// Feedback to address: what a reviewer said on your PR that still waits on
// your answer. An approval that says anything (a comment, a question, a
// condition, or a request) and any other person's comment (a review body, an
// inline thread, or the PR's conversation) wait until you answer: a reply
// from the PR's author on this PR after it (a conversation comment, a review,
// or a thread reply) or, for an approval's notes, your evidence-checked
// Confirm on this head. An issue or a PR that mentions this one, such as the
// rest of its stack, answers nothing: the reviewer sees no reply, so Confirm
// shows those links as evidence instead. A push alone answers nothing, and
// none of it depends on CI, a draft, conflicts, or merge state. While any
// waits, the PR never reads ready and never merges. Bots (deploy previews,
// trackers, CI, and code-review apps) never count: a code-review app's notes
// are bot notes (your-turn.ts), which a batch addresses too but which never
// wait on you as a person's do. This module imports only zod, so the browser
// can use it (A12.1).
import { z } from "zod";

/**
 * What a PR's own review read shows of feedback on it (ghactions.ts): open threads where a person other than you had the last word, bots'
 * words skipped, the newest comment from someone else that no later approval of theirs covers, its author's newest reply, when the
 * approval's newest note was left, and when a follow-up last linked it, which answers nothing. `noteAt` and `followUpAt` are absent on a
 * read that predates them. Stored and strict: a thread you spoke last in, or only bots did, stays out of `openThreads` rather than in a
 * field of its own, so an older build still reads it; a read from before that rule counts by who opened the thread until the PR is read
 * again.
 */
export const reviewFeedbackSchema = z.object({
  openThreads: z.number().int().min(0).max(2_000),
  comment: z.object({ login: z.string().max(140), at: z.string().max(40) }).strict().nullable(),
  repliedAt: z.string().max(40).nullable(),
  noteAt: z.string().max(40).nullable().optional(),
  followUpAt: z.string().max(40).nullable().optional(),
}).strict();
export type ReviewFeedback = z.infer<typeof reviewFeedbackSchema>;

/**
 * Apps some reads name as users: deploy previews, issue trackers, CI, and code-review apps (Claude, Codex, Copilot, and the rest), with or
 * without "[bot]". GitHub's own Bot type catches the rest.
 */
const BOTS = new Set(["vercel", "linear", "github-actions", "dependabot", "renovate", "codecov", "netlify", "sonarcloud", "sonarqubecloud", "coderabbitai",
  "copilot", "copilot-pull-request-reviewer", "claude", "codex", "openai-codex", "chatgpt-codex-connector", "greptile-apps", "graphite-app", "gemini-code-assist"]);
export function isBot(login: string, typename?: unknown): boolean {
  return typename === "Bot" || /(?:\[bot\]|-bot)$/iu.test(login) || BOTS.has(login.toLowerCase());
}

export const FEEDBACK_KINDS = ["approval", "comment"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
/** One piece of feedback that waits on you; `since` is when it was left, null when nothing dates it. */
export type FeedbackItem = { kind: FeedbackKind; login: string | null; since: number | null };
/** Each kind as a row's state names it. */
export const FEEDBACK_LABEL: Record<FeedbackKind, string> = { approval: "Approval comment to address", comment: "Comment to address" };

export type FeedbackFacts = { approvalFeedback?: { status: string }; reviewFeedback?: ReviewFeedback };

const time = (value: string | null | undefined): number | null => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
};

/**
 * The feedback waiting on you, the approval's notes first. `confirmed`: your evidence-checked confirmation covers this head and these
 * notes. An approval note no read dated waits until you confirm it; a comment the read didn't see asks nothing.
 */
export function feedbackToAddress(facts: FeedbackFacts, confirmed: boolean): FeedbackItem[] {
  const read = facts.reviewFeedback;
  // Only your reply on this PR: a follow-up that links it never does.
  const replied = time(read?.repliedAt);
  const answered = (at: number | null) => at !== null && replied !== null && replied > at;
  const items: FeedbackItem[] = [];
  if (facts.approvalFeedback?.status === "present" && !confirmed) {
    const at = time(read?.noteAt);
    if (!answered(at)) items.push({ kind: "approval", login: null, since: at });
  }
  const comment = read?.comment;
  const at = time(comment?.at);
  if (comment && at !== null && !answered(at)) items.push({ kind: "comment", login: comment.login, since: at });
  return items;
}
