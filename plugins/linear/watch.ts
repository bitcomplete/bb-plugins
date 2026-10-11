// Watching an issue: the durable watch list, what a watch remembers about
// its issue, how a fresh read is compared with that memory, and the message
// a thread is woken with. Pure apart from the SQLite store, which takes its
// database handle; nothing here talks to Linear or to bb.
//
// The doorbell service (hooks-client.ts) only ever says "look again". Every
// decision about whether something changed, and what to tell the thread, is
// made here against the snapshot and cursors a watch carries, so a doorbell
// that is a duplicate, late, or missing altogether changes nothing but when
// the thread hears about it.
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { PRIORITY_NAMES, type Issue } from "./linear.js";

/** How many issues one thread may watch. Enough for a ticket and its sub-issues; not a feed. */
export const WATCH_LIMIT = 10;
/** A watch nobody has woken in this long is forgotten. */
export const WATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How much of a new comment the wake message carries. */
export const WAKE_COMMENT_CHARS = 1000;

/**
 * Comments and issues a thread writes are signed with its id (server.ts adds
 * this to every comment and description). A watch skips comments carrying
 * its own thread's signature: the thread wrote them, so there is nothing to
 * wake it for. Another thread's signature is a real comment.
 */
export const signature = (threadId: string) => `\n\n_— from bb thread ${threadId}_`;

// Append-only: bb.storage.migrate records each statement's hash and refuses
// a changed one, so a schema change is a new statement at the end.
export const WATCH_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS watches (
     thread_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     issue_id TEXT NOT NULL,
     issue_key TEXT NOT NULL,
     snapshot TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     last_comment_at TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_activity_at INTEGER NOT NULL,
     PRIMARY KEY (thread_id, issue_id)
   )`,
  `CREATE INDEX IF NOT EXISTS watches_issue ON watches (issue_id)`,
];

// ---- what a watch remembers ---------------------------------------------------

/**
 * The fields a wake message reports on. Strings and string lists only, so a
 * snapshot survives JSON and two of them compare field by field. The
 * description is kept as a hash: an edit is worth a line, a diff is not.
 */
export const snapshotSchema = z.object({
  title: z.string().nullable(),
  state: z.string().nullable(),
  assignee: z.string().nullable(),
  priority: z.string().nullable(),
  labels: z.array(z.string()),
  project: z.string().nullable(),
  cycle: z.string().nullable(),
  parent: z.string().nullable(),
  dueDate: z.string().nullable(),
  estimate: z.string().nullable(),
  descriptionHash: z.string().nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

const personName = (p: Issue["assignee"]) => p?.displayName ?? p?.name ?? p?.email ?? null;

export function snapshotOf(issue: Issue): Snapshot {
  const priority = issue.priority === null || issue.priority === undefined ? null : issue.priorityLabel ?? PRIORITY_NAMES[issue.priority] ?? String(issue.priority);
  return {
    title: issue.title ?? null,
    state: issue.state?.name ?? null,
    assignee: personName(issue.assignee),
    priority,
    labels: [...(issue.labels?.nodes ?? [])].map((l) => l.name).sort(),
    project: issue.project?.name ?? null,
    cycle: issue.cycle ? `${issue.cycle.number}${issue.cycle.name ? ` (${issue.cycle.name})` : ""}` : null,
    parent: issue.parent?.identifier ?? null,
    dueDate: issue.dueDate ?? null,
    estimate: issue.estimate === null || issue.estimate === undefined ? null : String(issue.estimate),
    descriptionHash: issue.description === null || issue.description === undefined ? null : createHash("sha256").update(issue.description).digest("hex").slice(0, 16),
  };
}

const FIELD_LABELS: Record<keyof Snapshot, string> = {
  title: "Title",
  state: "State",
  assignee: "Assignee",
  priority: "Priority",
  labels: "Labels",
  project: "Project",
  cycle: "Cycle",
  parent: "Parent",
  dueDate: "Due",
  estimate: "Estimate",
  descriptionHash: "Description",
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
    // The hash means nothing to a reader; say that the text changed.
    if (field === "descriptionHash") changes.push({ field, label: FIELD_LABELS[field], from: "", to: "edited" });
    else changes.push({ field, label: FIELD_LABELS[field], from: shown(a), to: shown(b) });
  }
  return changes;
}

export type NewComment = { author: string; body: string; createdAt: string; url: string | null };

/**
 * The comments newer than the cursor that someone other than this thread
 * wrote, oldest first, and the newest createdAt seen (the next cursor). The
 * cursor advances past the thread's own comments too, so they are examined
 * once and never again.
 */
export function newComments(issue: Issue, lastCommentAt: string, threadId: string): { comments: NewComment[]; cursor: string } {
  const own = signature(threadId);
  const all = [...(issue.comments?.nodes ?? [])].filter((c) => typeof c.createdAt === "string").sort((a, b) => a.createdAt!.localeCompare(b.createdAt!));
  let cursor = lastCommentAt;
  const comments: NewComment[] = [];
  for (const c of all) {
    const at = c.createdAt!;
    if (at <= lastCommentAt) continue;
    if (at > cursor) cursor = at;
    if ((c.body ?? "").includes(own)) continue;
    comments.push({ author: personName(c.user) ?? "someone", body: c.body ?? "", createdAt: at, url: c.url ?? null });
  }
  return { comments, cursor };
}

// ---- the wake message ----------------------------------------------------------

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`);

