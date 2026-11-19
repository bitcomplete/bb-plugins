import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { NativeTaskRunner, type NativeTaskHooks, type NativeTaskRecord, type NativeTaskRequest, type NativeTaskSdk } from "../src/native-tasks.js";
import { MIGRATIONS, Store } from "../src/store.js";
const fixtures: { db: Database.Database; runner: NativeTaskRunner }[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.runner.reconcileCleanup({ timeoutMs: 100 }); f.db.close(); } });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(hooks: NativeTaskHooks = {}) {
  const db = new Database(":memory:"); MIGRATIONS.forEach(sql => db.exec(sql)); const store = new Store(db);
  const metadata = new Map<string, Record<string, unknown>>();
  const methods = { getPluginMetadata: vi.fn(async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {}),
    list: vi.fn(async () => []), stop: vi.fn(async () => ({ ok: true })), archive: vi.fn(async () => ({ ok: true })), spawn: vi.fn(async () => { throw new Error("unexpected dispatch"); }) };
  const sdk = { threads: methods } as unknown as NativeTaskSdk;
  const create = () => new NativeTaskRunner({ store, sdk, now: () => 1000, currentPrivacyGeneration: () => "privacy", hooks });
  const runner = create();
  const seed = (taskId: string, extra: Partial<NativeTaskRecord> = {}) => {
    const thread = { id: `thread-${taskId}`, projectId: "project", providerId: "fixture", environmentId: "environment", originPluginId: "self-improve" };
    const record: NativeTaskRecord = { taskId, nonce: "11111111-1111-4111-8111-111111111111", requestDigest: sha(taskId), promptHash: sha("input"), stage: "builder", runId: "revalidation-run", solutionId: "solution", projectId: "project", providerId: "fixture", model: "model", privacyGeneration: "privacy", permissionMode: "accept-edits", reasoningLevel: null, serviceTier: null, expectedEnvironmentId: "environment", resolvedEnvironmentId: null, threadId: null, state: "dispatching", startedAtMs: 1000, deadlineAtMs: 9000, endedAtMs: null, error: null, outputDigest: null, dispatched: true, active: true, cleanupPending: false, ...extra };
    store.put("native-tasks", taskId, record, 1000);
    if (record.threadId) store.put("native-task-threads", record.threadId, { taskId }, 1000);
    metadata.set(thread.id, { nativeTaskId: taskId, nativeTaskNonce: record.nonce, nativeTaskDigest: record.requestDigest });
    return { record, thread, dispatch: { originPluginId: "self-improve", attempt: "start-turn" as const, inputText: "input", requestedExecution: { providerId: "fixture", model: "model", permissionMode: "accept-edits", reasoningLevel: null, serviceTier: null } } };
  };
  const f = { db, store, methods, runner, create, seed }; fixtures.push(f); return f;
}
const request: NativeTaskRequest = { id: "pending", stage: "builder", runId: "revalidation-run", solutionId: "solution", instructions: "Return JSON", input: "fixture", execution: { projectId: "project", environment: { type: "reuse", environmentId: "environment" }, providerId: "fixture", model: "model" }, privacyGeneration: "privacy" };
it("runs the optional synchronous dispatch guard on each authenticated admission before writing the binding", async () => {
  let allowed = true; const guard = vi.fn((record: Readonly<NativeTaskRecord>) => { expect(Object.isFrozen(record)).toBe(true); if (!allowed) throw new Error("run-revoked"); });
  const f = fixture({ beforeDispatch: guard }), task = f.seed("guarded");
  await f.runner.admit(task.thread, task.dispatch); expect(guard).toHaveBeenCalledWith(expect.objectContaining({ taskId: "guarded", runId: "revalidation-run", threadId: task.thread.id }));
  const before = f.store.get("native-tasks", "guarded"), version = f.store.version("native-tasks", "guarded"); allowed = false;
  await expect(f.runner.admit(task.thread, task.dispatch)).rejects.toThrow("run-revoked");
  expect(guard).toHaveBeenCalledTimes(2); expect(f.store.get("native-tasks", "guarded")).toEqual(before); expect(f.store.version("native-tasks", "guarded")).toBe(version);
});
it("keeps existing callers compatible and rejects accidentally asynchronous dispatch guards", async () => {
  const ordinary = fixture(), task = ordinary.seed("ordinary"); expect((await ordinary.runner.admit(task.thread, task.dispatch))?.state).toBe("running");
  const asynchronous = fixture({ beforeDispatch: async () => {} }), other = asynchronous.seed("async");
  await expect(asynchronous.runner.admit(other.thread, other.dispatch)).rejects.toThrow("must-be-synchronous");
  expect(asynchronous.store.get<NativeTaskRecord>("native-tasks", "async")?.state).toBe("dispatching");
});
it("durably revokes one run's named tasks before cleanup without disposing unrelated work", async () => {
  const settled = vi.fn(async () => {}), f = fixture({ onSettled: settled });
  const target = f.seed("target", { state: "running", threadId: "thread-target", cleanupPending: true }), other = f.seed("unrelated");
  f.runner.revoke(["target", "not-yet-registered"], "owner-cancelled");
  expect(f.store.get<NativeTaskRecord>("native-tasks", "target")).toMatchObject({ state: "cancelled", active: false, error: "owner-cancelled", cleanupPending: true });
  expect(f.methods.stop).not.toHaveBeenCalled();
  await expect(f.runner.admit(target.thread, target.dispatch)).rejects.toThrow("inactive");
  expect((await f.runner.admit(other.thread, other.dispatch))?.state).toBe("running");
  await f.runner.reconcileCleanup({ timeoutMs: 100 });
  expect(f.methods.stop.mock.calls).toEqual([[expect.objectContaining({ threadId: "thread-target" })]]);
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ taskId: "target", status: "cancelled", cleanupPending: false }));
  const reloaded = f.create(); await expect(reloaded.execute({ ...request, id: "not-yet-registered" })).rejects.toThrow("retired-before-dispatch");
});
it("aborts pending admission after durable cancellation and never dispatches it", async () => {
  let entered!: () => void; const admitted = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ beforeStart: async () => { entered(); await new Promise(() => {}); } });
  const execution = f.runner.execute(request); await admitted; f.runner.revoke([request.id], "run-cancelled");
  await expect(execution).rejects.toThrow("run-cancelled");
  expect(f.methods.spawn).not.toHaveBeenCalled(); expect(f.store.get<NativeTaskRecord>("native-tasks", request.id)?.state).toBe("cancelled");
});
it("keeps failed cancellation cleanup durable across reload and leaves completed receipts unchanged", async () => {
  const f = fixture(); f.seed("pending-cleanup", { state: "running", threadId: "thread-pending-cleanup", cleanupPending: true });
  f.seed("complete", { state: "completed", active: false, endedAtMs: 900, threadId: "thread-complete", outputDigest: sha("output") });
  const complete = f.store.get("native-tasks", "complete"); f.methods.stop.mockRejectedValue(new Error("temporarily unavailable"));
  f.runner.revoke(["pending-cleanup", "complete"], "run-cancelled"); await f.runner.reconcileCleanup({ timeoutMs: 100 });
  expect(f.store.get<NativeTaskRecord>("native-tasks", "pending-cleanup")?.cleanupPending).toBe(true); expect(f.store.get("native-tasks", "complete")).toEqual(complete);
  f.methods.stop.mockResolvedValue({ ok: true }); await f.create().reconcileCleanup({ timeoutMs: 100 });
  expect(f.store.get<NativeTaskRecord>("native-tasks", "pending-cleanup")).toMatchObject({ state: "cancelled", active: false, cleanupPending: false });
});
