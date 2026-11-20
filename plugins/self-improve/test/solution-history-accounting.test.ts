import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityAccounting, type ActivityChatConversation } from "../src/activity-accounting.js";
import { Accounting, type CostPolicy } from "../src/costs.js";
import { NativeAccounting } from "../src/native-accounting.js";
import type { NativeTaskIdentity } from "../src/native-tasks.js";
import { NativeUsageLedger, type NativeUsageObservation, type NativeUsageSdk } from "../src/native-usage.js";
import { MIGRATIONS, Store } from "../src/store.js";
import { NOW, solution } from "./domain/fixtures.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function report(threadId: string, seq: number, amount: number | undefined, session: string) {
  return { id: `${threadId}-${seq}`, threadId, seq, createdAt: NOW + seq, scope: { kind: "thread" }, type: "thread/contextWindowUsage/updated",
    data: { providerThreadId: session, contextWindowUsage: { ...(amount === undefined ? {} : { cost: { amount, currency: "USD" } }) } } };
}
function fixture() {
  const db = new Database(":memory:"); databases.push(db); MIGRATIONS.forEach(sql => db.exec(sql));
  const store = new Store(db), chats: ActivityChatConversation[] = [], rows = new Map<string, ReturnType<typeof report>[]>();
  const policy: CostPolicy = { currency: "USD", dailyMicros: null, monthlyMicros: null, maxDailyCalls: 100, allowUnknown: true,
    prices: { historical: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, version: "fixture" } } };
  const list = vi.fn(async (input: { threadId: string; afterSeq?: string }) => (rows.get(input.threadId) ?? []).filter(row => row.seq > Number(input.afterSeq ?? -1)));
  const sdk = { threads: { events: { list } } } as unknown as NativeUsageSdk;
  const legacy = new Accounting(store, () => policy);
  const native = new NativeAccounting({ store, sdk, maxConcurrent: () => 100, now: () => NOW });
  const options = { store, policy: () => policy, legacy: () => legacy, native: () => native, chats: () => chats, now: () => NOW };
  const activity = new ActivityAccounting(options);
  const family = (id = "canonical", aliases = ["alias-a", "alias-b"]) => store.put("solutions", id, { ...solution(id), aliases }, NOW);
  const addNative = async (taskId: string, solutionId: string, amounts: (number | undefined)[], session = `session-${taskId}`) => {
    const identity: NativeTaskIdentity = { taskId, solutionId, runId: `run-${taskId}`, stage: "inventor", providerId: "codex", model: "fixture", startedAtMs: NOW };
    const threadId = `thread-${taskId}`; rows.set(threadId, amounts.map((amount, seq) => report(threadId, seq, amount, session)));
    await native.beforeStart(identity);
    await native.onSettled({ ...identity, threadId, status: "completed", endedAtMs: NOW + 100, error: null, dispatched: true, cleanupPending: false });
  };
  const addChat = (chatId: string, solutionId: string, amounts: (number | undefined)[], session = `session-${chatId}`) => {
    const bound = { taskId: chatId, threadId: `thread-${chatId}`, providerId: "codex", requestedModel: "fixture" };
    const usage = new NativeUsageLedger(store); usage.ingest(bound, amounts.map((amount, seq) => report(bound.threadId, seq, amount, session)));
    activity.admitChat({ chatId, threadId: bound.threadId, providerId: bound.providerId, model: bound.requestedModel, solutionId, runId: `run-${chatId}`, initial: true });
    chats.push({ chatId, threadId: bound.threadId, providerId: bound.providerId, model: bound.requestedModel, solutionId, runId: `run-${chatId}`, createdAtMs: NOW,
      requests: [{ requestId: `${chatId}-request`, atMs: NOW }], turns: [{ turnId: `${chatId}-turn`, atMs: NOW + 1, completed: true }], countsCaughtUp: true, countsIssue: null,
      usage: usage.read(bound), costObservations: store.list<NativeUsageObservation>("native-usage-observations")
        .filter(row => row.threadId === bound.threadId && row.kind === "cost").map(row => ({ ...row, cost: row.cost ?? null })) });
  };
  const invoice = (id: string, solutionId: string, amountMicros: number) => legacy.recordExternal({ idempotencyKey: id, kind: "charge", basis: "reported", amountMicros,
    currency: "USD", source: "owner fixture", reference: id, scope: "research", occurredAtMs: NOW, solutionId }, { kind: "owner", id: "owner" }, NOW);
  const snapshot = () => ({ records: db.prepare("SELECT * FROM records ORDER BY namespace,key").all(), audit: store.audit(), chats: structuredClone(chats) });
  return { store, legacy, native, activity, options, family, addNative, addChat, invoice, snapshot, list };
}

