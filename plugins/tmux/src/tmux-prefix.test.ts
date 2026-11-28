import { describe, expect, it } from "vitest";
import { buildKeymap } from "./keymap";
import type { TmuxPrefix } from "./prefix";
import {
  resolveTmuxConfig,
  stockTmuxConfig,
  type TmuxConfigFile,
} from "./tmux-keymap";
import { strokeFromTmuxKey } from "./tmux-syntax";

const HOME_CONFIG = "~/.tmux.conf";
const XDG_CONFIG = "~/.config/tmux/tmux.conf";

// tmux runs the files one after another, so the last command that sets or
// unsets the prefix decides. null when nothing sets it.
function prefixFromTmuxConfigs(
  files: readonly TmuxConfigFile[],
): TmuxPrefix | null {
  return resolveTmuxConfig(files).options.prefix;
}

function parse(text: string): TmuxPrefix | null {
  return prefixFromTmuxConfigs([{ path: HOME_CONFIG, text }]);
}

function usable(key: string, path = HOME_CONFIG): TmuxPrefix {
  return { key, path, usable: true };
}

function unusable(key: string, path = HOME_CONFIG): TmuxPrefix {
  return { key, path, usable: false };
}

// The translations of tmux keys that can serve as a prefix in bb.
const USABLE_KEYS: [string, string][] = [
  ["C-a", "C-a"],
  ["C-b", "C-b"],
  ["C-A", "C-a"],
  ["c-a", "C-a"],
  ["^a", "C-a"],
  ["^A", "C-a"],
  ["^^", "C-^"],
  ["M-a", "M-a"],
  ["m-a", "M-a"],
  ["M-A", "M-S-a"],
  ["C-M-a", "C-M-a"],
  ["M-C-a", "C-M-a"],
  ["C-M-A", "C-M-a"],
  ["C-S-a", "C-S-a"],
  ["M-S-a", "M-S-a"],
  ["C-Space", "C-Space"],
  ["C-space", "C-Space"],
  ["C-SPACE", "C-Space"],
  ["M-Space", "M-Space"],
  ["C- ", "C-Space"],
  ["C-@", "C-Space"],
  ["^@", "C-Space"],
  ["C-M-@", "C-M-Space"],
  ["M-@", "M-@"],
  ["F12", "F12"],
  ["f1", "F1"],
  ["S-F5", "S-F5"],
  ["C-F3", "C-F3"],
  ["C-Up", "C-ArrowUp"],
  ["C-Down", "C-ArrowDown"],
  ["M-Left", "M-ArrowLeft"],
  ["M-right", "M-ArrowRight"],
  ["C-BSpace", "C-Backspace"],
  ["C-BTab", "C-S-Tab"],
  ["C-DC", "C-Delete"],
  ["C-Delete", "C-Delete"],
  ["C-IC", "C-Insert"],
  ["C-Insert", "C-Insert"],
  ["C-Home", "C-Home"],
  ["C-End", "C-End"],
  ["C-NPage", "C-PageDown"],
  ["C-PageDown", "C-PageDown"],
  ["C-PgDn", "C-PageDown"],
  ["C-PPage", "C-PageUp"],
  ["C-PageUp", "C-PageUp"],
  ["C-pgup", "C-PageUp"],
  ["C-Enter", "C-Enter"],
  ["C-Escape", "C-Escape"],
  ["C-Tab", "C-Tab"],
  ["C-\\", "C-\\"],
  ["C-]", "C-]"],
  ["C--", "C--"],
  ["C-+", "C-+"],
  ["C-;", "C-;"],
  ["C-$", "C-$"],
  ["M-`", "M-`"],
];

// Keys that translate, but that would be taken away from typing.
const PLAIN_KEYS: [string, string][] = [
  ["`", "`"],
  ["a", "a"],
  ["A", "A"],
  ["S-a", "A"],
  ["^", "^"],
  ["@", "@"],
  ["-", "-"],
  [" ", "Space"],
  ["Space", "Space"],
  ["Tab", "Tab"],
  ["BTab", "S-Tab"],
  ["btab", "S-Tab"],
  ["Enter", "Enter"],
  ["Escape", "Escape"],
  ["Home", "Home"],
  ["Up", "ArrowUp"],
  ["S-Up", "S-ArrowUp"],
  ["BSpace", "Backspace"],
  ["DC", "Delete"],
  ["IC", "Insert"],
  ["NPage", "PageDown"],
  ["PPage", "PageUp"],
];

