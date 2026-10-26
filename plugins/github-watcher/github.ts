// GitHub's GraphQL API: how a pull request or issue is named, the documents
// the plugin sends (the watch's read, which is also stewards' snapshot, and
// the two stewards asks about repositories), and what comes back. Pure: the
// function that talks to the network takes its fetch as an argument, and no
// token appears in anything this module returns or throws.
import { z } from "zod";
import { DEPENDABOT_SEVERITIES, SNAPSHOT_COMMENT_CHARS, SNAPSHOT_COMMENTS_MAX, SNAPSHOT_DESCRIPTION_CHARS, signedBy, type AdoptableEntity, type DependabotAlert, type DependabotSeverity, type EntitySnapshot } from "./source-contract.js";

export const GITHUB_URL = "https://github.com";
export const GITHUB_API_URL = "https://api.github.com";
export const GRAPHQL_PATH = "/graphql";

/** The Dependabot alerts REST path for one repository, and one alert's. */
export const dependabotAlertsPath = (repo: string, state: string, perPage = 100): string => `/repos/${repo}/dependabot/alerts?state=${encodeURIComponent(state)}&per_page=${perPage}`;
export const dependabotAlertPath = (repo: string, number: number): string => `/repos/${repo}/dependabot/alerts/${number}`;

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubRequestError";
  }
}

// ---- naming a pull request or issue -------------------------------------------

/** "owner/repo" and a number. Issues and pull requests share one number space. */
export type Ref = { repo: string; number: number };

