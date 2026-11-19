import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { NativeMiner, NATIVE_MINER_INSTRUCTION } from "../src/native-miner.js";
import { MIGRATIONS, Store } from "../src/store.js";
import type { NativeExecution, NativeTaskRequest, NativeTaskReceipt, TaskRunner } from "../src/native-tasks.js";
import type { MiningEvent, MiningSession } from "../src/stages/mining.js";
import type { Problem } from "../src/domain/types.js";
import type { PrivacyPolicy } from "../src/adapters/privacy.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const session: MiningSession = { sessionId: "session", threadId: "source-thread", taskId: "source-task", day: "2026-11-18", firstEventAtMs: 1, originPluginId: null, events: [] };
const events: MiningEvent[] = [{ id: "event-1", sequence: 1, kind: "tool_error", atMs: 2, turnIndex: 0, excerpt: "ClientCorp EVENT_EXCERPT_ONLY tool error" }];
const next: MiningEvent = { id: "event-2", sequence: 2, kind: "tool_retry", atMs: 3, turnIndex: 0, excerpt: "The request was retried" };
const problem: Problem = { id: "problem-1", aliases: ["prior-problem"], category: "reliability", status: "open", causes: [{ id: "cause-1", text: "ClientCorp request state was lost" }], symptoms: [{ id: "symptom-1", causeId: "cause-1", text: "Retry omitted a payload" }], solutionIds: [], createdAtMs: 1 };
function fixture(providerId = "codex") {
  const db = new Database(":memory:"); dbs.push(db); for (const sql of MIGRATIONS) db.exec(sql);
  const store = new Store(db), states = new Map<string, any>();
  let policy: PrivacyPolicy = { clientNames: ["ClientCorp"] }, generation = "generation-1";
  let execution: NativeExecution = { projectId: "worker-project", environment: { type: "reuse", environmentId: "scratch" }, providerId, model: "model" };
  const reply = (request: NativeTaskRequest, patch?: unknown): NativeTaskReceipt => {
    const input = JSON.parse(request.input), event = input.events.find((event: any) => event.kind !== "context");
    const value = patch ?? { requestId: input.requestId, failures: event ? [{ eventId: event.id, kind: event.kind, symptom: "A retry failed", rootCauseHypothesis: "Saved payload was absent", category: "reliability", matchedProblemId: null }] : [] };
    return { taskId: request.id, threadId: `thread-${request.id}`, requestId: "client-request", turnId: "root-turn", providerId: request.execution.providerId, model: request.execution.model, stage: request.stage, runId: request.runId, solutionId: request.solutionId, text: JSON.stringify(value), promptHash: "a".repeat(64), startedAtMs: 10, endedAtMs: 20, modelIdentitySource: "requested-selection" };
  };
  const finished = (request: NativeTaskRequest, state = "completed", extra: Record<string, unknown> = {}) => states.set(request.id, { taskId: request.id, state, active: false, dispatched: true, threadId: `thread-${request.id}`, cleanupPending: false, ...extra });
  const execute = vi.fn(async (request: NativeTaskRequest): Promise<NativeTaskReceipt> => { finished(request); return reply(request); });
  const runner: TaskRunner = { execute }, owns = vi.fn((id: string) => id.startsWith("owned-"));
  const create = () => new NativeMiner({ store, runner, execution: () => execution, privacy: () => policy, privacyGeneration: () => generation, owns, taskState: id => states.get(id), now: () => 100 });
  let miner = create();
  return { store, runner, execute, states, reply, finished, owns, get miner() { return miner; }, restart() { miner = create(); }, privacy(next: PrivacyPolicy, gen: string) { policy = next; generation = gen; }, execution(next: NativeExecution) { execution = next; }, get executionValue() { return execution; } };
}

