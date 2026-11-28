import { describe, expect, it } from "vitest";
import {
  MAX_BINDING_ACTIONS,
  actionCount,
  actionsOfBinding,
  type CommandAction,
} from "./tmux-commands";
import { parseCommands } from "./tmux-syntax";

// What a key bound to these commands does: the text is what stands behind
// "bind KEY" in a config. null for commands that tmux refuses to bind.
function actions(commands: string): CommandAction[] | null {
  const [, , ...args] = parseCommands(`bind x ${commands}`)[0];
  return actionsOfBinding(args);
}

// How many actions the page gets for a key bound to these commands.
function countOf(commands: string): number {
  const bound = actions(commands) ?? [];
  return bound.reduce((count, action) => count + actionCount(action), 0);
}

const SHELL_COMMAND = "reattach-to-user-namespace pbcopy";

describe("pane commands", () => {
  it.each([
    ["select-pane -L", "left"],
    ["select-pane -D", "down"],
    ["select-pane -U", "up"],
    ["select-pane -R", "right"],
    ["selectp -L", "left"],
    ["select-p -R", "right"],
    ["select-pane -LZ", "left"],
    ["select-pane -Z -U", "up"],
  ] as const)("%s focuses the pane to the %s", (command, direction) => {
    expect(actions(command)).toEqual([{ type: "pane.focus", direction }]);
  });

  it.each([
    ["select-pane -t '{left-of}'", "left"],
    ["select-pane -t '{right-of}'", "right"],
    ["select-pane -t '{up-of}'", "up"],
    ["select-pane -t '{down-of}'", "down"],
    ["select-pane -t '.{left-of}'", "left"],
    ["select-pane -t ':.{up-of}'", "up"],
    ["select-pane -t'{right-of}'", "right"],
    ["selectp -Z -t '{down-of}'", "down"],
    ['select-pane -t "{left-of}"', "left"],
  ] as const)(
    "%s asks for the pane that tmux finds in the direction %s, which is not the move of select-pane with that flag",
    (command, direction) => {
      expect(actions(command)).toEqual([{ type: "pane.neighbour", direction }]);
    },
  );

  it("keeps the command behind such a target, which the page only runs when a pane was found", () => {
    expect(actions("select-pane -t '{left-of}' \\; kill-pane")).toEqual([
      { type: "pane.neighbour", direction: "left" },
      { type: "pane.close" },
    ]);
    expect(actions("select-pane -L \\; kill-pane")).toEqual([
      { type: "pane.focus", direction: "left" },
      { type: "pane.close" },
    ]);
  });

  it.each([
    "select-pane -t '{left}'",
    "select-pane -t '{right}'",
    "select-pane -t '{top}'",
    "select-pane -t '{bottom}'",
    "select-pane -t '{top-left}'",
    "select-pane -t '{bottom-right}'",
    "select-pane -t '{mouse}'",
    "select-pane -t '{marked}'",
    "select-pane -t '{left-of'",
    "select-pane -t '{LEFT-OF}'",
    "select-pane -t '{left-of}1'",
    "select-pane -t ':{left-of}'",
    "select-pane -t '1.{left-of}'",
    "select-pane -t 'main:.{left-of}'",
    "select-pane -t '{start}'",
    "select-pane -t '{end}'",
    "select-pane -t ^",
    "select-pane -t ':$'",
    "select-pane -L -t '{left-of}'",
    "select-pane -l -t '{left-of}'",
    "select-pane -e -t '{left-of}'",
    "select-window -t '{left-of}'",
    "select-window -t '.{left-of}'",
  ])("%s has no equivalent, because the target is none of the four pane sides", (command) => {
    expect(actions(command)).toEqual([]);
  });

  it.each([
    "select-pane -t :.+",
    "select-pane -t:.+",
    "select-pane -t +",
    "select-pane -t :.+1",
    "select-pane -t .+",
    "select-pane -t '{next}'",
    "select-pane -t ':.{next}'",
  ])(
    "%s goes to the next pane",
    (command) => {
      expect(actions(command)).toEqual([{ type: "pane.next" }]);
    },
  );

  it.each([
    "select-pane -t :.-",
    "select-pane -t:.-",
    "select-pane -t -",
    "select-pane -t :.-1",
    "select-pane -t '{previous}'",
    "select-pane -t '.{previous}'",
  ])(
    "%s goes to the previous pane",
    (command) => {
      expect(actions(command)).toEqual([{ type: "pane.previous" }]);
    },
  );

  it.each([
    "last-pane",
    "lastp",
    "last-pane -Z",
    "select-pane -l",
    "select-pane -lZ",
    "select-pane -t !",
    "select-pane -t :.!",
    "select-pane -t '{last}'",
    "select-pane -Z -t '.{last}'",
  ])(
    "%s goes to the pane that had the focus before",
    (command) => {
      expect(actions(command)).toEqual([{ type: "pane.last" }]);
    },
  );

  // cmd_find_target in cmd-find.c: a name is only looked up as the whole pane
  // part of the target, so tmux finds no pane for a name with more around it.
  it.each([
    "select-pane -t '{next}1'",
    "select-pane -t '{previous}1'",
    "select-pane -t ':.{next}1'",
    "select-pane -t '.{previous}1'",
    "select-pane -t '{last}1'",
    "select-pane -t '1{next}'",
    "select-pane -t 'x{next}'",
    "select-pane -t '{next}{next}'",
    "select-pane -t '+{next}'",
    "select-pane -t '{next}+'",
    "select-pane -t '{previous}{next}1'",
    "select-pane -t '!{last}'",
    "select-pane -t ':.x{last}'",
    "select-pane -t '{NEXT}'",
    "select-pane -t '.{last}{left-of}'",
  ])("%s has no equivalent, because a name of tmux only counts as the whole pane part of a target", (command) => {
    expect(actions(command)).toEqual([]);
  });

  it.each([
    "select-pane",
    "select-pane -m",
    "select-pane -M",
    "select-pane -e",
    "select-pane -d",
    "select-pane -T title",
    "select-pane -t 1",
    "select-pane -t :.1",
    "select-pane -t :+",
    "select-pane -t :.+2",
    "select-pane -t :!",
    "select-pane -t '{top}'",
    "select-pane -t '{next'",
    "select-pane -t $pane",
    "select-pane -L -t :.+",
    "select-layout even-horizontal",
    "last-pane -d",
    "last-pane -e",
    "last-pane -Zd",
  ])("%s has no equivalent", (command) => {
    expect(actions(command)).toEqual([]);
  });

  it.each([
    ["split-window", "down"],
    ["split-window -v", "down"],
    ["split-window -h", "right"],
    ["splitw -h", "right"],
    ["split-pane -h", "right"],
    ["split-pane", "down"],
    ["splitp -h", "right"],
    ["splitp -v", "down"],
    ['splitp -h -c "#{pane_current_path}"', "right"],
    ["split -h", "right"],
    ["split-window -hv", "right"],
    ['split-window -h -c "#{pane_current_path}"', "right"],
    ['split-window -c "#{pane_current_path}" -v', "down"],
    ["split-window -bdfh -l 30% -t :.1 -e A=b", "right"],
    ["split-window -h -p 30", "right"],
    ["split-window -l 10", "down"],
  ] as const)("%s opens the thread chooser for a pane %s", (command, placement) => {
    expect(actions(command)).toEqual([{ type: "chooser.open", placement }]);
  });

  it("takes a flag that it does not know for one without a value", () => {
    expect(actions("split-window -hQ")).toEqual([
      { type: "chooser.open", placement: "right" },
    ]);
  });

  it.each(["split-p -h", "splitpane -h", "Split-pane -h", "$alias -h"])(
    "%s, which is no command and no alias that tmux starts with, has no equivalent",
    (command) => {
      expect(actions(command)).toEqual([]);
    },
  );

  it.each([
    "split-window htop",
    "split-window -h 'ssh somewhere'",
    "split-pane htop",
    "new-window htop",
  ])(
    "%s, which runs a program, has no equivalent",
    (command) => {
      expect(actions(command)).toEqual([]);
    },
  );

  it.each([
    "kill-pane",
    "killp",
    "confirm-before kill-pane",
    'confirm-before -p "kill-pane #P? (y/n)" kill-pane',
    "confirm -y -c k kill-pane",
    "confirm-before { kill-pane }",
    'confirm-before "confirm-before kill-pane"',
  ])("%s closes the pane", (command) => {
    expect(actions(command)).toEqual([{ type: "pane.close" }]);
  });

  it.each([
    "kill-pane -a",
    "kill-pane -t 2",
    "kill-window",
    "kill-session",
    "kill-server",
    "confirm-before kill-window",
    'confirm-before "confirm \\"confirm \\\\\\"confirm { confirm kill-pane }\\\\\\"\\""',
  ])("%s has no equivalent", (command) => {
    expect(actions(command)).toEqual([]);
  });

  it("runs every command that waits behind a confirm-before", () => {
    expect(actions('confirm-before "kill-pane ; display gone"')).toEqual([
      { type: "pane.close" },
      { type: "notice.show", text: "gone" },
    ]);
  });

  it.each(["resize-pane -Z", "resizep -Z", "resize-pane -Z -L 5"])(
    "%s zooms the pane",
    (command) => {
      expect(actions(command)).toEqual([{ type: "pane.zoom" }]);
    },
  );

  it.each([
    ["resize-pane -L", "left", 1],
    ["resize-pane -R", "right", 1],
    ["resize-pane -U", "up", 1],
    ["resize-pane -D", "down", 1],
    ["resize-pane -L 5", "left", 5],
    ["resize-pane -D 10", "down", 10],
    ["resizep -R 2", "right", 2],
    ["resize-pane -U 2147483647", "up", 2147483647],
  ] as const)("%s resizes to the %s by %d cells", (command, direction, cells) => {
    expect(actions(command)).toEqual([{ type: "pane.resize", direction, cells }]);
  });

  it.each([
    "resize-pane",
    "resize-pane 5",
    "resize-pane -L 0",
    "resize-pane -L 1.5",
    "resize-pane -L five",
    "resize-pane -L $n",
    "resize-pane -L 2147483648",
    "resize-pane -x 80",
    "resize-pane -y 20%",
    "resize-pane -M",
    "resize-pane -T",
    "resize-pane -T -L 5",
    "resize-pane -t 1 -L 5",
    "resize-window -L 5",
  ])("%s has no equivalent", (command) => {
    expect(actions(command)).toEqual([]);
  });
});

