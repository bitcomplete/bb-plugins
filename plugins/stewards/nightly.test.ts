import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { backlogDigest, checkFindingFingerprint, createBriefing, duplicateBacklog, freshCheckFindings, localParts, nightOf, nightlyDue, stillNight, toDigestRecords } from "./nightly.js";
import { MIGRATIONS, createStore } from "./store.js";
import { formatRecords, type DigestRecords } from "./wake.js";
import type { BacklogLook } from "./ops.js";
import type { BacklogIssue } from "./source-contract.js";
import type { BacklogWrite } from "./backlog-triage.js";

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
    // BB-414: the stall is derived, so a free-text wait with no live source is what the briefing reads.
    store.patch(noWake.id, { status: { phase: "Todo", summary: "Waiting.", nextAction: "Wait", actor: "steward", waitingOn: "the vendor's reply", requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: SINCE + 5 } });
    const dated = binding("ENG-4");
    store.patch(dated.id, { requeueUntil: SINCE + 86_400_000 });
    const ended = binding("ENG-5");
    store.patch(ended.id, { endedAt: SINCE + 20, endReason: "merged" });
    // BB-406: an initiative the reconcile marked idle, and one that is not.
    const idleInit = binding("ENG-6");
    store.patch(idleInit.id, { idleInitiativeSince: SINCE - 3_600_000 });
    const notIdle = binding("ENG-7");

    const userEsc = store.escalate({ bindingId: moved.id, kind: "decision", question: "Ship it?", meanwhile: "Wait.", route: "user", recommendation: null, projectId: "p1" });
    const projectEsc = store.escalate({ bindingId: moved.id, kind: "decision", question: "Which model?", meanwhile: "Wait.", route: "project", recommendation: null, projectId: "p1" });
    const stuckEsc = store.escalate({ bindingId: held.id, kind: "stuck", question: "Stuck.", meanwhile: "Wait.", route: "project", recommendation: null, projectId: "p1" });
    const stallEsc = store.escalate({ bindingId: noWake.id, kind: "stall", question: "Stalled.", meanwhile: "Wait.", route: "project", recommendation: null, projectId: "p1" });

    const need = store.fileNeed({ bindingId: moved.id, kind: "decide", url: "review:ENG-1", what: "Review the pull request", how: null });
    const assumption = store.addAssumption({ projectId: "p1", bindingId: null, text: "The API is stable.", recordedBy: "steward" });
    const question = store.ask({ projectId: "p1", bindingId: moved.id, escalationId: null, question: "File an a11y ticket?", context: null });
    store.answer(question.id, "Yes.", "user");
    store.patchProject("p1", { digest: "Old digest.", digestAt: SINCE - 1000 });
    return { store, now, moved, held, noWake, dated, ended, idleInit, notIdle, userEsc, projectEsc, stuckEsc, stallEsc, need, assumption, question };
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
    expect(b.stuck.stalled.map((x) => x.id)).toEqual([f.noWake.id]);
    expect(b.stuck.datedWaits.map((x) => x.id)).toEqual([f.dated.id]);
    expect((b.stuck.idle ?? []).map((x) => x.id)).toEqual([f.idleInit.id]);
    expect(b.done.moved.map((x) => x.id)).toEqual([f.moved.id]);
    expect(b.done.ended.map((x) => x.id)).toEqual([f.ended.id]);
    expect(b.done.answered.map((x) => x.id)).toEqual([f.question.id]);
    expect(b.assumptions.map((x) => x.assumption.id)).toEqual([f.assumption.id]);
  });

  it("narrows to one binding and drops the sweep when scoped (BB-303)", () => {
    const f = fixture();
    const scoped = createBriefing(f.store, f.now)("p1", SINCE, f.moved.id);
    // Only the scoped binding's decisions, escalations and hold/stuck state.
    expect(scoped.decisions.needs.map((x) => x.need.id)).toEqual([f.need.id, f.userEsc.id]);
    expect(scoped.decisions.withUser.map((x) => x.escalation.id)).toEqual([f.userEsc.id]);
    expect(scoped.escalations.map((x) => x.escalation.id)).toEqual([f.projectEsc.id]);
    expect(scoped.stuck.stuck).toEqual([]);
    expect(scoped.stuck.held).toEqual([]);
    expect(scoped.stuck.stalled).toEqual([]);
    expect(scoped.stuck.datedWaits).toEqual([]);
    expect(scoped.decisions.needs.every((x) => x.binding.id === f.moved.id)).toBe(true);
    // The "since the last stand-up" sweep and the other bindings are not in it.
    expect(scoped.done).toEqual({ moved: [], ended: [], answered: [] });
    expect(scoped.assumptions).toEqual([]);
    // Without a binding the project-wide briefing is exactly as before.
    const full = createBriefing(f.store, f.now)("p1", SINCE);
    expect(full.done.moved.map((x) => x.id)).toEqual([f.moved.id]);
    expect(full.stuck.held.map((x) => x.id)).toEqual([f.held.id]);
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
      stalled: [f.store.binding(f.noWake.id)!],
      stall: [{ escalation: f.store.escalation(f.stallEsc.id)!, from: f.store.binding(f.noWake.id)! }],
      datedWaits: [f.store.binding(f.dated.id)!],
      held: [f.store.binding(f.held.id)!],
      idle: [f.store.binding(f.idleInit.id)!],
      nonActions: [],
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

// BB-328: the nightly pass runs the live half of `check` and records findings
// deduplicated by fingerprint: an unchanged finding is said once, and again
// only when it changes (or clears and returns).
describe("check findings deduplicated by fingerprint (BB-328)", () => {
  const problem = (text: string) => ({ level: "problem" as const, text });
  const warning = (text: string) => ({ level: "warning" as const, text });

  it("says an unchanged finding once, and a changed one again", () => {
    const first = freshCheckFindings([problem("ENG is not visible"), warning("ops-watch lag")], []);
    expect(first.fresh.map((f) => f.text)).toEqual(["ENG is not visible", "ops-watch lag"]);
    expect(first.next.every((f) => f.fingerprint === checkFindingFingerprint(f))).toBe(true);

    // The same two findings again: nothing fresh, the recorded set unchanged.
    const second = freshCheckFindings([problem("ENG is not visible"), warning("ops-watch lag")], first.next);
    expect(second.fresh).toEqual([]);
    expect(second.next.map((f) => f.fingerprint).sort()).toEqual(first.next.map((f) => f.fingerprint).sort());

    // One changed: only that one is fresh.
    const third = freshCheckFindings([problem("ENG has no state Todo"), warning("ops-watch lag")], first.next);
    expect(third.fresh.map((f) => f.text)).toEqual(["ENG has no state Todo"]);
  });

  it("says a finding again after it clears and returns", () => {
    const first = freshCheckFindings([problem("ENG is not visible")], []);
    const cleared = freshCheckFindings([], first.next);
    expect(cleared.fresh).toEqual([]);
    expect(cleared.next).toEqual([]);
    const returned = freshCheckFindings([problem("ENG is not visible")], cleared.next);
    expect(returned.fresh.map((f) => f.text)).toEqual(["ENG is not visible"]);
  });

  it("collapses duplicate findings within one pass", () => {
    const pass = freshCheckFindings([problem("same"), problem("same")], []);
    expect(pass.fresh).toHaveLength(1);
    expect(pass.next).toHaveLength(1);
  });

  it("records the current set in the store and reads it back", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.exec(sql);
    let clock = 1_000_000;
    const store = createStore(db, () => clock);
    const now = () => clock;
    expect(store.checkFindings("p1")).toEqual([]);
    const { next } = freshCheckFindings([problem("ENG is not visible")], []);
    store.setCheckFindings("p1", next, now());
    expect(store.checkFindings("p1")).toEqual([{ ...next[0]!, firstSeenAt: now() }]);
    // Re-recording an unchanged finding keeps its first-seen time.
    store.setCheckFindings("p1", next, now() + 1000);
    expect(store.checkFindings("p1")[0]!.firstSeenAt).toBe(now());
    // A finding that is gone is dropped, and one that returns is fresh again.
    store.setCheckFindings("p1", [], now() + 2000);
    expect(store.checkFindings("p1")).toEqual([]);
    expect(freshCheckFindings([problem("ENG is not visible")], store.checkFindings("p1")).fresh).toHaveLength(1);
  });
});

// BB-334: the backlog report is pure — the stored look plus the previous
// digest's snapshot in, the digest's metrics and lines out.
describe("the backlog report (BB-334)", () => {
  const NOW = at("2026-10-14T15:00:00Z");
  const issue = (over: Partial<BacklogIssue> = {}): BacklogIssue => ({
    id: "i1",
    key: "BB-1",
    title: "Fix login",
    state: "Backlog",
    stateType: "backlog",
    unit: "BB",
    labels: [],
    assignees: [],
    priority: null,
    estimate: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...over,
  });
  const look = (issues: BacklogIssue[], over: Partial<BacklogLook> = {}): BacklogLook => ({ at: NOW, target: "backlog/BB", team: "BB", error: null, issues, unsupported: false, truncated: false, ...over });
  const emptyRecords = (backlog: DigestRecords["backlog"]): DigestRecords => ({ previous: null, since: NOW, moved: [], ended: [], answered: [], withUser: [], stuck: [], stalled: [], stall: [], held: [], backlog });

  it("counts size, age buckets and inflow/outflow against the previous digest's snapshot", () => {
    const issues = [
      issue({ id: "a", key: "BB-1", createdAt: "2026-10-13T00:00:00Z" }),
      issue({ id: "b", key: "BB-2", createdAt: "2026-10-01T00:00:00Z" }),
      issue({ id: "c", key: "BB-3", createdAt: "2026-08-01T00:00:00Z" }),
      issue({ id: "d", key: "BB-4", createdAt: "2026-01-01T00:00:00Z" }),
    ];
    const report = backlogDigest(look(issues), { at: NOW - 86_400_000, ids: ["a", "gone"] }, { staleDays: 14 }, NOW);
    expect(report.size).toBe(4);
    expect(report.ages).toEqual([
      { label: "<1w", count: 1 },
      { label: "1-4w", count: 1 },
      { label: "1-3m", count: 1 },
      { label: ">3m", count: 1 },
    ]);
    expect(report.inflow).toBe(3);
    expect(report.outflow).toBe(1);
    expect(report.since).toBe(NOW - 86_400_000);
  });

  it("reports the first digest with no inflow or outflow", () => {
    expect(backlogDigest(look([issue()]), null, { staleDays: 14 }, NOW)).toMatchObject({ since: null, inflow: 0, outflow: 0 });
  });

  it("flags likely duplicates by normalised title, and never merges them", () => {
    const groups = duplicateBacklog([issue({ id: "a", key: "BB-1", title: "Fix the login page" }), issue({ id: "b", key: "BB-2", title: "Fix login page!" }), issue({ id: "c", key: "BB-3", title: "Add SSO" })]);
    expect(groups).toEqual([{ keys: ["BB-1", "BB-2"], title: "Fix the login page" }]);
  });

  it("lists stale tickets oldest first and proposes the next three with reasoning", () => {
    const issues = [
      issue({ id: "a", key: "BB-1", priority: "Low", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }),
      issue({ id: "b", key: "BB-2", priority: "Urgent", createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z", estimate: 3 }),
      issue({ id: "c", key: "BB-3", priority: "High", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }),
      issue({ id: "d", key: "BB-4", priority: "Medium", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" }),
    ];
    const report = backlogDigest(look(issues), null, { staleDays: 14 }, NOW);
    expect(report.stale).toEqual([
      { key: "BB-4", days: 74 },
      { key: "BB-3", days: 43 },
      { key: "BB-2", days: 15 },
    ]);
    expect(report.next.map((n) => n.key)).toEqual(["BB-2", "BB-3", "BB-4"]);
    expect(report.next[0]!.reason).toBe("Urgent, 4d old, estimate 3");
  });

  it("ranks Linear's priority label ignoring case and leaves a started ticket out of the proposal", () => {
    const issues = [
      issue({ id: "a", key: "BB-1", priority: "Medium", createdAt: "2026-01-01T00:00:00Z" }),
      issue({ id: "b", key: "BB-2", priority: "Urgent", createdAt: "2026-10-13T00:00:00Z", stateType: "started" }),
      issue({ id: "c", key: "BB-3", priority: "No priority", createdAt: "2026-09-01T00:00:00Z" }),
    ];
    const report = backlogDigest(look(issues), null, { staleDays: 14 }, NOW);
    // The started ticket is proposed never, and the medium outranks the unranked one.
    expect(report.next.map((n) => n.key)).toEqual(["BB-1", "BB-3"]);
    expect(report.next[0]!.reason).toMatch(/^Medium, /u);
    // It still counts in size and ages.
    expect(report.size).toBe(3);
    expect(report.ages.reduce((n, a) => n + a.count, 0)).toBe(3);
  });

  it("renders the section beside the record, and omits it when no role carries a backlog", () => {
    const report = backlogDigest(look([issue({ title: "Fix login" })]), null, { staleDays: 14 }, NOW);
    const withBacklog = formatRecords(emptyRecords([report]), []).join("\n");
    expect(withBacklog).toContain("### Backlog");
    expect(withBacklog).toContain("- BB: 1 open; age <1w 0, 1-4w 1, 1-3m 0, >3m 0; first digest");
    expect(withBacklog).toContain("- Proposed next: BB-1 (no priority, 13d old)");
    expect(formatRecords(emptyRecords([]), []).join("\n")).not.toContain("### Backlog");
    expect(formatRecords(emptyRecords(undefined), []).join("\n")).not.toContain("### Backlog");
  });

  it("lists each promotion and collapses repeated refusals by their unchanged reason (BB-385)", () => {
    const writes: BacklogWrite[] = [
      { id: "w1", projectId: "p1", team: "BB", issueId: "uuid-1", issueKey: "BB-1", at: NOW, outcome: "accepted", kind: "promote", detail: {}, reason: null },
      { id: "w2", projectId: "p1", team: "BB", issueId: "", issueKey: "", at: NOW, outcome: "refused", kind: "promote", detail: {}, reason: "WIP full" },
      { id: "w3", projectId: "p1", team: "BB", issueId: "", issueKey: "", at: NOW, outcome: "refused", kind: "promote", detail: {}, reason: "WIP full" },
      { id: "w4", projectId: "p1", team: "BB", issueId: "", issueKey: "", at: NOW, outcome: "refused", kind: "promote", detail: {}, reason: "no eligible candidate" },
      { id: "w5", projectId: "p1", team: "BB", issueId: "uuid-2", issueKey: "BB-2", at: NOW, outcome: "accepted", kind: "promote", detail: {}, reason: null },
      // A triage write is still one Writes line, and is not a promotion.
      { id: "w6", projectId: "p1", team: "BB", issueId: "uuid-3", issueKey: "BB-3", at: NOW, outcome: "accepted", kind: "label", detail: {}, reason: null },
    ];
    const report = backlogDigest(look([issue({ title: "Fix login" })]), null, { staleDays: 14, writes }, NOW);
    expect(report.promotions.map((p) => p.issueKey)).toEqual(["BB-1", "BB-2"]);
    expect(report.writes.map((w) => `${w.issueKey} ${w.kind}`)).toEqual(["BB-3 label"]);
    expect(report.refusals).toBe(3);
    expect(report.refusalReasons).toEqual([
      { reason: "WIP full", count: 2 },
      { reason: "no eligible candidate", count: 1 },
    ]);
    const text = formatRecords(emptyRecords([report]), []).join("\n");
    expect(text).toContain("  - Writes: BB-3 label");
    expect(text).toContain("  - Promoted: BB-1");
    expect(text).toContain("  - Promoted: BB-2");
    expect(text).toContain("  - Refused: WIP full (2); no eligible candidate (1)");
  });

  it("shows a failed read as one problem line, never an empty backlog", () => {
    const failed = backlogDigest(look([], { error: "Linear rate limited the read" }), null, { staleDays: 14 }, NOW);
    const text = formatRecords(emptyRecords([failed]), []).join("\n");
    expect(text).toContain("### Backlog");
    expect(text).toContain("- BB: unavailable — Linear rate limited the read");
    expect(text).not.toContain("0 open");
  });
});
