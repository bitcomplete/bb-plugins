import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Store } from "./store.js";
import { stableId, stableJson } from "./domain/shared.js";

const id = z.string().min(1).max(500);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = count.max(8_640_000_000_000_000);
/** BB serves at most 100 thread events per page; a larger request is refused. */
export const EVENT_PAGE = 100;
const bindingSchema = z.object({ taskId:id, threadId:id, providerId:id, requestedModel:id }).strict();
export type NativeUsageBinding = z.infer<typeof bindingSchema>;
const tokensSchema = z.object({
  totalTokens:count, inputTokens:count, cachedInputTokens:count, outputTokens:count,
  reasoningOutputTokens:count, cacheReadInputTokens:count.optional(), cacheWriteInputTokens:count.optional(),
});
export type ReportedTokens = z.infer<typeof tokensSchema>;
const costSchema = z.object({ amount:z.number().finite().nonnegative(), currency:z.string().min(1).max(32) });
const scopeSchema = z.discriminatedUnion("kind", [z.object({kind:z.literal("thread")}),z.object({kind:z.literal("turn"),turnId:id})]);
const base = z.object({ id, threadId:id, seq:count, createdAt:timestamp, scope:scopeSchema });
const rowSchema = z.discriminatedUnion("type", [
  base.extend({ type:z.literal("thread/tokenUsage/updated"), data:z.object({
    providerThreadId:id, tokenUsage:z.object({total:tokensSchema,last:tokensSchema}),
  }) }),
  base.extend({ type:z.literal("thread/contextWindowUsage/updated"), data:z.object({
    providerThreadId:id, contextWindowUsage:z.object({ cost:costSchema.optional() }),
  }) }),
]);
export interface NativeUsageObservation {
  id:string; taskId:string; threadId:string; providerId:string; requestedModel:string;
  eventId:string; sequence:number; atMs:number; providerSessionId:string; turnId:string|null;
  kind:"tokens"|"cost"; total?:ReportedTokens; last?:ReportedTokens;
  cost?:{amount:number;currency:string}|null;
}
interface Cursor { binding:NativeUsageBinding; sequence:number }
export interface NativeUsageRead {
  taskId:string; threadId:string; requestedModel:string; providerId:string; throughSequence:number;
  /** This describes observation retrieval only, never final billing completeness. */
  historyCaughtUp:boolean; retrievalIssue:string|null;
  sessions:Array<{
    providerSessionId:string; tokens:ReportedTokens|null; cost:{amount:number;currency:string}|null;
    tokenSequence:number|null; costSequence:number|null; counterResetObserved:boolean;
  }>;
  limitations:readonly string[];
}
export type NativeUsageSdk = Pick<BbPluginApi["sdk"],"threads">;
const namespaces = { cursors:"native-usage-cursors", observations:"native-usage-observations", reads:"native-usage-reads" };

