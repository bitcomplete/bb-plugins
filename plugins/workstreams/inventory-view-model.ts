// The PR inventory screen's view model (plan amendment A13): pure functions
// from inventory_get's output to what the screen draws. The server decided
// each row's state word, attention, owner, and age; this words them, nests
// each stack under its parent, and says which one-click action a row offers
// and why an action it can't take is disabled. It imports types, and Your
// turn's one rule from your-turn.ts, which is pure, so no server module
// reaches the browser.
import type { InventoryQuestion, InventoryRow, InventoryView } from "./inventory-view";
import type { AttentionReason } from "./pr-attention";
import type { SuggestionGroup } from "./effort-classify";
import { turnOf, type Sent, type Turn, type TurnFacts } from "./your-turn";

/** An observation's or hold's age: 25s, 52m, 5h, 2d. */
export function age(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1_000));
  return seconds < 60 ? `${seconds}s` : seconds < 3_600 ? `${Math.floor(seconds / 60)}m` : seconds < 86_400 ? `${Math.floor(seconds / 3_600)}h` : `${Math.floor(seconds / 86_400)}d`;
}

/** A time of day today, else a date: "11:32", "Sep 26". */
export function clock(at: number, now: number): string {
  const when = new Date(at);
  return when.toDateString() === new Date(now).toDateString()
    ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    : when.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Realtime: the server publishes it after each inventory read, single-PR read, hold change, and recorded inventory action. */
export const INVENTORY_CHANGED = "inventory-changed";

/** Attention categories retained in the inventory read model. */
export const QUESTIONS: readonly { key: InventoryQuestion; label: string; none: string }[] = [
  { key: "forgotten-draft", label: "Forgotten in draft", none: "No PR is forgotten in draft." },
  { key: "missing-reviewer", label: "Missing a reviewer", none: "Every PR has a reviewer." },
  { key: "needs-nudge", label: "Needs a nudge", none: "Nothing needs a nudge." },
];

/** Help copy for the two All PRs lists and their available action. */
export const INVENTORY_HOW: { intro: string; rows: [string, string][] } = {
  intro: "All PRs shows your open pull requests and PRs named by an effort. Your turn lists your PRs where a reviewer's feedback waits on you. Other open PRs stays below, grouped by effort.",
  rows: [
    ["Your turn", "A person's approval comment you haven't replied to, their change request with no push or reply since, a thread where they spoke last, or their comment with no reply of yours. Bots never put a PR here. Held PRs stay out."],
    ["Address", "Select Your turn rows with x, a click, or Shift for a range, then Address or b. One thread starts for all of them at once, with 8 s to Undo, and never merges."],
    ["Sent", "A sent row links its thread with BB's status for it: Working, Needs you, or Idle. The link stays while the PR is open, on Other open PRs once it leaves Your turn."],
    ["Dismiss", "Hides a row from Your turn until its head moves or someone says something new."],
    ["Move", "Select any rows, then Move to effort… or e: type to pick an effort or One-offs, or name a new effort. Rows regroup at once, with Undo."],
    ["Suggestion", "A row no effort owns shows the effort the classifier picks for it, → Effort?, with why on hover. Click it or ⇧A to accept, × to hide it. Weak or tied picks show nothing."],
    ["Other open PRs", "Each row shows its current state and next step. Open the PR to inspect it."],
    ["Nudge", "Appears only when a reviewer has waited long enough and the current PR state allows another request. The server checks again before sending. Your turn offers none: you answer first. After a change request you answered, it reads Re-request @login."],
    ["Refresh", "↻ on a row, g, or Refresh on a selection reads those PRs from GitHub again, review threads included. The row says Read just now, or why the read failed."],
    ["Last read", "When the inventory last finished reading GitHub; click it to read every open PR again. A failed read keeps the last available rows visible."],
  ],
};

/** A GitHub login or org/team slug, as ghactions.ts's REVIEWER reads one; a test keeps the two equal. */
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})?$/u;

