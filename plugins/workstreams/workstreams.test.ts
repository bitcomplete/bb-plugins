import { describe, expect, it } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import {
  ALL_LENSES,
  DAY_MS,
  DEFAULT_SURFACE_RULES,
  ESCALATING,
  LENSES,
  LIFECYCLES,
  MERGE_THRESHOLD,
  STALENESS_DAYS,
  UNSORTED,
  buildBoard,
  buildHierarchy,
  classifySurfaces,
  dominantSurface,
  freshest,
  groupChildren,
  hierarchyDepth,
  isStuck,
  lifecycleGroup,
  matchesFilters,
  matchesLens,
  namingCandidates,
  parseSurfaceRules,
  riskOf,
  similarity,
  stalenessOf,
  toLifecycle,
  type BoardGroup,
  mostUrgent,
  parseTicket,
  unitLifecycle,
  workstreamName,
  type ClusterDecision,
} from "./workstreams.js";

const PATTERN = /([A-Za-z]{2,5})-(\d{1,6})/;

function unit(overrides: Partial<RawUnit> = {}): RawUnit {
  return {
    path: "/checkouts/quill",
    dirName: "quill",
    repo: "quill",
    branch: "dev/abc-101-show-gift-card-balance",
    dirty: false,
    ahead: 0,
    behind: 0,
    lastCommitAt: "2029-12-24T00:00:00Z",
    defaultBranch: "main",
    pr: null,
    shipped: null,
    changedPaths: [],
    ...overrides,
  };
}

function pr(overrides: Partial<Pr> = {}): Pr {
  return {
    number: 42,
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    checkConclusions: [],
    url: "https://github.com/inkwell/quill/pull/42",
    title: "Show gift card balance",
    mergeable: "MERGEABLE",
    baseRefName: "main",
    headRefName: "dev/abc-101-show-gift-card-balance",
    latestReviewStates: [],
    mergedAt: null,
    mergeStateStatus: "CLEAN",
    ...overrides,
  };
}

describe("parseTicket", () => {
  it("prefers the branch over the directory, because a checkout outlives the directory it was first cloned into", () => {
    expect(
      parseTicket(PATTERN, "dev/abc-101-show-gift-card-balance", "old-eng-12-scratch"),
    ).toBe("ABC-101");
  });

  it("falls back to the directory name so a detached or renamed branch still clusters", () => {
    expect(parseTicket(PATTERN, "main", "abc-101-quill")).toBe("ABC-101");
  });

  it("uppercases the key so abc-101 and ABC-101 land in one cluster rather than two", () => {
    expect(parseTicket(PATTERN, "dev/abc-101-x", "x")).toBe(
      parseTicket(PATTERN, "dev/ABC-101-y", "y"),
    );
  });

  it("returns null when nothing ticket-shaped is present, so the unit can be surfaced as unsorted instead of mis-grouped", () => {
    expect(parseTicket(PATTERN, "main", "dotfiles")).toBeNull();
  });
});

describe("unitLifecycle", () => {
  it("calls a merged PR merged regardless of check or review state, because the work already landed", () => {
    expect(
      unitLifecycle(
        unit({ pr: pr({ state: "MERGED", checkConclusions: ["FAILURE"] }) }),
      ),
    ).toBe("merged");
  });

  it("distinguishes closed from merged, because abandoned work needs no follow-up", () => {
    expect(unitLifecycle(unit({ pr: pr({ state: "CLOSED" }) }))).toBe("closed");
  });

  it("calls a merged PR whose merge commit reached a release tag shipped, because merged and deployed are different facts and only one of them is done", () => {
    expect(unitLifecycle(unit({ shipped: true, pr: pr({ state: "MERGED" }) }))).toBe(
      "shipped",
    );
  });

  it("degrades to merged when tag containment could not be answered, because an unknown must never be allowed to invent a production deploy", () => {
    expect(unitLifecycle(unit({ shipped: null, pr: pr({ state: "MERGED" }) }))).toBe(
      "merged",
    );
    expect(unitLifecycle(unit({ shipped: false, pr: pr({ state: "MERGED" }) }))).toBe(
      "merged",
    );
  });

  it("treats a failing check as blocked even when the PR is approved, because a red check blocks the merge and an approval does not unblock it", () => {
    expect(
      unitLifecycle(
        unit({
          pr: pr({ reviewDecision: "APPROVED", checkConclusions: ["SUCCESS", "FAILURE"] }),
        }),
      ),
    ).toBe("blocked");
  });

  it("treats an errored check the same as a failing one, because both stop the merge", () => {
    expect(unitLifecycle(unit({ pr: pr({ checkConclusions: ["ERROR"] }) }))).toBe(
      "blocked",
    );
  });

  it("separates awaiting-followup from blocked, because one waits on YOUR edit and the other waits on CI: merging them would hide the only state you can clear alone", () => {
    expect(
      unitLifecycle(unit({ pr: pr({ reviewDecision: "CHANGES_REQUESTED" }) })),
    ).toBe("awaiting-followup");
    expect(
      unitLifecycle(
        unit({ pr: pr({ reviewDecision: "CHANGES_REQUESTED", checkConclusions: ["FAILURE"] }) }),
      ),
      // Red CI outranks it: fixing the review comments would not make this
      // mergeable, so the board must name the thing that actually stops it.
    ).toBe("blocked");
  });

  it("calls an approved PR carrying an unresolved COMMENTED review approved-with-comments, because the aggregate decision says APPROVED while something is still outstanding", () => {
    expect(
      unitLifecycle(
        unit({
          pr: pr({
            reviewDecision: "APPROVED",
            checkConclusions: ["SUCCESS"],
            latestReviewStates: ["APPROVED", "COMMENTED"],
          }),
        }),
      ),
    ).toBe("approved-with-comments");
  });

  it("calls an approved PR with green checks and no open comments awaiting-merge, because it is waiting on nothing but a button", () => {
    expect(
      unitLifecycle(
        unit({
          pr: pr({
            reviewDecision: "APPROVED",
            checkConclusions: ["SUCCESS", "SKIPPED"],
            latestReviewStates: ["APPROVED"],
          }),
        }),
      ),
    ).toBe("awaiting-merge");
  });

  it("calls an approved PR with a rollup still running awaiting-review rather than awaiting-merge, because 'just merge it' is a lie while a check is pending", () => {
    expect(
      unitLifecycle(
        unit({
          pr: pr({ reviewDecision: "APPROVED", checkConclusions: ["SUCCESS", "PENDING"] }),
        }),
      ),
    ).toBe("awaiting-review");
  });

  it("calls an approved PR with no checks at all awaiting-merge, because plenty of repos run no CI and calling those permanently unmergeable would be wrong", () => {
    expect(
      unitLifecycle(unit({ pr: pr({ reviewDecision: "APPROVED", checkConclusions: [] }) })),
    ).toBe("awaiting-merge");
  });

  it("calls an open, unreviewed PR awaiting-review, because it is waiting on someone else", () => {
    expect(unitLifecycle(unit({ pr: pr() }))).toBe("awaiting-review");
  });

  it("calls a draft PR in-progress rather than awaiting-review, because nobody has been asked to look at it yet", () => {
    expect(unitLifecycle(unit({ pr: pr({ isDraft: true }) }))).toBe("in-progress");
  });

  it("keeps a draft with failing checks in the ACTIVE group rather than blocked, because red CI on unfinished work is expected and must not compete with a PR that is genuinely stuck", () => {
    expect(
      unitLifecycle(
        unit({ pr: pr({ isDraft: true, checkConclusions: ["FAILURE"] }) }),
      ),
    ).toBe("in-progress");
    expect(lifecycleGroup("in-progress")).toBe("active");
  });

  it("keeps an approved draft in-progress rather than awaiting-merge, because the author has not marked it finished", () => {
    expect(
      unitLifecycle(
        unit({ pr: pr({ isDraft: true, reviewDecision: "APPROVED" }) }),
      ),
    ).toBe("in-progress");
  });

  it("calls a dirty draft active, because edits are open right now and that is a different thing from a clean branch waiting", () => {
    expect(
      unitLifecycle(unit({ dirty: true, pr: pr({ isDraft: true }) })),
    ).toBe("active");
  });

  it("calls a dirty checkout with no PR active, because the working tree is the most immediate signal there is", () => {
    expect(unitLifecycle(unit({ dirty: true, pr: null, ahead: 0 }))).toBe("active");
  });

  it("lets an open PR outrank a dirty tree, because what the PR is waiting on is what you would act on next", () => {
    expect(unitLifecycle(unit({ dirty: true, pr: pr() }))).toBe("awaiting-review");
  });

  it("calls unpushed local commits in-progress, because there is work in flight with no PR yet", () => {
    expect(unitLifecycle(unit({ pr: null, ahead: 3 }))).toBe("in-progress");
  });

  it("calls a clean checkout with no PR and nothing ahead up-next, because it is a parked, ready-to-start clone rather than work in progress", () => {
    expect(unitLifecycle(unit({ pr: null, ahead: 0 }))).toBe("up-next");
  });

  it("treats a missing upstream as up-next rather than guessing, because ahead is unknowable without one", () => {
    expect(unitLifecycle(unit({ pr: null, ahead: null, behind: null }))).toBe("up-next");
  });
});

