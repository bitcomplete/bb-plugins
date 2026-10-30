import { describe, expect, it } from "vitest";
import { classify, mergeQueue } from "./rules.js";
import { itemKey, type PullRequest, type QueueItem } from "./types.js";

const ME = "reader-ada";
const NOW = "2026-09-22T12:00:00Z";

/** Times ordered so a test can say "before my review" or "after the push". */
const T = {
  reviewed: "2026-09-20T09:00:00Z",
  pushed: "2026-09-21T09:00:00Z",
  commented: "2026-09-21T18:00:00Z",
};

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    nodeId: "PR_node1",
    repo: "inkwell/folio",
    number: 7,
    title: "Tighten the poller",
    url: "https://github.com/inkwell/folio/pull/7",
    author: "alice",
    isDraft: false,
    baseBranch: "main",
    headBranch: "alice/poller",
    headSha: "sha-head",
    headCommittedAt: T.pushed,
    updatedAt: T.commented,
    reviewDecision: "REVIEW_REQUIRED",
    requestedReviewers: [],
    myLastReview: null,
    ...overrides,
  };
}

function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  const rule = overrides.rule ?? "review-requested";
  const nodeId = overrides.nodeId ?? "PR_node1";
  const headSha = overrides.headSha ?? "sha-head";
  return {
    key: itemKey(rule, nodeId, headSha),
    rule,
    state: "queued",
    repo: "inkwell/folio",
    number: 7,
    title: "Tighten the poller",
    author: "alice",
    url: "https://github.com/inkwell/folio/pull/7",
    baseBranch: "main",
    headBranch: "alice/poller",
    headSha,
    nodeId,
    reason: "@alice requested your review",
    noticedAt: NOW,
    updatedAt: T.commented,
    ...overrides,
  };
}

function run(prs: PullRequest[], repoAllowlist: string[] = []): QueueItem[] {
  return classify(prs, { login: ME, repoAllowlist, now: NOW });
}

