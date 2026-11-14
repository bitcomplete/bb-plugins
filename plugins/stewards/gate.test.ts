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

// BB-327: a requested reviewer on an owner-lane pull request is the owner's
// delegation. While they are outstanding the owner is not asked; their
// APPROVED review meets the lane; the viewer's own approval stays an override;
// a changes-requested delegate is re-solicited once per approved head.
const ownerLaneMarker = (verdict = "approved", sha = head) =>
  comment({ id: "m1", author: "trotterdylan", body: `<!-- bb-review round=1 sha=${sha} verdict=${verdict} lane=owner-reviewed -->`, signedBy: "thr_reviewer", createdAt: "2026-10-14T16:00:00Z" });
const pageApproval = comment({ id: "o1", author: "jane", did: "commented", body: `Approved ${head} from the Stewards page`, signedBy: null, createdAt: "2026-10-14T16:30:00Z" });
/** A delegate's review, as both the flattened comment and the `pull.reviews` entry the gate reads. */
const delegateReview = (author: string, state: string, at: string, commit: string | null = head) => ({
  reviews: [{ author, state, submittedAt: at, commit }],
  comments: [comment({ id: `rev-${author}-${state}`, author, did: state === "approved" ? "approved" : "requested changes", body: "", createdAt: at, signedBy: null })],
});

const delegatePull = (reviewers: string[], extra: { comments?: ReturnType<typeof comment>[]; reviews?: { author: string; state: string; submittedAt: string; commit: string | null }[] } = {}) =>
  pull({ comments: [ownerLaneMarker(), ...(extra.comments ?? [])] }, { ...green, requestedReviewers: reviewers, ...(extra.reviews === undefined ? {} : { reviews: extra.reviews }) });

describe("a requested reviewer is the owner's delegation (BB-327)", () => {
  it("does not ask the owner while a requested reviewer is outstanding, and names them (criterion 1)", () => {
    const g = prGate(delegatePull(["arashout"]));
    expect(g.gateMet).toBe(false);
    expect(g.needsOwnerApproval).toBe(false);
    expect(g.delegatePending).toBe(true);
    expect(g.delegates).toEqual(["arashout"]);
    expect(g.missing).toBe("approval needed from arashout");
  });

  it("meets the owner lane on the delegate's APPROVED review (criterion 3)", () => {
    const review = delegateReview("arashout", "approved", "2026-10-14T17:00:00Z");
    const g = prGate(delegatePull(["arashout"], review));
    expect(g.gateMet).toBe(true);
    expect(g.delegateApproved).toBe(true);
    expect(g.delegateApprovalBy).toBe("arashout");
    expect(g.delegateApprovalId).toBe("rev-arashout-approved");
    expect(g.needsOwnerApproval).toBe(false);
  });

  it("still accepts the viewer's own unsigned approval as an override (criterion 4)", () => {
    const g = prGate(delegatePull(["arashout"], { comments: [pageApproval] }));
    expect(g.gateMet).toBe(true);
    expect(g.ownerApproved).toBe(true);
    expect(g.needsOwnerApproval).toBe(false);
  });

  it("revokes a delegate's approval on their later changes-requested, and keeps not asking (criterion 5)", () => {
    const approved = delegateReview("arashout", "approved", "2026-10-14T17:00:00Z");
    const changed = delegateReview("arashout", "changes requested", "2026-10-14T18:00:00Z", "bbbbbbb2");
    const g = prGate(delegatePull(["arashout"], { comments: [...approved.comments, ...changed.comments], reviews: [...approved.reviews, ...changed.reviews] }));
    expect(g.gateMet).toBe(false);
    expect(g.needsOwnerApproval).toBe(false);
    expect(g.delegates).toEqual(["arashout"]);
    // The delegate stays in the delegate set even after GitHub drops them from
    // the live list, because they have submitted a review.
    const remembered = prGate(delegatePull([], { comments: [...approved.comments, ...changed.comments], reviews: [...approved.reviews, ...changed.reviews] }), { rememberedRequesters: ["arashout"] });
    expect(remembered.needsOwnerApproval).toBe(false);
  });

  it("finds a delegate's approval after GitHub dropped them from the live list (criterion 6)", () => {
    const review = delegateReview("arashout", "approved", "2026-10-14T17:00:00Z");
    const entity = delegatePull([], review);
    // The live list is empty, so only the remembered set can find the approval.
    expect(prGate(entity).gateMet).toBe(false);
    expect(prGate(entity, { rememberedRequesters: ["arashout"] }).gateMet).toBe(true);
  });

  it("offers a changes-requested delegate for one re-request per approved head (criterion 7)", () => {
    // The delegate reviewed an earlier head; the current head is new.
    const changed = delegateReview("arashout", "changes requested", "2026-10-14T17:00:00Z", "bbbbbbb2");
    const entity = delegatePull(["arashout"], changed);
    expect(prGate(entity).delegatesToReRequest).toEqual(["arashout"]);
    // A repeated look with the record does not re-request.
    expect(prGate(entity, { reRequestedDelegates: ["arashout"] }).delegatesToReRequest).toEqual([]);
    // A further push without a new approved marker at that head causes none.
    const moved = pull({ comments: [ownerLaneMarker()] }, { ...green, requestedReviewers: ["arashout"], reviews: changed.reviews, headSha: "ccccccc3" });
    expect(prGate(moved).delegatesToReRequest).toEqual([]);
    // A head the independent reviewer has not approved causes none.
    const unapproved = pull({ comments: [ownerLaneMarker("changes-requested")] }, { ...green, requestedReviewers: ["arashout"], reviews: changed.reviews });
    expect(prGate(unapproved).delegatesToReRequest).toEqual([]);
  });

  it("names the re-request in the missing reason for the current head (criterion 10)", () => {
    const changed = delegateReview("arashout", "changes requested", "2026-10-14T17:00:00Z", "bbbbbbb2");
    expect(prGate(delegatePull(["arashout"], changed), { reRequestedDelegates: ["arashout"] }).missing).toContain("re-requested for this head");
  });

  it("does not treat bots, teams or the viewer as delegates (criterion 8)", () => {
    for (const reviewers of [["dependabot[bot]"], ["Platform Team"], ["jane"]]) {
      const g = prGate(delegatePull(reviewers));
      expect(g.delegates).toEqual([]);
      expect(g.needsOwnerApproval).toBe(true);
      expect(g.missing).toContain("owner approval needed");
    }
  });

  it("behaves exactly as today with no review requests (criterion 9)", () => {
    const g = prGate(delegatePull([]));
    expect(g.delegates).toEqual([]);
    expect(g.delegatePending).toBe(false);
    expect(g.delegateApproved).toBe(false);
    expect(g.needsOwnerApproval).toBe(true);
    expect(g.missing).toContain("owner approval needed");
  });
});
