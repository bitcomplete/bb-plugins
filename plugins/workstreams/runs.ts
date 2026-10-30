// Run tracking for the Board's row actions. Pure: what a run is, how a thread
// signal moves its status, how the outcome is read out of the agent's final
// message, and what the Board, the Agents strip and the sidebar badge show.
// No SDK, no storage and no model call here; runstore.ts persists runs and
// server.ts feeds it thread events.
import { compactAge } from "./workstreams.js";

export const RUN_STATUSES = ["running", "needs-you", "done", "failed", "succeeded"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunKind = "agent" | "direct";
export type RunMode = "continue" | "subthread" | "new";

export type Run = {
  id: number;
  kind: RunKind;
  /** e.g. resolve-conflicts, address-review, merge, nudge. */
  action: string;
  path: string;
  ticket: string | null;
  prUrl: string | null;
  prNumber: number | null;
  /** Agent runs only. */
  threadId: string | null;
  mode: RunMode | null;
  startedAt: number;
  status: RunStatus;
  finishedAt: number | null;
  result: string | null;
  error: string | null;
};

/** Still going: the row keeps reporting it however old it is. */
export function isOpen(status: RunStatus): boolean {
  return status === "running" || status === "needs-you";
}

// ---- the outcome in words ---------------------------------------------------

export const RESULT_MAX = 120;
/** Only the tail of a long message is searched: the Result line is the last thing asked for. */
const RESULT_SCAN_CHARS = 20_000;

/** Trim to `max` characters on one line, with an ellipsis when cut. */
export function clip(text: string, max = RESULT_MAX): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const RESULT_LINE = /^result(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/iu;

/**
 * The LAST line starting "Result:" in the agent's final message, trimmed and
 * capped. Markdown around it (a bullet, a quote, bold, a heading) is ignored.
 * Null when there is none or it is empty: a result is never invented.
 */
export function extractResult(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const lines = text.slice(-RESULT_SCAN_CHARS).split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const bare = (lines[index] ?? "").replace(/^[\s>*_#`-]+/u, "");
    const match = RESULT_LINE.exec(bare);
    if (match === null) continue;
    const body = (match[1] ?? "").replace(/(?:\s|\*\*|__)+$/u, "").trim();
    if (body !== "") return clip(body);
  }
  return null;
}

// ---- status from thread signals ---------------------------------------------

/**
 * What a thread event says about a run in it. `settled` means the thread is
 * still running but no longer waits on the user: an interaction was answered.
 */
export type ThreadSignal =
  | { kind: "active" }
  | { kind: "pending" }
  | { kind: "settled" }
  | { kind: "idle"; text: string | null }
  | { kind: "failed"; text: string | null; error: string | null }
  /** The thread was archived or deleted: whatever this run was, it is over. */
  | { kind: "gone"; reason: string };

/** The run fields a signal can read. */
export type TrackedRun = Pick<Run, "status" | "startedAt"> & {
  /**
   * Whether this run's own turn has been seen. A `continue` run shares a thread
   * with earlier work: until the thread goes active after the run started, an
   * idle or a question belongs to that earlier turn, not to this run.
   */
  armed: boolean;
};

export type RunPatch = {
  status: RunStatus;
  armed: boolean;
  finishedAt: number | null;
  result: string | null;
  error: string | null;
};

/**
 * The run after `signal`, observed at `at`, or null when nothing changes.
 * Finished runs never move again, and anything seen before the run started
 * is someone else's history.
 */
export function applySignal(run: TrackedRun, signal: ThreadSignal, at: number): RunPatch | null {
  if (!isOpen(run.status) || at < run.startedAt) return null;
  const keep = { finishedAt: null, result: null, error: null };
  if (signal.kind === "gone") return { status: "failed", armed: run.armed, finishedAt: at, result: null, error: clip(signal.reason) };
  if (signal.kind === "active") {
    if (!run.armed) return { status: "running", armed: true, ...keep };
    return run.status === "needs-you" ? { status: "running", armed: true, ...keep } : null;
  }
  if (!run.armed) return null;
  switch (signal.kind) {
    case "pending":
      return run.status === "needs-you" ? null : { status: "needs-you", armed: true, ...keep };
    case "settled":
      return run.status === "needs-you" ? { status: "running", armed: true, ...keep } : null;
    case "idle":
      return { status: "done", armed: true, finishedAt: at, result: extractResult(signal.text), error: null };
    case "failed":
      return {
        status: "failed",
        armed: true,
        finishedAt: at,
        result: extractResult(signal.text),
        error: signal.error === null || signal.error.trim() === "" ? null : clip(signal.error),
      };
  }
}

/** How long an unarmed continue run may wait on an idle thread before it is closed. */
export const STRANDED_MS = 6 * 60 * 60 * 1_000;

/**
 * A `continue` run whose own turn was never seen (its `thread.active` fired
 * during a reload) would otherwise stay "running" forever. Once its thread is
 * idle and the run is over six hours old, it is closed as done with no result:
 * the turn may well have finished, but what it did is not known, so the row
 * says "Done: see thread" rather than inventing an outcome.
 */
export function isStranded(
  run: Pick<Run, "mode" | "status" | "startedAt"> & { armed: boolean },
  threadIdle: boolean,
  now: number,
): boolean {
  return run.mode === "continue" && !run.armed && isOpen(run.status) && threadIdle && now - run.startedAt > STRANDED_MS;
}

// ---- direct actions ----------------------------------------------------------

/** What a direct run's row says once it succeeded, before "2m ago". Only merges run directly now; the rest label runs already stored. */
export const DIRECT_DONE: Record<string, string> = {
  merge: "Merged",
  "update-branch": "Branch updated",
  nudge: "Nudged",
};

/**
 * The short reason a direct run stores. A success keeps what the host did,
 * minus the repo and PR the row already shows; a failure keeps its reason.
 */
export function directOutcome(
  action: string,
  result: { ok: true; detail: string } | { ok: false; error: string },
): { ok: boolean; text: string } {
  if (!result.ok) return { ok: false, text: clip(result.error) };
  return { ok: true, text: DIRECT_DONE[action] ?? clip(result.detail) };
}

// ---- what the Board shows ----------------------------------------------------

const HOUR_MS = 60 * 60 * 1_000;
/** A finished run stays on its row this long. */
export const ROW_RUN_MS = 24 * HOUR_MS;

const AGENT_DOING: Record<string, string> = {
  "resolve-conflicts": "resolving conflicts",
  "investigate-ci": "investigating CI",
  "address-review": "addressing review",
  "address-comments": "addressing comments",
  "review-approval-note": "reviewing approval note",
};

/** One line for the row, in the user's words. */
export function runLabel(run: Run, now: number): string {
  const ago = (at: number) => (now - at < 60_000 ? "just now" : `${compactAge(at, now)} ago`);
  switch (run.status) {
    case "running":
      return `Agent ${AGENT_DOING[run.action] ?? "working"} · ${compactAge(run.startedAt, now)}`;
    case "needs-you":
      return "Agent needs you";
    case "done":
      return `Done: ${run.result ?? "see thread"}`;
    case "succeeded":
      return `${DIRECT_DONE[run.action] ?? "Done"} ${ago(run.finishedAt ?? run.startedAt)}`;
    case "failed":
      return `Failed: ${run.result ?? run.error ?? (run.kind === "agent" ? "see thread" : "no reason given")}`;
  }
}

/** The sidebar badge: needs-you first, else running; nothing when both are zero. */
export function badgeValue(runs: readonly Pick<Run, "status">[]): { count: number; needsYou: boolean } | null {
  const needsYou = runs.filter((run) => run.status === "needs-you").length;
  if (needsYou > 0) return { count: needsYou, needsYou: true };
  const running = runs.filter((run) => run.status === "running").length;
  return running > 0 ? { count: running, needsYou: false } : null;
}
