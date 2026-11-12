// BB-300 slice 3: the stand-up's instruction builder, its fixed tool set, and
// the note record. Nothing here touches OpenAI or the network: the tool
// readers are injected, so the whole surface is unit-tested.
import { describe, expect, it, vi } from "vitest";
import {
  STANDUP_CONTEXT_MAX_CHARS,
  STANDUP_ENTITY_DESCRIPTION_MAX_CHARS,
  STANDUP_MAX_INSTRUCTIONS_CHARS,
  STANDUP_NOTE_TYPES,
  STANDUP_STALE_DAYS,
  STANDUP_TOOL_NAMES,
  STANDUP_TOOLS,
  STANDUP_WRITE_TOOLS,
  buildStandupBrief,
  buildStandupInstructions,
  readbackLine,
  readbackLines,
  runStandupTool,
  stripMarkdown,
  type StandupNote,
  type StandupRecord,
  type StandupToolContext,
} from "./standup.js";
import type { Briefing } from "./nightly.js";
import type { Binding, Escalation, Lesson } from "./store.js";
import type { GuidanceUnit } from "./guidance.js";
import { comment, issue, pull } from "./fixtures.js";

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
    deployments: {},
    endedAt: null,
    endReason: null,
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
  const record: StandupRecord = { projectId: "p1", startedAt: 1, notes: [], connected: false, delegations: [] };
  return {
    projectId: "p1",
    now: () => 1_000,
    binding: (key) => (key === "ENG-12" ? binding() : null),
    openEscalations: () => [escalation()],
    escalation: (id) => (id === "esc_1" ? escalation() : null),
    lessons: () => [lesson()],
    guidance: async () => [unit()],
    entity: async (key) => ({ entity: issue({ key }), pulls: [] }),
    inScope: () => true,
    searchIssues: async () => [],
    needs: () => [],
    confirmed: [],
    endStandup: async (ids) => ({ output: `end ${ids.join(",")}`, applied: ids, skipped: [] }),
    record,
    ...over,
  };
}

