import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor, Store } from "./store.js";
import { stableId, stableJson } from "./domain/shared.js";
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
export const revalidationDefinitionSchema = z.object({
  target: revalidationTargetSchema, mode: z.enum(["replay", "challenge", "new-environment"]),
  concern: prose, // Deliberately not trimmed or rewritten: preserve the owner's skepticism verbatim.
  claim: z.object({ id, text: prose, scope: prose, originalEvidenceRefs: z.array(prose).max(100), requiredEvidence: requirement }).strict(),
  comparator: prose.nullable(), workload: z.object({ description: prose, manifestDigest: digest }).strict().nullable(),
  criteria: z.array(revalidationCriterionSchema).max(100),
  sample: z.object({ minimumPairs: count.positive(), minimumExposure: finite.positive().nullable(), exposureUnit: prose.nullable() }).strict()
    .refine(s => (s.minimumExposure === null) === (s.exposureUnit === null), "Exposure requires both amount and unit").nullable(),
  environment: revalidationEnvironmentSchema.nullable(),
  limits: z.object({ maxDurationMs: count.positive(), maxCalls: count.positive(), maxCostMicros: count.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/), allowUnknownCost: z.boolean() }).strict().nullable(),
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
  artifact: { target: RevalidationTarget; content: string }; environmentDigest: string; workloadDigest: string; frozenAtMs: number }
export interface RevalidationBinding { planDigest: string; artifactDigest: string; environmentDigest: string; workloadDigest: string }
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
export interface RevalidationOptions { redact: (value: string) => string; now?: () => number }
const hash = (value: unknown): string => createHash("sha256").update(stableJson(value)).digest("hex");
const contentDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const revalidationEnvironmentDigest = (environment: RevalidationEnvironment): string => hash(revalidationEnvironmentSchema.parse(environment));
const versionKey = (planId: string, version: number) => `${planId}:${version}`;
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
function editor(actor: Actor, ownerOnly = false): void {
  if (ownerOnly ? actor.kind !== "owner" : !["owner", "chat"].includes(actor.kind)) throw new Error("revalidation-owner-action-required");
  id.parse(actor.id);
}
function qualifies(kind: RevalidationEvidence["kind"], needed: EvidenceRequirement): boolean {
  return needed === "exploratory" ? kind.startsWith("exploratory-") : needed === "observational" && kind === "observational";
}

/** Keep executor private to server-owned code. Only `plans` belongs in RPC/chat adapters.
 * No method here writes trusted-evaluations, validated-artifacts or activation state.
 */
