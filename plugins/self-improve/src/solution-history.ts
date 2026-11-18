import type { Solution } from "./domain/types.js";
import { resolveSolutionId } from "./domain/candidates.js";
import type { Store } from "./store.js";

export interface SolutionHistory {
  requestedId: string;
  canonicalId: string;
  /** One live identity and its retained aliases, selected together rather than summing separate views. */
  solutionIds: string[];
}

/** Resolve live ownership only. Archived originals preserve evidence; they cannot grant new alias ownership. */
export function resolveSolutionHistory(store: Store, requestedId: string): SolutionHistory {
  const valid = (id: unknown): id is string => typeof id === "string" && !!id.trim() && id.length <= 200 && !/[\x00-\x1f\x7f]/.test(id);
  if (!valid(requestedId)) throw new Error("invalid solution history ID");
  const solutions = store.entries<Solution>("solutions").map(({key, value}) => {
    if (!value || !valid(value.id) || key !== value.id || !Array.isArray(value.aliases) || !value.aliases.every(valid)) throw new Error("invalid solution history identity");
    return value;
  });
  const canonicalId = resolveSolutionId(solutions, requestedId);
  const canonical = solutions.find(solution => solution.id === canonicalId)!;
  const solutionIds = [canonicalId, ...new Set(canonical.aliases.filter(id => id !== canonicalId))].sort();
  // Validate the whole family even when the requested canonical ID itself is unambiguous.
  for (const id of solutionIds) if (resolveSolutionId(solutions, id) !== canonicalId) throw new Error("conflicting solution alias");
  return { requestedId, canonicalId, solutionIds };
}
