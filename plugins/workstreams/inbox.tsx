// The Board: an inbox of checkouts, sectioned by the next action each needs.
//
// One row per checkout, because every action is per pull request. Unlike the
// Map, position here DOES follow status: this is a list you work through, and
// the sections and in-section order come from the pure rules in
// workstreams.ts (`inboxSection`, `byInboxOrder`), unit-tested there.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { UrlLink, experimental_useSidebarThreads, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { Board, Prefs, WireGroup, rpcContract } from "./server";
import {
  INBOX_COLLAPSED,
  INBOX_SECTIONS,
  INBOX_SECTION_LABEL,
  ESCALATING,
  STALENESS,
  ageLabel,
  byInboxOrder,
  displayTitle,
  groupChildren,
  inboxSection,
  inboxVerb,
  isTicketlessClone,
  matchesInboxQuery,
  stateAge,
  threadPrompt,
  type InboxSection,
  type Staleness,
  type StateAge,
} from "./workstreams";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Cluster = WireGroup["clusters"][number];
type Unit = Cluster["units"][number];

/** One inbox row: a checkout and everything the row shows about it. */
export type Row = {
  key: string;
  unit: Unit;
  cluster: Cluster;
  effort: string;
  section: InboxSection;
  verb: string | null;
  age: StateAge;
  repo: string;
  title: string;
};

/** Every checkout on the board, as rows, grouped and ordered by section. */
export function inboxRows(board: Board, now: number): Map<InboxSection, Row[]> {
  const byParent = groupChildren(board.groups);
  const rows: Row[] = [];
  for (const group of board.groups) {
    // Clusters live on the leaves; a group with children holds none itself.
    if ((byParent.get(group.key) ?? []).length > 0) continue;
    for (const cluster of group.clusters) {
      for (const unit of cluster.units) {
        const section = inboxSection(unit, now);
        rows.push({
          key: unit.path,
          unit,
          cluster,
          effort: group.name,
          section,
          verb: inboxVerb(unit, section),
          age: stateAge(unit),
          repo: unit.repo ?? unit.dirName,
          title: unit.pr === null ? (unit.branch ?? unit.dirName) : displayTitle(unit.pr.title),
        });
      }
    }
  }
  const sections = new Map<InboxSection, Row[]>(INBOX_SECTIONS.map((section) => [section, []]));
  for (const row of rows) sections.get(row.section)?.push(row);
  const facts = (row: Row) => ({
    repo: row.repo,
    prNumber: row.unit.pr?.number ?? null,
    path: row.unit.path,
    since: row.age.since,
  });
  for (const list of sections.values()) list.sort((a, b) => byInboxOrder(facts(a), facts(b)));
  return sections;
}

