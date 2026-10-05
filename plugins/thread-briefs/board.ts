/**
 * The board's rules, with no React and no rpc in them.
 *
 * Everything here is a pure function over a row shape the component builds from
 * two sources it does not control — the briefs off the wire and the sidebar's
 * live thread view — so which column a thread lands in, what order the cards
 * inside one go in, what a drag writes, and how the filters travel in the URL
 * are all testable without mounting anything.
 */
import type {
  BriefCard,
  BriefStage,
  BriefStatus,
  StoredBriefStatus,
} from "./contract.js";
import {
  STAGE_LABELS,
  STALE_DONE_RING_ICON,
  STATUS_LABELS,
  doneRingIcon,
  stageRingIcon,
} from "./brief.js";
import {
  BRIEF_STAGES,
  STORED_BRIEF_STATUSES,
  idleMsSince,
  isLiveWorking,
  isStaleDone,
  projectColorIndex,
} from "./shared.js";

// ----------------------------------------------------------------- the columns

/**
 * The column for a thread with nothing to sort by on this axis.
 *
 * Briefs are never backfilled, so on any real install a number of threads have
 * no stage to sort by. Giving them a column rather than dropping them is what
 * lets the board be read as "everything I have open": a thread missing from a
 * board that claims completeness is indistinguishable from a thread that is
 * finished, which is the one reading this surface cannot afford. It is the same
 * job bb's own catch-all "Threads" group does for the status sections.
 *
 * Named for the *axis* and not the cause. Every card resolves a stage — see
 * `briefCardFor` — so this column is exactly the threads with no stored brief,
 * which is two different situations: one never summarized, and one whose first
 * summary is still in flight (`listBriefCards` maps stored rows only). "No
 * stage" is the one label true of both, and it is the label that says why the
 * column is on a board whose other columns are stages. The card face still says
 * "never summarized", because that is the cause and the thing you can act on.
 */
export const NO_STAGE_COLUMN = "none";

/**
 * The terminal column, which holds a *status* rather than a stage.
 *
 * `done` is deliberately not a fifth stage anywhere else in this plugin — that
 * is what keeps the ring at four readable quarters. A board is the one surface
 * where it has to become a column anyway, because the whole affordance of a
 * kanban is that work flows left into a terminal bucket, and without one the
 * Review column mixes "needs my review" with "finished, archiving tomorrow" —
 * exactly the confusion the board exists to remove. The cost is that column
 * position stops meaning stage for this one column, and it is paid back on the
 * card: a done card still draws the closed ring, so its stage is legible there.
 */
export const DONE_COLUMN = "done";

export type BoardColumn =
  | typeof NO_STAGE_COLUMN
  | BriefStage
  | typeof DONE_COLUMN;

/** Left to right: stageless, then the four stages in order, then done. */
export const BOARD_COLUMNS: readonly BoardColumn[] = [
  NO_STAGE_COLUMN,
  ...BRIEF_STAGES,
  DONE_COLUMN,
];

export const BOARD_COLUMN_LABELS: Record<BoardColumn, string> = {
  [NO_STAGE_COLUMN]: "No stage",
  ...STAGE_LABELS,
  [DONE_COLUMN]: "Done",
};

/** Whether a column names a stage, which is what makes it a drop target. */
export function isStageColumn(column: BoardColumn): column is BriefStage {
  return (BRIEF_STAGES as readonly string[]).includes(column);
}

// -------------------------------------------------------------------- the rows

/**
 * What the board needs from one sidebar thread.
 *
 * A structural subset of the SDK's `PluginSidebarThread` rather than the type
 * itself, so these functions can be tested with plain objects and still accept
 * the real thing.
 */
export type BoardRowThread = {
  id: string;
  projectId: string;
  displayTitle: string;
  href: string;
  /** bb's live execution status, for the `working` fold. */
  status: string;
  isPinned: boolean;
  isHidden: boolean;
  latestAttentionAt: number;
};

