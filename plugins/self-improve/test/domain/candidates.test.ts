import { describe, expect, it } from "vitest";
import { candidateDerivation, mergeSolutionCandidates, resolveSolutionId } from "../../src/domain/candidates.js";
import { assertLedgerIntegrity, mergeLedgers } from "../../src/domain/problems.js";
import { candidateEligibility } from "../../src/domain/solutions.js";
import type { PaperSource, PortabilityDeclaration, Solution } from "../../src/domain/types.js";
import { DAY, NOW, problem, solution } from "./fixtures.js";

function paper(id: string, days = 20): PaperSource {
  return { id, version: "v1", url: `https://arxiv.org/abs/${id}`, publishedAtMs: NOW - days * DAY,
    credibility: { status: "passed", fieldWeightedCitationImpact: 1, authorSignal: 1, evidenceUrls: ["https://example.org/assessment"] } };
}
function draft(id: string, at = NOW): Solution {
  const s = solution(id);
  s.createdAtMs = at;
  s.provenance[0]!.sourceId = `invention-${id}`;
  s.attempts.push({ id: `proposal-${id}`, atMs: at, directionKey: s.directionKey, prediction: structuredClone(s.prediction), outcome: "proposed", reason: `Discovered ${id}`, evidenceIds: [], model: s.provenance[0]!.model });
  return s;
}
function paperDraft(id: string, days = 20, at = NOW): Solution {
  const s = draft(id, at);
  s.origin = "paper"; s.sourcePaper = paper(id, days);
  s.provenance = [{ origin: "paper", sourceId: id, model: { provider: "research-provider", model: "research-model" } }];
  s.assumptions = [`assumption-${id}`]; s.testPlan = `Evaluate ${id} independently`;
  return s;
}
function only(solutions: Solution[]): Solution { expect(solutions).toHaveLength(1); return solutions[0]!; }

describe("candidate identity across discovery batches", () => {
  it("merges exact mechanisms across origins, retaining provenance, attempts and complete originals", () => {
    const first = paperDraft("paper-discovery", 20, NOW - 1), invention = draft("inventor-discovery");
    invention.mechanism = `  ${first.mechanism.toUpperCase()}  `;
    const before = structuredClone([first, invention]);
    const result = mergeSolutionCandidates([invention, first]), merged = only(result.solutions);
    expect(merged.id).toBe(first.id);
    expect(resolveSolutionId(result.solutions, invention.id)).toBe(first.id);
    expect(merged.provenance).toHaveLength(2);
    expect(merged.attempts.map(a => a.id).sort()).toEqual([`proposal-${first.id}`, `proposal-${invention.id}`].sort());
    expect(merged.paperSources).toEqual([first.sourcePaper]);
    expect(merged).toMatchObject({ origin: "inventor", sourcePaper: null, mechanism: invention.mechanism, candidateState: "proposed" });
    expect(Object.values(merged.scores)).toEqual([null, null, null, null, null, null]);
    expect(merged.sourceDerivation).toMatchObject({ originalId: invention.id, originalCreatedAtMs: NOW, provenance: invention.provenance });
    expect(candidateEligibility(merged, [problem()], [], NOW).eligible).toBe(true);
    expect(result.solutionMerges).toEqual([{ canonicalId: first.id, canonicalBefore: first, absorbed: invention, reason: "exact-direction-and-canonical-problems" }]);
    expect([first, invention]).toEqual(before);
  });

  it("canonicalizes problem and symptom aliases before deciding equivalence", () => {
    const a = problem("p-a"), b = problem("p-b"), left = draft("left"), right = draft("right");
    b.aliases = ["problem-before-merge"];
    right.problemIds = ["problem-before-merge"];
    right.prediction.symptomIds = ["symptom-p-b"];
    right.attempts[0]!.prediction.symptomIds = ["symptom-p-b"];
    a.solutionIds = [left.id]; b.solutionIds = [right.id];
    const result = mergeLedgers({ problems: [b, a], solutions: [right, left], votes: [] });
    const merged = only(result.solutions);
    expect(merged.problemIds).toEqual(["p-a"]);
    expect(merged.prediction.symptomIds).toEqual(["symptom-p-a"]);
    expect(result.problems[0]!.solutionIds).toEqual([merged.id]);
    expect(result.solutionMerges?.[0]?.absorbed).toEqual(right);
    expect(() => assertLedgerIntegrity(result)).not.toThrow();
    expect(mergeLedgers(result)).toEqual(result);
  });

  it("does not merge merely similar mechanisms or different canonical problem sets", () => {
    const base = draft("base"), paraphrase = draft("paraphrase"), otherProblem = draft("other"), extraProblem = draft("extra");
    paraphrase.mechanism = "Save the retry input somewhere";
    otherProblem.problemIds = ["p-b"];
    extraProblem.problemIds = ["p-a", "p-b"];
    expect(mergeSolutionCandidates([base, paraphrase, otherProblem, extraProblem]).solutions).toHaveLength(4);
  });

  it("rejects colliding aliases even if an apparent merge would hide the collision", () => {
    const a = draft("a"), b = draft("b"); a.aliases = [b.id];
    expect(() => mergeSolutionCandidates([a, b])).toThrow("conflicting solution alias");
    expect(() => mergeSolutionCandidates([a, a])).toThrow("duplicate solution identity");
  });
});

