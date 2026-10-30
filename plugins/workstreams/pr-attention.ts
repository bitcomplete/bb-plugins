// The PR inventory's three questions for each open PR: is it forgotten in
// draft, is it missing a reviewer, and does it need a nudge. Pure: PR facts,
// holds, effort ownership, the clock, and thresholds in; each reason's next
// step, owner, and age out. Feedback to address comes first, whatever CI,
// a draft, conflicts, or the merge state say, and holds the merge while it
// waits. Ages come from GitHub's timestamps where GitHub keeps one. Red
// checks and conflicts have none, so their age starts at the read that first
// saw the state: a lower bound, and labeled as one.
import { z } from "zod";
import type { Pr } from "./contract.js";
import { feedbackToAddress } from "./feedback-to-address.js";
import { checksFailed, checksGreen } from "./pr-checks.js";
import { answeredSince, awaitingRerequest, conflicted, mergeClean, reviewEngaged } from "./pr-gates.js";
import { prHoldFor, type PrHolds } from "./pr-holds.js";
import type { WorkOwner } from "./work-context.js";

const DAY_MS = 86_400_000;

export type AttentionThresholds = {
  /** A draft with no push for this many days is forgotten. */
  draftIdleDays: number;
  /** A requested review unanswered for this many weekdays needs a nudge. */
  nudgeAfterBusinessDays: number;
  /** An approved PR left unmerged, or red checks or a conflict left standing, this many days needs a nudge. */
  stuckAfterDays: number;
};
export const DEFAULT_ATTENTION_THRESHOLDS: AttentionThresholds = { draftIdleDays: 3, nudgeAfterBusinessDays: 1, stuckAfterDays: 1 };
export type AttentionClock = { now: number; thresholds: AttentionThresholds; utcOffsetMinutes: number };

/** States GitHub keeps no time for. A local record dates each from the read that first saw it. */
export const UNDATED_STATES = ["ci-red", "conflicting"] as const;
export type UndatedState = (typeof UNDATED_STATES)[number];
/** When a read first saw each undated state, in epoch ms. */
export type StateSince = Partial<Record<UndatedState, number>>;

/** Whether each undated state holds now; null when GitHub hasn't decided, which neither starts nor ends it. */
export function undatedStates(pr: Pick<Pr, "checkConclusions" | "mergeable" | "mergeStateStatus">): Record<UndatedState, boolean | null> {
  return {
    "ci-red": checksFailed(pr.checkConclusions),
    conflicting: conflicted(pr) ? true : pr.mergeable === "MERGEABLE" ? false : null,
  };
}

/** Weekday time between two instants, in ms. Saturdays and Sundays at this UTC offset don't count. */
export function businessMsBetween(from: number, to: number, utcOffsetMinutes: number): number {
  const shift = utcOffsetMinutes * 60_000;
  let total = 0;
  for (let at = from + shift; at < to + shift;) {
    const next = Math.min((Math.floor(at / DAY_MS) + 1) * DAY_MS, to + shift);
    if (![0, 6].includes(new Date(at).getUTCDay())) total += next - at;
    at = next;
  }
  return total;
}

export const attentionReasonSchema = z.object({
  question: z.enum(["forgotten-draft", "missing-reviewer", "needs-nudge"]),
  /** `approval-note` and `review-comments` are feedback to address; `approval-comments` is notes you answered that still want your Confirm. */
  kind: z.enum(["approval-note", "review-comments", "draft-ready", "draft-idle", "missing-reviewer", "review-waiting", "rereview-needed", "approval-comments",
    "merge-waiting", "ci-red", "conflicting"]),
  action: z.enum(["mark-ready", "request-review", "nudge", "rerequest", "confirm-handled", "merge", "open-thread"]),
  nextStep: z.string(),
  /** Who acts: you, the PR's author, or the reviewers it names. */
  owner: z.enum(["you", "reviewers"]),
  /** The reviewers the step names: those to nudge, or to ask again. */
  reviewers: z.array(z.string()),
  /** When the wait began, in epoch ms; null when nothing dates it. */
  since: z.number().nullable(),
  ageMs: z.number().nullable(),
  /** `github`: a GitHub timestamp. `observed`: the read that first saw the state, so the wait is at least this long. */
  basis: z.enum(["github", "observed"]),
}).strict();
export type AttentionReason = z.infer<typeof attentionReasonSchema>;
export const prAttentionSchema = z.object({
  effort: z.object({ id: z.string(), name: z.string() }).strict().nullable(),
  held: z.boolean(),
  reasons: z.array(attentionReasonSchema),
}).strict();
export type PrAttention = z.infer<typeof prAttentionSchema>;

