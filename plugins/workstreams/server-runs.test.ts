// Run tracking through the real server.ts on BB's fake plugin host: the RPCs
// the Board calls, the thread events BB fires, and the targeted rescan a
// finished run triggers. Every thread, PR and host here is a fake.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import plugin, { type Board, type WireRun } from "./server.js";

const HOST = "host-inkwell";
const PATH = "/p/quill-abc-101";
const PR_URL = "https://github.com/inkwell/quill/pull/42";

function unit(mergeStateStatus: "DIRTY" | "CLEAN"): RawUnit {
  return {
    path: PATH,
    dirName: "quill-abc-101",
    repo: "inkwell/quill",
    branch: "dev/abc-101-gift-card-balance",
    dirty: false,
    ahead: 0,
    behind: 0,
    lastCommitAt: "2026-09-20T10:00:00Z",
    defaultBranch: "main",
    pr: {
      number: 42,
      state: "OPEN",
      isDraft: false,
      reviewDecision: "APPROVED",
      checkConclusions: ["SUCCESS"],
      url: PR_URL,
      title: "Show gift card balance",
      mergeable: mergeStateStatus === "DIRTY" ? "CONFLICTING" : "MERGEABLE",
      baseRefName: "main",
      headRefName: "dev/abc-101-gift-card-balance",
      latestReviewStates: ["APPROVED"],
      mergedAt: null,
      mergeStateStatus,
      reviewRequests: ["inkwell/reviewers"],
      latestReviews: [],
      unresolvedReviewThreads: 0,
      resolvedReviewThreads: 0,
    },
    shipped: null,
    changedPaths: ["src/balance.ts"],
  };
}

const thread = (id: string, status: "active" | "idle" | "error" = "active") => makeThreadResponse({ id, status });

async function load(options: { threads?: unknown[]; prWrite?: (input: unknown) => unknown; rebasing?: boolean; liveRebasing?: boolean; liveBranch?: string | null } = {}) {
  const rpcCalls: { method: string; input: unknown }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "workstreams",
    settings: { scanRoots: "/p" },
    sdk: {
      system: { config: async () => ({ primaryHostId: HOST }) as never },
      projects: { list: async () => [{ id: "proj-inkwell", sources: [{ hostId: HOST, path: "/p" }] }] as never },
      threads: {
        list: async () => (options.threads ?? []) as never,
        spawn: async () => thread("thr-quill-new"),
        get: async ({ threadId }: { threadId: string }) => ({ ...thread(threadId, "idle"), canSpawnChild: true }) as never,
        context: async () => ({ usage: null }) as never,
        send: async () => ({ ok: true, delivery: "sent" }) as never,
        output: async () => ({ output: "Rebased.\nResult: Resolved 2 conflicts and pushed" }),
        getPluginMetadata: async () => ({}) as never,
        events: { list: async () => [] },
        interactions: { list: async () => [] as never },
      },
    },
    experimental_callHostRpc: (call) => {
      rpcCalls.push({ method: call.method, input: call.input });
      if (call.method === "scan") return { units: [{ ...unit("DIRTY"), rebasing: options.rebasing ?? false }], warnings: [] };
      if (call.method === "inspectPaths") return { units: [unit("CLEAN")], warnings: [] };
      if (call.method === "checkoutState") return { ok: true, branch: options.liveBranch === undefined ? unit("DIRTY").branch : options.liveBranch, rebasing: options.liveRebasing ?? false };
      if (call.method === "prReviewers") return { ok: true, reviewers: unit("DIRTY").pr!.reviewRequests };
      if (call.method === "prWrite") return options.prWrite?.(call.input) ?? { ok: true, detail: "Updated the branch of inkwell/quill #42." };
      throw new Error(`unexpected host call ${call.method}`);
    },
  });
  await plugin(bb);
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const open = async () => (await harness.callRpc("runs_open", null)) as WireRun[];
  const board = async () => (await harness.callRpc("board_get", null)) as Board;
  const settle = () => vi.advanceTimersByTimeAsync(0);
  return { harness, rpcCalls, open, board, settle };
}

afterEach(() => vi.useRealTimers());

