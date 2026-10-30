// Groups the queue by product area, client-side, from what a row already
// carries. The conventional-commit scope in a title names the area; areas cross
// repos on purpose, so catalog work in two repos reads as one group.
import type { QueueItem } from "./types.js";

export interface AreaGroup {
  /** `scope:<normalized>` or, for unscoped titles, `repo:<owner/name>`. */
  key: string;
  /** The scope as most items wrote it, or the repo's short name. */
  label: string;
  /** Distinct repo short names the group spans, alphabetical. */
  repos: string[];
  /** Most recently updated first. */
  items: QueueItem[];
}

// `type(scope):` or `type(scope)!:` anywhere in the title, so a ticket prefix
// such as "ABC-3774: fix(purchases): …" still finds the scope.
const SCOPE = /\b[a-z]+\(([^()]+)\)!?:/i;

/** The conventional-commit scope as written, or null when the title has none. */
export function titleScope(title: string): string | null {
  const scope = title.match(SCOPE)?.[1]?.trim();
  return scope ? scope : null;
}

/**
 * The key near-identical scopes share: lowercase, the first token split on
 * `-`, `_`, `/`, or space, and a trailing plural `s` dropped (but not `ss`),
 * so `tags` and `tag-review` both key to `tag`.
 */
export function scopeKey(scope: string): string {
  const token = scope.toLowerCase().split(/[-_/\s]+/).find(Boolean) ?? "";
  return /[^s]s$/.test(token) ? token.slice(0, -1) : token;
}

const repoName = (repo: string): string => repo.split("/").pop() ?? repo;
const updated = (item: QueueItem): number => Date.parse(item.updatedAt);

/**
 * Unscoped titles fall back to their repo, keyed apart from scopes: an
 * unscoped hiringloop PR never joins a `feat(hiringloop)` group from another
 * repo just because the words match. Groups run largest first, then most
 * recently updated.
 */
export function groupByArea(items: readonly QueueItem[]): AreaGroup[] {
  const groups = new Map<string, { items: QueueItem[]; labels: string[] }>();
  for (const item of items) {
    const scope = titleScope(item.title);
    const key = scope === null ? `repo:${item.repo.toLowerCase()}` : `scope:${scopeKey(scope)}`;
    const group = groups.get(key) ?? { items: [], labels: [] };
    group.items.push(item);
    group.labels.push(scope ?? repoName(item.repo));
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({
    key,
    label: mostCommon(group.labels),
    repos: [...new Set(group.items.map((item) => repoName(item.repo)))].sort(),
    items: [...group.items].sort((a, b) => updated(b) - updated(a)),
  })).sort((a, b) =>
    b.items.length - a.items.length ||
    updated(b.items[0]!) - updated(a.items[0]!) ||
    a.key.localeCompare(b.key));
}

/** The most frequent label; ties go to the shortest, then alphabetical. */
function mostCommon(labels: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || a.length - b.length || a.localeCompare(b))[0]![0];
}

/** Keep title scopes within their GitHub owner, with owners in alphabetical order. */
export function groupByOrganization(items: readonly QueueItem[]) {
  const groups = new Map<string, QueueItem[]>();
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