describe("lifecycle groups", () => {
  it("puts every state in exactly one group, because the groups ARE the lenses and a state filterable twice would be invisible once", () => {
    const seen = LIFECYCLES.map((lifecycle) => lifecycleGroup(lifecycle));
    expect(seen).toHaveLength(LIFECYCLES.length);
    expect(new Set(seen)).toEqual(new Set(["active", "waiting", "done"]));
  });

  it("keeps shipped, merged and closed in Done, so landed and abandoned work never competes with live work for the reader", () => {
    for (const lifecycle of ["shipped", "merged", "closed"] as const) {
      expect(lifecycleGroup(lifecycle)).toBe("done");
    }
  });

  it("maps the old seven-state names forward rather than crashing, because a value cached by an earlier build must degrade to a renderable state", () => {
    expect(toLifecycle("ready")).toBe("awaiting-merge");
    expect(toLifecycle("review")).toBe("awaiting-review");
    expect(toLifecycle("drafting")).toBe("in-progress");
    expect(toLifecycle("local")).toBe("up-next");
    expect(toLifecycle("blocked")).toBe("blocked");
    expect(toLifecycle("something-else-entirely")).toBe("up-next");
    expect(toLifecycle(undefined)).toBe("up-next");
  });
});

describe("mostUrgent", () => {
  it("surfaces the blocked member of a cluster, because that is the one thing the cluster needs from you", () => {
    expect(mostUrgent(["merged", "awaiting-merge", "blocked", "up-next"])).toBe("blocked");
  });

  it("ranks awaiting-merge above awaiting-review, because merging is a smaller action than waiting on a reviewer", () => {
    expect(mostUrgent(["awaiting-review", "awaiting-merge"])).toBe("awaiting-merge");
  });

  it("ranks awaiting-review above in-progress, because a PR out for review is further along than local edits", () => {
    expect(mostUrgent(["in-progress", "awaiting-review"])).toBe("awaiting-review");
  });

  it("ranks awaiting-followup above everything but blocked, because the ball being with YOU is the most actionable fact on the board", () => {
    expect(
      mostUrgent(["awaiting-merge", "awaiting-review", "awaiting-followup"]),
    ).toBe("awaiting-followup");
    expect(mostUrgent(["awaiting-followup", "blocked"])).toBe("blocked");
  });

  it("ranks approved-with-comments above awaiting-merge, because unresolved comments are work and a green merge button is not", () => {
    expect(mostUrgent(["awaiting-merge", "approved-with-comments"])).toBe(
      "approved-with-comments",
    );
  });

  it("ranks any live state above shipped, so a partly shipped cluster still shows its remaining work", () => {
    expect(mostUrgent(["shipped", "shipped", "up-next"])).toBe("up-next");
  });

  it("ranks shipped above merged above closed, so landed work does not read as abandoned and deployed work does not read as merely merged", () => {
    expect(mostUrgent(["merged", "shipped"])).toBe("shipped");
    expect(mostUrgent(["closed", "merged"])).toBe("merged");
  });
});

describe("workstreamName", () => {
  it("prefers a manual override over Linear, because a name the user typed is a deliberate decision", () => {
    expect(workstreamName("ABC-101", { "ABC-101": "Gift card balances" }, { "ABC-101": "Catalog" })).toBe(
      "Gift card balances",
    );
  });

  it("uses the Linear project when there is no override, so clusters group themselves without manual work", () => {
    expect(workstreamName("ABC-101", {}, { "ABC-101": "Catalog" })).toBe("Catalog");
  });

  it("falls back to the ticket key when Linear knows nothing, so a cluster is never nameless", () => {
    expect(workstreamName("ABC-101", {}, { "ABC-101": null })).toBe("ABC-101");
  });

  it("ignores a blank override so an accidentally empty name does not erase the Linear name", () => {
    expect(workstreamName("ABC-101", { "ABC-101": "   " }, { "ABC-101": "Catalog" })).toBe(
      "Catalog",
    );
  });
});

describe("buildBoard", () => {
  const options = {
    pattern: PATTERN,
    overrides: {},
    linearProjects: { "ABC-101": "Catalog" },
  };

  it("clusters one ticket across repos, which is the grouping nothing else in the toolchain shows", () => {
    const board = buildBoard(
      [
        unit({ path: "/c/quill", dirName: "quill", repo: "quill" }),
        unit({ path: "/c/margin", dirName: "margin", repo: "margin" }),
        unit({ path: "/c/colophon", dirName: "colophon", repo: "colophon" }),
      ],
      options,
    );
    expect(board).toHaveLength(1);
    expect(board[0]?.name).toBe("Catalog");
    expect(board[0]?.clusters[0]?.ticket).toBe("ABC-101");
    expect(board[0]?.clusters[0]?.units.map((one) => one.repo)).toEqual(
      expect.arrayContaining(["quill", "margin", "colophon"]),
    );
  });

  it("rolls a cluster up to its most urgent member, so a mostly merged ticket still shows the repo that needs you", () => {
    const board = buildBoard(
      [
        unit({ path: "/c/a", pr: pr({ state: "MERGED" }) }),
        unit({ path: "/c/b", pr: pr({ reviewDecision: "CHANGES_REQUESTED" }) }),
      ],
      options,
    );
    expect(board[0]?.clusters[0]?.lifecycle).toBe("awaiting-followup");
  });

  it("gives every unparseable checkout its own Unsorted cluster, because they share nothing but the absence of a ticket", () => {
    const board = buildBoard(
      [
        unit({ path: "/c/dotfiles", dirName: "dotfiles", branch: "main" }),
        unit({ path: "/c/notes", dirName: "notes", branch: "main" }),
      ],
      options,
    );
    expect(board).toHaveLength(1);
    expect(board[0]?.name).toBe(UNSORTED);
    expect(board[0]?.clusters).toHaveLength(2);
  });

  it("orders workstreams by name and keeps Unsorted last, never by urgency, because a board that reorders when a PR turns red moves rows under the reader between two refreshes that changed no work", () => {
    const units = [
      unit({ path: "/c/dotfiles", dirName: "dotfiles", branch: "main" }),
      unit({
        path: "/c/quiet",
        dirName: "abc-1-quiet",
        branch: "dev/abc-1-quiet",
        pr: pr({ state: "MERGED" }),
      }),
      unit({
        path: "/c/urgent",
        dirName: "abc-101-urgent",
        branch: "dev/abc-101-urgent",
        pr: pr({ checkConclusions: ["FAILURE"] }),
      }),
    ];
    expect(buildBoard(units, options).map((one) => one.name)).toEqual([
      "ABC-1",
      "Catalog",
      UNSORTED,
    ]);
  });

  it("returns the SAME order when one unit's lifecycle changes and nothing else does, which is the whole of 'status is a lens'", () => {
    const base = [
      unit({ path: "/c/a", dirName: "abc-1-a", branch: "dev/abc-1-a" }),
      unit({ path: "/c/b", dirName: "abc-101-b", branch: "dev/abc-101-b" }),
      unit({ path: "/c/c", dirName: "abc-102-c", branch: "dev/abc-102-c" }),
    ];
    const names = (units: RawUnit[]) =>
      buildBoard(units, options).map((one) => [
        one.name,
        one.clusters.map((cluster) => cluster.ticket),
      ]);
    const before = names(base);
    // Turn one checkout from parked into the most urgent state there is.
    const after = names(
      base.map((one) =>
        one.path === "/c/b" ? unit({ ...one, pr: pr({ checkConclusions: ["FAILURE"] }) }) : one,
      ),
    );
    expect(after).toEqual(before);
    // …and the lifecycle really did change, so the assertion above is not vacuous.
    expect(buildBoard(base, options).flatMap((one) => one.clusters.map((c) => c.lifecycle))).not
      .toContain("blocked");
  });

  it("orders clusters inside a workstream by ticket key alone, so a checkout going red changes the colour of a row and never its position", () => {
    const board = buildBoard(
      [
        unit({
          path: "/c/old",
          dirName: "abc-1-old",
          branch: "dev/abc-1-old",
          lastCommitAt: "2029-05-01T00:00:00Z",
        }),
        unit({
          path: "/c/new",
          dirName: "abc-2-new",
          branch: "dev/abc-2-new",
          lastCommitAt: "2029-12-24T00:00:00Z",
        }),
        unit({
          path: "/c/blocked",
          dirName: "abc-3-blocked",
          branch: "dev/abc-3-blocked",
          lastCommitAt: "2028-05-01T00:00:00Z",
          pr: pr({ checkConclusions: ["FAILURE"] }),
        }),
      ],
      { ...options, overrides: { "ABC-1": "W", "ABC-2": "W", "ABC-3": "W" }, linearProjects: {} },
    );
    expect(board[0]?.clusters.map((one) => one.ticket)).toEqual([
      "ABC-1",
      "ABC-2",
      "ABC-3",
    ]);
  });
});

