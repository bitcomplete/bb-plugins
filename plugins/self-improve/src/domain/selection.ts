import type { SessionRecord, SessionSelection, TaskRun, Vote } from "./types.js";
import { compareIds, day, finite, stableJson, text, unique } from "./shared.js";
import { makeVote } from "./votes.js";

function selectionKey(session: Pick<SessionRecord, "taskId" | "sessionId" | "day">): string {
  return stableJson([session.day, session.taskId ? "task" : "session", session.taskId ?? session.sessionId]);
}
export function selectSessions(sessions: SessionRecord[], prior: SessionSelection[]): { selections: SessionSelection[]; selected: SessionRecord[]; skippedSessionIds: string[]; unknownTaskSessionIds: string[] } {
  const selections = new Map<string, SessionSelection>();
  for (const previous of prior) {
    if (previous.key !== selectionKey(previous)) throw new Error("invalid persisted selection key");
    const conflict = selections.get(previous.key);
    if (conflict && conflict.sessionId !== previous.sessionId) throw new Error("conflicting task/day selection");
    selections.set(previous.key, structuredClone(previous));
  }
  const observed = new Map<string, SessionRecord>();
  for (const s of sessions) {
    text(s.sessionId, "session ID"); text(s.threadId, "thread ID"); day(s.day); finite(s.firstEventAtMs, "session timestamp");
    if (s.taskId !== null) text(s.taskId, "task ID");
    const key = stableJson([s.day, s.sessionId]), previous = observed.get(key);
    if (previous && stableJson(previous) !== stableJson(s)) throw new Error("conflicting session identity");
    observed.set(key, s);
  }
  const ordered = [...observed.values()].filter(s => s.originPluginId !== "self-improve").sort((a, b) => a.firstEventAtMs - b.firstEventAtMs || compareIds(a.sessionId, b.sessionId));
  const selected: SessionRecord[] = [], skipped: string[] = [], unknown: string[] = [];
  for (const session of ordered) {
    const key = selectionKey(session);
    if (!selections.has(key)) selections.set(key, { key, sessionId: session.sessionId, day: session.day, taskId: session.taskId });
    if (selections.get(key)!.sessionId === session.sessionId) selected.push(structuredClone(session));
    else skipped.push(session.sessionId);
    if (session.taskId === null) unknown.push(session.sessionId);
  }
  return { selections: [...selections.values()].sort((a, b) => compareIds(a.key, b.key)), selected, skippedSessionIds: unique(skipped), unknownTaskSessionIds: unique(unknown) };
}

/** Adapter outcomes must be structured terminal facts, never guesses from an idle thread. */
export function deterministicTaskVotes(runs: TaskRun[], problemIds: { failed: string; blocked: string; looped: string }): Vote[] {
  const seen = new Map<string, TaskRun>();
  for (const run of runs) {
    text(run.taskId, "task ID"); text(run.runId, "run ID"); day(run.day); finite(run.occurredAtMs, "task run time");
    if (!["failed", "blocked", "succeeded", "running"].includes(run.outcome)) throw new Error("invalid task outcome");
    if (run.originPluginId === "self-improve") continue;
    const key = stableJson([run.taskId, run.runId]), existing = seen.get(key);
    if (existing && stableJson(existing) !== stableJson(run)) throw new Error("conflicting task run; reconcile terminal state before voting");
    seen.set(key, run);
  }
  const groups = new Map<string, TaskRun[]>(), votes: Vote[] = [];
  for (const run of seen.values()) {
    const key = stableJson([run.taskId, run.day]); groups.set(key, [...(groups.get(key) ?? []), run]);
    if (run.outcome === "failed" || run.outcome === "blocked") votes.push(makeVote({ problemId: problemIds[run.outcome], kind: run.outcome === "failed" ? "failed_task" : "blocked_task", evidence: { kind: "task", taskId: run.taskId, runId: run.runId }, day: run.day, occurredAtMs: run.occurredAtMs, originPluginId: run.originPluginId }));
  }
  for (const group of groups.values()) if (group.length > 5) {
    const sixth = group.sort((a, b) => a.occurredAtMs - b.occurredAtMs || compareIds(a.runId, b.runId))[5]!;
    votes.push(makeVote({ problemId: problemIds.looped, kind: "task_looped", evidence: { kind: "task", taskId: sixth.taskId, runId: `loop:${sixth.day}` }, day: sixth.day, occurredAtMs: sixth.occurredAtMs, originPluginId: sixth.originPluginId }));
  }
  return votes.sort((a, b) => compareIds(a.id, b.id));
}
