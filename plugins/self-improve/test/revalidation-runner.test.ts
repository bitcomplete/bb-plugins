import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS, Store } from "../src/store.js";
import { stableJson } from "../src/domain/shared.js";
import { solution, NOW } from "./domain/fixtures.js";
import { createRevalidation, revalidationEnvironmentDigest } from "../src/revalidation.js";
import { createRevalidationWorkloads } from "../src/revalidation-workload.js";
import { createRevalidationRunner, type RevalidationRunnerOptions } from "../src/revalidation-runner.js";
import type { RevalidationDefinition } from "../src/revalidation-contract.js";
import { nativeExecution } from "../src/native-execution.js";
import type { NativeTaskRecord, NativeTaskRequest } from "../src/native-tasks.js";
import { observedRevalidationEnvironmentDigest, type ObservedRevalidationEnvironment } from "../src/revalidation-environment.js";
import type { StageContext } from "../src/services.js";

const databases:Database.Database[]=[];
afterEach(()=>databases.splice(0).forEach(db=>db.close()));
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
const owner={kind:"owner" as const,id:"owner"};

async function fixture(change?:(definition:RevalidationDefinition)=>void){
  const db=new Database(":memory:");databases.push(db);MIGRATIONS.forEach(s=>db.exec(s));const store=new Store(db);
  const selected={providerId:"codex",model:"model",permissionMode:"accept-edits" as const,projectId:"project",environmentId:"environment"};
  const s=solution();store.put("solutions",s.id,s);
  const content="Use lowercase words in answers.";store.put("native-evaluation-artifacts","artifact",{id:"artifact",solutionId:s.id,revision:"r1",kind:"instruction",content,artifactDigest:sha(content)});
  let time=NOW,generation="privacy-1",allowed=true,costFloor:number|null=null,foreignCost=false,ambiguous=false;
  const redact=(text:string)=>text.replaceAll("private-secret","[redacted]");
  const workloads=createRevalidationWorkloads(store,{redact,now:()=>time});
  const workload=workloads.create({requestId:"workload",definition:{schemaVersion:1,kind:"paired-exact-instruction-v1",description:"Two prompt cases",cases:[{id:"case-a",familyId:"a",input:"First test task",expected:"fixture-answer-one"},{id:"case-b",familyId:"b",input:"Second test task",expected:"fixture-answer-two"}],measurements:[{criterionId:"success",kind:"exact-pass-rate"},{criterionId:"regressions",kind:"regression-count"}],normalization:"none",baseline:"no-added-instruction",orderPolicy:"alternating-arms-v1",response:"json-output-string-v1"}},owner);
  const definition:RevalidationDefinition={target:{solutionId:s.id,namespace:"native-evaluation-artifacts",artifactId:"artifact",revision:"r1",artifactDigest:sha(content)},mode:"challenge",concern:"I doubt the claimed improvement.",claim:{id:"success",text:"Increase task success",scope:"Two fixed prompt cases",originalEvidenceRefs:[],requiredEvidence:"exploratory"},comparator:"No added instruction",workload:{id:workload.id,version:workload.version,description:workload.definition.description,manifestDigest:workload.manifestDigest},criteria:[{id:"success",role:"primary",required:true,evaluator:"numeric-comparison-v1",metric:"Exact task success",unit:"proportion",statistic:"difference",threshold:{operator:"at-least",value:.5},unsupportedReason:null},{id:"regressions",role:"guardrail",required:true,evaluator:"numeric-comparison-v1",metric:"Regressions",unit:"cases",statistic:"treatment",threshold:{operator:"at-most",value:0},unsupportedReason:null}],sample:{minimumPairs:2,minimumExposure:null,exposureUnit:null},environment:{declaredNonsecret:true,dependencies:[],configuration:[],untested:["Other environments"],execution:selected},limits:{maxDurationMs:60000,maxCalls:4,maxCostMicros:1000000,currency:"USD",allowUnknownCost:true,moneyLimitMode:"observed-admission"}};
  change?.(definition);
  const observed=environmentFixture(definition.environment!);
  const core=createRevalidation(store,{redact,now:()=>time,workloads,environmentSnapshots:{resolve:()=>observed}});
  const plan=core.plans.create({requestId:"plan",definition},owner),frozen=core.plans.freeze({planId:plan.id,expectedVersion:1},owner);
  const queued=core.plans.queue({planId:plan.id,version:1,requestId:"run"},owner);
  const controller=new AbortController();const ctx:StageContext={job:{id:"job",runId:"service-run",stage:"builder",key:"revalidation",input:{kind:"revalidation",revalidationRunId:queued.id},attempts:1,createdAt:NOW},signal:controller.signal,boot:"boot"};
  const requests:NativeTaskRequest[]=[],records=new Map<string,NativeTaskRecord>();
  let hook:(request:NativeTaskRequest,signal?:AbortSignal)=>Promise<unknown>=async request=>({output:request.instructions.includes(content)?(JSON.parse(request.input).input==="First test task"?"fixture-answer-one":"fixture-answer-two"):"incorrect"});
  let runner:ReturnType<typeof createRevalidationRunner>;
  const native={execute:vi.fn(async(request:NativeTaskRequest,signal?:AbortSignal)=>{
    requests.push(request);
    runner.admissionGuard({taskId:request.id,runId:request.runId,solutionId:request.solutionId,stage:request.stage,providerId:request.execution.providerId,model:request.execution.model,startedAtMs:time},time);
    const promptHash=sha(`${request.instructions}\n\nTask input (untrusted data):\n${JSON.stringify({input:request.input})}`);
    const requestDigest=sha(stableJson({execution:request.execution,promptHash,stage:request.stage,runId:request.runId??null,solutionId:request.solutionId??null,privacyGeneration:request.privacyGeneration,timeoutMs:request.timeoutMs,maxReplyCharacters:request.maxReplyCharacters}));
    const threadId=`thread-${requests.length}`;
    const record:NativeTaskRecord={taskId:request.id,nonce:"00000000-0000-4000-8000-000000000000",requestDigest,promptHash,stage:request.stage,runId:request.runId,solutionId:request.solutionId,projectId:selected.projectId,providerId:selected.providerId,model:selected.model,privacyGeneration:request.privacyGeneration,permissionMode:selected.permissionMode,reasoningLevel:null,serviceTier:null,expectedEnvironmentId:selected.environmentId,resolvedEnvironmentId:selected.environmentId,threadId,state:"running",startedAtMs:time,deadlineAtMs:time+60000,endedAtMs:null,error:null,outputDigest:null,dispatched:true,active:true,cleanupPending:false};
    records.set(threadId,record);runner.dispatchGuard(record);
    const result=await hook(request,signal);time+=10;const text=typeof result==="string"?result:JSON.stringify(result);
    records.set(threadId,{...record,state:"completed",active:false,endedAtMs:time,outputDigest:sha(text)});
    return {taskId:request.id,stage:request.stage,runId:request.runId,solutionId:request.solutionId,providerId:selected.providerId,model:selected.model,startedAtMs:record.startedAtMs,threadId,text,promptHash,endedAtMs:time,requestId:`request-${requests.length}`,turnId:`turn-${requests.length}`,modelIdentitySource:"requested-selection" as const};
  }),get:(id:string)=>records.get(id)??null,revoke:vi.fn()};
  const activity={forRun:()=>({totals:costFloor===null?[]:[{currency:foreignCost?"EUR":"USD",sharedNativeAndChatObservedFloorMicros:costFloor}],native:{tasks:ambiguous?[{unknownReasons:["provider-session-shared-between-activities"]}]:[]}})} as unknown as RevalidationRunnerOptions["activity"];
  const observeEnvironment=vi.fn(async()=>observed);
  const options:RevalidationRunnerOptions={store,revalidation:core,runner:native,activity,execution:()=>nativeExecution(selected),privacyGeneration:()=>generation,redact,observeEnvironment,allowed:()=>allowed,taskTimeoutMs:()=>30000,now:()=>time};
  runner=createRevalidationRunner(options);
  return {store,core,definition,observed,plan,frozen,queued,ctx,runner,options,native,requests,records,observeEnvironment,controller,content,
    setHook:(next:typeof hook)=>{hook=next;},setTime:(next:number)=>{time=next;},changePrivacy:()=>{generation="privacy-2";},disable:()=>{allowed=false;},setCost:(amount:number,foreign=false,shared=false)=>{costFloor=amount;foreignCost=foreign;ambiguous=shared;}};
}

