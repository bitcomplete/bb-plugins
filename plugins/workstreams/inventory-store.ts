import { inventoryEntrySchema, type Pr } from "./contract.js";
import type { InventoryEntry, InventoryInspection, InventoryResult, MergeSighting } from "./inventory.js";
import type { RunDb } from "./runstore.js";
import { INVENTORY_LIMIT } from "./inventory.js";
import { prTarget } from "./ghactions.js";
import { UNDATED_STATES, undatedStates, type StateSince, type UndatedState } from "./pr-attention.js";
import { z } from "zod";

export const INVENTORY_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS authored_prs (url TEXT PRIMARY KEY, repo TEXT NOT NULL, entry TEXT NOT NULL, stale INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS authored_pr_metadata (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)`,
];
export const PR_OBSERVATIONS_MIGRATION = `CREATE TABLE IF NOT EXISTS pr_observations (url TEXT PRIMARY KEY, checked_at TEXT, failed_at TEXT)`;
/** Why the last read of a PR failed, kept beside its time until a read succeeds. */
export const PR_OBSERVATION_ERROR_MIGRATION = `ALTER TABLE pr_observations ADD COLUMN error TEXT`;
/** The last successful read of a PR found it merged, closed, or gone from your open PRs; a read that finds it open clears it. */
export const PR_OBSERVATION_CLOSED_MIGRATION = `ALTER TABLE pr_observations ADD COLUMN closed INTEGER NOT NULL DEFAULT 0`;
/** When a read first saw a PR in a state GitHub doesn't date (red checks, a conflict); the row goes when a read sees the state end. */
export const PR_STATE_SINCE_MIGRATION = `CREATE TABLE IF NOT EXISTS pr_state_since (url TEXT NOT NULL, state TEXT NOT NULL, since TEXT NOT NULL, PRIMARY KEY (url, state))`;
/**
 * Append-only: server.ts adds this after standing rules (id 62). When a read saw each PR merge, at GitHub's merge time, with the title and
 * branch that still place it in an effort once it leaves the inventory. The first sighting stays.
 */
export const PR_MERGES_MIGRATION = `CREATE TABLE IF NOT EXISTS pr_merges (url TEXT PRIMARY KEY, merged_at INTEGER NOT NULL, title TEXT NOT NULL, head_ref TEXT)`;
export type PrMerge = { url: string; at: number; title: string; headRefName: string | null };
export type PrObservation = { checkedAt: string | null; failedAt: string | null; error?: string | null };
export type InventoryMeta = { owners: string[]; complete: boolean; lastSuccessAt: string | null; lastAttemptAt: string | null; warnings: string[] };
export const EMPTY_INVENTORY = { owners: [], entries: [], complete: false, lastSuccessAt: null, lastAttemptAt: null, refreshing: false, warnings: [] };
type InventoryDb = RunDb & { transaction(fn: () => void): () => void };
const metaSchema = z.object({ owners: z.array(z.string()).max(50), complete: z.boolean(), lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(), warnings: z.array(z.string()).max(50) });

/**
 * A read that dates nothing, a checkout scan or an ages read GitHub refused, keeps the stored ages while they still describe this
 * head and these requests, so a rate limit never erases a nudge.
 */
function carryAges(previous: Pr | undefined, next: Pr): Pr {
  if (previous === undefined) return next;
  const sameHead = next.headRefOid !== undefined && next.headRefOid === previous.headRefOid;
  return { ...next,
    ...(next.headCommittedAt === undefined && sameHead && previous.headCommittedAt !== undefined ? { headCommittedAt: previous.headCommittedAt } : {}),
    ...(next.reviewRequestedAt === undefined && previous.reviewRequestedAt !== undefined
      ? { reviewRequestedAt: previous.reviewRequestedAt.filter((asked) => next.reviewRequests.includes(asked.reviewer)) } : {}) };
}

/** The read's warning about this PR, else its first warning, which a failure shared by every PR names. */
function failureOf(url: string, warnings: readonly string[], fallback: string): string {
  const target = prTarget(url);
  return (target && warnings.find((warning) => warning.startsWith(`${target.slug} #${target.number}:`))) ?? warnings[0] ?? fallback;
}