const UNKNOWN_KEYS = [
  "",
  "None",
  "none",
  "C-",
  "M-",
  "^C-",
  "a-",
  "--",
  "x-a",
  "D-a",
  "ctrl+a",
  "Ctrl-a",
  "cmd+k",
  "alt+X",
  "C-nonsense",
  "nonsense",
  "esc",
  "return",
  "backspace",
  "ArrowUp",
  "F0",
  "F13",
  "F24",
  "KP7",
  "KPEnter",
  "User0",
  "0x41",
  "Any",
  "S-`",
  "C-ab",
  "\u001b",
  "\u0001",
  "\t",
  "\n",
  "C-\u001b",
  "M-\u0001",
  "\u00a0",
  "C-\u00a0",
  "M-\u3000",
];

describe("strokeFromTmuxKey", () => {
  it.each(USABLE_KEYS)("reads the tmux key %j as %s", (key, stroke) => {
    expect(strokeFromTmuxKey(key)).toBe(stroke);
  });

  it.each(PLAIN_KEYS)("reads the plain tmux key %j as %s", (key, stroke) => {
    expect(strokeFromTmuxKey(key)).toBe(stroke);
  });

  it.each(UNKNOWN_KEYS)("has no stroke for %j", (key) => {
    expect(strokeFromTmuxKey(key)).toBeNull();
  });

  it.each(USABLE_KEYS)(
    "gives a stroke for %j that the keymap takes as the prefix %s",
    (key, stroke) => {
      const config = stockTmuxConfig();
      const prefix = usable(strokeFromTmuxKey(key) ?? "");

      expect(
        buildKeymap({ ...config, options: { ...config.options, prefix } }).prefix,
      ).toBe(stroke);
    },
  );

  it.each(PLAIN_KEYS)(
    "gives a stroke for %j that the keymap does not take as the prefix, which stays tmux's own",
    (key) => {
      const config = stockTmuxConfig();
      const prefix = usable(strokeFromTmuxKey(key) ?? "");

      expect(
        buildKeymap({ ...config, options: { ...config.options, prefix } }).prefix,
      ).toBe("C-b");
    },
  );
});

