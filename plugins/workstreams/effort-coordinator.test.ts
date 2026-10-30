import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEffortStore, EFFORT_MIGRATIONS, REPO_CONTROLLER_MIGRATION } from "./effort-store.js";
import { createCoordinatorService, type CoordinatorSdk, type EffortPlan } from "./effort-coordinator.js";
import { inventoryEffort } from "./effort-membership.js";

const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
const members = { tickets: ["ABC-101"], prUrls: ["https://github.com/inkwell/folio/pull/42"] };
const input = { groupKey: "suggested", name: "Improve review", goal: "Review manuscripts reliably", projectId: "proj-1", members };
const plan: EffortPlan = { ok: true, name: input.name, goal: "", members, projects: [{ id: "proj-1", name: "Folio" }], threads: [{ id: "existing", title: "Prior planning", projectId: "proj-1" }], effort: null };
function setup() {
  const db = new Database(":memory:"); dbs.push(db); EFFORT_MIGRATIONS.forEach((sql) => db.exec(sql)); db.exec(REPO_CONTROLLER_MIGRATION);
  const store = createEffortStore(db);
  const sdk: CoordinatorSdk = { get: vi.fn(async (id) => ({ id, projectId: "proj-1", title: null, status: "idle", archivedAt: null, deletedAt: null, canSpawnChild: true })),
    rename: vi.fn(async () => undefined), associate: vi.fn(async () => undefined), recover: vi.fn(async () => []), spawn: vi.fn(async () => ({ id: "spawned" })),
    models: async () => ({ code: { providerId: "codex", model: "gpt-6-sol", reasoningLevel: "high" }, planning: { providerId: "codex", model: "gpt-6-sol", reasoningLevel: "medium" } }) };
  return { store, sdk, service: createCoordinatorService(store, sdk) };
}
describe("coordinator identity and launch safety", () => {
  it("lazily creates a coordinator for an established effort in its saved project", async () => {
    const { store, sdk, service } = setup();
    const existing = store.establish({ ...input, sourceKey: "group-a", coordinatorState: "none" });
    const ready = await service.ensureExisting(existing.id, "another-repository-project");
    expect(ready).toMatchObject({ id: existing.id, coordinatorThreadId: "spawned", coordinatorState: "ready", projectId: input.projectId });
    expect(sdk.spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: input.projectId }));
  });
  it("launches once for a coordinator-free promoted effort and preserves its identity", async () => {
    const { store, sdk, service } = setup();
    const promoted = store.establish({ ...input, sourceKey: input.groupKey, goal: "", projectId: "", coordinatorState: "none" });
    expect(await service.coordinate(input, { ...plan, effort: promoted })).toMatchObject({ ok: true,
      effort: { id: promoted.id, coordinatorState: "ready", coordinatorThreadId: "spawned", goal: input.goal, projectId: input.projectId } });
    expect(sdk.spawn).toHaveBeenCalledTimes(1);
    expect(await service.coordinate(input, plan)).toMatchObject({ ok: true, effort: { id: promoted.id } });
    expect(sdk.spawn).toHaveBeenCalledTimes(1);
  });

  it("does not launch twice after an ambiguous coordinator-free promotion launch", async () => {
    const { store, sdk, service } = setup();
    store.establish({ ...input, sourceKey: input.groupKey, goal: "", projectId: "", coordinatorState: "none" });
    vi.mocked(sdk.spawn).mockRejectedValue(new Error("transport lost"));
    expect(await service.coordinate(input, plan)).toMatchObject({ ok: false });
    expect(await service.coordinate(input, plan)).toMatchObject({ ok: false });
    expect(sdk.spawn).toHaveBeenCalledTimes(1);
    expect(store.source(input.groupKey)?.coordinatorState).toBe("creating");
  });
  it("releases only a definitively rejected workspace claim so the same effort can retry", async () => {
    const { store, sdk, service } = setup();
    vi.mocked(sdk.spawn).mockRejectedValueOnce(Object.assign(new Error(
      "Workspace path is inside bb-managed storage but is not a workspace of this project"), { status: 409 }));
    expect(await service.coordinate(input, plan)).toMatchObject({ ok: false });
    const rejected = store.source(input.groupKey)!;
    expect(rejected).toMatchObject({ coordinatorState: "none", coordinatorThreadId: null });
    expect(await service.coordinate(input, plan)).toMatchObject({ ok: true,
      effort: { id: rejected.id, coordinatorState: "ready", coordinatorThreadId: "spawned" } });
    expect(sdk.spawn).toHaveBeenCalledTimes(2);
  });
  it("does not reset a coordinator claim changed after the rejected attempt", () => {
    const { store } = setup();
    const claim = store.establish({ ...input, sourceKey: "claim" });
    store.save({ ...claim, name: "Updated review" });
    expect(store.resetRejectedCoordinator(claim)).toBe(false);
    expect(store.get(claim.id)).toMatchObject({ coordinatorState: "creating", name: "Updated review" });
  });
  it("deduplicates a double click after the durable record exists but before spawn returns", async () => {
    const { store, sdk, service } = setup();
    let finish!: (thread: { id: string }) => void;
    vi.mocked(sdk.spawn).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = service.coordinate(input, plan);
    const stableKey = store.source(input.groupKey)!.key;
    const second = service.coordinate(input, plan);
    const third = service.coordinate({ ...input, groupKey: stableKey }, plan);
    await vi.waitFor(() => expect(sdk.spawn).toHaveBeenCalledTimes(1));
    finish({ id: "spawned" });
    expect(await first).toEqual(await second); expect(await second).toEqual(await third);
    expect(sdk.spawn).toHaveBeenCalledTimes(1);
  });
  it("recovers a completed spawn after reload without creating a second coordinator", async () => {
    const { store, sdk } = setup();
    const record = store.establish({ sourceKey: input.groupKey, ...input });
    vi.mocked(sdk.recover).mockResolvedValue(["recovered"]);
    const result = await createCoordinatorService(store, sdk).coordinate(input, plan);
    expect(result).toMatchObject({ ok: true, effort: { id: record.id, coordinatorThreadId: "recovered" } });
    expect(sdk.spawn).not.toHaveBeenCalled();
  });
  it("fails closed after an ambiguous launch and permits explicitly associating a verified existing thread", async () => {
    const { store, sdk, service } = setup();
    vi.mocked(sdk.spawn).mockRejectedValue(new Error("transport lost"));
    expect(await service.coordinate(input, plan)).toMatchObject({ ok: false });
    expect(await service.coordinate(input, plan)).toMatchObject({ ok: false });
    expect(sdk.spawn).toHaveBeenCalledTimes(1);
    expect(await service.coordinate({ ...input, threadId: "existing" }, plan)).toMatchObject({ ok: true });
    expect(store.list()).toHaveLength(1);
    expect(sdk.rename).toHaveBeenCalledWith("existing", "🔍 Improve review");
  });
  it("preserves explicit URL ownership when a title mentions a different effort ticket", () => {
    const { store } = setup();
    const exact = store.establish({ sourceKey: "a", ...input });
    store.establish({ sourceKey: "b", ...input, members: { tickets: ["ABC-202"], prUrls: [] } });
    expect(inventoryEffort({ url: members.prUrls[0]!, title: "Follow ABC-202", headRefName: "fix" }, [], store.list(), /([A-Z]+)-(\d+)/gu)).toEqual({ effortKey: exact.key, effortName: exact.name });
  });
  it("attaches remote siblings by exact ticket without creating a checkout", () => {
    const { store } = setup();
    const effort = store.establish({ sourceKey: "a", ...input });
    expect(inventoryEffort({ url: "https://github.com/inkwell/other/pull/2", title: "ABC-101 client changes", headRefName: "fix" }, [], store.list(), /([A-Z]+)-(\d+)/gu)?.effortKey).toBe(effort.key);
  });
});

