import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { stableId } from "./store.js";
import { stableJson } from "./domain/shared.js";
import { assertSafeArtifactPath, type ArtifactFile, type ExportDraft } from "./publication.js";
import type { GitHubTransport } from "./publish.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const publicationSchema = z.object({
  id:z.string().min(1), draftId:z.string().min(1), repository:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
  directory:z.string().min(1), bundleSha256:z.string().regex(/^[a-f0-9]{64}$/), commit:sha.optional(), url:z.string().optional(),
});
export interface PublicationObservation {
  id:string; publicationId:string; draftId:string; solutionId:string; revision:string; bundleSha256:string;
  sequence:number; observedAtMs:number; releaseTag:string|null;
  review:{state:"unsubmitted"|"open"|"closed"|"merged"|"unknown";url:string|null;headCommit:string|null;submittedCommitChanged:boolean|null};
  repository:{state:"unconfirmed"|"available"|"content-changed";commit:string|null;url:string|null};
  release:{state:"not-requested"|"unconfirmed"|"draft"|"released"|"content-changed";tag:string|null;commit:string|null;url:string|null;prerelease:boolean|null};
  /** Facts observed at immutable commits, never installation or marketplace claims. */
  issues:string[];
}

function blobSha(content:string):string {
  const bytes=Buffer.from(content,"utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Read-only remote observations. Does not merge, release, list, or activate a package. */
export class PublicationTracker {
  constructor(readonly store:Store,readonly repositories:()=>string[],readonly transport:GitHubTransport,readonly now:()=>number=Date.now){}
  history(publicationId:string):PublicationObservation[] {
    return this.store.list<PublicationObservation>("publication-observations").filter(item=>item.publicationId===publicationId).sort((a,b)=>a.sequence-b.sequence);
  }
  latest(publicationId:string):PublicationObservation|null {return this.store.get("publication-observation-latest",publicationId);}

  async reconcile(publicationId:string,releaseTag?:string):Promise<PublicationObservation> {
    if(typeof publicationId!=="string"||!publicationId||publicationId.length>200)throw new Error("invalid publication ID");
    if(releaseTag!==undefined&&(!releaseTag.length||releaseTag.length>200||/[\x00-\x20\x7f]/.test(releaseTag)))throw new Error("invalid release tag");
    const publication=publicationSchema.parse(this.store.get("publications",publicationId));
    if(publication.id!==publicationId)throw new Error("publication identity mismatch");
    if(!this.repositories().includes(publication.repository))throw new Error("Publication repository is no longer allowed");
    assertSafeArtifactPath(publication.directory);
    const draft=this.store.get<ExportDraft>("export-drafts",publication.draftId);
    if(!draft||draft.id!==publication.draftId||draft.bundleSha256!==publication.bundleSha256||hash(stableJson(draft.files))!==draft.bundleSha256)throw new Error("publication bundle changed");
    if(!draft.files.length||draft.files.length>100)throw new Error("invalid publication file count");
    const paths=new Set<string>();
    for(const file of draft.files){assertSafeArtifactPath(file.path);if(paths.has(file.path))throw new Error("duplicate publication file");paths.add(file.path);}
    const binding=stableJson({publication,draft});
    const sequence=this.store.transaction(()=>{
      const current=this.store.get<{sequence:number}>("publication-observation-cursors",publicationId)?.sequence??0;
      if(!Number.isSafeInteger(current)||current<0||current===Number.MAX_SAFE_INTEGER)throw new Error("invalid publication observation cursor");
      this.store.put("publication-observation-cursors",publicationId,{sequence:current+1});return current+1;
    });
    const observation:PublicationObservation={id:stableId("publication-observation",`${publicationId}:${sequence}`),publicationId,draftId:draft.id,solutionId:draft.solutionId,revision:draft.revision,bundleSha256:draft.bundleSha256,sequence,observedAtMs:0,releaseTag:releaseTag??null,
      review:{state:publication.url?"unknown":"unsubmitted",url:null,headCommit:null,submittedCommitChanged:null},
      repository:{state:"unconfirmed",commit:null,url:null},
      release:{state:releaseTag?"unconfirmed":"not-requested",tag:releaseTag??null,commit:null,url:null,prerelease:null},issues:[]};
    const root=`repos/${publication.repository}/`,get=(path:string)=>{
      if(!this.repositories().includes(publication.repository))throw new Error("Publication repository is no longer allowed");
      return this.transport.call("GET",root+path);
    };
    const resolveTag=async(tag:string):Promise<string>=>{
      const target=z.object({type:z.enum(["commit","tag"]),sha});
      const ref=z.object({ref:z.string(),object:target}).parse(await get(`git/ref/tags/${encodeURIComponent(tag)}`));
      if(ref.ref!==`refs/tags/${tag}`)throw new Error("release reference mismatch");
      let object=ref.object;const visited=new Set<string>();
      while(object.type==="tag"){
        if(visited.size>=5||visited.has(object.sha))throw new Error("release tag chain unavailable");
        visited.add(object.sha);
        const annotated=z.object({sha,object:target}).parse(await get(`git/tags/${object.sha}`));
        if(annotated.sha!==object.sha)throw new Error("release tag object mismatch");
        object=annotated.object;
      }
      return object.sha;
    };
    const available=async(commit:string,files:ArtifactFile[]):Promise<boolean>=>{
      const entry=z.object({sha,tree:z.object({sha})}).parse(await get(`git/commits/${commit}`));
      if(entry.sha!==commit)throw new Error("remote commit identity mismatch");
      const tree=z.object({sha,truncated:z.literal(false),tree:z.array(z.object({path:z.string(),type:z.string(),mode:z.string(),sha}))}).parse(await get(`git/trees/${entry.tree.sha}?recursive=1`));
      if(tree.sha!==entry.tree.sha)throw new Error("remote tree identity mismatch");
      const prefix=publication.directory+"/",inside=tree.tree.filter(row=>row.path.startsWith(prefix)&&row.type!=="tree");
      if(inside.length!==files.length)return false;
      return files.every(file=>{
        const matches=inside.filter(row=>row.path===prefix+file.path);
        return matches.length===1&&matches[0]!.type==="blob"&&matches[0]!.mode==="100644"&&matches[0]!.sha===blobSha(file.content);
      });
    };
    if(publication.url){
      const url=new URL(publication.url),prefix=`/${publication.repository}/pull/`;
      if(url.protocol!=="https:"||url.host!=="github.com"||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(prefix)||!/^\d+$/.test(url.pathname.slice(prefix.length)))throw new Error("invalid saved publication URL");
      observation.review.url=publication.url;
      try {
        const pull=z.object({number:z.number().int().positive(),state:z.enum(["open","closed"]),merged:z.boolean(),head:z.object({sha}),merge_commit_sha:sha.nullable()}).parse(await get(`pulls/${url.pathname.slice(prefix.length)}`));
        if(String(pull.number)!==url.pathname.slice(prefix.length)||pull.merged&&pull.state!=="closed")throw new Error("remote review identity mismatch");
        observation.review={state:pull.merged?"merged":pull.state,url:publication.url,headCommit:pull.head.sha,submittedCommitChanged:publication.commit?publication.commit!==pull.head.sha:null};
        if(pull.merged){
          if(!pull.merge_commit_sha)throw new Error("merged commit unavailable");
          observation.repository={state:await available(pull.merge_commit_sha,draft.files)?"available":"content-changed",commit:pull.merge_commit_sha,url:`https://github.com/${publication.repository}/tree/${pull.merge_commit_sha}/${publication.directory}`};
        }
      } catch {observation.issues.push("review-or-merged-content-not-confirmed");}
    }
    if(releaseTag){
      try {
        const release=z.object({tag_name:z.string(),draft:z.boolean(),prerelease:z.boolean(),published_at:z.string().nullable()}).parse(await get(`releases/tags/${encodeURIComponent(releaseTag)}`));
        if(release.tag_name!==releaseTag)throw new Error("release tag mismatch");
        observation.release.prerelease=release.prerelease;
        if(release.draft)observation.release.state="draft";
        else {
          if(release.published_at===null||!Number.isFinite(Date.parse(release.published_at)))throw new Error("release publication time unavailable");
          const commit=await resolveTag(releaseTag);
          observation.release={state:await available(commit,draft.files)?"released":"content-changed",tag:releaseTag,commit,url:`https://github.com/${publication.repository}/releases/tag/${encodeURIComponent(releaseTag)}`,prerelease:release.prerelease};
        }
      } catch {observation.issues.push("release-not-confirmed");}
    }
    observation.observedAtMs=this.now();
    if(!Number.isSafeInteger(observation.observedAtMs)||observation.observedAtMs<0)throw new Error("invalid observation time");
    return this.store.transaction(()=>{
      const current=publicationSchema.parse(this.store.get("publications",publicationId)),currentDraft=this.store.get<ExportDraft>("export-drafts",publication.draftId);
      if(stableJson({publication:current,draft:currentDraft})!==binding||!this.repositories().includes(publication.repository))throw new Error("publication changed during observation");
      if(!this.store.insert("publication-observations",observation.id,observation,observation.observedAtMs))throw new Error("publication observation already recorded");
      if(this.store.get<{sequence:number}>("publication-observation-cursors",publicationId)?.sequence===sequence)this.store.put("publication-observation-latest",publicationId,observation,observation.observedAtMs);
      return observation;
    });
  }
}
