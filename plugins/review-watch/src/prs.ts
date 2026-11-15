import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { GithubClient } from "./github.js";
import { pullRequestSchema, type PullRequest, type QueueItem } from "./types.js";
import { draftReadyKeys, reviewDeltaSchema, reviewResolutionSchema, type PrsReview } from "./prs-contract.js";

const CONTEXT_KEY = "prs-context-v1";
const DRAFTS_KEY = "review-drafts-v1";
const DETAILS_KEY = "review-details-v1";
const contextSchema = z.object({ at: z.string(), viewer: z.string(), pullRequests: z.array(pullRequestSchema) });
const detailsSchema = z.record(z.string(), z.object({ delta: reviewDeltaSchema, resolution: reviewResolutionSchema, at: z.string() }));
type Context = z.infer<typeof contextSchema>;
type Detail = z.infer<typeof detailsSchema>[string];
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function reviewBase(item: QueueItem, pr: PullRequest | undefined): string | null {
  const review = pr?.myLastReview;
  if (review?.commitSha) return review.commitSha;
  return review !== undefined && review !== null && review.submittedAt === item.reviewBaselineSubmittedAt
    ? item.reviewBaselineCommitSha ?? null : null;
}
const detailKey = (item: QueueItem, pr: PullRequest | undefined) => `${item.nodeId}:${reviewBase(item, pr) ?? "unknown"}:${item.headSha}`;

function isWithAuthors(pr: PullRequest, viewer: string): boolean {
  const review = pr.myLastReview;
  return !pr.isDraft && pr.author.toLowerCase() !== viewer.toLowerCase() && review !== null &&
    review.state !== "PENDING" && review.state !== "DISMISSED" &&
    !pr.requestedReviewers.some((login) => login.toLowerCase() === viewer.toLowerCase()) &&
    (review.state === "APPROVED" || review.commitSha === pr.headSha || Date.parse(review.submittedAt) >= Date.parse(pr.headCommittedAt));
}

/** A read projection keeps review history separate from the durable action queue. */
function projectedItems(queue: QueueItem[], context: Context | null): QueueItem[] {
  const byNode = new Map<string, QueueItem>();
  const dismissed = new Set(queue.filter((item) => item.state === "dismissed").map((item) => `${item.nodeId}:${item.headSha}`));
  for (const item of queue) {
    if (item.state === "dismissed" || dismissed.has(`${item.nodeId}:${item.headSha}`)) continue;
    const pr = context?.pullRequests.find((pr) => pr.nodeId === item.nodeId);
    if (pr !== undefined && pr.headSha !== item.headSha) continue;
    if (item.state === "archived" && (pr === undefined || context === null || !isWithAuthors(pr, context.viewer))) continue;
    const previous = byNode.get(item.nodeId);
    if (previous === undefined || (previous.state === "archived" && item.state !== "archived") ||
      ((previous.state === "archived") === (item.state === "archived") && item.noticedAt > previous.noticedAt)) byNode.set(item.nodeId, item);
  }
  for (const pr of context?.pullRequests ?? []) {
    if (context === null || byNode.has(pr.nodeId) || !isWithAuthors(pr, context.viewer)) continue;
    const key = `history:${pr.nodeId}:${pr.headSha}`;
    if (dismissed.has(`${pr.nodeId}:${pr.headSha}`)) continue;
    byNode.set(pr.nodeId, {
      key, rule: "review-followup", state: "archived", repo: pr.repo, number: pr.number,
      title: pr.title, author: pr.author, url: pr.url, baseBranch: pr.baseBranch,
      headBranch: pr.headBranch, headSha: pr.headSha, nodeId: pr.nodeId,
      reason: "Your submitted review leaves the next action with the author or another reviewer",
      noticedAt: pr.myLastReview?.submittedAt ?? context.at, updatedAt: pr.updatedAt,
      reviewBaselineSubmittedAt: pr.myLastReview?.submittedAt ?? null,
      reviewBaselineCommitSha: pr.myLastReview?.commitSha ?? null,
    });
  }
  return [...byNode.values()].sort((a, b) => a.noticedAt.localeCompare(b.noticedAt));
}

