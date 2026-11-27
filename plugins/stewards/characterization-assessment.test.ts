// BB-377 (criterion 1 of the ticket, slice C1 of BB-291): the full `assess`
// output, pinned for a ticket binding and a `pr`/`review` binding across the
// three STAGES, together with the surface list `assessment.ts`'s `compare`
// registers. This is a characterization test: it asserts today's answers so a
// later refactor slice (C2–C10) shows exactly what changed. No production code
// is touched, no divergence is fixed.
//
// Each `it` names the predicate, flag or branch it pins in its title. Where two
// surfaces answer the same question differently the test asserts both answers
// and carries a `DIVERGENCE:` comment.
//
// The binding-shaped fixtures carry a parked `finished` worker and a second
// open own pull request (the BB-291 working rule), unless the test is about
// their absence (named in the title).
import { describe, expect, it } from "vitest";
import { assess, compare, type AssessedGate, type Assessment, type AssessmentInput } from "./assessment.js";
import { parsePlaybook, type Playbook } from "./config.js";
import { comment, issue, parkedWorker, pull } from "./fixtures.js";
import { approvalMarkerLine } from "./gate.js";
import { readyStateSchema, type StatusRecord } from "./store.js";
import { LINEAR_TICKETS } from "./templates.js";
import type { EntitySnapshot } from "./source-contract.js";

const tickets: Playbook = (() => {
  const p = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
  if (!p.ok) throw new Error(p.error);
  return p.value;
})();

const head = "aaaaaaa1";
const green = { checks: { state: "success", failing: [] } };

const noReviewMarker = comment({ id: "m1", author: "trotterdylan", body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=no-review -->`, signedBy: "thr_reviewer", createdAt: "2026-10-14T16:00:00Z" });
const ownerMarker = comment({ id: "m2", author: "trotterdylan", body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=owner-reviewed approver=project -->`, signedBy: "thr_reviewer", createdAt: "2026-10-14T16:00:00Z" });
const projectApprovalMarker = (id: string) => comment({ id, author: "trotterdylan", body: approvalMarkerLine({ sha: head, entry: null, verdict: "approved" }), signedBy: "thr_project", createdAt: "2026-10-14T16:10:00Z" });

/** A gate-met own pull request (no-review, green) plus the reviewer marker. */
const gateMetPull = (key: string, url: string) => pull({ key, url, comments: [noReviewMarker] }, { headSha: head, ...green });
/** A second, not-gate-met own pull request, so the fixture is not about a lone PR. */
const secondOpenPull = (key: string, url: string) => pull({ key, url }, { headSha: "bbbbbbb2" });

const own = (...pulls: EntitySnapshot[]): Set<string> => new Set(pulls.flatMap((p) => [p.key.toLowerCase(), (p.url ?? "").toLowerCase()]).filter((s) => s !== ""));

const binding = (over: Partial<AssessmentInput["binding"]> = {}): AssessmentInput["binding"] => ({
  id: "b1",
  entityKey: "ENG-12",
  kind: "ticket",
  ready: readyStateSchema.parse({}),
  stage: "build",
  ending: null,
  hold: null,
  deployments: {},
  requeueUntil: null,
  status: null,
  createdAt: 1,
  advancedAt: 1,
  phase: "In Progress",
  ...over,
});

function input(over: Partial<AssessmentInput> = {}): AssessmentInput {
  return {
    binding: binding(),
    observed: { entity: issue({ state: "In Progress" }), pulls: [] },
    ownPulls: new Set<string>(),
    decisions: new Map(),
    projectApprovals: [],
    workers: [],
    escalations: [],
    needs: [],
    playbook: tickets,
    currentSpecHash: "",
    now: 1_000_000,
    ...over,
  };
}

/** The phase a stage sits in for the shipped `linear-tickets` playbook. */
const PHASE: Record<"spec" | "build" | "review", string> = { spec: "Todo", build: "In Progress", review: "In Review" };

/**
 * The BB-291 matrix fixture: one binding kind at one stage, a gate-met own pull
 * request, a second open own pull request (not gate-met) and a parked
 * `finished` worker, with no live tracked source. The second open pull
 * suppresses `idleInActiveStage` in every stage (see
 * `characterization-stage-enum.test.ts` for the stage's own effect).
 */
function matrix(kind: "ticket" | "pr" | "review", stage: "spec" | "build" | "review"): AssessmentInput {
  const first = gateMetPull("acme/web#7", "https://github.com/acme/web/pull/7");
  const second = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
  const entity = kind === "ticket" ? issue({ state: PHASE[stage] }) : first;
  return input({
    binding: binding({ kind, stage, phase: PHASE[stage], entityKey: kind === "ticket" ? "ENG-12" : "acme/web#7" }),
    observed: { entity, pulls: kind === "ticket" ? [first, second] : [second] },
    ownPulls: own(first, second),
    decisions: new Map([
      ["acme/web#7", "user"],
      ["acme/web#8", "user"],
    ]),
    workers: [parkedWorker()],
  });
}

