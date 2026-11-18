import { describe,expect,it } from "vitest";
import Database from "better-sqlite3";
import { Store,MIGRATIONS } from "../src/store.js";
import { Accounting } from "../src/costs.js";
import type { NativeExecution, NativeTaskReceipt, NativeTaskRequest } from "../src/native-tasks.js";
import { removeSolution,reviewRevisits } from "../src/revisit.js";
import { solution, problem, NOW } from "./domain/fixtures.js";
function setup(decision:"retain"|"remove"){
  const db=new Database(":memory:");MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
  const s=solution();s.status="active";s.validatedWith={provider:"anthropic",model:"old"};store.put("solutions",s.id,s);store.put("problems","p-a",problem());
  store.put("validated-artifacts",s.id,{solutionId:s.id,revision:"r1",kind:"instruction",content:"Check the original failure before retrying",artifactDigest:"a".repeat(64),evaluationId:"historical-proof",wiringLocation:"instruction",activatedAtMs:NOW});
  const accounting=new Accounting(store,()=>({currency:"USD",dailyMicros:null,monthlyMicros:null,maxDailyCalls:100,allowUnknown:true,prices:{}}));
  const execution:NativeExecution={projectId:"project",environment:{type:"reuse",environmentId:"environment"},providerId:"codex",model:"new",permissionMode:"accept-edits"};
  let calls=0;const runner={execute:async(request:NativeTaskRequest):Promise<NativeTaskReceipt>=>{calls++;return {taskId:request.id,stage:request.stage,runId:request.runId,solutionId:request.solutionId,providerId:request.execution.providerId,model:request.execution.model,threadId:"thread",requestId:"request",turnId:"turn",promptHash:"a".repeat(64),startedAtMs:NOW,endedAtMs:NOW+1,modelIdentitySource:"requested-selection",text:JSON.stringify({decision,reason:"Review on the changed model"})};}};
  return {db,store,s,accounting,runner,execution,privacyGeneration:"privacy-one",currentPrivacyGeneration:()=>"privacy-one",calls:()=>calls};
}
describe("model change revisits",()=>{
  it("records one review and requests a fresh retest without changing validation identity",async()=>{
    const f=setup("retain");try{const options={...f,runId:"run",signal:new AbortController().signal};
      expect(await reviewRevisits(options)).toMatchObject({revisited:1,retests:1});
      expect(await reviewRevisits(options)).toMatchObject({revisited:0,retests:0});expect(f.calls()).toBe(1);
      const s=f.store.get<ReturnType<typeof solution>>("solutions",f.s.id)!;
      expect(s.validatedWith?.model).toBe("old");expect(s.revisitHistory[0].to.model).toBe("new");expect(f.store.pending()).toHaveLength(1);
    }finally{f.db.close();}
  });
  it("records removal recommendations without removing the artifact",async()=>{
    const f=setup("remove");try{await reviewRevisits({...f,runId:"run",signal:new AbortController().signal});
      expect(f.store.get<ReturnType<typeof solution>>("solutions",f.s.id)?.status).toBe("fixing");expect(f.store.get("validated-artifacts",f.s.id)).not.toBeNull();
      expect(()=>removeSolution(f.store,f.s.id,2,"remove",{kind:"chat",id:"chat"})).toThrow("owner");
      removeSolution(f.store,f.s.id,f.store.version("solutions",f.s.id),"Owner confirms removal",{kind:"owner",id:"owner"});
      expect(f.store.get<ReturnType<typeof solution>>("solutions",f.s.id)?.status).toBe("removed");expect(f.store.audit()).toHaveLength(1);
      expect(f.store.get("validated-artifacts",f.s.id)).not.toBeNull();
    }finally{f.db.close();}
  });
});
