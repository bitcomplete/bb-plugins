import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { createRevalidation, createRevalidationSchema, revalidationEnvironmentDigest, type RevalidationDefinition, type RevalidationObservation } from "../src/revalidation.js";
import { solution, NOW } from "./domain/fixtures.js";

const owner = { kind: "owner" as const, id: "owner" }, chat = { kind: "chat" as const, id: "scoped-chat" };
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function setup() {
  const db = new Database(":memory:"); databases.push(db); MIGRATIONS.forEach(sql => db.exec(sql)); const store = new Store(db);
  const s = solution(); store.put("solutions", s.id, s);
  const content = "Keep the original request payload on retry.";
  store.put("native-evaluation-artifacts", "artifact-one", { id: "artifact-one", solutionId: s.id, revision: "revision-one", kind: "instruction", content, artifactDigest: sha(content), evaluationId: null, evidenceKind: "exploratory-development-replay" });
  const definition: RevalidationDefinition = {
    target: { solutionId: s.id, namespace: "native-evaluation-artifacts", artifactId: "artifact-one", revision: "revision-one", artifactDigest: sha(content) },
    mode: "challenge", concern: "  I'm skeptical this helps on larger repositories.\nPlease check.  ",
    claim: { id: "fewer-errors", text: "The instruction improves exact task success", scope: "Matched large-repository development cases", originalEvidenceRefs: ["native-evaluation-attempts:original"], requiredEvidence: "exploratory" },
    comparator: "The same task without the instruction", workload: { description: "Ten matched repository cases", manifestDigest: "a".repeat(64) },
    criteria: [{ id: "success", role: "primary", required: true, evaluator: "numeric-comparison-v1", metric: "Task success", unit: "proportion", statistic: "difference", threshold: { operator: "at-least", value: .1 }, unsupportedReason: null },
      { id: "correctness", role: "guardrail", required: true, evaluator: "numeric-comparison-v1", metric: "Regressions", unit: "cases", statistic: "treatment", threshold: { operator: "at-most", value: 0 }, unsupportedReason: null }],
    sample: { minimumPairs: 10, minimumExposure: null, exposureUnit: null },
    environment: { declaredNonsecret: true, dependencies: [{ kind: "runtime", name: "BB", version: ">=0.49", setup: "Use the selected worker environment" }], configuration: [{ name: "retries", value: "2" }], untested: ["Other providers"],
      execution: { providerId: "codex", model: "selected-model", permissionMode: "accept-edits", projectId: "worker-project", environmentId: "worker-environment" } },
    limits: { maxDurationMs: 60_000, maxCalls: 20, maxCostMicros: 1_000_000, currency: "USD", allowUnknownCost: false },
  };
  let time = NOW;
  const core = createRevalidation(store, { redact: text => text.replaceAll("private-secret-value", "[redacted]"), now: () => time });
  const create = (def = definition, requestId = "intent-one") => core.plans.create({ requestId, definition: def }, owner);
  const start = (def = definition, requestId = "intent-one", runKey = "run-one") => {
    const plan = create(def, requestId), frozen = core.plans.freeze({ planId: plan.id, expectedVersion: plan.version }, owner);
    const queued = core.plans.queue({ planId: plan.id, version: plan.version, requestId: runKey }, owner);
    const started = core.executor.start({ runId: queued.id, expectedVersion: core.plans.getRun(queued.id).version });
    return { plan, frozen, ...started };
  };
  const observations: RevalidationObservation[] = [
    { criterionId: "success", metric: "Task success", unit: "proportion", baseline: .5, treatment: .8, pairs: 10, exposure: null, exposureUnit: null, receiptRefs: ["native-task:case-observations"] },
    { criterionId: "correctness", metric: "Regressions", unit: "cases", baseline: 0, treatment: 0, pairs: 10, exposure: null, exposureUnit: null, receiptRefs: ["native-task:case-observations"] },
  ];
  const complete = (started: ReturnType<typeof start>, obs = observations) => core.executor.complete({ runId: started.run.id, lease: started.lease!, binding: started.run.binding, observations: obs,
    evidence: { kind: started.frozen.definition.mode === "replay" ? "exploratory-replay" : "exploratory-challenge", receiptRefs: ["native-task:case-observations"], limitations: ["Development work; ordinary BB context and tools remain"] },
    usage: { calls: 20, elapsedMs: 1000, costMicros: 500, currency: "USD" } });
  const gate = (def = definition) => core.plans.promotionGate({ target: def.target, claims: [{ id: def.claim.id, scope: def.claim.scope, requiredEvidence: def.claim.requiredEvidence }], environmentDigest: revalidationEnvironmentDigest(def.environment!) });
  return { store, core, definition, create, start, complete, observations, gate, setTime: (next: number) => { time = next; } };
}

