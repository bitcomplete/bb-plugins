import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { createRevalidation, createRevalidationSchema, revalidationEnvironmentDigest, type RevalidationDefinition, type RevalidationObservation } from "../src/revalidation.js";
import { createRevalidationWorkloads } from "../src/revalidation-workload.js";
import { observedRevalidationEnvironmentDigest, type ObservedRevalidationEnvironment } from "../src/revalidation-environment.js";
import { stableJson } from "../src/domain/shared.js";
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
  const workloads = createRevalidationWorkloads(store, {redact:text=>text.replaceAll("private-secret-value","[redacted]"),now:()=>NOW});
  const workload = workloads.create({requestId:"workload-one",definition:{schemaVersion:1,kind:"paired-exact-instruction-v1",description:"Ten matched repository cases",
    cases:Array.from({length:10},(_,i)=>({id:`case-${i}`,familyId:`family-${i}`,input:`Task ${i}`,expected:`Answer ${i}`})),
    measurements:[{criterionId:"success",kind:"exact-pass-rate"},{criterionId:"correctness",kind:"regression-count"}],normalization:"none",baseline:"no-added-instruction",orderPolicy:"alternating-arms-v1",response:"json-output-string-v1"}},owner);
  let observedVersion="fixture";
  const observe = (environment: NonNullable<RevalidationDefinition["environment"]>): ObservedRevalidationEnvironment => {
    const data = {schemaVersion:1 as const,declaredEnvironmentDigest:revalidationEnvironmentDigest(environment),environment:{id:environment.execution.environmentId,projectId:environment.execution.projectId,status:"ready" as const,hostLifecycle:"active" as const,phase:"active" as const},bbVersion:observedVersion,plugins:[],skills:[],unobservedDependencies:[],unknowns:["Ordinary workspace context remains"]};
    return {...data,digest:observedRevalidationEnvironmentDigest(data),capturedAtMs:NOW};
  };
  const definition: RevalidationDefinition = {
    target: { solutionId: s.id, namespace: "native-evaluation-artifacts", artifactId: "artifact-one", revision: "revision-one", artifactDigest: sha(content) },
    mode: "challenge", concern: "  I'm skeptical this helps on larger repositories.\nPlease check.  ",
    claim: { id: "fewer-errors", text: "The instruction improves exact task success", scope: "Matched large-repository development cases", originalEvidenceRefs: ["native-evaluation-attempts:original"], requiredEvidence: "exploratory" },
    comparator: "The same task without the instruction", workload: {id:workload.id,version:workload.version,description:workload.definition.description,manifestDigest:workload.manifestDigest},
    criteria: [{ id: "success", role: "primary", required: true, evaluator: "numeric-comparison-v1", metric: "Task success", unit: "proportion", statistic: "difference", threshold: { operator: "at-least", value: .1 }, unsupportedReason: null },
      { id: "correctness", role: "guardrail", required: true, evaluator: "numeric-comparison-v1", metric: "Regressions", unit: "cases", statistic: "treatment", threshold: { operator: "at-most", value: 0 }, unsupportedReason: null }],
    sample: { minimumPairs: 10, minimumExposure: null, exposureUnit: null },
    environment: { declaredNonsecret: true, dependencies: [{ kind: "runtime", name: "BB", version: ">=0.49", setup: "Use the selected worker environment" }], configuration: [{ name: "retries", value: "2" }], untested: ["Other providers"],
      execution: { providerId: "codex", model: "selected-model", permissionMode: "accept-edits", projectId: "worker-project", environmentId: "worker-environment" } },
    limits: { maxDurationMs: 60_000, maxCalls: 20, maxCostMicros: 1_000_000, currency: "USD", allowUnknownCost: true, moneyLimitMode:"observed-admission" },
  };
  let time = NOW;
  const core = createRevalidation(store, { redact: text => text.replaceAll("private-secret-value", "[redacted]"), now: () => time, workloads, environmentSnapshots:{resolve:observe} });
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
  const gate = (def = definition) => core.plans.promotionGate({ target: def.target, claims: [{ id: def.claim.id, scope: def.claim.scope, requiredEvidence: def.claim.requiredEvidence }], environmentDigest: revalidationEnvironmentDigest(def.environment!),environmentObservationDigest:observe(def.environment!).digest });
  return { store, core, definition, workloads, workload, observe, setObservedVersion:(value:string)=>{observedVersion=value;}, create, start, complete, observations, gate, setTime: (next: number) => { time = next; } };
}

