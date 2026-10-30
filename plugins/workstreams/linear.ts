// Linear ticket detail: which key can see which ticket, the batched query that
// fetches it, and what comes back. Pure: no fetch, no storage, no key ever
// leaves this module in a return value — a key is referred to by its INDEX in
// the parsed key list, so a log line or a stored row can never carry one.
import { z } from "zod";

/** A ticket's detail is refetched at most this often. */
export const LINEAR_DETAIL_TTL_MS = 12 * 60 * 60 * 1_000;
/** Each key's workspace and team keys are re-read at most this often (and on a settings change). */
export const LINEAR_TEAMS_TTL_MS = 24 * 60 * 60 * 1_000;
/** Issues per aliased query. */
export const LINEAR_BATCH = 25;
/** How much of a description is kept: context for naming, not a copy of the ticket. */
export const DESCRIPTION_CHARS = 500;
/** A PR merged this recently keeps its tickets in the sync, so Reconcile reads them fresh; an older merge keeps its last read. */
export const LINEAR_MERGED_MS = 14 * 86_400_000;
/** Linear moves a merged PR's tickets itself, soon after the merge: a read sooner than this after it may come before Linear did. */
export const LINEAR_SETTLE_MS = 10 * 60_000;
/** A ticket's read speaks for it after a merge that names it only once made LINEAR_SETTLE_MS past the merge. */
export const readSettled = (readAt: number | undefined, mergedAt: number) => readAt !== undefined && readAt >= mergedAt + LINEAR_SETTLE_MS;

/**
 * Every key the two settings hold, in order, without duplicates. A secret
 * cannot be multi-line, so the new setting separates keys with commas or any
 * whitespace; the old single-key setting is read too, so a key entered before
 * the new one existed keeps working.
 */
