// BB-417 (BB-291 criterion 8, slice C9): the stage set is declared by the
// playbook, not a closed enum. These are the new tests the ticket asks for: a
// four-stage playbook (spec, design, build, review), an unknown kind, an
// unknown stage in `phases`, and zero or two `start` stages. The BB-377
// characterization test pins the default three-stage behavior unchanged.
import { describe, expect, it } from "vitest";
import { DEFAULT_ACTIVE_STAGES, activeStageSet, activeStages, firstActiveStage, isActiveStage, isStartStage, lastActiveStage, parsePlaybook, phaseOf, stageProblems } from "./config.js";
import { issue, parkedWorker } from "./fixtures.js";
import { idleInActiveStage, isOwnStageChange, phaseAndStage, type IdleBinding } from "./reconcile.js";
import { atWork } from "./schedule.js";
import type { Binding } from "./store.js";
import { LINEAR_TICKETS } from "./templates.js";

/** The linear-tickets playbook with a four-stage declaration and a `label:design` phase. */
const FOUR_STAGE = LINEAR_TICKETS.replace(
  "source: linear\n",
  ["source: linear", "stages:", "  spec:   { kind: start }", "  design: { kind: active, stuck: 5d }", "  build:  { kind: active, stuck: 2d }", "  review: { kind: active, stuck: 3d }", ""].join("\n"),
).replace('  In Progress: { stage: build, stuck: 2d }', '  "label:design": { stage: design }\n  In Progress: { stage: build }');

const parsed = (text: string) => parsePlaybook(text, "linear-tickets");

describe("a playbook declares its stages (BB-417)", () => {
  it("parses a four-stage playbook and carries each stage's kind and stuck window", () => {
    const p = parsed(FOUR_STAGE);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(Object.keys(p.value.stages)).toEqual(["spec", "design", "build", "review"]);
    expect(p.value.stages.spec).toEqual({ kind: "start", stuckMs: null });
    expect(p.value.stages.design).toEqual({ kind: "active", stuckMs: 5 * 86_400_000 });
    expect(p.value.stages.build).toEqual({ kind: "active", stuckMs: 2 * 86_400_000 });
    expect(p.value.stages.review).toEqual({ kind: "active", stuckMs: 3 * 86_400_000 });
  });

  it("validates phases.<state>.stage against the declared keys", () => {
    const p = parsed(FOUR_STAGE);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(phaseOf(p.value, "In Progress")?.stage).toBe("build");
    // A `label:design` phase key names the declared `design` stage.
    expect(phaseAndStage(p.value, "Todo", ["design"]).stage).toBe("design");
  });

  it("reads a phase's stuck window from its stage when the phase sets none", () => {
    const p = parsed(FOUR_STAGE);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // `In Progress` carries no `stuck` in FOUR_STAGE; the stage's 2d applies.
    expect(phaseOf(p.value, "In Progress")?.stuckMs).toBe(2 * 86_400_000);
  });

  it("classifies the declared kinds: exactly one start, every other stage active", () => {
    const p = parsed(FOUR_STAGE);
    if (!p.ok) throw new Error(p.error);
    const stages = p.value.stages;
    expect(isStartStage(stages, "spec")).toBe(true);
    expect(isStartStage(stages, "design")).toBe(false);
    expect(isActiveStage(stages, "design")).toBe(true);
    expect(isActiveStage(stages, "build")).toBe(true);
    expect(isActiveStage(stages, "review")).toBe(true);
    expect(activeStages(stages)).toEqual(["design", "build", "review"]);
    expect(activeStageSet(stages)).toEqual(new Set(["design", "build", "review"]));
    // The ready gate applies at the first active stage and the scheduling
    // request withdraws at the last, both from declared order, never a name.
    expect(firstActiveStage(stages)).toBe("design");
    expect(lastActiveStage(stages)).toBe("review");
    const def = { spec: { kind: "start" as const, stuckMs: null }, build: { kind: "active" as const, stuckMs: null }, review: { kind: "active" as const, stuckMs: null } };
    expect(firstActiveStage(def)).toBe("build");
    expect(lastActiveStage(def)).toBe("review");
  });

  it("the core predicates read the declared active set, not a stage name", () => {
    const p = parsed(FOUR_STAGE);
    if (!p.ok) throw new Error(p.error);
    const set = activeStageSet(p.value.stages);
    // A `design` stage is active under the declared set and not under the default.
    expect(isOwnStageChange("design", "build", set)).toBe(true);
    expect(isOwnStageChange("design", "build")).toBe(false);
    expect(isOwnStageChange("spec", "design", set)).toBe(false);
    const idle = (stage: IdleBinding["stage"]): IdleBinding => ({
      stage,
      ending: null,
      hold: null,
      deployments: {},
      requeueUntil: null,
      workers: [parkedWorker()],
      ownPulls: new Set(),
      gateMetPulls: new Set(),
      escalations: [],
      needs: [],
    });
    const observed = { entity: issue({ state: "In Progress" }), pulls: [] };
    expect(idleInActiveStage(idle("design"), observed, Date.now(), set)).toBe(true);
    expect(idleInActiveStage(idle("design"), observed)).toBe(false);
    const binding = (over: Partial<Binding> = {}): Binding =>
      ({ kind: "ticket", endedAt: null, ending: null, hold: null, stage: "design", clearedToStart: false, touches: ["plugins/stewards"], lastSnapshot: null, ...over }) as Binding;
    expect(atWork(binding(), { activeStages: set })).toBe(true);
    expect(atWork(binding())).toBe(false);
  });

  it("omitting stages keeps the default set: spec start, build and review active", () => {
    const p = parsed(LINEAR_TICKETS);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.stages).toEqual({ spec: { kind: "start", stuckMs: null }, build: { kind: "active", stuckMs: null }, review: { kind: "active", stuckMs: null } });
    expect(activeStages(p.value.stages)).toEqual(["build", "review"]);
    expect(DEFAULT_ACTIVE_STAGES).toEqual(new Set(["build", "review"]));
    // The phase's own `stuck` still wins, exactly as before.
    expect(phaseOf(p.value, "In Progress")?.stuckMs).toBe(2 * 86_400_000);
  });
});