export function InboxBoard({
  board,
  prefs,
  onPrefs,
  focusTicket,
  onFocusTicket,
  onShowOnMap,
}: {
  board: Board;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  /** The shared selection: the cluster the Map had in focus. */
  focusTicket: string | null;
  onFocusTicket: (ticket: string | null) => void;
  /** Switch to the Map, which flies to `focusTicket` on arrival. */
  onShowOnMap: () => void;
}) {
  const navigate = useBbNavigate();
  const now = useMemo(() => Date.now(), [board]);
  const all = useMemo(() => inboxRows(board, now), [board, now]);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [help, setHelp] = useState(false);
  const [open, setOpen] = useState<Record<InboxSection, boolean>>(() =>
    Object.fromEntries(INBOX_SECTIONS.map((section) => [section, !INBOX_COLLAPSED[section]])) as Record<
      InboxSection,
      boolean
    >,
  );

  // Search and the Filter popover narrow rows; they never reorder them.
  const sections = useMemo(() => {
    const keep = (row: Row) =>
      (prefs.showClones || !isTicketlessClone(row.unit)) &&
      (prefs.staleness.length === 0 || prefs.staleness.includes(row.unit.staleness)) &&
      (prefs.surfaces.length === 0 || prefs.surfaces.some((surface) => row.unit.surfaces.includes(surface))) &&
      matchesInboxQuery(
        { ticket: row.unit.ticket, title: row.title, repo: row.repo, effort: row.effort },
        query,
      );
    return new Map([...all].map(([section, rows]) => [section, rows.filter(keep)]));
  }, [all, prefs, query]);

  // j/k walk the rows the reader can see, top to bottom.
  const visible = useMemo(
    () => INBOX_SECTIONS.flatMap((section) => (open[section] ? (sections.get(section) ?? []) : [])),
    [open, sections],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = visible.find((row) => row.key === selectedKey) ?? null;

  // Arriving from the Map selects the first row of the cluster it had in focus.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    const row = focusTicket === null ? undefined : visible.find((entry) => entry.cluster.ticket === focusTicket);
    if (row !== undefined) setSelectedKey(row.key);
  }, [focusTicket, visible]);

  const select = useCallback(
    (row: Row | null) => {
      setSelectedKey(row?.key ?? null);
      if (row !== null) onFocusTicket(row.cluster.ticket);
      if (row !== null) document.getElementById(`inbox-${row.key}`)?.scrollIntoView({ block: "nearest" });
    },
    [onFocusTicket],
  );

  // Most recent first, as on the Map: running, then by when the host last saw each move.
  const sidebarThreads = experimental_useSidebarThreads().threads;
  const threadsOf = useCallback(
    (row: Row) => {
      const updated = new Map(sidebarThreads.map((thread) => [thread.id, thread.updatedAt]));
      return [...row.cluster.threads].sort(
        (a, b) => Number(b.active) - Number(a.active) || (updated.get(b.id) ?? 0) - (updated.get(a.id) ?? 0),
      );
    },
    [sidebarThreads],
  );
  const openThread = useCallback((id: string) => navigate.toThread(id), [navigate]);

  const [starting, setStarting] = useState<Row | null>(null);

  /**
   * Open the checkout. The SDK has no frontend call that opens a BB terminal
   * at a path, so this asks BB to open the folder in the client's preferred
   * external target (the file link's own "open externally" intent), and falls
   * back to copying the path when BB declines.
   */
  const openCheckout = useCallback(
    (row: Row) => {
      const accepted =
        board.hostId !== null &&
        navigate.experimental_openFileExternally({
          target: { kind: "host", hostId: board.hostId, path: row.unit.path },
          location: null,
        });
      if (accepted) return;
      void navigator.clipboard.writeText(row.unit.path).then(
        () => toast.success("Checkout path copied", { description: row.unit.path }),
        () => toast.error("Could not open or copy the checkout path", { description: row.unit.path }),
      );
    },
    [board.hostId, navigate],
  );

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || starting !== null) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null)
      ) {
        return;
      }
      const index = selected === null ? -1 : visible.indexOf(selected);
      const act = (fn: (row: Row) => void) => {
        if (selected !== null) fn(selected);
      };
      switch (event.key) {
        case "j":
        case "ArrowDown":
          select(visible[Math.min(index + 1, visible.length - 1)] ?? null);
          break;
        case "k":
        case "ArrowUp":
          select(visible[Math.max(index - 1, 0)] ?? null);
          break;
        case "Enter":
          act((row) => {
            if (row.unit.pr !== null) navigate.openUrl(row.unit.pr.url);
          });
          break;
        case "t":
          act((row) => {
            const newest = threadsOf(row)[0];
            if (newest !== undefined) openThread(newest.id);
          });
          break;
        case "m":
          act((row) => {
            onFocusTicket(row.cluster.ticket);
            onShowOnMap();
          });
          break;
        case "o":
          act(openCheckout);
          break;
        case "n":
          act(setStarting);
          break;
        case "/":
          searchRef.current?.focus();
          break;
        case "?":
          setHelp((current) => !current);
          break;
        case "Escape":
          if (help) setHelp(false);
          else if (query !== "") setQuery("");
          else select(null);
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [help, navigate, onFocusTicket, onShowOnMap, openCheckout, openThread, query, select, selected, starting, threadsOf, visible],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);


  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <InboxHeader
        searchRef={searchRef}
        query={query}
        onQuery={setQuery}
        prefs={prefs}
        onPrefs={onPrefs}
        surfaces={board.surfaces}
        shown={[...sections.values()].reduce((sum, rows) => sum + rows.length, 0)}
        total={[...all.values()].reduce((sum, rows) => sum + rows.filter((row) => prefs.showClones || !isTicketlessClone(row.unit)).length, 0)}
        onHelp={() => setHelp((current) => !current)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col px-4 pb-10">
          {INBOX_SECTIONS.map((section) => {
            const rows = sections.get(section) ?? [];
            const expanded = open[section];
            return (
              <section key={section} aria-label={INBOX_SECTION_LABEL[section]} className="pt-5">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen((current) => ({ ...current, [section]: !current[section] }))}
                  className="flex w-full items-center gap-2 rounded-sm px-2 pb-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon
                    name="ChevronRight"
                    className={cn("size-3.5 text-muted-foreground transition-transform duration-150", expanded && "rotate-90")}
                  />
                  <h2 className="text-[13px] font-semibold tracking-tight text-foreground">
                    {INBOX_SECTION_LABEL[section]}
                  </h2>
                  <span className="font-mono text-[11px] text-muted-foreground">{rows.length}</span>
                </button>
                {expanded ? (
                  rows.length === 0 ? (
                    <p className="px-2 pb-1 pl-8 text-[12px] text-muted-foreground/80">{EMPTY[section]}</p>
                  ) : (
                    <ul role="listbox" aria-label={INBOX_SECTION_LABEL[section]} className="flex flex-col">
                      {rows.map((row) => (
                        <InboxRow
                          key={row.key}
                          row={row}
                          now={now}
                          selected={row.key === selected?.key}
                          threads={threadsOf(row)}
                          onSelect={() => select(row)}
                          onOpenThread={openThread}
                          onOpenCheckout={() => openCheckout(row)}
                          onStart={() => setStarting(row)}
                        />
                      ))}
                    </ul>
                  )
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
      {help ? <KeyList onClose={() => setHelp(false)} /> : null}
      <StartThreadDialog row={starting} onClose={() => setStarting(null)} />
    </div>
  );
}

const KEYS: [string, string][] = [
  ["j / k", "Next / previous row"],
  ["Enter", "Open the pull request"],
  ["t", "Open the most recent thread"],
  ["m", "Show it on the Map"],
  ["o", "Open the checkout"],
  ["n", "Start a thread (asks first)"],
  ["/", "Search"],
  ["Esc", "Clear search, then selection"],
  ["v", "Switch to the Map"],
  ["?", "Show or hide these keys"],
];

function KeyList({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="absolute right-4 top-12 z-30 w-72 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-md"
    >
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[12px] font-semibold">Keys</p>
        <button type="button" aria-label="Close" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <Icon name="X" className="size-3.5" />
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        {KEYS.map(([key, what]) => (
          <div key={key} className="contents">
            <dt>
              <kbd className="rounded border border-border px-1 font-mono text-[11px]">{key}</kbd>
            </dt>
            <dd className="text-muted-foreground">{what}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** What an empty section says. Plain, and never a scold. */
const EMPTY: Record<InboxSection, string> = {
  fix: "No failing CI.",
  respond: "No review feedback waiting on you.",
  merge: "Nothing ready to merge.",
  waiting: "Nothing waiting on review or a stack.",
  "in-flight": "Nothing in flight.",
  shipped: "Nothing merged in the last week.",
  parked: "Nothing parked.",
};

// ---- one row ---------------------------------------------------------------

/** The chip's tone is the section's, so a glance down the list reads the action. */
const CHIP: Record<InboxSection, string> = {
  fix: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  respond: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  merge: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  waiting: "bg-foreground/[0.06] text-muted-foreground",
  "in-flight": "bg-sky-500/12 text-sky-800 dark:text-sky-300",
  shipped: "bg-foreground/[0.05] text-muted-foreground",
  parked: "bg-foreground/[0.05] text-muted-foreground",
};

type ThreadLink = Cluster["threads"][number];

const TIER_WORDS: Record<ThreadLink["tier"], string> = {
  started: "started here",
  environment: "runs here",
  ticket: "names it",
  paths: "worked here",
};

/**
 * The thread mark, as on the Map: a dot that is solid while a thread runs.
 * Hover or focus lists the threads; a click opens the most recent one.
 */
function ThreadMark({ threads, onOpen }: { threads: readonly ThreadLink[]; onOpen: (id: string) => void }) {
  const [shown, setShown] = useState(false);
  if (threads.length === 0) return <span className="w-4 shrink-0" aria-hidden />;
  const running = threads.some((thread) => thread.active);
  return (
    <span className="relative flex w-4 shrink-0 justify-center">
      <button
        type="button"
        aria-label={`${threads.length} BB ${threads.length === 1 ? "thread" : "threads"}; open the most recent`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen(threads[0]!.id);
        }}
        onPointerEnter={() => setShown(true)}
        onPointerLeave={() => setShown(false)}
        onFocus={() => setShown(true)}
        onBlur={() => setShown(false)}
        className="flex size-5 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          aria-hidden
          className={cn("size-[7px] rounded-full", running ? "bg-foreground" : "bg-foreground/45")}
        />
      </button>
      {shown ? (
        <span
          role="tooltip"
          className="absolute right-0 top-6 z-20 w-72 rounded-lg border border-border bg-popover px-2.5 py-2 text-left text-popover-foreground shadow-sm"
        >
          {threads.slice(0, 5).map((thread) => (
            <span key={thread.id} className="flex min-w-0 items-center gap-2 py-0.5 text-[11.5px]">
              <span
                aria-hidden
                className={cn("size-[7px] shrink-0 rounded-full", thread.active ? "bg-foreground" : "bg-foreground/40")}
              />
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              <span className="shrink-0 text-[10.5px] text-muted-foreground">
                {thread.active ? "running" : "idle"} · {TIER_WORDS[thread.tier]}
              </span>
            </span>
          ))}
          {threads.length > 5 ? (
            <span className="block pl-[15px] text-[11px] text-muted-foreground">+{threads.length - 5} more</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

function RowAction({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.08] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  );
}

function InboxRow({
  row,
  now,
  selected,
  threads,
  onSelect,
  onOpenThread,
  onOpenCheckout,
  onStart,
}: {
  row: Row;
  now: number;
  selected: boolean;
  threads: readonly ThreadLink[];
  onSelect: () => void;
  onOpenThread: (id: string) => void;
  onOpenCheckout: () => void;
  onStart: () => void;
}) {
  const { unit } = row;
  const risk = unit.surfaces.filter((surface) => ESCALATING.includes(surface));
  const age = ageLabel(row.age, now);
  return (
    <li
      id={`inbox-${row.key}`}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "group flex h-9 min-w-0 cursor-default items-center gap-3 rounded-md px-2 text-[12.5px]",
        selected ? "bg-foreground/[0.07] ring-1 ring-inset ring-ring/60" : "hover:bg-foreground/[0.035]",
      )}
    >
      <span className="flex w-[10.5rem] shrink-0 items-center">
        {row.verb === null ? null : (
          <span className={cn("truncate rounded px-1.5 py-0.5 text-[11px] font-medium", CHIP[row.section])}>
            {row.verb}
          </span>
        )}
      </span>
      <span
        className={cn(
          "w-[6.5rem] shrink-0 truncate text-right font-mono text-[10.5px] tabular-nums",
          row.age.basis === "state" ? "text-foreground/80" : "text-muted-foreground/80",
        )}
        title={
          row.age.basis === "state"
            ? "Time in this state"
            : "No state change seen yet, so this is the time since the last commit"
        }
      >
        {age}
      </span>
      <span className="w-32 shrink-0 truncate font-medium text-foreground" title={row.repo}>
        {row.repo}
      </span>
      {unit.pr === null ? (
        <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground/70">—</span>
      ) : (
        <UrlLink
          href={unit.pr.url}
          onClick={(event) => event.stopPropagation()}
          className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          #{unit.pr.number}
        </UrlLink>
      )}
      <span className="min-w-0 flex-[3] truncate text-foreground" title={row.title}>
        {row.title}
      </span>
      <span
        className="hidden min-w-0 max-w-52 flex-1 truncate text-[11.5px] text-muted-foreground/80 lg:block"
        title={row.effort}
      >
        {row.effort}
      </span>
      {risk.length === 0 ? null : (
        <span className="shrink-0 rounded border border-rose-500/40 px-1 text-[10.5px] text-rose-700 dark:text-rose-300" title="High risk: touches an irreversible surface">
          {risk.join(" · ")}
        </span>
      )}
      <span
        className={cn(
          "flex shrink-0 items-center gap-0.5",
          selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        <RowAction label="Open checkout (o)" icon="FolderOpen" onClick={onOpenCheckout} />
        <RowAction label="Start a thread (n)" icon="MessageSquarePlus" onClick={onStart} />
      </span>
      <ThreadMark threads={threads} onOpen={onOpenThread} />
    </li>
  );
}

// ---- header: search and the one Filter popover ------------------------------

const STALENESS_WORDS: Record<Staleness, string> = {
  fresh: "Last commit ≤ 7 days",
  recent: "8–30 days",
  cold: "31–90 days",
  dead: "Over 90 days",
};

function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

function FilterOption({ checked, onToggle, children }: { checked: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-foreground/[0.05]"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {checked ? <Icon name="Check" className="size-3.5" /> : null}
      </span>
      {children}
    </button>
  );
}

function InboxHeader({
  searchRef,
  query,
  onQuery,
  prefs,
  onPrefs,
  surfaces,
  shown,
  total,
  onHelp,
}: {
  searchRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (next: string) => void;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  surfaces: readonly string[];
  shown: number;
  total: number;
  onHelp: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const active = prefs.staleness.length + prefs.surfaces.length + (prefs.showClones ? 1 : 0);

  return (
    <div className="shrink-0 border-b border-border/60">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-2 px-4 py-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2.5 focus-within:ring-2 focus-within:ring-ring">
          <Icon name="Search" className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                if (query !== "") onQuery("");
                else event.currentTarget.blur();
              }
            }}
            placeholder="Search tickets, titles, repos, efforts"
            aria-label="Search the board"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/70"
          />
          <kbd className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">/</kbd>
        </label>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {shown === total ? `${total} rows` : `${shown} of ${total}`}
        </span>
        <div ref={rootRef} className="relative shrink-0">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] hover:bg-foreground/[0.06]",
              active > 0 ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Icon name="FilterHorizontal" className="size-3.5" />
            Filter{active > 0 ? ` · ${active}` : ""}
          </button>
          {open ? (
            <div
              role="menu"
              className="absolute right-0 top-9 z-30 w-64 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-md"
            >
              <p className="px-2 pb-0.5 pt-1 text-[11px] font-semibold text-muted-foreground">Last commit</p>
              {STALENESS.map((bucket) => (
                <FilterOption
                  key={bucket}
                  checked={prefs.staleness.includes(bucket)}
                  onToggle={() => onPrefs({ staleness: toggled(prefs.staleness, bucket) })}
                >
                  {STALENESS_WORDS[bucket]}
                </FilterOption>
              ))}
              {surfaces.length === 0 ? null : (
                <>
                  <p className="px-2 pb-0.5 pt-2 text-[11px] font-semibold text-muted-foreground">Touches</p>
                  <div className="grid grid-cols-2">
                    {surfaces.map((surface) => (
                      <FilterOption
                        key={surface}
                        checked={prefs.surfaces.includes(surface)}
                        onToggle={() => onPrefs({ surfaces: toggled(prefs.surfaces, surface) })}
                      >
                        {surface}
                      </FilterOption>
                    ))}
                  </div>
                </>
              )}
              <div className="mt-1.5 border-t border-border/70 pt-1.5">
                <FilterOption checked={prefs.showClones} onToggle={() => onPrefs({ showClones: !prefs.showClones })}>
                  Show ticketless clones
                </FilterOption>
              </div>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Keyboard shortcuts (?)"
          title="Keyboard shortcuts (?)"
          onClick={onHelp}
          className="flex size-8 shrink-0 items-center justify-center rounded-md font-mono text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          ?
        </button>
      </div>
    </div>
  );
}

// ---- start a thread: never one click ------------------------------------------

/**
 * The confirm step before the Board's one write-ish action. The prompt is
 * prefilled from the row and editable; nothing runs until Start. A failure
 * (no BB project holds the checkout, say) is shown here, and the dialog stays
 * open with the prompt intact.
 */
function StartThreadDialog({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (row === null) return;
    setError(null);
    setBusy(false);
    setPrompt(
      threadPrompt(row.section, {
        repo: row.repo,
        prNumber: row.unit.pr?.number ?? null,
        title: row.unit.pr === null ? null : row.title,
        branch: row.unit.branch,
        path: row.unit.path,
      }),
    );
  }, [row]);

  const start = async () => {
    if (row === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("thread_start", { path: row.unit.path, prompt });
      if (result.ok) {
        onClose();
        navigate.toThread(result.threadId);
        return;
      }
      setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(false);
  };

  return (
    <Dialog open={row !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Start a thread</DialogTitle>
          <DialogDescription>
            {row === null ? null : (
              <>
                Runs in <span className="font-mono text-[12px]">{row.unit.path}</span> with the project's default
                agent. Edit the prompt first if you like.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void start();
            }
          }}
          aria-label="Prompt"
          rows={6}
          className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-[13px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {error === null ? null : (
          <p role="alert" className="text-[12.5px] text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void start()} disabled={busy || prompt.trim() === ""}>
            {busy ? "Starting…" : "Start thread"}
            <kbd className="ml-1 font-mono text-[10px] opacity-70">⌘↵</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
