// The product logic of review-watch: which pull requests earn a place in the
// queue, and how a fresh poll folds into the queue a human has already acted on.
// Pure functions only — no I/O, no SDK, so every rule is testable as data in and
// data out.
import { itemKey, type PullRequest, type QueueItem, type Rule } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isBefore(earlier: string, later: string): boolean {
  return Date.parse(earlier) < Date.parse(later);
}

/** An empty allowlist means the user has not narrowed the watch at all. */
function repoAllowed(repo: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((allowed) => allowed.toLowerCase() === repo.toLowerCase());
}

function toItem(
  pr: PullRequest,
  rule: Rule,
  reason: string,
  now: string,
): QueueItem {
  return {
    key: itemKey(rule, pr.nodeId, pr.headSha),
    rule,
    state: "queued",
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    author: pr.author,
    url: pr.url,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    headSha: pr.headSha,
    nodeId: pr.nodeId,
    reason,
    noticedAt: now,
    updatedAt: pr.updatedAt,
    reviewBaselineSubmittedAt: pr.myLastReview?.submittedAt ?? null,
  };
}

/** The one item a pull request justifies, or null. */
function itemFor(pr: PullRequest, login: string, now: string): QueueItem | null {
  // My own pull request never queues: a later push does not ask me to review
  // my own changes, and Workstreams owns the feedback on it as "Your turn".
  if (pr.author === login) return null;

  // A draft is not ready for anyone else's eyes, so neither reviewer rule fires.
  if (pr.isDraft) return null;

  const reviewedBeforeHead =
    pr.myLastReview !== null && isBefore(pr.myLastReview.submittedAt, pr.headCommittedAt);

  const requested = pr.requestedReviewers.includes(login);

  // Rule 1: I am on the hook as a reviewer and have not submitted a review yet.
  if (requested && pr.myLastReview === null) {
    return toItem(pr, "review-requested", `@${pr.author} requested your review`, now);
  }

  // Rule 2: A prior review makes an explicit request follow-up work, even when
  // the reviewed head has not changed. Without a request, approvals end my
  // involvement and other reviews follow up only after a newer commit.
  if (
    pr.myLastReview !== null &&
    (requested || (reviewedBeforeHead && pr.myLastReview.state !== "APPROVED"))
  ) {
    return toItem(
      pr,
      "review-followup",
      requested
        ? `@${pr.author} requested your follow-up review`
        : `@${pr.author} pushed a new commit since your review`,
      now,
    );
  }

  return null;
}

/** Turn a poll's pull requests into the queue items they justify. */
export function classify(
  prs: PullRequest[],
  options: { login: string; repoAllowlist: string[]; now: string },
): QueueItem[] {
  return prs
    .filter((pr) => repoAllowed(pr.repo, options.repoAllowlist))
    .flatMap((pr) => {
      const item = itemFor(pr, options.login, options.now);
      return item === null ? [] : [item];
    });
}

function byUpdatedAtDesc(a: QueueItem, b: QueueItem): number {
  const difference = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  // Keys break ties so the list order does not wobble between polls.
  return difference !== 0 ? difference : a.key.localeCompare(b.key);
}

/**
 * Fold a fresh classification into the stored queue, preserving human decisions.
 */
export function mergeQueue(
  existing: QueueItem[],
  incoming: QueueItem[],
  options: { openNodeIds: Set<string>; observedPullRequests?: PullRequest[]; maxAgeDays: number; now: string },
): QueueItem[] {
  const incomingByKey = new Map(incoming.map((item) => [item.key, item]));
  const incomingKeys = new Set(incomingByKey.keys());
  const storedKeys = new Set(existing.map((item) => item.key));
  const observed = new Map(options.observedPullRequests?.map((pr) => [pr.nodeId, pr]) ?? []);

  const merged = existing.filter((item) => {
    if (item.state === "archived") return true;
    // Closed queued and dismissed rows need no further action. Started threads
    // become archived below so their history remains reachable.
    if (!options.openNodeIds.has(item.nodeId) && item.state !== "started") return false;
    // A missing classification removes queued work only. Started rows need
    // concrete completion evidence, and dismissed rows prevent repeat asks.
    if (!incomingKeys.has(item.key) && item.state === "queued") return false;
    return true;
  }).map((item) => {
    if (item.state === "started") {
      const pr = observed.get(item.nodeId);
      const baseline = item.reviewBaselineSubmittedAt ?? item.noticedAt;
      const review = pr?.myLastReview;
      const reviewSent = review !== null && review !== undefined &&
        review.state !== "PENDING" && review.state !== "DISMISSED" &&
        isBefore(baseline, review.submittedAt);
      if (!options.openNodeIds.has(item.nodeId) ||
          (pr !== undefined && pr.headSha !== item.headSha) || reviewSent) {
        return { ...item, state: "archived" as const };
      }
    }
    const latest = incomingByKey.get(item.key);
    return item.state === "queued" && latest !== undefined
      ? { ...item, updatedAt: latest.updatedAt }
      : item;
  });

  // An incoming item whose key is already stored is ignored entirely: the stored
  // row carries the human's state, noticedAt and threadId, and re-adding it would
  // resurrect a dismissal or reset a started item to queued.
  for (const item of incoming) {
    if (!storedKeys.has(item.key)) merged.push(item);
  }

  const cutoff = Date.parse(options.now) - options.maxAgeDays * MS_PER_DAY;
  return merged
    .filter((item) => item.state !== "queued" || Date.parse(item.updatedAt) >= cutoff)
    .sort(byUpdatedAtDesc);
}
