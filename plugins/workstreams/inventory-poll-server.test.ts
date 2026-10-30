import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import type { InventoryView } from "./inventory-view.js";
import type { InventoryInspection, InventoryResult } from "./inventory.js";
import plugin, { type Board } from "./server.js";

const HOST = "host-inkwell";
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const HEAD = "a".repeat(40), NEXT = "b".repeat(40);
const pr = (number: number, extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN",
  title: `ABC-${number} Keep shelf order on reload`, isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `abc-${number}-shelves`, baseRefName: "main", headRefOid: HEAD, latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }],
  createdAt: "2026-09-21T15:00:00Z", updatedAt: "2026-09-25T11:00:00Z", ...extra }]))!.pr;
const listing = (prs: Pr[], extra: Partial<InventoryResult> = {}): InventoryResult => ({ owners: ["inkwell"], entries: prs.map((entry) => ({ repo: "inkwell/folio", pr: entry })),
  discoveryComplete: true, repositories: prs.length ? [{ repo: "inkwell/folio", complete: true }] : [], complete: true, warnings: [], ...extra });
const UNIT: RawUnit = { path: "/p/folio", dirName: "folio", repo: "folio", githubRepo: "inkwell/folio", branch: "abc-42-shelves", dirty: false,
  ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/**
 * PR #42 is checked out and authored; #43 is authored only.
 */
async function setup() {
  const calls: { method: string; input: unknown }[] = [];
  const state = {
    scanned: pr(42), authored: [pr(42), pr(43)],
    polled: listing([pr(42), pr(43)]),
    inspection: (urls: string[]): InventoryInspection => ({ entries: [], closed: urls, failed: [], warnings: [] }),
    resetAt: null as number | null,
    /** The full read waits on it, so a test can click again while one runs. */
    gate: Promise.resolve(),
  };
  const spawn = vi.fn(async () => { throw new Error("The poll must start no thread."); });
  const send = vi.fn(async () => { throw new Error("The poll must message no thread."); });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] }, spawn, send },
  }, experimental_callHostRpc: async ({ method, input }) => {
    calls.push({ method, input });
    if (method === "scan" || method === "inspectPaths") return { units: [{ ...UNIT, pr: state.scanned }], warnings: [] };
    if (method === "authoredPrs") { await state.gate; return listing(state.authored); }
    if (method === "pollAuthoredPrs") return state.polled;
    if (method === "inspectPrs") return state.inspection((input as { prUrls: string[] }).prUrls);
    if (method === "githubRateLimit") return { resetAt: state.resetAt };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  /** One pass of the inventory-poll service: it polls at once, then the test stops it before its next wait ends. */
  const poll = async () => {
    const before = calls.length;
    const { controller, done } = harness.runService("inventory-poll");
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
    controller.abort();
    await done;
    return calls.slice(before).map((call) => call.method);
  };
  return { harness, calls, state, spawn, send, poll, db: bb.storage.database(), board: async () => await harness.callRpc("board_get", null) as Board };
}

