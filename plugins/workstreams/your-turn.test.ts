// Your turn lists your PRs where a person's feedback waits on you, and nothing else, as the Reviews plugin reads it: each of the four
// clauses puts a PR on, a bot never does, and your answer takes it off. A PR waiting only on CI or on its reviewers stays off, so the badge
// never asks you to act where nothing is yours. One rule then says where a PR lists and whether Address takes it: a hold or a thread at
// work keeps it off, Dismiss hides it until its head moves or a person says more, and a sent PR keeps its thread's link with BB's live
// status for as long as it's open.
import { describe, expect, it } from "vitest";
import type { Pr } from "./contract.js";
import { parsePrList } from "./gh.js";
import { attentionReasons, DEFAULT_ATTENTION_THRESHOLDS } from "./pr-attention.js";
import { atWork, dismissed, sentState, sentText, turnOf, yourTurn, type Sent, type SentItem, type SentLink, type SentThread, type Turn, type TurnFacts }
  from "./your-turn.js";

const NOW = Date.UTC(2026, 8, 29, 15);
const at = (hour: number) => new Date(Date.UTC(2026, 8, 29, hour)).toISOString();
const base = parsePrList(JSON.stringify([{ number: 96, url: "https://github.com/inkwell/catalog/pull/96", state: "OPEN", title: "ABC-121 Show series order",
  isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: "c".repeat(40), latestReviews: [],
  reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }] }]))!.pr;
const pr = (patch: Partial<Pr>): Pr => ({ ...base, headCommittedAt: at(9), unresolvedReviewThreads: 0, resolvedReviewThreads: 0,
  approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, approvalFeedbackVerified: true,
  reviewFeedback: { openThreads: 0, comment: null, repliedAt: null }, ...patch });
/** The PR's own attention, which offers Re-request once you answered a change request and Confirm once you answered an approval's note. */
const reasons = (facts: Pr) => attentionReasons(facts, {}, { now: NOW, thresholds: DEFAULT_ATTENTION_THRESHOLDS, utcOffsetMinutes: 0 });
/** Your turn from the PR's facts alone: a hold, a Dismiss, or a thread at work is turnOf's to weigh. */
const turn = (facts: Pr) => yourTurn(facts);
const why = (facts: Pr) => turn(facts)?.why ?? null;

const changes = pr({ reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ login: "otto-v", state: "CHANGES_REQUESTED", submittedAt: at(10) }] });
const approval = pr({ reviewDecision: "APPROVED", latestReviews: [{ login: "mira-l", state: "APPROVED", submittedAt: at(11) }],
  approvalFeedback: { status: "present", fingerprint: "a".repeat(64), sourceIds: ["review-1"] }, approvalFeedbackVerified: false,
  reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: at(11), followUpAt: null } });
const threads = pr({ reviewFeedback: { openThreads: 2, comment: null, repliedAt: null } });
const comments = pr({ latestReviews: [{ login: "theo-k", state: "COMMENTED", submittedAt: at(12) }],
  reviewFeedback: { openThreads: 0, comment: { login: "theo-k", at: at(12) }, repliedAt: null } });
/** Codex's review with its threads: the review read leaves its threads out of the open threads a person had the last word in. */
const codex = { login: "chatgpt-codex-connector", state: "COMMENTED", submittedAt: at(12) };
const botOnly = pr({ latestReviews: [codex], reviewFeedback: { openThreads: 0, comment: null, repliedAt: null } });

