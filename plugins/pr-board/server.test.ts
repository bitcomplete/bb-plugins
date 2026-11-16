import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { calmRowSchema, stateSchema, type BoardState, type Prepared, type Runner, type ViewModel } from "./board";
import { afterRefresh, type Marker } from "./markers";
import { createPlugin, MAX_START, MIGRATIONS, THREAD_DEFAULTS } from "./server";

const KEY = (n: number) => `parsleyhealth/parsley-monorepo#${n}`;
const view: ViewModel = {
  fetched_at: "2026-11-13T12:00:00+00:00",
  summary: { work: 1, ready: 1, held: 0, mine: 0, theirs: 0, drafts: 0, other: 0 },
  suggestions: [{ id: "ready", text: "1 PR is ready to merge (#7)", action: null, keys: [] }],
  trains: [], prs: [], reviewer_batches: [],
  sections: [{ id: "ready", title: "Ready to merge", count: 1, open: true, groups: [{ title: null, rows: [
    { key: KEY(7), number: 7, url: "https://github.com/parsleyhealth/sage/pull/7", area: "sage", tone: 2, title: "Route purchases",
      sentence: "approved, checks green, no open comments", blocked: null, depth: 0, after: null, reviewers: [],
      size: { lines: 10, files: 1, bar: 0.2, label: "10 lines · 1 file" }, stack: null, action: null, gate_blocked: false }] }] }],
  reviewer_load: { reviewers: [], none: { count: 0, keys: [] } },
};

