import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Store, MIGRATIONS } from "../src/store.js";
import { Runtime, type MinedSessionExposure, type MiningCoverageWindow } from "../src/runtime.js";
import { defaultConfig } from "../src/config.js";
import type { NativeExecution } from "../src/native-tasks.js";
import type { StageContext } from "../src/services.js";
import { DAY, NOW, problem, solution, vote } from "./domain/fixtures.js";
import { addObjective, setObjectiveFocus } from "../src/objectives.js";
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
  const runtime = new Runtime({ bb: { sdk: {} } as BbPluginApi, store, config: () => config, privacy: () => ({}), runner: { execute: async () => { throw new Error("unexpected native dispatch"); } }, execution: (): NativeExecution => ({projectId:config.projectId,environment:{type:"reuse",environmentId:config.environmentId},providerId:config.providerId,model:config.model,permissionMode:"accept-edits"}), privacyGeneration: () => "privacy-one", workers: () => ({ owns: () => false, analyze }), build: async () => ({ built: 1 }) });
  return { store, runtime, config, analyze };
}
async function prepareResearch(runtime:Runtime,snapshotId:string) {
  const result=async(ctx:{snapshotId:string})=>({snapshotId:ctx.snapshotId,candidates:[],papers:[],paperAssessments:[],receipts:[],warnings:[],counts:{}});
  mocks.scout.mockImplementation(result);mocks.invent.mockImplementation(result);
  for(const stage of ["scout","inventor"] as const)await runtime.handlers[stage](context(stage,{},`${stage}:${snapshotId}`));
}
describe("runtime mining coverage", () => {
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
