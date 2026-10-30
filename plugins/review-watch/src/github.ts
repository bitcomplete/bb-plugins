// The GitHub half of review-watch: two searches over the GraphQL API, flattened
// into the `PullRequest` shape the rest of the plugin speaks.
//
// Only the *transport* — one GraphQL round trip — comes in two flavours: a
// personal access token over `fetch`, for a bb server on a cloud VM with no gh
// login, and `gh api graphql`, so a local server can reuse an existing gh
// session. The queries, the flattening, and the `types.ts` parsing below are
// single-path on purpose: a second copy of the parsing is how the two paths
// would silently drift apart.
import { execFile } from "node:child_process";
import { z } from "zod";
import { pullRequestSchema, type PullRequest } from "./types.js";

const GRAPHQL_URL = "https://api.github.com/graphql";
const USER_AGENT = "bb-plugin-review-watch";

/** Number of search results requested per GraphQL round trip. */
const SEARCH_PAGE_SIZE = 50;

/** One GraphQL round trip. Returns the parsed `data` object, or throws. */
export type GraphqlTransport = (
  query: string,
  variables: Record<string, string>,
) => Promise<unknown>;

/**
 * Shells out; injected in tests. Rejects on a non-zero exit, with the captured
 * `stdout` and `stderr` attached to the rejected error — `gh api graphql` prints
 * the response body and *then* exits 1 when that body carries GraphQL errors, so
 * throwing the output away would cost us the only useful diagnostic.
 */
export type RunCommand = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * A failure the user must fix before polling can ever work: no `gh`, no gh
 * login, a rejected or under-scoped token. `server.ts` routes these to
 * `bb.status.needsConfiguration` and keeps merely transient failures (rate
 * limits, outages) as warnings, so the marker is a type rather than a message
 * the caller has to pattern-match.
 */
export class TransportConfigurationError extends Error {
  override readonly name = "TransportConfigurationError";
}

export function isTransportConfigurationError(
  error: unknown,
): error is TransportConfigurationError {
  return error instanceof TransportConfigurationError;
}

export interface GithubClient {
  /** The authenticated user's login, cached for the client's lifetime. */
  viewerLogin(): Promise<string>;
  /**
   * Every open pull request that could need a review from `login`: ones where
   * they are a requested reviewer and ones they reviewed. Deduplicated by nodeId.
   */
  fetchWatchedPullRequests(login: string, updatedSince: string): Promise<PullRequest[]>;
  /** Open pull request node IDs from stored rows absent from the fresh searches. */
  fetchOpenNodeIds(ids: string[]): Promise<Set<string>>;
  /** Full details for started rows outside date-limited searches. */
  fetchRetainedPullRequests(ids: string[], login: string): Promise<{ openNodeIds: Set<string>; pullRequests: PullRequest[] }>;
}

/**
 * A pull request whose shape we cannot read is skipped rather than failing the
 * whole poll, and reported here. A logger callback (rather than a second return
 * channel) keeps `fetchWatchedPullRequests` returning a plain array, so every
 * caller that does not care about diagnostics ignores them by omission.
 */
type SkipLogger = (message: string) => void;

const PR_FIELDS = `
  id
  number
  title
  url
  isDraft
  updatedAt
  reviewDecision
  baseRefName
  headRefName
  headRefOid
  author { login }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { committedDate } } }
  reviewRequests(first: 50) {
    pageInfo { hasNextPage }
    nodes { requestedReviewer { __typename ... on User { login } } }
  }
  reviews(author: $login, last: 10) { nodes { state submittedAt } }
`;

