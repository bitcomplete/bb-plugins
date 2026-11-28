import type { PluginSidebarSplitLayout } from "@get-bb/plugin-sdk/app";
import { MAX_PANES } from "./constants";
import type { SplitPane } from "./types";

// isShowing is false while the pane shows no thread, as on the New thread
// screen. current is then the thread it showed last.
interface ShownThreads {
  current: string;
  previous: string | null;
  isShowing: boolean;
}

// The records of the panes of a split that has just ended: byThread holds
// those of the panes that showed a thread, by that thread, and idle those of
// the panes that showed none, as the New thread screen does. threadless is
// how many panes showed none, with a record or without, and
// hadThreadlessFocus whether one of them had the focus.
interface EndedSplit {
  byThread: ReadonlyMap<string, ShownThreads>;
  idle: readonly ShownThreads[];
  threadless: number;
  hadThreadlessFocus: boolean;
  until: number;
}

// The pane that bb gave the focus to by itself when another pane was closed,
// while this plugin moves the focus on to the pane that had it before.
interface PassingFocus {
  paneId: string;
  until: number;
}

// Stands for the only pane of a window that is not split.
const SINGLE_PANE = "";
// When a split ends, bb drops the layout at once and names the thread of the
// pane that stays a moment later. Until then the context can still name the
// thread of the pane that was closed.
const SPLIT_END_SETTLE_MS = 1000;
// A pane move of this plugin waits for bb for a second at most (pane-focus.ts).
// A pane that still has the focus after that keeps it, so its focus counts.
const PASSING_FOCUS_MS = 1500;

// The panes that had the focus, the latest first.
let focusOrder: readonly string[] = [];
const shownThreads = new Map<string, ShownThreads>();
// The thread that this plugin opened a new pane with, only to put the New
// thread screen in its place, by pane. The pane did not show it to the user.
// That ends once the pane shows the New thread screen, or another thread: a
// pane that shows the thread after that does so because the user opened it.
const standIns = new Map<string, string>();
let isSplit = false;
let threadlessPanes = 0;
let isThreadlessFocused = false;
let endedSplit: EndedSplit | null = null;
let passingFocus: PassingFocus | null = null;

function withoutStandIn(paneKey: string, threadId: string | null): string | null {
  if (threadId !== null && standIns.get(paneKey) === threadId) return null;
  standIns.delete(paneKey);
  return threadId;
}

function noteThread(paneKey: string, shownId: string | null): void {
  const threadId = withoutStandIn(paneKey, shownId);
  const shown = shownThreads.get(paneKey);
  if (threadId === null || threadId === shown?.current) {
    if (shown === undefined) return;
    shownThreads.set(paneKey, { ...shown, isShowing: threadId !== null });
    return;
  }
  shownThreads.set(paneKey, {
    current: threadId,
    previous: shown?.current ?? null,
    isShowing: true,
  });
}

// A pane that holds the thread it was opened with only to become the New
// thread screen shows none to the user.
function showsThread({ paneId, threadId }: SplitPane): boolean {
  return threadId !== null && standIns.get(paneId) !== threadId;
}

function forgetClosedPanes(panes: readonly SplitPane[]): void {
  for (const paneKey of [...shownThreads.keys()]) {
    const isOpen = panes.some((pane) => pane.paneId === paneKey);
    if (paneKey !== SINGLE_PANE && !isOpen) shownThreads.delete(paneKey);
  }
  for (const paneKey of [...standIns.keys()]) {
    if (!panes.some((pane) => pane.paneId === paneKey)) standIns.delete(paneKey);
  }
}

// The pane that the window had before the split is one of its panes now, so
// what it showed before goes with it: to the pane that shows its thread, or,
// when it showed none, to the one pane that shows none.
function startSplit(panes: readonly SplitPane[]): void {
  isSplit = true;
  endedSplit = null;
  const single = shownThreads.get(SINGLE_PANE);
  if (single === undefined) return;
  const threadId = single.isShowing ? single.current : null;
  const sameContent = panes.filter((pane) => pane.threadId === threadId);
  if (sameContent.length === 1) shownThreads.set(sameContent[0].paneId, single);
}

// bb gives the next new pane the id of a pane that was closed, so no record
// of a pane outlives the split. The record of the window without a split is
// from before the split and goes as well: the pane that stays brings its own.
function endSplit(now: number): void {
  isSplit = false;
  const byThread = new Map<string, ShownThreads>();
  const idle: ShownThreads[] = [];
  for (const [paneKey, shown] of shownThreads) {
    if (paneKey === SINGLE_PANE) continue;
    if (shown.isShowing) byThread.set(shown.current, shown);
    else idle.push(shown);
  }
  shownThreads.clear();
  standIns.clear();
  endedSplit = {
    byThread,
    idle,
    threadless: threadlessPanes,
    hadThreadlessFocus: isThreadlessFocused,
    until: now + SPLIT_END_SETTLE_MS,
  };
}

