import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import type { AdvanceFacts } from "./advance-contract.js";
import type { AdvanceBatch, AdvancePreview, AdvanceRepairPlan } from "./bulk-advance.js";
import { parsePrList } from "./gh.js";
import plugin from "./server.js";

const PATH = "/p/widget-checkout";
const HOST = "host-example";
const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

async function setup(options: { remoteOnly?: boolean; mixedCase?: boolean; ready?: boolean; fork?: boolean; omitLaunchedThreadsFromList?: boolean; feedback?: "threads" | "approval-note"; failFirstWorkspace?: boolean; author?: boolean; terminal?: "MERGED" | "CLOSED"; savedBatch?: { id: string; body: string } } = {}) {
  const repo = options.mixedCase ? "Example/Widget" : "example/widget";
  const url = `https://github.com/${repo}/pull/42`;
  const pr = { ...parsePrList(JSON.stringify([{ number: 42, url, state: options.terminal ?? "OPEN", title: "ABC-42 Fix account lookup", reviewDecision: "APPROVED",
    isDraft: false, headRefName: "abc-42-lookup", baseRefName: "main", headRefOid: HEAD, baseRefOid: BASE, mergeStateStatus: options.ready ? "CLEAN" : "DIRTY",
    mergeable: options.ready ? "MERGEABLE" : "CONFLICTING", statusCheckRollup: [{ conclusion: "SUCCESS" }], latestReviews: [], reviewRequests: [] }]))!.pr,
    unresolvedReviewThreads: options.feedback === "threads" ? 1 : 0, resolvedReviewThreads: 0 };
  const unit: RawUnit = { path: PATH, dirName: "widget-checkout", repo: "Widget", githubRepo: repo, branch: options.remoteOnly ? "main" : "abc-42-lookup",
    dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: options.remoteOnly ? null : pr,
    shipped: null, changedPaths: [], observed: { status: true, pr: true } };
  const facts: AdvanceFacts = { prUrl: url, number: 42, title: pr.title, repo, headRefName: "abc-42-lookup", baseRefName: "main", headOid: HEAD, baseOid: BASE,
    state: options.terminal ?? "OPEN", isDraft: false, isCrossRepository: options.fork ?? false, reviewDecision: "APPROVED", mergeStateStatus: options.ready ? "CLEAN" : "DIRTY",
    mergeable: options.ready ? "MERGEABLE" : "CONFLICTING", needsPreparation: !options.ready, readiness: options.terminal === "MERGED" ? "merged" : options.terminal === "CLOSED" ? "closed" : options.ready && !options.feedback ? "ready" : "needs-attention",
    detail: options.feedback ? "Review feedback needs attention" : options.ready ? "Approved and ready to merge" : "Resolve branch conflicts",
    unresolvedThreads: options.feedback === "threads" ? 1 : 0, checks: "passed", basePrNumber: null, approvalNotePending: options.feedback === "approval-note" };
  const calls: { method: string; input: unknown }[] = [];
  const beforeWorkspace = vi.fn(async () => {});
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  if (options.author) threads.set("thr-author", makeThreadResponse({ id: "thr-author", title: "ABC-42 Fix account lookup", projectId: "project-example", status: "idle" }));
  const blockedParents = new Set<string>();
  let spawned = 0, workspaces = 0;
  const spawn = vi.fn(async (args: Record<string, any>) => {
    const thread = makeThreadResponse({ id: ++spawned === 1 ? "thr-rebasing" : `thr-repair-${spawned}`, projectId: args.projectId, title: args.title, status: "active" });
    threads.set(thread.id, thread); return thread;
  });
  const send = vi.fn(async () => ({} as never));
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-example", name: "Example", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => (options.omitLaunchedThreadsFromList ? [] : [...threads.values()]) as never, spawn, send,
      get: async ({ threadId }: { threadId: string }) => ({ ...threads.get(threadId)!, canSpawnChild: !blockedParents.has(threadId) }) as never,
      getPluginMetadata: async () => ({}) as never, output: async () => ({ output: "" }),
      context: async () => ({ usage: null }) as never, events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: async ({ method, input }) => {
    calls.push({ method, input });
    if (method === "scan" || method === "inspectPaths") return { units: [unit], warnings: [] };
    if (method === "authoredPrs") return { owners: [repo.split("/")[0]], entries: pr.state === "OPEN" ? [{ repo, pr }] : [], discoveryComplete: true,
      repositories: [{ repo, complete: true }], complete: true, warnings: [] };
    if (method === "advanceInspect") return { ok: true, facts };
    if (method === "inspectPrs") return facts.state === "OPEN"
      ? { entries: [{ repo, pr }], closed: [], failed: [], warnings: [] }
      : { entries: [], closed: [url], failed: [], warnings: [] };
    if (method === "advanceWorkspace") {
      await beforeWorkspace();
      workspaces++;
      if (options.failFirstWorkspace && workspaces === 1) return { ok: false, error: "The fetched PR base changed. No checkout was created." };
      return { ok: true, path: `/synthetic/workstreams/batch/repo/${workspaces === 1 ? "job" : (input as { jobId: string }).jobId}`, workerPath: "/synthetic/workstreams/batch/repo", sourcePath: PATH, created: true };
    }
    throw new Error(`Unexpected host method ${method}`);
  } });
  if (options.savedBatch) {
    const db = bb.storage.database();
    db.prepare("CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();
    db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(options.savedBatch.id, options.savedBatch.body);
  }
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { harness, calls, spawn, send, facts, pr, url, threads, blockedParents, beforeWorkspace, savedBatch: (id: string) => bb.storage.database().prepare("SELECT id, body FROM advance_batches WHERE id = ?").get(id) as { id: string; body: string }, preview: async (prUrl = url) => await harness.callRpc("advance_preview", { prUrls: [prUrl] }) as AdvancePreview };
}