/** One card on the board: a thread, its brief if it has one, and its column. */
export type BoardRow = {
  threadId: string;
  title: string;
  href: string;
  /** Null for a thread with no project, which cannot take a project colour. */
  project: { id: string; name: string } | null;
  isPinned: boolean;
  latestAttentionAt: number;
  /**
   * The status the card shows: `working` where bb says the agent is running or
   * queued, otherwise the brief's own. Null for a briefless idle thread, which
   * has no status to claim — the board says so by leaving the badge off rather
   * than guessing one.
   */
  status: BriefStatus | null;
  /** The brief's facts, or null for a thread that has never been summarized. */
  card: BriefCard | null;
  /** Set only for a done thread that has gone cold; see `isStaleDone`. */
  stale: { idleMs: number; archiving: boolean } | null;
  column: BoardColumn;
};

/**
 * The column a row sits in, from its *folded* status rather than the stored one.
 *
 * Folded matters for one case: a done thread someone has started working in
 * again. Its brief still says done until the next summary lands, but bb says its
 * agent is running — and a card sitting in Done while its thread is mid-turn is
 * the board contradicting the sidebar. `working` can never equal `done`, so
 * reading the fold puts it back in its stage column immediately.
 */
export function columnFor(
  card: BriefCard | null,
  status: BriefStatus | null,
): BoardColumn {
  if (card === null) return NO_STAGE_COLUMN;
  if (status === "done") return DONE_COLUMN;
  return card.stage;
}

/**
 * Join the sidebar's live threads to the briefs off the wire.
 *
 * Driven by the *threads*, not the briefs: a brief with no thread beside it is a
 * thread this window is not showing — archived, or in a lifecycle the hook was
 * not asked for — and drawing a card for it would put something on the board
 * that clicking cannot reach. A thread with no brief still gets a row, in
 * {@link NO_STAGE_COLUMN}.
 */
export function buildRows(args: {
  threads: readonly BoardRowThread[];
  cards: readonly BriefCard[];
  projects: readonly { id: string; name: string }[];
  now: number;
  staleAfterMs: number;
  archiveAfterMs: number;
}): BoardRow[] {
  const cardByThreadId = new Map(
    args.cards.map((card) => [card.threadId, card] as const),
  );
  const projectNames = new Map(
    args.projects.map((project) => [project.id, project.name] as const),
  );

  const rows: BoardRow[] = [];
  for (const thread of args.threads) {
    // bb keeps hidden threads out of its own list — they are helper threads a
    // plugin spawned — and a board of work to pick up is not where they belong.
    if (thread.isHidden) continue;

    const card = cardByThreadId.get(thread.id) ?? null;
    const status: BriefStatus | null = isLiveWorking(thread.status)
      ? "working"
      : (card?.status ?? null);
    const stale =
      status === "done" &&
      isStaleDone({
        status,
        latestAttentionAt: thread.latestAttentionAt,
        now: args.now,
        afterMs: args.staleAfterMs,
      })
        ? {
            idleMs: idleMsSince(thread.latestAttentionAt, args.now),
            archiving: args.archiveAfterMs > 0,
          }
        : null;

    rows.push({
      threadId: thread.id,
      title: thread.displayTitle,
      href: thread.href,
      project:
        typeof thread.projectId === "string" && thread.projectId !== ""
          ? {
              id: thread.projectId,
              // The card still takes its colour from the id when the project is
              // not in the list yet; only the name waits.
              name: projectNames.get(thread.projectId) ?? "",
            }
          : null,
      isPinned: thread.isPinned,
      latestAttentionAt: thread.latestAttentionAt,
      status,
      card,
      stale,
      column: columnFor(card, status),
    });
  }
  return rows;
}

// ------------------------------------------------------------------ the sorting

/**
 * Where each status sits in "what should I look at first".
 *
 * `working` deliberately ranks *below* both waiting statuses: the agent has it,
 * so it is the one kind of row that is making progress without you. A briefless
 * row comes last because nothing is known about it — it is the bucket the
 * summarizer has not reached, not a claim that there is nothing to do.
 */
const STATUS_ORDER: readonly BriefStatus[] = [
  "waiting-on-me",
  "waiting-on-other",
  "working",
  "done",
];

