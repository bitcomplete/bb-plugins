import { describe, expect, it } from "vitest";
import { buildKeymap } from "./keymap";
import {
  INITIAL_MACHINE_STATE,
  isPrefixArmed,
  isRepeatWindowOpen,
  step,
} from "./machine";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import { stockTmuxConfig } from "./tmux-keymap";
import { VI_STYLE_CONFIG, tmuxConfigOf } from "./tmux-test-support";
import type {
  Action,
  CopyMotion,
  Direction,
  FocusKind,
  Keymap,
  MachineState,
  StepInput,
  StepResult,
} from "./types";

const NOW = 10_000;
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, enabled: true };
const STOCK = buildKeymap(stockTmuxConfig());
const VI_STYLE = buildKeymap(tmuxConfigOf(VI_STYLE_CONFIG));
const STOCK_REPEAT_TIME_MS = 500;

const PASSED: StepResult = {
  state: INITIAL_MACHINE_STATE,
  decision: "pass",
  actions: [],
};

const CONSUMED: StepResult = {
  state: INITIAL_MACHINE_STATE,
  decision: "consume",
  actions: [],
};

const ARMED: MachineState = { pending: "prefix", deadline: null };

const PREFIX_TIMEOUT_MS = 800;
const PREFIX_TIMEOUT_CONFIG = `set -g prefix-timeout ${PREFIX_TIMEOUT_MS}`;
const ARMED_FOR_A_TIME: MachineState = {
  pending: "prefix",
  deadline: NOW + PREFIX_TIMEOUT_MS,
};

const REPEATING: MachineState = {
  pending: "repeat",
  deadline: NOW + STOCK_REPEAT_TIME_MS,
};

const HANDLED_FOCUS_KINDS: FocusKind[] = [
  "typing",
  "sidebar",
  "control",
  "normal",
];

const PANE_FOCUS_KINDS: FocusKind[] = ["normal", "control"];

interface Scenario {
  shift?: boolean;
  focus?: FocusKind;
  copyMode?: boolean;
  now?: number;
  settings?: Settings;
  keymap?: Keymap;
}

function keymapOf(text: string): Keymap {
  return buildKeymap(tmuxConfigOf(text));
}

function press(
  state: MachineState,
  stroke: string,
  scenario: Scenario = {},
): StepResult {
  const input: StepInput = {
    stroke,
    shift: scenario.shift ?? false,
    focus: scenario.focus ?? "normal",
    copyMode: scenario.copyMode ?? false,
    now: scenario.now ?? NOW,
  };
  return step(state, input, scenario.keymap ?? STOCK, scenario.settings ?? SETTINGS);
}

function pressAll(strokes: string[], scenario: Scenario = {}): StepResult {
  let result: StepResult = PASSED;
  for (const stroke of strokes) {
    result = press(result.state, stroke, scenario);
  }
  return result;
}

function consumed(...actions: Action[]): StepResult {
  return { state: INITIAL_MACHINE_STATE, decision: "consume", actions };
}

function repeated(
  action: Action,
  now = NOW,
  repeatTimeMs = STOCK_REPEAT_TIME_MS,
): StepResult {
  return {
    state: { pending: "repeat", deadline: now + repeatTimeMs },
    decision: "consume",
    actions: [action],
  };
}

function focus(direction: Direction): Action {
  return { type: "pane.focus", direction };
}

function resize(direction: Direction, cells: number): Action {
  return { type: "pane.resize", direction, cells };
}

function move(motion: CopyMotion): Action {
  return { type: "copy.move", motion };
}

const VI: Scenario = { keymap: VI_STYLE };
const IN_COPY_MODE: Scenario = { copyMode: true };
const IN_VI_COPY_MODE: Scenario = { keymap: VI_STYLE, copyMode: true };

describe("step: the prefix", () => {
  it.each(HANDLED_FOCUS_KINDS)("arms on tmux's own prefix in %s focus", (focusKind) => {
    expect(press(INITIAL_MACHINE_STATE, "C-b", { focus: focusKind })).toEqual({
      state: ARMED,
      decision: "consume",
      actions: [],
    });
  });

  it("arms on the prefix of the tmux config, and no longer on tmux's own", () => {
    expect(press(INITIAL_MACHINE_STATE, "C-a", VI).state).toEqual(ARMED);
    expect(press(INITIAL_MACHINE_STATE, "C-b", VI)).toEqual(PASSED);
  });

  it("waits for the next key for as long as it takes, as stock tmux does", () => {
    const anHourLater = NOW + 3_600_000;

    expect(press(INITIAL_MACHINE_STATE, "C-b").state).toEqual({
      pending: "prefix",
      deadline: null,
    });
    expect(press(ARMED, "c", { now: anHourLater })).toEqual(
      consumed({ type: "thread.new" }),
    );
  });

  it("waits for the prefix-timeout of the tmux config", () => {
    const keymap = keymapOf(PREFIX_TIMEOUT_CONFIG);

    expect(press(INITIAL_MACHINE_STATE, "C-b", { keymap }).state).toEqual(
      ARMED_FOR_A_TIME,
    );
  });

  it("waits without a limit again with a prefix-timeout of 0", () => {
    const keymap = keymapOf(`${PREFIX_TIMEOUT_CONFIG}\nset -g prefix-timeout 0`);

    expect(press(INITIAL_MACHINE_STATE, "C-b", { keymap }).state).toEqual(ARMED);
  });

  it("still honours the prefix exactly at its deadline, and forgets it after", () => {
    const keymap = keymapOf(PREFIX_TIMEOUT_CONFIG);
    const deadline = NOW + PREFIX_TIMEOUT_MS;

    expect(press(ARMED_FOR_A_TIME, "c", { keymap, now: deadline })).toEqual(
      consumed({ type: "thread.new" }),
    );
    expect(press(ARMED_FOR_A_TIME, "c", { keymap, now: deadline + 1 })).toEqual(PASSED);
  });

  it("arms again when the prefix key comes after an expired prefix", () => {
    const keymap = keymapOf(PREFIX_TIMEOUT_CONFIG);
    const later = NOW + PREFIX_TIMEOUT_MS + 1;

    expect(press(ARMED_FOR_A_TIME, "C-b", { keymap, now: later }).state).toEqual({
      pending: "prefix",
      deadline: later + PREFIX_TIMEOUT_MS,
    });
  });

  it("is over after one key", () => {
    expect(pressAll(["C-b", "c", "c"])).toEqual(PASSED);
  });

  it("wins over a copy-mode key and a list key on the same key", () => {
    expect(press(INITIAL_MACHINE_STATE, "C-b", IN_COPY_MODE).state).toEqual(ARMED);
    expect(press(INITIAL_MACHINE_STATE, "C-b", { focus: "sidebar" }).state).toEqual(ARMED);
  });

  it.each(["overlay", "frame"] as const)(
    "passes the prefix and drops an armed one in %s focus",
    (focusKind) => {
      expect(press(INITIAL_MACHINE_STATE, "C-b", { focus: focusKind })).toEqual(PASSED);
      expect(press(ARMED, "c", { focus: focusKind })).toEqual(PASSED);
    },
  );

  it("is switched off by the default settings", () => {
    expect(press(INITIAL_MACHINE_STATE, "C-b", { settings: DEFAULT_SETTINGS })).toEqual(PASSED);
    expect(press(ARMED, "c", { settings: DEFAULT_SETTINGS })).toEqual(PASSED);
  });

  it("passes everything and drops an armed prefix while the plugin is switched off", () => {
    const settings = { ...SETTINGS, enabled: false };

    expect(press(INITIAL_MACHINE_STATE, "C-b", { settings })).toEqual(PASSED);
    expect(press(ARMED, "c", { settings })).toEqual(PASSED);
    expect(press(INITIAL_MACHINE_STATE, "j", { settings, focus: "sidebar" })).toEqual(PASSED);
    expect(press(INITIAL_MACHINE_STATE, "i", { settings })).toEqual(PASSED);
  });
});

