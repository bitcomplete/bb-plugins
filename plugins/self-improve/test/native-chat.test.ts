import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeChatManager, NATIVE_CHAT_INSTRUCTION, type NativeChatDispatch, type NativeChatRecord } from "../src/native-chat.js";
import { Store, MIGRATIONS } from "../src/store.js";
import type { NativeExecution, NativeTaskSdk } from "../src/native-tasks.js";
import type { PrivacyPolicy } from "../src/adapters/privacy.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const run = { selection: { kind: "problem" as const, id: "problem-one" }, context: "PrivateClient failed a retry" };
function fixture(providerId = "codex") {
  const db = new Database(":memory:"); databases.push(db); MIGRATIONS.forEach(sql => db.exec(sql)); const store = new Store(db);
  let execution: NativeExecution = { projectId: "project", environment: { type: "reuse", environmentId: "scratch" }, providerId, model: "selected", reasoningLevel: "high", serviceTier: "default", permissionMode: "accept-edits" };
  let generation = "generation-1", policy: PrivacyPolicy = { clientNames: ["PrivateClient"] }, manager: NativeChatManager;
  const threads = new Map<string, any>(), metadata = new Map<string, any>(), events = new Map<string, any[]>();
  const beforeDispatch = vi.fn(async () => {});
  const dispatch = (text: string, initial = false): NativeChatDispatch => ({ input: { blocks: [{ type: "text", text, mentions: [] }], text },
    originPluginId: initial ? "self-improve" : null, senderThreadId: null, initiator: initial ? "agent" : "user", attempt: "start-turn", queuedMessages: [],
    requestedExecution: { providerId: execution.providerId, model: execution.model, permissionMode: execution.permissionMode ?? "accept-edits", reasoningLevel: execution.reasoningLevel ?? null, serviceTier: execution.serviceTier ?? null } });
  const methods = {
    spawn: vi.fn(async (input: any) => {
      const thread = { id: `chat-${threads.size + 1}`, projectId: input.projectId, providerId: input.providerId, environmentId: input.environment.type === "reuse" ? input.environment.environmentId : "resolved", originPluginId: "self-improve", archivedAt: null, deletedAt: null };
      threads.set(thread.id, thread); metadata.set(thread.id, input.pluginMetadata); events.set(thread.id, []);
      await manager.admit(thread, dispatch(input.prompt, true)); return thread;
    }),
    get: vi.fn(async ({ threadId }: any) => threads.get(threadId)), getPluginMetadata: vi.fn(async ({ threadId }: any) => metadata.get(threadId) ?? {}),
    list: vi.fn(async ({ archived, offset }: any) => offset ? [] : [...threads.values()].filter(thread => Boolean(thread.archivedAt) === archived)),
    stop: vi.fn(async () => ({ ok: true })), archive: vi.fn(async ({ threadId }: any) => { threads.get(threadId).archivedAt = 100; return { ok: true }; }),
    events: { list: vi.fn(async ({ threadId, types, afterSeq, limit }: any) => (events.get(threadId) ?? []).filter(row => types.includes(row.type) && row.seq > Number(afterSeq ?? -1)).slice(0, Number(limit))) },
  };
  const sdk = { threads: methods } as unknown as NativeTaskSdk;
  const create = () => new NativeChatManager({ store, sdk, execution: () => execution, privacy: () => policy, privacyGeneration: () => generation, hooks: { beforeDispatch }, now: () => 1000 });
  manager = create();
  return { store, sdk, methods, threads, metadata, events, dispatch, beforeDispatch, get manager() { return manager; },
    restart() { manager = create(); }, privacy(p: PrivacyPolicy, g: string) { policy = p; generation = g; }, execution(patch: Partial<NativeExecution>) { execution = { ...execution, ...patch }; } };
}

