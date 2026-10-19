import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "./server.js";
import { viewSchema } from "./types.js";
import { comment, fixture, transportFor } from "./fixtures.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function setup() {
  const data = [fixture(), fixture(2)]; let fail = false;
  const host = createFakePluginHost({ pluginId: "pr-inbox", settings: { project: "project-test" }, sdk: { threads: {
    spawn: async () => makeThreadResponse({ id: "thread-address" }),
    get: async () => makeThreadResponse({ id: "thread-address", status: "idle" }),
  } } });
  cleanup.push(() => host.harness.lifecycle.dispose());
  const base = transportFor(() => data);
  const factory = createPlugin({ transport: (query, variables, signal) => { if (fail) throw new Error("GitHub unavailable"); return base(query, variables, signal); } });
  await factory(host.bb);
  const rpc = host.harness.behavior.callRpc;
  const view = async () => viewSchema.parse(await rpc("inbox_get", null));
  await rpc("poll_now", null);
  return { ...host, data, rpc, view, factory, fail: () => { fail = true; } };
}
const firstSelection = async (env: Awaited<ReturnType<typeof setup>>) => {
  const row = (await env.view()).rows[0]; if (!row) throw new Error("Expected a PR"); return { id: row.id, activity: row.activity };
};

describe("PR Feedback behavior", () => {
  it("polling never starts work; dismissal survives reload and a new human comment restores the row", async () => {
    const env = await setup(); const selection = await firstSelection(env);
    expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    await env.rpc("dismiss", { ...selection, dismissed: true });
    expect((await env.view()).rows[0]?.dismissed).toBe(true);
    const next = await env.harness.lifecycle.reload(env.factory);
    cleanup.push(() => next.harness.lifecycle.dispose());
    expect(viewSchema.parse(await next.harness.behavior.callRpc("inbox_get", null)).rows[0]?.dismissed).toBe(true);
    env.data[0]?.comments.push(comment());
    await next.harness.behavior.callRpc("poll_now", null);
    expect(viewSchema.parse(await next.harness.behavior.callRpc("inbox_get", null)).rows[0]?.dismissed).toBe(false);
  });
  it("starts one batch thread from selected PRs, retains its links, and blocks duplicates", async () => {
    const env = await setup(); const items = (await env.view()).rows.map(({ id, activity }) => ({ id, activity }));
    expect(await env.rpc("address", { items })).toEqual({ threadId: "thread-address" });
    const calls = env.harness.inspection.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).toContain("https://github.com/example/editor/pull/1");
    expect(JSON.stringify(calls)).toContain("Never merge");
    expect((await env.view()).rows.map((row) => row.dispatch)).toEqual([{ kind: "linked", threadId: "thread-address" }, { kind: "linked", threadId: "thread-address" }]);
    await expect(env.rpc("address", { items })).rejects.toThrow("already has a dispatch");
    expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
  it("revalidates selected heads and keeps cached rows on GitHub failure without dispatching", async () => {
    const env = await setup(); const item = await firstSelection(env);
    if (env.data[0]) env.data[0].pr.headRefOid = "b".repeat(40);
    await expect(env.rpc("address", { items: [item] })).rejects.toThrow("changed");
    const before = await env.view(); env.fail();
    await env.rpc("poll_now", null);
    expect((await env.view()).rows).toEqual(before.rows);
    expect((await env.view()).poll?.error).toContain("GitHub unavailable");
    await expect(env.rpc("address", { items: [await firstSelection(env)] })).rejects.toThrow("Could not verify");
    expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });
  it("marks ambiguous spawn failures and requires an explicit clear before another attempt", async () => {
    const env = await setup(); const item = await firstSelection(env);
    env.harness.inspection.sdk.stub("threads.spawn", async () => { throw new Error("Connection lost"); });
    await expect(env.rpc("address", { items: [item] })).rejects.toThrow("Connection lost");
    expect((await env.view()).rows[0]?.dispatch.kind).toBe("uncertain");
    await expect(env.rpc("address", { items: [item] })).rejects.toThrow("already has a dispatch");
    await env.rpc("clear_dispatch", { id: item.id });
    expect((await env.view()).rows[0]?.dispatch.kind).toBe("none");
  });
  it("two simultaneous clicks start at most one thread", async () => {
    const env = await setup(); const item = await firstSelection(env);
    const outcomes = await Promise.allSettled([env.rpc("address", { items: [item] }), env.rpc("address", { items: [item] })]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
  it("aborts an in-flight GitHub read when the background service stops", async () => {
    const host = createFakePluginHost({ pluginId: "pr-inbox", settings: { project: "project-test" } });
    cleanup.push(() => host.harness.lifecycle.dispose());
    let ready = () => {};
    const started = new Promise<void>((resolve) => { ready = resolve; });
    await createPlugin({ transport: (_query, _variables, signal) => new Promise((_resolve, reject) => {
      if (!signal) throw new Error("Expected cancellation signal");
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      ready();
    }) })(host.bb);
    const service = host.harness.behavior.runService("poll");
    await started;
    service.controller.abort();
    await service.done;
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });
  it("uses only the public plugin SDK and package-local source", async () => {
    const scan = await experimental_scanPublicSdkOnly(import.meta.dirname, { allow: [/^react$/, /^@testing-library\/react$/, /^@radix-ui\/react-slot$/, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/] });
    expect(scan.violations).toEqual([]); expect(scan.privateDependencies).toEqual([]);
  });
});
