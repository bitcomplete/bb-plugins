import { describe, expect, it } from "vitest";
import {
  createGhTransport,
  createGithubClient,
  createTokenTransport,
  isTransportConfigurationError,
  type GithubClient,
  type RunCommand,
} from "./github.js";

const TOKEN = "ghp_test";

interface RawNodeOverrides {
  id?: string;
  number?: unknown;
  author?: { login: string } | null;
  isDraft?: boolean;
  reviewDecision?: string | null;
  reviewRequests?: unknown;
  reviews?: unknown;
}

/** A GraphQL search node shaped the way GitHub sends it. */
function rawNode(overrides: RawNodeOverrides = {}): Record<string, unknown> {
  return {
    id: "PR_node1",
    number: 7,
    title: "Tighten the poller",
    url: "https://github.com/inkwell/folio/pull/7",
    isDraft: false,
    updatedAt: "2026-09-21T18:00:00Z",
    reviewDecision: "REVIEW_REQUIRED",
    baseRefName: "main",
    headRefName: "alice/poller",
    headRefOid: "sha-head",
    author: { login: "alice" },
    repository: { nameWithOwner: "inkwell/folio" },
    commits: { nodes: [{ commit: { committedDate: "2026-09-21T09:00:00Z" } }] },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviews: { nodes: [] },
    ...overrides,
  };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, string> };
}

/**
 * A fetch stub that answers each POST from `respond`, given the search string in
 * the request variables (or undefined for the viewer query).
 */
function stubFetch(
  respond: (search: string | undefined) => Response,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Call["body"];
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    return respond(body.variables.search);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function searchPayload(
  nodes: unknown[],
  pageInfo = { hasNextPage: false, endCursor: null as string | null },
): unknown {
  return { data: { search: { nodes, pageInfo } } };
}

/** A client on the token transport — the shape every case below shares. */
function tokenClient(fetchImpl: typeof fetch, onSkip?: (message: string) => void): GithubClient {
  return createGithubClient({ transport: createTokenTransport({ token: TOKEN, fetchImpl }), onSkip });
}

describe("viewerLogin", () => {
  it("asks GitHub once and reuses the answer, so a poll loop cannot burn rate limit on it", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ data: { viewer: { login: "reader-ada" } } }));
    const client = tokenClient(fetchImpl);
    expect(await client.viewerLogin()).toBe("reader-ada");
    expect(await client.viewerLogin()).toBe("reader-ada");
    expect(calls).toHaveLength(1);
  });

  it("authenticates as the token's user with a User-Agent GitHub accepts", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ data: { viewer: { login: "reader-ada" } } }));
    await tokenClient(fetchImpl).viewerLogin();
    expect(calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers.accept).toBe("application/vnd.github+json");
    expect(calls[0]?.headers["user-agent"]).toBeTruthy();
  });
});

describe("fetchWatchedPullRequests: failures", () => {
  it("names the token as the problem on a 401, the one failure a user can fix", async () => {
    const { fetchImpl } = stubFetch(() => new Response("Bad credentials", { status: 401 }));
    const client = tokenClient(fetchImpl);
    await expect(client.fetchWatchedPullRequests("reader-ada", "2026-09-15")).rejects.toThrow(/401.*token/is);
  });

  it("reports when the rate limit is exhausted, so the poll failure is not read as a bug", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response("rate limited", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" },
        }),
    );
    const client = tokenClient(fetchImpl);
    await expect(client.fetchWatchedPullRequests("reader-ada", "2026-09-15")).rejects.toThrow(/rate limit/i);
  });

  it("distinguishes a scope refusal from a rate limit on a 403", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response("Resource not accessible", { status: 403, headers: { "x-ratelimit-remaining": "4999" } }),
    );
    const client = tokenClient(fetchImpl);
    await expect(client.fetchWatchedPullRequests("reader-ada", "2026-09-15")).rejects.toThrow(/scope/i);
  });

  it("fails loudly on GraphQL errors in a 200, which would otherwise look like an empty queue", async () => {
    const { fetchImpl } = stubFetch(() =>
      json({ data: null, errors: [{ message: "Field 'reviewDecision' doesn't exist" }] }),
    );
    const client = tokenClient(fetchImpl);
    await expect(client.fetchWatchedPullRequests("reader-ada", "2026-09-15")).rejects.toThrow(
      /reviewDecision/,
    );
  });

  it("marks a rejected token as needing configuration but a rate limit as transient, so the poller only nags when a human must act", async () => {
    const rejected = stubFetch(() => new Response("Bad credentials", { status: 401 }));
    const limited = stubFetch(
      () => new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    );
    const configurationError = await tokenClient(rejected.fetchImpl)
      .fetchWatchedPullRequests("reader-ada", "2026-09-15")
      .catch((error: unknown) => error);
    const transientError = await tokenClient(limited.fetchImpl)
      .fetchWatchedPullRequests("reader-ada", "2026-09-15")
      .catch((error: unknown) => error);
    expect(isTransportConfigurationError(configurationError)).toBe(true);
    expect(isTransportConfigurationError(transientError)).toBe(false);
  });
});