describe("agent runs through the server", () => {
  it("messages only a thread still linked to the PR row, without creating a synthetic run", async () => {
    const linked = {
      ...thread("thr-quill-author", "idle"),
      environmentPath: PATH,
      environmentBranchName: "dev/abc-101-gift-card-balance",
      hasPendingInteraction: false,
    };
    const { harness, open } = await load({ threads: [linked] });
    expect(await harness.callRpc("thread_message", { path: PATH, prUrl: PR_URL, threadId: "thr-elsewhere", message: "PTAL" })).toMatchObject({ ok: false });
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
    expect(await harness.callRpc("thread_message", { path: PATH, prUrl: "https://github.com/inkwell/quill/pull/99", threadId: "thr-quill-author", message: "PTAL" })).toMatchObject({ ok: false });
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
    expect(await harness.callRpc("thread_message", { path: PATH, prUrl: PR_URL, threadId: "thr-quill-author", message: "Rebase, then post PTAL" })).toEqual({ ok: true, delivery: "sent" });
    expect(harness.sdk.callsTo("threads.send")).toEqual([[expect.objectContaining({ threadId: "thr-quill-author", mode: "auto" })]]);
    expect(await open()).toEqual([]);
  });

  it("records a run as running when the action launches, with the row's ticket and PR", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { harness, open } = await load();
    const result = await harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Fix it." });
    expect(result).toMatchObject({ ok: true, threadId: "thr-quill-new" });
    expect(await open()).toEqual([
      expect.objectContaining({ kind: "agent", action: "resolve-conflicts", status: "running", threadId: "thr-quill-new", ticket: "ABC-101", prNumber: 42, prUrl: PR_URL, mode: "new" }),
    ]);
  });

  it("records nothing when the launch fails, because nothing ran", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { harness, open, board } = await load();
    harness.sdk.stub("projects.list", async () => []);
    const result = await harness.callRpc("agent_run", { path: PATH, action: "investigate-ci", mode: "new", threadId: null, prompt: "Look." });
    expect(result).toMatchObject({ ok: false });
    expect(await open()).toEqual([]);
    expect((await board()).runs).toEqual([]);
  });

  it("follows the thread's events to needs-you, back to running, and done with its Result line, then rescans only that row", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { harness, open, board, rpcCalls, settle } = await load();
    await harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Fix it." });

    await harness.emitThreadEvent("interaction.pending", { thread: thread("thr-quill-new"), interaction: {} as never });
    await settle();
    expect((await open())[0]?.status).toBe("needs-you");

    // Answered: no event says so, but the thread's event sequence advances.
    await harness.emitThreadEvent("experimental_thread.events", { thread: thread("thr-quill-new"), sequence: 9 });
    await settle();
    expect((await open())[0]?.status).toBe("running");

    await harness.emitThreadEvent("thread.idle", {
      thread: thread("thr-quill-new", "idle"),
      lastAssistantText: "Both sides kept.\n**Result:** Resolved 2 conflicts in quill and pushed",
    });
    await settle();
    expect(await open()).toEqual([]);
    const [finished] = (await board()).runs;
    expect(finished).toMatchObject({ status: "done", result: "Resolved 2 conflicts in quill and pushed" });

    expect(rpcCalls.filter((call) => call.method === "inspectPaths")).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(rpcCalls.filter((call) => call.method === "inspectPaths")).toEqual([{ method: "inspectPaths", input: { paths: [PATH] } }]);
    // The row moved on its own: the conflict is gone after the targeted rescan.
    const units = (await board()).groups.flatMap((group) => group.clusters.flatMap((cluster) => cluster.units));
    expect(units.find((entry) => entry.path === PATH)?.pr?.mergeStateStatus).toBe("CLEAN");
    expect(rpcCalls.filter((call) => call.method === "scan")).toHaveLength(1);
  });

  it("reads the final message when a failed thread's event carries none", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { harness, board, settle } = await load();
    await harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Fix it." });
    await harness.emitThreadEvent("thread.failed", { thread: thread("thr-quill-new", "error"), error: "Provider overloaded" });
    await settle();
    expect((await board()).runs[0]).toMatchObject({ status: "failed", error: "Provider overloaded", result: "Resolved 2 conflicts and pushed" });
    expect(harness.sdk.callsTo("threads.output")).toEqual([[{ threadId: "thr-quill-new" }]]);
  });

  it("refuses continue before launching or recording an untrackable shared-thread action", async () => {
    const linked = {
      ...thread("thr-quill-author", "idle"),
      environmentPath: PATH,
      environmentBranchName: "dev/abc-101-gift-card-balance",
      hasPendingInteraction: false,
    };
    const { harness, open } = await load({ threads: [linked] });
    expect(await harness.callRpc("agent_run", { path: PATH, action: "address-comments", mode: "continue", threadId: "thr-quill-author", prompt: "Reply." })).toMatchObject({ ok: false });
    expect(await open()).toEqual([]);
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
  });
});

describe("direct runs through the server", () => {
  it("refuses direct PR actions during a rebase while retaining the PR in the board", async () => {
    const { harness, board, rpcCalls } = await load({ rebasing: true });
    expect((await board()).groups.flatMap((group) => group.clusters).flatMap((cluster) => cluster.units)
      .some((entry) => entry.pr?.url === PR_URL && entry.rebasing)).toBe(true);
    expect(await harness.callRpc("action_merge_preview", { path: PATH })).toMatchObject({ ok: false, error: expect.stringContaining("rebase") });
    expect(await harness.callRpc("action_update_branch", { path: PATH })).toMatchObject({ ok: false, error: expect.stringContaining("rebase") });
    expect(rpcCalls.some((call) => call.method === "prLive" || call.method === "prWrite")).toBe(false);
  });

  it("rechecks the checkout before a direct action when a rebase or branch change starts after the scan", async () => {
    const rebasing = await load({ liveRebasing: true });
    expect(await rebasing.harness.callRpc("action_update_branch", { path: PATH })).toMatchObject({ ok: false, error: expect.stringContaining("rebase") });
    expect(rebasing.rpcCalls.some((call) => call.method === "prWrite")).toBe(false);

    const switched = await load({ liveBranch: "someone-elses-branch" });
    expect(await switched.harness.callRpc("action_update_branch", { path: PATH })).toMatchObject({ ok: false, error: expect.stringContaining("branch changed") });
    expect(switched.rpcCalls.some((call) => call.method === "prWrite")).toBe(false);
  });

  it("records a succeeded direct action with a short reason and rescans its row", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { harness, board, rpcCalls } = await load();
    expect(await harness.callRpc("action_update_branch", { path: PATH })).toMatchObject({ ok: true });
    expect((await board()).runs[0]).toMatchObject({ kind: "direct", action: "update-branch", status: "succeeded", result: "Branch updated", threadId: null });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(rpcCalls.some((call) => call.method === "inspectPaths")).toBe(true);
  });

  it("records a refused direct action as failed with its reason, and does not rescan", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { harness, board, rpcCalls } = await load({ prWrite: () => ({ ok: false, error: "gh: head moved; refused" }) });
    expect(await harness.callRpc("action_update_branch", { path: PATH })).toMatchObject({ ok: false });
    expect((await board()).runs[0]).toMatchObject({ status: "failed", error: "gh: head moved; refused" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(rpcCalls.some((call) => call.method === "inspectPaths")).toBe(false);
  });
});