describe("step: the second prefix", () => {
  const keymap = keymapOf("set -g prefix2 C-s\nbind C-s send-prefix -2");
  const scenario: Scenario = { keymap };

  it("arms the same table as the prefix", () => {
    expect(press(INITIAL_MACHINE_STATE, "C-s", scenario).state).toEqual(ARMED);
    expect(pressAll(["C-s", "c"], scenario)).toEqual(consumed({ type: "thread.new" }));
    expect(pressAll(["C-b", "c"], scenario)).toEqual(consumed({ type: "thread.new" }));
  });

  it("is sent on by the key that is bound to send-prefix -2", () => {
    expect(pressAll(["C-s", "C-s"], scenario)).toEqual({
      state: INITIAL_MACHINE_STATE,
      decision: "pass",
      actions: [{ type: "prefix.send", second: true }],
    });
  });

  it("is an ordinary key without the option", () => {
    expect(press(INITIAL_MACHINE_STATE, "C-s")).toEqual(PASSED);
  });
});

describe("step: stock tmux after the prefix", () => {
  it.each<[string, Action]>([
    ["o", { type: "pane.next" }],
    [";", { type: "pane.last" }],
    ["%", { type: "chooser.open", placement: "right" }],
    ['"', { type: "chooser.open", placement: "down" }],
    ["x", { type: "pane.close" }],
    ["z", { type: "pane.zoom" }],
    ["[", { type: "copy.enter", motion: null }],
    ["PageUp", { type: "copy.enter", motion: "page-up" }],
    ["c", { type: "thread.new" }],
    ["n", { type: "thread.cycle", delta: 1 }],
    ["p", { type: "thread.cycle", delta: -1 }],
    ["l", { type: "thread.last" }],
    ["0", { type: "thread.jump", index: 1 }],
    ["1", { type: "thread.jump", index: 2 }],
    ["9", { type: "thread.jump", index: 10 }],
    ["w", { type: "chooser.open", placement: "replace" }],
    ["s", { type: "chooser.open", placement: "replace" }],
    ["?", { type: "help.open" }],
  ])("runs %s", (stroke, action) => {
    expect(pressAll(["C-b", stroke])).toEqual(consumed(action));
  });

  it.each<[string, Action]>([
    ["ArrowUp", focus("up")],
    ["ArrowDown", focus("down")],
    ["ArrowLeft", focus("left")],
    ["ArrowRight", focus("right")],
    ["M-ArrowUp", resize("up", 5)],
    ["M-ArrowDown", resize("down", 5)],
    ["M-ArrowLeft", resize("left", 5)],
    ["M-ArrowRight", resize("right", 5)],
    ["C-ArrowUp", resize("up", 1)],
    ["C-ArrowDown", resize("down", 1)],
    ["C-ArrowLeft", resize("left", 1)],
    ["C-ArrowRight", resize("right", 1)],
  ])("runs %s and opens the repeat window, as tmux binds it with -r", (stroke, action) => {
    expect(pressAll(["C-b", stroke])).toEqual(repeated(action));
  });

  it("sends the prefix on when it is pressed twice, because tmux binds C-b to send-prefix", () => {
    expect(pressAll(["C-b", "C-b"])).toEqual({
      state: INITIAL_MACHINE_STATE,
      decision: "pass",
      actions: [{ type: "prefix.send", second: false }],
    });
  });

  it.each(HANDLED_FOCUS_KINDS)("runs the keys in %s focus", (focusKind) => {
    expect(press(ARMED, "c", { focus: focusKind })).toEqual(
      consumed({ type: "thread.new" }),
    );
  });

  it.each(["Escape", "a", "h", "j", "k", "v", "y", "Enter", "Tab", "C-x", "M-h", "F5"])(
    "swallows %s, which tmux does not bind, and ends the prefix",
    (stroke) => {
      expect(press(ARMED, stroke)).toEqual(CONSUMED);
    },
  );

  it.each(["d", ":", "Space", "!", "&", ",", "]", "{", "t", "q", "i", "M-1", "C-o"])(
    "swallows %s, which tmux binds to a command bb has no equivalent for",
    (stroke) => {
      expect(press(ARMED, stroke)).toEqual(CONSUMED);
    },
  );

  it("opens the repeat window after a key bound with -r, also when bb has no equivalent for its command", () => {
    expect(press(ARMED, "S-ArrowUp")).toEqual({
      state: REPEATING,
      decision: "consume",
      actions: [],
    });
  });

  it("gives the prefix keys priority over the copy-mode keys and the list keys", () => {
    expect(press(ARMED, "q", IN_COPY_MODE)).toEqual(CONSUMED);
    expect(press(ARMED, "n", { focus: "sidebar" })).toEqual(
      consumed({ type: "thread.cycle", delta: 1 }),
    );
  });

  it("passes every prefix key that comes without the prefix", () => {
    for (const stroke of ["c", "o", "x", "%", "0", "ArrowUp", "M-ArrowUp", "?"]) {
      expect(press(INITIAL_MACHINE_STATE, stroke)).toEqual(PASSED);
    }
  });
});

