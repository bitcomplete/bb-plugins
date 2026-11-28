import { COMPACT_VIEWPORT_QUERY } from "../components/ui/hooks/use-compact-viewport";
import { markPluginSyntheticEvent } from "./bb-commands";
import {
  ATTRIBUTES,
  EVENTS,
  SELECTION_MENU_BUTTON_LABEL,
  SELECTORS,
  SIDEBAR_OPEN_STATES,
} from "./constants";
import type { Edge } from "./types";

type SidebarStopPicker = (
  stops: readonly HTMLElement[],
) => HTMLElement | undefined;

const UNREACHABLE_ANCESTOR_SELECTOR = "[hidden], [inert]";
const TIMELINE_VIEWPORT_SELECTOR = `${SELECTORS.threadWindow} ${SELECTORS.scrollViewport}`;
const SIDEBAR_PLACEHOLDER_SELECTOR = `${SELECTORS.sidebarWindowedItem}${SELECTORS.sidebarWindowedNav}`;
const SIDEBAR_STOP_SELECTOR = `${SELECTORS.sidebarRow}, ${SIDEBAR_PLACEHOLDER_SELECTOR}`;
const SIDEBAR_WINDOW_RETRY_LIMIT = 30;
const SIDEBAR_FALLBACK_PAGE_ROWS = 10;
const LAYOUT_ROUNDING_PX = 0.5;

let pendingSidebarFrame: number | null = null;
let clickedSidebarRow: Element | null = null;

function isFocusedPane(pane: HTMLElement): boolean {
  return (
    pane.getAttribute(ATTRIBUTES.paneFocused) === "true" &&
    pane.getAttribute(ATTRIBUTES.paneHiddenByZoom) !== "true"
  );
}

function clickElement(element: HTMLElement | null): boolean {
  if (element === null || element.matches(":disabled")) return false;
  element.click();
  return true;
}

function clickInFocusedPane(selector: string, doc: Document): boolean {
  const pane = getFocusedPaneElement(doc);
  if (pane === null) return false;
  return clickElement(pane.querySelector<HTMLElement>(selector));
}

export function cancelPendingSidebarFocus(): void {
  if (pendingSidebarFrame === null) return;
  cancelAnimationFrame(pendingSidebarFrame);
  pendingSidebarFrame = null;
}

function blurActiveElement(doc: Document): void {
  const active = doc.activeElement;
  if (active === null || active === doc.body) return;
  if (active instanceof HTMLElement || active instanceof SVGElement) {
    active.blur();
  }
}

export function getThreadPaneElements(doc: Document = document): HTMLElement[] {
  return Array.from(
    doc.querySelectorAll<HTMLElement>(SELECTORS.splitPane),
  ).filter((pane) => pane.closest(SELECTORS.sidePanelSplitContainer) === null);
}

export function getFocusedPaneElement(doc: Document = document): HTMLElement | null {
  const panes = getThreadPaneElements(doc);
  const focused = panes.find(isFocusedPane);
  if (focused !== undefined) return focused;
  return panes.length === 1 ? panes[0] : null;
}

export function getPaneElementById(
  paneId: string,
  doc: Document = document,
): HTMLElement | null {
  return (
    getThreadPaneElements(doc).find(
      (pane) => pane.getAttribute(ATTRIBUTES.paneId) === paneId,
    ) ?? null
  );
}

// In a narrow window bb shows one pane and treats a split as a plain navigation.
export function isCompactViewport(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia(COMPACT_VIEWPORT_QUERY).matches;
}

export function isPaneZoomed(doc: Document = document): boolean {
  return getThreadPaneElements(doc).some(
    (pane) => pane.getAttribute(ATTRIBUTES.paneMaximized) === "true",
  );
}

export function focusPaneElement(
  pane: HTMLElement | null,
  doc: Document = document,
): void {
  cancelPendingSidebarFocus();
  if (pane !== null && pane.hasAttribute("tabindex")) {
    pane.focus({ preventScroll: true });
  }
  if (pane !== null && doc.activeElement === pane) return;
  blurActiveElement(doc);
}

function panePointerEvent(type: string, buttons: number): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons,
    isPrimary: true,
    pointerType: "mouse",
  });
  return markPluginSyntheticEvent(event);
}

