// BB-293 (child 2 of BB-291): the shadow assessment and its divergence log.
// The fixtures are the ones BB-292 characterized: the BB-266 shape (a gate-met
// own pull request, a parked `finished` worker and a second open own pull
// request) and bb-plugins#294 (a `pr` binding's own open pull request with a
// free-text wait). Each BB-292 divergence appears here as a fixture whose
// divergence `compare` returns, so the log records it. Every gate-met fixture
// carries a parked worker and a second open own pull request unless the test is
// about their absence (named in the title).
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ASSESSMENT_DIVERGENCE_MAX_AGE_MS, ASSESSMENT_DIVERGENCE_MAX_ROWS, assess, compare, ownPullEntities, type AssessmentInput } from "./assessment.js";
import { parsePlaybook, type Playbook } from "./config.js";
import { comment, issue, parkedWorker, pull } from "./fixtures.js";
import { approvalMarkerLine } from "./gate.js";
import { formatDivergences } from "./server.js";
import { MIGRATIONS, createStore, readyStateSchema, type StatusRecord } from "./store.js";
import { LINEAR_TICKETS } from "./templates.js";
import type { EntitySnapshot } from "./source-contract.js";
import type { WakeSourceInput } from "./wake-source.js";

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
// The owner's unsigned approval, as the Stewards page posts it (BB-279).
const ownerUnsignedApproval = comment({ id: "oa", author: "jane", body: `Approved ${head} from the Stewards page`, signedBy: null, createdAt: "2026-10-14T17:00:00Z" });

const noSources: WakeSourceInput = { hold: null, holdBehind: [], mergeBehind: [], holdStack: [], deployments: {}, runningWorkers: 0, openEscalations: 0, openNeeds: 0, pullRequestWatch: false };

/** A gate-met own pull request (no-review, green) plus the reviewer marker. */
const gateMetPull = (key: string, url: string) => pull({ key, url, comments: [noReviewMarker] }, { headSha: head, ...green });
/** A second, not-gate-met own pull request, so the fixture is not about a lone PR. */
const secondOpenPull = (key: string, url: string) => pull({ key, url }, { headSha: "bbbbbbb2" });

/** The lowercased keys and URLs of the binding's own pull requests (BB-52 rule 0). */
const own = (...pulls: EntitySnapshot[]): Set<string> => new Set(pulls.flatMap((p) => [p.key.toLowerCase(), (p.url ?? "").toLowerCase()]).filter((s) => s !== ""));

const status = (waitingOn: string | null): StatusRecord => ({ phase: "In Progress", summary: "s", nextAction: "n", actor: "other", waitingOn, requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: 1 });

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

/**
 * BB-266: a gate-met own pull request, a parked `finished` worker, and (unless
 * `secondOpen` says the test is about its absence) a second open own pull
 * request. `sources` is the report path's, with no tracked source, so the
 * parked worker is not a wake source.
 */
function bb266(secondOpen: boolean): AssessmentInput {
  const first = gateMetPull("acme/web#7", "https://github.com/acme/web/pull/7");
  const second = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
  const pulls = secondOpen ? [first, second] : [first];
  return input({
    observed: { entity: issue({ state: "In Progress" }), pulls },
    ownPulls: own(...pulls),
    decisions: new Map(pulls.map((p) => [p.key.toLowerCase(), "user" as const])),
    workers: [parkedWorker({ result: "Waiting on the owner's approval of acme/web#7." })],
    sources: { ...noSources },
  });
}

