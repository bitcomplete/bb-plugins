// BB-414 (criterion 4 of BB-291): the one derived-stall helper every surface
// reads. For a typed wait the answer is the assessment's own derivation
// (`liveness.stalled`, recomputed on every reconcile), so each wait kind is
// exercised live and stalled through `assess`; the untyped free-text rule and
// the ops rule keep today's `observedStall` computed on read, with the stored
// assessment's composed `live` source.
import { describe, expect, it } from "vitest";
import { assess, type AssessmentInput } from "./assessment.js";
import { parsePlaybook, type Playbook } from "./config.js";
import { issue, parkedWorker, pull } from "./fixtures.js";
import { derivedStalled, observedStall } from "./reconcile.js";
import { readyStateSchema, type StatusRecord } from "./store.js";
import { LINEAR_TICKETS } from "./templates.js";
import type { EntitySnapshot } from "./source-contract.js";
import type { Wait } from "./wait.js";

const tickets: Playbook = (() => {
  const p = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
  if (!p.ok) throw new Error(p.error);
  return p.value;
})();

const NOW = 1_000_000;

/** A status record with the given free-text wait. */
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
    now: NOW,
    ...over,
  };
}

const openPull = (key: string, over: Partial<NonNullable<EntitySnapshot["pull"]>> = {}): EntitySnapshot => {
  const [repo, number] = key.split("#") as [string, string];
  return pull({ key, url: `https://github.com/${repo}/pull/${number}`, state: "open" }, over);
};
const mergedPull = (key: string): EntitySnapshot => {
  const [repo, number] = key.split("#") as [string, string];
  return pull({ key, url: `https://github.com/${repo}/pull/${number}`, state: "merged" }, { merged: true });
};
const waited = (e: EntitySnapshot) => new Map([[e.key.toLowerCase(), e]]);
const watch = (key: string, state: string) => ({ key, state, mergeSha: null, target: "", mergedAt: null, prRepo: "acme/web", files: [], repo: "acme/web", environment: "production", deploymentId: null, deploymentState: null, ref: null, sha: null, url: null, at: 1, deadlineAt: null, note: null, workflowRuns: [] });

/**
 * The helper's answer for one typed wait: the assessment derives it from the
 * rows, then the helper reads the stored liveness exactly as a surface would.
 */
function stalledFor(wait: Wait, over: Partial<AssessmentInput> = {}): boolean {
  const i = input({ ...over, binding: binding({ ...over.binding, wait }) });
  const a = assess(i);
  return derivedStalled({ ...i.binding, assessedLiveness: a.liveness }, i.now);
}

/** The same, plus the assessment's `waitLive` for the kind's live side. */
function waitLiveFor(wait: Wait, over: Partial<AssessmentInput> = {}): boolean | null {
  return assess(input({ ...over, binding: binding({ ...over.binding, wait }) })).liveness.waitLive;
}

