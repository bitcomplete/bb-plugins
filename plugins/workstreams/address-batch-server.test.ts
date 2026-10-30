// Address selected on Your turn PRs, through the real server on BB's fake host: the listing, its Undo window, one batch thread on the
// code-work model under the effort's parent, the checks its claims pass as it starts, the claims it holds until it finishes or goes, and
// each PR's own thread as the other choice. Every name here is synthetic.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import type { BatchItem, DeckBatch } from "./deck-batch.js";
import { startAddress } from "./deck-flow.js";
import type { DeckView } from "./deck.js";
import { createEffortStore } from "./effort-store.js";
import { PR_THREADS_RULE } from "./effort-recipes.js";
import { parsePrList } from "./gh.js";
import type { InventoryView } from "./inventory-view.js";
import { yourTurnRows } from "./inventory-view-model.js";
import { createRunStore } from "./runstore.js";
import plugin from "./server.js";
import { sentText } from "./your-turn.js";

const HOST = "host-inkwell";
const PROJECT = "proj-inkwell";
const REPO = "inkwell/folio";
const PATH = "/p/folio-abc-43";
const HEAD = "a".repeat(40);
const HOUR = 3_600_000;
const url = (number: number) => `https://github.com/${REPO}/pull/${number}`;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

const pr = (number: number, extra: Record<string, unknown> = {}, facts: Partial<Pr> = {}): Pr => ({ ...parsePrList(JSON.stringify([{ number, url: url(number),
  state: "OPEN", title: `ABC-${number} Keep manuscripts in order`, isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `abc-${number}-order`, baseRefName: "main", headRefOid: HEAD, latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }],
  createdAt: ago(5 * 24 * HOUR), ...extra }]))!.pr, unresolvedReviewThreads: 0, resolvedReviewThreads: 0, headCommittedAt: ago(3 * HOUR),
  reviewFeedback: { openThreads: 0, comment: null, repliedAt: null }, ...facts });

/**
 * Manuscript review owns four of your PRs. #42: mira approved with a comment, and its thread "Order fixes" worked on it. #43: otto asked
 * for changes, in its checkout. #44: ines commented and opened two threads, with no thread or checkout. #45: otto asked for changes too.
 * Spine labels owns #46, where ines commented.
 */
async function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const current = new Map<number, Pr>([
    [42, pr(42, { reviewDecision: "APPROVED", latestReviews: [{ author: { login: "mira" }, state: "APPROVED", submittedAt: ago(2 * HOUR) }] }, {
      approvalFeedback: { status: "present", fingerprint: "f".repeat(64), sourceIds: ["review-42"] }, approvalFeedbackVerified: false,
      reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: ago(2 * HOUR), followUpAt: null } })],
    [43, pr(43, { reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ author: { login: "otto" }, state: "CHANGES_REQUESTED", submittedAt: ago(HOUR) }] })],
    [44, pr(44, { latestReviews: [{ author: { login: "ines" }, state: "COMMENTED", submittedAt: ago(HOUR) }] },
      { reviewFeedback: { openThreads: 2, comment: { login: "ines", at: ago(HOUR) }, repliedAt: null } })],
    [45, pr(45, { reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ author: { login: "otto" }, state: "CHANGES_REQUESTED", submittedAt: ago(HOUR) }] })],
    [46, pr(46, { latestReviews: [{ author: { login: "ines" }, state: "COMMENTED", submittedAt: ago(HOUR) }] },
      { reviewFeedback: { openThreads: 0, comment: { login: "ines", at: ago(HOUR) }, repliedAt: null } })],
  ]);
  const raw: RawUnit = { path: PATH, dirName: "folio-abc-43", repo: REPO, githubRepo: REPO, branch: "abc-43-order", dirty: false, ahead: 0, behind: 0,
    lastCommitAt: null, defaultBranch: "main", pr: current.get(43)!, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
  /** More checkouts the scan finds, with no PR it linked. `linked`: whether it still finds #43's. */
  const units: RawUnit[] = [];
  const scan = { linked: true };
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const add = (id: string, patch: Record<string, unknown> = {}) => {
    const row = makeThreadResponse({ id, projectId: PROJECT, title: id, status: "idle", providerId: "codex", environmentPath: null, ...patch } as never);
    threads.set(id, row);
    return row;
  };
  add("thr-42", { title: "Order fixes" });
  /** A start BB never answers; `made`: it made the thread all the same. `until`: BB makes the thread and answers once this settles. */
  const hang = { spawn: false, made: false, until: null as Promise<void> | null };
  const hostCalls: string[] = [];
  /** Each PR read from GitHub, and what lands while one PR's read is out. */
  const reads = { urls: [] as string[], during: null as ((prUrl: string) => Promise<unknown>) | null };
  /** What lands once, after the board's next full thread list is read and before it answers. */
  const lists = { during: null as (() => Promise<unknown>) | null };
  const output = { text: "" };
  const send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
  const spawn = vi.fn(async (args: { title?: string; parentThreadId?: string; pluginMetadata?: Record<string, unknown> }) => {
    const id = `thr-batch-${spawn.mock.calls.length}`;
    const made = () => { metadata.set(id, args.pluginMetadata ?? {}); return add(id, { title: args.title ?? id, status: "active", parentThreadId: args.parentThreadId ?? null }); };
    if (hang.spawn) { if (hang.made) made(); return await new Promise<never>(() => undefined); }
    if (hang.until) await hang.until;
    return made();
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: PROJECT, name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      // As BB lists them: archived threads only when asked for.
      list: async (args?: { archived?: boolean; limit?: number }) => {
        const rows = [...threads.values()].filter((row) => (row.archivedAt !== null) === !!args?.archived)
          .map((row) => ({ ...row, originPluginId: metadata.has(row.id) ? "workstreams" : null }));
        const during = args?.limit === 500 ? lists.during : null;
        if (during) { lists.during = null; await during(); }
        return rows as never;
      },
      get: async ({ threadId }: { threadId: string }) => {
        const row = threads.get(threadId);
        if (!row) throw new Error("Unknown synthetic thread");
        return { ...row, canSpawnChild: true } as never;
      },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata.get(threadId) ?? {}) as never,
      spawn: spawn as never, send, output: async () => ({ output: output.text }), context: async () => ({ usage: null }) as never,
      events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: ({ method, input }) => {
    hostCalls.push(method);
    if (method === "scan" || method === "inspectPaths") return { units: [...scan.linked ? [{ ...raw, pr: current.get(43)! }] : [], ...units], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [...current.values()].map((entry) => ({ repo: REPO, pr: entry })),
      discoveryComplete: true, repositories: [{ repo: REPO, complete: true }], complete: true, warnings: [] };
    if (method === "inspectPrs") return (async () => {
      const { prUrls } = input as { prUrls: string[] };
      reads.urls.push(...prUrls);
      for (const prUrl of prUrls) await reads.during?.(prUrl);
      return { entries: prUrls.map((prUrl) => ({ repo: REPO, pr: current.get(Number(prUrl.split("/").pop()))! })), closed: [], failed: [], warnings: [] };
    })();
    if (method === "contextWorkspace") return { path: "/synthetic/workstreams/context/batch" };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb);
  const efforts = createEffortStore(bb.storage.database() as never);
  const effort = efforts.establish({ sourceKey: "ticket:ABC-42", name: "Manuscript review", goal: "Make manuscript review reliable", projectId: PROJECT,
    coordinatorState: "none", members: { tickets: [], prUrls: [42, 43, 44, 45].map(url) } });
  const spine = efforts.establish({ sourceKey: "ticket:ABC-46", name: "Spine labels", goal: "Print spine labels", projectId: PROJECT, coordinatorState: "none",
    members: { tickets: [], prUrls: [url(46)] } });
  efforts.recordWorker(effort.id, "thr-42", url(42), "pr");
  add("thr-coordinator", { title: "🧭 Manuscript review" });
  efforts.save({ ...efforts.get(effort.id)!, coordinatorThreadId: "thr-coordinator", coordinatorState: "ready" });
  const env = { harness, bb, current, units, scan, send, spawn, hang, output, effort, spine, efforts, threads, add, metadata, hostCalls, reads, lists,
    rpc: (method: string, value: unknown) => env.harness.callRpc(method as never, value as never),
    refresh: async () => expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0),
    batch: async (batchId: string) => await env.rpc("deck_batch_get", { batchId }) as DeckBatch,
    settled: (batchId: string) => vi.waitFor(async () => expect((await env.batch(batchId)).state).toBe("done")),
    plan: async (prUrls: string[], mode?: "batch" | "each") => await env.rpc("deck_batch_plan", { kind: "address", prUrls, ...mode ? { mode } : {} }) as
      { ok: true; batchId: string | null; items: BatchItem[]; skipped: { ref: string; reason: string }[]; thread?: DeckBatch["thread"] },
    card: async () => (await env.rpc("deck_get", {}) as DeckView).active.find((item) => item.id === effort.id)!,
    rows: async () => new Map((await env.card()).sections.flatMap((section) => section.rows).map((row) => [row.number, row])),
    /** All PRs' Your turn, which the badge counts, by PR number. */
    turn: async () => yourTurnRows(await env.rpc("inventory_get", {}) as InventoryView, Date.now()).map((line) => line.number).sort(),
    /** Restart the plugin on the same database, as a host reload does. */
    restart: async () => { const next = await env.harness.lifecycle.reload(plugin); env.harness = next.harness; env.bb = next.bb; },
  };
  cleanups.push(() => env.harness.lifecycle.dispose());
  await env.refresh();
  return env;
}
type Env = Awaited<ReturnType<typeof setup>>;
const spawned = (env: Env) => env.spawn.mock.calls.map(([args]) => args as unknown as { title: string; prompt: string; parentThreadId?: string; projectId: string;
  providerId: string; model: string; reasoningLevel: string; environment: unknown; pluginMetadata: { role: string; runIds: number[] } });