export type ActionId = "mark-ready" | "request-review" | "nudge" | "confirm-handled" | "revoke" | "merge" | "refresh" | "thread";
/** Who acts next: you, the reviewers a step names, or the PR this one is stacked on. */
export type Owner = { kind: "you" | "reviewers" | "parent"; label: string };
/** `since`: when what it answers began, in epoch ms, as `age` words it; null when nothing dates it. */
export type Step = { text: string; owner: Owner; age: string | null; ageTitle: string | null; since: number | null };
export type LineAction = {
  id: ActionId; label: string; enabled: boolean;
  /** Why a disabled action can't run now. */
  why: string | null;
  /** What the action does, for its tooltip and accessible name. */
  title: string;
  /** Whom a nudge asks again. */
  reviewers: string[];
  threadId: string | null;
};
export type ReviewerChip = { login: string; state: "requested" | "approved" | "changes requested" | "commented" | "dismissed" | "reviewed" };
export type InventoryLine = {
  prUrl: string;
  /** The repository's short name, and its owner/name. */
  repo: string; slug: string; number: number; title: string; draft: boolean;
  /** False for a teammate's PR an effort names: it asks nothing of you. */
  authored: boolean;
  reviewers: ReviewerChip[];
  /** Whom the reviewer picker suggests: this PR's past reviewers, then its repository's recent ones. */
  suggested: string[];
  /**
   * The server's state word; "Clear" on an approved PR reads "Ready to merge", or "Ready · your word" while your confirmation
   * of its review notes is what clears it, and approval comments to confirm read "Approved with comments". Feedback to address follows
   * whatever else holds the PR: "CI failing · approval comment to address".
   */
  status: string;
  hold: { reason: string | null; age: string } | null;
  /** Its effort is on hold, done, or archived: All PRs offers no write on it. */
  effortPile: "held" | "done" | "archived" | null;
  steps: Step[];
  /** The action the first step names, which the row leads with. */
  primary: ActionId | null;
  actions: LineAction[];
  threads: { id: string; title: string; active: boolean; role: "working" | "started" }[];
  checked: { text: string; title: string; failed: boolean; stale: boolean };
  /** What the last action on the PR did, or why it was refused. */
  last: { text: string; ok: boolean } | null;
  /** A person's feedback that waits on you, as the server found it, and how long it has waited. */
  yourTurn: { why: string; age: string | null } | null;
  /** Where it lists, Your turn or dismissed from it among them, and whether Address takes it (turnOf). */
  turn: Turn;
  /** The batch thread addressing that feedback now, which holds the PR's claim until it finishes; its id is null while it starts. */
  addressing: { threadId: string | null } | null;
  /** Where the newest Address batch sent it, and its thread's live status. */
  sent: Sent | null;
  /** Stack depth under its parent, and its branch glyph. */
  depth: number; branch: "├" | "└" | null;
};
export type InventoryGroup = { key: string; effort: InventoryView["groups"][number]["effort"]; label: string; lines: InventoryLine[] };
export type InventoryScreen = {
  counts: { key: InventoryQuestion; label: string; count: number; active: boolean }[];
  read: { text: string; title: string; refreshing: boolean };
  /** A failed or rate-limited read, and the server's warnings. */
  notices: { tone: "error" | "info"; text: string }[];
  groups: InventoryGroup[];
  /** What an empty list says; null when rows show. */
  empty: string | null;
};
/** The action each PR's click is running, by PR URL. */
export type Pending = ReadonlyMap<string, ActionId>;
/** What this visit's clicks got back, by PR URL: a refresh's read, or an action's result or refusal. */
export type Outcome = { at: number; action: ActionId; ok: boolean; text: string };

const WORD: Record<ActionId, string> = { "mark-ready": "Mark ready", "request-review": "Request review", nudge: "Nudge", "confirm-handled": "Confirm handled",
  revoke: "Revoke confirmation", merge: "Merge", refresh: "Refresh", thread: "Open thread" };
const RUNNING: Record<ActionId, string> = { "mark-ready": "Marking ready…", "request-review": "Requesting…", nudge: "Nudging…", "confirm-handled": "Confirming…",
  revoke: "Revoking…", merge: "Merge…", refresh: "Reading…", thread: "Open thread" };
/** What a recorded action no row button names was, as a refusal says it. */
const RECORDED: Record<"ask-thread" | "ask-fix" | "revoke-confirmation", string> = { "ask-thread": "Ask its thread", "ask-fix": "Ask its thread to fix",
  "revoke-confirmation": "Revoke confirmation" };
const STEP_ACTION: Record<AttentionReason["action"], ActionId> = { "mark-ready": "mark-ready", "request-review": "request-review", nudge: "nudge",
  rerequest: "nudge", "confirm-handled": "confirm-handled", merge: "merge", "open-thread": "thread" };
const REVIEW_STATE: Record<string, ReviewerChip["state"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented",
  DISMISSED: "dismissed" };
/** Code work the state word names, for a row the three questions don't ask about yet: you do it in the PR's thread. */
const CODE_WORK: Record<string, string> = { "CI failing": "Fix the failing checks", Conflicts: "Resolve the conflicts",
  "Changes requested": "Address the requested changes", "Branch behind": "Update the branch", Draft: "Finish the draft" };
