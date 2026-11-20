import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { DashboardData } from "../src/ui/types.js";

describe("plugin ledger persistence",()=>{
  it("creates an owner goal without observations and persists across reload",async()=>{
    const {bb,harness}=createFakePluginHost({pluginId:"self-improve"});
    try {
      await plugin(bb);
      const created=await harness.behavior.callRpc("createObjective",{requestId:"owner-objective",kind:"goal",title:"Fewer retries",description:"Reduce unnecessary tool retries",priority:"focus",metric:{name:"retries per task",unit:"retries",direction:"lower",target:1}}) as {id:string};
      const replacement=await harness.lifecycle.reload(plugin);
      try {
        const data=await replacement.harness.behavior.callRpc("dashboard",{}) as DashboardData;
        expect(data.problems[0].id).toBe(created.id);expect(data.votes).toEqual([]);expect(data.objectives?.[0].focus?.priority).toBe(5);
        expect(data.versions[`problems:${created.id}`]).toBeGreaterThan(0);
      }finally{await replacement.harness.lifecycle.dispose();}
    }finally{await harness.lifecycle.dispose();}
  });
});
