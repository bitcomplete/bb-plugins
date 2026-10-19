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
import type { Binding, Escalation, Observed, ReadyState } from "./store.js";

/**
 * One line of "what changed", and whether it alone makes a judgment turn due.
 * `own` marks the steward's own doing (its signed description edit), which is
 * news to nobody above it.
 */
export type Change = { text: string; actionable: boolean; own?: boolean; byUser?: boolean };

/**
 * A spec comment is a signed comment that starts by saying so. The steward's
 * own count, and so do the user's: a thread the user runs themselves is
 * treated as the user's own words (an amendment carries its own approval
 * when the approver is `me`). `isUserThread` says whether a signing thread is
 * the user's rather than a steward, worker or the project steward; without it
 * only the steward's own comments count.
 */
export const isSpecComment = (c: SnapshotComment, stewardThreadId: string | null, isUserThread?: (threadId: string) => boolean): boolean =>
  c.signedBy !== null && /^\s*(\*\*)?spec\b/iu.test(c.body) && (c.signedBy === stewardThreadId || (isUserThread?.(c.signedBy) ?? false));

/**
 * What an approval is pinned to: the description and the spec comments. The
 * steward's own and the user's (a thread the user runs) both count. Any
 * change to either changes the hash. The signature line is left out of the
 * description, so the steward's own signed edit hashes the same as the text
 * it wrote.
 */
const DESCRIPTION_SIGNATURE = /\s*_— from bb thread ([A-Za-z0-9_-]+)_\s*$/u;

/** The thread that signed the description, when its last edit was signed. */
export const descriptionSignedBy = (entity: EntitySnapshot): string | null => DESCRIPTION_SIGNATURE.exec(entity.description ?? "")?.[1] ?? null;

export function specHash(entity: EntitySnapshot, stewardThreadId: string | null, isUserThread?: (threadId: string) => boolean): string {
  const description = (entity.description ?? "").replace(DESCRIPTION_SIGNATURE, "").trim();
  const specs = entity.comments.filter((c) => isSpecComment(c, stewardThreadId, isUserThread)).map((c) => `${c.id}\n${c.body}`);
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
 * Whose pull request events are the steward's own work in progress. While one
 * of its workers is running, the worker pushes, edits the description, posts
 * as the viewer (every thread acts as the developer, signed or not) and waits
 * for checks; none of that is news to the steward, which hears from the
 * worker when it finishes. People and terminal states still wake it.
 */
type DiffContext = { prefix: string; own: ReadonlySet<string>; stewardThreadId: string | null; approved: boolean; viewer: string | null; workerRunning: boolean; userThread?: (threadId: string) => boolean };

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
    changes.push({ text: `${p}Description edited${own ? " (by this steward)" : ""}`, actionable: !(ctx.workerRunning && after.pull !== null), ...(own ? { own } : {}) });
  }

  // A spec comment the steward just posted is its own doing; it only matters
  // once an approval is pinned to the spec it changes.
  const beforeSpecs = new Set(before.comments.filter((c) => isSpecComment(c, ctx.stewardThreadId, ctx.userThread)).map((c) => c.id));
  const addedSpecs = after.comments.filter((c) => isSpecComment(c, ctx.stewardThreadId, ctx.userThread) && !beforeSpecs.has(c.id));
  if (addedSpecs.length > 0) {
    const byUser = addedSpecs.some((c) => c.signedBy !== null && (ctx.userThread?.(c.signedBy) ?? false));
    // A spec comment the user wrote is news on its own: it carries its own
    // approval when the approver is `me`, and when it is the project steward
    // the steward should know the user authored it, not wait on them.
    changes.push({ text: `${p}Spec comment${addedSpecs.length === 1 ? "" : "s"} added${byUser ? " by the user" : ""}`, actionable: ctx.approved || byUser, ...(byUser ? { byUser } : {}) });
  }

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
    changes.push({ text: `${p}Checks finished: ${aChecks}${a.checks!.failing.length > 0 ? ` (failing: ${a.checks!.failing.join(", ")})` : ""}`, actionable: !ctx.workerRunning });
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
 * request. `workerRunning` quiets the steward's own work on pull requests
 * (see DiffContext).
 */
