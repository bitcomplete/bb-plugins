import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { applyImprovement, setImprovementEnabled, improvementsForTurn, improvementInstructions, projectReceivesImprovements, MAX_ACTIVE_IMPROVEMENTS } from "../src/improvements.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const service = { kind: "service" as const, id: "native-builder" }, owner = { kind: "owner" as const, id: "dashboard" };
function fixture() {
  const db = new Database(":memory:"); databases.push(db); MIGRATIONS.forEach(sql => db.exec(sql)); const store = new Store(db);
  const artifact = (solutionId: string, content: string) => { const id = `artifact-${solutionId}`; store.put("native-evaluation-artifacts", id, { solutionId, revision: "r1", kind: "instruction", content, artifactDigest: sha(content) }); return id; };
  return { store, artifact };
}

it("adds an applied improvement to turns until it is disabled, then again once re-enabled", () => {
  const f = fixture(), id = f.artifact("s1", "Keep the original request payload when retrying.");
  applyImprovement(f.store, { solutionId: "s1", artifactId: id, attemptId: "a1", source: "automatic" }, service);
  expect(improvementInstructions(improvementsForTurn(f.store).included)).toContain("Keep the original request payload");
  setImprovementEnabled(f.store, "s1", false, owner);
  expect(improvementsForTurn(f.store).included).toEqual([]);
  setImprovementEnabled(f.store, "s1", true, owner);
  expect(improvementsForTurn(f.store).included.map(i => i.solutionId)).toEqual(["s1"]);
  expect(f.store.audit().filter(row => row.namespace === "applied-improvements").map(row => row.reason)).toEqual(["Apply a tested improvement automatically", "Disable an improvement", "Enable an improvement"]);
});

it("keeps each turn within its bounds and shows the rest as waiting", () => {
  const f = fixture();
  for (let i = 0; i < MAX_ACTIVE_IMPROVEMENTS + 2; i++) applyImprovement(f.store, { solutionId: `s${i}`, artifactId: f.artifact(`s${i}`, `Rule ${i}.`), attemptId: null, source: "owner" }, owner, 1000 + i);
  const turn = improvementsForTurn(f.store);
  expect(turn.included).toHaveLength(MAX_ACTIVE_IMPROVEMENTS); expect(turn.waiting.map(i => i.solutionId)).toEqual(["s10", "s11"]);
});

it("refuses an artifact that does not belong to the solution or was altered", () => {
  const f = fixture(), id = f.artifact("s1", "Text");
  expect(() => applyImprovement(f.store, { solutionId: "s2", artifactId: id, attemptId: null, source: "owner" }, owner)).toThrow("not found");
  f.store.put("native-evaluation-artifacts", id, { solutionId: "s1", revision: "r1", kind: "instruction", content: "Changed", artifactDigest: sha("Text") });
  expect(() => applyImprovement(f.store, { solutionId: "s1", artifactId: id, attemptId: null, source: "owner" }, owner)).toThrow("not found");
});

it("sends improvements to every project except the worker project unless projects are listed", () => {
  expect(projectReceivesImprovements("p1", [], "worker")).toBe(true);
  expect(projectReceivesImprovements("worker", [], "worker")).toBe(false);
  expect(projectReceivesImprovements("p2", ["p1"], "worker")).toBe(false);
});
