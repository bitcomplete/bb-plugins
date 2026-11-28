import { describe, expect, it } from "vitest";
import {
  buildKeymap,
  describeKeymap,
  describeKeymapPrefix,
  describeSource,
  describeTerminalKeys,
  strokeForKeymap,
  type HelpSection,
  type TmuxSource,
} from "./keymap";
import { TERMINAL_KEYS, formatStroke } from "./keys";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import {
  stockTmuxConfig,
  tmuxConfigFrom,
  type TmuxConfig,
  type TmuxConfigSources,
} from "./tmux-keymap";
import {
  TEST_CONFIG_PATH,
  VI_STYLE_CONFIG,
  fileSources,
  tmuxConfigOf,
} from "./tmux-test-support";
import type {
  Action,
  CopyMotion,
  Direction,
  KeyBinding,
  Keymap,
} from "./types";

const EM_DASH = String.fromCharCode(0x2014);

const STOCK = buildKeymap(stockTmuxConfig());
const VI_STYLE = buildKeymap(tmuxConfigOf(VI_STYLE_CONFIG));

function keymapOf(text: string): Keymap {
  return buildKeymap(tmuxConfigOf(text));
}

function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

const PASTED_TEXT_NAME = "the Config text setting";

// What the server answers when the Config text setting holds these lines,
// with the files and the chosen config file as the test says.
function configWithPastedText(
  text: string,
  sources: Partial<TmuxConfigSources> = {},
): TmuxConfig {
  return tmuxConfigFrom(
    {
      ...fileSources([]),
      ...sources,
      pastedText: { state: "applied", lines: { path: PASTED_TEXT_NAME, text } },
    },
    { visual: undefined, editor: undefined },
  );
}

// The keys of a table that do something, each with what it does.
function actionsByKey(
  bindings: readonly KeyBinding[],
): Record<string, readonly Action[]> {
  return Object.fromEntries(
    bindings
      .filter((binding) => binding.actions.length > 0)
      .map((binding) => [binding.key, binding.actions]),
  );
}

function keysWithoutActions(bindings: readonly KeyBinding[]): string[] {
  return bindings
    .filter((binding) => binding.actions.length === 0)
    .map((binding) => binding.key);
}

function actionsOf(
  bindings: readonly KeyBinding[],
  key: string,
): readonly Action[] | undefined {
  return bindings.find((binding) => binding.key === key)?.actions;
}

function repeatingKeys(bindings: readonly KeyBinding[]): string[] {
  return bindings.filter((binding) => binding.repeat).map((binding) => binding.key);
}

function sectionRows(
  sections: HelpSection[],
  title: string,
): Record<string, string> {
  const section = sections.find((candidate) => candidate.title === title);
  if (section === undefined) throw new Error(`no help section "${title}"`);
  return Object.fromEntries(
    section.rows.map((row) => [row.keys, row.description]),
  );
}

function helpText(sections: HelpSection[]): string {
  return sections
    .flatMap((section) => [
      section.title,
      ...section.rows.map((row) => `${row.keys} ${row.description}`),
    ])
    .join("\n");
}

function focus(direction: Direction): Action[] {
  return [{ type: "pane.focus", direction }];
}

function resize(direction: Direction, cells: number): Action[] {
  return [{ type: "pane.resize", direction, cells }];
}

function jump(index: number): Action[] {
  return [{ type: "thread.jump", index }];
}

function move(motion: CopyMotion): Action[] {
  return [{ type: "copy.move", motion }];
}

function scroll(direction: 1 | -1): Action[] {
  return [{ type: "copy.scroll", direction }];
}

const SEND_PREFIX: Action[] = [{ type: "prefix.send", second: false }];
const SPLIT_RIGHT: Action[] = [{ type: "chooser.open", placement: "right" }];
const SPLIT_DOWN: Action[] = [{ type: "chooser.open", placement: "down" }];
const CHOOSE_THREAD: Action[] = [{ type: "chooser.open", placement: "replace" }];
const BEGIN_SELECTION: Action[] = [{ type: "copy.beginSelection" }];
const CLEAR_SELECTION: Action[] = [{ type: "copy.clearSelection" }];
const COPY_AND_LEAVE: Action[] = [{ type: "copy.yank", after: "exit" }];
const LEAVE_COPY_MODE: Action[] = [{ type: "copy.exit" }];

const STOCK_PREFIX_ACTIONS: Record<string, Action[]> = {
  "C-b": SEND_PREFIX,
  '"': SPLIT_DOWN,
  "%": SPLIT_RIGHT,
  "0": jump(1),
  "1": jump(2),
  "2": jump(3),
  "3": jump(4),
  "4": jump(5),
  "5": jump(6),
  "6": jump(7),
  "7": jump(8),
  "8": jump(9),
  "9": jump(10),
  ";": [{ type: "pane.last" }],
  "?": [{ type: "help.open" }],
  "[": [{ type: "copy.enter", motion: null }],
  c: [{ type: "thread.new" }],
  l: [{ type: "thread.last" }],
  n: [{ type: "thread.cycle", delta: 1 }],
  o: [{ type: "pane.next" }],
  p: [{ type: "thread.cycle", delta: -1 }],
  s: CHOOSE_THREAD,
  w: CHOOSE_THREAD,
  x: [{ type: "pane.close" }],
  z: [{ type: "pane.zoom" }],
  PageUp: [{ type: "copy.enter", motion: "page-up" }],
  ArrowUp: focus("up"),
  ArrowDown: focus("down"),
  ArrowLeft: focus("left"),
  ArrowRight: focus("right"),
  "M-ArrowUp": resize("up", 5),
  "M-ArrowDown": resize("down", 5),
  "M-ArrowLeft": resize("left", 5),
  "M-ArrowRight": resize("right", 5),
  "C-ArrowUp": resize("up", 1),
  "C-ArrowDown": resize("down", 1),
  "C-ArrowLeft": resize("left", 1),
  "C-ArrowRight": resize("right", 1),
};

// The emacs table of tmux 3.5a without C-b, which is the prefix of stock tmux
// and so never reaches copy mode.
const STOCK_EMACS_COPY_ACTIONS: Record<string, Action[]> = {
  "C-Space": BEGIN_SELECTION,
  "C-a": move("line-start"),
  "C-c": LEAVE_COPY_MODE,
  "C-e": move("line-end"),
  "C-f": move("char-right"),
  "C-g": CLEAR_SELECTION,
  "C-n": move("line-down"),
  "C-p": move("line-up"),
  "C-v": move("page-down"),
  "C-w": COPY_AND_LEAVE,
  Escape: LEAVE_COPY_MODE,
  Space: move("page-down"),
  q: LEAVE_COPY_MODE,
  Home: move("line-start"),
  End: move("line-end"),
  PageDown: move("page-down"),
  PageUp: move("page-up"),
  ArrowUp: move("line-up"),
  ArrowDown: move("line-down"),
  ArrowLeft: move("char-left"),
  ArrowRight: move("char-right"),
  "M-<": move("document-start"),
  "M->": move("document-end"),
  "M-S-r": move("screen-top"),
  "M-b": move("word-back"),
  "M-f": move("word-end"),
  "M-m": move("line-indent"),
  "M-r": move("screen-middle"),
  "M-v": move("page-up"),
  "M-w": COPY_AND_LEAVE,
  "M-{": move("paragraph-back"),
  "M-}": move("paragraph-forward"),
  "M-ArrowUp": move("half-page-up"),
  "M-ArrowDown": move("half-page-down"),
  "C-ArrowUp": scroll(-1),
  "C-ArrowDown": scroll(1),
};

const VI_STYLE_COPY_ACTIONS: Record<string, Action[]> = {
  "C-c": LEAVE_COPY_MODE,
  "C-d": move("half-page-down"),
  "C-e": scroll(1),
  "C-b": move("page-up"),
  "C-f": move("page-down"),
  "C-h": move("char-left"),
  "C-j": COPY_AND_LEAVE,
  Enter: COPY_AND_LEAVE,
  "C-u": move("half-page-up"),
  "C-y": scroll(-1),
  Space: BEGIN_SELECTION,
  $: move("line-end"),
  "0": move("line-start"),
  G: move("document-end"),
  H: move("screen-top"),
  J: scroll(1),
  K: scroll(-1),
  L: move("screen-bottom"),
  M: move("screen-middle"),
  "^": move("line-indent"),
  b: move("word-back"),
  e: move("word-end"),
  g: move("document-start"),
  h: move("char-left"),
  j: move("line-down"),
  k: move("line-up"),
  l: move("char-right"),
  q: LEAVE_COPY_MODE,
  w: move("word-forward"),
  "{": move("paragraph-back"),
  "}": move("paragraph-forward"),
  Home: move("line-start"),
  End: move("line-end"),
  Backspace: move("char-left"),
  PageDown: move("page-down"),
  PageUp: move("page-up"),
  ArrowUp: move("line-up"),
  ArrowDown: move("line-down"),
  ArrowLeft: move("char-left"),
  ArrowRight: move("char-right"),
  "C-ArrowUp": scroll(-1),
  "C-ArrowDown": scroll(1),
  v: BEGIN_SELECTION,
  y: COPY_AND_LEAVE,
  Escape: LEAVE_COPY_MODE,
};

