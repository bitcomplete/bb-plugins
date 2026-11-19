import { applyImprovement } from "./improvements.js";
import type { Store } from "./store.js";
import type { Config } from "./config.js";
import { Deferred, type StageContext } from "./services.js";
import type { Problem, Solution } from "./domain/types.js";
import { candidateEligibility } from "./domain/solutions.js";
import { resolveProblemId } from "./domain/problems.js";
import { compareIds, stableId, stableJson } from "./domain/shared.js";
import type { PrivacyPolicy } from "./adapters/privacy.js";
import { evaluateInstruction, type BuiltArtifact, type EvaluationSuite, type ProposalHistoryEntry, type NativeEvaluationAttempt } from "./evaluation.js";
import type { NativeExecution, TaskRunner } from "./native-tasks.js";
import type { ValidatedArtifact } from "./publication.js";

export interface BuilderOptions {
  store:Store;config:()=>Config;runner:TaskRunner;execution:()=>NativeExecution;
  suite:()=>string|undefined;privacy:()=>PrivacyPolicy;privacyGeneration:()=>string;
  /** Retained for host construction compatibility; ordinary native evaluation writes no local manifest repository. */
  directory?:string;
}

/** Read every related direction, not only the selected candidate's attempts. */
function linkedProposalHistory(store: Store, candidate: Solution): ProposalHistoryEntry[] {
  const problems = store.list<Problem>("problems");
  const linked = new Set(candidate.problemIds.map(id => resolveProblemId(problems, id)));
  const knownProblems = new Set(problems.flatMap(problem => [problem.id, ...problem.aliases]));
  return store.list<Solution>("solutions")
    // An unrelated historic record can retain a reference to a removed problem.
    // It must not prevent reading known related histories or become a wildcard match.
    .filter(solution => solution.problemIds.some(id => knownProblems.has(id) && linked.has(resolveProblemId(problems, id))))
    .flatMap(solution => solution.attempts.map(attempt => ({ solutionId: solution.id, attemptId: attempt.id, value: {
      outcome: attempt.outcome, reason: attempt.reason, atMs: attempt.atMs,
      prediction: attempt.prediction, model: attempt.model, mechanism: solution.mechanism, solutionStatus: solution.status,
    } })))
    .sort((a, b) => a.value.atMs - b.value.atMs || compareIds(a.solutionId, b.solutionId) || compareIds(a.attemptId, b.attemptId))
    .map(entry => entry.value);
}

/** Produces exploratory instruction artifacts. Activation is blocked without independently verified BB isolation. */
export function createBuilder(options:BuilderOptions) {
  return async(context:StageContext,candidate:Solution,retest:boolean):Promise<Record<string,number>>=>{
    const {store}=options,config=options.config(),rawSuite=options.suite(),execution=structuredClone(options.execution());
    const selected=store.get<Solution>("solutions",candidate.id);if(!selected)throw new Error("native-builder-candidate-missing");candidate=selected;
    if(!rawSuite)throw new Deferred("configure-development-evaluation-suite");
    if(context.job.input.execution!==undefined&&stableJson(context.job.input.execution)!==stableJson(execution))throw new Deferred("retest-execution-changed");
    const attemptId=stableId("native-build-attempt",context.job.id),saved=store.get<NativeEvaluationAttempt>("native-evaluation-attempts",attemptId);
    if(saved&&(saved.solutionId!==candidate.id||saved.revision!==context.job.id))throw new Error("native-builder-job-identity-changed");
    if(!retest&&!saved){
      const eligibility=candidateEligibility(candidate,store.list("problems"),store.list("solutions"),Date.now());
      if(!eligibility.eligible){store.put("build-decisions",context.job.id,{solutionId:candidate.id,status:"deferred",reasons:eligibility.reasons});return {deferred:1};}
      if((candidate.scores.safety??0)<.8){store.put("build-decisions",context.job.id,{solutionId:candidate.id,status:"needs-owner-decision",reasons:["Estimated safety below the autonomous build threshold"]});return {riskDecisions:1};}
    }
    const previous=store.get<ValidatedArtifact>("validated-artifacts",candidate.id);
    if(retest&&(!previous||(typeof context.job.input.artifactRevision==="string"&&previous.revision!==context.job.input.artifactRevision)))throw new Error("retest-artifact-changed");
    const source=retest&&previous?store.list<BuiltArtifact>("built-artifacts").find(a=>a.solutionId===candidate.id&&a.revision===previous.revision&&a.artifactDigest===previous.artifactDigest):null;
    if(retest&&!source)throw new Error("retest-source-artifact-missing");
    let suite:EvaluationSuite;try{suite=JSON.parse(rawSuite) as EvaluationSuite;}catch{throw new Deferred("invalid-development-evaluation-suite");}
    const runId=context.job.runId??`${context.job.id}:${context.job.attempts}`,privacyGeneration=options.privacyGeneration();
    // The evaluator durably records running work before dispatch. Publish the decision only after
    // it accepts this immutable request, so a rejected retry cannot overwrite prior attribution.
    const attempt=await evaluateInstruction({store,attemptId,solutionId:candidate.id,revision:context.job.id,suite,runner:options.runner,execution,runId,privacyGeneration,currentPrivacyGeneration:options.privacyGeneration,
      // An empty list means every project except the worker project receives improvements.
      scopeProjectIds:config.scopeProjectIds.length?config.scopeProjectIds:["all-projects"],timeoutMs:config.taskTimeoutMs,...(source?{retestArtifactId:source.id}:{}),signal:context.signal,privacy:options.privacy,history:()=>linkedProposalHistory(store,candidate)});
    // A fix that beat the run without it, with no regressions, is applied automatically unless the owner turned that off.
    const passed=attempt.status==="completed"&&attempt.observationVerdict==="gain-without-regression"&&!!attempt.artifactId;
    const applied=passed&&config.autoApply?applyImprovement(store,{solutionId:candidate.id,artifactId:attempt.artifactId!,attemptId,source:"automatic"},{kind:"service",id:"native-builder"}):null;
    store.put("build-decisions",context.job.id,{solutionId:candidate.id,attemptId,status:applied?"applied":passed?"passed-awaiting-apply":"not-passed",reasons:applied||passed?[]:[attempt.observationVerdict],execution,executionStatus:attempt.status,observationVerdict:attempt.observationVerdict,artifactId:attempt.artifactId,evidenceKind:attempt.evidenceKind});
    return {tested:1,exploratory:1,completed:Number(attempt.status==="completed"),gainObserved:Number(passed),applied:Number(!!applied),adoptionBlocked:0,adopted:Number(!!applied),failed:Number(attempt.status==="failed"),cancelled:Number(attempt.status==="cancelled"),interrupted:Number(attempt.status==="interrupted")};
  };
}
