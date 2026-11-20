import { describe, expect, it } from "vitest";
import { DEFAULT_RANKING_CONFIG, appendVotes, decayWeight, makeVote, rankProblems } from "../../src/domain/votes.js";
import { DAY, NOW, problem, vote } from "./fixtures.js";

describe("votes and deterministic ranking", () => {
  it("half life is 21 days, not a step cutoff", () => {
    expect(decayWeight(3, NOW - 21 * DAY, NOW, 21)).toBeCloseTo(1.5);
    expect(decayWeight(3, NOW, NOW, 21)).toBe(3);
    expect(() => decayWeight(3, NOW, NOW, 0)).toThrow();
  });
  it("rejects future observations instead of inflating their score", () => {
    expect(() => rankProblems([problem()], [vote({ occurredAtMs: NOW + 1 })], NOW)).toThrow(/future/i);
  });
  it("keeps replayed observations idempotent but counts separate failed attempts", () => {
    const { id: _, ...base } = vote();
    const first = makeVote(base), replay = makeVote(base);
    const next = makeVote({ ...base, evidence: { kind: "task", taskId: "task-a", runId: "retry-2" } });
    expect(first.id).toBe(replay.id);
    expect(appendVotes([first], [replay, next])).toHaveLength(2);
    expect(() => appendVotes([first], [{ ...first, kind: "owner_correction" }])).toThrow(/conflict/i);
  });
  it("caps the decayed contribution per stable task/day and excludes own descendants", () => {
    const votes = Array.from({ length: 12 }, (_, i) => vote({ id: `v-${i}`, kind: "owner_correction", evidence: { kind: "thread", threadId: `t-${i}`, sessionId: `s-${i}`, turnIndex: 0, eventId: `e-${i}`, taskId: "same-task" } }));
    votes.push(vote({ id: "own", originPluginId: "self-improve" }));
    const ranked = rankProblems([problem()], votes, NOW);
    expect(ranked.top[0]).toMatchObject({ score: 3, sourceCount: 1, voteCount: 12 });
  });
  it("allocates separate caps across sources and days with deterministic tie breaking", () => {
    const a = problem("a"), b = problem("b");
    const result = rankProblems([b, a], [vote({ id: "b", problemId: "b" }), vote({ id: "a", problemId: "a" })], NOW);
    expect(result.top.map(x => x.problemId)).toEqual(["a", "b"]);
    expect(result.wildcards).toHaveLength(3);
    expect(result.wildcards.every(x => x.kind === "discovery-slot")).toBe(true);
  });
  it("returns at most seven real problems and never fabricates a top ten", () => {
    expect(rankProblems([problem()], [], NOW).top).toEqual([]);
    expect(DEFAULT_RANKING_CONFIG.weights.owner_correction).toBe(3);
    expect(DEFAULT_RANKING_CONFIG.weights.tool_retry).toBe(0.25);
  });
});
