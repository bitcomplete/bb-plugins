// The run record, on a real in-memory SQLite database: what is inserted when,
// how thread signals move it, and how much history is kept.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { RUNS_MIGRATION, RUN_HISTORY, createRunStore } from "./runstore.js";

function setup(start = 1_000_000) {
  const db = new Database(":memory:");
  db.exec(RUNS_MIGRATION);
  let clock = start;
  const store = createRunStore(db, () => clock);
  return { db, store, tick: (ms: number) => (clock += ms), at: () => clock };
}

const TARGET = { path: "/p/quill-abc-101", ticket: "ABC-101", prUrl: "https://github.com/inkwell/quill/pull/42", prNumber: 42 };

describe("agent runs", () => {
  it("records a new-thread run as running once it launches, bound to its thread", () => {
    const { store, at } = setup();
    const id = store.begin({ ...TARGET, action: "resolve-conflicts", mode: "new", threadId: null });
    store.attach(id, "thr-quill-1");
    expect(store.recent(0)).toEqual([
      expect.objectContaining({ id, kind: "agent", action: "resolve-conflicts", threadId: "thr-quill-1", status: "running", startedAt: at(), mode: "new" }),
    ]);
  });

  it("drops a run whose launch failed, because nothing ran", () => {
    const { store } = setup();
    const id = store.begin({ ...TARGET, action: "investigate-ci", mode: "new", threadId: null });
    store.discard(id);
    expect(store.recent(0)).toEqual([]);
  });

  it("moves through needs-you to done, reading the final message only when the event carried none", async () => {
    const { store, tick } = setup();
    const id = store.begin({ ...TARGET, action: "address-review", mode: "subthread", threadId: null });
    store.attach(id, "thr-folio-2");
    tick(1_000);
    const reads: string[] = [];
    const read = async () => {
      reads.push("read");
      return "Replied on every thread.\nResult: Addressed 3 review threads on folio #47";
    };
    expect((await store.signal("thr-folio-2", { kind: "pending" }, read))[0]?.status).toBe("needs-you");
    expect((await store.signal("thr-folio-2", { kind: "settled" }, read))[0]?.status).toBe("running");
    const [done] = await store.signal("thr-folio-2", { kind: "idle", text: null }, read);
    expect(done).toMatchObject({ status: "done", result: "Addressed 3 review threads on folio #47" });
    expect(reads).toEqual(["read"]);
    expect(await store.signal("thr-folio-2", { kind: "active" }, read)).toEqual([]);
  });

  it("does not attribute an earlier turn's Result to a legacy continue run", async () => {
    const { store, tick } = setup();
    store.begin({ ...TARGET, action: "address-comments", mode: "continue", threadId: "thr-margin-3" });
    tick(500);
    const none = async () => "Result: the earlier task";
    expect(await store.signal("thr-margin-3", { kind: "active" }, none)).toEqual([]);
    const [done] = await store.signal("thr-margin-3", { kind: "idle", text: "Result: the earlier task" }, none);
    expect(done).toMatchObject({ status: "done", result: null });
  });

  it("does not give one queued turn's Result to two open actions in the same legacy thread", async () => {
    const { store } = setup();
    const first = store.begin({ ...TARGET, action: "address-review", mode: "continue", threadId: "thr-shared" });
    const second = store.begin({ ...TARGET, action: "address-comments", mode: "continue", threadId: "thr-shared" });
    expect(await store.signal("thr-shared", { kind: "active" }, async () => null)).toEqual([]);
    const finished = await store.signal(
      "thr-shared",
      { kind: "idle", text: "Result: Addressed the first review" },
      async () => "Result: Addressed the first review",
    );
    expect(finished).toEqual([
      expect.objectContaining({ id: first, status: "done", result: null }),
      expect.objectContaining({ id: second, status: "done", result: null }),
    ]);
  });

  it("stores a failed run's error, and a null result when the message has no Result line", async () => {
    const { store, tick } = setup();
    const id = store.begin({ ...TARGET, action: "investigate-ci", mode: "new", threadId: null });
    store.attach(id, "thr-spine-4");
    tick(10);
    const [failed] = await store.signal("thr-spine-4", { kind: "failed", text: null, error: "Turn failed: overloaded" }, async () => "no result here");
    expect(failed).toMatchObject({ status: "failed", result: null, error: "Turn failed: overloaded" });
  });

  it("lists the open run threads for the post-scan reconcile", () => {
    const { store } = setup();
    store.attach(store.begin({ ...TARGET, action: "resolve-conflicts", mode: "new", threadId: null }), "thr-a");
    store.recordDirect({ ...TARGET, action: "merge", ok: true, text: "Merged", startedAt: 1 });
    expect(store.openThreadIds()).toEqual(["thr-a"]);
  });
});

