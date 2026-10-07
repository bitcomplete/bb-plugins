import type {
  BlockReason,
  BriefCard,
  BriefStage,
  BriefStatus,
  NextStepActor,
  ResolvedBrief,
  RowSignal,
  StoredBrief,
  StoredBriefStatus,
} from "./contract.js";
import { projectColorIndex } from "./shared.js";

export const briefKey = (threadId: string) => `brief:${threadId}`;
export const threadIdFromKey = (key: string) => key.slice("brief:".length);

/**
 * Whether an override anchored at `anchorSeq` still applies to a thread whose
 * activity cursor reads `cursor`.
 *
 * The whole of "sticks until real thread activity", shared by both overrides so
 * they cannot drift apart. An override with no anchor holds indefinitely: that
 * is unreachable today — setting one always records the cursor — but reading an
 * unanchored pin as *expired* would silently discard a deliberate choice, where
 * reading it as held merely leaves it for the user to clear.
 */
export function overrideHolds(
  anchorSeq: number | null | undefined,
  cursor: number,
): boolean {
  return anchorSeq === null || anchorSeq === undefined || cursor <= anchorSeq;
}

/**
 * The effective stage: a manual override wins until the thread has real new
 * activity past the point where it was set.
 */
export function effectiveStage(stored: StoredBrief): BriefStage {
  if (isStageOverrideStale(stored)) return stored.modelStage;
  return stored.stageOverride ?? stored.modelStage;
}

/** True once the thread has moved on from where a manual stage was set. */
export function isStageOverrideStale(stored: StoredBrief): boolean {
  return (
    stored.stageOverride !== null &&
    !overrideHolds(stored.stageOverrideSeq, stored.lastActivitySeen)
  );
}

/** True once the thread has moved on from where a manual status was set. */
export function isStatusOverrideStale(stored: StoredBrief): boolean {
  return (
    (stored.statusOverride ?? null) !== null &&
    !overrideHolds(stored.statusOverrideSeq, stored.lastActivitySeen)
  );
}

/**
 * The status this brief reports: the manual one while it holds, otherwise the
 * one the summarizer judged.
 *
 * The manual pin exists for the one thing no summary can see: a step carried
 * out somewhere the transcript does not reach. The summarizer is asked whether
 * the task is finished *assuming* you do what the thread asks of you, so a step
 * that is only yours already reads done; the pin is for the rest — a thread
 * waiting on your go-ahead that you settled elsewhere, or a reading you simply
 * disagree with.
 */
export function effectiveStatus(stored: StoredBrief): StoredBriefStatus {
  const override = stored.statusOverride ?? null;
  if (override !== null && !isStatusOverrideStale(stored)) return override;
  return stored.modelStatus ?? legacyStatus(stored.fields);
}

/**
 * The status of a brief written before the summarizer was asked for one, read
 * from its fields the way it used to be: nothing to do and nothing blocking is
 * done, a blocker or an outside actor is waiting on someone else, and anything
 * else is waiting on you.
 *
 * Only for old rows. Such a brief stays on this reading until its thread is
 * next summarized, which writes a `modelStatus` that replaces it.
 */
export function legacyStatus(fields: {
  nextStep: string;
  blockedOn: string;
  nextStepActor?: NextStepActor | undefined;
}): StoredBriefStatus {
  const nextStep = fields.nextStep.trim();
  const blockedOn = fields.blockedOn.trim();
  if (nextStep === "" && blockedOn === "") return "done";
  if (blockedOn !== "" || fields.nextStepActor === "other") {
    return "waiting-on-other";
  }
  return "waiting-on-me";
}

/**
 * The user's block reason as the UI shows it, without the cursor the server
 * keeps beside it.
 */
export function blockReasonOf(stored: StoredBrief): BlockReason | null {
  const reason = stored.blockReason ?? null;
  return reason === null
    ? null
    : { text: reason.text, recordedAt: reason.recordedAt };
}

/** Whether a stage or status pin is in force right now. */
export function isPinned(stored: StoredBrief): boolean {
  return (
    (stored.stageOverride !== null && !isStageOverrideStale(stored)) ||
    ((stored.statusOverride ?? null) !== null && !isStatusOverrideStale(stored))
  );
}

export function resolveBrief(stored: StoredBrief): ResolvedBrief {
  return {
    ...stored.fields,
    threadId: stored.threadId,
    stage: effectiveStage(stored),
    status: effectiveStatus(stored),
    // Report each override only while it is still in force, so a control does
    // not show a stale manual pick as active.
    stageOverride: isStageOverrideStale(stored) ? null : stored.stageOverride,
    statusOverride: isStatusOverrideStale(stored)
      ? null
      : (stored.statusOverride ?? null),
    blockReason: blockReasonOf(stored),
    lastSummarizedAt: stored.lastSummarizedAt,
  };
}