describe("the inventory poll", () => {
  it("writes one batched read through the board's stores, so the inventory, checkouts, and All PRs agree, and never writes", async () => {
    const env = await setup();
    const checkedAt = (await env.board()).prObservations[url(42)]?.checkedAt;
    const failing = pr(42, { headRefOid: NEXT, statusCheckRollup: [{ conclusion: "FAILURE" }] });
    env.state.polled = listing([failing, pr(43)]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    // Nothing else: no discovery, no listing per repository, no write.
    expect(await env.poll()).toEqual(["pollAuthoredPrs"]);
    const board = await env.board();
    expect(board.prInventory.entries.find((entry) => entry.pr.number === 42)?.pr).toMatchObject({ headRefOid: NEXT, checkConclusions: ["FAILURE"] });
    expect(board.groups.flatMap((group) => group.clusters.flatMap((cluster) => cluster.units)).find((unit) => unit.path === UNIT.path)?.pr)
      .toMatchObject({ headRefOid: NEXT, checkConclusions: ["FAILURE"] });
    expect(board.prObservations[url(42)]?.checkedAt).not.toBe(checkedAt);
    const rows = (await env.harness.callRpc("inventory_get", {}) as InventoryView).groups.flatMap((group) => group.rows);
    expect(rows.find((row) => row.number === 42)).toMatchObject({ status: "CI failing", head: NEXT });
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.send).not.toHaveBeenCalled();
  });

  it("reads a PR the search stopped listing before letting it go, since the search index can lag", async () => {
    const env = await setup();
    env.state.polled = listing([pr(42)]);
    // The index lagged: #43 is still open, so it stays.
    env.state.inspection = (urls) => ({ entries: urls.map((prUrl) => ({ repo: "inkwell/folio", pr: pr(Number(prUrl.split("/").pop())) })), closed: [], failed: [], warnings: [] });
    expect(await env.poll()).toEqual(["pollAuthoredPrs", "inspectPrs"]);
    expect(env.calls.at(-1)?.input).toEqual({ prUrls: [url(43)] });
    expect((await env.board()).prInventory.entries.map((entry) => [entry.pr.number, entry.stale])).toEqual([[42, false], [43, false]]);
    // GitHub couldn't say: #43 stays, stale, with the reason.
    env.state.inspection = (urls) => ({ entries: [], closed: [], failed: urls, warnings: ["inkwell/folio #43: PR refresh failed: HTTP 502"] });
    await env.poll();
    let board = await env.board();
    expect(board.prInventory.entries.map((entry) => [entry.pr.number, entry.stale])).toEqual([[42, false], [43, true]]);
    expect(board.prObservations[url(43)]).toMatchObject({ failedAt: expect.any(String), error: "inkwell/folio #43: PR refresh failed: HTTP 502" });
    // It closed: now it goes, even while #42's own read failing leaves the repository's membership partial.
    env.state.polled = listing([pr(42, { reviewDecision: "APPROVED" })]);
    env.state.inspection = (urls) => ({ entries: [], closed: urls.filter((prUrl) => prUrl === url(43)), failed: urls.filter((prUrl) => prUrl !== url(43)), warnings: [] });
    await env.poll();
    board = await env.board();
    expect(board.prInventory.entries.map((entry) => [entry.pr.number, entry.stale])).toEqual([[42, true]]);
  });

  it("reads a PR's review threads again only when its reviews moved, and otherwise carries their evidence", async () => {
    const env = await setup();
    const approved = (extra: Record<string, unknown> = {}): Pr => ({ ...pr(43, { reviewDecision: "APPROVED",
      latestReviews: [{ author: { login: "mira" }, state: "APPROVED", submittedAt: "2026-09-24T09:00:00Z" }], ...extra }), unresolvedReviewThreads: 0, resolvedReviewThreads: 1 });
    const evidence = { status: "none" as const, fingerprint: null, sourceIds: [] };
    const reviewFeedback = { openThreads: 0, comment: { login: "mira", at: "2026-09-24T09:00:00Z" }, repliedAt: null, noteAt: null, followUpAt: null };
    env.state.inspection = (urls) => ({ entries: urls.map((prUrl) => ({ repo: "inkwell/folio", pr: { ...approved(), url: prUrl, approvalFeedback: evidence, reviewFeedback } })),
      closed: [], failed: [], warnings: [] });
    env.state.polled = listing([pr(42), approved()]);
    expect(await env.poll()).toEqual(["pollAuthoredPrs", "inspectPrs"]);
    expect((await env.board()).prInventory.entries[1]?.pr).toMatchObject({ approvalFeedback: evidence, approvalFeedbackVerified: true, reviewFeedback });
    // Nothing moved: no read, and the evidence stays, Your turn's with it.
    expect(await env.poll()).toEqual(["pollAuthoredPrs"]);
    expect((await env.board()).prInventory.entries[1]?.pr).toMatchObject({ approvalFeedback: evidence, approvalFeedbackVerified: true, reviewFeedback });
    // A new comment moved GitHub's update time: the evidence may no longer hold, so it is read again.
    env.state.polled = listing([pr(42), approved({ updatedAt: "2026-09-26T09:00:00Z" })]);
    expect(await env.poll()).toEqual(["pollAuthoredPrs", "inspectPrs"]);
    // That read failed: the PR keeps the read that proved its evidence, stale, with why, rather than reading as fresh without it.
    env.state.polled = listing([pr(42), approved({ updatedAt: "2026-09-27T09:00:00Z" })]);
    env.state.inspection = (urls) => ({ entries: [], closed: [], failed: urls, warnings: ["inkwell/folio #43: PR refresh failed: HTTP 502"] });
    expect(await env.poll()).toEqual(["pollAuthoredPrs", "inspectPrs"]);
    const board = await env.board();
    expect(board.prInventory.entries.find((entry) => entry.pr.number === 43)).toMatchObject({ stale: true,
      pr: { approvalFeedback: evidence, approvalFeedbackVerified: true, updatedAt: "2026-09-25T11:00:00Z" } });
    expect(board.prObservations[url(43)]).toMatchObject({ failedAt: expect.any(String), error: "inkwell/folio #43: PR refresh failed: HTTP 502" });
  });

  it("leaves a PR the poll found closed out of the inventory view, though its checkout still says open", async () => {
    const env = await setup();
    createEffortStore(env.db).establish({ sourceKey: "pr:42", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
      coordinatorState: "none", members: { tickets: [], prUrls: [url(42), url(43)] } });
    // The poll rescans no checkout, so #42's still says open until the next scan.
    env.state.polled = listing([]);
    env.state.inspection = (urls) => ({ entries: [], closed: urls, failed: [], warnings: [] });
    expect(await env.poll()).toEqual(["pollAuthoredPrs", "inspectPrs"]);
    expect((await env.board()).groups.flatMap((group) => group.clusters.flatMap((cluster) => cluster.units)).map((unit) => unit.pr?.state)).toEqual(["OPEN"]);
    expect((await env.harness.callRpc("inventory_get", {}) as InventoryView).groups).toEqual([]);
  });

  it("stops at GitHub's rate limit until its reset, and names the reset in each PR's failure", async () => {
    const env = await setup();
    const resetAt = Date.now() + 15 * 60_000;
    env.state.resetAt = resetAt;
    env.state.polled = listing([], { complete: false, discoveryComplete: false, warnings: ["Authored PR poll failed: GraphQL: API rate limit exceeded for user ID 1."] });
    expect(await env.poll()).toEqual(["pollAuthoredPrs", "githubRateLimit"]);
    const board = await env.board();
    expect(board.prInventory.entries.map((entry) => entry.stale)).toEqual([true, true]);
    expect(board.prObservations[url(42)]?.error).toContain(new Date(resetAt + 30_000).toISOString());
    // The next pass reads nothing before the reset.
    const before = env.calls.length;
    const { controller, done } = env.harness.runService("inventory-poll");
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await done;
    expect(env.calls.slice(before)).toEqual([]);
  });

  // A secondary limit names no reset, so the poll backs off on its own: longer after each limit in a row, and from the start again
  // once a read goes through, so one bad minute doesn't hold every later read for 15.
  it("backs off a secondary rate limit longer each time, until a read GitHub doesn't limit", async () => {
    const env = await setup();
    const limited = listing([], { complete: false, discoveryComplete: false,
      warnings: ["Authored PR poll failed: HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again."] });
    const waits = async () => (await env.harness.callRpc("inventory_get", {}) as InventoryView).rateLimitedUntil! - Date.now();
    const start = Date.now();
    const at = (ms: number) => vi.spyOn(Date, "now").mockReturnValue(start + ms);
    try {
      at(0);
      env.state.polled = limited;
      // GitHub names no reset for a secondary limit, so nothing asks it for one.
      expect(await env.poll()).toEqual(["pollAuthoredPrs"]);
      expect(await waits()).toBe(60_000);
      at(61_000);
      expect(await env.poll()).toEqual(["pollAuthoredPrs"]);
      expect(await waits()).toBe(2 * 60_000);
      at(182_000);
      env.state.polled = listing([pr(42), pr(43)]);
      await env.poll();
      at(183_000);
      env.state.polled = limited;
      await env.poll();
      expect(await waits()).toBe(60_000);
    } finally { vi.restoreAllMocks(); }
  });
});

