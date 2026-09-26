import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { Recommendation, ThreadCandidate } from "./actions.js";
import { ADVANCE_MIGRATIONS, createAdvanceService, preparationPrompt, type AdvanceFacts } from "./bulk-advance.js";

const fact = (number = 1, overrides: Partial<AdvanceFacts> = {}): AdvanceFacts => ({
  prUrl: `https://github.com/acme/app/pull/${number}`, number, repo: "acme/app", title: `Fix ${number}`,
  headOid: `${number}`.repeat(40), baseOid: "a".repeat(40), headRefName: `fix-${number}`, baseRefName: "main",
  needsPreparation: true, needsFeedback: false, eligible: true, detail: "Needs rebase", workspace: "create", projectId: "project",
  hostId: "host", sourcePath: "/source", path: `/checkout/${number}`, readiness: "needs-attention", blockedBy: null, ...overrides,
});
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup(facts = [fact()]) {
  const db = new Database(":memory:");
  for (const sql of ADVANCE_MIGRATIONS) db.exec(sql);
  const current = new Map(facts.map((f) => [f.prUrl, f]));
  let time = 1_000;
  const deps = {
    inspect: vi.fn(async (url: string) => ({ ...current.get(url)! })),
    repairCandidates: vi.fn(async (_facts: AdvanceFacts, _job: unknown): Promise<{ candidates: ThreadCandidate[]; recommendation: Recommendation }> => ({
      candidates: [{ id: "author", title: "Original PR work", tier: "started", running: false, updatedAt: 0, contextUsed: null, canSpawnChild: true }],
      recommendation: { mode: "subthread", threadId: "author", reason: "Original PR author context" },
    })),
    repairSpawn: vi.fn(async (_facts: AdvanceFacts, _path: string, _prompt: string, _id: string, _mode: "new" | "subthread", _parent: string | null) => "repair-thread"),
    busyNow: vi.fn(() => false), busy: vi.fn(async () => false),
    workspace: vi.fn(async (_: AdvanceFacts, _batch: string, id: string) => ({ path: `/isolated/${id}`, workerPath: "/isolated" })),
    spawn: vi.fn(async (_facts: AdvanceFacts, _path: string, _prompt: string, _jobId: string) => "thread"), send: vi.fn(async (_threadId: string, _prompt: string) => {}),
    thread: vi.fn(async () => ({ status: "idle", archivedAt: null, deletedAt: null, output: "" })),
    recover: vi.fn(async (): Promise<string[]> => []), changed: vi.fn(), verified: vi.fn(), now: () => time,
  };
  const service = createAdvanceService(db, deps);
  const start = async () => { const plan = await service.preview(facts.map((f) => f.prUrl)); const batch = await service.start(plan.token); await drain(); return batch; };
  return { db, deps, service, current, start, time: (value: number) => { time = value; } };
}

