// A PR's stage and leading blocker, as All PRs shows them. GitHub and checkout facts remain the source of truth.
import type { Pr } from "./contract.js";
import type { PrHold } from "./pr-holds.js";
import type { Lifecycle } from "./workstreams.js";
import { checksFailed, checksGreen } from "./pr-checks.js";
import { FEEDBACK_LABEL, feedbackToAddress } from "./feedback-to-address.js";

export const PIPELINE_STAGES = ["build", "review", "feedback", "ready", "merged", "released"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type PipelineBlocker = { label: string; tone: "bad" | "warn" | "wait" | "clear" };
/** Lifecycle owns position. A draft and an active rebase stay in Build even with bad checks. */
export function stageFor(lifecycle: Lifecycle, pr: Pr | null, behind: number | null = null): PipelineStage {
  if (lifecycle === "shipped") return "released";
  if (lifecycle === "merged" || lifecycle === "closed") return "merged";
  if (pr === null || pr.isDraft || lifecycle === "active" || lifecycle === "in-progress" || lifecycle === "up-next") return "build";
  if (checksFailed(pr.checkConclusions)) return "feedback";
  if (pr !== null && !pr.isDraft && (pr.mergeStateStatus === "DIRTY" || pr.mergeStateStatus === "BEHIND")) return "feedback";
  if (behind !== null && pr?.reviewDecision === "APPROVED" && lifecycle === "awaiting-merge") return "ready";
  if (lifecycle === "blocked" || lifecycle === "awaiting-followup" || lifecycle === "approved-with-comments" || lifecycle === "approved-with-note") return "feedback";
  if (lifecycle === "awaiting-merge") return "ready";
  return "review"; // Awaiting review, re-review, or facts that need verification.
}

/** One visible gate, ordered by the repair that must happen first. */
export function blockerFor(pr: Pr | null, stage: PipelineStage, hold: PrHold | null, behind: number | null = null, stale = false): PipelineBlocker {
  if (hold !== null) return { label: "On hold", tone: "wait" };
  if (stage === "merged" || stage === "released") return { label: "Clear", tone: "clear" };
  if (pr === null) return { label: "In progress", tone: "wait" };
  if (stale) return { label: "Status unknown", tone: "wait" };
  if (checksFailed(pr.checkConclusions)) return { label: "CI failing", tone: "bad" };
  if (pr.mergeStateStatus === "DIRTY") return { label: "Conflicts", tone: "bad" };
  if (pr.reviewDecision === "CHANGES_REQUESTED" && !pr.reviewFollowupPosted) return { label: "Changes requested", tone: "warn" };
  if (pr.unresolvedReviewThreads !== null && pr.unresolvedReviewThreads > 0) return { label: `${pr.unresolvedReviewThreads} open threads`, tone: "warn" };
  // Feedback to address outranks every wait below and never reads Clear, whatever CI or the merge state say.
  const open = feedbackToAddress(pr, pr.approvalFeedbackConfirmed === true)[0];
  if (open) return { label: FEEDBACK_LABEL[open.kind], tone: "warn" };
  if (pr.reviewDecision === "APPROVED" && pr.approvalFeedback?.status === "present" && !pr.approvalFeedbackVerified) {
    return { label: pr.approvalFeedbackVerification === "head-changed" ? "Verification needs recheck" :
      pr.approvalFeedbackVerification === "feedback-changed" ? "New review feedback" : "Feedback verification needed", tone: "warn" };
  }
  if (pr.mergeStateStatus === "BEHIND") return { label: "Branch behind", tone: "wait" };
  if (pr.isDraft) return { label: "Draft", tone: "wait" };
  if (pr.reviewDecision === "APPROVED" && (!pr.approvalFeedback || pr.approvalFeedback.status === "unknown")) return { label: "Review history unknown", tone: "wait" };
  if (pr.mergeStateStatus === "UNKNOWN" ||
    (pr.reviewDecision === "APPROVED" && pr.unresolvedReviewThreads === null)) return { label: "Status unknown", tone: "wait" };
  if (behind !== null) return { label: `Behind #${behind}`, tone: "wait" };
  if (stage === "build") return { label: "In progress", tone: "wait" };
  if (pr.reviewDecision === "CHANGES_REQUESTED" && pr.reviewFollowupPosted) return { label: "Awaiting re-review", tone: "wait" };
  if (pr.reviewDecision === "APPROVED" && !checksGreen(pr.checkConclusions)) return { label: "Checks pending", tone: "wait" };
  if (pr.mergeStateStatus === "BLOCKED") return { label: "Rules block", tone: "wait" };
  if (pr.reviewDecision !== "APPROVED" && pr.reviewRequests.length === 0) return { label: "No reviewer", tone: "wait" };
  if (pr.reviewDecision !== "APPROVED") return { label: "Awaiting review", tone: "wait" };
  return { label: "Clear", tone: "clear" };
}
