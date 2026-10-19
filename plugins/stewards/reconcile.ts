// The mechanical tier's decisions, as pure functions: what changed between two
// observations of an entity, which of those changes are worth a judgment
// turn, where the ready gate stands, and when a binding counts as stuck.
// server.ts fetches, stores and wakes; nothing here talks to anything.
//
// The rule throughout: an event is a hint to look again, never the input a
// decision is made from. Every function here compares two states.
import { createHash } from "node:crypto";
import { isTerminal, phaseOf, type Playbook } from "./config.js";
import type { EntitySnapshot, SnapshotComment } from "./source-contract.js";
import type { Binding, Escalation, Observed, ReadyState, Worker } from "./store.js";

/**
 * One line of "what changed", and whether it alone makes a judgment turn due.
 * `own` marks the steward's own doing (its signed description edit), which is
 * news to nobody above it.
 */
export type Change = { text: string; actionable: boolean; own?: boolean };

/**
 * A worker is in flight from its spawn until it is stopped, failed or
 * archived. Its turn ending is a pause, not a finish: a worker waits on its
 * reviewer, is woken again, and pushes again. Own-pull-request activity is
 * the worker's while any worker of the binding is in flight (criterion 1).
 */
export const workerInFlight = (w: Pick<Worker, "status">): boolean => w.status === "running" || w.status === "finished";
export const anyWorkerInFlight = (workers: readonly Pick<Worker, "status">[]): boolean => workers.some(workerInFlight);

/** A reviewer's machine-readable verdict, as `pr-reviewer` posts it on the first line of a comment. */
export type ReviewMarker = { round: number; sha: string; verdict: string; lane: string };

const REVIEW_MARKER = /^<!--\s*bb-review\s+round=(\d+)\s+sha=(\S+)\s+verdict=(\S+)\s+lane=(\S+)\s*-->/u;

/** The reviewer's marker on a comment, or null for any other comment. */
export function reviewMarker(body: string): ReviewMarker | null {
  const first = body.split("\n", 1)[0]!.trim();
  const m = REVIEW_MARKER.exec(first);
  return m === null ? null : { round: Number(m[1]), sha: m[2]!, verdict: m[3]!, lane: m[4]! };
}

/** The newest reviewer marker in a comment list, by comment time. */
function latestMarker(comments: readonly SnapshotComment[]): ReviewMarker | null {
  let at = "";
  let latest: ReviewMarker | null = null;
  for (const c of comments) {
    const m = reviewMarker(c.body);
    if (m !== null && c.createdAt >= at) {
      at = c.createdAt;
      latest = m;
    }
  }
  return latest;
}

/**
 * A change in the lane a reviewer's rounds are in: the one thing about a
 * `bb-review` marker the steward hears while a worker is in flight.
 */
export function markerLaneChange(before: readonly SnapshotComment[], after: readonly SnapshotComment[]): { from: string; to: string } | null {
  const b = latestMarker(before);
  const a = latestMarker(after);
  if (b === null || a === null || b.lane === a.lane) return null;
  return { from: b.lane, to: a.lane };
}

/** A spec comment is one of the steward's own signed comments that starts by saying so. */
export const isSpecComment = (c: SnapshotComment, stewardThreadId: string | null): boolean =>
  stewardThreadId !== null && c.signedBy === stewardThreadId && /^\s*(\*\*)?spec\b/iu.test(c.body);

/**
 * What an approval is pinned to: the description and the steward's spec
 * comments. Any change to either changes the hash. The signature line is
 * left out of the description, so the steward's own signed edit hashes the
 * same as the text it wrote.
 */
const DESCRIPTION_SIGNATURE = /\s*_— from bb thread ([A-Za-z0-9_-]+)_\s*$/u;

/** The thread that signed the description, when its last edit was signed. */
export const descriptionSignedBy = (entity: EntitySnapshot): string | null => DESCRIPTION_SIGNATURE.exec(entity.description ?? "")?.[1] ?? null;

export function specHash(entity: EntitySnapshot, stewardThreadId: string | null): string {
  const description = (entity.description ?? "").replace(DESCRIPTION_SIGNATURE, "").trim();
  const specs = entity.comments.filter((c) => isSpecComment(c, stewardThreadId)).map((c) => `${c.id}\n${c.body}`);
  return createHash("sha256").update([description, ...specs].join("\n\u0000\n")).digest("hex").slice(0, 16);
}