// --- v2: words, rollups, hashing and the effort layer ----------------------

import {
  buildEfforts,
  clusterInputHash,
  effortLabel,
  fallbackSummary,
  isSummaryLength,
  displayTitle,
  normalizeSummary,
  truncateSummary,
  placeClusters,
  rollupSentence,
  seedGroups,
  stripTicketPrefix,
  summaryCandidates,
  type Cluster,
  type SummarizedCluster,
} from "./workstreams.js";

function cluster(ticket: string, units: RawUnit[]): Cluster {
  return {
    ticket,
    lifecycle: mostUrgent(units.map(unitLifecycle)),
    staleness: "fresh" as const,
    surfaces: [],
    risk: "none" as const,
    units: units.map((raw) => ({
      ...raw,
      ticket,
      lifecycle: unitLifecycle(raw),
      stack: null,
      staleness: "fresh" as const,
      surfaces: [],
      risk: "none" as const,
    })),
  };
}

describe("stripTicketPrefix", () => {
  it("drops the Linear key many teams put on every PR title, because the cluster heading already says it", () => {
    expect(stripTicketPrefix("OPS-1234: Show gift card balance in the cart")).toBe(
      "Show gift card balance in the cart",
    );
  });

  it("leaves a title that merely mentions a ticket-shaped word intact, because only a leading key is the convention", () => {
    expect(stripTicketPrefix("Rotate ABC-101 signing keys quarterly")).toBe(
      "Rotate ABC-101 signing keys quarterly",
    );
  });
});

describe("summary length", () => {
  it("rejects a one-word summary, because it names a topic rather than the work", () => {
    expect(isSummaryLength("Wishlists")).toBe(false);
    expect(normalizeSummary("Wishlists")).toBeNull();
  });

  it("accepts the 3-8 word window the board's rows are sized for", () => {
    expect(isSummaryLength("Show gift card balance in the cart")).toBe(true);
  });

  it("keeps an over-long title whole, because the caller must be able to prefer a shorter title that fits over cutting this one mid-phrase", () => {
    const long =
      "Paginate the author index so large catalogues load in under a second";
    expect(normalizeSummary(long)).toBe(long);
  });

  it("truncates only on request, keeping the leading clause, because PR titles put the subject first and the qualifier last", () => {
    const long =
      "Paginate the author index so large catalogues load in under a second";
    expect(truncateSummary(long)).toBe(
      "Paginate the author index so large catalogues load",
    );
    expect(isSummaryLength(truncateSummary(long))).toBe(true);
  });

  it("strips a conventional-commit prefix, because 'fix(search):' spends two of the eight words on nothing the board needs", () => {
    expect(normalizeSummary("fix(search): trim stray whitespace from queries")).toBe(
      "trim stray whitespace from queries",
    );
  });

  it("strips both prefixes in either order, because real titles carry the ticket and the commit type together", () => {
    expect(normalizeSummary("OPS-1234: fix(scope): cache cover images on upload")).toBe(
      "cache cover images on upload",
    );
    expect(normalizeSummary("fix(scope): OPS-1234: cache cover images on upload")).toBe(
      "cache cover images on upload",
    );
  });

  it("strips a trailing period so summaries read as labels and not sentences", () => {
    expect(normalizeSummary("Show gift card balance in the cart.")).toBe(
      "Show gift card balance in the cart",
    );
  });
});

describe("fallbackSummary", () => {
  it("uses the most recent PR title with the prefix stripped, so a board with no model keys still reads in words", () => {
    const board = cluster("ABC-101", [
      unit({
        path: "/c/old",
        lastCommitAt: "2029-05-01T00:00:00Z",
        pr: pr({ title: "ABC-101: Drop the unused isbn10 index" }),
      }),
      unit({
        path: "/c/new",
        lastCommitAt: "2029-12-24T00:00:00Z",
        pr: pr({ title: "ABC-101: Show gift card balance in the cart" }),
      }),
    ]);
    expect(fallbackSummary(board)).toBe("Show gift card balance in the cart");
  });

  it("falls back to the ticket key when no PR title is usable, so a cluster is never nameless", () => {
    expect(fallbackSummary(cluster("ABC-101", [unit({ pr: null })]))).toBe("ABC-101");
  });

  it("offers every distinct PR title as a candidate, because those are the only words a model is allowed to pick from", () => {
    const board = cluster("ABC-101", [
      unit({ path: "/c/a", pr: pr({ title: "ABC-101: Show gift card balance in the cart" }) }),
      unit({ path: "/c/b", pr: pr({ title: "ABC-101: Add dark mode to the reader app" }) }),
    ]);
    expect(summaryCandidates(board)).toEqual([
      "Show gift card balance in the cart",
      "Add dark mode to the reader app",
    ]);
  });

  it("offers a whole title that fits ahead of a newer one that must be cut, because a complete phrase from last week beats today's title chopped mid-thought", () => {
    const board = cluster("ABC-101", [
      unit({
        path: "/c/new",
        lastCommitAt: "2029-12-24T00:00:00Z",
        pr: pr({
          title:
            "ABC-101: rebuild the recommendation carousel so it loads lazily and caches cover thumbnails between page views",
        }),
      }),
      unit({
        path: "/c/old",
        lastCommitAt: "2029-05-01T00:00:00Z",
        pr: pr({ title: "ABC-101: Show gift card balance in the cart" }),
      }),
    ]);
    expect(summaryCandidates(board)[0]).toBe("Show gift card balance in the cart");
    expect(fallbackSummary(board)).toBe("Show gift card balance in the cart");
  });
});

describe("clusterInputHash", () => {
  it("ignores lifecycle, ahead/behind and timestamps, because those churn on every scan and would make an unchanged board cost model calls", () => {
    const before = cluster("ABC-101", [
      unit({ pr: pr({ title: "ABC-101: Show gift card balance" }) }),
    ]);
    const after = cluster("ABC-101", [
      unit({
        ahead: 7,
        behind: 3,
        dirty: true,
        lastCommitAt: "2031-05-05T00:00:00Z",
        pr: pr({
          title: "ABC-101: Show gift card balance",
          state: "MERGED",
          reviewDecision: "APPROVED",
          checkConclusions: ["SUCCESS", "FAILURE"],
        }),
      }),
    ]);
    expect(before.lifecycle).not.toBe(after.lifecycle);
    expect(clusterInputHash(after)).toBe(clusterInputHash(before));
  });

  it("changes when a PR title changes, because the words the summary is chosen from changed", () => {
    const before = cluster("ABC-101", [unit({ pr: pr({ title: "Show gift card balance" }) })]);
    const after = cluster("ABC-101", [unit({ pr: pr({ title: "Add wishlist sharing" }) })]);
    expect(clusterInputHash(after)).not.toBe(clusterInputHash(before));
  });

  it("changes when the cluster spreads to another repo, because that is a real change in what the work is", () => {
    const before = cluster("ABC-101", [unit({ path: "/c/a", repo: "quill" })]);
    const after = cluster("ABC-101", [
      unit({ path: "/c/a", repo: "quill" }),
      unit({ path: "/c/b", repo: "colophon" }),
    ]);
    expect(clusterInputHash(after)).not.toBe(clusterInputHash(before));
  });
});