// bb focuses a pane from a React onPointerDown handler on the pane root. The
// handler reads nothing from the event, and React needs it to bubble to its root.
// The press is marked as the plugin's own, so that the key handler does not
// take it for a mouse press of the user. The release follows at once: bb's
// selection menu takes the mouse button for held from a press until a release
// and does not follow the selection meanwhile.
export function activatePaneByPointer(
  paneId: string,
  doc: Document = document,
): boolean {
  const pane = getPaneElementById(paneId, doc);
  if (pane === null) return false;
  pane.dispatchEvent(panePointerEvent(EVENTS.paneFocusPointer, 1));
  pane.dispatchEvent(panePointerEvent(EVENTS.paneFocusPointerEnd, 0));
  return true;
}

export function clickClosePane(doc: Document = document): boolean {
  return clickInFocusedPane(SELECTORS.closePaneButton, doc);
}

export function clickMaximizePane(doc: Document = document): boolean {
  return clickInFocusedPane(SELECTORS.maximizePaneButton, doc);
}

export function getTimelineViewport(doc: Document = document): HTMLElement | null {
  const pane = getFocusedPaneElement(doc);
  if (pane === null && getThreadPaneElements(doc).length > 0) return null;
  const viewports = (pane ?? doc).querySelectorAll<HTMLElement>(
    TIMELINE_VIEWPORT_SELECTOR,
  );
  return (
    Array.from(viewports).find(
      (viewport) => viewport.closest(SELECTORS.sidePanelSplitContainer) === null,
    ) ?? null
  );
}

// bb's scroll position keeper snaps a scripted scroll back to the bottom unless
// it has just seen user scroll input, and it counts any wheel event as input.
function announceUserScroll(viewport: HTMLElement, deltaY: number): void {
  viewport.dispatchEvent(new WheelEvent(EVENTS.userScrollInput, { deltaY }));
}

function scrollViewportBy(viewport: HTMLElement, deltaPx: number): void {
  announceUserScroll(viewport, deltaPx);
  if (typeof viewport.scrollBy !== "function") {
    viewport.scrollTop += deltaPx;
    return;
  }
  viewport.scrollBy({ top: deltaPx, behavior: "instant" });
}

export function scrollTimelineBy(deltaPx: number, doc: Document = document): boolean {
  const viewport = getTimelineViewport(doc);
  if (viewport === null) return false;
  scrollViewportBy(viewport, deltaPx);
  return true;
}

export function isSidebarOpen(doc: Document = document): boolean {
  const sidebar = doc.querySelector(SELECTORS.sidebarRoot);
  const stateHolder = sidebar?.closest(SELECTORS.sidebarStateHolder) ?? null;
  if (stateHolder === null) {
    const trigger = doc.querySelector(SELECTORS.sidebarTrigger);
    return trigger?.getAttribute(ATTRIBUTES.sidebarTriggerExpanded) === "true";
  }
  const state = stateHolder.getAttribute(ATTRIBUTES.sidebarState);
  return state !== null && SIDEBAR_OPEN_STATES.includes(state);
}

export function toggleSidebar(doc: Document = document): boolean {
  return clickElement(doc.querySelector<HTMLElement>(SELECTORS.sidebarTrigger));
}

function isSidebarRow(element: Element): element is HTMLAnchorElement {
  return element.matches(SELECTORS.sidebarRow);
}

function isReachableSidebarElement(element: HTMLElement): boolean {
  if (element.closest(SELECTORS.sidebarOverflow) !== null) return false;
  if (element.closest(UNREACHABLE_ANCESTOR_SELECTOR) !== null) return false;
  if (typeof element.checkVisibility !== "function") return true;
  return element.checkVisibility({ visibilityProperty: true });
}

function getSidebarStops(doc: Document): HTMLElement[] {
  const sidebar = doc.querySelector(SELECTORS.sidebarRoot);
  if (sidebar === null) return [];
  return Array.from(
    sidebar.querySelectorAll<HTMLElement>(SIDEBAR_STOP_SELECTOR),
  ).filter(isReachableSidebarElement);
}

function scrollIntoViewIfPossible(
  element: HTMLElement,
  block: ScrollLogicalPosition,
): void {
  if (typeof element.scrollIntoView !== "function") return;
  element.scrollIntoView({ block });
}

