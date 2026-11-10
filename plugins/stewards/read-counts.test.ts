// BB-297: the read counts. One describe pins the counting mechanism (it adds
// no reads of its own), the other runs one reconcile pass over a fixed binding
// set and pins the exact number of store reads and GitHub/Linear source calls
// that pass performs. The second is a baseline fixture: update its numbers only
// in a child that explains the change in its pull request body, and never
// loosen it to an inequality.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { playbookPath } from "./config.js";
import { issue, pull } from "./fixtures.js";
import { countingDatabase, createReadCounts } from "./read-counts.js";
import { LINEAR_TICKETS } from "./templates.js";
import { setup } from "./test-world.js";

describe("the read counters (BB-297)", () => {
  it("counts store reads and source calls, and adds no reads of its own", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (n INTEGER)");
    db.prepare("INSERT INTO t (n) VALUES (1), (2)").run();
    const counts = createReadCounts();
    // The independent spy counts every row read the database serves, whatever
    // the counter does. Counting on, the two must agree.
    let rawReads = 0;
    const counted = countingDatabase(db, () => {
      rawReads += 1;
      counts.storeRead();
    });
    await counts.runReconcile(async () => {
      const statement = counted.prepare("SELECT n FROM t");
      expect(statement.get()).toEqual({ n: 1 });
      expect(statement.all()).toHaveLength(2);
      counts.sourceCall();
      counts.sourceCall();
    });
    const on = counts.snapshot().reconcile;
    expect(on.storeReads).toBe(2);
    expect(on.storeReads).toBe(rawReads);
    expect(on.sourceCalls).toBe(2);
    expect(on.reconciles).toBe(1);
    // Counting off (the spy only), the same reads happen: the wrapper added
    // none, so a measured reconcile reads exactly as much as an unmeasured one.
    const before = rawReads;
    const uncounted = countingDatabase(db, () => {
      rawReads += 1;
    });
    await counts.runReconcile(async () => {
      const statement = uncounted.prepare("SELECT n FROM t");
      statement.get();
      statement.all();
    });
    expect(rawReads - before).toBe(on.storeReads);
  });

  it("keeps a wake's counts apart from the reconcile that triggered it", async () => {
    const counts = createReadCounts();
    counts.beginReconcilePass(3);
    await counts.runReconcile(async () => {
      counts.storeRead();
      counts.sourceCall();
      await counts.runWake(async () => {
        counts.storeRead();
        counts.sourceCall();
        counts.sourceCall();
      });
      counts.storeRead();
    });
    const snapshot = counts.snapshot();
    // The reconcile sees the wake's reads too: the wake happens inside it.
    expect(snapshot.reconcile).toEqual({ storeReads: 3, sourceCalls: 3, reconciles: 1, bindings: 3 });
    // The wake counts only its own.
    expect(snapshot.wake).toEqual({ storeReads: 1, sourceCalls: 2, wakes: 1 });
  });
});

