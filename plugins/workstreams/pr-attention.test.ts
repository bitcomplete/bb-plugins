import { describe, expect, it } from "vitest";
import {
  attentionReasons, businessMsBetween, DEFAULT_ATTENTION_THRESHOLDS, prAttention, undatedStates,
  type AttentionClock, type AttentionFacts, type AttentionReason, type StateSince,
} from "./pr-attention.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A Wednesday afternoon, so "a day ago" never crosses a weekend unless a row says so.
const now = Date.UTC(2026, 8, 30, 15);
const iso = (at: number) => new Date(at).toISOString();
const url = "https://github.com/inkwell/folio/pull/42";
const clock: AttentionClock = { now, thresholds: DEFAULT_ATTENTION_THRESHOLDS, utcOffsetMinutes: 0 };
// Open, green, mergeable, and asked of mira an hour ago: nothing is overdue yet.
const quiet: AttentionFacts = {
  url, state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED", checkConclusions: ["SUCCESS"],
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewRequests: ["mira"], latestReviews: [],
  unresolvedReviewThreads: null, resolvedReviewThreads: null, createdAt: iso(now - 3 * DAY),
  headCommittedAt: iso(now - 2 * HOUR), reviewRequestedAt: [{ reviewer: "mira", at: iso(now - HOUR) }],
};
// Every merge gate the board can read passes: threads read and resolved, approval feedback verified, no parent.
const approved: Partial<AttentionFacts> = { reviewDecision: "APPROVED", reviewRequests: [], reviewRequestedAt: [],
  headCommittedAt: iso(now - 3 * DAY), latestReviews: [{ login: "mira", state: "APPROVED", submittedAt: iso(now - DAY) }],
  unresolvedReviewThreads: 0, resolvedReviewThreads: 0, approvalFeedbackVerified: true };
// Approved as above, but the approval said something a day ago that nothing since has answered or verified.
const noted: Partial<AttentionFacts> = { ...approved, approvalFeedbackVerified: false,
  approvalFeedback: { status: "present", fingerprint: "f".repeat(64), sourceIds: ["review-1"] },
  reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: iso(now - DAY), followUpAt: null } };
// The same comments, answered by your reply since, but not yet verified on this head.
const commented: Partial<AttentionFacts> = { ...noted, reviewFeedback: { ...noted.reviewFeedback!, repliedAt: iso(now - HOUR) } };
const changes = (submittedAt: number, state = "CHANGES_REQUESTED"): Partial<AttentionFacts> => ({
  reviewDecision: state === "DISMISSED" ? "REVIEW_REQUIRED" : "CHANGES_REQUESTED",
  reviewRequests: [], reviewRequestedAt: [], latestReviews: [{ login: "otto", state, submittedAt: iso(submittedAt) }] });
// The verified follow-up the gates require: a newer head, no thread open, and the author's PTAL.
const followedUp: Partial<AttentionFacts> = { reviewFollowupPosted: true, unresolvedReviewThreads: 0, resolvedReviewThreads: 2 };
// Opened a week ago, so each draft row turns on its last push.
const draft: Partial<AttentionFacts> = { isDraft: true, reviewRequests: [], reviewRequestedAt: [], checkConclusions: ["PENDING"], createdAt: iso(now - 7 * DAY) };

const reasons = (change: Partial<AttentionFacts> = {}, since: StateSince = {}, at: Partial<AttentionClock> = {}) =>
  attentionReasons({ ...quiet, ...change }, since, { ...clock, ...at });
const kinds = (...args: Parameters<typeof reasons>) => reasons(...args).map((reason) => reason.kind);

