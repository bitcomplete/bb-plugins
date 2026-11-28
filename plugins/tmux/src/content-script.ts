import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { cancelQueuedActions, runActionsInOrder } from "./action-queue";
import {
  cancelPendingActions,
  cancelPendingActionsOnPointerPress,
  runAction,
} from "./actions";
import { isMacPlatform, isPluginSyntheticEvent } from "./bb-commands";
import {
  getBridge,
  getUiState,
  subscribeUiState,
  updateUiState,
} from "./bridge";
import {
  exitCopyMode,
  exitCopyModeKeepingSelection,
  hasCopyModeLostConversation,
  isCopyModeActive,
} from "./copy-mode";
import { mountCopyOnSelect } from "./copy-on-select";
import {
  hasSidebarSelection,
  isInSelectionMenu,
  isSidebarRowFocusedByPointer,
  noteSidebarPointerDown,
} from "./dom-actions";
import { classifyFocus, detectSurface, isInOverlay } from "./focus-context";
import { buildKeymap, strokeForKeymap } from "./keymap";
import {
  isCompositionKey,
  keyStrokeFromEvent,
  typedCharacterFromEvent,
} from "./keys";
import {
  INITIAL_MACHINE_STATE,
  isOnPane,
  isPrefixArmed,
  isRepeatWindowOpen,
  step,
} from "./machine";
import { settleIdleDomFocus } from "./pane-focus";
import type { Settings } from "./settings";
import type { TmuxConfig } from "./tmux-keymap";
import type {
  Action,
  ActionType,
  FocusKind,
  Keymap,
  MachineState,
  StepResult,
  Surface,
} from "./types";

// wentIntoOverlay: the press itself went to an element of a dialog, a menu
// or a list. A press in a text field while a hover card of bb shows did not.
interface HeldKey {
  key: string;
  wentIntoOverlay: boolean;
  wasConsumed: boolean;
  actions: readonly Action[];
}

interface CachedKeymap {
  tmux: TmuxConfig;
  keymap: Keymap;
}

// The longest wait that a browser timer takes. A longer one runs at once.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const COPY_ACTION_PREFIX = "copy.";

// The actions that neither move the focus nor change what a pane shows, so
// that copy mode can go on over them.
const ACTIONS_BESIDE_COPY_MODE: ReadonlySet<ActionType> = new Set([
  "prefix.send",
  "config.reload",
  "notice.show",
]);

const REPEATABLE_ACTIONS: ReadonlySet<ActionType> = new Set([
  "sidebar.move",
  "sidebar.page",
  "copy.move",
  "copy.scroll",
  "pane.resize",
]);

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

// The sidebar keys are for a thread row reached from the keyboard. A row that
// was clicked is a plain link, and Escape is bb's while rows are selected. bb
// drops that selection on Escape itself only, so a key that stands in for
// Escape on a row, as Ctrl-[ does, stays a key of the row.
function focusKindOf(target: EventTarget | null, stroke: string): FocusKind {
  const kind = classifyFocus(target);
  if (kind !== "sidebar") return kind;
  if (isSidebarRowFocusedByPointer()) return "control";
  if (stroke === "Escape" && hasSidebarSelection()) return "control";
  return kind;
}

function leaveCopyMode(): void {
  if (isCopyModeActive()) exitCopyMode();
}

// A button of bb's selection menu acts on the selected text when it is
// clicked, so a press on it must not clear what copy mode selected.
function leaveCopyModeOnPointerDown(target: EventTarget | null): void {
  if (!isCopyModeActive()) return;
  if (isInSelectionMenu(target)) {
    exitCopyModeKeepingSelection();
    return;
  }
  exitCopyMode();
}

function allowsCopyMode(
  settings: Settings,
  focus: FocusKind,
  surface: Surface,
): boolean {
  return settings.enabled && isOnPane(focus) && surface === "thread";
}

function staysInCopyMode(action: Action): boolean {
  return (
    action.type.startsWith(COPY_ACTION_PREFIX) ||
    ACTIONS_BESIDE_COPY_MODE.has(action.type)
  );
}