describe("independent derivation selection", () => {
  it("never legitimizes an inventor record carrying paper sources by merging it", () => {
    const invalid = draft("invalid-invention", NOW - 2); invalid.paperSources = [paper("paper-only")];
    expect(candidateDerivation(invalid)).toBeNull();
    const pending = paperDraft("pending-paper", 1, NOW - 1); pending.sourcePaper!.credibility.status = "pending";
    const merged = only(mergeSolutionCandidates([invalid, pending]).solutions);
    expect(merged.origin).toBe("paper");
    expect(candidateEligibility(merged, [problem()], [], NOW).eligible).toBe(false);
    expect(merged.provenance).toHaveLength(2);
    // A separate pure invention can be selected, but its actual source is kept.
    const valid = draft("independent-invention");
    const withValid = only(mergeSolutionCandidates([merged, valid]).solutions);
    expect(withValid.sourceDerivation?.originalId).toBe(valid.id);
    expect(candidateEligibility(withValid, [problem()], [], NOW).eligible).toBe(true);
  });

  it("rejects a forged source derivation lacking a retained source identity or matching definition", () => {
    const a = draft("a"), b = draft("b");
    const merged = only(mergeSolutionCandidates([a, b]).solutions);
    merged.sourceDerivation!.originalId = "unrelated";
    expect(candidateEligibility(merged, [problem()], [], NOW).reasons).toContain("candidate source derivation is invalid");
    const edited = only(mergeSolutionCandidates([a, b]).solutions);
    edited.testPlan = "A different plan that has never been assessed";
    expect(candidateEligibility(edited, [problem()], [], NOW).reasons).toContain("candidate source derivation is invalid");
  });

  it("preserves a mature credible paper when an earlier-created duplicate cites a young paper", () => {
    const young = paperDraft("young", 1, NOW - 2), mature = paperDraft("mature", 20, NOW - 1);
    const merged = only(mergeSolutionCandidates([young, mature]).solutions);
    expect(merged.id).toBe(young.id);
    expect(merged.sourcePaper).toEqual(mature.sourcePaper);
    expect(merged.paperSources).toHaveLength(2);
    expect(candidateEligibility(merged, [problem()], [], NOW).eligible).toBe(true);
    const malformed = paperDraft("incomplete-reference", 100, NOW - 3); malformed.sourcePaper!.url = "invalid";
    expect(only(mergeSolutionCandidates([malformed, merged]).solutions).sourcePaper).toEqual(mature.sourcePaper);
  });

  it("does not allow mixed paper provenance to bypass the paper gate as an invention", () => {
    const laundered = draft("mixed", NOW - 1); laundered.provenance.push({ origin: "paper", sourceId: "paper-derived", model: { provider: "test", model: "test" } });
    const pending = paperDraft("pending", 1); pending.sourcePaper!.credibility.status = "pending";
    const merged = only(mergeSolutionCandidates([laundered, pending]).solutions);
    expect(candidateEligibility(merged, [problem()], [], NOW).eligible).toBe(false);
    expect(merged.provenance).toHaveLength(3);
  });

  it("selects the same original derivation across batch order and sequential merges", () => {
    const oldest = paperDraft("oldest", 20, NOW - 3); oldest.sourcePaper!.credibility.status = "pending";
    const later = paperDraft("later", 20, NOW - 1), earlier = paperDraft("earlier", 20, NOW - 2);
    const batch = only(mergeSolutionCandidates([oldest, later, earlier]).solutions);
    const step = only(mergeSolutionCandidates([oldest, later]).solutions);
    const sequential = only(mergeSolutionCandidates([step, earlier]).solutions);
    expect(sequential).toEqual(batch);
    expect(batch.sourceDerivation).toMatchObject({ originalId: earlier.id, originalCreatedAtMs: earlier.createdAtMs });
    expect(mergeSolutionCandidates([earlier, later, oldest]).solutions).toEqual([batch]);
    expect(mergeSolutionCandidates([batch]).solutions).toEqual([batch]);
  });
});

