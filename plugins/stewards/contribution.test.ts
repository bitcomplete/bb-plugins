// BB-380 (BB-291 criterion 8, slice C2): unit tests for the per-source
// contribution interface, the github contributor and the composer, and the
// shadow equality that makes this slice a refactor: the composed gate, waits
// and holds equal today's `assess()` answer on the C1 characterization
// fixtures. Any divergence is a test failure here.
//
// The fixtures mirror the C1 characterization tests
// (`characterization-assessment.test.ts`, `characterization-wait-derivation.test.ts`):
// the BB-291 matrix (one binding kind at one stage, a gate-met own pull
// request, a second open own pull request and a parked worker), the typed
// waits, the project-approved gate and the report-time no-wake-source flag.
import { describe, expect, it } from "vitest";
import { assess, compare, type AssessmentInput } from "./assessment.js";
import { compose, composeAssessment, githubContributor, linearContributor, localContributor, type GateContribution, type SourceContribution } from "./contribution.js";
import { parsePlaybook, type Playbook } from "./config.js";
import { comment, issue, parkedWorker, pull } from "./fixtures.js";
import { approvalMarkerLine } from "./gate.js";
import { readyStateSchema, type StatusRecord } from "./store.js";
import { LINEAR_TICKETS } from "./templates.js";
import type { EntitySnapshot } from "./source-contract.js";
import type { WakeSourceInput } from "./wake-source.js";
import type { Wait } from "./wait.js";

const tickets: Playbook = (() => {
  const p = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
  if (!p.ok) throw new Error(p.error);
  return p.value;
})();

const head = "aaaaaaa1";
const green = { checks: { state: "success", failing: [] } };
const noSources: WakeSourceInput = { hold: null, holdBehind: [], mergeBehind: [], holdStack: [], deployments: {}, runningWorkers: 0, openEscalations: 0, openNeeds: 0, pullRequestWatch: false };

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
  noWakeSource: false,
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
    sources: { ...noSources },
    playbook: tickets,
    currentSpecHash: "",
    now: 1_000_000,
    ...over,
  };
}

/** The phase a stage sits in for the shipped `linear-tickets` playbook. */
const PHASE: Record<"spec" | "build" | "review", string> = { spec: "Todo", build: "In Progress", review: "In Review" };

/** The BB-291 matrix fixture, mirroring `characterization-assessment.test.ts`. */
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

/** The matrix fixture without its second open own pull, at one stage (or none). */
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

/** A `review` binding whose project-placed pull carries a recorded `bb-approval`. */
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

/** The report-time `noWakeSource` flag set with no free-text wait. */
function noWakeSourceFlag(): AssessmentInput {
  const second = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
  return input({
    binding: binding({ noWakeSource: true, status: null }),
    observed: { entity: issue({ state: "In Progress" }), pulls: [second] },
    ownPulls: own(second),
    workers: [parkedWorker()],
  });
}

const status = (waitingOn: string | null): StatusRecord => ({ phase: "In Progress", summary: "s", nextAction: "n", actor: "other", waitingOn, requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: 1 });

/** An open or merged pull request read for a `pull`/`review` wait. */
const openPull = (key: string, over: Partial<NonNullable<EntitySnapshot["pull"]>> = {}) => {
  const [repo, number] = key.split("#") as [string, string];
  return pull({ key, url: `https://github.com/${repo}/pull/${number}`, state: "open" }, over);
};
const mergedPull = (key: string) => {
  const [repo, number] = key.split("#") as [string, string];
  return pull({ key, url: `https://github.com/${repo}/pull/${number}`, state: "merged" }, { merged: true });
};
const waited = (e: EntitySnapshot) => new Map([[e.key.toLowerCase(), e]]);
const watch = (key: string, state: string) => ({ key, state, mergeSha: null, target: "", mergedAt: null, prRepo: "acme/web", files: [], repo: "acme/web", environment: "production", deploymentId: null, deploymentState: null, ref: null, sha: null, url: null, at: 1, deadlineAt: null, note: null, workflowRuns: [] });

/** A binding-shaped input with one typed wait and the rows that resolve it. */
function waitInput(wait: Wait, over: Partial<AssessmentInput> = {}): AssessmentInput {
  const { binding: b, ...rest } = over;
  return input({ ...rest, binding: binding({ ...b, wait }) });
}

