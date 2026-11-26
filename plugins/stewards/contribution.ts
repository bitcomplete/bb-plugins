// BB-380 (BB-291 criterion 8, slice C2): the per-source contribution
// interface and the composer. BB-387 (C3) makes the composer's gate the one
// `assess()` returns: the github contributor owns the pull merge gate
// (`pullGate`, `gateInputKey`, `assessedPullGate`, the BB-321 forwarded-owner
// rule) and `assess()` composes its `merge` items. The resources, holds and
// reasons are still shadow — the reconcile computes them beside the
// assessment and `compare` records any divergence through the existing
// divergence log (BB-293). BB-399 (C4) added the composed `liveness`
// (idle/stall); BB-400 (C5) makes it the one `assess()` reads, so the inline
// idle/stall derivation is deleted and the composer is the only place idle or
// stall is derived.
//
// A source contributes what it knows about the subjects it owns: gate items,
// waits, resources, holds and reasons. `compose()` folds those into one
// answer. Today three in-process contributors wrap the code `assess()` already
// runs — the github contributor wraps the pull gate and the binding's own
// source (github, linear or local) wraps the typed-wait derivation and the
// binding's holds. Nothing here adds a store or source read: every row comes
// from the `AssessmentInput` the reconcile already holds.
import { createHash } from "node:crypto";
import {
  isOwn,
  leasedLinkedPullKeys,
  ownPullEntities,
  pullIsOpen,
  typedWaitLive,
  waitedPullKey,
  waitFingerprint,
  waitOverdueMs,
} from "./assessment.js";
import type { AssessedGate, Assessment, AssessmentInput, DecideMark } from "./assessment.js";
import { waitBudgetMs } from "./config.js";
import { prGate, type PrGate, type PrGateOptions, type ProjectApprovalRecord } from "./gate.js";
import { schedulingHolds, type HoldContribution } from "./holds.js";
import { idleInActiveStage, observedStall, productGateOptions } from "./reconcile.js";
import { gateState } from "./ready-gate.js";
import type { EntitySnapshot } from "./source-contract.js";
import type { Binding, Escalation } from "./store.js";
import type { Wait, WaitKind } from "./wait.js";

const lc = (s: string | null | undefined): string => (s ?? "").toLowerCase();

/**
 * BB-387 (C3): the pull merge gate's home. The single `prGate` call site
 * (BB-322 criterion 1) and the per-pull derivation the github contributor
 * wraps live here, not in `assessed-gate.ts`, which keeps only the store
 * read/refresh helpers. `pullGate` stays the one call site outside the gate
 * module.
 */
export function pullGate(entity: EntitySnapshot, options: PrGateOptions = {}): PrGate {
  return prGate(entity, options);
}

/** The gate options for one own pull request: the decide-list mark, the product inputs and the delegate records (BB-327). */
function gateOptions(binding: Pick<Binding, "kind" | "ready">, entity: EntitySnapshot, mark: DecideMark, projectApprovals: readonly ProjectApprovalRecord[], rememberedRequesters: readonly string[] = [], reRequestedDelegates: readonly string[] = []): PrGateOptions {
  return { decision: mark, projectApprovals, rememberedRequesters, reRequestedDelegates, ...productGateOptions(binding, entity) };
}

/**
 * A fingerprint of everything `prGate` reads for one pull request. The stored
 * assessment is reused only when it carries this same fingerprint, so a
 * reviewer marker, an approval, a check result or the base state that changed
 * at the same head sha is never read as the old answer (BB-210).
 */
export function gateInputKey(binding: Pick<Binding, "kind" | "ready">, entity: EntitySnapshot, mark: DecideMark, projectApprovals: readonly ProjectApprovalRecord[], rememberedRequesters: readonly string[] = [], reRequestedDelegates: readonly string[] = []): string {
  return createHash("sha1").update(JSON.stringify({ entity, options: gateOptions(binding, entity, mark, projectApprovals, rememberedRequesters, reRequestedDelegates) })).digest("hex");
}

