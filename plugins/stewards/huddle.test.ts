// BB-300 slice 3: the huddle's instruction builder, its fixed tool set, and
// the note record. Nothing here touches OpenAI or the network: the tool
// readers are injected, so the whole surface is unit-tested.
import { describe, expect, it } from "vitest";
import {
  HUDDLE_MAX_INSTRUCTIONS_CHARS,
  HUDDLE_NOTE_TYPES,
  HUDDLE_TOOL_NAMES,
  HUDDLE_TOOLS,
  HUDDLE_WRITE_TOOLS,
  buildHuddleInstructions,
  readbackLine,
  readbackLines,
  runHuddleTool,
  type HuddleNote,
  type HuddleRecord,
  type HuddleToolContext,
} from "./huddle.js";
import type { Briefing } from "./nightly.js";
import type { Binding, Escalation, Lesson } from "./store.js";
import type { GuidanceUnit } from "./guidance.js";
import { issue } from "./fixtures.js";

const binding = (over: Partial<Binding> = {}): Binding =>
  ({
    id: "b1",
    projectId: "p1",
    entityId: "uuid-12",
    entityKey: "ENG-12",
    url: "https://linear.app/acme/issue/ENG-12",
    title: "Fix login",
    kind: "ticket",
    phase: "build",
    source: "linear",
    guidance: [],
    pending: [],
    status: { actor: "steward", nextAction: "review", summary: "In review", waitingOn: "the review", at: 1 },
    hold: null,
    holdBehind: [],
    lastSnapshot: { entity: issue(), pulls: [] },
    ...over,
  }) as unknown as Binding;

const escalation = (over: Partial<Escalation> = {}): Escalation =>
  ({
    id: "esc_1",
    bindingId: "b1",
    kind: "decide",
    question: "Merge or close?",
    context: "The check is green.",
    meanwhile: "Waiting.",
    route: "user",
    recommendation: "Merge it.",
    choices: ["Merge", "Close"],
    status: "open",
    resolution: null,
    createdAt: 1,
    ...over,
  }) as unknown as Escalation;

const lesson = (over: Partial<Lesson> = {}): Lesson =>
  ({
    id: "lsn_1",
    projectId: "p1",
    bindingId: "b1",
    escalationId: "esc_1",
    file: "AGENTS.md",
    text: "Prefer the smaller change.",
    scope: "procedure",
    status: "pending",
    tier: "candidate",
    createdAt: 1,
    ...over,
  }) as unknown as Lesson;

const unit = (over: Partial<GuidanceUnit> = {}): GuidanceUnit => ({ id: "gu_1", file: "AGENTS.md", heading: "Merging", text: "Merge only green checks.", lessonId: null, ...over });

function context(over: Partial<HuddleToolContext> = {}): HuddleToolContext {
  const record: HuddleRecord = { projectId: "p1", startedAt: 1, notes: [], connected: false };
  return {
    projectId: "p1",
    now: () => 1_000,
    binding: (key) => (key === "ENG-12" ? binding() : null),
    openEscalations: () => [escalation()],
    escalation: (id) => (id === "esc_1" ? escalation() : null),
    lessons: () => [lesson()],
    guidance: async () => [unit()],
    snapshot: async () => issue(),
    needs: () => [],
    confirmed: [],
    record,
    ...over,
  };
}

describe("the huddle tool set (BB-300)", () => {
  it("declares the fixed, small tool set", () => {
    expect(HUDDLE_TOOL_NAMES).toEqual(["steward_status", "escalation", "entity_snapshot", "decision_rationale", "playbook_paragraph", "take_note", "retract_note"]);
    // Every declaration carries the shape the Realtime API needs.
    for (const tool of HUDDLE_TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/u);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toMatchObject({ type: "object" });
    }
  });

  it("has exactly take_note and retract_note as writers", () => {
    expect([...HUDDLE_WRITE_TOOLS].sort()).toEqual(["retract_note", "take_note"]);
    for (const name of HUDDLE_WRITE_TOOLS) expect(HUDDLE_TOOL_NAMES).toContain(name);
  });

  it("offers every typed note shape plus a free note", () => {
    expect(HUDDLE_NOTE_TYPES).toEqual(["resolve-escalation", "gate", "guidance", "direction", "standing-rule", "free"]);
  });
});