export function createRevalidation(store: Store, options: RevalidationOptions) {
  const now = () => { const value = options.now?.() ?? Date.now(); count.parse(value); return value; };
  function privateText(value: unknown): void {
    if (typeof value === "string" && options.redact(value) !== value) throw new Error("revalidation-private-input");
    if (Array.isArray(value)) value.forEach(privateText);
    else if (value && typeof value === "object") Object.values(value).forEach(privateText);
  }
  function definition(raw: unknown): RevalidationDefinition {
    const value = revalidationDefinitionSchema.parse(raw); privateText(value);
    if (value.environment?.configuration.some(c => /secret|password|token|credential|authorization|api.?key|private.?key/i.test(c.name) || /-----BEGIN .*PRIVATE KEY-----|\bBearer\s+\S+|:\/\/[^/\s]+:[^/@\s]+@/i.test(c.value))) throw new Error("revalidation-secret-configuration");
    return value;
  }
  function head(planId: string) {
    const value = store.get<{ version: number }>("revalidation-heads", id.parse(planId));
    if (!value) throw new Error("revalidation-plan-missing"); return value;
  }
  function plan(planId: string, version = head(planId).version): RevalidationPlan {
    const value = store.get<RevalidationPlan>("revalidation-plans", versionKey(planId, version));
    if (!value) throw new Error("revalidation-version-missing"); return value;
  }
  function artifact(target: RevalidationTarget): FrozenRevalidationPlan["artifact"] {
    if (!store.get("solutions", target.solutionId)) throw new Error("revalidation-solution-missing");
    const saved = store.get<{ solutionId: string; revision: string; content: string; artifactDigest: string; kind: string }>(target.namespace, target.artifactId);
    if (saved?.solutionId === target.solutionId && saved.revision === target.revision) {
      if (saved.kind !== "instruction" || typeof saved.content !== "string" || saved.artifactDigest !== target.artifactDigest || contentDigest(saved.content) !== target.artifactDigest) throw new Error("revalidation-artifact-changed");
      privateText(saved.content); return { target, content: saved.content };
    }
    // A historical validated-artifacts pointer may advance. Previously frozen bytes remain exact.
    const prior = store.list<FrozenRevalidationPlan>("revalidation-frozen").find(p => same(p.artifact.target, target));
    if (prior && contentDigest(prior.artifact.content) === target.artifactDigest) { privateText(prior.artifact.content); return prior.artifact; }
    throw new Error("revalidation-artifact-missing");
  }
  function freezeRecord(planId: string, version: number): FrozenRevalidationPlan {
    const frozen = store.get<FrozenRevalidationPlan>("revalidation-frozen", versionKey(planId, version));
    if (!frozen) throw new Error("revalidation-plan-not-frozen");
    const expected = hash({ planId, version, definition: frozen.definition, artifact: frozen.artifact });
    if (frozen.planDigest !== expected || contentDigest(frozen.artifact.content) !== frozen.definition.target.artifactDigest ||
      frozen.environmentDigest !== revalidationEnvironmentDigest(frozen.definition.environment!) || frozen.workloadDigest !== frozen.definition.workload?.manifestDigest) throw new Error("revalidation-frozen-input-changed");
    return frozen;
  }
  function run(runId: string): RevalidationRun {
    const value = store.get<RevalidationRun>("revalidation-runs", id.parse(runId));
    if (!value) throw new Error("revalidation-run-missing"); return value;
  }
  function binding(frozen: FrozenRevalidationPlan): RevalidationBinding {
    return { planDigest: frozen.planDigest, artifactDigest: frozen.definition.target.artifactDigest, environmentDigest: frozen.environmentDigest, workloadDigest: frozen.workloadDigest };
  }
  function updateRun(value: RevalidationRun, actor: Actor, reason: string): RevalidationRun {
    store.edit("revalidation-runs", value.id, store.version("revalidation-runs", value.id), value, actor, reason); return value;
  }
  function finishOperational(runId: string, status: "blocked" | "failed" | "cancelled", reason: string, actor: Actor, lease?: string): RevalidationRun {
    prose.parse(reason); privateText(reason);
    return store.transaction(() => {
      const current = run(runId);
      // plans.cancel authenticates the owner and checks the optimistic version in
      // this transaction. Only executor writes require the private worker lease.
      const ownerCancellation = status === "cancelled" && actor.kind === "owner";
      if (current.status === "running" && !ownerCancellation && (lease === undefined || store.get<{ lease: string }>("revalidation-leases", runId)?.lease !== lease)) throw new Error("revalidation-stale-executor");
      if (!["queued", "running"].includes(current.status)) {
        if (current.status === status && current.reason === reason) return current;
        throw new Error("revalidation-run-terminal");
      }
      const next = updateRun({ ...current, status, verdict: null, reason, endedAtMs: now() }, actor, reason);
      store.remove("revalidation-leases", runId); return next;
    });
  }
  const plans = {
    create(raw: z.infer<typeof createRevalidationSchema>, actor: Actor): RevalidationPlan {
      editor(actor); const input = createRevalidationSchema.parse(raw), def = definition(input.definition);
      return store.transaction(() => {
        const planId = stableId("revalidation", input.requestId);
        const existing = store.get<{ fingerprint: string }>("revalidation-requests", input.requestId);
        if (existing) { if (existing.fingerprint !== hash(def)) throw new Error("revalidation-request-conflict"); return plan(planId, 1); }
        artifact(def.target);
        const value: RevalidationPlan = { id: planId, version: 1, previousVersion: null, definition: def, createdAtMs: now(), actor: { ...actor } };
        store.createAudited("revalidation-plans", versionKey(planId, 1), value, actor, "Create a revalidation draft; claim is under review");
        store.createAudited("revalidation-heads", planId, { version: 1 }, actor, "Select initial revalidation version");
        store.put("revalidation-requests", input.requestId, { fingerprint: hash(def) }); return value;
      });
    },
    revise(raw: z.infer<typeof reviseRevalidationSchema>, actor: Actor): RevalidationPlan {
      editor(actor); const input = reviseRevalidationSchema.parse(raw), def = definition(input.definition);
      return store.transaction(() => {
        if (head(input.planId).version !== input.expectedVersion) throw new Error("revalidation-version-conflict");
        const old = plan(input.planId);
        if (!same(old.definition.target, def.target) || !same(old.definition.claim, def.claim)) throw new Error("revalidation-new-claim-needs-new-plan");
        // A different environment is a separate question, not a way to move an unresolved
        // contradiction out of its original scope. Null drafts may still be clarified.
        if (old.definition.environment !== null && !same(old.definition.environment, def.environment)) throw new Error("revalidation-new-environment-needs-new-plan");
        artifact(def.target);
        const value: RevalidationPlan = { ...old, version: old.version + 1, previousVersion: old.version, definition: def, createdAtMs: now(), actor: { ...actor } };
        store.createAudited("revalidation-plans", versionKey(value.id, value.version), value, actor, "Revise criteria in a new immutable plan version");
        store.edit("revalidation-heads", value.id, store.version("revalidation-heads", value.id), { version: value.version }, actor, "Select revised plan; prior plans and results are retained"); return value;
      });
    },
    freeze(raw: z.infer<typeof freezeRevalidationSchema>, actor: Actor): FrozenRevalidationPlan {
      editor(actor, true); const input = freezeRevalidationSchema.parse(raw);
      return store.transaction(() => {
        if (head(input.planId).version !== input.expectedVersion) throw new Error("revalidation-version-conflict");
        const value = plan(input.planId), def = definition(value.definition), key = versionKey(value.id, value.version);
        if (store.get("revalidation-frozen", key)) return freezeRecord(value.id, value.version);
        if (!def.comparator || !def.workload || !def.environment || !def.sample || !def.limits || !def.criteria.some(c => c.role === "primary" && c.required)) throw new Error("revalidation-plan-incomplete");
        const snapshot = artifact(def.target);
        const frozen: FrozenRevalidationPlan = { planId: value.id, version: value.version, definition: def, artifact: snapshot,
          planDigest: hash({ planId: value.id, version: value.version, definition: def, artifact: snapshot }),
          environmentDigest: revalidationEnvironmentDigest(def.environment), workloadDigest: def.workload.manifestDigest, frozenAtMs: now() };
        store.createAudited("revalidation-frozen", key, frozen, actor, "Freeze criteria and exact artifact before execution"); return frozen;
      });
    },
    queue(raw: z.infer<typeof queueRevalidationSchema>, actor: Actor): RevalidationRun {
      editor(actor, true); const input = queueRevalidationSchema.parse(raw);
      return store.transaction(() => {
        const runId = stableId("revalidation-run", input.requestId), existing = store.get<RevalidationRun>("revalidation-runs", runId);
        if (existing) { if (existing.planId !== input.planId || existing.planVersion !== input.version) throw new Error("revalidation-run-request-conflict"); return existing; }
        if (head(input.planId).version !== input.version) throw new Error("revalidation-version-conflict");
        const frozen = freezeRecord(input.planId, input.version); privateText(frozen.definition); privateText(frozen.artifact.content);
        const sequence = (store.get<number>("revalidation-sequence", "latest") ?? 0) + 1;
        const value: RevalidationRun = { id: runId, requestId: input.requestId, planId: input.planId, planVersion: input.version, sequence,
          binding: binding(frozen), status: "queued", verdict: null, createdAtMs: now(), startedAtMs: null, endedAtMs: null, reason: null };
        store.createAudited("revalidation-runs", runId, value, actor, "Queue a frozen revalidation plan"); store.put("revalidation-sequence", "latest", sequence); return value;
      });
    },
    cancel(input: { runId: string; expectedVersion: number; reason: string }, actor: Actor): RevalidationRun {
      editor(actor, true); return store.transaction(() => {
        if (store.version("revalidation-runs", input.runId) !== input.expectedVersion) throw new Error("revalidation-run-version-conflict");
        return finishOperational(input.runId, "cancelled", input.reason, actor);
      });
    },
    markStale(input: { planId: string; expectedVersion: number; reason: string }, actor: Actor): void {
      editor(actor); prose.parse(input.reason); privateText(input.reason);
      store.transaction(() => {
        if (head(input.planId).version !== input.expectedVersion) throw new Error("revalidation-version-conflict");
        const key = versionKey(input.planId, input.expectedVersion);
        if (!store.get("revalidation-stale", key)) store.createAudited("revalidation-stale", key, { reason: input.reason, atMs: now() }, actor, "Mark this claim scope stale; a new plan version is required");
      });
    },
    get(planId: string, version?: number) { const value = plan(planId, version); return { plan: value, frozen: store.get<FrozenRevalidationPlan>("revalidation-frozen", versionKey(value.id, value.version)) }; },
    list(solutionId?: string) { return store.entries<{ version: number }>("revalidation-heads").map(e => plan(e.key, e.value.version)).filter(p => !solutionId || p.definition.target.solutionId === solutionId); },
    history(planId: string) { head(planId); return { versions: store.list<RevalidationPlan>("revalidation-plans").filter(p => p.id === planId).sort((a, b) => a.version - b.version),
      runs: store.list<RevalidationRun>("revalidation-runs").filter(r => r.planId === planId).sort((a, b) => a.sequence - b.sequence),
      results: store.list<RevalidationResult>("revalidation-results").filter(r => run(r.runId).planId === planId) }; },
    getRun(runId: string) { return { run: run(runId), version: store.version("revalidation-runs", runId), result: store.get<RevalidationResult>("revalidation-results", runId) }; },
    promotionGate(input: { target: RevalidationTarget; claims: Array<{ id: string; scope: string; requiredEvidence: EvidenceRequirement }>; environmentDigest: string }) {
      revalidationTargetSchema.parse(input.target); digest.parse(input.environmentDigest);
      const reasons: string[] = [];
      if (!input.claims.length) reasons.push("no-claims-selected");
      for (const claim of input.claims) {
        id.parse(claim.id); prose.parse(claim.scope); requirement.parse(claim.requiredEvidence);
        const relevant = plans.list(input.target.solutionId).filter(p => same(p.definition.target, input.target) && p.definition.claim.id === claim.id && p.definition.claim.scope === claim.scope);
        const reasonsBefore = reasons.length;
        let supportedEnvironment = false;
        for (const current of relevant) {
          const key = versionKey(current.id, current.version), frozen = store.get<FrozenRevalidationPlan>("revalidation-frozen", key);
          const history = plans.history(current.id);
          const environment = current.definition.environment;
          const matchesEnvironment = environment !== null && revalidationEnvironmentDigest(environment) === input.environmentDigest;
          // Testing environment B does not invalidate A. A general challenge is
          // different: its concern applies to the whole claim, even if its test
          // runs in one environment. Revisions cannot silently narrow it away.
          const generalChallenge = history.versions.some(p => p.definition.mode === "challenge");
          if (environment !== null && !matchesEnvironment && !generalChallenge) continue;
          if (store.get("revalidation-stale", key)) { reasons.push(`${claim.id}:stale`); continue; }
          const latest = history.runs.filter(r => r.planVersion === current.version).at(-1);
          if (!frozen || !latest) {
            reasons.push(`${claim.id}:${environment === null ? "pending-unspecified-environment" : generalChallenge ? "pending-general-challenge" : "pending"}`); continue;
          }
          if (latest.status !== "completed") { reasons.push(`${claim.id}:${latest.status}`); continue; }
          const result = store.get<RevalidationResult>("revalidation-results", latest.id);
          if (!result || !same(result.binding, binding(freezeRecord(current.id, current.version)))) { reasons.push(`${claim.id}:missing-evidence`); continue; }
          if (result.verdict !== "supported") reasons.push(`${claim.id}:${result.verdict}`);
          // A resolved general challenge supplies positive evidence only for its
          // actual frozen environment; another advertised environment needs its own.
          if (matchesEnvironment) {
            if (!qualifies(result.evidence.kind, claim.requiredEvidence)) reasons.push(`${claim.id}:insufficient-evidence-class`);
            else if (result.verdict === "supported") supportedEnvironment = true;
          }
        }
        if (!supportedEnvironment && reasons.length === reasonsBefore) reasons.push(`${claim.id}:${relevant.length ? "untested-environment" : "unassessed"}`);
      }
      return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
    },
  };

  // These operations are capabilities for the trusted server executor, never RPC/chat input handlers.
  const executor = {
    start(input: { runId: string; expectedVersion: number }): { run: RevalidationRun; lease: string | null } {
      return store.transaction(() => {
        if (store.version("revalidation-runs", input.runId) !== input.expectedVersion) throw new Error("revalidation-run-version-conflict");
        const current = run(input.runId);
        if (current.status !== "queued") throw new Error("revalidation-run-not-queued");
        const frozen = freezeRecord(current.planId, current.planVersion); privateText(frozen.definition); privateText(frozen.artifact.content);
        const reason = head(current.planId).version !== current.planVersion ? "plan-superseded" : store.get("revalidation-stale", versionKey(current.planId, current.planVersion)) ? "claim-scope-stale" :
          frozen.definition.criteria.some(c => c.evaluator === "unsupported") ? "unsupported-criterion" :
          ["held-out", "causal"].includes(frozen.definition.claim.requiredEvidence) ? "required-evidence-capability-unavailable" : null;
        if (reason) return { run: finishOperational(current.id, "blocked", reason, { kind: "service", id: "revalidation-executor" }), lease: null };
        const lease = randomUUID(); store.put("revalidation-leases", current.id, { lease });
        return { run: updateRun({ ...current, status: "running", startedAtMs: now() }, { kind: "service", id: "revalidation-executor" }, "Start exact frozen revalidation"), lease };
      });
    },
    block(input: { runId: string; reason: string; lease?: string }) { return finishOperational(input.runId, "blocked", input.reason, { kind: "service", id: "revalidation-executor" }, input.lease); },
    fail(input: { runId: string; reason: string; lease: string }) { return finishOperational(input.runId, "failed", input.reason, { kind: "service", id: "revalidation-executor" }, input.lease); },
    cancel(input: { runId: string; reason: string; lease: string }) { return finishOperational(input.runId, "cancelled", input.reason, { kind: "service", id: "revalidation-executor" }, input.lease); },
    complete(input: { runId: string; lease: string; binding: RevalidationBinding; observations: RevalidationObservation[]; evidence: RevalidationEvidence; usage: RevalidationUsage }): RevalidationResult {
      const observations = z.array(observationSchema).max(100).parse(input.observations), evidence = evidenceSchema.parse(input.evidence), usage = usageSchema.parse(input.usage);
      privateText({ observations, evidence });
      return store.transaction(() => {
        const current = run(input.runId), frozen = freezeRecord(current.planId, current.planVersion);
        if (!same(input.binding, current.binding) || !same(current.binding, binding(frozen))) throw new Error("revalidation-result-binding-mismatch");
        const existing = store.get<RevalidationResult>("revalidation-results", current.id);
        const completionDigest = hash({ ...input, observations, evidence, usage });
        if (existing) {
          if (store.get("revalidation-completions", current.id) !== completionDigest) throw new Error("revalidation-result-immutable"); return existing;
        }
        if (current.status !== "running" || store.get<{ lease: string }>("revalidation-leases", current.id)?.lease !== input.lease) throw new Error("revalidation-stale-executor");
        privateText(frozen.definition); privateText(frozen.artifact.content);
        if (evidence.kind === "exploratory-replay" && frozen.definition.mode !== "replay" || evidence.kind === "exploratory-challenge" && frozen.definition.mode === "replay") throw new Error("revalidation-evidence-mode-mismatch");
        if (new Set(observations.map(o => o.criterionId)).size !== observations.length || observations.some(o => !frozen.definition.criteria.some(c => c.id === o.criterionId))) throw new Error("revalidation-observation-identity-mismatch");
        const limits = frozen.definition.limits!;
        if (usage.calls > limits.maxCalls || usage.elapsedMs > limits.maxDurationMs || now() - current.startedAtMs! > limits.maxDurationMs || usage.currency !== limits.currency ||
          usage.costMicros === null && !limits.allowUnknownCost || usage.costMicros !== null && limits.maxCostMicros !== null && usage.costMicros > limits.maxCostMicros) throw new Error("revalidation-execution-limit-exceeded");
        const criteria: CriterionAssessment[] = frozen.definition.criteria.map(c => {
          const o = observations.find(row => row.criterionId === c.id), sample = frozen.definition.sample!;
          let value: number | null = null, reason: string | null = null;
          if (c.evaluator !== "numeric-comparison-v1") reason = "unsupported-criterion";
          else if (!o) reason = "missing-observation";
          else if (o.metric !== c.metric || o.unit !== c.unit) throw new Error("revalidation-metric-unit-mismatch");
          else if (o.receiptRefs.some(ref => !evidence.receiptRefs.includes(ref))) throw new Error("revalidation-observation-receipt-mismatch");
          else if (o.pairs < sample.minimumPairs || sample.minimumExposure !== null && (o.exposure === null || o.exposure < sample.minimumExposure || o.exposureUnit !== sample.exposureUnit)) reason = "insufficient-exposure";
          else if (o.baseline === null || o.treatment === null) reason = "missing-comparison";
          else if (c.statistic === "relative-change" && o.baseline === 0) reason = "zero-comparator";
          else { value = c.statistic === "treatment" ? o.treatment : c.statistic === "difference" ? o.treatment - o.baseline : (o.treatment - o.baseline) / Math.abs(o.baseline); if (!Number.isFinite(value)) { value = null; reason = "nonfinite-comparison"; } }
          return { criterionId: c.id, value, reason, status: reason ? "inconclusive" : (c.threshold.operator === "at-least" ? value! >= c.threshold.value : value! <= c.threshold.value) ? "threshold-met" : "threshold-not-met" };
        });
        const required = criteria.filter(c => frozen.definition.criteria.find(d => d.id === c.criterionId)!.required);
        // Optional unsupported/missing measures remain visible and never silently increase confidence.
        const verdict: ClaimVerdict = !qualifies(evidence.kind, frozen.definition.claim.requiredEvidence) || criteria.some(c => c.status === "inconclusive") ? "inconclusive" : required.some(c => c.status === "threshold-not-met") ? "contradicted" : "supported";
        const result: RevalidationResult = { runId: current.id, binding: current.binding, verdict, observations, criteria, evidence, usage, observedAtMs: now() };
        store.insert("revalidation-results", current.id, result); store.put("revalidation-completions", current.id, completionDigest);
        updateRun({ ...current, status: "completed", verdict, endedAtMs: result.observedAtMs }, { kind: "service", id: "revalidation-executor" }, "Record scoped evidence; artifact and previous assessments remain unchanged");
        store.remove("revalidation-leases", current.id); return result;
      });
    },
  };
  return { plans, executor };
}
