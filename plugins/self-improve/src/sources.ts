import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TaskRun } from "./domain/types.js";
import type { JobRun, MiningEvent, MiningSession } from "./stages/mining.js";
import { stableId, stableJson } from "./domain/shared.js";

export type SourceSdk = Pick<BbPluginApi["sdk"],"threads"|"projects"|"plugins">;
export interface SourceCoverage { source:string;complete:boolean;reason:string|null }
export interface TaskOutcomeSource { pluginId:string;method:string }
export interface TaskOutcomeResult {runs:TaskRun[];complete:boolean;reason?:string|null}
export interface SourceInput {
  now:number;lookbackMs?:number;pageSize?:number;maxPages?:number;signal?:AbortSignal;
  readCursor:(key:string)=>{sequence:number}|null;
  redact:(text:string)=>string;
  dayFor?:(atMs:number)=>string;
  /** Explicit terminal history adapter; thread idle/failed is not a substitute. */
  taskOutcomeSource?:()=>Promise<TaskOutcomeResult>;
  /** Owner-configured public RPC with the structured history contract below. */
  taskOutcomeRpc?:TaskOutcomeSource;
  /** Trusted runtime registry, not writable agent metadata. */
  isOwnedThread?:(threadId:string)=>boolean;
}
export interface SessionMetadata {sessionId:string;day:string;projectId:string|null;providerId:string|null;model:string|null;firstSequence:number;lastSequence:number;complete:boolean;reasons:string[]}
export interface SourceResult {sessionMetadata:SessionMetadata[];sessions:MiningSession[];taskRuns:TaskRun[];jobRuns:JobRun[];coverage:SourceCoverage[];observedThreads:number}
type Row=Record<string,unknown>;
const object=(value:unknown):Row|null=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Row:null;
const text=(value:unknown):string|null=>typeof value==="string"&&value.length>0?value:null;
const timestamp=(value:unknown):number|null=>typeof value==="number"&&Number.isFinite(value)?value:typeof value==="string"&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const stringSchema=z.string().min(1);
const taskPageSchema=z.object({tasks:z.array(z.object({id:stringSchema})),nextCursor:z.string().nullable()});
const taskThreadsSchema=z.object({taskThreads:z.array(z.object({taskId:stringSchema,threadId:stringSchema,liveStatus:z.string(),attachedAt:z.string()}))});
const automationsSchema=z.array(z.object({id:stringSchema,createdByThreadId:z.string().nullable().optional()}));
const runsSchema=z.object({runs:z.array(z.object({id:stringSchema,automationId:stringSchema,threadId:z.string().nullable(),status:z.string(),startedAt:z.number(),finishedAt:z.number().nullable()})),nextCursor:z.string().nullable()});
const outcomeId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const taskOutcomePageSchema=z.object({
  runs:z.array(z.object({taskId:outcomeId,runId:outcomeId,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),occurredAtMs:z.number().int().nonnegative().max(8_640_000_000_000_000),outcome:z.enum(["failed","blocked","succeeded","running"]),originPluginId:z.string().min(1).max(200).nullable()}).strict()).max(200),
  nextCursor:z.string().min(1).max(2048).nullable(),complete:z.boolean(),
}).strict();

/** The producer attests terminal task facts. Thread liveStatus is never translated
 * into failed/blocked, and incomplete coverage is never promoted by this reader.
 */
