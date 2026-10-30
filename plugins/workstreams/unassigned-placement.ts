import { z } from "zod";
import type { RunDb } from "./runstore.js";
import { rejectedScratchPlacement } from "./scratch-placement.js";
import { waitForChildParent } from "./thread-readiness.js";

export const UNASSIGNED_PLACEMENT_MIGRATION =
  "CREATE TABLE IF NOT EXISTS unassigned_thread_placements (key TEXT PRIMARY KEY, body TEXT NOT NULL)";

const recordSchema = z.object({ key: z.string(), projectId: z.string(), hostId: z.string().nullable(),
  parentThreadId: z.string().nullable(), threadId: z.string().nullable(), state: z.enum(["creating", "ready"]) });
type Record = z.infer<typeof recordSchema>;
type Db = RunDb & { transaction<T>(fn: () => T): () => T };
type Thread = { id: string; projectId: string; parentThreadId: string | null; archivedAt: number | null;
  deletedAt: number | null; canSpawnChild: boolean; environmentHostId: string | null };
export type UnassignedPlacementSdk = {
  get(id: string): Promise<Thread>;
  recover(key: string, projectId: string): Promise<string[]>;
  spawn(record: Record, title: string, role: "unassigned-root" | "unassigned-repo", repo: string | null): Promise<{ id: string }>;
};

/** The placeholder organizes threads; it never assigns a PR to an effort. */
export function createUnassignedPlacementService(db: Db, sdk: UnassignedPlacementSdk) {
  const pending = new Map<string, Promise<string>>();
  const read = (key: string): Record | null => {
    const row = db.prepare("SELECT body FROM unassigned_thread_placements WHERE key = ?").get(key) as { body: string } | undefined;
    return row ? recordSchema.parse(JSON.parse(row.body)) : null;
  };
  const save = (record: Record) => db.prepare("UPDATE unassigned_thread_placements SET body = ? WHERE key = ?")
    .run(JSON.stringify(record), record.key);
  async function checked(record: Record): Promise<string> {
    if (!record.threadId) throw new Error("Unassigned parent launch is uncertain. Inspect its thread before retrying.");
    const threadId = record.threadId;
    const failure = "Unassigned parent no longer matches its recorded project, host, or hierarchy. Inspect its thread before retrying.";
    const thread = await waitForChildParent(() => sdk.get(threadId), (current) => {
      if (current.deletedAt !== null || current.archivedAt !== null || current.projectId !== record.projectId ||
        current.parentThreadId !== record.parentThreadId) throw new Error(failure);
    }, record.hostId, failure);
    return thread.id;
  }
  async function ensure(key: string, projectId: string, hostId: string | null, parentThreadId: string | null,
    title: string, role: "unassigned-root" | "unassigned-repo", repo: string | null): Promise<string> {
    const current = pending.get(key);
    if (current) return current;
    const task = (async () => {
      const claimed = db.transaction(() => {
        const existing = read(key);
        if (existing) return { record: existing, created: false };
        const record: Record = { key, projectId, hostId, parentThreadId, threadId: null, state: "creating" };
        db.prepare("INSERT INTO unassigned_thread_placements (key, body) VALUES (?, ?)").run(key, JSON.stringify(record));
        return { record, created: true };
      })();
      const { record, created } = claimed;
      // Repository anchors are organizational. Later callers may run in another project or host.
      if (record.threadId) return checked(record);
      if (!created) {
        const matches = await sdk.recover(key, record.projectId);
        if (matches.length !== 1) throw new Error("Unassigned parent launch is uncertain. Inspect matching threads before retrying.");
        const recovered = { ...record, threadId: matches[0]!, state: "ready" as const };
        const id = await checked(recovered);
        save(recovered);
        return id;
      }
      let spawned: { id: string };
      try { spawned = await sdk.spawn(record, title, role, repo); }
      catch (error) {
        if (rejectedScratchPlacement(error)) db.prepare("DELETE FROM unassigned_thread_placements WHERE key = ? AND body = ?")
          .run(key, JSON.stringify(record));
        throw error;
      }
      const saved = { ...record, threadId: spawned.id, state: "ready" as const };
      save(saved);
      return checked(saved);
    })().finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }
  return {
    root: () => read("root"),
    repo: (repo: string) => read(`repo:${repo.toLowerCase()}`),
    ensureRoot: (projectId: string, hostId: string | null) =>
      ensure("root", projectId, hostId, null, "Unassigned work", "unassigned-root", null),
    async ensureRepo(repo: string, projectId: string, hostId: string | null): Promise<string> {
      const root = await this.ensureRoot(projectId, hostId);
      return ensure(`repo:${repo.toLowerCase()}`, projectId, hostId, root, repo.toLowerCase(), "unassigned-repo", repo.toLowerCase());
    },
  };
}
