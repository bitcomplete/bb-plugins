import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { preregisterStudy, runWordingPair, ratingCards, ratePaper, promoteExperimentalCandidate, experimentReport, recoverExperimentPairs, type WordingPairOptions } from "../src/experiments.js";
import { NOW, DAY, problem, solution, vote } from "./domain/fixtures.js";
import type { ResearchResult } from "../src/stages/native-research.js";
import type { Paper } from "../src/adapters/types.js";
const dbs: Database.Database[]=[];
afterEach(()=>dbs.splice(0).forEach(db=>db.close()));
const owner={kind:"owner" as const,id:"owner"};
const paper:Paper={id:"2609.14858",version:"v1",title:"A public research paper",abstract:"An experimentally testable approach to preserving request data.",authors:["Research Author"],publishedAt:new Date(NOW-30*DAY).toISOString(),updatedAt:new Date(NOW-30*DAY).toISOString(),url:"https://arxiv.org/abs/2609.14858v1",source:"arxiv",fwci:null,authorSignal:null,retrievedAt:new Date(NOW).toISOString()};
function setup(){
  const db=new Database(":memory:");dbs.push(db);MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
  store.put("problems","p-a",problem());store.put("votes","v-one",vote({occurredAtMs:NOW-DAY,day:"2026-11-17"}));
  preregisterStudy(store,{id:"study-one",startsAtMs:NOW+DAY,endsAtMs:NOW+15*DAY,sampleSize:1,seed:"fixed-study-seed"},owner,NOW);
  const generate=vi.fn(async(_input:unknown)=>({abstract:"Preserve immutable request information across repeated operations.",concrete:"Keep the original request payload when retrying a failed tool call."}));
  const research=vi.fn(async(p:ReturnType<typeof problem>,key:string):Promise<ResearchResult>=>{
    const candidate=solution(`candidate-${key.includes("abstract")?"abstract":"concrete"}`);candidate.origin="paper";candidate.provenance=[{origin:"paper",sourceId:paper.id+paper.version,model:{provider:"provider",model:"model"}}];candidate.sourcePaper={id:paper.id,version:paper.version,url:paper.url,publishedAtMs:Date.parse(paper.publishedAt),credibility:{status:"pending",fieldWeightedCitationImpact:null,authorSignal:null,evidenceUrls:[]}};candidate.problemIds=[p.id];
    return{snapshotId:key,candidates:[candidate],papers:[paper],paperAssessments:[],receipts:[],warnings:[],counts:{problems:1,papers:1,candidates:1,taskRequests:1,cacheHits:0}};
  });
  const options:WordingPairOptions={store,runId:"study-run",execution:{projectId:"project",environment:{type:"reuse",environmentId:"environment"},providerId:"codex",model:"selected-model",permissionMode:"accept-edits"},privacyGeneration:"privacy-one",currentPrivacyGeneration:()=>"privacy-one",experimentId:"study-one",problemId:"p-a",voteIds:["v-one"],generate,research,now:()=>NOW+2*DAY};
  return{store,generate,research,options};
}
describe("operational paired wording study",()=>{
  it("locks the metric, sample size and duration before any outcome",()=>{
    const {store}=setup();
    expect(()=>preregisterStudy(store,{id:"study-one",startsAtMs:NOW+DAY,endsAtMs:NOW+15*DAY,sampleSize:2,seed:"fixed-study-seed"},owner,NOW)).toThrow(/conflict/);
    expect(()=>preregisterStudy(store,{id:"late",startsAtMs:NOW,endsAtMs:NOW+DAY,sampleSize:1,seed:"seed"},owner,NOW)).toThrow(/before|start/);
    expect(()=>preregisterStudy(store,{id:"worker",startsAtMs:NOW+DAY,endsAtMs:NOW+2*DAY,sampleSize:1,seed:"seed"},{kind:"service",id:"worker"},NOW)).toThrow(/owner/);
  });
  it("generates both wordings from one immutable evidence snapshot and keeps candidates outside live rankings",async()=>{
    const {store,options,generate,research}=setup();const first=await runWordingPair(options);
    expect(first.status).toBe("completed");expect(generate).toHaveBeenCalledTimes(1);expect(research).toHaveBeenCalledTimes(2);
    expect(research.mock.calls.every(call=>!/(?:abstract|concrete)/.test(call[1]))).toBe(true);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({problemId:"p-a",voteIds:["v-one"]});
    expect(store.list("solutions")).toEqual([]);expect(store.list("experiment-candidates")).toHaveLength(2);
    expect(await runWordingPair(options)).toEqual(first);expect(research).toHaveBeenCalledTimes(2);
    expect(()=>experimentReport(store,"study-one",NOW+2*DAY)).not.toThrow();
    expect(experimentReport(store,"study-one",NOW+2*DAY)).toMatchObject({blinded:true,arms:null});
  });
  it("rejects fabricated or wrong-problem evidence instead of calling the model",async()=>{
    const {options,generate}=setup();
    await expect(runWordingPair({...options,voteIds:["fabricated"]})).rejects.toThrow(/evidence|vote/);
    expect(generate).not.toHaveBeenCalled();
  });
  it("retains completed arm checkpoints through a failed next arm and recovery",async()=>{
    const {store,options,generate,research}=setup();const real=options.research;let calls=0;
    options.research=async(p,key,asOfMs,binding)=>{if(++calls===2)throw new Error("private transport message");return real(p,key,asOfMs,binding);};
    await expect(runWordingPair(options)).rejects.toThrow("experiment-pair-failed");
    expect(JSON.stringify(store.list("experiment-pairs-private"))).not.toContain("private transport");
    await runWordingPair(options);expect(generate).toHaveBeenCalledTimes(1);expect(research).toHaveBeenCalledTimes(2);
    expect(recoverExperimentPairs(store,NOW+3*DAY)).toBe(0);
  });
  it("shows papers without arm labels, records immutable owner ratings and disallows late ratings",async()=>{
    const {store,options}=setup();await runWordingPair(options);
    const cards=ratingCards(store,"study-one",NOW+3*DAY);expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards)).not.toMatch(/fixed-study-seed|immutable request information|Keep the original request/);
    expect(cards.every(card=>!Object.hasOwn(card,"variant"))).toBe(true);
    expect(cards[0]?.problem.symptoms[0]).toContain("payload");
    ratePaper(store,"study-one",cards[0]!.id,4,owner,NOW+3*DAY);
    expect(ratingCards(store,"study-one",NOW+3*DAY)[0]?.rating).toBe(4);
    expect(()=>ratePaper(store,"study-one",cards[0]!.id,5,owner,NOW+3*DAY)).toThrow(/immutable|conflict/);
    expect(()=>ratePaper(store,"study-one",cards[0]!.id,4,{kind:"service",id:"worker"},NOW+3*DAY)).toThrow(/owner/);
    expect(()=>ratePaper(store,"study-one",cards[0]!.id,4,owner,NOW+16*DAY)).toThrow(/closed|window/);
  });
  it("requires explicit owner promotion and records only actual trusted built/reduced outcomes",async()=>{
    const {store,options}=setup();await runWordingPair(options);
    const candidates=store.entries<{id:string;variant:string}>("experiment-candidates");const selected=candidates.find(c=>c.value.variant==="abstract")!;
    expect(()=>promoteExperimentalCandidate(store,selected.key,{kind:"service",id:"worker"},NOW+3*DAY)).toThrow(/owner/);
    const promoted=promoteExperimentalCandidate(store,selected.key,owner,NOW+3*DAY);
    expect(store.get("problems","p-a")).toMatchObject({solutionIds:[promoted.solutionId]});
    expect(experimentReport(store,"study-one",NOW+16*DAY).arms?.abstract).toMatchObject({builtPapers:0,reducedPapers:0});
    store.put("built-artifacts","built",{id:"built",solutionId:promoted.solutionId,revision:"revision-one",artifactDigest:"a".repeat(64),evaluationId:"trusted",createdAtMs:NOW+4*DAY});
    store.put("trusted-evaluations","trusted",{id:"trusted",kind:"evaluation",status:"passed",solutionId:promoted.solutionId,revision:"revision-one",artifactDigest:"a".repeat(64),createdAtMs:NOW+5*DAY,executionCount:6});
    store.put("performance","measurement",{id:"measurement",solutionId:promoted.solutionId,solutionRevision:"revision-one",observedAtMs:NOW+14*DAY,verification:{verdict:"REDUCED"},evidenceGaps:[]});
    expect(experimentReport(store,"study-one",NOW+16*DAY).arms?.abstract).toMatchObject({builtPapers:1,reducedPapers:1,builtRate:1,reducedRate:1,reducedAmongBuilt:1});
    expect(experimentReport(store,"study-one",NOW+16*DAY).arms?.concrete).toMatchObject({builtPapers:0,reducedPapers:0});
    store.put("performance","worse",{id:"worse",solutionId:promoted.solutionId,solutionRevision:"revision-one",observedAtMs:NOW+14*DAY+1,verification:{verdict:"WORSE"},evidenceGaps:[]});
    store.put("performance","too-late",{id:"too-late",solutionId:promoted.solutionId,solutionRevision:"revision-one",observedAtMs:NOW+16*DAY,verification:{verdict:"REDUCED"},evidenceGaps:[]});
    expect(experimentReport(store,"study-one",NOW+17*DAY).arms?.abstract.reducedPapers).toBe(0);
  });
  it("keeps the preregistered sample cap even when another problem is available",async()=>{
    const{store,options,generate}=setup();await runWordingPair(options);
    store.put("problems","p-b",problem("p-b"));store.put("votes","v-two",vote({id:"v-two",problemId:"p-b"}));
    await expect(runWordingPair({...options,problemId:"p-b",voteIds:["v-two"]})).rejects.toThrow(/sample size/);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("fences late model responses after recovery instead of resurrecting an old attempt",async()=>{
    const{store,options}=setup();let release!:(value:{abstract:string;concrete:string})=>void;
    options.generate=async()=>new Promise(resolve=>{release=resolve;});
    const running=runWordingPair(options);await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    expect(recoverExperimentPairs(store,NOW+3*DAY)).toBe(1);
    release({abstract:"General mechanism",concrete:"Specific observed failure"});
    await expect(running).rejects.toThrow("experiment-pair-failed");
    expect(store.list<{status:string}>("experiment-pairs-private")[0]?.status).toBe("failed");
    expect(store.list("experiment-arm-results")).toEqual([]);
  });
});