/**
 * The gate for one own pull request: the decide-list mark and the BB-321
 * forwarded-owner rule. The decide list places the pull request, but the
 * project steward may forward a `project` entry's approval escalation to the
 * owner (BB-192). The owner's unsigned approval is then the gate, so a gate
 * that still demanded a project-steward approval would be stricter than the
 * lane rules. The escalation is resolved once the owner answers and is no
 * longer in the rows the reconcile holds, so the approval it produced is the
 * fact that remains. A recorded project-steward approval keeps the pull
 * request the project steward's.
 */
export function assessedPullGate(binding: Pick<Binding, "kind" | "ready">, entity: EntitySnapshot, mark: DecideMark, projectApprovals: readonly ProjectApprovalRecord[], rememberedRequesters: readonly string[] = [], reRequestedDelegates: readonly string[] = []): PrGate {
  const options = gateOptions(binding, entity, mark, projectApprovals, rememberedRequesters, reRequestedDelegates);
  const probe = pullGate(entity, options);
  return mark === "project" && probe.ownerApproved && !probe.projectApproved ? pullGate(entity, { ...options, decision: "user" }) : probe;
}

/** The remembered requesters for one pull request, by its lowercased key or URL (BB-327). */
export function rememberedFor(map: ReadonlyMap<string, readonly string[]> | undefined, e: EntitySnapshot): readonly string[] {
  if (map === undefined) return [];
  return map.get(lc(e.key)) ?? (e.url === null ? [] : map.get(lc(e.url)) ?? []);
}

/**
 * Whether the project steward forwarded this pull request's approval escalation
 * to the owner (BB-192): an open `approval` escalation for the pull, routed to
 * the user with `resolutionKind: "approve-decline"`. A `project`-entry pull is
 * the owner's from the forward on (BB-322 blocker 1).
 */
export function forwardedToOwner(escalations: readonly Escalation[], e: EntitySnapshot): boolean {
  const url = lc(e.url ?? e.key);
  return escalations.some((x) => x.status === "open" && x.kind === "approval" && x.route === "user" && x.resolutionKind === "approve-decline" && lc(x.url) === url);
}

/** The source plugins a contribution can come from, as the design names them. */
export type ContributionSource = "github" | "linear" | "local";

/** What a contribution is about, as the design names it. */
export type ContributionSubject = { kind: "pull" | "artifact" | "step" | "entity"; id: string };

/**
 * One gate item a source contributes. The merge gate is a `pull` subject's
 * `merge` item; the wrapped `assessed` gate carries every field the surfaces
 * read today, so the composer reproduces `assess()` exactly.
 */
export type GateContribution = {
  source: ContributionSource;
  /** The subject the gate is about: a pull request's key. */
  subject: ContributionSubject;
  /** The item's id within its subject: `merge` for the pull request gate. */
  id: string;
  met: boolean;
  missing: string | null;
  /** The decide-list lane the gate was computed under. */
  lane: DecideMark;
  /** Whether the reviewer escalated the pull request to the owner (BB-192). */
  escalated: boolean;
  /** Whether the product reason made the pull request the owner's (BB-207). */
  product: boolean;
  /** The fingerprint of the gate's inputs (BB-210). */
  inputs: string;
  /** The wrapped today's gate, so the composer can reproduce `assess()` exactly. */
  assessed: AssessedGate;
};

/** One wait a source contributes, wrapping today's typed-wait derivation. */
export type WaitContribution = {
  source: ContributionSource;
  kind: WaitKind;
  ref: string;
  live: boolean;
  /** The waited pull's field fingerprint (BB-333), or null. */
  fingerprint: string | null;
  budgetMs: number | null;
  since: number | null;
  /** The age past the kind's budget when overdue (BB-351), else null. */
  overdueMs: number | null;
};

/**
 * One resource a source contributes: something the binding owns or watches.
 * `active` is whether the resource is live. The idle wake reads the own-pull
 * (`open-pull:<key>`) resources; the others are watched (a linked or waited
 * pull) or are read by `idleInActiveStage` from its own rows (workers,
 * deployments), so a linked pull no worker reported and a parked worker are
 * named fixtures, not idle-blocking.
 */