// Copy mode keeps the cursor on the pane itself, so that its keys are not
// typed. A key that is meant to end it gives the cursor back to the message
// box. A key of copy mode that finds the selection lost ends copy mode too,
// but the keys that follow it are still meant for copy mode, so the cursor
// stays on the pane and none of them is typed.
function runOneFromKey(action: Action): boolean {
  const wasInCopyMode = isCopyModeActive();
  const staysIn = staysInCopyMode(action);
  if (!staysIn) leaveCopyMode();
  const hasRun = runAction(action);
  const isMeantToLeave = !staysIn || action.type === "copy.exit";
  if (wasInCopyMode && isMeantToLeave && !isCopyModeActive()) {
    settleIdleDomFocus();
  }
  return hasRun;
}

// The PageUp that entered copy mode after the prefix goes on as the PageUp of
// copy mode while it is held, as it does in tmux.
function continuesHeldAction(first: Action | undefined, repeat: Action): boolean {
  if (first === undefined || !REPEATABLE_ACTIONS.has(repeat.type)) return false;
  if (first.type === repeat.type) return true;
  return (
    first.type === "copy.enter" &&
    repeat.type === "copy.move" &&
    first.motion === repeat.motion
  );
}

function continuesHeldKey(
  first: readonly Action[],
  repeat: readonly Action[],
): boolean {
  if (repeat.length === 0 || first.length !== repeat.length) return false;
  return repeat.every((action, at) => continuesHeldAction(first[at], action));
}

// bb can hand the same module instance to the next run when the plugin is
// switched off and on again, so the flags of one run must not reach the next.
function clearWindowFlags(): void {
  updateUiState({ paused: false, chooser: { open: false }, helpOpen: false });
  leaveCopyMode();
}