describe("Your turn", () => {
  // Each clause alone puts a PR on, with one line of why: drop any and that kind of feedback waits unseen.
  it("puts a PR on for each of the four clauses, saying why and since when", () => {
    expect(turn(changes)).toEqual({ why: "Changes requested by @otto-v", since: Date.parse(at(10)), latest: Date.parse(at(10)) });
    expect(turn(approval)).toEqual({ why: "Approval comment from @mira-l", since: Date.parse(at(11)), latest: Date.parse(at(11)) });
    expect(turn(threads)).toEqual({ why: "2 open threads", since: null, latest: null });
    expect(turn(comments)).toEqual({ why: "Comment from @theo-k", since: Date.parse(at(12)), latest: Date.parse(at(12)) });
    // Several in one line, oldest for its age; a change request's reviewer isn't named again for its comment.
    const both = pr({ ...changes, reviewFeedback: { openThreads: 1, comment: { login: "theo-k", at: at(12) }, repliedAt: null } });
    expect(turn(both)).toMatchObject({ why: "Changes requested by @otto-v · Comment from @theo-k · 1 open thread", since: Date.parse(at(10)) });
    expect(why(pr({ ...changes, reviewFeedback: { openThreads: 0, comment: { login: "otto-v", at: at(10) }, repliedAt: null } }))).toBe("Changes requested by @otto-v");
  });

  // A code-review app (Claude, Codex, Copilot) never puts a PR on: drop the rule and every drive-by review fills the list and the badge.
  it("keeps a bot-only PR off, whatever the bot said", () => {
    expect(turn(botOnly)).toBeNull();
    expect(turn(pr({ ...botOnly, reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ login: "claude", state: "CHANGES_REQUESTED", submittedAt: at(13) }] }))).toBeNull();
    expect(turn(pr({ latestReviews: [{ login: "copilot-pull-request-reviewer", state: "APPROVED", submittedAt: at(12) }] }))).toBeNull();
    // Beside a person's feedback it's named nowhere.
    expect(why(pr({ ...changes, latestReviews: [...changes.latestReviews, codex] }))).toBe("Changes requested by @otto-v");
  });

  // Your reply last makes it the reviewer's turn: the review read leaves such a thread out of openThreads (ghactions.ts), and a reply
  // after a comment answers it. Drop it and answered threads stay on the list forever.
  it("takes a thread or comment off once your reply is last, and never on a push or a PR that links it", () => {
    expect(turn(pr({ reviewFeedback: { openThreads: 0, comment: null, repliedAt: at(13) } }))).toBeNull();
    expect(turn({ ...comments, reviewFeedback: { ...comments.reviewFeedback!, repliedAt: at(13) } })).toBeNull();
    expect(why({ ...comments, headCommittedAt: at(13) })).toBe("Comment from @theo-k");
    expect(why({ ...comments, reviewFeedback: { ...comments.reviewFeedback!, followUpAt: at(13) } })).toBe("Comment from @theo-k");
    expect(why({ ...comments, reviewFeedback: { ...comments.reviewFeedback!, repliedAt: at(11) } })).toBe("Comment from @theo-k");
    expect(turn({ ...comments, reviewFeedback: undefined })).toBeNull();
  });

  // Answered by a push or a reply, a change request waits on your re-request, which the row offers off Your turn; GitHub's decision still
  // holds the merge. Drop it and every answered request sits on Your turn until the reviewer comes back.
  it("takes a change request off once you pushed or replied after it, and offers Re-request", () => {
    for (const answered of [pr({ ...changes, headCommittedAt: at(13) }), pr({ ...changes, reviewFeedback: { openThreads: 0, comment: null, repliedAt: at(13) } })]) {
      expect(turn(answered)).toBeNull();
      expect(reasons(answered)).toContainEqual(expect.objectContaining({ kind: "rereview-needed", action: "rerequest", reviewers: ["otto-v"] }));
    }
    expect(why(pr({ ...changes, reviewFeedback: { openThreads: 0, comment: null, repliedAt: at(9) } }))).toBe("Changes requested by @otto-v");
    expect(turn({ ...changes, reviewRequests: ["otto-v"] })).toBeNull();
  });

  // An approval's note waits on your reply whatever CI says; once you replied it waits only on your Confirm, which still blocks the merge.
  it("keeps an approval comment on until you reply on the PR, then leaves it to Confirm", () => {
    for (const checks of [["PENDING"], ["FAILURE"]]) expect(why({ ...approval, checkConclusions: checks, mergeStateStatus: "UNSTABLE" })).toBe("Approval comment from @mira-l");
    // A PR that mentions it later, or a worker's evidence, is no answer the reviewer sees.
    expect(why({ ...approval, approvalFeedbackVerified: true, reviewFeedback: { ...approval.reviewFeedback!, followUpAt: at(14) } })).toBe("Approval comment from @mira-l");
    const answered = pr({ ...approval, reviewFeedback: { ...approval.reviewFeedback!, repliedAt: at(13) } });
    expect(turn(answered)).toBeNull();
    expect(reasons(answered)).toEqual([expect.objectContaining({ kind: "approval-comments", action: "confirm-handled" })]);
    expect(turn({ ...approval, approvalFeedbackVerified: true, approvalFeedbackConfirmed: true })).toBeNull();
  });

  // Drafts count, as in Reviews: a person's open thread or change request on your draft still waits on you. A hold hides nothing here:
  // the feedback still waits, and turnOf keeps the PR off Your turn until you release it.
  it("leaves off a closed PR and one waiting on CI or reviewers, but keeps a draft for every clause", () => {
    for (const facts of [changes, approval, threads, comments]) {
      expect(turn({ ...facts, state: "MERGED" })).toBeNull();
      expect(why({ ...facts, isDraft: true })).toBe(why(facts));
    }
    expect(turn(pr({ checkConclusions: ["FAILURE"], mergeStateStatus: "UNSTABLE" }))).toBeNull();
    expect(turn(pr({ reviewRequests: ["mira-l"] }))).toBeNull();
  });
});

