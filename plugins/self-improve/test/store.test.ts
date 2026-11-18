import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";

const databases: Database.Database[] = [];
function store() {
  const db = new Database(":memory:"); databases.push(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  return new Store(db);
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
describe("durable queue and ledger commits", () => {
  it("deduplicates a job and excludes a concurrent claim", () => {
    const s = store(); s.enqueue("miner", "window:1", {}, 100);
    s.enqueue("miner", "window:1", {}, 100);
    const job = s.claim("miner", "lease-a", 100)!;
    expect(s.claim("miner", "lease-b", 100)).toBeNull();
    expect(job.key).toBe("window:1");
    s.complete(job.id, "lease-a", { votes: 1 }, 110);
    expect(s.claim("miner", "lease-b", 111)).toBeNull();
  });
  it("reconciles a crashed lease and rejects its stale completion", () => {
    const s = store(); s.enqueue("inventor", "snapshot:1", {}, 100);
    const first = s.claim("inventor", "dead", 100)!;
    s.recover("new-boot", 200);
    const second = s.claim("inventor", "new-boot", 200)!;
    expect(second.id).toBe(first.id);
    expect(() => s.complete(first.id, "dead", {}, 210)).toThrow(/lease/);
    s.complete(second.id, "new-boot", {}, 210);
    expect(s.runs().map(r => r.status)).toEqual(["interrupted", "succeeded"]);
  });
  it("atomically saves records and cursor; rolls back an invalid mutation", () => {
    const s = store();
    expect(() => s.transaction(() => {
      s.put("votes", "v1", { id: "v1" }); s.put("cursors", "t1", 10); throw new Error("fault");
    })).toThrow("fault");
    expect(s.list("votes")).toEqual([]); expect(s.get("cursors", "t1")).toBeNull();
  });
  it("does not lose a failed run or retry before its delay", () => {
    const s = store(); s.enqueue("scout", "day1", {}, 100);
    const job = s.claim("scout", "boot", 100)!;
    s.fail(job.id, "boot", "upstream-unavailable", 120, 500);
    expect(s.claim("scout", "boot", 499)).toBeNull();
    expect(s.claim("scout", "boot", 500)?.attempts).toBe(2);
    expect(s.runs()[0].errors).toEqual(["upstream-unavailable"]);
  });
  it("protects edits from a stale dashboard or chat", () => {
    const s = store(); s.put("problems", "p", { title: "a" });
    const version = s.version("problems", "p");
    s.edit("problems", "p", version, { title: "b" }, { kind: "owner", id: "ui" }, "clarify");
    expect(() => s.edit("problems", "p", version, { title: "c" }, { kind: "chat", id: "t" }, "change")).toThrow(/changed/);
    expect(s.audit()).toHaveLength(1);
  });
});
