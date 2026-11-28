import { getBridge, showNotice } from "./bridge";
import { MAX_PANES, PLUGIN_ID } from "./constants";
import { getThreadPaneElements, isCompactViewport } from "./dom-actions";
import { classifyFocus, detectSurface } from "./focus-context";
import { forgetStandIn } from "./history";
import {
  BRIDGE_MISSING_NOTICE,
  PANE_LIMIT_NOTICE,
  isThreadVisible,
  openThread,
  unzoomBeforeSplit,
} from "./open-thread";
import {
  cancelPendingFocus,
  getFocusedPane,
  getFocusedThreadId,
  isCursorInMessageBox,
  settleIdleDomFocus,
  showsNewThreadScreen,
} from "./pane-focus";
import {
  activeThreads,
  isThreadRunning,
  sortThreadsByRecency,
} from "./thread-order";
import type { Bridge, FocusKind, SplitPane, SplitPlacement } from "./types";

export type NewThreadResult =
  | "started"
  | "focused-existing"
  | "pane-limit"
  | "unavailable";

interface NewPaneRequest {
  threadId: string;
  placement: SplitPlacement;
  paneCountBefore: number;
  isSwap: boolean;
}

interface PendingWait {
  stop: () => void;
  onPointerPress: (() => void) | null;
}

const NEW_PANE_TIMEOUT_MS: Record<SplitPlacement, number> = {
  right: 1500,
  down: 3000,
};
const NEW_THREAD_SCREEN_TIMEOUT_MS = 1500;

export const ONE_NEW_THREAD_SCREEN_NOTICE =
  "bb shows the New thread screen in one pane only, so you were moved to it.";
const PLACEHOLDER_KEPT_NOTICE = `${ONE_NEW_THREAD_SCREEN_NOTICE} The new pane kept the thread it opened with.`;
const NO_PANES_NOTICE = "This page shows no panes, so no new pane was opened.";
const NARROW_WINDOW_NOTICE =
  "This window is too narrow for panes, so no new pane was opened.";
const NO_THREAD_NOTICE = "There is no thread to open the new pane with.";
const NEW_PANE_FAILED_NOTICE = "Could not open the new pane.";
const NEW_PANE_BELOW_FAILED_NOTICE = "Could not open the new pane below.";
const THREAD_PUT_BACK_NOTICE = "The thread is back in its pane.";
const THREAD_CLOSED_NOTICE =
  "The thread that was in the pane is closed. Open it again from the sidebar.";

const NOT_TYPING_FOCUS: ReadonlySet<FocusKind> = new Set([
  "normal",
  "control",
  "sidebar",
]);

let pendingWait: PendingWait | null = null;
let latestCall = 0;

export function cancelPendingNewThread(): void {
  pendingWait?.stop();
  pendingWait = null;
}

// A pointer press means the user has moved on, so the wait ends. The first
// half of a swap is the exception: the thread has left its pane by then, and
// the wait goes on so that the user is told.
export function interruptPendingNewThread(): void {
  if (pendingWait === null) return;
  if (pendingWait.onPointerPress === null) {
    cancelPendingNewThread();
    return;
  }
  pendingWait.onPointerPress();
}

function waitUntil(
  isReady: () => boolean,
  timeoutMs: number,
  onReady: () => void,
  onTimeout: () => void,
): PendingWait {
  let frame = 0;
  const finish = (then: () => void): void => {
    cancelPendingNewThread();
    then();
  };
  const poll = (): void => {
    if (isReady()) {
      finish(onReady);
      return;
    }
    frame = requestAnimationFrame(poll);
  };
  const timer = setTimeout(() => finish(onTimeout), timeoutMs);
  const wait: PendingWait = {
    stop: () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    },
    onPointerPress: null,
  };
  pendingWait = wait;
  frame = requestAnimationFrame(poll);
  return wait;
}

function isNewThreadPane(pane: SplitPane): boolean {
  return pane.threadId === null && showsNewThreadScreen(pane);
}

function hasNewThreadScreen(bridge: Bridge): boolean {
  if (bridge.layout === null) return detectSurface() === "compose";
  return bridge.layout.panes.some(isNewThreadPane);
}

// bb shows the New thread screen in one pane only: asked for it, it moves to
// a pane that shows it already and leaves the focused pane as it is.
export function hasNewThreadScreenInAnotherPane(bridge: Bridge): boolean {
  const panes = bridge.layout?.panes ?? [];
  return panes.some((pane) => !pane.isFocused && isNewThreadPane(pane));
}

