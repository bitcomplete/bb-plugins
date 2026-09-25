// The Board: an inbox of checkouts grouped by next action or effort.
//
// One row per checkout, because every action is per pull request. Unlike the
// Map, position here DOES follow status: this is a list you work through, and
// the sections and in-section order come from the pure rules in
// workstreams.ts (`inboxSection`, `byInboxOrder`), unit-tested there.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as SelectPrimitive from "@radix-ui/react-select";
import { UrlLink, experimental_useSidebarThreads, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { Board, Prefs, WireGroup, WireRun, rpcContract } from "./server";
import {
  INBOX_COLLAPSED,
  INBOX_SECTIONS,
  INBOX_SECTION_LABEL,
  ESCALATING,
  STALENESS,
  byInboxOrder,
  displayTitle,
  groupChildren,
  inboxSection,
  inboxVerb,
  isTicketlessClone,
  outsideGrouping,
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
import { Tip } from "@/components/ui/tooltip";
import { POINTER_CURSORS, cn } from "@/lib/utils";
import { toast } from "sonner";
import { primaryAction, type PrimaryAction } from "./actions";
import { ActionDialogs, RowActionMenu, ThreadMessageDialog, type ActionRequest } from "./rowactions";
import { ThreadMenu } from "./threadmenu";
import { PrBacklog } from "./pr-backlog-view";
import { EffortCoordinatorControl } from "./effort-coordinator-control";
import { backlogMatches, includeRemoteEfforts, prBacklog, remoteAttentionRows, remotePrsByEffort } from "./pr-backlog";
import { ArchivedThreadsButton } from "./archivedthreads";
import { rowRun, runDetail, runLabel, stripCounts, type RunStatus, type StripCounts } from "./runs";
import { REVIEWER_MARK, reviewerInitials, reviewersLabel, reviewersOf, visibleReviewers, type Reviewer, type ReviewerState } from "./reviewers";
import { ageHint, primaryHint, rowAge, shortAge, shortVerb, titleHint } from "./rowlabels";
import { completedByEffort, groupInboxRows, partitionCompletedRows, visibleCompletedRows, visibleInboxRows, type InboxGrouping, type RowGroup } from "./inbox-grouping";
import { latestEffortOutcome, type EffortOutcome } from "./outcomes";
import { attentionDetail, attentionLabel, hasBoardRows, workstreamAttention, type WorkstreamAttention } from "./workstream-attention";
import { usePortalScopeProps } from "./lib/portal-scope";

type Cluster = WireGroup["clusters"][number];
type Unit = Cluster["units"][number];

/** One inbox row: a checkout and everything the row shows about it. */
export type Row = {
  key: string;
  unit: Unit;
  cluster: Cluster;
  effortKey: string;
  effort: string;
  section: InboxSection;
  verb: string | null;
  age: StateAge;
  repo: string;
  title: string;
  /** What the row's `a` key and action button do; null when there is nothing to do. */
  action: PrimaryAction | null;
  /** The row's latest agent or direct run, while it is still worth reporting. */
  run: WireRun | null;
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
        const verb = inboxVerb(unit, section);
        rows.push({
          key: unit.path,
          unit,
          cluster,
          effortKey: group.key,
          effort: group.name,
          section,
          verb,
          action: primaryAction(unit, section, verb),
          age: stateAge(unit),
          run: rowRun(board.runs, unit.path, now),
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
  dispatchControls = false,
}: {
  board: Board;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  /** The shared selection: the cluster the Map had in focus. */
  focusTicket: string | null;
  onFocusTicket: (ticket: string | null) => void;
  /** Switch to the Map, which flies to `focusTicket` on arrival. */
  onShowOnMap: () => void;
  /** Show effort automation controls and the complete PR backlog. */
  dispatchControls?: boolean;
}) {
  const [boardV2View, setBoardV2View] = useState<"efforts" | "backlog">(() => {
    try { return window.localStorage.getItem("bb-workstreams:board-v2-view") === "backlog" ? "backlog" : "efforts"; }
    catch { return "efforts"; }
  });
  const backlogVisible = dispatchControls && boardV2View === "backlog";
  const chooseView = (view: "efforts" | "backlog") => {
    setBoardV2View(view);
    try { window.localStorage.setItem("bb-workstreams:board-v2-view", view); } catch { /* Storage may be disabled. */ }
  };
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const now = useMemo(() => Date.now(), [board]);
  const all = useMemo(() => inboxRows(board, now), [board, now]);
  const inventoryOnlyPrs = useMemo(() => prBacklog(board.prInventory.entries, [...all.values()].flat(), now).filter((row) => row.local === null), [board.prInventory.entries, all, now]);
  const allEfforts = useMemo(() => workstreamAttention([...Array.from(all.values()).flat(), ...remoteAttentionRows(inventoryOnlyPrs)]), [all, inventoryOnlyPrs]);
  const efforts = useMemo(() => allEfforts.filter(hasBoardRows), [allEfforts]);
  const [dispatch, setDispatch] = useState(board.dispatch);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  useEffect(() => setDispatch(board.dispatch), [board.dispatch]);
  const setDispatchMode = async (mode: Board["dispatch"]["mode"], effortKey: string | null) => {
    if (dispatchBusy) return;
    setDispatchBusy(true);
    setDispatchError(null);
    try {
      setDispatch(await rpc.call("dispatch_set", { mode, effortKey }));
    } catch (cause) {
      setDispatchError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDispatchBusy(false);
    }
  };
  const effortHeadings = useRef(new Map<string, HTMLElement>());
  const initialEffortScroll = useRef(false);
  const coordinatedFocus = useRef<string | null>(null);
  const focusEffort = (effortKey: string | null) => {
    if (effortKey !== null) {
      setEffortOpen((current) => ({ ...current, [effortKey]: true }));
      effortHeadings.current.get(effortKey)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    void setDispatchMode(effortKey === null ? "off" : "shadow", effortKey);
  };
  const [query, setQuery] = useState("");
  const remoteEffortPrs = useMemo(() => remotePrsByEffort(inventoryOnlyPrs, query), [inventoryOnlyPrs, query]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [boardWidth, setBoardWidth] = useState(0);
  useEffect(() => {
    const node = boardRef.current;
    if (node === null) return;
    const observer = new ResizeObserver(([entry]) => setBoardWidth(entry?.contentRect.width ?? node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // Keep a deliberate two-line grid until there is room for every desktop column.
  const compact = boardWidth < 1060;
  const tight = boardWidth < 480;
  const [groupBy, setGroupBy] = useState<InboxGrouping>(dispatchControls ? "effort" : "action");
  useEffect(() => setGroupBy(dispatchControls ? "effort" : "action"), [dispatchControls]);
  const [actionOpen, setActionOpen] = useState<Record<InboxSection, boolean>>(() =>
    Object.fromEntries(INBOX_SECTIONS.map((section) => [section, !INBOX_COLLAPSED[section]])) as Record<
      InboxSection,
      boolean
    >,
  );
  const [effortOpen, setEffortOpen] = useState<Record<string, boolean>>({});

  // Search and the Filter popover narrow rows; they never reorder them.
  const sections = useMemo(() => {
    const keep = (row: Row) =>
      (prefs.showClones || !isTicketlessClone(row.unit)) &&
      (prefs.staleness.length === 0 || prefs.staleness.includes(row.unit.staleness)) &&
      (prefs.surfaces.length === 0 || prefs.surfaces.some((surface) => row.unit.surfaces.includes(surface))) &&
      matchesInboxQuery(
        { ticket: row.unit.ticket, title: row.title, repo: row.repo, effort: row.effort, prNumber: row.unit.pr?.number ?? null },
        query,
      );
    return new Map([...all].map(([section, rows]) => [section, rows.filter(keep)]));
  }, [all, prefs, query]);
  const visibleEffortCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of [...sections.values()].flat()) counts.set(row.effortKey, (counts.get(row.effortKey) ?? 0) + 1);
    for (const [key, rows] of remoteEffortPrs) counts.set(key, (counts.get(key) ?? 0) + rows.length);
    return counts;
  }, [sections, remoteEffortPrs]);
  const completed = useMemo(() => partitionCompletedRows(sections), [sections]);
  const effortCompleted = useMemo(() => completedByEffort(completed), [completed]);
  const completionWithinEffort = dispatchControls && groupBy === "effort";
  const groups = useMemo(() => {
    const localGroups = groupInboxRows(dispatchControls && !completionWithinEffort ? completed.active : sections, groupBy)
      .filter((group) => !dispatchControls || group.section !== "shipped")
      .map((group) => completionWithinEffort ? { ...group, rows: group.rows.filter((row) => row.unit.lifecycle !== "merged" && row.unit.lifecycle !== "shipped") } : group);
    return completionWithinEffort ? includeRemoteEfforts(localGroups, remoteEffortPrs) : localGroups;
  }, [completed, completionWithinEffort, dispatchControls, sections, groupBy, remoteEffortPrs]);
  const [effortCompletedOpen, setEffortCompletedOpen] = useState<Record<string, { merged: boolean; inReleaseTag: boolean }>>({});
  const [completedOpen, setCompletedOpen] = useState({ merged: false, inReleaseTag: false });
  useEffect(() => {
    if (!dispatchControls || initialEffortScroll.current || groups.length === 0) return;
    initialEffortScroll.current = true;
    if (dispatch.effortKey !== null) {
      setEffortOpen((current) => ({ ...current, [dispatch.effortKey!]: true }));
      requestAnimationFrame(() => effortHeadings.current.get(dispatch.effortKey!)?.scrollIntoView({ block: "start" }));
    }
  }, [dispatchControls, dispatch.effortKey, groups]);
  useEffect(() => {
    const key = coordinatedFocus.current;
    if (key !== null && groups.some((group) => group.key === key)) {
      coordinatedFocus.current = null;
      requestAnimationFrame(() => effortHeadings.current.get(key)?.scrollIntoView({ block: "start" }));
    }
  }, [groups]);
  const selectedEffortVisible = dispatch.effortKey === null || groups.some((group) => group.key === dispatch.effortKey);
  const completedOnlySelected = allEfforts.some((effort) => effort.key === dispatch.effortKey && !hasBoardRows(effort)) && !inventoryOnlyPrs.some((row) => row.effortKey === dispatch.effortKey);
  const revealSelectedEffort = () => {
    setQuery("");
    const selectedRows = outcomeRows.get(dispatch.effortKey ?? "") ?? [];
    onPrefs({
      staleness: [],
      surfaces: [],
      ...(!prefs.showClones && selectedRows.length > 0 && selectedRows.every((row) => isTicketlessClone(row.unit)) ? { showClones: true } : {}),
    });
    if (dispatch.effortKey !== null) setEffortOpen((current) => ({ ...current, [dispatch.effortKey!]: true }));
    requestAnimationFrame(() => requestAnimationFrame(() => effortHeadings.current.get(dispatch.effortKey ?? "")?.scrollIntoView({ block: "start", behavior: "smooth" })));
  };
  const outcomeRows = useMemo(() => {
    const byEffort = new Map<string, Row[]>();
    for (const row of [...all.values()].flat()) {
      const rows = byEffort.get(row.effortKey) ?? [];
      rows.push(row);
      byEffort.set(row.effortKey, rows);
    }
    return byEffort;
  }, [all]);
  const isOpen = useCallback(
    (group: RowGroup) => group.section === null ? effortOpen[group.key] !== false : actionOpen[group.section],
    [actionOpen, effortOpen],
  );
  const toggleGroup = useCallback((group: RowGroup) => {
    const section = group.section;
    if (section === null) {
      setEffortOpen((current) => ({ ...current, [group.key]: current[group.key] === false }));
    } else {
      setActionOpen((current) => ({ ...current, [section]: !current[section] }));
    }
  }, []);

  // j/k walk the rows the reader can see, top to bottom.
  const visible = useMemo(() => completionWithinEffort
    ? groups.flatMap((group) => isOpen(group) ? [...group.rows, ...visibleCompletedRows(effortCompleted.get(group.key) ?? { merged: [], inReleaseTag: [] }, effortCompletedOpen[group.key] ?? { merged: false, inReleaseTag: false })] : [])
    : [...visibleInboxRows(groups, isOpen), ...(dispatchControls ? visibleCompletedRows(completed, completedOpen) : [])],
  [groups, isOpen, dispatchControls, completed, completedOpen, completionWithinEffort, effortCompleted, effortCompletedOpen]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = visible.find((row) => row.key === selectedKey) ?? null;

  // Arriving from the Map selects the first row of the cluster it had in focus.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    const row = focusTicket === null ? undefined : [...all.values()].flat().find((entry) => entry.cluster.ticket === focusTicket);
    if (row !== undefined) {
      setSelectedKey(row.key);
      setActionOpen((current) => ({ ...current, [row.section]: true }));
      setEffortOpen((current) => ({ ...current, [row.effortKey]: true }));
      if (dispatchControls && row.unit.lifecycle === "merged") setCompletedOpen((current) => ({ ...current, merged: true }));
      if (dispatchControls && row.unit.lifecycle === "shipped") setCompletedOpen((current) => ({ ...current, inReleaseTag: true }));
      if (dispatchControls && (row.unit.lifecycle === "merged" || row.unit.lifecycle === "shipped")) setEffortCompletedOpen((current) => ({ ...current, [row.effortKey]: { ...(current[row.effortKey] ?? { merged: false, inReleaseTag: false }), [row.unit.lifecycle === "merged" ? "merged" : "inReleaseTag"]: true } }));
    }
  }, [all, dispatchControls, focusTicket]);

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

  const reviewerColumn = useMemo(
    () => [...all.values()].some((rows) => rows.some((row) => reviewersOf(row.unit.pr).length > 0)),
    [all],
  );

  const [starting, setStarting] = useState<Row | null>(null);
  const [request, setRequest] = useState<ActionRequest | null>(null);
  const [messaging, setMessaging] = useState<Row | null>(null);

  /** Select a row anywhere on the Board, even when filters or a group hide it. */
  const reveal = useCallback(
    (target: Row) => {
      setActionOpen((current) => ({ ...current, [target.section]: true }));
      setEffortOpen((current) => ({ ...current, [target.effortKey]: true }));
      if (dispatchControls && target.unit.lifecycle === "merged") setCompletedOpen((current) => ({ ...current, merged: true }));
      if (dispatchControls && target.unit.lifecycle === "shipped") setCompletedOpen((current) => ({ ...current, inReleaseTag: true }));
      if (dispatchControls && (target.unit.lifecycle === "merged" || target.unit.lifecycle === "shipped")) setEffortCompletedOpen((current) => ({ ...current, [target.effortKey]: { ...(current[target.effortKey] ?? { merged: false, inReleaseTag: false }), [target.unit.lifecycle === "merged" ? "merged" : "inReleaseTag"]: true } }));
      setQuery("");
      const patch: Partial<Prefs> = {};
      if (!prefs.showClones && isTicketlessClone(target.unit)) patch.showClones = true;
      if (prefs.staleness.length > 0 && !prefs.staleness.includes(target.unit.staleness)) patch.staleness = [];
      if (prefs.surfaces.length > 0 && !prefs.surfaces.some((surface) => target.unit.surfaces.includes(surface))) patch.surfaces = [];
      if (Object.keys(patch).length > 0) onPrefs(patch);
      setSelectedKey(target.key);
      onFocusTicket(target.cluster.ticket);
      requestAnimationFrame(() => document.getElementById(`inbox-${target.key}`)?.scrollIntoView({ block: "nearest" }));
    },
    [dispatchControls, onFocusTicket, onPrefs, prefs],
  );

  // The Agents strip counts each row's own run, so every count has rows to jump to.
  const rowRuns = useMemo(() => [...all.values()].flat().filter((row) => row.run !== null), [all]);
  const strip = useMemo(() => stripCounts(rowRuns.map((row) => row.run!), now), [rowRuns, now]);
  const jumpIndex = useRef<{ kind: StripKind; index: number } | null>(null);
  /** Each click on a strip part selects the next row in that state. */
  const jumpTo = useCallback(
    (kind: StripKind) => {
      const matches = rowRuns.filter((row) => STRIP_MATCH[kind](row.run!.status));
      if (matches.length === 0) return;
      const index = jumpIndex.current?.kind === kind ? (jumpIndex.current.index + 1) % matches.length : 0;
      jumpIndex.current = { kind, index };
      reveal(matches[index]!);
    },
    [reveal, rowRuns],
  );

  /**
   * The row's primary action. Direct and agent actions only ever OPEN their
   * dialog; the write happens on the dialog's own confirm button. A jump
   * selects the PR this row is stacked behind, opening its section if folded.
   */
  const runPrimary = useCallback(
    (row: Row) => {
      const action = row.action;
      if (action === null) return;
      if (action.kind === "agent") setRequest({ kind: "agent", action: action.action, row });
      else if (action.kind === "direct") setRequest({ kind: "direct", action: action.action, row });
      else {
        const target = [...all.values()].flat().find((entry) => entry.repo === row.repo && entry.unit.pr?.number === action.behind);
        if (target === undefined) {
          toast.error(`#${action.behind} is not on the board`, { description: "It may live in a checkout outside the scan roots." });
          return;
        }
        reveal(target);
      }
    },
    [all, reveal],
  );

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
      if (backlogVisible || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || starting !== null || request !== null || messaging !== null) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, button, a[href], [contenteditable], [role=dialog], [role=menu], [role=combobox], [data-pr-backlog-row]") !== null)
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
        case "a":
          act(runPrimary);
          break;
        case "/":
          searchRef.current?.focus();
          break;
        case "Escape":
          if (query !== "") setQuery("");
          else select(null);
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [backlogVisible, messaging, navigate, onFocusTicket, onShowOnMap, openCheckout, openThread, query, request, runPrimary, select, selected, starting, threadsOf, visible],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const renderRow = (row: Row, showSection: boolean, groupKey: string | null) => (
    <InboxRow
      key={row.key}
      row={row}
      showSection={showSection}
      now={now}
      reviewerColumn={reviewerColumn}
      compact={compact}
      tight={tight}
      selected={row.key === selected?.key}
      candidate={dispatchControls && groupKey !== null && dispatch.effortKey === groupKey && dispatch.mode !== "off" && dispatch.candidate?.path === row.key ? dispatch.candidate : null}
      threads={threadsOf(row)}
      onSelect={() => select(row)}
      onOpenThread={openThread}
      onOpenCheckout={() => openCheckout(row)}
      onStart={() => setStarting(row)}
      onMessageAgent={() => setMessaging(row)}
      onPrimary={() => runPrimary(row)}
      onShowOnMap={() => {
        onFocusTicket(row.cluster.ticket);
        onShowOnMap();
      }}
    />
  );

  const completionCards = (done: { merged: Row[]; inReleaseTag: Row[] }, effortKey: string | null) => {
    const open = effortKey === null ? completedOpen : effortCompletedOpen[effortKey] ?? { merged: false, inReleaseTag: false };
    if (done.merged.length + done.inReleaseTag.length === 0) return null;
    return <div className={cn("flex flex-col gap-1", effortKey === null ? "mt-6 border-t border-border/60 pt-4" : "ml-7 mt-1 border-l border-border/50 pl-2")}>
      {([
        { key: "merged", label: "Merged", rows: done.merged, hint: "Pull requests merged on GitHub" },
        { key: "inReleaseTag", label: "In release tag", rows: done.inReleaseTag, hint: "Merge commits found in a local release tag; deployment is not verified" },
      ] as const).filter(({ rows }) => rows.length > 0).map(({ key, label, rows, hint }) => <section key={key} aria-label={label} className="min-w-0">
        <button type="button" aria-expanded={open[key]} onClick={() => effortKey === null
          ? setCompletedOpen((current) => ({ ...current, [key]: !current[key] }))
          : setEffortCompletedOpen((current) => ({ ...current, [effortKey]: { ...open, [key]: !open[key] } }))}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11.5px] text-muted-foreground outline-none hover:bg-foreground/[0.025] focus-visible:ring-2 focus-visible:ring-ring">
          <Icon name="ChevronRight" className={cn("size-3 shrink-0 transition-transform duration-150", open[key] && "rotate-90")} />
          <span>{label}</span><span className="font-mono text-[10.5px]">{rows.length}</span>
        </button>
        {open[key] ? <><p className="px-2 pb-1 text-[10.5px] text-muted-foreground">{hint}</p><ul role="listbox" aria-label={label}>{rows.map((row) => renderRow(row, false, null))}</ul></> : null}
      </section>)}
    </div>;
  };

  return (
    <div ref={boardRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {dispatchControls ? <div className="flex items-center gap-1 border-b border-border/60 px-4 py-1.5" role="group" aria-label="Board view">
        {(["efforts", "backlog"] as const).map((view) => <button key={view} type="button" aria-pressed={boardV2View === view} onClick={() => chooseView(view)} className={cn("rounded-md px-2.5 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring", boardV2View === view ? "bg-foreground/[0.08] font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>{view === "efforts" ? "Efforts" : "PR backlog"}</button>)}
      </div> : null}
      {backlogVisible && dispatch.mode === "auto" ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 px-4 py-2 text-[11.5px] text-muted-foreground">
        <span>Automatic agent runs · {allEfforts.find((effort) => effort.key === dispatch.effortKey)?.name ?? "selected effort"}</span>
        <button type="button" onClick={() => {
          chooseView("efforts");
          if (dispatch.effortKey !== null) {
            setEffortOpen((current) => ({ ...current, [dispatch.effortKey!]: true }));
            requestAnimationFrame(() => effortHeadings.current.get(dispatch.effortKey!)?.scrollIntoView({ block: "start" }));
          }
        }} className="rounded text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">Go to effort</button>
        <button type="button" disabled={dispatchBusy} onClick={() => void setDispatchMode("off", dispatch.effortKey)} className="rounded text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">Turn off</button>
        {dispatchError === null ? null : <span role="alert" className="text-destructive">{dispatchError}</span>}
      </div> : null}
      {backlogVisible ? <PrBacklog board={board} locals={[...all.values()].flat()} now={now} width={boardWidth} onRequest={setRequest} onMessage={setMessaging} onCheckout={openCheckout} onStart={setStarting} onOpenThread={openThread} threadsOf={threadsOf} /> : <>
      <InboxHeader
        searchRef={searchRef}
        query={query}
        onQuery={setQuery}
        groupBy={groupBy}
        onGroupBy={setGroupBy}
        prefs={prefs}
        onPrefs={onPrefs}
        surfaces={board.surfaces}
        shown={[...sections.values()].reduce((sum, rows) => sum + rows.length, 0) + (dispatchControls ? inventoryOnlyPrs.filter((row) => backlogMatches(row, query)).length : 0)}
        total={[...all.values()].reduce((sum, rows) => sum + rows.filter((row) => prefs.showClones || !isTicketlessClone(row.unit)).length, 0) + (dispatchControls ? inventoryOnlyPrs.length : 0)}
        dispatch={dispatch}
        dispatchBusy={dispatchBusy}
        dispatchError={dispatchError}
        efforts={efforts}
        unavailableEffortName={allEfforts.find((effort) => effort.key === dispatch.effortKey)?.name ?? null}
        focusedVisibleCount={visibleEffortCounts.get(dispatch.effortKey ?? "") ?? 0}
        focusedHasCheckout={[...all.values()].flat().some((row) => row.effortKey === dispatch.effortKey && row.unit.lifecycle !== "merged" && row.unit.lifecycle !== "shipped")}
        filtersActive={query !== "" || prefs.staleness.length > 0 || prefs.surfaces.length > 0 || prefs.showClones}
        onFocusEffort={focusEffort}
        onDispatchMode={(mode) => void setDispatchMode(mode, dispatch.effortKey)}
        dispatchControls={dispatchControls}
        compact={compact}
        tight={boardWidth < 560}
      />
      <AgentsStrip counts={strip} onJump={jumpTo} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col px-4 pb-10">
          {dispatchControls && !selectedEffortVisible ? (
            <div className="flex flex-wrap items-center gap-2 px-2 pt-4 text-[12px] text-muted-foreground">
              <span>{completedOnlySelected ? "The selected workstream has no current Board rows" : "The selected workstream is outside the current view"}{dispatch.mode === "auto" ? " · Running automatically" : dispatch.mode === "shadow" ? " · Preview only" : " · Off"}.</span>
              {!completedOnlySelected && (outcomeRows.has(dispatch.effortKey ?? "") || inventoryOnlyPrs.some((row) => row.effortKey === dispatch.effortKey)) ? (
                <button type="button" onClick={revealSelectedEffort} className="rounded text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">Show workstream</button>
              ) : null}
              {dispatch.mode !== "off" ? <button type="button" disabled={dispatchBusy} onClick={() => void setDispatchMode("off", dispatch.effortKey)} className="rounded text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">Turn off</button> : null}
            </div>
          ) : null}
          {groups.length === 0 && (!dispatchControls || (completed.merged.length + completed.inReleaseTag.length === 0 && !inventoryOnlyPrs.some((row) => backlogMatches(row, query)))) ? (
            <p className="px-2 pt-5 text-[12px] text-muted-foreground">No matching work.</p>
          ) : null}
          {groups.map((group) => {
            const rows = group.rows;
            const remoteCount = completionWithinEffort ? remoteEffortPrs.get(group.key)?.length ?? 0 : 0;
            const established = board.efforts.find((effort) => effort.key === group.key) ?? null;
            const canCoordinate = established !== null || (board.groups.some((entry) => entry.key === group.key && entry.level === "effort") && !outsideGrouping(group.key));
            const expanded = isOpen(group);
            const outcome = dispatchControls && group.section === null
              ? latestEffortOutcome(outcomeRows.get(group.key) ?? [], board.runs, dispatch.attempts)
              : null;
            return (
              <section key={group.key} aria-label={group.label} className="pt-5">
                <div ref={group.section === null ? (node) => {
                  if (node === null) effortHeadings.current.delete(group.key);
                  else effortHeadings.current.set(group.key, node);
                } : undefined} className="flex min-w-0 flex-wrap items-center gap-2 scroll-mt-3">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggleGroup(group)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 pb-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon
                      name="ChevronRight"
                      className={cn("size-3.5 text-muted-foreground transition-transform duration-150", expanded && "rotate-90")}
                    />
                    <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-tight text-foreground">
                      {group.label}
                    </h2>
                    <span className="font-mono text-[11px] text-muted-foreground">{completionWithinEffort ? rows.length + remoteCount > 0 ? `${rows.length + remoteCount} active` : "Completed" : rows.length}</span>
                  </button>
                  {dispatchControls && group.section === null && canCoordinate ? <EffortCoordinatorControl groupKey={group.key} name={group.label} effort={established} board={board} onOpenThread={openThread} onCoordinated={(key) => {
                    setEffortOpen((current) => ({ ...current, [key]: true }));
                    setDispatch((current) => current.effortKey === group.key ? { ...current, effortKey: key } : current);
                    coordinatedFocus.current = key;
                  }} /> : null}
                  {dispatchControls && group.section === null ? (
                    <EffortOutcomeCard
                      outcome={outcome}
                      onOpenThread={openThread}
                      threadUpdatedAt={sidebarThreads.find((thread) => thread.id === outcome?.threadId)?.updatedAt ?? null}
                    />
                  ) : null}
                  {dispatchControls && group.section === null && rows.length + remoteCount > 0 ? (
                    <button
                      type="button"
                      disabled={dispatchBusy || dispatch.effortKey === group.key}
                      onClick={() => focusEffort(group.key)}
                      aria-label={`Choose ${group.label} for agent action preview`}
                      aria-pressed={dispatch.effortKey === group.key}
                      className={cn(
                        "shrink-0 rounded-md px-2 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                        dispatch.effortKey === group.key ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground hover:bg-foreground/[0.06]",
                      )}
                    >
                      {dispatch.effortKey === group.key ? "Selected" : "Choose"}
                    </button>
                  ) : null}
                </div>
                {expanded ? (
                  rows.length === 0 ? (
                    completionWithinEffort && (effortCompleted.has(group.key) || remoteCount > 0) ? null : <p className="px-2 pb-1 pl-8 text-[12px] text-muted-foreground/80">{group.section === null ? "No matching checkouts." : EMPTY[group.section]}</p>
                  ) : (
                    <ul role="listbox" aria-label={group.label} className="flex flex-col">
                      {rows.map((row) => renderRow(row, groupBy === "effort", group.key))}
                    </ul>
                  )
                ) : null}
                {expanded && remoteCount > 0 ? <PrBacklog board={board} locals={[...all.values()].flat()} now={now} width={boardWidth} unassignedQuery={query} embeddedEffortKey={group.key} checkoutFiltersActive={prefs.staleness.length > 0 || prefs.surfaces.length > 0} onRequest={setRequest} onMessage={setMessaging} onCheckout={openCheckout} onStart={setStarting} onOpenThread={openThread} threadsOf={threadsOf} /> : null}
                {expanded && completionWithinEffort ? completionCards(effortCompleted.get(group.key) ?? { merged: [], inReleaseTag: [] }, group.key) : null}
              </section>
            );
          })}
          {dispatchControls ? <PrBacklog board={board} locals={[...all.values()].flat()} now={now} width={boardWidth} unassignedQuery={query} checkoutFiltersActive={prefs.staleness.length > 0 || prefs.surfaces.length > 0} onRequest={setRequest} onMessage={setMessaging} onCheckout={openCheckout} onStart={setStarting} onOpenThread={openThread} threadsOf={threadsOf} /> : null}
          {dispatchControls && !completionWithinEffort ? completionCards(completed, null) : null}
        </div>
      </div>
      </>}
      <StartThreadDialog row={starting} onClose={() => setStarting(null)} />
      <ActionDialogs request={request} now={now} onClose={() => setRequest(null)} />
      <ThreadMessageDialog row={messaging} threads={messaging === null ? [] : threadsOf(messaging)} onClose={() => setMessaging(null)} />
    </div>
  );
}

function EffortOutcomeCard({ outcome, onOpenThread, threadUpdatedAt }: { outcome: EffortOutcome | null; onOpenThread: (id: string) => void; threadUpdatedAt: number | null }) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const restoreFocus = useRef(false);
  const suppressFocusOpen = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const portalScope = usePortalScopeProps();
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    if (pinned.current) return;
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 250);
  };
  const pinCard = () => {
    pinned.current = true;
    cancelClose();
    setOpen(true);
    requestAnimationFrame(() => contentRef.current?.focus());
  };
  useEffect(() => cancelClose, []);
  if (outcome === null) return null;
  const pr = outcome.row.unit.pr;
  if (pr === null) return null;
  const prLabel = `${outcome.row.repo} #${pr.number}`;
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(value) => {
      if (!value) {
        restoreFocus.current = pinned.current;
        pinned.current = false;
      }
      setOpen(value);
    }}>
      <PopoverPrimitive.Anchor asChild>
        <button
          ref={anchorRef}
          type="button"
          aria-label={`Latest recorded Board action for ${outcome.row.effort}: ${outcome.outcome}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onFocus={() => { if (!suppressFocusOpen.current) setOpen(true); }}
          onBlur={scheduleClose}
          onPointerEnter={() => { cancelClose(); setOpen(true); }}
          onPointerLeave={scheduleClose}
          onClick={pinCard}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            pinCard();
          }}
          className="min-w-0 max-w-[min(34%,16rem)] shrink-0 truncate rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="font-medium">Latest Board action</span>
          <span aria-hidden className="mx-1">·</span>
          <span>{outcome.outcome}</span>
        </button>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          {...portalScope}
          ref={contentRef}
          role="dialog"
          aria-label={`Recorded Board action for ${prLabel}`}
          tabIndex={-1}
          side="bottom"
          align="end"
          sideOffset={5}
          collisionPadding={8}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!restoreFocus.current) return;
            restoreFocus.current = false;
            suppressFocusOpen.current = true;
            anchorRef.current?.focus();
            requestAnimationFrame(() => { suppressFocusOpen.current = false; });
          }}
          onInteractOutside={(event) => {
            if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
          }}
          className={cn("z-50 w-[min(24rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none", POINTER_CURSORS)}
        >
          <p className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Recorded Board action · {outcome.source}</p>
          <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px]">
            <UrlLink href={pr.url} className="shrink-0 font-semibold underline underline-offset-2">{prLabel}</UrlLink>
            <span className="min-w-0 text-muted-foreground">{outcome.row.title}</span>
          </div>
          <p className="mt-2 text-[12px] leading-5"><span className="font-medium">{outcome.action}:</span> {outcome.outcome}</p>
          <p className="mt-2 text-[11px] text-muted-foreground">PR state on board: {outcome.prState}</p>
          {outcome.threadId !== null && threadUpdatedAt !== null && threadUpdatedAt > outcome.at + 30_000 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">Thread has newer activity. Open it for the latest update.</p>
          ) : null}
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            <time dateTime={new Date(outcome.at).toISOString()}>{new Date(outcome.at).toLocaleString()}</time>
            {outcome.threadId === null ? null : (
              <button
                type="button"
                onClick={() => { setOpen(false); onOpenThread(outcome.threadId!); }}
                className="shrink-0 text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Open thread
              </button>
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
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

/**
 * The thread mark, as on the Map: a dot that is solid while a thread runs.
 * Hover or click opens the shared thread menu; each entry opens its thread.
 */
function ThreadMark({
  threads,
  onOpen,
  onMore,
}: {
  threads: readonly ThreadLink[];
  onOpen: (id: string) => void;
  onMore: () => void;
}) {
  if (threads.length === 0) return <span className="w-4 shrink-0" aria-hidden />;
  const running = threads.some((thread) => thread.active);
  return (
    <span className="relative flex w-4 shrink-0 justify-center">
      <ThreadMenu
        threads={threads}
        onOpenThread={onOpen}
        onMore={onMore}
        className="flex size-5 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden className={cn("size-[7px] rounded-full", running ? "bg-foreground" : "bg-foreground/45")} />
      </ThreadMenu>
    </span>
  );
}

/**
 * The row's verb. When the row has a primary action the chip IS its button
 * (the same thing `a` runs); otherwise it is plain text, so a filled chip
 * always means "click to act". The hover spells out the full verb.
 */
function VerbChip({
  verb,
  section,
  action,
  onPrimary,
}: {
  verb: string;
  section: InboxSection;
  action: PrimaryAction | null;
  onPrimary: () => void;
}) {
  const label = shortVerb(verb);
  if (action === null) {
    return (
      <Tip label={verb}>
        <span className="truncate px-1.5 text-[11px] text-muted-foreground">{label}</span>
      </Tip>
    );
  }
  const hint = primaryHint(verb, action);
  return (
    <Tip label={hint}>
      <button
        type="button"
        aria-label={hint}
        onClick={(event) => {
          event.stopPropagation();
          onPrimary();
        }}
        className={cn(
          "max-w-full cursor-pointer truncate rounded px-1.5 py-0.5 text-[11px] font-medium outline-none ring-1 ring-inset ring-foreground/15 hover:ring-foreground/35 hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring",
          CHIP[section],
        )}
      >
        {label}
      </button>
    </Tip>
  );
}

const REVIEWER_TONE: Record<ReviewerState, string> = {
  approved: "text-emerald-700 dark:text-emerald-300",
  changes: "text-rose-700 dark:text-rose-300",
  commented: "text-muted-foreground",
  pending: "text-muted-foreground",
};

/** Up to three reviewer marks and a "+N"; the hover lists every reviewer and where they stand. */
function ReviewerMarks({ reviewers, compact }: { reviewers: readonly Reviewer[]; compact: boolean }) {
  if (reviewers.length === 0) return compact ? null : <span className="w-[7rem] shrink-0" aria-hidden />;
  const { shown, more } = visibleReviewers(reviewers);
  const label = reviewersLabel(reviewers);
  return (
    <Tip label={label}>
      <span
        tabIndex={0}
        aria-label={`Reviewers: ${label.replace(/\n/gu, "; ")}`}
        className={cn("flex shrink-0 items-center gap-1.5 overflow-hidden rounded font-mono text-[10.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring", compact ? "max-w-[7rem]" : "w-[7rem]")}
      >
        {shown.map((reviewer) => (
          <span key={reviewer.login} className="flex shrink-0 items-center gap-0.5">
            <span aria-hidden className={cn("text-[11px]", REVIEWER_TONE[reviewer.state])}>
              {REVIEWER_MARK[reviewer.state]}
            </span>
            <span className="text-foreground/75">{reviewerInitials(reviewer.login)}</span>
          </span>
        ))}
        {more > 0 ? <span className="shrink-0 text-muted-foreground">+{more}</span> : null}
      </span>
    </Tip>
  );
}

/** A run's chip reads its status at a glance; only needs-you borrows the Fix rose. */
const RUN_TONE: Record<RunStatus, string> = {
  running: "bg-sky-500/10 text-sky-800 dark:text-sky-300",
  "needs-you": CHIP.fix,
  done: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  succeeded: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  failed: "bg-foreground/[0.05] text-rose-700 dark:text-rose-300",
};
const RUN_SHORT_LABEL: Record<RunStatus, string> = {
  running: "Running",
  "needs-you": "Needs you",
  done: "Done",
  succeeded: "Done",
  failed: "Failed",
};

/** A clock for one chip, so "· 4m" and "2m ago" stay true while the Board is open. */
function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * The row's latest run, beside its verb. An agent run opens its thread; a
 * direct run has none, so it only explains itself in the tooltip.
 */
function RunChip({ run, ageTip, compact, onOpenThread }: { run: WireRun; ageTip: string; compact: boolean; onOpenThread: (id: string) => void }) {
  const now = useTick(30_000);
  const label = runLabel(run, now);
  const visibleLabel = compact ? RUN_SHORT_LABEL[run.status] : label;
  // Keep the run's detail self-contained when opened from the supporting line.
  const detail = `${label}\n${runDetail(run, (at) => new Date(at).toLocaleString())}\n${ageTip}`;
  const threadId = run.threadId;
  const className = cn(
    "flex min-w-0 max-w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
    RUN_TONE[run.status],
  );
  const body = (
    <>
      {run.status === "running" ? (
        // Opacity only, and still under reduced motion.
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current motion-safe:animate-pulse" />
      ) : null}
      <span className="truncate">{visibleLabel}</span>
    </>
  );
  return (
    <Tip label={threadId === null ? detail : `${detail}\nClick to open the thread`}>
      {threadId === null ? (
        <span tabIndex={0} aria-label={detail} className={className}>
          {body}
        </span>
      ) : (
        <button
          type="button"
          aria-label={`${detail}. Open the thread`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenThread(threadId);
          }}
          className={cn(className, "hover:brightness-95")}
        >
          {body}
        </button>
      )}
    </Tip>
  );
}

function InboxRow({
  row,
  showSection,
  now,
  reviewerColumn,
  compact,
  tight,
  selected,
  candidate,
  threads,
  onSelect,
  onOpenThread,
  onOpenCheckout,
  onStart,
  onMessageAgent,
  onPrimary,
  onShowOnMap,
}: {
  row: Row;
  showSection: boolean;
  now: number;
  /** Some row on the Board has reviewers: every row keeps the column, so the columns stay aligned. */
  reviewerColumn: boolean;
  compact: boolean;
  tight: boolean;
  selected: boolean;
  candidate: Board["dispatch"]["candidate"];
  threads: readonly ThreadLink[];
  onSelect: () => void;
  onOpenThread: (id: string) => void;
  onOpenCheckout: () => void;
  onStart: () => void;
  onMessageAgent: () => void;
  onPrimary: () => void;
  onShowOnMap: () => void;
}) {
  const { unit } = row;
  const risk = unit.surfaces.filter((surface) => ESCALATING.includes(surface));
  const displayAge = rowAge(unit.pr, unit.lastCommitAt);
  const age = shortAge(displayAge, now);
  const ageTip = ageHint(displayAge, now);
  const resolvedThreads = unit.pr?.resolvedReviewThreads ?? 0;
  const approvedAfterReview = unit.pr?.reviewDecision === "APPROVED" && unit.pr.unresolvedReviewThreads === 0;
  const hiddenDetails = compact ? [
    ...(reviewerColumn && reviewersOf(unit.pr).length > 0 ? [`Reviewers: ${reviewersLabel(reviewersOf(unit.pr))}`] : []),
    ...(resolvedThreads > 0 ? [`${resolvedThreads} review ${resolvedThreads === 1 ? "thread" : "threads"} resolved`] : []),
    ...(unit.observed?.status === false ? ["Working-tree status unavailable; rescan to check local edits"] : []),
    ...(!showSection ? [`Workstream: ${row.effort}`] : []),
    ...(risk.length > 0 ? [`High risk: ${risk.join(" · ")}`] : []),
    ...(row.cluster.linear?.url != null ? [`Linear: ${row.cluster.linear.url}`] : []),
  ] : [];
  const portalScope = usePortalScopeProps();
  const titleDetail = [titleHint({ title: row.title, repo: row.repo, pr: unit.pr, branch: unit.branch, linear: row.cluster.linear }), ...hiddenDetails].join("\n");
  return (
    <li
      id={`inbox-${row.key}`}
      role="option"
      aria-selected={selected}
      aria-description={hiddenDetails.length > 0 ? hiddenDetails.join("; ") : undefined}
      onClick={onSelect}
      className={cn(
        "group min-w-0 cursor-default items-center rounded-md px-2 text-[12.5px]",
        compact ? cn("grid gap-x-2 gap-y-1 border-b border-border/40 py-2", tight ? "grid-cols-[minmax(0,1fr)_4rem_3rem]" : "grid-cols-[10.5rem_minmax(0,1fr)_4rem_3rem]") : "flex h-9 gap-3",
        selected ? "bg-foreground/[0.07] ring-1 ring-inset ring-ring/60" : "hover:bg-foreground/[0.035]",
      )}
    >
      <span className={compact ? "contents" : "flex min-w-0 flex-1 items-center gap-2"}>
        {row.verb === null && !showSection ? null : (
          <span className={cn("flex min-w-0 items-center gap-1", compact ? (tight ? "col-span-2 col-start-1 row-start-2" : "col-start-1 row-start-1") : "w-[11.5rem] shrink-0")}>
            <VerbChip verb={row.verb ?? INBOX_SECTION_LABEL[row.section]} section={row.section} action={row.action} onPrimary={onPrimary} />
            {unit.lifecycle === "awaiting-rereview" && unit.pr?.mergeStateStatus === "BEHIND" ? (
              <Tip label="The PR branch is behind its base. Update it before merging.">
                <span tabIndex={0} aria-label="Branch behind" className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">Behind</span>
              </Tip>
            ) : null}
          </span>
        )}
        <span className={cn("flex min-w-0 items-center gap-1.5", compact ? (tight ? "col-start-1 row-start-1" : "col-start-2 row-start-1") : "max-w-[11.5rem] shrink-0")}>
          <Tip label={row.repo}>
            <span className="min-w-0 max-w-[8rem] truncate font-semibold text-foreground">{row.repo}</span>
          </Tip>
          {unit.pr === null ? (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70" title={unit.observed?.pr === false ? "GitHub status unavailable; rescan to check for a pull request" : "No pull request found"}>{unit.observed?.pr === false ? "PR ?" : "—"}</span>
          ) : (
            <UrlLink
              href={unit.pr.url}
              onClick={(event) => event.stopPropagation()}
              className="shrink-0 font-mono text-[11.5px] font-medium text-foreground underline-offset-2 hover:underline"
            >
              #{unit.pr.number}
            </UrlLink>
          )}
        </span>
        {compact ? (
          <PopoverPrimitive.Root>
            <PopoverPrimitive.Trigger asChild>
              <button type="button" aria-label={`Details for ${row.repo}${unit.pr === null ? "" : ` #${unit.pr.number}`}: ${row.title}`} className={cn("min-w-0 truncate text-left text-foreground/80 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", tight ? "col-span-3 col-start-1 row-start-3" : "col-span-3 col-start-1 row-start-2")}>{row.title}</button>
            </PopoverPrimitive.Trigger>
            <PopoverPrimitive.Portal>
              <PopoverPrimitive.Content {...portalScope} side="bottom" align="start" sideOffset={4} collisionPadding={8} className="z-50 max-w-[min(24rem,calc(100vw-1rem))] whitespace-pre-line break-words rounded-lg border border-border bg-popover p-3 text-[12px] leading-5 text-popover-foreground shadow-md">
                {titleDetail}
              </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
          </PopoverPrimitive.Root>
        ) : (
          <Tip label={titleDetail}><span className="min-w-0 flex-1 truncate text-foreground/80">{row.title}</span></Tip>
        )}
        {candidate !== null && !compact ? (
          <Tip label={candidate.reason}>
            <span tabIndex={0} aria-label={`Next: ${DISPATCH_ACTION[candidate.action]}. ${candidate.reason}`} className="max-w-full shrink-0 truncate rounded border border-border px-1.5 py-0.5 text-[10.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">Next: {DISPATCH_ACTION[candidate.action]}</span>
          </Tip>
        ) : null}
      </span>
      <span className={compact ? "contents" : "flex min-w-0 shrink-0 items-center gap-x-3 gap-y-1"}>
        <span className={compact ? "contents" : "flex max-w-full shrink-0 flex-wrap items-center gap-x-3 gap-y-1"}>
          <Tip label={ageTip}>
            <span
              className={cn(
                "shrink-0 text-right font-mono text-[10.5px] tabular-nums",
                compact ? (tight ? "col-start-2 row-start-1" : "col-start-3 row-start-1") : "w-[4.8rem]",
                displayAge.basis === "pr" ? "text-foreground/80" : "text-muted-foreground/80",
              )}
            >
              {age}
            </span>
          </Tip>
          {row.run !== null && !compact ? (
            <span className="flex min-w-0 max-w-[13rem] shrink-0 items-center">
              <RunChip run={row.run} ageTip={ageTip} compact={false} onOpenThread={onOpenThread} />
            </span>
          ) : null}
          {resolvedThreads > 0 && !compact ? (
            <Tip label={approvedAfterReview
              ? `${resolvedThreads === 1 ? "The review thread is" : `All ${resolvedThreads} review threads are`} resolved; GitHub still marks this PR approved.`
              : `${resolvedThreads} review ${resolvedThreads === 1 ? "thread" : "threads"} resolved.`}>
              <span tabIndex={0} className="shrink-0 rounded text-[10px] text-muted-foreground/80 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {resolvedThreads} {resolvedThreads === 1 ? "thread" : "threads"} resolved
              </span>
            </Tip>
          ) : null}
          {unit.observed?.status === false && !compact ? <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400" title="Working-tree status unavailable; rescan to check local edits">git ?</span> : null}
          {reviewerColumn && !compact ? <ReviewerMarks reviewers={reviewersOf(unit.pr)} compact={compact} /> : null}
          {risk.length === 0 || compact ? null : (
            <Tip label="High risk: touches a surface that is hard to undo">
              <span
                tabIndex={0}
                aria-label={`High risk: touches ${risk.join(" and ")}`}
                className="shrink-0 rounded border border-rose-500/40 px-1 text-[10.5px] text-rose-700 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-rose-300"
              >
                {risk.join(" · ")}
              </span>
            </Tip>
          )}
        </span>
        <span className={cn("flex max-w-full shrink-0 items-center", compact ? (tight ? "col-start-3 row-start-1 justify-end gap-1" : "col-start-4 row-start-1 justify-end gap-1") : "gap-3")}>
          {showSection || compact ? null : (
            <Tip label={row.effort}>
              <span className="hidden min-w-0 max-w-32 truncate text-[11.5px] text-muted-foreground/80 lg:block">
                {row.effort}
              </span>
            </Tip>
          )}
          {row.cluster.linear?.url == null || compact ? null : (
            <UrlLink
              href={row.cluster.linear.url}
              onClick={(event) => event.stopPropagation()}
              className="shrink-0 text-[10.5px] text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
            >
              Linear
            </UrlLink>
          )}
          <span
            className={cn(
              "flex shrink-0 items-center",
              selected || compact ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            )}
          >
            <RowActionMenu
              hasThreads={threads.length > 0}
              hasOpenPr={unit.pr?.state === "OPEN"}
              onGoToThread={() => threads[0] !== undefined && onOpenThread(threads[0].id)}
              onMessageAgent={onMessageAgent}
              onOpenCheckout={onOpenCheckout}
              onNewThread={onStart}
            />
          </span>
          <ThreadMark threads={threads} onOpen={onOpenThread} onMore={onShowOnMap} />
        </span>
      </span>
      {compact && row.cluster.linear?.url != null ? (
        <UrlLink href={row.cluster.linear.url} onClick={(event) => event.stopPropagation()} className={cn("justify-self-end text-[10.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline", tight ? "col-start-3 row-start-2" : "col-start-4 row-start-2")}>Linear</UrlLink>
      ) : null}
      {compact && (row.run !== null || resolvedThreads > 0 || candidate !== null) ? (
        <span className={cn("flex min-w-0 items-center gap-3 overflow-hidden text-[10.5px] text-muted-foreground", tight ? "col-span-3 col-start-1 row-start-4" : "col-span-4 col-start-1 row-start-3")}>
          {candidate !== null ? (
            <Tip label={candidate.reason}>
              <span tabIndex={0} className="min-w-0 truncate font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">Next: {DISPATCH_ACTION[candidate.action]}</span>
            </Tip>
          ) : null}
          {row.run !== null ? <RunChip run={row.run} ageTip={ageTip} compact onOpenThread={onOpenThread} /> : null}
          {resolvedThreads > 0 ? (
            <Tip label={`${resolvedThreads} review ${resolvedThreads === 1 ? "thread" : "threads"} resolved${approvedAfterReview ? "; GitHub still marks this PR approved" : ""}.`}>
              <span tabIndex={0} className="min-w-0 truncate outline-none focus-visible:ring-2 focus-visible:ring-ring">{resolvedThreads} resolved{approvedAfterReview ? " · approved" : ""}</span>
            </Tip>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

// ---- the Agents strip ----------------------------------------------------------

type StripKind = "running" | "needs-you" | "done" | "failed";

const STRIP_MATCH: Record<StripKind, (status: RunStatus) => boolean> = {
  running: (status) => status === "running",
  "needs-you": (status) => status === "needs-you",
  done: (status) => status === "done" || status === "succeeded",
  failed: (status) => status === "failed",
};

/**
 * One quiet line, only while agents are working, waiting on you, or finished
 * in the last few hours. Each part jumps to the next row in that state.
 */
function AgentsStrip({ counts, onJump }: { counts: StripCounts; onJump: (kind: StripKind) => void }) {
  if (!counts.show) return null;
  const parts = (
    [
      ["running", counts.running, `${counts.running} running`],
      ["needs-you", counts.needsYou, `${counts.needsYou} needs you`],
      ["done", counts.doneToday, `${counts.doneToday} done today`],
      ["failed", counts.failedToday, `${counts.failedToday} failed today`],
    ] as const
  ).filter(([, count]) => count > 0);
  if (parts.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-border/60">
      <div role="status" aria-label="Agents" className="mx-auto flex w-full max-w-6xl items-center gap-1 px-4 py-1.5 text-[11.5px] text-muted-foreground">
        <span className="pr-1 font-medium text-foreground/80">Agents</span>
        {parts.map(([kind, , label], index) => (
          <span key={kind} className="flex items-center gap-1">
            {index === 0 ? null : <span aria-hidden>·</span>}
            <button
              type="button"
              onClick={() => onJump(kind)}
              aria-label={`${label}: go to the next one`}
              className={cn(
                "rounded px-1 outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                kind === "needs-you" && "font-medium text-rose-700 dark:text-rose-300",
              )}
            >
              {label}
            </button>
          </span>
        ))}
      </div>
    </div>
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
  groupBy,
  onGroupBy,
  prefs,
  onPrefs,
  surfaces,
  shown,
  total,
  dispatch,
  dispatchBusy,
  dispatchError,
  efforts,
  unavailableEffortName,
  focusedVisibleCount,
  focusedHasCheckout,
  filtersActive,
  onFocusEffort,
  onDispatchMode,
  dispatchControls,
  compact,
  tight,
}: {
  searchRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (next: string) => void;
  groupBy: InboxGrouping;
  onGroupBy: (next: InboxGrouping) => void;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  surfaces: readonly string[];
  shown: number;
  total: number;
  dispatch: Board["dispatch"];
  dispatchBusy: boolean;
  dispatchError: string | null;
  efforts: WorkstreamAttention[];
  unavailableEffortName: string | null;
  focusedVisibleCount: number;
  focusedHasCheckout: boolean;
  filtersActive: boolean;
  onFocusEffort: (key: string | null) => void;
  onDispatchMode: (mode: Board["dispatch"]["mode"]) => void;
  dispatchControls: boolean;
  compact: boolean;
  tight: boolean;
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
  const focusedAttention = efforts.find((effort) => effort.key === dispatch.effortKey);
  const focused = focusedAttention?.name ?? dispatch.effortKey;

  return (
    <div className="shrink-0 border-b border-border/60">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
        <label className={cn("flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2.5 focus-within:ring-2 focus-within:ring-ring", tight && !dispatchControls && "basis-full")}>
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
            placeholder={dispatchControls ? "Search tickets, PRs, titles, repos, workstreams" : "Search tickets, PRs, titles, repos, efforts"}
            aria-label="Search the board"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/70"
          />
          <kbd className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">/</kbd>
        </label>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {shown === total ? `${total} rows` : `${shown} of ${total}`}
        </span>
        {dispatchControls ? null : <label className="flex h-8 shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          View
          <select
            value={groupBy}
            onChange={(event) => onGroupBy(event.target.value as InboxGrouping)}
            aria-label="Group rows by"
            className="h-8 rounded-md border border-border bg-background px-1.5 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="effort">By effort</option>
            <option value="action">Next action</option>
          </select>
        </label>}
        <ArchivedThreadsButton />
        <div ref={rootRef} className="relative shrink-0">
          <Tip label="Filter rows by last commit, surface or clones">
            <button
              type="button"
              aria-expanded={open}
              aria-label={`Filter rows by last commit, surface or clones${active > 0 ? ` (${active} on)` : ""}`}
              onClick={() => setOpen((current) => !current)}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] hover:bg-foreground/[0.06]",
                active > 0 ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <Icon name="FilterHorizontal" className="size-3.5" />
              Filter{active > 0 ? ` · ${active}` : ""}
            </button>
          </Tip>
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
      </div>
      {dispatchControls ? (
        <div className={cn("mx-auto w-full max-w-6xl items-center gap-x-3 gap-y-2 border-t border-border/40 px-4 py-2 text-[11.5px]", compact ? (tight ? "grid grid-cols-[minmax(0,1fr)_auto]" : "grid grid-cols-[minmax(0,1fr)_auto_auto]") : "flex flex-wrap")}>
          <span className={cn("shrink-0 font-semibold text-foreground", compact && "sr-only")}>Agent actions</span>
          <div className={cn("flex min-w-0 items-center gap-1.5 text-muted-foreground", compact && tight && "col-span-2")}>
            <span id="workstream-chooser-label" className={compact ? "sr-only" : undefined}>Workstream</span>
            <SelectPrimitive.Root
              value={dispatch.effortKey ?? "__none__"}
              onValueChange={(value) => onFocusEffort(value === "__none__" ? null : value)}
              disabled={dispatchBusy}
            >
              <SelectPrimitive.Trigger
                aria-labelledby="workstream-chooser-label"
                className={cn("flex h-10 min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2 text-left text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", compact ? "w-full" : "w-64 max-w-[min(19rem,60vw)]")}
              >
                <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
                  <span className="w-full truncate font-medium" title={focused ?? undefined}>{focused ?? "Choose workstream"}</span>
                  {focusedAttention !== undefined ? (
                    <span className="mt-0.5 max-w-full truncate rounded bg-foreground/[0.06] px-1 text-[10px] text-muted-foreground">{attentionLabel(focusedAttention)}</span>
                  ) : null}
                </span>
                <SelectPrimitive.Icon><Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" /></SelectPrimitive.Icon>
              </SelectPrimitive.Trigger>
              <SelectPrimitive.Portal>
                <SelectPrimitive.Content
                  {...usePortalScopeProps()}
                  position="popper"
                  sideOffset={4}
                  collisionPadding={8}
                  className="z-50 max-h-[min(24rem,var(--radix-select-content-available-height))] w-[min(24rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none"
                >
                  <SelectPrimitive.Viewport className="max-h-[22rem] w-full min-w-0 overflow-y-auto">
                    <SelectPrimitive.Item value="__none__" className="relative flex cursor-pointer items-center rounded-md px-2 py-2 text-[12px] text-muted-foreground outline-none focus:bg-foreground/[0.07]">
                      <SelectPrimitive.ItemText>No workstream</SelectPrimitive.ItemText>
                    </SelectPrimitive.Item>
                    {dispatch.effortKey !== null && focusedAttention === undefined ? (
                      <SelectPrimitive.Item value={dispatch.effortKey} className="relative flex cursor-pointer items-center rounded-md px-2 py-2 text-[12px] outline-none focus:bg-foreground/[0.07]">
                        <SelectPrimitive.ItemText>{unavailableEffortName ?? dispatch.effortKey}</SelectPrimitive.ItemText>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">No current rows</span>
                      </SelectPrimitive.Item>
                    ) : null}
                    {efforts.map((effort) => (
                      <SelectPrimitive.Item key={effort.key} value={effort.key} title={effort.name} className="relative grid w-full min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-2 text-[12px] outline-none focus:bg-foreground/[0.07] data-[state=checked]:bg-foreground/[0.04]">
                        <SelectPrimitive.ItemText className="min-w-0 overflow-hidden"><span className="block w-full truncate font-medium">{effort.name}</span></SelectPrimitive.ItemText>
                        <span className="max-w-[10rem] truncate rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10.5px] text-muted-foreground">{attentionLabel(effort)}</span>
                      </SelectPrimitive.Item>
                    ))}
                  </SelectPrimitive.Viewport>
                </SelectPrimitive.Content>
              </SelectPrimitive.Portal>
            </SelectPrimitive.Root>
          </div>
          <div role="group" aria-label="Agent action mode" className={cn("flex shrink-0 items-center gap-1 rounded-md border border-border p-0.5", compact && "justify-self-start")}>
            {(["off", "shadow"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={dispatch.mode === mode}
                disabled={dispatchBusy || (mode === "shadow" && dispatch.effortKey === null)}
                onClick={() => onDispatchMode(mode)}
                className={cn(
                  "rounded px-2 py-1 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
                  dispatch.mode === mode ? "bg-foreground/[0.09] font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/[0.05]",
                )}
              >
                {mode === "off" ? "Off" : "Preview only"}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-pressed={dispatch.mode === "auto"}
            aria-label={focused ? `${dispatch.mode === "auto" ? "Running automatically" : "Run automatically"} for ${focused}` : "Run automatically"}
            disabled={dispatchBusy || dispatch.mode !== "shadow" || dispatch.effortKey === null || !focusedHasCheckout}
            onClick={() => onDispatchMode("auto")}
            className={cn(
              "h-8 max-w-full truncate rounded-md border px-2.5 text-[11.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              dispatch.mode === "auto" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : "border-border text-foreground hover:bg-foreground/[0.05]",
            )}
          >
            {dispatch.mode === "auto" ? "Running automatically" : "Run automatically"}
          </button>
          <span className={cn("min-w-0 text-muted-foreground", compact && (tight ? "col-span-2" : "col-span-3"))}>
            {dispatch.effortKey !== null && !focusedHasCheckout
              ? "No active checkout is linked. PR actions are available below; automatic repairs need a checkout."
              : dispatch.mode === "auto"
              ? "One agent at a time. Agents ask before pushing or replying. No automatic merges."
              : dispatch.mode === "shadow"
                ? "Shows the next action without starting an agent."
                : dispatch.effortKey === null ? "Off. Choose a workstream to preview the next action." : "Off. Select Preview only to see the next agent action."}
          </span>
          {focusedAttention !== undefined ? (
            <p className={cn("min-w-0 basis-full text-[11.5px] text-muted-foreground", compact && (tight ? "col-span-2" : "col-span-3"))} aria-live="polite">
              <span className="font-medium text-foreground">{focusedAttention.name} · What moves next across this effort:</span>{" "}
              {attentionDetail(focusedAttention)}
              {filtersActive ? ` ${focusedVisibleCount} match the current view.` : null}
            </p>
          ) : null}
        </div>
      ) : null}
      {dispatchControls && dispatchError !== null ? <p role="alert" className="mx-auto w-full max-w-6xl px-4 pb-2 text-[12px] text-destructive">{dispatchError}</p> : null}
    </div>
  );
}

const DISPATCH_ACTION: Record<NonNullable<Board["dispatch"]["candidate"]>["action"], string> = {
  "investigate-ci": "Investigate CI",
  "resolve-conflicts": "Resolve conflicts",
  "address-review": "Address review",
  "address-comments": "Address comments",
  "review-approval-note": "Review approval note",
};

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
      <DialogContent className={cn("max-w-xl", POINTER_CURSORS)}>
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