// Dismiss hides a row from Your turn on the head it saw, like Reviews' dismissed items: a new head or a person's newer word brings it back.
// It keeps the newest word the row showed, not the click's time: a comment written before the click but read after it was never seen.
describe("Dismiss", () => {
  const head = base.headRefOid!;
  const seen = { head, latest: turn(comments)!.latest };
  it("hides until the head moves or a person says something newer than the row showed", () => {
    expect(dismissed(seen, head, turn(comments))).toBe(true);
    expect(dismissed(seen, "d".repeat(40), turn(comments))).toBe(false);
    const unseen = pr({ ...comments, reviewFeedback: { ...comments.reviewFeedback!, comment: { login: "theo-k", at: "2026-09-29T12:55:00.000Z" } } });
    expect(dismissed(seen, head, turn(unseen))).toBe(false);
    expect(dismissed(seen, head, turn(pr({ ...changes, latestReviews: [{ login: "otto-v", state: "CHANGES_REQUESTED", submittedAt: at(14) }] })))).toBe(false);
    // Nothing waiting, or never dismissed, is nothing to hide.
    expect(dismissed(seen, head, null)).toBe(false);
    expect(dismissed(null, head, turn(comments))).toBe(false);
  });
});

// One rule says where a PR lists and whether Address takes it, for All PRs, its badge, the deck, a batch's listing, and its dispatch. It
// reads facts, never the button a row leads with: a re-request leading the row once dropped Address (756e943). A thread at work has the PR
// instead of you, unless it's the batch thread its own Address started, whose state the row keeps showing; a hold or a held effort parks it.
describe("where a PR lists", () => {
  const ready: TurnFacts = { owes: true, hold: false, pile: "active", dismissed: false, executor: null, batchThread: null, sent: null };
  const sent = (state: Sent["state"]) => ({ state });
  /** A thread at work on the PR now. */
  const busy = (id = "thr-other") => ({ executor: { id, active: true } });
  const BUSY = "An agent is already working on it.";
  it("lists each PR once by its facts, and says why Address can't take it", () => {
    const table: [Partial<TurnFacts>, Turn["list"], Turn["addressable"]][] = [
      [{}, "turn", true],
      [{ owes: false }, "other", "No feedback waits on you."],
      [{ owes: false, hold: true, ...busy(), dismissed: true }, "other", "No feedback waits on you."],
      [{ ...busy() }, "in-flight", BUSY],
      // The thread that worked on it last, now idle, keeps nothing.
      [{ executor: { id: "thr-other", active: false } }, "turn", true],
      // The batch's thread ended and another took the PR: that one has it, not you.
      [{ ...busy(), batchThread: "thr-batch", sent: sent("idle") }, "in-flight", BUSY],
      [{ ...busy(), sent: sent("working") }, "turn", BUSY],
      [{ sent: sent("needs-you") }, "turn", BUSY],
      [{ sent: sent("sending") }, "turn", "A write on it is waiting or just ran."],
      [{ sent: sent("idle") }, "turn", true],
      [{ sent: sent("refused") }, "turn", true],
      [{ sent: sent("failed") }, "turn", true],
      [{ hold: true }, "held", "On hold. Release it first."],
      [{ pile: "held" }, "held", "Its effort is on hold."],
      // A done or archived effort's PR still lists, as All PRs shows it, but nothing writes to it.
      [{ pile: "done" }, "turn", "Its effort is done."],
      [{ pile: "archived" }, "turn", "Its effort is archived."],
      [{ dismissed: true }, "dismissed", "You dismissed it from Your turn."],
      [{ dismissed: true, hold: true }, "held", "On hold. Release it first."],
      [{ dismissed: true, ...busy() }, "in-flight", BUSY],
    ];
    expect(table.map(([facts]) => { const turn = turnOf({ ...ready, ...facts }); return [facts, turn.list, turn.addressable]; })).toEqual(table);
  });

  // From the moment its Address's batch thread starts, that thread at work is the row's own, whatever Sent reads yet: taken for another
  // agent's, the row left Your turn and came back once Sent read Working.
  it("keeps a row on Your turn while its own batch thread works, whatever Sent reads", () => {
    const own = { ...busy("thr-batch"), batchThread: "thr-batch" };
    const table: [Partial<TurnFacts>, Turn["list"], Turn["addressable"]][] = [
      [{ ...own, sent: null }, "turn", BUSY],
      [{ ...own, sent: sent("idle") }, "turn", BUSY],
      [{ ...own, sent: sent("sending") }, "turn", "A write on it is waiting or just ran."],
      [{ ...own, sent: sent("working") }, "turn", BUSY],
    ];
    expect(table.map(([facts]) => { const turn = turnOf({ ...ready, ...facts }); return [facts, turn.list, turn.addressable]; })).toEqual(table);
  });

  it("parks a row for any other thread at work, whatever its batch thread is", () => {
    const other = busy("thr-other");
    const table: [Partial<TurnFacts>, Turn["list"], Turn["addressable"]][] = [
      [{ ...other, batchThread: "thr-batch", sent: null }, "in-flight", BUSY],
      [{ ...other, batchThread: "thr-batch", sent: sent("idle") }, "in-flight", BUSY],
      [{ ...other, batchThread: null, sent: null }, "in-flight", BUSY],
    ];
    expect(table.map(([facts]) => { const turn = turnOf({ ...ready, ...facts }); return [facts, turn.list, turn.addressable]; })).toEqual(table);
  });
});

