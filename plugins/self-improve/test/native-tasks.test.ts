import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Store, MIGRATIONS } from "../src/store.js";
import { NativeTaskRunner, type NativeTaskSettlement, type NativeTaskHooks, type NativeTaskRequest, type NativeTaskSdk } from "../src/native-tasks.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const request = (providerId = "codex", id = "task-1"): NativeTaskRequest => ({
  id, stage: "inventor", runId: "run-1", instructions: "Return only JSON with a falsifiable hypothesis.", input: '{"problem":"Retries lose their payload"}',
  execution: { projectId: "project", environment: { type: "reuse", environmentId: "scratch" }, providerId, model: "test-model" }, privacyGeneration: "privacy-1",
});
const dispatchExecution = (input: any) => ({ providerId: input.providerId, model: input.model, permissionMode: input.permissionMode ?? "accept-edits", reasoningLevel: input.reasoningLevel ?? "medium", serviceTier: input.serviceTier ?? "default" });
function fixture(hooks: NativeTaskHooks = {}, coldStart = false) {
  const db = new Database(":memory:"); databases.push(db); for (const migration of MIGRATIONS) db.exec(migration);
  const store = new Store(db), threads = new Map<string, any>(), metadata = new Map<string, any>(), output = new Map<string, string | null>(), history = new Map<string, any[]>();
  let generation = "privacy-1", now = 1000, runner: NativeTaskRunner;
  const methods = {
    spawn: vi.fn(async (input: any) => {
      const thread = { id: `thread-${threads.size + 1}`, projectId: input.projectId, providerId: input.providerId, environmentId: coldStart ? null : input.environment.type === "reuse" ? input.environment.environmentId : "resolved-environment", originPluginId: "self-improve", status: coldStart ? "starting" : "idle", queuedMessageCount: 0, archivedAt: null, deletedAt: null };
      threads.set(thread.id, thread); metadata.set(thread.id, input.pluginMetadata); output.set(thread.id, '{"hypothesis":"Persist the request payload"}');
      await runner.admit(thread, { originPluginId: "self-improve", attempt: "start-turn", inputText: input.prompt, requestedExecution: dispatchExecution(input) });
      const turn = { kind: "turn", turnId: `turn-${thread.id}` }, providerThreadId = `session-${thread.id}`;
      history.set(thread.id, [
        { id: "request", seq: 1, type: "client/turn/requested", threadId: thread.id, scope: { kind: "thread" }, data: { requestId: `request-${thread.id}`, source: "spawn", originPluginId: "self-improve", execution: dispatchExecution(input), target: { kind: "thread-start" }, input: [{ type: "text", text: input.prompt }] } },
        { id: "start", seq: 2, type: "turn/started", threadId: thread.id, scope: turn, data: { providerThreadId } },
        { id: "accepted", seq: 3, type: "turn/input/accepted", threadId: thread.id, scope: turn, data: { clientRequestId: `request-${thread.id}`, providerThreadId } },
        { id: "complete", seq: 4, type: "turn/completed", threadId: thread.id, scope: turn, data: { providerThreadId, status: "completed" } },
      ]); return thread;
    }),
    list: vi.fn(async ({ archived, offset }: any) => offset ? [] : [...threads.values()].filter(t => Boolean(t.archivedAt) === archived)),
    get: vi.fn(async ({ threadId }: any) => threads.get(threadId)),
    getPluginMetadata: vi.fn(async ({ threadId }: any) => metadata.get(threadId) ?? {}),
    wait: vi.fn(async ({ threadId }: any) => { const thread = threads.get(threadId); thread.status = "idle"; thread.environmentId ??= "scratch"; return { matched: true, target: { kind: "status", status: "idle" }, threadId, thread }; }),
    output: vi.fn(async ({ threadId }: any) => ({ output: output.get(threadId) ?? null })),
    events: { list: vi.fn(async ({ threadId }: any) => history.get(threadId) ?? []) },
    stop: vi.fn(async ({ threadId }: any) => { if (threads.has(threadId)) threads.get(threadId).status = "idle"; return { ok: true }; }),
    archive: vi.fn(async ({ threadId }: any) => { if (threads.has(threadId)) threads.get(threadId).archivedAt = now; return { ok: true }; }),
  };
  const sdk = { threads: methods } as unknown as NativeTaskSdk;
  const create = () => new NativeTaskRunner({ store, sdk, currentPrivacyGeneration: () => generation, now: () => now, hooks });
  runner = create();
  return { store, sdk, methods, threads, metadata, output, history, get runner() { return runner; }, restart() { runner = create(); }, setPrivacy(value: string) { generation = value; }, advance(ms: number) { now += ms; } };
}

