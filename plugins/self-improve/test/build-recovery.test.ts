import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createBuilder } from "../src/build.js";
import { defaultConfig } from "../src/config.js";
import { Accounting } from "../src/costs.js";
import { stableId } from "../src/domain/shared.js";
import type { Solution } from "../src/domain/types.js";
import type { NativeEvaluationAttempt, EvaluationSuite } from "../src/evaluation.js";
import type { NativeExecution, NativeTaskReceipt, NativeTaskRequest } from "../src/native-tasks.js";
import { Runtime } from "../src/runtime.js";
import type { StageContext } from "../src/services.js";
import { MIGRATIONS, Store } from "../src/store.js";
import { NOW, problem, solution } from "./domain/fixtures.js";

// Recovery remains meaningful; historical direct-provider adoption/review success is unsupported.
describe("completed native exploratory evaluation recovery",()=>{
  it("recovers the original job after reranking without new native calls or activation",async()=>{
    const db=new Database(":memory:");MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
    try {
      const candidate=solution();store.put("problems","p-a",problem());store.put("solutions",candidate.id,candidate);
      store.put("solution-ranking","latest",[{solutionId:candidate.id,eligible:true}]);
      const config={...defaultConfig(),providerId:"codex",model:"test-model",projectId:"project",environmentId:"environment",scopeProjectIds:["project"]};
      const execution:NativeExecution={providerId:config.providerId,model:config.model,projectId:config.projectId,environment:{type:"reuse",environmentId:config.environmentId},permissionMode:"accept-edits"};
      const suite:EvaluationSuite={id:"suite",development:[{id:"development",familyId:"dev-family",input:"Keep the input",expected:"kept"}],heldOut:[{id:"reserved",familyId:"hidden-family",input:"DO_NOT_SEND",expected:"HIDDEN"}]};
      const requests:NativeTaskRequest[]=[];
      const runner={execute:async(request:NativeTaskRequest):Promise<NativeTaskReceipt>=>{
        requests.push(request);const value=request.instructions.startsWith("Propose one")?{instruction:"Preserve the original input across retries."}:{output:request.instructions.includes("Additional instruction:")?"kept":"lost"};
        return {taskId:request.id,runId:request.runId,solutionId:request.solutionId,stage:request.stage,providerId:request.execution.providerId,model:request.execution.model,modelIdentitySource:"requested-selection",threadId:`thread-${request.id}`,requestId:"request",turnId:"turn",promptHash:"a".repeat(64),startedAtMs:NOW,endedAtMs:NOW+1,text:JSON.stringify(value)};
      }};
      const makeBuild=()=>createBuilder({store,config:()=>config,runner,execution:()=>execution,suite:()=>JSON.stringify(suite),privacy:()=>({}),privacyGeneration:()=>"generation"});
      const makeRuntime=()=>new Runtime({bb:{sdk:{}} as BbPluginApi,store,config:()=>config,privacy:()=>({}),runner,execution:()=>execution,privacyGeneration:()=>"generation",accounting:new Accounting(store,()=>config.budgets),workers:()=>({owns:()=>false,analyze:async()=>({failures:[]})}),build:makeBuild()});
      const context:StageContext={job:{id:"build-job",stage:"builder",key:"build",input:{},attempts:1,createdAt:NOW,runId:"first-run"},boot:"first",signal:new AbortController().signal};
      expect(await makeRuntime().handlers.builder(context)).toMatchObject({completed:1,adopted:0,adoptionBlocked:1});
      const id=stableId("native-build-attempt",context.job.id),attempt=store.get<NativeEvaluationAttempt>("native-evaluation-attempts",id)!;
      expect(attempt.status).toBe("completed");expect(requests).toHaveLength(3);
      const receipts=store.list("native-evaluation-receipts"),artifacts=store.list("native-evaluation-artifacts");
      store.put("solution-ranking","latest",[]);
      const retry={...context,boot:"restarted",job:{...context.job,attempts:2,runId:"later-run"}};
      expect(await makeRuntime().handlers.builder(retry)).toMatchObject({completed:1,adopted:0,adoptionBlocked:1});
      expect(requests).toHaveLength(3);expect(store.get("native-evaluation-attempts",id)).toEqual(attempt);
      expect(store.list("native-evaluation-receipts")).toEqual(receipts);expect(store.list("native-evaluation-artifacts")).toEqual(artifacts);
      expect(store.get<Solution>("solutions",candidate.id)).toMatchObject({candidateState:"built",status:null,wiring:null,validatedWith:null,attempts:[{outcome:"built"}]});
      expect(store.list("trusted-evaluations")).toEqual([]);expect(store.list("validated-artifacts")).toEqual([]);expect(JSON.stringify(requests)).not.toMatch(/DO_NOT_SEND|HIDDEN/);
    } finally {db.close();}
  });
});
