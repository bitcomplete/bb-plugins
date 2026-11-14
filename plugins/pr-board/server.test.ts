import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BoardState, Prepared, Runner, ViewModel } from "./board";
import { afterRefresh, type Marker } from "./markers";
import { createPlugin, MAX_START, THREAD_DEFAULTS } from "./server";

const KEY = (n: number) => `parsleyhealth/parsley-monorepo#${n}`;
const view: ViewModel = {
  fetched_at: "2026-11-13T12:00:00+00:00",
  summary: { work: 1, ready: 1, mine: 0, theirs: 0, drafts: 0, other: 0 },
  suggestions: [{ id: "ready", text: "1 PR is ready to merge (#7)", action: null, keys: [] }],
  trains: [],
  sections: [{ id: "ready", title: "Ready to merge", count: 1, open: true, groups: [{ title: null, rows: [
    { key: KEY(7), number: 7, url: "https://github.com/parsleyhealth/sage/pull/7", area: "sage", tone: 2, title: "Route purchases",
      sentence: "approved, checks green, no open comments", blocked: null, depth: 0, after: null, reviewers: [],
      size: { lines: 10, files: 1, bar: 0.2, label: "10 lines · 1 file" }, stack: null, action: null }] }] }],
  reviewer_load: { reviewers: [], none: { count: 0, keys: [] } },
};

/** A runner whose GitHub state, refusals and failures each test controls. */
function fakeRunner() {
  const calls = { fetch: 0, busy: [] as string[][], prepared: [] as string[] };
  const control = {
    heads: {} as Record<string, string>,
    refuse: {} as Record<string, string>,
    fetchError: null as string | null,
    gate: null as Promise<void> | null,
  };
  const runner: Runner = {
    async fetch() {
      calls.fetch++;
      if (control.gate) await control.gate;
      if (control.fetchError) throw new Error(control.fetchError);
      const prs = Object.fromEntries(Object.entries(control.heads).map(([key, head]) => [key, { head_oid: head, move: "ci" }]));
      return JSON.stringify({ prs });
    },
    async view(_data, busy) {
      calls.busy.push(busy);
      return view;
    },
    async prepare(_data, { key, expect, stop }): Promise<Prepared> {
      calls.prepared.push(`${key}:${expect}:${stop}`);
      const reason = control.refuse[key];
      return reason ? { ok: false, reason }
        : { ok: true, title: `Fix CI PR ${key.split("#")[1]} Title`, prompt: `PROMPT ${key} ${stop}`, head_oid: control.heads[key] ?? "h0", move: "ci" };
    },
  };
  return { runner, calls, control };
}

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });

async function host(runner: Runner, threadStatus: { value: "active" | "idle" } = { value: "active" }) {
  let spawned = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "pr-board",
    sdk: { threads: {
      spawn: async () => makeThreadResponse({ id: `thr_${++spawned}` }),
      get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: threadStatus.value, updatedAt: Date.parse("2026-11-13T13:00:00Z") }),
    } },
  });
  await createPlugin({ runner })(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const get = async () => (await harness.behavior.callRpc("board_get", null)) as BoardState;
  /** Wait until no start is still in flight. */
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      const state = await get();
      if (!state.markers.some((m) => m.status === "starting") && !state.refreshing) return state;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("start did not settle");
  };
  return { harness, get, settle };
}

it("stores the view model and success time after a refresh", async () => {
  const { runner } = fakeRunner();
  const { harness, get } = await host(runner);
  const state = await harness.behavior.callRpc("board_refresh", null);
  expect(state).toMatchObject({ view, lastError: null, refreshing: false, markers: [] });
  expect(await get()).toEqual(state);
  expect(harness.realtimeSignals.some((signal) => signal.channel === "board-changed")).toBe(true);
});

it("keeps the last good board and records the error when a run fails", async () => {
  const { runner, control } = fakeRunner();
  const { harness } = await host(runner);
  const good = (await harness.behavior.callRpc("board_refresh", null)) as BoardState;
  control.fetchError = "build.py: gh api user failed: not logged in";
  const state = await harness.behavior.callRpc("board_refresh", null);
  expect(state).toMatchObject({ view, lastSuccess: good.lastSuccess, lastError: "build.py: gh api user failed: not logged in" });
});

it("never overlaps runs: concurrent refreshes share one run", async () => {
  const { runner, calls, control } = fakeRunner();
  let release: () => void = () => {};
  control.gate = new Promise((resolve) => { release = resolve; });
  const { harness, get } = await host(runner);
  const first = harness.behavior.callRpc("board_refresh", null);
  const second = harness.behavior.callRpc("board_refresh", null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await get()).toMatchObject({ refreshing: true });
  release();
  await Promise.all([first, second]);
  expect(calls.fetch).toBe(1);
});

it("the CLI prints the board as text, the view model with --json, and fails on refresh errors", async () => {
  const { runner, control } = fakeRunner();
  const { harness } = await host(runner);
  await harness.behavior.callRpc("board_refresh", null);
  const text = await harness.behavior.runCli([]);
  expect(text.exitCode).toBe(0);
  expect(text.stdout).toContain("1 open Parsley PRs: 1 can merge");
  expect(text.stdout).toContain("  - 1 PR is ready to merge (#7)");
  expect(text.stdout).toContain("#7 Route purchases [sage] — approved, checks green, no open comments");
  expect(JSON.parse((await harness.behavior.runCli(["--json"])).stdout ?? "")).toEqual(view);
  control.fetchError = "gh missing";
  const refresh = await harness.behavior.runCli(["refresh"]);
  expect(refresh.exitCode).toBe(1);
  expect(refresh.stdout).toContain("Last refresh failed: gh missing");
});

