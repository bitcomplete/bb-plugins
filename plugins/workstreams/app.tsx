// bb-plugin-workstreams — frontend entry.
//
// The effort deck and All PRs lead; the Map (map.tsx), a spatial picture of the grouping hierarchy, and Efforts admin sit
// behind More. The Map reads board_get; the server publishes "board-changed" after each scan and the board
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
import { EffortsView } from "./efforts-view";
import { countApprovedOpenPrs } from "./approval-filter";
import { Icon } from "@/components/ui/icon";
import { Tip } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { POINTER_CURSORS, cn } from "@/lib/utils";
import { inventoryRoute, deckRoute, readLastView, storeLastView, viewFromSubPath, type ViewId } from "./view-preference";
import { ThreadEffortControl } from "./thread-effort-control";
import { InventoryNavView, useInventory } from "./inventory-screen";
import { yourTurnRows } from "./inventory-view-model";
import { DeckNavView } from "./deck-nav-view";
import { PaletteBody, viewPaletteItems, WorkstreamsHeader, type HeaderProps, type HeaderTarget } from "./deck-screen";
import { DeckDialog } from "./deck-flow";
import { paletteMatch, type PaletteItem } from "./deck-view-model";

export type Group = WireGroup;
export type Cluster = Group["clusters"][number];
export type Unit = Cluster["units"][number];

