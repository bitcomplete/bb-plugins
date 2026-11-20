import type { Eligibility, Problem, RankedProblem, RankedSolution, Solution, SolutionRubric } from "./types.js";
import { DAY_MS, compareIds, finite, stableJson, text, unique } from "./shared.js";
import { resolveProblemId } from "./problems.js";
import { candidateDirectionKey, candidateDerivation, untestedCandidate } from "./candidates.js";

export const DEFAULT_SOLUTION_RUBRIC: SolutionRubric = {
  version: "candidate-rubric-v1", weights: { fit: 0.3, benefit: 0.25, testability: 0.2, feasibility: 0.15, safety: 0.1 }, effortPenalty: 0.25, paperMinAgeDays: 7,
};
const factors = ["fit", "benefit", "testability", "feasibility", "safety"] as const;
const scored = [...factors, "effort"] as const;

export function candidateEligibility(candidate: Solution, problems: Problem[], history: Solution[], nowMs: number, rubric: SolutionRubric = DEFAULT_SOLUTION_RUBRIC): Eligibility {
  const reasons: string[] = [];
  finite(nowMs, "candidate evaluation time"); finite(rubric.paperMinAgeDays, "paper minimum age");
  if (!candidate.problemIds.length) reasons.push("candidate needs a concrete linked problem");
  const linked: string[] = [];
  for (const id of candidate.problemIds) {
    try { linked.push(resolveProblemId(problems, id)); } catch { reasons.push(`unknown linked problem ${id}`); }
  }
  if (!candidate.mechanism.trim()) reasons.push("candidate has no mechanism");
  if (!candidate.directionKey.trim()) reasons.push("candidate has no direction identity");
  if (!candidate.testPlan.trim()) reasons.push("candidate needs a falsifiable test plan");
  if (!candidate.prediction.change.trim() || !candidate.prediction.symptomIds.length) reasons.push("candidate needs predicted symptoms and change");
  const symptoms = new Set(problems.filter(p => linked.includes(p.id)).flatMap(p => p.symptoms.map(s => s.id)));
  if (candidate.prediction.symptomIds.some(id => !symptoms.has(id))) reasons.push("prediction references symptoms outside its linked problems");
  if (!Number.isFinite(candidate.prediction.kpi.target) || !candidate.prediction.kpi.name.trim()) reasons.push("candidate needs a finite named KPI target");
  if (candidate.status !== null || candidate.candidateState === "built") reasons.push("candidate is already built or has a lifecycle status");
  if (candidate.candidateState === "rejected") reasons.push("candidate was rejected");
  if (!candidate.provenance.length) reasons.push("candidate has no provenance");
  const derivation = candidateDerivation(candidate);
  if (!derivation) reasons.push("candidate source derivation is invalid");
  else if (derivation.origin === "inventor") {
    if (derivation.sourcePaper !== null || (!candidate.sourceDerivation && candidate.paperSources?.length)) reasons.push("invention must not claim a source paper");
    if (derivation.provenance.some(p => p.origin === "paper")) reasons.push("paper-derived provenance cannot bypass the paper gate as an invention");
  } else if (derivation.origin === "paper") {
    const paper = derivation.sourcePaper;
    if (!paper) reasons.push("paper candidate has no source paper");
    else {
      if (!Number.isFinite(paper.publishedAtMs) || paper.publishedAtMs > nowMs || nowMs - paper.publishedAtMs < rubric.paperMinAgeDays * DAY_MS) reasons.push("paper is younger than the minimum age");
      if (paper.credibility.status !== "passed") reasons.push("paper credibility gate has not passed");
      const c = paper.credibility;
      if (c.fieldWeightedCitationImpact === null || !Number.isFinite(c.fieldWeightedCitationImpact) || c.fieldWeightedCitationImpact < 0 || c.authorSignal === null || !Number.isFinite(c.authorSignal) || c.authorSignal < 0 || !c.evidenceUrls.length) reasons.push("paper credibility evidence is incomplete");
      if (!/^https:\/\//.test(paper.url) || !paper.id.trim() || !paper.version.trim()) reasons.push("paper reference is incomplete");
    }
  } else reasons.push("unknown candidate origin");
  const priorDirections = history.filter(s => s.problemIds.some(id => {
    try { return linked.includes(resolveProblemId(problems, id)); } catch { return false; }
  }));
  const direction = candidateDirectionKey(candidate, linked);
  const duplicates = priorDirections.filter(s => {
    if (s.id === candidate.id) return false;
    // History may retain a removed problem reference alongside a live one.
    // It is not an exact-scope duplicate and must not abort all ranking.
    try { return candidateDirectionKey(s, s.problemIds.map(id => resolveProblemId(problems, id))) === direction; }
    catch { return false; }
  });
  if (duplicates.some(s => s.status !== "removed" && (s.status !== null || s.candidateState === "built" || s.wiring !== null))) reasons.push("same direction already has an evaluated solution; retest its existing identity");
  if (untestedCandidate(candidate) && duplicates.some(untestedCandidate)) reasons.push("duplicate candidate direction must be merged before building");
  const failed = [...candidate.attempts, ...priorDirections.flatMap(s => s.attempts)].filter(a => a.directionKey === candidate.directionKey && ["failed", "rejected", "removed"].includes(a.outcome));
  const removed = priorDirections.filter(s => s.directionKey === candidate.directionKey && s.status === "removed");
  if (failed.length || removed.length) {
    const seenEvidence = new Set([...candidate.attempts.flatMap(a => a.evidenceIds), ...priorDirections.filter(s => s.id !== candidate.id).flatMap(s => [...s.newEvidenceIds, ...s.attempts.flatMap(a => a.evidenceIds)])]);
    if (!candidate.newEvidenceIds.some(id => id.trim() && !seenEvidence.has(id))) reasons.push("repeated failed or removed direction requires new evidence");
  }
  return { eligible: reasons.length === 0, reasons: unique(reasons) };
}

export function rankSolutions(candidates: Solution[], problems: Problem[], priorities: RankedProblem[], nowMs: number, rubric: SolutionRubric = DEFAULT_SOLUTION_RUBRIC, history: Solution[] = candidates): RankedSolution[] {
  text(rubric.version, "rubric version"); finite(rubric.effortPenalty, "effort penalty");
  let totalWeight = 0;
  for (const factor of factors) { finite(rubric.weights[factor], `${factor} weight`); totalWeight += rubric.weights[factor]; }
  if (totalWeight === 0) throw new Error("candidate rubric needs a positive weight");
  const priority = new Map<string, number>();
  for (const p of priorities) { finite(p.score, "problem priority"); priority.set(resolveProblemId(problems, p.problemId), p.score); }
  const maxPriority = Math.max(0, ...priority.values());
  const ids = new Set<string>();
  const results = candidates.map(candidate => {
    text(candidate.id, "candidate ID"); if (ids.has(candidate.id)) throw new Error("duplicate candidate ID"); ids.add(candidate.id);
    const eligibility = candidateEligibility(candidate, problems, history.filter(s => s.id !== candidate.id), nowMs, rubric);
    const missingFactors = scored.filter(f => candidate.scores[f] === null);
    for (const factor of scored) {
      const value = candidate.scores[factor]; if (value === null) continue;
      finite(value, `candidate score ${factor}`, factor === "effort" ? Number.MIN_VALUE : 0);
      if (factor !== "effort" && value > 1) throw new Error(`candidate score ${factor} must be at most one`);
      if (!candidate.scoreReasons[factor]?.trim()) throw new Error(`candidate score ${factor} needs a reason`);
    }
    const problemPriority = Math.max(0, ...candidate.problemIds.map(id => {
      try { return priority.get(resolveProblemId(problems, id)) ?? 0; } catch { return 0; }
    }));
    const eligible = eligibility.eligible && missingFactors.length === 0;
    let score: number | null = null;
    if (eligible) {
      const quality = factors.reduce((sum, f) => sum + candidate.scores[f]! * rubric.weights[f], 0) / totalWeight;
      score = quality * (maxPriority > 0 ? problemPriority / maxPriority : 1) / (1 + rubric.effortPenalty * candidate.scores.effort!);
    }
    return { solutionId: candidate.id, eligible, reasons: [...eligibility.reasons, ...(missingFactors.length ? [`missing score estimates: ${missingFactors.join(", ")}`] : [])], score, problemPriority, missingFactors: [...missingFactors], rank: null } as RankedSolution;
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.score ?? -1) - (a.score ?? -1) || compareIds(a.solutionId, b.solutionId));
  let rank = 0;
  for (const result of results) if (result.eligible) result.rank = ++rank;
  return results;
}