async function failedBatch(env: Awaited<ReturnType<typeof setup>>) {
  const batch = await env.harness.callRpc("advance_start", { token: (await env.preview()).token }) as AdvanceBatch;
  await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "needs-attention" }] }]));
  return { batchId: batch.id, jobId: batch.jobs[0]!.id };
}

describe("bulk advance server integration", () => {
  it("automatically retires a saved failed item when complete discovery loses its merged PR", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const env = await setup({ remoteOnly: true, failFirstWorkspace: true });
    await failedBatch(env);
    env.pr.state = "MERGED";
    Object.assign(env.facts, { state: "MERGED", readiness: "merged", detail: "GitHub confirms this PR merged" });
    await env.harness.runCli(["refresh"]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "merged", hiddenFromProgress: true }] }]);
    const inspections = env.calls.filter((call) => call.method === "inspectPrs").length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(env.calls.filter((call) => call.method === "inspectPrs")).toHaveLength(inspections);
    expect(env.spawn).not.toHaveBeenCalled();
  });
  it("reconciles a saved item missing from inventory once on startup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const previous = await setup({ remoteOnly: true, failFirstWorkspace: true });
    const ids = await failedBatch(previous);
    const savedBatch = previous.savedBatch(ids.batchId);
    await previous.harness.lifecycle.dispose();
    const env = await setup({ remoteOnly: true, terminal: "CLOSED", savedBatch });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "closed", hiddenFromProgress: true }] }]);
    expect(env.calls.filter((call) => call.method === "inspectPrs")).toHaveLength(1);
    expect(env.spawn).not.toHaveBeenCalled();
  });
  it("blocks Advance if Hold arrives while the separate checkout is being prepared", async () => {
    const env = await setup();
    env.beforeWorkspace.mockImplementationOnce(async () => { await env.harness.callRpc("pr_hold_set", { prUrl: env.url, held: true }); });
    const batch = await env.harness.callRpc("advance_start", { token: (await env.preview()).token }) as AdvanceBatch;
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ id: batch.id, jobs: [{ status: "needs-attention", uncertain: false, detail: expect.stringContaining("On hold") }] }]));
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.send).not.toHaveBeenCalled();
  });
  it("does not stop a worker that was already running when a PR is held", async () => {
    const env = await setup();
    await env.harness.callRpc("advance_start", { token: (await env.preview()).token });
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledOnce());
    await env.harness.callRpc("pr_hold_set", { prUrl: env.url, held: true });
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "running", threadId: "thr-rebasing" }] }]);
    expect(env.send).not.toHaveBeenCalled();
  });
  it("rechecks a saved failed PR after it leaves tracked inventory and confirms it merged", async () => {
    const env = await setup({ remoteOnly: true, failFirstWorkspace: true });
    const ids = await failedBatch(env);
    env.pr.state = "MERGED";
    Object.assign(env.facts, { state: "MERGED", needsPreparation: false, readiness: "merged", detail: "GitHub confirms this PR merged" });
    await env.harness.runCli(["refresh"]);
    expect(await env.harness.callRpc("board_get", null)).toMatchObject({ prInventory: { entries: [] } });
    expect(await env.harness.callRpc("advance_recheck", ids)).toMatchObject({ jobs: [{ status: "merged", hiddenFromProgress: true }] });
    expect(env.spawn).not.toHaveBeenCalled();
    await expect(env.preview("https://github.com/example/widget/pull/999")).rejects.toThrow("no longer tracked");
  });
  it("excludes held PRs from Advance and invalidates previews when a hold is added", async () => {
    const env = await setup(); const plan = await env.preview();
    await env.harness.callRpc("pr_hold_set", { prUrl: env.url.toUpperCase().replace("HTTPS:", "https:"), held: true, reason: "Await launch decision" });
    expect((await env.preview()).jobs[0]).toMatchObject({ eligible: false, detail: expect.stringContaining("On hold") });
    await expect(env.harness.callRpc("advance_start", { token: plan.token })).rejects.toThrow("changed");
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.calls.some((call) => call.method === "advanceWorkspace")).toBe(false);
  });
  it("allows an explicit repair of a held PR and preserves its hold", async () => {
    const env = await setup({ failFirstWorkspace: true, author: true });
    const ids = await failedBatch(env);
    await env.harness.callRpc("pr_hold_set", { prUrl: env.url, held: true });
    const plan = await env.harness.callRpc("advance_repair_plan", ids) as AdvanceRepairPlan;
    expect(plan.fresh.eligible).toBe(true);
    await env.harness.callRpc("advance_repair_run", { token: plan.token, mode: "new", threadId: null, instruction: "Fix validation only" });
    expect(env.spawn).toHaveBeenCalledOnce();
    expect(await env.harness.callRpc("board_get", null)).toMatchObject({ prHolds: { [env.url]: { reason: "" } } });
  });
  it("removes and restores progress through the RPC without deleting results or launching workers", async () => {
    const env = await setup({ ready: true });
    const batch = await env.harness.callRpc("advance_start", { token: (await env.preview()).token }) as AdvanceBatch;
    const ids = { batchId: batch.id, jobId: batch.jobs[0]!.id };
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "ready", hiddenFromProgress: false }] }]));
    expect(await env.harness.callRpc("advance_progress_visibility", { ...ids, hidden: true })).toMatchObject({ jobs: [{ status: "ready", hiddenFromProgress: true }] });
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ hiddenFromProgress: true }] }]);
    expect(await env.harness.callRpc("advance_recheck", ids)).toMatchObject({ jobs: [{ status: "ready", hiddenFromProgress: false }] });
    expect(await env.harness.callRpc("advance_progress_visibility", { ...ids, hidden: false })).toMatchObject({ jobs: [{ status: "ready", hiddenFromProgress: false }] });
    expect(env.spawn).not.toHaveBeenCalled();
    await expect(env.harness.callRpc("advance_recheck", { ...ids, jobId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow("item is no longer available");
  });
  it("rejects removing an active worker through the progress RPC", async () => {
    const env = await setup();
    const batch = await env.harness.callRpc("advance_start", { token: (await env.preview()).token }) as AdvanceBatch;
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledOnce());
    await expect(env.harness.callRpc("advance_progress_visibility", { batchId: batch.id, jobId: batch.jobs[0]!.id, hidden: true })).rejects.toThrow("reconcile");
  });
  it("previews without writes and routes a remote PR to a separate checkout in the exact matched project", async () => {
    const env = await setup({ remoteOnly: true });
    const plan = await env.preview();
    expect(plan.jobs[0]).toMatchObject({ eligible: true, workspace: "create", needsPreparation: true });
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.calls.some((call) => call.method === "advanceWorkspace")).toBe(false);
    await env.harness.callRpc("advance_start", { token: plan.token });
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    expect(env.calls.find((call) => call.method === "advanceWorkspace")?.input).toMatchObject({ sourcePath: PATH, prUrl: env.url, expectedHeadOid: HEAD, expectedBaseOid: BASE });
    expect(env.spawn.mock.calls[0]?.[0]).toMatchObject({ title: "Rebasing...", projectId: "project-example",
      environment: { type: "host", hostId: HOST, workspace: { type: "unmanaged", path: "/synthetic/workstreams/batch/repo" } },
      pluginMetadata: { role: "rebase-worker" } });
    expect(env.spawn.mock.calls[0]?.[0]).not.toHaveProperty("model");
    expect(env.spawn.mock.calls[0]?.[0]).not.toHaveProperty("providerId");
    expect(env.spawn.mock.calls[0]?.[0].prompt).toContain("/synthetic/workstreams/batch/repo/job");
  });

  it("reserves the PR against manual agent and GitHub actions while its worker runs", async () => {
    const env = await setup();
    await env.harness.callRpc("advance_start", { token: (await env.preview()).token });
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    expect(await env.harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Rebase this PR" })).toMatchObject({ ok: false });
    expect(await env.harness.callRpc("action_update_branch", { prUrl: env.url })).toMatchObject({ ok: false });
    expect(await env.harness.callRpc("thread_start", { path: PATH, prompt: "Rebase this PR" })).toMatchObject({ ok: false });
    expect(await env.harness.callRpc("thread_message", { path: PATH, prUrl: env.url, threadId: "thr-author", message: "Rebase this PR" })).toMatchObject({ ok: false });
    expect(env.calls.some((call) => call.method === "prWrite")).toBe(false);
    expect(env.send).not.toHaveBeenCalled();
    expect(env.spawn).toHaveBeenCalledTimes(1);
  });

  it("matches normalized selection URLs to mixed-case GitHub repository identities", async () => {
    const env = await setup({ mixedCase: true, remoteOnly: true });
    expect((await env.preview(env.url.toLowerCase())).jobs[0]).toMatchObject({ eligible: true, prUrl: env.url });
  });

  it("keeps a newly launched author thread busy before its lifecycle events reach the board", async () => {
    const env = await setup({ omitLaunchedThreadsFromList: true });
    expect(await env.harness.callRpc("thread_start", { path: PATH, prompt: "Rebase this PR" }))
      .toMatchObject({ ok: true, threadId: "thr-rebasing" });
    // No thread.created or thread.active event is emitted. The scan still has
    // no linked thread, so only the saved per-PR launch reference can guard it.
    expect((await env.preview()).jobs[0]).toMatchObject({ eligible: false, detail: "Another action or batch already owns this PR" });
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.calls.some((call) => call.method === "advanceWorkspace")).toBe(false);
  });

  it("verifies an already-ready fork without provisioning or starting a writer", async () => {
    const env = await setup({ ready: true, fork: true, remoteOnly: true });
    const plan = await env.preview();
    expect(plan.jobs[0]).toMatchObject({ eligible: true, needsPreparation: false, needsFeedback: false });
    await env.harness.callRpc("advance_start", { token: plan.token });
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "ready", checkedHeadOid: HEAD }] }]));
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.calls.some((call) => call.method === "advanceWorkspace")).toBe(false);
  });

  it.each(["threads", "approval-note"] as const)("launches feedback-only %s work even when the approved branch is clean", async (feedback) => {
    const env = await setup({ ready: true, remoteOnly: true, feedback });
    const plan = await env.preview();
    expect(plan.jobs[0]).toMatchObject({ eligible: true, needsPreparation: false, needsFeedback: true, workspace: "create", detail: env.facts.detail });
    await env.harness.callRpc("advance_start", { token: plan.token });
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    expect(env.calls.find((call) => call.method === "advanceWorkspace")?.input).toMatchObject({ sourcePath: PATH, prUrl: env.url, expectedHeadOid: HEAD, expectedBaseOid: BASE });
    expect(env.spawn.mock.calls[0]?.[0]).toMatchObject({ title: "Rebasing...", projectId: "project-example",
      environment: { type: "host", hostId: HOST, workspace: { type: "unmanaged", path: "/synthetic/workstreams/batch/repo" } } });
  });

  it.each(["threads", "approval-note"] as const)("skips fork %s feedback instead of silently treating it as verify-only", async (feedback) => {
    const env = await setup({ ready: true, remoteOnly: true, fork: true, feedback });
    expect((await env.preview()).jobs[0]).toMatchObject({ eligible: false, needsPreparation: false, needsFeedback: true, detail: expect.stringContaining("Fork PRs") });
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.calls.some((call) => call.method === "advanceWorkspace")).toBe(false);
  });

  it("preserves the current approval blocker when completed feedback work needs a new review", async () => {
    const env = await setup({ ready: true, remoteOnly: true, feedback: "threads" });
    const batch = await env.harness.callRpc("advance_start", { token: (await env.preview()).token }) as AdvanceBatch;
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    const pushedHead = "c".repeat(40);
    Object.assign(env.facts, { headOid: pushedHead, unresolvedThreads: 0, reviewDecision: "REVIEW_REQUIRED", readiness: "waiting-review", detail: "Waiting for approval on the current PR." });
    Object.assign(env.pr, { headRefOid: pushedHead, unresolvedReviewThreads: 0, reviewDecision: "REVIEW_REQUIRED" });
    await env.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr-rebasing", status: "idle" }),
      lastAssistantText: `Result: Feedback addressed and validated.\nWorkstreams job ${batch.jobs[0]!.id} complete: prepared`,
    });
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{
      status: "waiting-review", checkedHeadOid: pushedHead, detail: "Waiting for approval on the current PR.",
    }] }]));
  });

  it("previews a failed remote item without writes and repairs it after approval was dismissed", async () => {
    const env = await setup({ remoteOnly: true, feedback: "threads", failFirstWorkspace: true });
    const ids = await failedBatch(env);
    env.facts.reviewDecision = "REVIEW_REQUIRED";
    env.facts.readiness = "waiting-review";
    const plan = await env.harness.callRpc("advance_repair_plan", ids) as AdvanceRepairPlan;
    expect(plan.fresh).toMatchObject({ eligible: true, needsFeedback: true });
    expect(env.calls.filter((call) => call.method === "advanceWorkspace")).toHaveLength(1);
    expect(env.spawn).not.toHaveBeenCalled();
    const result = await env.harness.callRpc("advance_repair_run", { token: plan.token, mode: "new", threadId: null, instruction: "Address the remaining feedback and reply." }) as { batch: AdvanceBatch; threadId: string };
    expect(result.batch.jobs[0]).toMatchObject({ status: "running", dedicated: true, threadId: result.threadId });
    const request = env.spawn.mock.calls[0]![0];
    expect(request).toMatchObject({ projectId: "project-example", title: "widget #42: repair review feedback",
      environment: { type: "host", hostId: HOST, workspace: { type: "unmanaged", path: "/synthetic/workstreams/batch/repo" } },
      pluginMetadata: { role: "advance-repair", advanceJobId: result.batch.jobs[0]!.attemptId, prUrl: env.url } });
    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("parentThreadId");
    expect(result.batch.jobs[0]!.attemptId).not.toBe(ids.jobId);
    expect(request.prompt).toContain("Address the remaining feedback and reply.");
    expect(request.prompt).toContain("do not reset");
  });

  it("offers a linked author as a parent and rejects arbitrary parent IDs", async () => {
    const env = await setup({ feedback: "threads", failFirstWorkspace: true, author: true });
    const plan = await env.harness.callRpc("advance_repair_plan", await failedBatch(env)) as AdvanceRepairPlan;
    expect(plan.candidates).toContainEqual(expect.objectContaining({ id: "thr-author", canSpawnChild: true, canContinue: false }));
    await expect(env.harness.callRpc("advance_repair_run", { token: plan.token, mode: "subthread", threadId: "thr-unrelated", instruction: "Fix remaining comments" })).rejects.toThrow();
    expect(env.spawn).not.toHaveBeenCalled();
    await env.harness.callRpc("advance_repair_run", { token: plan.token, mode: "subthread", threadId: "thr-author", instruction: "Fix remaining comments" });
    expect(env.spawn.mock.calls[0]![0]).toMatchObject({ parentThreadId: "thr-author", projectId: "project-example", pluginMetadata: { role: "advance-repair" } });
    expect(env.spawn.mock.calls[0]![0].prompt).toContain("@thread:thr-author");
  });

  it("revalidates a parent's child capability before launching the repair", async () => {
    const env = await setup({ failFirstWorkspace: true, author: true });
    const plan = await env.harness.callRpc("advance_repair_plan", await failedBatch(env)) as AdvanceRepairPlan;
    env.blockedParents.add("thr-author");
    await expect(env.harness.callRpc("advance_repair_run", { token: plan.token, mode: "subthread", threadId: "thr-author", instruction: "Fix the failure" })).rejects.toThrow();
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.calls.filter((call) => call.method === "advanceWorkspace")).toHaveLength(2);
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "needs-attention", uncertain: false, threadId: null }] }]);
  });

  it("refuses a competing repair while the linked author is actively working", async () => {
    const env = await setup({ failFirstWorkspace: true, author: true });
    const ids = await failedBatch(env);
    env.threads.set("thr-author", { ...env.threads.get("thr-author")!, status: "active" });
    await expect(env.harness.callRpc("advance_repair_plan", ids)).rejects.toThrow(/Another writer/u);
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it.each(["closed", "draft", "fork"] as const)("refuses %s repairs even when the remaining task has no branch or feedback flag", async (blocker) => {
    const env = await setup({ failFirstWorkspace: true });
    const ids = await failedBatch(env);
    Object.assign(env.facts, { needsPreparation: false, unresolvedThreads: 0, approvalNotePending: false, readiness: "ready", detail: "Current state needs attention" });
    if (blocker === "closed") env.facts.state = "CLOSED";
    if (blocker === "draft") env.facts.isDraft = true;
    if (blocker === "fork") env.facts.isCrossRepository = true;
    await expect(env.harness.callRpc("advance_repair_plan", ids)).rejects.toThrow();
    expect(env.spawn).not.toHaveBeenCalled();
  });
});
