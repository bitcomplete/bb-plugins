// Approvals: the project steward's decision on an owner-reviewed pull request.
// Posting and recording the `bb-approval` marker, filing and refreshing the
// owner's `approve-pr` item, delivering the decision to the pull request's
// worker, and the Stewards page's approve/decline buttons. Kept in its own
// module because this is gate code: a pull request that touches it is always
// the owner's, whatever the decide list says (BB-153).
//
// The functions take an `ApprovalsContext` rather than the server's whole
// closure, so nothing here reads the plugin's config or snapshots on its own.
import { type BigDecision, decideFor, decideForPull, decideForRefusal, explainDecision, formatDecisionListing, type DecideMark } from "./decisions.js";
import type { ApprovalMode } from "./config.js";
import { approvalMarkerLine, classifyApproval, ESCALATED_APPROVAL_REFUSAL, productReason, PRODUCT_APPROVAL_REFUSAL, reviewWorkerThread, type PrGate } from "./gate.js";
import { assessedGate } from "./assessed-gate.js";
import { parsePullRef, type GithubWriter } from "./github.js";
import { isSpecComment, productGateOptions, workerInFlight, type MechanicalEvent } from "./reconcile.js";
import { signatureLine, type EntitySnapshot, type Source } from "./source-contract.js";
import type { Binding, Escalation, Need, Observed, Store } from "./store.js";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const normalizeText = (text: string) => text.replace(/\s+/gu, " ").trim().toLowerCase();

/** The text of a turn's input parts, joined; null when it carries no text (BB-178). */
function turnText(input: unknown): string | null {
  if (!Array.isArray(input)) return null;
  const parts = input.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const p = part as { type?: unknown; text?: unknown };
    return p.type === "text" && typeof p.text === "string" ? [p.text] : [];
  });
  return parts.length === 0 ? null : parts.join("\n");
}

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
  /** The raw `client/turn/requested` rows for a thread, newest first. */
  turnRequests: (threadId: string) => Promise<ReadonlyArray<{ createdAt: number; data: unknown }>>;
  /** Whether the plugin itself sent this text as a wake, recorded under its hash (BB-178). */
  pluginSent: (text: string) => Promise<boolean>;
  /** How far back an approval quote is looked for. */
  approvalLookbackMs: number;
  /** The time this plugin started recording its sends; a turn from before it is never the user's (BB-178). */
  sentSince: number;
  loadDecisions: (projectId: string) => Promise<readonly BigDecision[]>;
  /** The project's decide list, or null when the project file could not be read (BB-280). */
  loadDecisionsOrNull: (projectId: string) => Promise<readonly BigDecision[] | null>;
  observedPulls: (b: Binding, observed: Observed) => EntitySnapshot[];
  /** Write the status the plugin observed itself, without a steward turn (BB-203). */
  mechanicalStatus: (b: Binding, event: MechanicalEvent) => void;
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
 * The thread the pull request's worker is in, or null. The build-tickets
 * "Independent review running" comment names it; when that thread has ended,
 * the newest worker still in flight (a parked `finished` worker included) is
 * used instead.
 */
function workerThreadFor(ctx: ApprovalsContext, b: Binding, entity: EntitySnapshot): string | null {
  const signed = reviewWorkerThread(entity.comments);
  return (signed !== null && ctx.store.worker(signed)?.bindingId === b.id ? signed : null) ?? [...ctx.store.workers(b.id)].reverse().find((w) => workerInFlight(w))?.threadId ?? null;
}

/**
 * Tell the pull request's parked worker that a decision landed, so it merges
 * (or reworks) without a `github_watch` on the owner. The project steward's
 * decision and the owner's page approval both deliver by this one path
 * (BB-279). `actor` is null when the pull request is gate-met with no
 * approval from anyone (a `no-review` lane): the wake then names the gate
 * rather than an approver it would be wrong to name. Returns `worker` when it
 * was told, `steward` when it had ended and the ticket steward must be woken
 * instead.
 */
