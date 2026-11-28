import { sendsPrefix } from "./keymap";
import { isChord, terminalKeyOf } from "./keys";
import type { Settings } from "./settings";
import type {
  Action,
  FocusKind,
  KeyBinding,
  Keymap,
  MachineState,
  StepInput,
  StepResult,
} from "./types";

export const INITIAL_MACHINE_STATE: MachineState = {
  pending: "none",
  deadline: null,
};

const NO_ACTIONS: readonly Action[] = [];

function pass(): StepResult {
  return { state: INITIAL_MACHINE_STATE, decision: "pass", actions: NO_ACTIONS };
}

function consume(): StepResult {
  return {
    state: INITIAL_MACHINE_STATE,
    decision: "consume",
    actions: NO_ACTIONS,
  };
}

function hasExpired(state: MachineState, now: number): boolean {
  return state.deadline !== null && now > state.deadline;
}

function findKeyBinding(
  bindings: readonly KeyBinding[],
  stroke: string,
): KeyBinding | undefined {
  return bindings.find((binding) => binding.key === stroke);
}

function isPrefixKey(keymap: Keymap, stroke: string): boolean {
  return stroke === keymap.prefix || stroke === keymap.prefix2;
}

// The keymap only keeps a send-prefix on the prefix key itself, and that key
// press is what gets sent: it goes on to the focused element.
function runBinding(binding: KeyBinding, state: MachineState): StepResult {
  return {
    state,
    decision: sendsPrefix(binding) ? "pass" : "consume",
    actions: binding.actions,
  };
}

// As in tmux: a prefix-timeout of 0 lets the prefix wait until a key comes.
function armPrefix(now: number, keymap: Keymap): StepResult {
  const deadline =
    keymap.prefixTimeoutMs > 0 ? now + keymap.prefixTimeoutMs : null;
  return {
    state: { pending: "prefix", deadline },
    decision: "consume",
    actions: NO_ACTIONS,
  };
}

// As in tmux: a key bound with -r opens the repeat window, unless repeat-time
// is 0.
function runPrefixBinding(
  binding: KeyBinding,
  now: number,
  keymap: Keymap,
): StepResult {
  const repeats = binding.repeat && keymap.repeatTimeMs > 0;
  if (!repeats) return runBinding(binding, INITIAL_MACHINE_STATE);
  return runBinding(binding, {
    pending: "repeat",
    deadline: now + keymap.repeatTimeMs,
  });
}

// A pane in copy mode looks the key that send-prefix sends up in its copy
// table. So the key is taken here and runs what the copy table binds it to,
// in the place of the send-prefix.
function sendIntoCopyMode(result: StepResult, copy: KeyBinding): StepResult {
  return {
    state: result.state,
    decision: "consume",
    actions: result.actions.flatMap((action) =>
      action.type === "prefix.send" ? copy.actions : [action],
    ),
  };
}

// tmux tries a key that the prefix table does not have in the root table,
// where a prefix key arms the prefix again (server_client_key_callback in
// server-client.c). A key that neither table has ends the prefix and is not
// passed on.
function stepUnboundAfterPrefix(input: StepInput, keymap: Keymap): StepResult {
  if (isPrefixKey(keymap, input.stroke)) return armPrefix(input.now, keymap);
  const root = findKeyBinding(keymap.rootBindings, input.stroke);
  if (root === undefined) return consume();
  return runBinding(root, INITIAL_MACHINE_STATE);
}

function stepAfterPrefix(
  input: StepInput,
  keymap: Keymap,
  isInCopyMode: boolean,
): StepResult {
  const binding = findKeyBinding(keymap.prefixBindings, input.stroke);
  if (binding === undefined) return stepUnboundAfterPrefix(input, keymap);
  const result = runPrefixBinding(binding, input.now, keymap);
  if (!isInCopyMode) return result;
  const copy = findKeyBinding(keymap.sentCopyBindings, input.stroke);
  return copy === undefined ? result : sendIntoCopyMode(result, copy);
}

// The key that moves to the pane on the left can end on a thread row of the
// sidebar, and tmux binds it with -r. The list keys come first there, or the
// first key on the row would be taken for a pane move.
function findRepeatableBinding(
  keymap: Keymap,
  input: StepInput,
): KeyBinding | undefined {
  const isListKey =
    input.focus === "sidebar" &&
    findKeyBinding(keymap.sidebarBindings, input.stroke) !== undefined;
  if (isListKey) return undefined;
  const binding = findKeyBinding(keymap.prefixBindings, input.stroke);
  return binding?.repeat === true ? binding : undefined;
}

