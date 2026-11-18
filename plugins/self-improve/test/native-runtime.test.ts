import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Store, MIGRATIONS } from "../src/store.js";
import { Runtime, type SolutionAssessment } from "../src/runtime.js";
import { defaultConfig } from "../src/config.js";
import { Accounting } from "../src/costs.js";
import { reviewRevisits } from "../src/revisit.js";
import type { NativeExecution, NativeTaskReceipt, NativeTaskRequest } from "../src/native-tasks.js";
import type { StageContext } from "../src/services.js";
import type { Solution } from "../src/domain/types.js";
import { stableId } from "../src/domain/shared.js";
import { NOW, problem, solution, vote } from "./domain/fixtures.js";
const dbs: Database.Database[]=[];
beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(NOW);});
afterEach(()=>{dbs.splice(0).forEach(db=>db.close());vi.useRealTimers();vi.restoreAllMocks();});
function context(stage:StageContext["job"]["stage"],runId="first-run",jobId:string=stage):StageContext {
  return {job:{id:jobId,runId,stage,key:jobId,input:{},attempts:1,createdAt:NOW},signal:new AbortController().signal,boot:"boot"};
}
const scores=()=>({scores:solution().scores,reasons:solution().scoreReasons});
function receipt(request:NativeTaskRequest,value:unknown):NativeTaskReceipt {
  return {taskId:request.id,runId:request.runId,stage:request.stage,solutionId:request.solutionId,providerId:request.execution.providerId,model:request.execution.model,
    threadId:`thread-${request.id}`,requestId:`request-${request.id}`,turnId:`turn-${request.id}`,text:JSON.stringify(value),
    promptHash:createHash("sha256").update(request.instructions+request.input).digest("hex"),startedAtMs:NOW,endedAtMs:NOW,modelIdentitySource:"requested-selection"};
}
function setup(providerId="codex") {
  const db=new Database(":memory:");dbs.push(db);MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
  const config={...defaultConfig(),providerId,model:"selected",projectId:"project",environmentId:"environment"};
  const execution:NativeExecution={providerId,model:"selected",projectId:"project",environment:{type:"reuse",environmentId:"environment"},permissionMode:"accept-edits"};
  const privacy={clientNames:["PrivateClient"]};let generation="privacy-v1";
  const execute=vi.fn(async(request:NativeTaskRequest)=>receipt(request,request.stage==="inventor"?[]:scores()));
  const build=vi.fn(async(_ctx:StageContext,_candidate:Solution,_retest:boolean)=>({built:1}));
  const runtime=new Runtime({bb:{sdk:{}} as BbPluginApi,store,config:()=>config,privacy:()=>privacy,runner:{execute},execution:()=>execution,privacyGeneration:()=>generation,
    accounting:new Accounting(store,()=>config.budgets),workers:()=>({owns:()=>false,analyze:async()=>({failures:[]})}),build});
  vi.spyOn(runtime.arxiv,"search").mockResolvedValue([]);
  store.put("problems","p-a",problem());store.put("votes","v",vote());
  const candidate=solution();candidate.title="PrivateClient retry improvement";candidate.scores={fit:null,benefit:null,testability:null,feasibility:null,safety:null,effort:null};store.put("solutions",candidate.id,candidate);
  return {store,runtime,config,execution,privacy,execute,candidate,build,setGeneration:(value:string)=>{generation=value;}};
}
async function prepare(f:ReturnType<typeof setup>) {
  await f.runtime.handlers["problem-ranker"](context("problem-ranker"));
  await f.runtime.handlers.scout(context("scout"));
  await f.runtime.handlers.inventor(context("inventor"));
  f.execute.mockClear();
}
describe("native runtime integration",()=>{
  it("pins builder retries to the original native attempt after ranking changes",async()=>{
    const f=setup(),other=solution("other");f.store.put("solutions",other.id,other);
    f.store.put("solution-ranking","latest",[{solutionId:other.id,eligible:true}]);
    f.store.put("native-evaluation-attempts",stableId("native-build-attempt","builder"),{solutionId:f.candidate.id});
    await f.runtime.handlers.builder(context("builder"));
    expect(f.build.mock.calls[0]?.[1]).toEqual(f.candidate);
    const changed=context("builder");changed.job.input.solutionId=other.id;
    await expect(f.runtime.handlers.builder(changed)).rejects.toThrow("builder-job-candidate-changed");
    expect(f.build).toHaveBeenCalledTimes(1);
  });
  it("advances past a completed exploratory build in a stale ranking",async()=>{
    const f=setup(),built={...f.candidate,candidateState:"built" as const},next=solution("next");
    f.store.put("solutions",built.id,built);f.store.put("solutions",next.id,next);
    f.store.put("solution-ranking","latest",[{solutionId:built.id,eligible:true},{solutionId:next.id,eligible:true}]);
    await f.runtime.handlers.builder(context("builder"));
    expect(f.build.mock.calls[0]?.[1]).toEqual(next);
  });
  it.each(["codex","claude-code"])("runs native research and ranking with %s identities",async providerId=>{
    const f=setup(providerId);await prepare(f);
    await f.runtime.handlers["solution-ranker"](context("solution-ranker"));
    const request=f.execute.mock.calls[0][0];
    expect(request.execution.providerId).toBe(providerId);expect(request.input).not.toContain("PrivateClient");
    expect(f.store.get<Solution>("solutions",f.candidate.id)?.scores).toEqual(scores().scores);
    const record=f.store.list<SolutionAssessment>("solution-assessments")[0];
    expect(record).toMatchObject({runId:"first-run",taskId:request.id,threadId:`thread-${request.id}`,turnId:`turn-${request.id}`,requestId:`request-${request.id}`,model:{provider:providerId,model:"selected"},modelIdentitySource:"requested-selection",disposition:"applied"});
    expect(record).not.toHaveProperty("accountId");expect(JSON.stringify(record)).not.toContain(f.candidate.mechanism);
    await f.runtime.handlers["solution-ranker"](context("solution-ranker","later-run"));expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("keeps legacy research results separate from native completion and preserves native receipts",async()=>{
    const f=setup();await f.runtime.handlers["problem-ranker"](context("problem-ranker"));
    const id=f.store.get<string>("snapshot","latest")!;
    for(const stage of ["scout","inventor"])f.store.put("research-results",`${id}:${stage}`,{counts:{candidates:999}});
    await expect(f.runtime.handlers["solution-ranker"](context("solution-ranker"))).rejects.toThrow("awaiting-scout-snapshot");
    const result=await f.runtime.handlers.inventor(context("inventor","native-research-run"));expect(result.candidates).toBe(0);
    expect(f.store.get("research-results",`${id}:inventor`)).toEqual({counts:{candidates:999}});
    expect(f.store.get("research-results",`native-v1:${id}:inventor`)).toMatchObject({nativeBinding:{execution:{providerId:"codex"}},receipts:[{runId:"native-research-run"}]});
    expect(f.store.list("native-research-receipts")).toHaveLength(1);
    await f.runtime.handlers.inventor(context("inventor","retry"));expect(f.execute).toHaveBeenCalledTimes(1);
    f.setGeneration("privacy-v2");await expect(f.runtime.handlers.inventor(context("inventor"))).rejects.toThrow("research-input-changed-new-snapshot-required");
  });
  it("recovers the first ranker request after failure without rebinding its run ID",async()=>{
    const f=setup();await prepare(f);
    f.execute.mockRejectedValueOnce(Error("interrupted native read"));
    await expect(f.runtime.handlers["solution-ranker"](context("solution-ranker"))).rejects.toThrow("interrupted native read");
    const first=structuredClone(f.execute.mock.calls[0][0]);
    await f.runtime.handlers["solution-ranker"](context("solution-ranker","new-run-id"));
    expect(f.execute.mock.calls[1][0]).toEqual(first);
    expect(f.store.list<SolutionAssessment>("solution-assessments")[0].runId).toBe("first-run");
  });
  it("keeps the claimed research snapshot after latest advances during a partial failure",async()=>{
    const f=setup();await f.runtime.handlers["problem-ranker"](context("problem-ranker"));
    const oldId=f.store.get<string>("snapshot","latest")!;
    const original=f.store.get<Record<string,unknown>>("problem-snapshots",oldId)!;
    const p2=problem("p-b","Another failure mode");f.store.put("problems",p2.id,p2);
    f.store.put("problem-snapshots",oldId,{...original,problems:[problem(),p2]});
    let calls=0;f.execute.mockImplementation(async request=>{if(++calls===2)throw Error("second operation interrupted");return receipt(request,[]);});
    await expect(f.runtime.handlers.inventor(context("inventor"))).rejects.toThrow("second operation interrupted");
    const failedRequest=structuredClone(f.execute.mock.calls[1][0]);
    f.store.put("problem-snapshots","new-snapshot",{...original,id:"new-snapshot",problems:[problem("new-problem")]});f.store.put("snapshot","latest","new-snapshot");
    const result=await f.runtime.handlers.inventor(context("inventor","retry"));
    expect(result).toMatchObject({problems:2,taskRequests:1,cacheHits:1});
    expect(f.execute.mock.calls[2][0]).toEqual(failedRequest);
    expect(f.store.get("native-job-snapshots","inventor")).toMatchObject({snapshotId:oldId});
    expect(f.store.get("research-results",`native-v1:${oldId}:inventor`)).not.toBeNull();
    expect(f.store.get("research-results","native-v1:new-snapshot:inventor")).toBeNull();
  });
  it("keeps a ranker's claimed snapshot on retry and refuses changed explicit job input",async()=>{
    const f=setup();await prepare(f);const oldId=f.store.get<string>("snapshot","latest")!;
    f.execute.mockRejectedValueOnce(Error("native read interrupted"));
    await expect(f.runtime.handlers["solution-ranker"](context("solution-ranker"))).rejects.toThrow("native read interrupted");
    const first=structuredClone(f.execute.mock.calls[0][0]),original=f.store.get<Record<string,unknown>>("problem-snapshots",oldId)!;
    f.store.put("problem-snapshots","new-snapshot",{...original,id:"new-snapshot"});f.store.put("snapshot","latest","new-snapshot");
    await f.runtime.handlers["solution-ranker"](context("solution-ranker","retry"));
    expect(f.execute.mock.calls[1][0]).toEqual(first);
    expect(f.store.list<SolutionAssessment>("solution-assessments")[0].snapshotId).toBe(oldId);
    const changed=context("solution-ranker","third");changed.job.input.snapshotId="new-snapshot";
    await expect(f.runtime.handlers["solution-ranker"](changed)).rejects.toThrow("job-snapshot-input-changed");
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it("retains a paid stale receipt and refuses changed-input rebinding within the same job",async()=>{
    const f=setup();await prepare(f);
    f.execute.mockImplementationOnce(async request=>{
      const current=f.store.get<Solution>("solutions",f.candidate.id)!;
      f.store.put("solutions",current.id,{...current,testPlan:"Owner revised the test"});return receipt(request,scores());
    });
    await expect(f.runtime.handlers["solution-ranker"](context("solution-ranker"))).rejects.toThrow("ranking-input-changed");
    expect(f.store.get<Solution>("solutions",f.candidate.id)?.scores.fit).toBeNull();
    expect(f.store.list<SolutionAssessment>("solution-assessments")[0].disposition).toBe("stale");
    await expect(f.runtime.handlers["solution-ranker"](context("solution-ranker","retry"))).rejects.toThrow("ranking-input-changed-new-job-required");
    expect(f.execute).toHaveBeenCalledTimes(1);
    await f.runtime.handlers["solution-ranker"](context("solution-ranker","new-run","explicit-new-job"));
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.store.list<SolutionAssessment>("solution-assessments").map(row=>row.disposition).sort()).toEqual(["applied","stale"]);
  });
  it("refuses an obsolete reply after privacy or execution changes",async()=>{
    for(const change of ["privacy","execution"]){
      const f=setup();await prepare(f);
      f.execute.mockImplementationOnce(async request=>{if(change==="privacy")f.setGeneration("privacy-v2");else f.execution.model="new-model";return receipt(request,scores());});
      await expect(f.runtime.handlers["solution-ranker"](context("solution-ranker"))).rejects.toThrow("ranking-input-changed");
      expect(f.store.get<Solution>("solutions",f.candidate.id)?.scores.fit).toBeNull();
      expect(f.store.list<SolutionAssessment>("solution-assessments")[0].disposition).toBe("stale");
    }
  });
  it("does not re-dispatch an invalid completed assessment on automatic retry",async()=>{
    const f=setup();await prepare(f);
    f.execute.mockImplementationOnce(async request=>receipt(request,{...scores(),scores:{...scores().scores,fit:2}}));
    await expect(f.runtime.handlers["solution-ranker"](context("solution-ranker"))).rejects.toThrow();
    await expect(f.runtime.handlers["solution-ranker"](context("solution-ranker","retry"))).rejects.toThrow("native-ranking-invalid-new-job-required");
    expect(f.execute).toHaveBeenCalledTimes(1);expect(f.store.list<SolutionAssessment>("solution-assessments")[0].disposition).toBe("invalid");
  });
  it("keeps deterministic problem ranking available without configured native execution",async()=>{
    const f=setup();f.execution.providerId="";
    expect(await f.runtime.handlers["problem-ranker"](context("problem-ranker"))).toMatchObject({problems:1});
    expect(f.execute).not.toHaveBeenCalled();
    await expect(f.runtime.handlers.inventor(context("inventor"))).rejects.toThrow("configure-native-execution");
  });
  it("keeps a completed native revisit reviewed when the verifier runs again",async()=>{
    const f=setup(),active={...f.candidate,status:"active" as const,candidateState:"built" as const,validatedWith:{provider:"claude-code",model:"selected"}};
    f.store.put("solutions",active.id,active);
    f.store.put("validated-artifacts",active.id,{solutionId:active.id,revision:"r1",kind:"instruction",content:"Keep the original payload",artifactDigest:"b".repeat(64),evaluationId:"proof-old",wiringLocation:"instruction",activatedAtMs:NOW});
    await f.runtime.handlers.verifier(context("verifier"));expect(f.store.list("revisit-queue")).toHaveLength(1);
    f.execute.mockImplementation(async request=>receipt(request,{decision:"retain",reason:"Retest the unchanged artifact on the selected provider"}));
    const options={store:f.store,accounting:f.runtime.options.accounting,runner:{execute:f.execute},execution:f.execution,runId:"revisit-run",privacyGeneration:f.runtime.options.privacyGeneration(),currentPrivacyGeneration:f.runtime.options.privacyGeneration,privacy:f.privacy,signal:new AbortController().signal};
    expect(await reviewRevisits(options)).toMatchObject({revisited:1,retests:1});
    const reviewed=f.store.list("revisit-queue");expect(reviewed).toEqual([expect.objectContaining({status:"reviewed",reviewId:expect.any(String)})]);
    await f.runtime.handlers.verifier(context("verifier","later"));expect(f.store.list("revisit-queue")).toEqual(reviewed);
    expect(await reviewRevisits({...options,runId:"again"})).toMatchObject({revisited:0,retests:0});expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.store.pending()).toHaveLength(1);
  });
  it("uses the selected BB provider for revalidation decisions without changing adoption",async()=>{
    const f=setup();const active={...f.candidate,status:"active" as const,candidateState:"built" as const,validatedWith:{provider:"claude-code",model:"selected"}};
    f.store.put("solutions",active.id,active);await f.runtime.handlers.verifier(context("verifier"));
    expect(f.store.list("revisit-queue")).toEqual([expect.objectContaining({solutionId:active.id,to:{provider:"codex",model:"selected"}})]);
    expect(f.store.get<Solution>("solutions",active.id)?.status).toBe("active");expect(f.execute).not.toHaveBeenCalled();
  });
});
