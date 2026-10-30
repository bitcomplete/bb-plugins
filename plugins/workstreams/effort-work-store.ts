// The retired Effort-v2 execution tables: modes, targets, instructions, PR rows, transitions, decisions, and attempts. Nothing reads or
// writes them now; the migrations stay, unchanged and in order, because migrations are append-only.

/** Append-only: server.ts adds these after pr_facts (ids 39-41). */
export const EFFORT_EXECUTION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_execution (effort_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('legacy','v2')), revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS effort_v2_targets (target TEXT PRIMARY KEY, effort_id TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('pr','ticket')), resolved_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS effort_v2_targets_effort ON effort_v2_targets (effort_id)`,
];

/** Append-only: server.ts adds these after the execution migrations (ids 42-46). */
export const EFFORT_INSTRUCTION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_instructions (id TEXT PRIMARY KEY, effort_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','superseded','completed','cancelled')), request_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (effort_id, revision))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS effort_instructions_active ON effort_instructions (effort_id) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS effort_pr_work (target TEXT PRIMARY KEY, effort_id TEXT NOT NULL, instruction_id TEXT NOT NULL, phase TEXT NOT NULL, revision INTEGER NOT NULL, due_at INTEGER, body TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS effort_pr_work_effort ON effort_pr_work (effort_id, phase)`,
  `CREATE TABLE IF NOT EXISTS effort_transitions (seq INTEGER PRIMARY KEY AUTOINCREMENT, effort_id TEXT NOT NULL, target TEXT, row_revision INTEGER, at INTEGER NOT NULL, from_phase TEXT, to_phase TEXT, cause TEXT NOT NULL, detail TEXT NOT NULL, attempt_id TEXT, source TEXT NOT NULL, observed_at INTEGER, UNIQUE (target, row_revision))`,
];

/** Append-only: server.ts adds these after the instruction migrations (ids 47-48). */
export const EFFORT_DECISION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_decisions (id TEXT PRIMARY KEY, effort_id TEXT NOT NULL, ordinal INTEGER NOT NULL, dedupe_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','answered','withdrawn')), body TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER, UNIQUE (effort_id, ordinal))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS effort_decisions_open ON effort_decisions (effort_id, dedupe_key) WHERE status = 'open'`,
];

/** Append-only: server.ts adds these after the decision migrations (ids 49-53). */
export const EFFORT_ATTEMPT_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_attempts (id TEXT PRIMARY KEY, target TEXT NOT NULL, effort_id TEXT NOT NULL, instruction_id TEXT NOT NULL, launch_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK (status IN ('launching','running','uncertain','completed','failed','released')), thread_id TEXT, host_id TEXT, checkout_path TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS effort_attempts_pr_writer ON effort_attempts (target) WHERE status IN ('launching','running','uncertain')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS effort_attempts_checkout_writer ON effort_attempts (host_id, checkout_path) WHERE status IN ('launching','running','uncertain') AND checkout_path IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS effort_attempts_thread_writer ON effort_attempts (thread_id) WHERE status IN ('launching','running','uncertain') AND thread_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS effort_attempts_target ON effort_attempts (target, created_at)`,
];

/** Append-only: server.ts adds this after the attempt migrations (id 54). Each row transition keeps the head its row was observed on. */
export const EFFORT_JOURNAL_MIGRATIONS = [`ALTER TABLE effort_transitions ADD COLUMN head TEXT`];
