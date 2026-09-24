// Who is reviewing a PR and where each one stands, for the marks on a Board
// row. Pure, so the derivation is tested apart from the React that draws it.
import type { Pr } from "./contract.js";

export type ReviewerState = "changes" | "pending" | "commented" | "approved";

export type Reviewer = { login: string; state: ReviewerState };

/** The mark beside each reviewer, and the words the hover uses for it. */
export const REVIEWER_MARK: Record<ReviewerState, string> = {
  approved: "✓",
  changes: "✗",
  commented: "💬",
  pending: "○",
};

export const REVIEWER_WORDS: Record<ReviewerState, string> = {
  approved: "approved",
  changes: "changes requested",
  commented: "commented",
  pending: "review requested",
};

const FROM_REVIEW: Record<string, ReviewerState> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
};

/** What needs attention first: a block, then a wait, then talk, then a yes. */
const ORDER: readonly ReviewerState[] = ["changes", "pending", "commented", "approved"];

/**
 * Each reviewer's current state. A requested review is pending even when the
 * reviewer reviewed before, because re-requesting asks for a fresh look.
 * Dismissed and unsubmitted reviews carry no state. Bots are kept.
 */
export function reviewersOf(pr: Pick<Pr, "latestReviews" | "reviewRequests"> | null): Reviewer[] {
  if (pr === null) return [];
  const byLogin = new Map<string, ReviewerState>();
  for (const review of pr.latestReviews) {
    const state = FROM_REVIEW[review.state];
    if (state !== undefined) byLogin.set(review.login, state);
  }
  for (const login of pr.reviewRequests) byLogin.set(login, "pending");
  return [...byLogin]
    .map(([login, state]) => ({ login, state }))
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
}

/** The first few reviewers shown on the row, and how many the "+N" stands for. */
export function visibleReviewers(reviewers: readonly Reviewer[], max = 3): { shown: Reviewer[]; more: number } {
  return { shown: reviewers.slice(0, max), more: Math.max(0, reviewers.length - max) };
}

/** Two letters for a login: "reader-ada" is RA, a team is its slug's, a bot drops "[bot]". */
export function reviewerInitials(login: string): string {
  const name = (login.split("/").pop() ?? login).replace(/\[bot\]$/u, "");
  const parts = name.split(/[-_.]+/u).filter((part) => part !== "");
  const letters = parts.length > 1 ? parts[0]!.charAt(0) + parts[1]!.charAt(0) : name.slice(0, 2);
  return letters.toUpperCase();
}

/** The hover: every reviewer, one per line, with their state in words. */
export function reviewersLabel(reviewers: readonly Reviewer[]): string {
  return reviewers.map((reviewer) => `${REVIEWER_MARK[reviewer.state]} ${reviewer.login}: ${REVIEWER_WORDS[reviewer.state]}`).join("\n");
}
