import { prHoldFor, type PrHolds } from "./pr-holds";
import { isApprovedOpenPr } from "./approval-filter";

type SelectablePr = { url: string; state: string; reviewDecision: string | null };
export const isAdvanceEligible = (pr: SelectablePr, holds: PrHolds = {}): boolean => isApprovedOpenPr(pr) && prHoldFor(pr.url, holds) === null;
export const ADVANCE_SELECTION_LIMIT = 100;
export const advancePrKey = (url: string): string => url.replace(/\/$/u, "").toLowerCase();

/** A changing search never silently adds PRs to the finite selection. */
export function eligibleAdvanceSelection(selected: readonly string[], prs: readonly SelectablePr[], holds: PrHolds = {}): string[] {
  const eligible = new Set(prs.filter((pr) => isAdvanceEligible(pr, holds)).map((pr) => advancePrKey(pr.url)));
  return [...new Set(selected.map(advancePrKey))].filter((url) => eligible.has(url)).slice(0, ADVANCE_SELECTION_LIMIT);
}

/** Select only visible approved PRs, retaining explicit choices hidden by search. */
export function selectVisibleApproved(selected: readonly string[], prs: readonly SelectablePr[], holds: PrHolds = {}): string[] {
  return [...new Set([...selected.map(advancePrKey), ...prs.filter((pr) => isAdvanceEligible(pr, holds)).map((pr) => advancePrKey(pr.url))])].slice(0, ADVANCE_SELECTION_LIMIT);
}

/** Clear this visible section without changing choices in other sections or search results. */
export function clearVisibleSelection(selected: readonly string[], prs: readonly Pick<SelectablePr, "url">[]): string[] {
  const visible = new Set(prs.map((pr) => advancePrKey(pr.url)));
  return selected.filter((url) => !visible.has(advancePrKey(url)));
}

export type AdvanceSelection = { urls: string[]; removed: number };

/** Remove lost approvals durably, so a later reapproval requires a fresh choice. */
export function reconcileAdvanceSelection(selection: AdvanceSelection, prs: readonly SelectablePr[], holds: PrHolds = {}): AdvanceSelection {
  const urls = eligibleAdvanceSelection(selection.urls, prs, holds);
  if (urls.length === selection.urls.length && urls.every((url, index) => url === selection.urls[index])) return selection;
  return { urls, removed: selection.removed + selection.urls.length - urls.length };
}
