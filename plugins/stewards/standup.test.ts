// BB-300 slice 3: the stand-up's instruction builder, its fixed tool set, and
// the note record. Nothing here touches OpenAI or the network: the tool
// readers are injected, so the whole surface is unit-tested.
import { describe, expect, it, vi } from "vitest";
import {
  STANDUP_CONTEXT_MAX_CHARS,
  STANDUP_MAX_INSTRUCTIONS_CHARS,
  STANDUP_NOTE_TYPES,
  STANDUP_STALE_DAYS,
  STANDUP_TOOL_NAMES,
  STANDUP_TOOLS,
  STANDUP_WRITE_TOOLS,
  buildStandupInstructions,
  readbackLine,
  readbackLines,
  runStandupTool,
  type StandupNote,
  type StandupRecord,
  type StandupToolContext,
} from "./standup.js";
import type { Briefing } from "./nightly.js";
import type { Binding, Escalation, Lesson } from "./store.js";
import type { GuidanceUnit } from "./guidance.js";
import { comment, issue } from "./fixtures.js";

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
    createdAt: 1,
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

function context(over: Partial<StandupToolContext> = {}): StandupToolContext {
  const record: StandupRecord = { projectId: "p1", startedAt: 1, notes: [], connected: false };
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
    endStandup: async (ids) => ({ output: `end ${ids.join(",")}`, applied: ids, skipped: [] }),
    record,
    ...over,
  };
}

describe("the stand-up tool set (BB-300)", () => {
  it("declares the fixed, small tool set", () => {
    expect(STANDUP_TOOL_NAMES).toEqual(["steward_status", "escalation", "entity_snapshot", "decision_rationale", "playbook_paragraph", "readback", "take_note", "retract_note", "end_standup"]);
    // Every declaration carries the shape the Realtime API needs.
    for (const tool of STANDUP_TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/u);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toMatchObject({ type: "object" });
    }
  });

  it("has exactly take_note and retract_note as writers", () => {
    expect([...STANDUP_WRITE_TOOLS].sort()).toEqual(["retract_note", "take_note"]);
    for (const name of STANDUP_WRITE_TOOLS) expect(STANDUP_TOOL_NAMES).toContain(name);
  });

  it("offers every typed note shape plus a free note", () => {
    expect(STANDUP_NOTE_TYPES).toEqual(["resolve-escalation", "gate", "guidance", "direction", "standing-rule", "free"]);
  });
});