describe("thread commands", () => {
  it.each([
    "new-window",
    "neww",
    'new-window -c "#{pane_current_path}"',
    "new-window -d -n name -t 3",
  ])(
    "%s starts a new thread",
    (command) => {
      expect(actions(command)).toEqual([{ type: "thread.new" }]);
    },
  );

  it.each([
    "next-window",
    "next",
    "select-window -n",
    "select-window -t :+",
    "select-window -t +",
    "selectw -t:+1",
    "select-window -t '{next}'",
    "select-window -t ':{next}'",
  ])(
    "%s goes to the next thread",
    (command) => {
      expect(actions(command)).toEqual([{ type: "thread.cycle", delta: 1 }]);
    },
  );

  it.each([
    "previous-window",
    "prev",
    "select-window -p",
    "select-window -t :-",
    "select-window -t -1",
    "select-window -t '{previous}'",
  ])(
    "%s goes to the previous thread",
    (command) => {
      expect(actions(command)).toEqual([{ type: "thread.cycle", delta: -1 }]);
    },
  );

  it.each([
    "last-window",
    "last",
    "select-window -l",
    "select-window -t !",
    "select-window -t :!",
    "select-window -t '{last}'",
  ])(
    "%s goes to the thread that the pane showed before",
    (command) => {
      expect(actions(command)).toEqual([{ type: "thread.last" }]);
    },
  );

  it.each([
    "select-window -t '{start}'",
    "select-window -t ':{start}'",
    "select-window -t ^",
    "select-window -t :^",
    "select-window -t:^",
    "select-window -t '^'",
    "selectw -T -t '{start}'",
  ])("%s jumps to the first thread, whatever base-index is", (command) => {
    expect(actions(command)).toEqual([{ type: "thread.jump", index: 1 }]);
  });

  it.each([
    "select-window -t '{end}'",
    "select-window -t ':{end}'",
    "select-window -t ':$'",
    "select-window -t :$ ",
    "select-window -t:$ ",
    'select-window -t ":$"',
    "selectw -T -t '{end}'",
  ])("%s jumps to the last thread", (command) => {
    expect(actions(command)).toEqual([{ type: "thread.end" }]);
  });

  // cmd_find_target in cmd-find.c: a target that starts with "$" and has no
  // colon names a session by its id, and "$" alone is the id of none. A "="
  // in front of the window asks for a window of exactly that name.
  it.each([
    "select-window -t '$'",
    "select-window -t '$1'",
    "select-window -t '$:'",
    "select-window -t ':=^'",
    "select-window -t '=^'",
    "select-window -t ':=$'",
    "select-window -t ':={start}'",
    "select-window -t '={end}'",
    "select-window -t '^1'",
    "select-window -t ':$1'",
    "select-window -t ':^.1'",
    "select-window -t '{start}.1'",
    "select-window -t '{end}.'",
    "select-window -t 'main:^'",
    "select-window -t 'main:{end}'",
    "select-window -t '{START}'",
    "select-window -t '{start'",
  ])("%s has no equivalent, because tmux does not take the target for the first or the last window", (command) => {
    expect(actions(command)).toEqual([]);
  });

  // A name is only looked up as the whole window part of the target as well.
  it.each([
    "select-window -t '{next}1'",
    "select-window -t '{previous}1'",
    "select-window -t ':{next}1'",
    "select-window -t ':{previous}1'",
    "select-window -t '{last}1'",
    "select-window -t '1{next}'",
    "select-window -t 'x{previous}'",
    "select-window -t '{next}{next}'",
    "select-window -t '+{next}'",
    "select-window -t ':!{last}'",
    "select-window -t '{NEXT}'",
    "select-window -t '={next}'",
  ])("%s has no equivalent, because a name of tmux only counts as the whole window part of a target", (command) => {
    expect(actions(command)).toEqual([]);
  });

  it.each([
    ["select-window -t :=3", 3],
    ["select-window -t:=0", 0],
    ["select-window -t :4", 4],
    ["select-window -t =5", 5],
    ["select-window -t 6", 6],
    ["selectw -t :=12", 12],
    ["select-window -T -t :=1", 1],
  ])("%s names window %d", (command, window) => {
    expect(actions(command)).toEqual([{ type: "window.select", window }]);
  });

  it.each([
    "next-window -a",
    "previous-window -a",
    "select-window",
    "select-window -t main:1",
    "select-window -t 1.2",
    "select-window -t :1.2",
    "select-window -t :=one",
    "select-window -t :+2",
    "select-window -t :=!",
    "select-window -t '{mouse}'",
    "select-window -t $n",
    "select-window -t :=99999999999",
    "new-session",
    "new",
    "kill-window",
    "swap-window -t -1",
  ])("%s has no equivalent", (command) => {
    expect(actions(command)).toEqual([]);
  });

  it.each([
    "choose-tree",
    "choose-tree -Zs",
    "choose-tree -Zw",
    "choose-tree -F fmt -O name",
    "choose-window",
    "choose-session",
    "choose-window -Z",
    "choose-session -F fmt -O name",
  ])("%s opens the thread chooser for this pane", (command) => {
    expect(actions(command)).toEqual([{ type: "chooser.open", placement: "replace" }]);
  });

  it.each([
    "choose-buffer -Z",
    "choose-client",
    "choose-tree -Zw 'kill-window -t %%'",
    "choose-window 'kill-window -t %%'",
    "choose-w",
    "info",
    "server-info",
  ])(
    "%s has no equivalent",
    (command) => {
      expect(actions(command)).toEqual([]);
    },
  );
});

