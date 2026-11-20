import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NativeExecution, NativeTaskReceipt, NativeTaskRequest } from "../src/native-tasks.js";
import type { PrivacyPolicy } from "../src/adapters/privacy.js";
import { createBuilder } from "../src/build.js";
import { defaultConfig } from "../src/config.js";
import type { Attempt, Solution } from "../src/domain/types.js";
import { createEvaluationModel, type EvaluationSuite } from "../src/evaluation.js";
import type { StageContext } from "../src/services.js";
import { MIGRATIONS, Store } from "../src/store.js";
import { problem, solution } from "./domain/fixtures.js";

const marker = "OrchidPrivate";
function attempt(candidate: Solution, outcome: Attempt["outcome"], atMs: number): Attempt {
  return { id: `private-attempt-${outcome}`, atMs, directionKey: candidate.directionKey,
    prediction: { ...structuredClone(candidate.prediction), change: `${marker} predicted improvement`, kpi: { name: `${marker} loss rate`, target: 0, direction: "lower" } },
    outcome, reason: `${marker} ${outcome} result`, evidenceIds: ["private-event-reference"], model: { provider: `${marker}-provider`, model: `${marker}-model` } };
}
const execution:NativeExecution={projectId:"private-project",environment:{type:"reuse",environmentId:"environment"},providerId:"codex",model:"test-model",permissionMode:"accept-edits"};
function capturedRunner(requests:NativeTaskRequest[]) {
  return {execute:async(request:NativeTaskRequest):Promise<NativeTaskReceipt>=>{
    requests.push(request);
    const value=request.instructions.startsWith("Propose one")?{instruction:"Preserve the original immutable input across retries."}:{output:"no improvement in this controlled case"};
    return {taskId:request.id,runId:request.runId,solutionId:request.solutionId,stage:request.stage,providerId:request.execution.providerId,model:request.execution.model,modelIdentitySource:"requested-selection",threadId:"thread",requestId:"request",turnId:"turn",promptHash:"a".repeat(64),startedAtMs:1,endedAtMs:2,text:JSON.stringify(value)};
  }};
}
function promptData(request:NativeTaskRequest) {return JSON.parse(request.input);}

