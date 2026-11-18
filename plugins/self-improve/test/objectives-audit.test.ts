import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { addObjective, setObjectiveFocus } from "../src/objectives.js";

describe("owner objective audit trail", () => {
  it("records creation and focus changes atomically without duplicate replay entries or observations", () => {
    const db = new Database(":memory:"); MIGRATIONS.forEach(sql => db.exec(sql)); const store = new Store(db);
    try {
      const owner = { kind: "owner" as const, id: "dashboard" }, input = { requestId: "intent", kind: "problem" as const, title: "Retry", description: "Orchid requests lose their body" };
      const clean = (text: string) => text.replaceAll("Orchid", "[redacted]");
      const objective = addObjective(store, input, owner, clean, 100);
      expect(store.audit().map(row => row.namespace).sort()).toEqual(["objectives", "problems"]);
      for (const row of store.audit()) { expect(JSON.parse(String(row.actor))).toEqual(owner); expect(row.before_value).toBe("null"); expect(String(row.after_value)).not.toContain("Orchid"); }
      expect(addObjective(store, input, owner, clean, 200)).toEqual(objective); expect(store.audit()).toHaveLength(2);
      const focus = setObjectiveFocus(store, objective.id, 5, owner, 300);
      expect(setObjectiveFocus(store, objective.id, 5, owner, 400)).toEqual(focus); expect(store.audit()).toHaveLength(3);
      setObjectiveFocus(store, objective.id, 0, owner, 500);
      const updates = store.audit().filter(row => row.namespace === "objective-focus" && row.before_value !== "null");
      expect(updates).toHaveLength(1);
      expect(JSON.parse(String(updates[0]!.before_value)).priority).toBe(5); expect(JSON.parse(String(updates[0]!.after_value)).priority).toBe(0);
      expect(store.list("votes")).toEqual([]);
      const before = store.audit();
      expect(() => addObjective(store, { ...input, title: "Conflicting intent" }, owner, clean)).toThrow(/conflicts/);
      expect(() => setObjectiveFocus(store, objective.id, 2, { kind: "chat", id: "model" })).toThrow(/owner/);
      expect(store.audit()).toEqual(before);
    } finally { db.close(); }
  });
});