describe("fetchWatchedPullRequests: parsing", () => {
  it("fetches every search page before returning IDs that the poller uses to remove queue rows", async () => {
    const calls: Array<Record<string, string>> = [];
    const client = createGithubClient({
      transport: async (query, variables) => {
        calls.push(variables);
        expect(query).toContain("after: $after");
        const firstPage = Array.from({ length: 50 }, (_, index) =>
          rawNode({ id: `PR_${index}`, number: index + 1 }),
        );
        const page = variables.after === undefined
          ? searchPayload(firstPage, { hasNextPage: true, endCursor: "page-2" })
          : searchPayload([rawNode({ id: "PR_50", number: 51 })]);
        return (page as { data: unknown }).data;
      },
    });
    const prs = await client.fetchWatchedPullRequests("reader-ada", "2026-09-15");
    expect(prs).toHaveLength(51);
    expect(prs.at(-1)?.nodeId).toBe("PR_50");
    expect(calls.filter((call) => call.search.includes("review-requested")).map((call) => call.after))
      .toEqual([undefined, "page-2"]);
  });

  it("rejects truncated reviewRequests so incomplete review data cannot update the queue", async () => {
    const node = rawNode({
      reviewRequests: { pageInfo: { hasNextPage: true }, nodes: [] },
    });
    const { fetchImpl } = stubFetch((search) =>
      json(searchPayload(search?.includes("review-requested") ? [node] : [])),
    );
    await expect(tokenClient(fetchImpl).fetchWatchedPullRequests("reader-ada", "2026-09-15"))
      .rejects.toThrow(/reviewRequests is truncated.*inkwell\/folio#7/);
  });

  it("rejects a repeated search cursor instead of looping or returning a partial poll", async () => {
    const { fetchImpl } = stubFetch(() =>
      json(searchPayload([], { hasNextPage: true, endCursor: "same" })),
    );
    await expect(tokenClient(fetchImpl).fetchWatchedPullRequests("reader-ada", "2026-09-15"))
      .rejects.toThrow(/search pagination returned no new cursor/);
  });

  it("skips a pull request it cannot read rather than poisoning the whole poll", async () => {
    const skips: string[] = [];
    const { fetchImpl } = stubFetch((search) =>
      search?.includes("review-requested")
        ? json(searchPayload([rawNode({ id: "PR_bad", number: "seven" }), rawNode()]))
        : json(searchPayload([])),
    );
    const client = tokenClient(fetchImpl, (m) => skips.push(m));
    const prs = await client.fetchWatchedPullRequests("reader-ada", "2026-09-15");
    expect(prs.map((pr) => pr.nodeId)).toEqual(["PR_node1"]);
    expect(skips).toHaveLength(1);
  });

  it("ignores team review requests, because review-watch only nags a person", async () => {
    const { fetchImpl } = stubFetch((search) =>
      search?.includes("review-requested")
        ? json(
            searchPayload([
              rawNode({
                reviewRequests: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    { requestedReviewer: { __typename: "Team" } },
                    { requestedReviewer: { __typename: "User", login: "reader-ada" } },
                  ],
                },
              }),
            ]),
          )
        : json(searchPayload([])),
    );
    const client = tokenClient(fetchImpl);
    const prs = await client.fetchWatchedPullRequests("reader-ada", "2026-09-15");
    expect(prs[0]?.requestedReviewers).toEqual(["reader-ada"]);
  });

  it("deduplicates a pull request returned by both searches, so it cannot queue twice", async () => {
    const { fetchImpl, calls } = stubFetch(() => json(searchPayload([rawNode()])));
    const client = tokenClient(fetchImpl);
    const prs = await client.fetchWatchedPullRequests("reader-ada", "2026-09-15");
    expect(prs).toHaveLength(1);
    const searches = calls.map((call) => call.body.variables.search);
    // No `author:` search: Workstreams owns feedback on the viewer's own pull requests.
    expect(searches).toEqual([
      "is:open is:pr review-requested:reader-ada archived:false updated:>=2026-09-15",
      "is:open is:pr reviewed-by:reader-ada archived:false updated:>=2026-09-15",
    ]);
  });

  it("includes a previously reviewed pull request without an active review request", async () => {
    const { fetchImpl } = stubFetch((search) =>
      json(searchPayload(search?.includes("reviewed-by:") ? [rawNode()] : [])),
    );
    const prs = await tokenClient(fetchImpl).fetchWatchedPullRequests("reader-ada", "2026-09-15");
    expect(prs.map((pr) => pr.nodeId)).toEqual(["PR_node1"]);
  });

  it("flattens the fields the rules need, including the head commit's own timestamp", async () => {
    const { fetchImpl } = stubFetch((search) =>
      search?.includes("reviewed-by:")
        ? json(searchPayload([richNode()]))
        : json(searchPayload([])),
    );
    const client = tokenClient(fetchImpl);
    const [pr] = await client.fetchWatchedPullRequests("reader-ada", "2026-09-15");
    expect(pr).toMatchObject({
      repo: "inkwell/folio",
      number: 7,
      author: "alice",
      headSha: "sha-head",
      headCommittedAt: "2026-09-21T09:00:00Z",
      reviewDecision: "CHANGES_REQUESTED",
      requestedReviewers: ["reader-ada"],
      myLastReview: { state: "COMMENTED", submittedAt: "2026-09-20T09:00:00Z" },
    });
  });

  it("treats an unsubmitted draft review as no review, since it has no timestamp to compare", async () => {
    const { fetchImpl } = stubFetch(() =>
      json(searchPayload([rawNode({ reviews: { nodes: [{ state: "PENDING", submittedAt: null }] } })])),
    );
    const client = tokenClient(fetchImpl);
    const [pr] = await client.fetchWatchedPullRequests("reader-ada", "2026-09-15");
    expect(pr?.myLastReview).toBeNull();
  });

  it("keeps the latest submitted review when a newer draft review is pending", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      json(searchPayload([rawNode({ reviews: { nodes: [
        { state: "COMMENTED", submittedAt: "2026-09-20T09:00:00Z" },
        { state: "PENDING", submittedAt: null },
      ] } })])),
    );
    const [pr] = await tokenClient(fetchImpl).fetchWatchedPullRequests("reader-ada", "2026-09-15");
    expect(pr?.myLastReview).toEqual({ state: "COMMENTED", submittedAt: "2026-09-20T09:00:00Z" });
    expect(calls[0]?.body.query).toContain("reviews(author: $login, last: 10)");
  });

  it("skips non-pull-request search rows, which the ISSUE search type can return", async () => {
    const skips: string[] = [];
    const { fetchImpl } = stubFetch((search) =>
      search?.includes("review-requested")
        ? json(searchPayload([{}, null, rawNode()]))
        : json(searchPayload([])),
    );
    const client = tokenClient(fetchImpl, (m) => skips.push(m));
    const prs = await client.fetchWatchedPullRequests("reader-ada", "2026-09-15");
    expect(prs).toHaveLength(1);
    expect(skips).toEqual([]);
  });
});

