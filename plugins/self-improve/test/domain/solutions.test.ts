import { describe, expect, it } from "vitest";
import { candidateEligibility, rankSolutions } from "../../src/domain/solutions.js";
import { DAY, NOW, problem, solution } from "./fixtures.js";

describe("candidate ranking is not adoption", () => {
  it("permits an untested invention without fabricating a source paper", () => {
    expect(candidateEligibility(solution(), [problem()], [], NOW)).toEqual({ eligible: true, reasons: [] });
    expect(candidateEligibility({ ...solution(), sourcePaper: { id: "x" } as never }, [problem()], [], NOW).eligible).toBe(false);
  });
  it("keeps paper candidates pending when citation/author evidence is missing or too young", () => {
    const s = solution(); s.origin = "paper";
    s.sourcePaper = { id: "paper", version: "v1", url: "https://arxiv.org/abs/2611.18856", publishedAtMs: NOW - 10 * DAY, credibility: { status: "passed", fieldWeightedCitationImpact: null, authorSignal: 1, evidenceUrls: ["https://example.org/evidence"] } };
    expect(candidateEligibility(s, [problem()], [], NOW).reasons).toContain("paper credibility evidence is incomplete");
    s.sourcePaper.credibility.fieldWeightedCitationImpact = 1;
    s.sourcePaper.publishedAtMs = NOW - 5 * DAY;
    expect(candidateEligibility(s, [problem()], [], NOW).reasons).toContain("paper is younger than the minimum age");
  });
  it("requires new evidence for a previously failed direction, including removed solutions", () => {
    const prior = solution("old"); prior.status = "removed";
    prior.attempts = [{ id: "attempt", atMs: NOW - DAY, directionKey: prior.directionKey, prediction: prior.prediction, outcome: "failed", reason: "Did not preserve payload", evidenceIds: ["old-evidence"], model: { provider: "p", model: "m" } }];
    const next = solution(); next.newEvidenceIds = ["old-evidence"];
    expect(candidateEligibility(next, [problem()], [prior], NOW).eligible).toBe(false);
    next.newEvidenceIds = ["new-measured-evidence"];
    expect(candidateEligibility(next, [problem()], [prior], NOW).eligible).toBe(true);
  });
  it("checks the current candidate's failed attempts too", () => {
    const s = solution(); s.attempts = [{ id: "failed", atMs: NOW - DAY, directionKey: s.directionKey, prediction: s.prediction, outcome: "failed", reason: "No change", evidenceIds: ["old"], model: { provider: "p", model: "m" } }];
    expect(candidateEligibility(s, [problem()], [], NOW).eligible).toBe(false);
    s.newEvidenceIds = ["new"];
    expect(candidateEligibility(s, [problem()], [], NOW).eligible).toBe(true);
  });
  it("uses one rubric across sources, preserves uncertainty and has stable ties", () => {
    const a = solution("a"), b = solution("b");
    const result = rankSolutions([b, a], [problem()], [{ problemId: "p-a", score: 3, voteCount: 1, sourceCount: 1 }], NOW);
    expect(result.map(x => x.solutionId)).toEqual(["a", "b"]);
    expect(a.status).toBeNull();
    b.scores.benefit = null;
    expect(rankSolutions([b], [problem()], [], NOW)[0]).toMatchObject({ score: null, missingFactors: ["benefit"], rank: null });
  });
  it("rejects falsifiable-test omissions and impossible scores", () => {
    expect(candidateEligibility({ ...solution(), testPlan: "" }, [problem()], [], NOW).eligible).toBe(false);
    const s = solution(); s.scores.fit = 20;
    expect(() => rankSolutions([s], [problem()], [], NOW)).toThrow(/score/i);
  });
});

