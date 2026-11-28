// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPluginSyntheticEvent } from "./bb-commands";
import { getUiState, resetStore } from "./bridge";
import {
  RESIZE_FAILED_NOTICE,
  SINGLE_PANE_NOTICE,
  ZOOMED_PANE_NOTICE,
  cancelPendingResizeCheck,
  resetPaneResize,
  resizeFocusedPane,
} from "./pane-resize";
import type { Direction } from "./types";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PaneNode {
  pane: string;
}

interface SplitNode {
  dir: "row" | "col";
  dividers: string[];
  children: Layout[];
  sizes?: number[];
}

type Layout = PaneNode | SplitNode;

interface WorkspaceOptions {
  focused: string;
  zoomed?: string;
  box?: Box;
}

interface SeenEvent {
  type: string;
  divider: string | null;
  isOnHitTarget: boolean;
  x: number;
  y: number;
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  button: number;
  buttons: number;
  bubbles: boolean;
  cancelable: boolean;
  isOwn: boolean;
}

type DragRow = [type: string, divider: string, x: number, y: number];

const STEP = 48;
const POINTER_TYPES = ["pointerdown", "pointermove", "pointerup", "pointercancel"];
const WORKSPACE: Box = { left: 240, top: 40, width: 1001, height: 601 };
const SNAP_CAPTURE_PX = 12;
const SNAP_RELEASE_PX = 30;
const MIN_PAIR_FRACTION = 0.15;
const MAX_PAIR_FRACTION = 0.85;
const BB_MIN_SIZE = 0.15;
const BB_MAX_SIZE = 0.85;
const BB_SIZE_EPSILON = 1e-12;
// Sizes are shares of a row. One pixel of a row this wide is about 0.001.
const SAME_SIZE_DIGITS = 9;
// Three columns of 400 pixels and two dividers.
const THREE_COLUMN_BOX: Box = { left: 240, top: 40, width: 1202, height: 601 };

const SIDE_BY_SIDE: Layout = {
  dir: "row",
  dividers: ["a|b"],
  children: [{ pane: "a" }, { pane: "b" }],
};

const STACKED: Layout = {
  dir: "col",
  dividers: ["a/b"],
  children: [{ pane: "a" }, { pane: "b" }],
};

const THREE_COLUMNS: Layout = {
  dir: "row",
  dividers: ["a|b", "b|c"],
  children: [{ pane: "a" }, { pane: "b" }, { pane: "c" }],
};

// Two columns. The left one stacks a over b. The right one stacks c over a
// row of d and e.
const NESTED: Layout = {
  dir: "row",
  dividers: ["left|right"],
  children: [
    { dir: "col", dividers: ["a/b"], children: [{ pane: "a" }, { pane: "b" }] },
    {
      dir: "col",
      dividers: ["c/d"],
      children: [
        { pane: "c" },
        { dir: "row", dividers: ["d|e"], children: [{ pane: "d" }, { pane: "e" }] },
      ],
    },
  ],
};

// Two rows of two panes, so that two vertical dividers lie on one line.
const GRID: Layout = {
  dir: "col",
  dividers: ["top/bottom"],
  children: [
    { dir: "row", dividers: ["a|b"], children: [{ pane: "a" }, { pane: "b" }] },
    { dir: "row", dividers: ["c|d"], children: [{ pane: "c" }, { pane: "d" }] },
  ],
};

const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
let seen: SeenEvent[];
let listeners: AbortController;

function runFrame(): void {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}

function place(element: HTMLElement, box: Box): void {
  element.getBoundingClientRect = () =>
    new DOMRect(box.left, box.top, box.width, box.height);
}

function slice(box: Box, horizontal: boolean, offset: number, size: number): Box {
  return horizontal
    ? { left: offset, top: box.top, width: size, height: box.height }
    : { left: box.left, top: offset, width: box.width, height: size };
}

// The fixtures below mirror bb 0.50.1 markup: SplitThreadArea.tsx (SplitTree
// for pane roots and grid roots, SplitDivider for the dividers),
// SplitWorkspaceSecondaryPanelHost.tsx (the panel group and the handle of the
// right panel) and SidebarSplitContainer.tsx (the side panel's own panes and
// dividers). bb's style classes are left out, apart from the one that hides a
// divider, because the plugin build would copy them into the plugin's own
// stylesheet. jsdom has no layout, so every box is worked out here.
function buildPane(node: PaneNode, box: Box, options: WorkspaceOptions): HTMLElement {
  const zoomed = options.zoomed ?? null;
  const isMaximized = zoomed === node.pane;
  const isHiddenByZoom = zoomed !== null && !isMaximized;
  const pane = document.createElement("div");
  pane.tabIndex = -1;
  pane.setAttribute("data-split-pane-id", node.pane);
  pane.setAttribute("data-focused", node.pane === options.focused ? "true" : "false");
  if (isMaximized) pane.setAttribute("data-maximized", "true");
  if (isHiddenByZoom) pane.setAttribute("aria-hidden", "true");
  pane.innerHTML = `
    <div data-thread-window=""><div data-page-scroll-viewport=""></div></div>
    <div aria-hidden="true" data-pane-focus-scrim=""></div>`;
  place(pane, isMaximized ? (options.box ?? WORKSPACE) : box);
  return pane;
}

function buildDivider(
  split: SplitNode,
  index: number,
  box: Box,
  isHidden: boolean,
): HTMLElement {
  const horizontal = split.dir === "row";
  const divider = document.createElement("div");
  divider.setAttribute("role", "separator");
  divider.setAttribute("data-split-resize-grid-boundary", String(index));
  divider.setAttribute("data-split-resize-grid-count", String(split.children.length));
  divider.setAttribute("aria-orientation", horizontal ? "vertical" : "horizontal");
  divider.dataset.test = split.dividers[index - 1];
  if (isHidden) divider.className = "invisible";
  place(divider, box);
  const hitTarget = document.createElement("div");
  hitTarget.setAttribute("aria-hidden", "true");
  hitTarget.setAttribute("data-split-divider-hit-target", "");
  place(
    hitTarget,
    horizontal
      ? { ...box, left: box.left - 6, width: 12 }
      : { ...box, top: box.top - 6, height: 12 },
  );
  divider.append(hitTarget);
  return divider;
}

function buildNode(node: Layout, box: Box, options: WorkspaceOptions): HTMLElement {
  if ("pane" in node) return buildPane(node, box, options);
  const horizontal = node.dir === "row";
  const count = node.children.length;
  const root = document.createElement("div");
  root.setAttribute("data-split-resize-grid-root", "");
  place(root, box);
  const content = (horizontal ? box.width : box.height) - (count - 1);
  const sizes = node.sizes ?? node.children.map(() => 1 / count);
  let offset = horizontal ? box.left : box.top;
  node.children.forEach((child, index) => {
    if (index > 0) {
      const dividerBox = slice(box, horizontal, offset, 1);
      root.append(buildDivider(node, index, dividerBox, options.zoomed !== undefined));
      offset += 1;
    }
    const size = content * sizes[index];
    const childBox = slice(box, horizontal, offset, size);
    const wrapper = document.createElement("div");
    wrapper.style.flex = `${sizes[index]} 1 0`;
    place(wrapper, childBox);
    wrapper.append(buildNode(child, childBox, options));
    root.append(wrapper);
    offset += size;
  });
  return root;
}

