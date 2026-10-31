// Approvals: the project steward's decision on an owner-reviewed pull request.
// Posting and recording the `bb-approval` marker, filing and refreshing the
// owner's `approve-pr` item, delivering the decision to the pull request's
// worker, and the Stewards page's approve/decline buttons. Kept in its own
// module because this is gate code: a pull request that touches it is always
// the owner's, whatever the decide list says (BB-153).
//
// The functions take an `ApprovalsContext` rather than the server's whole
// closure, so nothing here reads the plugin's config or snapshots on its own.
import { type BigDecision, explainDecision, formatDecisionListing } from "./decisions.js";
import { approvalMarkerLine, prGate, reviewWorkerThread, type PrGate } from "./gate.js";
import { parsePullRef, type GithubWriter } from "./github.js";
import { workerInFlight } from "./reconcile.js";
import { signatureLine, type EntitySnapshot, type Source } from "./source-contract.js";
import type { Binding, Need, Observed, Store } from "./store.js";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What the approval functions need from the server: the store and GitHub
 * writer, the clock, and the few server helpers that read snapshots, deliver
 * messages and load the decide list. Passed in so this module holds no state.
 */
export type ApprovalsContext = {
  store: Store;
  github: GithubWriter;
  now: () => number;
  shortSha: (sha: string | null | undefined) => string;
  scheduleReconcile: (bindingId: string) => void;
  snapshot: (source: Source, id: string) => Promise<EntitySnapshot | null>;
  linkedPulls: (entity: EntitySnapshot) => Promise<EntitySnapshot[]>;
  threadInfo: (threadId: string) => Promise<{ deletedAt: number | null; archivedAt: number | null } | null>;
  sendTo: (threadId: string, text: string) => Promise<"sent" | "gone" | "failed" | "unavailable">;
  wakeProject: (projectId: string, reason: string, opts: { digestDue: boolean; notes?: string[] }) => Promise<void>;
  pullChangedFiles: (entity: EntitySnapshot) => Promise<string[] | null>;
  loadDecisions: (projectId: string) => Promise<readonly BigDecision[]>;
  observedPulls: (b: Binding, observed: Observed) => EntitySnapshot[];
};

/**
 * Post the plugin's `bb-approval` marker on a pull request as `byThread`
 * and return the GitHub comment id. The marker is signed, so `ownerApproval`
 * never reads it as the owner's unsigned approval, and the returned id is what
 * the lane gate matches the store's record against.
 */
export async function postApprovalMarker(ctx: ApprovalsContext, entity: EntitySnapshot, byThread: string, fields: { headSha: string; entry: string | null; verdict: "approved" | "declined"; reasoning: string }): Promise<string> {
  const ref = parsePullRef(entity.url ?? entity.key);
  if (ref === null) throw new Error(`I cannot tell which pull request ${entity.key} is.`);
  if (fields.headSha.trim() === "") throw new Error("The pull request's head sha is not known yet, so the marker cannot name it. Retry once the pull request has been observed.");
  const body = [approvalMarkerLine({ sha: fields.headSha, entry: fields.entry, verdict: fields.verdict }), "", fields.reasoning.trim(), "", signatureLine(byThread)].join("\n");
  return ctx.github.comment(ref.repo, ref.number, body);
}

/**
 * Tell the pull request's worker the project steward's decision landed, so it
 * merges (or reworks) without a `github_watch` on the owner. The worker is the
 * thread that posted build-tickets' "Independent review running" comment, or
 * the newest worker still in flight. When it has ended and cannot be reached,
 * the ticket steward is woken with the decision under "What changed" and
 * starts a fresh worker at the build-tickets merge step.
 */
