import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuilder } from "../src/build.js";
import { defaultConfig } from "../src/config.js";
import type { EvaluationSuite } from "../src/evaluation.js";
import type { NativeExecution, NativeTaskReceipt, NativeTaskRequest } from "../src/native-tasks.js";
import type { StageContext } from "../src/services.js";
import { MIGRATIONS, Store } from "../src/store.js";
import { NOW, problem, solution } from "./domain/fixtures.js";
const dbs:Database.Database[]=[];afterEach(()=>{for(const db of dbs.splice(0))db.close();});
const execution:NativeExecution={projectId:"project",environment:{type:"reuse",environmentId:"environment"},providerId:"codex",model:"selected-model",permissionMode:"accept-edits"};
function setup(){
  const db=new Database(":memory:");dbs.push(db);MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db),candidate=solution();store.put("solutions",candidate.id,candidate);
  const p=problem();p.aliases=["old-problem"];store.put("problems",p.id,p);
  const suite:EvaluationSuite={id:"suite",development:[{id:"dev",familyId:"dev-family",input:"development task",expected:"OK"}],heldOut:[{id:"reserved",familyId:"reserved-family",input:"NEVER_NATIVE_HELD_OUT",expected:"SECRET_EXPECTATION"}]};
  const execute=vi.fn(async(request:NativeTaskRequest):Promise<NativeTaskReceipt>=>({taskId:request.id,runId:request.runId,solutionId:request.solutionId,stage:request.stage,providerId:request.execution.providerId,model:request.execution.model,modelIdentitySource:"requested-selection",threadId:"thread",requestId:"request",turnId:"turn",promptHash:"a".repeat(64),startedAtMs:NOW,endedAtMs:NOW+1,
    text:JSON.stringify(request.instructions.startsWith("Propose one")?{instruction:"Preserve the original input across retries."}:{output:request.instructions.includes("Additional instruction:")?"OK":"WRONG"})}));
  const options={store,config:()=>({...defaultConfig(),scopeProjectIds:["project"]}),runner:{execute},execution:()=>execution,suite:()=>JSON.stringify(suite),privacy:()=>({clientNames:["PrivateClient"]}),privacyGeneration:()=>"generation"};
  const context:StageContext={job:{id:"job",key:"builder",stage:"builder",input:{},attempts:1,createdAt:NOW,runId:"run-one"},boot:"boot",signal:new AbortController().signal};
  return {store,candidate,execute,options,context};
}
describe("BB-native builder adoption boundary",()=>{
  it("exposes exploratory gain separately from the blocked adoption gate",async()=>{
    const {options,context,candidate,store}=setup();const build=createBuilder(options);
    expect(await build(context,candidate,false)).toMatchObject({exploratory:1,completed:1,gainObserved:1,adoptionBlocked:1,adopted:0});
    expect(store.get("build-decisions","job")).toMatchObject({status:"adoption-blocked",executionStatus:"completed",observationVerdict:"gain-without-regression"});
    expect(store.list("trusted-evaluations")).toEqual([]);expect(store.list("validated-artifacts")).toEqual([]);expect(store.list("baseline-anchors")).toEqual([]);
  });
  it("preserves the prior decision when a retry selects a different candidate or request",async()=>{
    const {options,context,candidate,store,execute}=setup(),build=createBuilder(options);
    await build(context,candidate,false);const prior=store.get("build-decisions","job");
    const another={...candidate,id:"another"};store.put("solutions",another.id,another);
    await expect(build(context,another,false)).rejects.toThrow("native-builder-job-identity-changed");
    await expect(createBuilder({...options,execution:()=>({...execution,permissionMode:"full"})})(context,candidate,false)).rejects.toThrow("immutable attempt");
    expect(store.get("build-decisions","job")).toEqual(prior);expect(execute).toHaveBeenCalledTimes(3);
  });
  it("uses current ledger eligibility instead of a stale queued candidate object",async()=>{
    const {options,context,candidate,store,execute}=setup();
    store.put("solutions",candidate.id,{...candidate,scores:{...candidate.scores,safety:.2}});
    expect(await createBuilder(options)(context,candidate,false)).toEqual({riskDecisions:1});
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([true,false])("leaves the automatic queue after completed observations (gain=%s) without adopting",async gain=>{
    const {options,context,candidate,store,execute}=setup(),build=createBuilder(options);
    if(!gain){const implementation=execute.getMockImplementation()!;execute.mockImplementation(async request=>({...await implementation(request),...(request.instructions.startsWith("Propose one")?{}:{text:JSON.stringify({output:"WRONG"})})}));}
    expect(await build(context,candidate,false)).toMatchObject({completed:1,gainObserved:Number(gain),adopted:0});
    expect(store.get("solutions",candidate.id)).toMatchObject({candidateState:"built",status:null,validatedWith:null,wiring:null});
    const nextContext={...context,job:{...context.job,id:"next-job",runId:"run-two"}};
    expect(await build(nextContext,candidate,false)).toEqual({deferred:1});expect(execute).toHaveBeenCalledTimes(3);
    // Original job recovery stays idempotent despite the changed queue disposition.
    expect(await build(context,candidate,false)).toMatchObject({completed:1,adopted:0});expect(execute).toHaveBeenCalledTimes(3);
    const next={...solution("next"),directionKey:"another-direction",mechanism:"A different candidate"};store.put("solutions",next.id,next);
    expect(await build({...nextContext,job:{...nextContext.job,id:"different-candidate-job"}},next,false)).toMatchObject({completed:1,adopted:0});
    expect(execute).toHaveBeenCalledTimes(6);expect(store.list("trusted-evaluations")).toEqual([]);
  });
  it("retains operational failure history but permits a new bounded job after admission recovers",async()=>{
    const {options,context,candidate,store,execute}=setup(),build=createBuilder(options);
    execute.mockRejectedValueOnce(new Error("admission denied"));
    expect(await build(context,candidate,false)).toMatchObject({failed:1,completed:0,adopted:0});
    expect(store.get("solutions",candidate.id)).toMatchObject({candidateState:"proposed",attempts:[{outcome:"execution-error"}]});
    const failed=store.list("native-evaluation-attempts")[0],failedTask=execute.mock.calls[0]![0].id;
    const next={...context,job:{...context.job,id:"recovered-job",runId:"run-two"}};
    expect(await build(next,candidate,false)).toMatchObject({completed:1,adopted:0});
    expect(execute).toHaveBeenCalledTimes(4);expect(execute.mock.calls[1]![0].id).not.toBe(failedTask);
    expect(store.list("native-evaluation-attempts")).toContainEqual(failed);
    expect(store.get("solutions",candidate.id)).toMatchObject({attempts:[{outcome:"execution-error"},{outcome:"built"}]});
  });
  it("retains complete related failed/removed history with privacy projection, excluding unknown unrelated references",async()=>{
    const {options,context,candidate,store,execute}=setup();
    const failed=solution("failed");failed.directionKey="failed-direction";failed.mechanism="PrivateClient earlier approach";
    failed.attempts=[{id:"opaque-attempt",atMs:NOW-2,directionKey:failed.directionKey,prediction:failed.prediction,outcome:"failed",reason:"PrivateClient prior failure",evidenceIds:["opaque-evidence"],model:{provider:"old",model:"old"}}];
    const removed=solution("removed");removed.directionKey="removed-direction";removed.problemIds=["unknown-old-problem","old-problem"];removed.status="removed";removed.mechanism="An abandoned approach";removed.attempts=[{...failed.attempts[0]!,id:"opaque-removed",atMs:NOW-1,outcome:"removed",reason:"Removed after failure"}];
    const orphan=solution("orphan");orphan.problemIds=["unknown-old-problem"];orphan.attempts=[{...failed.attempts[0]!,reason:"UNRELATED_HISTORY"}];
    for(const row of [failed,removed,orphan])store.put("solutions",row.id,row);
    await createBuilder(options)(context,candidate,false);
    const proposal=execute.mock.calls[0]![0],data=JSON.parse(proposal.input);
    expect(data.history.map((entry:{outcome:string})=>entry.outcome)).toEqual(["failed","removed"]);
    expect(proposal.input).toContain("[redacted] prior failure");expect(proposal.input).not.toMatch(/PrivateClient|opaque-|UNRELATED_HISTORY|NEVER_NATIVE_HELD_OUT|SECRET_EXPECTATION/);
    expect(store.get("solutions","failed")).toEqual(failed);expect(store.get("solutions","removed")).toEqual(removed);
  });
  it("refuses a queued revalidation when its selected execution configuration changed",async()=>{
    const {options,context,candidate,execute}=setup();context.job.input.execution={...execution,permissionMode:"full"};
    await expect(createBuilder(options)(context,candidate,true)).rejects.toThrow("retest-execution-changed");expect(execute).not.toHaveBeenCalled();
  });
});
