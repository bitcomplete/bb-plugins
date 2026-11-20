import { expect, it } from "vitest";
import { problemReport } from "../src/problem-report.js";
import { mergeLedgers } from "../src/domain/problems.js";
import type { Problem, Solution, Vote } from "../src/domain/types.js";
import { problem as fixtureProblem, solution as fixtureSolution } from "./domain/fixtures.js";

const vote = (id: string, threadId: string, day: string): Vote => ({ ...({} as Vote), id, problemId: "p-a", kind: "tool_error", day, occurredAtMs: 1, evidence: { kind: "thread", threadId, sessionId: "s", turnIndex: 0, eventId: id } } as Vote);

it("writes a sendable report with evidence, the workaround in use and suggested fixes, and links an issue for a GitHub plugin", () => {
  const problem: Problem = { ...fixtureProblem("p-a"), location: { kind: "plugin", name: "github-watcher" } };
  const solution: Solution = { ...fixtureSolution("s-a"), problemIds: ["p-a"] };
  const report = problemReport({ problem, votes: [vote("e1", "thr_1", "2026-11-18"), vote("e2", "thr_2", "2026-11-19"), vote("e3", "thr_2", "2026-11-19")], solutions: [solution],
    applied: [{ solutionId: "s-a", artifactId: "a", revision: "r", artifactDigest: "d", content: "Check the PR state before waiting.", attemptId: null, source: "automatic", enabled: true, appliedAtMs: 1, updatedAtMs: 1 }],
    sourceUrl: "https://github.com/bitcomplete/bb-plugins.git" });
  expect(report.body).toContain("A plugin: github-watcher");
  expect(report.body).toContain("3 occurrences in 2 BB threads, 2026-11-18 to 2026-11-19");
  expect(report.body).toContain("> Check the PR state before waiting.");
  expect(report.body).toContain(solution.mechanism);
  expect(report.issueUrl).toMatch(/^https:\/\/github\.com\/bitcomplete\/bb-plugins\/issues\/new\?title=/);
  expect(problemReport({ problem, votes: [], solutions: [], applied: [], sourceUrl: "https://gitlab.com/x/y.git" }).issueUrl).toBeNull();
});

it("keeps a known cause location when problems are merged", () => {
  const known: Problem = { ...fixtureProblem("p-a"), location: { kind: "skill", name: "deploy" } };
  const base = fixtureProblem("p-b"); const unknown: Problem = { ...base, causes: [{ ...base.causes[0]!, text: known.causes[0]!.text }], location: { kind: "unknown", name: null } };
  const merged = mergeLedgers({ problems: [unknown, known], solutions: [], votes: [] } as never).problems;
  expect(merged).toHaveLength(1); expect(merged[0]!.location).toEqual({ kind: "skill", name: "deploy" });
});
