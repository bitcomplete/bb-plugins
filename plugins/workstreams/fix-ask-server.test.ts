// Asking threads to fix the PRs in an effort's Work in threads section, through the real server on BB's fake host: the deck's listing, its
// Undo window, each PR's own fix sent to its existing thread, and a bounded Sol worker under the effort's parent only for a PR with none.
// Every name here is synthetic.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import type { BatchItem, DeckBatch } from "./deck-batch.js";
import type { DeckView } from "./deck.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const PROJECT = "proj-inkwell";
const REPO = "inkwell/folio";
const PATH = "/p/folio-abc-44";
const HEAD = "a".repeat(40);
const url = (number: number) => `https://github.com/${REPO}/pull/${number}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

const pr = (number: number, extra: Record<string, unknown> = {}): Pr => ({ ...parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN",
  title: `ABC-${number} Keep manuscripts in order`, isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `abc-${number}-order`, baseRefName: "main", headRefOid: HEAD, latestReviews: [], reviewRequests: [{ login: "mira" }],
  statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), ...extra }]))!.pr,
  unresolvedReviewThreads: 0, resolvedReviewThreads: 0 });

/**
 * Manuscript review owns three of your PRs: #42 conflicts and fails CI, and its thread "Order fixes" worked on it; #44 has requested
 * changes and only a checkout; #43 waits on mira's review.
 */
async function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const current = new Map<number, Pr>([
    [42, pr(42, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", statusCheckRollup: [{ conclusion: "FAILURE" }] })],
    [43, pr(43)],
    [44, pr(44, { reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ author: { login: "mira" }, state: "CHANGES_REQUESTED",
      submittedAt: new Date(Date.now() - 86_400_000).toISOString() }], reviewRequests: [] })],
  ]);
  const raw: RawUnit = { path: PATH, dirName: "folio-abc-44", repo: REPO, githubRepo: REPO, branch: "abc-44-order", dirty: false, ahead: 0, behind: 0,
    lastCommitAt: null, defaultBranch: "main", pr: current.get(44)!, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const add = (id: string, patch: Record<string, unknown> = {}) => {
    const row = makeThreadResponse({ id, projectId: PROJECT, title: id, status: "idle", providerId: "codex", environmentPath: null, ...patch } as never);
    threads.set(id, row);
    return row;
  };
  add("thr-pr", { title: "Order fixes" });
  const send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
  const spawn = vi.fn(async (args: { parentThreadId?: string }) => add("thr-new", { title: "Fix requested changes", parentThreadId: args.parentThreadId ?? null }));
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
      getPluginMetadata: async () => ({}) as never,
      spawn: spawn as never, send, output: async () => ({ output: null }), context: async () => ({ usage: null }) as never,
      events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: ({ method, input }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [raw], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [...current.values()].map((entry) => ({ repo: REPO, pr: entry })),
      discoveryComplete: true, repositories: [{ repo: REPO, complete: true }], complete: true, warnings: [] };
    if (method === "inspectPrs") return { entries: (input as { prUrls: string[] }).prUrls.map((prUrl) => ({ repo: REPO,
      pr: current.get(Number(prUrl.split("/").pop()))! })), closed: [], failed: [], warnings: [] };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const efforts = createEffortStore(bb.storage.database() as never);
  const effort = efforts.establish({ sourceKey: "ticket:ABC-42", name: "Manuscript review", goal: "Make manuscript review reliable", projectId: PROJECT,
    coordinatorState: "none", members: { tickets: [], prUrls: [url(42), url(43), url(44)] } });
  efforts.recordWorker(effort.id, "thr-pr", url(42), "pr");
  // The effort's parent thread, and the repository thread beneath it that every PR thread in the effort is placed under.
  add("thr-coordinator", { title: "🧭 Manuscript review" });
  add("thr-repo", { title: "📦 inkwell/folio", parentThreadId: "thr-coordinator", environment: { hostId: HOST } });
  efforts.save({ ...efforts.get(effort.id)!, coordinatorThreadId: "thr-coordinator", coordinatorState: "ready" });
  const claimed = efforts.claimRepoController({ effortId: effort.id, repo: REPO, projectId: PROJECT, hostId: HOST });
  efforts.saveRepoController({ ...claimed.record, threadId: "thr-repo", state: "ready" });
  const rpc = (method: string, value: unknown) => harness.callRpc(method as never, value as never);
  const batch = async (batchId: string) => await rpc("deck_batch_get", { batchId }) as DeckBatch;
  const refresh = async () => expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { rpc, current, send, spawn, effort, efforts, batch, threads, add, refresh,
    card: async () => (await rpc("deck_get", {}) as DeckView).active.find((item) => item.id === effort.id)!,
    plan: async (prUrls?: string[]) => await rpc("deck_batch_plan", { kind: "fix", effortId: effort.id, ...prUrls ? { prUrls } : {} }) as
      { ok: true; batchId: string; items: BatchItem[]; skipped: { ref: string; reason: string }[] },
    settled: (batchId: string) => vi.waitFor(async () => expect((await batch(batchId)).state).toBe("done")) };
}

describe("asking threads to fix an effort's code work", () => {
  it("sends each PR its own fix in its existing thread, and starts a bounded Sol worker under the effort's parent only for one with none", async () => {
    const env = await setup();
    const work = (await env.card()).sections.find((section) => section.key === "work")!;
    expect(work.rows.map((row) => row.number)).toEqual([42, 44]);
    const plan = await env.plan(work.rows.map((row) => row.prUrl));
    expect(plan.items.map((item) => [item.ref, item.kind, item.what, item.headOid, item.fixes])).toEqual([
      ["folio #42", "fix", "Ask “Order fixes”: resolve conflicts, fix CI", HEAD, ["conflicts", "checks"]],
      ["folio #44", "fix", "Start a thread under Manuscript review: address changes", HEAD, ["changes"]]]);
    expect(await env.rpc("deck_batch_start", { batchId: plan.batchId })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(7_900);
    expect([env.send.mock.calls, env.spawn.mock.calls]).toEqual([[], []]);
    await vi.advanceTimersByTimeAsync(200);
    await env.settled(plan.batchId);
    expect((await env.batch(plan.batchId)).items.map((item) => [item.ref, item.state, item.detail])).toEqual([
      ["folio #42", "sent", "Asked “Order fixes” to resolve conflicts, fix CI."],
      ["folio #44", "sent", "Started a thread under Manuscript review to address changes."]]);
    // #42's own thread gets its own fix, bound to its head, and never a merge.
    expect(env.send).toHaveBeenCalledTimes(1);
    const [{ threadId, input }] = env.send.mock.calls[0] as unknown as [{ threadId: string; input: { text: string }[] }];
    expect(threadId).toBe("thr-pr");
    expect(input[0]!.text).toContain(`PR: ${url(42)}`);
    expect(input[0]!.text).toContain(`Fix this PR so it can move toward merge: resolve conflicts, fix CI. expectedHead: ${HEAD}; headBranch: abc-42-order.`);
    expect(input[0]!.text).toContain("Do not merge, deploy, or start another PR.");
    // #44 had no thread: one worker in its checkout on the code-work model, under the effort's repository thread inside its parent.
    expect(env.spawn).toHaveBeenCalledTimes(1);
    const [args] = env.spawn.mock.calls[0] as unknown as [{ parentThreadId: string; environment: unknown; prompt: string; providerId: string; model: string;
      reasoningLevel: string }];
    expect(args).toMatchObject({ parentThreadId: "thr-repo", providerId: "codex", model: "gpt-6-sol", reasoningLevel: "high",
      environment: { type: "host", hostId: HOST, workspace: { type: "unmanaged", path: PATH } } });
    expect(args.prompt).toContain("Fix this PR so it can move toward merge: address changes.");
    expect(args.prompt).toContain("Do not merge, deploy, or start another PR.");
    // Each row says what you did, and stops counting until you mark it seen.
    expect((await env.card()).sections.find((section) => section.key === "work")!.rows.map((row) => [row.number, row.acted?.kind, row.acted?.state]))
      .toEqual([[42, "fix", "sent"], [44, "fix", "sent"]]);
  });

  it("sends nothing once you Undo inside the window", async () => {
    const env = await setup();
    const plan = await env.plan();
    expect(plan.items).toHaveLength(2);
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await env.rpc("deck_batch_undo", { batchId: plan.batchId })).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect([env.send.mock.calls, env.spawn.mock.calls]).toEqual([[], []]);
  });

  it("refuses a PR whose head moved after the listing, and asks the rest", async () => {
    const env = await setup();
    const plan = await env.plan();
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    env.current.set(44, { ...env.current.get(44)!, headRefOid: "b".repeat(40) });
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(plan.batchId);
    expect((await env.batch(plan.batchId)).items.map((item) => [item.ref, item.state, item.detail])).toEqual([
      ["folio #42", "sent", "Asked “Order fixes” to resolve conflicts, fix CI."],
      ["folio #44", "refused", "New commits landed since the row was shown. Review it and try again; nothing was sent."]]);
    expect([env.send.mock.calls.length, env.spawn.mock.calls.length]).toEqual([1, 0]);
  });

  // One writer per checkout, inside Workstreams or not: a thread already at work in the PR's checkout, though the board hasn't seen it yet,
  // keeps a new worker out.
  it("starts no worker in a checkout another thread is already working in", async () => {
    const env = await setup();
    const plan = await env.plan([url(44)]);
    expect(plan.items.map((item) => item.what)).toEqual(["Start a thread under Manuscript review: address changes"]);
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    env.add("thr-busy", { status: "active", environmentPath: PATH });
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(plan.batchId);
    expect((await env.batch(plan.batchId)).items.map((item) => [item.ref, item.state, item.detail])).toEqual([
      ["folio #44", "refused", expect.stringContaining("Thread thr-busy is already working in this checkout")]]);
    expect(env.spawn).not.toHaveBeenCalled();
  });

  // A fix goes only where its listing said: a thread that went away gets no new worker in its place, and one that appeared isn't asked
  // in place of the worker the listing named.
  it("sends nothing for a PR whose thread went away after the listing", async () => {
    const env = await setup();
    env.add("thr-44", { title: "Changes for 44" });
    env.efforts.recordWorker(env.effort.id, "thr-44", url(44), "pr");
    await env.refresh();
    const plan = await env.plan([url(44)]);
    expect(plan.items.map((item) => item.what)).toEqual(["Ask “Changes for 44”: address changes"]);
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    env.threads.delete("thr-44");
    await env.refresh();
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(plan.batchId);
    expect((await env.batch(plan.batchId)).items.map((item) => [item.ref, item.state, item.detail])).toEqual([
      ["folio #44", "refused", "Its thread changed since the listing. Review it and try again; nothing was sent."]]);
    expect([env.send.mock.calls.length, env.spawn.mock.calls.length]).toEqual([0, 0]);
  });

  it("sends nothing for a PR that got a thread after the listing named a new one", async () => {
    const env = await setup();
    const plan = await env.plan([url(44)]);
    expect(plan.items.map((item) => item.what)).toEqual(["Start a thread under Manuscript review: address changes"]);
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    env.add("thr-44", { title: "Changes for 44" });
    env.efforts.recordWorker(env.effort.id, "thr-44", url(44), "pr");
    await env.refresh();
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(plan.batchId);
    expect((await env.batch(plan.batchId)).items.map((item) => [item.ref, item.state, item.detail])).toEqual([
      ["folio #44", "refused", "Its thread changed since the listing. Review it and try again; nothing was sent."]]);
    expect([env.send.mock.calls.length, env.spawn.mock.calls.length]).toEqual([0, 0]);
  });

  // All PRs' Ask its thread on a Your turn row: one PR, no effort named, the same listing and window, and the PR's own thread asked. A
  // reply after the listing answers the comments, so the fresh read at send time refuses the ask rather than send stale work.
  it("asks a Your turn PR's own thread to answer new comments, from one PR's listing, until you reply", async () => {
    const env = await setup();
    const hour = 3_600_000;
    const commented = { ...env.current.get(43)!, reviewRequests: [], latestReviews: [{ login: "mira", state: "COMMENTED", submittedAt: new Date(Date.now() - hour).toISOString() }],
      headCommittedAt: new Date(Date.now() - 2 * hour).toISOString(),
      reviewFeedback: { openThreads: 0, comment: { login: "mira", at: new Date(Date.now() - hour).toISOString() }, repliedAt: null } };
    env.current.set(43, commented);
    env.add("thr-43", { title: "Order reads" });
    env.efforts.recordWorker(env.effort.id, "thr-43", url(43), "pr");
    await env.refresh();
    const row = (await env.card()).sections.flatMap((section) => section.rows).find((item) => item.number === 43)!;
    expect(row).toMatchObject({ section: "work", turn: { list: "turn", addressable: true }, step: { text: "Answer @mira's comment" } });
    const plan = await env.rpc("deck_batch_plan", { kind: "fix", prUrls: [url(43)] }) as { ok: true; batchId: string; items: BatchItem[] };
    expect(plan.items.map((item) => [item.what, item.fixes, item.route])).toEqual([["Ask “Order reads”: answer comments", ["comments"], { kind: "thread", id: "thr-43" }]]);
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(plan.batchId);
    expect((await env.batch(plan.batchId)).items.map((item) => [item.state, item.detail])).toEqual([["sent", "Asked “Order reads” to answer comments."]]);
    const [{ threadId, input }] = env.send.mock.calls[0] as unknown as [{ threadId: string; input: { text: string }[] }];
    expect([threadId, input[0]!.text.includes("Fix this PR so it can move toward merge: answer comments.")]).toEqual(["thr-43", true]);
    expect(env.spawn).not.toHaveBeenCalled();

    // Seen since, it's listed again; then you reply before it sends.
    const again = await env.rpc("deck_batch_plan", { kind: "fix", prUrls: [url(43)], seen: { [url(43)]: Date.now() } }) as { ok: true; batchId: string };
    await env.rpc("deck_batch_start", { batchId: again.batchId });
    env.current.set(43, { ...commented, reviewFeedback: { ...commented.reviewFeedback, repliedAt: new Date(Date.now()).toISOString() } });
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(again.batchId);
    expect((await env.batch(again.batchId)).items.map((item) => [item.state, item.detail])).toEqual([["refused", "It no longer needs to answer comments; nothing was sent."]]);
    expect(env.send).toHaveBeenCalledTimes(1);
  });

  it("leaves a PR that isn't code work out, saying why, and never plans a merge", async () => {
    const env = await setup();
    const plan = await env.plan([url(43), url(42)]);
    expect(plan.items.map((item) => item.ref)).toEqual(["folio #42"]);
    expect(plan.skipped).toEqual([{ prUrl: url(43), ref: "folio #43", reason: "Its next move isn't a thread's work." }]);
  });
});