describe("native miner", () => {
  it.each(["codex", "claude-code"])("uses semantic native tasks with %s and retains no source excerpts", async provider => {
    const f = fixture(provider), result = await f.miner.analyze(session, events, [problem], { runId: "run-original" });
    expect(result.failures).toHaveLength(1);
    const request = f.execute.mock.calls[0]![0], input = JSON.parse(request.input);
    expect(request).toMatchObject({ stage: "miner", runId: "run-original", execution: { providerId: provider }, privacyGeneration: "generation-1", instructions: NATIVE_MINER_INSTRUCTION });
    expect(request).not.toHaveProperty("messages"); expect(request).not.toHaveProperty("max_tokens");
    expect(input.events[0].preview).toContain("EVENT_EXCERPT_ONLY"); expect(input.threadId).toBe("source-thread"); expect(request.input).not.toContain("ClientCorp");
    const saved = JSON.stringify(f.store.list("native-mining-operations"));
    expect(saved).not.toContain("EVENT_EXCERPT_ONLY"); expect(saved).not.toContain("ClientCorp"); expect(saved).not.toContain(NATIVE_MINER_INSTRUCTION);
    expect(f.miner.owns("owned-thread")).toBe(true); expect(f.miner.owns("source-thread")).toBe(false);
  });

  it("recovers the original pending prefix with stable run, execution and problem context", async () => {
    const f = fixture(); f.execute.mockImplementationOnce(async request => { f.states.set(request.id, { taskId: request.id, state: "uncertain", active: false, dispatched: true, threadId: null, cleanupPending: true }); throw new Error("response lost"); });
    await expect(f.miner.analyze(session, events, [problem], { runId: "run-original" })).rejects.toThrow("response lost");
    const original = f.execute.mock.calls[0]![0]; f.restart();
    const changed = { ...problem, causes: [{ id: "cause-2", text: "A new ledger cause" }] };
    expect(await f.miner.analyze(session, [...events, next], [changed], { runId: "later-service-run" })).toMatchObject({ analyzedEvents: [{ id: "event-1", sequence: 1 }] });
    expect(f.execute.mock.calls[1]![0]).toEqual(original);
    expect(original.input).not.toContain("A new ledger cause"); expect(original.input).not.toContain("event-2");
  });

  it("reuses a completed prefix after a ledger write failure, then analyzes only the next delta", async () => {
    const f = fixture(), first = await f.miner.analyze(session, events, [problem], { runId: "run-1" }); f.restart();
    expect(await f.miner.analyze(session, [...events, next], [problem], { runId: "run-2" })).toEqual({ ...first, analyzedEvents: [{ id: "event-1", sequence: 1 }] });
    expect(f.execute).toHaveBeenCalledTimes(1);
    await f.miner.analyze(session, [next], [problem], { runId: "run-3" });
    expect(f.execute).toHaveBeenCalledTimes(2); expect(JSON.parse(f.execute.mock.calls[1]![0].input).events.map((event: any) => event.id)).toEqual(["event-2"]);
    expect(f.execute.mock.calls[0]![0].id).not.toBe(f.execute.mock.calls[1]![0].id);
  });

  it("does not dispatch again for absent, changed or reordered pending evidence", async () => {
    const f = fixture(); f.execute.mockRejectedValueOnce(new Error("unknown"));
    await expect(f.miner.analyze(session, [...events, next], [])).rejects.toThrow("unknown");
    await expect(f.miner.analyze(session, [next], [])).rejects.toThrow("native-miner-pending-prefix-unavailable");
    await expect(f.miner.analyze(session, [{ ...events[0]!, kind: "tool_retry" }, next], [])).rejects.toThrow("native-miner-pending-prefix-unavailable");
    await expect(f.miner.analyze(session, [{ ...events[0]!, excerpt: "Different content" }, next], [])).rejects.toThrow("native-miner-input-changed");
    await expect(f.miner.analyze(session, [next, ...events], [])).rejects.toThrow("native-miner-input-invalid");
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("does not reuse completed analysis for edited source content in the same generation", async () => {
    const f = fixture(); await f.miner.analyze(session, events, []);
    await expect(f.miner.analyze(session, [{ ...events[0]!, excerpt: "Corrected source" }], [])).rejects.toThrow("native-miner-input-changed");
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("reprojects cached sanitized results under current policy without old-context dispatch", async () => {
    const f = fixture(); f.execute.mockImplementationOnce(async request => { f.finished(request); const input = JSON.parse(request.input); return f.reply(request, { requestId: input.requestId, failures: [{ eventId: "event-1", kind: "tool_error", symptom: "NEW_PRIVATE_NAME failed", rootCauseHypothesis: "Lost payload", category: "failure", matchedProblemId: null }] }); });
    expect((await f.miner.analyze(session, events, [])).failures[0]!.symptom).toContain("NEW_PRIVATE_NAME");
    f.privacy({ clientNames: ["ClientCorp", "NEW_PRIVATE_NAME"] }, "generation-2"); f.restart();
    const result = await f.miner.analyze(session, events, []);
    expect(result.failures[0]!.symptom).not.toContain("NEW_PRIVATE_NAME"); expect(f.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.store.list("native-mining-operations"))).toContain("NEW_PRIVATE_NAME"); // historical generalized observation is preserved
  });

  it("blocks unfinished old-generation work until cleanup is confirmed, then creates an audited new task", async () => {
    const f = fixture(); f.execute.mockRejectedValueOnce(new Error("unknown delivery"));
    await expect(f.miner.analyze(session, events, [], { runId: "old-run" })).rejects.toThrow("unknown delivery");
    const first = f.execute.mock.calls[0]![0];
    f.privacy({ clientNames: ["ClientCorp", "EVENT_EXCERPT_ONLY"] }, "generation-2");
    await expect(f.miner.analyze(session, events, [], { runId: "new-run" })).rejects.toThrow("native-miner-privacy-changed");
    f.finished(first, "cancelled", { threadId: null, cleanupPending: false });
    await expect(f.miner.analyze(session, events, [], { runId: "new-run" })).rejects.toThrow("native-miner-privacy-changed");
    f.finished(first, "cancelled", { cleanupPending: true });
    await expect(f.miner.analyze(session, events, [], { runId: "new-run" })).rejects.toThrow("native-miner-privacy-changed");
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.finished(first, "cancelled");
    await f.miner.analyze(session, events, [], { runId: "new-run" });
    const second = f.execute.mock.calls[1]![0];
    expect(second.id).not.toEqual(first.id); expect(second.runId).toBe("new-run"); expect(second.input).not.toContain("EVENT_EXCERPT_ONLY");
    expect(f.store.list("native-mining-operations")).toEqual(expect.arrayContaining([expect.objectContaining({ state: "retired", retirementReason: "privacy-generation-changed-after-cleanup", runId: "old-run" })]));
    expect(f.store.audit()).toHaveLength(1);
  });

  it("permits a new generation after a confirmed undispatched cancellation", async () => {
    const f = fixture(); f.execute.mockImplementationOnce(async request => { f.finished(request, "cancelled", { dispatched: false, threadId: null }); throw new Error("not dispatched"); });
    await expect(f.miner.analyze(session, events, [])).rejects.toThrow("not dispatched");
    f.privacy({}, "generation-2"); await f.miner.analyze(session, events, []);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("requires a durable never-dispatch acknowledgement for missing registration across a policy change", async () => {
    const f = fixture(); f.execute.mockRejectedValueOnce(new Error("rejected before registration"));
    await expect(f.miner.analyze(session, events, [], { runId: "old-run" })).rejects.toThrow("rejected before registration");
    const original = f.execute.mock.calls[0]![0]; f.privacy({}, "generation-2");
    const retire = vi.fn((_id: string) => false); f.runner.retireUnregistered = retire;
    await expect(f.miner.analyze(session, events, [], { runId: "new-run" })).rejects.toThrow("native-miner-privacy-changed");
    expect(f.store.audit()).toHaveLength(0);
    retire.mockImplementation(id => { f.store.put("native-task-retirements", id, { taskId: id, neverDispatched: true }); return true; });
    await f.miner.analyze(session, [...events, next], [], { runId: "new-run" });
    expect(retire).toHaveBeenLastCalledWith(original.id);
    expect(f.execute.mock.calls[1]![0]).toMatchObject({ runId: "new-run", privacyGeneration: "generation-2" });
    expect(f.execute.mock.calls[1]![0].id).not.toBe(original.id);
    expect(JSON.parse(f.execute.mock.calls[1]![0].input).events).toHaveLength(1);
    expect(f.store.list("native-mining-operations")).toEqual(expect.arrayContaining([expect.objectContaining({ state: "retired", retirementReason: "privacy-generation-changed-before-dispatch" })]));
  });

  it("does not interpret malformed registry state as an absent registration", async () => {
    const f = fixture(); f.execute.mockImplementationOnce(async request => { f.states.set(request.id, { taskId: request.id, invalid: true }); throw new Error("unknown"); });
    await expect(f.miner.analyze(session, events, [])).rejects.toThrow("unknown");
    f.privacy({}, "generation-2"); const retire = vi.fn(() => true); f.runner.retireUnregistered = retire;
    await expect(f.miner.analyze(session, events, [])).rejects.toThrow("native-miner-privacy-changed");
    expect(retire).not.toHaveBeenCalled(); expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["completion", "failure"])("fences a late %s from a retired miner instance", async outcome => {
    const f = fixture(); let settle!: () => void, entered!: () => void;
    const result = new Promise<void>(resolve => { settle = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    f.execute.mockImplementationOnce(async request => {
      f.finished(request); entered(); await result;
      if (outcome === "failure") throw new Error("late accounting failure");
      return f.reply(request);
    });
    const old = f.miner.analyze(session, events, [], { runId: "old-run" });
    const rejected = expect(old).rejects.toThrow("native-miner-operation-superseded");
    await started; f.privacy({}, "generation-2"); f.restart();
    await f.miner.analyze(session, events, [], { runId: "new-run" });
    const before = f.store.entries("native-mining-operations");
    settle(); await rejected;
    expect(f.store.entries("native-mining-operations")).toEqual(before);
    expect(before.map(entry => (entry.value as any).state).sort()).toEqual(["ready", "retired"]);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("separates retrospective scopes and retains solution/run attribution", async () => {
    const f = fixture();
    await f.miner.analyze(session, events, [], { runId: "live-run" });
    await f.miner.analyze(session, events, [], { analysisScope: "retro_1", runId: "retro-run", solutionId: "solution" });
    await f.miner.analyze(session, events, [], { analysisScope: "retro_2", runId: "retro-2-run", solutionId: "solution" });
    expect(new Set(f.execute.mock.calls.map(([request]) => request.id)).size).toBe(3);
    expect(f.execute.mock.calls[1]![0]).toMatchObject({ stage: "retro", runId: "retro-run", solutionId: "solution" });
  });

  it("rejects wrong evidence identity/kind, unknown problem matches, duplicates and model-supplied prefix metadata", async () => {
    for (const change of [
      { eventId: "invented" }, { kind: "owner_correction" }, { matchedProblemId: "invented-problem" },
    ]) {
      const f = fixture(); f.execute.mockImplementationOnce(async request => { f.finished(request); const value = JSON.parse(f.reply(request).text); Object.assign(value.failures[0], change); return f.reply(request, value); });
      await expect(f.miner.analyze(session, events, [problem])).rejects.toThrow("native-miner-output-invalid");
    }
    for (const mutate of [(value: any) => value.failures.push(value.failures[0]), (value: any) => { value.analyzedEvents = [{ id: "event-1", sequence: 1 }]; }, (value: any) => { value.requestId = randomForeignId; }]) {
      const f = fixture(); f.execute.mockImplementationOnce(async request => { f.finished(request); const value = JSON.parse(f.reply(request).text); mutate(value); return f.reply(request, value); });
      await expect(f.miner.analyze(session, events, [])).rejects.toThrow("native-miner-output-invalid");
    }
  });

  it("matches a supplied alias and treats context-only events as data, not failure evidence", async () => {
    const f = fixture(); f.execute.mockImplementationOnce(async request => { f.finished(request); const value = JSON.parse(f.reply(request).text); value.failures[0].matchedProblemId = "prior-problem"; return f.reply(request, value); });
    expect((await f.miner.analyze(session, events, [problem])).failures[0]!.matchedProblemId).toBe("prior-problem");
    const other = fixture(); other.execute.mockImplementationOnce(async request => { other.finished(request); return other.reply(request, { requestId: JSON.parse(request.input).requestId, failures: [{ eventId: "event-1", kind: "tool_error", symptom: "Failure", rootCauseHypothesis: "Unknown", category: "reliability", matchedProblemId: null }] }); });
    await expect(other.miner.analyze(session, [{ ...events[0]!, kind: "context" }], [])).rejects.toThrow("native-miner-output-invalid");
  });

  it("bounds separately accounted retries after terminal cleanup and never extends an old task", async () => {
    const f = fixture(); f.execute.mockImplementation(async request => { f.finished(request, "failed"); throw new Error("terminal failure"); });
    for (let i = 0; i < 3; i++) await expect(f.miner.analyze(session, events, [], { runId: `run-${i}` })).rejects.toThrow("terminal failure");
    await expect(f.miner.analyze(session, [...events, next], [], { runId: "run-4" })).rejects.toThrow("native-miner-retries-exhausted");
    await expect(f.miner.analyze(session, [...events, next], [], { runId: "run-5" })).rejects.toThrow("native-miner-retries-exhausted");
    await expect(f.miner.analyze(session, [...events, next, { ...next, id: "event-3", sequence: 3 }], [], { runId: "run-6" })).rejects.toThrow("native-miner-retries-exhausted");
    expect(f.execute).toHaveBeenCalledTimes(3); expect(new Set(f.execute.mock.calls.map(([request]) => request.id)).size).toBe(3);
  });

  it("retains the original prefix after a terminal failure and rejects edited input before retirement", async () => {
    const f = fixture(); f.execute.mockImplementationOnce(async request => { f.finished(request, "failed"); throw new Error("terminal failure"); });
    await expect(f.miner.analyze(session, events, [])).rejects.toThrow("terminal failure");
    await expect(f.miner.analyze(session, [{ ...events[0]!, excerpt: "Edited source" }], [])).rejects.toThrow("native-miner-input-changed");
    expect(f.store.audit()).toHaveLength(0); expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await f.miner.analyze(session, [...events, next], [])).toMatchObject({ analyzedEvents: [{ id: "event-1", sequence: 1 }] });
    expect(JSON.parse(f.execute.mock.calls[1]![0].input).events).toHaveLength(1);
  });

  it("preserves the pending prefix if replacement validation or registration fails", async () => {
    const f = fixture(); f.execute.mockImplementation(async request => { f.finished(request, "failed"); throw new Error("terminal failure"); });
    await expect(f.miner.analyze(session, events, [])).rejects.toThrow("terminal failure");
    const original = f.store.entries("native-mining-operations");
    await expect(f.miner.analyze(session, [...events, next], [{ ...problem, causes: [{ id: "cause", text: "" }] }])).rejects.toThrow("native-miner-text-invalid");
    expect(f.store.entries("native-mining-operations")).toEqual(original); expect(f.store.audit()).toHaveLength(0);
    const insert = vi.spyOn(f.store, "insert"); insert.mockReturnValueOnce(false);
    await expect(f.miner.analyze(session, [...events, next], [])).rejects.toThrow("native-miner-concurrent-registration");
    insert.mockRestore();
    expect(f.store.entries("native-mining-operations")).toEqual(original); expect(f.store.audit()).toHaveLength(0);
    await expect(f.miner.analyze(session, [...events, next], [])).rejects.toThrow("terminal failure");
    await expect(f.miner.analyze(session, [...events, next], [])).rejects.toThrow("terminal failure");
    await expect(f.miner.analyze(session, [...events, next], [])).rejects.toThrow("native-miner-retries-exhausted");
    expect(f.execute).toHaveBeenCalledTimes(3);
    expect(f.execute.mock.calls.every(([request]) => JSON.parse(request.input).events.length === 1)).toBe(true);
  });

  it("uses the same native task to retry a missing accounting acknowledgement", async () => {
    const f = fixture(); f.execute.mockImplementationOnce(async request => { f.finished(request); throw new Error("native-task-accounting-pending"); });
    await expect(f.miner.analyze(session, events, [], { runId: "original" })).rejects.toThrow("native-task-accounting-pending");
    await f.miner.analyze(session, events, [], { runId: "later" });
    expect(f.execute.mock.calls[1]![0]).toEqual(f.execute.mock.calls[0]![0]);
  });

  it("serializes calls for one source and rejects malformed input without model work", async () => {
    const f = fixture(); const [left, right] = await Promise.all([f.miner.analyze(session, events, []), f.miner.analyze(session, events, [])]);
    expect(left).toEqual(right); expect(f.execute).toHaveBeenCalledTimes(1);
    for (const badEvents of [[], [events[0]!, events[0]!], [{ ...events[0]!, sequence: -1 }]]) await expect(f.miner.analyze(session, badEvents, [])).rejects.toThrow("native-miner-input-invalid");
    await expect(f.miner.analyze(session, [null] as unknown as MiningEvent[], [])).rejects.toThrow("native-miner-input-invalid");
    await expect(f.miner.analyze({ ...session, day: "2026-99-10" }, events, [])).rejects.toThrow("native-miner-input-invalid");
    await expect(f.miner.analyze({ ...session, threadId: "other-source" }, events, [])).rejects.toThrow("native-miner-source-changed");
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});

const randomForeignId = "80a064ab-3699-4eda-9f90-e9d556ecbe7b";
