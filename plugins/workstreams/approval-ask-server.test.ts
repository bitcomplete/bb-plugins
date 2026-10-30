// Asking a PR's thread to address its approval's notes, through the real server on BB's fake host: the deck's listing, its Undo window,
// and the guarded thread send, or a new thread under the effort's parent when the PR has none. Every name here is synthetic.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import type { BatchItem, DeckBatch } from "./deck-batch.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const PROJECT = "proj-inkwell";
const PATH = "/p/folio-abc-42";
const REPO = "inkwell/folio";
const HEAD = "a".repeat(40);
const url = (number: number) => `https://github.com/${REPO}/pull/${number}`;
const FEEDBACK = { status: "present" as const, fingerprint: "f".repeat(64), sourceIds: ["review-42"] };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

/** mira approved #42 with a note in her review body; checks are green, it's clean, and no thread is open. #43 needs nothing. */
const approved = (number: number, approvalFeedback: Pr["approvalFeedback"] = FEEDBACK): Pr => ({ ...parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title: `ABC-${number} Improve manuscript review`,
  isDraft: false, reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: `abc-${number}-review`, baseRefName: "main",
  headRefOid: HEAD, latestReviews: [{ author: { login: "mira" }, state: "APPROVED", submittedAt: new Date(Date.now() - 86_400_000).toISOString() }],
  reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString() }]))!.pr,
  approvalFeedback, unresolvedReviewThreads: 0, resolvedReviewThreads: 0 });
const NONE = { status: "none" as const, fingerprint: null, sourceIds: [] };

/** `threads`: threads the board has listed before you open the deck. `members`: the PRs the effort owns, both by default. */
async function setup(options: { checkout?: boolean; threads?: { id: string; title: string }[]; members?: string[] } = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const current = approved(42);
  const raw: RawUnit = { path: PATH, dirName: "folio-abc-42", repo: REPO, githubRepo: REPO, branch: "abc-42-review", dirty: false, ahead: 0, behind: 0,
    lastCommitAt: null, defaultBranch: "main", pr: options.checkout === false ? null : current, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const add = (id: string, patch: Record<string, unknown> = {}) => {
    const row = makeThreadResponse({ id, projectId: PROJECT, title: id, status: "idle", providerId: "codex", environmentPath: null, ...patch } as never);
    threads.set(id, row);
    return row;
  };
  for (const thread of options.threads ?? []) add(thread.id, { title: thread.title });
  const send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
  const spawn = vi.fn(async (args: { parentThreadId?: string }) => add("thr-new", { title: "Address notes", parentThreadId: args.parentThreadId ?? null }));
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
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [{ repo: REPO, pr: current }, { repo: REPO, pr: approved(43, NONE) }],
      discoveryComplete: true, repositories: [{ repo: REPO, complete: true }], complete: true, warnings: [] };
    if (method === "inspectPrs") return { entries: (input as { prUrls: string[] }).prUrls.map((prUrl) => ({ repo: REPO,
      pr: prUrl === url(42) ? current : approved(43, NONE) })), closed: [], failed: [], warnings: [] };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const efforts = createEffortStore(bb.storage.database() as never);
  const effort = efforts.establish({ sourceKey: "ticket:ABC-42", name: "Manuscript review", goal: "Make manuscript review reliable", projectId: PROJECT,
    coordinatorState: "none", members: { tickets: [], prUrls: options.members ?? [url(42), url(43)] } });
  const rpc = (method: string, value: unknown) => harness.callRpc(method as never, value as never);
  const ask = async (prUrls = [url(42)], effortId: string | null = effort.id) => await rpc("deck_batch_plan", { kind: "ask", ...effortId ? { effortId } : {}, prUrls }) as
    { ok: true; batchId: string; items: BatchItem[] } | { ok: false; error: string };
  const batch = async (batchId: string) => await rpc("deck_batch_get", { batchId }) as DeckBatch;
  const settled = (batchId: string) => vi.waitFor(async () => expect((await batch(batchId)).state).toBe("done"));
  const verifications = () => bb.storage.database().prepare("SELECT COUNT(*) AS n FROM approval_feedback_verifications").get();
  const stored = () => bb.storage.database().prepare("SELECT COUNT(*) AS n FROM established_efforts").get();
  /** The effort's parent thread, and the repository controller beneath it that every PR thread in the effort is placed under. */
  const place = () => {
    add("thr-coordinator", { title: "🧭 Manuscript review" });
    add("thr-repo", { title: "📦 inkwell/folio", parentThreadId: "thr-coordinator", environment: { hostId: HOST } });
    efforts.save({ ...efforts.get(effort.id)!, coordinatorThreadId: "thr-coordinator", coordinatorState: "ready" });
    const claimed = efforts.claimRepoController({ effortId: effort.id, repo: REPO, projectId: PROJECT, hostId: HOST });
    return efforts.saveRepoController({ ...claimed.record, threadId: "thr-repo", state: "ready" });
  };
  return { bb, harness, rpc, threads, add, send, spawn, efforts, effort, ask, batch, settled, verifications, stored, place };
}
const planned = (result: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["ask"]>>) => {
  if (!result.ok) throw new Error(result.error);
  return result;
};