const SEARCH_QUERY = `
query WatchedPullRequests($search: String!, $login: String!, $after: String) {
  search(query: $search, type: ISSUE, first: ${SEARCH_PAGE_SIZE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

const VIEWER_QUERY = `query Viewer { viewer { login } }`;
const NODE_BATCH_SIZE = 100;

/** The GraphQL node as GitHub sends it, before `types.ts` has its say. */
const searchNodeSchema = z
  .object({
    id: z.string(),
    number: z.number(),
    title: z.string(),
    url: z.string(),
    isDraft: z.boolean(),
    updatedAt: z.string(),
    reviewDecision: z.string().nullable(),
    baseRefName: z.string(),
    headRefName: z.string(),
    headRefOid: z.string(),
    // Null for a deleted ("ghost") account; such a pull request is unreadable
    // for our purposes and gets skipped by the pipe below.
    author: z.object({ login: z.string() }).nullable(),
    repository: z.object({ nameWithOwner: z.string() }),
    commits: z.object({
      nodes: z.array(z.object({ commit: z.object({ committedDate: z.string() }) })),
    }),
    reviewRequests: z.object({
      pageInfo: z.object({ hasNextPage: z.boolean() }),
      nodes: z.array(
        z.object({
          requestedReviewer: z
            .object({ __typename: z.string(), login: z.string().optional() })
            .nullable(),
        }),
      ),
    }),
    reviews: z.object({
      nodes: z.array(z.object({ state: z.string(), submittedAt: z.string().nullable() })),
    }),
  });

/**
 * Flatten a node into the shape `pullRequestSchema` describes. The result is
 * parsed by that schema rather than trusted, so `src/types.ts` stays the single
 * authority on what a valid pull request is.
 */
function flatten(node: z.infer<typeof searchNodeSchema>): unknown {
  return {
    nodeId: node.id,
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    author: node.author?.login,
    isDraft: node.isDraft,
    baseBranch: node.baseRefName,
    headBranch: node.headRefName,
    headSha: node.headRefOid,
    headCommittedAt: node.commits.nodes[0]?.commit.committedDate,
    updatedAt: node.updatedAt,
    reviewDecision: node.reviewDecision,
    // Team review requests carry no login; review-watch only nags a person.
    requestedReviewers: node.reviewRequests.nodes
      .map((request) => request.requestedReviewer?.login)
      .filter((login): login is string => login !== undefined),
    // Ignore an unsubmitted draft while retaining the latest submitted review.
    myLastReview: node.reviews.nodes
      .filter((review): review is { state: string; submittedAt: string } => review.submittedAt !== null)
      .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))[0] ?? null,
  };
}

/** A node we can use, or the reason we are skipping it. */
function parseSearchNode(node: unknown): { pullRequest: PullRequest } | { error: string } {
  const raw = searchNodeSchema.safeParse(node);
  if (!raw.success) return { error: raw.error.message };
  if (raw.data.reviewRequests.pageInfo.hasNextPage) {
    throw new Error(`GitHub reviewRequests is truncated for ${raw.data.repository.nameWithOwner}#${raw.data.number}; the poll cannot safely update the queue.`);
  }
  const parsed = pullRequestSchema.safeParse(flatten(raw.data));
  if (!parsed.success) return { error: parsed.error.message };
  return { pullRequest: parsed.data };
}

const graphqlResponseSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const viewerDataSchema = z.object({ viewer: z.object({ login: z.string() }) });
const searchDataSchema = z.object({
  search: z.object({
    nodes: z.array(z.unknown().nullable()),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }),
});
const nodesDataSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), state: z.enum(["OPEN", "CLOSED", "MERGED"]) }).nullable()),
});

/**
 * The one place a GraphQL response body becomes `data`. Both transports funnel
 * through it, so a query-level failure reads the same whether it arrived over
 * `fetch` or over `gh`.
 */