/**
 * Comments newer than the cursor that someone other than this steward and its
 * workers wrote, oldest first. Another thread's signed comment is a real
 * comment: it is not this steward's.
 */
export function newHumanComments(entity: EntitySnapshot, cursor: string, own: ReadonlySet<string>): SnapshotComment[] {
  return entity.comments.filter((c) => c.createdAt > cursor && (c.signedBy === null || !own.has(c.signedBy)));
}

export const newestCommentAt = (observed: Observed): string =>
  [observed.entity, ...observed.pulls].flatMap((e) => e.comments.map((c) => c.createdAt)).reduce((a, b) => (a > b ? a : b), "");

function same(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}
const descriptionHash = (e: EntitySnapshot) => createHash("sha256").update(e.description ?? "").digest("hex").slice(0, 16);
const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();

/**
 * Whose pull request events are the steward's own work in progress. While any
 * worker of the binding is in flight (criterion 1: from its spawn until it
 * finishes, not only while its turn runs), the worker pushes, edits the
 * description, posts as the viewer (every thread acts as the developer,
 * signed or not) and waits for checks; none of that is news to the steward,
 * which hears from the worker when it finishes. People and terminal states
 * still wake it.
 */
type DiffContext = { prefix: string; own: ReadonlySet<string>; stewardThreadId: string | null; approved: boolean; viewer: string | null; workerInFlight: boolean };

/**
 * The changes between two observations of one entity, each marked whether it
 * is actionable on its own. `prefix` names the entity when it is not the
 * binding's own (a linked pull request).
 */
export function diffEntity(before: EntitySnapshot, after: EntitySnapshot, ctx: DiffContext): Change[] {
  const changes: Change[] = [];
  const p = ctx.prefix;
  if (before.state !== after.state) changes.push({ text: `${p}State: ${before.state} → ${after.state}`, actionable: true });
  if ((before.title ?? "") !== (after.title ?? "")) changes.push({ text: `${p}Title: ${after.title ?? "(none)"}`, actionable: false });
  if (!same(before.labels, after.labels)) changes.push({ text: `${p}Labels: ${after.labels.join(", ") || "(none)"}`, actionable: false });
  if (!same(before.assignees, after.assignees)) changes.push({ text: `${p}Assignees: ${after.assignees.join(", ") || "(none)"}`, actionable: false });
  if ((before.priority ?? "") !== (after.priority ?? "")) changes.push({ text: `${p}Priority: ${after.priority ?? "(none)"}`, actionable: false });
  if (before.estimate !== after.estimate) changes.push({ text: `${p}Estimate: ${after.estimate ?? "(none)"}`, actionable: false });
  if (descriptionHash(before) !== descriptionHash(after)) {
    // Only an edit that adds the signature is surely the steward's: someone
    // rewriting a description it signed earlier usually keeps the line.
    const signer = descriptionSignedBy(after);
    const own = signer !== null && ctx.own.has(signer) && descriptionSignedBy(before) !== signer;
    changes.push({ text: `${p}Description edited${own ? " (by this steward)" : ""}`, actionable: !(ctx.workerInFlight && after.pull !== null), ...(own ? { own } : {}) });
  }

  // A spec comment the steward just posted is its own doing; it only matters
  // once an approval is pinned to the spec it changes.
  const beforeSpecs = new Set(before.comments.filter((c) => isSpecComment(c, ctx.stewardThreadId)).map((c) => c.id));
  const addedSpecs = after.comments.filter((c) => isSpecComment(c, ctx.stewardThreadId) && !beforeSpecs.has(c.id));
  if (addedSpecs.length > 0) changes.push({ text: `${p}Spec comment${addedSpecs.length === 1 ? "" : "s"} added`, actionable: ctx.approved });

  const beforeChildren = new Map(before.children.map((c) => [c.id, c]));
  for (const child of after.children) {
    const was = beforeChildren.get(child.id);
    if (was === undefined) changes.push({ text: `${p}Sub-issue added: ${child.key} ${child.title ?? ""}`.trimEnd(), actionable: false });
    else if (lc(was.state) !== lc(child.state)) changes.push({ text: `${p}Sub-issue ${child.key}: ${was.state ?? "?"} → ${child.state ?? "?"}`, actionable: true });
  }
  const added = after.linkedPulls.filter((l) => !before.linkedPulls.some((b) => b.url === l.url));
  for (const l of added) changes.push({ text: `${p}Pull request linked: ${l.key ?? l.url}`, actionable: false });

  if (before.pull !== null && after.pull !== null) changes.push(...diffPull(before, after, ctx));
  return changes;
}

