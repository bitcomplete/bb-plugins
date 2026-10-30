import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { createEffortStore } from "./effort-store.js";
import { createRunStore } from "./runstore.js";
import { effortTitle } from "./effort-title.js";
import plugin from "./server.js";

const url = "https://github.com/inkwell/folio/pull/42";
const requestId = "11111111-1111-4111-8111-111111111111";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup() {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  let failNextMetadataWrite = false;
  let failNextThreadUpdate = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host" }) as never },
    projects: { list: async () => [{ id: "project", name: "Folio", sources: [{ hostId: "host", path: "/p" }] }] as never },
    threads: {
      list: async () => [...threads.values()] as never,
      get: async ({ threadId }: { threadId: string }) => { const row = threads.get(threadId); if (!row) throw new Error("missing thread"); return row as never; },
      update: async ({ threadId, title, parentThreadId }: { threadId: string; title?: string | null; parentThreadId?: string | null }) => {
        if (failNextThreadUpdate) { failNextThreadUpdate = false; throw new Error("Synthetic thread update failure"); }
        const row = threads.get(threadId);
        if (!row) throw new Error("missing thread");
        const updated = { ...row, ...(title !== undefined ? { title } : {}), ...(parentThreadId !== undefined ? { parentThreadId } : {}) };
        threads.set(threadId, updated); return updated as never;
      },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata.get(threadId) ?? {}) as never,
      updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
        if (failNextMetadataWrite) { failNextMetadataWrite = false; throw new Error("Synthetic metadata write failure"); }
        const updated = { ...metadata.get(threadId), ...(set ?? {}) }; metadata.set(threadId, updated); return updated as never;
      },
      events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [], discoveryComplete: true, complete: true, repositories: [], warnings: [] };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  await harness.runCli(["refresh"]);
  const store = createEffortStore(bb.storage.database());
  const call = (method: string, input: unknown) => harness.callRpc(method as never, input as never) as Promise<any>;
  const list = () => call("effort_admin_list", null);
  const seed = () => {
    const source = store.establish({ sourceKey: "source", name: "Source effort", goal: "Source goal", projectId: "project",
      members: { tickets: ["ABC-101"], prUrls: [url], checkoutPaths: ["/p/source"] }, coordinatorState: "none" });
    const destination = store.establish({ sourceKey: "destination", name: "Destination effort", goal: "Destination goal", projectId: "project",
      members: { tickets: ["ABC-202"], prUrls: [] }, coordinatorState: "none" });
    return { source, destination };
  };
  return { bb, harness, store, threads, metadata, call, list, seed,
    failNextMetadataWrite: () => { failNextMetadataWrite = true; },
    failNextThreadUpdate: () => { failNextThreadUpdate = true; } };
}

it("creates an empty effort once and guards rename and archive with the current revision", async () => {
  const env = await setup();
  const created = await env.call("effort_admin_create", { name: "  Editorial   review  ", goal: "Review reliably", projectId: "project", requestId });
  expect(created).toMatchObject({ ok: true, effort: { name: "Editorial review", goal: "Review reliably",
    members: { tickets: [], prUrls: [] }, coordinatorState: "none" } });
  expect((await env.call("effort_admin_create", { name: "Editorial review", goal: "Review reliably", projectId: "project", requestId })).effort.id)
    .toBe(created.effort.id);
  expect(await env.call("effort_admin_create", { name: "Different", goal: "Review reliably", projectId: "project", requestId }))
    .toMatchObject({ ok: false });
  const before = await env.list();
  const oldScope = before.scopes[created.effort.key];
  const renamed = await env.call("effort_admin_update", { effortKey: created.effort.key, name: "Editorial delivery", goal: "Ship the review", expectedScope: oldScope });
  expect(renamed).toMatchObject({ ok: true, effort: { name: "Editorial delivery", goal: "Ship the review" } });
  expect(await env.call("effort_admin_archive", { effortKey: created.effort.key, archived: true, expectedScope: oldScope }))
    .toMatchObject({ ok: false, error: expect.stringContaining("changed") });
  const newScope = (await env.list()).scopes[created.effort.key];
  expect(await env.call("effort_admin_archive", { effortKey: created.effort.key, archived: true, expectedScope: newScope }))
    .toMatchObject({ ok: true, effort: { archivedAt: expect.any(Number) } });
  expect((await env.list()).efforts.find((effort: { id: string }) => effort.id === created.effort.id)).toMatchObject({
    archivedAt: expect.any(Number), name: "Editorial delivery",
  });
  const archivedScope = (await env.list()).scopes[created.effort.key];
  expect(await env.call("effort_admin_archive", { effortKey: created.effort.key, archived: false, expectedScope: archivedScope }))
    .toMatchObject({ ok: true, effort: { archivedAt: null } });
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
});

