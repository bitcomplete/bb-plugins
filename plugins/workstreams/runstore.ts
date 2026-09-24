// The run record behind the Board's row actions: one row per agent or direct
// action, a bounded history, and the status each thread signal moves it to.
// Written against the slice of SQLite server.ts already uses, so the tests run
// the real SQL on an in-memory database.
import { applySignal, clip, type Run, type RunMode, type RunStatus, type ThreadSignal } from "./runs.js";

/** Append-only: server.ts adds this to its migration list. */
export const RUNS_MIGRATION = `CREATE TABLE IF NOT EXISTS action_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  action TEXT NOT NULL,
  unit_path TEXT NOT NULL,
  ticket TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  thread_id TEXT,
  mode TEXT,
  started_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  finished_at INTEGER,
  result TEXT,
  error TEXT,
  armed INTEGER NOT NULL DEFAULT 1
)`;

/** Kept: the newest this many runs, and none older than the age limit. */
export const RUN_HISTORY = { max: 200, maxAgeMs: 30 * 24 * 60 * 60 * 1_000 } as const;

export type RunDb = {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

type Row = {
  id: number;
  kind: string;
  action: string;
  unit_path: string;
  ticket: string | null;
  pr_url: string | null;
  pr_number: number | null;
  thread_id: string | null;
  mode: string | null;
  started_at: number;
  status: string;
  finished_at: number | null;
  result: string | null;
  error: string | null;
  armed: number;
};

const STATUS = new Set<string>(["running", "needs-you", "done", "failed", "succeeded"]);
const MODES = new Set<string>(["continue", "subthread", "new"]);

function toRun(row: Row): Run & { armed: boolean } {
  return {
    id: row.id,
    kind: row.kind === "direct" ? "direct" : "agent",
    action: row.action,
    path: row.unit_path,
    ticket: row.ticket,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    threadId: row.thread_id,
    mode: row.mode !== null && MODES.has(row.mode) ? (row.mode as RunMode) : null,
    startedAt: row.started_at,
    // Stored values are untrusted; an unknown status reads as failed, never as running forever.
    status: STATUS.has(row.status) ? (row.status as RunStatus) : "failed",
    finishedAt: row.finished_at,
    result: row.result,
    error: row.error,
    armed: row.armed !== 0,
  };
}

export type RunTarget = { path: string; ticket: string | null; prUrl: string | null; prNumber: number | null };

export type RunStore = ReturnType<typeof createRunStore>;

export function createRunStore(db: RunDb, now: () => number = Date.now) {
  const insert = (fields: Omit<Row, "id">): number => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO action_runs (kind, action, unit_path, ticket, pr_url, pr_number, thread_id, mode, started_at, status, finished_at, result, error, armed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fields.kind, fields.action, fields.unit_path, fields.ticket, fields.pr_url, fields.pr_number, fields.thread_id,
          fields.mode, fields.started_at, fields.status, fields.finished_at, fields.result, fields.error, fields.armed,
        ).lastInsertRowid,
    );
    prune();
    return id;
  };

  /** Pruned on every write: the newest `max` runs, none past the age limit. Open runs are kept regardless. */
  function prune(): void {
    db.prepare(
      `DELETE FROM action_runs WHERE status NOT IN ('running', 'needs-you')
         AND (started_at < ? OR id NOT IN (SELECT id FROM action_runs ORDER BY started_at DESC, id DESC LIMIT ?))`,
    ).run(now() - RUN_HISTORY.maxAgeMs, RUN_HISTORY.max);
  }

  function openIn(threadId: string): (Run & { armed: boolean })[] {
    return (
      db
        .prepare(`SELECT * FROM action_runs WHERE thread_id = ? AND status IN ('running', 'needs-you') ORDER BY id`)
        .all(threadId) as Row[]
    ).map(toRun);
  }

  function get(id: number): (Run & { armed: boolean }) | null {
    const row = db.prepare(`SELECT * FROM action_runs WHERE id = ?`).get(id) as Row | undefined;
    return row === undefined ? null : toRun(row);
  }

  return {
    /**
     * Record an agent run as it launches. A `continue` run is recorded BEFORE
     * its message is sent, with the thread id, so the turn it starts cannot
     * fire before the run exists; it is unarmed until that turn is seen.
     */
    begin(args: RunTarget & { action: string; mode: RunMode; threadId: string | null }): number {
      return insert({
        kind: "agent",
        action: args.action,
        unit_path: args.path,
        ticket: args.ticket,
        pr_url: args.prUrl,
        pr_number: args.prNumber,
        thread_id: args.threadId,
        mode: args.mode,
        started_at: now(),
        status: "running",
        finished_at: null,
        result: null,
        error: null,
        armed: args.mode === "continue" ? 0 : 1,
      });
    },
    /** The launch succeeded: bind the run to its thread. */
    attach(id: number, threadId: string): void {
      db.prepare(`UPDATE action_runs SET thread_id = ? WHERE id = ?`).run(threadId, id);
    },
    /** The launch failed: nothing ran, so there is no run to report. */
    discard(id: number): void {
      db.prepare(`DELETE FROM action_runs WHERE id = ?`).run(id);
    },
    /** A direct action, recorded once with its final outcome. */
    recordDirect(args: RunTarget & { action: string; ok: boolean; text: string; startedAt: number }): Run {
      const id = insert({
        kind: "direct",
        action: args.action,
        unit_path: args.path,
        ticket: args.ticket,
        pr_url: args.prUrl,
        pr_number: args.prNumber,
        thread_id: null,
        mode: null,
        started_at: args.startedAt,
        status: args.ok ? "succeeded" : "failed",
        finished_at: now(),
        result: args.ok ? clip(args.text) : null,
        error: args.ok ? null : clip(args.text),
        armed: 1,
      });
      return get(id)!;
    },
    /** Open runs in this thread, oldest first. */
    openIn,
    /** Every open agent run's thread, for the post-scan reconcile. */
    openThreadIds(): string[] {
      return (
        db
          .prepare(`SELECT DISTINCT thread_id FROM action_runs WHERE thread_id IS NOT NULL AND status IN ('running', 'needs-you')`)
          .all() as { thread_id: string }[]
      ).map((row) => row.thread_id);
    },
    /**
     * Apply one thread signal to every open run in that thread. `readText` is
     * called at most once, only when a run finishes and the signal carried no text.
     * Returns the runs that changed.
     */
    async signal(threadId: string, signal: ThreadSignal, readText: () => Promise<string | null>): Promise<Run[]> {
      const at = now();
      const changed: Run[] = [];
      let text: string | null | undefined;
      for (const run of openIn(threadId)) {
        let effective = signal;
        if ((signal.kind === "idle" || signal.kind === "failed") && signal.text === null && run.armed && at >= run.startedAt) {
          if (text === undefined) text = await readText().catch(() => null);
          effective = { ...signal, text };
        }
        const patch = applySignal(run, effective, at);
        if (patch === null) continue;
        db.prepare(
          `UPDATE action_runs SET status = ?, armed = ?, finished_at = ?, result = ?, error = ? WHERE id = ? AND status IN ('running', 'needs-you')`,
        ).run(patch.status, patch.armed ? 1 : 0, patch.finishedAt, patch.result, patch.error, run.id);
        const next = get(run.id);
        if (next !== null) changed.push(next);
      }
      return changed;
    },
    /** Open runs, and everything started since `since`, newest first. */
    recent(since: number, limit = 100): Run[] {
      return (
        db
          .prepare(
            `SELECT * FROM action_runs WHERE status IN ('running', 'needs-you') OR started_at >= ? OR finished_at >= ?
             ORDER BY started_at DESC, id DESC LIMIT ?`,
          )
          .all(since, since, limit) as Row[]
      ).map(toRun).map(({ armed: _armed, ...run }) => run);
    },
  };
}
