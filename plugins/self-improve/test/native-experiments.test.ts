import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWordingGenerator, preregisterStudy, runWordingPair, type MinedStudyEvidence, type WordingPairOptions } from "../src/experiments.js";
import type { NativeExecution, NativeTaskReceipt, NativeTaskRequest, TaskRunner } from "../src/native-tasks.js";
import { MIGRATIONS, Store } from "../src/store.js";
import { DAY, NOW, problem, vote } from "./domain/fixtures.js";

const dbs:Database.Database[]=[];afterEach(()=>{for(const db of dbs.splice(0))db.close();});
const execution:NativeExecution={projectId:"project",environment:{type:"reuse",environmentId:"environment"},providerId:"codex",model:"selected-model",permissionMode:"accept-edits"};
const wordings={abstract:"Preserve request state during retries.",concrete:"Keep the original payload when a tool call retries."};
function receipt(request:NativeTaskRequest,value:unknown=wordings):NativeTaskReceipt {
  return {taskId:request.id,stage:request.stage,runId:request.runId,solutionId:request.solutionId,providerId:request.execution.providerId,model:request.execution.model,
    threadId:"thread",requestId:"request",turnId:"turn",text:JSON.stringify(value),promptHash:"a".repeat(64),startedAtMs:NOW,endedAtMs:NOW+1,modelIdentitySource:"requested-selection"};
}
function setup(){
  const db=new Database(":memory:");dbs.push(db);MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
  const execute=vi.fn(async(request:NativeTaskRequest)=>receipt(request));const runner:TaskRunner={execute};
  const options={store,runner,execution,experimentId:"study",runId:"run-one",privacyGeneration:"privacy-one",currentPrivacyGeneration:()=>"privacy-one",signal:new AbortController().signal};
  const evidence:MinedStudyEvidence={problemId:"problem",voteIds:["vote"],causes:["Retries may replace request state"],symptoms:["A retry loses the payload"],observations:[{id:"vote",kind:"tool_error",evidence:{kind:"thread",threadId:"private-thread",sessionId:"private-session",turnIndex:1,eventId:"event"},occurredAtMs:NOW}]};
  return {store,execute,options,evidence};
}
function pairSetup(){
  const f=setup();f.store.put("problems","p-a",problem());f.store.put("votes","v-one",vote({occurredAtMs:NOW-DAY,day:"2026-11-17"}));
  preregisterStudy(f.store,{id:"study",startsAtMs:NOW+DAY,endsAtMs:NOW+15*DAY,sampleSize:2,seed:"fixed"},{kind:"owner",id:"owner"},NOW);
  const research=vi.fn(async()=>({candidates:[],papers:[]}));
  const options:WordingPairOptions={...f.options,problemId:"p-a",voteIds:["v-one"],generate:createWordingGenerator(f.options),research,now:()=>NOW+2*DAY};
  return {...f,options,research};
}
describe("BB-native paired wording experiments",()=>{
  it.each(["codex","claude-code"])("uses the same %s native path with only the shared evidence projection",async providerId=>{
    const {options,evidence,execute}=setup();
    expect(await createWordingGenerator({...options,execution:{...execution,providerId}})(evidence)).toEqual(wordings);
    const request=execute.mock.calls[0]![0];expect(request.execution.providerId).toBe(providerId);
    expect(JSON.parse(request.input)).toEqual({causes:evidence.causes,symptoms:evidence.symptoms,observations:[{kind:"tool_error"}]});
    expect(request.input).not.toContain("private-thread");expect(request.instructions).toContain("ordinary BB context and tools may remain");
    expect(request).not.toHaveProperty("max_tokens");expect(request).not.toHaveProperty("messages");
  });
  it("persists the first task/run binding before dispatch and reuses it after interrupted attempts",async()=>{
    const {options,evidence,execute,store}=setup();
    execute.mockImplementationOnce(async(request)=>{
      expect(store.list("native-wording-checkpoints")).toMatchObject([{taskId:request.id,runId:"run-one",wordings:null}]);
      throw new Error("interrupted");
    });
    await expect(createWordingGenerator(options)(evidence)).rejects.toThrow("interrupted");
    await createWordingGenerator({...options,runId:"run-two"})(evidence);
    expect(execute.mock.calls.map(([request])=>request.runId)).toEqual(["run-one","run-one"]);
    expect(execute.mock.calls[0]![0].id).toBe(execute.mock.calls[1]![0].id);
    await createWordingGenerator({...options,runId:"run-three"})(evidence);expect(execute).toHaveBeenCalledTimes(2);
  });
  it("refuses changed evidence, provider options or privacy before consuming a prior result",async()=>{
    const {options,evidence,execute}=setup();await createWordingGenerator(options)(evidence);
    await expect(createWordingGenerator(options)({...evidence,symptoms:["A different failure"]})).rejects.toThrow("input-changed");
    await expect(createWordingGenerator({...options,execution:{...execution,permissionMode:"full"}})(evidence)).rejects.toThrow("input-changed");
    await expect(createWordingGenerator({...options,privacyGeneration:"privacy-two",currentPrivacyGeneration:()=>"privacy-two"})(evidence)).rejects.toThrow("input-changed");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("does not checkpoint a result after privacy changes during a turn",async()=>{
    const {options,evidence,execute,store}=setup();let generation="privacy-one";
    execute.mockImplementationOnce(async request=>{generation="privacy-two";return receipt(request);});
    await expect(createWordingGenerator({...options,currentPrivacyGeneration:()=>generation})(evidence)).rejects.toThrow("privacy-changed");
    expect(store.list("native-wording-receipts")).toEqual([]);expect(store.list("native-wording-checkpoints")).toMatchObject([{wordings:null}]);
  });
  it("binds the entire study to provider/model/options and keeps private arm identities out of callbacks",async()=>{
    const {options,research,store}=pairSetup();await runWordingPair(options);
    expect(research).toHaveBeenCalledTimes(2);
    for(const call of research.mock.calls as unknown as Array<[unknown,string,number,{runId:string;execution:NativeExecution}]>){expect(call[1]).not.toMatch(/abstract|concrete/);expect(call[3]).toMatchObject({runId:"run-one",execution});}
    await expect(runWordingPair({...options,execution:{...execution,providerId:"claude-code"}})).rejects.toThrow("execution-changed");
    store.put("problems","p-b",problem("p-b"));store.put("votes","v-two",vote({id:"v-two",problemId:"p-b"}));
    await expect(runWordingPair({...options,problemId:"p-b",voteIds:["v-two"],execution:{...execution,permissionMode:"full"}})).rejects.toThrow("execution-changed");
    expect(research).toHaveBeenCalledTimes(2);
  });
  it("keeps the original run attribution through partial arm retries",async()=>{
    const {options,research,execute}=pairSetup();research.mockRejectedValueOnce(new Error("interrupted"));
    await expect(runWordingPair(options)).rejects.toThrow("experiment-pair-failed");
    const retry={...options,runId:"run-two"};await runWordingPair(retry);
    expect(execute).toHaveBeenCalledTimes(1);
    const calls=research.mock.calls as unknown as Array<[unknown,string,number,{runId:string}]>;
    expect(calls.every(call=>call[3].runId==="run-one")).toBe(true);
  });
  it("preserves legacy pair records while refusing to relabel them as native execution",async()=>{
    const {options,store,execute}=pairSetup();await runWordingPair(options);
    const entry=store.entries<Record<string,unknown>>("experiment-pairs-private")[0]!;delete entry.value.executionBinding;store.put("experiment-pairs-private",entry.key,entry.value);
    await expect(runWordingPair(options)).rejects.toThrow("legacy-experiment-execution-unbound");
    expect(store.get("experiment-pairs-private",entry.key)).toEqual(entry.value);expect(execute).toHaveBeenCalledTimes(1);
  });
});
