import { describe, expect, it } from "vitest";
import { prSchema, type Pr } from "./contract.js";
import { checkConclusions } from "./gh.js";
import { blockerFor, stageFor } from "./pr-stage.js";
import { prLifecycle, type Lifecycle } from "./workstreams.js";

function pr(number: number, patch: Partial<Pr> = {}): Pr {
  return prSchema.parse({ number, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", checkConclusions: ["SUCCESS"],
    url: `https://github.com/inkwell/catalog/pull/${number}`, title: `Improve catalog ${number}`, mergeable: "MERGEABLE",
    baseRefName: "main", headRefName: `book-${number}`, latestReviewStates: ["APPROVED"], unresolvedReviewThreads: 0,
    mergeStateStatus: "CLEAN", createdAt: "2026-09-01T00:00:00Z",
    approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, approvalFeedbackVerified: true, ...patch });
}

describe("PR stage and blocker", () => {
  it("maps every lifecycle, while drafts stay in Build even with failed CI", () => {
    const cases: [Lifecycle, string][] = [
      ["active", "build"], ["in-progress", "build"], ["up-next", "build"],
      ["awaiting-review", "review"], ["awaiting-rereview", "review"], ["unverified", "review"],
      ["blocked", "feedback"], ["awaiting-followup", "feedback"], ["approved-with-comments", "feedback"], ["approved-with-note", "feedback"],
      ["awaiting-merge", "ready"], ["merged", "merged"], ["closed", "merged"], ["shipped", "released"],
    ];
    for (const [lifecycle, stage] of cases) expect(stageFor(lifecycle, pr(1))).toBe(stage);
    expect(stageFor("blocked", pr(1, { isDraft: true, checkConclusions: ["FAILURE"] }))).toBe("build");
    expect(stageFor("awaiting-merge", pr(1, { mergeStateStatus: "DIRTY" }))).toBe("feedback");
    expect(stageFor("awaiting-merge", pr(1, { mergeStateStatus: "BEHIND" }))).toBe("feedback");
  });

  // All PRs shows this label as the row's state: a real wait must read as one, and nothing unread or still running reads Clear.
  it("keeps real waits explicit, and keeps an approved PR from Clear while a check runs or its review facts are unread", () => {
    const shown = (value: Pr, stale = false) => {
      const stage = stageFor(stale ? "unverified" : prLifecycle(value), value);
      return [stage, blockerFor(value, stage, null, null, stale).label];
    };
    expect(shown(pr(5), true)).toEqual(["review", "Status unknown"]);
    expect(shown(pr(6, { checkConclusions: ["WAITING"] }))[1]).toBe("Checks pending");
    const running = pr(8, { checkConclusions: checkConclusions([{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" }]) });
    expect(shown(running)).toEqual(["review", "Checks pending"]);
    expect(shown(pr(7, { reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: true, reviewRequests: ["reviewer"] }))).toEqual(["review", "Awaiting re-review"]);
    expect(shown(pr(19, { reviewDecision: "REVIEW_REQUIRED", reviewRequests: [] }))[1]).toBe("No reviewer");
    expect(shown(pr(20, { reviewDecision: "REVIEW_REQUIRED", reviewRequests: ["reviewer"] }))[1]).toBe("Awaiting review");
    expect(shown(pr(21, { reviewDecision: null, latestReviewStates: [], reviewRequests: ["flasd"], unresolvedReviewThreads: null, resolvedReviewThreads: null,
      approvalFeedback: undefined, approvalFeedbackVerified: false, approvalFeedbackVerification: "unknown" }))).toEqual(["review", "Awaiting review"]);
    expect(shown(pr(22, { reviewDecision: null, reviewRequests: ["flasd"], unresolvedReviewThreads: 2, approvalFeedback: undefined }))[1]).toBe("2 open threads");
    expect(shown(pr(23, { unresolvedReviewThreads: null }))[1]).toBe("Status unknown");
  });
});
