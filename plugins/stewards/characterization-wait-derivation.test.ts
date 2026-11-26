// BB-377 (criterion 2 of the ticket, slice C1 of BB-291): the typed-wait
// derivation, pinned for every wait kind and every branch. `typedWaitLive` and
// `waitFingerprint` are private to `assessment.ts`, so they are read through
// the assessment's `liveness.waitLive` and `liveness.waited`; `observedStall`
// is a public predicate and is called directly. This is a characterization
// test: no production code is touched, no divergence is fixed.
//
// Each `it` names the predicate, kind or branch it pins in its title. Where two
// surfaces answer the same question differently the test asserts both answers
// and carries a `DIVERGENCE:` comment.
import { describe, expect, it } from "vitest";
import { assess, type AssessmentInput } from "./assessment.js";
import { parsePlaybook, type Playbook } from "./config.js";
import { issue, parkedWorker, pull } from "./fixtures.js";
import { observedStall } from "./reconcile.js";
import { readyStateSchema, type StatusRecord } from "./store.js";
import { LINEAR_TICKETS } from "./templates.js";
import type { EntitySnapshot } from "./source-contract.js";
import type { Wait } from "./wait.js";

const tickets: Playbook = (() => {
  const p = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
  if (!p.ok) throw new Error(p.error);
  return p.value;
})();


/** A second open own pull request, so the binding-shaped fixture is not a lone PR (BB-291). */
const secondOpenPull = pull({ key: "acme/web#8", url: "https://github.com/acme/web/pull/8" }, { headSha: "bbbbbbb2" });
const own = (e: EntitySnapshot): Set<string> => new Set([e.key.toLowerCase(), (e.url ?? "").toLowerCase()]);

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
    // The binding-shaped fixture carries a parked `finished` worker and a
    // second open own pull request (the BB-291 working rule); the wait kind is
    // judged independently of both.
    observed: { entity: issue({ state: "In Progress" }), pulls: [secondOpenPull] },
    ownPulls: own(secondOpenPull),
    decisions: new Map(),
    projectApprovals: [],
    workers: [parkedWorker()],
    escalations: [],
    needs: [],
    playbook: tickets,
    currentSpecHash: "",
    now: 1_000_000,
    ...over,
  };
}

/** A status record with the given free-text wait. */
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

/** A deployment watch in the given state, as the store holds it. */
const watch = (key: string, state: string) => ({ key, state, mergeSha: null, target: "", mergedAt: null, prRepo: "acme/web", files: [], repo: "acme/web", environment: "production", deploymentId: null, deploymentState: null, ref: null, sha: null, url: null, at: 1, deadlineAt: null, note: null, workflowRuns: [] });

/** The `waitLive` the assessment derives for one stored wait and its rows. */
const waitLive = (wait: Wait, over: Partial<AssessmentInput> = {}): boolean | null => {
  const { binding: b, ...rest } = over;
  return assess(input({ ...rest, binding: binding({ ...b, wait }) })).liveness.waitLive;
};

/** The `waited` fingerprint the assessment derives for one stored wait and its rows. */
const fingerprint = (wait: Wait | null, over: Partial<AssessmentInput> = {}): string | null => assess(input({ binding: binding({ wait }), ...over })).liveness.waited;

// ---------------------------------------------------------------------------
// typedWaitLive: every kind, live and not live.
// ---------------------------------------------------------------------------

