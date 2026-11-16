// Public Review Watch v1 wire boundary. No source/storage coupling between plugins.
import { z } from "zod";

export const ruleSchema = z.enum([
  // Someone named me as a reviewer and I have not reviewed this head commit.
  "review-requested",
  // I reviewed an earlier commit; the author has pushed since.
  "review-followup",
]);
export type Rule = z.infer<typeof ruleSchema>;

/**
 * Queue rows are never deleted on sight of the same pull request again:
 * `dismissed`, `started`, and `archived` survive polls so threads stay reachable
 * and past decisions do not return to the queue.
 */
export const itemStateSchema = z.enum(["queued", "started", "dismissed", "archived"]);
export type ItemState = z.infer<typeof itemStateSchema>;

export const queueItemSchema = z.object({
  /** `${rule}:${nodeId}:${headSha}` — the whole dedup story lives in this key. */
  key: z.string(),
  rule: ruleSchema,
  state: itemStateSchema,
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  url: z.string(),
  baseBranch: z.string(),
  headBranch: z.string(),
  headSha: z.string(),
  nodeId: z.string(),
  /** One line a human reads to decide whether to open it. */
  reason: z.string(),
  /** When review-watch first saw this item. */
  noticedAt: z.string(),
  /** The pull request's own updatedAt, for sorting. */
  updatedAt: z.string(),
  /** Last submitted review when this item was first classified. */
  reviewBaselineSubmittedAt: z.string().nullable().optional(),
  reviewBaselineCommitSha: z.string().nullable().optional(),
  /** Set once a thread has been started for this item. */
  threadId: z.string().optional(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;


const unknownSchema = z.object({ kind: z.literal("unknown"), reason: z.string() });
export const reviewTotalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("known"), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), files: z.number().int().nonnegative() }),
  unknownSchema,
]);
export const reviewDeltaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("known"), baseSha: z.string(), headSha: z.string(),
    additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
    files: z.array(z.object({ path: z.string(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() })),
  }),
  unknownSchema,
  z.object({ kind: z.literal("not-applicable") }),
]);
export const lastReviewSchema = z.object({
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
  submittedAt: z.string(), commitSha: z.string().nullable(),
});
export const reviewResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("known"), resolved: z.number().int().nonnegative(), unresolved: z.number().int().nonnegative() }),
  unknownSchema,
]);
export const prsReviewSchema = z.object({
  item: queueItemSchema,
  segment: z.enum(["on-you", "agent", "with-authors"]),
  agentState: z.enum(["none", "running", "draft-ready", "stopped", "unknown"]),
  evidence: z.string(),
  total: reviewTotalSchema,
  delta: reviewDeltaSchema,
  lastReview: lastReviewSchema.nullable(),
  resolution: reviewResolutionSchema,
});
export const lastPollSchema = z.object({
  at: z.string(), ok: z.boolean(), added: z.number(), total: z.number(), error: z.string().optional(),
});
export const prsSnapshotSchema = z.object({
  version: z.literal(1), items: z.array(prsReviewSchema),
  lastPoll: lastPollSchema.nullable(), lastSuccessAt: z.string().nullable(),
});
export type PrsReview = z.infer<typeof prsReviewSchema>;
export type ReviewDelta = z.infer<typeof reviewDeltaSchema>;


export const reviewsStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("available"), snapshot: prsSnapshotSchema }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);
export type ReviewsState = z.infer<typeof reviewsStateSchema>;
export const reviewTargetsSchema = z.object({
  projectId: z.string().nullable(), reason: z.enum(["organization", "default", "mixed", "choose"]),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type ReviewTargets = z.infer<typeof reviewTargetsSchema>;
export const reviewStartSchema = z.object({ item: queueItemSchema });
export const reviewBatchSchema = z.object({ threadId: z.string(), items: z.array(queueItemSchema) });
export const reviewPollSchema = z.object({ ok: z.boolean(), added: z.number(), removed: z.number(), total: z.number(), changed: z.boolean(), error: z.string().optional() });

/** Missing follow-up evidence never substitutes the total diff for the delta. */
export function reviewLines(review: PrsReview): number | null {
  if (review.item.rule === "review-followup") return review.delta.kind === "known" ? review.delta.additions + review.delta.deletions : null;
  return review.total.kind === "known" ? review.total.additions + review.total.deletions : null;
}
export function quickRead(review: PrsReview): boolean {
  if (review.agentState === "draft-ready") return true;
  const lines = reviewLines(review);
  return lines !== null && lines < (review.item.rule === "review-followup" ? 150 : 300);
}
export function estimatedMinutes(review: PrsReview): number | null {
  const lines = reviewLines(review);
  return lines === null ? null : Math.max(5, Math.ceil(lines / 30));
}
