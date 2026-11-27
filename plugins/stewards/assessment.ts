// BB-293 (child 2 of BB-291): the shadow assessment. One derived answer per
// binding for the merge gate (with the decide-list mark and the recorded
// project approvals the approvals.ts path omits), the worker state (an
// explicit `parked`, distinct from `running`) and the wait liveness (wake
// source, idle and stall derived from what the plugin observes, not a flag
// stored at report time; BB-414 retires the last such flag, the
// `no_wake_source` column). BB-400 (C5) makes the composer the one place idle
// and stall are derived: `assess()` reads them from the composed answer.
//
// It is pure: it reads only the rows a reconcile already has in hand and
// decides nothing. `compare` runs the predicates the assessment will replace
// over the same rows and returns every place the old answer and the assessment
// disagree, so the divergence log can be read for several days before any
// consumer reads the assessment.
import { composeAssessment, pullGate, type ComposedAssessment } from "./contribution.js";
import { latestReviewMarker, type PrGate, type ProjectApprovalRecord } from "./gate.js";
import { parsePullRef } from "./github.js";
import { gateState } from "./ready-gate.js";
import { CONTRIBUTED_REASON_CODES, isNonActionCode } from "./non-actions.js";
import { anyWorkerInFlight, productGateOptions, runningWorkerReason, stuckDue } from "./reconcile.js";
import { waitBudgetMs, type Playbook, type WaitBudgetKind } from "./config.js";
import type { EntitySnapshot } from "./source-contract.js";
import type { Binding, Escalation, Need, Observed, Worker } from "./store.js";
import type { Wait, WaitKind } from "./wait.js";

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
  /** The composed live-source answer (BB-413): a live wake resource or hold. */
  live: boolean;
  /** The stored typed wait's own liveness (BB-333); null when the binding has no typed wait. */
  waitLive: boolean | null;
  /**
   * A compact fingerprint of the freshly read waited `pull`/`review` ref
   * (BB-333), so a change on it wakes the binding. Null for any other wait or
   * when the ref could not be read; JSON, never the raw snapshot.
   */
  waited: string | null;
  /** The composer's `idleInActiveStage` before the typed wait is applied: what the consumer's idle wake reads (BB-333, BB-400). */
  idleBase: boolean;
  /** The composer's idle: `idleBase` with a live typed wait suppressing it. */
  idle: boolean;
  /** `stuckDue`: the phase backstop. */
  stuck: boolean;
  /** A free-text wait with no tracked source and no dated wait ahead, recomputed from the rows. */
  stalled: boolean;
  /** BB-351: the stored wait is live and past its kind's budget. */
  overdue: boolean;
  /** BB-351: the wait's age in ms when `overdue`, for the `, overdue <duration>` phrase; null otherwise. */
  overdueMs: number | null;
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
  /**
   * BB-351: the stored typed wait, and the requested reviewers of a live
   * `review` wait from the fresh snapshot. Null with no typed wait. Nothing
   * stores this; it is read by the reconcile's nudge step in the same look.
   */
  wait: { kind: WaitKind; ref: string; reviewers: readonly string[] } | null;
};

/**
 * Everything the assessment reads. All of it is already in hand when the
 * reconcile reaches the assessment, so no tick costs an extra GitHub or Linear
 * call.
 */
export type AssessmentInput = {
  binding: Pick<
    Binding,
    "id" | "entityKey" | "kind" | "ready" | "stage" | "ending" | "hold" | "deployments" | "requeueUntil" | "status" | "createdAt" | "advancedAt" | "phase"
  > & { wait?: Binding["wait"]; waitSince?: number | null; holdBehind?: Binding["holdBehind"]; holdStack?: Binding["holdStack"]; mergeBehind?: Binding["mergeBehind"] };
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
  /**
   * The pulls the wake pull watch counts (BB-413, C7): the observed pulls that
   * belong to the binding (`pullBelongsToTicket`), so a pull handed to another
   * binding is excluded even while it is still worker-owned. Defaults to
   * `gatePulls`.
   */
  watchedPulls?: ReadonlySet<string>;
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
  playbook: Playbook;
  /** BB-351: the project's `waitBudgets` overrides; omitted reads as the defaults. */
  waitBudgets?: Partial<Record<WaitBudgetKind, number | null>>;
  /** The spec hash the ready gate compares its approval against. */
  currentSpecHash: string;
  now: number;
};

