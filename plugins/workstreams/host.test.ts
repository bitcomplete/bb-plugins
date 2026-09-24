// The host's parsers, which are the boundary between `gh` output and every
// rule in workstreams.ts. Nothing here needs a network, a token, or git: what
// is checked is how a payload is read, not how it was fetched.
import { describe, expect, it } from "vitest";
import { latestReviewStates, latestReviewers, mergeCommitOf, parseMergeStateStatus, parsePrList } from "./gh.js";

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

describe("latestReviewers", () => {
  it("keeps who left each latest review, bots included, because the Board row marks every reviewer and a bot's review counts like a person's", () => {
    expect(
      latestReviewers([
        { author: { login: "reader-ada" }, state: "approved" },
        { author: { login: "inkbot" }, state: "COMMENTED" },
      ]),
    ).toEqual([
      { login: "reader-ada", state: "APPROVED" },
      { login: "inkbot", state: "COMMENTED" },
    ]);
  });

  it("drops an entry with no author or state rather than inventing a reviewer", () => {
    expect(latestReviewers(undefined)).toEqual([]);
    expect(latestReviewers([null, { state: "APPROVED" }, { author: { login: "reader-lin" } }, { author: null, state: "APPROVED" }])).toEqual([]);
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
        latestReviews: [
          { author: { login: "reader-ada" }, state: "APPROVED" },
          { author: { login: "reader-lin" }, state: "COMMENTED" },
        ],
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

  it("carries the reviewers from the same latestReviews field, because the row's reviewer marks must cost no extra gh call", () => {
    expect(parsePrList(row())?.pr.latestReviews).toEqual([
      { login: "reader-ada", state: "APPROVED" },
      { login: "reader-lin", state: "COMMENTED" },
    ]);
  });

  it("returns the merge commit beside the PR rather than on it, because it is an input to a local git check and not a fact the board renders", () => {
    const merged = parsePrList(row({ state: "MERGED", mergeCommit: { oid: "deadbeef1234" } }));
    expect(merged?.mergeCommit).toBe("deadbeef1234");
    expect(merged?.pr.state).toBe("MERGED");
  });

  it("reads an empty array as no pull request, because a branch without one is the normal case and not an error", () => {
    expect(parsePrList("[]")).toBeNull();
  });

  it("carries the merge time, because Recently shipped is dated by it and costs no extra gh call", () => {
    expect(parsePrList(row({ state: "MERGED", mergedAt: "2030-01-09T10:00:00Z" }))?.pr.mergedAt).toBe("2030-01-09T10:00:00Z");
  });

  it("reads a missing or unreadable merge time as null rather than inventing one", () => {
    expect(parsePrList(row())?.pr.mergedAt).toBeNull();
    expect(parsePrList(row({ mergedAt: "yesterday-ish" }))?.pr.mergedAt).toBeNull();
  });

  it("reads unparseable output as no pull request rather than throwing", () => {
    expect(parsePrList("not json")).toBeNull();
    expect(parsePrList('{"not":"an array"}')).toBeNull();
  });

  it("carries mergeStateStatus through, because it is the authoritative can-this-merge-now signal the inbox now reads", () => {
    expect(parsePrList(row({ mergeStateStatus: "dirty" }))?.pr.mergeStateStatus).toBe("DIRTY");
    expect(parsePrList(row({ mergeStateStatus: "behind" }))?.pr.mergeStateStatus).toBe("BEHIND");
  });
});

describe("parseMergeStateStatus", () => {
  it("uppercases each of GitHub's known merge state statuses", () => {
    for (const [raw, expected] of [
      ["clean", "CLEAN"],
      ["Behind", "BEHIND"],
      ["DIRTY", "DIRTY"],
      ["blocked", "BLOCKED"],
      ["unstable", "UNSTABLE"],
      ["has_hooks", "HAS_HOOKS"],
    ] as const) {
      expect(parseMergeStateStatus(raw)).toBe(expected);
    }
  });

  it("reads a missing or unrecognized value as UNKNOWN, so a unit cached before this field existed still loads and a new GitHub value is never misread as ready", () => {
    expect(parseMergeStateStatus(undefined)).toBe("UNKNOWN");
    expect(parseMergeStateStatus(null)).toBe("UNKNOWN");
    expect(parseMergeStateStatus(42)).toBe("UNKNOWN");
    expect(parseMergeStateStatus("some_future_value")).toBe("UNKNOWN");
  });
});