const LIST_ACTIONS: Record<string, Action[]> = {
  ArrowUp: [{ type: "sidebar.move", delta: -1 }],
  k: [{ type: "sidebar.move", delta: -1 }],
  "C-p": [{ type: "sidebar.move", delta: -1 }],
  ArrowDown: [{ type: "sidebar.move", delta: 1 }],
  j: [{ type: "sidebar.move", delta: 1 }],
  "C-n": [{ type: "sidebar.move", delta: 1 }],
  PageUp: [{ type: "sidebar.page", delta: -1 }],
  "C-b": [{ type: "sidebar.page", delta: -1 }],
  PageDown: [{ type: "sidebar.page", delta: 1 }],
  "C-f": [{ type: "sidebar.page", delta: 1 }],
  g: [{ type: "sidebar.edge", edge: "top" }],
  Home: [{ type: "sidebar.edge", edge: "top" }],
  G: [{ type: "sidebar.edge", edge: "bottom" }],
  End: [{ type: "sidebar.edge", edge: "bottom" }],
  Enter: [{ type: "sidebar.open", placement: "replace" }],
  q: [{ type: "sidebar.leave" }],
  Escape: [{ type: "sidebar.leave" }],
  "C-g": [{ type: "sidebar.leave" }],
};

const OPEN_RIGHT: Action[] = [{ type: "sidebar.open", placement: "right" }];
const OPEN_BELOW: Action[] = [{ type: "sidebar.open", placement: "down" }];

describe("buildKeymap for stock tmux, with no tmux config", () => {
  it("has tmux's own prefix, no second prefix, tmux's repeat time and the emacs keys", () => {
    expect(STOCK.prefix).toBe("C-b");
    expect(STOCK.prefix2).toBeNull();
    expect(STOCK.repeatTimeMs).toBe(500);
    expect(STOCK.modeKeys).toBe("emacs");
  });

  it("lets the prefix wait without a time limit, as stock tmux does", () => {
    expect(STOCK.prefixTimeoutMs).toBe(0);
  });

  it("keeps what the emacs table binds C-b to apart, for the C-b that send-prefix sends to a pane in copy mode", () => {
    expect(actionsByKey(STOCK.sentCopyBindings)).toEqual({
      "C-b": move("char-left"),
    });
  });

  it("gives every key of tmux's prefix table that bb has an equivalent for its action", () => {
    expect(actionsByKey(STOCK.prefixBindings)).toEqual(STOCK_PREFIX_ACTIONS);
  });

  it("counts the windows from 0, as stock tmux does, so that 0 is the first thread", () => {
    expect(actionsOf(STOCK.prefixBindings, "0")).toEqual(jump(1));
    expect(actionsOf(STOCK.prefixBindings, "9")).toEqual(jump(10));
  });

  it("lets the arrows and the resize keys repeat, as tmux binds them with -r", () => {
    expect(
      repeatingKeys(STOCK.prefixBindings).filter(
        (key) => actionsOf(STOCK.prefixBindings, key)?.length !== 0,
      ),
    ).toEqual([
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "M-ArrowUp",
      "M-ArrowDown",
      "M-ArrowLeft",
      "M-ArrowRight",
      "C-ArrowUp",
      "C-ArrowDown",
      "C-ArrowLeft",
      "C-ArrowRight",
    ]);
  });

  it("keeps the keys that tmux binds to a command bb has no equivalent for, with nothing to do", () => {
    const taken = keysWithoutActions(STOCK.prefixBindings);

    expect(taken).toEqual(
      expect.arrayContaining([
        "C-o",
        "Space",
        "!",
        "&",
        ",",
        ".",
        ":",
        "d",
        "f",
        "i",
        "q",
        "t",
        "{",
        "}",
        "]",
        "M-1",
        "M-n",
        "S-ArrowUp",
        "Delete",
      ]),
    );
    expect(taken).toHaveLength(49);
  });

  it("uses tmux's emacs table in copy mode", () => {
    expect(actionsByKey(STOCK.copyBindings)).toEqual(STOCK_EMACS_COPY_ACTIONS);
  });

  it("keeps the copy-mode keys without an equivalent, such as the searches, with nothing to do", () => {
    expect(keysWithoutActions(STOCK.copyBindings)).toEqual(
      expect.arrayContaining(["C-r", "C-s", "C-k", "n", "N", "R", "g", "M-1", "M-x"]),
    );
  });

  it("has no key that works without the prefix, because stock tmux has none on the keyboard", () => {
    expect(STOCK.rootBindings).toEqual([]);
  });

  it("binds i, and no other key, to the message box", () => {
    expect(actionsByKey(STOCK.plainBindings)).toEqual({
      i: [{ type: "composer.focus" }],
    });
  });

  it("gives a thread row of the sidebar tmux's list keys, less C-b, which is the prefix", () => {
    const { "C-b": _prefix, ...reachable } = LIST_ACTIONS;

    expect(actionsByKey(STOCK.sidebarBindings)).toEqual({
      ...reachable,
      "%": OPEN_RIGHT,
      '"': OPEN_BELOW,
    });
  });

  it("takes the split and new-thread keys of the lists from the prefix table", () => {
    expect(STOCK.listSplitKeys).toEqual({
      right: ["%"],
      down: ['"'],
      newThread: ["c"],
    });
  });
});

describe("buildKeymap for a tmux config in the vi style", () => {
  it("takes the prefix, the repeat time and the copy keys from the config", () => {
    expect(VI_STYLE.prefix).toBe("C-a");
    expect(VI_STYLE.prefix2).toBeNull();
    expect(VI_STYLE.repeatTimeMs).toBe(500);
    expect(VI_STYLE.modeKeys).toBe("vi");
  });

  it("sends the new prefix on from the key the config binds to send-prefix, and has C-b no more", () => {
    expect(actionsOf(VI_STYLE.prefixBindings, "C-a")).toEqual(SEND_PREFIX);
    expect(actionsOf(VI_STYLE.prefixBindings, "C-b")).toBeUndefined();
  });

  it("adds the letters for the panes, the split keys, the resize keys and the reload key to stock tmux", () => {
    const { "C-b": _sendPrefix, "0": _noWindow, l: _lastWindow, ...stock } =
      STOCK_PREFIX_ACTIONS;

    expect(actionsByKey(VI_STYLE.prefixBindings)).toEqual({
      ...stock,
      "C-a": SEND_PREFIX,
      "1": jump(1),
      "2": jump(2),
      "3": jump(3),
      "4": jump(4),
      "5": jump(5),
      "6": jump(6),
      "7": jump(7),
      "8": jump(8),
      "9": jump(9),
      h: focus("left"),
      j: focus("down"),
      k: focus("up"),
      l: focus("right"),
      v: SPLIT_RIGHT,
      s: SPLIT_DOWN,
      "M-h": resize("left", 5),
      "M-j": resize("down", 5),
      "M-k": resize("up", 5),
      "M-l": resize("right", 5),
      r: [
        { type: "config.reload" },
        { type: "notice.show", text: "Config reloaded" },
      ],
    });
  });

  it("counts the windows from 1 with base-index 1, so that 0 does nothing", () => {
    expect(actionsOf(VI_STYLE.prefixBindings, "1")).toEqual(jump(1));
    expect(actionsOf(VI_STYLE.prefixBindings, "0")).toEqual([]);
  });

  it("lets the resize keys of the config repeat, and not its pane letters", () => {
    const repeating = repeatingKeys(VI_STYLE.prefixBindings);

    expect(repeating).toEqual(expect.arrayContaining(["M-h", "M-j", "M-k", "M-l"]));
    expect(repeating).not.toEqual(expect.arrayContaining(["h"]));
  });

  it("uses tmux's vi table in copy mode with the selection and copy keys of the config", () => {
    expect(actionsByKey(VI_STYLE.copyBindings)).toEqual(VI_STYLE_COPY_ACTIONS);
  });

  it("gives a thread row of the sidebar every list key, and the split keys of both stock tmux and the config", () => {
    expect(actionsByKey(VI_STYLE.sidebarBindings)).toEqual({
      ...LIST_ACTIONS,
      "%": OPEN_RIGHT,
      v: OPEN_RIGHT,
      '"': OPEN_BELOW,
      s: OPEN_BELOW,
    });
    expect(VI_STYLE.listSplitKeys).toEqual({
      right: ["%", "v"],
      down: ['"', "s"],
      newThread: ["c"],
    });
  });
});

