import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateInstruction, recoverInterruptedEvaluations, type EvaluationOptions, type EvaluationSuite, type ExploratoryArtifact } from "../src/evaluation.js";
import type { NativeExecution, NativeTaskReceipt, NativeTaskRequest } from "../src/native-tasks.js";
import { MIGRATIONS, Store } from "../src/store.js";
import { NOW, solution } from "./domain/fixtures.js";
const dbs:Database.Database[]=[];afterEach(()=>{for(const db of dbs.splice(0))db.close();});
const execution:NativeExecution={projectId:"project",environment:{type:"reuse",environmentId:"environment"},providerId:"codex",model:"selected-model",permissionMode:"accept-edits"};
function reply(request:NativeTaskRequest,value?:unknown):NativeTaskReceipt {
  const proposed=request.instructions.startsWith("Propose one"),treatment=request.instructions.includes("Additional instruction:");
  return {taskId:request.id,runId:request.runId,solutionId:request.solutionId,stage:request.stage,providerId:request.execution.providerId,model:request.execution.model,modelIdentitySource:"requested-selection",threadId:`thread-${request.id}`,requestId:"request",turnId:"turn",promptHash:"a".repeat(64),startedAtMs:NOW,endedAtMs:NOW+1,
    text:JSON.stringify(value??(proposed?{instruction:"Preserve the original input across retries."}:{output:treatment?"EXPECTED":"WRONG"}))};
}
function setup(){
  const db=new Database(":memory:");dbs.push(db);MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);store.put("solutions","s-a",solution());
  const suite:EvaluationSuite={id:"suite",development:[{id:"dev",familyId:"development-family",input:"A development task",expected:"EXPECTED"}],heldOut:[{id:"hidden",familyId:"hidden-family",input:"HELD_OUT_INPUT_MUST_STAY_LOCAL",expected:"HELD_OUT_EXPECTED_MUST_STAY_LOCAL"}]};
  const execute=vi.fn(async(request:NativeTaskRequest)=>reply(request));let tick=NOW;
  const options:EvaluationOptions={store,runner:{execute},attemptId:"attempt",solutionId:"s-a",revision:"revision",runId:"run-one",execution,suite,scopeProjectIds:["project"],privacyGeneration:"privacy-one",currentPrivacyGeneration:()=>"privacy-one",privacy:()=>({}),signal:new AbortController().signal,now:()=>++tick};
  return {store,execute,options};
}
describe("BB-native exploratory instruction evaluation",()=>{
  it.each(["codex","claude-code"])("records useful %s development comparisons while keeping adoption blocked",async providerId=>{
    const {options,execute,store}=setup();const result=await evaluateInstruction({...options,execution:{...execution,providerId}});
    expect(result).toMatchObject({status:"completed",evidenceKind:"exploratory-development-replay",observationVerdict:"gain-without-regression",baselinePassed:0,treatmentPassed:1,completedExecutions:2,evaluationId:null,adoptionGate:{status:"blocked",reason:"native-isolation-unverified"}});
    expect(execute).toHaveBeenCalledTimes(3);expect(execute.mock.calls.every(([r])=>r.execution.providerId===providerId)).toBe(true);
    expect(JSON.stringify(execute.mock.calls)).not.toContain("HELD_OUT_");
    expect(JSON.stringify(store.list("native-evaluation-attempts"))).not.toContain("HELD_OUT_");
    expect(store.list("trusted-evaluations")).toEqual([]);expect(store.list("validated-artifacts")).toEqual([]);expect(store.list("built-artifacts")).toEqual([]);
    expect(store.list("consumed-evaluation-cases")).toEqual([]);expect(store.list("native-evaluation-artifacts")).toHaveLength(1);
    expect(store.get("solutions","s-a")).toMatchObject({candidateState:"built",status:null,validatedWith:null,wiring:null});
  });
  it("reuses a completed attempt but refuses a changed provider/permission/scope request",async()=>{
    const {options,execute}=setup();const first=await evaluateInstruction(options);expect(await evaluateInstruction(options)).toEqual(first);expect(execute).toHaveBeenCalledTimes(3);
    await expect(evaluateInstruction({...options,execution:{...execution,permissionMode:"full"}})).rejects.toThrow("immutable attempt");
    await expect(evaluateInstruction({...options,scopeProjectIds:["another"]})).rejects.toThrow("immutable attempt");
  });
  it("binds an attempt to the selected solution even when another candidate has the same definition",async()=>{
    const {options,store,execute}=setup();
    await evaluateInstruction(options);store.put("solutions","another",{...solution(),id:"another"});
    await expect(evaluateInstruction({...options,solutionId:"another"})).rejects.toThrow("immutable attempt");
    expect(execute).toHaveBeenCalledTimes(3);expect(store.get("native-evaluation-attempts","attempt")).toMatchObject({solutionId:"s-a"});
  });
  it("preserves declared dependencies and the test plan in fresh proposer input and binds timeout policy",async()=>{
    const {options,store,execute}=setup(),candidate={...solution(),assumptions:["Requires the configured task tracker"],testPlan:"Compare task turnaround under the declared configuration"};
    store.put("solutions",candidate.id,candidate);
    await evaluateInstruction({...options,timeoutMs:45678});
    const proposal=JSON.parse(execute.mock.calls[0]![0].input);
    expect(proposal).toMatchObject({assumptions:candidate.assumptions,testPlan:candidate.testPlan});
    expect(execute.mock.calls.every(([request])=>request.timeoutMs===45678)).toBe(true);
    await expect(evaluateInstruction({...options,timeoutMs:45679})).rejects.toThrow("immutable attempt");
  });
  it("distinguishes completed observations with no gain from execution failure and cancellation",async()=>{
    const a=setup();a.execute.mockImplementation(async request=>reply(request,request.instructions.startsWith("Propose one")?undefined:{output:"WRONG"}));
    expect(await evaluateInstruction(a.options)).toMatchObject({status:"completed",observationVerdict:"gain-or-regression-target-not-met",adoptionGate:{status:"blocked"}});
    const b=setup();b.execute.mockRejectedValue(new Error("private exception text"));
    expect(await evaluateInstruction(b.options)).toMatchObject({status:"failed",observationVerdict:"inconclusive",adoptionGate:{status:"blocked"}});
    expect(JSON.stringify(b.store.list("native-evaluation-attempts"))).not.toContain("private exception text");
    expect(b.store.get("solutions","s-a")).toMatchObject({candidateState:"proposed",attempts:[{outcome:"execution-error"}]});
    const c=setup(),controller=new AbortController();c.execute.mockImplementation(async request=>{controller.abort();return reply(request);});
    expect(await evaluateInstruction({...c.options,signal:controller.signal})).toMatchObject({status:"cancelled",adoptionGate:{status:"blocked"}});
    expect(c.store.get("solutions","s-a")).toMatchObject({candidateState:"proposed",attempts:[{outcome:"execution-error",reason:"exploratory-evaluation-cancelled"}]});
  });
  it("replays an unchanged artifact without proposing or overwriting historical evidence",async()=>{
    const {options,store,execute}=setup(),content="Use the established instruction without changes.";
    const historical={id:"historical",solutionId:"s-a",revision:"old-revision",kind:"instruction",content,artifactDigest:createHash("sha256").update(content).digest("hex"),createdAtMs:NOW-1,model:{provider:"old",model:"old"},builtWith:{provider:"old",model:"old"},scopeProjectIds:["project"],evaluationId:"old-proof",sourceArtifactId:null};
    store.put("built-artifacts","historical",historical);store.put("trusted-evaluations","old-proof",{status:"passed",executionCount:6});
    const result=await evaluateInstruction({...options,retestArtifactId:"historical"});expect(execute).toHaveBeenCalledTimes(2);
    const artifact=store.get<ExploratoryArtifact>("native-evaluation-artifacts",result.artifactId!)!;
    expect(artifact).toMatchObject({content,artifactDigest:historical.artifactDigest,sourceArtifactId:"historical",builtWith:historical.builtWith,evaluationId:null});
    expect(store.get("built-artifacts","historical")).toEqual(historical);expect(store.get("trusted-evaluations","old-proof")).toEqual({status:"passed",executionCount:6});
  });
  it("fences an interrupted turn and resumes the original task/run binding after recovery",async()=>{
    const {options,store,execute}=setup();let release!:(receipt:NativeTaskReceipt)=>void;
    execute.mockImplementationOnce(request=>new Promise(resolve=>{release=resolve;}));
    const first=evaluateInstruction(options);await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    expect(store.list("native-evaluation-operations")).toMatchObject([{runId:"run-one"}]);
    expect(recoverInterruptedEvaluations(store,NOW+50)).toBe(1);release(reply(execute.mock.calls[0]![0]));
    expect(await first).toMatchObject({status:"interrupted"});
    const resumed=await evaluateInstruction({...options,runId:"run-two"});expect(resumed).toMatchObject({status:"completed",runId:"run-one"});
    expect(execute.mock.calls[0]![0].id).toBe(execute.mock.calls[1]![0].id);expect(execute.mock.calls.every(([r])=>r.runId==="run-one")).toBe(true);
  });
  it("fails visibly when privacy or the candidate changes while a task runs",async()=>{
    const a=setup();let generation="privacy-one";a.execute.mockImplementation(async request=>{generation="privacy-two";return reply(request);});
    expect(await evaluateInstruction({...a.options,currentPrivacyGeneration:()=>generation})).toMatchObject({status:"failed",artifactId:null});
    const b=setup();b.execute.mockImplementation(async request=>{b.store.put("solutions","s-a",{...solution(),problemIds:["a-new-context"]});return reply(request);});
    expect(await evaluateInstruction(b.options)).toMatchObject({status:"failed",artifactId:null});
    expect(b.store.list("trusted-evaluations")).toEqual([]);
  });
  it("rejects concurrent callers and keeps baseline tasks free of proposer history and expected answers",async()=>{
    const {options,execute}=setup();let release!:(receipt:NativeTaskReceipt)=>void;
    execute.mockImplementationOnce(request=>new Promise(resolve=>{release=resolve;}));
    const first=evaluateInstruction({...options,history:()=>[{outcome:"failed",reason:"A prior failed tactic"}]});await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    await expect(evaluateInstruction(options)).rejects.toThrow("in progress");release(reply(execute.mock.calls[0]![0]));await first;
    expect(execute.mock.calls[0]![0].input).toContain("A prior failed tactic");
    for(const [request] of execute.mock.calls.slice(1)){expect(request.input).not.toContain("EXPECTED");expect(request.input).not.toContain("prior failed tactic");}
  });
});
