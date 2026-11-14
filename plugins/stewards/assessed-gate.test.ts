// BB-322 (child of BB-291, criterion 1): the single read/refresh of the stored
// merge-gate assessment. These fixtures cover the cases the ticket names:
// project-mark approved, the owner's unsigned approval on a project-placed pull
// (BB-321), a declined reviewer marker, null/empty changed files, and a stale
// assessment after a head sha change. Each gate-met fixture carries a parked
// `finished` worker and a second open own pull request (the BB-291 rule).
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { assess, type AssessmentInput } from "./assessment.js";
import { assessedGate, assessedPullGate } from "./assessed-gate.js";
import { parsePlaybook, type Playbook } from "./config.js";
import { comment, issue, parkedWorker, pull } from "./fixtures.js";
import { approvalMarkerLine, type PrGate } from "./gate.js";
import type { BigDecision } from "./decisions.js";
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
const noSources: WakeSourceInput = { hold: null, holdBehind: [], mergeBehind: [], holdStack: [], deployments: {}, runningWorkers: 0, openEscalations: 0, openNeeds: 0, pullRequestWatch: false };

const noReviewMarker = comment({ id: "m1", author: "trotterdylan", body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=no-review -->`, signedBy: "thr_reviewer", createdAt: "2026-10-14T16:00:00Z" });
const ownerMarker = comment({ id: "m2", author: "trotterdylan", body: `<!-- bb-review round=1 sha=${head} verdict=approved lane=owner-reviewed approver=project -->`, signedBy: "thr_reviewer", createdAt: "2026-10-14T16:00:00Z" });
const declinedMarker = comment({ id: "m3", author: "trotterdylan", body: `<!-- bb-review round=1 sha=${head} verdict=changes-requested lane=owner-reviewed -->`, signedBy: "thr_reviewer", createdAt: "2026-10-14T16:00:00Z" });
const projectApprovalMarker = (id: string) => comment({ id, author: "trotterdylan", body: approvalMarkerLine({ sha: head, entry: null, verdict: "approved" }), signedBy: "thr_project", createdAt: "2026-10-14T16:10:00Z" });
const ownerUnsignedApproval = comment({ id: "oa", author: "jane", body: `Approved ${head} from the Stewards page`, signedBy: null, createdAt: "2026-10-14T17:00:00Z" });

/** A gate-met own pull request plus the second open own pull request the rule requires. */
const gateMetPull = (key: string, url: string) => pull({ key, url, comments: [noReviewMarker] }, { headSha: head, ...green });
const secondOpenPull = (key: string, url: string) => pull({ key, url }, { headSha: "bbbbbbb2" });
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

/** An in-memory store with the assessment tables, as `assessment.test.ts` builds one. */
function store() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const s = createStore(db, () => 1_000_000);
  const b = s.create({
    projectId: "p1",
    source: "linear",
    entityId: "uuid-12",
    entityKey: "ENG-12",
    url: null,
    title: "Fix login",
    kind: "ticket",
    playbook: "linear-tickets",
    playbookVersion: "v1",
    parentBindingId: null,
    phase: "In Progress",
    stage: "build",
  });
  return { s, b };
}

/** Store the assessment for a fixture, so `assessedGate` has a copy to read. */
function storeAssessment(s: ReturnType<typeof store>["s"], i: AssessmentInput): void {
  const a = assess(i);
  s.recordAssessment({ bindingId: i.binding.id, at: i.now, gate: a.gate, worker: a.worker, liveness: a.liveness });
}

describe("the single stored-gate read (BB-322)", () => {
  it("reads the stored gate when it is current, and computes and stores it when it is missing", () => {
    const { s, b } = store();
    const first = gateMetPull("acme/web#7", "https://github.com/acme/web/pull/7");
    const second = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
    const i = input({
      binding: binding({ id: b.id }),
      observed: { entity: issue({ state: "In Progress" }), pulls: [first, second] },
      ownPulls: own(first, second),
      decisions: new Map([
        ["acme/web#7", "user"],
        ["acme/web#8", "user"],
      ]),
      workers: [parkedWorker()],
    });
    // No stored assessment yet: the read computes and stores one.
    expect(s.assessment(b.id)).toBeNull();
    const g = assessedGate(s, b, first, i.now);
    expect(g).toMatchObject({ gateMet: true, lane: "no-review" });
    expect(s.assessment(b.id)).not.toBeNull();
    // The second read returns the stored copy, not a fresh computation.
    expect(assessedGate(s, b, first, i.now + 1)).toMatchObject({ gateMet: true, lane: "no-review" });
  });

  it("recomputes for the pull's current head sha and never returns a stale met gate", () => {
    const { s, b } = store();
    const first = gateMetPull("acme/web#7", "https://github.com/acme/web/pull/7");
    const second = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
    const i = input({
      binding: binding({ id: b.id }),
      observed: { entity: issue({ state: "In Progress" }), pulls: [first, second] },
      ownPulls: own(first, second),
      decisions: new Map([
        ["acme/web#7", "user"],
        ["acme/web#8", "user"],
      ]),
      workers: [parkedWorker()],
    });
    storeAssessment(s, i);
    expect(assessedGate(s, b, first, i.now)).toMatchObject({ gateMet: true });
    // The head moves and its checks are still pending: the stored met answer is
    // stale and must not count.
    const moved = pull({ key: "acme/web#7", url: "https://github.com/acme/web/pull/7", comments: [noReviewMarker] }, { headSha: "ccccccc3", checks: { state: "pending", failing: [] } });
    expect(assessedGate(s, b, moved, i.now + 1)).toMatchObject({ gateMet: false, headSha: "ccccccc3" });
  });

  // BB-322 owner review: a push can add a file that moves the pull from the
  // project steward's lane to the owner's. The stored mark must not survive the
  // head move, or a recorded project approval would let a merge path act on a
  // change the owner should approve.
  it("re-derives the decide mark from the changed files when the head moves", () => {
    const { s, b } = store();
    const decisions: BigDecision[] = [
      { text: "A user entry", decide: "user", paths: ["bb-gate/hooks/hooks.go"] },
      { text: "A project entry", decide: "project", paths: ["bb-gate/docs/hooks.md"] },
    ];
    const entity = pull({ key: "acme/web#7", url: "https://github.com/acme/web/pull/7", comments: [ownerMarker, projectApprovalMarker("pa1")] }, { headSha: head, ...green, files: ["bb-gate/docs/hooks.md"] });
    s.recordProjectApproval({ bindingId: b.id, headSha: head, entry: null, byThread: "thr_project", commentId: "pa1", verdict: "approved" });
    const i = input({
      binding: binding({ id: b.id, kind: "review" }),
      observed: { entity: issue({ state: "In Progress" }), pulls: [entity] },
      ownPulls: own(entity),
      decisions: new Map([["acme/web#7", "project"]]),
      projectApprovals: s.projectApprovals(b.id),
      workers: [parkedWorker()],
    });
    storeAssessment(s, i);
    expect(assessedGate(s, b, entity, i.now, decisions)).toMatchObject({ gateMet: true, decision: "project" });
    // The head moves and the changed files now match a `user` entry: the mark
    // is re-derived, the recorded project approval no longer counts, and the
    // gate is not met.
    const moved = pull({ key: "acme/web#7", url: "https://github.com/acme/web/pull/7", comments: [ownerMarker, projectApprovalMarker("pa1")] }, { headSha: "ccccccc3", ...green, files: ["bb-gate/hooks/hooks.go"] });
    expect(assessedGate(s, b, moved, i.now + 1, decisions)).toMatchObject({ gateMet: false, decision: "user" });
  });

  it("covers a project-mark approved pull, with a parked worker and a second open own pull", () => {
    const { s, b } = store();
    const entity = pull({ key: "acme/web#7", url: "https://github.com/acme/web/pull/7", comments: [ownerMarker, projectApprovalMarker("pa1")] }, { headSha: head, ...green });
    const second = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
    const i = input({
      binding: binding({ id: b.id, kind: "review" }),
      observed: { entity: issue({ state: "In Progress" }), pulls: [entity, second] },
      ownPulls: own(entity, second),
      decisions: new Map([
        ["acme/web#7", "project"],
        ["acme/web#8", "user"],
      ]),
      projectApprovals: [],
      workers: [parkedWorker()],
    });
    s.recordProjectApproval({ bindingId: b.id, headSha: head, entry: null, byThread: "thr_project", commentId: "pa1", verdict: "approved" });
    i.projectApprovals = s.projectApprovals(b.id);
    storeAssessment(s, i);
    expect(assessedGate(s, b, entity, i.now)).toMatchObject({ gateMet: true, decision: "project", projectApproved: true, lane: "owner-reviewed" });
  });

  it("covers the owner's unsigned approval on a project-placed pull (BB-321), with a parked worker and a second open own pull", () => {
    const { s, b } = store();
    const entity = pull({ key: "acme/web#7", url: "https://github.com/acme/web/pull/7", comments: [ownerMarker, ownerUnsignedApproval] }, { headSha: head, ...green });
    const second = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
    const i = input({
      binding: binding({ id: b.id, kind: "review" }),
      observed: { entity: issue({ state: "In Progress" }), pulls: [entity, second] },
      ownPulls: own(entity, second),
      decisions: new Map([
        ["acme/web#7", "project"],
        ["acme/web#8", "user"],
      ]),
      projectApprovals: [{ commentId: "pa-other", verdict: "approved" }],
      workers: [parkedWorker()],
    });
    storeAssessment(s, i);
    expect(assessedGate(s, b, entity, i.now)).toMatchObject({ gateMet: true, decision: "user", ownerApproved: true, projectApproved: false });
  });

  it("covers a declined reviewer marker, with a parked worker and a second open own pull", () => {
    const { s, b } = store();
    const entity = pull({ key: "acme/web#7", url: "https://github.com/acme/web/pull/7", comments: [declinedMarker] }, { headSha: head, ...green });
    const second = secondOpenPull("acme/web#8", "https://github.com/acme/web/pull/8");
    const i = input({
      binding: binding({ id: b.id }),
      observed: { entity: issue({ state: "In Progress" }), pulls: [entity, second] },
      ownPulls: own(entity, second),
      decisions: new Map([
        ["acme/web#7", "user"],
        ["acme/web#8", "user"],
      ]),
      workers: [parkedWorker()],
    });
    storeAssessment(s, i);
    const g: PrGate = assessedGate(s, b, entity, i.now);
    expect(g.gateMet).toBe(false);
    expect(g.missing).toContain("changes-requested");
  });

  it("treats null/empty changed files as the user's, fail closed", () => {
    const entity = pull({ comments: [ownerMarker] }, { headSha: head, ...green, files: [] });
    expect(assessedPullGate(binding(), entity, "user", []).decision).toBe("user");
    // `assessedGate`'s refresh has no decide list, so a never-assessed pull
    // defaults to the owner's mark whatever its files; the gate is not met
    // without the owner's approval.
    const { s, b } = store();
    expect(assessedGate(s, b, entity, 1_000_000)).toMatchObject({ gateMet: false, decision: "user", needsOwnerApproval: true });
  });

  it("keeps a dated wait from being read as a stall in the stored assessment it writes", () => {
    // A small guard that the refresh writes the whole gate shape, not only the
    // pull it was asked about.
    const { s, b } = store();
    const entity = gateMetPull("acme/web#7", "https://github.com/acme/web/pull/7");
    const i = input({ binding: binding({ id: b.id, status: status("the vendor's reply"), requeueUntil: 2_000_000 }), observed: { entity: issue(), pulls: [entity] }, ownPulls: own(entity), decisions: new Map([["acme/web#7", "user"]]) });
    storeAssessment(s, i);
    assessedGate(s, b, entity, i.now);
    const stored = s.assessment(b.id)!.gate as { pulls: Array<{ pull: string; met: boolean }> };
    expect(stored.pulls).toHaveLength(1);
    expect(stored.pulls[0]).toMatchObject({ pull: "acme/web#7", met: true });
  });
});