it("starts one thread per PR, at most five, on fresh data, with the playbook and Parsley defaults", async () => {
  const { runner, calls, control } = fakeRunner();
  const { harness, settle } = await host(runner);
  await harness.behavior.callRpc("board_refresh", null);
  const fetchesBefore = calls.fetch;
  for (let n = 1; n <= 7; n++) control.heads[KEY(n)] = `h${n}`;
  const items = Array.from({ length: 7 }, (_, i) => ({ key: KEY(i + 1), action: "fix-ci" as const }));
  const result = await harness.behavior.callRpc("start", { items, stop: "prepare" });
  expect(result).toEqual({ starting: [1, 2, 3, 4, 5].map(KEY), skipped: [] });
  const state = await settle();
  expect(calls.fetch).toBe(fetchesBefore + 1); // re-checked against GitHub before starting
  const spawns = harness.inspection.sdk.callsTo("threads.spawn");
  expect(spawns).toHaveLength(MAX_START);
  expect(spawns[0]?.[0]).toMatchObject({
    ...THREAD_DEFAULTS,
    environment: { type: "project-default" },
    title: "Fix CI PR 1 Title",
    prompt: `PROMPT ${KEY(1)} prepare`,
    pluginMetadata: { pr: KEY(1), action: "fix-ci", stop: "prepare" },
  });
  expect(state.markers.map((m) => [m.key, m.status, m.threadId])).toEqual(
    [1, 2, 3, 4, 5].map((n) => [KEY(n), "live", `thr_${n}`]));
  expect(calls.busy.at(-1)).toEqual([1, 2, 3, 4, 5].map(KEY)); // suggestions skip PRs being worked on
});

it("refuses to start when the PR's move changed since the click, and says why", async () => {
  const { runner, calls, control } = fakeRunner();
  control.heads[KEY(581)] = "h1";
  control.refuse[KEY(581)] = "its next move changed to Fix CI (1 check failing); nothing started";
  const { harness, settle } = await host(runner);
  await harness.behavior.callRpc("start", { items: [{ key: KEY(581), action: "fix-feedback" }], stop: "publish" });
  const state = await settle();
  expect(calls.prepared).toEqual([`${KEY(581)}:fix-feedback:publish`]);
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  expect(state.markers).toMatchObject([{ key: KEY(581), status: "refused", reason: "its next move changed to Fix CI (1 check failing); nothing started" }]);
  // A refusal lasts until the next refresh.
  await harness.behavior.callRpc("board_refresh", null);
  expect((await harness.behavior.callRpc("board_get", null) as BoardState).markers).toEqual([]);
});

it("refuses every PR when GitHub cannot be re-checked", async () => {
  const { runner, control } = fakeRunner();
  control.fetchError = "gh: Bad credentials (HTTP 401)";
  const { harness, settle } = await host(runner);
  await harness.behavior.callRpc("start", { items: [{ key: KEY(1), action: "rebase" }], stop: "publish" });
  const state = await settle();
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  expect(state.markers[0]?.reason).toBe("could not re-check the PR on GitHub: gh: Bad credentials (HTTP 401)");
});

it("a PR an agent is on cannot be started twice", async () => {
  const { runner, control } = fakeRunner();
  control.heads[KEY(1)] = "h1";
  const { harness, settle } = await host(runner);
  await harness.behavior.callRpc("start", { items: [{ key: KEY(1), action: "fix-ci" }], stop: "publish" });
  await settle();
  const again = await harness.behavior.callRpc("start", { items: [{ key: KEY(1), action: "fix-ci" }], stop: "publish" });
  expect(again).toEqual({ starting: [], skipped: [{ key: KEY(1), reason: "an agent is already on it" }] });
});

it("marker lifecycle: live while the thread runs, then worked-on until the PR's head changes", async () => {
  const { runner, control } = fakeRunner();
  control.heads[KEY(1)] = "h1";
  const thread = { value: "active" as "active" | "idle" };
  const { harness, settle, get } = await host(runner, thread);
  await harness.behavior.callRpc("start", { items: [{ key: KEY(1), action: "fix-ci" }], stop: "publish" });
  expect((await settle()).markers[0]).toMatchObject({ status: "live", title: "Fix CI PR 1 Title" });
  thread.value = "idle";
  expect((await get()).markers[0]).toMatchObject({ status: "done", at: "2026-11-13T13:00:00.000Z" });
  await harness.behavior.callRpc("board_refresh", null); // same head: still worth showing
  expect((await get()).markers).toHaveLength(1);
  control.heads[KEY(1)] = "h2"; // the agent pushed
  await harness.behavior.callRpc("board_refresh", null);
  expect((await get()).markers).toEqual([]);
});

it("afterRefresh keeps a live thread's marker even after its head moves", () => {
  const marker: Marker = { key: "k", action: "fix-ci", status: "started", at: "t0", threadId: "thr", title: "T", head: "h1", move: "ci", reason: null };
  const prs = { k: { head_oid: "h2", move: "ci" } };
  expect(afterRefresh([marker], prs, { thr: { live: true, updatedAt: "t1" } }, "t2")).toEqual([marker]);
  expect(afterRefresh([marker], prs, { thr: { live: false, updatedAt: "t1" } }, "t2")).toEqual([]);
  expect(afterRefresh([marker], {}, { thr: null }, "t2")).toEqual([]); // PR closed
});
