// BB-335 (BB-291 criterion 3): the non-action reasons. The pure table and its
// merge, the store's read-free conditional write on the assessment row, and
// the binding read that carries the reasons to the card, `bb stewards show` and
// the digest. The last describe drives the two named branches (the
// binding-ended close and the spec-decline close) through a reconcile, so a
// code in the table is not just declared but written when its branch is taken.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { NON_ACTION_CODES, mergeNonAction, nonActionDay, nonActionText, sortedNonActions, type NonActionCode, type NonActions } from "./non-actions.js";
import { MIGRATIONS, createStore } from "./store.js";

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
    expect(nonActionText("binding-ended-closed", "terminal", NOW)).toBe("Closed because the binding ended (terminal, 2026-11-14)");
    expect(nonActionText("needs-decline-closed", null, NOW)).toContain("2026-11-14");
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

describe("the two named non-action branches (BB-335)", () => {
  it("records binding-ended-closed when an ending closes an open item", async () => {
    const { setup } = await import("./test-world.js");
    const { issue } = await import("./fixtures.js");
    const t = await setup();
    // A binding whose entity reached a terminal state and whose steward thread
    // is gone, so `beginEnding` resolves its open item and calls
    // `finishEnding` with no wake.
    t.entities.set("uuid-12", issue({ state: "Done", stateType: "completed" }));
    const b = t.hooks.store.create({ projectId: "p1", source: "linear", entityId: "uuid-12", entityKey: "ENG-12", url: null, title: "ENG-12", kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "In Progress", stage: "build" });
    t.hooks.store.escalate({ bindingId: b.id, kind: "decision", question: "Is this still wanted?", meanwhile: "waiting", route: "user", recommendation: null });
    await t.ring("linear", "uuid-12");
    await t.flush();
    const read = t.hooks.store.binding(b.id)!;
    expect(read.endedAt).not.toBeNull();
    expect(read.nonActions["binding-ended-closed"]).toBeDefined();
    expect(read.nonActions["binding-ended-closed"]!.text).toContain("Closed because the binding ended");
    expect(read.nonActions["binding-ended-closed"]!.text).toContain(String(read.endReason));
  });

  it("records needs-decline-closed when the spec was declined", async () => {
    const { setup } = await import("./test-world.js");
    const { issue } = await import("./fixtures.js");
    const t = await setup();
    const entity = issue({ state: "Todo", stateType: "unstarted" });
    t.entities.set("uuid-12", entity);
    const b = t.hooks.store.create({ projectId: "p1", source: "linear", entityId: "uuid-12", entityKey: "ENG-12", url: null, title: "ENG-12", kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "Todo", stage: "spec" });
    // The user declined this exact spec: `wantsSpec` is false and the approval
    // item is withdrawn, recording the decline-close.
    const hash = t.hooks.specHashFor(b, entity);
    t.hooks.store.decline(b.id, hash, "Declined by the user on the stewards page", "user");
    await t.ring("linear", "uuid-12");
    await t.flush();
    expect(t.hooks.store.binding(b.id)!.nonActions["needs-decline-closed"]).toBeDefined();
  });

  it("records gate-not-met for an open own pull request whose gate is not met", async () => {
    const { setup } = await import("./test-world.js");
    const { issue, pull } = await import("./fixtures.js");
    const t = await setup();
    t.entities.set("uuid-12", issue({ id: "uuid-12", key: "ENG-12", state: "In Progress", stateType: "started", linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }] }));
    t.entities.set("acme/web#7", pull({ id: "acme/web#7", key: "acme/web#7", url: "https://github.com/acme/web/pull/7", state: "open" }, { head: "bb/eng-12-retry", checks: { state: "pending", failing: [] } }));
    const b = t.hooks.store.create({ projectId: "p1", source: "linear", entityId: "uuid-12", entityKey: "ENG-12", url: null, title: "ENG-12", kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "In Progress", stage: "build" });
    await t.ring("linear", "uuid-12");
    await t.flush();
    expect(t.hooks.store.binding(b.id)!.nonActions["gate-not-met"]).toBeDefined();
  });

  it("records pull-closed when an own pull request is closed", async () => {
    const { setup } = await import("./test-world.js");
    const { issue, pull } = await import("./fixtures.js");
    const t = await setup();
    t.entities.set("uuid-12", issue({ id: "uuid-12", key: "ENG-12", state: "In Progress", stateType: "started", linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }] }));
    t.entities.set("acme/web#7", pull({ id: "acme/web#7", key: "acme/web#7", url: "https://github.com/acme/web/pull/7", state: "closed" }, { head: "bb/eng-12-retry", merged: false }));
    const b = t.hooks.store.create({ projectId: "p1", source: "linear", entityId: "uuid-12", entityKey: "ENG-12", url: null, title: "ENG-12", kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "In Progress", stage: "build" });
    await t.ring("linear", "uuid-12");
    await t.flush();
    expect(t.hooks.store.binding(b.id)!.nonActions["pull-closed"]).toBeDefined();
  });
});