export async function deliverApproval(ctx: ApprovalsContext, b: Binding, entity: EntitySnapshot, decision: { verdict: "approved" | "declined"; sha: string; entry: string | null; reasoning: string }, actor: "project steward" | "owner" | null): Promise<"worker" | "steward"> {
  const thread = workerThreadFor(ctx, b, entity);
  const info = thread === null ? null : await ctx.threadInfo(thread).catch(() => null);
  const label = decision.verdict === "approved" ? "approved" : "declined";
  const entry = decision.entry === null ? "" : ` (entry ${JSON.stringify(decision.entry)})`;
  const next = decision.verdict === "approved" ? "the lane gate is met: merge it now (build-tickets, The merge gate), do not wait for the owner" : "the lane gate is not met: treat this as a change request and address it";
  // A `no-review` pull request is gate-met with no approval from anyone, so the
  // wake names the gate, not an approver (BB-279).
  const what = actor === null ? `The lane gate is met (no-review) for ${entity.key}${entry} at ${ctx.shortSha(decision.sha)}` : `The ${actor} ${label} ${entity.key}${entry} at ${ctx.shortSha(decision.sha)}`;
  if (info !== null && info.deletedAt === null && info.archivedAt === null) {
    if ((await ctx.sendTo(thread!, `${what}: ${decision.reasoning}\n\n${next}.`)) === "sent") {
      ctx.store.note(b.id, `${what}; its worker was told.`, true);
      return "worker";
    }
  }
  ctx.store.note(b.id, `${what}: ${decision.reasoning} Start a worker at the build-tickets merge gate ${decision.verdict === "approved" ? "to merge it" : "to address the change request"}.`, false);
  ctx.scheduleReconcile(b.id);
  return "steward";
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
  // The project steward's approval is a mechanical status event: the page and
  // sidebar are current before the ticket steward's next turn (BB-203).
  if (decision.verdict === "approved") ctx.mechanicalStatus(b, { kind: "approved", pull: entity.key });
  return deliverApproval(ctx, b, entity, decision, "project steward");
}

/**
 * Post and record one project-steward decision in the order the gate needs:
 * the marker first, so a GitHub failure leaves nothing recorded and the
 * request open to retry. Used by `steward_update { approve }` and the decline
 * that resolves an `approve-decline` escalation. A reviewer's owner call in
 * the marker (`approver=owner`, or a missing/unknown approver) is refused: the
 * project steward does not decide an escalated pull request, whatever the
 * decide list matched (BB-192).
 */
export async function recordProjectDecision(ctx: ApprovalsContext, b: Binding, pull: EntitySnapshot, threadId: string, fields: { headSha: string; entry: string | null; verdict: "approved" | "declined"; reasoning: string }): Promise<{ commentId: string }> {
  const g = assessedGate(ctx.store, b, pull, ctx.now());
  if (g.escalated) throw new Error(g.reason === "product" ? PRODUCT_APPROVAL_REFUSAL : ESCALATED_APPROVAL_REFUSAL);
  const commentId = await postApprovalMarker(ctx, pull, threadId, fields);
  ctx.store.recordProjectApproval({ bindingId: b.id, headSha: fields.headSha, entry: fields.entry, byThread: threadId, commentId, verdict: fields.verdict });
  return { commentId };
}

/** Whether `threadId` is the thread of `b`'s project steward (BB-280). */
export const isProjectSteward = (ctx: ApprovalsContext, threadId: string, b: Binding): boolean => ctx.store.project(b.projectId).threadId === threadId;

/** Whether a thread is the user's own rather than a steward's, a worker's or the project steward's. */
export const isUserThread = (ctx: ApprovalsContext, threadId: string): boolean =>
  ctx.store.byThread(threadId) === null && ctx.store.worker(threadId) === null && ctx.store.projectByThread(threadId) === null;

/**
 * Whether the project steward's thread may approve `b`'s spec under the
 * playbook's `mode`: `project` and the project steward's own thread. `user` is
 * the user's, recorded by quoting their words (BB-280; this acceptance was in
 * server.ts before). The raw `ready.approval` value is accepted so both spec
 * acceptance paths route through here.
 */
export const specApprovedByProject = (ctx: ApprovalsContext, threadId: string, b: Binding, mode: ApprovalMode | null | undefined): boolean => mode === "project" && isProjectSteward(ctx, threadId, b);

