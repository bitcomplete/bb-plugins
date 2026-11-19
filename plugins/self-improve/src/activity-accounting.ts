import type { Accounting, AccountingAdmissionGuard, CostPolicy } from "./costs.js";
import type { NativeAccounting, NativeCostSession } from "./native-accounting.js";
import type { NativeTaskIdentity } from "./native-tasks.js";
import type { NativeUsageRead } from "./native-usage.js";
import type { Store } from "./store.js";
import { stableJson } from "./domain/shared.js";
import { resolveSolutionHistory } from "./solution-history.js";

/** Facts from persisted BB events, never counts of inline-hook invocations. */
export interface ActivityChatConversation {
  chatId:string; threadId:string; providerId:string; model:string; createdAtMs:number;
  solutionId?:string; runId?:string;
  requests:readonly {requestId:string;atMs:number}[];
  turns:readonly {turnId:string;atMs:number;completed?:boolean}[];
  countsCaughtUp:boolean; countsIssue:string|null; usage:NativeUsageRead;
  costObservations:readonly {eventId:string;sequence:number;atMs:number;providerSessionId:string;cost:{amount:number;currency:string}|null}[];
}
export interface ChatActivityAdmission {
  chatId:string; threadId:string; providerId:string; model:string; initial:boolean;
  solutionId?:string; runId?:string;
}
interface InitialChatAdmission extends Omit<ChatActivityAdmission,"initial"> {atMs:number}
export interface ActivityAccountingOptions {
  store:Store; policy:()=>CostPolicy; legacy:()=>Accounting; native:()=>NativeAccounting;
  chats:()=>readonly ActivityChatConversation[]; now?:()=>number;
}
interface Entry {atMs:number;currency:string;micros:number;unknown:boolean;scope:string;solutionId?:string}
interface Sample extends Entry {providerId:string;sessionId:string;owner:string;sequence:number}
interface Call {id:string;owner:string;atMs:number;scope:string;solutionId?:string;runId?:string}
type Filter = (item:{solutionId?:string;runId?:string})=>boolean;
const NS="activity-chat-admissions";
const safe=(value:number)=>Number.isSafeInteger(value)&&value>=0;
function checkTime(value:number):number {if(!safe(value)||value>8_640_000_000_000_000)throw new Error("activity-time-invalid");return value;}
function checkId(value:string):void {if(typeof value!=="string"||!value.trim()||value.length>500)throw new Error("activity-identity-invalid");}
const day=(value:number)=>new Date(checkTime(value)).toISOString().slice(0,10);
function sum(values:readonly number[]):number {let total=0;for(const value of values){if(!safe(value)||!safe(total+value))throw new Error("activity-total-overflow");total+=value;}return total;}
function micros(amount:number):number {const value=Math.ceil(amount*1_000_000);if(!Number.isFinite(amount)||amount<0||!safe(value))throw new Error("activity-cost-invalid");return value;}
function uniqueFacts<T extends {atMs:number}>(values:readonly T[],key:(value:T)=>string):T[] {
  const result=new Map<string,T>();for(const value of values){checkTime(value.atMs);const id=key(value);checkId(id);const old=result.get(id);if(!old||value.atMs<old.atMs)result.set(id,value);}
  return [...result.values()].sort((a,b)=>a.atMs-b.atMs||key(a).localeCompare(key(b)));
}
const limitations=[
  "Manual chat admission is an observed-budget preflight. BB's inline hook has no stable request ID; repeated hook checks do not reserve or count extra turns. Reporting delays and concurrent manual turns can exceed the observed threshold.",
  "One durable initial admission per conversation replaces its earliest observed request in admission counts. Requests and root turns are counted separately from persisted BB events; hidden provider retries are not known request counts.",
  "Native tasks retain synchronous admission limits. Shared monetary thresholds use observed session floors and legacy charges/reservations, not a hard bound on already dispatched work or subscription invoices.",
  "Provider sessions shared across activities cannot be allocated to individual tasks, chats, runs or solutions. Their latest reported subtotals are unknown; observed floors remain cumulative and filtered views may overlap.",
  "Legacy invoice attestations, credits and estimates retain their original labels. Native and chat reports remain cumulative provider-session observations; tokens are not repriced.",
  "Chat cost-floor increases use the UTC date of the observation. Native task floors use admission dates. Delayed reports, counter resets and reused sessions do not establish complete period billing.",
] as const;

