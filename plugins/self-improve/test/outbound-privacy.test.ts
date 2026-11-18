import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { modelProblemContext, modelSolutionContext, type PrivacyPolicy } from "../src/adapters/privacy.js";
import type { NativeExecution, NativeTaskReceipt, NativeTaskRequest } from "../src/native-tasks.js";
import { defaultConfig } from "../src/config.js";
import { Accounting } from "../src/costs.js";
import type { Solution } from "../src/domain/types.js";
import { createEvaluationModel, evaluateInstruction, type EvaluationOptions, type EvaluationSuite } from "../src/evaluation.js";
import { createWordingGenerator, preregisterStudy, runWordingPair } from "../src/experiments.js";
import { reviewRevisits } from "../src/revisit.js";
import { Runtime } from "../src/runtime.js";
import type { StageContext } from "../src/services.js";
import { Store, MIGRATIONS } from "../src/store.js";
import { DAY, NOW, problem, solution, vote } from "./domain/fixtures.js";

const marker = "OrchidPrivate", privacy: PrivacyPolicy = { clientNames: [marker] };
const dbs: Database.Database[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { dbs.splice(0).forEach(db => db.close()); vi.useRealTimers(); });
function database() {
  const db = new Database(":memory:"); dbs.push(db); MIGRATIONS.forEach(sql => db.exec(sql)); return new Store(db);
}
const execution:NativeExecution={projectId:"project",environment:{type:"reuse",environmentId:"environment"},providerId:"codex",model:"model",permissionMode:"accept-edits"};
function transport(reply:Record<string,unknown>|((request:NativeTaskRequest)=>unknown)) {
  const requests:NativeTaskRequest[]=[];
  const runner={execute:async(request:NativeTaskRequest):Promise<NativeTaskReceipt>=>{
    requests.push(request);const value=typeof reply==="function"?reply(request):reply;
    return {taskId:request.id,runId:request.runId,solutionId:request.solutionId,stage:request.stage,providerId:request.execution.providerId,model:request.execution.model,modelIdentitySource:"requested-selection",threadId:`thread-${request.id}`,requestId:"request",turnId:"turn",promptHash:"a".repeat(64),startedAtMs:NOW,endedAtMs:NOW+1,text:JSON.stringify(value)};
  }};
  return {runner,requests};
}
function nativeOptions(store:Store,runner:ReturnType<typeof transport>["runner"]) {
  return {store,runner,execution,runId:"run-one",privacyGeneration:"generation",currentPrivacyGeneration:()=>"generation",signal:new AbortController().signal};
}
function data(request:NativeTaskRequest) {return JSON.parse(request.input);}
function context(stage: StageContext["job"]["stage"]): StageContext {
  return { job: { id: `privacy-${stage}`, runId:"run-one", stage, key: stage, input: {}, attempts: 1, createdAt: NOW }, signal: new AbortController().signal, boot: "boot" };
}
function retainedSolution(): Solution {
  const s = solution(); s.mechanism = `Retain ${marker} request data`; s.prediction.change = `Reduce ${marker} losses`; s.prediction.kpi.name = `${marker} loss rate`;
  s.attempts = [{ id: "private-attempt-id", atMs: NOW, directionKey: s.directionKey, prediction: structuredClone(s.prediction), outcome: "failed", reason: `${marker} still lost data`, evidenceIds: ["private-event-id"], model: { provider: "provider", model: "old" } }];
  return s;
}
function accounting(store: Store) { return new Accounting(store, () => defaultConfig().budgets); }

