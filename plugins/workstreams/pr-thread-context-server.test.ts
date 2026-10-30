// PR thread links and sends through the real server on BB's fake host.
// Every project, PR, checkout, and thread in this file is synthetic.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import { createRunStore } from "./runstore.js";
import plugin, { type Board } from "./server.js";

const HOST = "host-inkwell";
const PROJECT = "proj-inkwell";
const PATH = "/p/folio-abc-42";
const REPO = "inkwell/folio";
const URL = "https://github.com/inkwell/folio/pull/42";
const NEXT_URL = "https://github.com/inkwell/folio/pull/43";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function pr(number: number, state: "OPEN" | "MERGED" = "OPEN") {
  return parsePrList(JSON.stringify([{ number, url: `https://github.com/${REPO}/pull/${number}`, state,
    title: `ABC-${number} Improve manuscript review`, headRefName: `abc-${number}-review`,
    baseRefName: "main", reviewDecision: "APPROVED" }]))!.pr;
}

async function setup(options: { remoteOnly?: boolean; state?: "OPEN" | "MERGED"; metadata?: Record<string, Record<string, unknown>>;
  initialThreads?: { id: string; title: string; status?: "active" | "idle" }[] } = {}) {
  const currentPr = pr(42, options.state);
  const raw: RawUnit = { path: PATH, dirName: "folio-abc-42", repo: REPO, githubRepo: REPO,
    branch: "abc-42-review", dirty: false, ahead: 0, behind: 0, lastCommitAt: null,
    defaultBranch: "main", pr: options.remoteOnly ? null : currentPr, shipped: null,
    changedPaths: ["src/review.ts"], observed: { status: true, pr: true } };
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const add = (id: string, patch: Record<string, unknown> = {}) => {
    const row = makeThreadResponse({ id, projectId: PROJECT, title: id, status: "idle", providerId: "codex", environmentPath: null, ...patch } as never);
    threads.set(id, row);
    return row;
  };
  for (const row of options.initialThreads ?? []) add(row.id, { title: row.title, status: row.status ?? "idle" });
  const send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
  const output = vi.fn(async () => ({ output: null as string | null }));
  const spawn = vi.fn(async () => add("thr-unexpected"));
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: PROJECT, name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => [...threads.values()] as never,
      get: async ({ threadId }: { threadId: string }) => {
        const row = threads.get(threadId);
        if (!row) throw new Error("Unknown synthetic thread");
        return { ...row, canSpawnChild: true } as never;
      },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (options.metadata?.[threadId] ?? {}) as never,
      spawn, send, output, context: async () => ({ usage: null }) as never,
      events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [raw], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [{ repo: REPO, pr: currentPr }, { repo: REPO, pr: pr(43) }],
      discoveryComplete: true, repositories: [{ repo: REPO, complete: true }], complete: true, warnings: [] };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const effortStore = createEffortStore(bb.storage.database() as never);
  const effort = effortStore.establish({ sourceKey: "ticket:ABC-42", name: "Improve manuscript review", goal: "Make manuscript review reliable",
    projectId: PROJECT, members: { tickets: ["ABC-42"], prUrls: [URL, NEXT_URL] } });
  const links = async (url = URL) => (await harness.callRpc("board_get", null) as Board).prThreadLinks[url] ?? [];
  const message = async (threadId: string, url = URL) => await harness.callRpc("thread_message", { prUrl: url, threadId, message: "Check this PR" });
  return { bb, harness, threads, add, send, spawn, effortStore, effort, links, message };
}

