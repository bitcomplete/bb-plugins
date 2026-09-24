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
 * is `unowned`: it gets no Linear detail from a key, which is not an error, and
 * it is the only kind of ticket the manual agent fallback may ever ask about.
 */
export function planFetch(
  tickets: readonly string[],
  owner: ReadonlyMap<string, number>,
): { byKey: Map<number, string[]>; unowned: string[] } {
  const byKey = new Map<number, string[]>();
  const unowned: string[] = [];
  for (const ticket of tickets) {
    const index = owner.get(ticketPrefix(ticket));
    if (index === undefined) {
      unowned.push(ticket);
      continue;
    }
    const bucket = byKey.get(index);
    if (bucket === undefined) byKey.set(index, [ticket]);
    else bucket.push(ticket);
  }
  return { byKey, unowned };
}

/** One aliased query for a batch: `t0: issue(id: "ABC-1") { ... } t1: ...`. */
export function detailQuery(batch: readonly string[]): string {
  const fields =
    "identifier title description state { name type } project { id name } parent { identifier title } labels { nodes { name } } url updatedAt";
  return `query {${batch.map((ticket, slot) => ` t${slot}: issue(id: ${JSON.stringify(ticket)}) { ${fields} }`).join("")} }`;
}

/** What the board keeps about one ticket. Every field past the identifier may be missing. */
export type LinearDetail = {
  identifier: string;
  title: string | null;
  description: string | null;
  state: { name: string; type: string | null } | null;
  project: { id: string | null; name: string } | null;
  parent: { identifier: string | null; title: string | null } | null;
  labels: string[];
  url: string | null;
  updatedAt: string | null;
  source: "key" | "agent";
};

const issueSchema = z.object({
  identifier: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  state: z.object({ name: z.string(), type: z.string().nullish() }).nullish(),
  project: z.object({ id: z.string().nullish(), name: z.string() }).nullish(),
  parent: z.object({ identifier: z.string().nullish(), title: z.string().nullish() }).nullish(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullish(),
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
      project: value.project === null || value.project === undefined ? null : { id: value.project.id ?? null, name: value.project.name },
      parent:
        value.parent === null || value.parent === undefined
          ? null
          : { identifier: value.parent.identifier ?? null, title: value.parent.title ?? null },
      labels: (value.labels?.nodes ?? []).map((label) => label.name).slice(0, 20),
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