describe("runHuddleTool (BB-300)", () => {
  it("reads a steward's status without touching the record", async () => {
    const ctx = context();
    const out = await runHuddleTool("steward_status", { key: "ENG-12" }, ctx);
    expect(out).toContain("ENG-12");
    expect(out).toContain("phase build");
    expect(out).toContain("the review");
    expect(out).toContain("Merge or close?");
    expect(ctx.record.notes).toHaveLength(0);
  });

  it("reads an escalation in full", async () => {
    const out = await runHuddleTool("escalation", { escalationId: "esc_1" }, context());
    expect(out).toContain("Merge or close?");
    expect(out).toContain("Choices: Merge / Close");
    expect(out).toContain("Meanwhile: Waiting.");
    expect(out).toContain("recommends: Merge it.");
  });

  it("reads the entity through the source snapshot", async () => {
    const out = await runHuddleTool("entity_snapshot", { key: "ENG-12" }, context());
    expect(out).toContain("Fix login");
    expect(out).toContain("Todo");
  });

  it("reads the lessons behind a decision", async () => {
    const out = await runHuddleTool("decision_rationale", { key: "ENG-12" }, context());
    expect(out).toContain("Prefer the smaller change.");
  });

  it("reads a playbook paragraph as written, and filters by file and query", async () => {
    const out = await runHuddleTool("playbook_paragraph", { query: "green" }, context());
    expect(out).toContain("Merge only green checks.");
    expect(await runHuddleTool("playbook_paragraph", { file: "AGENTS.md" }, context())).toContain("Merge only green checks.");
    expect(await runHuddleTool("playbook_paragraph", { query: "nothing-here" }, context())).toContain("No guidance paragraph");
  });

  it("refuses an unknown tool", async () => {
    await expect(runHuddleTool("merge_everything", {}, context())).rejects.toThrow(/No huddle tool/u);
  });

  it("takes and retracts notes, touching only the huddle record", async () => {
    const ctx = context();
    const before = JSON.stringify(ctx.record.notes);
    const taken = await runHuddleTool("take_note", { type: "guidance", text: "Keep it small", binding: "ENG-12" }, ctx);
    expect(taken).toContain("Keep it small");
    expect(ctx.record.notes).toHaveLength(1);
    expect(ctx.record.notes[0]).toMatchObject({ type: "guidance", text: "Keep it small", binding: "ENG-12", escalation: null, action: null });
    // The only state that changed is the record's own note list.
    expect(JSON.stringify(ctx.record.notes)).not.toBe(before);
    const id = ctx.record.notes[0]!.id;
    const retracted = await runHuddleTool("retract_note", { id }, ctx);
    expect(retracted).toContain("Keep it small");
    expect(ctx.record.notes).toHaveLength(0);
  });

  it("requires a valid type and text for a note", async () => {
    await expect(runHuddleTool("take_note", { type: "nonsense", text: "x" }, context())).rejects.toThrow(/type must be/u);
    await expect(runHuddleTool("take_note", { type: "free", text: "   " }, context())).rejects.toThrow(/text is required/u);
  });

  it("reports a note that is not there rather than failing", async () => {
    expect(await runHuddleTool("retract_note", { id: "note_nope" }, context())).toContain("No note");
  });

  it("refuses to retract a note the owner already confirmed", async () => {
    const ctx = context({ confirmed: ["note_1"] });
    ctx.record.notes.push({ id: "note_1", type: "guidance", text: "Keep it", binding: "ENG-12", escalation: null, action: null, need: null, needLabel: null, createdAt: 1 });
    const out = await runHuddleTool("retract_note", { id: "note_1" }, ctx);
    expect(out).toContain("already been applied");
    expect(ctx.record.notes).toHaveLength(1);
  });

  it("binds a gate note to one open need, and refuses an ambiguous one", async () => {
    const first = { id: "need_1", kind: "approve-pr", what: "Approve acme/web#7 on GitHub", url: "https://github.com/acme/web/pull/7" } as never;
    const second = { id: "need_2", kind: "approve-pr", what: "Approve acme/web#8 on GitHub", url: "https://github.com/acme/web/pull/8" } as never;
    const one = context({ needs: () => [first] });
    expect(await runHuddleTool("take_note", { type: "gate", text: "Looks good", binding: "ENG-12", action: "approve" }, one)).toContain("Looks good");
    expect(one.record.notes[0]).toMatchObject({ need: "need_1", needLabel: "Approve acme/web#7 on GitHub" });
    await expect(runHuddleTool("take_note", { type: "gate", text: "Looks good", binding: "ENG-12", action: "approve" }, context({ needs: () => [first, second] }))).rejects.toThrow(/several open gate items/u);
    const named = context({ needs: () => [first, second] });
    await runHuddleTool("take_note", { type: "gate", text: "Looks good", binding: "ENG-12", action: "approve", need: "need_2" }, named);
    expect(named.record.notes[0]).toMatchObject({ need: "need_2" });
  });
});

