// Linear's GraphQL API: the documents the tools send, what comes back, and
// how an issue is written out for an agent. Pure: the one function that
// talks to the network takes its fetch as an argument, and no token appears
// in anything this module returns or throws.
import { z } from "zod";

export const GRAPHQL_PATH = "/graphql";

/** How much of a description or comment a tool shows. Context, not a copy of the ticket. */
export const DESCRIPTION_CHARS = 6000;
export const COMMENT_CHARS = 2000;
export const COMMENTS_SHOWN = 15;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_LIMIT_DEFAULT = 20;

export class LinearRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LinearRequestError";
  }
}

type FetchLike = (url: string | URL, init: RequestInit) => Promise<Response>;

/**
 * One request. A non-2xx answer throws with the status so the caller can
 * tell an expired token (401) from anything else; GraphQL-level errors come
 * back in the payload for the caller to read.
 */
export async function graphql(
  apiUrl: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(new URL(GRAPHQL_PATH, apiUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(variables === undefined ? { query } : { query, variables }),
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new LinearRequestError(`Linear answered HTTP ${response.status}${firstErrorMessage(payload) === null ? "" : `: ${firstErrorMessage(payload)}`}`, response.status);
  }
  return payload;
}

export function graphqlErrors(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object") return [];
  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => (e !== null && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : String(e)));
}

function firstErrorMessage(payload: unknown): string | null {
  return graphqlErrors(payload)[0] ?? null;
}

/** The `data` of a payload, or a thrown Error naming the first GraphQL error. */
export function dataOf(payload: unknown): Record<string, unknown> {
  const errors = graphqlErrors(payload);
  const data = payload !== null && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
  if (data === null || typeof data !== "object") {
    throw new Error(errors.length > 0 ? `Linear: ${errors.join("; ")}` : "Linear answered without data");
  }
  if (errors.length > 0) throw new Error(`Linear: ${errors.join("; ")}`);
  return data as Record<string, unknown>;
}

// ---- the viewer ------------------------------------------------------------

export const VIEWER_QUERY = "query { viewer { id name displayName email } organization { name urlKey } }";

export const viewerSchema = z.object({
  viewer: z.object({ id: z.string(), name: z.string().nullish(), displayName: z.string().nullish(), email: z.string().nullish() }),
  organization: z.object({ name: z.string(), urlKey: z.string() }),
});
export type Viewer = {
  user: { id: string; name: string; email: string | null };
  organization: { name: string; urlKey: string };
};

export function parseViewer(payload: unknown): Viewer {
  const parsed = viewerSchema.parse(dataOf(payload));
  return {
    user: {
      id: parsed.viewer.id,
      name: parsed.viewer.displayName ?? parsed.viewer.name ?? parsed.viewer.email ?? parsed.viewer.id,
      email: parsed.viewer.email ?? null,
    },
    organization: parsed.organization,
  };
}

// ---- issues ----------------------------------------------------------------

const ISSUE_FIELDS =
  "id identifier title description url branchName priority priorityLabel estimate dueDate createdAt updatedAt " +
  "state { name type } team { key name } assignee { name displayName email } creator { name displayName } " +
  "labels { nodes { name } } project { name } cycle { number name } parent { identifier title } " +
  "children { nodes { identifier title state { name } } }";

const COMMENT_FIELDS = "comments(first: 50) { nodes { body createdAt url user { name displayName } } }";

export const ISSUE_QUERY = `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} ${COMMENT_FIELDS} } }`;
export const ISSUES_QUERY = `query($filter: IssueFilter, $first: Int!) { issues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } } }`;
export const SEARCH_QUERY = `query($term: String!, $filter: IssueFilter, $first: Int!) { searchIssues(term: $term, filter: $filter, first: $first) { nodes { ${ISSUE_FIELDS} } } }`;
export const ISSUE_REF_QUERY =
  "query($id: String!) { issue(id: $id) { id identifier labels { nodes { id name } } team { key states { nodes { id name type position } } labels(first: 250) { nodes { id name } } } } " +
  "issueLabels(filter: { team: { null: true } }, first: 250) { nodes { id name } } }";
export const COMMENT_CREATE = "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { url } } }";
export const ISSUE_UPDATE = "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier state { name } assignee { name displayName email } labels { nodes { name } } priority } } }";
export const ISSUE_CREATE = "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }";
/** A team by key, with the states and labels an issue in it can take. Workspace labels apply to every team. */
export const TEAM_QUERY =
  "query($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) { nodes { id key name states { nodes { id name type position } } labels(first: 250) { nodes { id name } } } } " +
  "issueLabels(filter: { team: { null: true } }, first: 250) { nodes { id name } } }";
