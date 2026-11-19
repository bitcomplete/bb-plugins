import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { stableId, stableJson } from "./domain/shared.js";
import type { createRevalidation } from "./revalidation.js";
import { REVALIDATION_PROTOCOL, type FrozenRevalidationPlan, type RevalidationBinding, type RevalidationEnvironment, type RevalidationRun } from "./revalidation-contract.js";
import type { ObservedRevalidationEnvironment } from "./revalidation-environment.js";
import { nativeExecution } from "./native-execution.js";
import type { NativeExecution, NativeTaskIdentity, NativeTaskRecord, NativeTaskRunner } from "./native-tasks.js";
import type { ActivityAccounting } from "./activity-accounting.js";
import { completeJson } from "./native-model.js";
import { Deferred, type StageContext } from "./services.js";

const JOURNALS="revalidation-executions", OPERATIONS="revalidation-operations", RECEIPTS="revalidation-receipts";
const hash=(value:unknown)=>createHash("sha256").update(stableJson(value)).digest("hex");
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const same=(a:unknown,b:unknown)=>stableJson(a)===stableJson(b);
const inputSchema=z.object({kind:z.literal("revalidation"),revalidationRunId:z.string().min(1).max(200)}).strict();
class RunnerFailure extends Error { constructor(readonly code:string){super(code);} }
function fail(code:string):never{throw new RunnerFailure(code);}
const TASK_INSTRUCTIONS="Perform the supplied test task. Return only JSON {output:string} with your exact answer. This is an exploratory paired prompt test. Ordinary BB context and tools may remain.";
/** Native tasks refuse longer instructions; checked before any paid arm. */
const MAX_NATIVE_INSTRUCTIONS=32768;
const treatmentInstructions=(artifact:string)=>`${TASK_INSTRUCTIONS}\n\nAdditional instruction:\n${artifact}`;
/** Ended runs keep reconciling late native reports for this long, then stop being scanned. */
const USAGE_RECONCILE_WINDOW_MS=30*24*60*60*1000;
interface ExecutionJournal { runId:string;binding:RevalidationBinding;boot:string;serviceJobId:string;serviceRunId:string|null;lease:string;privacyGeneration:string;startedAtMs:number;deadlineAtMs:number;taskIds:string[] }
interface Operation {taskId:string;runId:string;caseId:string;arm:"baseline"|"treatment";binding:RevalidationBinding;requestDigest:string;promptHash:string;admittedAtMs:number|null}
export interface RevalidationCaseReceipt {
  id:string;runId:string;taskId:string;caseId:string;arm:"baseline"|"treatment";binding:RevalidationBinding;
  threadId:string;requestId:string;turnId:string;promptHash:string;nativeRequestDigest:string;outputDigest:string;
  passed:boolean;providerId:string;model:string;modelIdentitySource:"requested-selection";observedAtMs:number;
}
export interface RevalidationRunnerOptions {
  store:Store; revalidation:ReturnType<typeof createRevalidation>;
  runner:Pick<NativeTaskRunner,"execute"|"get"|"revoke">;
  activity:Pick<ActivityAccounting,"forRun">;
  execution:()=>NativeExecution;privacyGeneration:()=>string;redact:(value:string)=>string;
  observeEnvironment:(environment:RevalidationEnvironment,signal?:AbortSignal)=>Promise<ObservedRevalidationEnvironment>;
  allowed:()=>boolean;taskTimeoutMs:()=>number;now?:()=>number;
}

