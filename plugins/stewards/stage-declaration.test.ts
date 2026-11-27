// BB-417 (BB-291 criterion 8, slice C9): the stage set is declared by the
// playbook, not a closed enum. These are the new tests the ticket asks for: a
// four-stage playbook (spec, design, build, review), an unknown kind, an
// unknown stage in `phases`, and zero or two `start` stages. The BB-377
// characterization test pins the default three-stage behavior unchanged.
import { describe, expect, it } from "vitest";
import { DEFAULT_ACTIVE_STAGES, activeStageSet, activeStages, firstActiveStage, isActiveStage, isStartStage, lastActiveStage, parsePlaybook, phaseOf, playbookPath, stageProblems } from "./config.js";
import { issue, parkedWorker, pull } from "./fixtures.js";
import { idleInActiveStage, isOwnStageChange, phaseAndStage, type IdleBinding } from "./reconcile.js";
import { atWork } from "./schedule.js";
import type { Binding } from "./store.js";
import { LINEAR_TICKETS } from "./templates.js";
import { setup } from "./test-world.js";

/** The linear-tickets playbook with a four-stage declaration and a `label:design` phase. */
const FOUR_STAGE = LINEAR_TICKETS.replace(
  "source: linear\n",
  ["source: linear", "stages:", "  spec:   { kind: start }", "  design: { kind: active, stuck: 5d }", "  build:  { kind: active, stuck: 2d }", "  review: { kind: active, stuck: 3d }", ""].join("\n"),
).replace('  In Progress: { stage: build, stuck: 2d }', '  "label:design": { stage: design }\n  In Progress: { stage: build }');

const parsed = (text: string) => parsePlaybook(text, "linear-tickets");

