import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import { calmRowSchema, stateSchema, viewModelSchema, type Runner } from "./board";
import { createPlugin } from "./server";
import { DEFAULT_AGENT_MODEL } from "./agent-model";
import { prsReviewSchema } from "./reviews";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";

const key = "acme/repo#7";
const row = calmRowSchema.parse({ key, number: 7, repo: "acme/repo", url: "https://github.com/acme/repo/pull/7", title: "Route the purchase", area: "repo", tone: 0,
  sentence: "nobody is asked to review it", blocked: null, depth: 0, after: null, reviewers: [], size: { lines: 20, files: 1, bar: 0, label: "20 lines · 1 file" },
  stack: null, action: "fix-ci", gate_blocked: false, segment: "on-you", group: "one-click", move: "ci", pushed_at: null, parent_key: null,
  stack_front: false, gate_links: [], review_summary: "No review", review_targets: [], waiting: [], checks: [] });
const view = viewModelSchema.parse({ fetched_at: "2026-11-15T10:00:00Z", prs: [row], summary: { work: 1, mine: 0, ready: 0, held: 0, theirs: 0, drafts: 0, other: 0 },
  suggestions: [], trains: [], sections: [], reviewer_batches: [], reviewer_load: { reviewers: [], none: { count: 0, keys: [] } } });
const review = prsReviewSchema.parse({ item: { key: "review-followup:node:head", rule: "review-followup", state: "queued", repo: "acme/repo", number: 7,
  title: "Retry lab fetches", author: "example-author", url: row.url, baseBranch: "main", headBranch: "retry", headSha: "head", nodeId: "node", reason: "Author pushed after your review", noticedAt: view.fetched_at, updatedAt: view.fetched_at }, segment: "on-you", agentState: "none", evidence: "Review follow-up", total: { kind: "known", additions: 1000, deletions: 200, files: 10 }, delta: { kind: "unknown", reason: "No last-reviewed commit" }, lastReview: null, resolution: { kind: "unknown", reason: "Not fetched" } });
const alternative = { providerId: "codex", model: "gpt-other", reasoningLevel: "high", serviceTier: "priority" };
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });

function decoded(output: PluginAgentToolResult) {
  const text = typeof output === "string" ? output : output.content.filter((item) => item.type === "text").map((item) => item.text).join("");
  return z.object({ data: z.unknown().optional(), truncated: z.array(z.object({ path: z.string(), omitted: z.number() })).optional(), error: z.string().optional() }).parse(JSON.parse(text));
}

async function host() {
  const control = { view, review, fetchError: false, reviewError: false, fetches: 0, prepareRefusal: null as string | null, prepareGate: null as Promise<void> | null, prepareCalls: 0, prepareSignal: null as AbortSignal | null,
    githubGate: null as Promise<void> | null, githubWrites: 0, spawned: 0, sent: 0, threadStatus: "active" as "active" | "idle", threadOutput: null as string | null, unavailable: false };
  const remote: { method: string; input: unknown }[] = [];
  const runner: Runner = {
    fetch: async () => { control.fetches++; if (control.fetchError) throw new Error("GitHub unavailable"); return JSON.stringify({ login: "me", prs: Object.fromEntries(control.view.prs.map((row) => [row.key, { head_oid: "head", move: "ci" }])) }); },
    view: async () => control.view,
    prepare: async (_data, request, signal) => { control.prepareCalls++; control.prepareSignal = signal; if (control.prepareGate) await control.prepareGate; signal.throwIfAborted(); return control.prepareRefusal ? { ok: false, reason: control.prepareRefusal } : { ok: true, title: "Repair CI", prompt: `Repair ${request.key}; stop at ${request.stop}`, head_oid: "head", move: "ci" }; },
  };
  const instance = createFakePluginHost({ pluginId: "pr-board" });
  const { harness } = instance;
  harness.sdk.stub("projects.get", async () => ({ sources: [{ hostId: "checkout-host", path: "/synthetic", isDefault: true }] }));
  harness.sdk.stub("providers.models", async () => ({ modelLoadError: null, providers: [{ id: "codex", available: !control.unavailable }], models: [
    { model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] },
    { model: "gpt-no-effort", supportedReasoningEfforts: [] },
    { model: "gpt-other", supportedReasoningEfforts: [{ reasoningEffort: "high" }], supportedServiceTiers: [{ id: "priority" }] },
  ] }));
  harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: `fix-${++control.spawned}` }));
  harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "fix-1", status: control.threadStatus }));
  harness.sdk.stub("threads.output", async () => ({ output: control.threadOutput }));
  harness.sdk.stub("threads.send", async () => { control.sent++; return { ok: true, delivery: "sent" }; });
  harness.sdk.stub("plugins.callRpc", async (args: { method: string; input?: unknown }) => {
    remote.push({ method: args.method, input: args.input });
    if (control.reviewError) throw new Error("Review Watch disabled");
    switch (args.method) {
      case "prs_snapshot": return { version: 1, items: [control.review], lastPoll: null, lastSuccessAt: view.fetched_at };
      case "prs_detail": return control.review;
      case "review_targets": return { projectId: "review-project", reason: "default", projects: [] };
      case "item_start": return { item: { ...review.item, state: "started", threadId: "review-1" } };
      case "item_batch_start": return { threadId: "review-1", items: [{ ...review.item, state: "started", threadId: "review-1" }] };
      case "item_dismiss": return { item: { ...review.item, state: "dismissed" } };
      case "poll_now": return { ok: true, added: 0, removed: 0, total: 1, changed: false };
      default: throw new Error("Unexpected Review Watch RPC");
    }
  });
  await createPlugin({ runner, github: async (args) => {
    if (control.githubGate) await control.githubGate;
    if (args.includes("POST")) { control.githubWrites++; return "{}"; }
    if (args[1]?.includes("collaborators")) return JSON.stringify([[{ login: "alice", type: "User" }]]);
    if (args[1]?.includes("contents")) return "* @alice";
    if (args[1]?.includes("/files")) return JSON.stringify([[{ filename: "index.ts" }]]);
    throw new Error("Unexpected GitHub request");
  } })(instance.bb);
  disposers.push(() => harness.lifecycle.dispose());
  const call = async (name: string, input: unknown, signal?: AbortSignal) => decoded(await harness.behavior.callAgentTool(name, input, { ...(signal ? { signal } : {}) }));
  const board = async () => stateSchema.parse(await harness.behavior.callRpc("board_get", null));
  const settle = async () => { await vi.waitFor(async () => expect((await board()).markers.some((marker) => marker.status === "starting")).toBe(false)); };
  return { ...instance, control, remote, call, board, settle };
}