/** The PR facts attention reads. A missing timestamp never ages a reason. */
export type AttentionFacts = Pick<Pr, "url" | "state" | "isDraft" | "reviewDecision" | "checkConclusions" | "mergeable" | "mergeStateStatus" |
  "reviewRequests" | "unresolvedReviewThreads" | "resolvedReviewThreads" | "createdAt" | "reviewFollowupPosted" | "approvalFeedback" | "approvalFeedbackVerified" |
  "approvalFeedbackConfirmed" | "reviewFeedback"> & {
  latestReviews: readonly { login: string; state: string; submittedAt?: string }[];
  /** The head commit's date: the last push, as near as GitHub dates it. */
  headCommittedAt?: string;
  /** When each currently requested reviewer was last asked. */
  reviewRequestedAt?: readonly { reviewer: string; at: string }[];
  /** The open PR this one is stacked on, which must merge first; absent for a stack root. */
  stackedOn?: number | null;
};

const time = (value: string | null | undefined): number | null => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
};
const mentions = (logins: readonly string[]) => logins.map((login) => `@${login}`).join(", ");

/** One PR's attention and the effort that owns it. A hold suppresses every reason, since each step it names is refused under a hold. */
export function prAttention(pr: AttentionFacts, sources: { holds: PrHolds; effort: WorkOwner | null; since: StateSince }, clock: AttentionClock): PrAttention {
  const held = prHoldFor(pr.url, sources.holds) !== null;
  return { effort: sources.effort && { id: sources.effort.id, name: sources.effort.name }, held,
    reasons: held ? [] : attentionReasons(pr, sources.since, clock) };
}