describe("prefixFromTmuxConfigs: the set command", () => {
  it.each([
    ["set-option -g prefix C-a", "C-a"],
    ["set -g prefix C-a", "C-a"],
    ["set -gq prefix ^A", "C-a"],
    ["set -g prefix C-b", "C-b"],
    ["set -g prefix C-Space", "C-Space"],
    ["set -g prefix M-a", "M-a"],
    ["set -g prefix F12", "F12"],
    ["set -g prefix C-M-a", "C-M-a"],
    ["  set   -g\tprefix   C-a  ", "C-a"],
    ["set -g prefix C-a\n", "C-a"],
    ["set -g prefix C-a\r\nset -g mouse on\r\n", "C-a"],
  ])("reads %j as the prefix %s", (text, key) => {
    expect(parse(text)).toEqual(usable(key));
  });

  it.each([
    ['set -g prefix "C-a"', "C-a"],
    ["set -g prefix 'C-a'", "C-a"],
    ['set -g prefix "C-Space"', "C-Space"],
    ['set -g prefix C-"a"', "C-a"],
    ["set -g prefix 'C-'a", "C-a"],
    ['set -g "prefix" C-a', "C-a"],
    ['"set" "-g" prefix C-a', "C-a"],
    ["set -g prefix 'C-\\'", "C-\\"],
    ["set -g prefix C-\\\\", "C-\\"],
    ['set -g prefix "C-\\\\"', "C-\\"],
    ["set -g prefix C-\\q", "C-q"],
  ])("takes the quotes and backslashes off %j: %s", (text, key) => {
    expect(parse(text)).toEqual(usable(key));
  });

  it.each([
    ["set -g prefix `", "`"],
    ["set -g prefix '`'", "`"],
    ["set -g prefix \\`", "`"],
    ['set -g prefix "\\140"', "`"],
    ['set -g prefix "\\u0060"', "`"],
    ["set -g prefix a", "a"],
    ["set -g prefix Home", "Home"],
    ["set -g prefix BTab", "BTab"],
    ["set -g prefix '$PREFIX'", "$PREFIX"],
    ["set -g prefix \\$PREFIX", "$PREFIX"],
    ["set -g prefix '~'", "~"],
    ["set -g prefix C-a#b", "C-a#b"],
  ])("records the plain or unknown key of %j as a prefix bb cannot use: %s", (text, key) => {
    expect(parse(text)).toEqual(unusable(key));
  });

  it.each(["None", "none", "NONE", "'None'"])(
    "records %s, tmux's word for no prefix, as a prefix bb cannot use",
    (value) => {
      const written = value.replaceAll("'", "");

      expect(parse(`set -g prefix ${value}`)).toEqual(unusable(written));
    },
  );

  it.each(["KP7", "User0", "0x41", "ctrl+a", "D-a", "C-nonsense"])(
    "records the key %s, which this plugin does not know, with its text as written",
    (value) => {
      expect(parse(`set -g prefix ${value}`)).toEqual(unusable(value));
    },
  );

  it.each(["C-\u0130", "^\u0130", "M-\u0130", "C-M-\u0130", "C-S-\u0130"])(
    "records the key %s on the Turkish capital dotted I, whose lower case is two characters, as a prefix bb cannot use",
    (value) => {
      expect(parse(`set -g prefix ${value}`)).toEqual(unusable(value));
      expect(parse(`set -g prefix C-a\nset -g prefix ${value}`)).toEqual(unusable(value));
    },
  );

  it.each([
    ["C-I", "C-i"],
    ["M-I", "M-S-i"],
    ["C-\u0131", "C-\u0131"],
    ["M-\u00c9", "M-S-\u00e9"],
  ])("reads the prefix %s on a letter whose lower case is one character as %s", (value, key) => {
    expect(parse(`set -g prefix ${value}`)).toEqual(usable(key));
  });

  it("shortens a long value that it cannot use", () => {
    const value = "x".repeat(100);

    expect(parse(`set -g prefix ${value}`)).toEqual(
      unusable(`${"x".repeat(32)}...`),
    );
  });

  it.each([
    "set prefix C-a",
    "set -q prefix C-a",
    "set -a prefix C-a",
    "set -F prefix C-a",
    "set -w prefix C-a",
    "set -p prefix C-a",
    "set -s prefix C-a",
    "set -go prefix C-a",
    "set -og prefix C-a",
    "set -g -o prefix C-a",
    "set -sgo prefix C-a",
    "set -gx prefix C-a",
    "set -g -1 prefix C-a",
    "set -tg prefix C-a",
    "set -t main prefix C-a",
    "set -g prefix",
    "set -g prefix C-a C-b",
    "set -g",
    "set",
    "set -g -t",
  ])("ignores %j", (text) => {
    expect(parse(text)).toBeNull();
    expect(parse(`set -g prefix C-s\n${text}`)).toEqual(usable("C-s"));
  });

  // tmux keeps the prefix as a session option, so -g alone says that the
  // global prefix is meant. -s, -w and -p only count for a user option, and
  // -a sets a key like a plain set.
  it.each([
    "set -sg prefix C-a",
    "set -gs prefix C-a",
    "set -g -s prefix C-a",
    "set -gw prefix C-a",
    "set -wg prefix C-a",
    "set -g -w prefix C-a",
    "set -gp prefix C-a",
    "set -ga prefix C-a",
    "set -ag prefix C-a",
    "set -gF prefix C-a",
    "set -gaFpqsw prefix C-a",
    "set-option -sgq -t 0 prefix C-a",
  ])("reads %j, which sets the global prefix in tmux although it has more flags than -g", (text) => {
    expect(parse(text)).toEqual(usable("C-a"));
    expect(parse(`set -g prefix C-s\n${text}`)).toEqual(usable("C-a"));
  });

  it.each([
    "set -gF prefix '#{prefix_key}'",
    "set -gF prefix C-#",
    "set -gF prefix '#H'",
    "set -gF prefix C-##",
  ])("ignores %j, whose value tmux would expand as a format", (text) => {
    expect(parse(text)).toBeNull();
    expect(parse(`set -g prefix C-a\n${text}`)).toEqual(usable("C-a"));
  });

  it.each([
    "set -gq prefix C-a",
    "set -qg prefix C-a",
    "set -g -q prefix C-a",
    "set -q -g prefix C-a",
    "set -g -t main prefix C-a",
    "set -gt main prefix C-a",
    "set -t main -g prefix C-a",
    "set -tmain -g prefix C-a",
    "set -gtmain prefix C-a",
    "set -g -- prefix C-a",
    "set-option -gq -t 0 prefix C-a",
  ])("reads the flags of %j", (text) => {
    expect(parse(text)).toEqual(usable("C-a"));
  });

  it.each([
    "set -g prefix2 C-a",
    "set -g prefix-timeout 500",
    "set -g pref C-a",
    "set -g PREFIX C-a",
    "set -g @prefix C-a",
    "set -g status-prefix C-a",
  ])("ignores %j, which sets another option", (text) => {
    expect(parse(text)).toBeNull();
  });

  it.each([
    "setw -g prefix C-a",
    "setw -gq prefix C-a",
    "setw -ga prefix C-a",
    "setw -gF prefix C-a",
    "setw -g -t 0 prefix C-a",
    "set-window-option -g prefix C-a",
  ])("reads %j, because tmux sets the global prefix with its window option command too", (text) => {
    expect(parse(text)).toEqual(usable("C-a"));
  });

  it.each([
    "set-o -g prefix C-a",
    "set-op -g prefix C-a",
    "set-opt -g prefix C-a",
    "set-opti -g prefix C-a",
    "set-optio -g prefix C-a",
    "set-w -g prefix C-a",
    "set-win -g prefix C-a",
    "set-window-optio -g prefix C-a",
  ])("reads %j, a shorter form of the command that tmux accepts", (text) => {
    expect(parse(text)).toEqual(usable("C-a"));
  });

  it.each([
    "setw -gs prefix C-a",
    "setw -gw prefix C-a",
    "setw -gp prefix C-a",
    "set-window-option -gs prefix C-a",
    "set-w -gp prefix C-a",
    "setw -go prefix C-a",
    "setw prefix C-a",
  ])("ignores %j, which tmux refuses for its flags", (text) => {
    expect(parse(text)).toBeNull();
    expect(parse(`set -g prefix C-s\n${text}`)).toEqual(usable("C-s"));
  });

  it.each([
    "SET -g prefix C-a",
    "sets -g prefix C-a",
    "se -g prefix C-a",
    "set- -g prefix C-a",
    "seto -g prefix C-a",
    "setb -g prefix C-a",
    "set-optionx -g prefix C-a",
    "set-options -g prefix C-a",
    "setw2 -g prefix C-a",
    "set-window-options -g prefix C-a",
    "set-hook -g prefix C-a",
    "set-environment -g prefix C-a",
  ])("ignores %j, whose first word is no form of set-option or set-window-option", (text) => {
    expect(parse(text)).toBeNull();
  });

  it.each([
    "bind r set -g prefix C-x",
    "bind-key r set-option -g prefix C-x",
    'if-shell "true" "set -g prefix C-x"',
    "if-shell true 'set -g prefix C-x'",
    'if "test -f ~/.work" "set -g prefix C-x" "set -g prefix C-y"',
    'run-shell "tmux set -g prefix C-x"',
    "display 'set -g prefix C-x'",
    'confirm-before "set -g prefix C-x"',
    "set-hook -g session-created 'set -g prefix C-x'",
  ])("ignores the set inside %j", (text) => {
    expect(parse(text)).toBeNull();
  });

  it.each([
    "set -g prefix $PREFIX",
    'set -g prefix "$PREFIX"',
    "set -g prefix ${PREFIX}",
    'set -g prefix "C-$KEY"',
    "set -g prefix C-$KEY",
    "set -g prefix $_KEY",
    'set -g prefix "#{prefix_key}"',
    "set -g prefix '#{prefix_key}'",
    "set -g prefix #{prefix_key}",
    "set -g prefix C-#{key}",
    "set -g prefix ~",
    "set -g prefix ~/key",
    'set -g prefix ""',
    "set -g prefix ''",
  ])("ignores %j, whose value cannot be evaluated", (text) => {
    expect(parse(text)).toBeNull();
    expect(parse(`set -g prefix C-a\n${text}`)).toEqual(usable("C-a"));
  });

  it("takes a $ that tmux would not expand as the key", () => {
    expect(parse("set -g prefix C-$\n")).toEqual(usable("C-$"));
    expect(parse('set -g prefix "C-$"')).toEqual(usable("C-$"));
  });

  it("ignores a set whose $ ends a file that has no line break at its end, which tmux refuses to read", () => {
    expect(parse("set -g prefix C-$")).toBeNull();
    expect(parse("set -g prefix C-a\nset -g prefix C-$")).toEqual(usable("C-a"));
  });
});