export async function deliverProjectApproval(ctx: ApprovalsContext, b: Binding, entity: EntitySnapshot, decision: { verdict: "approved" | "declined"; sha: string; entry: string | null; reasoning: string }): Promise<"worker" | "steward"> {
  const signed = reviewWorkerThread(entity.comments);
  const thread = (signed !== null && ctx.store.worker(signed)?.bindingId === b.id ? signed : null) ?? [...ctx.store.workers(b.id)].reverse().find((w) => workerInFlight(w))?.threadId ?? null;
  const info = thread === null ? null : await ctx.threadInfo(thread).catch(() => null);
  const label = decision.verdict === "approved" ? "approved" : "declined";
  const entry = decision.entry === null ? "" : ` (entry ${JSON.stringify(decision.entry)})`;
  const next = decision.verdict === "approved" ? "the lane gate is met: merge it now (build-tickets, The merge gate), do not wait for the owner" : "the lane gate is not met: treat this as a change request and address it";
  if (info !== null && info.deletedAt === null && info.archivedAt === null) {
    if ((await ctx.sendTo(thread!, `The project steward ${label} ${entity.key}${entry} at ${ctx.shortSha(decision.sha)}: ${decision.reasoning}\n\n${next}.`)) === "sent") {
      ctx.store.note(b.id, `The project steward ${label} ${entity.key}${entry} at ${ctx.shortSha(decision.sha)}; its worker was told.`, true);
      return "worker";
    }
  }
  ctx.store.note(b.id, `The project steward ${label} ${entity.key}${entry} at ${ctx.shortSha(decision.sha)}: ${decision.reasoning} Start a worker at the build-tickets merge gate ${decision.verdict === "approved" ? "to merge it" : "to address the change request"}.`, false);
  ctx.scheduleReconcile(b.id);
  return "steward";
}

/**
 * Post and record one project-steward decision in the order the gate needs:
 * the marker first, so a GitHub failure leaves nothing recorded and the
 * request open to retry. Used by `steward_update { approve }` and the decline
 * that resolves an `approve-decline` escalation.
 */
export async function recordProjectDecision(ctx: ApprovalsContext, b: Binding, pull: EntitySnapshot, threadId: string, fields: { headSha: string; entry: string | null; verdict: "approved" | "declined"; reasoning: string }): Promise<{ commentId: string }> {
  const commentId = await postApprovalMarker(ctx, pull, threadId, fields);
  ctx.store.recordProjectApproval({ bindingId: b.id, headSha: fields.headSha, entry: fields.entry, byThread: threadId, commentId, verdict: fields.verdict });
  return { commentId };
}

/**
 * Whether a pull request's author is someone other than the server's gh
 * login: a teammate's, where the owner can give a real GitHub review rather
 * than the self-approval comment an agent PR needs (BB-118).
 */
export function isForeignPull(pull: EntitySnapshot): boolean {
  return pull.author !== null && pull.viewer !== null && pull.author.toLowerCase() !== pull.viewer.toLowerCase();
}

/**
 * File or refresh the user's `approve-pr` item: the owner approves on GitHub
 * from the Stewards page. Deduped by (binding, kind, url), so a push updates
 * the same item's sha rather than closing and refiling it (BB-51). On a
 * teammate's pull request the owner can approve with a real GitHub review, so
 * the item says that rather than the agent-PR comment convention (BB-118).
 */
export function fileApprovePrNeed(ctx: ApprovalsContext, b: Binding, pull: EntitySnapshot, escalationId: string, headSha: string | null, listing: string | null = null): void {
  const foreign = isForeignPull(pull);
  const how = foreign
    ? `Submit an APPROVED review as you from the Stewards page; that is what counts as your approval.`
    : `Post the unsigned comment "Approved ${ctx.shortSha(headSha)} from the Stewards page" as you; that is what counts as your approval.`;
  // A later refresh (checks went red) may not have the files at hand; keep
  // the listing an earlier wake stored for the same head rather than
  // dropping it or showing the previous head's listing (BB-135).
  const url = pull.url ?? pull.key;
  const existing = ctx.store.openNeeds(b.id).find((n) => n.kind === "approve-pr" && n.url === url);
  const carried = listing ?? (existing?.data.decideListingSha === headSha && typeof existing.data.decideListing === "string" ? existing.data.decideListing : null);
  ctx.store.fileNeed({
    bindingId: b.id,
    kind: "approve-pr",
    url,
    what: `Approve ${pull.key} on GitHub`,
    how: carried === null ? how : `${how}\n\n${carried}`,
    data: { sha: headSha, escalationId, foreign, ...(carried === null ? {} : { decideListing: carried, decideListingSha: headSha }) },
    filedBy: "plugin",
  });
}

/**
 * File the user's `approve-pr` item when the project steward forwards an
 * `approval` escalation to them: the same listing the project steward saw, so
 * the approval route is legible (BB-135). The item is filed even when the pull
 * request is not in the binding's last snapshot; it then carries no listing.
 */