describe("buildKeymap: what a line of the tmux config changes", () => {
  it("drops a stock key that the config unbinds, also from the lists", () => {
    const keymap = keymapOf("unbind %\nunbind c");

    expect(actionsOf(keymap.prefixBindings, "%")).toBeUndefined();
    expect(actionsOf(keymap.prefixBindings, "c")).toBeUndefined();
    expect(keymap.listSplitKeys).toEqual({ right: [], down: ['"'], newThread: [] });
    expect(actionsOf(keymap.sidebarBindings, "%")).toBeUndefined();
  });

  it("has nothing but the keys of the config after unbind -a", () => {
    const keymap = keymapOf("unbind -a\nbind a split-window -h\nbind b new-window");

    expect(actionsByKey(keymap.prefixBindings)).toEqual({
      a: SPLIT_RIGHT,
      b: [{ type: "thread.new" }],
    });
    expect(keysWithoutActions(keymap.prefixBindings)).toEqual([]);
    expect(keymap.listSplitKeys).toEqual({ right: ["a"], down: [], newThread: ["b"] });
  });

  it("keeps a key that the config binds to a command without equivalent, with nothing to do", () => {
    const keymap = keymapOf("bind x kill-server\nbind X run-shell 'echo hi'");

    expect(actionsOf(keymap.prefixBindings, "x")).toEqual([]);
    expect(actionsOf(keymap.prefixBindings, "X")).toEqual([]);
  });

  it("replaces what a key did when the config binds it again", () => {
    const keymap = keymapOf("bind c split-window\nbind -r o select-pane -t :.-");

    expect(actionsOf(keymap.prefixBindings, "c")).toEqual(SPLIT_DOWN);
    expect(actionsOf(keymap.prefixBindings, "o")).toEqual([{ type: "pane.previous" }]);
    expect(repeatingKeys(keymap.prefixBindings)).toContain("o");
    expect(keymap.listSplitKeys).toEqual({
      right: ["%"],
      down: ['"', "c"],
      newThread: [],
    });
  });

  it("takes a root key that has Ctrl or Alt, or that is a function key", () => {
    const keymap = keymapOf(
      [
        "bind -n M-Left select-pane -L",
        "bind -n C-M-n next-window",
        "bind -n F5 new-window",
        "bind -T root S-F6 resize-pane -Z",
      ].join("\n"),
    );

    expect(actionsByKey(keymap.rootBindings)).toEqual({
      "M-ArrowLeft": focus("left"),
      "C-M-n": [{ type: "thread.cycle", delta: 1 }],
      F5: [{ type: "thread.new" }],
      "S-F6": [{ type: "pane.zoom" }],
    });
  });

  it.each(["h", "H", "Space", "Enter", "S-Left", "Tab", "PPage"])(
    "ignores the root key %s, which would be taken away from typing",
    (key) => {
      expect(keymapOf(`bind -n ${key} select-pane -L`).rootBindings).toEqual([]);
    },
  );

  it("does not take a root key whose command bb has no equivalent for, so that it still reaches bb", () => {
    const keymap = keymapOf(
      'bind -n C-k clear-history\nbind -n C-h if-shell "true" "select-pane -L"',
    );

    expect(keymap.rootBindings).toEqual([]);
  });

  it("ignores a root key on the prefix, which arms the prefix first", () => {
    expect(keymapOf("bind -n C-b new-window").rootBindings).toEqual([]);
  });

  it("takes a second prefix that bb can use", () => {
    expect(keymapOf("set -g prefix2 C-s").prefix2).toBe("C-s");
    expect(keymapOf("set -g prefix2 F12").prefix2).toBe("F12");
  });

  it.each(["set -g prefix2 None", "set -g prefix2 a", "set -g prefix2 C-b"])(
    "has no second prefix for %j",
    (text) => {
      expect(keymapOf(text).prefix2).toBeNull();
    },
  );

  it("sends the second prefix on only from the second prefix key", () => {
    const keymap = keymapOf(
      "set -g prefix2 C-s\nbind C-s send-prefix -2\nbind e send-prefix -2",
    );

    expect(actionsOf(keymap.prefixBindings, "C-s")).toEqual([
      { type: "prefix.send", second: true },
    ]);
    expect(actionsOf(keymap.prefixBindings, "e")).toEqual([]);
  });

  it("gives send-prefix nothing to do on a key that is not the prefix", () => {
    const moved = keymapOf("set -g prefix C-a");

    expect(moved.prefix).toBe("C-a");
    expect(actionsOf(moved.prefixBindings, "C-b")).toEqual([]);
    expect(actionsOf(moved.prefixBindings, "C-a")).toBeUndefined();
  });

  it("leaves a binding on the prefix key out of copy mode and the sidebar, where the key arms the prefix", () => {
    const vi = keymapOf("setw -g mode-keys vi");

    expect(vi.prefix).toBe("C-b");
    expect(actionsOf(vi.copyBindings, "C-b")).toBeUndefined();
    expect(actionsOf(vi.sidebarBindings, "C-b")).toBeUndefined();
    expect(actionsOf(VI_STYLE.copyBindings, "C-b")).toEqual(move("page-up"));
  });

  it("keeps the copy binding of a prefix key apart when the prefix table sends that key on", () => {
    const vi = keymapOf("setw -g mode-keys vi");
    const space = keymapOf("set -g prefix C-Space\nbind C-Space send-prefix");
    const second = keymapOf("set -g prefix2 C-a\nbind C-a send-prefix -2");

    expect(actionsByKey(vi.sentCopyBindings)).toEqual({ "C-b": move("page-up") });
    expect(actionsByKey(space.sentCopyBindings)).toEqual({
      "C-Space": BEGIN_SELECTION,
    });
    expect(actionsOf(space.copyBindings, "C-Space")).toBeUndefined();
    expect(actionsByKey(second.sentCopyBindings)).toEqual({
      "C-b": move("char-left"),
      "C-a": move("line-start"),
    });
  });

  it.each([
    ["the prefix table does not send the key on", "set -g prefix C-Space"],
    ["the key that is sent on is the other prefix", "set -g prefix2 C-a\nbind C-a send-prefix\nunbind C-b"],
    ["the copy table does not bind the key", VI_STYLE_CONFIG],
  ])("keeps no copy binding apart when %s", (_why, text) => {
    expect(keymapOf(text).sentCopyBindings).toEqual([]);
  });

  it("keeps the copy binding of a sent key that bb has no equivalent for, with nothing to do", () => {
    const keymap = keymapOf("set -g prefix C-s\nbind C-s send-prefix");

    expect(keymap.sentCopyBindings).toEqual([
      { key: "C-s", repeat: false, actions: [] },
    ]);
  });

  it("uses the copy table that mode-keys names", () => {
    expect(keymapOf("setw -g mode-keys vi").modeKeys).toBe("vi");
    expect(actionsOf(keymapOf("setw -g mode-keys vi").copyBindings, "h")).toEqual(
      move("char-left"),
    );
    expect(actionsOf(keymapOf("setw -g mode-keys emacs").copyBindings, "h")).toBeUndefined();
  });

  it("keeps a copy key of the config in its own table only", () => {
    const keymap = keymapOf("bind -T copy-mode-vi y send -X copy-selection");

    expect(actionsOf(keymap.copyBindings, "y")).toBeUndefined();
    expect(
      actionsOf(
        keymapOf("setw -g mode-keys vi\nbind -T copy-mode-vi y send -X copy-selection")
          .copyBindings,
        "y",
      ),
    ).toEqual([{ type: "copy.yank", after: "clear" }]);
  });

  it("never passes the shell command of copy-pipe on", () => {
    const keymap = keymapOf(
      'setw -g mode-keys vi\nbind -T copy-mode-vi y send -X copy-pipe-and-cancel "pbcopy"',
    );

    expect(actionsOf(keymap.copyBindings, "y")).toEqual(COPY_AND_LEAVE);
    expect(JSON.stringify(keymap)).not.toContain("pbcopy");
  });

  it("keeps -r for the keys of the prefix table only, where it means something", () => {
    const keymap = keymapOf(
      "setw -g mode-keys vi\nbind -r -T copy-mode-vi J send -X scroll-down\nbind -r -n M-n next-window\nbind -r n next-window",
    );

    expect(repeatingKeys(keymap.copyBindings)).toEqual([]);
    expect(repeatingKeys(keymap.rootBindings)).toEqual([]);
    expect(repeatingKeys(keymap.prefixBindings)).toContain("n");
  });

  it("takes the repeat time from the config", () => {
    expect(keymapOf("set -g repeat-time 1200").repeatTimeMs).toBe(1200);
    expect(keymapOf("set -g repeat-time 0").repeatTimeMs).toBe(0);
  });

  it("takes the time that the prefix waits from the config", () => {
    expect(keymapOf("set -g prefix-timeout 1200").prefixTimeoutMs).toBe(1200);
    expect(keymapOf("set -s prefix-timeout 0").prefixTimeoutMs).toBe(0);
  });

  it("keeps tmux's list keys and the filter key of the chooser out of the split keys", () => {
    const keymap = keymapOf(
      "bind j split-window\nbind g split-window -h\nbind q new-window\nbind / split-window -h",
    );

    expect(keymap.listSplitKeys).toEqual({
      right: ["%"],
      down: ['"'],
      newThread: ["c"],
    });
    expect(actionsOf(keymap.sidebarBindings, "j")).toEqual(LIST_ACTIONS.j);
  });

  it("takes a chord as a split key too", () => {
    expect(keymapOf("bind C-v split-window -h").listSplitKeys.right).toEqual([
      "%",
      "C-v",
    ]);
  });
});