export type ResourceContribution = {
  source: ContributionSource;
  /** `open-pull:<key>`, `linked-pull:<key>`, `waited-pull:<key>`, `deployment:<key>` or `workers`. */
  id: string;
  active: boolean;
  subject: ContributionSubject | null;
};

// The composed holds and their one derivation live in `holds.ts`, so the
// composer, the idle rule, `atWork`, the card row and the wake renderer share
// it without an import cycle. Re-exported here for the existing importers.
export { schedulingHolds, type HoldContribution, type HoldFields, type HoldSource } from "./holds.js";

/** One reason a source contributes, for the card, `show` and the digest (BB-335). */
export type Reason = {
  source: ContributionSource;
  code: string;
  detail: string | null;
  at: number;
};

/** Everything one source contributes for a binding. */
export type SourceContribution = {
  source: ContributionSource;
  gate: readonly GateContribution[];
  waits: readonly WaitContribution[];
  resources: readonly ResourceContribution[];
  holds: readonly HoldContribution[];
  reasons: readonly Reason[];
};

/** A source's in-process view of today's assessment. */
export type SourceContributor = {
  source: ContributionSource;
  contribute(input: AssessmentInput): SourceContribution;
};

/**
 * The composed answer, beside `assess()`. `gate` is exactly
 * `Assessment["gate"]`. `liveness` is the idle/stall answer (BB-399, C4;
 * BB-400, C5 makes it the one `assess()` reads): `idleBase` is
 * `idleInActiveStage`'s answer before the typed wait is applied, `idle` is
 * that with a live typed wait suppressing it, and `stalled` is the
 * observed/typed-wait stall. `compose` leaves it at its neutral default
 * because it folds contributions only, and `composeAssessment` derives it
 * from the contributions plus the rows the look already holds.
 */
export type ComposedAssessment = {
  gate: Assessment["gate"];
  waits: readonly WaitContribution[];
  resources: readonly ResourceContribution[];
  holds: readonly HoldContribution[];
  reasons: readonly Reason[];
  liveness: { live: boolean; idleBase: boolean; idle: boolean; stalled: boolean };
};

const empty = (source: ContributionSource): SourceContribution => ({ source, gate: [], waits: [], resources: [], holds: [], reasons: [] });

/** The typed wait as one contribution, wrapping today's derivation. */
function waitContribution(source: ContributionSource, input: AssessmentInput): WaitContribution | null {
  const wait: Wait | null = input.binding.wait ?? null;
  if (wait === null) return null;
  const budgets = input.waitBudgets ?? {};
  const live = typedWaitLive(wait, input);
  const since = input.binding.waitSince ?? null;
  return {
    source,
    kind: wait.kind,
    ref: wait.ref,
    live,
    fingerprint: waitFingerprint(wait, input),
    budgetMs: waitBudgetMs(wait.kind, budgets),
    since,
    overdueMs: live ? waitOverdueMs(wait, since, budgets, input.now) : null,
  };
}

/** The pull/review/deployment kinds a pull request's source owns; the rest are the entity's. */
const PULL_WAIT_KINDS: ReadonlySet<WaitKind> = new Set(["pull", "review", "deployment"]);

/**
 * The binding's holds, one item per kind so the set is complete: the scheduling
 * holds from `holds.ts`, plus the ready-gate hold. The ready gate is held while
 * the binding is in the spec stage (the playbook's Todo) and the gate has not
 * passed; it reads the same `gateState` `composeAssessment` computes for
 * `gate.readyPassed`.
 */
function bindingHolds(source: ContributionSource, input: AssessmentInput): HoldContribution[] {
  const b = input.binding;
  const readyPassed = gateState(input.playbook, b.ready, input.currentSpecHash).passed;
  return [
    ...schedulingHolds(b, input.now).map((h) => ({ ...h, source })),
    { source, id: "ready-gate", held: b.stage === "spec" && !readyPassed, behind: [] },
  ];
}

/**
 * What one entity source contributes: its typed wait (the non-pull kinds), the
 * binding's holds, and the resources core reads from its own rows: a
 * `deployment:<key>` per watch not yet settled and the `workers` resource.
 */