describe("prefixFromTmuxConfigs: unsetting", () => {
  it.each([
    "set -gu prefix",
    "set -ug prefix",
    "set -g -u prefix",
    "set -gqu prefix",
    "set-option -gu prefix",
    "set -gu prefix C-x",
    "set -gU prefix",
    "set -Ug prefix",
    "set -gU prefix C-x",
    "set -gwu prefix",
    "set -sgu prefix",
    "setw -gu prefix",
    "set-opt -gu prefix",
  ])("puts the prefix back to not set with %j", (text) => {
    expect(parse(`set -g prefix C-a\n${text}`)).toBeNull();
  });

  it.each([
    "set -u prefix",
    "set -U prefix",
    "set -gu prefix2",
    "set -gu",
    "set -gu prefix C-x C-y",
    "set -gou prefix",
    "setw -gU prefix",
  ])("keeps the prefix with %j", (text) => {
    expect(parse(`set -g prefix C-a\n${text}`)).toEqual(usable("C-a"));
  });

  it("takes a prefix that is set again after it was unset", () => {
    expect(
      parse("set -g prefix C-a\nset -gu prefix\nset -g prefix C-s"),
    ).toEqual(usable("C-s"));
  });
});

describe("prefixFromTmuxConfigs: comments", () => {
  it.each([
    "# set -g prefix C-x",
    "#set -g prefix C-x",
    "   # set -g prefix C-x",
    "\t#set -g prefix C-x",
    "set -g mouse on # set -g prefix C-x",
    "set -g status-right #H ; set -g prefix C-x",
    "set -g mouse on #{note} ; set -g prefix C-x",
    "display #{host} ; set -g prefix C-x",
    "display #{?#{==:#{host},work},a;b,c} ; set -g prefix C-x",
    "#{pane_current_path} set -g prefix C-x",
    "# one \\\nset -g prefix C-x",
  ])("finds no prefix in %j", (text) => {
    expect(parse(text)).toBeNull();
  });

  it.each([
    "set -g prefix C-a # the tmux prefix",
    "set -g prefix C-a #",
    "set -g prefix C-a\t# tab before the comment",
    "# remap the prefix\nset -g prefix C-a",
    'set -g status-right "#H" ; set -g prefix C-a',
    "set -g status-right '#H' ; set -g prefix C-a",
    "set -g status-right a#b ; set -g prefix C-a",
    "set -g status-right \\#H ; set -g prefix C-a",
    "set -g prefix C-a #{{{",
    "set -g prefix C-a #{host}",
    "set -g prefix C-a #{host} ; set -g prefix C-x",
    "#{pane_current_path} doesn't work here\nset -g prefix C-a",
    "#{{{ keys\nset -g prefix C-a\n#}}}",
    "#{ it's \"odd\nset -g prefix C-a",
  ])("reads the prefix C-a from %j", (text) => {
    expect(parse(text)).toEqual(usable("C-a"));
  });
});

