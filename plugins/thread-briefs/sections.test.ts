import { describe, expect, it } from "vitest";
import {
  manualSectionOrder,
  mergeSectionOrder,
  planAssignments,
  planSections,
  sectionNameForStatus,
  storedStatus,
  OWNED_SECTION_NAMES,
  SECTION_NAMES,
  STATUS_SECTIONS,
  type SectionedThread,
} from "./sections.js";
import type { BriefFields, StoredBrief } from "./contract.js";

const stored = (fields: Partial<BriefFields> = {}): StoredBrief => ({
  version: 1,
  threadId: "thr_1",
  fields: {
    goal: "Ship sidebar grouping",
    currentState: "Sync written",
    nextStep: "Run the tests",
    blockedOn: "",
    constraints: "",
    ...fields,
  },
  modelStage: "implementation",
  stageOverride: null,
  stageOverrideSeq: null,
  endedWithQuestion: false,
  lastSummarizedAt: 1_000,
  lastActivitySeen: 50,
});

/** Section ids, as `ensureSections` would hand them over. */
const IDS = new Map([
  ["🙋 Waiting on you", "sec_wait"],
  ["⏸️ Blocked", "sec_blocked"],
  ["✅ Done", "sec_done"],
]);
const OWNED = new Set(IDS.values());

const plan = (
  threads: readonly SectionedThread[],
  targets: ReadonlyMap<string, string>,
) =>
  planAssignments({
    threads,
    sectionIdByThreadId: targets,
    ownedSectionIds: OWNED,
  });

describe("the section table", () => {
  it("covers every status a stored brief can have", () => {
    // `working` is live-only, so a section for it could never have members.
    // Every *other* status must have a section or its threads would silently
    // fall into the no-brief bucket.
    for (const status of ["waiting-on-me", "waiting-on-other", "done"] as const) {
      expect(sectionNameForStatus(status)).not.toBeNull();
    }
    expect(sectionNameForStatus("working")).toBeNull();
  });

  it("lists its names in display order", () => {
    expect(SECTION_NAMES).toEqual(["🙋 Waiting on you", "⏸️ Blocked", "✅ Done"]);
    expect(STATUS_SECTIONS.map((entry) => entry.status)).toEqual([
      "waiting-on-me",
      "waiting-on-other",
      "done",
    ]);
  });

  it("owns its former names as well as its current ones", () => {
    // Teardown filters on this: a section still under a former name is ours,
    // and skipping it would strand it in the sidebar for good.
    expect(OWNED_SECTION_NAMES).toEqual([
      "🙋 Waiting on you",
      "Waiting on you",
      "⏸️ Blocked",
      "Blocked",
      "✅ Done",
      "Done",
    ]);
  });

  it("puts bb's own Threads group last, after our sections", () => {
    expect(manualSectionOrder(["a", "b", "c"])).toEqual([
      "pinned",
      "section:a",
      "section:b",
      "section:c",
      "threads",
    ]);
  });
});

describe("mergeSectionOrder", () => {
  const canonical = ["pinned", "section:a", "section:b", "section:c", "threads"];

  it("writes the canonical order when the sidebar has none of its own", () => {
    expect(mergeSectionOrder(undefined, ["a", "b", "c"])).toEqual(canonical);
    expect(mergeSectionOrder(["pinned", "sections", "threads"], ["a", "b", "c"])).toEqual(
      canonical,
    );
  });

  it("leaves a hand-reordered sidebar alone", () => {
    // The whole point: a reconcile runs on every brief write, so an order that
    // merely differs from ours is a drag we must not undo.
    expect(
      mergeSectionOrder(
        ["threads", "pinned", "section:c", "section:a", "section:b"],
        ["a", "b", "c"],
      ),
    ).toBeNull();
    expect(mergeSectionOrder(canonical, ["a", "b", "c"])).toBeNull();
  });

  it("keeps the user's order when a new section has to be slotted in", () => {
    expect(
      mergeSectionOrder(["threads", "pinned", "section:c", "section:a"], ["a", "b", "c"]),
    ).toEqual(["threads", "pinned", "section:c", "section:a", "section:b"]);
  });

  it("slots a new section beside its siblings, not below bb's Threads group", () => {
    expect(mergeSectionOrder(["pinned", "section:b", "threads"], ["a", "b", "c"])).toEqual(
      ["pinned", "section:a", "section:b", "section:c", "threads"],
    );
  });

  it("drops an entry we no longer own and a duplicate", () => {
    expect(
      mergeSectionOrder(
        ["pinned", "section:gone", "section:c", "section:c", "threads"],
        ["a", "b", "c"],
      ),
    ).toEqual(["pinned", "section:a", "section:b", "section:c", "threads"]);
  });

  it("writes the canonical order when the stored value is not a string list", () => {
    expect(mergeSectionOrder(["pinned", 3], ["a", "b", "c"])).toEqual(canonical);
    expect(mergeSectionOrder("pinned", ["a", "b", "c"])).toEqual(canonical);
  });
});

