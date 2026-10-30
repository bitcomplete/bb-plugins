import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createEffortStore, EFFORT_MIGRATIONS, REPO_CONTROLLER_MIGRATION, normalizeMembers, sameMembers } from "./effort-store.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const url = "https://github.com/inkwell/folio/pull/42";
const input = { sourceKey: "suggested", name: "Improve review", goal: "Review manuscripts reliably", projectId: "project", members: { tickets: ["ABC-101"], prUrls: [url] } };
function setup() {
  const db = new Database(":memory:"); databases.push(db);
  EFFORT_MIGRATIONS.forEach((sql) => db.exec(sql));
  db.exec(REPO_CONTROLLER_MIGRATION);
  return { db, store: createEffortStore(db, () => 1000) };
}

describe("established effort storage", () => {
  it("keeps one durable identity across the suggested key, stable key, and reload", () => {
    const { store, db } = setup();
    const first = store.establish(input);
    expect(store.establish(input)).toEqual(first);
    expect(store.establish({ ...input, sourceKey: first.key })).toEqual(first);
    const reloaded = createEffortStore(db);
    expect(reloaded.source(input.sourceKey)).toEqual(first);
    expect(reloaded.get(first.id)).toEqual(first);
    expect(reloaded.get(first.key)).toEqual(first);
    expect(reloaded.owner("ticket", "ABC-101")?.id).toBe(first.id);
    expect(reloaded.owner("prUrl", url.toUpperCase())?.id).toBe(first.id);
    expect(reloaded.list()).toHaveLength(1);
  });

  it("rejects conflicting ownership without leaving partial new effort or member records", () => {
    const { store } = setup();
    const first = store.establish(input);
    for (const members of [
      { tickets: ["ABC-202", "ABC-101"], prUrls: [] },
      { tickets: ["ABC-202"], prUrls: [url.toUpperCase()] },
    ]) expect(() => store.establish({ ...input, sourceKey: "another", members })).toThrow("already belongs");
    expect(store.source("another")).toBeNull();
    expect(store.owner("ticket", "ABC-202")).toBeNull();
    expect(store.list().map((effort) => effort.id)).toEqual([first.id]);
  });

  it("normalizes membership for order-independent stale-preview checks", () => {
    const members = { tickets: ["ABC-202", "ABC-101", "ABC-101"], prUrls: [url.toUpperCase(), url] };
    expect(normalizeMembers(members)).toEqual({ tickets: ["ABC-101", "ABC-202"], prUrls: [url] });
    expect(sameMembers(members, { tickets: ["ABC-101", "ABC-202"], prUrls: [url] })).toBe(true);
    expect(sameMembers(members, input.members)).toBe(false);
  });

  it("keeps worker history tied to one effort and PR", () => {
    const { store } = setup();
    const effort = store.establish(input);
    store.recordWorker(effort.id, "worker", url.toUpperCase(), "pr");
    store.recordWorker(effort.id, "followup", url, "followup");
    expect(store.workers(effort.id, url).map((worker) => worker.threadId).sort()).toEqual(["followup", "worker"]);
    expect(store.workers("another-effort", url)).toEqual([]);
    expect(store.workers(effort.id, `${url}0`)).toEqual([]);
  });

  it("promotes an ordinary group and transfers a ticket with its PRs atomically", () => {
    const { store, db } = setup();
    const source = store.establish(input);
    store.recordWorker(source.id, "worker", url, "pr");
    const other = "https://github.com/inkwell/folio/pull/43";
    const destination = store.transfer("ordinary-group", { tickets: ["ABC-101"], prUrls: [url] },
      { name: "Editorial workflow", members: { tickets: ["ABC-202"], prUrls: [other] } });
    expect(destination).toMatchObject({ name: "Editorial workflow", coordinatorState: "none",
      members: { tickets: ["ABC-101", "ABC-202"], prUrls: [url, other] } });
    expect(store.source("ordinary-group")?.id).toBe(destination.id);
    expect(store.owner("ticket", "ABC-101")?.id).toBe(destination.id);
    expect(store.owner("prUrl", url)?.id).toBe(destination.id);
    expect(store.get(source.id)?.members).toEqual({ tickets: [], prUrls: [] });
    expect(store.workers(source.id, url)).toEqual([{ threadId: "worker", role: "pr" }]);
    const reloaded = createEffortStore(db);
    expect(reloaded.owner("ticket", "ABC-202")?.id).toBe(destination.id);
    expect(reloaded.owner("prUrl", other)?.id).toBe(destination.id);
  });

  it("rolls back promotion when one inherited member is already owned", () => {
    const { store } = setup();
    const source = store.establish(input);
    expect(() => store.transfer("ordinary-group", { tickets: ["ABC-101"], prUrls: [url] },
      { name: "Editorial workflow", members: { tickets: ["ABC-202"], prUrls: [url] } })).toThrow("Destination membership changed");
    expect(store.source("ordinary-group")).toBeNull();
    expect(store.owner("ticket", "ABC-202")).toBeNull();
    expect(store.owner("ticket", "ABC-101")?.id).toBe(source.id);
  });

  it("does not restore stale membership during an unrelated coordinator state save", () => {
    const { store } = setup();
    const captured = store.establish(input);
    const destination = store.establish({ ...input, sourceKey: "destination", members: { tickets: ["ABC-202"], prUrls: [] } });
    store.transfer(destination.key, input.members);
    store.save({ ...captured, coordinatorState: "ready" });
    expect(store.get(captured.id)?.members).toEqual({ tickets: [], prUrls: [] });
    expect(store.owner("ticket", "ABC-101")?.id).toBe(destination.id);
    expect(store.owner("prUrl", url)?.id).toBe(destination.id);
  });

  it("inherits an unowned PR cohort once and leaves explicit ownership untouched", () => {
    const { store, db } = setup();
    const destination = store.establish({ ...input, sourceKey: "destination", members: { tickets: [], prUrls: [] }, coordinatorState: "none" });
    const conflicting = store.establish({ ...input, sourceKey: "other", members: { tickets: ["ABC-202"], prUrls: [] } });
    const cohort = { tickets: ["ABC-101"], prUrls: [url] };
    expect(store.claimUnowned(destination.key, cohort)).toMatchObject({ conflict: false, claimed: cohort });
    expect(store.claimUnowned(destination.key, cohort)).toMatchObject({ conflict: false, claimed: { tickets: [], prUrls: [] } });
    const blocked = { tickets: ["ABC-202"], prUrls: ["https://github.com/inkwell/folio/pull/43"] };
    expect(store.claimUnowned(destination.key, blocked)).toMatchObject({ conflict: true, claimed: { tickets: [], prUrls: [] } });
    expect(store.owner("ticket", "ABC-202")?.id).toBe(conflicting.id);
    expect(store.owner("prUrl", blocked.prUrls[0]!)?.id).toBeUndefined();
    const sibling = "https://github.com/inkwell/folio/pull/44";
    store.claimUnowned(conflicting.key, { tickets: [], prUrls: [sibling] });
    expect(store.claimUnowned(destination.key, { tickets: ["ABC-303"], prUrls: [blocked.prUrls[0]!] },
      { tickets: ["ABC-303"], prUrls: [blocked.prUrls[0]!, sibling] })).toMatchObject({ conflict: true });
    expect(store.owner("ticket", "ABC-303")).toBeNull();
    expect(createEffortStore(db).get(destination.id)?.members).toEqual(cohort);
  });

  it("sees explicit PR owners across copied URL variants without rewriting their rows", () => {
    const { store, db } = setup();
    const copied = `${url.toUpperCase()}/?view=files`;
    const owner = store.establish({ ...input, sourceKey: "legacy", members: { tickets: [], prUrls: [copied] } });
    const destination = store.establish({ ...input, sourceKey: "new", members: { tickets: [], prUrls: [] } });
    expect(store.claimUnowned(destination.key, { tickets: ["ABC-101"], prUrls: [url] })).toMatchObject({ conflict: true });
    expect(store.owner("ticket", "ABC-101")).toBeNull();
    expect(store.get(owner.id)?.members.prUrls).toEqual([copied.toLowerCase()]);
    expect((db.prepare(`SELECT ref FROM effort_members WHERE effort_id = ?`).all(owner.id) as { ref: string }[])
      .map((row) => row.ref)).toEqual([copied.toLowerCase()]);
    expect(() => store.transfer("suggested-group", { tickets: [], prUrls: [] },
      { name: "Suggested", members: { tickets: [], prUrls: [url] } })).toThrow("Destination membership changed");
  });

  it("moves a copied PR URL by canonical identity and removes its old row and JSON member", () => {
    const { store, db } = setup();
    const copied = `${url.toUpperCase()}/?view=files`;
    const previous = store.establish({ ...input, sourceKey: "legacy", members: { tickets: [], prUrls: [copied] } });
    const destination = store.establish({ ...input, sourceKey: "destination", members: { tickets: [], prUrls: [] } });
    expect(store.owner("prUrl", url)?.id).toBe(previous.id);
    store.transfer(destination.key, { tickets: [], prUrls: [url] });
    const reloaded = createEffortStore(db);
    expect(reloaded.owner("prUrl", `${url}/?tab=files`)?.id).toBe(destination.id);
    expect(reloaded.get(previous.id)?.members.prUrls).toEqual([]);
    expect(reloaded.get(destination.id)?.members.prUrls).toEqual([url]);
    expect((db.prepare(`SELECT ref FROM effort_members WHERE kind = 'prUrl'`).all() as { ref: string }[])
      .map((row) => row.ref)).toEqual([url]);
  });

  it("rejects conflicting copied-URL owners without changing either effort", () => {
    const { store } = setup();
    const legacy = store.establish({ ...input, sourceKey: "legacy", members: { tickets: [], prUrls: [`${url}/?view=files`] } });
    const exact = store.establish({ ...input, sourceKey: "exact", members: { tickets: [], prUrls: [url] } });
    const destination = store.establish({ ...input, sourceKey: "destination", members: { tickets: [], prUrls: [] } });
    expect(() => store.transfer(destination.key, { tickets: [], prUrls: [url] })).toThrow("Conflicting ownership");
    expect(store.get(legacy.id)?.members.prUrls).toEqual([`${url}/?view=files`]);
    expect(store.get(exact.id)?.members.prUrls).toEqual([url]);
    expect(store.get(destination.id)?.members.prUrls).toEqual([]);
  });

  it("rejects an oversized automatic claim before changing ownership or the readable effort", () => {
    const { store, db } = setup();
    const tickets = Array.from({ length: 1000 }, (_, index) => `ABC-${index}`);
    const destination = store.establish({ ...input, members: { tickets, prUrls: [] } });
    const extra = "ABC-1000";
    expect(() => store.claimUnowned(destination.key, { tickets: [extra], prUrls: [url] })).toThrow();
    expect(store.owner("ticket", extra)).toBeNull();
    expect(store.owner("prUrl", url)).toBeNull();
    expect(createEffortStore(db).get(destination.id)?.members).toEqual(normalizeMembers({ tickets, prUrls: [] }));
    expect(store.list()).toHaveLength(1);
  });

  it("keeps archived work owned and prevents a stale coordinator save from undoing admin edits", () => {
    const { store, db } = setup();
    const captured = store.establish(input);
    const renamed = store.updateDetails(captured.id, { name: "Editorial review", goal: "Ship the review" });
    expect(renamed).toMatchObject({ name: "Editorial review", goal: "Ship the review" });
    store.setArchived(captured.id, true);
    store.save({ ...captured, coordinatorState: "ready" });
    const reloaded = createEffortStore(db);
    expect(reloaded.get(captured.id)).toMatchObject({ name: "Editorial review", goal: "Ship the review", archivedAt: 1000 });
    expect(reloaded.owner("ticket", "ABC-101")?.id).toBe(captured.id);
    expect(reloaded.list().map((effort) => effort.id)).toEqual([captured.id]);
    expect(() => reloaded.claimUnowned(captured.key, { tickets: ["ABC-202"], prUrls: [] })).toThrow("destination effort changed");
    expect(store.setArchived(captured.id, false).archivedAt).toBeNull();
    expect(reloaded.owner("prUrl", url)?.id).toBe(captured.id);
  });

  it("does not change the revision when a coordinator refresh saves the same state", () => {
    const { store } = setup();
    const effort = store.establish(input);
    const ready = store.save({ ...effort, coordinatorState: "ready" });
    expect(Object.hasOwn(ready, "archivedAt")).toBe(false);
    expect(Object.hasOwn(ready, "mergedInto")).toBe(false);
    expect(ready.updatedAt).toBeGreaterThan(effort.updatedAt);
    expect(store.save({ ...ready }).updatedAt).toBe(ready.updatedAt);
    expect(store.updateDetails(effort.id, { name: ready.name }).updatedAt).toBe(ready.updatedAt);
  });

  it("merges ownership and worker history while old keys resolve to the surviving effort", () => {
    const { store, db } = setup();
    const copied = `${url}/?view=files`;
    const source = store.establish({ ...input, sourceKey: "source-key", members: { tickets: ["ABC-101"], prUrls: [copied], checkoutPaths: ["/source"] } });
    const destination = store.establish({ ...input, sourceKey: "destination-key", members: { tickets: ["ABC-202"], prUrls: [url], checkoutPaths: ["/destination"] } });
    store.recordWorker(source.id, "worker-source", copied, "pr");
    store.recordWorker(destination.id, "worker-destination", url, "followup");
    store.save({ ...source, coordinatorThreadId: "coordinator-source", coordinatorState: "ready" });
    const sourceRepo = store.claimRepoController({ effortId: source.id, repo: "inkwell/folio", projectId: "project", hostId: "host" }).record;
    store.saveRepoController({ ...sourceRepo, threadId: "repo-source", state: "ready" });
    const destinationRepo = store.claimRepoController({ effortId: destination.id, repo: "inkwell/folio", projectId: "project", hostId: "host" }).record;
    store.saveRepoController({ ...destinationRepo, threadId: "repo-destination", state: "ready" });
    const otherRepo = store.claimRepoController({ effortId: source.id, repo: "inkwell/other", projectId: "project", hostId: "host" }).record;
    store.saveRepoController({ ...otherRepo, threadId: "repo-other", state: "ready" });

    const merged = store.merge(source.id, destination.id);
    const reloaded = createEffortStore(db);
    expect(merged.members).toEqual({ tickets: ["ABC-101", "ABC-202"], prUrls: [url], checkoutPaths: ["/destination", "/source"] });
    expect(reloaded.get(source.id)?.id).toBe(destination.id);
    expect(reloaded.source(source.key)?.id).toBe(destination.id);
    expect(reloaded.source("source-key")?.id).toBe(destination.id);
    expect(reloaded.sourceKey(source.id)).toBe("destination-key");
    expect(reloaded.getRecord(source.id)).toMatchObject({ mergedInto: destination.id, coordinatorThreadId: "coordinator-source", members: { tickets: [], prUrls: [] } });
    expect(reloaded.list().map((effort) => effort.id)).toEqual([destination.id]);
    expect(reloaded.listAll()).toHaveLength(2);
    expect(reloaded.owner("ticket", "ABC-101")?.id).toBe(destination.id);
    expect(reloaded.owner("checkoutPath", "/source")?.id).toBe(destination.id);
    expect(reloaded.owner("prUrl", copied)?.id).toBe(destination.id);
    expect(reloaded.workers(destination.id, url).map((worker) => worker.threadId).sort()).toEqual(["worker-destination", "worker-source"]);
    expect(reloaded.workers(source.id, copied).map((worker) => worker.threadId).sort()).toEqual(["worker-destination", "worker-source"]);
    expect(reloaded.repoController(source.id, "inkwell/folio")?.threadId).toBe("repo-destination");
    expect(reloaded.repoController(destination.id, "inkwell/other")?.threadId).toBe("repo-other");
    expect(reloaded.repoControllers(source.id).map((record) => record.threadId)).toContain("repo-source");
    expect(reloaded.workersForEffort(destination.id)).toHaveLength(2);
    expect(reloaded.establish({ ...input, sourceKey: "source-key" }).id).toBe(destination.id);
    expect(reloaded.save({ ...source, coordinatorState: "unavailable" }).id).toBe(destination.id);
    expect(reloaded.getRecord(source.id)?.mergedInto).toBe(destination.id);
    expect(reloaded.get(destination.id)?.members.tickets).toEqual(["ABC-101", "ABC-202"]);
    expect((db.prepare(`SELECT ref FROM effort_members WHERE kind = 'prUrl'`).all() as { ref: string }[]).map((row) => row.ref)).toEqual([url]);
  });

  it("rolls back a merge when repository controller bindings disagree", () => {
    const { store } = setup();
    const source = store.establish(input);
    const destination = store.establish({ ...input, sourceKey: "destination", members: { tickets: ["ABC-202"], prUrls: [] } });
    store.claimRepoController({ effortId: source.id, repo: "inkwell/folio", projectId: "project", hostId: "host-a" });
    store.claimRepoController({ effortId: destination.id, repo: "inkwell/folio", projectId: "project", hostId: "host-b" });
    expect(() => store.merge(source.id, destination.id)).toThrow("different projects or hosts");
    expect(store.getRecord(source.id)?.mergedInto).toBeUndefined();
    expect(store.owner("ticket", "ABC-101")?.id).toBe(source.id);
    expect(store.owner("prUrl", url)?.id).toBe(source.id);
    expect(store.list()).toHaveLength(2);
  });

  it("adopts the source coordinator only when the destination has no coordinator", () => {
    const { store } = setup();
    const source = store.establish(input);
    store.save({ ...source, coordinatorThreadId: "source-coordinator", coordinatorState: "ready" });
    const destination = store.establish({ ...input, sourceKey: "destination", members: { tickets: ["ABC-202"], prUrls: [] },
      projectId: "other-project", coordinatorState: "none" });
    expect(store.merge(source.id, destination.id)).toMatchObject({
      coordinatorThreadId: "source-coordinator", coordinatorState: "ready", projectId: "project",
    });

    const secondSource = store.establish({ ...input, sourceKey: "second-source", members: { tickets: ["ABC-303"], prUrls: [] } });
    store.save({ ...secondSource, coordinatorThreadId: "second-coordinator", coordinatorState: "ready" });
    expect(store.merge(secondSource.id, destination.id).coordinatorThreadId).toBe("source-coordinator");
    expect(store.getRecord(secondSource.id)?.coordinatorThreadId).toBe("second-coordinator");
  });
});
