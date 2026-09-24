// One-off containers: an effort holding a single cluster is filed, by code
// alone, into a container per ticket prefix, so a board of one-offs does not
// read as a board of efforts. Filing, not a claim the members are related.
import { describe, expect, it } from "vitest";
import type { RawUnit } from "./contract.js";
import {
  NO_TICKET,
  UNSORTED,
  buildHierarchy,
  outsideGrouping,
  parseTeamNames,
  rollOneOffs,
  unitLifecycle,
  type BoardGroup,
  type Lifecycle,
  type SummarizedCluster,
} from "./workstreams.js";

function clusterOf(ticket: string | null, key: string, state: "OPEN" | "MERGED" = "OPEN"): SummarizedCluster {
  const raw: RawUnit = {
    path: `/c/${key}`, dirName: key, repo: "inkwell/quill", branch: `dev/${key}`, dirty: false, ahead: 0, behind: 0,
    lastCommitAt: null, defaultBranch: "main", shipped: null, changedPaths: [],
    pr: { number: 1, state, isDraft: false, reviewDecision: null, checkConclusions: [], url: `https://github.com/inkwell/quill/pull/${key}`,
      title: `Work on ${key}`, mergeable: null, baseRefName: "main", headRefName: `dev/${key}`, latestReviewStates: [], mergedAt: null,
      mergeStateStatus: "UNKNOWN", reviewRequests: [], latestReviews: [], unresolvedReviewThreads: null },
  };
  const lifecycle = unitLifecycle(raw);
  return {
    ticket: ticket ?? key, summary: `Work on ${key}`, lifecycle, staleness: "fresh", surfaces: [], risk: "none",
    units: [{ ...raw, ticket, ticketSource: ticket === null ? null : "branch", lifecycle, stack: null, staleness: "fresh", surfaces: [], risk: "none" }],
  };
}

function effort(key: string, clusters: SummarizedCluster[], lifecycle: Lifecycle = "in-progress"): BoardGroup {
  return {
    level: "effort", key, parentKey: null, name: key, rollup: "", lifecycle, cohesion: { verdict: "cohesive", reason: null },
    clusters, repoCount: 1, merged: 0, total: clusters.length, staleness: "fresh", surfaces: [], risk: "none",
  };
}

const none = { overrides: {}, teamNames: {}, linearTeamNames: {} };

const board = () => [
  effort("Gift cards", [clusterOf("ABC-1", "a1")]),
  effort("Shelf index", [clusterOf("ABC-2", "a2")]),
  effort("Print run", [clusterOf("OPS-1", "o1"), clusterOf("OPS-2", "o2")]),
  effort("Spine labels", [clusterOf("OPS-3", "o3")]),
];

describe("rolling one-offs into containers", () => {
  it("files one-cluster efforts by ticket prefix and leaves real efforts alone", () => {
    const { efforts, containers } = rollOneOffs(board(), none);
    expect(containers.map((group) => [group.key, group.level, group.name, group.clusters.map((c) => c.ticket)])).toEqual([
      ["team:ABC", "program", "ABC · 2 one-offs", ["ABC-1", "ABC-2"]],
    ]);
    // OPS-3 is OPS's only one-off: a container of one is just that cluster's own effort.
    expect(efforts.map((group) => group.key)).toEqual(["Print run", "Spine labels"]);
  });

  it("never claims a container is cohesive, so the Map never flags or vouches for it", () => {
    expect(rollOneOffs(board(), none).containers.every((group) => group.cohesion === null)).toBe(true);
  });

  it("keeps a one-off the user named by override, because that name is the user's grouping decision", () => {
    const { containers } = rollOneOffs([...board(), effort("Colophon", [clusterOf("ABC-3", "a3")])], { ...none, overrides: { "ABC-3": "Colophon" } });
    expect(containers[0]?.clusters.map((c) => c.ticket)).toEqual(["ABC-1", "ABC-2"]);
  });

  it("files finished ticketless PRs and ticketless one-offs together under No ticket", () => {
    const { efforts, containers } = rollOneOffs(
      [effort(NO_TICKET, [clusterOf(null, "quill-bump", "MERGED"), clusterOf(null, "quill-try", "MERGED")]), effort("Quick fix", [clusterOf(null, "quill-fix")])],
      none,
    );
    expect(efforts).toEqual([]);
    expect(containers.map((group) => [group.key, group.name, group.clusters.length])).toEqual([["team:No ticket", "No ticket · 3", 3]]);
  });

  it("collapses a No ticket container of one to that cluster's own group", () => {
    const { efforts, containers } = rollOneOffs([effort(NO_TICKET, [clusterOf(null, "quill-bump", "MERGED")])], none);
    expect(containers).toEqual([]);
    expect(efforts.map((group) => group.clusters.length)).toEqual([1]);
  });
});

