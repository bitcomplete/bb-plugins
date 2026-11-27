// BB-333 (criterion 4 of BB-291): the typed wait on `steward_report`. A wait is
// a closed kind plus a reference; free text stays the human annotation. This
// module owns the kind set, the report input schema, the named refusals and the
// self / unvalidatable downgrade to `external`.
//
// It derives nothing: PR 1 only validates, stores and renders the wait. The
// liveness, idle and stall derivation from the kind is PR 2, in the composer
// (`composeLiveness`) and read through `derivedStalled`.
import { z } from "zod";
import { parsePullRef } from "./github.js";
import { parseUntil } from "./wake-source.js";

/**
 * The closed kind set. `pull` and `review` name a pull request and are leased
 * beside the ticket's linked pulls in PR 2; `deployment`, `worker`, `binding`,
 * `date` and `person` resolve against rows the plugin already holds; `external`
 * is a well-formed wait nothing the plugin tracks will deliver.
 */
export const WAIT_KINDS = ["pull", "review", "deployment", "worker", "binding", "date", "person", "external"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];
const WAIT_KIND_SET: ReadonlySet<string> = new Set(WAIT_KINDS);

/** A stored typed wait: the closed kind and its reference. */
export const waitSchema = z.object({ kind: z.enum(WAIT_KINDS), ref: z.string().trim().min(1).max(500) });
export type Wait = z.infer<typeof waitSchema>;

/**
 * The `steward_report` wait input. `kind` is a plain string, not the enum, so
 * an unknown one is the named `unknown_kind` refusal rather than a zod type
 * error; `ref` is optional so a missing one is the named `missing_reference`
 * refusal. Both are checked in `validateWait`, only when a `wait` is sent.
 */
export const waitInputSchema = z.object({
  kind: z.string().trim().min(1).max(40),
  ref: z.string().trim().max(500).optional(),
});
export type WaitInput = z.infer<typeof waitInputSchema>;

/** The named validation cases. The first four are hard refusals; the last two downgrade to `external`. */
export const WAIT_REFUSALS = ["unknown_kind", "missing_reference", "malformed_reference", "date_wait_without_date", "reference_is_self", "unvalidatable_reference"] as const;
export type WaitRefusal = (typeof WAIT_REFUSALS)[number];

const LINEAR_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/u;
// Plugin ids are `newId`: a prefix and 9 random bytes as base64url, so the
// suffix may contain `-` and `_`.
const WORKER_THREAD = /^thr_[A-Za-z0-9_-]+$/u;
const PAGE_ITEM = /^(?:need|esc|qst)_[A-Za-z0-9_-]+$/u;

/** Whether `ref` is a binding entity key: a Linear key (ENG-12) or a pull request key (owner/repo#N). */
export function isEntityKey(ref: string): boolean {
  return LINEAR_KEY.test(ref) || parsePullRef(ref) !== null;
}

/**
 * The context-dependent half of the validation, read from rows the report path
 * already holds. Each answer is a boolean, so the validation itself stays pure
 * and testable; PR 2 adds the live reads that make `pull`/`review` live.
 */
export type WaitContext = {
  /** The ref is the binding's own pull request (its entity, or an own pull). */
  isOwnPull: (key: string) => boolean;
  /** The project watches the repo. */
  isWatchedRepo: (repo: string) => boolean;
  /** A deployment watch exists for the pull request key. */
  hasDeployment: (key: string) => boolean;
  /** A binding with the key exists and has not ended. */
  hasOpenBinding: (key: string) => boolean;
  /** A worker with the thread id is known. */
  hasWorker: (threadId: string) => boolean;
  /** A page item (need_…, esc_…, qst_…) with the id is open. */
  hasOpenItem: (id: string) => boolean;
};

export type WaitValidation = { ok: true; wait: Wait; downgraded: WaitRefusal | null } | { ok: false; refusal: WaitRefusal; message: string };

