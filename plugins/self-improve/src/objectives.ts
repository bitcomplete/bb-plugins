import type { Actor, Store } from "./store.js";
import type { Problem } from "./domain/types.js";
import { finite, integer, stableId, stableJson, text } from "./domain/shared.js";

export interface ObjectiveMetric { name: string; unit: string; target: number; direction: "lower" | "higher" }
export interface ObjectiveInput { requestId: string; kind: "problem" | "goal"; title: string; description: string; metric?: ObjectiveMetric }
export interface Objective {
  id: string; requestId: string; kind: "problem" | "goal"; title: string; description: string;
  metric: ObjectiveMetric | null; problemId: string; createdAtMs: number; source: "owner";
}
export interface ObjectiveFocus { objectiveId: string; problemId: string; priority: number; updatedAtMs: number; source: "owner-preference" }
function requireOwner(actor: Actor): void { if (actor.kind !== "owner") throw new Error("explicit owner action required"); }
function clean(value: string, label: string, redact: (value: string) => string): string { text(value, label); const safe = redact(value); text(safe, label); return safe; }

/** The transport must establish actor identity; neither model output nor metadata can name an owner. */
export function addObjective(store: Store, input: ObjectiveInput, actor: Actor, redact: (value: string) => string, nowMs = Date.now()): Objective {
  requireOwner(actor); text(input.requestId, "request ID"); finite(nowMs, "objective time");
  if (input.kind !== "problem" && input.kind !== "goal") throw new Error("invalid objective kind");
  const title = clean(input.title, "objective title", redact), description = clean(input.description, "objective description", redact);
  let metric: ObjectiveMetric | null = null;
  if (input.metric) {
    if (!Number.isFinite(input.metric.target)) throw new Error("metric target must be finite");
    if (!["lower", "higher"].includes(input.metric.direction)) throw new Error("metric needs a direction");
    metric = { name: clean(input.metric.name, "metric name", redact), unit: clean(input.metric.unit, "metric unit", redact), target: input.metric.target, direction: input.metric.direction };
  }
  if (input.kind === "goal" && !metric) throw new Error("optimization goal needs a measurable metric target");
  const id = stableId("objective", input.requestId), problemId = stableId("problem", ["owner", id]);
  const definition = { id, requestId: input.requestId, kind: input.kind, title, description, metric, problemId, source: "owner" as const };
  return store.transaction(() => {
    const previous = store.get<Objective>("objectives", id);
    if (previous) {
      const { createdAtMs: _, ...existing } = previous;
      if (stableJson(existing) !== stableJson(definition)) throw new Error("objective request conflicts with an earlier definition");
      return previous;
    }
    const objective = { ...definition, createdAtMs: nowMs };
    const causeId = stableId("cause", [problemId, "owner-unknown"]);
    const problem: Problem = { id: problemId, aliases: [], category: input.kind === "goal" ? "owner-optimization-goal" : "owner-reported-problem", status: "open",
      causes: [{ id: causeId, text: `Owner-supplied ${input.kind} ${id}: ${description}. A root cause is not established.` }],
      symptoms: [{ id: stableId("symptom", [problemId, title]), causeId, text: metric ? `Owner target: ${metric.name}, ${metric.direction} to ${metric.target} ${metric.unit}; not an observed failure.` : `Owner-reported problem: ${description}; not independently observed.` }],
      solutionIds: [], createdAtMs: nowMs };
    if (store.get("problems", problemId)) throw new Error("objective problem ID already exists without its objective");
    store.createAudited("problems", problemId, problem, actor, "Owner supplied a problem or optimization goal; no observed evidence created");
    store.createAudited("objectives", id, objective, actor, "Owner recorded an objective");
    return objective;
  });
}
export function setObjectiveFocus(store: Store, objectiveId: string, priority: number, actor: Actor, nowMs = Date.now()): ObjectiveFocus {
  requireOwner(actor); integer(priority, "focus priority"); finite(nowMs, "focus time");
  if (priority > 5) throw new Error("focus priority must be between zero and five");
  return store.transaction(() => {
    const objective = store.get<Objective>("objectives", objectiveId);
    if (!objective) throw new Error("objective does not exist");
    const previous = store.get<ObjectiveFocus>("objective-focus", objectiveId);
    if (previous?.priority === priority) return previous;
    const focus: ObjectiveFocus = { objectiveId, problemId: objective.problemId, priority, updatedAtMs: nowMs, source: "owner-preference" };
    const reason = "Owner changed optimization focus; observation votes remain unchanged";
    if (previous) store.edit("objective-focus", objectiveId, store.version("objective-focus", objectiveId), focus, actor, reason);
    else store.createAudited("objective-focus", objectiveId, focus, actor, reason);
    return focus;
  });
}
export function listObjectives(store: Store): Array<Objective & { focus: ObjectiveFocus | null }> {
  return store.list<Objective>("objectives").map(objective => ({ ...objective, focus: store.get<ObjectiveFocus>("objective-focus", objective.id) }));
}
