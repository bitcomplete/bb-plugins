/**
 * The board: every thread with a brief, in a column per stage, on its own page.
 *
 * **Why a page and not more sidebar.** The sidebar row has exactly one slot, and
 * this plugin already spends it on the stage ring. Everything else a brief knows
 * — the next step, who owes it, what is blocking, how long it has sat — has
 * nowhere to go on a row, and the Brief panel shows it one thread at a time,
 * which is the wrong shape for the question "which of these should I pick up".
 * A `navPanel` is bb's own answer: it takes the whole main area, gets a route of
 * its own, and arrives in the sidebar as a host-owned item beside Plugins and
 * Skills, orderable and hideable by the user with no work here.
 *
 * **Why the columns are stages.** Status is what the board *filters* by, because
 * it is the question you arrive with ("what needs me?"). Stage is what it lays
 * out, because it is the question you arrive unable to answer: of the eleven
 * threads waiting on you, which is one turn from done and which has not started.
 * Filtering on the first and laying out the second is what makes a single glance
 * answer both.
 *
 * **Why two of the six columns are rails.** Six equal columns spent a third of
 * the width on the two that do not answer "what should I pick up" — No stage,
 * empty whenever the summarizer has caught up, and Done, which fills with cards
 * whose point is that you are finished with them — and the four that do answer it
 * were the ones scrolled off the side. So those two collapse to a rail and the
 * stages flex into the width. See `layOutColumns` for when each one collapses; a
 * rail keeps its count and its drop target, so nothing has left the board.
 *
 * **Where the data comes from.** Two sources, joined on the client. The briefs
 * arrive in one `listBriefCards` call — one kv scan, no per-thread lookups — and
 * everything else (title, project, pin, live run status, attention cursor) is
 * already in the host's own cache behind `experimental_useSidebarThreads`, which
 * costs no request and updates exactly when bb's sidebar does. The board is
 * therefore the same shape as the row glyphs: stored facts over the wire, live
 * facts from the hook, folded together in a pure function in `board.ts`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  experimental_Icon as Icon,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  BriefCard,
  BriefState,
  BriefStage,
  BriefStatus,
  StoredBriefStatus,
  rpcContract,
} from "./contract.js";
import {
  BRIEFS_CHANGED_CHANNEL,
  STALE_DONE_RING_COLOR,
  idleMsSince,
  projectColorIndex,
  projectRingColor,
} from "./shared.js";
import { idleFor, summarizedAgo } from "./brief.js";
import {
  BOARD_COLUMN_LABELS,
  DONE_COLUMN,
  FILTERABLE_STATUSES,
  NO_STAGE_COLUMN,
  NO_FILTERS,
  COLUMN_CAP,
  EMPTY_VIEW,
  actorHint,
  buildRows,
  cardRingIcon,
  isFiltered,
  isPinnedByHand,
  isStageColumn,
  layOutColumns,
  matchesFilters,
  planDrop,
  statusLabel,
  lineFromView,
  toggleFilterValue,
  viewFromLine,
  type BoardColumn,
  type BoardView,
  type BoardDrop,
  type BoardFilters,
  type BoardRow,
} from "./board.js";
import { Field, StageControl, StatusControl } from "./controls.js";
import { useNow } from "./clock.js";

/** The nav panel's id and its URL segment under `/plugins/thread-briefs/`. */
export const BOARD_PANEL_ID = "board";
export const BOARD_PATH = "board";

/** How often ages and the grey treatment are re-tested. See {@link useNow}. */
const TICK_MS = 60_000;