describe("the shadow assessment: the worker state (BB-266)", () => {
  it("names a parked finished worker `parked`, in flight but not running", () => {
    const i = bb266(true);
    const a = assess(i);
    expect(a.worker).toMatchObject({ state: "parked", inFlight: true, running: false, parked: true, reason: null });
    expect(a.gate.pulls).toHaveLength(2);
    expect(a.gate.pulls[0]).toMatchObject({ pull: "acme/web#7", met: true, lane: "no-review" });
    expect(a.gate.pulls[1]).toMatchObject({ pull: "acme/web#8", met: false });
  });

  // DIVERGENCE (BB-292 #1): workerInFlight counts the parked worker in flight,
  // runningWorkerReason says nobody is mid-turn, and hasLiveWakeSource says no
  // tracked source is live; the assessment names the one state `parked`.
  it("records the parked-worker divergences: in-flight, not mid-turn, no live source", () => {
    const i = bb266(true);
    const a = assess(i);
    expect(a.liveness.idle).toBe(false); // the second open own PR is gate-unmet
    const d = compare(i, a);
    const by = new Map(d.map((x) => [x.surface, x]));
    expect(by.get("workerInFlight")).toMatchObject({ old: "in-flight", new: "parked" });
    expect(by.get("runningWorkerReason")).toMatchObject({ old: "not-mid-turn", new: "parked" });
    expect(by.get("hasLiveWakeSource")).toMatchObject({ old: "no-live-source", new: "parked" });
    expect(by.has("idleInActiveStage")).toBe(false);
    // The log's inputs hold only ids, states and timestamps.
    expect(by.get("workerInFlight")!.inputs).toEqual({ binding: "b1", workers: 1, states: "finished" });
  });

  // DIVERGENCE (BB-292 #1, the idle half): with only the gate-met own PR open,
  // idleInActiveStage calls the binding idle while workerInFlight calls the
  // parked worker in flight. The second own PR's absence is the test.
  it("records idleInActiveStage when the second own PR is absent (BB-266)", () => {
    const i = bb266(false);
    const a = assess(i);
    expect(a.liveness.idle).toBe(true);
    const d = compare(i, a);
    expect(d.find((x) => x.surface === "idleInActiveStage")).toMatchObject({ old: "idle", new: "parked" });
  });

  it("derives the explicit states directly, including none and running", () => {
    expect(assess(input()).worker.state).toBe("none");
    expect(assess(input({ workers: [{ ...parkedWorker(), status: "running" }] })).worker.state).toBe("running");
    expect(assess(input({ workers: [{ ...parkedWorker(), status: "failed" }] })).worker.state).toBe("failed");
    expect(assess(input({ workers: [{ ...parkedWorker(), status: "stopped" }] })).worker.state).toBe("stopped");
  });
});

describe("the shadow assessment: the merge gate inputs (BB-292 #2)", () => {
  // DIVERGENCE: approvals.ts builds the gate with `prGate(pull,
  // productGateOptions(b, pull))`, omitting `decision` and the recorded project
  // approvals; the full gate (server.ts, wake.ts, `bb stewards gate`) passes
  // both. On a project entry whose recorded `bb-approval` is on the pull
  // request the full gate is met and the approvals.ts path still asks the owner.
  it("records the approvals.gate divergence: the full gate is met, the approvals.ts gate asks the owner", () => {
    const entity = pull({ comments: [ownerMarker, projectApprovalMarker("pa1")] }, { headSha: head, ...green });
    const i = input({
      binding: binding({ kind: "review" }),
      observed: { entity, pulls: [] },
      ownPulls: own(entity),
      decisions: new Map([[entity.key.toLowerCase(), "project"]]),
      projectApprovals: [{ commentId: "pa1", verdict: "approved" }],
      // The BB-291 rule: a gate-met fixture carries a parked worker.
      workers: [parkedWorker()],
    });
    const a = assess(i);
    expect(a.gate.pulls[0]).toMatchObject({ met: true, decision: "project", projectApproved: true, lane: "owner-reviewed" });
    const d = compare(i, a);
    expect(d.find((x) => x.surface === "approvals.gate")).toMatchObject({ old: "owner approval needed", new: "met" });
    // The inputs are the ids and shas, never a comment body.
    expect(d.find((x) => x.surface === "approvals.gate")!.inputs).toEqual({ binding: "b1", pull: "acme/web#7", headSha: head, decision: "project", recordedApprovals: 1 });
  });

  it("agrees when the recorded project approval is absent from the gate inputs", () => {
    const entity = pull({ comments: [ownerMarker] }, { headSha: head, ...green });
    const i = input({ binding: binding({ kind: "review" }), observed: { entity, pulls: [] }, ownPulls: own(entity), decisions: new Map([[entity.key.toLowerCase(), "project"]]) });
    const a = assess(i);
    // No recorded approval, so the full gate is unmet too: no divergence.
    expect(a.gate.pulls[0].met).toBe(false);
    expect(compare(i, a).find((x) => x.surface === "approvals.gate")).toBeUndefined();
  });

  // BB-321: bb-plugins#330 (BB-300). The decide list placed the huddle
  // migration under the store-migration `project` entry, but the project
  // steward forwarded the approval escalation to the owner (BB-192), who
  // approved unsigned; the merge path counted that approval. The assessment
  // must not demand a project-steward approval the owner already gave, or the
  // shadow is stricter than the lane rules and logs a false divergence.
  it("agrees when the owner approved a project-placed pull the project steward forwarded (BB-321)", () => {
    const entity = pull({ key: "acme/web#7", url: "https://github.com/acme/web/pull/7", comments: [ownerMarker, ownerUnsignedApproval] }, { headSha: head, ...green });
    const second = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
    const i = input({
      observed: { entity: issue({ state: "In Progress" }), pulls: [entity, second] },
      ownPulls: own(entity, second),
      decisions: new Map([
        [entity.key.toLowerCase(), "project"],
        [second.key.toLowerCase(), "project"],
      ]),
      // The binding's three recorded project approvals are for the sibling
      // pulls; none is a `bb-approval` on #330, which carries no marker.
      projectApprovals: [
        { commentId: "pa-327", verdict: "approved" },
        { commentId: "pa-328", verdict: "approved" },
        { commentId: "pa-329", verdict: "approved" },
      ],
      workers: [parkedWorker()],
    });
    const a = assess(i);
    expect(a.gate.pulls[0]).toMatchObject({ pull: "acme/web#7", met: true, decision: "user", ownerApproved: true, projectApproved: false, lane: "owner-reviewed" });
    // The old gate (no decide mark, no recorded approvals) also says met, so
    // the anomalous `met → project steward approval needed` divergence is gone.
    expect(compare(i, a).find((x) => x.surface === "approvals.gate")).toBeUndefined();
  });
});

