import type { CandidateDerivation, Ledgers, PaperSource, Solution, SolutionMerge } from "./types.js";
import { compareIds, stableJson, unique } from "./shared.js";

/** Exact normalized mechanism and direction, on the same canonical problem set. */
export function candidateDirectionKey(solution: Solution, problemIds = solution.problemIds): string {
  return stableJson([solution.directionKey, solution.mechanism.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim(), unique(problemIds)]);
}
export function resolveSolutionId(solutions: Solution[], id: string): string {
  const matches = solutions.filter(s => s.id === id || s.aliases.includes(id));
  if (matches.length !== 1) throw new Error(matches.length ? "conflicting solution alias" : "unknown solution");
  return matches[0]!.id;
}
const ordered = (a: Solution, b: Solution) => a.createdAtMs - b.createdAtMs || compareIds(a.id, b.id);
const distinct = <T>(values: T[]): T[] => [...new Map(values.map(value => [stableJson(value), value])).entries()].sort(([a], [b]) => compareIds(a,b)).map(([,value]) => value);
export const candidatePapers = (s: Solution): PaperSource[] => distinct([...(s.sourcePaper ? [s.sourcePaper] : []), ...(s.paperSources ?? [])]);
const definition = (s: Pick<Solution, "origin" | "sourcePaper" | "mechanism" | "assumptions" | "testPlan" | "prediction" | "portability">) => ({ origin:s.origin, sourcePaper:s.sourcePaper, mechanism:s.mechanism, assumptions:s.assumptions, testPlan:s.testPlan, prediction:s.prediction, ...(s.portability === undefined ? {} : { portability:s.portability }) });
/** Only merge code constructs these from retained originals; no model/public edit accepts them. */
export function candidateDerivation(s: Solution): CandidateDerivation | null {
  const proof = s.sourceDerivation;
  if (!proof) {
    // A standalone paper-derived record cannot acquire an independent invention
    // identity merely because another draft is merged into it.
    if (s.origin === "inventor" && s.paperSources?.length) return null;
    if (!Number.isFinite(s.createdAtMs) || s.createdAtMs < 0) return null;
    return { originalId:s.id, originalCreatedAtMs:s.createdAtMs, ...definition(s), provenance:s.provenance };
  }
  if (!s.aliases.length || ![s.id,...s.aliases].includes(proof.originalId) || !Number.isFinite(proof.originalCreatedAtMs) || proof.originalCreatedAtMs < 0 || stableJson(definition(proof)) !== stableJson(definition(s)) || !proof.provenance.length || proof.provenance.some(p => !s.provenance.some(retained => stableJson(retained) === stableJson(p)))) return null;
  return proof;
}
/** Evaluated identities are never absorbed: receipts, costs and undo keep their original IDs. */
export function untestedCandidate(s: Solution): boolean {
  return s.status === null && s.candidateState !== "built" && s.candidateState !== "rejected" && s.wiring === null && s.builtWith === null && s.validatedWith === null && s.attempts.every(a => a.outcome === "proposed");
}
function anchors(s: Solution): boolean { return s.status !== "removed" && (s.status !== null || s.candidateState === "built" || s.wiring !== null || s.builtWith !== null || s.validatedWith !== null); }
function sourcePriority(s: Solution): number {
  const source = candidateDerivation(s);
  if (!source?.provenance.length) return 3;
  if (source.origin === "inventor") return source.sourcePaper === null && source.provenance.every(p => p.origin === "inventor") && (s.sourceDerivation !== undefined || !s.paperSources?.length) ? 0 : 3;
  const paper = source.sourcePaper;
  if (!paper) return 3;
  const c = paper.credibility;
  // This selects a representative, not an eligibility verdict. The ordinary
  // current-time paper age and credibility gates still run before building.
  return c.status === "passed" && c.fieldWeightedCitationImpact !== null && Number.isFinite(c.fieldWeightedCitationImpact) && c.fieldWeightedCitationImpact >= 0 && c.authorSignal !== null && Number.isFinite(c.authorSignal) && c.authorSignal >= 0 && c.evidenceUrls.length > 0 && Number.isFinite(paper.publishedAtMs) && /^https:\/\//.test(paper.url) && paper.id.trim() && paper.version.trim() ? 1 : 2;
}
function sourceOrder(a: Solution, b: Solution): number {
  const left = candidateDerivation(a), right = candidateDerivation(b);
  // Prefer the oldest complete paper: if any independently eligible paper has
  // aged past the gate, a younger duplicate cannot replace it. No clock is
  // needed here; candidateEligibility still applies the current rubric/time.
  const publication = (s: CandidateDerivation | null) => Number.isFinite(s?.sourcePaper?.publishedAtMs) ? s!.sourcePaper!.publishedAtMs : Number.MAX_VALUE;
  return sourcePriority(a) - sourcePriority(b)
    || publication(left) - publication(right)
    || (left?.originalCreatedAtMs ?? a.createdAtMs) - (right?.originalCreatedAtMs ?? b.createdAtMs)
    || compareIds(left?.originalId ?? a.id, right?.originalId ?? b.id);
}

