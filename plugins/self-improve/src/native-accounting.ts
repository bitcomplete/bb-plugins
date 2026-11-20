import { randomUUID } from "node:crypto";
import { z } from "zod";
import { stableJson } from "./domain/shared.js";
import type { Store } from "./store.js";
import type { NativeTaskHooks, NativeTaskIdentity, NativeTaskSettlement } from "./native-tasks.js";
import { NativeUsageLedger, type NativeUsageObservation, type NativeUsageRead, type NativeUsageSdk } from "./native-usage.js";

const id = z.string().min(1).max(500).refine(value=>value.trim()===value&&value.trim().length>0);
const time = z.number().int().nonnegative().max(8_640_000_000_000_000);
const identitySchema = z.object({ taskId:id, stage:id, runId:id.optional(), solutionId:id.optional(), providerId:id, model:id, startedAtMs:time }).strict();
const settlementSchema = identitySchema.extend({
  threadId:id.nullable(), status:z.enum(["completed","failed","cancelled","uncertain"]), endedAtMs:time,
  error:z.string().nullable(), dispatched:z.boolean(), cleanupPending:z.boolean(),
}).strict();
const recordSchema = z.object({ identity:identitySchema, admittedAtMs:time, settlement:settlementSchema.nullable(), collectionIssue:z.string().nullable() }).strict();
type Record = z.infer<typeof recordSchema>;
const NS = "native-accounting-tasks";
const safe = (n:number) => Number.isSafeInteger(n) && n >= 0;
function add(values:readonly number[]):number {
  let total=0;for(const value of values){if(!safe(value)||!safe(total+value))throw new Error("native-cost-total-overflow");total+=value;}return total;
}
function micros(amount:number):number {
  if(!Number.isFinite(amount)||amount<0)throw new Error("native-cost-amount-invalid");
  const value=Math.ceil(amount*1_000_000);if(!safe(value))throw new Error("native-cost-amount-invalid");return value;
}
const same = (a:NativeTaskIdentity,b:NativeTaskIdentity) => stableJson(identitySchema.parse(a))===stableJson(identitySchema.parse(b));
function identity(task:NativeTaskSettlement):NativeTaskIdentity {
  return {taskId:task.taskId,stage:task.stage,providerId:task.providerId,model:task.model,startedAtMs:task.startedAtMs,
    ...(task.runId===undefined?{}:{runId:task.runId}),...(task.solutionId===undefined?{}:{solutionId:task.solutionId})};
}
const binding = (record:Record) => ({taskId:record.identity.taskId,threadId:record.settlement!.threadId!,providerId:record.identity.providerId,requestedModel:record.identity.model});
const occupying = (record:Record):boolean => !record.settlement || record.settlement.cleanupPending || (record.settlement.dispatched && record.settlement.threadId===null);

export interface NativeAccountingOptions {
  store:Store; sdk:NativeUsageSdk; maxConcurrent:()=>number; now?:()=>number;
  usage?:NativeUsageLedger; collectionTimeoutMs?:number;
  /** The shared budget gate (ActivityAccounting.nativeGuard), run synchronously inside the admission transaction. */
  admissionGuard?:(task:NativeTaskIdentity,atMs:number)=>void;
}
export interface NativeCostSession {
  providerSessionId:string; currency:string;
  /** Latest optional BB report, in millionths of the reported currency. Never an invoice. */
  latestReportedMicros:number|null;
  /** Maximum observed snapshot: conservative admission floor, not a computed lifetime charge. */
  observedFloorMicros:number;
}
export interface NativeAccountingTask extends NativeTaskIdentity {
  admittedAtMs:number; settlement:NativeTaskSettlement|null; occupyingSlot:boolean; durationMs:number|null;
  usage:NativeUsageRead|null; sessions:NativeCostSession[]; unknownReasons:string[]; collectionIssue:string|null;
  /** Even when every session reports a cost, BB does not promise final billing coverage. */
  billingCompleteness:"unknown"|"not-dispatched";
}

/**
 * BB usage for Self improve's agent tasks: the source of truth for their tokens and reported costs.
 * Admission here enforces the concurrency limit; budgets are checked once, by the shared admission guard.
 */
