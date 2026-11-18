import { describe, expect, it } from "vitest";
import { selectSessions, deterministicTaskVotes } from "../../src/domain/selection.js";
import type { SessionRecord, TaskRun } from "../../src/domain/types.js";
import { NOW } from "./fixtures.js";

const session = (id: string, taskId: string | null = "task-a", time = NOW): SessionRecord => ({ sessionId: id, threadId: `t-${id}`, taskId, day: "2026-11-18", firstEventAtMs: time, originPluginId: null });
describe("session and loop cost control", () => {
  it("selects one session per task/day in stable event-time/ID order", () => {
    const chosen = selectSessions([session("c"), session("b"), session("a", "task-b")], []);
    expect(chosen.selected.map(x => x.sessionId)).toEqual(["a", "b"]);
    expect(chosen.skippedSessionIds).toEqual(["c"]);
  });
  it("retains an existing selection on later batches and reports unknown task identity", () => {
    const first = selectSessions([session("b")], []);
    const next = selectSessions([session("b"), session("a", "task-a", NOW - 1), session("unknown", null)], first.selections);
    expect(next.selected.map(x => x.sessionId)).toEqual(["b", "unknown"]);
    expect(next.unknownTaskSessionIds).toEqual(["unknown"]);
  });
  it("does not let self-improvement workers reserve a task's session selection", () => {
    expect(selectSessions([{ ...session("own"), originPluginId: "self-improve" }], []).selections).toEqual([]);
  });
  it("casts one loop vote after six distinct runs, independent of replay or extra runs", () => {
    const runs: TaskRun[] = Array.from({ length: 8 }, (_, i) => ({ taskId: "task-a", runId: `r-${i}`, day: "2026-11-18", occurredAtMs: NOW + i, outcome: "succeeded", originPluginId: null }));
    const ids = { failed: "failed", blocked: "blocked", looped: "looped" };
    expect(deterministicTaskVotes(runs.slice(0, 5), ids)).toEqual([]);
    const six = deterministicTaskVotes(runs.slice(0, 6), ids);
    expect(six).toHaveLength(1);
    expect(deterministicTaskVotes([...runs, ...runs], ids)).toEqual(six);
  });
  it("casts failed and blocked votes only from explicit terminal outcomes", () => {
    const runs: TaskRun[] = ["failed", "blocked", "running"].map((outcome, i) => ({ taskId: "task-a", runId: String(i), day: "2026-11-18", occurredAtMs: NOW, outcome: outcome as TaskRun["outcome"], originPluginId: null }));
    expect(deterministicTaskVotes(runs, { failed: "failed", blocked: "blocked", looped: "looped" }).map(v => v.kind).sort()).toEqual(["blocked_task", "failed_task"]);
  });
});