/** An approval whose written notes no one has confirmed handled doesn't merge yet: you read them on GitHub. */
const APPROVAL_NOTES: Record<string, string> = { "Feedback verification needed": "Read the approval's notes and confirm they're handled",
  "New review feedback": "Read the new review feedback", "Verification needs recheck": "Recheck the approval's notes against the new head" };
/** Ready only on your word: a later head, or a worker's evidence, replaces it and asks for the notes again. */
export const CONFIRMED = "Ready · your word";
/** Feedback to address, as a row's state adds it after whatever else holds the PR. */
const FEEDBACK_WORDS: Partial<Record<AttentionReason["kind"], string>> = { "approval-note": "approval comment to address", "review-comments": "comment to address" };
/** Why Confirm handled can't bind to what the row shows. */
const UNCONFIRMABLE = "No head or approval comments read yet; Refresh first";
/** A read that left the PR's state open: Refresh reads it again. */
const UNREAD = new Set(["Status unknown", "Review history unknown"]);
const YOU: Owner = { kind: "you", label: "you" };
/**
 * Attention moves that answer Your turn's feedback: confirming the approval's notes, and a thread's code work, whose fix takes the feedback
 * too. Merging, nudging someone else, or asking again leaves it waiting: a re-request follows a change request you already answered, which
 * Your turn no longer lists, so leading with it would skip a person's open thread or another change request still waiting on you.
 */
const ANSWERS: ReadonlySet<AttentionReason["action"]> = new Set(["confirm-handled", "open-thread"]);

const mentions = (logins: readonly string[]) => logins.map((login) => `@${login}`).join(", ");
const keyOf = (row: Pick<InventoryRow, "repo" | "number">) => `${row.repo.toLowerCase()}#${row.number}`;
/** Whom a nudge asks again: every reviewer an overdue request or an answered change request names, as the server's nudge checks them. */
export const nudgees = (row: Pick<InventoryRow, "attention">) =>
  [...new Set(row.attention.filter((reason) => reason.action === "nudge" || reason.action === "rerequest").flatMap((reason) => reason.reviewers))];

/** The server calls it mergeable now: a merge reason, or "Clear" on an approved PR stacked on nothing; never with feedback to address. */
function mergeable(row: InventoryRow): boolean {
  return row.hold === null && row.authored && !row.attention.some((reason) => FEEDBACK_WORDS[reason.kind]) &&
    (row.attention.some((reason) => reason.action === "merge") || (row.stage === "ready" && row.status === "Clear" && row.stackedOn === null));
}

/**
 * The row's state and every piece of feedback to address it doesn't already name: "CI failing · approval comment to address". Feedback to
 * address never reads beside ready: it holds the merge.
 */
