import { markPluginSyntheticEvent } from "./bb-commands";
import { showNotice } from "./bridge";
import {
  ATTRIBUTES,
  DIVIDER_ORIENTATIONS,
  EVENTS,
  SELECTORS,
  SPLIT_LIMITS,
} from "./constants";
import {
  getFocusedPaneElement,
  getThreadPaneElements,
  isPaneZoomed,
} from "./dom-actions";
import type { Direction } from "./types";

type Axis = "x" | "y";
type PaneSide = "after" | "before";

interface Span {
  start: number;
  end: number;
}

interface Point {
  x: number;
  y: number;
}

interface Divider {
  element: HTMLElement;
  rect: DOMRect;
}

// What bb's own drag code measures before it moves a divider.
interface DividerGrid {
  // From the near edge of the pane before the divider to the far edge of the
  // pane after it.
  pair: Span;
  thickness: number;
  paneCount: number;
  // The room that all panes of the row or column have together.
  paneRoom: number;
  evenSplitLine: number | null;
}

const EDGE_TOLERANCE_PX = 2;
const UNCHANGED_TOLERANCE_PX = 0.5;
const MIN_VISIBLE_PANE_PX = 1;
const SNAP_CLEARANCE_PX = SPLIT_LIMITS.snapCapturePx + 1;
// bb's handler captures the pointer of the press, and the browser throws a
// NotFoundError for a pointer id that is not active. The mouse always is, and
// it is pointer 1 in Chromium and Safari and pointer 0 in Firefox.
const MOUSE_POINTER_IDS = [1, 0] as const;
const POINTER_NOT_ACTIVE_ERROR = "NotFoundError";
const PRIMARY_BUTTON_HELD = 1;
const NO_BUTTON_HELD = 0;

export const SINGLE_PANE_NOTICE =
  "There is only one pane, so there is nothing to resize.";
export const ZOOMED_PANE_NOTICE =
  "Panes cannot be resized while a pane is zoomed.";
export const RESIZE_FAILED_NOTICE =
  "Resizing panes did not work in this version of bb.";

// pointer-not-active: bb's handler could not capture the pointer of the press.
type DragResult = "done" | "failed" | "pointer-not-active";

let hasReportedFailure = false;
let pendingCheckFrame: number | null = null;
let mousePointerId: number = MOUSE_POINTER_IDS[0];

export function cancelPendingResizeCheck(): void {
  if (pendingCheckFrame === null) return;
  cancelAnimationFrame(pendingCheckFrame);
  pendingCheckFrame = null;
}

export function resetPaneResize(): void {
  cancelPendingResizeCheck();
  hasReportedFailure = false;
  mousePointerId = MOUSE_POINTER_IDS[0];
}

function reportFailureOnce(): void {
  if (hasReportedFailure) return;
  hasReportedFailure = true;
  showNotice(RESIZE_FAILED_NOTICE);
}

function axisOf(direction: Direction): Axis {
  return direction === "left" || direction === "right" ? "x" : "y";
}

function signOf(direction: Direction): 1 | -1 {
  return direction === "right" || direction === "down" ? 1 : -1;
}

function spanAlong(rect: DOMRect, axis: Axis): Span {
  return axis === "x"
    ? { start: rect.left, end: rect.right }
    : { start: rect.top, end: rect.bottom };
}

function spanAcross(rect: DOMRect, axis: Axis): Span {
  return spanAlong(rect, axis === "x" ? "y" : "x");
}

function overlapOf(first: Span, second: Span): number {
  return Math.min(first.end, second.end) - Math.max(first.start, second.start);
}

function centreOf(span: Span): number {
  return (span.start + span.end) / 2;
}

function lengthOf(span: Span): number {
  return span.end - span.start;
}

function isEmpty(span: Span): boolean {
  return span.start > span.end;
}

// bb keeps the panes in the page while the side panel is widened until the
// conversation is hidden. They are then 0 pixels wide.
function isHidden(pane: DOMRect): boolean {
  return pane.width < MIN_VISIBLE_PANE_PX || pane.height < MIN_VISIBLE_PANE_PX;
}