export class NativeAccounting implements NativeTaskHooks {
  readonly usage:NativeUsageLedger;
  private readonly now:()=>number;
  constructor(readonly options:NativeAccountingOptions) {
    this.usage=options.usage??new NativeUsageLedger(options.store);
    this.now=options.now??Date.now;
    const timeout=options.collectionTimeoutMs??4000;
    if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)throw new Error("native-accounting-timeout-invalid");
  }
  private records():Record[] {
    return this.options.store.entries(NS).map(({key,value})=>{
      const record=recordSchema.parse(value);if(record.identity.taskId!==key)throw new Error("native-accounting-record-invalid");return record;
    });
  }
  private read(taskId:string):Record|null {
    const value=this.options.store.get(NS,taskId);if(value===null)return null;
    const record=recordSchema.parse(value);if(record.identity.taskId!==taskId)throw new Error("native-accounting-record-invalid");return record;
  }
  private write(record:Record):void { this.options.store.put(NS,record.identity.taskId,recordSchema.parse(record),this.now()); }

  /** Bind these methods to the runner, e.g. hooks: accounting.hooks(). */
  hooks():NativeTaskHooks { return {beforeStart:task=>this.beforeStart(task),onSettled:task=>this.onSettled(task)}; }
  async beforeStart(task:NativeTaskIdentity):Promise<void> {
    const supplied=identitySchema.parse(task),now=time.parse(this.now());
    this.options.store.transaction(()=>{
      const previous=this.read(task.taskId);
      if(previous){if(!same(previous.identity,supplied))throw new Error("native-accounting-identity-conflict");return;}
      const limit=this.options.maxConcurrent();
      if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error("native-accounting-concurrency-invalid");
      if(this.records().filter(occupying).length>=limit)throw new Error("native-concurrency-exhausted");
      this.options.admissionGuard?.(supplied,now);
      this.write({identity:supplied,admittedAtMs:now,settlement:null,collectionIssue:null});
    });
  }

  async onSettled(task:NativeTaskSettlement):Promise<void> {
    const supplied=settlementSchema.parse(task);
    // Do not persist provider diagnostic text through this accounting-only boundary.
    supplied.error=supplied.error===null?null:/^[a-z0-9-]{1,100}$/.test(supplied.error)?supplied.error:"native-task-failed";
    if(supplied.endedAtMs<supplied.startedAtMs)throw new Error("native-accounting-duration-invalid");
    if(!supplied.dispatched&&(supplied.threadId!==null||supplied.cleanupPending))throw new Error("native-accounting-dispatch-conflict");
    const collect=this.options.store.transaction(()=>{
      const record=this.read(supplied.taskId);
      // Admission denials also settle. They consumed no admitted task and made no dispatch.
      if(!record){if(supplied.dispatched||supplied.threadId!==null)throw new Error("native-accounting-admission-missing");return false;}
      if(!same(record.identity,identity(supplied)))throw new Error("native-accounting-identity-conflict");
      const old=record.settlement;
      if(old?.threadId!==null&&old?.threadId!==undefined&&supplied.threadId!==null&&old.threadId!==supplied.threadId)throw new Error("native-accounting-thread-conflict");
      if(old?.dispatched&&!supplied.dispatched)throw new Error("native-accounting-dispatch-conflict");
      if(old&&old.status!=="uncertain"&&supplied.status!=="uncertain"&&(old.endedAtMs!==supplied.endedAtMs||old.dispatched!==supplied.dispatched))throw new Error("native-accounting-settlement-conflict");
      // A delayed uncertain callback cannot erase the recovered terminal result or known thread.
      let next=supplied;
      if(old&&old.status!=="uncertain"&&supplied.status==="uncertain")next={...old};
      else if(old&&old.status!=="uncertain"&&old.status!==supplied.status)throw new Error("native-accounting-settlement-conflict");
      if(old?.threadId)next={...next,threadId:old.threadId,cleanupPending:old.cleanupPending&&next.cleanupPending};
      // Runner cleanup replays terminal history. Equal normalized settlements are a
      // no-op, including after reload and after an earlier collection failure.
      // Bounded reconcileUsage owns late reports and collection retries.
      if(old&&stableJson(old)===stableJson(next))return false;
      const recordNext={...record,settlement:next,collectionIssue:next.threadId?"native-usage-collection-pending":null};
      this.write(recordNext);return !!next.threadId;
    });
    if(collect)await this.collect(supplied.taskId);
  }
  private async collect(taskId:string,externalSignal?:AbortSignal):Promise<void> {
    const record=this.read(taskId);if(!record?.settlement?.threadId)return;
    const collectionId=randomUUID();this.options.store.put("native-accounting-collections",taskId,{collectionId});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.options.collectionTimeoutMs??4000);
    const signal=externalSignal?AbortSignal.any([externalSignal,controller.signal]):controller.signal;
    let issue:string|null=null;
    let abort:(()=>void)|undefined;
    try{
      const collection=this.usage.collect(this.options.sdk,binding(record),{signal});
      const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(new Error("native-usage-collection-interrupted"));if(signal.aborted)abort();else signal.addEventListener("abort",abort,{once:true});});
      const result=await Promise.race([collection,cancelled]);issue=result.retrievalIssue;
    }catch{issue="native-usage-collection-interrupted";}
    finally{clearTimeout(timer);if(abort)signal.removeEventListener("abort",abort);}
    this.options.store.transaction(()=>{
      if(this.options.store.get<{collectionId:string}>("native-accounting-collections",taskId)?.collectionId!==collectionId)return;
      const latest=this.read(taskId);if(latest)this.write({...latest,collectionIssue:issue});
    });
  }
  /** Run after task-runner cleanup reconciliation, and periodically for late reports. Never redispatches. */
  async reconcileUsage(options:{signal?:AbortSignal;maxTasks?:number}={}):Promise<{checked:number;pending:number}> {
    const limit=options.maxTasks??100;if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw new Error("native-accounting-reconcile-limit-invalid");
    // Round-robin cursor means a bounded pass does not starve later tasks.
    const all=this.records().filter(r=>r.settlement?.threadId).sort((a,b)=>a.identity.taskId<b.identity.taskId?-1:a.identity.taskId>b.identity.taskId?1:0);
    const cursor=this.options.store.get<string>("native-accounting-reconcile","cursor");
    const index=cursor===null?0:all.findIndex(r=>r.identity.taskId>cursor);
    const offset=index<0?0:index,ordered=[...all.slice(offset),...all.slice(0,offset)].slice(0,limit);
    let checked=0;
    for(const record of ordered){options.signal?.throwIfAborted();await this.collect(record.identity.taskId,options.signal);this.options.store.put("native-accounting-reconcile","cursor",record.identity.taskId);checked++;}
    return {checked,pending:this.records().filter(r=>occupying(r)||r.collectionIssue!==null).length};
  }
  private view(record:Record):NativeAccountingTask {
    const settled=record.settlement,usage=settled?.threadId?this.usage.read(binding(record)):null;
    const unknownReasons:string[]=[],sessions:NativeCostSession[]=[];
    if(!settled)unknownReasons.push("task-not-settled");
    else if(settled.dispatched){
      if(!settled.threadId)unknownReasons.push("dispatch-identity-unresolved");
      if(settled.cleanupPending)unknownReasons.push("cleanup-pending");
      if(settled.status!=="completed")unknownReasons.push("task-did-not-complete");
      if(!usage?.historyCaughtUp)unknownReasons.push("usage-history-incomplete");
      if(!usage?.sessions.length)unknownReasons.push("cost-not-reported");
      // Optional reports do not cover hidden retries/account failover/final billing by contract.
      unknownReasons.push("final-billing-coverage-unavailable");
    }
    const observations=usage?this.options.store.list<NativeUsageObservation>("native-usage-observations").filter(o=>o.threadId===usage.threadId&&o.kind==="cost"):[];
    for(const session of usage?.sessions??[]){
      const reports=observations.filter(o=>o.providerSessionId===session.providerSessionId&&o.cost);
      const currencies=[...new Set(reports.map(o=>o.cost!.currency))];
      if(!session.cost)unknownReasons.push("session-cost-not-reported");
      if(session.counterResetObserved)unknownReasons.push("usage-counter-reset");
      if(currencies.length>1)unknownReasons.push("session-cost-currency-changed");
      for(const currency of currencies){
        const amounts=reports.filter(o=>o.cost!.currency===currency).sort((a,b)=>a.sequence-b.sequence).map(o=>micros(o.cost!.amount));
        if(amounts.some((amount,index)=>index>0&&amount<amounts[index-1]!))unknownReasons.push("session-cost-counter-decreased");
        sessions.push({providerSessionId:session.providerSessionId,currency,latestReportedMicros:session.cost?.currency===currency?micros(session.cost.amount):null,observedFloorMicros:Math.max(...amounts)});
      }
    }
    return {...record.identity,admittedAtMs:record.admittedAtMs,settlement:settled,occupyingSlot:occupying(record),durationMs:settled?settled.endedAtMs-record.identity.startedAtMs:null,
      usage,sessions,unknownReasons:[...new Set(unknownReasons)],collectionIssue:record.collectionIssue,billingCompleteness:settled&&!settled.dispatched?"not-dispatched":"unknown"};
  }
  summary() { return this.report().summary(); }
  forRun(runId:string) { return this.report().forRun(runId); }
  forSolution(solutionId:string) { id.parse(solutionId);return this.rollup(task=>task.solutionId===solutionId,this.views()); }
  /** Exact-ID union: one rollup keeps shared cumulative sessions deduplicated. */
  forSolutionIds(solutionIds:readonly string[]) { return this.report().forSolutionIds(solutionIds); }
  /** Reads every task once; the returned views filter that one read. */
  report() {
    const all=this.views();
    return {
      summary:()=>this.rollup(()=>true,all),
      forRun:(runId:string)=>{id.parse(runId);return this.rollup(task=>task.runId===runId,all);},
      forSolutionIds:(solutionIds:readonly string[])=>{
        if(!solutionIds.length)throw new Error("empty-solution-history");
        for(const solutionId of solutionIds)id.parse(solutionId);
        const selected=new Set(solutionIds);return this.rollup(task=>task.solutionId!==undefined&&selected.has(task.solutionId),all);
      },
    };
  }
  private views():NativeAccountingTask[] { return this.records().map(record=>this.view(record)); }
  private rollup(filter:(task:{runId?:string;solutionId?:string})=>boolean,all:readonly NativeAccountingTask[]) {
    // Copies, so qualifying one filtered view never changes another view of the same read.
    const tasks=all.filter(filter).map(task=>({...task,unknownReasons:[...task.unknownReasons]}));
    const ownership=new Map<string,Set<string>>();
    for(const task of all)for(const session of task.usage?.sessions??[]){const key=stableJson([task.providerId,session.providerSessionId]);const set=ownership.get(key)??new Set();set.add(task.taskId);ownership.set(key,set);}
    for(const task of tasks)if(task.usage?.sessions.some(s=>(ownership.get(stableJson([task.providerId,s.providerSessionId]))?.size??0)>1))task.unknownReasons.push("provider-session-shared-between-tasks");
    const currencies=[...new Set(tasks.flatMap(t=>t.sessions.map(s=>s.currency)))].sort();
    const totals=currencies.map(currency=>{
      const native=new Map<string,{latest:number;floor:number}>();
      let attributionAmbiguous=false,missingLatest=false;
      for(const task of tasks)for(const session of task.sessions.filter(s=>s.currency===currency)){
        const key=stableJson([task.providerId,session.providerSessionId]),old=native.get(key);
        if((ownership.get(key)?.size??0)>1)attributionAmbiguous=true;
        if(session.latestReportedMicros===null)missingLatest=true;
        native.set(key,{latest:Math.max(old?.latest??0,session.latestReportedMicros??0),floor:Math.max(old?.floor??0,session.observedFloorMicros)});
      }
      return {currency,nativeLatestReportedSessionMicros:attributionAmbiguous||missingLatest?null:add([...native.values()].map(v=>v.latest)),nativeObservedFloorMicros:add([...native.values()].map(v=>v.floor))};
    });
    return {tasks,totals,nativeAdmissions:tasks.length,nativeOccupyingSlots:tasks.filter(t=>t.occupyingSlot).length,nativeUnknownBillingTasks:tasks.filter(t=>t.billingCompleteness==="unknown").length,
      limitations:["Native costs are optional BB provider-session reports, not invoices or subscription charges. Native tokens are not priced using legacy API prices.","Observed cost floors retain the maximum reported snapshot per session; decreases, missing reports and session reuse do not establish a complete lifetime cost.","Monetary thresholds are checked once, by the shared admission gate, using observed floors plus owner-recorded charges and reservations. They cannot cap work already dispatched or bound unreported retries.","Admissions and reports are attributed to the task's admission date in UTC. Shared sessions have ambiguous per-task attribution; filtered totals must not be added together.","Native and legacy amounts retain separate evidence labels. Missing reports, pending work and unknown currency are never displayed as free."]};
  }
}
