// The approvals module's own tests (BB-192). `recordProjectDecision` is the one
// path that posts a project-steward `bb-approval` marker, so it is where the
// refusal for a reviewer's owner call belongs; the RPC and wake surfaces that
// reach it are pinned in server.test.ts and wake.test.ts.
//
// BB-279: an owner's page approval and the project steward's decision deliver
// to a parked worker by the same path (`deliverProjectApproval`).
import { describe, expect, it, vi } from "vitest";
import { approvalRef, approvePrPageAction, deliverApproval, deliverProjectApproval, isDelegateWait, isUserThread, recordProjectDecision, syncPullApproval, userApprovedOnEntity, userSaid, type ApprovalsContext } from "./approvals.js";
import { isSelfWidening } from "./decisions.js";
import { prGate } from "./gate.js";
import { comment, parkedWorker, pull } from "./fixtures.js";
import type { Binding, Need } from "./store.js";

const head = "aaaaaaa1";
const green = { checks: { state: "success", failing: [] } };
const marker = (approver?: string) =>
  comment({
    id: "m1",
    author: "trotterdylan",
    body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=owner-reviewed${approver === undefined ? "" : ` approver=${approver}`} -->`,
    signedBy: "thr_reviewer",
    createdAt: "2026-10-14T16:00:00Z",
  });

/** The two collaborators `recordProjectDecision` touches: the GitHub writer and the store. */
function context() {
  const githubComment = vi.fn().mockResolvedValue("IC_1");
  const recordProjectApproval = vi.fn();
  const ctx = { github: { comment: githubComment }, now: () => 0, store: { recordProjectApproval, assessment: () => null, recordAssessment: vi.fn(), projectApprovals: () => [], pullRequesters: () => [], reviewerRequests: () => [] } } as unknown as ApprovalsContext;
  return { ctx, githubComment, recordProjectApproval };
}

const fields = { headSha: head, entry: "A cross-repo contract", verdict: "approved" as const, reasoning: "Approved." };

describe("the project steward's approval of an escalated pull request (BB-192)", () => {
  it("refuses to post a bb-approval when the reviewer escalated it to the owner", async () => {
    const { ctx, githubComment, recordProjectApproval } = context();
    const entity = pull({ comments: [marker("owner")] }, green);
    await expect(recordProjectDecision(ctx, { id: "b1" } as never, entity, "thr_project", fields)).rejects.toThrow(/reviewer escalated this pull request to the owner/u);
    // Nothing is posted and nothing is recorded, so the request stays open.
    expect(githubComment).not.toHaveBeenCalled();
    expect(recordProjectApproval).not.toHaveBeenCalled();
  });

  it("refuses when the approver is missing or unknown (fail closed), for an approval or a decline", async () => {
    for (const approver of [undefined, "something"]) {
      for (const verdict of ["approved", "declined"] as const) {
        const { ctx, githubComment, recordProjectApproval } = context();
        const entity = pull({ comments: [marker(approver)] }, green);
        await expect(recordProjectDecision(ctx, { id: "b1" } as never, entity, "thr_project", { ...fields, verdict, reasoning: "No." })).rejects.toThrow(/escalated/u);
        expect(githubComment).not.toHaveBeenCalled();
        expect(recordProjectApproval).not.toHaveBeenCalled();
      }
    }
  });

  it("posts when the reviewer left the decision to the project steward (approver=project)", async () => {
    const { ctx, githubComment, recordProjectApproval } = context();
    const entity = pull({ comments: [marker("project")] }, green);
    await expect(recordProjectDecision(ctx, { id: "b1" } as never, entity, "thr_project", fields)).resolves.toEqual({ commentId: "IC_1" });
    expect(githubComment).toHaveBeenCalledTimes(1);
    expect(recordProjectApproval).toHaveBeenCalledTimes(1);
  });
});

describe("an approval is delivered to a parked worker (BB-279)", () => {
  /** A context with one parked worker; the delivery path reaches it through `store.workers`. */
  function deliveryContext() {
    const worker = parkedWorker();
    const sendTo = vi.fn().mockResolvedValue("sent");
    const note = vi.fn();
    const scheduleReconcile = vi.fn();
    const closeNeedByKey = vi.fn();
    const addGuidance = vi.fn();
    const mechanicalStatus = vi.fn();
    const githubComment = vi.fn().mockResolvedValue("IC_1");
    const githubReview = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      store: {
        worker: (id: string) => (id === worker.threadId ? worker : null),
        workers: () => [worker],
        note,
        closeNeedByKey,
        addGuidance,
        patch: vi.fn(),
        assessment: () => null,
        recordAssessment: vi.fn(),
        projectApprovals: () => [],
        pullRequesters: () => [],
        reviewerRequests: () => [],
      },
      github: { comment: githubComment, review: githubReview },
      now: () => 0,
      shortSha: (sha: string | null | undefined) => (sha ?? "").slice(0, 7),
      scheduleReconcile,
      snapshot: vi.fn().mockResolvedValue(null),
      linkedPulls: vi.fn().mockResolvedValue([]),
      threadInfo: vi.fn().mockResolvedValue({ deletedAt: null, archivedAt: null }),
      sendTo,
      wakeProject: vi.fn(),
      pullChangedFiles: vi.fn().mockResolvedValue([]),
      loadDecisions: vi.fn().mockResolvedValue([]),
      observedPulls: vi.fn().mockReturnValue([]),
      mechanicalStatus,
    } as unknown as ApprovalsContext;
    return { ctx, worker, sendTo, note, scheduleReconcile, closeNeedByKey, addGuidance, mechanicalStatus, githubComment, githubReview };
  }

  it("delivers the project steward's decision to the parked worker", async () => {
    const { ctx, worker, sendTo, mechanicalStatus } = deliveryContext();
    const entity = pull({ comments: [] }, green);
    await expect(deliverProjectApproval(ctx, { id: "b1" } as never, entity, { verdict: "approved", sha: head, entry: null, reasoning: "Approved." })).resolves.toBe("worker");
    expect(sendTo).toHaveBeenCalledTimes(1);
    const [threadId, message] = sendTo.mock.calls[0]!;
    expect(threadId).toBe(worker.threadId);
    expect(message).toContain("The project steward approved");
    expect(message).toContain("merge it now");
    expect(mechanicalStatus).toHaveBeenCalledTimes(1);
  });

  it("delivers a gate-met no-review pull request naming the gate, not an approver (BB-279)", async () => {
    const { ctx, worker, sendTo } = deliveryContext();
    const entity = pull({ comments: [] }, green);
    await expect(deliverApproval(ctx, { id: "b1" } as never, entity, { verdict: "approved", sha: head, entry: null, reasoning: "a parked worker owns another open pull request." }, null)).resolves.toBe("worker");
    const [threadId, message] = sendTo.mock.calls[0]!;
    expect(threadId).toBe(worker.threadId);
    expect(message).toContain("The lane gate is met (no-review)");
    expect(message).toContain("merge it now");
    // It must not claim an approval nobody gave.
    expect(message).not.toContain("approved");
  });

  it("records the no-review gate wording, not a null approver, when the worker cannot be reached (BB-279)", async () => {
    const { ctx, sendTo, note, scheduleReconcile } = deliveryContext();
    // The parked worker's send fails, so the fallback note is what the
    // steward reads; it must carry the no-review wording too.
    sendTo.mockResolvedValue("failed");
    const entity = pull({ comments: [] }, green);
    await expect(deliverApproval(ctx, { id: "b1" } as never, entity, { verdict: "approved", sha: head, entry: null, reasoning: "a parked worker owns another open pull request." }, null)).resolves.toBe("steward");
    expect(scheduleReconcile).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledTimes(1);
    const [, text, actionable] = note.mock.calls[0]!;
    expect(text).toContain("The lane gate is met (no-review)");
    expect(text).not.toContain("null");
    expect(actionable).toBe(false);
  });

  it("delivers an owner page approval to the parked worker by the same path", async () => {
    const { ctx, worker, sendTo, closeNeedByKey, mechanicalStatus, githubComment } = deliveryContext();
    // The owner is the pull request's author here, so the page posts an
    // unsigned comment (not a GitHub review) and then delivers.
    const entity = pull({ author: "jane", viewer: "jane", comments: [marker("owner")] }, green);
    const b = { id: "b1", source: "ops", kind: "pr", entityId: "acme/web#7", entityKey: "acme/web#7", lastSnapshot: { entity, pulls: [] } } as unknown as Binding;
    const need = { id: "n1", bindingId: "b1", kind: "approve-pr", url: "https://github.com/acme/web/pull/7", what: "Approve acme/web#7", how: null, data: {}, filedBy: "plugin", status: "open", resolution: null, createdAt: 0, resolvedAt: null } as unknown as Need;
    await expect(approvePrPageAction(ctx, b, need, "approve", null)).resolves.toMatchObject({ ok: true });
    expect(githubComment).toHaveBeenCalledTimes(1);
    expect(closeNeedByKey).toHaveBeenCalledTimes(1);
    expect(mechanicalStatus).toHaveBeenCalledTimes(1);
    expect(sendTo).toHaveBeenCalledTimes(1);
    const [threadId, message] = sendTo.mock.calls[0]!;
    expect(threadId).toBe(worker.threadId);
    expect(message).toContain("The owner approved");
    expect(message).toContain("merge it now");
  });

  it("does not tell a teammate's review worker to merge", async () => {
    const { ctx, sendTo, githubReview } = deliveryContext();
    // A teammate's pull request (the author is not the viewer) approves with a
    // real GitHub review. Its worker is a review worker that follows
    // pr-reviewer's "Never merge", and the author merges, so it is not told to.
    const entity = pull({ author: "sam", viewer: "jane", comments: [marker("owner")] }, green);
    const b = { id: "b1", source: "ops", kind: "pr", entityId: "acme/web#7", entityKey: "acme/web#7", lastSnapshot: { entity, pulls: [] } } as unknown as Binding;
    const need = { id: "n1", bindingId: "b1", kind: "approve-pr", url: "https://github.com/acme/web/pull/7", what: "Approve acme/web#7", how: null, data: {}, filedBy: "plugin", status: "open", resolution: null, createdAt: 0, resolvedAt: null } as unknown as Need;
    await expect(approvePrPageAction(ctx, b, need, "approve", null)).resolves.toMatchObject({ ok: true });
    expect(githubReview).toHaveBeenCalledTimes(1);
    expect(sendTo).not.toHaveBeenCalled();
  });

  // BB-292: approvals.ts is a prGate caller. The page's Approve/Decline acts
  // only while the gate's `needsOwnerApproval` is true. A no-review marker's
  // met gate refuses the page action, and the refusal text falls through to
  // the `??` fallback: the gate's `missing` is null when met.
  //
  // DIVERGENCE: the gate answers `gateMet: true` for this pull request, while
  // the page's own refusal says "the pull request has not been observed yet".
  it("DIVERGENCE: pins the page action's prGate caller: a met no-review gate refuses with the not-observed message", async () => {
    const { ctx, worker, githubComment, githubReview, sendTo } = deliveryContext();
    const noReview = comment({ id: "m-nr", author: "trotterdylan", body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=no-review -->`, signedBy: "thr_reviewer", createdAt: "2026-10-14T16:00:00Z" });
    const entity = pull({ comments: [noReview] }, green);
    // The gate-met fixture carries a parked `finished` worker (in the context's
    // store) and a second open own pull request, the BB-291 working rule.
    const second = pull({ key: "acme/web#8", url: "https://github.com/acme/web/pull/8" }, { headSha: "bbbbbbb2" });
    expect(worker.status).toBe("finished");
    expect(ctx.store.workers("b1")).toEqual([worker]);
    const b = { id: "b1", source: "ops", kind: "pr", entityId: "acme/web#7", entityKey: "acme/web#7", workers: [worker], lastSnapshot: { entity, pulls: [second] } } as unknown as Binding;
    const need = { id: "n1", bindingId: "b1", kind: "approve-pr", url: "https://github.com/acme/web/pull/7", what: "Approve acme/web#7", how: null, data: {}, filedBy: "plugin", status: "open", resolution: null, createdAt: 0, resolvedAt: null } as unknown as Need;
    // The gate the caller reads is met; `needsOwnerApproval` is false.
    await expect(approvePrPageAction(ctx, b, need, "approve", null)).resolves.toEqual({ ok: false, message: "Not now: the pull request has not been observed yet." });
    expect(githubComment).not.toHaveBeenCalled();
    expect(githubReview).not.toHaveBeenCalled();
    expect(sendTo).not.toHaveBeenCalled();
  });
});

