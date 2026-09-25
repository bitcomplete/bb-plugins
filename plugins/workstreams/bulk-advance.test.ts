import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
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
    busyNow: vi.fn(() => false), busy: vi.fn(async () => false),
    workspace: vi.fn(async (_: AdvanceFacts, _batch: string, id: string) => ({ path: `/isolated/${id}`, workerPath: "/isolated" })),
    spawn: vi.fn(async (_facts: AdvanceFacts, _path: string, _prompt: string, _jobId: string) => "thread"), send: vi.fn(async () => {}),
    thread: vi.fn(async () => ({ status: "idle", archivedAt: null, deletedAt: null, output: "" })),
    recover: vi.fn(async (): Promise<string[]> => []), changed: vi.fn(), verified: vi.fn(), now: () => time,
  };
  const service = createAdvanceService(db, deps);
  const start = async () => { const plan = await service.preview(facts.map((f) => f.prUrl)); const batch = await service.start(plan.token); await drain(); return batch; };
  return { db, deps, service, current, start, time: (value: number) => { time = value; } };
}

describe("finite Advance preparation", () => {
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
  it("invalidates a verified result when fresh observation changes its base", async () => {
    const t = setup([fact(1, { needsPreparation: false, readiness: "ready" })]); await t.start();
    t.service.invalidate([{ url: fact().prUrl, headRefOid: fact().headOid, baseRefOid: "c".repeat(40) }]);
    expect(t.service.list()[0]!.jobs[0]).toMatchObject({ status: "needs-attention", checkedHeadOid: null });
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
});
