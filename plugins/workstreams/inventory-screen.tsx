// All PRs is the action view. Your turn lists unanswered feedback; Other open PRs lists the remaining open work.
// Both lists select for Advance selected and Move to effort. Address remains the feedback-specific batch action.
// A confirmed Advance selection starts one fresh context for exactly those PRs, with heads and holds rechecked.
// Cards link here to the exact PR row; the shared action controls keep confirmations and merge previews in this view.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useBbContext, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { InventoryRow, InventoryView } from "./inventory-view";
import type { rpcContract } from "./server";
import { cn, POINTER_CURSORS } from "./lib/utils";
import { SimpleInventoryList, type SimpleGroup } from "./inventory-rows";
import { MovePicker, useRouting, type MovePickerProps, type MoveTarget } from "./inventory-routing";
import { actionCall, INVENTORY_CHANGED, inventoryScreen, onYourTurn, pickRows, sendable, type InventoryLine, type InventoryScreen, type LineAction,
  type Outcome, type RowSuggestion } from "./inventory-view-model";
import { ACTION, type DeckActionId } from "./deck-keys";
import { readSeen, SEEN_KEY } from "./deck-place";
import { cardScreen, availability, hintKeys, paletteItems, paletteMatch, type CardScreen, type KeyContext, type PaletteItem } from "./deck-view-model";
import { BUTTON, COLUMN, CONTENT, COUNT, GHOST, HelpBody, HintBar, Kbd, PaletteBody, RefreshSelected, RING, SECTION_HEAD, Spin, TONE, WorkstreamsHeader, type HeaderProps,
  HoldBody, type HeaderTarget } from "./deck-screen";
import { DeckDialog, useBatchConfirm, useRefresh, useRegistryKeys, workingLabel, type LiveItems, type Undo, type Working } from "./deck-flow";

import { useDeck } from "./deck-read";
import { cardPrActions, cardPrIntent, type CardPrActionId, type CardPrContext } from "./deck-pr-actions";
import { useNotesConfirm } from "./notes-flow";
import { MergePreviewDialog } from "./merge-preview-dialog";

const REGION = cn("flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground", POINTER_CURSORS);
/** The scroller under the header, a container so the deck's column widens its gutters in a wide pane. */
const SCROLLER = "@container min-h-0 flex-1 overflow-y-auto overscroll-contain";
/** The deck's empty state. */
const EMPTY = "py-8 text-center text-[12px] text-muted-foreground";

/** Your turn, the rows you dismissed from it, and every other open PR, each by effort; a PR shows in only one. */
export function splitInventory(screen: InventoryScreen): { turn: SimpleGroup[]; dismissed: SimpleGroup[]; other: SimpleGroup[] } {
  const split = { turn: [] as SimpleGroup[], dismissed: [] as SimpleGroup[], other: [] as SimpleGroup[] };
  for (const group of screen.groups) {
    const identity = { key: group.key, label: group.label, effortId: group.effort?.id ?? null };
    const of = (line: InventoryLine) => onYourTurn(line) ? split.turn : line.turn.list === "dismissed" ? split.dismissed : split.other;
    for (const list of [split.turn, split.dismissed, split.other]) {
      const lines = group.lines.filter((line) => of(line) === list);
      if (lines.length) list.push({ ...identity, lines });
    }
  }
  return split;
}
/** The rows a click or x selects, in drawn order: Your turn's while Address can take them, then every other open PR. */
const selectable = (split: ReturnType<typeof splitInventory>) => [...split.turn.flatMap((group) => group.lines).filter(sendable),
  ...split.other.flatMap((group) => group.lines)];

/** The shared header, with this read's freshness; ⌘K and ? open the deck's palette and key sheet. */
function Header({ read, onView, onPalette, onHelp }: { read: HeaderProps["read"]; onView(target: HeaderTarget): void; onPalette(): void; onHelp(): void }) {
  return <WorkstreamsHeader view="inventory" read={read} palette="all actions" help="Keys and colors" onView={onView} onPalette={onPalette} onHelp={onHelp} />;
}

export function InventoryPending({ error, onRetry, onView, onPalette, onHelp }: { error: string | null; onRetry(): void; onView(target: HeaderTarget): void;
  onPalette(): void; onHelp(): void }) {
  return <div role="region" aria-label="PR inventory" className={REGION}>
    <Header read={{ text: error ? "Read failed" : "Reading…", error: null }} onView={onView} onPalette={onPalette} onHelp={onHelp} />
    <div className={SCROLLER}><div className={CONTENT}>
      <p className={cn(EMPTY, error && "text-foreground")} role={error ? "alert" : "status"}>
        {error ? <>Couldn't read the inventory: {error} <button type="button" onClick={onRetry} className={cn("ml-1 rounded-sm underline", RING)}>Retry</button></>
          : "Reading your open PRs…"}
      </p>
    </div></div>
  </div>;
}

function Notice({ notice }: { notice: InventoryScreen["notices"][number] }) {
  return <p role={notice.tone === "error" ? "alert" : "status"}
    className={cn("text-[12px]", notice.tone === "error" ? "text-destructive" : "text-muted-foreground")}>{notice.text}</p>;
}

/** Why Address can't take a selection: a row in it isn't a Your turn row Address can take. */
const ADDRESS_ONLY = "Address takes Your turn rows only.";
/**
 * The selected rows, docked under the lists: advance them together, address unanswered feedback, move, refresh, or clear.
 */
