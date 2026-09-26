import type {
  BriefStage,
  BriefStatus,
  ResolvedBrief,
  RowSignal,
  StoredBrief,
} from "./contract.js";

export const briefKey = (threadId: string) => `brief:${threadId}`;
export const threadIdFromKey = (key: string) => key.slice("brief:".length);

/**
 * The effective stage: a manual override wins until the thread has real new
 * activity past the point where it was set.
 */
export function effectiveStage(stored: StoredBrief): BriefStage {
  if (stored.stageOverride === null) return stored.modelStage;
  if (
    stored.stageOverrideSeq !== null &&
    stored.lastActivitySeen > stored.stageOverrideSeq
  ) {
    return stored.modelStage;
  }
  return stored.stageOverride;
}

/** True once the thread has moved on from where a manual override was set. */
export function isStageOverrideStale(stored: StoredBrief): boolean {
  return (
    stored.stageOverride !== null &&
    stored.stageOverrideSeq !== null &&
    stored.lastActivitySeen > stored.stageOverrideSeq
  );
}

/**
 * Status is mechanical, not a model judgement, so it stays right between
 * summaries:
 *
 * - no next step  → the work is done
 * - blocked on something → waiting on someone else
 * - the agent asked us something → waiting on me
 * - otherwise → working
 *
 * Order matters: a thread with nothing left to do is `done` even if the last
 * turn happened to end in a question.
 */
export function deriveStatus(args: {
  nextStep: string;
  blockedOn: string;
  awaitingUser: boolean;
}): BriefStatus {
  if (args.nextStep.trim() === "") return "done";
  if (args.blockedOn.trim() !== "") return "waiting-on-other";
  if (args.awaitingUser) return "waiting-on-me";
  return "working";
}

/**
 * `endedWithQuestion` is what the summarizer saw; `hasPendingInteraction` is
 * live. Either means the thread wants something from us.
 */
export function awaitingUser(args: {
  endedWithQuestion: boolean;
  hasPendingInteraction: boolean;
}): boolean {
  return args.hasPendingInteraction || args.endedWithQuestion;
}

export function resolveBrief(
  stored: StoredBrief,
  live: { hasPendingInteraction: boolean },
): ResolvedBrief {
  return {
    ...stored.fields,
    threadId: stored.threadId,
    stage: effectiveStage(stored),
    status: deriveStatus({
      nextStep: stored.fields.nextStep,
      blockedOn: stored.fields.blockedOn,
      awaitingUser: awaitingUser({
        endedWithQuestion: stored.endedWithQuestion,
        hasPendingInteraction: live.hasPendingInteraction,
      }),
    }),
    // Report the override only while it is still in force, so the stage
    // control does not show a stale manual pick as active.
    stageOverride: isStageOverrideStale(stored) ? null : stored.stageOverride,
    lastSummarizedAt: stored.lastSummarizedAt,
  };
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

export function rowSignalFor(brief: ResolvedBrief): RowSignal {
  return {
    threadId: brief.threadId,
    status: brief.status,
    stage: brief.stage,
    label: `${STATUS_LABELS[brief.status]} — ${STAGE_LABELS[brief.stage]}`,
  };
}

/** Glyph + tone per status. Names are real bb icon-registry entries. */
const GLYPHS: Record<
  BriefStatus,
  { icon: string; tone: "default" | "error" | "running" | "success" }
> = {
  "waiting-on-me": { icon: "MessageQuestion", tone: "default" },
  "waiting-on-other": { icon: "Pause", tone: "default" },
  done: { icon: "CircleCheck", tone: "success" },
  working: { icon: "Circle", tone: "default" },
};

/**
 * The row decoration for one signal, or null for a row that should keep bb's
 * own glyph.
 *
 * `working` draws nothing on purpose: bb paints a plugin row status *in place
 * of* its unsent-draft pencil, so decorating every row would cost the draft
 * indicator everywhere to say something the row already implies. Only the
 * three states that are news get a glyph.
 *
 * `hasPendingInteraction` is client-side truth the sidebar already has.
 * Per {@link deriveStatus}'s ordering it can only ever matter for a thread
 * that is otherwise `working`, so applying it here needs no extra server
 * round trip and cannot contradict a stored `done` or `waiting-on-other`.
 */
export function rowDecoration(
  signal: RowSignal,
  hasPendingInteraction: boolean,
): { icon: string; label: string; tone: "default" | "error" | "running" | "success" } | null {
  const status: BriefStatus =
    signal.status === "working" && hasPendingInteraction
      ? "waiting-on-me"
      : signal.status;
  if (status === "working") return null;
  const glyph = GLYPHS[status];
  return {
    icon: glyph.icon,
    tone: glyph.tone,
    label: `${STATUS_LABELS[status]} — ${STAGE_LABELS[signal.stage]}`,
  };
}