describe("typedWaitLive: the pull and review kinds", () => {
  it("pull: live only while the freshly read pull is open", () => {
    expect(waitLive({ kind: "pull", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) })).toBe(true);
    expect(waitLive({ kind: "pull", ref: "acme/web#9" }, { waitedPulls: waited(mergedPull("acme/web#9")) })).toBe(false);
    // Not read at all is not live.
    expect(waitLive({ kind: "pull", ref: "acme/web#9" })).toBe(false);
  });

  it("review: live while the pull is open and unreviewed, not live once reviewed or merged", () => {
    expect(waitLive({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) })).toBe(true);
    expect(waitLive({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9", { reviewDecision: "APPROVED" })) })).toBe(false);
    expect(waitLive({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(mergedPull("acme/web#9")) })).toBe(false);
    expect(waitLive({ kind: "review", ref: "acme/web#9" })).toBe(false);
  });
});

describe("typedWaitLive: the deployment, worker, binding and person kinds", () => {
  it("deployment: live while its watch is merged or deploying, not otherwise", () => {
    expect(waitLive({ kind: "deployment", ref: "acme/web#9" }, { binding: binding({ deployments: { "acme/web#9": watch("acme/web#9", "merged") as never } }) })).toBe(true);
    expect(waitLive({ kind: "deployment", ref: "acme/web#9" }, { binding: binding({ deployments: { "acme/web#9": watch("acme/web#9", "deploying") as never } }) })).toBe(true);
    expect(waitLive({ kind: "deployment", ref: "acme/web#9" }, { binding: binding({ deployments: { "acme/web#9": watch("acme/web#9", "deployed") as never } }) })).toBe(false);
    // No watch for the ref is not live.
    expect(waitLive({ kind: "deployment", ref: "acme/web#9" })).toBe(false);
  });

  it("worker: live while the named worker is running or parked (BB-389), not once plainly finished", () => {
    expect(waitLive({ kind: "worker", ref: "thr_w1" }, { workers: [{ threadId: "thr_w1", status: "running" } as never] })).toBe(true);
    expect(waitLive({ kind: "worker", ref: "thr_w1" }, { workers: [parkedWorker({ threadId: "thr_w1" })] })).toBe(true);
    expect(waitLive({ kind: "worker", ref: "thr_w1" }, { workers: [parkedWorker({ threadId: "thr_w1", parkedWaitingOn: null })] })).toBe(false);
    expect(waitLive({ kind: "worker", ref: "thr_w1" })).toBe(false);
  });

  it("binding: live only while the named binding is open", () => {
    expect(waitLive({ kind: "binding", ref: "ENG-13" }, { hasOpenBinding: () => true })).toBe(true);
    expect(waitLive({ kind: "binding", ref: "ENG-13" }, { hasOpenBinding: () => false })).toBe(false);
    // The lookup omitted reads as not live.
    expect(waitLive({ kind: "binding", ref: "ENG-13" })).toBe(false);
  });

  it("person: live only while the named page item is open", () => {
    expect(waitLive({ kind: "person", ref: "need_1" }, { hasOpenItem: () => true })).toBe(true);
    expect(waitLive({ kind: "person", ref: "need_1" }, { hasOpenItem: () => false })).toBe(false);
    expect(waitLive({ kind: "person", ref: "need_1" })).toBe(false);
  });
});

describe("typedWaitLive: the date and external kinds", () => {
  it("date: live only while the scheduled requeue is still ahead", () => {
    const now = 1_000_000;
    expect(waitLive({ kind: "date", ref: "2026-12-01" }, { now, binding: binding({ requeueUntil: now + 1 }) })).toBe(true);
    expect(waitLive({ kind: "date", ref: "2026-12-01" }, { now, binding: binding({ requeueUntil: now - 1 }) })).toBe(false);
    // A ref date the report never turned into `requeueUntil` is not a scheduled wake.
    expect(waitLive({ kind: "date", ref: "2026-12-01" }, { now })).toBe(false);
  });

  it("external: never live", () => {
    expect(waitLive({ kind: "external", ref: "the vendor's reply" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// waitFingerprint: per kind and for null.
// ---------------------------------------------------------------------------

describe("waitFingerprint: per kind and for null", () => {
  it("null when there is no typed wait", () => {
    expect(fingerprint(null)).toBeNull();
  });

  it("null for every kind that is not pull or review", () => {
    for (const wait of [
      { kind: "deployment" as const, ref: "acme/web#9" },
      { kind: "worker" as const, ref: "thr_w1" },
      { kind: "binding" as const, ref: "ENG-13" },
      { kind: "date" as const, ref: "2026-12-01" },
      { kind: "person" as const, ref: "need_1" },
      { kind: "external" as const, ref: "the vendor's reply" },
    ]) {
      expect(fingerprint(wait), wait.kind).toBeNull();
    }
  });

  it("null for a pull or review ref the look could not read", () => {
    expect(fingerprint({ kind: "pull", ref: "acme/web#9" })).toBeNull();
    expect(fingerprint({ kind: "review", ref: "acme/web#9" })).toBeNull();
  });

  it("is the JSON of the pull's waited fields for a pull and a review wait", () => {
    const expected = JSON.stringify({ key: "acme/web#9", state: "open", title: "Add login retry", head: "aaaaaaa1", checks: "pending", review: false, merged: false });
    expect(fingerprint({ kind: "pull", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) })).toBe(expected);
    expect(fingerprint({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) })).toBe(expected);
  });

  it("changes when the waited pull's head, checks, review or merge changes", () => {
    const base = fingerprint({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9")) });
    expect(fingerprint({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9", { headSha: "bbbbbbb2" })) })).not.toBe(base);
    expect(fingerprint({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9", { checks: { state: "success", failing: [] } })) })).not.toBe(base);
    expect(fingerprint({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(openPull("acme/web#9", { reviewDecision: "APPROVED" })) })).not.toBe(base);
    expect(fingerprint({ kind: "review", ref: "acme/web#9" }, { waitedPulls: waited(mergedPull("acme/web#9")) })).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// observedStall: the public predicate, and the date-ahead non-stall branch.
// ---------------------------------------------------------------------------

describe("observedStall: the wait, the live source and the dated wait", () => {
  const b = (over: { waitingOn?: string | null; requeueUntil?: number | null } = {}) => ({ status: over.waitingOn === undefined ? null : status(over.waitingOn), requeueUntil: over.requeueUntil ?? null });
  const now = 1_000_000;

  it("false with no waitingOn at all, or only whitespace", () => {
    expect(observedStall(b(), false, now)).toBe(false);
    expect(observedStall(b({ waitingOn: "" }), false, now)).toBe(false);
    expect(observedStall(b({ waitingOn: "   " }), false, now)).toBe(false);
  });

  it("false while a live tracked source exists", () => {
    expect(observedStall(b({ waitingOn: "the review" }), true, now)).toBe(false);
  });

  it("true with a wait, no live source and no dated wait still ahead", () => {
    expect(observedStall(b({ waitingOn: "the vendor" }), false, now)).toBe(true);
  });

  it("false while the dated wait is still ahead, true once it has passed", () => {
    expect(observedStall(b({ waitingOn: "the vendor", requeueUntil: now + 1 }), false, now)).toBe(false);
    expect(observedStall(b({ waitingOn: "the vendor", requeueUntil: now - 1 }), false, now)).toBe(true);
  });

  it("the date-ahead non-stall branch on the assessment's typed-wait path", () => {
    const now2 = 1_000_000;
    // No live source in the rows, so the dated wait is the only thing the
    // stall branch reads (BB-413: `live` is the composed resources, not a
    // test-only `sources` value).
    const quiet: Partial<AssessmentInput> = { workers: [], observed: { entity: issue({ state: "In Progress" }), pulls: [] }, ownPulls: new Set<string>() };
    const ahead = assess(input({ ...quiet, now: now2, binding: binding({ wait: { kind: "external", ref: "the vendor" }, status: status("the vendor"), requeueUntil: now2 + 86_400_000 }) }));
    expect(ahead.liveness.waitLive).toBe(false);
    expect(ahead.liveness.stalled).toBe(false);
    const past = assess(input({ ...quiet, now: now2, binding: binding({ wait: { kind: "external", ref: "the vendor" }, status: status("the vendor"), requeueUntil: now2 - 86_400_000 }) }));
    expect(past.liveness.stalled).toBe(true);
  });

  // The two derivations answer different questions and are both carried: the
  // composed live-source answer (resources and holds) is false for a live
  // typed wait, while `typedWaitLive` reads the wait's own kind and says live.
  // `compare` records no divergence for this; it is the design (BB-333), and
  // the test pins both answers so a refactor cannot quietly collapse them.
  it("pins the composed live-source answer false alongside a live typed wait (different questions, both carried)", () => {
    const quiet: Partial<AssessmentInput> = { workers: [], observed: { entity: issue({ state: "In Progress" }), pulls: [] }, ownPulls: new Set<string>() };
    const i = input({ ...quiet, binding: binding({ wait: { kind: "pull", ref: "acme/web#9" } }), waitedPulls: waited(openPull("acme/web#9")) });
    const a = assess(i);
    expect(a.liveness.live).toBe(false);
    expect(a.liveness.waitLive).toBe(true);
  });
});
