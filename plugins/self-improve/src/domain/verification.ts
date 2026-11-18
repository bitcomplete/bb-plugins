import type { EvaluationWindow, Verification, VerificationPolicy, Vote } from "./types.js";
import { DAY_MS, finite, integer, unique } from "./shared.js";
import { appendVotes } from "./votes.js";

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = { version: "rate-verdict-v1", minSessions: 30, materialChange: 0.2, solvedMaximumRate: 0.01, minimumWindowMs: 7 * DAY_MS };

/** Conservative Poisson concentration interval; valid for event counts, including >1 event/session. */
export function rateInterval(events: number, sessions: number, alpha = 0.025): [number, number] {
  integer(events, "event count"); integer(sessions, "session count", 1);
  if (!(alpha > 0 && alpha < 1)) throw new Error("interval alpha must be between zero and one");
  const log = Math.log(2 / alpha), margin = Math.sqrt(2 * events * log);
  return [Math.max(0, events - margin) / sessions, (events + margin + 2 * log) / sessions];
}

export function verifyWindows(before: EvaluationWindow, after: EvaluationWindow, policy: VerificationPolicy = DEFAULT_VERIFICATION_POLICY, confounders: string[] = []): Verification {
  for (const window of [before, after]) {
    finite(window.startMs, "window start"); finite(window.endMs, "window end");
    if (window.endMs <= window.startMs) throw new Error("window end must follow start");
    integer(window.sessions, "session count"); integer(window.votes, "vote count");
  }
  if (after.startMs < before.endMs) throw new Error("verification windows overlap");
  integer(policy.minSessions, "minimum sessions", 1); finite(policy.solvedMaximumRate, "solved target"); finite(policy.minimumWindowMs, "minimum window", 1);
  if (!(policy.materialChange > 0 && policy.materialChange < 1)) throw new Error("material change must be between zero and one");
  const beforeRate = before.sessions ? before.votes / before.sessions : null, afterRate = after.sessions ? after.votes / after.sessions : null;
  const beforeInterval = before.sessions ? rateInterval(before.votes, before.sessions) : null, afterInterval = after.sessions ? rateInterval(after.votes, after.sessions) : null;
  const reasons: string[] = [];
  if (before.sessions < policy.minSessions || after.sessions < policy.minSessions) reasons.push("insufficient session exposure");
  if (before.endMs - before.startMs < policy.minimumWindowMs || after.endMs - after.startMs < policy.minimumWindowMs) reasons.push("observation windows are not mature");
  if (before.votes === 0) reasons.push("no observed baseline symptom to improve");
  let verdict: Verification["verdict"] = "PENDING";
  if (!reasons.length && beforeInterval && afterInterval) {
    if (after.votes === 0 && afterInterval[1] <= policy.solvedMaximumRate && afterInterval[1] < beforeInterval[0] * (1 - policy.materialChange)) verdict = "SOLVED";
    else if (afterInterval[1] < beforeInterval[0] * (1 - policy.materialChange)) verdict = "REDUCED";
    else if (afterInterval[0] > beforeInterval[1] * (1 + policy.materialChange)) verdict = "WORSE";
    else if (afterInterval[0] >= beforeInterval[1] * (1 - policy.materialChange) && afterInterval[1] <= beforeInterval[0] * (1 + policy.materialChange)) verdict = "NO EFFECT";
    else reasons.push("uncertainty spans verdict thresholds; collect more exposure");
  }
  if (confounders.length) reasons.push("confounded comparison: an association, not causal proof");
  return { verdict, beforeRate, afterRate, beforeInterval, afterInterval, relativeChange: beforeRate && afterRate !== null ? afterRate / beforeRate - 1 : null, reasons, confounders: unique(confounders), policyVersion: policy.version };
}

export interface SessionExposure { sessionId: string; atMs: number; originPluginId: string | null }
/** Raw symptom observations, not ranking weights, divided by observed eligible sessions. */
export function observationWindow(startMs: number, endMs: number, sessions: SessionExposure[], votes: Vote[], problemIds: string[], symptomIds: string[]): EvaluationWindow {
  finite(startMs, "window start"); finite(endMs, "window end");
  if (endMs <= startMs) throw new Error("window end must follow start");
  const eligible = sessions.filter(s => s.originPluginId !== "self-improve" && s.atMs >= startMs && s.atMs < endMs);
  const sessionIds = new Set(eligible.map(s => s.sessionId));
  const observations = appendVotes([], votes).filter(v => v.originPluginId !== "self-improve" && problemIds.includes(v.problemId) && v.symptomId !== undefined && symptomIds.includes(v.symptomId) && v.occurredAtMs >= startMs && v.occurredAtMs < endMs && v.evidence.kind === "thread" && sessionIds.has(v.evidence.sessionId));
  return { startMs, endMs, sessions: sessionIds.size, votes: observations.length };
}
