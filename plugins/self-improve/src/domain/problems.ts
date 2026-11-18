import type { Ledgers, Problem, Symptom } from "./types.js";
import { compareIds, finite, stableJson, text, unique } from "./shared.js";
import { mergeSolutionCandidates, resolveSolutionId } from "./candidates.js";

function identityMap(problems: Problem[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const p of problems) {
    text(p.id, "problem ID");
    if (result.has(p.id)) throw new Error(`conflicting problem identity ${p.id}`);
    result.set(p.id, p.id);
  }
  for (const p of problems) for (const alias of p.aliases) {
    text(alias, "problem alias");
    const existing = result.get(alias);
    if (existing && existing !== p.id) throw new Error(`conflicting problem alias ${alias}`);
    result.set(alias, p.id);
  }
  return result;
}

export function resolveProblemId(problems: Problem[], id: string): string {
  const canonical = identityMap(problems).get(id);
  if (!canonical) throw new Error(`unknown problem ${id}`);
  return canonical;
}

/** Exact text merging only. A model's semantic match must be applied explicitly by its caller. */
export function mergeLedgers(input: Ledgers): Ledgers {
  const ledgers = structuredClone(input);
  const identities = identityMap(ledgers.problems);
  const parent = new Map(ledgers.problems.map(p => [p.id, p.id]));
  const find = (id: string): string => {
    const next = parent.get(id);
    if (next === undefined) throw new Error(`unknown problem ${id}`);
    if (next === id) return id;
    const root = find(next); parent.set(id, root); return root;
  };
  const rootCauses = new Map<string, string>();
  const globalCauses = new Map<string, string>();
  const globalSymptoms = new Set<string>();
  for (const p of ledgers.problems) {
    finite(p.createdAtMs, "problem creation time");
    if (!p.causes.length) throw new Error(`problem ${p.id} has no cause`);
    const ownCauses = new Set<string>();
    for (const cause of p.causes) {
      text(cause.id, "cause ID"); text(cause.text, "cause text");
      if (ownCauses.has(cause.id) || (globalCauses.has(cause.id) && globalCauses.get(cause.id) !== cause.text)) throw new Error(`conflicting cause ID ${cause.id}`);
      ownCauses.add(cause.id); globalCauses.set(cause.id, cause.text);
      const matching = rootCauses.get(cause.text);
      if (matching !== undefined) {
        const left = find(p.id), right = find(matching);
        const canonical = [left, right].sort(compareIds)[0]!;
        parent.set(left, canonical); parent.set(right, canonical);
      } else rootCauses.set(cause.text, p.id);
    }
    for (const symptom of p.symptoms) {
      text(symptom.id, "symptom ID"); text(symptom.text, "symptom text");
      if (globalSymptoms.has(symptom.id)) throw new Error(`duplicate symptom ID ${symptom.id}`);
      globalSymptoms.add(symptom.id);
      if (!ownCauses.has(symptom.causeId)) throw new Error(`symptom ${symptom.id} references missing cause`);
    }
  }
  const groups = new Map<string, Problem[]>();
  for (const p of ledgers.problems) {
    const root = find(p.id); groups.set(root, [...(groups.get(root) ?? []), p]);
  }
  const problemId = (id: string): string => {
    const actual = identities.get(id);
    if (!actual) throw new Error(`unknown problem ${id}`);
    return find(actual);
  };
  const merged: Problem[] = [];
  const symptomIds = new Map<string, string>();
  for (const [id, group] of groups) {
    group.sort((a, b) => compareIds(a.id, b.id));
    const causesByText = new Map<string, { id: string; text: string }>();
    for (const cause of group.flatMap(p => p.causes).sort((a, b) => compareIds(a.id, b.id))) if (!causesByText.has(cause.text)) causesByText.set(cause.text, cause);
    const causeId = new Map(group.flatMap(p => p.causes).map(c => [c.id, causesByText.get(c.text)!.id]));
    const bySymptom = new Map<string, Symptom>();
    for (const symptom of group.flatMap(p => p.symptoms).sort((a, b) => compareIds(a.id, b.id))) {
      const canonicalCause = causeId.get(symptom.causeId)!, key = stableJson([canonicalCause, symptom.text]);
      const previous = bySymptom.get(key);
      const canonical = previous?.id ?? symptom.id;
      for (const alias of [symptom.id, ...(symptom.aliases ?? [])]) symptomIds.set(alias, canonical);
      if (previous) previous.aliases = unique([...(previous.aliases ?? []), symptom.id, ...(symptom.aliases ?? [])]).filter(id => id !== canonical);
      else bySymptom.set(key, { ...symptom, causeId: canonicalCause });
    }
    const symptoms = [...bySymptom.values()].sort((a, b) => compareIds(a.id, b.id));
    const base = group[0]!;
    const canonicalParent = base.parentId ? problemId(base.parentId) : undefined;
    merged.push({ ...base, id, aliases: unique(group.flatMap(p => [p.id, ...p.aliases])).filter(a => a !== id),
      causes: [...causesByText.values()].sort((a, b) => compareIds(a.id, b.id)), symptoms,
      solutionIds: unique(group.flatMap(p => p.solutionIds)), createdAtMs: Math.min(...group.map(p => p.createdAtMs)),
      status: group.some(p => p.status === "open") ? "open" : group.some(p => p.status === "monitoring") ? "monitoring" : "resolved",
      ...(canonicalParent && canonicalParent !== id ? { parentId: canonicalParent } : { parentId: undefined }) });
  }
  merged.sort((a, b) => compareIds(a.id, b.id));
  const bySolution = new Map(ledgers.solutions.map(s => [s.id, s]));
  if (bySolution.size !== ledgers.solutions.length) throw new Error("duplicate solution identity");
  for (const s of ledgers.solutions) {
    s.problemIds = unique(s.problemIds.map(problemId));
    s.prediction.symptomIds = unique(s.prediction.symptomIds.map(id => symptomIds.get(id) ?? id));
    if (s.sourceDerivation) s.sourceDerivation.prediction.symptomIds = unique(s.sourceDerivation.prediction.symptomIds.map(id => symptomIds.get(id) ?? id));
    for (const attempt of s.attempts) attempt.prediction.symptomIds = unique(attempt.prediction.symptomIds.map(id => symptomIds.get(id) ?? id));
  }
  for (const p of merged) for (const id of p.solutionIds) {
    const s = bySolution.get(resolveSolutionId(ledgers.solutions, id)); if (!s) throw new Error(`unknown linked solution ${id}`);
    s.problemIds = unique([...s.problemIds, p.id]);
  }
  const solutionMerge = mergeSolutionCandidates(ledgers.solutions);
  if (solutionMerge.solutionMerges) {
    const originals = new Map(input.solutions.map(s => [s.id, s]));
    solutionMerge.solutionMerges = solutionMerge.solutionMerges.map(merge => ({ ...merge,
      // Keep the original problem/symptom references too, before canonical-link
      // projection. The live row uses aliases; the archive records what arrived.
      canonicalBefore: structuredClone(originals.get(merge.canonicalId)!),
      absorbed: structuredClone(originals.get(merge.absorbed.id)!),
    }));
  }
  ledgers.solutions = solutionMerge.solutions;
  for (const p of merged) p.solutionIds = unique(p.solutionIds.map(id => resolveSolutionId(ledgers.solutions, id)));
  for (const s of ledgers.solutions) for (const id of s.problemIds) {
    const p = merged.find(p => p.id === id)!; p.solutionIds = unique([...p.solutionIds, s.id]);
  }
  const votes = new Map<string, Ledgers["votes"][number]>();
  for (const v of ledgers.votes.sort((a, b) => compareIds(a.id, b.id))) {
    const canonical = { ...v, problemId: problemId(v.problemId), ...(v.symptomId ? { symptomId: symptomIds.get(v.symptomId) ?? v.symptomId } : {}) };
    const key = stableJson([canonical.problemId, canonical.kind, canonical.symptomId ?? null, canonical.evidence]);
    const previous = votes.get(key);
    if (previous) {
      const { id: _a, ...a } = previous, { id: _b, ...b } = canonical;
      if (stableJson(a) !== stableJson(b)) throw new Error("conflicting votes after problem merge");
    } else votes.set(key, canonical);
  }
  const result = { problems: merged, ...solutionMerge, votes: [...votes.values()], ...(input.solutionMerges?.length ? { solutionMerges: [...input.solutionMerges, ...(solutionMerge.solutionMerges ?? [])] } : {}) };
  assertLedgerIntegrity(result);
  return result;
}