function precedes(element: Element, other: Element): boolean {
  const position = element.compareDocumentPosition(other);
  return (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function scrollUpBy(scroller: HTMLElement, distancePx: number): void {
  if (typeof scroller.scrollBy !== "function") {
    scroller.scrollTop -= distancePx;
    return;
  }
  scroller.scrollBy({ top: -distancePx, behavior: "instant" });
}

// The browser takes a row for visible once it is inside the box of the
// scroller, also when a header that bb pins at the top of that box covers it,
// as after a move up the list. Only the headers in front of the row can cover
// it, and they stay where they are while the list is scrolled up from under
// them. So the row is moved down to the lower edge of the last one of them
// that it would still touch.
function revealBelowPinnedHeaders(row: HTMLElement): void {
  const scroller = row.closest<HTMLElement>(SELECTORS.sidebarScroller);
  const rect = row.getBoundingClientRect();
  if (scroller === null || rect.height <= 0) return;
  const headers = Array.from(
    scroller.querySelectorAll(SELECTORS.sidebarPinnedHeader),
  )
    .filter((header) => !header.contains(row) && precedes(header, row))
    .map((header) => header.getBoundingClientRect())
    .filter((header) => header.height > 0)
    .sort((a, b) => a.top - b.top);
  let top = rect.top;
  for (const header of headers) {
    const covers =
      header.top < top + rect.height &&
      header.bottom > top + LAYOUT_ROUNDING_PX;
    if (covers) top = header.bottom;
  }
  if (top > rect.top) scrollUpBy(scroller, top - rect.top);
}

function focusSidebarRow(row: HTMLAnchorElement, doc: Document): boolean {
  clickedSidebarRow = null;
  row.focus({ preventScroll: true });
  scrollIntoViewIfPossible(row, "nearest");
  revealBelowPinnedHeaders(row);
  return doc.activeElement === row;
}

function hasFocusMovedElsewhere(
  focusedBefore: Element | null,
  doc: Document,
): boolean {
  const active = doc.activeElement;
  return active !== null && active !== doc.body && active !== focusedBefore;
}

// bb's sidebar only mounts the rows near its viewport and leaves placeholders
// for the rest. Scrolling a placeholder into view makes bb mount its rows a
// few frames later, so look again on the next frame.
function focusSidebarStop(
  pick: SidebarStopPicker,
  block: ScrollLogicalPosition,
  doc: Document,
  attemptsLeft: number = SIDEBAR_WINDOW_RETRY_LIMIT,
): boolean {
  const stop = pick(getSidebarStops(doc));
  if (stop === undefined) return false;
  if (isSidebarRow(stop)) return focusSidebarRow(stop, doc);
  if (attemptsLeft === 0) return false;
  scrollIntoViewIfPossible(stop, block);
  const focusedBefore = doc.activeElement;
  pendingSidebarFrame = requestAnimationFrame(() => {
    pendingSidebarFrame = null;
    if (hasFocusMovedElsewhere(focusedBefore, doc)) return;
    focusSidebarStop(pick, block, doc, attemptsLeft - 1);
  });
  return true;
}

export function getSidebarRows(doc: Document = document): HTMLAnchorElement[] {
  return getSidebarStops(doc).filter(isSidebarRow);
}

export function getFocusedSidebarRow(
  doc: Document = document,
): HTMLAnchorElement | null {
  return (
    doc.activeElement?.closest<HTMLAnchorElement>(SELECTORS.sidebarRow) ?? null
  );
}

// A click leaves keyboard focus on the clicked thread row. The key handler
// treats such a row as a plain link, so the sidebar keys stay with rows that
// were reached from the keyboard.
export function noteSidebarPointerDown(target: EventTarget | null): void {
  clickedSidebarRow =
    target instanceof Element ? target.closest(SELECTORS.sidebarRow) : null;
}

export function isSidebarRowFocusedByPointer(doc: Document = document): boolean {
  return clickedSidebarRow !== null && doc.activeElement === clickedSidebarRow;
}

export function isInSelectionMenu(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(SELECTORS.selectionMenu) !== null
  );
}

function hasSelectionMenuButton(popover: Element): boolean {
  return Array.from(popover.querySelectorAll("button")).some(
    (button) => button.textContent?.trim() === SELECTION_MENU_BUTTON_LABEL,
  );
}

export function isSelectionMenu(modal: Element): boolean {
  if (modal.matches(SELECTORS.selectionMenu)) return true;
  return modal.matches(SELECTORS.popover) && hasSelectionMenuButton(modal);
}

function getOpenModals(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll(SELECTORS.openModal));
}