/** BB observations, with no vendor token arithmetic or invented subscription invoice. */
export class NativeUsageLedger {
  constructor(readonly store:Store) {}
  private cursor(binding:NativeUsageBinding):Cursor {
    bindingSchema.parse(binding);
    const value=this.store.get<Cursor>(namespaces.cursors,binding.threadId);
    if(value && stableJson(value.binding)!==stableJson(binding))throw new Error("native-usage-binding-conflict");
    return value ?? {binding,sequence:-1};
  }
  ingest(binding:NativeUsageBinding, rows:readonly unknown[]):void {
    this.cursor(binding);
    if(rows.length>200)throw new Error("native-usage-page-too-large");
    const parsed=rows.map(row=>rowSchema.parse(row));
    const observations:NativeUsageObservation[]=parsed.map((row,index)=>{
      if(row.threadId!==binding.threadId)throw new Error("native-usage-wrong-thread");
      if(index>0&&row.seq<=parsed[index-1]!.seq)throw new Error("native-usage-page-order");
      const common={...binding,id:stableId("native-usage",[binding.threadId,row.seq]),eventId:row.id,sequence:row.seq,atMs:row.createdAt,
        providerSessionId:row.data.providerThreadId,turnId:row.scope.kind==="turn"?row.scope.turnId:null};
      return row.type==="thread/tokenUsage/updated"
        ? {...common,kind:"tokens",total:row.data.tokenUsage.total,last:row.data.tokenUsage.last}
        : {...common,kind:"cost",cost:row.data.contextWindowUsage.cost??null};
    });
    this.store.transaction(()=>{
      const current=this.cursor(binding);
      let added=false;
      for(const observation of observations){
        const prior=this.store.get<NativeUsageObservation>(namespaces.observations,observation.id);
        if(prior){
          if(stableJson(prior)!==stableJson(observation))throw new Error("native-usage-event-conflict");
        }else{
          if(observation.sequence<=current.sequence)throw new Error("native-usage-unseen-earlier-event");
          this.store.put(namespaces.observations,observation.id,observation);
          added=true;
        }
      }
      const sequence=Math.max(current.sequence,observations.at(-1)?.sequence??-1);
      if(added||!this.store.get(namespaces.cursors,binding.threadId))this.store.put(namespaces.cursors,binding.threadId,{binding,sequence});
      // Direct ingestion cannot assert that the source has no later observations.
      if(added)this.store.put(namespaces.reads,binding.threadId,{throughSequence:sequence,caughtUp:false,issue:null});
    });
  }
  read(binding:NativeUsageBinding):NativeUsageRead {
    const cursor=this.cursor(binding);
    const retrieval=this.store.get<{throughSequence:number;caughtUp:boolean;issue:string|null}>(namespaces.reads,binding.threadId);
    const observations=this.store.list<NativeUsageObservation>(namespaces.observations)
      .filter(row=>row.threadId===binding.threadId).sort((a,b)=>a.sequence-b.sequence);
    const sessions=new Map<string,NativeUsageRead["sessions"][number]>();
    for(const row of observations){
      if(row.taskId!==binding.taskId||row.providerId!==binding.providerId||row.requestedModel!==binding.requestedModel)throw new Error("native-usage-binding-conflict");
      const session=sessions.get(row.providerSessionId)??{providerSessionId:row.providerSessionId,tokens:null,cost:null,tokenSequence:null,costSequence:null,counterResetObserved:false};
      if(row.kind==="tokens"){
        const next=row.total!;
        if(session.tokens&&Object.keys(next).some(key=>{
          const field=key as keyof ReportedTokens,previous=session.tokens![field];return previous!==undefined&&next[field]!==undefined&&next[field]!<previous;
        }))session.counterResetObserved=true;
        session.tokens=next;session.tokenSequence=row.sequence;
      }else{session.cost=row.cost??null;session.costSequence=row.sequence;}
      sessions.set(row.providerSessionId,session);
    }
    return {...binding,throughSequence:cursor.sequence,historyCaughtUp:retrieval?.throughSequence===cursor.sequence&&retrieval.caughtUp,
      retrievalIssue:retrieval?.issue??null,sessions:[...sessions.values()],limitations:[
        "Token fields retain the reporting provider's counting semantics; reasoning is already part of output. Cumulative updates are never added together.",
        "Cost is an optional provider-reported session amount, not a final per-attempt invoice or a subscription charge. Missing amounts remain unknown.",
        "Requested model identifies configuration, not proof of every underlying attempt's actual model. Session resets and provider retries can limit accounting coverage.",
      ]};
  }
  async collect(sdk:NativeUsageSdk,binding:NativeUsageBinding,options:{signal?:AbortSignal;maxPages?:number}={}):Promise<NativeUsageRead>{
    const maxPages=options.maxPages??10;
    if(!Number.isInteger(maxPages)||maxPages<1||maxPages>100)throw new Error("native-usage-page-limit-invalid");
    this.store.transaction(()=>{
      const cursor=this.cursor(binding);
      // Even an unavailable report belongs to one immutable task identity.
      if(!this.store.get(namespaces.cursors,binding.threadId))this.store.put(namespaces.cursors,binding.threadId,cursor);
    });
    const finish=(observedThrough:number,caughtUp:boolean,issue:string|null)=>this.store.transaction(()=>{
      const cursor=this.cursor(binding);
      // A delayed empty page cannot certify observations another reader fetched.
      if(cursor.sequence!==observedThrough)return {...this.read(binding),historyCaughtUp:false,retrievalIssue:"native-usage-concurrent-update"};
      this.store.put(namespaces.reads,binding.threadId,{throughSequence:cursor.sequence,caughtUp,issue});return this.read(binding);
    });
    let observedThrough=this.cursor(binding).sequence;
    for(let page=0;page<maxPages;page++){
      options.signal?.throwIfAborted();const cursor=this.cursor(binding);
      let rows:unknown;
      try{
        rows=await sdk.threads.events.list({threadId:binding.threadId,...(cursor.sequence>=0?{afterSeq:String(cursor.sequence)}:{}),limit:String(EVENT_PAGE),order:"asc",
          types:["thread/tokenUsage/updated","thread/contextWindowUsage/updated"],signal:options.signal});
      }catch{options.signal?.throwIfAborted();return finish(cursor.sequence,false,"native-usage-source-unavailable");}
      options.signal?.throwIfAborted();
      if(!Array.isArray(rows)||rows.length>EVENT_PAGE)return finish(cursor.sequence,false,"native-usage-invalid-page");
      try{
        if(rows.some(row=>!row||typeof row!=="object"||typeof row.seq!=="number"||row.seq<=cursor.sequence))throw new Error("native-usage-cursor-did-not-advance");
        this.ingest(binding,rows);
        observedThrough=rows.length?rows.at(-1)!.seq:cursor.sequence;
      }catch{return finish(cursor.sequence,false,"native-usage-invalid-page");}
      if(rows.length<EVENT_PAGE)return finish(observedThrough,true,null);
    }
    return finish(observedThrough,false,"native-usage-page-limit");
  }
}
