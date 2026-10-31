// BB-154: a steward's free-text `waitingOn` can name something nothing in the
// system will ever deliver, so the binding wakes only by requeue, reports the
// same wait, and goes back to sleep forever. Two event-driven answers, both
// decided at report time and neither a periodic scan: whether any structured
// source the plugin tracks is live on the binding, and a per-binding count of
// consecutive requeue-only wakes with the same wait that raises one `stall`.
//
// Pure, so the report path, the store's derived phrase and the tests all read
// the same rules. The threshold is one plugin constant, never a project.json
// key.
import type { Deployments } from "./deploy.js";

/**
 * Consecutive requeue-only wakes with the same trimmed `waitingOn` that raise
 * one `stall` escalation to the project steward. A plugin constant (BB-154),
 * not a `project.json` key.
 */
export const STALL_WAKE_THRESHOLD = 2;

/** The structured sources that will wake a binding, as the report path reads them. */
export type WakeSourceInput = {
  /** The hold reason, or null when not held. */
  hold: string | null;
  /** Entity keys the hold waits behind; a hold with entries lifts itself when they land. */
  holdBehind: readonly string[];
  /** Per-pull-request deployment watches; `merged` and `deploying` are the live ones. */
  deployments: Deployments;
  /** The binding's running workers. */
  runningWorkers: number;
  /** Open escalations on the binding. */
  openEscalations: number;
  /** Open "needs you" items on the binding. */
  openNeeds: number;
  /** A pull request the plugin watches: an open linked one, or the open PR binding itself. */
  pullRequestWatch: boolean;
};

/**
 * Whether anything the plugin tracks will wake this binding. The list is the
 * one in the ticket's criterion 1: an open `holdBehind` entry, a deployment
 * watch in `merged`/`deploying`, a running worker, an open escalation or need,
 * or a pull-request watch. A free-text `waitingOn` is not on it.
 */
export function hasLiveWakeSource(s: WakeSourceInput): boolean {
  return (
    (s.hold !== null && s.holdBehind.length > 0) ||
    Object.values(s.deployments).some((d) => d.state === "merged" || d.state === "deploying") ||
    s.runningWorkers > 0 ||
    s.openEscalations > 0 ||
    s.openNeeds > 0 ||
    s.pullRequestWatch
  );
}

/** The stored requeue-only counter for one binding. */
export type StallState = {
  /** Consecutive requeue-only wakes with the same wait. */
  count: number;
  /** The trimmed wait the run is counting, or null when no run is under way. */
  waitText: string | null;
  /** When the run's first wait was reported, for the escalation's "first reported" line. */
  firstAt: number | null;
};

export const NO_STALL: StallState = { count: 0, waitText: null, firstAt: null };

/**
 * What a report does to the requeue-only counter. It advances only when the
 * wake that preceded the report was a `requeue`, the report ended with a
 * non-empty `waitingOn`, and no structured source is live; any other wake
 * reason, a changed wait, or a source resets it. `escalate` is true once the
 * run reaches the threshold; the caller suppresses a second escalation while
 * one is already open, which the live-source test also does (an open `stall`
 * is an open escalation).
 */
export function advanceStall(
  prev: StallState,
  opts: { reason: string | null; waitingOn: string | null; liveSource: boolean; now: number },
): { state: StallState; escalate: boolean } {
  const text = opts.waitingOn === null ? null : opts.waitingOn.trim();
  if (text === null || text === "" || opts.reason !== "requeue" || opts.liveSource) {
    return { state: NO_STALL, escalate: false };
  }
  if (prev.waitText === text && prev.count > 0) {
    const count = prev.count + 1;
    return { state: { count, waitText: text, firstAt: prev.firstAt ?? opts.now }, escalate: count >= STALL_WAKE_THRESHOLD };
  }
  return { state: { count: 1, waitText: text, firstAt: opts.now }, escalate: STALL_WAKE_THRESHOLD <= 1 };
}
