import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createEffortNotesStore, EFFORT_NOTES_MIGRATION, firstLine } from "./effort-notes.js";

function setup() {
  const db = new Database(":memory:");
  db.exec(EFFORT_NOTES_MIGRATION);
  let now = 1_000;
  return { notes: createEffortNotesStore(db, () => now), tick: () => { now += 1_000; } };
}

describe("effort notes", () => {
  it("starts every effort empty at revision 0, and each save moves it one revision on", () => {
    const { notes, tick } = setup();
    expect(notes.get("effort-shelf")).toEqual({ body: "", revision: 0, updatedAt: null });
    expect(notes.save("effort-shelf", "Flags: shelf_v2\n\n", 0)).toEqual({ body: "Flags: shelf_v2", revision: 1, updatedAt: 1_000 });
    tick();
    expect(notes.save("effort-shelf", "Flags: shelf_v3", 1)).toEqual({ body: "Flags: shelf_v3", revision: 2, updatedAt: 2_000 });
    expect(notes.get("effort-shelf")).toEqual({ body: "Flags: shelf_v3", revision: 2, updatedAt: 2_000 });
    expect(notes.get("effort-pickup")).toEqual({ body: "", revision: 0, updatedAt: null });
  });

  // Two views editing the same notes: whoever saves second edited an old revision, and must see the newer notes before theirs replace them.
  it("refuses a save over a revision someone saved since, and changes nothing", () => {
    const { notes } = setup();
    notes.save("effort-shelf", "First", 0);
    expect(() => notes.save("effort-shelf", "Also first", 0)).toThrow("These notes changed since you opened them.");
    notes.save("effort-shelf", "Second", 1);
    expect(() => notes.save("effort-shelf", "Stale", 1)).toThrow("These notes changed since you opened them.");
    expect(notes.get("effort-shelf")).toMatchObject({ body: "Second", revision: 2 });
  });

  it("collapses to the first line with text, without its Markdown marker", () => {
    expect(["\n\n## Flags\n- one", "- [ ] try genre sort", "> quoted", "3. third", "plain line\nmore", "", "  \n "].map(firstLine))
      .toEqual(["Flags", "try genre sort", "quoted", "third", "plain line", "", ""]);
  });
});
