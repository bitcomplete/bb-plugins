// Watching a pull request or issue: the durable watch list, what a watch
// remembers about its target, how a fresh read is compared with that memory,
// and the message a thread is woken with. Pure apart from the SQLite store,
// which takes its database handle; nothing here talks to GitHub or to bb.
//
// The doorbell service (hooks-client.ts) only ever says "look again". Every
// decision about whether something changed, and what to tell the thread, is
// made here against the snapshot and cursors a watch carries, so a doorbell
// that is a duplicate, late, or missing altogether changes nothing but when
// the thread hears about it.
import type Database from "better-sqlite3";
import { z } from "zod";
import { kindName, type Target } from "./github.js";

/** How many targets one thread may watch. Enough for a PR and the ones it depends on; not a feed. */
export const WATCH_LIMIT = 10;
/** A watch nobody has woken in this long is forgotten. */
export const WATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How much of a new comment the wake message carries. */
export const WAKE_COMMENT_CHARS = 1000;

/**
 * A thread that comments through `gh` as the developer is asked (SKILL.md)
 * to end the comment with this line. A watch skips comments carrying its
 * own thread's signature: the thread wrote them, so there is nothing to
 * wake it for. Another thread's signature is a real comment.
 */
export const signature = (threadId: string) => `_— from bb thread ${threadId}_`;

// Append-only: bb.storage.migrate records each statement's hash and refuses
// a changed one, so a schema change is a new statement at the end.
export const WATCH_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS watches (
     thread_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     key TEXT NOT NULL,
     kind TEXT NOT NULL,
     snapshot TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     last_comment_at TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_activity_at INTEGER NOT NULL,
     PRIMARY KEY (thread_id, key)
   )`,
  `CREATE INDEX IF NOT EXISTS watches_key ON watches (key)`,
];

// ---- what a watch remembers ---------------------------------------------------

/**
 * The fields a wake message reports on. Strings and string lists only, so a
 * snapshot survives JSON and two of them compare field by field. Pull
 * request fields are null on an issue and never reported there.
 */
export const snapshotSchema = z.object({
  title: z.string().nullable(),
  state: z.string().nullable(),
  assignees: z.array(z.string()),
  labels: z.array(z.string()),
  milestone: z.string().nullable(),
  base: z.string().nullable(),
  head: z.string().nullable(),
  reviewDecision: z.string().nullable(),
  requestedReviewers: z.array(z.string()),
  reviews: z.array(z.string()),
  checks: z.string().nullable(),
  failingChecks: z.array(z.string()),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

const EMPTY_SNAPSHOT: Snapshot = { title: null, state: null, assignees: [], labels: [], milestone: null, base: null, head: null, reviewDecision: null, requestedReviewers: [], reviews: [], checks: null, failingChecks: [] };

export function snapshotOf(target: Target): Snapshot {
  const p = target.pull;
  return {
    title: target.title,
    state: target.state,
    assignees: [...target.assignees].sort(),
    labels: [...target.labels].sort(),
    milestone: target.milestone,
    base: p?.base ?? null,
    // The branch and its tip: a push is a change worth a line, and the
    // short sha says which push.
    head: p === null ? null : p.headSha === null ? p.head : `${p.head ?? "?"} @ ${p.headSha.slice(0, 7)}`,
    reviewDecision: p?.reviewDecision ?? null,
    requestedReviewers: [...(p?.requestedReviewers ?? [])].sort(),
    reviews: [...(p?.reviews ?? [])].sort(),
    checks: p?.checks?.state ?? null,
    failingChecks: [...(p?.checks?.failing ?? [])].sort(),
  };
}

const FIELD_LABELS: Record<keyof Snapshot, string> = {
  title: "Title",
  state: "State",
  assignees: "Assignees",
  labels: "Labels",
  milestone: "Milestone",
  base: "Base",
  head: "Head",
  reviewDecision: "Review decision",
  requestedReviewers: "Review requested from",
  reviews: "Reviews",
  checks: "Checks",
  failingChecks: "Failing checks",
};

export type FieldChange = { field: keyof Snapshot; label: string; from: string; to: string };

const shown = (value: string | string[] | null): string => (value === null ? "(none)" : Array.isArray(value) ? (value.length === 0 ? "(none)" : value.join(", ")) : value);

/** The fields whose value differs, in a fixed order, each with both values written out. */
export function diffSnapshots(before: Snapshot, after: Snapshot): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of Object.keys(FIELD_LABELS) as Array<keyof Snapshot>) {
    const a = before[field];
    const b = after[field];
    const same = Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b;
    if (same) continue;
    changes.push({ field, label: FIELD_LABELS[field], from: shown(a), to: shown(b) });
  }
  return changes;
}

export type NewComment = Target["comments"][number];

/**
 * The comments newer than the cursor that someone other than this thread
 * wrote, oldest first, and the newest createdAt seen (the next cursor). The
 * cursor advances past the thread's own comments too, so they are examined
 * once and never again.
 */
export function newComments(target: Target, lastCommentAt: string, threadId: string): { comments: NewComment[]; cursor: string } {
  const own = signature(threadId);
  let cursor = lastCommentAt;
  const comments: NewComment[] = [];
  for (const c of target.comments) {
    if (c.createdAt <= lastCommentAt) continue;
    if (c.createdAt > cursor) cursor = c.createdAt;
    if (c.body.includes(own)) continue;
    comments.push(c);
  }
  return { comments, cursor };
}

// ---- the wake message ----------------------------------------------------------

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`);