export async function fileForwardedApprovePrNeed(ctx: ApprovalsContext, b: Binding, forwarding: { id: string; question: string; url: string | null; headSha: string | null }): Promise<void> {
  const pull = b.lastSnapshot === null ? undefined : ctx.observedPulls(b, b.lastSnapshot).find((p) => (p.url ?? p.key) === forwarding.url);
  const key = forwarding.question.replace(/^Approve\s+/u, "");
  const listing = pull === undefined ? null : formatDecisionListing(explainDecision(await ctx.pullChangedFiles(pull), await ctx.loadDecisions(b.projectId)));
  const how = `Post the unsigned comment "Approved ${ctx.shortSha(forwarding.headSha)} from the Stewards page" as you; that is what counts as your approval.`;
  ctx.store.fileNeed({
    bindingId: b.id,
    kind: "approve-pr",
    url: forwarding.url ?? b.url ?? "",
    what: `Approve ${key} on GitHub`,
    how: listing === null ? how : `${how}\n\n${listing}`,
    data: { sha: forwarding.headSha, escalationId: forwarding.id, ...(listing === null ? {} : { decideListing: listing, decideListingSha: forwarding.headSha }) },
    filedBy: "plugin",
  });
}

/** A reviewer marker's identity: a new round on the same head is a new marker (BB-51). */
export const markerKey = (m: { round: number; sha: string } | null): string | null => (m === null ? null : `${m.round}:${m.sha}`);

/**
 * The comment or review that satisfied the gate, as "comment 6533…" or
 * "review 123…", with its URL; empty when the gate has no id to name. The
 * resolution text carries it so a closed approve-pr item is traceable to
 * what closed it (BB-151).
 */
export function approvalRef(g: PrGate): string {
  const id = g.projectApproved ? g.projectApprovalId : g.ownerApprovalId;
  if (id === null) return "";
  const url = g.projectApproved ? g.projectApprovalUrl : g.ownerApprovalUrl;
  const kind = g.projectApproved ? "comment" : (g.ownerApprovalKind ?? "comment");
  return url === null ? `${kind} ${id}` : `${kind} ${id}, ${url}`;
}

/** The gate and the escalation facts the per-pull approval sync reports back. */
export type PullApprovalResult = { gate: PrGate; closed: boolean; approvalRaised: boolean };

/**
 * The plugin's `approve-pr` handling for one observed pull request: decide the
 * lane, file or refresh or close the owner's item, and raise or reroute the
 * project steward's escalation. `decisions` is the project's decide list, read
 * once by the caller. The merge item is the caller's; this returns the gate so
 * it can file it.
 */