describe("native ledger chat", () => {
  it.each(["codex", "claude-code", "other-provider"])("uses the same ordinary BB conversation with %s and preserves owner history", async provider => {
    const f = fixture(provider), first = await f.manager.chat(run);
    f.store.put("annotations", "owner-note", { text: "Keep this edit" }); f.restart();
    expect(await f.manager.chat({ ...run, context: "Updated ledger summary" })).toEqual(first);
    expect(f.methods.spawn).toHaveBeenCalledOnce(); expect(f.store.get("annotations", "owner-note")).toEqual({ text: "Keep this edit" });
    expect(f.methods.spawn.mock.calls[0]![0]).toMatchObject({ providerId: provider, model: "selected", reasoningLevel: "high", serviceTier: "default", permissionMode: "accept-edits" });
    expect(f.methods.spawn.mock.calls[0]![0].prompt).toContain(NATIVE_CHAT_INSTRUCTION);
    expect(f.methods.spawn.mock.calls[0]![0].prompt).not.toContain("PrivateClient");
    expect(JSON.stringify(f.store.list("native-chats"))).not.toContain("failed a retry");
    expect(f.manager.get(first.threadId)).toMatchObject({ active: true, role: "chat", selection: run.selection });
    expect(f.beforeDispatch).toHaveBeenCalledWith(expect.objectContaining({ mode: "manual-chat", initial: true, providerId: provider }));
    expect(JSON.stringify(f.beforeDispatch.mock.calls)).not.toContain("retry");
  });

  it("scopes identities to selection and solution attribution", async () => {
    const f = fixture(), first = await f.manager.chat(run);
    const solution = await f.manager.chat({ selection: { kind: "solution", id: "solution-one" }, context: "A solution" });
    expect(solution.threadId).not.toBe(first.threadId);
    expect(f.manager.get(solution.threadId)).toMatchObject({ solutionId: "solution-one" });
    await expect(f.manager.chat({ selection: { kind: "solution", id: "solution-one" }, solutionId: "other", context: "" })).rejects.toThrow("native-chat-selection-invalid");
  });

  it("revalidates owner follow-ups and steers, while rejecting other agents and changed execution", async () => {
    const f = fixture(), { threadId } = await f.manager.chat(run), thread = f.threads.get(threadId);
    const owner = f.dispatch("Explain the evidence");
    expect(await f.manager.admit(thread, owner)).toMatchObject({ active: true });
    expect(await f.manager.admit(thread, { ...owner, attempt: "join-turn" })).toMatchObject({ active: true });
    for (const patch of [{ initiator: "agent" }, { initiator: "system" }, { senderThreadId: "other-agent" }, { originPluginId: "other-plugin" }, { initiator: "mixed" }]) {
      await expect(f.manager.admit(thread, { ...owner, ...patch } as NativeChatDispatch)).rejects.toThrow("native-chat-dispatch-rejected");
    }
    for (const patch of [{ model: "different" }, { providerId: "different" }, { reasoningLevel: "low" }, { serviceTier: "other" }, { permissionMode: "full" }]) {
      await expect(f.manager.admit(thread, { ...owner, requestedExecution: { ...owner.requestedExecution, ...patch } } as NativeChatDispatch)).rejects.toThrow("native-chat-execution-changed");
    }
    expect(f.beforeDispatch).toHaveBeenCalledTimes(3);
  });

  it("requires shared admission and rechecks revocation after an asynchronous admission decision", async () => {
    const f = fixture(), { threadId } = await f.manager.chat(run), thread = f.threads.get(threadId);
    f.beforeDispatch.mockRejectedValueOnce(new Error("budget denied"));
    await expect(f.manager.admit(thread, f.dispatch("More"))).rejects.toThrow("native-chat-admission-denied");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    f.beforeDispatch.mockImplementationOnce(async () => { entered(); await gate; });
    const admission = f.manager.admit(thread, f.dispatch("More")); const rejected = expect(admission).rejects.toThrow("native-chat-inactive");
    await started; await f.manager.revoke(threadId); release(); await rejected;
    expect(f.manager.get(threadId)?.active).toBe(false);
  });

  it("revokes and reopens after privacy or execution changes without rewriting old context", async () => {
    const f = fixture(), first = await f.manager.chat(run);
    f.privacy({ clientNames: ["PrivateClient", "failed"] }, "generation-2");
    expect(f.manager.get(first.threadId)?.active).toBe(false);
    const second = await f.manager.chat(run); expect(second.threadId).not.toBe(first.threadId);
    expect(f.methods.spawn.mock.calls[1]![0].prompt).not.toContain("failed");
    f.execution({ model: "another", environment: { type: "reuse", environmentId: "another-env" } });
    const third = await f.manager.chat(run); expect(third.threadId).not.toBe(second.threadId);
    expect(f.manager.get(first.threadId)?.state).toBe("revoked"); expect(f.methods.stop).toHaveBeenCalledTimes(2);
  });

  it("recovers a lost spawn response without a second thread or initial prompt", async () => {
    const f = fixture(), spawn = f.methods.spawn.getMockImplementation()!;
    f.methods.spawn.mockImplementationOnce(async input => { await spawn(input); throw new Error("response lost"); });
    const first = await f.manager.chat(run); f.restart(); expect(await f.manager.chat(run)).toEqual(first);
    expect(f.methods.spawn).toHaveBeenCalledOnce();
  });

  it("does not guess a rerun after an uncertain spawn, or trust forged metadata", async () => {
    const f = fixture(); f.methods.spawn.mockRejectedValueOnce(new Error("response lost"));
    await expect(f.manager.chat(run)).rejects.toThrow("native-chat-spawn-uncertain"); f.restart();
    await expect(f.manager.chat(run)).rejects.toThrow("native-chat-spawn-uncertain"); expect(f.methods.spawn).toHaveBeenCalledOnce();
    const record = f.store.list<NativeChatRecord>("native-chats")[0]!;
    const fake = { id: "fake", projectId: "project", providerId: "codex", environmentId: "scratch", originPluginId: "self-improve" };
    f.metadata.set("fake", { nativeChatId: record.chatId, nativeChatNonce: "wrong" });
    await expect(f.manager.admit(fake, f.dispatch("anything", true))).rejects.toThrow("native-chat-binding-mismatch");
  });

  it("pins environment and rejects relocated or foreign-project conversations", async () => {
    const f = fixture(), { threadId } = await f.manager.chat(run), thread = f.threads.get(threadId);
    await expect(f.manager.admit({ ...thread, environmentId: "moved" }, f.dispatch("More"))).rejects.toThrow("native-chat-environment-changed");
    await expect(f.manager.admit({ ...thread, projectId: "foreign" }, f.dispatch("More"))).rejects.toThrow("native-chat-binding-mismatch");
  });

  it("retains cleanup failures and blocks replacement until cleanup succeeds", async () => {
    const f = fixture(), { threadId } = await f.manager.chat(run);
    f.methods.stop.mockRejectedValue(new Error("unavailable")); await f.manager.revoke(threadId);
    await expect(f.manager.chat(run)).rejects.toThrow("native-chat-cleanup-unconfirmed"); expect(f.methods.spawn).toHaveBeenCalledOnce();
    f.methods.stop.mockResolvedValue({ ok: true }); await f.manager.reconcile();
    expect((await f.manager.chat(run)).threadId).not.toBe(threadId);
  });

  it("preserves established chats across disposal/reload, and serializes same-selection open", async () => {
    const f = fixture(), [a, b] = await Promise.all([f.manager.chat(run), f.manager.chat(run)]); expect(a).toEqual(b);
    await f.manager.dispose(); expect(f.methods.stop).not.toHaveBeenCalled(); f.restart();
    expect(await f.manager.chat(run)).toEqual(a); expect(f.methods.spawn).toHaveBeenCalledOnce();
  });

  it("collects unique public requests/root turns and whole-conversation snapshots without persisting message text", async () => {
    const f = fixture(), { threadId } = await f.manager.chat(run);
    const event = (seq: number, type: string, data: unknown, turnId: string | null = "turn-1") => ({ id: `event-${seq}`, seq, type, threadId, createdAt: 1000 + seq, scope: turnId ? { kind: "turn", turnId } : { kind: "thread" }, data });
    const tokens = (totalTokens: number) => ({ totalTokens, inputTokens: totalTokens - 10, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2 });
    f.events.set(threadId, [
      event(1, "client/turn/requested", { requestId: "req-1", input: [{ type: "text", text: "private message" }] }, null),
      event(2, "turn/started", {}), event(3, "turn/started", { parentToolCallId: "tool" }, "nested"), event(4, "turn/completed", { status: "completed" }),
      event(5, "thread/tokenUsage/updated", { providerThreadId: "session", tokenUsage: { total: tokens(100), last: tokens(100) } }),
      event(6, "thread/tokenUsage/updated", { providerThreadId: "session", tokenUsage: { total: tokens(150), last: tokens(50) } }),
      event(7, "thread/contextWindowUsage/updated", { providerThreadId: "session", contextWindowUsage: { cost: { amount: 1, currency: "USD" } } }),
      event(8, "thread/contextWindowUsage/updated", { providerThreadId: "session", contextWindowUsage: { cost: { amount: 1.5, currency: "USD" } } }),
    ]);
    const first = await f.manager.collect(threadId), second = await f.manager.collect(threadId);
    expect(second).toEqual(first); expect(first).toMatchObject({ requests: 1, rootTurns: 1, completedRootTurns: 1, countsCaughtUp: true, billingCompleteness: "unknown" });
    expect(first.usage.sessions[0]).toMatchObject({ tokens: { totalTokens: 150 }, cost: { amount: 1.5, currency: "USD" } });
    expect(first.requestEvents).toEqual([{ requestId: "req-1", atMs: 1001, turnId: null }]); expect(first.costObservations).toHaveLength(2);
    expect(f.manager.observations()[0]).toMatchObject({ requests: [{ requestId: "req-1", atMs: 1001 }], turns: [{ turnId: "turn-1", atMs: 1002, completed: true }], costObservations: [
      { eventId: "event-7", sequence: 7, atMs: 1007, providerSessionId: "session", cost: { amount: 1, currency: "USD" } },
      { eventId: "event-8", sequence: 8, atMs: 1008, providerSessionId: "session", cost: { amount: 1.5, currency: "USD" } },
    ] });
    expect(JSON.stringify(f.store.list("native-chat-events"))).not.toContain("private message");
    f.events.get(threadId)!.push(event(9, "thread/contextWindowUsage/updated", { providerThreadId: "new-session", contextWindowUsage: {} }));
    expect((await f.manager.collect(threadId)).usage.sessions[1]!.cost).toBeNull();
    expect(f.manager.observations()[0]!.costObservations.at(-1)!.cost).toBeNull();
    expect(f.store.list("native-accounting-tasks")).toEqual([]);
  });

  it("revokes ledger access under invalid configuration while keeping accounting readable", async () => {
    const f = fixture(), { threadId } = await f.manager.chat(run);
    f.execution({ model: "" });
    expect(f.manager.owns(threadId)).toBe(true); expect(f.manager.get(threadId)?.active).toBe(false);
    await f.manager.reconcile();
    expect(f.manager.get(threadId)?.state).toBe("revoked"); expect(f.manager.observations()[0]?.threadId).toBe(threadId);
    await expect(f.manager.chat(run)).rejects.toThrow("native-chat-execution-invalid");
  });

  it("collects late reports from revoked chats with a durable round-robin cursor", async () => {
    const f = fixture(), first = await f.manager.chat(run), second = await f.manager.chat({ ...run, selection: { kind: "problem", id: "two" } });
    await f.manager.revoke(first.threadId);
    const row = (threadId: string) => ({ id: `cost-${threadId}`, seq: 1, type: "thread/contextWindowUsage/updated", threadId, createdAt: 1001, scope: { kind: "thread" }, data: { providerThreadId: `session-${threadId}`, contextWindowUsage: { cost: { amount: 2, currency: "USD" } } } });
    f.events.set(first.threadId, [row(first.threadId)]); f.events.set(second.threadId, [row(second.threadId)]);
    expect(await f.manager.reconcileUsage({ maxChats: 1 })).toMatchObject({ checked: 1, pending: 1 });
    f.restart(); expect(await f.manager.reconcileUsage({ maxChats: 1 })).toEqual({ checked: 1, pending: 0 });
    expect(f.manager.observations().every(chat => chat.usage.sessions[0]?.cost?.amount === 2)).toBe(true);
    expect(f.methods.spawn).toHaveBeenCalledTimes(2);
    await expect(f.manager.reconcileUsage({ maxChats: 101 })).rejects.toThrow("native-chat-reconcile-limit-invalid");
  });

  it("retains unknown retrieval state on errors and resumes without repeating counts", async () => {
    const f = fixture(), { threadId } = await f.manager.chat(run);
    f.methods.events.list.mockRejectedValue(new Error("temporarily offline"));
    expect(await f.manager.reconcileUsage()).toEqual({ checked: 1, pending: 1 });
    expect(f.manager.accounting(threadId)).toMatchObject({ countsCaughtUp: false, countsIssue: "native-chat-counts-unavailable", requests: 0 });
    f.methods.events.list.mockResolvedValue([]); expect(await f.manager.reconcileUsage()).toEqual({ checked: 1, pending: 0 });
    expect(f.manager.accounting(threadId).usage.sessions).toEqual([]);
  });

  it("disposal interrupts pending event retrieval and leaves chats durable for reload", async () => {
    const f = fixture(), { threadId } = await f.manager.chat(run);
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.methods.events.list.mockImplementation(async () => { entered(); return new Promise(() => {}); });
    const collection = f.manager.collect(threadId); const rejected = expect(collection).rejects.toThrow();
    await waiting; await f.manager.dispose(); await rejected;
    expect(f.store.list<NativeChatRecord>("native-chats")[0]?.state).toBe("active");
    expect(f.methods.stop).not.toHaveBeenCalled();
  });


  it("does not register or spawn a replacement when its open is cancelled during reconciliation", async () => {
    const f = fixture(), { threadId } = await f.manager.chat(run);
    f.methods.stop.mockRejectedValueOnce(new Error("temporarily unavailable"));
    await f.manager.revoke(threadId);
    let entered!: () => void, release!: () => void, cleaned!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cleanupFinished = new Promise<void>(resolve => { cleaned = resolve; });
    f.methods.stop.mockImplementationOnce(async () => { entered(); await gate; return { ok: true }; });
    const archive = f.methods.archive.getMockImplementation()!;
    f.methods.archive.mockImplementationOnce(async input => { const value = await archive(input); cleaned(); return value; });
    const controller = new AbortController();
    const opening = f.manager.chat({ ...run, signal: controller.signal });
    const rejected = expect(opening).rejects.toThrow();
    await started; controller.abort(); await rejected;
    expect(f.methods.spawn).toHaveBeenCalledOnce();
    release(); await cleanupFinished;
    expect(f.methods.spawn).toHaveBeenCalledOnce();
    expect(f.store.list("native-chats")).toHaveLength(1);
    expect(f.manager.get(threadId)?.active).toBe(false);
  });

});
