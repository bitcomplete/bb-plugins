type ReviewerFacts<T> = { reviewRequests: readonly string[]; latestReviews: readonly T[] };

/** Reviewers who requested changes or had their review dismissed, and haven't been asked again. */
export function awaitingRerequest<T extends { login: string; state: string }>(reviewers: ReviewerFacts<T>): T[] {
  const requested = new Set(reviewers.reviewRequests.map((login) => login.toLowerCase()));
  return reviewers.latestReviews.filter((review) =>
    ["CHANGES_REQUESTED", "DISMISSED"].includes(review.state) && !requested.has(review.login.toLowerCase()));
}

/**
 * You answered this review since: a push, or a reply of yours on the PR, after it. An answered change request asks only that you ask again;
 * GitHub's decision still holds the merge until the reviewer comes back. An undated review is never answered.
 */
export function answeredSince(review: { submittedAt?: string }, facts: { headCommittedAt?: string; reviewFeedback?: { repliedAt: string | null } }): boolean {
  const at = Date.parse(review.submittedAt ?? "");
  return [facts.headCommittedAt, facts.reviewFeedback?.repliedAt].some((answer) => answer != null && Date.parse(answer) > at);
}