describe("versioned revalidation foundation", () => {
  it("keeps verbatim concern, original evidence and immutable versions with optimistic audited owner/chat edits", () => {
    const f = setup(), first = f.create();
    expect(first.definition.concern).toBe(f.definition.concern);
    expect(f.create()).toEqual(first); expect(f.core.plans.list()).toHaveLength(1);
    expect(f.gate()).toMatchObject({ eligible: false, reasons: ["fewer-errors:pending-general-challenge"] });
    const frozen = f.core.plans.freeze({ planId: first.id, expectedVersion: 1 }, owner);
    const changed = structuredClone(f.definition); changed.criteria[0].threshold.value = .2;
    const next = f.core.plans.revise({ planId: first.id, expectedVersion: 1, definition: changed }, chat);
    expect(next).toMatchObject({ version: 2, previousVersion: 1, actor: chat });
    expect(f.core.plans.get(first.id, 1).frozen).toEqual(frozen);
    expect(f.core.plans.history(first.id).versions.map(p => p.definition.criteria[0].threshold.value)).toEqual([.1, .2]);
    expect(() => f.core.plans.revise({ planId: first.id, expectedVersion: 1, definition: changed }, owner)).toThrow("version-conflict");
    expect(() => f.core.plans.freeze({ planId: first.id, expectedVersion: 2 }, chat)).toThrow("owner-action");
    expect(f.core.plans.freeze({ planId: first.id, expectedVersion: 2 }, owner).planDigest).not.toBe(frozen.planDigest);
    expect(f.store.audit().length).toBeGreaterThan(4);
  });

  it("cannot bind client bytes, private settings, result fields or fabricated artifact identities", () => {
    const f = setup();
    expect(() => createRevalidationSchema.parse({ requestId: "intent", definition: f.definition, verdict: "supported" })).toThrow();
    expect(() => f.create({ ...f.definition, target: { ...f.definition.target, artifactId: "missing" } })).toThrow("artifact-missing");
    expect(() => f.create({ ...f.definition, target: { ...f.definition.target, artifactDigest: "b".repeat(64) } })).toThrow("artifact-changed");
    const secret = structuredClone(f.definition); secret.environment!.configuration = [{ name: "apiKey", value: "unrecognized-value" }];
    expect(() => f.create(secret)).toThrow("secret-configuration");
    secret.environment!.configuration = [{ name: "safe-looking-name", value: "private-secret-value" }];
    expect(() => f.create(secret)).toThrow("private-input");
    expect(() => f.create({ ...f.definition, concern: "private-secret-value" })).toThrow("private-input");
    expect(f.core.plans.list()).toEqual([]);
    expect(f.core.plans).not.toHaveProperty("complete"); expect(f.core.plans).not.toHaveProperty("start");
  });

  it("requires explicit criteria and limits, and preserves unsupported optional criteria as blocked", () => {
    const f = setup(), draft = f.create({ ...f.definition, criteria: [], limits: null });
    expect(() => f.core.plans.freeze({ planId: draft.id, expectedVersion: 1 }, owner)).toThrow("plan-incomplete");
    const def = structuredClone(f.definition);
    def.criteria.push({ ...def.criteria[0], id: "portability", required: false, evaluator: "unsupported", unsupportedReason: "Minimal-environment harness unavailable" });
    const started = f.start(def, "unsupported-intent");
    expect(started.lease).toBeNull(); expect(started.run).toMatchObject({ status: "blocked", verdict: null, reason: "unsupported-criterion" });
    expect(f.core.plans.get(started.plan.id).frozen?.definition.criteria.at(-1)?.unsupportedReason).toContain("unavailable");
  });

  it.each(["held-out", "causal"] as const)("never infers %s proof from ordinary native numeric observations", evidence => {
    const f = setup(), def = structuredClone(f.definition); def.claim.requiredEvidence = evidence;
    const started = f.start(def);
    expect(started.run).toMatchObject({ status: "blocked", verdict: null, reason: "required-evidence-capability-unavailable" });
    expect(f.store.list("trusted-evaluations")).toEqual([]);
  });

  it("records scoped support and contradictory guardrails without modifying artifacts or old results", () => {
    const f = setup(), before = f.store.entries("native-evaluation-artifacts"), started = f.start();
    const result = f.complete(started);
    expect(result.verdict).toBe("supported"); expect(f.complete(started)).toEqual(result);
    expect(f.gate()).toEqual({ eligible: true, reasons: [] });
    const stronger = structuredClone(f.definition); stronger.claim.requiredEvidence = "held-out";
    expect(f.gate(stronger).reasons).toContain("fewer-errors:insufficient-evidence-class");
    const again = f.core.plans.queue({ planId: started.plan.id, version: 1, requestId: "second-run" }, owner);
    const next = f.core.executor.start({ runId: again.id, expectedVersion: 1 });
    const obs = structuredClone(f.observations); obs[1].treatment = 1;
    const failedClaim = f.complete({ ...started, ...next }, obs);
    expect(failedClaim.verdict).toBe("contradicted");
    expect(f.gate()).toMatchObject({ eligible: false, reasons: ["fewer-errors:contradicted"] });
    expect(f.core.plans.getRun(started.run.id).result).toEqual(result);
    expect(f.store.entries("native-evaluation-artifacts")).toEqual(before);
    expect(f.store.list("validated-artifacts")).toEqual([]);
    expect(() => f.complete(started, obs)).toThrow("result-immutable");
  });

  it.each(["baseline", "treatment", "pairs", "exposure", "zero-denominator"])("keeps %s insufficiency scientifically inconclusive", missing => {
    const f = setup(), def = structuredClone(f.definition), obs = structuredClone(f.observations);
    if (missing === "baseline") obs[0].baseline = null;
    if (missing === "treatment") obs[0].treatment = null;
    if (missing === "pairs") obs[0].pairs = 9;
    if (missing === "exposure") { def.sample = { minimumPairs: 10, minimumExposure: 100, exposureUnit: "session-days" }; obs.forEach(o => { o.exposure = 99; o.exposureUnit = "session-days"; }); }
    if (missing === "zero-denominator") { def.criteria[0].statistic = "relative-change"; obs[0].baseline = 0; }
    const started = f.start(def), result = f.complete(started, obs);
    expect(result.verdict).toBe("inconclusive"); expect(f.core.plans.getRun(started.run.id).run.status).toBe("completed");
  });

  it("binds plan, workload, environment, metric units and receipts to the executor outcome", () => {
    const f = setup(), started = f.start();
    const input = { runId: started.run.id, lease: started.lease!, binding: started.run.binding, observations: f.observations,
      evidence: { kind: "exploratory-challenge" as const, receiptRefs: ["native-task:case-observations"], limitations: ["No enforced isolation"] }, usage: { calls: 1, elapsedMs: 1, costMicros: 1, currency: "USD" } };
    for (const key of ["planDigest", "artifactDigest", "workloadDigest", "environmentDigest"]) expect(() => f.core.executor.complete({ ...input, binding: { ...input.binding, [key]: "b".repeat(64) } })).toThrow("binding-mismatch");
    expect(() => f.core.executor.complete({ ...input, observations: [{ ...f.observations[0], unit: "percent" }] })).toThrow("metric-unit-mismatch");
    expect(() => f.core.executor.complete({ ...input, evidence: { ...input.evidence, receiptRefs: ["different-receipt"] } })).toThrow("receipt-mismatch");
    expect(() => f.core.executor.complete({ ...input, usage: { ...input.usage, calls: 21 } })).toThrow("limit-exceeded");
    expect(() => f.core.executor.complete({ ...input, usage: { ...input.usage, costMicros: null } })).toThrow("limit-exceeded");
    expect(f.core.plans.getRun(started.run.id).result).toBeNull();
    expect(f.complete(started).verdict).toBe("supported");
  });

  it("separates operational failure, cancellation and new attempts from a scientific verdict", () => {
    const f = setup(), started = f.start();
    expect(() => f.core.executor.block({ runId: started.run.id, reason: "stale caller" })).toThrow("stale-executor");
    const failed = f.core.executor.fail({ runId: started.run.id, lease: started.lease!, reason: "provider-unavailable" });
    expect(failed).toMatchObject({ status: "failed", verdict: null });
    expect(f.core.plans.queue({ planId: started.plan.id, version: 1, requestId: "run-one" }, owner)).toEqual(failed);
    expect(() => f.complete(started)).toThrow("stale-executor");
    const newRun = f.core.plans.queue({ planId: started.plan.id, version: 1, requestId: "new-attempt" }, owner);
    expect(newRun.id).not.toBe(failed.id);
    expect(f.core.plans.cancel({ runId: newRun.id, expectedVersion: 1, reason: "Owner cancelled" }, owner)).toMatchObject({ status: "cancelled", verdict: null });
    expect(f.core.plans.history(started.plan.id).runs.map(r => r.status)).toEqual(["failed", "cancelled"]);
    expect(f.core.plans.history(started.plan.id).results).toEqual([]);
  });

  it("lets the owner cancel running work with an optimistic version and revokes the old worker lease", () => {
    const f = setup(), started = f.start(), running = f.core.plans.getRun(started.run.id);
    expect(running.run.status).toBe("running");
    expect(() => f.core.plans.cancel({ runId: started.run.id, expectedVersion: running.version - 1, reason: "Stop" }, owner)).toThrow("version-conflict");
    expect(() => f.core.plans.cancel({ runId: started.run.id, expectedVersion: running.version, reason: "Stop" }, chat)).toThrow("owner-action");
    expect(f.core.plans.getRun(started.run.id)).toEqual(running);
    const cancelled = f.core.plans.cancel({ runId: started.run.id, expectedVersion: running.version, reason: "Owner cancelled" }, owner);
    expect(cancelled).toMatchObject({ status: "cancelled", verdict: null, endedAtMs: NOW });
    expect(f.store.get("revalidation-leases", started.run.id)).toBeNull();
    expect(f.core.plans.getRun(started.run.id).version).toBe(running.version + 1);
    expect(() => f.complete(started)).toThrow("stale-executor");
    expect(() => f.core.executor.fail({ runId: started.run.id, lease: started.lease!, reason: "Late worker failure" })).toThrow("run-terminal");
    expect(f.core.plans.getRun(started.run.id).run).toEqual(cancelled);
    expect(f.core.plans.getRun(started.run.id).result).toBeNull();
  });

  it("supports independently tested environments and blocks both for an unresolved unspecified-environment concern", () => {
    const f = setup(), first = f.start(); f.complete(first);
    const secondDefinition = structuredClone(f.definition); secondDefinition.mode = "new-environment"; secondDefinition.environment!.configuration[0].value = "3";
    const second = f.start(secondDefinition, "environment-b", "run-b"); f.complete(second);
    expect(f.gate()).toEqual({ eligible: true, reasons: [] });
    expect(f.gate(secondDefinition)).toEqual({ eligible: true, reasons: [] });
    const untested = structuredClone(f.definition); untested.environment!.configuration[0].value = "4";
    expect(f.gate(untested)).toEqual({ eligible: false, reasons: ["fewer-errors:untested-environment"] });
    f.create({ ...f.definition, mode: "new-environment", environment: null, concern: "The affected environment is not known yet." }, "unspecified-environment");
    for (const def of [f.definition, secondDefinition]) expect(f.gate(def)).toEqual({ eligible: false, reasons: ["fewer-errors:pending-unspecified-environment"] });
    expect(f.core.plans.getRun(first.run.id).result?.verdict).toBe("supported");
    expect(f.core.plans.getRun(second.run.id).result?.verdict).toBe("supported");
  });

  it.each(["new-environment", "replay"] as const)("scopes pending, contradicted and explicitly stale %s work to its known environment", mode => {
    const f = setup(), first = f.start(); f.complete(first);
    const def = structuredClone(f.definition); def.mode = mode; def.environment!.configuration[0].value = "3";
    const pending = f.create(def, "environment-b");
    expect(f.gate()).toEqual({ eligible: true, reasons: [] });
    expect(f.gate(def)).toEqual({ eligible: false, reasons: ["fewer-errors:pending"] });
    const second = f.start(def, "environment-b", "run-b");
    const worse = structuredClone(f.observations); worse[0].treatment = .4;
    expect(f.complete(second, worse).verdict).toBe("contradicted");
    expect(f.gate()).toEqual({ eligible: true, reasons: [] });
    expect(f.gate(def)).toEqual({ eligible: false, reasons: ["fewer-errors:contradicted"] });
    f.core.plans.markStale({ planId: pending.id, expectedVersion: 1, reason: "This environment's dependency changed" }, owner);
    expect(f.gate()).toEqual({ eligible: true, reasons: [] });
    expect(f.gate(def)).toEqual({ eligible: false, reasons: ["fewer-errors:stale"] });
  });

  it("cannot hide an environment contradiction by revising its configuration, provider or environment to null", () => {
    const f = setup(), supported = f.start(); f.complete(supported);
    const def = { ...structuredClone(f.definition), mode: "replay" as const };
    const contradicted = f.start(def, "contradicted-a", "contradicted-a-run");
    const worse = structuredClone(f.observations); worse[0].treatment = .4;
    f.complete(contradicted, worse);
    const before = f.core.plans.history(contradicted.plan.id), audit = f.store.audit();
    const otherConfig = structuredClone(def); otherConfig.environment!.configuration[0].value = "3";
    const otherProvider = structuredClone(def); otherProvider.environment!.execution.providerId = "other-provider";
    for (const changed of [otherConfig, otherProvider, { ...def, environment: null }]) {
      expect(() => f.core.plans.revise({ planId: contradicted.plan.id, expectedVersion: 1, definition: changed }, owner)).toThrow("new-environment-needs-new-plan");
      expect(f.gate()).toEqual({ eligible: false, reasons: ["fewer-errors:contradicted"] });
      expect(f.core.plans.history(contradicted.plan.id)).toEqual(before);
      expect(f.store.audit()).toEqual(audit);
    }
    const inB = f.start({ ...otherConfig, mode: "new-environment" }, "separate-environment-b", "separate-run-b");
    f.complete(inB);
    expect(f.gate(otherConfig)).toEqual({ eligible: true, reasons: [] });
    expect(f.gate()).toEqual({ eligible: false, reasons: ["fewer-errors:contradicted"] });
  });

  it("allows an unspecified draft environment to be clarified without narrowing a general challenge", () => {
    const f = setup(), supported = f.start(); f.complete(supported);
    const draft = f.create({ ...f.definition, environment: null }, "unspecified-challenge");
    const clarified = structuredClone(f.definition); clarified.mode = "new-environment"; clarified.environment!.configuration[0].value = "3";
    const revised = f.core.plans.revise({ planId: draft.id, expectedVersion: 1, definition: clarified }, chat);
    expect(revised).toMatchObject({ version: 2, definition: { environment: clarified.environment } });
    expect(f.gate()).toEqual({ eligible: false, reasons: ["fewer-errors:pending-general-challenge"] });
    expect(f.core.plans.get(draft.id, 1).plan.definition.environment).toBeNull();
    expect(() => f.core.plans.revise({ planId: draft.id, expectedVersion: 2, definition: { ...clarified, environment: null } }, owner)).toThrow("new-environment-needs-new-plan");
  });

  it("keeps a general challenge broad across mode revisions and only attributes its support to the tested environment", () => {
    const f = setup(), first = f.start(); f.complete(first);
    const def = structuredClone(f.definition); def.environment!.configuration[0].value = "3";
    const broad = f.create(def, "broad-challenge");
    expect(f.gate()).toEqual({ eligible: false, reasons: ["fewer-errors:pending-general-challenge"] });
    const revised = f.core.plans.revise({ planId: broad.id, expectedVersion: 1, definition: { ...def, mode: "new-environment" } }, owner);
    expect(f.gate()).toEqual({ eligible: false, reasons: ["fewer-errors:pending-general-challenge"] });
    const frozen = f.core.plans.freeze({ planId: broad.id, expectedVersion: 2 }, owner);
    const queued = f.core.plans.queue({ planId: broad.id, version: 2, requestId: "broad-second-version" }, owner);
    const second = { plan: revised, frozen, ...f.core.executor.start({ runId: queued.id, expectedVersion: 1 }) };
    f.complete(second);
    expect(f.gate()).toEqual({ eligible: true, reasons: [] });
    expect(f.gate(def)).toEqual({ eligible: true, reasons: [] });
    const untested = structuredClone(def); untested.environment!.configuration[0].value = "4";
    expect(f.gate(untested)).toEqual({ eligible: false, reasons: ["fewer-errors:untested-environment"] });
    const retry = f.core.plans.queue({ planId: broad.id, version: 2, requestId: "broad-retry" }, owner);
    const next = { plan: revised, frozen, ...f.core.executor.start({ runId: retry.id, expectedVersion: 1 }) };
    const worse = structuredClone(f.observations); worse[1].treatment = 1;
    f.complete(next, worse);
    for (const environment of [f.definition, def]) expect(f.gate(environment)).toEqual({ eligible: false, reasons: ["fewer-errors:contradicted"] });
    f.core.plans.markStale({ planId: broad.id, expectedVersion: 2, reason: "The general claim needs new evidence" }, owner);
    for (const environment of [f.definition, def]) expect(f.gate(environment)).toEqual({ eligible: false, reasons: ["fewer-errors:stale"] });
  });

  it("keeps a later challenge pending when an older run completes, then marks configuration drift stale", () => {
    const f = setup(), older = f.start();
    const challenge = f.create({ ...f.definition, concern: "Does the effect survive a larger workload?" }, "later-challenge");
    f.complete(older);
    expect(f.gate()).toMatchObject({ eligible: false, reasons: ["fewer-errors:pending-general-challenge"] });
    expect(f.core.plans.get(challenge.id).plan.definition.concern).toContain("larger workload");
    const other = setup(), supported = other.start(); other.complete(supported);
    const changed = structuredClone(other.definition); changed.environment!.configuration[0].value = "3";
    expect(other.gate(changed).reasons).toContain("fewer-errors:untested-environment");
    other.core.plans.markStale({ planId: supported.plan.id, expectedVersion: 1, reason: "Dependency version changed" }, chat);
    expect(other.gate().reasons).toContain("fewer-errors:stale");
  });

  it("does not reattribute a queued run after plan edits or mutate historical artifact bytes", () => {
    const f = setup(), original = f.create(), frozen = f.core.plans.freeze({ planId: original.id, expectedVersion: 1 }, owner);
    const queued = f.core.plans.queue({ planId: original.id, version: 1, requestId: "before-edit" }, owner);
    const changed = structuredClone(f.definition); changed.comparator = "A new baseline";
    f.core.plans.revise({ planId: original.id, expectedVersion: 1, definition: changed }, owner);
    expect(f.core.executor.start({ runId: queued.id, expectedVersion: 1 }).run).toMatchObject({ status: "blocked", verdict: null, reason: "plan-superseded" });
    f.store.remove("native-evaluation-artifacts", "artifact-one");
    expect(f.core.plans.get(original.id, 1).frozen).toEqual(frozen);
    const historical = f.create(f.definition, "historical-version");
    expect(f.core.plans.freeze({ planId: historical.id, expectedVersion: 1 }, owner).artifact.content).toBe(frozen.artifact.content);
    expect(() => f.core.plans.queue({ planId: historical.id, version: 1, requestId: "before-edit" }, owner)).toThrow("request-conflict");
  });
});