function unwrapGraphqlBody(text: string): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`GitHub returned a 200 that is not JSON: ${text.slice(0, 200)}`);
  }
  const parsed = graphqlResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`GitHub returned an unrecognised GraphQL envelope: ${parsed.error.message}`);
  }
  // GraphQL reports query-level failures (bad scope, missing repo) in a 200.
  if (parsed.data.errors !== undefined && parsed.data.errors.length > 0) {
    throw new Error(
      `GitHub GraphQL error: ${parsed.data.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return parsed.data.data;
}

/** Turn a failed HTTP status into a message that tells a human what to do. */
function httpError(response: Response, body: string): Error {
  if (response.status === 401) {
    return new TransportConfigurationError(
      "GitHub rejected the token (401 Unauthorized). Set a valid personal access token with `repo` and `read:user` scope.",
    );
  }
  if (response.status === 403) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (remaining === "0") {
      // A rate limit heals on its own, so it is a warning rather than something
      // the user is asked to reconfigure.
      const resetAt = reset === null ? "shortly" : new Date(Number(reset) * 1000).toISOString();
      return new Error(`GitHub rate limit exhausted; it resets at ${resetAt}.`);
    }
    return new TransportConfigurationError(
      `GitHub refused the request (403 Forbidden): ${body.slice(0, 200)}. The token may lack scope for these repositories.`,
    );
  }
  return new Error(`GitHub returned ${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
}

export function createTokenTransport(options: {
  token: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}): GraphqlTransport {
  const fetchImpl = options.fetchImpl ?? fetch;

  // No retries: the poller runs again in minutes, and a retry here would only
  // stack more requests against a rate limit we may already have hit.
  return async (query, variables) => {
    const response = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await response.text();
    if (!response.ok) throw httpError(response, text);
    return unwrapGraphqlBody(text);
  };
}

/** Where `gh` lives when the daemon's PATH is not an interactive shell's. */
const GH_CANDIDATES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];

const GH_PROBE_TIMEOUT_MS = 5_000;
const GH_API_TIMEOUT_MS = 30_000;
/** A 50-result search can be large; 16 MiB is bb's own ceiling. */
const GH_MAX_BUFFER = 16 * 1024 * 1024;

const TOKEN_ALTERNATIVE = "Or set the `githubToken` setting to a personal access token instead.";
const GH_AUTH_FIX =
  "Run `gh auth login`, or `gh auth refresh -h github.com` if a stored token has gone stale. " +
  "Note that bb runs as a daemon, so it may not see a keychain the interactive shell can.";

/**
 * gh has no dedicated exit code for "not authenticated" — every failure is exit
 * 1 — so we match what it actually prints, verified against gh 2.98.0. Matched
 * against stderr and the failure message only, never the response body, so a
 * pull request that merely mentions "401" cannot be read as an auth failure.
 */
const GH_UNAUTHENTICATED_PATTERNS = [
  // "please run: gh auth login" (no credential) and "run: gh auth refresh -h
  // github.com" (a stored credential GitHub no longer accepts).
  /gh auth (login|refresh)/i,
  // GitHub's own wording, relayed by gh when it did send a token.
  /bad credentials/i,
  // The bare status, for a 401 whose body gh could not pull a message out of.
  /HTTP 401|401 Unauthorized/i,
];

interface CommandOutput {
  stdout: string;
  stderr: string;
}

/** `execFile`'s error carries no output, so the default `RunCommand` attaches it. */
function commandFailure(message: string, output: CommandOutput): Error {
  return Object.assign(new Error(message), output);
}

function failureOutput(error: unknown): CommandOutput {
  const carrier = error as Partial<CommandOutput> | null;
  return {
    stdout: typeof carrier?.stdout === "string" ? carrier.stdout : "",
    stderr: typeof carrier?.stderr === "string" ? carrier.stderr : "",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runCommand(file: string, args: string[], timeoutMs: number): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: GH_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            commandFailure(`${file} ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || error.message}`, {
              stdout,
              stderr,
            }),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/**
 * A transport with the resolved binary path exposed, so `bb review-watch status`
 * can report which `gh` the poller settled on without probing again itself.
 */
export type GhTransport = GraphqlTransport & {
  /** The winning candidate, or undefined until the first probe succeeds. */
  resolvedPath(): string | undefined;
};

/**
 * Resolves the `gh` binary on first use and reuses it thereafter. Throws an
 * error naming the fix when `gh` is missing or not authenticated.
 */
export function createGhTransport(options?: {
  run?: RunCommand;
  /** Probe order; defaults to the candidates below. */
  candidates?: string[];
}): GhTransport {
  const run: RunCommand =
    options?.run ?? ((file, args) => runCommand(file, args, GH_API_TIMEOUT_MS));
  const probeRun: RunCommand =
    options?.run ?? ((file, args) => runCommand(file, args, GH_PROBE_TIMEOUT_MS));
  const candidates = options?.candidates ?? GH_CANDIDATES;

  let resolved: string | undefined;
  // The two searches fire in parallel, so an in-flight probe is shared rather
  // than run twice. Only a success is cached: a gh installed a minute from now
  // should be found then.
  let probe: Promise<string> | undefined;

  async function probeCandidates(): Promise<string> {
    for (const candidate of candidates) {
      try {
        await probeRun(candidate, ["--version"]);
        return candidate;
      } catch {
        // Not this one; a missing binary and an unusable one are both "next".
      }
    }
    throw new TransportConfigurationError(
      `The GitHub CLI (gh) is not installed, or not on the bb server's PATH: tried ${candidates.join(", ")}. ${TOKEN_ALTERNATIVE}`,
    );
  }

  async function resolveGh(): Promise<string> {
    if (resolved !== undefined) return resolved;
    probe ??= probeCandidates()
      .then((file) => {
        resolved = file;
        return file;
      })
      .finally(() => {
        probe = undefined;
      });
    return probe;
  }

  function ghFailure(error: unknown): Error {
    const { stdout, stderr } = failureOutput(error);
    const diagnostics = `${stderr}\n${errorMessage(error)}`;
    if (GH_UNAUTHENTICATED_PATTERNS.some((pattern) => pattern.test(diagnostics))) {
      return new TransportConfigurationError(
        `The GitHub CLI (gh) is not authenticated for github.com. ${GH_AUTH_FIX} ${TOKEN_ALTERNATIVE}`,
      );
    }
    // gh prints the response body before exiting 1, so a GraphQL-level failure
    // still reaches the shared check and reads exactly as it would over fetch.
    if (stdout.trim() !== "") {
      try {
        unwrapGraphqlBody(stdout);
      } catch (bodyError) {
        return bodyError instanceof Error ? bodyError : new Error(String(bodyError));
      }
    }
    return new Error(`gh api graphql failed: ${errorMessage(error)}`);
  }

  return Object.assign(
    async (query: string, variables: Record<string, string>): Promise<unknown> => {
      const file = await resolveGh();
      // `gh api graphql` reads every field but `query` and `operationName` as a
      // GraphQL variable, and `-f` keeps each value a plain string — which is all
      // this plugin's variables ever are. (`-F` would coerce "7" to a number.)
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        ...Object.entries(variables).flatMap(([name, value]) => ["-f", `${name}=${value}`]),
      ];
      let stdout: string;
      try {
        ({ stdout } = await run(file, args));
      } catch (error) {
        throw ghFailure(error);
      }
      return unwrapGraphqlBody(stdout);
    },
    {
      resolvedPath: (): string | undefined => resolved,
    },
  );
}

export function createGithubClient(options: {
  transport: GraphqlTransport;
  /** Called once per pull request skipped because its shape did not parse. */
  onSkip?: SkipLogger;
}): GithubClient {
  const graphql = options.transport;
  const onSkip: SkipLogger = options.onSkip ?? (() => {});
  let cachedLogin: string | undefined;

  async function search(searchQuery: string, login: string): Promise<PullRequest[]> {
    const pullRequests: PullRequest[] = [];
    let after = "";
    const seenCursors = new Set<string>();
    while (true) {
      const variables = { search: searchQuery, login, ...(after ? { after } : {}) };
      const data = searchDataSchema.parse(await graphql(SEARCH_QUERY, variables));
      for (const node of data.search.nodes) {
        // `type: ISSUE` can return non-pull-request rows as empty selections.
        if (node === null || (typeof node === "object" && Object.keys(node).length === 0)) continue;
        const parsed = parseSearchNode(node);
        if ("error" in parsed) {
          onSkip(`skipped a search result from \`${searchQuery}\`: ${parsed.error}`);
          continue;
        }
        pullRequests.push(parsed.pullRequest);
      }
      if (!data.search.pageInfo.hasNextPage) break;
      const cursor = data.search.pageInfo.endCursor;
      if (cursor === null || seenCursors.has(cursor)) {
        throw new Error(`GitHub search pagination returned no new cursor for \`${searchQuery}\`; the poll cannot safely update the queue.`);
      }
      seenCursors.add(cursor);
      after = cursor;
    }
    return pullRequests;
  }

  return {
    async viewerLogin(): Promise<string> {
      if (cachedLogin !== undefined) return cachedLogin;
      const data = viewerDataSchema.parse(await graphql(VIEWER_QUERY, {}));
      cachedLogin = data.viewer.login;
      return cachedLogin;
    },

    async fetchWatchedPullRequests(login: string, updatedSince: string): Promise<PullRequest[]> {
      const cutoff = ` updated:>=${updatedSince}`;
      const [requested, reviewed] = await Promise.all([
        search(`is:open is:pr review-requested:${login} archived:false${cutoff}`, login),
        search(`is:open is:pr reviewed-by:${login} archived:false${cutoff}`, login),
      ]);
      const byNodeId = new Map<string, PullRequest>();
      for (const pullRequest of [...requested, ...reviewed]) {
        byNodeId.set(pullRequest.nodeId, pullRequest);
      }
      return [...byNodeId.values()];
    },

    async fetchOpenNodeIds(ids: string[]): Promise<Set<string>> {
      const open = new Set<string>();
      for (let index = 0; index < ids.length; index += NODE_BATCH_SIZE) {
        const batch = ids.slice(index, index + NODE_BATCH_SIZE);
        const query = `query RetainedPullRequestStates { nodes(ids: ${JSON.stringify(batch)}) { ... on PullRequest { id state } } }`;
        const data = nodesDataSchema.parse(await graphql(query, {}));
        if (data.nodes.length !== batch.length) {
          throw new Error("GitHub returned an incomplete retained pull request state lookup.");
        }
        for (const [offset, node] of data.nodes.entries()) {
          if (node === null || node.id !== batch[offset]) {
            throw new Error("GitHub returned an unknown retained pull request state; the poll cannot safely update the queue.");
          }
          if (node.state === "OPEN") open.add(node.id);
        }
      }
      return open;
    },

    async fetchRetainedPullRequests(ids: string[], login: string): Promise<{ openNodeIds: Set<string>; pullRequests: PullRequest[] }> {
      const openNodeIds = new Set<string>();
      const pullRequests: PullRequest[] = [];
      for (let index = 0; index < ids.length; index += NODE_BATCH_SIZE) {
        const batch = ids.slice(index, index + NODE_BATCH_SIZE);
        const query = `query RetainedPullRequestDetails($login: String!) { nodes(ids: ${JSON.stringify(batch)}) { ... on PullRequest { state ${PR_FIELDS} } } }`;
        const data = z.object({ nodes: z.array(z.unknown().nullable()) }).parse(await graphql(query, { login }));
        if (data.nodes.length !== batch.length) {
          throw new Error("GitHub returned an incomplete retained pull request detail lookup.");
        }
        for (const [offset, node] of data.nodes.entries()) {
          const state = z.object({ id: z.string(), state: z.enum(["OPEN", "CLOSED", "MERGED"]) }).safeParse(node);
          if (!state.success || state.data.id !== batch[offset]) {
            throw new Error("GitHub returned an unknown retained pull request; the poll cannot safely update the queue.");
          }
          if (state.data.state !== "OPEN") continue;
          const parsed = parseSearchNode(node);
          if ("error" in parsed) {
            throw new Error(`GitHub returned an unreadable retained pull request: ${parsed.error}`);
          }
          openNodeIds.add(state.data.id);
          pullRequests.push(parsed.pullRequest);
        }
      }
      return { openNodeIds, pullRequests };
    },
  };
}