describe("container labels", () => {
  it("prefers the user's name, then the Linear team name, then the prefix", () => {
    const name = (teamNames: Record<string, string>, linearTeamNames: Record<string, string>) =>
      rollOneOffs(board(), { overrides: {}, teamNames, linearTeamNames }).containers[0]?.name;
    expect(name({ ABC: "Storefront" }, { ABC: "Shop" })).toBe("Storefront (ABC) · 2 one-offs");
    expect(name({}, { ABC: "Shop" })).toBe("Shop (ABC) · 2 one-offs");
    expect(name({}, {})).toBe("ABC · 2 one-offs");
  });

  it("reads the teamNames setting defensively, skipping and counting malformed entries", () => {
    expect(parseTeamNames("ABC=Storefront, nonsense, =Nameless, OPS = Operations,  ,WEB=")).toEqual({
      names: { ABC: "Storefront", OPS: "Operations" },
      malformed: 3,
    });
    expect(parseTeamNames(undefined)).toEqual({ names: {}, malformed: 0 });
  });
});

describe("containers and the model", () => {
  it("keeps every container and the No ticket effort out of what a model is asked about", () => {
    const { containers } = rollOneOffs(board(), none);
    for (const group of containers) expect(outsideGrouping(group.key)).toBe(true);
    expect(outsideGrouping(NO_TICKET)).toBe(true);
    expect(outsideGrouping(UNSORTED)).toBe(true);
    expect(outsideGrouping("Print run")).toBe(false);
  });
});

describe("containers on the Map", () => {
  it("places containers deterministically, after real groups and before Unsorted, whatever the input order or lifecycle", () => {
    const layout = (efforts: BoardGroup[]) => {
      const rolled = rollOneOffs(efforts, none);
      return buildHierarchy({ efforts: rolled.efforts, containers: rolled.containers }).map((group) => `${group.key}>${group.parentKey}`);
    };
    const input = [...board(), effort(UNSORTED, [clusterOf(null, "quill")])];
    const blocked = input.map((group) => ({
      ...group,
      lifecycle: "blocked" as const,
      clusters: group.clusters.map((cluster) => ({ ...cluster, lifecycle: "blocked" as const })),
    }));
    expect(layout(input)).toEqual(["Print run>null", "Spine labels>null", "team:ABC>null", `${UNSORTED}>null`]);
    expect(layout([...input].reverse())).toEqual(layout(input));
    expect(layout(blocked)).toEqual(layout(input));
  });

  it("keeps a container at the top of the tree when programs and domains are built above the efforts", () => {
    const rolled = rollOneOffs(board(), none);
    const groups = buildHierarchy({
      efforts: rolled.efforts,
      containers: rolled.containers,
      programOf: () => "Catalog",
      domainOf: (program) => program.key,
    });
    const container = groups.find((group) => group.key === "team:ABC");
    expect(container?.parentKey).toBeNull();
    expect(groups.filter((group) => group.parentKey === "team:ABC")).toEqual([]);
  });
});
