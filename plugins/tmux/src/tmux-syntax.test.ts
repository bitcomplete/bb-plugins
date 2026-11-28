import { describe, expect, it } from "vitest";
import {
  isCommand,
  parseCommands,
  parseFlags,
  plainText,
  wholeNumber,
  type Argument,
  type Block,
  type Word,
} from "./tmux-syntax";

function word(text: string, isExpanded = false): Word {
  return { type: "word", text, isExpanded };
}

function words(...texts: string[]): Word[] {
  return texts.map((text) => word(text));
}

function block(...commands: Argument[][]): Block {
  return { type: "block", commands };
}

describe("parseCommands", () => {
  it("reads one command per line and per semicolon, without the comments", () => {
    const text = [
      "set -g mouse on # the mouse",
      "unbind C-b ; bind C-a send-prefix",
      "",
      "# nothing here",
    ].join("\n");

    expect(parseCommands(text)).toEqual([
      words("set", "-g", "mouse", "on"),
      words("unbind", "C-b"),
      words("bind", "C-a", "send-prefix"),
    ]);
  });

  it("keeps an escaped or quoted semicolon as a word of the command", () => {
    expect(parseCommands("bind r source-file a \\; display 'b;c'")).toEqual([
      words("bind", "r", "source-file", "a", ";", "display", "b;c"),
    ]);
  });

  it("marks a word that tmux would expand", () => {
    expect(parseCommands('source-file ~/.tmux.conf "$HOME/x" \'$HOME\'')).toEqual([
      [
        word("source-file"),
        word("~/.tmux.conf", true),
        word("$HOME/x", true),
        word("$HOME"),
      ],
    ]);
  });

  it("marks a ~ at the start of a word in double quotes, which tmux expands as well", () => {
    expect(parseCommands(`bind "~" kill-pane`)).toEqual([
      [word("bind"), word("~", true), word("kill-pane")],
    ]);
    expect(parseCommands(`display "~/.tmux.conf reloaded"`)).toEqual([
      [word("display"), word("~/.tmux.conf reloaded", true)],
    ]);
  });

  it.each([`'~'`, `'~/x'`, `"a~"`, `a~`, `\\~`, `"\\~"`, `"a"'~'`, `"a\n~"`])(
    "leaves the ~ of %s as it is",
    (written) => {
      const [[, key]] = parseCommands(`bind ${written} kill-pane`);

      expect(key).toMatchObject({ isExpanded: false });
    },
  );

  it.each([
    [`"saved to "~/x`, "saved to ~/x"],
    [`a"~/x"`, "a~/x"],
    [`''~/x`, "~/x"],
    [`a'b'~`, "ab~"],
  ])(
    "marks the ~ of %s, which tmux expands right after a quote opens or closes",
    (written, text) => {
      expect(parseCommands(`display ${written}`)).toEqual([
        [word("display"), word(text, true)],
      ]);
    },
  );

  it("reads a variable in braces as part of its word, outside quotes and inside", () => {
    const text = 'bind r source-file ${HOME}/.tmux.conf \\; display "${USER} done" ${}';

    expect(parseCommands(text)).toEqual([
      [
        word("bind"),
        word("r"),
        word("source-file"),
        word("${HOME}/.tmux.conf", true),
        word(";"),
        word("display"),
        word("${USER} done", true),
        word("${}", true),
      ],
    ]);
  });

  it("does not take the brace of a variable for the end of a block", () => {
    const text = [
      "bind m {",
      "  run-shell ${HOME}/bin/toggle",
      "  set -g mouse on",
      "}",
      "bind y kill-pane",
    ].join("\n");

    expect(parseCommands(text)).toEqual([
      [
        word("bind"),
        word("m"),
        block(
          [word("run-shell"), word("${HOME}/bin/toggle", true)],
          words("set", "-g", "mouse", "on"),
        ),
      ],
      words("bind", "y", "kill-pane"),
    ]);
  });

  it("leaves a ${...} inside single quotes as it is", () => {
    expect(parseCommands("display '${HOME}'")).toEqual([words("display", "${HOME}")]);
  });

  it.each(["${HOME/x}", "${HOME:-/tmp}", "${HO-ME}", "${HOME", "${FOO:-a b}", "${FOO;bar}"])(
    "drops a command with %s, which tmux refuses, and reads the commands around it",
    (variable) => {
      const text = [
        "set -g mouse on",
        `bind a run-shell ${variable}`,
        "bind b kill-pane",
      ].join("\n");

      expect(parseCommands(text)).toEqual([
        words("set", "-g", "mouse", "on"),
        words("bind", "b", "kill-pane"),
      ]);
    },
  );

  it.each([
    ["bind b kill-pane\nbind e select-window -t :$", [words("bind", "b", "kill-pane")]],
    ["display cost$", []],
    ['display "cost"$', []],
    ["bind e select-window -t :$\\\n", []],
  ])("drops the command of %j, whose $ ends the text, which tmux refuses", (text, commands) => {
    expect(parseCommands(text)).toEqual(commands);
  });

  it.each([
    ["display $\n", [words("display", "$")]],
    ["display $ ", [words("display", "$")]],
    ["display a$\nbind b kill-pane", [words("display", "a$"), words("bind", "b", "kill-pane")]],
    ["display $ ; display b", [words("display", "$"), words("display", "b")]],
    ['display "$"', [words("display", "$")]],
    ["display '$'", [words("display", "$")]],
    ["display 'cost$'", [words("display", "cost$")]],
    ["bind e { display $}", [[word("bind"), word("e"), block(words("display", "$"))]]],
  ])("reads the $ of %j as a character, with something behind it or inside single quotes", (text, commands) => {
    expect(parseCommands(text)).toEqual(commands);
  });

  it("keeps the block around a command with a ${...} that tmux refuses", () => {
    const text = "bind m {\n  run-shell ${HOME:-/tmp}/x\n  set -g mouse on\n}\nbind y kill-pane";

    expect(parseCommands(text)).toEqual([
      [word("bind"), word("m"), block(words("set", "-g", "mouse", "on"))],
      words("bind", "y", "kill-pane"),
    ]);
  });

  it.each([
    ["${FOO:-a b}", []],
    ["${FOO;bar}", []],
    ["${FOO:-a\tb} c ; display d", [words("display", "d")]],
  ])(
    "keeps the block around a command with %j, whose refused braces hold a blank or a semicolon",
    (variable, behind) => {
      const text = `bind m {\n  display ${variable}\n  set -g mouse on\n}\nbind y kill-pane`;

      expect(parseCommands(text)).toEqual([
        [word("bind"), word("m"), block(...behind, words("set", "-g", "mouse", "on"))],
        words("bind", "y", "kill-pane"),
      ]);
    },
  );

  it("ends refused braces at the end of their line, so that the block is closed by its own brace", () => {
    const text = "bind m {\n  display ${FOO:-a\n  set -g mouse on\n}\nbind y kill-pane";

    expect(parseCommands(text)).toEqual([
      [word("bind"), word("m"), block(words("set", "-g", "mouse", "on"))],
      words("bind", "y", "kill-pane"),
    ]);
  });

  it("runs the command behind one NAME=value, as tmux does", () => {
    const text = [
      "PREFIX=C-a set -g prefix C-a",
      "_x1=2 bind y kill-pane",
      "bind z { FOO=bar kill-pane }",
    ].join("\n");

    expect(parseCommands(text)).toEqual([
      words("set", "-g", "prefix", "C-a"),
      words("bind", "y", "kill-pane"),
      [word("bind"), word("z"), block(words("kill-pane"))],
    ]);
  });

  it.each(["FOO=$HOME/x", "FOO=${X}", "FOO=~/x", 'FOO="$A b"', "FOO=\\377", "FOO=a=$B"])(
    "runs the command behind %s, whose value tmux would change but whose name it would not",
    (written) => {
      expect(parseCommands(`${written} set -g mouse on`)).toEqual([
        words("set", "-g", "mouse", "on"),
      ]);
    },
  );

  it("finds no command in a NAME=value alone, and refuses a second one", () => {
    expect(parseCommands("FOO=bar\nA=1 B=2 set -g mouse on")).toEqual([]);
  });

  it.each(["1A=b", "A-B=c", "=x", "'$A'=b", "$A=b", "${A}=b", "A$B=c", "A\\377=b"])(
    "takes %s for the name of a command, not for a variable to set",
    (written) => {
      const [[name]] = parseCommands(`${written} set -g mouse on`);

      expect(name).toMatchObject({ type: "word" });
      expect(parseCommands(`${written} set -g mouse on`)[0]).toHaveLength(5);
    },
  );

  it("keeps a NAME=value that is an argument", () => {
    expect(parseCommands("display a=b")).toEqual([words("display", "a=b")]);
  });

  it("hands a brace block to its command as one argument", () => {
    expect(parseCommands("bind x { kill-pane }")).toEqual([
      [word("bind"), word("x"), block(words("kill-pane"))],
    ]);
  });

  it("reads the commands of a block that spans lines", () => {
    const text = [
      "bind r {",
      "  source-file ~/.tmux.conf",
      "  display 'done' ; display again",
      "}",
      "set -g mouse on",
    ].join("\n");

    expect(parseCommands(text)).toEqual([
      [
        word("bind"),
        word("r"),
        block(
          [word("source-file"), word("~/.tmux.conf", true)],
          words("display", "done"),
          words("display", "again"),
        ),
      ],
      words("set", "-g", "mouse", "on"),
    ]);
  });

  it("reads a block inside a block, and two blocks of one command", () => {
    expect(
      parseCommands("bind x if-shell true { confirm-before { kill-pane } } { display no }"),
    ).toEqual([
      [
        word("bind"),
        word("x"),
        word("if-shell"),
        word("true"),
        block([word("confirm-before"), block(words("kill-pane"))]),
        block(words("display", "no")),
      ],
    ]);
  });

  it("takes a brace inside quotes or in a comment for text", () => {
    const text = 'bind x {\n  display "}"\n  # } is not the end\n  kill-pane\n}';

    expect(parseCommands(text)).toEqual([
      [word("bind"), word("x"), block(words("display", "}"), words("kill-pane"))],
    ]);
  });

  it("drops a command whose block is never closed, and all that follows it", () => {
    expect(parseCommands("set -g mouse on\nbind x {\n  kill-pane\nset -g mouse off")).toEqual([
      words("set", "-g", "mouse", "on"),
    ]);
  });

  it.each(['"', "'"])(
    "drops a command with a %s that is never closed, and all that the quote takes in",
    (quote) => {
      const text = [
        "set -g mouse on",
        `bind r display ${quote}Reloaded`,
        "bind y run-shell deploy",
        "set -g prefix C-a",
      ].join("\n");

      expect(parseCommands(text)).toEqual([words("set", "-g", "mouse", "on")]);
    },
  );

  it("drops a command whose quote is never closed inside a block", () => {
    expect(parseCommands('set -g mouse on\nbind x { display "one\n}')).toEqual([
      words("set", "-g", "mouse", "on"),
    ]);
  });

  it("drops only the command that a stray closing brace stands in", () => {
    expect(parseCommands("bind x kill-pane }\nset -g mouse on")).toEqual([
      words("set", "-g", "mouse", "on"),
    ]);
  });

  it("leaves out what stands between %if and %endif, also inside a block", () => {
    const text = [
      "%if #{==:#{host},work}",
      "bind a kill-pane",
      "%endif",
      "bind x {",
      "  %if 1",
      "  kill-pane",
      "  %endif",
      "  display done",
      "}",
    ].join("\n");

    expect(parseCommands(text)).toEqual([
      [word("bind"), word("x"), block(words("display", "done"))],
    ]);
  });

  it.each([
    ["\\a", "\u0007"],
    ["\\b", "\b"],
    ["\\e", "\u001b"],
    ["\\f", "\f"],
    ["\\n", "\n"],
    ["\\r", "\r"],
    ["\\s", " "],
    ["\\t", "\t"],
    ["\\v", "\v"],
    ["\\101", "A"],
    ["\\177", "\u007f"],
    ["\\303\\251", "\u00e9"],
    ["\\360\\237\\230\\200", "\u{1f600}"],
    ["\\u00e9", "\u00e9"],
    ["\\U0001f600", "\u{1f600}"],
    ["\\q", "q"],
    ["\\8", "8"],
  ])("reads the escape %s as tmux does", (escape, character) => {
    expect(parseCommands(`display "a${escape}b"`)).toEqual([
      words("display", `a${character}b`),
    ]);
  });

  it.each(["\\377", "\\303", "\\303x\\251", "\\251\\303"])(
    "cannot know a word with the octal escapes %s, whose bytes are no UTF-8 text",
    (escape) => {
      expect(parseCommands(`display "a${escape}b"`)).toEqual([
        [word("display"), expect.objectContaining({ isExpanded: true })],
      ]);
    },
  );

  it("reads \\s as a space, so that a word can hold one without quotes", () => {
    expect(parseCommands("display saved\\sto\\sdisk")).toEqual([
      words("display", "saved to disk"),
    ]);
  });

  it.each(["\\400", "\\477", "\\777", "\\7", "\\0", "\\12", "\\08", "\\1a2"])(
    "drops a command with the octal escape %s, which tmux refuses, and reads the commands around it",
    (escape) => {
      const text = [
        "set -g mouse on",
        `bind a display "x${escape}y"`,
        "bind b kill-pane",
      ].join("\n");

      expect(parseCommands(text)).toEqual([
        words("set", "-g", "mouse", "on"),
        words("bind", "b", "kill-pane"),
      ]);
    },
  );

  it.each(["\\u12 ", "\\u12g4", "\\U0000123", "\\UFFFFFFFF", "\\U00110000", "\\ud800", "\\udfff"])(
    "drops a command with the escape %s, which tmux refuses, and reads the commands around it",
    (escape) => {
      const text = [
        "set -g mouse on",
        `bind a display "x${escape}y"`,
        "bind b kill-pane",
      ].join("\n");

      expect(parseCommands(text)).toEqual([
        words("set", "-g", "mouse", "on"),
        words("bind", "b", "kill-pane"),
      ]);
    },
  );

  it("drops a command that ends the text with a backslash, which tmux refuses", () => {
    expect(parseCommands("bind b kill-pane\nbind y display hi\\")).toEqual([
      words("bind", "b", "kill-pane"),
    ]);
    expect(parseCommands("bind y display hi\\\\")).toEqual([
      words("bind", "y", "display", "hi\\"),
    ]);
  });

  it("ends a line at its Windows line end", () => {
    expect(parseCommands("bind x kill-pane\r\nbind y kill-pane\r\n")).toEqual([
      words("bind", "x", "kill-pane"),
      words("bind", "y", "kill-pane"),
    ]);
  });

  it("does not join lines at a backslash in front of a Windows line end, as tmux does not", () => {
    const text = "bind x kill-pane \\\r\nbind y kill-pane\r\n";

    expect(parseCommands(text)).toEqual([
      words("bind", "x", "kill-pane", "\r"),
      words("bind", "y", "kill-pane"),
    ]);
  });

  it("ends a line at a Windows line end behind an escaped backslash", () => {
    expect(parseCommands("display a\\\\\r\nbind y kill-pane")).toEqual([
      words("display", "a\\"),
      words("bind", "y", "kill-pane"),
    ]);
  });

  it("leaves a backslash and digits inside single quotes as they are", () => {
    expect(parseCommands("display 'a\\477b'")).toEqual([
      words("display", "a\\477b"),
    ]);
  });

  it("finds no command in an empty text", () => {
    expect(parseCommands("")).toEqual([]);
    expect(parseCommands(" \n\t\n")).toEqual([]);
  });
});

