// BB-335 (BB-291 criterion 3): the non-action reasons. The pure table and its
// merge, the store's read-free conditional write on the assessment row, the
// binding read that carries the reasons to the card, `bb stewards show` and the
// digest, and one branch-driven assertion per reason code: each test drives the
// test world into the branch that declines and asserts the reason was written.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { NON_ACTION_CODES, mergeNonAction, nonActionDay, nonActionText, sortedNonActions, type NonActionCode, type NonActions } from "./non-actions.js";
import { MIGRATIONS, createStore, type Binding } from "./store.js";
import { PROJECT_FILE } from "./config.js";
import { comment, issue, pull } from "./fixtures.js";
import { setup } from "./test-world.js";
import { formatRecords, type DigestRecords } from "./wake.js";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const NEXT_DAY = Date.parse("2026-11-15T00:00:01Z");

function makeStore(now = NOW) {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const s = createStore(db, () => now);
  const b = s.create({
    projectId: "p1",
    source: "linear",
    entityId: "uuid-12",
    entityKey: "ENG-12",
    url: null,
    title: "ENG-12",
    kind: "ticket",
    playbook: "linear-tickets",
    playbookVersion: "v1",
    parentBindingId: null,
    phase: "In Progress",
    stage: "build",
  });
  return { db, s, b };
}

describe("the non-action reason table (BB-335)", () => {
  it("has one short text per code, rendered with the day", () => {
    for (const code of NON_ACTION_CODES) {
      const text = nonActionText(code, null, NOW);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("undefined");
    }
    // The two named cases carry the date, and the binding-ended one carries the
    // end reason too.
    expect(nonActionText("binding-ended-closed", "terminal", NOW)).toBe("Closed because the binding ended (terminal)");
    expect(nonActionText("needs-decline-closed", null, NOW)).toContain("declined");
  });

  it("records a reason for every code, so each branch has a write path", () => {
    for (const code of NON_ACTION_CODES) {
      const merged = mergeNonAction({}, code, null, NOW);
      expect(merged[code]).toEqual({ date: "2026-11-14", text: nonActionText(code, null, NOW) });
    }
  });

  it("keeps the latest reason per code, and writes nothing when the day and text are unchanged", () => {
    const first = mergeNonAction({}, "gate-not-met", "acme/web#7", NOW);
    // The same code on the same day is the same object: the store's merge
    // writes nothing.
    expect(mergeNonAction(first, "gate-not-met", "acme/web#7", NOW)).toBe(first);
    // A new day rolls the date.
    const rolled = mergeNonAction(first, "gate-not-met", "acme/web#7", NEXT_DAY);
    expect(rolled).not.toBe(first);
    expect(rolled["gate-not-met"]!.date).toBe("2026-11-15");
    // A different detail changes the text and so the entry.
    const changed = mergeNonAction(rolled, "gate-not-met", "acme/web#8", NEXT_DAY);
    expect(changed["gate-not-met"]!.text).toContain("acme/web#8");
  });

  it("sorts the reasons newest day first", () => {
    const list: NonActions = {
      "gate-not-met": { date: "2026-11-13", text: "a" },
      "worker-running": { date: "2026-11-14", text: "b" },
      "merge-held": { date: "2026-11-14", text: "c" },
    };
    expect(sortedNonActions(list).map((n) => n.code)).toEqual(["merge-held", "worker-running", "gate-not-met"]);
  });
});