describe("builder history from linked problems", () => {
  it("sends every related attempt with predictions and outcomes, including aliases and removed directions, without exposing held-out data", async () => {
    const directory = mkdtempSync(join(tmpdir(), "builder-history-"));
    const db = new Database(":memory:"); MIGRATIONS.forEach(sql => db.exec(sql)); const store = new Store(db);
    try {
      const canonical = problem(); canonical.aliases = ["private-old-problem"];
      store.put("problems", canonical.id, canonical); store.put("problems", "unrelated-problem", problem("unrelated-problem", "Unrelated latency"));
      const candidate = solution(); candidate.directionKey = "OPAQUE_DIRECTION_CURRENT"; candidate.attempts = [attempt(candidate, "proposed", 20)];
      const failed = solution("private-failed-solution"); failed.directionKey = "OPAQUE_DIRECTION_FAILED"; failed.mechanism = `${marker} earlier cache strategy`;
      // Deliberately store the later attempt first; history is ordered across all records.
      failed.attempts = [attempt(failed, "rejected", 25), { ...attempt(failed, "proposed", 10), id: "private-tie-attempt" }, attempt(failed, "failed", 10)];
      const removed = solution("private-removed-solution"); removed.problemIds = ["private-missing-history", "private-old-problem"]; removed.directionKey = "OPAQUE_DIRECTION_REMOVED"; removed.status = "removed";
      removed.mechanism = `${marker} abandoned queue strategy`; removed.attempts = [attempt(removed, "removed", 30)];
      const unrelated = solution("private-unrelated-solution"); unrelated.problemIds = ["unrelated-problem"]; unrelated.directionKey = "unrelated-direction";
      unrelated.attempts = [{ ...attempt(unrelated, "failed", 1), reason: "UNRELATED_HISTORY_MUST_STAY_OUT" }];
      const orphaned = solution("private-orphaned-solution"); orphaned.problemIds = ["private-missing-history"];
      orphaned.attempts = [{ ...attempt(orphaned, "failed", 1), reason: "ORPHANED_HISTORY_MUST_STAY_OUT" }];
      for (const row of [removed, unrelated, orphaned, candidate, failed]) store.put("solutions", row.id, row);
      const retained = [failed, removed, unrelated, orphaned].map(row => structuredClone(store.get("solutions", row.id)));
      const suite: EvaluationSuite = { id: "history-suite", development: [{ id: "dev", familyId: "dev-family", input: "development-visible-input", expected: "development-visible-answer" }], heldOut: [1,2,3].map(i => ({ id: `held-${i}`, familyId: `hidden-family-${i}`, input: `SEALED_INPUT_${i}`, expected: `SEALED_ANSWER_${i}` })) };
      const config = { ...defaultConfig(), model: "test-model", scopeProjectIds: ["private-project"] }, requests: NativeTaskRequest[] = [];
      const runner = capturedRunner(requests);
      const build = createBuilder({ store, directory, config: () => config, runner, execution:()=>execution, privacyGeneration:()=>"generation", suite: () => JSON.stringify(suite), privacy: () => ({ clientNames: [marker] }) });
      const context: StageContext = { job: { id: "history-job", key: "history", stage: "builder", input: {}, attempts: 1, createdAt: Date.now() }, boot: "boot", signal: new AbortController().signal };
      expect(await build(context, candidate)).toMatchObject({ tested:1,completed:1,gainObserved:0,adopted:0,adoptionBlocked:1 });
      expect(requests).toHaveLength(3);
      const proposal = requests[0]!, data = promptData(proposal), serialized = JSON.stringify({instructions:proposal.instructions,input:proposal.input});
      expect(data.development).toEqual(suite.development);
      expect(data.history.map((row: { outcome: string }) => row.outcome)).toEqual(["failed", "proposed", "proposed", "rejected", "removed"]);
      expect(data.history.map((row: { atMs: number }) => row.atMs)).toEqual([10, 10, 20, 25, 30]);
      expect(data.history[0]).toMatchObject({ atMs: 10, mechanism: "[redacted] earlier cache strategy", prediction: { change: "[redacted] predicted improvement", kpi: { name: "[redacted] loss rate", target: 0, direction: "lower" } }, reason: "[redacted] failed result", model: { provider: "[redacted]-provider", model: "[redacted]-model" }, solutionStatus: null });
      expect(data.history[4]).toMatchObject({ outcome: "removed", solutionStatus: "removed", mechanism: "[redacted] abandoned queue strategy" });
      expect(serialized).not.toMatch(/OrchidPrivate|SEALED_INPUT_|SEALED_ANSWER_|hidden-family-|private-|symptom-p-a|OPAQUE_DIRECTION_|UNRELATED_HISTORY_MUST_STAY_OUT|ORPHANED_HISTORY_MUST_STAY_OUT/);
      expect(data.history.every((row: object) => !Object.hasOwn(row, "direction") && !Object.hasOwn(row, "directionKey"))).toBe(true);
      expect(proposal.instructions).toContain("Ordinary BB context and tools may remain");
      expect(requests.slice(1).every(request => !JSON.stringify(request).includes("earlier cache strategy"))).toBe(true);
      for (const [index, row] of [failed, removed, unrelated, orphaned].entries()) expect(store.get("solutions", row.id)).toEqual(retained[index]);
      expect(store.list("validated-artifacts")).toEqual([]);
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("uses current policy for proposer text and rejects newly disallowed evaluated instructions",async()=>{
    const db=new Database(":memory:");MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
    try {
      const requests:NativeTaskRequest[]=[],runner=capturedRunner(requests);let policy:PrivacyPolicy={};
      const model=createEvaluationModel({store,runner,execution,attemptId:"history",solutionId:"s-a",runId:"run",privacyGeneration:"generation",currentPrivacyGeneration:()=>"generation",signal:new AbortController().signal,privacy:()=>policy});
      const candidate=solution(),history=[attempt(candidate,"failed",1)];policy={clientNames:[marker]};
      await model.propose({development:[{id:"dev",familyId:"family",input:"owner-authorized input",expected:"owner-authorized answer"}],mechanism:`${marker} strategy`,prediction:candidate.prediction,assumptions:[],testPlan:candidate.testPlan,history});
      expect(JSON.stringify(requests.map(r=>r.input))).not.toContain(marker);expect(promptData(requests[0]!).history[0].prediction).toMatchObject({change:"[redacted] predicted improvement"});
      await expect(model.run({caseId:"dev",arm:"treatment",input:"authorized task",instruction:`Use ${marker} data`})).rejects.toThrow(/disallowed/);expect(requests).toHaveLength(1);
    } finally {db.close();}
  });
});
