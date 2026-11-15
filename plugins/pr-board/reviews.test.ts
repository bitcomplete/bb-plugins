import { expect, it } from "vitest";
import { estimatedMinutes, prsReviewSchema, quickRead, reviewLines } from "./reviews";

const item = { key: "review-followup:node:head", rule: "review-followup", state: "queued", repo: "acme/repo", number: 7,
  title: "Retry lab fetches", author: "example-author", url: "https://github.com/acme/repo/pull/7", baseBranch: "main", headBranch: "retry", headSha: "head", nodeId: "node",
  reason: "Author pushed after your review", noticedAt: "2026-11-15T10:00:00Z", updatedAt: "2026-11-15T10:00:00Z" };
const review = prsReviewSchema.parse({ item, segment: "on-you", agentState: "none", evidence: "Review follow-up on current head", total: { kind: "known", additions: 1000, deletions: 200, files: 10 },
  delta: { kind: "unknown", reason: "No last-reviewed commit is available" }, lastReview: null, resolution: { kind: "unknown", reason: "Not fetched" } });

it("never labels a total diff as a delta when the baseline or compare is unavailable", () => {
  expect(reviewLines(review)).toBeNull();
  expect(quickRead(review)).toBe(false);
  expect(estimatedMinutes(review)).toBeNull();
});

it("uses actual delta with the strict 150 line follow-up threshold and minimum five minute estimate", () => {
  const small = { ...review, delta: { kind: "known" as const, baseSha: "old", headSha: "head", additions: 140, deletions: 9, files: [] } };
  expect(reviewLines(small)).toBe(149);
  expect(quickRead(small)).toBe(true);
  expect(estimatedMinutes(small)).toBe(5);
  expect(quickRead({ ...small, delta: { ...small.delta, deletions: 10 } })).toBe(false);
});

it("uses total size for first reviews, a strict 300 line threshold, and marks completed drafts as quick reads", () => {
  const first = { ...review, item: { ...review.item, rule: "review-requested" as const }, total: { kind: "known" as const, additions: 299, deletions: 0, files: 2 } };
  expect(quickRead(first)).toBe(true);
  expect(estimatedMinutes(first)).toBe(10);
  expect(quickRead({ ...first, total: { ...first.total, additions: 300 } })).toBe(false);
  expect(quickRead({ ...review, agentState: "draft-ready" })).toBe(true);
});
