import { getBridge, getUiState, showNotice } from "./bridge";
import { COPIED_NOTICE, COPY_FAILED_NOTICE, copySelection } from "./clipboard";
import { isConversationText, isCopyModeActive } from "./copy-mode";

interface SelectionEnds {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
}

interface MousePress {
  selectionBefore: SelectionEnds | null;
  hasSelectionChanged: boolean;
}

const PRIMARY_BUTTON = 0;

// auto follows the mouse option of tmux, which is what makes a selection
// with the mouse copy in tmux.
function isCopyOnSelectOn(): boolean {
  const bridge = getBridge();
  if (bridge === null || !bridge.settings.enabled) return false;
  const { copyOnSelect } = bridge.settings;
  const isWanted =
    copyOnSelect === "auto" ? bridge.tmux.options.mouse : copyOnSelect === "on";
  return isWanted && !getUiState().paused && !isCopyModeActive();
}

function hasConversationSelection(): boolean {
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount !== 1) return false;
  if (selection.isCollapsed || selection.toString().trim() === "") return false;
  const range = selection.getRangeAt(0);
  return (
    isConversationText(range.startContainer) &&
    isConversationText(range.endContainer)
  );
}

function readSelectionEnds(): SelectionEnds | null {
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  return { anchorNode, anchorOffset, focusNode, focusOffset };
}

function isSameSelection(a: SelectionEnds | null, b: SelectionEnds | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.anchorNode === b.anchorNode &&
    a.anchorOffset === b.anchorOffset &&
    a.focusNode === b.focusNode &&
    a.focusOffset === b.focusOffset
  );
}

function startsInConversation(event: MouseEvent): boolean {
  return event.target instanceof Node && isConversationText(event.target);
}

export function mountCopyOnSelect(signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};

  let press: MousePress | null = null;
  let pendingCheck: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Only a selection that this press made or changed is copied. One that was
  // already there, such as the word a right click selects, is left alone when
  // a later click lands on a part of bb that keeps the selection.
  function wasSelectedBy(finished: MousePress): boolean {
    if (finished.hasSelectionChanged) return true;
    return !isSameSelection(finished.selectionBefore, readSelectionEnds());
  }

  function copyFinishedSelection(): void {
    pendingCheck = null;
    const finished = press;
    press = null;
    if (finished === null || !isCopyOnSelectOn()) return;
    if (!hasConversationSelection() || !wasSelectedBy(finished)) return;
    void copySelection().then((result) => {
      if (disposed) return;
      if (result === "copied") showNotice(COPIED_NOTICE);
      if (result === "failed") showNotice(COPY_FAILED_NOTICE);
    });
  }

  function onMouseDown(event: MouseEvent): void {
    if (event.button !== PRIMARY_BUTTON || !startsInConversation(event)) {
      press = null;
      return;
    }
    press = { selectionBefore: readSelectionEnds(), hasSelectionChanged: false };
  }

  // The browser reports a changed selection a moment later, so the selection
  // is read one task after the button is released.
  function onMouseUp(event: MouseEvent): void {
    if (event.button !== PRIMARY_BUTTON) return;
    if (pendingCheck !== null) clearTimeout(pendingCheck);
    pendingCheck = setTimeout(copyFinishedSelection, 0);
  }

  // On macOS a click with Ctrl held is a right click: it opens the context
  // menu and selects the word under the pointer.
  function onContextMenu(): void {
    press = null;
  }

  function onSelectionChange(): void {
    if (press !== null) press.hasSelectionChanged = true;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (pendingCheck !== null) clearTimeout(pendingCheck);
    pendingCheck = null;
    press = null;
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("selectionchange", onSelectionChange);
    signal.removeEventListener("abort", dispose);
  }

  document.addEventListener("mousedown", onMouseDown, { capture: true, signal });
  document.addEventListener("mouseup", onMouseUp, { capture: true, signal });
  document.addEventListener("contextmenu", onContextMenu, { capture: true, signal });
  document.addEventListener("selectionchange", onSelectionChange, { signal });
  signal.addEventListener("abort", dispose, { once: true });

  return dispose;
}
