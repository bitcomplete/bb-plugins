import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import { stableId } from "./store.js";
import { approvePublication, assertSafeArtifactPath, type ExportDraft } from "./publication.js";
import { stableJson } from "./domain/shared.js";
import type { Solution } from "./domain/types.js";
import type { ValidatedArtifact } from "./publication.js";

export interface GitHubTransport { call(method:"GET"|"POST",path:string,body?:unknown):Promise<unknown> }
export class PublicationHttpError extends Error {constructor(readonly status:number){super(`GitHub publication request failed (${status})`);}}
export interface PublishInput {artifactId:string;repository:string;directory:string;bundleSha256:string;reviewed:true}
interface Publication {id:string;draftId:string;repository:string;directory:string;branch:string;bundleSha256:string;base?:string;baseCommit?:string;baseTree?:string;tree?:string;commit?:string;url?:string;status:"preparing"|"submitted-for-review"}
// Older versions called a draft PR "published"; it never meant a release or listing.
type StoredPublication = Omit<Publication,"status"> & {status:Publication["status"]|"published"};
interface Submission {url:string;status:"submitted-for-review"}
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("invalid-github-response");return value as Record<string,unknown>;};
const sha=(value:unknown)=>{if(typeof value!=="string"||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))throw new Error("invalid-github-sha");return value;};

/** Calls the server's existing gh login. Content goes over stdin, never through a shell or argv. */
export function githubTransport(signal?:AbortSignal):GitHubTransport {
  return {call:async(method,path,body)=>{
    if(!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(path))throw new Error("invalid-github-path");
    const args=["api","--hostname","github.com","--include","--method",method,path,...(body===undefined?[]:["--input","-"])];
    const result=await new Promise<string>((resolve,reject)=>{
      const child=spawn("gh",args,{stdio:["pipe","pipe","pipe"],env:{...process.env,GH_HOST:"github.com",GH_PROMPT_DISABLED:"1",GH_PAGER:"cat"},signal});
      const chunks:Buffer[]=[];let bytes=0,done=false;
      const timer=setTimeout(()=>{child.kill("SIGKILL");finish(new Error("github-publication-timeout"));},30000);
      function finish(error?:Error){if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(Buffer.concat(chunks).toString("utf8"));}
      child.on("error",()=>finish(new Error("github-client-unavailable")));
      child.stdout.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2_000_000){child.kill("SIGKILL");finish(new Error("github-response-too-large"));}else chunks.push(chunk);});
      child.stderr.resume(); // Never echo diagnostic bodies or environment information.
      child.on("close",code=>{if(code&&bytes===0)finish(new Error("github-client-failed"));else finish();});
      child.stdin.on("error",()=>{});child.stdin.end(body===undefined?undefined:JSON.stringify(body));
    });
    const boundary=result.search(/\r?\n\r?\n/),status=Number(result.match(/^HTTP\/\S+\s+(\d{3})/i)?.[1]);
    if(boundary<0||!status)throw new Error("invalid-github-response");
    if(status<200||status>=300)throw new PublicationHttpError(status);
    const json=result.slice(boundary).trim();return json?JSON.parse(json):null;
  }};
}

