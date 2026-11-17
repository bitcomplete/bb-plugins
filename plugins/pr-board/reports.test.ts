import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createPlugin } from "./server";
import { calmRowSchema, stateSchema, viewModelSchema, type Runner } from "./board";
import { prsReviewSchema, reviewsStateSchema } from "./reviews";

const key = "acme/repo#1", other = "acme/repo#2";
const row = calmRowSchema.parse({ key, number: 1, repo: "acme/repo", url: "https://github.com/acme/repo/pull/1", title: "Repair CI", area: "repo", tone: 0,
  sentence: "checks failing", blocked: null, depth: 0, after: null, reviewers: [], size: { lines: 20, files: 1, bar: 0, label: "20 lines" },
  stack: null, action: "fix-ci", gate_blocked: false, segment: "on-you", group: "one-click", move: "ci", pushed_at: null, parent_key: null,
  stack_front: false, gate_links: [], review_summary: "No review", review_targets: [], waiting: [], checks: [] });
const view = viewModelSchema.parse({ fetched_at: "2026-11-16T12:00:00Z", prs: [row], reviewer_batches: [], summary: { work: 1, ready: 0, held: 0, mine: 0, theirs: 0, drafts: 0, other: 0 }, suggestions: [], trains: [], sections: [], reviewer_load: { reviewers: [], none: { count: 0, keys: [] } } });
const review = prsReviewSchema.parse({ item: { key: "review-requested:node:head", rule: "review-requested", state: "started", repo: row.repo, number: row.number, title: row.title, author: "synthetic", url: row.url, baseBranch: "main", headBranch: "feature", headSha: "head", nodeId: "node", reason: "Review requested", noticedAt: view.fetched_at, updatedAt: view.fetched_at, threadId: "reviewer" }, segment: "agent", agentState: "running", evidence: "Agent working", total: { kind: "unknown", reason: "Not fetched" }, delta: { kind: "not-applicable" }, lastReview: null, resolution: { kind: "unknown", reason: "Not fetched" } });
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function data(result: PluginAgentToolResult) {
  const text = typeof result === "string" ? result : result.content.filter((item) => item.type === "text").map((item) => item.text).join("");
  return z.object({ data: z.unknown() }).parse(JSON.parse(text)).data;
}
async function host() {
  const control = { head: "head", status: "active" as "active" | "idle", needsInput: false, spawned: 0 };
  const instance = createFakePluginHost({ pluginId: "pr-board", sdk: { threads: {
    get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: control.status }),
    list: async (args) => (args?.threadIds ?? []).map((id) => ({ id, hasPendingInteraction: control.needsInput })),
  } } });
  const { harness } = instance;
  const runner: Runner = {
    fetch: async () => JSON.stringify({ prs: { [key]: { head_oid: control.head, move: "ci" }, [other]: { head_oid: control.head, move: "ci" } } }),
    view: async () => view,
    prepare: async () => ({ ok: true, title: "Repair CI", prompt: "Prepare the repair", head_oid: control.head, move: "ci" }),
  };
  harness.sdk.stub("projects.get", async () => ({ sources: [{ hostId: "host", path: "/synthetic", isDefault: true }] }));
  harness.sdk.stub("providers.models", async () => ({ modelLoadError: null, providers: [{ id: "codex", available: true }], models: [{ model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }] }));
  harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: `worker-${++control.spawned}` }));
  harness.sdk.stub("threads.output", async () => ({ output: null }));
  await createPlugin({ runner })(instance.bb);
  disposers.push(() => harness.lifecycle.dispose());
  const board = async () => stateSchema.parse(await harness.behavior.callRpc("board_get", null));
  const start = async (keys = [key, other]) => {
    await harness.behavior.callRpc("start", { items: keys.map((key) => ({ key, action: "fix-ci" })), stop: "prepare" });
    await vi.waitFor(async () => expect((await board()).markers.some((marker) => marker.status === "starting")).toBe(false));
  };
  const report = async (updates: unknown[], threadId = "worker-1") => data(await harness.behavior.callAgentTool("prs_report", { updates }, { threadId }));
  return { ...instance, runner, control, board, start, report };
}

it("stores only the latest report on the assigned marker and exposes it after reload without changing readiness or lifecycle", async () => {
  const { start, report, board, harness, runner } = await host(); await start();
  await report([{ kind: "progress", key, summary: "Reading CI" }]);
  expect(await report([{ kind: "result", key, outcome: "prepared", summary: "Repair prepared", detail: "One check passed." }])).toMatchObject({ accepted: [key] });
  const saved = await board();
  expect(saved.markers).toMatchObject([{ key, status: "live", report: { kind: "result", outcome: "prepared", summary: "Repair prepared", receivedAt: expect.any(String) } }, { key: other, report: null }]);
  expect(saved.view).toEqual(view);
  const reloaded = await harness.lifecycle.reload(createPlugin({ runner })); disposers.push(() => reloaded.harness.lifecycle.dispose());
  const restored = stateSchema.parse(await reloaded.harness.behavior.callRpc("board_get", null));
  expect(restored.markers).toEqual(saved.markers);
  expect(restored.view).toEqual(view);
});