export function statusRank(status: BriefStatus | null): number {
  if (status === null) return STATUS_ORDER.length;
  const index = STATUS_ORDER.indexOf(status);
  return index === -1 ? STATUS_ORDER.length : index;
}

/**
 * Card order inside one column: pins, then urgency, then recency.
 *
 * A pin is the user saying "keep this in front of me", and it outranks anything
 * inferred here for the same reason the archive sweep refuses to touch one.
 * Recency last rather than first because a column is scanned top-down and the
 * question being asked of it is which row needs a person, not which row moved.
 * The thread id breaks the final tie so the order is stable across renders
 * rather than left to the sort's implementation.
 */
export function compareRows(a: BoardRow, b: BoardRow): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  const byStatus = statusRank(a.status) - statusRank(b.status);
  if (byStatus !== 0) return byStatus;
  if (a.latestAttentionAt !== b.latestAttentionAt) {
    return b.latestAttentionAt - a.latestAttentionAt;
  }
  return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
}

/**
 * How many cards a column draws before it offers the rest behind a button.
 *
 * The SDK asks a plugin list to window its rows, and six unwindowed columns on
 * a phone is the case it is asking about. A cap is a tenth of the code of a
 * virtualiser and costs nothing here, because a column past fifty cards is one
 * you are going to filter rather than scroll.
 */
export const COLUMN_CAP = 50;

export function groupByColumn(
  rows: readonly BoardRow[],
  columns: readonly BoardColumn[],
): { column: BoardColumn; rows: BoardRow[] }[] {
  const byColumn = new Map<BoardColumn, BoardRow[]>(
    columns.map((column) => [column, []] as const),
  );
  for (const row of rows) byColumn.get(row.column)?.push(row);
  return columns.map((column) => ({
    column,
    rows: (byColumn.get(column) ?? []).sort(compareRows),
  }));
}

// ------------------------------------------------------------------ the filters

export type BoardFilters = {
  projectIds: readonly string[];
  statuses: readonly BriefStatus[];
};

export const NO_FILTERS: BoardFilters = { projectIds: [], statuses: [] };

export function isFiltered(filters: BoardFilters): boolean {
  return filters.projectIds.length > 0 || filters.statuses.length > 0;
}

/**
 * Whether a row survives the filters. An empty list means "no opinion", not
 * "nothing", so the unfiltered board is the same code path as a filtered one.
 *
 * A status filter drops every briefless row, because a briefless row has no
 * status to match — which is the honest answer rather than a special case:
 * asking for "waiting on you" is asking a question only a brief can answer.
 */
export function matchesFilters(row: BoardRow, filters: BoardFilters): boolean {
  if (
    filters.projectIds.length > 0 &&
    (row.project === null || !filters.projectIds.includes(row.project.id))
  ) {
    return false;
  }
  if (
    filters.statuses.length > 0 &&
    (row.status === null || !filters.statuses.includes(row.status))
  ) {
    return false;
  }
  return true;
}

/**
 * The columns worth drawing under these filters.
 *
 * A column that can only ever be empty is worse than absent: it is a bucket the
 * board is inviting you to read as "nothing here", when in fact the filter
 * excluded it. So the two columns that *are* statuses come and go with the
 * status filter, while the stage columns always stay — a status says nothing
 * about how far along a thread is, which is the whole reason the two axes are
 * separate.
 */
export function visibleColumns(filters: BoardFilters): BoardColumn[] {
  if (filters.statuses.length === 0) return [...BOARD_COLUMNS];
  const columns: BoardColumn[] = [];
  if (filters.statuses.some((status) => status !== "done")) {
    columns.push(...BRIEF_STAGES);
  }
  if (filters.statuses.includes("done")) columns.push(DONE_COLUMN);
  return columns;
}

/** The statuses the filter offers, in the order they rank. */
export const FILTERABLE_STATUSES: readonly BriefStatus[] = STATUS_ORDER;

/**
 * The filters as one line, e.g. `project:prj_a,prj_b/status:done`.
 *
 * A line rather than a JSON object because it is read back by
 * {@link filtersFromLine}, which is total: a line left behind by another
 * version of this plugin degrades to the filters it still recognises, where a
 * parsed object would have to be validated field by field to say the same
 * thing. Values are escaped and the whole thing is canonically ordered, so the
 * same filter always produces the same line.
 */
