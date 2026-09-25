// bb-plugin-workstreams — frontend entry.
//
// Three views of one fetch: the Map (map.tsx), a spatial picture of the grouping
// hierarchy, and two Boards (inbox.tsx), inboxes of checkouts ordered by the
// next action each needs. Everything either shows comes from
// board_get; the server publishes "board-changed" after each scan and the board
// refetches. Nothing here computes a count or a sentence — the server already
// did, so the board and the CLI can never disagree.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_useAppPanel,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Board, Prefs, WireGroup, WireRun, rpcContract } from "./server";
import { badgeValue } from "./runs";
import { groupChildren, relativeTime, type Lens, type Lifecycle } from "./workstreams";
import { HOW_TAB, HowThisWorks } from "./howto";
import { EASE_CSS } from "./layout";
import { MapView } from "./map";
import { InboxBoard } from "./inbox";
import { Icon } from "@/components/ui/icon";
import { Tip } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { POINTER_CURSORS, cn } from "@/lib/utils";
import { readLastView, storeLastView, viewFromSubPath, type ViewId } from "./view-preference";

export type Group = WireGroup;
export type Cluster = Group["clusters"][number];
export type Unit = Cluster["units"][number];

/** Restraint on purpose: color carries lifecycle meaning and nothing else. */
export const TONE: Record<Lifecycle, { dot: string; label: string }> = {
  blocked: { dot: "bg-destructive", label: "Blocked" },
  "awaiting-followup": { dot: "bg-orange-500", label: "Needs your changes" },
  "approved-with-comments": { dot: "bg-yellow-500", label: "Approved, comments open" },
  "awaiting-merge": { dot: "bg-emerald-500", label: "Ready to merge" },
  "awaiting-review": { dot: "bg-amber-500", label: "Awaiting review" },
  active: { dot: "bg-sky-400", label: "Being edited" },
  "in-progress": { dot: "bg-sky-600", label: "In progress" },
  unverified: { dot: "bg-amber-400", label: "Status unverified" },
  "up-next": { dot: "bg-muted-foreground/50", label: "Up next" },
  shipped: { dot: "bg-teal-500", label: "Release tagged" },
  merged: { dot: "bg-violet-500", label: "Merged" },
  closed: { dot: "bg-muted-foreground/40", label: "Closed" },
};

export const LENS_LABEL: Record<Lens, string> = {
  all: "All",
  active: "Active",
  waiting: "Waiting",
  done: "Done",
};

function useBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("board_get").then(
      (next) => {
        setBoard(next);
        setError(null);
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("board-changed", refetch);
  return { rpc, board, error, refetch };
}

const DEFAULT_PREFS: Prefs = { lens: "all", staleness: [], surfaces: [], colorBy: "status", face: "theme", showClones: false };

/**
 * The lens, persisted server-side in plugin kv so it survives a reload. Applied
 * optimistically: the control has to answer the click, and a lens is a view
 * preference rather than a fact that can fail to save.
 */
function usePrefs() {
  const rpc = useRpc<typeof rpcContract>();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  useEffect(() => {
    let live = true;
    rpc.call("prefs_get").then(
      (next) => {
        if (live) setPrefs(next);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [rpc]);
  const update = useCallback(
    (patch: Partial<Prefs>) => {
      setPrefs((current) => {
        const next = { ...current, ...patch };
        void rpc.call("prefs_set", next).catch(() => {});
        return next;
      });
    },
    [rpc],
  );
  return { prefs, update };
}

/**
 * Rebuild the tree the flat wire list encodes. The server decided which levels
 * survived the collapse, so the renderer reads the shape rather than assuming
 * one — a board that collapsed to efforts alone renders identically to v3.
 */
export function useTree(board: Board | null) {
  return useMemo(() => {
    const groups = board?.groups ?? [];
    const byParent = groupChildren(groups);
    return {
      groups,
      roots: byParent.get(null) ?? [],
      childrenOf: (key: string) => byParent.get(key) ?? [],
    };
  }, [board]);
}

/**
 * Keep each stack's members adjacent and in merge order, so the column reads
 * bottom-to-top the way the stack actually merges. Unstacked units keep the
 * server's recency order.
 */
export function stackOrder(units: Unit[]): Unit[] {
  return [...units].sort((a, b) => {
    const left = a.stack;
    const right = b.stack;
    if (left !== null && right !== null && left.id === right.id) {
      return left.position - right.position;
    }
    return (left?.id ?? "").localeCompare(right?.id ?? "");
  });
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

/**
 * "<repo>: no release tags found; …" is a permanent property of a repo, not an
 * event, so it folds into one line. Everything else — an auth failure, a scan
 * that died — is real news and stays listed on its own.
 */
const NO_RELEASE_TAGS = /^(.+?): no release tags found/;

function groupWarnings(warnings: readonly string[]): string[] {
  const untagged = warnings.filter((warning) => NO_RELEASE_TAGS.test(warning));
  const rest = warnings.filter((warning) => !NO_RELEASE_TAGS.test(warning));
  if (untagged.length === 0) return rest;
  const summary =
    untagged.length === 1
      ? `${NO_RELEASE_TAGS.exec(untagged[0]!)?.[1] ?? "One repo"} has no release tags — merged work there stays labeled Merged.`
      : `${untagged.length} repos have no release tags — merged work there stays labeled Merged.`;
  return [...rest, summary];
}

/**
 * Warnings as one small indicator rather than a banner above the map: the
 * count says something is there, a click says what.
 */
function Warnings({ warnings }: { warnings: string[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lines = useMemo(() => groupWarnings(warnings), [warnings]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  if (lines.length === 0) return null;
  return (
    <div ref={rootRef} className="relative shrink-0">
      <Tip label={`Show ${lines.length} ${lines.length === 1 ? "notice" : "notices"} from the last scan`}>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Show ${lines.length} ${lines.length === 1 ? "notice" : "notices"} from the last scan`}
          onClick={() => setOpen((current) => !current)}
          className="flex h-7 items-center gap-1 rounded-full px-2 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Icon name="AlertTriangle" className="size-3.5" />
          {lines.length}
        </button>
      </Tip>
      {open ? (
        <div
          role="status"
          className="absolute right-0 top-8 z-20 w-96 max-w-[80vw] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <ul className="max-h-72 space-y-2 overflow-y-auto text-xs leading-relaxed">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page: one fetch, three views of it.
// ---------------------------------------------------------------------------

/**
 * Each view has an explicit path so panel history keeps walking with browser
 * back and forward. The panel root redirects to the last view opened here.
 */
const VIEWS = [
  { id: "map", title: "Map", icon: "GridView" },
  { id: "board", title: "Board", icon: "Columns2" },
  { id: "board-v2", title: "Board v2", icon: "Columns2" },
] as const;

/** Typing in a field is never a view switch. */
function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null)
  );
}

/**
 * The views crossfade: the outgoing one fades and settles back a hair, the
 * incoming one rises into place. Transform and opacity only, on the page's one
 * easing; reduced motion swaps instantly. No shared-element morph — a circle
 * and a table row are not the same shape, and pretending costs more than it says.
 */
function ViewLayer({ leaving, children }: { leaving: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (reduced()) return;
    ref.current?.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 320, easing: EASE_CSS, fill: "backwards" },
    );
  }, []);
  useEffect(() => {
    if (!leaving || reduced()) return;
    ref.current?.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-3px) scale(0.995)" },
      ],
      { duration: 220, easing: EASE_CSS, fill: "forwards" },
    );
  }, [leaving]);
  return (
    <div
      ref={ref}
      aria-hidden={leaving || undefined}
      className={cn("absolute inset-0 flex min-h-0 flex-col", leaving && "pointer-events-none")}
    >
      {children}
    </div>
  );
}

function WorkstreamsPage({ subPath }: { subPath: string }) {
  const { rpc, board, error, refetch } = useBoard();
  const { prefs, update } = usePrefs();
  const navigate = useBbNavigate();
  const explicitView = viewFromSubPath(subPath);
  const view = explicitView ?? readLastView();
  useEffect(() => {
    if (explicitView === null) {
      navigate.toPluginPanel("board", { subPath: view, replace: true });
    } else {
      storeLastView(explicitView);
    }
  }, [explicitView, navigate, view]);
  const now = useNow(30_000);
  const panel = experimental_useAppPanel();
  const openHow = useCallback(() => {
    if (!panel.openFixedTab({ surface: { kind: "current" }, tab: HOW_TAB })) {
      toast.error("Could not open How this works", { description: "Open BB's right panel and choose its How this works tab." });
    }
  }, [panel]);
  // The selection all views share: a cluster focused on the Map is the
  // row either Board opens on, and the circle the Map flies back to.
  const [focusTicket, setFocusTicket] = useState<string | null>(null);

  const [leaving, setLeaving] = useState<ViewId | null>(null);
  const shownRef = useRef<ViewId>(view);
  useEffect(() => {
    if (shownRef.current === view) return;
    setLeaving(shownRef.current);
    shownRef.current = view;
    const timer = window.setTimeout(() => setLeaving(null), 240);
    return () => window.clearTimeout(timer);
  }, [view]);

  // `V` toggles Map and Board from anywhere on the page. The Map's own keys are
  // + − 0 Esc Backspace and the arrows, and Tab stays focus navigation.
  // `?` opens How this works from any view.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "v" && event.key !== "V" && event.key !== "?") return;
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
      event.preventDefault();
      if (event.key === "?") openHow();
      else navigate.toPluginPanel("board", { subPath: view === "map" ? "board" : "map" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, openHow, view]);

  const render = (id: ViewId) =>
    id !== "map" ? (
      board === null ? (
        <div className="p-4">
          <Notice>Loading the board…</Notice>
        </div>
      ) : (
        <InboxBoard
          dispatchControls={id === "board-v2"}
          board={board}
          prefs={prefs}
          onPrefs={update}
          focusTicket={focusTicket}
          onFocusTicket={setFocusTicket}
          onShowOnMap={() => navigate.toPluginPanel("board", { subPath: "map" })}
        />
      )
    ) : (
      <MapView
        board={board}
        prefs={prefs}
        onPrefs={update}
        selected={focusTicket}
        onSelect={setFocusTicket}
      />
    );

  return (
    <div className={cn("flex h-full min-h-0 flex-1 flex-col", POINTER_CURSORS)}>
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border/60 px-3">
        {/* Three views share one fetch. */}
        <div role="tablist" aria-label="Workstreams views" className="flex shrink-0 items-center gap-3">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={view === entry.id}
              title={entry.id === "board-v2" ? entry.title : `${entry.title} (V toggles)`}
              onClick={() => navigate.toPluginPanel("board", { subPath: entry.id })}
              className={cn(
                "text-xs transition-colors duration-150",
                view === entry.id
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.title}
            </button>
          ))}
        </div>
        {board === null ? (
          <p className="truncate text-[11px] text-muted-foreground">Loading…</p>
        ) : (
          <Tip label={board.lastScanAt === null ? "No scan has finished yet" : `Last scan: ${new Date(board.lastScanAt).toLocaleString()}`}>
            <p tabIndex={0} className="truncate text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {board.lastScanAt === null ? "Never scanned" : `scanned ${relativeTime(board.lastScanAt, now)}`}
            </p>
          </Tip>
        )}
        <span className="flex-1" />
        <Tip label={board?.scanning === true ? "A scan is running" : "Rescan every checkout now"}>
          <button
            type="button"
            disabled={board?.scanning === true}
            aria-label={board?.scanning === true ? "A scan is running" : "Rescan every checkout now"}
            onClick={() => {
              rpc.call("board_refresh").then(refetch, refetch);
            }}
            className="flex h-7 items-center gap-1.5 rounded-full px-2 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-60"
          >
            <Icon
              name={board?.scanning === true ? "Loading" : "ArrowReloadHorizontal"}
              className={cn("size-3.5", board?.scanning === true && "animate-spin")}
            />
            {board?.scanning === true ? "Scanning…" : "Rescan"}
          </button>
        </Tip>
        {board === null ? null : <Warnings warnings={board.warnings} />}
        <Tip label="How this works (?)">
          <button
            type="button"
            aria-label="How this works (?)"
            onClick={openHow}
            className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <Icon name="Info" className="size-4" />
          </button>
        </Tip>
      </header>

      {error === null ? null : (
        <p role="alert" className="shrink-0 px-3 pt-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {VIEWS.map((entry) =>
          entry.id === view || entry.id === leaving ? (
            <ViewLayer key={entry.id} leaving={entry.id !== view}>
              {render(entry.id)}
            </ViewLayer>
          ) : null,
        )}
      </div>
    </div>
  );
}

/** A clock that ticks every `ms`, for relative times that must not go stale on screen. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/** The How this works fixed tab: its own board read, so it stays current while open. */
function HowThisWorksTab() {
  const { board } = useBoard();
  const now = useNow(30_000);
  return (
    <div className={POINTER_CURSORS}>
      <HowThisWorks board={board} now={now} />
    </div>
  );
}

/**
 * The count beside "Workstreams" in BB's sidebar: agents waiting on you first
 * (rose), else agents running. Nothing at zero. Refetches on the same signal
 * the Board does, so it never polls.
 */
function RunsBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState<WireRun[]>([]);
  const refetch = useCallback(() => {
    rpc.call("runs_open").then(setOpen, () => {});
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("board-changed", refetch);
  const badge = badgeValue(open);
  if (badge === null) return null;
  const label = badge.needsYou
    ? `${badge.count} ${badge.count === 1 ? "agent needs" : "agents need"} you`
    : `${badge.count} ${badge.count === 1 ? "agent" : "agents"} running`;
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        "rounded-full px-1.5 font-mono text-[10.5px] leading-4 tabular-nums",
        badge.needsYou ? "bg-rose-500/15 text-rose-700 dark:text-rose-300" : "bg-foreground/[0.07] text-muted-foreground",
      )}
    >
      {badge.count}
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Workstreams",
    icon: "Columns2",
    path: "board",
    component: WorkstreamsPage,
    fixedTabs: [{ ...HOW_TAB, title: "How this works", icon: "Info", component: HowThisWorksTab, layout: "padded" }],
    experimental_sidebarAccessory: RunsBadge,
  });
});