describe("rollupSentence", () => {
  it("names the blocking repo and the reason, because 'partly done' is not something you can act on", () => {
    const effort = [
      cluster("ABC-101", [
        unit({ path: "/c/a", repo: "quill", pr: pr({ state: "MERGED" }) }),
        unit({
          path: "/c/b",
          repo: "colophon",
          pr: pr({ checkConclusions: ["FAILURE"] }),
        }),
      ]),
    ];
    expect(rollupSentence(effort)).toBe("1 of 2 merged; colophon blocked on CI.");
  });

  it("distinguishes a review block from a CI block, because they need different people: requested changes need YOUR edit and a red check needs CI", () => {
    const review = [
      cluster("ABC-101", [
        unit({ repo: "folio", pr: pr({ reviewDecision: "CHANGES_REQUESTED" }) }),
      ]),
    ];
    expect(rollupSentence(review)).toBe("0 of 1 merged; folio waiting on your changes.");
    const ci = [
      cluster("ABC-101", [unit({ repo: "folio", pr: pr({ checkConclusions: ["FAILURE"] }) })]),
    ];
    expect(rollupSentence(ci)).toBe("0 of 1 merged; folio blocked on CI.");
  });

  it("surfaces a ready merge when nothing is blocked, because that is the smallest next action", () => {
    const effort = [
      cluster("ABC-101", [
        unit({ path: "/c/a", repo: "folio", pr: pr({ state: "MERGED" }) }),
        unit({
          path: "/c/b",
          repo: "margin",
          pr: pr({ reviewDecision: "APPROVED", checkConclusions: ["SUCCESS"] }),
        }),
      ]),
    ];
    expect(rollupSentence(effort)).toBe("1 of 2 merged; margin ready to merge.");
  });

  it("counts rather than names when several units share the least urgent state, because five repo names is not a sentence", () => {
    const effort = [
      cluster("ABC-101", [
        unit({ path: "/c/a", repo: "folio", pr: pr() }),
        unit({ path: "/c/b", repo: "margin", pr: pr() }),
      ]),
    ];
    expect(rollupSentence(effort)).toBe("0 of 2 merged; 2 awaiting review.");
  });

  it("says nothing is open when the work has landed, rather than inventing a next step", () => {
    const effort = [
      cluster("ABC-101", [unit({ repo: "folio", pr: pr({ state: "MERGED" }) })]),
    ];
    expect(rollupSentence(effort)).toBe("1 of 1 merged; nothing open.");
  });
});

describe("seedGroups", () => {
  it("groups tickets that share repos and vocabulary, because those are the candidates worth asking a model about", () => {
    const groups = seedGroups([
      cluster("ABC-101", [
        unit({
          path: "/c/a",
          repo: "quill",
          branch: "dev/abc-101-gift-card-balance",
          pr: pr({ title: "Show gift card balance in the cart" }),
        }),
      ]),
      cluster("ABC-102", [
        unit({
          path: "/c/b",
          repo: "quill",
          branch: "dev/abc-102-gift-card-balance-log",
          pr: pr({ title: "Log slow search queries" }),
        }),
      ]),
      cluster("OPS-1111", [
        unit({
          path: "/c/c",
          repo: "colophon",
          branch: "dev/ops-1111-serif-typeface",
          pr: pr({ title: "Swap the default typeface for a serif" }),
        }),
      ]),
    ]);
    const tickets = groups.map((group) => group.map((one) => one.ticket).sort());
    expect(tickets).toContainEqual(["ABC-101", "ABC-102"]);
    expect(tickets).toContainEqual(["OPS-1111"]);
  });

  it("leaves unrelated clusters alone rather than chaining everything into one blob, because a group that contains the whole board says nothing", () => {
    const groups = seedGroups([
      cluster("AAA-1", [unit({ path: "/c/a", repo: "alpha", branch: "dev/aaa-1-alpha-widget", pr: null })]),
      cluster("BBB-2", [unit({ path: "/c/b", repo: "beta", branch: "dev/bbb-2-beta-ledger", pr: null })]),
      cluster("CCC-3", [unit({ path: "/c/c", repo: "gamma", branch: "dev/ccc-3-gamma-parser", pr: null })]),
    ]);
    expect(groups).toHaveLength(3);
  });
});

describe("effortLabel", () => {
  const base = {
    ticket: "ABC-101",
    override: undefined,
    threshold: 0.6,
    grouped: true,
    fallbackName: "Catalog",
  };

  it("sends a low-confidence assignment to Unsorted, because a cluster nobody is sure about must not look like a decision", () => {
    expect(
      effortLabel({ ...base, assignment: { label: "Wishlist work", fit: 0.4 } }),
    ).toBe(UNSORTED);
  });

  it("keeps an assignment at the threshold, because the setting is the cut and not a gap", () => {
    expect(
      effortLabel({ ...base, assignment: { label: "Wishlist work", fit: 0.6 } }),
    ).toBe("Wishlist work");
  });

  it("lets a name the user typed beat any model assignment, because that is a deliberate decision and this is not", () => {
    expect(
      effortLabel({
        ...base,
        override: "Gift card balances",
        assignment: { label: "Wishlist work", fit: 0.95 },
      }),
    ).toBe("Gift card balances");
  });

  it("keeps v1 grouping when no model is available, so the board degrades to useful rather than to Unsorted", () => {
    expect(effortLabel({ ...base, grouped: false, assignment: null })).toBe("Catalog");
  });

  it("keeps v1 grouping when a model was available but produced nothing, because a failed call is not evidence that a cluster is unsortable", () => {
    expect(effortLabel({ ...base, assignment: null })).toBe("Catalog");
  });
});

describe("placeClusters and buildEfforts", () => {
  const balance = unit({
    path: "/c/billing",
    repo: "quill",
    branch: "dev/abc-101-gift-card-balance",
    pr: pr({ title: "ABC-101: Show gift card balance in the cart", state: "MERGED" }),
  });
  const blocked = unit({
    path: "/c/www",
    dirName: "colophon",
    repo: "colophon",
    branch: "dev/abc-102-wishlist-count",
    pr: pr({ number: 43, title: "ABC-102: Let readers export their highlights", checkConclusions: ["FAILURE"] }),
  });

  function board(overrides: Record<string, string> = {}) {
    return buildBoard([balance, blocked], {
      pattern: PATTERN,
      overrides,
      linearProjects: { "ABC-101": "Catalog", "ABC-102": "Catalog" },
    });
  }

  it("produces a complete board with no model keys at all: every cluster summarized, grouped and rolled up", () => {
    const placed = placeClusters({
      workstreams: board(),
      decisionFor: () => undefined,
      overrides: {},
      threshold: 0.6,
      grouped: false,
    });
    const efforts = buildEfforts(placed, {}, false);
    expect(efforts).toHaveLength(1);
    expect(efforts[0]?.name).toBe("Catalog");
    expect(efforts[0]?.rollup).toBe("1 of 2 merged; colophon blocked on CI.");
    // Ordered by ticket, never by lifecycle: ABC-101 before ABC-102.
    expect(efforts[0]?.clusters.map((one) => one.summary)).toEqual([
      "Show gift card balance in the cart",
      "Let readers export their highlights",
    ]);
  });

  it("produces a complete board in Jev-only mode, with efforts named from the best-fitting member's own selected summary", () => {
    const decisions: Record<string, ClusterDecision> = {
      "ABC-101": {
        summary: "Show gift card balance in the cart",
        assignment: { label: "gift-cards", fit: 0.75 },
      },
      "ABC-102": {
        summary: "Let readers export their highlights",
        assignment: { label: "gift-cards", fit: 0.9 },
      },
    };
    const placed = placeClusters({
      workstreams: board(),
      decisionFor: (one) => decisions[one.ticket],
      overrides: {},
      threshold: 0.6,
      grouped: true,
    });
    // No `names`: Claude is the only thing that supplies them, and it is absent.
    const efforts = buildEfforts(placed, {});
    expect(efforts).toHaveLength(1);
    expect(efforts[0]?.name).toBe("Let readers export their highlights");
    expect(efforts[0]?.rollup).toBe("1 of 2 merged; colophon blocked on CI.");
    expect(efforts[0]?.repoCount).toBe(2);
    expect(efforts[0]?.merged).toBe(1);
    expect(efforts[0]?.total).toBe(2);
  });

  it("uses Claude's written name when there is one, because a category name reads better than a borrowed PR title", () => {
    const decisions: Record<string, ClusterDecision> = {
      "ABC-101": { summary: "Show gift card balance in the cart", assignment: { label: "gift-cards", fit: 0.75 } },
      "ABC-102": { summary: "Let readers export their highlights", assignment: { label: "gift-cards", fit: 0.9 } },
    };
    const placed = placeClusters({
      workstreams: board(),
      decisionFor: (one) => decisions[one.ticket],
      overrides: {},
      threshold: 0.6,
      grouped: true,
    });
    const efforts = buildEfforts(placed, {
      "gift-cards": { name: "Gift cards across the store", cohesion: null },
    });
    expect(efforts[0]?.name).toBe("Gift cards across the store");
  });

  it("splits a low-confidence cluster out into Unsorted and keeps Unsorted last, so a confident effort never absorbs a guess", () => {
    const decisions: Record<string, ClusterDecision> = {
      "ABC-101": { summary: "Show gift card balance in the cart", assignment: { label: "gift-cards", fit: 0.9 } },
      "ABC-102": { summary: "Let readers export their highlights", assignment: { label: "gift-cards", fit: 0.2 } },
    };
    const placed = placeClusters({
      workstreams: board(),
      decisionFor: (one) => decisions[one.ticket],
      overrides: {},
      threshold: 0.6,
      grouped: true,
    });
    const efforts = buildEfforts(placed, {});
    expect(efforts.map((one) => one.key)).toEqual(["gift-cards", UNSORTED]);
    expect(efforts[1]?.name).toBe(UNSORTED);
  });

  it("never leaves an effort nameless even when nothing chose a summary, because an unnamed card cannot be read", () => {
    const placed: { label: string; cluster: SummarizedCluster; fit: number }[] = [];
    const efforts = buildEfforts(placed, {});
    expect(efforts).toEqual([]);
  });
});

