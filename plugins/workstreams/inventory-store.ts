import { inventoryEntrySchema, type Pr } from "./contract.js";
import type { InventoryEntry, InventoryInspection, InventoryResult } from "./inventory.js";
import type { RunDb } from "./runstore.js";
import { INVENTORY_LIMIT } from "./inventory.js";
import { z } from "zod";

export const INVENTORY_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS authored_prs (url TEXT PRIMARY KEY, repo TEXT NOT NULL, entry TEXT NOT NULL, stale INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS authored_pr_metadata (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)`,
];
export type InventoryMeta = { owners: string[]; complete: boolean; lastSuccessAt: string | null; lastAttemptAt: string | null; warnings: string[] };
export const EMPTY_INVENTORY = { owners: [], entries: [], complete: false, lastSuccessAt: null, lastAttemptAt: null, refreshing: false, warnings: [] };
type InventoryDb = RunDb & { transaction(fn: () => void): () => void };
const metaSchema = z.object({ owners: z.array(z.string()).max(50), complete: z.boolean(), lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(), warnings: z.array(z.string()).max(50) });

export function createInventoryStore(db: InventoryDb, now: () => number = Date.now) {
  const put = db.prepare(`INSERT OR REPLACE INTO authored_prs (url, repo, entry, stale) VALUES (?, ?, ?, ?)`);
  const remove = db.prepare(`DELETE FROM authored_prs WHERE url = ?`);
  const writeMeta = (meta: InventoryMeta) => db.prepare(`INSERT OR REPLACE INTO authored_pr_metadata (id, value) VALUES (1, ?)`).run(JSON.stringify(meta));
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
  const insert = (entry: InventoryEntry) => put.run(entry.pr.url.toLowerCase(), entry.repo, JSON.stringify(entry), 0);
  return {
    read: () => ({ ...metadata(), entries: entries(), refreshing: false }),
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
        db.prepare(`UPDATE authored_prs SET stale = 1`).run();
        for (const entry of entries()) {
          const repo = entry.repo.toLowerCase();
          if (!result.owners.includes(repo.split("/")[0]!) || coverage.get(repo) === true ||
              (result.discoveryComplete && !coverage.has(repo))) remove.run(entry.pr.url.toLowerCase());
        }
        for (const entry of result.entries) if (entry.pr.state === "OPEN") insert(entry);
        const retained = entries().sort((a, b) => Number(a.stale) - Number(b.stale) || a.repo.localeCompare(b.repo) || a.pr.number - b.pr.number);
        const capped = retained.length > INVENTORY_LIMIT;
        for (const entry of retained.slice(INVENTORY_LIMIT)) remove.run(entry.pr.url.toLowerCase());
        writeMeta({ owners: result.owners, complete: result.complete && !capped, lastAttemptAt: at,
          lastSuccessAt: result.complete && !capped ? at : previous.lastSuccessAt,
          warnings: capped ? [`Authored PR cache reached its ${INVENTORY_LIMIT} PR limit; older stale entries were omitted.`, ...result.warnings].slice(0, 50) : result.warnings });
      })();
    },
    inspect(result: InventoryInspection): void {
      db.transaction(() => {
        const known = new Set(entries().map((entry) => entry.pr.url.toLowerCase()));
        for (const url of result.closed) remove.run(url.toLowerCase());
        for (const url of result.failed) db.prepare(`UPDATE authored_prs SET stale = 1 WHERE url = ?`).run(url.toLowerCase());
        for (const entry of result.entries) if (known.has(entry.pr.url.toLowerCase())) insert(entry);
        if (result.warnings.length > 0) writeMeta({ ...metadata(), complete: false, warnings: result.warnings });
      })();
    },
    /** Checkout scans also refresh already-discovered authored PRs. */
    observe(prs: readonly Pr[]): void {
      const known = new Map(entries().map((entry) => [entry.pr.url.toLowerCase(), entry]));
      db.transaction(() => {
        for (const pr of prs) {
          const entry = known.get(pr.url.toLowerCase());
          if (entry === undefined) continue;
          if (pr.state !== "OPEN") remove.run(pr.url.toLowerCase());
          else insert({ repo: entry.repo, pr });
        }
      })();
    },
  };
}
