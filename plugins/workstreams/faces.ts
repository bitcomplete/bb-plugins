// The Map's faces: the SAME clusters grouped by a different dimension, packed by
// the same `packLayout`. A face is a pure tree builder and nothing more — no
// React, no DOM — so which face a cluster lands where on is testable, and the
// geometry rules in layout.ts hold on every face without being restated.
//
// Two invariants carry over from the single-face map. A cluster is keyed by its
// ticket on every face, so identity survives a turn and fly-to keeps working.
// And position never derives from lifecycle on ANY face: the Risk face groups
// by what a change touches, which is a fact about its paths, never its status.
import type { LayoutNode } from "./layout";
import type { WireGroup } from "./server";
import { freshest, mostUrgent, type Risk } from "./workstreams";

export type Group = WireGroup;
export type Cluster = Group["clusters"][number];
export type MapDatum = { kind: "group"; group: Group } | { kind: "cluster"; cluster: Cluster };

export const FACES = ["theme", "risk"] as const;
export type Face = (typeof FACES)[number];

export const FACE_LABEL: Record<Face, string> = { theme: "Theme", risk: "Risk" };

/** One key per cluster, shared by every face: what lets a cluster travel. */
export function clusterKey(ticket: string): string {
  return `cluster:${ticket}`;
}

function clusterNode(cluster: Cluster): LayoutNode<MapDatum> {
  return {
    key: clusterKey(cluster.ticket),
    label: cluster.ticket,
    weight: cluster.units.length,
    data: { kind: "cluster", cluster },
  };
}

// ---- Theme: the grouping hierarchy ------------------------------------------

/**
 * Board → the layout's generic nested shape. Leaves are ticket clusters, sized
 * by their checkout count; units are drawn INSIDE a leaf by the renderer, not
 * packed, because a ring of dots or a short list reads better than a froth of
 * sub-circles and keeps the packing to the levels a reader navigates.
 */
function groupNode(group: Group, childrenOf: (key: string) => Group[]): LayoutNode<MapDatum> {
  const children = childrenOf(group.key);
  return {
    key: `g:${group.key}`,
    label: group.name,
    data: { kind: "group", group },
    children:
      children.length > 0
        ? children.map((child) => groupNode(child, childrenOf))
        : group.clusters.map(clusterNode),
  };
}

export function themeFace(
  roots: readonly Group[],
  childrenOf: (key: string) => Group[],
): LayoutNode<MapDatum>[] {
  return roots.map((root) => groupNode(root, childrenOf));
}

// ---- Risk: tier, then dominant surface ---------------------------------------

/** Tiers most dangerous first. */
export const RISK_TIERS: readonly Risk[] = ["high", "medium", "low", "none"];

/**
 * Explicit, static packing order for the risk tiers: High, Medium, Low, then
 * Unclassified last. This is a fixed severity ranking, never a fact about a
 * scan's current status, so it is allowed under layout.ts's "position never
 * derives from lifecycle" rule — see the `order` field on `LayoutNode`.
 */
export const RISK_TIER_ORDER: Record<Risk, number> = Object.fromEntries(
  RISK_TIERS.map((tier, index) => [tier, index]),
) as Record<Risk, number>;

const TIER_NAME: Record<Risk, string> = {
  high: "High risk",
  medium: "Medium risk",
  low: "Low risk",
  none: "Unclassified",
};

const SURFACE_NAME: Record<string, string> = { api: "API", ui: "UI" };

export function surfaceName(surface: string): string {
  return SURFACE_NAME[surface] ?? `${surface.charAt(0).toUpperCase()}${surface.slice(1)}`;
}

/**
 * A group the Risk face assembles for itself. It carries the fields the
 * renderer reads off any group, and no cohesion verdict: these groupings are
 * deterministic, so there is nothing for Claude to have judged.
 */
function syntheticGroup(
  key: string,
  name: string,
  level: Group["level"],
  clusters: Cluster[],
  risk: Risk,
  surfaces: string[],
): Group {
  const units = clusters.flatMap((cluster) => cluster.units);
  return {
    level,
    key,
    parentKey: null,
    name,
    rollup: "",
    lifecycle: mostUrgent(clusters.map((cluster) => cluster.lifecycle)),
    cohesion: null,
    clusters: level === "effort" ? clusters : [],
    repoCount: new Set(units.map((unit) => unit.repo ?? unit.dirName)).size,
    merged: units.filter((unit) => unit.lifecycle === "merged" || unit.lifecycle === "shipped").length,
    total: units.length,
    staleness: freshest(clusters.map((cluster) => cluster.staleness)),
    surfaces,
    risk,
  };
}

/**
 * Top level: risk tiers. Inside each, one group per DOMINANT surface — every
 * cluster has exactly one, so none appears twice — then the clusters. A tier
 * with nothing in it is not drawn, and "Unclassified" holds its clusters
 * directly, because a surface group named "none" would say nothing.
 */
export function riskFace(clusters: readonly Cluster[]): LayoutNode<MapDatum>[] {
  const nodes: LayoutNode<MapDatum>[] = [];
  RISK_TIERS.forEach((tier) => {
    const members = clusters.filter((cluster) => cluster.dominant.risk === tier);
    if (members.length === 0) return;
    const key = `risk:${tier}`;
    const bySurface = new Map<string, Cluster[]>();
    for (const cluster of members) {
      const surface = cluster.dominant.surface;
      if (surface === null) continue;
      bySurface.set(surface, [...(bySurface.get(surface) ?? []), cluster]);
    }
    const surfaces = [...bySurface.keys()].sort();
    const unfiled = members.filter((cluster) => cluster.dominant.surface === null);
    nodes.push({
      key,
      label: TIER_NAME[tier],
      order: RISK_TIER_ORDER[tier],
      data: {
        kind: "group",
        group: syntheticGroup(key, TIER_NAME[tier], "program", members, tier, surfaces),
      },
      children: [
        ...surfaces.map((surface): LayoutNode<MapDatum> => {
          const inside = bySurface.get(surface)!;
          const surfaceKey = `${key}:${surface}`;
          return {
            key: surfaceKey,
            label: surface,
            data: {
              kind: "group",
              group: syntheticGroup(surfaceKey, surfaceName(surface), "effort", inside, tier, [surface]),
            },
            children: inside.map(clusterNode),
          };
        }),
        ...unfiled.map(clusterNode),
      ],
    });
  });
  return nodes;
}