function panelGroupHtml(sidePanelHtml: string): string {
  return `
    <main>
      <div>
        <div data-panel-group="" data-split-resize-grid-root="">
          <div data-panel="" id="split-workspace-main-panel">
            <div data-test="main-area"></div>
          </div>
          <div role="separator" data-panel-resize-handle-enabled="true" data-panel-resize-snap-handle="" aria-label="Resize right panel" tabindex="-1" data-test="panel-handle">
            <span aria-hidden="true" data-panel-resize-hit-target=""></span>
          </div>
          <div data-panel="" id="thread-secondary-panel">${sidePanelHtml}</div>
        </div>
      </div>
    </main>`;
}

const SIDE_PANEL_HTML = `
  <div data-sidebar-split-container="" data-sidebar-split-root-direction="row">
    <div data-split-resize-grid-root="">
      <div style="flex: 1 1 0px"></div>
      <div role="separator" data-split-resize-grid-boundary="1" data-split-resize-grid-count="2" aria-label="Resize right panel panes" aria-orientation="vertical" data-test="side-panel-columns">
        <div aria-hidden="true" data-split-divider-hit-target=""></div>
      </div>
      <div style="flex: 1 1 0px">
        <div data-split-resize-grid-root="">
          <div style="flex: 1 1 0px"></div>
          <div role="separator" data-split-resize-grid-boundary="1" data-split-resize-grid-count="2" aria-label="Resize stacked right panel panes" aria-orientation="horizontal" data-test="side-panel-rows">
            <div aria-hidden="true" data-split-divider-hit-target=""></div>
          </div>
          <div style="flex: 1 1 0px"></div>
        </div>
      </div>
    </div>
    <div data-split-pane-id="pane-1" data-focused="true"></div>
    <div data-split-pane-id="pane-2" data-focused="false"></div>
    <div data-split-pane-id="pane-3" data-focused="false"></div>
  </div>`;

function mountWorkspace(layout: Layout, options: WorkspaceOptions): void {
  document.body.innerHTML = panelGroupHtml(SIDE_PANEL_HTML);
  testElement("main-area").append(buildNode(layout, options.box ?? WORKSPACE, options));
}

// With a single pane bb renders no split tree. The pane root then comes from
// SecondaryPanelLayout.tsx and carries no data-focused attribute.
function mountSinglePane(): void {
  document.body.innerHTML = panelGroupHtml(SIDE_PANEL_HTML);
  const pane = document.createElement("div");
  pane.setAttribute("data-split-pane-id", "a");
  place(pane, WORKSPACE);
  testElement("main-area").append(pane);
}