export function parseLinearKeys(...values: unknown[]): string[] {
  const keys: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const key of value.split(/[\s,]+/u)) {
      if (key !== "" && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/** The prefix a ticket key is routed by: `ABC-101` → `ABC`. */
export function ticketPrefix(ticket: string): string {
  const dash = ticket.lastIndexOf("-");
  return (dash === -1 ? ticket : ticket.slice(0, dash)).toUpperCase();
}

/** One key's workspace, as discovered. `keyIndex` stands in for the key everywhere. */
export type LinearWorkspace = {
  keyIndex: number;
  name: string;
  urlKey: string;
  teams: string[];
  /** Team key → the team's display name, where Linear gave one. */
  teamNames?: Record<string, string>;
};

export const WORKSPACE_QUERY = "query { viewer { organization { name urlKey } } teams(first: 250) { nodes { key name } } }";

const workspaceSchema = z.object({
  data: z.object({
    viewer: z.object({ organization: z.object({ name: z.string(), urlKey: z.string() }) }),
    teams: z.object({ nodes: z.array(z.object({ key: z.string(), name: z.string().nullish() })) }),
  }),
});

/** A workspace-discovery response, or null when it is not one. */
export function parseWorkspace(keyIndex: number, payload: unknown): LinearWorkspace | null {
  if (hasGraphqlErrors(payload)) return null;
  const parsed = workspaceSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { organization } = parsed.data.data.viewer;
  return {
    keyIndex,
    name: organization.name,
    urlKey: organization.urlKey,
    teams: [...new Set(parsed.data.data.teams.nodes.map((team) => team.key.toUpperCase()))],
    teamNames: Object.fromEntries(
      parsed.data.data.teams.nodes.flatMap((team) => (typeof team.name === "string" && team.name.trim() !== "" ? [[team.key.toUpperCase(), team.name.trim().slice(0, 60)]] : [])),
    ),
  };
}

/**
 * Team key → the key index that owns it. When two keys claim one team the
 * lower index wins — deterministic, and the order the user typed — and the team
 * is reported once as a duplicate so the caller can warn about it.
 */
export function routeTeams(workspaces: readonly LinearWorkspace[]): {
  owner: Map<string, number>;
  duplicates: string[];
} {
  const owner = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const workspace of [...workspaces].sort((a, b) => a.keyIndex - b.keyIndex)) {
    for (const team of workspace.teams) {
      if (owner.has(team)) duplicates.add(team);
      else owner.set(team, workspace.keyIndex);
    }
  }
  return { owner, duplicates: [...duplicates].sort() };
}

/**
 * Split tickets by the key that can see them. A ticket whose prefix no key owns
 * is left out: it gets no Linear detail, which is not an error.
 */
export function planFetch(tickets: readonly string[], owner: ReadonlyMap<string, number>): Map<number, string[]> {
  const byKey = new Map<number, string[]>();
  for (const ticket of tickets) {
    const index = owner.get(ticketPrefix(ticket));
    if (index === undefined) continue;
    const bucket = byKey.get(index);
    if (bucket === undefined) byKey.set(index, [ticket]);
    else bucket.push(ticket);
  }
  return byKey;
}

/** One aliased query for a batch: `t0: issue(id: "ABC-1") { ... } t1: ...`. Initiatives are capped so a batch stays well inside Linear's query cost. */
export function detailQuery(batch: readonly string[]): string {
  const fields = "identifier title description state { name type } priority priorityLabel estimate " +
    "project { id name description targetDate initiatives(first: 5) { nodes { id name } } } parent { identifier title } labels { nodes { name } } " +
    "assignee { name displayName } cycle { number name endsAt } dueDate url createdAt startedAt completedAt canceledAt updatedAt";
  return `query {${batch.map((ticket, slot) => ` t${slot}: issue(id: ${JSON.stringify(ticket)}) { ${fields} }`).join("")} }`;
}

/**
 * What the board keeps about one ticket. Every field past the identifier may be missing. The optional fields came with the Linear seed
 * (A16): a key read always sets them, and a row cached before them, or by the removed agent fetch (`source: "agent"`), has none.
 */
export type LinearDetail = {
  identifier: string;
  title: string | null;
  description: string | null;
  state: { name: string; type: string | null } | null;
  project: { id: string | null; name: string; description?: string | null; targetDate?: string | null; initiatives?: { id: string; name: string }[] } | null;
  parent: { identifier: string | null; title: string | null } | null;
  labels: string[];
  assignee?: string | null;
  cycle?: { number: number; name: string | null; endsAt: string | null } | null;
  /** The ticket's own due date, as Linear's calendar date (2026-10-17). */
  dueDate?: string | null;
  /**
   * Linear's priority, 0 for none, then 1 Urgent to 4 Low, and its word for it; its points; and when it was created, started, completed,
   * and canceled. Effort card v2 added them: a row cached before has none until its 12-hour cache runs out.
   */
  priority?: number | null; priorityLabel?: string | null; estimate?: number | null;
  createdAt?: string | null; startedAt?: string | null; completedAt?: string | null; canceledAt?: string | null;
  url: string | null;
  updatedAt: string | null;
  source: "key" | "agent";
};
/** A key read cached before the seed's fields: refetched on the next sync rather than after its TTL. */
export const missingSeedFields = (detail: LinearDetail | null) => detail !== null && !("cycle" in detail);

const issueSchema = z.object({
  identifier: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  state: z.object({ name: z.string(), type: z.string().nullish() }).nullish(),
  project: z.object({ id: z.string().nullish(), name: z.string(), description: z.string().nullish(), targetDate: z.string().nullish(),
    initiatives: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }).nullish() }).nullish(),
  parent: z.object({ identifier: z.string().nullish(), title: z.string().nullish() }).nullish(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullish(),
  assignee: z.object({ name: z.string().nullish(), displayName: z.string().nullish() }).nullish(),
  cycle: z.object({ number: z.number(), name: z.string().nullish(), endsAt: z.string().nullish() }).nullish(),
  dueDate: z.string().nullish(),
  priority: z.number().nullish(), priorityLabel: z.string().nullish(), estimate: z.number().nullish(),
  createdAt: z.string().nullish(), startedAt: z.string().nullish(), completedAt: z.string().nullish(), canceledAt: z.string().nullish(),
  url: z.string().nullish(),
  updatedAt: z.string().nullish(),
});

