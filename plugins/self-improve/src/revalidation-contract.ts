import { z } from "zod";
import type { ObservedRevalidationEnvironment } from "./revalidation-environment.js";
import type { Actor } from "./store.js";
import { executionSelectionSchema } from "./native-execution.js";

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const prose = z.string().min(1).max(4000).refine(value => !!value.trim() && !value.includes("\0"));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requirement = z.enum(["exploratory", "observational", "held-out", "causal"]);
export const revalidationTargetSchema = z.object({
  solutionId: id, namespace: z.enum(["native-evaluation-artifacts", "built-artifacts", "validated-artifacts"]),
  artifactId: id, revision: id, artifactDigest: digest,
}).strict();
export const revalidationCriterionSchema = z.object({
  id, role: z.enum(["primary", "guardrail"]), required: z.boolean(),
  evaluator: z.enum(["numeric-comparison-v1", "unsupported"]), metric: prose, unit: prose,
  statistic: z.enum(["treatment", "difference", "relative-change"]),
  threshold: z.object({ operator: z.enum(["at-least", "at-most"]), value: finite }).strict(),
  unsupportedReason: prose.nullable(),
}).strict().refine(c => c.evaluator === "unsupported" ? c.unsupportedReason !== null : c.unsupportedReason === null,
  "Unsupported criteria need an explicit reason; numeric criteria cannot declare one");
export const revalidationEnvironmentSchema = z.object({
  declaredNonsecret: z.literal(true),
  dependencies: z.array(z.object({ kind: z.enum(["plugin", "skill", "tool", "runtime"]), name: prose, version: prose, setup: prose }).strict()).max(100),
  configuration: z.array(z.object({ name: prose, value: prose }).strict()).max(100),
  untested: z.array(prose).max(100), execution: executionSelectionSchema,
}).strict();

export const REVALIDATION_PROTOCOL = "paired-exact-instruction-v1" as const;
export const revalidationWorkloadDefinitionSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal(REVALIDATION_PROTOCOL), description: prose,
  cases: z.array(z.object({ id, familyId: id, input: z.string().min(1).max(16000), expected: z.string().max(8000) }).strict()).min(1).max(50),
  measurements: z.array(z.object({ criterionId: id, kind: z.enum(["exact-pass-rate", "regression-count"]) }).strict()).min(1).max(100),
  normalization: z.literal("none"), baseline: z.literal("no-added-instruction"), orderPolicy: z.literal("alternating-arms-v1"), response: z.literal("json-output-string-v1"),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.cases.map(c => c.id)).size !== value.cases.length) ctx.addIssue({code:"custom",message:"Case IDs must be unique"});
  if (new Set(value.cases.map(c => c.input)).size !== value.cases.length) ctx.addIssue({code:"custom",message:"Case inputs must be unique"});
  if (new Set(value.measurements.map(m => m.criterionId)).size !== value.measurements.length) ctx.addIssue({code:"custom",message:"Measurement bindings must be unique"});
  if (value.cases.some(c => !c.input.trim() || c.input.includes("\0") || c.expected.includes("\0"))) ctx.addIssue({code:"custom",message:"Invalid case text"});
  if (JSON.stringify(value).length > 400000) ctx.addIssue({code:"custom",message:"Workload exceeds serialized size limit"});
});
export const revalidationWorkloadRefSchema = z.object({id,version:count.positive(),description:prose,manifestDigest:digest}).strict();
export const createRevalidationWorkloadSchema = z.object({requestId:id,definition:revalidationWorkloadDefinitionSchema}).strict();
export const reviseRevalidationWorkloadSchema = z.object({id,expectedVersion:count.positive(),definition:revalidationWorkloadDefinitionSchema}).strict();
export type RevalidationWorkloadDefinition = z.infer<typeof revalidationWorkloadDefinitionSchema>;
export type RevalidationWorkloadRef = z.infer<typeof revalidationWorkloadRefSchema>;
export interface RevalidationWorkload {id:string;version:number;previousVersion:number|null;manifestDigest:string;definition:RevalidationWorkloadDefinition;createdAtMs:number;actor:Actor}
export type RevalidationWorkloadSnapshot = Pick<RevalidationWorkload,"id"|"version"|"manifestDigest"|"definition">;

