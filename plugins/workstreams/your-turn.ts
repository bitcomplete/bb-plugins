// Your turn: your open PRs where a person's feedback waits on your move, as the Reviews plugin reads it, from facts the inventory already
// keeps. A PR is on it when any of these waits: an approval's note no reply or Confirm of yours followed, changes a person asked for that
// neither a push nor a reply of yours followed, an open thread where another person had the last word (the review read skips bots' words,
// and your reply last is the reviewer's turn), or another person's comment no reply of yours on the PR followed. A bot (Claude, Codex,
// Copilot, CI) never puts a PR on it; a batch still addresses every comment, bots' included. A push answers no comment or thread, and
// neither does a PR that mentions this one. A draft is on it, as Reviews counts drafts. turnOf then says where each PR lists and whether
// Address takes it, for every reader alike: a hold, its effort's pile, Dismiss, and a thread at work weigh in there, never the button its
// row leads with. Pure and browser-safe: All PRs, the deck, a batch's listing, and its dispatch each ask turnOf.
import { z } from "zod";
import type { Pr } from "./contract.js";
import { feedbackToAddress, isBot } from "./feedback-to-address.js";
import { answeredSince, awaitingRerequest } from "./pr-gates.js";

export const yourTurnSchema = z.object({
  /** Why, in one line: "Changes requested by @otto · Approval comment from @mira". */
  why: z.string(),
  /** When the oldest feedback it names arrived, and the newest a person left, in epoch ms; null when nothing dates it. */
  since: z.number().nullable(), latest: z.number().nullable(),
}).strict();
export type YourTurn = z.infer<typeof yourTurnSchema>;

export type YourTurnFacts = Pick<Pr, "state" | "reviewRequests" | "latestReviews" | "reviewFeedback" | "headCommittedAt" | "approvalFeedback"
  | "approvalFeedbackConfirmed">;

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

/** Where a PR lists: Your turn, the ones you dismissed from it, parked by a hold, worked by a thread, or nothing waits on you. */
const TURN_LISTS = ["turn", "dismissed", "held", "in-flight", "other"] as const;
/** `addressable`: Address may take it now, or why not. */
export const turnSchema = z.object({ list: z.enum(TURN_LISTS), addressable: z.union([z.literal(true), z.string()]) }).strict();
export type Turn = z.infer<typeof turnSchema>;
export type TurnFacts = {
  /** yourTurn found a person's feedback waiting on you. */
  owes: boolean;
  /** You hold the PR. */
  hold: boolean;
  /** Its effort's pile: active with no effort. */
  pile: "active" | "held" | "done" | "archived";
  /** You dismissed it on this head, and no person has said more since. */
  dismissed: boolean;
  /** The thread working on it now or last, and whether it's at work now: its own, or its Address's batch thread. */
  executor: { id: string; active: boolean } | null;
  /** Its newest Address batch thread, by id, once that thread's start links it. */
  batchThread: string | null;
  /** Where its newest Address sent it. */
  sent: Pick<Sent, "state"> | null;
};
/** Sent states its batch or that batch's thread still owns. */
const OWNED: ReadonlySet<Sent["state"]> = new Set(["sending", "working", "needs-you"]);
const BUSY = "An agent is already working on it.";
const PAUSED = { held: "Its effort is on hold.", done: "Its effort is done.", archived: "Its effort is archived." } as const;
/**
 * Where a PR lists, first that applies: nothing waits on you; a thread at work has it, unless it's the batch thread its own Address
 * started, known by its id from the moment it starts, whose state its row keeps showing on Your turn; your hold or its effort's parks it;
 * you dismissed it. Address takes only a Your turn PR that nothing it sent still owns and whose effort is active. Never the button a row
 * leads with.
 */
export function turnOf(facts: TurnFacts): Turn {
  const working = facts.executor?.active ? facts.executor.id : null;
  // Its own batch thread at work is the batch's, whatever Sent reads before BB's word on that thread and its link agree.
  const batch = (facts.sent !== null && OWNED.has(facts.sent.state)) || (working !== null && working === facts.batchThread);
  const [list, why]: [Turn["list"], string | null] = !facts.owes ? ["other", "No feedback waits on you."]
    : working !== null && !batch ? ["in-flight", BUSY]
    : facts.hold ? ["held", "On hold. Release it first."]
    : facts.pile === "held" ? ["held", PAUSED.held]
    : facts.dismissed ? ["dismissed", "You dismissed it from Your turn."]
    : ["turn", facts.sent?.state === "sending" ? "A write on it is waiting or just ran." : batch ? BUSY : facts.pile === "active" ? null : PAUSED[facts.pile]];
  return { list, addressable: why ?? true };
}

