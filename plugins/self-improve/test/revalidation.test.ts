import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { createRevalidation, type RevalidationDefinition } from "../src/revalidation.js";
import { solution, NOW } from "./domain/fixtures.js";

const owner = { kind: "owner" as const, id: "owner" }, chat = { kind: "chat" as const, id: "chat-thread" };
const worker = { providerId: "codex", model: "selected-model", permissionMode: "accept-edits" as const, projectId: "worker-project", environmentId: "worker-environment" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

function setup() {
  const db = new Database(":memory:"); databases.push(db); MIGRATIONS.forEach(sql => db.exec(sql)); const store = new Store(db);
  const s = solution(); store.put("solutions", s.id, s);
  const content = "Keep the original request payload on retry.";
  store.put("native-evaluation-artifacts", "artifact-one", { solutionId: s.id, revision: "revision-one", kind: "instruction", content, artifactDigest: sha(content) });
  const definition: RevalidationDefinition = {
    target: { solutionId: s.id, namespace: "native-evaluation-artifacts", artifactId: "artifact-one", revision: "revision-one", artifactDigest: sha(content) },
    concern: "  I'm skeptical this helps on larger repositories.  ",
    claim: { id: "fewer-errors", text: "The instruction improves exact task success" },
    cases: [{ id: "case-1", input: "Task one", expected: "Answer one" }, { id: "case-2", input: "Task two", expected: "Answer two" }],
    criteria: [{ id: "gain", measure: "pass-rate", statistic: "difference", operator: "at-least", value: 0.5, required: true }],
    limits: { maxDurationMs: 600_000 },
  };
  let time = NOW;
  const core = createRevalidation(store, { redact: text => text.replaceAll("private-secret", "[redacted]"), now: () => time });
  const queued = (requestId = "run-1") => {
    const plan = core.plans.create({ requestId: "plan-1", definition }, owner);
    core.plans.freeze({ planId: plan.id, expectedVersion: plan.version }, worker, owner);
    return { plan, run: core.plans.queue({ planId: plan.id, version: plan.version, requestId }, owner) };
  };
  const result = (verdict: "supported" | "contradicted") => ({ verdict, cases: 2, passed: { baseline: 0, treatment: verdict === "supported" ? 2 : 0 }, regressions: 0, unreadable: { baseline: 0, treatment: 0 }, criteria: [] });
  return { store, core, definition, content, queued, result, tick: () => { time += 1000; } };
}

describe("rule 1: owner authority", () => {
  it("lets the chat draft and revise, but only the owner freeze, queue and cancel", () => {
    const f = setup(), draft = f.core.plans.create({ requestId: "draft", definition: f.definition }, chat);
    const revised = f.core.plans.revise({ planId: draft.id, expectedVersion: 1, definition: { ...f.definition, concern: "A sharper doubt" } }, chat);
    expect(revised.version).toBe(2);
    expect(() => f.core.plans.freeze({ planId: draft.id, expectedVersion: 2 }, worker, chat)).toThrow("owner-action-required");
    f.core.plans.freeze({ planId: draft.id, expectedVersion: 2 }, worker, owner);
    expect(() => f.core.plans.queue({ planId: draft.id, version: 2, requestId: "r" }, chat)).toThrow("owner-action-required");
    const run = f.core.plans.queue({ planId: draft.id, version: 2, requestId: "r" }, owner);
    expect(() => f.core.plans.cancel({ runId: run.id, reason: "stop" }, chat)).toThrow("owner-action-required");
    expect(() => f.core.plans.create({ requestId: "x", definition: f.definition }, { kind: "service", id: "other" })).toThrow("owner-action-required");
  });
  it("stops the chat from replacing a version the owner has queued, but not the owner", () => {
    const f = setup(), { plan } = f.queued();
    expect(() => f.core.plans.revise({ planId: plan.id, expectedVersion: 1, definition: { ...f.definition, concern: "Changed" } }, chat)).toThrow("run-active-cancel-first");
    expect(f.core.plans.revise({ planId: plan.id, expectedVersion: 1, definition: { ...f.definition, concern: "Changed" } }, owner).version).toBe(2);
  });
  it("keeps a plan on its solution and claim", () => {
    const f = setup(), plan = f.core.plans.create({ requestId: "p", definition: f.definition }, chat);
    expect(() => f.core.plans.revise({ planId: plan.id, expectedVersion: 1, definition: { ...f.definition, claim: { ...f.definition.claim, id: "other-claim" } } }, chat)).toThrow("new-claim-needs-new-plan");
    expect(() => f.core.plans.revise({ planId: plan.id, expectedVersion: 1, definition: { ...f.definition, target: { ...f.definition.target, solutionId: "s-b" } } }, chat)).toThrow("new-claim-needs-new-plan");
  });
});

describe("rule 2: test integrity", () => {
  it("freezes the exact instruction bytes and worker settings, and the frozen plan does not follow later edits", () => {
    const f = setup(), { plan, run } = f.queued(), frozen = f.core.plans.get(plan.id).frozen!;
    expect(frozen.artifact.content).toBe(f.content); expect(frozen.testedOn).toEqual(worker); expect(run.planDigest).toBe(frozen.planDigest);
    f.core.plans.revise({ planId: plan.id, expectedVersion: 1, definition: { ...f.definition, cases: [{ id: "new", input: "New", expected: "New" }] } }, owner);
    expect(f.core.executor.frozen(f.core.executor.run(run.id)).definition.cases).toEqual(f.definition.cases);
    expect(f.core.plans.freeze({ planId: plan.id, expectedVersion: 1 + 1 }, worker, owner).definition.cases[0]!.id).toBe("new");
  });
  it("refuses to freeze an incomplete plan or an instruction that changed since the draft", () => {
    const f = setup();
    const empty = f.core.plans.create({ requestId: "empty", definition: { ...f.definition, cases: [] } }, owner);
    expect(() => f.core.plans.freeze({ planId: empty.id, expectedVersion: 1 }, worker, owner)).toThrow("plan-incomplete");
    const optional = f.core.plans.create({ requestId: "optional", definition: { ...f.definition, criteria: [{ ...f.definition.criteria[0]!, required: false }] } }, owner);
    expect(() => f.core.plans.freeze({ planId: optional.id, expectedVersion: 1 }, worker, owner)).toThrow("plan-incomplete");
    const plan = f.core.plans.create({ requestId: "p", definition: f.definition }, owner);
    f.store.put("native-evaluation-artifacts", "artifact-one", { solutionId: "s-a", revision: "revision-one", kind: "instruction", content: "Edited", artifactDigest: sha("Edited") });
    expect(() => f.core.plans.freeze({ planId: plan.id, expectedVersion: 1 }, worker, owner)).toThrow("artifact-changed");
  });
  it("refuses text the privacy policy would rewrite instead of changing it", () => {
    const f = setup();
    expect(() => f.core.plans.create({ requestId: "p", definition: { ...f.definition, concern: "private-secret" } }, owner)).toThrow("private-input");
  });
});

describe("rule 3: honest verdicts", () => {
  it("records a verdict only through completion of a running run; stops leave no verdict", () => {
    const f = setup(), { run } = f.queued();
    expect(() => f.core.executor.complete(run.id, f.result("supported"))).toThrow("not-running");
    f.core.executor.start(run.id);
    expect(f.core.executor.start(run.id)).toBeNull();
    f.core.plans.cancel({ runId: run.id, reason: "Owner stopped it" }, owner);
    expect(f.core.plans.getRun(run.id).run).toMatchObject({ status: "cancelled", verdict: null });
    expect(() => f.core.executor.complete(run.id, f.result("supported"))).toThrow("not-running");
    expect(f.core.executor.stop(run.id, "failed", "late").status).toBe("cancelled");
  });
});

describe("rule 7: standing", () => {
  it("takes the latest completed run of the latest frozen version, keeping earlier results", () => {
    const f = setup(), { plan, run } = f.queued();
    f.core.executor.start(run.id); f.core.executor.complete(run.id, f.result("contradicted"));
    expect(f.core.plans.standing("s-a", "fewer-errors")).toMatchObject({ verdict: "contradicted", runId: run.id });
    f.tick(); const again = f.core.plans.queue({ planId: plan.id, version: 1, requestId: "run-2" }, owner);
    f.core.executor.start(again.id); f.core.executor.complete(again.id, f.result("supported"));
    expect(f.core.plans.standing("s-a", "fewer-errors")).toMatchObject({ verdict: "supported", runId: again.id });
    expect(f.core.plans.history(plan.id).results.map(r => r.verdict)).toEqual(["contradicted", "supported"]);
    f.core.plans.revise({ planId: plan.id, expectedVersion: 1, definition: { ...f.definition, concern: "New" } }, owner);
    f.tick(); f.core.plans.freeze({ planId: plan.id, expectedVersion: 2 }, worker, owner);
    expect(f.core.plans.standing("s-a", "fewer-errors").verdict).toBeNull();
  });
  it("lets the most recently frozen plan for a claim decide, across plans", () => {
    const f = setup(), { run } = f.queued();
    f.core.executor.start(run.id); f.core.executor.complete(run.id, f.result("supported"));
    f.tick(); const other = f.core.plans.create({ requestId: "chat-plan", definition: { ...f.definition, concern: "Another doubt" } }, chat);
    f.core.plans.freeze({ planId: other.id, expectedVersion: 1 }, worker, owner);
    expect(f.core.plans.standing("s-a", "fewer-errors")).toMatchObject({ verdict: null, planId: other.id });
    const otherRun = f.core.plans.queue({ planId: other.id, version: 1, requestId: "other-run" }, owner);
    f.core.executor.start(otherRun.id); f.core.executor.complete(otherRun.id, f.result("contradicted"));
    expect(f.core.plans.standing("s-a", "fewer-errors")).toMatchObject({ verdict: "contradicted", runId: otherRun.id });
  });
  it("returns the same run for a repeated queue request", () => {
    const f = setup(), { plan, run } = f.queued();
    expect(f.core.plans.queue({ planId: plan.id, version: 1, requestId: "run-1" }, owner)).toEqual(run);
  });
});
