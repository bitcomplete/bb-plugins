import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEffortStore, EFFORT_MIGRATIONS, REPO_CONTROLLER_MIGRATION } from "./effort-store.js";
import { createRepoControllerService, type RepoControllerSdk } from "./repo-controller.js";

const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
function setup() {
  const db = new Database(":memory:"); dbs.push(db); EFFORT_MIGRATIONS.forEach((sql) => db.exec(sql)); db.exec(REPO_CONTROLLER_MIGRATION);
  const store = createEffortStore(db);
  const effort = store.save({ ...store.establish({ sourceKey: "group-a", name: "Improve review", goal: "", projectId: "coord-project",
    members: { tickets: [], prUrls: ["https://github.com/example/docs/pull/1"] } }), coordinatorThreadId: "coordinator", coordinatorState: "ready" });
  const threads = new Map<string, { id: string; projectId: string; parentThreadId: string | null; status: string; canSpawnChild: boolean;
    archivedAt: number | null; deletedAt: number | null; environmentHostId: string | null }>([
    ["coordinator", { id: "coordinator", projectId: "coord-project", parentThreadId: null, status: "idle", canSpawnChild: true, archivedAt: null, deletedAt: null, environmentHostId: "host" }],
  ]);
  let index = 0;
  const sdk: RepoControllerSdk = {
    get: vi.fn(async (id) => { const thread = threads.get(id); if (!thread) throw new Error("unavailable"); return thread; }),
    recover: vi.fn(async () => []),
    models: async () => ({ code: { providerId: "codex", model: "gpt-6-sol", reasoningLevel: "high" }, planning: { providerId: "codex", model: "gpt-6-sol", reasoningLevel: "medium" } }),
    spawn: vi.fn(async (args) => {
      const id = `repo-${++index}`;
      threads.set(id, { id, projectId: args.projectId, parentThreadId: args.parentThreadId, status: "active", canSpawnChild: true,
        archivedAt: null, deletedAt: null, environmentHostId: "repo-host" });
      return { id };
    }),
  };
  const input = { effort, repo: "example/docs", projectId: "repo-project", hostId: "repo-host", coordinatorThreadId: "coordinator" };
  return { store, sdk, threads, input, service: createRepoControllerService(store, sdk) };
}

