import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, resultSchema, rpcContract, snapshotResultSchema, type Result, type SnapshotResult } from "./contract.js";
import { mondayEt, weekBounds } from "./activity.js";

const CURRENT_TTL_MS = 24 * 60 * 60_000;
const COMPLETED_TTL_MS = 30 * CURRENT_TTL_MS;
const TIMEOUT_MS = 150_000;

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE IF NOT EXISTS activity_cache_v1 (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, result TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS in_progress_cache_v1 (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, result TEXT NOT NULL)",
  ]);
  const readCache = db.prepare("SELECT expires_at, result FROM activity_cache_v1 WHERE key = ?");
  const writeCache = db.prepare("INSERT INTO activity_cache_v1 (key, expires_at, result) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at, result = excluded.result");
  const readSnapshot = db.prepare("SELECT expires_at, result FROM in_progress_cache_v1 WHERE key = ?");
  const writeSnapshot = db.prepare("INSERT INTO in_progress_cache_v1 (key, expires_at, result) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at, result = excluded.result");
  const pending = new Map<string, Promise<Result>>();
  const pendingSnapshots = new Map<string, Promise<SnapshotResult>>();
  const readCachedSnapshot = (org: string, week: string): SnapshotResult | null => {
    const key = `${org}:${week}`;
    for (const [read, schema] of [[readSnapshot, snapshotResultSchema], [readCache, resultSchema]] as const) {
      const hit = read.get(key) as { expires_at: number; result: string } | undefined;
      if (!hit || Date.now() >= hit.expires_at) continue;
      try {
        const parsed = schema.safeParse(JSON.parse(hit.result));
        if (parsed.success && parsed.data.ok && parsed.data.org === org && parsed.data.week === week) {
          const { fetchedAt, inProgress } = parsed.data;
          return { ok: true, org, week, fetchedAt, inProgress };
        }
      } catch { /* A malformed cache entry is a miss. */ }
    }
    return null;
  };

  bb.rpc.register(rpcContract, {
    activity_cached: ({ org, week }) => {
      try { weekBounds(week); } catch { return null; }
      const hit = readCache.get(`${org}:${week}`) as { expires_at: number; result: string } | undefined;
      if (!hit || Date.now() >= hit.expires_at) return null;
      try {
        const parsed = resultSchema.safeParse(JSON.parse(hit.result));
        return parsed.success && parsed.data.ok && parsed.data.org === org && parsed.data.week === week
          ? parsed.data : null;
      } catch { return null; }
    },
    activity_get: async ({ org, week, refresh }) => {
      try { weekBounds(week); } catch (error) { return { ok: false as const, error: String(error).slice(0, 800) }; }
      const key = `${org}:${week}`;
      if (!refresh) {
        const hit = readCache.get(key) as { expires_at: number; result: string } | undefined;
        if (hit && Date.now() < hit.expires_at) {
          try {
            const parsed = resultSchema.safeParse(JSON.parse(hit.result));
            if (parsed.success && parsed.data.ok && parsed.data.org === org && parsed.data.week === week) return parsed.data;
          } catch { /* A malformed cache entry is a miss. */ }
        }
      }
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      const work = (async (): Promise<Result> => {
        try {
          const hostId = (await bb.sdk.system.config()).primaryHostId;
          if (hostId === null) return { ok: false, error: "No primary BB host is available to run gh." };
          const result = await host.call("activity", { org, week, refresh }, { hostId, timeoutMs: TIMEOUT_MS });
          if (result.ok) {
            const now = Date.now();
            const expiresAt = week === mondayEt(new Date(now))
              ? Math.min(now + CURRENT_TTL_MS, Date.parse(weekBounds(week).end))
              : now + COMPLETED_TTL_MS;
            writeCache.run(key, expiresAt, JSON.stringify(result));
          }
          return result;
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message.slice(0, 800) : "Could not read GitHub activity." };
        } finally { pending.delete(key); }
      })();
      pending.set(key, work);
      return work;
    },
    in_progress_cached: ({ org, week }) => {
      try {
        weekBounds(week);
        if (week > mondayEt(new Date())) return null;
      } catch { return null; }
      return readCachedSnapshot(org, week);
    },
    in_progress_get: async ({ org, week, refresh }) => {
      try {
        weekBounds(week);
        if (week > mondayEt(new Date())) throw new Error("Choose the current week or an earlier Monday in Eastern Time.");
      } catch (error) { return { ok: false as const, error: String(error).slice(0, 800) }; }
      const key = `${org}:${week}`;
      if (!refresh) {
        const cached = readCachedSnapshot(org, week);
        if (cached) return cached;
      }
      const pendingKey = `${key}:${refresh}`;
      const inFlight = pendingSnapshots.get(pendingKey);
      if (inFlight) return inFlight;
      const work = (async (): Promise<SnapshotResult> => {
        try {
          const hostId = (await bb.sdk.system.config()).primaryHostId;
          if (hostId === null) return { ok: false, error: "No primary BB host is available to run gh." };
          const result = await host.call("in_progress", { org, week, refresh }, { hostId, timeoutMs: TIMEOUT_MS });
          if (result.ok) {
            const now = Date.now();
            const expiresAt = week === mondayEt(new Date(now))
              ? Math.min(now + CURRENT_TTL_MS, Date.parse(weekBounds(week).end))
              : now + COMPLETED_TTL_MS;
            writeSnapshot.run(key, expiresAt, JSON.stringify(result));
          }
          return result;
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message.slice(0, 800) : "Could not read in-progress PRs." };
        } finally { pendingSnapshots.delete(pendingKey); }
      })();
      pendingSnapshots.set(pendingKey, work);
      return work;
    },
  });
}
export { rpcContract };