describe("classify: review-requested", () => {
  it("queues a pull request that names me as a reviewer so a request cannot go unseen", () => {
    const items = run([pullRequest({ requestedReviewers: [ME] })]);
    expect(items).toHaveLength(1);
    expect(items[0]?.rule).toBe("review-requested");
    expect(items[0]?.state).toBe("queued");
    expect(items[0]?.noticedAt).toBe(NOW);
    expect(items[0]?.reviewBaselineSubmittedAt).toBeNull();
    expect(items[0]?.reason).toBe("@alice requested your review");
    expect(items[0]?.key).toBe(itemKey("review-requested", "PR_node1", "sha-head"));
  });

  it("ignores a request on someone else's behalf, so a teammate's queue is not mine", () => {
    expect(run([pullRequest({ requestedReviewers: ["bob"] })])).toEqual([]);
  });

  it("stays quiet after I review the current head when no request remains", () => {
    const items = run([
      pullRequest({
        myLastReview: { state: "COMMENTED", submittedAt: T.commented },
      }),
    ]);
    expect(items).toEqual([]);
  });

  it("counts a request after an earlier review as follow-up work, not a new review", () => {
    const items = run([
      pullRequest({
        requestedReviewers: [ME],
        myLastReview: { state: "COMMENTED", submittedAt: T.reviewed },
      }),
    ]);
    expect(items.filter((item) => item.rule === "review-requested")).toHaveLength(0);
    expect(items.filter((item) => item.rule === "review-followup")).toHaveLength(1);
  });

  it("counts a same-head re-request after my review as follow-up work", () => {
    const items = run([
      pullRequest({
        requestedReviewers: [ME],
        myLastReview: { state: "COMMENTED", submittedAt: T.pushed },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items.filter((item) => item.rule === "review-requested")).toHaveLength(0);
    expect(items.filter((item) => item.rule === "review-followup")).toHaveLength(1);
    expect(items[0]?.reason).toBe("@alice requested your follow-up review");
    expect(items[0]?.reviewBaselineSubmittedAt).toBe(T.pushed);
  });

  it("leaves drafts alone, because the author has not asked anyone to look yet", () => {
    expect(run([pullRequest({ requestedReviewers: [ME], isDraft: true })])).toEqual([]);
  });
});

describe("classify: review-followup", () => {
  it("queues a push that lands after my non-approving review, since my comments may be unanswered", () => {
    const items = run([
      pullRequest({ myLastReview: { state: "CHANGES_REQUESTED", submittedAt: T.reviewed } }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.rule).toBe("review-followup");
    expect(items[0]?.reason).toBe("@alice pushed a new commit since your review");
  });

  it("treats a push after my approval as someone else's problem", () => {
    const items = run([
      pullRequest({ myLastReview: { state: "APPROVED", submittedAt: T.reviewed } }),
    ]);
    expect(items).toEqual([]);
  });

  it("counts an explicit re-request after approval as follow-up work", () => {
    const items = run([
      pullRequest({
        requestedReviewers: [ME],
        myLastReview: { state: "APPROVED", submittedAt: T.reviewed },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items.filter((item) => item.rule === "review-requested")).toHaveLength(0);
    expect(items.filter((item) => item.rule === "review-followup")).toHaveLength(1);
  });

  it("does not follow up after approval unless GitHub explicitly re-requests me", () => {
    const items = run([
      pullRequest({
        myLastReview: { state: "APPROVED", submittedAt: T.reviewed },
      }),
    ]);
    expect(items).toEqual([]);
  });

  it("stays quiet when nothing has been pushed since my review, so old reviews do not nag", () => {
    const items = run([
      pullRequest({ myLastReview: { state: "COMMENTED", submittedAt: T.commented } }),
    ]);
    expect(items).toEqual([]);
  });

  it("follows up after my review was dismissed, because a dismissal is not a sign-off", () => {
    const items = run([
      pullRequest({ myLastReview: { state: "DISMISSED", submittedAt: T.reviewed } }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.rule).toBe("review-followup");
  });

  it("does not follow up on a pull request I never reviewed, which is not mine to chase", () => {
    expect(run([pullRequest()])).toEqual([]);
  });

  it("leaves a draft alone even when I reviewed it before the push", () => {
    const items = run([
      pullRequest({
        isDraft: true,
        myLastReview: { state: "COMMENTED", submittedAt: T.reviewed },
      }),
    ]);
    expect(items).toEqual([]);
  });
});

describe("classify: my own pull requests", () => {
  // Feedback on my own pull requests belongs to Workstreams ("Your turn"), so
  // the review queue holds only work I owe other authors as a reviewer.
  it("never queues my own pull request when a reviewer asks for changes", () => {
    const items = run([pullRequest({ author: ME, reviewDecision: "CHANGES_REQUESTED" })]);
    expect(items).toEqual([]);
  });

  it("ignores a review request on my own pull request, which is not a review I owe", () => {
    const items = run([pullRequest({ author: ME, requestedReviewers: [ME] })]);
    expect(items).toEqual([]);
  });

  it("does not call my own later push a review follow-up", () => {
    const items = run([pullRequest({
      author: ME,
      myLastReview: { state: "COMMENTED", submittedAt: T.reviewed },
    })]);
    expect(items).toEqual([]);
  });

  it("queues only review requests and follow-ups across every kind of pull request it watches", () => {
    const items = run([
      pullRequest({ nodeId: "PR_requested", requestedReviewers: [ME] }),
      pullRequest({
        nodeId: "PR_followup",
        myLastReview: { state: "CHANGES_REQUESTED", submittedAt: T.reviewed },
      }),
      pullRequest({ nodeId: "PR_mine", author: ME, reviewDecision: "CHANGES_REQUESTED" }),
      pullRequest({ nodeId: "PR_mine_draft", author: ME, isDraft: true }),
    ]);
    expect(items.map((item) => [item.nodeId, item.rule])).toEqual([
      ["PR_requested", "review-requested"],
      ["PR_followup", "review-followup"],
    ]);
  });
});

describe("classify: repo allowlist", () => {
  it("watches every repo when the allowlist is empty, the unconfigured default", () => {
    expect(run([pullRequest({ requestedReviewers: [ME] })], [])).toHaveLength(1);
  });

  it("drops repos outside the allowlist, so an unrelated org cannot fill the queue", () => {
    const items = run([pullRequest({ requestedReviewers: [ME] })], ["inkwell/quill"]);
    expect(items).toEqual([]);
  });

  it("matches allowlist entries case-insensitively, because GitHub slugs are typed by hand", () => {
    const items = run([pullRequest({ requestedReviewers: [ME] })], ["Inkwell/Folio"]);
    expect(items).toHaveLength(1);
  });
});

describe("mergeQueue", () => {
  const open = (...nodeIds: string[]) => new Set(nodeIds);
  const merge = (
    existing: QueueItem[],
    incoming: QueueItem[],
    openNodeIds = open("PR_node1"),
    maxAgeDays = 14,
    observedPullRequests: PullRequest[] = [],
  ) => mergeQueue(existing, incoming, { openNodeIds, maxAgeDays, now: NOW, observedPullRequests });

  it("does not re-queue a dismissed item when the same head commit is seen again", () => {
    const stored = queueItem({ state: "dismissed", noticedAt: T.reviewed });
    const merged = merge([stored], [queueItem()]);
    expect(merged).toEqual([stored]);
  });

  it("keeps a started item's thread and noticedAt instead of resetting it to queued", () => {
    const stored = queueItem({ state: "started", threadId: "thread-9", noticedAt: T.reviewed });
    const merged = merge([stored], [queueItem()]);
    expect(merged).toEqual([stored]);
  });

  it("appends an item the queue has never seen, so new work actually shows up", () => {
    const incoming = queueItem({ rule: "review-followup" });
    expect(merge([], [incoming])).toEqual([incoming]);
  });

  it("archives an opened thread when the pull request closes, so its history remains reachable", () => {
    const stored = queueItem({ state: "started", threadId: "thread-9" });
    expect(merge([stored], [], open())).toEqual([{ ...stored, state: "archived" }]);
  });

  it("keeps an opened initial review pending after a withdrawn request or date-filter omission", () => {
    const stored = queueItem({ state: "started", threadId: "thread-9", reviewBaselineSubmittedAt: null });
    const withdrawn = pullRequest({ requestedReviewers: [] });
    expect(merge([stored], [], open("PR_node1"), 14, [withdrawn])).toEqual([stored]);
    expect(merge([stored], [])).toEqual([stored]);
  });

  it("archives an opened initial review only after GitHub shows my submitted review", () => {
    const stored = queueItem({ state: "started", threadId: "thread-9", reviewBaselineSubmittedAt: null });
    const submitted = pullRequest({ myLastReview: { state: "COMMENTED", submittedAt: "2026-09-22T13:00:00Z" } });
    expect(merge([stored], [], open("PR_node1"), 14, [submitted]))
      .toEqual([{ ...stored, state: "archived" }]);
  });

  it("uses noticedAt for older stored rows without a review baseline", () => {
    const stored = queueItem({ state: "started", threadId: "thread-9" });
    const prior = pullRequest({ myLastReview: { state: "COMMENTED", submittedAt: T.reviewed } });
    const later = pullRequest({ myLastReview: { state: "COMMENTED", submittedAt: "2026-09-22T13:00:00Z" } });
    expect(merge([stored], [], open("PR_node1"), 14, [prior])).toEqual([stored]);
    expect(merge([stored], [], open("PR_node1"), 14, [later]))
      .toEqual([{ ...stored, state: "archived" }]);
  });

  it("keeps a same-head follow-up pending until a review later than its baseline", () => {
    const stored = queueItem({ rule: "review-followup", state: "started", reviewBaselineSubmittedAt: T.reviewed });
    const prior = pullRequest({ myLastReview: { state: "COMMENTED", submittedAt: T.reviewed } });
    const later = pullRequest({ myLastReview: { state: "APPROVED", submittedAt: "2026-09-22T13:00:00Z" } });
    expect(merge([stored], [], open("PR_node1"), 14, [prior])).toEqual([stored]);
    expect(merge([stored], [], open("PR_node1"), 14, [later]))
      .toEqual([{ ...stored, state: "archived" }]);
  });

  it("does not treat a dismissed or pending review as a submitted review", () => {
    const stored = queueItem({ state: "started", reviewBaselineSubmittedAt: null });
    for (const state of ["DISMISSED", "PENDING"] as const) {
      const observed = pullRequest({ myLastReview: { state, submittedAt: "2026-09-22T13:00:00Z" } });
      expect(merge([stored], [], open("PR_node1"), 14, [observed])).toEqual([stored]);
    }
  });

  it("archives the old opened thread when a new head creates a fresh pending item", () => {
    const stored = queueItem({ state: "started", threadId: "thread-9" });
    const fresh = queueItem({ headSha: "sha-next", key: itemKey("review-requested", "PR_node1", "sha-next") });
    const observed = pullRequest({ headSha: "sha-next" });
    expect(merge([stored], [fresh], open("PR_node1"), 14, [observed]))
      .toEqual([{ ...stored, state: "archived" }, fresh]);
  });

  it("drops a queued item the poll no longer justifies, so stale asks disappear", () => {
    expect(merge([queueItem()], [])).toEqual([]);
  });

  it("keeps a started item visible after GitHub stops reporting it", () => {
    const stored = queueItem({ state: "started", threadId: "thread-9" });
    expect(merge([stored], [])).toEqual([stored]);
  });

  it("keeps a dismissed item the poll no longer justifies, so it cannot come back", () => {
    const stored = queueItem({ state: "dismissed" });
    expect(merge([stored], [])).toEqual([stored]);
  });

  it("expires old queued rows but preserves decisions on open pull requests", () => {
    const old = { noticedAt: "2026-08-01T12:00:00Z" };
    const started = queueItem({ ...old, state: "started", rule: "review-followup" });
    const dismissed = queueItem({ ...old, state: "dismissed", headSha: "sha-older" });
    const merged = merge(
      [
        queueItem({ ...old, updatedAt: old.noticedAt, state: "queued" }),
        started,
        dismissed,
      ],
      [queueItem({ rule: "review-followup" }), queueItem({ headSha: "sha-older" })],
    );
    expect(merged).toEqual([started, dismissed]);
  });

  it("does not re-queue an expired open PR on the next poll", () => {
    const incoming = queueItem({ updatedAt: "2026-08-01T12:00:00Z" });
    const first = merge([], [incoming]);
    expect(first).toEqual([]);
    expect(merge(first, [incoming])).toEqual([]);
  });

  it("uses a fresh PR update when an existing queued row has the same key", () => {
    const old = queueItem({ noticedAt: "2026-08-01T12:00:00Z", updatedAt: "2026-08-01T12:00:00Z" });
    const incoming = queueItem({ updatedAt: T.commented });
    const first = merge([old], [incoming]);
    expect(first).toEqual([{ ...old, updatedAt: T.commented }]);
    expect(merge(first, [incoming])).toEqual(first);
  });

  it("keeps a PR updated exactly maxAgeDays ago, so the cutoff does not lose a live row", () => {
    const incoming = queueItem({ updatedAt: "2026-09-08T12:00:00Z" });
    expect(merge([], [incoming])).toEqual([incoming]);
  });

  it("sorts newest updatedAt first, so the freshest thing needing me is on top", () => {
    const older = queueItem({ nodeId: "PR_old", updatedAt: "2026-09-15T00:00:00Z" });
    const newer = queueItem({ nodeId: "PR_new", updatedAt: "2026-09-22T00:00:00Z" });
    const merged = merge([], [older, newer], open("PR_old", "PR_new"));
    expect(merged.map((item) => item.nodeId)).toEqual(["PR_new", "PR_old"]);
  });

  it("re-queues the same rule after a new push, because the key carries the head sha", () => {
    const stored = queueItem({ state: "dismissed" });
    const afterPush = queueItem({ headSha: "sha-newer" });
    const merged = merge([stored], [afterPush], open("PR_node1"));
    expect(merged.map((item) => item.state).sort()).toEqual(["dismissed", "queued"]);
  });
});