/**
 * The title to write to a thread, or null to leave it alone.
 *
 * bb generates a thread's title exactly once, from the opening prompt, before
 * anyone knows what the thread became — `applyGeneratedThreadTitle` refuses to
 * write over an existing title and nothing else in bb rewrites one. So a title
 * this plugin writes is permanent, and the only name that can be clobbered by
 * writing one is a name a person chose.
 *
 * That is the whole of the rule below. bb stores no provenance for a title, so
 * "did a person choose this?" is answered by memory: `applied` is the title we
 * last wrote, and a `current` that disagrees with it is someone else's work.
 *
 * - `applied === null` — we have never written one. Whatever is there is bb's
 *   opening-prompt guess (or nothing), which is exactly what this replaces.
 * - `current === applied` — ours, still untouched. Free to update.
 * - otherwise — renamed by hand since we last wrote. Never again: the caller
 *   leaves `applied` as it is, so this comparison keeps failing and every later
 *   summary skips the rename too, with no "locked" flag to store or clear.
 *
 * `observed` covers the case that rule cannot see: the *first* rename, where
 * `applied` is null and so nothing is being compared against. A summary takes
 * up to a minute, and a thread renamed during it would be overwritten by a
 * name chosen before the rename happened. So the caller reads the title once
 * when the summary starts and again just before writing, and a title that
 * moved in between belongs to whoever moved it.
 *
 * A `desired` equal to what the thread already shows returns null as well, so a
 * settled thread costs no write — which matters because bb's title PATCH also
 * dispatches a rename command to the thread's environment.
 */
export function planRename(args: {
  /** The title now, read as late as the caller can manage. */
  current: string | null;
  /** The title when this summary started; defaults to `current`. */
  observed?: string | null;
  desired: string | undefined;
  applied: string | null | undefined;
}): string | null {
  const desired = args.desired?.trim() ?? "";
  if (desired === "") return null;

  const current = args.current?.trim() ?? "";
  const observed = args.observed === undefined ? current : (args.observed?.trim() ?? "");
  if (current !== observed) return null;

  const applied = args.applied ?? null;
  if (applied !== null && current !== applied.trim()) return null;
  if (current === desired) return null;
  return desired;
}

/**
 * How long ago a brief was written, for the panel's staleness line.
 *
 * Coarse on purpose. The question it answers is "does this describe the turn I
 * just watched, or one from this morning?", and a brief is only rewritten after
 * a quiet period anyway, so minute precision on a two-hour-old one would be
 * false precision. A `now` behind the timestamp — clock skew between the server
 * that wrote it and the browser reading it — clamps to "just now" rather than
 * counting into the future.
 */
export function summarizedAgo(lastSummarizedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - lastSummarizedAt) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export const STAGE_LABELS: Record<BriefStage, string> = {
  discovery: "Discovery",
  planning: "Planning",
  implementation: "Implementation",
  review: "Review",
};

export const STATUS_LABELS: Record<BriefStatus, string> = {
  working: "Working",
  "waiting-on-me": "Waiting on you",
  "waiting-on-other": "Blocked",
  done: "Done",
};

/**
 * The accessible label for a row glyph, naming both axes.
 *
 * Stage leads because the glyph now draws the stage, and a ring reads as "how
 * far along" rather than as a word — the label is the only thing that says
 * which stage that is. Status still has to appear: the sidebar's status
 * grouping says it in the section header, but grouping is off by default and
 * nothing else on an ungrouped row says it at all.
 */
export function rowLabelFor(
  stage: BriefStage,
  status: BriefStatus,
  pinned = false,
): string {
  const base = `${STAGE_LABELS[stage]} — ${STATUS_LABELS[status]}`;
  // The dot on the ring is the only mark that is not the model's; the label is
  // where it gets its name.
  return pinned ? `${base} · set by hand` : base;
}

/**
 * The board's card for one stored brief.
 *
 * Built from the stored row rather than from a {@link ResolvedBrief}, because
 * `modelStage` is the one fact the board needs that resolving deliberately
 * throws away — it is what makes "dropped on the stage the summarizer already
 * chose" a clearable pin rather than a new one.
 */
