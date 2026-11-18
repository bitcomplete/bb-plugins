import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, Store } from "../src/store.js";
import { addObjective, listObjectives, setObjectiveFocus } from "../src/objectives.js";
import { recordPerformance, performanceHistory } from "../src/performance.js";
import { approvePublication, prepareExport, assertSafeArtifactPath, type ValidatedArtifact, type TrustedEvaluation } from "../src/publication.js";
import { DAY, NOW, solution } from "./domain/fixtures.js";
import { redact as policyRedact } from "../src/adapters/privacy.js";

const dbs: Database.Database[] = [];
function store(): Store { const db = new Database(":memory:"); dbs.push(db); for (const migration of MIGRATIONS) db.exec(migration); return new Store(db); }
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const owner = { kind: "owner" as const, id: "owner-local" };
const redact = (s: string) => s.replaceAll("secret-token", "[redacted]");
function trusted(store: Store) {
  const s = solution(); s.status = "active"; s.candidateState = "built";
  s.wiring = { location: "instruction-slot-a", activatedAtMs: NOW - DAY, executionCount: 4, undo: "Disable instruction slot instruction-slot-a" };
  s.builtWith = s.validatedWith = { provider: "provider", model: "model" }; store.put("solutions", s.id, s);
  const content = "Preserve the original request payload when retrying a failed tool call.";
  const artifactDigest = createHash("sha256").update(content).digest("hex");
  const evaluation: TrustedEvaluation = { id: "eval-one", solutionId: s.id, revision: "revision-one", artifactDigest, heldOutManifestDigest: "b".repeat(64), model: s.validatedWith, createdAtMs: NOW - DAY, status: "passed", executionCount: 1, kind: "evaluation",
    proof: { manifestCommit: "a".repeat(40), manifestCommittedAtMs: NOW - 3 * DAY, patchCreatedAtMs: NOW - 2 * DAY, proposerVisibleTaskIds: ["visible"], heldOutTaskIds: ["sealed"], proposerVisibleFamilyIds: ["visible-family"], heldOutFamilyIds: ["sealed-family"], isolationVerified: true, passed: true, proofRef: "receipt-one" } };
  const artifact: ValidatedArtifact = { solutionId: s.id, revision: "revision-one", kind: "instruction", content, artifactDigest, evaluationId: evaluation.id, wiringLocation: s.wiring.location, activatedAtMs: s.wiring.activatedAtMs! };
  store.put("trusted-evaluations", evaluation.id, evaluation); store.put("validated-artifacts", s.id, artifact);
  return { s, artifact, evaluation };
}
describe("owner objectives", () => {
  it("creates a measurable owner goal without invented evidence or votes", () => {
    const db = store();
    const objective = addObjective(db, { requestId: "request-one", kind: "goal", title: "Reduce retries", description: "Reduce redundant tool calls", metric: { name: "tool retries per session", unit: "retries/session", target: 0.1, direction: "lower" } }, owner, redact, NOW);
    expect(objective.metric?.target).toBe(0.1);
    expect(db.list("votes")).toEqual([]);
    expect(JSON.stringify(db.list("problems"))).toContain("not established");
    setObjectiveFocus(db, objective.id, 5, owner, NOW + 1);
    expect(listObjectives(db)[0]?.focus?.priority).toBe(5);
    expect(db.list("votes")).toEqual([]);
  });
  it("requires owner provenance and a measurable goal, and makes request replay idempotent", () => {
    const db = store(), input = { requestId: "request-one", kind: "problem" as const, title: "Retry loses data", description: "Payload omitted" };
    const first = addObjective(db, input, owner, redact, NOW);
    expect(addObjective(db, input, owner, redact, NOW + 1).id).toBe(first.id);
    expect(db.list("objectives")).toHaveLength(1);
    expect(() => addObjective(db, input, { kind: "service", id: "worker" }, redact, NOW)).toThrow(/owner/);
    expect(() => addObjective(db, { ...input, kind: "goal" }, owner, redact, NOW)).toThrow(/metric/);
    expect(() => addObjective(db, { ...input, title: "Changed intent" }, owner, redact, NOW)).toThrow(/conflict/);
  });
});
describe("append-only measured performance", () => {
  it("computes confidence-aware verdicts, stores costs/model and deduplicates the measurement", () => {
    const db = store(); const { s } = trusted(db);
    const input = { measurementKey: "week-one", solutionId: s.id, solutionRevision: "revision-one", before: { startMs: NOW - 15 * DAY, endMs: NOW - 8 * DAY, sessions: 10000, votes: 1000 }, after: { startMs: NOW - 7 * DAY, endMs: NOW, sessions: 10000, votes: 100 }, model: { provider: "provider", model: "model" }, costs: [{ currency: "USD", reportedMicros: 0, estimatedMicros: 1200, unknownAttempts: 1 }], confounders: ["another instruction changed"], evidenceRefs: ["observed-window-one"], observedAtMs: NOW };
    const record = recordPerformance(db, input);
    expect(record.verification.verdict).toBe("REDUCED");
    expect(record.verification.confounders).toEqual(input.confounders);
    expect(recordPerformance(db, input)).toEqual(record);
    expect(performanceHistory(db, s.id)).toHaveLength(1);
    expect(() => recordPerformance(db, { ...input, after: { ...input.after, votes: 0 } })).toThrow(/conflict/);
  });
  it("records missing exposure as pending and rejects future or unreferenced observations", () => {
    const db = store(); const { s } = trusted(db);
    const input = { measurementKey: "empty", solutionId: s.id, solutionRevision: "revision-one", before: { startMs: NOW - 14 * DAY, endMs: NOW - 7 * DAY, sessions: 0, votes: 0 }, after: { startMs: NOW - 7 * DAY, endMs: NOW, sessions: 0, votes: 0 }, model: { provider: "provider", model: "model" }, costs: [], confounders: [], evidenceRefs: ["empty-window-scan"], observedAtMs: NOW };
    expect(recordPerformance(db, input).verification.verdict).toBe("PENDING");
    expect(() => recordPerformance(db, { ...input, evidenceRefs: [] })).toThrow(/evidence/);
    expect(() => recordPerformance(db, { ...input, after: { ...input.after, endMs: NOW + DAY } })).toThrow(/future/);
  });
});
describe("reviewable export drafts", () => {
  const args = { solutionId: "s-a", revision: "revision-one", format: "skill" as const, name: "preserve-retry-data", description: "Preserve request data during tool retries", scopeProjectIds: ["project-one"] };
  it("exports the actual adopted instruction with provenance and exact undo as an immutable skill draft", () => {
    const db = store(); const { artifact } = trusted(db);
    const draft = prepareExport(db, args, redact, NOW);
    expect(draft.status).toBe("draft");
    const skill = draft.files.find(f => f.path === "skills/preserve-retry-data/SKILL.md")!;
    expect(skill.content).toContain('name: "preserve-retry-data"');
    expect(skill.content).toContain(artifact.content);
    expect(draft.files.find(f => f.path === "EVIDENCE.md")!.content).toContain("Disable instruction slot instruction-slot-a");
    expect(prepareExport(db, args, redact, NOW + 1)).toEqual(draft);
    expect(db.list("publication-approvals")).toEqual([]);
  });
  it("exports a scoped BB plugin that is off by default", () => {
    const db = store(); trusted(db);
    const draft = prepareExport(db, { ...args, format: "plugin" }, redact, NOW);
    const manifest = JSON.parse(draft.files.find(f => f.path === "package.json")!.content);
    expect(manifest.bb.server).toBe("./server.ts");
    const server = draft.files.find(f => f.path === "server.ts")!.content;
    expect(server).toContain("default: false");
    expect(server).toContain("context.project.id");
    expect(server).toContain("bb.agents.configure");
    expect(server).not.toContain("process.env");
    const temp = mkdtempSync(join(process.cwd(), ".export-check-"));
    try {
      writeFileSync(join(temp, "server.ts"), server);
      const tsc = join(process.cwd(), "node_modules/.bin/tsc");
      const result = spawnSync(tsc, ["--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", join(temp, "server.ts")], { encoding: "utf8", timeout: 20000 });
      expect(result.stdout + result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it("allows canonical paper provenance while rejecting identifiers in the instruction", () => {
    const db = store(); const { s, artifact } = trusted(db);
    s.origin = "paper";
    s.sourcePaper = { id: "2609.14858", version: "v1", url: "https://arxiv.org/abs/2609.14858v1", publishedAtMs: NOW - 30 * DAY, credibility: { status: "passed", fieldWeightedCitationImpact: 1, authorSignal: 1, evidenceUrls: [] } };
    db.put("solutions", s.id, s);
    expect(prepareExport(db, args, policyRedact, NOW).files[0]?.content).toContain(s.sourcePaper.url);
    db.remove("export-drafts", db.entries("export-drafts")[0]!.key);
    const content = artifact.content + " Consult https://private-client.example/customer-one.";
    const digest = createHash("sha256").update(content).digest("hex");
    db.put("validated-artifacts", s.id, { ...artifact, content, artifactDigest: digest });
    db.put("trusted-evaluations", "eval-one", { ...db.get<TrustedEvaluation>("trusted-evaluations", "eval-one"), artifactDigest: digest });
    expect(() => prepareExport(db, args, policyRedact, NOW)).toThrow(/privacy/);
  });
  it("preserves a long measured history without applying excerpt truncation to the evidence document", () => {
    const db = store(); const { s } = trusted(db);
    for (let i = 0; i < 20; i++) recordPerformance(db, { measurementKey: `window-${i}`, solutionId: s.id, solutionRevision: "revision-one", before: { startMs: NOW - 14 * DAY, endMs: NOW - 7 * DAY, sessions: 100, votes: 10 }, after: { startMs: NOW - 7 * DAY, endMs: NOW, sessions: 100, votes: 8 }, model: { provider: "provider", model: "model" }, costs: [], confounders: [], evidenceRefs: [`observation-${i}`], observedAtMs: NOW });
    const evidence = prepareExport(db, args, policyRedact, NOW).files.find(f => f.path === "EVIDENCE.md")!.content;
    expect(evidence.length).toBeGreaterThan(8000);
    expect(evidence).not.toContain("[omitted]");
    expect((evidence.match(/observedAtMs/g) ?? [])).toHaveLength(20);
  });
  it("refuses pitches, stale/mismatched proof, inactive wiring and privacy-changing output", () => {
    const db = store(); const { s, artifact } = trusted(db);
    s.status = null; db.put("solutions", s.id, s);
    expect(() => prepareExport(db, args, redact, NOW)).toThrow(/active|proven/);
    s.status = "active"; db.put("solutions", s.id, s);
    db.put("validated-artifacts", s.id, { ...artifact, content: "secret-token" });
    expect(() => prepareExport(db, args, redact, NOW)).toThrow(/digest|privacy/);
    db.put("validated-artifacts", s.id, artifact);
    s.wiring!.executionCount = 0; db.put("solutions", s.id, s);
    expect(() => prepareExport(db, args, redact, NOW)).toThrow(/execution|wiring/);
  });
  it("rejects unsafe paths and makes publication a distinct owner decision bound to the draft", () => {
    for (const path of ["../outside", "/absolute", "C:\\outside", "nested/../file", "nested\\file", ".git/config"]) expect(() => assertSafeArtifactPath(path)).toThrow();
    const db = store(); trusted(db); const draft = prepareExport(db, args, redact, NOW);
    const target = { repository: "https://github.com/example/repo", branch: "export-review", directory: "skills/preserve-retry-data", bundleSha256: draft.bundleSha256 };
    expect(() => approvePublication(db, draft.id, target, { kind: "service", id: "worker" }, NOW)).toThrow(/owner/);
    const approval = approvePublication(db, draft.id, target, owner, NOW);
    expect(approval.target).toEqual(target);
    expect(approval.status).toBe("approved-for-publication");
    expect(db.get("export-drafts", draft.id)).toMatchObject({ status: "draft" });
  });
});