export async function syncPullApproval(ctx: ApprovalsContext, b: Binding, pull: EntitySnapshot, decisions: readonly BigDecision[]): Promise<PullApprovalResult> {
  const url = pull.url ?? pull.key;
  // The decide list places the pull request: a `project` entry whose paths
  // the change touches is the project steward's, and everything else is
  // the user's, filed on the page at once (BB-51). The files are read only
  // when the lane actually waits on an approval.
  const preliminary = prGate(pull, { projectApprovals: ctx.store.projectApprovals(b.id) });
  let g = preliminary;
  // The decide-list listing is fetched once, with the changed files, and
  // passed to whichever surface asks for the approval (BB-135).
  let listing: string | null = null;
  if (preliminary.lane !== "no-review" && preliminary.marker?.verdict === "approved" && preliminary.checksGreen && !preliminary.ownerApproved && !preliminary.projectApproved) {
    const files = await ctx.pullChangedFiles(pull);
    const explanation = explainDecision(files, decisions);
    listing = formatDecisionListing(explanation);
    g = prGate(pull, { decision: explanation.mark, projectApprovals: ctx.store.projectApprovals(b.id) });
  }
  const closed = pull.pull?.merged === true || pull.state === "merged" || pull.state === "closed";
  const approvalEsc = ctx.store.openEscalations(b.id).find((x) => x.kind === "approval" && x.url === url && x.resolutionKind === "approve-decline") ?? null;
  const markerSha = markerKey(g.marker);
  let approvalRaised = false;
  if (closed) {
    ctx.store.closeNeedByKey(b.id, "approve-pr", url, "The pull request is closed.");
    if (approvalEsc !== null) ctx.store.resolve(approvalEsc.id, "The pull request is closed.");
    return { gate: g, closed: true, approvalRaised: false };
  }
  if (g.needsOwnerApproval) {
    // The user's lane: the page item is filed as soon as the reviewer's
    // marker is approved and checks are green, with no project-steward
    // turn (BB-51). Deduped by (binding, kind, url), so a push updates the
    // same item rather than closing and refiling it. A head and marker
    // the owner already declined from the page are not asked again; a
    // new round or a new push files the item afresh (BB-118).
    if (b.declinedPrHeadSha === g.headSha && b.declinedPrMarker === markerSha) {
      ctx.store.closeNeedByKey(b.id, "approve-pr", url, "Declined on the Stewards page; waiting for a new review round.");
      if (approvalEsc !== null) ctx.store.resolve(approvalEsc.id, "Declined on the Stewards page.");
    } else if (approvalEsc === null) {
      const x = ctx.store.escalate({ bindingId: b.id, kind: "approval", question: `Approve ${pull.key}`, meanwhile: "Waiting: the owner approves on GitHub from the Stewards page.", route: "me", recommendation: null, resolutionKind: "approve-decline", url, headSha: g.headSha, projectId: b.projectId });
      fileApprovePrNeed(ctx, b, pull, x.id, g.headSha, listing);
    } else {
      if (approvalEsc.headSha !== g.headSha) ctx.store.setEscalationHead(approvalEsc.id, g.headSha);
      if (approvalEsc.route !== "me") ctx.store.reroute(approvalEsc.id, "me", approvalEsc.recommendation);
      fileApprovePrNeed(ctx, b, pull, approvalEsc.id, g.headSha, listing);
    }
  } else if (g.needsProjectApproval) {
    // The project steward's lane: one escalation, no page item.
    ctx.store.closeNeedByKey(b.id, "approve-pr", url, "Owner review is the project steward's to decide.");
    if (approvalEsc === null) {
      // A decline of this head and reviewer marker is not asked again.
      if (!(b.declinedPrHeadSha === g.headSha && b.declinedPrMarker === markerSha)) {
        ctx.store.escalate({ bindingId: b.id, kind: "approval", question: `Approve ${pull.key}`, meanwhile: "Wait for the project steward's decision.", route: "project", recommendation: null, resolutionKind: "approve-decline", url, headSha: g.headSha, projectId: b.projectId });
        approvalRaised = true;
      }
    } else {
      if (approvalEsc.headSha !== g.headSha) ctx.store.setEscalationHead(approvalEsc.id, g.headSha);
      if (approvalEsc.route === "me") {
        // A change from the user's lane to the project steward's: ask it.
        ctx.store.reroute(approvalEsc.id, "project", null);
        approvalRaised = true;
      }
    }
  } else if (approvalEsc !== null) {
    if (g.checksGreen === false) {
      // Checks went pending or failing: never resolve the request as
      // approved. Keep it and the page item open, re-pointed at the head.
      if (approvalEsc.headSha !== g.headSha) ctx.store.setEscalationHead(approvalEsc.id, g.headSha);
      if (approvalEsc.route === "me") fileApprovePrNeed(ctx, b, pull, approvalEsc.id, g.headSha, listing);
      ctx.store.note(b.id, `${pull.key}'s checks are ${g.checksState ?? "not run"}; its approval request stays open.`, true);
    } else if (g.ownerApproved || g.projectApproved) {
      // The resolution names what approved, so a closed item can always
      // be traced to the comment or review that closed it (BB-151).
      const ref = approvalRef(g);
      const suffix = ref === "" ? "" : ` (${ref})`;
      ctx.store.closeNeedByKey(b.id, "approve-pr", url, `Approval is present${suffix}.`);
      ctx.store.resolve(approvalEsc.id, `Approved by ${g.projectApproved ? "the project steward" : "the owner"}${suffix}.`);
    } else {
      // The marker is no longer approved (or gone): withdraw the request
      // with the gate's words, never "Approved.".
      const why = g.missing ?? "The pull request is not waiting for an owner approval.";
      ctx.store.closeNeedByKey(b.id, "approve-pr", url, why);
      ctx.store.resolve(approvalEsc.id, why);
    }
  } else {
    ctx.store.closeNeedByKey(b.id, "approve-pr", url, `${g.missing ?? "The pull request is not waiting for an owner approval."}`);
  }
  return { gate: g, closed: false, approvalRaised };
}

