// PR row actions. Pure: whether a merge may go ahead. Nothing here runs a command or calls the SDK; host.ts and
// server.ts do, and they read every decision from here so it can be tested.
import type { MergeStateStatus } from "./contract.js";
import { feedbackVerified, userConfirmation } from "./approval-feedback.js";
import { feedbackToAddress, type ReviewFeedback } from "./feedback-to-address.js";

/** Mechanical GitHub actions the host runs directly, behind a confirm dialog. */
export const DIRECT_ACTIONS = ["merge"] as const;
export type DirectAction = (typeof DIRECT_ACTIONS)[number];

// ---- merge ------------------------------------------------------------------

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** What the merge dialog re-reads from GitHub the moment it opens. */
export type LiveMergeFacts = {
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  mergeStateStatus: MergeStateStatus;
  headRefOid: string | null;
  /** Open PRs whose base is this PR's head branch: merging with delete would orphan them. */
  stackedAbove: number[];
  unresolvedThreads: number;
  /** True when there were more review threads than one page could count. */
  unresolvedAtLeast: boolean;
  /** Written approving reviews from complete live review history, newest first. */
  approvalNotes: { author: string; body: string; submittedAt: string; truncated: boolean }[];
  approvalNotesMore: number;
  /** False when GitHub could not provide the complete review history. */
  approvalNotesComplete: boolean;
  /** Complete current approving-review feedback, independently of thread resolution. */
  approvalFeedback: import("./approval-feedback.js").ApprovalFeedbackSnapshot;
  /** Who said what last, and what answered it (feedback-to-address.ts); absent when GitHub didn't return enough to tell. */
  reviewFeedback?: ReviewFeedback;
};

export type MergeVerdict = { refusals: string[]; warnings: string[] };

export const SHA = /^[0-9a-f]{40}$/u;

const MERGE_STATE_REFUSAL: Partial<Record<MergeStateStatus, string>> = {
  DIRTY: "It has merge conflicts with its base.",
  BEHIND: "The branch is behind its base. Update the branch first.",
  BLOCKED: "Branch protection is not satisfied (a required check or review is missing).",
  UNKNOWN: "GitHub has not worked out whether it can merge yet. Try again in a moment.",
};

/** Refuse unless open, not a draft, approved, and CLEAN / HAS_HOOKS / UNSTABLE. */
export function mergeVerdict(live: LiveMergeFacts, verification: import("./approval-feedback.js").ApprovalFeedbackRecord | null = null): MergeVerdict {
  const refusals: string[] = [];
  const warnings: string[] = [];
  if (live.state !== "OPEN") refusals.push(`The pull request is ${live.state.toLowerCase() || "not open"}.`);
  if (live.isDraft) refusals.push("It is a draft.");
  if (live.reviewDecision !== "APPROVED") {
    refusals.push(
      live.reviewDecision === "CHANGES_REQUESTED" ? "Changes are requested." : "It is not approved.",
    );
  }
  const status = MERGE_STATE_REFUSAL[live.mergeStateStatus];
  if (status !== undefined) refusals.push(status);
  if (live.mergeStateStatus === "UNSTABLE") warnings.push("Some checks that are not required are failing.");
  if (live.headRefOid === null || !SHA.test(live.headRefOid)) refusals.push("GitHub did not report the head commit.");
  if (!feedbackVerified(live.approvalFeedback, live.headRefOid, verification)) refusals.push("Approval feedback needs verified follow-up on the current head.");
  else if (live.approvalFeedback.status === "present" && verification?.provenance?.kind === "user") {
    warnings.push("Its review notes are confirmed by you; no check ran.");
  }
  // Feedback to address holds the merge until you answer it on GitHub or confirm the approval's notes; a worker's evidence doesn't.
  if (live.reviewFeedback === undefined) refusals.push("GitHub didn't return who commented last. Refresh and try again.");
  const confirmed = userConfirmation(verification, live.approvalFeedback, live.headRefOid)?.current === true;
  for (const item of feedbackToAddress(live, confirmed)) {
    refusals.push(item.kind === "approval" ? "An approval comment waits on your answer: reply on the PR or confirm it."
      : `A comment from @${item.login} waits on your answer.`);
  }
  return { refusals, warnings };
}

/** `--delete-branch` only when allowed AND nothing open is based on this branch. */
export function shouldDeleteBranch(setting: boolean, stackedAbove: readonly number[]): boolean {
  return setting && stackedAbove.length === 0;
}