describe("buildKeymap: the prefix", () => {
  it.each([
    ["C-x", "C-x"],
    ["M-Space", "M-Space"],
    ["F12", "F12"],
    ["M-X", "M-S-x"],
  ])("is the key that the tmux config sets as its prefix %s: %s", (key, prefix) => {
    expect(keymapOf(`set -g prefix ${key}`).prefix).toBe(prefix);
  });

  it("is tmux's own, Ctrl-b, when no line of the config sets one", () => {
    expect(STOCK.prefix).toBe("C-b");
    expect(keymapOf("set -g mouse on").prefix).toBe("C-b");
  });

  it("uses tmux's own prefix when the config names one that bb cannot use", () => {
    expect(keymapOf("set -g prefix `").prefix).toBe("C-b");
  });

  it("is the one of the last line that sets it, and tmux's own when that line names a key that bb cannot use", () => {
    expect(keymapOf("set -g prefix C-a\nset -g prefix C-s").prefix).toBe("C-s");
    expect(keymapOf("set -g prefix C-a\nset -g prefix `").prefix).toBe("C-b");
  });

  it("is the prefix of the Config text setting when its lines set one after a file has, and the key of the file is an ordinary key then", () => {
    const keymap = buildKeymap(
      configWithPastedText(
        "set -g prefix C-Space\nbind C-Space send-prefix",
        fileSources([{ path: TEST_CONFIG_PATH, text: VI_STYLE_CONFIG }]),
      ),
    );

    expect(VI_STYLE.prefix).toBe("C-a");
    expect(actionsOf(VI_STYLE.prefixBindings, "C-a")).toEqual(SEND_PREFIX);
    expect(keymap.prefix).toBe("C-Space");
    expect(actionsOf(keymap.prefixBindings, "C-Space")).toEqual(SEND_PREFIX);
    expect(actionsOf(keymap.prefixBindings, "C-a")).toEqual([]);
  });
});

// On a German Mac keyboard Option-5 types "[", Option-8 "{" and Option-9 "}".
// The key reader names those presses M-5, M-8 and M-9.
describe("strokeForKeymap", () => {
  it("is the chord when the key press typed no character", () => {
    expect(strokeForKeymap(STOCK, "C-b", null)).toBe("C-b");
    expect(strokeForKeymap(STOCK, "M-8", null)).toBe("M-8");
  });

  it.each([
    ["M-5", "["],
    ["M-S-5", "["],
    ["C-M-8", "["],
    ["M-S-7", "?"],
  ])("is the typed character for %s when %s is a key that does something", (chord, typed) => {
    expect(strokeForKeymap(STOCK, chord, typed)).toBe(typed);
  });

  it("is the typed character although tmux binds the chord, when bb has no equivalent for what it is bound to", () => {
    expect(actionsOf(STOCK.prefixBindings, "M-5")).toEqual([]);
    expect(strokeForKeymap(STOCK, "M-5", "[")).toBe("[");
  });

  it("stays a chord when neither the chord nor the character does anything", () => {
    expect(strokeForKeymap(STOCK, "M-8", "|")).toBe("M-8");
    expect(strokeForKeymap(STOCK, "M-x", "≈")).toBe("M-x");
    expect(strokeForKeymap(STOCK, "M-S-7", "\\")).toBe("M-S-7");
  });

  it("is the chord when the chord is the prefix key", () => {
    const withAltPrefix = keymapOf("set -g prefix M-5");

    expect(strokeForKeymap(withAltPrefix, "M-5", "[")).toBe("M-5");
  });

  it("is the chord when the chord is the second prefix", () => {
    expect(strokeForKeymap(keymapOf("set -g prefix2 M-5"), "M-5", "[")).toBe("M-5");
  });

  // A symbol needs Shift on one keyboard layout and not on another: ? is
  // Shift-/ and ^ is Shift-6 on a US keyboard.
  it.each([
    ["C-?", "C-S-?"],
    ["C-^", "C-S-^"],
    ["C-_", "C-S-_"],
    ["M-{", "M-S-{"],
    ["C-M-?", "C-M-S-?"],
  ])("is the prefix %s for the same symbol pressed with Shift, %s", (prefix, chord) => {
    const withSymbolPrefix = keymapOf(`set -g prefix ${prefix}`);

    expect(withSymbolPrefix.prefix).toBe(prefix);
    expect(strokeForKeymap(withSymbolPrefix, chord, null)).toBe(prefix);
    expect(strokeForKeymap(withSymbolPrefix, prefix, null)).toBe(prefix);
  });

  it("is the second prefix for its symbol pressed with Shift", () => {
    const keymap = keymapOf("set -g prefix2 C-^");

    expect(strokeForKeymap(keymap, "C-S-^", null)).toBe("C-^");
  });

  it.each([
    ["M-S-<", "M-<"],
    ["M-S->", "M->"],
    ["M-S-{", "M-{"],
    ["M-S-}", "M-}"],
  ])("is tmux's copy key %s for the same symbol pressed with Shift, %s", (chord, key) => {
    expect(strokeForKeymap(STOCK, chord, null)).toBe(key);
  });

  it.each([
    ["a letter, whose Shift form is another key", "C-a", "C-S-a"],
    ["a digit", "C-1", "C-S-1"],
    ["a letter with an accent", "C-é", "C-S-é"],
    ["a named key", "C-Tab", "C-S-Tab"],
    ["another symbol", "C-/", "C-S-?"],
    ["a symbol with other modifiers", "C-?", "M-S-?"],
  ])("does not take Shift off %s", (_name, prefix, chord) => {
    const other = keymapOf(`set -g prefix ${prefix}`);

    expect(other.prefix).toBe(prefix);
    expect(strokeForKeymap(other, chord, null)).toBe(chord);
  });

  it("keeps a prefix that names Shift itself apart from the one without", () => {
    const withShift = keymapOf("set -g prefix C-S-?");

    expect(withShift.prefix).toBe("C-S-?");
    expect(strokeForKeymap(withShift, "C-S-?", null)).toBe("C-S-?");
    expect(strokeForKeymap(withShift, "C-?", null)).toBe("C-?");
  });

  it("is the chord when the chord is bound, as Ctrl-d is in the vi copy table", () => {
    expect(strokeForKeymap(VI_STYLE, "C-d", "[")).toBe("C-d");
  });

  // On a US Mac keyboard Option-h, j, k and l type these four characters.
  it.each([
    ["M-h", "˙"],
    ["M-j", "∆"],
    ["M-k", "˚"],
    ["M-l", "¬"],
  ])("is the chord %s for a resize key of the config that typed %s", (chord, typed) => {
    expect(strokeForKeymap(VI_STYLE, chord, typed)).toBe(chord);
  });

  it("is the chord of a root key that typed a character", () => {
    const keymap = keymapOf("bind -n M-h select-pane -L");

    expect(strokeForKeymap(keymap, "M-h", "˙")).toBe("M-h");
  });

  it("knows the characters of every table", () => {
    expect(strokeForKeymap(VI_STYLE, "M-S-7", "?")).toBe("?");
    expect(strokeForKeymap(VI_STYLE, "M-S-7", "$")).toBe("$");
    expect(strokeForKeymap(VI_STYLE, "M-S-7", "G")).toBe("G");
  });

  it("never takes a key press with Ctrl, Alt or Cmd for the plain i", () => {
    expect(strokeForKeymap(STOCK, "M-i", null)).toBe("M-i");
    expect(strokeForKeymap(STOCK, "M-S-8", "i")).toBe("M-S-8");
    expect(strokeForKeymap(STOCK, "C-M-8", "i")).toBe("C-M-8");
  });
});

