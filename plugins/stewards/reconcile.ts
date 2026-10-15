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

/** One line of "what changed", and whether it alone makes a judgment turn due. */
export type Change = { text: string; actionable: boolean };

/** A spec comment is one of the steward's own signed comments that starts by saying so. */
export const isSpecComment = (c: SnapshotComment, stewardThreadId: string | null): boolean =>
  stewardThreadId !== null && c.signedBy === stewardThreadId && /^\s*(\*\*)?spec\b/iu.test(c.body);

/**
 * What an approval is pinned to: the description and the steward's spec
 * comments. Any change to either changes the hash. The signature line is
 * left out of the description, so the steward's own signed edit hashes the
 * same as the text it wrote.
 */
export function specHash(entity: EntitySnapshot, stewardThreadId: string | null): string {
  const description = (entity.description ?? "").replace(/\s*_— from bb thread [A-Za-z0-9_-]+_\s*$/u, "").trim();
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
 * The changes between two observations of one entity, each marked whether it
 * is actionable on its own. `prefix` names the entity when it is not the
 * binding's own (a linked pull request).
 */
export function diffEntity(before: EntitySnapshot, after: EntitySnapshot, ctx: { prefix: string; own: ReadonlySet<string>; stewardThreadId: string | null; approved: boolean; viewer: string | null }): Change[] {
  const changes: Change[] = [];
  const p = ctx.prefix;
  if (before.state !== after.state) changes.push({ text: `${p}State: ${before.state} → ${after.state}`, actionable: true });
  if ((before.title ?? "") !== (after.title ?? "")) changes.push({ text: `${p}Title: ${after.title ?? "(none)"}`, actionable: false });
  if (!same(before.labels, after.labels)) changes.push({ text: `${p}Labels: ${after.labels.join(", ") || "(none)"}`, actionable: false });
  if (!same(before.assignees, after.assignees)) changes.push({ text: `${p}Assignees: ${after.assignees.join(", ") || "(none)"}`, actionable: false });
  if ((before.priority ?? "") !== (after.priority ?? "")) changes.push({ text: `${p}Priority: ${after.priority ?? "(none)"}`, actionable: false });
  if (before.estimate !== after.estimate) changes.push({ text: `${p}Estimate: ${after.estimate ?? "(none)"}`, actionable: false });
  if (descriptionHash(before) !== descriptionHash(after)) changes.push({ text: `${p}Description edited`, actionable: true });

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

function diffPull(before: EntitySnapshot, after: EntitySnapshot, ctx: { prefix: string; viewer: string | null }): Change[] {
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
    changes.push({ text: `${p}Checks finished: ${aChecks}${a.checks!.failing.length > 0 ? ` (failing: ${a.checks!.failing.join(", ")})` : ""}`, actionable: true });
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

/** Every change between two observations: the entity, then each linked pull request. */
export function diffObserved(before: Observed, after: Observed, ctx: { own: ReadonlySet<string>; stewardThreadId: string | null; approved: boolean; cursor: string }): Change[] {
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
    if (fresh.length > 0) changes.push({ text: `${e === after.entity ? "" : `${e.key}: `}${fresh.length} new comment${fresh.length === 1 ? "" : "s"} from ${[...new Set(fresh.map((c) => c.author))].join(", ")}`, actionable: true });
  }
  return changes;
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

export function gateState(playbook: Playbook, ready: ReadyState, currentSpecHash: string): GateState {
  if (playbook.ready === null) return { none: true, checklistMet: true, unmet: [], substantial: null, approvalNeeded: false, approved: false, approvalStale: false, passed: true };
  const items = playbook.ready.checklist;
  const unmet = items.filter((item) => !ready.checklist.some((c) => c.item.toLowerCase() === item.toLowerCase() && c.met));
  const checklistMet = unmet.length === 0;
  // Unjudged counts as substantial: the safe side of the gate.
  const approvalNeeded = ready.substantial !== false;
  const approved = ready.approval !== null;
  const approvalStale = approved && ready.approval!.specHash !== currentSpecHash;
  const passed = checklistMet && (!approvalNeeded || (approved && !approvalStale));
  return { none: false, checklistMet, unmet, substantial: ready.substantial, approvalNeeded, approved, approvalStale, passed };
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
 */
export function lifecycle(binding: Pick<Binding, "kind" | "endedAt" | "endReason" | "manualDetach">, playbook: Playbook, entity: EntitySnapshot, label: string): Lifecycle {
  const terminal = isTerminal(playbook, entity.state);
  const labelled = binding.kind === "review" || hasLabel(entity, label);
  if (binding.endedAt !== null) {
    if (terminal || !labelled || binding.manualDetach) return { kind: "stay-ended" };
    if (binding.endReason === "terminal") return { kind: "reopen", why: `reopened: now ${entity.state}` };
    if (binding.endReason === "detach") return { kind: "reopen", why: `the ${label} label is back` };
    return { kind: "stay-ended" };
  }
  if (terminal) return { kind: "terminal" };
  if (!labelled) return { kind: "detach" };
  return { kind: "continue" };
}

export { hasLabel };

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
