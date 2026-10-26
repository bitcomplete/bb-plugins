import { describe, expect, it } from "vitest";
import { hasLessonAnchor, lessonAnchor, lessonScore, planLessonTransitions, removeLessonAnchor, retireLessonAnchor, retiredLessonAnchor, withLessonAnchor, type ScoreableLesson } from "./lessons.js";
import type { LessonRules } from "./config.js";

const DAY = 86_400_000;
const T = Date.parse("2026-10-18T05:00:00Z");

const rules: LessonRules = {
  trial: { max: 5, retireDays: 30 },
  promote: { hits: 3, days: 14 },
  promoted: { maxPerFile: 2, retireDays: 90, corrections: 2 },
  decayHalfLifeDays: 30,
};

function lesson(over: Partial<ScoreableLesson> = {}): ScoreableLesson {
  return { id: "lsn_a", tier: "trial", file: "AGENTS.md", hits: 0, corrections: 0, lastCitedAt: null, createdAt: T - 20 * DAY, tierAt: T - 20 * DAY, supersededBy: null, ...over };
}

describe("the lesson anchor", () => {
  it("carries the id in the file and finds it again", () => {
    expect(lessonAnchor("lsn_1")).toBe("<!-- lesson:lsn_1 -->");
    expect(withLessonAnchor("A rule.", "lsn_1")).toBe("<!-- lesson:lsn_1 -->\nA rule.");
    expect(hasLessonAnchor("x\n<!-- lesson:lsn_1 -->\nA rule.\n", "lsn_1")).toBe(true);
    expect(hasLessonAnchor("x\nA rule.\n", "lsn_1")).toBe(false);
  });

  it("removes exactly its own anchored block and nothing else", () => {
    const content = ["# Guidance", "", "Tail text.", "", withLessonAnchor("First rule.", "lsn_1"), "", withLessonAnchor("Second rule.", "lsn_2")].join("\n");
    const after = removeLessonAnchor(content, "lsn_1");
    expect(after).not.toContain("First rule.");
    expect(after).not.toContain(lessonAnchor("lsn_1"));
    // The neighbour, the headings and the tail are untouched.
    expect(after).toContain(withLessonAnchor("Second rule.", "lsn_2"));
    expect(after).toContain("Tail text.");
    expect(after).toContain("# Guidance");
  });

  it("removes the last block through the end of the file", () => {
    const content = `# Guidance\n\n${withLessonAnchor("Only rule.", "lsn_1")}\n`;
    expect(removeLessonAnchor(content, "lsn_1")).toBe("# Guidance\n\n");
  });

  it("leaves a file without the anchor unchanged", () => {
    expect(removeLessonAnchor("# Guidance\n", "lsn_1")).toBe("# Guidance\n");
    expect(retireLessonAnchor("# Guidance\n", "lsn_1")).toBe("# Guidance\n");
  });

  it("replaces the block with a retired anchor that is not a live anchor", () => {
    const content = `# Guidance\n\n${withLessonAnchor("A rule.", "lsn_1")}\n`;
    const after = retireLessonAnchor(content, "lsn_1");
    expect(after).toBe(`# Guidance\n\n${retiredLessonAnchor("lsn_1")}\n`);
    expect(after).not.toContain("A rule.");
    expect(hasLessonAnchor(after, "lsn_1")).toBe(false);
  });
});

describe("the lesson score", () => {
  it("halves a citation's weight every half-life", () => {
    const fresh = lessonScore({ hits: 4, corrections: 0, lastCitedAt: T, createdAt: T, tierAt: T }, T, 30 * DAY);
    const old = lessonScore({ hits: 4, corrections: 0, lastCitedAt: T - 30 * DAY, createdAt: T, tierAt: T }, T, 30 * DAY);
    expect(fresh).toBe(4);
    expect(old).toBe(2);
    // A correction subtracts.
    expect(lessonScore({ hits: 4, corrections: 1, lastCitedAt: T, createdAt: T, tierAt: T }, T, 30 * DAY)).toBe(3);
  });
});

