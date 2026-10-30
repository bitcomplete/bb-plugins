// What an approval's notes say and whether anything since shows they were
// handled. Confirming notes handled clears the merge gate on your word, so
// the confirm reads GitHub fresh and shows its evidence first: commits after
// the approval, a reply from the PR's author after it (a PR comment or a
// review reply), and every inline thread the newest note opened resolved.
// With none of those, one click never confirms: its thread is asked to
// address the notes, or you confirm anyway and the record says there was no
// evidence. Issues and PRs the author linked the PR from since are shown
// beside it, since one may be the follow-up the note asked for, but a
// mention is no reply and never counts. This module imports only zod, so the
// browser can use it (A12.1).
import { z } from "zod";

/** How much of one note the confirm shows. */
export const NOTE_MAX = 1_200;

export const approvalSourceSchema = z.object({
  /** The review or thread id, as the approval feedback's source ids name it. */
  id: z.string(),
  /** An approving or follow-up review's body, or an inline thread the approval opened, by its first comment. */
  kind: z.enum(["review", "thread"]),
  author: z.string(), at: z.string(), body: z.string(), truncated: z.boolean(),
  /** A thread's state; null for a review body. */
  resolved: z.boolean().nullable(),
}).strict();
export type ApprovalSource = z.infer<typeof approvalSourceSchema>;

export const approvalEvidenceSchema = z.object({
  /** When the newest approval note was left: only what came after it counts. */
  since: z.string(),
  commits: z.number().int().nonnegative(),
  replies: z.number().int().nonnegative(),
  /** The inline threads the newest note opened; none for a note only in a review body. An older note's thread may have been resolved before it. */
  threads: z.object({ total: z.number().int().nonnegative(), resolved: z.number().int().nonnegative() }).strict(),
  /** False when GitHub's answer was cut short, so a commit or reply may be unread: that is never evidence. */
  complete: z.boolean(),
  /** Issues and PRs the PR's author linked it from since, oldest first: shown, never counted. Absent when there are none. */
  linked: z.array(z.object({ repo: z.string().max(200), number: z.number().int().positive() }).strict()).max(50).optional(),
}).strict();
export type ApprovalEvidence = z.infer<typeof approvalEvidenceSchema>;

/** Anything since the approval that shows its notes were handled. */
export function handled(evidence: ApprovalEvidence): boolean {
  return evidence.complete && (evidence.commits > 0 || evidence.replies > 0 || (evidence.threads.total > 0 && evidence.threads.resolved === evidence.threads.total));
}

export const NO_EVIDENCE = "No commits, reply, or resolved threads since this approval";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The evidence in one line: what came after the approval, or plainly that nothing did. */
export function evidenceText(evidence: ApprovalEvidence): string {
  if (!evidence.complete) return "GitHub's answer was cut short, so there's no evidence to show";
  const { total, resolved } = evidence.threads;
  if (!handled(evidence)) return resolved ? `${resolved} of ${plural(total, "thread")} resolved; no commits or replies since this approval` : NO_EVIDENCE;
  return `${[evidence.commits && plural(evidence.commits, "commit"), evidence.replies && plural(evidence.replies, "reply", "replies"),
    total && `${resolved} of ${plural(total, "thread")} resolved`].filter(Boolean).join(" · ")} since this approval`;
}

/** The follow-ups since the approval in one line, by repository name and number; null when there are none. */
export function linkedText(evidence: ApprovalEvidence): string | null {
  const refs = (evidence.linked ?? []).map(({ repo, number }) => `${repo.split("/").at(-1)} #${number}`);
  return refs.length ? `Linked: ${refs.join(", ")} ${refs.length === 1 ? "mentions" : "mention"} this PR` : null;
}

/** The confirm's fresh read: the head and feedback it binds to, each note, and the evidence since the newest. */
export const approvalHandlingSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), headOid: z.string().regex(/^[0-9a-f]{40}$/u), fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    sources: z.array(approvalSourceSchema).max(300), evidence: approvalEvidenceSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(800) }).strict(),
]);
export type ApprovalHandling = z.infer<typeof approvalHandlingSchema>;

/**
 * Where Ask would send: the PR's own thread, a new thread beneath a parent that already exists (`under` names its effort, or its repository
 * when no effort owns it), or why it can't, since asking never creates an effort or its threads.
 */
export const askToSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), title: z.string() }).strict(),
  z.object({ kind: z.literal("new"), under: z.string() }).strict(),
  z.object({ kind: z.literal("none"), why: z.string() }).strict(),
]);

/** What the confirm shows for one PR: the fresh read, and where Ask would send. */
export const confirmReadSchema = z.discriminatedUnion("ok", [
  approvalHandlingSchema.options[0].extend({ ask: askToSchema }).strict(),
  approvalHandlingSchema.options[1],
]);
export type ConfirmRead = z.infer<typeof confirmReadSchema>;

/** Your confirmation of a PR's notes, as its row shows it: when, whether it still covers this head and these notes, and whether evidence backed it. */
export const userConfirmationSchema = z.object({ at: z.number(), current: z.boolean(),
  /** Null for a confirmation made before evidence was read. */
  evidence: z.boolean().nullable() }).strict();
export type UserConfirmation = z.infer<typeof userConfirmationSchema>;