describe("fetchOpenNodeIds", () => {
  it("reads only node ID and state for retained rows, keeping open PRs without fetching review details", async () => {
    const queries: string[] = [];
    const client = createGithubClient({ transport: async (query) => {
      queries.push(query);
      return { nodes: [
        { id: "PR_open", state: "OPEN" },
        { id: "PR_closed", state: "CLOSED" },
        { id: "PR_merged", state: "MERGED" },
      ] };
    } });

    expect(await client.fetchOpenNodeIds(["PR_open", "PR_closed", "PR_merged"]))
      .toEqual(new Set(["PR_open"]));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('nodes(ids: ["PR_open","PR_closed","PR_merged"])');
    expect(queries[0]).toContain("... on PullRequest { id state }");
    expect(queries[0]).not.toContain("reviewRequests");
  });

  it("propagates a failed state lookup so the poller cannot discard retained rows", async () => {
    const client = createGithubClient({ transport: async () => {
      throw new Error("state lookup failed");
    } });
    await expect(client.fetchOpenNodeIds(["PR_open"]))
      .rejects.toThrow("state lookup failed");
  });

  it("rejects an unreadable node instead of treating it as closed", async () => {
    const client = createGithubClient({ transport: async () => ({ nodes: [null] }) });
    await expect(client.fetchOpenNodeIds(["PR_unreadable"]))
      .rejects.toThrow("cannot safely update the queue");
  });
});