/**
 * Where the view is kept: React state for this session, local storage so
 * reopening the board lands where you left it.
 *
 * **Why not the URL.** The panel's `subPath` was the obvious home — it is what
 * makes a view linkable and hands you browser back between views for free — and
 * it does not survive the round trip. `toPluginPanel` percent-encodes each
 * segment on the way out (`status:done` → `status%3Adone`), and react-router 7
 * hands params back raw: it undoes `%2F` and nothing else. So the view came
 * back as an unparsable string, every filter read as "no filter", and the page
 * looked dead — the chips lit nothing, the rails would not open. A board is a
 * thing you come back to rather than one you send someone, so the linkability
 * was paying for a bug rather than a feature, and this is the whole of what it
 * bought: one line, written on change, read once on mount.
 *
 * Keyed by plugin id because a copy of this plugin published under another name
 * must not share the entry.
 */
const viewStorageKey = (pluginId: string) => `${pluginId}:board-filters`;

function readStoredView(pluginId: string): BoardView {
  try {
    const line = window.localStorage.getItem(viewStorageKey(pluginId));
    return viewFromLine(line ?? "");
  } catch {
    // Storage disabled is a board with no remembered view, not a broken one.
    return EMPTY_VIEW;
  }
}

function storeView(pluginId: string, view: BoardView): void {
  try {
    window.localStorage.setItem(viewStorageKey(pluginId), lineFromView(view));
  } catch {
    // As above: the board stays usable without the memory.
  }
}

// ------------------------------------------------------------------- the data

/**
 * The cards off the wire, joined to the sidebar's live threads.
 *
 * Refetched on `briefs-changed` like every other surface here. A failed fetch
 * keeps the previous cards rather than emptying the board, for the same reason
 * the row glyphs do: a transient error should not look like "you have no work".
 */
function useBoardRows(now: number) {
  const rpc = useRpc<typeof rpcContract>();
  const {
    threads,
    projects,
    status: threadsStatus,
  } = experimental_useSidebarThreads();
  const [cards, setCards] = useState<readonly BriefCard[] | null>(null);
  const [thresholds, setThresholds] = useState({
    staleAfterMs: 0,
    archiveAfterMs: 0,
  });

  const load = useCallback(() => {
    void rpc
      .call("listBriefCards")
      .then((result) => {
        setCards(result.cards);
        setThresholds({
          staleAfterMs: result.staleAfterMs,
          archiveAfterMs: result.archiveAfterMs,
        });
      })
      .catch(() => {
        // Nothing yet becomes nothing-and-settled, so the board says "no
        // briefs" rather than spinning forever on an endpoint that is down.
        setCards((previous) => previous ?? []);
      });
  }, [rpc]);

  useEffect(load, [load]);
  useRealtime(BRIEFS_CHANGED_CHANNEL, load);

  const rows = useMemo(
    () =>
      cards === null
        ? []
        : buildRows({
            threads,
            cards,
            projects,
            now,
            staleAfterMs: thresholds.staleAfterMs,
            archiveAfterMs: thresholds.archiveAfterMs,
          }),
    [cards, now, projects, threads, thresholds],
  );

  return {
    rows,
    projects,
    isLoading: cards === null || threadsStatus === "loading",
    reload: load,
  };
}

// ----------------------------------------------------------------- the filters

