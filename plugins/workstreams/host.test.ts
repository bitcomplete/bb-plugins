// The host's parsers, which are the boundary between `gh` output and every
// rule in workstreams.ts. Nothing here needs a network, a token, or git: what
// is checked is how a payload is read, not how it was fetched.
import { describe, expect, it } from "vitest";
import { latestReviewStates, mergeCommitOf, parsePrList } from "./gh.js";

describe("latestReviewStates", () => {
  it("uppercases each reviewer's most recent state, because `approved-with-comments` turns on a COMMENTED review the aggregate decision hides", () => {
    expect(
      latestReviewStates([{ state: "approved" }, { state: "COMMENTED" }]),
    ).toEqual(["APPROVED", "COMMENTED"]);
  });

  it("reads a missing or malformed field as no reviews rather than throwing, because one odd PR must never fail a scan of hundreds of checkouts", () => {
    expect(latestReviewStates(undefined)).toEqual([]);
    expect(latestReviewStates("nonsense")).toEqual([]);
    expect(latestReviewStates([null, {}, { state: "" }])).toEqual([]);
  });
});

describe("mergeCommitOf", () => {
  it("takes the oid `gh` reports, because tag containment is asked about a commit and nothing else identifies it", () => {
    expect(mergeCommitOf({ oid: "a1b2c3d4e5f6" })).toBe("a1b2c3d4e5f6");
  });

  it("returns null for an unmerged PR or a shape that is not a sha, so a bad value can never be handed to git as an argument", () => {
    expect(mergeCommitOf(null)).toBeNull();
    expect(mergeCommitOf({})).toBeNull();
    expect(mergeCommitOf({ oid: "; rm -rf /" })).toBeNull();
    expect(mergeCommitOf({ oid: "short" })).toBeNull();
  });
});

describe("parsePrList", () => {
  const row = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify([
      {
        number: 42,
        state: "open",
        isDraft: false,
        reviewDecision: "approved",
        statusCheckRollup: [{ conclusion: "success" }],
        latestReviews: [{ state: "APPROVED" }, { state: "COMMENTED" }],
        url: "https://github.com/inkwell/folio/pull/42",
        title: "ABC-101: Show gift card balance",
        mergeable: "mergeable",
        baseRefName: "main",
        headRefName: "dev/abc-101",
        mergeCommit: null,
        ...overrides,
      },
    ]);

  it("carries the review states through, because that field is the whole reason the gh call changed", () => {
    expect(parsePrList(row())?.pr.latestReviewStates).toEqual(["APPROVED", "COMMENTED"]);
  });

  it("returns the merge commit beside the PR rather than on it, because it is an input to a local git check and not a fact the board renders", () => {
    const merged = parsePrList(row({ state: "MERGED", mergeCommit: { oid: "deadbeef1234" } }));
    expect(merged?.mergeCommit).toBe("deadbeef1234");
    expect(merged?.pr.state).toBe("MERGED");
  });

  it("reads an empty array as no pull request, because a branch without one is the normal case and not an error", () => {
    expect(parsePrList("[]")).toBeNull();
  });

  it("reads unparseable output as no pull request rather than throwing", () => {
    expect(parsePrList("not json")).toBeNull();
    expect(parsePrList('{"not":"an array"}')).toBeNull();
  });
});
