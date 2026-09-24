// The host's parsers, which are the boundary between `gh` output and every
// rule in workstreams.ts. Nothing here needs a network, a token, or git: what
// is checked is how a payload is read, not how it was fetched.
import { describe, expect, it } from "vitest";
import { prSchema } from "./contract.js";
import { latestReviewStates, latestReviewers, mergeCommitOf, parseLiveReviewRequests, parseMergeStateStatus, parsePrList } from "./gh.js";
import { namingResponse, parseNames } from "./naming.js";

describe("Claude naming response", () => {
  const labels = ["checkout", "accounts"];
  const complete = JSON.stringify({ groups: [
    { label: "checkout", name: "Gift cards in checkout", cohesion: "cohesive", reason: null },
    { label: "accounts", name: "Reader account updates", cohesion: "mixed", reason: "The login change is unrelated" },
  ] });

  it("accepts a complete structured batch with a verdict for every requested label", () => {
    expect(namingResponse("effort", "end_turn", complete, labels)).toEqual({
      names: [
        { label: "checkout", name: "Gift cards in checkout", cohesion: "cohesive", reason: null },
        { label: "accounts", name: "Reader account updates", cohesion: "mixed", reason: "The login change is unrelated" },
      ],
      warnings: [],
    });
  });

  it("rejects invalid cohesion instead of silently calling the group cohesive", () => {
    const invalid = complete.replace('"cohesion":"cohesive"', '"cohesion":"uncertain"');
    expect(parseNames(invalid, labels)).toBeNull();
  });

  it("rejects a missing label so it can be retried on the next scan", () => {
    const incomplete = JSON.stringify({ groups: [JSON.parse(complete).groups[0]] });
    expect(parseNames(incomplete, labels)).toBeNull();
    expect(namingResponse("effort", "end_turn", incomplete, labels).names).toEqual([]);
  });

  it("does not accept a refusal or token-limited response even if its JSON looks complete", () => {
    for (const stopReason of ["refusal", "max_tokens"]) {
      const result = namingResponse("effort", stopReason, complete, labels);
      expect(result.names).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    }
  });
});

describe("latestReviewStates", () => {
  it("uppercases each reviewer's most recent state for the Board's reviewer marks", () => {
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

describe("parseLiveReviewRequests", () => {
  it("requires a readable state and reviewer list so a nudge cannot use stale scan data", () => {
    expect(parseLiveReviewRequests(JSON.stringify({ state: "open", reviewRequests: [
      { login: "ada-inkwell" },
      { __typename: "Team", slug: "reviewers", organization: { login: "inkwell" } },
    ] }))).toEqual({ state: "OPEN", reviewers: ["ada-inkwell", "inkwell/reviewers"] });
    expect(parseLiveReviewRequests("not json")).toBeNull();
    expect(parseLiveReviewRequests(JSON.stringify({ state: "open" }))).toBeNull();
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

  it("carries review states through for the Board's reviewer marks", () => {
    expect(parsePrList(row())?.pr.latestReviewStates).toEqual(["APPROVED", "COMMENTED"]);
  });

  it("starts review-thread counts unknown and loads older cached PRs without resolved history", () => {
    const parsed = parsePrList(row())!.pr;
    expect(parsed.unresolvedReviewThreads).toBeNull();
    expect(parsed.resolvedReviewThreads).toBeNull();
    const { resolvedReviewThreads: _oldCount, ...older } = parsed;
    expect(prSchema.parse(older).resolvedReviewThreads).toBeNull();
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
