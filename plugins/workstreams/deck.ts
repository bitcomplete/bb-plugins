// The effort deck's read model (plan amendments A15 and A17.1): the active pile
// of effort cards, the On hold and Done piles, a service card per repository
// for its open PRs and threads that no effort has, and Loose threads, so
// nothing open is outside a card. Pure: the server gathers the inventory's
// rows, each thread's evidence, and what the board keeps about each effort.
// This places every row in one section by the move it needs, words it as the
// inventory does, counts Needs you with deck-shared.ts's one rule, places each
// thread with deck-homes.ts's, and sums each card from its rows, merges,
// Linear details, and threads. Service cards and Loose threads live only
// here: nothing stores them.
import { z } from "zod";
import type { Pr } from "./contract.js";
import { ACTED_KINDS, ACTED_MS, DECK_SECTIONS, LOOSE_ID, needsYou, serviceGoal, serviceId, serviceName, type DeckPile, type DeckSection, type RowActed }
  from "./deck-shared.js";
import { threadHome, type ThreadEvidence } from "./deck-homes.js";
import { suggestionGroupSchema, type SuggestionGroup } from "./effort-classify.js";
import { EFFORT_PILES, type EffortPileState } from "./effort-piles.js";
import { effortNotesSchema, NO_NOTES, type EffortNotes } from "./effort-notes.js";
import type { InventoryRow } from "./inventory-view.js";
import { userConfirmationSchema } from "./approval-evidence.js";
import { inventoryLine, rowTurn, type ActionId } from "./inventory-view-model.js";
import { LINEAR_MERGED_MS, readSettled, type LinearDetail } from "./linear.js";
import { sentSchema, turnSchema, yourTurnSchema, type Turn } from "./your-turn.js";

/** Merged this week, and how far back recent activity reaches. */
const WEEK_MS = 7 * 86_400_000;

const waitSchema = z.object({
  kind: z.enum(["parent", "hold"]),
  /** Who or what it waits on: the PR it's stacked on, or you, for a hold. */
  on: z.string(),
  /** What, in a few words: the parent merging first, or the hold's reason. */
  what: z.string(),
  since: z.number().nullable(),
}).strict();
export const deckRowSchema = z.object({
  prUrl: z.string(), repo: z.string(), number: z.number(), title: z.string(), draft: z.boolean().nullable(),
  section: z.enum(DECK_SECTIONS),
  /** The inventory's state word. */
  status: z.string(),
  /** The next step, who takes it (you, reviewers, or #N), and since when, as the inventory row states it. */
  step: z.object({ text: z.string(), owner: z.string(), since: z.number().nullable() }).strict().nullable(),
  waitsOn: waitSchema.nullable(),
  reviewers: z.array(z.object({ login: z.string(), state: z.string() }).strict()),
  /** Whom Request review asks first, and whom Nudge asks again. */
  suggested: z.array(z.string()), nudge: z.array(z.string()),
  /** Approval comments waiting for your confirmation. */
  notes: z.number(),
  /** Where All PRs lists it, Your turn among them, and whether Address takes it (turnOf); and the feedback that waits on you, when some does. */
  turn: turnSchema, yourTurn: yourTurnSchema.nullable(),
  tickets: z.array(z.string()),
  stackedOn: z.number().nullable(),
  thread: z.object({ id: z.string(), title: z.string(), active: z.boolean() }).strict().nullable(),
  /** The batch thread whose claim holds it while it addresses the feedback; its id is null while it starts. */
  addressing: z.object({ threadId: z.string().nullable(), title: z.string().nullable() }).strict().nullable(),
  /** Where the last Address batch sent it, and how that stands, with the thread's link however it ended. */
  sent: sentSchema.nullable(),
  hold: z.object({ reason: z.string(), since: z.number() }).strict().nullable(),
  /** When GitHub last answered for it; `failed` when its last read didn't, and `stale` when the last full read didn't list it or couldn't read it. */
  checkedAt: z.string().nullable(), failed: z.boolean(), stale: z.boolean(),
  /** Your confirmation of its review notes, at any age, which Revoke takes back; `current` while it covers this head and these notes. */
  confirmation: userConfirmationSchema.nullable(),
  acted: z.object({ kind: z.enum(ACTED_KINDS), state: z.enum(["queued", "sending", "sent", "refused", "unknown"]), at: z.number(), batchId: z.string().nullable() })
    .strict().nullable(),
}).strict();
export type DeckRow = z.infer<typeof deckRowSchema>;

