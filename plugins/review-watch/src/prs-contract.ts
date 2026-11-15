import { z } from "zod";
import { queueItemSchema } from "./types.js";

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

const resultSchema = z.object({ version: z.literal(1), status: z.literal("draft-ready"), itemKeys: z.array(z.string().min(1)).min(1) }).strict();

/** Only a validated final block is evidence that the agent completed a draft. */
export function draftReadyKeys(output: string | null): Set<string> {
  if (output === null) return new Set();
  const match = /```review-watch-result\s*\n([\s\S]*?)\n```\s*$/.exec(output);
  if (match?.[1] === undefined) return new Set();
  try {
    const parsed = resultSchema.safeParse(JSON.parse(match[1]));
    return new Set(parsed.success ? parsed.data.itemKeys : []);
  } catch { return new Set(); }
}