describe("step: a tmux config in the vi style after the prefix", () => {
  it.each<[string, Action]>([
    ["h", focus("left")],
    ["j", focus("down")],
    ["k", focus("up")],
    ["l", focus("right")],
    ["v", { type: "chooser.open", placement: "right" }],
    ["s", { type: "chooser.open", placement: "down" }],
    ["%", { type: "chooser.open", placement: "right" }],
    ["1", { type: "thread.jump", index: 1 }],
    ["9", { type: "thread.jump", index: 9 }],
    ["w", { type: "chooser.open", placement: "replace" }],
    ["c", { type: "thread.new" }],
  ])("runs %s", (stroke, action) => {
    expect(pressAll(["C-a", stroke], VI)).toEqual(consumed(action));
  });

  it("runs both commands of the reload key, in their order", () => {
    expect(pressAll(["C-a", "r"], VI)).toEqual(
      consumed(
        { type: "config.reload" },
        { type: "notice.show", text: "Config reloaded" },
      ),
    );
  });

  it("sends the prefix on from the key that the config binds to send-prefix", () => {
    expect(pressAll(["C-a", "C-a"], VI)).toEqual({
      state: INITIAL_MACHINE_STATE,
      decision: "pass",
      actions: [{ type: "prefix.send", second: false }],
    });
  });

  it("does nothing for C-b, which the config unbinds, and for 0, which is no window with base-index 1", () => {
    expect(pressAll(["C-a", "C-b"], VI)).toEqual(CONSUMED);
    expect(pressAll(["C-a", "0"], VI)).toEqual(CONSUMED);
  });

  it("keeps the prefix armed when it is pressed twice and no key is bound to send-prefix, as tmux does", () => {
    const keymap = keymapOf("set -g prefix C-a\nunbind C-b");

    expect(pressAll(["C-a", "C-a"], { keymap })).toEqual({
      state: ARMED,
      decision: "consume",
      actions: [],
    });
    expect(pressAll(["C-a", "C-a", "c"], { keymap })).toEqual(
      consumed({ type: "thread.new" }),
    );
  });

  it("starts the prefix-timeout anew when the prefix is pressed again", () => {
    const keymap = keymapOf(`set -g prefix C-a\nunbind C-b\n${PREFIX_TIMEOUT_CONFIG}`);
    const later = NOW + 500;

    expect(press(ARMED_FOR_A_TIME, "C-a", { keymap, now: later }).state).toEqual({
      pending: "prefix",
      deadline: later + PREFIX_TIMEOUT_MS,
    });
  });

  it("opens the repeat window for the resize keys of the config", () => {
    expect(pressAll(["C-a", "M-h"], VI)).toEqual(repeated(resize("left", 5)));
  });
});

describe("step: the repeat window", () => {
  it("runs a key bound with -r without the prefix, and opens the window anew", () => {
    const later = NOW + 300;

    expect(press(REPEATING, "ArrowDown", { now: later })).toEqual(
      repeated(focus("down"), later),
    );
  });

  it("runs any key bound with -r in the window, not only the one that opened it", () => {
    expect(press(REPEATING, "M-ArrowLeft")).toEqual(repeated(resize("left", 5)));
    expect(press(REPEATING, "C-ArrowRight")).toEqual(repeated(resize("right", 1)));
  });

  it("keeps going for as long as each key comes in time", () => {
    let result = pressAll(["C-b", "ArrowUp"]);
    for (let presses = 1; presses <= 5; presses += 1) {
      const now = NOW + presses * STOCK_REPEAT_TIME_MS;
      result = press(result.state, "ArrowUp", { now });
      expect(result).toEqual(repeated(focus("up"), now));
    }
  });

  it("still honours the window exactly at repeat-time, and is over after it", () => {
    const deadline = NOW + STOCK_REPEAT_TIME_MS;

    expect(press(REPEATING, "ArrowUp", { now: deadline })).toEqual(
      repeated(focus("up"), deadline),
    );
    expect(press(REPEATING, "ArrowUp", { now: deadline + 1 })).toEqual(PASSED);
  });

  it("lasts as long as the repeat-time of the config", () => {
    const keymap = keymapOf("set -g repeat-time 1500");
    const opened = pressAll(["C-b", "ArrowUp"], { keymap });

    expect(opened).toEqual(repeated(focus("up"), NOW, 1500));
    expect(press(opened.state, "ArrowUp", { keymap, now: NOW + 1500 }).actions).toEqual([
      focus("up"),
    ]);
    expect(press(opened.state, "ArrowUp", { keymap, now: NOW + 1501 })).toEqual(PASSED);
  });

  it("does not open with repeat-time 0", () => {
    const keymap = keymapOf("set -g repeat-time 0");

    expect(pressAll(["C-b", "ArrowUp"], { keymap })).toEqual(consumed(focus("up")));
  });

  it("does not open after a key that is not bound with -r", () => {
    expect(pressAll(["C-b", "o"])).toEqual(consumed({ type: "pane.next" }));
    expect(pressAll(["C-b", "o", "o"])).toEqual(PASSED);
  });

  it("lets a key of the config bound with -r repeat, and one bound without it not", () => {
    const keymap = keymapOf("bind -r n next-window\nbind Up select-pane -U");

    expect(pressAll(["C-b", "n", "n"], { keymap })).toEqual(
      repeated({ type: "thread.cycle", delta: 1 }),
    );
    expect(pressAll(["C-b", "ArrowUp", "ArrowUp"], { keymap })).toEqual(PASSED);
  });

  it("ends on any other key, which then does what it does without the window", () => {
    expect(press(REPEATING, "c")).toEqual(PASSED);
    expect(press(REPEATING, "i")).toEqual(consumed({ type: "composer.focus" }));
    expect(press(REPEATING, "j", { focus: "sidebar" })).toEqual(
      consumed({ type: "sidebar.move", delta: 1 }),
    );
    expect(pressAll(["C-b", "ArrowUp", "x", "ArrowUp"])).toEqual(PASSED);
  });

  it.each(["typing", "control", "normal"] as const)("works in %s focus", (focusKind) => {
    expect(press(REPEATING, "ArrowUp", { focus: focusKind })).toEqual(
      repeated(focus("up")),
    );
  });

  it("lets the list keys come first on a thread row of the sidebar, which the key for the pane on the left can end on", () => {
    const onRow: Scenario = { focus: "sidebar" };

    expect(press(REPEATING, "ArrowDown", onRow)).toEqual(
      consumed({ type: "sidebar.move", delta: 1 }),
    );
    expect(press(REPEATING, "ArrowUp", onRow)).toEqual(
      consumed({ type: "sidebar.move", delta: -1 }),
    );
    expect(press(REPEATING, "ArrowRight", onRow)).toEqual(repeated(focus("right")));
    expect(press(REPEATING, "M-ArrowLeft", onRow)).toEqual(repeated(resize("left", 5)));
  });

  it("arms the prefix on the prefix key inside the window", () => {
    expect(press(REPEATING, "C-b").state).toEqual(ARMED);
  });

  it("repeats a prefix key that is bound with -r inside the window, as tmux does", () => {
    const keymap = keymapOf("set -g prefix C-a\nunbind C-b\nbind -r C-a next-window");
    const next: Action = { type: "thread.cycle", delta: 1 };
    const scenario: Scenario = { keymap, focus: "typing" };

    const armed = press(INITIAL_MACHINE_STATE, "C-a", scenario);
    const first = press(armed.state, "C-a", scenario);
    const second = press(first.state, "C-a", scenario);
    const third = press(second.state, "C-a", scenario);

    expect(armed.state).toEqual(ARMED);
    expect([first, second, third]).toEqual([repeated(next), repeated(next), repeated(next)]);
    expect(press(third.state, "C-a", { ...scenario, now: NOW + STOCK_REPEAT_TIME_MS + 1 }).state).toEqual(
      ARMED,
    );
  });

  it("arms the prefix on a prefix key that is bound without -r inside the window", () => {
    const keymap = keymapOf("set -g prefix C-a\nunbind C-b\nbind C-a next-window");

    expect(press(REPEATING, "C-a", { keymap }).state).toEqual(ARMED);
  });

  it.each(["overlay", "frame"] as const)("passes everything in %s focus", (focusKind) => {
    expect(press(REPEATING, "ArrowUp", { focus: focusKind })).toEqual(PASSED);
  });
});

