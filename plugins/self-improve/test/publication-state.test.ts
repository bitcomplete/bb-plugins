import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { stableJson } from "../src/domain/shared.js";
import { PublicationTracker } from "../src/publication-state.js";
import type { GitHubTransport } from "../src/publish.js";

const databases:Database.Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
const commit="a".repeat(40),tree="b".repeat(40),head="c".repeat(40);
function fixture(){
  const db=new Database(":memory:");databases.push(db);MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
  const content="A measured instruction\n",files=[{path:"README.md",content}],bundleSha256=createHash("sha256").update(stableJson(files)).digest("hex");
  store.put("export-drafts","draft",{id:"draft",solutionId:"solution",revision:"r1",files,bundleSha256});
  store.put("publications","publication",{id:"publication",draftId:"draft",repository:"org/repo",directory:"plugins/fix",bundleSha256,commit:head,url:"https://github.com/org/repo/pull/7",status:"published"});
  const state={pull:{number:7,state:"closed",merged:true,head:{sha:head},merge_commit_sha:commit},release:{tag_name:"v1",draft:false,prerelease:false,published_at:"2026-11-18T00:00:00Z"},truncated:false,
    rows:[{path:"plugins/fix/README.md",type:"blob",mode:"100644",sha:createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex")}]};
  const calls:string[]=[];let fail=false;
  const transport:GitHubTransport={call:async(method,path)=>{
    expect(method).toBe("GET");calls.push(path);if(fail)throw new Error("remote unavailable");
    if(path.endsWith("pulls/7"))return structuredClone(state.pull);
    if(path.endsWith(`git/commits/${commit}`))return {sha:commit,tree:{sha:tree}};
    if(path.endsWith(`git/trees/${tree}?recursive=1`))return {sha:tree,truncated:state.truncated,tree:structuredClone(state.rows)};
    if(path.endsWith(`releases/tags/${encodeURIComponent(state.release.tag_name)}`))return structuredClone(state.release);
    if(path.endsWith(`git/ref/tags/${encodeURIComponent(state.release.tag_name)}`))return {ref:`refs/tags/${state.release.tag_name}`,object:{type:"commit",sha:commit}};
    throw new Error("unexpected endpoint");
  }};
  return {store,state,calls,transport,tracker:new PublicationTracker(store,()=>["org/repo"],transport,()=>1000),fail:()=>{fail=true;}};
}

it.each(["open","closed"])("a %s unmerged PR is not repository availability",async state=>{
  const f=fixture();f.state.pull.state=state;f.state.pull.merged=false;
  const result=await f.tracker.reconcile("publication");
  expect(result.review.state).toBe(state);expect(result.repository.state).toBe("unconfirmed");expect(result.release.state).toBe("not-requested");expect(f.calls).toEqual(["repos/org/repo/pulls/7"]);
});
it("confirms the exact merged package at an immutable commit, independently of release",async()=>{
  const f=fixture(),before=f.store.get("publications","publication");const result=await f.tracker.reconcile("publication");
  expect(result.repository).toMatchObject({state:"available",commit});expect(result.release.state).toBe("not-requested");expect(result.review.submittedCommitChanged).toBe(false);
  expect(f.store.get("publications","publication")).toEqual(before);expect(result.issues).toEqual([]);
});
it.each(["changed","extra","symlink"])("does not attribute %s package contents to the reviewed digest",async variant=>{
  const f=fixture();if(variant==="changed")f.state.rows[0]!.sha="d".repeat(40);else if(variant==="symlink")f.state.rows[0]!.mode="120000";else f.state.rows.push({...f.state.rows[0]!,path:"plugins/fix/extra.txt"});
  expect((await f.tracker.reconcile("publication")).repository.state).toBe("content-changed");
});
it("keeps a truncated tree unconfirmed rather than concluding that files match",async()=>{
  const f=fixture();f.state.truncated=true;const result=await f.tracker.reconcile("publication");
  expect(result.review.state).toBe("merged");expect(result.repository.state).toBe("unconfirmed");expect(result.issues).toEqual(["review-or-merged-content-not-confirmed"]);
});
it("records a published release only after resolving its tag and verifying the package bytes",async()=>{
  const f=fixture();const result=await f.tracker.reconcile("publication","v1");
  expect(result.release).toEqual({state:"released",tag:"v1",commit,url:"https://github.com/org/repo/releases/tag/v1",prerelease:false});
  f.state.release.draft=true;expect((await f.tracker.reconcile("publication","v1")).release.state).toBe("draft");
  expect(f.tracker.history("publication").map(o=>o.release.state)).toEqual(["released","draft"]);
});
it("preserves past confirmed evidence when later reads fail",async()=>{
  const f=fixture();await f.tracker.reconcile("publication");f.fail();const latest=await f.tracker.reconcile("publication");
  expect(latest.review.state).toBe("unknown");expect(latest.repository.state).toBe("unconfirmed");
  expect(f.tracker.history("publication")[0]!.repository.state).toBe("available");expect(f.tracker.latest("publication")).toEqual(latest);
});
it("does not let an older delayed observation replace a newer one",async()=>{
  const f=fixture();let release!:(value:unknown)=>void;let count=0;
  const transport:GitHubTransport={call:async()=>{count++;return count===1?new Promise(resolve=>{release=resolve;}):{...f.state.pull,state:"closed",merged:false};}};
  const tracker=new PublicationTracker(f.store,()=>["org/repo"],transport,()=>1000);
  const earlier=tracker.reconcile("publication"),later=await tracker.reconcile("publication");
  release({...f.state.pull,state:"open",merged:false});await earlier;
  expect(tracker.latest("publication")).toEqual(later);expect(tracker.history("publication").map(o=>o.sequence)).toEqual([1,2]);
});
it("refuses to persist a response for a publication changed during the remote read",async()=>{
  const f=fixture();const tracker=new PublicationTracker(f.store,()=>["org/repo"],{call:async()=>{
    const p=f.store.get<Record<string,unknown>>("publications","publication")!;f.store.put("publications","publication",{...p,commit:"d".repeat(40)});
    return {...f.state.pull,state:"open",merged:false};
  }});
  await expect(tracker.reconcile("publication")).rejects.toThrow("changed during observation");expect(tracker.history("publication")).toEqual([]);
});
it("retains history across tracker reload and refuses revoked destinations before a request",async()=>{
  const f=fixture();const first=await f.tracker.reconcile("publication");
  const reloaded=new PublicationTracker(f.store,()=>[],f.transport);const calls=f.calls.length;
  expect(reloaded.history("publication")).toEqual([first]);await expect(reloaded.reconcile("publication")).rejects.toThrow("no longer allowed");expect(f.calls).toHaveLength(calls);
});
it("stops subsequent remote reads if repository policy changes during an earlier read",async()=>{
  const f=fixture();let allowed=true;let calls=0;
  const tracker=new PublicationTracker(f.store,()=>allowed?["org/repo"]:[],{call:async()=>{calls++;allowed=false;return f.state.pull;}});
  await expect(tracker.reconcile("publication","v1")).rejects.toThrow("changed during observation");
  expect(calls).toBe(1);expect(tracker.history("publication")).toEqual([]);
});
it("uses the tag namespace even when a release tag looks like a commit SHA",async()=>{
  const f=fixture();f.state.release.tag_name="f".repeat(40);
  expect((await f.tracker.reconcile("publication",f.state.release.tag_name)).release).toMatchObject({state:"released",commit});
  expect(f.calls).toContain(`repos/org/repo/git/ref/tags/${f.state.release.tag_name}`);
  expect(f.calls).not.toContain(`repos/org/repo/commits/${f.state.release.tag_name}`);
});
it("peels an annotated tag and leaves cycles unconfirmed",async()=>{
  const f=fixture(),tagSha="e".repeat(40);let cycle=false;
  const tracker=new PublicationTracker(f.store,()=>["org/repo"],{call:async(method,path)=>{
    if(path.endsWith("git/ref/tags/v1"))return {ref:"refs/tags/v1",object:{type:"tag",sha:tagSha}};
    if(path.endsWith(`git/tags/${tagSha}`))return {sha:tagSha,object:cycle?{type:"tag",sha:tagSha}:{type:"commit",sha:commit}};
    return f.transport.call(method,path);
  }});
  expect((await tracker.reconcile("publication","v1")).release.state).toBe("released");cycle=true;
  const changed=await tracker.reconcile("publication","v1");expect(changed.release.state).toBe("unconfirmed");expect(changed.issues).toContain("release-not-confirmed");
});