describe("versioned revalidation foundation", () => {
  it("freezes actual test bytes and protocol while later workload versions preserve the old execution", () => {
    const f=setup(), started=f.start();
    expect(started.frozen).toMatchObject({schemaVersion:2,protocol:"paired-exact-instruction-v1",workload:{id:f.workload.id,version:1}});
    expect(started.run.binding).toMatchObject({protocol:"paired-exact-instruction-v1",environmentObservationDigest:started.frozen.observedEnvironment!.digest});
    const changed=structuredClone(f.workload.definition);changed.cases[0].expected="A new expected answer";
    const next=f.workloads.revise({id:f.workload.id,expectedVersion:1,definition:changed},chat);
    expect(next.manifestDigest).not.toBe(f.workload.manifestDigest);
    expect(f.core.plans.get(started.plan.id).frozen).toEqual(started.frozen);
    expect(started.frozen.workload!.definition.cases[0].expected).toBe("Answer 0");
    expect(f.complete(started).verdict).toBe("supported");
    expect(f.workloads.get(f.workload.id,1).definition.cases[0].expected).toBe("Answer 0");
  });

  it("requires real workload content and explicit monetary semantics for new freezes", () => {
    const f=setup();
    const legacy={...f.definition,workload:{description:"Only a claimed digest",manifestDigest:"a".repeat(64)}};
    const plan=f.create(legacy);
    expect(()=>f.core.plans.freeze({planId:plan.id,expectedVersion:1},owner)).toThrow("workload-unavailable-create-new-version");
    const missing=structuredClone(f.definition);delete missing.limits!.moneyLimitMode;
    const second=f.create(missing,"missing-money-mode");
    expect(()=>f.core.plans.freeze({planId:second.id,expectedVersion:1},owner)).toThrow("money-mode-required");
    expect(f.store.list("revalidation-frozen")).toEqual([]);
    expect(f.core.plans.history(plan.id).versions).toHaveLength(1);
  });

  it.each(["hard-money", "unknown-cost", "exposure", "sample", "calls", "measurement"])("blocks unsupported %s capabilities without authorizing a worker", unsupported=>{
    const f=setup(),def=structuredClone(f.definition);
    if(unsupported==="hard-money")def.limits!.moneyLimitMode="hard";
    if(unsupported==="unknown-cost")def.limits!.allowUnknownCost=false;
    if(unsupported==="exposure")def.sample={minimumPairs:10,minimumExposure:1,exposureUnit:"session-days"};
    if(unsupported==="sample")def.sample!.minimumPairs=11;
    if(unsupported==="calls")def.limits!.maxCalls=19;
    if(unsupported==="measurement")def.criteria[0].unit="percent";
    const started=f.start(def);
    expect(started.run.status).toBe("blocked");expect(started.run.verdict).toBeNull();expect(started.lease).toBeNull();
    expect(f.core.plans.getRun(started.run.id).result).toBeNull();
    expect(f.store.list("revalidation-leases")).toEqual([]);
  });

  it("keeps legacy frozen plans readable and unchanged but blocks newly executing them",()=>{
    const f=setup(),def=structuredClone(f.definition);delete def.limits!.moneyLimitMode;
    def.workload={description:"Legacy digest only",manifestDigest:"a".repeat(64)};
    const plan=f.create(def),artifact={target:def.target,content:"Keep the original request payload on retry."};
    const legacy={planId:plan.id,version:1,definition:def,artifact,environmentDigest:revalidationEnvironmentDigest(def.environment!),workloadDigest:def.workload.manifestDigest,frozenAtMs:NOW,
      planDigest:sha(stableJson({planId:plan.id,version:1,definition:def,artifact}))};
    f.store.put("revalidation-frozen",`${plan.id}:1`,legacy);
    expect(f.core.plans.get(plan.id).frozen).toEqual(legacy);
    expect(f.core.plans.freeze({planId:plan.id,expectedVersion:1},owner)).toEqual(legacy);
    const queued=f.core.plans.queue({planId:plan.id,version:1,requestId:"legacy-run"},owner);
    expect(f.core.executor.start({runId:queued.id,expectedVersion:1})).toMatchObject({lease:null,run:{status:"blocked",reason:"legacy-plan-needs-new-version-and-workload",verdict:null}});
    expect(f.core.plans.get(plan.id).frozen).toEqual(legacy);
  });

  it("rejects mutated frozen case bytes and observed environment records",()=>{
    for(const field of ["workload","environment"]){
      const f=setup(),plan=f.create(),frozen=f.core.plans.freeze({planId:plan.id,expectedVersion:1},owner),tampered=structuredClone(frozen);
      if(field==="workload")tampered.workload!.definition.cases[0].expected="Changed after freeze";
      else tampered.observedEnvironment!.bbVersion="changed";
      f.store.put("revalidation-frozen",`${plan.id}:1`,tampered);
      expect(()=>f.core.plans.queue({planId:plan.id,version:1,requestId:"tampered"},owner)).toThrow();
      expect(f.core.plans.history(plan.id).runs).toEqual([]);
    }
  });

  it("requires the current observed environment for positive promotion evidence",()=>{
    const f=setup(),started=f.start();f.complete(started);
    const input={target:f.definition.target,claims:[f.definition.claim],environmentDigest:revalidationEnvironmentDigest(f.definition.environment!)};
    expect(f.core.plans.promotionGate(input).reasons).toContain("fewer-errors:environment-observation-required");
    expect(f.core.plans.promotionGate({...input,environmentObservationDigest:"e".repeat(64)}).reasons).toContain("fewer-errors:untested-environment");
    expect(f.gate()).toEqual({eligible:true,reasons:[]});
  });

  it("preserves observed-environment contradictions across revisions while allowing a separately tested snapshot",()=>{
    const f=setup(),base={...f.definition,mode:"replay" as const},supported=f.start(base);f.complete(supported);
    const contradicted=f.start(base,"contradicted-observation","contradicted-observation-run"),worse=structuredClone(f.observations);worse[0].treatment=.4;
    f.complete(contradicted,worse);expect(f.gate().reasons).toContain("fewer-errors:contradicted");
    f.setObservedVersion("new-bb-version");
    const revised=f.core.plans.revise({planId:contradicted.plan.id,expectedVersion:1,definition:base},owner);
    expect(()=>f.core.plans.freeze({planId:revised.id,expectedVersion:2},owner)).toThrow("new-observed-environment-needs-new-plan");
    // The unfrozen revision remains pending; it cannot erase the old concern by changing its observed scope.
    expect(f.gate().eligible).toBe(false);
    const newRun=f.start({...base,mode:"new-environment"},"new-observation","new-observation-run");f.complete(newRun);
    expect(f.gate().eligible).toBe(false);
    // Revise the original concern back onto its original observed snapshot and settle it there.
    f.setObservedVersion("fixture");
    const frozen=f.core.plans.freeze({planId:revised.id,expectedVersion:2},owner),queued=f.core.plans.queue({planId:revised.id,version:2,requestId:"resolve-original"},owner);
    const started={plan:revised,frozen,...f.core.executor.start({runId:queued.id,expectedVersion:1})};f.complete(started);
    expect(f.gate()).toEqual({eligible:true,reasons:[]});
    f.setObservedVersion("new-bb-version");expect(f.gate()).toEqual({eligible:true,reasons:[]});
  });

  it("interrupts a running lease and retains idempotent partial and late usage independently of scientific results",()=>{
    const f=setup(),started=f.start(),before=f.core.plans.getRun(started.run.id);
    const usage={runId:started.run.id,requestId:"partial-one",binding:started.run.binding,usage:{calls:1,elapsedMs:250,costMicros:null,currency:"USD"},taskIds:["native-task-one"],unknownReasons:["billing-incomplete"],observedCostFloorMicros:5};
    const partial=f.core.executor.recordUsage(usage);expect(f.core.executor.recordUsage(usage)).toEqual(partial);
    expect(()=>f.core.executor.recordUsage({...usage,usage:{...usage.usage,calls:2}})).toThrow("usage-request-conflict");
    expect(()=>f.core.executor.interrupt({runId:started.run.id,expectedVersion:before.version-1})).toThrow("version-conflict");
    const stopped=f.core.executor.interrupt({runId:started.run.id,expectedVersion:before.version});
    expect(stopped).toMatchObject({status:"blocked",reason:"interrupted-needs-new-run",verdict:null});
    expect(()=>f.complete(started)).toThrow("stale-executor");
    expect(()=>f.core.executor.assertActive({runId:started.run.id,lease:started.lease!})).toThrow("stale-executor");
    f.core.executor.recordUsage({...usage,requestId:"late-report",observedCostFloorMicros:8});
    expect(f.core.plans.usage(started.run.id).map(row=>row.observedCostFloorMicros)).toEqual([5,8]);
    expect(f.core.plans.getRun(started.run.id).result).toBeNull();
    const next=f.core.plans.queue({planId:started.plan.id,version:1,requestId:"explicit-retry"},owner);
    expect(next.id).not.toBe(started.run.id);expect(f.core.plans.usage(next.id)).toEqual([]);
    expect(f.core.plans.history(started.plan.id).runs.map(run=>run.status)).toEqual(["blocked","queued"]);
  });

  it("keeps late accounting separate from immutable results and never invents missing cost",()=>{
    const f=setup(),started=f.start(),result=f.core.executor.complete({runId:started.run.id,lease:started.lease!,binding:started.run.binding,observations:f.observations,
      evidence:{kind:"exploratory-challenge",receiptRefs:["native-task:case-observations"],limitations:["ordinary-context"]},usage:{calls:20,elapsedMs:1000,costMicros:null,currency:"USD"}});
    f.core.executor.recordUsage({runId:started.run.id,requestId:"late",binding:started.run.binding,usage:{calls:20,elapsedMs:1000,costMicros:null,currency:"USD"},taskIds:[],unknownReasons:["billing-incomplete"],observedCostFloorMicros:700});
    expect(f.core.plans.getRun(started.run.id).result).toEqual(result);expect(result.usage.costMicros).toBeNull();
    expect(f.core.plans).not.toHaveProperty("recordUsage");expect(f.core.plans).not.toHaveProperty("interrupt");
  });

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

  it.each(["baseline", "treatment", "pairs", "zero-denominator"])("keeps %s insufficiency scientifically inconclusive", missing => {
    const f = setup(), def = structuredClone(f.definition), obs = structuredClone(f.observations);
    if (missing === "baseline") obs[0].baseline = null;
    if (missing === "treatment") obs[0].treatment = null;
    if (missing === "pairs") obs[0].pairs = 9;
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
    expect(() => f.core.executor.complete({ ...input, usage: { ...input.usage, currency: "EUR" } })).toThrow("limit-exceeded");
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
