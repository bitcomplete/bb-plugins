import { runCoreCommand } from "./bb-commands";
import { getBridge, getSettings, showNotice, updateUiState } from "./bridge";
import { BB_COMMANDS, PLUGIN_ID } from "./constants";
import {
  beginCopySelection,
  clearCopySelection,
  enterCopyMode,
  exitCopyMode,
  isCopyModeActive,
  moveCopyCursor,
  scrollCopyView,
  yankCopySelection,
} from "./copy-mode";
import {
  cancelPendingSidebarFocus,
  clickClosePane,
  clickMaximizePane,
  focusPaneElement,
  focusSidebarEdge,
  focusSidebarRowForThread,
  getFocusedPaneElement,
  getFocusedSidebarRow,
  getThreadPaneElements,
  isPaneZoomed,
  isSidebarOpen,
  moveSidebarFocus,
  pageSidebarFocus,
  sidebarRowThreadId,
  toggleSidebar,
} from "./dom-actions";
import { classifyFocus } from "./focus-context";
import {
  findDirectionalPane,
  findNextPane,
  findPaneAcrossWindow,
  findPaneFromZoomedPane,
} from "./geometry";
import {
  findLastFocusedPane,
  getFocusOrder,
  getLastShownThreadId,
  passFocusOn,
} from "./history";
import {
  ONE_NEW_THREAD_SCREEN_NOTICE,
  cancelPendingNewThread,
  hasNewThreadScreenInAnotherPane,
  interruptPendingNewThread,
} from "./new-thread";
import { BRIDGE_MISSING_NOTICE, openThread } from "./open-thread";
import { cancelPendingResizeCheck, resizeFocusedPane } from "./pane-resize";
import {
  cancelPendingFocus,
  focusPane,
  getFocusedPane,
  getFocusedThreadId,
  settleDomFocus,
  settleDomFocusWhen,
  settleIdleDomFocus,
} from "./pane-focus";
import {
  cycleThread,
  lastThread,
  nthThread,
  readSidebarThreadOrder,
  resolveThreadOrder,
} from "./thread-order";
import type {
  Action,
  AfterCopy,
  Bridge,
  ConfigReload,
  CopyMotion,
  Direction,
  Placement,
  SplitPane,
} from "./types";

const SIDEBAR_OPEN_TIMEOUT_MS = 1000;
const SIDEBAR_FOCUS_FAILED_NOTICE = "Could not move to a thread in the sidebar.";
const NO_LAST_PANE_NOTICE = "No other pane has had the focus yet.";
const NO_LAST_THREAD_NOTICE = "This pane has not shown another thread yet.";
const CONFIG_RELOAD_NOTICES: Record<ConfigReload, string> = {
  read: "The tmux config was read again.",
  incomplete:
    "The tmux config could not be read in full. The key help says what is missing.",
  failed: "The tmux config could not be read again. The keys stay as they were.",
};

type ResizeAction = Extract<Action, { type: "pane.resize" }>;
type MoveWithError = Extract<
  Action,
  {
    type:
      | "pane.neighbour"
      | "pane.last"
      | "thread.jump"
      | "thread.end"
      | "thread.cycle"
      | "thread.last";
  }
>;

const MOVES_WITH_ERROR: ReadonlySet<Action["type"]> = new Set([
  "pane.neighbour",
  "pane.last",
  "thread.jump",
  "thread.end",
  "thread.cycle",
  "thread.last",
]);

function isMoveWithError(action: Action): action is MoveWithError {
  return MOVES_WITH_ERROR.has(action.type);
}

let sidebarEntryFrame: number | null = null;

function cancelSidebarEntry(): void {
  if (sidebarEntryFrame === null) return;
  cancelAnimationFrame(sidebarEntryFrame);
  sidebarEntryFrame = null;
}

function cancelPendingMoves(): void {
  cancelSidebarEntry();
  cancelPendingSidebarFocus();
  cancelPendingFocus();
  cancelPendingResizeCheck();
}

