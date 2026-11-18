import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { inventCandidates, scout, type ResearchCheckpoint, type ResearchContext } from "../src/stages/native-research.js";
import type { NativeTaskRequest, NativeTaskReceipt } from "../src/native-tasks.js";
import type { Paper } from "../src/adapters/types.js";
import { problem, NOW } from "./domain/fixtures.js";
const proposal = { mechanism: "Validate input shape", prediction: "Fewer invalid calls", assumptions: ["Schemas exist; no additional BB plugins required"], test: "Run schema error cases", effort: 2, risk: 1 };
const paper: Paper = { id: "2609.14858", version: "v2", title: "Validation", abstract: "Validate calls before executing them.", authors: ["Author"], publishedAt: "2026-09-14T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z", url: "https://arxiv.org/abs/2609.14858v2", source: "arxiv", fwci: null, authorSignal: null, retrievedAt: "2026-11-18T00:00:00Z" };
const review = { relevant: true, impact: 4, fit: 5, reasons: { impact: "Estimated potential reduction", fit: "Estimated direct applicability" }, proposal };
function receipt(request: NativeTaskRequest, value: unknown): NativeTaskReceipt { return { taskId: request.id, runId: request.runId, stage: request.stage, providerId: request.execution.providerId, model: request.execution.model, threadId: `thread-${request.id}`, requestId: `request-${request.id}`, turnId: `turn-${request.id}`, text: JSON.stringify(value), promptHash: createHash("sha256").update(request.instructions + request.input).digest("hex"), startedAtMs: 1, endedAtMs: 2, modelIdentitySource: "requested-selection" }; }
function setup(value: unknown = [proposal]) {
  const saved = new Map<string, ResearchCheckpoint>();
  const execute = vi.fn(async (request: NativeTaskRequest) => receipt(request, value));
  const checkpoints: ResearchContext["checkpoints"] = {
    read: async key => saved.has(key) ? structuredClone(saved.get(key)!) : null,
    claim: async (key, proposed) => { if (!saved.has(key)) saved.set(key, structuredClone(proposed)); return structuredClone(saved.get(key)!); },
    write: async (key, entry) => { saved.set(key, structuredClone(entry)); },
  };
  const ctx: ResearchContext = { runner: { execute }, execution: { providerId: "codex", model: "selected", projectId: "p", environment: { type: "reuse", environmentId: "e" } }, privacyGeneration: "v1", currentPrivacyGeneration: () => "v1", runId: "run-first", snapshotId: "snapshot", now: NOW, problems: [problem()], signal: new AbortController().signal, checkpoints };
  return { saved, execute, checkpoints, ctx };
}
describe("BB-native research", () => {
  it("retains requested provider identity and reuses exact receipts and attempts on later job attempts", async () => {
    const { ctx, execute, saved } = setup();
    const first = await inventCandidates(ctx), again = await inventCandidates({ ...ctx, runId: "later-job-attempt" });
    expect(again.candidates).toEqual(first.candidates);
    expect(again.receipts).toEqual(first.receipts);
    expect(first.candidates[0].provenance[0].model).toEqual({ provider: "codex", model: "selected" });
    expect(first.candidates[0]).toMatchObject({ origin: "inventor", sourcePaper: null, candidateState: "proposed", status: null });
    expect(again.counts).toMatchObject({ taskRequests: 0, cacheHits: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
    const request = execute.mock.calls[0][0];
    expect(Object.keys(JSON.parse(request.input))).toEqual(["symptoms", "rootCauseHypothesis"]);
    expect(request.input).not.toContain("p-a");
    expect(JSON.stringify([...saved.values()])).not.toContain('"text":');
  });
  it("retains distinct same-mechanism hypotheses with independent identities", async () => {
    const alternatives = [proposal, { ...proposal, prediction: "Fewer repeated errors", assumptions: ["A schema plugin is required"], test: "Compare retry failures", effort: 3, risk: 2 }];
    const { ctx } = setup(alternatives);
    const first = await inventCandidates(ctx), replay = await inventCandidates({ ...ctx, runId: "replay" });
    expect(first.candidates).toHaveLength(2);
    expect(new Set(first.candidates.map(candidate => candidate.id)).size).toBe(2);
    expect(new Set(first.candidates.flatMap(candidate => candidate.attempts.map(attempt => attempt.id))).size).toBe(2);
    expect(new Set(first.candidates.map(candidate => candidate.directionKey)).size).toBe(1);
    expect(first.candidates.map(candidate => candidate.prediction.change).sort()).toEqual(alternatives.map(candidate => candidate.prediction).sort());
    expect(replay.candidates).toEqual(first.candidates);
  });
  it("coalesces exact duplicate proposals deterministically without discarding another definition", async () => {
    const alternative = { ...proposal, test: "Run different schema error cases" };
    const first = setup([proposal, alternative, { ...proposal }]), reverse = setup([alternative, { ...proposal }, proposal]);
    const a = await inventCandidates(first.ctx), b = await inventCandidates(reverse.ctx);
    expect(a.candidates).toHaveLength(2);
    expect(a.counts.candidates).toBe(2);
    expect(b.candidates).toEqual(a.candidates);
    expect(new Set(a.candidates.map(candidate => candidate.id)).size).toBe(2);
  });
  it("binds a task before dispatch and recovers it after a lost checkpoint write without creating another task", async () => {
    const { ctx, execute, checkpoints } = setup();
    let failWrite = true;
    ctx.checkpoints = { ...checkpoints, write: async (key, entry) => { if (failWrite) { failWrite = false; throw Error("interrupted before persistence"); } await checkpoints.write(key, entry); } };
    await expect(inventCandidates(ctx)).rejects.toThrow("interrupted before persistence");
    const result = await inventCandidates({ ...ctx, runId: "retry-run" });
    expect(execute.mock.calls[1][0]).toEqual(execute.mock.calls[0][0]);
    expect(result.receipts[0].runId).toBe("run-first");
    // execute is a recovery request; NativeTaskRunner owns whether any provider dispatch occurs.
    expect(result.counts.taskRequests).toBe(1);
  });
  it("rejects changed selection, policy or source bindings before another task request", async () => {
    const { ctx, execute } = setup();
    await inventCandidates(ctx);
    await expect(inventCandidates({ ...ctx, execution: { ...ctx.execution, providerId: "claude-code" } })).rejects.toThrow("immutable input");
    await expect(inventCandidates({ ...ctx, privacyGeneration: "v2", currentPrivacyGeneration: () => "v2" })).rejects.toThrow("immutable input");
    await expect(inventCandidates({ ...ctx, problems: [{ ...problem(), symptoms: [{ ...problem().symptoms[0], id: "new-symptom" }] }] })).rejects.toThrow("immutable input");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("refuses obsolete cached work and late replies after privacy changes", async () => {
    const cached = setup();
    await inventCandidates(cached.ctx);
    await expect(inventCandidates({ ...cached.ctx, currentPrivacyGeneration: () => "changed" })).rejects.toThrow("privacy policy changed");
    const late = setup(); let version = "v1";
    late.ctx.currentPrivacyGeneration = () => version;
    late.execute.mockImplementation(async request => { version = "v2"; return receipt(request, [proposal]); });
    await expect(inventCandidates(late.ctx)).rejects.toThrow("privacy policy changed");
    expect([...late.saved.values()][0].result).toMatchObject({ phase: "pending" });
  });
  it("shares the first pending operation binding across concurrent job attempts", async () => {
    const { ctx, execute } = setup();
    const [first, second] = await Promise.all([inventCandidates(ctx), inventCandidates({ ...ctx, runId: "concurrent" })]);
    expect(first.candidates).toEqual(second.candidates);
    for (const [request] of execute.mock.calls) expect(request.runId).toBe("run-first");
  });
  it("preserves completed operations when another problem fails", async () => {
    const { ctx, execute } = setup();
    let number = 0;
    execute.mockImplementation(async request => { if (++number === 2) throw Error("task unavailable"); return receipt(request, [proposal]); });
    const multiple = { ...ctx, concurrency: 1, problems: [problem(), problem("p-b")] };
    await expect(inventCandidates(multiple)).rejects.toThrow("task unavailable");
    const result = await inventCandidates({ ...multiple, runId: "next" });
    expect(result.counts).toMatchObject({ taskRequests: 1, cacheHits: 1, candidates: 2 });
    expect(execute.mock.calls[2][0]).toEqual(execute.mock.calls[1][0]);
  });
  it("falls directly from DAIR to arXiv and leaves abstract-only evidence deferred", async () => {
    const { ctx } = setup(review), search = vi.fn(async () => [paper]);
    const result = await scout({ ...ctx, arxiv: { search }, dair: { search: async () => { throw Error("remote failure"); } }, wildcardQueries: ["agent validation"] });
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.warnings).toContain("DAIR unavailable; direct arXiv fallback used");
    expect(result.paperAssessments).toHaveLength(2);
    expect(result.paperAssessments[0]).toMatchObject({ strength: null, score: null, provisionalScore: 20, status: "deferred" });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].candidateState).toBe("deferred");
  });
  it("replays frozen discovery after a partial model failure even if sources change", async () => {
    const { ctx, execute } = setup(review);
    const paperB = { ...paper, id: "2609.14859", url: "https://arxiv.org/abs/2609.14859v2", title: "Retry validation" };
    const paperC = { ...paper, id: "2609.14860", url: "https://arxiv.org/abs/2609.14860v2", title: "New discovery" };
    let discoveries = [paper, paperB], calls = 0;
    const search = vi.fn(async () => discoveries);
    execute.mockImplementation(async request => { if (++calls === 2) throw Error("interrupted second paper"); return receipt(request, review); });
    const context = { ...ctx, concurrency: 1, arxiv: { search } };
    await expect(scout(context)).rejects.toThrow("interrupted second paper");
    discoveries = [paperC];
    const recovered = await scout({ ...context, runId: "later" });
    expect(search).toHaveBeenCalledTimes(1);
    expect(recovered.papers.map(paper => paper.id)).toEqual([paper.id, paperB.id]);
    expect(recovered.candidates.map(candidate => candidate.sourcePaper!.id).sort()).toEqual([paper.id, paperB.id]);
    expect(recovered.counts).toMatchObject({ taskRequests: 1, cacheHits: 1, candidates: 2 });
    expect(recovered.receipts).toHaveLength(2);
    expect(execute.mock.calls[2][0]).toEqual(execute.mock.calls[1][0]);
  });
  it("keeps the original abstract-only scope when full text becomes available after failure", async () => {
    const { ctx, execute } = setup(review);
    const text = "Detailed methods and limitations. ".repeat(10);
    const fullText = { paperId: paper.id, version: paper.version, url: `https://arxiv.org/html/${paper.id}${paper.version}`, text, sha256: createHash("sha256").update(text).digest("hex"), retrievedAt: paper.retrievedAt };
    let available = false, calls = 0;
    const loadFullText = vi.fn(async () => available ? fullText : null);
    execute.mockImplementation(async request => { if (++calls === 1) throw Error("task interrupted"); return receipt(request, review); });
    const context = { ...ctx, arxiv: { search: async () => [paper] }, loadFullText };
    await expect(scout(context)).rejects.toThrow("task interrupted");
    available = true;
    const recovered = await scout({ ...context, runId: "later" });
    expect(loadFullText).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[1][0]).toEqual(execute.mock.calls[0][0]);
    expect(recovered.paperAssessments[0]).toMatchObject({ reviewedScope: "metadata-and-abstract", strength: null, status: "deferred" });
  });
  it("qualifies grounded full-text evidence and preserves its native receipt on recovery", async () => {
    const text = "We compared the intervention with a held-out baseline. " + "Methodology and limitations are reported. ".repeat(8);
    const fullText = { paperId: paper.id, version: paper.version, url: `https://arxiv.org/html/${paper.id}${paper.version}`, text, sha256: createHash("sha256").update(text).digest("hex"), retrievedAt: paper.retrievedAt };
    const value = { ...review, strength: { estimate: 3, reason: "Comparison reported; replication remains unknown", quotes: ["compared the intervention with a held-out baseline"] } };
    const { ctx, execute } = setup(value);
    const context = { ...ctx, arxiv: { search: async () => [{ ...paper, fwci: 2, authorSignal: 2, credibilityEvidenceUrls: ["https://example.org/metrics"] }] }, loadFullText: async () => fullText };
    const first = await scout(context), second = await scout({ ...context, runId: "again" });
    expect(first.paperAssessments[0]).toMatchObject({ strength: 3, score: .48, status: "assessed" });
    expect(first.candidates[0].candidateState).toBe("proposed");
    expect(second.receipts).toEqual(first.receipts);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain(text);
  });
  it("rejects unsupported strength claims and ungrounded quotations", async () => {
    const { ctx } = setup({ ...review, strength: { estimate: 5, reason: "Claimed", quotes: [] } });
    await expect(scout({ ...ctx, arxiv: { search: async () => [paper] } })).rejects.toThrow("invalid-paper-assessment");
    const text = "Detailed methods and limitations. ".repeat(10);
    const grounded = setup({ ...review, strength: { estimate: 5, reason: "Claimed", quotes: ["not found in the paper"] } });
    await expect(scout({ ...grounded.ctx, arxiv: { search: async () => [paper] }, loadFullText: async () => ({ paperId: paper.id, version: paper.version, url: `https://arxiv.org/html/${paper.id}${paper.version}`, text, sha256: createHash("sha256").update(text).digest("hex"), retrievedAt: paper.retrievedAt }) })).rejects.toThrow("ungrounded-paper-strength");
  });
});