describe("other commands of the prefix table", () => {
  it.each(["copy-mode", "copy-mode -e", "copy-mode -H"])("%s enters copy mode", (command) => {
    expect(actions(command)).toEqual([{ type: "copy.enter", motion: null }]);
  });

  it.each(["copy-mode -u", "copy-mode -eu"])("%s enters copy mode one page up", (command) => {
    expect(actions(command)).toEqual([{ type: "copy.enter", motion: "page-up" }]);
  });

  it.each(["copy-mode -d", "copy-mode -ed"])("%s enters copy mode one page down", (command) => {
    expect(actions(command)).toEqual([{ type: "copy.enter", motion: "page-down" }]);
  });

  it("enters copy mode without a move for copy-mode -ud, which goes up a page and down again", () => {
    expect(actions("copy-mode -ud")).toEqual([{ type: "copy.enter", motion: null }]);
  });

  it.each(["copy-mode -q", "copy-mode -qu", "copy-mode -q -M"])(
    "%s leaves copy mode and does nothing else",
    (command) => {
      expect(actions(command)).toEqual([{ type: "copy.exit" }]);
    },
  );

  it.each(["copy-mode -M", "copy-mode -t 1", "copy-mode -q -t 1", "copy-mode -s 1", "clock-mode"])(
    "%s has no equivalent",
    (command) => {
      expect(actions(command)).toEqual([]);
    },
  );

  it.each(["list-keys", "list-keys -N", "lsk", "list-keys -T copy-mode-vi"])(
    "%s opens the key help",
    (command) => {
      expect(actions(command)).toEqual([{ type: "help.open" }]);
    },
  );

  it("passes the prefix on with send-prefix, and the second prefix with -2", () => {
    expect(actions("send-prefix")).toEqual([{ type: "prefix.send", second: false }]);
    expect(actions("send-prefix -2")).toEqual([{ type: "prefix.send", second: true }]);
    expect(actions("send-prefix -t 1")).toEqual([{ type: "prefix.send", second: false }]);
  });

  it.each([
    "source-file ~/.tmux.conf",
    "source ~/.config/tmux/tmux.conf",
    "source-file -q /etc/tmux.conf other.conf",
    'source-file "$HOME/.tmux.conf"',
  ])("%s reads the config again", (command) => {
    expect(actions(command)).toEqual([{ type: "config.reload" }]);
  });

  it("source-file -n ~/.tmux.conf has no equivalent", () => {
    expect(actions("source-file -n ~/.tmux.conf")).toEqual([]);
  });

  it.each([
    ["display-message Reloaded", "Reloaded"],
    ["display 'Config reloaded!'", "Config reloaded!"],
    ['display -d 2000 "two words"', "two words"],
    ["display-mes -p shown", "shown"],
    ["display -F shown", "shown"],
    ["display -d 2000 -F 'two words'", "two words"],
  ])("%s shows a notice", (command, text) => {
    expect(actions(command)).toEqual([{ type: "notice.show", text }]);
  });

  it.each([
    "display-message",
    'display "#{pane_current_path}"',
    'display "window #W"',
    'display "100## done"',
    'display "%H:%M"',
    "display 'saved at %T'",
    "display 100%%",
    "display '%-I o clock'",
    'display "$HOME"',
    "display ~",
    'display ""',
    "display '  '",
    "display -a",
    "display -a text",
    "display -I text",
    "display -v text",
    "display -F '#{pane_id}'",
    "display -F one two",
    "display-menu x",
    "display-panes",
    "display-popup",
  ])("%s has no equivalent", (command) => {
    expect(actions(command)).toEqual([]);
  });

  it.each(["100%", "50% done", "at 100% now"])(
    "shows the message %j, whose %% starts no date or time",
    (text) => {
      expect(actions(`display '${text}'`)).toEqual([{ type: "notice.show", text }]);
    },
  );

  it("cuts a very long message short", () => {
    const [action] = actions(`display '${"a".repeat(5000)}'`) ?? [];

    expect(action).toEqual({ type: "notice.show", text: "a".repeat(200) });
  });

  it("does not cut a long message in the middle of a character", () => {
    const emoji = "\u{1f600}";

    expect(actions(`display '${"a".repeat(199)}${emoji}b'`)).toEqual([
      { type: "notice.show", text: "a".repeat(199) },
    ]);
    expect(actions(`display '${"a".repeat(198)}${emoji}b'`)).toEqual([
      { type: "notice.show", text: `${"a".repeat(198)}${emoji}` },
    ]);
  });

  it.each([
    "rotate-window",
    "next-layout",
    "break-pane",
    "swap-pane -U",
    "paste-buffer -p",
    "detach-client",
    "command-prompt",
    "switch-client -T resize",
    "refresh-client",
    "send-keys C-l",
    "send-keys -R",
    'run-shell "tmux kill-pane"',
    'if-shell "true" "kill-pane"',
    "if-shell true { kill-pane }",
    'run "split-window -h"',
    "set -g mouse on",
    "bind y kill-pane",
    "nonsense",
    "$command",
    "{ kill-pane } more",
  ])("%s has no equivalent", (command) => {
    expect(actions(command)).toEqual([]);
  });
});