function entityContribution(source: ContributionSource, input: AssessmentInput): SourceContribution {
  if (input.observed.entity.source !== source) return empty(source);
  const wait = input.binding.wait ?? null;
  const waits: WaitContribution[] = [];
  if (wait !== null && !PULL_WAIT_KINDS.has(wait.kind)) {
    const w = waitContribution(source, input);
    if (w !== null) waits.push(w);
  }
  const resources: ResourceContribution[] = [];
  // The deployments map is keyed by the watch id (`<pull>` or
  // `<pull>::<target>` for a named target, BB-132), so the resource id is the
  // map key and the subject is still the pull. Keying by `w.key` would collapse
  // two named targets into one id and diverge from `compare`.
  for (const [key, w] of Object.entries(input.binding.deployments)) {
    resources.push({ source, id: `deployment:${lc(key)}`, active: w.state === "merged" || w.state === "deploying", subject: { kind: "pull", id: w.key } });
  }
  // The resources the live-source answer reads (BB-413, C7): a running worker
  // and a parked worker are the two halves of the retired live predicate's
  // worker clauses, an open escalation and a need are its last two. A plainly
  // `finished` worker is in flight but is not a live source, so `workers`
  // follows the live predicate (running or parked), and a parked worker gets
  // its own resource so the surface can name it.
  resources.push({ source, id: "workers", active: input.workers.some((w) => w.status === "running" || (w.status === "finished" && w.parkedWaitingOn !== null)), subject: null });
  resources.push({ source, id: "parked-workers", active: input.workers.some((w) => w.status === "finished" && w.parkedWaitingOn !== null), subject: null });
  resources.push({ source, id: "escalations", active: input.escalations.length > 0, subject: null });
  resources.push({ source, id: "needs", active: input.needs.length > 0, subject: null });
  return { source, gate: [], waits, resources, holds: bindingHolds(source, input), reasons: [] };
}

/** The pull request contributions: the merge gate items, the open-pull resources and the pull/review/deployment wait. */
function pullContributions(input: AssessmentInput): { gate: GateContribution[]; waits: WaitContribution[]; resources: ResourceContribution[]; reasons: Reason[] } {
  const { binding, observed, ownPulls, decisions, projectApprovals, escalations } = input;
  const gatePulls = input.gatePulls ?? ownPulls;
  // The wake pull watch counts the belonging pulls, not the wider `gatePulls`
  // seeded with `ownPulls`: a pull handed to another binding (BB-386) is still
  // worker-owned but is not this binding's watch (BB-413, C7).
  const watchedPulls = input.watchedPulls ?? gatePulls;
  const gate: GateContribution[] = [];
  const resources: ResourceContribution[] = [];
  const reasons: Reason[] = [];
  // The pull watch (`pullWatchCounts`, BB-285/BB-154): a ticket's belonging
  // open pull request whose gate is unmet. It is the wake answer, distinct
  // from the idle-blocking `open-pull` below (a `pr`/`review` binding's own
  // open pull is idle-blocking but never a wake source).
  let pullWatch = false;
  for (const e of ownPullEntities(observed, gatePulls)) {
    const decideMark = decisions.get(lc(e.key)) ?? "user";
    const mark: DecideMark = decideMark === "project" && forwardedToOwner(escalations, e) ? "user" : decideMark;
    const remembered = rememberedFor(input.rememberedRequesters, e);
    const reRequested = rememberedFor(input.reRequestedDelegates, e);
    const g: PrGate = assessedPullGate(binding, e, mark, projectApprovals, remembered, reRequested);
    if (binding.kind === "ticket" && watchedPulls.has(lc(e.key)) && pullIsOpen(e) && !g.gateMet) pullWatch = true;
    const inputs = gateInputKey(binding, e, g.decision, projectApprovals, remembered, reRequested);
    const assessed: AssessedGate = { ...g, pull: e.key, met: g.gateMet, key: inputs };
    gate.push({ source: "github", subject: { kind: "pull", id: e.key }, id: "merge", met: g.gateMet, missing: g.missing, lane: g.decision, escalated: g.escalated, product: g.reason === "product", inputs, assessed });
    // The resource is the idle-blocking one, so it follows `idleInActiveStage`'s
    // own-pull set, not the wider `gatePulls` the gate items use (BB-399 review
    // round 1): a linked pull no worker has reported, or a `pr`/`review`
    // binding's own non-worker pull, is gated but does not suppress the idle
    // wake.
    resources.push({ source: "github", id: `open-pull:${lc(e.key)}`, active: pullIsOpen(e) && !g.gateMet && isOwn(e, ownPulls), subject: { kind: "pull", id: e.key } });
    if (!g.gateMet && g.missing !== null) reasons.push({ source: "github", code: "gate-not-met", detail: g.missing, at: input.now });
  }
  // BB-412 (C6): the pulls the binding watches beside its own: the ticket's
  // leased linked pulls and a typed `pull`/`review` wait's leased ref. They are
  // resources, not idle-blocking (only `open-pull` is), so the idle wake is
  // unchanged.
  for (const key of leasedLinkedPullKeys(input)) {
    resources.push({ source: "github", id: `linked-pull:${lc(key)}`, active: true, subject: { kind: "pull", id: key } });
  }
  const wait = input.binding.wait ?? null;
  const waitedKey = waitedPullKey(wait);
  if (wait !== null && waitedKey !== null) {
    resources.push({ source: "github", id: `waited-pull:${waitedKey}`, active: typedWaitLive(wait, input), subject: { kind: "pull", id: waitedKey } });
  }
  // A ticket's own open pull is a wake source only while the gate is unmet
  // (`pullWatchCounts`), so the resource exists for a ticket alone.
  if (binding.kind === "ticket") resources.push({ source: "github", id: "pull-watch", active: pullWatch, subject: null });
  const waits: WaitContribution[] = [];
  if (wait !== null && PULL_WAIT_KINDS.has(wait.kind)) {
    const w = waitContribution("github", input);
    if (w !== null) waits.push(w);
  }
  return { gate, waits, resources, reasons };
}

