// The reviewer marks on a Board row. What matters is that each mark says where
// a reviewer stands NOW, so the row tells you who you are waiting on.
import { describe, expect, it } from "vitest";
import { reviewerInitials, reviewersLabel, reviewersOf, visibleReviewers, type Reviewer } from "./reviewers.js";

const review = (login: string, state: string) => ({ login, state });

describe("reviewersOf", () => {
  it("maps each latest review to its mark, because the row shows where every reviewer stands", () => {
    const reviewers = reviewersOf({
      latestReviews: [review("reader-ada", "APPROVED"), review("reader-lin", "CHANGES_REQUESTED"), review("reader-kai", "COMMENTED")],
      reviewRequests: ["reader-mo"],
    });
    expect(reviewers).toEqual([
      { login: "reader-lin", state: "changes" },
      { login: "reader-mo", state: "pending" },
      { login: "reader-kai", state: "commented" },
      { login: "reader-ada", state: "approved" },
    ]);
  });

  it("shows a reviewer who reviewed and was re-requested as pending, because re-requesting asks for a fresh look and the old approval no longer answers it", () => {
    expect(reviewersOf({ latestReviews: [review("reader-ada", "APPROVED")], reviewRequests: ["reader-ada"] })).toEqual([
      { login: "reader-ada", state: "pending" },
    ]);
  });

  it("keeps bots, because a bot's review counts like a person's", () => {
    expect(reviewersOf({ latestReviews: [review("inkbot", "CHANGES_REQUESTED")], reviewRequests: ["folio-lint[bot]"] })).toEqual([
      { login: "inkbot", state: "changes" },
      { login: "folio-lint[bot]", state: "pending" },
    ]);
  });

  it("drops dismissed and unsubmitted reviews rather than guessing a state for them", () => {
    expect(reviewersOf({ latestReviews: [review("reader-ada", "DISMISSED"), review("reader-lin", "PENDING")], reviewRequests: [] })).toEqual([]);
    expect(reviewersOf(null)).toEqual([]);
  });
});

describe("visibleReviewers", () => {
  const many = (n: number): Reviewer[] => Array.from({ length: n }, (_, i) => ({ login: `reader-${i}`, state: "approved" }));

  it("shows three and folds the rest into +N, so a crowded review never pushes the title into truncation", () => {
    const { shown, more } = visibleReviewers(many(6));
    expect(shown.map((r) => r.login)).toEqual(["reader-0", "reader-1", "reader-2"]);
    expect(more).toBe(3);
  });

  it("never shows more than three, because the column has a fixed width; a fourth becomes +1", () => {
    expect(visibleReviewers(many(4))).toEqual({ shown: many(3), more: 1 });
    expect(visibleReviewers(many(2))).toEqual({ shown: many(2), more: 0 });
  });
});

describe("reviewerInitials", () => {
  it("abbreviates people, teams and bots to two letters", () => {
    expect(reviewerInitials("reader-ada")).toBe("RA");
    expect(reviewerInitials("inkwell/copy-desk")).toBe("CD");
    expect(reviewerInitials("inkbot")).toBe("IN");
    expect(reviewerInitials("folio-lint[bot]")).toBe("FL");
  });
});

describe("reviewersLabel", () => {
  it("lists every reviewer with their state in words, hidden ones included, because the hover is where +N is spelled out", () => {
    expect(
      reviewersLabel([
        { login: "reader-lin", state: "changes" },
        { login: "reader-ada", state: "pending" },
      ]),
    ).toBe("✗ reader-lin: changes requested\n○ reader-ada: review requested");
  });
});
