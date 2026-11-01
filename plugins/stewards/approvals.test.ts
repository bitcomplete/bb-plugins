// The approvals module's own tests (BB-192). `recordProjectDecision` is the one
// path that posts a project-steward `bb-approval` marker, so it is where the
// refusal for a reviewer's owner call belongs; the RPC and wake surfaces that
// reach it are pinned in server.test.ts and wake.test.ts.
import { describe, expect, it, vi } from "vitest";
import { recordProjectDecision, type ApprovalsContext } from "./approvals.js";
import { comment, pull } from "./fixtures.js";

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
