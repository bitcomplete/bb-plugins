// BB-293 (child 2 of BB-291): the shadow assessment. One derived answer per
// binding for the merge gate (with the decide-list mark and the recorded
// project approvals the approvals.ts path omits), the worker state (an
// explicit `parked`, distinct from `running`) and the wait liveness (wake
// source, idle and stall derived from what the plugin observes, not the
// report-time `noWakeSource` flag).
//
// It is pure: it reads only the rows a reconcile already has in hand and
// decides nothing. `compare` runs the predicates the assessment will replace
// over the same rows and returns every place the old answer and the assessment
// disagree, so the divergence log can be read for several days before any
// consumer reads the assessment.
import { assessedPullGate, gateInputKey, pullGate } from "./assessed-gate.js";
import { latestReviewMarker, type PrGate, type ProjectApprovalRecord } from "./gate.js";
import { parsePullRef } from "./github.js";
import { gateState } from "./ready-gate.js";
import { anyWorkerInFlight, idleInActiveStage, observedStall, productGateOptions, runningWorkerReason, stuckDue, type IdleBinding } from "./reconcile.js";
import { hasLiveWakeSource, parseUntil, type WakeSourceInput } from "./wake-source.js";
import type { Playbook } from "./config.js";
import type { EntitySnapshot } from "./source-contract.js";
import type { Binding, Escalation, Need, Observed, Worker } from "./store.js";
import type { Wait } from "./wait.js";

export type DecideMark = "project" | "user";

/** How long a divergence row is kept before the reconcile prunes it. */
export const ASSESSMENT_DIVERGENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The most divergence rows kept, newest first; the reconcile prunes the rest. */
export const ASSESSMENT_DIVERGENCE_MAX_ROWS = 500;

/**
 * The merge gate for one own pull request, derived with every input the
 * plugin has. It is the full `PrGate` (BB-322: every surface reads it from
 * the stored assessment) plus the pull request's key and the `met` shorthand
 * the assessment's own callers use.
 */
export type AssessedGate = PrGate & {
  /** The pull request's key (owner/repo#N), an id, never free text. */
  pull: string;
  met: boolean;
  /** The fingerprint of the gate's inputs, so a stored answer is reused only when nothing changed (BB-210). */
  key: string;
};

/**
 * The binding's worker state. `parked` is explicit: a worker that called its
 * own `worker_park` tool and finished its turn, so it is kept unarchived until
 * its next turn clears the park. A `finished` worker that did not park is a
 * plain finish. `inFlight` is still running-or-finished (the wake quieting and
 * lifecycle answer) and `reason` is `runningWorkerReason`'s text.
 */
export type AssessedWorker = {
  state: "running" | "parked" | "finished" | "failed" | "stopped" | "none";
  inFlight: boolean;
  running: boolean;
  parked: boolean;
  /** `runningWorkerReason`'s text for a mid-turn worker, else null. */
  reason: string | null;
};

export type AssessedLiveness = {
  /** `hasLiveWakeSource` over the observable rows. */
  live: boolean;
  /** The stored typed wait's own liveness (BB-333); null when the binding has no typed wait. */
  waitLive: boolean | null;
  /** `idleInActiveStage`. */
  idle: boolean;
  /** `stuckDue`: the phase backstop. */
  stuck: boolean;
  /** A free-text wait with no tracked source and no dated wait ahead, recomputed from the rows. */
  stalled: boolean;
  /** The report-time flag the assessment replaces. */
  reportedNoWakeSource: boolean;
};

export type Assessment = {
  bindingId: string;
  entityKey: string;
  gate: {
    pulls: AssessedGate[];
    /** Every own pull's gate is met; true when the binding has none. */
    met: boolean;
    decision: DecideMark;
    missing: string | null;
    /** The ticket ready gate's pass, or null when the playbook has none. */
    readyPassed: boolean | null;
  };
  worker: AssessedWorker;
  liveness: AssessedLiveness;
};

/**
 * Everything the assessment reads. All of it is already in hand when the
 * reconcile reaches the assessment, so no tick costs an extra GitHub or Linear
 * call.
 */