export function cancelPendingActions(): void {
  cancelPendingMoves();
  cancelPendingNewThread();
}

export function cancelPendingActionsOnPointerPress(): void {
  cancelPendingMoves();
  interruptPendingNewThread();
}

function requireBridge(): Bridge | null {
  const bridge = getBridge();
  if (bridge === null) showNotice(BRIDGE_MISSING_NOTICE);
  return bridge;
}

function toggleSidebarByAnyMeans(): boolean {
  if (toggleSidebar()) return true;
  return runCoreCommand(BB_COMMANDS.sidebarToggle) === "ran";
}

function focusSidebarRowOfFocusedThread(): boolean {
  return focusSidebarRowForThread(getFocusedThreadId());
}

function enterSidebar(): void {
  cancelPendingFocus();
  if (isSidebarOpen()) {
    if (!focusSidebarRowOfFocusedThread()) showNotice(SIDEBAR_FOCUS_FAILED_NOTICE);
    return;
  }
  if (!toggleSidebarByAnyMeans()) {
    showNotice("Could not open the sidebar.");
    return;
  }
  const deadline = Date.now() + SIDEBAR_OPEN_TIMEOUT_MS;
  const poll = () => {
    sidebarEntryFrame = null;
    if (isSidebarOpen() && focusSidebarRowOfFocusedThread()) return;
    if (Date.now() >= deadline) {
      showNotice(SIDEBAR_FOCUS_FAILED_NOTICE);
      return;
    }
    sidebarEntryFrame = requestAnimationFrame(poll);
  };
  sidebarEntryFrame = requestAnimationFrame(poll);
}

// bb keeps the split layout while Settings or a plugin page fills the window,
// so the layout alone does not say that there are panes to move between. As
// in tmux, a search that goes around starts again at the other side of the
// window when it finds no pane up to the edge.
function findPaneOnSide(
  bridge: Bridge,
  direction: Direction,
  goesAround: boolean,
): SplitPane | null {
  const focused = getFocusedPane();
  if (bridge.layout === null || focused === null) return null;
  if (getThreadPaneElements().length === 0) return null;
  const { panes } = bridge.layout;
  const order = getFocusOrder();
  const neighbour = findDirectionalPane(panes, focused.paneId, direction, order);
  if (neighbour !== null || !goesAround) return neighbour;
  return findPaneAcrossWindow(panes, focused.paneId, direction, order);
}

// A pane move drops what the plugin still waits to do with the focus. The
// wait for a new thread pane goes on, as it does over every other key: only a
// mouse press of the user ends that one.
function moveToPane(pane: SplitPane): void {
  cancelPendingMoves();
  focusPane(pane);
}

// A move to the left does not go around: from the leftmost pane it goes to
// the sidebar.
function focusPaneInDirection(direction: Direction): void {
  if (direction === "right" && getFocusedSidebarRow() !== null) {
    settleDomFocus();
    return;
  }
  const bridge = requireBridge();
  if (bridge === null) return;
  const neighbour = findPaneOnSide(bridge, direction, direction !== "left");
  if (neighbour !== null) {
    moveToPane(neighbour);
    return;
  }
  if (direction === "left") enterSidebar();
}

// The pane that a target such as {left-of} names in tmux, which looks for it
// as select-pane -L does (cmd_find_get_pane_with_window in cmd-find.c with
// window_pane_find_left in window.c), around the edge of the window on every
// side. select-pane -L removes a zoom before it looks, and a target is
// looked up before that: from a zoomed pane, which fills the window in tmux.
// bb's layout is the same with and without a zoom.
function findTargetPane(bridge: Bridge, direction: Direction): SplitPane | null {
  if (!isPaneZoomed()) return findPaneOnSide(bridge, direction, true);
  const focused = getFocusedPane();
  if (bridge.layout === null || focused === null) return null;
  const { panes } = bridge.layout;
  return findPaneFromZoomedPane(panes, focused.paneId, direction, getFocusOrder());
}

