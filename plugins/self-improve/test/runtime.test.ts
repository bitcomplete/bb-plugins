import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Store, MIGRATIONS } from "../src/store.js";
import { Runtime, type MinedSessionExposure, type MiningCoverageWindow } from "../src/runtime.js";
import { defaultConfig } from "../src/config.js";
import type { NativeExecution } from "../src/native-tasks.js";
import { Accounting } from "../src/costs.js";
import type { StageContext } from "../src/services.js";
import { DAY, NOW, problem, solution, vote } from "./domain/fixtures.js";
import { addObjective, setObjectiveFocus } from "../src/objectives.js";
import { performanceHistory } from "../src/performance.js";
import type { SourceResult } from "../src/sources.js";
const mocks = vi.hoisted(() => ({ sources: vi.fn(), invent: vi.fn(), scout: vi.fn(), complete: vi.fn() }));
vi.mock("../src/sources.js", () => ({ collectSources: mocks.sources }));
vi.mock("../src/stages/native-research.js", () => ({ inventCandidates: mocks.invent, scout: mocks.scout }));
vi.mock("../src/native-model.js", () => ({ completeJson: mocks.complete }));
const dbs: Database.Database[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); Object.values(mocks).forEach(fn => fn.mockReset()); });
afterEach(() => { dbs.splice(0).forEach(db => db.close()); vi.useRealTimers(); });
function context(stage: StageContext["job"]["stage"], input: Record<string, unknown> = {}, id: string = stage): StageContext { return { job: { id, stage, key: id, input, attempts: 1, createdAt: NOW }, signal: new AbortController().signal, boot: "boot" }; }
function setup() {
  const db = new Database(":memory:"); dbs.push(db); MIGRATIONS.forEach(sql => db.exec(sql)); const store = new Store(db);
  const config = { ...defaultConfig(), providerId: "claude-code", model: "model", projectId: "project", environmentId: "environment", scopeProjectIds: ["project"] };
  const analyze = vi.fn(async () => ({ failures: [] }));
  const runtime = new Runtime({ bb: { sdk: {} } as BbPluginApi, store, config: () => config, privacy: () => ({}), runner: { execute: async () => { throw new Error("unexpected native dispatch"); } }, execution: (): NativeExecution => ({projectId:config.projectId,environment:{type:"reuse",environmentId:config.environmentId},providerId:config.providerId,model:config.model,permissionMode:"accept-edits"}), privacyGeneration: () => "privacy-one", accounting: new Accounting(store,()=>config.budgets), workers: () => ({ owns: () => false, analyze }), build: async () => ({ built: 1 }) });
  return { store, runtime, config, analyze };
}
async function prepareResearch(runtime:Runtime,snapshotId:string) {
  const result=async(ctx:{snapshotId:string})=>({snapshotId:ctx.snapshotId,candidates:[],papers:[],paperAssessments:[],receipts:[],warnings:[],counts:{}});
  mocks.scout.mockImplementation(result);mocks.invent.mockImplementation(result);
  for(const stage of ["scout","inventor"] as const)await runtime.handlers[stage](context(stage,{},`${stage}:${snapshotId}`));
}
function coverage(store: Store, fromMs: number, toMs: number, complete = true) {
  const record: MiningCoverageWindow = { id: `scan-${fromMs}-${toMs}`, fromMs, toMs, atMs: NOW, complete, policyVersion: "mined-session-day-v1", reasons: complete ? [] : ["incomplete-source-scan"] };
  store.put("mining-coverage", record.id, record);
}
function observed(store: Store, id: string, atMs: number, complete = true, model = "model") {
  const day = new Date(atMs).toISOString().slice(0, 10);
  const record: MinedSessionExposure = { sessionId: id, day, atMs, originPluginId: null, taskId: `task-${id}`, complete, observedThroughSequence: 10, minedThroughSequence: complete ? 10 : 1, projectId: "project", model: { provider: "claude-code", model }, minedAtMs: NOW, policyVersion: "mined-session-day-v1" };
  store.put("session-exposure", `${id}:${day}`, record);
  return record;
}
function active(store: Store) {
  const s = solution(); s.status = "active"; s.candidateState = "built"; s.validatedWith = { provider: "anthropic", model: "model" };
  const activation = Math.floor((NOW - 10 * DAY) / DAY) * DAY;
  s.wiring = { location: "slot", activatedAtMs: activation, executionCount: 400, undo: "Disable the instruction" };
  store.put("problems", "p-a", problem()); store.put("solutions", s.id, s);
  store.put("validated-artifacts", s.id, { solutionId: s.id, revision: "revision-one", kind: "instruction", content: "Preserve request data.", artifactDigest: "a".repeat(64), evaluationId: "evaluation", wiringLocation: "slot", activatedAtMs: activation });
  store.put("built-artifacts", "artifact", { solutionId: s.id, revision: "revision-one", scopeProjectIds: ["project"], evaluationId: "evaluation" });
  coverage(store, activation - 7 * DAY, NOW);
  const afterStart = Math.floor(NOW / DAY) * DAY - 7 * DAY;
  for (let i = 0; i < 200; i++) {
    const before = observed(store, `before-${i}`, activation - DAY);
    const after = observed(store, `after-${i}`, afterStart + DAY);
    store.put("wiring-executions", `${s.id}:after-${i}`, { solutionId: s.id, threadId: after.sessionId, eventId: `complete-${i}`, revision: "revision-one", boundAtMs: after.atMs - 1, atMs: after.atMs + 1, projectId: "project", model: after.model });
    const v = vote({ id: `v-${i}` }); v.occurredAtMs = before.atMs; v.day = before.day; v.evidence = { kind: "thread", threadId: before.sessionId, sessionId: before.sessionId, turnIndex: 0, eventId: `failure-${i}` };
    store.put("votes", v.id, v);
  }
  return { s, activation, afterStart };
}
describe("runtime observational evidence", () => {
  it("does not count capped or partly mined sessions as a favorable denominator", async () => {
    const { store, runtime, config } = setup(); config.maxEventsPerSession = 10;
    const source: SourceResult = { sessions: ["chosen", "capped"].map((id, index) => ({ sessionId: id, threadId: id, taskId: "same-task", day: new Date(NOW).toISOString().slice(0, 10), firstEventAtMs: NOW - 100 + index, originPluginId: null, events: Array.from({ length: 11 }, (_, j) => ({ id: `${id}-${j}`, sequence: j + 1, atMs: NOW - 90 + j, turnIndex: 0, kind: "context" as const, excerpt: "A completed operation" })) })), taskRuns: [], jobRuns: [], sessionMetadata: [], observedThreads: 2, coverage: [{ source: "active-threads", complete: true, reason: null }, { source: "archived-threads", complete: true, reason: null }, { source: "task-identity", complete: true, reason: null }, { source: "thread:chosen", complete: true, reason: null }, { source: "thread:capped", complete: true, reason: null }] };
    mocks.sources.mockResolvedValue(source);
    source.coverage.push({ source: "task-outcomes", complete: false, reason: "structured-task-history-unavailable" });
    await runtime.handlers.miner(context("miner"));
    const records = store.list<MinedSessionExposure>("session-exposure");
    expect(records).toHaveLength(1); expect(records[0]!.sessionId).toBe("chosen"); expect(records[0]!.complete).toBe(false);
    await runtime.handlers.miner(context("miner", {}, "next-batch"));
    expect(store.list<MinedSessionExposure>("session-exposure")[0]?.complete).toBe(true);
    expect(store.get<MiningCoverageWindow>("mining-coverage","next-batch:1")?.complete).toBe(true);
  });
  it("requires mature complete matched windows and actual instruction exposure", async () => {
    const { store, runtime } = setup(); const { s } = active(store);
    runtime.options.accounting.recordExternal({idempotencyKey:"measured-invoice",kind:"charge",basis:"reported",amountMicros:1200,currency:"USD",source:"provider",reference:"invoice-one",scope:"builder",solutionId:s.id,occurredAtMs:NOW},{kind:"owner",id:"local-owner"},NOW);
    await runtime.handlers.verifier(context("verifier"));
    expect(performanceHistory(store, s.id)[0]?.verification.verdict).toBe("REDUCED");
    expect(performanceHistory(store,s.id)[0]?.costs).toEqual([{currency:"USD",reportedMicros:1200,estimatedMicros:0,unknownAttempts:0}]);
    const e = store.entries<MinedSessionExposure>("session-exposure").find(e => e.value.sessionId === "after-0")!;
    store.put("session-exposure", e.key, { ...e.value, complete: false });
    await runtime.handlers.verifier(context("verifier", {}, "incomplete"));
    const incomplete = performanceHistory(store, s.id).find(p => p.measurementKey.startsWith("incomplete"))!;
    expect(incomplete.verification.verdict).toBe("PENDING");
    expect(incomplete.verification.reasons.join(" ")).toContain("incomplete");
  });
  it("keeps incompatible or unobserved runtime models pending", async () => {
    const { store, runtime } = setup(); const { s } = active(store);
    const e = store.entries<MinedSessionExposure>("session-exposure").find(e => e.value.sessionId === "after-0")!;
    store.put("session-exposure", e.key, { ...e.value, model: null });
    await runtime.handlers.verifier(context("verifier"));
    expect(performanceHistory(store, s.id)[0]?.verification.verdict).toBe("PENDING");
  });
  it("uses a fixed baseline and rolling complete after windows", async () => {
    const { store, runtime } = setup(); const { s, activation } = active(store);
    await runtime.handlers.verifier(context("verifier"));
    const first = performanceHistory(store, s.id)[0]!;
    vi.setSystemTime(NOW + DAY);
    coverage(store, activation - 7 * DAY, NOW + DAY);
    await runtime.handlers.verifier(context("verifier", {}, "tomorrow"));
    const second = performanceHistory(store, s.id).find(p => p.measurementKey.includes("tomorrow"))!;
    expect(second.before).toEqual(first.before); expect(second.after.endMs - first.after.endMs).toBe(DAY); expect(second.after.startMs - first.after.startMs).toBe(DAY);
  });
  it("never produces a measured verdict from unverified legacy exposure records", async () => {
    const { store, runtime } = setup(); const { s } = active(store);
    for (const entry of store.entries<MinedSessionExposure>("session-exposure")) store.put("session-exposure", entry.key, { sessionId: entry.value.sessionId, atMs: entry.value.atMs, originPluginId: null });
    await runtime.handlers.verifier(context("verifier"));
    expect(performanceHistory(store, s.id)[0]?.verification.verdict).toBe("PENDING");
  });
  it("requires source coverage and completed treatment execution rather than active status alone", async () => {
    const { store, runtime } = setup(); const { s } = active(store);
    for (const entry of store.entries("mining-coverage")) store.remove("mining-coverage",entry.key);
    for (const entry of store.entries("wiring-executions")) store.remove("wiring-executions",entry.key);
    await runtime.handlers.verifier(context("verifier"));
    const result = performanceHistory(store,s.id)[0]!;
    expect(result.verification.verdict).toBe("PENDING");
    expect(result.evidenceGaps?.join(" ")).toContain("coverage");
    expect(result.evidenceGaps?.join(" ")).toContain("completed instruction exposure");
    expect(result.verification.afterInterval).toBeNull();
  });
});
describe("runtime ranking and restart-safe research", () => {
  it("refreshes ranking when configured weights change and preserves the old policy snapshot",async()=>{
    const {store,runtime,config}=setup();store.put("problems","p-a",problem());store.put("votes","vote",vote({id:"vote",kind:"tool_error"}));
    await runtime.handlers["problem-ranker"](context("problem-ranker"));
    const oldId=store.get<string>("snapshot","latest")!;
    const oldSnapshot=store.get<{policy:{weights:{tool_error:number}};ranking:{ranked:Array<{score:number}>}}>("problem-snapshots",oldId)!;
    config.ranking.weights.tool_error=1;
    await runtime.handlers["problem-ranker"](context("problem-ranker"));
    expect(store.get("snapshot","latest")).not.toBe(oldId);
    expect(store.get<{policy:{weights:{tool_error:number}}}>("problem-snapshots",oldId)?.policy.weights.tool_error).toBe(.5);
    expect(store.get<{ranked:Array<{score:number}>}>("ranking","latest")!.ranked[0]!.score).toBeCloseTo(oldSnapshot.ranking.ranked[0]!.score*2);
  });
  it("makes owner focus an explicit selection preference without fabricating votes", async () => {
    const { store, runtime } = setup(); const objective = addObjective(store, { requestId: "manual", kind: "goal", title: "Fewer retries", description: "Reduce unnecessary requests", metric: { name: "requests", unit: "per task", target: 2, direction: "lower" } }, { kind: "owner", id: "owner" }, s => s, NOW);
    setObjectiveFocus(store, objective.id, 5, { kind: "owner", id: "owner" }, NOW);
    const focused = solution("focused"); focused.problemIds = [objective.problemId]; focused.prediction.symptomIds = store.get<ReturnType<typeof problem>>("problems", objective.problemId)!.symptoms.map(s => s.id);
    const observedCandidate = solution("observed"); store.put("problems", "p-a", problem()); store.put("solutions", focused.id, focused); store.put("solutions", observedCandidate.id, observedCandidate); store.put("votes", "vote", vote({ id: "vote" }));
    await runtime.handlers["problem-ranker"](context("problem-ranker"));
    const snapshotId = store.get<string>("snapshot", "latest")!;
    await prepareResearch(runtime,snapshotId);
    await runtime.handlers["solution-ranker"](context("solution-ranker"));
    expect(store.list("votes")).toHaveLength(1);
    const ranking = store.get<Array<{ solutionId: string; focusPriority: number; selectionBasis: string }>>("solution-ranking", "latest")!;
    expect(ranking[0]).toMatchObject({ solutionId: "focused", focusPriority: 5, selectionBasis: "owner-focus" });
  });
  it("persists model checkpoints even when the stage later fails, and reuses completed results", async () => {
    const { store, runtime } = setup(); store.put("problems", "p-a", problem());
    await runtime.handlers["problem-ranker"](context("problem-ranker"));
    let attempts = 0;
    mocks.invent.mockImplementation(async (ctx: { snapshotId: string; checkpoints: { read(key: string): Promise<unknown>; write(key: string, value: unknown): Promise<void> } }) => {
      const previous = await ctx.checkpoints.read("operation");
      if (!previous) await ctx.checkpoints.write("operation", { fingerprint: "request", result: { proposals: [] } });
      if (attempts++ === 0) throw new Error("transient next operation failed");
      expect(previous).toEqual({ fingerprint: "request", result: { proposals: [] } });
      return { candidates: [], papers: [], paperAssessments:[], receipts:[], warnings: [], counts: { problems: 1, papers: 0, candidates: 0, taskRequests: 0 }, snapshotId: ctx.snapshotId };
    });
    await expect(runtime.handlers.inventor(context("inventor"))).rejects.toThrow("transient");
    await runtime.handlers.inventor(context("inventor"));
    await runtime.handlers.inventor(context("inventor"));
    expect(mocks.invent).toHaveBeenCalledTimes(2);
  });
  it("attributes native research receipts to the persisted run UUID", async () => {
    const { store,runtime }=setup(); store.put("problems","p-a",problem()); store.put("votes","vote",vote());
    await runtime.handlers["problem-ranker"](context("problem-ranker"));
    const snapshotId=store.get<string>("snapshot","latest")!;
    mocks.invent.mockImplementation(async (input:{runId:string})=>{ expect(input.runId).toBe("actual-run-uuid"); return {candidates:[],papers:[],paperAssessments:[],receipts:[{taskId:"inventor-task",runId:input.runId,stage:"inventor",providerId:"claude-code",model:"model",threadId:"native-thread",requestId:"native-request",turnId:"native-turn",promptHash:"a".repeat(64),startedAtMs:NOW,endedAtMs:NOW,modelIdentitySource:"requested-selection"}],warnings:[],counts:{},snapshotId}; });
    const ctx=context("inventor"); Object.assign(ctx.job,{runId:"actual-run-uuid"});
    await runtime.handlers.inventor(ctx);
    expect(store.get("native-research-receipts","inventor-task")).toMatchObject({runId:"actual-run-uuid",threadId:"native-thread",modelIdentitySource:"requested-selection"});
  });
});