export type AssessmentInput = {
  binding: Pick<
    Binding,
    "id" | "entityKey" | "kind" | "ready" | "stage" | "ending" | "hold" | "deployments" | "requeueUntil" | "noWakeSource" | "status" | "createdAt" | "advancedAt" | "phase"
  > & { wait?: Binding["wait"] };
  /**
   * Fresh snapshots of the binding's waited `pull`/`review` refs (BB-333),
   * keyed by lowercased `owner/repo#N`. Read by the look, never stored in the
   * binding's snapshot.
   */
  waitedPulls?: ReadonlyMap<string, EntitySnapshot>;
  /** Whether a binding with this entity key is open and unfinished, for a `binding` wait (BB-333). */
  hasOpenBinding?: (key: string) => boolean;
  /** Whether a page item with this id is open, for a `person` wait (BB-333). */
  hasOpenItem?: (id: string) => boolean;
  /** The observation the reconcile just read. */
  observed: Observed;
  /** The binding's own pull keys and URLs, lowercased (BB-52 rule 0). */
  ownPulls: ReadonlySet<string>;
  /**
   * The pull requests to gate (BB-322): the binding's own plus every linked one
   * that belongs to it, the same set `syncNeeds` acts on. Defaults to
   * `ownPulls`, so a caller that does not need the broader set is unchanged.
   */
  gatePulls?: ReadonlySet<string>;
  /** The decide-list mark for each own pull, from the files the snapshot already carries. */
  decisions: ReadonlyMap<string, DecideMark>;
  /** The plugin's recorded project approvals for the binding. */
  projectApprovals: readonly ProjectApprovalRecord[];
  /**
   * The logins the store remembers as requested reviewers, keyed by a pull
   * request's lowercased key and URL (BB-327). Read by the gate so a
   * delegate's APPROVED review still counts after GitHub drops the reviewer
   * from the live list; omitted reads as none, which leaves the live list in
   * charge.
   */
  rememberedRequesters?: ReadonlyMap<string, readonly string[]>;
  /**
   * The delegates already re-requested for a pull request's current head,
   * keyed by its lowercased key and URL (BB-327). The gate reads it so a
   * repeated look does not re-request and the status can say it was done.
   */
  reRequestedDelegates?: ReadonlyMap<string, readonly string[]>;
  workers: readonly Worker[];
  escalations: readonly Escalation[];
  needs: readonly Need[];
  /** The wake sources the report path already assembles (BB-154). */
  sources: WakeSourceInput;
  playbook: Playbook;
  /** The spec hash the ready gate compares its approval against. */
  currentSpecHash: string;
  now: number;
};

const lc = (s: string | null | undefined): string => (s ?? "").toLowerCase();

/** The remembered requesters for one pull request, by its lowercased key or URL (BB-327). */
function rememberedFor(map: ReadonlyMap<string, readonly string[]> | undefined, e: EntitySnapshot): readonly string[] {
  if (map === undefined) return [];
  return map.get(lc(e.key)) ?? (e.url === null ? [] : map.get(lc(e.url)) ?? []);
}

/** Whether an observed entity is one of the binding's own pull requests (BB-52 rule 0). */
const isOwn = (e: EntitySnapshot, own: ReadonlySet<string>): boolean =>
  (e.key !== "" && own.has(lc(e.key))) || (e.url !== null && e.url !== "" && own.has(lc(e.url)));

/** A pull request the plugin can see is still open (not merged or closed). */
const pullIsOpen = (e: EntitySnapshot): boolean => e.pull !== null && e.state !== "merged" && e.state !== "closed" && e.pull.merged !== true;

/** Whether a pull request's review has been given: an approved review or marker at its head (BB-333). */
function reviewGiven(e: EntitySnapshot): boolean {
  if (e.pull === null) return false;
  if (e.pull.reviewDecision === "APPROVED") return true;
  const marker = latestReviewMarker(e.comments);
  if (marker !== null && marker.verdict === "approved" && (marker.sha === "" || marker.sha === e.pull.headSha)) return true;
  return e.pull.reviews.some((r) => r.state.toLowerCase() === "approved" && (r.commit === null || r.commit === e.pull?.headSha));
}

