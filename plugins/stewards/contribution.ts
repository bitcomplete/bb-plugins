// BB-380 (BB-291 criterion 8, slice C2): the per-source contribution
// interface and the composer. BB-387 (C3) makes the composer's gate the one
// `assess()` returns: the github contributor owns the pull merge gate
// (`pullGate`, `gateInputKey`, `assessedPullGate`, the BB-321 forwarded-owner
// rule) and `assess()` composes its `merge` items. The waits, resources, holds
// and reasons are still shadow — the reconcile computes them beside the
// assessment and `compare` records any divergence through the existing
// divergence log (BB-293).
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
  ownPullEntities,
  pullIsOpen,
  typedWaitLive,
  waitFingerprint,
  waitOverdueMs,
} from "./assessment.js";
import type { AssessedGate, Assessment, AssessmentInput, DecideMark } from "./assessment.js";
import { waitBudgetMs } from "./config.js";
import { prGate, type PrGate, type PrGateOptions, type ProjectApprovalRecord } from "./gate.js";
import { productGateOptions } from "./reconcile.js";
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

/** One resource a source contributes: something active keeps the binding from being idle. */
export type ResourceContribution = {
  source: ContributionSource;
  /** `open-pull:<key>`, `workers`, `deployment:<key>`, … */
  id: string;
  active: boolean;
  subject: ContributionSubject | null;
};

/** One hold a source contributes, wrapping the binding's hold, ending and requeue. */
export type HoldContribution = {
  source: ContributionSource;
  /** `hold`, `ending`, `requeue`, `merge-behind` or `stack`. */
  id: string;
  held: boolean;
  behind: readonly string[];
};

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

/** The composed answer, beside `assess()`. `gate` is exactly `Assessment["gate"]`. */
export type ComposedAssessment = {
  gate: Assessment["gate"];
  waits: readonly WaitContribution[];
  resources: readonly ResourceContribution[];
  holds: readonly HoldContribution[];
  reasons: readonly Reason[];
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

/** The binding's holds, wrapping the fields `idleInActiveStage` reads today. */
function bindingHolds(source: ContributionSource, input: AssessmentInput): HoldContribution[] {
  const b = input.binding;
  const holds: HoldContribution[] = [];
  if (b.hold !== null) holds.push({ source, id: "hold", held: true, behind: [] });
  if (b.ending !== null) holds.push({ source, id: "ending", held: true, behind: [] });
  if (b.requeueUntil !== null) holds.push({ source, id: "requeue", held: b.requeueUntil > input.now, behind: [] });
  return holds;
}

/** What one entity source contributes: its typed wait (the non-pull kinds) and the binding's holds. */
function entityContribution(source: ContributionSource, input: AssessmentInput): SourceContribution {
  if (input.observed.entity.source !== source) return empty(source);
  const wait = input.binding.wait ?? null;
  const waits: WaitContribution[] = [];
  if (wait !== null && !PULL_WAIT_KINDS.has(wait.kind)) {
    const w = waitContribution(source, input);
    if (w !== null) waits.push(w);
  }
  return { source, gate: [], waits, resources: [], holds: bindingHolds(source, input), reasons: [] };
}

/** The pull request contributions: the merge gate items, the open-pull resources and the pull/review/deployment wait. */
function pullContributions(input: AssessmentInput): { gate: GateContribution[]; waits: WaitContribution[]; resources: ResourceContribution[]; reasons: Reason[] } {
  const { binding, observed, ownPulls, decisions, projectApprovals, escalations } = input;
  const gatePulls = input.gatePulls ?? ownPulls;
  const gate: GateContribution[] = [];
  const resources: ResourceContribution[] = [];
  const reasons: Reason[] = [];
  for (const e of ownPullEntities(observed, gatePulls)) {
    const decideMark = decisions.get(lc(e.key)) ?? "user";
    const mark: DecideMark = decideMark === "project" && forwardedToOwner(escalations, e) ? "user" : decideMark;
    const remembered = rememberedFor(input.rememberedRequesters, e);
    const reRequested = rememberedFor(input.reRequestedDelegates, e);
    const g: PrGate = assessedPullGate(binding, e, mark, projectApprovals, remembered, reRequested);
    const inputs = gateInputKey(binding, e, g.decision, projectApprovals, remembered, reRequested);
    const assessed: AssessedGate = { ...g, pull: e.key, met: g.gateMet, key: inputs };
    gate.push({ source: "github", subject: { kind: "pull", id: e.key }, id: "merge", met: g.gateMet, missing: g.missing, lane: g.decision, escalated: g.escalated, product: g.reason === "product", inputs, assessed });
    resources.push({ source: "github", id: `open-pull:${lc(e.key)}`, active: pullIsOpen(e) && !g.gateMet, subject: { kind: "pull", id: e.key } });
    if (!g.gateMet && g.missing !== null) reasons.push({ source: "github", code: "gate-not-met", detail: g.missing, at: input.now });
  }
  const wait = input.binding.wait ?? null;
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
      resources: pull.resources,
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
      // The roll-up reads the contribution fields, not the wrapped gate, so a
      // composer that disagrees with today's gate is visible to `compare`.
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
  };
}

/** The shadow composition for one binding, from the rows the look already holds. */
export function composeAssessment(input: AssessmentInput): ComposedAssessment {
  const composed = compose(CONTRIBUTORS.map((c) => c.contribute(input)));
  composed.gate.readyPassed = gateState(input.playbook, input.binding.ready, input.currentSpecHash).passed;
  return composed;
}

/**
 * BB-387 (C3): the one gate `assess()` composes. The pull `merge` items come
 * from the github contributor and core folds them with `compose`; the ready
 * gate stays core and is filled here. Nothing pull-specific is named.
 */
export function composeGate(input: AssessmentInput): Assessment["gate"] {
  return composeAssessment(input).gate;
}