function Chip({
  isActive,
  onClick,
  children,
  title,
}: {
  isActive: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={isActive}
      title={title}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
        isActive
          ? "border-border bg-card font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:bg-card"
      }`}
    >
      {children}
    </button>
  );
}

/** A project's hue as a dot, the same colour its threads' rings take. */
function ProjectDot({ projectId }: { projectId: string }) {
  return (
    <span
      aria-hidden
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ background: projectRingColor(projectColorIndex(projectId)) }}
    />
  );
}

/**
 * The filter bar, in the body rather than the host's title bar.
 *
 * `headerContent` was the obvious home and is the wrong one: a multi-project
 * row plus four status chips does not fit a shared title bar, and on a compact
 * viewport it would be the first thing to go. Counts live here too, beside the
 * chips that change them, so a count can never disagree with the board below it.
 */
function FilterBar({
  filters,
  projects,
  rows,
  visible,
  onChange,
}: {
  filters: BoardFilters;
  projects: readonly { id: string; name: string }[];
  rows: readonly BoardRow[];
  visible: number;
  onChange: (filters: BoardFilters) => void;
}) {
  const counts = useMemo(() => {
    const byStatus = new Map<BriefStatus, number>();
    for (const row of rows) {
      if (row.status === null) continue;
      byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    }
    return byStatus;
  }, [rows]);

  // Only projects that actually have a thread on the board, so the bar does not
  // list every project in the install to filter a board none of them appear on.
  const present = useMemo(() => {
    const ids = new Set(
      rows.map((row) => row.project?.id).filter((id): id is string => !!id),
    );
    return projects.filter((project) => ids.has(project.id));
  }, [projects, rows]);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-1">
        <span className="pr-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Status
        </span>
        {FILTERABLE_STATUSES.map((status) => (
          <Chip
            key={status}
            isActive={filters.statuses.includes(status)}
            onClick={() =>
              onChange({
                ...filters,
                statuses: toggleFilterValue(filters.statuses, status),
              })
            }
          >
            {statusLabel(status)}
            <span className="tabular-nums opacity-60">
              {counts.get(status) ?? 0}
            </span>
          </Chip>
        ))}
      </div>

      {present.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="pr-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Project
          </span>
          {present.map((project) => (
            <Chip
              key={project.id}
              isActive={filters.projectIds.includes(project.id)}
              onClick={() =>
                onChange({
                  ...filters,
                  projectIds: toggleFilterValue(filters.projectIds, project.id),
                })
              }
            >
              <ProjectDot projectId={project.id} />
              {project.name === "" ? project.id : project.name}
            </Chip>
          ))}
        </div>
      ) : null}

      <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          {visible === rows.length
            ? `${rows.length} thread${rows.length === 1 ? "" : "s"}`
            : `${visible} of ${rows.length}`}
        </span>
        {isFiltered(filters) ? (
          <button
            type="button"
            onClick={() => onChange(NO_FILTERS)}
            className="rounded border border-border px-1.5 py-0.5 hover:text-foreground"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- the cards

const STATUS_TONE: Record<BriefStatus, string> = {
  working: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "waiting-on-me": "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "waiting-on-other": "bg-slate-500/20 text-slate-700 dark:text-slate-300",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

/**
 * The rest of the brief, fetched only for the card you opened.
 *
 * This is why `listBriefCards` carries `nextStep` and not the other four fields:
 * the card face needs one of them on every card, and the remaining prose is worth
 * a round trip per expansion rather than a payload multiplied by every thread in
 * the install. `getBrief` already answers it, so there is no second endpoint.
 */
function CardDetail({
  threadId,
  now,
  onPickStage,
  onPickStatus,
  onSetBlockReason,
}: {
  threadId: string;
  now: number;
  onPickStage: (stage: BriefStage | null) => void;
  onPickStatus: (status: StoredBriefStatus | null) => void;
  onSetBlockReason: (text: string | null) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<BriefState | null>(null);

  useEffect(() => {
    let live = true;
    void rpc
      .call("getBrief", { threadId })
      .then((result) => {
        if (live) setState(result);
      })
      .catch(() => {
        // The card face already says everything load-bearing; an expansion that
        // could not load says so by staying on "Loading…" rather than throwing
        // away the card around it.
      });
    return () => {
      live = false;
    };
  }, [rpc, threadId]);

  if (state === null || state.state !== "ready") {
    return (
      <div className="border-t border-border pt-1.5 text-[11px] text-muted-foreground">
        {state === null
          ? "Loading…"
          : state.state === "summarizing"
            ? "Summarizing…"
            : "No brief."}
      </div>
    );
  }

  const { brief } = state;
  return (
    <div className="space-y-2 border-t border-border pt-1.5">
      <Field label="Goal" value={brief.goal} />
      <Field label="Current state" value={brief.currentState} />
      <Field label="Constraints" value={brief.constraints} />
      <div className="text-[10px] text-muted-foreground">
        Summarized {summarizedAgo(brief.lastSummarizedAt, now)}
      </div>
      {/*
        The same two controls the Brief panel offers, for the same two writes a
        drag performs. They are the board's touch story: drag-and-drop is a
        pointer affordance, and a phone would otherwise have no way to pin a
        stage at all.
      */}
      <StatusControl
        status={brief.status}
        statusOverride={brief.statusOverride}
        blockReason={brief.blockReason}
        onPick={onPickStatus}
        onSetBlockReason={onSetBlockReason}
      />
      <StageControl
        stage={brief.stage}
        stageOverride={brief.stageOverride}
        onPick={onPickStage}
      />
    </div>
  );
}

function Card({
  row,
  now,
  isExpanded,
  isPending,
  onToggle,
  onDragStart,
  onDragEnd,
  onPickStage,
  onPickStatus,
  onSetBlockReason,
  onSummarize,
}: {
  row: BoardRow;
  now: number;
  isExpanded: boolean;
  isPending: boolean;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onPickStage: (stage: BriefStage | null) => void;
  onPickStatus: (status: StoredBriefStatus | null) => void;
  onSetBlockReason: (text: string | null) => void;
  onSummarize: () => void;
}) {
  const ring = cardRingIcon(row);
  const hint = actorHint(row.card, row.status);
  const age = idleFor(idleMsSince(row.latestAttentionAt, now));

  return (
    <article
      // Only a card with a brief can be dragged, because only a brief has the
      // overrides a drop writes. A briefless card offers Summarize instead.
      draggable={row.card !== null}
      onDragStart={(event) => {
        // The payload is read back by nothing — the page holds the dragged row
        // in state — but a drag with no data is refused outright by some
        // browsers, so the thread id goes in as the honest minimum.
        event.dataTransfer.setData("text/plain", row.threadId);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`space-y-1 rounded-lg border border-border bg-card p-2 ${
        isPending ? "opacity-50" : ""
      } ${row.stale !== null ? "text-muted-foreground" : ""}`}
    >
      <div className="flex items-start gap-1.5">
        {ring === null ? null : (
          <Icon name={ring} className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        {/*
          An anchor on bb's own href, so a plain click routes in place and
          middle-click, copy-link and open-in-new-window work with no code here.
        */}
        <a
          href={row.href}
          className="min-w-0 flex-1 text-xs font-medium leading-snug text-foreground hover:underline"
        >
          {row.title}
        </a>
        {row.isPinned ? (
          <Icon
            name="Pin"
            className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground"
            aria-label="Pinned thread"
          />
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "Hide the brief" : "Show the whole brief"}
          className="-mr-0.5 -mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <Icon
            name={isExpanded ? "ChevronUp" : "ChevronDown"}
            className="h-3.5 w-3.5"
            aria-hidden
          />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {row.status === null ? null : (
          <span
            className={`rounded px-1 py-px text-[10px] font-medium ${STATUS_TONE[row.status]}`}
          >
            {statusLabel(row.status)}
          </span>
        )}
        {hint === null ? null : (
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        )}
        {isPinnedByHand(row.card) ? (
          <span
            title="Pinned by hand · clears on the next turn"
            className="text-[10px] text-muted-foreground"
          >
            · pinned
          </span>
        ) : null}
      </div>

      {/*
        `nextStep` is the card's body rather than `goal`, because the board's
        question is which thread to pick up rather than what a thread was for.
        Goal is one chevron away, where it answers the other question.
      */}
      {row.card === null ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] leading-snug text-muted-foreground">
            Never summarized — briefs are not backfilled.
          </p>
          <button
            type="button"
            onClick={onSummarize}
            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            Summarize
          </button>
        </div>
      ) : row.card.nextStep.trim() === "" ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Nothing outstanding.
        </p>
      ) : (
        <p className="text-[11px] leading-snug text-foreground/80">
          {row.card.nextStep}
        </p>
      )}

      {row.card !== null && row.card.blockedOn.trim() !== "" ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Blocked on {row.card.blockedOn}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
        {row.project === null ? null : (
          <>
            {row.stale === null ? (
              <ProjectDot projectId={row.project.id} />
            ) : (
              // A cold done card gives its project colour up, the same trade the
              // sidebar ring makes: colour here means a live project, and a
              // thread on its way out of the sidebar has no use for it.
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: STALE_DONE_RING_COLOR }}
              />
            )}
            <span className="truncate">{row.project.name}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span>idle {age}</span>
        {row.stale?.archiving === true ? (
          <span className="italic">· archiving soon</span>
        ) : null}
      </div>

      {isExpanded ? (
        <CardDetail
          threadId={row.threadId}
          now={now}
          onPickStage={onPickStage}
          onPickStatus={onPickStatus}
          onSetBlockReason={onSetBlockReason}
        />
      ) : null}
    </article>
  );
}

// ----------------------------------------------------------------- the columns

/**
 * A collapsed column: the label and the count, turned on its side.
 *
 * Vertical only from `sm` up, where the board is columns side by side and a rail
 * has to be narrow to be worth collapsing. On a phone the board is already
 * stacked sections down the page, so the rail is a full-width strip with the
 * label the right way up — the same element and the same handlers, one utility
 * apart, rather than a second layout to keep in step.
 */
function CollapsedRail({
  column,
  count,
  canToggle,
  onToggle,
}: {
  column: BoardColumn;
  count: number;
  canToggle: boolean;
  onToggle: () => void;
}) {
  const label = BOARD_COLUMN_LABELS[column];
  const body = (
    <>
      <span className="text-[11px] font-semibold uppercase tracking-wide sm:[writing-mode:vertical-rl]">
        {label}
      </span>
      <span className="text-[11px] tabular-nums opacity-70">{count}</span>
    </>
  );
  const shape =
    "flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-muted-foreground sm:h-full sm:w-full sm:flex-col sm:justify-start sm:py-2";

  return canToggle ? (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={false}
      aria-label={`Show the ${label} column`}
      className={`${shape} hover:bg-card hover:text-foreground`}
    >
      {body}
      <Icon
        name="ChevronRight"
        className="ml-auto h-3.5 w-3.5 shrink-0 sm:ml-0 sm:mt-1"
        aria-hidden
      />
    </button>
  ) : (
    <div
      className={shape}
      title={
        column === NO_STAGE_COLUMN
          ? "Every thread here has a stage."
          : `${label} · ${count}`
      }
    >
      {body}
    </div>
  );
}

function Column({
  column,
  rows,
  now,
  isCollapsed,
  canToggle,
  onToggleCollapsed,
  isDropTarget,
  isOver,
  expandedId,
  pending,
  onToggle,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onPickStage,
  onPickStatus,
  onSetBlockReason,
  onSummarize,
}: {
  column: BoardColumn;
  rows: readonly BoardRow[];
  now: number;
  isCollapsed: boolean;
  canToggle: boolean;
  onToggleCollapsed: () => void;
  isDropTarget: boolean;
  isOver: boolean;
  expandedId: string | null;
  pending: ReadonlySet<string>;
  onToggle: (threadId: string) => void;
  onDragStart: (row: BoardRow) => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onPickStage: (row: BoardRow, stage: BriefStage | null) => void;
  onPickStatus: (row: BoardRow, status: StoredBriefStatus | null) => void;
  onSetBlockReason: (row: BoardRow, text: string | null) => void;
  onSummarize: (row: BoardRow) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, COLUMN_CAP);

  return (
    <section
      aria-label={BOARD_COLUMN_LABELS[column]}
      onDragOver={(event) => {
        if (!isDropTarget) return;
        // Preventing the default is what makes this element a drop target at
        // all; without it the browser refuses the drop silently.
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDrop={(event) => {
        if (!isDropTarget) return;
        event.preventDefault();
        onDrop();
      }}
      className={`flex flex-col rounded-lg ${
        isCollapsed
          ? // A rail wide enough to read, and wider while a card is in the air:
            // 2.5rem is a poor target to aim a drop at, and Done is the one
            // column you drag to on purpose.
            `sm:shrink-0 ${isDropTarget ? "border border-dashed border-border sm:w-20" : "sm:w-10"}`
          : isStageColumn(column)
            ? // The stages take the width the rails gave up, rather than the
              // fixed 18rem that used to push them off the side of the viewport.
              "sm:min-w-60 sm:max-w-88 sm:flex-1"
            : "sm:w-72 sm:shrink-0"
      } ${isOver ? "bg-foreground/[0.06]" : ""}`}
    >
      {isCollapsed ? (
        <CollapsedRail
          column={column}
          count={rows.length}
          canToggle={canToggle}
          onToggle={onToggleCollapsed}
        />
      ) : (
        <>
      <header className="sticky top-0 z-10 flex items-baseline gap-1.5 bg-background/95 px-1 pb-1.5 pt-0.5 backdrop-blur">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
          {BOARD_COLUMN_LABELS[column]}
        </h2>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {rows.length}
        </span>
        {canToggle ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded
            aria-label={`Hide the ${BOARD_COLUMN_LABELS[column]} column`}
            className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <Icon name="ChevronLeft" className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </header>
      <div className="flex flex-col gap-1.5 px-1 pb-2">
        {rows.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {column === NO_STAGE_COLUMN
              ? "Every thread here has a stage."
              : "Nothing here."}
          </p>
        ) : null}
        {shown.map((row) => (
          <Card
            key={row.threadId}
            row={row}
            now={now}
            isExpanded={expandedId === row.threadId}
            isPending={pending.has(row.threadId)}
            onToggle={() => onToggle(row.threadId)}
            onDragStart={() => onDragStart(row)}
            onDragEnd={onDragEnd}
            onPickStage={(stage) => onPickStage(row, stage)}
            onPickStatus={(status) => onPickStatus(row, status)}
            onSetBlockReason={(text) => onSetBlockReason(row, text)}
            onSummarize={() => onSummarize(row)}
          />
        ))}
        {shown.length < rows.length ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Show all {rows.length}
          </button>
        ) : null}
      </div>
        </>
      )}
    </section>
  );
}

// -------------------------------------------------------------------- the page

export function BoardPage() {
  const rpc = useRpc<typeof rpcContract>();
  const pluginId = experimental_usePluginId();
  const now = useNow(TICK_MS);
  const { rows, projects, isLoading, reload } = useBoardRows(now);

  // Read once, on mount: nothing else in this window writes the entry, and a
  // board that re-read storage would be answering a question nobody asked.
  const [view, setStoredView] = useState<BoardView>(() =>
    readStoredView(pluginId),
  );
  const { filters } = view;

  const setView = useCallback(
    (next: BoardView) => {
      storeView(pluginId, next);
      setStoredView(next);
    },
    [pluginId],
  );

  // Changing a filter leaves the rails where they were: the two are independent
  // readings of the same board, and clearing a filter is not a request to close
  // Done again.
  const setFilters = useCallback(
    (next: BoardFilters) => setView({ filters: next, expanded: view.expanded }),
    [setView, view.expanded],
  );

  const toggleCollapsed = useCallback(
    (column: BoardColumn) =>
      setView({
        filters: view.filters,
        expanded: toggleFilterValue(view.expanded, column),
      }),
    [setView, view.expanded, view.filters],
  );

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<BoardRow | null>(null);
  const [over, setOver] = useState<BoardColumn | null>(null);
  /** Threads with a write in flight, drawn faded until realtime settles them. */
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const visible = useMemo(
    () => rows.filter((row) => matchesFilters(row, filters)),
    [filters, rows],
  );
  const columns = useMemo(
    () => layOutColumns({ rows: visible, filters, expanded: view.expanded }),
    [filters, view.expanded, visible],
  );

  /** Write the user's block reason; realtime redraws the card. */
  const setBlockReason = useCallback(
    async (row: BoardRow, text: string | null) => {
      setPending((previous) => new Set(previous).add(row.threadId));
      try {
        await rpc.call("setBlockReason", { threadId: row.threadId, text });
      } catch {
        // Same recovery as a drop: the server's state is what gets drawn.
      } finally {
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(row.threadId);
          return next;
        });
      }
    },
    [rpc],
  );

  /**
   * Apply a plan, then let realtime redraw.
   *
   * The card is faded rather than moved optimistically: a pin can be refused —
   * the thread's brief may have been deleted, or a summary may have landed
   * between the drag and the drop — and a card that moved and then moved back is
   * a worse lie than one that took a moment to move.
   */
  const applyDrops = useCallback(
    async (row: BoardRow, drops: readonly BoardDrop[]) => {
      if (drops.length === 0) return;
      setPending((previous) => new Set(previous).add(row.threadId));
      try {
        // In order, and awaited: a drag out of Done writes the status first and
        // the stage second, and the two must not race to `writeBrief`.
        for (const drop of drops) {
          if (drop.kind === "stage") {
            await rpc.call("setStageOverride", {
              threadId: row.threadId,
              stage: drop.stage,
            });
          } else {
            await rpc.call("setStatusOverride", {
              threadId: row.threadId,
              status: drop.status,
            });
          }
        }
      } catch {
        // The realtime reload below is the recovery: whatever the server
        // actually holds is what the board ends up drawing.
      } finally {
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(row.threadId);
          return next;
        });
        reload();
      }
    },
    [reload, rpc],
  );

  const onDrop = useCallback(
    (column: BoardColumn) => {
      const row = dragging;
      setDragging(null);
      setOver(null);
      if (row === null) return;
      void applyDrops(row, planDrop(row, column));
    },
    [applyDrops, dragging],
  );

  const onSummarize = useCallback(
    (row: BoardRow) => {
      void rpc.call("refresh", { threadId: row.threadId }).catch(() => {
        // Nothing to undo: the queue either took it or it did not, and the next
        // brief to arrive says which.
      });
    },
    [rpc],
  );

  if (isLoading && rows.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">Loading briefs…</div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar
        filters={filters}
        projects={projects}
        rows={rows}
        visible={visible.length}
        onChange={setFilters}
      />
      {/*
        Columns side by side on a real viewport and stacked on a phone, from one
        flex direction rather than a second layout: the column headers become
        section headings and the whole page scrolls vertically, with the same
        cards and the same data path. Drag-and-drop simply does not engage on
        touch, which is why the expanded card carries the pin controls.
      */}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <div className="flex min-h-full flex-col gap-3 sm:flex-row sm:gap-2">
          {columns.map(({ column, rows: columnRows, isCollapsed, canToggle }) => (
            <Column
              key={column}
              column={column}
              rows={columnRows}
              now={now}
              isCollapsed={isCollapsed}
              canToggle={canToggle}
              onToggleCollapsed={() => toggleCollapsed(column)}
              isDropTarget={
                dragging !== null &&
                planDrop(dragging, column).length > 0 &&
                (isStageColumn(column) || column === DONE_COLUMN)
              }
              isOver={over === column}
              expandedId={expandedId}
              pending={pending}
              onToggle={(threadId) =>
                setExpandedId((previous) =>
                  previous === threadId ? null : threadId,
                )
              }
              onDragStart={setDragging}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={() => setOver(column)}
              onDrop={() => onDrop(column)}
              onPickStage={(row, stage) =>
                void applyDrops(row, [{ kind: "stage", stage }])
              }
              onPickStatus={(row, status) =>
                void applyDrops(row, [{ kind: "status", status }])
              }
              onSetBlockReason={(row, text) => void setBlockReason(row, text)}
              onSummarize={onSummarize}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
