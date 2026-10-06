import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createEffortStore } from "./effort-store.js";
import type { DeckView } from "./deck.js";
import plugin from "./server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); });

async function setup() {
  const threads = new Map(["parent", "worker", "busy", "unrelated"].map((id) => [id, makeThreadResponse({ id, projectId: "project-folio", title: `Manuscript ${id}`,
    status: id === "busy" ? "active" : "idle", originPluginId: "workstreams" })]));
  const metadata = new Map<string, Record<string, unknown>>();
  const archive = vi.fn(async ({ threadId }: { threadId: string }) => {
    const thread = { ...threads.get(threadId)!, archivedAt: Date.now() }; threads.set(threadId, thread);
    await harness.behavior.emitThreadEvent("thread.archived", { thread });
    return { ok: true as const, archivedThreadIds: [threadId] };
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-folio" }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: "host-folio", path: "/p" }] }] as never },
    threads: {
      list: async (args?: { archived?: boolean; parentThreadId?: string; sourceThreadId?: string; limit?: number }) => {
        const rows = [...threads.values()].filter((t) => (t.archivedAt !== null) === !!args?.archived
          && (!args?.parentThreadId || t.parentThreadId === args.parentThreadId) && !args?.sourceThreadId);
        return rows.slice(0, args?.limit ?? rows.length);
      },
      get: async ({ threadId }: { threadId: string }) => { const t = threads.get(threadId); if (!t) throw new Error("Missing synthetic thread"); return t; },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata.get(threadId) ?? {}) as never,
      events: { list: async () => [] }, interactions: { list: async () => [] }, archive,
      unarchive: async ({ threadId }: { threadId: string }) => {
        const thread = { ...threads.get(threadId)!, archivedAt: null }; threads.set(threadId, thread);
        await harness.behavior.emitThreadEvent("thread.unarchived", { thread }); return { ok: true as const };
      },
    },
  }, experimental_callHostRpc: ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [], warnings: [] };
    if (method === "authoredPrs") return { entries: [], owners: ["inkwell"], repositories: [], discoveryComplete: true, complete: true, warnings: [] };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  const store = createEffortStore(bb.storage.database() as never);
  const effort = store.establish({ sourceKey: "manual:manuscripts", name: "Manuscripts", goal: "Keep manuscripts in order", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: [], prUrls: [] } });
  store.save({ ...effort, coordinatorThreadId: "parent", coordinatorState: "ready" });
  metadata.set("worker", { workEffortId: effort.id }); metadata.set("busy", { workEffortId: effort.id });
  // Persisted index from earlier effort assignments; this fixture has no PR/checkouts to establish a link.
  for (const id of ["worker", "busy"]) bb.storage.database().prepare("INSERT INTO thread_work_intent_ids (thread_id) VALUES (?)").run(id);
  expect((await harness.behavior.runCli(["refresh"])).exitCode).toBe(0);
  const card = async () => (await harness.behavior.callRpc("deck_get", {}) as DeckView).active.find((c) => c.id === effort.id)!;
  return { harness, threads, archive, effort, card };
}

it("archives a thread linked only to an effort, records recovery, and restores it without starting an agent", async () => {
  const env = await setup();
  expect((await env.card()).threads.map((t) => t.id)).toContain("worker");
  expect(await env.harness.behavior.callRpc("thread_archive", { threadId: "worker", cardId: env.effort.id })).toMatchObject({ ok: true });
  expect(env.archive).toHaveBeenCalledWith({ threadId: "worker" });
  expect((await env.card()).threads.map((t) => t.id)).not.toContain("worker");
  expect(await env.harness.behavior.callRpc("thread_archived", {})).toMatchObject([{ threadId: "worker", ticket: "Manuscripts" }]);
  expect(await env.harness.behavior.callRpc("thread_restore", { threadId: "worker" })).toMatchObject({ ok: true });
  await vi.waitFor(async () => expect((await env.card()).threads.map((t) => t.id)).toContain("worker"));
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("refuses forged card scope, working threads, and parent threads with children", async () => {
  const env = await setup();
  expect(await env.harness.behavior.callRpc("thread_archive", { threadId: "unrelated", cardId: env.effort.id })).toMatchObject({ ok: false });
  expect(await env.harness.behavior.callRpc("thread_archive", { threadId: "busy", cardId: env.effort.id })).toMatchObject({ ok: false });
  env.threads.set("worker", { ...env.threads.get("worker")!, parentThreadId: "parent" });
  expect(await env.harness.behavior.callRpc("thread_archive", { threadId: "parent", cardId: env.effort.id })).toMatchObject({ ok: false, error: expect.stringContaining("subthreads") });
  expect(env.archive).not.toHaveBeenCalled();
});