// BB-327: a requested reviewer is the owner's delegation. The sync files no
// approve-pr need and routes no user escalation while one is outstanding; the
// delegate's APPROVED review meets the lane; a changes-requested delegate is
// re-solicited once per approved head.
const delegateLaneMarker = comment({ id: "m1", author: "trotterdylan", body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=owner-reviewed -->`, signedBy: "thr_reviewer", createdAt: "2026-10-14T16:00:00Z" });
const delegateReview = (author: string, state: string, at: string, commit: string | null = head) => ({
  reviews: [{ author, state, submittedAt: at, commit }],
  comments: [comment({ id: `rev-${author}-${state}`, author, did: state === "approved" ? "approved" : "requested changes", body: "", createdAt: at, signedBy: null })],
});
const delegatePull = (reviewers: string[], extra: { comments?: ReturnType<typeof comment>[]; reviews?: { author: string; state: string; submittedAt: string; commit: string | null }[] } = {}) =>
  pull({ comments: [delegateLaneMarker, ...(extra.comments ?? [])] }, { ...green, requestedReviewers: reviewers, ...(extra.reviews === undefined ? {} : { reviews: extra.reviews }) });
const delegateUrl = "https://github.com/acme/web/pull/7";

/** A context whose store records what `syncPullApproval` does to it. */
function syncContext(existing: Array<Record<string, unknown>> = [], remembered: string[] = []) {
  const fileNeed = vi.fn();
  const escalate = vi.fn(() => ({ id: "esc_new" }));
  const closeNeedByKey = vi.fn();
  const resolve = vi.fn();
  const setEscalationHead = vi.fn();
  const reroute = vi.fn();
  const setEscalationMeanwhile = vi.fn();
  const note = vi.fn();
  const rememberPullRequesters = vi.fn();
  const forgetPullRequester = vi.fn();
  const recordReviewerRequest = vi.fn();
  const requestReviewers = vi.fn().mockResolvedValue(undefined);
  const store = {
    rememberPullRequesters,
    closeNeedByKey,
    openNeeds: () => [],
    fileNeed: vi.fn(),
    openEscalations: () => existing as never[],
    escalate,
    resolve,
    setEscalationHead,
    reroute,
    setEscalationMeanwhile,
    note,
    forgetPullRequester,
    recordReviewerRequest,
    assessment: () => null,
    recordAssessment: vi.fn(),
    projectApprovals: () => [],
    pullRequesters: () => remembered,
    reviewerRequests: () => [],
  };
  const ctx = {
    store,
    github: { comment: vi.fn(), review: vi.fn(), requestReviewers },
    now: () => 0,
    shortSha: (sha: string | null | undefined) => (sha ?? "").slice(0, 7),
    scheduleReconcile: vi.fn(),
    snapshot: vi.fn().mockResolvedValue(null),
    linkedPulls: vi.fn().mockResolvedValue([]),
    threadInfo: vi.fn().mockResolvedValue(null),
    sendTo: vi.fn(),
    wakeProject: vi.fn(),
    pullChangedFiles: vi.fn().mockResolvedValue([]),
    loadDecisions: vi.fn().mockResolvedValue([]),
    observedPulls: vi.fn().mockReturnValue([]),
    mechanicalStatus: vi.fn(),
  } as unknown as ApprovalsContext;
  const b = { id: "b1", projectId: "p1", entityKey: "acme/web#7", source: "ops", kind: "pr", entityId: "acme/web#7", url: delegateUrl, lastSnapshot: null } as unknown as Binding;
  return { ctx, b, fileNeed, escalate, closeNeedByKey, resolve, setEscalationHead, reroute, setEscalationMeanwhile, note, rememberPullRequesters, forgetPullRequester, recordReviewerRequest, requestReviewers };
}

describe("a requested reviewer is the owner's delegation (BB-327)", () => {
  it("files no approve-pr need and routes no user escalation while one is outstanding (criterion 2)", async () => {
    const { ctx, b, fileNeed, escalate, closeNeedByKey, rememberPullRequesters } = syncContext();
    const entity = delegatePull(["arashout"]);
    const result = await syncPullApproval(ctx, b, entity, [], () => prGate(entity));
    expect(result.gate.delegatePending).toBe(true);
    // The request list is remembered for the delegate set.
    expect(rememberPullRequesters).toHaveBeenCalledWith("b1", delegateUrl, ["arashout"]);
    // No page item, and the escalation waits on the delegate, not the user.
    expect(fileNeed).not.toHaveBeenCalled();
    expect(escalate).toHaveBeenCalledTimes(1);
    const fields = (escalate.mock.calls as unknown as Array<[{ route: string; meanwhile: string }]>)[0]![0];
    expect(fields.route).toBe("steward");
    expect(fields.meanwhile).toContain("arashout");
    expect(closeNeedByKey).toHaveBeenCalledWith("b1", "approve-pr", delegateUrl, expect.stringContaining("arashout"));
  });

  it("reroutes an existing owner escalation to the steward and names the delegate (criterion 2)", async () => {
    const esc = { id: "esc1", kind: "approval", url: delegateUrl, resolutionKind: "approve-decline", route: "user", headSha: head, recommendation: null };
    const { ctx, b, fileNeed, escalate, reroute, setEscalationMeanwhile } = syncContext([esc]);
    const entity = delegatePull(["arashout"]);
    await syncPullApproval(ctx, b, entity, [], () => prGate(entity));
    expect(fileNeed).not.toHaveBeenCalled();
    expect(escalate).not.toHaveBeenCalled();
    expect(reroute).toHaveBeenCalledWith("esc1", "steward", null);
    expect(setEscalationMeanwhile).toHaveBeenCalledWith("esc1", expect.stringContaining("arashout"));
  });

  it("forgets a requester the owner withdrew while they had no review (criterion 8)", async () => {
    const { ctx, b, forgetPullRequester } = syncContext([], ["arashout"]);
    // The request list no longer names arashout and they never reviewed.
    const entity = delegatePull([]);
    await syncPullApproval(ctx, b, entity, [], () => prGate(entity));
    expect(forgetPullRequester).toHaveBeenCalledWith("b1", delegateUrl, "arashout");
  });

  it("does not forget a requester who has reviewed (criterion 8)", async () => {
    const { ctx, b, forgetPullRequester } = syncContext([], ["arashout"]);
    const review = delegateReview("arashout", "approved", "2026-10-14T17:00:00Z");
    const entity = delegatePull([], review);
    await syncPullApproval(ctx, b, entity, [], () => prGate(entity));
    expect(forgetPullRequester).not.toHaveBeenCalled();
  });

  it("marks the delegate wait as the plugin's, not the steward's (criterion 2)", () => {
    expect(isDelegateWait({ kind: "approval", route: "steward" })).toBe(true);
    expect(isDelegateWait({ kind: "approval", route: "user" })).toBe(false);
    expect(isDelegateWait({ kind: "approval", route: "project" })).toBe(false);
    expect(isDelegateWait({ kind: "stuck", route: "steward" })).toBe(false);
  });

  it("names the delegate's review in approvalRef (criterion 3)", () => {
    const review = delegateReview("arashout", "approved", "2026-10-14T17:00:00Z");
    const entity = delegatePull(["arashout"], review);
    const g = prGate(entity);
    expect(g.gateMet).toBe(true);
    expect(approvalRef(g)).toBe("review rev-arashout-approved");
  });

  it("re-requests a changes-requested delegate once per approved head (criterion 7)", async () => {
    const { ctx, b, requestReviewers, recordReviewerRequest } = syncContext();
    const review = delegateReview("arashout", "changes requested", "2026-10-14T17:00:00Z", "bbbbbbb2");
    const entity = delegatePull(["arashout"], review);
    await syncPullApproval(ctx, b, entity, [], () => prGate(entity));
    expect(requestReviewers).toHaveBeenCalledTimes(1);
    expect(requestReviewers).toHaveBeenCalledWith("acme/web", 7, ["arashout"]);
    expect(recordReviewerRequest).toHaveBeenCalledWith("b1", delegateUrl, "arashout", head);
  });

  it("does not re-request a delegate already re-requested for the head (criterion 7)", async () => {
    const { ctx, b, requestReviewers } = syncContext();
    const review = delegateReview("arashout", "changes requested", "2026-10-14T17:00:00Z", "bbbbbbb2");
    const entity = delegatePull(["arashout"], review);
    await syncPullApproval(ctx, b, entity, [], () => prGate(entity, { reRequestedDelegates: ["arashout"] }));
    expect(requestReviewers).not.toHaveBeenCalled();
  });
});

// BB-280: the approve/decline recording path lives in this module, so a change
// to it must always be the user's, whatever the decide list matched.
describe("the approval-recording files are self-widening (BB-280)", () => {
  it("classifies approvals.ts and approvals-store.ts as self-widening", () => {
    for (const file of ["bb-plugins/plugins/stewards/approvals.ts", "plugins/stewards/approvals.ts", "bb-plugins/plugins/stewards/approvals-store.ts", "plugins/stewards/approvals-store.ts"]) {
      expect(isSelfWidening([file]), file).toBe(true);
    }
  });

  it("keeps the user's approval detection in approvals.ts", () => {
    expect(typeof userSaid).toBe("function");
    expect(typeof userApprovedOnEntity).toBe("function");
  });

  it("filters the user's turns in approvals.ts, so the logic cannot move back to server.ts", async () => {
    const at = 1_000_000;
    const turn = (createdAt: number, initiator: string, text: string) => ({ createdAt, data: { initiator, input: [{ type: "text", text }] } });
    const ctx = (rows: Array<{ createdAt: number; data: unknown }>, sent: string[] = [], sentSince = 0) =>
      ({ now: () => at, approvalLookbackMs: 60_000, sentSince, turnRequests: async () => rows, pluginSent: async (text: string) => sent.includes(text) }) as unknown as ApprovalsContext;
    // A genuine user turn counts; the plugin's own wake, recorded under its hash, does not.
    await expect(userSaid(ctx([turn(at, "user", "LGTM"), turn(at, "user", "LGTM wake")], ["LGTM wake"]), "thr_user", "LGTM")).resolves.toBe(true);
    await expect(userSaid(ctx([turn(at, "user", "LGTM wake")], ["LGTM wake"]), "thr_user", "LGTM")).resolves.toBe(false);
    // A steward's turn, and a turn from before the plugin recorded its sends, do not count.
    await expect(userSaid(ctx([turn(at, "steward", "LGTM")]), "thr_user", "LGTM")).resolves.toBe(false);
    await expect(userSaid(ctx([turn(at, "user", "LGTM")], [], at + 1), "thr_user", "LGTM")).resolves.toBe(false);
    // A turn older than the lookback does not count.
    await expect(userSaid(ctx([turn(at - 120_000, "user", "LGTM")]), "thr_user", "LGTM")).resolves.toBe(false);
  });

  it("decides whose thread a signed comment is from the store, not a server closure", () => {
    const ctx = (byThread: unknown, worker: unknown, projectByThread: unknown) => ({ store: { byThread: () => byThread, worker: () => worker, projectByThread: () => projectByThread } }) as unknown as ApprovalsContext;
    expect(isUserThread(ctx(null, null, null), "thr_user")).toBe(true);
    expect(isUserThread(ctx({}, null, null), "thr_user")).toBe(false);
    expect(isUserThread(ctx(null, {}, null), "thr_user")).toBe(false);
    expect(isUserThread(ctx(null, null, {}), "thr_user")).toBe(false);
  });
});
