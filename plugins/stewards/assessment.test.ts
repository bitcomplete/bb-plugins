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
import { ASSESSMENT_DIVERGENCE_MAX_AGE_MS, ASSESSMENT_DIVERGENCE_MAX_ROWS, assess, compare, ownPullEntities, waitOverdueMs, type AssessmentInput } from "./assessment.js";
import { parsePlaybook, type Playbook } from "./config.js";
import { composeAssessment } from "./contribution.js";
import { comment, issue, parkedWorker, pull } from "./fixtures.js";
import { approvalMarkerLine } from "./gate.js";
import { formatDivergences } from "./server.js";
import { MIGRATIONS, createStore, readyStateSchema, type StatusRecord } from "./store.js";
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
// The owner's unsigned approval, as the Stewards page posts it (BB-279).
const ownerUnsignedApproval = comment({ id: "oa", author: "jane", body: `Approved ${head} from the Stewards page`, signedBy: null, createdAt: "2026-10-14T17:00:00Z" });


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

/**
 * BB-266: a gate-met own pull request, a parked `finished` worker, and (unless
 * `secondOpen` says the test is about its absence) a second open own pull
 * request. The parked worker is the composed `parked-workers` resource, so
 * `assess().liveness.live` is true exactly as the report path read it.
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
  // runningWorkerReason says nobody is mid-turn; the assessment names the one
  // state `parked`. BB-413 (C7) retired the live-source row.
  it("records the parked-worker divergences: in-flight and not mid-turn", () => {
    const i = bb266(true);
    const a = assess(i);
    expect(a.liveness.idle).toBe(false); // the second open own PR is gate-unmet
    const d = compare(i, a);
    const by = new Map(d.map((x) => [x.surface, x]));
    expect(by.get("workerInFlight")).toMatchObject({ old: "in-flight", new: "parked" });
    expect(by.get("runningWorkerReason")).toMatchObject({ old: "not-mid-turn", new: "parked" });
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

  // BB-329: `parked` is driven by the worker's own `worker_park` call. A
  // finished worker that did not park is a plain finish, whatever its text.
  it("names a finished worker that did not call worker_park `finished`, not `parked`", () => {
    const plain = assess(input({ workers: [{ ...parkedWorker(), parkedWaitingOn: null, result: "Waiting on the owner's approval of acme/web#7." }] })).worker;
    expect(plain).toMatchObject({ state: "finished", parked: false, running: false });
    const parked = assess(input({ workers: [parkedWorker()] })).worker;
    expect(parked).toMatchObject({ state: "parked", parked: true });
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

describe("the shadow assessment: the liveness (bb-plugins#294 and the free-text rule)", () => {
  it("derives the stall from the rows on the bb-plugins#294 shape", () => {
    // #294: a `pr` binding's own open pull request with a free-text wait and no
    // other source; the derivation marks it stalled.
    const entity = pull({ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" });
    const i = input({
      binding: binding({ kind: "pr", status: status("the dompurify fix on main") }),
      observed: { entity, pulls: [] },
      ownPulls: own(entity),
    });
    const a = assess(i);
    expect(a.liveness.live).toBe(false);
    expect(a.liveness.stalled).toBe(true);
  });

  it("does not call a dated wait a stall", () => {
    const i = input({ binding: binding({ status: status("the vendor's reply"), requeueUntil: 2_000_000 }) });
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

// BB-412 (C6): the composed resources and holds. Each old side is derived from
// the raw rows, never from `composed.resources`/`composed.holds`, so a
// hand-built composed answer that differs records a real divergence.
describe("the composed resources and holds divergences (BB-412, C6)", () => {
  it("records a compose.resources row when the composer has a resource the rows do not", () => {
    const i = input();
    const composed = composeAssessment(i);
    const extra = { ...composed, resources: [...composed.resources, { source: "github" as const, id: "linked-pull:acme/web#99", active: true, subject: null }] };
    const rows = compare(i, assess(i), extra).filter((d) => d.surface === "compose.resources");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.old).not.toContain("linked-pull:acme/web#99");
    expect(rows[0]!.new).toContain("linked-pull:acme/web#99:true");
    expect(rows[0]!.inputs).toMatchObject({ binding: "b1", linkedPulls: 0 });
  });

  it("records a compose.resources row when a resource the rows have is missing", () => {
    const i = input();
    const composed = composeAssessment(i);
    const missing = { ...composed, resources: composed.resources.filter((r) => r.id !== "escalations") };
    const rows = compare(i, assess(i), missing).filter((d) => d.surface === "compose.resources");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.old).toContain("escalations:false");
    expect(rows[0]!.new).not.toContain("escalations:false");
    expect(rows[0]!.inputs).toMatchObject({ binding: "b1" });
  });

  it("records a compose.holds row when a hold disagrees", () => {
    const i = input({ binding: binding({ mergeBehind: ["ENG-13"] }) });
    const composed = composeAssessment(i);
    const flipped = { ...composed, holds: composed.holds.map((h) => (h.id === "merge-behind" ? { ...h, held: false } : h)) };
    const rows = compare(i, assess(i), flipped).filter((d) => d.surface === "compose.holds");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.old).toContain("merge-behind:true");
    expect(rows[0]!.new).toContain("merge-behind:false");
    // The inputs hold the ids and booleans, never the composer's output.
    expect(rows[0]!.inputs).toMatchObject({ binding: "b1", mergeBehind: "ENG-13" });
  });

  it("names the intended difference: a linked pull no worker reported is a linked-pull resource but not idle-blocking", () => {
    const linked = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
    const i = input({
      binding: binding({ stage: "build", phase: "In Progress" }),
      observed: { entity: issue({ state: "In Progress" }), pulls: [linked] },
      ownPulls: new Set<string>(),
      gatePulls: new Set([linked.key.toLowerCase()]),
      decisions: new Map([[linked.key.toLowerCase(), "user"]]),
      workers: [parkedWorker()],
    });
    const composed = composeAssessment(i);
    expect(composed.resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: "linked-pull:acme/web#8", active: true })]));
    // The linked pull is not an own pull and the parked worker is not running,
    // so neither suppresses the idle wake, and there is no divergence.
    expect(composed.liveness.idle).toBe(true);
    expect(compare(i, assess(i), composed).filter((d) => d.surface.startsWith("compose."))).toEqual([]);
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

// BB-333 (criterion 4 of BB-291): the typed-wait shadow derivation. `waitLive`
// is resolved from the stored kind on every reconcile, never from the stored
// flag; a typed wait is judged by its own kind, a no-kind report
// keeps the free-text rule exactly.
describe("the shadow assessment: the typed wait (BB-333)", () => {
  const openPull = (key: string, pullOver: Partial<NonNullable<EntitySnapshot["pull"]>> = {}) => {
    const [repo, number] = key.split("#") as [string, string];
    return pull({ key, url: `https://github.com/${repo}/pull/${number}`, state: "open" }, pullOver);
  };
  const waited = (e: EntitySnapshot) => new Map([[e.key.toLowerCase(), e]]);
  const withWait = (wait: NonNullable<AssessmentInput["binding"]["wait"]>, over: Partial<AssessmentInput> = {}) => input({ binding: binding({ wait }), ...over });

  it("derives a live pull wait from the freshly read pull, and suppresses idle", () => {
    const a = assess(withWait({ kind: "pull", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) }));
    expect(a.liveness.waitLive).toBe(true);
    expect(a.liveness.stalled).toBe(false);
    // The base idle rule is true (build stage, no source), and a live typed wait suppresses it.
    expect(a.liveness.idle).toBe(false);
  });

  // BB-389: the typed wait may add liveness but never removes it. An external
  // (or otherwise non-live) wait beside a live structured source is not stalled.
  it("does not stall a non-live external wait while a structured source is live", () => {
    const pr = openPull("acme/web#7");
    const a = assess(withWait({ kind: "external", ref: "the vendor" }, { observed: { entity: issue({ state: "In Progress" }), pulls: [pr] }, ownPulls: own(pr), gatePulls: own(pr), decisions: new Map([[pr.key.toLowerCase(), "user" as const]]) }));
    expect(a.liveness.waitLive).toBe(false);
    expect(a.liveness.live).toBe(true);
    expect(a.liveness.stalled).toBe(false);
  });

  it("derives a review wait live only until the review is given", () => {
    const live = assess(withWait({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) }));
    expect(live.liveness.waitLive).toBe(true);
    const reviewed = assess(withWait({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9", { reviewDecision: "APPROVED" })) }));
    expect(reviewed.liveness.waitLive).toBe(false);
    expect(reviewed.liveness.stalled).toBe(true);
  });

  it("derives a deployment wait live while the watch is merged or deploying", () => {
    const watch = { key: "acme/web#9", state: "deploying" as const, mergeSha: null, target: "", mergedAt: null, prRepo: "acme/web", files: [], repo: "acme/web", environment: "production", deploymentId: null, deploymentState: null, ref: null, sha: null, url: null, at: 1, deadlineAt: null, note: null, workflowRuns: [] };
    const a = assess(input({ binding: binding({ wait: { kind: "deployment", ref: "acme/web#9" }, deployments: { "acme/web#9": watch } }) }));
    expect(a.liveness.waitLive).toBe(true);
  });

  it("derives a worker wait live while the worker runs or is parked", () => {
    const running = assess(withWait({ kind: "worker", ref: "thr_w1" }, { workers: [{ threadId: "thr_w1", status: "running" } as never] }));
    expect(running.liveness.waitLive).toBe(true);
    // BB-389: a parked worker is still waiting, so the wait is live.
    const parked = assess(withWait({ kind: "worker", ref: "thr_w1" }, { workers: [parkedWorker({ threadId: "thr_w1" })] }));
    expect(parked.liveness.waitLive).toBe(true);
    // A plainly finished worker (no park) is over, so the wait is not live.
    const finished = assess(withWait({ kind: "worker", ref: "thr_w1" }, { workers: [parkedWorker({ threadId: "thr_w1", parkedWaitingOn: null })] }));
    expect(finished.liveness.waitLive).toBe(false);
  });

  it("derives a binding and a person wait from the lookups the reconcile holds", () => {
    const open = assess(withWait({ kind: "binding", ref: "ENG-13" }, { hasOpenBinding: () => true }));
    expect(open.liveness.waitLive).toBe(true);
    const closed = assess(withWait({ kind: "binding", ref: "ENG-13" }, { hasOpenBinding: () => false }));
    expect(closed.liveness.waitLive).toBe(false);
    const person = assess(withWait({ kind: "person", ref: "need_1" }, { hasOpenItem: () => true }));
    expect(person.liveness.waitLive).toBe(true);
  });

  it("derives a date wait live only while the scheduled requeue is ahead", () => {
    const now = Date.UTC(2026, 5, 1);
    const dateWait = (ref: string, requeueUntil: number | null) => assess(input({ now, binding: binding({ wait: { kind: "date", ref }, requeueUntil }) }));
    const ahead = dateWait("2026-12-01", Date.UTC(2026, 11, 1));
    expect(ahead.liveness.waitLive).toBe(true);
    expect(ahead.liveness.stalled).toBe(false);
    const past = dateWait("2000-01-01", Date.UTC(2000, 0, 1));
    expect(past.liveness.waitLive).toBe(false);
    expect(past.liveness.stalled).toBe(true);
    // A ref date the report did not turn into `requeueUntil` is not a wake
    // source: the plugin never scheduled a wake there, so the wait stalls
    // rather than reading live from the ref text (the `date` row the shadow
    // showed as derived-live while `noWakeSource` said no source).
    const unscheduled = dateWait("2026-12-01", null);
    expect(unscheduled.liveness.waitLive).toBe(false);
    expect(unscheduled.liveness.stalled).toBe(true);
  });

  it("keeps the free-text rule exactly for a report with no typed wait", () => {
    const stalled = assess(input({ binding: binding({ status: status("the vendor") }) }));
    expect(stalled.liveness.waitLive).toBeNull();
    expect(stalled.liveness.stalled).toBe(true);
    const dated = assess(input({ binding: binding({ status: status("the vendor"), requeueUntil: 2_000_000 }) }));
    expect(dated.liveness.stalled).toBe(false);
  });

  it("keeps the idleInActiveStage divergence on the unadjusted idle when a typed wait is live", () => {
    const base = bb266(false);
    const i: AssessmentInput = { ...base, binding: { ...base.binding, wait: { kind: "pull", ref: "acme/web#9" } }, waitedPulls: waited(openPull("acme/web#9")) };
    const a = assess(i);
    // The consumer's idle (idleBase) is true, the typed-wait-adjusted idle is not.
    expect(a.liveness.idleBase).toBe(true);
    expect(a.liveness.idle).toBe(false);
    // The parked-worker surface still compares the consumer's idle.
    expect(compare(i, a).find((x) => x.surface === "idleInActiveStage")).toMatchObject({ old: "idle", new: "parked" });
  });
});

// BB-389: a typed wait may add liveness but never removes it. Each row is one
// healthy wait from the ticket's table that read `waiting, no wake source`
// because a non-live typed wait (or a parked worker) overrode the live source.
// The ticket's five rows all have a typed `external` wait or none at all.
describe("BB-389: a live structured source is never overridden by a typed wait", () => {
  const external: NonNullable<AssessmentInput["binding"]["wait"]> = { kind: "external", ref: "thr_vyvrsvpt9r" };
  const withWait = (over: Partial<AssessmentInput>) => assess(input({ binding: binding({ wait: external }), ...over }));

  it("row 1: an open schedule escalation is live with an external wait", () => {
    const a = withWait({ escalations: [{ status: "open", route: "project" } as never] });
    expect(a.liveness.waitLive).toBe(false);
    expect(a.liveness.live).toBe(true);
    expect(a.liveness.stalled).toBe(false);
  });

  it("row 2: a parked worker is live with an external wait", () => {
    const a = withWait({ workers: [parkedWorker()] });
    expect(a.liveness.live).toBe(true);
    expect(a.liveness.stalled).toBe(false);
  });

  const watchedPull = (): Partial<AssessmentInput> => {
    const pr = pull({ key: "acme/web#7", url: "https://github.com/acme/web/pull/7", state: "open" });
    return { observed: { entity: issue({ state: "In Progress" }), pulls: [pr] }, ownPulls: own(pr), gatePulls: own(pr), decisions: new Map([[pr.key.toLowerCase(), "user" as const]]) };
  };

  it("row 3: a pull-request watch is live with an external wait (checks on the PR)", () => {
    const a = withWait(watchedPull());
    expect(a.liveness.stalled).toBe(false);
  });

  it("row 4: the reviewer's pull-request watch is live with an external wait (a stored reviewer thread)", () => {
    const a = withWait(watchedPull());
    expect(a.liveness.stalled).toBe(false);
  });

  it("row 5: an open approval escalation and approve-pr need are live with an external wait", () => {
    const a = withWait({ escalations: [{ status: "open", route: "project" } as never], needs: [{} as never] });
    expect(a.liveness.stalled).toBe(false);
  });

  // The BB-154 true positive is unchanged: a free-text or `external` wait with
  // no live source still flags.
  it("still flags a non-live external wait with no structured source", () => {
    const a = withWait({});
    expect(a.liveness.waitLive).toBe(false);
    expect(a.liveness.live).toBe(false);
    expect(a.liveness.stalled).toBe(true);
    const freeText = assess(input({ binding: binding({ status: status("the vendor") }) }));
    expect(freeText.liveness.stalled).toBe(true);
  });
});

// BB-351: the per-kind wait budget. `overdue` is true only when the stored
// wait is live, its kind has a budget, and `now - waitSince` exceeds it.
describe("the shadow assessment: the wait budget (BB-351)", () => {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  const now = 100 * DAY;
  const openPull = (key: string) => pull({ key, url: `https://github.com/${key.split("#")[0]}/pull/${key.split("#")[1]}`, state: "open" });
  const withWait = (wait: NonNullable<AssessmentInput["binding"]["wait"]>, since: number, over: Partial<AssessmentInput> = {}) => input({ now, binding: binding({ wait, waitSince: since }), ...over });

  it("reads overdue for each kind with its default budget, and not within it", () => {
    const open = openPull("acme/web#9");
    const waited = new Map([[open.key.toLowerCase(), open]]);
    // review: one calendar day (no project calendar exists).
    expect(assess(withWait({ kind: "review", ref: "acme/web#9" }, now - DAY - 1, { waitedPulls: waited })).liveness.overdue).toBe(true);
    expect(assess(withWait({ kind: "review", ref: "acme/web#9" }, now - DAY + 1, { waitedPulls: waited })).liveness.overdue).toBe(false);
    // pull: one hour.
    expect(assess(withWait({ kind: "pull", ref: "acme/web#9" }, now - HOUR - 1, { waitedPulls: waited })).liveness.overdue).toBe(true);
    expect(assess(withWait({ kind: "pull", ref: "acme/web#9" }, now - HOUR + 1, { waitedPulls: waited })).liveness.overdue).toBe(false);
    // deployment: two hours, live while its watch is merged or deploying.
    const watch = { key: "acme/web#9", state: "deploying" as const, mergeSha: null, target: "", mergedAt: null, prRepo: "acme/web", files: [], repo: "acme/web", environment: "production", deploymentId: null, deploymentState: null, ref: null, sha: null, url: null, at: 1, deadlineAt: null, note: null, workflowRuns: [] };
    expect(assess(withWait({ kind: "deployment", ref: "acme/web#9" }, now - 2 * HOUR - 1, { binding: binding({ wait: { kind: "deployment", ref: "acme/web#9" }, waitSince: now - 2 * HOUR - 1, deployments: { "acme/web#9": watch } }) })).liveness.overdue).toBe(true);
    // person: one calendar day, live while its page item is open.
    expect(assess(withWait({ kind: "person", ref: "need_1" }, now - DAY - 1, { hasOpenItem: () => true })).liveness.overdue).toBe(true);
    // worker/binding/date/external have no time budget.
    expect(assess(withWait({ kind: "worker", ref: "thr_w1" }, now - 10 * DAY, { workers: [{ threadId: "thr_w1", status: "running" } as never] })).liveness.overdue).toBe(false);
    expect(assess(withWait({ kind: "binding", ref: "ENG-13" }, now - 10 * DAY, { hasOpenBinding: () => true })).liveness.overdue).toBe(false);
    expect(assess(withWait({ kind: "external", ref: "the vendor" }, now - 10 * DAY)).liveness.overdue).toBe(false);
  });

  it("honours a project.json override and a kind turned off with null", () => {
    const open = openPull("acme/web#9");
    const waited = new Map([[open.key.toLowerCase(), open]]);
    const overridden = withWait({ kind: "review", ref: "acme/web#9" }, now - DAY - 1, { waitedPulls: waited, waitBudgets: { review: 3 * DAY } });
    expect(assess(overridden).liveness.overdue).toBe(false);
    const off = withWait({ kind: "review", ref: "acme/web#9" }, now - 10 * DAY, { waitedPulls: waited, waitBudgets: { review: null } });
    expect(assess(off).liveness.overdue).toBe(false);
  });

  it("never reads a date wait overdue before its date, and not at all after it", () => {
    // The date is ahead: the wait is live but has no time budget.
    const ahead = assess(input({ now, binding: binding({ wait: { kind: "date", ref: "2026-12-01" }, waitSince: now - 10 * DAY, requeueUntil: now + DAY }) }));
    expect(ahead.liveness.waitLive).toBe(true);
    expect(ahead.liveness.overdue).toBe(false);
    // The date has passed: the wait is not live, so it cannot be overdue.
    const past = assess(input({ now, binding: binding({ wait: { kind: "date", ref: "2026-12-01" }, waitSince: now - 10 * DAY, requeueUntil: now - DAY }) }));
    expect(past.liveness.waitLive).toBe(false);
    expect(past.liveness.overdue).toBe(false);
  });

  it("is false while the wait is not live, however old it is", () => {
    const merged = pull({ key: "acme/web#9", url: "https://github.com/acme/web/pull/9", state: "merged" }, { merged: true });
    const i = withWait({ kind: "review", ref: "acme/web#9" }, now - 10 * DAY, { waitedPulls: new Map([[merged.key.toLowerCase(), merged]]) });
    expect(assess(i).liveness.waitLive).toBe(false);
    expect(assess(i).liveness.overdue).toBe(false);
    // A closed page item, likewise.
    expect(assess(withWait({ kind: "person", ref: "need_1" }, now - 10 * DAY, { hasOpenItem: () => false })).liveness.overdue).toBe(false);
  });

  it("reads a changed wait as fresh: a new kind or ref resets the clock", () => {
    const open = openPull("acme/web#9");
    const waited = new Map([[open.key.toLowerCase(), open]]);
    // The old wait's start is far past the budget, so a changed wait reported
    // now carries a fresh `waitSince` and is not overdue.
    const changed = withWait({ kind: "pull", ref: "acme/web#9" }, now - 1, { waitedPulls: waited });
    expect(assess(changed).liveness.overdue).toBe(false);
    // waitOverdueMs is the one derivation: the same wait and start is overdue.
    expect(waitOverdueMs({ kind: "pull", ref: "acme/web#9" }, now - HOUR - 1, {}, now)).toBe(HOUR + 1);
    expect(waitOverdueMs({ kind: "pull", ref: "acme/web#9" }, now - 1, {}, now)).toBeNull();
  });
});

describe("the typed-wait divergence store (BB-333)", () => {
  function store() {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.exec(sql);
    let now = 1_000;
    const s = createStore(db, () => now);
    return { s, advance: (ms: number) => (now += ms) };
  }

  it("writes a noWakeSource row only when the disagreement starts", () => {
    const { s } = store();
    // The first observation disagrees: a start row.
    expect(s.recordWaitDivergence({ bindingId: "b1", derived: true, reported: false, waitKind: "external", waitLive: false, inputs: {} }, 1_000)).toBe(true);
    // The same disagreement again: no new row, but the open row is kept fresh.
    expect(s.recordWaitDivergence({ bindingId: "b1", derived: true, reported: false, waitKind: "external", waitLive: false, inputs: {} }, 2_000)).toBe(false);
    let rows = s.divergences({ bindingId: "b1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ old: "source-or-no-wait", new: "no-wake-source", firstSeenAt: 1_000, lastSeenAt: 2_000, count: 1 });
    expect(rows[0]!.inputs).toMatchObject({ transition: "ongoing" });
    // It stops disagreeing: noted on the same row, never a row of its own.
    expect(s.recordWaitDivergence({ bindingId: "b1", derived: false, reported: false, waitKind: null, waitLive: false, inputs: {} }, 3_000)).toBe(false);
    rows = s.divergences({ bindingId: "b1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputs).toMatchObject({ transition: "stop" });
    // It starts again: the same (old, new) row bumps its count rather than adding a row.
    expect(s.recordWaitDivergence({ bindingId: "b1", derived: true, reported: false, waitKind: "external", waitLive: false, inputs: {} }, 4_000)).toBe(true);
    rows = s.divergences({ bindingId: "b1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
    // The surface filter still reads it as `noWakeSource`.
    expect(s.divergences({ surface: "waitStall" })).toHaveLength(1);
    // A first observation that agrees is a baseline, not a transition.
    expect(s.recordWaitDivergence({ bindingId: "b2", derived: false, reported: false, waitKind: null, waitLive: false, inputs: {} }, 5_000)).toBe(false);
    expect(s.divergences({ bindingId: "b2" })).toHaveLength(0);
  });

  it("keeps a stopped row's own wait kind and liveness, only flipping its transition", () => {
    const { s } = store();
    // A worker disagreement: the worker was between turns, so the typed
    // derivation stalled while the stored flag said live.
    s.recordWaitDivergence({ bindingId: "b1", derived: true, reported: false, waitKind: "worker", waitLive: false, inputs: { hasWait: false } }, 1_000);
    // It stops disagreeing while the current fields say the worker is running
    // (waitLive true). The stopped row must keep the disagreement's own
    // `waitKind`/`waitLive`, never the current ones, or it reads as a live
    // worker stalling.
    s.recordWaitDivergence({ bindingId: "b1", derived: false, reported: false, waitKind: "worker", waitLive: true, inputs: { hasWait: true } }, 2_000);
    const rows = s.divergences({ bindingId: "b1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputs).toMatchObject({ waitKind: "worker", waitLive: false, hasWait: false, transition: "stop" });
  });

  it("keeps the two directions' rows apart and treats a flip as a stop plus a start", () => {
    const { s } = store();
    // start A, stop A, start B, ongoing B.
    expect(s.recordWaitDivergence({ bindingId: "b1", derived: true, reported: false, waitKind: "external", waitLive: false, inputs: {} }, 1_000)).toBe(true);
    expect(s.recordWaitDivergence({ bindingId: "b1", derived: false, reported: false, waitKind: null, waitLive: false, inputs: {} }, 2_000)).toBe(false);
    expect(s.recordWaitDivergence({ bindingId: "b1", derived: false, reported: true, waitKind: "pull", waitLive: true, inputs: {} }, 3_000)).toBe(true);
    expect(s.recordWaitDivergence({ bindingId: "b1", derived: false, reported: true, waitKind: "pull", waitLive: true, inputs: {} }, 4_000)).toBe(false);
    let rows = s.divergences({ bindingId: "b1" });
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.new === "no-wake-source")!;
    const b = rows.find((r) => r.old === "no-wake-source")!;
    // The stop touched A, and ongoing B did not touch A again.
    expect(a.inputs).toMatchObject({ transition: "stop" });
    expect(a.lastSeenAt).toBe(2_000);
    expect(b.inputs).toMatchObject({ transition: "ongoing" });
    expect(b.lastSeenAt).toBe(4_000);
    // A flip B → A is a stop on B plus a start on A (bumping A's count).
    expect(s.recordWaitDivergence({ bindingId: "b1", derived: true, reported: false, waitKind: "external", waitLive: false, inputs: {} }, 5_000)).toBe(true);
    rows = s.divergences({ bindingId: "b1" });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.new === "no-wake-source")!.count).toBe(2);
    expect(rows.find((r) => r.old === "no-wake-source")!.inputs).toMatchObject({ transition: "stop" });
  });

  it("reads the state table for the wait-divergences command, joining the log", () => {
    const { s } = store();
    // A start, then a flip to the other direction: the state points at the
    // second row, so the reader must prefer the active direction, not the
    // newest row by time (both were touched at the flip).
    s.recordWaitDivergence({ bindingId: "b1", derived: true, reported: false, waitKind: "external", waitLive: false, inputs: {} }, 1_000);
    s.recordWaitDivergence({ bindingId: "b1", derived: false, reported: true, waitKind: "pull", waitLive: true, inputs: {} }, 2_000);
    // A first observation that agrees: a state row with no divergence row.
    s.recordWaitDivergence({ bindingId: "b2", derived: false, reported: false, waitKind: null, waitLive: false, inputs: {} }, 3_000);
    const rows = s.waitDivergences();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.bindingId === "b1")).toEqual({ bindingId: "b1", derived: false, reported: true, kind: "pull", firstSeenAt: 2_000, lastSeenAt: 2_000, count: 1, at: 2_000 });
    expect(rows.find((r) => r.bindingId === "b2")).toEqual({ bindingId: "b2", derived: false, reported: false, kind: null, firstSeenAt: null, lastSeenAt: null, count: 0, at: 3_000 });
    // A stopped divergence keeps its most recent row for the seen window, and
    // that row keeps the wait kind it disagreed about, not the current one.
    s.recordWaitDivergence({ bindingId: "b1", derived: false, reported: false, waitKind: null, waitLive: false, inputs: {} }, 4_000);
    expect(s.waitDivergences({ bindingId: "b1" })).toEqual([{ bindingId: "b1", derived: false, reported: false, kind: "pull", firstSeenAt: 2_000, lastSeenAt: 4_000, count: 1, at: 4_000 }]);
  });
});