it("reads and prepares without React or an agent start, reporting unavailable and fresh state", async () => {
  const { call, harness, control } = await host();
  expect((await call("prs_read", { kind: "board" })).data).toMatchObject({ available: false, lastSuccess: null, items: [] });
  expect((await call("prs_prepare", { key, action: "fix-ci", stop: "prepare" })).data).toMatchObject({ ok: true, head_oid: "head", stop: "prepare" });
  expect(control.spawned).toBe(0);
  const state = stateSchema.parse(await harness.behavior.callRpc("board_get", null));
  expect((await call("prs_read", { kind: "board" })).data).toMatchObject({ lastSuccess: state.lastSuccess, items: [{ key, title: row.title, action: "fix-ci" }] });
  expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  control.fetchError = true;
  expect((await call("prs_read", { kind: "refresh", target: "board" })).data).toMatchObject({ available: true, lastError: "GitHub unavailable" });
  expect((await call("prs_prepare", { key, action: "fix-ci", stop: "prepare" })).data).toMatchObject({ ok: false, reason: expect.stringContaining("could not re-check") });
});

it("pages canonical rows, checks, and review deltas while preserving unknown evidence", async () => {
  const { call, control } = await host();
  control.view = { ...view, prs: Array.from({ length: 31 }, (_, index) => ({ ...row, key: `acme/repo#${index + 1}`, checks: Array.from({ length: 33 }, (_, n) => ({ name: `check-${n}`, state: "pending", url: null })) })) };
  await call("prs_read", { kind: "refresh", target: "board" });
  expect((await call("prs_read", { kind: "board", offset: 20, limit: 10 })).data).toMatchObject({ total: 31, nextOffset: 30, items: expect.arrayContaining([{ key: "acme/repo#21", title: row.title, url: row.url, segment: "on-you", group: "one-click", sentence: row.sentence, blocked: null, action: "fix-ci", checks: { total: 33, failed: 0, pending: 33 }, marker: null }]) });
  expect((await call("prs_read", { kind: "pr", key: "acme/repo#1", offset: 30 })).data).toMatchObject({ row: { checks: { total: 33, nextOffset: null, items: [{ name: "check-30" }, { name: "check-31" }, { name: "check-32" }] } } });
  expect((await call("prs_read", { kind: "review-detail", key: review.item.key })).data).toMatchObject({ delta: { kind: "unknown" }, total: { additions: 1000 } });
  control.review = { ...review, delta: { kind: "known", baseSha: "base", headSha: "head", additions: 30, deletions: 0, files: Array.from({ length: 30 }, (_, index) => ({ path: `file-${index}`, additions: 1, deletions: 0 })) } };
  expect((await call("prs_read", { kind: "review-detail", key: review.item.key, limit: 5 })).data).toMatchObject({ delta: { files: { total: 30, nextOffset: 5 } } });
  control.reviewError = true;
  expect((await call("prs_read", { kind: "review-queue" })).data).toEqual({ kind: "unavailable", reason: "Review Watch disabled" });
});

