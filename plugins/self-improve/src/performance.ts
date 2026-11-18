import type { ActivityCostView } from "./activity-view.js";
import type { Store } from "./store.js";
import type { EvaluationWindow, ModelIdentity, Solution, Verification, VerificationPolicy } from "./domain/types.js";
import { DEFAULT_VERIFICATION_POLICY, verifyWindows } from "./domain/verification.js";
import { finite, integer, stableId, stableJson, text, unique } from "./domain/shared.js";

export interface PerformanceCost { currency: string; reportedMicros: number; estimatedMicros: number; unknownAttempts: number }
export interface PerformanceInput {
  measurementKey: string; solutionId: string; solutionRevision: string;
  before: EvaluationWindow; after: EvaluationWindow; model: ModelIdentity;
  costs: PerformanceCost[]; activityCosts?: ActivityCostView; confounders: string[]; evidenceRefs: string[]; observedAtMs: number;
  /** Hard eligibility gaps, distinct from acknowledged causal confounders. */
  evidenceGaps?: string[];
}
export interface PerformanceSnapshot extends PerformanceInput { id: string; verification: Verification }

/** Trusted verifier entrypoint only. Public surfaces may read snapshots, never supply window counts. */
export function recordPerformance(store: Store, input: PerformanceInput, policy: VerificationPolicy = DEFAULT_VERIFICATION_POLICY): PerformanceSnapshot {
  text(input.measurementKey, "measurement key"); text(input.solutionId, "solution ID"); text(input.solutionRevision, "solution revision");
  finite(input.observedAtMs, "observation time"); text(input.model.model, "model"); text(input.model.provider, "provider");
  const solution = store.get<Solution>("solutions", input.solutionId);
  if (!solution) throw new Error("performance solution does not exist");
  if (input.after.endMs > input.observedAtMs || input.before.endMs > input.observedAtMs) throw new Error("performance window is in the future");
  if (!input.evidenceRefs.length) throw new Error("performance measurement needs observation evidence");
  for (const ref of input.evidenceRefs) text(ref, "evidence reference");
  const currencies = new Set<string>();
  for (const cost of input.costs) {
    if (!/^[A-Z]{3}$/.test(cost.currency) || currencies.has(cost.currency)) throw new Error("cost currency must be distinct ISO-style codes");
    currencies.add(cost.currency);
    integer(cost.reportedMicros, "reported cost"); integer(cost.estimatedMicros, "estimated cost"); integer(cost.unknownAttempts, "unknown cost attempts");
  }
  const confounders = unique(input.confounders);
  const evidenceGaps = unique(input.evidenceGaps ?? []);
  [...confounders, ...evidenceGaps].forEach(value => text(value, "measurement qualification"));
  if (solution.validatedWith && stableJson(solution.validatedWith) !== stableJson(input.model)) confounders.push("model/provider differs from the validation model");
  const snapshot: PerformanceSnapshot = {
    id: stableId("measurement", [input.solutionId, input.solutionRevision, input.measurementKey]),
    measurementKey: input.measurementKey, solutionId: input.solutionId, solutionRevision: input.solutionRevision,
    before: { ...input.before }, after: { ...input.after }, model: { ...input.model }, costs: input.costs.map(c => ({ ...c })),
    ...(input.activityCosts ? { activityCosts: structuredClone(input.activityCosts) } : {}),
    confounders: unique(confounders), evidenceRefs: unique(input.evidenceRefs), observedAtMs: input.observedAtMs,
    ...(evidenceGaps.length ? { evidenceGaps } : {}),
    verification: verifyWindows(input.before, input.after, policy, confounders),
  };
  if (evidenceGaps.length) snapshot.verification = { ...snapshot.verification, verdict: "PENDING", beforeInterval: null, afterInterval: null,
    reasons: unique([...snapshot.verification.reasons, ...evidenceGaps.map(gap => `comparison evidence incomplete: ${gap}`)]) };
  return store.transaction(() => {
    const previous = store.get<PerformanceSnapshot>("performance", snapshot.id);
    if (previous) {
      if (stableJson(previous) !== stableJson(snapshot)) throw new Error("measurement conflicts with an immutable performance snapshot");
      return previous;
    }
    store.put("performance", snapshot.id, snapshot, input.observedAtMs);
    return snapshot;
  });
}
export function performanceHistory(store: Store, solutionId: string): PerformanceSnapshot[] {
  return store.list<PerformanceSnapshot>("performance").filter(s => s.solutionId === solutionId).sort((a, b) => a.observedAtMs - b.observedAtMs || a.id.localeCompare(b.id));
}