it("refuses another thread and an out-of-assignment key before writing any member of the batch", async () => {
  const { start, report, board } = await host(); await start();
  await report([{ kind: "progress", key, summary: "Original" }]);
  const before = (await board()).markers;
  expect(await report([{ kind: "progress", key, summary: "Forged" }], "unrelated")).toMatchObject({ error: "operation_refused" });
  expect(await report([{ kind: "progress", key, summary: "Partial" }, { kind: "progress", key: "acme/repo#9", summary: "Outside" }])).toMatchObject({ error: "operation_refused" });
  expect((await board()).markers).toEqual(before);
});

it("returns a retryable error while spawn has started but markers have no thread ID, then accepts the retry", async () => {
  const { harness, start, report, board } = await host();
  let early: unknown;
  harness.sdk.stub("threads.spawn", async () => {
    early = await report([{ kind: "progress", key, summary: "Early" }]);
    return makeThreadResponse({ id: "worker-1" });
  });
  await start();
  expect(early).toMatchObject({ error: "report_retryable", message: expect.stringContaining("Retry") });
  expect((await board()).markers[0].report).toBeNull();
  expect(await report([{ kind: "progress", key, summary: "Assigned" }])).toMatchObject({ accepted: [key] });
});

it("rejects caller-supplied thread IDs and duplicate keys instead of trusting report payloads", async () => {
  const { harness, start, board } = await host(); await start();
  const update = { kind: "progress", key, summary: "Forged" };
  for (const input of [{ threadId: "worker-1", updates: [update] }, { updates: [update, update] }]) {
    await expect(harness.behavior.callAgentTool("prs_report", input, { threadId: "unrelated" })).rejects.toThrow(/arguments are invalid/);
  }
  expect((await board()).markers.every((marker) => marker.report === null)).toBe(true);
});

it("lets reports expire with their marker and refuses an old coordinator after reassignment", async () => {
  const { start, report, board, control, harness } = await host(); await start([key]);
  await report([{ kind: "result", key, outcome: "prepared", summary: "Prepared", detail: "Local commit" }]);
  control.status = "idle";
  await harness.behavior.callRpc("board_refresh", null);
  expect((await board()).markers[0]).toMatchObject({ status: "done", report: { summary: "Prepared" } });
  control.head = "next";
  await harness.behavior.callRpc("board_refresh", null);
  expect((await board()).markers).toEqual([]);
  await start([key]);
  expect(await report([{ kind: "progress", key, summary: "Late report" }])).toMatchObject({ error: "operation_refused" });
  expect((await board()).markers[0]).toMatchObject({ threadId: "worker-2", report: null });
});

it("reads pending input from scoped thread lists for fixes and reviews without inspecting or answering interactions", async () => {
  const { start, control, harness, board } = await host(); await start();
  control.needsInput = true;
  expect((await board()).needsInput).toEqual({ "worker-1": true });
  expect(harness.sdk.callsTo("threads.list").at(-1)?.[0]).toMatchObject({ threadIds: ["worker-1"], includeHidden: true, limit: 200 });
  harness.sdk.stub("plugins.callRpc", async () => ({ version: 1, items: [review], lastPoll: null, lastSuccessAt: null }));
  expect(reviewsStateSchema.parse(await harness.behavior.callRpc("reviews_get", null))).toMatchObject({ kind: "available", snapshot: { items: [review] }, needsInput: { reviewer: true } });
  expect(harness.sdk.callsTo("plugins.callRpc").map(([args]) => args)).toMatchObject([{ method: "prs_snapshot" }]);
  const signals = harness.realtimeSignals.length;
  await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "worker-1" }) });
  expect(harness.realtimeSignals.length).toBeGreaterThan(signals);
  control.needsInput = false;
  expect((await board()).needsInput).toEqual({ "worker-1": false });
  expect(harness.sdk.callsTo("threads.interactions.list")).toHaveLength(0);
  expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
});


it("keeps the board and marker reports readable when pending-input lookup fails", async () => {
  const { start, report, board, harness } = await host(); await start();
  await report([{ kind: "progress", key, summary: "Reading CI" }]);
  const before = await board();
  harness.sdk.stub("threads.list", async () => { throw new Error("Thread list unavailable"); });
  expect(await board()).toEqual({ ...before, needsInput: {} });
});

it("keeps reviews available when pending-input lookup fails", async () => {
  const { harness } = await host();
  const snapshot = { version: 1, items: [review], lastPoll: null, lastSuccessAt: null };
  harness.sdk.stub("plugins.callRpc", async () => snapshot);
  harness.sdk.stub("threads.list", async () => { throw new Error("Thread list unavailable"); });
  expect(reviewsStateSchema.parse(await harness.behavior.callRpc("reviews_get", null))).toEqual({ kind: "available", snapshot, needsInput: {} });
  expect(harness.sdk.callsTo("threads.list").at(-1)?.[0]).toMatchObject({ threadIds: ["reviewer"] });
});
