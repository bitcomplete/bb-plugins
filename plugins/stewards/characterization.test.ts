// Characterization tests for BB-292 (child 1 of BB-291): pin what the plugin
// answers TODAY for the merge gate, the worker-busy predicates and the
// liveness / stuck predicates, so the shadow-assessment child can show what
// changes and count retirements. Tests only; no production code is touched and
// no divergence is fixed here.
//
// Each `it` names the predicate, flag or silent branch it pins in its title.
// Where two surfaces answer the same question differently the test asserts
// both answers and carries a `DIVERGENCE:` comment.
//
// The binding-shaped fixtures here (the BB-266 idle/worker fixture) carry a
// parked `finished` worker and a second open own pull request, the BB-291
// working rule, unless the test is about their absence (named in the title).
// The pure `prGate` fixtures take an entity snapshot only — `prGate` reads no
// binding or worker — so the rule applies to the integration fixtures that
// model a binding (server.test.ts) and to the BB-266 fixture below.
import { describe, expect, it } from "vitest";
import { parsePlaybook, type Playbook } from "./config.js";
import { comment, issue, parkedWorker, pull } from "./fixtures.js";
import { approvalMarkerLine, prGate, productReason, type ProjectApprovalRecord } from "./gate.js";
import { gateState } from "./ready-gate.js";
import {
  anyWorkerInFlight,
  gateKnownUnmet,
  idleInActiveStage,
  namesUserAsBlocker,
  productGateOptions,
  runningWorkerReason,
  stuckDue,
  unheardWait,
  workerInFlight,
  workerRunning,
  type IdleBinding,
} from "./reconcile.js";
import { isBusy } from "./sidebar.js";
import { readyStateSchema, type Worker } from "./store.js";
import { LINEAR_TICKETS } from "./templates.js";
import { hasLiveWakeSource, pullWatchCounts, type WakeSourceInput } from "./wake-source.js";
import { workerReportedError, workerWaiting } from "./wake.js";

const tickets: Playbook = (() => {
  const p = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
  if (!p.ok) throw new Error(p.error);
  return p.value;
})();

