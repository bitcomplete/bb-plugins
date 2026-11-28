import type { Direction, SplitPane } from "./types";

const EPSILON = 1e-9;

interface AxisSpan {
  start: number;
  size: number;
  crossStart: number;
  crossSize: number;
}

// gap: how far the pane lies from the focused pane in the direction of the
// move. offset: how far its centre is from the centre of the focused pane on
// the other axis.
interface Candidate {
  pane: SplitPane;
  gap: number;
  offset: number;
}

function axisSpan(rect: SplitPane["rect"], horizontal: boolean): AxisSpan {
  if (horizontal) {
    return {
      start: rect.x,
      size: rect.width,
      crossStart: rect.y,
      crossSize: rect.height,
    };
  }
  return {
    start: rect.y,
    size: rect.height,
    crossStart: rect.x,
    crossSize: rect.width,
  };
}

function isHorizontal(direction: Direction): boolean {
  return direction === "left" || direction === "right";
}

function isForward(direction: Direction): boolean {
  return direction === "right" || direction === "down";
}

function crossOverlap(origin: AxisSpan, candidate: AxisSpan): number {
  return (
    Math.min(
      origin.crossStart + origin.crossSize,
      candidate.crossStart + candidate.crossSize,
    ) - Math.max(origin.crossStart, candidate.crossStart)
  );
}

function crossOffset(origin: AxisSpan, candidate: AxisSpan): number {
  return Math.abs(
    candidate.crossStart +
      candidate.crossSize / 2 -
      origin.crossStart -
      origin.crossSize / 2,
  );
}

function focusRank(focusOrder: readonly string[], pane: SplitPane): number {
  const rank = focusOrder.indexOf(pane.paneId);
  return rank === -1 ? Infinity : rank;
}

// As tmux does (window_pane_choose_best in window.c): of the panes that are
// equally near, the one that had the focus last. Without such a pane, the one
// whose centre is closest, then the first pane in layout order.
function chooseBest(
  candidates: readonly Candidate[],
  focusOrder: readonly string[],
): SplitPane | null {
  const nearestGap = Math.min(...candidates.map(({ gap }) => gap));
  let best: Candidate | null = null;
  let bestRank = Infinity;
  for (const candidate of candidates) {
    if (candidate.gap > nearestGap + EPSILON) continue;
    const rank = focusRank(focusOrder, candidate.pane);
    const isBetter =
      best === null ||
      rank < bestRank ||
      (rank === bestRank && candidate.offset < best.offset);
    if (!isBetter) continue;
    best = candidate;
    bestRank = rank;
  }
  return best?.pane ?? null;
}

// The nearest pane that lies fully on that side and overlaps the focused pane
// on the other axis. focusOrder holds the panes that had the focus, the latest
// first.
export function findDirectionalPane(
  panes: readonly SplitPane[],
  focusedPaneId: string,
  direction: Direction,
  focusOrder: readonly string[] = [],
): SplitPane | null {
  const focused = panes.find((pane) => pane.paneId === focusedPaneId);
  if (focused === undefined) return null;
  const horizontal = isHorizontal(direction);
  const origin = axisSpan(focused.rect, horizontal);
  const candidates: Candidate[] = [];
  for (const pane of panes) {
    if (pane.paneId === focusedPaneId) continue;
    const span = axisSpan(pane.rect, horizontal);
    const gap = isForward(direction)
      ? span.start - origin.start - origin.size
      : origin.start - span.start - span.size;
    if (gap < -EPSILON || crossOverlap(origin, span) <= EPSILON) continue;
    candidates.push({ pane, gap, offset: crossOffset(origin, span) });
  }
  return chooseBest(candidates, focusOrder);
}

// The rectangle that the panes fill together.
function windowRect(panes: readonly SplitPane[]): SplitPane["rect"] {
  const x = Math.min(...panes.map(({ rect }) => rect.x));
  const y = Math.min(...panes.map(({ rect }) => rect.y));
  const right = Math.max(...panes.map(({ rect }) => rect.x + rect.width));
  const bottom = Math.max(...panes.map(({ rect }) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

// A pane other than the focused one at the edge of the window that a move in
// that direction goes around to, and that overlaps a rectangle on the other
// axis.
function findPaneAtOppositeEdge(
  panes: readonly SplitPane[],
  focusedPaneId: string,
  from: SplitPane["rect"],
  direction: Direction,
  focusOrder: readonly string[],
): SplitPane | null {
  const horizontal = isHorizontal(direction);
  const forward = isForward(direction);
  const origin = axisSpan(from, horizontal);
  const spans = panes.map((pane) => axisSpan(pane.rect, horizontal));
  const windowStart = Math.min(...spans.map((span) => span.start));
  const windowEnd = Math.max(...spans.map((span) => span.start + span.size));
  const candidates: Candidate[] = [];
  panes.forEach((pane, at) => {
    if (pane.paneId === focusedPaneId) return;
    const span = spans[at];
    const gap = forward
      ? span.start - windowStart
      : windowEnd - span.start - span.size;
    if (gap > EPSILON || crossOverlap(origin, span) <= EPSILON) return;
    candidates.push({ pane, gap, offset: crossOffset(origin, span) });
  });
  return chooseBest(candidates, focusOrder);
}

// Where a move from the edge of the window ends in tmux (the window_pane_find
// functions in window.c): on a pane at the opposite edge of the window that
// overlaps the focused pane on the other axis.
export function findPaneAcrossWindow(
  panes: readonly SplitPane[],
  focusedPaneId: string,
  direction: Direction,
  focusOrder: readonly string[] = [],
): SplitPane | null {
  const focused = panes.find((pane) => pane.paneId === focusedPaneId);
  if (focused === undefined) return null;
  return findPaneAtOppositeEdge(panes, focusedPaneId, focused.rect, direction, focusOrder);
}

// The pane that those functions of tmux find from a zoomed pane. tmux gives
// the zoomed pane the whole window and leaves the others where they were
// (window_zoom in window.c, layout_fix_panes in layout.c), so the zoomed pane
// is at every edge of the window: the search goes around on each side, and
// every pane at the opposite edge overlaps the zoomed one.
export function findPaneFromZoomedPane(
  panes: readonly SplitPane[],
  focusedPaneId: string,
  direction: Direction,
  focusOrder: readonly string[] = [],
): SplitPane | null {
  if (!panes.some((pane) => pane.paneId === focusedPaneId)) return null;
  return findPaneAtOppositeEdge(
    panes,
    focusedPaneId,
    windowRect(panes),
    direction,
    focusOrder,
  );
}

// The pane after the focused one in the order bb lists the panes in, or the
// one before it for a step of -1. That order follows the splits, as the pane
// list of tmux does: a new pane comes right after the pane it was split from.
// The pane after the last one is the first one, and the pane before the first
// one is the last.
export function findNextPane(
  panes: readonly SplitPane[],
  focusedPaneId: string,
  step: 1 | -1 = 1,
): SplitPane | null {
  const index = panes.findIndex((pane) => pane.paneId === focusedPaneId);
  if (index === -1) return null;
  return panes[(index + step + panes.length) % panes.length];
}
