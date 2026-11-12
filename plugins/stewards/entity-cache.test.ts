// BB-312: the entity cache every stand-up read falls through. The cache is
// pure, so the three layers, the caps and the failure fall-back are exercised
// without a store, a server or a network.
import { describe, expect, it, vi } from "vitest";
import { EntityCache, type EntityRecord } from "./entity-cache.js";
import { issue, pull } from "./fixtures.js";

const record = (key: string, at: number, over: Partial<EntityRecord> = {}): EntityRecord => ({ entity: issue({ key, id: `uuid-${key}` }), pulls: [], at, ...over });

function cache(over: Partial<ConstructorParameters<typeof EntityCache>[0]> = {}) {
  const deps = {
    now: () => 1_000_000,
    ttlMs: 3_600_000,
    maxPerProject: 500,
    maxConcurrent: 4,
    stored: () => null,
    canonical: async () => null,
    ...over,
  };
  return { deps, cache: new EntityCache(deps) };
}

describe("EntityCache (BB-312)", () => {
  it("answers a fresh cache entry without touching the store or the source", async () => {
    const stored = vi.fn(() => null);
    const canonical = vi.fn(async () => record("ENG-1", 1_000_000));
    const { cache: c } = cache({ stored, canonical });
    // Prime the cache.
    await c.read("p1", "ENG-1");
    expect(canonical).toHaveBeenCalledTimes(1);
    stored.mockClear();
    canonical.mockClear();
    // A second read is a cache hit: neither the store nor the source is touched.
    const read = await c.read("p1", "ENG-1");
    expect(read?.layer).toBe("cache");
    expect(read?.record.entity.key).toBe("ENG-1");
    expect(stored).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
  });

  it("falls from a stale cache entry to a fresh binding snapshot", async () => {
    let firstRead = true;
    const stored = vi.fn(() => {
      // The first read has no stored snapshot; the second has a fresh one.
      if (firstRead) {
        firstRead = false;
        return null;
      }
      return record("ENG-1", 999_999);
    });
    const canonical = vi.fn(async () => record("ENG-1", 0));
    const { cache: c } = cache({ stored, canonical, ttlMs: 500_000 });
    // The first read stores a stale entry (at 0, now 1_000_000).
    await c.read("p1", "ENG-1");
    canonical.mockClear();
    stored.mockClear();
    const read = await c.read("p1", "ENG-1");
    expect(read?.layer).toBe("snapshot");
    expect(stored).toHaveBeenCalledTimes(1);
    expect(canonical).not.toHaveBeenCalled();
    // The hit filled the cache.
    expect(c.peek("p1", "ENG-1")?.at).toBe(999_999);
  });

  it("falls from a stale binding snapshot to the canonical source", async () => {
    const stored = vi.fn(() => record("ENG-1", 0));
    const canonical = vi.fn(async () => record("ENG-1", 1_000_000));
    const { cache: c } = cache({ stored, canonical, ttlMs: 500_000 });
    const read = await c.read("p1", "ENG-1");
    expect(read?.layer).toBe("source");
    expect(canonical).toHaveBeenCalledTimes(1);
    expect(c.peek("p1", "ENG-1")?.at).toBe(1_000_000);
  });

  it("reaches the source directly for a key with no binding", async () => {
    const stored = vi.fn(() => null);
    const canonical = vi.fn(async () => record("acme/web#7", 1_000_000));
    const { cache: c } = cache({ stored, canonical });
    const read = await c.read("p1", "acme/web#7");
    expect(read?.layer).toBe("source");
    expect(stored).toHaveBeenCalledWith("p1", "acme/web#7");
    expect(canonical).toHaveBeenCalledWith("p1", "acme/web#7");
  });

  it("falls back to the stored snapshot when the canonical read fails, and never throws", async () => {
    const stored = vi.fn(() => record("ENG-1", 0));
    const canonical = vi.fn(async () => {
      throw new Error("Linear rate limited the read");
    });
    const { cache: c } = cache({ stored, canonical });
    const read = await c.read("p1", "ENG-1");
    expect(read?.layer).toBe("snapshot");
    expect(read?.record.entity.key).toBe("ENG-1");
  });

  it("leaves the item out when the canonical read fails and nothing is stored", async () => {
    const canonical = vi.fn(async () => {
      throw new Error("rate limited");
    });
    const { cache: c } = cache({ canonical });
    expect(await c.read("p1", "ENG-1")).toBeNull();
  });

  it("falls back to a stored snapshot when the canonical read times out", async () => {
    const stored = vi.fn(() => record("ENG-1", 0));
    const canonical = vi.fn(() => new Promise<EntityRecord>(() => {})); // never resolves
    const { cache: c } = cache({ stored, canonical });
    const read = await c.read("p1", "ENG-1", { ttlMs: 0, timeoutMs: 5 });
    expect(read?.layer).toBe("snapshot");
  });

  it("drops an entry on a ring", async () => {
    const canonical = vi.fn(async () => record("ENG-1", 1_000_000));
    const { cache: c } = cache({ canonical });
    await c.read("p1", "ENG-1");
    expect(c.peek("p1", "ENG-1")).toBeDefined();
    c.invalidate("p1", "ENG-1");
    expect(c.peek("p1", "ENG-1")).toBeUndefined();
    await c.read("p1", "ENG-1");
    expect(canonical).toHaveBeenCalledTimes(2);
  });

  it("caps a project's entries and drops the oldest first", async () => {
    let clock = 1_000_000;
    const canonical = vi.fn(async (_project: string, key: string) => record(key, clock));
    const { cache: c } = cache({ now: () => clock, maxPerProject: 3, canonical });
    for (const key of ["a", "b", "c"]) {
      await c.read("p1", key);
      clock += 1_000;
    }
    expect(c.size("p1")).toBe(3);
    // A fourth entry drops the oldest (`a`).
    await c.read("p1", "d");
    expect(c.size("p1")).toBe(3);
    expect(c.peek("p1", "a")).toBeUndefined();
    expect(c.peek("p1", "b")).toBeDefined();
    expect(c.peek("p1", "d")).toBeDefined();
    // Projects are capped independently.
    await c.read("p2", "a");
    expect(c.size("p2")).toBe(1);
  });

  it("caps concurrent canonical reads at the configured limit", async () => {
    let active = 0;
    let peak = 0;
    const canonical = vi.fn(async (_project: string, key: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return record(key, 1_000_000);
    });
    const { cache: c } = cache({ canonical, maxConcurrent: 4 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => c.read("p1", `ENG-${i}`)));
    expect(canonical).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("joins one canonical read per key rather than starting two", async () => {
    const canonical = vi.fn(async (_project: string, key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return record(key, 1_000_000);
    });
    const { cache: c } = cache({ canonical });
    await Promise.all([c.read("p1", "ENG-1"), c.read("p1", "ENG-1"), c.read("p1", "ENG-1")]);
    expect(canonical).toHaveBeenCalledTimes(1);
  });

  it("keeps the pulls a canonical read returned", async () => {
    const linked = pull({ key: "acme/web#7", id: "acme/web#7" });
    const canonical = vi.fn(async () => ({ entity: issue(), pulls: [linked], at: 1_000_000 }));
    const { cache: c } = cache({ canonical });
    const read = await c.read("p1", "ENG-12");
    expect(read?.record.pulls.map((p) => p.key)).toEqual(["acme/web#7"]);
  });
});
