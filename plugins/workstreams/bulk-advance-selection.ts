import { isApprovedOpenPr } from "./approval-filter";

type SelectablePr = { url: string; state: string; reviewDecision: string | null };
export const ADVANCE_SELECTION_LIMIT = 100;
export const advancePrKey = (url: string): string => url.replace(/\/$/u, "").toLowerCase();

/** A changing search never silently adds PRs to the finite selection. */
export function eligibleAdvanceSelection(selected: readonly string[], prs: readonly SelectablePr[]): string[] {
  const eligible = new Set(prs.filter(isApprovedOpenPr).map((pr) => advancePrKey(pr.url)));
  return [...new Set(selected.map(advancePrKey))].filter((url) => eligible.has(url)).slice(0, ADVANCE_SELECTION_LIMIT);
}

/** Select only visible approved PRs, retaining explicit choices hidden by search. */
export function selectVisibleApproved(selected: readonly string[], prs: readonly SelectablePr[]): string[] {
  return [...new Set([...selected.map(advancePrKey), ...prs.filter(isApprovedOpenPr).map((pr) => advancePrKey(pr.url))])].slice(0, ADVANCE_SELECTION_LIMIT);
}

export type AdvanceSelection = { urls: string[]; removed: number };

/** Remove lost approvals durably, so a later reapproval requires a fresh choice. */
export function reconcileAdvanceSelection(selection: AdvanceSelection, prs: readonly SelectablePr[]): AdvanceSelection {
  const urls = eligibleAdvanceSelection(selection.urls, prs);
  if (urls.length === selection.urls.length && urls.every((url, index) => url === selection.urls[index])) return selection;
  return { urls, removed: selection.removed + selection.urls.length - urls.length };
}
