import type { AgentAction } from "./actions.js";
import type { RunDb } from "./runstore.js";
import type { Board } from "./server.js";

export type DispatchMode = "off" | "shadow" | "auto";
export type DispatchStatus = "launching" | "running" | "verifying" | "verified" | "needs-you" | "failed";
export type DispatchCandidate = { path: string; prUrl: string; action: AgentAction; reason: string };
export type DispatchAttempt = {
  id: number; path: string; prUrl: string; action: string; status: DispatchStatus;
  detail: string; threadId: string | null; startedAt: number;
};
export type DispatchState = {
  mode: DispatchMode; effortKey: string | null; candidate: DispatchCandidate | null; attempts: DispatchAttempt[];
};

export const DISPATCH_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS dispatch_policy (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL, effort_key TEXT)`,
  `CREATE TABLE IF NOT EXISTS dispatch_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, unit_path TEXT NOT NULL, pr_url TEXT NOT NULL,
    action TEXT NOT NULL, reason TEXT NOT NULL, fingerprint TEXT NOT NULL,
    status TEXT NOT NULL, detail TEXT NOT NULL, thread_id TEXT, started_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dispatch_active_pr ON dispatch_attempts (pr_url)
    WHERE status IN ('launching', 'running', 'verifying', 'needs-you')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dispatch_active_path ON dispatch_attempts (unit_path)
    WHERE status IN ('launching', 'running', 'verifying', 'needs-you')`,
];

type AttemptRow = {
  id: number; unit_path: string; pr_url: string; action: string; reason: string;
  fingerprint: string; status: DispatchStatus; detail: string; thread_id: string | null; started_at: number;
};
type PolicyRow = { mode: DispatchMode; effort_key: string | null };
const ACTIVE = new Set<DispatchStatus>(["launching", "running", "verifying"]);
const BAD_CHECKS = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

export function gateOf(pr: NonNullable<Board["groups"][number]["clusters"][number]["units"][number]["pr"]>):
  { action: AgentAction; reason: string } | null {
  if (pr.checkConclusions.some((check) => BAD_CHECKS.has(check))) return { action: "investigate-ci", reason: "CI checks are failing" };
  if (pr.mergeStateStatus === "DIRTY") return { action: "resolve-conflicts", reason: "PR has merge conflicts" };
  if (!pr.reviewFollowupPosted && (pr.reviewDecision === "CHANGES_REQUESTED" || pr.latestReviewStates.includes("CHANGES_REQUESTED"))) {
    return { action: "address-review", reason: "Reviewers requested changes" };
  }
  if (pr.unresolvedReviewThreads !== null && pr.unresolvedReviewThreads > 0) {
    return { action: "address-comments", reason: `${pr.unresolvedReviewThreads} review thread(s) remain open` };
  }
  return null;
}

export function gateStillOpen(pr: NonNullable<Board["groups"][number]["clusters"][number]["units"][number]["pr"]>, action: string): boolean {
  if (action === "investigate-ci") return pr.checkConclusions.some((check) => BAD_CHECKS.has(check));
  if (action === "resolve-conflicts") return pr.mergeStateStatus === "DIRTY";
  if (action === "address-review") return !pr.reviewFollowupPosted &&
    (pr.reviewDecision === "CHANGES_REQUESTED" || pr.latestReviewStates.includes("CHANGES_REQUESTED"));
  if (action === "address-comments") return pr.unresolvedReviewThreads === null || pr.unresolvedReviewThreads > 0;
  return true;
}

function fingerprint(unit: Board["groups"][number]["clusters"][number]["units"][number], action: AgentAction): string {
  const pr = unit.pr!;
  return JSON.stringify([pr.url, action, unit.lastCommitAt, pr.checkConclusions, pr.mergeStateStatus,
    pr.reviewDecision, pr.latestReviewStates, pr.unresolvedReviewThreads, pr.reviewFollowupPosted]);
}

export function selectCandidate(
  groups: Board["groups"], effortKey: string | null, attempts: readonly (DispatchAttempt & { fingerprint: string })[],
  openRuns: readonly Pick<Board["runs"][number], "path" | "prUrl" | "status">[],
): { candidate: DispatchCandidate; fingerprint: string } | null {
  if (effortKey === null) return null;
  const effort = groups.find((group) => group.key === effortKey && !groups.some((child) => child.parentKey === group.key));
  if (effort === undefined) return null;
  const counts = new Map<string, number>();
  for (const group of groups) for (const cluster of group.clusters) for (const unit of cluster.units) {
    if (unit.pr?.state === "OPEN") counts.set(unit.pr.url, (counts.get(unit.pr.url) ?? 0) + 1);
  }
  for (const cluster of effort.clusters) for (const unit of [...cluster.units].sort((a, b) => a.path.localeCompare(b.path))) {
    const pr = unit.pr;
    if (unit.dirty || unit.rebasing || (unit.stack !== null && unit.stack.blockedBelow !== null) ||
      unit.observed?.status !== true || unit.observed?.pr !== true || pr === null || pr.state !== "OPEN" ||
      pr.isDraft || pr.mergeStateStatus === "UNKNOWN" || counts.get(pr.url) !== 1 ||
      cluster.threads.some((thread) => thread.active) ||
      openRuns.some((run) => (run.path === unit.path || run.prUrl === pr.url) && (run.status === "running" || run.status === "needs-you")) ||
      attempts.some((attempt) => (ACTIVE.has(attempt.status) || attempt.status === "needs-you") &&
        (attempt.path === unit.path || attempt.prUrl === pr.url))) continue;
    const gate = gateOf(pr);
    if (gate === null) continue;
    const facts = fingerprint(unit, gate.action);
    if (attempts.some((attempt) => attempt.prUrl === pr.url && attempt.action === gate.action && attempt.fingerprint === facts)) continue;
    return { candidate: { path: unit.path, prUrl: pr.url, ...gate }, fingerprint: facts };
  }
  return null;
}

export function createDispatchStore(db: RunDb, now: () => number = Date.now) {
  function policy(): PolicyRow {
    return (db.prepare(`SELECT mode, effort_key FROM dispatch_policy WHERE id = 1`).get() as PolicyRow | undefined) ?? { mode: "off", effort_key: null };
  }
  function attempts(): (DispatchAttempt & { fingerprint: string })[] {
    return (db.prepare(`SELECT * FROM dispatch_attempts ORDER BY id DESC`).all() as AttemptRow[]).map((row) => ({
      id: row.id, path: row.unit_path, prUrl: row.pr_url, action: row.action,
      fingerprint: row.fingerprint, status: row.status, detail: row.detail, threadId: row.thread_id, startedAt: row.started_at,
    }));
  }
  return {
    policy,
    attempts,
    setPolicy(mode: DispatchMode, effortKey: string | null): void {
      db.prepare(`INSERT OR REPLACE INTO dispatch_policy (id, mode, effort_key) VALUES (1, ?, ?)`).run(mode, effortKey);
    },
    reserve(item: { candidate: DispatchCandidate; fingerprint: string }): number | null {
      const active = db.prepare(`SELECT id FROM dispatch_attempts WHERE status IN ('launching', 'running', 'verifying', 'needs-you') LIMIT 1`).get();
      if (active !== undefined) return null;
      const { candidate, fingerprint } = item;
      const id = db.prepare(`INSERT INTO dispatch_attempts (unit_path, pr_url, action, reason, fingerprint, status, detail, thread_id, started_at)
        VALUES (?, ?, ?, ?, ?, 'launching', 'Launching agent', NULL, ?)`).run(
        candidate.path, candidate.prUrl, candidate.action, candidate.reason, fingerprint, now(),
      ).lastInsertRowid;
      return Number(id);
    },
    update(id: number, status: DispatchStatus, detail: string, threadId?: string): void {
      db.prepare(`UPDATE dispatch_attempts SET status = ?, detail = ?, thread_id = COALESCE(?, thread_id) WHERE id = ?`).run(status, detail, threadId ?? null, id);
    },
    status(id: number): DispatchStatus | null {
      return (db.prepare(`SELECT status FROM dispatch_attempts WHERE id = ?`).get(id) as { status: DispatchStatus } | undefined)?.status ?? null;
    },
    finishVerification(id: number, status: "verified" | "needs-you", detail: string): void {
      db.prepare(`UPDATE dispatch_attempts SET status = ?, detail = ? WHERE id = ? AND status = 'verifying'`).run(status, detail, id);
    },
    activeFor(path: string, prUrl: string | null): boolean {
      return db.prepare(`SELECT id FROM dispatch_attempts WHERE (unit_path = ? OR pr_url = ?)
        AND status IN ('launching', 'running', 'verifying', 'needs-you') LIMIT 1`).get(path, prUrl) !== undefined;
    },
    byThread(threadId: string): (DispatchAttempt & { fingerprint: string }) | undefined {
      return attempts().find((attempt) => attempt.threadId === threadId);
    },
    closeStranded(): void {
      db.prepare(`UPDATE dispatch_attempts SET status = 'needs-you', detail = 'Launch was interrupted; inspect the thread before retrying' WHERE status = 'launching'`).run();
    },
  };
}
