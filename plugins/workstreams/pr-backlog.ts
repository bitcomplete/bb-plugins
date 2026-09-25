import type { Pr } from "./contract.js";
import type { Row } from "./inbox.js";
import type { AttentionRow } from "./workstream-attention.js";
import type { RowGroup } from "./inbox-grouping.js";
import { primaryAction, type PrimaryAction } from "./actions.js";
import { displayTitle, inboxSection, inboxVerb, prLifecycle, unitLifecycle, type InboxSection, type Lifecycle } from "./workstreams.js";

export const BACKLOG_GROUPS = ["ready", "approved", "respond", "waiting", "draft", "unknown"] as const;
export type BacklogGroup = (typeof BACKLOG_GROUPS)[number];
export const BACKLOG_LABEL: Record<BacklogGroup, string> = {
  ready: "Ready to merge", approved: "Approved · next steps", respond: "Fix or respond",
  waiting: "Waiting for review or another PR", draft: "Drafts and work in progress", unknown: "Status to verify",
};
export type BacklogEntry = { repo: string; pr: Pr; stale: boolean; effortKey?: string; effortName?: string };
export type BacklogRow = BacklogEntry & {
  group: BacklogGroup; lifecycle: Lifecycle; section: InboxSection; verb: string; action: PrimaryAction | null; local: Row | null;
  parent: { repo: string; pr: Pr } | null;
};
const urlKey = (url: string) => url.replace(/\/$/u, "").toLowerCase();

/** Inventory owns membership and remote facts; a real checkout only adds local context. */
export function prBacklog(entries: readonly BacklogEntry[], locals: readonly Row[], now: number): BacklogRow[] {
  const unique = new Map<string, BacklogEntry>();
  for (const entry of entries) {
    if (entry.pr.state !== "OPEN") continue;
    const key = urlKey(entry.pr.url);
    if (!unique.has(key) || unique.get(key)!.stale && !entry.stale) unique.set(key, entry);
  }
  const localByUrl = new Map<string, Row>();
  // A rebase in any checkout must not disappear behind a second clean checkout.
  for (const row of [...locals].sort((a, b) => Number(b.unit.rebasing === true) - Number(a.unit.rebasing === true) || a.key.localeCompare(b.key))) {
    if (row.unit.pr !== null && !localByUrl.has(urlKey(row.unit.pr.url))) localByUrl.set(urlKey(row.unit.pr.url), row);
  }
  const result = [...unique.values()].map((entry): BacklogRow => {
    const { pr } = entry;
    const original = localByUrl.get(urlKey(pr.url)) ?? null;
    const parent = pr.baseRefName === null ? null : [...unique.values()].find((candidate) =>
      candidate.repo.toLowerCase() === entry.repo.toLowerCase() && candidate.pr.number !== pr.number && candidate.pr.headRefName === pr.baseRefName,
    ) ?? null;
    const lifecycle = original === null ? prLifecycle(pr) : unitLifecycle({ ...original.unit, pr });
    const stack = parent === null ? original?.unit.stack ?? null : { blockedBelow: parent.pr.number };
    const facts = { ticket: original?.unit.ticket ?? null, pr, lifecycle, stack, rebasing: original?.unit.rebasing };
    const section = inboxSection(facts, now);
    const currentVerb = inboxVerb(facts, section) ?? "In progress";
    // Approval still stands while CI runs; nudging a reviewer cannot clear CI.
    const verb = entry.stale ? "Refresh to verify" : pr.reviewDecision === "APPROVED" && currentVerb === "In review" ? "Checks pending" : currentVerb;
    const action = entry.stale ? null : primaryAction(facts, section, verb);
    const local = original === null ? null : {
      ...original, unit: { ...original.unit, pr, lifecycle, stack: parent === null ? original.unit.stack : { ...original.unit.stack, id: original.unit.stack?.id ?? parent.pr.url, blockedBelow: parent.pr.number, size: original.unit.stack?.size ?? 2, position: original.unit.stack?.position ?? 2 } },
      title: displayTitle(pr.title), section, verb, action,
    };
    const group: BacklogGroup = entry.stale || lifecycle === "unverified" ? "unknown"
      : pr.isDraft || original?.unit.rebasing ? "draft"
      : stack?.blockedBelow != null ? "waiting"
      : verb === "Ready to merge" ? "ready"
      : pr.reviewDecision === "APPROVED" ? "approved"
      : section === "fix" || section === "respond" ? "respond" : "waiting";
    return { ...entry, group, lifecycle, section, verb, action, local, parent };
  });
  return result.sort((a, b) => BACKLOG_GROUPS.indexOf(a.group) - BACKLOG_GROUPS.indexOf(b.group) ||
    a.repo.localeCompare(b.repo) || a.pr.number - b.pr.number);
}

export function backlogMatches(row: BacklogRow, query: string): boolean {
  const haystack = `${row.repo} #${row.pr.number} ${row.pr.title} ${row.local?.effort ?? row.effortName ?? ""} ${row.verb}`.toLowerCase();
  return query.trim().toLowerCase().split(/\s+/u).every((part) => haystack.includes(part));
}

/** Server-confirmed associations give remote PRs a home without inventing checkouts. */
export function remotePrsByEffort(rows: readonly BacklogRow[], query: string): Map<string, BacklogRow[]> {
  const groups = new Map<string, BacklogRow[]>();
  for (const row of rows) {
    if (row.local !== null || row.effortKey === undefined || !backlogMatches(row, query)) continue;
    const members = groups.get(row.effortKey) ?? [];
    members.push(row);
    groups.set(row.effortKey, members);
  }
  return groups;
}

/** A matching remote sibling keeps its effort visible when no checkout matches the search. */
export function includeRemoteEfforts(groups: readonly RowGroup[], remote: ReadonlyMap<string, readonly BacklogRow[]>): RowGroup[] {
  const result = [...groups];
  for (const [key, rows] of remote) {
    if (!result.some((group) => group.key === key)) result.push({ key, label: rows[0]?.effortName ?? key, rows: [], section: null });
  }
  return result;
}

/** Add server-associated remote siblings to the same attention counts as checkout rows. */
export function remoteAttentionRows(rows: readonly BacklogRow[]): AttentionRow[] {
  return rows.flatMap((row) => row.local !== null || row.effortKey === undefined ? [] : [{
    effortKey: row.effortKey, effort: row.effortName ?? row.effortKey,
    section: row.stale ? "waiting" : row.section, verb: row.verb,
    unit: { ticket: null, pr: row.pr, lifecycle: row.stale ? "unverified" : row.lifecycle },
  }]);
}
