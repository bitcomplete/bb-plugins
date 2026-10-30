// Classification changes membership only on your click, or through a standing
// rule you added. Each change is one action: a row per PR or ticket it gave an
// effort, which is both the audit trail and what Undo reverses. Undo releases
// exactly what the action added, and only while that effort still owns all of it.
// A move out of another effort (into One-offs) names that effort on its row, so
// Undo puts the PR back there.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RULE_KINDS, ruleSchema, suggestionGroupSchema, type Rule } from "./effort-classify.js";
import type { EffortStore, EstablishedEffort } from "./effort-store.js";
import type { RunDb } from "./runstore.js";

/** The source key of the one effort for standalone PRs, created the first time you mark a PR one-off. */
export const ONE_OFFS_SOURCE = "one-offs";
export const ONE_OFFS = { name: "One-offs", goal: "Standalone PRs that belong to no larger outcome." };
/** Append-only: server.ts adds these after effort piles (ids 59-60). */
export const EFFORT_ASSIGNMENT_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_assignments (seq INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL, at INTEGER NOT NULL, source TEXT NOT NULL, effort_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, rule_id TEXT, undone_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS effort_assignments_action ON effort_assignments (action_id)`,
];
/** Append-only: server.ts adds this after the classification audit (id 61). */
export const EFFORT_RULE_MIGRATION = `CREATE TABLE IF NOT EXISTS effort_rules (id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, effort_id TEXT, created_at INTEGER NOT NULL)`;
/**
 * Append-only: server.ts adds this after the confirmation audit (id 66). The effort a moved PR was an exact member of, which Undo puts it
 * back in; null when the PR had no effort, or was in one only through a ticket, which it rejoins once Undo releases it.
 */
export const EFFORT_ASSIGNMENT_FROM_MIGRATION = `ALTER TABLE effort_assignments ADD COLUMN from_effort_id TEXT`;
export type AssignmentSource = "assign" | "new-effort" | "one-off" | "rule" | "seed";

const failure = z.object({ ok: z.literal(false), error: z.string() });
const ruleInput = z.object({ kind: z.enum(RULE_KINDS), value: z.string().max(200), effortKey: z.string().min(1).max(500).nullable() }).strict();
const prUrls = z.array(z.string().max(500)).min(1).max(100);
/** Only tickets the chosen PRs' titles or branches carry, with every open PR of yours on them chosen too, and none another effort's PRs carry. */
const tickets = z.array(z.string().min(1).max(300)).max(50).optional();
export const classifyActionResultSchema = z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true), actionId: z.string(),
  effort: z.object({ id: z.string(), key: z.string(), name: z.string() }).strict(),
  /** PRs the action put in the effort; tickets it added don't count. */
  added: z.number() }).strict()]);
export const classifyContract = {
  /** Read-only: a suggestion for each open PR of yours that no effort owns, grouped for accepting together. */
  classify_get: { input: z.null(), output: z.object({ groups: z.array(suggestionGroupSchema), oneOffsId: z.string().nullable(),
    /** Your standing rules, with how many PRs each placed in the last 7 days. */
    rules: z.array(ruleSchema.extend({ effortName: z.string().nullable(), hits: z.number() }).strict()),
    /** The efforts on the active pile, One-offs aside, that All PRs' Move to effort… lists. */
    efforts: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
    /** Suggestions you dismissed in All PRs: by PR, the effort each named, so a later suggestion of another effort still shows. */
    dismissed: z.record(z.string(), z.string()) }).strict() },
  /**
   * Add a standing rule. After each read it places open PRs of yours that no effort owns and that were opened after the rule; `now` also places
   * every PR it matches today, as one undoable action per effort. A stack rule names no effort or value.
   */
  classify_rule_add: { input: ruleInput.extend({ now: z.boolean() }).strict(),
    output: z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true), rule: ruleSchema,
      actions: z.array(classifyActionResultSchema.options[1]) }).strict()]) },
  /** Read-only: the open PRs this rule would place if you added it with `now`, to show before you add it. A PR stacked on one of them may follow. */
  classify_rule_preview: { input: ruleInput, output: z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true), prUrls: z.array(z.string()) }).strict()]) },
  /** Remove a rule. PRs it placed stay where they are. */
  classify_rule_remove: { input: z.object({ ruleId: z.string().uuid() }).strict(), output: z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true) }).strict()]) },
  /** Put open PRs of yours that no effort owns into an effort, with any of their tickets you choose, so later PRs on those tickets join it too. */
  classify_assign: { input: z.object({ effortKey: z.string().min(1).max(500), prUrls, tickets }).strict(), output: classifyActionResultSchema },
  /** Start an effort from open PRs of yours that no effort owns. Undoing it removes the effort again. */
  classify_new_effort: { input: z.object({ name: z.string().max(500), goal: z.string().max(4_000), prUrls, tickets, requestId: z.string().uuid() }).strict(),
    output: classifyActionResultSchema },
  /**
   * Put open PRs of yours into One-offs, which the first use creates: PRs no effort owns, or with `from`, PRs that effort owns now, moved
   * out of it. Undo puts each back where it was.
   */
  classify_one_off: { input: z.object({ prUrls, from: z.string().min(1).max(500).optional() }).strict(), output: classifyActionResultSchema },
  /**
   * Move PRs All PRs lists into an effort, One-offs, which the first use creates, or a new effort by name, out of whichever effort has
   * each now, or none, as one action. Undo puts each back where it was, and removes a new effort again.
   */
  classify_move: { input: z.object({ prUrls, to: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("effort"), effortKey: z.string().min(1).max(500) }).strict(),
    z.object({ kind: z.literal("one-off") }).strict(),
    z.object({ kind: z.literal("new"), name: z.string().max(500), requestId: z.string().uuid() }).strict()]) }).strict(), output: classifyActionResultSchema },
  /** Hide the suggestion of an effort for one PR in All PRs, or with null show it again. A suggestion of another effort still shows. */
  classify_dismiss: { input: z.object({ prUrl: z.string().min(1).max(500), effortId: z.string().min(1).max(500).nullable() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict() },
  /** Reverse one classification action while its effort still owns everything the action added. */
  classify_undo: { input: z.object({ actionId: z.string().uuid() }).strict(), output: z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true) }).strict()]) },
};

type Db = RunDb & { transaction<T>(fn: () => T): () => T };
type Row = { effortId: string; source: AssignmentSource; kind: "prUrl" | "ticket"; ref: string; from: string | null };

export function createAssignmentStore(db: Db, efforts: EffortStore, now = Date.now) {
  return {
    /** Claim unowned PRs and tickets for one effort as one action, or nothing when another effort owns any of them. */
    assign(input: { effortId: string; source: AssignmentSource; prUrls: readonly string[]; tickets?: readonly string[]; ruleId?: string }):
      { actionId: string; effort: EstablishedEffort; added: number } {
      return db.transaction(() => {
        const result = efforts.claimUnowned(input.effortId, { tickets: [...input.tickets ?? []], prUrls: [...input.prUrls] });
        if (result.conflict) throw new Error("Another effort owns some of this work now. Refresh and try again.");
        const actionId = randomUUID();
        const insert = db.prepare(`INSERT INTO effort_assignments (action_id, at, source, effort_id, kind, ref, rule_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const [kind, refs] of [["prUrl", result.claimed.prUrls], ["ticket", result.claimed.tickets]] as const)
          for (const ref of refs) insert.run(actionId, now(), input.source, result.effort.id, kind, ref, input.ruleId ?? null);
        return { actionId, effort: result.effort, added: result.claimed.prUrls.length };
      })();
    },
    /**
     * Move PRs into one effort as one action, out of whichever effort has them now; the caller checked they may move. Each row names the
     * effort the PR was an exact member of, for Undo.
     */
    move(input: { effortId: string; source: AssignmentSource; prUrls: readonly string[] }): { actionId: string; effort: EstablishedEffort; added: number } {
      return db.transaction(() => {
        const destination = efforts.get(input.effortId);
        if (!destination || destination.archivedAt) throw new Error("The destination effort changed. Refresh before moving work.");
        const moving = [...new Set(input.prUrls)].map((ref) => ({ ref, from: efforts.owner("prUrl", ref)?.id ?? null })).filter((item) => item.from !== destination.id);
        if (!moving.length) throw new Error(`These are in ${destination.name} already.`);
        const effort = efforts.transfer(destination.id, { tickets: [], prUrls: moving.map((item) => item.ref) });
        const actionId = randomUUID();
        const insert = db.prepare(`INSERT INTO effort_assignments (action_id, at, source, effort_id, kind, ref, from_effort_id) VALUES (?, ?, ?, ?, 'prUrl', ?, ?)`);
        for (const item of moving) insert.run(actionId, now(), input.source, effort.id, item.ref, item.from);
        return { actionId, effort, added: moving.length };
      })();
    },
    rules: (): Rule[] => (db.prepare(`SELECT id, kind, value, effort_id AS effortId, created_at AS createdAt FROM effort_rules ORDER BY created_at, id`).all())
      .map((row) => ruleSchema.parse(row)),
    addRule(input: Pick<Rule, "kind" | "value" | "effortId">): Rule {
      const rule: Rule = { id: randomUUID(), ...input, createdAt: now() };
      db.prepare(`INSERT INTO effort_rules (id, kind, value, effort_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(rule.id, rule.kind, rule.value, rule.effortId, rule.createdAt);
      return rule;
    },
    removeRule(id: string): boolean {
      if (!db.prepare(`SELECT 1 FROM effort_rules WHERE id = ?`).get(id)) return false;
      db.prepare(`DELETE FROM effort_rules WHERE id = ?`).run(id);
      return true;
    },
    /** PRs whose placement by a rule you undid: rules leave them to you. */
    undoneByRules: (): Set<string> => new Set((db.prepare(`SELECT ref FROM effort_assignments WHERE source = 'rule' AND kind = 'prUrl' AND undone_at IS NOT NULL`)
      .all() as { ref: string }[]).map((row) => row.ref)),
    /** PRs each rule placed since then, not counting undone placements. */
    ruleHits: (since: number): Map<string, number> => new Map((db.prepare(`SELECT rule_id AS ruleId, COUNT(*) AS hits FROM effort_assignments
      WHERE rule_id IS NOT NULL AND kind = 'prUrl' AND undone_at IS NULL AND at >= ? GROUP BY rule_id`).all(since) as { ruleId: string; hits: number }[])
      .map((row) => [row.ruleId, row.hits])),
    /** Returns the effort the action added to and how, so the caller can finish a new effort's undo. */
    undo(actionId: string): { effortId: string; source: AssignmentSource } {
      return db.transaction(() => {
        const rows = db.prepare(`SELECT effort_id AS effortId, source, kind, ref, from_effort_id AS "from" FROM effort_assignments
          WHERE action_id = ? AND undone_at IS NULL`).all(actionId) as Row[];
        if (rows.length === 0) throw new Error("Nothing to undo.");
        const { effortId, source } = rows[0]!;
        if (rows.some((row) => efforts.owner(row.kind, row.ref)?.id !== effortId)) throw new Error("This work moved since, so Undo no longer applies.");
        // A PR moved out of an effort goes back to it; the rest leave, and a PR its ticket placed rejoins that ticket's effort.
        const back = rows.filter((row) => row.from !== null);
        for (const from of new Set(back.map((row) => row.from!))) {
          const home = efforts.get(from);
          if (!home || home.archivedAt) throw new Error("The effort it came from is gone or archived, so Undo no longer applies.");
          efforts.transfer(home.id, { tickets: [], prUrls: back.filter((row) => row.from === from).map((row) => row.ref) });
        }
        const leave = rows.filter((row) => row.from === null);
        efforts.release(effortId, { tickets: leave.flatMap((row) => row.kind === "ticket" ? [row.ref] : []), prUrls: leave.flatMap((row) => row.kind === "prUrl" ? [row.ref] : []) });
        db.prepare(`UPDATE effort_assignments SET undone_at = ? WHERE action_id = ?`).run(now(), actionId);
        return { effortId, source };
      })();
    },
  };
}
