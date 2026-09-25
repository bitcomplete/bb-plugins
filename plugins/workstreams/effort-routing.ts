import type { EffortStore, EstablishedEffort } from "./effort-store.js";

type Parent = { id: string; title: string | null; status: string; canSpawnChild: boolean; archivedAt: number | null; deletedAt: number | null };
export async function effortParent(store: EffortStore, effort: EstablishedEffort, prUrl: string, get: (id: string) => Promise<Parent>): Promise<{ thread: Parent; role: "pr" | "followup" } | null> {
  const candidates = [...store.workers(effort.id, prUrl).filter((worker) => worker.role === "pr").map((worker) => ({ id: worker.threadId, role: "followup" as const })),
    ...(effort.coordinatorThreadId ? [{ id: effort.coordinatorThreadId, role: "pr" as const }] : [])];
  for (const candidate of candidates) {
    try {
      const thread = await get(candidate.id);
      if (thread.archivedAt === null && thread.deletedAt === null && thread.canSpawnChild && (candidate.role === "pr" || thread.status === "idle")) return { thread, role: candidate.role };
    } catch { /* A missing prior worker cannot be used as a parent. */ }
  }
  return null;
}

/** A parent-child relationship is not a filesystem lock. Refuse live writers even outside Workstreams. */
export async function activeCheckoutThread(path: string, hostId: string, list: (offset: number) => Promise<readonly { id: string; status: string; environmentPath: string | null; environmentHostId?: string | null }[]>): Promise<string | null> {
  const normalize = (value: string) => value.replace(/\/+$/u, "");
  for (let offset = 0; offset < 10_000; offset += 100) {
    const rows = await list(offset);
    const active = rows.find((thread) => (thread.environmentHostId == null || thread.environmentHostId === hostId) && thread.environmentPath !== null && normalize(thread.environmentPath) === normalize(path) && !["idle", "error"].includes(thread.status));
    if (active) return active.id;
    if (rows.length < 100) return null;
  }
  throw new Error("Too many threads to verify checkout ownership. Stop competing work and try again.");
}
