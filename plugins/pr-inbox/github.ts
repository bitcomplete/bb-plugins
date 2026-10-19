import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { feedbackOf } from "./feedback.js";
import type { PullRequest } from "./types.js";

const run = promisify(execFile);
export type Transport = (query: string, variables: Record<string, string>, signal?: AbortSignal) => Promise<unknown>;
const envelope = z.object({ data: z.unknown().optional(), errors: z.array(z.object({ message: z.string() })).optional() });

export function githubTransport(token?: string): Transport {
  return async (query, variables, signal) => {
    const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    let body: unknown;
    if (token?.trim()) {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST", signal: abort,
        headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json", "user-agent": "bb-plugin-pr-inbox" },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      body = await response.json();
    } else {
      const { stdout } = await run("gh", ["api", "graphql", "-f", `query=${query}`,
        ...Object.entries(variables).flatMap(([key, value]) => ["-f", `${key}=${value}`])],
      { signal: abort, maxBuffer: 16 * 1024 * 1024 });
      body = JSON.parse(stdout);
    }
    const parsed = envelope.parse(body);
    if (parsed.errors?.length) throw new Error(parsed.errors.map((error) => error.message).join("; "));
    return parsed.data;
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
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ committedDate: z.string() }) })) }),
});
export type Metadata = z.infer<typeof metadataSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Comment = z.infer<typeof commentSchema>;
export type ReviewThread = z.infer<typeof threadSchema>;

const metadataFields = `id number title url isDraft headRefOid headRefName updatedAt
  author { login __typename } repository { nameWithOwner }
  commits(last:1) { nodes { commit { committedDate } } }`;
const commentFields = "id body createdAt updatedAt author { login __typename }";
const threadCommentFields = `${commentFields} pullRequestReview { id }`;
const pageFields = "pageInfo { hasNextPage endCursor }";

export function createGithubClient(transport: Transport) {
  async function pages<T extends z.ZodType>(options: {
    query: string; variables: Record<string, string>; schema: T;
    read: (data: unknown) => unknown; signal?: AbortSignal;
  }): Promise<z.infer<T>[]> {
    const result: z.infer<T>[] = [];
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 200; page++) {
      const data = await transport(options.query, { ...options.variables, ...(after ? { after } : {}) }, options.signal);
      const next = connection(options.schema).parse(options.read(data));
      result.push(...next.nodes);
      if (!next.pageInfo.hasNextPage) return result;
      after = next.pageInfo.endCursor;
      if (!after || cursors.has(after)) throw new Error("GitHub pagination did not advance; the previous inbox was kept.");
      cursors.add(after);
    }
    throw new Error("GitHub exceeded the pagination limit; the previous inbox was kept.");
  }

  async function field<T extends z.ZodType>(options: {
    id: string; kind: "reviews" | "comments" | "reviewThreads" | "reviewRequests";
    fields: string; schema: T; signal?: AbortSignal;
  }) {
    const dataSchema = z.object({ node: z.object({ [options.kind]: z.unknown() }) });
    return pages({
      query: `query($id:ID!,$after:String) { node(id:$id) { ... on PullRequest {
        ${options.kind}(first:100,after:$after) { ${pageFields} nodes { ${options.fields} } }
      } } }`, variables: { id: options.id }, schema: options.schema, signal: options.signal,
      read: (data) => dataSchema.parse(data).node[options.kind],
    });
  }

  return {
    async fetchInbox(allowlist: string[], signal?: AbortSignal): Promise<{ login: string; prs: PullRequest[] }> {
      const { viewer } = z.object({ viewer: z.object({ login: z.string() }) }).parse(
        await transport("query { viewer { login } }", {}, signal));
      const searchSchema = z.object({ search: z.object({ nodes: z.array(metadataSchema), pageInfo, issueCount: z.number() }) });
      const metadata = await pages({
        query: `query($search:String!,$after:String) { search(query:$search,type:ISSUE,first:50,after:$after) {
          issueCount ${pageFields} nodes { ... on PullRequest { ${metadataFields} } }
        } }`, variables: { search: `is:pr is:open author:${viewer.login}` }, schema: metadataSchema, signal,
        read: (data) => {
          const { search } = searchSchema.parse(data);
          if (search.issueCount > 1000) throw new Error("GitHub search exceeds 1,000 open PRs; the previous inbox was kept.");
          return search;
        },
      });
      const allowed = new Set(allowlist.map((repo) => repo.toLowerCase()));
      const prs: PullRequest[] = [];
      for (const pr of metadata) {
        if (pr.author?.login.toLowerCase() !== viewer.login.toLowerCase()) continue;
        if (allowed.size && !allowed.has(pr.repository.nameWithOwner.toLowerCase())) continue;
        const [reviews, comments, threads, requests] = await Promise.all([
          field({ id: pr.id, kind: "reviews", fields: "id state body submittedAt author { login __typename }", schema: reviewSchema, signal }),
          field({ id: pr.id, kind: "comments", fields: commentFields, schema: commentSchema, signal }),
          field({ id: pr.id, kind: "reviewThreads", fields: `id isResolved comments(first:100) { ${pageFields} nodes { ${threadCommentFields} } }`, schema: threadSchema, signal }),
          field({ id: pr.id, kind: "reviewRequests", fields: "requestedReviewer { ... on User { login } }", schema: z.object({ requestedReviewer: z.object({ login: z.string().optional() }).nullable() }), signal }),
        ]);
        for (const thread of threads) {
          if (!thread.comments.pageInfo.hasNextPage) continue;
          thread.comments.nodes = await pages({
            query: `query($id:ID!,$after:String) { node(id:$id) { ... on PullRequestReviewThread {
              comments(first:100,after:$after) { ${pageFields} nodes { ${threadCommentFields} } }
            } } }`, variables: { id: thread.id }, schema: commentSchema, signal,
            read: (data) => z.object({ node: z.object({ comments: z.unknown() }) }).parse(data).node.comments,
          });
        }
        const fresh = z.object({ node: z.object({ state: z.string(), headRefOid: z.string() }) }).parse(
          await transport("query($id:ID!) { node(id:$id) { ... on PullRequest { state headRefOid } } }", { id: pr.id }, signal));
        if (fresh.node.state !== "OPEN") continue;
        if (fresh.node.headRefOid !== pr.headRefOid) throw new Error("A PR changed while reading feedback. Refresh again.");
        prs.push(feedbackOf({ pr, reviews, comments, threads,
          requested: requests.flatMap((request) => request.requestedReviewer?.login ? [request.requestedReviewer.login] : []) }));
      }
      return { login: viewer.login, prs };
    },
  };
}