const NAME = "[A-Za-z0-9_.-]+";
const FORMS = [
  // https://github.com/owner/repo/pull/12, .../issues/12, with anything after the number
  new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${NAME})/(${NAME})/(?:pulls?|issues?)/(\\d+)(?:[/?#].*)?$`, "u"),
  // owner/repo/pull/12
  new RegExp(`^(${NAME})/(${NAME})/(?:pulls?|issues?)/(\\d+)$`, "u"),
  // owner/repo#12
  new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`, "u"),
];

/** A ref from any of the ways people write one, or null. The repository's casing is kept; GitHub decides. */
export function parseRef(input: string): Ref | null {
  const s = input.trim();
  for (const form of FORMS) {
    const m = form.exec(s);
    if (m === null) continue;
    const number = Number(m[3]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { repo: `${m[1]}/${m[2]}`, number };
  }
  return null;
}

/** The entity id doorbells carry and the watch store keys on: "owner/repo#12". */
export const refKey = (ref: Ref): string => `${ref.repo}#${ref.number}`;

export function parseRefKey(key: string): Ref | null {
  const m = new RegExp(`^(${NAME}/${NAME})#(\\d+)$`, "u").exec(key);
  return m === null ? null : { repo: m[1]!, number: Number(m[2]) };
}

/** "owner/repo" split in two, or null when it is not one: what a repo lease and a project's unit name. */
export function parseRepo(input: string): { owner: string; name: string } | null {
  const m = new RegExp(`^(${NAME})/(${NAME})$`, "u").exec(input.trim());
  return m === null ? null : { owner: m[1]!, name: m[2]! };
}

// ---- the request ---------------------------------------------------------------

type FetchLike = (url: string | URL, init: RequestInit) => Promise<Response>;

/**
 * One request. A non-2xx answer throws with the status so the caller can
 * tell a refused token (401) from anything else; GraphQL-level errors come
 * back in the payload for the caller to read.
 */
export async function graphql(apiUrl: string, token: string, query: string, variables: Record<string, unknown>, fetchImpl: FetchLike, signal: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(new URL(GRAPHQL_PATH, apiUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}`, "user-agent": "bb-plugin-github" },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const first = graphqlErrors(payload)[0];
    throw new GitHubRequestError(`GitHub answered HTTP ${response.status}${first === undefined ? "" : `: ${first}`}`, response.status);
  }
  return payload;
}

export function graphqlErrors(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object") return [];
  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => (e !== null && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : String(e)));
}

function errorTypes(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object") return [];
  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => (e !== null && typeof e === "object" && typeof (e as { type?: unknown }).type === "string" ? (e as { type: string }).type : ""));
}

// ---- the document --------------------------------------------------------------

const ACTOR = "{ login }";
const COMMENT_FIELDS = `id author ${ACTOR} body createdAt url`;
const COMMON_FIELDS = `number title body url createdAt updatedAt author ${ACTOR} assignees(first: 20) { nodes { login } } labels(first: 50) { nodes { name } } milestone { title } comments(last: 50) { nodes { ${COMMENT_FIELDS} } }`;

/**
 * One read of a pull request or issue: everything a watch compares, the
 * newest comments and reviews, and what stewards' snapshot adds on top (the
 * description, ids, the commit each review was given on, who pushed the
 * head, and who the token is).
 */
export const TARGET_QUERY = `query($owner: String!, $name: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $name) { nameWithOwner issueOrPullRequest(number: $number) { __typename
  ... on Issue { ${COMMON_FIELDS} state stateReason }
  ... on PullRequest { ${COMMON_FIELDS} state isDraft merged reviewDecision headRefName headRefOid baseRefName
    reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } } }
    latestReviews(first: 50) { nodes { author ${ACTOR} state } }
    reviews(last: 50) { nodes { id author ${ACTOR} state body createdAt submittedAt url commit { oid } comments(first: 50) { nodes { ${COMMENT_FIELDS} path } } } }
    commits(last: 1) { nodes { commit { oid author { user { login } } statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } } } } } } }`;

const actor = z.object({ login: z.string() }).nullish();
const commentNode = z.object({ id: z.string().nullish(), author: actor, body: z.string().nullish(), createdAt: z.string(), url: z.string().nullish(), path: z.string().nullish() });
const reviewNode = z.object({
  id: z.string().nullish(),
  author: actor,
  state: z.string(),
  body: z.string().nullish(),
  createdAt: z.string(),
  submittedAt: z.string().nullish(),
  url: z.string().nullish(),
  commit: z.object({ oid: z.string() }).nullish(),
  comments: z.object({ nodes: z.array(commentNode) }).nullish(),
});
const contextNode = z.object({
  __typename: z.string(),
  name: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  detailsUrl: z.string().nullish(),
  context: z.string().nullish(),
  state: z.string().nullish(),
  targetUrl: z.string().nullish(),
});
const common = {
  number: z.number(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  url: z.string().nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  author: actor,
  assignees: z.object({ nodes: z.array(z.object({ login: z.string() })) }).nullish(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullish(),
  milestone: z.object({ title: z.string() }).nullish(),
  comments: z.object({ nodes: z.array(commentNode) }).nullish(),
};
const issueNode = z.object({ __typename: z.literal("Issue"), ...common, state: z.string(), stateReason: z.string().nullish() });
const pullNode = z.object({
  __typename: z.literal("PullRequest"),
  ...common,
  state: z.string(),
  isDraft: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  reviewDecision: z.string().nullish(),
  headRefName: z.string().nullish(),
  headRefOid: z.string().nullish(),
  baseRefName: z.string().nullish(),
  reviewRequests: z.object({ nodes: z.array(z.object({ requestedReviewer: z.object({ __typename: z.string(), login: z.string().nullish(), name: z.string().nullish() }).nullish() })) }).nullish(),
  latestReviews: z.object({ nodes: z.array(z.object({ author: actor, state: z.string() })) }).nullish(),
  reviews: z.object({ nodes: z.array(reviewNode) }).nullish(),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ oid: z.string(), author: z.object({ user: actor }).nullish(), statusCheckRollup: z.object({ state: z.string(), contexts: z.object({ nodes: z.array(contextNode) }).nullish() }).nullish() }) })) }).nullish(),
});
const targetPayload = z.object({
  data: z.object({ viewer: actor, repository: z.object({ nameWithOwner: z.string(), issueOrPullRequest: z.discriminatedUnion("__typename", [issueNode, pullNode]).nullable() }).nullable() }).nullable(),
});

// ---- what comes back ---------------------------------------------------------------

/** One thing someone said on the target: a comment, a review, or an inline review comment. */
export type Comment = {
  author: string;
  /** What the author did: "commented", "approved", "requested changes", "reviewed", "commented on path/to/file". */
  did: string;
  body: string;
  createdAt: string;
  url: string | null;
};

export type Checks = {
  /** The rollup: success, failure, pending, error, expected. */
  state: string;
  /** Checks that concluded badly, each as "name (url)". */
  failing: string[];
};

export type Target = {
  kind: "issue" | "pull";
  /** The repository as GitHub spells it, which is also what doorbells carry. */
  repo: string;
  number: number;
  key: string;
  title: string | null;
  url: string | null;
  /** open, closed, merged, or open (draft); closed issues carry the reason. */
  state: string;
  author: string | null;
  assignees: string[];
  labels: string[];
  milestone: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Comments, reviews and review comments together, oldest first. */
  comments: Comment[];
  pull: {
    base: string | null;
    head: string | null;
    headSha: string | null;
    reviewDecision: string | null;
    requestedReviewers: string[];
    /** Each reviewer's latest review, "login: approved". */
    reviews: string[];
    checks: Checks | null;
  } | null;
};

const lower = (s: string | null | undefined): string | null => (s === null || s === undefined ? null : s.toLowerCase().replace(/_/gu, " "));

const REVIEW_VERBS: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed", DISMISSED: "had a review dismissed" };

type TargetNode = z.infer<typeof issueNode> | z.infer<typeof pullNode>;
type TargetRead = { repo: string; viewer: string | null; node: TargetNode };

/** The validated answer, or null when the repository or the number is not there (or not visible). Anything else throws. */
function readTargetPayload(payload: unknown): TargetRead | null {
  const errors = graphqlErrors(payload);
  const types = errorTypes(payload);
  const parsed = targetPayload.safeParse(payload);
  if (!parsed.success) throw new Error(errors.length > 0 ? `GitHub: ${errors.join("; ")}` : "GitHub answered without data");
  const repository = parsed.data.data?.repository ?? null;
  if (repository === null || repository.issueOrPullRequest === null) {
    // A missing repository or number is a NOT_FOUND error beside null data;
    // any other error with null data is something to report.
    if (errors.length > 0 && types.some((t) => t !== "NOT_FOUND")) throw new Error(`GitHub: ${errors.join("; ")}`);
    return null;
  }
  if (errors.length > 0 && types.some((t) => t !== "NOT_FOUND" && t !== "FORBIDDEN")) throw new Error(`GitHub: ${errors.join("; ")}`);
  return { repo: repository.nameWithOwner, viewer: parsed.data.data?.viewer?.login ?? null, node: repository.issueOrPullRequest };
}

/**
 * Comments, reviews and inline review comments as one list, oldest first,
 * each with GitHub's node id (its URL, or who and when, if there is none):
 * the watch reads them as what someone said, stewards' snapshot as things
 * it has already seen.
 */
function flattenComments(node: TargetNode): Array<Comment & { id: string }> {
  const idOf = (id: string | null | undefined, url: string | null | undefined, author: string, at: string) => id ?? url ?? `${author}@${at}`;
  const comments = (node.comments?.nodes ?? []).map((c) => {
    const author = c.author?.login ?? "someone";
    return { id: idOf(c.id, c.url, author, c.createdAt), author, did: "commented", body: c.body ?? "", createdAt: c.createdAt, url: c.url ?? null };
  });
  if (node.__typename === "PullRequest") {
    for (const r of node.reviews?.nodes ?? []) {
      // The viewer's own unsubmitted review is PENDING and not news.
      if (r.state === "PENDING") continue;
      const author = r.author?.login ?? "someone";
      const at = r.submittedAt ?? r.createdAt;
      const body = (r.body ?? "").trim();
      // An approval or a request for changes is an event even without words;
      // a review that only carries inline comments is told by those.
      if (body !== "" || (r.state !== "COMMENTED" && r.state !== "DISMISSED")) comments.push({ id: idOf(r.id, r.url, author, at), author, did: REVIEW_VERBS[r.state] ?? lower(r.state) ?? "reviewed", body, createdAt: at, url: r.url ?? null });
      for (const c of r.comments?.nodes ?? []) {
        const by = c.author?.login ?? author;
        comments.push({ id: idOf(c.id, c.url, by, c.createdAt), author: by, did: c.path ? `commented on ${c.path}` : "commented", body: c.body ?? "", createdAt: c.createdAt, url: c.url ?? null });
      }
    }
  }
  return sortComments(comments);
}

function targetOf({ repo, node }: TargetRead, comments: Comment[]): Target {
  const base: Omit<Target, "kind" | "state" | "pull"> = {
    repo,
    number: node.number,
    key: `${repo}#${node.number}`,
    title: node.title ?? null,
    url: node.url ?? null,
    author: node.author?.login ?? null,
    assignees: (node.assignees?.nodes ?? []).map((a) => a.login).sort(),
    labels: (node.labels?.nodes ?? []).map((l) => l.name).sort(),
    milestone: node.milestone?.title ?? null,
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
    comments,
  };
  if (node.__typename === "Issue") {
    const state = node.state.toLowerCase() === "closed" && node.stateReason ? `closed (${lower(node.stateReason)})` : node.state.toLowerCase();
    return { ...base, kind: "issue", state, pull: null };
  }
  const state = node.merged ? "merged" : node.state.toLowerCase() === "open" && node.isDraft ? "open (draft)" : node.state.toLowerCase();
  const commit = node.commits?.nodes[0]?.commit ?? null;
  const rollup = commit?.statusCheckRollup ?? null;
  let checks: Checks | null = null;
  if (rollup !== null) {
    const failing: string[] = [];
    for (const c of rollup.contexts?.nodes ?? []) {
      if (c.__typename === "CheckRun") {
        if (c.conclusion && ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(c.conclusion)) failing.push(c.detailsUrl ? `${c.name ?? "check"} (${c.detailsUrl})` : (c.name ?? "check"));
      } else if (c.__typename === "StatusContext") {
        if (c.state === "FAILURE" || c.state === "ERROR") failing.push(c.targetUrl ? `${c.context ?? "status"} (${c.targetUrl})` : (c.context ?? "status"));
      }
    }
    checks = { state: rollup.state.toLowerCase(), failing: failing.sort() };
  }
  return {
    ...base,
    kind: "pull",
    state,
    pull: {
      base: node.baseRefName ?? null,
      head: node.headRefName ?? null,
      headSha: commit?.oid ?? node.headRefOid ?? null,
      reviewDecision: lower(node.reviewDecision),
      requestedReviewers: (node.reviewRequests?.nodes ?? []).map((r) => r.requestedReviewer?.login ?? r.requestedReviewer?.name ?? "").filter((s) => s !== "").sort(),
      reviews: (node.latestReviews?.nodes ?? [])
        .filter((r) => r.state !== "PENDING")
        .map((r) => `${r.author?.login ?? "someone"}: ${lower(r.state)}`)
        .sort(),
      checks,
    },
  };
}

