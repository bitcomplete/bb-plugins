import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import { loadActivity, loadInProgress } from "./activity.js";

const QUERY = `query($searchQuery: String!, $cursor: String) {
  search(query: $searchQuery, type: ISSUE, first: 100, after: $cursor) {
    issueCount pageInfo { hasNextPage endCursor }
    nodes { __typename ... on PullRequest {
      number title url createdAt mergedAt closedAt additions deletions changedFiles
      author { __typename login }
      repository { nameWithOwner }
      reviews(first: 100) { pageInfo { hasNextPage } nodes { id submittedAt state author { __typename login } } }
    } }
  }
}`;
const SNAPSHOT_QUERY = `query($searchQuery: String!, $cursor: String) {
  search(query: $searchQuery, type: ISSUE, first: 100, after: $cursor) {
    issueCount pageInfo { hasNextPage endCursor }
    nodes { __typename ... on PullRequest {
      number title url createdAt mergedAt closedAt additions deletions changedFiles isDraft
      author { __typename login }
      repository { nameWithOwner }
    } }
  }
}`;

function gh(document: string, query: string, cursor: string | null, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const args = ["api", "graphql", "-f", `query=${document}`, "-f", `searchQuery=${query}`];
    if (cursor !== null) args.push("-f", `cursor=${cursor}`);
    execFile("gh", args, { cwd: homedir(), signal, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error((stderr || error.message).trim().slice(0, 500))); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("GitHub returned invalid JSON.")); }
    });
  });
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    activity: async ({ org, week }, context) => {
      try {
        const now = new Date();
        const [events, inProgress] = await Promise.all([
          loadActivity(org, week, (query, cursor, signal) => gh(QUERY, query, cursor, signal), context.signal),
          loadInProgress(org, week, now, (query, cursor, signal) => gh(SNAPSHOT_QUERY, query, cursor, signal), context.signal),
        ]);
        return { ok: true as const, org, week, fetchedAt: now.toISOString(), events, inProgress };
      }
      catch (error) { return { ok: false as const, error: error instanceof Error ? error.message.slice(0, 800) : "Could not load GitHub activity." }; }
    },
    in_progress: async ({ org, week }, context) => {
      try {
        const now = new Date();
        const inProgress = await loadInProgress(org, week, now, (query, cursor, signal) => gh(SNAPSHOT_QUERY, query, cursor, signal), context.signal);
        return { ok: true as const, org, week, fetchedAt: now.toISOString(), inProgress };
      } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message.slice(0, 800) : "Could not load in-progress PRs." }; }
    },
  },
});
