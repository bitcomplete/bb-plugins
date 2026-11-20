import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, Store } from "../src/store.js";
import { addObjective, listObjectives, setObjectiveFocus } from "../src/objectives.js";
import { NOW } from "./domain/fixtures.js";
const dbs: Database.Database[] = [];
function store(): Store { const db = new Database(":memory:"); dbs.push(db); for (const migration of MIGRATIONS) db.exec(migration); return new Store(db); }
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const owner = { kind: "owner" as const, id: "owner-local" };
const redact = (s: string) => s.replaceAll("secret-token", "[redacted]");
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
