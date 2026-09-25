import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { parsePrList } from "./gh.js";
import type { RawUnit } from "./contract.js";
import type { EffortPlan } from "./effort-coordinator.js";
import plugin, { type Board } from "./server.js";

const PATH = "/p/folio-abc-101", URL = "https://github.com/inkwell/folio/pull/42";
const pr = parsePrList(JSON.stringify([{ number: 42, url: URL, state: "OPEN", title: "ABC-101 Improve manuscript review", headRefName: "abc-101-review", reviewDecision: "APPROVED" }]))!.pr;
const unit: RawUnit = { path: PATH, dirName: "folio-abc-101", repo: "folio", githubRepo: "inkwell/folio", branch: "abc-101-review", dirty: false,
  ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr, shipped: null, changedPaths: ["src/review.ts"], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup() {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const spawns: Record<string, any>[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-inkwell" }) as never },
    projects: { list: async () => [{ id: "proj-inkwell", name: "Folio", sources: [{ hostId: "host-inkwell", path: "/p" }] }] as never },
    threads: {
      list: async () => [...threads.values()] as never,
      get: async ({ threadId }: { threadId: string }) => { const row = threads.get(threadId); if (!row) throw new Error("missing thread"); return { ...row, canSpawnChild: true } as never; },
      spawn: async (args: Record<string, any>) => {
        spawns.push(args);
        const id = `thr-${spawns.length}`;
        const row = makeThreadResponse({ id, projectId: args.projectId, title: args.title ?? "PR worker", status: "idle", environmentPath: args.environment.workspace?.path ?? "/planning/worktree" } as never);
        threads.set(id, row); metadata.set(id, args.pluginMetadata);
        return row;
      },
      update: async ({ threadId, title }: { threadId: string; title?: string | null }) => { const updated = { ...threads.get(threadId)!, title: title ?? null }; threads.set(threadId, updated); return updated; },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata.get(threadId) ?? {}) as never,
      context: async () => ({ usage: null }) as never,
      events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [unit], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [], discoveryComplete: true, complete: true, repositories: [], warnings: [] };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  await harness.runCli(["refresh"]);
  const board = async () => await harness.callRpc("board_get", null) as Board;
  const group = (await board()).groups.find((group) => group.clusters.length > 0)!;
  const plan = await harness.callRpc("effort_plan", { groupKey: group.key }) as Extract<EffortPlan, { ok: true }>;
  const input = { groupKey: group.key, name: "Improve manuscript review", goal: "Make manuscript review reliable", projectId: "proj-inkwell", members: plan.members };
  return { harness, board, plan, input, spawns, threads, metadata };
}

describe("established effort coordination through the server", () => {
  it("previews without launching and establishes a persistent effort in a separate worktree", async () => {
    const { harness, board, input, plan, spawns } = await setup();
    expect(plan.ok).toBe(true); expect(spawns).toEqual([]);
    expect(await harness.callRpc("effort_coordinate", input)).toMatchObject({ ok: true });
    expect(spawns[0]).toMatchObject({ title: "🔍 Improve manuscript review", environment: { type: "provider", environmentProviderId: "git-worktree" }, pluginMetadata: { role: "coordinator" } });
    expect(spawns[0]).not.toHaveProperty("model"); expect(spawns[0]).not.toHaveProperty("providerId");
    const established = (await board()).efforts[0]!;
    await harness.runCli(["refresh"]);
    expect((await board()).groups.some((group) => group.key === established.key && group.name === input.name)).toBe(true);
    expect((await board()).efforts[0]?.id).toBe(established.id);
    await harness.callRpc("effort_coordinate", input);
    expect(spawns).toHaveLength(1);
  });

  it("rejects changed membership and invalid project before creating anything", async () => {
    const { harness, input, spawns } = await setup();
    expect(await harness.callRpc("effort_coordinate", { ...input, members: { tickets: [], prUrls: [] } })).toMatchObject({ ok: false });
    expect(await harness.callRpc("effort_coordinate", { ...input, projectId: "unrelated" })).toMatchObject({ ok: false });
    expect(spawns).toHaveLength(0);
  });

  it("routes the first PR worker to the coordinator and a bounded follow-up to that worker", async () => {
    const { harness, input, spawns } = await setup();
    await harness.callRpc("effort_coordinate", input);
    expect(await harness.callRpc("agent_plan", { path: PATH, action: "resolve-conflicts" })).toMatchObject({ ok: true, recommendation: { mode: "subthread", threadId: "thr-1" } });
    const action = { path: PATH, action: "resolve-conflicts", mode: "subthread", threadId: "thr-1", prompt: "Inspect and repair this PR." };
    expect(await harness.callRpc("agent_run", action)).toMatchObject({ ok: true, threadId: "thr-2" });
    expect(spawns[1]).toMatchObject({ parentThreadId: "thr-1", environment: { workspace: { path: PATH } }, pluginMetadata: { role: "pr", prUrl: URL, ticket: "ABC-101" } });
    expect(await harness.callRpc("agent_plan", { path: PATH, action: "resolve-conflicts" })).toMatchObject({ ok: true, recommendation: { threadId: "thr-2" } });
    expect(await harness.callRpc("agent_run", { ...action, threadId: "thr-2" })).toMatchObject({ ok: true });
    expect(spawns[2]).toMatchObject({ parentThreadId: "thr-2", pluginMetadata: { role: "followup" } });
  });

  it("refuses an active writer from another thread before launching a repair", async () => {
    const { harness, threads, spawns } = await setup();
    threads.set("thr-busy", makeThreadResponse({ id: "thr-busy", status: "active", environmentPath: PATH } as never));
    expect(await harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Fix it" })).toMatchObject({ ok: false, error: expect.stringContaining("already working") });
    expect(spawns).toHaveLength(0);
  });

  it("reports archived coordinators as unavailable while retaining their effort", async () => {
    const { harness, board, threads, input } = await setup();
    await harness.callRpc("effort_coordinate", input);
    threads.set("thr-1", { ...threads.get("thr-1")!, archivedAt: Date.now() });
    expect((await board()).efforts[0]).toMatchObject({ coordinatorThreadId: "thr-1", coordinatorState: "unavailable" });
  });
});