describe("step: keys of the root table", () => {
  const keymap = keymapOf(
    [
      "bind -n M-Left select-pane -L",
      "bind -n F5 new-window",
      "bind -n h select-pane -L",
      "bind -n C-k clear-history",
    ].join("\n"),
  );
  const scenario: Scenario = { keymap };

  it.each(HANDLED_FOCUS_KINDS)(
    "runs a root key with a modifier without the prefix in %s focus",
    (focusKind) => {
      expect(press(INITIAL_MACHINE_STATE, "M-ArrowLeft", { keymap, focus: focusKind })).toEqual(
        consumed(focus("left")),
      );
    },
  );

  it("runs a root key that is a function key", () => {
    expect(press(INITIAL_MACHINE_STATE, "F5", scenario)).toEqual(
      consumed({ type: "thread.new" }),
    );
  });

  it.each(HANDLED_FOCUS_KINDS)(
    "passes a plain key that the config binds in the root table in %s focus",
    (focusKind) => {
      expect(press(INITIAL_MACHINE_STATE, "h", { keymap, focus: focusKind })).toEqual(PASSED);
    },
  );

  it("passes a root key whose command bb has no equivalent for", () => {
    expect(press(INITIAL_MACHINE_STATE, "C-k", scenario)).toEqual(PASSED);
    expect(press(INITIAL_MACHINE_STATE, "C-k", { keymap, focus: "typing" })).toEqual(PASSED);
  });

  it.each(["overlay", "frame"] as const)("passes a root key in %s focus", (focusKind) => {
    expect(press(INITIAL_MACHINE_STATE, "M-ArrowLeft", { keymap, focus: focusKind })).toEqual(
      PASSED,
    );
  });

  it("runs a root key in copy mode when the copy table does not bind the key", () => {
    expect(press(INITIAL_MACHINE_STATE, "F5", { keymap, copyMode: true })).toEqual(
      consumed({ type: "thread.new" }),
    );
  });

  it("lets the copy table come first in copy mode", () => {
    const both = keymapOf("bind -n M-Up select-pane -U");

    expect(press(INITIAL_MACHINE_STATE, "M-ArrowUp", { keymap: both })).toEqual(
      consumed(focus("up")),
    );
    expect(press(INITIAL_MACHINE_STATE, "M-ArrowUp", { keymap: both, copyMode: true })).toEqual(
      consumed(move("half-page-up")),
    );
  });

  it("comes before the list keys on a thread row of the sidebar", () => {
    const withList = keymapOf("bind -n C-n next-window");

    expect(press(INITIAL_MACHINE_STATE, "C-n", { keymap: withList, focus: "sidebar" })).toEqual(
      consumed({ type: "thread.cycle", delta: 1 }),
    );
  });

  it("runs after the prefix when the prefix table does not bind the key, as tmux then tries the root table", () => {
    const withLetter = keymapOf("bind -n M-h select-pane -L");

    expect(press(ARMED, "F5", scenario)).toEqual(consumed({ type: "thread.new" }));
    expect(press(ARMED, "M-h", { keymap: withLetter, focus: "typing" })).toEqual(
      consumed(focus("left")),
    );
  });

  it("gives way to the prefix table after the prefix", () => {
    const both = keymapOf("bind -n F5 new-window\nbind F5 kill-pane");

    expect(press(ARMED, "F5", { keymap: both })).toEqual(
      consumed({ type: "pane.close" }),
    );
  });

  it.each(["C-k", "h"])(
    "swallows %s after the prefix, which is no root key that bb can run",
    (stroke) => {
      expect(press(ARMED, stroke, scenario)).toEqual(CONSUMED);
    },
  );
});

describe("step: send-prefix while the pane is in copy mode", () => {
  const sent = (text: string): Scenario => ({
    keymap: keymapOf(text),
    copyMode: true,
  });

  it("runs what the emacs table binds the prefix key to, in the place of sending the key", () => {
    expect(pressAll(["C-b", "C-b"], IN_COPY_MODE)).toEqual(
      consumed(move("char-left")),
    );
  });

  it("runs what the vi table binds the prefix key to", () => {
    expect(pressAll(["C-b", "C-b"], sent("setw -g mode-keys vi"))).toEqual(
      consumed(move("page-up")),
    );
  });

  it("starts a selection with a prefix of C-Space, the only key the emacs table has for it", () => {
    const scenario = sent("set -g prefix C-Space\nbind C-Space send-prefix");

    expect(pressAll(["C-Space", "C-Space"], scenario)).toEqual(
      consumed({ type: "copy.beginSelection" }),
    );
  });

  it("does the same for the second prefix and send-prefix -2", () => {
    const scenario = sent("set -g prefix2 C-a\nbind C-a send-prefix -2");

    expect(pressAll(["C-a", "C-a"], scenario)).toEqual(consumed(move("line-start")));
    expect(pressAll(["C-b", "C-a"], scenario)).toEqual(consumed(move("line-start")));
  });

  it("keeps the other commands of the key in their place", () => {
    const scenario = sent('bind C-b display "one" \\; send-prefix \\; display "two"');

    expect(pressAll(["C-b", "C-b"], scenario)).toEqual(
      consumed(
        { type: "notice.show", text: "one" },
        move("char-left"),
        { type: "notice.show", text: "two" },
      ),
    );
  });

  it("swallows the key when the copy table binds it to a command bb has no equivalent for", () => {
    const scenario = sent("set -g prefix C-s\nbind C-s send-prefix");

    expect(pressAll(["C-s", "C-s"], scenario)).toEqual(CONSUMED);
  });

  it("passes the key on when the copy table does not bind it", () => {
    const scenario = sent("set -g prefix C-x\nbind C-x send-prefix");

    expect(pressAll(["C-x", "C-x"], scenario)).toEqual({
      state: INITIAL_MACHINE_STATE,
      decision: "pass",
      actions: [{ type: "prefix.send", second: false }],
    });
  });

  it("only arms the prefix again when no key is bound to send-prefix", () => {
    const scenario = sent("set -g prefix C-Space\nunbind C-b");

    expect(pressAll(["C-Space", "C-Space"], scenario)).toEqual({
      state: ARMED,
      decision: "consume",
      actions: [],
    });
  });

  it.each(["typing", "sidebar"] as const)(
    "passes the key on in %s focus, where the pane does not get it",
    (focusKind) => {
      expect(pressAll(["C-b", "C-b"], { copyMode: true, focus: focusKind })).toEqual({
        state: INITIAL_MACHINE_STATE,
        decision: "pass",
        actions: [{ type: "prefix.send", second: false }],
      });
    },
  );
});