/** The wait fixtures, one per kind, live and not, mirroring the C1 wait tests. */
const waitCases = (): Array<[string, AssessmentInput]> => [
  ["pull live", waitInput({ kind: "pull", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) })],
  ["pull merged", waitInput({ kind: "pull", ref: "acme/web#9" }, { waitedPulls: waited(mergedPull("acme/web#9")) })],
  ["pull unread", waitInput({ kind: "pull", ref: "acme/web#9" })],
  ["review live", waitInput({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) })],
  ["review approved", waitInput({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9", { reviewDecision: "APPROVED" })) })],
  ["deployment live", waitInput({ kind: "deployment", ref: "acme/web#9" }, { binding: binding({ deployments: { "acme/web#9": watch("acme/web#9", "merged") as never } }) })],
  ["deployment deployed", waitInput({ kind: "deployment", ref: "acme/web#9" }, { binding: binding({ deployments: { "acme/web#9": watch("acme/web#9", "deployed") as never } }) })],
  ["worker live", waitInput({ kind: "worker", ref: "thr_w1" }, { workers: [{ threadId: "thr_w1", status: "running" } as never] })],
  ["worker parked", waitInput({ kind: "worker", ref: "thr_w1" }, { workers: [parkedWorker({ threadId: "thr_w1" })] })],
  ["binding live", waitInput({ kind: "binding", ref: "ENG-13" }, { hasOpenBinding: () => true })],
  ["binding closed", waitInput({ kind: "binding", ref: "ENG-13" }, { hasOpenBinding: () => false })],
  ["date ahead", waitInput({ kind: "date", ref: "2026-12-01" }, { binding: binding({ requeueUntil: 1_000_000 + 86_400_000 }) })],
  ["date past", waitInput({ kind: "date", ref: "2026-12-01" }, { binding: binding({ requeueUntil: 1_000_000 - 86_400_000 }) })],
  ["person live", waitInput({ kind: "person", ref: "need_1" }, { hasOpenItem: () => true })],
  ["person closed", waitInput({ kind: "person", ref: "need_1" }, { hasOpenItem: () => false })],
  ["external", waitInput({ kind: "external", ref: "the vendor's reply" })],
];

/** The C1-shaped fixtures whose composed answer must equal `assess()` with no divergence. */
const characterizationFixtures = (): Array<[string, AssessmentInput]> => [
  ...(["ticket", "pr", "review"] as const).flatMap((kind) => (["spec", "build", "review"] as const).map((stage): [string, AssessmentInput] => [`matrix ${kind} ${stage}`, matrix(kind, stage)])),
  ...(["spec", "build", "review", null] as const).map((stage): [string, AssessmentInput] => [`only-gate-met ${String(stage)}`, onlyGateMetAt(stage)]),
  ["project approved", projectApproved()],
  ["no-wake-source flag", noWakeSourceFlag()],
  ...waitCases(),
];

// ---------------------------------------------------------------------------
// The composer.
// ---------------------------------------------------------------------------

describe("the composer (BB-380)", () => {
  it("rolls the gate items up and concatenates waits, resources, holds and reasons in contributor order", () => {
    const i = matrix("ticket", "build");
    const contributions: SourceContribution[] = [githubContributor.contribute(i), linearContributor.contribute(i)];
    const composed = compose(contributions);
    // The gate roll-up: every own pull's `met`, the first pull's lane, the first unmet pull's missing.
    expect(composed.gate.pulls.map((p) => p.pull)).toEqual(["acme/web#7", "acme/web#8"]);
    expect(composed.gate).toMatchObject({ met: false, decision: "user", missing: "no reviewer round yet" });
    // The rest is concatenated in contributor order.
    expect(composed.waits).toEqual(contributions.flatMap((c) => c.waits));
    expect(composed.resources).toEqual(contributions.flatMap((c) => c.resources));
    expect(composed.holds).toEqual(contributions.flatMap((c) => c.holds));
    expect(composed.reasons).toEqual(contributions.flatMap((c) => c.reasons));
    // The ready gate is core, so `compose` leaves it for `composeAssessment`.
    expect(composed.gate.readyPassed).toBeNull();
  });

  it("reads a gate-met binding's roll-up as met with no missing", () => {
    const composed = composeAssessment(onlyGateMetAt("build"));
    expect(composed.gate).toMatchObject({ met: true, decision: "user", missing: null });
  });

  it("rolls the gate up from the contribution fields, not the wrapped gate", () => {
    const [real] = githubContributor.contribute(onlyGateMetAt("build")).gate;
    // A contribution whose item fields disagree with the gate it wrapped: the
    // roll-up must follow the item, or `compare` could never catch a composer
    // that disagrees with today's gate (BB-380 review round 1).
    const flipped: GateContribution = { ...real!, met: false, missing: "the item says unmet", lane: "project" };
    const composed = compose([{ source: "github", gate: [flipped], waits: [], resources: [], holds: [], reasons: [] }]);
    expect(composed.gate).toMatchObject({ met: false, decision: "project", missing: "the item says unmet" });
    // The wrapped gate still rides along for the C3 surfaces.
    expect(composed.gate.pulls).toEqual([real!.assessed]);
  });
});

// ---------------------------------------------------------------------------
// The github contributor.
// ---------------------------------------------------------------------------

describe("the github contributor (BB-380)", () => {
  it("wraps assessedPullGate/gateInputKey output as `merge` gate items without changing it", () => {
    const i = matrix("ticket", "build");
    const a = assess(i);
    const gate = githubContributor.contribute(i).gate;
    expect(gate.map((g) => g.id)).toEqual(["merge", "merge"]);
    expect(gate.map((g) => g.source)).toEqual(["github", "github"]);
    expect(gate.map((g) => g.subject)).toEqual(a.gate.pulls.map((p) => ({ kind: "pull", id: p.pull })));
    // The wrapped gate is byte-for-byte today's per-pull assessment.
    expect(gate.map((g) => g.assessed)).toEqual(a.gate.pulls);
    expect(gate.map((g) => g.inputs)).toEqual(a.gate.pulls.map((p) => p.key));
    expect(gate.map((g) => [g.met, g.missing, g.lane, g.escalated, g.product])).toEqual(a.gate.pulls.map((p) => [p.met, p.missing, p.decision, p.escalated, p.reason === "product"]));
  });

  it("contributes one open-pull resource per own pull, inactive once gate-met", () => {
    const resources = githubContributor.contribute(matrix("ticket", "build")).resources;
    expect(resources).toEqual([
      { source: "github", id: "open-pull:acme/web#7", active: false, subject: { kind: "pull", id: "acme/web#7" } },
      { source: "github", id: "open-pull:acme/web#8", active: true, subject: { kind: "pull", id: "acme/web#8" } },
    ]);
  });

  it("contributes the pull/review/deployment typed wait for any binding and the entity's own wait and holds", () => {
    const pullWait = githubContributor.contribute(waitInput({ kind: "pull", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) }));
    expect(pullWait.waits.map((w) => `${w.source} ${w.kind} ${w.ref}`)).toEqual(["github pull acme/web#9"]);
    expect(pullWait.waits[0]!.live).toBe(true);

    // A non-pull wait is the binding's own source's, so a github binding's is github's.
    const githubWorker = githubContributor.contribute(waitInput({ kind: "worker", ref: "thr_w1" }, { observed: { entity: pull({}), pulls: [] }, workers: [{ threadId: "thr_w1", status: "running" } as never] }));
    expect(githubWorker.waits.map((w) => `${w.source} ${w.kind}`)).toEqual(["github worker"]);
    const linearWorker = linearContributor.contribute(waitInput({ kind: "worker", ref: "thr_w1" }, { workers: [{ threadId: "thr_w1", status: "running" } as never] }));
    expect(linearWorker.waits.map((w) => `${w.source} ${w.kind}`)).toEqual(["linear worker"]);

    const held = githubContributor.contribute(input({ observed: { entity: pull({}), pulls: [] }, binding: binding({ hold: "a freeze", ending: "terminal", requeueUntil: 2_000_000 }) }));
    expect(held.holds.map((h) => h.id)).toEqual(["hold", "ending", "requeue"]);
    expect(held.holds.find((h) => h.id === "requeue")!.held).toBe(true);
  });

  it("reports a reason naming the first unmet gate's missing text", () => {
    const reasons = githubContributor.contribute(matrix("ticket", "build")).reasons;
    expect(reasons).toEqual([{ source: "github", code: "gate-not-met", detail: "no reviewer round yet", at: 1_000_000 }]);
  });
});

// ---------------------------------------------------------------------------
// The linear and local contributors.
// ---------------------------------------------------------------------------

describe("the linear and local contributors (BB-380)", () => {
  it("each contributes only for its own entity source, wrapping the binding's holds and non-pull wait", () => {
    const linear = input({ binding: binding({ hold: "a freeze" }), observed: { entity: issue(), pulls: [] } });
    expect(linearContributor.contribute(linear).holds.map((h) => h.id)).toEqual(["hold"]);
    expect(localContributor.contribute(linear)).toEqual({ source: "local", gate: [], waits: [], resources: [], holds: [], reasons: [] });

    const github = input({ observed: { entity: pull({}), pulls: [] } });
    expect(githubContributor.contribute(github).holds).toEqual([]);
    expect(linearContributor.contribute(github)).toEqual({ source: "linear", gate: [], waits: [], resources: [], holds: [], reasons: [] });
  });
});

// ---------------------------------------------------------------------------
// The shadow equality: the composed answer equals today's assess().
// ---------------------------------------------------------------------------

describe("the composed answer equals today's assess() on the C1 characterization fixtures (BB-380)", () => {
  it("pins the whole gate for every binding kind and stage", () => {
    for (const [label, i] of characterizationFixtures()) {
      expect(composeAssessment(i).gate, label).toEqual(assess(i).gate);
    }
  });

  it("pins the typed wait's liveness, fingerprint and overdue age for every kind", () => {
    for (const [label, i] of waitCases()) {
      const a = assess(i);
      const c = composeAssessment(i);
      const typed = c.waits.find((w) => w.kind === (a.wait?.kind ?? "") && w.ref === (a.wait?.ref ?? "")) ?? null;
      if (a.wait === null) {
        expect(typed, label).toBeNull();
      } else {
        expect(typed, label).not.toBeNull();
        expect(typed!.live, label).toBe(a.liveness.waitLive);
        expect(typed!.fingerprint, label).toBe(a.liveness.waited);
        expect(typed!.overdueMs, label).toBe(a.liveness.overdueMs);
      }
    }
  });

  it("pins the holds against the binding's hold, ending and requeue", () => {
    const i = input({ binding: binding({ hold: "a freeze", ending: "terminal", requeueUntil: 1_000_000 + 1 }) });
    expect(composeAssessment(i).holds.map((h) => [h.id, h.held])).toEqual([
      ["hold", true],
      ["ending", true],
      ["requeue", true],
    ]);
    const past = input({ binding: binding({ requeueUntil: 1_000_000 - 1 }) });
    expect(composeAssessment(past).holds.map((h) => [h.id, h.held])).toEqual([["requeue", false]]);
  });

  it("records no compose divergence through the existing compare path", () => {
    for (const [label, i] of characterizationFixtures()) {
      const a = assess(i);
      const rows = compare(i, a, composeAssessment(i)).filter((d) => d.surface.startsWith("compose."));
      expect(rows, label).toEqual([]);
    }
  });

  it("compare still records the seven C1 surfaces when no composed answer is passed", () => {
    const union = new Set<string>();
    for (const [label, i] of characterizationFixtures()) {
      for (const d of compare(i, assess(i))) union.add(d.surface);
    }
    expect([...union].sort()).toEqual(["approvals.gate", "approvals.pageRefusal", "hasLiveWakeSource", "idleInActiveStage", "noWakeSource", "runningWorkerReason", "workerInFlight"]);
  });
});

// ---------------------------------------------------------------------------
// The interface itself: the types the later consumer slices read.
// ---------------------------------------------------------------------------

describe("the contribution interface (BB-380)", () => {
  it("compose over no contributions is an empty, gate-met answer", () => {
    const composed = compose([]);
    expect(composed.gate).toMatchObject({ pulls: [], met: true, decision: "user", missing: null });
    expect(composed.waits).toEqual([]);
    expect(composed.resources).toEqual([]);
    expect(composed.holds).toEqual([]);
    expect(composed.reasons).toEqual([]);
  });

  it("a gate contribution carries the source, subject, id and inputs the design names", () => {
    const g: GateContribution = githubContributor.contribute(onlyGateMetAt("build")).gate[0]!;
    expect(g).toMatchObject({ source: "github", subject: { kind: "pull", id: "acme/web#7" }, id: "merge", met: true, missing: null, lane: "user" });
    expect(g.inputs).toBe(g.assessed.key);
  });
});
