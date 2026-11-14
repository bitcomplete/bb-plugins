// BB-335 (BB-291 criterion 3): the non-actions. `syncNeeds` and
// `reconcileOnce` have many early returns that decline to act and record
// nothing, so the owner cannot tell "decided not to act" from "never looked".
// This module is the closed table of reason codes: every declining branch in
// those two functions names one, plus the two cases the owner called out, the
// binding-ended close (`finishEnding`) and the spec-decline close in
// `syncNeeds`. Each code has one short text, rendered with the day it was
// recorded, so the card, `bb stewards show` and the digest can show why a
// binding was not acted on without reading a transcript.
//
// It is data only: a code, its text, and the pure merge that keeps the latest
// reason per code. Recording appends a reason; it changes nothing about what a
// branch decides.
import { z } from "zod";

/**
 * The closed set of reasons a declining branch records. Adding a branch means
 * adding a code here and its text below; the record stores the code, so the
 * set is the inventory of declines. The two `*-closed` codes are the owner's
 * named cases: `binding-ended-closed` is `finishEnding` resolving an ended
 * binding's open items, and `needs-decline-closed` is `syncNeeds` closing a
 * spec-approval item because the spec was declined.
 */
export const NON_ACTION_CODES = [
  // reconcileOnce: before the assessment.
  "config-unreadable",
  "project-disabled",
  "no-playbook",
  "entity-unreadable",
  "entity-gone",
  "stay-ended",
  "other-binding-open",
  "ending-in-progress",
  "follow-through-ran-out",
  // reconcileOnce: after the assessment.
  "nothing-to-do",
  "deferred",
  "worker-busy",
  // syncNeeds: the per-pull-request declines.
  "pull-foreign-owner",
  "pull-closed",
  "merge-held",
  "retarget-needed",
  "merge-steward-filed",
  "worker-running",
  "merge-paused",
  "parked-owns-another",
  "base-not-default",
  "merge-refused",
  "head-moved",
  "gate-not-met",
  // The owner's two named cases.
  "binding-ended-closed",
  "needs-decline-closed",
] as const;

export type NonActionCode = (typeof NON_ACTION_CODES)[number];

const codeSet = new Set<string>(NON_ACTION_CODES);
/** Whether `value` is one of the closed reason codes. */
export const isNonActionCode = (value: string): value is NonActionCode => codeSet.has(value);

/**
 * The one-line text for each code. `detail` is an optional binding-specific
 * fact (a pull request's key, the end reason); `day` is the recorded date
 * (YYYY-MM-DD). Kept short: it renders inside a card row.
 */
const NON_ACTION_TEXT: Record<NonActionCode, (detail: string | null, day: string) => string> = {
  "config-unreadable": () => "Could not read the project configuration; left for the next sweep",
  "project-disabled": () => "The project is switched off on this server",
  "no-playbook": () => "No playbook applies to this binding",
  "entity-unreadable": () => "Could not read the entity from its source",
  "entity-gone": () => "The entity is gone from its source",
  "stay-ended": () => "Ended and staying ended",
  "other-binding-open": () => "Another project already holds this entity open",
  "ending-in-progress": () => "The binding is ending; its last turn is under way",
  "follow-through-ran-out": () => "The follow-through turn ran out",
  "nothing-to-do": () => "Nothing actionable changed this look",
  deferred: () => "Deferred: stewards are paused or the binding is on hold",
  "worker-busy": () => "The steward's thread is busy; the news waits for the next turn",
  "pull-foreign-owner": (d) => `The pull request${d === null ? "" : ` ${d}`} belongs to another ticket`,
  "pull-closed": (d) => `The pull request${d === null ? "" : ` ${d}`} is closed`,
  "merge-held": (d) => `The merge${d === null ? "" : ` of ${d}`} is held behind other work`,
  "retarget-needed": (d) => `The pull request${d === null ? "" : ` ${d}`} needs a retarget after its base merged`,
  "merge-steward-filed": (d) => `A steward-filed Merge item${d === null ? "" : ` for ${d}`} is open`,
  "worker-running": () => "A worker's turn is in progress; it acts on the pull request",
  "merge-paused": () => "Stewards are paused; the plugin files no merge",
  "parked-owns-another": () => "A parked worker owns another open pull request of this ticket",
  "base-not-default": (d) => `The pull request${d === null ? "" : ` ${d}`} is based on a branch that is not the default`,
  "merge-refused": (d) => `GitHub refused the merge${d === null ? "" : ` of ${d}`}`,
  "head-moved": (d) => `The head moved between the look and the merge${d === null ? "" : ` of ${d}`}`,
  "gate-not-met": (d) => `The merge gate${d === null ? "" : ` for ${d}`} is not met`,
  "binding-ended-closed": (d, day) => `Closed because the binding ended (${d ?? "ended"}, ${day})`,
  "needs-decline-closed": (d, day) => `Closed the spec approval because the spec was declined${d === null ? "" : ` (${d})`} (${day})`,
};

/** The UTC day (YYYY-MM-DD) a moment falls in, so a reason's date rolls at midnight UTC. */
export function nonActionDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * One recorded reason: the code is the key in the stored object, `date` is the
 * UTC day it was last recorded, and `text` is the rendered one-line reason.
 */
export const nonActionSchema = z.object({ date: z.string(), text: z.string() });
export type NonAction = z.infer<typeof nonActionSchema>;

/**
 * The latest reason per code, keyed by code. The closed code set bounds it, so
 * it needs no separate cap.
 */
export const nonActionsSchema = z.record(z.string(), nonActionSchema);
export type NonActions = z.infer<typeof nonActionsSchema>;

/** One code and its optional detail, as a declining branch hands it to the store. */
export type NonActionInput = { code: NonActionCode; detail?: string | null };

/** Render the one-line text for a code and detail at a moment. */
export function nonActionText(code: NonActionCode, detail: string | null, at: number): string {
  return NON_ACTION_TEXT[code](detail, nonActionDay(at));
}

/**
 * Merge one reason into the stored set: the entry for `code` is replaced with
 * the day and text, or left exactly as it is when the code was already
 * recorded on the same day (so a tick that declines the same way writes
 * nothing). Pure, so a test and the store's SQL merge can both rely on it.
 */
export function mergeNonAction(current: NonActions, code: NonActionCode, detail: string | null, at: number): NonActions {
  const entry: NonAction = { date: nonActionDay(at), text: nonActionText(code, detail, at) };
  const before = current[code];
  if (before !== undefined && before.date === entry.date && before.text === entry.text) return current;
  return { ...current, [code]: entry };
}

/** The stored reasons, newest day first, for a card, `bb stewards show` or the digest. */
export function sortedNonActions(nonActions: NonActions): Array<NonAction & { code: NonActionCode }> {
  return Object.entries(nonActions)
    .filter((entry): entry is [NonActionCode, NonAction] => isNonActionCode(entry[0]))
    .map(([code, action]) => ({ code, ...action }))
    .sort((a, b) => (a.date === b.date ? a.code.localeCompare(b.code) : b.date.localeCompare(a.date)));
}