describe("step: copy mode with tmux's emacs keys", () => {
  it.each<[string, Action]>([
    ["C-Space", { type: "copy.beginSelection" }],
    ["C-g", { type: "copy.clearSelection" }],
    ["C-w", { type: "copy.yank", after: "exit" }],
    ["M-w", { type: "copy.yank", after: "exit" }],
    ["q", { type: "copy.exit" }],
    ["Escape", { type: "copy.exit" }],
    ["C-c", { type: "copy.exit" }],
    ["C-f", move("char-right")],
    ["ArrowLeft", move("char-left")],
    ["C-n", move("line-down")],
    ["C-p", move("line-up")],
    ["C-a", move("line-start")],
    ["C-e", move("line-end")],
    ["M-f", move("word-end")],
    ["M-b", move("word-back")],
    ["M-m", move("line-indent")],
    ["M-<", move("document-start")],
    ["M->", move("document-end")],
    ["M-S-r", move("screen-top")],
    ["M-r", move("screen-middle")],
    ["M-{", move("paragraph-back")],
    ["M-}", move("paragraph-forward")],
    ["C-v", move("page-down")],
    ["Space", move("page-down")],
    ["M-v", move("page-up")],
    ["PageUp", move("page-up")],
    ["M-ArrowUp", move("half-page-up")],
    ["M-ArrowDown", move("half-page-down")],
    ["C-ArrowUp", { type: "copy.scroll", direction: -1 }],
    ["C-ArrowDown", { type: "copy.scroll", direction: 1 }],
  ])("runs %s", (stroke, action) => {
    expect(press(INITIAL_MACHINE_STATE, stroke, IN_COPY_MODE)).toEqual(consumed(action));
  });

  it.each(PANE_FOCUS_KINDS)("runs the keys in %s focus", (focusKind) => {
    expect(press(INITIAL_MACHINE_STATE, "q", { copyMode: true, focus: focusKind })).toEqual(
      consumed({ type: "copy.exit" }),
    );
  });

  it.each(["h", "j", "v", "y", "Enter", "a", "1", "Tab", "/", "F5", "i"])(
    "swallows the plain key %s, which the emacs table does not bind, so that it is not typed",
    (stroke) => {
      expect(press(INITIAL_MACHINE_STATE, stroke, IN_COPY_MODE)).toEqual(CONSUMED);
    },
  );

  it.each(["C-r", "C-s", "C-k", "M-1", "M-x", "C-M-b", "n", "g"])(
    "swallows %s, which tmux binds to a copy command bb has no equivalent for",
    (stroke) => {
      expect(press(INITIAL_MACHINE_STATE, stroke, IN_COPY_MODE)).toEqual(CONSUMED);
    },
  );

  it.each(["C-x", "C-d", "D-c", "M-q", "C-M-x"])(
    "passes the shortcut %s, which tmux does not bind in copy mode",
    (stroke) => {
      expect(press(INITIAL_MACHINE_STATE, stroke, IN_COPY_MODE)).toEqual(PASSED);
    },
  );

  it("arms the prefix and runs the key after it", () => {
    expect(pressAll(["C-b", "c"], IN_COPY_MODE)).toEqual(consumed({ type: "thread.new" }));
  });

  it("passes every copy-mode key while copy mode is off", () => {
    for (const stroke of ["C-Space", "C-w", "q", "M-f", "C-n"]) {
      expect(press(INITIAL_MACHINE_STATE, stroke)).toEqual(PASSED);
    }
  });

  it("passes every key typed in a text field or the terminal", () => {
    for (const stroke of ["q", "C-n", "Space"]) {
      expect(
        press(INITIAL_MACHINE_STATE, stroke, { copyMode: true, focus: "typing" }),
      ).toEqual(PASSED);
    }
  });
});

describe("step: copy mode with the vi keys of a tmux config", () => {
  it.each<[string, Action]>([
    ["h", move("char-left")],
    ["j", move("line-down")],
    ["k", move("line-up")],
    ["l", move("char-right")],
    ["w", move("word-forward")],
    ["b", move("word-back")],
    ["e", move("word-end")],
    ["0", move("line-start")],
    ["^", move("line-indent")],
    ["$", move("line-end")],
    ["g", move("document-start")],
    ["G", move("document-end")],
    ["H", move("screen-top")],
    ["M", move("screen-middle")],
    ["L", move("screen-bottom")],
    ["C-d", move("half-page-down")],
    ["C-u", move("half-page-up")],
    ["C-f", move("page-down")],
    ["C-b", move("page-up")],
    ["C-e", { type: "copy.scroll", direction: 1 }],
    ["C-y", { type: "copy.scroll", direction: -1 }],
    ["Space", { type: "copy.beginSelection" }],
    ["v", { type: "copy.beginSelection" }],
    ["y", { type: "copy.yank", after: "exit" }],
    ["Enter", { type: "copy.yank", after: "exit" }],
    ["q", { type: "copy.exit" }],
    ["Escape", { type: "copy.exit" }],
  ])("runs %s", (stroke, action) => {
    expect(press(INITIAL_MACHINE_STATE, stroke, IN_VI_COPY_MODE)).toEqual(consumed(action));
  });

  it("drops the selection on Escape with tmux's own vi table, and leaves on q", () => {
    const keymap = keymapOf("setw -g mode-keys vi");

    expect(press(INITIAL_MACHINE_STATE, "Escape", { keymap, copyMode: true })).toEqual(
      consumed({ type: "copy.clearSelection" }),
    );
    expect(press(INITIAL_MACHINE_STATE, "q", { keymap, copyMode: true })).toEqual(
      consumed({ type: "copy.exit" }),
    );
  });

  it.each(["/", "?", "n", "V", "o", "C-v", "1", "%"])(
    "swallows %s, which tmux binds to a copy command bb has no equivalent for",
    (stroke) => {
      expect(press(INITIAL_MACHINE_STATE, stroke, IN_VI_COPY_MODE)).toEqual(CONSUMED);
    },
  );

  it("runs every action of a key that the config binds to several commands", () => {
    const keymap = keymapOf(
      "setw -g mode-keys vi\nbind -T copy-mode-vi J send -X -N 3 cursor-down",
    );

    expect(press(INITIAL_MACHINE_STATE, "J", { keymap, copyMode: true })).toEqual(
      consumed(move("line-down"), move("line-down"), move("line-down")),
    );
  });

  it("enters copy mode and starts selecting from one prefix key of the config", () => {
    const keymap = keymapOf("bind v copy-mode \\; send -X begin-selection");

    expect(pressAll(["C-b", "v"], { keymap })).toEqual(
      consumed({ type: "copy.enter", motion: null }, { type: "copy.beginSelection" }),
    );
  });
});