/** One Markdown message for everything that changed since the thread last looked. */
export function formatWake(issue: { identifier: string; title: string | null; url: string | null }, changes: FieldChange[], comments: NewComment[]): string {
  const lines: string[] = [];
  lines.push(`Linear issue ${issue.identifier} changed: ${issue.title ?? "(untitled)"}`);
  if (issue.url !== null) lines.push(issue.url);
  if (changes.length > 0) {
    lines.push("");
    for (const c of changes) lines.push(c.from === "" ? `- ${c.label}: ${c.to}` : `- ${c.label}: ${c.from} → ${c.to}`);
  }
  if (comments.length > 0) {
    lines.push("", comments.length === 1 ? "New comment:" : `New comments (${comments.length}):`);
    for (const c of comments) {
      lines.push("", `**${c.author}** — ${c.createdAt}${c.url === null ? "" : ` (${c.url})`}`);
      const body = clip(c.body.trim(), WAKE_COMMENT_CHARS);
      lines.push(...(body === "" ? ["> (empty)"] : body.split("\n").map((l) => `> ${l}`)));
    }
  }
  return lines.join("\n");
}

// ---- comparing a read with the memory -----------------------------------------

export type WatchRow = {
  threadId: string;
  projectId: string;
  issueId: string;
  issueKey: string;
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
  issueKey: string;
};

/** What a fresh read of the issue means for one watch. Pure: the caller fetches and sends. */
export function compare(watch: WatchRow, issue: Issue): CheckOutcome {
  const snapshot = snapshotOf(issue);
  const changes = diffSnapshots(watch.snapshot, snapshot);
  const { comments, cursor } = newComments(issue, watch.lastCommentAt, watch.threadId);
  const message = changes.length === 0 && comments.length === 0 ? null : formatWake({ identifier: issue.identifier, title: issue.title ?? null, url: issue.url ?? null }, changes, comments);
  return { message, snapshot, updatedAt: issue.updatedAt ?? watch.updatedAt, lastCommentAt: cursor, issueKey: issue.identifier };
}

/** The cursors a brand-new watch starts from: nothing that exists now is news. */
export function initialCursors(issue: Issue, nowIso: string): { updatedAt: string; lastCommentAt: string } {
  const newest = (issue.comments?.nodes ?? []).map((c) => c.createdAt ?? "").reduce((a, b) => (a > b ? a : b), "");
  return { updatedAt: issue.updatedAt ?? nowIso, lastCommentAt: newest !== "" ? newest : (issue.createdAt ?? nowIso) };
}

// ---- the store -----------------------------------------------------------------

type Row = {
  thread_id: string;
  project_id: string;
  issue_id: string;
  issue_key: string;
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
    issueId: row.issue_id,
    issueKey: row.issue_key,
    // A snapshot an older build wrote is treated as empty: every field then
    // reads as changed once, which beats refusing to watch at all.
    snapshot: parsed.success ? parsed.data : { title: null, state: null, assignee: null, priority: null, labels: [], project: null, cycle: null, parent: null, dueDate: null, estimate: null, descriptionHash: null },
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
  forIssue(issueId: string): WatchRow[];
  get(threadId: string, issueId: string): WatchRow | null;
  /** Every distinct issue id with at least one watch: what to lease. */
  issueIds(): string[];
  /** After a check: the new memory, and whether the thread was woken (activity). */
  advance(threadId: string, issueId: string, outcome: CheckOutcome, woke: boolean): void;
  remove(threadId: string, issueId: string): void;
  removeThread(threadId: string): number;
  /** Delete watches idle longer than the TTL; returns how many went. */
  expire(): number;
}