it("rejects a stale merge preview and moves members only after a fresh preview", async () => {
  const env = await setup();
  const { source, destination } = env.seed();
  const keys = { sourceKey: source.key, destinationKey: destination.key };
  const first = await env.call("effort_admin_merge_preview", keys);
  expect(first).toMatchObject({ ok: true, preview: { blockers: [], members: { tickets: 1, prUrls: 1, checkoutPaths: 1 } } });
  env.store.updateDetails(source.id, { goal: "Updated source goal" });
  expect(await env.call("effort_admin_merge", { ...keys, expectedScope: first.preview.scope })).toMatchObject({ ok: false,
    error: expect.stringContaining("preview") });
  expect(env.store.owner("ticket", "ABC-101")?.id).toBe(source.id);
  const fresh = await env.call("effort_admin_merge_preview", keys);
  const merged = await env.call("effort_admin_merge", { ...keys, expectedScope: fresh.preview.scope });
  expect(merged).toMatchObject({ ok: true, effort: { id: destination.id, members: { tickets: ["ABC-101", "ABC-202"], prUrls: [url] } } });
  expect(env.store.get(source.id)?.id).toBe(destination.id);
  expect(env.store.source("source")?.id).toBe(destination.id);
  expect(env.store.owner("checkoutPath", "/p/source")?.id).toBe(destination.id);
  expect((await env.list()).efforts.find((effort: { id: string }) => effort.id === source.id)).toMatchObject({ mergedInto: destination.id });
  const retry = await env.call("effort_admin_merge_preview", keys);
  expect(retry).toMatchObject({ ok: true, preview: { blockers: [] } });
  expect(await env.call("effort_admin_merge", { ...keys, expectedScope: retry.preview.scope })).toMatchObject({ ok: true,
    effort: { id: destination.id } });
});

it("blocks a merge while an affected action run or repository controller claim is active", async () => {
  const env = await setup();
  const { source, destination } = env.seed();
  const keys = { sourceKey: source.key, destinationKey: destination.key };
  const before = await env.call("effort_admin_merge_preview", keys);
  expect(before).toMatchObject({ ok: true, preview: { blockers: [] } });
  const runs = createRunStore(env.bb.storage.database());
  const runId = runs.begin({ path: "/p/source", ticket: "ABC-101", prUrl: url, prNumber: 42,
    action: "investigate-ci", mode: "new", threadId: null });
  expect(await env.call("effort_admin_merge_preview", keys)).toMatchObject({ ok: true,
    preview: { blockers: expect.arrayContaining([expect.stringContaining("Run")]) } });
  expect(await env.call("effort_admin_merge", { ...keys, expectedScope: before.preview.scope })).toMatchObject({ ok: false });
  expect(env.store.getRecord(source.id)?.mergedInto).toBeUndefined();
  runs.discard(runId);
  env.store.claimRepoController({ effortId: source.id, repo: "inkwell/folio", projectId: "project", hostId: "host" });
  expect(await env.call("effort_admin_merge_preview", keys)).toMatchObject({ ok: true,
    preview: { blockers: expect.arrayContaining([expect.stringContaining("controller")]) } });
});

it("blocks unresolved launches and active threads before merging", async () => {
  const env = await setup();
  const { source, destination } = env.seed();
  const keys = { sourceKey: source.key, destinationKey: destination.key };
  env.store.save({ ...source, coordinatorState: "creating" });
  expect(await env.call("effort_admin_merge_preview", keys)).toMatchObject({ ok: true,
    preview: { blockers: expect.arrayContaining([expect.stringContaining("coordinator launch")]) } });
  env.store.save({ ...env.store.getRecord(source.id)!, coordinatorState: "none" });
  env.threads.set("thr-active", makeThreadResponse({ id: "thr-active", projectId: "project", status: "active" } as never));
  env.metadata.set("thr-active", { workEffortId: source.id });
  expect(await env.call("effort_admin_merge_preview", keys)).toMatchObject({ ok: true,
    preview: { blockers: expect.arrayContaining([expect.stringContaining("thr-active")]) } });
});

it("keeps an archived effort's ownership on the board", async () => {
  const env = await setup();
  const { source } = env.seed();
  const scope = (await env.list()).scopes[source.key];
  expect(await env.call("effort_admin_archive", { effortKey: source.key, archived: true, expectedScope: scope }))
    .toMatchObject({ ok: true, effort: { archivedAt: expect.any(Number) } });
  expect(env.store.owner("ticket", "ABC-101")?.id).toBe(source.id);
});