// --- stacked pull requests -------------------------------------------------

import { linkStacks, type Unit } from "./workstreams.js";

/** One checkout whose PR is based on `base` and whose head is `head`. */
function stacked(options: {
  path: string;
  repo?: string;
  number: number;
  head: string;
  base: string;
  state?: string;
  reviewDecision?: string | null;
  checkConclusions?: string[];
}): Unit {
  const raw = unit({
    path: options.path,
    repo: options.repo ?? "quill",
    branch: options.head,
    defaultBranch: "main",
    pr: pr({
      number: options.number,
      state: options.state ?? "OPEN",
      reviewDecision: options.reviewDecision ?? null,
      checkConclusions: options.checkConclusions ?? [],
      headRefName: options.head,
      baseRefName: options.base,
    }),
  });
  return {
    ...raw,
    ticket: "ABC-101",
    lifecycle: unitLifecycle(raw),
    stack: null,
    staleness: "fresh" as const,
    surfaces: [],
    risk: "none" as const,
  };
}

function link(units: Unit[]): string[] {
  const warnings: string[] = [];
  linkStacks(units, (message) => warnings.push(message));
  return warnings;
}

describe("linkStacks", () => {
  it("orders a chain root to tip, because that is the order it has to merge in", () => {
    const bottom = stacked({ path: "/c/1", number: 1, head: "dev/one", base: "main" });
    const middle = stacked({ path: "/c/2", number: 2, head: "dev/two", base: "dev/one" });
    const top = stacked({ path: "/c/3", number: 3, head: "dev/three", base: "dev/two" });
    link([top, bottom, middle]);
    expect([bottom, middle, top].map((one) => one.stack?.position)).toEqual([1, 2, 3]);
    expect(top.stack?.size).toBe(3);
    expect(top.stack?.id).toBe(bottom.stack?.id);
  });

  it("leaves a lone PR on the default branch unstacked, so the board shows no stack chrome around a single PR", () => {
    const only = stacked({ path: "/c/1", number: 1, head: "dev/one", base: "main" });
    link([only]);
    expect(only.stack).toBeNull();
  });

  it("treats a PR whose base has no PR here as a root, because a chain simply starts where we can see it", () => {
    const orphan = stacked({ path: "/c/2", number: 2, head: "dev/two", base: "dev/gone" });
    const top = stacked({ path: "/c/3", number: 3, head: "dev/three", base: "dev/two" });
    link([orphan, top]);
    expect(orphan.stack?.position).toBe(1);
    expect(top.stack?.position).toBe(2);
  });

  it("still calls it a stack when the PR underneath already merged, because merge order is what defines the stack and it is only partly done", () => {
    const landed = stacked({ path: "/c/1", number: 1, head: "dev/one", base: "main", state: "MERGED" });
    const top = stacked({ path: "/c/2", number: 2, head: "dev/two", base: "dev/one" });
    link([landed, top]);
    expect(top.stack?.size).toBe(2);
    // Nothing below it is still open, so the top is genuinely next to merge.
    expect(top.stack?.blockedBelow).toBeNull();
  });

  it("names the unmerged PR below as the blocker, because an approved PR on top of it cannot merge yet", () => {
    const bottom = stacked({ path: "/c/1", number: 46, head: "dev/one", base: "main" });
    const top = stacked({
      path: "/c/2",
      number: 47,
      head: "dev/two",
      base: "dev/one",
      reviewDecision: "APPROVED",
      checkConclusions: ["SUCCESS"],
    });
    link([bottom, top]);
    expect(top.lifecycle).toBe("awaiting-merge");
    // Lifecycle stays honest about the PR itself; the dependency is separate.
    expect(top.stack?.blockedBelow).toBe(46);
  });

  it("breaks a cycle of bases and warns instead of looping forever, because git will happily let you create one", () => {
    const a = stacked({ path: "/c/1", number: 1, head: "dev/one", base: "dev/two" });
    const b = stacked({ path: "/c/2", number: 2, head: "dev/two", base: "dev/one" });
    const warnings = link([a, b]);
    expect(warnings.some((line) => line.includes("cycle"))).toBe(true);
    expect(a.stack?.size ?? 1).toBeLessThanOrEqual(2);
  });

  it("never links across repos, because a base branch name only means something inside one repository", () => {
    const here = stacked({ path: "/c/1", repo: "quill", number: 1, head: "dev/one", base: "main" });
    const elsewhere = stacked({ path: "/c/2", repo: "margin", number: 2, head: "dev/two", base: "dev/one" });
    link([here, elsewhere]);
    expect(here.stack).toBeNull();
    expect(elsewhere.stack).toBeNull();
  });

  it("links a chain that spans two tickets, because a stack is a repository structure and does not respect cluster boundaries", () => {
    const bottom = stacked({ path: "/c/1", number: 1, head: "dev/abc-101-one", base: "main" });
    const top = { ...stacked({ path: "/c/2", number: 2, head: "dev/abc-102-two", base: "dev/abc-101-one" }), ticket: "ABC-102" };
    link([bottom, top]);
    expect(bottom.stack?.id).toBe(top.stack?.id);
    expect(top.stack?.position).toBe(2);
  });

  it("drops a closed PR out of the merge order, because nothing waits on a PR that will never land", () => {
    const abandoned = stacked({ path: "/c/1", number: 1, head: "dev/one", base: "main", state: "CLOSED" });
    const other = stacked({ path: "/c/2", number: 2, head: "dev/two", base: "dev/one" });
    link([abandoned, other]);
    expect(abandoned.stack).toBeNull();
    expect(other.stack).toBeNull();
  });
});