describe("the stand-up tool set (BB-300)", () => {
  it("declares the fixed, small tool set (BB-313)", () => {
    expect(STANDUP_TOOL_NAMES).toEqual(["lookup", "search_tickets", "playbook_paragraph", "readback", "take_note", "retract_note", "end_standup"]);
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

  it("offers every typed note shape plus a free note (BB-313)", () => {
    expect(STANDUP_NOTE_TYPES).toEqual(["resolve-escalation", "gate", "guidance", "direction", "standing-rule", "follow-up", "free"]);
  });
});

describe("runStandupTool (BB-300)", () => {
  it("reads the whole record for a stewarded key in one lookup (BB-313)", async () => {
    const ctx = context();
    const out = (await runStandupTool("lookup", { key: "ENG-12" }, ctx)) as string;
    expect(out).toContain("Fix login");
    expect(out).toContain("State: Todo");
    expect(out).toContain("Steward: ENG-12 — ticket, phase build");
    expect(out).toContain("In review");
    expect(out).toContain("Waiting on: the review");
    expect(out).toContain("Merge or close?");
    expect(out).toContain("Choices: Merge / Close");
    expect(out).toContain("Meanwhile: Waiting.");
    expect(out).toContain("recommends: Merge it.");
    expect(out).toContain("Prefer the smaller change.");
    expect(ctx.record.notes).toHaveLength(0);
  });

  it("renders each pull request's verdict, checks, merge commit and deploy state (BB-313)", async () => {
    const linked = pull(
      {
        id: "acme/web#7",
        key: "acme/web#7",
        url: "https://github.com/acme/web/pull/7",
        title: "Add login retry",
        state: "open",
        author: "sam",
        description: "Retries login.",
        comments: [comment({ id: "m1", author: "trotterdylan", body: "<!-- bb-review round=1 sha=aaaaaaa1 verdict=approved lane=owner-reviewed approver=owner -->", createdAt: "2026-10-03T00:00:00Z" })],
      },
      { checks: { state: "success", failing: [] }, mergeCommit: "abcdef1" },
    );
    const ticketEntity = issue({ linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }] });
    const b = binding({ lastSnapshot: { entity: ticketEntity, pulls: [linked] }, deployments: { d1: { state: "deployed" } } as never });
    const ctx = context({ entity: async () => ({ entity: ticketEntity, pulls: [linked] }), binding: (key) => (key === "ENG-12" || key === "acme/web#7" || key === "https://github.com/acme/web/pull/7" ? b : null) });
    // The ticket lists the linked pull with the title and state the binding holds.
    const ticket = (await runStandupTool("lookup", { key: "ENG-12" }, ctx)) as string;
    expect(ticket).toContain("Linked pull requests: acme/web#7 Add login retry (open)");
    expect(ticket).toContain("Pull request acme/web#7: Add login retry — open");
    expect(ticket).toContain("Review: approved, lane owner-reviewed, approver owner");
    expect(ticket).toContain("Checks: success");
    expect(ticket).toContain("Merge commit: abcdef1");
    expect(ticket).toContain("Deploy: 1/1 confirmed");
    // A pull key that resolves to the ticket renders the pull, not the ticket.
    const pr = (await runStandupTool("lookup", { key: "acme/web#7" }, ctx)) as string;
    expect(pr).toContain("acme/web#7: Add login retry");
    expect(pr).not.toContain("No steward");
    // A pull URL resolves the same way.
    const byUrl = (await runStandupTool("lookup", { key: "https://github.com/acme/web/pull/7" }, ctx)) as string;
    expect(byUrl).toContain("acme/web#7: Add login retry");
  });

  it("shows the last comments, linked pull requests and children from the snapshot (BB-306)", async () => {
    const ctx = context({
      entity: async (key) => ({
        entity: issue({
          key,
          comments: [
            comment({ id: "c1", author: "Sam", did: "commented", body: "Can we also cover SSO?", createdAt: "2026-10-02T00:00:00Z" }),
            comment({ id: "c2", author: "Jane", did: "approved", body: "Looks good to me.", createdAt: "2026-10-03T00:00:00Z" }),
          ],
          linkedPulls: [{ url: "https://github.com/acme/web/pull/7", key: "acme/web#7" }],
          children: [{ id: "acme/web#13", key: "acme/web#13", title: "Sub-task", state: "open", stateType: null, labels: [] }],
        }),
        pulls: [],
      }),
    });
    const out = (await runStandupTool("lookup", { key: "ENG-12" }, ctx)) as string;
    expect(out).toContain("2026-10-02T00:00:00Z Sam commented: Can we also cover SSO?");
    expect(out).toContain("2026-10-03T00:00:00Z Jane approved: Looks good to me.");
    expect(out).toContain("Linked pull requests: acme/web#7");
    expect(out).toContain("Children: acme/web#13 Sub-task (open)");
  });

  it("clips a long pull body without flattening it (BB-309)", async () => {
    const long = pull({ id: "acme/web#8", key: "acme/web#8", url: "https://github.com/acme/web/pull/8", description: `first line\n\n${"y".repeat(STANDUP_ENTITY_DESCRIPTION_MAX_CHARS + 50)}` });
    const b = binding({ lastSnapshot: { entity: issue(), pulls: [long] } });
    const ctx = context({ binding: (key) => (key === "acme/web#8" ? b : null) });
    const out = (await runStandupTool("lookup", { key: "acme/web#8" }, ctx)) as string;
    expect(out).toContain("first line");
    // The body keeps its line breaks and is clipped at the cap.
    expect(out).toContain("first line\n\ny");
    expect(out).not.toContain("y".repeat(STANDUP_ENTITY_DESCRIPTION_MAX_CHARS + 1));
    expect(out).toContain("…");
  });

  it("clips a ticket body to the spoken-answer budget (BB-313)", async () => {
    const long = "z".repeat(STANDUP_ENTITY_DESCRIPTION_MAX_CHARS + 50);
    const entity = issue({ description: long });
    const b = binding({ lastSnapshot: { entity, pulls: [] } });
    const ctx = context({ entity: async () => ({ entity, pulls: [] }), binding: (key) => (key === "ENG-12" ? b : null) });
    const out = (await runStandupTool("lookup", { key: "ENG-12" }, ctx)) as string;
    expect(out).not.toContain(long);
    expect(out).toContain("…");
  });

  it("renders a pull request's own verdict, checks, merge and deploy when it is the entity (BB-313)", async () => {
    const linked = pull(
      { key: "acme/web#7", url: "https://github.com/acme/web/pull/7", title: "Add login retry", comments: [comment({ id: "m1", author: "trotterdylan", body: "<!-- bb-review round=1 sha=aaaaaaa1 verdict=approved lane=owner-reviewed approver=owner -->" })] },
      { checks: { state: "failure", failing: ["test"] }, mergeCommit: "abcdef1" },
    );
    // A PR steward's own PR: the binding's key is the entity.
    const b = binding({ kind: "pr", entityKey: "acme/web#7", lastSnapshot: { entity: linked, pulls: [] }, deployments: { d1: { state: "deployed" } } as never });
    const ctx = context({ binding: (key) => (key === "acme/web#7" ? b : null), entity: async () => ({ entity: linked, pulls: [] }) });
    const out = (await runStandupTool("lookup", { key: "acme/web#7" }, ctx)) as string;
    expect(out).toContain("Review: approved, lane owner-reviewed, approver owner");
    expect(out).toContain("Checks: failure (failing: test)");
    expect(out).toContain("Merge commit: abcdef1");
    expect(out).toContain("Deploy: 1/1 confirmed");
    // A stewardless PR key answers the same way, with no deploy state.
    const noSteward = context({ binding: () => null, entity: async () => ({ entity: linked, pulls: [] }) });
    const out2 = (await runStandupTool("lookup", { key: "acme/web#7" }, noSteward)) as string;
    expect(out2).toContain("Review: approved");
    expect(out2).toContain("Checks: failure (failing: test)");
    expect(out2).toContain("Merge commit: abcdef1");
  });

  it("rejects the removed tool names as unknown (BB-313)", async () => {
    for (const name of ["steward_status", "escalation", "decision_rationale", "entity_snapshot", "ask_a_thread"]) {
      await expect(runStandupTool(name, {}, context())).rejects.toThrow(/No stand-up tool/u);
    }
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
      { id: "note_1", type: "guidance", text: "Keep it small", binding: "ENG-12", escalation: null, action: null, need: null, needLabel: null, thread: null, threadError: null, threadPending: false, createdAt: 1 },
      { id: "note_2", type: "free", text: "A thought", binding: null, escalation: null, action: null, need: null, needLabel: null, thread: null, threadError: null, threadPending: false, createdAt: 2 },
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
    ctx.record.notes.push({ id: "note_1", type: "guidance", text: "Keep it", binding: "ENG-12", escalation: null, action: null, need: null, needLabel: null, thread: null, threadError: null, threadPending: false, createdAt: 1 });
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

  it("matches a gate need by the pull request key the brief shows (BB-309)", async () => {
    const need = { id: "need_1", kind: "approve-pr", what: "Approve acme/web#7 on GitHub", url: "https://github.com/acme/web/pull/7" } as never;
    const byKey = context({ needs: () => [need] });
    await runStandupTool("take_note", { type: "gate", text: "Looks good", binding: "ENG-12", action: "approve", need: "acme/web#7" }, byKey);
    expect(byKey.record.notes[0]).toMatchObject({ need: "need_1", needLabel: "Approve acme/web#7 on GitHub" });
    const byUrl = context({ needs: () => [need] });
    await runStandupTool("take_note", { type: "gate", text: "Looks good", binding: "ENG-12", action: "approve", need: "https://github.com/acme/web/pull/7" }, byUrl);
    expect(byUrl.record.notes[0]).toMatchObject({ need: "need_1" });
    const noMatch = context({ needs: () => [need] });
    await expect(runStandupTool("take_note", { type: "gate", text: "Looks good", binding: "ENG-12", action: "approve", need: "acme/web#9" }, noMatch)).rejects.toThrow(/matches/u);
  });

  it("records the resolved binding key for a gate note taken by pull key (BB-309)", async () => {
    const need = { id: "need_1", kind: "approve-pr", what: "Approve acme/web#7 on GitHub", url: "https://github.com/acme/web/pull/7" } as never;
    const ctx = context({ binding: (key) => (key === "ENG-12" || key === "acme/web#7" ? binding() : null), needs: () => [need] });
    await runStandupTool("take_note", { type: "gate", text: "Looks good", binding: "acme/web#7", action: "approve" }, ctx);
    // The confirmation path's `store.find` needs the binding's own key, not the pull key.
    expect(ctx.record.notes[0]).toMatchObject({ binding: "ENG-12", need: "need_1" });
  });

  it("uses a pull-key binding to pick the exact gate item, and keeps a ticket key ambiguous (BB-309)", async () => {
    const approve7 = { id: "need_7", kind: "approve-pr", what: "Approve acme/web#7 on GitHub", url: "https://github.com/acme/web/pull/7" } as never;
    const merge8 = { id: "need_8", kind: "merge", what: "Merge acme/web#8 on GitHub", url: "https://github.com/acme/web/pull/8" } as never;
    const resolve = (key: string) => (key === "ENG-12" || key === "acme/web#7" || key === "acme/web#8" ? binding() : null);
    // The pull key names #8, which has no approve item: refuse, never bind #7.
    await expect(runStandupTool("take_note", { type: "gate", text: "Looks good", binding: "acme/web#8", action: "approve" }, context({ binding: resolve, needs: () => [approve7, merge8] }))).rejects.toThrow(/matches/u);
    // The pull key with the matching action binds that pull's item, not the first of the kind.
    const mergeCtx = context({ binding: resolve, needs: () => [approve7, merge8] });
    await runStandupTool("take_note", { type: "gate", text: "Ship it", binding: "acme/web#8", action: "merge" }, mergeCtx);
    expect(mergeCtx.record.notes[0]).toMatchObject({ binding: "ENG-12", need: "need_8" });
    // A ticket key with two items of the action's kind is still ambiguous.
    const approve7b = { id: "need_7b", kind: "approve-pr", what: "Approve acme/web#7b on GitHub", url: "https://github.com/acme/web/pull/7b" } as never;
    await expect(runStandupTool("take_note", { type: "gate", text: "Looks good", binding: "ENG-12", action: "approve" }, context({ needs: () => [approve7, approve7b] }))).rejects.toThrow(/several open gate items/u);
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
  const note = (over: Partial<StandupNote> = {}): StandupNote => ({ id: "note_1", type: "free", text: "Something", binding: null, escalation: null, action: null, need: null, needLabel: null, thread: null, threadError: null, threadPending: false, createdAt: 1, ...over });

  it("renders one line per typed shape from the stored note, not the model", () => {
    expect(readbackLine(note({ type: "resolve-escalation", escalation: "esc_1", text: "Merge it" }))).toBe("Resolve escalation esc_1 with: Merge it");
    expect(readbackLine(note({ type: "gate", binding: "ENG-12", action: "approve", text: "Looks good" }))).toBe("Approve ENG-12: Looks good");
    expect(readbackLine(note({ type: "gate", binding: "ENG-12", action: "decline", text: "Not yet" }))).toBe("Decline ENG-12: Not yet");
    expect(readbackLine(note({ type: "gate", binding: "ENG-12", action: "merge", text: "Ship it" }))).toBe("Merge ENG-12: Ship it");
    expect(readbackLine(note({ type: "guidance", binding: "ENG-12", text: "Keep it small" }))).toBe("Guidance for ENG-12: Keep it small");
    expect(readbackLine(note({ type: "direction", text: "Prioritise the migration" }))).toBe("Project direction: Prioritise the migration");
    expect(readbackLine(note({ type: "standing-rule", text: "Never merge red checks" }))).toBe("Standing rule: Never merge red checks");
    expect(readbackLine(note({ type: "follow-up", text: "Check the cache eviction" }))).toBe("Follow up in a thread: Check the cache eviction");
    expect(readbackLine(note({ type: "follow-up", binding: "ENG-12", text: "Check the cache eviction" }))).toBe("Follow up in a thread: Check the cache eviction (about ENG-12)");
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
    // BB-313: the stale-claim line points at lookup, and the follow-up note is offered.
    expect(text).toContain("verify it with lookup");
    expect(text).toContain("take a follow-up note");
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

  it("tells the model a brief acknowledgement is not an interruption and to resume after a real one (BB-308)", () => {
    const text = buildStandupInstructions(briefing(), "Acme", 10_000);
    expect(text).toContain("\"okay\", \"yes\", \"nice\", \"mm-hmm\"");
    expect(text).toContain("is not an interruption and needs no reply");
    expect(text).toContain("resume from where the reply was cut off and never start the briefing over");
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

  it("carries a gate item's pull title, steward summary and review verdict (BB-309)", () => {
    const need = { what: "Approve acme/web#7 on GitHub", kind: "approve-pr", createdAt: 1, url: "https://github.com/acme/web/pull/7" } as never;
    const linked = pull({ comments: [comment({ id: "m1", author: "trotterdylan", body: "<!-- bb-review round=1 sha=aaaaaaa1 verdict=approved lane=owner-reviewed approver=owner -->", signedBy: "thr_reviewer", createdAt: "2026-10-14T16:00:00Z" })] });
    const b = binding({ entityKey: "ENG-12", status: { actor: "steward", nextAction: "review", summary: "In review, waiting on the owner", waitingOn: "the approval", at: 1 } as never, lastSnapshot: { entity: issue(), pulls: [linked] } });
    const text = buildStandupInstructions(briefing({ decisions: { needs: [{ need, binding: b }], withUser: [] } }), "Acme", 10_000);
    expect(text).toContain("Add login retry");
    expect(text).toContain("In review, waiting on the owner");
    expect(text).toContain("review approved, lane owner-reviewed, approver owner");
  });

  it("clips a long steward summary in a gate item's line (BB-309)", () => {
    const need = { what: "Approve acme/web#7 on GitHub", kind: "approve-pr", createdAt: 1, url: "https://github.com/acme/web/pull/7" } as never;
    const longSummary = `In review ${"x".repeat(STANDUP_CONTEXT_MAX_CHARS + 50)}`;
    const b = binding({ entityKey: "ENG-12", status: { summary: longSummary, actor: "steward", nextAction: "review", waitingOn: "the approval", at: 1 } as never, lastSnapshot: { entity: issue(), pulls: [pull()] } });
    const text = buildStandupInstructions(briefing({ decisions: { needs: [{ need, binding: b }], withUser: [] } }), "Acme", 10_000);
    expect(text).not.toContain("x".repeat(STANDUP_CONTEXT_MAX_CHARS + 1));
  });

  it("tells the model a gate note's binding is the ticket key and need is the pull request (BB-309)", () => {
    const text = buildStandupInstructions(briefing(), "Acme", 10_000);
    expect(text).toContain("the binding is the ticket key before the colon on the brief line");
    expect(text).toContain("need is the pull request named on it");
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

describe("stripMarkdown (BB-309)", () => {
  it("keeps the words and drops headings, bullets, emphasis and code", () => {
    expect(stripMarkdown("**Bold** and `code`.")).toBe("Bold and code.");
    expect(stripMarkdown("keep snake_case and 2 * 3 * 4")).toBe("keep snake_case and 2 * 3 * 4");
    expect(stripMarkdown("# Heading\n## Two")).toBe("Heading\nTwo");
    expect(stripMarkdown("- one\n- two")).toBe("one\ntwo");
    expect(stripMarkdown("1. one\n2. two")).toBe("one\ntwo");
    expect(stripMarkdown("```\nblock\n```")).toBe("\nblock\n");
    expect(stripMarkdown("plain text")).toBe("plain text");
  });
});

// ---- BB-312: the steward-tiered brief and the entity read tools ------------

const NOW = Date.parse("2026-11-12T12:00:00Z");
const DAY = 86_400_000;

/** A briefing whose only agenda item is a need on `agenda`, with no other sections populated. */
const tierBriefing = (agenda: Binding, over: Partial<Briefing> = {}): Briefing =>
  briefing({
    decisions: { needs: [{ need: { id: "need_1", what: "Approve the spec", kind: "approve-spec", createdAt: NOW - 1_000, url: "spec", how: null } as never, binding: agenda }], withUser: [] },
    escalations: [],
    stuck: { stuck: [], held: [], noWakeSource: [], stall: [], datedWaits: [] },
    done: { moved: [], ended: [], answered: [] },
    assumptions: [],
    ...over,
  });

describe("buildStandupBrief (BB-312)", () => {
  it("ranks the tiers: agenda, then other open stewards, then recently closed", () => {
    const agenda = binding({ id: "b-agenda", entityKey: "ENG-1", title: "Agenda" });
    const open = binding({ id: "b-open", entityKey: "ENG-2", title: "Open" });
    const closed = binding({ id: "b-closed", entityKey: "ENG-3", title: "Closed", endedAt: NOW - 1_000, endReason: "merged" });
    const text = buildStandupBrief(tierBriefing(agenda), [agenda, open, closed], new Map(), "Acme", NOW, [], { closedLimit: 10, closedDays: 3, lastCompletedAt: null });
    const agendaAt = text.indexOf("## Needs your input");
    const openAt = text.indexOf("## Other open stewards");
    const closedAt = text.indexOf("## Recently closed");
    expect(agendaAt).toBeGreaterThan(-1);
    expect(agendaAt).toBeLessThan(openAt);
    expect(openAt).toBeLessThan(closedAt);
    expect(text.slice(agendaAt, openAt)).toContain("ENG-1");
    expect(text.slice(openAt, closedAt)).toContain("ENG-2");
    expect(text.slice(closedAt)).toContain("ENG-3");
    // The agenda binding is not repeated in the open tier.
    expect(text.slice(openAt, closedAt)).not.toContain("ENG-1");
  });

  it("leaves out an ended binding older than the clamp", () => {
    const agenda = binding({ id: "b-agenda", entityKey: "ENG-1" });
    const old = binding({ id: "b-old", entityKey: "ENG-9", endedAt: NOW - 10 * DAY, endReason: "merged" });
    const text = buildStandupBrief(tierBriefing(agenda), [agenda, old], new Map(), "Acme", NOW, [], { closedLimit: 10, closedDays: 3, lastCompletedAt: null });
    expect(text).not.toContain("ENG-9");
  });

  it("lists at most the closed limit, newest first", () => {
    const agenda = binding({ id: "b-agenda", entityKey: "ENG-0" });
    const ended = Array.from({ length: 11 }, (_, i) => binding({ id: `b-${i}`, entityKey: `ENG-${i + 1}`, endedAt: NOW - (i + 1) * 1_000, endReason: "merged" }));
    const text = buildStandupBrief(tierBriefing(agenda), [agenda, ...ended], new Map(), "Acme", NOW, [], { closedLimit: 10, closedDays: 3, lastCompletedAt: null });
    expect(text).toContain("ENG-1");
    expect(text).not.toContain("ENG-11");
  });

  it("clamps to the later of the window and the last completed stand-up", () => {
    const agenda = binding({ id: "b-agenda", entityKey: "ENG-0" });
    const before = binding({ id: "b-before", entityKey: "ENG-8", endedAt: NOW - 2 * DAY, endReason: "merged" });
    const after = binding({ id: "b-after", entityKey: "ENG-7", endedAt: NOW - 30 * 60_000, endReason: "merged" });
    // A stand-up completed an hour ago clamps to that, so the two-day-old end is out.
    const text = buildStandupBrief(tierBriefing(agenda), [agenda, before, after], new Map(), "Acme", NOW, [], { closedLimit: 10, closedDays: 3, lastCompletedAt: NOW - 60 * 60_000 });
    expect(text).not.toContain("ENG-8");
    expect(text).toContain("ENG-7");
  });

  it("carries stuck, stall, held, no-wake-source and dated-wait flags on the open line, with no separate section", () => {
    const stuck = binding({ id: "b-stuck", entityKey: "ENG-10", title: "Stuck" });
    const stalled = binding({ id: "b-stall", entityKey: "ENG-11", title: "Stalled" });
    const held = binding({ id: "b-held", entityKey: "ENG-12", title: "Held", hold: "behind ENG-1", holdBehind: ["ENG-1"] });
    const noWake = binding({ id: "b-nowake", entityKey: "ENG-13", title: "No wake", noWakeSource: true });
    const dated = binding({ id: "b-dated", entityKey: "ENG-14", title: "Dated", requeueUntil: NOW + DAY });
    const brief = tierBriefing(binding({ id: "b-agenda", entityKey: "ENG-1" }), {
      stuck: {
        stuck: [{ escalation: escalation({ kind: "stuck", question: "Blocked" }), from: stuck }],
        stall: [{ escalation: escalation({ kind: "stall", question: "Stalled" }), from: stalled }],
        held: [held],
        noWakeSource: [noWake],
        datedWaits: [dated],
      },
    });
    const text = buildStandupBrief(brief, [stuck, stalled, held, noWake, dated], new Map(), "Acme", NOW, [], { closedLimit: 10, closedDays: 3, lastCompletedAt: null });
    const item = (key: string) => text.split("\n- ").find((block) => block.startsWith(key));
    expect(item("ENG-10")).toContain("stuck");
    expect(item("ENG-11")).toContain("stalled");
    expect(item("ENG-12")).toContain("held");
    expect(item("ENG-13")).toContain("no wake source");
    expect(item("ENG-14")).toContain("waiting until");
    expect(text).not.toContain("## Stuck or held");
  });

  it("drops the closed tier before the open tier and the open tier before the agenda", () => {
    const agenda = binding({ id: "b-agenda", entityKey: "ENG-0", title: "Agenda" });
    const open = Array.from({ length: 40 }, (_, i) => binding({ id: `o-${i}`, entityKey: `OP-${i}`, title: "Open", status: { summary: "x".repeat(180) } as never }));
    const closed = Array.from({ length: 40 }, (_, i) => binding({ id: `c-${i}`, entityKey: `CL-${i}`, title: "Closed", endedAt: NOW - i * 1_000, endReason: "merged" }));
    const brief = tierBriefing(agenda);
    const text = buildStandupBrief(brief, [agenda, ...open, ...closed], new Map(), "Acme", NOW, [], { closedLimit: 40, closedDays: 3, lastCompletedAt: null });
    expect(text.length).toBeLessThanOrEqual(STANDUP_MAX_INSTRUCTIONS_CHARS);
    // The agenda survives, some open survive, and the closed tier is gone first.
    expect(text).toContain("ENG-0");
    expect(text).toContain("OP-0");
    expect(text).not.toContain("## Recently closed\n- (none)");
  });
});

describe("the entity read tools (BB-312)", () => {
  it("renders a stewardless key through the entity reader", async () => {
    const ctx = context({ binding: () => null, entity: async (key) => ({ entity: issue({ key, title: "Stewardless" }), pulls: [] }) });
    const out = (await runStandupTool("lookup", { key: "ENG-99" }, ctx)) as string;
    expect(out).toContain("Stewardless");
    expect(out).toContain("ENG-99");
  });

  it("refuses a key outside the project's teams and repos", async () => {
    const ctx = context({ inScope: () => false });
    expect(await runStandupTool("lookup", { key: "OTHER-1" }, ctx)).toContain("not in this project");
    expect(await runStandupTool("search_tickets", { query: "anything" }, ctx)).toContain("No ticket");
  });

  it("searches through the injected reader and drops an out-of-scope result", async () => {
    const searchIssues = vi.fn(async () => [
      { id: "a", key: "ENG-1", title: "In scope", description: null, state: "Todo", stateType: null, unit: "ENG", assignee: "Jane" },
      { id: "b", key: "OTHER-2", title: "Out of scope", description: null, state: "Todo", stateType: null, unit: "OTHER", assignee: null },
    ]);
    const ctx = context({ searchIssues, inScope: (key) => key.startsWith("ENG-") });
    const out = (await runStandupTool("search_tickets", { query: "login", limit: 5 }, ctx)) as string;
    expect(searchIssues).toHaveBeenCalledWith("login", 5);
    expect(out).toContain("ENG-1");
    expect(out).not.toContain("OTHER-2");
  });
});

describe("the enriched agenda items (BB-312)", () => {
  it("carries the binding's description, status and newest pull on an escalation item", () => {
    const from = binding({ id: "b-esc", entityKey: "ENG-5", title: "Escalated", status: { summary: "In review", waitingOn: "the approval" } as never });
    const brief = briefing({
      decisions: { needs: [], withUser: [{ escalation: escalation({ question: "Ship it?" }), from }] },
      escalations: [],
      stuck: { stuck: [], held: [], noWakeSource: [], stall: [], datedWaits: [] },
      done: { moved: [], ended: [], answered: [] },
      assumptions: [],
    });
    const linked = pull({ key: "acme/web#9", title: "Ship the fix", state: "open", comments: [comment({ body: "<!-- bb-review round=1 sha=aaaaaaa1 verdict=approved lane=owner-reviewed -->" })] });
    const facts = new Map([[from.id, { entity: issue({ description: "The bug is real." }), pulls: [linked] }]]);
    const text = buildStandupBrief(brief, [from], facts, "Acme", NOW, [], { closedLimit: 10, closedDays: 3, lastCompletedAt: null });
    expect(text).toContain("Ship it?");
    expect(text).toContain("The bug is real.");
    expect(text).toContain("Ship the fix");
    expect(text).toContain("In review");
  });

  it("renders a queued project note as a flag on the steward it names, as a whole token", () => {
    const target = binding({ id: "b-note", entityKey: "BB-312" });
    const other = binding({ id: "b-other", entityKey: "BB-31" });
    const brief = briefing({
      notes: ["The owner asked about BB-312"],
      decisions: { needs: [], withUser: [] },
      escalations: [],
      stuck: { stuck: [], held: [], noWakeSource: [], stall: [], datedWaits: [] },
      done: { moved: [], ended: [], answered: [] },
      assumptions: [],
    });
    const text = buildStandupBrief(brief, [target, other], new Map(), "Acme", NOW, [], { closedLimit: 10, closedDays: 3, lastCompletedAt: null });
    const item = (key: string) => text.split("\n- ").find((block) => block.startsWith(`${key}:`));
    expect(item("BB-312")).toContain("project note:");
    // The key is a whole token: a note about BB-312 does not land on BB-31.
    expect(item("BB-31")).not.toContain("project note:");
  });
});
