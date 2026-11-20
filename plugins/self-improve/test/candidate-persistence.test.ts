import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { mergeLedgers } from "../src/domain/problems.js";
import { resolveSolutionId } from "../src/domain/candidates.js";
import { readLedgers, writeLedgers } from "../src/stages/mining.js";
import type { Ledgers, SolutionMerge } from "../src/domain/types.js";
import { NOW, problem, solution } from "./domain/fixtures.js";

const databases: Database.Database[] = [];
function store(): Store { const db = new Database(":memory:"); databases.push(db); for (const sql of MIGRATIONS) db.exec(sql); return new Store(db); }
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function original(): Ledgers {
  const p = problem(), a = solution("a"), b = solution("b");
  b.provenance[0]!.sourceId = "second-discovery";
  b.assumptions = ["Distinct source context that must not disappear"];
  b.scoreReasons.fit = "Separate model estimate";
  p.solutionIds = [a.id, b.id];
  return { problems: [p], solutions: [a, b], votes: [] };
}

describe("candidate merge persistence", () => {
  it("archives both original definitions, audits once and resolves old IDs after reloading", () => {
    const s = store(), input = original();
    s.transaction(() => writeLedgers(s, input, NOW));
    s.transaction(() => writeLedgers(s, mergeLedgers(readLedgers(s)), NOW + 1));
    const persisted = readLedgers(s), archive = s.list<SolutionMerge>("solution-merges");
    expect(persisted.solutions).toHaveLength(1);
    expect(resolveSolutionId(persisted.solutions, "b")).toBe("a");
    expect(persisted.problems[0]!.solutionIds).toEqual(["a"]);
    expect(archive).toHaveLength(1);
    expect(archive[0]).toMatchObject({ canonicalId: "a", canonicalBefore: input.solutions[0], absorbed: input.solutions[1] });
    expect(s.audit()).toHaveLength(1);
    const version = s.version("solutions", "a");
    s.transaction(() => writeLedgers(s, mergeLedgers(readLedgers(s)), NOW + 2));
    expect(s.list("solution-merges")).toEqual(archive);
    expect(s.version("solutions", "a")).toBe(version);
    expect(s.audit()).toHaveLength(1);
  });

  it("rolls back original-row deletion and audit/archive writes together on persistence failure", () => {
    const s = store(), input = original(); s.transaction(() => writeLedgers(s, input, NOW));
    const remove = s.remove.bind(s);
    s.remove = (namespace, key) => { if (namespace === "solutions" && key === "b") throw new Error("simulated-delete-failure"); remove(namespace, key); };
    expect(() => s.transaction(() => writeLedgers(s, mergeLedgers(readLedgers(s)), NOW + 1))).toThrow("simulated-delete-failure");
    expect(readLedgers(s)).toEqual(input);
    expect(s.list("solution-merges")).toEqual([]);
    expect(s.audit()).toEqual([]);
    s.remove = remove;
    s.transaction(() => writeLedgers(s, mergeLedgers(readLedgers(s)), NOW + 2));
    expect(readLedgers(s).solutions).toHaveLength(1);
    expect(s.audit()).toHaveLength(1);
  });
});