/** One Markdown message for everything that changed since the thread last looked. */
export function formatWake(target: { kind: Target["kind"]; key: string; title: string | null; url: string | null }, changes: FieldChange[], comments: NewComment[]): string {
  const lines: string[] = [];
  lines.push(`GitHub ${kindName(target.kind)} ${target.key} changed: ${target.title ?? "(untitled)"}`);
  if (target.url !== null) lines.push(target.url);
  if (changes.length > 0) {
    lines.push("");
    for (const c of changes) lines.push(`- ${c.label}: ${c.from} → ${c.to}`);
  }
  if (comments.length > 0) {
    lines.push("", comments.length === 1 ? "New comment:" : `New comments (${comments.length}):`);
    for (const c of comments) {
      lines.push("", `**${c.author}** ${c.did} — ${c.createdAt}${c.url === null ? "" : ` (${c.url})`}`);
      const body = clip(c.body.trim(), WAKE_COMMENT_CHARS);
      lines.push(...(body === "" ? ["> (no text)"] : body.split("\n").map((l) => `> ${l}`)));
    }
  }
  return lines.join("\n");
}

// ---- comparing a read with the memory -----------------------------------------

export type WatchRow = {
  threadId: string;
  projectId: string;
  key: string;
  kind: Target["kind"];
  snapshot: Snapshot;
  updatedAt: string;
  lastCommentAt: string;
  createdAt: number;
  lastActivityAt: number;
};

export type CheckOutcome = {
  /** Null when there is nothing to tell the thread; the cursors still move. */
  message: string | null;
  snapshot: Snapshot;
  updatedAt: string;
  lastCommentAt: string;
  kind: Target["kind"];
};

/** What a fresh read of the target means for one watch. Pure: the caller fetches and sends. */
export function compare(watch: WatchRow, target: Target): CheckOutcome {
  const snapshot = snapshotOf(target);
  const changes = diffSnapshots(watch.snapshot, snapshot);
  const { comments, cursor } = newComments(target, watch.lastCommentAt, watch.threadId);
  const message = changes.length === 0 && comments.length === 0 ? null : formatWake(target, changes, comments);
  return { message, snapshot, updatedAt: target.updatedAt ?? watch.updatedAt, lastCommentAt: cursor, kind: target.kind };
}

/** The cursors a brand-new watch starts from: nothing that exists now is news. */
export function initialCursors(target: Target, nowIso: string): { updatedAt: string; lastCommentAt: string } {
  const newest = target.comments.map((c) => c.createdAt).reduce((a, b) => (a > b ? a : b), "");
  return { updatedAt: target.updatedAt ?? nowIso, lastCommentAt: newest !== "" ? newest : (target.createdAt ?? nowIso) };
}

// ---- the store -----------------------------------------------------------------

type Row = {
  thread_id: string;
  project_id: string;
  key: string;
  kind: string;
  snapshot: string;
  updated_at: string;
  last_comment_at: string;
  created_at: number;
  last_activity_at: number;
};