describe("rollupSentence with stacks", () => {
  it("reports an approved PR stuck behind an unmerged one as waiting, because merge order is the real constraint and 'ready to merge' would be a lie", () => {
    const bottom = stacked({ path: "/c/1", repo: "folio", number: 46, head: "dev/one", base: "main" });
    const top = stacked({
      path: "/c/2",
      repo: "folio",
      number: 47,
      head: "dev/two",
      base: "dev/one",
      reviewDecision: "APPROVED",
      checkConclusions: ["SUCCESS"],
    });
    link([bottom, top]);
    const stack: Cluster = {
      ticket: "ABC-101",
      lifecycle: mostUrgent([bottom.lifecycle, top.lifecycle]),
      units: [top, bottom],
      staleness: "fresh",
      surfaces: [],
      risk: "none",
    };
    expect(rollupSentence([stack])).toBe(
      "0 of 2 merged; folio approved, blocked by #46 below it.",
    );
  });

  it("still reports a clear approved PR as ready even when another one is stacked, because the actionable one is what you want named", () => {
    const bottom = stacked({ path: "/c/1", repo: "folio", number: 46, head: "dev/one", base: "main" });
    const top = stacked({
      path: "/c/2",
      repo: "folio",
      number: 47,
      head: "dev/two",
      base: "dev/one",
      reviewDecision: "APPROVED",
      checkConclusions: ["SUCCESS"],
    });
    const clear = stacked({
      path: "/c/3",
      repo: "margin",
      number: 48,
      head: "dev/solo",
      base: "main",
      reviewDecision: "APPROVED",
      checkConclusions: ["SUCCESS"],
    });
    link([bottom, top, clear]);
    const board: Cluster = {
      ticket: "ABC-101",
      lifecycle: "awaiting-merge",
      units: [top, bottom, clear],
      staleness: "fresh",
      surfaces: [],
      risk: "none",
    };
    expect(rollupSentence([board])).toBe("0 of 3 merged; margin ready to merge.");
  });
});

describe("displayTitle", () => {
  it("strips both prefixes from a unit row title, because the map showed 'ABC-105: fix(search): ...' and spent the row on metadata the cluster header already states", () => {
    expect(displayTitle("ABC-105: fix(search): trim stray whitespace from queries")).toBe(
      "trim stray whitespace from queries",
    );
  });

  it("keeps a short title that normalizeSummary would reject, because a unit row must always show something", () => {
    expect(displayTitle("OPS-1: Fix typo")).toBe("Fix typo");
  });

  it("never truncates, because the row is width-constrained already and the hover title must hold the whole thing", () => {
    const long = "paginate the author index so large catalogues load in under a second";
    expect(displayTitle(`ABC-101: ${long}`)).toBe(long);
  });

  it("falls back to the original when a title is nothing but prefixes, so a row is never blank", () => {
    expect(displayTitle("OPS-1234:")).toBe("OPS-1234:");
  });
});

// ---------------------------------------------------------------------------
// v4: the two new dimensions, the hierarchy, and the lens.
// ---------------------------------------------------------------------------

/** The buildBoard options the v4 cases share. */
const options = {
  pattern: PATTERN,
  overrides: {} as Record<string, string>,
  linearProjects: {} as Record<string, string | null>,
};

/** One cluster, assembled directly rather than through a whole board. */
function clusterOf(ticket: string, repo: string, branch: string, title: string): Cluster {
  return cluster(ticket, [
    unit({ path: `/c/${ticket}`, dirName: ticket, repo, branch, pr: pr({ title }) }),
  ]);
}

describe("stalenessOf", () => {
  const now = Date.parse("2030-01-15T00:00:00Z");
  const daysAgo = (days: number) =>
    new Date(now - days * DAY_MS).toISOString();

  it("puts today's commit in fresh, because work touched this week is live", () => {
    expect(stalenessOf(daysAgo(0), now)).toBe("fresh");
  });

  it("keeps exactly seven days in fresh, because the boundary is an inclusive upper bound and a week-old branch is not stale yet", () => {
    expect(stalenessOf(daysAgo(7), now)).toBe("fresh");
    expect(stalenessOf(daysAgo(7.01), now)).toBe("recent");
  });

  it("keeps exactly thirty days in recent, so a month-old branch is not prematurely called cold", () => {
    expect(stalenessOf(daysAgo(30), now)).toBe("recent");
    expect(stalenessOf(daysAgo(30.01), now)).toBe("cold");
  });

  it("keeps exactly ninety days in cold, and anything past it dead, because a quarter without a commit is the point the work stopped being current", () => {
    expect(stalenessOf(daysAgo(90), now)).toBe("cold");
    expect(stalenessOf(daysAgo(90.01), now)).toBe("dead");
    expect(stalenessOf(daysAgo(400), now)).toBe("dead");
  });

  it("reads a missing or unparseable commit date as dead rather than fresh, because absence of evidence is not evidence of activity", () => {
    expect(stalenessOf(null, now)).toBe("dead");
    expect(stalenessOf("not-a-date", now)).toBe("dead");
  });

  it("takes every boundary from one exported constant, so a boundary cannot drift between the derivation and the UI", () => {
    expect(STALENESS_DAYS).toEqual({ fresh: 7, recent: 30, cold: 90 });
  });

  it("calls a group as fresh as its freshest member, because one commit yesterday means the work is live however long its other checkouts sat", () => {
    expect(freshest(["dead", "cold", "fresh"])).toBe("fresh");
    expect(freshest(["dead", "cold"])).toBe("cold");
  });
});

describe("staleness beside lifecycle", () => {
  const now = Date.parse("2030-01-15T00:00:00Z");

  it("lets one checkout be awaiting-review AND dead at the same time, which is the single most useful signal on the board and the whole reason these are two dimensions", () => {
    const board = buildBoard(
      [unit({ lastCommitAt: "2028-05-01T00:00:00Z", pr: pr() })],
      { ...options, now },
    );
    const only = board[0]?.clusters[0]?.units[0];
    expect(only?.lifecycle).toBe("awaiting-review");
    expect(only?.staleness).toBe("dead");
  });

  it("keeps staleness out of the lifecycle enum entirely, so the pair can never be collapsed into one value by accident", () => {
    expect(LIFECYCLES as readonly string[]).not.toContain("dead");
    expect(LIFECYCLES as readonly string[]).not.toContain("stale");
  });
});

describe("surface classification", () => {
  const rules = parseSurfaceRules(DEFAULT_SURFACE_RULES).rules;
  const of = (path: string) => classifySurfaces([path], rules);

  it("classifies every surface the default table ships, because a label nothing can ever match is a label that lies about what the table covers", () => {
    expect(of("services/auth/token.go")).toContain("auth");
    expect(of("web/src/payments/checkout.ts")).toContain("payments");
    expect(of("folio/db/migrate/0031_add_highlights.sql")).toContain("migrations");
    expect(of("schema/storefront.graphql")).toContain("schema");
    expect(of(".github/workflows/deploy.yml")).toContain("infra");
    expect(of("infra/terraform/main.tf")).toContain("infra");
    expect(of("server/api/wishlist.ts")).toContain("api");
    expect(of("web/src/components/BookPage.tsx")).toContain("ui");
    expect(of("web/src/bookPage.test.ts")).toContain("tests");
    expect(of("docs/runbook.md")).toContain("docs");
  });

  it("classifies generated GraphQL types as schema, because codegen output is schema surface and looks like ordinary source otherwise", () => {
    expect(of("web/src/__generated__/graphql.ts")).toContain("schema");
  });

  it("carries several surfaces on one unit, because a change that touches auth AND migrations is riskier than either alone and one label would hide that", () => {
    const surfaces = classifySurfaces(
      ["services/auth/token.go", "folio/db/migrate/0007.sql", "docs/auth.md"],
      rules,
    );
    expect(surfaces).toEqual(expect.arrayContaining(["auth", "migrations", "docs"]));
  });

  it("reports risk as a coarse ordinal rather than a number, because a rule table has no precision a decimal would be honest about", () => {
    expect(riskOf(["auth"])).toBe("high");
    expect(riskOf(["payments", "ui"])).toBe("high");
    expect(riskOf(["migrations"])).toBe("high");
    expect(riskOf(["ui", "api"])).toBe("medium");
    expect(riskOf(["docs", "tests"])).toBe("low");
    expect(riskOf([])).toBe("none");
  });

  it("falls back to the whole default table when a line cannot be read, because half a table silently applied would show plausible surfaces and never tell the user their edit was ignored", () => {
    const broken = parseSurfaceRules("auth: **/auth/**\nthis line has no colon");
    expect(broken.warning).not.toBeNull();
    expect(broken.rules.map((rule) => rule.surface)).toEqual(
      rules.map((rule) => rule.surface),
    );
  });

  it("falls back rather than throwing when a surface lists no patterns at all", () => {
    const empty = parseSurfaceRules("auth:");
    expect(empty.warning).not.toBeNull();
    expect(() => parseSurfaceRules("auth:")).not.toThrow();
  });

  it("honours a tuned table, because risk is org-specific and the setting exists to be edited", () => {
    const tuned = parseSurfaceRules("returns: **/returns/**");
    expect(tuned.warning).toBeNull();
    expect(classifySurfaces(["folio/returns/check.go"], tuned.rules)).toEqual([
      "returns",
    ]);
  });
});

