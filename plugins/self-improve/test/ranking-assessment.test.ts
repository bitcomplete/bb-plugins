import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Store, MIGRATIONS } from "../src/store.js";
import { Runtime, type FocusedSolutionRanking, type SolutionAssessment } from "../src/runtime.js";
import { defaultConfig } from "../src/config.js";
import type { NativeExecution, NativeTaskRequest } from "../src/native-tasks.js";
import type { StageContext } from "../src/services.js";
import type { Problem, Solution } from "../src/domain/types.js";
import type { PrivacyPolicy } from "../src/adapters/privacy.js";
import { addObjective, setObjectiveFocus } from "../src/objectives.js";
import { NOW, problem, solution, vote } from "./domain/fixtures.js";

// Completion and research boundaries are replaced: no account, gateway, cost, queue,
// network or service lifecycle is exercised by these ranking regressions.
const mocks = vi.hoisted(() => ({ complete: vi.fn(), scout: vi.fn(), invent: vi.fn() }));
vi.mock("../src/native-model.js", () => ({ completeJson: async(runner:unknown,request:NativeTaskRequest,signal?:AbortSignal) => ({
  taskId:request.id,runId:request.runId,stage:request.stage,solutionId:request.solutionId,providerId:request.execution.providerId,model:request.execution.model,
  threadId:`thread-${request.id}`,turnId:`turn-${request.id}`,modelIdentitySource:"requested-selection",startedAtMs:NOW,endedAtMs:NOW,
  ...await mocks.complete(runner,request,signal),
}) }));
vi.mock("../src/stages/native-research.js", () => ({ scout: mocks.scout, inventCandidates: mocks.invent }));
const dbs: Database.Database[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); Object.values(mocks).forEach(fn => fn.mockReset()); });
afterEach(() => { dbs.splice(0).forEach(db => db.close()); vi.useRealTimers(); });
function context(stage: StageContext["job"]["stage"], input: Record<string, unknown> = {}, controller = new AbortController(),id:string=stage): StageContext {
  return { job: { id, runId: "ranking-run", stage, key: id, input, attempts: 1, createdAt: NOW }, signal: controller.signal, boot: "boot" };
}
function reply(requestId = "request-one", value: unknown = { scores: solution().scores, reasons: solution().scoreReasons }) {
  return { value, requestId, promptHash: "a".repeat(64) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const db = new Database(":memory:"); dbs.push(db); MIGRATIONS.forEach(sql => db.exec(sql)); const store = new Store(db);
  const config = { ...defaultConfig(), providerId:"codex",model: "ranking-model",projectId:"project",environmentId:"environment" }, privacy: PrivacyPolicy = { clientNames: ["PrivateClient"] };
  const runtime = new Runtime({ bb: { sdk: {} } as BbPluginApi, store, config: () => config, privacy: () => privacy,
    runner:{execute:async()=>{throw new Error("ranking completion is mocked");}},execution:():NativeExecution=>({projectId:config.projectId,environment:{type:"reuse",environmentId:config.environmentId},providerId:config.providerId,model:config.model,permissionMode:"accept-edits"}),privacyGeneration:()=>"privacy-one", 
    workers: () => { throw new Error("ranking must not start workers"); }, build: async () => { throw new Error("ranking must not build"); } });
  const p = problem(); p.aliases = ["legacy-candidate", "legacy-history"];
  const candidate = solution(); candidate.problemIds = ["legacy-candidate"];
  candidate.title = "PrivateClient retry improvement";
  candidate.scores = { fit: null, benefit: null, testability: null, feasibility: null, safety: null, effort: null };
  const prior = solution("prior"); prior.problemIds = ["legacy-history"]; prior.status = "removed"; prior.directionKey = "different-failed-direction";
  prior.attempts = [{ id: "prior-attempt", atMs: NOW - 1, directionKey: prior.directionKey, prediction: prior.prediction,
    outcome: "failed", evidenceIds: ["retained-evidence"], reason: "PrivateClient replay failed", model: { provider: "fixture", model: "prior-model" } }];
  store.put("problems", p.id, p); store.put("problems", "p-b", problem("p-b", "A different failure"));
  store.put("solutions", candidate.id, candidate); store.put("solutions", prior.id, prior); store.put("votes", "vote", vote());
  await runtime.handlers["problem-ranker"](context("problem-ranker"));
  const snapshotId = store.get<string>("snapshot", "latest")!;
  await prepareResearch(runtime,snapshotId);
  // Restore alias-bearing records to exercise resolution at the ranking boundary.
  store.put("solutions",candidate.id,candidate);store.put("solutions",prior.id,prior);
  return { store, runtime, config, privacy, candidate:{...candidate,problemIds:[p.id]}, prior:{...prior,problemIds:[p.id]}, snapshotId };
}
async function prepareResearch(runtime:Runtime,snapshotId:string,counts:Record<string,number>={}) {
  const result=async(ctx:{snapshotId:string})=>({snapshotId:ctx.snapshotId,candidates:[],papers:[],paperAssessments:[],receipts:[],warnings:[],counts});
  mocks.scout.mockImplementation(result);mocks.invent.mockImplementation(result);
  for(const stage of ["scout","inventor"] as const)await runtime.handlers[stage](context(stage,{},new AbortController(),`${stage}:${snapshotId}`));
  mocks.scout.mockClear();mocks.invent.mockClear();
}
function freshContext(suffix:string){return context("solution-ranker",{},new AbortController(),`solution-ranker:${suffix}`);}
type Fixture = Awaited<ReturnType<typeof setup>>;
function updateCandidate(f: Fixture, update: (s: Solution) => void) {
  const current = f.store.get<Solution>("solutions", f.candidate.id)!; update(current); f.store.put("solutions", current.id, current);
}
function updateProblem(f: Fixture, update: (p: Problem) => void) {
  const current = f.store.get<Problem>("problems", "p-a")!; update(current); f.store.put("problems", current.id, current);
}
function assessments(store: Store) { return store.list<SolutionAssessment>("solution-assessments"); }
function requestBody(index = 0) {
  return JSON.parse((mocks.complete.mock.calls[index]![1] as NativeTaskRequest).input);
}

describe("asynchronous candidate assessments", () => {
  it("waits for a response, resolves context/history aliases and persists bounded provenance without private prompts", async () => {
    const f = await setup(), pending = deferred<ReturnType<typeof reply>>();
    mocks.complete.mockReturnValueOnce(pending.promise);
    const running = f.runtime.handlers["solution-ranker"](context("solution-ranker"));
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(f.store.get<Solution>("solutions", f.candidate.id)?.scores.fit).toBeNull();
    expect(assessments(f.store)).toEqual([]);
    const body = requestBody();
    expect(body.problems).toHaveLength(1); expect(body.problems[0].causes).toEqual(["Retries lose the original payload"]);
    expect(body.history.find((s: { status: string }) => s.status === "removed").attempts[0]).toMatchObject({ outcome: "failed", reason: "[redacted] replay failed" });
    expect(JSON.stringify(body)).not.toContain("PrivateClient");
    pending.resolve(reply()); await running;
    const record = assessments(f.store)[0]!;
    expect(record).toEqual({ id: expect.any(String), solutionId: f.candidate.id, snapshotId: f.snapshotId, runId: "ranking-run", atMs: NOW,
      model: { provider: "codex", model: "ranking-model" }, requestId: "request-one", taskId:expect.any(String),threadId:expect.any(String),turnId:expect.any(String),modelIdentitySource:"requested-selection",
      promptHash: "a".repeat(64), inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), disposition: "applied" });
    expect(JSON.stringify(record)).not.toContain("PrivateClient"); expect(JSON.stringify(record)).not.toContain(f.candidate.mechanism);
    expect(f.store.get<Solution>("solutions", f.candidate.id)).toEqual({ ...f.candidate, scores: solution().scores, scoreReasons: solution().scoreReasons });
    expect(f.store.get<FocusedSolutionRanking[]>("solution-ranking", "latest")?.[0]).toMatchObject({ solutionId: f.candidate.id, eligible: true });
    expect(f.store.list("native-ranking-operations")).toEqual([expect.objectContaining({taskId:record.taskId,runId:"ranking-run",inputFingerprint:record.inputFingerprint})]);
    expect(record).not.toHaveProperty("accountId");
  });

  const candidateEdits: Array<[string, (s: Solution) => void]> = [
    ["title", s => { s.title = "Owner revised title"; }],
    ["mechanism", s => { s.mechanism = "A different mechanism"; }],
    ["assumptions", s => { s.assumptions.push("Owner revised assumption"); }],
    ["test plan", s => { s.testPlan = "Owner revised falsifiable test"; }],
    ["linked problems", s => { s.problemIds = ["p-b"]; }],
    ["direction", s => { s.directionKey = "owner-direction"; }],
    ["new evidence", s => { s.newEvidenceIds.push("owner-evidence"); }],
    ["prediction symptoms", s => { s.prediction.symptomIds = ["owner-symptom"]; }],
    ["prediction KPI", s => { s.prediction.kpi.target = 0.5; }],
    ["rejected state", s => { s.candidateState = "rejected"; }],
    ["built state", s => { s.candidateState = "built"; }],
    ["lifecycle", s => { s.status = "removed"; }],
    ["owner score", s => { s.scores.fit = 0.1; }],
    ["owner completed scores", s => { s.scores = solution().scores; }],
    ["score reason", s => { s.scoreReasons.fit = "Owner estimate"; }],
    ["provenance", s => { s.provenance[0]!.sourceId = "owner-source"; }],
    ["redacted-only text", s => { s.title = "PRIVATECLIENT retry improvement"; }],
  ];
  it.each(candidateEdits)("does not overwrite an owner edit to %s while a response is pending", async (_name, update) => {
    const f = await setup(), pending = deferred<ReturnType<typeof reply>>(); mocks.complete.mockReturnValueOnce(pending.promise);
    const running = f.runtime.handlers["solution-ranker"](context("solution-ranker"));
    updateCandidate(f, update); const ownerVersion = f.store.get<Solution>("solutions", f.candidate.id);
    const rejected = expect(running).rejects.toThrow("ranking-input-changed"); pending.resolve(reply()); await rejected;
    expect(f.store.get("solutions", f.candidate.id)).toEqual(ownerVersion);
    expect(assessments(f.store)).toEqual([expect.objectContaining({ disposition: "stale" })]);
    expect(f.store.get("solution-ranking", "latest")).toBeNull();
  });

  const stateEdits: Array<[string, (f: Fixture) => void]> = [
    ["current linked problem", f => updateProblem(f, p => { p.causes[0]!.text = "Owner revised cause"; })],
    ["history evidence", f => { f.prior.attempts[0]!.evidenceIds.push("new-evidence"); f.store.put("solutions", f.prior.id, f.prior); }],
    ["history reason", f => { f.prior.attempts[0]!.reason = "Owner revised failure"; f.store.put("solutions", f.prior.id, f.prior); }],
    ["new linked history", f => { const other = solution("new-history"); other.status = "removed"; f.store.put("solutions", other.id, other); }],
    ["removed linked history", f => { f.store.remove("solutions", f.prior.id); }],
    ["changed alias links", f => updateProblem(f, p => { p.aliases = ["legacy-candidate"]; })],
    ["snapshot content", f => { const snap = f.store.get<Record<string, unknown>>("problem-snapshots", f.snapshotId)!; f.store.put("problem-snapshots", f.snapshotId, { ...snap, atMs: NOW + 1 }); }],
    ["deleted snapshot", f => { f.store.remove("problem-snapshots", f.snapshotId); }],
    ["deleted candidate", f => { f.store.remove("solutions", f.candidate.id); }],
    ["model setting", f => { f.config.model = "different-model"; }],
    ["privacy policy", f => { f.privacy.clientNames = ["PrivateClient", "NewClient"]; }],
    ["reverted owner edit", f => { updateCandidate(f, s => { s.testPlan = "Temporary edit"; }); f.store.put("solutions", f.candidate.id, f.candidate); }],
  ];
  it.each(stateEdits)("rejects a response after %s changes", async (_name, update) => {
    const f = await setup(), pending = deferred<ReturnType<typeof reply>>(); mocks.complete.mockReturnValueOnce(pending.promise);
    const running = f.runtime.handlers["solution-ranker"](context("solution-ranker"));
    update(f); const ownerVersion = f.store.get<Solution>("solutions", f.candidate.id);
    const rejected = expect(running).rejects.toThrow("ranking-input-changed"); pending.resolve(reply()); await rejected;
    expect(f.store.get("solutions", f.candidate.id)).toEqual(ownerVersion);
    expect(assessments(f.store)[0]?.disposition).toBe("stale"); expect(f.store.get("solution-ranking", "latest")).toBeNull();
  });

  it("requires a new job for changed state, then skips already applied scores", async () => {
    const f = await setup(), pending = deferred<ReturnType<typeof reply>>(); mocks.complete.mockReturnValueOnce(pending.promise);
    const running = f.runtime.handlers["solution-ranker"](context("solution-ranker"));
    updateCandidate(f, s => { s.testPlan = "Updated owner test plan"; });
    const rejected = expect(running).rejects.toThrow("ranking-input-changed"); pending.resolve(reply()); await rejected;
    await expect(f.runtime.handlers["solution-ranker"](context("solution-ranker"))).rejects.toThrow("ranking-input-changed-new-job-required");
    mocks.complete.mockResolvedValueOnce(reply("fresh-request"));
    await f.runtime.handlers["solution-ranker"](freshContext("changed-input"));
    expect(requestBody(1).candidate.testPlan).toBe("Updated owner test plan");
    const records = assessments(f.store), fresh = records.find(r => r.disposition === "applied")!, stale = records.find(r => r.disposition === "stale")!;
    expect(fresh.inputFingerprint).not.toBe(stale.inputFingerprint); expect(fresh.requestId).toBe("fresh-request");
    await f.runtime.handlers["solution-ranker"](freshContext("changed-input"));
    expect(mocks.complete).toHaveBeenCalledTimes(2); expect(assessments(f.store)).toHaveLength(2);
  });

  it("does not apply a response after cancellation", async () => {
    const f = await setup(), pending = deferred<ReturnType<typeof reply>>(), controller = new AbortController(); mocks.complete.mockReturnValueOnce(pending.promise);
    const running = f.runtime.handlers["solution-ranker"](context("solution-ranker", {}, controller)); controller.abort();
    const rejected = expect(running).rejects.toThrow("service-stopped"); pending.resolve(reply()); await rejected;
    expect(f.store.get("solutions", f.candidate.id)).toEqual(f.candidate); expect(assessments(f.store)[0]?.disposition).toBe("stale");
  });

  const malformed: Array<[string, unknown]> = [
    ["missing scores", { reasons: solution().scoreReasons }],
    ["out of range factor", { scores: { ...solution().scores, fit: 1.01 }, reasons: solution().scoreReasons }],
    ["zero effort", { scores: { ...solution().scores, effort: 0 }, reasons: solution().scoreReasons }],
    ["excessive effort", { scores: { ...solution().scores, effort: 101 }, reasons: solution().scoreReasons }],
    ["unknown score field", { scores: { ...solution().scores, adopted: true }, reasons: solution().scoreReasons }],
    ["unknown response field", { scores: solution().scores, reasons: solution().scoreReasons, adopted: true }],
    ["wrong reason type", { scores: solution().scores, reasons: { ...solution().scoreReasons, fit: 1 } }],
    ["empty reason", { scores: solution().scores, reasons: { ...solution().scoreReasons, fit: "" } }],
    ["blank reason", { scores: solution().scores, reasons: { ...solution().scoreReasons, fit: " \t\n " } }],
    ["private reason", { scores: solution().scores, reasons: { ...solution().scoreReasons, fit: "PrivateClient wants this" } }],
  ];
  it.each(malformed)("rejects %s without caching it as usable, and accepts a new-job assessment", async (_name, value) => {
    const f = await setup(); mocks.complete.mockResolvedValueOnce(reply("invalid-request", value));
    await expect(f.runtime.handlers["solution-ranker"](context("solution-ranker"))).rejects.toThrow();
    expect(f.store.get("solutions", f.candidate.id)).toEqual(f.candidate); expect(f.store.get("solution-ranking", "latest")).toBeNull();
    expect(assessments(f.store)).toEqual([expect.objectContaining({ requestId: "invalid-request", disposition: "invalid" })]);
    expect(JSON.stringify(assessments(f.store))).not.toContain("PrivateClient");
    await expect(f.runtime.handlers["solution-ranker"](context("solution-ranker"))).rejects.toThrow("native-ranking-invalid-new-job-required");
    mocks.complete.mockResolvedValueOnce(reply("valid-retry")); await f.runtime.handlers["solution-ranker"](freshContext("valid-new-job"));
    expect(f.store.get<Solution>("solutions", f.candidate.id)?.scores).toEqual(solution().scores);
    expect(assessments(f.store).find(r => r.disposition === "applied")?.requestId).toBe("valid-retry");
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });

  it("uses a fresh job after failed completion without inventing request provenance", async () => {
    const f = await setup(); mocks.complete.mockRejectedValueOnce(new Error("completion unavailable"));
    await expect(f.runtime.handlers["solution-ranker"](context("solution-ranker"))).rejects.toThrow("completion unavailable");
    expect(f.store.get("solutions", f.candidate.id)).toEqual(f.candidate); expect(assessments(f.store)).toEqual([]);
    mocks.complete.mockResolvedValueOnce(reply()); await f.runtime.handlers["solution-ranker"](freshContext("completion-retry"));
    expect(assessments(f.store)[0]?.disposition).toBe("applied");
  });

  it.each(["advance","revert"])("retains the job snapshot when the latest pointer is changed: %s",async(change)=>{
    const f=await setup(),pending=deferred<ReturnType<typeof reply>>();mocks.complete.mockReturnValueOnce(pending.promise);
    const running=f.runtime.handlers["solution-ranker"](context("solution-ranker"));
    f.store.put("snapshot","latest","temporary");if(change==="revert")f.store.put("snapshot","latest",f.snapshotId);
    pending.resolve(reply());await running;
    expect(assessments(f.store)[0]).toMatchObject({disposition:"applied",snapshotId:f.snapshotId});
    expect(f.store.get("native-job-snapshots","solution-ranker")).toMatchObject({snapshotId:f.snapshotId});
  });

  it("leaves an explicitly selected snapshot valid when the latest pointer changes", async () => {
    const f = await setup(), pending = deferred<ReturnType<typeof reply>>(); mocks.complete.mockReturnValueOnce(pending.promise);
    const running = f.runtime.handlers["solution-ranker"](context("solution-ranker", { snapshotId: f.snapshotId }));
    f.store.put("snapshot", "latest", "another-snapshot"); pending.resolve(reply()); await running;
    expect(assessments(f.store)[0]).toMatchObject({ disposition: "applied", snapshotId: f.snapshotId });
  });

  it("preserves owner focus through merged aliases in both snapshot selection and candidate ordering", async () => {
    const f = await setup(), owner = { kind: "owner" as const, id: "owner" };
    const high = addObjective(f.store, { requestId: "high", kind: "problem", title: "High focus", description: "Owner priority" }, owner, s => s, NOW);
    const low = addObjective(f.store, { requestId: "low", kind: "problem", title: "Low focus", description: "Another owner priority" }, owner, s => s, NOW);
    setObjectiveFocus(f.store, high.id, 5, owner, NOW); setObjectiveFocus(f.store, low.id, 2, owner, NOW);
    // These objective IDs survive a ledger merge as aliases of a single problem.
    f.store.remove("problems", high.problemId); f.store.remove("problems", low.problemId);
    updateProblem(f, p => { p.aliases.push(high.problemId, low.problemId); });
    for (const entry of f.store.entries("votes")) f.store.remove("votes", entry.key);
    await f.runtime.handlers["problem-ranker"](context("problem-ranker"));
    const snapshotId = f.store.get<string>("snapshot", "latest")!;
    expect(f.store.get<{ focusProblemIds: string[]; problems: Problem[] }>("problem-snapshots", snapshotId)).toMatchObject({ focusProblemIds: ["p-a"], problems: [expect.objectContaining({ id: "p-a" })] });
    const other = solution("unfocused"); other.problemIds = ["p-b"]; other.prediction.symptomIds = ["symptom-p-b"]; f.store.put("solutions", other.id, other);
    await prepareResearch(f.runtime,snapshotId);
    mocks.complete.mockResolvedValueOnce(reply()); await f.runtime.handlers["solution-ranker"](context("solution-ranker"));
    expect(f.store.get<FocusedSolutionRanking[]>("solution-ranking", "latest")?.[0]).toMatchObject({ solutionId: f.candidate.id, focusPriority: 5, selectionBasis: "owner-focus", eligible: true });
    expect(f.store.list("votes")).toEqual([]);
  });

  it("reselects a cached snapshot and its completed research when owner focus returns to an earlier preference", async () => {
    const f = await setup(), owner = { kind: "owner" as const, id: "owner" };
    const objective = addObjective(f.store, { requestId: "reversible", kind: "problem", title: "Reversible focus", description: "Owner priority" }, owner, s => s, NOW);
    setObjectiveFocus(f.store, objective.id, 1, owner, NOW);
    await f.runtime.handlers["problem-ranker"](context("problem-ranker"));
    const firstId = f.store.get<string>("snapshot", "latest")!;
    const first = f.store.get<{ ranking: unknown }>("problem-snapshots", firstId)!;
    const version = f.store.version("problem-snapshots", firstId);
    await prepareResearch(f.runtime,firstId,{candidates:7});
    vi.setSystemTime(NOW + 1000);
    setObjectiveFocus(f.store, objective.id, 5, owner, NOW);
    await f.runtime.handlers["problem-ranker"](context("problem-ranker"));
    expect(f.store.get("snapshot", "latest")).not.toBe(firstId);
    expect(f.store.get("ranking", "latest")).not.toEqual(first.ranking);
    setObjectiveFocus(f.store, objective.id, 1, owner, NOW);
    expect(await f.runtime.handlers["problem-ranker"](context("problem-ranker"))).toMatchObject({ reused: 1 });
    expect(f.store.get("snapshot", "latest")).toBe(firstId);
    expect(f.store.get("ranking", "latest")).toEqual(first.ranking);
    expect(f.store.get("problem-snapshots", firstId)).toEqual(first); expect(f.store.version("problem-snapshots", firstId)).toBe(version);
    for (const stage of ["scout", "inventor"] as const) expect(await f.runtime.handlers[stage](context(stage))).toEqual({ candidates: 7 });
    expect(mocks.scout).not.toHaveBeenCalled(); expect(mocks.invent).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
    const selectionVersion = f.store.version("snapshot", "latest");
    await f.runtime.handlers["problem-ranker"](context("problem-ranker"));
    expect(f.store.version("snapshot", "latest")).toBe(selectionVersion);
  });
});