describe("evaluated identities and failures", () => {
  it("absorbs new drafts into an established identity without replacing its artifact metadata", () => {
    const active = draft("active", NOW), incoming = paperDraft("incoming", 20, NOW - 1);
    active.status = "active"; active.candidateState = "built";
    active.wiring = { location: "installed-skill", activatedAtMs: NOW - DAY, executionCount: 4, undo: "Disable the installed skill" };
    active.builtWith = active.validatedWith = { provider: "verified-provider", model: "verified-model" };
    active.attempts[0]!.outcome = "adopted";
    const result = mergeSolutionCandidates([incoming, active]), merged = only(result.solutions);
    expect(merged.id).toBe(active.id);
    for (const key of ["origin", "sourcePaper", "mechanism", "assumptions", "testPlan", "prediction", "scores", "candidateState", "status", "wiring", "builtWith", "validatedWith", "revisitHistory"] as const) expect(merged[key]).toEqual(active[key]);
    expect(merged.attempts).toContainEqual(active.attempts[0]);
    expect(result.solutionMerges?.[0]?.canonicalBefore).toEqual(active);
  });

  it("retains tested, failed, rejected and removed identities, reporting multiple established directions", () => {
    const active = draft("active"), built = draft("built"), removed = draft("removed"), failed = draft("failed"), rejected = draft("rejected");
    active.status = "active"; built.candidateState = "built"; removed.status = "removed";
    failed.attempts[0]!.outcome = "failed"; rejected.candidateState = "rejected";
    const result = mergeSolutionCandidates([active, built, removed, failed, rejected, draft("new")]);
    expect(result.solutions.map(s => s.id)).toEqual(["active", "built", "failed", "rejected", "removed"]);
    expect(result.solutionMergeConflicts).toMatchObject([{ solutionIds: ["active", "built"] }]);
    expect(result.solutions.find(s => s.id === failed.id)).toEqual(failed);
    expect(result.solutions.find(s => s.id === removed.id)).toEqual(removed);
    expect(result.solutions.find(s => s.id === rejected.id)).toEqual(rejected);
  });

  it("blocks duplicate construction and still demands new evidence after earlier failure", () => {
    const candidate = draft("new"), sibling = draft("sibling");
    expect(candidateEligibility(candidate, [problem()], [sibling], NOW).reasons).toContain("duplicate candidate direction must be merged before building");
    sibling.status = "active";
    expect(candidateEligibility(candidate, [problem()], [sibling], NOW).reasons).toContain("same direction already has an evaluated solution; retest its existing identity");
    sibling.status = "removed"; sibling.attempts[0]!.outcome = "failed";
    expect(candidateEligibility(candidate, [problem()], [sibling], NOW).eligible).toBe(false);
    candidate.newEvidenceIds = ["independent-new-observation"];
    expect(candidateEligibility(candidate, [problem()], [sibling], NOW).eligible).toBe(true);
  });

  it("tolerates unknown historical problem refs without treating partial scope as an exact duplicate", () => {
    const p = problem(); p.aliases = ["old-problem"];
    const historic = draft("history"); historic.status = "active"; historic.problemIds = ["old-problem", "deleted-problem"];
    const candidate = draft("new");
    expect(candidateEligibility(candidate, [p], [historic], NOW).eligible).toBe(true);
    historic.problemIds = ["old-problem"];
    expect(candidateEligibility(candidate, [p], [historic], NOW).eligible).toBe(false);
  });
});


