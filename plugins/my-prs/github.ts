import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { feedbackOf } from "./feedback.js";
import { statusSchema, type PullRequest } from "./types.js";

const run = promisify(execFile);
export type Transport = (query: string, variables: Record<string, string>, signal?: AbortSignal) => Promise<unknown>;
const envelope = z.object({ data: z.unknown().optional(), message: z.string().optional(), errors: z.array(z.object({ message: z.string() })).optional() });

export class GithubRateLimitError extends Error {
  constructor(readonly retryAt: string) {
    super(`GitHub's API allowance is temporarily exhausted. Try again after ${new Date(retryAt).toUTCString()}. Your PR snapshot was kept.`);
  }
}

function responseData(body: unknown, headers: Headers, status: number): unknown {
  const parsed = envelope.parse(body);
  const error = parsed.errors?.map((error) => error.message).join("; ") || (status >= 400 ? parsed.message : undefined);
  if ((status >= 400 && headers.get("x-ratelimit-remaining") === "0") || (error && /rate limit/i.test(error)) || headers.has("retry-after")) {
    const reset = Number(headers.get("x-ratelimit-reset")) * 1000;
    const delay = Number(headers.get("retry-after")) * 1000;
    throw new GithubRateLimitError(new Date(Math.max(Date.now() + (delay || 60_000), reset || 0)).toISOString());
  }
  if (error) throw new Error(error);
  if (status >= 400) throw new Error(`GitHub HTTP ${status}`);
  return parsed.data;
}

function ghResponse(stdout: string): unknown {
  const boundary = /\r?\n\r?\n/.exec(stdout);
  if (!boundary || boundary.index === undefined) throw new Error("GitHub returned an invalid response.");
  const [statusLine, ...lines] = stdout.slice(0, boundary.index).split(/\r?\n/);
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  return responseData(JSON.parse(stdout.slice(boundary.index + boundary[0].length)), headers, Number(statusLine?.split(/\s+/)[1]));
}

export function githubTransport(token?: string): Transport {
  return async (query, variables, signal) => {
    const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    if (token?.trim()) {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST", signal: abort,
        headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json", "user-agent": "bb-plugin-my-prs" },
        body: JSON.stringify({ query, variables }),
      });
      return responseData(await response.json(), response.headers, response.status);
    } else {
      let stdout: string;
      try {
        ({ stdout } = await run("gh", ["api", "graphql", "--include", "-f", `query=${query}`,
          ...Object.entries(variables).flatMap(([key, value]) => ["-f", `${key}=${value}`])],
        { signal: abort, maxBuffer: 16 * 1024 * 1024 }));
      } catch (cause) {
        const failed = z.object({ stdout: z.string() }).safeParse(cause);
        if (!failed.success || !failed.data.stdout.startsWith("HTTP/")) throw cause;
        stdout = failed.data.stdout;
      }
      return ghResponse(stdout);
    }
  };
}

const actor = z.object({ login: z.string(), __typename: z.string() }).nullable();
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const connection = <T extends z.ZodType>(node: T) => z.object({ nodes: z.array(node), pageInfo });
export const reviewSchema = z.object({
  id: z.string(), author: actor, state: z.string(), body: z.string(), submittedAt: z.string().nullable(),
});
export const commentSchema = z.object({
  id: z.string(), author: actor, body: z.string(), createdAt: z.string(), updatedAt: z.string(),
  pullRequestReview: z.object({ id: z.string() }).nullable().optional(),
});
export const threadSchema = z.object({ id: z.string(), isResolved: z.boolean(), comments: connection(commentSchema) });
export const metadataSchema = z.object({
  id: z.string(), number: z.number().int().positive(), title: z.string(), url: z.string(), isDraft: z.boolean(),
  headRefOid: z.string(), headRefName: z.string(), updatedAt: z.string(), author: actor,
  repository: z.object({ nameWithOwner: z.string() }),
  reviewDecision: statusSchema.shape.reviewDecision.default(null),
  mergeable: statusSchema.shape.mergeable.default("UNKNOWN"),
  mergeStateStatus: z.string().default("UNKNOWN"),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ committedDate: z.string(),
    statusCheckRollup: z.object({ state: statusSchema.shape.checks }).nullable().default(null),
  }) })) }),
});
export type Metadata = z.infer<typeof metadataSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Comment = z.infer<typeof commentSchema>;
export type ReviewThread = z.infer<typeof threadSchema>;

