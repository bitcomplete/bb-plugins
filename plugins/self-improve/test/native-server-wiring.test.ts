import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { dataDirectory } from "../src/exports.js";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { defaultConfig } from "../src/config.js";
import type { DashboardData } from "../src/ui/types.js";

describe("BB-native server wiring", () => {
  it("keeps startup and owner ledgers available before execution is configured", async () => {
    const {bb,harness}=createFakePluginHost({pluginId:"self-improve"});
    try {
      await plugin(bb);
      const data=await harness.behavior.callRpc("dashboard",{}) as DashboardData;
      expect(data.health.issues).toContain("Choose a BB provider");
      expect(data.costs.activity).toMatchObject({nativeTasks:0,chatConversations:0,totals:[]});
      expect(harness.inspection.registrations.services.map(service=>service.name).sort()).toEqual(["builder","inventor","miner","problem-ranker","scout","solution-ranker","verifier"]);
      const result=await harness.behavior.callRpc("createObjective",{requestId:"owner-objective",kind:"problem",title:"Keep useful history",description:"Retries should preserve the original request",priority:"normal"});
      expect(result).toHaveProperty("id");
      expect((await harness.behavior.runCli(["doctor"])).exitCode).toBe(0);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("saves a coherent host picker selection without replacing unrelated configuration",async()=>{
    const config={...defaultConfig(),providerId:"codex",model:"original",projectId:"project",environmentId:"environment",concurrency:7};
    const {bb,harness}=createFakePluginHost({pluginId:"self-improve",settings:{config:JSON.stringify(config)}});
    try {
      await plugin(bb);
      const initial=await harness.behavior.callRpc("getExecution",{}) as {revision:string};
      const selection={providerId:"claude-code",model:"chosen-model",permissionMode:"auto",reasoningLevel:"high",projectId:"project",environmentId:"environment"};
      const saved=await harness.behavior.callRpc("setExecution",{expectedRevision:initial.revision,selection});
      expect(saved).toMatchObject({selection:{providerId:"claude-code",model:"chosen-model",reasoningLevel:"high"},permissionMode:"auto"});
      const publicConfig=JSON.parse((await harness.behavior.runCli(["config"])).stdout!);expect(publicConfig.concurrency).toBe(7);
      await expect(harness.behavior.callRpc("setExecution",{expectedRevision:initial.revision,selection:{...selection,model:"stale"}})).rejects.toThrow("Configuration changed");
      expect((await harness.behavior.callRpc("getExecution",{}))).toMatchObject({selection:{model:"chosen-model"}});
    } finally {await harness.lifecycle.dispose();}
  });

  it.each(["codex","claude-code"])("opens scoped native chat and accounts its admission through %s", async providerId => {
    const config={...defaultConfig(),providerId,model:"owner-selected",projectId:"project",environmentId:"environment",budgets:{...defaultConfig().budgets,allowUnknown:true}};
    const threads=new Map<string,ReturnType<typeof makeThreadResponse>>(),metadata=new Map<string,Record<string,unknown>>();
    const events:any[]=[];
    let dispatch: ReturnType<typeof createFakePluginHost>["harness"]["inspection"]["registrations"]["hooks"]["message.dispatch"];
    const spawn=vi.fn(async(input:any)=>{
      const thread=makeThreadResponse({id:`native-${threads.size+1}`,originPluginId:"self-improve",projectId:input.projectId,environmentId:input.environment.environmentId,providerId:input.providerId});
      threads.set(thread.id,thread);metadata.set(thread.id,input.pluginMetadata);
      const decision=await dispatch!(makeMessageDispatchHookContext({thread,originPluginId:"self-improve",initiator:"agent",senderThreadId:null,input:{text:input.prompt,blocks:[{type:"text",text:input.prompt,mentions:[]}]},requestedExecution:{providerId:input.providerId,model:input.model,permissionMode:input.permissionMode,reasoningLevel:input.reasoningLevel??null,serviceTier:input.serviceTier??null}}));
      expect(decision.action).toBe("proceed");return thread;
    });
    const {bb,harness}=createFakePluginHost({pluginId:"self-improve",settings:{config:JSON.stringify(config)},sdk:{threads:{spawn,get:async({threadId})=>threads.get(threadId)!,getPluginMetadata:async({threadId})=>metadata.get(threadId)??{},list:async()=>[],events:{list:async({types,afterSeq,limit})=>events.filter(row=>types?.includes(row.type)&&row.seq>Number(afterSeq??-1)).slice(0,Number(limit??100))}}}});
    try {
      await plugin(bb);dispatch=harness.inspection.registrations.hooks["message.dispatch"];
      const created=await harness.behavior.callRpc("createObjective",{requestId:"owner-objective",kind:"problem",title:"Retry behavior",description:"Inspect retry history",priority:"normal"}) as {id:string};
      const chat=await harness.behavior.callRpc("startChat",{kind:"problem",id:created.id,projectId:"project"}) as {threadId:string};
      expect(spawn).toHaveBeenCalledTimes(1);expect(spawn.mock.calls[0]![0]).toMatchObject({providerId,model:"owner-selected",permissionMode:"accept-edits",environment:{type:"reuse",environmentId:"environment"}});
      await harness.behavior.callAgentTool("self_improve_edit",{kind:"problem",id:created.id,expectedVersion:1,label:"retries",reason:"Clarify the problem category"},{threadId:chat.threadId});
      const data=await harness.behavior.callRpc("dashboard",{}) as DashboardData;
      expect(data.problems[0]!.category).toBe("retries");
      expect(data.costs.activity).toMatchObject({chatConversations:1,unknownBillingActivities:1,unknownCurrencyActivities:1,totals:[]});
      const costs=JSON.parse((await harness.behavior.runCli(["costs"])).stdout!);
      expect(costs.calls.initialChatAdmissions).toBe(1);expect(costs.legacy.events).toEqual([]);
      expect(costs.chats[0]).toMatchObject({providerId,model:"owner-selected",billingCompleteness:"unknown"});
      await harness.behavior.runSchedule("native-execution-reconciliation");
      const signals=harness.inspection.realtimeSignals.length;
      events.push({id:"late-cost",seq:1,type:"thread/contextWindowUsage/updated",threadId:chat.threadId,createdAt:Date.now(),scope:{kind:"thread"},data:{providerThreadId:"provider-session",contextWindowUsage:{cost:{amount:2,currency:"USD"}}}});
      await harness.behavior.runSchedule("native-execution-reconciliation");
      expect(harness.inspection.realtimeSignals.length).toBeGreaterThan(signals);
      const refreshed=await harness.behavior.callRpc("dashboard",{}) as DashboardData;
      expect(refreshed.costs.activity?.totals).toEqual([{currency:"USD",observedSessionFloorMicros:2_000_000}]);
      const directory=dataDirectory(new Store(bb.storage.database()));
      await vi.waitFor(async()=>expect(JSON.parse(await readFile(join(directory,"activity-costs.json"),"utf8")).totals[0].sharedNativeAndChatObservedFloorMicros).toBe(2_000_000));
    } finally { await harness.lifecycle.dispose(); }
  });
});