export const USERS_QUERY =
  "query($who: String!) { users(filter: { or: [{ displayName: { containsIgnoreCase: $who } }, { name: { containsIgnoreCase: $who } }, { email: { eqIgnoreCase: $who } }] }, first: 10) { nodes { id name displayName email active } } }";

const person = z.object({ name: z.string().nullish(), displayName: z.string().nullish(), email: z.string().nullish() }).nullish();
const personName = (p: z.infer<typeof person>) => p?.displayName ?? p?.name ?? p?.email ?? null;

const commentSchema = z.object({
  body: z.string().nullish(),
  createdAt: z.string().nullish(),
  url: z.string().nullish(),
  user: person,
});

export const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  url: z.string().nullish(),
  branchName: z.string().nullish(),
  priority: z.number().nullish(),
  priorityLabel: z.string().nullish(),
  estimate: z.number().nullish(),
  dueDate: z.string().nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  state: z.object({ name: z.string(), type: z.string().nullish() }).nullish(),
  team: z.object({ key: z.string(), name: z.string().nullish() }).nullish(),
  assignee: person,
  creator: person,
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullish(),
  project: z.object({ name: z.string() }).nullish(),
  cycle: z.object({ number: z.number(), name: z.string().nullish() }).nullish(),
  parent: z.object({ identifier: z.string(), title: z.string().nullish() }).nullish(),
  children: z.object({ nodes: z.array(z.object({ identifier: z.string(), title: z.string().nullish(), state: z.object({ name: z.string() }).nullish() })) }).nullish(),
  comments: z.object({ nodes: z.array(commentSchema) }).nullish(),
});
export type Issue = z.infer<typeof issueSchema>;

export function parseIssue(payload: unknown): Issue | null {
  const data = dataOf(payload);
  if (data.issue === null || data.issue === undefined) return null;
  return issueSchema.parse(data.issue);
}

export function parseIssueList(payload: unknown, field: "issues" | "searchIssues"): Issue[] {
  const data = dataOf(payload);
  const list = z.object({ nodes: z.array(issueSchema) }).parse(data[field]);
  return list.nodes;
}

const labelNodes = z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) });

export type IssueRef = {
  id: string;
  identifier: string;
  /** The labels on the issue now. */
  labels: Array<{ id: string; name: string }>;
  team: {
    key: string;
    states: Array<{ id: string; name: string; type: string; position: number }>;
    /** The labels the issue may carry: the team's own and the workspace's. */
    labels: Array<{ id: string; name: string }>;
  };
};

export function parseIssueRef(payload: unknown): IssueRef | null {
  const data = dataOf(payload);
  if (data.issue === null || data.issue === undefined) return null;
  const parsed = z
    .object({
      issue: z.object({
        id: z.string(),
        identifier: z.string(),
        labels: labelNodes.nullish(),
        team: z.object({
          key: z.string(),
          states: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), position: z.number() })) }),
          labels: labelNodes.nullish(),
        }),
      }),
      issueLabels: labelNodes.nullish(),
    })
    .parse(data);
  const issue = parsed.issue;
  return {
    id: issue.id,
    identifier: issue.identifier,
    labels: issue.labels?.nodes ?? [],
    team: { key: issue.team.key, states: issue.team.states.nodes, labels: [...(issue.team.labels?.nodes ?? []), ...(parsed.issueLabels?.nodes ?? [])] },
  };
}

/** The state whose name matches, ignoring case; null when none does. */
export function findState(states: IssueRef["team"]["states"], name: string): IssueRef["team"]["states"][number] | null {
  const wanted = name.trim().toLowerCase();
  return states.find((s) => s.name.toLowerCase() === wanted) ?? null;
}

export function parseCommentCreate(payload: unknown): { url: string | null } {
  const data = dataOf(payload);
  const parsed = z.object({ success: z.boolean(), comment: z.object({ url: z.string().nullish() }).nullish() }).parse(data.commentCreate);
  if (!parsed.success) throw new Error("Linear did not create the comment");
  return { url: parsed.comment?.url ?? null };
}

export type IssueUpdated = { identifier: string; state: string | null; assignee: string | null; labels: string[]; priority: number | null };