/** The github source: the pull merge gate, the open-pull resources and the pull waits, plus its entity's own items. */
export const githubContributor: SourceContributor = {
  source: "github",
  contribute(input) {
    const entity = entityContribution("github", input);
    const pull = pullContributions(input);
    return {
      source: "github",
      gate: pull.gate,
      waits: [...entity.waits, ...pull.waits],
      resources: [...entity.resources, ...pull.resources],
      holds: entity.holds,
      reasons: pull.reasons,
    };
  },
};

/** The linear source: its ticket's non-pull typed wait and the binding's holds. */
export const linearContributor: SourceContributor = {
  source: "linear",
  contribute: (input) => entityContribution("linear", input),
};

/** The local source: its ticket's non-pull typed wait and the binding's holds. */
export const localContributor: SourceContributor = {
  source: "local",
  contribute: (input) => entityContribution("local", input),
};

/** The in-process contributors, in the order the composer folds them. */
export const CONTRIBUTORS: readonly SourceContributor[] = [githubContributor, linearContributor, localContributor];

/**
 * Fold the sources' contributions into one answer. The gate roll-up is every
 * item's `met`, the first item's lane, and the first unmet item's `missing`;
 * the rest are concatenated in contributor order. `readyPassed` is core
 * (the ready gate stays in the plugin), so `composeAssessment` fills it.
 */
export function compose(contributions: readonly SourceContribution[]): ComposedAssessment {
  const gateItems = contributions.flatMap((c) => c.gate);
  return {
    gate: {
      // The roll-up reads the contribution fields, not the wrapped gate, so
      // `assess()` returns the contributor's `met`, `lane` and `missing`
      // rather than re-deriving them from the wrapped gate.
      pulls: gateItems.map((g) => g.assessed),
      met: gateItems.every((g) => g.met),
      decision: gateItems[0]?.lane ?? "user",
      missing: gateItems.find((g) => !g.met)?.missing ?? null,
      readyPassed: null,
    },
    waits: contributions.flatMap((c) => c.waits),
    resources: contributions.flatMap((c) => c.resources),
    holds: contributions.flatMap((c) => c.holds),
    reasons: contributions.flatMap((c) => c.reasons),
    // `compose` folds contributions only; the liveness also reads rows, so
    // `composeAssessment` overwrites this neutral default.
    liveness: { live: false, idleBase: false, idle: false, stalled: false },
  };
}

