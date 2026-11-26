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
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { assess, compare, type AssessmentInput } from "./assessment.js";
import { compose, composeAssessment, githubContributor, linearContributor, localContributor, type GateContribution, type SourceContribution } from "./contribution.js";
import { parsePlaybook, type Playbook } from "./config.js";
import { comment, issue, parkedWorker, pull } from "./fixtures.js";
import { approvalMarkerLine } from "./gate.js";
import { readyStateSchema, type StatusRecord } from "./store.js";
import { LINEAR_TICKETS } from "./templates.js";
import { rowLiveSource, type WakeSourceInput } from "./wake-source.js";
import type { EntitySnapshot } from "./source-contract.js";
import type { Wait } from "./wait.js";

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

  it("contributes one open-pull resource per own pull, inactive once gate-met, and a linked-pull resource per leased linked pull", () => {
    const resources = githubContributor.contribute(matrix("ticket", "build")).resources;
    expect(resources).toEqual([
      { source: "github", id: "open-pull:acme/web#7", active: false, subject: { kind: "pull", id: "acme/web#7" } },
      { source: "github", id: "open-pull:acme/web#8", active: true, subject: { kind: "pull", id: "acme/web#8" } },
      { source: "github", id: "linked-pull:acme/web#7", active: true, subject: { kind: "pull", id: "acme/web#7" } },
      { source: "github", id: "linked-pull:acme/web#8", active: true, subject: { kind: "pull", id: "acme/web#8" } },
      // BB-413 (C7): the wake pull watch (a ticket's belonging open pull whose
      // gate is unmet), distinct from the idle-blocking `open-pull` above.
      { source: "github", id: "pull-watch", active: true, subject: null },
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
    expect(held.holds.map((h) => h.id)).toEqual(["hold", "ending", "requeue", "behind", "stack", "merge-behind", "ready-gate"]);
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
    expect(linearContributor.contribute(linear).holds.map((h) => h.id)).toEqual(["hold", "ending", "requeue", "behind", "stack", "merge-behind", "ready-gate"]);
    expect(localContributor.contribute(linear)).toEqual({ source: "local", gate: [], waits: [], resources: [], holds: [], reasons: [] });

    const github = input({ observed: { entity: pull({}), pulls: [] } });
    expect(githubContributor.contribute(github).holds.map((h) => h.id)).toEqual(["hold", "ending", "requeue", "behind", "stack", "merge-behind", "ready-gate"]);
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
      ["behind", false],
      ["stack", false],
      ["merge-behind", false],
      ["ready-gate", false],
    ]);
    const past = input({ binding: binding({ requeueUntil: 1_000_000 - 1 }) });
    expect(composeAssessment(past).holds.map((h) => [h.id, h.held])).toEqual([
      ["hold", false],
      ["ending", false],
      ["requeue", false],
      ["behind", false],
      ["stack", false],
      ["merge-behind", false],
      ["ready-gate", false],
    ]);
  });

  it("records no compose divergence through the existing compare path", () => {
    for (const [label, i] of characterizationFixtures()) {
      const a = assess(i);
      const rows = compare(i, a, composeAssessment(i)).filter((d) => d.surface.startsWith("compose."));
      expect(rows, label).toEqual([]);
    }
  });

  it("compare still records the six C1 surfaces when no composed answer is passed (BB-413 retired the live-source surface)", () => {
    const union = new Set<string>();
    for (const [label, i] of characterizationFixtures()) {
      for (const d of compare(i, assess(i))) union.add(d.surface);
    }
    expect([...union].sort()).toEqual(["approvals.gate", "approvals.pageRefusal", "idleInActiveStage", "noWakeSource", "runningWorkerReason", "workerInFlight"]);
  });
});

// ---------------------------------------------------------------------------
// BB-399 (C4): the composed liveness (idle/stall), in shadow.
// ---------------------------------------------------------------------------

