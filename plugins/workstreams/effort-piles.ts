// Effort piles: every effort is active, held, or done. A pile lives in its own
// table, keyed by effort id, so it never touches the effort's record: a
// coordinator save that spreads a stale effort can't undo a move, and a move
// never changes members, threads, or the archive and merge fields. An effort
// with no row is active, and has been since it was created.
import { z } from "zod";
import type { RunDb } from "./runstore.js";

export const EFFORT_PILES = ["active", "held", "done"] as const;
export type EffortPile = (typeof EFFORT_PILES)[number];
/** Append-only: server.ts adds this after PR read closures (id 58). */
export const EFFORT_PILE_MIGRATION =
  `CREATE TABLE IF NOT EXISTS effort_piles (effort_id TEXT PRIMARY KEY, pile TEXT NOT NULL CHECK (pile IN ('active','held','done')), reason TEXT NOT NULL, since INTEGER NOT NULL)`;

/** `since` is when the effort joined its pile: a resumed or reopened effort joins the end of the active pile. */
export const effortPileSchema = z.object({ effortId: z.string(), pile: z.enum(EFFORT_PILES), reason: z.string(), since: z.number() }).strict();
export type EffortPileState = z.infer<typeof effortPileSchema>;

const MOVES = {
  hold: { from: ["active"], to: "held" },
  complete: { from: ["active", "held"], to: "done" },
  resume: { from: ["held"], to: "active" },
  reopen: { from: ["done"], to: "active" },
} as const satisfies Record<string, { from: readonly EffortPile[]; to: EffortPile }>;
export type PileMove = keyof typeof MOVES;
const PILE_WORDS: Record<EffortPile, string> = { active: "active", held: "on hold", done: "done" };

const failure = z.object({ ok: z.literal(false), error: z.string() });
const pileResult = z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true), pile: effortPileSchema })]);
const effortKey = z.string().min(1).max(500);
export const effortPilesContract = {
  /** Every unarchived effort's pile. */
  effort_piles_get: { input: z.null(), output: z.array(effortPileSchema) },
  effort_hold: { input: z.object({ effortKey, reason: z.string().max(500).optional() }).strict(), output: pileResult },
  /** Completing keeps every member and thread; the result names what is still open. */
  effort_complete: { input: z.object({ effortKey }).strict(), output: z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true), pile: effortPileSchema,
    open: z.object({ prs: z.array(z.object({ prUrl: z.string(), repo: z.string(), number: z.number(), title: z.string() }).strict()),
      threads: z.array(z.object({ id: z.string(), title: z.string() }).strict()) }).strict() })]) },
  effort_resume: { input: z.object({ effortKey }).strict(), output: pileResult },
  effort_reopen: { input: z.object({ effortKey }).strict(), output: pileResult },
};

export function createEffortPileStore(db: RunDb, now = Date.now) {
  function get(effort: { id: string; createdAt: number }): EffortPileState {
    const row = db.prepare(`SELECT pile, reason, since FROM effort_piles WHERE effort_id = ?`).get(effort.id);
    return row ? effortPileSchema.parse({ effortId: effort.id, ...row as object }) : { effortId: effort.id, pile: "active", reason: "", since: effort.createdAt };
  }
  return {
    get,
    /** Only a hold keeps a reason. */
    move(effort: { id: string; createdAt: number }, move: PileMove, reason = ""): EffortPileState {
      const current = get(effort);
      if (!(MOVES[move].from as readonly EffortPile[]).includes(current.pile)) throw new Error(current.pile === MOVES[move].to
        ? `This effort is already ${PILE_WORDS[current.pile]}.` : `This effort is ${PILE_WORDS[current.pile]}. Refresh the deck.`);
      const next: EffortPileState = { effortId: effort.id, pile: MOVES[move].to, reason: MOVES[move].to === "held" ? reason.trim() : "", since: now() };
      db.prepare(`INSERT INTO effort_piles (effort_id, pile, reason, since) VALUES (?, ?, ?, ?)
        ON CONFLICT(effort_id) DO UPDATE SET pile = excluded.pile, reason = excluded.reason, since = excluded.since`).run(next.effortId, next.pile, next.reason, next.since);
      return next;
    },
  };
}
export type EffortPileStore = ReturnType<typeof createEffortPileStore>;