export function createPrsInbox(options: {
  bb: BbPluginApi;
  readQueue: () => Promise<QueueItem[]>;
  github: () => Promise<{ client: GithubClient; viewer: string }>;
}) {
  const { bb } = options;
  async function context(): Promise<Context | null> {
    const parsed = contextSchema.safeParse(await bb.storage.kv.get(CONTEXT_KEY));
    return parsed.success ? parsed.data : null;
  }
  async function details() {
    const parsed = detailsSchema.safeParse(await bb.storage.kv.get(DETAILS_KEY));
    return parsed.success ? parsed.data : {};
  }
  async function saveDetails(cached: z.infer<typeof detailsSchema>) {
    const oldest = Object.keys(cached).sort((a, b) => (cached[a]?.at ?? "").localeCompare(cached[b]?.at ?? ""));
    while (Buffer.byteLength(JSON.stringify(cached), "utf8") > 192_000) {
      const key = oldest.shift();
      if (key === undefined) break;
      delete cached[key];
    }
    await bb.storage.kv.set(DETAILS_KEY, cached);
  }
  async function drafts() {
    const parsed = z.record(z.string(), z.array(z.string())).safeParse(await bb.storage.kv.get(DRAFTS_KEY));
    return parsed.success ? parsed.data : {};
  }
  // Only these short local writes share a lock; GitHub reads never hold it.
  let writeTurn = Promise.resolve();
  async function write<T>(operation: () => Promise<T>): Promise<T> {
    const previous = writeTurn;
    let release!: () => void;
    writeTurn = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  function row(item: QueueItem, ctx: Context | null, detail: Detail | undefined, agentState: PrsReview["agentState"]): PrsReview {
    const pr = ctx?.pullRequests.find((pr) => pr.nodeId === item.nodeId && pr.headSha === item.headSha);
    const review = pr?.myLastReview;
    const withAuthors = item.state === "archived" && pr !== undefined && ctx !== null && isWithAuthors(pr, ctx.viewer);
    return {
      item,
      segment: withAuthors ? "with-authors" : agentState === "running" ? "agent" : "on-you",
      agentState,
      evidence: withAuthors ? "GitHub records your submitted review with no outstanding request for you."
        : agentState === "running" ? "The reviewer thread has an active or starting turn."
        : agentState === "draft-ready" ? "The reviewer thread completed a validated draft-ready result."
        : agentState === "stopped" ? "The reviewer thread stopped without a completed draft marker. Open the thread to check its progress."
        : agentState === "unknown" ? "The reviewer thread state is unavailable. Open the thread to check its progress."
        : item.reason,
      total: pr?.additions !== undefined && pr.deletions !== undefined && pr.changedFiles !== undefined
        ? { kind: "known", additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles }
        : { kind: "unknown", reason: "Refresh Review Watch to load this pull request's size." },
      delta: item.rule === "review-requested" ? { kind: "not-applicable" }
        : detail?.delta ?? { kind: "unknown", reason: "Open this review to load the comparison with your last reviewed commit." },
      lastReview: review === undefined || review === null ? null : { ...review, commitSha: review.commitSha ?? null },
      resolution: detail?.resolution ?? { kind: "unknown", reason: "Open this review to load the resolution of your previous threads." },
    };
  }
  async function snapshot() {
    const [queue, ctx, cachedDetails, completed] = await Promise.all([options.readQueue(), context(), details(), drafts()]);
    const items = projectedItems(queue, ctx);
    const ids = [...new Set(items.flatMap((item) => item.state === "started" && item.threadId ? [item.threadId] : []))];
    const states = new Map<string, PrsReview["agentState"]>();
    for (let offset = 0; offset < ids.length; offset += 200) {
      try {
        const batch = ids.slice(offset, offset + 200);
        const threads = await bb.sdk.threads.list({ threadIds: batch, includeHidden: true, limit: 200 });
        for (const thread of threads) {
          states.set(thread.id, thread.status === "active" || thread.status === "starting" ? "running"
            : thread.status === "idle" && completed[thread.id] !== undefined ? "draft-ready" : "stopped");
        }
      } catch (cause) { bb.log.warn(`Could not read reviewer thread states: ${errorText(cause)}`); }
    }
    return {
      items: items.map((item) => {
        let state: PrsReview["agentState"] = item.state === "started" && item.threadId ? states.get(item.threadId) ?? "unknown" : "none";
        if (state === "draft-ready" && item.threadId && !completed[item.threadId]?.includes(item.key)) state = "stopped";
        return row(item, ctx, cachedDetails[detailKey(item, ctx?.pullRequests.find((pr) => pr.nodeId === item.nodeId))], state);
      }),
      lastSuccessAt: ctx?.at ?? null,
    };
  }
  return {
    snapshot,
    async observe(pullRequests: PullRequest[], viewer: string, at: string) {
      await write(async () => {
        await bb.storage.kv.set(CONTEXT_KEY, { at, viewer, pullRequests });
        const validKeys = new Set((await options.readQueue()).map((item) => detailKey(item, pullRequests.find((pr) => pr.nodeId === item.nodeId))));
        const retained = Object.fromEntries(Object.entries(await details()).filter(([key]) => validKeys.has(key)));
        await saveDetails(retained);
      });
    },
    async findItem(key: string) {
      return projectedItems(await options.readQueue(), await context()).find((item) => item.key === key);
    },
    async recordDraft(threadId: string, output: string | null) {
      await write(async () => {
        const completed = await drafts();
        const keys = [...draftReadyKeys(output)];
        if (keys.length > 0) completed[threadId] = keys; else delete completed[threadId];
        await bb.storage.kv.set(DRAFTS_KEY, completed);
      });
    },
    async detail(key: string): Promise<PrsReview> {
      const item = projectedItems(await options.readQueue(), await context()).find((item) => item.key === key);
      if (item === undefined) throw new Error("This review is no longer available. Refresh the review queue.");
      const { client, viewer } = await options.github();
      const retained = await client.fetchRetainedPullRequests([item.nodeId], viewer);
      const pr = retained.pullRequests.find((pr) => pr.nodeId === item.nodeId);
      if (pr === undefined || pr.headSha !== item.headSha) throw new Error("This pull request changed or closed. Refresh the review queue before reading its delta.");
      const baseline = reviewBase(item, pr);
      const [delta, resolution] = await Promise.all([
        item.rule === "review-requested" ? Promise.resolve({ kind: "not-applicable" as const })
          : !baseline ? Promise.resolve({ kind: "unknown" as const, reason: "GitHub did not provide the commit for your last submitted review." })
          : client.compareCommits(item.repo, baseline, item.headSha).catch((cause): PrsReview["delta"] => ({ kind: "unknown", reason: `GitHub compare failed: ${errorText(cause)}` })),
        client.fetchReviewResolution(item.nodeId, viewer).catch((cause): PrsReview["resolution"] => ({ kind: "unknown", reason: `Review thread lookup failed: ${errorText(cause)}` })),
      ]);
      await write(async () => {
        const cachedDetails = await details();
        cachedDetails[detailKey(item, pr)] = { delta, resolution, at: new Date().toISOString() };
        await saveDetails(cachedDetails);
        const previous = await context();
        const observed = previous?.pullRequests.find((value) => value.nodeId === pr.nodeId);
        if (observed === undefined || (observed.headSha === pr.headSha && observed.updatedAt <= pr.updatedAt)) {
          await bb.storage.kv.set(CONTEXT_KEY, { viewer, at: previous?.at ?? new Date().toISOString(), pullRequests: [...(previous?.pullRequests.filter((value) => value.nodeId !== pr.nodeId) ?? []), pr] });
        }
      });
      const refreshed = await snapshot();
      const current = refreshed.items.find((value) => value.item.key === key);
      if (current === undefined) throw new Error("This review changed while loading. Refresh the review queue.");
      return current.lastReview?.submittedAt === pr.myLastReview?.submittedAt ? { ...current, delta, resolution } : current;
    },
  };
}