describe("the store's non-action write (BB-335)", () => {
  it("merges a reason into the assessment row and carries it on the binding read", () => {
    const { s, b } = makeStore();
    s.recordNonAction(b.id, "gate-not-met", "acme/web#7", NOW);
    const read = s.binding(b.id)!;
    expect(read.nonActions["gate-not-met"]).toEqual({ date: "2026-11-14", text: nonActionText("gate-not-met", "acme/web#7", NOW) });
    // The card, `bb stewards show` and the digest all read the binding, so the
    // joined value is the one surface.
    expect(s.assessment(b.id)!.nonActions["gate-not-met"]!.date).toBe("2026-11-14");
  });

  it("writes nothing when the same reason is recorded again on the same day", () => {
    const { db, s, b } = makeStore();
    s.recordNonAction(b.id, "gate-not-met", null, NOW);
    const before = db.prepare("SELECT non_actions FROM assessments WHERE binding_id = ?").get(b.id) as { non_actions: string };
    s.recordNonAction(b.id, "gate-not-met", null, NOW);
    const after = db.prepare("SELECT non_actions FROM assessments WHERE binding_id = ?").get(b.id) as { non_actions: string };
    expect(after.non_actions).toBe(before.non_actions);
    // A new day rolls the date.
    s.recordNonAction(b.id, "gate-not-met", null, NEXT_DAY);
    expect(s.binding(b.id)!.nonActions["gate-not-met"]!.date).toBe("2026-11-15");
  });

  it("merges the non-actions a reconcile passes to recordAssessment", () => {
    const { s, b } = makeStore();
    s.recordAssessment({ bindingId: b.id, at: NOW, gate: {}, worker: {}, liveness: {}, nonActions: [{ code: "worker-running" }, { code: "merge-held", detail: "acme/web#7" }] });
    const read = s.binding(b.id)!;
    expect(Object.keys(read.nonActions).sort()).toEqual(["merge-held", "worker-running"]);
    // The assessment's own values are written too, and the non-actions survive
    // a later plain recordAssessment (which does not touch the column).
    expect(s.assessment(b.id)!.gate).toEqual({});
    s.recordAssessment({ bindingId: b.id, at: NOW, gate: { a: 1 }, worker: {}, liveness: {} });
    expect(s.assessment(b.id)!.gate).toEqual({ a: 1 });
    expect(Object.keys(s.binding(b.id)!.nonActions).sort()).toEqual(["merge-held", "worker-running"]);
  });
});

describe("a legacy store without the non-actions column (BB-335)", () => {
  it("opens and reads bindings unchanged, with no non-actions", () => {
    const db = new Database(":memory:");
    // The base schema plus the assessment table, but not the non-action
    // migration: the join must fall back to the plain binding select.
    for (const sql of MIGRATIONS) {
      if (sql.includes("ADD COLUMN non_actions")) continue;
      db.exec(sql);
    }
    const s = createStore(db, () => NOW);
    const b = s.create({ projectId: "p1", source: "linear", entityId: "uuid-12", entityKey: "ENG-12", url: null, title: "ENG-12", kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "In Progress", stage: "build" });
    expect(s.binding(b.id)!.nonActions).toEqual({});
  });
});

// ---- one branch-driven assertion per reason code -----------------------------

type World = Awaited<ReturnType<typeof setup>>;
const TICKET = { projectId: "p1", source: "linear" as const, entityId: "uuid-12", entityKey: "ENG-12", url: null, title: "ENG-12", kind: "ticket" as const, playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "Todo", stage: "spec" as const };
const HEAD = "aaaaaaa1";