describe("coordinator association guards", () => {
  it("keeps an already linked coordinator's title when opening its established effort", async () => {
    const { store, sdk, service } = setup();
    store.save({ ...store.establish({ sourceKey: input.groupKey, ...input }), coordinatorThreadId: "existing", coordinatorState: "ready" });
    vi.mocked(sdk.get).mockResolvedValue({ id: "existing", projectId: "proj-1", title: "🧭 Improve review", status: "idle", archivedAt: null, deletedAt: null, canSpawnChild: true });
    expect(await service.coordinate(input, plan)).toMatchObject({ ok: true, effort: { coordinatorThreadId: "existing" } });
    expect(sdk.rename).not.toHaveBeenCalled();
    expect(sdk.spawn).not.toHaveBeenCalled();
  });

  it("rejects a stale scope before writing identity or launching anything", async () => {
    const { store, sdk, service } = setup();
    expect(await service.coordinate({ ...input, members: { ...members, tickets: ["ABC-202"] } }, plan)).toMatchObject({ ok: false, error: expect.stringContaining("membership changed") });
    expect(store.list()).toEqual([]);
    expect(sdk.spawn).not.toHaveBeenCalled();
    expect(sdk.rename).not.toHaveBeenCalled();
  });

  it("reuses one idle thread with one exact title update and no new turn or coordinator", async () => {
    const { store, sdk, service } = setup();
    const args = { ...input, threadId: "existing" };
    expect(await service.coordinate(args, plan)).toMatchObject({ ok: true, effort: { coordinatorThreadId: "existing" } });
    expect(await service.coordinate(args, plan)).toMatchObject({ ok: true, effort: { coordinatorThreadId: "existing" } });
    expect(sdk.rename).toHaveBeenCalledExactlyOnceWith("existing", "🔍 Improve review");
    expect(sdk.associate).toHaveBeenCalledExactlyOnceWith("existing", store.list()[0]!.id);
    expect(sdk.spawn).not.toHaveBeenCalled();
    expect(store.list()).toHaveLength(1);
  });

  it.each([
    { projectId: "other" }, { status: "running" }, { archivedAt: 1 }, { deletedAt: 1 }, { canSpawnChild: false },
  ])("rechecks reuse eligibility at execution time: %j", async (change) => {
    const { store, sdk, service } = setup();
    vi.mocked(sdk.get).mockResolvedValue({ id: "existing", projectId: "proj-1", title: "Prior planning", status: "idle", archivedAt: null, deletedAt: null, canSpawnChild: true, ...change });
    expect(await service.coordinate({ ...input, threadId: "existing" }, plan)).toMatchObject({ ok: false });
    expect(sdk.rename).not.toHaveBeenCalled();
    expect(sdk.spawn).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it("does not claim a reused thread when its rename fails", async () => {
    const { store, sdk, service } = setup();
    vi.mocked(sdk.rename).mockRejectedValueOnce(new Error("offline"));
    expect(await service.coordinate({ ...input, threadId: "existing" }, plan)).toMatchObject({ ok: false });
    expect(store.source(input.groupKey)?.coordinatorThreadId).toBeNull();
    expect(sdk.spawn).not.toHaveBeenCalled();
    expect(await service.coordinate({ ...input, threadId: "existing" }, plan)).toMatchObject({ ok: true, effort: { coordinatorThreadId: "existing" } });
    expect(store.list()).toHaveLength(1);
  });

  it("permits explicitly replacing a missing coordinator while retaining the effort identity", async () => {
    const { store, sdk, service } = setup();
    const saved = store.save({ ...store.establish({ sourceKey: input.groupKey, ...input }), coordinatorThreadId: "missing", coordinatorState: "unavailable" });
    vi.mocked(sdk.get).mockImplementation(async (id) => {
      if (id === "missing") throw new Error("not found");
      return { id, projectId: "proj-1", title: "Prior planning", status: "idle", archivedAt: null, deletedAt: null, canSpawnChild: true };
    });
    expect(await service.coordinate(input, plan)).toMatchObject({ ok: false });
    expect(await service.coordinate({ ...input, threadId: "existing" }, plan)).toMatchObject({ ok: true, effort: { id: saved.id, coordinatorThreadId: "existing" } });
    expect(sdk.spawn).not.toHaveBeenCalled();
  });

  it("prevents concurrent and later attempts to reuse one coordinator for different efforts", async () => {
    const { store, sdk, service } = setup();
    let release!: () => void;
    vi.mocked(sdk.rename).mockImplementation(() => new Promise((resolve) => { release = () => resolve(undefined); }));
    const first = service.coordinate({ ...input, threadId: "existing" }, plan);
    const otherMembers = { tickets: ["ABC-202"], prUrls: [] };
    const other = { ...input, groupKey: "another", members: otherMembers, threadId: "existing" };
    const otherPlan: EffortPlan = { ...plan, members: otherMembers };
    expect(await service.coordinate(other, otherPlan)).toMatchObject({ ok: false });
    expect(sdk.rename).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await service.coordinate(other, otherPlan)).toMatchObject({ ok: false, error: expect.stringContaining("another effort") });
    expect(store.list()).toHaveLength(1);
  });

  it("leaves ambiguous ticket membership unassigned rather than guessing from wording", () => {
    const { store } = setup();
    store.establish({ sourceKey: "a", ...input });
    store.establish({ sourceKey: "b", ...input, members: { tickets: ["ABC-202"], prUrls: [] } });
    const remote = { url: "https://github.com/inkwell/other/pull/2", title: "ABC-101 and ABC-202 manuscripts review", headRefName: "fix" };
    expect(inventoryEffort(remote, [], store.list(), /([A-Z]+)-(\d+)/gu)).toBeNull();
    expect(inventoryEffort({ ...remote, title: "Improve review" }, [], store.list(), /([A-Z]+)-(\d+)/gu)).toBeNull();
  });
});

it("keeps a failed metadata association recoverable without spawning another thread", async () => {
  const { store, sdk, service } = setup();
  vi.mocked(sdk.associate).mockRejectedValueOnce(new Error("metadata unavailable"));
  expect(await service.coordinate({ ...input, threadId: "existing" }, plan)).toMatchObject({ ok: false });
  const identity = store.source(input.groupKey)!;
  expect(identity.coordinatorThreadId).toBeNull();
  expect(await service.coordinate({ ...input, threadId: "existing" }, plan)).toMatchObject({ ok: true, effort: { id: identity.id, coordinatorThreadId: "existing" } });
  expect(sdk.spawn).not.toHaveBeenCalled();
  expect(store.list()).toHaveLength(1);
});