describe("derivedStalled: one answer per typed wait kind (BB-414)", () => {
  it("pull: not stalled while the waited pull is open, stalled once it is merged or unread", () => {
    expect(stalledFor({ kind: "pull", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) })).toBe(false);
    expect(stalledFor({ kind: "pull", ref: "acme/web#9" }, { waitedPulls: waited(mergedPull("acme/web#9")) })).toBe(true);
    expect(stalledFor({ kind: "pull", ref: "acme/web#9" })).toBe(true);
  });

  it("review: not stalled while the pull is open and unreviewed, stalled once reviewed", () => {
    expect(stalledFor({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) })).toBe(false);
    expect(stalledFor({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9", { reviewDecision: "APPROVED" })) })).toBe(true);
  });

  it("deployment: not stalled while its watch is merged or deploying, stalled once settled", () => {
    expect(stalledFor({ kind: "deployment", ref: "acme/web#9" }, { binding: binding({ deployments: { "acme/web#9": watch("acme/web#9", "merged") as never } }) })).toBe(false);
    expect(stalledFor({ kind: "deployment", ref: "acme/web#9" }, { binding: binding({ deployments: { "acme/web#9": watch("acme/web#9", "deployed") as never } }) })).toBe(true);
  });

  it("worker: not stalled while the named worker is running or parked, stalled once plainly finished", () => {
    expect(stalledFor({ kind: "worker", ref: "thr_w1" }, { workers: [{ threadId: "thr_w1", status: "running" } as never] })).toBe(false);
    expect(stalledFor({ kind: "worker", ref: "thr_w1" }, { workers: [parkedWorker({ threadId: "thr_w1" })] })).toBe(false);
    expect(stalledFor({ kind: "worker", ref: "thr_w1" }, { workers: [parkedWorker({ threadId: "thr_w1", parkedWaitingOn: null })] })).toBe(true);
  });

  it("binding: not stalled while the named binding is open, stalled once it is closed", () => {
    expect(stalledFor({ kind: "binding", ref: "ENG-13" }, { hasOpenBinding: () => true })).toBe(false);
    expect(stalledFor({ kind: "binding", ref: "ENG-13" }, { hasOpenBinding: () => false })).toBe(true);
  });

  it("date: not stalled while the scheduled requeue is ahead, stalled once it has passed", () => {
    expect(stalledFor({ kind: "date", ref: "2026-12-01" }, { binding: binding({ requeueUntil: NOW + 86_400_000 }) })).toBe(false);
    expect(stalledFor({ kind: "date", ref: "2026-12-01" }, { binding: binding({ requeueUntil: NOW - 86_400_000 }) })).toBe(true);
  });

  it("person: not stalled while the named page item is open, stalled once it closes", () => {
    expect(stalledFor({ kind: "person", ref: "need_1" }, { hasOpenItem: () => true })).toBe(false);
    expect(stalledFor({ kind: "person", ref: "need_1" }, { hasOpenItem: () => false })).toBe(true);
  });

  it("external: never live, so always stalled", () => {
    expect(waitLiveFor({ kind: "external", ref: "the vendor's reply" })).toBe(false);
    expect(stalledFor({ kind: "external", ref: "the vendor's reply" })).toBe(true);
  });
});

describe("derivedStalled: the untyped free-text rule and the ops rule (BB-414)", () => {
  it("untyped: computes observedStall on read with the stored live source", () => {
    // A free-text wait, no live source, no dated wait: stalled.
    const stalled = { ...binding({ status: status("the vendor") }), assessedLiveness: { stalled: true, live: false } };
    expect(derivedStalled(stalled, NOW)).toBe(true);
    // A live composed source: not stalled, whatever the stored `stalled` said.
    const live = { ...binding({ status: status("the vendor") }), assessedLiveness: { stalled: true, live: true } };
    expect(derivedStalled(live, NOW)).toBe(false);
    // A dated wait still ahead: not stalled.
    const dated = { ...binding({ status: status("the vendor"), requeueUntil: NOW + 86_400_000 }), assessedLiveness: { stalled: true, live: false } };
    expect(derivedStalled(dated, NOW)).toBe(false);
    // No free-text wait at all: not stalled.
    expect(derivedStalled({ ...binding(), assessedLiveness: { stalled: true, live: false } }, NOW)).toBe(false);
  });

  it("ops: reads the liveness the ops reconcile stores, so a live source is not stalled", () => {
    const ops = (over: Partial<AssessmentInput["binding"]> = {}, liveness: { stalled: boolean; live: boolean } | null = null) => ({ ...binding({ kind: "ops", ...over }), assessedLiveness: liveness });
    // The ops reconcile stores the free-text rule's own liveness, so a running
    // worker or an open escalation (live: true) keeps the wait un-stalled.
    expect(derivedStalled(ops({ status: status("the vendor") }, { stalled: false, live: true }), NOW)).toBe(false);
    expect(derivedStalled(ops({ status: status("the vendor") }, { stalled: true, live: false }), NOW)).toBe(true);
    // A brand-new binding with no assessment yet falls back to the free-text
    // rule on read with no live source.
    expect(derivedStalled(ops({ status: status("the vendor") }), NOW)).toBe(true);
    expect(derivedStalled(ops({ status: status("the vendor"), requeueUntil: NOW + 86_400_000 }), NOW)).toBe(false);
    expect(derivedStalled(ops({ status: null }), NOW)).toBe(false);
  });

  it("agrees with observedStall for the untyped and ops paths", () => {
    const b = binding({ status: status("the vendor") });
    expect(derivedStalled({ ...b, assessedLiveness: null }, NOW)).toBe(observedStall(b, false, NOW));
    expect(derivedStalled({ ...b, assessedLiveness: { stalled: false, live: true } }, NOW)).toBe(observedStall(b, true, NOW));
  });
});
