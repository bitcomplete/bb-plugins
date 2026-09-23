import { describe, expect, it } from "vitest";
import { clusterKey, riskFace, themeFace, type Cluster, type Group, type MapDatum } from "./faces.js";
import { flatten, packLayout, type LayoutNode, type PackLayout } from "./layout.js";
import type { Lifecycle, Risk } from "./workstreams.js";

/** A wire cluster with only what the face builders read filled in meaningfully. */
function cluster(
  ticket: string,
  dominant: { surface: string | null; risk: Risk },
  options: { units?: number; lifecycle?: Lifecycle } = {},
): Cluster {
  const unit = {
    path: `/c/${ticket}`,
    dirName: ticket,
    repo: "repo",
    branch: ticket,
    dirty: false,
    ahead: 0,
    behind: 0,
    lastCommitAt: null,
    defaultBranch: "main",
    pr: null,
    shipped: null,
    changedPaths: [],
    ticket,
    lifecycle: options.lifecycle ?? "in-progress",
    stack: null,
    staleness: "fresh" as const,
    surfaces: [],
    risk: "none" as const,
  };
  return {
    ticket,
    lifecycle: options.lifecycle ?? "in-progress",
    summary: `${ticket} summary`,
    units: Array.from({ length: options.units ?? 1 }, (_, i) => ({ ...unit, path: `${unit.path}/${i}` })),
    staleness: "fresh",
    surfaces: dominant.surface === null ? [] : [dominant.surface],
    risk: dominant.risk,
    dominant,
    threads: [],
  };
}

const CLUSTERS: Cluster[] = [
  cluster("ABC-101", { surface: "migrations", risk: "high" }, { units: 2 }),
  cluster("ABC-102", { surface: "payments", risk: "high" }, { units: 7 }),
  cluster("OPS-3333", { surface: "api", risk: "medium" }, { units: 1 }),
  cluster("SHOP-1", { surface: "tests", risk: "low" }, { units: 3 }),
  cluster("WEB-9", { surface: null, risk: "none" }, { units: 5 }),
];

function geometry(layout: PackLayout<MapDatum>): Map<string, [number, number, number]> {
  return new Map(flatten(layout).map((c) => [c.key, [c.x, c.y, c.r]]));
}

function leaves(nodes: readonly LayoutNode<MapDatum>[]): string[] {
  return nodes.flatMap((node) => (node.children === undefined ? [node.key] : leaves(node.children)));
}

describe("riskFace", () => {
  it("files every cluster exactly once, so no ticket appears in two places on one face", () => {
    const keys = leaves(riskFace(CLUSTERS));
    expect(keys.sort()).toEqual(CLUSTERS.map((c) => clusterKey(c.ticket)).sort());
  });

  it("groups by tier, then by dominant surface, with the tiers packed most dangerous first", () => {
    const face = riskFace(CLUSTERS);
    expect(face.map((node) => node.key)).toEqual(["risk:high", "risk:medium", "risk:low", "risk:none"]);
    const high = face[0]!;
    expect(high.children?.map((node) => node.key)).toEqual(["risk:high:migrations", "risk:high:payments"]);
    expect(high.children?.[0]?.children?.map((node) => node.key)).toEqual(["cluster:ABC-101"]);
  });

  it("holds unclassified clusters directly in their tier, because a surface group called 'none' would say nothing", () => {
    const none = riskFace(CLUSTERS).find((node) => node.key === "risk:none")!;
    expect(none.children?.map((node) => node.key)).toEqual(["cluster:WEB-9"]);
  });

  it("draws no empty tier", () => {
    const face = riskFace(CLUSTERS.filter((c) => c.dominant.risk !== "low"));
    expect(face.map((node) => node.key)).not.toContain("risk:low");
  });

  it("is deterministic: the same clusters in any order pack to byte-identical geometry", () => {
    const a = packLayout(riskFace(CLUSTERS));
    const b = packLayout(riskFace([...CLUSTERS].reverse()));
    expect(geometry(b)).toEqual(geometry(a));
  });

  it("never positions by lifecycle: turning every cluster red moves nothing on the Risk face", () => {
    const red = CLUSTERS.map((c) => ({ ...c, lifecycle: "blocked" as const }));
    expect(geometry(packLayout(riskFace(red)))).toEqual(geometry(packLayout(riskFace(CLUSTERS))));
  });

  it("builds nodes with no lifecycle field, the same shape the Theme face uses — `order` is the one addition, and only tiers carry it", () => {
    const keys = new Set<string>();
    const visit = (node: LayoutNode<MapDatum>) => {
      Object.keys(node).forEach((key) => keys.add(key));
      node.children?.forEach(visit);
    };
    riskFace(CLUSTERS).forEach(visit);
    expect([...keys].sort()).toEqual(["children", "data", "key", "label", "order", "weight"]);
  });

  it("orders tiers by the fixed RISK_TIER_ORDER constant, not anything computed from cluster state — reversing or relabeling the clusters can't change it", () => {
    const face = riskFace(CLUSTERS);
    for (const [index, tier] of ["high", "medium", "low", "none"].entries()) {
      expect(face.find((node) => node.key === `risk:${tier}`)?.order).toBe(index);
    }
    // Same order however the input clusters are shuffled.
    const shuffled = riskFace([...CLUSTERS].reverse());
    expect(shuffled.map((node) => node.order)).toEqual(face.map((node) => node.order));
  });

  it("carries no cohesion verdict on its groups, because a deterministic grouping was never judged", () => {
    const groups = riskFace(CLUSTERS).flatMap((node) => [node, ...(node.children ?? [])]);
    for (const node of groups) {
      if (node.data.kind === "group") expect(node.data.group.cohesion).toBeNull();
    }
  });
});

describe("themeFace", () => {
  it("keys clusters exactly as the Risk face does, so a cluster keeps its identity across a turn", () => {
    const group = {
      level: "effort",
      key: "e",
      parentKey: null,
      name: "Cart",
      rollup: "",
      lifecycle: "in-progress",
      cohesion: null,
      clusters: CLUSTERS,
      repoCount: 1,
      merged: 0,
      total: 1,
      staleness: "fresh",
      surfaces: [],
      risk: "none",
    } satisfies Group;
    const theme = new Set(leaves(themeFace([group], () => [])));
    expect(theme).toEqual(new Set(leaves(riskFace(CLUSTERS))));
  });
});