describe("runStandupTool (BB-300)", () => {
  it("reads a steward's status without touching the record", async () => {
    const ctx = context();
    const out = await runStandupTool("steward_status", { key: "ENG-12" }, ctx);
    expect(out).toContain("ENG-12");
    expect(out).toContain("phase build");
    expect(out).toContain("the review");
    expect(out).toContain("Merge or close?");
    expect(ctx.record.notes).toHaveLength(0);
  });

  it("reads an escalation in full", async () => {
    const out = await runStandupTool("escalation", { escalationId: "esc_1" }, context());
    expect(out).toContain("Merge or close?");
    expect(out).toContain("Choices: Merge / Close");
    expect(out).toContain("Meanwhile: Waiting.");
    expect(out).toContain("recommends: Merge it.");
  });

  it("reads the entity through the source snapshot", async () => {
    const out = await runStandupTool("entity_snapshot", { key: "ENG-12" }, context());
    expect(out).toContain("Fix login");
    expect(out).toContain("Todo");
  });

  it("shows the last comments, linked pull requests and children from the snapshot (BB-306)", async () => {
    const ctx = context({
      snapshot: async () =>
        issue({
          comments: [
            comment({ id: "c1", author: "Sam", did: "commented", body: "Can we also cover SSO?", createdAt: "2026-10-02T00:00:00Z" }),
            comment({ id: "c2", author: "Jane", did: "approved", body: "Looks good to me.", createdAt: "2026-10-03T00:00:00Z" }),
          ],
          linkedPulls: [{ url: "https://github.com/acme/web/pull/7", key: "acme/web#7" }],
          children: [{ id: "acme/web#13", key: "acme/web#13", title: "Sub-task", state: "open", stateType: null, labels: [] }],
        }),
    });
    const out = (await runStandupTool("entity_snapshot", { key: "ENG-12" }, ctx)) as string;
    expect(out).toContain("2026-10-02T00:00:00Z Sam commented: Can we also cover SSO?");
    expect(out).toContain("2026-10-03T00:00:00Z Jane approved: Looks good to me.");
    expect(out).toContain("Linked pull requests: acme/web#7");
    expect(out).toContain("Children: acme/web#13 Sub-task (open)");
  });

  it("reads the lessons behind a decision", async () => {
    const out = await runStandupTool("decision_rationale", { key: "ENG-12" }, context());
    expect(out).toContain("Prefer the smaller change.");
  });

  it("reads a playbook paragraph as written, and filters by file and query", async () => {
    const out = await runStandupTool("playbook_paragraph", { query: "green" }, context());
    expect(out).toContain("Merge only green checks.");
    expect(await runStandupTool("playbook_paragraph", { file: "AGENTS.md" }, context())).toContain("Merge only green checks.");
    expect(await runStandupTool("playbook_paragraph", { query: "nothing-here" }, context())).toContain("No guidance paragraph");
  });

  it("refuses an unknown tool", async () => {
    await expect(runStandupTool("merge_everything", {}, context())).rejects.toThrow(/No stand-up tool/u);
  });

  it("reads the mechanical readback lines, with note ids, and writes nothing", async () => {
    const ctx = context();
    ctx.record.notes.push(
      { id: "note_1", type: "guidance", text: "Keep it small", binding: "ENG-12", escalation: null, action: null, need: null, needLabel: null, createdAt: 1 },
      { id: "note_2", type: "free", text: "A thought", binding: null, escalation: null, action: null, need: null, needLabel: null, createdAt: 2 },
    );
    const before = JSON.stringify(ctx.record.notes);
    const out = (await runStandupTool("readback", {}, ctx)) as string;
    expect(out).toContain("Guidance for ENG-12: Keep it small (id note_1)");
    expect(out).toContain("Note: A thought (id note_2)");
    expect(JSON.stringify(ctx.record.notes)).toBe(before);
  });

  it("says so when there is nothing to read back", async () => {
    expect(await runStandupTool("readback", {}, context())).toContain("No notes");
  });

  it("ends the stand-up through the injected callback and returns the last-reply flag", async () => {
    const endStandup = vi.fn(async (ids: string[]) => ({ output: `Applied ${ids.length}.`, applied: ids, skipped: [] }));
    const out = await runStandupTool("end_standup", { ids: ["note_1", "note_2"] }, context({ endStandup }));
    expect(out).toEqual({ output: "Applied 2.", last: true });
    expect(endStandup).toHaveBeenCalledWith(["note_1", "note_2"]);
  });

  it("requires an array of ids for end_standup", async () => {
    await expect(runStandupTool("end_standup", {}, context())).rejects.toThrow(/must be an array/u);
  });

  it("passes a busy end_standup outcome through as last: false", async () => {
    const endStandup = vi.fn(async () => ({ output: "Retry.", applied: [], skipped: [], last: false }));
    const out = await runStandupTool("end_standup", { ids: ["note_1"] }, context({ endStandup }));
    expect(out).toEqual({ output: "Retry.", last: false });
  });

  it("takes and retracts notes, touching only the stand-up record", async () => {
    const ctx = context();
    const before = JSON.stringify(ctx.record.notes);
    const taken = await runStandupTool("take_note", { type: "guidance", text: "Keep it small", binding: "ENG-12" }, ctx);
    expect(taken).toContain("Keep it small");
    expect(ctx.record.notes).toHaveLength(1);
    expect(ctx.record.notes[0]).toMatchObject({ type: "guidance", text: "Keep it small", binding: "ENG-12", escalation: null, action: null });
    // The only state that changed is the record's own note list.
    expect(JSON.stringify(ctx.record.notes)).not.toBe(before);
    const id = ctx.record.notes[0]!.id;
    const retracted = await runStandupTool("retract_note", { id }, ctx);
    expect(retracted).toContain("Keep it small");
    expect(ctx.record.notes).toHaveLength(0);
  });

  it("requires a valid type and text for a note", async () => {
    await expect(runStandupTool("take_note", { type: "nonsense", text: "x" }, context())).rejects.toThrow(/type must be/u);
    await expect(runStandupTool("take_note", { type: "free", text: "   " }, context())).rejects.toThrow(/text is required/u);
  });

  it("reports a note that is not there rather than failing", async () => {
    expect(await runStandupTool("retract_note", { id: "note_nope" }, context())).toContain("No note");
  });

  it("refuses to retract a note the owner already confirmed", async () => {
    const ctx = context({ confirmed: ["note_1"] });
    ctx.record.notes.push({ id: "note_1", type: "guidance", text: "Keep it", binding: "ENG-12", escalation: null, action: null, need: null, needLabel: null, createdAt: 1 });
    const out = await runStandupTool("retract_note", { id: "note_1" }, ctx);
    expect(out).toContain("already been applied");
    expect(ctx.record.notes).toHaveLength(1);
  });

  it("binds a gate note to one open need, and refuses an ambiguous one", async () => {
    const first = { id: "need_1", kind: "approve-pr", what: "Approve acme/web#7 on GitHub", url: "https://github.com/acme/web/pull/7" } as never;
    const second = { id: "need_2", kind: "approve-pr", what: "Approve acme/web#8 on GitHub", url: "https://github.com/acme/web/pull/8" } as never;
    const one = context({ needs: () => [first] });
    expect(await runStandupTool("take_note", { type: "gate", text: "Looks good", binding: "ENG-12", action: "approve" }, one)).toContain("Looks good");
    expect(one.record.notes[0]).toMatchObject({ need: "need_1", needLabel: "Approve acme/web#7 on GitHub" });
    await expect(runStandupTool("take_note", { type: "gate", text: "Looks good", binding: "ENG-12", action: "approve" }, context({ needs: () => [first, second] }))).rejects.toThrow(/several open gate items/u);
    const named = context({ needs: () => [first, second] });
    await runStandupTool("take_note", { type: "gate", text: "Looks good", binding: "ENG-12", action: "approve", need: "need_2" }, named);
    expect(named.record.notes[0]).toMatchObject({ need: "need_2" });
  });
});