describe("step: a thread row of the sidebar", () => {
  const ON_ROW: Scenario = { focus: "sidebar" };

  it.each<[string, Action]>([
    ["ArrowUp", { type: "sidebar.move", delta: -1 }],
    ["k", { type: "sidebar.move", delta: -1 }],
    ["C-p", { type: "sidebar.move", delta: -1 }],
    ["ArrowDown", { type: "sidebar.move", delta: 1 }],
    ["j", { type: "sidebar.move", delta: 1 }],
    ["C-n", { type: "sidebar.move", delta: 1 }],
    ["PageUp", { type: "sidebar.page", delta: -1 }],
    ["PageDown", { type: "sidebar.page", delta: 1 }],
    ["C-f", { type: "sidebar.page", delta: 1 }],
    ["g", { type: "sidebar.edge", edge: "top" }],
    ["Home", { type: "sidebar.edge", edge: "top" }],
    ["G", { type: "sidebar.edge", edge: "bottom" }],
    ["End", { type: "sidebar.edge", edge: "bottom" }],
    ["Enter", { type: "sidebar.open", placement: "replace" }],
    ["q", { type: "sidebar.leave" }],
    ["Escape", { type: "sidebar.leave" }],
    ["C-g", { type: "sidebar.leave" }],
  ])("runs tmux's list key %s", (stroke, action) => {
    expect(press(INITIAL_MACHINE_STATE, stroke, ON_ROW)).toEqual(consumed(action));
  });

  it("opens the thread in a split with the split keys of stock tmux", () => {
    expect(press(INITIAL_MACHINE_STATE, "%", ON_ROW)).toEqual(
      consumed({ type: "sidebar.open", placement: "right" }),
    );
    expect(press(INITIAL_MACHINE_STATE, '"', ON_ROW)).toEqual(
      consumed({ type: "sidebar.open", placement: "down" }),
    );
  });

  it("opens the thread in a split with the split keys of the config as well", () => {
    const onRow: Scenario = { keymap: VI_STYLE, focus: "sidebar" };

    expect(press(INITIAL_MACHINE_STATE, "v", onRow)).toEqual(
      consumed({ type: "sidebar.open", placement: "right" }),
    );
    expect(press(INITIAL_MACHINE_STATE, "s", onRow)).toEqual(
      consumed({ type: "sidebar.open", placement: "down" }),
    );
    expect(press(INITIAL_MACHINE_STATE, "%", onRow)).toEqual(
      consumed({ type: "sidebar.open", placement: "right" }),
    );
  });

  it.each(["v", "s", "l", "h", "c", "x", "/", "C-j", "1"])(
    "passes %s, which is no list key and no split key of stock tmux",
    (stroke) => {
      expect(press(INITIAL_MACHINE_STATE, stroke, ON_ROW)).toEqual(PASSED);
    },
  );

  it("pages up with C-b when the prefix is another key", () => {
    expect(press(INITIAL_MACHINE_STATE, "C-b", { keymap: VI_STYLE, focus: "sidebar" })).toEqual(
      consumed({ type: "sidebar.page", delta: -1 }),
    );
  });

  it("passes the list keys everywhere else", () => {
    for (const focusKind of ["normal", "control", "typing"] as const) {
      expect(press(INITIAL_MACHINE_STATE, "j", { focus: focusKind })).toEqual(PASSED);
      expect(press(INITIAL_MACHINE_STATE, "C-n", { focus: focusKind })).toEqual(PASSED);
    }
  });
});

