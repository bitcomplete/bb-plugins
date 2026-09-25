import type { Row } from "./inbox.js";
import type { Board, WireRun } from "./server.js";

type Attempt = Board["dispatch"]["attempts"][number];

export type EffortOutcome = {
  row: Row;
  action: string;
  outcome: string;
  source: "Agent reported at action finish" | "Agent finished without a result" | "Direct action" | "Scan verified" | "Dispatch needs you" | "Dispatch failed";
  at: number;
  threadId: string | null;
  prState: string;
};

const ACTION_LABEL: Record<string, string> = {
  "investigate-ci": "Investigate CI",
  "resolve-conflicts": "Resolve conflicts",
  "address-review": "Address review",
  "address-comments": "Address comments",
  "review-approval-note": "Review approval note",
  "update-branch": "Update branch",
  merge: "Merge",
  nudge: "Nudge reviewers",
};

/** The most recent completed action affecting a checkout in an effort. */
export function latestEffortOutcome(
  rows: readonly Row[],
  runs: readonly WireRun[],
  attempts: readonly Attempt[],
): EffortOutcome | null {
  const byPath = new Map(rows.filter((row) => row.unit.pr !== null).map((row) => [row.key, row]));
  const terminalAttempts = attempts.filter((attempt) =>
    byPath.has(attempt.path) && ["verified", "needs-you", "failed"].includes(attempt.status),
  );
  // A continued thread can host several actions on the same checkout. Pair an
  // attempt with its own run, not every run in that thread.
  const dispatched = new Set<number>();
  const runForAttempt = new Map<number, WireRun>();
  for (const attempt of [...terminalAttempts].sort((a, b) => a.startedAt - b.startedAt)) {
    if (attempt.threadId === null) continue;
    const run = runs.filter((entry) =>
      entry.path === attempt.path && entry.threadId === attempt.threadId &&
      entry.action === attempt.action && entry.startedAt >= attempt.startedAt &&
      entry.startedAt - attempt.startedAt <= 10 * 60_000 && !dispatched.has(entry.id),
    ).sort((a, b) => a.startedAt - b.startedAt)[0];
    if (run === undefined) continue;
    dispatched.add(run.id);
    runForAttempt.set(attempt.id, run);
  }
  const candidates: { row: Row; action: string; outcome: string; source: EffortOutcome["source"]; at: number; threadId: string | null }[] = [];

  for (const run of runs) {
    const row = byPath.get(run.path);
    if (row === undefined || !["done", "succeeded", "failed"].includes(run.status)) continue;
    if (dispatched.has(run.id)) continue;
    candidates.push({
      row,
      action: ACTION_LABEL[run.action] ?? run.action,
      outcome: run.result ?? run.error ?? (run.kind === "agent" ? "Finished; see thread" : "Finished"),
      source: run.kind === "direct" ? "Direct action" : run.result === null ? "Agent finished without a result" : "Agent reported at action finish",
      at: run.finishedAt ?? run.startedAt,
      threadId: run.threadId,
    });
  }
  for (const attempt of terminalAttempts) {
    const row = byPath.get(attempt.path)!;
    const run = runForAttempt.get(attempt.id);
    candidates.push({
      row,
      action: ACTION_LABEL[attempt.action] ?? attempt.action,
      outcome: attempt.detail || (attempt.status === "verified" ? "Gate cleared on scan" : "See thread"),
      source: attempt.status === "verified" ? "Scan verified" : attempt.status === "needs-you" ? "Dispatch needs you" : "Dispatch failed",
      at: run?.finishedAt ?? attempt.startedAt,
      threadId: attempt.threadId,
    });
  }

  const latest = candidates.sort((a, b) => b.at - a.at)[0];
  if (latest === undefined) return null;
  return {
    ...latest,
    prState: latest.row.verb ?? latest.row.section,
  };
}