describe("fetchRetainedPullRequests", () => {
  it("reads review details only for retained started rows and excludes closed PRs", async () => {
    const queries: string[] = [];
    const client = createGithubClient({ transport: async (query) => {
      queries.push(query);
      return { nodes: [
        { ...rawNode({ reviews: { nodes: [{ state: "APPROVED", submittedAt: "2026-09-22T13:00:00Z" }] } }), state: "OPEN" },
        { id: "PR_closed", state: "CLOSED" },
      ] };
    } });
    const result = await client.fetchRetainedPullRequests(["PR_node1", "PR_closed"], "reader-ada");
    expect(result.openNodeIds).toEqual(new Set(["PR_node1"]));
    expect(result.pullRequests[0]?.myLastReview?.submittedAt).toBe("2026-09-22T13:00:00Z");
    expect(queries[0]).toContain("reviews(author: $login, last: 10)");
  });
});

// --- The gh transport ------------------------------------------------------
//
// review-watch must work on a cloud bb server with a token and on a laptop with
// nothing but a gh login. The cases below hold the second half of that promise:
// the same queue, and failures that name their own fix.

/** A node exercising every field the rules read, for cross-transport comparison. */
function richNode(): Record<string, unknown> {
  return rawNode({
    reviewDecision: "CHANGES_REQUESTED",
    reviews: { nodes: [{ state: "COMMENTED", submittedAt: "2026-09-20T09:00:00Z" }] },
    reviewRequests: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { requestedReviewer: { __typename: "Team" } },
        { requestedReviewer: { __typename: "User", login: "reader-ada" } },
      ],
    },
  });
}

interface RunCall {
  file: string;
  args: string[];
}

/** The variables `gh api graphql` was given, read back out of its `-f` pairs. */
function ghVariables(args: string[]): Record<string, string> {
  const variables: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-f") continue;
    const pair = args[index + 1] ?? "";
    const split = pair.indexOf("=");
    variables[pair.slice(0, split)] = pair.slice(split + 1);
  }
  return variables;
}

interface RunStubOptions {
  /** Candidates whose `--version` probe succeeds; the rest behave as missing. */
  installed?: string[];
  /** Answers `gh api graphql`, given the search variable (undefined for viewer). */
  api?: (search: string | undefined) => string;
  /** When set, `gh api graphql` fails with this message and body instead. */
  apiFailure?: { message: string; stdout?: string };
}