const nextSchema = z.object({ text: z.string(), owner: z.string().nullable(), prUrl: z.string().nullable() }).strict();
const tally = z.array(z.object({ name: z.string(), count: z.number() }).strict());
const personSchema = z.object({ login: z.string(), prs: z.array(z.object({ prUrl: z.string(), ref: z.string(), since: z.number().nullable() }).strict()) }).strict();
export const deckCardSchema = z.object({
  id: z.string(), key: z.string(), name: z.string(), goal: z.string(),
  /**
   * A stored effort's card, or one only this read model draws: a repository's service card, named by `repo`, or Loose threads, for the
   * threads no effort, PR, or repository places.
   */
  kind: z.enum(["effort", "service", "loose"]), repo: z.string().nullable(),
  /** The one effort for standalone PRs. */
  oneOff: z.boolean(),
  pile: z.enum(EFFORT_PILES), reason: z.string(), since: z.number(),
  status: z.object({ tone: z.enum(["you", "waiting", "moving", "quiet", "held"]), text: z.string() }).strict(),
  needsYou: z.number(),
  /** Your turn: its open PRs where a person's feedback waits on you, as All PRs lists them; a held PR isn't. The strip chip counts it. */
  yourTurn: z.number(),
  /** `mergedFortnight`: merged in the last 14 days, which paces the finish line's ETA. */
  stats: z.object({ open: z.number(), ready: z.number(), mergedWeek: z.number(), mergedFortnight: z.number(), medianAgeMs: z.number().nullable(),
    oldestWait: z.object({ prUrl: z.string(), ref: z.string(), text: z.string(), since: z.number() }).strict().nullable() }).strict(),
  /** Merged PRs a read saw against open ones. */
  progress: z.object({ merged: z.number(), open: z.number() }).strict(),
  /** Up to three: the oldest moves of yours, then the oldest waits. A held row is none of these until you release it. */
  next: z.array(nextSchema),
  /** Every row waiting on someone or something else, oldest first; a held row waits on you, under Held. */
  blocked: z.array(waitSchema.extend({ prUrl: z.string(), ref: z.string() }).strict()),
  /** What the stored Linear details say about its tickets; `known` 0 means no Linear data. Each tally counts tickets, most first. */
  linear: z.object({ tickets: z.number(), known: z.number(),
    /** With the project's target date, when Linear has one. */
    projects: z.array(z.object({ name: z.string(), count: z.number(), targetDate: z.string().nullable() }).strict()),
    initiatives: tally, parents: tally,
    states: z.array(z.object({ name: z.string(), type: z.string().nullable(), count: z.number() }).strict()), labels: tally,
    cycles: z.array(z.object({ number: z.number(), name: z.string().nullable(), endsAt: z.string().nullable(), count: z.number() }).strict()),
    assignees: tally,
    /** Each ticket read, for the rows' ticket chips and the p expand: its state type, Linear's priority (0 none, 1 Urgent to 4 Low) and word, and points. */
    issues: z.array(z.object({ id: z.string(), type: z.string().nullable(), priority: z.number().nullable(), label: z.string().nullable(),
      estimate: z.number().nullable() }).strict()),
    /**
     * Where Linear and GitHub disagree (Reconcile): tickets Linear completed while PRs here are open, and those PRs; open tickets every PR of
     * which merged in the last 14 days, with their Linear pages.
     */
    reconcile: z.object({ done: z.array(z.string()), prUrls: z.array(z.string()),
      merged: z.array(z.object({ id: z.string(), url: z.string().nullable() }).strict()) }).strict() }).strict(),
  /** Reviewers you wait on, and reviewers whose requested changes wait on you. */
  people: z.object({ youWaitOn: z.array(personSchema), waitOnYou: z.array(personSchema) }).strict(),
  /**
   * Its parent thread, then the threads on its open PRs, then the rest of the threads it holds, each most recent first. Read-only. A `linked`
   * thread is here by its own evidence (deck-homes.ts), with the open PR on this card it links, if any.
   */
  threads: z.array(z.object({ id: z.string(), title: z.string(), role: z.enum(["parent", "pr", "linked"]), prUrl: z.string().nullable(), status: z.string(),
    lastActivityAt: z.number().nullable(), waiting: z.boolean().optional() }).strict()),
  /** Merges, reviews, and pushes in the last 7 days, newest first. */
  activity: z.array(z.object({ kind: z.enum(["merged", "approved", "changes", "pushed"]), prUrl: z.string(), ref: z.string(), who: z.string().nullable(),
    at: z.number() }).strict()),
  sections: z.array(z.object({ key: z.enum(DECK_SECTIONS), needsYou: z.number(), rows: z.array(deckRowSchema) }).strict()),
  /** On a service card, the classifier's suggestions for its PRs, each group cut to the PRs on this card; empty on an effort's. */
  suggestions: z.array(suggestionGroupSchema),
  /** A stored effort's Markdown notes, at revision 0 before the first save; null on a card no effort backs, which has nowhere to keep them. */
  notes: effortNotesSchema.nullable(),
}).strict();
export type DeckCard = z.infer<typeof deckCardSchema>;
export const deckViewSchema = z.object({
  /** Active efforts, most Needs you first and One-offs after them, then the service cards, most Needs you first, then Loose threads. */
  active: z.array(deckCardSchema),
  /** Held efforts, in the order they were held. */
  held: z.array(deckCardSchema),
  /** Done efforts, newest first, and archived efforts that still own open PRs. */
  done: z.array(z.object({ id: z.string(), key: z.string(), name: z.string(), archived: z.boolean(), since: z.number(), merged: z.number(), open: z.number() })
    .strict()),
  /** One-offs, once the first one-off made it. */
  oneOffsId: z.string().nullable(),
  counts: z.object({ needsYou: z.number(), held: z.number(), done: z.number() }).strict(),
  checkedAt: z.string().nullable(), refreshing: z.boolean(),
  /** GitHub's rate limit holds reads until then. */
  limitedUntil: z.number().nullable(),
  /**
   * Of the PRs the view asked about (its rows, as it last saw them), each that a read found merged, with when, or closed: so a row that
   * left says which instead of vanishing.
   */
  gone: z.array(z.object({ prUrl: z.string(), how: z.enum(["merged", "closed"]), at: z.number().nullable() }).strict()),
}).strict();
export type DeckView = z.infer<typeof deckViewSchema>;
/** When you last marked each PR's row seen, by PR URL, as the view keeps it. */
export const deckSeenSchema = z.record(z.string().max(500), z.number()).refine((seen) => Object.keys(seen).length <= 1_000, "Too many PRs.");

