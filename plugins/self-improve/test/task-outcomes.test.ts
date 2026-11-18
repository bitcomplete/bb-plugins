import {describe,expect,it,vi} from "vitest";
import {collectSources,collectTaskOutcomes,type SourceSdk} from "../src/sources.js";
import {parseConfig} from "../src/config.js";
import type {TaskRun} from "../src/domain/types.js";

const now=Date.UTC(2026,10,18,12),since=now-86400000;
const source={pluginId:"task-history",method:"outcomes"};
const run=(id:string,outcome:TaskRun["outcome"]="failed"):TaskRun=>({taskId:"task-a",runId:id,day:"2026-11-18",occurredAtMs:now-100,outcome,originPluginId:null});
const page=(runs:TaskRun[],nextCursor:string|null=null,complete=true)=>({runs,nextCursor,complete});
const input={sinceMs:since,untilMs:now,limit:2,maxPages:5};
function sdk(pages:unknown[]):SourceSdk {
  let index=0;
  return {plugins:{callRpc:vi.fn(async(args:any)=>args.pluginId===source.pluginId?pages[index++]:args.method==="listTasks"?{tasks:[],nextCursor:null}:[])},
    threads:{list:async()=>[]},projects:{list:async()=>[]}} as unknown as SourceSdk;
}
describe("configured structured task outcome source",()=>{
  it("fetches every cursor page, excludes plugin-owned work and preserves terminal facts",async()=>{
    const api=sdk([page([run("failed"),{...run("self"),originPluginId:"self-improve"}],"next"),page([run("blocked","blocked")])]);
    const result=await collectTaskOutcomes(api,source,input);
    expect(result).toMatchObject({complete:true,runs:[run("failed"),run("blocked","blocked")],reason:null});
    expect(api.plugins.callRpc).toHaveBeenNthCalledWith(2,expect.objectContaining({pluginId:"task-history",method:"outcomes",input:{sinceMs:since,untilMs:now,limit:2,cursor:"next"}}));
  });
  it("reports pagination cycles and page limits while retaining only validated observations",async()=>{
    const result=await collectTaskOutcomes(sdk([page([run("a")],"one"),page([run("b")],"two"),page([run("c")],"one")]),source,input);
    expect(result.complete).toBe(false);expect(result.reason).toBe("task-history-cursor-cycle");expect(result.runs).toHaveLength(3);
    const limited=await collectTaskOutcomes(sdk([page([run("a")],"next")]),source,{...input,maxPages:1});
    expect(limited).toMatchObject({complete:false,reason:"task-history-page-limit",runs:[run("a")]});
  });
  it("rejects invalid timestamps, day claims, raw data and unsupported terminal guesses",async()=>{
    for(const invalid of [{...run("a"),day:"2026-11-17"},{...run("a"),occurredAtMs:now+1},{...run("a"),occurredAtMs:since-1},{...run("a"),rawTranscript:"SECRET"},{...run("a"),outcome:"idle"}]){
      const result=await collectTaskOutcomes(sdk([page([invalid as TaskRun])]),source,input);
      expect(result).toMatchObject({complete:false,runs:[],reason:"task-history-invalid-page"});expect(JSON.stringify(result)).not.toContain("SECRET");
    }
  });
  it("deduplicates identical runs but refuses conflicting versions of a terminal fact",async()=>{
    expect((await collectTaskOutcomes(sdk([page([run("a")],"next"),page([run("a")])]),source,input)).runs).toEqual([run("a")]);
    const result=await collectTaskOutcomes(sdk([page([run("a")],"next"),page([run("a","succeeded")])]),source,input);
    expect(result).toMatchObject({complete:false,runs:[run("a")],reason:"task-history-conflicting-run"});
  });
  it("preserves declared partial coverage and safely reports unavailable providers",async()=>{
    const partial=await collectTaskOutcomes(sdk([page([run("a")],null,false)]),source,input);
    expect(partial).toMatchObject({complete:false,runs:[run("a")],reason:"task-history-provider-partial"});
    const api=sdk([]);api.plugins.callRpc=vi.fn(async()=>{throw Error("SECRET provider message");});
    const unavailable=await collectTaskOutcomes(api,source,input);
    expect(unavailable).toMatchObject({complete:false,runs:[],reason:"task-history-rpc-unavailable"});expect(JSON.stringify(unavailable)).not.toContain("SECRET");
  });
  it("rejects invalid config and resource bounds before making requests",async()=>{
    const api=sdk([]);
    for(const bad of [{...input,untilMs:since-1},{...input,limit:0},{...input,maxPages:1001}])await expect(collectTaskOutcomes(api,source,bad)).rejects.toThrow();
    expect(()=>parseConfig(JSON.stringify({taskOutcomeSource:{pluginId:"self-improve",method:"outcomes"}}))).toThrow();
    expect(()=>parseConfig(JSON.stringify({taskOutcomeSource:{pluginId:"task-history",method:"outcomes",complete:true}}))).toThrow();
    expect(parseConfig(JSON.stringify({taskOutcomeSource:source})).taskOutcomeSource).toEqual(source);expect(api.plugins.callRpc).not.toHaveBeenCalled();
  });
  it("uses the configured public RPC and retains explicit injectable-source precedence",async()=>{
    const api=sdk([page([run("failed")])]);
    const result=await collectSources(api,{now,lookbackMs:86400000,readCursor:()=>null,redact:s=>s,taskOutcomeRpc:source});
    expect(result.taskRuns).toEqual([run("failed")]);expect(result.coverage.find(c=>c.source==="task-outcomes")).toMatchObject({complete:true,reason:null});
    const injected=await collectSources(sdk([]),{now,lookbackMs:86400000,readCursor:()=>null,redact:s=>s,taskOutcomeRpc:source,taskOutcomeSource:async()=>({runs:[run("injected","blocked")],complete:true})});
    expect(injected.taskRuns).toEqual([run("injected","blocked")]);
  });
  it("respects cancellation and bounds response page sizes",async()=>{
    const controller=new AbortController();controller.abort();const api=sdk([]);
    await expect(collectTaskOutcomes(api,source,{...input,signal:controller.signal})).rejects.toThrow();expect(api.plugins.callRpc).not.toHaveBeenCalled();
    const large=await collectTaskOutcomes(sdk([page([run("a"),run("b"),run("c")])]),source,input);
    expect(large).toMatchObject({complete:false,runs:[],reason:"task-history-invalid-page"});
  });
});