export function lineFromFilters(filters: BoardFilters): string {
  const segments: string[] = [];
  if (filters.projectIds.length > 0) {
    segments.push(`project:${encodeList([...filters.projectIds].sort())}`);
  }
  if (filters.statuses.length > 0) {
    const ordered = FILTERABLE_STATUSES.filter((status) =>
      filters.statuses.includes(status),
    );
    segments.push(`status:${encodeList(ordered)}`);
  }
  return segments.join("/");
}

/**
 * Filters back out of a line, ignoring anything it does not recognise.
 *
 * Deliberately total: this parses storage, which outlives the build that wrote
 * it — an older line is missing keys this version knows, a newer one carries
 * keys it does not. Every failure mode collapses to "that filter is not
 * applied", which shows more than intended rather than crashing the page.
 */
export function filtersFromLine(line: string): BoardFilters {
  const projectIds: string[] = [];
  const statuses: BriefStatus[] = [];
  for (const segment of line.split("/")) {
    const separator = segment.indexOf(":");
    if (separator === -1) continue;
    const key = segment.slice(0, separator);
    const values = decodeList(segment.slice(separator + 1));
    if (key === "project") {
      for (const value of values) {
        if (value !== "" && !projectIds.includes(value)) projectIds.push(value);
      }
    } else if (key === "status") {
      for (const value of values) {
        if (isBriefStatus(value) && !statuses.includes(value)) {
          statuses.push(value);
        }
      }
    }
  }
  return { projectIds, statuses };
}

function encodeList(values: readonly string[]): string {
  return values.map((value) => encodeURIComponent(value)).join(",");
}

function decodeList(raw: string): string[] {
  return raw.split(",").map((value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      // A malformed escape is not worth losing the rest of the filter over.
      return value;
    }
  });
}

function isBriefStatus(value: string): value is BriefStatus {
  return (
    value === "working" ||
    (STORED_BRIEF_STATUSES as readonly string[]).includes(value)
  );
}

/** One toggle of a filter value, as the chips drive it. */
export function toggleFilterValue<Value extends string>(
  values: readonly Value[],
  value: Value,
): Value[] {
  return values.includes(value)
    ? values.filter((existing) => existing !== value)
    : [...values, value];
}

// ------------------------------------------------------------------- the layout

/**
 * The two columns that collapse to a rail rather than holding a column's width.
 *
 * Both are the bookends, and both earn it for the same reason from opposite
 * directions: **No stage** is empty on any install where the summarizer has
 * caught up, and **Done** fills with cards whose whole point is that you are
 * finished with them. Six equal columns means the four that answer "what should
 * I pick up" are the ones pushed off the side of the viewport, so the two that
 * do not answer it give their width up and the stages spread into it.
 *
 * Collapsed is a rail, not an absence. A card that vanished off the board would
 * make the board unreadable as "everything I have open" — the same argument that
 * gives {@link NO_STAGE_COLUMN} a column at all — and Done has to stay on screen
 * regardless because dropping a card there is how you finish it by hand.
 */
export const COLLAPSIBLE_COLUMNS: readonly BoardColumn[] = [
  NO_STAGE_COLUMN,
  DONE_COLUMN,
];

export function isCollapsibleColumn(column: BoardColumn): boolean {
  return COLLAPSIBLE_COLUMNS.includes(column);
}

/** One column as the page draws it: its cards, and how much room it takes. */
export type ColumnLayout = {
  column: BoardColumn;
  rows: BoardRow[];
  /** Drawn as a rail: the label and the count, no cards. */
  isCollapsed: boolean;
  /** Whether the header offers a control to change that. */
  canToggle: boolean;
};

