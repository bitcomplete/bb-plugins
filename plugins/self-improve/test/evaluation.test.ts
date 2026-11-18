import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { evaluateInstruction, sealManifest, createEvaluationModel, recoverInterruptedEvaluations, type EvaluationOptions, type EvaluationSuite, type ExploratoryArtifact } from "../src/evaluation.js";
import type { NativeExecution, NativeTaskReceipt, NativeTaskRequest } from "../src/native-tasks.js";
import { NOW, solution } from "./domain/fixtures.js";

// Native architecture migration: see reviews/delivery/native-legacy-evaluation-test-mapping.md.
// These fixtures assert development observations only; no test flag grants isolation or adoption.
const dbs: Database.Database[] = [], dirs: string[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
const execution:NativeExecution={projectId:"project-one",environment:{type:"reuse",environmentId:"environment"},providerId:"codex",model:"selected",permissionMode:"accept-edits"};
function receipt(request:NativeTaskRequest,value:unknown):NativeTaskReceipt {
  return {taskId:request.id,runId:request.runId,solutionId:request.solutionId,stage:request.stage,providerId:request.execution.providerId,model:request.execution.model,modelIdentitySource:"requested-selection",threadId:`thread-${request.id}`,requestId:"request",turnId:"turn",promptHash:"a".repeat(64),startedAtMs:NOW,endedAtMs:NOW+1,text:JSON.stringify(value)};
}
function context() {
  const db=new Database(":memory:");dbs.push(db);MIGRATIONS.forEach(m=>db.exec(m));const store=new Store(db);store.put("solutions","s-a",solution());
  const suite:EvaluationSuite={id:"suite-one",development:[{id:"dev-one",familyId:"dev-family",input:"visible input",expected:"VISIBLE"}],heldOut:[{id:"held-one",familyId:"held-family",input:"sealed input",expected:"HIDDEN"}]};
  const execute=vi.fn(async(request:NativeTaskRequest)=>receipt(request,request.instructions.startsWith("Propose one")?{instruction:"Answer the input faithfully and preserve all meaningful data."}:{output:request.instructions.includes("Additional instruction:")?"VISIBLE":"WRONG"}));
  let tick=NOW;
  const options:EvaluationOptions={store,attemptId:"attempt-one",solutionId:"s-a",revision:"revision-one",suite,runner:{execute},execution,runId:"run-one",privacyGeneration:"privacy-one",currentPrivacyGeneration:()=>"privacy-one",privacy:()=>({}),signal:new AbortController().signal,scopeProjectIds:["project-one"],minimumGain:.2,now:()=>++tick};
  return {options,store,execute};
}
describe("native development evaluation and historical recovery",()=>{
  it("retains executed development observations without issuing held-out proof",async()=>{
    const {options,store,execute}=context(),result=await evaluateInstruction(options);
    expect(result).toMatchObject({status:"completed",baselinePassed:0,treatmentPassed:1,evaluationId:null,adoptionGate:{status:"blocked"}});
    expect(execute).toHaveBeenCalledTimes(3);expect(JSON.stringify(execute.mock.calls)).not.toMatch(/sealed input|held-family|HIDDEN/);
    expect(store.list("trusted-evaluations")).toEqual([]);expect(store.list("validated-artifacts")).toEqual([]);expect(store.list("built-artifacts")).toEqual([]);
    expect(store.list("native-evaluation-artifacts")).toHaveLength(1);
    expect(await evaluateInstruction(options)).toEqual(result);expect(execute).toHaveBeenCalledTimes(3);
  });
  it("refuses development/held-out overlap before dispatch while allowing explicitly labeled development replay",async()=>{
    const {options,execute,store}=context();options.suite.heldOut[0]!.familyId=options.suite.development[0]!.familyId;
    await expect(evaluateInstruction(options)).rejects.toThrow(/overlap/);expect(execute).not.toHaveBeenCalled();
    options.suite.heldOut[0]!.familyId="reserved-family";
    const first=await evaluateInstruction(options);
    const replay=await evaluateInstruction({...options,attemptId:"attempt-two",revision:"revision-two",retestArtifactId:first.artifactId!});
    expect(replay).toMatchObject({status:"completed",evidenceKind:"exploratory-development-replay",adoptionGate:{status:"blocked"}});
    expect(store.list("consumed-evaluation-cases")).toEqual([]);expect(store.list("exposed-evaluation-cases").length).toBeGreaterThan(0);
  });
  it("does not call a net gain with a per-case regression a successful observation",async()=>{
    const {options,store,execute}=context();options.suite.development=[1,2,3].map(n=>({id:`dev-${n}`,familyId:`dev-family-${n}`,input:`case-${n}`,expected:"OK"}));
    execute.mockImplementation(async request=>receipt(request,request.instructions.startsWith("Propose one")?{instruction:"Preserve request data."}:{output:JSON.parse(request.input).input==="case-1"?(request.instructions.includes("Additional instruction:")?"WRONG":"OK"):(request.instructions.includes("Additional instruction:")?"OK":"WRONG")}));
    expect(await evaluateInstruction(options)).toMatchObject({status:"completed",regressions:1,baselinePassed:1,treatmentPassed:2,observationVerdict:"gain-or-regression-target-not-met",adoptionGate:{status:"blocked"}});
    expect(store.list("trusted-evaluations")).toEqual([]);
  });
  it("retains execution failure without exception text, hidden answers, or negative hypothesis evidence",async()=>{
    const {options,store,execute}=context();execute.mockRejectedValue(new Error("credential-secret and sealed input"));
    expect(await evaluateInstruction(options)).toMatchObject({status:"failed",observationVerdict:"inconclusive"});
    const records=JSON.stringify(store.list("native-evaluation-attempts"));expect(records).not.toMatch(/credential-secret|sealed input/);
    expect(store.get("solutions","s-a")).toMatchObject({attempts:[{outcome:"execution-error"}]});
  });
  it("retests the exact artifact under a new execution identity without changing the original",async()=>{
    const {options,store,execute}=context(),first=await evaluateInstruction(options),original=store.get<ExploratoryArtifact>("native-evaluation-artifacts",first.artifactId!)!;
    execute.mockClear();const result=await evaluateInstruction({...options,attemptId:"retest-one",revision:"revision-two",retestArtifactId:original.id,execution:{...execution,providerId:"claude-code",model:"new-model"}});
    expect(result).toMatchObject({status:"completed",model:{provider:"claude-code",model:"new-model"},evaluationId:null});
    expect(execute).toHaveBeenCalledTimes(2);expect(execute.mock.calls.every(([r])=>!r.instructions.startsWith("Propose one"))).toBe(true);
    expect(store.get("native-evaluation-artifacts",original.id)).toEqual(original);
    expect(store.get("native-evaluation-artifacts",result.artifactId!)).toMatchObject({content:original.content,artifactDigest:original.artifactDigest,builtWith:original.builtWith,sourceArtifactId:original.id});
  });
  it("fences legacy running attempts during startup without manufacturing native proof",()=>{
    const {store}=context();const legacy={id:"legacy",solutionId:"s-a",status:"running",artifactId:"partial",evaluationId:null,model:{provider:"historical-provider",model:"historical-model"}};
    store.put("evaluation-attempts",legacy.id,legacy);
    expect(recoverInterruptedEvaluations(store,NOW+1000)).toBe(1);
    expect(store.get("evaluation-attempts","legacy")).toMatchObject({status:"failed",reason:"evaluation-interrupted",artifactId:null,evaluationId:null});
    expect(recoverInterruptedEvaluations(store,NOW+2000)).toBe(0);expect(store.list("trusted-evaluations")).toEqual([]);expect(store.list("native-evaluation-attempts")).toEqual([]);
  });
  it("seals a historical manifest as a utility without claiming native isolation",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"self-improve-seal-test-"));dirs.push(directory);
    const content='{"fixtures":[]}',digest=createHash("sha256").update(content).digest("hex");
    const result=await sealManifest(directory,{digest,content});expect(result.commit).toMatch(/^[a-f0-9]{40,64}$/);expect(result.manifestDigest).toBe(digest);
  });
  it("keeps expected answers and proposer history out of development runner task input",async()=>{
    const {options,execute}=context(),io=createEvaluationModel(options);
    await io.propose({development:options.suite.development,prediction:solution().prediction,mechanism:"Preserve data",assumptions:[],testPlan:"Compare answers",history:[{outcome:"failed",reason:"prior tactic"}]});
    await io.run({caseId:"dev-one",arm:"treatment",input:"test input",instruction:"Preserve request data."});
    const request=execute.mock.calls[1]![0];expect(request.input).not.toMatch(/VISIBLE|prior tactic/);expect(request.input).toContain("test input");expect(io.mode).toBe("bb-native-exploratory");
  });
});