/** A status record with the given free-text wait, as `steward_report` writes it. */
const status = (waitingOn: string | null): StatusRecord => ({ phase: "In Progress", summary: "s", nextAction: "n", actor: "other", waitingOn, requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: 1 });

/** Every `PrGate` field, with the gate-met answer for `acme/web#7`. */
const metGateEntry: AssessedGate = {
  headSha: head,
  marker: { round: 1, sha: head, verdict: "approved", lane: "no-review", substantial: null, ticketApprovedSpec: false },
  lane: "no-review",
  checksGreen: true,
  checksState: "success",
  ownerApproved: false,
  ownerApprovalAt: null,
  ownerApprovalId: null,
  ownerApprovalUrl: null,
  ownerApprovalKind: null,
  projectApprovalId: null,
  projectApprovalUrl: null,
  gateMet: true,
  missing: null,
  delegates: [],
  delegatePending: false,
  delegateApproved: false,
  delegateApprovalBy: null,
  delegateApprovalAt: null,
  delegateApprovalId: null,
  delegateApprovalUrl: null,
  delegateChangesRequested: [],
  delegateReRequested: [],
  delegatesToReRequest: [],
  needsOwnerApproval: false,
  needsProjectApproval: false,
  baseStale: false,
  decision: "user",
  projectApproved: false,
  escalated: false,
  reason: null,
  pull: "acme/web#7",
  met: true,
  key: "be7ee79a6bc6b1cadf05ec1d99c826d645c04711",
};

/** The same fields, with the not-gate-met answer for `acme/web#8`. */
const unmetGateEntry: AssessedGate = {
  ...metGateEntry,
  headSha: "bbbbbbb2",
  marker: null,
  lane: null,
  checksGreen: false,
  checksState: "pending",
  gateMet: false,
  missing: "no reviewer round yet",
  pull: "acme/web#8",
  met: false,
  key: "a36fc6b16361ec8db5484c833e56af0a3f3b32fe",
};

/** The exact `Assessment` the matrix fixture produces, whatever its stage. */
function expectedAssessment(entityKey: string): Assessment {
  return {
    bindingId: "b1",
    entityKey,
    gate: {
      pulls: [metGateEntry, unmetGateEntry],
      met: false,
      decision: "user",
      missing: "no reviewer round yet",
      readyPassed: false,
    },
    worker: { state: "parked", inFlight: true, running: false, parked: true, reason: null },
    // BB-413 (C7): the parked worker is the composed `parked-workers`
    // resource, so `live` is true, exactly as the report path's row source read it in
    // production (the old fixture's `sources` omitted the parked worker).
    liveness: { live: true, waitLive: null, waited: null, idleBase: false, idle: false, stuck: false, stalled: false, overdue: false, overdueMs: null },
    wait: null,
  };
}

describe("the full Assessment across binding kinds and stages", () => {
  it("pins the whole Assessment for a ticket binding in the spec, build and review stages", () => {
    for (const stage of ["spec", "build", "review"] as const) {
      expect(assess(matrix("ticket", stage))).toEqual(expectedAssessment("ENG-12"));
    }
  });

  it("pins the whole Assessment for a pr binding in the spec, build and review stages", () => {
    for (const stage of ["spec", "build", "review"] as const) {
      expect(assess(matrix("pr", stage))).toEqual(expectedAssessment("acme/web#7"));
    }
  });

  it("pins the whole Assessment for a review binding in the spec, build and review stages", () => {
    for (const stage of ["spec", "build", "review"] as const) {
      expect(assess(matrix("review", stage))).toEqual(expectedAssessment("acme/web#7"));
    }
  });

  it("pins the gate composition: the pull keys, the assessment's own pull list and the per-binding roll-up", () => {
    const a = assess(matrix("ticket", "build"));
    expect(a.gate.pulls.map((p) => p.pull)).toEqual(["acme/web#7", "acme/web#8"]);
    // The roll-up is every own pull's `met`, and the missing names the first unmet one.
    expect(a.gate).toMatchObject({ met: false, decision: "user", missing: "no reviewer round yet" });
    // The first pull is the single gate-met one; the second is not.
    expect(a.gate.pulls.map((p) => [p.pull, p.met, p.lane])).toEqual([
      ["acme/web#7", true, "no-review"],
      ["acme/web#8", false, null],
    ]);
  });

  it("pins the liveness flags on the matrix fixture: no tracked source, no typed wait, no stall", () => {
    const a = assess(matrix("ticket", "build"));
    expect(a.liveness).toEqual({ live: true, waitLive: null, waited: null, idleBase: false, idle: false, stuck: false, stalled: false, overdue: false, overdueMs: null });
    // `stuck` is the phase backstop: Todo has no limit, and In Progress / In
    // Review are days away from `advancedAt`.
    expect(a.liveness.stuck).toBe(false);
  });

  it("pins the worker state: a parked finished worker is `parked`, in flight but not running", () => {
    expect(assess(matrix("ticket", "build")).worker).toEqual({ state: "parked", inFlight: true, running: false, parked: true, reason: null });
  });

  // The matrix fixture's second open own pull suppresses `idleInActiveStage` in
  // every stage, so the matrix alone cannot show the stage gate. This names the
  // second pull's absence and pins the stage's own effect on the assessment:
  // `idleBase`/`idle` are true only in the active stages, and the
  // `idleInActiveStage` compare surface appears only there.
  it("pins the stage's own effect on idleBase, idle and the idleInActiveStage surface when the second open own pull is absent (named: about its absence)", () => {
    const cases: Array<["spec" | "build" | "review" | null, boolean]> = [
      ["spec", false],
      ["build", true],
      ["review", true],
      [null, false],
    ];
    for (const [stage, idle] of cases) {
      const i = onlyGateMetAt(stage);
      const a = assess(i);
      expect(a.liveness.idleBase, String(stage)).toBe(idle);
      expect(a.liveness.idle, String(stage)).toBe(idle);
      expect(compare(i, a).some((d) => d.surface === "idleInActiveStage"), String(stage)).toBe(idle);
    }
  });
});