/** An open PR's reasons; a closed or merged PR has none. */
export function attentionReasons(pr: AttentionFacts, since: StateSince, { now, thresholds, utcOffsetMinutes }: AttentionClock): AttentionReason[] {
  if (pr.state !== "OPEN") return [];
  const reasons: AttentionReason[] = [];
  const add = (reason: Omit<AttentionReason, "ageMs" | "basis" | "reviewers"> & Partial<Pick<AttentionReason, "basis" | "reviewers">>) =>
    reasons.push({ reviewers: [], basis: "github", ...reason, ageMs: reason.since === null ? null : Math.max(0, now - reason.since) });
  const aged = (from: number | null, days: number) => from !== null && now - from >= days * DAY_MS;
  const pushed = time(pr.headCommittedAt);
  // A draft can't have sat unpushed since before it was opened: its branch was pushed to open it.
  const drafted = pushed === null ? null : Math.max(pushed, time(pr.createdAt) ?? pushed);
  const submitted = pr.latestReviews.filter((review) => review.state !== "PENDING");
  const green = checksGreen(pr.checkConclusions);

  // Feedback to address first, on any PR: an approval's note, else another person's comment, that no reply of yours on the PR answered
  // (or, for the note, your Confirm). A PR or issue that mentions this one, such as the rest of its stack, answers neither.
  const open = feedbackToAddress(pr, pr.approvalFeedbackConfirmed === true);
  for (const item of open) {
    add(item.kind === "approval"
      ? { question: "needs-nudge", kind: "approval-note", action: "confirm-handled", nextStep: "Answer the approval's comment", owner: "you", since: item.since }
      : { question: "needs-nudge", kind: "review-comments", action: "open-thread", nextStep: `Answer @${item.login}'s comment`, owner: "you", since: item.since });
  }

  if (pr.isDraft) {
    if (green && !conflicted(pr)) add({ question: "forgotten-draft", kind: "draft-ready", action: "mark-ready", nextStep: "Mark ready for review", owner: "you", since: drafted });
    else if (aged(drafted, thresholds.draftIdleDays)) add({ question: "forgotten-draft", kind: "draft-idle", action: "open-thread", nextStep: "Finish or close the draft", owner: "you", since: drafted });
  } else if (pr.reviewDecision !== "APPROVED" && !reviewEngaged(pr)) {
    add({ question: "missing-reviewer", kind: "missing-reviewer", action: "request-review", nextStep: "Request a review", owner: "you", since: time(pr.createdAt) });
  }

  const requested = new Set(pr.reviewRequests.map((login) => login.toLowerCase()));
  const waiting = (pr.reviewRequestedAt ?? []).flatMap(({ reviewer, at }) => {
    const asked = time(at);
    if (asked === null || !requested.has(reviewer.toLowerCase())) return [];
    // An undated review may be newer than the request, so it counts as an answer.
    if (submitted.some((review) => review.login.toLowerCase() === reviewer.toLowerCase() && (time(review.submittedAt) ?? Infinity) >= asked)) return [];
    return businessMsBetween(asked, now, utcOffsetMinutes) >= thresholds.nudgeAfterBusinessDays * DAY_MS ? [{ reviewer, asked }] : [];
  }).sort((a, b) => a.asked - b.asked);
  if (waiting.length) {
    const reviewers = waiting.map((wait) => wait.reviewer);
    add({ question: "needs-nudge", kind: "review-waiting", action: "nudge", nextStep: `Nudge ${mentions(reviewers)}`, owner: "reviewers", reviewers, since: waiting[0]!.asked });
  }

  // Ask again once you answered a review: a push or a reply of yours on the PR after it. Neither clears it: GitHub's decision still holds
  // the merge until the reviewer comes back, and a person's open thread or another change request still waits on you and leads the row
  // (your-turn.ts, inventory-view-model.ts).
  if (pr.reviewDecision !== "APPROVED") {
    const addressed = awaitingRerequest(pr).filter((review) => answeredSince(review, pr));
    if (addressed.length) {
      const reviewers = addressed.map((review) => review.login);
      const answers = [pushed, time(pr.reviewFeedback?.repliedAt)].flatMap((at) => at === null ? [] : [at]);
      add({ question: "needs-nudge", kind: "rereview-needed", action: "rerequest", nextStep: `Re-request review from ${mentions(reviewers)}`,
        owner: "you", reviewers, since: Math.max(...answers) });
    }
  }

  // Approved, green, merge-clean, and every review thread read and resolved: what the merge gates read from GitHub.
  const threadsResolved = pr.unresolvedReviewThreads === 0 && pr.resolvedReviewThreads !== null;
  const approvedClean = !pr.isDraft && pr.reviewDecision === "APPROVED" && green && mergeClean(pr) === true && threadsResolved;
  const approvals = submitted.filter((review) => review.state === "APPROVED").map((review) => time(review.submittedAt));
  // The newest approval; an undated one leaves the wait undated.
  const approved = approvals.length > 0 && approvals.every((at) => at !== null) ? Math.max(...(approvals as number[])) : null;
  // Notes you answered but haven't confirmed on this head still hold the merge, and you can confirm them yourself, so this asks at once.
  if (approvedClean && pr.approvalFeedback?.status === "present" && pr.approvalFeedbackVerified !== true && !open.some((item) => item.kind === "approval")) {
    add({ question: "needs-nudge", kind: "approval-comments", action: "confirm-handled", nextStep: "Confirm the approval's comments are handled", owner: "you",
      since: approved });
  }
  // Only what the merge gates pass: the above, approval feedback verified, no feedback to address, and no open parent to merge first.
  if (approvedClean && pr.approvalFeedbackVerified === true && open.length === 0 && pr.stackedOn == null) {
    // Mergeable since the newest approval, or the push after it.
    const from = approved === null ? null : Math.max(approved, pushed ?? approved);
    if (aged(from, thresholds.stuckAfterDays)) add({ question: "needs-nudge", kind: "merge-waiting", action: "merge", nextStep: "Merge", owner: "you", since: from });
  }

  const states = undatedStates(pr);
  for (const state of UNDATED_STATES) {
    const from = since[state] ?? null;
    if (states[state] === true && aged(from, thresholds.stuckAfterDays)) {
      add({ question: "needs-nudge", kind: state, action: "open-thread", nextStep: state === "ci-red" ? "Fix the failing checks" : "Resolve the conflicts",
        owner: "you", since: from, basis: "observed" });
    }
  }
  return reasons;
}
