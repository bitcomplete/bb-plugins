import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createBriefing, localParts, nightOf, nightlyDue, stillNight, toDigestRecords } from "./nightly.js";
import { MIGRATIONS, createStore } from "./store.js";
import { formatRecords, type DigestRecords } from "./wake.js";

const NY = { at: "01:00", until: "02:45", timezone: "America/New_York" };
// 2026-10-14 05:30Z is 01:30 in New York (EDT, UTC-4).
const at = (isoz: string) => Date.parse(isoz);

describe("the nightly window", () => {
  it("reads local time in the project's zone", () => {
    expect(localParts(at("2026-10-14T05:30:00Z"), NY.timezone)).toEqual({ date: "2026-10-14", minutes: 90 });
  });

  it("is due once per night, inside the window only", () => {
    expect(nightlyDue(at("2026-10-14T04:59:00Z"), NY, null)).toBeNull();
    expect(nightlyDue(at("2026-10-14T05:30:00Z"), NY, null)).toBe("2026-10-14");
    expect(nightlyDue(at("2026-10-14T05:30:00Z"), NY, "2026-10-14")).toBeNull();
    expect(nightlyDue(at("2026-10-14T06:50:00Z"), NY, null)).toBeNull();
    expect(stillNight(at("2026-10-14T06:40:00Z"), NY, "2026-10-14")).toBe(true);
    expect(stillNight(at("2026-10-14T06:46:00Z"), NY, "2026-10-14")).toBe(false);
  });

  it("names a window across midnight by the evening it started", () => {
    const late = { at: "23:00", until: "02:00", timezone: "UTC" };
    expect(nightOf(at("2026-10-14T23:30:00Z"), late)).toBe("2026-10-14");
    expect(nightOf(at("2026-10-15T01:30:00Z"), late)).toBe("2026-10-14");
    expect(nightOf(at("2026-10-15T12:00:00Z"), late)).toBeNull();
  });
});