// A terminal sends Ctrl-[ as Escape, Ctrl-m as Enter and Ctrl-i as Tab, so
// tmux cannot tell the two keys of a pair apart. A browser can.
describe("step: the keys that a terminal sends as Escape, Enter and Tab", () => {
  const TERMINAL_CHORDS = ["C-[", "C-m", "C-i"];
  const ON_ROW: Scenario = { focus: "sidebar" };
  const STOCK_VI = keymapOf("setw -g mode-keys vi");

  describe("in copy mode", () => {
    it("runs what tmux's emacs table binds Escape to on Ctrl-[, and swallows Ctrl-m and Ctrl-i as it swallows Enter and Tab", () => {
      expect(press(INITIAL_MACHINE_STATE, "C-[", IN_COPY_MODE)).toEqual(
        consumed({ type: "copy.exit" }),
      );
      expect(press(INITIAL_MACHINE_STATE, "C-m", IN_COPY_MODE)).toEqual(CONSUMED);
      expect(press(INITIAL_MACHINE_STATE, "C-i", IN_COPY_MODE)).toEqual(CONSUMED);
    });

    it("runs what tmux's vi table binds Escape and Enter to on Ctrl-[ and Ctrl-m", () => {
      const inCopyMode: Scenario = { keymap: STOCK_VI, copyMode: true };

      expect(press(INITIAL_MACHINE_STATE, "C-[", inCopyMode)).toEqual(
        consumed({ type: "copy.clearSelection" }),
      );
      expect(press(INITIAL_MACHINE_STATE, "C-m", inCopyMode)).toEqual(
        consumed({ type: "copy.yank", after: "exit" }),
      );
      expect(press(INITIAL_MACHINE_STATE, "C-i", inCopyMode)).toEqual(CONSUMED);
    });

    it("follows the tmux config: Ctrl-[ leaves copy mode where the config binds Escape to cancel", () => {
      expect(press(INITIAL_MACHINE_STATE, "C-[", IN_VI_COPY_MODE)).toEqual(
        consumed({ type: "copy.exit" }),
      );
    });

    it("runs what the config binds Tab to on Ctrl-i", () => {
      const keymap = keymapOf(
        "setw -g mode-keys vi\nbind -T copy-mode-vi Tab send -X begin-selection",
      );

      expect(press(INITIAL_MACHINE_STATE, "C-i", { keymap, copyMode: true })).toEqual(
        consumed({ type: "copy.beginSelection" }),
      );
      expect(press(INITIAL_MACHINE_STATE, "Tab", { keymap, copyMode: true })).toEqual(
        consumed({ type: "copy.beginSelection" }),
      );
    });

    it.each(PANE_FOCUS_KINDS)("does so in %s focus", (focusKind) => {
      expect(
        press(INITIAL_MACHINE_STATE, "C-[", { copyMode: true, focus: focusKind }),
      ).toEqual(consumed({ type: "copy.exit" }));
    });

    it("runs the binding of the chord itself when the copy table has one", () => {
      const keymap = keymapOf(
        [
          "setw -g mode-keys vi",
          "bind -T copy-mode-vi C-m send -X cursor-down",
          "bind -T copy-mode-vi C-[ send -X cursor-up",
          "bind -T copy-mode-vi C-i send -X cursor-right",
        ].join("\n"),
      );
      const inCopyMode: Scenario = { keymap, copyMode: true };

      expect(press(INITIAL_MACHINE_STATE, "C-m", inCopyMode)).toEqual(
        consumed(move("line-down")),
      );
      expect(press(INITIAL_MACHINE_STATE, "C-[", inCopyMode)).toEqual(
        consumed(move("line-up")),
      );
      expect(press(INITIAL_MACHINE_STATE, "C-i", inCopyMode)).toEqual(
        consumed(move("char-right")),
      );
      expect(press(INITIAL_MACHINE_STATE, "Enter", inCopyMode)).toEqual(
        consumed({ type: "copy.yank", after: "exit" }),
      );
    });

    it("does not run Enter's binding for a Ctrl-m that the copy table binds to a command without equivalent", () => {
      const keymap = keymapOf(
        "setw -g mode-keys vi\nbind -T copy-mode-vi C-m command-prompt",
      );

      expect(press(INITIAL_MACHINE_STATE, "C-m", { keymap, copyMode: true })).toEqual(
        CONSUMED,
      );
    });

    it("runs a no-prefix binding of the chord itself, and not what the copy table binds Enter to", () => {
      const keymap = keymapOf("setw -g mode-keys vi\nbind -n C-m new-window");

      expect(press(INITIAL_MACHINE_STATE, "C-m", { keymap, copyMode: true })).toEqual(
        consumed({ type: "thread.new" }),
      );
    });

    it("arms the prefix on a chord that is the prefix", () => {
      const keymap = keymapOf("setw -g mode-keys vi\nset -g prefix C-]\nset -g prefix2 C-m");

      expect(press(INITIAL_MACHINE_STATE, "C-m", { keymap, copyMode: true })).toEqual({
        state: ARMED,
        decision: "consume",
        actions: [],
      });
    });
  });

  describe("on a thread row of the sidebar", () => {
    it("leaves the row on Ctrl-[ and opens its thread on Ctrl-m, as Escape and Enter do", () => {
      expect(press(INITIAL_MACHINE_STATE, "C-[", ON_ROW)).toEqual(
        consumed({ type: "sidebar.leave" }),
      );
      expect(press(INITIAL_MACHINE_STATE, "C-m", ON_ROW)).toEqual(
        consumed({ type: "sidebar.open", placement: "replace" }),
      );
    });

    it("passes Ctrl-i, as it passes Tab, which is no key of a list", () => {
      expect(press(INITIAL_MACHINE_STATE, "C-i", ON_ROW)).toEqual(PASSED);
      expect(press(INITIAL_MACHINE_STATE, "Tab", ON_ROW)).toEqual(PASSED);
    });

    it("runs the chord itself when it is a split key of the config", () => {
      const keymap = keymapOf("bind C-m split-window -h\nbind C-[ split-window");
      const onRow: Scenario = { keymap, focus: "sidebar" };

      expect(press(INITIAL_MACHINE_STATE, "C-m", onRow)).toEqual(
        consumed({ type: "sidebar.open", placement: "right" }),
      );
      expect(press(INITIAL_MACHINE_STATE, "C-[", onRow)).toEqual(
        consumed({ type: "sidebar.open", placement: "down" }),
      );
      expect(press(INITIAL_MACHINE_STATE, "Enter", onRow)).toEqual(
        consumed({ type: "sidebar.open", placement: "replace" }),
      );
    });

    it("runs a no-prefix binding of the chord itself", () => {
      const keymap = keymapOf("bind -n C-m new-window");

      expect(press(INITIAL_MACHINE_STATE, "C-m", { keymap, focus: "sidebar" })).toEqual(
        consumed({ type: "thread.new" }),
      );
    });

    it.each(["C-x", "C-j", "M-[", "D-[", "C-S-m"])(
      "passes %s, which a terminal sends as none of the three",
      (stroke) => {
        expect(press(INITIAL_MACHINE_STATE, stroke, ON_ROW)).toEqual(PASSED);
      },
    );
  });

  describe("everywhere else", () => {
    it.each(TERMINAL_CHORDS)("%s is a key of its own after the prefix, which ends the prefix", (chord) => {
      for (const focusKind of HANDLED_FOCUS_KINDS) {
        expect(pressAll(["C-b", chord], { focus: focusKind })).toEqual(CONSUMED);
      }
      expect(pressAll(["C-b", chord], IN_COPY_MODE)).toEqual(CONSUMED);
    });

    it("does not run what the prefix table binds Escape, Enter or Tab to", () => {
      const keymap = keymapOf(
        "bind Escape new-window\nbind Enter next-window\nbind Tab previous-window",
      );

      for (const chord of TERMINAL_CHORDS) {
        expect(pressAll(["C-b", chord], { keymap })).toEqual(CONSUMED);
        expect(pressAll(["C-b", chord], { keymap, copyMode: true })).toEqual(CONSUMED);
        expect(pressAll(["C-b", chord], { keymap, focus: "sidebar" })).toEqual(CONSUMED);
      }
      expect(pressAll(["C-b", "Enter"], { keymap })).toEqual(
        consumed({ type: "thread.cycle", delta: 1 }),
      );
    });

    it("runs what the prefix table binds the chord itself to, and Enter does not", () => {
      const keymap = keymapOf("bind C-m new-window");

      expect(pressAll(["C-b", "C-m"], { keymap })).toEqual(consumed({ type: "thread.new" }));
      expect(pressAll(["C-b", "Enter"], { keymap })).toEqual(CONSUMED);
    });

    it("goes on as a key of its own while a key bound with -r repeats, also on a sidebar row", () => {
      const keymap = keymapOf("bind -r C-m resize-pane -D 2");
      const repeating = pressAll(["C-b", "C-m"], { keymap });
      expect(repeating).toEqual(repeated(resize("down", 2)));

      expect(press(repeating.state, "C-m", { keymap, focus: "sidebar" })).toEqual(
        repeated(resize("down", 2)),
      );
    });

    it("runs a no-prefix binding of the chord itself wherever such a key works, and Tab does not", () => {
      const keymap = keymapOf("bind -n C-i next-window");

      for (const focusKind of HANDLED_FOCUS_KINDS) {
        expect(press(INITIAL_MACHINE_STATE, "C-i", { keymap, focus: focusKind })).toEqual(
          consumed({ type: "thread.cycle", delta: 1 }),
        );
        expect(press(INITIAL_MACHINE_STATE, "Tab", { keymap, focus: focusKind })).toEqual(
          PASSED,
        );
      }
    });

    it.each(TERMINAL_CHORDS)("%s is passed on a pane outside copy mode and in a text field", (chord) => {
      for (const focusKind of ["normal", "control", "typing"] as const) {
        expect(press(INITIAL_MACHINE_STATE, chord, { focus: focusKind })).toEqual(PASSED);
      }
      expect(
        press(INITIAL_MACHINE_STATE, chord, { copyMode: true, focus: "typing" }),
      ).toEqual(PASSED);
    });

    it.each(TERMINAL_CHORDS)("%s is passed in a dialog and in an embedded page", (chord) => {
      for (const focusKind of ["overlay", "frame"] as const) {
        expect(
          press(INITIAL_MACHINE_STATE, chord, { copyMode: true, focus: focusKind }),
        ).toEqual(PASSED);
      }
    });
  });
});