const briefing = (over: Partial<Briefing> = {}): Briefing => ({
  since: 500,
  previous: null,
  notes: [],
  decisions: { needs: [{ need: { what: "Approve the spec", kind: "approve-spec" } as never, binding: binding({ entityKey: "ENG-12" }) }], withUser: [] },
  escalations: [{ escalation: escalation({ question: "A project question" }), from: binding({ entityKey: "ENG-13" }) }],
  stuck: { stuck: [{ escalation: escalation({ kind: "stuck", question: "Blocked on CI" }), from: binding({ entityKey: "ENG-14" }) }], held: [binding({ entityKey: "ENG-15", hold: "behind ENG-16", holdBehind: ["ENG-16"] })], noWakeSource: [], stall: [], datedWaits: [] },
  done: { moved: [binding({ entityKey: "ENG-17" })], ended: [binding({ entityKey: "ENG-18", endReason: "merged" })], answered: [] },
  assumptions: [{ assumption: { text: "the schema is stable" } as never, binding: binding({ entityKey: "ENG-19" }) }],
  ...over,
});

describe("the mechanical readback (BB-300 slice 4)", () => {
  const note = (over: Partial<HuddleNote> = {}): HuddleNote => ({ id: "note_1", type: "free", text: "Something", binding: null, escalation: null, action: null, need: null, needLabel: null, createdAt: 1, ...over });

  it("renders one line per typed shape from the stored note, not the model", () => {
    expect(readbackLine(note({ type: "resolve-escalation", escalation: "esc_1", text: "Merge it" }))).toBe("Resolve escalation esc_1 with: Merge it");
    expect(readbackLine(note({ type: "gate", binding: "ENG-12", action: "approve", text: "Looks good" }))).toBe("Approve ENG-12: Looks good");
    expect(readbackLine(note({ type: "gate", binding: "ENG-12", action: "decline", text: "Not yet" }))).toBe("Decline ENG-12: Not yet");
    expect(readbackLine(note({ type: "gate", binding: "ENG-12", action: "merge", text: "Ship it" }))).toBe("Merge ENG-12: Ship it");
    expect(readbackLine(note({ type: "guidance", binding: "ENG-12", text: "Keep it small" }))).toBe("Guidance for ENG-12: Keep it small");
    expect(readbackLine(note({ type: "direction", text: "Prioritise the migration" }))).toBe("Project direction: Prioritise the migration");
    expect(readbackLine(note({ type: "standing-rule", text: "Never merge red checks" }))).toBe("Standing rule: Never merge red checks");
    expect(readbackLine(note({ type: "free", text: "A thought" }))).toBe("Note: A thought");
  });

  it("keeps the order the notes were taken in", () => {
    expect(readbackLines([note({ id: "a", type: "direction", text: "One" }), note({ id: "b", type: "free", text: "Two" })])).toEqual(["Project direction: One", "Note: Two"]);
  });
});

