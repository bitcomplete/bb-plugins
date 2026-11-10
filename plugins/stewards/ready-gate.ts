// The ready gate's plugin-side plumbing: the gate a brief reads, and the
// approval request the plugin keeps in step with the gate. This is the ready
// gate seam, kept in its own module so a change to it is always the owner's.
//
// The functions take a `ReadyGateContext` rather than the server's whole
// closure, so nothing here reads the plugin's config or snapshots on its own.
import type { SpecDiff } from "./reconcile.js";
import type { EntitySnapshot } from "./source-contract.js";
import type { Binding, Escalation, ReadyState, Store } from "./store.js";
import type { Playbook } from "./config.js";

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
 * Whether the gate waits on its approver: the checklist is met, the ticket
 * is (or may be) substantial, and the current spec has no approval. The
 * plugin asks the approver itself then, so the gate does not depend on the
 * steward remembering to.
 */
export const approvalWanted = (gate: GateState): boolean => !gate.none && gate.checklistMet && gate.approvalNeeded && !gate.passed;

/**
 * What the ready gate needs from the server: the store, the spec hash and text
 * a binding's approval is pinned to (they read the store for the user's own
 * spec comments), and the plugin log. Passed in so this module holds no state.
 */
export type ReadyGateContext = {
  store: Store;
  specHashFor: (b: Pick<Binding, "threadId">, entity: EntitySnapshot) => string;
  specTextFor: (b: Pick<Binding, "threadId">, entity: EntitySnapshot) => string;
  specDiff: (before: string, after: string, context?: number) => SpecDiff;
  log: (message: string) => void;
};

/**
 * The ready gate for a brief: the live spec hash when the binding has a
 * snapshot, so an approval whose spec changed reads as not passed. The wake
 * does the same; a brief pinned to the approval's own hash would call a stale
 * gate passed on exactly the compacted/non-wake turns it protects.
 */
export const briefGate = (ctx: ReadyGateContext, b: Binding, playbook: Playbook) =>
  gateState(playbook, b.ready, b.lastSnapshot === null ? (b.ready.approval?.specHash ?? "") : ctx.specHashFor(b, b.lastSnapshot.entity));

/**
 * Keep the gate's approval request in step with the gate. While the
 * checklist is met, the ticket is substantial and the current spec has
 * no approval, one `approval` escalation is open with the approver: the
 * project steward, or the user with `approval: user`. It is the plugin's,
 * so the approver hears whatever the steward wrote, and it closes itself
 * once the gate passes or no longer needs an approval. A request the
 * approver declined (guidance + resolve) is not made again until the
 * spec changes. A Linear-state approval is the steward's to wait for.
 *
 * Returns a request just filed with the project steward, for the caller
 * to wake it, once, with whatever else it has to say.
 */
export async function syncApprovalRequest(ctx: ReadyGateContext, b: Binding, playbook: Playbook): Promise<Escalation | null> {
  const mode = playbook.ready?.approval ?? null;
  if (mode === null || typeof mode === "object" || b.lastSnapshot === null) return null;
  // `approval: user` is the user's, and is filed as an `approve-spec` need by
  // syncNeeds; the escalation below is only for the project steward.
  if (mode === "user") return null;
  const open = ctx.store.openEscalations(b.id).filter((x) => x.kind === "approval" && x.resolutionKind !== "approve-decline");
  const current = ctx.specHashFor(b, b.lastSnapshot.entity);
  const gate = gateState(playbook, b.ready, current);
  const wanted = approvalWanted(gate) && b.endedAt === null && b.ending === null && b.ready.declinedSpecHash !== current;
  if (!wanted) {
    const why = gate.passed ? "The spec is approved." : !gate.checklistMet ? "Withdrawn: the ready checklist is no longer met." : !gate.approvalNeeded ? "Withdrawn: the ticket is not substantial." : "Withdrawn.";
    for (const x of open) ctx.store.resolve(x.id, why);
    return null;
  }
  if (open.length > 0) return null;
  // BB-251: the request lists the open assumptions it covers, and records
  // their ids, so the approval confirms exactly those. An assumption
  // recorded after this request was shown is not on the list and stays open.
  const coveredAssumptions = ctx.store.openAssumptions(b.id);
  const assumptionListing =
    coveredAssumptions.length === 0 ? "" : ` It covers ${coveredAssumptions.length} open assumption${coveredAssumptions.length === 1 ? "" : "s"}: ${coveredAssumptions.map((a) => `${a.id} — ${a.text}`).join("; ")}.`;
  // BB-249: a re-approval after an edit carries the same diff the user's
  // item does, so the project steward reads a change rather than a document.
  const prior = b.ready.approval;
  const approvedText = prior?.approvedText ?? b.ready.voidedApprovedText;
  const reapproval = approvedText !== null ? ctx.specDiff(approvedText, ctx.specTextFor(b, b.lastSnapshot.entity)) : null;
  const x = ctx.store.escalate({
    bindingId: b.id,
    kind: "approval",
    question:
      `Approve ${b.entityKey}'s spec${b.title === null ? "" : ` (${b.title})`}? The ready checklist is met and the ticket is ${b.ready.substantial === null ? "not yet judged, so treated as substantial" : "substantial"}${b.ready.why === null ? "" : ` (${b.ready.why})`}; ` +
      (gate.approvalStale ? "the spec has changed since its last approval." : "the current spec has no approval.") +
      assumptionListing,
    meanwhile: "Waiting: no implementation workers start until it is approved.",
    route: "project",
    recommendation: null,
    data: {
      assumptionIds: coveredAssumptions.map((a) => a.id),
      ...(reapproval === null ? {} : { specDiff: reapproval.diff, specChangedLines: reapproval.changedLines }),
    },
  });
  ctx.log(`stewards: ${b.entityKey}'s ready gate waits on the project steward; asked for approval (${x.id})`);
  return x;
}