it("retains a committed merge when metadata sync fails and completes it on retry", async () => {
  const env = await setup();
  const { source, destination } = env.seed();
  const keys = { sourceKey: source.key, destinationKey: destination.key };
  env.threads.set("thr-source", makeThreadResponse({ id: "thr-source", projectId: "project", status: "idle" } as never));
  env.metadata.set("thr-source", { workEffortId: source.id, role: "worker" });
  const preview = await env.call("effort_admin_merge_preview", keys);
  expect(preview).toMatchObject({ ok: true, preview: { blockers: [] } });
  env.failNextMetadataWrite();
  expect(await env.call("effort_admin_merge", { ...keys, expectedScope: preview.preview.scope })).toMatchObject({ ok: true,
    effort: { id: destination.id }, pendingThreadSync: 1 });
  expect(env.store.getRecord(source.id)?.mergedInto).toBe(destination.id);
  expect(env.metadata.get("thr-source")?.workEffortId).toBe(source.id);
  const retry = await env.call("effort_admin_merge_preview", keys);
  expect(retry).toMatchObject({ ok: true, preview: { pendingThreadSync: 1 } });
  expect(await env.call("effort_admin_merge", { ...keys, expectedScope: retry.preview.scope })).toMatchObject({ ok: true,
    pendingThreadSync: 0 });
  expect(env.metadata.get("thr-source")?.workEffortId).toBe(destination.id);
});

it("keeps a saved sync action after metadata succeeds but a thread update fails", async () => {
  const env = await setup();
  const { source, destination } = env.seed();
  env.store.save({ ...source, coordinatorThreadId: "thr-coordinator", coordinatorState: "ready" });
  env.threads.set("thr-coordinator", makeThreadResponse({ id: "thr-coordinator", projectId: "project",
    title: "Old coordinator title", status: "idle" } as never));
  env.metadata.set("thr-coordinator", { effortId: source.id, workEffortId: source.id, role: "coordinator" });
  const keys = { sourceKey: source.key, destinationKey: destination.key };
  const preview = await env.call("effort_admin_merge_preview", keys);
  expect(preview).toMatchObject({ ok: true, preview: { blockers: [] } });
  env.failNextThreadUpdate();
  expect(await env.call("effort_admin_merge", { ...keys, expectedScope: preview.preview.scope })).toMatchObject({ ok: true,
    effort: { coordinatorThreadId: "thr-coordinator" }, pendingThreadSync: 1 });
  expect(env.metadata.get("thr-coordinator")).toMatchObject({ effortId: destination.id, workEffortId: destination.id });
  expect(env.threads.get("thr-coordinator")?.title).toBe("Old coordinator title");
  const retry = await env.call("effort_admin_merge_preview", keys);
  expect(retry).toMatchObject({ ok: true, preview: { pendingThreadSync: 1 } });
  expect(await env.call("effort_admin_merge", { ...keys, expectedScope: retry.preview.scope })).toMatchObject({ ok: true,
    pendingThreadSync: 0 });
  expect(env.threads.get("thr-coordinator")?.title).toBe(effortTitle(destination.name));
});

it("finishes a merge whose coordinator was renamed after planning, keeping the new title and still moving effort metadata and parents", async () => {
  const env = await setup();
  const { source, destination } = env.seed();
  env.store.save({ ...source, coordinatorThreadId: "thr-coordinator", coordinatorState: "ready" });
  env.threads.set("thr-coordinator", makeThreadResponse({ id: "thr-coordinator", projectId: "project",
    title: "Old coordinator title", status: "idle" } as never));
  env.metadata.set("thr-coordinator", { effortId: source.id, workEffortId: source.id, role: "coordinator" });
  // The source's controller sits outside the coordinator, so the merge also moves it under the coordinator.
  env.threads.set("thr-controller", makeThreadResponse({ id: "thr-controller", projectId: "project", status: "idle", parentThreadId: null } as never));
  env.metadata.set("thr-controller", { effortId: source.id, role: "repo" });
  const { record } = env.store.claimRepoController({ effortId: source.id, repo: "inkwell/folio", projectId: "project", hostId: "host" });
  env.store.saveRepoController({ ...record, threadId: "thr-controller", state: "ready" });
  const keys = { sourceKey: source.key, destinationKey: destination.key };
  const preview = await env.call("effort_admin_merge_preview", keys);
  expect(preview).toMatchObject({ ok: true, preview: { blockers: [] } });
  // Both thread updates fail once, so every planned action is still pending when the coordinator is renamed.
  env.failNextMetadataWrite();
  env.failNextThreadUpdate();
  expect(await env.call("effort_admin_merge", { ...keys, expectedScope: preview.preview.scope })).toMatchObject({ ok: true, pendingThreadSync: 2 });
  // A person, or thread-briefs' renameThreads, renames the coordinator before the retry.
  env.threads.set("thr-coordinator", { ...env.threads.get("thr-coordinator")!, title: "Shelf fixes brief" });
  const retry = await env.call("effort_admin_merge_preview", keys);
  expect(await env.call("effort_admin_merge", { ...keys, expectedScope: retry.preview.scope })).toEqual({ ok: true, effort: expect.anything(), pendingThreadSync: 0,
    notice: `Thread thr-coordinator was renamed after this merge was planned, so it keeps its title instead of "${effortTitle(destination.name)}".` });
  expect(env.threads.get("thr-coordinator")?.title).toBe("Shelf fixes brief");
  expect(env.metadata.get("thr-coordinator")).toMatchObject({ effortId: destination.id, workEffortId: destination.id });
  expect(env.metadata.get("thr-controller")).toMatchObject({ effortId: destination.id });
  expect(env.threads.get("thr-controller")?.parentThreadId).toBe("thr-coordinator");
  expect(await env.call("effort_admin_merge_preview", keys)).toMatchObject({ ok: true, preview: { pendingThreadSync: 0 } });
});