// bb never shows one thread in two panes, so the thread tells which pane
// stays. A pane that stays without a thread is the one that showed none, when
// there was one such pane only.
function stayingRecord(
  ended: EndedSplit,
  threadId: string | null,
): ShownThreads | undefined {
  if (threadId !== null) return ended.byThread.get(threadId);
  return ended.idle.length === 1 ? ended.idle[0] : undefined;
}

// Whether the pane that stays without a thread is one that has shown no
// thread at all: the one pane of the split that showed none, with no record.
// Not when that pane had the focus: it is then the one that was closed. bb
// closes a pane without a thread by its close command, which takes the
// focused pane, or by the close button of the pane, and a press on a pane
// gives it the focus first (SplitThreadArea.tsx in bb 0.50.1). The pane that
// stays brought its record, and shows no thread because the user went on to
// the New thread screen.
function staysWithoutRecord(ended: EndedSplit, threadId: string | null): boolean {
  if (threadId !== null || ended.hadThreadlessFocus) return false;
  return ended.threadless === 1 && ended.idle.length === 0;
}

// The pane that stays after a split is the only pane of the window from then
// on, so what it showed before stays with it. A pane that has shown nothing
// before brings no record: the one that was taken while the context still
// named the thread of the closed pane is that pane's and goes.
function noteSinglePane(threadId: string | null, now: number): void {
  const ended = endedSplit !== null && now <= endedSplit.until ? endedSplit : null;
  const staying = ended === null ? undefined : stayingRecord(ended, threadId);
  if (staying !== undefined) {
    shownThreads.set(SINGLE_PANE, staying);
    return;
  }
  if (ended !== null && staysWithoutRecord(ended, threadId)) {
    shownThreads.delete(SINGLE_PANE);
    return;
  }
  const isNewThread =
    threadId !== null && threadId !== shownThreads.get(SINGLE_PANE)?.current;
  if (ended === null || isNewThread) endedSplit = null;
  noteThread(SINGLE_PANE, threadId);
}

// The focus of that pane does not count while it lasts, up to the time limit.
function isPassingFocus(paneId: string, now: number): boolean {
  if (passingFocus === null) return false;
  if (paneId === passingFocus.paneId && now <= passingFocus.until) return true;
  passingFocus = null;
  return false;
}

// Remembers which panes had the focus before the one that has it now, and
// which thread each pane showed before what it shows now. bb does not keep
// either, and tmux's last-pane and last-window need them.
export function noteLayout(
  layout: PluginSidebarSplitLayout | null,
  contextThreadId: string | null,
  now: number = Date.now(),
): void {
  if (layout === null) {
    if (isSplit) endSplit(now);
    noteSinglePane(contextThreadId, now);
    return;
  }
  forgetClosedPanes(layout.panes);
  if (!isSplit) startSplit(layout.panes);
  for (const pane of layout.panes) noteThread(pane.paneId, pane.threadId);
  const threadless = layout.panes.filter((pane) => !showsThread(pane));
  threadlessPanes = threadless.length;
  isThreadlessFocused = threadless.some((pane) => pane.isFocused);
  const paneId = layout.panes.find((pane) => pane.isFocused)?.paneId ?? null;
  if (paneId === null || isPassingFocus(paneId, now)) return;
  if (paneId === focusOrder[0]) return;
  const others = focusOrder.filter((id) => id !== paneId);
  focusOrder = [paneId, ...others].slice(0, MAX_PANES);
}

// The pane that had the focus last among those that do not have it now. A
// pane that was closed since is passed over.
export function findLastFocusedPane(
  panes: readonly SplitPane[],
): SplitPane | null {
  for (const paneId of focusOrder) {
    const pane = panes.find((candidate) => candidate.paneId === paneId);
    if (pane !== undefined && !pane.isFocused) return pane;
  }
  return null;
}

// For a new pane that this plugin opened with a thread only to put the New
// thread screen in its place: the pane has not shown that thread.
export function forgetStandIn(paneId: string, threadId: string): void {
  standIns.set(paneId, threadId);
  if (shownThreads.get(paneId)?.current === threadId) shownThreads.delete(paneId);
}

export function getFocusOrder(): readonly string[] {
  return focusOrder;
}

// For the close of a pane, after which bb gives the focus to a pane of its
// own choice and this plugin moves it on to the pane that had it before. As
// in tmux (window_lost_pane in window.c), no pane counts as one that had the
// focus in between: the order is the one from before the close again, and
// the focus of the pane that bb chose does not count while it lasts.
export function passFocusOn(
  paneId: string,
  orderBefore: readonly string[],
  now: number = Date.now(),
): void {
  focusOrder = orderBefore;
  passingFocus = { paneId, until: now + PASSING_FOCUS_MS };
}

// The thread that the pane showed before what it shows now. paneId is null
// for a window that is not split.
export function getLastShownThreadId(paneId: string | null): string | null {
  const shown = shownThreads.get(paneId ?? SINGLE_PANE);
  if (shown === undefined) return null;
  return shown.isShowing ? shown.previous : shown.current;
}

export function resetHistory(): void {
  focusOrder = [];
  shownThreads.clear();
  standIns.clear();
  isSplit = false;
  threadlessPanes = 0;
  isThreadlessFocused = false;
  endedSplit = null;
  passingFocus = null;
}