/**
 * Which columns to draw, what is in them, and which of them are rails.
 *
 * The collapse rules, each of which is a choice:
 *
 * - **Done starts collapsed**, every time the board loads. It is the only column
 *   whose cards are, by definition, not work — and a default that had to be
 *   re-applied by hand each session would be no default at all. Expanding is one
 *   click and it sticks in the URL, so the reading "show me what I finished" is
 *   a link rather than a preference.
 * - **No stage collapses only when it is empty**, which is most of the time and
 *   is exactly when it is worth nothing. When it does hold threads they are ones
 *   the summarizer has not reached and the Summarize button is the point, so the
 *   column opens itself rather than hiding them behind a rail.
 * - **The only column on the board never collapses.** Filter to `status:done`
 *   and {@link visibleColumns} returns Done alone; collapsing it would leave a
 *   board consisting of one closed strip and no way to read what you asked for.
 *
 * Note what is deliberately *not* a rule: a status filter that merely includes
 * `done` alongside others does not force Done open. It would conflict with the
 * expansion in the URL — the filter would say open, the URL would say closed,
 * and the collapse control would then be a button that does nothing. One click
 * is the cheaper answer than two sources of truth.
 */
export function layOutColumns(args: {
  rows: readonly BoardRow[];
  filters: BoardFilters;
  expanded: readonly BoardColumn[];
}): ColumnLayout[] {
  const columns = visibleColumns(args.filters);
  return groupByColumn(args.rows, columns).map(({ column, rows }) => {
    const isCollapsed =
      isCollapsibleColumn(column) &&
      columns.length > 1 &&
      !args.expanded.includes(column) &&
      (column === DONE_COLUMN || rows.length === 0);
    return {
      column,
      rows,
      isCollapsed,
      canToggle:
        isCollapsibleColumn(column) &&
        columns.length > 1 &&
        // A rail with nothing behind it is not a button: pressing it would open
        // an empty column, and the count on the rail already said so.
        (isCollapsed ? rows.length > 0 : true),
    };
  });
}

/**
 * A whole board view: what is filtered out, and which rails are open.
 *
 * Both are remembered for the same reason — the board is a place you come back
 * to rather than one you arrive at fresh, and a filter you have to reapply
 * every visit is one you stop using. The expansion rides in the same line as
 * the filters because {@link filtersFromLine} ignores segments it does not
 * recognise, which makes `expand:` additive: a line stored before this existed
 * still parses, and one stored after still parses in a build without it.
 */
export type BoardView = {
  filters: BoardFilters;
  expanded: readonly BoardColumn[];
};

export const EMPTY_VIEW: BoardView = { filters: NO_FILTERS, expanded: [] };

/** Filters first, then the expansion, so one view is always one line. */
export function lineFromView(view: BoardView): string {
  const segments: string[] = [];
  const filters = lineFromFilters(view.filters);
  if (filters !== "") segments.push(filters);
  const ordered = COLLAPSIBLE_COLUMNS.filter((column) =>
    view.expanded.includes(column),
  );
  if (ordered.length > 0) segments.push(`expand:${encodeList(ordered)}`);
  return segments.join("/");
}

/**
 * A view back out of a line. Total, like the filter parse it wraps: an
 * unrecognised column in `expand:` is one that cannot collapse anyway, so
 * dropping it silently is the same answer as honouring it.
 */
export function viewFromLine(line: string): BoardView {
  const expanded: BoardColumn[] = [];
  for (const segment of line.split("/")) {
    if (!segment.startsWith("expand:")) continue;
    for (const value of decodeList(segment.slice("expand:".length))) {
      const column = value as BoardColumn;
      if (isCollapsibleColumn(column) && !expanded.includes(column)) {
        expanded.push(column);
      }
    }
  }
  return { filters: filtersFromLine(line), expanded };
}

// -------------------------------------------------------------------- the drags

/**
 * What one drop writes. Both are the overrides the Brief panel already sets, so
 * the board gains no new state of its own: a dragged card is pinned to where you
 * put it, anchored to the thread's activity cursor, and the pin retires on the
 * next real turn.
 */
export type BoardDrop =
  | { kind: "stage"; stage: BriefStage | null }
  | { kind: "status"; status: StoredBriefStatus | null };

