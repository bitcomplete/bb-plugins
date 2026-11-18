import type { Store } from "./store.js";
import type { PerformanceSnapshot } from "./performance.js";
import type { PerformancePoint } from "./ui/types.js";
import { resolveSolutionHistory } from "./solution-history.js";

/** Select the live alias family without rewriting the identity or costs of past observations. */
export function performanceView(store: Store, solutionId?: string): { points: PerformancePoint[] } {
  const family = solutionId === undefined ? null : new Set(resolveSolutionHistory(store, solutionId).solutionIds);
  return { points: store.list<PerformanceSnapshot>("performance").filter(p => family === null || family.has(p.solutionId)).flatMap(p => (["baseline", "after"] as const).map(phase => {
    const window = phase === "baseline" ? p.before : p.after;
    return { id: `${p.id}:${phase}`, solutionId: p.solutionId, atMs: window.endMs, phase,
      votes: window.votes, sessions: window.sessions, rate: window.sessions ? window.votes / window.sessions : null,
      confounders: p.confounders, costs: p.costs, ...(p.activityCosts ? { activityCosts: p.activityCosts } : {}) };
  })) };
}