function getDividers(axis: Axis, doc: Document): Divider[] {
  const orientation =
    axis === "x" ? DIVIDER_ORIENTATIONS.sideBySide : DIVIDER_ORIENTATIONS.stacked;
  return Array.from(doc.querySelectorAll<HTMLElement>(SELECTORS.splitDivider))
    .filter(
      (element) =>
        element.getAttribute(ATTRIBUTES.dividerOrientation) === orientation,
    )
    .map((element) => ({ element, rect: element.getBoundingClientRect() }));
}

function gapToPane(
  divider: DOMRect,
  pane: DOMRect,
  axis: Axis,
  side: PaneSide,
): number {
  const dividerSpan = spanAlong(divider, axis);
  const paneSpan = spanAlong(pane, axis);
  return side === "after"
    ? dividerSpan.start - paneSpan.end
    : paneSpan.start - dividerSpan.end;
}

function findDividerBeside(
  dividers: readonly Divider[],
  pane: DOMRect,
  axis: Axis,
  side: PaneSide,
): Divider | null {
  let best: Divider | null = null;
  let bestOverlap = 0;
  for (const divider of dividers) {
    const gap = gapToPane(divider.rect, pane, axis, side);
    if (Math.abs(gap) > EDGE_TOLERANCE_PX) continue;
    const overlap = overlapOf(
      spanAcross(divider.rect, axis),
      spanAcross(pane, axis),
    );
    if (overlap <= bestOverlap) continue;
    best = divider;
    bestOverlap = overlap;
  }
  return best;
}

// As in tmux: the divider on the pane's right or bottom edge, and the one on
// its left or top edge only when the pane has none there.
function findDivider(pane: DOMRect, axis: Axis, doc: Document): Divider | null {
  const dividers = getDividers(axis, doc);
  return (
    findDividerBeside(dividers, pane, axis, "after") ??
    findDividerBeside(dividers, pane, axis, "before")
  );
}

// The line bb pulls a dragged divider onto: the one that splits the row or
// column evenly. From equalGridCoordinate in bb's lib/split-resize-snap.ts.
function evenSplitLineOf(
  gridStart: number,
  paneRoom: number,
  thickness: number,
  boundaryIndex: number,
  paneCount: number,
): number | null {
  const isBoundary =
    Number.isInteger(boundaryIndex) &&
    boundaryIndex >= 1 &&
    boundaryIndex < paneCount;
  if (!isBoundary || paneRoom <= 0) return null;
  return (
    gridStart +
    (paneRoom * boundaryIndex) / paneCount +
    thickness * (boundaryIndex - 0.5)
  );
}

function readDividerGrid(divider: Divider, axis: Axis): DividerGrid | null {
  const { element, rect } = divider;
  const before = element.previousElementSibling;
  const after = element.nextElementSibling;
  const grid = element.closest(SELECTORS.splitGrid);
  if (before === null || after === null || grid === null) return null;
  const paneCount = Number(element.getAttribute(ATTRIBUTES.dividerPaneCount));
  if (!Number.isInteger(paneCount) || paneCount < 2) return null;
  const thickness = lengthOf(spanAlong(rect, axis));
  const gridSpan = spanAlong(grid.getBoundingClientRect(), axis);
  const paneRoom = lengthOf(gridSpan) - thickness * (paneCount - 1);
  return {
    pair: {
      start: spanAlong(before.getBoundingClientRect(), axis).start,
      end: spanAlong(after.getBoundingClientRect(), axis).end,
    },
    thickness,
    paneCount,
    paneRoom,
    evenSplitLine: evenSplitLineOf(
      gridSpan.start,
      paneRoom,
      thickness,
      Number(element.getAttribute(ATTRIBUTES.dividerBoundaryIndex)),
      paneCount,
    ),
  };
}

function rangeKeeping(grid: DividerGrid, minPanePx: number): Span {
  return {
    start: grid.pair.start + grid.thickness / 2 + minPanePx,
    end: grid.pair.end - grid.thickness / 2 - minPanePx,
  };
}

// bb pulls a pointer that comes close to the even-split line onto that line.
// Where the line itself is past a limit, the limit moves in front of that pull.
function clearOfSnap(range: Span, line: number | null): Span {
  if (line === null) return range;
  return {
    start:
      line < range.start
        ? Math.max(range.start, line + SNAP_CLEARANCE_PX)
        : range.start,
    end:
      line > range.end
        ? Math.min(range.end, line - SNAP_CLEARANCE_PX)
        : range.end,
  };
}