const head = "aaaaaaa1";
const green = { checks: { state: "success", failing: [] } };
const noReviewMarker = comment({
  id: "m1",
  author: "trotterdylan",
  body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=no-review -->`,
  signedBy: "thr_reviewer",
  createdAt: "2026-10-14T16:00:00Z",
});

/** A gate-met own pull request (no-review, green) plus the reviewer marker. */
const gateMetPull = (key: string, url: string) => pull({ key, url, comments: [noReviewMarker] }, { headSha: head, ...green });
/** A second, not-gate-met own pull request, so the fixture is not about a lone PR. */
const secondOpenPull = (key: string, url: string) => pull({ key, url }, { headSha: "bbbbbbb2" });

// ---------------------------------------------------------------------------
// 1. Merge gate: prGate and the product / decide-list inputs it reads.
// ---------------------------------------------------------------------------

describe("the merge gate: prGate's lane, approval and missing branches", () => {
  const record = (commentId: string, verdict: "approved" | "declined" = "approved"): ProjectApprovalRecord => ({ commentId, verdict });
  const ownerApproval = comment({ id: "oa", author: "jane", body: "LGTM", signedBy: null, createdAt: "2026-10-14T17:00:00Z" });
  const projectMarker = (id: string) => comment({ id, author: "trotterdylan", body: approvalMarkerLine({ sha: head, entry: null, verdict: "approved" }), signedBy: "thr_project", createdAt: "2026-10-14T16:10:00Z" });

  it("pins gateMet true for a no-review marker on green checks, and missing null", () => {
    const g = prGate(pull({ comments: [noReviewMarker] }, green));
    expect(g).toMatchObject({ lane: "no-review", checksGreen: true, gateMet: true, needsOwnerApproval: false, needsProjectApproval: false, missing: null });
  });

  it("pins the silent branch: no marker, a non-approved verdict, and red checks each set missing", () => {
    expect(prGate(pull({ comments: [] })).missing).toBe("no reviewer round yet");
    expect(prGate(pull({ comments: [comment({ id: "m2", author: "jane", body: "<!-- bb-review round=1 sha=aaaaaaa1 verdict=changes-requested lane=no-review -->" })] }, green)).missing).toBe("reviewer verdict: changes-requested");
    expect(prGate(pull({ comments: [noReviewMarker] }, { checks: { state: "pending", failing: [] } })).missing).toBe("checks pending");
    // checks null is read as green by prGate (no check runs, nothing failed).
    expect(prGate(pull({ comments: [noReviewMarker] }, { checks: null })).checksGreen).toBe(true);
  });

  it("pins needsOwnerApproval / needsProjectApproval as the two approval asks, and the owner lane's missing text", () => {
    const ownerLane = pull({ comments: [comment({ id: "m3", author: "trotterdylan", body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=owner-reviewed approver=project -->`, signedBy: "thr_reviewer" })] }, green);
    expect(prGate(ownerLane, { decision: "user" })).toMatchObject({ decision: "user", needsOwnerApproval: true, needsProjectApproval: false, gateMet: false, missing: "owner approval needed" });
    expect(prGate(ownerLane, { decision: "project", projectApprovals: [] })).toMatchObject({ decision: "project", needsProjectApproval: true, needsOwnerApproval: false, missing: "project steward approval needed" });
    expect(prGate(pull({ comments: [ownerLane.comments[0]!, ownerApproval] }, green), { decision: "user" })).toMatchObject({ ownerApproved: true, gateMet: true, missing: null });
  });

  it("pins escalated / reason product: a substantial PR with no approved spec is the owner's, missing names it", () => {
    const g = prGate(pull({ comments: [noReviewMarker] }, green), { substantial: true, decision: "project", projectApprovals: [record("pa1")] });
    expect(g).toMatchObject({ reason: "product", escalated: true, decision: "user", needsOwnerApproval: true, gateMet: false, missing: "owner approval needed (product)" });
    expect(productReason(true, false)).toBe("product");
    expect(productReason(true, true)).toBeNull();
    expect(productReason(false, false)).toBeNull();
    expect(productReason(null, false)).toBeNull();
  });

  it("pins the project-steward approval branch: only a recorded comment id counts, and a project entry is met", () => {
    const marker = projectMarker("pa1");
    const entity = pull({ comments: [comment({ id: "m4", author: "trotterdylan", body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=owner-reviewed approver=project -->`, signedBy: "thr_reviewer" }), marker] }, green);
    expect(prGate(entity, { decision: "project", projectApprovals: [record("pa1")] })).toMatchObject({ projectApproved: true, gateMet: true });
    // The same marker text with an id the store does not hold is a lookalike.
    expect(prGate(entity, { decision: "project", projectApprovals: [record("typed")] })).toMatchObject({ projectApproved: false, gateMet: false, missing: "project steward approval needed" });
  });

  // DIVERGENCE: approvals.ts builds the gate from `prGate(pull,
  // productGateOptions(b, pull))` (recordProjectDecision, approvePrPageAction),
  // which omits the decide mark and the project's recorded approvals; server.ts,
  // wake.ts and `bb stewards gate` pass `decision` and `projectApprovals`. On a
  // project entry whose recorded `bb-approval` is on the pull request the two
  // surfaces answer differently: the full gate is met, the approvals.ts path
  // still asks the owner.
  it("DIVERGENCE: approvals.ts's gate (no decision, no recorded approvals) asks the owner where the full gate is met", () => {
    const marker = projectMarker("pa1");
    const entity = pull({ comments: [comment({ id: "m5", author: "trotterdylan", body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=owner-reviewed approver=project -->`, signedBy: "thr_reviewer" }), marker] }, green);
    const binding = { kind: "review" as const, ready: readyStateSchema.parse({}) };
    const full = prGate(entity, { decision: "project", projectApprovals: [record("pa1")] });
    const approvalsPath = prGate(entity, productGateOptions(binding, entity));
    expect(full).toMatchObject({ decision: "project", gateMet: true, needsOwnerApproval: false });
    // DIVERGENCE: same pull request, same marker, no recorded approvals passed.
    expect(approvalsPath).toMatchObject({ decision: "user", gateMet: false, needsOwnerApproval: true, missing: "owner approval needed" });
  });

  it("pins productGateOptions' inputs: a review binding reads the marker then the report, a ticket binding only the marker", () => {
    const marked = pull({ comments: [comment({ id: "m6", author: "jane", body: `<!-- bb-review round=1 sha=abc verdict=approved lane=no-review substantial=yes spec=yes -->`, createdAt: "2026-10-02T00:00:00Z" })] });
    expect(productGateOptions({ kind: "review", ready: readyStateSchema.parse({ substantial: true }) }, marked)).toEqual({ substantial: true, ticketApprovedSpec: true });
    expect(productGateOptions({ kind: "review", ready: readyStateSchema.parse({ substantial: false }) }, marked)).toEqual({ substantial: true, ticketApprovedSpec: true });
    expect(productGateOptions({ kind: "ticket", ready: readyStateSchema.parse({ substantial: true }) }, marked)).toEqual({ substantial: true, ticketApprovedSpec: false });
    expect(productGateOptions({ kind: "ticket", ready: readyStateSchema.parse({ substantial: true, approval: { at: 1, specHash: "h", by: "user" } }) }, marked)).toEqual({ substantial: true, ticketApprovedSpec: true });
  });

  it("pins gateState and gateKnownUnmet: known-unmet is a missing or stale approval or a reported unmet item", () => {
    const allMet = tickets.ready!.checklist.map((item) => ({ item, met: true }));
    const hash = "h1";
    const approval = { at: 1, specHash: hash, by: "thr_p" };
    expect(gateState(tickets, readyStateSchema.parse({ checklist: allMet }), hash)).toMatchObject({ passed: false, approvalNeeded: true, approved: false });
    expect(gateState(tickets, readyStateSchema.parse({ checklist: allMet, approval }), hash).passed).toBe(true);
    expect(gateState(tickets, readyStateSchema.parse({ checklist: allMet, approval }), "changed")).toMatchObject({ approvalStale: true, passed: false });
    expect(gateKnownUnmet(tickets, readyStateSchema.parse({ approval }), hash)).toBe(false);
    expect(gateKnownUnmet(tickets, readyStateSchema.parse({ approval }), "changed")).toBe(true);
    expect(gateKnownUnmet(tickets, readyStateSchema.parse({ approval, checklist: [{ ...allMet[0]!, met: false }] }), hash)).toBe(true);
    // An item the steward has not reported does not count as known unmet.
    expect(gateKnownUnmet(tickets, readyStateSchema.parse({ approval }), hash)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Worker-busy predicates and the text rules.
// ---------------------------------------------------------------------------

describe("the worker-busy predicates: workerInFlight vs runningWorkerReason", () => {
  const status = (s: Worker["status"]) => ({ threadId: "thr_w1", status: s });

  it("pins workerInFlight / anyWorkerInFlight as running OR finished (a parked worker is in flight)", () => {
    expect(workerInFlight(status("running"))).toBe(true);
    expect(workerInFlight(status("finished"))).toBe(true);
    expect(workerInFlight(status("failed"))).toBe(false);
    expect(workerInFlight(status("stopped"))).toBe(false);
    expect(anyWorkerInFlight([status("finished")])).toBe(true);
    expect(anyWorkerInFlight([status("stopped")])).toBe(false);
    expect(anyWorkerInFlight([])).toBe(false);
  });

  it("pins workerRunning and runningWorkerReason as running ONLY (a parked worker is not mid-turn)", () => {
    expect(workerRunning(status("running"))).toBe(true);
    expect(workerRunning(status("finished"))).toBe(false);
    expect(runningWorkerReason([status("finished")])).toBeNull();
    expect(runningWorkerReason([status("running")])).toBe("worker thr_w1 is mid-turn");
    expect(runningWorkerReason([status("running"), { threadId: "thr_w2", status: "running" }])).toBe("workers thr_w1, thr_w2 are mid-turn");
  });

  // DIVERGENCE: workerInFlight / anyWorkerInFlight count a parked `finished`
  // worker as busy (the wake quieting and lifecycle surfaces read them), while
  // runningWorkerReason counts only `running` (the plugin merge, BB-266). This
  // is the BB-266 shape: a worker parked "waiting on the owner's approval" is
  // in flight to the wake, and not mid-turn to the merge path.
  it("DIVERGENCE: a parked finished worker is in flight to workerInFlight but not mid-turn to runningWorkerReason (BB-266)", () => {
    const parked = parkedWorker({ result: "Waiting on the owner's approval of acme/web#7." });
    expect(workerInFlight(parked)).toBe(true);
    expect(anyWorkerInFlight([parked])).toBe(true);
    // DIVERGENCE: the same worker, the merge path's answer.
    expect(runningWorkerReason([parked])).toBeNull();
  });

  it("pins isBusy (BUSY) as the host thread's starting/active/stopping, and nothing else", () => {
    expect(["starting", "active", "stopping"].every(isBusy)).toBe(true);
    expect(["idle", "finished", "failed"].some(isBusy)).toBe(false);
  });

  it("pins WAITING: workerWaiting fires on waiting/awaits/awaiting/parked/standing by", () => {
    expect(workerWaiting("Waiting on the reviewer.")).toBe(true);
    expect(workerWaiting("It awaits the owner's approval.")).toBe(true);
    expect(workerWaiting("Parked until the build lands.")).toBe(true);
    expect(workerWaiting("Standing by.")).toBe(true);
    expect(workerWaiting("Done and verified.")).toBe(false);
    expect(workerWaiting(null)).toBe(false);
  });

  it("pins ERROR_REPORT: workerReportedError fires on a line-leading error marker, not a mention", () => {
    expect(workerReportedError("Error: the build refused the push")).toBe(true);
    expect(workerReportedError("Unable to reach GitHub")).toBe(true);
    expect(workerReportedError("I could not merge it")).toBe(true);
    expect(workerReportedError("Fixed the error: the retry now backs off")).toBe(false);
    expect(workerReportedError("No errors here.")).toBe(false);
    expect(workerReportedError(null)).toBe(false);
  });

  it("pins unheardWait: a wait on the project steward or the user with no open escalation or need", () => {
    const status = (waitingOn: string | null) => ({ phase: "In Progress", summary: "s", nextAction: "n", actor: "other" as const, waitingOn, requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: 1 });
    expect(unheardWait(status("the project steward's approval of the new spec"), [])).toMatch(/project steward/u);
    expect(unheardWait(status("the user's answer on scope"), [])).toMatch(/the user/u);
    expect(unheardWait(status("the user's answer"), [{ kind: "approval" } as never])).toBeNull();
    expect(unheardWait(status("Sam's review"), [])).toBeNull();
    expect(unheardWait(status(null), [])).toBeNull();
  });

  it("pins namesUserAsBlocker: user/owner/human as a word, not inside another word", () => {
    expect(namesUserAsBlocker("the user must choose")).toBe(true);
    expect(namesUserAsBlocker("the owner's approval")).toBe(true);
    expect(namesUserAsBlocker("a human review")).toBe(true);
    expect(namesUserAsBlocker("the username is wrong")).toBe(false);
    expect(namesUserAsBlocker("ownerless")).toBe(false);
    expect(namesUserAsBlocker("waiting on the reviewer")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Liveness / stuck predicates, with the BB-266 and bb-plugins#294 shapes.
// ---------------------------------------------------------------------------

describe("the liveness and stuck predicates", () => {
  const noSources: WakeSourceInput = { hold: null, holdBehind: [], mergeBehind: [], holdStack: [], deployments: {}, runningWorkers: 0, openEscalations: 0, openNeeds: 0, pullRequestWatch: false };

  it("pins hasLiveWakeSource: every tracked source, and a free-text wait is not one", () => {
    expect(hasLiveWakeSource(noSources)).toBe(false);
    expect(hasLiveWakeSource({ ...noSources, runningWorkers: 1 })).toBe(true);
    expect(hasLiveWakeSource({ ...noSources, hold: "a freeze", holdBehind: ["ENG-9"] })).toBe(true);
    expect(hasLiveWakeSource({ ...noSources, mergeBehind: ["ENG-9"] })).toBe(true);
    expect(hasLiveWakeSource({ ...noSources, holdStack: ["ENG-9"], hold: "stacked" })).toBe(true);
    expect(hasLiveWakeSource({ ...noSources, deployments: { "acme/web#7": { state: "deploying" } as never } })).toBe(true);
    expect(hasLiveWakeSource({ ...noSources, deployments: { "acme/web#7": { state: "deployed" } as never } })).toBe(false);
    expect(hasLiveWakeSource({ ...noSources, openEscalations: 1 })).toBe(true);
    expect(hasLiveWakeSource({ ...noSources, openNeeds: 1 })).toBe(true);
    expect(hasLiveWakeSource({ ...noSources, pullRequestWatch: true })).toBe(true);
  });

  it("pins pullWatchCounts: a pr/review binding's own open PR is never a source, a ticket's only while gate-unmet (#294)", () => {
    expect(pullWatchCounts("pr", 1, false)).toBe(false);
    expect(pullWatchCounts("review", 1, false)).toBe(false);
    expect(pullWatchCounts("ticket", 1, false)).toBe(true);
    expect(pullWatchCounts("ticket", 1, true)).toBe(false);
    expect(pullWatchCounts("ticket", 0, false)).toBe(false);
  });

  it("pins the bb-plugins#294 shape: a pr binding's own open PR with a free-text wait is not a live source", () => {
    // #294's steward was parked on "the dompurify fix on main" with its own open
    // pull request and no other source; pullWatchCounts is false, so the report
    // path marks the binding noWakeSource.
    const pr = pull({ labels: ["bb-managed"], author: "jane" });
    const ownPulls = 1;
    const source: WakeSourceInput = { ...noSources, pullRequestWatch: pullWatchCounts("pr", ownPulls, false) };
    expect(source.pullRequestWatch).toBe(false);
    expect(hasLiveWakeSource(source)).toBe(false);
    expect(pr.state).toBe("open");
  });

  it("pins stuckDue: the phase limit after advancedAt, once, and null with a phase that has no limit", () => {
    const b = { advancedAt: 0, createdAt: 0, phase: "In Progress" };
    expect(stuckDue(b, tickets, [], 86_400_000)).toBeNull();
    expect(stuckDue(b, tickets, [], 3 * 86_400_000)).toBe(2 * 86_400_000);
    expect(stuckDue({ ...b, phase: "Todo" }, tickets, [], 30 * 86_400_000)).toBeNull();
    expect(stuckDue(b, tickets, [{ kind: "stuck" } as never], 3 * 86_400_000)).toBeNull();
  });

  // BB-266's fixture: a gate-met own pull request, a parked `finished` worker,
  // and a second open own pull request. The idle predicate is not suppressed by
  // the gate-met PR but is by the second one, while the worker predicates
  // disagree about the parked worker.
  const bb266 = (secondOpen: boolean): { binding: IdleBinding; observed: { entity: ReturnType<typeof issue>; pulls: Array<ReturnType<typeof pull>> } } => {
    const ownPulls = new Set(["acme/web#7", "https://github.com/acme/web/pull/7", "acme/web#8", "https://github.com/acme/web/pull/8"]);
    const pulls = secondOpen ? [gateMetPull("acme/web#7", "https://github.com/acme/web/pull/7"), secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8")] : [gateMetPull("acme/web#7", "https://github.com/acme/web/pull/7")];
    return {
      binding: {
        stage: "build",
        ending: null,
        hold: null,
        deployments: {},
        requeueUntil: null,
        workers: [parkedWorker({ result: "Waiting on the owner's approval of acme/web#7." })],
        ownPulls,
        gateMetPulls: new Set(["acme/web#7"]),
        escalations: [],
        needs: [],
      },
      observed: { entity: issue({ state: "In Progress" }), pulls },
    };
  };

  it("pins idleInActiveStage: false while a second open own PR waits, true when only the gate-met own PR is open (BB-266)", () => {
    const withSecond = bb266(true);
    const onlyGateMet = bb266(false);
    expect(idleInActiveStage(withSecond.binding, withSecond.observed)).toBe(false);
    // The parked worker is not running, so it does not suppress idle; the
    // gate-met PR does not either (BB-285).
    expect(idleInActiveStage(onlyGateMet.binding, onlyGateMet.observed)).toBe(true);
    // A `running` worker does suppress idle.
    expect(idleInActiveStage({ ...onlyGateMet.binding, workers: [{ status: "running" }] }, onlyGateMet.observed)).toBe(false);
  });

  // DIVERGENCE: the same BB-266 fixture, three surfaces. `workerInFlight`
  // (wake quieting, lifecycle) says the parked worker is busy; `idleInActiveStage`
  // (BB-83) says the binding is idle when the only open own PR is gate-met;
  // `runningWorkerReason` (the merge path) says nobody is mid-turn. The parked
  // worker is simultaneously busy, idle and free.
  it("DIVERGENCE: BB-266's parked worker is in flight, idle and not mid-turn at once", () => {
    const { binding } = bb266(false);
    expect(workerInFlight(binding.workers[0]!)).toBe(true);
    // DIVERGENCE: idleInActiveStage ignores the parked worker.
    expect(idleInActiveStage(binding, bb266(false).observed)).toBe(true);
    // DIVERGENCE: runningWorkerReason ignores the parked worker.
    expect(runningWorkerReason(binding.workers as Array<{ threadId: string; status: Worker["status"] }>)).toBeNull();
  });
});
