import type { Row } from "./types.js";

export function groupByArea(items: readonly Row[]) {
  const groups = new Map<string, { items: Row[]; labels: string[]; latest: number }>();
  for (const item of items) {
    const scope = item.title.match(/\b[a-z]+\(([^()]+)\)!?:/i)?.[1]?.trim();
    const token = scope?.toLowerCase().split(/[-_/\s]+/).find(Boolean) ?? "";
    const normalized = /[^s]s$/.test(token) ? token.slice(0, -1) : token;
    const key = scope ? `scope:${normalized || scope.toLowerCase()}` : `repo:${item.repo.toLowerCase()}`;
    const group = groups.get(key) ?? { items: [], labels: [], latest: 0 };
    group.items.push(item);
    group.labels.push(scope || item.repo.split("/").pop() || item.repo);
    group.latest = Math.max(group.latest, Date.parse(item.updatedAt));
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => {
    const counts = new Map<string, number>();
    for (const label of group.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    const label = [...counts].sort(([a, x], [b, y]) => y - x || a.length - b.length || a.localeCompare(b))[0]?.[0] ?? key;
    return {
      key, label, latest: group.latest,
      repos: [...new Set(group.items.map((item) => item.repo.split("/").pop() || item.repo))].sort(),
      items: [...group.items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    };
  }).sort((a, b) => b.items.length - a.items.length || b.latest - a.latest || a.key.localeCompare(b.key));
}

/** Keep title scopes within their GitHub owner, with owners in alphabetical order. */
export function groupByOrganization(items: readonly Row[]) {
  const groups = new Map<string, Row[]>();
  for (const item of items) {
    const organization = (item.repo.split("/")[0] || item.repo).toLowerCase();
    const group = groups.get(organization) ?? [];
    group.push(item);
    groups.set(organization, group);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([label, rows]) => ({
    label, items: rows, areas: groupByArea(rows),
  }));
}