describe("copy mode commands", () => {
  it.each([
    ["cursor-left", "char-left"],
    ["cursor-right", "char-right"],
    ["cursor-up", "line-up"],
    ["cursor-down", "line-down"],
    ["next-word", "word-forward"],
    ["previous-word", "word-back"],
    ["next-word-end", "word-end"],
    ["start-of-line", "line-start"],
    ["back-to-indentation", "line-indent"],
    ["end-of-line", "line-end"],
    ["previous-paragraph", "paragraph-back"],
    ["next-paragraph", "paragraph-forward"],
    ["history-top", "document-start"],
    ["history-bottom", "document-end"],
    ["top-line", "screen-top"],
    ["middle-line", "screen-middle"],
    ["bottom-line", "screen-bottom"],
    ["halfpage-up", "half-page-up"],
    ["halfpage-down", "half-page-down"],
    ["page-up", "page-up"],
    ["page-down", "page-down"],
  ] as const)("send-keys -X %s moves by %s", (name, motion) => {
    expect(actions(`send-keys -X ${name}`)).toEqual([{ type: "copy.move", motion }]);
    expect(actions(`send -X ${name}`)).toEqual([{ type: "copy.move", motion }]);
  });

  it("scrolls with scroll-up and scroll-down", () => {
    expect(actions("send -X scroll-up")).toEqual([{ type: "copy.scroll", direction: -1 }]);
    expect(actions("send -X scroll-down")).toEqual([{ type: "copy.scroll", direction: 1 }]);
  });

  it("starts, drops and leaves with begin-selection, clear-selection and cancel", () => {
    expect(actions("send -X begin-selection")).toEqual([{ type: "copy.beginSelection" }]);
    expect(actions("send -X clear-selection")).toEqual([{ type: "copy.clearSelection" }]);
    expect(actions("send -X cancel")).toEqual([{ type: "copy.exit" }]);
  });

  it.each([
    ["copy-selection", "clear"],
    ["copy-pipe", "clear"],
    [`copy-pipe "${SHELL_COMMAND}"`, "clear"],
    ["copy-selection-no-clear", "keep"],
    ["copy-pipe-no-clear", "keep"],
    ["copy-pipe-no-clear xclip", "keep"],
    ["copy-selection-and-cancel", "exit"],
    ["copy-pipe-and-cancel", "exit"],
    [`copy-pipe-and-cancel "${SHELL_COMMAND}"`, "exit"],
    ["copy-pipe-and-cancel 'xclip -in -selection clipboard' prefix", "exit"],
  ] as const)("send-keys -X %s copies, and then: %s", (command, after) => {
    expect(actions(`send-keys -X ${command}`)).toEqual([{ type: "copy.yank", after }]);
  });

  it("never hands on the shell command of a copy-pipe", () => {
    const found = actions(`send-keys -X copy-pipe-and-cancel "${SHELL_COMMAND}"`);

    expect(JSON.stringify(found)).toBe('[{"type":"copy.yank","after":"exit"}]');
  });

  it("reads the flags of send-keys in any order", () => {
    expect(actions("send-keys -t 1 -X cancel")).toEqual([{ type: "copy.exit" }]);
    expect(actions("send -FX cursor-up")).toEqual([{ type: "copy.move", motion: "line-up" }]);
  });

  it("keeps a command that is sent with -N as one entry with its count", () => {
    const up = { type: "copy.move", motion: "line-up" };

    expect(actions("send-keys -N 3 -X cursor-up")).toEqual([
      { type: "repeated", action: up, count: 3 },
    ]);
    expect(actions("send -N5 -X scroll-up")).toEqual([
      { type: "repeated", action: { type: "copy.scroll", direction: -1 }, count: 5 },
    ]);
    expect(actions("send -X -N 1 cursor-up")).toEqual([up]);
  });

  it("takes any repeat count up to the limit of a binding, and gives a larger one no action", () => {
    expect(countOf("send -N 150 -X cursor-up")).toBe(150);
    expect(actions(`send -N ${MAX_BINDING_ACTIONS} -X cursor-up`)).toHaveLength(1);
    expect(countOf(`send -N ${MAX_BINDING_ACTIONS} -X cursor-up`)).toBe(
      MAX_BINDING_ACTIONS,
    );
    expect(actions(`send -N ${MAX_BINDING_ACTIONS + 1} -X cursor-up`)).toEqual([]);
    expect(actions("send -N 4294967295 -X cursor-up")).toEqual([]);
  });

  it.each([
    "send -X cursor-up extra",
    "send -X cancel now",
    "send -X copy-selection a b",
    "send -X copy-pipe-and-cancel a b c",
  ])("%s, with more arguments than tmux lets the command take, has no equivalent", (command) => {
    expect(actions(command)).toEqual([]);
  });

  it.each([
    "send-keys -X rectangle-toggle",
    "send-keys -X select-line",
    "send-keys -X other-end",
    "send-keys -X next-space",
    "send-keys -X search-again",
    "send-keys -X jump-again",
    "send-keys -X copy-line",
    "send-keys -X copy-end-of-line",
    "send-keys -X copy-pipe-end-of-line-and-cancel",
    "send-keys -X scroll-middle",
    "send-keys -X page-down-and-cancel",
    "send-keys -X",
    "send-keys -X $command",
    "send-keys cancel",
    "send-keys -N 0 -X cursor-up",
    "send-keys -N 4294967296 -X cursor-up",
    "send-keys -N many -X cursor-up",
    'command-prompt -p "(goto line)" { send -X goto-line "%%" }',
  ])("%s has no equivalent", (command) => {
    expect(actions(command)).toEqual([]);
  });
});