export async function collectTaskOutcomes(sdk:SourceSdk,source:TaskOutcomeSource,input:{sinceMs:number;untilMs:number;limit?:number;maxPages?:number;signal?:AbortSignal}):Promise<TaskOutcomeResult>{
  const limit=input.limit??100,maxPages=input.maxPages??100;
  if(!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(source.pluginId)||source.pluginId==="self-improve"||!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(source.method))throw new Error("invalid-task-outcome-source");
  if(!Number.isSafeInteger(input.sinceMs)||input.sinceMs<0||!Number.isSafeInteger(input.untilMs)||input.untilMs<input.sinceMs||input.untilMs>8_640_000_000_000_000||!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>1000)throw new Error("invalid-task-outcome-window-or-limits");
  const runs=new Map<string,TaskRun>(),cursors=new Set<string>();let cursor:string|undefined,declaredComplete=true;
  const result=(reason:string|null):TaskOutcomeResult=>({runs:[...runs.values()],complete:reason===null,reason});
  for(let page=0;page<maxPages;page++){
    input.signal?.throwIfAborted();let raw:unknown;
    try{raw=await sdk.plugins.callRpc({pluginId:source.pluginId,method:source.method,input:{sinceMs:input.sinceMs,untilMs:input.untilMs,limit,...(cursor?{cursor}:{})},outputSchema:taskOutcomePageSchema});}
    catch{input.signal?.throwIfAborted();return result("task-history-rpc-unavailable");}
    input.signal?.throwIfAborted();const parsed=taskOutcomePageSchema.safeParse(raw);
    if(!parsed.success||parsed.data.runs.length>limit)return result("task-history-invalid-page");
    const data=parsed.data;
    if(data.runs.some(run=>run.occurredAtMs<input.sinceMs||run.occurredAtMs>input.untilMs||new Date(run.occurredAtMs).toISOString().slice(0,10)!==run.day))return result("task-history-invalid-page");
    // Validate the entire page before committing any of its observations.
    const next=new Map(runs);
    for(const run of data.runs){
      if(run.originPluginId==="self-improve")continue;
      const key=stableJson([run.taskId,run.runId]),previous=next.get(key);
      if(previous&&stableJson(previous)!==stableJson(run))return result("task-history-conflicting-run");
      next.set(key,run);
    }
    if(next.size>10000)return result("task-history-run-limit");
    for(const [key,run] of next)runs.set(key,run);
    declaredComplete=declaredComplete&&data.complete;
    if(data.nextCursor===null)return result(declaredComplete?null:"task-history-provider-partial");
    if(cursors.has(data.nextCursor))return result("task-history-cursor-cycle");
    cursors.add(data.nextCursor);cursor=data.nextCursor;
  }
  return result("task-history-page-limit");
}

/** Only allowlisted fields reach the miner. Arguments, raw output, env, usage and reasoning never do. */
export function extractMiningEvent(raw:unknown,turnIndex:number,redact:SourceInput["redact"]):MiningEvent|null {
  const row=object(raw),data=object(row?.data);if(!row||!data||typeof row.seq!=="number"||!Number.isSafeInteger(row.seq)||typeof row.id!=="string"||typeof row.createdAt!=="number")return null;
  let kind:MiningEvent["kind"]="context",excerpt="";
  if(row.type==="client/turn/requested"){
    if(data.originPluginId==="self-improve")return null;
    if(typeof data.retryOfRequestId==="string"&&typeof data.retryAttempt==="number"){kind="tool_retry";excerpt=`A failed turn was retried (attempt ${data.retryAttempt})`;}
    else if(data.initiator==="user"&&Array.isArray(data.input)){
      // Candidate class, not a deterministic correction vote: the miner must find an actual correction.
      kind="owner_correction";excerpt=data.input.flatMap(v=>{const p=object(v);return p?.type==="text"&&typeof p.text==="string"?[p.text]:[];}).join("\n");
    }
  }else if(row.type==="item/completed"){
    const item=object(data.item);if(!item)return null;
    if(item.type==="agentMessage"&&typeof item.text==="string")excerpt=item.text;
    else if(item.type==="toolCall"||item.type==="commandExecution"||item.type==="fileChange"){
      const failed=item.status==="failed"||(typeof item.exitCode==="number"&&item.exitCode!==0)||typeof item.error==="string";
      kind=failed?"tool_error":"context";
      excerpt=`${item.type} ${failed?"failed":"completed"}${typeof item.exitCode==="number"?` (exit ${item.exitCode})`:""}${typeof item.error==="string"?`: ${item.error}`:""}`;
      // Tool names are identifiers, but commands/arguments and aggregatedOutput may contain credentials.
    }
  }else if(row.type==="provider/error"){kind=data.willRetry===true?"tool_retry":"tool_error";excerpt=typeof data.message==="string"?data.message:"Provider failure";}
  else if(row.type==="turn/completed"){excerpt=`Turn completed with status ${typeof data.status==="string"?data.status:"unknown"}`;}
  if(!excerpt)return null;
  const safe=redact(excerpt).slice(0,4000);if(!safe)return null;
  return {id:row.id,sequence:row.seq,atMs:row.createdAt,turnIndex,kind,excerpt:safe};
}

