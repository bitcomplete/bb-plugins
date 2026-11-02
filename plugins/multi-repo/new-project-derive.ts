/**
 * The New project form's two derivation rules, pulled out of the component so
 * they can be tested without a DOM.
 *
 * Both follow the same promise: a derived field is recomputed until the user
 * edits it, and then left alone. The location has a second way to freeze — a
 * local checkout adopted as the project source — but that freeze is not a
 * user edit: changing the URL clears it, while a hand-typed location survives
 * a URL change.
 */
import { dirFromUrl } from "./names.js";

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