it("finds an active coordinator from the stored binding even without plugin metadata", async () => {
  const env = await setup();
  const { source, destination } = env.seed();
  env.store.save({ ...source, coordinatorThreadId: "thr-unlabeled", coordinatorState: "ready" });
  env.threads.set("thr-unlabeled", makeThreadResponse({ id: "thr-unlabeled", projectId: "project", status: "active" } as never));
  expect(await env.call("effort_admin_merge_preview", { sourceKey: source.key, destinationKey: destination.key }))
    .toMatchObject({ ok: true, preview: { blockers: expect.arrayContaining([expect.stringContaining("thr-unlabeled")]) } });
});

it("blocks a chained merge until the previous merge finishes its thread sync", async () => {
  const env = await setup();
  const { source, destination } = env.seed();
  const next = env.store.establish({ sourceKey: "next", name: "Next effort", goal: "Next goal", projectId: "project",
    members: { tickets: ["ABC-303"], prUrls: [] }, coordinatorState: "none" });
  env.threads.set("thr-source", makeThreadResponse({ id: "thr-source", projectId: "project", status: "idle" } as never));
  env.metadata.set("thr-source", { workEffortId: source.id });
  const firstKeys = { sourceKey: source.key, destinationKey: destination.key };
  const first = await env.call("effort_admin_merge_preview", firstKeys);
  env.failNextMetadataWrite();
  expect(await env.call("effort_admin_merge", { ...firstKeys, expectedScope: first.preview.scope })).toMatchObject({ ok: true, pendingThreadSync: 1 });
  const chainedKeys = { sourceKey: destination.key, destinationKey: next.key };
  expect(await env.call("effort_admin_merge_preview", chainedKeys)).toMatchObject({ ok: true,
    preview: { blockers: expect.arrayContaining([expect.stringContaining("pending thread sync")]) } });
  const retry = await env.call("effort_admin_merge_preview", firstKeys);
  expect(await env.call("effort_admin_merge", { ...firstKeys, expectedScope: retry.preview.scope })).toMatchObject({ ok: true,
    pendingThreadSync: 0 });
  expect(await env.call("effort_admin_merge_preview", chainedKeys)).toMatchObject({ ok: true, preview: { blockers: [] } });
});

it("rolls back the thread sync plan if a merged membership exceeds the limit", async () => {
  const env = await setup();
  const source = env.store.establish({ sourceKey: "large-source", name: "Large source", goal: "", projectId: "project",
    members: { tickets: Array.from({ length: 1000 }, (_, index) => `ABC-${index}`), prUrls: [] }, coordinatorState: "none" });
  const destination = env.store.establish({ sourceKey: "small-destination", name: "Small destination", goal: "", projectId: "project",
    members: { tickets: ["ABC-1000"], prUrls: [] }, coordinatorState: "none" });
  const keys = { sourceKey: source.key, destinationKey: destination.key };
  const preview = await env.call("effort_admin_merge_preview", keys);
  expect(preview).toMatchObject({ ok: true, preview: { blockers: [] } });
  expect(await env.call("effort_admin_merge", { ...keys, expectedScope: preview.preview.scope })).toMatchObject({ ok: false });
  expect(env.store.getRecord(source.id)?.mergedInto).toBeUndefined();
  expect(env.store.owner("ticket", "ABC-999")?.id).toBe(source.id);
  expect(env.bb.storage.database().prepare(`SELECT source_id FROM effort_admin_sync WHERE source_id = ?`).get(source.id)).toBeUndefined();
  expect(await env.call("effort_admin_merge_preview", keys)).toMatchObject({ ok: true, preview: { blockers: [] } });
});