/**
 * The writes a drop performs, in order, or none where the drop changes nothing.
 *
 * Three rules worth stating, because each is a choice:
 *
 * - **Dropping a card on the stage the summarizer already judged clears the pin**
 *   rather than setting one. Dragging a card back to where it would have sat by
 *   itself is a statement that the model was right, and pinning it there would
 *   leave a pin that does nothing until it silently expires.
 * - **Dragging out of Done pins `waiting-on-me`.** A done reading can come from
 *   the derivation (nothing outstanding in the brief) as well as from a pin, and
 *   *clearing* a pin in the first case would hand the card straight back to a
 *   derivation that still says done — the card would snap back into the column
 *   you just dragged it out of. Pinning is the only write that always produces
 *   what the drag asked for. Where the derivation already disagreed the pin is
 *   redundant, which costs nothing: it says the same thing and retires on the
 *   next turn either way.
 * - **The briefless column is not a drop target**, in either direction. A thread
 *   with no brief has no row to pin anything on, and there is no such thing as
 *   un-summarizing one.
 */
export function planDrop(row: BoardRow, target: BoardColumn): BoardDrop[] {
  const card = row.card;
  if (card === null) return [];
  if (target === NO_STAGE_COLUMN) return [];

  if (target === DONE_COLUMN) {
    return row.column === DONE_COLUMN
      ? []
      : [{ kind: "status", status: "done" }];
  }
  if (!isStageColumn(target)) return [];

  const drops: BoardDrop[] = [];
  if (row.column === DONE_COLUMN) {
    drops.push({ kind: "status", status: "waiting-on-me" });
  }
  if (target === card.modelStage) {
    if (card.stageOverride !== null) drops.push({ kind: "stage", stage: null });
  } else if (card.stageOverride !== target) {
    drops.push({ kind: "stage", stage: target });
  }
  return drops;
}

// ------------------------------------------------------------------- the labels

/** How many rows each status holds, for the filter chips' counts. */
export function countByStatus(
  rows: readonly BoardRow[],
): Record<BriefStatus, number> {
  const counts: Record<BriefStatus, number> = {
    working: 0,
    "waiting-on-me": 0,
    "waiting-on-other": 0,
    done: 0,
  };
  for (const row of rows) if (row.status !== null) counts[row.status] += 1;
  return counts;
}

/**
 * The one thing the status badge cannot say.
 *
 * `waiting-on-me` covers a thread the *agent* could carry on by itself as well
 * as one that needs your answer, because the nudge is ours to give — so two cards reading
 * "Waiting on you" can want completely different amounts of work from you. On a
 * board, where the whole task is choosing between them, that difference is worth
 * a word.
 */
export function actorHint(
  card: BriefCard | null,
  status: BriefStatus | null,
): string | null {
  if (card === null || status !== "waiting-on-me") return null;
  return card.nextStepActor === "agent" ? "agent can continue" : null;
}

/**
 * The ring a card draws, or null for a briefless one.
 *
 * The same three-facts-in-one-glyph as the sidebar row — how far round is the
 * stage, a filled centre is done, the hue is the project, grey is done and cold
 * — so the vocabulary learned in one place reads in the other. It differs from
 * `rowDecoration` in one way: a `working` card still draws its brief's ring here.
 * On a row that decoration is suppressed because bb has a live glyph of its own
 * to put there; a card has room for both and the stage is still the fact that
 * says how close the running thread is to finished.
 */
export function cardRingIcon(row: BoardRow): string | null {
  if (row.card === null) return null;
  if (row.stale !== null) return STALE_DONE_RING_ICON;
  const colorIndex =
    row.project === null ? undefined : projectColorIndex(row.project.id);
  if (row.status === "done") return doneRingIcon(colorIndex);
  return stageRingIcon(row.card.stage, colorIndex);
}

/** Whether either pin is in force on this card, for the "pinned" marker. */
export function isPinnedByHand(card: BriefCard | null): boolean {
  return (
    card !== null &&
    (card.stageOverride !== null || card.statusOverride !== null)
  );
}

/** The accessible name for one card's status badge. */
export function statusLabel(status: BriefStatus | null): string {
  return status === null ? "No brief yet" : STATUS_LABELS[status];
}