export const revalidationDefinitionSchema = z.object({
  target: revalidationTargetSchema, mode: z.enum(["replay", "challenge", "new-environment"]),
  concern: prose, // Deliberately not trimmed or rewritten: preserve the owner's skepticism verbatim.
  claim: z.object({ id, text: prose, scope: prose, originalEvidenceRefs: z.array(prose).max(100), requiredEvidence: requirement }).strict(),
  comparator: prose.nullable(), workload: z.union([revalidationWorkloadRefSchema, z.object({ description: prose, manifestDigest: digest }).strict()]).nullable(),
  criteria: z.array(revalidationCriterionSchema).max(100),
  sample: z.object({ minimumPairs: count.positive(), minimumExposure: finite.positive().nullable(), exposureUnit: prose.nullable() }).strict()
    .refine(s => (s.minimumExposure === null) === (s.exposureUnit === null), "Exposure requires both amount and unit").nullable(),
  environment: revalidationEnvironmentSchema.nullable(),
  limits: z.object({ maxDurationMs: count.positive(), maxCalls: count.positive(), maxCostMicros: count.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/), allowUnknownCost: z.boolean(), moneyLimitMode: z.enum(["observed-admission", "hard"]).optional() }).strict().nullable(),
}).strict().refine(d => new Set(d.criteria.map(c => c.id)).size === d.criteria.length, "Criterion IDs must be unique");
export const createRevalidationSchema = z.object({ requestId: id, definition: revalidationDefinitionSchema }).strict();
export const reviseRevalidationSchema = z.object({ planId: id, expectedVersion: count.positive(), definition: revalidationDefinitionSchema }).strict();
export const freezeRevalidationSchema = z.object({ planId: id, expectedVersion: count.positive() }).strict();
export const queueRevalidationSchema = z.object({ planId: id, version: count.positive(), requestId: id }).strict();
export type RevalidationTarget = z.infer<typeof revalidationTargetSchema>;
export type RevalidationDefinition = z.infer<typeof revalidationDefinitionSchema>;
export type RevalidationEnvironment = z.infer<typeof revalidationEnvironmentSchema>;
export type EvidenceRequirement = z.infer<typeof requirement>;
export interface RevalidationPlan { id: string; version: number; previousVersion: number | null; definition: RevalidationDefinition; createdAtMs: number; actor: Actor }
export interface FrozenRevalidationPlan { planId: string; version: number; planDigest: string; definition: RevalidationDefinition;
  schemaVersion?: 2; protocol?: typeof REVALIDATION_PROTOCOL; workload?: RevalidationWorkloadSnapshot;
  observedEnvironment?: ObservedRevalidationEnvironment; environmentObservationDigest?: string;
  artifact: { target: RevalidationTarget; content: string }; environmentDigest: string; workloadDigest: string; frozenAtMs: number }
export interface RevalidationBinding { protocol?: typeof REVALIDATION_PROTOCOL; environmentObservationDigest?: string; planDigest: string; artifactDigest: string; environmentDigest: string; workloadDigest: string }
export type RevalidationExecutionStatus = "queued" | "running" | "blocked" | "failed" | "cancelled" | "completed";
export type ClaimVerdict = "supported" | "contradicted" | "inconclusive";
export interface RevalidationRun { id: string; planId: string; planVersion: number; sequence: number; requestId: string; binding: RevalidationBinding;
  status: RevalidationExecutionStatus; verdict: ClaimVerdict | null; createdAtMs: number; startedAtMs: number | null; endedAtMs: number | null; reason: string | null }
const observationSchema = z.object({ criterionId: id, metric: prose, unit: prose, baseline: finite.nullable(), treatment: finite.nullable(),
  pairs: count, exposure: finite.nonnegative().nullable(), exposureUnit: prose.nullable(), receiptRefs: z.array(prose).min(1).max(100) }).strict();
const evidenceSchema = z.object({ kind: z.enum(["exploratory-replay", "exploratory-challenge", "observational"]),
  receiptRefs: z.array(prose).min(1).max(100), limitations: z.array(prose).min(1).max(100) }).strict();
const usageSchema = z.object({ calls: count, elapsedMs: count, costMicros: count.nullable(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export type RevalidationObservation = z.infer<typeof observationSchema>;
export type RevalidationEvidence = z.infer<typeof evidenceSchema>;
export type RevalidationUsage = z.infer<typeof usageSchema>;
export interface CriterionAssessment { criterionId: string; status: "threshold-met" | "threshold-not-met" | "inconclusive"; value: number | null; reason: string | null }
export interface RevalidationResult { runId: string; binding: RevalidationBinding; verdict: ClaimVerdict; observations: RevalidationObservation[];
  criteria: CriterionAssessment[]; evidence: RevalidationEvidence; usage: RevalidationUsage; observedAtMs: number }

export { id as revalidationIdSchema, prose as revalidationProseSchema, digest as revalidationDigestSchema, count as revalidationCountSchema, requirement as revalidationRequirementSchema };

export const revalidationUsageJournalInputSchema = z.object({
  runId:id, requestId:id, binding:z.object({planDigest:digest,artifactDigest:digest,environmentDigest:digest,workloadDigest:digest,
    protocol:z.literal(REVALIDATION_PROTOCOL).optional(),environmentObservationDigest:digest.optional()}).strict(),
  usage:usageSchema, taskIds:z.array(id).max(100), unknownReasons:z.array(prose).max(100), observedCostFloorMicros:count.nullable().optional(),
}).strict().refine(value=>new Set(value.taskIds).size===value.taskIds.length,"Task identities must be unique");
export type RevalidationUsageJournalInput = z.infer<typeof revalidationUsageJournalInputSchema>;
export interface RevalidationUsageJournalEntry extends RevalidationUsageJournalInput {id:string;sequence:number;recordedAtMs:number}