/** One inventory row with the facts the deck adds. */
export type DeckRowInput = InventoryRow & {
  effort: { id: string; name: string } | null;
  /** What GitHub last said of it, for the dates its waits start; null for a teammate's PR the board doesn't read. */
  pr: Pick<Pr, "createdAt" | "headCommittedAt" | "reviewRequestedAt" | "approvalFeedback"> | null;
  tickets: readonly string[];
  acted: RowActed | null;
};
export type DeckEffortInput = {
  id: string; key: string; name: string; goal: string; oneOff: boolean; pile: EffortPileState;
  /** Archived: it keeps its PRs, which pause on the Done pile until you restore it. */
  archived: boolean;
  parentThreadId: string | null;
  /** Tickets it owns by name. */
  tickets: readonly string[];
  /** Its notes; none yet when left out. */
  notes?: EffortNotes;
};
export type DeckInput = {
  now: number;
  efforts: readonly DeckEffortInput[];
  rows: readonly DeckRowInput[];
  /** Merges a read saw, with the effort that owns each and the tickets its title and branch name. */
  merges: readonly { url: string; at: number; effortId: string; tickets?: readonly string[] }[];
  linear: ReadonlyMap<string, LinearDetail>;
  /** When each ticket in `linear` was read: a state read before Linear could move it after a merge says nothing of that merge (readSettled). */
  linearReadAt: ReadonlyMap<string, number>;
  threads: ReadonlyMap<string, { title: string; status: string; updatedAt: number; waiting?: boolean }>;
  /** Every visible thread, with the evidence that places it on one card. */
  homes: readonly ThreadEvidence[];
  /** The classifier's suggestions for the open PRs no effort owns, and One-offs. */
  classify: { groups: SuggestionGroup[]; oneOffsId: string | null };
  read: { checkedAt: string | null; refreshing: boolean; limitedUntil: number | null };
  /** When you last marked each PR's row seen; see counted(). */
  seen: ReadonlyMap<string, number>;
  /** What a read found of the PRs the view asked about that are no longer open. */
  gone?: DeckView["gone"];
};