// A sent PR's one link is the thread its Address started, stored once when that start returned: its batch item while the batch waits or
// was refused, else that thread with BB's status for it. Which batch a thread belongs to is stored, never told from times (dde6814). The
// link outlives the thread for as long as the PR is open; only a newer batch's thread replaces it.
describe("a sent PR", () => {
  const item = (state: SentItem["state"], detail: string | null = null): SentItem => ({ state, detail, batchId: "b-2" });
  const link = (threadId = "thr-1", batchId: string | null = "b-2"): SentLink => ({ threadId, batchId });
  const thread = (status: string, patch: Partial<SentThread> = {}): SentThread => ({ title: "Address feedback: catalog #96", status, waiting: false, error: null, ...patch });
  const shown = (sent: Sent | null) => sent && [sent.state, sent.threadId, sentText(sent)];

  it("shows Sending with Undo, then its thread with BB's live status, and keeps the link after the thread ends", () => {
    expect(shown(sentState(item("queued"), null, null))).toEqual(["sending", null, "Sending"]);
    expect(sentState(item("queued"), null, null)?.batchId).toBe("b-2");
    expect(sentState(item("sending"), null, null)?.batchId).toBeNull();
    // Starting and pending are BB queueing or starting its turn, as a thread not listed yet a moment after its start reads.
    for (const status of ["active", "starting", "pending"]) expect(shown(sentState(item("sent"), link(), thread(status)))).toEqual(["working", "thr-1", "Working"]);
    // However many PRs its batch took, a thread asking you something needs you.
    expect(shown(sentState(item("sent"), link(), thread("active", { waiting: true })))).toEqual(["needs-you", "thr-1", "Needs you"]);
    expect(shown(sentState(item("sent"), link(), thread("error", { error: "Provider overloaded" })))).toEqual(["failed", "thr-1", "Failed: Provider overloaded"]);
    expect(shown(sentState(item("sent"), link(), thread("error")))).toEqual(["failed", "thr-1", "Failed"]);
    expect(shown(sentState(item("sent"), link(), thread("idle")))).toEqual(["idle", "thr-1", "Idle"]);
    // Its batch item gone after a day, the link stays and BB says whether the thread works again; a thread BB no longer lists keeps it too.
    expect(shown(sentState(null, link(), thread("active")))).toEqual(["working", "thr-1", "Working"]);
    expect(sentState(null, link(), null)).toMatchObject({ state: "idle", threadId: "thr-1", title: null });
  });

  it("holds its PR only while its thread works or asks you something", () => {
    expect(["active", "starting", "pending", "stopping", "idle", "error"].map((status) => atWork(thread(status)))).toEqual([true, true, true, true, false, false]);
    expect([atWork(thread("active", { waiting: true })), atWork(null)]).toEqual([true, false]);
  });

  // A refused batch started nothing, so the older thread it would have replaced stays linked beside the reason, an older build's included.
  it("says why dispatch refused it beside an older batch's thread, and lets a newer batch replace that link", () => {
    const refused = item("refused", "On hold. Release it first.");
    expect(shown(sentState(refused, link("thr-1", "b-1"), thread("idle")))).toEqual(["refused", "thr-1", "Not sent: On hold. Release it first."]);
    expect(shown(sentState(refused, link("thr-1", null), thread("active")))).toEqual(["refused", "thr-1", "Not sent: On hold. Release it first."]);
    expect(shown(sentState(refused, null, null))).toEqual(["refused", null, "Not sent: On hold. Release it first."]);
    expect(shown(sentState(item("queued"), link("thr-1", "b-1"), null))).toEqual(["sending", null, "Sending"]);
    // A reload cut its start off: the thread BB made is its own batch's link once recovery finds it, else it reads as not sent.
    expect(shown(sentState(item("unknown", "The plugin restarted"), link("thr-2"), thread("active")))).toEqual(["working", "thr-2", "Working"]);
    expect(shown(sentState(item("unknown", "The plugin restarted"), link("thr-1", "b-1"), thread("idle")))).toEqual(["refused", "thr-1", "Not sent: The plugin restarted"]);
  });
});