/** Trusted server executor only. None of these capabilities belong in RPC or chat inputs. */
export function createRevalidationRunner(options:RevalidationRunnerOptions){
  const {store,revalidation,runner}=options,now=options.now??Date.now;
  const active=new Map<string,AbortController>(),locks=new Map<string,Promise<Record<string,number>>>();
  let disposed=false;
  const journal=(runId:string)=>store.get<ExecutionJournal>(JOURNALS,runId);
  const operations=(runId:string)=>{
    const j=journal(runId);
    // The journal names every planned task, so a run's operations are point reads rather than a table scan.
    if(j)return j.taskIds.map(id=>store.get<Operation>(OPERATIONS,id)).filter((o):o is Operation=>o!==null&&o.runId===runId);
    return store.list<Operation>(OPERATIONS).filter(o=>o.runId===runId);
  };
  function frozen(run:RevalidationRun):FrozenRevalidationPlan {
    const value=revalidation.plans.get(run.planId,run.planVersion).frozen;
    if(!value||value.schemaVersion!==2||value.protocol!==REVALIDATION_PROTOCOL||!value.workload||!value.observedEnvironment||!value.environmentObservationDigest)fail("revalidation-executable-snapshot-unavailable");
    return value;
  }
  function clean(value:unknown):void {
    if(typeof value==="string"&&options.redact(value)!==value)fail("revalidation-privacy-changed");
    if(Array.isArray(value))value.forEach(clean);else if(value&&typeof value==="object")Object.values(value).forEach(clean);
  }
  function current(j:ExecutionJournal,checkDeadline=true):FrozenRevalidationPlan {
    const state=revalidation.plans.getRun(j.runId).run;
    let value:FrozenRevalidationPlan;
    try { value=revalidation.executor.assertActive({runId:j.runId,lease:j.lease}).frozen; } catch { return fail("revalidation-run-revoked"); }
    if(disposed||!options.allowed())fail("revalidation-execution-disabled");
    if(state.status!=="running"||!same(state.binding,j.binding))fail("revalidation-run-revoked");
    if(revalidation.plans.get(state.planId).plan.version!==state.planVersion||store.get("revalidation-stale",`${state.planId}:${state.planVersion}`))fail("revalidation-plan-stale");
    if(options.privacyGeneration()!==j.privacyGeneration)fail("revalidation-privacy-changed");
    if(!same(options.execution(),nativeExecution(value.definition.environment!.execution)))fail("revalidation-selection-changed");
    if(checkDeadline&&now()>=j.deadlineAtMs)fail("revalidation-time-limit");
    clean(value.definition);clean(value.workload);clean(value.artifact.content);
    return value;
  }
  function costState(runId:string,currency:string){
    const view=options.activity.forRun(runId),totals=view.totals;
    const known=totals.find(t=>t.currency===currency)?.sharedNativeAndChatObservedFloorMicros??0;
    if(!Number.isSafeInteger(known)||known<0)fail("revalidation-cost-observation-invalid");
    return {view,known,hasObservation:totals.some(t=>t.currency===currency),ambiguous:view.native.tasks.some(t=>t.unknownReasons.some(r=>r.includes("shared-between"))),otherCurrency:totals.some(t=>t.currency!==currency)};
  }
  function checkMoney(runId:string,limits:NonNullable<FrozenRevalidationPlan["definition"]["limits"]>){
    if(limits.moneyLimitMode!=="observed-admission"||!limits.allowUnknownCost)fail("revalidation-native-cost-mode-unsupported");
    const state=costState(runId,limits.currency);
    if(limits.maxCostMicros!==null&&(state.ambiguous||state.otherCurrency))fail("revalidation-cost-attribution-unavailable");
    if(limits.maxCostMicros!==null&&state.known>=limits.maxCostMicros)fail("revalidation-observed-cost-threshold");
  }
  function usage(runId:string,reason:string){
    const run=revalidation.plans.getRun(runId).run,j=journal(runId),value=revalidation.plans.get(run.planId,run.planVersion).frozen;
    if(!value?.definition.limits)return;
    const ops=operations(runId),currency=value.definition.limits.currency,cost=costState(runId,currency);
    // Elapsed time is only recorded once the run has ended, so repeated observations of a running run stay idempotent.
    const observation={calls:ops.filter(o=>o.admittedAtMs!==null).length,elapsedMs:j&&run.endedAtMs!==null&&run.endedAtMs!==undefined?Math.max(0,run.endedAtMs-j.startedAtMs):0,costMicros:null,currency};
    const unknownReasons=["native-billing-incomplete",reason,...(cost.ambiguous?["shared-session-attribution"]:[]),...(cost.otherCurrency?["multiple-cost-currencies"]:[])];
    const taskIds=ops.map(o=>o.taskId).sort(),observedCostFloorMicros=cost.hasObservation?cost.known:null;
    revalidation.executor.recordUsage({runId,requestId:stableId("revalidation-usage",{runId,observation,taskIds,unknownReasons,observedCostFloorMicros}),binding:run.binding,usage:observation,taskIds,unknownReasons,observedCostFloorMicros});
  }
  function revoke(runId:string,reason:string){
    active.get(runId)?.abort();
    const ids=journal(runId)?.taskIds??operations(runId).map(o=>o.taskId);
    if(ids.length)runner.revoke(ids,reason);
  }
  function admissionGuard(identity:NativeTaskIdentity,atMs:number){
    const op=store.get<Operation>(OPERATIONS,identity.taskId);
    // Other native stages retain their ordinary shared admission policy.
    if(!op){if(identity.runId&&journal(identity.runId))fail("revalidation-operation-unregistered");return;}
    store.transaction(()=>{
      const j=journal(op.runId);if(!j)fail("revalidation-journal-missing");
      const value=current(j),selected=value.definition.environment!.execution;
      if(identity.runId!==op.runId||identity.solutionId!==value.definition.target.solutionId||identity.stage!=="builder"||identity.providerId!==selected.providerId||identity.model!==selected.model||!same(op.binding,j.binding))fail("revalidation-operation-binding-mismatch");
      const latest=store.get<Operation>(OPERATIONS,op.taskId)!;
      if(latest.admittedAtMs===null){
        checkMoney(op.runId,value.definition.limits!);
        if(operations(op.runId).filter(o=>o.admittedAtMs!==null).length>=value.definition.limits!.maxCalls)fail("revalidation-call-limit");
        store.put(OPERATIONS,op.taskId,{...latest,admittedAtMs:atMs});
      }
    });
  }
  function dispatchGuard(record:Readonly<NativeTaskRecord>){
    const op=store.get<Operation>(OPERATIONS,record.taskId);
    if(!op){if(record.runId&&journal(record.runId))fail("revalidation-operation-unregistered");return;}
    const j=journal(op.runId);if(!j)fail("revalidation-journal-missing");const value=current(j);
    if(op.admittedAtMs===null||record.runId!==op.runId||record.solutionId!==value.definition.target.solutionId||record.stage!=="builder"||record.promptHash!==op.promptHash||record.requestDigest!==op.requestDigest||!same(op.binding,j.binding))fail("revalidation-dispatch-binding-mismatch");
    checkMoney(op.runId,value.definition.limits!);
  }
  async function bounded<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
    if(signal.aborted){void operation.catch(()=>{});return fail("revalidation-execution-aborted");}
    return new Promise<T>((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener("abort",abort);reject(new RunnerFailure("revalidation-execution-aborted"));};
      signal.addEventListener("abort",abort,{once:true});
      operation.then(value=>{signal.removeEventListener("abort",abort);resolve(value);},error=>{signal.removeEventListener("abort",abort);reject(error);});
    });
  }
  async function environment(j:ExecutionJournal,signal:AbortSignal){
    const value=current(j);signal.throwIfAborted();
    const observed=await bounded(options.observeEnvironment(value.definition.environment!,signal),signal);signal.throwIfAborted();current(j);
    if(observed.digest!==value.environmentObservationDigest||observed.declaredEnvironmentDigest!==value.environmentDigest)fail("revalidation-environment-changed");
  }
  function validateProtocol(value:FrozenRevalidationPlan,runId:string){
    const {definition:def,workload}=value;if(!workload)fail("revalidation-workload-unavailable");
    if(def.claim.requiredEvidence!=="exploratory")fail("revalidation-evidence-capability-unavailable");
    if(def.sample!.minimumExposure!==null||def.sample!.exposureUnit!==null)fail("revalidation-exposure-capability-unavailable");
    if(def.sample!.minimumPairs>workload.definition.cases.length)fail("revalidation-insufficient-planned-pairs");
    if(def.limits!.maxCalls<workload.definition.cases.length*2)fail("revalidation-insufficient-planned-calls");
    if(treatmentInstructions(value.artifact.content).length>MAX_NATIVE_INSTRUCTIONS)fail("revalidation-artifact-too-large-for-native-task");
    if(!Number.isSafeInteger(def.limits!.maxDurationMs)||def.limits!.maxDurationMs>2_147_000_000)fail("revalidation-duration-unsupported");
    if(workload.definition.measurements.length!==def.criteria.length)fail("revalidation-measurement-binding-mismatch");
    for(const c of def.criteria){
      const mapping=workload.definition.measurements.find(m=>m.criterionId===c.id);
      if(c.evaluator!=="numeric-comparison-v1"||!mapping)fail("revalidation-criterion-unsupported");
      if(mapping.kind==="exact-pass-rate"?c.unit!=="proportion":c.unit!=="cases"||c.statistic!=="treatment")fail("revalidation-measurement-unit-mismatch");
    }
    checkMoney(runId,def.limits!);
  }
  async function execute(ctx:StageContext,runId:string):Promise<Record<string,number>>{
    let state=revalidation.plans.getRun(runId);
    if(!["queued","running"].includes(state.run.status))return {revalidation:1,terminal:1};
    if(state.run.status==="running"){
      revalidation.executor.interrupt({runId,expectedVersion:state.version});revoke(runId,"revalidation-interrupted");usage(runId,"interrupted");return {revalidation:1,blocked:1};
    }
    // A disabled plugin leaves queued runs queued; Services retries deferred jobs with backoff.
    if(disposed||!options.allowed())throw new Deferred("revalidation-execution-disabled");
    let j:ExecutionJournal|null=null,controller:AbortController|null=null,deadline:AbortSignal|null=null;
    try {
      const value=frozen(state.run);validateProtocol(value,runId);
      const started=revalidation.executor.start({runId,expectedVersion:state.version});
      if(!started.lease){usage(runId,"blocked-before-start");return {revalidation:1,blocked:1};}
      const startedAtMs=started.run.startedAtMs!;
      const ids=value.workload!.definition.cases.flatMap(c=>["baseline","treatment"].map(arm=>stableId("revalidation-task",[runId,c.id,arm])));
      j={runId,binding:started.run.binding,boot:ctx.boot,serviceJobId:ctx.job.id,serviceRunId:ctx.job.runId??null,lease:started.lease,privacyGeneration:options.privacyGeneration(),startedAtMs,deadlineAtMs:startedAtMs+value.definition.limits!.maxDurationMs,taskIds:ids};
      if(!store.insert(JOURNALS,runId,j))fail("revalidation-execution-already-recorded");
      controller=new AbortController();active.set(runId,controller);
      deadline=AbortSignal.timeout(Math.max(1,j.deadlineAtMs-now()));
      const signal=AbortSignal.any([ctx.signal,controller.signal,deadline]);
      await environment(j,signal);
      const receipts:RevalidationCaseReceipt[]=[];
      for(const [index,c] of value.workload!.definition.cases.entries()){
        const arms=(index%2?["treatment","baseline"]:["baseline","treatment"]) as Array<"baseline"|"treatment">;
        for(const arm of arms){
          await environment(j,signal);
          const instructions=arm==="treatment"?treatmentInstructions(value.artifact.content):TASK_INSTRUCTIONS;
          const input=JSON.stringify({input:c.input}),taskId=stableId("revalidation-task",[runId,c.id,arm]);
          const timeoutMs=Math.min(900000,options.taskTimeoutMs(),Math.max(1,j.deadlineAtMs-now()));
          const request={id:taskId,instructions,input,stage:"builder",runId,solutionId:value.definition.target.solutionId,execution:nativeExecution(value.definition.environment!.execution),privacyGeneration:j.privacyGeneration,timeoutMs,maxReplyCharacters:64000};
          const promptHash=sha(`${instructions}\n\nTask input (untrusted data):\n${JSON.stringify({input})}`);
          const requestDigest=sha(stableJson({execution:request.execution,promptHash,stage:request.stage,runId,solutionId:request.solutionId,privacyGeneration:request.privacyGeneration,timeoutMs,maxReplyCharacters:request.maxReplyCharacters}));
          const op:Operation={taskId,runId,caseId:c.id,arm,binding:j.binding,requestDigest,promptHash,admittedAtMs:null};
          current(j);checkMoney(runId,value.definition.limits!);if(!store.insert(OPERATIONS,taskId,op))fail("revalidation-operation-already-recorded");
          const response=await completeJson(runner,request,signal);current(j);signal.throwIfAborted();
          const parsed=z.object({output:z.string().max(8000)}).strict().parse(response.value),native=runner.get(response.threadId),registered=store.get<Operation>(OPERATIONS,taskId);
          if(!registered||registered.admittedAtMs===null||!native||native.taskId!==taskId||native.state!=="completed"||native.outputDigest!==sha(response.text)||native.requestDigest!==requestDigest||native.promptHash!==promptHash||response.promptHash!==promptHash||native.resolvedEnvironmentId!==value.definition.environment!.execution.environmentId||native.projectId!==request.execution.projectId||native.privacyGeneration!==j.privacyGeneration||native.runId!==runId||native.solutionId!==request.solutionId||native.stage!==request.stage||native.providerId!==response.providerId||native.model!==response.model||!response.requestId||!response.turnId||native.endedAtMs!==response.endedAtMs)fail("revalidation-native-receipt-mismatch");
          const receipt:RevalidationCaseReceipt={id:stableId("revalidation-receipt",taskId),runId,taskId,caseId:c.id,arm,binding:j.binding,threadId:response.threadId,requestId:response.requestId,turnId:response.turnId,promptHash,nativeRequestDigest:requestDigest,outputDigest:sha(parsed.output),passed:parsed.output===c.expected,providerId:response.providerId,model:response.model,modelIdentitySource:"requested-selection",observedAtMs:now()};
          if(receipts.some(r=>r.threadId===receipt.threadId||r.requestId===receipt.requestId||r.turnId===receipt.turnId))fail("revalidation-reused-native-receipt");
          current(j);if(!store.insert(RECEIPTS,receipt.id,receipt))fail("revalidation-receipt-already-recorded");receipts.push(receipt);usage(runId,"partial-or-complete-native-observations");
        }
      }
      await environment(j,signal);
      const pairs=value.workload!.definition.cases.length,baseline=receipts.filter(r=>r.arm==="baseline"&&r.passed).length,treatment=receipts.filter(r=>r.arm==="treatment"&&r.passed).length;
      const regressions=value.workload!.definition.cases.filter(c=>receipts.some(r=>r.caseId===c.id&&r.arm==="baseline"&&r.passed)&&receipts.some(r=>r.caseId===c.id&&r.arm==="treatment"&&!r.passed)).length;
      const refs=receipts.map(r=>r.id);
      revalidation.executor.complete({runId,lease:j.lease,binding:j.binding,observations:value.definition.criteria.map(c=>{
        const kind=value.workload!.definition.measurements.find(m=>m.criterionId===c.id)!.kind;
        return {criterionId:c.id,metric:c.metric,unit:c.unit,baseline:kind==="exact-pass-rate"?baseline/pairs:0,treatment:kind==="exact-pass-rate"?treatment/pairs:regressions,pairs,exposure:null,exposureUnit:null,receiptRefs:refs};
      }),evidence:{kind:value.definition.mode==="replay"?"exploratory-replay":"exploratory-challenge",receiptRefs:refs,limitations:["Ordinary BB/provider/user/workspace context and tools may remain; no enforced isolation or causal claim.","Only exact answers on the frozen prompt cases were compared; packaged skill/plugin portability was not tested.","Provider/model identity is the requested selection; native billing remains incomplete."]},usage:{calls:operations(runId).filter(o=>o.admittedAtMs!==null).length,elapsedMs:Math.max(0,now()-j.startedAtMs),costMicros:null,currency:value.definition.limits!.currency}});
      usage(runId,"completed");return {revalidation:1,completed:1,pairs};
    } catch(error){
      state=revalidation.plans.getRun(runId);
      const timedOut=deadline?.aborted===true||(j!==null&&now()>=j.deadlineAtMs);
      // Plugin disposal or the service stopping is a shutdown, whichever is observed first.
      const shutdown=disposed||ctx.signal.aborted;
      // Run guards fire inside native admission/dispatch and arrive wrapped as native errors; recover their real code.
      let guardCode:string|null=error instanceof RunnerFailure?error.code:null;
      if(guardCode===null&&j!==null&&!shutdown){
        try{const value=current(j);checkMoney(runId,value.definition.limits!);}catch(guard){if(guard instanceof RunnerFailure)guardCode=guard.code;}
      }
      const reason=shutdown?"interrupted-needs-new-run":timedOut?"revalidation-time-limit":guardCode??(controller?.signal.aborted?"revalidation-execution-aborted":"revalidation-native-execution-failed");
      // Shutdown follows the restart rule: blocked, needing an explicit new run, never a failed hypothesis.
      if(shutdown&&state.run.status==="running"){try{revalidation.executor.interrupt({runId,expectedVersion:state.version});}catch{/* recovery on next boot */}}
      else if(["queued","running"].includes(state.run.status)){
        if(guardCode!==null||timedOut||shutdown)revalidation.executor.block({runId,reason,...(j?{lease:j.lease}:{})});
        else if(j)revalidation.executor.fail({runId,reason,lease:j.lease});
        else revalidation.executor.block({runId,reason});
      }
      revoke(runId,"revalidation-terminal");usage(runId,reason);
      return {revalidation:1,operationalFailure:1};
    } finally {if(controller)controller.abort();active.delete(runId);}
  }
  return {
    admissionGuard,dispatchGuard,
    handle(ctx:StageContext){const {revalidationRunId:runId}=inputSchema.parse(ctx.job.input);const previous=locks.get(runId);if(previous)return previous;
      const operation=execute(ctx,runId);locks.set(runId,operation);void operation.finally(()=>{if(locks.get(runId)===operation)locks.delete(runId);}).catch(()=>{});return operation;},
    cancel(runId:string){if(revalidation.plans.getRun(runId).run.status!=="cancelled")fail("revalidation-owner-cancellation-required");revoke(runId,"revalidation-owner-cancelled");usage(runId,"owner-cancelled");},
    recover(boot:string){
      // Runs at startup: one damaged run must not prevent the plugin from starting or other runs from recovering.
      for(const entry of store.entries<RevalidationRun>("revalidation-runs")){
        if(entry.value.status!=="running"||active.has(entry.key))continue;
        try{const j=journal(entry.key);if(j?.boot===boot)continue;revalidation.executor.interrupt({runId:entry.key,expectedVersion:entry.version});revoke(entry.key,"revalidation-interrupted");usage(entry.key,"interrupted");}
        catch{/* left running; retried on the next boot */}
      }
    },
    reconcileUsage(){
      // Late native reports for ended runs; running runs record usage after every receipt. One bad run does not stop the sweep.
      for(const j of store.list<ExecutionJournal>(JOURNALS)){
        if(active.has(j.runId))continue;
        try{
          const run=revalidation.plans.getRun(j.runId).run;
          if(["queued","running"].includes(run.status)||(run.endedAtMs!=null&&now()-run.endedAtMs>USAGE_RECONCILE_WINDOW_MS))continue;
          usage(j.runId,"reconciled-native-usage");
        }catch{/* retried next sweep */}
      }
    },
    dispose(){disposed=true;for(const runId of active.keys())revoke(runId,"revalidation-disposed");},
  };
}