describe("describeKeymap for stock tmux", () => {
  const sections = describeKeymap(STOCK, DEFAULT_SETTINGS);
  const afterPrefix = sectionRows(sections, "After the prefix");
  const copyMode = sectionRows(sections, "Copy mode, emacs keys");

  it("lists the sections in order, and none for the keys without the prefix, of which there are none", () => {
    expect(sections.map((section) => section.title)).toEqual([
      "After the prefix",
      "Outside a text field",
      "Copy mode, emacs keys",
      "On a thread in the sidebar",
      "In the thread chooser",
    ]);
  });

  it("shows the keys of tmux's prefix table with the prefix in front of them", () => {
    expect(afterPrefix).toEqual({
      "Ctrl-b Ctrl-b": "Send Ctrl-b itself to the terminal or text field",
      'Ctrl-b "': "Choose a thread, or the New thread row, for a new pane below",
      "Ctrl-b %":
        "Choose a thread, or the New thread row, for a new pane to the right",
      "Ctrl-b 0-9": "Jump to thread 1-10, in sidebar order",
      "Ctrl-b ;": "Focus the pane that had the focus before",
      "Ctrl-b ?": "Show this help",
      "Ctrl-b [": "Enter copy mode to scroll, select and copy conversation text",
      "Ctrl-b c": "Start a new thread in this pane",
      "Ctrl-b l": "Go to the thread that this pane showed before",
      "Ctrl-b n": "Go to the next thread",
      "Ctrl-b o":
        "Focus the next pane in the order of the splits, and the first one after the last",
      "Ctrl-b p": "Go to the previous thread",
      "Ctrl-b s / w": "Choose a thread to open in this pane",
      "Ctrl-b x": "Close this pane",
      "Ctrl-b z": "Zoom or unzoom this pane",
      "Ctrl-b PageUp": "Enter copy mode and scroll one page up",
      "Ctrl-b Up": "Focus the pane above (repeats)",
      "Ctrl-b Down": "Focus the pane below (repeats)",
      "Ctrl-b Left":
        "Focus the pane to the left, or the sidebar from the leftmost pane (repeats)",
      "Ctrl-b Right": "Focus the pane to the right (repeats)",
      "Ctrl-b Alt-Up":
        "Resize this pane by moving its divider up by 5 cells (repeats)",
      "Ctrl-b Alt-Down":
        "Resize this pane by moving its divider down by 5 cells (repeats)",
      "Ctrl-b Alt-Left":
        "Resize this pane by moving its divider to the left by 5 cells (repeats)",
      "Ctrl-b Alt-Right":
        "Resize this pane by moving its divider to the right by 5 cells (repeats)",
      "Ctrl-b Ctrl-Up":
        "Resize this pane by moving its divider up by 1 cell (repeats)",
      "Ctrl-b Ctrl-Down":
        "Resize this pane by moving its divider down by 1 cell (repeats)",
      "Ctrl-b Ctrl-Left":
        "Resize this pane by moving its divider to the left by 1 cell (repeats)",
      "Ctrl-b Ctrl-Right":
        "Resize this pane by moving its divider to the right by 1 cell (repeats)",
      "(repeats)":
        "After such a key, every key with this mark works without the prefix for 0.5 seconds",
      "Ctrl-b any other key": "Cancel the prefix",
    });
  });

  it.each(["Ctrl-b d", "Ctrl-b :", "Ctrl-b Space", "Ctrl-b !", "Ctrl-b ]", "Ctrl-b {"])(
    "does not show %s, which tmux binds to a command bb has no equivalent for",
    (keys) => {
      expect(Object.keys(afterPrefix)).not.toContain(keys);
    },
  );

  it("shows i, without the prefix in front of it, as the one key outside a text field", () => {
    expect(sectionRows(sections, "Outside a text field")).toEqual({
      i: "Put the text cursor in the message box of the focused pane",
    });
  });

  it("shows the emacs keys of copy mode, with the keys that do the same on one row", () => {
    expect(copyMode).toEqual({
      "Ctrl-Space": "Start selecting from the cursor",
      "Ctrl-a / Home": "Move to the start of the line",
      "Ctrl-c / Escape / q": "Leave copy mode without copying",
      "Ctrl-e / End": "Move to the end of the line",
      "Ctrl-f / Right": "Move right one character",
      "Ctrl-g": "Drop the selection",
      "Ctrl-n / Down": "Move down one line",
      "Ctrl-p / Up": "Move up one line",
      "Ctrl-v / Space / PageDown": "Move down one page",
      "Ctrl-w / Alt-w": "Copy the selection and leave copy mode",
      "PageUp / Alt-v": "Move up one page",
      Left: "Move left one character",
      "Ctrl-b Ctrl-b": "Move left one character",
      "Alt-<": "Move to the start of the conversation",
      "Alt->": "Move to the end of the conversation",
      "Alt-Shift-r": "Move to the top visible line",
      "Alt-b": "Move to the previous word",
      "Alt-f": "Move to the end of the word",
      "Alt-m": "Move to the first character of the line that is not a blank",
      "Alt-r": "Move to the middle visible line",
      "Alt-{": "Move to the previous paragraph",
      "Alt-}": "Move to the next paragraph",
      "Alt-Up": "Move up half a page",
      "Alt-Down": "Move down half a page",
      "Ctrl-Up": "Scroll the conversation up one step",
      "Ctrl-Down": "Scroll the conversation down one step",
    });
  });

  it("shows the list keys of tmux for a thread row of the sidebar, and the split keys of the prefix table", () => {
    expect(sectionRows(sections, "On a thread in the sidebar")).toEqual({
      "Up / k / Ctrl-p": "Move to the previous thread",
      "Down / j / Ctrl-n": "Move to the next thread",
      PageUp: "Move up one page",
      "PageDown / Ctrl-f": "Move down one page",
      "g / Home": "Move to the first thread",
      "G / End": "Move to the last thread",
      Enter: "Open the thread in the focused pane",
      "q / Escape / Ctrl-g": "Return to the pane",
      "%": "Open the thread in a new pane to the right",
      '"': "Open the thread in a new pane below",
    });
  });

  it("shows the keys of the thread chooser, where Ctrl-b is a list key because the prefix does not work there", () => {
    expect(sectionRows(sections, "In the thread chooser")).toEqual({
      "Up / k / Ctrl-p": "Move to the previous thread",
      "Down / j / Ctrl-n": "Move to the next thread",
      "PageUp / Ctrl-b": "Move up one page",
      "PageDown / Ctrl-f": "Move down one page",
      "g / Home": "Move to the first thread",
      "G / End": "Move to the last thread",
      Enter: "Open the thread where the chooser was asked to",
      "q / Escape / Ctrl-g": "Close the chooser",
      "%": "Open the thread in a new pane to the right",
      '"': "Open the thread in a new pane below",
      c: "Start a new thread in the new pane that the chooser was opened for",
      "/": "Filter the threads by title or project",
    });
  });

  it("names the Alt key Option on a Mac, and changes nothing but that name", () => {
    const onMac = describeKeymap(STOCK, DEFAULT_SETTINGS, true);

    expect(sectionRows(onMac, "After the prefix")["Ctrl-b Option-Up"]).toBe(
      "Resize this pane by moving its divider up by 5 cells (repeats)",
    );
    expect(helpText(onMac).replaceAll("Option-", "Alt-")).toBe(helpText(sections));
  });

  it("says which order the thread numbers follow", () => {
    const recent = describeKeymap(STOCK, settingsWith({ threadOrder: "recent" }));

    expect(sectionRows(recent, "After the prefix")["Ctrl-b 0-9"]).toBe(
      "Jump to thread 1-10, most recent first",
    );
  });

  it("never uses an em dash in the help text", () => {
    expect(helpText(sections)).not.toContain(EM_DASH);
  });
});