// False when there is no such pane, as with a single pane, which is an error
// in tmux.
function focusNeighbourPane(direction: Direction): boolean {
  const bridge = requireBridge();
  if (bridge === null) return false;
  const neighbour = findTargetPane(bridge, direction);
  if (neighbour === null) return false;
  moveToPane(neighbour);
  return true;
}

function findNextPaneInLayout(bridge: Bridge, step: 1 | -1): SplitPane | null {
  const focused = getFocusedPane();
  if (bridge.layout === null || focused === null) return null;
  return findNextPane(bridge.layout.panes, focused.paneId, step);
}

// A single pane is its own next pane, so the cursor goes back into its
// message box.
function focusNextPane(step: 1 | -1): void {
  const bridge = requireBridge();
  if (bridge === null || getThreadPaneElements().length === 0) return;
  const next = findNextPaneInLayout(bridge, step);
  if (next === null || next.isFocused) {
    settleDomFocus();
    return;
  }
  moveToPane(next);
}

// As in tmux (cmd-select-pane.c): when no pane is known to have had the focus
// before, as right after the first split, the other one of two panes is it.
function findLastPane(panes: readonly SplitPane[]): SplitPane | null {
  const last = findLastFocusedPane(panes);
  if (last !== null || panes.length !== 2) return last;
  const others = panes.filter((pane) => !pane.isFocused);
  return others.length === 1 ? others[0] : null;
}

// False when there is no such pane, which is an error in tmux.
function focusLastPane(): boolean {
  const bridge = requireBridge();
  if (bridge === null || getThreadPaneElements().length === 0) return false;
  const last = findLastPane(bridge.layout?.panes ?? []);
  if (last === null) {
    showNotice(NO_LAST_PANE_NOTICE);
    return false;
  }
  moveToPane(last);
  return true;
}

// A page without panes, such as Settings, has no message box to go to, so
// the cursor stays where it is.
function focusMessageBox(): void {
  if (getThreadPaneElements().length === 0) return;
  settleDomFocus();
}

function paneIdsKey(panes: readonly SplitPane[]): string {
  return panes.map((pane) => pane.paneId).join("\n");
}

// bb gives the focus to the pane that takes the place of the closed one. As
// in tmux (window_lost_pane in window.c), the pane that had the focus before
// the closed one gets it, when there is one, and the pane that bb chose does
// not count as one that had the focus.
function focusAfterClose(
  lastFocusedId: string | null,
  orderBefore: readonly string[],
): void {
  const panes = getBridge()?.layout?.panes ?? [];
  const last = panes.find((pane) => pane.paneId === lastFocusedId);
  if (last === undefined || last.isFocused) {
    settleDomFocus();
    return;
  }
  const chosenByBb = panes.find((pane) => pane.isFocused);
  if (chosenByBb !== undefined) passFocusOn(chosenByBb.paneId, orderBefore);
  moveToPane(last);
}

// When the second of two panes is closed, bb drops the split layout at once
// and changes the route a moment later. With a single pane the focused thread
// is read from the route, so the settle waits until the route names the
// thread of the pane that stays.
function closeFocusedPane(): void {
  const bridge = requireBridge();
  if (bridge === null || bridge.layout === null) return;
  const { panes } = bridge.layout;
  const before = paneIdsKey(panes);
  const staying =
    panes.length === 2 ? panes.find((pane) => !pane.isFocused) : undefined;
  const lastFocusedId = findLastFocusedPane(panes)?.paneId ?? null;
  const orderBefore = getFocusOrder();
  if (!clickClosePane() && runCoreCommand(BB_COMMANDS.paneClose) !== "ran") {
    showNotice("Could not close this pane.");
    return;
  }
  settleDomFocusWhen(
    () => {
      const layout = getBridge()?.layout ?? null;
      if (layout !== null) return paneIdsKey(layout.panes) !== before;
      return staying === undefined || getFocusedThreadId() === staying.threadId;
    },
    undefined,
    () => focusAfterClose(lastFocusedId, orderBefore),
  );
}