/** Install both guards; this is the shared boundary for native, legacy/Laya and manual chat work. */
export class ActivityAccounting {
  constructor(readonly options:ActivityAccountingOptions) {}
  private now():number {return checkTime((this.options.now??Date.now)());}
  readonly legacyGuard:AccountingAdmissionGuard=({request,atMs,currency,maxMicros,unknown})=>{
    this.check({atMs,scope:request.scope,solutionId:request.solutionId,currency,additionalMicros:maxMicros,unknown,additionalCalls:1});
  };
  readonly nativeGuard=(task:NativeTaskIdentity,atMs:number):void=>{
    this.check({atMs,scope:task.stage,solutionId:task.solutionId,currency:this.options.policy().currency,additionalMicros:0,unknown:true,additionalCalls:1});
  };
  /** Pass directly from the manual-chat beforeDispatch hook. Only the initial chat ID is reserved. */
  admitChat(input:ChatActivityAdmission):void {
    for(const value of [input.chatId,input.threadId,input.providerId,input.model,input.solutionId??"absent",input.runId??"absent"])checkId(value);
    if(typeof input.initial!=="boolean")throw new Error("activity-chat-admission-invalid");
    const identity={chatId:input.chatId,threadId:input.threadId,providerId:input.providerId,model:input.model,
      ...(input.solutionId===undefined?{}:{solutionId:input.solutionId}),...(input.runId===undefined?{}:{runId:input.runId})};
    this.options.store.transaction(()=>{
      const previous=this.options.store.get<InitialChatAdmission>(NS,input.chatId);
      if(previous){const {atMs:_,...bound}=previous;if(stableJson(bound)!==stableJson(identity))throw new Error("activity-chat-identity-conflict");}
      if(input.initial&&previous)return;
      const atMs=this.now(),observed=this.chatViews().find(chat=>chat.chatId===input.chatId);
      if(observed&&(observed.threadId!==input.threadId||observed.providerId!==input.providerId||observed.model!==input.model||observed.solutionId!==input.solutionId||observed.runId!==input.runId))throw new Error("activity-chat-identity-conflict");
      // An initial request may already be visible before its inline hook is called.
      const additionalCalls=input.initial&&observed?.requests.length?0:1;
      this.check({atMs,scope:"chat",solutionId:input.solutionId,currency:this.options.policy().currency,additionalMicros:0,unknown:true,additionalCalls});
      if(input.initial)this.options.store.put(NS,input.chatId,{...identity,atMs});
    });
  }
  private initials():InitialChatAdmission[] {
    return this.options.store.entries<InitialChatAdmission>(NS).map(({key,value})=>{
      if(value.chatId!==key)throw new Error("activity-chat-identity-conflict");checkTime(value.atMs);
      for(const id of [value.chatId,value.threadId,value.providerId,value.model])checkId(id);return value;
    });
  }
  private chatViews() {
    const ids=new Set<string>(),threads=new Set<string>();
    return this.options.chats().map(chat=>{
      for(const value of [chat.chatId,chat.threadId,chat.providerId,chat.model])checkId(value);checkTime(chat.createdAtMs);
      if(ids.has(chat.chatId)||threads.has(chat.threadId))throw new Error("activity-chat-duplicate");ids.add(chat.chatId);threads.add(chat.threadId);
      if(chat.usage.threadId!==chat.threadId||chat.usage.taskId!==chat.chatId||chat.usage.providerId!==chat.providerId||chat.usage.requestedModel!==chat.model)throw new Error("activity-chat-usage-binding-conflict");
      const requests=uniqueFacts(chat.requests,r=>r.requestId),turns=uniqueFacts(chat.turns,t=>t.turnId);
      const bySequence=new Map<number,ActivityChatConversation["costObservations"][number]>();
      for(const report of chat.costObservations){
        checkId(report.eventId);checkId(report.providerSessionId);checkTime(report.atMs);if(!safe(report.sequence))throw new Error("activity-sequence-invalid");
        if(report.cost){checkId(report.cost.currency);micros(report.cost.amount);}
        const previous=bySequence.get(report.sequence);if(previous&&stableJson(previous)!==stableJson(report))throw new Error("activity-chat-event-conflict");bySequence.set(report.sequence,report);
      }
      const reports=[...bySequence.values()].sort((a,b)=>a.sequence-b.sequence);
      const sessions:NativeCostSession[]=[],unknownReasons=["final-billing-coverage-unavailable"];
      if(!chat.countsCaughtUp)unknownReasons.push("request-history-incomplete");
      if(!chat.usage.historyCaughtUp)unknownReasons.push("usage-history-incomplete");
      if(!chat.usage.sessions.length)unknownReasons.push("cost-not-reported");
      for(const session of chat.usage.sessions){
        if(!session.cost)unknownReasons.push("session-cost-not-reported");
        if(session.counterResetObserved)unknownReasons.push("usage-counter-reset");
        const amounts=reports.filter(r=>r.providerSessionId===session.providerSessionId&&r.cost);
        if(session.cost&&!amounts.some(r=>r.sequence===session.costSequence&&stableJson(r.cost)===stableJson(session.cost)))throw new Error("activity-chat-cost-observations-missing");
        const currencies=[...new Set(amounts.map(r=>r.cost!.currency))];if(currencies.length>1)unknownReasons.push("session-cost-currency-changed");
        for(const currency of currencies){
          const values=amounts.filter(r=>r.cost!.currency===currency).map(r=>micros(r.cost!.amount));
          if(values.some((v,i)=>i>0&&v<values[i-1]!))unknownReasons.push("session-cost-counter-decreased");
          sessions.push({providerSessionId:session.providerSessionId,currency,latestReportedMicros:session.cost?.currency===currency?micros(session.cost.amount):null,observedFloorMicros:values.reduce((a,b)=>Math.max(a,b),0)});
        }
      }
      if(reports.some(r=>!chat.usage.sessions.some(s=>s.providerSessionId===r.providerSessionId)))throw new Error("activity-chat-session-missing");
      return {...chat,requests,turns,costObservations:reports,sessions,observedRequests:requests.length,observedRootTurns:turns.length,
        completedRootTurns:new Set(chat.turns.filter(t=>t.completed).map(t=>t.turnId)).size,billingCompleteness:"unknown" as const,unknownReasons:[...new Set(unknownReasons)]};
    });
  }
  private snapshot() {
    const legacy=this.options.legacy().summary(),native=this.options.native().summary(),chats=this.chatViews(),initials=this.initials();
    const calls:Call[]=this.options.store.list<{id:string;at:number;scope:string;solutionId?:string;runId?:string}>("cost-reservations").map(r=>({id:`legacy:${r.id}`,owner:`legacy:${r.id}`,atMs:r.at,scope:r.scope,solutionId:r.solutionId,runId:r.runId}));
    for(const task of native.tasks)calls.push({id:`native:${task.taskId}`,owner:`native:${task.taskId}`,atMs:task.admittedAtMs,scope:task.stage,solutionId:task.solutionId,runId:task.runId});
    for(const initial of initials)calls.push({id:`chat-initial:${initial.chatId}`,owner:`chat:${initial.chatId}`,atMs:initial.atMs,scope:"chat",solutionId:initial.solutionId,runId:initial.runId});
    for(const chat of chats){
      const initial=initials.find(i=>i.chatId===chat.chatId);
      if(initial&&(initial.threadId!==chat.threadId||initial.providerId!==chat.providerId||initial.model!==chat.model||initial.solutionId!==chat.solutionId||initial.runId!==chat.runId))throw new Error("activity-chat-identity-conflict");
      for(const request of chat.requests.slice(initial?1:0))calls.push({id:stableJson(["chat-request",chat.threadId,request.requestId]),owner:`chat:${chat.chatId}`,atMs:request.atMs,scope:"chat",solutionId:chat.solutionId,runId:chat.runId});
    }
    const entries:Entry[]=[...legacy.events.map(e=>({atMs:e.at,currency:e.currency,micros:e.amountMicros??("maxMicros" in e?e.maxMicros:0),unknown:e.amountMicros===null&&("price" in e?e.price===null&&e.maxMicros===0:true),scope:e.scope,solutionId:e.solutionId})),
      ...legacy.pending.map(e=>({atMs:e.at,currency:e.currency,micros:e.maxMicros,unknown:e.price===null&&e.maxMicros===0,scope:e.scope,solutionId:e.solutionId}))];
    const ownership=new Map<string,Set<string>>(),samples:Sample[]=[];
    const own=(providerId:string,sessionId:string,owner:string)=>{const key=stableJson([providerId,sessionId]),set=ownership.get(key)??new Set<string>();set.add(owner);ownership.set(key,set);};
    for(const task of native.tasks){
      const owner=`native:${task.taskId}`;
      for(const session of task.usage?.sessions??[])own(task.providerId,session.providerSessionId,owner);
      for(const session of task.sessions)samples.push({providerId:task.providerId,sessionId:session.providerSessionId,owner,sequence:0,atMs:task.admittedAtMs,currency:session.currency,micros:session.observedFloorMicros,unknown:true,scope:task.stage,solutionId:task.solutionId});
    }
    for(const chat of chats){
      const owner=`chat:${chat.chatId}`;for(const session of chat.usage.sessions)own(chat.providerId,session.providerSessionId,owner);
      for(const report of chat.costObservations)if(report.cost)samples.push({providerId:chat.providerId,sessionId:report.providerSessionId,owner,sequence:report.sequence,atMs:report.atMs,currency:report.cost.currency,micros:micros(report.cost.amount),unknown:true,scope:"chat",solutionId:chat.solutionId});
    }
    // Only increases of the maximum observed cumulative report add to the floor.
    // Shared sessions deduplicate here; monetary admission separately rejects ambiguous attribution.
    samples.sort((a,b)=>a.atMs-b.atMs||a.owner.localeCompare(b.owner)||a.sequence-b.sequence);
    const floors=new Map<string,number>();
    for(const sample of samples){const key=stableJson([sample.providerId,sample.sessionId,sample.currency]),prior=floors.get(key)??0;entries.push({...sample,micros:Math.max(0,sample.micros-prior)});floors.set(key,Math.max(prior,sample.micros));}
    const ambiguousOwners=new Set([...ownership.values()].filter(set=>set.size>1).flatMap(set=>[...set]));
    const unknownAt=[...native.tasks.filter(t=>t.billingCompleteness==="unknown").map(t=>t.admittedAtMs),...initials.map(i=>i.atMs),...chats.flatMap(c=>[c.createdAtMs,...c.requests.map(r=>r.atMs),...c.costObservations.map(r=>r.atMs)])];
    return {legacy,native,chats,initials,calls,entries,samples,ambiguousOwners,unknownAt};
  }
  private check(input:{atMs:number;scope:string;solutionId?:string;currency:string;additionalMicros:number;unknown:boolean;additionalCalls:number}):void {
    const p=this.options.policy(),today=day(input.atMs),month=today.slice(0,7);
    if(!/^[A-Z]{3}$/.test(p.currency)||p.maxDailyCalls!==null&&(!Number.isSafeInteger(p.maxDailyCalls)||p.maxDailyCalls<1)||[p.dailyMicros,p.monthlyMicros,...Object.values(p.scopeLimitsMicros??{})].some(v=>v!==null&&!safe(v)))throw new Error("activity-policy-invalid");
    const state=this.snapshot(),monthly=state.entries.filter(e=>day(e.atMs).startsWith(month)),daily=monthly.filter(e=>day(e.atMs)===today);
    if(!p.allowUnknown&&(input.unknown||state.unknownAt.some(at=>day(at).startsWith(month))||monthly.some(e=>e.unknown)))throw new Error("activity-cost-unknown-not-authorized");
    if(p.maxDailyCalls!==null&&sum([state.calls.filter(c=>day(c.atMs)===today).length,input.additionalCalls])>p.maxDailyCalls)throw new Error("daily-call-budget-exhausted");
    const scopes=[input.scope,...(input.solutionId?[`solution:${input.solutionId}`]:[])],moneyLimited=p.dailyMicros!==null||p.monthlyMicros!==null||scopes.some(s=>p.scopeLimitsMicros?.[s]!==undefined);
    if(moneyLimited&&(input.currency!==p.currency||monthly.some(e=>e.currency!==p.currency&&(e.micros>0||e.unknown))))throw new Error("budget-currency-mismatch");
    if(moneyLimited&&[...state.ambiguousOwners].some(owner=>state.samples.some(s=>s.owner===owner&&day(s.atMs).startsWith(month))||state.calls.some(c=>c.owner===owner&&day(c.atMs).startsWith(month))))throw new Error("activity-cost-attribution-ambiguous");
    const amount=(es:Entry[])=>sum(es.filter(e=>e.currency===p.currency).map(e=>e.micros));
    const exhausted=(used:number,limit:number)=>sum([used,input.additionalMicros])>limit||(input.unknown&&used>=limit);
    if(p.dailyMicros!==null&&exhausted(amount(daily),p.dailyMicros))throw new Error("daily-cost-budget-exhausted");
    if(p.monthlyMicros!==null&&exhausted(amount(monthly),p.monthlyMicros))throw new Error("monthly-cost-budget-exhausted");
    for(const scope of scopes){const limit=p.scopeLimitsMicros?.[scope];if(limit!==undefined&&exhausted(amount(daily.filter(e=>e.scope===scope||`solution:${e.solutionId}`===scope)),limit))throw new Error("scope-cost-budget-exhausted");}
  }
  summary(){return this.rollup(()=>true);}
  forRun(id:string){checkId(id);return this.rollup(item=>item.runId===id,{runId:id});}
  /** Exact original identity, retained for immutable historical callers. */
  forSolution(id:string){checkId(id);return this.rollup(item=>item.solutionId===id,{solutionIds:[id]});}
  /** Live owner view over canonical identity and aliases; never relabels stored execution facts. */
  forSolutionHistory(id:string) {
    return this.options.store.transaction(()=>{
      const solutionHistory=resolveSolutionHistory(this.options.store,id),selected=new Set(solutionHistory.solutionIds);
      return {...this.rollup(item=>item.solutionId!==undefined&&selected.has(item.solutionId),solutionHistory),solutionHistory};
    });
  }
  private rollup(filter:Filter,selection?:{runId:string}|{solutionIds:readonly string[]}) {
    const state=this.snapshot(),legacy=!selection?state.legacy:"runId" in selection?this.options.legacy().forRun(selection.runId):this.options.legacy().forSolutionIds(selection.solutionIds),
      selectedNative=!selection?state.native:"runId" in selection?this.options.native().forRun(selection.runId):this.options.native().forSolutionIds(selection.solutionIds);
    const native={...selectedNative,
      tasks:selectedNative.tasks.map(task=>({...task,unknownReasons:[...task.unknownReasons,...(state.ambiguousOwners.has(`native:${task.taskId}`)?["provider-session-shared-between-activities"]:[])]})),
      totals:selectedNative.totals.map(total=>({...total,nativeLatestReportedSessionMicros:selectedNative.tasks.some(task=>state.ambiguousOwners.has(`native:${task.taskId}`)&&task.sessions.some(session=>session.currency===total.currency))?null:total.nativeLatestReportedSessionMicros})),
    };
    const chats=state.chats.filter(filter).map(chat=>({...chat,unknownReasons:[...chat.unknownReasons,...(state.ambiguousOwners.has(`chat:${chat.chatId}`)?["provider-session-shared-between-activities"]:[])]}));
    const initials=state.initials.filter(filter),calls=state.calls.filter(filter);
    const currencies=[...new Set([...legacy.totals.map(t=>t.currency),...native.totals.map(t=>t.currency),...chats.flatMap(c=>c.sessions.map(s=>s.currency))])].sort();
    const totals=currencies.map(currency=>{
      const reports=new Map<string,{latest:number|null;floor:number}>();let ambiguous=false;
      for(const chat of chats)for(const session of chat.sessions.filter(s=>s.currency===currency)){
        const key=stableJson([chat.providerId,session.providerSessionId]),previous=reports.get(key);
        if(state.ambiguousOwners.has(`chat:${chat.chatId}`))ambiguous=true;
        reports.set(key,{latest:session.latestReportedMicros===null||previous?.latest===null?null:Math.max(previous?.latest??0,session.latestReportedMicros),floor:Math.max(previous?.floor??0,session.observedFloorMicros)});
      }
      const floors=new Map<string,number>();
      for(const task of native.tasks)for(const s of task.sessions.filter(s=>s.currency===currency)){const key=stableJson([task.providerId,s.providerSessionId]);floors.set(key,Math.max(floors.get(key)??0,s.observedFloorMicros));}
      for(const [key,value] of reports)floors.set(key,Math.max(floors.get(key)??0,value.floor));
      return {currency,manualChatLatestReportedSessionMicros:ambiguous||!reports.size||[...reports.values()].some(r=>r.latest===null)?null:sum([...reports.values()].map(r=>r.latest!)),manualChatObservedFloorMicros:sum([...reports.values()].map(r=>r.floor)),sharedNativeAndChatObservedFloorMicros:sum([...floors.values()])};
    });
    return {legacy,native,chats,initialChatAdmissions:initials,totals,calls:{legacyAdmissions:calls.filter(c=>c.id.startsWith("legacy:")).length,nativeAdmissions:native.tasks.length,initialChatAdmissions:initials.length,observedChatRequests:sum(chats.map(c=>c.observedRequests)),observedChatRootTurns:sum(chats.map(c=>c.observedRootTurns)),totalAdmissionsAndObservedRequests:calls.length},limitations};
  }
}