describe("describeKeymap for a tmux config in the vi style", () => {
  const sections = describeKeymap(VI_STYLE, DEFAULT_SETTINGS);
  const afterPrefix = sectionRows(sections, "After the prefix");

  it("shows the keys of the config next to the stock keys that do the same", () => {
    expect(afterPrefix).toMatchObject({
      'Ctrl-a " / s': "Choose a thread, or the New thread row, for a new pane below",
      "Ctrl-a % / v":
        "Choose a thread, or the New thread row, for a new pane to the right",
      "Ctrl-a 1-9": "Jump to thread 1-9, in sidebar order",
      "Ctrl-a w": "Choose a thread to open in this pane",
      "Ctrl-a Alt-Left / Alt-h":
        "Resize this pane by moving its divider to the left by 5 cells (repeats)",
      "Ctrl-a Ctrl-a": "Send Ctrl-a itself to the terminal or text field",
      "Ctrl-a h":
        "Focus the pane to the left, or the sidebar from the leftmost pane",
      "Ctrl-a j": "Focus the pane below",
      "Ctrl-a k": "Focus the pane above",
      "Ctrl-a l": "Focus the pane to the right",
      "Ctrl-a r":
        'Read the tmux config again, then show the notice "Config reloaded"',
      "Ctrl-a any other key": "Cancel the prefix",
    });
  });

  it.each(["Ctrl-a Ctrl-b", "Ctrl-a 0", "Ctrl-a 0-9", "Ctrl-b Ctrl-b"])(
    "does not show %s",
    (keys) => {
      expect(Object.keys(afterPrefix)).not.toContain(keys);
    },
  );

  it("shows the vi keys of copy mode with the selection and copy keys of the config", () => {
    expect(sectionRows(sections, "Copy mode, vi keys")).toEqual({
      "Ctrl-c / q / Escape": "Leave copy mode without copying",
      "Ctrl-d": "Move down half a page",
      "Ctrl-e / J / Ctrl-Down": "Scroll the conversation down one step",
      "Ctrl-b / PageUp": "Move up one page",
      "Ctrl-f / PageDown": "Move down one page",
      "Ctrl-h / h / Backspace / Left": "Move left one character",
      "Ctrl-j / Enter / y": "Copy the selection and leave copy mode",
      "Ctrl-u": "Move up half a page",
      "Ctrl-y / K / Ctrl-Up": "Scroll the conversation up one step",
      "Space / v": "Start selecting from the cursor",
      "$ / End": "Move to the end of the line",
      "0 / Home": "Move to the start of the line",
      G: "Move to the end of the conversation",
      H: "Move to the top visible line",
      L: "Move to the bottom visible line",
      M: "Move to the middle visible line",
      "^": "Move to the first character of the line that is not a blank",
      b: "Move to the previous word",
      e: "Move to the end of the word",
      g: "Move to the start of the conversation",
      "j / Down": "Move down one line",
      "k / Up": "Move up one line",
      "l / Right": "Move right one character",
      w: "Move to the next word",
      "{": "Move to the previous paragraph",
      "}": "Move to the next paragraph",
    });
  });

  it("shows the split keys of the config in the lists", () => {
    expect(sectionRows(sections, "On a thread in the sidebar")).toMatchObject({
      "PageUp / Ctrl-b": "Move up one page",
      "% / v": "Open the thread in a new pane to the right",
      '" / s': "Open the thread in a new pane below",
    });
    expect(sectionRows(sections, "In the thread chooser")).toMatchObject({
      "% / v": "Open the thread in a new pane to the right",
      '" / s': "Open the thread in a new pane below",
      c: "Start a new thread in the new pane that the chooser was opened for",
    });
  });

  it("never uses an em dash in the help text", () => {
    expect(helpText(sections)).not.toContain(EM_DASH);
  });
});

describe("describeKeymap: what a line of the tmux config changes", () => {
  function rowsOf(text: string, title = "After the prefix"): Record<string, string> {
    return sectionRows(describeKeymap(keymapOf(text), DEFAULT_SETTINGS), title);
  }

  it("does not show a key that is bound to a command without equivalent", () => {
    const rows = rowsOf("bind x kill-server\nbind X run-shell 'echo hi'");

    expect(Object.keys(rows)).not.toContain("Ctrl-b x");
    expect(Object.keys(rows)).not.toContain("Ctrl-b X");
  });

  it("does not show a key that the config unbinds", () => {
    expect(Object.keys(rowsOf("unbind z"))).not.toContain("Ctrl-b z");
  });

  it("leaves a list key that a key without the prefix takes out of the sidebar keys, where that key comes first", () => {
    const text = "bind -n C-n next-window\nbind -n C-g kill-pane";
    const keymap = keymapOf(text);
    const rows = rowsOf(text, "On a thread in the sidebar");

    expect(actionsOf(keymap.sidebarBindings, "C-n")).toBeUndefined();
    expect(actionsOf(keymap.sidebarBindings, "C-g")).toBeUndefined();
    expect(actionsOf(keymap.sidebarBindings, "C-p")).toEqual(LIST_ACTIONS["C-p"]);
    expect(rows).toMatchObject({
      "Down / j": "Move to the next thread",
      "Up / k / Ctrl-p": "Move to the previous thread",
      "q / Escape": "Return to the pane",
    });
    expect(rowsOf(text, "Without the prefix")).toMatchObject({
      "Ctrl-n": "Go to the next thread",
    });
    expect(rowsOf(text, "In the thread chooser")).toMatchObject({
      "Down / j / Ctrl-n": "Move to the next thread",
    });
  });

  it("keeps the list key of a sidebar row whose key without the prefix has no equivalent", () => {
    const text = "bind -n C-n clock-mode";

    expect(actionsOf(keymapOf(text).sidebarBindings, "C-n")).toEqual(LIST_ACTIONS["C-n"]);
    expect(rowsOf(text, "On a thread in the sidebar")).toMatchObject({
      "Down / j / Ctrl-n": "Move to the next thread",
    });
  });

  it("lists the copy binding of the prefix key with the prefix in front of it, which is how it is reached", () => {
    const space = "set -g prefix C-Space\nbind C-Space send-prefix";

    expect(rowsOf(space, "Copy mode, emacs keys")).toMatchObject({
      "Ctrl-Space Ctrl-Space": "Start selecting from the cursor",
    });
    expect(rowsOf("setw -g mode-keys vi", "Copy mode, vi keys")).toMatchObject({
      "Ctrl-b Ctrl-b": "Move up one page",
    });
  });

  it.each([
    ["set -g prefix C-Space", "Ctrl-Space Ctrl-Space"],
    ["set -g prefix C-s\nbind C-s send-prefix", "Ctrl-s Ctrl-s"],
  ])("does not list a copy binding for %j, which cannot be reached or does nothing", (text, keys) => {
    expect(Object.keys(rowsOf(text, "Copy mode, emacs keys"))).not.toContain(keys);
  });

  it("says that a key after the prefix can be one that works without the prefix, when there is one", () => {
    expect(rowsOf("bind -n M-h select-pane -L")).toMatchObject({
      "Ctrl-b any other key":
        "Cancel the prefix, or do what the key does without the prefix",
    });
    expect(rowsOf("bind -n M-h rotate-window\nbind -n h select-pane -L")).toMatchObject({
      "Ctrl-b any other key": "Cancel the prefix",
    });
  });

  it("lists the keys that work without the prefix in a section of their own", () => {
    expect(
      rowsOf("bind -n M-Left select-pane -L\nbind -n h select-pane -L", "Without the prefix"),
    ).toEqual({
      "Alt-Left":
        "Focus the pane to the left, or the sidebar from the leftmost pane",
    });
  });

  it("gives each thread number a row of its own when the keys do not count on", () => {
    const rows = rowsOf("unbind 3\nbind 5 select-window -t :=9");

    expect(rows).toMatchObject({
      "Ctrl-b 0": "Jump to thread 1, in sidebar order",
      "Ctrl-b 4": "Jump to thread 5, in sidebar order",
      "Ctrl-b 5": "Jump to thread 10, in sidebar order",
    });
    expect(Object.keys(rows)).not.toContain("Ctrl-b 0-9");
    expect(Object.keys(rows)).not.toContain("Ctrl-b 3");
  });

  it("describes the keys for the first and the last thread, with the order they follow", () => {
    const config = "bind ^ select-window -t ^\nbind e select-window -t '{end}'";

    expect(rowsOf(config)).toMatchObject({
      "Ctrl-b ^": "Jump to thread 1, in sidebar order",
      "Ctrl-b e": "Jump to the last thread, in sidebar order",
    });
    expect(
      sectionRows(
        describeKeymap(keymapOf(config), settingsWith({ threadOrder: "recent" })),
        "After the prefix",
      )["Ctrl-b e"],
    ).toBe("Jump to the last thread, most recent first");
  });

  it("describes a key for the pane that tmux finds on one side in a row of its own, in the words of the key that moves there", () => {
    const rows = rowsOf("bind -r e select-pane -t '{up-of}'");

    expect(rows).toMatchObject({
      "Ctrl-b Up": "Focus the pane above (repeats)",
      "Ctrl-b e": "Focus the pane above (repeats)",
    });
    expect(Object.keys(rows)).not.toContain("Ctrl-b Up / e");
  });

  it("says of a key for the pane that tmux finds on the left that it goes around the window, where the key for a move to the left names the sidebar", () => {
    expect(rowsOf("bind e select-pane -t '{left-of}'")).toMatchObject({
      "Ctrl-b Left":
        "Focus the pane to the left, or the sidebar from the leftmost pane (repeats)",
      "Ctrl-b e":
        "Focus the pane to the left, or the rightmost pane from the leftmost one",
    });
  });

  it.each([
    ["{down-of}", "Focus the pane below"],
    ["{right-of}", "Focus the pane to the right"],
  ])("describes a key for the pane that tmux finds with %s", (name, description) => {
    expect(rowsOf(`bind e select-pane -t '${name}'`)["Ctrl-b e"]).toBe(description);
  });

  it("says nothing about repeating when repeat-time is 0", () => {
    const rows = rowsOf("set -g repeat-time 0");

    expect(rows["Ctrl-b Up"]).toBe("Focus the pane above");
    expect(Object.keys(rows)).not.toContain("(repeats)");
  });

  it("says how long the keys repeat, in whole seconds too", () => {
    expect(rowsOf("set -g repeat-time 1000")["(repeats)"]).toBe(
      "After such a key, every key with this mark works without the prefix for 1 second",
    );
    expect(rowsOf("set -g repeat-time 2000")["(repeats)"]).toBe(
      "After such a key, every key with this mark works without the prefix for 2 seconds",
    );
  });

  it("says once what a key does that runs the same command several times", () => {
    const rows = rowsOf(
      "setw -g mode-keys vi\nbind -T copy-mode-vi J send -X -N 5 cursor-down",
      "Copy mode, vi keys",
    );

    expect(rows.J).toBe("Move down one line, 5 times");
  });

  it("describes the other commands that bb has an equivalent for", () => {
    const rows = rowsOf(
      [
        "bind a select-pane -t :.-",
        "bind b kill-pane",
        "bind e display-message hello",
        "bind -T copy-mode C-o send -X copy-selection",
        "bind -T copy-mode C-t send -X copy-selection-no-clear",
      ].join("\n"),
    );

    expect(rows).toMatchObject({
      "Ctrl-b a":
        "Focus the previous pane in the order of the splits, and the last one before the first",
      "Ctrl-b x / b": "Close this pane",
      "Ctrl-b e": 'Show the notice "hello"',
    });
    expect(
      rowsOf(
        "bind -T copy-mode C-o send -X copy-selection\nbind -T copy-mode C-t send -X copy-selection-no-clear",
        "Copy mode, emacs keys",
      ),
    ).toMatchObject({
      "Ctrl-o": "Copy the selection and drop it",
      "Ctrl-t": "Copy the selection and keep it",
    });
  });

  it("describes copy-mode -d, copy-mode -q and a pane or window named as the last one", () => {
    const rows = rowsOf(
      [
        "bind a copy-mode -d",
        "bind b copy-mode -q",
        "bind e select-pane -t '{last}'",
        "bind f select-window -t !",
      ].join("\n"),
    );

    expect(rows).toMatchObject({
      "Ctrl-b a": "Enter copy mode and scroll one page down",
      "Ctrl-b b": "Leave copy mode without copying",
      "Ctrl-b ; / e": "Focus the pane that had the focus before",
      "Ctrl-b l / f": "Go to the thread that this pane showed before",
    });
  });
});