function statusOf(row: InventoryRow): string {
  const feedback = row.attention.flatMap((reason) => FEEDBACK_WORDS[reason.kind] ?? []);
  const word = row.attention.some((reason) => reason.kind === "approval-comments") ? "Approved with comments"
    : row.status !== "Clear" || row.stage !== "ready" ? row.status : feedback.length ? "" : row.confirmation?.current ? CONFIRMED : "Ready to merge";
  const text = [word, ...feedback.filter((item) => item !== word.toLowerCase())].filter(Boolean).join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Approved and waiting only on the PR it's stacked on, which is itself mergeable or next in line: it merges in stack order. */
function inOrder(row: InventoryRow, parents: ReadonlyMap<string, InventoryRow>, seen = new Set<string>()): boolean {
  const parent = row.stackedOn === null ? undefined : parents.get(`${row.repo.toLowerCase()}#${row.stackedOn}`);
  if (!parent || seen.has(keyOf(row)) || row.hold !== null || row.stage !== "ready" || row.status !== `Behind #${row.stackedOn}`) return false;
  seen.add(keyOf(row));
  return mergeable(parent) || inOrder(parent, parents, seen);
}

/**
 * Each reason's step with its owner and age, led by the one that answers Your turn's feedback, else by that feedback; with none, the step
 * the state word or the stack names, so an authored row that needs you never reads blank. Held and teammates' rows ask nothing.
 */
export function nextSteps(row: InventoryRow, parents: ReadonlyMap<string, InventoryRow>, now: number): { steps: Step[]; primary: ActionId | null } {
  if (row.hold !== null || !row.authored) return { steps: [], primary: null };
  const step = (text: string, owner: Owner = YOU, since: number | null = null): Step => ({ text, owner, since,
    age: since === null ? null : age(since, now), ageTitle: since === null ? null : `Since ${new Date(since).toLocaleString()}` });
  // Feedback that waits on you is its thread's work, as old as the feedback.
  const feedback = row.yourTurn && step("Address the review feedback", YOU, row.yourTurn.since);
  if (row.attention.length) {
    // Your turn's feedback leads, so the deck files the row where Your turn lists it: the attention move that answers it, else the feedback.
    const answer = feedback ? row.attention.find((reason) => ANSWERS.has(reason.action)) : undefined;
    const reasons = answer ? [answer, ...row.attention.filter((reason) => reason !== answer)] : row.attention;
    const steps = reasons.map((reason): Step => ({ text: reason.nextStep, since: reason.since,
      owner: reason.owner === "reviewers" ? { kind: "reviewers", label: "reviewers" } : YOU,
      age: reason.since === null ? null : `${age(reason.since, now)}${reason.basis === "observed" ? "+" : ""}`,
      ageTitle: reason.since === null ? null : reason.basis === "observed"
        ? "At least this long: dated from the first read that saw it" : `Since ${new Date(reason.since).toLocaleString()}` }));
    return feedback && !answer ? { steps: [feedback, ...steps], primary: "thread" } : { steps, primary: STEP_ACTION[reasons[0]!.action] };
  }
  if (CODE_WORK[row.status]) return { steps: [step(CODE_WORK[row.status]!)], primary: "thread" };
  if (/^\d+ open threads?$/u.test(row.status)) return { steps: [step("Resolve the open review threads")], primary: "thread" };
  if (APPROVAL_NOTES[row.status]) return { steps: [step(APPROVAL_NOTES[row.status]!)], primary: null };
  if (UNREAD.has(row.status)) return { steps: [step("Refresh to read it again")], primary: "refresh" };
  // Feedback the state word doesn't name is its thread's work too.
  if (feedback) return { steps: [feedback], primary: "thread" };
  if (row.stackedOn !== null && row.status === `Behind #${row.stackedOn}`) {
    return inOrder(row, parents) ? { steps: [step(`Merge after #${row.stackedOn}`)], primary: "merge" }
      : { steps: [step(`Waits on #${row.stackedOn}`, { kind: "parent", label: `#${row.stackedOn}` })], primary: null };
  }
  if (mergeable(row)) return { steps: [step("Merge")], primary: "merge" };
  if (row.status === "Awaiting review" && row.reviewers.requested.length) {
    return { steps: [step(`Waiting on ${mentions(row.reviewers.requested)}`, { kind: "reviewers", label: "reviewers" })], primary: null };
  }
  if (row.status === "Awaiting re-review") return { steps: [step("Waiting on re-review", { kind: "reviewers", label: "reviewers" })], primary: null };
  return { steps: [], primary: null };
}

/** Why All PRs writes nothing to a done or archived effort's PR, and the way back; the server refuses it too. */
const EFFORT_STOPPED = { done: "Its effort is done. Reopen it first", archived: "Its effort is archived. Restore it first" } as const;
/**
 * The row's actions: each write its attention offers, Merge… when it's mergeable or next in its stack, then Refresh and Open thread. A held
 * effort's row offers no write, and a done or archived effort's row says why each can't run.
 */
export function rowActions(row: InventoryRow, parents: ReadonlyMap<string, InventoryRow>, context: { now: number; limitedUntil: number | null;
  running: ActionId | null; effortPile?: InventoryLine["effortPile"]; turn?: boolean }): LineAction[] {
  const actions: LineAction[] = [];
  const thread = row.threads.executor ?? row.threads.origin;
  const action = (id: ActionId, title: string, why: string | null, extra: Partial<LineAction> = {}): LineAction =>
    ({ id, label: context.running === id ? RUNNING[id] : id === "request-review" || id === "merge" || id === "confirm-handled" ? `${WORD[id]}…` : WORD[id], enabled: why === null, why, title,
      reviewers: [], threadId: null, ...extra });
  // Every write reads the PR from GitHub first, so it waits out a rate limit, and one action runs on a PR at a time.
  const blocked = context.running !== null ? "Another action on this PR is running"
    : context.limitedUntil !== null ? `GitHub's rate limit holds reads until ${clock(context.limitedUntil, context.now)}; try then` : null;
  const target = `${row.repo.split("/").at(-1)} #${row.number}`;
  const asks = (id: AttentionReason["action"]) => row.attention.some((reason) => reason.action === id);
  if (asks("mark-ready")) actions.push(action("mark-ready", `Mark ${target} ready for review, pinned to the head this row shows`,
    blocked ?? (row.head === null ? "No head commit read yet; Refresh first" : null)));
  if (asks("request-review")) actions.push(action("request-review", `Pick reviewers to ask for ${target}`, blocked));
  // Asking again after your answer, a change request's move once you pushed or replied, reads Re-request: the same write re-adds the
  // reviewer. While feedback waits on you, nobody is asked again: you answer first.
  const nudged = context.turn ? [] : nudgees(row);
  const again = !asks("nudge");
  if (nudged.length) actions.push(action("nudge", again ? `Re-request review from ${mentions(nudged)} on ${target}` : `Ask ${mentions(nudged)} again to review ${target}`,
    blocked, { reviewers: nudged, ...again ? { label: context.running === "nudge" ? "Re-requesting…" : `Re-request ${mentions(nudged)}` } : {} }));
  if (asks("confirm-handled")) actions.push(action("confirm-handled", `Read the approval's notes on ${target} and what came after, then confirm ` +
    "them handled or ask its thread; it merges nothing", blocked ?? (row.head === null || row.feedbackFingerprint === null ? UNCONFIRMABLE : null)));
  // Your confirmation can always be taken back, at any age, while its effort or the PR is held too: it only makes the PR need you again.
  if (row.confirmation) actions.push(action("revoke", `Take back your confirmation of ${target}'s review notes; it needs you again before it merges`,
    context.running !== null ? "Another action on this PR is running" : null));
  if (mergeable(row)) actions.push(action("merge", `Open a fresh merge preview of ${target}; only a click or ⌘↵ there merges`, null));
  else if (inOrder(row, parents)) actions.push(action("merge", `Merges after #${row.stackedOn}`, `Merge #${row.stackedOn} first; this one follows it`));
  // pr_refresh_many reads your PRs and checked-out ones; a teammate's PR with neither goes unread.
  const unread = !row.authored && row.stage === null ? "The board reads a teammate's PR only from its checkout" : null;
  actions.push(action("refresh", `Read ${target} from GitHub now`, unread ?? (context.running === "refresh" ? "Reading GitHub now" : null)));
  actions.push(action("thread", thread ? `Open "${thread.title}"` : `Open ${target}'s thread`, thread ? null : "No thread is linked to this PR yet",
    { threadId: thread?.id ?? null }));
  const reads = (item: LineAction) => item.id === "refresh" || item.id === "thread" || item.id === "revoke";
  if (context.effortPile === "held") return actions.filter(reads);
  const stopped = context.effortPile && EFFORT_STOPPED[context.effortPile];
  return stopped ? actions.map((item) => reads(item) ? item : { ...item, enabled: false, why: stopped }) : actions;
}

/** The PR's reviewers: those asked now, then those who reviewed and aren't asked again, with their latest review. */
export function reviewerChips(row: Pick<InventoryRow, "reviewers">): ReviewerChip[] {
  const asked = new Set(row.reviewers.requested.map((login) => login.toLowerCase()));
  return [...row.reviewers.requested.map((login): ReviewerChip => ({ login, state: "requested" })),
    ...row.reviewers.reviewed.filter((review) => !asked.has(review.login.toLowerCase()))
      .map((review): ReviewerChip => ({ login: review.login, state: REVIEW_STATE[review.state] ?? "reviewed" }))];
}

/** When GitHub last answered for the row, or when it last didn't, and whether the last full read still listed it. */
function checked(row: InventoryRow, now: number): InventoryLine["checked"] {
  const since = (iso: string) => `${age(Date.parse(iso), now)} ago`;
  const good = row.checkedAt ? `last good read ${since(row.checkedAt)}` : "no good read yet";
  const stale = row.stale ? "; the last full read didn't list it, so it may be out of date" : "";
  if (row.failure) return { text: `read failed ${since(row.failure.at)}`, failed: true, stale: row.stale,
    title: `GitHub didn't answer${row.failure.error ? `: ${row.failure.error}` : ""}. ${good[0]!.toUpperCase()}${good.slice(1)}${stale}.` };
  if (row.checkedAt) return { text: `checked ${since(row.checkedAt)}`, failed: false, stale: row.stale, title: `Read from GitHub ${since(row.checkedAt)}${stale}` };
  return { text: "not checked yet", failed: false, stale: row.stale, title: `GitHub hasn't been read for this PR${stale}` };
}

/**
 * This visit's outcomes after a click: what it got back, or, when a read succeeds, no earlier failed read, which would otherwise show
 * beside the row's new age. A good read leaves a refused write's reason, which the read doesn't answer.
 */
export function withOutcome(outcomes: ReadonlyMap<string, Outcome>, prUrl: string, outcome: Outcome | null): ReadonlyMap<string, Outcome> {
  const next = new Map(outcomes);
  if (outcome) next.set(prUrl, outcome);
  else if (outcomes.get(prUrl)?.action === "refresh") next.delete(prUrl);
  return next;
}

/** A refresh's result on its row: Read just now for a minute after a good read, then nothing; a failed read says why until a good one. */
export function readNote(outcome: Pick<Outcome, "at" | "ok" | "text">, now: number): { text: string; ok: boolean } | null {
  if (outcome.ok) return now - outcome.at < 60_000 ? { text: "Read just now", ok: true } : null;
  return { text: `Refresh failed ${age(outcome.at, now)} ago: ${outcome.text}`, ok: false };
}

/** The newer of the server's record of the last action and this visit's own click. */
function lastOf(row: InventoryRow, outcome: Outcome | undefined, now: number): InventoryLine["last"] {
  const server = row.lastAction && { at: row.lastAction.at, action: row.lastAction.action, ok: row.lastAction.ok, text: row.lastAction.detail };
  const last = outcome && (!server || outcome.at >= server.at) ? outcome : server;
  if (!last) return null;
  if (last.action === "refresh") return readNote(last, now);
  const when = `${age(last.at, now)} ago`;
  const word = last.action === "ask-thread" || last.action === "ask-fix" || last.action === "revoke-confirmation" ? RECORDED[last.action] : WORD[last.action];
  return { ok: last.ok, text: last.ok ? `${last.text} · ${when}` : `${word} refused ${when}: ${last.text}` };
}

export function inventoryLine(row: InventoryRow, parents: ReadonlyMap<string, InventoryRow>, context: { now: number; limitedUntil: number | null;
  running?: ActionId; outcome?: Outcome; effortPile?: InventoryLine["effortPile"] }): InventoryLine {
  const { now } = context;
  const effortPile = context.effortPile ?? null;
  // A held effort's PR asks nothing of you until you resume the effort, as a held PR asks nothing until you release it.
  const { steps, primary } = effortPile === "held" ? { steps: [], primary: null } : nextSteps(row, parents, now);
  const working = row.threads.executor;
  const started = row.threads.origin && row.threads.origin.id !== working?.id ? row.threads.origin : null;
  const threads = [...working ? [{ ...working, role: "working" as const }] : [], ...started ? [{ ...started, role: "started" as const }] : []];
  const yourTurn = row.yourTurn && { why: row.yourTurn.why, age: row.yourTurn.since === null ? null : age(row.yourTurn.since, now) };
  const addressing = row.addressing && { threadId: row.addressing.threadId };
  const sent = row.sent ?? null;
  const turn = rowTurn(row, effortPile ?? "active");
  return {
    prUrl: row.prUrl, repo: row.repo.split("/").at(-1) ?? row.repo, slug: row.repo, number: row.number, title: row.title, draft: row.draft === true,
    authored: row.authored, reviewers: reviewerChips(row), suggested: row.suggestedReviewers,
    status: statusOf(row),
    hold: row.hold && { reason: row.hold.reason || null, age: age(row.hold.heldAt, now) }, effortPile,
    steps, primary,
    // Feedback waits on you on a Your turn row, dismissed or not, and a Nudge there would leave it waiting.
    actions: rowActions(row, parents, { now, limitedUntil: context.limitedUntil, running: context.running ?? null, effortPile,
      turn: turn.list === "turn" || turn.list === "dismissed" }),
    threads,
    checked: checked(row, now),
    last: lastOf(row, context.outcome, now),
    yourTurn, turn, addressing, sent,
    depth: 0, branch: null,
  };
}

/** Where a row lists and whether Address takes it, from its facts on its effort's pile: All PRs and the deck both read it so. */
export const rowTurn = (row: InventoryRow, pile: TurnFacts["pile"]): Turn => turnOf({ owes: row.yourTurn !== null, hold: row.hold !== null, pile,
  dismissed: row.dismissed, executor: row.threads.executor, batchThread: row.sent?.threadId ?? null, sent: row.sent });
/** On Your turn. A PR an Address batch sent stays, with its state, until GitHub shows its feedback cleared. */
export const onYourTurn = (line: Pick<InventoryLine, "turn">): boolean => line.turn.list === "turn";
/** A Your turn row Address can take now: nothing it sent is still under way, and its effort is active. */
export const sendable = (line: Pick<InventoryLine, "turn">): boolean => line.turn.addressable === true;

/** The effort the classifier picks for a PR no effort owns, as its row offers it, and why, in one line. */
export type RowSuggestion = { effortId: string; name: string; reason: string };
/**
 * Each PR's suggestion, by PR: an effort the classifier picks at medium confidence or better, unless you dismissed that effort for the PR.
 * A weak or tied pick, a new effort, and One-offs show nothing. The reason is the PR's own signals, else its group's.
 */
export function rowSuggestions(groups: readonly SuggestionGroup[], dismissed: Readonly<Record<string, string>>): Map<string, RowSuggestion> {
  return new Map(groups.flatMap((group) => {
    const target = group.target;
    if (target?.kind !== "effort" || (group.confidence !== "medium" && group.confidence !== "high")) return [];
    return group.prs.flatMap((pr) => dismissed[pr.prUrl] === target.effortId ? [] : [[pr.prUrl, { effortId: target.effortId, name: target.name,
      reason: pr.signals.filter((signal) => signal.effortId === target.effortId).map((signal) => signal.text).join(" · ") || group.reason }] as const]);
  }));
}
/** What accepting these rows' suggestions assigns: one call per effort, in the order the rows show, with only the rows that have one. */
export function acceptCalls(lines: readonly Pick<InventoryLine, "prUrl">[], suggestions: ReadonlyMap<string, RowSuggestion>): { effortId: string; prUrls: string[] }[] {
  const calls = new Map<string, string[]>();
  for (const line of lines) {
    const suggestion = suggestions.get(line.prUrl);
    if (suggestion) calls.set(suggestion.effortId, [...calls.get(suggestion.effortId) ?? [], line.prUrl]);
  }
  return [...calls].map(([effortId, prUrls]) => ({ effortId, prUrls }));
}

/**
 * The selection after a click on one of `order`'s rows: Shift adds every row from the last one you clicked through this one, in the order
 * drawn; otherwise the click toggles this row. Rows no longer in `order` drop out.
 */
export function pickRows(order: readonly string[], picked: ReadonlySet<string>, prUrl: string, shift: boolean, anchor: string | null): Set<string> {
  const next = new Set(order.filter((item) => picked.has(item)));
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (shift && from >= 0) {
    const [a, b] = [from, order.indexOf(prUrl)].sort((x, y) => x - y);
    for (const item of order.slice(a, b + 1)) next.add(item);
  } else if (next.has(prUrl)) next.delete(prUrl);
  else next.add(prUrl);
  return next;
}

/** Your turn's rows, which the badge counts and the list shows. */
export const yourTurnRows = (view: InventoryView, now: number): InventoryLine[] =>
  inventoryScreen(view, { now, filter: null }).groups.flatMap((group) => group.lines.filter(onYourTurn));

/** Rows in the server's order, each stack parent followed by the rows stacked on it in the same group, at any depth. */
function stacked(rows: readonly InventoryRow[], make: (row: InventoryRow) => InventoryLine): InventoryLine[] {
  const here = new Set(rows.map(keyOf));
  const children = new Map<string, InventoryRow[]>();
  const roots: InventoryRow[] = [];
  for (const row of rows) {
    const parent = row.stackedOn === null ? null : `${row.repo.toLowerCase()}#${row.stackedOn}`;
    if (parent !== null && parent !== keyOf(row) && here.has(parent)) children.set(parent, [...children.get(parent) ?? [], row]);
    else roots.push(row);
  }
  const lines: InventoryLine[] = [];
  const placed = new Set<string>();
  const visit = (row: InventoryRow, depth: number, branch: InventoryLine["branch"]) => {
    if (placed.has(keyOf(row))) return;
    placed.add(keyOf(row));
    lines.push({ ...make(row), depth, branch });
    const kids = [...children.get(keyOf(row)) ?? []].sort((a, b) => a.number - b.number);
    kids.forEach((kid, index) => visit(kid, depth + 1, index === kids.length - 1 ? "└" : "├"));
  };
  for (const row of roots) visit(row, 0, null);
  // A stack that loops back on itself has no root; its rows still show.
  for (const row of rows) visit(row, 0, null);
  return lines;
}

/** The whole screen for one inventory read: counts that filter, when GitHub was last read, notices, and rows by effort, "No effort" last. */
export function inventoryScreen(view: InventoryView, options: { now: number; filter: InventoryQuestion | null; pending?: Pending;
  outcomes?: ReadonlyMap<string, Outcome> }): InventoryScreen {
  const { now, filter } = options;
  const limitedUntil = view.rateLimitedUntil !== null && view.rateLimitedUntil > now ? view.rateLimitedUntil : null;
  const all = view.groups.flatMap((group) => group.rows);
  const parents = new Map(all.map((row) => [keyOf(row), row]));
  const make = (effortPile: InventoryLine["effortPile"]) => (row: InventoryRow) => inventoryLine(row, parents, { now, limitedUntil,
    running: options.pending?.get(row.prUrl), outcome: options.outcomes?.get(row.prUrl), effortPile });
  const groups = view.groups.flatMap((group): InventoryGroup[] => {
    const rows = filter ? group.rows.filter((row) => row.attention.some((reason) => reason.question === filter)) : group.rows;
    const pile = group.effort?.pile && group.effort.pile !== "active" ? group.effort.pile : null;
    return rows.length ? [{ key: group.effort?.id ?? "", effort: group.effort, label: group.effort?.name ?? "No effort", lines: stacked(rows, make(pile)) }] : [];
  });
  const notices: InventoryScreen["notices"] = [];
  if (limitedUntil !== null) notices.push({ tone: "error", text: `GitHub's rate limit holds reads until ${clock(limitedUntil, now)}. Rows show the last good read.` });
  if (view.attemptedAt !== null && view.attemptedAt !== view.checkedAt && !view.refreshing) {
    notices.push({ tone: "error", text: `The last GitHub read, ${age(Date.parse(view.attemptedAt), now)} ago, didn't finish. ` +
      (view.checkedAt ? `Rows show the read from ${age(Date.parse(view.checkedAt), now)} ago.` : "No read has finished yet.") });
  }
  notices.push(...view.warnings.map((text) => ({ tone: "info" as const, text })));
  return {
    counts: QUESTIONS.map(({ key, label }) => ({ key, label, count: view.counts[key], active: filter === key })),
    read: { refreshing: view.refreshing, text: `Last read ${view.checkedAt ? `${age(Date.parse(view.checkedAt), now)} ago` : "never"}${view.refreshing ? " · reading now" : ""}`,
      title: view.checkedAt ? `The last complete read of your open PRs finished ${new Date(view.checkedAt).toLocaleString()}` : "No complete read of your open PRs yet" },
    notices, groups,
    empty: groups.length ? null : filter ? QUESTIONS.find((question) => question.key === filter)!.none
      : view.checkedAt ? "No open PRs you author or an effort names." : "GitHub hasn't been read yet; the first read lists your open PRs.",
  };
}

/** Logins typed into the picker: split on spaces and commas, with any leading @ dropped, and those GitHub can't take named. */
export function parseLogins(text: string): { logins: string[]; invalid: string[] } {
  const words = text.split(/[\s,]+/u).map((word) => word.replace(/^@/u, "")).filter(Boolean);
  return { logins: [...new Set(words.filter((word) => LOGIN.test(word)))], invalid: words.filter((word) => !LOGIN.test(word)) };
}

/** What one click on a row's action does: an inventory RPC with the facts the row showed, the fresh merge preview, a read, or a thread. */
export type ActionCall =
  | { kind: "rpc"; method: "inventory_mark_ready"; input: { prUrl: string; headOid: string } }
  | { kind: "rpc"; method: "inventory_request_review"; input: { prUrl: string; logins: string[]; shown: InventoryRow["reviewers"] } }
  | { kind: "rpc"; method: "inventory_nudge"; input: { prUrl: string; reviewers: string[] } }
  | { kind: "rpc"; method: "inventory_confirm_revoke"; input: { prUrl: string } }
  /** Review notes open their confirm, which reads them and what came after from GitHub first. */
  | { kind: "notes"; prUrl: string }
  | { kind: "preview"; target: string }
  | { kind: "refresh"; prUrl: string }
  | { kind: "thread"; threadId: string }
  | { kind: "refuse"; why: string };

/** The call a click makes. Merge only opens the fresh preview: nothing here carries a head to merge, so no click on a row can merge. */
export function actionCall(row: InventoryRow, action: LineAction, logins: readonly string[] = []): ActionCall {
  if (!action.enabled) return { kind: "refuse", why: action.why ?? "Not available now" };
  if (action.id === "mark-ready") return row.head ? { kind: "rpc", method: "inventory_mark_ready", input: { prUrl: row.prUrl, headOid: row.head } }
    : { kind: "refuse", why: "No head commit read yet; Refresh first" };
  if (action.id === "request-review") return logins.length ? { kind: "rpc", method: "inventory_request_review",
    input: { prUrl: row.prUrl, logins: [...logins], shown: row.reviewers } } : { kind: "refuse", why: "Pick or type a reviewer first" };
  if (action.id === "nudge") return { kind: "rpc", method: "inventory_nudge", input: { prUrl: row.prUrl, reviewers: action.reviewers } };
  if (action.id === "confirm-handled") return row.head && row.feedbackFingerprint ? { kind: "notes", prUrl: row.prUrl } : { kind: "refuse", why: UNCONFIRMABLE };
  if (action.id === "revoke") return { kind: "rpc", method: "inventory_confirm_revoke", input: { prUrl: row.prUrl } };
  if (action.id === "merge") return { kind: "preview", target: row.prUrl };
  if (action.id === "refresh") return { kind: "refresh", prUrl: row.prUrl };
  return action.threadId ? { kind: "thread", threadId: action.threadId } : { kind: "refuse", why: "No thread is linked to this PR yet" };
}