describe("PR attention", () => {
  it("asks nothing of an open PR whose review was requested an hour ago", () => {
    expect(reasons()).toEqual([]);
  });

  // Each row changes the facts that one rule reads, often at its threshold's
  // edge. If a rule reads another fact or moves its threshold, its row fails.
  it.each<[string, Partial<AttentionFacts>, StateSince, AttentionReason["kind"][]]>([
    ["a draft with green checks and no conflict", { ...draft, checkConclusions: ["SUCCESS"] }, {}, ["draft-ready"]],
    ["a draft in a repository without checks", { ...draft, checkConclusions: [] }, {}, ["draft-ready"]],
    ["a green draft whose conflict GitHub reported", { ...draft, checkConclusions: ["SUCCESS"], mergeable: "CONFLICTING" }, {}, []],
    ["a draft with no push for exactly the idle days", { ...draft, headCommittedAt: iso(now - 3 * DAY) }, {}, ["draft-idle"]],
    ["a draft pushed just inside the idle days", { ...draft, headCommittedAt: iso(now - 3 * DAY + 1) }, {}, []],
    ["a draft whose last push is undated", { ...draft, headCommittedAt: undefined }, {}, []],
    ["a draft opened today on an older commit", { ...draft, createdAt: iso(now - HOUR), headCommittedAt: iso(now - 4 * DAY) }, {}, []],
    ["a draft opened the idle days ago on an older commit", { ...draft, createdAt: iso(now - 3 * DAY), headCommittedAt: iso(now - 4 * DAY) }, {}, ["draft-idle"]],
    ["a ready PR nobody was asked to review", { reviewRequests: [], reviewRequestedAt: [] }, {}, ["missing-reviewer"]],
    ["a ready PR with only your own pending review", { reviewRequests: [], latestReviews: [{ login: "reader", state: "PENDING" }] }, {}, ["missing-reviewer"]],
    ["a ready PR someone reviewed unasked", { reviewRequests: [], latestReviews: [{ login: "otto", state: "COMMENTED", submittedAt: iso(now - DAY) }] }, {}, []],
    ["a request exactly one business day old", { reviewRequestedAt: [{ reviewer: "mira", at: iso(now - DAY) }] }, {}, ["review-waiting"]],
    ["a request just under one business day old", { reviewRequestedAt: [{ reviewer: "mira", at: iso(now - DAY + 1) }] }, {}, []],
    ["a request answered by a review since", { reviewRequestedAt: [{ reviewer: "mira", at: iso(now - 2 * DAY) }],
      latestReviews: [{ login: "Mira", state: "COMMENTED", submittedAt: iso(now - DAY) }] }, {}, []],
    ["a re-request after the reviewer's last review", { reviewRequestedAt: [{ reviewer: "mira", at: iso(now - 2 * DAY) }],
      latestReviews: [{ login: "mira", state: "CHANGES_REQUESTED", submittedAt: iso(now - 3 * DAY) }] }, {}, ["review-waiting"]],
    ["a request beside an undated review from that reviewer", { reviewRequestedAt: [{ reviewer: "mira", at: iso(now - 2 * DAY) }],
      latestReviews: [{ login: "mira", state: "COMMENTED" }] }, {}, []],
    ["a request whose time is unknown", { reviewRequestedAt: undefined }, {}, []],
    ["a request time for a reviewer no longer requested", { reviewRequests: ["otto"], reviewRequestedAt: [{ reviewer: "mira", at: iso(now - 2 * DAY) }] }, {}, []],
    // A push or a reply of yours after a change request answers it enough to ask again; GitHub's decision still holds the merge, and an
    // open thread a person spoke last in still waits on you on its own.
    ["changes requested, pushed, and followed up", { ...changes(now - 2 * DAY), ...followedUp }, {}, ["rereview-needed"]],
    ["changes requested, then a push", { ...changes(now - 2 * DAY), unresolvedReviewThreads: 0, resolvedReviewThreads: 2 }, {}, ["rereview-needed"]],
    ["changes requested, then a push with threads still open", { ...changes(now - 2 * DAY), unresolvedReviewThreads: 5, resolvedReviewThreads: 0 }, {}, ["rereview-needed"]],
    ["changes requested, then your reply and no push", { ...changes(now - HOUR), reviewFeedback: { openThreads: 0, comment: null, repliedAt: iso(now - 30 * MINUTE) } }, {},
      ["rereview-needed"]],
    ["changes requested, with neither a push nor a reply since", { ...changes(now - HOUR), reviewFeedback: { openThreads: 0, comment: null, repliedAt: iso(now - 3 * HOUR) } },
      {}, []],
    ["a follow-up on a head older than the review", { ...changes(now - HOUR), ...followedUp }, {}, []],
    ["changes requested, followed up, and asked again", { ...changes(now - 2 * DAY), ...followedUp, reviewRequests: ["otto"] }, {}, []],
    ["a review dismissed by a later push", changes(now - 2 * DAY, "DISMISSED"), {}, ["rereview-needed"]],
    ["approved, green, and mergeable for a day", approved, {}, ["merge-waiting"]],
    ["approved just under a day ago", { ...approved, latestReviews: [{ login: "mira", state: "APPROVED", submittedAt: iso(now - DAY + 1) }] }, {}, []],
    ["approved a day ago but pushed since", { ...approved, headCommittedAt: iso(now - HOUR) }, {}, []],
    ["approved with an undated approval", { ...approved, latestReviews: [{ login: "mira", state: "APPROVED" }] }, {}, []],
    ["approved but blocked by branch protection", { ...approved, mergeStateStatus: "BLOCKED" }, {}, []],
    ["approved while GitHub computes mergeability", { ...approved, mergeable: "UNKNOWN" }, {}, []],
    ["approved with checks running", { ...approved, checkConclusions: ["PENDING"] }, {}, []],
    ["approved with a review thread still open", { ...approved, unresolvedReviewThreads: 3 }, {}, []],
    ["approved with review thread pages left unread", { ...approved, resolvedReviewThreads: null }, {}, []],
    ["approved with its approval feedback unverified", { ...approved, approvalFeedbackVerified: false }, {}, []],
    ["approved with feedback GitHub couldn't fully read", { ...approved, approvalFeedback: { status: "unknown", fingerprint: null, sourceIds: [] },
      approvalFeedbackVerified: false }, {}, []],
    // An approval that said something no one answered is feedback to address, first and whatever CI, a draft, a conflict, a push, or a
    // worker's evidence says; only your reply on the PR or your Confirm clears it, never a PR that mentions it, and until then nothing asks
    // to merge.
    ["approved with a comment no one answered", noted, {}, ["approval-note"]],
    ["approved with a comment no one answered, and red checks", { ...noted, checkConclusions: ["FAILURE"] }, { "ci-red": now - 2 * DAY }, ["approval-note", "ci-red"]],
    ["approved with a comment no one answered, and checks running", { ...noted, checkConclusions: ["PENDING"] }, {}, ["approval-note"]],
    ["approved with a comment no one answered, conflicting", { ...noted, mergeable: "CONFLICTING" }, {}, ["approval-note"]],
    ["approved with a comment no one answered, blocked by branch protection", { ...noted, mergeStateStatus: "BLOCKED" }, {}, ["approval-note"]],
    ["approved with a comment no one answered, a review thread still open", { ...noted, unresolvedReviewThreads: 1 }, {}, ["approval-note"]],
    ["approved with a comment no one answered, stacked on an open PR", { ...noted, stackedOn: 41 }, {}, ["approval-note"]],
    ["a green draft approved with a comment no one answered", { ...noted, isDraft: true }, {}, ["approval-note", "draft-ready"]],
    ["approved with a comment no one answered, pushed since", { ...noted, headCommittedAt: iso(now - HOUR) }, {}, ["approval-note"]],
    ["approved with a comment no one answered, and a worker's evidence on this head", { ...noted, approvalFeedbackVerified: true }, {}, ["approval-note"]],
    ["approved with a comment you confirmed on this head", { ...noted, approvalFeedbackVerified: true, approvalFeedbackConfirmed: true }, {}, ["merge-waiting"]],
    ["approved with a comment only a later PR mentioning it followed, verified on this head", { ...noted, approvalFeedbackVerified: true,
      reviewFeedback: { ...noted.reviewFeedback!, followUpAt: iso(now - HOUR) } }, {}, ["approval-note"]],
    ["approved with a comment you replied to on the PR, verified on this head", { ...noted, approvalFeedbackVerified: true,
      reviewFeedback: { ...noted.reviewFeedback!, repliedAt: iso(now - HOUR), followUpAt: iso(now - HOUR) } }, {}, ["merge-waiting"]],
    ["approved, green, and mergeable, with a reviewer's comment no one answered", { ...approved,
      reviewFeedback: { openThreads: 0, comment: { login: "theo", at: iso(now - 2 * HOUR) }, repliedAt: iso(now - DAY), noteAt: null, followUpAt: null } }, {},
      ["review-comments"]],
    ["approved, green, and mergeable, with a reviewer's comment you replied to", { ...approved,
      reviewFeedback: { openThreads: 0, comment: { login: "theo", at: iso(now - 2 * HOUR) }, repliedAt: iso(now - HOUR), noteAt: null, followUpAt: null } }, {},
      ["merge-waiting"]],
    // Comments you answered that nobody has verified on this head: you confirm them, at once, once nothing else holds the merge.
    ["approved with comments not yet confirmed", commented, {}, ["approval-comments"]],
    ["approved with comments a minute ago", { ...commented, latestReviews: [{ login: "mira", state: "APPROVED", submittedAt: iso(now - MINUTE) }] }, {}, ["approval-comments"]],
    ["approved with comments, stacked on an open PR", { ...commented, stackedOn: 41 }, {}, ["approval-comments"]],
    ["approved with comments and a review thread still open", { ...commented, unresolvedReviewThreads: 1 }, {}, []],
    ["approved with comments and review thread pages left unread", { ...commented, resolvedReviewThreads: null }, {}, []],
    ["approved with comments and checks running", { ...commented, checkConclusions: ["PENDING"] }, {}, []],
    ["approved with comments and red checks", { ...commented, checkConclusions: ["FAILURE"] }, {}, []],
    ["approved with comments but blocked by branch protection", { ...commented, mergeStateStatus: "BLOCKED" }, {}, []],
    ["approved with comments, conflicting", { ...commented, mergeable: "CONFLICTING" }, {}, []],
    // Green, so only its being a draft keeps it from asking for the confirmation: marking it ready comes first.
    ["a green draft approved with comments", { ...commented, isDraft: true }, {}, ["draft-ready"]],
    ["approved with comments verified on this head", { ...commented, approvalFeedbackVerified: true }, {}, ["merge-waiting"]],
    ["approved but stacked on an open PR", { ...approved, stackedOn: 41 }, {}, []],
    ["approved over an older change request", { ...approved, latestReviews: [...approved.latestReviews!, { login: "otto", state: "CHANGES_REQUESTED", submittedAt: iso(now - 4 * DAY) }] }, {}, ["merge-waiting"]],
    ["red for exactly a day", { checkConclusions: ["FAILURE"] }, { "ci-red": now - DAY }, ["ci-red"]],
    ["red for just under a day", { checkConclusions: ["FAILURE"] }, { "ci-red": now - DAY + 1 }, []],
    ["red with no record of when", { checkConclusions: ["FAILURE"] }, {}, []],
    ["green again after a red record", {}, { "ci-red": now - 2 * DAY }, []],
    ["conflicting for a day", { mergeable: "CONFLICTING" }, { conflicting: now - DAY }, ["conflicting"]],
    ["dirty for a day", { mergeStateStatus: "DIRTY" }, { conflicting: now - DAY }, ["conflicting"]],
    ["undecided mergeability after a conflict record", { mergeable: "UNKNOWN" }, { conflicting: now - 2 * DAY }, []],
    ["a red draft that is also idle", { ...draft, checkConclusions: ["FAILURE"], headCommittedAt: iso(now - 4 * DAY) }, { "ci-red": now - 2 * DAY }, ["draft-idle", "ci-red"]],
    ["closed", { state: "CLOSED", reviewRequests: [], checkConclusions: ["FAILURE"] }, { "ci-red": now - 2 * DAY }, []],
  ])("%s", (_name, change, since, expected) => {
    expect(kinds(change, since)).toEqual(expected);
  });

  it("names each step's owner, action, and age, and labels ages GitHub doesn't keep", () => {
    expect(reasons({ ...draft, checkConclusions: ["SUCCESS"] })).toEqual([{ question: "forgotten-draft", kind: "draft-ready", action: "mark-ready",
      nextStep: "Mark ready for review", owner: "you", reviewers: [], since: now - 2 * HOUR, ageMs: 2 * HOUR, basis: "github" }]);
    expect(reasons({ reviewRequests: [], reviewRequestedAt: [] })).toEqual([{ question: "missing-reviewer", kind: "missing-reviewer",
      action: "request-review", nextStep: "Request a review", owner: "you", reviewers: [], since: now - 3 * DAY, ageMs: 3 * DAY, basis: "github" }]);
    // The reviewers are the owners, oldest request first; a team request is nudged like a person.
    expect(reasons({ reviewRequests: ["mira", "inkwell/editors", "otto"], reviewRequestedAt: [{ reviewer: "mira", at: iso(now - 2 * DAY) },
      { reviewer: "inkwell/editors", at: iso(now - 5 * DAY) }, { reviewer: "otto", at: iso(now - HOUR) }] })).toEqual([{ question: "needs-nudge",
      kind: "review-waiting", action: "nudge", nextStep: "Nudge @inkwell/editors, @mira", owner: "reviewers", reviewers: ["inkwell/editors", "mira"],
      since: now - 5 * DAY, ageMs: 5 * DAY, basis: "github" }]);
    expect(reasons({ ...changes(now - 2 * DAY), ...followedUp })).toEqual([{ question: "needs-nudge", kind: "rereview-needed", action: "rerequest",
      nextStep: "Re-request review from @otto", owner: "you", reviewers: ["otto"], since: now - 2 * HOUR, ageMs: 2 * HOUR, basis: "github" }]);
    expect(reasons(approved)).toEqual([{ question: "needs-nudge", kind: "merge-waiting", action: "merge", nextStep: "Merge", owner: "you",
      reviewers: [], since: now - DAY, ageMs: DAY, basis: "github" }]);
    // Aged from the newest approval, not the push, since the comments came with it.
    expect(reasons({ ...commented, latestReviews: [{ login: "mira", state: "APPROVED", submittedAt: iso(now - 2 * DAY) },
      { login: "otto", state: "APPROVED", submittedAt: iso(now - 4 * HOUR) }] })).toEqual([{ question: "needs-nudge", kind: "approval-comments",
      action: "confirm-handled", nextStep: "Confirm the approval's comments are handled", owner: "you", reviewers: [], since: now - 4 * HOUR, ageMs: 4 * HOUR,
      basis: "github" }]);
    // Feedback to address leads, aged from the note or the comment.
    expect(reasons({ ...noted, reviewFeedback: { ...noted.reviewFeedback!, comment: { login: "theo", at: iso(now - 2 * HOUR) } } }).slice(0, 2)).toEqual([
      { question: "needs-nudge", kind: "approval-note", action: "confirm-handled", nextStep: "Answer the approval's comment", owner: "you", reviewers: [],
        since: now - DAY, ageMs: DAY, basis: "github" },
      { question: "needs-nudge", kind: "review-comments", action: "open-thread", nextStep: "Answer @theo's comment", owner: "you", reviewers: [],
        since: now - 2 * HOUR, ageMs: 2 * HOUR, basis: "github" }]);
    expect(reasons({ checkConclusions: ["FAILURE"], mergeable: "CONFLICTING" }, { "ci-red": now - 2 * DAY, conflicting: now - 3 * DAY })).toEqual([
      { question: "needs-nudge", kind: "ci-red", action: "open-thread", nextStep: "Fix the failing checks", owner: "you", reviewers: [],
        since: now - 2 * DAY, ageMs: 2 * DAY, basis: "observed" },
      { question: "needs-nudge", kind: "conflicting", action: "open-thread", nextStep: "Resolve the conflicts", owner: "you", reviewers: [],
        since: now - 3 * DAY, ageMs: 3 * DAY, basis: "observed" },
    ]);
  });

  it("skips the weekend before nudging a reviewer", () => {
    const monday = Date.UTC(2026, 9, 5, 11);
    const fridayNoon = iso(Date.UTC(2026, 9, 2, 12));
    const asked = { reviewRequestedAt: [{ reviewer: "mira", at: fridayNoon }] };
    // Three calendar days, but only 23 weekday hours.
    expect(kinds(asked, {}, { now: monday })).toEqual([]);
    expect(kinds(asked, {}, { now: monday + HOUR })).toEqual(["review-waiting"]);
  });

  it("reads each threshold from settings", () => {
    const lenient = { thresholds: { draftIdleDays: 5, nudgeAfterBusinessDays: 2, stuckAfterDays: 2 } };
    expect(kinds({ ...draft, headCommittedAt: iso(now - 4 * DAY) }, {}, lenient)).toEqual([]);
    expect(kinds({ ...draft, headCommittedAt: iso(now - 5 * DAY) }, {}, lenient)).toEqual(["draft-idle"]);
    expect(kinds({ reviewRequestedAt: [{ reviewer: "mira", at: iso(now - DAY) }] }, {}, lenient)).toEqual([]);
    expect(kinds({ reviewRequestedAt: [{ reviewer: "mira", at: iso(now - 2 * DAY) }] }, {}, lenient)).toEqual(["review-waiting"]);
    expect(kinds(approved, {}, lenient)).toEqual([]);
    expect(kinds({ checkConclusions: ["FAILURE"] }, { "ci-red": now - DAY }, lenient)).toEqual([]);
    expect(kinds({ mergeable: "CONFLICTING" }, { conflicting: now - 2 * DAY }, lenient)).toEqual(["conflicting"]);
  });

  it("shows a held PR as held and nudges nobody about it, since every step it names is refused under a hold", () => {
    const stuck = { ...quiet, checkConclusions: ["FAILURE"], reviewRequestedAt: [{ reviewer: "mira", at: iso(now - 3 * DAY) }] };
    const since = { "ci-red": now - 2 * DAY };
    const effort = { id: "effort-shelves", key: "ticket:ABC-340", name: "Shelf order" };
    expect(prAttention(stuck, { holds: {}, effort, since }, clock)).toMatchObject({ effort: { id: "effort-shelves", name: "Shelf order" }, held: false,
      reasons: [{ kind: "review-waiting" }, { kind: "ci-red" }] });
    // Holds are keyed by canonical URL, so a differently cased link is the same PR.
    const holds = { [url]: { reason: "Waiting on the pricing launch", heldAt: now - DAY } };
    expect(prAttention({ ...stuck, url: url.replace("inkwell", "Inkwell") }, { holds, effort: null, since }, clock))
      .toEqual({ effort: null, held: true, reasons: [] });
  });
});