describe("step: i when the cursor is not in a text field", () => {
  const FOCUS_MESSAGE_BOX: Action = { type: "composer.focus" };

  it.each(["normal", "control", "sidebar"] as const)(
    "puts the cursor in the message box in %s focus",
    (focusKind) => {
      expect(press(INITIAL_MACHINE_STATE, "i", { focus: focusKind })).toEqual(
        consumed(FOCUS_MESSAGE_BOX),
      );
    },
  );

  it("does so whatever the tmux config binds", () => {
    expect(press(INITIAL_MACHINE_STATE, "i", VI)).toEqual(consumed(FOCUS_MESSAGE_BOX));
    expect(
      press(INITIAL_MACHINE_STATE, "i", { keymap: keymapOf("unbind -a\nbind i new-window") }),
    ).toEqual(consumed(FOCUS_MESSAGE_BOX));
  });

  it.each(["typing", "overlay", "frame"] as const)("is passed in %s focus", (focusKind) => {
    expect(press(INITIAL_MACHINE_STATE, "i", { focus: focusKind })).toEqual(PASSED);
  });

  it("is passed with Shift held, and as part of a chord", () => {
    expect(press(INITIAL_MACHINE_STATE, "i", { shift: true })).toEqual(PASSED);
    expect(press(INITIAL_MACHINE_STATE, "C-i")).toEqual(PASSED);
    expect(press(INITIAL_MACHINE_STATE, "M-i")).toEqual(PASSED);
    expect(press(INITIAL_MACHINE_STATE, "I")).toEqual(PASSED);
  });

  it("is swallowed in copy mode, like every plain key that tmux does not bind there", () => {
    expect(press(INITIAL_MACHINE_STATE, "i", IN_COPY_MODE)).toEqual(CONSUMED);
  });

  it("is the only plain key outside copy mode and the sidebar", () => {
    for (const stroke of ["j", "k", "g", "G", "/", ":", "v", "Space", "q", "Escape", "Enter"]) {
      for (const focusKind of PANE_FOCUS_KINDS) {
        expect(press(INITIAL_MACHINE_STATE, stroke, { focus: focusKind })).toEqual(PASSED);
      }
    }
  });
});

describe("step purity", () => {
  it.each([ARMED, REPEATING])("does not change the state it is given", (state) => {
    const before = structuredClone(state);

    press(state, "ArrowUp");

    expect(state).toEqual(before);
  });

  it("leaves INITIAL_MACHINE_STATE untouched and returns it when idle", () => {
    const result = press(INITIAL_MACHINE_STATE, "x");

    expect(result.state).toBe(INITIAL_MACHINE_STATE);
    expect(INITIAL_MACHINE_STATE).toEqual({ pending: "none", deadline: null });
  });
});

describe("isPrefixArmed", () => {
  it("is false when nothing is pending and while the repeat window is open", () => {
    expect(isPrefixArmed(INITIAL_MACHINE_STATE, NOW)).toBe(false);
    expect(isPrefixArmed(REPEATING, NOW)).toBe(false);
  });

  it("is true from arming until the deadline, and false after it", () => {
    expect(isPrefixArmed(ARMED_FOR_A_TIME, NOW)).toBe(true);
    expect(isPrefixArmed(ARMED_FOR_A_TIME, NOW + PREFIX_TIMEOUT_MS)).toBe(true);
    expect(isPrefixArmed(ARMED_FOR_A_TIME, NOW + PREFIX_TIMEOUT_MS + 1)).toBe(false);
  });

  it("stays true without a deadline, however late it is asked", () => {
    expect(isPrefixArmed(ARMED, NOW + 3_600_000)).toBe(true);
  });

  it("follows step: armed after the prefix, not after the next key", () => {
    const armed = press(INITIAL_MACHINE_STATE, "C-b");

    expect(isPrefixArmed(armed.state, NOW)).toBe(true);
    expect(isPrefixArmed(press(armed.state, "c").state, NOW)).toBe(false);
  });
});

describe("isRepeatWindowOpen", () => {
  it("is false when nothing is pending and while the prefix is armed", () => {
    expect(isRepeatWindowOpen(INITIAL_MACHINE_STATE, NOW)).toBe(false);
    expect(isRepeatWindowOpen(ARMED, NOW)).toBe(false);
  });

  it("is true from the key until the deadline, and false after it", () => {
    expect(isRepeatWindowOpen(REPEATING, NOW)).toBe(true);
    expect(isRepeatWindowOpen(REPEATING, NOW + STOCK_REPEAT_TIME_MS)).toBe(true);
    expect(isRepeatWindowOpen(REPEATING, NOW + STOCK_REPEAT_TIME_MS + 1)).toBe(false);
  });

  it("follows step: open after a key bound with -r, closed after any other key", () => {
    const opened = pressAll(["C-b", "ArrowUp"]);

    expect(isRepeatWindowOpen(opened.state, NOW)).toBe(true);
    expect(isRepeatWindowOpen(press(opened.state, "x").state, NOW)).toBe(false);
  });
});