const marker = (head = HEAD) => comment({ id: "r8", author: "jane", did: "reviewed", body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=no-review -->`, createdAt: "2026-10-14T16:00:00Z" });

const create = (t: World, over: Record<string, unknown> = {}) => t.hooks.store.create({ ...TICKET, ...over } as never);

/** A ticket binding with one linked, gate-met own pull request (the BB-279 shape). */
async function gateMetTicket(t: World, pullOver: Record<string, unknown> = {}, bindingOver: Record<string, unknown> = {}): Promise<Binding> {
  t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started", linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }] }));
  t.entities.set("acme/web#7", pull({ id: "acme/web#7", key: "acme/web#7", url: "https://github.com/acme/web/pull/7", author: "sam", comments: [marker()] }, { head: "bb/eng-12-retry", checks: { state: "success", failing: [] }, ...pullOver }));
  return create(t, { phase: "In Progress", stage: "build", ...bindingOver });
}

const written = (t: World, b: Binding, code: NonActionCode) => expect(t.hooks.store.binding(b.id)!.nonActions[code]).toBeDefined();

describe("the declining branches record their reason (BB-335)", () => {
  it("config-unreadable: the project configuration could not be read", async () => {
    const t = await setup();
    t.files[PROJECT_FILE] = null;
    t.hooks.forgetConfigs();
    t.entities.set("uuid-12", issue());
    const b = create(t);
    await t.hooks.reconcilePass("p1");
    await t.flush();
    written(t, b, "config-unreadable");
  });

  it("project-disabled: the project is switched off", async () => {
    const t = await setup();
    await t.hooks.setProjectEnabled("p1", false);
    t.entities.set("uuid-12", issue());
    const b = create(t);
    await t.hooks.reconcilePass("p1");
    await t.flush();
    written(t, b, "project-disabled");
  });

  it("no-playbook: no playbook applies", async () => {
    const t = await setup();
    // An ops binding with no ops playbook in the config takes the null-playbook
    // return rather than the ops handoff.
    const b = create(t, { source: "ops", entityId: "k8s-namespace:acme", entityKey: "ops:acme", kind: "ops" });
    await t.hooks.reconcilePass("p1");
    await t.flush();
    written(t, b, "no-playbook");
  });

  it("entity-unreadable: the entity read failed", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    t.setSnapshotError("uuid-12", true);
    const b = create(t);
    await t.hooks.reconcilePass("p1");
    await t.flush();
    written(t, b, "entity-unreadable");
  });

  it("entity-gone: the entity is gone and the binding already ended", async () => {
    const t = await setup();
    const b = create(t);
    t.hooks.store.patch(b.id, { endedAt: 1, endReason: "gone" });
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "entity-gone");
  });

  it("stay-ended: an ended binding stays ended", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue({ labels: [] }));
    const b = create(t);
    t.hooks.store.patch(b.id, { endedAt: 1, endReason: "detach" });
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "stay-ended");
  });

  it("other-binding-open: another project holds the entity open", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    const b = create(t);
    t.hooks.store.patch(b.id, { endedAt: 1, endReason: "detach" });
    create(t, { projectId: "p2" });
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "other-binding-open");
  });

  it("ending-in-progress: the binding is ending", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    const b = create(t);
    t.hooks.store.patch(b.id, { ending: "detach", endingAt: 1 });
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "ending-in-progress");
  });

  it("follow-through-ran-out: the follow-through turn ran out", async () => {
    const t = await setup();
    t.threads.set("thr_steward", { status: "idle", archivedAt: null });
    t.entities.set("uuid-12", issue({ state: "Done", stateType: "completed" }));
    const b = create(t, { threadId: "thr_steward", phase: "Done", stage: "build" });
    t.hooks.store.patch(b.id, { ending: "terminal", endingAt: 1, followThrough: "wrap up", followThroughUntil: 1 });
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "follow-through-ran-out");
  });

  it("nothing-to-do: nothing actionable changed", async () => {
    const t = await setup();
    t.threads.set("thr_steward", { status: "idle", archivedAt: null });
    t.entities.set("uuid-12", issue());
    const b = create(t);
    t.hooks.store.patch(b.id, { threadId: "thr_steward" });
    await t.hooks.reconcilePass("p1");
    await t.flush();
    written(t, b, "nothing-to-do");
  });

  it("deferred: stewards are paused", async () => {
    const t = await setup();
    t.threads.set("thr_steward", { status: "idle", archivedAt: null });
    t.entities.set("uuid-12", issue());
    const b = create(t);
    t.hooks.store.patch(b.id, { threadId: "thr_steward" });
    (t.hooks.settings as unknown as { experimental_set(v: Record<string, unknown>): Promise<unknown> }).experimental_set({ paused: true });
    t.hooks.store.note(b.id, "something new", false);
    await t.hooks.reconcilePass("p1");
    await t.flush();
    written(t, b, "deferred");
  });

  it("worker-busy: the steward's thread is busy", async () => {
    const t = await setup();
    t.threads.set("thr_steward", { status: "active", archivedAt: null });
    t.entities.set("uuid-12", issue());
    const b = create(t);
    t.hooks.store.patch(b.id, { threadId: "thr_steward" });
    t.hooks.store.note(b.id, "something new", false);
    await t.hooks.reconcilePass("p1");
    await t.flush();
    written(t, b, "worker-busy");
  });

  it("pull-foreign-owner: a linked pull request belongs to another ticket", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started", linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }] }));
    t.entities.set("acme/web#7", pull({ id: "acme/web#7", key: "acme/web#7", url: "https://github.com/acme/web/pull/7", author: "sam" }, { head: "bb/other-work" }));
    const b = create(t, { phase: "In Progress", stage: "build" });
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "pull-foreign-owner");
  });

  it("pull-closed: an own pull request is closed", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started", linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }] }));
    t.entities.set("acme/web#7", pull({ id: "acme/web#7", key: "acme/web#7", url: "https://github.com/acme/web/pull/7", author: "sam", state: "closed" }, { head: "bb/eng-12-retry", merged: false }));
    const b = create(t, { phase: "In Progress", stage: "build" });
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "pull-closed");
  });

  it("merge-held: the pull request is stacked on an open base", async () => {
    const t = await setup();
    const b = await gateMetTicket(t);
    t.entities.set("acme/web#8", pull({ id: "acme/web#8", key: "acme/web#8", url: "https://github.com/acme/web/pull/8", title: "Base" }, { head: "bb/bb-256-parent", base: "main" }));
    t.entities.set("acme/web#7", pull({ id: "acme/web#7", key: "acme/web#7", url: "https://github.com/acme/web/pull/7", author: "sam", comments: [marker()] }, { base: "bb/bb-256-parent", head: "bb/eng-12-retry", checks: { state: "success", failing: [] } }));
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "merge-held");
  });

  it("retarget-needed: the pull request's base merged", async () => {
    const t = await setup();
    const b = await gateMetTicket(t);
    t.entities.set("acme/web#8", pull({ id: "acme/web#8", key: "acme/web#8", url: "https://github.com/acme/web/pull/8", title: "Base", state: "merged" }, { merged: true, mergeCommit: "b".repeat(40), head: "bb/bb-256-parent", base: "main" }));
    t.entities.set("acme/web#7", pull({ id: "acme/web#7", key: "acme/web#7", url: "https://github.com/acme/web/pull/7", author: "sam", comments: [marker()] }, { base: "bb/bb-256-parent", head: "bb/eng-12-retry", checks: { state: "success", failing: [] } }));
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "retarget-needed");
  });

  it("merge-steward-filed: a steward-filed Merge item is open", async () => {
    const t = await setup();
    const b = await gateMetTicket(t);
    t.hooks.store.fileNeed({ bindingId: b.id, kind: "merge", url: "https://github.com/acme/web/pull/7", what: "Merge acme/web#7", how: null, filedBy: "steward" });
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "merge-steward-filed");
  });

  it("worker-running: a worker's turn is in progress", async () => {
    const t = await setup();
    const b = await gateMetTicket(t);
    t.hooks.store.addWorker("thr_w1", b.id, "ENG-12: implement");
    t.hooks.store.setWorker("thr_w1", "running", null);
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "worker-running");
  });

  it("merge-paused: stewards are paused", async () => {
    const t = await setup();
    const b = await gateMetTicket(t);
    (t.hooks.settings as unknown as { experimental_set(v: Record<string, unknown>): Promise<unknown> }).experimental_set({ paused: true });
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "merge-paused");
  });

  it("parked-owns-another: a parked worker owns another open pull request", async () => {
    const t = await setup();
    const b = await gateMetTicket(t);
    t.hooks.store.addWorker("thr_w1", b.id, "ENG-12: implement");
    t.hooks.store.setWorker("thr_w1", "finished", "Watching acme/web#7 and acme/web#8.");
    t.hooks.store.parkWorker("thr_w1", "the review");
    t.entities.set("acme/web#8", pull({ id: "acme/web#8", key: "acme/web#8", url: "https://github.com/acme/web/pull/8", title: "Second", author: "sam" }, { head: "bb/eng-12-retry", checks: { state: "pending", failing: [] } }));
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started", linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }, { key: "acme/web#8", url: "https://github.com/acme/web/pull/8" }] }));
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "parked-owns-another");
  });

  it("base-not-default: the pull request is not based on the default branch", async () => {
    const t = await setup();
    const b = await gateMetTicket(t, { base: "release" });
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "base-not-default");
  });

  it("merge-refused: GitHub refused the merge", async () => {
    const t = await setup();
    const b = await gateMetTicket(t);
    t.setMergePullError("GitHub refused the merge: pull request is not mergeable");
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "merge-refused");
  });

  it("head-moved: the head moved between the look and the merge", async () => {
    const t = await setup();
    const b = await gateMetTicket(t);
    t.setMoveHeadOnMerge(true);
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "head-moved");
  });

  it("gate-not-met: the merge gate is not met", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started", linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }] }));
    t.entities.set("acme/web#7", pull({ id: "acme/web#7", key: "acme/web#7", url: "https://github.com/acme/web/pull/7", author: "sam" }, { head: "bb/eng-12-retry", checks: { state: "pending", failing: [] } }));
    const b = create(t, { phase: "In Progress", stage: "build" });
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "gate-not-met");
  });

  it("binding-ended-closed: an ending closes an open item", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue({ state: "Done", stateType: "completed" }));
    const b = create(t);
    t.hooks.store.escalate({ bindingId: b.id, kind: "decision", question: "Is this still wanted?", meanwhile: "waiting", route: "user", recommendation: null });
    await t.ring("linear", "uuid-12");
    await t.flush();
    const read = t.hooks.store.binding(b.id)!;
    expect(read.endedAt).not.toBeNull();
    written(t, b, "binding-ended-closed");
    expect(read.nonActions["binding-ended-closed"]!.text).toContain("Closed because the binding ended");
    expect(read.nonActions["binding-ended-closed"]!.text).toContain(String(read.endReason));
  });

  it("needs-decline-closed: the spec was declined", async () => {
    const t = await setup();
    const entity = issue({ state: "Todo", stateType: "unstarted" });
    t.entities.set("uuid-12", entity);
    const b = create(t);
    t.hooks.store.decline(b.id, t.hooks.specHashFor(b, entity), "Declined by the user on the stewards page", "user");
    await t.ring("linear", "uuid-12");
    await t.flush();
    written(t, b, "needs-decline-closed");
  });

  it("wait-slack-unsent: an Ask on Slack that sent nothing", async () => {
    const t = await setup();
    const b = create(t);
    const need = t.hooks.store.fileNeed({
      bindingId: b.id,
      kind: "decide",
      url: "acme/web#9",
      what: "The review wait is overdue.",
      how: "Choose.",
      data: { waitBudget: true, choices: ["Review it yourself", "Reassign", "Keep waiting", "Ask on Slack"], waitKind: "review", waitRef: "acme/web#9", waitSlackCandidates: ["arashout"] },
      filedBy: "plugin",
    });
    const out = await t.harness.behavior.runCli(["wait-slack-refused", need.id, "--candidates", "arashout"]);
    expect(out.exitCode).toBe(0);
    written(t, b, "wait-slack-unsent");
  });

  it("covers every code in the closed table", () => {
    // The table and the branch tests cannot drift: every code has a test above,
    // and no test names a code the table does not have.
    const tested: NonActionCode[] = [
      "config-unreadable", "project-disabled", "no-playbook", "entity-unreadable", "entity-gone", "stay-ended", "other-binding-open",
      "ending-in-progress", "follow-through-ran-out", "nothing-to-do", "deferred", "worker-busy", "pull-foreign-owner", "pull-closed",
      "merge-held", "retarget-needed", "merge-steward-filed", "worker-running", "merge-paused", "parked-owns-another", "base-not-default",
      "merge-refused", "head-moved", "gate-not-met", "binding-ended-closed", "needs-decline-closed", "wait-slack-unsent",
    ];
    expect([...tested].sort()).toEqual([...NON_ACTION_CODES].sort());
  });
});

// ---- the render surfaces -----------------------------------------------------

describe("the non-action render surfaces (BB-335)", () => {
  it("prints the reason in bb stewards show", async () => {
    const t = await setup();
    const b = await gateMetTicket(t, { base: "release" });
    await t.ring("linear", "uuid-12");
    await t.flush();
    const out = (await t.harness.behavior.runCli(["show", "ENG-12"])).stdout;
    expect(out).toMatch(/Non-action 2026-10-\d\d: The pull request acme\/web#7 is based on a branch that is not the default/);
  });

  it("renders the digest's Non-actions section", () => {
    const records: DigestRecords = {
      previous: null,
      since: NOW - 1000,
      moved: [],
      ended: [],
      answered: [],
      withUser: [],
      stuck: [],
      noWakeSource: [],
      stall: [],
      held: [],
      nonActions: [{ binding: { entityKey: "ENG-12", kind: "ticket", phase: "Done" } as never, nonActions: { "binding-ended-closed": { date: "2026-11-14", text: "Closed because the binding ended (terminal)" } } }],
    };
    const text = formatRecords(records, []).join("\n");
    expect(text).toContain("### Non-actions");
    expect(text).toContain("ENG-12 (ticket, Done): Closed because the binding ended (terminal) (2026-11-14)");
  });

  it("does not render the digest section when there are no non-actions", () => {
    const records: DigestRecords = { previous: null, since: NOW, moved: [], ended: [], answered: [], withUser: [], stuck: [], noWakeSource: [], stall: [], held: [] };
    expect(formatRecords(records, []).join("\n")).not.toContain("### Non-actions");
  });
});