// In tmux "#{" at the start of a word opens a format only right after %if or
// %elif. Everywhere else it starts a comment, like any other "#".
describe("prefixFromTmuxConfigs: formats", () => {
  it("reads the format that a condition tests as one word, with the blanks and semicolons in it", () => {
    const text = [
      "%if #{?#{==:#{host},work},a ; b,c}",
      "set -g prefix C-x",
      "%elif #{==:#{host},home} ; set -g prefix C-y",
      "%endif",
      "set -g prefix C-a",
    ].join("\n");

    expect(parse(text)).toEqual(usable("C-a"));
  });

  it("takes #{ for a comment when a line break stands between it and the condition", () => {
    expect(parse("%if 1\n#{ it's\nset -g prefix C-x\n%endif\nset -g prefix C-a")).toEqual(
      usable("C-a"),
    );
  });

  it("does not take #{ in the middle of a word for a format: the word ends at the closing brace, which makes the line a block", () => {
    expect(parse("set -g prefix C-#{key}")).toBeNull();
    expect(parse("set -g prefix C-x#{host} ; set -g prefix C-a")).toEqual(usable("C-a"));
  });

  it("still knows a format inside quotes, whose value cannot be evaluated", () => {
    expect(parse('set -g prefix "#{prefix_key}"')).toBeNull();
  });
});

// tmux keeps the line breaks of a string in quotes that spans lines, and
// drops the comment lines in it.
describe("prefixFromTmuxConfigs: quoted strings that span lines", () => {
  it.each([
    ["an apostrophe in a comment line of a single-quoted string", "bind-key x run-shell '\n  # don't forget\n  echo hi\n'\nset -g prefix C-a"],
    ["a double quote in a comment line of a double-quoted string", 'bind-key x run-shell "\n  # a 27\" screen\n  echo hi\n"\nset -g prefix C-a'],
    ["two comment lines in a row", "bind-key x run-shell '\n# don't\n\t# can't\necho hi\n'\nset -g prefix C-a"],
    ["a string without a comment", "bind-key x run-shell '\n  echo hi\n'\nset -g prefix C-a"],
    ["a comment without a quote character", "bind-key x run-shell '\n  # do not forget\n  echo hi\n'\nset -g prefix C-a"],
  ])("reads the prefix after %s", (_name, text) => {
    expect(parse(text)).toEqual(usable("C-a"));
  });

  it.each([
    ["#{", "bind-key x display '\n  #{it's}'\nset -g prefix C-x"],
    ["##", "bind-key x display '\n  ##it's'\nset -g prefix C-x"],
    ["#,", "bind-key x display '\n  #,it's'\nset -g prefix C-x"],
    ["#}", "bind-key x display '\n  #}it's'\nset -g prefix C-x"],
    ["#:", "bind-key x display '\n  #:it's'\nset -g prefix C-x"],
  ])("does not take a line that starts with %s for a comment, because that is part of a format", (_name, text) => {
    expect(parse(text)).toBeNull();
  });

  it("drops a comment line together with a quote character at its end, so that the string goes on", () => {
    expect(parse("bind-key x run-shell '\necho hi\n# done'\nset -g prefix C-x")).toBeNull();
  });

  it("drops the blanks that a line inside quotes starts with and keeps the line break", () => {
    expect(parse("set -g prefix 'C-\n   a'")).toEqual(unusable("C-\na"));
  });

  it("does not drop a comment line outside quotes differently: it ends the command", () => {
    expect(parse("set -g prefix\n# note\nC-a")).toBeNull();
  });
});