function SelectionBar({ count, addressable, refusal, working, refresh, move, onAddress, onAdvance, onRefresh, onClear }: { count: number; addressable: boolean;
  refusal?: string | null; working?: Working | null; refresh?: { busy: boolean; progress: string | null }; move?: MovePickerProps; onAddress(): void; onAdvance?(): void;
  onRefresh(): void; onClear(): void }) {
  if (!count) return null;
  const note = refusal ?? (addressable || onAdvance ? null : ADDRESS_ONLY);
  return <div aria-label="Selection" className="shrink-0 border-t border-border bg-background">
    <div className={cn(COLUMN, "flex flex-wrap items-center gap-1.5 px-4 py-1.5 text-[12px]")}>
      <b className="mr-1 font-semibold">{count} selected</b>
      {addressable ? <button type="button" data-inventory-action="address" disabled={!!working} aria-busy={working?.kind === "address" || undefined} onClick={onAddress}
        title="Starts one thread for them now, with 8 s to Undo. Nothing merges."
        className={cn(BUTTON, "border-foreground bg-foreground font-medium text-background", working?.kind === "address" && "disabled:opacity-100")}>
        {working?.kind === "address" ? <><Spin />{workingLabel(working)}</> : <>Address {count}<Kbd inverted>{ACTION.address.keys[0]}</Kbd></>}</button> : null}
      {onAdvance ? <button type="button" data-inventory-action="advance-selected" disabled={!!working} onClick={onAdvance}
        title="Review this selection, then advance it together in one fresh thread. Nothing merges." className={cn(BUTTON, "border-border hover:bg-foreground/[0.04]")}>Advance selected</button> : null}
      {move ? <MovePicker {...move} /> : null}
      <RefreshSelected count={count} busy={!!refresh?.busy} progress={refresh?.progress ?? null} onClick={onRefresh} />
      {/* A refusal, or why Address can't take these, takes the room before Clear and truncates there, so the column's narrower bar never wraps
          Clear to a line of its own. */}
      {note ? <span role={refusal ? "alert" : "status"} data-inventory-refusal className={cn("min-w-0 flex-1 basis-0 truncate", refusal ? "text-destructive" : "text-muted-foreground")}
        title={note}>{note}</span> : <span className="flex-1" />}
      <button type="button" onClick={onClear} className={GHOST}>Clear<Kbd>esc</Kbd></button>
    </div>
  </div>;
}