/** The batch thread's work order, each PR's line by its number. */
const orders = (env: Env) => new Map(spawned(env)[0]!.prompt.split("\n").filter((line) => line.startsWith('{"pr"'))
  .map((line) => JSON.parse(line) as { url: string; checkout: string | null; worktreeFrom: string | null; mergeState: string; threads: unknown })
  .map((order) => [Number(order.url.split("/").pop()), order]));
/** A checkout the scan found with no PR linked. */
const worktree = (path: string, githubRepo: string, branch: string): RawUnit => ({ path, dirName: path.split("/").pop()!, repo: githubRepo, githubRepo, branch,
  dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } });
/** An agent goes to work in #43's checkout, in the board's run record, on no PR of its own. */
const deskAt43 = (env: Env) => createRunStore(env.bb.storage.database() as never).begin({ path: PATH, ticket: null, prUrl: null, prNumber: null,
  action: "address-review", mode: "new", threadId: "thr-desk" });
/** An agent on this PR in its own thread, in the board's run record. */
const runOn = (env: Env, number: number) => createRunStore(env.bb.storage.database() as never).begin({ path: "", ticket: null, prUrl: url(number), prNumber: number,
  action: "address-review", mode: "new", threadId: `thr-${number}` });
/** Every step already under way finishes: a thread event's handling, or the thread list a refresh starts and doesn't wait for. */
const drain = () => new Promise((resolve) => setImmediate(resolve));
/** BB says this thread went to work. */
async function activate(env: Env, id: string) {
  env.threads.set(id, { ...env.threads.get(id)!, status: "active" });
  await env.harness.emitThreadEvent("thread.active", { thread: env.threads.get(id)! });
  await drain();
}
/** Confirm a listing and let its Undo window pass; `during`, what lands inside the window first. */
async function confirm(env: Env, batchId: string | null, during?: () => Promise<unknown>) {
  expect(await env.rpc("deck_batch_start", { batchId })).toMatchObject({ ok: true });
  await vi.advanceTimersByTimeAsync(2_000);
  await during?.();
  env.reads.urls.length = 0;
  await vi.advanceTimersByTimeAsync(6_100);
  await env.settled(batchId!);
  return (await env.batch(batchId!)).items.map((item) => `${item.ref}: ${item.state}: ${item.detail}`);
}
/** Each batch claim in the board's run record: its PR and status. */
const claims = (env: Env) => createRunStore(env.bb.storage.database() as never).recent(0).filter((run) => run.action === "address-feedback")
  .map((run) => [run.prNumber, run.status]);