// The shortest form of each command that tmux 3.5a still takes, worked out
// from the command names of its cmd.c, with what a key bound to it does. One
// character less and tmux answers "ambiguous command" or "unknown command".
describe("the shortest form of a command name", () => {
  const SHORTEST: [form: string, action: CommandAction][] = [
    ["select-p -L", { type: "pane.focus", direction: "left" }],
    ["last-p", { type: "pane.last" }],
    ["sp", { type: "chooser.open", placement: "down" }],
    ["kill-p", { type: "pane.close" }],
    ["resize-p -Z", { type: "pane.zoom" }],
    ["cop", { type: "copy.enter", motion: null }],
    ["new-w", { type: "thread.new" }],
    ["next-w", { type: "thread.cycle", delta: 1 }],
    ["previous-w", { type: "thread.cycle", delta: -1 }],
    ["last-w", { type: "thread.last" }],
    ["select-w -n", { type: "thread.cycle", delta: 1 }],
    ["choose-t", { type: "chooser.open", placement: "replace" }],
    ["list-k", { type: "help.open" }],
    ["send-p", { type: "prefix.send", second: false }],
    ["so x", { type: "config.reload" }],
    ["display-mes hi", { type: "notice.show", text: "hi" }],
    ["send-k -X cancel", { type: "copy.exit" }],
    ["con kill-pane", { type: "pane.close" }],
  ];

  function oneCharacterLess(form: string): string {
    const [name, ...rest] = form.split(" ");
    return [name.slice(0, -1), ...rest].join(" ");
  }

  it.each(SHORTEST)("takes %j", (form, action) => {
    expect(actions(form)).toEqual([action]);
  });

  it.each(SHORTEST)("does not take %j with one character less", (form) => {
    expect(actions(oneCharacterLess(form))).toEqual([]);
  });
});