/** Submits a new directory on an isolated branch in a draft PR. Never overwrites or merges. */
export class Publisher {
  private readonly locks=new Map<string,Promise<unknown>>();
  constructor(readonly store:Store,readonly repositories:()=>string[],readonly transport:GitHubTransport){}
  async publish(input:PublishInput):Promise<Submission>{
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.repository)||!this.repositories().includes(input.repository))throw new Error("Choose an explicitly allowed publication repository");
    if(input.reviewed!==true)throw new Error("Review the files and evidence before submitting for review");
    assertSafeArtifactPath(input.directory);
    const draft=this.store.get<ExportDraft>("export-drafts",input.artifactId);
    if(!draft||draft.bundleSha256!==input.bundleSha256)throw new Error("Export changed; review the current draft");
    if(createHash("sha256").update(stableJson(draft.files)).digest("hex")!==draft.bundleSha256)throw new Error("Export content digest mismatch");
    const solution=this.store.get<Solution>("solutions",draft.solutionId),artifact=this.store.get<ValidatedArtifact>("validated-artifacts",draft.solutionId);
    if(!solution||!["active","proven"].includes(solution.status??"")||artifact?.revision!==draft.revision||artifact.evaluationId!==draft.evaluationId)throw new Error("The reviewed solution revision is no longer active");
    const id=stableId("publication",JSON.stringify([draft.id,input.repository,input.directory,input.bundleSha256]));
    const prior=this.locks.get(id)??Promise.resolve();
    const next=prior.catch(()=>{}).then(()=>this.perform(id,draft,input));this.locks.set(id,next);
    try{return await next;}finally{if(this.locks.get(id)===next)this.locks.delete(id);}
  }
  private async perform(id:string,draft:ExportDraft,input:PublishInput):Promise<Submission>{
    let record=this.store.get<StoredPublication>("publications",id);
    if(record?.url){
      // Normalize the saved draft outcome without redispatching GitHub mutations.
      if(record.status!=="submitted-for-review"){
        record.status="submitted-for-review";this.store.put("publications",id,record);
      }
      return {url:record.url,status:"submitted-for-review"};
    }
    if(!record){
      record={id,draftId:draft.id,repository:input.repository,directory:input.directory,branch:`self-improve-${id.slice(-24)}`,bundleSha256:draft.bundleSha256,status:"preparing"};
      approvePublication(this.store,draft.id,{repository:`https://github.com/${record.repository}`,branch:record.branch,directory:record.directory,bundleSha256:record.bundleSha256},{kind:"owner",id:"publication-form"});
      this.store.put("publications",id,record);
    }
    const save=()=>this.store.put("publications",id,record!),api=(method:"GET"|"POST",suffix:string,body?:unknown)=>this.transport.call(method,`repos/${record!.repository}/${suffix}`,body);
    if(!record.base){
      const metadata=object(await this.transport.call("GET",`repos/${record.repository}/`));
      if(typeof metadata.default_branch!=="string"||!metadata.default_branch)throw new Error("Repository has no default branch");
      record.base=metadata.default_branch;save();
    }
    if(!record.baseCommit){const ref=object(await api("GET",`git/ref/heads/${encodeURIComponent(record.base)}`));record.baseCommit=sha(object(ref.object).sha);save();}
    if(!record.baseTree){const commit=object(await api("GET",`git/commits/${record.baseCommit}`));record.baseTree=sha(object(commit.tree).sha);save();}
    if(!record.tree){
      const tree=object(await api("GET",`git/trees/${record.baseTree}?recursive=1`));
      if(tree.truncated!==false||!Array.isArray(tree.tree))throw new Error("Repository tree cannot be checked completely");
      if(tree.tree.some(row=>{const item=object(row),path=item.path;return typeof path==="string"&&(path===record!.directory||path.startsWith(record!.directory+"/")||(record!.directory.startsWith(path+"/")&&item.type!=="tree"));}))throw new Error("Publication directory already exists or has a file ancestor; choose a new directory");
      for(const file of draft.files)assertSafeArtifactPath(file.path);
      const created=object(await api("POST","git/trees",{base_tree:record.baseTree,tree:draft.files.map(file=>({path:`${record!.directory}/${file.path}`,mode:"100644",type:"blob",content:file.content}))}));
      record.tree=sha(created.sha);save();
    }
    if(!record.commit){const commit=object(await api("POST","git/commits",{message:`Package validated improvement ${draft.name}`,tree:record.tree,parents:[record.baseCommit]}));record.commit=sha(commit.sha);save();}
    let ref:Record<string,unknown>|null=null;
    try{ref=object(await api("GET",`git/ref/heads/${record.branch}`));}catch(error){if(!(error instanceof PublicationHttpError)||error.status!==404)throw error;}
    if(ref&&sha(object(ref.object).sha)!==record.commit)throw new Error("Publication branch changed; refusing to overwrite it");
    if(!ref)await api("POST","git/refs",{ref:`refs/heads/${record.branch}`,sha:record.commit});
    const pulls=await api("GET",`pulls?state=all&head=${encodeURIComponent(record.repository.split("/")[0]+":"+record.branch)}`);
    if(!Array.isArray(pulls))throw new Error("invalid-github-response");
    let pull=pulls.find(p=>object(object(p).head).sha===record!.commit);
    if(!pull)pull=await api("POST","pulls",{title:`Add validated improvement: ${draft.name}`,head:record.branch,base:record.base,draft:true,body:`Packages a tested instruction as a ${draft.format}. Review the included EVIDENCE.md for source validation, model, measurements, project scope and undo.\n\nExport digest: ${draft.bundleSha256}\n\nThis pull request does not install or enable the artifact.`});
    const url=object(pull).html_url;
    if(typeof url!=="string"||!url.startsWith(`https://github.com/${record.repository}/pull/`))throw new Error("invalid-pull-request-url");
    record.url=url;record.status="submitted-for-review";save();return {url,status:"submitted-for-review"};
  }
}