/**
 * Whether the user said these words in this thread lately, in their own turn
 * rather than the plugin's own wake (BB-178). The context supplies the user's
 * own recent turns, already filtered to the user and the lookback and
 * normalized. The path was in server.ts before (BB-280).
 */
export async function userSaid(ctx: ApprovalsContext, threadId: string, quote: string): Promise<boolean> {
  const want = normalizeText(quote);
  const rows = await ctx.turnRequests(threadId);
  for (const row of rows) {
    if (ctx.now() - row.createdAt > ctx.approvalLookbackMs) break;
    // A turn from before this plugin started recording its sends cannot be
    // told from the plugin's own wakes, so it is never the owner's (BB-178).
    if (row.createdAt < ctx.sentSince) continue;
    const data = row.data as { initiator?: string; input?: unknown };
    if (data.initiator !== "user") continue;
    const text = turnText(data.input);
    if (text === null) continue;
    if (!normalizeText(text).includes(want)) continue;
    // A wake the plugin sent is recorded under its text's hash; it quotes
    // the entity verbatim and must never count as the owner's approval.
    if (await ctx.pluginSent(text)) continue;
    return true;
  }
  return false;
}

/**
 * Whether the connected user approved in an unsigned comment on the entity,
 * after the latest spec comment (criterion 3). `quote` is matched against the
 * comment's text, so the steward can quote it back. The path was in server.ts
 * before (BB-280).
 */
export function userApprovedOnEntity(ctx: ApprovalsContext, entity: EntitySnapshot | null, stewardThreadId: string | null, quote: string): boolean {
  if (entity === null || entity.viewer === null) return false;
  const viewer = entity.viewer.toLowerCase();
  const latestSpec = entity.comments.filter((c) => isSpecComment(c, stewardThreadId, (threadId) => isUserThread(ctx, threadId))).reduce((max, c) => (c.createdAt > max ? c.createdAt : max), "");
  const want = quote.replace(/\s+/gu, " ").trim().toLowerCase();
  return entity.comments.some(
    (c) =>
      c.signedBy === null &&
      c.author.toLowerCase() === viewer &&
      c.createdAt > latestSpec &&
      classifyApproval(c.body) === "approve" &&
      c.body.replace(/\s+/gu, " ").toLowerCase().includes(want),
  );
}

/**
 * The decide-list placement of a pull request a steward is reporting:
 * `decideForPull` on its changed files, so a steward cannot file the user's
 * item for the project steward's lane (BB-51, BB-280).
 */
export const placeReportedPull = async (ctx: ApprovalsContext, pull: EntitySnapshot, decisions: readonly BigDecision[]): Promise<DecideMark> => decideForPull(await ctx.pullChangedFiles(pull), decisions);

/** The outcome of the project steward's decision on an owner-reviewed pull request from `steward_update`. */
export type ProjectPullDecision = { ok: true; done: string } | { ok: false; error: string };

/**
 * Record the project steward's approval of an owner-reviewed pull request
 * (`steward_update { approve: true, entry }`): the isProjectSteward check, the
 * reviewer's owner call refusal, the decide-list placement, the marker and the
 * delivery. The decide list comes from the context, null when the project file
 * could not be read. The whole path was in server.ts before (BB-280).
 */