function testElement(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-test="${name}"]`);
  if (element === null) throw new Error(`fixture ${name} is missing`);
  return element;
}

function hitTargetOf(name: string): HTMLElement {
  const hitTarget = testElement(name).firstElementChild;
  if (!(hitTarget instanceof HTMLElement)) {
    throw new Error(`divider ${name} has no hit target`);
  }
  return hitTarget;
}

function paneElement(paneId: string): HTMLElement {
  const pane = document.querySelector<HTMLElement>(
    `main [data-test="main-area"] [data-split-pane-id="${paneId}"]`,
  );
  if (pane === null) throw new Error(`pane ${paneId} is missing`);
  return pane;
}

function boxOf(element: HTMLElement): Box {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
}

function record(event: Event): void {
  if (!(event instanceof PointerEvent)) return;
  const target = event.target instanceof Element ? event.target : null;
  const divider = target?.closest<HTMLElement>('[role="separator"]') ?? null;
  seen.push({
    type: event.type,
    divider: divider?.dataset.test ?? null,
    isOnHitTarget: target !== null && target === divider?.firstElementChild,
    x: event.clientX,
    y: event.clientY,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isPrimary: event.isPrimary,
    button: event.button,
    buttons: event.buttons,
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    isOwn: isPluginSyntheticEvent(event),
  });
}

function seenRows(): DragRow[] {
  return seen.map((event) => [event.type, event.divider ?? "none", event.x, event.y]);
}

function dragRows(divider: string, x: number, y: number): DragRow[] {
  return [
    ["pointerdown", divider, x, y],
    ["pointermove", divider, x, y],
    ["pointerup", divider, x, y],
  ];
}

function resize(direction: Direction, stepPx = STEP): DragRow[] {
  seen = [];
  resizeFocusedPane(direction, stepPx);
  return seenRows();
}

function noticeText(): string | null {
  return getUiState().notice?.text ?? null;
}

// bb's repair of the sizes of one row or column, normalizeSizes in
// lib/split-layout/ops.ts: every pane is brought to between 15 and 85 percent
// of the whole row, and what that adds or takes is spread over the others.
function bbNormalizeSizes(sizes: readonly number[]): number[] {
  const count = sizes.length;
  const equal = Array.from({ length: count }, () => 1 / count);
  if (sizes.some((size) => !Number.isFinite(size) || size <= 0)) return equal;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (!Number.isFinite(total) || total <= 0) return equal;
  const clamp = (size: number): number =>
    Math.min(BB_MAX_SIZE, Math.max(BB_MIN_SIZE, size));
  const normalized = sizes.map((size) => clamp(size / total));
  for (let pass = 0; pass < count + 1; pass += 1) {
    const currentTotal = normalized.reduce((sum, size) => sum + size, 0);
    const difference = 1 - currentTotal;
    if (Math.abs(difference) <= BB_SIZE_EPSILON) break;
    const adjustable = normalized
      .map((size, index) => ({ index, size }))
      .filter(({ size }) => (difference > 0 ? size < BB_MAX_SIZE : size > BB_MIN_SIZE));
    if (adjustable.length === 0) return equal;
    const adjustment = difference / adjustable.length;
    for (const { index } of adjustable) {
      normalized[index] = clamp(normalized[index] + adjustment);
    }
  }
  const finalTotal = normalized.reduce((sum, size) => sum + size, 0);
  const correctionIndex = normalized.findIndex((size) => {
    const corrected = size + (1 - finalTotal);
    return corrected >= BB_MIN_SIZE && corrected <= BB_MAX_SIZE;
  });
  if (correctionIndex !== -1) normalized[correctionIndex] += 1 - finalTotal;
  return normalized;
}

// What bb stores when a drag ends, resizeSplit in the same file: it repairs
// the sizes first and only then gives the two panes beside the divider their
// new shares of what the two have together.
function bbResizeSplit(
  sizes: readonly number[],
  childIndex: number,
  fraction: number,
): number[] {
  const next = bbNormalizeSizes(sizes);
  const pairTotal = next[childIndex] + next[childIndex + 1];
  const pairFraction = Math.min(MAX_PAIR_FRACTION, Math.max(MIN_PAIR_FRACTION, fraction));
  next[childIndex] = pairTotal * pairFraction;
  next[childIndex + 1] = pairTotal * (1 - pairFraction);
  return next;
}

function throwOn(name: string, type: string): void {
  hitTargetOf(name).addEventListener(
    type,
    () => {
      throw new Error(`bb could not handle ${type}`);
    },
    { signal: listeners.signal },
  );
}

// The place bb snaps a divider to: the line that splits its row or column
// evenly. From equalGridCoordinate in lib/split-resize-snap.ts.
function evenSplitLine(divider: HTMLElement, horizontal: boolean): number | null {
  const grid = divider.closest<HTMLElement>("[data-split-resize-grid-root]");
  if (grid === null) return null;
  const gridRect = grid.getBoundingClientRect();
  const boundaryIndex = Number(divider.getAttribute("data-split-resize-grid-boundary"));
  const childCount = Number(divider.getAttribute("data-split-resize-grid-count"));
  const extent = horizontal
    ? divider.getBoundingClientRect().width
    : divider.getBoundingClientRect().height;
  const span = horizontal ? gridRect.width : gridRect.height;
  const contentSpan = span - extent * (childCount - 1);
  const start = horizontal ? gridRect.left : gridRect.top;
  return (
    start + (contentSpan * boundaryIndex) / childCount + extent * (boundaryIndex - 0.5)
  );
}

// bb's rules for where a dragged divider ends up, from
// createSplitResizeSnapResolver in lib/split-resize-snap.ts: the divider goes
// where the pointer is, is pulled onto the even-split line within 12 pixels
// of it, and once it is on that line it stays there until the pointer has
// been more than 30 pixels away for two moves in a row.
function createBbSnapResolver(extent: number, line: number | null) {
  let fastCrossingAnchor: number | null = null;
  let lastPointer: number | null = null;
  let releasePending = false;
  let snapped = false;

  function clamp(fraction: number): number {
    return Math.min(MAX_PAIR_FRACTION, Math.max(MIN_PAIR_FRACTION, fraction));
  }

  function staysOnLine(pointer: number, previous: number | null, gridLine: number): boolean {
    const distance = Math.abs(pointer - gridLine);
    const previousDelta = previous === null ? null : previous - gridLine;
    const pointerDelta = pointer - gridLine;
    const crossedLine =
      previousDelta !== null &&
      ((previousDelta < 0 && pointerDelta >= 0) ||
        (previousDelta > 0 && pointerDelta <= 0));
    if (distance <= SNAP_CAPTURE_PX) {
      fastCrossingAnchor = null;
      releasePending = false;
      return true;
    }
    if (crossedLine) {
      fastCrossingAnchor = distance > SNAP_RELEASE_PX ? pointer : null;
      releasePending = false;
      return true;
    }
    if (!snapped) return false;
    if (distance <= SNAP_RELEASE_PX) {
      fastCrossingAnchor = null;
      releasePending = false;
      return true;
    }
    if (
      fastCrossingAnchor !== null &&
      Math.abs(pointer - fastCrossingAnchor) <= SNAP_RELEASE_PX
    ) {
      releasePending = false;
      return true;
    }
    if (releasePending) return false;
    releasePending = true;
    return true;
  }

  return (start: number, end: number, pointer: number): number => {
    const contentSpan = end - start - extent;
    const unsnapped = clamp(
      contentSpan > 0 ? (pointer - start - extent / 2) / contentSpan : 0.5,
    );
    const previous = lastPointer;
    lastPointer = pointer;
    if (line === null || contentSpan <= 0) {
      releasePending = false;
      snapped = false;
      return unsnapped;
    }
    const onLine = clamp((line - start - extent / 2) / contentSpan);
    const reachable =
      Math.abs(start + contentSpan * onLine + extent / 2 - line) <= 0.01;
    if (reachable && staysOnLine(pointer, previous, line)) {
      snapped = true;
      return onLine;
    }
    fastCrossingAnchor = null;
    releasePending = false;
    snapped = false;
    return unsnapped;
  };
}

// Stands in for bb's own drag code, SplitDivider.handlePointerDown in
// SplitThreadArea.tsx: it captures the pointer of the press, follows the moves
// and the release of that same pointer on the hit target, and stores the
// share of the pane before the divider when the button is released. The
// browser only lets it capture a pointer that is active, which the mouse
// always is: pointer 1 in Chromium and Safari, pointer 0 in Firefox.
function installBbDragHandler(name: string, mousePointerId = 1): number[] {
  const stored: number[] = [];
  const divider = testElement(name);
  const hitTarget = hitTargetOf(name);
  const horizontal = divider.getAttribute("aria-orientation") === "vertical";
  const position = (event: PointerEvent): number =>
    horizontal ? event.clientX : event.clientY;
  hitTarget.setPointerCapture = (pointerId: number): void => {
    if (pointerId === mousePointerId) return;
    throw new DOMException("No active pointer with the given id is found.", "NotFoundError");
  };
  hitTarget.addEventListener(
    "pointerdown",
    (event) => {
      event.preventDefault();
      const previous = divider.previousElementSibling;
      const next = divider.nextElementSibling;
      if (previous === null || next === null) return;
      const previousRect = previous.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      const start = horizontal ? previousRect.left : previousRect.top;
      const end = horizontal ? nextRect.right : nextRect.bottom;
      if (end - start <= 0) return;
      hitTarget.setPointerCapture(event.pointerId);
      divider.dataset.dragging = "true";
      const pointerId = event.pointerId;
      const dividerRect = divider.getBoundingClientRect();
      const resolve = createBbSnapResolver(
        horizontal ? dividerRect.width : dividerRect.height,
        evenSplitLine(divider, horizontal),
      );
      resolve(start, end, position(event));
      let pendingFraction: number | null = null;
      const drag = new AbortController();
      const finish = (commit: boolean): void => {
        drag.abort();
        delete divider.dataset.dragging;
        if (commit && pendingFraction !== null) stored.push(pendingFraction);
      };
      hitTarget.addEventListener(
        "pointermove",
        (moveEvent) => {
          if (moveEvent.pointerId !== pointerId) return;
          pendingFraction = resolve(start, end, position(moveEvent));
        },
        { signal: drag.signal },
      );
      hitTarget.addEventListener(
        "pointerup",
        (upEvent) => {
          if (upEvent.pointerId === pointerId) finish(true);
        },
        { signal: drag.signal },
      );
      hitTarget.addEventListener(
        "pointercancel",
        (cancelEvent) => {
          if (cancelEvent.pointerId === pointerId) finish(false);
        },
        { signal: drag.signal },
      );
    },
    { signal: listeners.signal },
  );
  return stored;
}

interface LiveRow {
  content: number;
  sizes: () => number[];
  press: (focused: string, direction: Direction, stepPx?: number) => DragRow[];
}

// One row or column of panes named a, b, c and so on that answers a drag the
// way bb does: every press lays the panes out from the sizes bb has stored,
// and a drag that bb commits changes those sizes through bbResizeSplit.
function mountLiveRow(
  dir: "row" | "col",
  initialSizes: readonly number[],
  box: Box = WORKSPACE,
): LiveRow {
  const names = initialSizes.map((_, index) => String.fromCharCode(97 + index));
  const dividers = names.slice(1).map((name, index) => `${names[index]}|${name}`);
  const span = dir === "row" ? box.width : box.height;
  let sizes = [...initialSizes];
  return {
    content: span - (names.length - 1),
    sizes: () => [...sizes],
    press: (focused, direction, stepPx = STEP) => {
      const layout: Layout = {
        dir,
        dividers,
        children: names.map((pane) => ({ pane })),
        sizes,
      };
      mountWorkspace(layout, { focused, box });
      const stored = dividers.map((name) => installBbDragHandler(name));
      const rows = resize(direction, stepPx);
      stored.forEach((fractions, index) => {
        for (const fraction of fractions) sizes = bbResizeSplit(sizes, index, fraction);
      });
      return rows;
    },
  };
}

// A small seeded random number generator (mulberry32), so that a failing run
// can be repeated.
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// What bb does to the page while the side panel is widened until the
// conversation is hidden (SplitWorkspaceSecondaryPanelHost.tsx gives the main
// panel no width): the panes stay in the page and are 0 pixels wide, and each
// divider keeps its 1 pixel.
function hideConversationArea(): void {
  const area = testElement("main-area");
  const columns = Array.from(
    area.querySelectorAll<HTMLElement>(":scope > [data-split-resize-grid-root] > *"),
  );
  let left = WORKSPACE.left;
  for (const column of columns) {
    const width = column.getAttribute("role") === "separator" ? 1 : 0;
    const box = { left, top: WORKSPACE.top, width, height: WORKSPACE.height };
    place(column, box);
    for (const inner of column.querySelectorAll<HTMLElement>("*")) place(inner, box);
    left += width;
  }
  for (const root of area.querySelectorAll<HTMLElement>(":scope > [data-split-resize-grid-root]")) {
    place(root, { ...WORKSPACE, width: 0 });
  }
}

beforeEach(() => {
  frames.clear();
  seen = [];
  listeners = new AbortController();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  for (const type of POINTER_TYPES) {
    document.addEventListener(type, record, { signal: listeners.signal });
  }
  // jsdom prints an error that a listener threw unless a page listener
  // claims it, as bb's own error reporting would.
  window.addEventListener("error", (event) => event.preventDefault(), {
    signal: listeners.signal,
  });
});

afterEach(() => {
  listeners.abort();
  resetPaneResize();
  resetStore();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("resizeFocusedPane with panes side by side", () => {
  it("moves the divider on the right edge of the left pane to the right", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });

    expect(resize("right")).toEqual(dragRows("a|b", 788.5, 340.5));
    expect(noticeText()).toBeNull();
  });

  it("moves that same divider to the left on left", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });

    expect(resize("left")).toEqual(dragRows("a|b", 692.5, 340.5));
  });

  it("uses the divider on the left edge of a pane that has none on its right", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "b" });

    expect(resize("right")).toEqual(dragRows("a|b", 788.5, 340.5));
    expect(resize("left")).toEqual(dragRows("a|b", 692.5, 340.5));
  });

  it("does nothing and says nothing on up and down, which have no divider", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });

    expect(resize("up")).toEqual([]);
    expect(resize("down")).toEqual([]);
    expect(noticeText()).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("prefers the divider on the right edge of a pane that has one on each side", () => {
    mountWorkspace(THREE_COLUMNS, { focused: "b" });

    expect(resize("right")).toEqual(dragRows("b|c", 955.5, 340.5));
    expect(resize("left")).toEqual(dragRows("b|c", 859.5, 340.5));
  });

  it("works for a pane at the left edge of the window", () => {
    mountWorkspace(SIDE_BY_SIDE, {
      focused: "a",
      box: { left: 0, top: 0, width: 801, height: 601 },
    });

    expect(resize("left")).toEqual(dragRows("a|b", 352.5, 300.5));
    expect(resize("right")).toEqual(dragRows("a|b", 448.5, 300.5));
  });

  it("moves by the step it is given", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });

    expect(resize("right", 32)).toEqual(dragRows("a|b", 772.5, 340.5));

    mountWorkspace(SIDE_BY_SIDE, {
      focused: "a",
      box: { left: 0, top: 0, width: 2001, height: 601 },
    });

    expect(resize("left", 400)).toEqual(dragRows("a|b", 600.5, 300.5));
  });

  it("shortens a step that would take a pane below bb's smallest size", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });

    expect(resize("left", 400)).toEqual(dragRows("a|b", 390.5, 340.5));
    expect(resize("right", 400)).toEqual(dragRows("a|b", 1090.5, 340.5));
  });
});

describe("resizeFocusedPane with stacked panes", () => {
  it("moves the divider on the bottom edge of the top pane down and up", () => {
    mountWorkspace(STACKED, { focused: "a" });

    expect(resize("down")).toEqual(dragRows("a/b", 740.5, 388.5));
    expect(resize("up")).toEqual(dragRows("a/b", 740.5, 292.5));
  });

  it("uses the divider on the top edge of a pane that has none below", () => {
    mountWorkspace(STACKED, { focused: "b" });

    expect(resize("down")).toEqual(dragRows("a/b", 740.5, 388.5));
    expect(resize("up")).toEqual(dragRows("a/b", 740.5, 292.5));
  });

  it("does nothing and says nothing on left and right, which have no divider", () => {
    mountWorkspace(STACKED, { focused: "b" });

    expect(resize("left")).toEqual([]);
    expect(resize("right")).toEqual([]);
    expect(noticeText()).toBeNull();
  });
});

describe("resizeFocusedPane in a nested layout", () => {
  it.each<[string, Direction, string, number, number]>([
    ["a", "right", "left|right", 788.5, 340.5],
    ["a", "left", "left|right", 692.5, 340.5],
    ["a", "down", "a/b", 490, 388.5],
    ["a", "up", "a/b", 490, 292.5],
    ["b", "right", "left|right", 788.5, 340.5],
    ["b", "down", "a/b", 490, 388.5],
    ["b", "up", "a/b", 490, 292.5],
    ["c", "left", "left|right", 692.5, 340.5],
    ["c", "right", "left|right", 788.5, 340.5],
    ["c", "down", "c/d", 991, 388.5],
    ["d", "right", "d|e", 1039, 491],
    ["d", "left", "d|e", 943, 491],
    ["d", "up", "c/d", 991, 292.5],
    ["e", "left", "d|e", 943, 491],
    ["e", "right", "d|e", 1039, 491],
    ["e", "down", "c/d", 991, 388.5],
  ])("from pane %s, %s drags the divider %s", (focused, direction, divider, x, y) => {
    mountWorkspace(NESTED, { focused });

    expect(resize(direction)).toEqual(dragRows(divider, x, y));
  });

  it("picks the divider beside the pane when two dividers lie on one line", () => {
    mountWorkspace(GRID, { focused: "a" });
    expect(resize("right")).toEqual(dragRows("a|b", 788.5, 190));

    mountWorkspace(GRID, { focused: "c" });
    expect(resize("right")).toEqual(dragRows("c|d", 788.5, 491));

    mountWorkspace(GRID, { focused: "d" });
    expect(resize("up")).toEqual(dragRows("top/bottom", 740.5, 292.5));
  });

  it("takes a divider whose near side is within 2 pixels of the pane edge and no farther", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    const divider = testElement("a|b");

    place(divider, { ...boxOf(divider), left: 741.5 });
    expect(resize("right")).toEqual(dragRows("a|b", 790, 340.5));

    place(divider, { ...boxOf(divider), left: 743.5 });
    expect(resize("right")).toEqual([]);
    expect(noticeText()).toBeNull();
  });
});

describe("the drag that resizeFocusedPane imitates", () => {
  it("presses, moves and releases the mouse pointer on the divider's hit target", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });

    resize("right");

    expect(seen.map((event) => event.type)).toEqual([
      "pointerdown",
      "pointermove",
      "pointerup",
    ]);
    expect(seen.map((event) => event.buttons)).toEqual([1, 1, 0]);
    for (const event of seen) {
      expect(event).toMatchObject({
        divider: "a|b",
        isOnHitTarget: true,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        bubbles: true,
        cancelable: true,
      });
    }
  });

  it("marks all three events as the plugin's own", () => {
    mountWorkspace(STACKED, { focused: "a" });

    resize("down");

    expect(seen.map((event) => event.isOwn)).toEqual([true, true, true]);
  });

  it("is finished before the call returns and leaves no check behind", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    const stored = installBbDragHandler("a|b");

    resize("right");

    expect(stored).toHaveLength(1);
    expect(testElement("a|b").hasAttribute("data-dragging")).toBe(false);
    expect(frames.size).toBe(0);
    expect(noticeText()).toBeNull();
  });

  it("moves a divider that sits on bb's even-split line, where bb would hold a drag that starts on it", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    const stored = installBbDragHandler("a|b");

    resize("right");
    resize("left");

    expect(stored).toEqual([0.548, 0.452]);
  });

  it("moves a divider between stacked panes by the step as well", () => {
    mountWorkspace(STACKED, { focused: "a" });
    const stored = installBbDragHandler("a/b");

    resize("down");

    expect(stored).toEqual([0.58]);
  });

  it("moves a divider that is off the even-split line by the whole step", () => {
    mountWorkspace({ ...SIDE_BY_SIDE, sizes: [0.7, 0.3] } as Layout, { focused: "a" });
    const stored = installBbDragHandler("a|b");

    resize("left");

    expect(stored[0]).toBeCloseTo(0.652, 6);
  });

  it("lets bb pull the divider onto the even-split line when the step ends within 12 pixels of it", () => {
    mountWorkspace({ ...SIDE_BY_SIDE, sizes: [0.54, 0.46] } as Layout, { focused: "a" });
    const stored = installBbDragHandler("a|b");

    resize("left");

    expect(stored).toEqual([0.5]);
  });

  it("moves a divider on the even-split line past bb's pull when the step is shorter than the pull, as one cell of tmux is", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    const stored = installBbDragHandler("a|b");

    resize("right", 10);
    resize("left", 10);
    resize("right", 1);

    expect(stored).toEqual([0.513, 0.487, 0.513]);
  });

  it("goes back onto the even-split line from there with the same short step", () => {
    mountWorkspace({ ...SIDE_BY_SIDE, sizes: [0.513, 0.487] } as Layout, { focused: "a" });
    const stored = installBbDragHandler("a|b");

    resize("left", 10);

    expect(stored).toEqual([0.5]);
  });

  it("moves by the short step itself where bb's pull is out of reach", () => {
    mountWorkspace({ ...SIDE_BY_SIDE, sizes: [0.7, 0.3] } as Layout, { focused: "a" });
    const stored = installBbDragHandler("a|b");

    resize("left", 10);
    resize("right", 50);

    expect(stored[0]).toBeCloseTo(0.69, 6);
    expect(stored[1]).toBeCloseTo(0.75, 6);
  });

  it("stops at bb's smallest pane size", () => {
    mountWorkspace({ ...SIDE_BY_SIDE, sizes: [0.16, 0.84] } as Layout, { focused: "a" });
    const stored = installBbDragHandler("a|b");

    resize("left");

    expect(stored).toEqual([0.15]);
  });

  it("uses a pointer that bb's handler is allowed to capture", () => {
    mountWorkspace(NESTED, { focused: "d" });
    const stored = installBbDragHandler("d|e");

    resize("right");
    runFrame();

    expect(stored).toHaveLength(1);
    expect(noticeText()).toBeNull();
  });
});

describe("resizeFocusedPane with three or more panes in one row or column", () => {
  it("stops the left of three columns at 15 percent of the row and never moves the other divider", () => {
    const row = mountLiveRow("row", [1 / 3, 1 / 3, 1 / 3], THREE_COLUMN_BOX);
    const leftSizes: number[] = [1 / 3];

    for (let press = 0; press < 16; press += 1) {
      row.press("a", "left");
      const [left, , right] = row.sizes();
      expect(right, `press ${press + 1}`).toBeCloseTo(1 / 3, SAME_SIZE_DIGITS);
      expect(left, `press ${press + 1}`).toBeLessThanOrEqual(leftSizes[press] + 1e-9);
      leftSizes.push(left);
    }

    expect(leftSizes.slice(1, 5).map((size) => Math.round(size * row.content))).toEqual([
      352, 304, 256, 208,
    ]);
    expect(leftSizes[5]).toBeCloseTo(BB_MIN_SIZE, SAME_SIZE_DIGITS);
    expect(leftSizes[16]).toBeCloseTo(BB_MIN_SIZE, SAME_SIZE_DIGITS);
  });

  it("sends bb nothing more once the pane is at that size", () => {
    const row = mountLiveRow("row", [1 / 3, 1 / 3, 1 / 3], THREE_COLUMN_BOX);
    for (let press = 0; press < 5; press += 1) {
      expect(row.press("a", "left"), `press ${press + 1}`).toHaveLength(3);
    }
    const atSmallest = row.sizes();

    expect(row.press("a", "left")).toEqual([]);
    expect(row.press("a", "left", 400)).toEqual([]);

    expect(row.sizes()).toEqual(atSmallest);
    expect(noticeText()).toBeNull();
  });

  it("moves only the divider of the focused pane after another pane was shrunk as far as it goes", () => {
    const row = mountLiveRow("row", [1 / 3, 1 / 3, 1 / 3], THREE_COLUMN_BOX);
    for (let press = 0; press < 5; press += 1) row.press("a", "left");
    const before = row.sizes();

    expect(row.press("b", "right")).toHaveLength(3);

    const after = row.sizes();
    expect(after[0]).toBeCloseTo(before[0], SAME_SIZE_DIGITS);
    expect((after[1] - before[1]) * row.content).toBeCloseTo(STEP, 6);
    expect((before[2] - after[2]) * row.content).toBeCloseTo(STEP, 6);
  });

  it("keeps the two far columns of four where they are", () => {
    const row = mountLiveRow("row", [0.25, 0.25, 0.25, 0.25], {
      ...WORKSPACE,
      width: 1203,
    });

    for (let press = 0; press < 8; press += 1) {
      row.press("a", "left");
      const [left, , third, fourth] = row.sizes();
      expect(third, `press ${press + 1}`).toBeCloseTo(0.25, SAME_SIZE_DIGITS);
      expect(fourth, `press ${press + 1}`).toBeCloseTo(0.25, SAME_SIZE_DIGITS);
      expect(left, `press ${press + 1}`).toBeGreaterThanOrEqual(BB_MIN_SIZE - 1e-9);
    }

    expect(row.sizes()[0]).toBeCloseTo(BB_MIN_SIZE, SAME_SIZE_DIGITS);
  });

  it("does the same for stacked panes", () => {
    const column = mountLiveRow("col", [1 / 3, 1 / 3, 1 / 3], {
      ...WORKSPACE,
      height: 902,
    });

    for (let press = 0; press < 10; press += 1) {
      column.press("c", "down");
      const [top, , bottom] = column.sizes();
      expect(top, `press ${press + 1}`).toBeCloseTo(1 / 3, SAME_SIZE_DIGITS);
      expect(bottom, `press ${press + 1}`).toBeGreaterThanOrEqual(BB_MIN_SIZE - 1e-9);
    }

    expect(column.sizes()[2]).toBeCloseTo(BB_MIN_SIZE, SAME_SIZE_DIGITS);
    expect(column.press("c", "down")).toEqual([]);
    expect(column.press("c", "up")).toHaveLength(3);
  });

  // The line of an even split for a|b lies 6 pixels past the place where b is
  // at its smallest size, and bb pulls a divider dropped within 12 pixels of
  // that line onto it.
  it("stays clear of an even-split line that would pull a pane below that size", () => {
    const row = mountLiveRow("row", [300 / 1200, 274 / 1200, 626 / 1200], THREE_COLUMN_BOX);

    row.press("a", "right");
    row.press("a", "right");
    row.press("a", "right");

    const [left, middle, right] = row.sizes();
    expect(middle).toBeGreaterThanOrEqual(BB_MIN_SIZE - 1e-9);
    expect(left * row.content).toBeCloseTo(387, 6);
    expect(right).toBeCloseTo(626 / 1200, SAME_SIZE_DIGITS);
    expect(row.press("a", "right")).toEqual([]);
  });

  it("brings back a pane that a mouse drag left below that size, and does not shrink it further", () => {
    const row = mountLiveRow("row", [0.1, 1.7 / 3, 1 / 3], THREE_COLUMN_BOX);

    expect(row.press("a", "left")).toEqual([]);
    expect(row.sizes()[0]).toBe(0.1);

    expect(row.press("a", "right")).toHaveLength(3);
    expect(row.sizes()[0]).toBeGreaterThanOrEqual(BB_MIN_SIZE);
  });

  // Two mouse drags can leave two neighbours that are too small together for
  // both to have 15 percent of the row: here a has 20 percent and b has 9.
  it("only shrinks the bigger of two panes that are too small together, one step at a time", () => {
    const row = mountLiveRow("row", [0.2, 0.09, 0.71], THREE_COLUMN_BOX);

    expect(row.press("a", "right")).toEqual([]);
    expect(row.sizes()).toEqual([0.2, 0.09, 0.71]);

    expect(row.press("a", "left")).toEqual(dragRows("a|b", 240 + 240 + 0.5 - STEP, 340.5));
    for (let press = 0; press < 6; press += 1) {
      row.press("a", "left");
      expect(row.sizes()[0], `press ${press + 1}`).toBeGreaterThanOrEqual(BB_MIN_SIZE - 1e-9);
    }
    for (const size of row.sizes()) expect(size).toBeGreaterThanOrEqual(BB_MIN_SIZE - 1e-9);
    expect(row.press("a", "left")).toEqual([]);
  });

  // With six equal columns in a narrow row, the smallest size lies less than
  // 12 pixels from the even-split line, so bb pulls the divider straight back.
  it("sends bb nothing when bb would pull the divider back to where it is", () => {
    const row = mountLiveRow("row", Array.from({ length: 6 }, () => 1 / 6), {
      ...WORKSPACE,
      width: 701,
    });
    const before = row.sizes();

    expect(row.press("a", "left")).toEqual([]);
    expect(row.press("a", "right")).toEqual([]);
    expect(row.press("c", "left", 400)).toEqual([]);

    expect(row.sizes()).toEqual(before);
  });

  it("still moves a divider in a row of seven panes, which bb cannot keep at 15 percent each", () => {
    const row = mountLiveRow("row", Array.from({ length: 7 }, () => 1 / 7), {
      ...WORKSPACE,
      width: 1406,
    });

    expect(row.press("a", "right")).toHaveLength(3);

    const sizes = row.sizes();
    expect((sizes[0] - 1 / 7) * row.content).toBeCloseTo(STEP, 6);
    for (const size of sizes.slice(2)) expect(size).toBeCloseTo(1 / 7, SAME_SIZE_DIGITS);
    for (let press = 0; press < 6; press += 1) row.press("a", "left");
    expect(row.sizes()[0] / (2 / 7)).toBeCloseTo(MIN_PAIR_FRACTION, SAME_SIZE_DIGITS);
    expect(row.press("a", "left")).toEqual([]);
  });

  // 800 presses, each on a page of its own: a few seconds alone, and
  // several times that while the other test files run.
  it("holds for any sizes, focused pane, direction and step", { timeout: 60_000 }, () => {
    const random = seededRandom(20261119);
    const pick = <T,>(options: readonly T[]): T =>
      options[Math.floor(random() * options.length)];
    const closeToLimitPx = SNAP_CAPTURE_PX + 1.5;

    for (let round = 0; round < 40; round += 1) {
      const count = 2 + Math.floor(random() * 5);
      const weights = Array.from({ length: count }, () => 0.05 + random());
      const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
      const spare = 1 - BB_MIN_SIZE * count;
      const sizes = weights.map((weight) => BB_MIN_SIZE + (spare * weight) / weightTotal);
      const dir = pick(["row", "col"] as const);
      const span = 700 + Math.floor(random() * 900);
      const row = mountLiveRow(dir, sizes, {
        ...WORKSPACE,
        ...(dir === "row" ? { width: span } : { height: span }),
      });
      const directions: readonly Direction[] = dir === "row" ? ["left", "right"] : ["up", "down"];

      for (let press = 0; press < 20; press += 1) {
        const focusedIndex = Math.floor(random() * count);
        const direction = pick(directions);
        const stepPx = pick([32, 48, 100, 400]);
        const label = `round ${round}, press ${press}: ${direction} by ${stepPx} from pane ${focusedIndex} of ${count}`;
        const before = row.sizes();
        const sent = row.press(String.fromCharCode(97 + focusedIndex), direction, stepPx);
        const after = row.sizes();
        const dividerIndex = focusedIndex < count - 1 ? focusedIndex : focusedIndex - 1;
        const grows = direction === "right" || direction === "down";
        const shrinking = grows ? dividerIndex + 1 : dividerIndex;

        for (const size of after) expect(size, label).toBeGreaterThanOrEqual(BB_MIN_SIZE - 1e-9);
        if (sent.length === 0) {
          expect(after, label).toEqual(before);
          expect((before[shrinking] - BB_MIN_SIZE) * row.content, label).toBeLessThanOrEqual(
            closeToLimitPx,
          );
          continue;
        }
        expect(sent, label).toHaveLength(3);
        after.forEach((size, index) => {
          if (index === dividerIndex || index === dividerIndex + 1) return;
          expect(size, `${label}, pane ${index}`).toBeCloseTo(before[index], SAME_SIZE_DIGITS);
        });
        expect((before[shrinking] - after[shrinking]) * row.content, label).toBeGreaterThan(0.5);
      }
    }
  });
});

describe("resizeFocusedPane while the conversation area is hidden", () => {
  it("leaves two hidden columns as they are, where a drag would make bb even them out", () => {
    mountWorkspace({ ...SIDE_BY_SIDE, sizes: [0.3, 0.7] } as Layout, { focused: "a" });
    hideConversationArea();
    const stored = installBbDragHandler("a|b");

    expect(resize("right")).toEqual([]);
    expect(resize("left")).toEqual([]);

    expect(stored).toEqual([]);
    expect(resizeFocusedPane("right", STEP)).toBe(false);
    expect(noticeText()).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("leaves three hidden columns as they are from every pane", () => {
    for (const focused of ["a", "b", "c"]) {
      mountWorkspace(THREE_COLUMNS, { focused });
      hideConversationArea();
      const stored = [installBbDragHandler("a|b"), installBbDragHandler("b|c")];

      expect(resize("right"), focused).toEqual([]);
      expect(resize("left"), focused).toEqual([]);
      expect(stored, focused).toEqual([[], []]);
    }
  });

  it("treats a pane without height the same way", () => {
    mountWorkspace(STACKED, { focused: "a" });
    place(paneElement("a"), { ...boxOf(paneElement("a")), height: 0 });

    expect(resize("down")).toEqual([]);
    expect(resizeFocusedPane("down", STEP)).toBe(false);
  });
});

describe("what resizeFocusedPane reports back", () => {
  it("reports a divider after a drag", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });

    expect(resizeFocusedPane("right", STEP)).toBe(true);
    expect(resizeFocusedPane("left", STEP)).toBe(true);
  });

  it("reports a divider that is already as far that way as it can go", () => {
    mountWorkspace({ ...SIDE_BY_SIDE, sizes: [0.15, 0.85] } as Layout, { focused: "a" });

    expect(resizeFocusedPane("left", STEP)).toBe(true);
    expect(seen).toEqual([]);
  });

  it("reports a divider when bb's handler failed on the drag", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    throwOn("a|b", "pointerdown");

    expect(resizeFocusedPane("right", STEP)).toBe(true);
  });

  it("reports none on a page that shows no panes", () => {
    document.body.innerHTML = "<main><input /></main>";

    expect(resizeFocusedPane("right", STEP)).toBe(false);
  });

  it("reports none with a single pane", () => {
    mountSinglePane();

    expect(resizeFocusedPane("right", STEP)).toBe(false);
  });

  it("reports none while a pane is zoomed", () => {
    mountWorkspace(NESTED, { focused: "d", zoomed: "d" });

    expect(resizeFocusedPane("right", STEP)).toBe(false);
  });

  it("reports none when bb marks no pane as focused", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "none" });

    expect(resizeFocusedPane("right", STEP)).toBe(false);
  });

  it("reports none when the pane has no divider that can go that way", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });

    expect(resizeFocusedPane("up", STEP)).toBe(false);
    expect(resizeFocusedPane("down", STEP)).toBe(false);
  });

  it("reports none when the divider cannot be dragged at all", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    hitTargetOf("a|b").removeAttribute("data-split-divider-hit-target");

    expect(resizeFocusedPane("right", STEP)).toBe(false);
  });
});

describe("resizeFocusedPane where there is nothing to resize", () => {
  it("does nothing and says nothing on a page that shows no panes", () => {
    document.body.innerHTML = "<main><input /></main>";

    expect(resize("right")).toEqual([]);
    expect(noticeText()).toBeNull();
  });

  it("says that there is only one pane", () => {
    mountSinglePane();

    expect(resize("right")).toEqual([]);
    expect(noticeText()).toBe(SINGLE_PANE_NOTICE);
  });

  it("says that a pane is zoomed and leaves the hidden dividers alone", () => {
    mountWorkspace(NESTED, { focused: "d", zoomed: "d" });

    for (const direction of ["left", "down", "up", "right"] as const) {
      expect(resize(direction)).toEqual([]);
    }
    expect(noticeText()).toBe(ZOOMED_PANE_NOTICE);
  });

  it("never drags a divider that bb has hidden", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    testElement("a|b").classList.add("invisible");

    expect(resize("right")).toEqual([]);
    expect(noticeText()).toBeNull();
  });

  it("does nothing when bb marks no pane as focused", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "none" });

    expect(resize("right")).toEqual([]);
    expect(noticeText()).toBeNull();
  });
});

describe("resizeFocusedPane next to the side panel", () => {
  function placeSidePanelDividersAround(paneId: string): void {
    const pane = boxOf(paneElement(paneId));
    place(testElement("side-panel-columns"), {
      left: pane.left + pane.width,
      top: pane.top,
      width: 1,
      height: pane.height,
    });
    place(testElement("side-panel-rows"), {
      left: pane.left,
      top: pane.top + pane.height,
      width: pane.width,
      height: 1,
    });
  }

  it("ignores the side panel's own dividers even where they touch the pane", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "b" });
    placeSidePanelDividersAround("b");

    expect(resize("right")).toEqual(dragRows("a|b", 788.5, 340.5));
    expect(resize("down")).toEqual([]);
    expect(noticeText()).toBeNull();
  });

  it("ignores the handle of the right panel, which is a separator too", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "b" });
    place(testElement("panel-handle"), { left: 1241, top: 40, width: 1, height: 601 });

    expect(resize("right")).toEqual(dragRows("a|b", 788.5, 340.5));
  });

  it("does not count the side panel's panes or follow its focused pane", () => {
    mountSinglePane();
    placeSidePanelDividersAround("a");

    expect(resize("right")).toEqual([]);
    expect(resize("down")).toEqual([]);
    expect(noticeText()).toBe(SINGLE_PANE_NOTICE);
  });
});

describe("resizeFocusedPane when bb's divider does not answer", () => {
  function noticeId(): number | null {
    return getUiState().notice?.id ?? null;
  }

  it("says once that resizing did not work when a divider has no hit target", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    hitTargetOf("a|b").removeAttribute("data-split-divider-hit-target");

    expect(resize("right")).toEqual([]);
    expect(noticeText()).toBe(RESIZE_FAILED_NOTICE);
    const firstNotice = noticeId();

    expect(resize("right")).toEqual([]);
    expect(noticeId()).toBe(firstNotice);
  });

  it("contains an error from bb's handler and ends the drag it may have begun", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    throwOn("a|b", "pointerdown");

    expect(() => resizeFocusedPane("right", STEP)).not.toThrow();

    expect(seenRows()).toEqual([
      ["pointerdown", "a|b", 788.5, 340.5],
      ["pointercancel", "a|b", 788.5, 340.5],
    ]);
    expect(seen.map((event) => event.isOwn)).toEqual([true, true]);
    expect(seen[1]).toMatchObject({ pointerId: 1, buttons: 0 });
  });

  it("says so on the next frame when the pane is still the size it was", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    throwOn("a|b", "pointerdown");

    resize("right");
    expect(noticeText()).toBeNull();
    runFrame();

    expect(noticeText()).toBe(RESIZE_FAILED_NOTICE);
  });

  it("says it only once for as long as the page is loaded", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    throwOn("a|b", "pointerdown");
    resize("right");
    runFrame();
    const firstNotice = noticeId();

    resize("right");
    runFrame();
    hitTargetOf("a|b").removeAttribute("data-split-divider-hit-target");
    resize("right");
    runFrame();

    expect(noticeId()).toBe(firstNotice);
  });

  it("says nothing when the pane was resized in spite of the error", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    throwOn("a|b", "pointerup");
    const pane = paneElement("a");

    resize("right");
    place(pane, { ...boxOf(pane), width: 548 });
    runFrame();

    expect(noticeText()).toBeNull();
  });

  it("drags as pointer 0 in a browser that has the mouse as pointer 0, as Firefox does, and goes on with that pointer", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    const stored = installBbDragHandler("a|b", 0);

    resize("right");
    runFrame();

    expect(seen.map((event) => `${event.type} ${event.pointerId}`)).toEqual([
      "pointerdown 1",
      "pointercancel 1",
      "pointerdown 0",
      "pointermove 0",
      "pointerup 0",
    ]);
    expect(stored).toHaveLength(1);
    expect(noticeText()).toBeNull();

    seen.length = 0;
    resize("right");

    expect(seen.map((event) => `${event.type} ${event.pointerId}`)).toEqual([
      "pointerdown 0",
      "pointermove 0",
      "pointerup 0",
    ]);
    expect(stored).toHaveLength(2);
  });

  it("starts with pointer 1 again after a reset, as on a page that was loaded anew", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    installBbDragHandler("a|b", 0);
    resize("right");
    resetPaneResize();
    seen.length = 0;

    resize("right");

    expect(seen[0]).toMatchObject({ type: "pointerdown", pointerId: 1 });
  });

  it("says that resizing did not work when the browser takes neither pointer for the mouse", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    const stored = installBbDragHandler("a|b", 7);

    resize("right");
    runFrame();

    expect(seen.map((event) => `${event.type} ${event.pointerId}`)).toEqual([
      "pointerdown 1",
      "pointercancel 1",
      "pointerdown 0",
      "pointercancel 0",
    ]);
    expect(stored).toEqual([]);
    expect(noticeText()).toBe(RESIZE_FAILED_NOTICE);
  });

  it("cancels the drag when bb's handler fails on the move, and does not release", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    const stored = installBbDragHandler("a|b");
    throwOn("a|b", "pointermove");

    resize("right");
    runFrame();

    expect(seen.map((event) => event.type)).toEqual([
      "pointerdown",
      "pointermove",
      "pointercancel",
    ]);
    expect(stored).toEqual([]);
    expect(testElement("a|b").hasAttribute("data-dragging")).toBe(false);
    expect(noticeText()).toBe(RESIZE_FAILED_NOTICE);
  });

  it("sends bb nothing and says nothing when the pane is at its smallest size", () => {
    mountWorkspace({ ...SIDE_BY_SIDE, sizes: [0.15, 0.85] } as Layout, { focused: "a" });
    const stored = installBbDragHandler("a|b");

    expect(resize("left")).toEqual([]);
    runFrame();

    expect(stored).toEqual([]);
    expect(frames.size).toBe(0);
    expect(noticeText()).toBeNull();
  });

  it("still moves that pane the other way", () => {
    mountWorkspace({ ...SIDE_BY_SIDE, sizes: [0.15, 0.85] } as Layout, { focused: "a" });
    const stored = installBbDragHandler("a|b");

    resize("right");

    expect(stored[0]).toBeCloseTo(0.198, 6);
  });

  it("drops the check when the pending work is cancelled or another resize follows", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    throwOn("a|b", "pointerdown");

    resize("right");
    expect(frames.size).toBe(1);
    cancelPendingResizeCheck();
    expect(frames.size).toBe(0);

    resize("right");
    resize("up");
    expect(frames.size).toBe(0);
    runFrame();
    expect(noticeText()).toBeNull();
  });

  it("says that resizing did not work where the browser has no pointer events", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    vi.stubGlobal("PointerEvent", undefined);

    expect(() => resizeFocusedPane("right", STEP)).not.toThrow();

    expect(noticeText()).toBe(RESIZE_FAILED_NOTICE);
  });

  it("says so, and drags nothing, when the divider is not inside a row or column of bb", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    for (const grid of document.querySelectorAll("[data-split-resize-grid-root]")) {
      grid.removeAttribute("data-split-resize-grid-root");
    }

    expect(resize("right")).toEqual([]);
    expect(noticeText()).toBe(RESIZE_FAILED_NOTICE);
  });

  it("says so when the divider does not say how many panes its row has", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    testElement("a|b").setAttribute("data-split-resize-grid-count", "");

    expect(resize("right")).toEqual([]);
    expect(noticeText()).toBe(RESIZE_FAILED_NOTICE);
  });

  it("says so when the divider has no pane on one of its sides", () => {
    mountWorkspace(SIDE_BY_SIDE, { focused: "a" });
    const paneAfterDivider = testElement("a|b").nextElementSibling;
    if (paneAfterDivider === null) throw new Error("the divider has no pane after it");
    testElement("main-area").append(paneAfterDivider);

    expect(resize("right")).toEqual([]);
    expect(noticeText()).toBe(RESIZE_FAILED_NOTICE);
  });

  it("uses the pane sizes alone when the divider does not say where it is in its row", () => {
    mountWorkspace({ ...SIDE_BY_SIDE, sizes: [0.54, 0.46] } as Layout, { focused: "a" });
    testElement("a|b").setAttribute("data-split-resize-grid-boundary", "");

    expect(resize("left")).toEqual(dragRows("a|b", 732.5, 340.5));
    expect(noticeText()).toBeNull();
  });
});