describe("a forced read from GitHub", () => {
  const SINCE = "2026-09-24T09:00:00Z", MINE = "2026-09-26T10:00:00Z";
  const reviewed = (extra: Partial<Pr> = {}): Pr => ({ ...pr(43, { latestReviews: [{ author: { login: "mira" }, state: "COMMENTED", submittedAt: SINCE }] }),
    unresolvedReviewThreads: 1, ...extra });
  // Stored: mira had the last word in an open thread. On GitHub now, the thread's last comment is my reply, so nothing waits on me; the
  // thread stays unresolved and nothing the poll compares moved, so the poll's only-if-moved shortcut keeps the stored read.
  const stale = reviewed({ reviewFeedback: { openThreads: 1, comment: { login: "mira", at: SINCE }, repliedAt: null, noteAt: null, followUpAt: null } });
  const fresh = reviewed({ reviewFeedback: { openThreads: 0, comment: { login: "mira", at: SINCE }, repliedAt: MINE, noteAt: null, followUpAt: null } });
  const turn = async (env: Awaited<ReturnType<typeof setup>>) => ((await env.harness.callRpc("inventory_get", {})) as InventoryView).groups
    .flatMap((group) => group.rows).find((row) => row.number === 43)?.yourTurn ?? null;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
  type Reads = { reads: { prUrl: string; read: { status: string; error?: string } }[] };
  /** #43 stored with mira's open thread, which a poll that sees nothing moved leaves on Your turn. */
  async function staleTurn() {
    const env = await setup();
    env.state.authored = [pr(42), stale];
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    env.state.polled = listing([pr(42), reviewed()]);
    expect(await env.poll()).toEqual(["pollAuthoredPrs"]);
    expect(await turn(env)).toMatchObject({ why: "Comment from @mira · 1 open thread" });
    await tick();
    return env;
  }

  it("replaces one PR's stale review facts, so a thread whose last comment is now mine leaves Your turn", async () => {
    const env = await staleTurn();
    env.state.inspection = (urls) => ({ entries: urls.map(() => ({ repo: "inkwell/folio", pr: fresh })), closed: [], failed: [], warnings: [] });
    expect(await env.harness.callRpc("pr_refresh_many", { prUrls: [url(43)] })).toMatchObject({ reads: [{ prUrl: url(43), read: { status: "checked" } }] });
    expect(await turn(env)).toBeNull();
  });

  it("reads exactly the selected PRs, in one read of at most four", async () => {
    const env = await setup();
    env.state.inspection = (urls) => ({ entries: urls.map((prUrl) => ({ repo: "inkwell/folio", pr: pr(Number(prUrl.split("/").pop())) })), closed: [], failed: [], warnings: [] });
    await tick();
    const before = env.calls.length;
    const result = await env.harness.callRpc("pr_refresh_many", { prUrls: [url(43), url(42)] }) as Reads;
    expect(env.calls.slice(before).filter((call) => call.method === "inspectPrs").map((call) => call.input)).toEqual([{ prUrls: [url(43), url(42)] }]);
    expect(result.reads.map(({ prUrl, read }) => [prUrl, read.status])).toEqual([[url(43), "checked"], [url(42), "checked"]]);
    // A fifth is more than one read takes at once: the browser sends the selection four at a time.
    await expect(env.harness.callRpc("pr_refresh_many", { prUrls: [42, 43, 44, 45, 46].map(url) })).rejects.toThrow();
  });

  it("reads every open PR in full from Last read, bypassing the poll's only-if-moved shortcut, and ignores a second click while it runs", async () => {
    const env = await staleTurn();
    env.state.authored = [pr(42), fresh];
    let release!: () => void;
    env.state.gate = new Promise<void>((resolve) => { release = resolve; });
    const before = env.calls.length;
    expect(await env.harness.callRpc("inventory_refresh", null)).toEqual({ started: true });
    expect(await env.harness.callRpc("inventory_refresh", null)).toEqual({ started: false });
    release();
    await vi.waitFor(async () => expect(await turn(env)).toBeNull());
    expect(env.calls.slice(before).map((call) => call.method)).toEqual(["authoredPrs"]);
    // Once it ends, the next click reads again.
    await vi.waitFor(async () => expect(await env.harness.callRpc("inventory_refresh", null)).toEqual({ started: true }));
  });

  it("says why a read failed, GitHub's rate limit among them, and reads nothing until the limit resets", async () => {
    const env = await setup();
    await tick();
    env.state.inspection = (urls) => ({ entries: [], closed: [], failed: urls,
      warnings: urls.map((prUrl) => `inkwell/folio #${prUrl.split("/").pop()}: PR refresh failed: GraphQL: API rate limit exceeded for user ID 1.`) });
    expect(((await env.harness.callRpc("pr_refresh_many", { prUrls: [url(43)] })) as Reads).reads[0]!.read)
      .toEqual({ status: "failed", checkedAt: expect.any(String), error: "GraphQL: API rate limit exceeded for user ID 1." });
    // The poll found the limit: until GitHub's reset, a row, a selection, or Last read says so and reads nothing.
    env.state.resetAt = Date.now() + 15 * 60_000;
    env.state.polled = listing([], { complete: false, discoveryComplete: false, warnings: ["Authored PR poll failed: GraphQL: API rate limit exceeded for user ID 1."] });
    await env.poll();
    const before = env.calls.length;
    expect(((await env.harness.callRpc("pr_refresh_many", { prUrls: [url(42)] })) as Reads).reads[0]!.read)
      .toMatchObject({ status: "failed", error: expect.stringMatching(/^GitHub's rate limit holds reads until \S/u) });
    expect(await env.harness.callRpc("inventory_refresh", null)).toEqual({ started: false, limitedUntil: expect.any(Number) });
    expect(env.calls.slice(before)).toEqual([]);
  });
});
