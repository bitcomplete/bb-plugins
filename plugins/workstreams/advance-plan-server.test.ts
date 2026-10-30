import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { inkwellInventoryPrs } from "./inkwell-fixtures.js";
import { createEffortStore } from "./effort-store.js";
import type { AdvanceSnapshot } from "./advance-plan.js";
import type { RawUnit } from "./contract.js";
import plugin, { rpcContract } from "./server.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup() {
  const prs = inkwellInventoryPrs().filter((p) => [340, 330, 305].includes(p.number));
  const units: RawUnit[] = [{ path: "/synthetic/folio", dirName: "folio", repo: "inkwell/folio", githubRepo: "inkwell/folio", branch: "main", dirty: false, ahead: 0, behind: 0,
    lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } }];
  const hostCalls: string[] = [], files = new Map<string, string>(), threads = new Map<string, ReturnType<typeof makeThreadResponse>>(), metadata = new Map<string, Record<string, unknown>>();
  const spawn = vi.fn(async (args: { projectId: string; title: string; prompt: string; pluginMetadata?: Record<string, unknown> }) => {
    const thread = makeThreadResponse({ id: `thr-plan-${threads.size}`, projectId: args.projectId, title: args.title });
    threads.set(thread.id, thread); metadata.set(thread.id, args.pluginMetadata ?? {}); return thread;
  });
  const write = vi.fn(async ({ path, content }: { path: string; content: string }) => {
    if (files.has(path)) return { outcome: "conflict" as const };
    files.set(path, content); return { outcome: "written", sha256: createHash("sha256").update(content).digest("hex") };
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/synthetic" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-synthetic" }) as never },
    projects: { list: async () => [{ id: "proj-synthetic", name: "Folio", sources: [{ hostId: "host-synthetic", path: "/synthetic" }] }] as never },
    threads: { list: async () => [...threads.values()] as never, get: async ({ threadId }) => threads.get(threadId)!,
      getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {}, spawn: spawn as never,
      events: { list: async () => [] }, interactions: { list: async () => [] as never } },
    files: { write: write as never, read: async ({ path }) => ({ content: files.get(path), contentEncoding: "utf8" }) as never },
  }, experimental_callHostRpc: ({ method }) => {
    hostCalls.push(method);
    if (method === "scan" || method === "inspectPaths") return { units, warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: prs.map((pr) => ({ repo: "inkwell/folio", pr })), complete: true, discoveryComplete: true,
      repositories: [{ repo: "inkwell/folio", complete: true }], warnings: [] };
    if (method === "contextWorkspace") return { path: "/synthetic/context" };
    throw new Error(`Unexpected planning host call: ${method}`);
  } });
  await plugin(bb);
  const efforts = createEffortStore(bb.storage.database() as never);
  efforts.establish({ sourceKey: "synthetic-plan", name: "Shelf order", goal: "Reliable shelf order", projectId: "proj-synthetic", coordinatorState: "none",
    members: { tickets: [], prUrls: [prs[0]!.url] } });
  expect((await harness.behavior.runCli(["refresh"])).exitCode).toBe(0);
  const env = { harness, bb, spawn, write, hostCalls, files, prs, threads, metadata,
    call: (requestId: string) => env.harness.behavior.callRpc("inventory_plan_advance", { requestId, projectId: "proj-synthetic" }).then((result) => rpcContract.inventory_plan_advance.output.parse(result)),
    restart: async () => { const next = await env.harness.lifecycle.reload(plugin); env.harness = next.harness; env.bb = next.bb; } };
  cleanups.push(() => env.harness.lifecycle.dispose());
  return env;
}
describe("Plan Advance All RPC", () => {
  it("passes cached data for all unheld open PRs to one planning thread, with no GitHub writes or fresh PR reads", async () => {
    const env = await setup();
    await env.harness.behavior.callRpc("pr_hold_set", { prUrl: env.prs[1]!.url, held: true, reason: "Waiting" });
    env.hostCalls.length = 0;
    const result = await env.call(randomUUID());
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error);
    expect(result.count).toBe(2); expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.hostCalls).toEqual(["contextWorkspace"]);
    const snapshot = JSON.parse(env.files.get(result.snapshotPath)!) as AdvanceSnapshot;
    expect(snapshot.excludedHeldCount).toBe(1); expect(snapshot.prs).toHaveLength(2);
    expect(snapshot.prs.some((p) => p.url === env.prs[1]!.url)).toBe(false);
    const args = env.spawn.mock.calls[0]![0];
    expect(args.prompt).toContain(result.snapshotPath); expect(args.prompt).toContain("planning only");
    expect(args.pluginMetadata?.role).toBe("advance-planner"); expect(args.pluginMetadata).not.toHaveProperty("prUrls");
    expect(result.notice).toContain("not configured");
    expect(env.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(env.harness.inspection.sdk.callsTo("files.write")[0]![0]).toMatchObject({ expectedSha256: null, mode: 0o600 });
  });
  it("coalesces duplicate clicks and returns the saved thread after a plugin reload", async () => {
    const env = await setup(), id = randomUUID();
    const [first, second] = await Promise.all([env.call(id), env.call(id)]);
    expect(first).toEqual(second); expect(env.spawn).toHaveBeenCalledTimes(1);
    await env.restart(); expect(await env.call(id)).toEqual(first); expect(env.spawn).toHaveBeenCalledTimes(1);
  });
  it("refuses an all-held inventory without starting a thread", async () => {
    const env = await setup();
    for (const pr of env.prs) await env.harness.behavior.callRpc("pr_hold_set", { prUrl: pr.url, held: true });
    const result = await env.call(randomUUID());
    expect(result).toMatchObject({ ok: false }); if (result.ok) throw new Error("Unexpected thread");
    expect(result.error).toContain("All open PRs are held"); expect(env.spawn).not.toHaveBeenCalled(); expect(env.write).not.toHaveBeenCalled();
  });
  it("recovers a started thread whose spawn reply was lost instead of duplicating it", async () => {
    const env = await setup(), id = randomUUID();
    const base = env.spawn.getMockImplementation()!;
    env.spawn.mockImplementationOnce(async (args) => { await base(args); throw new Error("Reply lost"); });
    expect(await env.call(id)).toMatchObject({ ok: false });
    const retry = await env.call(id);
    expect(retry.ok).toBe(true); expect(env.spawn).toHaveBeenCalledTimes(1);
  });
});
