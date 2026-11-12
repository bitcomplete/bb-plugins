// BB-312: the one entity read path the stand-up brief and its read tools fall
// through. An entity record is the raw merged shape a read produces (the
// entity and, for a ticket, its linked pull requests) with the time it was
// read; it is not pre-formatted text, so every renderer starts from the same
// record.
//
// The read tries three layers in order: the project's cache entry while it is
// younger than the TTL, the binding's stored snapshot while it is younger than
// the TTL, and finally the canonical source read. A hit at any layer fills the
// cache, so the next read is instant whatever layer answered. A canonical read
// here never writes a binding: the stand-up path must not move `lastSnapshot`
// or the comment cursor the reconcile loop compares against.
//
// Pure and injectable: the store, the source and the clock are arguments, so
// the whole fall-through is unit-tested without a server, a network or a
// database.
import type { EntitySnapshot } from "./source-contract.js";

/** One entity record: the raw snapshot(s) and when they were read. */
export type EntityRecord = {
  entity: EntitySnapshot;
  /** The pull requests linked to the entity, read for a ticket; empty otherwise. */
  pulls: EntitySnapshot[];
  /** When the record was read (ms). */
  at: number;
};

/** Which layer answered a read. */
export type EntityLayer = "cache" | "snapshot" | "source";

export type EntityRead = {
  record: EntityRecord;
  layer: EntityLayer;
};

/** What the cache reads through. All four are injected, so the cache stays pure. */
export type EntityCacheDeps = {
  now: () => number;
  /** How long an entry is fresh (ms). */
  ttlMs: number;
  /** The most entries one project may hold before the oldest is dropped. */
  maxPerProject: number;
  /** The most canonical reads in flight at once. */
  maxConcurrent: number;
  /** The binding's stored snapshot for the key, with its read time, or null. */
  stored: (projectId: string, key: string) => EntityRecord | null;
  /** The canonical read. It may throw on a rate limit or a failure. */
  canonical: (projectId: string, key: string) => Promise<EntityRecord | null>;
};

export type EntityReadOptions = {
  /** Override the TTL for one read (0 forces a fresh canonical read). */
  ttlMs?: number;
  /** Give up on the canonical read after this long and fall back. */
  timeoutMs?: number;
};

/** A promise that rejects with a timeout error when `ms` passes first. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`entity read timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The server-level entity cache. One instance per server; entries are keyed by
 * project and entity key, and each project holds at most `maxPerProject`
 * entries (the oldest dropped first). `read` is the only entry point and never
 * throws: a rate-limited or failed canonical read falls back to the stored
 * snapshot or the last cached one, or leaves the item out.
 */
export class EntityCache {
  private readonly entries = new Map<string, Map<string, EntityRecord>>();
  private readonly inFlight = new Map<string, Promise<EntityRead | null>>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly deps: EntityCacheDeps) {}

  /** The cached record for a key, or undefined. Exposed for tests and diagnostics. */
  peek(projectId: string, key: string): EntityRecord | undefined {
    return this.entries.get(projectId)?.get(key);
  }

  /** How many entries a project holds. */
  size(projectId: string): number {
    return this.entries.get(projectId)?.size ?? 0;
  }

  /** Drop one key's cache entry (a `stewardsRing` doorbell for the entity). */
  invalidate(projectId: string, key: string): void {
    this.entries.get(projectId)?.delete(key);
  }

  /** Drop one key's entry in every project, when a ring names an entity id with no project. */
  invalidateKey(key: string): void {
    for (const project of this.entries.values()) project.delete(key);
  }

  /** Drop every entry, for a project or the whole server. */
  clear(projectId?: string): void {
    if (projectId === undefined) this.entries.clear();
    else this.entries.delete(projectId);
  }

  /**
   * Read an entity through the cache path. Returns null when no layer has a
   * record. Never throws: a failure is caught and the fall-through continues.
   */
  async read(projectId: string, key: string, options: EntityReadOptions = {}): Promise<EntityRead | null> {
    const ttl = options.ttlMs ?? this.deps.ttlMs;
    const now = this.deps.now();
    const cached = this.peek(projectId, key);
    if (cached !== undefined && now - cached.at < ttl) return { record: cached, layer: "cache" };
    // One canonical read per key at a time: a second caller joins it rather
    // than starting another.
    const flightKey = `${projectId}\u0000${key}`;
    const existing = this.inFlight.get(flightKey);
    if (existing !== undefined) return existing;
    const flight = this.resolve(projectId, key, ttl, cached, options);
    this.inFlight.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  private async resolve(projectId: string, key: string, ttl: number, cached: EntityRecord | undefined, options: EntityReadOptions): Promise<EntityRead | null> {
    const stored = this.deps.stored(projectId, key);
    // A stored snapshot younger than the TTL answers without a source read.
    if (stored !== null && this.deps.now() - stored.at < ttl) {
      this.put(projectId, key, stored);
      return { record: stored, layer: "snapshot" };
    }
    try {
      const canonical = this.limited(() => this.deps.canonical(projectId, key));
      const fresh = options.timeoutMs === undefined ? await canonical : await withTimeout(canonical, options.timeoutMs);
      if (fresh !== null) {
        this.put(projectId, key, fresh);
        return { record: fresh, layer: "source" };
      }
    } catch {
      // A rate limit, a timeout or any other failure: fall back, never throw.
    }
    // The canonical read could not answer: a stored snapshot (even stale), then
    // the last cached record, then nothing.
    if (stored !== null) {
      this.put(projectId, key, stored);
      return { record: stored, layer: "snapshot" };
    }
    if (cached !== undefined) return { record: cached, layer: "cache" };
    return null;
  }

  /** Insert a record, dropping the oldest entry of the project when at the cap. */
  private put(projectId: string, key: string, record: EntityRecord): void {
    let project = this.entries.get(projectId);
    if (project === undefined) {
      project = new Map();
      this.entries.set(projectId, project);
    }
    if (!project.has(key) && project.size >= this.deps.maxPerProject) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidate, entry] of project) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = candidate;
        }
      }
      if (oldestKey !== null) project.delete(oldestKey);
    }
    project.set(key, record);
  }

  /** Run `fn` under the concurrency cap; the slot is handed to the next waiter. */
  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.deps.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next !== undefined) next();
      else this.active--;
    }
  }
}