describe("the composed liveness is assess()'s (BB-400, C5)", () => {
  /**
   * Every wait kind (live and not), no wait, a live structured source, and the
   * three hold-like rows the idle rule reads. The last two rows set `gatePulls`
   * wider than `ownPulls`, as the reconcile always does, so the idle-blocking
   * resource must follow `ownPulls` (BB-399 review round 1).
   */
  const livenessCases = (): Array<[string, AssessmentInput]> => {
    const linkedNotOwn = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
    const teammate = pull({ key: "acme/web#9", url: "https://github.com/acme/web/pull/9" }, { headSha: "ccccccc3" });
    return [
      ["no wait", input({ binding: binding({ status: status("the vendor") }) })],
      ...waitCases(),
      ["live source", waitInput({ kind: "external", ref: "the vendor" }, { workers: [{ threadId: "thr_w1", status: "running" } as never] })],
      ["hold", input({ binding: binding({ hold: "a freeze" }) })],
      ["ending", input({ binding: binding({ ending: "terminal" }) })],
      ["requeue ahead", input({ binding: binding({ requeueUntil: 1_000_000 + 86_400_000 }) })],
      [
        "ticket with a linked pull the worker has not reported",
        input({
          binding: binding({ stage: "build", phase: "In Progress" }),
          observed: { entity: issue({ state: "In Progress" }), pulls: [linkedNotOwn] },
          ownPulls: new Set<string>(),
          gatePulls: new Set([linkedNotOwn.key.toLowerCase()]),
          decisions: new Map([[linkedNotOwn.key.toLowerCase(), "user"]]),
        }),
      ],
      [
        "review binding on a pull whose head is not a worker's branch",
        input({
          binding: binding({ kind: "review", stage: "review", phase: "In Review", entityKey: teammate.key }),
          observed: { entity: teammate, pulls: [] },
          ownPulls: new Set<string>(),
          gatePulls: new Set([teammate.key.toLowerCase()]),
          decisions: new Map([[teammate.key.toLowerCase(), "user"]]),
        }),
      ],
    ];
  };

  it("derives idle and stalled equal to assess()'s for every row", () => {
    for (const [label, i] of livenessCases()) {
      const a = assess(i);
      expect(composeAssessment(i).liveness, label).toMatchObject({ idle: a.liveness.idle, stalled: a.liveness.stalled });
    }
  });

  // BB-400 criterion: `assess().liveness.{idle,stalled}` is the composer's over
  // the whole C1 characterization matrix, not just the liveness rows.
  it("makes assess()'s idle and stalled the composed answer for every characterization fixture", () => {
    for (const [label, i] of characterizationFixtures()) {
      const a = assess(i);
      const composed = composeAssessment(i);
      expect({ idle: a.liveness.idle, stalled: a.liveness.stalled }, label).toEqual({ idle: composed.liveness.idle, stalled: composed.liveness.stalled });
    }
  });

  it("takes assess()'s idle, idleBase and stalled from a passed composed answer", () => {
    const i = input();
    const flipped = { ...composeAssessment(i), liveness: { live: true, idleBase: true, idle: true, stalled: true } };
    expect(assess(i, flipped).liveness).toMatchObject({ live: true, idleBase: true, idle: true, stalled: true });
  });

  it("retired the compose.liveness surface from compare", () => {
    const union = new Set<string>();
    for (const [, i] of livenessCases()) for (const d of compare(i, assess(i), composeAssessment(i))) union.add(d.surface);
    expect(union.has("compose.liveness")).toBe(false);
  });

  it("takes the idle pull wait from the github contributor's open-pull resources, not from core naming the pull set", () => {
    // A ticket in build with an open, gate-unmet own pull is not idle. The
    // composer reads the github contributor's `open-pull` resource for it, so
    // stubbing that contribution away flips the composed idle — core never
    // names the pull set.
    const i = matrix("ticket", "build");
    expect(composeAssessment(i).liveness.idle).toBe(false);
    const spy = vi.spyOn(githubContributor, "contribute").mockReturnValue({ source: "github", gate: [], waits: [], resources: [], holds: [], reasons: [] });
    try {
      expect(composeAssessment(i).liveness.idle).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // BB-400 criterion: no non-test source derives the typed-wait idle or stall
  // outside the composer. The ops path's `observedStall` is a named exception
  // (out of C5's scope), so this greps the typed-wait shape, not every call to
  // the primitive.
  it("derives the typed-wait idle and stall only in the composer", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx") && !f.includes("node_modules"));
    const derivations: Array<{ file: string; line: string }> = [];
    for (const file of files) {
      for (const line of readFileSync(`${dir}${file}`, "utf8").split("\n")) {
        if (/waitLive === true \? false|!live && waitLive !== true/.test(line)) derivations.push({ file, line: line.trim() });
      }
    }
    expect(derivations.map((d) => d.file)).toEqual(["contribution.ts", "contribution.ts"]);
    expect(derivations.map((d) => d.line)).toEqual([
      "idle: typedWait !== null && waitLive === true ? false : idleBase,",
      "stalled: typedWait === null ? observedStall(binding, live, now) : !live && waitLive !== true && !dateAhead,",
    ]);
  });
});

// ---------------------------------------------------------------------------
// BB-412 (C6): the resources and holds contributions, in shadow.
// ---------------------------------------------------------------------------

describe("the resources and holds contributions (BB-412, C6)", () => {
  /** A `ready` state with every checklist item met and not substantial, so the ready gate passes. */
  const readyMet = () => readyStateSchema.parse({ checklist: tickets.ready!.checklist.map((item) => ({ item, met: true })), substantial: false });

  const linkedNotOwn = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");

  /** One row per resource kind: the composed id and its live value. */
  const resourceCases = (): Array<[string, AssessmentInput, Array<[string, boolean]>]> => [
    ["a gate-met own pull is an inactive open-pull and a live linked-pull", onlyGateMetAt("build"), [["open-pull:acme/web#7", false], ["linked-pull:acme/web#7", true], ["pull-watch", false], ["workers", true], ["parked-workers", true]]],
    [
      "a linked pull no worker reported is a live linked-pull, not an active open-pull",
      input({ observed: { entity: issue({ state: "In Progress" }), pulls: [linkedNotOwn] }, ownPulls: new Set<string>(), gatePulls: new Set([linkedNotOwn.key.toLowerCase()]), decisions: new Map([[linkedNotOwn.key.toLowerCase(), "user"]]), workers: [parkedWorker()] }),
      [["open-pull:acme/web#8", false], ["linked-pull:acme/web#8", true], ["pull-watch", true], ["workers", true], ["parked-workers", true]],
    ],
    ["a live waited pull is a live waited-pull", waitInput({ kind: "pull", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) }), [["waited-pull:acme/web#9", true], ["workers", false]]],
    ["a merged waited pull is an inactive waited-pull", waitInput({ kind: "pull", ref: "acme/web#9" }, { waitedPulls: waited(mergedPull("acme/web#9")) }), [["waited-pull:acme/web#9", false], ["workers", false]]],
    ["an unsettled deployment watch is a live deployment", input({ binding: binding({ deployments: { "acme/web#9": watch("acme/web#9", "merged") as never } }) }), [["deployment:acme/web#9", true], ["workers", false]]],
    ["a settled deployment watch is an inactive deployment", input({ binding: binding({ deployments: { "acme/web#9": watch("acme/web#9", "deployed") as never } }) }), [["deployment:acme/web#9", false], ["workers", false]]],
    ["a named-target deployment watch is keyed by its watch id", input({ binding: binding({ deployments: { "acme/web#9::bb-gate": watch("acme/web#9", "merged") as never } }) }), [["deployment:acme/web#9::bb-gate", true], ["workers", false]]],
    [
      "two named-target watches on one pull keep distinct deployment ids",
      input({ binding: binding({ deployments: { "acme/web#9::bb-gate": watch("acme/web#9", "merged") as never, "acme/web#9::devbox": watch("acme/web#9", "deployed") as never } }) }),
      [["deployment:acme/web#9::bb-gate", true], ["deployment:acme/web#9::devbox", false], ["workers", false]],
    ],
    ["a running worker is a live workers resource", input({ workers: [{ threadId: "thr_w1", status: "running" } as never] }), [["workers", true], ["parked-workers", false]]],
    ["a parked worker is a live workers resource and a live parked-workers resource (BB-413)", input({ workers: [parkedWorker()] }), [["workers", true], ["parked-workers", true]]],
    ["a plainly finished worker is not a live workers resource (BB-413)", input({ workers: [parkedWorker({ parkedWaitingOn: null })] }), [["workers", false], ["parked-workers", false]]],
    ["an open escalation is a live escalations resource", input({ escalations: [{ status: "open", route: "project" } as never] }), [["escalations", true]]],
    ["an open need is a live needs resource", input({ needs: [{} as never] }), [["needs", true]]],
  ];

  it("composes one resource per kind with its live value", () => {
    for (const [label, i, expected] of resourceCases()) {
      expect(composeAssessment(i).resources, label).toEqual(expect.arrayContaining(expected.map(([id, active]) => expect.objectContaining({ id, active }))));
    }
  });

  it("carries the deployment key and the linked/waited pull as the resource subject", () => {
    const deployment = composeAssessment(resourceCases()[4]![1]).resources.find((r) => r.id === "deployment:acme/web#9")!;
    expect(deployment.subject).toEqual({ kind: "pull", id: "acme/web#9" });
    const waited = composeAssessment(resourceCases()[2]![1]).resources.find((r) => r.id === "waited-pull:acme/web#9")!;
    expect(waited.subject).toEqual({ kind: "pull", id: "acme/web#9" });
    const workers = composeAssessment(resourceCases()[0]![1]).resources.find((r) => r.id === "workers")!;
    expect(workers.subject).toBeNull();
  });

  /** The seven hold ids in the order the composer emits them. */
  const HOLD_IDS = ["hold", "ending", "requeue", "behind", "stack", "merge-behind", "ready-gate"] as const;
  const held = (i: AssessmentInput): Array<[string, boolean]> => composeAssessment(i).holds.map((h) => [h.id, h.held] as [string, boolean]);
  const allHolds = (on: Partial<Record<(typeof HOLD_IDS)[number], boolean>>): Array<[string, boolean]> => HOLD_IDS.map((id) => [id, on[id] ?? false]);

  it("composes one hold per kind with its held value", () => {
    expect(held(input({ binding: binding({ hold: "a freeze" }) }))).toEqual(allHolds({ hold: true }));
    expect(held(input({ binding: binding({ ending: "terminal" }) }))).toEqual(allHolds({ ending: true }));
    expect(held(input({ binding: binding({ requeueUntil: 1_000_000 + 1 }) }))).toEqual(allHolds({ requeue: true }));
    expect(held(input({ binding: binding({ requeueUntil: 1_000_000 - 1 }) }))).toEqual(allHolds({}));
    expect(held(input({ binding: binding({ holdBehind: ["ENG-13"] }) }))).toEqual(allHolds({ behind: true }));
    expect(held(input({ binding: binding({ holdStack: ["ENG-13"] }) }))).toEqual(allHolds({ stack: true }));
    expect(held(input({ binding: binding({ mergeBehind: ["ENG-14"] }) }))).toEqual(allHolds({ "merge-behind": true }));
    expect(held(input({ binding: binding({ stage: "spec", phase: "Todo" }) }))).toEqual(allHolds({ "ready-gate": true }));
    expect(held(input({ binding: binding({ stage: "spec", phase: "Todo", ready: readyMet() }) }))).toEqual(allHolds({}));
  });

  it("carries the entity keys a behind or merge-behind hold waits on", () => {
    const behind = composeAssessment(input({ binding: binding({ holdBehind: ["ENG-13", "ENG-14"] }) })).holds.find((h) => h.id === "behind")!;
    expect(behind.behind).toEqual(["ENG-13", "ENG-14"]);
    const merge = composeAssessment(input({ binding: binding({ mergeBehind: ["ENG-15"] }) })).holds.find((h) => h.id === "merge-behind")!;
    expect(merge.behind).toEqual(["ENG-15"]);
  });

  it("names the intended differences: a linked pull and a parked worker are resources but not idle-blocking", () => {
    const composed = composeAssessment(resourceCases()[1]![1]);
    // Both resources are live, and neither suppresses the idle wake: the linked
    // pull is not an own pull, and `idleInActiveStage` reads only a running
    // worker (a parked worker is `parked-workers`).
    expect(composed.resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: "linked-pull:acme/web#8", active: true }), expect.objectContaining({ id: "workers", active: true })]));
    expect(composed.liveness.idle).toBe(true);
    expect(compare(resourceCases()[1]![1], assess(resourceCases()[1]![1]), composed).filter((d) => d.surface.startsWith("compose."))).toEqual([]);
  });

  it("records no compose divergence for any resource or hold fixture", () => {
    const fixtures: Array<[string, AssessmentInput]> = [...resourceCases().map(([label, i]): [string, AssessmentInput] => [label, i]), ...HOLD_IDS.flatMap((id) => {
      const over: Partial<AssessmentInput["binding"]> = id === "hold" ? { hold: "a freeze" } : id === "ending" ? { ending: "terminal" } : id === "requeue" ? { requeueUntil: 1_000_000 + 1 } : id === "behind" ? { holdBehind: ["ENG-13"] } : id === "stack" ? { holdStack: ["ENG-13"] } : id === "merge-behind" ? { mergeBehind: ["ENG-14"] } : { stage: "spec", phase: "Todo" };
      return [[`hold ${id}`, input({ binding: binding(over) })] as [string, AssessmentInput]];
    })];
    for (const [label, i] of fixtures) {
      expect(compare(i, assess(i), composeAssessment(i)).filter((d) => d.surface.startsWith("compose.")), label).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// BB-413 (C7): the composed live-source answer covers every WakeSourceInput
// field. This is the fixture the ticket asks for before the old predicate is
// deleted: for each field, the composed `live` equals the row predicate over
// the same rows.
// ---------------------------------------------------------------------------

describe("the composed live-source answer covers every WakeSourceInput field (BB-413, C7)", () => {
  const sourcesFor = (i: AssessmentInput, pullRequestWatch: boolean): WakeSourceInput => ({
    hold: i.binding.hold,
    holdBehind: i.binding.holdBehind ?? [],
    mergeBehind: i.binding.mergeBehind ?? [],
    holdStack: i.binding.holdStack ?? [],
    deployments: i.binding.deployments,
    runningWorkers: i.workers.filter((w) => w.status === "running").length,
    parkedWorkers: i.workers.filter((w) => w.status === "finished" && w.parkedWaitingOn !== null).length,
    openEscalations: i.escalations.length,
    openNeeds: i.needs.length,
    pullRequestWatch,
  });

  const ownPullInput = (): AssessmentInput => {
    const pr = openPull("acme/web#9");
    return input({ observed: { entity: issue({ state: "In Progress" }), pulls: [pr] }, ownPulls: own(pr), gatePulls: own(pr), decisions: new Map([[pr.key.toLowerCase(), "user" as const]]) });
  };

  const cases = (): Array<[string, AssessmentInput, boolean, boolean]> => [
    // [label, input, pullRequestWatch, expected live]
    ["hold behind another binding", input({ binding: binding({ hold: "a freeze", holdBehind: ["ENG-13"] }) }), false, true],
    ["stack-wait on another binding", input({ binding: binding({ hold: "stacked", holdStack: ["ENG-13"] }) }), false, true],
    ["merge hold", input({ binding: binding({ mergeBehind: ["ENG-14"] }) }), false, true],
    ["a hold with nothing behind it is not a source", input({ binding: binding({ hold: "a freeze" }) }), false, false],
    ["a deployment watch deploying", input({ binding: binding({ deployments: { "acme/web#9": watch("acme/web#9", "deploying") as never } }) }), false, true],
    ["a settled deployment watch", input({ binding: binding({ deployments: { "acme/web#9": watch("acme/web#9", "deployed") as never } }) }), false, false],
    ["a running worker", input({ workers: [{ threadId: "thr_w1", status: "running" } as never] }), false, true],
    ["a parked worker", input({ workers: [parkedWorker()] }), false, true],
    ["a plainly finished worker is not a source", input({ workers: [parkedWorker({ parkedWaitingOn: null })] }), false, false],
    ["an open escalation", input({ escalations: [{ status: "open", route: "project" } as never] }), false, true],
    ["an open need", input({ needs: [{} as never] }), false, true],
    ["a ticket's open pull whose gate is unmet", ownPullInput(), true, true],
    ["a pr binding's own open pull is not a source", input({ binding: binding({ kind: "pr" }), observed: { entity: pull({ key: "acme/web#9", url: "https://github.com/acme/web/pull/9", state: "open" }), pulls: [] }, ownPulls: own(pull({ key: "acme/web#9", url: "https://github.com/acme/web/pull/9" })) }), false, false],
    ["no structured source", input(), false, false],
  ];

  it("makes the composed live equal the row predicate and the named answer for every field", () => {
    for (const [label, i, pullRequestWatch, expected] of cases()) {
      const composed = composeAssessment(i).liveness.live;
      expect(composed, label).toBe(expected);
      expect(composed, label).toBe(rowLiveSource(sourcesFor(i, pullRequestWatch)));
    }
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
    // `compose` folds contributions only; the liveness is a neutral default
    // that `composeAssessment` overwrites.
    expect(composed.liveness).toEqual({ live: false, idleBase: false, idle: false, stalled: false });
  });

  it("a gate contribution carries the source, subject, id and inputs the design names", () => {
    const g: GateContribution = githubContributor.contribute(onlyGateMetAt("build")).gate[0]!;
    expect(g).toMatchObject({ source: "github", subject: { kind: "pull", id: "acme/web#7" }, id: "merge", met: true, missing: null, lane: "user" });
    expect(g.inputs).toBe(g.assessed.key);
  });
});

// ---------------------------------------------------------------------------
// BB-387 (C3): the gate is the github contributor's, composed by `assess()`.
// ---------------------------------------------------------------------------

describe("the composed gate is the github contributor's (BB-387)", () => {
  it("takes `assess()`'s gate from the github contributor: a stubbed contribution changes it", () => {
    const i = onlyGateMetAt("build");
    const real = assess(i);
    expect(real.gate).toMatchObject({ met: true, decision: "user", missing: null });

    const stub: GateContribution = {
      source: "github",
      subject: { kind: "pull", id: "acme/web#7" },
      id: "merge",
      met: false,
      missing: "the stub says unmet",
      lane: "project",
      escalated: false,
      product: false,
      inputs: "stub",
      assessed: { ...real.gate.pulls[0]!, met: false, missing: "the stub says unmet", decision: "project", key: "stub" },
    };
    const spy = vi.spyOn(githubContributor, "contribute").mockReturnValue({ source: "github", gate: [stub], waits: [], resources: [], holds: [], reasons: [] });
    try {
      const stubbed = assess(i);
      expect(stubbed.gate).toMatchObject({ met: false, decision: "project", missing: "the stub says unmet" });
      expect(stubbed.gate.pulls).toEqual([stub.assessed]);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps assessment.ts free of the pull-specific gate computation", () => {
    const source = readFileSync(fileURLToPath(new URL("./assessment.ts", import.meta.url)), "utf8");
    // No import names the computation the github contributor owns. The body may
    // still discuss `prGate` in the divergence-log comment, so only the import
    // statements are checked.
    expect(source).not.toMatch(/import\s*\{[^}]*\bassessedPullGate\b[^}]*\}/s);
    expect(source).not.toMatch(/import\s*\{[^}]*\bprGate\b[^}]*\}/s);
    // The gate arrives through the contributor's composer.
    expect(source).toMatch(/\bcomposeAssessment\b/);
  });

  it("calls prGate from exactly one site in the plugin source, pullGate (BB-322 criterion 1)", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx") && !f.includes("node_modules"));
    const calls: Array<{ file: string; line: string }> = [];
    for (const file of files) {
      const text = readFileSync(`${dir}${file}`, "utf8");
      for (const line of text.split("\n")) {
        // The gate module's own `export function prGate(` is the definition, not
        // a call site.
        if (/\bprGate\s*\(/.test(line) && !/function\s+prGate\s*\(/.test(line)) calls.push({ file, line: line.trim() });
      }
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("contribution.ts");
    expect(calls[0]!.line).toBe("return prGate(entity, options);");
  });
});