/** A Dismiss, kept per PR: the head and the newest word its row showed, so a word read after the click still brings it back. */
export const dismissalSchema = z.object({ head: z.string(), latest: z.number().nullable() }).strict();
export type Dismissal = z.infer<typeof dismissalSchema>;
/** Dismissed holds until the head moves or a person says something newer than the row showed. */
export const dismissed = (dismissal: Dismissal | null | undefined, head: string | null, turn: Pick<YourTurn, "latest"> | null): boolean =>
  !!dismissal && !!turn && dismissal.head === head && (turn.latest ?? 0) <= (dismissal.latest ?? 0);

/**
 * Where the newest Address batch sent a PR, and how its thread stands now: waiting out its Undo window, refused by dispatch, or its
 * thread's live status. The link stays for as long as the PR is open, a refusal's included, until a newer batch's thread takes it.
 */
export const SENT_STATES = ["sending", "refused", "working", "needs-you", "failed", "idle"] as const;
export const sentSchema = z.object({
  state: z.enum(SENT_STATES), threadId: z.string().nullable(), title: z.string().nullable(),
  /** Why dispatch refused it, or why its thread failed. */
  detail: z.string().nullable(),
  /** The batch still in its Undo window, which Undo takes back. */
  batchId: z.string().nullable(),
}).strict();
export type Sent = z.infer<typeof sentSchema>;
/** The PR's newest Address item: its state, its batch, and what dispatch said. */
export type SentItem = { state: "queued" | "sending" | "sent" | "refused" | "unknown"; detail: string | null; batchId: string };
/** The PR's newest batch thread, stored when its start returned, and the batch that started it; null for an earlier build's. */
export type SentLink = { threadId: string; batchId: string | null };
/** That thread as BB lists it now: its status, whether it asks you something, and why it failed. Null once BB lists it no more. */
export type SentThread = { title: string | null; status: string; waiting: boolean; error: string | null };
/** BB's statuses for a thread starting, at work, or stopping: queued counts. */
const AT_WORK: ReadonlySet<string> = new Set(["starting", "pending", "active", "stopping"]);
/** A batch thread holds its PRs while it works or asks you something. */
export const atWork = (thread: SentThread | null): boolean => !!thread && (thread.waiting || AT_WORK.has(thread.status));

/** A PR's Sent from its newest Address item, its newest batch thread, and that thread as BB lists it. */
export function sentState(item: SentItem | null, link: SentLink | null, thread: SentThread | null): Sent | null {
  const none = { threadId: null, title: null, detail: null, batchId: null };
  if (item?.state === "queued" || item?.state === "sending") return { ...none, state: "sending", batchId: item.state === "queued" ? item.batchId : null };
  const linked = { threadId: link?.threadId ?? null, title: thread?.title ?? null };
  // Its batch started no thread: dispatch refused it, or a reload cut its start off and BB made none. An older batch's thread stays linked.
  if (item && link?.batchId !== item.batchId && (item.state === "refused" || item.state === "unknown")) return { ...none, ...linked, state: "refused", detail: item.detail };
  if (!link) return null;
  if (atWork(thread)) return { ...none, ...linked, state: thread!.waiting ? "needs-you" : "working" };
  return thread?.status === "error" ? { ...none, ...linked, state: "failed", detail: thread.error } : { ...none, ...linked, state: "idle" };
}

/** A Sent's words. Sending's Undo is the row's own button. */
export function sentText(sent: Sent): string {
  switch (sent.state) {
    case "sending": return "Sending";
    case "refused": return `Not sent: ${sent.detail ?? "refused"}`;
    case "working": return "Working";
    case "needs-you": return "Needs you";
    case "failed": return sent.detail ? `Failed: ${sent.detail}` : "Failed";
    case "idle": return "Idle";
  }
}
