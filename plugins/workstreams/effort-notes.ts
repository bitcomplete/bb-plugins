// An effort's notes (plan amendment A17.8): one Markdown body per effort for
// flags, experiments, and anything else its card doesn't track yet. It lives
// in its own table, keyed by effort id, so a coordinator save that spreads a
// stale effort never touches it. Each save names the revision it edited, and
// one made since refuses it, so two views never overwrite each other unseen.
import { z } from "zod";
import type { RunDb } from "./runstore.js";

/** Append-only: server.ts adds this after where a moved PR came from (id 67). */
export const EFFORT_NOTES_MIGRATION =
  `CREATE TABLE IF NOT EXISTS effort_notes (effort_id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)`;
export const NOTES_MAX = 20_000;

/** An effort with no notes yet is at revision 0, with an empty body. */
export const effortNotesSchema = z.object({ body: z.string(), revision: z.number().int(), updatedAt: z.number().nullable() }).strict();
export type EffortNotes = z.infer<typeof effortNotesSchema>;
export const NO_NOTES: EffortNotes = { body: "", revision: 0, updatedAt: null };

const failure = z.object({ ok: z.literal(false), error: z.string() }).strict();
export const effortNotesContract = {
  /** Save an effort's notes over the revision you edited; an empty body clears them. */
  effort_notes_save: { input: z.object({ effortKey: z.string().min(1).max(500), body: z.string().max(NOTES_MAX), revision: z.number().int().min(0) }).strict(),
    output: z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true), notes: effortNotesSchema }).strict()]) },
};

export function createEffortNotesStore(db: RunDb, now = Date.now) {
  const get = (effortId: string): EffortNotes => {
    const row = db.prepare(`SELECT body, revision, updated_at AS updatedAt FROM effort_notes WHERE effort_id = ?`).get(effortId);
    return row ? effortNotesSchema.parse(row) : NO_NOTES;
  };
  return {
    get,
    /** The next revision, or a refusal when another save landed since `revision`. Trailing blank space is dropped. */
    save(effortId: string, body: string, revision: number): EffortNotes {
      const next: EffortNotes = { body: body.trimEnd(), revision: revision + 1, updatedAt: now() };
      const result = revision === 0
        ? db.prepare(`INSERT INTO effort_notes (effort_id, body, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(effort_id) DO NOTHING`).run(effortId, next.body, next.updatedAt)
        : db.prepare(`UPDATE effort_notes SET body = ?, revision = ?, updated_at = ? WHERE effort_id = ? AND revision = ?`)
          .run(next.body, next.revision, next.updatedAt, effortId, revision);
      if ((result as { changes?: number }).changes !== 1) throw new Error("These notes changed since you opened them. Copy your text, then open them again.");
      return next;
    },
  };
}
export type EffortNotesStore = ReturnType<typeof createEffortNotesStore>;

/** The line a collapsed Notes tile shows: the first with any text, without its heading, list, or quote marker. */
export function firstLine(body: string): string {
  const line = body.split("\n").find((item) => item.trim()) ?? "";
  return line.trim().replace(/^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|>\s*|\d+[.)]\s+)/u, "");
}
