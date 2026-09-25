import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RunDb } from "./runstore.js";

export const effortMembersSchema = z.object({ tickets: z.array(z.string().min(1).max(300)).max(1000), prUrls: z.array(z.string().url().max(500)).max(1000) }).strict();
export const establishedEffortSchema = z.object({
  id: z.string(), key: z.string(), name: z.string(), goal: z.string(), projectId: z.string(),
  coordinatorThreadId: z.string().nullable(), coordinatorState: z.enum(["creating", "ready", "unavailable"]),
  members: effortMembersSchema, createdAt: z.number(), updatedAt: z.number(),
});
export type EffortMembers = z.infer<typeof effortMembersSchema>;
export type EstablishedEffort = z.infer<typeof establishedEffortSchema>;
export const EFFORT_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS established_efforts (id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS effort_members (kind TEXT NOT NULL, ref TEXT NOT NULL, effort_id TEXT NOT NULL, PRIMARY KEY(kind, ref))`,
  `CREATE TABLE IF NOT EXISTS effort_workers (thread_id TEXT PRIMARY KEY, effort_id TEXT NOT NULL, pr_url TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL)`,
];
type EffortDb = RunDb & { transaction<T>(fn: () => T): () => T };
export function normalizeMembers(members: EffortMembers): EffortMembers {
  return { tickets: [...new Set(members.tickets)].sort(), prUrls: [...new Set(members.prUrls.map((url) => url.toLowerCase()))].sort() };
}
export function sameMembers(a: EffortMembers, b: EffortMembers): boolean {
  return JSON.stringify(normalizeMembers(a)) === JSON.stringify(normalizeMembers(b));
}
export function createEffortStore(db: EffortDb, now = Date.now) {
  function read(row: unknown): EstablishedEffort | null {
    if (!row) return null;
    return establishedEffortSchema.parse(JSON.parse((row as { value: string }).value));
  }
  const get = (id: string) => read(db.prepare(`SELECT value FROM established_efforts WHERE id = ?`).get(id.replace(/^effort:/u, "")));
  function save(effort: EstablishedEffort): EstablishedEffort {
    const updated = { ...effort, members: normalizeMembers(effort.members), updatedAt: now() };
    db.prepare(`UPDATE established_efforts SET value = ? WHERE id = ?`).run(JSON.stringify(updated), updated.id);
    return updated;
  }
  return {
    get,
    list: () => (db.prepare(`SELECT value FROM established_efforts ORDER BY id`).all()).map((row) => read(row)!),
    source: (sourceKey: string) => get(sourceKey) ?? read(db.prepare(`SELECT value FROM established_efforts WHERE source_key = ?`).get(sourceKey)),
    owner(kind: "ticket" | "prUrl", ref: string): EstablishedEffort | null {
      const row = db.prepare(`SELECT effort_id FROM effort_members WHERE kind = ? AND ref = ?`).get(kind, kind === "prUrl" ? ref.toLowerCase() : ref) as { effort_id: string } | undefined;
      return row ? get(row.effort_id) : null;
    },
    establish(input: { sourceKey: string; name: string; goal: string; projectId: string; members: EffortMembers }): EstablishedEffort {
      return db.transaction(() => {
        const existing = get(input.sourceKey) ?? read(db.prepare(`SELECT value FROM established_efforts WHERE source_key = ?`).get(input.sourceKey));
        if (existing) return existing;
        const members = normalizeMembers(input.members);
        for (const [kind, refs] of [["ticket", members.tickets], ["prUrl", members.prUrls]] as const) {
          for (const ref of refs) if (db.prepare(`SELECT effort_id FROM effort_members WHERE kind = ? AND ref = ?`).get(kind, ref)) {
            throw new Error("Some work already belongs to an established effort. Refresh before coordinating.");
          }
        }
        const id = randomUUID();
        const effort: EstablishedEffort = { id, key: `effort:${id}`, name: input.name, goal: input.goal, projectId: input.projectId,
          members, coordinatorThreadId: null, coordinatorState: "creating", createdAt: now(), updatedAt: now() };
        db.prepare(`INSERT INTO established_efforts (id, source_key, value) VALUES (?, ?, ?)`).run(id, input.sourceKey, JSON.stringify(effort));
        for (const [kind, refs] of [["ticket", members.tickets], ["prUrl", members.prUrls]] as const) {
          for (const ref of refs) db.prepare(`INSERT INTO effort_members (kind, ref, effort_id) VALUES (?, ?, ?)`).run(kind, ref, id);
        }
        return effort;
      })();
    },
    save,
    recordWorker(effortId: string, threadId: string, prUrl: string, role: "pr" | "followup"): void {
      db.prepare(`INSERT OR REPLACE INTO effort_workers (thread_id, effort_id, pr_url, role, created_at) VALUES (?, ?, ?, ?, ?)`).run(threadId, effortId, prUrl.toLowerCase(), role, now());
    },
    workers(effortId: string, prUrl: string): { threadId: string; role: "pr" | "followup" }[] {
      return db.prepare(`SELECT thread_id AS threadId, role FROM effort_workers WHERE effort_id = ? AND pr_url = ? ORDER BY created_at DESC`).all(effortId, prUrl.toLowerCase()) as { threadId: string; role: "pr" | "followup" }[];
    },
  };
}
export type EffortStore = ReturnType<typeof createEffortStore>;