describe("the commands of one key", () => {
  it("runs the commands of a sequence in their order, up to the first one without equivalent", () => {
    expect(
      actions("source-file ~/.tmux.conf \\; display 'Reloaded' \\; refresh-client \\; resize-pane -Z"),
    ).toEqual([
      { type: "config.reload" },
      { type: "notice.show", text: "Reloaded" },
    ]);
  });

  it.each([
    "swap-window -t -1 \\; select-window -t -1",
    "set -g mouse on \\; display 'Mouse: ON'",
    'run "tmux save-buffer - | pbcopy" \\; display "Copied"',
    "break-pane \\; select-window -l",
    "select-pane -t 2 \\; kill-pane",
    "{\n  swap-pane -U\n  kill-pane\n}",
    "'rotate-window ; select-pane -L'",
    'confirm-before "swap-pane -U ; kill-pane"',
    "confirm-before kill-window \\; kill-pane",
  ])("does nothing for %s, whose first command has no equivalent", (commands) => {
    expect(actions(commands)).toEqual([]);
  });

  it("keeps a command in front of the one without equivalent", () => {
    expect(actions("split-window -h \\; select-layout even-horizontal")).toEqual([
      { type: "chooser.open", placement: "right" },
    ]);
    expect(actions("new-window \\; rename-window logs \\; display named")).toEqual([
      { type: "thread.new" },
    ]);
  });

  it.each([
    'confirm-before "kill-pane ; swap-pane -U" \\; display gone',
    'confirm-before -p "sure?" "kill-pane ; swap-pane -U" \\; display gone',
    "confirm-before { kill-pane ; swap-pane -U } \\; display gone",
    'confirm-before "kill-pane ; swap-pane -U" \\; kill-pane',
    "confirm-before 'confirm-before \"kill-pane ; swap-pane -U\"' \\; display gone",
  ])("ends the sequence of %s inside the confirm-before, at the command without equivalent", (commands) => {
    expect(actions(commands)).toEqual([{ type: "pane.close" }]);
  });

  it("goes on behind a confirm-before whose commands all have an equivalent", () => {
    expect(actions('confirm-before "kill-pane ; display one" \\; display two')).toEqual([
      { type: "pane.close" },
      { type: "notice.show", text: "one" },
      { type: "notice.show", text: "two" },
    ]);
  });

  it("takes a binding with as many actions as the limit, and gives one with more no action", () => {
    const pages = (count: number): string =>
      `{ ${Array.from({ length: count }, () => "send -X -N 100 page-up").join(" ; ")} }`;

    expect(countOf(pages(MAX_BINDING_ACTIONS / 100))).toBe(MAX_BINDING_ACTIONS);
    expect(actions(pages(MAX_BINDING_ACTIONS / 100 + 1))).toEqual([]);
    expect(actions(`confirm-before "${pages(6).slice(2, -2)}"`)).toEqual([]);
  });

  it("ends a command at a semicolon that a word ends in", () => {
    expect(actions("copy-mode\\; send-keys -X begin-selection")).toEqual([
      { type: "copy.enter", motion: null },
      { type: "copy.beginSelection" },
    ]);
  });

  it("takes a semicolon behind a backslash for part of the word", () => {
    expect(actions("display 'saved\\;' \\; kill-pane")).toEqual([
      { type: "notice.show", text: "saved;" },
      { type: "pane.close" },
    ]);
  });

  it("reads the commands of a brace body, over several lines as well", () => {
    expect(actions("{ kill-pane }")).toEqual([{ type: "pane.close" }]);
    expect(
      actions("{\n  select-pane -L\n  resize-pane -Z ; display zoomed\n  rotate-window\n}"),
    ).toEqual([
      { type: "pane.focus", direction: "left" },
      { type: "pane.zoom" },
      { type: "notice.show", text: "zoomed" },
    ]);
  });

  it("parses a command that is given as one string once more", () => {
    expect(actions('"split-window -h"')).toEqual([
      { type: "chooser.open", placement: "right" },
    ]);
    expect(actions("'select-pane -U ; resize-pane -Z'")).toEqual([
      { type: "pane.focus", direction: "up" },
      { type: "pane.zoom" },
    ]);
    expect(actions("kill-pane")).toEqual([{ type: "pane.close" }]);
  });

  it("does not parse a string once more when other words stand next to it", () => {
    expect(actions('"split-window -h" -v')).toEqual([]);
  });

  it("does nothing of an if-shell or a run-shell, nor of what follows it", () => {
    expect(
      actions('if-shell "test -f x" { kill-pane } { split-window } \\; display done'),
    ).toEqual([]);
    expect(actions('run-shell "split-window -h" \\; kill-pane')).toEqual([]);
  });

  it("has no action for a key that is bound to nothing it knows", () => {
    expect(actions("rotate-window \\; next-layout")).toEqual([]);
    expect(actions("{ }")).toEqual([]);
    expect(actions("''")).toEqual([]);
    expect(actionsOfBinding([])).toEqual([]);
  });
});