describe("prefixFromTmuxConfigs: continuation lines", () => {
  it.each([
    "set -g \\\nprefix C-a",
    "set -g prefix \\\n    C-a",
    "set \\\n -g \\\n prefix \\\n C-a",
    "set -g prefix C-\\\na",
    "set -g prefix 'C-\\\na'",
    "set -g status-left 'one \\\ntwo'\nset -g prefix C-a",
    "set -g mouse on \\\n\nset -g prefix C-a",
  ])("joins the lines of %j", (text) => {
    expect(parse(text)).toEqual(usable("C-a"));
  });

  it("joins a comment with the line after it", () => {
    const text = "# note \\\nset -g prefix C-x\nset -g prefix C-a";

    expect(parse(text)).toEqual(usable("C-a"));
  });

  it("does not join after a backslash that is itself escaped", () => {
    const text = "set -g prefix C-\\\\\nset -g mouse on";

    expect(parse(text)).toEqual(usable("C-\\"));
  });

  it("joins after three backslashes, of which two are an escaped backslash", () => {
    const text = "set -g prefix C-\\\\\\\n";

    expect(parse(text)).toEqual(usable("C-\\"));
  });
});

describe("prefixFromTmuxConfigs: semicolons", () => {
  it.each([
    ["set -g prefix C-a;", "C-a"],
    ["set -g prefix C-a ;", "C-a"],
    ["set -g prefix C-a; bind C-a send-prefix", "C-a"],
    ["unbind C-b ; set -g prefix C-a ; bind C-a send-prefix", "C-a"],
    ["unbind C-b;set -g prefix C-a;bind C-a send-prefix", "C-a"],
    ["set -g prefix C-a ; set -g prefix C-s", "C-s"],
    ["set -g mouse on; set -g prefix C-a", "C-a"],
    ['display ";" ; set -g prefix C-a', "C-a"],
    ["display 'a;b' ; set -g prefix C-a", "C-a"],
    [";;; set -g prefix C-a", "C-a"],
  ])("splits %j into commands: %s", (text, key) => {
    expect(parse(text)).toEqual(usable(key));
  });

  it.each([
    "bind r source-file ~/.tmux.conf \\; display x",
    "bind r set -g prefix C-x \\; display x",
    "bind r source-file ~/.tmux.conf \\; set -g prefix C-x",
    "set -g mouse on \\; set -g prefix C-x",
    "bind r display x\\; set -g prefix C-x",
    'display "; set -g prefix C-x"',
    "display '; set -g prefix C-x ;'",
  ])("does not split %j at the escaped or quoted semicolon", (text) => {
    expect(parse(text)).toBeNull();
  });

  it("goes on with the next line after a bind that holds escaped semicolons", () => {
    const text = [
      "bind r source-file ~/.tmux.conf \\; display x",
      "set -g prefix C-a",
    ].join("\n");

    expect(parse(text)).toEqual(usable("C-a"));
  });
});

describe("prefixFromTmuxConfigs: %if blocks", () => {
  it.each([
    '%if "#{==:#{host},work}"\nset -g prefix C-x\n%endif',
    "%if #{==:#{host},work}\nset -g prefix C-x\n%endif",
    "%if #{==:#{host},work}\nset -g prefix C-x\n%else\nset -g prefix C-y\n%endif",
    "%if 1\nset -g prefix C-x\n%elif 2\nset -g prefix C-y\n%else\nset -g prefix C-z\n%endif",
    "%if #{==:#{host},work} set -g prefix C-x %endif",
    "%if 1\n%if 2\nset -g prefix C-x\n%endif\nset -g prefix C-y\n%endif",
    "  %if 1\n  set -g prefix C-x\n  %endif",
    "%if 1\nset -g prefix C-x",
    "%endif set -g prefix C-x",
    "set -g prefix C-x %if 1\n%endif",
  ])("finds no prefix in %j", (text) => {
    expect(parse(text)).toBeNull();
  });

  it.each([
    "%if 1\nset -g prefix C-x\n%endif\nset -g prefix C-a",
    "set -g prefix C-a\n%if 1\nset -g prefix C-x\n%endif",
    "%if #{==:#{host},work} set -g prefix C-x %endif\nset -g prefix C-a",
    "%if 1\n%if 2\nset -g prefix C-x\n%endif\n%endif\nset -g prefix C-a",
    "%endif\nset -g prefix C-a",
    "%hidden KEY=C-x\nset -g prefix C-a",
    "unbind %\nset -g prefix C-a",
    'display "%if"\nset -g prefix C-a',
  ])("reads the prefix C-a outside the block of %j", (text) => {
    expect(parse(text)).toEqual(usable("C-a"));
  });
});