export function mountKeyHandler(context: PluginContentScriptContext): () => void {
  const { signal } = context;
  if (signal.aborted) return () => {};

  let state: MachineState = INITIAL_MACHINE_STATE;
  let cachedKeymap: CachedKeymap | null = null;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let armedBy: string | null = null;
  let heldKey: HeldKey | null = null;
  let wasSwitchedOff = getUiState().switchState === "off";
  let disposed = false;
  const disposeCopyOnSelect = mountCopyOnSelect(signal);

  function keymapFor(tmux: TmuxConfig): Keymap {
    if (cachedKeymap === null || cachedKeymap.tmux !== tmux) {
      cachedKeymap = { tmux, keymap: buildKeymap(tmux) };
    }
    return cachedKeymap.keymap;
  }

  // stroke is the key that led to the state. Only a prefix key arms the
  // prefix, and the pill names that key until the prefix and the repeat
  // window after it are over.
  function setState(next: MachineState, stroke: string | null): void {
    state = next;
    if (armTimer !== null) clearTimeout(armTimer);
    armTimer = null;
    const now = Date.now();
    const armed = isPrefixArmed(next, now) || isRepeatWindowOpen(next, now);
    if (next.pending === "prefix") armedBy = stroke;
    if (!armed) armedBy = null;
    updateUiState({ prefixArmed: armed, prefixArmedBy: armedBy });
    if (!armed || next.deadline === null) return;
    // A prefix-timeout near the top of tmux's range gets no timer. The
    // machine checks the deadline at the next key by itself.
    const delay = next.deadline - now + 1;
    if (delay > MAX_TIMER_DELAY_MS) return;
    armTimer = setTimeout(reset, delay);
  }

  function reset(): void {
    setState(INITIAL_MACHINE_STATE, null);
  }

  // A key can be bound to several commands, which run in their order. The
  // machine opens the repeat window before the resize runs. A resize that
  // found no divider to move leaves nothing to repeat, so the window closes
  // and the keys of the window go back to typing.
  function runAndSettle(actions: readonly Action[]): void {
    runActionsInOrder(actions, runOneFromKey, () => {
      if (state.pending === "repeat") reset();
    });
  }

  // A held key only goes on doing what its first press did: it keeps moving
  // through the sidebar, moving the copy cursor, scrolling in copy mode or
  // resizing a pane, and it is swallowed when that press was taken by the
  // plugin or went to a dialog that has since closed.
  function onRepeat(
    event: KeyboardEvent,
    key: string,
    focus: FocusKind,
    result: StepResult,
  ): void {
    const first = heldKey?.key === key ? heldKey : null;
    const { actions } = result;
    if (continuesHeldKey(first?.actions ?? [], actions)) {
      setState(result.state, null);
      consume(event);
      runAndSettle(actions);
      return;
    }
    const hasLeftDialog = first?.wentIntoOverlay === true && focus !== "overlay";
    if (result.decision === "consume" || first?.wasConsumed || hasLeftDialog) {
      consume(event);
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (isPluginSyntheticEvent(event)) return;
    // Such a key is left to the browser, but it is not a modifier: like any
    // other key it ends a prefix or a repeat window that waits.
    if (isCompositionKey(event)) {
      cancelQueuedActions();
      if (state.pending !== "none") reset();
      return;
    }
    // A key that bb has already taken is left alone as well, and ends what
    // waits in the same way. A bare modifier does not.
    if (event.defaultPrevented) {
      if (state.pending !== "none" && keyStrokeFromEvent(event) !== null) {
        cancelQueuedActions();
        reset();
      }
      return;
    }
    if (getUiState().paused) {
      leaveCopyMode();
      return;
    }
    // No bridge means that the user's settings and tmux config are not known
    // yet, and the defaults could take keys that the user has switched off or
    // moved.
    const bridge = getBridge();
    if (bridge === null) return;
    const { settings } = bridge;
    const chord = keyStrokeFromEvent(event);
    if (chord === null) return;
    // A new key ends what the key before it still waited to do.
    if (!event.repeat) cancelQueuedActions();
    const keymap = keymapFor(bridge.tmux);
    const stroke = strokeForKeymap(
      keymap,
      chord,
      typedCharacterFromEvent(event, isMacPlatform(navigator.platform)),
    );
    const focus = focusKindOf(event.target, stroke);
    const surface = detectSurface();
    const canStayInCopyMode =
      allowsCopyMode(settings, focus, surface) && !hasCopyModeLostConversation();
    if (!canStayInCopyMode) leaveCopyMode();
    const result = step(
      state,
      {
        stroke,
        shift: event.shiftKey,
        focus,
        copyMode: isCopyModeActive(),
        now: Date.now(),
      },
      keymap,
      settings,
    );
    const key = event.code === "" ? stroke : event.code;
    if (event.repeat) {
      if (settings.enabled) onRepeat(event, key, focus, result);
      return;
    }
    const wasConsumed = result.decision === "consume";
    heldKey = {
      key,
      wentIntoOverlay: isInOverlay(event.target),
      wasConsumed,
      actions: result.actions,
    };
    setState(result.state, stroke);
    if (wasConsumed) consume(event);
    if (result.actions.length > 0) runAndSettle(result.actions);
  }

  function onBlur(): void {
    heldKey = null;
    reset();
    cancelQueuedActions();
    leaveCopyMode();
  }

  function onVisibilityChange(): void {
    if (document.visibilityState !== "hidden") return;
    reset();
    cancelQueuedActions();
    leaveCopyMode();
  }

  function onPointerDown(event: Event): void {
    if (isPluginSyntheticEvent(event)) return;
    noteSidebarPointerDown(event.target);
    reset();
    cancelQueuedActions();
    cancelPendingActionsOnPointerPress();
    leaveCopyModeOnPointerDown(event.target);
  }

  // Whatever is under way ends: an armed prefix or repeat window, a held
  // key, what an action still waits for, copy mode, and an open chooser or
  // key help.
  function stop(): void {
    heldKey = null;
    reset();
    cancelQueuedActions();
    cancelPendingActions();
    clearWindowFlags();
  }

  // The settings can switch the plugin off without a key or a mouse press in
  // this window, so what is under way is stopped as soon as the flag is set.
  function onUiStateChange(): void {
    const isSwitchedOff = getUiState().switchState === "off";
    if (isSwitchedOff === wasSwitchedOff) return;
    wasSwitchedOff = isSwitchedOff;
    if (isSwitchedOff) stop();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    signal.removeEventListener("abort", dispose);
    unsubscribeUiState();
    disposeCopyOnSelect();
    reset();
    cancelQueuedActions();
    cancelPendingActions();
    noteSidebarPointerDown(null);
    clearWindowFlags();
  }

  clearWindowFlags();
  const unsubscribeUiState = subscribeUiState(onUiStateChange);
  window.addEventListener("keydown", onKeydown, { capture: true, signal });
  window.addEventListener("pointerdown", onPointerDown, { capture: true, signal });
  window.addEventListener("blur", onBlur, { signal });
  document.addEventListener("visibilitychange", onVisibilityChange, { signal });
  signal.addEventListener("abort", dispose, { once: true });

  return dispose;
}
