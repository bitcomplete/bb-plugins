import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "./server.js";
import { viewSchema } from "./types.js";
import { comment, fixture, transportFor } from "./fixtures.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function setup(settings: Record<string, unknown> = {}) {
  const data = [fixture(), fixture(2)]; let fail = false;
  const host = createFakePluginHost({ pluginId: "pr-inbox", settings: { project: "project-test", ...settings }, sdk: { threads: {
    spawn: async () => makeThreadResponse({ id: "thread-address" }),
    get: async () => makeThreadResponse({ id: "thread-address", status: "idle" }),
  } } });
  cleanup.push(() => host.harness.lifecycle.dispose());
  host.harness.inspection.sdk.stub("projects.get", async ({ projectId }) => ({
    id: projectId, sources: [
      { hostId: "server-host", path: "/wrong-checkout", isDefault: false },
      { hostId: projectId === "project-parsley" ? "parsley-host" : "devbox-host", path: projectId === "project-parsley" ? "/home/dev/parsley" : "/project-checkout", isDefault: true },
    ],
  }));
  host.harness.inspection.sdk.stub("projects.list", async () => [
    { id: "project-test", name: "Default", sources: [{ isDefault: true }] },
    { id: "project-parsley", name: "Parsley", sources: [{ isDefault: true }] },
  ]);
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

describe("My PRs behavior", () => {
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
    expect(calls[0]?.[0]).toMatchObject({ environment: { type: "host", hostId: "devbox-host", workspace: { type: "unmanaged", path: "/project-checkout" } } });
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
    const scan = await experimental_scanPublicSdkOnly(import.meta.dirname, { allow: [/^react-dom$/, /^@radix-ui\/react-dialog$/, /^react$/, /^@testing-library\/react$/, /^@radix-ui\/react-slot$/, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/] });
    expect(scan.violations).toEqual([]); expect(scan.privateDependencies).toEqual([]);
  });
});

it("persists holds through reload and new feedback, blocks dispatch, then expires automatically", async () => {
  const env = await setup();
  const selection = await firstSelection(env);
  const until = new Date(Date.now() + 3_600_000).toISOString();
  await env.rpc("hold", { ...selection, until });
  await expect(env.rpc("address", { items: [selection] })).rejects.toThrow("on hold");
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  const next = await env.harness.lifecycle.reload(env.factory);
  cleanup.push(() => next.harness.lifecycle.dispose());
  env.data[0]?.comments.push(comment());
  await next.harness.behavior.callRpc("poll_now", null);
  const read = async () => viewSchema.parse(await next.harness.behavior.callRpc("inbox_get", null));
  expect((await read()).rows.find((row) => row.id === selection.id)?.holdUntil).toBe(until);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  try { expect((await read()).rows.find((row) => row.id === selection.id)?.holdUntil).toBeNull(); }
  finally { clock.mockRestore(); }
});

it("validates hold times and stale activity, and allows early resume", async () => {
  const env = await setup(); const selection = await firstSelection(env);
  await expect(env.rpc("hold", { ...selection, until: "2000-01-01T00:00:00Z" })).rejects.toThrow("future");
  await expect(env.rpc("hold", { ...selection, until: "not a date" })).rejects.toThrow();
  await expect(env.rpc("hold", { ...selection, activity: "stale", until: null })).rejects.toThrow("changed");
  await env.rpc("hold", { ...selection, until: "2099-01-01T00:00:00Z" });
  await env.rpc("hold", { ...selection, until: null });
  expect((await env.view()).rows.find((row) => row.id === selection.id)?.holdUntil).toBeNull();
  expect(await env.rpc("address", { items: [selection] })).toEqual({ threadId: "thread-address" });
});

it("reads saved state from before holds were introduced without losing dismissal or dispatch", async () => {
  const env = await setup(); const selection = await firstSelection(env);
  env.bb.storage.database().prepare("INSERT OR REPLACE INTO inbox_state (id, body) VALUES (?, ?)").run(selection.id,
    JSON.stringify({ dismissedActivity: selection.activity, dispatch: { kind: "linked", threadId: "thread-address" } }));
  expect((await env.view()).rows.find((row) => row.id === selection.id)).toMatchObject({
    holdUntil: null, dismissed: true, dispatch: { kind: "linked", threadId: "thread-address" },
  });
});

it("targets the selected project and its remote machine when addressing feedback", async () => {
  const env = await setup(); const selection = await firstSelection(env);
  await env.rpc("address", { items: [selection], projectId: "project-parsley" });
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    projectId: "project-parsley", environment: { type: "host", hostId: "parsley-host", workspace: { type: "unmanaged", path: "/home/dev/parsley" } },
  });
});

it("preselects the organization mapping and uses it for CLI-style starts", async () => {
  const env = await setup({ organizationProjects: '{"EXAMPLE":"project-parsley"}' });
  const selection = await firstSelection(env);
  expect(await env.rpc("address_targets", { items: [selection] })).toMatchObject({ projectId: "project-parsley", reason: "organization" });
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  await env.rpc("address", { items: [selection] });
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ projectId: "project-parsley", environment: { hostId: "parsley-host" } });
});

it("requires a project for mixed mappings and handles missing project checkouts before marking dispatch", async () => {
  const env = await setup({ organizationProjects: '{"example":"project-parsley"}' });
  const second = env.data[1]; if (!second) throw new Error("Missing second PR");
  second.pr.repository.nameWithOwner = "other/editor";
  await env.rpc("poll_now", null);
  const items = (await env.view()).rows.map(({ id, activity }) => ({ id, activity }));
  expect(await env.rpc("address_targets", { items })).toMatchObject({ projectId: null, reason: "mixed" });
  await expect(env.rpc("address", { items })).rejects.toThrow("Choose one project");
  env.harness.inspection.sdk.stub("projects.get", async () => ({ id: "project-test", sources: [] }));
  await expect(env.rpc("address", { items, projectId: "project-test" })).rejects.toThrow("default project checkout");
  expect((await env.view()).rows.every((row) => row.dispatch.kind === "none")).toBe(true);
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("allows a manual project without a default and offers a choice if a mapped project was deleted", async () => {
  const env = await setup({ project: undefined, organizationProjects: '{"example":"project-deleted"}' });
  const selection = await firstSelection(env);
  expect(await env.rpc("address_targets", { items: [selection] })).toMatchObject({ projectId: null, reason: "choose" });
  await env.rpc("address", { items: [selection], projectId: "project-parsley" });
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ projectId: "project-parsley" });
});