// bb's selection menu matches bb's own test for an open dialog, but it shows
// next to any selected text and the keys must go on working then.
export function hasOpenModal(doc: Document = document): boolean {
  return getOpenModals(doc).some((modal) => !isSelectionMenu(modal));
}

export function hasSidebarSelection(doc: Document = document): boolean {
  return doc.querySelector(SELECTORS.sidebarSelectedRow) !== null;
}

export function sidebarRowThreadId(row: Element | null): string | null {
  const threadId = row?.getAttribute(ATTRIBUTES.sidebarThreadId);
  if (threadId === null || threadId === undefined || threadId === "") {
    return null;
  }
  return threadId;
}

export function focusSidebarRowForThread(
  threadId: string | null,
  doc: Document = document,
): boolean {
  cancelPendingSidebarFocus();
  const rows = getSidebarRows(doc);
  const row =
    rows.find(
      (candidate) =>
        threadId !== null && sidebarRowThreadId(candidate) === threadId,
    ) ?? rows[0];
  if (row === undefined) return false;
  return focusSidebarRow(row, doc);
}

// A move that would pass the first or the last row ends on that row.
function moveSidebarFocusBy(
  current: HTMLAnchorElement,
  rows: number,
  doc: Document,
): boolean {
  cancelPendingSidebarFocus();
  return focusSidebarStop(
    (stops) => {
      const index = stops.indexOf(current);
      if (index === -1) return undefined;
      const target = Math.min(stops.length - 1, Math.max(0, index + rows));
      return target === index ? undefined : stops[target];
    },
    "nearest",
    doc,
  );
}

function isLastSidebarStop(
  row: HTMLAnchorElement,
  delta: 1 | -1,
  doc: Document,
): boolean {
  const stops = getSidebarStops(doc);
  return row === (delta === 1 ? stops[stops.length - 1] : stops[0]);
}

// As in tmux's lists, a move by one row goes around: from the last row to the
// first, and from the first to the last.
export function moveSidebarFocus(delta: 1 | -1, doc: Document = document): boolean {
  const current = getFocusedSidebarRow(doc);
  const startEdge = delta === 1 ? "top" : "bottom";
  if (current === null) return focusSidebarEdge(startEdge, doc);
  if (isLastSidebarStop(current, delta, doc)) {
    return focusSidebarEdge(startEdge, doc);
  }
  return moveSidebarFocusBy(current, delta, doc);
}

// As many rows as the sidebar shows at once, less one, so that a row of the
// page before stays in view.
function sidebarPageRows(row: HTMLElement, doc: Document): number {
  const sidebar = doc.querySelector(SELECTORS.sidebarRoot);
  const rowHeight = row.getBoundingClientRect().height;
  if (sidebar === null || rowHeight <= 0) return SIDEBAR_FALLBACK_PAGE_ROWS;
  const shown = Math.floor(sidebar.getBoundingClientRect().height / rowHeight);
  return Math.max(1, shown - 1);
}

// As in tmux's lists, a move by a page stops at the first and the last row.
export function pageSidebarFocus(delta: 1 | -1, doc: Document = document): boolean {
  const current = getFocusedSidebarRow(doc);
  if (current === null) {
    return focusSidebarEdge(delta === 1 ? "top" : "bottom", doc);
  }
  return moveSidebarFocusBy(current, delta * sidebarPageRows(current, doc), doc);
}

export function focusSidebarEdge(edge: Edge, doc: Document = document): boolean {
  cancelPendingSidebarFocus();
  return focusSidebarStop(
    (stops) => (edge === "top" ? stops[0] : stops[stops.length - 1]),
    edge === "top" ? "start" : "end",
    doc,
  );
}

export function runSelfCheck(doc: Document = document): string[] {
  const missing: string[] = [];
  const sidebar = doc.querySelector(SELECTORS.sidebarRoot);
  if (sidebar === null) missing.push("sidebarRoot");
  if (sidebar !== null && sidebar.closest(SELECTORS.sidebarStateHolder) === null) {
    missing.push("sidebarStateHolder");
  }
  if (doc.querySelector(SELECTORS.sidebarTrigger) === null) {
    missing.push("sidebarTrigger");
  }
  const panes = getThreadPaneElements(doc);
  if (panes.length > 1 && !panes.some(isFocusedPane)) missing.push("paneFocused");
  return missing;
}
