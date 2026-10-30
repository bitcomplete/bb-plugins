// The effort deck in the Workstreams panel (plan amendments A15 and A17.1,
// effort card v2): deck_get live from the server, with inventory_get for All
// PRs' own rows under each move; the one key registry; and every write
// through a listing confirm that waits out its Undo window, through the fresh
// merge preview, or, for Address alone, started at once into that window.
// Membership changes (accept, move, one-off, new effort, promote, rules) and
// pile moves are each one explicit click or key with Undo.
//
// This is the part that talks to BB and the DOM: it keeps your place per view
// in the session (deck-place.ts), holds rows at their pixel through reads,
// resizes, and flips, and never leaves focus on the page body.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { DeckRow, DeckView } from "./deck";
import type { DeckSection } from "./deck-shared";
import type { DeckActionId } from "./deck-keys";
import { anchorScroll, deckRing, EMPTY_VIEW, focusFallback, keepOrder, landAfter, meltSlack, numberedEffort, PLACE_KEY, readPlace, readSeen, SEEN_KEY, withArrivals, type Anchor,
  type FocusKey, type Place, type Seen, type ViewPlace } from "./deck-place";
import { acceptLabel, addressPicks, availability, cardScreen, cardSnapshot, hintKeys, keptServiceCards, KIND_OF, overviewScreen,
  paletteItems, paletteMatch, readText, refreshNote, rowFacts, stripChips, targets, threadSnapshot, threadsKey, type Accepted, type DeckLine, type KeyContext,
  type PaletteItem } from "./deck-view-model";
import { CompleteBody, DeckPane, HelpBody, HoldBody, MoveBody, NewEffortBody, PaletteBody, RULE_WORDS, RuleBody, SeedBody, WeakBody, type DeckCommand, type HeaderTarget,
  type NotesEdit, type Panel, type RuleDraft, type RuleItem } from "./deck-screen";
import { DeckDialog, message, useBatchConfirm, useRefresh, useRegistryKeys, type Undo } from "./deck-flow";
import { useDeck } from "./deck-read";
import { inventoryPrPath } from "./view-preference";
import { inventoryScreen } from "./inventory-view-model";
import { useInventory } from "./inventory-screen";
import { useNotesConfirm } from "./notes-flow";
import { EASE, FLIP_MS, flipMotion, flipper, focusNamesCard, ghostOf, playFlip, settleFlip, type FlipMotion } from "./deck-flip";
import { MergePreviewDialog } from "./merge-preview-dialog";
import { ArchivedThreadsDialog } from "./archivedthreads";
import type { SeedProposal } from "./linear-seed";
import { deckLinkStep } from "./view-preference";

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/** A row as All PRs draws it, named "owner/repo#N", which anchors, focus, and j and k find it by. */
const ROW = "[data-inventory-row]";
const rowAt = (key: string) => `[data-inventory-row="${CSS.escape(key)}"]`;
const keyOf = (row: Pick<DeckRow, "repo" | "number">) => `${row.repo}#${row.number}`;
/** The last deck read, so coming back to the deck draws it at once instead of "Reading…" (PLACE-LOSS #1). */


function readStore<T>(storage: "sessionStorage" | "localStorage", key: string, parse: (raw: string | null) => T): T {
  try { return parse(window[storage].getItem(key)); } catch { return parse(null); }
}
function writeStore(storage: "sessionStorage" | "localStorage", key: string, value: unknown) {
  try { window[storage].setItem(key, JSON.stringify(value)); } catch { /* The deck still works for this visit without storage. */ }
}
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(timer); }, [ms]);
  return now;
}

/**
 * deck_get, read on mount, on deck-changed, and when the page shows again; a signal during a read reads once more after it. `drawn`: the
 * PRs the view drew as it last saw them, which the read says the fate of when they leave.
 */
type Dialogs =
  | { kind: "hold"; id: string; effortKey: string; name: string; reason: string } | { kind: "complete"; id: string }
  | { kind: "hold-pr"; prUrl: string; ref: string; reason: string }
  | { kind: "rule"; draft: RuleDraft; matches: number | null }
  /** `promote`: the service card whose PRs all go. */
  | { kind: "new"; prUrls: string[]; refs: string[]; name: string; goal: string; group: string | null; promote?: { id: string; name: string } }
  | { kind: "move"; prUrls: string[]; refs: string[]; group: string | null } | { kind: "palette"; query: string; highlight: number } | { kind: "help" }
  | { kind: "seed"; proposals: SeedProposal[] | null; keyed: boolean; picked: string[]; requestId: string }
  | { kind: "weak"; group: string; lines: readonly DeckLine[] };

