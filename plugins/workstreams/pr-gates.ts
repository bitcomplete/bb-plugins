// What GitHub's facts say about a PR's merge state and its reviewers, as All PRs' attention, Your turn, and a thread's fixes read them.
// `null` means the facts cannot decide yet: read again.

type MergeFacts = { mergeable: string | null; mergeStateStatus: string };
type ReviewerFacts<T> = { reviewRequests: readonly string[]; latestReviews: readonly T[] };

/** A conflict GitHub reported; mergeability it hasn't computed yet is not one. */
export function conflicted(facts: MergeFacts): boolean {
  return facts.mergeable === "CONFLICTING" || facts.mergeStateStatus === "DIRTY";
}

/** GitHub would merge this now; null while it is still computing. */
export function mergeClean(facts: MergeFacts): boolean | null {
  return facts.mergeable === "UNKNOWN" || facts.mergeStateStatus === "UNKNOWN" ? null :
    facts.mergeable === "MERGEABLE" && ["CLEAN", "HAS_HOOKS"].includes(facts.mergeStateStatus);
}

/** Someone was asked to review, or reviewed. gh's latestReviews carries no commit, so any submitted review counts as engagement. */
export function reviewEngaged(reviewers: ReviewerFacts<{ state: string }>): boolean {
  return reviewers.reviewRequests.length > 0 || reviewers.latestReviews.some((review) => review.state !== "PENDING");
}

/** GitHub no longer asks for changes, or the author's verified follow-up answers them on a newer head. */
export function changesAddressed(facts: { reviewDecision: string | null; reviewFollowupPosted?: boolean }): boolean {
  return facts.reviewDecision !== "CHANGES_REQUESTED" || facts.reviewFollowupPosted === true;
}

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