/** FOUR_STAGE with the last active stage named `ship`, so `lastActiveStage` cannot be a hardcoded "review". */
const LAST_SHIP = FOUR_STAGE.replace("  review: { kind: active, stuck: 3d }", "  ship:   { kind: active, stuck: 3d }").replace("  In Review:   { stage: review, stuck: 3d }", "  In Review:   { stage: ship, stuck: 3d }");

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

  it("does not accept an inherited Object key as a stage name", () => {
    // `toString in stages` is true by prototype, so the old check accepted it
    // and then read no kind. It must be rejected as undeclared.
    const text = FOUR_STAGE.replace("In Progress: { stage: build }", "In Progress: { stage: toString }");
    const p = parsed(text);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.error).toContain("phases.In Progress.stage");
    expect(p.error).toContain("toString");
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

// ---------------------------------------------------------------------------
// The server's stage consumers against a declared-stages playbook. These are
// the paths the ticket rewires: the ready-gate flag and the schedule
// withdrawal. Replacing `firstActiveStage(playbook.stages)` with "build" (or
// `lastActiveStage(...)` with "review") must fail one of them.
// ---------------------------------------------------------------------------

describe("the server reads the declared set, not a stage name (BB-417)", () => {
  const flagged = /before the ready gate passed/u;

  /** A bound ticket in the declared playbook's `spec` stage, with its project steward and steward. */
  async function boundFour() {
    const t = await setup();
    t.files[playbookPath("linear-tickets")] = FOUR_STAGE;
    t.hooks.forgetConfigs();
    await t.hooks.loadConfig("p1", true);
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id) as [string, string];
    const wakes = () => t.sends.filter((s) => s.threadId === steward).map((s) => s.text);
    const move = async (entity: ReturnType<typeof issue>) => {
      const before = wakes().length;
      t.entities.set("uuid-12", entity);
      await t.ring("linear", "uuid-12");
      expect(wakes().length).toBeGreaterThan(before);
      return wakes().at(-1)!;
    };
    return { t, project, steward, move };
  }

  it("raises the ready-gate flag entering the first active stage (design) from spec", async () => {
    const { move } = await boundFour();
    // The `design` label moves the phase to the declared `design` stage, the
    // first active stage; no approval and nothing reported, so the gate is unmet.
    expect(await move(issue({ labels: ["bb-managed", "design"] }))).toMatch(flagged);
  });

  it("does not raise the flag entering a later active stage (build) from spec", async () => {
    const { move } = await boundFour();
    // Build is the second active stage, not the first: only the entry into the
    // first active stage counts as entering build (the steward's ruling).
    expect(await move(issue({ state: "In Progress", stateType: "started" }))).not.toMatch(flagged);
  });

  /** ENG-12 at work and ENG-13 with a ready gate and a filed schedule request, over the given declared-stages playbook. */
  async function twoFour(playbook: string = FOUR_STAGE) {
    const t = await setup();
    t.files[playbookPath("linear-tickets")] = playbook;
    t.hooks.forgetConfigs();
    await t.hooks.loadConfig("p1", true);
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started", linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }] }));
    t.entities.set("acme/web#7", pull());
    t.entities.set("uuid-13", issue({ id: "uuid-13", key: "ENG-13", title: "Add SSO" }));
    await t.ring("linear", "uuid-12");
    await t.ring("linear", "uuid-13");
    const [project, first, second] = t.spawns.map((x) => x.id) as [string, string, string];
    const toProject = () => t.sends.filter((s) => s.threadId === project);
    await t.tool("steward_report", { phase: "In Progress", summary: "Worker building.", nextAction: "Wait for the pull request", actor: "steward", touches: ["web/src/login"] }, first);
    const ready = { phase: "Todo", summary: "Spec posted.", nextAction: "Start a worker", actor: "steward", ready: { checklist: [1, 2, 3, 4, 5].map((item) => ({ item, met: true })), substantial: false }, touches: ["web/src"] };
    await t.tool("steward_report", ready, second);
    const id = /(esc_[\w-]+) from ENG-13 \(schedule\)/u.exec(toProject()[0]!.text)![1]!;
    return { t, project, first, second, toProject, id };
  }

  it("does not withdraw a design-stage ticket's scheduling request as the work has started", async () => {
    const { t, id } = await twoFour();
    // ENG-13 enters the declared first active stage (design) and links a new
    // pull request: the request is not withdrawn, so the overlap check re-runs.
    t.entities.set("uuid-13", issue({ id: "uuid-13", key: "ENG-13", title: "Add SSO", labels: ["bb-managed", "design"], state: "In Progress", stateType: "started", linkedPulls: [{ key: "acme/web#9", url: "https://github.com/acme/web/pull/9" }] }));
    t.entities.set("acme/web#9", pull({ state: "open" }, { merged: false }));
    await t.ring("linear", "uuid-13");
    expect(t.hooks.store.find("ENG-13")!.stage).toBe("design");
    expect(t.hooks.store.escalation(id)!.resolution ?? "").not.toMatch(/the work has started/u);
  });

  it("withdraws a review-stage ticket's scheduling request as the work has started", async () => {
    const { t, id } = await twoFour();
    // Review is the last active stage: the request is withdrawn.
    t.entities.set("uuid-13", issue({ id: "uuid-13", key: "ENG-13", title: "Add SSO", state: "In Review", stateType: "started" }));
    await t.ring("linear", "uuid-13");
    expect(t.hooks.store.find("ENG-13")!.stage).toBe("review");
    expect(t.hooks.store.escalation(id)!.resolution).toMatch(/the work has started/u);
  });

  it("withdraws at the last active stage even when it is not named review", async () => {
    const { t, id } = await twoFour(LAST_SHIP);
    // The declared last active stage is `ship`; the withdrawal must follow it,
    // not the name "review".
    t.entities.set("uuid-13", issue({ id: "uuid-13", key: "ENG-13", title: "Add SSO", state: "In Review", stateType: "started" }));
    await t.ring("linear", "uuid-13");
    expect(t.hooks.store.find("ENG-13")!.stage).toBe("ship");
    expect(t.hooks.store.escalation(id)!.resolution).toMatch(/the work has started/u);
  });
});
