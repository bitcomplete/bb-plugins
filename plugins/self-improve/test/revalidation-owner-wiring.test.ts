import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { Store } from "../src/store.js";
import { defaultConfig } from "../src/config.js";
import { solution } from "./domain/fixtures.js";
import type { EditRevalidationDraft } from "../src/revalidation-edit-contract.js";
import type { RevalidationOwnerApi } from "../src/revalidation-owner.js";

async function fixture(){
  const selection={providerId:"codex",model:"owner-selected",projectId:"project",environmentId:"environment",permissionMode:"accept-edits" as const};
  const spawn=vi.fn(async()=>{throw new Error("No model dispatch is expected in an owner draft test");});
  const {bb,harness}=createFakePluginHost({pluginId:"self-improve",settings:{config:JSON.stringify({...defaultConfig(),...selection})},sdk:{
    environments:{get:async()=>({id:"environment",projectId:"project",status:"ready",hostLifecycle:"active",lifecycle:{phase:"active"}} as any)},
    system:{version:async()=>({currentVersion:"0.49.0",upgradeCommand:"unused"} as any)},threads:{spawn},
  }});
  await plugin(bb);const store=new Store(bb.storage.database());
  const content="Preserve each field of the original payload.",artifactDigest=createHash("sha256").update(content).digest("hex");
  store.put("solutions","solution",solution("solution"));store.put("native-evaluation-artifacts","artifact",{id:"artifact",solutionId:"solution",revision:"r1",kind:"instruction",content,artifactDigest});
  const input:EditRevalidationDraft={action:"create",requestId:"owner-intent",definition:{target:{solutionId:"solution",namespace:"native-evaluation-artifacts",artifactId:"artifact",revision:"r1",artifactDigest},mode:"challenge",concern:"Does it preserve whitespace?",claim:{id:"payload-preserved",text:"Keep payload fields",scope:"These prompt cases",originalEvidenceRefs:[],requiredEvidence:"exploratory"},comparator:"No additional instruction",workload:null,
    criteria:[{id:"primary",role:"primary",required:true,evaluator:"numeric-comparison-v1",metric:"Exact answer pass rate",unit:"proportion",statistic:"difference",threshold:{operator:"at-least",value:0},unsupportedReason:null}],sample:{minimumPairs:1,minimumExposure:null,exposureUnit:null},
    environment:{declaredNonsecret:true,dependencies:[],configuration:[],untested:["Package installation"],execution:selection},limits:{maxDurationMs:120000,maxCalls:2,maxCostMicros:null,currency:"USD",allowUnknownCost:true,moneyLimitMode:"observed-admission"}},
    workload:{schemaVersion:1,kind:"paired-exact-instruction-v1",description:"Whitespace preservation",cases:[{id:"case",familyId:"payload",input:"Return two leading spaces then field",expected:"  field"}],measurements:[{criterionId:"primary",kind:"exact-pass-rate"}],normalization:"none",baseline:"no-added-instruction",orderPolicy:"alternating-arms-v1",response:"json-output-string-v1"}};
  return {harness,store,input,spawn};
}
it("edits, freezes and queues the exact plan through public owner RPC with one durable retry identity",async()=>{
  const f=await fixture();try{
    const overview=await f.harness.behavior.callRpc("revalidationOverview",{solutionId:"solution"}) as ReturnType<RevalidationOwnerApi["overview"]>;
    expect(overview.artifacts[0]!.target).toEqual(f.input.definition.target);expect(overview.selection?.providerId).toBe("codex");
    const first=await f.harness.behavior.callRpc("editRevalidationDraft",f.input) as ReturnType<RevalidationOwnerApi["edit"]>;
    expect(await f.harness.behavior.callRpc("editRevalidationDraft",f.input)).toEqual(first);
    const frozen=await f.harness.behavior.callRpc("freezeRevalidation",{planId:first.plan.id,expectedVersion:1}) as Awaited<ReturnType<RevalidationOwnerApi["freeze"]>>;
    expect(frozen.artifact.content).toBe(overview.artifacts[0]!.content);expect(frozen.workload?.definition.cases[0]!.expected).toBe("  field");
    expect(frozen.observedEnvironment?.environment.id).toBe("environment");
    const request={planId:first.plan.id,version:1,requestId:"queue-intent"};
    const queued=await f.harness.behavior.callRpc("queueRevalidation",request) as ReturnType<RevalidationOwnerApi["queue"]>;
    expect(await f.harness.behavior.callRpc("queueRevalidation",request)).toEqual(queued);
    const jobs=f.store.db.prepare("SELECT input FROM jobs WHERE stage='builder'").all() as {input:string}[];
    expect(jobs.map(row=>JSON.parse(row.input))).toEqual([{kind:"revalidation",revalidationRunId:queued.run.id}]);
    const detail=await f.harness.behavior.callRpc("revalidationPlan",{planId:first.plan.id}) as ReturnType<RevalidationOwnerApi["detail"]>;
    expect(detail.results).toEqual([]);expect(detail.runs[0]!.verdict).toBeNull();expect(f.spawn).not.toHaveBeenCalled();
    expect(f.harness.inspection.registrations.services).toHaveLength(7);
  }finally{await f.harness.lifecycle.dispose();}
});
it("cancels queued owner work without making a result or reopening it on a lost-response retry",async()=>{
  const f=await fixture();try{
    const draft=await f.harness.behavior.callRpc("editRevalidationDraft",f.input) as ReturnType<RevalidationOwnerApi["edit"]>;
    await f.harness.behavior.callRpc("freezeRevalidation",{planId:draft.plan.id,expectedVersion:1});
    const request={planId:draft.plan.id,version:1,requestId:"queue-once"};
    const queued=await f.harness.behavior.callRpc("queueRevalidation",request) as ReturnType<RevalidationOwnerApi["queue"]>;
    const cancelled=await f.harness.behavior.callRpc("cancelRevalidation",{runId:queued.run.id,expectedVersion:f.store.version("revalidation-runs",queued.run.id),reason:"Revise the cases first"});
    expect(cancelled).toMatchObject({status:"cancelled",verdict:null});
    expect(await f.harness.behavior.callRpc("queueRevalidation",request)).toMatchObject({run:{status:"cancelled",verdict:null},jobId:null});
    expect(f.store.list("revalidation-results")).toEqual([]);expect(f.spawn).not.toHaveBeenCalled();
  }finally{await f.harness.lifecycle.dispose();}
});