function rowToWatch(row: Row): WatchRow {
  const parsed = snapshotSchema.safeParse(JSON.parse(row.snapshot));
  return {
    threadId: row.thread_id,
    projectId: row.project_id,
    key: row.key,
    kind: row.kind === "pull" ? "pull" : "issue",
    // A snapshot an older build wrote is treated as empty: every field then
    // reads as changed once, which beats refusing to watch at all.
    snapshot: parsed.success ? parsed.data : EMPTY_SNAPSHOT,
    updatedAt: row.updated_at,
    lastCommentAt: row.last_comment_at,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
}

export type AddResult = { outcome: "added" } | { outcome: "already" } | { outcome: "full"; limit: number };

export interface WatchStore {
  add(watch: Omit<WatchRow, "createdAt" | "lastActivityAt">): AddResult;
  all(): WatchRow[];
  forKey(key: string): WatchRow[];
  get(threadId: string, key: string): WatchRow | null;
  /** Every distinct key with at least one watch: what to lease. */
  keys(): string[];
  /** After a check: the new memory, and whether the thread was woken (activity). */
  advance(threadId: string, key: string, outcome: CheckOutcome, woke: boolean): void;
  remove(threadId: string, key: string): void;
  removeThread(threadId: string): number;
  /** Delete watches idle longer than the TTL; returns how many went. */
  expire(): number;
}

export function createWatchStore(db: Database.Database, now: () => number): WatchStore {
  const insert = db.prepare(
    `INSERT INTO watches (thread_id, project_id, key, kind, snapshot, updated_at, last_comment_at, created_at, last_activity_at)
     VALUES (@thread_id, @project_id, @key, @kind, @snapshot, @updated_at, @last_comment_at, @created_at, @last_activity_at)`,
  );
  const countForThread = db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM watches WHERE thread_id = ?");
  const selectOne = db.prepare<[string, string], Row>("SELECT * FROM watches WHERE thread_id = ? AND key = ?");
  const selectAll = db.prepare<[], Row>("SELECT * FROM watches ORDER BY created_at");
  const selectKey = db.prepare<[string], Row>("SELECT * FROM watches WHERE key = ? ORDER BY created_at");
  const selectKeys = db.prepare<[], { key: string }>("SELECT DISTINCT key FROM watches ORDER BY key");
  const touch = db.prepare("UPDATE watches SET last_activity_at = ? WHERE thread_id = ? AND key = ?");
  const update = db.prepare("UPDATE watches SET snapshot = ?, updated_at = ?, last_comment_at = ?, kind = ? WHERE thread_id = ? AND key = ?");
  const updateWoke = db.prepare("UPDATE watches SET snapshot = ?, updated_at = ?, last_comment_at = ?, kind = ?, last_activity_at = ? WHERE thread_id = ? AND key = ?");
  const deleteOne = db.prepare("DELETE FROM watches WHERE thread_id = ? AND key = ?");
  const deleteThread = db.prepare("DELETE FROM watches WHERE thread_id = ?");
  const deleteExpired = db.prepare("DELETE FROM watches WHERE last_activity_at < ?");

  const add = db.transaction((watch: Omit<WatchRow, "createdAt" | "lastActivityAt">): AddResult => {
    if (selectOne.get(watch.threadId, watch.key) !== undefined) {
      // Asking again is a sign the thread still cares; that is activity.
      touch.run(now(), watch.threadId, watch.key);
      return { outcome: "already" };
    }
    if (countForThread.get(watch.threadId)!.n >= WATCH_LIMIT) return { outcome: "full", limit: WATCH_LIMIT };
    insert.run({
      thread_id: watch.threadId,
      project_id: watch.projectId,
      key: watch.key,
      kind: watch.kind,
      snapshot: JSON.stringify(watch.snapshot),
      updated_at: watch.updatedAt,
      last_comment_at: watch.lastCommentAt,
      created_at: now(),
      last_activity_at: now(),
    });
    return { outcome: "added" };
  });

  return {
    add: (watch) => add(watch),
    all: () => selectAll.all().map(rowToWatch),
    forKey: (key) => selectKey.all(key).map(rowToWatch),
    get: (threadId, key) => {
      const row = selectOne.get(threadId, key);
      return row === undefined ? null : rowToWatch(row);
    },
    keys: () => selectKeys.all().map((r) => r.key),
    advance: (threadId, key, outcome, woke) => {
      const snapshot = JSON.stringify(outcome.snapshot);
      if (woke) updateWoke.run(snapshot, outcome.updatedAt, outcome.lastCommentAt, outcome.kind, now(), threadId, key);
      else update.run(snapshot, outcome.updatedAt, outcome.lastCommentAt, outcome.kind, threadId, key);
    },
    remove: (threadId, key) => {
      deleteOne.run(threadId, key);
    },
    removeThread: (threadId) => Number(deleteThread.run(threadId).changes),
    expire: () => Number(deleteExpired.run(now() - WATCH_TTL_MS).changes),
  };
}

// ---- coalescing checks ---------------------------------------------------------

/** A doorbell waits this long for the ones behind it: GitHub sends several per push or review. */
export const DOORBELL_DEBOUNCE_MS = 3000;

export interface CheckQueue {
  /** A doorbell: check this key soon, once, however many times this is called meanwhile. */
  ring(key: string): void;
  /** Check these keys now (each still queued behind any check of the same key in flight). */
  sweep(keys: string[]): Promise<void>;
  /** Drop pending doorbells; in-flight checks finish. */
  stop(): void;
}

/**
 * Checks for one key never overlap: a per-key promise chain runs them one
 * after another, so a doorbell during a sweep's check of the same target
 * waits for it rather than racing it to the cursor. Different keys run
 * concurrently.
 */
export function createCheckQueue(run: (key: string) => Promise<void>, options: { debounceMs?: number; onError?: (key: string, error: unknown) => void } = {}): CheckQueue {
  const debounceMs = options.debounceMs ?? DOORBELL_DEBOUNCE_MS;
  const chains = new Map<string, Promise<void>>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  function enqueue(key: string): Promise<void> {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => (stopped ? undefined : run(key)))
      .catch((error: unknown) => options.onError?.(key, error))
      .finally(() => {
        if (chains.get(key) === next) chains.delete(key);
      });
    chains.set(key, next);
    return next;
  }

  return {
    ring(key) {
      if (stopped || pending.has(key)) return;
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key);
          void enqueue(key);
        }, debounceMs),
      );
    },
    sweep(keys) {
      return Promise.all([...new Set(keys)].map(enqueue)).then(() => undefined);
    },
    stop() {
      stopped = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}