describe("asking a PR's thread to address its approval's notes", () => {
  it("sends the PR's own thread the approval-feedback recipe 8 seconds after you confirm the listing, and confirms nothing", async () => {
    const env = await setup({ threads: [{ id: "thr-pr", title: "Review fixes" }] });
    env.efforts.recordWorker(env.effort.id, "thr-pr", url(42), "pr");
    const plan = planned(await env.ask());
    expect(plan.items.map((item) => [item.ref, item.kind, item.what, item.headOid, item.fingerprint])).toEqual([
      ["folio #42", "ask", "Ask “Review fixes” to address 1 note", HEAD, FEEDBACK.fingerprint]]);
    expect(await env.rpc("deck_batch_start", { batchId: plan.batchId })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(7_900);
    expect(env.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await env.settled(plan.batchId);
    expect((await env.batch(plan.batchId)).items.map((item) => [item.state, item.detail])).toEqual([["sent", "Asked “Review fixes” to address the notes."]]);
    expect(env.send).toHaveBeenCalledTimes(1);
    const [{ threadId, input }] = env.send.mock.calls[0] as unknown as [{ threadId: string; input: { text: string }[] }];
    expect(threadId).toBe("thr-pr");
    expect(input[0]!.text).toContain(`PR: ${url(42)}`);
    expect(input[0]!.text).toContain("Address the approval's note on this PR (head aaaaaaa)");
    expect(input[0]!.text).toContain("Resolve only review threads whose requests are addressed.");
    expect(input[0]!.text).toContain("Do not merge or deploy.");
    expect([env.spawn.mock.calls, env.verifications()]).toEqual([[], { n: 0 }]);
    // Its row says what you did, and its notes still wait for you once you mark it seen.
    const card = (await env.rpc("deck_get", { seen: { [url(42)]: Date.now() } }) as { active: { id: string; sections: { key: string; rows: { number: number; acted: unknown }[] }[] }[] })
      .active.find((item) => item.id === env.effort.id)!;
    expect(card.sections.find((section) => section.key === "confirm")?.rows).toEqual([expect.objectContaining({ number: 42,
      acted: expect.objectContaining({ kind: "ask", state: "sent" }) })]);
  });

  it("sends nothing once you Undo inside the window", async () => {
    const env = await setup({ threads: [{ id: "thr-pr", title: "Review fixes" }] });
    env.efforts.recordWorker(env.effort.id, "thr-pr", url(42), "pr");
    const plan = planned(await env.ask());
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await env.rpc("deck_batch_undo", { batchId: plan.batchId })).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect([env.send.mock.calls, env.spawn.mock.calls]).toEqual([[], []]);
  });

  it("starts a thread in the PR's checkout under its effort's parent only when the PR has none", async () => {
    const env = await setup();
    env.place();
    const plan = planned(await env.ask());
    expect(plan.items.map((item) => item.what)).toEqual(["Start a thread under Manuscript review to address 1 note"]);
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_000);
    await env.settled(plan.batchId);
    expect((await env.batch(plan.batchId)).items.map((item) => [item.state, item.detail])).toEqual([["sent", "Started a thread under Manuscript review to address the notes."]]);
    expect(env.spawn).toHaveBeenCalledTimes(1);
    const [args] = env.spawn.mock.calls[0] as unknown as [{ parentThreadId: string; environment: unknown; prompt: string }];
    expect(args).toMatchObject({ parentThreadId: "thr-repo", environment: { type: "host", hostId: HOST, workspace: { type: "unmanaged", path: PATH } } });
    expect(args.prompt).toContain("Address the approval's note on this PR");
    expect([env.send.mock.calls, env.verifications()]).toEqual([[], { n: 0 }]);
  });

  it("asks one PR at a time, and leaves out a PR with no thread or checkout to ask, saying why", async () => {
    const env = await setup({ checkout: false });
    expect(await env.ask([url(42), url(43)])).toEqual({ ok: false, error: "Ask one PR's thread at a time." });
    expect(await env.ask()).toEqual({ ok: true, batchId: null, items: [], skipped: [{ prUrl: url(42), ref: "folio #42",
      reason: "This PR has no thread or checkout yet." }] });
    expect([env.send.mock.calls, env.spawn.mock.calls]).toEqual([[], []]);
  });

  // Starting the effort's parent and controller threads, or storing a board group as an effort, is its own confirmed action: never Ask's.
  it("never stores an effort or starts its parent threads to ask: a PR with nothing to start a thread under is left out", async () => {
    const reason = "This PR has no thread, and nothing to start one under yet.";
    const owned = await setup();
    expect(await owned.ask()).toEqual({ ok: true, batchId: null, items: [], skipped: [{ prUrl: url(42), ref: "folio #42", reason }] });
    expect([owned.spawn.mock.calls, owned.stored(), owned.efforts.get(owned.effort.id)?.coordinatorState]).toEqual([[], { n: 1 }, "none"]);
    // From All PRs, a PR no effort owns: its board group is never stored for it.
    const loose = await setup({ members: [url(43)] });
    expect(await loose.ask([url(42)], null)).toEqual({ ok: true, batchId: null, items: [], skipped: [{ prUrl: url(42), ref: "folio #42", reason }] });
    expect([loose.spawn.mock.calls, loose.stored()]).toEqual([[], { n: 1 }]);
  });

  it("refuses when the parent it would start a thread under is gone by the time it sends, and starts nothing", async () => {
    const env = await setup();
    const controller = env.place();
    const plan = planned(await env.ask());
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    env.efforts.saveRepoController({ ...controller, state: "creating" });
    await vi.advanceTimersByTimeAsync(8_000);
    await env.settled(plan.batchId);
    expect((await env.batch(plan.batchId)).items.map((item) => [item.state, item.detail])).toEqual([
      ["refused", "This PR has no thread, and nothing to start one under yet. Open a thread for it first; nothing was sent."]]);
    expect([env.send.mock.calls, env.spawn.mock.calls]).toEqual([[], []]);
  });
});
