// Legacy Advance's saved batches. Nothing starts, rechecks, or settles a job any
// more: the batches are history that thread links and All PRs read, in the shape
// the removed engine wrote them. A job it left unsettled holds nothing.
import { z } from "zod";
import { approvalFeedbackSchema } from "./approval-feedback.js";
import type { RunDb } from "./runstore.js";

export const advancePreviewJobSchema = z.object({
  prUrl: z.string(), repo: z.string(), number: z.number(), title: z.string(), headOid: z.string(),
  baseOid: z.string().optional(),
  baseRefName: z.string(), headRefName: z.string(), needsPreparation: z.boolean(), needsFeedback: z.boolean().default(false), needsChecks: z.boolean().default(false), eligible: z.boolean(),
  approvalFeedback: approvalFeedbackSchema.optional(),
  detail: z.string(), workspace: z.enum(["existing", "create", "unavailable"]),
});
const advanceAttemptSchema = z.object({ attemptId: z.string(), threadId: z.string().nullable(), path: z.string().nullable(), detail: z.string(), status: z.string(), updatedAt: z.number() });
export const advanceJobSchema = advancePreviewJobSchema.extend({
  id: z.string(), hiddenFromProgress: z.boolean().default(false), status: z.enum(["queued", "launching", "running", "verifying", "ready", "waiting-checks", "waiting-review", "needs-attention", "cancelled", "merged", "closed"]),
  attemptId: z.string().nullable().default(null), dedicated: z.boolean().default(false), previousAttempts: z.array(advanceAttemptSchema).max(5).default([]),
  threadId: z.string().nullable(), path: z.string().nullable(), checkedHeadOid: z.string().nullable(), checkedBaseOid: z.string().nullable().optional(), updatedAt: z.number(), uncertain: z.boolean().default(false),
});
export const advanceBatchSchema = z.object({ id: z.string(), createdAt: z.number(), cancelled: z.boolean(), instruction: z.string().max(4_000).optional(), jobs: z.array(advanceJobSchema) });
export type AdvanceJob = z.infer<typeof advanceJobSchema>;
export type AdvanceBatch = z.infer<typeof advanceBatchSchema>;
export const ADVANCE_MIGRATIONS = ["CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)"];

/** The saved batches, read once when the plugin loads, newest first. */
export function createAdvanceHistory(db: RunDb) {
  const batches = (db.prepare("SELECT body FROM advance_batches").all() as { body: string }[])
    .map(({ body }) => advanceBatchSchema.parse(JSON.parse(body))).sort((a, b) => b.createdAt - a.createdAt);
  return { list: (): AdvanceBatch[] => [...batches] };
}