describe("BB-native semantic tasks", () => {
  it.each(["codex", "claude-code", "another-provider"])("uses the same fresh-thread path with %s", async provider => {
    const beforeStart = vi.fn(async () => {}), onSettled = vi.fn(async () => {}), f = fixture({ beforeStart, onSettled });
    const receipt = await f.runner.execute(request(provider));
    expect(receipt).toMatchObject({ taskId: "task-1", threadId: "thread-1", providerId: provider, model: "test-model", modelIdentitySource: "requested-selection", text: '{"hypothesis":"Persist the request payload"}' });
    const args = f.methods.spawn.mock.calls[0]![0];
    expect(args).toMatchObject({ providerId: provider, visibility: "hidden", parentNotifications: "off", permissionMode: "accept-edits", environment: { type: "reuse", environmentId: "scratch" } });
    expect(args).not.toHaveProperty("parentThreadId"); expect(args).not.toHaveProperty("sourceThreadId");
    expect(args).not.toHaveProperty("max_tokens"); expect(args).not.toHaveProperty("messages");
    expect(beforeStart).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", stage: "inventor", providerId: provider }));
    expect(JSON.stringify(beforeStart.mock.calls)).not.toContain("Retries lose");
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", threadId: "thread-1", status: "completed", dispatched: true, cleanupPending: false }));
    expect(f.methods.stop).toHaveBeenCalledOnce(); expect(f.methods.archive).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(f.store.list("native-tasks"));
    expect(serialized).not.toContain("Retries lose"); expect(serialized).not.toContain("Persist the request payload");
  });

  it("separates tasks and replays a completed identity across restart without another dispatch", async () => {
    const f = fixture(); const first = await f.runner.execute(request());
    await f.runner.execute(request("codex", "task-2")); f.restart();
    expect(await f.runner.execute(request())).toEqual(first);
    expect(f.methods.spawn).toHaveBeenCalledTimes(2);
    expect(f.methods.spawn.mock.calls[0]![0].pluginMetadata.nativeTaskNonce).not.toEqual(f.methods.spawn.mock.calls[1]![0].pluginMetadata.nativeTaskNonce);
    await expect(f.runner.execute({ ...request(), input: "Different problem" })).rejects.toThrow("native-task-input-changed");
    await expect(f.runner.execute({ ...request(), execution: { ...request().execution, providerId: "claude-code" } })).rejects.toThrow("native-task-input-changed");
  });

  it("serializes overlapping calls for the same task without duplicate dispatch or reservation", async () => {
    const beforeStart = vi.fn(async () => {}), f = fixture({ beforeStart });
    const [left, right] = await Promise.all([f.runner.execute(request()), f.runner.execute(request())]);
    expect(left).toEqual(right); expect(beforeStart).toHaveBeenCalledOnce(); expect(f.methods.spawn).toHaveBeenCalledOnce();
  });

  it("durably retires queued unregistered tasks before any reservation or dispatch", async () => {
    const beforeStart = vi.fn(async () => {}), onSettled = vi.fn(async () => {}), f = fixture({ beforeStart, onSettled });
    const queued = f.runner.execute(request());
    expect(f.runner.retireUnregistered("task-1")).toBe(true);
    expect(f.runner.retireUnregistered("task-1")).toBe(true);
    await expect(queued).rejects.toThrow("native-task-retired-before-dispatch");
    f.restart();
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-retired-before-dispatch");
    expect(f.store.get("native-tasks", "task-1")).toBeNull();
    expect(f.store.get("native-task-retirements", "task-1")).toMatchObject({ taskId: "task-1", neverDispatched: true });
    expect(beforeStart).not.toHaveBeenCalled(); expect(onSettled).not.toHaveBeenCalled(); expect(f.methods.spawn).not.toHaveBeenCalled();
    await f.runner.execute(request("codex", "task-2"));
    expect(f.methods.spawn).toHaveBeenCalledOnce();
  });

  it("refuses never-dispatched acknowledgement once registration has won the race", async () => {
    let release!: () => void, entered!: () => void;
    const admission = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture({ beforeStart: async () => { entered(); await admission; } });
    const execution = f.runner.execute(request()); await started;
    expect(f.runner.retireUnregistered("task-1")).toBe(false);
    expect(f.store.get("native-task-retirements", "task-1")).toBeNull();
    release(); await execution;
    expect(f.runner.retireUnregistered("task-1")).toBe(false);
    f.store.put("native-tasks", "malformed", { unknown: true });
    expect(f.runner.retireUnregistered("malformed")).toBe(false);
    expect(f.methods.spawn).toHaveBeenCalledOnce();
  });

  it("can tombstone a request rejected before registration without assuming its absence is proof", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.runner.execute(request(), controller.signal)).rejects.toThrow("native-task-aborted");
    expect(f.store.get("native-tasks", "task-1")).toBeNull();
    expect(f.runner.retireUnregistered("task-1")).toBe(true);
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-retired-before-dispatch");
    expect(f.methods.spawn).not.toHaveBeenCalled();
  });

  it("recovers an acknowledged thread when the spawn response was lost", async () => {
    const f = fixture(), spawn = f.methods.spawn.getMockImplementation()!;
    f.methods.spawn.mockImplementationOnce(async args => { await spawn(args); throw new Error("lost response"); });
    expect(await f.runner.execute(request())).toMatchObject({ threadId: "thread-1" });
    expect(f.methods.spawn).toHaveBeenCalledOnce(); expect(f.methods.stop).toHaveBeenCalledOnce();
  });

  it("recovers an uncertain binding from archived metadata without creating a second task", async () => {
    const f = fixture(); await f.runner.execute(request());
    const record = f.store.get<any>("native-tasks", "task-1");
    f.store.put("native-tasks", "task-1", { ...record, threadId: null, state: "uncertain", outputDigest: null, endedAtMs: null });
    f.store.remove("native-task-threads", "thread-1"); f.restart();
    expect(await f.runner.execute(request())).toMatchObject({ threadId: "thread-1" });
    expect(f.methods.spawn).toHaveBeenCalledOnce();
  });

  it("does not repeat dispatch when no thread can be found after a failed spawn", async () => {
    const f = fixture(); f.methods.spawn.mockRejectedValueOnce(new Error("transport failed"));
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-dispatch-uncertain");
    f.restart(); await expect(f.runner.execute(request())).rejects.toThrow("native-task-dispatch-uncertain");
    expect(f.methods.spawn).toHaveBeenCalledOnce();
    expect(f.store.get("native-tasks", "task-1")).toMatchObject({ state: "uncertain", active: false, threadId: null });
  });

  it("refuses ambiguous recovery and never binds arbitrary matching titles", async () => {
    const f = fixture(); await f.runner.execute(request());
    const record = f.store.get<any>("native-tasks", "task-1");
    f.store.put("native-tasks", "task-1", { ...record, threadId: null, state: "uncertain", outputDigest: null });
    f.threads.set("duplicate", { ...f.threads.get("thread-1"), id: "duplicate" }); f.metadata.set("duplicate", f.metadata.get("thread-1"));
    f.restart(); await expect(f.runner.execute(request())).rejects.toThrow("native-task-ambiguous");
    expect(f.methods.spawn).toHaveBeenCalledOnce();
  });

  it("rejects missing admission integration and stops the created runtime", async () => {
    const f = fixture(); f.methods.spawn.mockImplementationOnce(async input => {
      const thread = { id: "not-admitted", projectId: input.projectId, providerId: input.providerId, model: input.model, environmentId: "scratch", originPluginId: "self-improve", status: "active", queuedMessageCount: 0, archivedAt: null, deletedAt: null };
      f.threads.set(thread.id, thread); f.metadata.set(thread.id, input.pluginMetadata); return thread;
    });
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-gate-not-bound");
    expect(f.methods.stop).toHaveBeenCalledWith(expect.objectContaining({ threadId: "not-admitted" }));
  });

  it("does not start when admission is denied", async () => {
    const onSettled = vi.fn(async () => {}), f = fixture({ beforeStart: async () => { throw new Error("budget full"); }, onSettled });
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-admission-denied");
    expect(f.methods.spawn).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", dispatched: false, threadId: null }));
  });

  it("rejects a new privacy generation before dispatch and old output after policy rotation", async () => {
    const f = fixture(); f.setPrivacy("privacy-2");
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-privacy-changed");
    expect(f.methods.spawn).not.toHaveBeenCalled(); f.setPrivacy("privacy-1");
    await f.runner.execute(request()); f.setPrivacy("privacy-2");
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-privacy-changed");
    expect(f.methods.spawn).toHaveBeenCalledOnce();
  });

  it("rejects a changed actual provider or ownership binding", async () => {
    for (const change of [{ providerId: "another-provider" }, { projectId: "different-project" }, { originPluginId: "other-plugin" }, { environmentId: "another-environment" }]) {
      const f = fixture(); await f.runner.execute(request()); Object.assign(f.threads.get("thread-1"), change);
      await expect(f.runner.execute(request())).rejects.toThrow(/native-task-(binding-mismatch|model-changed|environment-changed)/);
      expect(f.methods.spawn).toHaveBeenCalledOnce();
    }
  });

  it("rejects forged metadata and refuses completed thread reuse", async () => {
    const f = fixture(); await f.runner.execute(request());
    await expect(f.runner.admit(f.threads.get("thread-1"), { originPluginId: "self-improve", attempt: "start-turn", inputText: f.methods.spawn.mock.calls[0]![0].prompt, requestedExecution: dispatchExecution(f.methods.spawn.mock.calls[0]![0]) })).rejects.toThrow("native-task-inactive");
    f.threads.get("thread-1").status = "active";
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-thread-reused");
    f.threads.get("thread-1").status = "idle"; f.metadata.get("thread-1").nativeTaskNonce = "forged";
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-binding-mismatch");
  });

  it("allows initial dispatch rechecks but rejects unrelated submissions and steering", async () => {
    const f = fixture(), spawn = f.methods.spawn.getMockImplementation()!;
    f.methods.spawn.mockImplementationOnce(async input => {
      const thread = await spawn(input), initial = { originPluginId: "self-improve", attempt: "start-turn" as const, inputText: input.prompt, requestedExecution: dispatchExecution(input) };
      expect(await f.runner.admit(thread, initial)).toMatchObject({ threadId: thread.id, state: "running" });
      for (const change of [{ originPluginId: null }, { originPluginId: "other-plugin" }, { attempt: "join-turn" as const }, { inputText: "Unrelated follow-up" }]) {
        await expect(f.runner.admit(thread, { ...initial, ...change })).rejects.toThrow("native-task-dispatch-mismatch");
      }
      return thread;
    });
    expect(await f.runner.execute(request())).toMatchObject({ requestId: "request-thread-1", turnId: "turn-thread-1" });
  });


  it("waits through asynchronous BB environment provisioning before accepting a result", async () => {
    const f = fixture({}, true);
    expect(await f.runner.execute(request())).toMatchObject({ threadId: "thread-1" });
    expect(f.methods.wait).toHaveBeenCalledOnce();
    expect(f.store.get("native-tasks", "task-1")).toMatchObject({ resolvedEnvironmentId: "scratch", state: "completed" });
  });

  it("requires a resolved environment for the completed result", async () => {
    const f = fixture({}, true);
    f.methods.wait.mockImplementationOnce(async ({ threadId }: any) => {
      const thread = f.threads.get(threadId); thread.status = "idle";
      return { matched: true, target: { kind: "status", status: "idle" }, threadId, thread };
    });
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-environment-unresolved");
  });

  it("checks the authoritative request execution when ThreadResponse has no model field", async () => {
    for (const change of [{ model: "different-model" }, { permissionMode: "full" }, { reasoningLevel: "low" }, { serviceTier: "another-tier" }]) {
      const f = fixture(), task = { ...request(), execution: { ...request().execution, reasoningLevel: "high" as const, serviceTier: "fast" } };
      await f.runner.execute(task);
      expect(f.threads.get("thread-1")).not.toHaveProperty("model");
      Object.assign(f.history.get("thread-1")![0].data.execution, change);
      await expect(f.runner.execute(task)).rejects.toThrow(/native-task-(model|execution)-changed/);
      expect(f.methods.spawn).toHaveBeenCalledOnce();
    }
  });

  it("rejects changed dispatch execution before approving the native task", async () => {
    const f = fixture(), spawn = f.methods.spawn.getMockImplementation()!;
    f.methods.spawn.mockImplementationOnce(async input => {
      const thread = await spawn(input);
      await expect(f.runner.admit(thread, { originPluginId: "self-improve", attempt: "start-turn", inputText: input.prompt, requestedExecution: { ...dispatchExecution(input), model: "changed" } })).rejects.toThrow("native-task-model-changed");
      return thread;
    });
    await f.runner.execute(request());
  });

  it("pins an initially resolved environment and rejects subsequent relocation", async () => {
    const f = fixture(), task = { ...request(), execution: { ...request().execution, environment: { type: "project-default" as const } } };
    await f.runner.execute(task);
    expect(f.store.get("native-tasks", task.id)).toMatchObject({ expectedEnvironmentId: null, resolvedEnvironmentId: "resolved-environment" });
    f.threads.get("thread-1").environmentId = "moved";
    await expect(f.runner.execute(task)).rejects.toThrow("native-task-environment-changed");
  });

  it("rejects additional requested/root turns, unmatched acceptance and non-success completion", async () => {
    for (const mutate of [
      (events: any[]) => events.push({ ...events[0], id: "other-request", seq: 5, data: { ...events[0].data, requestId: "other", source: "tell" } }),
      (events: any[]) => events.push({ ...events[1], id: "other-start", seq: 5, scope: { kind: "turn", turnId: "other" } }),
      (events: any[]) => { events[2].data.clientRequestId = "other"; },
      (events: any[]) => { events[3].data.status = "interrupted"; },
      (events: any[]) => { events[0].data.input[0].text = "Unrelated task"; },
    ]) {
      const f = fixture(), spawn = f.methods.spawn.getMockImplementation()!;
      f.methods.spawn.mockImplementationOnce(async input => { const thread = await spawn(input); mutate(f.history.get(thread.id)!); return thread; });
      await expect(f.runner.execute(request())).rejects.toThrow(/native-task-turn-(history-unmatched|not-completed)/);
      expect(f.methods.stop).toHaveBeenCalledOnce();
    }
  });

  it("rechecks turn identity after reading output to catch intervening thread reuse", async () => {
    const f = fixture(), read = f.methods.output.getMockImplementation()!;
    f.methods.output.mockImplementationOnce(async args => {
      const result = await read(args), events = f.history.get(args.threadId)!;
      events.push({ ...events[0], id: "intervening", seq: 5 }); return result;
    });
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-turn-history-unmatched");
  });

  it.each([null, "", "  ", "x".repeat(200001)])("rejects absent/empty/oversized output (%#)", async bad => {
    const f = fixture(); f.methods.output.mockResolvedValue({ output: bad });
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-output-invalid");
    expect(f.methods.stop).toHaveBeenCalledOnce(); expect(f.store.get("native-tasks", "task-1")).toMatchObject({ state: "failed", active: false });
  });

  it("rejects changed stored output rather than attributing a later turn to the original task", async () => {
    const f = fixture(); await f.runner.execute(request()); f.output.set("thread-1", "Different answer");
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-output-changed");
  });

  it("cancels even a wait implementation that ignores its AbortSignal, then stops and archives", async () => {
    const f = fixture(), controller = new AbortController(), spawn = f.methods.spawn.getMockImplementation()!;
    f.methods.spawn.mockImplementation(async args => { const thread = await spawn(args); thread.status = "active"; return thread; });
    f.methods.wait.mockImplementation(async () => { controller.abort(); return new Promise<never>(() => {}); });
    await expect(f.runner.execute(request(), controller.signal)).rejects.toThrow("native-task-aborted");
    expect(f.methods.stop).toHaveBeenCalledOnce(); expect(f.methods.archive).toHaveBeenCalledOnce();
    expect(f.store.get("native-tasks", "task-1")).toMatchObject({ state: "cancelled", active: false });
  });

  it("records timeout and keeps cleanup failures pending until reconciliation", async () => {
    const f = fixture(), spawn = f.methods.spawn.getMockImplementation()!;
    f.methods.spawn.mockImplementation(async args => { const thread = await spawn(args); thread.status = "active"; return thread; });
    f.methods.wait.mockImplementationOnce(async () => { f.advance(200000); throw new Error("SDK wait timeout"); });
    f.methods.stop.mockRejectedValueOnce(new Error("stop unavailable"));
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-timeout");
    expect(f.store.get("native-tasks", "task-1")).toMatchObject({ state: "failed", error: "native-task-timeout", cleanupPending: true });
    await f.runner.reconcileCleanup();
    expect(f.methods.stop).toHaveBeenCalledTimes(2); expect(f.store.get("native-tasks", "task-1")).toMatchObject({ cleanupPending: false });
  });

  it("preserves completion when accounting fails and retries its receipt without another model task", async () => {
    const onSettled = vi.fn(async () => {}); onSettled.mockRejectedValueOnce(new Error("ledger unavailable")); const f = fixture({ onSettled });
    await expect(f.runner.execute(request())).rejects.toThrow("native-task-accounting-pending");
    expect(f.store.get("native-tasks", "task-1")).toMatchObject({ state: "completed" });
    expect(await f.runner.execute(request())).toMatchObject({ threadId: "thread-1" });
    expect(f.methods.spawn).toHaveBeenCalledOnce(); expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("revokes admission and cleans up on dispose", async () => {
    const f = fixture(); await f.runner.execute(request()); await f.runner.dispose();
    await expect(f.runner.execute(request("codex", "task-2"))).rejects.toThrow("native-task-disposed");
    expect(f.methods.spawn).toHaveBeenCalledOnce();
  });
  it("limits cleanup work and continues fairly after restart even when early identities keep failing", async () => {
    const f=fixture();for(const name of ["a","b","c"]){await f.runner.execute(request("codex",name));const record=f.store.get<any>("native-tasks",name);f.store.put("native-tasks",name,{...record,cleanupPending:true});}
    f.methods.stop.mockClear();f.methods.archive.mockClear();f.methods.stop.mockRejectedValue(new Error("offline"));
    expect(await f.runner.reconcileCleanup({maxTasks:2})).toEqual({checked:2,pending:3});
    expect(f.methods.stop.mock.calls.map(([arg])=>arg.threadId)).toEqual(["thread-1","thread-2"]);
    f.restart();f.methods.stop.mockClear();f.methods.stop.mockResolvedValue({ok:true});
    expect(await f.runner.reconcileCleanup({maxTasks:2})).toEqual({checked:2,pending:1});
    expect(f.methods.stop.mock.calls.map(([arg])=>arg.threadId)).toEqual(["thread-3","thread-1"]);
    expect(await f.runner.reconcileCleanup({maxTasks:2})).toEqual({checked:1,pending:0});
    expect(f.methods.spawn).toHaveBeenCalledTimes(3);
  });

  it("revokes every privacy-stale task synchronously before bounded cleanup or caller cancellation", async () => {
    const f=fixture();for(const name of ["a","b","c"]){await f.runner.execute(request("codex",name));const record=f.store.get<any>("native-tasks",name);f.store.put("native-tasks",name,{...record,state:"running",active:true,endedAtMs:null,cleanupPending:true});}
    f.setPrivacy("privacy-2");f.methods.stop.mockClear();f.methods.archive.mockClear();
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    f.methods.stop.mockImplementation(async()=>{entered();return new Promise<never>(()=>{});});
    const controller=new AbortController(),sweep=f.runner.reconcileCleanup({maxTasks:1,signal:controller.signal});const rejected=expect(sweep).rejects.toThrow();
    expect(f.store.list<any>("native-tasks").every(record=>!record.active&&record.state==="cancelled")).toBe(true);
    await started;controller.abort();await rejected;
    expect(f.methods.stop).toHaveBeenCalledOnce();expect(f.methods.archive).not.toHaveBeenCalled();
    expect(f.store.list<any>("native-tasks").every(record=>record.cleanupPending)).toBe(true);
  });

  it("bounds total cleanup elapsed work when an SDK stop ignores AbortSignal", async () => {
    const f=fixture();for(const name of ["a","b","c"]){await f.runner.execute(request("codex",name));const record=f.store.get<any>("native-tasks",name);f.store.put("native-tasks",name,{...record,cleanupPending:true});}
    f.methods.stop.mockClear();f.methods.archive.mockClear();f.methods.stop.mockImplementation(async()=>new Promise<never>(()=>{}));
    expect(await f.runner.reconcileCleanup({maxTasks:100,timeoutMs:10})).toEqual({checked:1,pending:3});
    expect(f.methods.stop).toHaveBeenCalledOnce();expect(f.methods.archive).not.toHaveBeenCalled();
    f.restart();f.methods.stop.mockClear();f.methods.stop.mockResolvedValue({ok:true});
    await f.runner.reconcileCleanup({maxTasks:1});expect(f.methods.stop.mock.calls[0]![0].threadId).toBe("thread-2");
  });

  it("bounds unresolved-identity recovery and moves its cursor past a stalled search", async () => {
    const f=fixture();for(const name of ["a","b"]){await f.runner.execute(request("codex",name));const record=f.store.get<any>("native-tasks",name);f.store.put("native-tasks",name,{...record,threadId:null,state:"uncertain",cleanupPending:true});}
    const list=f.methods.list.getMockImplementation()!;f.methods.list.mockClear();f.methods.list.mockImplementation(async()=>new Promise<never>(()=>{}));
    expect(await f.runner.reconcileCleanup({timeoutMs:10})).toEqual({checked:1,pending:2});
    expect(f.methods.list).toHaveBeenCalledOnce();
    f.restart();f.methods.list.mockImplementation(list);await f.runner.reconcileCleanup({maxTasks:1});
    expect(f.store.get("native-tasks","b")).toMatchObject({threadId:"thread-2",active:false,cleanupPending:false});
    expect(f.store.get("native-tasks","a")).toMatchObject({threadId:null,cleanupPending:true});expect(f.methods.spawn).toHaveBeenCalledTimes(2);
  });

  it("retries failed settlement acknowledgements fairly without replaying settled history", async () => {
    const onSettled=vi.fn(async(_settlement:NativeTaskSettlement)=>{}),f=fixture({onSettled});for(const name of ["a","b"]){await f.runner.execute(request("codex",name));f.store.remove("native-task-settlements",name);}
    onSettled.mockClear();onSettled.mockRejectedValueOnce(new Error("ledger unavailable"));
    expect(await f.runner.reconcileCleanup({maxTasks:2})).toEqual({checked:2,pending:1});expect(onSettled).toHaveBeenCalledTimes(2);
    f.restart();expect(await f.runner.reconcileCleanup()).toEqual({checked:1,pending:0});
    expect(onSettled).toHaveBeenCalledTimes(3);expect(await f.runner.reconcileCleanup()).toEqual({checked:0,pending:0});expect(onSettled).toHaveBeenCalledTimes(3);
    expect(f.methods.spawn).toHaveBeenCalledTimes(2);
  });

  it("disposes within one cleanup budget and leaves the entire remaining backlog revoked for reload", async () => {
    const f=fixture();for(const name of ["a","b","c"]){await f.runner.execute(request("codex",name));const record=f.store.get<any>("native-tasks",name);f.store.put("native-tasks",name,{...record,state:"running",active:true,endedAtMs:null,cleanupPending:true});}
    f.methods.stop.mockClear();f.methods.archive.mockClear();f.methods.stop.mockImplementation(async()=>new Promise<never>(()=>{}));
    const disposal=f.runner.dispose({timeoutMs:10,maxTasks:1});
    expect(f.store.list<any>("native-tasks").every(record=>!record.active&&record.state==="cancelled")).toBe(true);
    await disposal;expect(f.methods.stop).toHaveBeenCalledOnce();expect(f.methods.archive).not.toHaveBeenCalled();
    await expect(f.runner.execute(request("codex","new"))).rejects.toThrow("native-task-disposed");
    f.restart();f.methods.stop.mockClear();f.methods.stop.mockResolvedValue({ok:true});await f.runner.reconcileCleanup({maxTasks:1});
    expect(f.methods.stop.mock.calls[0]![0].threadId).toBe("thread-2");
  });

  it("does not let a late executing turn resurrect an expired task revoked by reconciliation", async () => {
    const f=fixture({},true);let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const wait=f.methods.wait.getMockImplementation()!;f.methods.wait.mockImplementationOnce(async args=>{entered();await gate;return wait(args);});
    const running=f.runner.execute(request()),rejected=expect(running).rejects.toThrow("native-task-timeout");await started;f.advance(200000);
    await f.runner.reconcileCleanup({maxTasks:1});expect(f.store.get("native-tasks","task-1")).toMatchObject({active:false,state:"cancelled"});
    release();await rejected;expect(f.store.get("native-tasks","task-1")).toMatchObject({active:false,state:"cancelled"});expect(f.methods.output).not.toHaveBeenCalled();
  });

  it("includes stalled settlement acknowledgement in the sweep deadline and retries it later", async () => {
    const onSettled=vi.fn(async(_settlement:NativeTaskSettlement)=>{}),f=fixture({onSettled});for(const name of ["a","b"]){await f.runner.execute(request("codex",name));f.store.remove("native-task-settlements",name);}
    onSettled.mockClear();onSettled.mockImplementationOnce(async()=>new Promise<never>(()=>{}));
    expect(await f.runner.reconcileCleanup({timeoutMs:10})).toEqual({checked:1,pending:2});expect(onSettled).toHaveBeenCalledOnce();
    f.restart();expect(await f.runner.reconcileCleanup({maxTasks:1})).toEqual({checked:1,pending:1});
    expect(onSettled.mock.calls[1]?.[0]).toMatchObject({taskId:"b"});
    expect(await f.runner.reconcileCleanup()).toEqual({checked:1,pending:0});expect(f.methods.spawn).toHaveBeenCalledTimes(2);
  });

});
