import { canonicalPrUrl, prHoldSchema, type PrHold, type PrHolds } from "./pr-holds.js";
import type { RunDb } from "./runstore.js";

export const PR_HOLD_MIGRATIONS = [
  "CREATE TABLE IF NOT EXISTS pr_holds (pr_url TEXT PRIMARY KEY, reason TEXT NOT NULL, held_at INTEGER NOT NULL)",
];

export function createPrHoldStore(db: RunDb, now: () => number = Date.now) {
  function get(prUrl: string): PrHold | null {
    const key = canonicalPrUrl(prUrl);
    if (key === null) return null;
    const row = db.prepare("SELECT reason, held_at AS heldAt FROM pr_holds WHERE pr_url = ?").get(key);
    return row === undefined ? null : prHoldSchema.parse(row);
  }
  function list(): PrHolds {
    const rows = db.prepare("SELECT pr_url, reason, held_at AS heldAt FROM pr_holds").all() as (PrHold & { pr_url: string })[];
    return Object.fromEntries(rows.map((row) => [row.pr_url, prHoldSchema.parse(row)]));
  }
  return {
    get, list,
    set(prUrl: string, held: boolean, reason = ""): PrHolds {
      const key = canonicalPrUrl(prUrl);
      if (key === null) throw new Error("Choose a valid GitHub PR URL");
      if (held) {
        const hold = prHoldSchema.parse({ reason: reason.trim(), heldAt: get(key)?.heldAt ?? now() });
        db.prepare("INSERT OR REPLACE INTO pr_holds (pr_url, reason, held_at) VALUES (?, ?, ?)").run(key, hold.reason, hold.heldAt);
      } else db.prepare("DELETE FROM pr_holds WHERE pr_url = ?").run(key);
      return list();
    },
  };
}