describe("undated PR states", () => {
  it("starts a conflict on GitHub's report, ends it on a clean merge check, and leaves it alone while GitHub is undecided", () => {
    expect(undatedStates({ checkConclusions: ["FAILURE", "PENDING"], mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })).toEqual({ "ci-red": true, conflicting: true });
    expect(undatedStates({ checkConclusions: ["PENDING"], mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" })).toEqual({ "ci-red": false, conflicting: false });
    expect(undatedStates({ checkConclusions: [], mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).toEqual({ "ci-red": false, conflicting: null });
    expect(undatedStates({ checkConclusions: [], mergeable: null, mergeStateStatus: "UNKNOWN" })).toEqual({ "ci-red": false, conflicting: null });
  });
});

describe("business days", () => {
  const at = (day: number, hour: number) => Date.UTC(2026, 9, day, hour);
  // October 2026: the 2nd is a Friday, the 3rd and 4th a weekend, the 5th a Monday.
  it.each<[string, number, number, number, number]>([
    ["within a weekday", at(1, 9), at(1, 17), 0, 8 * HOUR],
    ["from Friday noon to Monday noon", at(2, 12), at(5, 12), 0, DAY],
    ["across a weekend only", at(3, 10), at(4, 20), 0, 0],
    ["from Saturday into Monday", at(3, 10), at(5, 6), 0, 6 * HOUR],
    ["over a whole week", at(5, 0), at(12, 0), 0, 5 * DAY],
    ["backwards", at(5, 12), at(2, 12), 0, 0],
    // Friday 20:00 to Saturday 06:00 UTC is Friday afternoon and evening in Inkwell's UTC-7 office.
    ["late Friday in UTC", at(2, 20), at(3, 6), 0, 4 * HOUR],
    ["the same span at UTC-7", at(2, 20), at(3, 6), -420, 10 * HOUR],
  ])("counts %s", (_name, from, to, offset, expected) => {
    expect(businessMsBetween(from, to, offset)).toBe(expected);
  });
});