// The stroke of a character does not say whether Shift was held, and with
// Caps Lock on, Shift can type the lowercase letter. A plain key only counts
// without Shift.
function stepPlain(input: StepInput, keymap: Keymap): StepResult {
  if (input.shift) return pass();
  const binding = findKeyBinding(keymap.plainBindings, input.stroke);
  return binding === undefined
    ? pass()
    : runBinding(binding, INITIAL_MACHINE_STATE);
}

// The key that a thread row of the sidebar takes the stroke for: the stroke
// itself when it is a key of the row, and otherwise the key that a terminal
// sends for it, so that Ctrl-[ is Escape and Ctrl-m is Enter there.
function sidebarKeyOf(keymap: Keymap, stroke: string): string {
  if (findKeyBinding(keymap.sidebarBindings, stroke) !== undefined) return stroke;
  return terminalKeyOf(stroke) ?? stroke;
}

function stepSidebar(input: StepInput, keymap: Keymap): StepResult {
  const key = sidebarKeyOf(keymap, input.stroke);
  const binding = findKeyBinding(keymap.sidebarBindings, key);
  if (binding === undefined) return stepPlain(input, keymap);
  return runBinding(binding, INITIAL_MACHINE_STATE);
}

// Copy mode takes every plain key, so that none of them reaches bb, nor a
// button that bb has given the focus since. A shortcut with Ctrl, Alt or Cmd
// that tmux has not bound in copy mode is passed on. Ctrl-[, Ctrl-m and
// Ctrl-i are Escape, Enter and Tab to a terminal, so here each of them runs
// what the copy table binds that key to, and is taken as that plain key is.
function stepUnboundInCopyMode(input: StepInput, keymap: Keymap): StepResult {
  const key = terminalKeyOf(input.stroke);
  if (key === null) return isChord(input.stroke) ? pass() : consume();
  const copy = findKeyBinding(keymap.copyBindings, key);
  return copy === undefined ? consume() : runBinding(copy, INITIAL_MACHINE_STATE);
}

// The focus is on a pane and not in a text field, a list or a dialog.
export function isOnPane(focus: FocusKind): boolean {
  return focus === "normal" || focus === "control";
}

// Inside the repeat window a key bound with -r comes first, also when it is
// the prefix key, as in tmux (server_client_key_callback in server-client.c
// does not test for the prefix while the prefix table is the current one).
// Then the prefix key, the table of copy mode, the root table, and the keys
// of a list only after that. A key that stands in for
// another one, as Ctrl-[ does for Escape, comes after the keys that are
// bound themselves, and never after the prefix or in the root table.
export function step(
  state: MachineState,
  input: StepInput,
  keymap: Keymap,
  settings: Settings,
): StepResult {
  if (!settings.enabled) return pass();
  if (input.focus === "overlay" || input.focus === "frame") return pass();

  const current = hasExpired(state, input.now) ? INITIAL_MACHINE_STATE : state;
  const onPane = isOnPane(input.focus);
  const isInCopyMode = input.copyMode && onPane;
  if (current.pending === "prefix") {
    return stepAfterPrefix(input, keymap, isInCopyMode);
  }
  if (current.pending === "repeat") {
    const repeated = findRepeatableBinding(keymap, input);
    if (repeated !== undefined) {
      return runPrefixBinding(repeated, input.now, keymap);
    }
  }
  if (isPrefixKey(keymap, input.stroke)) return armPrefix(input.now, keymap);
  if (isInCopyMode) {
    const copy = findKeyBinding(keymap.copyBindings, input.stroke);
    if (copy !== undefined) return runBinding(copy, INITIAL_MACHINE_STATE);
  }
  const root = findKeyBinding(keymap.rootBindings, input.stroke);
  if (root !== undefined) return runBinding(root, INITIAL_MACHINE_STATE);
  if (input.focus === "sidebar") return stepSidebar(input, keymap);
  if (!onPane) return pass();
  if (isInCopyMode) return stepUnboundInCopyMode(input, keymap);
  return stepPlain(input, keymap);
}

export function isPrefixArmed(state: MachineState, now: number): boolean {
  return state.pending === "prefix" && !hasExpired(state, now);
}

export function isRepeatWindowOpen(state: MachineState, now: number): boolean {
  return state.pending === "repeat" && !hasExpired(state, now);
}