/** `openCard`: a card a link asked for, such as a thread's effort chip, opened once the deck has read it; a held effort opens its pile. */
export function DeckNavView({ onView, openCard = null }: { onView(target: HeaderTarget): void; openCard?: string | null }) {
  const navigate = useBbNavigate();
  const placeRef = useRef<Place>(readStore("sessionStorage", PLACE_KEY, readPlace));
  const [seen, setSeen] = useState<Seen>(() => readStore("localStorage", SEEN_KEY, (raw) => readSeen(raw, Date.now())));
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((value) => value + 1), []);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const slackRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const slack = useRef(0);
  const pendingAnchor = useRef<Anchor | null>(null);
  const liveAnchor = useRef<Anchor | null>(null);
  const lastFocus = useRef<FocusKey | null>(null);
  const pendingFocus = useRef<FocusKey | null>(null);
  /** The pending focus follows an action, so it scrolls into view if it has to. */
  const scrollFocus = useRef(false);
  const lastFocusElement = useRef<Element | null>(null);
  const opener = useRef<FocusKey>({});
  /** The flip the next render lands, with the card it takes away, and the flips so far, which know when the last one started. */
  const landing = useRef<{ direction: 1 | -1; motion: FlipMotion; ghost: HTMLElement | null } | null>(null);
  const [flips] = useState(flipper);
  /** The card a flip landed on, for screen readers, once the flips stop. */
  const [announce, setAnnounce] = useState("");
  const announceTimer = useRef<number | null>(null);
  /** The focused row, by its All PRs name. */
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Accepted>(new Map());
  /** A card an action made, which the deck opens once a read has it: a promoted service card goes on as its effort. */
  const follow = useRef<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [merging, setMerging] = useState<{ target: string; n: null }[] | null>(null);
  const [archivingThread, setArchivingThread] = useState<string | null>(null);
  const archivingRef = useRef(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [pile, setPile] = useState<"hold" | "done" | null>(null);
  const [flash, setFlash] = useState<{ text: string; undo: boolean } | null>(null);
  const [seenNote, setSeenNote] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [rules, setRules] = useState<RuleItem[]>([]);
  /** Rows whose Refresh is running, until the read after it lands; with what each was, and the reads so far when GitHub answered. */
  const [refreshing, setRefreshing] = useState<ReadonlyMap<string, { ref: string; was: { status: string; section: DeckSection } | null; after: number | null }>>(new Map());
  /** The Notes editor, open on one effort's card, with the revision it edits. */
  const [notesEdit, setNotesEdit] = useState<(NotesEdit & { effortId: string; revision: number }) | null>(null);
  const now = useNow(30_000);

  const scrollBox = () => scrollerRef.current?.getBoundingClientRect() ?? null;
  const inView = (element: Element) => {
    const box = scrollBox();
    const rect = element.getBoundingClientRect();
    return !!box && rect.top >= box.top + 30 && rect.bottom <= box.bottom + 1;
  };
  /** What holds your place now: `prefer`, else the focused row in view, else the card's top while it shows, else the first row below the top. */
  const captureAnchor = useCallback((prefer?: Element | null): Anchor | null => {
    const box = scrollBox();
    const view = viewRef.current;
    if (!box || !view) return null;
    const focused = document.activeElement?.closest?.(ROW);
    const row = [prefer, focused].find((element) => element && view.contains(element) && inView(element));
    if (row) return { row: (row as HTMLElement).dataset.inventoryRow!, at: row.getBoundingClientRect().top - box.top };
    // The stack's box: the card on top, without the edges of the cards behind it.
    const card = view.querySelector("[data-deck-stack]");
    const cardBox = card?.getBoundingClientRect();
    if (cardBox && cardBox.bottom > box.top + 40) return { card: true, at: cardBox.top - box.top };
    for (const element of Array.from(view.querySelectorAll<HTMLElement>(ROW))) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > box.top + 36) return { row: element.dataset.inventoryRow!, at: rect.top - box.top };
    }
    return null;
  }, []);
  const setSlack = (value: number) => { slack.current = value; if (slackRef.current) slackRef.current.style.height = `${value}px`; };
  const restoreAnchor = useCallback((anchor: Anchor | null) => {
    const scroller = scrollerRef.current;
    const view = viewRef.current;
    if (!anchor || !scroller || !view) return;
    const element = "card" in anchor ? view.querySelector("[data-deck-stack]") : view.querySelector(rowAt(anchor.row));
    if (!element) return;
    const next = anchorScroll({ scrollTop: scroller.scrollTop, slack: slack.current, at: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top, want: anchor.at });
    setSlack(next.slack);
    scroller.scrollTop = next.scrollTop;
  }, []);

  const { rpc, view, reads, error, load, busy: readingNow } = useDeck(() => seenRef.current.at, () => [...new Set(Object.entries(seenRef.current.rows)
    .flatMap(([key, rows]) => key.startsWith("threads:") ? [] : rows.map((row) => row.prUrl)))].slice(0, 1_000), () => { pendingAnchor.current = captureAnchor(); });
  const readsRef = useRef(reads);
  readsRef.current = reads;
  const flashTimer = useRef<number | null>(null);
  const say = useCallback((text: string, withUndo = false, ms?: number) => {
    setFlash({ text, undo: withUndo });
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), ms ?? (withUndo ? 9_000 : 5_000));
  }, []);
  const batch = useBatchConfirm({ seenAt: () => seenRef.current.at, scopeName: (id) => view?.active.find((item) => item.id === id)?.name ?? null, say, setUndo, load,
    onOpen: () => { const key = focusKey(document.activeElement); if (key.id || key.row) opener.current = key; }, onReturn: () => returnFocus(), reread: view });
  /** The rows a Refresh is about to read, with what each was, for when it starts. */
  const starting = useRef<Map<string, { ref: string; was: { status: string; section: DeckSection }; after: null }>>(new Map());
  const refresh = useRefresh({ say, started: () => setRefreshing((current) => new Map([...current, ...starting.current])),
    reads: (reads) => {
      // A read already running may have started before GitHub answered, so the one after it carries the answer; a failed read stops now.
      const after = readsRef.current + (readingNow() ? 1 : 0);
      const answers = new Map(reads.map((item) => [item.prUrl, item.read.status]));
      setRefreshing((current) => new Map([...current].flatMap(([prUrl, item]) => !answers.has(prUrl) ? [[prUrl, item] as const]
        : answers.get(prUrl) === "checked" ? [[prUrl, { ...item, after }] as const] : [])));
      load();
    } });
  const notes = useNotesConfirm({ say, load, onOpen: () => { const key = focusKey(document.activeElement); if (key.id || key.row) opener.current = key; },
    onReturn: () => returnFocus(), ask: (prUrl, effortId) => void batch.plan("ask", effortId, [prUrl]) });
  // All PRs' own rows, which each move draws, read again after every deck read so the two agree.
  const inventory = useInventory();
  useEffect(() => { if (view) inventory.load(); }, [view, inventory.load]);
  const rowLines = useMemo(() => new Map((inventory.view ? inventoryScreen(inventory.view, { now, filter: null, outcomes: refresh.outcomes }).groups : [])
    .flatMap((group) => group.lines.map((line) => [line.prUrl, line] as const))), [inventory.view, now, refresh.outcomes]);

  // ---- what the deck shows -------------------------------------------------
  const place = placeRef.current;
  // A service card whose last PR left stays until you mark it seen.
  const active = useMemo(() => view ? [...view.active, ...keptServiceCards(place.order, view.active, seen.rows, accepted)] : [],
    [view, place.order, seen.rows, accepted]);
  const cards = useMemo(() => new Map(active.map((item) => [item.id, cardScreen(item, seen, { now, accepted })])), [active, seen, now, accepted]);
  const order = useMemo(() => keepOrder(place.order, active.map((item) => item.id)), [active, place.order]);
  // Overview opens the ring without taking an effort's number key.
  const ring = useMemo(() => deckRing(view ? order : null), [view, order]);
  if (follow.current && ring.includes(follow.current)) { place.cur = follow.current; follow.current = null; }
  // The order this render reads is the one you last saw until the effect below saves the new one, so the card landed on is kept now.
  const cur = landAfter(place.order, place.cur, ring);
  if (cur) place.cur = cur;
  const card = cur && cur !== "overview" ? cards.get(cur) ?? null : null;
  const overview = useMemo(() => ({ ...overviewScreen(order, cards),
    held: (view?.held ?? []).map((item) => cardScreen(item, seen, { now })),
    other: order.flatMap((id) => { const item = cards.get(id); return item && item.card.kind !== "effort" ? [item] : []; }) }), [order, cards, view?.held, seen, now]);
  const viewPlace = (key: string | null): ViewPlace => (place.views[key ?? ""] ??= { ...EMPTY_VIEW, unpicked: [], open: [] });
  const here = viewPlace(cur);
  // Focus and scroll events can fire between a flip's render and its effects; they read the card shown now.
  const curRef = useRef(cur);
  curRef.current = cur;
  const lines: DeckLine[] = card?.lines ?? [];
  const focused = lines.find((line) => line.row && keyOf(line.row) === activeRow) ?? null;
  const lineOf = (prUrl: string) => lines.find((line) => line.prUrl === prUrl && line.row) ?? null;
  // The Address move's rows start ticked, as its listing: b takes each one you haven't unticked that Address can take now.
  const addressRows = lines.filter((line) => card?.moves.some((item) => item.kind === "address" && item.prUrls.includes(line.prUrl)) && line.row?.turn.addressable === true);
  const selected = addressRows.filter((line) => !here.unpicked.includes(line.prUrl) && !line.dim);
  const changedHere = card?.changed ?? 0;
  const settleable = card?.settleable ?? false;
  const chips = useMemo(() => stripChips(order, cards, cur), [order, cards, cur]);
  const context: KeyContext = { view: "deck", cur: card ?? (view && cur === "overview" ? "overview" : null), service: order.find((id) => cards.get(id)?.card.kind === "service") ?? null, focused, selected,
    seenAvailable: changedHere > 0 || settleable, undo: !!undo?.live(), held: view?.held.length ?? 0, done: view?.done.length ?? 0 };
  const on = availability(context);
  const persist = useCallback(() => writeStore("sessionStorage", PLACE_KEY, placeRef.current), []);

  // The session's order grows with new cards at the end; each view gets its baseline the first time it's read, so nothing is news then.
  useEffect(() => {
    if (!view) return;
    if (place.order.join() !== order.join()) { place.order = order; persist(); }
    const missing: Record<string, ReturnType<typeof cardSnapshot>> = {};
    for (const item of view.active) {
      // A row that arrives since you looked joins the snapshot as new, so it counts as changed, and again if it leaves, until Mark seen.
      const known = seen.rows[item.id];
      const arrived = known && withArrivals(known, cardSnapshot(item));
      if (!known || arrived) missing[item.id] = arrived || cardSnapshot(item);
      if (!seen.rows[threadsKey(item.id)]) missing[threadsKey(item.id)] = threadSnapshot(item);
    }
    if (Object.keys(missing).length) setSeen((current) => ({ ...current, rows: { ...current.rows, ...missing } }));
  }, [view, order, place, seen.rows, persist]);
  useEffect(() => writeStore("localStorage", SEEN_KEY, seen), [seen]);

  // ---- place: scroll anchors, flips, resizes, and focus --------------------
  /** The card the last flip landed on. */
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (pendingAnchor.current) { restoreAnchor(pendingAnchor.current); pendingAnchor.current = null; }
    if (pendingFocus.current) { focusBack(pendingFocus.current, scrollFocus.current); pendingFocus.current = null; scrollFocus.current = false; return; }
    // The one safety net: a control that unmounted or hid under focus hands it to its replacement, never to the page.
    const active = document.activeElement;
    const gone = lastFocusElement.current && (!lastFocusElement.current.isConnected || (lastFocusElement.current as HTMLElement).offsetParent === null);
    // A flip lands focus itself, on the card's own saved row (the effect below).
    if ((!active || active === document.body) && lastFocus.current && gone && !dialog && !batch.open && !merging && shown.current === cur) focusBack(lastFocus.current);
  });
  // A flip lands on the card's saved place, then plays its motion over the stack (deck-flip.ts).
  useLayoutEffect(() => {
    if (!view || !cur || shown.current === cur) return;
    const first = shown.current === null;
    shown.current = cur;
    // A flip still playing ends first, so what follows measures where things sit, not where it draws them.
    if (viewRef.current) settleFlip(viewRef.current);
    setSlack(0);
    const saved = viewPlace(cur);
    if (scrollerRef.current) scrollerRef.current.scrollTop = saved.scrollTop;
    restoreAnchor(saved.anchor);
    liveAnchor.current = saved.anchor;
    const flipped = landing.current;
    landing.current = null;
    // Focus lands before the motion starts, for the same reason. A flip from the strip keeps focus in the strip; any other flip, or
    // arriving from another view, lands on what you can see.
    const before = document.activeElement;
    const strip = before?.closest?.("nav[aria-label=Efforts]");
    if (strip) rootRef.current?.querySelector<HTMLElement>(`[data-deck-chip="${CSS.escape(cur)}"]`)?.focus({ preventScroll: true });
    else if (!first || !document.activeElement || document.activeElement === document.body) landFocus(saved);
    chipsRef.current?.querySelector(`[data-deck-chip="${CSS.escape(cur)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (first) return;
    if (flipped && viewRef.current) playFlip(viewRef.current, flipped);
    // Screen readers hear the card once, after the last of a run of flips, and not at all when focus moved onto its heading or chip, which say it.
    const said = focusNamesCard(before, document.activeElement);
    const name = card?.card.name ?? (cur === "overview" ? "Overview" : "");
    setAnnounce("");
    if (announceTimer.current !== null) window.clearTimeout(announceTimer.current);
    announceTimer.current = said ? null : window.setTimeout(() => setAnnounce(name), FLIP_MS);
  });
  useEffect(() => () => { if (announceTimer.current !== null) window.clearTimeout(announceTimer.current); }, []);
  // A Refresh's spinner stays until the read after GitHub answered lands; then the hint bar says what it found.
  useEffect(() => {
    if (!view) return;
    const landed = [...refreshing].filter(([, item]) => item.after !== null && reads > item.after);
    if (!landed.length) return;
    const facts = rowFacts(view);
    const gone = new Map(view.gone.map((item) => [item.prUrl, item]));
    say(landed.map(([prUrl, item]) => refreshNote(item.ref, item.was, facts.get(prUrl) ?? null, gone.get(prUrl) ?? null)).join(" · "));
    setRefreshing((current) => new Map([...current].filter(([prUrl]) => !landed.some(([url]) => url === prUrl))));
  }, [view, reads, refreshing, say]);
  // The pane resizing holds the row you were on in place, and keeps the current chip in view.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let width = scroller.clientWidth;
    const observer = new ResizeObserver(() => {
      if (scroller.clientWidth === width) return;
      width = scroller.clientWidth;
      restoreAnchor(liveAnchor.current);
      chipsRef.current?.querySelector("[aria-current=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [restoreAnchor]);
  const onScroll = useRef<number | null>(null);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const handler = () => {
      const melted = meltSlack({ scrollTop: scroller.scrollTop, slack: slack.current });
      if (melted.slack !== slack.current) { setSlack(melted.slack); scroller.scrollTop = melted.scrollTop; }
      if (onScroll.current !== null) window.clearTimeout(onScroll.current);
      onScroll.current = window.setTimeout(() => {
        const saved = viewPlace(curRef.current);
        saved.scrollTop = scroller.scrollTop;
        saved.anchor = liveAnchor.current = captureAnchor();
        persist();
      }, 120);
    };
    scroller.addEventListener("scroll", handler, { passive: true });
    return () => scroller.removeEventListener("scroll", handler);
  });
  // Track focus inside the deck: its row, and the key that finds the control again.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onIn = (event: FocusEvent) => {
      const key = focusKey(event.target as Element);
      lastFocus.current = key;
      lastFocusElement.current = event.target as Element;
      setActiveRow(key.row ?? null);
      if (key.row) { viewPlace(curRef.current).focus = key.row; persist(); }
    };
    const onOut = (event: FocusEvent) => { if (event.relatedTarget instanceof Element && !root.contains(event.relatedTarget)) lastFocus.current = null; };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    return () => { root.removeEventListener("focusin", onIn); root.removeEventListener("focusout", onOut); };
  });

  function focusKey(element: Element | null): FocusKey {
    if (!element) return {};
    return { id: element.closest<HTMLElement>("[data-deck-focus]")?.dataset.deckFocus, row: element.closest<HTMLElement>(ROW)?.dataset.inventoryRow,
      section: element.closest<HTMLElement>("[data-deck-move]")?.dataset.deckMove };
  }
  function focusBack(key: FocusKey, reveal = false) {
    const root = rootRef.current;
    if (!root) return;
    const live = (element: HTMLElement) => element.isConnected && element.getAttribute("aria-disabled") !== "true" && !(element as HTMLButtonElement).disabled
      && element.offsetParent !== null;
    const rows = () => Array.from(root.querySelectorAll<HTMLElement>(ROW));
    const target = focusFallback<HTMLElement>(key, {
      byId: (id) => root.querySelector(`[data-deck-focus="${CSS.escape(id)}"]`), row: (row) => root.querySelector(rowAt(row)),
      // The move a row left: its next row there, else in a move after it.
      nextLiveRow: (section) => {
        const moves = Array.from(root.querySelectorAll<HTMLElement>("[data-deck-move]"));
        const from = moves.findIndex((element) => element.dataset.deckMove === section);
        for (const element of from < 0 ? [] : moves.slice(from)) { const row = element.querySelector<HTMLElement>(ROW); if (row) return row; }
        return null;
      },
      firstLiveRow: () => rows().find(inView) ?? null, heading: () => root.querySelector("[data-deck-focus=heading]"), live });
    target?.focus({ preventScroll: true });
    if (target && reveal && !inView(target)) target.scrollIntoView({ block: "nearest" });
  }
  /** After a flip or a view switch: the row you were on if it shows, else the first row in view below the card, else the card's heading. */
  function landFocus(saved: ViewPlace) {
    const root = rootRef.current;
    if (!root) return;
    const row = saved.focus ? root.querySelector<HTMLElement>(rowAt(saved.focus)) : null;
    const heading = root.querySelector<HTMLElement>("[data-deck-focus=heading]");
    const target = (row && inView(row) ? row : null) ?? (heading && inView(heading) ? heading : null)
      ?? Array.from(root.querySelectorAll<HTMLElement>(ROW)).find(inView) ?? heading;
    target?.focus({ preventScroll: true });
  }

  // ---- small helpers -------------------------------------------------------
  const openDialog = (next: Dialogs) => {
    // A dialog opened from the palette returns where the palette came from.
    const key = focusKey(document.activeElement);
    if (key.id || key.row) opener.current = key;
    setDialogError(null); setBusy(false); setDialog(next);
  };
  const closeDialog = () => setDialog(null);
  const returnFocus = () => { pendingFocus.current = null; window.requestAnimationFrame(() => focusBack(opener.current)); };
  /** A flip lands on its card now; the card it takes away is copied first, for its motion to take away after the swap. */
  const go = (to: { step: 1 | -1 } | { id: string }) => {
    const next = cur && flips(ring, cur, to, performance.now(), reduced());
    if (!next) return;
    viewPlace(cur).scrollTop = scrollerRef.current?.scrollTop ?? 0;
    viewPlace(cur).anchor = captureAnchor();
    landing.current = { direction: next.direction, motion: next.motion, ghost: next.motion.kind !== "none" && viewRef.current ? ghostOf(viewRef.current) : null };
    place.cur = next.id;
    setActiveRow(null);
    persist();
    bump();
  };
  const refs = (list: readonly DeckLine[]) => list.map((line) => line.ref);
  const cardOf = (id: string) => view?.active.find((item) => item.id === id) ?? view?.held.find((item) => item.id === id) ?? null;

  // ---- membership: accept, move, one-off, new effort, rules ---------------
  /** `promote`: the service card it promotes, which the deck leaves for the new effort's card, and comes back to on Undo. */
  async function classify(call: () => Promise<{ ok: true; actionId: string; effort: { id: string; name: string }; added: number } | { ok: false; error: string }>,
    group: string | null, prUrls: readonly string[], promote: string | null = null) {
    setBusy(true);
    let result: Awaited<ReturnType<typeof call>>;
    try { result = await call(); } catch (cause) { result = { ok: false, error: message(cause) }; }
    setBusy(false);
    if (!result.ok) { if (dialog) setDialogError(result.error); else say(result.error); return false; }
    const { actionId, effort, added } = result;
    const text = `${added} PR${added === 1 ? "" : "s"} → ${effort.name}`;
    const index = card?.suggest.findIndex((item) => item.key === group) ?? -1;
    if (group) setAccepted((current) => new Map([...current, [group, { actionId, text, prUrls, index: Math.max(0, index) }]]));
    const undoIt = async () => {
      const undone = await rpc.call("classify_undo", { actionId });
      if (undone.ok) {
        if (promote) follow.current = promote;
        if (group) setAccepted((current) => { const next = new Map(current); next.delete(group); return next; });
      }
      say(undone.ok ? "Undone." : undone.error);
      load();
    };
    let used = false;
    setUndo({ label: text, live: () => !used, run: async () => { used = true; await undoIt(); } });
    closeDialog();
    say(text, true);
    if (group) nextSortFocus(prUrls);
    if (promote) follow.current = effort.id;
    load();
    return true;
  }
  /** After an accept, the next row on the card still to sort takes focus: the next one below the rows it moved, else the first. */
  function nextSortFocus(gone: readonly string[]) {
    const left = lines.filter((line) => line.row && !line.dim && !gone.includes(line.prUrl));
    const from = lines.findIndex((line) => gone.includes(line.prUrl));
    const row = left.find((line) => lines.indexOf(line) > from) ?? left[0];
    const element = row ? rootRef.current?.querySelector(rowAt(keyOf(row.row!))) : null;
    pendingAnchor.current = captureAnchor(element);
    pendingFocus.current = row ? { row: keyOf(row.row!) } : { id: "heading" };
    scrollFocus.current = true;
  }
  const assign = (effortId: string, prUrls: string[], group: string | null) => classify(() => rpc.call("classify_assign", { effortKey: effortId, prUrls }), group, prUrls);
  const oneOff = (prUrls: string[], group: string | null) => classify(() => rpc.call("classify_one_off", { prUrls }), group, prUrls);
  /** `asked`: a weak group's rows you already checked in its confirm; before that, its Accept opens the confirm. */
  function acceptGroup(key: string, { asked }: { asked?: readonly DeckLine[] } = {}) {
    const group = card?.suggest.find((item) => item.key === key);
    if (!group) return;
    const live = group.lines.filter((line) => !line.dim);
    const rows = asked ?? live;
    if (!rows.length) return;
    if (group.button.confirm && !asked) { openDialog({ kind: "weak", group: key, lines: rows }); return; }
    const prUrls = rows.map((line) => line.prUrl);
    const target = group.target;
    if (target?.kind === "effort") void assign(target.effortId, prUrls, key);
    else if (target?.kind === "one-off") void oneOff(prUrls, key);
    else if (target?.kind === "new") openDialog({ kind: "new", prUrls, refs: refs(rows), name: target.name, goal: "", group: key });
    else {
      // No clear signal: pick an effort for the focused row, else the group's first, and the dialog names exactly that one.
      const chosen = [live.find((line) => line === focused) ?? live[0]!];
      openDialog({ kind: "move", prUrls: chosen.map((line) => line.prUrl), refs: refs(chosen), group: null });
    }
  }
  /** A service card's rows move one at a time, from the focused row. */
  const scopeRows = () => focused?.row && !focused.dim ? [focused] : [];
  /** The suggestion a row on this card is in. */
  const groupOf = (prUrl: string) => card?.suggest.find((item) => !item.accepted && item.lines.some((line) => line.prUrl === prUrl))?.key ?? null;

  // ---- piles --------------------------------------------------------------
  async function movePile(move: "hold" | "complete" | "resume" | "reopen", effort: { id: string; key: string; name: string }, reason = "") {
    const { key: effortKey, name } = effort;
    setBusy(true);
    const leaving = move === "hold" || move === "complete";
    // Light card motion: the card on top drops toward its pile, which then bumps, and shows the stack behind it.
    const cardElement = viewRef.current?.querySelector<HTMLElement>("[data-deck-top]");
    const pileElement = rootRef.current?.querySelector<HTMLElement>(`[data-deck-pile="${move === "hold" ? "hold" : "done"}"]`);
    if (leaving && cardElement && pileElement && !reduced()) {
      const from = cardElement.getBoundingClientRect(), to = pileElement.getBoundingClientRect();
      // It shrinks about its middle, where a flip scales it about its right edge.
      const origin = "50% 50%";
      await cardElement.animate([{ transformOrigin: origin, transform: "none", opacity: 1 },
        { transformOrigin: origin, transform: `translate(${to.left - from.left - from.width / 2}px, ${to.top - from.top}px) scale(0.08) rotate(${move === "hold" ? -6 : 6}deg)`, opacity: 0.2 }],
        { duration: 300, easing: "cubic-bezier(.5,0,.2,1)", fill: "forwards" }).finished.catch(() => undefined);
    }
    let result: { ok: true } | { ok: false; error: string };
    try {
      result = move === "hold" ? await rpc.call("effort_hold", { effortKey, reason }) : move === "complete" ? await rpc.call("effort_complete", { effortKey })
        : move === "resume" ? await rpc.call("effort_resume", { effortKey }) : await rpc.call("effort_reopen", { effortKey });
    } catch (cause) { result = { ok: false, error: message(cause) }; }
    setBusy(false);
    cardElement?.getAnimations().forEach((animation) => animation.cancel());
    if (!result.ok) { if (dialog) setDialogError(result.error); else say(result.error); return; }
    closeDialog();
    setPile(null);
    if (!reduced()) pileElement?.animate([{ transform: "scale(1)" }, { transform: "scale(1.25)" }, { transform: "scale(1)" }], { duration: 350, easing: EASE });
    const back = move === "hold" ? "resume" : move === "complete" ? "reopen" : null;
    let used = false;
    setUndo(back ? { label: `${move} ${name}`, live: () => !used, run: async () => { used = true; await movePile(back, effort); } } : null);
    say(move === "hold" ? `Held ${name}. Its PRs stop counting until you resume it.` : move === "complete" ? `Completed ${name}.`
      : `${move === "resume" ? "Resumed" : "Reopened"} ${name}. It joins the end of the pile.`, !!back);
    if (leaving) {
      const index = order.indexOf(effort.id);
      const nextOrder = order.filter((id) => id !== effort.id);
      place.cur = nextOrder[Math.min(Math.max(0, index), nextOrder.length - 1)] ?? "overview";
    } else place.cur = effort.id;
    // The card it lands on rises out of the stack; the one that left already flew to its pile.
    if (place.cur !== cur) landing.current = { direction: 1, motion: flipMotion(reduced(), null), ghost: null };
    persist();
    bump();
    load();
  }

  // ---- Refresh -------------------------------------------------------------
  /**
   * Rows read from GitHub now, the selection four at a time: each spinner runs until the read that carries its answer lands, and the row
   * changes in place and says Read just now, or why its read failed. Another Refresh while one reads is ignored.
   */
  function refreshRows(list: readonly DeckLine[]) {
    const rows = list.filter((line) => line.row && !line.ghost);
    starting.current = new Map(rows.map((line) => [line.prUrl, { ref: line.ref, was: { status: line.row!.status, section: line.row!.section }, after: null }]));
    void refresh.read(rows.map((line) => line.prUrl));
  }

  // ---- Mark seen -----------------------------------------------------------
  function markSeen() {
    if (!view || !card || !context.seenAvailable) return;
    // Rows follow the read, so nothing moves: the snapshot and seen marks settle, and your place holds.
    pendingAnchor.current = captureAnchor();
    const stamp = Date.now();
    const settled = { [card.card.id]: cardSnapshot(card.card), [threadsKey(card.card.id)]: threadSnapshot(card.card) };
    const marked = Object.fromEntries(card.card.sections.flatMap((section) => section.rows).map((row) => [row.prUrl, stamp]));
    setSeen((current) => ({ rows: { ...current.rows, ...settled }, at: { ...current.at, ...marked } }));
    // What you moved from here settles with it: its collapsed suggestions.
    setAccepted((current) => new Map([...current].filter(([key]) => !key.startsWith(`${card.card.id} `))));
    const key = focusKey(document.activeElement);
    pendingFocus.current = { id: key.id === "seen" ? undefined : key.id, row: key.row, section: key.section };
    const left = lines.filter((line) => line.ghost).length;
    setSeenNote(["Seen", left && `${left} left this view`].filter(Boolean).join(" · "));
    window.setTimeout(() => setSeenNote(null), 4_500);
  }

  // ---- ticks and rows ------------------------------------------------------
  const lastTicked = useRef<string | null>(null);
  /** Tick or untick one of the Address move's rows; Shift takes the range from the last one you clicked to this one. */
  function toggleTick(prUrl: string, shift: boolean) {
    const order = addressRows.map((line) => line.prUrl);
    const from = shift && lastTicked.current ? order.indexOf(lastTicked.current) : -1;
    const [first, last] = [from, order.indexOf(prUrl)].sort((x, y) => x - y);
    const range = from >= 0 ? order.slice(first, last! + 1) : [prUrl];
    const tick = here.unpicked.includes(prUrl);
    here.unpicked = tick ? here.unpicked.filter((item) => !range.includes(item)) : [...new Set([...here.unpicked, ...range])];
    lastTicked.current = prUrl;
    persist();
    bump();
  }
  function moveRow(delta: number) {
    const root = rootRef.current;
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>(ROW));
    if (!rows.length) return;
    const current = document.activeElement?.closest<HTMLElement>(ROW);
    const at = current ? rows.indexOf(current) : -1;
    const visible = rows.filter(inView);
    const next = at < 0 ? (delta > 0 ? visible[0] : visible.at(-1)) ?? rows[0]! : rows[Math.max(0, Math.min(rows.length - 1, at + delta))]!;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest" });
  }
  const toggleIn = (list: string[], item: string) => list.includes(item) ? list.filter((value) => value !== item) : [...list, item];
  /** A toggle's panel opens, closing any other; the same toggle closes it. */
  function openPanel(key: Panel, toggle = true) {
    here.panel = toggle && here.panel === key ? null : key;
    pendingAnchor.current = captureAnchor();
    persist(); bump();
  }
  /** A row in view, focused and flashed so the eye finds it: where a move shows it, else in All N PRs, which opens to show it. */
  function showRow(prUrl: string) {
    const line = lineOf(prUrl);
    if (!line?.row) return;
    const key = keyOf(line.row);
    const element = rootRef.current?.querySelector<HTMLElement>(rowAt(key));
    if (!element) { openPanel("all", false); pendingFocus.current = { row: key }; scrollFocus.current = true; return; }
    element.scrollIntoView({ block: "center" });
    element.focus({ preventScroll: true });
    if (!reduced()) element.animate([{ background: "rgba(56,189,248,.18)" }, { background: "transparent" }], { duration: 900 });
  }

  // ---- the one action runner: keys, buttons, the palette ---------------------
  function runAction(id: DeckActionId, line?: DeckLine, n?: number) {
    if (!on[id].on) return;
    const row = line ?? focused;
    switch (id) {
      case "next": case "prev": go({ step: id === "next" ? 1 : -1 }); return;
      case "jump": { const target = n ? numberedEffort(order, n) : null; if (target) go({ id: target }); return; }
      case "services": if (context.service) go({ id: context.service }); return;
      case "view": onView("inventory"); return;
      case "seen": markSeen(); return;
      case "hold-pile": setPile("hold"); return;
      case "done-pile": setPile("done"); return;
      // The card's chores, as its Advance line counts them: never a merge, review notes, or a thread's work.
      case "advance": if (card && on.advance.on) void batch.plan("advance", card.card.id, card.chores.prUrls); return;
      case "hold": if (card) openDialog({ kind: "hold", id: card.card.id, effortKey: card.card.key, name: card.card.name, reason: "" }); return;
      case "complete": if (card) openDialog({ kind: "complete", id: card.card.id }); return;
      case "held": openPanel("held", false); return;
      case "progress": here.open = toggleIn(here.open, "progress"); pendingAnchor.current = captureAnchor(); persist(); bump(); return;
      case "notes": {
        if (!card?.notes) return;
        // A second ⇧N goes back to the editor already open, with what you typed.
        if (notesEdit?.effortId === card.card.id) { rootRef.current?.querySelector<HTMLElement>("[data-deck-notes-editor]")?.focus(); return; }
        openPanel("notes", false);
        setNotesEdit({ effortId: card.card.id, draft: card.notes.body, revision: card.notes.revision, busy: false, error: null });
        return;
      }
      case "merge": {
        const list = line ? [line] : targets("merge", context);
        if (list.length) { opener.current = focusKey(document.activeElement); setMerging(list.map((item) => ({ target: item.prUrl, n: null }))); }
        return;
      }
      // Review notes are read and confirmed one PR at a time, never as a batch.
      case "confirm": {
        const target = line ?? targets("confirm", context)[0];
        if (target && card) notes.show(target.prUrl, target.ref, card.card.id);
        return;
      }
      case "nudge": case "request": case "ready": case "release": case "fix": {
        const list = line ? [line] : targets(id, context);
        if (list.length) void batch.plan(KIND_OF[id]!, card?.card.id ?? null, list.map((item) => item.prUrl));
        return;
      }
      // The Address move's ticked rows go to one batch thread, started now; each row says why any stays out, and Undo takes it back for 8 s.
      case "address": if (card && on.address.on) void batch.address(card.card.id, addressPicks(selected).map((item) => item.prUrl)); return;
      case "undo": if (undo?.live()) { const run = undo; setUndo(null); setFlash(null); void run.run(); } return;
      case "hold-pr": {
        if (!row?.row) return;
        // A release lists the PR first and waits out its Undo window, as Release does from Held.
        if (row.row.hold) runAction("release", row);
        else openDialog({ kind: "hold-pr", prUrl: row.prUrl, ref: row.ref, reason: "" });
        return;
      }
      case "revoke": {
        if (!row?.row?.confirmation) return;
        void rpc.call("inventory_confirm_revoke", { prUrl: row.prUrl }).then((result) => { say(result.ok ? result.detail : result.error); load(); },
          (cause: unknown) => say(message(cause)));
        return;
      }
      // A row's ↻, or g, reads that row.
      case "refresh": refreshRows(row ? [row] : []); return;
      case "row-next": moveRow(1); return;
      case "row-prev": moveRow(-1); return;
      case "select": if (row && on.select.on) toggleTick(row.prUrl, false); return;
      case "select-section": here.unpicked = []; persist(); bump(); say(`Ticked ${addressRows.length} on Your turn.`); return;
      case "expand": {
        // ↵ on a row folds the move it's in, and focus goes to the move's header; elsewhere, it toggles the card's first move.
        const move = card?.moves.find((item) => row && item.prUrls.includes(row.prUrl)) ?? card?.moves[0];
        if (!move) return;
        here.open = toggleIn(here.open, move.kind);
        pendingAnchor.current = captureAnchor();
        pendingFocus.current = { id: `move-${move.kind}` };
        persist(); bump();
        return;
      }
      case "clear":
        if (selected.length) { here.unpicked = addressRows.map((item) => item.prUrl); persist(); bump(); }
        else if (here.panel) openPanel(here.panel as Panel);
        return;
      case "open-thread": if (row?.row?.thread) navigate.toThread(row.row.thread.id); return;
      case "open-pr": if (row) navigate.openUrl(row.prUrl); return;
      case "accept": { const key = row && groupOf(row.prUrl); if (key) acceptGroup(key); return; }
      case "move": { const list = scopeRows(); if (list.length) openDialog({ kind: "move", prUrls: list.map((item) => item.prUrl), refs: refs(list), group: null }); return; }
      case "one-off": {
        // A service card's rows have no effort yet; an effort's move out of it, and Undo puts them back.
        const list = line ? [line] : scopeRows();
        const prUrls = list.map((item) => item.prUrl);
        if (!card || !prUrls.length) return;
        if (card.card.kind === "service") void oneOff(prUrls, null);
        else void classify(() => rpc.call("classify_one_off", { prUrls, from: card.card.id }), null, prUrls);
        return;
      }
      case "new-effort": { const list = scopeRows(); if (list.length) openDialog({ kind: "new", prUrls: list.map((item) => item.prUrl), refs: refs(list), name: "", goal: "", group: null }); return; }
      case "promote": {
        // Every open PR on the service card, as one new effort named for its repository; its threads follow their PRs.
        const list = lines.filter((line) => line.row && !line.ghost);
        if (card?.card.kind === "service" && list.length) openDialog({ kind: "new", prUrls: list.map((item) => item.prUrl), refs: refs(list),
          name: card.card.repo?.split("/").at(-1) ?? "", goal: "", group: null, promote: { id: card.card.id, name: card.card.name } });
        return;
      }
      case "rule": {
        loadRules();
        const first = view?.active.find((item) => !item.oneOff && item.kind === "effort");
        openDialog({ kind: "rule", draft: { kind: "ticket-prefix", value: "", effortId: first?.id ?? "", now: true }, matches: null });
        return;
      }
      case "seed": {
        openDialog({ kind: "seed", proposals: null, keyed: true, picked: [], requestId: crypto.randomUUID() });
        void rpc.call("linear_seed_preview", null).then((result) => setDialog((current) => current?.kind === "seed" ? { ...current, ...result } : current),
          (cause: unknown) => setDialogError(message(cause)));
        return;
      }
      case "palette": openDialog({ kind: "palette", query: "", highlight: 0 }); return;
      case "help": openDialog({ kind: "help" }); return;
    }
  }
  const runRef = useRef(runAction);
  runRef.current = runAction;

  const archiveThread = async (command: Extract<DeckCommand, { kind: "archive-thread" }>) => {
    if (archivingRef.current) return;
    archivingRef.current = true; setArchivingThread(command.id);
    try {
      const result = await rpc.call("thread_archive", { threadId: command.id, cardId: command.cardId });
      if (!result.ok) { say(result.error); return; }
      let used = false;
      setUndo({ label: `Archive ${command.title}`, live: () => !used, run: async () => {
        used = true;
        try {
          const restored = await rpc.call("thread_restore", { threadId: command.id });
          say(restored.ok ? `Restored ${command.title}.` : restored.error); load();
        } catch { say("Couldn't restore the thread. Try Archived threads."); }
      } });
      say(`Archived ${command.title}.`, true, 15_000); load();
    } catch (cause) { say(`Couldn't confirm the archive. Check Archived threads before retrying. ${message(cause)}`); }
    finally { archivingRef.current = false; setArchivingThread(null); }
  };

  const run = (command: DeckCommand) => {
    switch (command.kind) {
      case "action": runAction(command.id, command.line); return;
      case "go": go({ id: command.id }); return;
      case "view": onView(command.view); return;
      case "row": { const line = lineOf(command.prUrl); if (line) runAction(command.id, line); return; }
      case "open": navigate.openUrl(command.url); return;
      case "select": toggleTick(command.prUrl, command.shift); return;
      case "fold": here.open = toggleIn(here.open, command.key); pendingAnchor.current = captureAnchor(); persist(); bump(); return;
      case "panel": openPanel(command.key); return;
      case "group": acceptGroup(command.key); return;
      case "undo-group": {
        const done = accepted.get(command.key);
        if (done) void rpc.call("classify_undo", { actionId: done.actionId }).then((result) => {
          if (result.ok) setAccepted((current) => { const next = new Map(current); next.delete(command.key); return next; });
          else say(result.error);
          load();
        }, (cause: unknown) => say(message(cause)));
        return;
      }
      case "undo-batch": void rpc.call("deck_batch_undo", { batchId: command.batchId }).then((result) => { say(result.ok ? "Undone. Nothing was sent." : result.error); load(); },
        (cause: unknown) => say(message(cause))); return;
      case "thread": navigate.toThread(command.id); return;
      case "archive-thread": void archiveThread(command); return;
      case "archived-threads": setArchivedOpen(true); return;
      case "jump": navigate.toPluginPanel("board", { subPath: inventoryPrPath(command.prUrl) }); return;
      case "resume": { const item = view?.held.find((entry) => entry.id === command.id); if (item) void movePile("resume", item); return; }
      case "reopen": { const item = view?.done.find((entry) => entry.id === command.id); if (item) void movePile("reopen", item); return; }
      case "rule-remove": void rpc.call("classify_rule_remove", { ruleId: command.id }).then((result) => { if (!result.ok) say(result.error); loadRules(); }); return;
      case "pile": setPile(command.pile); return;
      case "notes-draft": setNotesEdit((current) => current && { ...current, draft: command.text }); return;
      case "notes-cancel": setNotesEdit(null); pendingFocus.current = { id: "notes-edit" }; return;
      case "notes-save": saveNotes(); return;
    }
  };

  // The keys: one registry, only while focus is in the deck (or nowhere), and never while you type.
  useRegistryKeys(rootRef, { on: () => availability(contextRef.current), run: (id, n) => runRef.current(id, undefined, n), say,
    isRow: (target) => target.dataset.inventoryRow !== undefined });
  const contextRef = useRef(context);
  contextRef.current = context;

  const loadRules = useCallback(() => {
    void rpc.call("classify_get", null).then((result) => setRules(result.rules.map((rule) => ({ id: rule.id,
      text: `${RULE_WORDS[rule.kind]}${rule.kind === "stack" ? "" : ` ${rule.value}`} → ${rule.effortName ?? "its base's effort"} · ${rule.hits} this week` }))), () => undefined);
  }, [rpc]);
  const loaded = view !== null;
  const sorting = card?.card.kind === "service";
  useEffect(() => { if (loaded && sorting) loadRules(); }, [loaded, sorting, loadRules]);
  // A link opens its card once the deck has it. A deck read before the link can predate the card, so a miss reads again and waits for
  // that. Then the link leaves the route, so coming Back to the deck keeps your place.
  const linked = useRef<{ card: string; reads: number } | null>(null);
  useEffect(() => {
    if (!loaded || !openCard) { linked.current = null; return; }
    if (linked.current?.card !== openCard) linked.current = { card: openCard, reads };
    const step = deckLinkStep(openCard, { ring, held: view?.held.map((item) => item.id) ?? [] }, reads > linked.current.reads);
    if (step === "read") { load(); return; }
    if (step === "open" && openCard !== cur) { place.cur = openCard; persist(); bump(); }
    if (step === "hold") setPile("hold");
    navigate.toPluginPanel("board", { subPath: "deck", replace: true });
  }, [loaded, reads, openCard]);
  // A rule's preview counts the PRs it would place now, before you add it.
  const ruleDraft = dialog?.kind === "rule" ? dialog.draft : null;
  useEffect(() => {
    if (!ruleDraft || (ruleDraft.kind !== "stack" && !ruleDraft.value.trim())) return;
    let live = true;
    const timer = window.setTimeout(() => void rpc.call("classify_rule_preview", { kind: ruleDraft.kind, value: ruleDraft.value.trim(),
      effortKey: ruleDraft.kind === "stack" ? null : ruleDraft.effortId }).then((result) => {
      if (live) setDialog((current) => current?.kind === "rule" ? { ...current, matches: result.ok ? result.prUrls.length : null } : current);
    }, () => undefined), 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [ruleDraft?.kind, ruleDraft?.value, ruleDraft?.effortId, rpc]);

  // ---- render ----------------------------------------------------------------
  const pileItems = {
    held: (view?.held ?? []).map((item) => ({ id: item.id, key: item.key, name: item.name, note: `${item.reason || "No reason given"} · ${item.stats.open} open` })),
    done: (view?.done ?? []).map((item) => ({ id: item.id, key: item.key, name: item.name, archived: item.archived, note: `${item.merged} merged · ${item.open} open` })),
  };
  const palette = paletteItems(on, chips, pileItems, cur, true);
  const runPalette = (item: PaletteItem) => {
    closeDialog();
    // The palette's action runs once its dialog has handed focus back, so a confirm it opens takes focus from there.
    window.setTimeout(() => {
      if (item.action) runAction(item.action.id);
      else if (item.target?.kind === "go") go({ id: item.target.id });
      else if (item.target) run({ kind: item.target.kind, id: item.target.id });
    }, 0);
  };
  const complete = dialog?.kind === "complete" ? cardOf(dialog.id) : null;
  const weakGroup = dialog?.kind === "weak" ? card?.suggest.find((item) => item.key === dialog.group) ?? null : null;
  const matches = dialog?.kind === "palette" ? paletteMatch(palette, dialog.query) : [];
  const moveTargets = [...order.flatMap((id) => { const item = cards.get(id); return item?.card.kind === "effort" ? [{ id, name: item.card.name, color: item.color,
    open: item.card.stats.open }] : []; })];

  return <>
    <ArchivedThreadsDialog open={archivedOpen} onOpenChange={(open) => { setArchivedOpen(open); if (!open) load(); }} />
    <DeckPane chips={chips} cur={cur} card={card} overview={cur === "overview" && view ? overview : null} rules={rules} held={pileItems.held} done={pileItems.done} pile={pile} announce={announce}
      read={{ text: view ? readText(view, now) : "Reading…", error, busy: !!view?.refreshing, onRefresh: view ? refresh.all : undefined }}
      seen={{ changed: changedHere, available: context.seenAvailable, note: seenNote }}
      kit={{ lines: rowLines, picked: new Set(selected.map((line) => line.prUrl)), live: batch.live, left: batch.details, working: batch.working?.prUrls,
        reading: new Set([...refreshing.keys(), ...refresh.reading]), refusal: batch.refusal, archivingThread }}
      open={new Set(here.open)} panel={here.panel as Panel | null} on={on} hints={hintKeys(context, on)}
      flash={flash ?? (refresh.progress ? { text: refresh.progress, undo: false, busy: true } : batch.sending ? { text: batch.sending, undo: false, busy: true } : null)}
      run={run} onPalette={() => runAction("palette")} onHelp={() => runAction("help")}
      onUndo={() => runAction("undo")} rootRef={rootRef} scrollerRef={scrollerRef} slackRef={slackRef} viewRef={viewRef} chipsRef={chipsRef}
      notes={notesEdit && notesEdit.effortId === cur ? notesEdit : null} markdown={(body) => <Markdown content={body} />} />
    {batch.element}
    {notes.element}
    <DeckDialog open={dialog?.kind === "hold" || dialog?.kind === "hold-pr"} title={dialog?.kind === "hold" ? `Hold ${dialog.name}` : dialog?.kind === "hold-pr" ? `Hold ${dialog.ref}` : ""}
      sub={dialog?.kind === "hold" ? "It leaves the active pile. Its PRs stay open and stop counting; nothing acts on them until you resume it."
        : "Nothing acts on this PR, and no batch writes to it, until you release it."}
      onClose={closeDialog} onReturn={returnFocus} onConfirmKey={() => holdNow()}>
      {dialog?.kind === "hold" || dialog?.kind === "hold-pr" ? <HoldBody reason={dialog.reason} onReason={(value) => setDialog({ ...dialog, reason: value })} busy={busy}
        error={dialogError} onHold={() => holdNow()} onCancel={closeDialog} /> : null}
    </DeckDialog>
    <DeckDialog open={!!complete} title={complete ? `Complete ${complete.name}?` : ""} sub="Still open first:" onClose={closeDialog} onReturn={returnFocus}
      onConfirmKey={() => { if (complete) void movePile("complete", complete); }}>
      {complete ? <CompleteBody screen={cards.get(complete.id) ?? cardScreen(complete, seen, { now })} busy={busy} error={dialogError}
        onComplete={() => void movePile("complete", complete)} onCancel={closeDialog} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "rule"} title="Standing rules" sub="Each places new PRs on every read. Removing one leaves the PRs it placed."
      onClose={closeDialog} onReturn={returnFocus} onConfirmKey={() => addRule()}>
      {dialog?.kind === "rule" ? <RuleBody draft={dialog.draft} efforts={moveTargets} rules={rules} matches={dialog.matches} busy={busy} error={dialogError}
        onDraft={(draft) => setDialog({ ...dialog, draft })} onAdd={() => addRule()} onRemove={(id) => run({ kind: "rule-remove", id })} onCancel={closeDialog} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "new"} title={dialog?.kind === "new" && dialog.promote ? `Promote ${dialog.promote.name}` : "New effort"}
      sub={dialog?.kind === "new" && dialog.promote ? "It becomes an effort with all its open PRs. Their threads go with them."
        : "A new card joins the end of the pile. You stay where you are."} onClose={closeDialog} onReturn={returnFocus} onConfirmKey={() => createEffort()}>
      {dialog?.kind === "new" ? <NewEffortBody name={dialog.name} goal={dialog.goal} refs={dialog.refs} busy={busy} error={dialogError}
        onName={(value) => setDialog({ ...dialog, name: value })} onGoal={(value) => setDialog({ ...dialog, goal: value })} onCreate={() => createEffort()} onCancel={closeDialog} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "move"} title={dialog?.kind === "move" ? `Move ${dialog.prUrls.length} PR${dialog.prUrls.length === 1 ? "" : "s"} to` : ""}
      onClose={closeDialog} onReturn={returnFocus}>
      {dialog?.kind === "move" ? <MoveBody refs={dialog.refs} busy={busy} error={dialogError}
        efforts={moveTargets} onMove={(effortId) => void assign(effortId, dialog.prUrls, dialog.group)}
        onNew={() => setDialog({ kind: "new", prUrls: dialog.prUrls, refs: dialog.refs, name: "", goal: "", group: dialog.group })} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "seed"} title="Seed efforts from Linear" sub="One effort per Linear project on your open PRs. Check the ones to create."
      onClose={closeDialog} onReturn={returnFocus} onConfirmKey={() => seed()}>
      {dialog?.kind === "seed" ? <SeedBody proposals={dialog.proposals} keyed={dialog.keyed} picked={new Set(dialog.picked)} busy={busy} error={dialogError}
        onPick={(projectId) => setDialog({ ...dialog, picked: toggleIn(dialog.picked, projectId) })} onCreate={() => seed()} onCancel={closeDialog} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "weak"} title="Weak suggestion" sub={weakGroup ? `Only weak signals point ${dialog?.kind === "weak" && dialog.lines.length === 1 ? "this"
      : "these"} at ${weakGroup.title}. Check each first.` : undefined} onClose={closeDialog} onReturn={returnFocus} onConfirmKey={() => acceptWeak()}>
      {dialog?.kind === "weak" && weakGroup ? <WeakBody lines={dialog.lines} label={acceptLabel(weakGroup.target, dialog.lines.length)} busy={busy} error={dialogError}
        onAccept={() => acceptWeak()} onCancel={closeDialog} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "palette"} title="All actions" bare onClose={closeDialog} onReturn={returnFocus}>
      {dialog?.kind === "palette" ? <div onKeyDown={(event) => {
        const live = matches.filter((item) => item.on);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setDialog({ ...dialog, highlight: Math.max(0, Math.min(live.length - 1, dialog.highlight + (event.key === "ArrowDown" ? 1 : -1))) });
        } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); const item = live[dialog.highlight]; if (item) runPalette(item); }
        else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); closeDialog(); }
      }}><PaletteBody query={dialog.query} items={matches} highlight={dialog.highlight} onQuery={(query) => setDialog({ ...dialog, query, highlight: 0 })}
        onRun={runPalette} onHighlight={(highlight) => setDialog({ ...dialog, highlight })} /></div> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "help"} wide closeKey="?" title="Keys and colors" sub="The same keys do the same thing in Efforts and All PRs. Grayed keys don't apply here."
      onClose={closeDialog} onReturn={returnFocus}>
      {dialog?.kind === "help" ? <HelpBody items={palette} /> : null}
    </DeckDialog>
    <MergePreviewDialog targets={merging} onClose={() => setMerging(null)} onMerged={load} onOpenUrl={(url) => navigate.openUrl(url)} onClosed={returnFocus}
      rows={(merging ?? []).flatMap(({ target }) => { const row = lines.find((line) => line.prUrl === target)?.row; return row ? [{ target, repo: row.repo, number: row.number, title: row.title }] : []; })} />
  </>;

  /** Save the open notes over the revision they started from; the tile then shows them rendered, and Undo saves what was there before. */
  function saveNotes() {
    const edit = notesEdit;
    if (!edit || edit.busy) return;
    const before = cardOf(edit.effortId)?.notes?.body ?? "";
    setNotesEdit({ ...edit, busy: true, error: null });
    void rpc.call("effort_notes_save", { effortKey: edit.effortId, body: edit.draft, revision: edit.revision }).then((result) => {
      if (!result.ok) { setNotesEdit((current) => current && { ...current, busy: false, error: result.error }); return; }
      setNotesEdit(null);
      viewPlace(edit.effortId).panel = "notes";
      persist();
      pendingFocus.current = { id: "notes-edit" };
      let used = false;
      setUndo({ label: "Notes saved", live: () => !used, run: async () => {
        used = true;
        const back = await rpc.call("effort_notes_save", { effortKey: edit.effortId, body: before, revision: result.notes.revision })
          .catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
        say(back.ok ? "Undone." : back.error);
        load();
      } });
      say("Notes saved.", true);
      load();
    }, (cause: unknown) => setNotesEdit((current) => current && { ...current, busy: false, error: message(cause) }));
  }
  function holdNow() {
    if (dialog?.kind === "hold") void movePile("hold", { id: dialog.id, key: dialog.effortKey, name: dialog.name }, dialog.reason.trim());
    if (dialog?.kind === "hold-pr" && !busy) {
      setBusy(true);
      void rpc.call("pr_hold_set", { prUrl: dialog.prUrl, held: true, reason: dialog.reason.trim() || undefined }).then(() => { setBusy(false); closeDialog(); say(`Held ${dialog.ref}.`); load(); },
        (cause: unknown) => { setBusy(false); setDialogError(message(cause)); });
    }
  }
  function addRule() {
    if (dialog?.kind !== "rule" || busy) return;
    const { draft } = dialog;
    setBusy(true);
    void rpc.call("classify_rule_add", { kind: draft.kind, value: draft.value.trim(), effortKey: draft.kind === "stack" ? null : draft.effortId, now: draft.now }).then((result) => {
      setBusy(false);
      if (!result.ok) { setDialogError(result.error); return; }
      closeDialog();
      const placed = result.actions.reduce((sum, action) => sum + action.added, 0);
      const text = placed ? `Rule added; it placed ${placed} PR${placed === 1 ? "" : "s"} now.` : "Rule added.";
      // Undo takes the rule back with every PR it placed now.
      let used = false;
      setUndo({ label: text, live: () => !used, run: async () => {
        used = true;
        const errors: string[] = [];
        try {
          for (const action of result.actions) { const undone = await rpc.call("classify_undo", { actionId: action.actionId }); if (!undone.ok) errors.push(undone.error); }
          const removed = await rpc.call("classify_rule_remove", { ruleId: result.rule.id });
          if (!removed.ok) errors.push(removed.error);
        } catch (cause) { errors.push(message(cause)); }
        say(errors[0] ?? "Undone.");
        loadRules();
        load();
      } });
      say(text, true);
      loadRules();
      load();
    }, (cause: unknown) => { setBusy(false); setDialogError(message(cause)); });
  }
  /** Each seeded effort is one classification, so Undo takes all of them back together. */
  function seed() {
    if (dialog?.kind !== "seed" || busy || !dialog.picked.length) return;
    setBusy(true);
    void rpc.call("linear_seed_create", { projectIds: dialog.picked, requestId: dialog.requestId }).then((result) => {
      setBusy(false);
      if (!result.ok) { setDialogError(result.error); return; }
      closeDialog();
      const made = result.created.map((item) => item.effort.name);
      const skipped = result.skipped.map((item) => `${item.name}: ${item.reason}`);
      const text = [made.length ? `Created ${made.join(", ")}` : "Created nothing", ...skipped.length ? [`skipped ${skipped.join("; ")}`] : []].join(" · ");
      let used = false;
      setUndo(made.length ? { label: text, live: () => !used, run: async () => {
        used = true;
        let error: string | null = null;
        for (const item of result.created) { const undone = await rpc.call("classify_undo", { actionId: item.actionId }); if (!undone.ok) error = undone.error; }
        say(error ?? "Undone.");
        load();
      } } : null);
      say(text, made.length > 0);
      load();
    }, (cause: unknown) => { setBusy(false); setDialogError(message(cause)); });
  }
  function acceptWeak() {
    if (dialog?.kind === "weak" && !busy) acceptGroup(dialog.group, { asked: dialog.lines });
  }
  function createEffort() {
    if (dialog?.kind !== "new" || busy || !dialog.name.trim()) return;
    const { prUrls, name, goal, group, promote } = dialog;
    void classify(() => rpc.call("classify_new_effort", { name: name.trim(), goal: goal.trim(), prUrls, requestId: crypto.randomUUID() }), group, prUrls,
      promote?.id ?? null);
  }
}