describe("finite Advance preparation", () => {
  it.each(["merged", "closed"] as const)("removes %s failed work without requiring a success marker, retaining durable history", async (readiness) => {
    const t = setup(); const batch = await t.start(); const job = batch.jobs[0]!;
    await t.service.signal("thread", "idle", "Worker stopped without a prepared marker");
    expect(job).toMatchObject({ status: "needs-attention", uncertain: true });
    t.current.set(job.prUrl, fact(1, { readiness, eligible: false, needsPreparation: false, detail: `PR ${readiness}.`, baseOid: "" }));
    t.deps.thread.mockRejectedValueOnce(new Error("Old worker was deleted"));
    await t.service.recheck(batch.id, job.id);
    expect(job).toMatchObject({ status: readiness, hiddenFromProgress: true, uncertain: false, threadId: "thread" });
    expect(t.service.reserved(job.prUrl, job.path)).toBe(false);
    t.service.progressVisibility(batch.id, job.id, false);
    t.deps.inspect.mockRejectedValueOnce(new Error("Old PR unavailable"));
    await t.service.recheck(batch.id);
    expect(job).toMatchObject({ status: readiness, hiddenFromProgress: true });
    await expect(t.service.repairPlan(batch.id, job.id)).rejects.toThrow("not awaiting a repair");
    t.service.dispose();
    expect(createAdvanceService(t.db, t.deps).list()[0]!.jobs[0]).toMatchObject({ status: readiness, hiddenFromProgress: true, threadId: "thread" });
  });
  it.each(["MERGED", "CLOSED"])("fresh %s observations remove failed jobs even without a checked head", async (state) => {
    const t = setup(); const batch = await t.start(); const job = batch.jobs[0]!;
    await t.service.signal("thread", "idle", `Workstreams job ${job.id} complete: blocked`);
    expect(job.checkedHeadOid).toBeNull();
    t.service.invalidate([{ url: job.prUrl, state }]);
    expect(job).toMatchObject({ status: state.toLowerCase(), hiddenFromProgress: true });
    t.deps.changed.mockClear();
    t.service.invalidate([{ url: job.prUrl, state }]);
    expect(t.deps.changed).not.toHaveBeenCalled();
    t.service.invalidate([{ url: job.prUrl, state: "OPEN", headRefOid: "c".repeat(40) }]);
    expect(job.hiddenFromProgress).toBe(true);
  });
  it("only retires an active item when live terminal state is proven", async () => {
    const t = setup(); const batch = await t.start(); const job = batch.jobs[0]!;
    t.deps.inspect.mockRejectedValueOnce(new Error("GitHub unavailable"));
    await t.service.recheck(batch.id, job.id);
    expect(job.status).toBe("running");
    expect(t.service.reserved(job.prUrl, job.path)).toBe(true);
    await t.service.recheck(batch.id, job.id);
    expect(job.status).toBe("running");
    t.current.set(job.prUrl, fact(1, { readiness: "merged", eligible: false }));
    await t.service.recheck(batch.id, job.id);
    expect(job).toMatchObject({ status: "merged", hiddenFromProgress: true });
  });
  it("a late spawn response cannot resurrect a PR already observed merged", async () => {
    const t = setup(); let finish!: (id: string) => void;
    t.deps.spawn.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const batch = await t.start(); const job = batch.jobs[0]!;
    expect(job.status).toBe("launching");
    t.service.invalidate([{ url: job.prUrl, state: "MERGED" }]);
    finish("late-thread"); await drain();
    expect(job).toMatchObject({ status: "merged", hiddenFromProgress: true, threadId: "late-thread" });
  });
  it("records a failed recheck per item and continues checking other selected PRs", async () => {
    const t = setup([fact(1, { needsPreparation: false, readiness: "ready" }), fact(2, { needsPreparation: false, readiness: "ready" })]);
    const batch = await t.start(); await drain();
    t.deps.inspect.mockRejectedValueOnce(new Error("GitHub unavailable"));
    t.current.set(fact(2).prUrl, fact(2, { readiness: "closed", eligible: false, needsPreparation: false }));
    await t.service.recheck(batch.id);
    expect(batch.jobs[0]).toMatchObject({ status: "needs-attention", detail: expect.stringContaining("GitHub unavailable") });
    expect(batch.jobs[1]).toMatchObject({ status: "closed", hiddenFromProgress: true });
  });
  it("does not launch a queued PR that merged while the earlier repository job ran", async () => {
    const t = setup([fact(1), fact(2)]); const batch = await t.start();
    t.current.set(fact(2).prUrl, fact(2, { readiness: "merged", eligible: false, needsPreparation: false }));
    t.current.set(fact(1).prUrl, fact(1, { readiness: "ready", needsPreparation: false }));
    await t.service.signal("thread", "idle", `Workstreams job ${batch.jobs[0]!.id} complete: prepared`); await drain();
    expect(batch.jobs[1]).toMatchObject({ status: "merged", hiddenFromProgress: true });
    expect(t.deps.workspace).toHaveBeenCalledTimes(1);
    expect(t.deps.send).not.toHaveBeenCalled();
  });
  it("checks the hold policy after provisioning and before any worker launch", async () => {
    const t = setup(); let held = false;
    const assertAdvanceAllowed = vi.fn(() => { if (held) throw new Error("PR is on hold"); });
    t.deps.workspace.mockImplementationOnce(async () => { held = true; return { path: "/isolated/job", workerPath: "/isolated" }; });
    t.service.dispose();
    const service = createAdvanceService(t.db, { ...t.deps, assertAdvanceAllowed });
    const plan = await service.preview([fact().prUrl]); const batch = await service.start(plan.token); await drain();
    expect(batch.jobs[0]).toMatchObject({ status: "needs-attention", uncertain: false, detail: "Error: PR is on hold" });
    expect(t.deps.spawn).not.toHaveBeenCalled();
    expect(assertAdvanceAllowed).toHaveBeenCalledTimes(2);
  });

  it("removes only the queued item and never requeues it when progress visibility is restored", async () => {
    const t = setup([fact(1), fact(2), fact(3)]); const batch = await t.start();
    const [first, removed, next] = batch.jobs;
    t.service.progressVisibility(batch.id, removed!.id, true);
    expect(removed).toMatchObject({ status: "cancelled", hiddenFromProgress: true });
    expect(batch.cancelled).toBe(false);
    t.service.progressVisibility(batch.id, removed!.id, false);
    expect(removed).toMatchObject({ status: "cancelled", hiddenFromProgress: false });
    t.current.set(first!.prUrl, fact(1, { needsPreparation: false, readiness: "ready" }));
    await t.service.signal("thread", "idle", `Workstreams job ${first!.id} complete: prepared`); await drain();
    expect(next!.status).toBe("running");
    expect(t.deps.send).toHaveBeenCalledTimes(1);
    expect(t.deps.send.mock.calls[0]![1]).toContain(`Workstreams job ${next!.id} complete: prepared`);
    expect(t.deps.workspace.mock.calls.map(([facts]) => facts.number)).toEqual([1, 3]);
    expect(t.service.list()[0]!.jobs).toHaveLength(3);
  });
  it("cancels a queued item even while its checkout is being provisioned", async () => {
    const t = setup();
    let finish!: (workspace: { path: string; workerPath: string }) => void;
    t.deps.workspace.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const batch = await t.start();
    expect(t.deps.workspace).toHaveBeenCalledOnce();
    t.service.progressVisibility(batch.id, batch.jobs[0]!.id, true);
    finish({ path: "/isolated/job", workerPath: "/isolated" }); await drain();
    expect(t.deps.spawn).not.toHaveBeenCalled();
    expect(batch.jobs[0]).toMatchObject({ status: "cancelled", hiddenFromProgress: true });
  });
  it.each(["launching", "running", "verifying", "uncertain"])("keeps %s work visible until its writer is reconciled", async (status) => {
    const t = setup(); const batch = await t.start(); t.service.dispose();
    const saved = JSON.parse((t.db.prepare("SELECT body FROM advance_batches WHERE id = ?").get(batch.id) as { body: string }).body);
    Object.assign(saved.jobs[0], { status: status === "uncertain" ? "needs-attention" : status, uncertain: status === "uncertain" });
    t.db.prepare("UPDATE advance_batches SET body = ? WHERE id = ?").run(JSON.stringify(saved), batch.id);
    const restored = createAdvanceService(t.db, t.deps);
    expect(() => restored.progressVisibility(batch.id, batch.jobs[0]!.id, true)).toThrow("reconcile");
    expect(restored.list()[0]!.jobs[0]!.hiddenFromProgress).toBe(false);
    expect(restored.reserved(fact().prUrl, fact().path)).toBe(true);
  });
  it("persists hidden results and defaults older stored jobs to visible without relaunching work", async () => {
    const t = setup([fact(1, { needsPreparation: false, readiness: "ready" })]); const batch = await t.start();
    t.service.progressVisibility(batch.id, batch.jobs[0]!.id, true); t.service.dispose();
    const restored = createAdvanceService(t.db, t.deps);
    expect(restored.list()[0]!.jobs[0]!.hiddenFromProgress).toBe(true);
    restored.progressVisibility(batch.id, batch.jobs[0]!.id, false);
    await restored.tick(true); restored.dispose();
    const saved = JSON.parse((t.db.prepare("SELECT body FROM advance_batches WHERE id = ?").get(batch.id) as { body: string }).body);
    delete saved.jobs[0].hiddenFromProgress;
    t.db.prepare("UPDATE advance_batches SET body = ? WHERE id = ?").run(JSON.stringify(saved), batch.id);
    expect(createAdvanceService(t.db, t.deps).list()[0]!.jobs[0]!.hiddenFromProgress).toBe(false);
    expect(t.deps.spawn).not.toHaveBeenCalled();
    expect(t.deps.workspace).not.toHaveBeenCalled();
  });
  it("rechecks only the requested item and restores its progress visibility", async () => {
    const t = setup([fact(1, { needsPreparation: false, readiness: "ready" }), fact(2, { needsPreparation: false, readiness: "ready" })]);
    const batch = await t.start(); await drain();
    for (const job of batch.jobs) t.service.progressVisibility(batch.id, job.id, true);
    t.current.set(fact().prUrl, fact(1, { needsPreparation: false, readiness: "waiting-review" }));
    t.deps.inspect.mockClear();
    await t.service.recheck(batch.id, batch.jobs[0]!.id);
    expect(t.deps.inspect.mock.calls).toEqual([[fact().prUrl]]);
    expect(batch.jobs[0]).toMatchObject({ status: "waiting-review", hiddenFromProgress: false });
    expect(batch.jobs[1]).toMatchObject({ status: "ready", hiddenFromProgress: true });
    await expect(t.service.recheck(batch.id, "missing")).rejects.toThrow("item is no longer available");
    expect(() => t.service.progressVisibility(batch.id, "missing", true)).toThrow("item is no longer available");
  });
  it("keeps background checks and batch rechecks hidden until a new actionable blocker appears", async () => {
    const t = setup([fact(1, { needsPreparation: false, readiness: "waiting-checks" })]); const batch = await t.start();
    const job = batch.jobs[0]!;
    t.service.progressVisibility(batch.id, job.id, true);
    await t.service.tick();
    expect(job).toMatchObject({ status: "waiting-checks", hiddenFromProgress: true });
    await t.service.recheck(batch.id);
    expect(job.hiddenFromProgress).toBe(true);
    t.current.set(job.prUrl, fact(1, { needsPreparation: false, readiness: "needs-attention", detail: "Checks failed" }));
    await t.service.tick();
    expect(job).toMatchObject({ status: "needs-attention", hiddenFromProgress: false });
    t.service.progressVisibility(batch.id, job.id, true);
    await t.service.recheck(batch.id);
    expect(job.hiddenFromProgress).toBe(true);
  });
  it("restores a hidden failed item when its worker reports a new completed result", async () => {
    const t = setup(); const batch = await t.start(); const job = batch.jobs[0]!;
    await t.service.signal("thread", "idle", `Workstreams job ${job.id} complete: blocked`);
    t.service.progressVisibility(batch.id, job.id, true);
    t.current.set(job.prUrl, fact(1, { needsPreparation: false, readiness: "ready" }));
    await t.service.signal("thread", "idle", `Workstreams job ${job.id} complete: prepared`);
    expect(job).toMatchObject({ status: "ready", hiddenFromProgress: false });
  });
  it("restores a hidden failed item when its worker resumes or an explicit repair starts", async () => {
    const t = setup(); const batch = await t.start(); const job = batch.jobs[0]!;
    await t.service.signal("thread", "idle", `Workstreams job ${job.id} complete: blocked`);
    t.service.progressVisibility(batch.id, job.id, true);
    t.deps.thread.mockResolvedValue({ status: "active", archivedAt: null, deletedAt: null, output: "" });
    await t.service.recheck(batch.id);
    expect(job).toMatchObject({ status: "running", hiddenFromProgress: false });
    await t.service.signal("thread", "idle", `Workstreams job ${job.id} complete: blocked`);
    t.deps.thread.mockResolvedValue({ status: "idle", archivedAt: null, deletedAt: null, output: "" });
    t.service.progressVisibility(batch.id, job.id, true);
    const plan = await t.service.repairPlan(batch.id, job.id);
    await t.service.repairRun({ token: plan.token, mode: "new", threadId: null, instruction: "" });
    expect(job).toMatchObject({ status: "running", hiddenFromProgress: false, threadId: "repair-thread" });
  });
  it("verifies already current PRs without a worker and keeps selection/idempotency", async () => {
    const t = setup([fact(1, { needsPreparation: false, readiness: "ready", detail: "Ready" })]);
    const plan = await t.service.preview([fact().prUrl, fact().prUrl]);
    const batch = await t.service.start(plan.token); await drain();
    expect((await t.service.start(plan.token)).id).toBe(batch.id);
    expect(t.service.list()[0]!.jobs).toHaveLength(1);
    expect(t.service.list()[0]!.jobs[0]).toMatchObject({ status: "ready", checkedHeadOid: fact().headOid });
    expect(t.deps.spawn).not.toHaveBeenCalled();
    expect(t.deps.verified).toHaveBeenCalledWith(fact().prUrl, fact().path);
  });
  it("starts a feedback-only worker and reuses it for the next PR in the repository", async () => {
    const one = fact(1, { needsPreparation: false, needsFeedback: true });
    const two = fact(2, { needsPreparation: false, needsFeedback: true });
    const t = setup([one, two]); const batch = await t.start();
    expect(t.deps.workspace).toHaveBeenCalledTimes(1);
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
    expect(t.service.list()[0]!.jobs[0]!.detail).toContain("review feedback");
    t.current.set(one.prUrl, { ...one, needsFeedback: false, readiness: "ready", detail: "Feedback addressed" });
    await t.service.signal("thread", "idle", `Workstreams job ${batch.jobs[0]!.id} complete: prepared`); await drain();
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
    expect(t.deps.send).toHaveBeenCalledTimes(1);
    expect(t.deps.workspace).toHaveBeenCalledTimes(2);
    expect(t.service.list()[0]!.jobs[0]!.status).toBe("ready");
    expect(t.service.list()[0]!.jobs[1]!.status).toBe("running");
  });
  it("keeps blocked feedback work blocked when GitHub looks ready but completion was not confirmed", async () => {
    const feedback = fact(1, { needsPreparation: false, needsFeedback: true });
    const t = setup([feedback]); const batch = await t.start();
    t.current.set(feedback.prUrl, { ...feedback, needsFeedback: false, readiness: "ready" });
    await t.service.signal("thread", "idle", `Workstreams job ${batch.jobs[0]!.id} complete: blocked`);
    await t.service.recheck(batch.id);
    expect(t.service.list()[0]!.jobs[0]!.status).toBe("needs-attention");
    expect(t.service.list()[0]!.jobs[0]!.detail).toContain("Requested work was not confirmed");
  });
  it("rejects feedback appearing after a verify-only preview", async () => {
    const current = fact(1, { needsPreparation: false, needsFeedback: false });
    const t = setup([current]); const plan = await t.service.preview([current.prUrl]);
    t.current.set(current.prUrl, { ...current, needsFeedback: true });
    await expect(t.service.start(plan.token)).rejects.toThrow("changed");
    expect(t.deps.spawn).not.toHaveBeenCalled();
  });
  it("defaults legacy persisted jobs to no feedback permission and never adds writes during recovery", async () => {
    for (const feedbackAppeared of [false, true]) {
      const current = fact(1, { needsPreparation: false, needsFeedback: false, readiness: "ready" });
      const t = setup([current]); const batch = await t.start(); t.service.dispose();
      const row = t.db.prepare("SELECT body FROM advance_batches WHERE id = ?").get(batch.id) as { body: string };
      const saved = JSON.parse(row.body);
      saved.jobs[0].status = "queued";
      saved.prepared = {};
      delete saved.jobs[0].needsFeedback;
      delete saved.facts[saved.jobs[0].id].needsFeedback;
      t.db.prepare("UPDATE advance_batches SET body = ? WHERE id = ?").run(JSON.stringify(saved), batch.id);
      t.current.set(current.prUrl, { ...current, needsFeedback: feedbackAppeared });
      const restored = createAdvanceService(t.db, t.deps);
      expect(restored.list()[0]!.jobs[0]!.needsFeedback).toBe(false);
      await restored.tick(true); await drain();
      expect(t.deps.spawn).not.toHaveBeenCalled();
      expect(t.deps.workspace).not.toHaveBeenCalled();
      expect(restored.list()[0]!.jobs[0]!.status).toBe(feedbackAppeared ? "needs-attention" : "ready");
    }
  });
  it("never promotes a preview skip if its busy writer finishes before confirmation", async () => {
    const t = setup([fact(1), fact(2)]);
    t.deps.busy.mockImplementation(async (url?: string) => url === fact().prUrl);
    const plan = await t.service.preview([fact().prUrl, fact(2).prUrl]);
    t.deps.busy.mockResolvedValue(false);
    await t.service.start(plan.token); await drain();
    expect(t.service.list()[0]!.jobs[0]!.eligible).toBe(false);
    expect(t.service.list()[0]!.jobs[0]!.status).toBe("needs-attention");
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
  });
  it("rejects changed head, base or newly required writes between preview and start", async () => {
    for (const change of [{ headOid: "b".repeat(40) }, { baseOid: "b".repeat(40) }, { needsPreparation: false }]) {
      const t = setup(); const plan = await t.service.preview([fact().prUrl]);
      t.current.set(fact().prUrl, fact(1, change));
      await expect(t.service.start(plan.token)).rejects.toThrow("changed");
      expect(t.deps.spawn).not.toHaveBeenCalled();
    }
  });
  it("keeps PR/repo reserved while waiting for input and ignores stale completion markers", async () => {
    const t = setup([fact(1), fact(2)]); const batch = await t.start();
    await t.service.signal("thread", "pending");
    expect(t.service.reserved(fact().prUrl, null)).toBe(true);
    expect(t.deps.send).not.toHaveBeenCalled();
    await t.service.signal("thread", "idle", "Workstreams job old complete: prepared");
    expect(t.service.list()[0]!.jobs[0]).toMatchObject({ uncertain: true, status: "needs-attention" });
    expect(t.service.reserved(fact().prUrl, null)).toBe(true);
    expect(t.service.list()[0]!.id).toBe(batch.id);
  });
  it("does not turn a worker's failed validation into Ready from GitHub alone", async () => {
    const t = setup(); const batch = await t.start();
    t.current.set(fact().prUrl, fact(1, { readiness: "ready", needsPreparation: false }));
    await t.service.signal("thread", "idle", `Workstreams job ${batch.jobs[0]!.id} complete: blocked`);
    await t.service.recheck(batch.id);
    expect(t.service.list()[0]!.jobs[0]!.status).toBe("needs-attention");
  });
  it("prepares a three-level stack in order with one repo worker despite remaining comments", async () => {
    const root = fact(1), child = fact(2, { baseRefName: "fix-1", baseOid: root.headOid }), top = fact(3, { baseRefName: "fix-2", baseOid: child.headOid });
    const t = setup([top, child, root]); const batch = await t.start();
    expect(t.deps.spawn.mock.calls[0]?.[0]).toMatchObject({ number: 1 });
    for (const number of [1, 2, 3]) {
      const current = t.current.get(fact(number).prUrl)!;
      const headOid = `${number + 3}`.repeat(40);
      t.current.set(current.prUrl, { ...current, headOid, needsPreparation: false, readiness: "needs-attention", detail: "Review comments remain" });
      const next = t.current.get(fact(number + 1).prUrl);
      if (next) t.current.set(next.prUrl, { ...next, baseOid: headOid });
      const job = batch.jobs.find((entry) => entry.number === number)!;
      await t.service.signal("thread", "idle", `Workstreams job ${job.id} complete: prepared`); await drain();
    }
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
    expect(t.deps.send).toHaveBeenCalledTimes(2);
    expect(t.service.list()[0]!.jobs.every((job) => job.checkedHeadOid !== null)).toBe(true);
  });
  it("does not expand verify-only authorization when a selected parent creates new prep work", async () => {
    const root = fact(1), child = fact(2, { baseRefName: "fix-1", baseOid: root.headOid, needsPreparation: false });
    const t = setup([root, child]); const batch = await t.start();
    const newHead = "d".repeat(40);
    t.current.set(root.prUrl, { ...root, headOid: newHead, needsPreparation: false, readiness: "ready" });
    t.current.set(child.prUrl, { ...child, baseOid: newHead, needsPreparation: true });
    await t.service.signal("thread", "idle", `Workstreams job ${batch.jobs[0]!.id} complete: prepared`); await drain();
    expect(t.deps.send).not.toHaveBeenCalled();
    expect(t.service.list()[0]!.jobs[1]!.detail).toContain("Selected parent advanced");
  });
  it("requires the completion marker to be the exact final line", async () => {
    const t = setup(); const batch = await t.start();
    await t.service.signal("thread", "idle", `Workstreams job ${batch.jobs[0]!.id} complete: prepared\nActually, tests failed.`);
    expect(t.service.list()[0]!.jobs[0]).toMatchObject({ status: "needs-attention", uncertain: true });
  });
  it("cancels a queued job even when workspace provisioning is already awaiting IO", async () => {
    const t = setup(); let resolve!: (value: { path: string; workerPath: string }) => void;
    t.deps.workspace.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const batch = await t.start(); t.service.cancel(batch.id);
    resolve({ path: "/isolated/job", workerPath: "/isolated" }); await drain();
    expect(t.deps.spawn).not.toHaveBeenCalled();
    expect(t.service.list()[0]!.jobs[0]!.status).toBe("cancelled");
  });
  it("recovers an interrupted spawn without spawning twice and requires stopped-worker reconciliation", async () => {
    const t = setup(); t.deps.spawn.mockRejectedValue(new Error("timeout"));
    const batch = await t.start();
    expect(t.service.list()[0]!.jobs[0]!.uncertain).toBe(true);
    const restored = createAdvanceService(t.db, t.deps); t.deps.recover.mockResolvedValue(["existing"]);
    t.deps.thread.mockResolvedValue({ status: "active", archivedAt: null, deletedAt: null, output: "" });
    await restored.recheck(batch.id);
    expect(restored.reserved(fact().prUrl, null)).toBe(true);
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
    t.deps.thread.mockResolvedValue({ status: "idle", archivedAt: null, deletedAt: null, output: "" });
    await restored.recheck(batch.id);
    expect(restored.reserved(fact().prUrl, null)).toBe(false);
  });
  it("releases a confirmed absent ambiguous launch without retrying writes", async () => {
    const t = setup(); t.deps.spawn.mockRejectedValue(new Error("timeout")); const batch = await t.start();
    t.time(40_000); await t.service.recheck(batch.id);
    expect(t.service.reserved(fact().prUrl, null)).toBe(false);
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
  });
  it("does not confuse GitHub's historical base snapshot with the live verified base tip", async () => {
    const t = setup([fact(1, { needsPreparation: false, readiness: "ready" })]); await t.start();
    t.service.invalidate([{ url: fact().prUrl, headRefOid: fact().headOid, baseRefOid: "c".repeat(40) }]);
    expect(t.service.list()[0]!.jobs[0]).toMatchObject({ status: "ready", checkedHeadOid: fact().headOid });
  });
  it("invalidates Ready when approval or comments change on the same head", async () => {
    for (const change of [{ reviewDecision: "CHANGES_REQUESTED" }, { unresolvedReviewThreads: 1 }, { unresolvedReviewThreads: null }, { isDraft: true }, { approvalHasBody: true, approvalNoteFollowedUp: false }, { checkConclusions: ["FAILURE"] }]) {
      const t = setup([fact(1, { needsPreparation: false, readiness: "ready" })]); await t.start();
      t.service.invalidate([{ url: fact().prUrl, headRefOid: fact().headOid, baseRefOid: fact().baseOid, ...change }]);
      expect(t.service.list()[0]!.jobs[0]!.status).toBe("needs-attention");
    }
  });
  it("bounds active workers to two independent repositories", async () => {
    const facts = [fact(1), fact(2, { repo: "acme/web" }), fact(3, { repo: "acme/api" })];
    const t = setup(facts); await t.start();
    expect(t.deps.spawn).toHaveBeenCalledTimes(2);
    expect(t.service.list()[0]!.jobs.filter((job) => job.status === "queued")).toHaveLength(1);
  });
  it("stops a new batch when a manual writer starts during preflight", async () => {
    const t = setup(); const plan = await t.service.preview([fact().prUrl]); t.deps.busyNow.mockReturnValue(true);
    await expect(t.service.start(plan.token)).rejects.toThrow("Another action");
    expect(t.deps.spawn).not.toHaveBeenCalled();
  });
  it("instructs feedback fixes, evidence-based replies, safe resolutions, and no-op bookkeeping", () => {
    const prompt = preparationPrompt(fact(1, { needsPreparation: false, needsFeedback: true }), "/isolated/job");
    expect(prompt).toContain("all paginated review threads");
    expect(prompt).toContain("prior author replies");
    expect(prompt).toContain("integrate the current PR base");
    expect(prompt).toContain("no new commit or push is required");
    expect(prompt).toContain("Never resolve unanswered disagreements");
    expect(prompt).toContain('explicitly says "approval note"');
    expect(prompt).toContain("actual @reviewer");
    expect(prompt).toContain("current head SHA");
    expect(prompt).toContain("ask PTAL only when another review is needed");
    expect(prompt).not.toContain("do not make unrelated review fixes");
  });
  it("pins detached-worktree pushes to the original remote head and forbids merge", () => {
    const prompt = preparationPrompt(fact(), "/isolated/job");
    expect(prompt).toContain("HEAD:refs/heads/<headBranch>");
    expect(prompt).toContain("original expectedHead");
    expect(prompt).toContain("do not merge");
    expect(prompt).toContain("untrusted task metadata");
  });
  it("reconciles success after a worker failed and then resumed, without sending again", async () => {
    const t = setup(); const batch = await t.start(); const job = batch.jobs[0]!;
    await t.service.signal("thread", "failed");
    t.current.set(job.prUrl, fact(1, { needsPreparation: false, readiness: "ready" }));
    t.deps.thread.mockResolvedValue({ status: "idle", archivedAt: null, deletedAt: null, output: `Workstreams job ${job.id} complete: prepared` });
    await t.service.recheck(batch.id);
    expect(t.service.list()[0]!.jobs[0]).toMatchObject({ status: "ready", uncertain: false });
    expect(t.deps.send).not.toHaveBeenCalled();
  });
  it("accepts the exact current result event after a failed attempt resumes", async () => {
    const t = setup(); const batch = await t.start(); const job = batch.jobs[0]!;
    await t.service.signal("thread", "failed");
    t.current.set(job.prUrl, fact(1, { needsPreparation: false, readiness: "ready" }));
    await t.service.signal("thread", "idle", `Workstreams job ${job.id} complete: prepared`);
    expect(t.service.list()[0]!.jobs[0]!.status).toBe("ready");
  });
  it("launches a dedicated child repair once, preserves history, and ignores the old marker", async () => {
    const t = setup(); const batch = await t.start(); const job = batch.jobs[0]!;
    await t.service.signal("thread", "idle", `Workstreams job ${job.id} complete: blocked`);
    const plan = await t.service.repairPlan(batch.id, job.id);
    const input = { token: plan.token, mode: "subthread" as const, threadId: "author", instruction: "Fix the failing tests" };
    const result = await t.service.repairRun(input);
    expect((await t.service.repairRun(input)).threadId).toBe(result.threadId);
    expect(t.deps.repairSpawn).toHaveBeenCalledTimes(1);
    expect(t.deps.repairSpawn.mock.calls[0]?.slice(4)).toEqual(["subthread", "author"]);
    const repaired = result.batch.jobs[0]!;
    expect(repaired).toMatchObject({ dedicated: true, threadId: "repair-thread", status: "running" });
    expect(repaired.attemptId).not.toBe(job.id);
    expect(repaired.previousAttempts[0]).toMatchObject({ attemptId: job.id, threadId: "thread", status: "needs-attention" });
    t.current.set(job.prUrl, fact(1, { needsPreparation: false, readiness: "ready" }));
    await t.service.signal("repair-thread", "idle", `Workstreams job ${job.id} complete: prepared`);
    expect(t.service.list()[0]!.jobs[0]).toMatchObject({ status: "needs-attention", uncertain: true });
    await t.service.signal("repair-thread", "idle", `Workstreams job ${repaired.attemptId} complete: prepared`);
    expect(t.service.list()[0]!.jobs[0]!.status).toBe("ready");
  });
  it("rejects stale repair previews without overwriting the prior failed attempt", async () => {
    const t = setup(); const batch = await t.start(); const id = batch.jobs[0]!.id;
    await t.service.signal("thread", "idle", `Workstreams job ${id} complete: blocked`);
    const plan = await t.service.repairPlan(batch.id, id);
    t.current.set(fact().prUrl, fact(1, { headOid: "f".repeat(40) }));
    await expect(t.service.repairRun({ token: plan.token, mode: "new", threadId: null, instruction: "" })).rejects.toThrow("changed");
    expect(t.service.list()[0]!.jobs[0]).toMatchObject({ threadId: "thread", status: "needs-attention", attemptId: null, previousAttempts: [] });
    expect(t.deps.repairSpawn).not.toHaveBeenCalled();
  });
  it("refuses repair while the uncertain original worker is still active", async () => {
    const t = setup(); const batch = await t.start(); await t.service.signal("thread", "failed");
    t.deps.thread.mockResolvedValue({ status: "active", archivedAt: null, deletedAt: null, output: "" });
    await expect(t.service.repairPlan(batch.id, batch.jobs[0]!.id)).rejects.toThrow("still active");
    expect(t.service.reserved(fact().prUrl, null)).toBe(true);
    expect(t.deps.repairSpawn).not.toHaveBeenCalled();
  });
  it("never reuses a dedicated repair child for the remaining repository queue", async () => {
    const t = setup([fact(1), fact(2), fact(3)]); const batch = await t.start();
    await t.service.signal("thread", "idle", `Workstreams job ${batch.jobs[0]!.id} complete: blocked`); await drain();
    const plan = await t.service.repairPlan(batch.id, batch.jobs[0]!.id);
    expect(plan.modes).not.toContain("continue");
    const result = await t.service.repairRun({ token: plan.token, mode: "subthread", threadId: "author", instruction: "" });
    t.current.set(fact(2).prUrl, fact(2, { needsPreparation: false, readiness: "ready" }));
    await t.service.signal("thread", "idle", `Workstreams job ${batch.jobs[1]!.id} complete: prepared`); await drain();
    t.current.set(fact().prUrl, fact(1, { needsPreparation: false, readiness: "ready" }));
    await t.service.signal("repair-thread", "idle", `Workstreams job ${result.batch.jobs[0]!.attemptId} complete: prepared`); await drain();
    expect(t.deps.send.mock.calls.at(-1)?.[0]).toBe("thread");
    expect(t.deps.send.mock.calls.some(([thread]) => thread === "repair-thread")).toBe(false);
    expect(t.service.list()[0]!.jobs[2]!.status).toBe("running");
  });
  it("continues only the exclusive stopped worker and preserves its failed checkout", async () => {
    const t = setup(); const batch = await t.start(); const job = batch.jobs[0]!;
    await t.service.signal("thread", "idle", `Workstreams job ${job.id} complete: blocked`);
    t.deps.repairCandidates.mockResolvedValue({ candidates: [{ id: "thread", title: "Rebasing...", tier: "started", running: false, updatedAt: 0, contextUsed: null, canSpawnChild: true }], recommendation: { mode: "continue", threadId: "thread", reason: "Continue stopped work" } });
    const plan = await t.service.repairPlan(batch.id, job.id);
    expect(plan.candidates[0]!.canContinue).toBe(true);
    const workspaces = t.deps.workspace.mock.calls.length;
    const result = await t.service.repairRun({ token: plan.token, mode: "continue", threadId: "thread", instruction: "Preserve the partial fix" });
    expect(result.threadId).toBe("thread");
    expect(t.deps.workspace).toHaveBeenCalledTimes(workspaces);
    expect(t.deps.send.mock.calls[0]?.[1]).toContain("preserve unfinished changes");
    expect(t.deps.repairSpawn).not.toHaveBeenCalled();
  });
  it("can repair a failed item after its original queue was stopped", async () => {
    const t = setup(); const batch = await t.start(); const job = batch.jobs[0]!;
    await t.service.signal("thread", "idle", `Workstreams job ${job.id} complete: blocked`);
    t.service.cancel(batch.id);
    const plan = await t.service.repairPlan(batch.id, job.id);
    await t.service.repairRun({ token: plan.token, mode: "new", threadId: null, instruction: "" });
    expect(t.deps.repairSpawn).toHaveBeenCalledTimes(1);
    expect(t.service.list()[0]!.jobs[0]!.status).toBe("running");
  });

  it("does not hand off an older failure while a newer batch owns that PR", async () => {
    const t = setup(); const old = await t.start();
    await t.service.signal("thread", "idle", `Workstreams job ${old.jobs[0]!.id} complete: blocked`);
    const newer = await t.start();
    expect(newer.id).not.toBe(old.id);
    await expect(t.service.repairPlan(old.id, old.jobs[0]!.id)).rejects.toThrow("Another batch");
    expect(t.deps.repairSpawn).not.toHaveBeenCalled();
  });
  it("starts a fresh repository worker when the stopped previous worker is unusable", async () => {
    const t = setup([fact(1), fact(2)]); const batch = await t.start();
    await t.service.signal("thread", "failed");
    t.deps.thread.mockResolvedValue({ status: "error", archivedAt: null, deletedAt: null, output: "" });
    await t.service.recheck(batch.id); await drain();
    expect(t.deps.spawn).toHaveBeenCalledTimes(2);
    expect(t.deps.send).not.toHaveBeenCalled();
    expect(t.service.list()[0]!.jobs[1]).toMatchObject({ status: "running", uncertain: false });
  });
  it("treats a parent disappearing during workspace creation as a definite pre-send refusal", async () => {
    const t = setup(); const batch = await t.start(); const job = batch.jobs[0]!;
    await t.service.signal("thread", "idle", `Workstreams job ${job.id} complete: blocked`);
    const plan = await t.service.repairPlan(batch.id, job.id);
    t.deps.workspace.mockImplementation(async () => {
      t.deps.repairCandidates.mockResolvedValue({ candidates: [], recommendation: { mode: "new", threadId: null, reason: "Parent disappeared" } });
      return { path: "/new/path", workerPath: "/new" };
    });
    await expect(t.service.repairRun({ token: plan.token, mode: "subthread", threadId: "author", instruction: "" })).rejects.toThrow("parent");
    expect(t.service.list()[0]!.jobs[0]).toMatchObject({ status: "needs-attention", uncertain: false, previousAttempts: [] });
    expect(t.deps.repairSpawn).not.toHaveBeenCalled();
  });
  it("recovers a repair launch by its new attempt ID without repeating the write", async () => {
    const t = setup(); const batch = await t.start(); const job = batch.jobs[0]!;
    await t.service.signal("thread", "idle", `Workstreams job ${job.id} complete: blocked`);
    const plan = await t.service.repairPlan(batch.id, job.id);
    t.deps.repairSpawn.mockRejectedValue(new Error("reply lost"));
    await expect(t.service.repairRun({ token: plan.token, mode: "new", threadId: null, instruction: "" })).rejects.toThrow("reply lost");
    const attempt = t.service.list()[0]!.jobs[0]!.attemptId!;
    const restored = createAdvanceService(t.db, t.deps);
    t.deps.recover.mockResolvedValue(["repair-thread"]);
    t.deps.thread.mockResolvedValue({ status: "idle", archivedAt: null, deletedAt: null, output: `Workstreams job ${attempt} complete: prepared` });
    t.current.set(job.prUrl, fact(1, { needsPreparation: false, readiness: "ready" }));
    await restored.recheck(batch.id);
    expect(t.deps.recover).toHaveBeenCalledWith(attempt, "project");
    expect(restored.list()[0]!.jobs[0]).toMatchObject({ status: "ready", uncertain: false });
    expect((await restored.repairRun({ token: plan.token, mode: "new", threadId: null, instruction: "" })).threadId).toBe("repair-thread");
    expect(t.deps.repairSpawn).toHaveBeenCalledTimes(1);
  });
  it("requires completion evidence for a repair whose fresh PR only needs validation", async () => {
    const t = setup([fact(1, { needsPreparation: false, readiness: "ready" })]); const batch = await t.start();
    t.service.invalidate([{ url: fact().prUrl, reviewDecision: "CHANGES_REQUESTED" }]);
    const plan = await t.service.repairPlan(batch.id, batch.jobs[0]!.id);
    const result = await t.service.repairRun({ token: plan.token, mode: "new", threadId: null, instruction: "Investigate the earlier validation failure" });
    const job = result.batch.jobs[0]!;
    expect(t.deps.repairSpawn.mock.calls[0]?.[2]).toContain("including validation or CI failures");
    await t.service.signal("repair-thread", "idle", `Workstreams job ${job.attemptId} complete: blocked`);
    await t.service.recheck(batch.id);
    expect(t.service.list()[0]!.jobs[0]!.status).toBe("needs-attention");
  });

  it("persists a new repair identity before workspace IO and never recovers the old worker after interruption", async () => {
    const t = setup(); const batch = await t.start(); const oldJobId = batch.jobs[0]!.id;
    await t.service.signal("thread", "idle", `Workstreams job ${oldJobId} complete: blocked`);
    const plan = await t.service.repairPlan(batch.id, oldJobId);
    let finishWorkspace!: (value: { path: string; workerPath: string }) => void;
    t.deps.workspace.mockImplementation(() => new Promise((resolve) => { finishWorkspace = resolve; }));
    const launching = t.service.repairRun({ token: plan.token, mode: "new", threadId: null, instruction: "" });
    const interrupted = expect(launching).rejects.toThrow("interrupted");
    await drain();
    const attempt = t.service.list()[0]!.jobs[0]!.attemptId;
    expect(attempt).toBeTruthy();
    expect(attempt).not.toBe(oldJobId);
    expect(t.service.list()[0]!.jobs[0]).toMatchObject({ threadId: null, path: null, dedicated: true, status: "launching" });
    expect(t.service.list()[0]!.jobs[0]!.previousAttempts[0]).toMatchObject({ attemptId: oldJobId, threadId: "thread" });
    t.service.dispose();
    t.deps.recover.mockImplementation(async (id?: string) => id === oldJobId ? ["thread"] : []);
    t.deps.thread.mockResolvedValue({ status: "idle", archivedAt: null, deletedAt: null, output: `Workstreams job ${oldJobId} complete: prepared` });
    const restored = createAdvanceService(t.db, t.deps);
    await restored.tick(true);
    expect(t.deps.recover).toHaveBeenCalledWith(attempt, "project");
    await restored.signal("thread", "idle", `Workstreams job ${oldJobId} complete: prepared`);
    expect(restored.list()[0]!.jobs[0]).toMatchObject({ attemptId: attempt, threadId: null, status: "needs-attention", uncertain: true });
    finishWorkspace({ path: "/interrupted/workspace", workerPath: "/interrupted" });
    await interrupted;
    // A late response from the disposed runtime cannot overwrite reconciliation.
    const persisted = createAdvanceService(t.db, t.deps);
    expect(persisted.list()[0]!.jobs[0]).toMatchObject({ attemptId: attempt, threadId: null, status: "needs-attention" });
    expect(t.deps.repairSpawn).not.toHaveBeenCalled();
    expect(t.deps.send).not.toHaveBeenCalled();
  });

});