// The limits for the middle of the divider: start is as far as it may go
// towards the pane before it, end as far as it may go towards the pane after
// it. While a divider is dragged, bb only keeps the two panes beside it at
// their smallest share of the room those two have (pairRange). When it stores
// the result, it first brings every pane of the row or column up to that
// share of the whole row or column and takes the difference from the other
// panes, which moves dividers nobody touched. So the limits here are the
// stricter ones. In a row of seven or eight panes no pane can have that
// share, bb evens such a row out on every drop, and only pairRange is left.
function allowedRange(
  grid: DividerGrid,
  pairRoom: number,
  pairRange: Span,
): Span {
  if (grid.paneCount * SPLIT_LIMITS.minPaneShare > 1) return pairRange;
  const rowRoom = Math.max(grid.paneRoom, pairRoom);
  return clearOfSnap(
    rangeKeeping(grid, SPLIT_LIMITS.minPaneShare * rowRoom),
    grid.evenSplitLine,
  );
}

// The pane that gets smaller stops at its limit. A pane that a mouse drag
// left below its limit is taken up to it when it gets bigger, unless the two
// panes are too small together for both to be at their limit.
function stepWithin(range: Span, from: number, stepPx: number): number {
  const stepped = from + stepPx;
  if (!isEmpty(range)) {
    return Math.min(range.end, Math.max(range.start, stepped));
  }
  return stepPx > 0
    ? Math.min(stepped, range.end)
    : Math.max(stepped, range.start);
}

// Where bb puts a divider that is pressed, moved and released at one place.
function landingOf(
  pointer: number,
  pairRange: Span,
  line: number | null,
): number {
  if (line === null || line < pairRange.start || line > pairRange.end) {
    return pointer;
  }
  const isPulledOntoLine =
    Math.abs(pointer - line) <= SPLIT_LIMITS.snapCapturePx;
  return isPulledOntoLine ? line : pointer;
}

// Null when the divider cannot go any further that way. A step that is
// shorter than bb's pull onto the even-split line would leave a divider on
// that line where it is, so such a step goes on to the first place past the
// pull.
function dropPosition(
  grid: DividerGrid,
  from: number,
  direction: Direction,
  stepPx: number,
): number | null {
  const pairRoom = lengthOf(grid.pair) - grid.thickness;
  if (pairRoom <= 0) return null;
  const pairRange = rangeKeeping(grid, SPLIT_LIMITS.minPaneShare * pairRoom);
  const range = allowedRange(grid, pairRoom, pairRange);
  const sign = signOf(direction);
  const line = grid.evenSplitLine;
  const movesDivider = (pointer: number): boolean => {
    const landing = landingOf(pointer, pairRange, line);
    return (landing - from) * sign > UNCHANGED_TOLERANCE_PX;
  };
  const pointer = stepWithin(range, from, sign * stepPx);
  if (movesDivider(pointer)) return pointer;
  if (line === null) return null;
  const pastPull = line + sign * SNAP_CLEARANCE_PX;
  if ((pastPull - pointer) * sign <= 0) return null;
  const further = stepWithin(range, from, pastPull - from);
  return movesDivider(further) ? further : null;
}

function pointOn(divider: DOMRect, axis: Axis, along: number): Point {
  const across = centreOf(spanAcross(divider, axis));
  return axis === "x" ? { x: along, y: across } : { x: across, y: along };
}

function failureOf(error: unknown): DragResult {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? error.name
      : null;
  return name === POINTER_NOT_ACTIVE_ERROR ? "pointer-not-active" : "failed";
}

// An error thrown by a listener does not come back through dispatchEvent. The
// browser, and React for its own handlers, report it as an error event on the
// window while the dispatch is still running.
function dispatchPointer(
  target: HTMLElement,
  type: string,
  point: Point,
  buttons: number,
  pointerId: number,
): DragResult {
  const view = target.ownerDocument.defaultView;
  let result: DragResult = "done";
  const onError = (event: Event): void => {
    result = failureOf((event as ErrorEvent).error);
  };
  view?.addEventListener("error", onError);
  try {
    target.dispatchEvent(
      markPluginSyntheticEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons,
          clientX: point.x,
          clientY: point.y,
        }),
      ),
    );
  } catch (error) {
    result = failureOf(error);
  } finally {
    view?.removeEventListener("error", onError);
  }
  return result;
}