/** The inventory action a row leads with, as the section it files under. */
const MOVES: Partial<Record<ActionId, DeckSection>> = { merge: "merge", "confirm-handled": "confirm", nudge: "nudge", "request-review": "request",
  "mark-ready": "ready", thread: "work" };
const time = (value: string | null | undefined): number | null => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
};
const short = (repo: string) => repo.split("/").at(-1) ?? repo;
const refOf = (row: Pick<InventoryRow, "repo" | "number">) => `${short(row.repo)} #${row.number}`;
const urlRef = (url: string) => { const match = /\/([^/]+)\/pull\/(\d+)\/?$/u.exec(url); return match ? `${match[1]} #${match[2]}` : url; };
const oldest = (a: number | null, b: number | null) => (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY);

/**
 * The section a row files under, and what it waits on when that isn't you. A hold outranks everything, as it does every write, and files
 * the row under Held alone. Only a parent blocks: a review not yet due a nudge, running checks, code work a thread is
 * doing, feedback a thread is at work on or you dismissed (turnOf, whatever the row leads with), and feedback a batch thread's claim holds
 * are in flight.
 */
function place(row: DeckRowInput, turn: Turn, primary: ActionId | null, owner: string | null): { section: DeckSection; waitsOn: DeckRow["waitsOn"] } {
  const blocked = (waitsOn: NonNullable<DeckRow["waitsOn"]>) => ({ section: "blocked" as const, waitsOn });
  if (row.hold) return { section: "held", waitsOn: { kind: "hold", on: "you", what: row.hold.reason ? `On hold: ${row.hold.reason}` : "On hold", since: row.hold.heldAt } };
  if (row.addressing || turn.list === "in-flight" || turn.list === "dismissed") return { section: "flight", waitsOn: null };
  const move = primary && MOVES[primary];
  if (move && !(move === "work" && row.threads.executor?.active)) return { section: move, waitsOn: null };
  if (owner === "parent" && row.stackedOn !== null) {
    const parent = `${short(row.repo)} #${row.stackedOn}`;
    return blocked({ kind: "parent", on: parent, what: `Merges after ${parent}`, since: time(row.pr?.headCommittedAt) });
  }
  return { section: "flight", waitsOn: null };
}

/** One row as the deck draws it on a card on `pile`, worded by the inventory's own view model. */
export function deckRow(row: DeckRowInput, parents: ReadonlyMap<string, InventoryRow>, now: number, pile: DeckPile): DeckRow {
  const line = inventoryLine(row, parents, { now, limitedUntil: null });
  const first = line.steps[0];
  const turn = rowTurn(row, pile);
  const { section, waitsOn } = place(row, turn, line.primary, first?.owner.kind ?? null);
  const thread = row.threads.executor ?? row.threads.origin;
  const feedback = row.pr?.approvalFeedback;
  return {
    prUrl: row.prUrl, repo: row.repo, number: row.number, title: row.title, draft: row.draft, section, status: line.status,
    step: first ? { text: first.text, owner: first.owner.label, since: first.since } : null,
    waitsOn, reviewers: line.reviewers, suggested: line.suggested, nudge: line.actions.find((action) => action.id === "nudge")?.reviewers ?? [],
    notes: feedback?.status === "present" ? feedback.sourceIds.length : 0, turn, yourTurn: row.yourTurn, tickets: [...row.tickets], stackedOn: row.stackedOn,
    thread: thread && { id: thread.id, title: thread.title, active: thread.active }, addressing: row.addressing, sent: row.sent,
    hold: row.hold && { reason: row.hold.reason, since: row.hold.heldAt },
    checkedAt: row.checkedAt, failed: row.failure !== null, stale: row.stale, confirmation: row.confirmation, acted: row.acted && now - row.acted.at < ACTED_MS ? row.acted : null,
  };
}