function reportFailure(label: string, error: unknown): void {
  console.error(`[${PLUGIN_ID}] ${label} failed`, error);
  showNotice("That key did not work. See the console for details.");
}

function zoomFocusedPane(): void {
  const bridge = requireBridge();
  if (bridge === null || bridge.layout === null) return;
  if (runCoreCommand(BB_COMMANDS.paneMaximizeToggle) === "ran") return;
  if (clickMaximizePane()) return;
  const threadId = getFocusedThreadId();
  // paneAction reaches every bb window, so it is only for a pane that this
  // window shows; without one it would zoom the other windows and not this one.
  if (threadId === null || getFocusedPaneElement() === null) {
    showNotice("Could not zoom this pane.");
    return;
  }
  bridge.sdk.threads
    .paneAction({ threadId, action: "toggle" })
    .catch((error: unknown) => reportFailure("pane.zoom", error));
}

function startNewThread(): void {
  const bridge = requireBridge();
  if (bridge === null) return;
  const isScreenInAnotherPane = hasNewThreadScreenInAnotherPane(bridge);
  cancelPendingFocus();
  bridge.navigate.toCompose({ focusPrompt: true });
  if (isScreenInAnotherPane) showNotice(ONE_NEW_THREAD_SCREEN_NOTICE);
}

// False when there is no thread to go to, which is an error in tmux: no such
// window, or no other window to go to.
function goToThread(pick: (order: readonly string[]) => string | null): boolean {
  const bridge = requireBridge();
  if (bridge === null) return false;
  const { order } = resolveThreadOrder({
    mode: bridge.settings.threadOrder,
    domOrder: readSidebarThreadOrder(),
    threads: bridge.threads,
  });
  const threadId = pick(order);
  if (threadId === null) return false;
  openThread(threadId, "replace");
  return true;
}

// A thread that was archived or deleted since is no window to go back to, as
// a killed window is none in tmux. Once bb has loaded its threads it lists
// every thread that is neither.
function isThreadGone(bridge: Bridge, threadId: string): boolean {
  if (!bridge.threadsReady) return false;
  return !bridge.threads.some(
    (thread) => thread.id === threadId && !thread.isArchived,
  );
}

// False when the pane has no such thread, which is an error in tmux.
function goToLastThread(): boolean {
  const bridge = requireBridge();
  if (bridge === null) return false;
  const paneId = bridge.layout === null ? null : getFocusedPane()?.paneId;
  const threadId =
    paneId === undefined ? null : getLastShownThreadId(paneId);
  if (threadId === null || isThreadGone(bridge, threadId)) {
    showNotice(NO_LAST_THREAD_NOTICE);
    return false;
  }
  openThread(threadId, "replace");
  return true;
}

function openFocusedSidebarRow(placement: Placement): void {
  const threadId = sidebarRowThreadId(getFocusedSidebarRow());
  if (threadId === null) return;
  openThread(threadId, placement);
}

// The prefix also works in the message box, the terminal and the sidebar,
// where the next key would be typed and end copy mode, and on a button or a
// link, which Space and Enter would press. So focus goes to the pane. A pane
// move that has not settled yet would take it into the message box again, so
// that is dropped.
function enterCopyModeFromKey(motion: CopyMotion | null): void {
  if (!enterCopyMode()) {
    showNotice("There is no conversation text to select here");
    return;
  }
  cancelPendingFocus();
  if (classifyFocus(document.activeElement) !== "normal") {
    focusPaneElement(getFocusedPaneElement());
  }
  if (motion !== null) moveCopyCursor(motion);
}