function stubRun(options: RunStubOptions): { run: RunCommand; calls: RunCall[] } {
  const installed = options.installed ?? ["gh"];
  const calls: RunCall[] = [];
  const run: RunCommand = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === "--version") {
      // What a shell reports for a binary that is not there.
      if (!installed.includes(file)) throw new Error(`spawn ${file} ENOENT`);
      return { stdout: "gh version 2.98.0\n", stderr: "" };
    }
    if (options.apiFailure !== undefined) {
      // The default RunCommand attaches the captured output to the rejection,
      // because gh prints the response body before exiting non-zero.
      throw Object.assign(new Error(options.apiFailure.message), {
        stdout: options.apiFailure.stdout ?? "",
        stderr: options.apiFailure.message,
      });
    }
    const respond = options.api ?? (() => JSON.stringify(searchPayload([])));
    return { stdout: respond(ghVariables(args).search), stderr: "" };
  };
  return { run, calls };
}

describe("createGhTransport: locating gh", () => {
  it("finds gh at a Homebrew path when the daemon's PATH does not have it, which is the whole point of the fallback", async () => {
    const { run, calls } = stubRun({ installed: ["/opt/homebrew/bin/gh"] });
    const transport = createGhTransport({ run });
    const client = createGithubClient({ transport });
    await client.fetchWatchedPullRequests("reader-ada", "2026-09-15");
    expect(calls.filter((call) => call.args[0] === "--version").map((call) => call.file)).toEqual([
      "gh",
      "/opt/homebrew/bin/gh",
    ]);
    expect(transport.resolvedPath()).toBe("/opt/homebrew/bin/gh");
  });

  it("probes for gh once across repeated polls, so every request does not pay for a subprocess", async () => {
    const { run, calls } = stubRun({ installed: ["gh"] });
    const client = createGithubClient({ transport: createGhTransport({ run }) });
    await client.fetchWatchedPullRequests("reader-ada", "2026-09-15");
    await client.fetchWatchedPullRequests("reader-ada", "2026-09-15");
    expect(calls.filter((call) => call.args[0] === "--version")).toHaveLength(1);
    // Two searches per poll were still made; only the probe was cached.
    expect(calls.filter((call) => call.args[0] === "api")).toHaveLength(4);
  });

  it("tells the user gh is missing and that a token would do instead, rather than failing anonymously", async () => {
    const { run } = stubRun({ installed: [] });
    const client = createGithubClient({ transport: createGhTransport({ run }) });
    const error = await client.viewerLogin().catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/gh.*not installed/is);
    expect((error as Error).message).toMatch(/githubToken/);
    expect(isTransportConfigurationError(error)).toBe(true);
  });

  // Every wording gh 2.98.0 actually produces for "no usable credential". Each
  // row is here because it is the only one of these a single detection pattern
  // catches, so dropping a pattern fails a row rather than passing quietly.
  const ghAuthFailures = [
    {
      when: "gh has no credential stored at all",
      stderr:
        "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.",
    },
    {
      when: "the stored credential has gone stale",
      stderr:
        "gh: The token in keyring is invalid. To re-authenticate, run: gh auth refresh -h github.com",
    },
    { when: "GitHub rejects the token gh sent", stderr: "gh: Bad credentials" },
    {
      when: "gh relays a bare 401 with no message body",
      stderr: "gh: HTTP 401 (https://api.github.com/graphql)",
    },
  ];

  it.each(ghAuthFailures)(
    "asks the user to log in when $when, the failure a keychain-less daemon hits most",
    async ({ stderr }) => {
      const { run } = stubRun({ installed: ["gh"], apiFailure: { message: stderr } });
      const client = createGithubClient({ transport: createGhTransport({ run }) });
      const error = await client.viewerLogin().catch((caught: unknown) => caught);
      expect((error as Error).message).toMatch(/not authenticated/i);
      // The message must carry the fix, since a daemon's keychain is not the
      // one the user just logged into.
      expect((error as Error).message).toMatch(/gh auth login/);
      expect((error as Error).message).toMatch(/gh auth refresh -h github\.com/);
      expect((error as Error).message).toMatch(/githubToken/);
      expect(isTransportConfigurationError(error)).toBe(true);
    },
  );
});