describe("the nightly transitions", () => {
  it("promotes a trial with 3 distinct bindings, no corrections, 14 days in trial", () => {
    const ready = lesson({ hits: 3, lastCitedAt: T - 1 * DAY, tierAt: T - 20 * DAY });
    expect(planLessonTransitions([ready], rules, T)).toEqual([{ id: "lsn_a", action: "promote", reason: expect.stringContaining("3 bindings") }]);
    // Two hits is not enough.
    expect(planLessonTransitions([lesson({ hits: 2, lastCitedAt: T - 1 * DAY, tierAt: T - 20 * DAY })], rules, T)).toEqual([]);
    // Under 14 days in trial is not enough.
    expect(planLessonTransitions([lesson({ hits: 3, lastCitedAt: T - 1 * DAY, tierAt: T - 5 * DAY })], rules, T)).toEqual([]);
  });

  it("retires a trial uncited for 30 days, or on any correction", () => {
    expect(planLessonTransitions([lesson({ tierAt: T - 31 * DAY })], rules, T)).toEqual([{ id: "lsn_a", action: "retire", reason: expect.stringContaining("uncited") }]);
    expect(planLessonTransitions([lesson({ hits: 1, lastCitedAt: T - 40 * DAY, tierAt: T - 60 * DAY })], rules, T)).toEqual([{ id: "lsn_a", action: "retire", reason: expect.stringContaining("uncited") }]);
    expect(planLessonTransitions([lesson({ corrections: 1, lastCitedAt: T - 1 * DAY })], rules, T)).toEqual([{ id: "lsn_a", action: "retire", reason: "corrected" }]);
  });

  it("retires a promoted lesson uncited for 90 days or with 2 corrections", () => {
    expect(planLessonTransitions([lesson({ tier: "promoted", tierAt: T - 91 * DAY })], rules, T)).toEqual([{ id: "lsn_a", action: "retire", reason: expect.stringContaining("uncited") }]);
    expect(planLessonTransitions([lesson({ tier: "promoted", corrections: 2, lastCitedAt: T - 1 * DAY })], rules, T)).toEqual([{ id: "lsn_a", action: "retire", reason: "2 corrections" }]);
    expect(planLessonTransitions([lesson({ tier: "promoted", corrections: 1, lastCitedAt: T - 1 * DAY })], rules, T)).toEqual([]);
  });

  it("retires a superseded lesson, and never also promotes it", () => {
    const superseded = lesson({ hits: 5, lastCitedAt: T - 1 * DAY, supersededBy: "lsn_new" });
    expect(planLessonTransitions([superseded], rules, T)).toEqual([{ id: "lsn_a", action: "retire", reason: "superseded by lsn_new" }]);
  });

  it("displaces the lowest-scoring promoted lesson when a file is full", () => {
    const low = lesson({ id: "lsn_low", tier: "promoted", file: "AGENTS.md", hits: 1, lastCitedAt: T - 80 * DAY, tierAt: T - 200 * DAY });
    const high = lesson({ id: "lsn_high", tier: "promoted", file: "AGENTS.md", hits: 5, lastCitedAt: T - 1 * DAY, tierAt: T - 200 * DAY });
    const newcomer = lesson({ id: "lsn_new", hits: 3, lastCitedAt: T - 1 * DAY, tierAt: T - 20 * DAY });
    const plan = planLessonTransitions([low, high, newcomer], rules, T);
    expect(plan).toContainEqual({ id: "lsn_low", action: "retire", reason: "displaced by lsn_new" });
    expect(plan).toContainEqual({ id: "lsn_new", action: "promote", reason: expect.stringContaining("3 bindings"), displacedId: "lsn_low" });
    // A file with room promotes without displacing.
    expect(planLessonTransitions([newcomer], rules, T)).toEqual([{ id: "lsn_new", action: "promote", reason: expect.stringContaining("3 bindings") }]);
  });

  it("ignores candidates and retired lessons", () => {
    expect(planLessonTransitions([lesson({ tier: "candidate", hits: 9 })], rules, T)).toEqual([]);
    expect(planLessonTransitions([lesson({ tier: "retired", hits: 9 })], rules, T)).toEqual([]);
  });
});