type Placed = { row: DeckRow; input: DeckRowInput };
const tallies = (values: readonly string[]) => [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())]
  .map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

function people(rows: readonly Placed[]): DeckCard["people"] {
  const add = (map: Map<string, DeckCard["people"]["youWaitOn"][number]["prs"]>, login: string, row: DeckRow, since: number | null) =>
    map.set(login, [...map.get(login) ?? [], { prUrl: row.prUrl, ref: refOf(row), since }]);
  const youWaitOn = new Map<string, DeckCard["people"]["youWaitOn"][number]["prs"]>(), waitOnYou = new Map<string, DeckCard["people"]["youWaitOn"][number]["prs"]>();
  for (const { row, input } of rows) {
    if (!input.authored || input.hold) continue;
    for (const login of input.reviewers.requested) add(youWaitOn, login, row, time(input.pr?.reviewRequestedAt?.find((wait) => wait.reviewer === login)?.at));
    // Changes a reviewer asked for wait on you until you answer them.
    if (row.section === "work") for (const review of input.reviewers.reviewed.filter((item) => item.state === "CHANGES_REQUESTED"))
      add(waitOnYou, review.login, row, time(review.submittedAt));
  }
  const first = (prs: readonly { since: number | null }[]) => Math.min(...prs.map((pr) => pr.since ?? Number.POSITIVE_INFINITY));
  // Longest wait first; NaN between two undated waits falls through to the next key.
  const sorted = (map: typeof youWaitOn) => [...map].map(([login, prs]) => ({ login, prs }))
    .sort((a, b) => first(a.prs) - first(b.prs) || b.prs.length - a.prs.length || a.login.localeCompare(b.login));
  return { youWaitOn: sorted(youWaitOn), waitOnYou: sorted(waitOnYou) };
}