const SETTLED = new Set(["success", "failure", "error"]);

function diffPull(before: EntitySnapshot, after: EntitySnapshot, ctx: DiffContext): Change[] {
  const b = before.pull!;
  const a = after.pull!;
  const p = ctx.prefix;
  const changes: Change[] = [];
  const viewer = lc(ctx.viewer ?? after.viewer);
  if (b.headSha !== a.headSha && a.headSha !== null) {
    // The viewer's own pushes are the steward's workers at work: their checks
    // finishing is the news, not the push.
    const byOther = a.headAuthor !== null && lc(a.headAuthor) !== viewer;
    changes.push({ text: `${p}Pushed ${a.headSha.slice(0, 7)}${a.headAuthor === null ? "" : ` by ${a.headAuthor}`}`, actionable: byOther });
  }
  const bChecks = b.checks?.state ?? null;
  const aChecks = a.checks?.state ?? null;
  if (aChecks !== null && SETTLED.has(aChecks) && (bChecks !== aChecks || !same(b.checks?.failing ?? [], a.checks?.failing ?? []))) {
    changes.push({ text: `${p}Checks finished: ${aChecks}${a.checks!.failing.length > 0 ? ` (failing: ${a.checks!.failing.join(", ")})` : ""}`, actionable: !ctx.workerInFlight });
  }
  const seen = new Set(b.reviews.map((r) => `${r.author}|${r.submittedAt}|${r.state}`));
  for (const r of a.reviews) {
    if (seen.has(`${r.author}|${r.submittedAt}|${r.state}`)) continue;
    changes.push({ text: `${p}Review: ${r.author} ${r.state}`, actionable: lc(r.author) !== viewer });
  }
  const requestedNow = a.requestedReviewers.some((r) => lc(r) === viewer) && !b.requestedReviewers.some((r) => lc(r) === viewer);
  if (requestedNow) changes.push({ text: `${p}Your review was requested`, actionable: true });
  if ((b.reviewDecision ?? "") !== (a.reviewDecision ?? "")) changes.push({ text: `${p}Review decision: ${a.reviewDecision ?? "(none)"}`, actionable: false });
  return changes;
}

const commentNews = (prefix: string, fresh: SnapshotComment[]) =>
  `${prefix}${fresh.length} new comment${fresh.length === 1 ? "" : "s"} from ${[...new Set(fresh.map((c) => c.author))].join(", ")}`;

/** Whether a line of "what changed" is diffObserved's comment count. */
export const isCommentNews = (text: string): boolean => /^(?:\S+: )?\d+ new comments? from /u.test(text);

/**
 * Every change between two observations: the entity, then each linked pull
 * request. `workerInFlight` quiets the steward's own work on pull requests
 * (see DiffContext), including the reviewer's `bb-review` markers, except a
 * change of lane (criterion 3).
 */
export function diffObserved(before: Observed, after: Observed, ctx: { own: ReadonlySet<string>; stewardThreadId: string | null; approved: boolean; cursor: string; workerInFlight: boolean }): Change[] {
  const viewer = after.entity.viewer;
  const changes = diffEntity(before.entity, after.entity, { ...ctx, prefix: "", viewer });
  const beforePulls = new Map(before.pulls.map((p) => [p.key.toLowerCase(), p]));
  for (const pull of after.pulls) {
    const was = beforePulls.get(pull.key.toLowerCase());
    const prefix = `${pull.key}: `;
    if (was === undefined) changes.push({ text: `${prefix}now followed (${pull.state})`, actionable: false });
    else changes.push(...diffEntity(was, pull, { ...ctx, prefix, viewer: pull.viewer }));
  }
  // Comments are compared with what the steward was last shown, not with the
  // last ring, so a comment that arrived while the binding was held is still
  // news at the next turn.
  const beforeByKey = new Map<string, EntitySnapshot>([[before.entity.key.toLowerCase(), before.entity], ...before.pulls.map((p) => [p.key.toLowerCase(), p] as const)]);
  for (const e of [after.entity, ...after.pulls]) {
    const prefix = e === after.entity ? "" : `${e.key}: `;
    const fresh = newHumanComments(e, ctx.cursor, ctx.own);
    // On a pull request a worker owns, the viewer's comments are the worker's
    // and its reviewers': they post as the developer, often unsigned. The
    // reviewer's markers are the worker's business too, whoever posts them;
    // a round that changes the lane is not.
    const ownWork = ctx.workerInFlight && e.pull !== null;
    const people = ownWork ? fresh.filter((c) => reviewMarker(c.body) === null && lc(c.author) !== lc(e.viewer)) : fresh;
    if (fresh.length > 0) changes.push({ text: commentNews(prefix, fresh), actionable: people.length > 0 });
    if (ownWork) {
      const lane = markerLaneChange(beforeByKey.get(e.key.toLowerCase())?.comments ?? [], e.comments);
      if (lane !== null) changes.push({ text: `${prefix}Review lane: ${lane.from} → ${lane.to}`, actionable: true });
    }
  }
  return changes;
}