/** The pull request a page action names, read fresh, falling back to the last snapshot. */
async function freshPull(ctx: ApprovalsContext, b: Binding, url: string): Promise<EntitySnapshot | null> {
  const entity = (b.source === "ops" ? null : await ctx.snapshot(b.source, b.entityId).catch(() => null)) ?? b.lastSnapshot?.entity ?? null;
  if (entity === null) return null;
  const pulls = b.kind === "ticket" ? await ctx.linkedPulls(entity) : [];
  return [entity, ...pulls].find((e) => (e.url ?? e.key) === url || e.key === url) ?? (entity.pull === null ? null : entity);
}

/**
 * The Stewards page's Approve/Decline buttons on an `approve-pr` item. It acts
 * on GitHub as the connected user (a real APPROVED review on a teammate's
 * pull request, an unsigned comment on an agent's), closes the item and wakes
 * the steward. The same head and reviewer marker are not asked again until a
 * new round or a new push (BB-118).
 */
export async function approvePrPageAction(ctx: ApprovalsContext, b: Binding, need: Need, action: "approve" | "decline", text: string | null): Promise<{ ok: boolean; message: string }> {
  const ref = parsePullRef(need.url);
  if (ref === null) return { ok: false, message: `I cannot tell which pull request ${need.url} is.` };
  const pull = await freshPull(ctx, b, need.url);
  const gate = pull === null ? null : prGate(pull);
  if (pull === null || gate === null || !gate.needsOwnerApproval) return { ok: false, message: `Not now: ${gate?.missing ?? "the pull request has not been observed yet"}.` };
  const foreign = isForeignPull(pull);
  const after = (closure: string): void => {
    ctx.store.note(b.id, closure);
    if (text !== null) ctx.store.addGuidance(b.id, text, "user");
    ctx.scheduleReconcile(b.id);
  };
  if (action === "decline") {
    try {
      if (foreign) await ctx.github.review(ref.repo, ref.number, text === null ? "COMMENT" : "REQUEST_CHANGES", `Declined ${ctx.shortSha(gate.headSha)} from the Stewards page${text === null ? "" : `: ${text}`}`);
      else await ctx.github.comment(ref.repo, ref.number, `Declined ${ctx.shortSha(gate.headSha)} from the Stewards page${text === null ? "" : `: ${text}`}`);
    } catch (error) {
      return { ok: false, message: `GitHub refused the ${foreign ? "review" : "comment"}: ${errorMessage(error)}` };
    }
    // The same head and reviewer marker are not asked again until a
    // new round or a new push (BB-118).
    ctx.store.patch(b.id, { declinedPrHeadSha: gate.headSha, declinedPrMarker: markerKey(gate.marker) });
    ctx.store.closeNeedByKey(b.id, "approve-pr", need.url, "Declined on the Stewards page.");
    after(`The user declined ${pull.key} from the Stewards page${text === null ? "" : `: "${text}"`}.`);
    return { ok: true, message: `Declined; ${b.entityKey}'s steward has been told.` };
  }
  if (foreign) {
    try {
      await ctx.github.review(ref.repo, ref.number, "APPROVE", "");
    } catch (error) {
      return { ok: false, message: `GitHub refused the review: ${errorMessage(error)}` };
    }
    ctx.store.closeNeedByKey(b.id, "approve-pr", need.url, "Approved on the Stewards page.");
    after(`The user approved ${pull.key} from the Stewards page.`);
    return { ok: true, message: `Approved; ${b.entityKey}'s steward has been told.` };
  }
  const body = `Approved ${gate.headSha ?? "?"} from the Stewards page`;
  try {
    await ctx.github.comment(ref.repo, ref.number, body);
  } catch (error) {
    return { ok: false, message: `GitHub refused the comment: ${errorMessage(error)}` };
  }
  ctx.store.closeNeedByKey(b.id, "approve-pr", need.url, "Approved on the Stewards page.");
  after(`The user approved ${pull.key} from the Stewards page: "${body}".`);
  return { ok: true, message: `Approved; ${b.entityKey}'s steward has been told.` };
}