function card(effort: DeckEffortInput, rows: readonly Placed[], input: DeckInput, homed: readonly ThreadEvidence[], kind: DeckCard["kind"] = "effort",
  repo: string | null = null): DeckCard {
  const { now } = input;
  const pile = effort.pile.pile;
  const all = rows.map(({ row }) => row);
  const inSection = (section: DeckSection) => all.filter((row) => row.section === section);
  const counts = (row: DeckRow) => needsYou(row, pile, input.seen.get(row.prUrl));
  const needs = all.filter(counts).length;
  const blocked = inSection("blocked").map((row) => ({ ...row.waitsOn!, prUrl: row.prUrl, ref: refOf(row) })).sort((a, b) => oldest(a.since, b.since));
  const flight = inSection("flight").length;
  const held = inSection("held").length;
  const merges = input.merges.filter((merge) => merge.effortId === effort.id);
  const ages = rows.flatMap(({ input: row }) => time(row.pr?.createdAt) ?? []).map((at) => now - at).sort((a, b) => a - b);
  // A row you hold is parked, not waiting: it stays out of the oldest wait and the next steps until you release it.
  const parked = (row: DeckRow) => row.section === "flight" || row.section === "held";
  const waits = all.filter((row) => !parked(row)).flatMap((row) => {
    const since = row.waitsOn?.since ?? row.step?.since ?? null;
    return since === null ? [] : [{ prUrl: row.prUrl, ref: refOf(row), text: row.waitsOn?.what ?? row.step!.text, since }];
  }).sort((a, b) => a.since - b.since);
  const next = all.filter((row) => !parked(row)).sort((a, b) => DECK_SECTIONS.indexOf(a.section) - DECK_SECTIONS.indexOf(b.section) ||
    oldest(a.waitsOn?.since ?? a.step?.since ?? null, b.waitsOn?.since ?? b.step?.since ?? null)).slice(0, 3)
    .map((row) => ({ text: row.waitsOn?.what ?? row.step?.text ?? row.status, owner: row.waitsOn?.on ?? row.step?.owner ?? null, prUrl: row.prUrl }));
  const tickets = [...new Set([...effort.tickets, ...rows.flatMap(({ input: row }) => row.tickets)])].sort();
  const details = tickets.flatMap((ticket) => input.linear.get(ticket) ?? []);
  // Linear and GitHub disagree: a ticket Linear completed while a PR here is open, and an open ticket no open PR names whose PRs merged in
  // the last 14 days, the merges the sync keeps fresh, as of a read made once Linear could move it after the newest merge naming it, in
  // any effort. A ticket Linear never read disagrees with nothing.
  const typeOf = (ticket: string) => input.linear.get(ticket)?.state?.type ?? null;
  const done = tickets.filter((ticket) => typeOf(ticket) === "completed" && rows.some(({ input: row }) => row.tickets.includes(ticket)));
  const named = new Set(input.rows.flatMap((row) => row.tickets));
  const newest = (ticket: string) => Math.max(...input.merges.filter((merge) => merge.tickets?.includes(ticket)).map((merge) => merge.at));
  const merged = [...new Set(merges.filter((merge) => now - merge.at <= LINEAR_MERGED_MS).flatMap((merge) => merge.tickets ?? []))].sort()
    .filter((ticket) => !named.has(ticket) && ![null, "completed", "canceled"].includes(typeOf(ticket)) && readSettled(input.linearReadAt.get(ticket), newest(ticket)));
  const threads = new Map<string, DeckCard["threads"][number]>();
  const parent = effort.parentThreadId ? input.threads.get(effort.parentThreadId) : undefined;
  if (parent) threads.set(effort.parentThreadId!, { id: effort.parentThreadId!, title: parent.title, role: "parent", prUrl: null, status: parent.status,
    lastActivityAt: parent.updatedAt, ...parent.waiting !== undefined ? { waiting: parent.waiting } : {} });
  for (const { input: row } of rows) for (const thread of [row.threads.executor, row.threads.origin]) if (thread && !threads.has(thread.id)) {
    const facts = input.threads.get(thread.id);
    threads.set(thread.id, { id: thread.id, title: thread.title, role: "pr", prUrl: row.prUrl, status: facts?.status ?? (thread.active ? "active" : "idle"),
      lastActivityAt: facts?.updatedAt ?? null, ...facts?.waiting !== undefined ? { waiting: facts.waiting } : {} });
  }
  for (const thread of homed) {
    const facts = input.threads.get(thread.id);
    if (!facts || threads.has(thread.id)) continue;
    const prUrl = thread.prs.find((pr) => rows.some(({ row }) => row.prUrl === pr.url))?.url ?? null;
    threads.set(thread.id, { id: thread.id, title: facts.title, role: "linked", prUrl, status: facts.status, lastActivityAt: facts.updatedAt,
      ...facts.waiting !== undefined ? { waiting: facts.waiting } : {} });
  }
  const recent = (at: number | null, span = WEEK_MS) => at !== null && now - at <= span;
  const activity: DeckCard["activity"] = [
    ...merges.filter((merge) => recent(merge.at)).map((merge) => ({ kind: "merged" as const, prUrl: merge.url, ref: urlRef(merge.url), who: null, at: merge.at })),
    ...rows.flatMap(({ input: row }) => [
      ...row.reviewers.reviewed.flatMap((review) => {
        const at = time(review.submittedAt);
        const kind = review.state === "APPROVED" ? "approved" as const : review.state === "CHANGES_REQUESTED" ? "changes" as const : null;
        return kind && recent(at) ? [{ kind, prUrl: row.prUrl, ref: refOf(row), who: review.login, at: at! }] : [];
      }),
      ...recent(time(row.pr?.headCommittedAt)) ? [{ kind: "pushed" as const, prUrl: row.prUrl, ref: refOf(row), who: null, at: time(row.pr?.headCommittedAt)! }] : []]),
  ].sort((a, b) => b.at - a.at).slice(0, 12);
  const parts = [needs && `${needs} need you`, blocked.length && `${blocked.length} blocked`, flight && `${flight} in flight`, held && `${held} held`]
    .filter(Boolean);
  return {
    id: effort.id, key: effort.key, name: effort.name, goal: effort.goal, kind, repo, oneOff: effort.oneOff, pile,
    reason: effort.pile.reason, since: effort.pile.since,
    status: pile === "held" ? { tone: "held", text: effort.pile.reason ? `On hold: ${effort.pile.reason}` : "On hold" }
      : { tone: needs ? "you" : blocked.length || held ? "waiting" : rows.length ? "moving" : "quiet", text: parts.join(" · ") || "No open PRs" },
    needsYou: needs, yourTurn: all.filter((row) => row.turn.list === "turn").length,
    stats: { open: rows.length, ready: inSection("merge").length, mergedWeek: merges.filter((merge) => recent(merge.at)).length,
      mergedFortnight: merges.filter((merge) => recent(merge.at, 2 * WEEK_MS)).length,
      medianAgeMs: ages.length ? ages[Math.floor(ages.length / 2)]! : null, oldestWait: waits[0] ?? null },
    progress: { merged: merges.length, open: rows.length },
    next, blocked,
    linear: { tickets: tickets.length, known: details.length,
      projects: tallies(details.flatMap((detail) => detail.project ? [detail.project.name] : [])).map((item) => ({ ...item,
        targetDate: details.find((detail) => detail.project?.name === item.name && detail.project.targetDate)?.project?.targetDate ?? null })),
      initiatives: tallies(details.flatMap((detail) => (detail.project?.initiatives ?? []).map((initiative) => initiative.name))),
      parents: tallies(details.flatMap((detail) => detail.parent?.identifier ? [`${detail.parent.identifier}${detail.parent.title ? ` ${detail.parent.title}` : ""}`] : [])),
      states: tallies(details.flatMap((detail) => detail.state ? [detail.state.name] : []))
        .map(({ name, count }) => ({ name, type: details.find((detail) => detail.state?.name === name)!.state!.type, count })),
      labels: tallies(details.flatMap((detail) => detail.labels)),
      cycles: tallies(details.flatMap((detail) => detail.cycle ? [String(detail.cycle.number)] : [])).map(({ name, count }) => {
        const cycle = details.find((detail) => String(detail.cycle?.number) === name)!.cycle!;
        return { number: cycle.number, name: cycle.name, endsAt: cycle.endsAt, count };
      }),
      assignees: tallies(details.flatMap((detail) => detail.assignee ? [detail.assignee] : [])),
      issues: tickets.flatMap((id) => { const detail = input.linear.get(id); return detail ? [{ id, type: detail.state?.type ?? null,
        priority: detail.priority ?? null, label: detail.priorityLabel ?? null, estimate: detail.estimate ?? null }] : []; }),
      reconcile: { done, prUrls: DECK_SECTIONS.flatMap(inSection).filter((row) => row.tickets.some((ticket) => done.includes(ticket))).map((row) => row.prUrl),
        merged: merged.map((ticket) => ({ id: ticket, url: input.linear.get(ticket)?.url ?? null })) } },
    people: people(rows),
    // Threads on open work come first; the rest, on merged work or none, wait behind More.
    threads: [...threads.values()].sort((a, b) => Number(b.role === "parent") - Number(a.role === "parent") || Number(b.prUrl !== null) - Number(a.prUrl !== null)
      || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)),
    activity,
    sections: DECK_SECTIONS.flatMap((key) => {
      const list = inSection(key);
      return list.length ? [{ key, needsYou: list.filter(counts).length, rows: list }] : [];
    }),
    suggestions: kind !== "service" ? [] : input.classify.groups.flatMap((group) => {
      const prs = group.prs.filter((pr) => all.some((row) => row.prUrl === pr.prUrl));
      return prs.length ? [{ ...group, prs }] : [];
    }),
    notes: kind === "effort" ? effort.notes ?? NO_NOTES : null,
  };
}