/** A runner whose GitHub state, refusals and failures each test controls. */
function fakeRunner() {
  const calls = { fetch: 0, busy: [] as string[][], prepared: [] as string[] };
  const control = {
    heads: {} as Record<string, string>,
    refuse: {} as Record<string, string>,
    view,
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
      return control.view;
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
  const delivery = { output: null as string | null, error: null as string | null, gate: null as Promise<void> | null, updatedAt: Date.parse("2026-11-13T13:00:00Z") };
  const { bb, harness } = createFakePluginHost({
    pluginId: "pr-board",
    sdk: { threads: {
      output: async () => ({ output: delivery.output }),
      send: async () => {
        if (delivery.gate) await delivery.gate;
        if (delivery.error) throw new Error(delivery.error);
        return { ok: true as const, delivery: "sent" as const };
      },
      spawn: async () => makeThreadResponse({ id: `thr_${++spawned}` }),
      get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: threadStatus.value, updatedAt: delivery.updatedAt }),
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
  return { bb, harness, get, settle, delivery };
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
  expect(result).toEqual({ starting: [1, 2, 3, 4, 5].map(KEY), skipped: [6, 7].map((n) => ({ key: KEY(n), reason: "at most 5 agents start per click" })) });
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
  const marker: Marker = { key: "k", action: "fix-ci", status: "started", at: "t0", threadId: "thr", title: "T", head: "h1", move: "ci", reason: null, question: null, answeredQuestions: [], answering: null, answerError: null };
  const prs = { k: { head_oid: "h2", move: "ci" } };
  expect(afterRefresh([marker], prs, { thr: { live: true, updatedAt: "t1" } }, "t2")).toEqual([marker]);
  expect(afterRefresh([marker], prs, { thr: { live: false, updatedAt: "t1" } }, "t2")).toEqual([]);
  expect(afterRefresh([marker], {}, { thr: null }, "t2")).toEqual([]); // PR closed
});


const question = { id: "fixture-1", prompt: "Repair the fixture?", options: [
  { id: "repair", label: "Repair", message: "Repair the fixture and run checks." },
  { id: "stop", label: "Stop", message: "Stop and report the remaining work." },
] };
const output = "Decisions for Matt\n```pr-board-question\n" + JSON.stringify({ version: 1, question }) + "\n```";
const answer = { key: KEY(1), questionId: question.id, optionId: "repair" };

it("recovers a real final question from supported thread output after a missed idle event, and keeps it across a push", async () => {
  const { runner, control } = fakeRunner(); control.heads[KEY(1)] = "old";
  const thread = { value: "active" as "active" | "idle" };
  const { harness, settle, delivery, get } = await host(runner, thread);
  await harness.behavior.callRpc("start", { items: [{ key: KEY(1), action: "fix-ci" }], stop: "publish" });
  await settle();
  thread.value = "idle"; delivery.output = output;
  control.heads[KEY(1)] = "new";
  await harness.behavior.callRpc("board_refresh", null);
  expect((await get()).markers[0]).toMatchObject({ status: "asking", question });
  await harness.behavior.callRpc("answer", answer);
  expect(harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({ threadId: "thr_1", mode: "start", input: [{ type: "text", text: question.options[0]!.message, mentions: [] }] });
  // Old output still contains the same question; it must never reappear after a successful answer.
  expect((await get()).markers[0]).toMatchObject({ status: "done", question: null });
  await expect(harness.behavior.callRpc("answer", answer)).rejects.toThrow(/no longer available/);
  expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
});

it("claims an answer once across simultaneous clicks and clears it only after delivery succeeds", async () => {
  const { runner } = fakeRunner(); const thread = { value: "active" as "active" | "idle" };
  const { harness, settle, delivery, get } = await host(runner, thread);
  await harness.behavior.callRpc("start", { items: [{ key: KEY(1), action: "fix-ci" }], stop: "prepare" }); await settle();
  thread.value = "idle"; delivery.output = output; await get();
  let release = () => {}; delivery.gate = new Promise<void>((resolve) => { release = resolve; });
  const first = harness.behavior.callRpc("answer", answer);
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
  expect((await get()).markers[0]).toMatchObject({ question, answering: true });
  await expect(harness.behavior.callRpc("answer", answer)).rejects.toThrow(/no longer available/);
  release(); await first;
  expect((await get()).markers[0]).toMatchObject({ question: null, answering: false });
});

it("keeps ambiguous delivery visible and refuses to resend after a reload", async () => {
  const { runner } = fakeRunner(); const thread = { value: "active" as "active" | "idle" };
  const { harness, settle, delivery, get } = await host(runner, thread);
  await harness.behavior.callRpc("start", { items: [{ key: KEY(1), action: "fix-ci" }], stop: "prepare" }); await settle();
  thread.value = "idle"; delivery.output = output; await get(); delivery.error = "connection lost";
  await expect(harness.behavior.callRpc("answer", answer)).rejects.toThrow(/connection lost/);
  expect((await get()).markers[0]).toMatchObject({ status: "asking", question, answering: true, answerError: expect.stringMatching(/Could not confirm/) });
  expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  const reloaded = await harness.lifecycle.reload(createPlugin({ runner }));
  disposers.push(() => reloaded.harness.lifecycle.dispose());
  const recovered = stateSchema.parse(await reloaded.harness.behavior.callRpc("board_get", null));
  expect(recovered.markers[0]).toMatchObject({ status: "asking", question, answering: true, answerError: expect.stringMatching(/interrupted/) });
  await expect(reloaded.harness.behavior.callRpc("answer", answer)).rejects.toThrow(/no longer available/);
  expect(reloaded.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
});


it("upgrades a precanonical saved board from its own snapshot without discarding success/error history or refetching GitHub", async () => {
  const { runner, calls } = fakeRunner();
  const { bb, harness } = createFakePluginHost({ pluginId: "pr-board" });
  const db = bb.storage.database();
  bb.storage.migrate(db, [MIGRATIONS[0]]);
  db.prepare("INSERT INTO snapshot (id, body) VALUES (1, ?)").run(JSON.stringify({ prs: {} }));
  const { prs, reviewer_batches, ...legacy } = view;
  await bb.storage.kv.set("board", { view: legacy, lastSuccess: "2026-11-13T12:00:05Z", lastError: "Last remote attempt failed" });
  const reloaded = await harness.lifecycle.reload(createPlugin({ runner }));
  disposers.push(() => reloaded.harness.lifecycle.dispose());
  expect(stateSchema.parse(await reloaded.harness.behavior.callRpc("board_get", null))).toMatchObject({ view, lastSuccess: "2026-11-13T12:00:05Z", lastError: "Last remote attempt failed" });
  expect(await reloaded.bb.storage.kv.get("board")).toBeUndefined();
  expect(calls.fetch).toBe(0);
});


it("does not resend when reload interrupts persistence after an answer is accepted", async () => {
  const { runner } = fakeRunner(); const thread = { value: "active" as "active" | "idle" };
  const { harness, settle, delivery, get } = await host(runner, thread);
  await harness.behavior.callRpc("start", { items: [{ key: KEY(1), action: "fix-ci" }], stop: "prepare" }); await settle();
  thread.value = "idle"; delivery.output = output; await get();
  let release = () => {}; delivery.gate = new Promise<void>((resolve) => { release = resolve; });
  const sending = harness.behavior.callRpc("answer", answer);
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
  const reloaded = await harness.lifecycle.reload(createPlugin({ runner }));
  disposers.push(() => reloaded.harness.lifecycle.dispose());
  release();
  await expect(sending).rejects.toThrow(/stale API handle/);
  const recovered = stateSchema.parse(await reloaded.harness.behavior.callRpc("board_get", null));
  expect(recovered.markers[0]).toMatchObject({ question, answering: true, answerError: expect.stringMatching(/interrupted/) });
  await expect(reloaded.harness.behavior.callRpc("answer", answer)).rejects.toThrow(/no longer available/);
  expect(reloaded.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
});


it("retires a question when a manual thread follow-up completes without a question and prevents stale option replay", async () => {
  const { runner } = fakeRunner();
  const thread = { value: "active" as "active" | "idle" };
  const { harness, settle, delivery, get } = await host(runner, thread);
  await harness.behavior.callRpc("start", { items: [{ key: KEY(1), action: "fix-ci" }], stop: "prepare" }); await settle();
  thread.value = "idle"; delivery.output = output; await get();
  expect((await get()).markers[0]?.status).toBe("asking");
  thread.value = "active";
  await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_1", status: "active" }) });
  thread.value = "idle";
  delivery.output = 'Completed the requested fix.\n```pr-board-question\n{"version":1,"question":null}\n```';
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", status: "idle" }), lastAssistantText: delivery.output });
  expect((await get()).markers[0]).toMatchObject({ status: "done", question: null, answering: false, answerError: null });
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", status: "idle" }), lastAssistantText: output });
  expect((await get()).markers[0]?.question).toBeNull();
  await expect(harness.behavior.callRpc("answer", answer)).rejects.toThrow(/no longer available/);
  expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
});

it("recovers a missed completion after manual ambiguous-delivery recovery, without resending or resurrecting the retired question", async () => {
  const { runner } = fakeRunner();
  const thread = { value: "active" as "active" | "idle" };
  const { harness, settle, delivery, get } = await host(runner, thread);
  await harness.behavior.callRpc("start", { items: [{ key: KEY(1), action: "fix-ci" }], stop: "prepare" }); await settle();
  thread.value = "idle"; delivery.output = output; await get(); delivery.error = "connection lost";
  await expect(harness.behavior.callRpc("answer", answer)).rejects.toThrow(/connection lost/);
  expect((await get()).markers[0]).toMatchObject({ question, answering: true, answerError: expect.any(String) });
  // The user opens the thread and continues there. No idle event reaches this plugin.
  delivery.output = 'Work completed.\n```pr-board-question\n{"version":1,"question":null}\n```';
  delivery.updatedAt += 60_000;
  const recovered = await get();
  expect(recovered.markers[0]).toMatchObject({ status: "done", question: null, answering: false, answerError: null });
  const reloaded = await harness.lifecycle.reload(createPlugin({ runner }));
  disposers.push(() => reloaded.harness.lifecycle.dispose());
  delivery.output = output; delivery.updatedAt += 60_000;
  expect(stateSchema.parse(await reloaded.harness.behavior.callRpc("board_get", null)).markers[0]?.question).toBeNull();
  await expect(reloaded.harness.behavior.callRpc("answer", answer)).rejects.toThrow(/no longer available/);
  expect(reloaded.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
});

it("keeps a question and ambiguous send locked when later output has no valid final result", async () => {
  const { runner } = fakeRunner(); const thread = { value: "active" as "active" | "idle" };
  const { harness, settle, delivery, get } = await host(runner, thread);
  await harness.behavior.callRpc("start", { items: [{ key: KEY(1), action: "fix-ci" }], stop: "prepare" }); await settle();
  thread.value = "idle"; delivery.output = output; await get(); delivery.error = "connection lost";
  await expect(harness.behavior.callRpc("answer", answer)).rejects.toThrow(/connection lost/);
  for (const next of ["Done.", '```pr-board-question\n{"version":2,"question":null}\n```']) {
    delivery.output = next; delivery.updatedAt += 60_000;
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", status: "idle", updatedAt: delivery.updatedAt }), lastAssistantText: next });
    expect((await get()).markers[0]).toMatchObject({ question, answering: true, answerError: expect.any(String) });
  }
  await expect(harness.behavior.callRpc("answer", answer)).rejects.toThrow(/no longer available/);
  expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
});


it("preserves a new question when the resumed worker finishes before the answer acknowledgement", async () => {
  const { runner } = fakeRunner(); const thread = { value: "active" as "active" | "idle" };
  const { harness, settle, delivery, get } = await host(runner, thread);
  await harness.behavior.callRpc("start", { items: [{ key: KEY(1), action: "fix-ci" }], stop: "prepare" }); await settle();
  thread.value = "idle"; delivery.output = output; await get();
  let release = () => {}; delivery.gate = new Promise<void>((resolve) => { release = resolve; });
  const sending = harness.behavior.callRpc("answer", answer);
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
  const nextQuestion = { ...question, id: "fixture-2", prompt: "Publish the verified fixture repair?" };
  delivery.output = "Next decision.\n```pr-board-question\n" + JSON.stringify({ version: 1, question: nextQuestion }) + "\n```";
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", status: "idle" }), lastAssistantText: delivery.output });
  release(); await sending;
  expect((await get()).markers[0]).toMatchObject({ status: "asking", question: nextQuestion, answering: false, answerError: null });
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", status: "idle" }), lastAssistantText: output });
  expect((await get()).markers[0]?.question).toEqual(nextQuestion);
  await expect(harness.behavior.callRpc("answer", answer)).rejects.toThrow(/no longer available/);
});


it("persists a full board above the KV limit across refresh, failed refresh, reads, and reload", async () => {
  const { runner, calls, control } = fakeRunner();
  const checks = Array.from({ length: 3000 }, (_, index) => ({ name: `Required integration suite ${index}`, state: index === 2999 ? "fail" : "pass", url: `https://github.com/example/repo/actions/runs/100/jobs/${index}` }));
  const row = calmRowSchema.parse({ ...view.sections[0].groups[0].rows[0], repo: "parsleyhealth/sage", segment: "ready", group: null, move: "ready", pushed_at: "2026-11-15T10:00:00Z", parent_key: null,
    stack_front: false, gate_links: [], review_summary: "Approved", review_targets: [], waiting: [], checks });
  control.view = { ...view, prs: [row] };
  expect(Buffer.byteLength(JSON.stringify(control.view))).toBeGreaterThan(256 * 1024);
  const { bb, harness, get } = await host(runner);
  const good = stateSchema.parse(await harness.behavior.callRpc("board_refresh", null));
  expect(good.view).toEqual(control.view);
  expect((await get()).view?.prs[0]?.checks).toEqual(checks);
  control.fetchError = "GitHub temporarily unavailable";
  const failed = stateSchema.parse(await harness.behavior.callRpc("board_refresh", null));
  expect(failed).toMatchObject({ view: control.view, lastSuccess: good.lastSuccess, lastError: "GitHub temporarily unavailable" });
  const before = calls.fetch;
  // A leftover older KV copy must never replace the newer SQL board during reload.
  const { prs, reviewer_batches, ...oldView } = view;
  await bb.storage.kv.set("board", { view: oldView, lastSuccess: "2020-01-01T00:00:00Z", lastError: "Older KV copy" });
  const reloaded = await harness.lifecycle.reload(createPlugin({ runner }));
  disposers.push(() => reloaded.harness.lifecycle.dispose());
  expect(stateSchema.parse(await reloaded.harness.behavior.callRpc("board_get", null))).toMatchObject({ view: control.view, lastSuccess: good.lastSuccess, lastError: failed.lastError });
  expect(calls.fetch).toBe(before);
});


it("migrates a validated canonical KV board on first read and retains it through reload", async () => {
  const { runner, calls } = fakeRunner();
  const { bb, harness } = createFakePluginHost({ pluginId: "pr-board" });
  const legacy = { view, lastSuccess: "2026-11-13T12:00:05Z", lastError: "Last remote attempt failed" };
  await bb.storage.kv.set("board", legacy);
  await createPlugin({ runner })(bb);
  disposers.push(() => harness.lifecycle.dispose());
  expect(stateSchema.parse(await harness.behavior.callRpc("board_get", null))).toMatchObject(legacy);
  expect(await bb.storage.kv.get("board")).toBeUndefined();
  const reloaded = await harness.lifecycle.reload(createPlugin({ runner }));
  disposers.push(() => reloaded.harness.lifecycle.dispose());
  expect(stateSchema.parse(await reloaded.harness.behavior.callRpc("board_get", null))).toMatchObject(legacy);
  expect(calls.fetch).toBe(0);
});