// BB-377 criterion 1: the wait and stall half of the full Assessment, on
// fixtures that carry a stored typed wait. The kind's own derivation is
// characterized in `characterization-wait-derivation.test.ts`.
describe("the full Assessment: the stored typed wait and the stall it derives", () => {
  const openPull = (key: string, over: Partial<NonNullable<EntitySnapshot["pull"]>> = {}) => {
    const [repo, number] = key.split("#") as [string, string];
    return pull({ key, url: `https://github.com/${repo}/pull/${number}`, state: "open" }, over);
  };
  const waited = (e: EntitySnapshot) => new Map([[e.key.toLowerCase(), e]]);

  it("pins a live pull wait: waitLive true, the waited fingerprint, idle suppressed and no stall", () => {
    const w = { kind: "pull" as const, ref: "acme/web#9" };
    const a = assess(input({ binding: binding({ wait: w }), waitedPulls: waited(openPull("acme/web#9")) }));
    expect(a.wait).toEqual({ kind: "pull", ref: "acme/web#9", reviewers: [] });
    expect(a.liveness.waitLive).toBe(true);
    // The base idle rule is true (build stage, no worker, no own pull); a live typed wait suppresses it.
    expect(a.liveness.idleBase).toBe(true);
    expect(a.liveness.idle).toBe(false);
    expect(a.liveness.stalled).toBe(false);
    expect(a.liveness.waited).toBe(JSON.stringify({ key: "acme/web#9", state: "open", title: "Add login retry", head: "aaaaaaa1", checks: "pending", review: false, merged: false }));
  });

  it("pins an external wait with a free-text wait: waitLive false, stalled true", () => {
    const a = assess(input({ binding: binding({ wait: { kind: "external", ref: "the vendor's reply" }, status: status("the vendor's reply") }) }));
    expect(a.wait).toEqual({ kind: "external", ref: "the vendor's reply", reviewers: [] });
    expect(a.liveness.waitLive).toBe(false);
    expect(a.liveness.stalled).toBe(true);
    expect(a.liveness.waited).toBeNull();
  });

  it("pins a date wait ahead of its date as live and not a stall, and past it as a stall", () => {
    const now = 1_000_000;
    const ahead = assess(input({ now, binding: binding({ wait: { kind: "date", ref: "2026-12-01" }, requeueUntil: now + 86_400_000 }) }));
    expect(ahead.liveness.waitLive).toBe(true);
    expect(ahead.liveness.stalled).toBe(false);
    expect(ahead.liveness.overdue).toBe(false);
    const past = assess(input({ now, binding: binding({ wait: { kind: "date", ref: "2026-12-01" }, requeueUntil: now - 86_400_000 }) }));
    expect(past.liveness.waitLive).toBe(false);
    expect(past.liveness.stalled).toBe(true);
  });

  it("pins a live review wait's requested reviewers from the freshly read pull", () => {
    const a = assess(input({ binding: binding({ wait: { kind: "review", ref: "acme/web#9" } }), waitedPulls: waited(openPull("acme/web#9", { requestedReviewers: ["jane", "sam"] })) }));
    expect(a.wait).toEqual({ kind: "review", ref: "acme/web#9", reviewers: ["jane", "sam"] });
    expect(a.liveness.waitLive).toBe(true);
  });
});

