// GitHub's GraphQL API: how a pull request or issue is named, the one
// document the watch sends, and what comes back. Pure: the function that
// talks to the network takes its fetch as an argument, and no token appears
// in anything this module returns or throws.
import { z } from "zod";

export const GITHUB_URL = "https://github.com";
export const GITHUB_API_URL = "https://api.github.com";
export const GRAPHQL_PATH = "/graphql";

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
const COMMENT_FIELDS = `author ${ACTOR} body createdAt url`;
const COMMON_FIELDS = `number title url createdAt updatedAt author ${ACTOR} assignees(first: 20) { nodes { login } } labels(first: 50) { nodes { name } } milestone { title } comments(last: 50) { nodes { ${COMMENT_FIELDS} } }`;

/** One read of a pull request or issue: everything a watch compares, and the newest comments and reviews. */
export const TARGET_QUERY = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { nameWithOwner issueOrPullRequest(number: $number) { __typename
  ... on Issue { ${COMMON_FIELDS} state stateReason }
  ... on PullRequest { ${COMMON_FIELDS} state isDraft merged reviewDecision headRefName headRefOid baseRefName
    reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } } }
    latestReviews(first: 50) { nodes { author ${ACTOR} state } }
    reviews(last: 50) { nodes { author ${ACTOR} state body createdAt submittedAt url comments(first: 50) { nodes { ${COMMENT_FIELDS} path } } } }
    commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } } } } } } }`;

const actor = z.object({ login: z.string() }).nullish();
const commentNode = z.object({ author: actor, body: z.string().nullish(), createdAt: z.string(), url: z.string().nullish(), path: z.string().nullish() });
const reviewNode = z.object({
  author: actor,
  state: z.string(),
  body: z.string().nullish(),
  createdAt: z.string(),
  submittedAt: z.string().nullish(),
  url: z.string().nullish(),
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
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ oid: z.string(), statusCheckRollup: z.object({ state: z.string(), contexts: z.object({ nodes: z.array(contextNode) }).nullish() }).nullish() }) })) }).nullish(),
});
const targetPayload = z.object({
  data: z.object({ repository: z.object({ nameWithOwner: z.string(), issueOrPullRequest: z.discriminatedUnion("__typename", [issueNode, pullNode]).nullable() }).nullable() }).nullable(),
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

/** The target, or null when the repository or the number is not there (or not visible). Anything else throws. */
export function parseTarget(payload: unknown): Target | null {
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
  const node = repository.issueOrPullRequest;
  const comments: Comment[] = (node.comments?.nodes ?? []).map((c) => ({ author: c.author?.login ?? "someone", did: "commented", body: c.body ?? "", createdAt: c.createdAt, url: c.url ?? null }));
  const base: Omit<Target, "kind" | "state" | "pull"> = {
    repo: repository.nameWithOwner,
    number: node.number,
    key: `${repository.nameWithOwner}#${node.number}`,
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
    return { ...base, kind: "issue", state, pull: null, comments: sortComments(comments) };
  }
  for (const r of node.reviews?.nodes ?? []) {
    // The viewer's own unsubmitted review is PENDING and not news.
    if (r.state === "PENDING") continue;
    const author = r.author?.login ?? "someone";
    const at = r.submittedAt ?? r.createdAt;
    const body = (r.body ?? "").trim();
    // An approval or a request for changes is an event even without words;
    // a review that only carries inline comments is told by those.
    if (body !== "" || (r.state !== "COMMENTED" && r.state !== "DISMISSED")) comments.push({ author, did: REVIEW_VERBS[r.state] ?? lower(r.state) ?? "reviewed", body, createdAt: at, url: r.url ?? null });
    for (const c of r.comments?.nodes ?? []) {
      comments.push({ author: c.author?.login ?? author, did: c.path ? `commented on ${c.path}` : "commented", body: c.body ?? "", createdAt: c.createdAt, url: c.url ?? null });
    }
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
    comments: sortComments(comments),
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

const sortComments = (comments: Comment[]): Comment[] => [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** "pull request" or "issue", for prose. */
export const kindName = (kind: Target["kind"]): string => (kind === "pull" ? "pull request" : "issue");
