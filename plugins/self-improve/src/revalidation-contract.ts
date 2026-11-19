import { z } from "zod";
import type { Actor } from "./store.js";
import { executionSelectionSchema, type ExecutionSelection } from "./native-execution.js";

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const prose = z.string().min(1).max(4000).refine(value => !!value.trim() && !value.includes("\0"));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** The exact instruction artifact under test. */
export const revalidationTargetSchema = z.object({
  solutionId: id, namespace: z.enum(["native-evaluation-artifacts", "built-artifacts", "validated-artifacts"]),
  artifactId: id, revision: id, artifactDigest: digest,
}).strict();

/** One test: the input the model sees and the exact answer the server expects. */
export const revalidationCaseSchema = z.object({ id, input: z.string().min(1).max(16000), expected: z.string().max(8000) }).strict();

/**
 * A pass criterion. `pass-rate` is the share of cases answered exactly; `regressions` counts cases that pass
 * without the instruction but fail with it. `treatment` judges the run with the instruction alone; `difference`
 * judges it minus the run without.
 */
export const revalidationCriterionSchema = z.object({
  id, measure: z.enum(["pass-rate", "regressions"]), statistic: z.enum(["treatment", "difference"]),
  operator: z.enum(["at-least", "at-most"]), value: z.number().finite(), required: z.boolean(),
}).strict().refine(c => c.measure !== "regressions" || c.statistic === "treatment", "Regressions are counted on the run with the instruction");

export const revalidationLimitsSchema = z.object({
  maxDurationMs: z.number().int().min(60_000).max(7 * 24 * 60 * 60 * 1000),
}).strict();

export const revalidationDefinitionSchema = z.object({
  target: revalidationTargetSchema,
  concern: prose, // Kept verbatim: the owner's doubt in their own words.
  claim: z.object({ id, text: prose }).strict(),
  cases: z.array(revalidationCaseSchema).max(50),
  criteria: z.array(revalidationCriterionSchema).max(20),
  limits: revalidationLimitsSchema,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.cases.map(c => c.id)).size !== value.cases.length) ctx.addIssue({ code: "custom", message: "Case IDs must be unique" });
  if (new Set(value.criteria.map(c => c.id)).size !== value.criteria.length) ctx.addIssue({ code: "custom", message: "Criterion IDs must be unique" });
  if (value.cases.some(c => !c.input.trim() || c.input.includes("\0") || c.expected.includes("\0"))) ctx.addIssue({ code: "custom", message: "Invalid case text" });
});

export const createRevalidationSchema = z.object({ requestId: id, definition: revalidationDefinitionSchema }).strict();
export const reviseRevalidationSchema = z.object({ planId: id, expectedVersion: count.positive(), definition: revalidationDefinitionSchema }).strict();
export const freezeRevalidationSchema = z.object({ planId: id, expectedVersion: count.positive() }).strict();
export const queueRevalidationSchema = z.object({ planId: id, version: count.positive(), requestId: id }).strict();
export const cancelRevalidationSchema = z.object({ runId: id, reason: prose }).strict();

export type RevalidationTarget = z.infer<typeof revalidationTargetSchema>;
export type RevalidationCase = z.infer<typeof revalidationCaseSchema>;
export type RevalidationCriterion = z.infer<typeof revalidationCriterionSchema>;
export type RevalidationDefinition = z.infer<typeof revalidationDefinitionSchema>;

export interface RevalidationPlan { id: string; version: number; previousVersion: number | null; definition: RevalidationDefinition; createdAtMs: number; actor: Actor }
/** Written once at freeze. A run uses exactly these bytes, cases, criteria and worker settings. */
export interface FrozenRevalidationPlan {
  planId: string; version: number; definition: RevalidationDefinition;
  artifact: { target: RevalidationTarget; content: string };
  testedOn: ExecutionSelection; planDigest: string; frozenAtMs: number;
}
export type RevalidationRunStatus = "queued" | "running" | "blocked" | "failed" | "cancelled" | "completed";
export type ClaimVerdict = "supported" | "contradicted";
export interface RevalidationRun {
  id: string; requestId: string; planId: string; planVersion: number; planDigest: string; sequence: number;
  status: RevalidationRunStatus; verdict: ClaimVerdict | null; reason: string | null;
  createdAtMs: number; startedAtMs: number | null; endedAtMs: number | null;
}
/** Server-scored outcome of one arm of one case. The model's answer itself is never stored. */
export interface RevalidationReceipt {
  runId: string; caseId: string; arm: "baseline" | "treatment"; taskId: string; threadId: string;
  answerDigest: string; readable: boolean; passed: boolean;
}
export interface CriterionAssessment { criterionId: string; value: number; status: "threshold-met" | "threshold-not-met" }
export interface RevalidationResult {
  runId: string; planDigest: string; verdict: ClaimVerdict;
  cases: number; passed: { baseline: number; treatment: number }; regressions: number; unreadable: { baseline: number; treatment: number };
  criteria: CriterionAssessment[]; completedAtMs: number;
}

export { id as revalidationIdSchema, prose as revalidationProseSchema, digest as revalidationDigestSchema, count as revalidationCountSchema, executionSelectionSchema };