describe("parseFlags", () => {
  function parse(text: string, valueFlags = "") {
    const parsed = parseFlags(parseCommands(text)[0], valueFlags);
    if (parsed === null) return null;
    return {
      flags: Object.fromEntries(
        [...parsed.flags].map(([flag, value]) => [flag, plainText(value)]),
      ),
      operands: parsed.operands.map((operand) => plainText(operand)),
    };
  }

  it("reads single flags, flags in one word, and stops at the first operand", () => {
    expect(parse("-n -rq key -x rest")).toEqual({
      flags: { n: null, r: null, q: null },
      operands: ["key", "-x", "rest"],
    });
  });

  it("gives a flag its value from the next word or from the rest of its own", () => {
    expect(parse("-T copy-mode-vi -Nnote -r key", "NT")).toEqual({
      flags: { T: "copy-mode-vi", N: "note", r: null },
      operands: ["key"],
    });
    expect(parse("-rTroot key", "T")).toEqual({
      flags: { r: null, T: "root" },
      operands: ["key"],
    });
  });

  it("takes a value that starts with a dash", () => {
    expect(parse("-t -1 key", "t")).toEqual({
      flags: { t: "-1" },
      operands: ["key"],
    });
  });

  it("ends the flags at -- and takes a single dash for an operand", () => {
    expect(parse("-r -- -n key")).toEqual({
      flags: { r: null },
      operands: ["-n", "key"],
    });
    expect(parse("- delete-buffer")).toEqual({
      flags: {},
      operands: ["-", "delete-buffer"],
    });
  });

  it("ends the flags at a block", () => {
    const [command] = parseCommands("-r { kill-pane } -n");
    const parsed = parseFlags(command, "");

    expect([...(parsed?.flags.keys() ?? [])]).toEqual(["r"]);
    expect(parsed?.operands).toHaveLength(2);
  });

  it("has no answer for a flag without its value, or one that is no letter or digit", () => {
    expect(parse("-r -T", "T")).toBeNull();
    expect(parse("-r:", "")).toBeNull();
    expect(parse("-r=x key", "")).toBeNull();
  });

  it("reads no flags from no arguments", () => {
    expect(parseFlags([], "T")).toEqual({ flags: new Map(), operands: [] });
  });
});

