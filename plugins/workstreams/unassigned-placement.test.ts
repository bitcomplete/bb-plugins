import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createUnassignedPlacementService, UNASSIGNED_PLACEMENT_MIGRATION } from "./unassigned-placement.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.useRealTimers(); });

function setup() {
  const db = new Database(":memory:"); dbs.push(db); db.exec(UNASSIGNED_PLACEMENT_MIGRATION);
  const threads = new Map<string, { id: string; projectId: string; parentThreadId: string | null; archivedAt: null;
    deletedAt: null; canSpawnChild: boolean; environmentHostId: string | null }>();
  const metadata = new Map<string, string>();
  const spawn = vi.fn(async (record: { key: string; projectId: string; hostId: string | null; parentThreadId: string | null },
    _title: string, _role: string, _repo: string | null) => {
    const id = `thread-${threads.size + 1}`;
    threads.set(id, { id, projectId: record.projectId, parentThreadId: record.parentThreadId,
      archivedAt: null, deletedAt: null, canSpawnChild: true, environmentHostId: record.hostId });
    metadata.set(id, record.key);
    return { id };
  });
  const sdk = { get: async (id: string) => threads.get(id)!, recover: async (key: string, projectId: string) =>
    [...threads.values()].filter((thread) => thread.projectId === projectId && metadata.get(thread.id) === key).map((thread) => thread.id), spawn };
  return { db, threads, metadata, spawn, service: createUnassignedPlacementService(db, sdk), sdk };
}

it("creates one shared root and plain repository children without an effort owner", async () => {
  const env = setup();
  const [one, same] = await Promise.all([env.service.ensureRepo("Example/Widget", "project-a", "host-a"),
    env.service.ensureRepo("example/widget", "project-a", "host-a")]);
  const other = await env.service.ensureRepo("example/other", "project-b", "host-b");
  expect(one).toBe(same);
  expect(env.spawn).toHaveBeenCalledTimes(3);
  expect(env.spawn.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
    ["Unassigned work", "unassigned-root", null],
    ["example/widget", "unassigned-repo", "example/widget"],
    ["example/other", "unassigned-repo", "example/other"],
  ]);
  expect(env.threads.get(other)?.parentThreadId).toBe(env.service.root()?.threadId);
  expect(env.threads.get(other)?.projectId).toBe("project-b");
  expect(env.db.prepare("SELECT COUNT(*) AS count FROM unassigned_thread_placements").get()).toMatchObject({ count: 3 });
});

it("reuses a personal repository anchor when later writers have a repository project", async () => {
  const env = setup();
  const personal = await env.service.ensureRepo("example/widget", "proj_personal", null);
  expect(await env.service.ensureRepo("example/widget", "project-a", "host-a")).toBe(personal);
  expect(env.service.repo("example/widget")).toMatchObject({ projectId: "proj_personal", hostId: null });
  expect(env.spawn).toHaveBeenCalledTimes(2);
});

it("recovers an ambiguous launch without creating a duplicate", async () => {
  const env = setup();
  env.spawn.mockImplementationOnce(async (record) => {
    const id = "ambiguous-root";
    env.threads.set(id, { id, projectId: record.projectId, parentThreadId: null,
      archivedAt: null, deletedAt: null, canSpawnChild: true, environmentHostId: record.hostId });
    env.metadata.set(id, record.key);
    throw new Error("SDK timed out after creation");
  });
  await expect(env.service.ensureRoot("project-a", "host-a")).rejects.toThrow("timed out");
  expect(await env.service.ensureRoot("project-a", "host-a")).toBe("ambiguous-root");
  expect(env.spawn).toHaveBeenCalledTimes(1);
});

it("rejects a mismatched parent and keeps the recorded thread for inspection", async () => {
  const env = setup();
  env.spawn.mockImplementationOnce(async (record) => {
    const id = "wrong-parent";
    env.threads.set(id, { id, projectId: record.projectId, parentThreadId: "another-thread",
      archivedAt: null, deletedAt: null, canSpawnChild: true, environmentHostId: record.hostId });
    return { id };
  });
  await expect(env.service.ensureRoot("project-a", "host-a")).rejects.toThrow("hierarchy");
  expect(env.service.root()?.threadId).toBe("wrong-parent");
  await expect(env.service.ensureRoot("project-a", "host-a")).rejects.toThrow("hierarchy");
  expect(env.spawn).toHaveBeenCalledTimes(1);
});

it("waits for a new parent's host binding without spawning a duplicate", async () => {
  const env = setup();
  const get = env.sdk.get;
  let reads = 0;
  env.sdk.get = async (id) => {
    const thread = await get(id);
    return ++reads === 1 ? { ...thread, environmentHostId: null } : thread;
  };
  expect(await env.service.ensureRoot("project-a", "host-a")).toBe("thread-1");
  expect(reads).toBeGreaterThan(1);
  expect(env.spawn).toHaveBeenCalledTimes(1);
});

it("keeps a parent whose host never binds and reuses it after attachment", async () => {
  vi.useFakeTimers();
  const env = setup();
  env.spawn.mockImplementationOnce(async (record) => {
    const id = "pending-host";
    env.threads.set(id, { id, projectId: record.projectId, parentThreadId: null,
      archivedAt: null, deletedAt: null, canSpawnChild: true, environmentHostId: null });
    return { id };
  });
  const pending = env.service.ensureRoot("project-a", "host-a");
  const failure = expect(pending).rejects.toThrow("workspace did not attach");
  await vi.advanceTimersByTimeAsync(5_000);
  await failure;
  expect(env.service.root()?.threadId).toBe("pending-host");
  env.threads.get("pending-host")!.environmentHostId = "host-a";
  expect(await env.service.ensureRoot("project-a", "host-a")).toBe("pending-host");
  expect(env.spawn).toHaveBeenCalledTimes(1);
});

it("rejects a known wrong host or missing child capacity immediately", async () => {
  const env = setup();
  await env.service.ensureRoot("project-a", "host-a");
  env.threads.get("thread-1")!.environmentHostId = "other-host";
  await expect(env.service.ensureRoot("project-a", "host-a")).rejects.toThrow("recorded project, host");
  env.threads.get("thread-1")!.environmentHostId = "host-a";
  env.threads.get("thread-1")!.canSpawnChild = false;
  await expect(env.service.ensureRoot("project-a", "host-a")).rejects.toThrow("recorded project, host");
  expect(env.spawn).toHaveBeenCalledTimes(1);
});