describe("direct runs", () => {
  it("records success and failure with their final outcome and a short reason", () => {
    const { store, at } = setup();
    const merged = store.recordDirect({ ...TARGET, action: "merge", ok: true, text: "Merged", startedAt: at() - 2_000 });
    expect(merged).toMatchObject({ kind: "direct", status: "succeeded", result: "Merged", error: null, finishedAt: at(), threadId: null });
    const refused = store.recordDirect({
      ...TARGET,
      action: "merge",
      ok: false,
      text: "Not merged: new commits were pushed since the dialog opened. Reopen it to review the new head.",
      startedAt: at(),
    });
    expect(refused).toMatchObject({ status: "failed", result: null });
    expect(refused.error).toMatch(/^Not merged: new commits were pushed/u);
  });
});

describe("pruning", () => {
  it("keeps only the newest runs, so the table cannot grow without bound", () => {
    const { store, db, tick } = setup();
    for (let index = 0; index < RUN_HISTORY.max + 15; index += 1) {
      tick(1);
      store.recordDirect({ ...TARGET, action: "nudge", ok: true, text: `Nudged ${index}`, startedAt: 1_000_000 + index });
    }
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM action_runs`).get() as { n: number }).n;
    expect(count).toBe(RUN_HISTORY.max);
  });

  it("drops finished runs older than the age limit but never an open one", () => {
    const { store, db, tick } = setup();
    const open = store.begin({ ...TARGET, action: "resolve-conflicts", mode: "new", threadId: null });
    store.recordDirect({ ...TARGET, action: "merge", ok: true, text: "Merged", startedAt: 1_000_000 });
    tick(RUN_HISTORY.maxAgeMs + 1);
    store.recordDirect({ ...TARGET, action: "nudge", ok: true, text: "Nudged", startedAt: 1_000_000 + RUN_HISTORY.maxAgeMs + 1 });
    const actions = (db.prepare(`SELECT id, action FROM action_runs ORDER BY id`).all() as { id: number; action: string }[]).map((row) => row.action);
    expect(actions).toEqual(["resolve-conflicts", "nudge"]);
    expect(store.recent(0).some((run) => run.id === open)).toBe(true);
  });
});

describe("stranded continue runs", () => {
  const HOUR = 3_600_000;

  it("closes an unarmed continue run on an idle thread after 6h as done with no result, because its outcome is unknown and must not be invented", async () => {
    const { store, tick } = setup();
    const id = store.begin({ ...TARGET, action: "address-comments", mode: "continue", threadId: "thr-spine-4" });
    tick(6 * HOUR + 1_000);
    const [closed] = store.closeStranded("thr-spine-4");
    expect(closed).toMatchObject({ id, status: "done", result: null, error: null });
    // Closed runs never move again, even on a later turn in the same thread.
    expect(await store.signal("thr-spine-4", { kind: "idle", text: "Result: something else" }, async () => null)).toEqual([]);
  });

  it("leaves a run under 6h open, because its own turn may still arrive", () => {
    const { store, tick } = setup();
    store.begin({ ...TARGET, action: "address-comments", mode: "continue", threadId: "thr-spine-4" });
    tick(5 * HOUR);
    expect(store.closeStranded("thr-spine-4")).toEqual([]);
    expect(store.recent(0)[0]?.status).toBe("running");
  });

  it("leaves a new-thread run alone, while a legacy continue run remains ambiguous", async () => {
    const { store, tick } = setup();
    store.begin({ ...TARGET, action: "address-review", mode: "continue", threadId: "thr-colophon-5" });
    tick(1_000);
    expect(await store.signal("thr-colophon-5", { kind: "active" }, async () => null)).toEqual([]);
    const fresh = store.begin({ ...TARGET, action: "investigate-ci", mode: "new", threadId: null });
    store.attach(fresh, "thr-colophon-6");
    tick(7 * HOUR);
    expect(store.closeStranded("thr-colophon-5")).toEqual([expect.objectContaining({ status: "done", result: null })]);
    expect(store.closeStranded("thr-colophon-6")).toEqual([]);
  });
});

describe("settling a run from its answer", () => {
  it("turns a cleanly finished run into a failure with a short reason when its answer was unusable", () => {
    const { store } = setup();
    const id = store.begin({ path: "/p", ticket: null, prUrl: null, prNumber: null, action: "linear-fetch", mode: "new", threadId: null });
    const failed = store.settle(id, false, "No json block in the final message.");
    expect(failed).toEqual(expect.objectContaining({ id, status: "failed", error: "No json block in the final message.", result: null }));
    expect(failed?.finishedAt).not.toBeNull();
    expect(store.settle(id, true, "Stored 2 of 3 tickets")).toEqual(expect.objectContaining({ status: "done", result: "Stored 2 of 3 tickets", error: null }));
  });
});
