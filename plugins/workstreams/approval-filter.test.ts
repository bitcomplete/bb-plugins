import { describe, expect, it } from "vitest";
import { countApprovedOpenPrs, isApprovedOpenPr, matchesApprovedFilter } from "./approval-filter.js";
import { rpcContract } from "./server.js";

const approved = { url: "https://github.com/inkwell/folio/pull/42", state: "OPEN", reviewDecision: "APPROVED" };

describe("shared Approved display filter", () => {
  it("includes approved PRs that still need comment, CI, or branch work", () => {
    const blocked = { ...approved, unresolvedReviewThreads: 2, checkConclusions: ["FAILURE"], mergeStateStatus: "BEHIND" };
    expect(matchesApprovedFilter(blocked, true)).toBe(true);
    expect(isApprovedOpenPr({ ...approved, reviewDecision: "CHANGES_REQUESTED" })).toBe(false);
    expect(isApprovedOpenPr({ ...approved, reviewDecision: "REVIEW_REQUIRED" })).toBe(false);
    expect(isApprovedOpenPr(null)).toBe(false);
  });

  it("excludes completed PRs while preserving all work when the filter is off", () => {
    for (const state of ["MERGED", "CLOSED"]) expect(matchesApprovedFilter({ ...approved, state }, true)).toBe(false);
    expect(matchesApprovedFilter(null, false)).toBe(true);
    expect(matchesApprovedFilter({ ...approved, state: "MERGED" }, false)).toBe(true);
    expect(matchesApprovedFilter({ ...approved, reviewDecision: null }, false)).toBe(true);
  });

  it("counts remote PRs and duplicate checkout references once by URL", () => {
    const remote = { ...approved, url: "https://github.com/inkwell/quill/pull/9" };
    expect(countApprovedOpenPrs([
      approved, { ...approved, url: `${approved.url.toUpperCase()}/` }, remote,
      { ...approved, url: "https://github.com/inkwell/folio/pull/43", state: "MERGED" },
      { ...remote, url: "https://github.com/inkwell/quill/pull/10", reviewDecision: "REVIEW_REQUIRED" }, null,
    ])).toBe(2);
    expect([approved, remote].filter((pr) => matchesApprovedFilter(pr, true))).toEqual([approved, remote]);
  });

  it("defaults old saved preferences to off and round-trips explicit selection", () => {
    const old = { lens: "all", staleness: [], surfaces: [], colorBy: "status", face: "theme", showClones: false };
    expect(rpcContract.prefs_get.output.parse(old).approvedOnly).toBe(false);
    expect(rpcContract.prefs_set.input.parse({ ...old, approvedOnly: true }).approvedOnly).toBe(true);
  });
});