/** The lowercased `owner/repo#N` a stored `pull`/`review` ref names, or null when it does not parse. */
function waitPullKey(ref: string): string | null {
  const parsed = parsePullRef(ref);
  return parsed === null ? null : `${parsed.repo}#${parsed.number}`.toLowerCase();
}

/**
 * Whether the stored typed wait is live, resolved against the rows the look
 * holds (BB-333): the freshly read waited pull, the deployment watches, the
 * workers, the other bindings, the page items and the date. The typed wait is
 * judged by its own kind, never by `hasLiveWakeSource`.
 */
function typedWaitLive(wait: Wait, input: AssessmentInput): boolean {
  switch (wait.kind) {
    case "pull":
    case "review": {
      const key = waitPullKey(wait.ref);
      const e = key === null ? undefined : input.waitedPulls?.get(key);
      if (e === undefined || !pullIsOpen(e)) return false;
      return wait.kind === "pull" ? true : !reviewGiven(e);
    }
    case "deployment": {
      const key = waitPullKey(wait.ref);
      return key !== null && Object.values(input.binding.deployments).some((w) => lc(w.key) === key && (w.state === "merged" || w.state === "deploying"));
    }
    case "worker":
      return input.workers.some((w) => w.threadId === wait.ref && w.status === "running");
    case "binding":
      return input.hasOpenBinding?.(wait.ref) ?? false;
    case "date": {
      const at = parseUntil(wait.ref) ?? input.binding.requeueUntil;
      return at !== null && at > input.now;
    }
    case "person":
      return input.hasOpenItem?.(wait.ref) ?? false;
    case "external":
      return false;
  }
}

/**
 * Whether the project steward forwarded this pull request's approval escalation
 * to the owner (BB-192): an open `approval` escalation for the pull, routed to
 * the user with `resolutionKind: "approve-decline"`. A `project`-entry pull is
 * the owner's from the forward on (BB-322 blocker 1).
 */
function forwardedToOwner(escalations: readonly Escalation[], e: EntitySnapshot): boolean {
  const url = lc(e.url ?? e.key);
  return escalations.some((x) => x.status === "open" && x.kind === "approval" && x.route === "user" && x.resolutionKind === "approve-decline" && lc(x.url) === url);
}

/** Every own pull request the binding's workers opened, the binding's own entity first. */
export function ownPullEntities(observed: Observed, own: ReadonlySet<string>): EntitySnapshot[] {
  return [observed.entity, ...observed.pulls].filter((e) => e.pull !== null && isOwn(e, own));
}

/**
 * The worker state. `parked` is driven by the worker's own `worker_park` call
 * (BB-329): a `finished` worker that did not park is a plain finish, whatever
 * its final text says, and is named `finished` rather than `parked`.
 */
export function assessWorker(workers: readonly Worker[]): AssessedWorker {
  const running = workers.some((w) => w.status === "running");
  const finished = !running && workers.some((w) => w.status === "finished");
  const parked = !running && workers.some((w) => w.status === "finished" && w.parkedWaitingOn !== null);
  const failed = !running && !finished && workers.some((w) => w.status === "failed");
  const state: AssessedWorker["state"] = running ? "running" : parked ? "parked" : workers.length === 0 ? "none" : finished ? "finished" : failed ? "failed" : "stopped";
  return { state, inFlight: anyWorkerInFlight(workers), running, parked, reason: runningWorkerReason(workers) };
}

/**
 * The idle answer (BB-83), in one place: `assess` and the reconcile's idle
 * wake both call it, so no surface calls `idleInActiveStage` directly.
 */
export function assessIdle(idleBinding: IdleBinding, observed: Observed, now: number = Date.now()): boolean {
  return idleInActiveStage(idleBinding, observed, now);
}

/**
 * The live-wake-source answer (BB-154), in one place: `assess` and the report
 * path's `liveWakeSourceFor` both call it, so no surface calls
 * `hasLiveWakeSource` directly.
 */
