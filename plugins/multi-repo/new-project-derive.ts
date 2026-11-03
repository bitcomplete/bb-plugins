/**
 * The New project form's derivation and gate rules, pulled out of the
 * component so they can be tested without a DOM.
 *
 * The name and location follow the same promise: a derived field is
 * recomputed until the user edits it, and then left alone. The location has a
 * second way to freeze — a local checkout adopted as the project source — but
 * that freeze is not a user edit: changing the URL clears it, while a
 * hand-typed location survives a URL change.
 *
 * The probe is the form's gate: nothing beyond the URL field is shown until it
 * answers, and Create stays disabled until then. The probe's outcome is also
 * the whole source the host is asked to build — a remote is cloned, a local
 * checkout is adopted — so the form never submits the host-side `auto` that
 * used to re-probe on submit.
 */
import { dirFromUrl } from "./names.js";
import type { ProbeRemoteResult } from "./contract.js";

/** The name a URL derives, unless the user has edited it. */
export function deriveName(url: string, current: string, edited: boolean): string {
  return edited ? current : dirFromUrl(url) ?? "";
}

/**
 * True when the location must not be recomputed from the name: the user typed
 * it, or it was adopted from a local checkout.
 */
export function locationFrozen(edited: boolean, adopted: boolean): boolean {
  return edited || adopted;
}

/** The form's probe state, as the component tracks it. */
export type ProbeStatus = "idle" | "probing" | "done" | "error";

/** Name, Machine and Location appear only once the probe has answered. */
export function fieldsRevealed(status: ProbeStatus): boolean {
  return status === "done";
}

/**
 * Create is enabled only when the probe has answered and every field it
 * reveals is filled in. A failed or unfinished probe leaves it disabled.
 */
export function createReady(input: {
  submitting: boolean;
  probe: ProbeStatus;
  hostId: string | null;
  name: string;
  path: string;
}): boolean {
  return (
    !input.submitting &&
    fieldsRevealed(input.probe) &&
    input.hostId !== null &&
    input.name.trim().length > 0 &&
    input.path.trim().length > 0
  );
}

/** What the host is asked to build, from the probe's answer. */
export function sourceFromProbe(
  outcome: ProbeRemoteResult["outcome"],
  url: string,
): { kind: "clone"; url: string } | { kind: "checkout"; url: string } {
  return outcome === "checkout" ? { kind: "checkout", url } : { kind: "clone", url };
}