// tmux reads the commands of a bind-key before it binds the key, and binds
// nothing when it refuses one of them (cmd_bind_key_exec in cmd-bind-key.c
// and args_parse in arguments.c).
describe("commands that tmux refuses to bind a key to", () => {
  it.each([
    "new-window -c",
    "split-window -c",
    "split-window -h -c",
    "next-window -t",
    "select-pane -t",
    "select-window -t",
    "display-message -d",
    "send-keys -X -N",
    "confirm-before -p",
  ])("%s, whose last flag lacks its value, is refused", (command) => {
    expect(actions(command)).toBeNull();
  });

  it.each(["kill-pane -_", "select-pane -L -.", "new-window -%"])(
    "%s, with a flag that is no letter or digit, is refused",
    (command) => {
      expect(actions(command)).toBeNull();
    },
  );

  it.each([
    "kill-pane now",
    "select-pane -L extra",
    "select-pane -t '{left-of}' extra",
    "last-pane extra",
    "last-pane -t '{left-of}' extra",
    "resize-pane -L 5 6",
    "copy-mode extra",
    "next-window extra",
    "next-window -t '{end}' extra",
    "previous-window extra",
    "last-window extra",
    "select-window -t '{end}' extra",
    "choose-tree one two",
    "list-keys one two",
    "send-prefix extra",
    "display one two",
    "confirm-before kill-pane kill-pane",
  ])("%s, with more arguments than tmux lets the command take, is refused", (command) => {
    expect(actions(command)).toBeNull();
  });

  it.each(["source-file", "confirm-before", "confirm-before -p sure"])(
    "%s, with fewer arguments than tmux needs, is refused",
    (command) => {
      expect(actions(command)).toBeNull();
    },
  );

  it.each([
    "split-window -h htop",
    "new-window -n logs 'tail -f log'",
    "resize-pane -L 5",
    "choose-tree '%%'",
    "list-keys C-b",
    "display one",
    "send-keys -X copy-pipe a b c",
    "source-file a b",
  ])("%s, which tmux takes with its arguments, is not refused", (command) => {
    expect(actions(command)).not.toBeNull();
  });

  // Neither flag is in the manual of tmux 3.5a (the .args of
  // cmd-select-pane.c and of cmd-display-message.c).
  it.each([
    "select-pane -P 'bg=red'",
    "select-pane -t :.+ -P 'bg=red'",
    "select-pane -L -P bg=red",
    "display-message -F '#{pane_id}' extra",
  ])(
    "%s, whose flag takes a value in tmux, is not refused and has no equivalent",
    (command) => {
      expect(actions(command)).toEqual([]);
    },
  );

  it.each(["select-pane -P", "display-message -F"])(
    "%s, whose flag lacks that value, is refused",
    (command) => {
      expect(actions(command)).toBeNull();
    },
  );

  it("refuses a sequence for one such command anywhere in it, also behind a command without equivalent", () => {
    expect(actions("kill-pane \\; kill-pane now")).toBeNull();
    expect(actions("rotate-window \\; kill-pane now")).toBeNull();
    expect(actions("{ kill-pane ; new-window -c }")).toBeNull();
    expect(actions("'select-pane -L ; kill-pane now'")).toBeNull();
    expect(actions("rotate-window \\; kill-pane")).toEqual([]);
  });

  it("refuses a brace body behind confirm-before with such a command, and takes a string, which tmux only reads when the key is pressed and then runs nothing of", () => {
    expect(actions("confirm-before { kill-pane now }")).toBeNull();
    expect(actions('confirm-before "kill-pane now"')).toEqual([]);
    expect(actions('confirm-before "kill-pane ; new-window -c"')).toEqual([]);
    expect(actions('confirm-before "confirm-before"')).toEqual([]);
    expect(actions('display one \\; confirm-before "kill-pane now" \\; kill-pane')).toEqual([
      { type: "notice.show", text: "one" },
    ]);
  });

  it("takes a flag that the command does not have in tmux for one without a value", () => {
    expect(actions("kill-pane -Q")).toEqual([{ type: "pane.close" }]);
  });
});
