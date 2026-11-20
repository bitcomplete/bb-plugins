import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store.js";
import type { Accounting } from "./costs.js";
import type { Config } from "./config.js";
import { LayaClient } from "./adapters/laya.js";
import type { PrivacyPolicy } from "./adapters/privacy.js";
import { extractMiningEvent } from "./sources.js";

interface Options {bb:BbPluginApi;store:Store;accounting:Accounting;config:()=>Config;enabled:()=>boolean;privacy:()=>PrivacyPolicy;redact:(text:string)=>string;owns:(id:string)=>boolean;enqueue:()=>void}
/** An asynchronous hint. It can accelerate mining, but never veto the interval sweep. */
export function registerReactive(options:Options):void {
  const {bb,store}=options;let inFlight=0;
  const cancellation=new AbortController(),tasks=new Set<Promise<void>>();
  const busy=new Set<string>();
  const handle:Parameters<typeof bb.events.on<"experimental_thread.events">>[1]=async({thread,sequence})=>{
    const config=options.config();
    if(cancellation.signal.aborted||!options.enabled())return;
    if(!config.laya.enabled||!config.laya.endpoint||busy.has(thread.id)||inFlight>=4)return;
    if(options.owns(thread.id)||thread.originPluginId==="self-improve")return;
    const last=store.get<{atMs:number;sequence:number}>("detector-cursors",thread.id);
    if(last&&(sequence<=last.sequence||Date.now()-last.atMs<30000))return;
    busy.add(thread.id);inFlight++;
    const id=randomUUID();let reserved=false,started=Date.now(),status="not-dispatched";
    try {
      // Follow both lifecycle parents and forks before reading their context.
      const seen=new Set<string>(), pending=[thread.parentThreadId,thread.sourceThreadId].filter((id):id is string=>!!id);
      while(pending.length){
        const parentId=pending.pop()!;if(seen.has(parentId))continue;seen.add(parentId);
        if(seen.size>100)throw new Error("ancestor-coverage-incomplete");
        if(options.owns(parentId))return;
        const parent=await bb.sdk.threads.get({threadId:parentId});if(parent.originPluginId==="self-improve")return;
        if(parent.parentThreadId)pending.push(parent.parentThreadId);if(parent.sourceThreadId)pending.push(parent.sourceThreadId);
      }
      const events=await bb.sdk.threads.events.list({threadId:thread.id,limit:"8",order:"desc"});
      const excerpts=events.map(e=>extractMiningEvent(e,0,options.redact)).filter(e=>e!==null).slice(0,2).reverse().map(e=>e.excerpt.slice(0,70));
      if(!excerpts.length)return;
      // Local inference and infrastructure prices are unknown until metered.
      // Opting into reactive mining alone never silently waives that policy.
      if(!config.budgets.allowUnknown)throw new Error("reactive-cost-unknown-disabled");
      if(!options.enabled()||cancellation.signal.aborted)return;
      options.accounting.reserve({id,model:"self-improve-laya-infrastructure",scope:"detector",inputBound:0,outputBound:0,workerId:`detector:${thread.id}`});reserved=true;
      const result=await new LayaClient({url:config.laya.endpoint,minConfidence:config.laya.minConfidence,privacy:options.privacy(),allowLoopback:bb.server.experimental_dataDir.includes("scratch")}).classify(excerpts,cancellation.signal);
      status=result.reason??result.decision;
      store.put("detector-events",id,{threadId:thread.id,sequence,atMs:started,...result,costBasis:"unknown"});
      store.put("detector-cursors",thread.id,{atMs:Date.now(),sequence});
      if(result.complete&&result.decision==="learn"&&(result.confidence??0)>=config.laya.minConfidence)options.enqueue();
    } catch {
      status="detector-unavailable-or-budget-deferred";
      store.put("detector-health","latest",{atMs:Date.now(),status,intervalFallback:true});
    } finally {
      if(reserved)options.accounting.settle({id,model:"self-improve-laya-infrastructure",usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null},complete:false,status,durationMs:Date.now()-started});
      busy.delete(thread.id);inFlight--;
    }
  };
  bb.events.on("experimental_thread.events",payload=>{const task=Promise.resolve(handle(payload));tasks.add(task);void task.then(()=>tasks.delete(task),()=>tasks.delete(task));return task;});
  bb.onDispose(async()=>{cancellation.abort();await Promise.allSettled(tasks);});
}