describe("describeKeymapPrefix", () => {
  function source(config: TmuxConfig, isFromServer = true): TmuxSource {
    return { config, isFromServer };
  }

  function prefixLine(config: TmuxConfig, isFromServer = true): string {
    return describeKeymapPrefix(buildKeymap(config), source(config, isFromServer));
  }

  it("says that the prefix is tmux's default when no config sets one", () => {
    expect(prefixLine(stockTmuxConfig())).toBe(
      "Prefix: Ctrl-b, tmux's default (no tmux config sets a prefix)",
    );
  });

  it("names the file that sets the prefix", () => {
    expect(prefixLine(tmuxConfigOf(VI_STYLE_CONFIG))).toBe(
      `Prefix: Ctrl-a, from ${TEST_CONFIG_PATH}`,
    );
  });

  it("says which prefix of the config cannot be used", () => {
    expect(prefixLine(tmuxConfigOf("set -g prefix `"))).toBe(
      `Prefix: Ctrl-b, tmux's default (the prefix \` in ${TEST_CONFIG_PATH} cannot be used in bb)`,
    );
  });

  it("keeps Ctrl-b and names the prefix and the second prefix on the Turkish capital dotted I, which cannot be used", () => {
    const config = tmuxConfigOf("set -g prefix C-\u0130\nset -g prefix2 M-\u0130");
    const keymap = buildKeymap(config);

    expect(keymap.prefix).toBe("C-b");
    expect(keymap.prefix2).toBeNull();
    expect(prefixLine(config)).toBe(
      `Prefix: Ctrl-b, tmux's default (the prefix C-\u0130 in ${TEST_CONFIG_PATH} cannot be used in bb). The second prefix M-\u0130 in ${TEST_CONFIG_PATH} cannot be used in bb`,
    );
  });

  it("says that the config could not be read when the server gave no answer", () => {
    expect(prefixLine(stockTmuxConfig(), false)).toBe(
      "Prefix: Ctrl-b, tmux's default (the tmux config could not be read)",
    );
  });

  it("says that the config could not be read when a file that may set the prefix was not read", () => {
    expect(prefixLine({ ...stockTmuxConfig(), unreadable: true })).toBe(
      "Prefix: Ctrl-b, tmux's default (the tmux config could not be read)",
    );
  });

  it("says that a part of the config could not be read when a file was applied that sets no prefix, and another source that may set one was not read", () => {
    const applied = tmuxConfigOf("set -g mouse on");
    const partly =
      "Prefix: Ctrl-b, tmux's default (part of the tmux config could not be read and may set another one)";

    expect(prefixLine(applied)).toBe(
      "Prefix: Ctrl-b, tmux's default (no tmux config sets a prefix)",
    );
    expect(prefixLine({ ...applied, unreadable: true })).toBe(partly);
    expect(prefixLine({ ...applied, pastedText: "unreadable" })).toBe(partly);
    expect(
      prefixLine({ ...applied, namedFile: true, pastedText: "unreadable" }),
    ).toBe(partly);
  });

  it("says the same when the pasted text was applied and sets no prefix, and a file was not read", () => {
    const partly =
      "Prefix: Ctrl-b, tmux's default (part of the tmux config could not be read and may set another one)";

    expect(
      prefixLine(configWithPastedText("set -g mouse on", { unreadable: true })),
    ).toBe(partly);
    expect(
      prefixLine(
        configWithPastedText("set -g mouse on", { unreadable: true, namedFile: true }),
      ),
    ).toBe(partly);
  });

  it("still names the file that sets the prefix when another file was not read", () => {
    expect(prefixLine({ ...tmuxConfigOf(VI_STYLE_CONFIG), unreadable: true })).toBe(
      `Prefix: Ctrl-a, from ${TEST_CONFIG_PATH}`,
    );
  });

  it("names the second prefix", () => {
    expect(prefixLine(tmuxConfigOf("set -g prefix2 M-s"))).toBe(
      "Prefix: Ctrl-b, tmux's default (no tmux config sets a prefix). Second prefix: Alt-s",
    );
  });

  it("says which second prefix of the config cannot be used", () => {
    expect(prefixLine(tmuxConfigOf("set -g prefix2 `"))).toBe(
      `Prefix: Ctrl-b, tmux's default (no tmux config sets a prefix). The second prefix \` in ${TEST_CONFIG_PATH} cannot be used in bb`,
    );
    expect(prefixLine(configWithPastedText("set -g prefix C-a\nset -g prefix2 a"))).toBe(
      "Prefix: Ctrl-a, from the Config text setting. The second prefix a in the Config text setting cannot be used in bb",
    );
  });

  it.each(["set -g prefix2 None", "set -g prefix2 C-b", "set -g prefix C-a\nset -g prefix2 C-a"])(
    "says nothing about a second prefix for %j, which is none or the prefix itself",
    (text) => {
      expect(prefixLine(tmuxConfigOf(text))).not.toContain("econd prefix");
    },
  );

  it("names the Config text setting when its lines set the prefix, also after a file has set one", () => {
    expect(prefixLine(configWithPastedText("set -g prefix C-s"))).toBe(
      "Prefix: Ctrl-s, from the Config text setting",
    );
    expect(
      prefixLine(
        configWithPastedText(
          "set -g prefix C-Space",
          fileSources([{ path: TEST_CONFIG_PATH, text: VI_STYLE_CONFIG }]),
        ),
      ),
    ).toBe("Prefix: Ctrl-Space, from the Config text setting");
    expect(prefixLine(configWithPastedText("set -g prefix `"))).toBe(
      "Prefix: Ctrl-b, tmux's default (the prefix ` in the Config text setting cannot be used in bb)",
    );
  });

  it("says that the config could not be read when the chosen file or the pasted text, which may set the prefix, was not read", () => {
    expect(
      prefixLine({ ...stockTmuxConfig(), unreadable: true, namedFile: true }),
    ).toBe("Prefix: Ctrl-b, tmux's default (the tmux config could not be read)");
    expect(prefixLine({ ...stockTmuxConfig(), pastedText: "unreadable" })).toBe(
      "Prefix: Ctrl-b, tmux's default (the tmux config could not be read)",
    );
  });

  it("still names the file that sets the prefix when the pasted text was not read", () => {
    expect(
      prefixLine({ ...tmuxConfigOf(VI_STYLE_CONFIG), pastedText: "unreadable" }),
    ).toBe(`Prefix: Ctrl-a, from ${TEST_CONFIG_PATH}`);
  });

  it("is one line without an em dash", () => {
    for (const text of ["", "set -g prefix `", "set -g prefix2 M-s", VI_STYLE_CONFIG]) {
      const line = prefixLine(tmuxConfigOf(text));

      expect(line).not.toContain(EM_DASH);
      expect(line).not.toContain("\n");
    }
  });
});