// The thread that fills the new pane until the New thread screen replaces it.
// bb marks a thread as read when it is shown, and again when new activity
// arrives while it is shown, so a read thread that is not running goes first.
function pickPlaceholderId(bridge: Bridge): string | null {
  const candidates = sortThreadsByRecency(activeThreads(bridge.threads)).filter(
    (thread) => !isThreadVisible(bridge, thread.id),
  );
  const placeholder =
    candidates.find((thread) => !thread.isUnread && !isThreadRunning(thread)) ??
    candidates.find((thread) => !thread.isUnread) ??
    candidates.at(0);
  return placeholder?.id ?? null;
}

// bb updates its pane layout a moment after toCompose() changed the page, and
// until then it takes a thread opened in a new pane for one that is already
// shown. A single pane has no layout to watch here, but bb lists the New
// thread message box only after that update.
function isNewThreadScreenFocused(): boolean {
  const bridge = getBridge();
  if (bridge === null || getFocusedThreadId() !== null) return false;
  if (bridge.layout !== null) return true;
  return bridge.composers.some(({ scope }) => scope.kind === "new-thread");
}

function isFocusedInNewPane(threadId: string, paneCountBefore: number): boolean {
  const layout = getBridge()?.layout ?? null;
  if (layout === null || layout.panes.length <= paneCountBefore) return false;
  return getFocusedPane()?.threadId === threadId;
}

function openInNewPane(
  bridge: Bridge,
  threadId: string,
  placement: SplitPlacement,
  onRejected: () => void,
): void {
  if (placement === "right") {
    bridge.navigate.toThread(threadId, { split: true });
    return;
  }
  bridge.sdk.threads
    .open({ threadId, split: "down", file: null })
    .catch((error: unknown) => {
      console.error(`[${PLUGIN_ID}] threads.open failed`, error);
      onRejected();
    });
}

function goToNewThreadScreen(): void {
  const bridge = getBridge();
  if (bridge === null) return;
  cancelPendingFocus();
  bridge.navigate.toCompose({ focusPrompt: true });
}

// A New thread screen that showed up in another pane during the wait is the
// one bb moves to, and the new pane keeps the placeholder thread. Otherwise
// the new pane has only held that thread for the plugin, so it does not count
// as a thread that the pane showed.
function replacePlaceholderWithNewThreadScreen(threadId: string): void {
  const bridge = getBridge();
  if (bridge === null) return;
  const isScreenInAnotherPane = hasNewThreadScreen(bridge);
  const newPane = getFocusedPane();
  if (!isScreenInAnotherPane && newPane !== null) forgetStandIn(newPane.paneId, threadId);
  goToNewThreadScreen();
  if (isScreenInAnotherPane) showNotice(PLACEHOLDER_KEPT_NOTICE);
}

// bb puts the cursor in the message box of the New thread screen by itself as
// soon as that screen shows, so a cursor there does not tell that the user is
// writing. The draft does. A cursor in any other text field or in the
// terminal does.
function isUserWriting(bridge: Bridge): boolean {
  if (NOT_TYPING_FOCUS.has(classifyFocus(document.activeElement))) return false;
  if (!isCursorInMessageBox()) return true;
  const draft = bridge.composers.find(({ scope }) => scope.kind === "new-thread");
  return draft === undefined || !draft.isEmpty;
}

// toThread() fills the focused pane, so the thread that a swap took out of its
// pane only goes back while that pane still shows the New thread screen and
// the user is not writing.
function canPutThreadBack(bridge: Bridge): boolean {
  if (isUserWriting(bridge)) return false;
  if (bridge.layout === null) return detectSurface() === "compose";
  const focused = getFocusedPane();
  return focused !== null && isNewThreadPane(focused);
}

// The chooser that asked for the new pane has closed and left the cursor on
// nothing. A failure that comes while the plugin still waits gives it to the
// message box of the focused pane. After a mouse press the cursor is where
// the user put it.
function showFailure(text: string, isStillWaiting: boolean): void {
  showNotice(text);
  if (isStillWaiting) settleIdleDomFocus();
}

function reportSwapFailure(
  threadId: string,
  failure: string,
  isStillWaiting: boolean,
): void {
  const bridge = getBridge();
  if (bridge === null || isThreadVisible(bridge, threadId)) {
    showFailure(failure, isStillWaiting);
    return;
  }
  if (!isStillWaiting || !canPutThreadBack(bridge)) {
    showFailure(`${failure} ${THREAD_CLOSED_NOTICE}`, isStillWaiting);
    return;
  }
  openThread(threadId, "replace");
  showNotice(`${failure} ${THREAD_PUT_BACK_NOTICE}`);
}