describe("buildHuddleInstructions (BB-300)", () => {
  it("ranks decisions first, then stuck, then done, and calls out deviations", () => {
    const text = buildHuddleInstructions(briefing(), "Acme", 10_000);
    const decisions = text.indexOf("## Decisions waiting on the owner");
    const projectEscalations = text.indexOf("## Escalations with the project steward");
    const stuck = text.indexOf("## Stuck or held");
    const done = text.indexOf("## Done since");
    const deviations = text.indexOf("## Approaches that departed from the written playbook");
    expect(decisions).toBeGreaterThan(-1);
    expect(decisions).toBeLessThan(projectEscalations);
    expect(projectEscalations).toBeLessThan(stuck);
    expect(stuck).toBeLessThan(done);
    expect(done).toBeLessThan(deviations);
    expect(text).toContain("Acme");
    expect(text).toContain("Approve the spec");
    expect(text).toContain("Blocked on CI");
    expect(text).toContain("merged");
    expect(text).toContain("the schema is stable");
    // The write boundary is stated to the model, and the tools are separate.
    expect(text).toContain("cannot act on a steward, merge, resolve or change anything");
  });

  it("says the beginning when there is no previous huddle", () => {
    expect(buildHuddleInstructions(briefing({ since: 0 }), "Acme", 10_000)).toContain("since the beginning");
  });

  it("keeps a huge briefing under the voice plugin's instruction cap, ranked", () => {
    const many = Array.from({ length: 400 }, (_, i) => binding({ entityKey: `ENG-${i}` }));
    const text = buildHuddleInstructions(briefing({ done: { moved: [], ended: many, answered: [] } }), "Acme", 10_000);
    expect(text.length).toBeLessThanOrEqual(HUDDLE_MAX_INSTRUCTIONS_CHARS);
    expect(text).toMatch(/…and \d+ more/u);
    // The decisions section survives even when the tail is huge.
    expect(text).toContain("Approve the spec");
  });

  it("drops the tail to fit the cap and never empties a section into '(none)'", () => {
    // Each section is under the per-section cap, but the whole is well over the
    // voice plugin's limit, so the length loop must empty some later sections.
    const long = (label: string, i: number): string => `${label}-${i}: ${"x".repeat(180)}`;
    const needs = Array.from({ length: 35 }, (_, i) => ({ need: { what: long("need", i), kind: "approve-spec" } as never, binding: binding({ entityKey: `ENG-${i}` }) }));
    const escalations = Array.from({ length: 35 }, (_, i) => ({ escalation: escalation({ question: long("esc", i) }), from: binding({ entityKey: `ENG-${i}` }) }));
    const stuck = Array.from({ length: 35 }, (_, i) => ({ escalation: escalation({ kind: "stuck", question: long("stuck", i) }), from: binding({ entityKey: `ENG-${i}` }) }));
    const moved = Array.from({ length: 35 }, (_, i) => binding({ entityKey: `ENG-${i}`, status: { summary: long("moved", i) } as never }));
    const assumptions = Array.from({ length: 35 }, (_, i) => ({ assumption: { text: long("assume", i) } as never, binding: binding({ entityKey: `ENG-${i}` }) }));
    const text = buildHuddleInstructions(
      briefing({
        decisions: { needs, withUser: [] },
        escalations,
        stuck: { stuck, held: [], noWakeSource: [], stall: [], datedWaits: [] },
        done: { moved, ended: [], answered: [] },
        assumptions,
      }),
      "Acme",
      10_000,
    );
    expect(text.length).toBeLessThanOrEqual(HUDDLE_MAX_INSTRUCTIONS_CHARS);
    // A section the loop emptied says it was omitted, not that it had nothing.
    expect(text).toContain("(omitted to fit the briefing limit)");
    expect(text).not.toMatch(/## Done since\n- \(none\)/u);
  });
});