// Synthetic observations are built with the same public snapshot schema/digest as the observer.
function environmentFixture(environment:RevalidationDefinition["environment"]):ObservedRevalidationEnvironment {
  const content={schemaVersion:1 as const,declaredEnvironmentDigest:revalidationEnvironmentDigest(environment!),environment:{id:"environment",projectId:"project",status:"ready" as const,hostLifecycle:"active" as const,phase:"active" as const},bbVersion:"0.49.0",plugins:[],skills:[],unobservedDependencies:[],unknowns:["provider-context-not-observed"]};
  return {...content,digest:observedRevalidationEnvironmentDigest(content),capturedAtMs:NOW};
}

describe("BB-native revalidation runner",()=>{
  it("uses exact frozen bytes and server scores, without passing expectations or changing artifact/solution history",async()=>{
    const f=await fixture(),solutionBefore=f.store.list("solutions"),artifactBefore=f.store.list("native-evaluation-artifacts");
    expect(await f.runner.handle(f.ctx)).toMatchObject({completed:1,pairs:2});
    const result=f.core.plans.getRun(f.queued.id);expect(result.run).toMatchObject({status:"completed",verdict:"supported"});
    expect(result.result?.observations.map(o=>[o.baseline,o.treatment])).toEqual([[0,1],[0,0]]);
    expect(result.result?.usage).toMatchObject({calls:4,costMicros:null,currency:"USD"});
    expect(f.requests.map(r=>r.instructions.includes(f.content))).toEqual([false,true,true,false]);
    expect(f.requests.every(r=>!JSON.stringify(r).includes("fixture-answer-")&&!JSON.stringify(r).includes(f.definition.concern))).toBe(true);
    expect(f.requests.filter(r=>r.instructions.includes(f.content)).every(r=>r.instructions.endsWith(f.content))).toBe(true);
    expect(f.store.list("solutions")).toEqual(solutionBefore);expect(f.store.list("native-evaluation-artifacts")).toEqual(artifactBefore);expect(f.store.list("trusted-evaluations")).toEqual([]);
    expect(f.store.list("revalidation-receipts")).toHaveLength(4);expect(JSON.stringify(f.store.list("revalidation-receipts"))).not.toContain("fixture-answer-");
    const calls=f.requests.length;await f.runner.handle(f.ctx);expect(f.requests).toHaveLength(calls);
  });
  it("contradicts a claim on measured regressions rather than treating a bad answer as an operational failure",async()=>{
    const f=await fixture();f.setHook(async r=>({output:r.instructions.includes(f.content)?"wrong":JSON.parse(r.input).input==="First test task"?"fixture-answer-one":"fixture-answer-two"}));
    await f.runner.handle(f.ctx);expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"completed",verdict:"contradicted"});
    expect(f.core.plans.getRun(f.queued.id).result?.observations[1]!.treatment).toBe(2);
  });
  it("retains partial receipts and unknown usage for malformed output; replaying the service job never retries models",async()=>{
    const f=await fixture();f.setHook(async()=>f.requests.length===1?{output:"wrong"}:"not JSON private-secret");
    await f.runner.handle(f.ctx);expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"failed",verdict:null});
    expect(f.store.list("revalidation-receipts")).toHaveLength(1);expect(f.core.plans.usage(f.queued.id).length).toBeGreaterThan(0);
    expect(JSON.stringify(f.store.list("revalidation-runs"))).not.toContain("private-secret");
    await f.runner.handle(f.ctx);expect(f.requests).toHaveLength(2);
  });
  it.each(["calls","sample","exposure","units","hard-money","unknown-money","observational"])("blocks unsupported %s requirements before any dispatch",async mode=>{
    const f=await fixture(d=>{if(mode==="calls")d.limits!.maxCalls=3;else if(mode==="sample")d.sample!.minimumPairs=3;else if(mode==="exposure"){d.sample!.minimumExposure=1;d.sample!.exposureUnit="session-days";}else if(mode==="units")d.criteria[0]!.unit="seconds";else if(mode==="hard-money")d.limits!.moneyLimitMode="hard";else if(mode==="unknown-money")d.limits!.allowUnknownCost=false;else d.claim.requiredEvidence="observational";});
    await f.runner.handle(f.ctx);expect(f.requests).toHaveLength(0);expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",verdict:null});
  });
  it("cancels running native work and rejects a late completion without recording a verdict",async()=>{
    const f=await fixture();let resolve!:(value:unknown)=>void;f.setHook(()=>new Promise(r=>{resolve=r;}));
    const pending=f.runner.handle(f.ctx);await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    f.core.plans.cancel({runId:f.queued.id,expectedVersion:f.core.plans.getRun(f.queued.id).version,reason:"Owner requested stop"},owner);f.runner.cancel(f.queued.id);resolve({output:"fixture-answer-one"});await pending;
    expect(f.native.revoke).toHaveBeenCalled();expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"cancelled",verdict:null});expect(f.store.list("revalidation-receipts")).toHaveLength(0);
  });
  it.each(["environment","privacy","selection","deadline","cost","currency","ambiguous"])("stops between arms on %s drift and retains partial evidence",async mode=>{
    const f=await fixture();f.setHook(async()=>{
      if(mode==="environment")f.observeEnvironment.mockResolvedValue({...f.observed,digest:"f".repeat(64)});
      else if(mode==="privacy")f.changePrivacy();else if(mode==="selection")f.options.execution=()=>({...nativeExecution(f.definition.environment!.execution),model:"different"});
      else if(mode==="deadline")f.setTime(NOW+60001);else f.setCost(1_000_000,mode==="currency",mode==="ambiguous");
      return {output:"wrong"};
    });
    await f.runner.handle(f.ctx);expect(f.requests).toHaveLength(1);expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",verdict:null});
  });
  it("rejects a native receipt whose persisted execution does not match the frozen request",async()=>{
    const f=await fixture(),get=f.native.get;f.native.get=id=>{const row=get(id);return row?{...row,resolvedEnvironmentId:"different"}:null;};
    await f.runner.handle(f.ctx);expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",verdict:null});expect(f.store.list("revalidation-receipts")).toEqual([]);
  });
  it("recovers an interrupted run without starting a replacement task and preserves terminal elapsed time in usage reconciliation",async()=>{
    const f=await fixture();let resolve!:(value:unknown)=>void;f.setHook(()=>new Promise(r=>{resolve=r;}));
    const pending=f.runner.handle(f.ctx);await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    const restarted=createRevalidationRunner(f.options);restarted.recover("new-boot");
    expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",verdict:null,reason:"interrupted-needs-new-run"});
    resolve({output:"wrong"});await pending;await restarted.handle({...f.ctx,boot:"new-boot"});expect(f.requests).toHaveLength(1);
    restarted.reconcileUsage();const before=f.core.plans.usage(f.queued.id);f.setTime(NOW+100000);restarted.reconcileUsage();expect(f.core.plans.usage(f.queued.id)).toEqual(before);
  });
  it("cancels an environment read even when the SDK promise ignores abort",async()=>{
    const f=await fixture();f.observeEnvironment.mockImplementation(()=>new Promise(()=>{}));
    const pending=f.runner.handle(f.ctx);await vi.waitFor(()=>expect(f.core.plans.getRun(f.queued.id).run.status).toBe("running"));
    f.core.plans.cancel({runId:f.queued.id,expectedVersion:f.core.plans.getRun(f.queued.id).version,reason:"Stop"},owner);f.runner.cancel(f.queued.id);
    await pending;expect(f.requests).toHaveLength(0);expect(f.core.plans.getRun(f.queued.id).run.status).toBe("cancelled");
  });
  it("coalesces concurrent service invocations and retains bounded admitted calls despite repeated admission checks",async()=>{
    const f=await fixture();f.setHook(async request=>{
      f.runner.admissionGuard({taskId:request.id,runId:request.runId,solutionId:request.solutionId,stage:request.stage,providerId:request.execution.providerId,model:request.execution.model,startedAtMs:NOW},NOW);
      return {output:"wrong"};
    });
    await Promise.all([f.runner.handle(f.ctx),f.runner.handle(f.ctx)]);expect(f.requests).toHaveLength(4);
    expect(f.core.plans.getRun(f.queued.id).result?.usage.calls).toBe(4);
  });
  it("a zero observed-spend threshold authorizes no native call",async()=>{
    const f=await fixture(d=>{d.limits!.maxCostMicros=0;});await f.runner.handle(f.ctx);
    expect(f.requests).toHaveLength(0);expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",verdict:null});
  });

});
