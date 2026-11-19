import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import type { createRevalidation } from "./revalidation.js";
import type { createRevalidationWorkloads } from "./revalidation-workload.js";
import type { createRevalidationDraftEditor } from "./revalidation-edit.js";
import type { createRevalidationEnvironmentObserver } from "./revalidation-environment.js";
import type { createRevalidationRunner } from "./revalidation-runner.js";
import type { ExecutionSelection } from "./native-execution.js";
import type { Solution } from "./domain/types.js";
import { resolveSolutionHistory } from "./solution-history.js";
import { freezeRevalidationSchema, queueRevalidationSchema, revalidationTargetSchema, type RevalidationTarget, type FrozenRevalidationPlan } from "./revalidation-contract.js";
import type { EditRevalidationDraft } from "./revalidation-edit-contract.js";

export interface RevalidationArtifactChoice { target:RevalidationTarget; title:string; content:string; origin:"exploratory"|"historical"; }
export interface RevalidationOwnerOptions {
  store:Store; domain:ReturnType<typeof createRevalidation>; workloads:ReturnType<typeof createRevalidationWorkloads>;
  editDraft:ReturnType<typeof createRevalidationDraftEditor>;
  observer:Pick<ReturnType<typeof createRevalidationEnvironmentObserver>,"observe">;
  runner:Pick<ReturnType<typeof createRevalidationRunner>,"cancel">;
  selection:()=>ExecutionSelection|null; currency:()=>string; redact:(value:string)=>string; changed:()=>void;
}
const owner={kind:"owner" as const,id:"dashboard"};
/** Authenticated owner adapter. Scientific outcomes and receipt-writing are never public methods. */
export function createRevalidationOwnerApi(options:RevalidationOwnerOptions){
  const {store,domain,workloads}=options;
  return {
    overview(solutionId?:string){
      const family=solutionId===undefined?null:new Set(resolveSolutionHistory(store,solutionId).solutionIds);
      const solutions=store.list<Solution>("solutions"),artifacts:RevalidationArtifactChoice[]=[];
      const warnings:string[]=[];
      const seen=new Set<string>();
      const add=(rawTarget:unknown,content:unknown)=>{
        const parsed=revalidationTargetSchema.safeParse(rawTarget);
        if(!parsed.success||typeof content!=="string"){warnings.push("An artifact has incomplete identity and cannot be selected.");return;}
        const target=parsed.data;
        if(family&&!family.has(target.solutionId))return;
        const solution=solutions.find(item=>item.id===target.solutionId);if(!solution)return;
        if(createHash("sha256").update(content).digest("hex")!==target.artifactDigest){warnings.push("An artifact has incomplete identity and cannot be selected.");return;}
        if(options.redact(content)!==content){warnings.push("An artifact is unavailable under the current text policy.");return;}
        const identity=JSON.stringify(target);if(seen.has(identity))return;seen.add(identity);
        artifacts.push({target,title:solution.title,content,origin:target.namespace==="native-evaluation-artifacts"?"exploratory":"historical"});
      };
      for(const namespace of ["native-evaluation-artifacts","built-artifacts","validated-artifacts"] as const){
        for(const entry of store.entries<{solutionId:string;revision:string;kind:string;content:string;artifactDigest:string}>(namespace)){
          const artifact=entry.value;
          if(artifact.kind!=="instruction")continue;
          add({solutionId:artifact.solutionId,namespace,artifactId:entry.key,revision:artifact.revision,artifactDigest:artifact.artifactDigest},artifact.content);
        }
      }
      // Frozen prior revisions remain selectable after a mutable artifact pointer advances.
      for(const frozen of store.list<FrozenRevalidationPlan>("revalidation-frozen"))add(frozen.artifact.target,frozen.artifact.content);
      return {artifacts,plans:domain.plans.list().filter(plan=>family===null||family.has(plan.definition.target.solutionId)),selection:options.selection(),currency:options.currency(),warnings:[...new Set(warnings)]};
    },
    detail(planId:string){
      const selected=domain.plans.get(planId),history=domain.plans.history(planId),reference=selected.plan.definition.workload;
      return {...selected,...history,workload:reference&&"id" in reference?workloads.get(reference.id,reference.version):null,
        runVersions:Object.fromEntries(history.runs.map(run=>[run.id,domain.plans.getRun(run.id).version])),
        usageByRun:Object.fromEntries(history.runs.map(run=>[run.id,domain.plans.usage(run.id)]))};
    },
    edit(input:EditRevalidationDraft){const result=options.editDraft(input,owner);options.changed();return result;},
    async freeze(raw:Parameters<typeof domain.plans.freeze>[0],signal?:AbortSignal){
      const input=freezeRevalidationSchema.parse(raw),selected=domain.plans.get(input.planId).plan;
      if(selected.version!==input.expectedVersion)throw new Error("revalidation-version-conflict");
      if(!selected.definition.environment)throw new Error("revalidation-plan-incomplete");
      await options.observer.observe(selected.definition.environment,signal);
      if(signal?.aborted)throw new Error("revalidation-freeze-cancelled");
      const result=domain.plans.freeze(input,owner);options.changed();return result;
    },
    queue(raw:Parameters<typeof domain.plans.queue>[0]){
      const input=queueRevalidationSchema.parse(raw);
      const result=store.transaction(()=>{
        const run=domain.plans.queue(input,owner);
        const jobId=run.status==="queued"?store.enqueue("builder",`revalidation:${run.id}`,{kind:"revalidation",revalidationRunId:run.id}):null;
        return {run,jobId};
      });options.changed();return result;
    },
    cancel(input:Parameters<typeof domain.plans.cancel>[0]){
      const run=domain.plans.cancel(input,owner);
      try{options.runner.cancel(run.id);}finally{options.changed();}
      return run;
    },
    repairQueuedJobs(){
      for(const run of store.list<{id:string;status:string}>("revalidation-runs"))if(run.status==="queued")store.enqueue("builder",`revalidation:${run.id}`,{kind:"revalidation",revalidationRunId:run.id});
    },
  };
}
export type RevalidationOwnerApi=ReturnType<typeof createRevalidationOwnerApi>;
