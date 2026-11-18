import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewRevisits, type RevisitOptions } from "../src/revisit.js";
import type { NativeExecution, NativeTaskReceipt, NativeTaskRequest } from "../src/native-tasks.js";
import { MIGRATIONS, Store } from "../src/store.js";
import { solution, problem, NOW } from "./domain/fixtures.js";

const dbs:Database.Database[]=[];afterEach(()=>{for(const db of dbs.splice(0))db.close();});
const execution:NativeExecution={projectId:"project",environment:{type:"reuse",environmentId:"environment"},providerId:"codex",model:"new",permissionMode:"accept-edits"};
function receipt(request:NativeTaskRequest,decision="retain"):NativeTaskReceipt {
  return {taskId:request.id,stage:request.stage,runId:request.runId,solutionId:request.solutionId,providerId:request.execution.providerId,model:request.execution.model,
    threadId:"thread",requestId:"request",turnId:"turn",text:JSON.stringify({decision,reason:"This remains a hypothesis pending evaluation."}),promptHash:"a".repeat(64),startedAtMs:NOW,endedAtMs:NOW+1,modelIdentitySource:"requested-selection"};
}
function setup(){
  const db=new Database(":memory:");dbs.push(db);MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
  const s=solution();s.status="active";s.validatedWith={provider:"old-provider",model:"old-model"};store.put("solutions",s.id,s);store.put("problems","p-a",problem());
  const artifact={solutionId:s.id,revision:"revision",content:"Check the original failure before retrying",kind:"instruction",artifactDigest:"b".repeat(64),evaluationId:"old-proof",wiringLocation:"instruction",activatedAtMs:NOW};store.put("validated-artifacts",s.id,artifact);
  store.put("trusted-evaluations","old-proof",{status:"passed",model:s.validatedWith});
  const execute=vi.fn(async(request:NativeTaskRequest)=>receipt(request));
  const options:RevisitOptions={store,runner:{execute},execution,runId:"run-one",privacyGeneration:"privacy-one",currentPrivacyGeneration:()=>"privacy-one",signal:new AbortController().signal,accounting:{forSolution:()=>({totals:[]})},now:()=>NOW+2};
  return {store,s,artifact,execute,options};
}
describe("BB-native revisit recommendations",()=>{
  it.each(["codex","claude-code"])("uses %s via BB and queues retesting without replacing earlier proof",async providerId=>{
    const {store,s,options,execute}=setup();const selected={...options,execution:{...execution,providerId}};
    expect(await reviewRevisits(selected)).toEqual({revisited:1,retests:1,removalDecisions:0});
    expect(await reviewRevisits(selected)).toEqual({revisited:0,retests:0,removalDecisions:0});
    expect(execute).toHaveBeenCalledTimes(1);expect(execute.mock.calls[0]![0].execution.providerId).toBe(providerId);
    expect(store.get("solutions",s.id)).toMatchObject({validatedWith:s.validatedWith,status:"active"});
    expect(store.get("trusted-evaluations","old-proof")).toEqual({status:"passed",model:s.validatedWith});
    expect(store.list("revisit-reviews")).toMatchObject([{to:{provider:providerId,model:"new"},runId:"run-one",threadId:"thread"}]);
    expect(store.pending()).toHaveLength(1);
  });
  it("claims stable task/run ownership before dispatch and retains it through a job retry",async()=>{
    const {store,options,execute}=setup();execute.mockImplementationOnce(async request=>{
      expect(store.list("native-revisit-bindings")).toMatchObject([{taskId:request.id,runId:"run-one"}]);throw new Error("interrupted");
    });
    await expect(reviewRevisits(options)).rejects.toThrow("interrupted");await reviewRevisits({...options,runId:"run-two"});
    expect(execute.mock.calls.map(([request])=>request.runId)).toEqual(["run-one","run-one"]);
    expect(execute.mock.calls[0]![0].id).toBe(execute.mock.calls[1]![0].id);
  });
  it("does not reuse native reviews across permission changes or overwrite legacy reviews",async()=>{
    const {store,options,execute}=setup();const old={id:"legacy",reason:"Historical review"};store.put("revisit-reviews","legacy",old);
    await reviewRevisits(options);await reviewRevisits({...options,execution:{...execution,permissionMode:"full"}});
    expect(execute).toHaveBeenCalledTimes(2);expect(execute.mock.calls[0]![0].id).not.toBe(execute.mock.calls[1]![0].id);
    expect(store.get("revisit-reviews","legacy")).toEqual(old);
  });
  it("rejects stale output after solution content changes during review",async()=>{
    const {store,s,options,execute}=setup();execute.mockImplementationOnce(async request=>{
      store.put("solutions",s.id,{...s,mechanism:"A new mechanism requires a new review"});return receipt(request);
    });
    await expect(reviewRevisits(options)).rejects.toThrow("revisit-input-changed");
    expect(store.list("revisit-reviews")).toEqual([]);expect(store.pending()).toEqual([]);
    const first=execute.mock.calls[0]![0];
    expect(store.get("native-revisit-bindings",first.id)).toMatchObject({status:"stale",runId:"run-one"});
    expect(store.get("native-revisit-receipts",first.id)).toMatchObject({taskId:first.id,runId:"run-one"});
    expect(await reviewRevisits({...options,runId:"next"})).toMatchObject({revisited:1,retests:1});
    expect(execute).toHaveBeenCalledTimes(2);expect(execute.mock.calls[1]![0].id).not.toBe(first.id);
    expect(execute.mock.calls[1]![0].runId).toBe("next");
    expect(store.get("native-revisit-bindings",first.id)).toMatchObject({status:"stale",runId:"run-one"});
    expect(await reviewRevisits({...options,runId:"after-retain"})).toMatchObject({revisited:0,retests:0});expect(execute).toHaveBeenCalledTimes(2);
  });
  it("does not revive a retired task when source content is reverted",async()=>{
    const {store,s,options,execute}=setup();execute.mockImplementationOnce(async request=>{
      store.put("solutions",s.id,{...s,mechanism:"Temporary changed mechanism"});return receipt(request);
    });
    await expect(reviewRevisits(options)).rejects.toThrow("revisit-input-changed");
    const retired=execute.mock.calls[0]![0].id;store.put("solutions",s.id,s);
    expect(await reviewRevisits({...options,runId:"after-revert"})).toMatchObject({revisited:1,retests:1});
    expect(execute.mock.calls[1]![0].id).not.toBe(retired);
    expect(store.get("native-revisit-bindings",retired)).toMatchObject({status:"stale",runId:"run-one"});
    expect(await reviewRevisits({...options,runId:"after-retain"})).toMatchObject({revisited:0,retests:0});expect(execute).toHaveBeenCalledTimes(2);
  });
  it("starts a new review generation after linked problem input changes",async()=>{
    const {store,options,execute}=setup();execute.mockImplementationOnce(async request=>{
      const current=store.get<ReturnType<typeof problem>>("problems","p-a")!;
      store.put("problems","p-a",{...current,causes:current.causes.map(cause=>({...cause,text:"New owner diagnosis"}))});return receipt(request);
    });
    await expect(reviewRevisits(options)).rejects.toThrow("revisit-input-changed");
    expect(await reviewRevisits({...options,runId:"new-context"})).toMatchObject({revisited:1,retests:1});
    expect(execute.mock.calls[1]![0].id).not.toBe(execute.mock.calls[0]![0].id);
    expect(execute.mock.calls[1]![0].input).toContain("New owner diagnosis");
    expect(store.list("native-revisit-receipts")).toHaveLength(2);
  });
  it("does not apply a reply after privacy generation changes",async()=>{
    const {options,execute,store}=setup();let generation="privacy-one";
    execute.mockImplementationOnce(async request=>{generation="privacy-two";return receipt(request);});
    await expect(reviewRevisits({...options,currentPrivacyGeneration:()=>generation})).rejects.toThrow("revisit-privacy-changed");
    expect(store.list("revisit-reviews")).toEqual([]);expect(store.pending()).toEqual([]);
  });
  it("keeps removal as a recommendation and preserves the exact artifact",async()=>{
    const {store,s,artifact,options,execute}=setup();execute.mockImplementation(async request=>receipt(request,"remove"));
    expect(await reviewRevisits(options)).toEqual({revisited:1,retests:0,removalDecisions:1});
    expect(store.get("solutions",s.id)).toMatchObject({status:"fixing",validatedWith:s.validatedWith});
    expect(store.get("validated-artifacts",s.id)).toEqual(artifact);expect(store.audit()).toEqual([]);
  });
});