const briefing = (over: Partial<Briefing> = {}): Briefing => ({
  since: 500,
  previous: null,
  notes: [],
  decisions: { needs: [{ need: { what: "Approve the spec", kind: "approve-spec", createdAt: 1 } as never, binding: binding({ entityKey: "ENG-12" }) }], withUser: [] },
  escalations: [{ escalation: escalation({ question: "A project question" }), from: binding({ entityKey: "ENG-13" }) }],
  stuck: { stuck: [{ escalation: escalation({ kind: "stuck", question: "Blocked on CI" }), from: binding({ entityKey: "ENG-14" }) }], held: [binding({ entityKey: "ENG-15", hold: "behind ENG-16", holdBehind: ["ENG-16"] })], noWakeSource: [], stall: [], datedWaits: [] },
  done: { moved: [binding({ entityKey: "ENG-17" })], ended: [binding({ entityKey: "ENG-18", endReason: "merged" })], answered: [] },
  assumptions: [{ assumption: { text: "the schema is stable" } as never, binding: binding({ entityKey: "ENG-19" }) }],
  ...over,
});

describe("the mechanical readback (BB-300 slice 4)", () => {
  const note = (over: Partial<StandupNote> = {}): StandupNote => ({ id: "note_1", type: "free", text: "Something", binding: null, escalation: null, action: null, need: null, needLabel: null, createdAt: 1, ...over });

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

describe("buildStandupInstructions (BB-300)", () => {
  it("ranks decisions first, then stuck, then done, and calls out deviations", () => {
    const text = buildStandupInstructions(briefing(), "Acme", 10_000);
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

  it("says the beginning when there is no previous stand-up", () => {
    expect(buildStandupInstructions(briefing({ since: 0 }), "Acme", 10_000)).toContain("since the beginning");
  });

  it("tells the model to greet and lead, and to close only after a readback and a clear yes", () => {
    const text = buildStandupInstructions(briefing(), "Acme", 10_000);
    expect(text).toContain("Greet the owner briefly and begin immediately");
    expect(text).toContain("nothing is waiting on the owner and nothing is stuck");
    expect(text).toContain("call readback and read every line aloud");
    expect(text).toContain("Never end without a readback");
    expect(text).toContain("merge gate item is never applied by end_standup");
  });

  it("names the scope and drops the project-wide sections for a scoped stand-up (BB-303)", () => {
    const text = buildStandupInstructions(briefing(), "Acme", 10_000, [], "ENG-12");
    expect(text).toContain("This stand-up is about ENG-12 only");
    expect(text).toContain("about ENG-12 only");
    // The project-wide sweep and playbook deviations do not belong to one binding.
    expect(text).not.toContain("## Done since");
    expect(text).not.toContain("## Approaches that departed from the written playbook");
    // The three scoped sections stay, and the decisions still read.
    expect(text).toContain("## Decisions waiting on the owner");
    expect(text).toContain("## Escalations with the project steward");
    expect(text).toContain("## Stuck or held");
    expect(text).toContain("Approve the spec");
  });

  it("dates an open question, marks it stale past the threshold and clips its context (BB-306)", () => {
    const createdAt = Date.parse("2026-11-02T00:00:00Z");
    const now = createdAt + (STANDUP_STALE_DAYS + 7) * 86_400_000; // 10 days later
    const longContext = "x".repeat(STANDUP_CONTEXT_MAX_CHARS + 50);
    const text = buildStandupInstructions(briefing(), "Acme", now, [{ key: "ENG-12", question: "Are the builds still stalling?", choices: ["Yes", "No"], createdAt, context: longContext }]);
    expect(text).toContain("Are the builds still stalling?");
    expect(text).toContain("open since 2026-11-02T00:00:00.000Z");
    expect(text).toContain("open 10 days; a claim this old may be out of date — verify before repeating it");
    // The context is rendered under its line, indented and clipped to the constant.
    expect(text).toContain(`  ${"x".repeat(STANDUP_CONTEXT_MAX_CHARS - 1)}…`);
    expect(text).not.toContain("x".repeat(STANDUP_CONTEXT_MAX_CHARS + 1));
  });

  it("leaves a hold undated because the store records no hold time (BB-306)", () => {
    const now = Date.parse("2026-11-12T00:00:00Z");
    const text = buildStandupInstructions(
      briefing({ stuck: { stuck: [], held: [binding({ entityKey: "ENG-15", hold: "behind ENG-16", holdBehind: ["ENG-16"], createdAt: 1 })], noWakeSource: [], stall: [], datedWaits: [] } }),
      "Acme",
      now,
    );
    const line = text.split("\n").find((l) => l.includes("ENG-15: on hold"));
    expect(line).toBeDefined();
    // `Binding.createdAt` is when the steward was bound, not when the hold started.
    expect(line).not.toContain("open since");
    expect(line).not.toContain("days");
  });

  it("says no digest yet, and the last digest date once there is one (BB-306)", () => {
    expect(buildStandupInstructions(briefing(), "Acme", 10_000)).toContain("has not filed a digest yet");
    const at = Date.parse("2026-11-10T00:00:00Z");
    const text = buildStandupInstructions(briefing({ previous: { text: "A digest body", at } }), "Acme", 10_000);
    expect(text).toContain("The project steward's last digest was 2026-11-10T00:00:00.000Z.");
    // The digest text itself is not injected, only its date.
    expect(text).not.toContain("A digest body");
  });

  it("stays under the instruction cap with the added age lines and still omits sections to fit (BB-306)", () => {
    const createdAt = Date.parse("2026-11-02T00:00:00Z");
    const now = createdAt + (STANDUP_STALE_DAYS + 7) * 86_400_000; // 10 days later
    const long = (label: string, i: number): string => `${label}-${i}: ${"x".repeat(180)}`;
    const needs = Array.from({ length: 35 }, (_, i) => ({ need: { what: long("need", i), kind: "approve-spec", createdAt } as never, binding: binding({ entityKey: `ENG-${i}`, createdAt }) }));
    const escalations = Array.from({ length: 35 }, (_, i) => ({ escalation: escalation({ question: long("esc", i), createdAt }), from: binding({ entityKey: `ENG-${i}`, createdAt }) }));
    const stuck = Array.from({ length: 35 }, (_, i) => ({ escalation: escalation({ kind: "stuck", question: long("stuck", i), createdAt }), from: binding({ entityKey: `ENG-${i}`, createdAt }) }));
    const moved = Array.from({ length: 35 }, (_, i) => binding({ entityKey: `ENG-${i}`, createdAt, status: { summary: long("moved", i) } as never }));
    const assumptions = Array.from({ length: 35 }, (_, i) => ({ assumption: { text: long("assume", i) } as never, binding: binding({ entityKey: `ENG-${i}`, createdAt }) }));
    const text = buildStandupInstructions(
      briefing({
        decisions: { needs, withUser: [] },
        escalations,
        stuck: { stuck, held: [], noWakeSource: [], stall: [], datedWaits: [] },
        done: { moved, ended: [], answered: [] },
        assumptions,
      }),
      "Acme",
      now,
    );
    expect(text.length).toBeLessThanOrEqual(STANDUP_MAX_INSTRUCTIONS_CHARS);
    expect(text).toContain("(omitted to fit the briefing limit)");
    // A stale age renders on the lines that survive.
    expect(text).toContain("open 10 days; a claim this old may be out of date");
  });

  it("keeps a huge briefing under the voice plugin's instruction cap, ranked", () => {
    const many = Array.from({ length: 400 }, (_, i) => binding({ entityKey: `ENG-${i}` }));
    const text = buildStandupInstructions(briefing({ done: { moved: [], ended: many, answered: [] } }), "Acme", 10_000);
    expect(text.length).toBeLessThanOrEqual(STANDUP_MAX_INSTRUCTIONS_CHARS);
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
    const text = buildStandupInstructions(
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
    expect(text.length).toBeLessThanOrEqual(STANDUP_MAX_INSTRUCTIONS_CHARS);
    // A section the loop emptied says it was omitted, not that it had nothing.
    expect(text).toContain("(omitted to fit the briefing limit)");
    expect(text).not.toMatch(/## Done since\n- \(none\)/u);
  });
});
