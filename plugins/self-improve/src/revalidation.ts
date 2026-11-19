import { createHash } from "node:crypto";
import type { Actor, Store } from "./store.js";
import { stableId, stableJson } from "./domain/shared.js";
import {
  revalidationIdSchema as id, revalidationProseSchema as prose, createRevalidationSchema, reviseRevalidationSchema,
  freezeRevalidationSchema, queueRevalidationSchema, cancelRevalidationSchema, executionSelectionSchema,
  type RevalidationTarget, type RevalidationDefinition, type RevalidationPlan, type FrozenRevalidationPlan,
  type RevalidationRun, type RevalidationResult, type RevalidationRunStatus, type ClaimVerdict,
} from "./revalidation-contract.js";
import type { ExecutionSelection } from "./native-execution.js";
export * from "./revalidation-contract.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const versionKey = (planId: string, version: number) => `${planId}:${version}`;
const ACTIVE: RevalidationRunStatus[] = ["queued", "running"];
export const REVALIDATION_NAMESPACES = { plans: "revalidation-plans", heads: "revalidation-heads", frozen: "revalidation-frozen", runs: "revalidation-runs", results: "revalidation-results", receipts: "revalidation-receipts", requests: "revalidation-requests" } as const;
const NS = REVALIDATION_NAMESPACES;

function requireActor(actor: Actor, ownerOnly: boolean): void {
  if (ownerOnly ? actor.kind !== "owner" : actor.kind !== "owner" && actor.kind !== "chat") throw new Error("revalidation-owner-action-required");
  id.parse(actor.id);
}

/**
 * Revalidation plans, runs and results. `plans` is the owner/chat domain; `executor` is used only by the server's runner.
 * The guarantees it enforces are listed in docs/revalidation.md (owner authority, frozen integrity, honest verdicts).
 */
