// @vitest-environment jsdom
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingActions,
  cancelPendingActionsOnPointerPress,
  runAction,
} from "./actions";
import { isMacPlatform, isPluginSyntheticEvent } from "./bb-commands";
import { getUiState, resetStore, setBridge, updateUiState } from "./bridge";
import { mountKeyHandler } from "./content-script";
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
import { keyStrokeFromEvent, typedCharacterFromEvent } from "./keys";
import { INITIAL_MACHINE_STATE, step } from "./machine";
import { isFocusPending, settleIdleDomFocus } from "./pane-focus";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import type { TmuxConfig } from "./tmux-keymap";
import type {
  Action,
  Bridge,
  FocusKind,
  Keymap,
  MachineState,
  StepInput,
  StepResult,
} from "./types";

vi.mock("./actions", () => ({
  cancelPendingActions: vi.fn(),
  cancelPendingActionsOnPointerPress: vi.fn(),
  runAction: vi.fn(),
}));
vi.mock("./bb-commands", () => ({
  isMacPlatform: vi.fn(),
  isPluginSyntheticEvent: vi.fn(),
}));
vi.mock("./copy-mode", () => ({
  exitCopyMode: vi.fn(),
  exitCopyModeKeepingSelection: vi.fn(),
  hasCopyModeLostConversation: vi.fn(),
  isCopyModeActive: vi.fn(),
}));
vi.mock("./copy-on-select", () => ({ mountCopyOnSelect: vi.fn() }));
vi.mock("./dom-actions", () => ({
  hasSidebarSelection: vi.fn(),
  isInSelectionMenu: vi.fn(),
  isSidebarRowFocusedByPointer: vi.fn(),
  noteSidebarPointerDown: vi.fn(),
}));
vi.mock("./focus-context", () => ({
  classifyFocus: vi.fn(),
  detectSurface: vi.fn(),
  isInOverlay: vi.fn(),
}));
vi.mock("./keymap", () => ({ buildKeymap: vi.fn(), strokeForKeymap: vi.fn() }));
vi.mock("./keys", async (importOriginal) => ({
  isCompositionKey: (await importOriginal<typeof import("./keys")>()).isCompositionKey,
  keyStrokeFromEvent: vi.fn(),
  typedCharacterFromEvent: vi.fn(),
}));
vi.mock("./machine", () => ({
  INITIAL_MACHINE_STATE: { pending: "none", deadline: null },
  isOnPane: (focus: FocusKind) => focus === "normal" || focus === "control",
  isPrefixArmed: vi.fn(
    (state: MachineState, now: number) =>
      state.pending === "prefix" && (state.deadline === null || now <= state.deadline),
  ),
  isRepeatWindowOpen: vi.fn(
    (state: MachineState, now: number) =>
      state.pending === "repeat" && state.deadline !== null && now <= state.deadline,
  ),
  step: vi.fn(),
}));
vi.mock("./pane-focus", () => ({
  hasFocusWaitGivenUp: vi.fn(),
  isFocusPending: vi.fn(),
  settleIdleDomFocus: vi.fn(),
}));

const PREFIX_TIMEOUT_MS = 3000;
const REPEAT_TIMEOUT_MS = 1000;

// The settings of these tests have the plugin switched on.
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, enabled: true };

const KEYMAP: Keymap = {
  prefix: "C-a",
  prefix2: null,
  repeatTimeMs: REPEAT_TIMEOUT_MS,
  prefixTimeoutMs: PREFIX_TIMEOUT_MS,
  modeKeys: "emacs",
  prefixBindings: [],
  rootBindings: [],
  plainBindings: [],
  sidebarBindings: [],
  copyBindings: [],
  sentCopyBindings: [],
  listSplitKeys: { right: [], down: [], newThread: [] },
};

// The keymap is built by a stand-in here, so what the config holds does not
// matter, only which config it is.
function tmuxConfig(): TmuxConfig {
  return {
    options: {
      prefix: null,
      prefix2: null,
      modeKeys: "emacs",
      mouse: false,
      repeatTimeMs: REPEAT_TIMEOUT_MS,
      prefixTimeoutMs: PREFIX_TIMEOUT_MS,
      baseIndex: 0,
    },
    tables: { prefix: [], root: [], copyMode: [], copyModeVi: [] },
    files: [],
    unreadable: false,
    namedFile: false,
    pastedText: "none",
  };
}

const TMUX = tmuxConfig();

const SIDEBAR_DOWN: Action = { type: "sidebar.move", delta: 1 };
const FOCUS_LEFT: Action = { type: "pane.focus", direction: "left" };
const FOCUS_DOWN: Action = { type: "pane.focus", direction: "down" };
const FOCUS_MESSAGE_BOX: Action = { type: "composer.focus" };
const COPY_MOVE_DOWN: Action = { type: "copy.move", motion: "line-down" };
const COPY_SCROLL_DOWN: Action = { type: "copy.scroll", direction: 1 };
const COPY_ENTER: Action = { type: "copy.enter", motion: null };
const COPY_ENTER_PAGE_UP: Action = { type: "copy.enter", motion: "page-up" };
const COPY_PAGE_UP: Action = { type: "copy.move", motion: "page-up" };
const RESIZE_RIGHT: Action = { type: "pane.resize", direction: "right", cells: 5 };
const SEND_PREFIX: Action = { type: "prefix.send", second: false };
const CONFIG_RELOAD: Action = { type: "config.reload" };
const SHOW_NOTICE: Action = { type: "notice.show", text: "Config reloaded" };
// What Option-l is on a US Mac keyboard: the key types this character.
const OPTION_L: KeyboardEventInit = { key: "\u00ac", code: "KeyL", altKey: true };

let controller: AbortController;
let dispose: () => void;
let laterListener: ReturnType<typeof vi.fn<(event: Event) => void>>;
let disposeCopyOnSelect: ReturnType<typeof vi.fn<() => void>>;
let copyModeActive: boolean;

function mount(signal: AbortSignal = controller.signal): () => void {
  const context: PluginContentScriptContext = { pluginId: "tmux", generation: 1, signal };
  dispose = mountKeyHandler(context);
  window.addEventListener("keydown", laterListener, true);
  return dispose;
}

function pass(state: MachineState = INITIAL_MACHINE_STATE): StepResult {
  return { state, decision: "pass", actions: [] };
}

function consumed(...actions: Action[]): StepResult {
  return { state: INITIAL_MACHINE_STATE, decision: "consume", actions };
}

function armedState(): MachineState {
  return { pending: "prefix", deadline: Date.now() + PREFIX_TIMEOUT_MS };
}

function armPrefix(): MachineState {
  const state = armedState();
  vi.mocked(step).mockReturnValueOnce({ state, decision: "consume", actions: [] });
  press({ key: "a", code: "KeyA", ctrlKey: true });
  return state;
}

function repeatState(): MachineState {
  return { pending: "repeat", deadline: Date.now() + REPEAT_TIMEOUT_MS };
}

function resizeWith(init: KeyboardEventInit = {}): MachineState {
  const state = repeatState();
  vi.mocked(step).mockReturnValueOnce({ state, decision: "consume", actions: [RESIZE_RIGHT] });
  press({ ...OPTION_L, ...init });
  return state;
}

function resizeAfterPrefix(): MachineState {
  armPrefix();
  return resizeWith();
}

function press(init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "j",
    code: "KeyJ",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function lastStepState(): MachineState {
  const calls = vi.mocked(step).mock.calls;
  return calls[calls.length - 1][0];
}

function lastStepInput(): StepInput {
  const calls = vi.mocked(step).mock.calls;
  return calls[calls.length - 1][1];
}

function callOrder(mock: unknown): number {
  return vi.mocked(mock as () => void).mock.invocationCallOrder[0];
}

function publishSettings(settings: Settings, tmux: TmuxConfig = TMUX): void {
  setBridge({
    settings,
    tmux,
    layout: null,
    context: { projectId: null, threadId: null },
  } as unknown as Bridge);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  controller = new AbortController();
  laterListener = vi.fn<(event: Event) => void>();
  disposeCopyOnSelect = vi.fn<() => void>();
  copyModeActive = false;
  vi.mocked(isCopyModeActive).mockImplementation(() => copyModeActive);
  vi.mocked(exitCopyMode).mockImplementation(() => {
    copyModeActive = false;
  });
  vi.mocked(exitCopyModeKeepingSelection).mockImplementation(() => {
    copyModeActive = false;
  });
  vi.mocked(hasCopyModeLostConversation).mockReturnValue(false);
  vi.mocked(isInSelectionMenu).mockReturnValue(false);
  vi.mocked(mountCopyOnSelect).mockReturnValue(disposeCopyOnSelect);
  publishSettings(SETTINGS);
  vi.mocked(isPluginSyntheticEvent).mockReturnValue(false);
  vi.mocked(isMacPlatform).mockReturnValue(true);
  vi.mocked(hasSidebarSelection).mockReturnValue(false);
  vi.mocked(isSidebarRowFocusedByPointer).mockReturnValue(false);
  vi.mocked(classifyFocus).mockReturnValue("normal");
  vi.mocked(isInOverlay).mockReturnValue(false);
  vi.mocked(detectSurface).mockReturnValue("thread");
  vi.mocked(buildKeymap).mockReturnValue(KEYMAP);
  vi.mocked(keyStrokeFromEvent).mockImplementation((event) => event.key);
  vi.mocked(typedCharacterFromEvent).mockReturnValue(null);
  vi.mocked(strokeForKeymap).mockImplementation((_keymap, chord) => chord);
  vi.mocked(step).mockReturnValue(pass());
  vi.mocked(runAction).mockReturnValue(true);
});