function reportThreadClosedByStoppedSwap(threadId: string): void {
  const bridge = getBridge();
  if (bridge === null || isThreadVisible(bridge, threadId)) return;
  showNotice(`${NEW_PANE_FAILED_NOTICE} ${THREAD_CLOSED_NOTICE}`);
}

function openPaneThenNewThread(request: NewPaneRequest): void {
  const bridge = getBridge();
  if (bridge === null) return;
  const { threadId, placement, paneCountBefore, isSwap } = request;
  const call = latestCall;
  let hasEnded = false;
  const fail = (failure: string, isStillWaiting: boolean): void => {
    if (hasEnded) return;
    hasEnded = true;
    if (!isSwap) {
      showFailure(failure, isStillWaiting);
      return;
    }
    reportSwapFailure(threadId, failure, isStillWaiting);
  };
  cancelPendingFocus();
  openInNewPane(bridge, threadId, placement, () => {
    const isStillWaiting = call === latestCall && pendingWait !== null;
    if (isStillWaiting) cancelPendingNewThread();
    fail(NEW_PANE_BELOW_FAILED_NOTICE, isStillWaiting);
  });
  waitUntil(
    () => isFocusedInNewPane(threadId, paneCountBefore),
    NEW_PANE_TIMEOUT_MS[placement],
    () => {
      hasEnded = true;
      if (isSwap) {
        goToNewThreadScreen();
        return;
      }
      replacePlaceholderWithNewThreadScreen(threadId);
    },
    () => fail(NEW_PANE_FAILED_NOTICE, true),
  );
}

function moveFocusedThreadToNewPane(bridge: Bridge, swap: NewPaneRequest): void {
  let wasPointerPressed = false;
  cancelPendingFocus();
  bridge.navigate.toCompose();
  const wait = waitUntil(
    isNewThreadScreenFocused,
    NEW_THREAD_SCREEN_TIMEOUT_MS,
    () => {
      if (wasPointerPressed) {
        reportThreadClosedByStoppedSwap(swap.threadId);
        return;
      }
      openPaneThenNewThread(swap);
    },
    () => {
      if (wasPointerPressed) {
        reportThreadClosedByStoppedSwap(swap.threadId);
        return;
      }
      reportSwapFailure(swap.threadId, NEW_PANE_FAILED_NOTICE, true);
    },
  );
  wait.onPointerPress = () => {
    wasPointerPressed = true;
  };
}

export function openNewThreadInSplit(placement: SplitPlacement): NewThreadResult {
  cancelPendingNewThread();
  latestCall += 1;
  const bridge = getBridge();
  if (bridge === null) {
    showNotice(BRIDGE_MISSING_NOTICE);
    return "unavailable";
  }
  // bb keeps its pane layout while Settings or a plugin page fills the window,
  // so neither the layout nor the route says what such a page shows.
  if (getThreadPaneElements().length === 0) {
    showNotice(NO_PANES_NOTICE);
    return "unavailable";
  }
  if (hasNewThreadScreen(bridge)) {
    goToNewThreadScreen();
    showNotice(ONE_NEW_THREAD_SCREEN_NOTICE);
    return "focused-existing";
  }
  if (isCompactViewport()) {
    showNotice(NARROW_WINDOW_NOTICE);
    return "unavailable";
  }
  const paneCountBefore = bridge.layout?.panes.length ?? 1;
  if (paneCountBefore >= MAX_PANES) {
    showNotice(PANE_LIMIT_NOTICE);
    return "pane-limit";
  }
  const placeholderId = pickPlaceholderId(bridge);
  if (placeholderId !== null) {
    unzoomBeforeSplit();
    openPaneThenNewThread({
      threadId: placeholderId,
      placement,
      paneCountBefore,
      isSwap: false,
    });
    return "started";
  }
  const focusedThreadId = getFocusedThreadId();
  if (focusedThreadId === null) {
    showNotice(NO_THREAD_NOTICE);
    return "unavailable";
  }
  unzoomBeforeSplit();
  moveFocusedThreadToNewPane(bridge, {
    threadId: focusedThreadId,
    placement,
    paneCountBefore,
    isSwap: true,
  });
  return "started";
}