describe("prefixFromTmuxConfigs: brace blocks", () => {
  it.each([
    'if-shell "true" {\n  set -g prefix C-x\n}',
    "if-shell true { set -g prefix C-x }",
    "bind x {\n  set -g prefix C-x\n}",
    'bind x {\n  display "}"\n  set -g prefix C-x\n}',
    "bind x {\n  # } is not the end\n  set -g prefix C-x\n}",
    "bind x {\n  display '{'\n  set -g prefix C-x\n}",
    'bind x if-shell "true" {\n  if-shell "true" {\n    set -g prefix C-x\n  }\n  set -g prefix C-y\n}',
    "bind x {\n  %if #{==:#{host},work}\n  set -g prefix C-x\n  %endif\n  set -g prefix C-y\n}",
    "bind x {\n  display #{host}\n  set -g prefix C-x\n}",
    "set -g prefix { C-x }",
    "set -g prefix C-x {\n}",
    "bind x {\n  set -g prefix C-x",
    "} set -g prefix C-x",
  ])("finds no prefix in %j", (text) => {
    expect(parse(text)).toBeNull();
  });

  it.each([
    "bind x {\n  set -g prefix C-x\n}\nset -g prefix C-a",
    "set -g prefix C-a\nbind x {\n  set -g prefix C-x\n}",
    "if-shell true { set -g prefix C-x } ; set -g prefix C-a",
    'bind x {\n  display "}"\n}\nset -g prefix C-a',
    "bind x {\n  %if #{==:#{host},work}\n  display a\n  %endif\n}\nset -g prefix C-a",
    'bind x if-shell "true" {\n  if-shell "true" {\n    display a\n  }\n}\nset -g prefix C-a',
    "}\nset -g prefix C-a",
    'display "{"\nset -g prefix C-a',
  ])("reads the prefix C-a outside the block of %j", (text) => {
    expect(parse(text)).toEqual(usable("C-a"));
  });
});

describe("prefixFromTmuxConfigs: the last command wins", () => {
  it("takes the later of two prefixes", () => {
    expect(parse("set -g prefix C-a\nset -g prefix C-s")).toEqual(usable("C-s"));
  });

  it("lets a later prefix that bb cannot use replace a usable one", () => {
    expect(parse("set -g prefix C-a\nset -g prefix `")).toEqual(unusable("`"));
    expect(parse("set -g prefix C-a\nset -g prefix None")).toEqual(
      unusable("None"),
    );
  });

  it("lets a later usable prefix replace one that bb cannot use", () => {
    expect(parse("set -g prefix `\nset -g prefix C-a")).toEqual(usable("C-a"));
  });

  it("keeps the earlier prefix when the later command does not count", () => {
    const text = [
      "set -g prefix C-a",
      "set -g prefix2 C-s",
      "bind r set -g prefix C-x",
      "set -go prefix C-y",
      "set prefix C-z",
    ].join("\n");

    expect(parse(text)).toEqual(usable("C-a"));
  });

  it("reads the prefix from a config with the usual lines around it", () => {
    const text = [
      "# remap prefix from 'C-b' to 'C-a'",
      "unbind C-b",
      "set-option -g prefix C-a",
      "bind-key C-a send-prefix",
      "",
      "# split panes using | and -",
      "bind | split-window -h",
      "bind - split-window -v",
      "unbind '\"'",
      "unbind %",
      "",
      "bind r source-file ~/.tmux.conf \\; display \"Reloaded!\"",
      "set -g mouse on",
      "set -g status-right \"#[fg=cyan]#(whoami) #{host} %H:%M\"",
      "setw -g mode-keys vi",
      "set -g @plugin 'tmux-plugins/tpm'",
      "if-shell \"uname | grep -q Darwin\" \"source-file ~/.tmux-macos.conf\"",
      "bind -T copy-mode-vi v send -X begin-selection",
      "bind-key -n C-S-Left swap-window -t -1\\; select-window -t -1",
      "run '~/.tmux/plugins/tpm/tpm'",
      "",
    ].join("\n");

    expect(parse(text)).toEqual(usable("C-a"));
  });
});

