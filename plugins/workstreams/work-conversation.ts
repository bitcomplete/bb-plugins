/** The retired Pipeline conversations' table. Nothing reads or writes it now; the migration stays because migrations are append-only. */
export const WORK_CONVERSATION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS work_conversations (id TEXT PRIMARY KEY, scope_key TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, body TEXT NOT NULL)`,
];