/** The target, or null when the repository or the number is not there (or not visible). Anything else throws. */
export function parseTarget(payload: unknown): Target | null {
  const read = readTargetPayload(payload);
  return read === null ? null : targetOf(read, flattenComments(read.node).map(({ id: _id, ...c }) => c));
}

const sortComments = <C extends Comment>(comments: C[]): C[] => [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

// ---- stewards' snapshot ----------------------------------------------------------

/** Long text cut to `max` characters, saying how much was left out. */
export const clipText = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`);

/**
 * The same read as stewards' contract wants it (source-contract.ts): the
 * state a playbook keys its phases on (open, draft, merged, closed), the
 * description, the newest comments with ids and the thread whose signature
 * each carries, and on a pull request every submitted review with the
 * commit it was given on. Null exactly when parseTarget is.
 */
export function parseSnapshot(payload: unknown): EntitySnapshot | null {
  const read = readTargetPayload(payload);
  if (read === null) return null;
  const all = flattenComments(read.node);
  const target = targetOf(read, all);
  const node = read.node;
  // The signature is the body's last line, so it is read before the body is clipped.
  const comments = all.slice(-SNAPSHOT_COMMENTS_MAX).map((c) => ({ id: c.id, author: c.author, did: c.did, body: clipText(c.body, SNAPSHOT_COMMENT_CHARS), createdAt: c.createdAt, url: c.url, signedBy: signedBy(c.body) }));
  const snapshot: EntitySnapshot = {
    source: "github",
    kind: target.kind,
    id: target.key,
    key: target.key,
    url: target.url,
    title: target.title,
    state: "open",
    stateType: null,
    unit: target.repo,
    labels: target.labels,
    author: target.author,
    assignees: target.assignees,
    priority: null,
    estimate: null,
    description: node.body === null || node.body === undefined ? null : clipText(node.body, SNAPSHOT_DESCRIPTION_CHARS),
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
    comments,
    parent: null,
    children: [],
    linkedPulls: [],
    pull: null,
    viewer: read.viewer,
  };
  if (node.__typename === "Issue") return { ...snapshot, state: node.state.toLowerCase() === "closed" ? "closed" : "open" };
  const merged = node.merged === true;
  const draft = node.isDraft === true;
  const state = merged ? "merged" : node.state.toLowerCase() !== "open" ? "closed" : draft ? "draft" : "open";
  const commit = node.commits?.nodes[0]?.commit ?? null;
  const reviews = (node.reviews?.nodes ?? [])
    .filter((r) => r.state !== "PENDING")
    .map((r) => ({ author: r.author?.login ?? "someone", state: lower(r.state) ?? "commented", submittedAt: r.submittedAt ?? r.createdAt, commit: r.commit?.oid ?? null }))
    .sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
  const p = target.pull!;
  return {
    ...snapshot,
    state,
    pull: { draft, merged, base: p.base, head: p.head, headSha: p.headSha, headAuthor: commit?.author?.user?.login ?? null, reviewDecision: p.reviewDecision, requestedReviewers: p.requestedReviewers, reviews, checks: p.checks },
  };
}


// ---- repositories, for stewards ------------------------------------------------------

/** Who the token is; also the cheapest proof that it works. */
export const VIEWER_QUERY = `query { viewer { login } }`;

export function parseViewer(payload: unknown): string {
  const parsed = z.object({ data: z.object({ viewer: z.object({ login: z.string() }) }) }).safeParse(payload);
  if (!parsed.success) {
    const errors = graphqlErrors(payload);
    throw new Error(errors.length > 0 ? `GitHub: ${errors.join("; ")}` : "GitHub answered without data");
  }
  return parsed.data.data.viewer.login;
}

/** Whether a repository is visible as the developer and carries a label: what `sourceValidate` asks per unit. */
export const REPO_CHECK_QUERY = `query($owner: String!, $name: String!, $label: String!) { viewer { login } repository(owner: $owner, name: $name) { nameWithOwner label(name: $label) { name } } }`;

const repoCheckPayload = z.object({
  data: z.object({ viewer: actor, repository: z.object({ nameWithOwner: z.string(), label: z.object({ name: z.string() }).nullish() }).nullable() }).nullable(),
});

/** found is false for a repository that is not there or not visible; any other error throws. */
export function parseRepoCheck(payload: unknown): { viewer: string | null; found: boolean; labelFound: boolean } {
  const errors = graphqlErrors(payload);
  const parsed = repoCheckPayload.safeParse(payload);
  if (!parsed.success) throw new Error(errors.length > 0 ? `GitHub: ${errors.join("; ")}` : "GitHub answered without data");
  const repository = parsed.data.data?.repository ?? null;
  if (errors.length > 0 && errorTypes(payload).some((t) => t !== "NOT_FOUND")) throw new Error(`GitHub: ${errors.join("; ")}`);
  return { viewer: parsed.data.data?.viewer?.login ?? null, found: repository !== null, labelFound: repository?.label != null };
}

/** One page of a repository's open pull requests, oldest created first: what a nightly pass may adopt. */
export const OPEN_PULLS_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String) { viewer { login } repository(owner: $owner, name: $name) { nameWithOwner
  pullRequests(states: OPEN, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) { pageInfo { hasNextPage endCursor }
    nodes { number isDraft createdAt author ${ACTOR} labels(first: 50) { nodes { name } } } } } }`;

const openPullsPayload = z.object({
  data: z
    .object({
      viewer: actor,
      repository: z
        .object({
          nameWithOwner: z.string(),
          pullRequests: z.object({
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
            nodes: z.array(z.object({ number: z.number(), isDraft: z.boolean().nullish(), createdAt: z.string().nullish(), author: actor, labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullish() })),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

/** One page as adoptable entities named the way doorbells name them, and the cursor of the next page; null when the repository is not there or not visible. */
export function parseOpenPulls(payload: unknown): { viewer: string | null; entities: AdoptableEntity[]; next: string | null } | null {
  const errors = graphqlErrors(payload);
  const parsed = openPullsPayload.safeParse(payload);
  if (!parsed.success) throw new Error(errors.length > 0 ? `GitHub: ${errors.join("; ")}` : "GitHub answered without data");
  if (errors.length > 0 && errorTypes(payload).some((t) => t !== "NOT_FOUND")) throw new Error(`GitHub: ${errors.join("; ")}`);
  const repository = parsed.data.data?.repository ?? null;
  if (repository === null) return null;
  const repo = repository.nameWithOwner;
  const page = repository.pullRequests;
  return {
    viewer: parsed.data.data?.viewer?.login ?? null,
    entities: page.nodes.map((n) => ({
      id: `${repo}#${n.number}`,
      key: `${repo}#${n.number}`,
      unit: repo,
      kind: "pull" as const,
      state: n.isDraft ? "draft" : "open",
      labels: (n.labels?.nodes ?? []).map((l) => l.name).sort(),
      author: n.author?.login ?? null,
      draft: n.isDraft === true,
      createdAt: n.createdAt ?? null,
    })),
    next: page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? null) : null,
  };
}

/** "pull request" or "issue", for prose. */
export const kindName = (kind: Target["kind"]): string => (kind === "pull" ? "pull request" : "issue");

// ---- Dependabot alerts -------------------------------------------------------------

const dependabotAlertNode = z.object({
  number: z.number(),
  state: z.string(),
  dependency: z
    .object({
      package: z.object({ ecosystem: z.string(), name: z.string() }),
      manifest_path: z.string().nullish(),
    })
    .nullish(),
  security_advisory: z.object({ ghsa_id: z.string().nullish(), severity: z.string().nullish(), summary: z.string().nullish() }).nullish(),
  security_vulnerability: z.object({ severity: z.string().nullish(), first_patched_version: z.object({ identifier: z.string() }).nullish() }).nullish(),
  html_url: z.string().nullish(),
  url: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});

/** GitHub's severity is one of the four; anything unexpected is read as low rather than thrown away. */
const severityOf = (value: string | null | undefined): DependabotSeverity => {
  const s = (value ?? "").toLowerCase();
  return (DEPENDABOT_SEVERITIES as readonly string[]).includes(s) ? (s as DependabotSeverity) : "low";
};

/**
 * One page of `GET /repos/{owner}/{repo}/dependabot/alerts`, as the shared
 * contract wants it. `repo` is the name the caller asked with; GitHub's
 * answer does not repeat it. The alert number is the repository's own alert
 * numbering, which is what the entity id and fingerprint use.
 */
export function parseDependabotAlerts(payload: unknown, repo: string): DependabotAlert[] {
  const parsed = z.array(dependabotAlertNode).safeParse(payload);
  if (!parsed.success) throw new Error("GitHub answered with something that is not a Dependabot alert list");
  return parsed.data.map((a) => ({
    id: `${repo}#${a.number}`,
    repo,
    number: a.number,
    severity: severityOf(a.security_advisory?.severity ?? a.security_vulnerability?.severity),
    package: a.dependency?.package.name ?? "(unknown)",
    ecosystem: a.dependency?.package.ecosystem ?? "unknown",
    manifestPath: a.dependency?.manifest_path ?? null,
    state: a.state,
    ghsaId: a.security_advisory?.ghsa_id ?? null,
    fixedVersion: a.security_vulnerability?.first_patched_version?.identifier ?? null,
    summary: a.security_advisory?.summary ?? null,
    url: a.html_url ?? null,
    createdAt: a.created_at ?? null,
    updatedAt: a.updated_at ?? null,
  }));
}

// ---- deployments, for stewards ----------------------------------------------------

/** The REST path for a repository's recent deployments, newest first. */
export const deploymentsPath = (repo: string, perPage = 100): string => `/repos/${repo}/deployments?per_page=${perPage}`;

/** The REST path for one deployment's statuses, newest first. */
export const deploymentStatusesPath = (repo: string, id: number, perPage = 1): string => `/repos/${repo}/deployments/${id}/statuses?per_page=${perPage}`;

const deploymentNode = z.object({
  id: z.number(),
  environment: z.string().nullish(),
  ref: z.string().nullish(),
  sha: z.string().nullish(),
  url: z.string().nullish(),
});

/**
 * The deployments GitHub returned, newest first. The list has no `state`;
 * the latest status of each carries it, read separately.
 */
export function parseDeployments(payload: unknown): Array<{ id: number; environment: string; ref: string; sha: string; url: string | null }> {
  const parsed = z.array(deploymentNode).safeParse(payload);
  if (!parsed.success) throw new Error("GitHub answered with something that is not a deployment list");
  return parsed.data.map((d) => ({ id: d.id, environment: d.environment ?? "", ref: d.ref ?? "", sha: d.sha ?? "", url: d.url ?? null })).sort((a, b) => b.id - a.id);
}

const deploymentStatusNode = z.object({
  state: z.string(),
  url: z.string().nullish(),
  log_url: z.string().nullish(),
  environment_url: z.string().nullish(),
  target_url: z.string().nullish(),
});

/**
 * The newest deployment status's state and the best link a person can open,
 * exactly as bb-gate-hooks builds a `deployment` doorbell's `url`: the
 * status's `log_url`, then `environment_url`, then `target_url`, then the
 * status's own API URL; null when it set none (the caller then falls back to
 * the deployment's API URL). "" state when no status has been reported.
 */
export function parseDeploymentStatus(payload: unknown): { state: string; url: string | null } {
  const parsed = z.array(deploymentStatusNode).safeParse(payload);
  if (!parsed.success) throw new Error("GitHub answered with something that is not a deployment status list");
  const status = parsed.data[0];
  if (status === undefined) return { state: "", url: null };
  const url = [status.log_url, status.environment_url, status.target_url, status.url].find((u): u is string => typeof u === "string" && u !== "") ?? null;
  return { state: status.state, url };
}