export function createInventoryStore(db: InventoryDb, now: () => number = Date.now) {
  const put = db.prepare(`INSERT OR REPLACE INTO authored_prs (url, repo, entry, stale) VALUES (?, ?, ?, ?)`);
  const remove = db.prepare(`DELETE FROM authored_prs WHERE url = ?`);
  // A read-only copy of a database from before pr_state_since dates no undated state.
  const datesStates = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pr_state_since'`).get() !== undefined;
  /** A state starts at the first read that sees it and ends at the first that sees it gone; GitHub's indecision changes neither. */
  const recordStates = (pr: Pr, at: string) => {
    if (!datesStates) return;
    for (const [state, holds] of Object.entries(undatedStates(pr))) {
      if (holds === true) db.prepare(`INSERT OR IGNORE INTO pr_state_since (url, state, since) VALUES (?, ?, ?)`).run(pr.url.toLowerCase(), state, at);
      else if (holds === false) db.prepare(`DELETE FROM pr_state_since WHERE url = ? AND state = ?`).run(pr.url.toLowerCase(), state);
    }
  };
  // A read-only copy of a database from before pr_merges records no merges.
  const keepsMerges = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pr_merges'`).get() !== undefined;
  const recordMerge = (merge: MergeSighting) => {
    const at = Date.parse(merge.at);
    if (keepsMerges && !Number.isNaN(at)) db.prepare(`INSERT OR IGNORE INTO pr_merges (url, merged_at, title, head_ref) VALUES (?, ?, ?, ?)`)
      .run(merge.url.toLowerCase(), at, merge.title, merge.headRefName);
  };
  /** After each write, so a refresh that rewrites a PR keeps its dates and a PR that leaves the inventory takes its dates along. */
  const pruneStates = () => { if (datesStates) db.prepare(`DELETE FROM pr_state_since WHERE url NOT IN (SELECT url FROM authored_prs)`).run(); };
  const writeMeta = (meta: InventoryMeta) => db.prepare(`INSERT OR REPLACE INTO authored_pr_metadata (id, value) VALUES (1, ?)`).run(JSON.stringify(meta));
  // A read-only copy of a database from before these columns keeps failure times without their reasons, and closures as plain reads.
  const column = (name: string) => db.prepare(`SELECT 1 FROM pragma_table_info('pr_observations') WHERE name = ?`).get(name) !== undefined;
  const keepsErrors = column("error"), keepsClosed = column("closed");
  const succeeded = (closed: 0 | 1) => db.prepare(`INSERT INTO pr_observations (url, checked_at, failed_at${keepsClosed ? ", closed" : ""})
    VALUES (?, ?, NULL${keepsClosed ? `, ${closed}` : ""}) ON CONFLICT(url) DO UPDATE SET checked_at = excluded.checked_at, failed_at = NULL` +
    `${keepsErrors ? ", error = NULL" : ""}${keepsClosed ? ", closed = excluded.closed" : ""}`);
  const success = succeeded(0), closure = succeeded(1);
  const failure = keepsErrors ? db.prepare(`INSERT INTO pr_observations (url, checked_at, failed_at, error) VALUES (?, NULL, ?, ?)
    ON CONFLICT(url) DO UPDATE SET failed_at = excluded.failed_at, error = excluded.error`) : db.prepare(`INSERT INTO pr_observations (url, checked_at, failed_at)
    VALUES (?, NULL, ?) ON CONFLICT(url) DO UPDATE SET failed_at = excluded.failed_at`);
  const recordSuccess = (url: string, at: string) => success.run(url.toLowerCase(), at);
  const recordClosed = (url: string, at: string) => closure.run(url.toLowerCase(), at);
  const recordFailure = (url: string, at: string, error: string) => failure.run(url.toLowerCase(), at, ...keepsErrors ? [error.slice(0, 500)] : []);
  function metadata(): InventoryMeta {
    const row = db.prepare(`SELECT value FROM authored_pr_metadata WHERE id = 1`).get() as { value: string } | undefined;
    if (row === undefined) return { owners: [], complete: false, lastSuccessAt: null, lastAttemptAt: null, warnings: [] };
    try {
      const value = metaSchema.safeParse(JSON.parse(row.value));
      if (value.success) return value.data;
    } catch { /* Ignore a corrupt metadata row. */ }
    return { owners: [], complete: false, lastSuccessAt: null, lastAttemptAt: null, warnings: [] };
  }
  function entries(): (InventoryEntry & { stale: boolean })[] {
    return (db.prepare(`SELECT entry, stale FROM authored_prs ORDER BY repo, url`).all() as { entry: string; stale: number }[]).flatMap((row) => {
      try {
        const parsed = inventoryEntrySchema.safeParse(JSON.parse(row.entry));
        return parsed.success && parsed.data.pr.state === "OPEN" ? [{ ...parsed.data, stale: row.stale !== 0 }] : [];
      } catch { return []; }
    });
  }
  const insert = (entry: InventoryEntry, previous: Pr | undefined) =>
    put.run(entry.pr.url.toLowerCase(), entry.repo, JSON.stringify({ ...entry, pr: carryAges(previous, entry.pr) }), 0);
  return {
    read: () => ({ ...metadata(), entries: entries(), refreshing: false }),
    observation(url: string): PrObservation | null {
      const row = db.prepare(`SELECT checked_at, failed_at${keepsErrors ? ", error" : ""} FROM pr_observations WHERE url = ?`).get(url.toLowerCase()) as
        { checked_at: string | null; failed_at: string | null; error?: string | null } | undefined;
      return row === undefined ? null : { checkedAt: row.checked_at, failedAt: row.failed_at, ...keepsErrors ? { error: row.error ?? null } : {} };
    },
    /** The last successful read found this PR merged, closed, or gone from your open PRs. */
    closed(url: string): boolean {
      return keepsClosed && (db.prepare(`SELECT closed FROM pr_observations WHERE url = ?`).get(url.toLowerCase()) as { closed: number } | undefined)?.closed === 1;
    },
    /** PRs a read saw merge at or after `since`, newest first. */
    merges(since = 0): PrMerge[] {
      if (!keepsMerges) return [];
      return db.prepare(`SELECT url, merged_at AS at, title, head_ref AS headRefName FROM pr_merges WHERE merged_at >= ? ORDER BY merged_at DESC, url`).all(since) as PrMerge[];
    },
    lastCheckedAt(): string | null {
      const row = db.prepare(`SELECT MAX(checked_at) AS checked_at FROM pr_observations`).get() as { checked_at: string | null };
      return row.checked_at;
    },
    /** When a read first saw each undated state of each open PR, in epoch ms, by lowercased URL. */
    statesSince(): Map<string, StateSince> {
      const since = new Map<string, StateSince>();
      if (!datesStates) return since;
      for (const row of db.prepare(`SELECT url, state, since FROM pr_state_since`).all() as { url: string; state: UndatedState; since: string }[]) {
        const at = Date.parse(row.since);
        if (UNDATED_STATES.includes(row.state) && !Number.isNaN(at)) since.set(row.url, { ...since.get(row.url), [row.state]: at });
      }
      return since;
    },
    get(url: string): (InventoryEntry & { stale: boolean }) | undefined {
      const row = db.prepare(`SELECT entry, stale FROM authored_prs WHERE url = ?`).get(url.toLowerCase()) as { entry: string; stale: number } | undefined;
      if (row === undefined) return undefined;
      try {
        const parsed = inventoryEntrySchema.safeParse(JSON.parse(row.entry));
        return parsed.success && parsed.data.pr.state === "OPEN" ? { ...parsed.data, stale: row.stale !== 0 } : undefined;
      } catch { return undefined; }
    },
    apply(result: InventoryResult): void {
      const at = new Date(now()).toISOString();
      const previous = metadata();
      const coverage = new Map(result.repositories.map((repo) => [repo.repo.toLowerCase(), repo.complete]));
      db.transaction(() => {
        const stored = new Map(entries().map((entry) => [entry.pr.url.toLowerCase(), entry.pr]));
        db.prepare(`UPDATE authored_prs SET stale = 1`).run();
        for (const entry of entries()) {
          const repo = entry.repo.toLowerCase();
          const scoped = result.owners.includes(repo.split("/")[0]!);
          if (!scoped || coverage.get(repo) === true || (result.discoveryComplete && !coverage.has(repo))) {
            remove.run(entry.pr.url.toLowerCase());
            // Gone from your open PRs, it merged or closed; if it is still listed, its read below says so.
            if (scoped) recordClosed(entry.pr.url, at);
          }
        }
        for (const entry of result.entries) if (entry.pr.state === "OPEN") {
          insert(entry, stored.get(entry.pr.url.toLowerCase()));
          recordSuccess(entry.pr.url, at);
          recordStates(entry.pr, at);
        }
        const retained = entries().sort((a, b) => Number(a.stale) - Number(b.stale) || a.repo.localeCompare(b.repo) || a.pr.number - b.pr.number);
        for (const entry of retained) if (entry.stale) recordFailure(entry.pr.url, at, failureOf(entry.pr.url, result.warnings, "Not in the last authored PR read."));
        const capped = retained.length > INVENTORY_LIMIT;
        for (const entry of retained.slice(INVENTORY_LIMIT)) remove.run(entry.pr.url.toLowerCase());
        pruneStates();
        writeMeta({ owners: result.owners, complete: result.complete && !capped, lastAttemptAt: at,
          lastSuccessAt: result.complete && !capped ? at : previous.lastSuccessAt,
          warnings: capped ? [`Authored PR cache reached its ${INVENTORY_LIMIT} PR limit; older stale entries were omitted.`, ...result.warnings].slice(0, 50) : result.warnings });
      })();
    },
    inspect(result: InventoryInspection): void {
      const at = new Date(now()).toISOString();
      db.transaction(() => {
        const known = new Map(entries().map((entry) => [entry.pr.url.toLowerCase(), entry.pr]));
        for (const url of result.closed) { remove.run(url.toLowerCase()); recordClosed(url, at); }
        for (const merge of result.merged ?? []) recordMerge(merge);
        for (const url of result.failed) {
          db.prepare(`UPDATE authored_prs SET stale = 1 WHERE url = ?`).run(url.toLowerCase());
          recordFailure(url, at, failureOf(url, result.warnings, "GitHub could not read this PR."));
        }
        for (const entry of result.entries) {
          recordSuccess(entry.pr.url, at);
          const previous = known.get(entry.pr.url.toLowerCase());
          if (previous === undefined) continue;
          insert(entry, previous);
          recordStates(entry.pr, at);
        }
        pruneStates();
        if (result.warnings.length > 0) writeMeta({ ...metadata(), complete: false, warnings: result.warnings });
      })();
    },
    /**
     * What a checkout scan saw of PRs: that it read each the inventory doesn't keep, and which merged or closed, which leaves the inventory.
     * It neither rewrites an open authored PR nor marks it read: the inventory's poll and Refresh own that row and its read, and a scan's
     * PR without a review read would erase it.
     */
    observe(prs: readonly Pr[]): void {
      const at = new Date(now()).toISOString();
      const authored = db.prepare(`SELECT 1 FROM authored_prs WHERE url = ?`);
      db.transaction(() => {
        for (const pr of prs) {
          if (pr.state !== "OPEN") recordClosed(pr.url, at);
          else if (authored.get(pr.url.toLowerCase()) === undefined) recordSuccess(pr.url, at);
          if (pr.state === "MERGED" && pr.mergedAt) recordMerge({ url: pr.url, at: pr.mergedAt, title: pr.title, headRefName: pr.headRefName });
          if (pr.state !== "OPEN") remove.run(pr.url.toLowerCase());
        }
        pruneStates();
      })();
    },
  };
}