/**
 * Read one batch's response. An explicit null means Linear has no such issue
 * only when the response has no GraphQL errors. Missing or unreadable aliases
 * are left out so a partial response cannot poison the cache.
 */
export function parseDetails(batch: readonly string[], payload: unknown): Map<string, LinearDetail | null> | null {
  const data =
    payload !== null && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
  if (data === null || typeof data !== "object") return null;
  const errors = graphqlErrors(payload);
  const failedAliases = new Set<string>();
  let unscopedError = false;
  for (const error of errors) {
    const path = error !== null && typeof error === "object" ? (error as { path?: unknown }).path : undefined;
    const alias = Array.isArray(path) ? path[0] : undefined;
    if (typeof alias === "string" && /^t\d+$/u.test(alias)) failedAliases.add(alias);
    else unscopedError = true;
  }
  const out = new Map<string, LinearDetail | null>();
  batch.forEach((ticket, slot) => {
    const alias = `t${slot}`;
    if (unscopedError || failedAliases.has(alias)) return;
    if (!Object.hasOwn(data, alias)) return;
    const raw = (data as Record<string, unknown>)[alias];
    if (raw === null) {
      if (errors.length === 0) out.set(ticket, null);
      return;
    }
    const issue = issueSchema.safeParse(raw);
    if (!issue.success || issue.data.identifier.toUpperCase() !== ticket.toUpperCase()) return;
    const value = issue.data;
    out.set(ticket, {
      identifier: value.identifier,
      title: value.title ?? null,
      description: value.description === null || value.description === undefined ? null : value.description.slice(0, DESCRIPTION_CHARS),
      state: value.state === null || value.state === undefined ? null : { name: value.state.name, type: value.state.type ?? null },
      project: value.project === null || value.project === undefined ? null : { id: value.project.id ?? null, name: value.project.name,
        description: value.project.description?.slice(0, DESCRIPTION_CHARS) ?? null, targetDate: value.project.targetDate ?? null,
        initiatives: (value.project.initiatives?.nodes ?? []).map((initiative) => ({ id: initiative.id, name: initiative.name })) },
      parent:
        value.parent === null || value.parent === undefined
          ? null
          : { identifier: value.parent.identifier ?? null, title: value.parent.title ?? null },
      labels: (value.labels?.nodes ?? []).map((label) => label.name).slice(0, 20),
      assignee: value.assignee?.displayName ?? value.assignee?.name ?? null,
      cycle: value.cycle ? { number: value.cycle.number, name: value.cycle.name ?? null, endsAt: value.cycle.endsAt ?? null } : null,
      dueDate: value.dueDate ?? null,
      priority: value.priority ?? null, priorityLabel: value.priorityLabel ?? null, estimate: value.estimate ?? null,
      createdAt: value.createdAt ?? null, startedAt: value.startedAt ?? null, completedAt: value.completedAt ?? null, canceledAt: value.canceledAt ?? null,
      url: value.url ?? null,
      updatedAt: value.updatedAt ?? null,
      source: "key",
    });
  });
  return out;
}

function hasGraphqlErrors(payload: unknown): boolean {
  return graphqlErrors(payload).length > 0;
}

function graphqlErrors(payload: unknown): unknown[] {
  if (payload === null || typeof payload !== "object") return [];
  const errors = (payload as { errors?: unknown }).errors;
  return Array.isArray(errors) ? errors : [];
}

/** The name `basic` mode and the Linear seed term have always used: the project, else the parent's title. */
export function projectNameOf(detail: LinearDetail | null | undefined): string | null {
  const name = detail?.project?.name ?? detail?.parent?.title ?? null;
  return name === null || name.trim() === "" ? null : name.trim();
}
