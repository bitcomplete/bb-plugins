// The approvals module's own tests (BB-192). `recordProjectDecision` is the one
// path that posts a project-steward `bb-approval` marker, so it is where the
// refusal for a reviewer's owner call belongs; the RPC and wake surfaces that
// reach it are pinned in server.test.ts and wake.test.ts.
//
// BB-279: an owner's page approval and the project steward's decision deliver
// to a parked worker by the same path (`deliverProjectApproval`).
import { describe, expect, it, vi } from "vitest";
import { approvePrPageAction, deliverProjectApproval, recordProjectDecision, userApprovedOnEntity, userSaid, type ApprovalsContext } from "./approvals.js";
import { isSelfWidening } from "./decisions.js";
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
  const ctx = { github: { comment: githubComment }, store: { recordProjectApproval } } as unknown as ApprovalsContext;
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
});