describe("the two transports are interchangeable", () => {
  it("flattens a gh api graphql payload into exactly the pull request fetch produces, so switching transports cannot change the queue", async () => {
    const payload = JSON.stringify(searchPayload([richNode()]));
    const { fetchImpl } = stubFetch((search) =>
      search?.includes("reviewed-by:") ? new Response(payload) : json(searchPayload([])),
    );
    const { run } = stubRun({
      installed: ["gh"],
      api: (search) =>
        search?.includes("reviewed-by:") ? payload : JSON.stringify(searchPayload([])),
    });

    const viaToken = await tokenClient(fetchImpl).fetchWatchedPullRequests("reader-ada", "2026-09-15");
    const viaGh = await createGithubClient({
      transport: createGhTransport({ run }),
    }).fetchWatchedPullRequests("reader-ada", "2026-09-15");

    expect(viaGh).toEqual(viaToken);
    // Not vacuously equal: this is the fully populated node, not an empty result.
    expect(viaGh).toHaveLength(1);
    expect(viaGh[0]?.requestedReviewers).toEqual(["reader-ada"]);
    expect(viaGh[0]?.myLastReview).toEqual({ state: "COMMENTED", submittedAt: "2026-09-20T09:00:00Z" });
  });

  it("passes the query and its variables to gh as string fields, which is how gh forwards GraphQL variables", async () => {
    const { run, calls } = stubRun({ installed: ["gh"] });
    await createGithubClient({ transport: createGhTransport({ run }) }).viewerLogin().catch(() => {});
    const apiCall = calls.find((call) => call.args[0] === "api");
    expect(apiCall?.args.slice(0, 2)).toEqual(["api", "graphql"]);
    const variables = ghVariables(apiCall?.args ?? []);
    expect(variables.query).toContain("query Viewer");
  });

  it("reports a GraphQL error identically from gh and from fetch, so one transport cannot hide a broken query", async () => {
    const errorBody = JSON.stringify({
      data: null,
      errors: [{ message: "Field 'reviewDecision' doesn't exist" }],
    });
    const { fetchImpl } = stubFetch(() => new Response(errorBody));
    // gh prints the body and then exits 1, so the shared check must be reachable
    // from the failure path as well as the success path.
    const failing = stubRun({
      installed: ["gh"],
      apiFailure: { message: "gh: Field 'reviewDecision' doesn't exist", stdout: errorBody },
    });
    // Some responses arrive as a plain exit-0 body with errors inside.
    const quiet = stubRun({ installed: ["gh"], api: () => errorBody });

    const fromToken = await tokenClient(fetchImpl)
      .fetchWatchedPullRequests("reader-ada", "2026-09-15")
      .catch((error: unknown) => (error as Error).message);
    const fromGh = await createGithubClient({ transport: createGhTransport({ run: failing.run }) })
      .fetchWatchedPullRequests("reader-ada", "2026-09-15")
      .catch((error: unknown) => (error as Error).message);
    const fromQuietGh = await createGithubClient({ transport: createGhTransport({ run: quiet.run }) })
      .fetchWatchedPullRequests("reader-ada", "2026-09-15")
      .catch((error: unknown) => (error as Error).message);

    expect(fromToken).toMatch(/GitHub GraphQL error: Field 'reviewDecision'/);
    expect(fromGh).toBe(fromToken);
    expect(fromQuietGh).toBe(fromToken);
  });

  it("skips an unreadable pull request over gh too, keeping the rest of the poll usable", async () => {
    const skips: string[] = [];
    const { run } = stubRun({
      installed: ["gh"],
      api: (search) =>
        search?.includes("review-requested")
          ? JSON.stringify(searchPayload([rawNode({ id: "PR_bad", number: "seven" }), rawNode()]))
          : JSON.stringify(searchPayload([])),
    });
    const client = createGithubClient({
      transport: createGhTransport({ run }),
      onSkip: (message) => skips.push(message),
    });
    const prs = await client.fetchWatchedPullRequests("reader-ada", "2026-09-15");
    expect(prs.map((pr) => pr.nodeId)).toEqual(["PR_node1"]);
    expect(skips).toHaveLength(1);
  });
});
