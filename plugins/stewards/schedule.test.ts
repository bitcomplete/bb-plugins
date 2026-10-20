import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { issue, pull } from "./fixtures.js";
import { allPullsMerged, atWork, conflictsOf, normalizeTouches, touchesOverlap } from "./schedule.js";
import { MIGRATIONS, createStore, type Binding } from "./store.js";

const T = Date.parse("2026-10-18T05:00:00Z");

function world() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const s = createStore(db, () => T);
  let n = 0;
  const bind = (key: string, over: { stage?: "spec" | "build" | "review"; touches?: string[]; parent?: string | null; project?: string } = {}): Binding => {
    const b = s.create({ projectId: over.project ?? "p1", source: "linear", entityId: `uuid-${++n}`, entityKey: key, url: null, title: null, kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: over.parent ?? null, phase: "In Progress", stage: over.stage ?? "build" });
    return s.patch(b.id, { touches: over.touches ?? [] });
  };
  return { s, bind };
}

describe("touches", () => {
  it("are normalized and deduplicated", () => {
    expect(normalizeTouches([" ./Web/src/login/ ", "web\\src\\login", "", "bb-gate//docker", "/x/"])).toEqual(["web/src/login", "bb-gate/docker", "x"]);
  });

  it("overlap when one is the other or a directory above it, never on a shared prefix of a name", () => {
    expect(touchesOverlap(["web/src"], ["web/src/login"])).toEqual(["web/src/login"]);
    expect(touchesOverlap(["web/src/login/form.ts"], ["web"])).toEqual(["web/src/login/form.ts"]);
    expect(touchesOverlap(["web/src"], ["web/srcs", "api/src"])).toEqual([]);
    expect(touchesOverlap(["bb-plugins/plugins/stewards", "bb-gate"], ["bb-gate/docker", "bb-plugins/plugins/linear"])).toEqual(["bb-gate/docker"]);
  });
});

describe("conflicts", () => {
  it("name the open bindings at work on the same paths, oldest first, leaving out held, spec-stage, landed and related ones", () => {
    const { s, bind } = world();
    const me = bind("ENG-20", { stage: "spec", touches: ["web/src"] });
    const building = bind("ENG-11", { touches: ["web/src/login"] });
    const reviewing = bind("ENG-12", { stage: "review", touches: ["web/src/signup"] });
    const held = s.patch(bind("ENG-13", { touches: ["web/src"] }).id, { hold: "Later." });
    bind("ENG-14", { stage: "spec", touches: ["web/src"] });
    bind("ENG-15", { touches: ["api"] });
    const landed = s.patch(bind("ENG-16", { touches: ["web/src"] }).id, { lastSnapshot: { entity: issue({ linkedPulls: [{ key: "acme/web#7", url: "u" }] }), pulls: [pull({ state: "merged" }, { merged: true })] } });
    const child = bind("ENG-17", { touches: ["web/src"], parent: me.id });
    bind("ENG-18", { touches: ["web/src"], project: "p2" });
    const ended = s.patch(bind("ENG-19", { touches: ["web/src"] }).id, { endedAt: T, endReason: "terminal" });
    expect(atWork(held)).toBe(false);
    expect(atWork(landed)).toBe(false);
    expect(atWork(ended)).toBe(false);
    expect(atWork(child)).toBe(true);
    expect(conflictsOf(me, s.open()).map((c) => [c.with.entityKey, c.on])).toEqual([
      ["ENG-11", ["web/src/login"]],
      ["ENG-12", ["web/src/signup"]],
    ]);
    expect(conflictsOf(building, s.open()).map((c) => c.with.entityKey)).toEqual(["ENG-17"]);
    expect(conflictsOf(s.patch(me.id, { touches: [] }), s.open())).toEqual([]);
  });

  it("count pull requests as landed only when there is one and every one merged", () => {
    const { bind } = world();
    const ticket = bind("ENG-1");
    expect(allPullsMerged(ticket, { entity: issue(), pulls: [] })).toBe(false);
    expect(allPullsMerged(ticket, { entity: issue(), pulls: [pull({}, { merged: true }), pull()] })).toBe(false);
    expect(allPullsMerged(ticket, { entity: issue(), pulls: [pull({}, { merged: true })] })).toBe(true);
    const pr = { ...ticket, kind: "pr" as const };
    expect(allPullsMerged(pr, { entity: pull({}, { merged: true }), pulls: [] })).toBe(true);
    expect(allPullsMerged(pr, { entity: pull(), pulls: [] })).toBe(false);
  });
});
