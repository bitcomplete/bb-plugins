import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { APPROVAL_FEEDBACK_MIGRATION, createApprovalFeedbackStore, feedbackVerificationState, feedbackVerified, userConfirmation,
  type ApprovalFeedbackSnapshot } from "./approval-feedback.js";
import { readReviewThreads, type GhRunner } from "./ghactions.js";

const url = "https://github.com/example/widget/pull/42";
const target = { host: "github.com", owner: "example", name: "widget", number: 42, slug: "example/widget" };
const head = "a".repeat(40);
const review = { id: "review-42", state: "APPROVED", body: "Fix the fallback", submittedAt: "2026-09-24T12:00:00Z",
  author: { login: "reviewer" }, commit: { oid: head } };
const gh: GhRunner = async () => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: {
  headRefOid: head, author: { login: "author" }, reviews: { pageInfo: { hasPreviousPage: false }, nodes: [review] },
  reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
} } } }) });

function report(attemptId: string, fingerprint: string, outcome: "passed" | "not-needed" | "failed" = "passed") {
  return { attemptId, headOid: head, fingerprint, findings: [{ sourceId: review.id, resolution: "already-satisfied" as const,
    evidence: "The current fallback already handles the reviewed case in src/fallback.ts.",
    validation: { outcome, detail: outcome === "not-needed" ? "Static inspection covers this wording request." : "Focused fallback test passed." } }], blockers: [] };
}