const lc = (s: string | null | undefined): string => (s ?? "").toLowerCase();

/**
 * BB-412 (C6): the lowercased pull keys leased to a binding as linked pulls:
 * a ticket's open linked pulls, read from the observation the look already
 * holds. It mirrors `leasedPulls` in server.ts, which reads the stored
 * snapshot; the composer and `compare` both derive from it so a drift is a
 * composer bug, never a second data source.
 */
export function leasedLinkedPullKeys(input: Pick<AssessmentInput, "binding" | "observed">): string[] {
  if (input.binding.kind !== "ticket") return [];
  const pulls = input.observed.pulls;
  const keys = new Set<string>(pulls.map((p) => p.key));
  for (const l of input.observed.entity.linkedPulls) if (l.key !== null) keys.add(l.key);
  return [...keys].filter((k) => {
    const seen = pulls.find((p) => lc(p.key) === lc(k));
    return seen === undefined || !["closed", "merged"].includes(lc(seen.state));
  });
}

/** BB-412 (C6): the lowercased pull key a `pull`/`review` typed wait leases, or null. */
export function waitedPullKey(wait: Wait | null): string | null {
  if (wait === null || (wait.kind !== "pull" && wait.kind !== "review")) return null;
  return waitPullKey(wait.ref);
}

/** Whether an observed entity is one of the binding's own pull requests (BB-52 rule 0). */
export const isOwn = (e: EntitySnapshot, own: ReadonlySet<string>): boolean =>
  (e.key !== "" && own.has(lc(e.key))) || (e.url !== null && e.url !== "" && own.has(lc(e.url)));

/** A pull request the plugin can see is still open (not merged or closed). */
export const pullIsOpen = (e: EntitySnapshot): boolean => e.pull !== null && e.state !== "merged" && e.state !== "closed" && e.pull.merged !== true;

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
 * A compact, JSON fingerprint of the freshly read waited `pull`/`review` ref
 * (BB-333): the fields a steward's wait is about, so any change on the ref
 * wakes the binding without storing the snapshot. Null for another kind or a
 * ref the look could not read.
 */
export function waitFingerprint(wait: Wait | null, input: AssessmentInput): string | null {
  if (wait === null || (wait.kind !== "pull" && wait.kind !== "review")) return null;
  const key = waitPullKey(wait.ref);
  const e = key === null ? undefined : input.waitedPulls?.get(key);
  if (e === undefined) return null;
  return JSON.stringify({
    key: e.key,
    state: e.state,
    title: e.title,
    head: e.pull?.headSha ?? null,
    checks: e.pull?.checks?.state ?? null,
    review: reviewGiven(e),
    merged: e.pull?.merged === true,
  });
}

/**
 * BB-351: the wait's age in ms when it is past its kind's budget, else null.
 * `since` is the moment the current wait was first reported. A kind with no
 * budget (`worker`, `binding`, `date`, `external`) never reads overdue.
 */
export function waitOverdueMs(wait: Wait | null, since: number | null, budgets: Partial<Record<WaitBudgetKind, number | null>>, now: number): number | null {
  if (wait === null || since === null) return null;
  const budget = waitBudgetMs(wait.kind, budgets);
  if (budget === null) return null;
  const age = now - since;
  return age > budget ? age : null;
}

/**
 * The requested reviewers of a live `review` wait, from the freshly read pull
 * (BB-351). Empty for any other wait or when the ref could not be read.
 */
function waitReviewers(wait: Wait | null, input: AssessmentInput): readonly string[] {
  if (wait === null || wait.kind !== "review") return [];
  const key = waitPullKey(wait.ref);
  const e = key === null ? undefined : input.waitedPulls?.get(key);
  return e?.pull?.requestedReviewers ?? [];
}

/**
 * Whether the stored typed wait is live, resolved against the rows the look
 * holds (BB-333): the freshly read waited pull, the deployment watches, the
 * workers, the other bindings, the page items and the date. The typed wait is
 * judged by its own kind, never by the row live-source predicate.
 */