afterEach(() => {
  dispose?.();
  controller.abort();
  window.removeEventListener("keydown", laterListener, true);
  resetStore();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("mountKeyHandler", () => {
  it("installs one capture-phase keydown listener on window tied to the signal", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");

    mount();

    const keydownCalls = addEventListener.mock.calls.filter(([type]) => type === "keydown");
    expect(keydownCalls).toHaveLength(2);
    expect(keydownCalls[0][2]).toEqual({ capture: true, signal: controller.signal });
    expect(keydownCalls[1][1]).toBe(laterListener);
    const keyupCalls = addEventListener.mock.calls.filter(([type]) => type === "keyup");
    expect(keyupCalls).toHaveLength(0);
  });

  it("feeds the machine with the stroke, focus kind, copy mode, time, keymap and settings", () => {
    mount();
    vi.mocked(classifyFocus).mockReturnValue("sidebar");
    vi.mocked(detectSurface).mockReturnValue("compose");
    const button = document.body.appendChild(document.createElement("button"));

    press({ key: "G" }, button);

    expect(classifyFocus).toHaveBeenCalledWith(button);
    expect(buildKeymap).toHaveBeenCalledWith(TMUX);
    expect(step).toHaveBeenCalledWith(
      INITIAL_MACHINE_STATE,
      {
        stroke: "G",
        shift: false,
        focus: "sidebar",
        copyMode: false,
        now: Date.now(),
      },
      KEYMAP,
      SETTINGS,
    );
    button.remove();
  });

  it("lets the keymap choose between the chord and the character that a key press typed", () => {
    mount();
    vi.mocked(keyStrokeFromEvent).mockReturnValue("M-5");
    vi.mocked(typedCharacterFromEvent).mockReturnValue("[");
    vi.mocked(strokeForKeymap).mockReturnValue("[");

    const event = press({ key: "[", code: "Digit5", altKey: true });

    expect(typedCharacterFromEvent).toHaveBeenCalledWith(event, true);
    expect(strokeForKeymap).toHaveBeenCalledWith(KEYMAP, "M-5", "[");
    expect(lastStepInput().stroke).toBe("[");
  });

  it("tells the machine whether Shift is held, which the stroke of a character does not say", () => {
    mount();

    press({ key: "i", code: "KeyI", shiftKey: true });
    expect(lastStepInput()).toMatchObject({ stroke: "i", shift: true });

    press({ key: "i", code: "KeyI" });
    expect(lastStepInput()).toMatchObject({ stroke: "i", shift: false });
  });

  it("tells the key reader when the platform is not a Mac", () => {
    mount();
    vi.mocked(isMacPlatform).mockReturnValue(false);

    const event = press({ key: "[", code: "Digit8", ctrlKey: true, altKey: true });

    expect(isMacPlatform).toHaveBeenCalledWith(navigator.platform);
    expect(typedCharacterFromEvent).toHaveBeenCalledWith(event, false);
  });

  it("keeps the keymap when the settings change, because the keys come from the tmux config alone", () => {
    mount();
    press();
    press();
    expect(buildKeymap).toHaveBeenCalledTimes(1);

    const changed = { ...SETTINGS, scrollStepPx: 120 };
    publishSettings(changed);
    press();
    press();

    expect(buildKeymap).toHaveBeenCalledTimes(1);
    expect(vi.mocked(step).mock.lastCall?.[3]).toBe(changed);
  });

  it("rebuilds the keymap when the tmux config is read again, and only then", () => {
    mount();
    press();
    publishSettings(SETTINGS, TMUX);
    press();
    expect(buildKeymap).toHaveBeenCalledTimes(1);

    const reloaded = tmuxConfig();
    publishSettings(SETTINGS, reloaded);
    press();
    press();

    expect(buildKeymap).toHaveBeenCalledTimes(2);
    expect(buildKeymap).toHaveBeenLastCalledWith(reloaded);
  });
});

describe("events the handler ignores", () => {
  function expectIgnored(event: KeyboardEvent): void {
    expect(step).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
    expect(laterListener).toHaveBeenCalledWith(event);
  }

  beforeEach(() => {
    vi.mocked(step).mockReturnValue(consumed(SIDEBAR_DOWN));
  });

  it("ignores the plugin's own synthetic events", () => {
    mount();
    vi.mocked(isPluginSyntheticEvent).mockReturnValue(true);

    const event = press();

    expect(isPluginSyntheticEvent).toHaveBeenCalledWith(event);
    expect(event.defaultPrevented).toBe(false);
    expectIgnored(event);
  });

  it("ignores events another listener already handled", () => {
    const earlier = (event: Event) => event.preventDefault();
    window.addEventListener("keydown", earlier, true);
    mount();

    const event = press();

    window.removeEventListener("keydown", earlier, true);
    expect(event.defaultPrevented).toBe(true);
    expectIgnored(event);
  });

  it("ignores keys typed during IME composition", () => {
    mount();

    const composing = press({ isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    expectIgnored(composing);

    const processKey = press({ keyCode: 229 });
    expect(processKey.keyCode).toBe(229);
    expect(processKey.defaultPrevented).toBe(false);
    expectIgnored(processKey);
  });

  it("ignores everything while paused", () => {
    mount();
    updateUiState({ paused: true });

    const event = press();

    expect(event.defaultPrevented).toBe(false);
    expectIgnored(event);
  });

  it("ignores every key until the overlay has published the user's settings", () => {
    mount();
    setBridge(null);

    const event = press({ key: "a", code: "KeyA", ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(buildKeymap).not.toHaveBeenCalled();
    expectIgnored(event);
  });

  it("ignores keys without a stroke, such as a bare modifier", () => {
    mount();
    vi.mocked(keyStrokeFromEvent).mockReturnValue(null);

    const event = press({ key: "Control", code: "ControlLeft" });

    expect(event.defaultPrevented).toBe(false);
    expect(strokeForKeymap).not.toHaveBeenCalled();
    expectIgnored(event);
  });

  it("ignores a dead key, which waits for the next letter to put an accent on it", () => {
    mount();

    const event = press({ key: "Dead", code: "KeyU", altKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(keyStrokeFromEvent).not.toHaveBeenCalled();
    expectIgnored(event);
  });
});

// What Option-u is on a US Mac keyboard. Chromium may report it as key 229,
// the way it reports a key that an input method takes, or with its own code.
const DEAD_KEYS: [string, KeyboardEventInit][] = [
  ["a dead key", { key: "Dead", code: "KeyU", altKey: true }],
  ["a dead key reported as key 229", { key: "Dead", code: "KeyU", altKey: true, keyCode: 229 }],
  ["a key that an input method takes", { key: "Process", code: "KeyH", keyCode: 229 }],
  ["a key typed during composition", { key: "j", code: "KeyJ", isComposing: true }],
];

describe("a key that composes text while the plugin waits for a key", () => {
  it.each(DEAD_KEYS)("ends the prefix on %s and leaves that key alone", (_name, init) => {
    mount();
    armPrefix();
    vi.mocked(step).mockClear();

    const event = press(init);

    expect(getUiState().prefixArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    expect(laterListener).toHaveBeenCalledWith(event);
    expect(step).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
  });

  it.each(DEAD_KEYS)("hands the key after %s to the machine without the prefix", (_name, init) => {
    mount();
    armPrefix();
    press(init);
    vi.advanceTimersByTime(PREFIX_TIMEOUT_MS - 500);

    const typed = press({ key: "x", code: "KeyX" });

    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
    expect(typed.defaultPrevented).toBe(false);
    expect(runAction).not.toHaveBeenCalled();
  });

  it.each(DEAD_KEYS)("ends the repeat window on %s", (_name, init) => {
    mount();
    resizeAfterPrefix();

    const event = press(init);

    expect(getUiState().prefixArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    press(OPTION_L);
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Alt", "AltLeft"],
    ["Shift", "ShiftLeft"],
    ["Control", "ControlLeft"],
    ["Meta", "MetaLeft"],
  ])("keeps the prefix through the bare modifier %s, which composes nothing", (key, code) => {
    mount();
    const armed = armPrefix();
    vi.mocked(keyStrokeFromEvent).mockReturnValueOnce(null);

    press({ key, code, altKey: key === "Alt" });

    expect(getUiState().prefixArmed).toBe(true);
    press(OPTION_L);
    expect(lastStepState()).toBe(armed);
  });
});

describe("a key that bb took before the plugin while the plugin waits for a key", () => {
  // bb handles its pane shortcuts in a listener that comes before the
  // plugin's. It prevents the default and lets the other listeners run.
  const takenByBb = (event: Event): void => {
    if ((event as KeyboardEvent).metaKey) event.preventDefault();
  };
  const BB_SHORTCUT: KeyboardEventInit = {
    key: "ArrowLeft",
    code: "ArrowLeft",
    metaKey: true,
    ctrlKey: true,
  };

  beforeEach(() => {
    window.addEventListener("keydown", takenByBb, true);
  });

  afterEach(() => {
    window.removeEventListener("keydown", takenByBb, true);
  });

  it("ends the prefix and leaves the key alone", () => {
    mount();
    armPrefix();
    vi.mocked(step).mockClear();

    const event = press(BB_SHORTCUT);

    expect(event.defaultPrevented).toBe(true);
    expect(getUiState().prefixArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(step).not.toHaveBeenCalled();
    expect(laterListener).toHaveBeenCalledWith(event);
    press({ key: "c", code: "KeyC" });
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
  });

  it("ends the repeat window", () => {
    mount();
    resizeAfterPrefix();

    press(BB_SHORTCUT);

    expect(getUiState().prefixArmed).toBe(false);
    press(OPTION_L);
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
  });

  it("keeps the prefix through a bare modifier, which is no key press to tmux", () => {
    mount();
    const armed = armPrefix();
    vi.mocked(keyStrokeFromEvent).mockReturnValueOnce(null);

    const event = press({ key: "Meta", code: "MetaLeft", metaKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(getUiState().prefixArmed).toBe(true);
    press(OPTION_L);
    expect(lastStepState()).toBe(armed);
  });
});

describe("consume and pass", () => {
  it("prevents the default and stops every later listener for a consumed key", () => {
    mount();
    vi.mocked(step).mockReturnValue(consumed());

    const event = press();

    expect(event.defaultPrevented).toBe(true);
    expect(laterListener).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
  });

  it("leaves a passed key completely alone", () => {
    mount();
    const preventDefault = vi.spyOn(KeyboardEvent.prototype, "preventDefault");
    const stopImmediatePropagation = vi.spyOn(
      KeyboardEvent.prototype,
      "stopImmediatePropagation",
    );
    const stopPropagation = vi.spyOn(KeyboardEvent.prototype, "stopPropagation");

    const event = press();

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopImmediatePropagation).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(laterListener).toHaveBeenCalledWith(event);
  });

  it("runs the action of a consumed key", () => {
    mount();
    vi.mocked(step).mockReturnValue(consumed(FOCUS_LEFT));

    const event = press({ key: "h", code: "KeyH", ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenCalledWith(FOCUS_LEFT);
  });

  it("carries the machine state from one key to the next", () => {
    mount();
    const armed = armPrefix();

    press({ key: "o", code: "KeyO" });

    expect(lastStepState()).toBe(armed);
    press({ key: "o", code: "KeyO" });
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
  });

  it("passes the key that tmux binds to send-prefix through to the focused element", () => {
    mount();
    armPrefix();
    vi.mocked(step).mockReturnValueOnce({
      state: INITIAL_MACHINE_STATE,
      decision: "pass",
      actions: [SEND_PREFIX],
    });

    const second = press({ key: "a", code: "KeyA", ctrlKey: true });

    expect(second.defaultPrevented).toBe(false);
    expect(laterListener).toHaveBeenCalledWith(second);
    expect(runAction).toHaveBeenCalledExactlyOnceWith(SEND_PREFIX);
    expect(getUiState().prefixArmed).toBe(false);
  });

  it("swallows the repeats of that key, which would only arm the prefix again", () => {
    mount();
    armPrefix();
    vi.mocked(step).mockReturnValueOnce({
      state: INITIAL_MACHINE_STATE,
      decision: "pass",
      actions: [SEND_PREFIX],
    });
    press({ key: "a", code: "KeyA", ctrlKey: true });
    vi.mocked(step).mockReturnValueOnce({
      state: armedState(),
      decision: "consume",
      actions: [],
    });

    const repeat = press({ key: "a", code: "KeyA", ctrlKey: true, repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(getUiState().prefixArmed).toBe(false);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("runs every action of a key that tmux binds to several commands, in their order", () => {
    mount();
    vi.mocked(step).mockReturnValue(consumed(CONFIG_RELOAD, SHOW_NOTICE));

    const event = press({ key: "r", code: "KeyR" });

    expect(event.defaultPrevented).toBe(true);
    expect(vi.mocked(runAction).mock.calls).toEqual([[CONFIG_RELOAD], [SHOW_NOTICE]]);
  });

  it("goes on with the next action when one found nothing to act on", () => {
    mount();
    vi.mocked(runAction).mockReturnValueOnce(false);
    vi.mocked(step).mockReturnValue(consumed(RESIZE_RIGHT, SHOW_NOTICE));

    press();

    expect(vi.mocked(runAction).mock.calls).toEqual([[RESIZE_RIGHT], [SHOW_NOTICE]]);
  });
});

describe("a key whose next command has to wait for bb", () => {
  const CLOSE: Action = { type: "pane.close" };
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;

  function runFrame(): void {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  }

  function pressMoveThenClose(): void {
    vi.mocked(isFocusPending).mockReturnValue(true);
    vi.mocked(step).mockReturnValueOnce(consumed(FOCUS_DOWN, CLOSE));
    press({ key: "x", code: "KeyX" });
  }

  function bbFollows(): void {
    vi.mocked(isFocusPending).mockReturnValue(false);
    runFrame();
  }

  beforeEach(() => {
    frames.clear();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the command after a pane move only once bb has followed the move", () => {
    mount();

    pressMoveThenClose();
    expect(vi.mocked(runAction).mock.calls).toEqual([[FOCUS_DOWN]]);

    runFrame();
    expect(vi.mocked(runAction).mock.calls).toEqual([[FOCUS_DOWN]]);

    bbFollows();
    expect(vi.mocked(runAction).mock.calls).toEqual([[FOCUS_DOWN], [CLOSE]]);
  });

  it("drops that command when another key is pressed first", () => {
    mount();
    pressMoveThenClose();

    press({ key: "j", code: "KeyJ" });
    bbFollows();

    expect(vi.mocked(runAction).mock.calls).toEqual([[FOCUS_DOWN]]);
  });

  it("keeps it over the repeats of the key while it is held, and over a key that is no stroke, such as Shift", () => {
    mount();
    pressMoveThenClose();

    press({ key: "x", code: "KeyX", repeat: true });
    vi.mocked(keyStrokeFromEvent).mockReturnValueOnce(null);
    press({ key: "Shift", code: "ShiftLeft" });
    bbFollows();

    expect(vi.mocked(runAction).mock.calls).toEqual([[FOCUS_DOWN], [CLOSE]]);
  });

  it.each([
    ["a mouse press", () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))],
    ["the window losing focus", () => window.dispatchEvent(new Event("blur"))],
    ["a dead key", () => press({ key: "Dead", code: "Backquote" })],
    ["the plugin being switched off", () => updateUiState({ switchState: "off" })],
    ["the key handler being removed", () => dispose()],
  ])("drops that command on %s", (_what, interrupt) => {
    mount();
    pressMoveThenClose();

    interrupt();
    bbFollows();

    expect(vi.mocked(runAction).mock.calls).toEqual([[FOCUS_DOWN]]);
  });

  it("closes the repeat window when the command that had to wait found nothing to act on", () => {
    mount();
    vi.mocked(isFocusPending).mockReturnValue(true);
    vi.mocked(step).mockReturnValueOnce({
      state: repeatState(),
      decision: "consume",
      actions: [FOCUS_DOWN, RESIZE_RIGHT],
    });
    press({ key: "x", code: "KeyX" });
    expect(getUiState().prefixArmed).toBe(true);

    vi.mocked(runAction).mockReturnValueOnce(false);
    bbFollows();

    expect(vi.mocked(runAction).mock.calls).toEqual([[FOCUS_DOWN], [RESIZE_RIGHT]]);
    expect(getUiState().prefixArmed).toBe(false);
  });
});

describe("auto-repeat of a key with several actions", () => {
  it("lets a key repeat that moves the copy cursor several lines at once", () => {
    mount();
    vi.mocked(step).mockReturnValue(consumed(COPY_MOVE_DOWN, COPY_MOVE_DOWN));

    press();
    const repeat = press({ repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(4);
  });

  it("runs a key once that does more than move, scroll or resize, however long it is held", () => {
    mount();
    vi.mocked(step).mockReturnValue(consumed(COPY_MOVE_DOWN, SHOW_NOTICE));

    press();
    const repeat = press({ repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(2);
  });

  it("lets a held key page through the sidebar", () => {
    mount();
    vi.mocked(step).mockReturnValue(consumed({ type: "sidebar.page", delta: 1 }));

    press();
    press({ repeat: true });

    expect(runAction).toHaveBeenCalledTimes(2);
  });
});

describe("auto-repeat", () => {
  it.each<Action>([
    { type: "sidebar.move", delta: -1 },
    COPY_MOVE_DOWN,
    COPY_SCROLL_DOWN,
    RESIZE_RIGHT,
  ])(
    "lets $type repeat",
    (action) => {
      mount();
      vi.mocked(step).mockReturnValue(consumed(action));

      press();
      const repeat = press({ repeat: true });

      expect(repeat.defaultPrevented).toBe(true);
      expect(runAction).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps resizing while a resize key is held and starts the repeat window again each time", () => {
    mount();
    resizeAfterPrefix();
    vi.advanceTimersByTime(600);

    const renewed = resizeWith({ repeat: true });

    expect(runAction).toHaveBeenCalledTimes(2);
    expect(runAction).toHaveBeenLastCalledWith(RESIZE_RIGHT);
    expect(laterListener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REPEAT_TIMEOUT_MS - 1);
    expect(getUiState().prefixArmed).toBe(true);
    press({ key: "x", code: "KeyX" });
    expect(lastStepState()).toBe(renewed);
  });

  it("swallows a held resize key without resizing once the repeat window is over", () => {
    mount();
    resizeAfterPrefix();
    vi.advanceTimersByTime(REPEAT_TIMEOUT_MS + 1);

    const repeat = press({ ...OPTION_L, repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(laterListener).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(getUiState().prefixArmed).toBe(false);
  });

  it("does not resize from the repeats of a key whose first press did something else", () => {
    mount();
    vi.mocked(step).mockReturnValueOnce(consumed(FOCUS_LEFT));
    press(OPTION_L);
    vi.mocked(step).mockReturnValueOnce({
      state: repeatState(),
      decision: "consume",
      actions: [RESIZE_RIGHT],
    });

    const repeat = press({ ...OPTION_L, repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenCalledWith(FOCUS_LEFT);
    expect(getUiState().prefixArmed).toBe(false);
  });

  it.each<Action>([
    FOCUS_LEFT,
    { type: "pane.next" },
    { type: "pane.close" },
    { type: "sidebar.edge", edge: "top" },
    FOCUS_MESSAGE_BOX,
    COPY_ENTER,
    { type: "copy.beginSelection" },
    { type: "copy.clearSelection" },
    { type: "copy.yank", after: "exit" },
  ])("runs $type once however long the key is held", (action) => {
    mount();
    vi.mocked(step).mockReturnValue(consumed(action));

    press();
    const repeat = press({ repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(laterListener).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("consumes other repeated keys without running the action or changing the state", () => {
    mount();
    const armed = armPrefix();
    vi.mocked(step).mockReturnValueOnce(consumed({ type: "pane.close" }));

    const repeat = press({ key: "a", code: "KeyA", ctrlKey: true, repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(laterListener).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
    press({ key: "x", code: "KeyX" });
    expect(lastStepState()).toBe(armed);
  });

  it("consumes and ignores a held prefix key", () => {
    mount();
    const armed = armPrefix();
    vi.mocked(step).mockReturnValueOnce(pass());

    const repeat = press({ key: "a", code: "KeyA", ctrlKey: true, repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(laterListener).not.toHaveBeenCalled();
    expect(getUiState().prefixArmed).toBe(true);
    press({ key: "h", code: "KeyH" });
    expect(lastStepState()).toBe(armed);
  });

  it("keeps swallowing a held key after its action ran, even once the machine would pass it", () => {
    mount();
    armPrefix();
    vi.mocked(step).mockReturnValueOnce(consumed(FOCUS_LEFT));
    press({ key: "h", code: "KeyH" });

    const repeat = press({ key: "h", code: "KeyH", repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("does not type a held i into the message box that its first press put the cursor in", () => {
    mount();
    vi.mocked(step).mockReturnValueOnce(consumed(FOCUS_MESSAGE_BOX));
    press({ key: "i", code: "KeyI" });
    vi.mocked(classifyFocus).mockReturnValue("typing");

    const repeat = press({ key: "i", code: "KeyI", repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(laterListener).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenCalledWith(FOCUS_MESSAGE_BOX);
  });

  it("lets the repeats of a passed key through", () => {
    mount();
    vi.mocked(step).mockReturnValueOnce(consumed(FOCUS_LEFT));
    press({ key: "h", code: "KeyH" });

    const typed = press({ key: "h", code: "KeyH" });
    const repeat = press({ key: "h", code: "KeyH", repeat: true });

    expect(typed.defaultPrevented).toBe(false);
    expect(repeat.defaultPrevented).toBe(false);
    expect(laterListener).toHaveBeenCalledWith(repeat);
  });

  it("does not let a key held after the prefix repeat as a sidebar key", () => {
    mount();
    armPrefix();
    vi.mocked(step).mockReturnValueOnce(consumed(FOCUS_DOWN));
    press();
    vi.mocked(step).mockReturnValue(consumed(SIDEBAR_DOWN));

    const repeat = press({ repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(laterListener).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenCalledWith(FOCUS_DOWN);
  });

  it("does not start moving the copy cursor from the repeats of a key that was passed on", () => {
    mount();
    press();
    vi.mocked(step).mockReturnValue(consumed(COPY_MOVE_DOWN));

    const repeat = press({ repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(runAction).not.toHaveBeenCalled();
  });

  it("swallows the repeats of a key that closed a dialog once focus is back on the page", () => {
    mount();
    vi.mocked(classifyFocus).mockReturnValue("overlay");
    vi.mocked(isInOverlay).mockReturnValue(true);
    const closing = press({ key: "q", code: "KeyQ" });
    vi.mocked(classifyFocus).mockReturnValue("typing");
    vi.mocked(isInOverlay).mockReturnValue(false);

    const repeat = press({ key: "q", code: "KeyQ", repeat: true });

    expect(closing.defaultPrevented).toBe(false);
    expect(repeat.defaultPrevented).toBe(true);
    expect(laterListener).toHaveBeenCalledTimes(1);
    expect(laterListener).toHaveBeenCalledWith(closing);
  });

  it("lets a key that was typed into a text field under a hover card of bb go on repeating after the card has closed", () => {
    mount();
    const field = document.createElement("textarea");
    document.body.append(field);
    vi.mocked(classifyFocus).mockReturnValue("overlay");
    const first = press({ key: "Backspace", code: "Backspace" }, field);
    const underCard = press({ key: "Backspace", code: "Backspace", repeat: true }, field);
    vi.mocked(classifyFocus).mockReturnValue("typing");

    const afterCard = press({ key: "Backspace", code: "Backspace", repeat: true }, field);

    field.remove();
    expect(isInOverlay).toHaveBeenCalledWith(field);
    expect(first.defaultPrevented).toBe(false);
    expect(underCard.defaultPrevented).toBe(false);
    expect(afterCard.defaultPrevented).toBe(false);
    expect(laterListener).toHaveBeenCalledWith(afterCard);
  });

  it("lets a key held inside a dialog repeat there", () => {
    mount();
    vi.mocked(classifyFocus).mockReturnValue("overlay");
    press({ key: "j", code: "KeyJ" });

    const repeat = press({ key: "j", code: "KeyJ", repeat: true });

    expect(repeat.defaultPrevented).toBe(false);
    expect(laterListener).toHaveBeenCalledWith(repeat);
  });

  it("does not swallow another key that is typed after the dialog closed", () => {
    mount();
    vi.mocked(classifyFocus).mockReturnValue("overlay");
    vi.mocked(isInOverlay).mockReturnValue(true);
    press({ key: "q", code: "KeyQ" });
    vi.mocked(classifyFocus).mockReturnValue("typing");
    vi.mocked(isInOverlay).mockReturnValue(false);

    const typed = press({ key: "q", code: "KeyQ" });
    const repeat = press({ key: "q", code: "KeyQ", repeat: true });

    expect(typed.defaultPrevented).toBe(false);
    expect(repeat.defaultPrevented).toBe(false);
  });

  it("leaves every repeat alone while the plugin is switched off", () => {
    mount();
    publishSettings({ ...SETTINGS, enabled: false });
    vi.mocked(classifyFocus).mockReturnValue("overlay");
    vi.mocked(isInOverlay).mockReturnValue(true);
    press({ key: "q", code: "KeyQ" });
    vi.mocked(classifyFocus).mockReturnValue("typing");

    const repeat = press({ key: "q", code: "KeyQ", repeat: true });

    expect(repeat.defaultPrevented).toBe(false);
    expect(laterListener).toHaveBeenCalledWith(repeat);
  });

  it("forgets the held key when the window loses focus", () => {
    mount();
    vi.mocked(step).mockReturnValueOnce(consumed(FOCUS_LEFT));
    press({ key: "h", code: "KeyH" });
    window.dispatchEvent(new Event("blur"));

    const repeat = press({ key: "h", code: "KeyH", repeat: true });

    expect(repeat.defaultPrevented).toBe(false);
  });
});

describe("copy mode", () => {
  const OTHER_FOCUS_KINDS: FocusKind[] = ["overlay", "frame", "typing", "sidebar"];

  const COPY_ACTIONS: Action[] = [
    COPY_ENTER,
    COPY_ENTER_PAGE_UP,
    COPY_MOVE_DOWN,
    COPY_SCROLL_DOWN,
    { type: "copy.beginSelection" },
    { type: "copy.clearSelection" },
    { type: "copy.yank", after: "exit" },
    { type: "copy.exit" },
  ];

  const OTHER_ACTIONS: Action[] = [
    FOCUS_LEFT,
    { type: "pane.next" },
    { type: "pane.zoom" },
    RESIZE_RIGHT,
    { type: "chooser.open", placement: "replace" },
    { type: "thread.cycle", delta: 1 },
    { type: "help.open" },
  ];

  it("tells the machine whether copy mode is active", () => {
    mount();

    press();
    expect(lastStepInput().copyMode).toBe(false);

    copyModeActive = true;
    press();
    expect(lastStepInput().copyMode).toBe(true);
    expect(exitCopyMode).not.toHaveBeenCalled();
  });

  it.each(["normal", "control"] as const)(
    "stays in copy mode for a key in %s focus on a thread",
    (focus) => {
      mount();
      copyModeActive = true;
      vi.mocked(classifyFocus).mockReturnValue(focus);

      press();

      expect(exitCopyMode).not.toHaveBeenCalled();
      expect(lastStepInput()).toMatchObject({ focus, copyMode: true });
    },
  );

  it.each(OTHER_FOCUS_KINDS)(
    "leaves copy mode before the machine sees a key in %s focus",
    (focus) => {
      mount();
      copyModeActive = true;
      vi.mocked(classifyFocus).mockReturnValue(focus);

      press();

      expect(exitCopyMode).toHaveBeenCalledTimes(1);
      expect(callOrder(exitCopyMode)).toBeLessThan(callOrder(step));
      expect(lastStepInput()).toMatchObject({ focus, copyMode: false });
    },
  );

  it("stays in copy mode on a sidebar row that was clicked, which counts as a control", () => {
    mount();
    copyModeActive = true;
    vi.mocked(classifyFocus).mockReturnValue("sidebar");
    vi.mocked(isSidebarRowFocusedByPointer).mockReturnValue(true);

    press();

    expect(exitCopyMode).not.toHaveBeenCalled();
    expect(lastStepInput()).toMatchObject({ focus: "control", copyMode: true });
  });

  it.each(["compose", "other"] as const)(
    "leaves copy mode when the pane shows the %s surface instead of a conversation",
    (surface) => {
      mount();
      copyModeActive = true;
      vi.mocked(detectSurface).mockReturnValue(surface);

      press();

      expect(exitCopyMode).toHaveBeenCalledTimes(1);
      expect(callOrder(exitCopyMode)).toBeLessThan(callOrder(step));
      expect(lastStepInput().copyMode).toBe(false);
    },
  );

  it("leaves copy mode before the machine sees a key once bb replaced the conversation", () => {
    mount();
    copyModeActive = true;
    vi.mocked(hasCopyModeLostConversation).mockReturnValue(true);

    press();

    expect(exitCopyMode).toHaveBeenCalledTimes(1);
    expect(callOrder(exitCopyMode)).toBeLessThan(callOrder(step));
    expect(lastStepInput()).toMatchObject({ focus: "normal", copyMode: false });
  });

  it.each(OTHER_ACTIONS)(
    "leaves copy mode before running the action $type",
    (action) => {
      mount();
      copyModeActive = true;
      vi.mocked(step).mockReturnValue(consumed(action));

      press();

      expect(exitCopyMode).toHaveBeenCalledTimes(1);
      expect(runAction).toHaveBeenCalledWith(action);
      expect(callOrder(exitCopyMode)).toBeLessThan(callOrder(runAction));
    },
  );

  it.each([SEND_PREFIX, CONFIG_RELOAD, SHOW_NOTICE])(
    "stays in copy mode over the action $type, which neither moves the focus nor changes a pane",
    (action) => {
      mount();
      copyModeActive = true;
      vi.mocked(step).mockReturnValue(consumed(action));

      press();

      expect(exitCopyMode).not.toHaveBeenCalled();
      expect(settleIdleDomFocus).not.toHaveBeenCalled();
      expect(runAction).toHaveBeenCalledWith(action);
    },
  );

  it("enters copy mode and starts selecting from one key of the tmux config", () => {
    mount();
    vi.mocked(step).mockReturnValue(
      consumed(COPY_ENTER, { type: "copy.beginSelection" }),
    );

    press();

    expect(exitCopyMode).not.toHaveBeenCalled();
    expect(vi.mocked(runAction).mock.calls).toEqual([
      [COPY_ENTER],
      [{ type: "copy.beginSelection" }],
    ]);
  });

  it("leaves copy mode for a pane action that the tmux config binds in the copy table", () => {
    mount();
    copyModeActive = true;
    vi.mocked(step).mockReturnValue(consumed(SHOW_NOTICE, FOCUS_LEFT));

    press();

    expect(exitCopyMode).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAction).mock.calls).toEqual([[SHOW_NOTICE], [FOCUS_LEFT]]);
    expect(settleIdleDomFocus).toHaveBeenCalledTimes(1);
  });

  it.each(COPY_ACTIONS)("leaves $type to the copy engine", (action) => {
    mount();
    copyModeActive = true;
    vi.mocked(step).mockReturnValue(consumed(action));

    press();

    expect(exitCopyMode).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledWith(action);
  });

  it.each(OTHER_ACTIONS)(
    "gives the cursor back to the message box after $type has ended copy mode",
    (action) => {
      mount();
      copyModeActive = true;
      vi.mocked(step).mockReturnValue(consumed(action));

      press();

      expect(settleIdleDomFocus).toHaveBeenCalledTimes(1);
      expect(callOrder(runAction)).toBeLessThan(callOrder(settleIdleDomFocus));
    },
  );

  it("gives the cursor back to the message box when q or Escape leaves copy mode", () => {
    mount();
    copyModeActive = true;
    vi.mocked(step).mockReturnValue(consumed({ type: "copy.exit" }));
    vi.mocked(runAction).mockImplementation(() => {
      copyModeActive = false;
      return true;
    });

    press({ key: "q", code: "KeyQ" });

    expect(settleIdleDomFocus).toHaveBeenCalledTimes(1);
    expect(callOrder(runAction)).toBeLessThan(callOrder(settleIdleDomFocus));
  });

  it.each(COPY_ACTIONS.filter((action) => action.type !== "copy.exit"))(
    "leaves the cursor on the pane when $type finds the selection lost, so that the next copy-mode keys are not typed",
    (action) => {
      mount();
      copyModeActive = true;
      vi.mocked(step).mockReturnValue(consumed(action));
      vi.mocked(runAction).mockImplementation(() => {
        copyModeActive = false;
        return true;
      });

      press();

      expect(runAction).toHaveBeenCalledWith(action);
      expect(settleIdleDomFocus).not.toHaveBeenCalled();
    },
  );

  it.each(COPY_ACTIONS.filter((action) => action.type !== "copy.exit"))(
    "leaves the cursor on the pane while $type keeps copy mode on",
    (action) => {
      mount();
      copyModeActive = true;
      vi.mocked(step).mockReturnValue(consumed(action));

      press();

      expect(settleIdleDomFocus).not.toHaveBeenCalled();
    },
  );

  it.each([...OTHER_ACTIONS, ...COPY_ACTIONS])(
    "leaves the cursor alone for $type outside copy mode",
    (action) => {
      mount();
      vi.mocked(step).mockReturnValue(consumed(action));

      press();

      expect(runAction).toHaveBeenCalledWith(action);
      expect(settleIdleDomFocus).not.toHaveBeenCalled();
    },
  );

  it("leaves the cursor alone when copy mode ends without a key of its own", () => {
    mount();
    copyModeActive = true;
    vi.mocked(classifyFocus).mockReturnValue("typing");
    press();
    copyModeActive = true;
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    copyModeActive = true;
    window.dispatchEvent(new Event("blur"));

    expect(exitCopyMode).toHaveBeenCalledTimes(3);
    expect(settleIdleDomFocus).not.toHaveBeenCalled();
  });

  it("stays in copy mode for a swallowed key and for a key that is passed on", () => {
    mount();
    copyModeActive = true;

    vi.mocked(step).mockReturnValueOnce(consumed());
    const swallowed = press({ key: "x", code: "KeyX" });
    const copied = press({ key: "c", code: "KeyC", metaKey: true });

    expect(swallowed.defaultPrevented).toBe(true);
    expect(copied.defaultPrevented).toBe(false);
    expect(exitCopyMode).not.toHaveBeenCalled();
  });

  it("stays in copy mode while the prefix is armed and leaves on the pane move after it", () => {
    mount();
    copyModeActive = true;

    armPrefix();
    expect(exitCopyMode).not.toHaveBeenCalled();

    vi.mocked(step).mockReturnValueOnce(consumed(FOCUS_LEFT));
    press({ key: "h", code: "KeyH" });
    expect(exitCopyMode).toHaveBeenCalledTimes(1);
  });

  it("leaves copy mode on any pointer press", () => {
    mount();
    copyModeActive = true;

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(isInSelectionMenu).toHaveBeenCalledWith(document.body);
    expect(exitCopyMode).toHaveBeenCalledTimes(1);
    expect(exitCopyModeKeepingSelection).not.toHaveBeenCalled();
  });

  it("leaves copy mode but keeps its selection for a press on bb's selection menu", () => {
    mount();
    copyModeActive = true;
    const addToChat = document.createElement("button");
    document.body.append(addToChat);
    vi.mocked(isInSelectionMenu).mockImplementation((target) => target === addToChat);

    addToChat.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(exitCopyModeKeepingSelection).toHaveBeenCalledTimes(1);
    expect(exitCopyMode).not.toHaveBeenCalled();
    addToChat.remove();
  });

  it("leaves copy mode on window blur", () => {
    mount();
    copyModeActive = true;

    window.dispatchEvent(new Event("blur"));

    expect(exitCopyMode).toHaveBeenCalledTimes(1);
  });

  it("leaves copy mode when the document becomes hidden, not when it becomes visible", () => {
    mount();
    copyModeActive = true;
    const visibility = vi.spyOn(document, "visibilityState", "get");

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(exitCopyMode).not.toHaveBeenCalled();

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(exitCopyMode).toHaveBeenCalledTimes(1);
  });

  it("leaves copy mode when the handler is disposed", () => {
    mount();
    copyModeActive = true;

    dispose();

    expect(exitCopyMode).toHaveBeenCalledTimes(1);
  });

  it("leaves copy mode when the signal aborts", () => {
    mount();
    copyModeActive = true;

    controller.abort();

    expect(exitCopyMode).toHaveBeenCalledTimes(1);
  });

  it("leaves a copy mode that an earlier run left behind when the handler mounts", () => {
    copyModeActive = true;

    mount();

    expect(exitCopyMode).toHaveBeenCalledTimes(1);
  });

  it("leaves copy mode on the next key once the keys are paused or switched off", () => {
    mount();
    copyModeActive = true;
    updateUiState({ paused: true });
    const paused = press();
    expect(exitCopyMode).toHaveBeenCalledTimes(1);
    expect(paused.defaultPrevented).toBe(false);
    expect(step).not.toHaveBeenCalled();

    updateUiState({ paused: false });
    copyModeActive = true;
    publishSettings({ ...SETTINGS, enabled: false });
    press();
    expect(exitCopyMode).toHaveBeenCalledTimes(2);
    expect(lastStepInput().copyMode).toBe(false);
  });

  it("never asks the copy engine to leave while copy mode is not active", () => {
    mount();
    vi.mocked(classifyFocus).mockReturnValue("typing");
    vi.mocked(step).mockReturnValueOnce(consumed(FOCUS_LEFT));

    press();
    vi.mocked(isInSelectionMenu).mockReturnValue(true);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    dispose();

    expect(exitCopyMode).not.toHaveBeenCalled();
    expect(exitCopyModeKeepingSelection).not.toHaveBeenCalled();
  });

  it("keeps moving the copy cursor while a movement key is held", () => {
    mount();
    copyModeActive = true;
    vi.mocked(step).mockReturnValue(consumed(COPY_MOVE_DOWN));

    press();
    const first = press({ repeat: true });
    const second = press({ repeat: true });

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(3);
    expect(runAction).toHaveBeenLastCalledWith(COPY_MOVE_DOWN);
    expect(exitCopyMode).not.toHaveBeenCalled();
  });

  it("keeps scrolling in copy mode while Ctrl-e or Ctrl-y is held", () => {
    mount();
    copyModeActive = true;
    vi.mocked(step).mockReturnValue(consumed(COPY_SCROLL_DOWN));

    press({ key: "e", code: "KeyE", ctrlKey: true });
    const repeat = press({ key: "e", code: "KeyE", ctrlKey: true, repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(2);
    expect(runAction).toHaveBeenLastCalledWith(COPY_SCROLL_DOWN);
    expect(exitCopyMode).not.toHaveBeenCalled();
  });

  it("goes on paging from the repeats of the PageUp that entered copy mode", () => {
    mount();
    armPrefix();
    vi.mocked(step).mockReturnValueOnce(consumed(COPY_ENTER_PAGE_UP));
    press({ key: "PageUp", code: "PageUp" });
    copyModeActive = true;
    vi.mocked(step).mockReturnValue(consumed(COPY_PAGE_UP));

    const first = press({ key: "PageUp", code: "PageUp", repeat: true });
    const second = press({ key: "PageUp", code: "PageUp", repeat: true });

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(3);
    expect(runAction).toHaveBeenNthCalledWith(1, COPY_ENTER_PAGE_UP);
    expect(runAction).toHaveBeenNthCalledWith(2, COPY_PAGE_UP);
    expect(runAction).toHaveBeenNthCalledWith(3, COPY_PAGE_UP);
    expect(exitCopyMode).not.toHaveBeenCalled();
  });

  it.each([
    ["the [ that entered copy mode", COPY_ENTER, COPY_MOVE_DOWN],
    ["a key that entered copy mode with another move", COPY_ENTER_PAGE_UP, COPY_MOVE_DOWN],
  ])("swallows the repeats of %s", (_name, entered, repeated) => {
    mount();
    armPrefix();
    vi.mocked(step).mockReturnValueOnce(consumed(entered));
    press({ key: "[", code: "BracketLeft" });
    copyModeActive = true;
    vi.mocked(step).mockReturnValue(consumed(repeated));

    const repeat = press({ key: "[", code: "BracketLeft", repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenCalledWith(entered);
  });

  it("does not type the repeats of the key that left copy mode", () => {
    mount();
    copyModeActive = true;
    vi.mocked(step).mockReturnValueOnce(consumed({ type: "copy.exit" }));
    press({ key: "q", code: "KeyQ" });
    copyModeActive = false;

    const repeat = press({ key: "q", code: "KeyQ", repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(laterListener).not.toHaveBeenCalled();
  });

  it("leaves copy mode on a repeated key as well once focus is in a text field", () => {
    mount();
    copyModeActive = true;
    vi.mocked(step).mockReturnValueOnce(consumed(COPY_MOVE_DOWN));
    press();
    vi.mocked(classifyFocus).mockReturnValue("typing");

    press({ repeat: true });

    expect(exitCopyMode).toHaveBeenCalledTimes(1);
    expect(lastStepInput().copyMode).toBe(false);
  });
});

describe("copy on select", () => {
  it("mounts once with the content script's signal", () => {
    mount();

    expect(mountCopyOnSelect).toHaveBeenCalledTimes(1);
    expect(mountCopyOnSelect).toHaveBeenCalledWith(controller.signal);
    expect(disposeCopyOnSelect).not.toHaveBeenCalled();
  });

  it("is disposed once with the handler", () => {
    mount();

    dispose();
    dispose();

    expect(disposeCopyOnSelect).toHaveBeenCalledTimes(1);
  });

  it("is disposed when the signal aborts", () => {
    mount();

    controller.abort();

    expect(disposeCopyOnSelect).toHaveBeenCalledTimes(1);
  });

  it("is not mounted for a signal that is already aborted", () => {
    const aborted = new AbortController();
    aborted.abort();

    mountKeyHandler({ pluginId: "tmux", generation: 1, signal: aborted.signal });

    expect(mountCopyOnSelect).not.toHaveBeenCalled();
  });
});

describe("thread rows in the sidebar", () => {
  function lastStepFocus(): string {
    const calls = vi.mocked(step).mock.calls;
    return calls[calls.length - 1][1].focus;
  }

  beforeEach(() => {
    vi.mocked(classifyFocus).mockReturnValue("sidebar");
  });

  it("uses the sidebar keys on a row reached from the keyboard", () => {
    mount();

    press();

    expect(lastStepFocus()).toBe("sidebar");
  });

  it("treats a row that was clicked as a plain link", () => {
    mount();
    vi.mocked(isSidebarRowFocusedByPointer).mockReturnValue(true);

    press();

    expect(lastStepFocus()).toBe("control");
  });

  it("leaves Escape to bb while rows are selected, and only Escape", () => {
    mount();
    vi.mocked(hasSidebarSelection).mockReturnValue(true);

    press({ key: "Escape", code: "Escape" });
    expect(lastStepFocus()).toBe("control");

    press();
    expect(lastStepFocus()).toBe("sidebar");
  });

  // On Windows and Linux Ctrl-[ is bb's shortcut for going back, and bb only
  // drops its selection of rows on Escape itself.
  it.each([
    ["while rows are selected", true],
    ["while no rows are selected", false],
  ])(
    "keeps the key that a terminal sends as Escape a key of the row %s, where the machine takes it for Escape",
    (_when, isSelected) => {
      mount();
      vi.mocked(hasSidebarSelection).mockReturnValue(isSelected);
      vi.mocked(keyStrokeFromEvent).mockReturnValue("C-[");

      press({ key: "[", code: "BracketLeft", ctrlKey: true });

      expect(lastStepFocus()).toBe("sidebar");
      expect(lastStepInput().stroke).toBe("C-[");
    },
  );

  it.each([
    ["Escape", { key: "Escape", code: "Escape" }],
    ["C-[", { key: "[", code: "BracketLeft", ctrlKey: true }],
  ])(
    "treats a row that was clicked as a plain link for %s as well, also while rows are selected",
    (stroke, init) => {
      mount();
      vi.mocked(isSidebarRowFocusedByPointer).mockReturnValue(true);
      vi.mocked(hasSidebarSelection).mockReturnValue(true);
      vi.mocked(keyStrokeFromEvent).mockReturnValue(stroke);

      press(init);

      expect(lastStepFocus()).toBe("control");
      expect(lastStepInput().stroke).toBe(stroke);
    },
  );

  it("does not look for selected rows when the cursor is not on a row", () => {
    mount();
    vi.mocked(classifyFocus).mockReturnValue("normal");
    vi.mocked(hasSidebarSelection).mockReturnValue(true);

    press({ key: "Escape", code: "Escape" });

    expect(hasSidebarSelection).not.toHaveBeenCalled();
    expect(lastStepFocus()).toBe("normal");
  });

  it("records which element each pointerdown lands on", () => {
    mount();
    const row = document.body.appendChild(document.createElement("a"));

    row.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(noteSidebarPointerDown).toHaveBeenCalledWith(row);
    row.remove();
  });
});

describe("flags of an earlier run", () => {
  function leaveFlagsBehind(): void {
    updateUiState({
      paused: true,
      helpOpen: true,
      chooser: { open: true, placement: "right" },
    });
  }

  function expectFlagsCleared(): void {
    expect(getUiState()).toMatchObject({
      paused: false,
      helpOpen: false,
      chooser: { open: false },
    });
  }

  it("are cleared when the handler mounts", () => {
    leaveFlagsBehind();

    mount();

    expectFlagsCleared();
    vi.mocked(step).mockReturnValueOnce(consumed());
    expect(press().defaultPrevented).toBe(true);
  });

  it("are cleared when the handler is disposed", () => {
    mount();
    leaveFlagsBehind();

    dispose();

    expectFlagsCleared();
  });
});

describe("prefix indicator flag", () => {
  it("follows the machine", () => {
    mount();
    expect(getUiState().prefixArmed).toBe(false);

    armPrefix();
    expect(getUiState().prefixArmed).toBe(true);

    vi.mocked(step).mockReturnValueOnce(consumed(FOCUS_LEFT));
    press({ key: "h", code: "KeyH" });
    expect(getUiState().prefixArmed).toBe(false);
  });

  it("clears when the prefix times out and resets the machine", () => {
    mount();
    armPrefix();

    vi.advanceTimersByTime(PREFIX_TIMEOUT_MS - 1);
    expect(getUiState().prefixArmed).toBe(true);

    vi.advanceTimersByTime(2);
    expect(getUiState().prefixArmed).toBe(false);
    press();
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sets no timer for a prefix-timeout that a browser timer cannot hold, which would run at once and cancel the prefix", () => {
    mount();
    const deadline = Date.now() + 2147483647;
    const state: MachineState = { pending: "prefix", deadline };
    vi.mocked(step).mockReturnValueOnce({ state, decision: "consume", actions: [] });
    const setTimer = vi.spyOn(globalThis, "setTimeout");

    press({ key: "a", code: "KeyA", ctrlKey: true });

    expect(setTimer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getUiState().prefixArmed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(getUiState().prefixArmed).toBe(true);
    press();
    expect(lastStepState()).toBe(state);
  });

  it("still sets the timer for the longest prefix-timeout that a browser timer can hold", () => {
    mount();
    const state: MachineState = { pending: "prefix", deadline: Date.now() + 2147483646 };
    vi.mocked(step).mockReturnValueOnce({ state, decision: "consume", actions: [] });
    const setTimer = vi.spyOn(globalThis, "setTimeout");

    press({ key: "a", code: "KeyA", ctrlKey: true });

    expect(setTimer).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 2147483647);
  });

  it("stays up for as long as it takes when the prefix has no time limit, as in stock tmux", () => {
    mount();
    const state: MachineState = { pending: "prefix", deadline: null };
    vi.mocked(step).mockReturnValueOnce({ state, decision: "consume", actions: [] });

    press({ key: "a", code: "KeyA", ctrlKey: true });

    expect(getUiState().prefixArmed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_600_000);
    expect(getUiState().prefixArmed).toBe(true);
    press();
    expect(lastStepState()).toBe(state);
  });

  it("names the prefix key that was pressed, which can be the second prefix", () => {
    mount();
    expect(getUiState().prefixArmedBy).toBeNull();

    vi.mocked(step).mockReturnValueOnce({
      state: armedState(),
      decision: "consume",
      actions: [],
    });
    press({ key: "C-s", code: "KeyS", ctrlKey: true });
    expect(getUiState()).toMatchObject({ prefixArmed: true, prefixArmedBy: "C-s" });

    vi.mocked(step).mockReturnValueOnce({
      state: armedState(),
      decision: "consume",
      actions: [],
    });
    press({ key: "C-a", code: "KeyA", ctrlKey: true });
    expect(getUiState().prefixArmedBy).toBe("C-a");
  });

  it("keeps naming that key for the repeat window, and no key once the window is over", () => {
    mount();
    vi.mocked(step).mockReturnValueOnce({
      state: armedState(),
      decision: "consume",
      actions: [],
    });
    press({ key: "C-s", code: "KeyS", ctrlKey: true });

    resizeWith();
    expect(getUiState()).toMatchObject({ prefixArmed: true, prefixArmedBy: "C-s" });

    vi.advanceTimersByTime(REPEAT_TIMEOUT_MS + 1);
    expect(getUiState()).toMatchObject({ prefixArmed: false, prefixArmedBy: null });
  });

  it("names no key after the key that ended the prefix", () => {
    mount();
    armPrefix();

    vi.mocked(step).mockReturnValueOnce(consumed(FOCUS_LEFT));
    press({ key: "h", code: "KeyH" });

    expect(getUiState().prefixArmedBy).toBeNull();
  });

  it("clears on window blur", () => {
    mount();
    armPrefix();

    window.dispatchEvent(new Event("blur"));

    expect(getUiState()).toMatchObject({ prefixArmed: false, prefixArmedBy: null });
    press();
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears when the document becomes hidden, not when it becomes visible", () => {
    mount();
    armPrefix();
    const visibility = vi.spyOn(document, "visibilityState", "get");

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getUiState().prefixArmed).toBe(true);

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getUiState().prefixArmed).toBe(false);
    press();
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
  });

  it("clears on any pointerdown and stops pending focus work", () => {
    mount();
    armPrefix();

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(getUiState().prefixArmed).toBe(false);
    expect(cancelPendingActionsOnPointerPress).toHaveBeenCalledTimes(1);
    expect(cancelPendingActions).not.toHaveBeenCalled();
    press();
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
  });

  it("stays up for the repeat window that follows a resize", () => {
    mount();

    resizeAfterPrefix();

    expect(getUiState().prefixArmed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("clears when the repeat window times out and resets the machine", () => {
    mount();
    resizeAfterPrefix();

    vi.advanceTimersByTime(REPEAT_TIMEOUT_MS - 1);
    expect(getUiState().prefixArmed).toBe(true);

    vi.advanceTimersByTime(2);
    expect(getUiState().prefixArmed).toBe(false);
    press();
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times the repeat window from the resize, not from the prefix", () => {
    mount();
    armPrefix();
    vi.advanceTimersByTime(PREFIX_TIMEOUT_MS - 500);
    resizeWith();

    vi.advanceTimersByTime(REPEAT_TIMEOUT_MS - 1);
    expect(getUiState().prefixArmed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(2);
    expect(getUiState().prefixArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears when another key ends the repeat window", () => {
    mount();
    resizeAfterPrefix();

    const typed = press({ key: "x", code: "KeyX" });

    expect(typed.defaultPrevented).toBe(false);
    expect(getUiState().prefixArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears on window blur during the repeat window", () => {
    mount();
    resizeAfterPrefix();

    window.dispatchEvent(new Event("blur"));

    expect(getUiState().prefixArmed).toBe(false);
    press();
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a resize that found no divider to move", () => {
  function resizeWithoutDivider(init: KeyboardEventInit = {}): KeyboardEvent {
    vi.mocked(runAction).mockReturnValueOnce(false);
    vi.mocked(step).mockReturnValueOnce({
      state: repeatState(),
      decision: "consume",
      actions: [RESIZE_RIGHT],
    });
    return press({ ...OPTION_L, ...init });
  }

  it("takes the key but opens no repeat window and shows no pill", () => {
    mount();
    armPrefix();

    const event = resizeWithoutDivider();

    expect(event.defaultPrevented).toBe(true);
    expect(runAction).toHaveBeenCalledWith(RESIZE_RIGHT);
    expect(getUiState().prefixArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands the next resize key to the machine without the window, so it is typed", () => {
    mount();
    armPrefix();
    resizeWithoutDivider();

    const typed = press(OPTION_L);

    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
    expect(typed.defaultPrevented).toBe(false);
    expect(laterListener).toHaveBeenCalledWith(typed);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("swallows the key while it is held and does not try again", () => {
    mount();
    armPrefix();
    resizeWithoutDivider();

    const repeat = press({ ...OPTION_L, repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(laterListener).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(getUiState().prefixArmed).toBe(false);
  });

  it("closes a window that is open when the divider goes away under a held key", () => {
    mount();
    resizeAfterPrefix();

    const repeat = resizeWithoutDivider({ repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(2);
    expect(getUiState().prefixArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    press(OPTION_L);
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
  });

  it("keeps the window open after a resize that had a divider", () => {
    mount();

    const repeating = resizeAfterPrefix();

    expect(getUiState().prefixArmed).toBe(true);
    press(OPTION_L);
    expect(lastStepState()).toBe(repeating);
  });

  it("leaves the state alone when another action reports nothing to act on", () => {
    mount();
    vi.mocked(runAction).mockReturnValueOnce(false);
    const armed = armedState();
    vi.mocked(step).mockReturnValueOnce({ state: armed, decision: "consume", actions: [FOCUS_LEFT] });

    press({ key: "h", code: "KeyH" });

    expect(getUiState().prefixArmed).toBe(true);
    press();
    expect(lastStepState()).toBe(armed);
  });
});

describe("pointer events the plugin dispatches itself", () => {
  it("keeps the repeat window open through the pointerdown of its own resize", () => {
    mount();
    const own = new Event("pointerdown", { bubbles: true });
    vi.mocked(isPluginSyntheticEvent).mockImplementation((event) => event === own);
    vi.mocked(runAction).mockImplementationOnce(() => {
      document.body.dispatchEvent(own);
      return true;
    });

    const repeating = resizeAfterPrefix();

    expect(isPluginSyntheticEvent).toHaveBeenCalledWith(own);
    expect(getUiState().prefixArmed).toBe(true);
    press(OPTION_L);
    expect(lastStepState()).toBe(repeating);
  });

  it("cancels no pending work, keeps copy mode and forgets no clicked row for such a pointerdown", () => {
    mount();
    armPrefix();
    copyModeActive = true;
    vi.mocked(isPluginSyntheticEvent).mockReturnValue(true);

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(cancelPendingActionsOnPointerPress).not.toHaveBeenCalled();
    expect(cancelPendingActions).not.toHaveBeenCalled();
    expect(noteSidebarPointerDown).not.toHaveBeenCalled();
    expect(exitCopyMode).not.toHaveBeenCalled();
    expect(exitCopyModeKeepingSelection).not.toHaveBeenCalled();
    expect(copyModeActive).toBe(true);
    expect(getUiState().prefixArmed).toBe(true);
  });

  it("still ends the repeat window on a pointerdown of the user", () => {
    mount();
    resizeAfterPrefix();

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(getUiState().prefixArmed).toBe(false);
    expect(cancelPendingActionsOnPointerPress).toHaveBeenCalledTimes(1);
    press(OPTION_L);
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
  });
});

describe("the switched off flag", () => {
  function switchOff(): void {
    updateUiState({ switchState: "off" });
  }

  it("ends an armed prefix at once, without a key or a mouse press", () => {
    mount();
    armPrefix();

    switchOff();

    expect(getUiState().prefixArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    press();
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
  });

  it("ends an open repeat window at once", () => {
    mount();
    resizeAfterPrefix();
    expect(getUiState().prefixArmed).toBe(true);

    switchOff();

    expect(getUiState().prefixArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    press();
    expect(lastStepState()).toBe(INITIAL_MACHINE_STATE);
  });

  it("leaves copy mode, closes the chooser and the key help, and ends a pause", () => {
    mount();
    copyModeActive = true;
    updateUiState({
      paused: true,
      helpOpen: true,
      chooser: { open: true, placement: "right" },
    });

    switchOff();

    expect(exitCopyMode).toHaveBeenCalledTimes(1);
    expect(getUiState()).toMatchObject({
      paused: false,
      helpOpen: false,
      chooser: { open: false },
      switchState: "off",
    });
  });

  it("drops what an action still waits for", () => {
    mount();

    switchOff();

    expect(cancelPendingActions).toHaveBeenCalledTimes(1);
  });

  it("forgets the key that is held, so that its repeats are not swallowed afterwards", () => {
    mount();
    vi.mocked(step).mockReturnValueOnce(consumed(SIDEBAR_DOWN));
    press();

    switchOff();
    const repeat = press({ repeat: true });

    expect(repeat.defaultPrevented).toBe(false);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("stops nothing for a change of another flag, when the flag is set to what it is, or when the settings turn out to have the plugin on", () => {
    mount();
    armPrefix();

    updateUiState({ helpOpen: true });
    updateUiState({ switchState: "unknown" });
    updateUiState({ switchState: "on" });

    expect(getUiState()).toMatchObject({ prefixArmed: true, helpOpen: true });
    expect(cancelPendingActions).not.toHaveBeenCalled();
  });

  it("stops nothing when the plugin is switched on", () => {
    updateUiState({ switchState: "off" });
    mount();
    vi.mocked(cancelPendingActions).mockClear();
    updateUiState({ helpOpen: true });

    updateUiState({ switchState: "on" });

    expect(getUiState().helpOpen).toBe(true);
    expect(cancelPendingActions).not.toHaveBeenCalled();
  });

  it("stops again the next time the plugin is switched off", () => {
    mount();
    switchOff();
    updateUiState({ switchState: "on" });
    armPrefix();

    switchOff();

    expect(getUiState().prefixArmed).toBe(false);
    expect(cancelPendingActions).toHaveBeenCalledTimes(2);
  });

  it("is left as it is by the handler, which only reads it", () => {
    updateUiState({ switchState: "off" });

    mount();
    dispose();

    expect(getUiState().switchState).toBe("off");
  });

  it("is no longer watched once the handler is disposed", () => {
    mount();
    dispose();
    vi.mocked(cancelPendingActions).mockClear();
    updateUiState({ helpOpen: true });

    switchOff();

    expect(getUiState().helpOpen).toBe(true);
    expect(cancelPendingActions).not.toHaveBeenCalled();
  });
});

describe("disposer", () => {
  function expectFullyRemoved(): void {
    expect(getUiState().prefixArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    vi.mocked(step).mockClear();
    vi.mocked(cancelPendingActions).mockClear();
    vi.mocked(cancelPendingActionsOnPointerPress).mockClear();
    vi.mocked(noteSidebarPointerDown).mockClear();
    vi.mocked(step).mockReturnValue(consumed(SIDEBAR_DOWN));
    const event = press();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(step).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(runAction).not.toHaveBeenCalled();
    expect(cancelPendingActions).not.toHaveBeenCalled();
    expect(cancelPendingActionsOnPointerPress).not.toHaveBeenCalled();
    expect(noteSidebarPointerDown).not.toHaveBeenCalled();
  }

  it("removes every listener and timer and clears the flag", () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    mount();
    armPrefix();

    dispose();

    expect(removeEventListener.mock.calls.map(([type]) => type).sort()).toEqual([
      "blur",
      "keydown",
      "pointerdown",
    ]);
    expect(removeDocumentListener.mock.calls.map(([type]) => type)).toEqual([
      "visibilitychange",
    ]);
    expect(cancelPendingActions).toHaveBeenCalledTimes(1);
    expect(noteSidebarPointerDown).toHaveBeenLastCalledWith(null);
    expectFullyRemoved();
  });

  it("is idempotent", () => {
    mount();
    armPrefix();

    dispose();
    updateUiState({ prefixArmed: true });
    expect(() => dispose()).not.toThrow();

    expect(getUiState().prefixArmed).toBe(true);
    updateUiState({ prefixArmed: false });
    expectFullyRemoved();
  });

  it("runs when the signal aborts", () => {
    mount();
    armPrefix();

    controller.abort();

    expectFullyRemoved();
    expect(() => dispose()).not.toThrow();
  });

  it("installs nothing for a signal that is already aborted", () => {
    const aborted = new AbortController();
    aborted.abort();
    const addEventListener = vi.spyOn(window, "addEventListener");

    const disposer = mountKeyHandler({
      pluginId: "tmux",
      generation: 1,
      signal: aborted.signal,
    });

    expect(addEventListener).not.toHaveBeenCalled();
    expect(() => disposer()).not.toThrow();
    press();
    expect(step).not.toHaveBeenCalled();
  });
});
