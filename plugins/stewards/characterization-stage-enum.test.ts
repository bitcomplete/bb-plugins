// BB-377 (criterion 3 of the ticket, slice C1 of BB-291): every consumer of the
// closed stage enum (`STAGES` / `Stage`), pinned with a case per `STAGES` value
// and a no-stage case. `idleInActiveStage` and `isOwnStageChange` (the
// `OWN_MOVE_STAGES` set) are called directly; `atWork` is the schedule
// predicate; `phaseSchema.stage` is exercised through `parsePlaybook`, the only
// public door to it; and the server's `stages: [...STAGES]` listing is read
// through the board RPC. This is a characterization test: no production code is
// touched, no divergence is fixed.
//
// Each `it` names the predicate, stage or branch it pins in its title. The
// binding-shaped fixtures carry a parked `finished` worker and a second open own
// pull request (the BB-291 working rule) where the test models a binding, unless
// the test is about their absence (named in the title).
import { describe, expect, it } from "vitest";
import { STAGES, parsePlaybook } from "./config.js";
import { issue, parkedWorker, pull } from "./fixtures.js";
import { idleInActiveStage, isOwnStageChange, isOwnStageMove, type IdleBinding } from "./reconcile.js";
import { atWork } from "./schedule.js";
import type { Binding } from "./store.js";
import { LINEAR_TICKETS } from "./templates.js";
import { setup } from "./test-world.js";

// ---------------------------------------------------------------------------
// idleInActiveStage: the stage gate (BB-83).
// ---------------------------------------------------------------------------

