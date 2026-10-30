import { describe, expect, it } from "vitest";
import { GUIDANCE_UNCITED_DAYS, escalationWeeks, guidanceUnitId, isGuidanceUnitId, normalizeGuidanceText, parseGuidanceUnits, uncitedGuidanceUnits, weekStart } from "./guidance.js";
import { removeLessonAnchor, retireLessonAnchor, withLessonAnchor } from "./lessons.js";

const DAY = 86_400_000;
const T = Date.parse("2026-10-21T12:00:00Z");

describe("the guidance unit index (BB-35 step 6)", () => {
  it("keys a paragraph by its content, stable across a rewrap and elsewhere in the file", () => {
    const id = guidanceUnitId("A new column read with SELECT * breaks the previous image.");
    expect(isGuidanceUnitId(id)).toBe(true);
    expect(id).toMatch(/^gu_[0-9a-f]{16}$/u);
    // The same words reflowed are the same unit; a different word is not.
    expect(guidanceUnitId("A new column\nread with SELECT *   breaks the previous image.")).toBe(id);
    expect(guidanceUnitId("A new column read with SELECT breaks the previous image.")).not.toBe(id);
    expect(normalizeGuidanceText("  a\n b  ")).toBe("a b");
  });

  it("splits a file into paragraphs under their nearest heading", () => {
    const content = ["# Cross-repo guidance", "", "First paragraph.", "Still first.", "", "## Repos", "", "Second paragraph.", "", "- a list item", "- another"].join("\n");
    const units = parseGuidanceUnits("AGENTS.md", content);
    expect(units.map((u) => ({ heading: u.heading, text: u.text }))).toEqual([
      { heading: "Cross-repo guidance", text: "First paragraph.\nStill first." },
      { heading: "Repos", text: "Second paragraph." },
      { heading: "Repos", text: "- a list item\n- another" },
    ]);
    expect(units.every((u) => u.file === "AGENTS.md" && u.lessonId === null)).toBe(true);
  });

  it("drops a playbook's YAML frontmatter as metadata, not guidance", () => {
    const content = ["---", "name: linear-tickets", "kind: ticket", "---", "", "# Phases", "", "Real guidance."].join("\n");
    const units = parseGuidanceUnits("stewards/playbooks/linear-tickets.md", content);
    expect(units.map((u) => u.text)).toEqual(["Real guidance."]);
    expect(units[0]!.heading).toBe("Phases");
  });

  it("does not take a `#` inside a fenced code block for a heading", () => {
    const content = ["# Real heading", "", "```sh", "# a shell comment", "git commit -m x", "```", "", "After the fence."].join("\n");
    const units = parseGuidanceUnits("AGENTS.md", content);
    expect(units.map((u) => ({ heading: u.heading, text: u.text }))).toEqual([
      { heading: "Real heading", text: "```sh\n# a shell comment\ngit commit -m x\n```" },
      { heading: "Real heading", text: "After the fence." },
    ]);
  });

  it("tags an anchored lesson block and keeps it out of the hand-written units", () => {
    const content = `# Guidance\n\nHand-written before.\n\n${withLessonAnchor("A promoted rule.", "lsn_1")}\n\nHand-written after.\n`;
    const units = parseGuidanceUnits("AGENTS.md", content);
    const lesson = units.find((u) => u.lessonId === "lsn_1")!;
    expect(lesson.text).toContain("A promoted rule.");
    expect(units.filter((u) => u.lessonId === null).map((u) => u.text)).toEqual(["Hand-written before.", "Hand-written after."]);
  });

  it("never auto-retires a hand-written unit: only the anchored lesson block is removed", () => {
    // Half one: the hand-written units survive a retirement byte for byte.
    const before = parseGuidanceUnits("AGENTS.md", "# Guidance\n\nHand-written before.\n");
    const content = `# Guidance\n\nHand-written before.\n\n${withLessonAnchor("A promoted rule.", "lsn_1")}\n\n${withLessonAnchor("A second rule.", "lsn_2")}\n\nHand-written after.\n`;
    const handWrittenBefore = parseGuidanceUnits("AGENTS.md", content).filter((u) => u.lessonId === null).map((u) => u.id);
    const after = removeLessonAnchor(content, "lsn_1");
    expect(after).toContain("Hand-written before.");
    expect(after).toContain("Hand-written after.");
    expect(after).not.toContain("A promoted rule.");
    expect(parseGuidanceUnits("AGENTS.md", after).filter((u) => u.lessonId === null).map((u) => u.id)).toEqual(handWrittenBefore);
    expect(before[0]!.id).toBe(guidanceUnitId("Hand-written before."));
    // Half two: retirement touches exactly the lesson's own anchored block, not its neighbour's.
    const retired = retireLessonAnchor(content, "lsn_1");
    expect(retired).toContain("<!-- lesson:lsn_1 retired -->");
    expect(retired).not.toContain("A promoted rule.");
    expect(retired).toContain(withLessonAnchor("A second rule.", "lsn_2"));
    expect(retired).toContain("Hand-written after.");
  });

  it("lists the hand-written units uncited for 90 days, never a lesson-backed one", () => {
    const units = [
      { id: "gu_aaaaaaaaaaaaaaaa", file: "AGENTS.md", heading: "Old", text: "Never cited.", lessonId: null },
      { id: "gu_bbbbbbbbbbbbbbbb", file: "stewards/playbooks/linear-tickets.md", heading: null, text: "Cited long ago.", lessonId: null },
      { id: "gu_cccccccccccccccc", file: "AGENTS.md", heading: null, text: "Cited recently.", lessonId: null },
      { id: "gu_dddddddddddddddd", file: "AGENTS.md", heading: null, text: "A lesson block.", lessonId: "lsn_1" },
    ];
    const citations = [
      { unitId: "gu_bbbbbbbbbbbbbbbb", lastCitedAt: T - 100 * DAY },
      { unitId: "gu_cccccccccccccccc", lastCitedAt: T - 2 * DAY },
    ];
    expect(uncitedGuidanceUnits(units, citations, T).map((u) => [u.unit.id, u.lastCitedAt])).toEqual([
      ["gu_aaaaaaaaaaaaaaaa", null],
      ["gu_bbbbbbbbbbbbbbbb", T - 100 * DAY],
    ]);
    // The window is configurable and defaults to 90 days.
    expect(GUIDANCE_UNCITED_DAYS).toBe(90);
    // A shorter window includes the recently cited one; the lesson-backed block is always left out.
    expect(uncitedGuidanceUnits(units, citations, T, 1).map((u) => u.unit.id)).toEqual(["gu_aaaaaaaaaaaaaaaa", "gu_bbbbbbbbbbbbbbbb", "gu_cccccccccccccccc"]);
  });
});

describe("the efficacy view's escalation trend (BB-35 step 6)", () => {
  it("buckets escalations reaching the user by Monday-start week, oldest first", () => {
    const monday = Date.parse("2026-10-19T00:00:00Z");
    expect(weekStart(monday + 3 * DAY)).toBe(monday);
    const weeks = escalationWeeks([monday - 8 * DAY, monday - 7 * DAY, monday, monday + DAY, monday + 7 * DAY], monday + 7 * DAY, 3);
    expect(weeks).toEqual([
      { start: monday - 7 * DAY, count: 1 },
      { start: monday, count: 2 },
      { start: monday + 7 * DAY, count: 1 },
    ]);
  });
});