describe("PR thread links and messaging", () => {
  it("sends to the effort's current repository controller, linked through its effort, and launches nothing", async () => {
    const env = await setup();
    env.add("thr-coordinator", { title: "🧭 Manuscript review" });
    env.add("thr-repo", { title: "📦 inkwell/folio", parentThreadId: "thr-coordinator", environment: { hostId: HOST } });
    env.add("thr-pr", { title: "Review fixes" });
    env.effortStore.save({ ...env.effort, coordinatorThreadId: "thr-coordinator", coordinatorState: "ready" });
    const claimed = env.effortStore.claimRepoController({ effortId: env.effort.id, repo: REPO, projectId: PROJECT, hostId: HOST });
    env.effortStore.saveRepoController({ ...claimed.record, threadId: "thr-repo", state: "ready" });
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");

    expect(await env.message("thr-repo")).toEqual({ ok: true, delivery: "sent" });
    expect(env.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr-repo" }));
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it("includes an explicitly linked remote PR thread and sends without a checkout path", async () => {
    const env = await setup({ remoteOnly: true, metadata: { "thr-remote": { linkedPrUrl: URL } },
      initialThreads: [{ id: "thr-remote", title: "Remote PR author" }] });
    await vi.waitFor(async () => expect(await env.links()).toEqual(["thr-remote"]));
    expect(await env.message("thr-remote")).toEqual({ ok: true, delivery: "sent" });
    expect(env.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr-remote", model: "gpt-6-sol", reasoningLevel: "high" }));
    expect(await env.harness.callRpc("runs_open", null)).toEqual([
      expect.objectContaining({ path: "", prUrl: URL, threadId: "thr-remote" }),
    ]);
  });

  it("sends PR turns only to a thread on the configured code-work provider, with its configured model", async () => {
    const env = await setup({ remoteOnly: true, metadata: { "thr-remote": { linkedPrUrl: URL } },
      initialThreads: [{ id: "thr-remote", title: "Remote PR author" }] });
    await vi.waitFor(async () => expect(await env.links()).toEqual(["thr-remote"]));
    await env.harness.behavior.setSettings({ codeModel: "claude-code/claude-opus/high" });
    expect(await env.message("thr-remote")).toEqual({ ok: false,
      error: "This thread runs on codex, not the configured claude-code provider. Message it in its own thread, or set the Code-work model to a codex model; nothing was sent." });
    expect(env.send).not.toHaveBeenCalled();
    expect(await env.harness.callRpc("runs_open", null)).toEqual([]);
    await env.harness.behavior.setSettings({ codeModel: "codex/gpt-6-sol/xhigh" });
    expect(await env.message("thr-remote")).toEqual({ ok: true, delivery: "sent" });
    expect(env.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr-remote", model: "gpt-6-sol", reasoningLevel: "xhigh" }));
  });

  it("keeps an Advance worker linked by PR metadata after its batch history is gone", async () => {
    const env = await setup({ remoteOnly: true,
      metadata: { "thr-advance": { role: "rebase-worker", advanceJobId: "old-job", prUrl: URL } },
      initialThreads: [{ id: "thr-advance", title: "PR worker" }] });
    expect(await env.links()).toContain("thr-advance");
  });

  it("shows one thread's two recorded PRs in both PRs' board indicators", async () => {
    const env = await setup({ remoteOnly: true, initialThreads: [{ id: "thr-shared", title: "Two PR review" }] });
    const runs = createRunStore(env.bb.storage.database());
    for (const [url, number] of [[URL, 42], [NEXT_URL, 43]] as const) runs.begin({ path: PATH, ticket: null,
      prUrl: url, prNumber: number, action: "review", mode: "new", threadId: "thr-shared" });
    expect(await env.links(URL)).toEqual(["thr-shared"]);
    expect(await env.links(NEXT_URL)).toEqual(["thr-shared"]);
  });

  it("keeps an active linked thread visible when more than twenty historical threads exist", async () => {
    const initialThreads = [{ id: "thr-active", title: "Current review", status: "active" as const },
      ...Array.from({ length: 24 }, (_, index) => ({ id: `thr-old-${index}`, title: `Earlier review ${index}`, status: "idle" as const }))];
    const env = await setup({ remoteOnly: true, initialThreads });
    const runs = createRunStore(env.bb.storage.database());
    for (const thread of initialThreads) runs.begin({ path: PATH, ticket: null, prUrl: URL, prNumber: 42,
      action: "review", mode: "new", threadId: thread.id });
    const board = await env.harness.callRpc("board_get", null) as Board;
    expect(board.prThreadLinks[URL]).toHaveLength(20);
    expect(board.prThreadLinks[URL]?.[0]).toBe("thr-active");
  });

  it("refuses new instructions to a merged PR's thread", async () => {
    const env = await setup({ state: "MERGED" });
    env.add("thr-pr", { environmentPath: PATH });
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");
    expect(await env.message("thr-pr")).toMatchObject({ ok: false });
    expect(env.send).not.toHaveBeenCalled();
  });

  it("rejects unrelated, archived, and hidden targets from the send path", async () => {
    const env = await setup();
    env.add("thr-unrelated");
    env.add("thr-archived", { archivedAt: Date.now() });
    env.add("thr-hidden", { visibility: "hidden" });
    env.effortStore.recordWorker(env.effort.id, "thr-archived", URL, "pr");
    env.effortStore.recordWorker(env.effort.id, "thr-hidden", URL, "pr");
    for (const id of ["thr-unrelated", "thr-archived", "thr-hidden"])
      expect(await env.message(id)).toMatchObject({ ok: false });
    expect(env.send).not.toHaveBeenCalled();
  });

  it("rejects sends while the PR is on hold", async () => {
    const env = await setup();
    env.add("thr-pr");
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");
    await env.harness.callRpc("pr_hold_set", { prUrl: URL, held: true, reason: "Waiting for copy review" });
    expect(await env.message("thr-pr")).toMatchObject({ ok: false, error: expect.stringContaining("hold") });
    expect(env.send).not.toHaveBeenCalled();
  });

  it("rejects a competing PR owner but allows a message to that same owner's thread", async () => {
    const env = await setup();
    env.add("thr-pr", { status: "active", environmentPath: PATH });
    env.add("thr-repo");
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");
    const claimed = env.effortStore.claimRepoController({ effortId: env.effort.id, repo: REPO, projectId: PROJECT, hostId: HOST });
    env.effortStore.saveRepoController({ ...claimed.record, threadId: "thr-repo", state: "ready" });
    createRunStore(env.bb.storage.database()).begin({ path: PATH, ticket: "ABC-42", prUrl: URL, prNumber: 42,
      action: "address-review", mode: "continue", threadId: "thr-pr" });
    expect(await env.message("thr-repo")).toMatchObject({ ok: false, error: expect.stringContaining("Another agent") });
    expect(await env.message("thr-pr")).toEqual({ ok: true, delivery: "sent" });
    expect(env.send).toHaveBeenCalledTimes(1);
  });

  it("holds the PR writer lease through an asynchronous send so concurrent requests cannot both deliver", async () => {
    const env = await setup();
    env.add("thr-pr", { environmentPath: PATH });
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");
    let release!: (value: { ok: true; delivery: "sent" }) => void;
    env.send.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = env.message("thr-pr");
    await vi.waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
    const second = await env.message("thr-pr");
    expect(second).toMatchObject({ ok: false, error: expect.stringContaining("owns this PR") });
    release({ ok: true, delivery: "sent" });
    expect(await first).toEqual({ ok: true, delivery: "sent" });
    expect(env.send).toHaveBeenCalledTimes(1);
  });
});