// The copy ends copy mode a moment after the key, so the cursor goes back
// into the message box from here and not from the key handler. Only a key
// that is meant to leave copy mode does that: after one that stays and finds
// the selection lost, the keys that follow are still meant for copy mode.
function yankFromKey(after: AfterCopy): void {
  if (!isCopyModeActive()) return;
  yankCopySelection(after)
    .then(() => {
      if (after === "exit" && !isCopyModeActive()) settleIdleDomFocus();
    })
    .catch((error: unknown) => reportFailure("copy.yank", error));
}

function reloadTmuxConfig(): void {
  const bridge = requireBridge();
  if (bridge === null) return;
  bridge
    .reloadTmuxConfig()
    .then((reload) => showNotice(CONFIG_RELOAD_NOTICES[reload]))
    .catch((error: unknown) => reportFailure("config.reload", error));
}

// The moves that tmux reports an error for when they find nothing to go to.
function performMove(action: MoveWithError): boolean {
  switch (action.type) {
    case "pane.neighbour":
      return focusNeighbourPane(action.direction);
    case "pane.last":
      return focusLastPane();
    case "thread.jump":
      return goToThread((order) => nthThread(order, action.index));
    case "thread.end":
      return goToThread(lastThread);
    case "thread.cycle":
      return goToThread((order) =>
        cycleThread(order, getFocusedThreadId(), action.delta),
      );
    case "thread.last":
      return goToLastThread();
  }
}

function perform(action: Exclude<Action, ResizeAction | MoveWithError>): void {
  switch (action.type) {
    case "pane.focus":
      focusPaneInDirection(action.direction);
      return;
    case "pane.next":
      focusNextPane(1);
      return;
    case "pane.previous":
      focusNextPane(-1);
      return;
    case "pane.zoom":
      zoomFocusedPane();
      return;
    case "pane.close":
      closeFocusedPane();
      return;
    case "chooser.open":
      updateUiState({ chooser: { open: true, placement: action.placement } });
      return;
    case "help.open":
      updateUiState({ helpOpen: true });
      return;
    case "thread.new":
      startNewThread();
      return;
    // The key handler lets the key press through, which is the sending.
    case "prefix.send":
      return;
    case "config.reload":
      reloadTmuxConfig();
      return;
    case "notice.show":
      showNotice(action.text);
      return;
    case "sidebar.move":
      moveSidebarFocus(action.delta);
      return;
    case "sidebar.page":
      pageSidebarFocus(action.delta);
      return;
    case "sidebar.edge":
      focusSidebarEdge(action.edge);
      return;
    case "sidebar.open":
      openFocusedSidebarRow(action.placement);
      return;
    case "sidebar.leave":
      settleDomFocus();
      return;
    case "composer.focus":
      focusMessageBox();
      return;
    case "copy.enter":
      enterCopyModeFromKey(action.motion);
      return;
    case "copy.move":
      moveCopyCursor(action.motion);
      return;
    case "copy.scroll":
      scrollCopyView(action.direction * getSettings().scrollStepPx);
      return;
    case "copy.beginSelection":
      beginCopySelection();
      return;
    case "copy.clearSelection":
      clearCopySelection();
      return;
    case "copy.yank":
      yankFromKey(action.after);
      return;
    case "copy.exit":
      exitCopyMode();
      return;
  }
  action satisfies never;
}

// False when the action found nothing it could act on. A resize reports
// that, so that the key handler can close the repeat window it opened for it,
// and so do the moves that are an error in tmux then, which ends the command
// sequence of their key.
export function runAction(action: Action): boolean {
  try {
    cancelSidebarEntry();
    if (action.type === "pane.resize") {
      return resizeFocusedPane(
        action.direction,
        action.cells * getSettings().resizeCellPx,
      );
    }
    if (isMoveWithError(action)) return performMove(action);
    perform(action);
    return true;
  } catch (error) {
    reportFailure(action.type, error);
    return false;
  }
}