export function briefCardFor(stored: StoredBrief): BriefCard {
  const resolved = resolveBrief(stored);
  return {
    threadId: stored.threadId,
    stage: resolved.stage,
    modelStage: stored.modelStage,
    // Not `resolved.status`, which is typed as the full union including the
    // live-only `working`: the stored status is what this wire field carries,
    // and taking it from the narrower function says so without a cast.
    status: effectiveStatus(stored),
    stageOverride: resolved.stageOverride,
    statusOverride: resolved.statusOverride,
    blockReason: resolved.blockReason,
    nextStep: resolved.nextStep,
    // Spread rather than assigned, so an absent actor stays absent: the schema
    // is `.strict()` and an explicit `undefined` is not the same as no key.
    ...(resolved.nextStepActor === undefined
      ? {}
      : { nextStepActor: resolved.nextStepActor }),
    blockedOn: resolved.blockedOn,
    lastSummarizedAt: resolved.lastSummarizedAt,
  };
}

export function rowSignalFor(brief: ResolvedBrief): RowSignal {
  const pinned = brief.stageOverride !== null || brief.statusOverride !== null;
  return {
    threadId: brief.threadId,
    status: brief.status,
    stage: brief.stage,
    label: rowLabelFor(brief.stage, brief.status, pinned),
    pinned,
  };
}

/** bb's convention for a plugin's own icon-registry names: `<pluginId>/<name>`. */
const ICON_PREFIX = "thread-briefs/";

/**
 * The registry name of the ring drawn for a stage — one quarter filled per
 * stage reached, so `implementation` is three quarters and `review` closes the
 * ring. The artwork is registered by `app.tsx`.
 *
 * Built from the stage rather than listed against it, so a stage added to
 * `BRIEF_STAGES` cannot get a name without also getting artwork: `app.tsx`
 * registers its icons by mapping this same function over the same list.
 */
export function stageRingIcon(
  stage: BriefStage,
  colorIndex?: number,
  pinned = false,
): string {
  return `${ICON_PREFIX}stage-${stage}${pinSuffix(pinned)}${ringColorSuffix(
    colorIndex,
  )}`;
}

/**
 * The suffix on a ring's registry name when it carries the centre dot.
 *
 * A pin is a human overriding the summarizer, and it is the one fact on the
 * row the model did not decide — so it gets the one mark the ring has room
 * for in its centre. Before the dot meant this, a filled centre meant `done`;
 * done is now one seamless circle instead, so the two cannot be confused and a
 * pinned done thread can show both.
 */
function pinSuffix(pinned: boolean): string {
  return pinned ? "-pinned" : "";
}

/**
 * The palette suffix on a ring's registry name, or "" for the neutral ring.
 *
 * Every ring exists twice over: once in `currentColor`, which is what the panel
 * and the stage picker want — they sit inside one thread, where naming its
 * project back to it says nothing — and once per palette slot for the sidebar
 * row, where the project is the fact the colour is there to carry.
 */
function ringColorSuffix(colorIndex: number | undefined): string {
  return colorIndex === undefined ? "" : `-c${colorIndex}`;
}

/** {@link DONE_RING_ICON} in a project's colour, or neutral without one. */
export function doneRingIcon(colorIndex?: number, pinned = false): string {
  return `${DONE_RING_ICON}${pinSuffix(pinned)}${ringColorSuffix(colorIndex)}`;
}

/** {@link STALE_DONE_RING_ICON}, with the centre dot when a pin holds. */
export function staleDoneRingIcon(pinned = false): string {
  return `${STALE_DONE_RING_ICON}${pinSuffix(pinned)}`;
}

/**
 * The seamless circle drawn for `done` in place of any stage ring.
 *
 * `done` is a status, not a fifth stage: the arc is over, so which stage it
 * ended in stops being the interesting fact about the row. Keeping it off the
 * ring is also what holds the ring at four 90° segments, and four is the point
 * where the fill's endpoint lands on a clock position you can read without
 * counting marks. A fifth segment in a 16px glyph is where that stops working.
 *
 * A circle rather than a filled centre, because the centre now means "pinned"
 * — see {@link stageRingIcon}. Seamless rather than four closed quarters
 * because a done thread draws no stage, so there are no boundaries to mark;
 * the review ring's gaps are what tell the two apart.
 */
export const DONE_RING_ICON = `${ICON_PREFIX}done`;

/**
 * The done ring in grey, for a thread that finished and has not been touched
 * since.
 *
 * One icon, not a set: grey *replaces* the project hue rather than varying with
 * it, so there is nothing to register per palette slot. That is the reading —
 * colour on this row means a live project, and a ring that has given its colour
 * up is one nobody is coming back to. The shape is unchanged, so the row still
 * says `done` at a glance and the grey only adds "and cold".
 */
export const STALE_DONE_RING_ICON = `${ICON_PREFIX}done-stale`;