/** Input problem links must already be canonical. No semantic/model equivalence guesses. */
export function mergeSolutionCandidates(solutions: Solution[]): Pick<Ledgers, "solutions" | "solutionMerges" | "solutionMergeConflicts"> {
  const groups = new Map<string, Solution[]>(), ids = new Set<string>(), identities = new Map<string,string>();
  for (const s of solutions) {
    if (ids.has(s.id)) throw new Error("duplicate solution identity"); ids.add(s.id);
    for (const id of [s.id,...s.aliases]) {
      const previous = identities.get(id);
      if (previous && previous !== s.id) throw new Error("conflicting solution alias");
      identities.set(id,s.id);
    }
    const key = candidateDirectionKey(s); groups.set(key, [...(groups.get(key) ?? []), structuredClone(s)]);
  }
  const result: Solution[] = [], merges: SolutionMerge[] = [], conflicts: NonNullable<Ledgers["solutionMergeConflicts"]> = [];
  for (const group of groups.values()) {
    group.sort(ordered);
    const bound = group.filter(anchors), drafts = group.filter(untestedCandidate);
    if (bound.length > 1) conflicts.push({ solutionIds: unique(bound.map(s => s.id)), reason: "Duplicate evaluated directions retain separate artifact identities; owner review is required" });
    const canonical = bound[0] ?? drafts[0];
    if (!canonical) { result.push(...group); continue; }
    const absorbed = drafts.filter(s => s.id !== canonical.id);
    if (!absorbed.length) { result.push(...group); continue; }
    const members = [canonical, ...absorbed];
    const papers = distinct(members.flatMap(candidatePapers));
    const representative = untestedCandidate(canonical) ? [...members].sort(sourceOrder)[0]! : canonical;
    const source = candidateDerivation(representative);
    const updated: Solution = { ...canonical,
      aliases: unique(members.flatMap(s => [s.id, ...s.aliases])).filter(id => id !== canonical.id),
      provenance: distinct(members.flatMap(s => s.provenance)), newEvidenceIds: unique(members.flatMap(s => s.newEvidenceIds)),
      attempts: distinct(members.flatMap(s => s.attempts)),
      ...(papers.length ? { paperSources: papers } : {}),
    };
    if (untestedCandidate(canonical)) {
      // Use one independently qualified derivation. Adding an uncertain citation
      // neither invalidates a real invention nor grants a paper an exemption.
      Object.assign(updated, definition(representative));
      // The selected variant owns the whole declaration. An older undeclared
      // representative must not inherit requirements from the canonical record.
      if (representative.portability === undefined) delete updated.portability;
      updated.scores = { fit:null, benefit:null, testability:null, feasibility:null, safety:null, effort:null };
      updated.scoreReasons = { fit:"Merged discovery awaits independent ranking", benefit:"Untested hypothesis", testability:"Merged discovery awaits independent ranking", feasibility:"Merged discovery awaits independent ranking", safety:"Merged discovery awaits independent review", effort:"Merged discovery awaits independent ranking" };
      updated.candidateState = "proposed";
    }
    // Invalid originals stay invalid. Never manufacture an independent source.
    if (source) updated.sourceDerivation = structuredClone(source);
    for (const original of absorbed) merges.push({ canonicalId: canonical.id, canonicalBefore: canonical, absorbed: original, reason: "exact-direction-and-canonical-problems" });
    result.push(updated, ...group.filter(s => s.id !== canonical.id && !absorbed.some(a => a.id === s.id)));
  }
  result.sort((a,b) => compareIds(a.id,b.id));
  const references = new Map<string,string>();
  for (const s of result) for (const id of [s.id,...s.aliases]) { const previous = references.get(id); if (previous && previous !== s.id) throw new Error("conflicting solution alias"); references.set(id,s.id); }
  return { solutions: result, ...(merges.length ? { solutionMerges: merges.sort((a,b)=>compareIds(a.absorbed.id,b.absorbed.id)) } : {}), ...(conflicts.length ? { solutionMergeConflicts: conflicts.sort((a,b)=>compareIds(stableJson(a),stableJson(b))) } : {}) };
}