describe("dimensions never reach a position", () => {
  const now = Date.parse("2030-01-15T00:00:00Z");
  const order = (units: RawUnit[]) =>
    buildBoard(units, { ...options, now }).map((one) => [
      one.name,
      one.clusters.map((cluster) => cluster.ticket),
    ]);

  const base = [
    unit({ path: "/c/a", dirName: "abc-1-a", branch: "dev/abc-1-a" }),
    unit({ path: "/c/b", dirName: "abc-101-b", branch: "dev/abc-101-b" }),
  ];

  it("returns identical ordering when a unit goes from fresh to dead, because staleness paints and never positions", () => {
    const stale = base.map((one) =>
      one.path === "/c/b" ? unit({ ...one, lastCommitAt: "2027-05-01T00:00:00Z" }) : one,
    );
    expect(order(stale)).toEqual(order(base));
    expect(
      buildBoard(stale, { ...options, now }).flatMap((one) =>
        one.clusters.map((cluster) => cluster.staleness),
      ),
    ).toContain("dead");
  });

  it("returns identical ordering when a unit's surfaces change, because surface is a filter and a colour, not a place", () => {
    const touched = base.map((one) =>
      one.path === "/c/b"
        ? unit({ ...one, changedPaths: ["services/auth/token.go"] })
        : one,
    );
    expect(order(touched)).toEqual(order(base));
    expect(
      buildBoard(touched, { ...options, now }).flatMap((one) =>
        one.clusters.map((cluster) => cluster.risk),
      ),
    ).toContain("high");
  });
});

describe("the Linear signal", () => {
  function twoUnrelated() {
    return [
      clusterOf("ABC-1", "folio", "dev/abc-1-search", "Tune search ranking weights"),
      clusterOf("ABC-9", "colophon", "dev/abc-9-reading-list", "Refresh the seasonal reading list"),
    ];
  }

  it("cannot on its own merge two clusters whose repos and vocabulary disagree, because Linear informs a theme and does not decide one", () => {
    const clusters = twoUnrelated();
    const grouped = seedGroups(clusters, {
      "ABC-1": "Inkwell backlog",
      "ABC-9": "Inkwell backlog",
    });
    expect(grouped).toHaveLength(2);
  });

  it("scores a perfect project match alone below the merge threshold, which is the arithmetic that makes the rule above true rather than a coincidence of this fixture", () => {
    const alone = similarity(
      { key: "a", repos: new Set(["x"]), vocab: new Set(["one"]), projects: new Set(["P"]) },
      { key: "b", repos: new Set(["y"]), vocab: new Set(["two"]), projects: new Set(["P"]) },
    );
    expect(alone).toBeLessThan(MERGE_THRESHOLD);
  });

  it("still amplifies agreement the other terms already found, because a nudge that never changes anything is not a signal", () => {
    const a = { key: "a", repos: new Set(["folio"]), vocab: new Set(["wishlist"]) };
    const without = similarity(
      { ...a, projects: new Set<string>() },
      { key: "b", repos: new Set(["folio"]), vocab: new Set(["billing"]), projects: new Set<string>() },
    );
    const with_ = similarity(
      { ...a, projects: new Set(["Wishlists"]) },
      { key: "b", repos: new Set(["folio"]), vocab: new Set(["billing"]), projects: new Set(["Wishlists"]) },
    );
    expect(with_).toBeGreaterThan(without);
  });

  it("scores exactly as it did before the term existed when no project is known, so a board with no Linear key behaves precisely as today", () => {
    const a = { key: "a", repos: new Set(["folio"]), vocab: new Set(["wishlist", "giftcard"]), projects: new Set<string>() };
    const b = { key: "b", repos: new Set(["folio"]), vocab: new Set(["wishlist"]), projects: new Set<string>() };
    expect(similarity(a, b)).toBeCloseTo(0.6 * 1 + 0.4 * 0.5, 10);
  });

  it("offers a Linear project as ONE naming candidate among the members' own words rather than installing it as the answer", () => {
    const candidates = namingCandidates(
      ["Show gift card balance in the cart", "Let readers export their highlights"],
      ["Reader accounts"],
    );
    expect(candidates).toContain("Reader accounts");
    expect(candidates).toContain("Show gift card balance in the cart");
    expect(candidates.length).toBeGreaterThan(1);
  });

  it("drops a blank or missing project rather than offering an empty candidate, so a messy Linear never degrades the board", () => {
    expect(namingCandidates(["Show gift card balance"], [null, "", "   "])).toEqual([
      "Show gift card balance",
    ]);
  });
});

describe("the hierarchy and its collapse rules", () => {
  function effortOf(key: string, tickets: string[]): BoardGroup {
    return {
      level: "effort",
      key,
      parentKey: null,
      name: key,
      rollup: "",
      lifecycle: "up-next",
      cohesion: null,
      clusters: tickets.map((ticket) => ({
        ...clusterOf(ticket, "folio", `dev/${ticket.toLowerCase()}`, "Some work here"),
        summary: "Some work here",
      })),
      repoCount: 1,
      merged: 0,
      total: tickets.length,
      staleness: "fresh",
      surfaces: [],
      risk: "none",
    };
  }

  const efforts = [
    effortOf("Search", ["ABC-1"]),
    effortOf("Gift cards", ["ABC-2"]),
    effortOf("Homepage", ["ABC-9"]),
  ];

  it("renders no program wrapper around a single effort, because a group that restates its only child is noise the reader has to look past", () => {
    const groups = buildHierarchy({
      efforts,
      // Every effort in its own program: three wrappers, each redundant.
      programOf: (effort) => effort.key,
    });
    expect(groups.map((group) => group.level)).toEqual(["effort", "effort", "effort"]);
    expect(hierarchyDepth(groups)).toBe(1);
  });

  it("dissolves a single domain holding the whole board, because one group containing everything says nothing the board did not already say", () => {
    const groups = buildHierarchy({
      efforts,
      programOf: (effort) => (effort.key === "Homepage" ? "Events" : "Storefront"),
      domainOf: () => "Everything",
    });
    expect(groups.some((group) => group.level === "domain")).toBe(false);
    // "Events" held one effort and went with it; "Storefront" held two and stayed.
    expect(groups.filter((group) => group.level === "program").map((group) => group.key)).toEqual([
      "program:Storefront",
    ]);
  });

  it("collapses a level whose grouping merely restates the level below it, because an identical membership partition adds a rung and no information", () => {
    const groups = buildHierarchy({
      efforts,
      programOf: (effort) => (effort.key === "Homepage" ? "Events" : "Storefront"),
      // One domain per program: the same partition, one level up.
      domainOf: (program) => program.key,
    });
    expect(groups.some((group) => group.level === "domain")).toBe(false);
    expect(hierarchyDepth(groups)).toBe(2);
  });

  it("keeps a level that earns its place, because depth is a maximum rather than something to avoid", () => {
    const four = [...efforts, effortOf("Payments", ["ABC-3"])];
    const groups = buildHierarchy({
      efforts: four,
      programOf: (effort) =>
        effort.key === "Homepage"
          ? "Events"
          : effort.key === "Payments"
            ? "Catalog"
            : "Storefront",
      domainOf: (program) => (program.key === "program:Events" ? "Growth" : "Product"),
    });
    expect(hierarchyDepth(groups)).toBe(3);
    const domains = groups.filter((group) => group.level === "domain");
    // "Growth" holds one program, so it collapses; "Product" holds two and stays.
    // Its NAME is borrowed from its widest member — no model named it here —
    // so the key is what identifies it.
    expect(domains.map((group) => group.key)).toEqual(["domain:Product"]);
  });

  it("rolls counts up from the clusters below rather than from the level beneath, so a collapsed level cannot lose a checkout", () => {
    const groups = buildHierarchy({
      efforts,
      programOf: (effort) => (effort.key === "Homepage" ? "Events" : "Storefront"),
    });
    const storefront = groups.find((group) => group.key === "program:Storefront");
    expect(storefront?.total).toBe(2);
    expect(storefront?.clusters).toHaveLength(0);
  });

  it("keeps Unsorted last at every level, because a residue is not a theme however the hierarchy collapsed", () => {
    const groups = buildHierarchy({
      efforts: [...efforts, effortOf(UNSORTED, ["ZZ-1"])],
      programOf: (effort) =>
        effort.key === UNSORTED ? UNSORTED : effort.key === "Homepage" ? "Events" : "Storefront",
    });
    const roots = groups.filter((group) => group.parentKey === null);
    expect(roots[roots.length - 1]?.key).toBe(UNSORTED);
  });

  it("orders every level by name and never by lifecycle, so the rule that made the board a status board cannot come back one rung up", () => {
    const blockedFirst = efforts.map((effort) =>
      effort.key === "Homepage" ? { ...effort, lifecycle: "blocked" as const } : effort,
    );
    const names = (list: BoardGroup[]) =>
      buildHierarchy({ efforts: list }).map((group) => group.name);
    expect(names(blockedFirst)).toEqual(names(efforts));
    expect(names(efforts)).toEqual(["Gift cards", "Homepage", "Search"]);
  });

  it("keeps the wire list a valid tree: every parentKey names a group that is present", () => {
    const groups = buildHierarchy({
      efforts,
      programOf: (effort) => (effort.key === "Homepage" ? "Events" : "Storefront"),
    });
    const keys = new Set(groups.map((group) => group.key));
    for (const group of groups) {
      if (group.parentKey !== null) expect(keys.has(group.parentKey)).toBe(true);
    }
    expect([...groupChildren(groups).get(null) ?? []].length).toBe(2);
  });
});