/**
 * Whether to compact a steward's context: it already holds more than the
 * limit, or the wake about to be sent would push it over (criterion 4).
 * Tokens are estimated from the wake's characters; the provider's reading is
 * exact. A non-positive limit leaves compaction to the provider.
 */
export const CHARS_PER_TOKEN = 4;
export function compactDue(usedTokens: number | null, limit: number, incomingChars = 0): boolean {
  if (!(limit > 0) || usedTokens === null) return false;
  return usedTokens > limit || usedTokens + Math.ceil(incomingChars / CHARS_PER_TOKEN) > limit;
}

// ---- the ready gate ------------------------------------------------------------------

export type GateState = {
  /** No ready gate in the playbook: nothing to pass. */
  none: boolean;
  checklistMet: boolean;
  unmet: string[];
  /** Null until the steward has judged it. */
  substantial: boolean | null;
  approvalNeeded: boolean;
  approved: boolean;
  /** An approval exists but the spec has changed since. */
  approvalStale: boolean;
  passed: boolean;
};

/** Checklist wording as compared: case, runs of spaces and trailing punctuation do not count. */
const checklistKey = (s: string) => s.toLowerCase().replace(/\s+/gu, " ").replace(/[\s.:;,]+$/u, "").trim();

/** What the steward last reported for one of the playbook's checklist items. */
export const reportedItem = (ready: ReadyState, item: string): ReadyState["checklist"][number] | undefined =>
  ready.checklist.find((c) => checklistKey(c.item) === checklistKey(item));

/**
 * The playbook's own wording for a reported checklist entry: by its number
 * in the wake (1-based), or by its text as the playbook writes it. Null for
 * anything else. Stewards paraphrase long items, so a paraphrase is refused
 * rather than guessed at: a guess that misses leaves the gate shut in
 * silence, which is how it never passed.
 */
export function resolveChecklistItem(items: readonly string[], reported: string | number): string | null {
  const text = String(reported);
  const number = /^\s*#?(\d+)\.?\s*$/u.exec(text);
  if (number !== null) return items[Number(number[1]) - 1] ?? null;
  return items.find((item) => checklistKey(item) === checklistKey(text)) ?? null;
}

export function gateState(playbook: Playbook, ready: ReadyState, currentSpecHash: string): GateState {
  if (playbook.ready === null) return { none: true, checklistMet: true, unmet: [], substantial: null, approvalNeeded: false, approved: false, approvalStale: false, passed: true };
  const items = playbook.ready.checklist;
  const unmet = items.filter((item) => reportedItem(ready, item)?.met !== true);
  const checklistMet = unmet.length === 0;
  // Unjudged counts as substantial: the safe side of the gate.
  const approvalNeeded = ready.substantial !== false;
  const approved = ready.approval !== null;
  const approvalStale = approved && ready.approval!.specHash !== currentSpecHash;
  const passed = checklistMet && (!approvalNeeded || (approved && !approvalStale));
  return { none: false, checklistMet, unmet, substantial: ready.substantial, approvalNeeded, approved, approvalStale, passed };
}

/**
 * Whether the gate is shut on something known rather than merely not yet
 * reported: approval is needed and the current spec has none (missing,
 * voided or stale), or the steward reported a checklist item unmet. An item
 * the steward has not reported does not count, so a ticket moved on right
 * after its approval, before the steward reports again, is not flagged.
 */
export function gateKnownUnmet(playbook: Playbook, ready: ReadyState, currentSpecHash: string): boolean {
  const gate = gateState(playbook, ready, currentSpecHash);
  if (gate.passed) return false;
  if (gate.approvalNeeded && (!gate.approved || gate.approvalStale)) return true;
  return gate.unmet.some((item) => reportedItem(ready, item)?.met === false);
}