/** A card no stored effort backs, as the effort it stands in for: always active, and never held, completed, or given a goal to meet. */
const standIn = (id: string, name: string, goal: string): DeckEffortInput => ({ id, key: id, name, goal, oneOff: false, archived: false,
  pile: { effortId: id, pile: "active", reason: "", since: 0 }, parentThreadId: null, tickets: [] });
const serviceEffort = (repo: string) => standIn(serviceId(repo), serviceName(repo), serviceGoal(repo));

/** Every row as the deck draws it, with the facts it came from, its card, and its card's pile: a PR no effort owns is on its repository's service card. */
export function deckRows(input: Pick<DeckInput, "now" | "efforts" | "rows">): (Placed & { pile: DeckPile; cardId: string })[] {
  const parents = new Map(input.rows.map((row) => [`${row.repo.toLowerCase()}#${row.number}`, row]));
  const piles = new Map(input.efforts.map((effort) => [effort.id, effort.pile.pile]));
  return input.rows.flatMap((row) => {
    const pile = row.effort ? piles.get(row.effort.id) : "active";
    return pile ? [{ row: deckRow(row, parents, input.now, pile), input: row, pile, cardId: row.effort?.id ?? serviceId(row.repo) }] : [];
  });
}

/** The whole deck from one read. */
export function deckView(input: DeckInput): DeckView {
  const placed = deckRows(input);
  const of = (cardId: string) => placed.filter((item) => item.cardId === cardId);
  // Each thread on the one card its evidence names: an effort's, a repository's service card, or Loose threads.
  const homes = new Map<string, ThreadEvidence[]>();
  for (const thread of input.homes) {
    const home = threadHome(thread);
    const id = home.kind === "effort" ? home.id : home.kind === "service" ? serviceId(home.repo) : LOOSE_ID;
    homes.set(id, [...homes.get(id) ?? [], thread]);
  }
  const homed = (cardId: string) => homes.get(cardId) ?? [];
  const cards = input.efforts.filter((effort) => effort.pile.pile !== "done").map((effort) => card(effort, of(effort.id), input, homed(effort.id)));
  const repos = [...new Set([...placed.flatMap(({ input: row }) => row.effort ? [] : [row.repo.toLowerCase()]),
    ...input.homes.flatMap((thread) => { const home = threadHome(thread); return home.kind === "service" && input.threads.has(thread.id) ? [home.repo] : []; })])];
  const services = repos.map((repo) => card(serviceEffort(repo), of(serviceId(repo)), input, homed(serviceId(repo)), "service", repo))
    .sort((a, b) => b.yourTurn - a.yourTurn || b.stats.open - a.stats.open || a.name.localeCompare(b.name));
  const loose = homed(LOOSE_ID).filter((thread) => input.threads.has(thread.id));
  if (loose.length) services.push(card(standIn(LOOSE_ID, "Loose threads", "Threads with no effort or repository yet."), [], input, loose, "loose"));
  const active = [...cards.filter((item) => item.pile === "active")
    .sort((a, b) => Number(a.oneOff) - Number(b.oneOff) || b.yourTurn - a.yourTurn || a.since - b.since || a.name.localeCompare(b.name)), ...services];
  const held = cards.filter((item) => item.pile === "held").sort((a, b) => a.since - b.since || a.name.localeCompare(b.name));
  const done = input.efforts.filter((effort) => effort.pile.pile === "done" && (!effort.archived || of(effort.id).length))
    .map((effort) => ({ id: effort.id, key: effort.key, name: effort.name, archived: effort.archived, since: effort.pile.since,
      merged: input.merges.filter((merge) => merge.effortId === effort.id).length, open: of(effort.id).length }))
    .sort((a, b) => b.since - a.since || a.name.localeCompare(b.name));
  return { active, held, done, oneOffsId: input.classify.oneOffsId,
    counts: { needsYou: active.reduce((sum, item) => sum + item.needsYou, 0), held: held.length, done: done.length },
    checkedAt: input.read.checkedAt, refreshing: input.read.refreshing, limitedUntil: input.read.limitedUntil, gone: [...input.gone ?? []] };
}
