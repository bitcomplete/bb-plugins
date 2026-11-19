import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { createRevalidation, type RevalidationDefinition } from "../src/revalidation.js";
import { createRevalidationRunner, readAnswer, revalidationJobInput } from "../src/revalidation-runner.js";
import type { NativeTaskRequest } from "../src/native-tasks.js";
import type { StageContext } from "../src/services.js";
import { solution, NOW } from "./domain/fixtures.js";

const owner = { kind: "owner" as const, id: "owner" };
const worker = { providerId: "codex", model: "selected-model", permissionMode: "accept-edits" as const, projectId: "worker-project", environmentId: "worker-environment" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

type Reply = (request: NativeTaskRequest, input: string, treatment: boolean) => unknown;
function fixture(change?: (d: RevalidationDefinition) => void) {
  const db = new Database(":memory:"); databases.push(db); MIGRATIONS.forEach(sql => db.exec(sql)); const store = new Store(db);
  const s = solution(); store.put("solutions", s.id, s);
  const content = "Answer in lowercase.";
  store.put("native-evaluation-artifacts", "artifact", { solutionId: s.id, revision: "r1", kind: "instruction", content, artifactDigest: sha(content) });
  const definition: RevalidationDefinition = {
    target: { solutionId: s.id, namespace: "native-evaluation-artifacts", artifactId: "artifact", revision: "r1", artifactDigest: sha(content) },
    concern: "I doubt it helps.", claim: { id: "claim", text: "It improves exact answers" },
    cases: [{ id: "case-a", input: "First task", expected: "one" }, { id: "case-b", input: "Second task", expected: "two" }],
    criteria: [{ id: "gain", measure: "pass-rate", statistic: "difference", operator: "at-least", value: 0.5, required: true },
      { id: "no-regressions", measure: "regressions", statistic: "treatment", operator: "at-most", value: 0, required: true }],
    limits: { maxDurationMs: 600_000 },
  };
  change?.(definition);
  let time = NOW, allowed = true, selection: typeof worker | null = worker;
  const core = createRevalidation(store, { redact: t => t, now: () => time });
  const plan = core.plans.create({ requestId: "p", definition }, owner);
  core.plans.freeze({ planId: plan.id, expectedVersion: 1 }, worker, owner);
  const run = core.plans.queue({ planId: plan.id, version: 1, requestId: "r" }, owner);
  const requests: NativeTaskRequest[] = [];
  // Default model: answers correctly only with the instruction.
  let reply: Reply = (_r, input, treatment) => ({ output: treatment ? (input === "First task" ? "one" : "two") : "wrong" });
  const native = { execute: vi.fn(async (request: NativeTaskRequest, signal?: AbortSignal) => {
    requests.push(request);
    const value = await reply(request, JSON.parse(request.input).input, request.instructions.includes(content));
    signal?.throwIfAborted(); time += 10;
    return { taskId: request.id, runId: request.runId, stage: request.stage, solutionId: request.solutionId, providerId: request.execution.providerId, model: request.execution.model,
      modelIdentitySource: "requested-selection" as const, threadId: `thread-${requests.length}`, text: typeof value === "string" ? value : JSON.stringify(value), promptHash: "p", startedAtMs: time, endedAtMs: time, requestId: "q", turnId: "t" };
  }) };
  const controller = new AbortController();
  const ctx: StageContext = { job: { id: "job", runId: "svc", stage: "builder", key: `revalidation:${run.id}`, input: revalidationJobInput(run.id), attempts: 1, createdAt: NOW }, signal: controller.signal, boot: "boot" };
  const runner = createRevalidationRunner({ store, revalidation: core, runner: native as never, allowed: () => allowed, selection: () => selection, privacyGeneration: () => "g", taskTimeoutMs: () => 60_000, now: () => time });
  return { store, core, run, plan, runner, native, requests, ctx, controller, content, definition,
    state: () => core.plans.getRun(run.id), setReply: (next: Reply) => { reply = next; },
    disable: () => { allowed = false; }, changeWorker: () => { selection = { ...worker, model: "other" }; }, setTime: (t: number) => { time = t; } };
}

describe("rule 2: expected answers stay on the server", () => {
  it("sends only the case input, and the exact instruction bytes only with the treatment", async () => {
    const f = fixture(); await f.runner.handle(f.ctx);
    expect(f.requests).toHaveLength(4);
    for (const r of f.requests) { expect(r.input).not.toMatch(/"one"|"two"/); expect(r.instructions).not.toMatch(/\bone\b|\btwo\b/); }
    expect(f.requests.filter(r => r.instructions.includes(f.content))).toHaveLength(2);
    expect(JSON.stringify(f.store.list("revalidation-receipts"))).not.toContain("wrong");
  });
});

describe("rules 3 and 4: scoring and verdicts", () => {
  it("scores every case on the server and records the verdict", async () => {
    const f = fixture(); await f.runner.handle(f.ctx);
    expect(f.state().run).toMatchObject({ status: "completed", verdict: "supported" });
    expect(f.state().result).toMatchObject({ cases: 2, passed: { baseline: 0, treatment: 2 }, regressions: 0, unreadable: { baseline: 0, treatment: 0 } });
  });
  it("contradicts the claim when the treatment regresses", async () => {
    const f = fixture(); f.setReply((_r, input, treatment) => ({ output: input === "First task" ? (treatment ? "nope" : "one") : treatment ? "two" : "x" }));
    await f.runner.handle(f.ctx);
    expect(f.state().result).toMatchObject({ verdict: "contradicted", regressions: 1, passed: { baseline: 1, treatment: 1 } });
  });
  it("accepts one code fence, and counts other unreadable answers as failures on either arm", async () => {
    expect(readAnswer("```json\n{\"output\":\"one\"}\n```")).toBe("one");
    expect(readAnswer("Sure! {\"output\":\"one\"}")).toBeNull();
    const f = fixture(); f.setReply((_r, input, treatment) => treatment ? (input === "First task" ? "```\n{\"output\":\"one\"}\n```" : "not json") : "nope");
    await f.runner.handle(f.ctx);
    expect(f.state().result).toMatchObject({ passed: { baseline: 0, treatment: 1 }, unreadable: { baseline: 2, treatment: 1 } });
  });
});

describe("rule 3: stops leave no verdict", () => {
  it.each([
    ["owner cancel", (f: ReturnType<typeof fixture>) => f.core.plans.cancel({ runId: f.run.id, reason: "Stop" }, owner), "cancelled", /^Stop$/],
    ["plugin disabled", (f: ReturnType<typeof fixture>) => f.disable(), "blocked", /^revalidation-execution-disabled \(case case-a, treatment\)$/],
    ["worker settings changed", (f: ReturnType<typeof fixture>) => f.changeWorker(), "blocked", /^revalidation-worker-settings-changed/],
    ["time limit", (f: ReturnType<typeof fixture>) => f.setTime(NOW + 600_001), "blocked", /^revalidation-time-limit/],
  ] as const)("%s after the first call", async (_name, act, status, reason) => {
    const f = fixture(); f.setReply((r, input, treatment) => { if (f.requests.length === 1) act(f); return { output: treatment ? "one" : "x" }; });
    await f.runner.handle(f.ctx);
    expect(f.requests).toHaveLength(1);
    expect(f.state().run).toMatchObject({ status, verdict: null, reason: expect.stringMatching(reason) });
    expect(f.state().result).toBeNull();
  });
  it("names the error, case and arm when a native call fails", async () => {
    const f = fixture(); f.setReply(() => { if (f.requests.length === 2) throw Object.assign(new Error("x"), { code: "native-task-timeout" }); return { output: "x" }; });
    await f.runner.handle(f.ctx);
    expect(f.state().run).toMatchObject({ status: "failed", verdict: null, reason: "revalidation-native-call-failed: native-task-timeout (case case-a, treatment)" });
  });
  it("ends as needing a new run when the service stops mid-call", async () => {
    const f = fixture(); f.setReply(() => { f.controller.abort(); return { output: "x" }; });
    await f.runner.handle(f.ctx);
    expect(f.state().run).toMatchObject({ status: "blocked", verdict: null, reason: "interrupted-needs-new-run" });
  });
  it("refuses an instruction too large for a native task before any call", async () => {
    const f = fixture(); f.store.put("revalidation-frozen", `${f.plan.id}:1`, { ...f.core.plans.get(f.plan.id).frozen!, artifact: { ...f.core.plans.get(f.plan.id).frozen!.artifact, content: "x".repeat(33_000) } });
    await f.runner.handle(f.ctx);
    expect(f.requests).toHaveLength(0); expect(f.state().run.status).toBe("blocked");
  });
});

describe("rule 5: no repeated or unauthorised calls", () => {
  it("makes no calls when started while not allowed to spend", async () => {
    const f = fixture(); f.disable(); await f.runner.handle(f.ctx);
    expect(f.requests).toHaveLength(0); expect(f.state().run).toMatchObject({ status: "blocked", verdict: null });
  });
  it("shares one execution between concurrent deliveries and never re-runs a started run", async () => {
    const f = fixture();
    await Promise.all([f.runner.handle(f.ctx), f.runner.handle(f.ctx)]);
    expect(f.requests).toHaveLength(4);
    await f.runner.handle(f.ctx); expect(f.requests).toHaveLength(4);
    expect(new Set(f.requests.map(r => r.id)).size).toBe(4);
  });
  it("interrupts a run left running by a previous process instead of resuming it", async () => {
    const f = fixture(); f.core.executor.start(f.run.id);
    expect(f.runner.recover()).toBe(1);
    expect(f.state().run).toMatchObject({ status: "blocked", reason: "interrupted-needs-new-run" });
    await f.runner.handle(f.ctx); expect(f.requests).toHaveLength(0);
  });
});

describe("rule 8: rollback", () => {
  it("gives older plugin versions a job naming a solution that does not exist", () => {
    expect(revalidationJobInput("run-1")).toEqual({ kind: "revalidation", revalidationRunId: "run-1", solutionId: "revalidation-run:run-1" });
  });
});