export function InventoryPane(props: { screen: InventoryScreen; busyKey: string | null; error: string | null;
  onView(target: HeaderTarget): void; onPalette(): void; onHelp(): void; onOpenPr(url: string): void; onOpenThread(id: string): void; onOpenEffort(effortId: string): void;
  renderActions?(line: InventoryLine): ReactNode;
  planner?: { busy: boolean; error: string | null; onPlan(): void };
  onNudge(line: InventoryLine, action: LineAction): void; rootRef?: RefObject<HTMLDivElement | null>;
  /** Rows selected, by PR; a row's checkbox, Your turn's box for all or none of it, Address, Move to effort…'s picker, and Clear. */
  selected?: ReadonlySet<string>; onSelect?(line: InventoryLine, shift: boolean): void; onSelectAll?(all: boolean): void; onSelectOther?(all: boolean): void; onAddress?(): void; onAdvance?(): void; onClear?(): void;
  move?: MovePickerProps;
  /** The classifier's suggestion for each row no effort owns, by PR, with accepting rows' suggestions, and hiding one. */
  suggestions?: ReadonlyMap<string, RowSuggestion>; onAccept?(lines: InventoryLine[]): void; onDismissSuggestion?(line: InventoryLine): void;
  /** Why the last Address started nothing, and why it didn't send each PR, by PR; a batch's Undo from its row; and Dismiss and back. */
  refusal?: string | null; notes?: ReadonlyMap<string, string>; onUndo?(batchId: string): void; onDismiss?(line: InventoryLine, dismiss: boolean): void;
  /** A batch call out now, whose rows show pending; and each item of a batch sending now, by PR. */
  working?: Working | null; live?: LiveItems;
  /** The deck's shared hint bar, under the lists. */
  footer?: ReactNode;
  /** ↻ on a row, Refresh on the selection, and a click on Last read; the rows reading now, and the selection's progress. */
  onRefresh?(line: InventoryLine): void; onRefreshSelected?(): void; onRefreshAll?(): void; reading?: ReadonlySet<string>; refresh?: { busy: boolean; progress: string | null } }) {
  const split = splitInventory(props.screen);
  const { turn, dismissed, other } = split;
  const [primaryNotice, ...otherNotices] = props.screen.notices;
  const callbacks = { busyKey: props.busyKey, onOpenPr: props.onOpenPr, onOpenThread: props.onOpenThread,
    onOpenEffort: props.onOpenEffort, onNudge: props.onNudge, renderActions: props.renderActions, onRefresh: props.onRefresh, reading: props.reading, onDismiss: props.onDismiss };
  // Your turn's box takes only the Your turn rows Address can; the bar counts every selected row, and Address takes them only if it can take each.
  const turnLines = turn.flatMap((group) => group.lines).filter(sendable);
  const turnPicked = turnLines.filter((line) => props.selected?.has(line.prUrl)).length;
  const otherLines = other.flatMap((group) => group.lines);
  const otherPicked = otherLines.filter((line) => props.selected?.has(line.prUrl)).length;
  const chosen = selectable(split).filter((line) => props.selected?.has(line.prUrl));
  const listed = turn.reduce((sum, group) => sum + group.lines.length, 0);
  const hidden = dismissed.reduce((sum, group) => sum + group.lines.length, 0);
  const pick = { selected: props.selected, onSelect: props.onSelect, suggestions: props.suggestions, onAccept: props.onAccept, onDismissSuggestion: props.onDismissSuggestion };
  const rows = { ...callbacks, ...pick, notes: props.notes, onUndo: props.onUndo, working: props.working?.prUrls, live: props.live };
  return <div ref={props.rootRef} role="region" aria-label="PR inventory" className={REGION}>
    <Header read={{ text: props.screen.read.text, title: props.screen.read.title, busy: props.screen.read.refreshing, error: null, onRefresh: props.onRefreshAll }} onView={props.onView}
      onPalette={props.onPalette} onHelp={props.onHelp} />
    <div className={SCROLLER}><div className={CONTENT}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 pl-2"><h1 className="text-[16px] font-semibold">All PRs</h1>
        {props.planner ? <button type="button" data-inventory-plan-all disabled={props.planner.busy || !props.screen.groups.some((g) => g.lines.length)}
          aria-busy={props.planner.busy || undefined} onClick={props.planner.onPlan} title="Start a planning thread for all open PRs except those on hold. Jev groups attention; the thread prioritizes a plan."
          className={cn(BUTTON, "h-7 border-border px-2.5 hover:bg-foreground/[0.04]")}>{props.planner.busy ? <><Spin />Planning…</> : "Plan Advance All"}</button> : null}
      </div>
      {props.planner?.error ? <p role="alert" className="mb-3 px-2 text-[12px] text-destructive">{props.planner.error}</p> : null}
      {props.error || props.screen.notices.length ? <div className="grid gap-1 px-2 pb-3">
        {props.error ? <p role="alert" className="text-[12px] text-destructive">Couldn't read the inventory: {props.error}</p> : null}
        {primaryNotice ? <Notice notice={primaryNotice} /> : null}
        {otherNotices.length ? <details className="text-[11px] text-muted-foreground">
          <summary className={cn("w-fit rounded-sm hover:text-foreground", RING)}>{otherNotices.length} more inventory {otherNotices.length === 1 ? "notice" : "notices"}</summary>
          <div className="grid gap-1 pt-2">{otherNotices.map((notice) => <Notice key={notice.text} notice={notice} />)}</div>
        </details> : null}
      </div> : null}
      {/* The deck's section headings: a colored bar, then the title and its count. Your turn is yours, so it takes the deck's blue for your moves. */}
      <section aria-label="Your turn">
        <div className={SECTION_HEAD}>
          <span aria-hidden className={cn("h-3.5 w-[3px] shrink-0 rounded-full", TONE.blue.edge)} />
          {turnLines.length && props.onSelectAll ? <input type="checkbox" data-inventory-select-all checked={turnPicked === turnLines.length}
            ref={(element) => { if (element) element.indeterminate = turnPicked > 0 && turnPicked < turnLines.length; }}
            aria-label={turnPicked === turnLines.length ? "Clear the selection" : "Select every Your turn PR"} onChange={() => props.onSelectAll!(turnPicked < turnLines.length)}
            className="size-3.5 shrink-0 accent-sky-600" /> : null}
          <h2 className="truncate text-[12.5px] font-semibold">Your turn</h2>
          <span className={cn(COUNT, listed ? cn("font-semibold", TONE.blue.chip) : "text-muted-foreground")}>{listed}</span>
        </div>
        {turn.length ? <SimpleInventoryList groups={turn} kind="turn" {...rows} />
          : <p className={EMPTY}>Nothing waits on you.</p>}
        {hidden ? <details className="pb-1.5" data-inventory-dismissed>
          <summary className={cn("ml-9 w-fit rounded-sm text-[11px] text-muted-foreground hover:text-foreground", RING)}>{hidden} dismissed · show</summary>
          <SimpleInventoryList groups={dismissed} kind="dismissed" {...callbacks} />
        </details> : null}
      </section>
      <section className="mt-6" aria-label="Other open PRs">
        <div className={SECTION_HEAD}>
          <span aria-hidden className={cn("h-3.5 w-[3px] shrink-0 rounded-full", TONE.gray.edge)} />
          {otherLines.length && props.onSelectOther ? <input type="checkbox" data-inventory-select-other checked={otherPicked === otherLines.length}
            ref={(element) => { if (element) element.indeterminate = otherPicked > 0 && otherPicked < otherLines.length; }}
            aria-label={otherPicked === otherLines.length ? "Clear Other open PRs selection" : "Select every Other open PR"} onChange={() => props.onSelectOther!(otherPicked < otherLines.length)}
            className="size-3.5 shrink-0 accent-sky-600" /> : null}
          <h2 className="truncate text-[12.5px] font-semibold">Other open PRs</h2>
          <span className={cn(COUNT, "text-muted-foreground")}>{other.reduce((sum, group) => sum + group.lines.length, 0)}</span>
        </div>
        {other.length ? <SimpleInventoryList groups={other} kind="other" {...callbacks} {...pick} />
          : <p className={EMPTY}>{props.screen.empty ?? "No other open PRs."}</p>}
      </section>
    </div></div>
    <SelectionBar count={chosen.length} addressable={chosen.every(sendable)} refusal={props.refusal} working={props.working} refresh={props.refresh} move={props.move}
      onAddress={() => props.onAddress?.()} onAdvance={props.onAdvance} onRefresh={() => props.onRefreshSelected?.()} onClear={() => props.onClear?.()} />
    {props.footer}
  </div>;
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
/** inventory_get, read again on each inventory change, a board change you can see, and when the page shows again: never on a timer. */
export function useInventory() {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<InventoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);
  const again = useRef(false);
  const load = useCallback(function read(): void {
    if (reading.current) { again.current = true; return; }
    reading.current = true;
    rpc.call("inventory_get", {}).then((next) => { setView(next); setError(null); }, (cause: unknown) => setError(message(cause))).finally(() => {
      reading.current = false;
      if (again.current) { again.current = false; read(); }
    });
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(INVENTORY_CHANGED, () => load());
  useRealtime("board-changed", () => { if (document.visibilityState === "visible") load(); });
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [load]);
  return { view, error, load };
}

/** Show the exact scope before starting one fresh worker for the selection. */
export function AdvanceSelectionBody({ lines, busy, error, onConfirm, onCancel }: { lines: readonly InventoryLine[]; busy: boolean; error: string | null; onConfirm(): void; onCancel(): void }) {
  const allowed = lines.filter((l) => !l.hold && !l.effortPile);
  return <div className="grid gap-3 text-[12px]">
    <p>One fresh thread will work on the selected PRs, in dependency order. Nothing merges. Previous threads stay as they are.</p>
    <ul className="grid gap-2">{lines.map((l) => <li key={l.prUrl} className="min-w-0"><b>{l.repo} #{l.number}</b> · {l.title}<p className="text-muted-foreground">{l.hold ? `Excluded: on hold${l.hold.reason ? ` — ${l.hold.reason}` : ""}` : l.effortPile ? `Excluded: effort is ${l.effortPile}` : l.status}</p></li>)}</ul>
    <p className="text-muted-foreground">Current heads and holds are checked again before starting. Other workers and checkout conflicts are yours to manage.</p>
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    <div className="flex gap-2"><button type="button" disabled={busy || !allowed.length} onClick={onConfirm} className={cn(BUTTON, "border-foreground bg-foreground text-background")}>{busy ? <><Spin />Starting…</> : `Advance ${allowed.length} in one thread`}</button><button type="button" disabled={busy} onClick={onCancel} className={GHOST}>Cancel</button></div>
  </div>;
}

export function PrActionControls({ source, line, context, onAction, note }: { source: CardScreen; line: InventoryLine; context: CardPrContext;
  onAction(id: CardPrActionId): void; note?: string }) {
    const actions = cardPrActions(source, line.prUrl, line, context).filter((action) => !["move", "dismiss", "undismiss", "refresh"].includes(action.id));
    const buttons = (secondary: boolean) => actions.filter((action) => action.secondary === secondary).map((action) => <button key={action.id} type="button"
      data-inventory-pr-action={action.id} disabled={!action.enabled} title={action.why ?? action.title} aria-label={`${action.label.replace(/…$/u, "")} for ${line.repo} #${line.number}`}
      onClick={() => onAction(action.id)} className={cn(secondary ? GHOST : BUTTON, secondary ? "h-5 px-1 text-[11px]" : "h-6 text-[11.5px] border-border hover:bg-foreground/[0.04]")}>{action.label}</button>);
    return <><div className="flex flex-wrap items-center gap-1.5">{buttons(false)}{actions.some((a) => a.secondary) ? <details className="text-[11px] text-muted-foreground"><summary className={cn("cursor-pointer rounded-sm", RING)}>More</summary><div className="mt-1 flex flex-wrap gap-1">{buttons(true)}</div></details> : null}</div>
      {note ? <p role="status" className="mt-1 text-[11px] text-muted-foreground">{note}</p> : null}</>;
}

export function InventoryNavView({ onView, openPr = null }: { onView(target: HeaderTarget): void; openPr?: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { view, error, load: loadInventory } = useInventory();
  const bbContext = useBbContext();
  const deck = useDeck(() => ({}), () => [], () => undefined);
  const load = useCallback(() => { loadInventory(); deck.load(); }, [loadInventory, deck.load]);
  const [merging, setMerging] = useState<string | null>(null);
  const [hold, setHold] = useState<{ prUrl: string; ref: string; reason: string; busy: boolean; error: string | null } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const planBusy = useRef(false);
  const planRequest = useRef<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const now = Date.now();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(() => new Map<string, InventoryRow>(view?.groups.flatMap((group) => group.rows.map((row) => [row.prUrl, row] as const)) ?? []), [view]);
  const nudge = async (line: InventoryLine, action: LineAction) => {
    if (busyKey || !action.enabled) return;
    const row = rows.get(line.prUrl);
    if (!row) return;
    const call = actionCall(row, action);
    if (call.kind !== "rpc" || call.method !== "inventory_nudge") return;
    setBusyKey(line.prUrl);
    try {
      const result = await rpc.call("inventory_nudge", call.input);
      setOutcomes((current) => new Map([...current, [line.prUrl, { at: Date.now(), action: "nudge", ok: result.ok,
        text: result.ok ? result.detail : result.error }]]));
      load();
    } catch (cause) {
      setOutcomes((current) => new Map([...current, [line.prUrl, { at: Date.now(), action: "nudge", ok: false, text: message(cause) }]]));
    } finally { setBusyKey(null); }
  };

  // ---- the deck's shared keys, hint bar, palette, and ? sheet ----------------
  const [dialog, setDialog] = useState<{ kind: "palette"; query: string; highlight: number } | { kind: "help" } | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [flash, setFlash] = useState<{ text: string; undo: boolean } | null>(null);
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const [advancing, setAdvancing] = useState<{ lines: InventoryLine[]; targets: { prUrl: string; headOid: string }[]; busy: boolean; error: string | null } | null>(null);
  const advanceBusy = useRef(false);
  const anchor = useRef<string | null>(null);
  // A selected row that can't be selected now (a batch took it from Your turn, or it closed) stays unselected if it comes back.
  useEffect(() => {
    if (!view) return;
    const live = new Set(selectable(splitInventory(inventoryScreen(view, { now: Date.now(), filter: null }))).map((line) => line.prUrl));
    setPicked((current) => [...current].every((prUrl) => live.has(prUrl)) ? current : new Set([...current].filter((prUrl) => live.has(prUrl))));
  }, [view]);
  const opener = useRef<HTMLElement | null>(null);
  const flashTimer = useRef<number | null>(null);
  const say = useCallback((text: string, withUndo = false, ms?: number) => {
    setFlash({ text, undo: withUndo });
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), ms ?? (withUndo ? 9_000 : 5_000));
  }, []);
  const refresh = useRefresh({ say, reads: () => load() });
  const routing = useRouting({ say, setUndo });
  // After a move, focus follows the row it left from to its new group once the list reads it there.
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const row = refocus.current ? rootRef.current?.querySelector<HTMLElement>(`[data-inventory-row="${CSS.escape(refocus.current)}"]`) : null;
    if (!row) return;
    refocus.current = null;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }, [view]);
  // A row's newer outcome wins: a read after a Nudge, or a Nudge after a read.
  const screen = useMemo(() => view && inventoryScreen(view, { now, filter: null, pending: new Map([...refresh.reading].map((prUrl) => [prUrl, "refresh" as const])),
    outcomes: new Map([...outcomes, ...[...refresh.outcomes].filter(([prUrl, outcome]) => (outcomes.get(prUrl)?.at ?? 0) <= outcome.at)]) }),
  [view, now, outcomes, refresh.reading, refresh.outcomes]);
  const arrived = useRef<string | null>(null);
  useEffect(() => {
    if (!openPr) { arrived.current = null; return; }
    if (!screen || arrived.current === openPr) return;
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-inventory-row="${CSS.escape(openPr)}"]`);
    if (row) {
      const hidden = row.closest<HTMLDetailsElement>("details"); if (hidden) hidden.open = true;
      row.focus({ preventScroll: true }); row.scrollIntoView({ block: "center" }); setActiveRow(openPr);
    } else say("This PR is no longer in the open inventory. Refresh to check its current state.");
    arrived.current = openPr;
    navigate.toPluginPanel("board", { subPath: "inventory", replace: true });
  }, [openPr, screen, navigate, say]);
  const remember = () => { opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : opener.current; };
  /** Back to the control that opened a dialog, or its row, never the page body. */
  const returnFocus = () => window.requestAnimationFrame(() => {
    const element = opener.current;
    const row = activeRow ? rootRef.current?.querySelector<HTMLElement>(`[data-inventory-row="${CSS.escape(activeRow)}"]`) : null;
    (element?.isConnected ? element : row ?? rootRef.current?.querySelector<HTMLElement>("[data-inventory-row]"))?.focus({ preventScroll: true });
  });
  const batch = useBatchConfirm({ seenAt: () => { try { return readSeen(window.localStorage.getItem(SEEN_KEY), Date.now()).at; } catch { return {}; } },
    scopeName: () => null, say, setUndo, load, onOpen: remember, onReturn: returnFocus, reread: view });
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onIn = (event: FocusEvent) => setActiveRow((event.target as Element).closest<HTMLElement>("[data-inventory-row]")?.dataset.inventoryRow ?? null);
    root.addEventListener("focusin", onIn);
    return () => root.removeEventListener("focusin", onIn);
  });
  const notesConfirm = useNotesConfirm({ say, load, onOpen: remember, onReturn: returnFocus, ask: (prUrl, effortId) => void batch.plan("ask", effortId, [prUrl]) });
  const sources = useMemo(() => {
    const cards = [...(deck.view?.active ?? []), ...(deck.view?.held ?? [])].map((card) => cardScreen(card, { rows: {} }, { now }));
    return new Map(cards.flatMap((card) => card.lines.flatMap((line) => line.row ? [[line.prUrl, card] as const] : [])));
  }, [deck.view, now]);
  const prContext = { live: batch.live, working: batch.working?.prUrls, reading: refresh.reading };
  const runPrAction = (line: InventoryLine, id: CardPrActionId) => {
    const source = sources.get(line.prUrl);
    const intent = source ? cardPrIntent(source, line.prUrl, id, line, prContext) : null;
    if (!intent) { say("This action is no longer available. Refresh the PR to check its current state."); return; }
    remember();
    switch (intent.kind) {
      case "restart": { const headOid = rows.get(intent.prUrl)?.head; if (!headOid) { say("Refresh to read the PR head first."); return; } void rpc.call("inventory_restart_thread", { prUrl: intent.prUrl, headOid, ...(bbContext.projectId ? { projectId: bbContext.projectId } : {}) }).then((result) => {
        if (!result.ok) { say(result.error); return; } load(); navigate.toThread(result.threadId);
      }, (cause: unknown) => say(String(cause))); return; }
      case "batch": void batch.plan(intent.action, intent.effortId, intent.prUrls); return;
      case "address": void batch.address(intent.effortId, intent.prUrls); return;
      case "merge": setMerging(intent.prUrl); return;
      case "notes": notesConfirm.show(intent.prUrl, intent.ref, intent.effortId); return;
      case "hold": setHold({ prUrl: intent.prUrl, ref: intent.ref, reason: "", busy: false, error: null }); return;
      case "move": setPicked(new Set(intent.prUrls)); setMoving(true); return;
      case "refresh": void refresh.read(intent.prUrls); return;
      case "revoke": void rpc.call("inventory_confirm_revoke", { prUrl: intent.prUrl }).then((result) => { say(result.ok ? result.detail : result.error); load(); }, (cause: unknown) => say(String(cause))); return;
      case "dismiss": dismiss(line, intent.dismiss); return;
    }
  };
  const renderActions = (line: InventoryLine) => {
    const source = sources.get(line.prUrl);
    if (!source) return <p className="text-[11px] text-muted-foreground">{deck.error ? "Couldn't read action context. Refresh to retry." : deck.view ? "This effort is completed or archived. Reopen it in Efforts to act on this PR." : "Reading action context…"}</p>;
    return <PrActionControls source={source} line={line} context={prContext} onAction={(id) => runPrAction(line, id)} note={batch.details.get(line.prUrl)} />;
  };
  const holdNow = async () => {
    if (!hold || hold.busy) return;
    setHold({ ...hold, busy: true, error: null });
    try {
      const result = await rpc.call("pr_hold_set", { prUrl: hold.prUrl, held: true, reason: hold.reason.trim() || undefined });
      setHold(null); load(); returnFocus();
    } catch (cause) { setHold({ ...hold, busy: false, error: String(cause) }); }
  };
  const planAll = async () => {
    if (planBusy.current) return;
    planBusy.current = true; setPlanning(true); setPlanError(null);
    planRequest.current ??= crypto.randomUUID();
    try {
      const result = await rpc.call("inventory_plan_advance", { requestId: planRequest.current, ...(bbContext.projectId ? { projectId: bbContext.projectId } : {}) });
      if (result.ok) { planRequest.current = null; navigate.toThread(result.threadId); }
      else setPlanError(result.error);
    } catch (cause) { setPlanError(String(cause)); }
    finally { planBusy.current = false; setPlanning(false); }
  };
  // The focused row, in either list: a PR shows in only one.
  const focused = activeRow ? screen?.groups.flatMap((group) => group.lines).find((line) => `${line.slug}#${line.number}` === activeRow) ?? null : null;
  // Nudge is due exactly where its row shows the button; so is Refresh.
  const due = focused?.actions.find((action) => action.id === "nudge" && action.enabled) ?? null;
  const readable = !!focused?.actions.some((action) => action.id === "refresh" && action.enabled);
  const thread = focused?.actions.find((action) => action.id === "thread" && action.enabled)?.threadId ?? null;
  // The rows in drawn order, which a Shift-click's range follows, less Your turn rows a batch still works on; a selected row that leaves
  // them is no longer selected. Address takes the selection only while it can take every row in it.
  const split = screen ? splitInventory(screen) : null;
  const turnLines = split ? split.turn.flatMap((group) => group.lines).filter(sendable) : [];
  const order = split ? selectable(split) : [];
  const chosen = order.filter((line) => picked.has(line.prUrl));
  const selected = chosen.every(sendable) ? chosen : [];
  const toggle = (line: InventoryLine, shift: boolean) => {
    setPicked(pickRows(order.map((item) => item.prUrl), picked, line.prUrl, shift, anchor.current));
    anchor.current = line.prUrl;
  };
  const clear = () => { setPicked(new Set()); setMoving(false); };
  // A suggestion shows only on a row the list files under No effort, so one read before a move never shows on a row an effort has now.
  const loose = new Set(screen?.groups.find((group) => group.effort === null)?.lines.map((line) => line.prUrl));
  const suggestions = new Map([...routing.suggestions].filter(([prUrl]) => loose.has(prUrl)));
  const context: KeyContext = { view: "prs", cur: null, focused: null, selected: [], seenAvailable: false, undo: !!undo?.live(), held: 0, done: 0,
    prs: { row: !!focused, thread: !!thread, moves: new Set<DeckActionId>([...readable ? ["refresh" as const] : [], ...focused && sources.get(focused.prUrl) ? cardPrActions(sources.get(focused.prUrl)!, focused.prUrl, focused, prContext)
      .filter((a) => a.enabled).flatMap((a): DeckActionId[] => a.id === "dismiss" || a.id === "undismiss" || a.id === "restart" ? [] : [a.id === "hold" ? "hold-pr" : a.id]) : []]),
      selectable: !!focused && order.includes(focused), turn: turnLines.length, picked: chosen.length, addressable: !!selected.length,
      suggested: !!focused && suggestions.has(focused.prUrl) } };
  /** Move the selection where the picker says: on success the picker closes, the selection clears, and focus follows the focused row. */
  const moveTo = async (to: MoveTarget) => {
    refocus.current = activeRow ?? (chosen[0] ? `${chosen[0].slug}#${chosen[0].number}` : null);
    const refusal = await routing.move(chosen.map((line) => line.prUrl), to);
    if (refusal === null) clear(); else refocus.current = null;
    return refusal;
  };
  /** Address the selected Your turn rows: one batch thread, started now, with 8 s to Undo. */
  const address = () => { if (selected.length) void batch.address(null, selected.map((line) => line.prUrl)); };
  const showAdvance = () => { remember(); setAdvancing({ lines: [...chosen],
    targets: chosen.filter((l) => !l.hold && !l.effortPile).flatMap((l) => { const headOid = rows.get(l.prUrl)?.head; return headOid ? [{ prUrl: l.prUrl, headOid }] : []; }), busy: false, error: null }); };
  const advanceChosen = async () => {
    if (!advancing || advancing.busy || advanceBusy.current) return;
    const targets = advancing.targets;
    const allowed = advancing.lines.filter((l) => !l.hold && !l.effortPile);
    if (!allowed.length) return;
    if (targets.length !== allowed.length) { setAdvancing({ ...advancing, error: "Refresh the selection to read every PR head first." }); return; }
    advanceBusy.current = true; setAdvancing({ ...advancing, busy: true, error: null });
    try {
      const result = await rpc.call("inventory_advance_selected", { targets, ...(bbContext.projectId ? { projectId: bbContext.projectId } : {}) });
      if (!result.ok) { setAdvancing({ ...advancing, busy: false, error: result.error }); return; }
      setAdvancing(null); clear(); load();
      if (result.skipped.length) say(`Started ${result.count}; skipped ${result.skipped.map((s) => `${s.prUrl.replace("https://github.com/", "").replace("/pull/", "#")}: ${s.reason}`).join(" · ")}`);
      navigate.toThread(result.threadId);
    } catch (cause) { setAdvancing({ ...advancing, busy: false, error: String(cause) }); }
    finally { advanceBusy.current = false; }
  };
  /** Dismiss a row on the head and the newest word it shows, or bring it back. */
  const dismiss = (line: InventoryLine, on: boolean) => {
    const row = on ? rows.get(line.prUrl) : undefined;
    void rpc.call("inventory_dismiss", { prUrl: line.prUrl, head: row?.head ?? null, latest: row?.yourTurn?.latest ?? null }).then(load, (cause: unknown) => say(message(cause)));
  };
  const undoBatch = async (batchId: string) => {
    const undone = await rpc.call("deck_batch_undo", { batchId }).catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
    say(undone.ok ? "Undone. Nothing was sent." : undone.error);
    load();
  };
  /** Refresh the selection, else the focused row: four at a time, each row saying what its read got. */
  const reread = () => { void refresh.read(chosen.length ? chosen.map((line) => line.prUrl) : focused && readable ? [focused.prUrl] : []); };
  const on = availability(context);
  const contextRef = useRef(context);
  contextRef.current = context;
  function runKey(id: DeckActionId) {
    switch (id) {
      case "view": onView("deck"); return;
      case "palette": remember(); setDialog({ kind: "palette", query: "", highlight: 0 }); return;
      case "help": remember(); setDialog({ kind: "help" }); return;
      case "row-next": case "row-prev": {
        const all = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-inventory-row]") ?? []);
        const at = activeRow ? all.findIndex((element) => element.dataset.inventoryRow === activeRow) : -1;
        const next = all[at < 0 ? 0 : Math.max(0, Math.min(all.length - 1, at + (id === "row-next" ? 1 : -1)))];
        next?.focus({ preventScroll: true });
        next?.scrollIntoView({ block: "nearest" });
        return;
      }
      // The key opens the deck's listing confirm, which waits out its Undo window; only the row's own Nudge button is one click.
      case "nudge": case "merge": case "confirm": case "request": case "ready": case "release": case "fix": case "revoke":
        if (focused) runPrAction(focused, id); return;
      case "hold-pr": if (focused) runPrAction(focused, "hold"); return;
      // The key starts it, as the bar's button does; nothing starts before its Undo window ends.
      case "address": address(); return;
      case "refresh": reread(); return;
      case "select": if (focused && order.includes(focused)) toggle(focused, false); return;
      case "select-section": setPicked(new Set(turnLines.map((line) => line.prUrl))); say(`Selected ${turnLines.length} on Your turn.`); return;
      case "clear": clear(); return;
      // e moves the selection, else the focused row, which it selects so the bar shows what moves.
      case "move": if (!chosen.length && focused && order.includes(focused)) setPicked(new Set([focused.prUrl])); setMoving(true); return;
      case "accept": if (focused && suggestions.has(focused.prUrl)) { refocus.current = activeRow; routing.accept([focused]); } return;
      case "undo": if (undo?.live()) { const last = undo; setUndo(null); setFlash(null); void last.run(); } return;
      case "open-thread": if (thread) navigate.toThread(thread); return;
      case "open-pr": if (focused) navigate.openUrl(focused.prUrl); return;
      default: return;
    }
  }
  const runRef = useRef(runKey);
  runRef.current = runKey;
  useRegistryKeys(rootRef, { on: () => availability(contextRef.current), run: (id) => runRef.current(id), say, isRow: () => false });
  const palette = paletteItems(on, [], { held: [], done: [] }, null, false);
  const matches = dialog?.kind === "palette" ? paletteMatch(palette, dialog.query) : [];
  const runPalette = (entry: PaletteItem) => { setDialog(null); window.setTimeout(() => { if (entry.action) runKey(entry.action.id); }, 0); };

  return <>
    {screen ? <InventoryPane screen={screen} busyKey={busyKey} error={error} rootRef={rootRef}
      renderActions={renderActions} planner={{ busy: planning, error: planError, onPlan: () => void planAll() }}
      onView={onView} onPalette={() => runKey("palette")} onHelp={() => runKey("help")} onOpenPr={(url) => navigate.openUrl(url)} onOpenThread={(id) => navigate.toThread(id)}
      onOpenEffort={(effortId) => navigate.toPluginPanel("board", { subPath: `deck/${encodeURIComponent(effortId)}` })}
      onNudge={(line, action) => { void nudge(line, action); }}
      selected={picked} onSelect={toggle} onAddress={address} onAdvance={showAdvance} onSelectOther={(all) => setPicked((current) => { const next = new Set(current); for (const l of split?.other.flatMap((g) => g.lines) ?? []) { if (all) next.add(l.prUrl); else next.delete(l.prUrl); } return next; })} onClear={clear} refusal={batch.refusal}
      onSelectAll={(all) => setPicked(new Set(all ? [...picked, ...turnLines.map((line) => line.prUrl)] : [...picked].filter((prUrl) => !turnLines.some((line) => line.prUrl === prUrl))))}
      move={{ open: moving && chosen.length > 0, onOpenChange: setMoving, efforts: routing.efforts, busy: routing.busy, onMove: moveTo }}
      suggestions={suggestions} onAccept={routing.accept} onDismissSuggestion={routing.dismiss} notes={batch.details} onUndo={(batchId) => void undoBatch(batchId)} onDismiss={dismiss} working={batch.working} live={batch.live}
      onRefresh={(line) => void refresh.read([line.prUrl])} onRefreshSelected={reread} onRefreshAll={refresh.all} reading={refresh.reading}
      refresh={{ busy: refresh.reading.size > 0, progress: refresh.progress }}
      footer={<HintBar hints={hintKeys(context, on)} flash={flash ?? (refresh.progress ? { text: refresh.progress, undo: false, busy: true } : batch.sending ? { text: batch.sending, undo: false, busy: true } : null)} onPalette={() => runKey("palette")} onHelp={() => runKey("help")} onUndo={() => runKey("undo")} />} />
      : <InventoryPending error={error} onRetry={load} onView={onView} onPalette={() => runKey("palette")} onHelp={() => runKey("help")} />}
    <DeckDialog open={!!advancing} title={advancing ? `Advance ${advancing.lines.length} selected PRs` : ""} onClose={() => { if (!advancing?.busy) setAdvancing(null); }} onReturn={returnFocus} onConfirmKey={() => void advanceChosen()}>
      {advancing ? <AdvanceSelectionBody lines={advancing.lines} busy={advancing.busy} error={advancing.error} onConfirm={() => void advanceChosen()} onCancel={() => setAdvancing(null)} /> : null}
    </DeckDialog>
    {batch.element}
    {notesConfirm.element}
    <MergePreviewDialog targets={merging ? [{ target: merging, n: null }] : null} rows={screen?.groups.flatMap((g) => g.lines.map((l) => ({ target: l.prUrl, repo: l.slug, number: l.number, title: l.title }))) ?? []} onClose={() => setMerging(null)} onMerged={load} onOpenUrl={(url) => navigate.openUrl(url)} onClosed={returnFocus} />
    <DeckDialog open={!!hold} title={hold ? `Hold ${hold.ref}` : ""} onClose={() => { if (!hold?.busy) setHold(null); }} onReturn={returnFocus} onConfirmKey={() => void holdNow()}>
      {hold ? <HoldBody reason={hold.reason} onReason={(reason) => setHold({ ...hold, reason })} busy={hold.busy} error={hold.error} onHold={() => void holdNow()} onCancel={() => setHold(null)} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "palette"} title="All actions" bare onClose={() => setDialog(null)} onReturn={returnFocus}>
      {dialog?.kind === "palette" ? <div onKeyDown={(event) => {
        const live = matches.filter((entry) => entry.on);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setDialog({ ...dialog, highlight: Math.max(0, Math.min(live.length - 1, dialog.highlight + (event.key === "ArrowDown" ? 1 : -1))) });
        } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); const entry = live[dialog.highlight]; if (entry) runPalette(entry); }
        else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setDialog(null); }
      }}><PaletteBody query={dialog.query} items={matches} highlight={dialog.highlight} onQuery={(query) => setDialog({ ...dialog, query, highlight: 0 })}
        onRun={runPalette} onHighlight={(highlight) => setDialog({ ...dialog, highlight })} /></div> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "help"} wide closeKey="?" title="Keys and colors" sub="The same keys do the same thing in Efforts and All PRs. Grayed keys don't apply here."
      onClose={() => setDialog(null)} onReturn={returnFocus}>
      {dialog?.kind === "help" ? <HelpBody items={palette} /> : null}
    </DeckDialog>
  </>;
}