/**
 * How long a thread has been idle, for the grey ring's hover label.
 *
 * Coarse like {@link summarizedAgo}, and for a stronger reason: this label is
 * recomputed on a timer, and a phrase that changed every minute would rewrite
 * every stale row's status a thousand times a day to say the same thing. Days
 * and hours change rarely enough that the decoration diff absorbs the ticks.
 */
export function idleFor(ms: number): string {
  const hours = Math.floor(Math.max(0, ms) / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The row decoration for one signal, or null for a row that should keep bb's
 * own glyph.
 *
 * The glyph draws the **stage**, not the status. Status is what the sidebar's
 * own status grouping already puts in the section header, so a status glyph
 * spends the row's one slot repeating its own heading; stage is orthogonal to
 * it, and is the fact that says which of a dozen threads waiting on you is one
 * turn from finished. Stage is also ordinal, which a ring can show and a set of
 * unrelated glyphs cannot: you read four rings at a glance without reading any
 * of them.
 *
 * The one channel a named icon leaves free — colour — goes to the **project**,
 * because `sidebarGrouping status` is what takes the sidebar's own project
 * grouping away and nothing else on the row replaces it. `done` used to hold
 * that channel and gives it up: it already has the two marks that do not need
 * it, the filled centre and its section heading, where the project has neither.
 *
 * Unconditionally, including where only one project is on screen. A colour that
 * appeared only sometimes would have to be interpreted before it could be read,
 * against a rule nothing in the sidebar shows you — and "only one project" is a
 * fact a filter or a newly added project can change without any thread having
 * changed.
 *
 * `waiting-on-me` and `waiting-on-other` still draw the same ring, told apart
 * by the section header or by the label on hover when grouping is off.
 *
 * Precedence is live first, stored second: a thread whose agent is running or
 * queued is `working` no matter what its brief says, and `working` still draws
 * nothing. Three reasons, in order of how much they cost:
 *
 * - bb hides a plugin row status outright when its own indicator is `runtime`,
 *   `unread-error` or `waiting-for-input`, so for a plain running thread a
 *   decoration here is ignored anyway.
 * - It is *not* hidden for `plan-mode`, `goal`, `workflow` or
 *   `background-agent`, where it would displace a shimmering live glyph that
 *   says something a stored brief cannot.
 * - bb paints the status in place of the unsent-draft pencil, so decorating a
 *   row always costs the pencil there.
 *
 * `liveWorking` is client-side truth the sidebar already holds, so applying it
 * here costs no server round trip — which is the whole reason `listRowSignals`
 * does no per-thread lookups.
 *
 * `stale` is the same kind of thing: a done thread nobody has touched since,
 * computed from the attention cursor on the sidebar row beside the same brief.
 * It takes the ring's colour away rather than adding a mark, because the row
 * has no second channel to add one to — and giving up the project colour is the
 * honest thing for a thread that is about to leave the sidebar entirely.
 */
export function rowDecoration(
  signal: RowSignal,
  liveWorking: boolean,
  project: { id: string; name: string } | null = null,
  stale: { idleMs: number; archiving: boolean } | null = null,
): { icon: string; label: string; tone: "default" | "error" | "running" | "success" } | null {
  if (liveWorking) return null;
  const isDone = signal.status === "done";
  // Only a done row can be stale; anything else is a caller bug, and drawing
  // the done ring for it would be worse than ignoring it.
  const staleDone = isDone ? stale : null;
  const colorIndex =
    project === null ? undefined : projectColorIndex(project.id);
  const label =
    staleDone === null
      ? rowLabelFor(signal.stage, signal.status, signal.pinned)
      : // The grey is not self-explanatory the way the ring's shape is, so the
        // label is where "why has this one gone flat" gets answered — including
        // the fact that it is on its way out, which nothing else says.
        `${rowLabelFor(signal.stage, signal.status, signal.pinned)} · idle ${idleFor(
          staleDone.idleMs,
        )}${staleDone.archiving ? ", archiving soon" : ""}`;
  return {
    icon: staleDone !== null
      ? staleDoneRingIcon(signal.pinned)
      : isDone
        ? doneRingIcon(colorIndex, signal.pinned)
        : stageRingIcon(signal.stage, colorIndex, signal.pinned),
    // Never `success`. The colour channel belongs to the project now, and a
    // green that showed up only on the rows this function happens to be handed
    // no project for would be a second, invisible rule competing with it.
    // `done` keeps the two marks that do not need the channel: the filled
    // centre, and its section heading.
    tone: "default",
    label:
      project === null || project.name === "" ? label : `${label} (${project.name})`,
  };
}
