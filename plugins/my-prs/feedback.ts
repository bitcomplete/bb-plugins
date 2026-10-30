import { createHash } from "node:crypto";
import { isBot } from "./feedback-to-address.js";
import { yourTurn } from "./your-turn.js";
import type { Comment, Metadata, Review, ReviewThread } from "./github.js";
import type { PullRequest } from "./types.js";

// Workstreams' reviewFeedbackOf, over validated GraphQL data.
export function feedbackOf({ pr, reviews, comments, threads, requested }: {
  pr: Metadata; reviews: Review[]; comments: Comment[]; threads: ReviewThread[]; requested: string[];
}): PullRequest {
  const me = pr.author?.login.toLowerCase();
  const person = (author: Comment["author"]) => author && !isBot(author.login, author.__typename) ? author.login.toLowerCase() : null;
  const submitted = reviews.filter((review) => review.state !== "PENDING" && review.submittedAt !== null)
    .sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
  const latest = new Map<string, Review>();
  const decided = new Map<string, Review>();
  for (const review of submitted) {
    const who = person(review.author);
    if (!who || who === me) continue;
    latest.set(who, review);
    if (review.state !== "COMMENTED") decided.set(who, review);
  }
  const approvals = submitted.filter((review) => review.state === "APPROVED" && person(review.author) !== null && person(review.author) !== me);
  const approvalIds = new Set(approvals.map((review) => review.id));
  const approvalThreads = new Map(threads.flatMap((thread) => {
    const first = thread.comments.nodes[0];
    return first?.pullRequestReview && approvalIds.has(first.pullRequestReview.id) ? [[thread.id, person(first.author)]] : [];
  }));
  const notes = [
    ...approvals.flatMap((review) => review.body.trim() && review.submittedAt ? [review.submittedAt] : []),
    ...threads.flatMap((thread) => thread.comments.nodes.flatMap((comment) =>
      approvalThreads.get(thread.id) === person(comment.author) && person(comment.author) !== null ? [comment.createdAt] : [])),
  ];
  const said: { login: string; at: string }[] = [];
  const replies: string[] = [];
  const hear = (author: Comment["author"], at: string) => {
    const who = person(author);
    if (!who) return;
    if (who === me) { replies.push(at); return; }
    const approval = decided.get(who);
    if (approval?.state === "APPROVED" && (approval.submittedAt ?? "") >= at) return;
    said.push({ login: author?.login ?? who, at });
  };
  for (const review of submitted) {
    if (review.submittedAt && (person(review.author) === me || (review.body.trim() && !approvalIds.has(review.id)))) hear(review.author, review.submittedAt);
  }
  for (const thread of threads) for (const comment of thread.comments.nodes) {
    if (person(comment.author) !== me && approvalThreads.get(thread.id) === person(comment.author)) continue;
    hear(comment.author, comment.createdAt);
  }
  for (const comment of comments) hear(comment.author, comment.createdAt);
  const last = said.sort((a, b) => b.at.localeCompare(a.at))[0];
  const openThreads = threads.filter((thread) => {
    const last = thread.comments.nodes.map((comment) => person(comment.author)).filter((who) => who !== null).at(-1);
    return !thread.isResolved && last !== undefined && last !== me;
  }).length;
  const turn = yourTurn({
    state: "OPEN", reviewRequests: requested,
    latestReviews: [...latest.values()].map((review) => ({ login: review.author?.login ?? "", state: review.state,
      ...(review.submittedAt ? { submittedAt: review.submittedAt } : {}) })),
    headCommittedAt: pr.commits.nodes[0]?.commit.committedDate,
    approvalFeedback: { status: notes.length ? "present" : "none" },
    reviewFeedback: { openThreads, comment: last ?? null, repliedAt: replies.sort().at(-1) ?? null, noteAt: notes.sort().at(-1) ?? null },
  });
  const human = (author: Comment["author"]) => person(author) !== null && person(author) !== me;
  const activity = createHash("sha256").update(JSON.stringify({ head: pr.headRefOid,
    reviews: submitted.filter((review) => human(review.author)),
    comments: comments.filter((comment) => human(comment.author)),
    threads: threads.filter((thread) => thread.comments.nodes.some((comment) => human(comment.author))).map((thread) => ({ id: thread.id, resolved: thread.isResolved, comments: thread.comments.nodes.filter((comment) => human(comment.author)) })),
  })).digest("hex");
  return { id: pr.id, repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url,
    head: pr.headRefOid, branch: pr.headRefName, draft: pr.isDraft, updatedAt: pr.updatedAt, activity, turn,
    status: { reviewDecision: pr.reviewDecision, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus,
      checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null } };
}