export async function approveOwnerReviewedPull(ctx: ApprovalsContext, b: Binding, prApproval: Escalation, threadId: string, fields: { entry: string | null; guidance: string | undefined }): Promise<ProjectPullDecision> {
  if (!isProjectSteward(ctx, threadId, b)) return { ok: false, error: "An owner-reviewed pull request is the project steward's to approve; a steward escalates it and waits." };
  const decisions = await ctx.loadDecisionsOrNull(b.projectId);
  if (decisions === null) return { ok: false, error: "The project file could not be read, so no project-steward approval can be recorded." };
  const observed = b.lastSnapshot;
  const pull = observed === null ? null : [observed.entity, ...observed.pulls].find((e) => (e.url ?? e.key) === prApproval.url) ?? null;
  // A reviewer's owner call in the marker is binding: the project steward does
  // not decide it, whatever entry the decide list matched, and never posts a
  // `bb-approval` on it (BB-192). The product reason (BB-207) binds it the same way.
  const approvalGate = pull === null ? null : assessedGate(ctx.store, b, pull, ctx.now());
  if (approvalGate !== null && approvalGate.escalated) return { ok: false, error: approvalGate.reason === "product" ? PRODUCT_APPROVAL_REFUSAL : ESCALATED_APPROVAL_REFUSAL };
  const files = pull === null ? null : await ctx.pullChangedFiles(pull);
  const decision = decideFor(files, fields.entry, decisions);
  if (decision !== "project") {
    const why = decideForRefusal(files, fields.entry, decisions) ?? "the change is not the project steward's to approve";
    return { ok: false, error: `That pull request is the user's to approve: ${why}. Forward it with steward_update { binding: "${b.entityKey}", forward: "${prApproval.id}", resolution: "approve-decline", recommendation } instead.` };
  }
  const answer = fields.guidance ?? `Approved as ${JSON.stringify(fields.entry)}.`;
  if (pull === null) return { ok: false, error: "The pull request could not be read, so the approval marker cannot be posted." };
  try {
    await recordProjectDecision(ctx, b, pull, threadId, { headSha: prApproval.headSha ?? "", entry: fields.entry, verdict: "approved", reasoning: answer });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  ctx.store.addGuidance(b.id, answer, threadId);
  ctx.store.answerEscalation(prApproval.id, answer, threadId);
  const reached = await deliverProjectApproval(ctx, b, pull, { verdict: "approved", sha: prApproval.headSha ?? "", entry: fields.entry, reasoning: answer });
  return { ok: true, done: `posted the project steward's approval marker on ${prApproval.url} at ${ctx.shortSha(prApproval.headSha)} and ${reached === "worker" ? "told its worker" : "woke the steward"}` };
}

/**
 * Record the project steward's decline of an owner-reviewed pull request that
 * resolves an `approve-decline` escalation: the marker first, then the
 * delivery, so a GitHub failure leaves the request open to retry rather than
 * recording a decision nobody can see. The path was in server.ts before (BB-280).
 */
export async function declineOwnerReviewedPull(ctx: ApprovalsContext, b: Binding, pull: EntitySnapshot, threadId: string, fields: { headSha: string | null; entry: string | null; reasoning: string }): Promise<void> {
  await recordProjectDecision(ctx, b, pull, threadId, { headSha: fields.headSha ?? "", entry: fields.entry, verdict: "declined", reasoning: fields.reasoning });
  await deliverProjectApproval(ctx, b, pull, { verdict: "declined", sha: fields.headSha ?? "", entry: fields.entry, reasoning: fields.reasoning });
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
export function fileApprovePrNeed(ctx: ApprovalsContext, b: Binding, pull: EntitySnapshot, escalationId: string, headSha: string | null, listing: string | null = null, reason: "product" | null = null): void {
  const foreign = isForeignPull(pull);
  const base = foreign
    ? `Submit an APPROVED review as you from the Stewards page; that is what counts as your approval.`
    : `Post the unsigned comment "Approved ${ctx.shortSha(headSha)} from the Stewards page" as you; that is what counts as your approval.`;
  // The product reason (BB-207) points the owner at the Product section of the
  // review, which is what the approval acks.
  const how = reason === "product" ? `${base}\n\nThis pull request is substantial and references no ticket with an approved spec: read the **Product** section of the review before you approve.` : base;
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
  const base = `Post the unsigned comment "Approved ${ctx.shortSha(forwarding.headSha)} from the Stewards page" as you; that is what counts as your approval.`;
  // The same product text the plugin-filed item carries (BB-207).
  const product = productGateOptions(b, pull);
  const how = productReason(product.substantial, product.ticketApprovedSpec) === "product" ? `${base}\n\nThis pull request is substantial and references no ticket with an approved spec: read the **Product** section of the review before you approve.` : base;
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
export async function syncPullApproval(ctx: ApprovalsContext, b: Binding, pull: EntitySnapshot, decisions: readonly BigDecision[], gateFor?: (pull: EntitySnapshot) => PrGate | null): Promise<PullApprovalResult> {
  const url = pull.url ?? pull.key;
  // BB-322: the gate comes from the stored assessment (the reconcile passes
  // its in-memory copy through `gateFor`; otherwise the single `assessedGate`
  // site reads or refreshes it). The decide-list placement is already in it,
  // so this no longer builds a second gate from the changed files. The files
  // are still read for the listing the approval item carries (BB-135).
  let g = gateFor?.(pull) ?? assessedGate(ctx.store, b, pull, ctx.now());
  // The decide-list listing is fetched once, with the changed files, and
  // passed to whichever surface asks for the approval (BB-135).
  let listing: string | null = null;
  if (g.lane !== "no-review" && g.marker?.verdict === "approved" && g.checksGreen && !g.ownerApproved && !g.projectApproved) {
    const files = await ctx.pullChangedFiles(pull);
    listing = formatDecisionListing(explainDecision(files, decisions));
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
      const x = ctx.store.escalate({ bindingId: b.id, kind: "approval", question: `Approve ${pull.key}`, meanwhile: "Waiting: the owner approves on GitHub from the Stewards page.", route: "user", recommendation: null, resolutionKind: "approve-decline", url, headSha: g.headSha, projectId: b.projectId });
      fileApprovePrNeed(ctx, b, pull, x.id, g.headSha, listing, g.reason);
    } else {
      if (approvalEsc.headSha !== g.headSha) ctx.store.setEscalationHead(approvalEsc.id, g.headSha);
      if (approvalEsc.route !== "user") ctx.store.reroute(approvalEsc.id, "user", approvalEsc.recommendation);
      fileApprovePrNeed(ctx, b, pull, approvalEsc.id, g.headSha, listing, g.reason);
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
      if (approvalEsc.route === "user") {
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
      if (approvalEsc.route === "user") fileApprovePrNeed(ctx, b, pull, approvalEsc.id, g.headSha, listing, g.reason);
      ctx.store.note(b.id, `${pull.key}'s checks are ${g.checksState ?? "not run"}; its approval request stays open.`, true);
    } else if (g.baseStale) {
      // The approval is present but stale: the base ref changed after it was
      // given and the head is not based on the default branch tip. The remedy
      // is a rebase, not another approval, so close the request with the
      // gate's words rather than resolving it as approved (BB-279).
      const why = g.missing ?? "Rebase the head onto the default branch.";
      ctx.store.closeNeedByKey(b.id, "approve-pr", url, why);
      ctx.store.resolve(approvalEsc.id, why);
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
  const gate = pull === null ? null : assessedGate(ctx.store, b, pull, ctx.now());
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
    ctx.mechanicalStatus(b, { kind: "approved", pull: pull.key });
    after(`The user approved ${pull.key} from the Stewards page.`);
    // A teammate's pull request is the author's to merge after the owner's
    // approval, so no worker is told to merge it: the review worker follows
    // pr-reviewer's "Never merge", and there is no build worker here to reach.
    return { ok: true, message: `Approved; ${b.entityKey}'s steward has been told.` };
  }
  const body = `Approved ${gate.headSha ?? "?"} from the Stewards page`;
  try {
    await ctx.github.comment(ref.repo, ref.number, body);
  } catch (error) {
    return { ok: false, message: `GitHub refused the comment: ${errorMessage(error)}` };
  }
  ctx.store.closeNeedByKey(b.id, "approve-pr", need.url, "Approved on the Stewards page.");
  ctx.mechanicalStatus(b, { kind: "approved", pull: pull.key });
  after(`The user approved ${pull.key} from the Stewards page: "${body}".`);
  // BB-279: the owner's page approval is delivered to the parked worker by the
  // same path the project steward's decision is. Only the pull request's own
  // (non-foreign) worker is reached: a teammate's pull request is the author's
  // to merge.
  await deliverApproval(ctx, b, pull, { verdict: "approved", sha: gate.headSha ?? "", entry: null, reasoning: text ?? "Approved from the Stewards page." }, "owner");
  return { ok: true, message: `Approved; ${b.entityKey}'s steward has been told.` };
}