// BB-377 criterion 1: the surface list `assessment.ts`'s `compare` registers.
// Every surface is a place the old predicate and the shadow assessment answer
// the same question; the test asserts both answers.
describe("the compare surface list (BB-292)", () => {
  const surfaceNames = (i: AssessmentInput): string[] => compare(i, assess(i)).map((d) => d.surface);

  it("registers all five surfaces across the divergence fixtures (BB-413 retired the live-source surface, BB-414 the no-wake-source one)", () => {
    const union = new Set<string>([
      ...surfaceNames(matrix("ticket", "build")),
      ...surfaceNames(onlyGateMetAt("build")),
      ...surfaceNames(projectApproved()),
    ]);
    expect([...union].sort()).toEqual(["approvals.gate", "approvals.pageRefusal", "idleInActiveStage", "runningWorkerReason", "workerInFlight"]);
  });

  // DIVERGENCE: `workerInFlight` counts the parked `finished` worker in flight,
  // `runningWorkerReason` says nobody is mid-turn; the assessment names the one
  // state `parked`. BB-413 (C7) retired the live-source row: the live
  // answer now comes from the composed `parked-workers` resource, which counts
  // the parked worker exactly as the report path did.
  it("DIVERGENCE: a parked worker is in flight and not mid-turn at once", () => {
    const d = new Map(compare(matrix("ticket", "build"), assess(matrix("ticket", "build"))).map((x) => [x.surface, x]));
    expect(d.get("workerInFlight")).toMatchObject({ old: "in-flight", new: "parked" });
    expect(d.get("runningWorkerReason")).toMatchObject({ old: "not-mid-turn", new: "parked" });
    expect(d.get("idleInActiveStage")).toBeUndefined();
  });

  // DIVERGENCE: `idleInActiveStage` calls the binding idle when its only open
  // own pull request is gate-met, while the parked worker is in flight to
  // `workerInFlight`; the assessment names the one state `parked`.
  it("DIVERGENCE: idleInActiveStage calls a gate-met-only binding idle while the parked worker is in flight (named: about the second pull's absence)", () => {
    const i = onlyGateMetAt("build");
    const d = compare(i, assess(i));
    expect(d.find((x) => x.surface === "idleInActiveStage")).toMatchObject({ old: "idle", new: "parked" });
  });

  // DIVERGENCE: approvals.ts builds the gate with `prGate(pull,
  // productGateOptions(b, pull))`, omitting the decide mark and the recorded
  // project approvals; the assessment passes both. A project entry whose
  // recorded `bb-approval` is on the pull request is met to the assessment and
  // still asks the owner to the approvals.ts path.
  it("DIVERGENCE: approvals.gate reports the old gate's `owner approval needed` against the assessment's `met`", () => {
    const i = projectApproved();
    const d = compare(i, assess(i));
    expect(d.find((x) => x.surface === "approvals.gate")).toMatchObject({ old: "owner approval needed", new: "met" });
  });

  // DIVERGENCE: the page action's refusal falls through to its `??` fallback on
  // a met no-review gate, so it says "the pull request has not been observed
  // yet" while the gate answers met.
  it("DIVERGENCE: approvals.pageRefusal reports the not-observed fallback against the assessment's `met`", () => {
    const d = compare(matrix("ticket", "build"), assess(matrix("ticket", "build")));
    expect(d.find((x) => x.surface === "approvals.pageRefusal")).toMatchObject({ old: "the pull request has not been observed yet", new: "met" });
  });

});

/** The matrix fixture without its second open own pull, at one stage (or none); its absence is the point. */
function onlyGateMetAt(stage: "spec" | "build" | "review" | null): AssessmentInput {
  const first = gateMetPull("acme/web#7", "https://github.com/acme/web/pull/7");
  const phase = stage === null ? "In Progress" : PHASE[stage];
  return input({
    binding: binding({ stage, phase }),
    observed: { entity: issue({ state: phase }), pulls: [first] },
    ownPulls: own(first),
    decisions: new Map([["acme/web#7", "user"]]),
    workers: [parkedWorker()],
  });
}

/** A `review` binding whose project-placed pull carries a recorded `bb-approval`; it also carries the rule's second open own pull. */
function projectApproved(): AssessmentInput {
  const entity = pull({ comments: [ownerMarker, projectApprovalMarker("pa1")] }, { headSha: head, ...green });
  const second = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
  return input({
    binding: binding({ kind: "review" }),
    observed: { entity, pulls: [second] },
    ownPulls: own(entity, second),
    decisions: new Map([
      [entity.key.toLowerCase(), "project"],
      [second.key.toLowerCase(), "user"],
    ]),
    projectApprovals: [{ commentId: "pa1", verdict: "approved" }],
    workers: [parkedWorker()],
  });
}

