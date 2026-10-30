// The effort deck's view model (plan amendment A15, effort card v2): pure
// functions from deck_get's output, what each view last marked seen, and the
// view's own state to what the deck draws. The server placed each row in its
// section; this ranks a card's rows into its few moves (rankMoves), words its
// finish line, counts Your turn for its strip chip, and says which actions the
// keys, hint bar, ? sheet, and ⌘K offer right now. Moves and keys follow the
// read as All PRs does, but leave a row a write of yours holds, as
// deck_batch_plan does; Mark seen settles what changed since you looked
// (deck-place.ts) and the writes that landed. It imports types, zero-import
// modules, All PRs' time format, and approval-evidence.ts's wording (zod
// only), so no server module reaches the browser (A12.1).
import type { DeckCard, DeckRow, DeckView } from "./deck";
import { cardTier, counted, DECK_SECTIONS, LOOSE_ID, SERVICE_PREFIX, serviceGoal, serviceName, yours, type DeckPile, type DeckSection, type DeckWrite }
  from "./deck-shared";
import { settleRows, type SettledRow, type Shown } from "./deck-place";
import { PR_VIEW_ACTIONS, ACTION, DECK_ACTIONS, type DeckAction, type DeckActionId } from "./deck-keys";
import type { SuggestionGroup } from "./effort-classify";
import { age, clock } from "./inventory-view-model";
import { evidenceText, handled, linkedText, type ConfirmRead } from "./approval-evidence";
import { firstLine } from "./effort-notes";

const DAY = 86_400_000;
/** A Linear date or time as its calendar day, "Oct 17": a target or due date is a day, not a moment. */
const calendarDay = (value: string | number) => new Date(typeof value === "number" ? value : Date.parse(value))
  .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** Days from today to a Linear date or time's calendar day, in UTC as calendarDay words it: negative once it's past. */
const daysTo = (value: string | number, now: number) =>
  Math.floor((typeof value === "number" ? value : Date.parse(value.slice(0, 10))) / DAY) - Math.floor(now / DAY);
/** Color only where the move is yours; gray waits on others or runs itself. */
export type Tone = "green" | "violet" | "blue" | "amber" | "red" | "gray";
/** Each section's name, as a batch's confirm titles it. */
export const SECTIONS: Record<DeckSection, { title: string }> = {
  merge: { title: "Merge" }, confirm: { title: "Confirm review notes" }, nudge: { title: "Nudge reviewers" }, request: { title: "Request a reviewer" },
  ready: { title: "Mark ready" }, work: { title: "Work in threads" }, flight: { title: "In flight" }, blocked: { title: "Blocked" }, held: { title: "Held" },
};
/** The batch each act key plans. */
export const KIND_OF: Partial<Record<DeckActionId, DeckWrite>> = { nudge: "nudge", request: "request", ready: "ready", release: "release", fix: "fix" };
const SECTION_OF: Partial<Record<DeckActionId, DeckSection>> = { merge: "merge", confirm: "confirm", nudge: "nudge", request: "request", ready: "ready", release: "held",
  fix: "work" };
/** A held row Release can take: still held, and nothing you did to it waits or runs. */
const releasable = (line: Pick<DeckLine, "row" | "dim">) => !line.dim && !!line.row?.hold;
/** Muted effort colors, picked by the effort's id so a card keeps its color across reads and sessions. */
const EFFORT_COLORS = ["#5fb3b3", "#d3a35a", "#8c8fd9", "#d98ca8", "#9cb86a", "#6fa8d6", "#d9905f", "#b48ad6"];
export const ONE_OFF_COLOR = "#8f8e8a";
/** A service card's color, drawn as a hollow dot: it stands in for an effort no one made yet. */
export const SERVICE_COLOR = "#d3a35a";
export function effortColor(id: string, oneOff = false): string {
  if (oneOff || id === LOOSE_ID) return ONE_OFF_COLOR;
  if (cardTier(id) > 0) return SERVICE_COLOR;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return EFFORT_COLORS[hash % EFFORT_COLORS.length]!;
}

