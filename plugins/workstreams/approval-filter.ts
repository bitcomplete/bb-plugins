/** Approval is a review decision, independently of checks, comments, or branch readiness. */
export function isApprovedOpenPr(pr: { state: string; reviewDecision: string | null } | null): boolean {
  return pr?.state === "OPEN" && pr.reviewDecision === "APPROVED";
}

export function matchesApprovedFilter(pr: Parameters<typeof isApprovedOpenPr>[0], approvedOnly: boolean): boolean {
  return !approvedOnly || isApprovedOpenPr(pr);
}

/** Multiple checkouts and the remote inventory can describe the same PR. */
export function countApprovedOpenPrs(prs: readonly ({ state: string; reviewDecision: string | null; url: string } | null)[]): number {
  return new Set(prs.filter((pr) => isApprovedOpenPr(pr)).map((pr) => pr!.url.replace(/\/$/u, "").toLowerCase())).size;
}