it("bounds text explicitly and rejects invalid or unsupported actions before effects", async () => {
  const { call, harness, control } = await host();
  control.view = { ...view, prs: [{ ...row, title: "x".repeat(5000) }] };
  await call("prs_read", { kind: "refresh", target: "board" });
  const output = await harness.behavior.callAgentTool("prs_read", { kind: "board" });
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(33 * 1024);
  expect(decoded(output).truncated).toContainEqual({ path: "data.items[0].title", omitted: 3000 });
  await expect(call("prs_act", { kind: "start-fixes", items: [{ key, action: "fix-ci" }] })).rejects.toThrow();
  await expect(call("prs_act", { kind: "merge", key })).rejects.toThrow();
  await expect(call("prs_act", { kind: "start-fixes", items: [{ key, action: "fix-ci" }], stop: "publish", confirmed: true })).rejects.toThrow();
  expect(control.spawned).toBe(0);
});

it("shares one coordinator and start claims with RPC, including selections above five PRs", async () => {
  const { call, control, harness, settle } = await host();
  const items = Array.from({ length: 7 }, (_, index) => ({ key: `acme/repo#${index + 1}`, action: "fix-ci" }));
  expect((await call("prs_act", { kind: "start-fixes", items, stop: "prepare" })).data).toMatchObject({ starting: items.map((item) => item.key), skipped: [] });
  expect(await harness.behavior.callRpc("start", { items: [items[0]], stop: "prepare" })).toMatchObject({ starting: [], skipped: [{ reason: "an agent is already on it" }] });
  await settle();
  expect(control.spawned).toBe(1);
  expect((await call("prs_read", { kind: "pr", key: items[0].key })).data).toMatchObject({ marker: { threadId: "fix-1", status: "live" } });
  control.prepareRefusal = "next move changed";
  const staleKey = "acme/repo#8";
  await call("prs_act", { kind: "start-fixes", items: [{ key: staleKey, action: "fix-ci" }], stop: "prepare" });
  await settle();
  expect((await call("prs_read", { kind: "pr", key: staleKey })).data).toMatchObject({ marker: { status: "refused", reason: "next move changed" } });
  expect(control.spawned).toBe(1);
});

it("shares reviewer eligibility and duplicate claims with RPC", async () => {
  const { call, control, harness } = await host();
  await call("prs_read", { kind: "refresh", target: "board" });
  expect((await call("prs_read", { kind: "reviewers", key })).data).toMatchObject({ items: [{ login: "alice" }] });
  expect((await call("prs_act", { kind: "request-reviewers", requests: [{ key, reviewers: ["outside"] }] })).data).toMatchObject({ sent: [], skipped: [{ reason: expect.stringContaining("eligible") }] });
  let release = () => {}; control.githubGate = new Promise<void>((resolve) => { release = resolve; });
  const first = call("prs_act", { kind: "request-reviewers", requests: [{ key, reviewers: ["alice"] }] });
  await vi.waitFor(() => expect(control.fetches).toBeGreaterThan(2));
  expect(await harness.behavior.callRpc("reviewers_request", { requests: [{ key, reviewers: ["alice"] }] })).toMatchObject({ sent: [], skipped: [{ reason: expect.stringContaining("already sending") }] });
  release();
  expect((await first).data).toEqual({ sent: [key], skipped: [] });
  expect(control.githubWrites).toBe(1);
  control.view = { ...view, prs: [{ ...row, segment: "ready", group: null }] };
  expect((await call("prs_act", { kind: "request-reviewers", requests: [{ key, reviewers: ["alice"] }] })).data).toMatchObject({ sent: [], skipped: [{ reason: expect.stringContaining("no longer needs") }] });
  expect(control.githubWrites).toBe(1);
});