// The server reads files of up to 1 MiB while bb waits, so the time it takes
// must grow with the size of the file and no faster.
describe("prefixFromTmuxConfigs: long files", () => {
  const LENGTH = 100_000;
  const LIMIT_MS = 1000;

  function timed(text: string): { prefix: TmuxPrefix | null; ms: number } {
    const started = performance.now();
    const prefix = parse(text);
    return { prefix, ms: performance.now() - started };
  }

  it.each([
    "\\",
    "#{} ",
    "#{",
    "{ ",
    "} ",
    "' ",
    "; ",
    "%if ",
    "$X ",
    "x\\; ",
    "-t ",
  ])("reads a line of 100000 characters made of %j in good time", (unit) => {
    const line = unit.repeat(LENGTH / unit.length);

    expect(timed(`${line}x\nset -g prefix C-a\n`).ms).toBeLessThan(LIMIT_MS);
    expect(timed(line).ms).toBeLessThan(LIMIT_MS);
  });

  it("reads many lines in good time and still finds the prefix after them", () => {
    const line = 'set -g status-right "#{host}" ; bind r display x \\; display y # note\n';
    const text = `${line.repeat(LENGTH / line.length)}set -g prefix C-a\n`;

    const { prefix, ms } = timed(text);

    expect(prefix).toEqual(usable("C-a"));
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("tells an even run of backslashes at the end of a line from an odd one", () => {
    const next = "\nset -g prefix C-a\n";

    expect(parse(`${"\\".repeat(LENGTH)}${next}`)).toEqual(usable("C-a"));
    expect(parse(`${"\\".repeat(LENGTH + 1)}${next}`)).toBeNull();
  });

  it("does not try to read a key out of a very long value", () => {
    const { prefix, ms } = timed(`set -g prefix ${"C-".repeat(LENGTH / 2)}a`);

    expect(prefix).toEqual(unusable(`${"C-".repeat(16)}...`));
    expect(ms).toBeLessThan(LIMIT_MS);
  });
});

describe("prefixFromTmuxConfigs: several files", () => {
  it("finds no prefix without any file, and none in an empty file", () => {
    expect(prefixFromTmuxConfigs([])).toBeNull();
    expect(parse("")).toBeNull();
    expect(parse("\n\n")).toBeNull();
  });

  it("names the file that the prefix comes from", () => {
    const prefix = prefixFromTmuxConfigs([
      { path: HOME_CONFIG, text: "set -g mouse on" },
      { path: XDG_CONFIG, text: "set -g prefix C-a" },
    ]);

    expect(prefix).toEqual(usable("C-a", XDG_CONFIG));
  });

  it("lets a later file override an earlier one", () => {
    const prefix = prefixFromTmuxConfigs([
      { path: HOME_CONFIG, text: "set -g prefix C-a" },
      { path: XDG_CONFIG, text: "set -g prefix C-s" },
    ]);

    expect(prefix).toEqual(usable("C-s", XDG_CONFIG));
  });

  it("keeps the prefix of an earlier file when a later one sets none", () => {
    const prefix = prefixFromTmuxConfigs([
      { path: HOME_CONFIG, text: "set -g prefix C-a" },
      { path: XDG_CONFIG, text: "set -g mouse on\nbind r set -g prefix C-x" },
    ]);

    expect(prefix).toEqual(usable("C-a", HOME_CONFIG));
  });

  it("lets a later file unset the prefix of an earlier one", () => {
    const prefix = prefixFromTmuxConfigs([
      { path: HOME_CONFIG, text: "set -g prefix C-a" },
      { path: XDG_CONFIG, text: "set -gu prefix" },
    ]);

    expect(prefix).toBeNull();
  });

  it("names the file of a prefix that bb cannot use", () => {
    const prefix = prefixFromTmuxConfigs([
      { path: HOME_CONFIG, text: "set -g prefix C-a" },
      { path: XDG_CONFIG, text: "set -g prefix `" },
    ]);

    expect(prefix).toEqual(unusable("`", XDG_CONFIG));
  });

  it.each([
    "%if 1\nset -g prefix C-x",
    "bind x {\nset -g prefix C-x",
    "set -g status-left 'never closed",
    "set -g mouse on \\",
  ])("starts each file afresh after %j", (unfinished) => {
    const prefix = prefixFromTmuxConfigs([
      { path: HOME_CONFIG, text: unfinished },
      { path: XDG_CONFIG, text: "set -g prefix C-a" },
    ]);

    expect(prefix).toEqual(usable("C-a", XDG_CONFIG));
  });
});