describe("advancing selected open PRs in one fresh context", () => {
  const targets = (...numbers: number[]) => numbers.map((n) => ({ prUrl: url(n), headOid: HEAD }));

  it("advances Other PRs together, including an archived worker, and links only the selected scope", async () => {
    const env = await setup();
    for (const n of [42, 44]) env.current.set(n, pr(n, { reviewDecision: "APPROVED" }));
    env.threads.set("thr-42", { ...env.threads.get("thr-42")!, archivedAt: Date.now() });
    await env.refresh(); expect(await env.turn()).not.toContain(42); expect(await env.turn()).not.toContain(44);
    const result = await env.rpc("inventory_advance_selected", { targets: targets(42, 44, 42) });
    expect(result).toEqual({ ok: true, threadId: "thr-batch-1", count: 2, skipped: [] });
    expect(spawned(env)).toHaveLength(1);
    expect(spawned(env)[0]).toMatchObject({ parentThreadId: "thr-coordinator", projectId: PROJECT,
      pluginMetadata: { role: "worker", prUrls: [url(42), url(44)] } });
    const prompt = spawned(env)[0]!.prompt;
    expect(prompt).toContain(url(42)); expect(prompt).toContain(url(44)); expect(prompt).not.toContain(url(43));
    expect(prompt).toContain("Do not merge"); expect(prompt).toContain("do not resume or message an older worker");
    expect(env.send).not.toHaveBeenCalled(); expect(env.threads.get("thr-42")!.archivedAt).not.toBeNull();
    const inventory = await env.rpc("inventory_get", {}) as InventoryView;
    const rows = inventory.groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.number === 42)?.sent?.threadId).toBe("thr-batch-1");
    expect(rows.find((r) => r.number === 44)?.sent?.threadId).toBe("thr-batch-1");
    expect(rows.find((r) => r.number === 43)?.sent?.threadId).not.toBe("thr-batch-1");
  });

  it("skips holds, stopped efforts and changed heads while advancing the remaining mixed selection", async () => {
    const env = await setup();
    env.current.set(44, pr(44, { reviewDecision: "APPROVED" })); await env.refresh();
    await env.rpc("pr_hold_set", { prUrl: url(42), held: true, reason: "Later" });
    await env.rpc("effort_hold", { effortKey: env.spine.id, reason: "Labels later" });
    const result = await env.rpc("inventory_advance_selected", { targets: [...targets(42, 43, 44, 46), { prUrl: url(45), headOid: "0".repeat(40) }] });
    expect(result).toMatchObject({ ok: true, count: 2, skipped: [
      { prUrl: url(42), reason: expect.stringMatching(/hold/iu) },
      { prUrl: url(46), reason: expect.stringMatching(/hold/iu) },
      { prUrl: url(45), reason: expect.stringContaining("New commits") },
    ] });
    expect(spawned(env)[0]).toMatchObject({ pluginMetadata: { prUrls: [url(43), url(44)] } });
    const prompt = spawned(env)[0]!.prompt;
    for (const n of [42, 45, 46]) expect(prompt).not.toContain(url(n));
    expect(env.reads.urls).not.toContain(url(42)); expect(env.reads.urls).not.toContain(url(46));
  });

  it("rechecks a hold that arrives during fresh reads and starts nothing when all selected PRs are held", async () => {
    const env = await setup();
    env.reads.during = async (prUrl) => { if (prUrl === url(43)) await env.rpc("pr_hold_set", { prUrl: url(42), held: true, reason: "Pause" }); };
    expect(await env.rpc("inventory_advance_selected", { targets: targets(42, 43) })).toMatchObject({ ok: true, count: 1,
      skipped: [{ prUrl: url(42), reason: expect.stringMatching(/hold/iu) }] });
    expect(spawned(env)[0]).toMatchObject({ pluginMetadata: { prUrls: [url(43)] } });
    expect(await env.rpc("inventory_advance_selected", { targets: targets(42) })).toMatchObject({ ok: false });
    expect(env.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("addressing Your turn PRs in one batch thread", () => {

  it("starts a fresh context for an archived worker without restoring or messaging it", async () => {
    const env = await setup();
    env.threads.set("thr-42", { ...env.threads.get("thr-42")!, archivedAt: Date.now() });
    env.scan.linked = false; env.units.push(worktree("/p/folio", REPO, "main")); await env.refresh();
    const result = await env.rpc("inventory_restart_thread", { prUrl: url(42), headOid: env.current.get(42)!.headRefOid });
    expect(result).toEqual({ ok: true, threadId: "thr-batch-1" });
    expect(spawned(env)[0]).toMatchObject({ parentThreadId: "thr-coordinator", projectId: PROJECT, environment: { workspace: { path: "/synthetic/workstreams/context/batch" }, hostId: HOST } });
    expect(spawned(env)[0]!.prompt).toContain('"worktreeFrom":"/p/folio"');
    expect(spawned(env)[0]!.prompt).toContain("new context"); expect(env.send).not.toHaveBeenCalled();
    expect(env.threads.get("thr-42")!.archivedAt).not.toBeNull();
  });

  it("leaves other worker conflicts to the user but still checks holds and the shown head", async () => {
    const env = await setup(); await activate(env, "thr-42");
    env.scan.linked = false; env.units.push(worktree("/p/folio", REPO, "main")); await env.refresh();
    expect(await env.rpc("inventory_restart_thread", { prUrl: url(42), headOid: env.current.get(42)!.headRefOid })).toMatchObject({ ok: true });
    await env.rpc("pr_hold_set", { prUrl: url(42), held: true, reason: "Later" });
    expect(await env.rpc("inventory_restart_thread", { prUrl: url(42), headOid: env.current.get(42)!.headRefOid })).toMatchObject({ ok: false });
    expect(await env.rpc("inventory_restart_thread", { prUrl: url(43), headOid: "0".repeat(40) })).toMatchObject({ ok: false, error: expect.stringContaining("New commits") });
    expect(env.spawn).toHaveBeenCalledTimes(1);
  });
  it("plans a PR with no checkout or effort project from its repository source, then creates its effort parent and nests the worker", async () => {
    const env = await setup();
    env.efforts.save({ ...env.efforts.get(env.effort.id)!, projectId: "", coordinatorThreadId: null, coordinatorState: "none" });
    env.threads.delete("thr-coordinator");
    env.scan.linked = false;
    env.units.push(worktree("/p/folio", REPO, "main"));
    await env.refresh();
    const plan = await env.plan([url(44)]);
    expect(plan).toMatchObject({ ok: true, skipped: [], thread: { projectId: PROJECT, parentThreadId: null,
      effortId: env.effort.id, under: "🔍 Manuscript review (new effort thread)" } });
    expect(plan.items.map((item) => item.where)).toEqual(["No checkout: a new worktree from folio"]);
    expect(env.spawn).not.toHaveBeenCalled();
    await env.restart();
    env.efforts = createEffortStore(env.bb.storage.database() as never);
    await env.refresh();
    await confirm(env, plan.batchId);
    expect(spawned(env)).toMatchObject([
      { projectId: PROJECT, title: "🔍 Manuscript review", pluginMetadata: { role: "coordinator", effortId: env.effort.id } },
      { projectId: PROJECT, title: "Address feedback: folio #44", parentThreadId: "thr-batch-1", pluginMetadata: { role: "address-feedback" } },
    ]);
    expect(env.efforts.get(env.effort.id)).toMatchObject({ projectId: PROJECT, coordinatorThreadId: "thr-batch-1", coordinatorState: "ready" });
    expect(claims(env)).toEqual([[44, "running"]]);
    expect((await env.batch(plan.batchId!)).items[0]).toMatchObject({ state: "sent" });
    const next = await env.plan([url(45)]);
    expect(next.thread).toEqual({ projectId: PROJECT, parentThreadId: "thr-batch-1", under: "🔍 Manuscript review" });
    await confirm(env, next.batchId);
    expect(spawned(env)[2]).toMatchObject({ parentThreadId: "thr-batch-1", pluginMetadata: { role: "address-feedback" } });
    expect(spawned(env).filter((args) => args.pluginMetadata.role === "coordinator")).toHaveLength(1);
  });

  it("finds the repository source for a PR with no checkout even when no effort owns it", async () => {
    const env = await setup();
    env.efforts.release(env.spine.id, { tickets: [], prUrls: [url(46)] });
    const plan = await env.plan([url(46)]);
    expect(plan).toMatchObject({ ok: true, thread: { projectId: PROJECT, parentThreadId: null, under: null } });
    await confirm(env, plan.batchId);
    expect(spawned(env)).toHaveLength(1);
    expect(spawned(env)[0]).toMatchObject({ projectId: PROJECT, pluginMetadata: { role: "address-feedback" } });
  });

  it("creates no effort parent when Undo cancels a plan or no feedback remains at dispatch", async () => {
    const env = await setup();
    env.efforts.save({ ...env.efforts.get(env.effort.id)!, projectId: "", coordinatorThreadId: null, coordinatorState: "none" });
    env.threads.delete("thr-coordinator");
    const cancelled = await env.plan([url(44)]);
    expect(await env.rpc("deck_batch_start", { batchId: cancelled.batchId })).toMatchObject({ ok: true });
    expect(await env.rpc("deck_batch_undo", { batchId: cancelled.batchId })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(8_100);
    expect(env.spawn).not.toHaveBeenCalled();
    const plan = await env.plan([url(44)]);
    await confirm(env, plan.batchId, async () => {
      env.current.set(44, { ...env.current.get(44)!, reviewFeedback: { openThreads: 0, comment: null, repliedAt: null }, latestReviews: [] });
    });
    expect([env.spawn.mock.calls.length, claims(env)]).toEqual([0, []]);
    expect(env.efforts.get(env.effort.id)?.coordinatorState).toBe("none");
  });

  it("refuses a missing effort parent after a recorded launch instead of launching another or a detached worker", async () => {
    const env = await setup();
    env.efforts.save({ ...env.efforts.get(env.effort.id)!, coordinatorThreadId: null, coordinatorState: "creating" });
    env.threads.delete("thr-coordinator");
    const plan = await env.plan([url(44)]);
    await confirm(env, plan.batchId);
    expect((await env.batch(plan.batchId!)).items[0]).toMatchObject({ state: "refused" });
    expect((await env.batch(plan.batchId!)).items[0]!.detail).toContain("A coordinator launch was already recorded");
    expect([env.spawn.mock.calls.length, claims(env)]).toEqual([0, []]);
  });

  it("creates one effort parent for two batches dispatched together and nests both workers beneath it", async () => {
    const env = await setup();
    env.efforts.save({ ...env.efforts.get(env.effort.id)!, coordinatorThreadId: null, coordinatorState: "none" });
    env.threads.delete("thr-coordinator");
    const plans = [await env.plan([url(43)]), await env.plan([url(44)])];
    let release = () => {};
    env.hang.until = new Promise<void>((resolve) => { release = resolve; });
    for (const plan of plans) expect(await env.rpc("deck_batch_start", { batchId: plan.batchId })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(8_100);
    expect(spawned(env)).toHaveLength(1);
    expect(spawned(env)[0]!.pluginMetadata.role).toBe("coordinator");
    release();
    for (const plan of plans) await env.settled(plan.batchId!);
    const workers = spawned(env).filter((args) => args.pluginMetadata.role === "address-feedback");
    expect(workers).toHaveLength(2);
    expect(workers.map((args) => args.parentThreadId)).toEqual(["thr-batch-1", "thr-batch-1"]);
    expect(claims(env).map(([number]) => number).sort()).toEqual([43, 44]);
  });

  it("rechecks effort ownership after waiting for its new parent before claiming or starting a worker", async () => {
    const env = await setup();
    env.efforts.save({ ...env.efforts.get(env.effort.id)!, coordinatorThreadId: null, coordinatorState: "none" });
    env.threads.delete("thr-coordinator");
    const plan = await env.plan([url(44)]);
    env.spawn.mockImplementationOnce(async (args) => {
      env.efforts.transfer(env.spine.key, { tickets: [], prUrls: [url(44)] });
      env.metadata.set("thr-parent-new", args.pluginMetadata ?? {});
      return env.add("thr-parent-new", { title: args.title });
    });
    await confirm(env, plan.batchId);
    expect((await env.batch(plan.batchId!)).items[0]).toMatchObject({ state: "refused",
      detail: "Its effort changed since the listing. Review it and try again; nothing was started." });
    expect(spawned(env).map((args) => args.pluginMetadata.role)).toEqual(["coordinator"]);
    expect(claims(env)).toEqual([]);
  });

  it("lists each PR's feedback and where it runs, then after the window starts one worker under the effort's parent that claims them all until it finishes", async () => {
    const env = await setup();
    expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
    const plan = await env.plan([42, 43, 44].map(url));
    // The listing is exactly what the thread gets.
    expect(plan.items.map((item) => [item.ref, item.kind, item.feedback, item.where, item.headOid])).toEqual([
      ["folio #42", "address", "Approval comment from @mira", "No checkout: a new worktree from folio-abc-43", HEAD],
      ["folio #43", "address", "Changes requested by @otto", "In folio-abc-43", HEAD],
      ["folio #44", "address", "Comment from @ines · 2 open threads", "No checkout: a new worktree from folio-abc-43", HEAD]]);
    expect([plan.skipped, plan.thread]).toEqual([[], { projectId: PROJECT, parentThreadId: "thr-coordinator", under: "🧭 Manuscript review" }]);
    expect(await env.rpc("deck_batch_start", { batchId: plan.batchId })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(7_900);
    expect(env.spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await env.settled(plan.batchId!);
    expect((await env.batch(plan.batchId!)).items.map((item) => [item.ref, item.state, item.detail])).toEqual([42, 43, 44].map((number) =>
      [`folio #${number}`, "sent", "Started “Address feedback: folio #42, #43, #44”."]));

    // One worker, on the code-work model, under the effort's parent, in a context workspace; each PR's feedback, bound to its claim.
    const [args] = spawned(env);
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(args).toMatchObject({ title: "Address feedback: folio #42, #43, #44", parentThreadId: "thr-coordinator", projectId: PROJECT, providerId: "codex", model: "gpt-6-sol",
      reasoningLevel: "high", environment: { type: "host", hostId: HOST, workspace: { type: "unmanaged", path: "/synthetic/workstreams/context/batch" } },
      pluginMetadata: { role: "address-feedback" } });
    const runIds = args!.pluginMetadata.runIds;
    expect(runIds).toHaveLength(3);
    for (const number of [42, 43, 44]) expect(args!.prompt).toContain(`{"pr":"${REPO}#${number}"`);
    expect(args!.prompt).toContain('"waiting":"Approval comment from @mira"');
    expect(args!.prompt).toContain(`"checkout":"${PATH}"`);
    expect(args!.prompt).toContain("Reply to each reviewer's note on the PR");
    expect(args!.prompt).toContain("Do not merge, deploy, mark ready, request review, or start another thread.");
    // Nothing here writes to GitHub, and nothing merges.
    expect(env.hostCalls.filter((method) => !["scan", "inspectPaths", "authoredPrs", "inspectPrs", "contextWorkspace"].includes(method))).toEqual([]);

    // Each PR in it reads Working, In flight on the deck, and stays on Your turn where you sent it from; the thread shows on the card.
    await env.refresh();
    const rows = await env.rows();
    for (const number of [42, 43, 44]) expect(rows.get(number)).toMatchObject({ section: "flight", addressing: { threadId: "thr-batch-1", title: "Address feedback: folio #42, #43, #44" },
      sent: { state: "working", threadId: "thr-batch-1", title: "Address feedback: folio #42, #43, #44" } });
    expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
    expect((await env.card()).threads.map((thread) => thread.id)).toContain("thr-batch-1");
  });

  // The thread brings each PR's base in once its feedback is handled, so its line says what the row's facts show of the merge state,
  // from GitHub's read at the start rather than a new one: a conflict, a branch behind its base, red checks, clean, or unknown while
  // GitHub hasn't computed it.
  it("gives each PR's line its merge state from its row's facts", async () => {
    const env = await setup();
    env.current.set(43, { ...env.current.get(43)!, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    env.current.set(44, { ...env.current.get(44)!, mergeStateStatus: "BEHIND" });
    env.current.set(45, { ...env.current.get(45)!, mergeStateStatus: "UNSTABLE", checkConclusions: ["SUCCESS", "FAILURE"] });
    env.current.set(46, { ...env.current.get(46)!, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" });
    await env.refresh();
    const plan = await env.plan([42, 43, 44, 45, 46].map(url));
    await confirm(env, plan.batchId);
    expect([...orders(env)].map(([number, order]) => [number, order.mergeState])).toEqual([[42, "clean"], [43, "conflicts"], [44, "behind"],
      [45, "checks failing"], [46, "unknown"]]);
    expect(env.reads.urls).toEqual([42, 43, 44, 45, 46].map(url));
  });

  // A PR the scan linked no checkout to still works where its branch already is, so the thread neither adds another worktree nor works on
  // a stale copy; a worktree on another branch, in another repository, or on the default branch a fork's head can share a name with is not
  // it. Each other one gets a new worktree from a checkout of its own repository, never one of another repository.
  it("lists and sends a PR without a scanned checkout in its repository's worktree on its head branch, and no other", async () => {
    const env = await setup();
    env.current.set(46, { ...env.current.get(46)!, headRefName: "main" });
    env.units.push(worktree("/p/folio-wt-44", REPO, "abc-44-order"), worktree("/p/folio-abc-42-draft", REPO, "abc-42-draft"),
      worktree("/p/quill-abc-45", "inkwell/quill", "abc-45-order"), worktree("/p/folio", REPO, "main"));
    await env.refresh();
    const plan = await env.plan([42, 44, 45, 46].map(url));
    expect(plan.items.map((item) => [item.ref, item.where])).toEqual([["folio #42", "No checkout: a new worktree from folio"], ["folio #44", "In folio-wt-44"],
      ["folio #45", "No checkout: a new worktree from folio"], ["folio #46", "No checkout: a new worktree from folio"]]);
    await confirm(env, plan.batchId);
    expect([...orders(env)].map(([number, order]) => [number, order.checkout, order.worktreeFrom])).toEqual([[42, null, "/p/folio"],
      [44, "/p/folio-wt-44", null], [45, null, "/p/folio"], [46, null, "/p/folio"]]);
  });

  // The thread never clones: a PR with neither a checkout of its own nor a local checkout of its repository to add a worktree from has
  // nowhere to be worked, so the start refuses it when that checkout went during the Undo window, and the next listing leaves it out.
  it("starts nothing for a PR with no local checkout of its repository, and the next listing says why", async () => {
    const env = await setup();
    const plan = await env.plan([42, 44].map(url));
    expect(plan.items.map((item) => item.where)).toEqual(["No checkout: a new worktree from folio-abc-43", "No checkout: a new worktree from folio-abc-43"]);
    // Folio's only checkout is removed during the window.
    expect(await confirm(env, plan.batchId, async () => { env.scan.linked = false; await env.refresh(); })).toEqual([42, 44].map((number) =>
      `folio #${number}: refused: No local checkout of its repository to add a worktree from; nothing was started.`));
    expect([env.spawn.mock.calls.length, claims(env)]).toEqual([0, []]);
    const again = await env.plan([42, 44].map(url));
    expect([again.items, again.skipped.map((item) => `${item.ref}: ${item.reason}`)]).toEqual([[], [42, 44].map((number) =>
      `folio #${number}: No local checkout of its repository to add a worktree from.`)]);
  });

  // The PR's earlier threads hold what was decided and why; the batch thread may read them, but they never steer it and it never writes there.
  it("gives each PR's line the thread its work started in and the one that worked on it, to read for context and never message", async () => {
    const env = await setup();
    env.add("thr-42-origin", { title: "Start manuscript order" });
    env.metadata.set("thr-42-origin", { prUrl: url(42) });
    await env.refresh();
    const plan = await env.plan([42, 44].map(url));
    await confirm(env, plan.batchId);
    expect([...orders(env)].map(([number, order]) => [number, order.threads])).toEqual([
      [42, { origin: { id: "thr-42-origin", title: "Start manuscript order" }, executor: { id: "thr-42", title: "Order fixes" } }],
      [44, { origin: null, executor: null }]]);
    expect(spawned(env)[0]!.prompt).toContain(PR_THREADS_RULE);
    expect(env.send).not.toHaveBeenCalled();
  });

  // One writer per PR: while the batch thread's claims hold, no second agent starts on a batched PR, from any path that starts one.
  it("keeps a second agent off every PR it claims, and the next Address listing says why", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43].map(url));
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(plan.batchId!);
    await env.refresh();
    expect(await env.rpc("thread_message", { prUrl: url(42), threadId: "thr-42", message: "Address mira's note." }))
      .toEqual({ ok: false, error: "A batch thread is addressing this PR's feedback. Wait for it to finish." });
    const again = await env.plan([42, 43, 44].map(url));
    expect(again.items.map((item) => item.ref)).toEqual(["folio #44"]);
    expect(again.skipped).toEqual([{ prUrl: url(42), ref: "folio #42", reason: "An agent is already working on it." },
      { prUrl: url(43), ref: "folio #43", reason: "An agent is already working on it." }]);
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.send).not.toHaveBeenCalled();
  });

  // The worker's report is for you, never parsed: its claims end with its turn whatever it wrote, and only its replies on the PR clear the
  // feedback. Parse it again and a report line could end or keep a claim.
  it("releases its claims when it finishes without reading its report, and clears feedback only once a reply shows on the PR", async () => {
    const env = await setup();
    const plan = await env.plan([43, 44].map(url));
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(plan.batchId!);
    expect(spawned(env)[0]!.prompt).not.toContain("Workstreams result v1");
    env.output.text = "Worked #43 then #44.\nWorkstreams result v1: {\"outcome\":\"blocked\"}";
    env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, status: "idle" });
    await env.harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr-batch-1", status: "idle" }), lastAssistantText: env.output.text });
    const runs = createRunStore(env.bb.storage.database() as never);
    await vi.waitFor(() => expect(runs.recent(0).filter((run) => run.action === "address-feedback").map((run) => [run.prNumber, run.status, run.result ?? run.error]))
      .toEqual([[44, "done", null], [43, "done", null]]));
    await env.refresh();
    // Claims released, and the feedback still waits: a report and a push answer no reviewer.
    expect((await env.rows()).get(43)).toMatchObject({ addressing: null });
    expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
    // The worker replied to ines on #44 and resolved her threads: its next read clears it. #43 waits until you ask otto again.
    env.current.set(44, { ...env.current.get(44)!, reviewFeedback: { openThreads: 0, comment: { login: "ines", at: ago(HOUR) }, repliedAt: ago(HOUR / 2) } });
    await env.refresh();
    expect(await env.turn()).toEqual([42, 43, 45, 46]);
  });

  // What the listing leaves out, it names with why: a hold, a held effort, or an agent already on the PR or its checkout.
  it("leaves out a held PR, a held effort's PR, and a PR an agent is on or in its checkout, each with why", async () => {
    const env = await setup();
    await env.rpc("pr_hold_set", { prUrl: url(45), held: true, reason: "Counter redesign" });
    expect(await env.rpc("effort_hold", { effortKey: env.spine.id, reason: "Labels later" })).toMatchObject({ ok: true });
    runOn(env, 44);
    env.threads.set("thr-42", { ...env.threads.get("thr-42")!, status: "active" });
    env.add("thr-desk", { title: "Desk tidy", status: "active", environmentPath: PATH });
    await env.refresh();
    const plan = await env.plan([42, 43, 44, 45, 46].map(url));
    expect([plan.batchId, plan.items]).toEqual([null, []]);
    expect(plan.skipped.map((skip) => `${skip.ref}: ${skip.reason}`)).toEqual(["folio #42: An agent is already working on it.",
      "folio #43: An agent is working in its checkout.", "folio #44: An agent is already working on it.", "folio #45: On hold. Release it first.",
      "folio #46: Its effort is on hold."]);
    expect(env.spawn).not.toHaveBeenCalled();
  });

  // A PR you dismissed is off Your turn, so neither list offers it, and the listing leaves it out too, whichever list picked it: the deck
  // once still sent it, since it never read Dismiss. A new word brings it back.
  it("leaves out a PR you dismissed from Your turn, and takes it again once a person says more", async () => {
    const env = await setup();
    const row = async () => (await env.rpc("inventory_get", {}) as InventoryView).groups.flatMap((group) => group.rows).find((item) => item.number === 44)!;
    expect(await env.rpc("inventory_dismiss", { prUrl: url(44), head: HEAD, latest: (await row()).yourTurn!.latest })).toEqual({ ok: true });
    expect(await env.turn()).toEqual([42, 43, 45, 46]);
    const plan = await env.plan([43, 44].map(url));
    expect([plan.items.map((item) => item.ref), plan.skipped.map((skip) => `${skip.ref}: ${skip.reason}`)])
      .toEqual([["folio #43"], ["folio #44: You dismissed it from Your turn."]]);
    env.current.set(44, { ...env.current.get(44)!, reviewFeedback: { openThreads: 2, comment: { login: "ines", at: ago(HOUR / 4) }, repliedAt: null } });
    await env.refresh();
    expect((await env.plan([44].map(url))).items.map((item) => item.ref)).toEqual(["folio #44"]);
  });

  // The removed Advance engine's saved jobs are history: nothing can settle one it left mid-run, so it holds neither its PR nor its checkout.
  it("lists for Address, and messages, PRs whose only owner is a legacy Advance job that never settled", async () => {
    const env = await setup();
    const job = (number: number, patch: Record<string, unknown>) => ({ prUrl: url(number), repo: REPO, number, title: `ABC-${number} Keep manuscripts in order`,
      headOid: HEAD, baseRefName: "main", headRefName: `abc-${number}-order`, needsPreparation: false, needsFeedback: true, needsChecks: false, eligible: true,
      detail: "Addressing review feedback", workspace: "existing", id: `job-${number}`, threadId: null, path: null, checkedHeadOid: null, updatedAt: Date.now(), ...patch });
    env.bb.storage.database().prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run("batch-legacy", JSON.stringify({ id: "batch-legacy",
      createdAt: Date.now(), cancelled: false, jobs: [job(42, { status: "queued" }), job(43, { status: "verifying", uncertain: true })], facts: { "job-43": { path: PATH } } }));
    await env.restart();
    await env.refresh();
    const plan = await env.plan([42, 43].map(url));
    expect([plan.items.map((item) => item.ref), plan.skipped]).toEqual([["folio #42", "folio #43"], []]);
    expect(await env.rpc("thread_message", { prUrl: url(42), threadId: "thr-42", message: "Address mira's note." })).toMatchObject({ ok: true });
    expect(env.send).toHaveBeenCalledTimes(1);
  });

  // Undo takes the batch back before anything starts, and a restart inside the window keeps both the cancel and the one start.
  it("starts nothing after an Undo, and a restart inside the window neither starts twice nor loses the Undo", async () => {
    const env = await setup();
    const kept = await env.plan([42, 43].map(url));
    const undone = await env.plan([url(44)]);
    for (const plan of [kept, undone]) expect(await env.rpc("deck_batch_start", { batchId: plan.batchId })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await env.rpc("deck_batch_undo", { batchId: undone.batchId })).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await env.restart();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(env.spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await env.settled(kept.batchId!);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawned(env).map((args) => args.title)).toEqual(["Address feedback: folio #42, #43"]);
    expect((await env.batch(undone.batchId!)).state).toBe("cancelled");
    await env.refresh();
    expect((await env.rows()).get(44)).toMatchObject({ addressing: null, acted: null });
  });

  // A start cut off by a reload can't know whether BB made the thread: the PRs read maybe sent and stay claimed until a read of BB's
  // threads finds the one it made, whose claims it keeps, or finds none, and drops them so nothing holds a PR no one works on.
  it("binds a start a reload cut off to the thread BB made, and drops its claims when BB made none", async () => {
    for (const made of [true, false]) {
      const env = await setup();
      env.hang.spawn = true;
      env.hang.made = made;
      const plan = await env.plan([43, 44].map(url));
      await env.rpc("deck_batch_start", { batchId: plan.batchId });
      await vi.advanceTimersByTimeAsync(8_100);
      await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
      await env.restart();
      await env.settled(plan.batchId!);
      expect((await env.batch(plan.batchId!)).items.map((item) => item.state)).toEqual(["unknown", "unknown"]);
      await env.refresh();
      expect((await env.rows()).get(43)?.addressing).toEqual({ threadId: null, title: null });
      await vi.advanceTimersByTimeAsync(90_000);
      await vi.waitFor(async () => { await env.refresh(); expect((await env.rows()).get(43)?.addressing?.threadId ?? "none").toBe(made ? "thr-batch-1" : "none"); });
      // Either way the PRs stay on Your turn: working in the thread BB made, or back to you when it made none.
      expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
      expect((await env.rows()).get(43)?.sent?.state).toBe(made ? "working" : "refused");
      expect(env.spawn).toHaveBeenCalledTimes(1);
      await env.harness.lifecycle.dispose();
      cleanups.pop();
      vi.useRealTimers();
    }
  });

  // Each PR in its own thread is the Ask its thread path, and only for a PR that has a thread; the rest are listed with why.
  it("offers each PR's own thread only to PRs that have one, and sends there, starting nothing", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43, 44].map(url), "each");
    expect(plan.items.map((item) => [item.ref, item.kind, item.what, item.feedback])).toEqual([
      ["folio #42", "ask", "Ask “Order fixes” to address 1 note", "Approval comment from @mira"]]);
    expect(plan.skipped.map((skip) => `${skip.ref}: ${skip.reason}`)).toEqual(["folio #43: It has no thread. Use One batch thread.",
      "folio #44: It has no thread. Use One batch thread."]);
    expect(plan.thread).toBeUndefined();
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(plan.batchId!);
    expect((await env.batch(plan.batchId!)).items.map((item) => [item.state, item.detail])).toEqual([["sent", "Asked “Order fixes” to address the notes."]]);
    expect((env.send.mock.calls as unknown as [{ threadId: string }][]).map(([args]) => args.threadId)).toEqual(["thr-42"]);
    expect(env.spawn).not.toHaveBeenCalled();
  });
});

describe("the checks a batch thread's claims pass as it starts", () => {
  // What the listing checked, the start checks again before it reads GitHub. #42 has no checkout, so only its own thread going to work
  // shows an agent on it.
  it("leaves out, unread, a PR that got a hold or an agent in the Undo window, even one only in the PR's own thread", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43, 44, 45].map(url));
    expect(plan.items).toHaveLength(4);
    expect(await confirm(env, plan.batchId, async () => {
      await activate(env, "thr-42");
      deskAt43(env);
      runOn(env, 44);
      await env.rpc("pr_hold_set", { prUrl: url(45), held: true, reason: "Counter redesign" });
    })).toEqual(["folio #42: refused: An agent is already working on it.",
      "folio #43: refused: An agent is already working on it.",
      "folio #44: refused: An agent is already working on it.", "folio #45: refused: On hold: Counter redesign. Release the hold before advancing or merging this PR."]);
    expect(env.reads.urls).toEqual([]);
    expect([claims(env), env.spawn.mock.calls.length]).toEqual([[], 0]);
  });

  // An effort held while GitHub answers holds each of its PRs: the one being read at the claim, and the next before it's read.
  it("claims nothing for a PR whose effort is held while GitHub reads it", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43].map(url));
    expect(await confirm(env, plan.batchId, async () => {
      env.reads.during = async (prUrl) => { if (prUrl === url(42)) await env.rpc("effort_hold", { effortKey: env.effort.id, reason: "Counter redesign" }); };
    })).toEqual([42, 43].map((number) => `folio #${number}: refused: Its effort is on hold. Resume it first; nothing was written.`));
    expect(env.reads.urls).toEqual([url(42)]);
    expect([claims(env), env.spawn.mock.calls.length]).toEqual([[], 0]);
  });

  // Whatever lands while GitHub answers, the step that claims sees, on every PR in the listing: #42 gets a new worker thread, at work.
  it("checks each PR again in the step that claims it, after the last GitHub read", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43, 44, 45, 46].map(url));
    expect(plan.items).toHaveLength(5);
    expect(await confirm(env, plan.batchId, async () => {
      env.reads.during = async (prUrl) => {
        if (prUrl !== url(46)) return;
        env.efforts.recordWorker(env.effort.id, "thr-42-again", url(42), "pr");
        env.add("thr-42-again", { title: "Order fixes, again" });
        await activate(env, "thr-42-again");
        deskAt43(env);
        runOn(env, 44);
        await env.rpc("pr_hold_set", { prUrl: url(45), held: true, reason: "Counter redesign" });
        await env.rpc("effort_hold", { effortKey: env.spine.id, reason: "Labels later" });
      };
    })).toEqual(["folio #42: refused: An agent is already working on it.",
      "folio #43: refused: An agent is already working on it.",
      "folio #44: refused: An agent is already working on it.", "folio #45: refused: On hold: Counter redesign. Release the hold before advancing or merging this PR.",
      "folio #46: refused: Its effort is on hold. Resume it first; nothing was written."]);
    expect(env.reads.urls).toEqual([42, 43, 44, 45, 46].map(url));
    expect([claims(env), env.spawn.mock.calls.length]).toEqual([[], 0]);
  });

  // The thread gets only what GitHub still shows waiting on you, on the head the listing showed.
  it("leaves out a PR with new commits since the listing, or with no feedback waiting now, and starts the rest", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43, 44].map(url));
    expect(await confirm(env, plan.batchId, async () => {
      env.current.set(43, { ...env.current.get(43)!, headRefOid: "d".repeat(40) });
      env.current.set(44, { ...env.current.get(44)!, reviewFeedback: { openThreads: 0, comment: { login: "ines", at: ago(HOUR) }, repliedAt: ago(HOUR / 2) } });
    })).toEqual(["folio #42: sent: Started “Address feedback: folio #42”.",
      "folio #43: refused: New commits landed since the listing. Review it and try again; nothing was started.",
      "folio #44: refused: No feedback waits on you."]);
    expect(claims(env)).toEqual([[42, "running"]]);
    expect(spawned(env).map((args) => [args.title, args.prompt.includes(url(42)), args.prompt.includes(url(43)), args.prompt.includes(url(44))]))
      .toEqual([["Address feedback: folio #42", true, false, false]]);
  });

  it("starts nothing when the parent thread it listed is gone", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43].map(url));
    expect(plan.thread?.parentThreadId).toBe("thr-coordinator");
    expect(await confirm(env, plan.batchId, async () => { env.threads.delete("thr-coordinator"); })).toEqual([42, 43].map((number) =>
      `folio #${number}: refused: Its parent thread is gone since the listing. Review it and try again; nothing was started.`));
    expect([claims(env), env.spawn.mock.calls.length]).toEqual([[], 0]);
  });

  // Two listings confirmed together that share a PR: one claim takes it, and the other batch starts without it. Each batch's read of #43
  // waits for the other's, so both pass the check before the read and only the one at the claim can tell them apart.
  it("claims a PR two listings share once when both are confirmed in the same window", async () => {
    const env = await setup();
    const first = await env.plan([42, 43].map(url));
    const second = await env.plan([43, 44].map(url));
    for (const plan of [first, second]) expect(await env.rpc("deck_batch_start", { batchId: plan.batchId })).toMatchObject({ ok: true });
    let meet = () => undefined as void;
    const met = new Promise<void>((resolve) => { meet = resolve; });
    let seen = 0;
    env.reads.during = async (prUrl) => { if (prUrl === url(43) && ++seen <= 2) { if (seen === 2) meet(); await met; } };
    await vi.advanceTimersByTimeAsync(8_100);
    for (const plan of [first, second]) await env.settled(plan.batchId!);
    const items = [...(await env.batch(first.batchId!)).items, ...(await env.batch(second.batchId!)).items];
    expect(items.filter((item) => item.ref === "folio #43").map((item) => item.state).sort()).toEqual(["refused", "sent"]);
    expect(items.find((item) => item.state === "refused")?.detail).toBe("An agent is already working on it.");
    expect(seen).toBe(2);
    expect(claims(env).map(([number]) => number).sort()).toEqual([42, 43, 44]);
    expect(env.spawn).toHaveBeenCalledTimes(2);
  });

  // Until its start returns, a claim has no thread for a message's owner check to name; it holds the PR all the same.
  it("refuses a message to a batched PR's thread while the batch thread is still starting", async () => {
    const env = await setup();
    env.hang.spawn = true;
    const plan = await env.plan([42, 43].map(url));
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    expect(claims(env).map(([number]) => number).sort()).toEqual([42, 43]);
    expect(await env.rpc("thread_message", { prUrl: url(42), threadId: "thr-42", message: "Address mira's note." }))
      .toEqual({ ok: false, error: "A batch thread is addressing this PR's feedback. Wait for it to finish." });
    expect(env.send).not.toHaveBeenCalled();
  });

  // A Fix listed before the claim still starts no second agent: the claim refuses the new thread it would start, thread or no thread yet.
  it("refuses the new thread a Fix listed earlier would start once a starting batch thread claims its PR", async () => {
    const env = await setup();
    env.add("thr-repo", { title: "📦 inkwell/folio", parentThreadId: "thr-coordinator", environment: { hostId: HOST } });
    const controller = env.efforts.claimRepoController({ effortId: env.effort.id, repo: REPO, projectId: PROJECT, hostId: HOST });
    env.efforts.saveRepoController({ ...controller.record, threadId: "thr-repo", state: "ready" });
    env.current.set(43, { ...env.current.get(43)!, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    await env.refresh();
    const fix = await env.rpc("deck_batch_plan", { kind: "fix", effortId: env.effort.id, prUrls: [url(43)] }) as { ok: true; batchId: string; items: BatchItem[] };
    expect(fix.items.map((item) => item.what)).toEqual([expect.stringMatching(/^Start a thread under Manuscript review: /u)]);
    env.hang.spawn = true;
    const plan = await env.plan([url(43)]);
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    expect(claims(env).map(([number]) => number)).toEqual([43]);
    env.hang.spawn = false;
    await env.rpc("deck_batch_start", { batchId: fix.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(fix.batchId);
    expect((await env.batch(fix.batchId)).items.map((item) => [item.state, item.detail]))
      .toEqual([["refused", "A batch thread is addressing this PR's feedback. Wait for it to finish."]]);
    expect(env.spawn).toHaveBeenCalledTimes(1);
  });

  // Each sent PR keeps its link to the batch thread, with BB's status for it, however the thread ends and after the PR leaves Your turn,
  // until a newer batch takes it: like Reviews' started items.
  it("keeps each PR's link to a batch thread after it ends and after Your turn, lets Address take it again, and a newer batch replaces the link", async () => {
    const env = await setup();
    const sent = async () => new Map(((await env.rpc("inventory_get", {})) as InventoryView).groups.flatMap((group) => group.rows)
      .map((row) => [row.number, row.sent && `${row.sent.state} ${row.sent.threadId}`]));
    const first = await env.plan([43, 44].map(url));
    await confirm(env, first.batchId);
    await env.refresh();
    expect([(await sent()).get(43), (await sent()).get(44)]).toEqual(["working thr-batch-1", "working thr-batch-1"]);
    // Stopped by hand.
    env.output.text = "Stopped.";
    env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, status: "idle" });
    await env.harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr-batch-1", status: "idle" }), lastAssistantText: env.output.text });
    await vi.waitFor(async () => expect([(await sent()).get(43), (await sent()).get(44)]).toEqual(["idle thr-batch-1", "idle thr-batch-1"]));
    await env.refresh();
    expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
    // The claim is gone and so is the start's mark: the deck files it where its feedback does, needing you, and Address takes it again.
    expect((await env.rows()).get(43)).toMatchObject({ addressing: null, acted: null, sent: { state: "idle", threadId: "thr-batch-1" } });
    expect((await env.rows()).get(43)?.section).not.toBe("flight");
    const again = await env.plan([url(43)]);
    expect([again.items.map((item) => item.ref), again.skipped]).toEqual([["folio #43"], []]);
    await confirm(env, again.batchId);
    await env.refresh();
    expect([(await sent()).get(43), (await sent()).get(44)]).toEqual(["working thr-batch-2", "idle thr-batch-1"]);
    // Once GitHub shows #44's feedback answered, it leaves Your turn and keeps its link; BB's status follows the thread if you resume it.
    env.current.set(44, { ...env.current.get(44)!, reviewFeedback: { openThreads: 0, comment: { login: "ines", at: ago(HOUR) }, repliedAt: ago(HOUR / 2) } });
    await env.refresh();
    expect(await env.turn()).toEqual([42, 43, 45, 46]);
    expect((await sent()).get(44)).toBe("idle thr-batch-1");
    await activate(env, "thr-batch-1");
    await env.refresh();
    expect((await sent()).get(44)).toBe("working thr-batch-1");
  });

  // A finished claim reads its PR again and rescans its checkout. The scan's PR carries no review read, which only the inventory's poll and
  // Refresh own: were the rescan to write it over the inventory's, a comment-only PR would leave Your turn and the deck would hide its thread.
  it("keeps a comment-only PR on Your turn with its sent link through its checkout's rescan after the batch thread ends", async () => {
    const env = await setup();
    const { reviewFeedback: _unread, ...scanned } = env.current.get(44)!;
    env.units.push({ ...worktree("/p/folio-abc-44", REPO, "abc-44-order"), pr: scanned });
    await env.refresh();
    await confirm(env, (await env.plan([url(44)])).batchId);
    const rescans = env.hostCalls.filter((method) => method === "inspectPaths").length;
    env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, status: "idle" });
    await env.harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr-batch-1", status: "idle" }), lastAssistantText: "Replied." });
    await vi.waitFor(() => expect(claims(env)).toEqual([[44, "done"]]));
    await vi.advanceTimersByTimeAsync(3_100);
    await vi.waitFor(() => expect(env.hostCalls.filter((method) => method === "inspectPaths").length).toBe(rescans + 1));
    await drain();
    expect(await env.turn()).toContain(44);
    const row = (await env.rpc("inventory_get", {}) as InventoryView).groups.flatMap((group) => group.rows).find((item) => item.number === 44)!;
    expect(row.yourTurn?.why).toBe("Comment from @ines · 2 open threads");
    expect((await env.rows()).get(44)).toMatchObject({ addressing: null, turn: { list: "turn", addressable: true }, sent: { state: "idle", threadId: "thr-batch-1" } });
  });

  // Address selected's own path, with no listing: its one click schedules the batch, the row reads Sending with Undo, and Undo starts nothing.
  it("starts Address selected's batch at once through the server, and its Undo starts nothing", async () => {
    const env = await setup();
    const rpc = { plan: (input: unknown) => env.rpc("deck_batch_plan", input) as never, start: (batchId: string) => env.rpc("deck_batch_start", { batchId }) as never };
    const outcome = await startAddress(rpc, null, [42, 43].map(url), {});
    expect(outcome).toMatchObject({ ok: true, count: 2, skipped: [] });
    const batchId = (outcome as { batchId: string }).batchId;
    expect((await env.batch(batchId)).state).toBe("scheduled");
    expect((await env.rows()).get(42)?.sent).toEqual({ state: "sending", threadId: null, title: null, detail: null, batchId });
    expect(await env.rpc("deck_batch_undo", { batchId })).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(env.spawn).not.toHaveBeenCalled();
    expect([(await env.batch(batchId)).state, (await env.rows()).get(42)?.sent ?? null]).toEqual(["cancelled", null]);
  });

  // Nothing fails quietly: a PR dispatch refuses keeps why on its row, where All PRs and the deck both read it.
  it("keeps why dispatch refused a PR on its row", async () => {
    const env = await setup();
    const plan = await env.plan([url(43)]);
    const said = await confirm(env, plan.batchId, () => env.rpc("pr_hold_set", { prUrl: url(43), held: true, reason: "Counter redesign" }));
    const why = said[0]!.replace(/^folio #43: refused: /u, "");
    expect(why).not.toBe(said[0]);
    await env.rpc("pr_hold_set", { prUrl: url(43), held: false });
    await env.refresh();
    expect((await env.rows()).get(43)?.sent).toEqual({ state: "refused", threadId: null, title: null, detail: why, batchId: null });
    expect(await env.turn()).toContain(43);
    expect(env.spawn).not.toHaveBeenCalled();
  });

  // A batch thread removed while no load listened sends no event. The next list of BB's threads finds it gone and ends its claims, so its
  // PRs don't wait on a thread that no longer exists; a run of another kind in a thread the list leaves out keeps its own rules.
  it("releases the claims of a batch thread deleted or archived unheard, back to Your turn", async () => {
    for (const gone of ["deleted", "archived"] as const) {
      const env = await setup();
      const plan = await env.plan([43, 44].map(url));
      await confirm(env, plan.batchId);
      const other = runOn(env, 45);
      await env.restart();
      if (gone === "deleted") env.threads.delete("thr-batch-1");
      else env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, archivedAt: Date.now() });
      await env.refresh();
      await drain();
      const runs = createRunStore(env.bb.storage.database() as never).recent(0);
      expect(runs.filter((run) => run.action === "address-feedback").map((run) => [run.prNumber, run.status, run.error])).toEqual([44, 43].map((number) =>
        [number, "failed", "Its batch thread is gone: deleted or archived while the board wasn't listening."]));
      expect(runs.find((run) => run.id === other)?.status).toBe("running");
      // The thread is gone, but each PR keeps its link to it.
      expect((await env.rows()).get(43)).toMatchObject({ addressing: null, sent: { state: "idle", threadId: "thr-batch-1" } });
      expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
      await env.harness.lifecycle.dispose();
      cleanups.pop();
      vi.useRealTimers();
    }
  });

  // A list read before BB made a batch thread can't show it: the claim bound while that list was out is not taken for gone.
  it("keeps the claims of a batch thread its start bound after the thread list began", async () => {
    const env = await setup();
    let answer = () => undefined as void;
    env.hang.until = new Promise<void>((resolve) => { answer = resolve; });
    const plan = await env.plan([url(43)]);
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    let listed = false;
    env.lists.during = async () => { answer(); await env.settled(plan.batchId!); listed = true; };
    await env.refresh();
    // The list answers after BB made the thread and its claim was bound; then the board reconciles.
    await vi.waitFor(() => expect(listed).toBe(true));
    await drain();
    expect(claims(env)).toEqual([[43, "running"]]);
    expect((await env.rows()).get(43)?.addressing?.threadId).toBe("thr-batch-1");
  });

  // From the click to its batch thread at work, each sent row stays on Your turn, Sending and then Working, with BB listing the thread at
  // work before its start returns. A row that took its own batch's thread for another agent's left Your turn until Sent read Working.
  it("keeps each sent PR on Your turn from the click through its thread's start, reading Sending then Working", async () => {
    const env = await setup();
    let answer = () => undefined as void;
    env.hang.until = new Promise<void>((resolve) => { answer = resolve; });
    const where = async () => {
      const [rows, turn] = [await env.rows(), await env.turn()];
      return [42, 43].map((number) => { const row = rows.get(number)!; return [row.turn.list, turn.includes(number), row.sent && sentText(row.sent)]; });
    };
    const plan = await env.plan([42, 43].map(url));
    expect(await where()).toEqual([["turn", true, null], ["turn", true, null]]);
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    expect(await where()).toEqual([["turn", true, "Sending"], ["turn", true, "Sending"]]);
    // The Undo window ends; GitHub is read again and the claims are written as the start goes out.
    await vi.advanceTimersByTimeAsync(8_100);
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    expect(await where()).toEqual([["turn", true, "Sending"], ["turn", true, "Sending"]]);
    // BB makes the thread and says it's at work before the start returns.
    env.metadata.set("thr-batch-1", spawned(env)[0]!.pluginMetadata);
    env.add("thr-batch-1", { title: "Address feedback: folio #42, #43", status: "idle", parentThreadId: "thr-coordinator" });
    await env.harness.emitThreadEvent("thread.created", { thread: env.threads.get("thr-batch-1")! });
    await activate(env, "thr-batch-1");
    expect(await where()).toEqual([["turn", true, "Sending"], ["turn", true, "Sending"]]);
    answer();
    await env.settled(plan.batchId!);
    expect(await where()).toEqual([["turn", true, "Working"], ["turn", true, "Working"]]);
    await env.refresh();
    expect(await where()).toEqual([["turn", true, "Working"], ["turn", true, "Working"]]);
  });
});

