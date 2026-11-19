import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { createRevalidation } from "../src/revalidation.js";
import { createRevalidationWorkloads } from "../src/revalidation-workload.js";
import { createRevalidationDraftEditor } from "../src/revalidation-edit.js";
import type { EditRevalidationDraft } from "../src/revalidation-edit-contract.js";
import { solution } from "./domain/fixtures.js";
const databases:Database.Database[]=[];
afterEach(()=>databases.splice(0).forEach(db=>db.close()));
const owner={kind:"owner" as const,id:"dashboard"};
function fixture(){
  const db=new Database(":memory:");databases.push(db);MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
  const content="Keep the original request unchanged.",artifactDigest=createHash("sha256").update(content).digest("hex");
  store.put("solutions","solution",solution("solution"));store.put("native-evaluation-artifacts","artifact",{solutionId:"solution",revision:"r1",kind:"instruction",content,artifactDigest});
  const workloads=createRevalidationWorkloads(store,{redact:value=>value});
  const domain=createRevalidation(store,{redact:value=>value,workloads});
  const edit=createRevalidationDraftEditor(store,domain.plans,workloads);
  const input:EditRevalidationDraft={action:"create",requestId:"intent-1",definition:{target:{solutionId:"solution",namespace:"native-evaluation-artifacts",artifactId:"artifact",revision:"r1",artifactDigest},mode:"challenge",concern:"Does it preserve every field?",claim:{id:"claim",text:"Payload preservation",scope:"Declared prompt cases",originalEvidenceRefs:[],requiredEvidence:"exploratory"},comparator:null,workload:null,criteria:[],sample:null,environment:null,limits:null},
    workload:{schemaVersion:1,kind:"paired-exact-instruction-v1",description:"Payload cases",cases:[{id:"case-1",familyId:"payload",input:"Copy the input payload unchanged.",expected:"original"}],measurements:[{criterionId:"primary",kind:"exact-pass-rate"}],normalization:"none",baseline:"no-added-instruction",orderPolicy:"alternating-arms-v1",response:"json-output-string-v1"}};
  const snapshot=()=>({records:db.prepare("SELECT * FROM records ORDER BY namespace,key").all(),audit:store.audit()});
  return {store,domain,workloads,edit,input,snapshot};
}
it("retries the same create without duplicating either plan or tests",()=>{
  const f=fixture(),first=f.edit(f.input,owner),before=f.snapshot();
  expect(f.edit(f.input,owner)).toEqual(first);expect(f.snapshot()).toEqual(before);
  expect(first.plan.definition.workload).toMatchObject({id:first.workload!.id,version:1,manifestDigest:first.workload!.manifestDigest});
  expect(f.store.list("revalidation-runs")).toEqual([]);
});
it("retries an acknowledged revision by its saved version even after later edits",()=>{
  const f=fixture(),first=f.edit(f.input,owner);
  const revise:EditRevalidationDraft={...f.input,action:"revise",planId:first.plan.id,expectedVersion:1,requestId:"edit-2",workload:{...f.input.workload!,cases:[{...f.input.workload!.cases[0]!,expected:"next"}]}};
  const second=f.edit(revise,owner);
  f.edit({...revise,requestId:"edit-3",expectedVersion:2,definition:{...revise.definition,concern:"A further concern"}},owner);
  const before=f.snapshot();expect(f.edit(revise,owner)).toEqual(second);expect(f.snapshot()).toEqual(before);
  expect(f.domain.plans.get(first.plan.id).plan.version).toBe(3);
  expect(f.workloads.history(first.workload!.id).map(row=>row.definition.cases[0]!.expected)).toEqual(["original","next"]);
});
it("rolls back tests and audit if the associated plan edit is rejected",()=>{
  const f=fixture(),first=f.edit(f.input,owner),before=f.snapshot();
  const input:EditRevalidationDraft={...f.input,action:"revise",requestId:"conflicting-claim",planId:first.plan.id,expectedVersion:1,
    definition:{...f.input.definition,claim:{...f.input.definition.claim,text:"A different claim"}},
    workload:{...f.input.workload!,cases:[{...f.input.workload!.cases[0]!,expected:"changed"}]}};
  expect(()=>f.edit(input,owner)).toThrow("revalidation-new-claim-needs-new-plan");expect(f.snapshot()).toEqual(before);
});
it("keeps incomplete drafts editable without inventing tests or execution",()=>{
  const f=fixture(),first=f.edit({...f.input,workload:null},owner);
  expect(first.plan.definition.workload).toBeNull();expect(first.workload).toBeNull();expect(f.workloads.list()).toEqual([]);
  const complete=f.edit({...f.input,action:"revise",requestId:"add-tests",planId:first.plan.id,expectedVersion:1},owner);
  expect(complete.workload?.version).toBe(1);expect(f.store.list("revalidation-runs")).toEqual([]);
});
it("rejects conflicting intent retries and stale revisions without writes",()=>{
  const f=fixture(),first=f.edit(f.input,owner),before=f.snapshot();
  expect(()=>f.edit({...f.input,workload:null},owner)).toThrow("revalidation-edit-request-conflict");
  expect(()=>f.edit({...f.input,action:"revise",requestId:"stale",planId:first.plan.id,expectedVersion:7},owner)).toThrow("revalidation-version-conflict");
  expect(f.snapshot()).toEqual(before);
});
it("keeps the current tests when a revision omits the workload, and detaches them only on explicit null",()=>{
  const f=fixture(),first=f.edit(f.input,owner);
  const {workload:_,...withoutWorkload}={...f.input,action:"revise" as const,planId:first.plan.id,expectedVersion:1,requestId:"criteria-only",definition:{...f.input.definition,concern:"Only the concern changed"}};
  const kept=f.edit(withoutWorkload as EditRevalidationDraft,owner);
  expect(kept.plan.definition.workload).toMatchObject({id:first.workload!.id,version:1});expect(f.workloads.history(first.workload!.id)).toHaveLength(1);
  const detached=f.edit({...withoutWorkload,requestId:"detach",expectedVersion:2,workload:null} as EditRevalidationDraft,owner);
  expect(detached.plan.definition.workload).toBeNull();
});