export function parseIssueUpdate(payload: unknown): IssueUpdated {
  const data = dataOf(payload);
  const parsed = z
    .object({
      success: z.boolean(),
      issue: z
        .object({
          identifier: z.string(),
          state: z.object({ name: z.string() }).nullish(),
          assignee: person,
          labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullish(),
          priority: z.number().nullish(),
        })
        .nullish(),
    })
    .parse(data.issueUpdate);
  if (!parsed.success || parsed.issue === null || parsed.issue === undefined) throw new Error("Linear did not update the issue");
  const issue = parsed.issue;
  return { identifier: issue.identifier, state: issue.state?.name ?? null, assignee: personName(issue.assignee), labels: (issue.labels?.nodes ?? []).map((l) => l.name), priority: issue.priority ?? null };
}

export function parseIssueCreate(payload: unknown): { identifier: string; url: string | null } {
  const data = dataOf(payload);
  const parsed = z
    .object({ success: z.boolean(), issue: z.object({ identifier: z.string(), url: z.string().nullish() }).nullish() })
    .parse(data.issueCreate);
  if (!parsed.success || parsed.issue === null || parsed.issue === undefined) throw new Error("Linear did not create the issue");
  return { identifier: parsed.issue.identifier, url: parsed.issue.url ?? null };
}

export type Team = {
  id: string;
  key: string;
  name: string | null;
  states: IssueRef["team"]["states"];
  /** The team's own labels and the workspace's, the team's first. */
  labels: Array<{ id: string; name: string }>;
};

export function parseTeam(payload: unknown): Team | null {
  const data = dataOf(payload);
  const parsed = z
    .object({
      teams: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            key: z.string(),
            name: z.string().nullish(),
            states: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), position: z.number() })) }),
            labels: labelNodes.nullish(),
          }),
        ),
      }),
      issueLabels: labelNodes.nullish(),
    })
    .parse(data);
  const team = parsed.teams.nodes[0];
  if (team === undefined) return null;
  return {
    id: team.id,
    key: team.key,
    name: team.name ?? null,
    states: team.states.nodes,
    labels: [...(team.labels?.nodes ?? []), ...(parsed.issueLabels?.nodes ?? [])],
  };
}

/** Each wanted label's id, matched by name ignoring case; the names with no match. */
export function findLabels(labels: Team["labels"], names: string[]): { ids: string[]; missing: string[] } {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const wanted = name.trim().toLowerCase();
    const found = labels.find((l) => l.name.toLowerCase() === wanted);
    if (found === undefined) missing.push(name.trim());
    else if (!ids.includes(found.id)) ids.push(found.id);
  }
  return { ids, missing };
}

export type User = { id: string; name: string; email: string | null; active: boolean };

export function parseUsers(payload: unknown): User[] {
  const data = dataOf(payload);
  const parsed = z
    .object({ nodes: z.array(z.object({ id: z.string(), name: z.string().nullish(), displayName: z.string().nullish(), email: z.string().nullish(), active: z.boolean().nullish() })) })
    .parse(data.users);
  return parsed.nodes.map((u) => ({ id: u.id, name: u.displayName ?? u.name ?? u.email ?? u.id, email: u.email ?? null, active: u.active ?? true }));
}

/** Linear's priority numbers: 0 is none, 1 urgent, 4 low. */
export const PRIORITIES = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 } as const;
export const PRIORITY_NAMES = Object.fromEntries(Object.entries(PRIORITIES).map(([name, n]) => [n, name])) as Record<number, keyof typeof PRIORITIES>;
export type PriorityName = keyof typeof PRIORITIES;

// ---- search filters --------------------------------------------------------

export interface SearchInput {
  query?: string;
  team?: string;
  state?: string;
  assignee?: string;
  openOnly?: boolean;
  limit?: number;
}

/** An IssueFilter from the tool's arguments; undefined when there is nothing to filter by. */
export function issueFilter(input: SearchInput): Record<string, unknown> | undefined {
  const and: Record<string, unknown>[] = [];
  if (input.team !== undefined && input.team.trim() !== "") and.push({ team: { key: { eq: input.team.trim().toUpperCase() } } });
  if (input.state !== undefined && input.state.trim() !== "") and.push({ state: { name: { eqIgnoreCase: input.state.trim() } } });
  else if (input.openOnly === true) and.push({ state: { type: { nin: ["completed", "canceled"] } } });
  if (input.assignee !== undefined && input.assignee.trim() !== "") {
    const who = input.assignee.trim();
    and.push(
      who.toLowerCase() === "me"
        ? { assignee: { isMe: { eq: true } } }
        : { assignee: { or: [{ displayName: { containsIgnoreCase: who } }, { name: { containsIgnoreCase: who } }, { email: { eqIgnoreCase: who } }] } },
    );
  }
  if (and.length === 0) return undefined;
  return and.length === 1 ? and[0] : { and };
}