/** The reader-facing sentence for each named case. The case name leads, so a test can match on it. */
export const WAIT_REFUSAL_MESSAGE: Record<WaitRefusal, string> = {
  unknown_kind: `unknown_kind: kind must be one of ${WAIT_KINDS.join(", ")}.`,
  missing_reference: "missing_reference: a typed wait needs a non-empty ref.",
  malformed_reference: "malformed_reference: the ref does not parse for the kind.",
  date_wait_without_date: "date_wait_without_date: a date wait needs a parseable date in ref, or an until.",
  reference_is_self: "reference_is_self: a pull wait cannot name the binding's own pull request; recorded as external.",
  unvalidatable_reference: "unvalidatable_reference: the ref does not resolve to a live source; recorded as external.",
};

/**
 * Validate one `steward_report { wait }`. Only called when a wait is sent; a
 * report with no wait is never refused here. An unknown kind, a missing or
 * malformed ref, and a date wait with no date are hard refusals (nothing is
 * written). A pull/review ref that is the binding's own, or a well-formed ref
 * the plugin cannot resolve, is accepted and recorded as `external`.
 */
export function validateWait(input: WaitInput, until: string | undefined, ctx: WaitContext): WaitValidation {
  if (!WAIT_KIND_SET.has(input.kind)) return { ok: false, refusal: "unknown_kind", message: WAIT_REFUSAL_MESSAGE.unknown_kind };
  const kind = input.kind as WaitKind;
  const ref = (input.ref ?? "").trim();
  if (ref === "") return { ok: false, refusal: "missing_reference", message: WAIT_REFUSAL_MESSAGE.missing_reference };
  switch (kind) {
    case "pull":
    case "review":
    case "deployment":
      if (parsePullRef(ref) === null) return { ok: false, refusal: "malformed_reference", message: WAIT_REFUSAL_MESSAGE.malformed_reference };
      break;
    case "worker":
      if (!WORKER_THREAD.test(ref)) return { ok: false, refusal: "malformed_reference", message: WAIT_REFUSAL_MESSAGE.malformed_reference };
      break;
    case "binding":
      if (!isEntityKey(ref)) return { ok: false, refusal: "malformed_reference", message: WAIT_REFUSAL_MESSAGE.malformed_reference };
      break;
    case "date":
      // The structured form of `until`: the ref may carry the date, or an
      // `until` in the same report may supply it. Nothing is derived from it.
      if (parseUntil(ref) === null && (until === undefined || parseUntil(until) === null)) return { ok: false, refusal: "date_wait_without_date", message: WAIT_REFUSAL_MESSAGE.date_wait_without_date };
      break;
    case "person":
      if (!PAGE_ITEM.test(ref)) return { ok: false, refusal: "malformed_reference", message: WAIT_REFUSAL_MESSAGE.malformed_reference };
      break;
    case "external":
      break;
  }
  let downgraded: WaitRefusal | null = null;
  switch (kind) {
    case "pull": {
      const parsed = parsePullRef(ref)!;
      const key = `${parsed.repo}#${parsed.number}`;
      if (ctx.isOwnPull(key)) downgraded = "reference_is_self";
      else if (!ctx.isWatchedRepo(parsed.repo)) downgraded = "unvalidatable_reference";
      break;
    }
    case "review": {
      // A review wait on the binding's own pull is valid: the steward is
      // waiting for its review, not for the plugin's own merge action. Only a
      // pull wait on the binding's own pull is unobservable (BB-333 design).
      const parsed = parsePullRef(ref)!;
      if (!ctx.isWatchedRepo(parsed.repo)) downgraded = "unvalidatable_reference";
      break;
    }
    case "deployment": {
      const parsed = parsePullRef(ref)!;
      if (!ctx.hasDeployment(`${parsed.repo}#${parsed.number}`)) downgraded = "unvalidatable_reference";
      break;
    }
    case "worker":
      if (!ctx.hasWorker(ref)) downgraded = "unvalidatable_reference";
      break;
    case "binding":
      if (!ctx.hasOpenBinding(ref)) downgraded = "unvalidatable_reference";
      break;
    case "person":
      if (!ctx.hasOpenItem(ref)) downgraded = "unvalidatable_reference";
      break;
    case "date":
    case "external":
      break;
  }
  const wait: Wait = downgraded === null ? { kind, ref } : { kind: "external", ref };
  return { ok: true, wait, downgraded };
}

/** The one-line render of a stored wait, for `bb stewards show` and the card. */
export function waitPhrase(wait: Wait | null): string | null {
  return wait === null ? null : `${wait.kind} ${wait.ref}`;
}
