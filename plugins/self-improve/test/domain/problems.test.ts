import { describe, expect, it } from "vitest";
import { assertLedgerIntegrity, linkSolution, mergeLedgers, resolveProblemId } from "../../src/domain/problems.js";
import { problem, solution, vote } from "./fixtures.js";

describe("problem identity and linking", () => {
  it("merges exact causes deterministically, retaining IDs, symptoms, votes and solution links", () => {
    const a = problem("p-a"), b = problem("p-b"); b.aliases = ["p-old"]; b.solutionIds = ["s-a"];
    const s = solution(); s.problemIds = ["p-old"]; s.prediction.symptomIds = ["symptom-p-b"];
    const input = { problems: [b, a], solutions: [s], votes: [vote({ problemId: "p-old", symptomId: "symptom-p-b" })] };
    const merged = mergeLedgers(input);
    expect(merged.problems).toHaveLength(1);
    expect(merged.problems[0]).toMatchObject({ id: "p-a", aliases: ["p-b", "p-old"], solutionIds: ["s-a"] });
    expect(merged.problems[0]!.causes).toHaveLength(1);
    expect(merged.problems[0]!.symptoms).toHaveLength(1);
    expect(merged.problems[0]!.symptoms.every(x => x.causeId === "cause-p-a")).toBe(true);
    expect(merged.solutions[0]!.problemIds).toEqual(["p-a"]);
    expect(merged.votes[0]!.problemId).toBe("p-a");
    expect(merged.votes[0]!.symptomId).toBe("symptom-p-a");
    expect(merged.solutions[0]!.prediction.symptomIds).toEqual(["symptom-p-a"]);
    expect(mergeLedgers({ ...input, problems: [a, b] })).toEqual(merged);
    expect(input.problems).toHaveLength(2);
    expect(() => assertLedgerIntegrity(merged)).not.toThrow();
  });
  it("does not guess semantic equivalence or silently trim exact-cause text", () => {
    expect(mergeLedgers({ problems: [problem("a", "Payload lost"), problem("b", "payload lost"), problem("c", "Payload lost ")], solutions: [], votes: [] }).problems).toHaveLength(3);
  });
  it("merges transitive equal causes and never leaves stale links", () => {
    const a = problem("a", "A"), b = problem("b", "B"), c = problem("c", "B");
    b.causes.push({ id: "cause-a2", text: "A" });
    const merged = mergeLedgers({ problems: [c, b, a], solutions: [], votes: [] });
    expect(merged.problems.map(x => x.id)).toEqual(["a"]);
    expect(resolveProblemId(merged.problems, "c")).toBe("a");
  });
  it("links from both directions and rejects dangling references", () => {
    const linked = linkSolution({ problems: [problem()], solutions: [solution()], votes: [] }, "s-a", ["p-a"]);
    expect(linked.problems[0]!.solutionIds).toEqual(["s-a"]);
    expect(() => linkSolution(linked, "s-a", ["missing"])).toThrow(/problem/i);
    expect(() => assertLedgerIntegrity({ problems: [problem()], solutions: [solution()], votes: [] })).toThrow(/link/i);
  });
  it("refuses conflicting aliases rather than assigning another problem's evidence", () => {
    const a = problem("a", "A"), b = problem("b", "B"); a.aliases = ["b"];
    expect(() => mergeLedgers({ problems: [a, b], solutions: [], votes: [] })).toThrow(/alias|identity/i);
  });
  it("does not count one observation twice after aliases merge", () => {
    const result = mergeLedgers({ problems: [problem("p-a"), problem("p-b")], solutions: [], votes: [vote(), vote({ id: "duplicate", problemId: "p-b", symptomId: "symptom-p-b" })] });
    expect(result.votes).toHaveLength(1);
  });
  it("rejects parent cycles", () => {
    const a = problem("a", "A"), b = problem("b", "B"); a.parentId = "b"; b.parentId = "a";
    expect(() => assertLedgerIntegrity({ problems: [a, b], solutions: [], votes: [] })).toThrow(/cycle/i);
  });
});