describe("current-policy outbound privacy", () => {
  it("projects safe context without altering public citations, structure or retained history", () => {
    const s = solution(), p = problem(); s.origin = "paper";
    s.sourcePaper = { id: "2601.12345", version: "v2", url: "https://arxiv.org/abs/2601.12345v2", publishedAtMs: NOW - DAY, credibility: { status: "passed", fieldWeightedCitationImpact: 2, authorSignal: 1, evidenceUrls: ["https://example.invalid/public-evidence"] } };
    const original = structuredClone(s), out = modelSolutionContext(s, { clientNames: ["change", "reason"] });
    expect(out.sourcePaper).toEqual(s.sourcePaper); expect(out.prediction).toHaveProperty("change"); expect(out.mechanism).toBe(s.mechanism);
    expect(modelProblemContext(p)).toEqual({ category: p.category, status: p.status, causes: p.causes.map(c => c.text), symptoms: p.symptoms.map(s => s.text) });
    expect(out).not.toHaveProperty("id"); expect(out).not.toHaveProperty("provenance"); expect(s).toEqual(original);
  });

  it("applies a tightened policy to ranking candidates, linked snapshot problems and failed history", async () => {
    const store = database(), s = retainedSolution(), p = problem("p-a", `${marker} loses data`); s.scores.fit = null;
    const removed = retainedSolution(); removed.id = "removed-solution"; removed.status = "removed";
    store.put("problems", p.id, p); store.put("solutions", s.id, s); store.put("solutions", removed.id, removed); store.put("votes", "v-one", vote());
    const { runner, requests } = transport(request=>request.stage==="inventor"?[]:{scores:solution().scores,reasons:solution().scoreReasons});
    const config = { ...defaultConfig(),providerId:execution.providerId, model: "model",projectId:"project",environmentId:"environment" };
    const runtime = new Runtime({ bb: { sdk: {} } as BbPluginApi, store, config: () => config, privacy: () => privacy, runner,execution:()=>execution,privacyGeneration:()=>"generation", accounting: accounting(store), workers: () => ({ owns: () => false, analyze: async () => ({ failures: [] }) }), build: async () => ({}) });
    await runtime.handlers["problem-ranker"](context("problem-ranker"));
    const snapshotId = store.get<string>("snapshot", "latest")!;
    const snapshot = store.get("problem-snapshots", snapshotId);
    vi.spyOn(runtime.arxiv,"search").mockResolvedValue([]);
    await runtime.handlers.scout(context("scout"));await runtime.handlers.inventor(context("inventor"));requests.splice(0);
    await runtime.handlers["solution-ranker"](context("solution-ranker"));
    expect(requests).toHaveLength(1); expect(JSON.stringify(requests)).not.toMatch(/OrchidPrivate|private-event-id|private-attempt-id/);
    const outbound = data(requests[0]!); expect(outbound.history.find((h: Solution) => h.status === "removed").attempts[0]).toMatchObject({ outcome: "failed", reason: "[redacted] still lost data" });
    expect(outbound.problems[0].causes).toEqual(["[redacted] loses data"]);
    expect(store.get("problem-snapshots", snapshotId)).toEqual(snapshot); expect(store.get("solutions", removed.id)).toEqual(removed);
    expect(store.get<Solution>("solutions", s.id)?.attempts).toEqual(s.attempts);
  });

  it("redacts proposer context but keeps authorized fixture bytes and safe instructions exact", async () => {
    const { runner, requests } = transport(() => requests.length === 1 ? { instruction: "Preserve all request data." } : { output: "OK" });
    const io = createEvaluationModel({...nativeOptions(database(),runner),attemptId:"evaluation",solutionId:"s-a",privacy:()=>privacy});
    const s = retainedSolution(), development = [{ id: "dev", familyId: "family", input: "authorized fixture task", expected: "exact fixture answer" }];
    const original = structuredClone(s);
    const instruction = await io.propose({ development, prediction: s.prediction, mechanism: s.mechanism,assumptions:s.assumptions,testPlan:s.testPlan, history: s.attempts });
    const outbound = data(requests[0]!); expect(outbound.development).toEqual(development);
    expect(JSON.stringify({ ...outbound, development: [] })).not.toContain(marker); expect(outbound.history[0].outcome).toBe("failed");
    await io.run({caseId:"dev",arm:"treatment", input: development[0]!.input, instruction });
    expect(data(requests[1]!).input).toBe(development[0]!.input); expect(requests[1]!.instructions).toContain(instruction); expect(s).toEqual(original);
  });

  it("rejects a newly disallowed evaluated instruction before runner dispatch", async () => {
    const { runner, requests } = transport({ output: "OK" });
    const io = createEvaluationModel({...nativeOptions(database(),runner),attemptId:"evaluation",solutionId:"s-a",privacy:()=>privacy});
    await expect(io.run({caseId:"dev",arm:"treatment", input: "authorized task", instruction: `Preserve ${marker} request data.` })).rejects.toThrow(/disallowed/);
    expect(requests).toEqual([]);
  });

  it("redacts revisit context while preserving the instruction and the original validation identity", async () => {
    const store = database(), s = retainedSolution(); s.status = "active"; s.validatedWith = { provider: "provider", model: "old" };
    const artifact = { revision: "original-revision", content: "Preserve request data." };
    store.put("solutions", s.id, s); store.put("problems", "p-a", problem("p-a", `${marker} loses data`)); store.put("validated-artifacts", s.id, artifact);
    const { runner, requests } = transport({ decision: "retain", reason: "Retest the original instruction" });
    await reviewRevisits({ ...nativeOptions(store,runner), accounting: accounting(store),privacy });
    expect(requests).toHaveLength(1); expect(JSON.stringify(requests)).not.toContain(marker); expect(data(requests[0]!).instruction).toBe(artifact.content);
    expect(store.get("validated-artifacts", s.id)).toEqual(artifact); expect(store.get<Solution>("solutions", s.id)?.validatedWith).toEqual(s.validatedWith);
    expect(store.get<Solution>("solutions", s.id)?.attempts).toEqual(s.attempts);
  });

  it("rejects a newly disallowed revisit instruction before dispatch or review persistence", async () => {
    const store = database(), s = solution(); s.status = "active"; s.validatedWith = { provider: "provider", model: "old" };
    const artifact = { revision: "original-revision", content: `Preserve ${marker} data.` };
    store.put("solutions", s.id, s); store.put("validated-artifacts", s.id, artifact);
    const { runner, requests } = transport({ decision: "retain", reason: "Retest" });
    await expect(reviewRevisits({ ...nativeOptions(store,runner), accounting: accounting(store),privacy })).rejects.toThrow(/disallowed/);
    expect(requests).toEqual([]); expect(store.list("revisit-reviews")).toEqual([]); expect(store.get("validated-artifacts", s.id)).toEqual(artifact); expect(store.get("solutions", s.id)).toEqual(s);
  });

  it("rejects disallowed fixture bytes before the native proposer dispatches",async()=>{
    const {runner,requests}=transport({instruction:"Preserve data."}),io=createEvaluationModel({...nativeOptions(database(),runner),attemptId:"fixture-policy",solutionId:"s-a",privacy:()=>privacy});
    const s=solution();
    await expect(io.propose({development:[{id:"dev",familyId:"family",input:`${marker} task`,expected:"answer"}],prediction:s.prediction,mechanism:s.mechanism,assumptions:s.assumptions,testPlan:s.testPlan,history:[]})).rejects.toThrow(/disallowed/);
    expect(requests).toEqual([]);
  });

  it("rechecks current instruction policy before replaying an existing exploratory artifact",async()=>{
    const store=database(),s=solution();store.put("solutions",s.id,s);
    const {runner,requests}=transport(request=>request.instructions.startsWith("Propose one")?{instruction:`Preserve ${marker} request data.`}:{output:"ok"});
    const suite:EvaluationSuite={id:"suite",development:[{id:"dev",familyId:"family",input:"visible task",expected:"ok"}],heldOut:[]};
    const options:EvaluationOptions={...nativeOptions(store,runner),attemptId:"first",solutionId:s.id,revision:"first",scopeProjectIds:["project"],suite,privacy:()=>({})};
    const first=await evaluateInstruction(options),original=store.get("native-evaluation-artifacts",first.artifactId!)!;expect(first.status).toBe("completed");
    requests.splice(0);
    expect(await evaluateInstruction({...options,attemptId:"replay",revision:"replay",retestArtifactId:first.artifactId!,privacy:()=>privacy,privacyGeneration:"tightened",currentPrivacyGeneration:()=>"tightened"})).toMatchObject({status:"failed",artifactId:null,observationVerdict:"inconclusive"});
    expect(requests).toEqual([]);expect(store.get("native-evaluation-artifacts",first.artifactId!)).toEqual(original);expect(store.list("trusted-evaluations")).toEqual([]);
  });

  it("revalidates failed wording evidence under the retry policy without changing the snapshot", async () => {
    const store = database(), p = problem("p-a", `${marker} loses payloads`); store.put("problems", p.id, p); store.put("votes", "v-one", vote());
    preregisterStudy(store, { id: "study", startsAtMs: NOW + DAY, endsAtMs: NOW + 4 * DAY, sampleSize: 1, seed: "seed" }, { kind: "owner", id: "owner" }, NOW);
    let fail = true;
    const { runner, requests } = transport(() => { if (fail) throw new Error("dummy generation failure"); return { abstract: "Retain immutable data", concrete: "Keep original retry payloads" }; });
    const generate = (policy: PrivacyPolicy) => createWordingGenerator({...nativeOptions(store,runner),experimentId:"study",privacy:policy});
    const research = vi.fn(async () => ({candidates:[],papers:[]}));
    const options = { ...nativeOptions(store,runner), experimentId: "study", problemId: p.id, voteIds: ["v-one"], research, now: () => NOW + 2 * DAY };
    await expect(runWordingPair({ ...options, generate: generate({}) })).rejects.toThrow("experiment-pair-failed");
    expect(requests).toHaveLength(1); expect(data(requests[0]!).causes).toEqual([p.causes[0]!.text]);
    expect(data(requests[0]!)).toEqual({ causes: p.causes.map(c => c.text), symptoms: p.symptoms.map(s => s.text), observations: [{ kind: "tool_error" }] });
    const saved = store.list<{ evidence: unknown; evidenceDigest: string }>("experiment-pairs-private")[0]!;
    const retry = vi.fn(generate(privacy)); fail = false;
    await expect(runWordingPair({ ...options, generate: retry, privacy })).rejects.toThrow("experiment-execution-changed");
    expect(retry).not.toHaveBeenCalled(); expect(requests).toHaveLength(1); expect(research).not.toHaveBeenCalled();
    expect(store.list<{ evidence: unknown; evidenceDigest: string }>("experiment-pairs-private")[0]).toMatchObject({ evidence: saved.evidence, evidenceDigest: saved.evidenceDigest });
    await runWordingPair({ ...options, generate: generate({}) });
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(research).toHaveBeenCalledTimes(2);
  });

  it("rejects newly forbidden wording on first send even when the generator is used directly", async () => {
    const { runner, requests } = transport({ abstract: "General", concrete: "Specific" });
    const evidence = { problemId: "private-problem-id", voteIds: ["private-vote-id"], causes: [`${marker} loses data`], symptoms: ["Missing payload"], observations: [] };
    await expect(createWordingGenerator({...nativeOptions(database(),runner),experimentId:"study",privacy})(evidence)).rejects.toThrow(/disallowed/);
    expect(requests).toEqual([]);
  });
});