// bb places the divider where the pointer is, not by how far it moved, and a
// divider that starts on bb's even-split line stays snapped to it for the
// first move away from it. So the press already happens at the new place.
// Only a press says that the pointer is not active: bb captures it there.
function dragDividerAs(
  hitTarget: HTMLElement,
  to: Point,
  pointerId: number,
): DragResult {
  const steps = [
    { type: EVENTS.dividerDragStart, buttons: PRIMARY_BUTTON_HELD },
    { type: EVENTS.dividerDragMove, buttons: PRIMARY_BUTTON_HELD },
    { type: EVENTS.dividerDragEnd, buttons: NO_BUTTON_HELD },
  ];
  for (const { type, buttons } of steps) {
    const result = dispatchPointer(hitTarget, type, to, buttons, pointerId);
    if (result === "done") continue;
    const cancel = EVENTS.dividerDragCancel;
    dispatchPointer(hitTarget, cancel, to, NO_BUTTON_HELD, pointerId);
    return type === EVENTS.dividerDragStart ? result : "failed";
  }
  return "done";
}

// A press that the browser refuses for its pointer id has moved nothing, so
// the drag is made once more as the other pointer that a mouse can be. The id
// that worked is the one the next drag starts with.
function dragDivider(hitTarget: HTMLElement, to: Point): boolean {
  const result = dragDividerAs(hitTarget, to, mousePointerId);
  if (result !== "pointer-not-active") return result === "done";
  const other = MOUSE_POINTER_IDS.find((id) => id !== mousePointerId);
  if (other === undefined) return false;
  if (dragDividerAs(hitTarget, to, other) !== "done") return false;
  mousePointerId = other;
  return true;
}

function hasSameBox(first: DOMRect, second: DOMRect): boolean {
  return (
    Math.abs(first.left - second.left) <= UNCHANGED_TOLERANCE_PX &&
    Math.abs(first.top - second.top) <= UNCHANGED_TOLERANCE_PX &&
    Math.abs(first.width - second.width) <= UNCHANGED_TOLERANCE_PX &&
    Math.abs(first.height - second.height) <= UNCHANGED_TOLERANCE_PX
  );
}

function reportFailureUnlessResized(pane: HTMLElement, before: DOMRect): void {
  pendingCheckFrame = requestAnimationFrame(() => {
    pendingCheckFrame = null;
    if (hasSameBox(before, pane.getBoundingClientRect())) reportFailureOnce();
  });
}

// Returns whether the focused pane has a divider that the key moves, also when
// that divider is already as far that way as it can go. The key handler keeps
// the repeat window open only then.
export function resizeFocusedPane(
  direction: Direction,
  stepPx: number,
  doc: Document = document,
): boolean {
  cancelPendingResizeCheck();
  const panes = getThreadPaneElements(doc);
  if (panes.length === 0) return false;
  if (panes.length === 1) {
    showNotice(SINGLE_PANE_NOTICE);
    return false;
  }
  if (isPaneZoomed(doc)) {
    showNotice(ZOOMED_PANE_NOTICE);
    return false;
  }
  const pane = getFocusedPaneElement(doc);
  if (pane === null) return false;
  const axis = axisOf(direction);
  const paneRect = pane.getBoundingClientRect();
  if (isHidden(paneRect)) return false;
  const divider = findDivider(paneRect, axis, doc);
  if (divider === null) return false;
  const hitTarget = divider.element.querySelector<HTMLElement>(
    SELECTORS.splitDividerHitTarget,
  );
  const grid = readDividerGrid(divider, axis);
  if (
    hitTarget === null ||
    grid === null ||
    typeof PointerEvent !== "function"
  ) {
    reportFailureOnce();
    return false;
  }
  const from = centreOf(spanAlong(divider.rect, axis));
  const to = dropPosition(grid, from, direction, stepPx);
  if (to === null) return true;
  if (!dragDivider(hitTarget, pointOn(divider.rect, axis, to))) {
    reportFailureUnlessResized(pane, paneRect);
  }
  return true;
}