export function createWatchStore(db: Database.Database, now: () => number): WatchStore {
  const insert = db.prepare(
    `INSERT INTO watches (thread_id, project_id, issue_id, issue_key, snapshot, updated_at, last_comment_at, created_at, last_activity_at)
     VALUES (@thread_id, @project_id, @issue_id, @issue_key, @snapshot, @updated_at, @last_comment_at, @created_at, @last_activity_at)`,
  );
  const countForThread = db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM watches WHERE thread_id = ?");
  const selectOne = db.prepare<[string, string], Row>("SELECT * FROM watches WHERE thread_id = ? AND issue_id = ?");
  const selectAll = db.prepare<[], Row>("SELECT * FROM watches ORDER BY created_at");
  const selectIssue = db.prepare<[string], Row>("SELECT * FROM watches WHERE issue_id = ? ORDER BY created_at");
  const selectIds = db.prepare<[], { issue_id: string }>("SELECT DISTINCT issue_id FROM watches ORDER BY issue_id");
  const touch = db.prepare("UPDATE watches SET last_activity_at = ? WHERE thread_id = ? AND issue_id = ?");
  const update = db.prepare("UPDATE watches SET snapshot = ?, updated_at = ?, last_comment_at = ?, issue_key = ? WHERE thread_id = ? AND issue_id = ?");
  const updateWoke = db.prepare("UPDATE watches SET snapshot = ?, updated_at = ?, last_comment_at = ?, issue_key = ?, last_activity_at = ? WHERE thread_id = ? AND issue_id = ?");
  const deleteOne = db.prepare("DELETE FROM watches WHERE thread_id = ? AND issue_id = ?");
  const deleteThread = db.prepare("DELETE FROM watches WHERE thread_id = ?");
  const deleteExpired = db.prepare("DELETE FROM watches WHERE last_activity_at < ?");

  const add = db.transaction((watch: Omit<WatchRow, "createdAt" | "lastActivityAt">): AddResult => {
    if (selectOne.get(watch.threadId, watch.issueId) !== undefined) {
      // Asking again is a sign the thread still cares; that is activity.
      touch.run(now(), watch.threadId, watch.issueId);
      return { outcome: "already" };
    }
    if (countForThread.get(watch.threadId)!.n >= WATCH_LIMIT) return { outcome: "full", limit: WATCH_LIMIT };
    insert.run({
      thread_id: watch.threadId,
      project_id: watch.projectId,
      issue_id: watch.issueId,
      issue_key: watch.issueKey,
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
    forIssue: (issueId) => selectIssue.all(issueId).map(rowToWatch),
    get: (threadId, issueId) => {
      const row = selectOne.get(threadId, issueId);
      return row === undefined ? null : rowToWatch(row);
    },
    issueIds: () => selectIds.all().map((r) => r.issue_id),
    advance: (threadId, issueId, outcome, woke) => {
      const snapshot = JSON.stringify(outcome.snapshot);
      if (woke) updateWoke.run(snapshot, outcome.updatedAt, outcome.lastCommentAt, outcome.issueKey, now(), threadId, issueId);
      else update.run(snapshot, outcome.updatedAt, outcome.lastCommentAt, outcome.issueKey, threadId, issueId);
    },
    remove: (threadId, issueId) => {
      deleteOne.run(threadId, issueId);
    },
    removeThread: (threadId) => Number(deleteThread.run(threadId).changes),
    expire: () => Number(deleteExpired.run(now() - WATCH_TTL_MS).changes),
  };
}

// ---- coalescing checks ---------------------------------------------------------

/** A doorbell waits this long for the ones behind it: Linear sends several per edit. */
export const DOORBELL_DEBOUNCE_MS = 3000;

export interface CheckQueue {
  /** A doorbell: check this issue soon, once, however many times this is called meanwhile. */
  ring(issueId: string): void;
  /** Check these issues now (each still queued behind any check of the same issue in flight). */
  sweep(issueIds: string[]): Promise<void>;
  /** Drop pending doorbells; in-flight checks finish. */
  stop(): void;
}

/**
 * Checks for one issue never overlap: a per-issue promise chain runs them
 * one after another, so a doorbell during a sweep's check of the same issue
 * waits for it rather than racing it to the cursor. Different issues run
 * concurrently.
 */
export function createCheckQueue(run: (issueId: string) => Promise<void>, options: { debounceMs?: number; onError?: (issueId: string, error: unknown) => void } = {}): CheckQueue {
  const debounceMs = options.debounceMs ?? DOORBELL_DEBOUNCE_MS;
  const chains = new Map<string, Promise<void>>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  function enqueue(issueId: string): Promise<void> {
    const previous = chains.get(issueId) ?? Promise.resolve();
    const next = previous
      .then(() => (stopped ? undefined : run(issueId)))
      .catch((error: unknown) => options.onError?.(issueId, error))
      .finally(() => {
        if (chains.get(issueId) === next) chains.delete(issueId);
      });
    chains.set(issueId, next);
    return next;
  }

  return {
    ring(issueId) {
      if (stopped || pending.has(issueId)) return;
      pending.set(
        issueId,
        setTimeout(() => {
          pending.delete(issueId);
          void enqueue(issueId);
        }, debounceMs),
      );
    },
    sweep(issueIds) {
      return Promise.all([...new Set(issueIds)].map(enqueue)).then(() => undefined);
    },
    stop() {
      stopped = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}