describe("describeTerminalKeys", () => {
  it("says in one sentence which keys work as Escape, Enter and Tab, and where", () => {
    expect(describeTerminalKeys()).toBe(
      "As in a terminal, Ctrl-[, Ctrl-m and Ctrl-i work as Escape, Enter and Tab in copy mode, in the thread chooser and here, and Ctrl-[ and Ctrl-m as Escape and Enter on a thread in the sidebar, unless the key itself is bound there.",
    );
    expect(describeTerminalKeys()).not.toContain(EM_DASH);
  });

  it("names for the sidebar the keys that a thread row takes there, which Ctrl-i is not", () => {
    const onRow = / here, and (.*) on a thread in the sidebar/.exec(describeTerminalKeys())?.[1];

    for (const [stroke, key] of TERMINAL_KEYS) {
      const isKeyOfRow = STOCK.sidebarBindings.some((binding) => binding.key === key);
      expect(onRow?.includes(formatStroke(stroke)), stroke).toBe(isKeyOfRow);
    }
    expect(onRow).toBe("Ctrl-[ and Ctrl-m as Escape and Enter");
  });
});

describe("describeSource", () => {
  it("says that stock tmux is in use when no config was found", () => {
    expect(describeSource({ config: stockTmuxConfig(), isFromServer: true })).toBe(
      "No tmux config was found, so these are the keys of stock tmux.",
    );
  });

  it("names the config file that was read", () => {
    expect(
      describeSource({ config: tmuxConfigOf(VI_STYLE_CONFIG), isFromServer: true }),
    ).toBe(`The keys of stock tmux with ${TEST_CONFIG_PATH} applied to them.`);
  });

  it("names every config file that was read", () => {
    const config = {
      ...tmuxConfigOf(VI_STYLE_CONFIG),
      files: ["~/.tmux.conf", "~/.config/tmux/tmux.conf"],
    };

    expect(describeSource({ config, isFromServer: true })).toBe(
      "The keys of stock tmux with ~/.tmux.conf and ~/.config/tmux/tmux.conf applied to them.",
    );
  });

  it("says so when a config file is there but could not be read", () => {
    expect(
      describeSource({
        config: { ...stockTmuxConfig(), unreadable: true },
        isFromServer: true,
      }),
    ).toBe(
      "A tmux config is there but could not be read, so these are the keys of stock tmux.",
    );
    expect(
      describeSource({
        config: { ...tmuxConfigOf(VI_STYLE_CONFIG), unreadable: true },
        isFromServer: true,
      }),
    ).toBe(
      `The keys of stock tmux with ${TEST_CONFIG_PATH} applied to them. Another tmux config is there but could not be read.`,
    );
  });

  it("says that the config could not be read when the server gave no answer", () => {
    expect(describeSource({ config: stockTmuxConfig(), isFromServer: false })).toBe(
      "The tmux config could not be read, so these are the keys of stock tmux.",
    );
  });

  describe("with a chosen config file and the Config text setting", () => {
    const NAMED = "~/made-up/tmux.conf";
    const NAMED_FILE = { path: NAMED, text: "bind g kill-pane" };
    const NOT_READ = { unreadable: true, namedFile: true };

    function sourceLine(config: TmuxConfig): string {
      return describeSource({ config, isFromServer: true });
    }

    it("names the Config text setting after the files, in the order they are applied in", () => {
      const files = [
        { path: "~/.tmux.conf", text: "" },
        { path: "~/.config/tmux/tmux.conf", text: "" },
      ];

      expect(
        sourceLine(configWithPastedText("bind g kill-pane", fileSources(files))),
      ).toBe(
        "The keys of stock tmux with ~/.tmux.conf, ~/.config/tmux/tmux.conf and the Config text setting applied to them.",
      );
    });

    it("names the Config text setting alone when no file was read", () => {
      expect(sourceLine(configWithPastedText("bind g kill-pane"))).toBe(
        "The keys of stock tmux with the Config text setting applied to them.",
      );
    });

    it("names the chosen config file by its path, as the one chosen in the plugin's settings", () => {
      const config = tmuxConfigFrom(
        { ...fileSources([NAMED_FILE]), namedFile: true },
        { visual: undefined, editor: undefined },
      );

      expect(sourceLine(config)).toBe(
        `The keys of stock tmux with ${NAMED} (chosen in the plugin's settings) applied to them.`,
      );
      expect(
        sourceLine(
          configWithPastedText("bind G kill-pane", {
            files: [NAMED_FILE],
            namedFile: true,
          }),
        ),
      ).toBe(
        `The keys of stock tmux with ${NAMED} (chosen in the plugin's settings) and the Config text setting applied to them.`,
      );
    });

    it("names a file of tmux's usual places without that mark", () => {
      expect(sourceLine(tmuxConfigOf(VI_STYLE_CONFIG))).toBe(
        `The keys of stock tmux with ${TEST_CONFIG_PATH} applied to them.`,
      );
    });

    it("says that the config file chosen in the plugin's settings could not be read", () => {
      expect(sourceLine({ ...stockTmuxConfig(), ...NOT_READ })).toBe(
        "The config file chosen in the plugin's settings could not be read, so these are the keys of stock tmux.",
      );
    });

    it("says so after the pasted text, which is applied all the same", () => {
      expect(sourceLine(configWithPastedText("bind g kill-pane", NOT_READ))).toBe(
        "The keys of stock tmux with the Config text setting applied to them. The config file chosen in the plugin's settings could not be read.",
      );
    });

    it("names no setting for the config file, because there is none", () => {
      const lines = [
        sourceLine({ ...stockTmuxConfig(), ...NOT_READ }),
        sourceLine(configWithPastedText("bind g kill-pane", NOT_READ)),
        sourceLine(
          tmuxConfigFrom(
            { ...fileSources([NAMED_FILE]), namedFile: true },
            { visual: undefined, editor: undefined },
          ),
        ),
      ];

      for (const line of lines) expect(line).not.toContain("Config file setting");
    });

    it("says that a config of tmux's own places is there but could not be read, also next to the pasted text", () => {
      expect(
        sourceLine(configWithPastedText("bind g kill-pane", { unreadable: true })),
      ).toBe(
        "The keys of stock tmux with the Config text setting applied to them. A tmux config is there but could not be read.",
      );
    });

    it("says that the pasted text is too large to be read", () => {
      expect(sourceLine({ ...stockTmuxConfig(), pastedText: "unreadable" })).toBe(
        "The Config text setting is too large to be read, so these are the keys of stock tmux.",
      );
      expect(
        sourceLine({ ...tmuxConfigOf(VI_STYLE_CONFIG), pastedText: "unreadable" }),
      ).toBe(
        `The keys of stock tmux with ${TEST_CONFIG_PATH} applied to them. The Config text setting is too large to be read.`,
      );
    });

    it("names both when neither the file nor the pasted text could be read", () => {
      expect(
        sourceLine({ ...stockTmuxConfig(), ...NOT_READ, pastedText: "unreadable" }),
      ).toBe(
        "The config file chosen in the plugin's settings could not be read, and the Config text setting is too large to be read, so these are the keys of stock tmux.",
      );
      expect(
        sourceLine({
          ...tmuxConfigOf(VI_STYLE_CONFIG),
          unreadable: true,
          pastedText: "unreadable",
        }),
      ).toBe(
        `The keys of stock tmux with ${TEST_CONFIG_PATH} applied to them. Another tmux config is there but could not be read. The Config text setting is too large to be read.`,
      );
    });

    it("never repeats a line of the pasted text", () => {
      const line = sourceLine(configWithPastedText("bind g kill-pane"));

      expect(line).not.toContain("kill-pane");
      expect(line).not.toContain(EM_DASH);
    });
  });
});
