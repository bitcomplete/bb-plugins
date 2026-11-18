import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { defaultConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import type { Retrospective } from "../src/retro.js";
import type { DashboardData } from "../src/ui/types.js";
import { DAY, NOW, problem, solution } from "./domain/fixtures.js";

describe("historical mining controls",()=>{
  it("captures immutable artifact scope in the queued retro job and validates CLI combinations",async()=>{
    const config={...defaultConfig(),scopeProjectIds:["configured-project"]};
    const {bb,harness}=createFakePluginHost({pluginId:"self-improve",settings:{config:JSON.stringify(config)}});
    try{
      await plugin(bb);const store=new Store(bb.storage.database());store.put("solutions","s-a",solution());
      store.put("validated-artifacts","s-a",{revision:"original",evaluationId:"evaluation",artifactDigest:"digest"});
      store.put("built-artifacts","artifact",{solutionId:"s-a",revision:"original",evaluationId:"evaluation",artifactDigest:"digest",scopeProjectIds:["immutable-project"]});
      const result=await harness.behavior.runCli(["retro","--solution","s-a","--go-live-ms",String(NOW-8*DAY)]);
      expect(result.exitCode).toBe(0);
      expect(store.claim("verifier","test")?.input).toEqual({mode:"retro",solutionId:"s-a",goLiveMs:NOW-8*DAY,scopeProjectIds:["immutable-project"]});
      const invalid=await harness.behavior.runCli(["retro","--go-live-ms",String(NOW-8*DAY)]);expect(invalid.exitCode).not.toBe(0);
      const mixed=await harness.behavior.runCli(["retro","--id","missing","--solution","s-a"]);expect(mixed.exitCode).not.toBe(0);
      const list=await harness.behavior.runCli(["retro","--solution","s-a"]);expect(JSON.parse(list.stdout)).toEqual([]);
    }finally{await harness.lifecycle.dispose();}
  });

  it("routes a retro job without running live verification or model/provider revisits",async()=>{
    const config={...defaultConfig(),providerId:"codex",projectId:"project",environmentId:"environment",scopeProjectIds:["project"],model:"fixture-model"};
    const {bb,harness}=createFakePluginHost({pluginId:"self-improve",settings:{config:JSON.stringify(config)}});
    try{
      await plugin(bb);const store=new Store(bb.storage.database());store.put("problems","p-a",problem());store.put("solutions","s-a",solution());
      const original=store.entries("solutions");
      const queued=await harness.behavior.runCli(["retro","--solution","s-a","--go-live-ms",String(Date.now()-100*DAY)]);
      expect(queued.exitCode).toBe(0);const {jobId}=JSON.parse(queued.stdout);
      const running=harness.behavior.runService("verifier");
      try{await vi.waitFor(()=>expect(store.jobStatus(jobId)).toBe("succeeded"));}finally{running.controller.abort();await running.done;}
      expect(store.entries("solutions")).toEqual(original);
      expect(store.list("performance")).toEqual([]);expect(store.list("revisit-queue")).toEqual([]);expect(store.list("revisit-reviews")).toEqual([]);
      const report=store.list<Retrospective>("retro-analyses")[0];expect(report.coverageGaps).toContain("requested-window-exceeds-90-day-history-limit");
      const detail=await harness.behavior.runCli(["retro","--id",report.id]);
      expect(detail.exitCode).toBe(0);expect(JSON.parse(detail.stdout)).toMatchObject({id:report.id,cursors:[],selections:[],verification:{verdict:"PENDING"},costs:[{runId:report.runIds[0],costs:{totals:[]}}]});
    }finally{await harness.lifecycle.dispose();}
  });
});

describe("re-test evidence in dashboard",()=>{
  it("reuses queued and running requests across clients and internal revisit jobs",async()=>{
    const {bb,harness}=createFakePluginHost({pluginId:"self-improve"});
    try{
      await plugin(bb);const store=new Store(bb.storage.database());store.put("solutions","s-a",{...solution(),status:"active"});store.put("validated-artifacts","s-a",{revision:"original"});
      const input={solutionId:"s-a",expectedVersion:store.version("solutions","s-a"),reason:"First owner reason"};
      const first=await harness.behavior.callRpc("retest",input) as {jobId:string};
      expect(await harness.behavior.callRpc("retest",{...input,reason:"Second reason"})).toEqual(first);
      expect(store.list("retests")).toHaveLength(1);expect(store.list<{reason:string}>("retests")[0].reason).toBe(input.reason);
      store.claim("builder","test");expect(await harness.behavior.callRpc("retest",input)).toEqual(first);
      store.complete(first.jobId,"test",{});
      const internal=store.enqueue("builder","revisit:test",{solutionId:"s-a",retest:true,artifactRevision:"original",revisitId:"test"});
      expect(await harness.behavior.callRpc("retest",input)).toEqual({jobId:internal});expect(store.list("retests")).toHaveLength(1);
      const snapshot=await harness.behavior.callRpc("dashboard",{}) as DashboardData;
      expect(snapshot.retests?.find(r=>r.jobId===internal)).toMatchObject({status:"queued",solutionId:"s-a"});
      expect(store.audit()).toEqual([]);
    }finally{await harness.lifecycle.dispose();}
  });
  it("never promotes a successful job to a passing re-test without matching evaluation and adoption evidence",async()=>{
    const {bb,harness}=createFakePluginHost({pluginId:"self-improve"});
    try{
      await plugin(bb);const store=new Store(bb.storage.database());store.put("solutions","s-a",solution());
      const jobId=store.enqueue("builder","retest-evidence",{retest:true,solutionId:"s-a"});store.claim("builder","test");store.complete(jobId,"test",{tested:1,passed:0});
      store.put("retests","request",{jobId,solutionId:"s-a",status:"queued",atMs:NOW,reason:"Fixture re-test"});
      const status=async()=>(await harness.behavior.callRpc("dashboard",{}) as DashboardData).retests![0].status;
      expect(await status()).toBe("inconclusive");
      const attempt={id:jobId,solutionId:"s-a",revision:jobId,status:"rejected",artifactId:null,evaluationId:null};store.put("evaluation-attempts",jobId,attempt);
      expect(await status()).toBe("rejected");
      store.put("evaluation-attempts",jobId,{...attempt,status:"passed",artifactId:"artifact",evaluationId:"receipt"});
      expect(await status()).toBe("inconclusive");
      const proof={manifestCommit:"a".repeat(40),manifestCommittedAtMs:NOW-3*DAY,patchCreatedAtMs:NOW-2*DAY,proposerVisibleTaskIds:["visible"],heldOutTaskIds:["sealed"],proposerVisibleFamilyIds:["visible-family"],heldOutFamilyIds:["sealed-family"],isolationVerified:true,passed:true,proofRef:"receipt"};
      store.put("trusted-evaluations","receipt",{id:"receipt",solutionId:"s-a",revision:jobId,kind:"evaluation",status:"passed",executionCount:6,artifactDigest:"digest",proof});
      store.put("built-artifacts","artifact",{solutionId:"s-a",revision:jobId,evaluationId:"receipt",artifactDigest:"digest"});
      expect(await status()).toBe("needs-review");
      store.put("solutions","s-a",{...solution(),attempts:[{id:`adopt-${jobId}`,outcome:"adopted",evidenceIds:["receipt"]}]});
      expect(await status()).toBe("passed");
      store.put("trusted-evaluations","receipt",{id:"receipt",solutionId:"different-solution",revision:jobId,kind:"evaluation",status:"passed",executionCount:6,artifactDigest:"digest",proof});
      expect(await status()).toBe("inconclusive");
    }finally{await harness.lifecycle.dispose();}
  });
});
