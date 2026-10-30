import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Pr } from "./contract.js";
import type { EffortPileState } from "./effort-piles.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const pr = (number: number, title: string): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title, isDraft: false,
  reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: `branch-${number}`, baseRefName: "main",
  headRefOid: "a".repeat(40), latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: "2026-09-21T15:00:00Z" }]))!.pr;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** You author #314 (ABC-341, in Shelf order) and #316 (no effort). Shelf order's coordinator thread is working. */
async function setup() {
  const thread = { ...makeThreadResponse({ id: "thr-shelf", title: "Shelf order", projectId: "project-folio", status: "active" }), queuedWork: "none",
    hasPendingInteraction: false, activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 } };
  const updates: unknown[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => [thread] as never,
      get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project-folio", status: "active" }) as never,
      update: async (input: unknown) => { updates.push(input); return thread as never; },
      getPluginMetadata: async () => ({}) as never, events: { list: async () => [] }, output: async () => ({ output: "" }),
    },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [pr(314, "ABC-341 Group shelves by genre"), pr(316, "Sort shelves by author")]
      .map((entry) => ({ repo: "inkwell/folio", pr: entry })), discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const efforts = createEffortStore(bb.storage.database());
  const created = efforts.establish({ sourceKey: "ticket:ABC-341", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: ["ABC-341"], prUrls: [] } });
  const shelf = efforts.save({ ...created, coordinatorThreadId: "thr-shelf", coordinatorState: "ready" });
  const pickup = efforts.establish({ sourceKey: "ticket:ABC-330", name: "Store pickup", goal: "Reserve books for pickup", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: ["ABC-330"], prUrls: [] } });
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const call = (method: string, input: unknown) => harness.callRpc(method as never, input as never) as Promise<any>;
  return { bb, harness, efforts, shelf, pickup, updates, call, piles: async () => new Map((await call("effort_piles_get", null) as EffortPileState[])
    .map((pile) => [pile.effortId, pile])) };
}

describe("effort piles over RPC", () => {
  it("holds with a reason and completes with what is still open, keeping every member and thread", async () => {
    const env = await setup();
    const before = env.efforts.get(env.shelf.id);
    expect(await env.call("effort_hold", { effortKey: env.shelf.key, reason: "Waiting on the store layout review" }))
      .toMatchObject({ ok: true, pile: { pile: "held", reason: "Waiting on the store layout review" } });
    expect((await env.piles()).get(env.shelf.id)).toMatchObject({ pile: "held" });
    const completed = await env.call("effort_complete", { effortKey: env.shelf.key });
    expect(completed).toEqual({ ok: true, pile: expect.objectContaining({ pile: "done" }), open: {
      prs: [{ prUrl: url(314), repo: "inkwell/folio", number: 314, title: "ABC-341 Group shelves by genre" }],
      threads: [{ id: "thr-shelf", title: "Shelf order" }] } });
    // Nothing moved: the effort still owns its ticket and PR, its coordinator is still its coordinator, and no thread was touched.
    expect(env.efforts.get(env.shelf.id)).toEqual(before);
    expect(env.updates).toEqual([]);
    const inventory = await env.call("inventory_get", {});
    expect(inventory.groups.find((group: { effort: { id: string } | null }) => group.effort?.id === env.shelf.id).rows.map((row: { number: number }) => row.number))
      .toEqual([314]);
  });

  it("returns a resumed or reopened effort to the end of the active pile, so the deck's numbers don't shift", async () => {
    const env = await setup();
    await env.call("effort_hold", { effortKey: env.shelf.key });
    expect((await env.call("effort_resume", { effortKey: env.shelf.key })).pile.since).toBeGreaterThan((await env.piles()).get(env.pickup.id)!.since);
    await env.call("effort_complete", { effortKey: env.pickup.key });
    expect(await env.call("effort_reopen", { effortKey: env.pickup.key })).toMatchObject({ ok: true, pile: { pile: "active", reason: "" } });
  });

  it("leaves archived efforts out, and holds none until it is restored", async () => {
    const env = await setup();
    env.efforts.setArchived(env.pickup.id, true);
    expect([...(await env.piles()).keys()]).toEqual([env.shelf.id]);
    expect(await env.call("effort_hold", { effortKey: env.pickup.key })).toEqual({ ok: false, error: "Restore this effort first." });
    expect(await env.call("effort_resume", { effortKey: env.shelf.key })).toEqual({ ok: false, error: "This effort is already active." });
  });
});
