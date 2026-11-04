import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { createPlugin, rpcContract } from "./server.js";
import { GithubRateLimitError, type Transport } from "./github.js";
import { pollSchema, viewSchema, type Selection } from "./types.js";
import { actor, comment, fixture, transportFor, type Fixture } from "./fixtures.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function setup(settings: Record<string, unknown> = {}) {
  const data = [fixture(), fixture(2)]; let fail = false;
  const host = createFakePluginHost({ pluginId: "my-prs", settings: { project: "project-test", ...settings }, sdk: { plugins: {
    list: async () => ({ plugins: [] }),
  }, threads: {
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
  const reads: { query: string; id?: string }[] = [];
  let github = base;
  const factory = createPlugin({ transport: (query, variables, signal) => { reads.push({ query, id: variables.id }); if (fail) throw new Error("GitHub unavailable"); return github(query, variables, signal); } });
  await factory(host.bb);
  const rpc = host.harness.behavior.callRpc;
  const view = async () => viewSchema.parse(await rpc("prs_get", null));
  await rpc("poll_now", null);
  return { ...host, data, rpc, view, factory, reads, base, useGithub: (next: Transport) => { github = next; }, fail: () => { fail = true; } };
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
    expect(viewSchema.parse(await next.harness.behavior.callRpc("prs_get", null)).rows[0]?.dismissed).toBe(true);
    env.data[0]?.comments.push(comment());
    await next.harness.behavior.callRpc("poll_now", null);
    expect(viewSchema.parse(await next.harness.behavior.callRpc("prs_get", null)).rows[0]?.dismissed).toBe(false);
  });
  it("starts one batch thread from selected PRs and allows explicitly regrouping linked PRs", async () => {
    const env = await setup(); const items = (await env.view()).rows.map(({ id, activity }) => ({ id, activity }));
    expect(await env.rpc("address", { items })).toEqual({ threadId: "thread-address" });
    const calls = env.harness.inspection.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({ environment: { type: "host", hostId: "devbox-host", workspace: { type: "unmanaged", path: "/project-checkout" } } });
    expect(JSON.stringify(calls)).toContain("https://github.com/example/editor/pull/1");
    expect(JSON.stringify(calls)).toContain("Never merge");
    expect((await env.view()).rows.map((row) => row.dispatch)).toEqual([{ kind: "linked", threadId: "thread-address" }, { kind: "linked", threadId: "thread-address" }]);
    env.harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thread-address", status: "active" }));
    await env.rpc("address", { items });
    expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  });
  it("reads each shared batch thread only once per snapshot", async () => {
    const env = await setup();
    const items = (await env.view()).rows.map(({ id, activity }) => ({ id, activity }));
    await env.rpc("address", { items });
    const before = env.harness.inspection.sdk.callsTo("threads.get").length;
    expect((await env.view()).rows.map((row) => row.threadStatus)).toEqual(["idle", "idle"]);
    expect(env.harness.inspection.sdk.callsTo("threads.get").length - before).toBe(1);
  });
  it("retains a known open PR when GitHub search temporarily omits it", async () => {
    const data = [fixture(1), fixture(2)];
    const base = transportFor(() => data);
    let omit = false;
    const host = createFakePluginHost({ pluginId: "my-prs" });
    cleanup.push(() => host.harness.lifecycle.dispose());
    await createPlugin({ transport: (query, variables, signal) => {
      if (omit && query.includes("search(")) return Promise.resolve({ search: { nodes: [data[0]?.pr], issueCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null } } });
      return base(query, variables, signal);
    } })(host.bb);
    await host.harness.behavior.callRpc("poll_now", null);
    omit = true;
    await host.harness.behavior.callRpc("poll_now", null);
    const view = viewSchema.parse(await host.harness.behavior.callRpc("prs_get", null));
    expect(view.rows.map((row) => row.id)).toEqual(["PR_1", "PR_2"]);
    expect(view.poll?.error).toBeNull();
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
    const host = createFakePluginHost({ pluginId: "my-prs", settings: { project: "project-test" } });
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

it("persists holds through reload and explicit dispatch, then expires automatically", async () => {
  const env = await setup();
  const selection = await firstSelection(env);
  const until = new Date(Date.now() + 3_600_000).toISOString();
  await env.rpc("hold", { ...selection, until });
  expect(await env.rpc("address", { items: [selection] })).toEqual({ threadId: "thread-address" });
  expect((await env.view()).rows.find((row) => row.id === selection.id)?.holdUntil).toBe(until);
  const next = await env.harness.lifecycle.reload(env.factory);
  cleanup.push(() => next.harness.lifecycle.dispose());
  env.data[0]?.comments.push(comment());
  await next.harness.behavior.callRpc("poll_now", null);
  const read = async () => viewSchema.parse(await next.harness.behavior.callRpc("prs_get", null));
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
  env.bb.storage.database().prepare("INSERT OR REPLACE INTO prs_state (id, body) VALUES (?, ?)").run(selection.id,
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

it("provisions a multi-repo workspace on the selected project's machine", async () => {
  const env = await setup(); const selection = await firstSelection(env);
  env.harness.inspection.sdk.stub("plugins.list", async () => ({ plugins: [{ id: "multi-repo", enabled: true }] }));
  env.harness.inspection.sdk.stub("plugins.callRpc", async () => ({ reposJson: '{"version":1,"repos":[]}', error: null }));
  await env.rpc("address", { items: [selection], projectId: "project-parsley" });
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    projectId: "project-parsley",
    environment: {
      type: "provider", environmentProviderId: "multi-repo-workspace", inputs: null,
      machine: { type: "existing", hostId: "parsley-host" },
    },
  });
  expect(env.harness.inspection.sdk.callsTo("plugins.callRpc")[0]?.[0]).toMatchObject({
    pluginId: "multi-repo", method: "repoSet", input: { projectId: "project-parsley" },
  });
});

it("keeps a native checkout when the multi-repo plugin has no repo set for the project", async () => {
  const env = await setup(); const selection = await firstSelection(env);
  env.harness.inspection.sdk.stub("plugins.list", async () => ({ plugins: [{ id: "multi-repo", enabled: true }] }));
  env.harness.inspection.sdk.stub("plugins.callRpc", async () => ({ reposJson: null, error: null }));
  await env.rpc("address", { items: [selection] });
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    environment: { type: "host", hostId: "devbox-host", workspace: { type: "unmanaged", path: "/project-checkout" } },
  });
});

it("does not dispatch into a native checkout when reading the multi-repo configuration fails", async () => {
  const env = await setup(); const selection = await firstSelection(env);
  env.harness.inspection.sdk.stub("plugins.list", async () => ({ plugins: [{ id: "multi-repo", enabled: true }] }));
  env.harness.inspection.sdk.stub("plugins.callRpc", async () => ({ reposJson: null, error: "Invalid repos.json" }));
  await expect(env.rpc("address", { items: [selection] })).rejects.toThrow("Invalid repos.json");
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect((await env.view()).rows.every((row) => row.dispatch.kind === "none")).toBe(true);
  env.harness.inspection.sdk.stub("plugins.callRpc", async () => { throw new Error("Project machine disconnected"); });
  await expect(env.rpc("address", { items: [selection] })).rejects.toThrow("Project machine disconnected");
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
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


it("Address verifies only selected PRs and leaves unrelated cached rows intact", async () => {
  const env = await setup(); const item = await firstSelection(env);
  const unrelated = (await env.view()).rows.find((row) => row.id !== item.id);
  env.reads.length = 0;
  await env.rpc("address", { items: [item] });
  expect(env.reads.some((read) => read.query.includes("search("))).toBe(false);
  expect(env.reads.filter((read) => read.id && read.id !== item.id)).toEqual([]);
  expect((await env.view()).rows.find((row) => row.id === unrelated?.id)).toEqual(unrelated);
});


it("keeps the snapshot and suspends GitHub reads until reset, including after reload", async () => {
  const env = await setup(); const before = await env.view(); const item = await firstSelection(env);
  const reset = Date.now() + 3_600_000;
  const reads = vi.fn<Transport>(async () => { throw new GithubRateLimitError(new Date(reset).toISOString()); });
  const factory = createPlugin({ transport: reads });
  const next = await env.harness.lifecycle.reload(factory);
  cleanup.push(() => next.harness.lifecycle.dispose());
  const poll = await next.harness.behavior.callRpc("poll_now", null);
  expect(poll).toMatchObject({ error: expect.stringContaining("Try again after"), retryAt: expect.any(String) });
  expect(viewSchema.parse(await next.harness.behavior.callRpc("prs_get", null)).rows).toEqual(before.rows);
  await next.harness.behavior.callRpc("poll_now", null);
  next.harness.inspection.sdk.stub("projects.get", async () => ({ sources: [{ hostId: "devbox-host", path: "/project-checkout", isDefault: true }] }));
  await expect(next.harness.behavior.callRpc("address", { items: [item] })).rejects.toThrow("Try again after");
  expect(reads).toHaveBeenCalledTimes(1);
  const reloaded = await next.harness.lifecycle.reload(factory);
  cleanup.push(() => reloaded.harness.lifecycle.dispose());
  await reloaded.harness.behavior.callRpc("poll_now", null);
  expect(reads).toHaveBeenCalledTimes(1);
  reads.mockImplementation(transportFor(() => env.data));
  const clock = vi.spyOn(Date, "now").mockReturnValue(reset + 1);
  try { expect(await reloaded.harness.behavior.callRpc("poll_now", null)).toMatchObject({ error: null, retryAt: null }); }
  finally { clock.mockRestore(); }
  expect(reads.mock.calls.length).toBeGreaterThan(1);
});


it("starts one thread for approved, conflicting, CI-failing, waiting, draft, dismissed, and held PRs", async () => {
  const env = await setup();
  const approved = fixture(3); approved.reviews = []; approved.pr.reviewDecision = "APPROVED";
  const conflict = fixture(4); conflict.reviews = []; conflict.pr.mergeable = "CONFLICTING";
  const failing = fixture(5); failing.reviews = []; failing.pr.commits.nodes = [{ commit: { committedDate: approved.pr.updatedAt, statusCheckRollup: { state: "FAILURE" } } }];
  const waiting = fixture(6); waiting.reviews = [];
  const draft = fixture(7); draft.reviews = []; draft.pr.isDraft = true;
  env.data.push(approved, conflict, failing, waiting, draft);
  await env.rpc("poll_now", null);
  const rows = (await env.view()).rows;
  const first = rows.find((row) => row.id === "PR_1"), second = rows.find((row) => row.id === "PR_2");
  if (!first || !second) throw new Error("Missing feedback PRs");
  await env.rpc("dismiss", { id: first.id, activity: first.activity, dismissed: true });
  await env.rpc("hold", { id: second.id, activity: second.activity, until: "2099-01-01T00:00:00Z" });
  expect(await env.rpc("address", { items: rows.map(({ id, activity }) => ({ id, activity })) })).toEqual({ threadId: "thread-address" });
  const calls = env.harness.inspection.sdk.callsTo("threads.spawn");
  expect(calls).toHaveLength(1);
  const spawned = calls[0]?.[0];
  expect(spawned).toMatchObject({ pluginMetadata: { prs: rows.map((row) => row.url) } });
  expect(spawned).toHaveProperty("prompt", expect.stringContaining("Review: APPROVED"));
  expect(spawned).toHaveProperty("prompt", expect.stringContaining("Mergeability: CONFLICTING"));
  expect(spawned).toHaveProperty("prompt", expect.stringContaining("Checks: FAILURE"));
  expect(spawned).toHaveProperty("prompt", expect.stringContaining("resolve merge conflicts"));
  expect(spawned).toHaveProperty("prompt", expect.stringContaining("Do not invent changes"));
  expect(spawned).not.toHaveProperty("prompt", expect.stringContaining("undefined"));
  expect((await env.view()).rows.find((row) => row.id === first.id)?.dismissed).toBe(true);
  expect((await env.view()).rows.find((row) => row.id === second.id)?.holdUntil).toBe("2099-01-01T00:00:00Z");
});

it("rejects a delayed overlapping start after another request has already linked its thread", async () => {
  const env = await setup();
  const item = await firstSelection(env);
  let release = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let started = () => {};
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let gets = 0;
  env.harness.inspection.sdk.stub("projects.get", async () => {
    if (++gets === 2) { started(); await waiting; }
    return { id: "project-test", sources: [{ hostId: "devbox-host", path: "/project-checkout", isDefault: true }] };
  });
  const first = env.rpc("address", { items: [item] });
  const second = env.rpc("address", { items: [item] });
  const rejected = expect(second).rejects.toThrow("already has a dispatch");
  await ready;
  await first;
  release();
  await rejected;
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

describe("closing selected PRs", () => {
  type Env = Awaited<ReturnType<typeof setup>>;
  const closes = (env: Env) => env.reads.filter((read) => read.query.includes("closePullRequest")).map((read) => read.id);
  const listed = async (env: Env) => (await env.view()).rows.map((row) => row.id);
  const selections = async (env: Env) => (await env.view()).rows.map(({ id, activity }) => ({ id, activity }));
  const closePrs = async (env: Env, items: Selection[]) => rpcContract.close_prs.output.parse(await env.rpc("close_prs", { items })).results;
  function gate() {
    let open = () => {};
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { opened, open };
  }
  /** Blocks the first read of a PR, so a test can complete a close while that read is outstanding. */
  function holdFirstRead(env: Env, id: string) {
    const hold = gate();
    let held = false;
    env.useGithub(async (query, variables, signal) => {
      if (!held && variables.id === id && query.includes("viewer { login }")) { held = true; await hold.opened; }
      return env.base(query, variables, signal);
    });
    return hold;
  }
  function holdCloses(env: Env) {
    const hold = gate();
    env.useGithub(async (query, variables, signal) => {
      if (query.includes("closePullRequest")) await hold.opened;
      return env.base(query, variables, signal);
    });
    return hold;
  }

  it("verifies each PR directly before closing it, keeps partial successes, and removes only confirmed rows", async () => {
    const env = await setup(); env.data.push(fixture(3));
    await env.rpc("poll_now", null);
    const items = await selections(env);
    env.useGithub((query, variables, signal) => query.includes("closePullRequest") && variables.id === "PR_2"
      ? Promise.reject(new Error("Resource not accessible")) : env.base(query, variables, signal));
    env.reads.length = 0; env.harness.inspection.realtimeSignals.length = 0;
    expect(await closePrs(env, items)).toEqual([
      { id: "PR_1", kind: "closed" },
      { id: "PR_2", kind: "failed", message: expect.stringContaining("Resource not accessible") },
      { id: "PR_3", kind: "closed" },
    ]);
    expect(env.reads.map((read) => read.id)).toEqual(["PR_1", "PR_1", "PR_1", "PR_2", "PR_2", "PR_2", "PR_3", "PR_3", "PR_3"]);
    expect(await listed(env)).toEqual(["PR_2"]);
    expect(env.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "prs-changed")).toHaveLength(2);
    expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("rejects empty, oversized, and duplicate selections before reading GitHub", async () => {
    const env = await setup(); const item = await firstSelection(env);
    env.reads.length = 0;
    await expect(env.rpc("close_prs", { items: [] })).rejects.toThrow();
    await expect(env.rpc("close_prs", { items: Array.from({ length: 21 }, (_, index) => ({ ...item, id: `PR_${index}` })) })).rejects.toThrow();
    await expect(env.rpc("close_prs", { items: [item, item] })).rejects.toThrow("Select each PR once");
    expect(env.reads).toEqual([]);
  });

  it("does not read GitHub for a selection that no longer matches the cached row", async () => {
    const env = await setup(); const item = await firstSelection(env);
    env.reads.length = 0;
    expect(await closePrs(env, [{ ...item, activity: "stale" }, { id: "PR_unknown", activity: item.activity }])).toEqual([
      { id: item.id, kind: "failed", message: expect.stringContaining("changed") },
      { id: "PR_unknown", kind: "failed", message: expect.stringContaining("changed") },
    ]);
    expect(env.reads).toEqual([]);
  });

  it.each<[string, (pr: Fixture) => void]>([
    ["closed on GitHub", (pr) => { pr.state = "CLOSED"; }],
    ["merged on GitHub", (pr) => { pr.state = "MERGED"; }],
    ["authored by someone else", (pr) => { pr.pr.author = actor("someone-else"); }],
    ["outside the repository allowlist", (pr) => { pr.pr.repository.nameWithOwner = "other/editor"; }],
  ])("does not close a PR %s, and removes it from the list", async (_name, change) => {
    const env = await setup({ repoAllowlist: "example/editor" }); const item = await firstSelection(env);
    const pr = env.data[0]; if (!pr) throw new Error("Missing PR");
    change(pr);
    env.harness.inspection.realtimeSignals.length = 0;
    expect(await closePrs(env, [item])).toEqual([{ id: item.id, kind: "failed", message: expect.stringContaining("removed it from the list") }]);
    expect(closes(env)).toEqual([]);
    expect(await listed(env)).toEqual(["PR_2"]);
    expect(env.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "prs-changed")).toHaveLength(1);
  });

  it.each<[string, (pr: Fixture) => void]>([
    ["pushed after selection", (pr) => { pr.pr.headRefOid = "b".repeat(40); }],
    ["given new human feedback after selection", (pr) => { pr.comments.push(comment()); }],
  ])("does not close a PR %s, and keeps it listed", async (_name, change) => {
    const env = await setup(); const item = await firstSelection(env);
    const pr = env.data[0]; if (!pr) throw new Error("Missing PR");
    change(pr);
    expect(await closePrs(env, [item])).toEqual([{ id: item.id, kind: "failed", message: expect.stringContaining("changed on GitHub") }]);
    expect(closes(env)).toEqual([]);
    expect(await listed(env)).toContain(item.id);
  });

  it.each<[string, () => Promise<unknown>]>([
    ["rejects the request", () => Promise.reject(new Error("Bad credentials"))],
    ["returns another PR", async () => ({ closePullRequest: { pullRequest: { id: "PR_other", state: "CLOSED" } } })],
    ["leaves the PR open", async () => ({ closePullRequest: { pullRequest: { id: "PR_1", state: "OPEN" } } })],
    ["returns no PR", async () => ({ closePullRequest: null })],
  ])("keeps the row and allows an explicit retry when GitHub %s", async (_name, respond) => {
    const env = await setup(); const item = await firstSelection(env);
    env.useGithub((query, variables, signal) => query.includes("closePullRequest") ? respond() : env.base(query, variables, signal));
    expect(await closePrs(env, [item])).toEqual([{ id: item.id, kind: "failed", message: expect.stringContaining("Refresh GitHub before you retry") }]);
    expect(closes(env)).toEqual([item.id]);
    expect(await listed(env)).toContain(item.id);
    env.useGithub(env.base);
    expect(await closePrs(env, [item])).toEqual([{ id: item.id, kind: "closed" }]);
  });

  it("makes no further GitHub requests in a batch after a rate limit", async () => {
    const env = await setup(); const items = await selections(env);
    env.useGithub(async (query, variables, signal) => {
      if (query.includes("closePullRequest")) throw new GithubRateLimitError(new Date(Date.now() + 3_600_000).toISOString());
      return env.base(query, variables, signal);
    });
    env.reads.length = 0;
    const results = await closePrs(env, items);
    expect(results.map((result) => result.kind)).toEqual(["failed", "failed"]);
    expect(env.reads.filter((read) => read.id === "PR_2")).toEqual([]);
  });

  it("does not close a PR after GitHub settings change during its verification", async () => {
    const env = await setup(); const item = await firstSelection(env);
    const hold = holdFirstRead(env, item.id);
    env.reads.length = 0;
    const closing = closePrs(env, [item]);
    await vi.waitFor(() => expect(env.reads).toHaveLength(1));
    await env.harness.behavior.setSettings({ repoAllowlist: "example/editor" });
    hold.open();
    expect(await closing).toEqual([{ id: item.id, kind: "failed", message: expect.stringContaining("settings changed") }]);
    expect(closes(env)).toEqual([]);
  });

  it("sends one mutation for simultaneous requests while unrelated selections proceed", async () => {
    const env = await setup(); const [first, second] = await selections(env);
    if (!first || !second) throw new Error("Expected two PRs");
    const hold = holdCloses(env);
    const original = closePrs(env, [first]);
    await vi.waitFor(() => expect(closes(env)).toEqual([first.id]));
    const overlapping = closePrs(env, [first, second]);
    await vi.waitFor(() => expect(closes(env)).toEqual([first.id, second.id]));
    hold.open();
    expect(await original).toEqual([{ id: first.id, kind: "closed" }]);
    expect(await overlapping).toEqual([
      { id: first.id, kind: "failed", message: expect.stringContaining("in progress") },
      { id: second.id, kind: "closed" },
    ]);
    expect(closes(env)).toEqual([first.id, second.id]);
  });

  it("refuses to close a PR while its Address thread is starting", async () => {
    const env = await setup(); const item = await firstSelection(env);
    const hold = gate();
    env.harness.inspection.sdk.stub("threads.spawn", async () => { await hold.opened; return makeThreadResponse({ id: "thread-address" }); });
    const starting = env.rpc("address", { items: [item] });
    await vi.waitFor(() => expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
    expect(await closePrs(env, [item])).toEqual([{ id: item.id, kind: "failed", message: expect.stringContaining("in progress") }]);
    expect(closes(env)).toEqual([]);
    hold.open();
    await starting;
  });

  it("refuses to start an Address thread for a PR that is closing", async () => {
    const env = await setup(); const item = await firstSelection(env);
    const hold = holdCloses(env);
    const closing = closePrs(env, [item]);
    await vi.waitFor(() => expect(closes(env)).toEqual([item.id]));
    await expect(env.rpc("address", { items: [item] })).rejects.toThrow("closing");
    hold.open();
    expect(await closing).toEqual([{ id: item.id, kind: "closed" }]);
    expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it.each<[string, (env: Env) => void, string]>([
    ["confirmed as closed", () => {}, "closed"],
    ["no longer eligible", (env) => { const pr = env.data[0]; if (pr) pr.state = "CLOSED"; }, "failed"],
  ])("does not let an older poll restore a row %s, yet applies its other changes and later reads", async (_name, change, kind) => {
    const env = await setup(); const item = await firstSelection(env);
    const hold = holdFirstRead(env, "PR_2");
    await env.bb.storage.kv.set("poll", { at: "2020-01-01T00:00:00.000Z", login: "me", error: null, lastSuccess: "2020-01-01T00:00:00.000Z", retryAt: null });
    env.reads.length = 0;
    const overlapping = env.rpc("poll_now", null);
    const joined = env.rpc("poll_now", null);
    await vi.waitFor(() => expect(env.reads.some((read) => read.id === item.id && read.query.includes("state headRefOid"))).toBe(true));
    change(env);
    const pr = env.data[1]; if (!pr) throw new Error("Missing PR");
    pr.pr.title = "Retitled during the poll";
    expect((await closePrs(env, [item]))[0]?.kind).toBe(kind);
    hold.open();
    const result = pollSchema.parse(await overlapping);
    expect(await joined).toEqual(result);
    expect(result.error).toBeNull();
    expect(result.lastSuccess).not.toBe("2020-01-01T00:00:00.000Z");
    expect((await env.view()).rows.map((row) => [row.id, row.title])).toEqual([["PR_2", "Retitled during the poll"]]);
    const reopened = env.data[0]; if (!reopened) throw new Error("Missing PR");
    reopened.state = "OPEN";
    await env.rpc("poll_now", null);
    expect(await listed(env)).toEqual([item.id, "PR_2"]);
  });

  it("does not let Address verification restore a selected row that closed while it ran", async () => {
    const env = await setup(); const items = await selections(env);
    const [first] = items; if (!first) throw new Error("Expected a PR");
    const hold = holdFirstRead(env, "PR_2");
    env.reads.length = 0;
    const rejected = expect(env.rpc("address", { items })).rejects.toThrow("changed");
    await vi.waitFor(() => expect(env.reads.some((read) => read.id === "PR_2")).toBe(true));
    expect(await closePrs(env, [first])).toEqual([{ id: first.id, kind: "closed" }]);
    hold.open();
    await rejected;
    expect(await listed(env)).toEqual(["PR_2"]);
    expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("lets Address finish when an unrelated PR closes during its verification", async () => {
    const env = await setup(); const [first, second] = await selections(env);
    if (!first || !second) throw new Error("Expected two PRs");
    const hold = holdFirstRead(env, first.id);
    env.reads.length = 0;
    const starting = env.rpc("address", { items: [first] });
    await vi.waitFor(() => expect(env.reads.some((read) => read.id === first.id)).toBe(true));
    expect(await closePrs(env, [second])).toEqual([{ id: second.id, kind: "closed" }]);
    hold.open();
    expect(await starting).toEqual({ threadId: "thread-address" });
    expect(await listed(env)).toEqual([first.id]);
  });
});
