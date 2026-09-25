import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parsePrList } from "./gh.js";
import { createInventoryStore, INVENTORY_MIGRATIONS } from "./inventory-store.js";
import { INVENTORY_LIMIT, type InventoryEntry, type InventoryResult } from "./inventory.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function setup() {
  const db = new Database(":memory:");
  databases.push(db);
  for (const migration of INVENTORY_MIGRATIONS) db.exec(migration);
  let clock = 1_000;
  return { db, store: createInventoryStore(db, () => clock), tick: () => { clock += 1_000; } };
}
function entry(number: number, repo = "inkwell/folio"): InventoryEntry {
  return { repo, pr: parsePrList(JSON.stringify([{ number, state: "OPEN", url: `https://github.com/${repo}/pull/${number}`, title: "Improve manuscript review" }]))!.pr };
}
function result(entries: InventoryEntry[], extra: Partial<InventoryResult> = {}): InventoryResult {
  return { owners: ["inkwell"], entries, discoveryComplete: true, complete: true, warnings: [],
    repositories: [...new Set(entries.map((row) => row.repo))].map((repo) => ({ repo, complete: true })), ...extra };
}

describe("authored PR cache coverage", () => {
  it("finds a URL without case sensitivity and refuses closed or corrupt persisted rows", () => {
    const { db, store } = setup();
    const first = entry(1);
    store.apply(result([first]));
    expect(store.get(first.pr.url.toUpperCase())?.pr.number).toBe(1);
    db.prepare(`UPDATE authored_prs SET entry = ? WHERE url = ?`).run(JSON.stringify({ ...first, pr: { ...first.pr, state: "CLOSED" } }), first.pr.url);
    expect(store.get(first.pr.url)).toBeUndefined();
    db.prepare(`UPDATE authored_prs SET entry = ? WHERE url = ?`).run("bad json", first.pr.url);
    expect(store.get(first.pr.url)).toBeUndefined();
  });

  it("removes closed PRs in successful repositories while retaining failed repositories as stale", () => {
    const { store, tick } = setup();
    store.apply(result([entry(1), entry(2, "inkwell/spine")]));
    const success = store.read().lastSuccessAt;
    tick();
    store.apply(result([], { complete: false, repositories: [
      { repo: "inkwell/folio", complete: true }, { repo: "inkwell/spine", complete: false },
    ], warnings: ["spine is offline"] }));
    expect(store.read()).toMatchObject({ complete: false, lastSuccessAt: success, entries: [{ repo: "inkwell/spine", stale: true }] });
    expect(store.read().lastAttemptAt).not.toBe(success);
  });

  it("removes undiscovered repositories only when discovery is complete", () => {
    const { store } = setup();
    store.apply(result([entry(1), entry(2, "inkwell/spine")]));
    store.apply(result([entry(1)], { complete: false, discoveryComplete: false }));
    expect(store.read().entries).toHaveLength(2);
    store.apply(result([entry(1)]));
    expect(store.read().entries.map((row) => row.repo)).toEqual(["inkwell/folio"]);
  });

  it("removes organizations outside the current project scope even when discovery fails", () => {
    const { store } = setup();
    store.apply(result([entry(1), entry(2, "margin/paper")], { owners: ["inkwell", "margin"] }));
    store.apply(result([], { complete: false, discoveryComplete: false }));
    expect(store.read().entries).toMatchObject([{ repo: "inkwell/folio", stale: true }]);
  });

  it("keeps a targeted failed read stale, removes confirmed closed PRs, and refuses unrelated inserts", () => {
    const { store } = setup();
    const first = entry(1), second = entry(2);
    store.apply(result([first, second]));
    store.inspect({ entries: [entry(3)], closed: [first.pr.url], failed: [second.pr.url], warnings: ["offline"] });
    expect(store.read()).toMatchObject({ complete: false, entries: [{ pr: { number: 2 }, stale: true }] });
    store.inspect({ entries: [second], closed: [], failed: [], warnings: [] });
    expect(store.get(second.pr.url)?.stale).toBe(false);
  });

  it("bounds retained failed-repository history when new repositories arrive", () => {
    const { store } = setup();
    store.apply(result(Array.from({ length: INVENTORY_LIMIT }, (_, index) => entry(index + 1))));
    const fresh = entry(1, "inkwell/spine");
    store.apply(result([fresh], { complete: false, discoveryComplete: false }));
    expect(store.read().entries).toHaveLength(INVENTORY_LIMIT);
    expect(store.get(fresh.pr.url)?.stale).toBe(false);
    expect(store.read().warnings[0]).toContain("limit");
  });

  it("reflects fresh checkout observations without adding unauthored PRs", () => {
    const { store } = setup();
    const first = entry(1);
    store.apply(result([first]));
    store.observe([{ ...first.pr, state: "CLOSED" }, entry(2).pr]);
    expect(store.read().entries).toEqual([]);
  });
});