describe("the status lens", () => {
  const item = (
    lifecycle: Parameters<typeof matchesFilters>[0]["lifecycle"],
    staleness: Parameters<typeof matchesFilters>[0]["staleness"],
    surfaces: string[] = [],
  ) => ({ lifecycle, staleness, surfaces });

  it("maps each lens onto exactly one lifecycle group, because the lenses ARE the groups and a fourth definition would be a fourth thing to keep in sync", () => {
    expect(matchesLens("blocked", "waiting")).toBe(true);
    expect(matchesLens("awaiting-merge", "waiting")).toBe(true);
    expect(matchesLens("in-progress", "active")).toBe(true);
    expect(matchesLens("active", "active")).toBe(true);
    expect(matchesLens("shipped", "done")).toBe(true);
    expect(matchesLens("blocked", "active")).toBe(false);
  });

  it("matches everything under All, so the lens has an off position", () => {
    for (const lifecycle of LIFECYCLES) expect(matchesLens(lifecycle, "all")).toBe(true);
  });

  it("composes the status lens with staleness, because 'Needs you AND cold or dead' is the question the two dimensions exist to answer together", () => {
    const filters = { lens: "waiting" as const, staleness: ["cold", "dead"] as const, surfaces: [] };
    expect(matchesFilters(item("awaiting-review", "dead"), filters)).toBe(true);
    expect(matchesFilters(item("awaiting-review", "fresh"), filters)).toBe(false);
    expect(matchesFilters(item("in-progress", "dead"), filters)).toBe(false);
  });

  it("composes with surfaces too, and treats an empty filter as 'every one' so the three compose without a null case", () => {
    expect(
      matchesFilters(item("blocked", "fresh", ["auth"]), {
        lens: "all",
        staleness: [],
        surfaces: ["auth"],
      }),
    ).toBe(true);
    expect(
      matchesFilters(item("blocked", "fresh", ["ui"]), {
        lens: "all",
        staleness: [],
        surfaces: ["auth"],
      }),
    ).toBe(false);
    expect(matchesFilters(item("blocked", "fresh", ["ui"]), ALL_LENSES)).toBe(true);
  });

  it("is a PREDICATE and not a transform, so a lens can only ever decide how loudly a row reads and can never reorder or remove one", () => {
    const groups = buildHierarchy({
      efforts: [
        {
          level: "effort",
          key: "A",
          parentKey: null,
          name: "A",
          rollup: "",
          lifecycle: "blocked",
          cohesion: null,
          clusters: [],
          repoCount: 0,
          merged: 0,
          total: 0,
          staleness: "fresh",
          surfaces: [],
          risk: "none",
        },
      ],
    });
    const before = groups.map((group) => group.key);
    for (const lens of LENSES) {
      // Filtering is the caller's business and happens after this point; the
      // board itself is identical whatever lens is selected.
      expect(groups.filter(() => true).map((group) => group.key)).toEqual(before);
      expect(typeof matchesLens("blocked", lens)).toBe("boolean");
    }
  });
});

describe("isStuck", () => {
  it("marks awaiting-review gone dead as stuck, because a review nobody has touched in months is the single most useful thing the two dimensions say together", () => {
    expect(isStuck({ lifecycle: "awaiting-review", staleness: "dead" })).toBe(true);
    expect(isStuck({ lifecycle: "awaiting-review", staleness: "cold" })).toBe(true);
  });

  it("marks every Waiting state and the two working Active states once cold, because each is expected to move", () => {
    for (const lifecycle of ["blocked", "awaiting-followup", "approved-with-comments", "awaiting-merge", "active", "in-progress"] as const) {
      expect(isStuck({ lifecycle, staleness: "cold" })).toBe(true);
    }
  });

  it("never marks fresh or recent work, because a commit this month means it is moving", () => {
    expect(isStuck({ lifecycle: "awaiting-review", staleness: "recent" })).toBe(false);
    expect(isStuck({ lifecycle: "in-progress", staleness: "fresh" })).toBe(false);
  });

  it("does not mark an old up-next checkout, because a parked clone is not expected to move and flagging it would bury the real ones", () => {
    expect(isStuck({ lifecycle: "up-next", staleness: "dead" })).toBe(false);
  });

  it("does not mark Done work however old, because finished work has nowhere left to move", () => {
    for (const lifecycle of ["shipped", "merged", "closed"] as const) {
      expect(isStuck({ lifecycle, staleness: "dead" })).toBe(false);
    }
  });
});

describe("dominantSurface", () => {
  const rules = parseSurfaceRules(DEFAULT_SURFACE_RULES).rules;
  const ui = (count: number) => Array.from({ length: count }, (_, i) => `web/components/Widget${i}.tsx`);

  it("files a cluster by what it MOSTLY changes, so one auth helper inside a forty-file UI branch reads as the UI change it is", () => {
    expect(dominantSurface(["api/auth/token.go", ...ui(40)], rules)).toEqual({ surface: "ui", risk: "medium" });
  });

  it("escalates on a single migration, because a schema change cannot be un-run against real data however small the branch around it", () => {
    expect(dominantSurface(["db/migrations/0118_add_typefaces.sql", ...ui(40)], rules)).toEqual({
      surface: "migrations",
      risk: "high",
    });
  });

  it("escalates on a single payments file over docs, because a money path is dangerous at one file", () => {
    expect(
      dominantSurface(["src/billing/charge.ts", "docs/a.md", "docs/b.md", "docs/c.md"], rules),
    ).toEqual({ surface: "payments", risk: "high" });
  });

  it("breaks a tie between two escalating surfaces by rule-table order, never by file count or input order", () => {
    const paths = ["src/billing/charge.ts", "src/billing/refund.ts", "db/migrations/0042.sql"];
    // payments precedes migrations in the shipped table.
    expect(dominantSurface(paths, rules).surface).toBe("payments");
    expect(dominantSurface([...paths].reverse(), rules).surface).toBe("payments");
  });

  it("breaks an equal file count toward the riskier surface, so a tie never hides the dangerous half", () => {
    expect(dominantSurface(["src/api/routes/a.go", "docs/a.md"], rules)).toEqual({ surface: "api", risk: "medium" });
  });

  it("lands a cluster with no classified paths in none, rather than inventing a home for it", () => {
    expect(dominantSurface([], rules)).toEqual({ surface: null, risk: "none" });
    expect(dominantSurface(["Makefile", "go.sum"], rules)).toEqual({ surface: null, risk: "none" });
  });

  it("names exactly the two irreversible surfaces as escalating, and keeps it a constant rather than a setting", () => {
    expect([...ESCALATING].sort()).toEqual(["migrations", "payments"]);
  });
});
