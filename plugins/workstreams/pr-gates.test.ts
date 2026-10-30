import { describe, expect, it } from "vitest";
import { awaitingRerequest, changesAddressed, conflicted, mergeClean, reviewEngaged } from "./pr-gates.js";

describe("PR merge and review predicates", () => {
  // Each row changes one merge fact from a clean PR. If a predicate starts or stops reading a fact, its row fails, so the attention
  // All PRs shows and the fixes a thread is asked for can't drift from GitHub's own words.
  it.each<[string, { mergeable: string; mergeStateStatus: string }, boolean, boolean | null]>([
    ["clean", { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }, false, true],
    ["clean with hooks", { mergeable: "MERGEABLE", mergeStateStatus: "HAS_HOOKS" }, false, true],
    ["conflicting", { mergeable: "CONFLICTING", mergeStateStatus: "CLEAN" }, true, false],
    ["dirty", { mergeable: "MERGEABLE", mergeStateStatus: "DIRTY" }, true, false],
    ["behind its base", { mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" }, false, false],
    ["blocked by branch protection", { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }, false, false],
    ["unstable", { mergeable: "MERGEABLE", mergeStateStatus: "UNSTABLE" }, false, false],
    // Mergeability GitHub hasn't computed yet is neither a conflict nor clean: read again.
    ["still computing mergeability", { mergeable: "UNKNOWN", mergeStateStatus: "CLEAN" }, false, null],
    ["of unknown merge state", { mergeable: "MERGEABLE", mergeStateStatus: "UNKNOWN" }, false, null],
  ])("reads a PR that is %s as conflicted only on a reported conflict, and clean only when GitHub would merge it", (_name, facts, conflict, clean) => {
    expect([conflicted(facts), mergeClean(facts)]).toEqual([conflict, clean]);
  });

  it("counts requested changes addressed once GitHub stops asking, or the author's verified follow-up answers them", () => {
    expect(changesAddressed({ reviewDecision: "APPROVED" })).toBe(true);
    expect(changesAddressed({ reviewDecision: "CHANGES_REQUESTED" })).toBe(false);
    expect(changesAddressed({ reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: true })).toBe(true);
  });

  it("asks again only reviewers who requested changes or had their review dismissed", () => {
    const latestReviews = [{ login: "Mira", state: "CHANGES_REQUESTED" }, { login: "otto", state: "COMMENTED" }];
    expect(awaitingRerequest({ reviewRequests: [], latestReviews })).toEqual([{ login: "Mira", state: "CHANGES_REQUESTED" }]);
    expect(awaitingRerequest({ reviewRequests: ["otto"], latestReviews })).toHaveLength(1);
    // Logins match in any case.
    expect(awaitingRerequest({ reviewRequests: ["mira"], latestReviews })).toEqual([]);
    const dismissed = [{ login: "otto", state: "DISMISSED" }];
    expect(awaitingRerequest({ reviewRequests: [], latestReviews: dismissed })).toEqual(dismissed);
    expect(awaitingRerequest({ reviewRequests: ["otto"], latestReviews: dismissed })).toEqual([]);
  });

  it("finds a PR nobody has been asked to review", () => {
    expect(reviewEngaged({ reviewRequests: [], latestReviews: [] })).toBe(false);
    // Your own pending review asks nobody.
    expect(reviewEngaged({ reviewRequests: [], latestReviews: [{ state: "PENDING" }] })).toBe(false);
    expect(reviewEngaged({ reviewRequests: ["mira"], latestReviews: [] })).toBe(true);
    expect(reviewEngaged({ reviewRequests: [], latestReviews: [{ state: "COMMENTED" }] })).toBe(true);
  });
});