describe("the shadow assessment: the page refusal text (BB-292 #3)", () => {
  // DIVERGENCE: the page action's refusal falls through to its `??` fallback on
  // a met no-review gate, so it says "the pull request has not been observed
  // yet" while the gate answers met.
  it("records the approvals.pageRefusal divergence on a met no-review gate", () => {
    const first = gateMetPull("acme/web#7", "https://github.com/acme/web/pull/7");
    const second = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
    const i = input({
      observed: { entity: issue({ state: "In Progress" }), pulls: [first, second] },
      ownPulls: own(first, second),
      decisions: new Map([
        ["acme/web#7", "user"],
        ["acme/web#8", "user"],
      ]),
      workers: [parkedWorker()],
    });
    const a = assess(i);
    expect(a.gate.pulls[0].met).toBe(true);
    const d = compare(i, a);
    expect(d.find((x) => x.surface === "approvals.pageRefusal")).toMatchObject({ old: "the pull request has not been observed yet", new: "met" });
  });
});

describe("the shadow assessment: the liveness (bb-plugins#294 and noWakeSource)", () => {
  it("derives the stall from the rows on the bb-plugins#294 shape, agreeing with the report-time flag", () => {
    // #294: a `pr` binding's own open pull request with a free-text wait and no
    // other source; the report path marks it noWakeSource, and the rows say the
    // same thing.
    const entity = pull({ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" });
    const i = input({
      binding: binding({ kind: "pr", status: status("the dompurify fix on main"), noWakeSource: true }),
      observed: { entity, pulls: [] },
      ownPulls: own(entity),
      sources: { ...noSources, pullRequestWatch: false },
    });
    const a = assess(i);
    expect(a.liveness.live).toBe(false);
    expect(a.liveness.stalled).toBe(true);
    expect(a.liveness.reportedNoWakeSource).toBe(true);
    // Agreement, so nothing is logged.
    expect(compare(i, a).find((x) => x.surface === "noWakeSource")).toBeUndefined();
  });

  it("records a noWakeSource divergence when the report-time flag and the rows disagree", () => {
    const i = input({ binding: binding({ noWakeSource: true, status: null }) });
    const a = assess(i);
    expect(a.liveness.stalled).toBe(false);
    expect(compare(i, a).find((x) => x.surface === "noWakeSource")).toMatchObject({ old: "no-wake-source", new: "source-or-no-wait" });
  });

  it("does not call a dated wait a stall", () => {
    const i = input({ binding: binding({ status: status("the vendor's reply"), requeueUntil: 2_000_000, noWakeSource: false }) });
    const a = assess(i);
    expect(a.liveness.stalled).toBe(false);
  });

  it("selects the binding's own pull requests, not every observed one", () => {
    const mine = pull({ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" });
    const other = pull({ key: "acme/web#9", url: "https://github.com/acme/web/pull/9" });
    const entities = ownPullEntities({ entity: issue(), pulls: [mine, other] }, own(mine));
    expect(entities.map((e) => e.key)).toEqual(["acme/web#7"]);
  });
});

describe("the divergence store", () => {
  function store() {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.exec(sql);
    let now = 1_000;
    const s = createStore(db, () => now);
    return { s, advance: (ms: number) => (now += ms) };
  }

  it("keeps the latest assessment per binding and dedupes an unchanged divergence", () => {
    const { s } = store();
    s.recordAssessment({ bindingId: "b1", at: 1_000, gate: { met: true }, worker: { state: "parked" }, liveness: { live: false } });
    s.recordAssessment({ bindingId: "b1", at: 2_000, gate: { met: false }, worker: { state: "running" }, liveness: { live: true } });
    expect(s.assessment("b1")).toMatchObject({ at: 2_000, gate: { met: false }, worker: { state: "running" } });
    expect(s.assessments()).toHaveLength(1);
    s.recordDivergences([{ bindingId: "b1", surface: "workerInFlight", old: "in-flight", new: "parked", inputs: { workers: 1 } }], 1_000);
    s.recordDivergences([{ bindingId: "b1", surface: "workerInFlight", old: "in-flight", new: "parked", inputs: { workers: 2 } }], 2_000);
    const rows = s.divergences();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, firstSeenAt: 1_000, lastSeenAt: 2_000, inputs: { workers: 2 } });
    // Filters.
    expect(s.divergences({ bindingId: "b1" })).toHaveLength(1);
    expect(s.divergences({ surface: "workerInFlight" })).toHaveLength(1);
    expect(s.divergences({ bindingId: "b1", surface: "workerInFlight" })).toHaveLength(1);
    expect(s.divergences({ bindingId: "b2" })).toHaveLength(0);
    expect(s.divergences({ surface: "approvals.gate" })).toHaveLength(0);
  });

  it("bounds the log by an age and a row count", () => {
    const { s } = store();
    for (let i = 0; i < 5; i++) s.recordDivergences([{ bindingId: "b1", surface: `s${i}`, old: "a", new: "b", inputs: {} }], 1_000 + i);
    expect(s.divergences()).toHaveLength(5);
    // Neither bound bites: all rows are newer than the age and under the count.
    expect(s.pruneDivergences(ASSESSMENT_DIVERGENCE_MAX_AGE_MS, ASSESSMENT_DIVERGENCE_MAX_ROWS, 2_000)).toBe(0);
    // The row-count bound keeps the newest three.
    expect(s.pruneDivergences(10_000, 3, 2_000)).toBe(2);
    expect(s.divergences()).toHaveLength(3);
    // The age bound drops the rest once they are old enough.
    expect(s.pruneDivergences(1_000, 10, 20_000)).toBe(3);
    expect(s.divergences()).toHaveLength(0);
  });

  it("formats the log for the CLI, one block per row", () => {
    const rows = [{ bindingId: "b1", surface: "workerInFlight", old: "in-flight", new: "parked", inputs: { workers: 1 }, firstSeenAt: 1_000, lastSeenAt: 2_000, count: 2 }];
    const text = formatDivergences(rows);
    expect(text).toContain("b1  workerInFlight  x2");
    expect(text).toContain("old: in-flight");
    expect(text).toContain("new: parked");
    expect(text).toContain('inputs: {"workers":1}');
    expect(formatDivergences([])).toBe("No divergences recorded.");
  });
});
