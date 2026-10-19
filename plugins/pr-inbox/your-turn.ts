// Extracted from Workstreams: the four human-feedback rules, independent of efforts.
import { z } from "zod";
import { feedbackToAddress, isBot } from "./feedback-to-address.js";
import { answeredSince, awaitingRerequest } from "./pr-gates.js";

export const yourTurnSchema = z.object({
  /** Why, in one line: "Changes requested by @otto · Approval comment from @mira". */
  why: z.string(),
  /** When the oldest feedback it names arrived, and the newest a person left, in epoch ms; null when nothing dates it. */
  since: z.number().nullable(), latest: z.number().nullable(),
}).strict();
export type YourTurn = z.infer<typeof yourTurnSchema>;

export type YourTurnFacts = {
  state: string;
  reviewRequests: string[];
  latestReviews: { login: string; state: string; submittedAt?: string }[];
  reviewFeedback?: import("./feedback-to-address.js").ReviewFeedback;
  headCommittedAt?: string;
  approvalFeedback?: { status: string };
  approvalFeedbackConfirmed?: boolean;
};

const time = (value: string | null | undefined): number | null => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
};
const mentions = (logins: readonly string[]) => logins.map((login) => `@${login}`).join(", ");
const dates = (values: readonly (number | null)[]) => values.filter((value): value is number => value !== null && Number.isFinite(value));

/** Whether a person's feedback waits on you on this PR, and why, from its facts alone. */
export function yourTurn(pr: YourTurnFacts): YourTurn | null {
  if (pr.state !== "OPEN") return null;
  const people = pr.latestReviews.filter((review) => !isBot(review.login));
  const parts: { text: string; since: number | null }[] = [];
  // A person's change request that no push or reply of yours followed. Answered, it waits on your re-request, which attention offers.
  const changes = awaitingRerequest({ ...pr, latestReviews: people }).filter((review) => review.state === "CHANGES_REQUESTED" && !answeredSince(review, pr));
  if (changes.length) parts.push({ text: `Changes requested by ${mentions(changes.map((review) => review.login))}`,
    since: Math.min(...changes.map((review) => time(review.submittedAt) ?? Number.POSITIVE_INFINITY)) });
  // Only a note no reply of yours or Confirm followed: notes you answered wait on the row's Confirm, which still holds the merge.
  const waiting = feedbackToAddress(pr, pr.approvalFeedbackConfirmed === true);
  const approval = waiting.find((item) => item.kind === "approval");
  const approvers = people.filter((review) => review.state === "APPROVED").map((review) => review.login);
  if (approval) parts.push({ text: approvers.length ? `Approval comment from ${mentions(approvers)}` : "Approval comment", since: approval.since });
  const read = pr.reviewFeedback;
  // Another person's comment no reply on the PR answered; a change request's reviewer is named once.
  const comment = waiting.find((item) => item.kind === "comment");
  if (comment && !changes.some((review) => review.login === comment.login)) parts.push({ text: `Comment from @${comment.login}`, since: comment.since });
  const open = read?.openThreads ?? 0;
  if (open > 0) parts.push({ text: `${open} open ${open === 1 ? "thread" : "threads"}`, since: null });
  if (!parts.length) return null;
  const oldest = dates(parts.map((part) => part.since));
  // The newest a person said, which Dismiss compares: their approval or change request, their comment, or the approval's note.
  const newest = dates([...people.filter((review) => review.state !== "COMMENTED").map((review) => time(review.submittedAt)), time(read?.comment?.at), time(read?.noteAt)]);
  return { why: parts.map((part) => part.text).join(" · "), since: oldest.length ? Math.min(...oldest) : null, latest: newest.length ? Math.max(...newest) : null };
}
