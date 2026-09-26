import { z } from "zod";

export const advanceFactsSchema = z.object({
  prUrl: z.string().max(500), number: z.number().int().positive(), title: z.string().max(300), repo: z.string().max(160),
  headRefName: z.string().max(300), baseRefName: z.string().max(300),
  headOid: z.string().regex(/^(?:[0-9a-f]{40})?$/u), baseOid: z.string().regex(/^(?:[0-9a-f]{40})?$/u),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean(), isCrossRepository: z.boolean(),
  reviewDecision: z.string().nullable(), mergeStateStatus: z.string(), mergeable: z.string(),
  needsPreparation: z.boolean(), readiness: z.enum(["ready", "waiting-checks", "waiting-review", "needs-attention", "merged", "closed"]),
  detail: z.string().max(800), unresolvedThreads: z.number().int().nonnegative(),
  checks: z.enum(["passed", "pending", "failed", "unknown"]),
  basePrNumber: z.number().int().positive().nullable(), approvalNotePending: z.boolean(),
}).strict().superRefine((facts, ctx) => {
  if (facts.state !== "OPEN") return;
  for (const key of ["headOid", "baseOid"] as const) if (facts[key] === "") {
    ctx.addIssue({ code: "custom", path: [key], message: "Open PRs require verified commit identities" });
  }
});
export type AdvanceFacts = z.infer<typeof advanceFactsSchema>;
export const advanceInspectionSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), facts: advanceFactsSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(800) }).strict(),
]);
export type AdvanceInspection = z.infer<typeof advanceInspectionSchema>;

export const advanceWorkspaceInputSchema = z.object({
  sourcePath: z.string().max(1_000), prUrl: z.string().max(500),
  expectedHeadOid: z.string().regex(/^[0-9a-f]{40}$/u), expectedBaseOid: z.string().regex(/^[0-9a-f]{40}$/u),
  batchId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u), jobId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u),
}).strict();
export type AdvanceWorkspaceInput = z.infer<typeof advanceWorkspaceInputSchema>;
export const advanceWorkspaceSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), path: z.string(), workerPath: z.string(), sourcePath: z.string(), created: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(800) }).strict(),
]);
export type AdvanceWorkspace = z.infer<typeof advanceWorkspaceSchema>;