describe("a reconcile pass over a fixed binding set (BB-297)", () => {
  /** The default playbook plus one deployment target, so a merged own pull request opens a watch. */
  const deploymentPlaybook = LINEAR_TICKETS.replace(
    "requeue-default: 2d",
    'requeue-default: 2d\ndeployment:\n  source: github\n  repo: acme/web\n  environment: production\n  carries: "The pin contains the merge."\n  timeout: 1h',
  );

  it("performs the pinned number of store reads and source calls", async () => {
    const t = await setup();
    t.files[playbookPath("linear-tickets")] = deploymentPlaybook;
    t.hooks.forgetConfigs();
    // A steward thread the looks already point at, so no binding is adopted
    // mid-pass and no wake spawns a thread.
    t.threads.set("thr_steward", { status: "idle", archivedAt: null });

    const bind = (key: string, entityId: string) => {
      const b = t.hooks.store.create({
        projectId: "p1",
        source: "linear",
        entityId,
        entityKey: key,
        url: null,
        title: key,
        kind: "ticket",
        playbook: "linear-tickets",
        playbookVersion: "v1",
        parentBindingId: null,
        phase: "In Progress",
        stage: "build",
      });
      return t.hooks.store.patch(b.id, { threadId: "thr_steward" });
    };

    // Binding 1: the gate-met shape — a parked worker and two open own pull
    // requests (the second is not gate-met). The worker's result names both, so
    // both are its own.
    const b1 = bind("ENG-12", "uuid-12");
    t.entities.set("uuid-12", issue({ id: "uuid-12", key: "ENG-12", state: "In Progress", stateType: "started", linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }, { key: "acme/web#8", url: "https://github.com/acme/web/pull/8" }] }));
    t.entities.set("acme/web#7", pull({ id: "acme/web#7", key: "acme/web#7", url: "https://github.com/acme/web/pull/7", state: "open" }, { head: "bb/eng-12-retry" }));
    t.entities.set("acme/web#8", pull({ id: "acme/web#8", key: "acme/web#8", url: "https://github.com/acme/web/pull/8", state: "open" }, { head: "bb/eng-12-retry" }));
    t.hooks.store.addWorker("thr_w1", b1.id, "ENG-12: implement");
    t.hooks.store.setWorker("thr_w1", "finished", "Watching acme/web#7 and acme/web#8 for the review.");

    // Binding 2: a deployment watch. The merged own pull request opens the
    // watch and the look reads GitHub for its deployment.
    const b2 = bind("ENG-13", "uuid-13");
    t.entities.set("uuid-13", issue({ id: "uuid-13", key: "ENG-13", state: "In Progress", stateType: "started", linkedPulls: [{ key: "acme/web#9", url: "https://github.com/acme/web/pull/9" }] }));
    t.entities.set("acme/web#9", pull({ id: "acme/web#9", key: "acme/web#9", url: "https://github.com/acme/web/pull/9", state: "merged" }, { merged: true, mergeCommit: "a".repeat(40), head: "bb/eng-13-merge" }));
    t.hooks.store.addWorker("thr_w2", b2.id, "ENG-13: implement");
    t.hooks.store.setWorker("thr_w2", "finished", "Merged acme/web#9.");

    // Binding 3: a typed wait — a dated requeue.
    const b3 = bind("ENG-14", "uuid-14");
    t.entities.set("uuid-14", issue({ id: "uuid-14", key: "ENG-14", state: "In Progress", stateType: "started" }));
    t.hooks.store.patch(b3.id, { requeueUntil: t.now() + 100_000 });

    // Binding 4: a free-text wait.
    const b4 = bind("ENG-15", "uuid-15");
    t.entities.set("uuid-15", issue({ id: "uuid-15", key: "ENG-15", state: "In Progress", stateType: "started" }));
    t.hooks.store.patch(b4.id, {
      status: { phase: "In Progress", summary: "Waiting on the vendor.", nextAction: "Wait for the vendor.", actor: "other", waitingOn: "the vendor", requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: t.now() },
    });

    // One reconcile pass over the fixed set, measured as the sweep measures one.
    await t.hooks.reconcilePass("p1");
    const { reconcile, wake } = t.hooks.readCounts.snapshot();
    // The pinned baseline. Update these numbers only in a child that explains
    // the change in its pull request body; never loosen them to inequalities.
    expect(reconcile).toEqual({ storeReads: 191, sourceCalls: 10, reconciles: 4, bindings: 4 });
    expect(wake).toEqual({ storeReads: 16, sourceCalls: 0, wakes: 1 });
  });

  it("reports the pass in bb stewards stats, text and JSON (BB-297)", async () => {
    const t = await setup();
    t.files[playbookPath("linear-tickets")] = deploymentPlaybook;
    t.hooks.forgetConfigs();
    t.threads.set("thr_steward", { status: "idle", archivedAt: null });
    t.entities.set("uuid-12", issue({ id: "uuid-12", key: "ENG-12", state: "In Progress", stateType: "started" }));
    t.hooks.store.patch(t.hooks.store.create({ projectId: "p1", source: "linear", entityId: "uuid-12", entityKey: "ENG-12", url: null, title: "ENG-12", kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "In Progress", stage: "build" }).id, { threadId: "thr_steward" });
    await t.hooks.reconcilePass("p1");
    const json = JSON.parse((await t.harness.behavior.runCli(["stats", "--json"])).stdout) as { reads: { reconcile: { storeReads: number; sourceCalls: number; reconciles: number; bindings: number }; wake: { storeReads: number; sourceCalls: number; wakes: number } } };
    expect(json.reads.reconcile).toEqual(t.hooks.readCounts.snapshot().reconcile);
    expect(json.reads.reconcile.bindings).toBe(1);
    expect(json.reads.wake).toEqual(t.hooks.readCounts.snapshot().wake);
    const text = (await t.harness.behavior.runCli(["stats"])).stdout;
    expect(text).toMatch(/Reads and source calls \(BB-297\):/u);
    expect(text).toMatch(/reconcile pass: \d+ store reads, \d+ source calls over \d+ reconciles? at 1 binding \(\d+\.\d reads, \d+\.\d calls per reconcile\)/u);
    expect(text).toMatch(/wake: \d+ store reads, \d+ source calls over \d+ wakes? \(\d+\.\d reads, \d+\.\d calls per wake\)/u);
  });
});
