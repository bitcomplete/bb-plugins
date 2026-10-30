// Row actions: merge refusals. Fixtures are the invented Inkwell bookstore: repos quill,
// folio, margin, colophon and spine; tickets ABC-/OPS-/WEB-/SHOP-; PRs 42–99.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  mergeVerdict,
  shouldDeleteBranch,
  type LiveMergeFacts,
} from "./actions.js";
import { APPROVAL_FEEDBACK_MIGRATION, createApprovalFeedbackStore } from "./approval-feedback.js";
import type { MergeStateStatus } from "./contract.js";

function live(overrides: Partial<LiveMergeFacts> = {}): LiveMergeFacts {
  return {
    state: "OPEN",
    isDraft: false,
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    headRefOid: "a".repeat(40),
    stackedAbove: [],
    unresolvedThreads: 0,
    unresolvedAtLeast: false,
    approvalNotes: [],
    approvalNotesMore: 0,
    approvalNotesComplete: true,
    approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] },
    reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: null, followUpAt: null },
    ...overrides,
  };
}

describe("mergeVerdict", () => {
  it("requires current-head evidence for written or inline approval feedback", () => {
    const approvalFeedback = { status: "present" as const, fingerprint: "f".repeat(64), sourceIds: ["review-1"] };
    const pending = live({ approvalFeedback });
    expect(mergeVerdict(pending).refusals).toContain("Approval feedback needs verified follow-up on the current head.");
    const record = { prUrl: "https://github.com/example/widget/pull/42", threadId: "thread-1", attemptId: "job-1",
      headOid: pending.headRefOid!, fingerprint: approvalFeedback.fingerprint, verifiedAt: 1,
      findings: [{ sourceId: "review-1", resolution: "fixed" as const, evidence: "The fallback is covered in src/fallback.ts.",
        validation: { outcome: "passed" as const, detail: "Focused test passed." } }], blockers: [] };
    // A worker's evidence verifies the head, but only an answer the reviewer sees clears their note: here, your reply after it.
    expect(mergeVerdict(pending, record).refusals).toEqual(["An approval comment waits on your answer: reply on the PR or confirm it."]);
    const replied = live({ ...pending, reviewFeedback: { openThreads: 0, comment: null, repliedAt: "2026-09-28T13:00:00Z", noteAt: "2026-09-28T12:00:00Z", followUpAt: null } });
    expect(mergeVerdict(replied, record).refusals).toEqual([]);
    expect(mergeVerdict(live({ ...pending, headRefOid: "b".repeat(40) }), record).refusals).toContain("Approval feedback needs verified follow-up on the current head.");
    expect(mergeVerdict(live({ ...pending, approvalFeedback: { ...approvalFeedback, fingerprint: "a".repeat(64) } }), record).refusals).toContain("Approval feedback needs verified follow-up on the current head.");
    expect(mergeVerdict(pending, { ...record, findings: [{ ...record.findings[0]!, validation: { outcome: "failed", detail: "Focused test failed." } }] }).refusals)
      .toContain("Approval feedback needs verified follow-up on the current head.");
  });
  // The inventory's Confirm handled leads to this preview, so the preview must take your confirmation, and only for what you confirmed.
  it("accepts your confirmation of approval feedback on the head and feedback you confirmed, as it accepts worker evidence", () => {
    const approvalFeedback = { status: "present" as const, fingerprint: "f".repeat(64), sourceIds: ["review-1", "review-2"] };
    const pending = live({ approvalFeedback });
    const db = new Database(":memory:"); db.exec(APPROVAL_FEEDBACK_MIGRATION);
    const evidence = { since: "2026-09-28T12:00:00Z", commits: 0, replies: 1, threads: { total: 0, resolved: 0 }, complete: true };
    const confirmed = createApprovalFeedbackStore(db).confirm("https://github.com/example/widget/pull/42", approvalFeedback, pending.headRefOid!, 1_000, evidence);
    expect(confirmed.provenance).toEqual({ kind: "user", evidence });
    // It merges on your word, and the preview says so, so it never reads as checked.
    expect(mergeVerdict(pending, confirmed)).toEqual({ refusals: [], warnings: ["Its review notes are confirmed by you; no check ran."] });
    expect(mergeVerdict(live({ ...pending, headRefOid: "b".repeat(40) }), confirmed).refusals).toContain("Approval feedback needs verified follow-up on the current head.");
    expect(mergeVerdict(live({ ...pending, approvalFeedback: { ...approvalFeedback, fingerprint: "a".repeat(64), sourceIds: ["review-1", "review-2", "review-3"] } }),
      confirmed).refusals).toContain("Approval feedback needs verified follow-up on the current head.");
    db.close();
  });
  // Feedback to address refuses the merge whatever else passes, and neither a push nor a PR that mentions it answers it: only a reply does.
  it("refuses while anyone's comment or the approval's note waits on your answer, or when GitHub didn't say who spoke last", () => {
    const said = (patch: Partial<NonNullable<LiveMergeFacts["reviewFeedback"]>>) => live({ reviewFeedback: { openThreads: 0, comment: null, repliedAt: null,
      noteAt: null, followUpAt: null, ...patch } });
    expect(mergeVerdict(said({ comment: { login: "theo-k", at: "2026-09-28T12:00:00Z" } })).refusals).toEqual(["A comment from @theo-k waits on your answer."]);
    expect(mergeVerdict(said({ comment: { login: "theo-k", at: "2026-09-28T12:00:00Z" }, repliedAt: "2026-09-28T13:00:00Z" })).refusals).toEqual([]);
    expect(mergeVerdict(said({ comment: { login: "theo-k", at: "2026-09-28T12:00:00Z" }, followUpAt: "2026-09-28T13:00:00Z" })).refusals)
      .toEqual(["A comment from @theo-k waits on your answer."]);
    expect(mergeVerdict(live({ reviewFeedback: undefined })).refusals).toEqual(["GitHub didn't return who commented last. Refresh and try again."]);
  });
  it("allows an open, approved, clean PR", () => {
    expect(mergeVerdict(live())).toEqual({ refusals: [], warnings: [] });
    expect(mergeVerdict(live({ mergeStateStatus: "HAS_HOOKS" })).refusals).toEqual([]);
  });

  it("allows UNSTABLE with a warning", () => {
    expect(mergeVerdict(live({ mergeStateStatus: "UNSTABLE" }))).toEqual({
      refusals: [],
      warnings: ["Some checks that are not required are failing."],
    });
  });

  const refusals: [string, Partial<LiveMergeFacts>, string][] = [
    ["a draft", { isDraft: true }, "It is a draft."],
    ["an unapproved PR", { reviewDecision: "REVIEW_REQUIRED" }, "It is not approved."],
    ["a PR with no review decision", { reviewDecision: null }, "It is not approved."],
    ["a closed PR", { state: "CLOSED" }, "The pull request is closed."],
    ...(["DIRTY", "BEHIND", "BLOCKED", "UNKNOWN"] as MergeStateStatus[]).map(
      (status): [string, Partial<LiveMergeFacts>, string] => [status, { mergeStateStatus: status }, ""],
    ),
    ["a missing head sha", { headRefOid: null }, "GitHub did not report the head commit."],
  ];
  for (const [what, overrides, reason] of refusals) {
    it(`refuses ${what}, with a reason`, () => {
      const verdict = mergeVerdict(live(overrides));
      expect(verdict.refusals.length).toBe(1);
      if (reason !== "") expect(verdict.refusals[0]).toBe(reason);
    });
  }
});

describe("shouldDeleteBranch", () => {
  it("deletes only when the setting allows it and no open PR is based on the branch", () => {
    expect(shouldDeleteBranch(true, [])).toBe(true);
    expect(shouldDeleteBranch(false, [])).toBe(false);
    expect(shouldDeleteBranch(true, [58])).toBe(false);
  });
});
