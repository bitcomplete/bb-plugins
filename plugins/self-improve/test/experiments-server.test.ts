import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { defaultConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { DAY, NOW, problem, solution, vote } from "./domain/fixtures.js";
const external=vi.hoisted(()=>({research:vi.fn(),generate:vi.fn()}));
vi.mock("../src/experiments.js",async importOriginal=>({...await importOriginal<typeof import("../src/experiments.js")>(),createWordingGenerator:()=>external.generate}));
vi.mock("../src/stages/native-research.js",async importOriginal=>({...await importOriginal<typeof import("../src/stages/native-research.js")>(),scout:external.research}));
import plugin from "../server.js";
afterEach(()=>{vi.useRealTimers();external.research.mockReset();external.generate.mockReset();});
describe("public paired-study workflow",()=>{
  it("queues real service runs, keeps reports blinded and measures only trusted built/reduced artifacts",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(NOW);
    const config={...defaultConfig(),providerId:"codex",model:"study-model",projectId:"project",environmentId:"environment"};
    const {bb,harness}=createFakePluginHost({pluginId:"self-improve",settings:{enabled:false,config:JSON.stringify(config)}});
    try{
      await plugin(bb);const store=new Store(bb.storage.database());
      store.put("problems","p-a",problem());store.put("votes","v-one",vote({occurredAtMs:NOW-DAY,day:"2026-11-17"}));
      const spec={id:"cli-study",startsAtMs:NOW+DAY,endsAtMs:NOW+15*DAY,sampleSize:1};
      const registered=await harness.behavior.runCli(["experiments","--register",JSON.stringify(spec)]);
      expect(registered.exitCode).toBe(0);expect(registered.stdout).not.toMatch(/seed|wordings|runToken/);
      expect((await harness.behavior.runCli(["experiments","--register",JSON.stringify(spec)])).exitCode).toBe(0);
      const paper={id:"2609.14858",version:"v1",title:"Study paper",abstract:"A method for keeping retry inputs.",authors:[],publishedAt:new Date(NOW-30*DAY).toISOString(),updatedAt:new Date(NOW-30*DAY).toISOString(),url:"https://arxiv.org/abs/2609.14858v1",source:"arxiv" as const,fwci:null,authorSignal:null,retrievedAt:new Date(NOW).toISOString()};
      external.generate.mockResolvedValue({abstract:"Preserve information across repeated operations.",concrete:"Keep the original request payload when retrying a failed call."});
      external.research.mockImplementation(async(ctx:{snapshotId:string;runId:string;problems:ReturnType<typeof problem>[]})=>{
        expect(ctx.snapshotId).not.toMatch(/abstract|concrete/);expect(store.runs().some(r=>r.id===ctx.runId)).toBe(true);
        const candidate=solution("research-candidate");candidate.origin="paper";candidate.sourcePaper={id:paper.id,version:paper.version,url:paper.url,publishedAtMs:Date.parse(paper.publishedAt),credibility:{status:"pending",fieldWeightedCitationImpact:null,authorSignal:null,evidenceUrls:[]}};
        return{snapshotId:ctx.snapshotId,candidates:[candidate],papers:[paper],paperAssessments:[],warnings:[],receipts:[],counts:{problems:1,papers:1,candidates:1,taskRequests:0,cacheHits:0}};
      });
      vi.setSystemTime(NOW+2*DAY);
      const queued=await harness.behavior.runCli(["experiments","--run",JSON.stringify({experimentId:spec.id,problemId:"p-a",voteIds:["v-one"]})]);
      const jobId=(JSON.parse(queued.stdout!) as {jobId:string}).jobId;
      const service=harness.behavior.runService("scout");
      try{await vi.waitFor(()=>expect(store.jobStatus(jobId)).toBe("succeeded"));}finally{service.controller.abort();await service.done;}
      expect(store.list("solutions")).toEqual([]);expect(external.research).toHaveBeenCalledTimes(2);
      const before=JSON.parse((await harness.behavior.runCli(["experiments","--id",spec.id,"--report"])).stdout!);
      expect(before).toMatchObject({blinded:true,arms:null,completePairs:1});expect(JSON.stringify(before)).not.toMatch(/seed|wordings|runToken/);
      const cards=JSON.parse((await harness.behavior.runCli(["experiments","--id",spec.id,"--cards"])).stdout!) as Array<{id:string}>;
      expect(cards).toHaveLength(1);
      expect((await harness.behavior.runCli(["experiments","--rate",JSON.stringify({experimentId:spec.id,cardId:cards[0]!.id,value:4})])).exitCode).toBe(0);
      const candidate=store.entries<{variant:string}>("experiment-candidates").find(e=>e.value.variant==="abstract")!;
      const promoted=JSON.parse((await harness.behavior.runCli(["experiments","--promote",candidate.key])).stdout!) as {solutionId:string};
      store.put("built-artifacts","built",{id:"built",solutionId:promoted.solutionId,revision:"tested",artifactDigest:"a".repeat(64),evaluationId:"receipt",createdAtMs:NOW+3*DAY});
      store.put("trusted-evaluations","receipt",{id:"receipt",kind:"evaluation",status:"passed",executionCount:6,solutionId:promoted.solutionId,revision:"tested",artifactDigest:"a".repeat(64),createdAtMs:NOW+4*DAY});
      store.put("performance","measured",{id:"measured",solutionId:promoted.solutionId,solutionRevision:"tested",observedAtMs:NOW+14*DAY,verification:{verdict:"REDUCED"},evidenceGaps:[]});
      vi.setSystemTime(NOW+16*DAY);
      const report=JSON.parse((await harness.behavior.runCli(["experiments","--id",spec.id,"--report"])).stdout!);
      expect(report).toMatchObject({blinded:false,status:"complete",arms:{abstract:{builtPapers:1,reducedPapers:1,meanRelevance:4},concrete:{builtPapers:0,reducedPapers:0,meanRelevance:4}}});
      expect(store.list("native-experiment-executions")).toHaveLength(1);
    }finally{await harness.lifecycle.dispose();}
  });
});