/**
 * The resource ids that are live wake sources, the non-hold clauses of the
 * retired live-source predicate (BB-413, C7): the pull watch, a deployment watch in
 * `merged`/`deploying`, a running or parked worker, and an open escalation or
 * need. `open-pull` is the idle resource and `linked-pull`/`waited-pull` are
 * watched resources the typed wait judges, so none of them is a wake source.
 */
const WAKE_RESOURCE_IDS: ReadonlySet<string> = new Set(["pull-watch", "workers", "parked-workers", "escalations", "needs"]);
export const isWakeResource = (id: string): boolean => WAKE_RESOURCE_IDS.has(id) || id.startsWith("deployment:");

/** No own pulls: the composer's idle derivation takes the pull wait from the
 * github contributor's `open-pull` resources, so core names no pull set. */
const NO_OWN_PULLS: ReadonlySet<string> = new Set<string>();

/**
 * BB-399 (C4): the composed idle and stall. BB-400 (C5) makes it the one
 * `assess()` reads. The idle base is `idleInActiveStage`'s rows with the
 * own-pull wait taken from the github contributor's `open-pull` resources, so
 * core names no pull request; a live typed wait suppresses the idle wake. The
 * stall is the `observedStall`/typed-wait rule, with `live` from the rows and
 * the requeue ahead read from the holds contribution. It reads only rows the
 * look already holds, so it adds no store read or source call.
 *
 * BB-412 (C6) adds resources that are watched rather than idle-blocking (a
 * linked pull no worker reported, a live waited pull, a parked worker, a
 * settled deployment) and holds that the idle rule does not read. The idle
 * base therefore reads only the `open-pull` resources; `idleInActiveStage`
 * still reads workers and deployments from its rows, so the new resources
 * leave the idle answer exactly as it was.
 *
 * BB-413 (C7) makes the live-source answer the composed resources and holds,
 * not the retired row helper. The `open-pull` resource is the idle-blocking
 * own-pull wait, not the wake source, so the live scan skips it; the github
 * contributor's `pull-watch` resource is the pull watch (`pullWatchCounts`).
 * A held `hold` behind a `behind`/`stack` and a `merge-behind` are the two
 * hold clauses the retired live-source predicate read.
 */
function composeLiveness(input: AssessmentInput, composed: ComposedAssessment): ComposedAssessment["liveness"] {
  const { binding, observed, workers, escalations, needs, now } = input;
  const idleBase =
    idleInActiveStage(
      {
        stage: binding.stage,
        ending: binding.ending,
        hold: binding.hold,
        deployments: binding.deployments,
        requeueUntil: binding.requeueUntil,
        workers,
        ownPulls: NO_OWN_PULLS,
        escalations,
        needs,
      },
      observed,
      now,
    ) && !composed.resources.some((r) => r.id.startsWith("open-pull:") && r.active);
  // A binding has at most one stored typed wait, so the composed waits hold at
  // most that one item.
  const typedWait = composed.waits[0] ?? null;
  const waitLive = typedWait === null ? null : typedWait.live;
  const dateAhead = composed.holds.some((h) => h.id === "requeue" && h.held);
  const held = (id: string): boolean => composed.holds.some((h) => h.id === id && h.held);
  const resourceLive = composed.resources.some((r) => r.active && isWakeResource(r.id));
  const holdLive = held("merge-behind") || (held("hold") && (held("behind") || held("stack")));
  const live = resourceLive || holdLive;
  return {
    live,
    idleBase,
    idle: typedWait !== null && waitLive === true ? false : idleBase,
    stalled: typedWait === null ? observedStall(binding, live, now) : !live && waitLive !== true && !dateAhead,
  };
}

/** The composition for one binding, from the rows the look already holds. */
export function composeAssessment(input: AssessmentInput): ComposedAssessment {
  const composed = compose(CONTRIBUTORS.map((c) => c.contribute(input)));
  composed.gate.readyPassed = gateState(input.playbook, input.binding.ready, input.currentSpecHash).passed;
  composed.liveness = composeLiveness(input, composed);
  return composed;
}