it("answers only a live validated question and rejects replay across transports", async () => {
  const { call, control, settle, harness } = await host();
  await call("prs_act", { kind: "start-fixes", items: [{ key, action: "fix-ci" }], stop: "prepare" }); await settle();
  const question = { id: "choose", prompt: "Repair or stop?", options: [{ id: "repair", label: "Repair", message: "Repair the fixture." }, { id: "stop", label: "Stop", message: "Stop." }] };
  control.threadStatus = "idle";
  control.threadOutput = "```pr-board-question\n" + JSON.stringify({ version: 1, question }) + "\n```";
  expect((await call("prs_read", { kind: "pr", key })).data).toMatchObject({ marker: { question } });
  expect((await call("prs_act", { kind: "answer-question", key, questionId: "choose", optionId: "invented" })).data).toMatchObject({ error: "operation_refused" });
  expect((await call("prs_act", { kind: "answer-question", key, questionId: "choose", optionId: "repair" })).data).toEqual({ sent: true });
  await expect(harness.behavior.callRpc("answer", { key, questionId: "choose", optionId: "repair" })).rejects.toThrow(/no longer available/);
  expect(control.sent).toBe(1);
});

it("forwards draft review operations and saved model choice through the public companion contract", async () => {
  const { call, remote, harness } = await host();
  await harness.behavior.callRpc("agent_model_set", alternative);
  expect((await call("prs_act", { kind: "start-review", key: review.item.key, projectId: "review-project" })).data).toMatchObject({ item: { threadId: "review-1" } });
  expect(remote.at(-1)).toEqual({ method: "item_start", input: { key: review.item.key, projectId: "review-project", agentModel: alternative } });
  await call("prs_act", { kind: "start-review-batch", keys: [review.item.key], agentModel: DEFAULT_AGENT_MODEL });
  expect(remote.at(-1)).toEqual({ method: "item_batch_start", input: { keys: [review.item.key], agentModel: DEFAULT_AGENT_MODEL } });
  expect((await call("prs_act", { kind: "dismiss-review", key: review.item.key })).data).toMatchObject({ item: { state: "dismissed" } });
});

it("persists a validated shared model, captures one choice per batch, and preserves explicit overrides", async () => {
  const { call, control, harness, settle, bb } = await host();
  expect((await call("prs_read", { kind: "agent-model" })).data).toEqual({ choice: DEFAULT_AGENT_MODEL, routing: { kind: "host", hostId: "checkout-host" } });
  let release = () => {}; control.prepareGate = new Promise<void>((resolve) => { release = resolve; });
  await call("prs_act", { kind: "start-fixes", items: [{ key: "acme/repo#1", action: "fix-ci" }, { key: "acme/repo#2", action: "fix-ci" }], stop: "prepare" });
  await vi.waitFor(() => expect(control.prepareCalls).toBe(1));
  expect((await call("prs_act", { kind: "set-agent-model", ...alternative })).data).toEqual(alternative);
  release(); await settle();
  expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  for (const [spawn] of harness.sdk.callsTo("threads.spawn")) expect(spawn).toMatchObject(DEFAULT_AGENT_MODEL);
  expect(await bb.storage.kv.get("agent-model")).toEqual(alternative);
  expect(harness.realtimeSignals).toContainEqual({ channel: "agent-model-changed", payload: {} });
  await call("prs_act", { kind: "start-fixes", items: [{ key, action: "fix-ci" }], stop: "prepare" }); await settle();
  expect(harness.sdk.callsTo("threads.spawn").at(-1)?.[0]).toMatchObject(alternative);
  await call("prs_act", { kind: "start-fixes", items: [{ key: "acme/repo#8", action: "fix-ci" }], stop: "prepare", agentModel: DEFAULT_AGENT_MODEL }); await settle();
  expect(harness.sdk.callsTo("threads.spawn").at(-1)?.[0]).toMatchObject(DEFAULT_AGENT_MODEL);
  expect(await harness.behavior.callRpc("agent_model_get", null)).toEqual({ choice: alternative, routing: { kind: "host", hostId: "checkout-host" } });
  await expect(harness.behavior.callRpc("agent_model_set", { ...alternative, model: "invented" })).rejects.toThrow(/unavailable/);
  await expect(harness.behavior.callRpc("agent_model_set", { ...alternative, reasoningLevel: "ultra" })).rejects.toThrow(/unavailable/);
  await expect(harness.behavior.callRpc("agent_model_set", { ...alternative, serviceTier: "invented" })).rejects.toThrow(/unavailable/);
  expect(await harness.behavior.callRpc("agent_model_get", null)).toEqual({ choice: alternative, routing: { kind: "host", hostId: "checkout-host" } });
  expect(harness.sdk.callsTo("providers.models").at(-1)?.[0]).toMatchObject({ hostId: "checkout-host", providerId: "codex" });
});