describe("isCommand", () => {
  const splitWindow = { name: "split-window", alias: "splitw", shortest: "sp" };
  const copyMode = { name: "copy-mode", shortest: "cop" };

  it.each(["split-window", "splitw", "sp", "split", "split-w"])(
    "takes %s for split-window",
    (written) => {
      expect(isCommand(written, splitWindow)).toBe(true);
    },
  );

  it.each(["s", "split-windows", "splitwin", "split-pane", "Split-window", ""])(
    "does not take %j for split-window",
    (written) => {
      expect(isCommand(written, splitWindow)).toBe(false);
    },
  );

  it("knows a command without an alias by its name and its shortest form only", () => {
    expect(isCommand("copy-mode", copyMode)).toBe(true);
    expect(isCommand("cop", copyMode)).toBe(true);
    expect(isCommand("co", copyMode)).toBe(false);
    expect(isCommand("undefined", copyMode)).toBe(false);
  });
});

describe("plainText and wholeNumber", () => {
  it("has the text of a word that tmux leaves as it is, and of nothing else", () => {
    expect(plainText(word("5"))).toBe("5");
    expect(plainText(word("$N", true))).toBeNull();
    expect(plainText(block())).toBeNull();
    expect(plainText(null)).toBeNull();
    expect(plainText(undefined)).toBeNull();
  });

  it.each([
    ["0", 0],
    ["5", 5],
    ["007", 7],
    ["100", 100],
  ])("reads %j as %d", (text, value) => {
    expect(wholeNumber(text, 0, 100)).toBe(value);
  });

  it.each(["", "-1", "+1", "1.5", "1e2", " 1", "0x10", "101", "9".repeat(400)])(
    "has no number between 0 and 100 for %j",
    (text) => {
      expect(wholeNumber(text, 0, 100)).toBeNull();
    },
  );

  it("has no number for no text, and none below the least one allowed", () => {
    expect(wholeNumber(null, 0, 100)).toBeNull();
    expect(wholeNumber("0", 1, 100)).toBeNull();
  });
});
