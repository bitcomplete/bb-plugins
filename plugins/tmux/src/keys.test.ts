// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  TERMINAL_KEYS,
  formatStroke,
  isCompositionKey,
  keyStrokeFromEvent,
  strokeFromNamedKey,
  terminalKeyOf,
  typedCharacterFromEvent,
  type KeyEventLike,
} from "./keys";

const NO_BREAK_SPACE = String.fromCharCode(0xa0);

function keyEvent(
  key: string,
  overrides: Partial<KeyEventLike> = {},
): KeyEventLike {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

type NamedKey = Parameters<typeof strokeFromNamedKey>[0];

function namedKey(
  base: string,
  held: Partial<Omit<NamedKey, "base">> = {},
): NamedKey {
  return { ctrl: false, alt: false, shift: false, ...held, base };
}

describe("isCompositionKey", () => {
  it.each([
    ["a key typed during composition", { isComposing: true, keyCode: 74, key: "j" }, true],
    ["a key that an input method takes", { isComposing: false, keyCode: 229, key: "Process" }, true],
    ["the Enter that ends a composition without the composing flag", { isComposing: false, keyCode: 229, key: "Enter" }, true],
    ["a dead key", { isComposing: false, keyCode: 85, key: "Dead" }, true],
    ["a plain Enter", { isComposing: false, keyCode: 13, key: "Enter" }, false],
    ["a letter", { isComposing: false, keyCode: 74, key: "j" }, false],
  ])("tells %s from a key that is typed as it is", (_name, event, expected) => {
    expect(isCompositionKey(event)).toBe(expected);
  });
});

describe("keyStrokeFromEvent", () => {
  it.each(["a", "j", "z", "1", "9", ",", "/", "-", "`"])(
    "names the plain character %s as itself",
    (key) => {
      expect(keyStrokeFromEvent(keyEvent(key))).toBe(key);
    },
  );

  it.each(["G", "H", "L", ":", "?", "!", "_"])(
    "folds Shift into the shifted character %s",
    (key) => {
      expect(keyStrokeFromEvent(keyEvent(key, { shiftKey: true }))).toBe(key);
    },
  );

  it("keeps a capital letter typed with CapsLock and no Shift", () => {
    expect(keyStrokeFromEvent(keyEvent("A"))).toBe("A");
  });

  it("keeps a digit that needs Shift on the keyboard layout", () => {
    expect(keyStrokeFromEvent(keyEvent("1", { shiftKey: true }))).toBe("1");
  });

  it("keeps a non-ASCII character", () => {
    expect(keyStrokeFromEvent(keyEvent("é"))).toBe("é");
  });

  it.each([" ", "Spacebar"])("names the space key %j as Space", (key) => {
    expect(keyStrokeFromEvent(keyEvent(key))).toBe("Space");
  });

  it("prefixes the space key like a named key", () => {
    expect(keyStrokeFromEvent(keyEvent(" ", { shiftKey: true }))).toBe(
      "S-Space",
    );
    expect(keyStrokeFromEvent(keyEvent(" ", { ctrlKey: true }))).toBe(
      "C-Space",
    );
  });

  it.each([
    "Escape",
    "Enter",
    "Tab",
    "Backspace",
    "Delete",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "PageDown",
    "F5",
  ])("keeps the DOM name of the named key %s", (key) => {
    expect(keyStrokeFromEvent(keyEvent(key))).toBe(key);
  });

  it("adds S- to a named key pressed with Shift", () => {
    expect(keyStrokeFromEvent(keyEvent("Tab", { shiftKey: true }))).toBe(
      "S-Tab",
    );
    expect(keyStrokeFromEvent(keyEvent("Enter", { shiftKey: true }))).toBe(
      "S-Enter",
    );
  });

  it("does not lowercase a named key pressed with a modifier", () => {
    expect(keyStrokeFromEvent(keyEvent("Enter", { ctrlKey: true }))).toBe(
      "C-Enter",
    );
    expect(
      keyStrokeFromEvent(
        keyEvent("ArrowLeft", { ctrlKey: true, shiftKey: true }),
      ),
    ).toBe("C-S-ArrowLeft");
  });

  it.each([
    ["a", "C-a"],
    ["h", "C-h"],
    ["j", "C-j"],
    ["k", "C-k"],
    ["l", "C-l"],
    ["d", "C-d"],
    ["u", "C-u"],
  ])("names Ctrl+%s as %s", (key, stroke) => {
    expect(keyStrokeFromEvent(keyEvent(key, { ctrlKey: true }))).toBe(stroke);
  });

  it("lowercases the letter of a Ctrl combo typed with CapsLock", () => {
    expect(keyStrokeFromEvent(keyEvent("A", { ctrlKey: true }))).toBe("C-a");
  });

  it("adds S- when Shift is held with another modifier", () => {
    expect(
      keyStrokeFromEvent(keyEvent("A", { ctrlKey: true, shiftKey: true })),
    ).toBe("C-S-a");
    expect(
      keyStrokeFromEvent(keyEvent("K", { metaKey: true, shiftKey: true })),
    ).toBe("D-S-k");
    expect(
      keyStrokeFromEvent(keyEvent("?", { ctrlKey: true, shiftKey: true })),
    ).toBe("C-S-?");
  });

  it("names Command combos with D-", () => {
    expect(keyStrokeFromEvent(keyEvent("k", { metaKey: true }))).toBe("D-k");
  });

  it("names Alt combos with M-", () => {
    expect(keyStrokeFromEvent(keyEvent("x", { altKey: true }))).toBe("M-x");
    expect(
      keyStrokeFromEvent(keyEvent("X", { altKey: true, shiftKey: true })),
    ).toBe("M-S-x");
  });

  it("derives the base key from event.code when Alt changes the character on macOS", () => {
    expect(
      keyStrokeFromEvent(keyEvent("≈", { altKey: true, code: "KeyX" })),
    ).toBe("M-x");
    expect(
      keyStrokeFromEvent(keyEvent("£", { altKey: true, code: "Digit3" })),
    ).toBe("M-3");
    expect(
      keyStrokeFromEvent(
        keyEvent("˛", { altKey: true, shiftKey: true, code: "KeyX" }),
      ),
    ).toBe("M-S-x");
    expect(
      keyStrokeFromEvent(
        keyEvent(NO_BREAK_SPACE, { altKey: true, code: "Space" }),
      ),
    ).toBe("M-Space");
  });

  it("keeps event.key with Alt when the code is not a letter, digit or space", () => {
    expect(
      keyStrokeFromEvent(keyEvent("…", { altKey: true, code: "Semicolon" })),
    ).toBe("M-…");
    expect(keyStrokeFromEvent(keyEvent("≈", { altKey: true }))).toBe("M-≈");
  });

  it("ignores event.code when Alt is not held", () => {
    expect(keyStrokeFromEvent(keyEvent("q", { code: "KeyA" }))).toBe("q");
    expect(
      keyStrokeFromEvent(keyEvent("q", { ctrlKey: true, code: "KeyA" })),
    ).toBe("C-q");
  });

  it("orders the modifier prefixes as C-, M-, D-, S-", () => {
    expect(
      keyStrokeFromEvent(
        keyEvent("A", {
          ctrlKey: true,
          altKey: true,
          metaKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe("C-M-D-S-a");
    expect(
      keyStrokeFromEvent(keyEvent("a", { altKey: true, metaKey: true })),
    ).toBe("M-D-a");
  });

  it("names Ctrl plus the minus key without losing the key", () => {
    expect(keyStrokeFromEvent(keyEvent("-", { ctrlKey: true }))).toBe("C--");
  });

  it.each([
    "Control",
    "Shift",
    "Alt",
    "Meta",
    "CapsLock",
    "Fn",
    "AltGraph",
    "NumLock",
    "Dead",
    "Unidentified",
    "Process",
    "Eisu",
    "KanaMode",
    "Alphanumeric",
    "HangulMode",
    "HanjaMode",
    "Compose",
    "Convert",
    "NonConvert",
    "ModeChange",
    "ZenkakuHankaku",
    "Romaji",
    "",
  ])("returns null for the key %j", (key) => {
    expect(keyStrokeFromEvent(keyEvent(key))).toBeNull();
  });

  it("returns null for a modifier key even though its own flag is set", () => {
    expect(
      keyStrokeFromEvent(keyEvent("Control", { ctrlKey: true })),
    ).toBeNull();
    expect(
      keyStrokeFromEvent(keyEvent("Shift", { shiftKey: true })),
    ).toBeNull();
    expect(keyStrokeFromEvent(keyEvent("Alt", { altKey: true }))).toBeNull();
    expect(keyStrokeFromEvent(keyEvent("Meta", { metaKey: true }))).toBeNull();
  });

  it("accepts a real KeyboardEvent", () => {
    expect(
      keyStrokeFromEvent(
        new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true }),
      ),
    ).toBe("C-a");
    expect(
      keyStrokeFromEvent(
        new KeyboardEvent("keydown", {
          key: "G",
          code: "KeyG",
          shiftKey: true,
        }),
      ),
    ).toBe("G");
    expect(
      keyStrokeFromEvent(new KeyboardEvent("keydown", { key: "Shift" })),
    ).toBeNull();
  });

  it("returns null for a keydown that is a plain Event and so has no key, as a script can dispatch one", () => {
    const keyless = new Event("keydown") as unknown as KeyEventLike;

    expect(keyless.key).toBeUndefined();
    expect(keyStrokeFromEvent(keyless)).toBeNull();
  });
});

// What a German Mac keyboard sends: Option-5 types "[", Option-8 "{" and
// Option-9 "}". A French one needs Option-Shift-5 for "[".
describe("typedCharacterFromEvent on a Mac", () => {
  const IS_MAC = true;

  it.each([
    ["[", "Digit5"],
    ["{", "Digit8"],
    ["}", "Digit9"],
    ["|", "Digit7"],
    ["@", "KeyL"],
  ])("is %s for a character typed with Option", (key, code) => {
    const event = keyEvent(key, { altKey: true, code });
    expect(typedCharacterFromEvent(event, IS_MAC)).toBe(key);
  });

  it("is the character when Shift is needed as well", () => {
    const event = keyEvent("[", { altKey: true, shiftKey: true, code: "Digit5" });
    expect(typedCharacterFromEvent(event, IS_MAC)).toBe("[");
  });

  it("is the character for the symbols Option types on a US keyboard", () => {
    const event = keyEvent("≈", { altKey: true, code: "KeyX" });
    expect(typedCharacterFromEvent(event, IS_MAC)).toBe("≈");
  });

  it("is null without Option, where the key press is a character already", () => {
    expect(typedCharacterFromEvent(keyEvent("["), IS_MAC)).toBeNull();
    expect(
      typedCharacterFromEvent(keyEvent("{", { shiftKey: true }), IS_MAC),
    ).toBeNull();
  });

  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])("is null when %s is held too, which makes it a shortcut", (_name, modifier) => {
    const event = keyEvent("[", { altKey: true, code: "Digit5", ...modifier });
    expect(typedCharacterFromEvent(event, IS_MAC)).toBeNull();
  });

  it.each(["a", "Z", "5"])("is null for the letter or digit %s", (key) => {
    expect(
      typedCharacterFromEvent(keyEvent(key, { altKey: true }), IS_MAC),
    ).toBeNull();
  });

  it.each(["ArrowLeft", "Enter", "Dead", " ", NO_BREAK_SPACE])(
    "is null for %j, which is not a visible character",
    (key) => {
      expect(
        typedCharacterFromEvent(keyEvent(key, { altKey: true }), IS_MAC),
      ).toBeNull();
    },
  );
});

// Windows can report AltGr as Ctrl plus Alt. Alt alone types nothing there.
describe("typedCharacterFromEvent on Windows and Linux", () => {
  const IS_MAC = false;

  it("is the character typed with AltGr, reported as Ctrl plus Alt", () => {
    const event = keyEvent("[", { ctrlKey: true, altKey: true, code: "Digit8" });
    expect(typedCharacterFromEvent(event, IS_MAC)).toBe("[");
  });

  it("is null for Alt alone, which is a shortcut there", () => {
    const event = keyEvent("[", { altKey: true, code: "BracketLeft" });
    expect(typedCharacterFromEvent(event, IS_MAC)).toBeNull();
  });

  it("is null for Ctrl alone and for the Windows key", () => {
    expect(
      typedCharacterFromEvent(keyEvent("[", { ctrlKey: true }), IS_MAC),
    ).toBeNull();
    expect(
      typedCharacterFromEvent(
        keyEvent("[", { ctrlKey: true, altKey: true, metaKey: true }),
        IS_MAC,
      ),
    ).toBeNull();
  });
});

describe("strokeFromNamedKey", () => {
  it.each([",", "g", "G", "?", ":", "/", "`", "\\", "1", "é", "-", "+"])(
    "keeps the single character %j as it is",
    (base) => {
      expect(strokeFromNamedKey(namedKey(base))).toBe(base);
    },
  );

  it.each(["Space", "Escape", "Enter", "Tab", "Backspace", "ArrowLeft", "PageDown", "F5"])(
    "keeps the name of the key %s",
    (base) => {
      expect(strokeFromNamedKey(namedKey(base))).toBe(base);
    },
  );

  it.each<[Partial<Omit<NamedKey, "base">>, string, string]>([
    [{ ctrl: true }, "a", "C-a"],
    [{ alt: true }, "x", "M-x"],
    [{ ctrl: true, alt: true }, "x", "C-M-x"],
    [{ ctrl: true, shift: true }, "a", "C-S-a"],
    [{ alt: true, shift: true }, "x", "M-S-x"],
    [{ ctrl: true, alt: true, shift: true }, "x", "C-M-S-x"],
    [{ ctrl: true }, "Space", "C-Space"],
    [{ alt: true }, "Space", "M-Space"],
    [{ shift: true }, "Tab", "S-Tab"],
    [{ ctrl: true, shift: true }, "Tab", "C-S-Tab"],
    [{ ctrl: true }, "ArrowRight", "C-ArrowRight"],
    [{ shift: true }, "F5", "S-F5"],
    [{ ctrl: true }, "F12", "C-F12"],
    [{ ctrl: true }, "-", "C--"],
    [{ ctrl: true }, "+", "C-+"],
    [{ alt: true }, "1", "M-1"],
    [{ alt: true }, "!", "M-!"],
    [{ ctrl: true, shift: true }, "?", "C-S-?"],
  ])("puts the held keys %j in front of %s, in the order C-, M-, S-: %s", (held, base, stroke) => {
    expect(strokeFromNamedKey(namedKey(base, held))).toBe(stroke);
  });

  it("writes a letter that is named with Ctrl or Alt in lower case", () => {
    expect(strokeFromNamedKey(namedKey("A", { ctrl: true }))).toBe("C-a");
    expect(strokeFromNamedKey(namedKey("X", { alt: true }))).toBe("M-x");
    expect(strokeFromNamedKey(namedKey("X", { alt: true, shift: true }))).toBe("M-S-x");
    expect(strokeFromNamedKey(namedKey("É", { alt: true, shift: true }))).toBe("M-S-é");
  });

  it("turns Shift plus a letter into the capital letter", () => {
    expect(strokeFromNamedKey(namedKey("g", { shift: true }))).toBe("G");
    expect(strokeFromNamedKey(namedKey("G", { shift: true }))).toBe("G");
    expect(strokeFromNamedKey(namedKey("é", { shift: true }))).toBe("É");
  });

  it.each(["1", "/", "`", "-", "+"])(
    "has no stroke for Shift plus %j, whose shifted form depends on the keyboard layout",
    (base) => {
      expect(strokeFromNamedKey(namedKey(base, { shift: true }))).toBeNull();
    },
  );

  it("produces the stroke that the matching key event produces", () => {
    expect(strokeFromNamedKey(namedKey("a", { ctrl: true }))).toBe(
      keyStrokeFromEvent(keyEvent("a", { ctrlKey: true })),
    );
    expect(strokeFromNamedKey(namedKey("x", { alt: true }))).toBe(
      keyStrokeFromEvent(keyEvent("≈", { altKey: true, code: "KeyX" })),
    );
    expect(strokeFromNamedKey(namedKey("x", { alt: true, shift: true }))).toBe(
      keyStrokeFromEvent(keyEvent("X", { altKey: true, shiftKey: true })),
    );
    expect(strokeFromNamedKey(namedKey("g", { shift: true }))).toBe(
      keyStrokeFromEvent(keyEvent("G", { shiftKey: true })),
    );
    expect(strokeFromNamedKey(namedKey("Space"))).toBe(
      keyStrokeFromEvent(keyEvent(" ")),
    );
    expect(strokeFromNamedKey(namedKey("Tab", { shift: true }))).toBe(
      keyStrokeFromEvent(keyEvent("Tab", { shiftKey: true })),
    );
    expect(strokeFromNamedKey(namedKey("ArrowLeft", { ctrl: true, shift: true }))).toBe(
      keyStrokeFromEvent(keyEvent("ArrowLeft", { ctrlKey: true, shiftKey: true })),
    );
  });
});

describe("terminalKeyOf", () => {
  it.each([
    ["Ctrl-[", keyEvent("[", { ctrlKey: true }), "Escape"],
    ["Ctrl-m", keyEvent("m", { ctrlKey: true }), "Enter"],
    ["Ctrl-i", keyEvent("i", { ctrlKey: true }), "Tab"],
  ])("is the key that a terminal sends for a press of %s: %s", (_name, event, key) => {
    const stroke = keyStrokeFromEvent(event);

    expect(stroke).not.toBeNull();
    expect(terminalKeyOf(stroke ?? "")).toBe(key);
  });

  it.each([
    ["Escape", keyEvent("Escape")],
    ["Enter", keyEvent("Enter")],
    ["Tab", keyEvent("Tab")],
    ["[", keyEvent("[")],
    ["m", keyEvent("m")],
    ["Ctrl-Shift-m", keyEvent("M", { ctrlKey: true, shiftKey: true })],
    ["Ctrl-Alt-m", keyEvent("m", { ctrlKey: true, altKey: true })],
    ["Ctrl-Cmd-i", keyEvent("i", { ctrlKey: true, metaKey: true })],
    ["Alt-[", keyEvent("[", { altKey: true })],
    ["Cmd-[", keyEvent("[", { metaKey: true })],
    ["Ctrl-]", keyEvent("]", { ctrlKey: true })],
    ["Ctrl-j", keyEvent("j", { ctrlKey: true })],
    ["Ctrl-h", keyEvent("h", { ctrlKey: true })],
  ])("is null for a press of %s, which stays the key it is", (_name, event) => {
    expect(terminalKeyOf(keyStrokeFromEvent(event) ?? "")).toBeNull();
  });

  it("knows three such keys, each a chord that stands for a plain key", () => {
    expect([...TERMINAL_KEYS]).toEqual([
      ["C-[", "Escape"],
      ["C-m", "Enter"],
      ["C-i", "Tab"],
    ]);
  });
});

describe("formatStroke", () => {
  it.each([
    ["C-a", "Ctrl-a"],
    ["M-x", "Alt-x"],
    ["S-Tab", "Shift-Tab"],
    ["C-S-a", "Ctrl-Shift-a"],
    ["C-M-S-x", "Ctrl-Alt-Shift-x"],
    ["C-Space", "Ctrl-Space"],
    ["C--", "Ctrl--"],
    ["C-d", "Ctrl-d"],
  ])("shows %s as %s", (stroke, label) => {
    expect(formatStroke(stroke)).toBe(label);
  });

  it.each([
    "Escape",
    "Enter",
    "Space",
    "PageUp",
    "g",
    "G",
    "C",
    "M",
    "D",
    "S",
    "-",
    "?",
    ",",
  ])("leaves %s unchanged", (stroke) => {
    expect(formatStroke(stroke)).toBe(stroke);
    expect(formatStroke(stroke, true)).toBe(stroke);
  });

  it.each([
    ["ArrowUp", "Up"],
    ["ArrowDown", "Down"],
    ["ArrowLeft", "Left"],
    ["ArrowRight", "Right"],
    ["C-ArrowRight", "Ctrl-Right"],
    ["M-S-ArrowUp", "Alt-Shift-Up"],
  ])("names the arrow key of %s as tmux and the README do: %s", (stroke, label) => {
    expect(formatStroke(stroke)).toBe(label);
  });

  it("names an arrow key the same way on a Mac", () => {
    expect(formatStroke("M-ArrowLeft", true)).toBe("Option-Left");
  });

  it.each([
    ["M-h", "Option-h"],
    ["M-S-l", "Option-Shift-l"],
    ["C-M-S-x", "Ctrl-Option-Shift-x"],
    ["C-a", "Ctrl-a"],
    ["S-Tab", "Shift-Tab"],
  ])("shows %s as %s on a Mac, where the Alt key is called Option", (stroke, label) => {
    expect(formatStroke(stroke, true)).toBe(label);
  });

  it("names the key Alt when it is not told that the keyboard is a Mac's", () => {
    expect(formatStroke("M-h", false)).toBe("Alt-h");
    expect(formatStroke("M-h")).toBe("Alt-h");
  });
});