export function searchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SEARCH_LIMIT_DEFAULT;
  return Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(limit)));
}

// ---- the read-only escape hatch --------------------------------------------

/**
 * Whether a document is a query and not a mutation. Comments are stripped
 * first so a `# mutation` cannot hide one and a `# query` cannot excuse one.
 * Anonymous selections (`{ viewer { id } }`) are queries.
 */
export function isReadOnlyDocument(document: string): boolean {
  const stripped = document.replace(/#[^\n]*/gu, "").trim();
  if (stripped === "") return false;
  if (/\b(mutation|subscription)\b/u.test(stripped)) return false;
  return /^(query\b|\{)/u.test(stripped);
}

// ---- writing an issue out --------------------------------------------------

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`);

/** One line per issue, for lists. */
export function issueLine(issue: Issue): string {
  const parts = [`${issue.identifier}`, issue.title ?? "(untitled)"];
  const meta: string[] = [];
  if (issue.state) meta.push(issue.state.name);
  const assignee = personName(issue.assignee);
  if (assignee !== null) meta.push(`@${assignee}`);
  if (issue.priorityLabel && issue.priority !== 0) meta.push(issue.priorityLabel);
  return `- ${parts.join(" ")}${meta.length > 0 ? ` [${meta.join(", ")}]` : ""}`;
}

export function formatIssueList(issues: Issue[], heading: string): string {
  if (issues.length === 0) return `${heading}: no issues.`;
  return `${heading} (${issues.length}):\n${issues.map(issueLine).join("\n")}`;
}

/** The whole issue, as an agent should see it. */
export function formatIssue(issue: Issue): string {
  const lines: string[] = [];
  lines.push(`# ${issue.identifier}: ${issue.title ?? "(untitled)"}`);
  const facts: Array<[string, string | null | undefined]> = [
    ["State", issue.state ? `${issue.state.name}${issue.state.type ? ` (${issue.state.type})` : ""}` : null],
    ["Team", issue.team ? `${issue.team.key}${issue.team.name ? ` – ${issue.team.name}` : ""}` : null],
    ["Assignee", personName(issue.assignee)],
    ["Creator", personName(issue.creator)],
    ["Priority", issue.priority === 0 || issue.priority === null || issue.priority === undefined ? null : issue.priorityLabel ?? String(issue.priority)],
    ["Estimate", issue.estimate === null || issue.estimate === undefined ? null : String(issue.estimate)],
    ["Labels", issue.labels && issue.labels.nodes.length > 0 ? issue.labels.nodes.map((l) => l.name).join(", ") : null],
    ["Project", issue.project?.name],
    ["Cycle", issue.cycle ? `${issue.cycle.number}${issue.cycle.name ? ` (${issue.cycle.name})` : ""}` : null],
    ["Parent", issue.parent ? `${issue.parent.identifier}${issue.parent.title ? `: ${issue.parent.title}` : ""}` : null],
    ["Due", issue.dueDate],
    ["Branch", issue.branchName],
    ["URL", issue.url],
    ["Created", issue.createdAt],
    ["Updated", issue.updatedAt],
  ];
  for (const [label, value] of facts) {
    if (value !== null && value !== undefined && value !== "") lines.push(`${label}: ${value}`);
  }
  if (issue.children && issue.children.nodes.length > 0) {
    lines.push("", "Sub-issues:");
    for (const child of issue.children.nodes) {
      lines.push(`- ${child.identifier} ${child.title ?? "(untitled)"}${child.state ? ` [${child.state.name}]` : ""}`);
    }
  }
  lines.push("", "## Description", issue.description && issue.description.trim() !== "" ? clip(issue.description, DESCRIPTION_CHARS) : "(none)");
  const comments = [...(issue.comments?.nodes ?? [])].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const shown = comments.slice(-COMMENTS_SHOWN);
  lines.push("", `## Comments (${comments.length}${shown.length < comments.length ? `, last ${shown.length} shown` : ""})`);
  if (shown.length === 0) lines.push("(none)");
  for (const c of shown) {
    lines.push(`### ${personName(c.user) ?? "someone"} — ${c.createdAt ?? ""}`, clip(c.body ?? "", COMMENT_CHARS), "");
  }
  return lines.join("\n").trimEnd();
}
