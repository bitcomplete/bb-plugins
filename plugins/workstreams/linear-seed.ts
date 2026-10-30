// Seed efforts from Linear projects (plan amendment A16). The preview proposes
// one effort per Linear project whose tickets are on your open PRs, and flags
// an effort that already matches it by name, by owning some of its PRs, or by
// having been seeded from it. Nothing is created until you pick projects and
// press Create; each seeded effort records the project it came from, in its
// own table so no effort save can drop it, and never reads Linear again. Pure
// but for the seed store: the server gathers the facts.
import { z } from "zod";
import type { LinearDetail } from "./linear.js";
import type { RunDb } from "./runstore.js";

/** Append-only: server.ts adds this after deck batches (id 64). */
export const LINEAR_SEED_MIGRATION =
  `CREATE TABLE IF NOT EXISTS effort_seeds (effort_id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL)`;

export const seededFromSchema = z.object({ kind: z.literal("linear-project"), id: z.string(), name: z.string() }).strict();
export type SeededFrom = z.infer<typeof seededFromSchema>;

const effortRef = z.object({ id: z.string(), name: z.string() }).strict();
export const seedProposalSchema = z.object({
  projectId: z.string(), name: z.string(),
  /** The project's summary, cut short. */
  goal: z.string(),
  /** Your open PRs with a ticket in the project, with the effort that owns each now: Create adds only the ones no effort owns. */
  prs: z.array(z.object({ prUrl: z.string(), repo: z.string(), number: z.number(), title: z.string(), tickets: z.array(z.string()), effort: effortRef.nullable() }).strict()),
  /** Efforts it may duplicate: one with its name, one that owns some of its PRs (how many), or one seeded from it. */
  matches: z.array(effortRef.extend({ by: z.enum(["name", "members", "seed"]), prs: z.number() }).strict()),
}).strict();
export type SeedProposal = z.infer<typeof seedProposalSchema>;

const failure = z.object({ ok: z.literal(false), error: z.string() });
export const linearSeedContract = {
  /** Read-only: one proposed effort per Linear project with tickets on your open PRs, from the Linear details the board stores. */
  linear_seed_preview: { input: z.null(), output: z.object({ proposals: z.array(seedProposalSchema),
    /** Whether any Linear API key is set: without one, the board has no project ids to seed from. */
    keyed: z.boolean() }).strict() },
  /**
   * Create an effort for each project you picked, from the preview read again now, with the PRs in it that no effort owns, as one undoable
   * classification each. A project that an effort was seeded from, whose name an effort has, or whose PRs all have an effort is skipped.
   */
  linear_seed_create: { input: z.object({ projectIds: z.array(z.string().min(1).max(200)).min(1).max(50), requestId: z.string().uuid() }).strict(),
    output: z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true),
      created: z.array(z.object({ projectId: z.string(), actionId: z.string(), effort: z.object({ id: z.string(), key: z.string(), name: z.string() }).strict(),
        added: z.number() }).strict()),
      skipped: z.array(z.object({ projectId: z.string(), name: z.string(), reason: z.string() }).strict()) }).strict()]) },
};

/** A project's summary as a goal: its first line, at most 160 characters, cut at a word. */
export function seedGoal(description: string | null | undefined): string {
  const line = (description ?? "").split(/\r?\n/u).map((part) => part.trim()).find(Boolean) ?? "";
  if (line.length <= 160) return line;
  const space = line.lastIndexOf(" ", 158);
  return `${line.slice(0, space > 80 ? space : 159).trimEnd()}…`;
}

const nameKey = (value: string) => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();

export type SeedInput = {
  prs: readonly { prUrl: string; repo: string; number: number; title: string; tickets: readonly string[]; effort: { id: string; name: string } | null }[];
  linear: ReadonlyMap<string, LinearDetail>;
  /** Every effort not merged away, with the project it was seeded from. */
  efforts: readonly { id: string; name: string; seededFrom: string | null }[];
};

/**
 * One proposal per Linear project a ticket on your open PRs belongs to, most PRs to add first. Only a key read knows a project's id, so a
 * ticket whose detail the removed agent fetch cached proposes nothing. A PR with tickets in two projects is listed in both; the first created
 * takes it.
 */
export function seedProposals(input: SeedInput): SeedProposal[] {
  const projects = new Map<string, { name: string; goal: string; prs: SeedProposal["prs"] }>();
  for (const pr of input.prs) {
    const byProject = new Map<string, { name: string; goal: string; tickets: string[] }>();
    for (const ticket of pr.tickets) {
      const project = input.linear.get(ticket)?.project;
      if (!project?.id) continue;
      const entry = byProject.get(project.id) ?? { name: project.name, goal: seedGoal(project.description), tickets: [] };
      entry.tickets.push(ticket);
      byProject.set(project.id, entry);
    }
    for (const [id, entry] of byProject) {
      const proposal = projects.get(id) ?? { name: entry.name, goal: entry.goal, prs: [] };
      proposal.prs.push({ prUrl: pr.prUrl, repo: pr.repo, number: pr.number, title: pr.title, tickets: entry.tickets, effort: pr.effort });
      projects.set(id, proposal);
    }
  }
  return [...projects].map(([projectId, proposal]): SeedProposal => {
    const owners = new Map<string, { id: string; name: string; prs: number }>();
    for (const pr of proposal.prs) if (pr.effort) owners.set(pr.effort.id, { ...pr.effort, prs: (owners.get(pr.effort.id)?.prs ?? 0) + 1 });
    const matches: SeedProposal["matches"] = [
      ...input.efforts.filter((effort) => effort.seededFrom === projectId).map((effort) => ({ id: effort.id, name: effort.name, by: "seed" as const,
        prs: owners.get(effort.id)?.prs ?? 0 })),
      ...input.efforts.filter((effort) => effort.seededFrom !== projectId && nameKey(effort.name) === nameKey(proposal.name))
        .map((effort) => ({ id: effort.id, name: effort.name, by: "name" as const, prs: owners.get(effort.id)?.prs ?? 0 })),
    ];
    for (const owner of owners.values()) if (!matches.some((match) => match.id === owner.id)) matches.push({ ...owner, by: "members" });
    return { projectId, name: proposal.name, goal: proposal.goal, matches,
      prs: proposal.prs.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number) };
  }).sort((a, b) => b.prs.filter((pr) => !pr.effort).length - a.prs.filter((pr) => !pr.effort).length || a.name.localeCompare(b.name));
}

/** Where each seeded effort came from. A row outlives nothing: removing the effort's seed is part of undoing its creation. */
export function createSeedStore(db: RunDb, now = Date.now) {
  return {
    record(effortId: string, seed: SeededFrom): void {
      db.prepare(`INSERT OR REPLACE INTO effort_seeds (effort_id, kind, ref, name, at) VALUES (?, ?, ?, ?, ?)`).run(effortId, seed.kind, seed.id, seed.name, now());
    },
    get(effortId: string): SeededFrom | null {
      const row = db.prepare(`SELECT kind, ref AS id, name FROM effort_seeds WHERE effort_id = ?`).get(effortId);
      return row ? seededFromSchema.parse(row) : null;
    },
    remove(effortId: string): void {
      db.prepare(`DELETE FROM effort_seeds WHERE effort_id = ?`).run(effortId);
    },
    /** A merged effort's seed goes to the effort it merged into, unless that one has its own, so the project is never seeded twice. */
    move(fromId: string, toId: string): void {
      db.prepare(`UPDATE OR IGNORE effort_seeds SET effort_id = ? WHERE effort_id = ?`).run(toId, fromId);
    },
  };
}
