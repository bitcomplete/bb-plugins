// The retired Roster's numbering and snapshot tables, and the PR full reads it kept. Nothing reads or writes them now; the migrations
// stay, unchanged and in order, because migrations are append-only.

/** Append-only: server.ts adds these after effort_admin_sync (ids 35-37). */
export const EFFORT_ROSTER_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_roster_numbers (effort_id TEXT NOT NULL, ordinal INTEGER NOT NULL, target TEXT NOT NULL, assigned_at INTEGER NOT NULL, PRIMARY KEY (effort_id, ordinal), UNIQUE (effort_id, target))`,
  `CREATE TABLE IF NOT EXISTS effort_roster_snapshots (id TEXT PRIMARY KEY, effort_id TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS effort_roster_snapshots_effort ON effort_roster_snapshots (effort_id, created_at)`,
];
/** Append-only: server.ts adds this after the roster migrations (id 38). */
export const PR_FACTS_MIGRATION = `CREATE TABLE IF NOT EXISTS pr_facts (pr_url TEXT PRIMARY KEY, full_at INTEGER, failed_at INTEGER, error TEXT, signature TEXT, cheap_at INTEGER, body TEXT)`;