export function assessLiveWakeSource(sources: WakeSourceInput): boolean {
  return hasLiveWakeSource(sources);
}

/** Derive the one assessment for a binding from the rows the reconcile already read. */
export function assess(input: AssessmentInput): Assessment {
  const { binding, observed, ownPulls, decisions, projectApprovals, workers, escalations, needs, sources, playbook, currentSpecHash, now } = input;
  const pulls: AssessedGate[] = [];
  const gatePulls = input.gatePulls ?? ownPulls;
  for (const e of ownPullEntities(observed, gatePulls)) {
    // BB-322 blocker 1: a `project` entry the project steward forwarded to the
    // owner (BB-192) is the owner's from the moment of the forward, not only
    // after they approve. The forward is an open `approval` escalation routed
    // to the user with the pull's url and `resolutionKind: "approve-decline"`
    // (a normal owner-lane approval is the same shape but the mark is already
    // `user`). Without this the gate says `project`, the page refuses the
    // owner's approval and the reconcile reroutes the escalation back.
    const decideMark = decisions.get(lc(e.key)) ?? "user";
    const mark: DecideMark = decideMark === "project" && forwardedToOwner(escalations, e) ? "user" : decideMark;
    const remembered = rememberedFor(input.rememberedRequesters, e);
    const reRequested = rememberedFor(input.reRequestedDelegates, e);
    const g = assessedPullGate(binding, e, mark, projectApprovals, remembered, reRequested);
    pulls.push({ ...g, pull: e.key, met: g.gateMet, key: gateInputKey(binding, e, g.decision, projectApprovals, remembered, reRequested) });
  }
  const idleBinding: IdleBinding = {
    stage: binding.stage,
    ending: binding.ending,
    hold: binding.hold,
    deployments: binding.deployments,
    requeueUntil: binding.requeueUntil,
    workers,
    ownPulls,
    // BB-322: derived from the one assessment, so no surface computes the gate
    // again; the old `gateMetPulls` input is retired.
    gateMetPulls: new Set(pulls.filter((p) => p.met).map((p) => p.pull.toLowerCase())),
    escalations,
    needs,
  };
  const live = assessLiveWakeSource(sources);
  // BB-333: the typed wait is judged by its own kind, on every reconcile,
  // never from a flag stored at report time. A no-kind report keeps today's
  // free-text rule exactly.
  const wait = binding.wait ?? null;
  const waitLive = wait === null ? null : typedWaitLive(wait, input);
  const dateAhead = binding.requeueUntil !== null && binding.requeueUntil > now;
  const idleBase = assessIdle(idleBinding, observed, now);
  return {
    bindingId: binding.id,
    entityKey: binding.entityKey,
    gate: {
      pulls,
      met: pulls.every((p) => p.met),
      decision: pulls[0]?.decision ?? "user",
      missing: pulls.find((p) => !p.met)?.missing ?? null,
      readyPassed: gateState(playbook, binding.ready, currentSpecHash).passed,
    },
    worker: assessWorker(workers),
    liveness: {
      live,
      waitLive,
      // A live typed wait is something the plugin waits on, so it suppresses
      // the idle wake; a stalled or external one does not (BB-333).
      idle: wait !== null && waitLive === true ? false : idleBase,
      stuck: stuckDue(binding, playbook, [...escalations], now) !== null,
      stalled: wait === null ? observedStall(binding, live, now) : waitLive !== true && !dateAhead,
      reportedNoWakeSource: binding.noWakeSource,
    },
  };
}

/**
 * One place the old predicate and the shadow assessment disagree. `inputs`
 * carries only ids, shas, states and timestamps: never a comment body or any
 * free text, so the log cannot leak a transcript.
 */
export type Divergence = {
  bindingId: string;
  surface: string;
  old: string;
  new: string;
  inputs: Record<string, string | number | boolean | null>;
};

const verdict = (met: boolean, missing: string | null): string => (met ? "met" : (missing ?? "unmet"));