/** Restraint on purpose: color carries lifecycle meaning and nothing else. */
export const TONE: Record<Lifecycle, { dot: string; label: string }> = {
  blocked: { dot: "bg-destructive", label: "Blocked" },
  "awaiting-followup": { dot: "bg-orange-500", label: "Needs your changes" },
  "awaiting-rereview": { dot: "bg-amber-500", label: "Awaiting re-review" },
  "approved-with-comments": { dot: "bg-yellow-500", label: "Approved, comments open" },
  "approved-with-note": { dot: "bg-yellow-500", label: "Review approval note" },
  "awaiting-merge": { dot: "bg-emerald-500", label: "Ready to merge" },
  "awaiting-review": { dot: "bg-amber-500", label: "Awaiting review" },
  active: { dot: "bg-sky-400", label: "Being edited" },
  "in-progress": { dot: "bg-sky-600", label: "In progress" },
  unverified: { dot: "bg-amber-400", label: "Status unverified" },
  "up-next": { dot: "bg-muted-foreground/50", label: "Up next" },
  shipped: { dot: "bg-teal-500", label: "In release tag" },
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

const DEFAULT_PREFS: Prefs = { lens: "all", staleness: [], surfaces: [], colorBy: "status", face: "theme", showClones: false, approvedOnly: false };

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
// The page: one fetch, three primary views of it.
// ---------------------------------------------------------------------------

/**
 * Each view has an explicit path so panel history keeps walking with browser
 * back and forward. The panel root redirects to the last view opened here.
 * `V` cycles these outside the deck and All PRs.
 */
const CYCLE: readonly ViewId[] = ["deck", "inventory", "map", "efforts"];

/** How fresh the board is, as the shared header says it on the views that read it. */
function boardRead(board: Board | null, now: number): HeaderProps["read"] {
  if (board === null) return { text: "Loading…", error: null };
  return { error: null, text: `${board.lastScanAt === null ? "Not scanned" : `Scanned ${relativeTime(board.lastScanAt, now)}`} · ${board.lastPrCheckedAt === null
    ? "GitHub not checked" : `GitHub ${relativeTime(board.lastPrCheckedAt, now)}`}`,
  title: `Checkouts: ${board.lastScanAt === null ? "no scan yet" : new Date(board.lastScanAt).toLocaleString()}. GitHub PRs: ${board.lastPrCheckedAt === null
    ? "no check yet" : new Date(board.lastPrCheckedAt).toLocaleString()}.` };
}

/** ⌘K on a view with no actions palette of its own: go to any view, or How this works. */
function ViewsPalette({ open, view, onClose, onPick }: { open: boolean; view: HeaderProps["view"]; onClose(): void; onPick(target: HeaderTarget): void }) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  }, [open]);
  const items = paletteMatch(viewPaletteItems(view), query);
  const live = items.filter((item) => item.on);
  const pick = (item: PaletteItem) => { onClose(); onPick(item.key as HeaderTarget); };
  return <DeckDialog open={open} title="Go to" bare onClose={onClose} onReturn={() => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); }}>
    {open ? <div onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((current) => Math.max(0, Math.min(live.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))));
      } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); const item = live[highlight]; if (item) pick(item); }
      else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); onClose(); }
    }}><PaletteBody query={query} items={items} highlight={highlight} onQuery={(next) => { setQuery(next); setHighlight(0); }} onRun={pick} onHighlight={setHighlight} /></div>
      : null}
  </DeckDialog>;
}

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
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === "visible") void rpc.call("pr_poll", null).catch(() => {});
    };
    poll();
    document.addEventListener("visibilitychange", poll);
    const timer = window.setInterval(poll, 45_000);
    return () => {
      document.removeEventListener("visibilitychange", poll);
      window.clearInterval(timer);
    };
  }, [rpc]);
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
  const approvedCount = useMemo(() => {
    if (board === null) return 0;
    return countApprovedOpenPrs(board.groups.flatMap((group) => group.clusters.flatMap((cluster) => cluster.units.map((unit) => unit.pr))));
  }, [board]);
  const now = useNow(30_000);
  const panel = experimental_useAppPanel();
  const openHow = useCallback(() => {
    if (!panel.openFixedTab({ surface: { kind: "current" }, tab: HOW_TAB })) {
      toast.error("Could not open How this works", { description: "Open BB's right panel and choose its How this works tab." });
    }
  }, [panel]);
  // The cluster focused on the Map, kept while another view shows so the Map flies back to it.
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

  const go = useCallback((target: HeaderTarget) => {
    if (target === "how") openHow();
    else navigate.toPluginPanel("board", { subPath: target });
  }, [navigate, openHow]);
  const [palette, setPalette] = useState(false);
  const pageRef = useRef<HTMLDivElement | null>(null);

  // `V` cycles the views from anywhere on the page. The Map's own keys are
  // + − 0 Esc Backspace and the arrows, and Tab stays focus navigation.
  // `?` opens How this works from any view, and ⌘K the Go to palette. The effort deck and All PRs own their keys, ⌘K and `?` included.
  useEffect(() => {
    if (view === "deck" || view === "inventory") return;
    const onKey = (event: KeyboardEvent) => {
      const active = document.activeElement;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        if (active && active !== document.body && !pageRef.current?.contains(active)) return;
        event.preventDefault();
        setPalette(true);
        return;
      }
      if (event.key !== "v" && event.key !== "V" && event.key !== "?") return;
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target) || (event.target instanceof HTMLElement && event.target.closest("[role=dialog], [role=menu], [role=combobox]"))) return;
      event.preventDefault();
      if (event.key === "?") openHow();
      else navigate.toPluginPanel("board", { subPath: CYCLE[(CYCLE.indexOf(view) + 1) % CYCLE.length]! });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, openHow, view]);

  const read = boardRead(board, now);
  const header = (id: Exclude<ViewId, "deck" | "inventory">, tools?: ReactNode) => <WorkstreamsHeader view={id} read={read} palette="go to" help="How this works"
    tools={tools} onView={go} onPalette={() => setPalette(true)} onHelp={openHow} />;
  // The Map keeps its Approved filter, Rescan, and scan notices beside More.
  const boardTools = <>
    <Tip label="Approved open PRs with scanned checkouts on the Map. Approval can still need comment, check, or branch work.">
      <button type="button" aria-pressed={prefs.approvedOnly} disabled={board === null} onClick={() => update({ approvedOnly: !prefs.approvedOnly })}
        className={cn("shrink-0 rounded-md border px-2 py-1 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", prefs.approvedOnly ? "border-ring/50 bg-foreground/[0.08]" : "border-border text-muted-foreground")}>Approved {approvedCount}</button>
    </Tip>
    <Tip label={board?.scanning === true ? "A scan is running" : "Rescan every checkout now"}>
      <button
        type="button"
        disabled={board?.scanning === true}
        aria-label={board?.scanning === true ? "A scan is running" : "Rescan every checkout now"}
        onClick={() => {
          rpc.call("board_refresh").then(refetch, refetch);
        }}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-60"
      >
        <Icon
          name={board?.scanning === true ? "Loading" : "ArrowReloadHorizontal"}
          className={cn("size-3.5", board?.scanning === true && "animate-spin")}
        />
        {board?.scanning === true ? "Scanning…" : "Rescan"}
      </button>
    </Tip>
    {board === null ? null : <Warnings warnings={board.warnings} />}
  </>;

  const render = (id: ViewId) =>
    id === "deck" ? (
      <DeckNavView openCard={deckRoute(subPath)} onView={go} />
    ) : id === "inventory" ? (
      <InventoryNavView onView={go} openPr={inventoryRoute(subPath)} />
    ) : id === "efforts" ? (
      <>{header("efforts")}<EffortsView board={board} /></>
    ) : (
      <>{header("map", boardTools)}<MapView
        board={board}
        prefs={prefs}
        onPrefs={update}
        selected={focusTicket}
        onSelect={setFocusTicket}
      /></>
    );

  return (
    <div ref={pageRef} className={cn("flex h-full min-h-0 flex-1 flex-col", POINTER_CURSORS)}>
      {error === null ? null : (
        <p role="alert" className="shrink-0 px-3 pt-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {(["deck", "inventory", "map", "efforts"] as const).map((id) =>
          id === view || id === leaving ? (
            <ViewLayer key={id} leaving={id !== view}>
              {render(id)}
            </ViewLayer>
          ) : null,
        )}
      </div>
      <ViewsPalette open={palette} view={view} onClose={() => setPalette(false)} onPick={go} />
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
 * The counts beside "Workstreams" in BB's sidebar: agents waiting on you first
 * (rose), else agents running, nothing at zero; then, in violet, your PRs
 * where it's your turn, as All PRs lists them. Each refetches on the signals
 * its view does, so neither polls.
 */
function RunsBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState<WireRun[]>([]);
  const refetch = useCallback(() => {
    rpc.call("runs_open").then(setOpen, () => {});
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("board-changed", refetch);
  const { view } = useInventory();
  const turn = view ? yourTurnRows(view, Date.now()).length : null;
  const badge = badgeValue(open);
  if (badge === null && turn === null) return null;
  const label = badge?.needsYou
    ? `${badge.count} ${badge.count === 1 ? "agent needs" : "agents need"} you`
    : badge ? `${badge.count} ${badge.count === 1 ? "agent" : "agents"} running` : "";
  return (
    <span className="inline-flex items-center gap-1">
    {badge ? <span
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        "rounded-full px-1.5 font-mono text-[10.5px] leading-4 tabular-nums",
        badge.needsYou ? "bg-rose-500/15 text-rose-700 dark:text-rose-300" : "bg-foreground/[0.07] text-muted-foreground",
      )}
    >
      {badge.count}
    </span> : null}
    {turn !== null ? <span role="status" aria-label={`Your turn on ${turn} ${turn === 1 ? "PR" : "PRs"}`}
      title={`Your turn on ${turn} ${turn === 1 ? "PR" : "PRs"}`} className="rounded bg-violet-500/10 px-1 py-0.5 text-[10px] font-medium leading-none tabular-nums text-violet-800 dark:text-violet-200">
      {turn > 99 ? "99+" : turn}
    </span> : null}
    </span>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "thread-effort",
    scopes: ["thread"],
    banners: [{ id: "thread-effort-control", chrome: "bare", component: ThreadEffortControl }],
  });
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