export function createRevalidation(store: Store, options: { redact: (value: string) => string; now?: () => number }) {
  const now = () => options.now?.() ?? Date.now();
  /** Text the current privacy policy would rewrite is refused rather than silently changed. */
  function privateText(value: unknown): void {
    if (typeof value === "string" && options.redact(value) !== value) throw new Error("revalidation-private-input");
    if (Array.isArray(value)) value.forEach(privateText);
    else if (value && typeof value === "object") Object.values(value).forEach(privateText);
  }
  const head = (planId: string) => {
    const value = store.get<{ version: number }>(NS.heads, id.parse(planId));
    if (!value) throw new Error("revalidation-plan-missing"); return value.version;
  };
  const plan = (planId: string, version = head(planId)) => {
    const value = store.get<RevalidationPlan>(NS.plans, versionKey(planId, version));
    if (!value) throw new Error("revalidation-version-missing"); return value;
  };
  const run = (runId: string) => {
    const value = store.get<RevalidationRun>(NS.runs, id.parse(runId));
    if (!value) throw new Error("revalidation-run-missing"); return value;
  };
  const frozenPlan = (planId: string, version: number) => {
    const value = store.get<FrozenRevalidationPlan>(NS.frozen, versionKey(planId, version));
    if (!value) throw new Error("revalidation-plan-not-frozen"); return value;
  };
  const runs = (planId: string) => store.list<RevalidationRun>(NS.runs).filter(r => r.planId === planId).sort((a, b) => a.sequence - b.sequence);
  function artifact(target: RevalidationTarget): FrozenRevalidationPlan["artifact"] {
    if (!store.get("solutions", target.solutionId)) throw new Error("revalidation-solution-missing");
    const saved = store.get<{ solutionId: string; revision: string; content: string; kind: string }>(target.namespace, target.artifactId);
    if (!saved || saved.solutionId !== target.solutionId || saved.revision !== target.revision || saved.kind !== "instruction" || typeof saved.content !== "string" || sha(saved.content) !== target.artifactDigest) throw new Error("revalidation-artifact-changed");
    privateText(saved.content); return { target, content: saved.content };
  }
  function update(value: RevalidationRun, actor: Actor, reason: string): RevalidationRun {
    store.edit(NS.runs, value.id, store.version(NS.runs, value.id), value, actor, reason); return value;
  }
  function end(runId: string, status: "blocked" | "failed" | "cancelled", reason: string, actor: Actor): RevalidationRun {
    prose.parse(reason); privateText(reason);
    return store.transaction(() => {
      const current = run(runId);
      if (!ACTIVE.includes(current.status)) return current;
      return update({ ...current, status, verdict: null, reason, endedAtMs: now() }, actor, reason);
    });
  }

  const plans = {
    create(raw: unknown, actor: Actor): RevalidationPlan {
      requireActor(actor, false); const input = createRevalidationSchema.parse(raw); privateText(input.definition);
      return store.transaction(() => {
        const planId = stableId("revalidation", [actor.kind, actor.id, input.requestId]), fingerprint = sha(stableJson(input.definition));
        const previous = store.get<{ fingerprint: string }>(NS.requests, planId);
        if (previous) { if (previous.fingerprint !== fingerprint) throw new Error("revalidation-request-conflict"); return plan(planId, 1); }
        artifact(input.definition.target);
        const value: RevalidationPlan = { id: planId, version: 1, previousVersion: null, definition: input.definition, createdAtMs: now(), actor: { ...actor } };
        store.createAudited(NS.plans, versionKey(planId, 1), value, actor, "Create a revalidation draft");
        store.createAudited(NS.heads, planId, { version: 1 }, actor, "Select the first plan version");
        store.put(NS.requests, planId, { fingerprint }); return value;
      });
    },
    revise(raw: unknown, actor: Actor): RevalidationPlan {
      requireActor(actor, false); const input = reviseRevalidationSchema.parse(raw); privateText(input.definition);
      return store.transaction(() => {
        if (head(input.planId) !== input.expectedVersion) throw new Error("revalidation-version-conflict");
        const old = plan(input.planId);
        if (stableJson(old.definition) === stableJson(input.definition)) return old;
        if (stableJson(old.definition.target) !== stableJson(input.definition.target) || old.definition.claim.id !== input.definition.claim.id) throw new Error("revalidation-new-claim-needs-new-plan");
        // The chat cannot cancel, so it must not replace a version the owner has queued or is running.
        if (actor.kind === "chat" && runs(input.planId).some(r => r.planVersion === old.version && ACTIVE.includes(r.status))) throw new Error("revalidation-run-active-cancel-first");
        artifact(input.definition.target);
        const value: RevalidationPlan = { ...old, version: old.version + 1, previousVersion: old.version, definition: input.definition, createdAtMs: now(), actor: { ...actor } };
        store.createAudited(NS.plans, versionKey(value.id, value.version), value, actor, "Revise the plan in a new version");
        store.edit(NS.heads, value.id, store.version(NS.heads, value.id), { version: value.version }, actor, "Select the revised version"); return value;
      });
    },
    /** Owner only. Snapshots the instruction bytes and the worker settings the plan will run with. */
    freeze(raw: unknown, testedOn: ExecutionSelection, actor: Actor): FrozenRevalidationPlan {
      requireActor(actor, true); const input = freezeRevalidationSchema.parse(raw), selection = executionSelectionSchema.parse(testedOn);
      return store.transaction(() => {
        if (head(input.planId) !== input.expectedVersion) throw new Error("revalidation-version-conflict");
        const value = plan(input.planId), key = versionKey(value.id, value.version);
        const existing = store.get<FrozenRevalidationPlan>(NS.frozen, key);
        if (existing) return existing;
        const def: RevalidationDefinition = value.definition;
        if (!def.cases.length || !def.criteria.some(c => c.required)) throw new Error("revalidation-plan-incomplete");
        privateText(def);
        const snapshot = artifact(def.target);
        const content = { planId: value.id, version: value.version, definition: def, artifact: snapshot, testedOn: selection };
        const frozen: FrozenRevalidationPlan = { ...content, planDigest: sha(stableJson(content)), frozenAtMs: now() };
        store.createAudited(NS.frozen, key, frozen, actor, "Freeze the plan and the exact instruction under test"); return frozen;
      });
    },
    /** Owner only. Queues the latest frozen version; a repeated request returns the same run. */
    queue(raw: unknown, actor: Actor): RevalidationRun {
      requireActor(actor, true); const input = queueRevalidationSchema.parse(raw);
      return store.transaction(() => {
        const runId = stableId("revalidation-run", input.requestId), existing = store.get<RevalidationRun>(NS.runs, runId);
        if (existing) { if (existing.planId !== input.planId || existing.planVersion !== input.version) throw new Error("revalidation-run-request-conflict"); return existing; }
        if (head(input.planId) !== input.version) throw new Error("revalidation-version-conflict");
        const frozen = frozenPlan(input.planId, input.version);
        const sequence = (store.get<number>("revalidation-sequence", "latest") ?? 0) + 1;
        const value: RevalidationRun = { id: runId, requestId: input.requestId, planId: input.planId, planVersion: input.version, planDigest: frozen.planDigest, sequence,
          status: "queued", verdict: null, reason: null, createdAtMs: now(), startedAtMs: null, endedAtMs: null };
        store.createAudited(NS.runs, runId, value, actor, "Queue a frozen revalidation plan"); store.put("revalidation-sequence", "latest", sequence); return value;
      });
    },
    /** Owner only. A call already in flight may finish, but the run ends without a verdict. */
    cancel(raw: unknown, actor: Actor): RevalidationRun {
      requireActor(actor, true); const input = cancelRevalidationSchema.parse(raw);
      return end(input.runId, "cancelled", input.reason, actor);
    },
    get(planId: string, version?: number) { const value = plan(planId, version); return { plan: value, frozen: store.get<FrozenRevalidationPlan>(NS.frozen, versionKey(value.id, value.version)) }; },
    list(solutionId?: string) { return store.entries<{ version: number }>(NS.heads).map(e => plan(e.key, e.value.version)).filter(p => !solutionId || p.definition.target.solutionId === solutionId); },
    history(planId: string) {
      head(planId);
      const planRuns = runs(planId);
      return { versions: store.list<RevalidationPlan>(NS.plans).filter(p => p.id === planId).sort((a, b) => a.version - b.version),
        runs: planRuns, results: planRuns.flatMap(r => { const result = store.get<RevalidationResult>(NS.results, r.id); return result ? [result] : []; }) };
    },
    getRun(runId: string) { return { run: run(runId), result: store.get<RevalidationResult>(NS.results, runId) }; },
    /**
     * Across every plan for the claim, the most recently frozen version decides: its latest completed run's verdict,
     * or no standing until one completes. Earlier results stay in the history.
     */
    standing(solutionId: string, claimId: string): { verdict: ClaimVerdict | null; planId: string | null; runId: string | null } {
      const planIds = new Set(plans.list(solutionId).filter(p => p.definition.claim.id === claimId).map(p => p.id));
      const newest = store.list<FrozenRevalidationPlan>(NS.frozen).filter(f => planIds.has(f.planId))
        .sort((a, b) => b.frozenAtMs - a.frozenAtMs || b.version - a.version)[0];
      if (!newest) return { verdict: null, planId: null, runId: null };
      const completed = runs(newest.planId).filter(r => r.planVersion === newest.version && r.status === "completed").at(-1);
      return { verdict: completed?.verdict ?? null, planId: newest.planId, runId: completed?.id ?? null };
    },
  };

  /** Used only by the server's runner. Never exposed through RPC or chat tools. */
  const service: Actor = { kind: "service", id: "revalidation-runner" };
  const executor = {
    frozen(current: RevalidationRun): FrozenRevalidationPlan {
      const value = frozenPlan(current.planId, current.planVersion);
      if (value.planDigest !== current.planDigest) throw new Error("revalidation-frozen-plan-changed");
      return value;
    },
    run,
    /** Moves a queued run to running exactly once; returns null if it is not queued (already started, ended or cancelled). */
    start(runId: string): RevalidationRun | null {
      return store.transaction(() => {
        const current = run(runId);
        if (current.status !== "queued") return null;
        return update({ ...current, status: "running", startedAtMs: now() }, service, "Start the frozen plan");
      });
    },
    stop(runId: string, status: "blocked" | "failed", reason: string): RevalidationRun { return end(runId, status, reason, service); },
    complete(runId: string, result: Omit<RevalidationResult, "runId" | "planDigest" | "completedAtMs">): RevalidationResult {
      return store.transaction(() => {
        const current = run(runId);
        if (current.status !== "running") throw new Error("revalidation-run-not-running");
        const value: RevalidationResult = { ...result, runId, planDigest: current.planDigest, completedAtMs: now() };
        store.createAudited(NS.results, runId, value, service, "Record the scored result");
        update({ ...current, status: "completed", verdict: value.verdict, endedAtMs: value.completedAtMs }, service, "Record the verdict");
        return value;
      });
    },
  };
  return { plans, executor };
}
export type Revalidation = ReturnType<typeof createRevalidation>;