export function linkSolution(input: Ledgers, solutionId: string, problemIds: string[]): Ledgers {
  const result = structuredClone(input);
  solutionId = resolveSolutionId(result.solutions, solutionId);
  const s = result.solutions.find(s => s.id === solutionId);
  if (!s) throw new Error(`unknown solution ${solutionId}`);
  const linked = unique(problemIds.map(id => resolveProblemId(result.problems, id)));
  s.problemIds = linked;
  for (const p of result.problems) p.solutionIds = linked.includes(p.id) ? unique([...p.solutionIds, solutionId]) : p.solutionIds.filter(id => id !== solutionId);
  assertLedgerIntegrity(result);
  return result;
}

export function assertLedgerIntegrity(ledgers: Ledgers): void {
  const ids = identityMap(ledgers.problems), solutions = new Map(ledgers.solutions.map(s => [s.id, s]));
  if (solutions.size !== ledgers.solutions.length) throw new Error("duplicate solution identity");
  for (const p of ledgers.problems) {
    const causes = new Set(p.causes.map(c => c.id));
    for (const s of p.symptoms) if (!causes.has(s.causeId)) throw new Error("symptom cause link is missing");
    for (const id of p.solutionIds) if (!solutions.get(id)?.problemIds.includes(p.id)) throw new Error(`solution link is not bidirectional: ${id}`);
    if (p.parentId && (!ids.has(p.parentId) || ids.get(p.parentId) === p.id)) throw new Error("invalid parent problem link");
    const ancestors = new Set([p.id]);
    let ancestor = p.parentId;
    while (ancestor) {
      const canonical = ids.get(ancestor);
      if (!canonical) throw new Error("invalid parent problem link");
      if (ancestors.has(canonical)) throw new Error("parent problem cycle");
      ancestors.add(canonical);
      ancestor = ledgers.problems.find(p => p.id === canonical)?.parentId;
    }
  }
  for (const s of ledgers.solutions) {
    const symptoms = new Set<string>();
    for (const id of s.problemIds) {
      const canonical = ids.get(id), p = ledgers.problems.find(p => p.id === canonical);
      if (!p || !p.solutionIds.includes(s.id)) throw new Error(`problem link is not bidirectional: ${id}`);
      for (const symptom of p.symptoms) symptoms.add(symptom.id);
    }
    if (s.problemIds.length && s.prediction.symptomIds.some(id => !symptoms.has(id))) throw new Error("prediction symptom is outside linked problems");
  }
  for (const v of ledgers.votes) {
    const p = ledgers.problems.find(p => p.id === ids.get(v.problemId));
    if (!p) throw new Error("vote problem link is missing");
    if (v.symptomId && !p.symptoms.some(s => s.id === v.symptomId)) throw new Error("vote symptom link is missing");
  }
}
