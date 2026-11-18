import { describe,expect,it } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { Store,MIGRATIONS } from "../src/store.js";
import { stableJson } from "../src/domain/shared.js";
import { Publisher,PublicationHttpError,type GitHubTransport,type PublishInput } from "../src/publish.js";
import { solution } from "./domain/fixtures.js";
function setup(){
  const db=new Database(":memory:");MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
  const s=solution();s.status="active";store.put("solutions",s.id,s);
  store.put("validated-artifacts",s.id,{revision:"r1",evaluationId:"e1"});
  const files=[{path:"README.md",content:"An instruction and its evidence"}],digest=createHash("sha256").update(stableJson(files)).digest("hex");
  store.put("export-drafts","draft",{id:"draft",solutionId:s.id,revision:"r1",evaluationId:"e1",name:"tested-improvement",format:"plugin",files,bundleSha256:digest,status:"draft"});
  const input:PublishInput={artifactId:"draft",repository:"org/repo",directory:"plugins/tested-improvement",bundleSha256:digest,reviewed:true};
  let branch:string|null=null,ref=false,pull=false,failOnce=false;const calls:Array<{method:string;path:string;body:unknown}>=[];let rows:unknown[]=[];
  const transport:GitHubTransport={call:async(method,path,body)=>{
    calls.push({method,path,body});
    if(method==="GET"&&path==="repos/org/repo/")return {default_branch:"main"};
    if(path.endsWith("git/ref/heads/main"))return {object:{sha:"a".repeat(40)}};
    if(path.includes("git/commits/"))return {tree:{sha:"b".repeat(40)}};
    if(path.includes("git/trees/")&&method==="GET")return {truncated:false,tree:rows};
    if(path.endsWith("git/trees"))return {sha:"c".repeat(40)};
    if(path.endsWith("git/commits"))return {sha:"d".repeat(40)};
    if(path.includes("git/ref/heads/self-improve-")){if(!ref)throw new PublicationHttpError(404);return {object:{sha:"d".repeat(40)}};}
    if(path.endsWith("git/refs")){branch=(body as {ref:string}).ref;ref=true;return {};}
    if(path.includes("pulls?"))return pull?[{head:{sha:"d".repeat(40)},html_url:"https://github.com/org/repo/pull/7"}]:[];
    if(path.endsWith("pulls")){pull=true;if(failOnce){failOnce=false;throw new Error("lost response");}return {html_url:"https://github.com/org/repo/pull/7"};}
    throw new Error("unexpected endpoint");
  }};
  return {db,store,input,calls,transport,setRows:(next:unknown[])=>{rows=next;},loseResponse:()=>{failOnce=true;},getBranch:()=>branch};
}
describe("reviewed artifact publication",()=>{
  it("opens one draft PR with exact reviewed content and no merge or overwrite calls",async()=>{
    const f=setup();try{
      const publisher=new Publisher(f.store,()=>["org/repo"],f.transport);
      expect(await publisher.publish(f.input)).toEqual({status:"submitted-for-review",url:"https://github.com/org/repo/pull/7"});
      await publisher.publish(f.input);
      expect(f.calls.filter(c=>c.method==="POST"&&c.path.endsWith("pulls"))).toHaveLength(1);
      expect(f.calls.find(c=>c.path.endsWith("pulls")&&c.method==="POST")?.body).toMatchObject({draft:true,base:"main"});
      expect(f.calls.find(c=>c.path.endsWith("git/trees")&&c.method==="POST")?.body).toMatchObject({tree:[{path:"plugins/tested-improvement/README.md",content:"An instruction and its evidence"}]});
      expect(f.getBranch()).toMatch(/^refs\/heads\/self-improve-/);
      expect(f.store.list("publication-approvals")).toHaveLength(1);
      expect(f.store.list("publications")).toEqual([expect.objectContaining({status:"submitted-for-review",url:"https://github.com/org/repo/pull/7"})]);
    }finally{f.db.close();}
  });
  it("recovers a created PR after its response is lost without creating another",async()=>{
    const f=setup();try{f.loseResponse();await expect(new Publisher(f.store,()=>["org/repo"],f.transport).publish(f.input)).rejects.toThrow("lost response");
      expect(await new Publisher(f.store,()=>["org/repo"],f.transport).publish(f.input)).toMatchObject({status:"submitted-for-review"});
      expect(f.calls.filter(c=>c.method==="POST"&&c.path.endsWith("pulls"))).toHaveLength(1);
    }finally{f.db.close();}
  });
  it("normalizes a saved legacy published draft without new transport calls or changed evidence",async()=>{
    const f=setup();try{
      await new Publisher(f.store,()=>["org/repo"],f.transport).publish(f.input);
      const [prior]=f.store.entries<Record<string,unknown>>("publications");
      f.store.put("publications",prior.key,{...prior.value,status:"published"});
      const legacyVersion=f.store.version("publications",prior.key);
      const namespaces=["publication-approvals","solutions","validated-artifacts","export-drafts"];
      const before=namespaces.map(namespace=>f.store.entries(namespace));
      f.calls.length=0;
      expect(await new Publisher(f.store,()=>["org/repo"],f.transport).publish(f.input)).toEqual({status:"submitted-for-review",url:"https://github.com/org/repo/pull/7"});
      expect(f.store.get("publications",prior.key)).toEqual({...prior.value,status:"submitted-for-review"});
      expect(f.store.version("publications",prior.key)).toBe(legacyVersion+1);
      expect(await new Publisher(f.store,()=>["org/repo"],f.transport).publish(f.input)).toEqual({status:"submitted-for-review",url:"https://github.com/org/repo/pull/7"});
      expect(f.store.version("publications",prior.key)).toBe(legacyVersion+1);
      expect(namespaces.map(namespace=>f.store.entries(namespace))).toEqual(before);
      expect(f.calls).toEqual([]);
    }finally{f.db.close();}
  });
  it("keeps current destination, digest and activation gates before returning a saved legacy draft",async()=>{
    const f=setup();try{
      await new Publisher(f.store,()=>["org/repo"],f.transport).publish(f.input);
      const [prior]=f.store.entries<Record<string,unknown>>("publications");
      const legacy={...prior.value,status:"published"};f.store.put("publications",prior.key,legacy);
      const legacyVersion=f.store.version("publications",prior.key);
      f.calls.length=0;
      await expect(new Publisher(f.store,()=>[],f.transport).publish(f.input)).rejects.toThrow("allowed");
      const publisher=new Publisher(f.store,()=>["org/repo"],f.transport);
      await expect(publisher.publish({...f.input,bundleSha256:"f".repeat(64)})).rejects.toThrow("changed");
      const draft=f.store.get<Record<string,unknown>>("export-drafts","draft")!;
      f.store.put("export-drafts","draft",{...draft,files:[{path:"README.md",content:"Unreviewed replacement"}]});
      await expect(publisher.publish(f.input)).rejects.toThrow("content digest mismatch");
      f.store.put("export-drafts","draft",draft);
      const s=solution();s.status="removed";f.store.put("solutions",s.id,s);
      await expect(publisher.publish(f.input)).rejects.toThrow("no longer active");
      expect(f.store.get("publications",prior.key)).toEqual(legacy);
      expect(f.store.version("publications",prior.key)).toBe(legacyVersion);
      expect(f.calls).toEqual([]);
    }finally{f.db.close();}
  });
  it.each([{path:"plugins/tested-improvement/README.md",type:"blob"},{path:"plugins",type:"blob",mode:"120000"}])("refuses existing content and symlink/file ancestors",async row=>{
    const f=setup();try{f.setRows([row]);await expect(new Publisher(f.store,()=>["org/repo"],f.transport).publish(f.input)).rejects.toThrow("already exists");expect(f.calls.some(c=>c.method==="POST")).toBe(false);}finally{f.db.close();}
  });
  it("requires an allowlisted target, matching digest and an active revision before network calls",async()=>{
    const f=setup();try{const p=new Publisher(f.store,()=>["org/repo"],f.transport);
      await expect(p.publish({...f.input,repository:"stranger/repo"})).rejects.toThrow("allowed");
      await expect(p.publish({...f.input,directory:"../repo"})).rejects.toThrow("safe relative");
      await expect(p.publish({...f.input,bundleSha256:"f".repeat(64)})).rejects.toThrow("changed");
      const s=solution();s.status="removed";f.store.put("solutions",s.id,s);
      await expect(p.publish(f.input)).rejects.toThrow("no longer active");expect(f.calls).toHaveLength(0);
    }finally{f.db.close();}
  });
});