const metadataFields = `id number title url isDraft headRefOid headRefName updatedAt reviewDecision mergeable mergeStateStatus
  author { login __typename } repository { nameWithOwner }
  commits(last:1) { nodes { commit { committedDate statusCheckRollup { state } } } }`;
const commentFields = "id body createdAt updatedAt author { login __typename }";
const threadCommentFields = `${commentFields} pullRequestReview { id }`;
const pageFields = "pageInfo { hasNextPage endCursor }";

export function createGithubClient(transport: Transport) {
  async function pages<T extends z.ZodType>(options: {
    query: string; variables: Record<string, string>; schema: T;
    read: (data: unknown) => unknown; signal?: AbortSignal; initial?: unknown;
  }): Promise<z.infer<T>[]> {
    const result: z.infer<T>[] = [];
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 200; page++) {
      const next = connection(options.schema).parse(page === 0 && options.initial !== undefined ? options.initial
        : options.read(await transport(options.query, { ...options.variables, ...(after ? { after } : {}) }, options.signal)));
      result.push(...next.nodes);
      if (!next.pageInfo.hasNextPage) return result;
      after = next.pageInfo.endCursor;
      if (!after || cursors.has(after)) throw new Error("GitHub pagination did not advance; the previous PR snapshot was kept.");
      cursors.add(after);
    }
    throw new Error("GitHub exceeded the pagination limit; the previous PR snapshot was kept.");
  }

  async function field<T extends z.ZodType>(options: {
    id: string; kind: "reviews" | "comments" | "reviewThreads" | "reviewRequests";
    fields: string; schema: T; signal?: AbortSignal; initial: unknown;
  }) {
    const dataSchema = z.object({ node: z.object({ [options.kind]: z.unknown() }) });
    return pages({
      query: `query($id:ID!,$after:String) { node(id:$id) { ... on PullRequest {
        ${options.kind}(first:100,after:$after) { ${pageFields} nodes { ${options.fields} } }
      } } }`, variables: { id: options.id }, schema: options.schema, signal: options.signal, initial: options.initial,
      read: (data) => dataSchema.parse(data).node[options.kind],
    });
  }

  const requestSchema = z.object({ requestedReviewer: z.object({ login: z.string().optional() }).nullable() });
  const reviewFields = "id state body submittedAt author { login __typename }";
  const threadFields = `id isResolved comments(first:100) { ${pageFields} nodes { ${threadCommentFields} } }`;
  const requestFields = "requestedReviewer { ... on User { login } }";

  async function fetchPullRequest(id: string, allowlist: string[], signal?: AbortSignal): Promise<PullRequest | null> {
    const data = z.object({ viewer: z.object({ login: z.string() }), node: metadataSchema.extend({
      state: z.string(), reviews: connection(reviewSchema), comments: connection(commentSchema),
      reviewThreads: connection(threadSchema), reviewRequests: connection(requestSchema),
    }).nullable() }).parse(await transport(`query($id:ID!) {
      viewer { login }
      node(id:$id) { ... on PullRequest { state ${metadataFields}
        reviews(first:100) { ${pageFields} nodes { ${reviewFields} } }
        comments(first:100) { ${pageFields} nodes { ${commentFields} } }
        reviewThreads(first:100) { ${pageFields} nodes { ${threadFields} } }
        reviewRequests(first:100) { ${pageFields} nodes { ${requestFields} } }
      } }
    }`, { id }, signal));
    const pr = data.node;
    if (!pr || pr.state !== "OPEN" || pr.author?.login.toLowerCase() !== data.viewer.login.toLowerCase()) return null;
    if (allowlist.length && !allowlist.some((repo) => repo.toLowerCase() === pr.repository.nameWithOwner.toLowerCase())) return null;
    const [reviews, comments, threads, requests] = await Promise.all([
      field({ id, kind: "reviews", fields: reviewFields, schema: reviewSchema, initial: pr.reviews, signal }),
      field({ id, kind: "comments", fields: commentFields, schema: commentSchema, initial: pr.comments, signal }),
      field({ id, kind: "reviewThreads", fields: threadFields, schema: threadSchema, initial: pr.reviewThreads, signal }),
      field({ id, kind: "reviewRequests", fields: requestFields, schema: requestSchema, initial: pr.reviewRequests, signal }),
    ]);
    for (const thread of threads) {
      if (!thread.comments.pageInfo.hasNextPage) continue;
      thread.comments.nodes = await pages({
        query: `query($id:ID!,$after:String) { node(id:$id) { ... on PullRequestReviewThread {
          comments(first:100,after:$after) { ${pageFields} nodes { ${threadCommentFields} } }
        } } }`, variables: { id: thread.id }, schema: commentSchema, signal, initial: thread.comments,
        read: (data) => z.object({ node: z.object({ comments: z.unknown() }) }).parse(data).node.comments,
      });
    }
    const fresh = z.object({ node: z.object({ state: z.string(), headRefOid: z.string() }).nullable() }).parse(
      await transport("query($id:ID!) { node(id:$id) { ... on PullRequest { state headRefOid } } }", { id }, signal));
    if (!fresh.node || fresh.node.state !== "OPEN") return null;
    if (fresh.node.headRefOid !== pr.headRefOid) throw new Error("A PR changed while reading feedback. Refresh again.");
    return feedbackOf({ pr, reviews, comments, threads,
      requested: requests.flatMap((request) => request.requestedReviewer?.login ? [request.requestedReviewer.login] : []) });
  }

  return {
    fetchPullRequest,
    async fetchMyPrs(allowlist: string[], signal?: AbortSignal): Promise<{ login: string; prs: PullRequest[] }> {
      const { viewer } = z.object({ viewer: z.object({ login: z.string() }) }).parse(
        await transport("query { viewer { login } }", {}, signal));
      const searchSchema = z.object({ search: z.object({ nodes: z.array(metadataSchema), pageInfo, issueCount: z.number() }) });
      const metadata = await pages({
        query: `query($search:String!,$after:String) { search(query:$search,type:ISSUE,first:50,after:$after) {
          issueCount ${pageFields} nodes { ... on PullRequest { ${metadataFields} } }
        } }`, variables: { search: `is:pr is:open author:${viewer.login}` }, schema: metadataSchema, signal,
        read: (data) => {
          const { search } = searchSchema.parse(data);
          if (search.issueCount > 1000) throw new Error("GitHub search exceeds 1,000 open PRs; the previous PR snapshot was kept.");
          return search;
        },
      });
      const allowed = new Set(allowlist.map((repo) => repo.toLowerCase()));
      const eligible = metadata.filter((pr) => pr.author?.login.toLowerCase() === viewer.login.toLowerCase() &&
        (!allowed.size || allowed.has(pr.repository.nameWithOwner.toLowerCase())));
      const snapshots: (PullRequest | null)[] = eligible.map(() => null);
      const queue = eligible.entries();
      const cancel = new AbortController();
      const abort = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal;
      const failures: unknown[] = [];
      await Promise.all(Array.from({ length: Math.min(4, eligible.length) }, async () => {
        for (const [index, pr] of queue) {
          if (abort.aborted) return;
          try { snapshots[index] = await fetchPullRequest(pr.id, allowlist, abort); }
          catch (cause) { failures.push(cause); cancel.abort(); return; }
        }
      }));
      if (failures.length) throw failures[0];
      signal?.throwIfAborted();
      return { login: viewer.login, prs: snapshots.filter((pr) => pr !== null) };
    },
  };
}