describe("solution history accounting", () => {
  it("selects canonical and retained aliases once across native tasks, chats and historical costs, without relabeling or writes", async () => {
    const f = fixture(); f.family("canonical", ["alias-b", "alias-a", "alias-a"]); f.family("unrelated", []);
    await f.addNative("native-canonical", "canonical", [1]);
    await f.addNative("native-alias", "alias-a", [2]);
    await f.addNative("native-outside", "unrelated", [50]);
    f.addChat("chat-alias", "alias-b", [3]); f.addChat("chat-outside", "unrelated", [60]);
    f.invoice("invoice-canonical", "canonical", 10); f.invoice("invoice-alias", "alias-a", 20); f.invoice("invoice-outside", "unrelated", 100);
    f.legacy.reserve({ id: "estimate", model: "historical", scope: "inventor", inputBound: 5, outputBound: 0, solutionId: "canonical" }, NOW);
    f.legacy.settle({ id: "estimate", model: "historical", status: "completed", complete: true, usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }, NOW + 1);
    f.legacy.reserve({ id: "pending", model: "historical", scope: "inventor", inputBound: 7, outputBound: 0, solutionId: "alias-b" }, NOW);
    const before = f.snapshot(); f.list.mockClear();
    const canonical = f.activity.forSolutionHistory("canonical"), alias = new ActivityAccounting(f.options).forSolutionHistory("alias-a");
    expect(canonical.solutionHistory).toEqual({ requestedId: "canonical", canonicalId: "canonical", solutionIds: ["alias-a", "alias-b", "canonical"] });
    expect(alias).toEqual({ ...canonical, solutionHistory: { ...canonical.solutionHistory, requestedId: "alias-a" } });
    expect(canonical.native.tasks.map(task => task.solutionId).sort()).toEqual(["alias-a", "canonical"]);
    expect(canonical.chats.map(chat => chat.solutionId)).toEqual(["alias-b"]);
    expect(canonical.initialChatAdmissions.map(chat => chat.solutionId)).toEqual(["alias-b"]);
    expect(canonical.legacy.events.map(event => event.solutionId).sort()).toEqual(["alias-a", "canonical", "canonical"]);
    expect(canonical.legacy.pending.map(event => event.solutionId)).toEqual(["alias-b"]);
    expect(canonical.legacy.totals).toMatchObject([{ reportedMicros: 30, estimatedMicros: 5, reservedMicros: 7 }]);
    expect(canonical.native.totals).toMatchObject([{ nativeObservedFloorMicros: 3_000_000 }]);
    expect(canonical.totals).toMatchObject([{ sharedNativeAndChatObservedFloorMicros: 6_000_000 }]);
    expect(canonical.calls).toEqual({ legacyAdmissions: 2, nativeAdmissions: 2, initialChatAdmissions: 1, observedChatRequests: 1, observedChatRootTurns: 1, totalAdmissionsAndObservedRequests: 5 });
    expect(f.activity.forSolution("canonical").native.tasks.map(task => task.taskId)).toEqual(["native-canonical"]);
    expect(f.activity.forSolution("canonical").chats).toEqual([]);
    expect(f.activity.forSolution("alias-a").legacy.totals[0]!.reportedMicros).toBe(20);
    expect(f.activity.forRun("run-native-alias").native.tasks.map(task => task.solutionId)).toEqual(["alias-a"]);
    expect(f.list).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
  });

  it("deduplicates cumulative sessions across the whole family and across native/chat activities", async () => {
    const f = fixture(); f.family();
    await f.addNative("first", "canonical", [1, 2, 2], "shared");
    await f.addNative("second", "alias-a", [2, 3], "shared");
    f.addChat("third", "alias-b", [3, 4, 4], "shared");
    const result = f.activity.forSolutionHistory("alias-b");
    expect(result.native.totals[0]).toMatchObject({ nativeLatestReportedSessionMicros: null, nativeObservedFloorMicros: 3_000_000 });
    expect(result.totals[0]).toEqual({ currency: "USD", manualChatLatestReportedSessionMicros: null, manualChatObservedFloorMicros: 4_000_000, sharedNativeAndChatObservedFloorMicros: 4_000_000 });
    expect(result.calls.totalAdmissionsAndObservedRequests).toBe(3);
    expect(result.native.tasks.every(task => task.unknownReasons.includes("provider-session-shared-between-tasks") && task.unknownReasons.includes("provider-session-shared-between-activities"))).toBe(true);
    expect(result.chats[0]!.unknownReasons).toContain("provider-session-shared-between-activities");
  });

  it("retains cross-family ambiguity even when the other owner is filtered out or has no amount", async () => {
    const f = fixture(); f.family(); f.family("other-family", ["other-alias"]);
    await f.addNative("selected", "alias-a", [2], "cross-family");
    f.addChat("outside", "other-alias", [undefined], "cross-family");
    f.addChat("selected-chat", "alias-b", [4], "other-cross-family");
    await f.addNative("outside-native", "other-family", [5], "other-cross-family");
    const selected = f.activity.forSolutionHistory("canonical");
    expect(selected.native.tasks.map(task => task.taskId)).toEqual(["selected"]);
    expect(selected.chats.map(chat => chat.chatId)).toEqual(["selected-chat"]);
    expect(selected.native.totals[0]).toMatchObject({ nativeLatestReportedSessionMicros: null, nativeObservedFloorMicros: 2_000_000 });
    expect(selected.native.tasks[0]!.unknownReasons).toContain("provider-session-shared-between-activities");
    expect(selected.chats[0]!.unknownReasons).toContain("provider-session-shared-between-activities");
    expect(selected.totals[0]).toMatchObject({ manualChatLatestReportedSessionMicros: null, sharedNativeAndChatObservedFloorMicros: 6_000_000 });
    expect(f.activity.summary().totals[0]!.sharedNativeAndChatObservedFloorMicros).toBe(7_000_000);
  });

  it("rejects unknown and archive-only IDs without breaking exact historical reads", async () => {
    const f = fixture(); f.family(); await f.addNative("historical", "archive-only", [1]);
    f.store.put("solution-merges", "old-merge", { canonicalId: "canonical", canonicalBefore: solution("canonical"), absorbed: solution("archive-only"), reason: "exact-direction-and-canonical-problems" }, NOW);
    const before = f.snapshot();
    for (const id of ["missing", "archive-only"]) expect(() => f.activity.forSolutionHistory(id)).toThrow("unknown solution");
    expect(f.activity.forSolution("archive-only").native.tasks.map(task => task.solutionId)).toEqual(["archive-only"]);
    expect(f.activity.forSolution("missing").native.tasks).toEqual([]);
    expect(f.activity.forSolutionHistory("canonical").native.tasks).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  });

  it.each(["alias-owned-twice", "alias-is-another-canonical", "canonical-is-another-alias"])("rejects %s for every entry point into that family", collision => {
    const f = fixture(); f.family();
    if (collision === "alias-owned-twice") f.family("other", ["alias-a"]);
    if (collision === "alias-is-another-canonical") f.family("alias-a", []);
    if (collision === "canonical-is-another-alias") f.family("other", ["canonical"]);
    const before = f.snapshot();
    for (const id of ["canonical", "alias-a", "alias-b"]) expect(() => f.activity.forSolutionHistory(id)).toThrow("conflicting solution alias");
    expect(f.snapshot()).toEqual(before);
  });

  it("rejects malformed stored identity without rewriting records", () => {
    const f = fixture(); f.family(); f.store.put("solutions", "wrong-key", solution("different-id"), NOW);
    const before = f.snapshot();
    expect(() => f.activity.forSolutionHistory("canonical")).toThrow("invalid solution history identity");
    expect(() => f.activity.forSolutionHistory("bad\nidentity")).toThrow("invalid solution history ID");
    expect(f.snapshot()).toEqual(before);
  });
});
