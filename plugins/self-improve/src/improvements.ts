import { createHash } from "node:crypto";
import type { Actor, Store } from "./store.js";

/**
 * Improvements applied to agent turns. An improvement is instruction text that passed its test runs; while enabled,
 * Self improve adds it to turns through BB's agents.configure hook. Nothing is written to disk and disabling takes
 * effect from the next turn.
 */
export interface AppliedImprovement {
  solutionId: string; artifactId: string; revision: string; artifactDigest: string; content: string;
  attemptId: string | null; source: "automatic" | "owner"; enabled: boolean;
  appliedAtMs: number; updatedAtMs: number;
}
export interface ImprovementUsage { turns: number; lastAtMs: number | null }
const NS = "applied-improvements", USAGE = "applied-improvement-usage";
/** Bounds on what is added to one turn. Improvements past the bound wait rather than being silently dropped. */
export const MAX_ACTIVE_IMPROVEMENTS = 10, MAX_IMPROVEMENT_CHARACTERS = 2000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function listImprovements(store: Store): AppliedImprovement[] {
  return store.list<AppliedImprovement>(NS).sort((a, b) => a.appliedAtMs - b.appliedAtMs || a.solutionId.localeCompare(b.solutionId));
}
export function improvementUsage(store: Store, solutionId: string): ImprovementUsage {
  return store.get<ImprovementUsage>(USAGE, solutionId) ?? { turns: 0, lastAtMs: null };
}

/** Applies a tested artifact for its solution, replacing any earlier revision. */
export function applyImprovement(store: Store, input: { solutionId: string; artifactId: string; attemptId: string | null; source: AppliedImprovement["source"] }, actor: Actor, now = Date.now()): AppliedImprovement {
  return store.transaction(() => {
    const artifact = store.get<{ solutionId: string; revision: string; kind: string; content: string; artifactDigest: string }>("native-evaluation-artifacts", input.artifactId);
    if (!artifact || artifact.solutionId !== input.solutionId || artifact.kind !== "instruction" || typeof artifact.content !== "string" || sha(artifact.content) !== artifact.artifactDigest) throw new Error("Tested instruction not found for this solution");
    const previous = store.get<AppliedImprovement>(NS, input.solutionId);
    const value: AppliedImprovement = { solutionId: input.solutionId, artifactId: input.artifactId, revision: artifact.revision, artifactDigest: artifact.artifactDigest, content: artifact.content,
      // An automatic re-apply never turns back on an improvement the owner disabled.
      attemptId: input.attemptId, source: input.source, enabled: input.source === "automatic" && previous ? previous.enabled : true, appliedAtMs: previous?.artifactId === input.artifactId ? previous.appliedAtMs : now, updatedAtMs: now };
    if (previous) store.edit(NS, input.solutionId, store.version(NS, input.solutionId), value, actor, input.source === "automatic" ? "Apply a tested improvement automatically" : "Apply a tested improvement");
    else store.createAudited(NS, input.solutionId, value, actor, input.source === "automatic" ? "Apply a tested improvement automatically" : "Apply a tested improvement");
    return value;
  });
}

/** Enables or disables an applied improvement from the next turn on. History is kept in the audit log. */
export function setImprovementEnabled(store: Store, solutionId: string, enabled: boolean, actor: Actor, now = Date.now()): AppliedImprovement {
  return store.transaction(() => {
    const current = store.get<AppliedImprovement>(NS, solutionId);
    if (!current) throw new Error("This solution has no applied improvement");
    if (current.enabled === enabled) return current;
    const value = { ...current, enabled, updatedAtMs: now };
    store.edit(NS, solutionId, store.version(NS, solutionId), value, actor, enabled ? "Enable an improvement" : "Disable an improvement");
    return value;
  });
}

/** Whether a project receives improvements: the configured list, or every project except the worker project when none is set. */
export function projectReceivesImprovements(projectId: string, scopeProjectIds: readonly string[], workerProjectId: string): boolean {
  return scopeProjectIds.length ? scopeProjectIds.includes(projectId) : projectId !== workerProjectId;
}

/** The enabled improvements one turn receives, oldest first, within the size bounds; the rest wait. */
export function improvementsForTurn(store: Store): { included: AppliedImprovement[]; waiting: AppliedImprovement[] } {
  const included: AppliedImprovement[] = [], waiting: AppliedImprovement[] = [];
  let characters = 0;
  for (const item of listImprovements(store).filter(i => i.enabled)) {
    if (included.length < MAX_ACTIVE_IMPROVEMENTS && characters + item.content.length <= MAX_IMPROVEMENT_CHARACTERS) { included.push(item); characters += item.content.length; }
    else waiting.push(item);
  }
  return { included, waiting };
}

/** Records that a turn received these improvements, for the applied list. */
export function recordImprovementDelivery(store: Store, solutionIds: readonly string[], now = Date.now()): void {
  store.transaction(() => { for (const id of solutionIds) { const usage = improvementUsage(store, id); store.put(USAGE, id, { turns: usage.turns + 1, lastAtMs: now }); } });
}

export const improvementInstructions = (items: readonly AppliedImprovement[]) => items.length
  ? `Improvements learned from earlier work in this BB installation (added by the Self improve plugin):\n\n${items.map(i => i.content).join("\n\n")}` : "";
