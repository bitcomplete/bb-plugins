import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createEffortStore, EFFORT_MIGRATIONS, normalizeMembers, sameMembers } from "./effort-store.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const url = "https://github.com/inkwell/folio/pull/42";
const input = { sourceKey: "suggested", name: "Improve review", goal: "Review manuscripts reliably", projectId: "project", members: { tickets: ["ABC-101"], prUrls: [url] } };
function setup() {
  const db = new Database(":memory:"); databases.push(db);
  EFFORT_MIGRATIONS.forEach((sql) => db.exec(sql));
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
});
