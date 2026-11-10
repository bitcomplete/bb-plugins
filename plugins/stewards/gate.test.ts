// The merge gate's base-ref retarget rule (BB-279). An approval given before
// the pull request's base ref changed counts only when the head's merge-base
// with the default branch is the default branch's tip. The rule fires only when
// the base changed after the approval: a pull request based on the default
// branch throughout that is merely behind keeps its approval, because the base
// never changed.
import { describe, expect, it } from "vitest";
import { prGate } from "./gate.js";
import { comment, pull } from "./fixtures.js";

const head = "aaaaaaa1";
const green = { checks: { state: "success", failing: [] } };
const approvalAt = "2026-10-14T16:00:00Z";
const afterApproval = "2026-10-15T00:00:00Z";
const beforeApproval = "2026-10-14T15:00:00Z";

/** The reviewer's owner-reviewed marker; `approver=owner` escalates the pull request to the owner. */
const marker = (approver: string) =>
  comment({
    id: "m1",
    author: "trotterdylan",
    body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=owner-reviewed approver=${approver} -->`,
    signedBy: "thr_reviewer",
    createdAt: "2026-10-14T16:00:00Z",
  });

/** The owner's unsigned approval comment, as the Stewards page posts it. */
const ownerApproval = (createdAt: string) => comment({ id: "o1", author: "jane", did: "commented", body: `Approved ${head} from the Stewards page`, signedBy: null, createdAt });

/** The project steward's recorded `bb-approval` marker. */
const projectMarker = (createdAt: string) => comment({ id: "pa1", author: "trotterdylan", body: `<!-- bb-approval by=project-steward sha=${head} -->`, signedBy: "thr_project", createdAt });
const projectApprovals = [{ commentId: "pa1", verdict: "approved" }];

const ownerPull = (base: { baseChangedAt?: string | null; headMergeBaseIsDefaultTip?: boolean | null }) => pull({ comments: [marker("owner"), ownerApproval(approvalAt)] }, { ...green, ...base });

describe("the merge gate's base-ref retarget rule (BB-279)", () => {
  it("is not met when the base changed after the approval and the head is not based on the default branch", () => {
    const g = prGate(ownerPull({ baseChangedAt: afterApproval, headMergeBaseIsDefaultTip: false }));
    expect(g.gateMet).toBe(false);
    expect(g.missing).toMatch(/rebase the head onto the default branch/u);
    // A stale approval is not a request for another approval: the head must be
    // rebased first, or a fresh approval would let the un-rebased head merge.
    expect(g.baseStale).toBe(true);
    expect(g.needsOwnerApproval).toBe(false);
  });

  it("stays met when the base never changed, even though the head is merely behind", () => {
    // The PR has targeted the default branch throughout: the base ref never
    // changed, so the approval is of this pull request and a moving head is
    // not a reason to ask again.
    const g = prGate(ownerPull({ baseChangedAt: null, headMergeBaseIsDefaultTip: false }));
    expect(g.gateMet).toBe(true);
    expect(g.missing).toBeNull();
  });

  it("stays met when the base changed after the approval but the head was rebased onto the default branch", () => {
    const g = prGate(ownerPull({ baseChangedAt: afterApproval, headMergeBaseIsDefaultTip: true }));
    expect(g.gateMet).toBe(true);
  });

  it("stays met when the base changed before the approval (the approval is of the retargeted state)", () => {
    const g = prGate(ownerPull({ baseChangedAt: beforeApproval, headMergeBaseIsDefaultTip: false }));
    expect(g.gateMet).toBe(true);
  });

  it("fails closed when the source cannot say whether the head is based on the default branch", () => {
    const g = prGate(ownerPull({ baseChangedAt: afterApproval }));
    expect(g.gateMet).toBe(false);
  });

  it("reads the facts from the caller when the snapshot does not carry them", () => {
    const stale = prGate(ownerPull({ baseChangedAt: null, headMergeBaseIsDefaultTip: false }), { baseChangedSinceApproval: true, headMergeBaseIsDefaultTip: false });
    expect(stale.gateMet).toBe(false);
    const rebased = prGate(ownerPull({ baseChangedAt: null, headMergeBaseIsDefaultTip: false }), { baseChangedSinceApproval: true, headMergeBaseIsDefaultTip: true });
    expect(rebased.gateMet).toBe(true);
  });

  it("applies to the project steward's approval too", () => {
    const entity = pull({ comments: [marker("project"), projectMarker(approvalAt)] }, { ...green, baseChangedAt: afterApproval, headMergeBaseIsDefaultTip: false });
    const g = prGate(entity, { decision: "project", projectApprovals });
    expect(g.gateMet).toBe(false);
    expect(g.baseStale).toBe(true);
    expect(g.needsProjectApproval).toBe(false);
  });

  it("leaves a project approval that predates the base change met", () => {
    const entity = pull({ comments: [marker("project"), projectMarker(approvalAt)] }, { ...green, baseChangedAt: beforeApproval, headMergeBaseIsDefaultTip: false });
    expect(prGate(entity, { decision: "project", projectApprovals }).gateMet).toBe(true);
  });
});