/**
 * Every place the predicates the assessment will retire answer differently
 * from it, over the same rows. The surfaces:
 *
 * - `workerInFlight`, `runningWorkerReason`, `idleInActiveStage`,
 *   `hasLiveWakeSource`: a parked `finished` worker is in flight to the first
 *   and not mid-turn, idle and not a live source to the others (BB-292 #1).
 * - `approvals.gate`: the old surface gate, built without the decide mark or
 *   the recorded project approvals, against the assessment (BB-292 #2).
 * - `approvals.pageRefusal`: the page action's refusal on a met gate (BB-292 #3).
 * - `noWakeSource`: the report-time flag against the stall recomputed from
 *   the observable rows.
 *
 * BB-322 keeps the gate comparison as the soak's evidence that the consumer's
 * answer still matches the predicate it retired; a new `approvals.gate` row is
 * a real difference, not a fixture. It is read through `pullGate`, the same
 * single `prGate` site, so no second call site appears.
 */
export function compare(input: AssessmentInput, assessment: Assessment): Divergence[] {
  const { binding, observed, ownPulls, projectApprovals, workers } = input;
  const out: Divergence[] = [];
  const add = (surface: string, old: string, next: string, inputs: Divergence["inputs"]): void => {
    if (old !== next) out.push({ bindingId: binding.id, surface, old, new: next, inputs });
  };
  const workerInputs: Divergence["inputs"] = { binding: binding.id, workers: workers.length, states: workers.map((w) => w.status).join(",") };

  // (1) A parked worker: the boolean predicates disagree about it; the
  // assessment names the state `parked`.
  if (assessment.worker.parked) {
    if (anyWorkerInFlight(workers)) add("workerInFlight", "in-flight", "parked", workerInputs);
    if (runningWorkerReason(workers) === null) add("runningWorkerReason", "not-mid-turn", "parked", workerInputs);
    if (assessment.liveness.idle) add("idleInActiveStage", "idle", "parked", workerInputs);
    if (!assessment.liveness.live) add("hasLiveWakeSource", "no-live-source", "parked", workerInputs);
  }

  // (2) The gate inputs, and (3) the page's refusal text.
  for (const e of ownPullEntities(observed, ownPulls)) {
    const assessed = assessment.gate.pulls.find((p) => lc(p.pull) === lc(e.key));
    if (assessed === undefined) continue;
    const oldGate = pullGate(e, productGateOptions(binding, e));
    const gateInputs: Divergence["inputs"] = {
      binding: binding.id,
      pull: e.key,
      headSha: e.pull?.headSha ?? null,
      decision: assessed.decision,
      recordedApprovals: projectApprovals.length,
    };
    if (oldGate.gateMet !== assessed.met) add("approvals.gate", verdict(oldGate.gateMet, oldGate.missing), verdict(assessed.met, assessed.missing), gateInputs);
    // The page acts only while `needsOwnerApproval` is true; on a met gate it
    // falls to the `??` fallback, whose words this records.
    const pageRefusal = oldGate.needsOwnerApproval ? null : (oldGate.missing ?? "the pull request has not been observed yet");
    if (pageRefusal !== null && assessed.met) add("approvals.pageRefusal", pageRefusal, "met", gateInputs);
  }

  // (4) The report-time no-wake-source flag against the stall recomputed from
  // the rows. `hasLiveWakeSource`, `idleInActiveStage` and `stuckDue` are the
  // assessment's own derivation, so they are compared by construction; only
  // the flag and the observed stall can disagree.
  add("noWakeSource", binding.noWakeSource ? "no-wake-source" : "source-or-no-wait", assessment.liveness.stalled ? "no-wake-source" : "source-or-no-wait", {
    binding: binding.id,
    live: assessment.liveness.live,
    idle: assessment.liveness.idle,
    stuck: assessment.liveness.stuck,
    readyPassed: assessment.gate.readyPassed,
    requeueUntil: binding.requeueUntil,
    phase: binding.phase,
    // The row the predicates read, as a boolean, never the wait text.
    hasWait: (binding.status?.waitingOn ?? "").trim() !== "",
    waitKind: binding.wait?.kind ?? null,
    waitLive: assessment.liveness.waitLive === true,
  });
  return out;
}