describe("approval feedback verification", () => {
  it("verifies a stored no-change worker report only for the exact current review and head, then survives a base-only change", async () => {
    const read = await readReviewThreads(gh, target);
    if (!read.ok) throw new Error(read.error);
    const snapshot = read.approvalFeedback;
    expect(snapshot).toMatchObject({ status: "present", sourceIds: [review.id] });
    const db = new Database(":memory:");
    db.exec(APPROVAL_FEEDBACK_MIGRATION);
    const store = createApprovalFeedbackStore(db);
    store.save(url, "thread-1", report("attempt-1", snapshot.fingerprint!, "not-needed"), 1_000);
    expect(store.get(url)?.provenance).toEqual({ kind: "worker" });
    expect(feedbackVerified(snapshot, head, store.get(url))).toBe(true);
    expect(feedbackVerified(snapshot, "b".repeat(40), store.get(url))).toBe(false);
    expect(feedbackVerified({ ...snapshot, fingerprint: "c".repeat(64) }, head, store.get(url))).toBe(false);
    expect(feedbackVerified({ status: "none", fingerprint: null, sourceIds: [] }, head, null)).toBe(true);
    expect(feedbackVerified({ status: "unknown", fingerprint: null, sourceIds: [] }, head, store.get(url))).toBe(false);
    db.close();
  });

  it("loads older worker records and keeps audited legacy provenance without weakening current-head checks", async () => {
    const read = await readReviewThreads(gh, target);
    if (!read.ok) throw new Error(read.error);
    const snapshot = read.approvalFeedback;
    const parsed = report("old-attempt", snapshot.fingerprint!);
    const db = new Database(":memory:");
    db.exec(APPROVAL_FEEDBACK_MIGRATION);
    const store = createApprovalFeedbackStore(db);
    store.save(url, "old-thread", parsed, 1_000);
    const row = db.prepare("SELECT body FROM approval_feedback_verifications WHERE pr_url = ?").get(url) as { body: string };
    const { provenance: _provenance, ...older } = JSON.parse(row.body) as Record<string, unknown>;
    db.prepare("UPDATE approval_feedback_verifications SET body = ? WHERE pr_url = ?").run(JSON.stringify(older), url);
    expect(store.get(url)?.provenance).toEqual({ kind: "worker" });

    const provenance = { kind: "legacy-reconciliation" as const, auditThreadId: "thr_audit",
      evidenceRefs: ["thr_old", "https://github.com/example/widget/pull/42#discussion_r1"] };
    const reconciled = store.save(url, "old-thread", parsed, 2_000, provenance);
    expect(store.get(url)?.provenance).toEqual(provenance);
    expect(reconciled).toMatchObject({ attemptId: "old-attempt", threadId: "old-thread", provenance });
    expect(feedbackVerified(snapshot, head, store.get(url))).toBe(true);
    expect(feedbackVerified(snapshot, "b".repeat(40), store.get(url))).toBe(false);
    expect(feedbackVerified({ ...snapshot, fingerprint: "c".repeat(64) }, head, store.get(url))).toBe(false);
    expect(feedbackVerified({ ...snapshot, sourceIds: ["different-source"] }, head, store.get(url))).toBe(false);
    for (const invalid of [
      { ...provenance, auditThreadId: "  " },
      { ...provenance, evidenceRefs: [] },
      { ...provenance, evidenceRefs: ["  "] },
    ]) expect(() => store.save(url, "old-thread", parsed, 3_000, invalid)).toThrow();
    expect(store.get(url)?.verifiedAt).toBe(2_000);
    db.close();
  });

  // Your confirmation clears the merge gate the way worker evidence does, so it must say it's yours and bind to exactly what you read.
  it("records your confirmation as yours, bound to the head and feedback you confirmed, and never for feedback it can't name", async () => {
    const read = await readReviewThreads(gh, target);
    if (!read.ok) throw new Error(read.error);
    const snapshot = read.approvalFeedback;
    const db = new Database(":memory:"); db.exec(APPROVAL_FEEDBACK_MIGRATION);
    const store = createApprovalFeedbackStore(db);
    // Confirmed anyway, with nothing since the approval: the record keeps that it rests on your word alone.
    const none = { since: review.submittedAt, commits: 0, replies: 0, threads: { total: 0, resolved: 0 }, complete: true };
    const confirmed = store.confirm(url, snapshot, head, 5_000, none);
    expect(store.get(url)).toEqual(confirmed);
    expect(confirmed).toMatchObject({ provenance: { kind: "user", evidence: none }, threadId: "inventory", headOid: head, fingerprint: snapshot.fingerprint,
      verifiedAt: 5_000, findings: [{ sourceId: review.id, evidence: "You confirmed this approval feedback handled without evidence. No commits, reply, or resolved threads since this approval.",
        validation: { outcome: "not-needed", detail: "Your confirmation; no check ran." } }] });
    expect(store.confirm(url, snapshot, head, 5_500, { ...none, commits: 2 }).findings[0]!.evidence)
      .toBe("You confirmed this approval feedback handled. 2 commits since this approval.");
    // Linked follow-ups are shown in the dialog but left out of the record, so an older build can still read your confirmation.
    const linked = store.confirm(url, snapshot, head, 5_600, { ...none, linked: [{ repo: "inkwell/folio", number: 302 }] });
    expect(linked.provenance).toEqual({ kind: "user", evidence: none });
    expect(JSON.stringify(store.get(url))).not.toContain("linked");
    store.confirm(url, snapshot, head, 5_000, none);
    expect(feedbackVerified(snapshot, head, store.get(url))).toBe(true);
    expect(feedbackVerificationState(snapshot, "b".repeat(40), store.get(url))).toBe("head-changed");
    expect(feedbackVerificationState({ ...snapshot, fingerprint: "c".repeat(64), sourceIds: [...snapshot.sourceIds, "review-43"] }, head, store.get(url)))
      .toBe("feedback-changed");
    const unnamed: [ApprovalFeedbackSnapshot, string][] = [[{ status: "unknown", fingerprint: null, sourceIds: [] }, head],
      [{ status: "none", fingerprint: null, sourceIds: [] }, head], [snapshot, "not-a-head"]];
    for (const [feedback, at] of unnamed) expect(() => store.confirm(url, feedback, at, 6_000, none)).toThrow();
    expect(store.get(url)).toEqual(confirmed);
    db.close();
  });

  // Your confirmation can be taken back at any age, and says on its row whether it still covers the head and whether evidence backed it.
  it("revokes only your own confirmation, however old or stale, and never a worker's evidence", async () => {
    const read = await readReviewThreads(gh, target);
    if (!read.ok) throw new Error(read.error);
    const snapshot = read.approvalFeedback;
    const db = new Database(":memory:"); db.exec(APPROVAL_FEEDBACK_MIGRATION);
    const store = createApprovalFeedbackStore(db);
    const none = { since: review.submittedAt, commits: 0, replies: 0, threads: { total: 0, resolved: 0 }, complete: true };
    const confirmed = store.confirm(url, snapshot, head, 5_000, none);
    expect(userConfirmation(store.get(url), snapshot, head)).toEqual({ at: 5_000, current: true, evidence: false });
    // A later head leaves it stale, but still yours to take back.
    expect(userConfirmation(store.get(url), snapshot, "b".repeat(40))).toEqual({ at: 5_000, current: false, evidence: false });
    expect(store.revoke(url)).toEqual(confirmed);
    expect([store.get(url), store.revoke(url)]).toEqual([null, null]);
    store.save(url, "thread-1", report("attempt-2", snapshot.fingerprint!), 7_000);
    expect([store.revoke(url), store.get(url)?.provenance, userConfirmation(store.get(url), snapshot, head)]).toEqual([null, { kind: "worker" }, null]);
    db.close();
  });

  it("carries exact feedback across an identical Git tree while preserving the original evidence and refusing a superseded record", async () => {
    const read = await readReviewThreads(gh, target);
    if (!read.ok) throw new Error(read.error);
    const snapshot = read.approvalFeedback;
    const db = new Database(":memory:"); db.exec(APPROVAL_FEEDBACK_MIGRATION);
    const store = createApprovalFeedbackStore(db);
    const provenance = { kind: "legacy-reconciliation" as const, auditThreadId: "thr_audit", evidenceRefs: ["thr_old"] };
    const original = store.save(url, "thr_old", report("attempt-old", snapshot.fingerprint!), 1_000, provenance);
    const newHead = "b".repeat(40), tree = "c".repeat(40);
    expect(feedbackVerificationState(snapshot, newHead, original)).toBe("head-changed");
    expect(store.carryEquivalent(url, original, snapshot, newHead, tree, "d".repeat(40), 2_000)).toBeNull();
    expect(store.carryEquivalent(url, original, { ...snapshot, sourceIds: ["new-review"] }, newHead, tree, tree, 2_000)).toBeNull();
    expect(store.carryEquivalent(url, original, { ...snapshot, fingerprint: "d".repeat(64) }, newHead, tree, tree, 2_000)).toBeNull();
    const carried = store.carryEquivalent(url, original, snapshot, newHead, tree, tree, 2_000);
    expect(carried).toMatchObject({ headOid: newHead, attemptId: "attempt-old", threadId: "thr_old", verifiedAt: 1_000,
      provenance, equivalence: { sourceHeadOid: head, sourceVerifiedAt: 1_000, treeOid: tree, checkedAt: 2_000 } });
    expect(feedbackVerified(snapshot, newHead, store.get(url))).toBe(true);
    expect(store.carryEquivalent(url, original, snapshot, "e".repeat(40), tree, tree, 3_000)).toBeNull();
    const newer = store.save(url, "thr_new", report("attempt-new", snapshot.fingerprint!), 3_000);
    expect(store.carryEquivalent(url, carried!, snapshot, "e".repeat(40), tree, tree, 4_000)).toBeNull();
    expect(store.get(url)).toEqual(newer);
    db.close();
  });

  // Your word covers the head you confirmed on; even one with the same tree asks for the notes again, where its new commit shows as evidence.
  it("never carries your confirmation to a new head, even one with an identical tree", async () => {
    const read = await readReviewThreads(gh, target);
    if (!read.ok) throw new Error(read.error);
    const snapshot = read.approvalFeedback;
    const db = new Database(":memory:"); db.exec(APPROVAL_FEEDBACK_MIGRATION);
    const store = createApprovalFeedbackStore(db);
    const confirmed = store.confirm(url, snapshot, head, 1_000, { since: review.submittedAt, commits: 1, replies: 0, threads: { total: 0, resolved: 0 }, complete: true });
    expect(store.carryEquivalent(url, confirmed, snapshot, "b".repeat(40), "c".repeat(40), "c".repeat(40), 2_000)).toBeNull();
    expect([store.get(url), feedbackVerificationState(snapshot, "b".repeat(40), store.get(url))]).toEqual([confirmed, "head-changed"]);
    db.close();
  });

  it("does not carry failed or missing validation into a new head", async () => {
    const read = await readReviewThreads(gh, target);
    if (!read.ok) throw new Error(read.error);
    const snapshot = read.approvalFeedback;
    const db = new Database(":memory:"); db.exec(APPROVAL_FEEDBACK_MIGRATION);
    const store = createApprovalFeedbackStore(db);
    const failed = store.save(url, "thr_old", report("attempt-old", snapshot.fingerprint!, "failed"), 1_000);
    expect(store.carryEquivalent(url, failed, snapshot, "b".repeat(40), "c".repeat(40), "c".repeat(40), 2_000)).toBeNull();
    expect(feedbackVerificationState(snapshot, "b".repeat(40), failed)).toBe("feedback-changed");
    db.close();
  });

  it("cannot claim an approved PR has no inline feedback when a thread root lacks review identity", async () => {
    const run: GhRunner = async () => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: {
      headRefOid: head, author: { login: "author" }, reviews: { pageInfo: { hasPreviousPage: false }, nodes: [{ ...review, body: "" }] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ id: "thread-1", isResolved: true,
        comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: "comment-1", body: "Fix the fallback", createdAt: review.submittedAt,
          updatedAt: review.submittedAt, author: { login: "reviewer" }, pullRequestReview: null }] } }] },
    } } } }) });
    const read = await readReviewThreads(run, target);
    expect(read).toMatchObject({ ok: true, approvalFeedback: { status: "unknown" } });
  });
});