export async function collectSources(sdk:SourceSdk,input:SourceInput):Promise<SourceResult>{
  const pageSize=input.pageSize??100,maxPages=input.maxPages??100;
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>200||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>1000)throw new Error("Invalid source pagination limits");
  const lookback=input.lookbackMs??2*86_400_000;
  if(!Number.isFinite(input.now)||!Number.isFinite(lookback)||lookback<=0||lookback>90*86_400_000)throw new Error("Invalid source time window");
  const since=input.now-lookback;const dayFor=input.dayFor??(ms=>new Date(ms).toISOString().slice(0,10));
  const coverage:SourceCoverage[]=[];const sessionMetadata:SessionMetadata[]=[];const sessions:MiningSession[]=[];const taskRuns:TaskRun[]=[];const jobRuns:JobRun[]=[];
  const threads=new Map<string,Row>();
  const addCoverage=(source:string,complete:boolean,reason:string|null=null)=>coverage.push({source,complete,reason});
  const stop=()=>input.signal?.throwIfAborted();
  for(const archived of [false,true]){
    let done=false;
    try{for(let page=0;page<maxPages;page++){
      stop();const rows=await sdk.threads.list({includeHidden:true,archived,limit:pageSize,offset:page*pageSize,signal:input.signal});
      if(!Array.isArray(rows))throw new Error("invalid page");let added=0;
      for(const row of rows){if(threads.has(row.id))continue;threads.set(row.id,row as unknown as Row);added++;}
      if(rows.length<pageSize){done=true;break;}if(added===0)throw new Error("pagination did not advance");
    }addCoverage(archived?"archived-threads":"active-threads",done,done?null:"page-limit");}
    catch{stop();addCoverage(archived?"archived-threads":"active-threads",false,"unavailable-or-invalid-page");}
  }
  const ownership=new Map<string,boolean|null>();
  async function owned(id:string,path=new Set<string>()):Promise<boolean|null>{
    if(input.isOwnedThread?.(id))return true;if(ownership.has(id))return ownership.get(id)!;
    if(path.has(id)||path.size>100)return null;path.add(id);
    let thread=threads.get(id);
    if(!thread){try{thread=await sdk.threads.get({threadId:id}) as unknown as Row;threads.set(id,thread);}catch{return null;}}
    if(thread.originPluginId==="self-improve"){ownership.set(id,true);return true;}
    const parent=text(thread.parentThreadId),source=text(thread.sourceThreadId);
    for(const ancestor of [parent,source].filter((x):x is string=>x!==null)){
      const result=await owned(ancestor,new Set(path));if(result!==false){ownership.set(id,result);return result;}
    }
    ownership.set(id,false);return false;
  }
  const taskForThread=new Map<string,string>();
  try{
    let cursor:string|undefined;let done=false;
    for(let page=0;page<maxPages;page++){
      stop();const result=await sdk.plugins.callRpc({pluginId:"tasks",method:"listTasks",input:{limit:pageSize,...(cursor?{cursor}:{})},outputSchema:taskPageSchema});
      for(const task of result.tasks){
        const result=await sdk.plugins.callRpc({pluginId:"tasks",method:"listTaskThreads",input:{taskId:task.id},outputSchema:taskThreadsSchema});
        for(const thread of result.taskThreads){if(taskForThread.has(thread.threadId)&&taskForThread.get(thread.threadId)!==task.id)throw new Error("ambiguous task identity");taskForThread.set(thread.threadId,task.id);}
      }
      if(!result.nextCursor){done=true;break;}if(result.nextCursor===cursor)throw new Error("pagination did not advance");cursor=result.nextCursor;
    }addCoverage("task-identity",done,done?null:"page-limit");
  }catch{stop();addCoverage("task-identity",false,"tasks-rpc-unavailable-or-invalid");}
  const taskOutcomeSource=input.taskOutcomeSource??(input.taskOutcomeRpc?()=>collectTaskOutcomes(sdk,input.taskOutcomeRpc!,{sinceMs:Math.max(0,since),untilMs:input.now,limit:pageSize,maxPages,signal:input.signal}):undefined);
  if(taskOutcomeSource){
    try{const result=await taskOutcomeSource();for(const run of result.runs){if(run.originPluginId!=="self-improve"&&run.occurredAtMs>=since&&run.occurredAtMs<=input.now)taskRuns.push(run);}addCoverage("task-outcomes",result.complete,result.complete?null:result.reason??"partial-structured-history");}
    catch{stop();addCoverage("task-outcomes",false,"structured-task-history-unavailable");}
  }else addCoverage("task-outcomes",false,"Public task statuses do not establish terminal failed/blocked outcomes or complete run counts");
  async function eventPages(id:string,after=0,turnStarts=false):Promise<Row[]>{
    // A new reader starts from recent events, so years of unrelated history cannot
    // exhaust the page budget before it reaches the requested window.
    if(after===0&&!turnStarts){
      const recent:Row[]=[];let before:number|undefined;
      for(let page=0;page<maxPages;page++){
        stop();const batch=await sdk.threads.events.list({threadId:id,...(before!==undefined?{beforeSeq:String(before)}:{}),limit:String(pageSize),order:"desc",signal:input.signal});
        let crossed=false;
        for(const event of batch){if(!Number.isSafeInteger(event.seq)||(before!==undefined&&event.seq>=before))throw new Error("event pagination did not advance");before=event.seq;recent.push(event as unknown as Row);if(event.createdAt<since)crossed=true;}
        if(batch.length<pageSize||crossed)return recent.reverse();
      }throw new Error("recent event page limit");
    }
    const all:Row[]=[];let cursor=after;
    for(let page=0;page<maxPages;page++){
      stop();const batch=await sdk.threads.events.list({threadId:id,afterSeq:String(cursor),limit:String(pageSize),order:"asc",signal:input.signal,...(turnStarts?{types:["turn/started","client/turn/requested","turn/input/accepted","provider/modelFallback"] as const}:{})});
      if(!Array.isArray(batch))throw new Error("invalid events");
      for(const event of batch){if(!Number.isSafeInteger(event.seq)||event.seq<=cursor)throw new Error("event pagination did not advance");cursor=event.seq;all.push(event as unknown as Row);}
      if(batch.length<pageSize)return all;
    }throw new Error("event page limit");
  }
  for(const thread of [...threads.values()]){
    stop();const id=text(thread.id);if(!id)continue;
    const ownershipStatus=await owned(id);if(ownershipStatus===true)continue;
    if(ownershipStatus===null){addCoverage(`thread:${id}`,false,"ancestor-attribution-unavailable");continue;}
    try{
      const provenance=await eventPages(id,0,true);const turnIndices=new Map<string,number>();
      provenance.filter(r=>r.type==="turn/started").forEach((r,index)=>{const turn=text(object(r.scope)?.turnId);if(turn)turnIndices.set(turn,index);});
      const days=new Set<string>();for(let t=since;t<=input.now;t+=86_400_000)days.add(dayFor(t));days.add(dayFor(input.now));
      const cursors=[...days].map(day=>input.readCursor(stableId("cursor",[id,day]))?.sequence??0);const after=Math.min(...cursors);
      const events=await eventPages(id,after);const byDay=new Map<string,MiningEvent[]>(),byDayTurns=new Map<string,Set<string|null>>();
      const ownRequestIds=new Set<string>(),ownTurns=new Set<string>(),requests=new Map<string,Row>(),models=new Map<string,Set<string>>(),fallbackTurns=new Set<string|null>();
      // A plugin may submit work to an otherwise owner-origin thread. Attribute that turn,
      // including its retry, from BB's stored dispatch provenance rather than agent metadata.
      for(const row of provenance){const data=object(row.data);if(!data)continue;
        if(row.type==="client/turn/requested"&&typeof data.requestId==="string")requests.set(data.requestId,data);
        if(row.type==="provider/modelFallback")fallbackTurns.add(text(object(row.scope)?.turnId));
        if(row.type==="turn/input/accepted"){
          const turn=text(object(row.scope)?.turnId),request=text(data.clientRequestId);const model=request?text(object(requests.get(request)?.execution)?.model):null;
          if(turn&&model){const found=models.get(turn)??new Set<string>();found.add(model);models.set(turn,found);}
        }
        if(row.type==="client/turn/requested"&&(data.originPluginId==="self-improve"||(typeof data.retryOfRequestId==="string"&&ownRequestIds.has(data.retryOfRequestId)))){
          if(typeof data.requestId==="string")ownRequestIds.add(data.requestId);
          const turn=text(object(row.scope)?.turnId);if(turn)ownTurns.add(turn);
        }
        if(row.type==="turn/input/accepted"&&typeof data.clientRequestId==="string"&&ownRequestIds.has(data.clientRequestId)){
          const turn=text(object(row.scope)?.turnId);if(turn)ownTurns.add(turn);
        }
      }
      for(const row of events){
        const at=timestamp(row.createdAt);if(at===null||at<since||at>input.now)continue;
        const day=dayFor(at);const cursor=input.readCursor(stableId("cursor",[id,day]))?.sequence??0;if(Number(row.seq)<=cursor)continue;
        const turnId=text(object(row.scope)?.turnId);const turnIndex=turnId?turnIndices.get(turnId):undefined;
        if(turnId&&ownTurns.has(turnId))continue;
        // A user input can be queued before this cursor and accepted later. Mine it
        // at its acceptance sequence, where the real turn identity is established.
        if(row.type==="client/turn/requested")continue;
        let observed=row;
        if(row.type==="turn/input/accepted"){
          const requestId=text(object(row.data)?.clientRequestId);const request=requestId?requests.get(requestId):null;
          if(!request)throw new Error("accepted request provenance unavailable");
          observed={...row,type:"client/turn/requested",data:request};
        }
        const event=extractMiningEvent(observed,turnIndex??0,input.redact);if(!event)continue;
        if(turnId&&turnIndex===undefined)throw new Error("turn index unavailable");
        byDay.set(day,[...(byDay.get(day)??[]),event]);const turns=byDayTurns.get(day)??new Set<string|null>();turns.add(turnId);byDayTurns.set(day,turns);
      }
      for(const [day,events] of byDay){
        const firstEventAtMs=events[0].atMs;sessions.push({sessionId:id,threadId:id,taskId:taskForThread.get(id)??null,day,firstEventAtMs,originPluginId:null,events});
        const turns=[...(byDayTurns.get(day)??[])],observedModels=new Set(turns.flatMap(turn=>turn?[...(models.get(turn)??[])]:[])),reasons:string[]=[];
        if(turns.some(turn=>!turn||!models.has(turn)))reasons.push("historical-model-unavailable");
        if(observedModels.size>1)reasons.push("mixed-models");
        if(fallbackTurns.has(null)||turns.some(turn=>fallbackTurns.has(turn)))reasons.push("model-fallback");
        const projectId=text(thread.projectId),providerId=text(thread.providerId);
        if(!projectId||!providerId)reasons.push("source-identity-unavailable");
        sessionMetadata.push({sessionId:id,day,projectId,providerId,model:reasons.length===0&&observedModels.size===1?[...observedModels][0]!:null,firstSequence:events[0]!.sequence,lastSequence:events[events.length-1]!.sequence,complete:reasons.length===0,reasons});
      }
      addCoverage(`thread:${id}`,true);
    }catch{stop();addCoverage(`thread:${id}`,false,"event-history-unavailable-invalid-or-page-limit");}
  }
  try{
    const projects=await sdk.projects.list();
    for(const project of projects){
      stop();const automations=await sdk.plugins.callRpc({pluginId:"automations",method:"automations_list",input:{projectId:project.id},outputSchema:automationsSchema});
      for(const automation of automations){
        if(automation.createdByThreadId&&await owned(automation.createdByThreadId)!==false)continue;
        let cursor:string|undefined,done=false;
        for(let page=0;page<maxPages;page++){
          const result=await sdk.plugins.callRpc({pluginId:"automations",method:"automations_runs",input:{projectId:project.id,automationId:automation.id,limit:pageSize,...(cursor?{cursor}:{})},outputSchema:runsSchema});
          for(const run of result.runs){
            if(run.threadId&&await owned(run.threadId)!==false)continue;
            const at=run.startedAt;if(at<since||at>input.now)continue;
            const status=run.status==="failed"?"failed":run.status==="succeeded"?"succeeded":run.status==="running"?"running":null;
            if(status)jobRuns.push({jobId:automation.id,runId:run.id,day:dayFor(at),occurredAtMs:at,status,originPluginId:null});
          }
          if(!result.nextCursor){done=true;break;}if(result.nextCursor===cursor)throw new Error("run pagination did not advance");cursor=result.nextCursor;
        }addCoverage(`automation:${automation.id}`,done,done?null:"page-limit");
      }
    }addCoverage("scheduled-jobs",true);
  }catch{stop();addCoverage("scheduled-jobs",false,"automations-rpc-unavailable-or-invalid");}
  addCoverage("other-plugin-schedules",false,"Only latest status is public; historical run coverage is unavailable");
  return {sessions,taskRuns,jobRuns,sessionMetadata,coverage,observedThreads:threads.size};
}