describe("a malformed stage declaration is rejected (BB-417)", () => {
  it("an unknown kind is the BB-355 unsupported value, never a silent last-good copy", () => {
    const text = FOUR_STAGE.replace("design: { kind: active, stuck: 5d }", "design: { kind: manual }");
    const p = parsed(text);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.unsupported).toBeDefined();
    expect(p.unsupported).toContain("stages.design.kind");
    expect(p.unsupported).toContain("manual");
  });

  it("an unknown stage in phases is an ordinary parse error", () => {
    const text = FOUR_STAGE.replace("In Progress: { stage: build }", "In Progress: { stage: shipped }");
    const p = parsed(text);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.unsupported).toBeUndefined();
    expect(p.error).toContain("phases.In Progress.stage");
    expect(p.error).toContain("shipped");
  });

  it("rejects a declaration with no start stage", () => {
    const text = FOUR_STAGE.replace("spec:   { kind: start }", "spec:   { kind: active }");
    const p = parsed(text);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.error).toContain("exactly one start stage");
  });

  it("rejects a declaration with two start stages", () => {
    const text = FOUR_STAGE.replace("design: { kind: active, stuck: 5d }", "design: { kind: start, stuck: 5d }");
    const p = parsed(text);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.error).toContain("exactly one start stage");
  });

  it("stageProblems names the two failures directly", () => {
    expect(stageProblems({ a: { kind: "active", stuckMs: null } }, {})).toMatch(/exactly one start/);
    expect(stageProblems({ a: { kind: "start", stuckMs: null }, b: { kind: "start", stuckMs: null } }, {})).toMatch(/exactly one start/);
    expect(stageProblems({ a: { kind: "start", stuckMs: null } }, { X: { stage: "b" } })).toMatch(/phases\.X\.stage/);
  });
});