describe("idleInActiveStage: a case per STAGES value plus no stage", () => {
  const own = new Set(["acme/web#7", "https://github.com/acme/web/pull/7"]);
  const idle = (stage: IdleBinding["stage"]): IdleBinding => ({
    stage,
    ending: null,
    hold: null,
    deployments: {},
    requeueUntil: null,
    // A parked `finished` worker is not running, so it does not suppress idle.
    workers: [parkedWorker()],
    ownPulls: own,
    // The gate-met pull request does not suppress the idle wake (BB-285).
    gateMetPulls: new Set(["acme/web#7"]),
    escalations: [],
    needs: [],
  });
  // The gate-met own pull request is closed/merged, so nothing is left to wait on.
  const merged = { entity: issue({ state: "In Review" }), pulls: [pull({ state: "merged" }, { merged: true })] };

  it("is false in the spec stage (no second open own pull: named absence)", () => {
    expect(idleInActiveStage(idle("spec"), merged)).toBe(false);
  });

  it("is true in the build stage with nothing left to wait on (no second open own pull: named absence)", () => {
    expect(idleInActiveStage(idle("build"), merged)).toBe(true);
  });

  it("is true in the review stage with nothing left to wait on (no second open own pull: named absence)", () => {
    expect(idleInActiveStage(idle("review"), merged)).toBe(true);
  });

  it("is false with no stage at all (no second open own pull: named absence)", () => {
    expect(idleInActiveStage(idle(null), merged)).toBe(false);
  });

  it("is suppressed in every active stage by a second open own pull request (named: about its absence)", () => {
    const open = { entity: issue({ state: "In Review" }), pulls: [pull({ key: "acme/web#8", url: "https://github.com/acme/web/pull/8", state: "open" })] };
    const second = new Set(["acme/web#8", "https://github.com/acme/web/pull/8"]);
    for (const stage of STAGES) {
      expect(idleInActiveStage({ ...idle(stage), ownPulls: second }, open), stage).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// atWork: the stage gate and the running-worker override.
// ---------------------------------------------------------------------------

describe("atWork: a case per STAGES value plus no stage, with and without a running worker", () => {
  const binding = (over: Partial<Binding> = {}): Binding =>
    ({
      kind: "ticket",
      endedAt: null,
      ending: null,
      hold: null,
      stage: "build",
      clearedToStart: false,
      touches: ["plugins/stewards"],
      lastSnapshot: null,
      ...over,
    }) as Binding;
  // A last snapshot with a second open own pull request, so the binding is not
  // finished and its stage is what the predicate reads.
  const openSecond = {
    entity: issue(),
    pulls: [pull({ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }, { merged: true }), pull({ key: "acme/web#8", url: "https://github.com/acme/web/pull/8", state: "open" })],
  };

  it("is false in the spec stage, true in build and review, false with no stage, with a second open own pull in the snapshot", () => {
    expect(atWork(binding({ stage: "spec", lastSnapshot: openSecond }))).toBe(false);
    expect(atWork(binding({ stage: "build", lastSnapshot: openSecond }))).toBe(true);
    expect(atWork(binding({ stage: "review", lastSnapshot: openSecond }))).toBe(true);
    expect(atWork(binding({ stage: null, lastSnapshot: openSecond }))).toBe(false);
  });

  it("is true for a cleared-to-start binding whatever its stage, including no stage", () => {
    expect(atWork(binding({ stage: "spec", clearedToStart: true }))).toBe(true);
    expect(atWork(binding({ stage: null, clearedToStart: true }))).toBe(true);
  });

  it("is false for a binding whose work is finished with no worker still running (named: about the second open own pull's absence)", () => {
    const finished = binding({ stage: "build", noMorePulls: true, lastSnapshot: { entity: issue(), pulls: [pull({}, { merged: true })] } });
    expect(atWork(finished)).toBe(false);
  });

  it("is true for the same finished binding while a running worker is passed (named: about the second open own pull's absence)", () => {
    const finished = binding({ stage: "build", noMorePulls: true, lastSnapshot: { entity: issue(), pulls: [pull({}, { merged: true })] } });
    expect(atWork(finished, { runningWorker: true })).toBe(true);
  });

  it("is true for a noMorePulls binding while a second own pull request is still open, even with no running worker", () => {
    const b = binding({ stage: "build", noMorePulls: true, lastSnapshot: openSecond });
    expect(atWork(b)).toBe(true);
    expect(atWork(b, { runningWorker: false })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OWN_MOVE_STAGES: isOwnStageChange / isOwnStageMove.
// ---------------------------------------------------------------------------

describe("OWN_MOVE_STAGES: a case per STAGES value plus no stage", () => {
  it("is true only for a move between build and review, in either direction", () => {
    expect(isOwnStageChange("build", "review")).toBe(true);
    expect(isOwnStageChange("review", "build")).toBe(true);
  });

  it("is false for any move involving spec", () => {
    expect(isOwnStageChange("spec", "build")).toBe(false);
    expect(isOwnStageChange("build", "spec")).toBe(false);
    expect(isOwnStageChange("spec", "review")).toBe(false);
    expect(isOwnStageChange("review", "spec")).toBe(false);
  });

  it("is false for a move within one stage", () => {
    for (const stage of STAGES) expect(isOwnStageChange(stage, stage), stage).toBe(false);
  });

  it("is false when either side has no stage", () => {
    expect(isOwnStageChange(null, "build")).toBe(false);
    expect(isOwnStageChange("build", null)).toBe(false);
    expect(isOwnStageChange(null, null)).toBe(false);
  });

  it("isOwnStageMove reads the same judgment through a state-to-stage mapping", () => {
    const stageOf = (state: string): string | null => (state === "In Progress" ? "build" : state === "In Review" ? "review" : state === "Todo" ? "spec" : null);
    expect(isOwnStageMove(stageOf, "In Progress", "In Review")).toBe(true);
    expect(isOwnStageMove(stageOf, "In Review", "In Progress")).toBe(true);
    expect(isOwnStageMove(stageOf, "Todo", "In Progress")).toBe(false);
    expect(isOwnStageMove(stageOf, "In Progress", "Todo")).toBe(false);
    // No mapping is no own move.
    expect(isOwnStageMove(undefined, "In Progress", "In Review")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// phaseSchema.stage: the playbook's stage value, through parsePlaybook.
// ---------------------------------------------------------------------------

describe("phaseSchema.stage: accepts the three STAGES values, rejects anything else", () => {
  const withStage = (value: string): string => LINEAR_TICKETS.replace("In Progress: { stage: build, stuck: 2d }", `In Progress: { stage: ${value}, stuck: 2d }`);
  const parsed = (value: string) => parsePlaybook(withStage(value), "linear-tickets");

  it("accepts each of the three STAGES values", () => {
    for (const stage of STAGES) {
      const p = parsed(stage);
      expect(p.ok, stage).toBe(true);
      if (p.ok) expect(p.value.phases["In Progress"]?.stage).toBe(stage);
    }
  });

  it("rejects any other string", () => {
    expect(parsed("nope")).toMatchObject({ ok: false });
    expect(parsed("Build")).toMatchObject({ ok: false });
    expect(parsed("BUILD")).toMatchObject({ ok: false });
  });

  it("rejects a non-string value", () => {
    expect(parsed("123")).toMatchObject({ ok: false });
    expect(parsed("[]")).toMatchObject({ ok: false });
    expect(parsed("{}")).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// STAGES: the constant and the server's board listing.
// ---------------------------------------------------------------------------

describe("STAGES and the server's stage listing", () => {
  it("is the closed enum, in order", () => {
    expect(STAGES).toEqual(["spec", "build", "review"]);
  });

  // The server's `stages: [...STAGES]` listing in `stewardsBoard` is the
  // worker loop's stage read the ticket names; this pins the rendered list.
  it("lists the three stages in the board payload", async () => {
    const t = await setup();
    const result = (await t.harness.callRpc("stewardsBoard", { projectId: "p1" })) as { board: { stages: string[] } | null };
    expect(result.board?.stages).toEqual([...STAGES]);
  });
});
