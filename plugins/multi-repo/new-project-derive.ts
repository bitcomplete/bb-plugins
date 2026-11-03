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
 * The probe is the form's gate. Name, Machine and Location appear only after
 * the URL's own probe answers, and Create is enabled only while that probe's
 * answer is current. A re-probe after a machine change keeps the fields
 * visible (there is nothing to hide, and hiding the Machine select would trap
 * the user on a machine that cannot read the remote), but Create stays
 * disabled until it answers. The probe's outcome is also the whole source the
 * host is asked to build — a remote is cloned, a local checkout is adopted —
 * so the form never submits the host-side `auto` that used to re-probe on
 * submit.
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

/**
 * Whether Name, Machine and Location are shown. Once the URL's own probe has
 * answered they stay shown — a machine-change re-probe must not unmount the
 * Machine select it is running for — while a URL change hides them again.
 */
export function fieldsRevealed(revealed: boolean, status: ProbeStatus): boolean {
  return revealed || status === "done";
}

/**
 * Create is enabled only when the probe for the current URL and machine has
 * answered and every field it reveals is filled in. A re-probe disables it
 * until it answers; a failed or unfinished first probe leaves the fields
 * hidden and it disabled.
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
    input.probe === "done" &&
    input.hostId !== null &&
    input.name.trim().length > 0 &&
    input.path.trim().length > 0
  );
}

/**
 * Whether a blur or Enter should probe. A URL and machine the last answered
 * probe already covers is skipped, so clicking a revealed field does not
 * start a probe that unmounts it under the cursor.
 */
export function probeNeeded(
  last: { url: string; hostId: string } | null,
  url: string,
  hostId: string | null,
): boolean {
  if (hostId === null || url.length === 0) return false;
  return last === null || last.url !== url || last.hostId !== hostId;
}

/** What the host is asked to build, from the probe's answer. */
export function sourceFromProbe(
  outcome: ProbeRemoteResult["outcome"],
  url: string,
): { kind: "clone"; url: string } | { kind: "checkout"; url: string } {
  return outcome === "checkout" ? { kind: "checkout", url } : { kind: "clone", url };
}