// The thread an Address started is stored once, on each PR it took, when its start returns; how that thread stands is BB's word now. The
// board's run log once carried both: a batch of more than one PR never read as asking you, a failure read as done with no reason, and 200
// newer runs pruned the link away.
describe("a batch thread's link", () => {
  it("shows each PR of a 3-PR batch needing you when its thread asks, and its error once it fails, back to Address", async () => {
    const env = await setup();
    await confirm(env, (await env.plan([42, 43, 44].map(url))).batchId);
    await env.refresh();
    env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, hasPendingInteraction: true } as never);
    await env.harness.emitThreadEvent("interaction.pending", { thread: env.threads.get("thr-batch-1")!, interaction: {} as never });
    await drain();
    const asking = await env.rows();
    for (const number of [42, 43, 44]) expect(asking.get(number)).toMatchObject({ section: "flight", addressing: { threadId: "thr-batch-1" },
      sent: { state: "needs-you", threadId: "thr-batch-1" } });
    env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, status: "error", hasPendingInteraction: false } as never);
    await env.harness.emitThreadEvent("thread.failed", { thread: env.threads.get("thr-batch-1")!, error: "Provider overloaded" });
    await vi.waitFor(async () => {
      const failed = await env.rows();
      for (const number of [42, 43, 44]) expect(failed.get(number)).toMatchObject({ addressing: null, turn: { list: "turn", addressable: true },
        sent: { state: "failed", threadId: "thr-batch-1", detail: "Provider overloaded" } });
    });
  });

  it("keeps a batch thread's link through 200 newer runs, and beside a newer batch dispatch refused", async () => {
    const env = await setup();
    await confirm(env, (await env.plan([url(43)])).batchId);
    env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, status: "idle" });
    await env.harness.emitThreadEvent("thread.idle", { thread: env.threads.get("thr-batch-1")!, lastAssistantText: "Replied." });
    await vi.waitFor(() => expect(claims(env)).toEqual([[43, "done"]]));
    // The run log keeps its newest 200: a week of merges prunes the batch's claim.
    const runs = createRunStore(env.bb.storage.database() as never);
    for (let index = 0; index < 200; index++) runs.recordDirect({ path: PATH, ticket: null, prUrl: url(45), prNumber: 45, action: "merge", ok: false,
      text: "Not mergeable", startedAt: Date.now() });
    expect(claims(env)).toEqual([]);
    await env.refresh();
    expect((await env.rows()).get(43)).toMatchObject({ addressing: null, sent: { state: "idle", threadId: "thr-batch-1" } });
    expect((await env.card()).threads.map((thread) => thread.id)).toContain("thr-batch-1");
    // A newer batch that dispatch refused started nothing, so the older thread stays linked beside why.
    const said = await confirm(env, (await env.plan([url(43)])).batchId, () => env.rpc("pr_hold_set", { prUrl: url(43), held: true, reason: "Counter redesign" }));
    await env.rpc("pr_hold_set", { prUrl: url(43), held: false });
    await env.refresh();
    expect((await env.rows()).get(43)?.sent).toEqual({ state: "refused", threadId: "thr-batch-1", title: "Address feedback: folio #43",
      detail: said[0]!.replace(/^folio #43: refused: /u, ""), batchId: null });
  });

  // After a reload, until a thread list answers, nothing says the batch thread finished: taken for gone, its PRs would go to a second batch.
  it("holds its PRs after a reload until the first thread list answers", async () => {
    const env = await setup();
    await confirm(env, (await env.plan([url(44)])).batchId);
    await env.refresh();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    env.lists.during = () => new Promise<never>(() => undefined);
    await env.restart();
    const again = await env.plan([url(44)]);
    expect([again.items, again.skipped.map((skip) => skip.reason)]).toEqual([[], ["An agent is already working on it."]]);
  });

  // BB can list a new thread idle before its first turn. Only its own idle or failed event, or two minutes, says it finished: taken for done
  // at once, its PRs would go to a second batch while it starts on them.
  it("holds its PRs while BB lists it idle before its first turn, until two minutes pass", async () => {
    for (const via of ["list", "created"] as const) {
      const env = await setup();
      await confirm(env, (await env.plan([url(44)])).batchId);
      env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, status: "idle" });
      if (via === "list") await env.refresh();
      else { await env.harness.emitThreadEvent("thread.created", { thread: env.threads.get("thr-batch-1")! }); await drain(); }
      expect((await env.plan([url(44)])).skipped.map((skip) => skip.reason)).toEqual(["An agent is already working on it."]);
      expect((await env.rows()).get(44)?.sent?.state).toBe("working");
      await vi.advanceTimersByTimeAsync(120_000);
      expect((await env.plan([url(44)])).items.map((item) => item.ref)).toEqual(["folio #44"]);
      expect((await env.rows()).get(44)?.sent?.state).toBe("idle");
      await env.harness.lifecycle.dispose();
      cleanups.pop();
      vi.useRealTimers();
    }
  });

  // Every writer reads one rule for whether a batch thread holds a PR, BB's word, and never the run log's copy of its claims, which is kept
  // only for a rollback: resumed after its claims ended, it still holds its effort against archive and merge.
  it("keeps its effort from being archived or merged while it works, by BB's word, after its claims ended", async () => {
    const env = await setup();
    await confirm(env, (await env.plan([url(43)])).batchId);
    env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, status: "idle" });
    await env.harness.emitThreadEvent("thread.idle", { thread: env.threads.get("thr-batch-1")!, lastAssistantText: "Replied." });
    await vi.waitFor(() => expect(claims(env)).toEqual([[43, "done"]]));
    await activate(env, "thr-batch-1");
    const { scopes } = await env.rpc("effort_admin_list", null) as { scopes: Record<string, string> };
    expect(await env.rpc("effort_admin_archive", { effortKey: env.effort.key, archived: true, expectedScope: scopes[env.effort.key] }))
      .toEqual({ ok: false, error: "An affected worker is still active. Wait for it to settle before archiving." });
    expect(await env.rpc("effort_admin_merge_preview", { sourceKey: env.effort.key, destinationKey: env.spine.key }))
      .toMatchObject({ ok: true, preview: { blockers: [`A batch thread is addressing feedback on ${url(43)}.`] } });
  });

  // BB's word can come by an event that signals no run: the run log's open copy of the claim then keeps no message from the PR's own thread
  // that Address would let through.
  it("lets a message through to a PR's own thread once BB says its batch thread finished, as Address takes the PR", async () => {
    const env = await setup();
    await confirm(env, (await env.plan([url(42)])).batchId);
    await env.refresh();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, status: "idle" });
    await env.harness.emitThreadEvent("thread.created", { thread: env.threads.get("thr-batch-1")! });
    await drain();
    expect(claims(env)).toEqual([[42, "running"]]);
    expect((await env.plan([url(42)])).items.map((item) => item.ref)).toEqual(["folio #42"]);
    expect(await env.rpc("thread_message", { prUrl: url(42), threadId: "thr-42", message: "Address mira's note." })).toMatchObject({ ok: true });
  });

  // An earlier build, before a rollback or before this one, left its batch threads' links in the run log only: they still link, and a
  // claim whose thread still works holds its PR.
  it("keeps the links an earlier build's batch threads left in the run log", async () => {
    const env = await setup();
    env.add("thr-batch-old", { title: "Address feedback: folio #44, #45", status: "active" });
    const runs = createRunStore(env.bb.storage.database() as never);
    for (const number of [44, 45]) runs.attach(runs.begin({ path: "", ticket: null, prUrl: url(number), prNumber: number, action: "address-feedback",
      mode: "new", threadId: null }), "thr-batch-old");
    await env.restart();
    await env.refresh();
    expect((await env.rows()).get(44)).toMatchObject({ addressing: { threadId: "thr-batch-old" }, sent: { state: "working", threadId: "thr-batch-old" } });
    expect((await env.plan([url(45)])).skipped.map((skip) => skip.reason)).toEqual(["An agent is already working on it."]);
  });
});
