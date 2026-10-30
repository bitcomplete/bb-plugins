import { describe, expect, it, vi } from "vitest";
import type { JevAnswer, JevClient } from "./enrich.js";
import { suggestThreadEfforts } from "./thread-effort-suggestions.js";

const effort = (key: string, name = key) => ({ key, name, labels: [name] });
const work = [{ label: "Repair CI cache", ticket: "CI-12" }];
const answer = (score: number, confidence = 0.9): JevAnswer => ({ type: "score", score, confidence });
const choice = (name: string, confidence = 0.9): JevAnswer => ({ type: "choice", choice: name, confidence });

function client(answers: Record<string, JevAnswer>) {
  const ask = vi.fn<JevClient["ask"]>(async () => ({ answers, usage: { input_tokens: 0, output_tokens: 0 } }));
  return { ask };
}

describe("thread effort suggestions", () => {
  it("returns at most three strong existing fits in score order, mapped to supplied keys", async () => {
    const jev = client({ e0: answer(3), e1: answer(4), e2: answer(3.5), e3: answer(3.7), name: choice("none") });
    const result = await suggestThreadEfforts({ threadTitle: "Speed up CI", work, efforts: [effort("cache"), effort("runner"), effort("build"), effort("checks")], jev });
    expect(result).toEqual({
      suggestions: ["runner", "checks", "build"].map((key) => ({ key, reason: "Strong match to this thread and linked work" })),
      suggestedName: null, notice: null,
    });
    expect(jev.ask).toHaveBeenCalledTimes(1);
    expect(Object.keys(jev.ask.mock.calls[0]![1])).toEqual(["e0", "e1", "e2", "e3", "name"]);
  });

  it("uses truthful title-only copy and accepts a score at the rubric cut", async () => {
    const result = await suggestThreadEfforts({ threadTitle: "  Cache   rollout ", work: [], efforts: [effort("cache")], jev: client({ e0: answer(3), name: choice("none") }) });
    expect(result.suggestions).toEqual([{ key: "cache", reason: "Strong match to this thread" }]);
  });

  it("withholds low, absent, noul, malformed, and out-of-range answers", async () => {
    const jev = client({
      e0: answer(2.99), e1: answer(4, 0.59), e2: { type: "noul", noul: 1 },
      e3: answer(Number.NaN), e4: answer(5), e5: answer(3, Number.POSITIVE_INFINITY),
      e6: { type: "score", score: "4", confidence: 1 } as unknown as JevAnswer,
      e7: { type: "score", score: 4, confidence: "1" } as unknown as JevAnswer,
      e8: answer(4, 1.01), e9: null as unknown as JevAnswer,
    });
    const result = await suggestThreadEfforts({ threadTitle: "CI cache", work, efforts: Array.from({ length: 10 }, (_, i) => effort(`key${i}`)), jev });
    expect(result.suggestions).toEqual([]);
    expect(result.notice).toContain("No confident existing effort match");
  });

  it("chooses only a unique, cleaned name from bounded source labels", async () => {
    const jev = client({ name: choice("n1") });
    const result = await suggestThreadEfforts({
      threadTitle: "  Existing   effort ",
      work: [{ label: "  Improve   CI   cache  ", ticket: null }, { label: "improve ci cache", ticket: null }],
      efforts: [effort("existing", "Existing effort")], jev,
    });
    expect(result.suggestedName).toBeNull();
    expect((jev.ask.mock.calls[0]![1].name as { criteria: Record<string, unknown> }).criteria).toEqual({ none: "No suitable source name", n0: null });
    const accepted = await suggestThreadEfforts({ threadTitle: "Existing effort", work: [{ label: "Improve CI cache", ticket: null }], efforts: [effort("existing", "Existing effort")], jev: client({ name: choice("n0") }) });
    expect(accepted.suggestedName).toBe("Improve CI cache");
    const invented = await suggestThreadEfforts({ threadTitle: "Existing effort", work, efforts: [effort("existing", "Existing effort")], jev: client({ name: choice("An invented name") }) });
    expect(invented.suggestedName).toBeNull();
    const uncertain = await suggestThreadEfforts({ threadTitle: "Existing effort", work, efforts: [effort("existing", "Existing effort")], jev: client({ name: choice("n0", 0.59) }) });
    expect(uncertain.suggestedName).toBeNull();
    const malformed = await suggestThreadEfforts({ threadTitle: "Existing effort", work, efforts: [effort("existing", "Existing effort")], jev: client({ name: { type: "choice", choice: "n0", confidence: Number.NaN } }) });
    expect(malformed.suggestedName).toBeNull();
  });

  it("bounds all context and question IDs in one call, and reports truncation", async () => {
    const jev = client({ e29: answer(4), e30: answer(4), name: choice("n9") });
    const result = await suggestThreadEfforts({
      threadTitle: "T".repeat(250),
      work: Array.from({ length: 12 }, (_, i) => ({ label: `Work ${i} ${"x".repeat(250)}`, ticket: `T-${i}` })),
      efforts: Array.from({ length: 35 }, (_, i) => ({ key: `key${i}`, name: `Effort ${i} ${"y".repeat(250)}`, labels: Array(5).fill("z".repeat(250)) })), jev,
    });
    expect(jev.ask).toHaveBeenCalledTimes(1);
    const [state, questions] = jev.ask.mock.calls[0]!;
    const context = state as { thread: { title: string; work: { label: string }[] }; efforts: { name: string; labels: string[] }[]; nameOptions: { name: string }[] };
    expect(context.thread.title).toHaveLength(200);
    expect(context.thread.work).toHaveLength(8);
    expect(context.efforts).toHaveLength(30);
    expect(context.efforts[0]!.labels).toHaveLength(3);
    expect(context.efforts[0]!.name).toHaveLength(200);
    expect(context.nameOptions).toHaveLength(9);
    expect(context.nameOptions.every(({ name }) => name.length <= 120)).toBe(true);
    expect(Object.keys(questions)).toEqual([...Array.from({ length: 30 }, (_, i) => `e${i}`), "name"]);
    expect(result.suggestions.map(({ key }) => key)).toEqual(["key29"]);
    expect(result.suggestedName).toBeNull();
    expect(result.notice).toContain("limited selection");
  });

  it("skips Jev when title and linked work have no meaningful text", async () => {
    const jev = client({});
    const result = await suggestThreadEfforts({ threadTitle: "  ", work: [{ label: "\n ", ticket: null }], efforts: [effort("one")], jev });
    expect(jev.ask).not.toHaveBeenCalled();
    expect(result).toEqual({ suggestions: [], suggestedName: null, notice: expect.any(String) });
  });

  it("propagates Jev errors so the server can report them", async () => {
    const jev: JevClient = { async ask() { throw new Error("offline"); } };
    await expect(suggestThreadEfforts({ threadTitle: "CI cache", work: [], efforts: [effort("one")], jev })).rejects.toThrow("offline");
  });
});
