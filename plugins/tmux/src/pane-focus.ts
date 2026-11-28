import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { getBridge, getUiState, showNotice } from "./bridge";
import { ATTRIBUTES, SELECTORS } from "./constants";
import {
  activatePaneByPointer,
  focusPaneElement,
  getFocusedPaneElement,
  getPaneElementById,
} from "./dom-actions";
import { classifyFocus, isInTextField } from "./focus-context";
import type { SplitPane } from "./types";

const SETTLE_TIMEOUT_MS = 1000;

let cancelPending: (() => void) | null = null;
let hasGivenUp = false;
let isSettleOwed = false;

export function cancelPendingFocus(): void {
  cancelPending?.();
  cancelPending = null;
}

// True from a pane move, a pane close or a thread change of this plugin until
// bb shows what it asked for, or until the wait for that is dropped.
export function isFocusPending(): boolean {
  return cancelPending !== null;
}

// True when the last wait ended at its time limit, without bb showing what it
// waited for.
export function hasFocusWaitGivenUp(): boolean {
  return hasGivenUp;
}

export function getFocusedPane(): SplitPane | null {
  const layout = getBridge()?.layout ?? null;
  if (layout === null) return null;
  return layout.panes.find((pane) => pane.isFocused) ?? null;
}

export function getFocusedThreadId(): string | null {
  const bridge = getBridge();
  if (bridge === null) return null;
  if (bridge.layout === null) return bridge.context.threadId;
  return getFocusedPane()?.threadId ?? null;
}

function findFocusedComposer(): PluginComposerApi | null {
  const bridge = getBridge();
  if (bridge === null) return null;
  const threadId = getFocusedThreadId();
  if (threadId !== null) {
    const match = bridge.composers.find(
      ({ scope }) => scope.kind === "thread" && scope.threadId === threadId,
    );
    return match ?? null;
  }
  // bb keeps a single New thread screen per window, so its composer can sit in
  // a pane other than the focused one (a plugin page also has no thread, and
  // the chat that it may embed is not that screen).
  const paneElement = getFocusedPaneElement();
  if (paneElement !== null && paneElement.querySelector(SELECTORS.messageBox) === null) {
    return null;
  }
  return bridge.composers.find(({ scope }) => scope.kind === "new-thread") ?? null;
}

function tryFocusComposer(composer: PluginComposerApi): boolean {
  // In bb 0.50.1 focus() does nothing for a handle whose composer has
  // unmounted since the overlay last published it, and does not throw. The
  // catch is only there in case a later bb throws "This composer is no longer
  // available." here, as it does for the calls that change the draft.
  try {
    composer.focus();
    return true;
  } catch {
    return false;
  }
}

// The message box of a pane is its own composer. The editor bb opens in place
// to change a sent or a queued message is not, and neither is a composer in
// the side panel. bb marks the whole frame of the message box as the composer,
// with its banners, its question form and its buttons, so the cursor only
// counts as being there when it is in a text field.
function isInMessageBoxOfFocusedPane(target: Element | null): boolean {
  if (target === null || !isInTextField(target)) return false;
  const composer = target.closest(SELECTORS.composer);
  if (composer === null || composer.matches(SELECTORS.secondaryComposer)) {
    return false;
  }
  if (composer.closest(SELECTORS.sidePanelSplitContainer) !== null) return false;
  const pane = getFocusedPaneElement();
  return pane === null || pane.contains(composer);
}

export function isCursorInMessageBox(): boolean {
  return isInMessageBoxOfFocusedPane(document.activeElement);
}

// Puts the text cursor in the message box of the focused pane, so that the
// user can type at once. A cursor that is there already keeps its place in
// the draft. bb's own call puts it at the end of the draft a moment later,
// and does nothing while the box is hidden, for example behind a question
// form. So the pane takes the cursor first, and keeps it when the pane has no
// message box to give it to.
export function settleDomFocus(): void {
  if (isCursorInMessageBox()) return;
  focusPaneElement(getFocusedPaneElement());
  const composer = findFocusedComposer();
  if (composer !== null) tryFocusComposer(composer);
}

function isDialogOpen(): boolean {
  const { chooser, helpOpen } = getUiState();
  return chooser.open || helpOpen;
}

// For the end of copy mode, which keeps the cursor on the pane itself. A
// cursor that something else has taken since stays where it is, and so does
// one that a pane move or a dialog of this plugin is about to place.
export function settleIdleDomFocus(): void {
  if (cancelPending !== null || isDialogOpen()) return;
  if (classifyFocus(document.activeElement) !== "normal") return;
  settleDomFocus();
}

// True once after a wait ended while the thread chooser or the key help was
// open. The cursor then stayed in that dialog and is still owed to the pane.
export function takeOwedSettle(): boolean {
  const isOwed = isSettleOwed;
  isSettleOwed = false;
  return isOwed;
}

// The function it returns drops this wait and says whether it was still on.
// A wait that has settled, or that a newer one has replaced, is left alone.
// settle is what places the cursor once bb is ready. At the time limit, and
// after a dialog of this plugin that was open meanwhile, settleDomFocus does.
export function settleDomFocusWhen(
  isReady: () => boolean,
  timeoutMs: number = SETTLE_TIMEOUT_MS,
  settle: () => void = settleDomFocus,
): () => boolean {
  cancelPendingFocus();
  hasGivenUp = false;
  isSettleOwed = false;
  let frame = 0;
  const finish = (place: () => void) => {
    cancelPendingFocus();
    if (isDialogOpen()) {
      isSettleOwed = true;
      return;
    }
    place();
  };
  const poll = () => {
    if (isReady()) {
      finish(settle);
      return;
    }
    frame = requestAnimationFrame(poll);
  };
  const timer = setTimeout(() => {
    hasGivenUp = true;
    finish(settleDomFocus);
  }, timeoutMs);
  const stop = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
  cancelPending = stop;
  frame = requestAnimationFrame(poll);
  return () => {
    if (cancelPending !== stop) return false;
    cancelPendingFocus();
    return true;
  };
}

// A pane that shows a plugin page can hold the chat of that plugin, which bb
// marks as a secondary composer. Only the message box counts.
export function showsNewThreadScreen(pane: SplitPane): boolean {
  const element = getPaneElementById(pane.paneId);
  return element !== null && element.querySelector(SELECTORS.messageBox) !== null;
}

function navigateToPane(pane: SplitPane): void {
  const navigate = getBridge()?.navigate;
  if (navigate === undefined) return;
  if (pane.threadId !== null) {
    navigate.toThread(pane.threadId);
    return;
  }
  // toCompose() focuses the New thread pane when there is one, but replaces the
  // focused pane's thread when there is none, so never use it for a plugin pane.
  if (!showsNewThreadScreen(pane)) {
    showNotice("Could not move to that pane.");
    return;
  }
  navigate.toCompose();
}

export function focusPane(pane: SplitPane): void {
  cancelPendingFocus();
  hasGivenUp = false;
  isSettleOwed = false;
  activatePaneByPointer(pane.paneId);
  const frame = requestAnimationFrame(() => {
    cancelPending = null;
    if (getFocusedPane()?.paneId !== pane.paneId) navigateToPane(pane);
    settleDomFocusWhen(
      () => getFocusedPaneElement()?.getAttribute(ATTRIBUTES.paneId) === pane.paneId,
    );
  });
  cancelPending = () => cancelAnimationFrame(frame);
}
