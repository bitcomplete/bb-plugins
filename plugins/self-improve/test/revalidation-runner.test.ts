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

async function fixture(change?:(definition:RevalidationDefinition)=>void,artifactContent="Use lowercase words in answers."){
  const db=new Database(":memory:");databases.push(db);MIGRATIONS.forEach(s=>db.exec(s));const store=new Store(db);
  const selected={providerId:"codex",model:"model",permissionMode:"accept-edits" as const,projectId:"project",environmentId:"environment"};
  const s=solution();store.put("solutions",s.id,s);
  const content=artifactContent;store.put("native-evaluation-artifacts","artifact",{id:"artifact",solutionId:s.id,revision:"r1",kind:"instruction",content,artifactDigest:sha(content)});
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
  it("scores a malformed answer as a failed case without storing its text; replaying the service job never retries models",async()=>{
    const f=await fixture();f.setHook(async()=>f.requests.length===1?{output:"wrong"}:"not JSON private-secret");
    await f.runner.handle(f.ctx);expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"completed"});
    const receipts=f.store.list<{answerFormat:string;passed:boolean}>("revalidation-receipts");
    expect(receipts).toHaveLength(4);expect(receipts.filter(r=>r.answerFormat==="invalid")).toHaveLength(3);expect(receipts.every(r=>!r.passed)).toBe(true);
    expect(JSON.stringify(f.store.list("revalidation-runs"))+JSON.stringify(receipts)).not.toContain("private-secret");
    await f.runner.handle(f.ctx);expect(f.requests).toHaveLength(4);
  });
  it("names the error code, case and arm when native execution fails",async()=>{
    const f=await fixture();f.setHook(async()=>{if(f.requests.length===2)throw Object.assign(new Error("x"),{code:"native-task-timeout"});return {output:"fixture-answer-one"};});
    await f.runner.handle(f.ctx);
    expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"failed",verdict:null,reason:"revalidation-native-execution-failed: native-task-timeout (case case-a, treatment)"});
  });
  it("blocks with the shared admission code when BB's budget or concurrency limit refuses an arm",async()=>{
    const f=await fixture();f.setHook(async()=>{throw Object.assign(new Error("x"),{code:"native-task-admission-denied"});});
    await f.runner.handle(f.ctx);
    expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:"revalidation-shared-admission-denied (case case-a, baseline)"});
  });
  it("refuses before any call when unknown native costs are not allowed",async()=>{
    const f=await fixture();f.options.allowUnknownCost=()=>false;const runner=createRevalidationRunner(f.options);await runner.handle(f.ctx);
    expect(f.requests).toHaveLength(0);expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:"revalidation-unknown-cost-not-allowed"});
  });
  it("stops the in-flight arm when the run may no longer proceed",async()=>{
    const f=await fixture();f.setHook((_r,signal)=>new Promise((_resolve,reject)=>{signal?.addEventListener("abort",()=>reject(Object.assign(new Error("x"),{code:"native-task-aborted"})));}));
    const pending=f.runner.handle(f.ctx);await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    f.disable();f.runner.enforce();await pending;
    expect(f.native.revoke).toHaveBeenCalledWith(expect.any(Array),"revalidation-execution-disabled");
    expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:expect.stringMatching(/^revalidation-execution-disabled/)});
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
    // Drift detected after the completed arm keeps its receipt; drift caught before the receipt write keeps none. Usage is always retained.
    expect(f.store.list("revalidation-receipts")).toHaveLength(["privacy","selection","deadline"].includes(mode)?0:1);
    expect(f.core.plans.usage(f.queued.id).at(-1)).toMatchObject({usage:{calls:1,costMicros:null}});
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

  it("reports a run that exceeds its time limit as blocked by the time limit, not as a native failure",async()=>{
    const f=await fixture();f.setHook(async()=>{f.setTime(NOW+60001);throw new Error("native-task-timeout");});
    await f.runner.handle(f.ctx);
    expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:"revalidation-time-limit",verdict:null});
  });
  it("blocks rather than fails a running run on graceful shutdown",async()=>{
    const f=await fixture();let resolve!:(value:unknown)=>void;f.setHook(()=>new Promise(r=>{resolve=r;}));
    const pending=f.runner.handle(f.ctx);await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    f.runner.dispose();resolve({output:"fixture-answer-one"});await pending;
    expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:"interrupted-needs-new-run",verdict:null});
  });
  it("does not let a chat draft revision revoke a queued run of the frozen version",()=>fixture().then(f=>{
    expect(()=>f.core.plans.revise({planId:f.plan.id,expectedVersion:1,definition:{...f.definition,concern:"A new doubt"}},{kind:"chat",id:"chat-thread"})).toThrow("revalidation-run-active-cancel-first");
    expect(f.core.plans.get(f.plan.id).plan.version).toBe(1);
  }));
  it("reconciles usage only for ended runs and stays idempotent",async()=>{
    const f=await fixture();await f.runner.handle(f.ctx);
    f.runner.reconcileUsage();const before=f.core.plans.usage(f.queued.id);
    f.setTime(NOW+120000);f.runner.reconcileUsage();expect(f.core.plans.usage(f.queued.id)).toEqual(before);
  });
  it("reports a guard refusal inside native admission by its own code, not as a native failure",async()=>{
    const f=await fixture();f.setHook(async()=>{f.changePrivacy();throw new Error("native-task-sdk-unavailable");});
    await f.runner.handle(f.ctx);
    expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:"revalidation-privacy-changed (case case-a, baseline)",verdict:null});
  });
  it("treats the service stopping before plugin disposal as an interruption",async()=>{
    const f=await fixture();let resolve!:(value:unknown)=>void;f.setHook(()=>new Promise(r=>{resolve=r;}));
    const pending=f.runner.handle(f.ctx);await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    f.controller.abort();resolve({output:"fixture-answer-one"});await pending;
    expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:"interrupted-needs-new-run",verdict:null});
  });
  it("leaves a queued run queued while the plugin is disabled",async()=>{
    const f=await fixture();f.disable();
    await expect(f.runner.handle(f.ctx)).rejects.toThrow("revalidation-execution-disabled");
    expect(f.requests).toHaveLength(0);expect(f.core.plans.getRun(f.queued.id).run.status).toBe("queued");
  });
  it("refuses an artifact too large for a native task before paying for any arm",async()=>{
    const f=await fixture(undefined,"x".repeat(33000));await f.runner.handle(f.ctx);
    expect(f.requests).toHaveLength(0);expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:"revalidation-artifact-too-large-for-native-task"});
  });
  it("skips a running run when reconciling usage",async()=>{
    const f=await fixture();let resolve!:(value:unknown)=>void;f.setHook(()=>new Promise(r=>{resolve=r;}));
    const pending=f.runner.handle(f.ctx);await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    const before=f.core.plans.usage(f.queued.id);f.runner.reconcileUsage();expect(f.core.plans.usage(f.queued.id)).toEqual(before);
    resolve({output:"fixture-answer-one"});f.setHook(async()=>({output:"fixture-answer-two"}));await pending;
  });
  it("keeps recovering other runs when one interrupted run cannot be recovered",async()=>{
    const f=await fixture();let resolve!:(value:unknown)=>void;f.setHook(()=>new Promise(r=>{resolve=r;}));
    const pending=f.runner.handle(f.ctx);await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    const interrupt=vi.spyOn(f.core.executor,"interrupt").mockImplementationOnce(()=>{throw new Error("damaged-run");});
    const restarted=createRevalidationRunner(f.options);expect(()=>restarted.recover("next-boot")).not.toThrow();expect(interrupt).toHaveBeenCalled();
    interrupt.mockRestore();resolve({output:"fixture-answer-one"});f.setHook(async()=>({output:"fixture-answer-two"}));await pending;
  });
  it("stops early without a verdict when an unreadable baseline makes every criterion unanswerable",async()=>{
    const f=await fixture();f.setHook(async()=>"```json\n{\"output\":\"fixture-answer-one\"}\n```");
    await f.runner.handle(f.ctx);
    expect(f.requests).toHaveLength(1);
    expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",verdict:null,reason:"revalidation-baseline-answer-unreadable (case case-a, baseline)"});
    expect(f.store.list("revalidation-receipts")).toHaveLength(1);
  });
  it("keeps the stop reason when the condition clears before the arm ends",async()=>{
    const f=await fixture();f.setHook((_r,signal)=>new Promise((_resolve,reject)=>{signal?.addEventListener("abort",()=>reject(Object.assign(new Error("x"),{code:"native-task-aborted"})));}));
    const pending=f.runner.handle(f.ctx);await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    let allowed=false;f.options.allowed=()=>allowed;f.runner.enforce();allowed=true;await pending;
    expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:"revalidation-execution-disabled (case case-a, baseline)"});
  });
  it("labels the runner's own admission refusal rather than blaming BB's shared budget",async()=>{
    const f=await fixture(),execute=f.native.execute.getMockImplementation()!;
    f.native.execute.mockImplementation(async(request,signal)=>{f.setCost(1_000_000);try{return await execute(request,signal);}catch{throw Object.assign(new Error("x"),{code:"native-task-admission-denied"});}});
    await f.runner.handle(f.ctx);
    expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:"revalidation-observed-cost-threshold (case case-a, baseline)"});
  });
  it("retries a failed setup read instead of discarding the run",async()=>{
    const f=await fixture();vi.useFakeTimers({toFake:["setTimeout"]});
    try{
      f.observeEnvironment.mockRejectedValueOnce(new Error("revalidation-environment-observation-unavailable"));
      const pending=f.runner.handle(f.ctx);await vi.advanceTimersByTimeAsync(5000);await pending;
      expect(f.core.plans.getRun(f.queued.id).run.status).toBe("completed");
    }finally{vi.useRealTimers();}
  });
  it("never contradicts a claim because some baseline answers were unreadable",async()=>{
    const f=await fixture(d=>{d.sample!.minimumPairs=1;});f.setHook(async request=>{
      const input=JSON.parse(request.input).input,treatment=request.instructions.includes(f.content);
      if(!treatment&&input==="First test task")return "```json\n{}\n```";
      return {output:input==="First test task"?"fixture-answer-one":"fixture-answer-two"};
    });
    await f.runner.handle(f.ctx);
    const state=f.core.plans.getRun(f.queued.id);
    expect(state.run.verdict).not.toBe("contradicted");expect(state.run).toMatchObject({status:"blocked",reason:expect.stringMatching(/^revalidation-baseline-answer-unreadable/)});
  });
  it("labels a binding refusal inside native admission as that refusal",async()=>{
    const f=await fixture(),execute=f.native.execute.getMockImplementation()!;
    f.native.execute.mockImplementation(async(request,signal)=>{try{return await execute({...request,execution:{...request.execution,model:"other-model"}},signal);}catch{throw Object.assign(new Error("x"),{code:"native-task-admission-denied"});}});
    await f.runner.handle(f.ctx);
    expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:"revalidation-operation-binding-mismatch (case case-a, baseline)"});
  });
  it("waits for shared concurrency room instead of losing the run",async()=>{
    const f=await fixture();let room=false;f.options.hasCapacity=()=>room;const runner=createRevalidationRunner(f.options);
    vi.useFakeTimers({toFake:["setTimeout"]});
    try{
      const pending=runner.handle(f.ctx);await vi.advanceTimersByTimeAsync(5000);expect(f.requests).toHaveLength(0);
      room=true;await vi.advanceTimersByTimeAsync(5000);await pending;
      expect(f.core.plans.getRun(f.queued.id).run.status).toBe("completed");
    }finally{vi.useRealTimers();}
  });
  it("marks only baseline comparisons unusable when a baseline answer is unreadable",async()=>{
    const f=await fixture(d=>{d.criteria[0]!.statistic="treatment";d.criteria[0]!.threshold={operator:"at-least",value:1};});
    f.setHook(async request=>{
      const input=JSON.parse(request.input).input,treatment=request.instructions.includes(f.content);
      if(!treatment&&input==="First test task")return "```json\n{}\n```";
      return {output:input==="First test task"?"fixture-answer-one":"fixture-answer-two"};
    });
    await f.runner.handle(f.ctx);
    const result=f.core.plans.getRun(f.queued.id).result!;
    expect(result.criteria.find(c=>c.criterionId==="success")).toMatchObject({status:"threshold-met",value:1});
    expect(result.criteria.find(c=>c.criterionId==="regressions")).toMatchObject({status:"inconclusive",reason:"baseline-answer-format-invalid"});
    expect(result.verdict).toBe("inconclusive");
  });
  it("waits visibly for shared concurrency room for at most ten minutes",async()=>{
    const f=await fixture(d=>{d.limits!.maxDurationMs=3_600_000;});f.options.hasCapacity=()=>false;const runner=createRevalidationRunner(f.options);
    vi.useFakeTimers({toFake:["setTimeout"]});
    try{
      const pending=runner.handle(f.ctx);await vi.advanceTimersByTimeAsync(5000);
      expect(f.store.get("revalidation-progress",f.queued.id)).toMatchObject({waitingFor:"shared-concurrency"});
      for(let t=0;t<130;t++){f.setTime(NOW+t*5000);await vi.advanceTimersByTimeAsync(5000);}
      await pending;
      expect(f.requests).toHaveLength(0);expect(f.store.get("revalidation-progress",f.queued.id)).toBeNull();
      expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:"revalidation-shared-concurrency-unavailable (case case-a, baseline)"});
    }finally{vi.useRealTimers();}
  });
  it("blocks at the run deadline while waiting for concurrency room",async()=>{
    const f=await fixture(d=>{d.limits!.maxDurationMs=60_000;});f.options.hasCapacity=()=>false;const runner=createRevalidationRunner(f.options);
    vi.useFakeTimers({toFake:["setTimeout"]});
    try{
      const pending=runner.handle(f.ctx);
      for(let t=1;t<=14;t++){f.setTime(NOW+t*5000);await vi.advanceTimersByTimeAsync(5000);}
      await pending;
      expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:"revalidation-shared-concurrency-unavailable (case case-a, baseline)"});
    }finally{vi.useRealTimers();}
  });
  it("keeps the stop reason when the run is stopped mid-wait and clears the waiting note",async()=>{
    const f=await fixture();f.options.hasCapacity=()=>false;const runner=createRevalidationRunner(f.options);
    vi.useFakeTimers({toFake:["setTimeout"]});
    try{
      const pending=runner.handle(f.ctx);await vi.advanceTimersByTimeAsync(5000);
      f.disable();runner.enforce();await vi.advanceTimersByTimeAsync(5000);await pending;
      expect(f.core.plans.getRun(f.queued.id).run).toMatchObject({status:"blocked",reason:expect.stringMatching(/^revalidation-execution-disabled/)});
      expect(f.store.get("revalidation-progress",f.queued.id)).toBeNull();expect(f.requests).toHaveLength(0);
    }finally{vi.useRealTimers();}
  });
  it("clears a waiting note left by a crash when recovering the run",async()=>{
    const f=await fixture();let release!:()=>void;f.setHook(()=>new Promise(resolve=>{release=()=>resolve({output:"x"});}));
    const pending=f.runner.handle(f.ctx);await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    f.store.put("revalidation-progress",f.queued.id,{waitingFor:"shared-concurrency",sinceMs:NOW});
    createRevalidationRunner(f.options).recover("next-boot");
    expect(f.store.get("revalidation-progress",f.queued.id)).toBeNull();
    release();await pending;
  });
});