export function diffObserved(before: Observed, after: Observed, ctx: { own: ReadonlySet<string>; stewardThreadId: string | null; approved: boolean; cursor: string; workerRunning: boolean; userThread?: (threadId: string) => boolean }): Change[] {
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
  for (const e of [after.entity, ...after.pulls]) {
    const fresh = newHumanComments(e, ctx.cursor, ctx.own);
    // On a pull request a running worker owns, the viewer's comments are the
    // worker's and its reviewers': they post as the developer, often unsigned.
    const ownWork = ctx.workerRunning && e.pull !== null;
    const people = ownWork ? fresh.filter((c) => lc(c.author) !== lc(e.viewer)) : fresh;
    if (fresh.length > 0) changes.push({ text: commentNews(e === after.entity ? "" : `${e.key}: `, fresh), actionable: people.length > 0 });
  }
  return changes;
}

// ---- approval words -------------------------------------------------------------------

/**
 * How a piece of text answers an approval request. Explicit approval words
 * approve; explicit refusal words decline; anything else is ambiguous and is
 * the project steward's to interpret. The page answer uses all three; a
 * project steward's own guidance + resolve is a decision, so anything that
 * does not approve declines (as before).
 */
export type ApprovalVerdict = "approve" | "decline" | "ambiguous";

const NEGATED_APPROVE = /(?:^|[^\p{L}\p{N}])(?:not|do\s+not|don'?t)\s+(?:\w+\s+){0,2}?(?:approv\w*|ship|lgtm|go\s+ahead|looks?\s+good|sign\s*off|yes)(?:[^\p{L}\p{N}]|$)/iu;
const REFUSAL = /(?:^|[^\p{L}\p{N}])(?:reject(?:ed)?|declin(?:e|ed)|hold\s+off)(?:[^\p{L}\p{N}]|$)/iu;
const APPROVE_WORDS = /(?:^|[^\p{L}\p{N}])(?:lgtm|approv(?:e|es|ed|al)|ship\s*it|go\s*ahead|looks?\s+good|sign(?:ed)?\s*off|:shipit:|yes|yep|yeah)(?:[^\p{L}\p{N}]|$)/iu;
const DECLINE_WORDS = /(?:^|[^\p{L}\p{N}])(?:no|nope|don'?t|do\s+not|not\s+yet|changes?\s+(?:are\s+)?(?:needed|requested)|needs?\s+changes?)(?:[^\p{L}\p{N}]|$)/iu;

/**
 * A clear refusal first, so "not approved" and "don't ship it" decline rather
 * than matching the approval word inside them; then approval words, so
 * "LGTM, no concerns" and "ship it, no further changes needed" approve; then
 * a bare no or a request for changes declines; anything else is ambiguous.
 */
export function classifyApproval(text: string | null | undefined): ApprovalVerdict {
  const flat = (text ?? "").replace(/\s+/gu, " ").trim();
  if (flat === "") return "ambiguous";
  if (NEGATED_APPROVE.test(flat) || REFUSAL.test(flat)) return "decline";
  if (APPROVE_WORDS.test(flat)) return "approve";
  if (DECLINE_WORDS.test(flat)) return "decline";
  return "ambiguous";
}

/**
 * A steward that asks for an approval that is already open. The plugin files
 * the request and lists it on the Stewards page, so the playbook says not to
 * ask the user again; a report whose next action is to ask them anyway is a
 * violation `bb stewards show` points at. Only an imperative next action
 * counts, so merely waiting on the request is not flagged.
 */
export function asksForOpenApproval(status: Binding["status"], open: readonly Escalation[]): string | null {
  if (status === null || !open.some((x) => x.kind === "approval")) return null;
  const next = status.nextAction.trim();
  if (!/^(?:ask|asks|asking|request|requests|requesting|remind|reminds|reminding|tell|tells|telling|prompt|prompts|prompting)\b/iu.test(next)) return null;
  if (!/\b(?:approv\w*|lgtm|sign[- ]?off)\b/iu.test(next)) return null;
  if (!/\b(?:user|you|your)\b/iu.test(next)) return null;
  return "asks for an approval that is already open";
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