const short = (repo: string) => repo.split("/").at(-1) ?? repo;
export const refOf = (row: Pick<DeckRow, "repo" | "number">) => `${short(row.repo)} #${row.number}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "You 3 · @mira-l 1": each value with how many times it comes, most first, then in the order each first came. */
const tally = (values: readonly string[]) => [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())]
  .sort((a, b) => b[1] - a[1]).map(([value, n]) => `${value} ${n}`).join(" · ");

/** One row as the keys know it: a PR on the card now, or one that left since you marked the card seen, which only Mark seen counts. */
export type DeckLine = {
  prUrl: string; ref: string; title: string;
  /** Its section as the read has it; a row that left keeps the one you saw it in. */
  section: DeckSection;
  /** A move takes it now: an active card, a section whose move is yours, and no write of yours holding it (busy). */
  needs: boolean;
  /** It left, or a write of yours holds it: no key takes it. */
  dim: boolean; ghost: boolean;
  /** It changed, arrived, or left since you marked the card seen, which Mark seen settles. */
  dot: boolean;
  /** On a service card, where its suggestion points, and its own signals in a group. */
  signals: string[];
  row: DeckRow | null;
};

/**
 * A write of yours holds its row from its Undo window until you mark the row seen after it lands, as deck_batch_plan reads it (counted):
 * a thread's fix leaves GitHub as it was, so only your look says the read is past it. No move takes the row until then.
 */
const busy = (row: Pick<DeckRow, "acted">, seenAt: number | undefined) => !counted(row, seenAt);

/** One settled row as a line: the read's row in its section now, or one that left, which only counts toward what Mark seen settles. */
export function deckLine(item: Shown<DeckRow>, pile: DeckPile, seenAt: number | undefined, signals: string[] = []): DeckLine {
  const row = item.row;
  const dim = item.ghost || (row !== null && busy(row, seenAt));
  return {
    prUrl: item.prUrl, ref: row ? refOf(row) : item.settled!.ref, title: row?.title ?? item.settled!.title,
    section: row?.section ?? item.section as DeckSection, needs: !dim && row !== null && pile === "active" && yours(row.section), dim, ghost: item.ghost,
    dot: item.ghost || item.change !== null || item.arrived, signals, row,
  };
}

const settledOf = (row: DeckRow, section: string = row.section): SettledRow => ({ prUrl: row.prUrl, ref: refOf(row), title: row.title, section, status: row.status });
/** What Mark seen keeps for a card: its rows in their sections now. */
export const cardSnapshot = (card: DeckCard): SettledRow[] => card.sections.flatMap((section) => section.rows.map((row) => settledOf(row)));
const threadRow = (thread: DeckCard["threads"][number]) => ({ prUrl: thread.id, ref: thread.role, title: thread.title, section: "threads", status: thread.status });
/** What Mark seen keeps of a card's threads, whose order holds until then. */
export const threadSnapshot = (card: DeckCard): SettledRow[] => card.threads.map(threadRow);
export const threadsKey = (cardId: string) => `threads:${cardId}`;

/**
 * The service cards in the session's `order` that a read no longer draws, because their last PR left, as empty stand-ins while Mark seen
 * has something there to settle: a row you last saw there, or a suggestion you accepted there, with its Undo. So a service card stays put
 * like an effort's card rather than going out from under you; Mark seen lets it go.
 */
export function keptServiceCards(order: readonly string[], active: readonly DeckCard[], seen: Readonly<Record<string, readonly SettledRow[]>>,
  accepted: Accepted): DeckCard[] {
  const here = new Set(active.map((card) => card.id));
  return order.filter((id) => id.startsWith(SERVICE_PREFIX) && !here.has(id)
    && (!!seen[id]?.length || [...accepted.keys()].some((key) => key.startsWith(`${id} `)))).map((id) => {
    const repo = id.slice(SERVICE_PREFIX.length);
    return { id, key: id, name: serviceName(repo), goal: serviceGoal(repo), kind: "service", repo, oneOff: false, pile: "active", reason: "", since: 0,
      status: { tone: "quiet", text: "No open PRs" }, needsYou: 0, yourTurn: 0, stats: { open: 0, ready: 0, mergedWeek: 0, mergedFortnight: 0, medianAgeMs: null, oldestWait: null },
      progress: { merged: 0, open: 0 }, next: [], blocked: [],
      linear: { tickets: 0, known: 0, projects: [], initiatives: [], parents: [], states: [], labels: [], cycles: [], assignees: [], issues: [],
        reconcile: { done: [], prUrls: [], merged: [] } },
      people: { youWaitOn: [], waitOnYou: [] }, threads: [], activity: [], sections: [], suggestions: [], notes: null };
  });
}

// ---------------------------------------------------------------------------
// Moves: a card's few next moves, each one outcome, one verb, and one key.
// ---------------------------------------------------------------------------

/** What a move does, as the action its button and key run. */
type ActKind = Extract<DeckActionId, "address" | "merge" | "confirm" | "fix" | "nudge" | "release">;
/** Reconcile runs no action: its buttons show rows or open Linear, so it has no key. */
export type MoveKind = ActKind | "reconcile";
/**
 * One Reconcile line: what disagrees, its tickets, and its one button. `done`: tickets Linear completed, whose Show unfolds the open PRs
 * that name them; `merged`: open tickets whose PRs all merged, whose button opens the first one's Linear page, when Linear gave one.
 */
export type Mismatch = { kind: "done" | "merged"; text: string; tickets: string[]; button: string; url: string | null };
/**
 * One move: what it gets you, its detail in a line, its verb, and the rows it touches. Address's verb counts the rows you leave ticked.
 * Reconcile's lines say each mismatch with its own button.
 */
export type Move = { kind: MoveKind; title: string; meta: string; verb: string; tone: Tone; prUrls: string[]; lines?: Mismatch[] };
/** A reviewer holding a PR this long makes a move that names them; a shorter wait is a chore. */
const HOLDS_MS = 4 * DAY;
/** The move each section's rows make once Your turn has taken its own. */
const MOVE_OF: Partial<Record<DeckSection, ActKind>> = { merge: "merge", confirm: "confirm", work: "fix", nudge: "nudge" };
const TONE_OF: Record<ActKind, Tone> = { address: "amber", merge: "green", confirm: "green", fix: "blue", nudge: "gray", release: "gray" };
const handles = (text: string | null | undefined) => [...new Set(text?.match(/@[\w-]+/gu) ?? [])];
/** When a row's wait began: the feedback that waits on you, its next step, or what it waits on. */
const since = (row: DeckRow) => row.yourTurn?.since ?? row.step?.since ?? row.waitsOn?.since ?? null;
const oldest = (rows: readonly DeckRow[]) => rows.reduce<number | null>((first, row) => { const at = since(row); return at !== null && (first === null || at < first) ? at : first; }, null);
/** A move's rows by state word, in the order they come, a stack's children as stacked: "Ready to merge 1 · stacked 3". */
const states = (rows: readonly DeckRow[]) => {
  const words = rows.map((row) => /^Behind #/u.test(row.status) ? "stacked" : row.status);
  return [...new Set(words)].map((word) => `${word} ${words.filter((item) => item === word).length}`).join(" · ");
};

function move(kind: ActKind, rows: readonly DeckRow[], now: number): Move {
  const n = rows.length;
  const first = oldest(rows);
  const wait = first === null ? null : age(first, now);
  // One row names itself, so the move reads without opening.
  const make = (title: string, verb: string, ...detail: (string | null | false)[]): Move => ({ kind, title, verb, tone: TONE_OF[kind], prUrls: rows.map((row) => row.prUrl),
    meta: [n === 1 && refOf(rows[0]!), ...detail].filter(Boolean).join(" · ") });
  switch (kind) {
    case "address": {
      const who = [...new Set(rows.flatMap((row) => handles(row.yourTurn?.why)))];
      const names = who.length > 2 ? `${who.slice(0, 2).join(", ")} +${who.length - 2}` : who.join(", ");
      return make(who.length ? `${names} ${who.length === 1 ? "waits" : "wait"} on you` : "Feedback waits on you", "Address", n > 1 && plural(n, "PR"), wait);
    }
    case "merge": return make(n === 1 ? "Ready to merge" : `${n} ready to merge`, n === 1 ? "Merge…" : `Merge ${n}…`, n > 1 ? states(rows) : wait);
    case "confirm": return make(n === 1 ? "Approved; confirm its notes" : `${n} approved; confirm their notes`, "Confirm…", n > 1 && plural(n, "PR"), wait);
    case "fix": {
      const words = [...new Set(rows.map((row) => row.status))];
      const only = words.length === 1 ? words[0]! : null;
      const title = only === "Conflicts" ? `Clear conflicts${n > 1 ? ` on ${n}` : ""}` : only === "CI failing" ? `Fix CI${n > 1 ? ` on ${n}` : ""}`
        : `Unblock ${n === 1 ? "one" : n} of yours`;
      return make(title, `Fix ${n}…`, only === "Conflicts" || only === "CI failing" ? null : n === 1 ? only : states(rows), wait && (n > 1 ? `oldest ${wait}` : wait));
    }
    case "nudge": {
      // Who holds the most of them leads, named; the others follow with how many each holds.
      const holders = [...rows.flatMap((row) => row.nudge.map((login) => `@${login}`)).reduce((map, login) => map.set(login, (map.get(login) ?? 0) + 1), new Map<string, number>())]
        .sort((a, b) => b[1] - a[1]);
      const lead = holders[0];
      return make(lead ? `${lead[0]} holds ${lead[1]}` : `Reviewers hold ${n}`, holders.length === 1 ? `Nudge ${lead![0]}…` : `Nudge ${n}…`,
        wait && (n > 1 ? `oldest ${wait}` : wait), ...holders.slice(1).map(([login, k]) => `${login} ${k}`));
    }
    case "release": return make(`All ${plural(n, "PR")} held`, `Release ${n}…`, `held ${age(rows.reduce((at, row) => Math.min(at, row.hold?.since ?? now), now), now)}`);
  }
}

/** Reconcile, from where deck.ts found Linear and GitHub disagree: a line per mismatch, or no move when they agree. It writes nothing. */
function reconcile({ done, prUrls, merged }: DeckCard["linear"]["reconcile"]): Move | null {
  const lines: Mismatch[] = [
    ...done.length ? [{ kind: "done" as const, text: `${done.length} Done in Linear · ${plural(prUrls.length, "PR")} open`, tickets: done,
      button: `Show ${prUrls.length}`, url: null }] : [],
    ...merged.length ? [{ kind: "merged" as const, text: `${merged.length} open with every PR merged`, tickets: merged.map((ticket) => ticket.id), button: "Open in Linear ↗",
      url: merged.find((ticket) => ticket.url)?.url ?? null }] : []];
  return lines.length ? { kind: "reconcile", title: "Linear and GitHub disagree", meta: lines.map((line) => line.text).join(" · "), verb: lines[0]!.button,
    tone: "gray", prUrls, lines } : null;
}

/**
 * A card's moves, by one fixed rule, each row in the first that takes it: someone waits on you (Address); one step from merged (Merge,
 * then Confirm); your own blockers (Fix); a reviewer holding it 4 days or more (Nudge, naming who); then Linear and GitHub disagreeing
 * (Reconcile, from `disagree`). Nudges under 4 days, requests, and ready marks are chores: Advance clears them, and they never take a move.
 * With nothing to move and every open PR held, Release is the one move. A held effort moves nothing until you resume it. A row a write of
 * yours holds (busy, by `seenAt`) takes no move, but Your turn keeps its rows with their state, as All PRs does.
 */
export function rankMoves(rows: readonly DeckRow[], pile: DeckPile, now: number, disagree?: DeckCard["linear"]["reconcile"],
  seenAt: Readonly<Record<string, number>> = {}): { moves: Move[]; chores: string[] } {
  const active = pile === "active";
  const turn = rows.filter((row) => active && row.turn.list === "turn");
  const live = rows.filter((row) => active && !busy(row, seenAt[row.prUrl]) && row.turn.list !== "turn");
  const of = (kind: ActKind) => live.filter((row) => MOVE_OF[row.section] === kind && (kind !== "nudge" || now - (since(row) ?? now) >= HOLDS_MS));
  const moves = ([["address", turn], ...(["merge", "confirm", "fix", "nudge"] as const).map((kind) => [kind, of(kind)] as const)] as const)
    .flatMap(([kind, list]) => list.length ? [move(kind, list, now)] : []);
  const mismatch = active && disagree ? reconcile(disagree) : null;
  if (mismatch) moves.push(mismatch);
  const stuck = new Set(of("nudge"));
  const chores = live.filter((row) => (row.section === "nudge" && !stuck.has(row)) || row.section === "request" || row.section === "ready");
  const held = rows.filter((row) => row.section === "held");
  if (!moves.length && held.length && held.length === rows.length) moves.push(move("release", held, now));
  return { moves, chores: chores.map((row) => row.prUrl) };
}

// ---------------------------------------------------------------------------
// Linear priority: a glyph on each row's ticket chip, and what's left by priority in the p expand.
// ---------------------------------------------------------------------------

type Issue = DeckCard["linear"]["issues"][number];
/** Linear's priorities, 1 Urgent to 4 Low: a glyph after Linear's own climbing bars, hair spaces apart, its word, and red for Urgent alone. */
const PRIORITY: Record<number, { glyph: string; label: string; tone: Tone }> = { 1: { glyph: "!", label: "Urgent", tone: "red" },
  2: { glyph: "▂\u200a▄\u200a▆", label: "High", tone: "gray" }, 3: { glyph: "▂\u200a▄", label: "Medium", tone: "gray" }, 4: { glyph: "▂", label: "Low", tone: "gray" } };
/** A ticket's priority as drawn, in Linear's word when it gave one; none for no priority (0) or a ticket Linear hasn't read. */
export function priorityOf(issue: Pick<Issue, "priority" | "label"> | undefined): { glyph: string; label: string; tone: Tone } | null {
  const known = issue?.priority ? PRIORITY[issue.priority] : undefined;
  return known ? { ...known, label: issue!.label ?? known.label } : null;
}
/** A row's ticket chip: its first ticket and how many more it names, with the first's priority as a glyph. */
export type TicketChip = { text: string; glyph: string | null; title: string; tone: Tone };

// ---------------------------------------------------------------------------
// The finish line: how much is done, the date it answers to, and when it lands at the pace of the last two weeks.
// ---------------------------------------------------------------------------

export type Finish = {
  /** "4 of 12 done": Linear's completed tickets of those it read and didn't cancel, else merged PRs of every PR a read saw. */
  done: string;
  /** The date it answers to and where it stands: the Linear project's target, else the current cycle's end; null with neither. */
  date: { text: string; tone: Tone } | null;
  /** When its open PRs merge at the last 14 days' pace, "ETA Oct 14 at 1.5/wk"; amber past the date. Null with nothing open or merged. */
  eta: { text: string; tone: Tone } | null;
  /** The p expand: on track, what's left, who holds it, is it moving, and what stands between it and Done, a line each. */
  answers: [string, string][];
};

function finish(card: DeckCard, rows: readonly DeckRow[], now: number): Finish {
  const { linear, stats } = card;
  const doneTickets = linear.states.filter((state) => state.type === "completed").reduce((sum, state) => sum + state.count, 0);
  const left = linear.states.filter((state) => state.type !== "completed" && state.type !== "canceled");
  const leftTickets = left.reduce((sum, state) => sum + state.count, 0);
  const project = linear.projects.find((item) => item.targetDate);
  const cycle = linear.cycles.filter((item) => item.endsAt && daysTo(item.endsAt, now) >= 0)
    .sort((a, b) => Date.parse(a.endsAt!) - Date.parse(b.endsAt!))[0];
  const target = project ? { at: project.targetDate!, label: `Target ${calendarDay(project.targetDate!)}`, name: "the target" }
    : cycle ? { at: cycle.endsAt!, label: cycle.name ?? `Cycle ${cycle.number}`, name: "the cycle's end" } : null;
  const days = target ? daysTo(target.at, now) : null;
  const date: Finish["date"] = !target || days === null ? null
    : days < 0 ? { text: `${target.label} · ${-days}d late`, tone: "red" }
    : { text: `${target.label} · ${days ? `${days}d left` : "today"}`, tone: days ? "gray" : "amber" };
  const rate = stats.mergedFortnight / 2;
  const at = rate > 0 && stats.open > 0 ? now + stats.open / rate * 7 * DAY : null;
  const behind = at !== null && days !== null && days >= 0 ? daysTo(at, now) - days : null;
  const eta: Finish["eta"] = at === null ? null : { text: `ETA ${calendarDay(at)} at ${Number.isInteger(rate) ? rate : rate.toFixed(1)}/wk`, tone: behind !== null && behind > 0 ? "amber" : "gray" };
  // Who each open PR waits on: you, for your move or feedback that waits on you, else the reviewers its next step names. Held, in flight,
  // and stacked PRs wait on nobody yet.
  const holders = tally(rows.filter((row) => row.section !== "held" && row.section !== "flight").flatMap((row) => row.turn.list === "turn" || row.step?.owner === "you" ? ["You"]
    : row.step?.owner === "reviewers" ? (row.nudge.length ? row.nudge : row.reviewers.filter((review) => review.state === "requested").map((review) => review.login))
      .map((login) => `@${login}`) : []));
  const held = rows.filter((row) => row.section === "held").length;
  const active = card.threads.filter((thread) => thread.status === "active").length;
  // What's left by Linear's priority, most urgent first, and its points of all the points estimated on tickets not canceled.
  const open = linear.issues.filter((issue) => issue.type !== null && issue.type !== "completed" && issue.type !== "canceled");
  const points = (list: readonly Issue[]) => list.reduce((sum, issue) => sum + (issue.estimate ?? 0), 0);
  const estimated = linear.issues.filter((issue) => issue.estimate !== null && issue.type !== "canceled");
  const priorities = [...[1, 2, 3, 4].flatMap((rank) => { const list = open.filter((issue) => issue.priority === rank); return list.length ? [`${list.length} ${priorityOf(list[0])!.label}`] : []; }),
    estimated.length ? `${points(open)} of ${plural(points(estimated), "pt")} left` : null].filter(Boolean).join(" · ");
  const paced = at === null ? null : calendarDay(at);
  const track = !stats.open ? `No open PRs${leftTickets ? `; ${plural(leftTickets, "ticket")} still open` : ""}`
    : target && days !== null && days < 0 ? `${target.label} passed ${-days}d ago${paced ? ` · ETA ${paced}` : " · nothing merged in 14d"}`
    : target && behind !== null ? behind > 0 ? `Behind: ETA ${paced}, ${behind}d after ${target.name}` : `On pace: ETA ${paced}, ${-behind}d to spare`
    : target ? `Nothing merged in 14d to pace ${target.name}`
    : paced ? `No date in Linear · ETA ${paced}` : "No date, and nothing merged in 14d";
  return {
    done: doneTickets + leftTickets ? `${doneTickets} of ${doneTickets + leftTickets} done` : `${card.progress.merged} of ${card.progress.merged + stats.open} merged`,
    date, eta,
    answers: [["On track?", track],
      ["What's left", [linear.known ? `${plural(leftTickets, "open ticket")}${left.length ? `: ${left.map((state) => `${state.count} ${state.name}`).join(" · ")}` : ""}` : null,
        plural(stats.open, "open PR"), linear.known ? null : "no Linear data"].filter(Boolean).join(" · ")],
      ...priorities ? [["Left", priorities] as [string, string]] : [],
      ["Who holds it", holders || "Nobody: the rest is held, in flight, or stacked"],
      ["Moving?", `${stats.mergedWeek} merged in 7d · ${stats.mergedFortnight} in 14d`],
      ["To Done", [`${plural(stats.open, "open PR")}${held ? ` (${held} held)` : ""}`, leftTickets ? plural(leftTickets, "open ticket") : null,
        active ? plural(active, "active thread") : null].filter(Boolean).join(" · ")]],
  };
}

/** How strongly a suggestion's signals point at its target, as its group says it. */
export type Strength = "strong" | "moderate" | "weak";
/** One of a service card's suggestions, with the card's rows it covers. */
export type SuggestGroup = {
  /** The card's id and the classifier's group key: a group that spans repositories shows on each of their cards. */
  key: string; title: string; target: SuggestionGroup["target"]; color: string; reason: string; strength: Strength | null;
  /** The specific signals behind its target, strongest first, shown before you accept it. */
  signals: readonly string[];
  /**
   * What its one button does to its rows still here, and how many. `confirm`: a weak suggestion that would move PRs at once asks first,
   * listing each PR with its signals.
   */
  button: { kind: "assign" | "new" | "one-off" | "pick"; label: string; count: number; confirm: boolean };
  /** Its rows on the card, each with its own signals. */
  lines: DeckLine[];
  /** You accepted all of it that was here: one line with Undo until Mark seen. */
  accepted: { text: string; actionId: string } | null;
};
/** A suggestion you accepted, by its group key, with the PRs it moved and where its line was, until Mark seen. */
export type Accepted = ReadonlyMap<string, { actionId: string; text: string; prUrls: readonly string[]; index?: number }>;
export type CardScreen = {
  card: DeckCard; color: string;
  /** Your turn: its open PRs where a person's feedback waits on you (turnOf), which its strip chip and header count. A held PR isn't. */
  yourTurn: number;
  /** Its moves, ranked (rankMoves), and the chores Advance clears, with what they are: "nudge 2 · ready 1". */
  moves: Move[]; chores: { prUrls: string[]; text: string };
  /** Each open row's ticket chip, by PR; a row naming no ticket has none. */
  tickets: ReadonlyMap<string, TicketChip>;
  /** Every row the keys know: each open PR as the read has it, and each that left since you marked the card seen. */
  lines: DeckLine[];
  /** What changed here since you marked it seen, and whether Mark seen has anything else to settle: a suggestion you accepted, or a write that landed. */
  changed: number; settleable: boolean;
  /** Its PRs on hold now, which its Held toggle lists. */
  held: number;
  /** Its finish line and p expand, on an effort with an outcome; null on One-offs and cards no effort backs. */
  finish: Finish | null;
  /** Overview's: its first next step, its waits on others, and its open PRs by the move each needs. */
  next: string | null;
  blocked: { prUrl: string; ref: string; on: string; what: string; age: string | null; dot: boolean }[];
  stats: { open: number; mergedWeek: number; bar: { key: string; label: string; count: number; tone: Tone }[] };
  threads: { id: string; title: string; ref: string; status: string; waiting?: boolean; age: string | null; dot: boolean }[];
  /**
   * Chips for its projects (▣), initiatives (◇), and labels (#), a bar of its tickets' states, and its top project's target, all on one line;
   * then one [label, value] line per field Linear gave.
   */
  linear: { summary: string; chips: { kind: "project" | "initiative" | "label"; text: string }[]; bar: { name: string; count: number; tone: Tone }[];
    target: string | null; lines: [string, string][] };
  /** A service card's suggestions, in the classifier's order; empty on an effort's card. */
  suggest: SuggestGroup[];
  /** An effort's notes: all of them, and their first line; null on a card no effort backs. */
  notes: { body: string; first: string; revision: number } | null;
};

export type OverviewScreen = {
  cards: CardScreen[];
  held?: CardScreen[];
  other?: CardScreen[];
  blockers: { effortId: string; effort: string; ref: string; age: string | null; on: string; cause: string; since: number | null }[];
};

/** The active efforts in session order, with their waits ranked by age across efforts; service cards and Loose threads stay on the strip. */
export function overviewScreen(order: readonly string[], cards: ReadonlyMap<string, CardScreen>): OverviewScreen {
  const active = order.flatMap((id) => { const card = cards.get(id); return card?.card.kind === "effort" ? [card] : []; });
  const blockers = active.flatMap((screen) => screen.card.blocked.map((wait) => ({ effortId: screen.card.id, effort: screen.card.name,
    ref: wait.ref, age: screen.blocked.find((item) => item.prUrl === wait.prUrl)?.age ?? null, on: wait.on, cause: wait.what, since: wait.since })));
  blockers.sort((a, b) => a.since === null ? 1 : b.since === null ? -1 : a.since - b.since);
  return { cards: active, blockers };
}

const BAR: { key: string; label: string; tone: Tone; of: readonly DeckSection[] }[] = [
  { key: "ready", label: "ready to merge", tone: "green", of: ["merge"] }, { key: "yours", label: "your other moves", tone: "blue", of: ["confirm", "nudge", "request", "ready"] },
  { key: "fix", label: "to fix", tone: "amber", of: ["work"] }, { key: "flight", label: "in flight", tone: "gray", of: ["flight"] },
  { key: "blocked", label: "blocked", tone: "gray", of: ["blocked"] }, { key: "held", label: "held", tone: "gray", of: ["held"] }];

/** Where a suggestion points, as a row's chip says it. */
const pointer = (target: SuggestionGroup["target"]) => target?.kind === "effort" ? `→ ${target.name}` : target?.kind === "new" ? `→ new ${target.name}`
  : target?.kind === "one-off" ? "→ One-offs" : null;
/** A chore's kind, as the Advance line counts it. */
const CHORE: Partial<Record<DeckSection, string>> = { nudge: "nudge", request: "request", ready: "ready" };

/**
 * A card as the deck draws it: its moves and chores from the read, its finish line, and its rows against what you last marked seen,
 * which only counts what changed. On a service card, each row names where its suggestion points, and `accepted` collapses the
 * suggestions you took.
 */
export function cardScreen(card: DeckCard, seen: { rows: Readonly<Record<string, readonly SettledRow[]>>; at?: Readonly<Record<string, number>> },
  context: { now: number; accepted?: Accepted }): CardScreen {
  const { now } = context;
  const current = card.sections.flatMap((section) => section.rows);
  const groupOf = new Map(card.suggestions.flatMap((group) => group.prs.map((pr) => [pr.prUrl, group] as const)));
  const lines = settleRows(seen.rows[card.id], current, DECK_SECTIONS).map((item) => {
    const chip = pointer(groupOf.get(item.prUrl)?.target ?? null);
    return deckLine(item, card.pile, seen.at?.[item.prUrl], chip && !item.ghost ? [chip] : []);
  });
  const byPr = new Map(lines.map((line) => [line.prUrl, line]));
  const counts = (of: readonly DeckSection[]) => current.filter((row) => of.includes(row.section)).length;
  const threads = settleRows(seen.rows[threadsKey(card.id)], card.threads.map(threadRow)).filter((item) => !item.ghost).map((item) => {
    const thread = card.threads.find((candidate) => candidate.id === item.prUrl)!;
    const pr = thread.prUrl ? current.find((row) => row.prUrl === thread.prUrl) : undefined;
    return { id: thread.id, title: thread.title, ref: thread.role === "parent" ? "parent" : pr ? refOf(pr) : "", status: thread.status,
      age: thread.lastActivityAt === null ? null : age(thread.lastActivityAt, now), dot: item.change !== null || item.arrived,
      ...thread.waiting !== undefined ? { waiting: thread.waiting } : {} };
  });
  const { linear } = card;
  const tallies = (list: readonly { name: string; count: number }[]) => list.map((item) => `${item.name}${item.count > 1 ? ` ${item.count}` : ""}`).join(" · ");
  const top = linear.projects[0];
  const target = top?.targetDate ? `target ${calendarDay(top.targetDate)}` : null;
  const linearLines = ([["States", linear.states.map((state) => `${state.count} ${state.name.toLowerCase()}`).join(" · ")],
    ["Cycle", linear.cycles.map((cycle) => `${cycle.name ?? `Cycle ${cycle.number}`}${cycle.endsAt ? ` → ${calendarDay(cycle.endsAt)}` : ""}`).join(" · ")],
    ["Assignees", linear.assignees.map((person) => person.name).join(", ")],
    ["Target", linear.projects.flatMap((project) => project.targetDate ? [`${calendarDay(project.targetDate)} ${project.name}`] : []).join(" · ")],
    ["Parent", tallies(linear.parents)], ["Read", `${linear.known} of ${plural(linear.tickets, "ticket")}`]] as [string, string][]).filter(([, value]) => value);
  const suggest = suggestGroups(card, lines, context.accepted ?? new Map());
  const { moves, chores } = rankMoves(current, card.pile, now, linear.reconcile, seen.at);
  const issues = new Map(linear.issues.map((issue) => [issue.id, issue]));
  const tickets = new Map(current.flatMap((row) => {
    const [first, ...rest] = row.tickets;
    const priority = first ? priorityOf(issues.get(first)) : null;
    return first ? [[row.prUrl, { text: `${first}${rest.length ? ` +${rest.length}` : ""}`, glyph: priority?.glyph ?? null,
      title: [row.tickets.join(" · "), priority && `${priority.label} priority`].filter(Boolean).join(" · "), tone: priority?.tone ?? "gray" }] as const] : [];
  }));
  return {
    card, color: effortColor(card.id, card.oneOff),
    yourTurn: card.yourTurn,
    moves, chores: { prUrls: chores, text: tally(chores.map((prUrl) => CHORE[byPr.get(prUrl)!.section]!)) }, tickets,
    lines,
    changed: lines.filter((line) => line.dot).length + threads.filter((thread) => thread.dot).length,
    settleable: suggest.some((group) => group.accepted) || lines.some((line) => line.row?.acted?.state === "sent" && line.dim),
    held: counts(["held"]),
    finish: card.kind === "effort" && !card.oneOff ? finish(card, current, now) : null,
    next: card.next[0]?.text ?? null,
    blocked: card.blocked.map((item) => ({ prUrl: item.prUrl, ref: item.ref, on: item.on, what: item.what, age: item.since === null ? null : age(item.since, now),
      dot: !!byPr.get(item.prUrl)?.dot })),
    stats: { open: card.stats.open, mergedWeek: card.stats.mergedWeek,
      bar: BAR.map((segment) => ({ key: segment.key, label: segment.label, tone: segment.tone, count: counts(segment.of) })).filter((segment) => segment.count) },
    threads,
    linear: { summary: linear.known === 0 ? "no Linear data" : [top?.name, target].filter(Boolean).join(" · ") || `${linear.known} of ${linear.tickets} tickets`,
      chips: linear.known ? [...linear.projects.map((project) => ({ kind: "project" as const, text: project.name })),
        ...linear.initiatives.map((initiative) => ({ kind: "initiative" as const, text: initiative.name })),
        ...linear.labels.map((label) => ({ kind: "label" as const, text: label.name }))] : [],
      bar: linear.states.map((state) => ({ name: state.name, count: state.count,
        tone: state.type === "completed" ? "green" as const : state.type === "started" ? "blue" as const : "gray" as const })),
      target, lines: linear.known ? linearLines : [] },
    suggest,
    notes: card.notes && { body: card.notes.body, first: firstLine(card.notes.body), revision: card.notes.revision },
  };
}


const STRENGTH: Record<NonNullable<SuggestionGroup["confidence"]>, Strength> = { high: "strong", medium: "moderate", low: "weak" };

/** What accepting a group does to `n` of its PRs, as its button and a weak group's confirm say it. */
export function acceptLabel(target: SuggestionGroup["target"], n: number): string {
  return target?.kind === "effort" ? `Put ${n} in ${target.name}` : target?.kind === "new" ? `New effort from ${n}`
    : target?.kind === "one-off" ? `Mark ${n} one-off${n === 1 ? "" : "s"}` : "Pick per PR";
}

/**
 * A service card's suggestions: each group with its reason once and one button, over the card's rows it covers, in the classifier's order.
 * A group you accepted all of collapses to one line with Undo where it was, even after its PRs leave the card, until Mark seen.
 */
function suggestGroups(card: DeckCard, shown: readonly DeckLine[], accepted: Accepted): SuggestGroup[] {
  if (card.kind !== "service") return [];
  const keyOf = (key: string) => `${card.id} ${key}`;
  const make = (key: string, group: SuggestionGroup | null, lines: DeckLine[], done: { text: string; actionId: string } | null): SuggestGroup => {
    const target = group?.target ?? null;
    const count = lines.filter((line) => !line.dim).length;
    const title = !group ? "Moved" : target?.kind === "effort" || target?.kind === "new" ? target.name : target?.kind === "one-off" ? "One-offs" : "No clear signal";
    const strength = group?.confidence ? STRENGTH[group.confidence] : null;
    const confirm = strength === "weak" && (target?.kind === "effort" || target?.kind === "one-off");
    const button: SuggestGroup["button"] = { kind: target?.kind === "effort" ? "assign" : target?.kind ?? "pick",
      label: `${acceptLabel(target, count)}${confirm || target?.kind === "new" ? "…" : ""}`, count, confirm };
    return { key, title, target, color: target?.kind === "effort" ? effortColor(target.effortId) : target?.kind === "one-off" ? ONE_OFF_COLOR : SERVICE_COLOR,
      reason: (group?.reason ?? "").replace(/^No clear signal\.\s*/u, ""), strength, signals: group?.signals ?? [], button, lines, accepted: done };
  };
  const groups = card.suggestions.map((group) => {
    const key = keyOf(group.key);
    const taken = accepted.get(key);
    const lines = shown.filter((line) => !line.ghost && line.row && group.prs.some((pr) => pr.prUrl === line.prUrl))
      .map((line) => ({ ...line, signals: group.prs.find((pr) => pr.prUrl === line.prUrl)!.signals.map((signal) => signal.text) }));
    // It collapses only while nothing here is outside what you accepted, so the rest of a partial accept, or a PR that arrives, shows.
    return make(key, group, lines, taken && lines.every((line) => line.dim || taken.prUrls.includes(line.prUrl)) ? taken : null);
  });
  for (const [key, taken] of accepted) if (key.startsWith(keyOf("")) && !groups.some((group) => group.key === key))
    groups.splice(Math.min(taken.index ?? groups.length, groups.length), 0, make(key, null, [], taken));
  return groups.filter((group) => group.lines.length || group.accepted);
}


/** Each open row's state and section in one read, by PR, to tell what a later read changed. */
export type RowFacts = ReadonlyMap<string, { ref: string; status: string; section: DeckSection }>;
export function rowFacts(view: Pick<DeckView, "active" | "held">): RowFacts {
  return new Map([...view.active, ...view.held].flatMap((card) => card.sections.flatMap((section) => section.rows.map((row) =>
    [row.prUrl, { ref: refOf(row), status: row.status, section: row.section }] as const))));
}
/** What a row's Refresh found, in the hint bar: what changed and where the row is now, or that nothing did. */
export function refreshNote(ref: string, before: { status: string; section: DeckSection } | null, after: { status: string; section: DeckSection } | null,
  gone: { how: "merged" | "closed" } | null): string {
  if (!after) return `${ref}: ${gone ? (gone.how === "merged" ? "merged" : "closed") : "left this card"}`;
  if (!before || (before.status === after.status && before.section === after.section)) return `Read ${ref} just now · no change`;
  const moved = before.section !== after.section ? `now in ${SECTIONS[after.section].title}` : null;
  return `${ref}: ${[before.status !== after.status && `${before.status} → ${after.status}`, moved].filter(Boolean).join(" · ")}`;
}

/** The top bar's read status: when the deck last read GitHub, and GitHub's rate limit while it holds reads. */
export function readText(view: Pick<DeckView, "checkedAt" | "refreshing" | "limitedUntil">, now: number): string {
  const limited = view.limitedUntil !== null && view.limitedUntil > now ? `Rate-limited until ${clock(view.limitedUntil, now)} · ` : "";
  return `${limited}${view.refreshing ? "Reading now · " : ""}Read ${view.checkedAt ? `${age(Date.parse(view.checkedAt), now)} ago` : "never"}`;
}

/**
 * One strip chip: Overview, then the active pile in session order, service cards after the efforts. `count` is Your turn, so amber means a
 * person waits on you. `service`: no stored effort backs it.
 */
export type Chip = { id: string; n: number | null; name: string; color: string; count: number; ping: boolean; service: boolean };
export function stripChips(order: readonly string[], cards: ReadonlyMap<string, CardScreen>, cur: string | null): Chip[] {
  return [{ id: "overview", n: null, name: "Overview", color: "", count: 0, ping: false, service: false }, ...order.filter((id) => cards.has(id)).map((id, index) => {
    const card = cards.get(id)!;
    return { id, n: index < 9 ? index + 1 : null, name: card.card.name, color: card.color, count: card.yourTurn, ping: id !== cur && card.changed > 0,
      service: card.card.kind !== "effort" };
  })];
}

/** What the keys can act on: the view, the card or deck shown, the focused row, and the Your turn rows ticked for Address. */
export type KeyContext = {
  view: "deck" | "prs";
  /** The card shown on the deck, or Overview. */
  cur: CardScreen | "overview" | null;
  /** The first service card, which u goes to; none when nothing open is outside an effort. */
  service?: string | null;
  focused: DeckLine | null;
  /** On the deck, the Address move's rows you left ticked, which b takes. */
  selected: readonly DeckLine[];
  seenAvailable: boolean; undo: boolean; held: number; done: number;
  /**
   * In All PRs: whether a row is focused, whether it has a thread, and the moves its inventory row offers; whether x selects the focused
   * row; how many rows Your turn lists, which ⇧X selects; how many rows are selected, which e moves, and whether b can address them all;
   * and whether the focused row has a suggestion, which ⇧A accepts.
   */
  prs?: { row: boolean; thread: boolean; moves: ReadonlySet<DeckActionId>; selectable?: boolean; turn?: number; picked?: number; addressable?: boolean;
    suggested?: boolean };
};
export type Availability = Record<DeckActionId, { on: boolean; why: string }>;

/**
 * Which rows an act key would take: the focused row when it has that move, else the card's move of that kind, the rows its button lists,
 * else every row on the card with it; for review notes, only one row. Only rows a move takes now count, or for Release, rows still held.
 */
export function targets(id: DeckActionId, context: Pick<KeyContext, "cur" | "focused">): DeckLine[] {
  const section = SECTION_OF[id];
  if (!section) return [];
  // Overview draws no rows, so no key takes any from it.
  const card = context.cur === "overview" ? null : context.cur;
  const take = (lines: readonly DeckLine[]) => lines.filter((line) => (section === "held" ? releasable(line) : line.needs) && line.section === section);
  if (context.focused && take([context.focused]).length) return [context.focused];
  if (!card) return [];
  const move = card.moves.find((item) => item.kind === id);
  const list = take(card.lines).filter((line) => !move || move.prUrls.includes(line.prUrl));
  // Review notes are read and confirmed one PR at a time: the focused row's, else the card's first, never a batch.
  return id === "confirm" ? list.slice(0, 1) : list;
}

const NO_CARD = "open an effort card";
const NOTHING = { merge: "nothing is ready to merge", confirm: "no notes are waiting", nudge: "no nudge is due", request: "every PR has a reviewer",
  ready: "no draft is ready", release: "nothing here is on hold", fix: "no PR here needs a thread's fix" } as const;
/** The ticked deck rows Address takes: live ones All PRs lists on Your turn. The listing says why any it can't take stays out. */
export const addressPicks = (selected: readonly DeckLine[]): DeckLine[] => selected.filter((line) => !line.dim && line.row?.turn.list === "turn");
/** Every action's availability now, with why one can't run, for the keys, the hint bar, the ? sheet, and ⌘K. */
export function availability(context: KeyContext): Availability {
  const { focused, selected } = context;
  const deck = context.view === "deck";
  const card = deck && context.cur !== "overview" ? context.cur : null;
  const live = !!card && card.card.pile === "active";
  const service = !!card && card.card.kind === "service";
  const row = deck ? !!focused?.row && !focused.ghost : !!context.prs?.row;
  // A service card's rows move one at a time, from the focused row.
  const sorting = service && row && !focused!.dim;
  // An effort's rows move to One-offs too, as an explicit move out of it; One-offs' own rows are there already.
  const leaves = !!card && card.card.kind === "effort" && !card.card.oneOff;
  const prs = context.prs;
  const out = {} as Availability;
  const set = (id: DeckActionId, on: boolean, why = "") => { out[id] = { on, why: on ? "" : why }; };
  set("next", deck, "Efforts only"); set("prev", deck, "Efforts only"); set("jump", deck, "Efforts only");
  set("services", deck && !!context.service, deck ? "every PR is in an effort" : "Efforts only");
  set("view", true); set("seen", deck && context.seenAvailable, deck ? "nothing changed here" : "Efforts only");
  set("hold-pile", deck && context.held > 0, deck ? "no effort is on hold" : "Efforts only");
  set("done-pile", deck && context.done > 0, deck ? "no effort is done" : "Efforts only");
  set("advance", live && card!.chores.prUrls.length > 0, !card ? (deck ? NO_CARD : "Efforts only") : !live ? "this card is paused" : "no chores here");
  const effort = card?.card.kind === "effort";
  const stays = card?.card.oneOff ? "One-offs stays active" : !effort ? "this card stays active" : "it's on hold";
  set("hold", live && !card!.card.oneOff && effort, card ? stays : deck ? NO_CARD : "Efforts only");
  set("complete", live && !card!.card.oneOff && effort, card ? stays : deck ? NO_CARD : "Efforts only");
  set("held", !!card && card.held > 0, card ? "nothing here is on hold" : deck ? NO_CARD : "Efforts only");
  set("progress", !!card?.finish, card ? "only an effort with an outcome has a finish line" : deck ? NO_CARD : "Efforts only");
  set("promote", service && card!.card.stats.open > 0, service ? "no open PRs here" : card ? "only a service card promotes" : deck ? NO_CARD : "Efforts only");
  set("notes", !!card?.notes, card ? "only an effort keeps notes" : deck ? NO_CARD : "Efforts only");
  for (const id of ["merge", "confirm", "nudge", "request", "ready", "release", "fix"] as const) {
    if (!deck) { set(id, !!prs?.moves.has(id), prs?.row ? "the row has no such move" : "focus a row first"); continue; }
    set(id, (live || id === "release") && targets(id, context).length > 0, !card ? NO_CARD : NOTHING[id]);
  }
  // Address takes the Your turn rows ticked for it, never a row by focus alone: you pick what one thread gets.
  const picked = deck ? addressPicks(selected).length : prs?.picked ?? 0;
  // In All PRs, b takes the selection only while every row in it is one Address can take.
  const mixed = !deck && picked > 0 && prs?.addressable === false;
  set("address", (deck ? live : true) && picked > 0 && !mixed, deck && !card ? NO_CARD : deck && !live ? "this card is paused" : deck ? "no Your turn row is ticked"
    : mixed ? "Your turn rows only" : "select Your turn rows first");
  set("undo", context.undo, "nothing to undo");
  // In All PRs, a row holds or refreshes only when its list offers it. Refresh takes the selection there when there is one.
  set("hold-pr", deck ? row : !!prs?.moves.has("hold-pr"), deck || !row ? "focus a row first" : "the row has no such move");
  // Your confirmation of a PR's review notes clears its merge gate; taking it back makes the notes yours again. Only the deck offers it.
  set("revoke", deck ? !!focused?.row?.confirmation : !!prs?.moves.has("revoke"), !deck ? "Efforts only" : row ? "you haven't confirmed its notes" : "focus a row first");
  set("refresh", deck ? row : !!prs?.picked || !!prs?.moves.has("refresh"), deck || !row ? "focus a row first" : "the row has no such move");
  set("row-next", !deck || context.cur !== "overview", "no rows on Overview"); set("row-prev", !deck || context.cur !== "overview", "no rows on Overview");
  const turnRow = !!focused && !focused.dim && focused.row?.turn.list === "turn";
  set("select", deck ? turnRow : !!prs?.selectable, deck ? "focus a Your turn row first" : "focus a row first");
  set("select-section", deck ? !!card && card.yourTurn > 0 : (prs?.turn ?? 0) > 0, "nothing is on Your turn");
  set("expand", deck && !!card && card.moves.length > 0, deck ? (card ? "nothing to move here" : NO_CARD) : "Efforts only");
  set("clear", selected.length > 0 || (prs?.picked ?? 0) > 0, "nothing ticked");
  set("open-thread", deck ? !!focused?.row?.thread : !!prs?.thread, row ? "the row has no thread" : "focus a row first");
  set("open-pr", row, "focus a row first");
  // In All PRs, ⇧A takes the focused row's suggestion, and e moves the selection, else the focused row.
  set("accept", deck ? sorting : !!prs?.suggested, !deck ? (row ? "the row has no suggestion" : "focus a row first") : service ? "focus a row first"
    : "only a service card's rows move from here");
  set("move", deck ? sorting : !!prs?.picked || !!prs?.selectable, !deck ? "select a row first" : service ? "focus a row first" : "only a service card's rows move from here");
  set("one-off", (service || leaves) && row && !focused!.dim, !card ? (deck ? NO_CARD : "Efforts only") : card.card.oneOff ? "they're in One-offs"
    : service || leaves ? "focus a row first" : "only an effort's or a service card's rows move from here");
  set("new-effort", sorting, service ? "focus a row first" : "only a service card's rows move from here");
  set("rule", deck, "Efforts only");
  set("seed", deck, "Efforts only");
  set("palette", true); set("help", true);
  if (deck) for (const id of PR_VIEW_ACTIONS) set(id, false, "Open the PR in All PRs to act");
  return out;
}

/** The verb a move's key says in the hint bar. */
const HINT: Record<ActKind, string> = { address: "address", merge: "merge", confirm: "confirm", fix: "fix", nudge: "nudge", release: "release" };
/** The few keys that matter now, for the hint bar: [kbd, what it does]. */
export function hintKeys(context: KeyContext, on: Availability): [string, string][] {
  const { focused } = context;
  const card = context.cur === "overview" ? null : context.cur;
  const pick = (...items: ([DeckActionId, string] | false)[]) => items.flatMap((item) => item && on[item[0]].on ? [[ACTION[item[0]].keys.join(" "), item[1]] as [string, string]] : []);
  if (context.view === "prs") {
    const move = (["merge", "confirm", "nudge", "request", "ready", "release", "fix"] as const).find((id) => on[id].on);
    const moveHint = move ? [move, move === "merge" ? "preview merge" : move === "release" ? "release" : move === "fix" ? "ask to fix"
      : ACTION[move].title.replace("…", "").toLowerCase()] as [DeckActionId, string] : false;
    return context.prs?.picked ? pick(["select", "toggle"], ["address", "address selected"], ["move", "move"], ["refresh", "refresh"], ["clear", "clear"])
      : pick(["row-next", "rows"], moveHint, ["accept", "accept"], ["select", "select"], ["open-thread", "open thread"], ["refresh", "refresh"], ["view", "Efforts"]);
  }
  if (context.view === "deck") return pick(["row-next", "rows"], ["view", "All PRs"], ["open-thread", "open thread"], ["progress", "progress"], ["next", "flip"], ["seen", "mark seen"]);
  // Legacy move hints below remain shared with ranked move data.
  const moves = (card?.moves ?? []).flatMap((item) => item.kind === "reconcile" ? [] : [[item.kind, HINT[item.kind]] as [DeckActionId, string]]);
  if (focused) return pick(["row-next", "rows"], ...moves, ["select", "tick"], ["open-thread", "open thread"], ["refresh", "refresh"], ["expand", "fold"]);
  return pick(["row-next", "rows"], ...moves, ["advance", "advance"], ["progress", "progress"], ["next", "flip"], ["seen", "mark seen"]);
}

/** One palette entry: a registry action, or a go-to, resume, or reopen for one effort. */
export type PaletteItem = { key: string; group: string; title: string; keys: readonly string[]; on: boolean; why: string; action: DeckAction | null;
  target?: { kind: "go" | "resume" | "reopen"; id: string } };
/** Every action with its key, then each effort to go to, resume, or reopen; grayed with why when it can't run here. */
export function paletteItems(on: Availability, chips: readonly Chip[], piles: { held: readonly { id: string; name: string }[];
  done: readonly { id: string; name: string; archived: boolean }[] }, cur: string | null, deck: boolean): PaletteItem[] {
  const items: PaletteItem[] = DECK_ACTIONS.filter((action) => action.id !== "jump" && (!deck || !PR_VIEW_ACTIONS.has(action.id))).map((action) => ({ key: action.id, group: action.group, title: action.title,
    keys: action.keys, on: on[action.id].on, why: on[action.id].why, action }));
  items.push(...chips.map((chip) => ({ key: `go:${chip.id}`, group: "Deck", title: `Go to ${chip.name}`, keys: chip.n ? [String(chip.n)] : [],
    on: !deck || chip.id !== cur, why: "you're here", action: null, target: { kind: "go" as const, id: chip.id } })));
  items.push(...piles.held.map((item) => ({ key: `resume:${item.id}`, group: "Card", title: `Resume ${item.name}`, keys: [], on: true, why: "", action: null,
    target: { kind: "resume" as const, id: item.id } })));
  items.push(...piles.done.map((item) => ({ key: `reopen:${item.id}`, group: "Card", title: `Reopen ${item.name}`, keys: [], on: !item.archived,
    why: "archived: restore it first", action: null, target: { kind: "reopen" as const, id: item.id } })));
  return items;
}
/** The palette's matches for what you typed: a word of the title or group, or a key. */
export function paletteMatch(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter((item) => `${item.group} ${item.title}`.toLowerCase().includes(q) || item.keys.some((key) => key.toLowerCase() === q)) : [...items];
}

/**
 * The confirm for one PR's review notes: each note (a review body, or a thread the approval opened), the evidence since the newest, and
 * what leads. With evidence, Confirm handled leads; without it, asking the PR's thread leads, and confirming anyway is a second, deliberate
 * choice whose record says there was none. Follow-ups that linked the PR since show beside the evidence, whichever leads.
 */
export type NotesScreen = {
  notes: { id: string; who: string; what: string; age: string; body: string; truncated: boolean }[];
  /** `linked`: the issues and PRs that mention this one since the note, in one line; null when none do. */
  evidence: { text: string; handled: boolean; linked: string | null };
  /** What ⌘↵ does; null when there's no evidence and nowhere to ask, which leaves only Confirm anyway's own click. */
  primary: "confirm" | "ask" | null;
  /** Where Ask sends the approval-feedback recipe, or why it can't. */
  ask: { to: string } | { why: string };
};
export function notesScreen(read: Extract<ConfirmRead, { ok: true }>, now: number): NotesScreen {
  const yes = handled(read.evidence);
  return {
    notes: read.sources.map((source) => ({ id: source.id, who: `@${source.author}`, age: age(Date.parse(source.at), now), body: source.body, truncated: source.truncated,
      what: source.kind === "review" ? "review" : source.resolved ? "thread, resolved" : "thread, open" })),
    evidence: { text: evidenceText(read.evidence), handled: yes, linked: linkedText(read.evidence) },
    primary: yes ? "confirm" : read.ask.kind === "none" ? null : "ask",
    ask: read.ask.kind === "thread" ? { to: `goes to “${read.ask.title}”` } : read.ask.kind === "new" ? { to: `starts a thread under ${read.ask.under}` }
      : { why: read.ask.why },
  };
}