// BB-300: the nightly digest generalised into briefing(project, since). The
// nightly pass is its first caller; a stand-up calls it on demand with "since
// the last stand-up".
describe("briefing", () => {
  const SINCE = 10_000_000;

  function world() {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.exec(sql);
    let clock = SINCE;
    const store = createStore(db, () => clock);
    const binding = (key: string) =>
      store.create({ projectId: "p1", source: "linear", entityId: key, entityKey: key, url: null, title: key, kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "Todo", stage: "spec" });
    return { store, binding, now: () => clock };
  }

  /** One of every kind the four sections carry, all since `SINCE`. */
  function fixture() {
    const { store, binding, now } = world();
    const moved = binding("ENG-1");
    store.patch(moved.id, { status: { phase: "Todo", summary: "Moved.", nextAction: "Go", actor: "steward", waitingOn: null, requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: SINCE + 10 }, advancedAt: SINCE + 10 });
    const held = binding("ENG-2");
    store.patch(held.id, { hold: "Waiting on ENG-1" });
    const noWake = binding("ENG-3");
    store.patch(noWake.id, { noWakeSource: true });
    const dated = binding("ENG-4");
    store.patch(dated.id, { requeueUntil: SINCE + 86_400_000 });
    const ended = binding("ENG-5");
    store.patch(ended.id, { endedAt: SINCE + 20, endReason: "merged" });

    const userEsc = store.escalate({ bindingId: moved.id, kind: "decision", question: "Ship it?", meanwhile: "Wait.", route: "user", recommendation: null, projectId: "p1" });
    const projectEsc = store.escalate({ bindingId: moved.id, kind: "decision", question: "Which model?", meanwhile: "Wait.", route: "project", recommendation: null, projectId: "p1" });
    const stuckEsc = store.escalate({ bindingId: held.id, kind: "stuck", question: "Stuck.", meanwhile: "Wait.", route: "project", recommendation: null, projectId: "p1" });
    const stallEsc = store.escalate({ bindingId: noWake.id, kind: "stall", question: "Stalled.", meanwhile: "Wait.", route: "project", recommendation: null, projectId: "p1" });

    const need = store.fileNeed({ bindingId: moved.id, kind: "decide", url: "review:ENG-1", what: "Review the pull request", how: null });
    const assumption = store.addAssumption({ projectId: "p1", bindingId: null, text: "The API is stable.", recordedBy: "steward" });
    const question = store.ask({ projectId: "p1", bindingId: moved.id, escalationId: null, question: "File an a11y ticket?", context: null });
    store.answer(question.id, "Yes.", "user");
    store.patchProject("p1", { digest: "Old digest.", digestAt: SINCE - 1000 });
    return { store, now, moved, held, noWake, dated, ended, userEsc, projectEsc, stuckEsc, stallEsc, need, assumption, question };
  }

  it("reads the four sections the stand-up ranks, since the given moment", () => {
    const f = fixture();
    const b = createBriefing(f.store, f.now)("p1", SINCE);
    expect(b.since).toBe(SINCE);
    expect(b.previous).toEqual({ text: "Old digest.", at: SINCE - 1000 });
    expect(b.decisions.needs.map((x) => x.need.id)).toEqual([f.need.id, f.userEsc.id]);
    expect(b.decisions.withUser.map((x) => x.escalation.id)).toEqual([f.userEsc.id]);
    expect(b.escalations.map((x) => x.escalation.id)).toEqual([f.projectEsc.id, f.stuckEsc.id, f.stallEsc.id]);
    expect(b.stuck.stuck.map((x) => x.escalation.id)).toEqual([f.stuckEsc.id]);
    expect(b.stuck.stall.map((x) => x.escalation.id)).toEqual([f.stallEsc.id]);
    expect(b.stuck.held.map((x) => x.id)).toEqual([f.held.id]);
    expect(b.stuck.noWakeSource.map((x) => x.id)).toEqual([f.noWake.id]);
    expect(b.stuck.datedWaits.map((x) => x.id)).toEqual([f.dated.id]);
    expect(b.done.moved.map((x) => x.id)).toEqual([f.moved.id]);
    expect(b.done.ended.map((x) => x.id)).toEqual([f.ended.id]);
    expect(b.done.answered.map((x) => x.id)).toEqual([f.question.id]);
    expect(b.assumptions.map((x) => x.assumption.id)).toEqual([f.assumption.id]);
  });

  it("flattens to the digest record the nightly rendered before, so its output is unchanged", () => {
    const f = fixture();
    const records = toDigestRecords(createBriefing(f.store, f.now)("p1", SINCE));
    expect(records).toEqual<DigestRecords>({
      previous: { text: "Old digest.", at: SINCE - 1000 },
      since: SINCE,
      notes: [],
      moved: [f.store.binding(f.moved.id)!],
      ended: [f.store.binding(f.ended.id)!],
      answered: [f.store.question(f.question.id)!],
      withUser: [{ escalation: f.store.escalation(f.userEsc.id)!, from: f.store.binding(f.moved.id)! }],
      needs: [{ need: f.store.need(f.need.id)!, binding: f.store.binding(f.moved.id)! }, { need: f.store.need(f.userEsc.id)!, binding: f.store.binding(f.moved.id)! }],
      assumptions: [{ assumption: f.store.assumption(f.assumption.id)!, binding: null }],
      stuck: [{ escalation: f.store.escalation(f.stuckEsc.id)!, from: f.store.binding(f.held.id)! }],
      noWakeSource: [f.store.binding(f.noWake.id)!],
      stall: [{ escalation: f.store.escalation(f.stallEsc.id)!, from: f.store.binding(f.noWake.id)! }],
      datedWaits: [f.store.binding(f.dated.id)!],
      held: [f.store.binding(f.held.id)!],
    });
    // `formatRecords` is untouched, so rendering the extracted record is the
    // nightly's byte-identical digest record.
    expect(formatRecords(records, []).join("\n")).toContain("## The record since");
  });

  it("keeps 'since the last stand-up' per project with no migration", () => {
    const { store } = world();
    expect(store.lastStandup("p1")).toBeNull();
    store.setLastStandup("p1", 111);
    store.setLastStandup("p2", 222);
    expect(store.lastStandup("p1")).toBe(111);
    expect(store.lastStandup("p2")).toBe(222);
    store.setLastStandup("p1", 333);
    expect(store.lastStandup("p1")).toBe(333);
  });
});