function declaration(identity: string): PortabilityDeclaration {
  return {
    schemaVersion: 1, status: "unverified", scope: `Scope for ${identity}`, dependencyStatus: "declared",
    requirements: [{ kind: "skill", identity, versionConstraint: null, setup: `Install ${identity}; version requirements unknown` }],
    assumptions: [`Assumption for ${identity}`],
    testProposal: { minimalEnvironment: `Minimal BB plus ${identity}`, packagedArtifact: `Invoke the packaged ${identity} via its declared trigger` },
    untestedConfigurations: [`Other configurations of ${identity}`],
  };
}
describe("portability belongs to the exact representative derivation", () => {
  it("keeps absent historical declarations unknown without synthesizing them", () => {
    const older = draft("older", NOW - 1), later = draft("later");
    expect(candidateDerivation(older)).not.toHaveProperty("portability");
    const merged = only(mergeSolutionCandidates([later, older]).solutions);
    expect(merged).not.toHaveProperty("portability");
    expect(candidateDerivation(merged)).not.toHaveProperty("portability");
  });

  it("copies one complete declaration while retaining originals, never unioning requirements", () => {
    const first = paperDraft("paper", 20, NOW - 1), selected = draft("inventor");
    first.portability = declaration("paper-skill"); selected.portability = declaration("inventor-skill");
    const before = structuredClone([first, selected]);
    const result = mergeSolutionCandidates([first, selected]), merged = only(result.solutions);
    expect(merged.id).toBe(first.id);
    expect(merged.portability).toEqual(selected.portability);
    expect(candidateDerivation(merged)?.portability).toEqual(selected.portability);
    expect(result.solutionMerges?.[0]?.canonicalBefore.portability).toEqual(first.portability);
    expect(result.solutionMerges?.[0]?.absorbed.portability).toEqual(selected.portability);
    expect([first, selected]).toEqual(before);
  });

  it("clears a declaration when the selected independent representative has no declaration", () => {
    const canonical = paperDraft("paper", 20, NOW - 1), legacy = draft("legacy-inventor");
    canonical.portability = declaration("paper-skill");
    const merged = only(mergeSolutionCandidates([canonical, legacy]).solutions);
    expect(merged.id).toBe(canonical.id);
    expect(merged).not.toHaveProperty("portability");
    expect(candidateDerivation(merged)).toMatchObject({ originalId: legacy.id });
    expect(candidateDerivation(merged)).not.toHaveProperty("portability");
  });

  it.each(["scope", "requirements", "assumptions", "testProposal", "untestedConfigurations", "dependencyStatus", "absence"])("invalidates the derivation when %s changes independently", field => {
    const first = draft("first", NOW - 1), later = draft("later"); first.portability = declaration("first-skill");
    const merged = only(mergeSolutionCandidates([first, later]).solutions);
    expect(candidateDerivation(merged)).not.toBeNull();
    if (field === "absence") delete merged.portability;
    else if (field === "dependencyStatus") merged.portability!.dependencyStatus = "unknown";
    else Object.assign(merged.portability!, { [field]: declaration("different-skill")[field as keyof PortabilityDeclaration] });
    expect(candidateDerivation(merged)).toBeNull();
  });

  it("cannot graft a declaration onto a historical merged derivation", () => {
    const merged = only(mergeSolutionCandidates([draft("first", NOW - 1), draft("later")]).solutions);
    merged.portability = declaration("new-skill");
    expect(candidateDerivation(merged)).toBeNull();
  });

  it("preserves an evaluated identity's unknown declaration when absorbing a declared variant", () => {
    const active = draft("active"), incoming = draft("incoming", NOW - 1);
    active.status = "active"; incoming.portability = declaration("incoming-skill");
    const merged = only(mergeSolutionCandidates([active, incoming]).solutions);
    expect(merged).not.toHaveProperty("portability");
    expect(candidateDerivation(merged)).not.toHaveProperty("portability");
  });
});
