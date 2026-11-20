import { describe, expect, it, vi } from "vitest";
import { collectSources, extractMiningEvent, type SourceSdk } from "../src/sources.js";
import { stableId } from "../src/domain/shared.js";
const now=Date.parse("2026-11-18T12:00:00Z");
const row=(type:string,data:unknown,seq=1)=>({id:`e${seq}`,type,data,seq,createdAt:now-100,scope:{kind:"turn",turnId:"turn1"},threadId:"t1"});
const sdk=(events:unknown[],threads:unknown[]=[{id:"t1",projectId:"p1",originPluginId:null,parentThreadId:null}]):SourceSdk=>({
  projects:{list:async()=>[{id:"p1"}]},threads:{list:async({archived,offset}:any)=>!archived&&!offset?threads:[],get:async()=>{throw Error("missing");},events:{list:async(args:any)=>{
    const selected=events.filter((e:any)=>(!args.types||args.types.includes(e.type))&&e.seq>Number(args.afterSeq??0)&&e.seq<Number(args.beforeSeq??Infinity));
    return (args.order==="desc"?[...selected].reverse():selected).slice(0,Number(args.limit??100));
  }}},
  plugins:{callRpc:async()=>{throw Error("unavailable");}},
} as unknown as SourceSdk);
const options={now,lookbackMs:86_400_000,readCursor:()=>null,redact:(s:string)=>s.replaceAll("SECRET","[redacted]")};
describe("read-only source ingestion",()=>{
  it("reads hidden and archived threads, discards raw environment/token events",async()=>{
    const api=sdk([row("turn/started",{},1),row("provider.env-resolved",{SECRET:"credential"},2),row("thread/tokenUsage/updated",{text:"SECRET"},3),row("item/completed",{item:{type:"toolCall",tool:"fetch",status:"failed",error:"SECRET",arguments:{secret:"RAW"},result:"RAW"}},4)]);
    const spy=vi.spyOn(api.threads,"list");const result=await collectSources(api,options);
    expect(spy.mock.calls.some(([args])=>args?.archived===true&&args.includeHidden===true)).toBe(true);
    expect(result.sessions[0].events).toHaveLength(1);expect(JSON.stringify(result)).not.toMatch(/SECRET|RAW|credential/);
    expect(result.sessions[0].events[0]).toMatchObject({kind:"tool_error",turnIndex:0});
  });
  it("excludes plugin descendants even when their own origin is absent",async()=>{
    const api=sdk([row("turn/started",{},1),row("item/completed",{item:{type:"agentMessage",text:"work"}},2)],[{id:"t1",originPluginId:null,parentThreadId:"parent"},{id:"parent",originPluginId:"self-improve",parentThreadId:null}]);
    expect((await collectSources(api,options)).sessions).toEqual([]);
  });
  it("reads a long thread in full, asking only for the event types it uses",async()=>{
    // 3,000 streaming deltas around 1,500 completed messages: far more than ten pages of raw events.
    const events:unknown[]=[row("turn/started",{},1)];let seq=2;
    for(let i=0;i<1500;i++){events.push(row("item/agentMessage/delta",{delta:"x"},seq++),row("item/agentMessage/delta",{delta:"y"},seq++),row("item/completed",{item:{type:"agentMessage",text:`message ${i}`}},seq++));}
    const api=sdk(events),spy=vi.spyOn(api.threads.events,"list");
    const result=await collectSources(api,{...options,maxPages:10});
    expect(result.coverage.filter(c=>c.source==="thread:t1")).toEqual([{source:"thread:t1",complete:true,reason:null}]);
    expect(result.sessions[0].events).toHaveLength(1500);
    expect(spy.mock.calls.every(([args])=>{const types=(args as unknown as {types?:string[]}).types;return Array.isArray(types)&&!types.includes("item/agentMessage/delta");})).toBe(true);
  });
  it("reuses committed per-session/day cursors without writing them",async()=>{
    const api=sdk([row("turn/started",{},1),row("item/completed",{item:{type:"agentMessage",text:"old"}},2),row("item/completed",{item:{type:"agentMessage",text:"new"}},3)]);
    const readCursor=vi.fn((key:string)=>key===stableId("cursor",["t1","2026-11-18"])?{sequence:2}:null);
    const result=await collectSources(api,{...options,readCursor});
    expect(result.sessions[0].events.map(e=>e.sequence)).toEqual([3]);
  });
  it("does not treat task-thread liveStatus failed as a terminal task failure",async()=>{
    const api=sdk([]);api.plugins.callRpc=vi.fn(async(args:any)=>args.method==="listTasks"?{tasks:[{id:"task1"}],nextCursor:null}:args.method==="listTaskThreads"?{taskThreads:[{taskId:"task1",threadId:"t1",liveStatus:"failed",attachedAt:new Date(now-1000).toISOString()}]}:[] ) as any;
    const result=await collectSources(api,options);
    expect(result.taskRuns).toEqual([]);expect(result.coverage.some(c=>c.source==="task-outcomes"&&!c.complete)).toBe(true);
  });
  it("extracts only safe text fields and labels user input as a correction candidate",()=>{
    const event=extractMiningEvent(row("client/turn/requested",{initiator:"user",input:[{type:"text",text:"Please fix SECRET"}],request:{params:{token:"RAW"}}}),0,options.redact);
    expect(event).toMatchObject({kind:"owner_correction",excerpt:"Please fix [redacted]"});expect(JSON.stringify(event)).not.toContain("RAW");
  });
  it("reports a non-advancing event page and returns no partial session",async()=>{
    const api=sdk([row("turn/started",{},1)]);api.threads.events.list=async(args:any)=>args.types?[row("turn/started",{},1)]:[row("item/completed",{item:{type:"agentMessage",text:"x"}},2)] as any;
    const result=await collectSources(api,{...options,pageSize:1,maxPages:2});
    expect(result.sessions).toEqual([]);expect(result.coverage.some(c=>!c.complete)).toBe(true);
  });
  it("excludes plugin-submitted turns inside an owner-origin thread",async()=>{
    const api=sdk([row("turn/started",{},1),row("client/turn/requested",{originPluginId:"self-improve",requestId:"r",initiator:"system",input:[]},2),row("turn/input/accepted",{clientRequestId:"r"},3),row("item/completed",{item:{type:"toolCall",status:"failed",error:"own failure"}},4)]);
    expect((await collectSources(api,options)).sessions).toEqual([]);
  });
  it("retains self-turn provenance before the committed cursor",async()=>{
    const api=sdk([row("turn/started",{},1),row("client/turn/requested",{originPluginId:"self-improve",requestId:"r",initiator:"system",input:[]},2),row("turn/input/accepted",{clientRequestId:"r"},3),row("item/completed",{item:{type:"toolCall",status:"failed",error:"own failure"}},4)]);
    const result=await collectSources(api,{...options,readCursor:()=>({sequence:3})});
    expect(result.sessions).toEqual([]);
  });
  it("emits a delayed owner correction at acceptance with the actual turn index",async()=>{
    const first=row("turn/started",{},1);first.scope.turnId="older";
    const requested=row("client/turn/requested",{requestId:"owner",initiator:"user",input:[{type:"text",text:"Please fix SECRET"}]},2);requested.scope={kind:"thread"} as any;
    const api=sdk([first,requested,row("turn/started",{},3),row("turn/input/accepted",{clientRequestId:"owner"},4)]);
    const result=await collectSources(api,{...options,readCursor:()=>({sequence:3})});
    expect(result.sessions[0]?.events).toEqual([expect.objectContaining({id:"e4",kind:"owner_correction",turnIndex:1,excerpt:"Please fix [redacted]"})]);
  });

  it("derives historical model identity from accepted execution metadata",async()=>{
    const api=sdk([row("turn/started",{},1),row("client/turn/requested",{requestId:"r",initiator:"user",execution:{model:"historical-model"},input:[{type:"text",text:"Fix that"}]},2),row("turn/input/accepted",{clientRequestId:"r"},3)],[{id:"t1",projectId:"p1",providerId:"claude-code",originPluginId:null,parentThreadId:null}]);
    expect((await collectSources(api,options)).sessionMetadata[0]).toMatchObject({sessionId:"t1",projectId:"p1",providerId:"claude-code",model:"historical-model",complete:true,firstSequence:3,lastSequence:3});
  });
  it("does not infer a historical model when a provider fallback occurred",async()=>{
    const api=sdk([row("turn/started",{},1),row("client/turn/requested",{requestId:"r",initiator:"user",execution:{model:"model-a"},input:[{type:"text",text:"Fix that"}]},2),row("turn/input/accepted",{clientRequestId:"r"},3),row("provider/modelFallback",{originalModel:"model-a",fallbackModel:"model-b",message:"SECRET"},4)]);
    expect((await collectSources(api,options)).sessionMetadata[0]).toMatchObject({model:null,complete:false,reasons:expect.arrayContaining(["model-fallback"])});
  });

});