export function typedWaitLive(wait: Wait, input: AssessmentInput): boolean {
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
      // BB-389: a parked worker is still waiting, so a `worker` wait naming it
      // is live until its next turn clears the park. A plainly finished, failed
      // or stopped worker is not.
      return input.workers.some((w) => w.threadId === wait.ref && (w.status === "running" || (w.status === "finished" && w.parkedWaitingOn !== null)));
    case "binding":
      return input.hasOpenBinding?.(wait.ref) ?? false;
    case "date":
      // The design's rule: a `date` wait is live while the binding's own
      // requeue is still ahead (`requeueUntil`). `steward_report` sets
      // `requeueUntil` from the ref (or from `until`) in PR 3, so a `date`
      // wait that sent only a ref is live while the date is ahead. Reading the
      // ref here would claim a wake the plugin never scheduled.
      return input.binding.requeueUntil !== null && input.binding.requeueUntil > input.now;
    case "person":
      return input.hasOpenItem?.(wait.ref) ?? false;
    case "external":
      return false;
  }
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

/** Derive the one assessment for a binding from the rows the reconcile already read. */
export function assess(input: AssessmentInput, composed?: ComposedAssessment): Assessment {
  const { binding, workers, escalations, playbook, now } = input;
  // BB-387 (C3): the merge gate is the github contributor's `merge` items,
  // folded by core. BB-400 (C5): the idle/stall liveness is the composer's,
  // too, so `assess()` names no pull-specific or typed-wait derivation. A
  // caller that already composed the answer passes it in, so the reconcile
  // does not compose twice.
  const answer = composed ?? composeAssessment(input);
  const gate = answer.gate;
  // BB-333: the typed wait is judged by its own kind, on every reconcile,
  // never from a flag stored at report time.
  const wait = binding.wait ?? null;
  const waitLive = wait === null ? null : typedWaitLive(wait, input);
  const overdueMs = waitLive === true ? waitOverdueMs(wait, binding.waitSince ?? null, input.waitBudgets ?? {}, now) : null;
  return {
    bindingId: binding.id,
    entityKey: binding.entityKey,
    gate,
    worker: assessWorker(workers),
    liveness: {
      // BB-413 (C7): the live-source answer is the composed resources and
      // holds, computed once by `composeLiveness`.
      live: answer.liveness.live,
      waitLive,
      waited: waitFingerprint(wait, input),
      // BB-400 (C5): the idle base, the idle answer and the stall are the
      // composer's, computed once and read here. The inline typed-wait
      // derivation is deleted, not kept beside it.
      idleBase: answer.liveness.idleBase,
      idle: answer.liveness.idle,
      stuck: stuckDue(binding, playbook, [...escalations], now) !== null,
      stalled: answer.liveness.stalled,
      overdue: overdueMs !== null,
      overdueMs,
    },
    wait: wait === null ? null : { kind: wait.kind, ref: wait.ref, reviewers: waitReviewers(wait, input) },
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
 * - `workerInFlight`, `runningWorkerReason`, `idleInActiveStage`: a parked
 *   `finished` worker is in flight to the first and not mid-turn to the second,
 *   and idle to the third (BB-292 #1).
 * - `approvals.gate`: the old surface gate, built without the decide mark or
 *   the recorded project approvals, against the assessment (BB-292 #2).
 * - `approvals.pageRefusal`: the page action's refusal on a met gate (BB-292 #3).
 *
 * BB-414 (C4) retires the `noWakeSource` surface with the column it compared:
 * the flag is no longer written, and the derived stall is the one answer every
 * surface reads through `derivedStalled`.
 *
 * BB-322 keeps the gate comparison as the soak's evidence that the consumer's
 * answer still matches the predicate it retired; a new `approvals.gate` row is
 * a real difference, not a fixture. It is read through `pullGate`, the same
 * single `prGate` site, so no second call site appears.
 *
 * BB-380 (C2) adds the shadow composer's own surfaces: `compose.waits` and
 * `compose.holds` (BB-387/C3 retired `compose.gate`, since the gate now comes
 * from the composed answer and cannot diverge from it; BB-400/C5 retired
 * `compose.liveness`, since `assess()` now reads idle and stalled from the
 * composed answer and they cannot diverge either). BB-412 (C6) completes
 * `compose.holds` and adds `compose.resources`. The composed answer is a
 * refactor of today's derivation, so a row on one of them is a defect, not a
 * fixture. BB-415 (C8) adds `compose.reasons`: the reason codes the look
 * declined against the composed codes, both sorted. The recorded side is the
 * codes `decline()` wrote in the same look, not the binding's whole
 * non-action history (whose store merge never removes a code), and both sides
 * are restricted to `CONTRIBUTED_REASON_CODES`, the codes a contributor owns.
 * A row here is expected evidence, not a defect: the composer derives only the
 * reasons the rows in hand can express, so an owned code that needs a source
 * call or a merge race shows as a divergence until the consumer slice gives it
 * a home. The `declined` set is passed by the reconcile once the look ends,
 * because the per-pull declines happen after `assess()` composes.
 * Each old side is derived here from the raw rows (the binding, the
 * snapshot, the deployments and the workers), never from the composer's own
 * output. The comparison runs only when the caller passes the composed
 * answer; the C1 characterization tests call `compare` without one and see the
 * seven surfaces they pin.
 */
export function compare(input: AssessmentInput, assessment: Assessment, composed?: ComposedAssessment, declined?: ReadonlySet<string>): Divergence[] {
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
    if (assessment.liveness.idleBase) add("idleInActiveStage", "idle", "parked", workerInputs);
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

  // (4) BB-380 (C2): the shadow composer's waits and holds against the
  // assessment. The composed answer is computed from the same rows by the
  // in-process contributors; a difference here is a defect in the refactor, so
  // the row is the evidence the next slice's consumer can rely on the
  // composed answer. Nothing reads the composed answer yet. BB-387 (C3)
  // retired the `compose.gate` comparison: the gate now comes from the composed
  // answer, so it cannot diverge.
  if (composed !== undefined) {
    // The typed wait the assessment derived, against the composed item. A
    // binding has at most one stored typed wait, so the match is by kind and ref.
    const composedWait = composed.waits.find((w) => w.kind === (assessment.wait?.kind ?? "") && w.ref === (assessment.wait?.ref ?? "")) ?? null;
    if (assessment.wait === null) {
      if (composed.waits.length > 0) add("compose.waits", "none", composed.waits.map((w) => `${w.kind} ${w.ref}`).join(","), { binding: binding.id });
    } else if (composedWait === null) {
      add("compose.waits", `${assessment.wait.kind} ${assessment.wait.ref}`, "none", { binding: binding.id });
    } else {
      const composedWaitText = `${composedWait.live}|${composedWait.fingerprint ?? ""}|${composedWait.overdueMs ?? ""}`;
      const assessedWaitText = `${assessment.liveness.waitLive}|${assessment.liveness.waited ?? ""}|${assessment.liveness.overdueMs ?? ""}`;
      if (composedWaitText !== assessedWaitText) add("compose.waits", assessedWaitText, composedWaitText, { binding: binding.id, kind: assessment.wait.kind });
    }

    // BB-412 (C6): the binding's holds, derived from the raw fields. The
    // ready-gate hold is held while the binding is in the spec stage (the
    // playbook's Todo) and the ready gate has not passed.
    const holdBehind = binding.holdBehind ?? [];
    const holdStack = binding.holdStack ?? [];
    const mergeBehind = binding.mergeBehind ?? [];
    const readyPassed = gateState(input.playbook, binding.ready, input.currentSpecHash).passed;
    const assessedHolds = [
      `hold:${binding.hold !== null}`,
      `ending:${binding.ending !== null}`,
      `requeue:${binding.requeueUntil !== null && binding.requeueUntil > input.now}`,
      `behind:${holdBehind.length > 0}`,
      `stack:${holdStack.length > 0}`,
      `merge-behind:${mergeBehind.length > 0}`,
      `ready-gate:${binding.stage === "spec" && !readyPassed}`,
    ].join(",");
    const composedHolds = composed.holds.map((h) => `${h.id}:${h.held}`).join(",");
    if (assessedHolds !== composedHolds) {
      add("compose.holds", assessedHolds, composedHolds, {
        binding: binding.id,
        hold: binding.hold !== null,
        ending: binding.ending !== null,
        requeue: binding.requeueUntil !== null && binding.requeueUntil > input.now,
        behind: holdBehind.join(","),
        stack: holdStack.join(","),
        mergeBehind: mergeBehind.join(","),
        readyPassed,
        stage: binding.stage,
      });
    }

    // BB-412 (C6): the composed resources against the rows. `active` is
    // whether the resource is live; the idle wake still reads the own-pull
    // (`open-pull`) resources, so a linked pull no worker reported, a parked
    // worker, an unsettled deployment and a live waited pull are resources
    // whose effect on idle is the named fixture, not a divergence. The two
    // sides are sorted so contributor order never reads as a difference.
    const gateMetByPull = new Map(assessment.gate.pulls.map((p) => [lc(p.pull), p.met]));
    const watchedPulls = input.watchedPulls ?? input.gatePulls ?? ownPulls;
    const assessedResources: string[] = [];
    let pullWatch = false;
    for (const e of ownPullEntities(observed, input.gatePulls ?? ownPulls)) {
      const open = pullIsOpen(e) && !(gateMetByPull.get(lc(e.key)) ?? false);
      assessedResources.push(`open-pull:${lc(e.key)}:${open && isOwn(e, ownPulls)}`);
      if (binding.kind === "ticket" && watchedPulls.has(lc(e.key)) && open) pullWatch = true;
    }
    if (binding.kind === "ticket") assessedResources.push(`pull-watch:${pullWatch}`);
    for (const key of leasedLinkedPullKeys(input)) assessedResources.push(`linked-pull:${lc(key)}:true`);
    const waitedKey = waitedPullKey(binding.wait ?? null);
    if (waitedKey !== null) assessedResources.push(`waited-pull:${waitedKey}:${typedWaitLive(binding.wait!, input)}`);
    for (const [key, w] of Object.entries(binding.deployments)) assessedResources.push(`deployment:${lc(key)}:${w.state === "merged" || w.state === "deploying"}`);
    assessedResources.push(`workers:${workers.some((w) => w.status === "running" || (w.status === "finished" && w.parkedWaitingOn !== null))}`);
    assessedResources.push(`parked-workers:${workers.some((w) => w.status === "finished" && w.parkedWaitingOn !== null)}`);
    assessedResources.push(`escalations:${input.escalations.length > 0}`);
    assessedResources.push(`needs:${input.needs.length > 0}`);
    const composedResources = composed.resources.map((r) => `${r.id}:${r.active}`);
    assessedResources.sort();
    composedResources.sort();
    if (assessedResources.join(",") !== composedResources.join(",")) {
      add("compose.resources", assessedResources.join(","), composedResources.join(","), {
        binding: binding.id,
        resources: composed.resources.length,
        workers: workers.length,
        deployments: Object.keys(binding.deployments).length,
        linkedPulls: leasedLinkedPullKeys(input).length,
        waitKind: binding.wait?.kind ?? null,
      });
    }

    // BB-415 (C8): the codes this look declined against the composed codes.
    // Both sides are sorted, so contributor order is not a difference, and both
    // are restricted to the codes a contributor owns: the reconcile-level codes
    // (`nothing-to-do`, `worker-busy`, ...) are not a composer concern and would
    // otherwise make the surface never run clean. `declined` is the codes
    // `decline()` wrote in this look, so a stale code from an earlier look is
    // not compared. `inputs` carries counts and the codes, never free text.
    //
    // BB-416: both sides key the distinct code set, not occurrences. The
    // recorded side is a `Set`, so a code is held once however many pulls
    // declined it; the composer deliberately emits one `Reason` per pull (the
    // detail names the pull), so several foreign-owner pulls compose
    // `pull-foreign-owner` once per pull. Comparing occurrences read as
    // recorded 1 vs composed 14 on a binding with fourteen foreign pulls, and
    // would never clear. The Reason shape is unchanged; only this comparison
    // dedupes.
    if (declined !== undefined) {
      const recordedReasons = [...declined].filter((c) => isNonActionCode(c) && CONTRIBUTED_REASON_CODES.has(c)).sort();
      // `deferred` is the one local reason the composer approximates: it
      // composes it whenever the binding is on hold. The reconcile declines
      // `nothing-to-do` or `worker-busy` before it ever reaches its own defer
      // check, so a held binding with nothing changed or a busy steward would
      // otherwise read as `""` against `deferred` on most looks.
      const composedReasons = [
        ...new Set(
          composed.reasons
            .filter((r) => r.code !== "deferred" || (!declined.has("nothing-to-do") && !declined.has("worker-busy")))
            .map((r) => r.code),
        ),
      ].sort();
      if (recordedReasons.join(",") !== composedReasons.join(",")) {
        add("compose.reasons", recordedReasons.join(","), composedReasons.join(","), {
          binding: binding.id,
          recorded: recordedReasons.length,
          composed: composedReasons.length,
        });
      }
    }
  }
  return out;
}
