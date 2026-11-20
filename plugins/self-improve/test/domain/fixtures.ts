import type { Problem, Solution, Vote } from "../../src/domain/types.js";
export const NOW = Date.UTC(2026, 10, 18);
export const DAY = 86_400_000;
export function problem(id = "p-a", text = "Retries lose the original payload"): Problem {
  return { id, aliases: [], category: "reliability", status: "open", causes: [{ id: `cause-${id}`, text }], symptoms: [{ id: `symptom-${id}`, causeId: `cause-${id}`, text: "The retried request lacks its payload" }], solutionIds: [], createdAtMs: NOW - DAY };
}
export function vote(overrides: Partial<Vote> = {}): Vote {
  return { id: "v-one", problemId: "p-a", symptomId: "symptom-p-a", kind: "tool_error", evidence: { kind: "thread", threadId: "thread-a", sessionId: "session-a", turnIndex: 0, eventId: "event-a", taskId: "task-a" }, occurredAtMs: NOW, day: "2026-11-18", originPluginId: null, ...overrides };
}
export function solution(id = "s-a"): Solution {
  return { id, aliases: [], title: "Retain request payload across retry", origin: "inventor", sourcePaper: null,
    provenance: [{ origin: "inventor", sourceId: "request-one", model: { provider: "test-provider", model: "test-model" } }],
    problemIds: ["p-a"], directionKey: "preserve-request-on-retry", mechanism: "Carry the original immutable request", assumptions: [], testPlan: "Retry a request and compare its payload", prediction: { symptomIds: ["symptom-p-a"], change: "Retried requests retain their payload", kpi: { name: "lost payload rate", target: 0, direction: "lower" } },
    scores: { fit: 0.8, benefit: 0.8, testability: 0.8, feasibility: 0.8, safety: 0.8, effort: 1 }, scoreReasons: { fit: "Targets the cause", benefit: "Expected reduction", testability: "Deterministic replay", feasibility: "Small request change", safety: "Reversible patch", effort: "One unit" },
    newEvidenceIds: [], createdAtMs: NOW, candidateState: "proposed", status: null, attempts: [], wiring: null, builtWith: null, validatedWith: null, revisitHistory: [] };
}
