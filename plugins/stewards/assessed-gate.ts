// BB-322 (child of BB-291, criterion 1): the one place a pull request's merge
// gate is computed, and the read of the stored per-binding assessment every
// surface uses. `pullGate` is the single `prGate` call site outside the
// assessment module (`assessment.ts` calls `assessedPullGate`, never `prGate`);
// `assessedGate` reads the assessment the reconcile stored and, when it is
// missing or not for the pull's current head sha, computes the pull's gate and
// stores it rather than falling back to a surface's own predicate. A missing
// or stale assessment therefore never counts as met (fail closed).
import { createHash } from "node:crypto";
import { decideForPull, type BigDecision, type DecideMark } from "./decisions.js";
import { prGate, type PrGate, type PrGateOptions, type ProjectApprovalRecord } from "./gate.js";
import { productGateOptions } from "./reconcile.js";
import type { EntitySnapshot } from "./source-contract.js";
import type { Binding } from "./store.js";

/** The single `prGate` call site outside `assessment.ts` (BB-322 criterion 1). */
export function pullGate(entity: EntitySnapshot, options: PrGateOptions = {}): PrGate {
  return prGate(entity, options);
}

/** The gate options for one own pull request: the decide-list mark and the product inputs. */
function gateOptions(binding: Pick<Binding, "kind" | "ready">, entity: EntitySnapshot, mark: DecideMark, projectApprovals: readonly ProjectApprovalRecord[]): PrGateOptions {
  return { decision: mark, projectApprovals, ...productGateOptions(binding, entity) };
}

/**
 * A fingerprint of everything `prGate` reads for one pull request. The stored
 * assessment is reused only when it carries this same fingerprint, so a
 * reviewer marker, an approval, a check result or the base state that changed
 * at the same head sha is never read as the old answer (BB-210).
 */
export function gateInputKey(binding: Pick<Binding, "kind" | "ready">, entity: EntitySnapshot, mark: DecideMark, projectApprovals: readonly ProjectApprovalRecord[]): string {
  return createHash("sha1").update(JSON.stringify({ entity, options: gateOptions(binding, entity, mark, projectApprovals) })).digest("hex");
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
export function assessedPullGate(binding: Pick<Binding, "kind" | "ready">, entity: EntitySnapshot, mark: DecideMark, projectApprovals: readonly ProjectApprovalRecord[]): PrGate {
  const options = gateOptions(binding, entity, mark, projectApprovals);
  const probe = pullGate(entity, options);
  return mark === "project" && probe.ownerApproved && !probe.projectApproved ? pullGate(entity, { ...options, decision: "user" }) : probe;
}

/** The full gate stored per own pull request, plus the key and input fingerprint it names. */
export type StoredGate = PrGate & { pull: string; met: boolean; key: string };

/** The gate half of a stored assessment, as `store.assessment` returns it. */
export type StoredAssessmentGate = {
  pulls?: StoredGate[];
  met?: boolean;
  decision?: DecideMark;
  missing?: string | null;
  readyPassed?: boolean | null;
};

/** The store reads the assessment read/refresh needs. */
export type AssessmentStore = {
  assessment(bindingId: string): { gate: unknown; worker: unknown; liveness: unknown } | null;
  recordAssessment(fields: { bindingId: string; at: number; gate: unknown; worker: unknown; liveness: unknown }): void;
  projectApprovals(bindingId: string): readonly ProjectApprovalRecord[];
};

const lc = (s: string | null | undefined): string => (s ?? "").toLowerCase();

/** The per-pull gates a stored assessment holds, or an empty list. */
export function storedGates(gate: unknown): StoredGate[] {
  const pulls = (gate as StoredAssessmentGate | null | undefined)?.pulls;
  return Array.isArray(pulls) ? pulls : [];
}

/** The stored gate entry for a pull request, whatever head sha it names, or null. */
export function storedPullGate(gate: unknown, pull: EntitySnapshot): StoredGate | null {
  const pulls = (gate as StoredAssessmentGate | null | undefined)?.pulls;
  if (!Array.isArray(pulls)) return null;
  const key = lc(pull.key);
  const url = lc(pull.url);
  return pulls.find((p) => lc(p.pull) === key || (url !== "" && lc(p.pull) === url)) ?? null;
}

/**
 * The stored gate entry for a pull request only when it is for the pull's
 * current head sha; a missing or head-stale assessment returns null and never
 * counts as met (BB-322 limit 3, fail closed).
 */
export function currentStoredGate(gate: unknown, pull: EntitySnapshot): StoredGate | null {
  const found = storedPullGate(gate, pull);
  if (found === null) return null;
  return found.headSha === (pull.pull?.headSha ?? null) ? found : null;
}

/**
 * Read the binding's stored assessment's gate for one pull request, computing
 * and storing it when there is none for the pull's current head sha. This is
 * the single read/refresh site every merge-gate surface goes through; the
 * decide-list mark is the one the last assessment recorded (a head that moved
 * keeps its lane) and, when the pull request was never assessed, the mark its
 * snapshot's changed files give under the binding's decide list (`bigDecisions`,
 * empty means the owner's, fail closed). `forceMark` is the caller's own mark
 * for a fact the stored assessment predates: the forward path passes `user`
 * when the project steward has just forwarded a `project`-entry approval to
 * the owner (BB-322 round 2), so the key changes and the read refreshes.
 */
export function assessedGate(store: AssessmentStore, binding: Binding, pull: EntitySnapshot, at: number, bigDecisions: readonly BigDecision[] = [], forceMark?: DecideMark): PrGate {
  const row = store.assessment(binding.id);
  const known = storedPullGate(row?.gate, pull);
  // BB-322 owner review: the stored decide mark is reused only while the head
  // is unchanged. A push can add a file that moves the pull between the owner's
  // and the project steward's lane, so a moved head re-derives the mark from
  // the snapshot's files. A caller without the decide list then gets the
  // owner's mark (fail closed), never a stale `project` that a recorded project
  // approval would let a merge path act on before the next reconcile.
  const sameHead = known !== null && known.headSha === (pull.pull?.headSha ?? null);
  const mark: DecideMark = forceMark ?? (sameHead ? known!.decision : decideForPull(pull.pull?.files ?? null, bigDecisions));
  const projectApprovals = store.projectApprovals(binding.id);
  const key = gateInputKey(binding, pull, mark, projectApprovals);
  // Reuse the stored answer only when it is for this pull request's current
  // head sha and every gate input is unchanged; otherwise recompute through
  // the single site and store it (fail closed: a missing or stale assessment
  // never counts as met).
  if (known !== null && known.headSha === (pull.pull?.headSha ?? null) && known.key === key) return known;
  const gate = assessedPullGate(binding, pull, mark, projectApprovals);
  const entry: StoredGate = { ...gate, pull: pull.key, met: gate.gateMet, key };
  const stored = (row?.gate as StoredAssessmentGate | null | undefined) ?? {};
  const pulls = Array.isArray(stored.pulls) ? [...stored.pulls] : [];
  const index = pulls.findIndex((p) => lc(p.pull) === lc(pull.key));
  if (index >= 0) pulls[index] = entry;
  else pulls.push(entry);
  const gateState: StoredAssessmentGate = {
    ...stored,
    pulls,
    met: pulls.every((p) => p.met),
    decision: pulls[0]?.decision ?? "user",
    missing: pulls.find((p) => !p.met)?.missing ?? null,
    readyPassed: stored.readyPassed ?? null,
  };
  store.recordAssessment({ bindingId: binding.id, at, gate: gateState, worker: row?.worker ?? null, liveness: row?.liveness ?? null });
  return gate;
}