it("cancels preparation and refuses work after disposal without starting threads", async () => {
  const { call, control, harness } = await host();
  const aborted = new AbortController(); aborted.abort();
  expect((await call("prs_act", { kind: "start-fixes", items: [{ key, action: "fix-ci" }], stop: "prepare" }, aborted.signal)).data).toMatchObject({ error: "cancelled" });
  let release = () => {}; control.prepareGate = new Promise<void>((resolve) => { release = resolve; });
  const pending = call("prs_prepare", { key, action: "fix-ci", stop: "prepare" });
  await vi.waitFor(() => expect(control.prepareSignal).not.toBeNull());
  await harness.lifecycle.dispose(); release();
  expect(control.prepareSignal?.aborted).toBe(true);
  expect((await pending).data).toMatchObject({ error: "cancelled" });
  expect(control.spawned).toBe(0);
});

it("accepts a catalog model without reasoning controls and keeps provider refusal side-effect free", async () => {
  const { call, harness, settle, control } = await host();
  const noEffort = { providerId: "codex", model: "gpt-no-effort" };
  expect(await harness.behavior.callRpc("agent_model_set", noEffort)).toEqual(noEffort);
  await call("prs_act", { kind: "start-fixes", items: [{ key, action: "fix-ci" }], stop: "prepare" }); await settle();
  const spawned = harness.sdk.callsTo("threads.spawn").at(-1)?.[0];
  expect(spawned).toMatchObject(noEffort);
  expect(spawned).not.toHaveProperty("reasoningLevel");
  await expect(harness.behavior.callRpc("agent_model_set", { ...noEffort, reasoningLevel: "xhigh" })).rejects.toThrow(/unavailable/);
  control.unavailable = true;
  expect((await call("prs_act", { kind: "start-fixes", items: [{ key: "acme/repo#8", action: "fix-ci" }], stop: "prepare" })).data).toMatchObject({ error: "operation_refused", message: expect.stringContaining("unavailable") });
  expect(control.spawned).toBe(1);
});

it("does not claim or queue a worker when cancellation arrives during catalog validation", async () => {
  const { call, control, harness, board } = await host();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  harness.sdk.stub("providers.models", async () => { await gate; return { modelLoadError: null, providers: [{ id: "codex", available: true }], models: [{ model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }] }; });
  const controller = new AbortController();
  const pending = call("prs_act", { kind: "start-fixes", items: [{ key, action: "fix-ci" }], stop: "prepare" }, controller.signal);
  await vi.waitFor(() => expect(harness.sdk.callsTo("providers.models")).toHaveLength(1));
  controller.abort(); release();
  expect((await pending).data).toMatchObject({ error: "cancelled" });
  expect((await board()).markers).toEqual([]);
  expect(control.spawned).toBe(0);
});

it("normalizes the native picker's standard tier for saved choices, overrides, and review forwarding", async () => {
  const { call, harness, bb, settle, remote } = await host();
  harness.sdk.stub("providers.models", async () => ({ modelLoadError: null, providers: [{ id: "codex", available: true }], models: [{ model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }], supportedServiceTiers: [{ id: "fast" }] }] }));
  const standard = { ...DEFAULT_AGENT_MODEL, serviceTier: "default" };
  expect(await harness.behavior.callRpc("agent_model_set", standard)).toEqual(DEFAULT_AGENT_MODEL);
  expect(await bb.storage.kv.get("agent-model")).toEqual(DEFAULT_AGENT_MODEL);
  await call("prs_act", { kind: "start-fixes", items: [{ key, action: "fix-ci" }], stop: "prepare", agentModel: standard }); await settle();
  expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject(DEFAULT_AGENT_MODEL);
  expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).not.toHaveProperty("serviceTier");
  await call("prs_act", { kind: "start-review", key: review.item.key, agentModel: standard });
  expect(remote.at(-1)).toEqual({ method: "item_start", input: { key: review.item.key, agentModel: DEFAULT_AGENT_MODEL } });
  await call("prs_act", { kind: "start-review-batch", keys: [review.item.key], agentModel: standard });
  expect(remote.at(-1)).toEqual({ method: "item_batch_start", input: { keys: [review.item.key], agentModel: DEFAULT_AGENT_MODEL } });
  const paid = { ...DEFAULT_AGENT_MODEL, serviceTier: "fast" };
  expect(await harness.behavior.callRpc("agent_model_set", paid)).toEqual(paid);
  await call("prs_act", { kind: "start-fixes", items: [{ key: "acme/repo#8", action: "fix-ci" }], stop: "prepare" }); await settle();
  expect(harness.sdk.callsTo("threads.spawn").at(-1)?.[0]).toMatchObject(paid);
});