describe("persistent effort repository controllers", () => {
  it("creates one cross-project child with a separate repository binding and reuses it", async () => {
    const t = setup();
    const first = await t.service.ensure(t.input);
    expect(first).toMatchObject({ threadId: "repo-1", state: "ready", projectId: "repo-project", hostId: "repo-host" });
    expect(t.sdk.spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: "repo-project", parentThreadId: "coordinator",
      title: "example/docs", pluginMetadata: { effortId: t.input.effort.id, repo: "example/docs", role: "repo" } }));
    expect((await createRepoControllerService(t.store, t.sdk).ensure(t.input)).threadId).toBe("repo-1");
    expect(t.sdk.spawn).toHaveBeenCalledTimes(1);
    await expect(t.service.ensure({ ...t.input, hostId: "other-host" })).rejects.toThrow("different project or host");
  });

  it("waits for a new repository controller's host binding before using it", async () => {
    const t = setup();
    vi.mocked(t.sdk.spawn).mockImplementationOnce(async (args) => {
      t.threads.set("pending-repo", { id: "pending-repo", projectId: args.projectId,
        parentThreadId: args.parentThreadId, status: "active", canSpawnChild: true,
        archivedAt: null, deletedAt: null, environmentHostId: null });
      return { id: "pending-repo" };
    });
    const get = vi.mocked(t.sdk.get).getMockImplementation()!;
    let reads = 0;
    vi.mocked(t.sdk.get).mockImplementation(async (id) => {
      if (id === "pending-repo" && ++reads === 2) t.threads.get(id)!.environmentHostId = "repo-host";
      return get(id);
    });
    expect((await t.service.ensure(t.input)).threadId).toBe("pending-repo");
    expect(reads).toBe(2);
    expect(t.sdk.spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects a conflicting concurrent binding and keeps separate efforts in the same repository", async () => {
    const t = setup();
    let finish!: (value: { id: string }) => void;
    vi.mocked(t.sdk.spawn).mockImplementationOnce((args) => new Promise<{ id: string }>((resolve) => {
      t.threads.set("first-repo", { id: "first-repo", projectId: args.projectId, parentThreadId: args.parentThreadId, status: "active",
        canSpawnChild: true, archivedAt: null, deletedAt: null, environmentHostId: "repo-host" });
      finish = resolve;
    }));
    const first = t.service.ensure(t.input);
    await expect(t.service.ensure({ ...t.input, hostId: "other-host" })).rejects.toThrow("different project, host, or coordinator");
    for (let index = 0; index < 10 && !finish; index++) await Promise.resolve();
    finish({ id: "first-repo" });
    expect((await first).threadId).toBe("first-repo");
    t.threads.set("coordinator-2", { ...t.threads.get("coordinator")!, id: "coordinator-2" });
    const other = t.store.save({ ...t.store.establish({ sourceKey: "group-b", name: "Review other work", goal: "", projectId: "coord-project",
      members: { tickets: [], prUrls: ["https://github.com/example/docs/pull/2"] } }), coordinatorThreadId: "coordinator-2", coordinatorState: "ready" });
    expect((await t.service.ensure({ ...t.input, effort: other, coordinatorThreadId: "coordinator-2" })).threadId).toBe("repo-1");
    expect(t.store.repoController(other.id, t.input.repo)?.threadId).toBe("repo-1");
    expect(t.store.repoController(t.input.effort.id, t.input.repo)?.threadId).toBe("first-repo");
  });

  it("keeps an ambiguous launch durable and recovers by metadata without a second spawn", async () => {
    const t = setup();
    vi.mocked(t.sdk.spawn).mockRejectedValueOnce(new Error("response lost"));
    await expect(t.service.ensure(t.input)).rejects.toThrow("response lost");
    expect(t.store.repoController(t.input.effort.id, t.input.repo)).toMatchObject({ state: "creating", threadId: null });
    await expect(createRepoControllerService(t.store, t.sdk).ensure(t.input)).rejects.toThrow("launch is uncertain");
    expect(t.sdk.spawn).toHaveBeenCalledTimes(1);
    t.threads.set("recovered", { id: "recovered", projectId: "repo-project", parentThreadId: "coordinator", status: "idle",
      canSpawnChild: true, archivedAt: null, deletedAt: null, environmentHostId: "repo-host" });
    vi.mocked(t.sdk.recover).mockResolvedValueOnce(["recovered"]);
    expect((await createRepoControllerService(t.store, t.sdk).ensure(t.input)).threadId).toBe("recovered");
    expect(t.sdk.spawn).toHaveBeenCalledTimes(1);
  });

  it("discards only a definitively rejected workspace claim before retrying", async () => {
    const t = setup();
    vi.mocked(t.sdk.spawn).mockRejectedValueOnce(Object.assign(new Error(
      "Workspace path is a bb-managed workspace owned by another project"), { status: 409 }));
    await expect(t.service.ensure(t.input)).rejects.toThrow("owned by another project");
    expect(t.store.repoController(t.input.effort.id, t.input.repo)).toBeNull();
    expect((await t.service.ensure(t.input)).threadId).toBe("repo-1");
    expect(t.sdk.spawn).toHaveBeenCalledTimes(2);
  });

  it("restores a deleted controller binding when its replacement workspace is rejected", async () => {
    const t = setup();
    await t.service.ensure(t.input);
    t.threads.get("repo-1")!.deletedAt = 1;
    vi.mocked(t.sdk.spawn).mockRejectedValueOnce(Object.assign(new Error(
      "Workspace path is inside bb-managed storage but is not a workspace of this project"), { status: 409 }));
    await expect(t.service.ensure(t.input)).rejects.toThrow("inside bb-managed storage");
    expect(t.store.repoController(t.input.effort.id, t.input.repo)).toMatchObject({
      threadId: "repo-1", state: "ready", previousThreadIds: [],
    });
    expect((await t.service.ensure(t.input)).threadId).toBe("repo-2");
    expect(t.store.repoController(t.input.effort.id, t.input.repo)?.previousThreadIds).toEqual(["repo-1"]);
  });

  it("does not reset a repository claim changed after the rejected attempt", async () => {
    const t = setup();
    const claim = t.store.claimRepoController({ effortId: t.input.effort.id, repo: t.input.repo,
      projectId: t.input.projectId, hostId: t.input.hostId }).record;
    t.store.saveRepoController({ ...claim, state: "ready", threadId: "another-controller" });
    expect(t.store.resetRejectedRepoController(claim, null)).toBe(false);
    expect(t.store.repoController(t.input.effort.id, t.input.repo)?.threadId).toBe("another-controller");
  });

  it("replaces a confirmed deleted controller once and retains its previous ID", async () => {
    const t = setup();
    await t.service.ensure(t.input);
    t.threads.get("repo-1")!.deletedAt = 1;
    let finish!: (value: { id: string }) => void;
    vi.mocked(t.sdk.spawn).mockImplementationOnce(async (args) => new Promise((resolve) => {
      t.threads.set("repo-2", { id: "repo-2", projectId: args.projectId, parentThreadId: args.parentThreadId, status: "active",
        canSpawnChild: true, archivedAt: null, deletedAt: null, environmentHostId: "repo-host" });
      finish = resolve;
    }));
    const replacement = t.service.ensure(t.input);
    const concurrent = t.service.ensure(t.input);
    for (let index = 0; index < 10 && !finish; index++) await Promise.resolve();
    expect(t.sdk.spawn).toHaveBeenCalledTimes(2);
    finish({ id: "repo-2" });
    expect((await replacement).threadId).toBe("repo-2");
    expect((await concurrent).threadId).toBe("repo-2");
    expect(t.store.repoController(t.input.effort.id, t.input.repo)?.previousThreadIds).toEqual(["repo-1"]);
    expect((await createRepoControllerService(t.store, t.sdk).ensure(t.input)).threadId).toBe("repo-2");
    expect(t.sdk.spawn).toHaveBeenCalledTimes(2);
  });

  it("keeps archived and unreadable controllers bound without launching replacements", async () => {
    const t = setup();
    await t.service.ensure(t.input);
    t.threads.get("repo-1")!.archivedAt = 1;
    await expect(t.service.ensure(t.input)).rejects.toThrow("Unarchive");
    expect(t.store.repoController(t.input.effort.id, t.input.repo)?.state).toBe("unavailable");
    t.threads.get("repo-1")!.archivedAt = null;
    expect((await t.service.ensure(t.input)).threadId).toBe("repo-1");
    const get = vi.mocked(t.sdk.get).getMockImplementation()!;
    vi.mocked(t.sdk.get).mockImplementation((id) => id === "repo-1" ? Promise.reject(new Error("transport unavailable")) : get(id));
    await expect(t.service.ensure(t.input)).rejects.toThrow("could not be inspected");
    expect(t.sdk.spawn).toHaveBeenCalledTimes(1);
  });
});
