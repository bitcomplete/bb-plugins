import Database from "better-sqlite3";
import {afterEach,describe,it,expect} from "vitest";
import {Store,MIGRATIONS} from "../src/store.js";
import {createRevalidationWorkloads,revalidationWorkloadDigest} from "../src/revalidation-workload.js";
import {createRevalidationWorkloadSchema,type RevalidationWorkloadDefinition} from "../src/revalidation-contract.js";
const owner={kind:"owner" as const,id:"owner"},chat={kind:"chat" as const,id:"chat-one"};
const dbs:Database.Database[]=[];afterEach(()=>dbs.splice(0).forEach(db=>db.close()));
function fixture(){
  const db=new Database(":memory:");dbs.push(db);MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
  const registry=createRevalidationWorkloads(store,{redact:text=>text.replaceAll("private-value","[redacted]"),now:()=>1});
  const definition:RevalidationWorkloadDefinition={schemaVersion:1,kind:"paired-exact-instruction-v1",description:"Explicit prompt cases",cases:[{id:"case-one",familyId:"family-one",input:"Return the exact answer",expected:"  answer\n"}],measurements:[{criterionId:"success",kind:"exact-pass-rate"}],normalization:"none",baseline:"no-added-instruction",orderPolicy:"alternating-arms-v1",response:"json-output-string-v1"};
  return {store,registry,definition};
}
describe("immutable revalidation workloads",()=>{
  it("preserves exact expected bytes, audited history and lost-response idempotency",()=>{
    const f=fixture(),first=f.registry.create({requestId:"intent",definition:f.definition},owner);
    expect(first.definition.cases[0].expected).toBe("  answer\n");
    expect(f.registry.create({requestId:"intent",definition:f.definition},chat)).toEqual(first);
    const changed=structuredClone(f.definition);changed.cases[0].expected="changed";
    const second=f.registry.revise({id:first.id,expectedVersion:1,definition:changed},chat);
    expect(second.manifestDigest).not.toBe(first.manifestDigest);expect(second.previousVersion).toBe(1);
    expect(f.registry.get(first.id,1)).toEqual(first);expect(f.registry.list()).toEqual([second]);
    expect(f.registry.history(first.id)).toEqual([first,second]);
    expect(()=>f.registry.revise({id:first.id,expectedVersion:1,definition:changed},owner)).toThrow("version-conflict");
    expect(()=>f.registry.create({requestId:"intent",definition:changed},owner)).toThrow("request-conflict");
    expect(f.store.audit()).toHaveLength(4);
  });
  it("rejects owner outcomes, undeclared protocols, duplicate cases, bindings and bounded input overflow",()=>{
    const f=fixture();
    expect(()=>createRevalidationWorkloadSchema.parse({requestId:"intent",definition:f.definition,score:1})).toThrow();
    const mutations=[{...f.definition,normalization:"trim"},{...f.definition,cases:[{...f.definition.cases[0],observed:"answer"}]},
      {...f.definition,cases:[f.definition.cases[0],{...f.definition.cases[0],id:"case-two"}]},
      {...f.definition,cases:[f.definition.cases[0],{...f.definition.cases[0],input:"different"}]},
      {...f.definition,measurements:[...f.definition.measurements,...f.definition.measurements]},
      {...f.definition,cases:[{...f.definition.cases[0],input:"x".repeat(16001)}]},
      {...f.definition,cases:Array.from({length:30},(_,i)=>({...f.definition.cases[0],id:`case-${i}`,input:`${i}${"x".repeat(15000)}`}))}];
    for(const definition of mutations)expect(()=>createRevalidationWorkloadSchema.parse({requestId:"intent",definition})).toThrow();
    expect(f.registry.list()).toEqual([]);
  });
  it("validates privacy without rewriting case bytes or expected answers",()=>{
    const f=fixture();
    for(const field of ["input","expected"]){const definition=structuredClone(f.definition);definition.cases[0][field as "input"|"expected"]="private-value";
      expect(()=>f.registry.create({requestId:field,definition},owner)).toThrow("private-input");}
    expect(f.store.audit()).toEqual([]);
    expect(()=>f.registry.create({requestId:"service",definition:f.definition},{kind:"service",id:"worker"})).toThrow("editor-required");
  });
  it("resolves actual immutable versions, rejects fabricated digests and detects stored test mutations",()=>{
    const f=fixture(),saved=f.registry.create({requestId:"intent",definition:f.definition},owner),ref={id:saved.id,version:1,description:saved.definition.description,manifestDigest:saved.manifestDigest};
    expect(f.registry.resolve(ref)).toEqual({id:saved.id,version:1,definition:f.definition,manifestDigest:saved.manifestDigest});
    expect(()=>f.registry.resolve({...ref,manifestDigest:"a".repeat(64)})).toThrow("reference-changed");
    expect(()=>f.registry.resolve({...ref,description:"different"})).toThrow("reference-changed");
    const changed=structuredClone(saved);changed.definition.cases[0].expected="mutated";f.store.put("revalidation-workloads",`${saved.id}:1`,changed);
    expect(()=>f.registry.resolve(ref)).toThrow("workload-changed");
  });
  it("binds case order, exact expected text and measurement mappings in content identity",()=>{
    const f=fixture(),base=revalidationWorkloadDigest(f.definition);
    for(const change of ["expected","measurement","order"]){const value=structuredClone(f.definition);
      if(change==="expected")value.cases[0].expected=value.cases[0].expected.trim();
      if(change==="measurement")value.measurements[0].kind="regression-count";
      if(change==="order")value.cases.unshift({id:"case-zero",familyId:"family-zero",input:"First",expected:"zero"});
      expect(revalidationWorkloadDigest(value)).not.toBe(base);}
  });
});
