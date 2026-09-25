import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import type { AdvanceFacts } from "./advance-contract.js";
import type { AdvanceBatch, AdvancePreview } from "./bulk-advance.js";
import { parsePrList } from "./gh.js";
import plugin from "./server.js";

const PATH = "/p/widget-checkout";
const HOST = "host-example";
const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(options: { remoteOnly?: boolean; mixedCase?: boolean; ready?: boolean; fork?: boolean; omitLaunchedThreadsFromList?: boolean; feedback?: "threads" | "approval-note" } = {}) {
  const repo = options.mixedCase ? "Example/Widget" : "example/widget";
  const url = `https://github.com/${repo}/pull/42`;
  const pr = { ...parsePrList(JSON.stringify([{ number: 42, url, state: "OPEN", title: "ABC-42 Fix account lookup", reviewDecision: "APPROVED",
    isDraft: false, headRefName: "abc-42-lookup", baseRefName: "main", headRefOid: HEAD, baseRefOid: BASE, mergeStateStatus: options.ready ? "CLEAN" : "DIRTY",
    mergeable: options.ready ? "MERGEABLE" : "CONFLICTING", statusCheckRollup: [{ conclusion: "SUCCESS" }], latestReviews: [], reviewRequests: [] }]))!.pr,
    unresolvedReviewThreads: options.feedback === "threads" ? 1 : 0, resolvedReviewThreads: 0 };
  const unit: RawUnit = { path: PATH, dirName: "widget-checkout", repo: "Widget", githubRepo: repo, branch: options.remoteOnly ? "main" : "abc-42-lookup",
    dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: options.remoteOnly ? null : pr,
    shipped: null, changedPaths: [], observed: { status: true, pr: true } };
  const facts: AdvanceFacts = { prUrl: url, number: 42, title: pr.title, repo, headRefName: "abc-42-lookup", baseRefName: "main", headOid: HEAD, baseOid: BASE,
    state: "OPEN", isDraft: false, isCrossRepository: options.fork ?? false, reviewDecision: "APPROVED", mergeStateStatus: options.ready ? "CLEAN" : "DIRTY",
    mergeable: options.ready ? "MERGEABLE" : "CONFLICTING", needsPreparation: !options.ready, readiness: options.ready && !options.feedback ? "ready" : "needs-attention",
    detail: options.feedback ? "Review feedback needs attention" : options.ready ? "Approved and ready to merge" : "Resolve branch conflicts",
    unresolvedThreads: options.feedback === "threads" ? 1 : 0, checks: "passed", basePrNumber: null, approvalNotePending: options.feedback === "approval-note" };
  const calls: { method: string; input: unknown }[] = [];
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const spawn = vi.fn(async (args: Record<string, any>) => {
    const thread = makeThreadResponse({ id: "thr-rebasing", projectId: args.projectId, title: args.title, status: "active" });
    threads.set(thread.id, thread); return thread;
  });
  const send = vi.fn(async () => ({} as never));
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-example", name: "Example", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => (options.omitLaunchedThreadsFromList ? [] : [...threads.values()]) as never, spawn, send,
      get: async ({ threadId }: { threadId: string }) => ({ ...threads.get(threadId)!, canSpawnChild: true }) as never,
      getPluginMetadata: async () => ({}) as never, output: async () => ({ output: "" }),
      context: async () => ({ usage: null }) as never, events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: ({ method, input }) => {
    calls.push({ method, input });
    if (method === "scan" || method === "inspectPaths") return { units: [unit], warnings: [] };
    if (method === "authoredPrs") return { owners: [repo.split("/")[0]], entries: [{ repo, pr }], discoveryComplete: true,
      repositories: [{ repo, complete: true }], complete: true, warnings: [] };
    if (method === "advanceInspect") return { ok: true, facts };
    if (method === "advanceWorkspace") return { ok: true, path: "/synthetic/workstreams/batch/repo/job", workerPath: "/synthetic/workstreams/batch/repo", sourcePath: PATH, created: true };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { harness, calls, spawn, send, facts, pr, url, preview: async (prUrl = url) => await harness.callRpc("advance_preview", { prUrls: [prUrl] }) as AdvancePreview };
}

describe("bulk advance server integration", () => {
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
});