describe("planSections", () => {
  const existing = (...names: string[]) =>
    names.map((name, index) => ({ id: `sec_${index + 1}`, name }));

  it("creates all three when the sidebar has none of ours", () => {
    const plan = planSections([{ id: "sec_theirs", name: "Reading" }]);
    expect(plan.steps).toEqual(
      SECTION_NAMES.map((name) => ({ name, id: null, renameFrom: null })),
    );
    expect(plan.retire).toEqual([]);
  });

  it("renames a section left under a former name, keeping its id", () => {
    // The id is what threads are filed against, so a rename has to carry the
    // members over rather than build an empty section beside the full one.
    const plan = planSections(existing("Waiting on you", "Blocked", "Done"));
    expect(plan.steps).toEqual([
      { name: "🙋 Waiting on you", id: "sec_1", renameFrom: "Waiting on you" },
      { name: "⏸️ Blocked", id: "sec_2", renameFrom: "Blocked" },
      { name: "✅ Done", id: "sec_3", renameFrom: "Done" },
    ]);
    expect(plan.retire).toEqual([]);
  });

  it("does nothing once every section is already named right", () => {
    const plan = planSections(existing(...SECTION_NAMES));
    expect(plan.steps.map((step) => step.renameFrom)).toEqual([null, null, null]);
    expect(plan.steps.map((step) => step.id)).toEqual(["sec_1", "sec_2", "sec_3"]);
    expect(plan.retire).toEqual([]);
  });

  it("retires a former-named leftover when the current one already exists", () => {
    // Half-migrated, or renamed by hand. Deleting the leftover drops its
    // assignments, so the same reconcile pass re-files those threads.
    const plan = planSections([
      { id: "sec_new", name: "⏸️ Blocked" },
      { id: "sec_old", name: "Blocked" },
    ]);
    expect(plan.steps[1]).toEqual({
      name: "⏸️ Blocked",
      id: "sec_new",
      renameFrom: null,
    });
    expect(plan.retire).toEqual(["sec_old"]);
  });
});

describe("storedStatus", () => {
  it("maps each kind of brief to its section", () => {
    expect(sectionNameForStatus(storedStatus(stored()))).toBe("🙋 Waiting on you");
    expect(
      sectionNameForStatus(storedStatus(stored({ blockedOn: "Review" }))),
    ).toBe("⏸️ Blocked");
    expect(
      sectionNameForStatus(
        storedStatus(stored({ nextStep: "", blockedOn: "" })),
      ),
    ).toBe("✅ Done");
  });

  it("sends an external actor to Blocked even with no blockedOn text", () => {
    expect(
      sectionNameForStatus(storedStatus(stored({ nextStepActor: "other" }))),
    ).toBe("⏸️ Blocked");
  });

  it("files a pinned thread where the pin says, not where its prose does", () => {
    // Sections are keyed on this, and nothing feeds a section assignment back
    // into a brief — so if the grouping ignored the override, the next
    // reconcile would put the thread straight back where you moved it from.
    const pinned: StoredBrief = {
      ...stored(),
      statusOverride: "done",
      statusOverrideSeq: 50,
    };
    expect(sectionNameForStatus(storedStatus(stored()))).toBe("🙋 Waiting on you");
    expect(sectionNameForStatus(storedStatus(pinned))).toBe("✅ Done");
  });

  it("stops honouring the pin once the thread has moved on", () => {
    const retired: StoredBrief = {
      ...stored(),
      statusOverride: "done",
      statusOverrideSeq: 50,
      lastActivitySeen: 51,
    };
    expect(sectionNameForStatus(storedStatus(retired))).toBe("🙋 Waiting on you");
  });
});

describe("planAssignments", () => {
  it("moves a thread into the section its brief implies", () => {
    expect(
      plan([{ id: "thr_1", sectionId: null }], new Map([["thr_1", "sec_wait"]])),
    ).toEqual([{ threadId: "thr_1", sectionId: "sec_wait" }]);
  });

  it("leaves a thread that is already in the right section untouched", () => {
    expect(
      plan(
        [{ id: "thr_1", sectionId: "sec_wait" }],
        new Map([["thr_1", "sec_wait"]]),
      ),
    ).toEqual([]);
  });

  it("re-files a thread whose status changed", () => {
    expect(
      plan(
        [{ id: "thr_1", sectionId: "sec_wait" }],
        new Map([["thr_1", "sec_done"]]),
      ),
    ).toEqual([{ threadId: "thr_1", sectionId: "sec_done" }]);
  });

  it("leaves a briefless thread unassigned, for bb's Threads group", () => {
    expect(plan([{ id: "thr_1", sectionId: null }], new Map())).toEqual([]);
  });

  it("clears a stale assignment left by a brief that is gone", () => {
    expect(plan([{ id: "thr_1", sectionId: "sec_done" }], new Map())).toEqual([
      { threadId: "thr_1", sectionId: null },
    ]);
  });

  it("does not touch a thread the user filed in their own section", () => {
    // Overwriting a deliberate placement costs more than a catch-all is worth.
    expect(
      plan([{ id: "thr_1", sectionId: "sec_reading_list" }], new Map()),
    ).toEqual([]);
  });

  it("is idempotent: re-planning the result of a plan is empty", () => {
    const threads: SectionedThread[] = [
      { id: "thr_1", sectionId: null },
      { id: "thr_2", sectionId: "sec_wait" },
      { id: "thr_3", sectionId: "sec_done" },
    ];
    const targets = new Map([
      ["thr_1", "sec_wait"],
      ["thr_2", "sec_blocked"],
    ]);

    const first = plan(threads, targets);
    expect(first).toHaveLength(3);

    const applied = threads.map((thread) => {
      const move = first.find((candidate) => candidate.threadId === thread.id);
      return move === undefined ? thread : { ...thread, sectionId: move.sectionId };
    });
    expect(plan(applied, targets)).toEqual([]);
  });
});