/**
 * Whether the gate waits on its approver: the checklist is met, the ticket
 * is (or may be) substantial, and the current spec has no approval. The
 * plugin asks the approver itself then, so the gate does not depend on the
 * steward remembering to.
 */
export const approvalWanted = (gate: GateState): boolean => !gate.none && gate.checklistMet && gate.approvalNeeded && !gate.passed;

/**
 * A status that says it waits on the project steward or the user while
 * none of its escalations is open: a wait nobody above it hears about.
 */
export function unheardWait(status: Binding["status"], open: readonly Escalation[]): string | null {
  if (status === null || status.blockedOn === null || open.length > 0) return null;
  if (/project steward/iu.test(status.blockedOn)) return "waits on the project steward, with no open escalation";
  if (/\buser\b/iu.test(status.blockedOn)) return "waits on the user, with no open escalation";
  return null;
}

// ---- lifecycle -----------------------------------------------------------------------

export type Lifecycle =
  | { kind: "continue" }
  | { kind: "terminal" }
  | { kind: "detach" }
  | { kind: "reopen"; why: string }
  | { kind: "stay-ended" };

const hasLabel = (entity: EntitySnapshot, label: string) => entity.labels.some((l) => l.toLowerCase() === label.toLowerCase());

/**
 * What the entity's state means for the binding. A review binding is not
 * labelled, so only the terminal state ends it; a ticket or pr binding also
 * ends when the label goes, and comes back when it returns.
 *
 * An entity that leaves its terminal state while the binding is still
 * ending reopens it too: a ticket an automation moved to Done and someone
 * moved straight back should not cost its steward its workers.
 */
export function lifecycle(binding: Pick<Binding, "kind" | "endedAt" | "endReason" | "manualDetach" | "ending">, playbook: Playbook, entity: EntitySnapshot, label: string): Lifecycle {
  const terminal = isTerminal(playbook, entity.state);
  const labelled = binding.kind === "review" || hasLabel(entity, label);
  if (binding.endedAt !== null) {
    if (terminal || !labelled || binding.manualDetach) return { kind: "stay-ended" };
    if (binding.endReason === "terminal") return { kind: "reopen", why: `reopened: now ${entity.state}` };
    if (binding.endReason === "detach") return { kind: "reopen", why: `the ${label} label is back` };
    return { kind: "stay-ended" };
  }
  if (binding.ending === "terminal" && !terminal && labelled) return { kind: "reopen", why: `reopened before the binding ended: now ${entity.state}` };
  if (terminal) return { kind: "terminal" };
  if (!labelled) return { kind: "detach" };
  return { kind: "continue" };
}

export { hasLabel };

/** Whether a terminal binding is being kept open by its steward to finish its work. */
export const followingThrough = (b: Pick<Binding, "ending" | "followThrough">): boolean => b.ending === "terminal" && b.followThrough !== null;

/**
 * When an ending is overdue: the follow-through's cap once the steward has
 * declared one, otherwise the wrap-up turn's own timeout.
 */
export function endingDeadline(b: Pick<Binding, "ending" | "endingAt" | "followThroughUntil">, turnTimeoutMs: number): number | null {
  if (b.ending === null) return null;
  if (b.followThroughUntil !== null) return b.followThroughUntil;
  return b.endingAt === null ? null : b.endingAt + turnTimeoutMs;
}

/** The phase and stage for the entity's state, or nulls when the playbook does not name it. */
export function phaseAndStage(playbook: Playbook, state: string): { phase: string; stage: Binding["stage"] } {
  const p = phaseOf(playbook, state);
  return { phase: p?.name ?? state, stage: p?.stage ?? null };
}

/**
 * Whether the backstop should raise `stuck`: the phase has a stuck limit, the
 * status record has not moved in that long, and nothing already says so.
 */
export function stuckDue(binding: Pick<Binding, "advancedAt" | "createdAt" | "phase">, playbook: Playbook, open: Escalation[], now: number): number | null {
  if (binding.phase === null) return null;
  const limit = phaseOf(playbook, binding.phase)?.stuckMs ?? null;
  if (limit === null) return null;
  if (open.some((e) => e.kind === "stuck")) return null;
  const since = binding.advancedAt ?? binding.createdAt;
  return now - since >= limit ? limit : null;
}

/** Whether a new status record moved on from the last one. */
export const advanced = (before: Binding["status"], after: { phase: string; summary: string; nextAction: string }): boolean =>
  before === null || before.phase !== after.phase || before.summary !== after.summary || before.nextAction !== after.nextAction;
