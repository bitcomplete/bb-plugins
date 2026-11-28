import { describe, expect, it } from "vitest";
import {
  describePrefix,
  isUsablePrefix,
  resolvePrefix,
  worksWithoutPrefix,
  type ResolvedPrefix,
  type TmuxLookup,
  type TmuxPrefix,
} from "./prefix";
import { STOCK_TMUX_OPTIONS } from "./tmux-defaults";

const EM_DASH = String.fromCharCode(0x2014);

const NOTHING_SET: TmuxLookup = { status: "answered", prefix: null };
const UNAVAILABLE: TmuxLookup = { status: "unavailable" };

const DEFAULT_NOT_SET: ResolvedPrefix = {
  stroke: "C-b",
  origin: { kind: "tmux-default", cause: { kind: "not-set" } },
};

function answered(prefix: TmuxPrefix): TmuxLookup {
  return { status: "answered", prefix };
}

function fromConfig(key: string, path = "~/.tmux.conf"): TmuxLookup {
  return answered({ key, path, usable: true });
}

function rejected(key: string, path = "~/.tmux.conf"): TmuxLookup {
  return answered({ key, path, usable: false });
}

describe("worksWithoutPrefix", () => {
  it.each(["C-a", "C-Space", "M-ArrowLeft", "C-M-S-x", "C-S-Tab", "F5", "S-F12"])(
    "is true for %s, which has Ctrl or Alt or is a function key",
    (stroke) => {
      expect(worksWithoutPrefix(stroke)).toBe(true);
    },
  );

  it.each(["a", "A", "`", "-", "5", "Space", "Enter", "Escape", "S-ArrowLeft", "S-Tab", "PageUp", "F"])(
    "is false for %s, which would be taken away from typing",
    (stroke) => {
      expect(worksWithoutPrefix(stroke)).toBe(false);
    },
  );

  it.each(["D-k", "D-S-k", "D-ArrowLeft", "D-F5"])(
    "is false for %s, which has Cmd and neither Ctrl nor Alt: no tmux config names such a key",
    (stroke) => {
      expect(worksWithoutPrefix(stroke)).toBe(false);
    },
  );
});

describe("isUsablePrefix", () => {
  it.each([
    "C-a",
    "C-Space",
    "M-a",
    "C-M-a",
    "M-S-a",
    "C-M-S-x",
    "C-S-Tab",
    "C-ArrowUp",
    "M-PageDown",
    "C-F3",
    "F12",
    "S-F5",
    "C-\\",
    "C--",
    "C-S--",
    "C-+",
    "C-5",
    "M-\u00e9",
  ])("is true for %s, the stroke of one key that works without the prefix", (stroke) => {
    expect(isUsablePrefix(stroke)).toBe(true);
  });

  it.each(["a", "A", "`", "5", "Space", "Enter", "S-Tab", "PageUp", "D-k", "D-S-k"])(
    "is false for %s, which does not work without the prefix",
    (stroke) => {
      expect(isUsablePrefix(stroke)).toBe(false);
    },
  );

  it.each([
    "C-",
    "M-",
    "C-M-",
    "C-S-",
    "C-ab",
    "C-ic",
    "C-nonsense",
    "C-space",
    "C-a b",
    "M-C-a",
    "S-C-a",
    "C-C-a",
    "C-D-k",
    "M-D-k",
  ])("is false for %j, which is no stroke of one key", (stroke) => {
    expect(isUsablePrefix(stroke)).toBe(false);
  });

  it.each(["C-X", "C-M", "M-S", "M-S-X", "C-\u00c9"])(
    "is false for %s: a stroke with Ctrl or Alt has its letter in lower case",
    (stroke) => {
      expect(isUsablePrefix(stroke)).toBe(false);
    },
  );

  it.each(["C-i\u0307", "C-M-i\u0307", "C-S-i\u0307", "M-S-i\u0307", "C-M-S-i\u0307"])(
    "is false for %j, the Turkish capital dotted I in lower case, which is two characters",
    (stroke) => {
      expect("\u0130".toLowerCase()).toBe("i\u0307");
      expect(isUsablePrefix(stroke)).toBe(false);
    },
  );
});

describe("resolvePrefix", () => {
  it("has tmux's own default, Ctrl-b, as the only fallback", () => {
    expect(STOCK_TMUX_OPTIONS.prefix).toBe("C-b");
  });

  it("uses the usable prefix of the tmux config and names its file", () => {
    expect(resolvePrefix(fromConfig("C-a", "~/.config/tmux/tmux.conf"))).toEqual({
      stroke: "C-a",
      origin: { kind: "tmux-config", path: "~/.config/tmux/tmux.conf" },
    });
  });

  it("uses Ctrl-b when no tmux config exists or none sets a prefix", () => {
    expect(resolvePrefix(NOTHING_SET)).toEqual(DEFAULT_NOT_SET);
  });

  it("uses Ctrl-b and keeps the key and file of a prefix that bb cannot use", () => {
    expect(resolvePrefix(rejected("`"))).toEqual({
      stroke: "C-b",
      origin: {
        kind: "tmux-default",
        cause: { kind: "not-usable", key: "`", path: "~/.tmux.conf" },
      },
    });
  });

  it("uses Ctrl-b when the server gave no answer", () => {
    expect(resolvePrefix(UNAVAILABLE)).toEqual({
      stroke: "C-b",
      origin: { kind: "tmux-default", cause: { kind: "not-read" } },
    });
  });

  it("uses Ctrl-b, and says that a part was not read, when what was read sets no prefix and the rest may", () => {
    expect(resolvePrefix({ status: "partly-read" })).toEqual({
      stroke: "C-b",
      origin: { kind: "tmux-default", cause: { kind: "partly-read" } },
    });
  });

  it.each([
    ["None", "~/.tmux.conf"],
    ["KP7", "~/.config/tmux/tmux.conf"],
    ["`", "/etc/xdg/tmux/tmux.conf"],
  ])("keeps the rejected prefix %s of %s as it was written", (key, path) => {
    expect(resolvePrefix(rejected(key, path)).origin).toEqual({
      kind: "tmux-default",
      cause: { kind: "not-usable", key, path },
    });
  });

  it.each(["D-a", "ctrl+a", "C-a"])(
    "does not use the key %s that the server calls not usable",
    (key) => {
      expect(resolvePrefix(rejected(key))).toEqual({
        stroke: "C-b",
        origin: {
          kind: "tmux-default",
          cause: { kind: "not-usable", key, path: "~/.tmux.conf" },
        },
      });
    },
  );

  it.each([
    "C-a",
    "C-Space",
    "M-a",
    "C-M-a",
    "M-S-a",
    "C-S-Tab",
    "C-ArrowUp",
    "F12",
    "S-F5",
    "C-\\",
    "C--",
    "C-+",
  ])("hands the prefix %s of the tmux config on unchanged", (stroke) => {
    expect(resolvePrefix(fromConfig(stroke)).stroke).toBe(stroke);
  });

  it.each([
    "`",
    "a",
    "S-Tab",
    "nonsense",
    "ctrl+a",
    "",
    "C-",
    "M-",
    "C-ab",
    "C-ic",
    "C-nonsense",
    "C-X",
    "M-C-a",
    "C-i\u0307",
    "M-S-i\u0307",
    "D-k",
    "C-D-k",
  ])(
    "does not trust an answer that calls %j usable",
    (key) => {
      expect(resolvePrefix(fromConfig(key))).toEqual({
        stroke: "C-b",
        origin: {
          kind: "tmux-default",
          cause: { kind: "not-usable", key, path: "~/.tmux.conf" },
        },
      });
    },
  );

  it("never falls back to Ctrl-a", () => {
    const lookups = [NOTHING_SET, UNAVAILABLE, rejected("`"), rejected("None")];
    for (const lookup of lookups) {
      expect(resolvePrefix(lookup).stroke).toBe("C-b");
    }
  });
});

describe("describePrefix", () => {
  it.each<[string, ResolvedPrefix, string]>([
    [
      "the tmux config",
      { stroke: "C-a", origin: { kind: "tmux-config", path: "~/.tmux.conf" } },
      "Prefix: Ctrl-a, from ~/.tmux.conf",
    ],
    [
      "tmux's default",
      DEFAULT_NOT_SET,
      "Prefix: Ctrl-b, tmux's default (no tmux config sets a prefix)",
    ],
    [
      "a prefix that cannot be used",
      {
        stroke: "C-b",
        origin: {
          kind: "tmux-default",
          cause: { kind: "not-usable", key: "`", path: "~/.tmux.conf" },
        },
      },
      "Prefix: Ctrl-b, tmux's default (the prefix ` in ~/.tmux.conf cannot be used in bb)",
    ],
    [
      "a config that could not be read",
      {
        stroke: "C-b",
        origin: { kind: "tmux-default", cause: { kind: "not-read" } },
      },
      "Prefix: Ctrl-b, tmux's default (the tmux config could not be read)",
    ],
    [
      "a config of which a part could not be read",
      {
        stroke: "C-b",
        origin: { kind: "tmux-default", cause: { kind: "partly-read" } },
      },
      "Prefix: Ctrl-b, tmux's default (part of the tmux config could not be read and may set another one)",
    ],
    [
      "tmux having no prefix",
      {
        stroke: "C-b",
        origin: {
          kind: "tmux-default",
          cause: {
            kind: "not-usable",
            key: "None",
            path: "~/.config/tmux/tmux.conf",
          },
        },
      },
      "Prefix: Ctrl-b, tmux's default (the prefix None in ~/.config/tmux/tmux.conf cannot be used in bb)",
    ],
  ])("says in one line that the prefix comes from %s", (_origin, prefix, line) => {
    expect(describePrefix(prefix)).toBe(line);
    expect(line).not.toContain(EM_DASH);
    expect(line).not.toContain("\n");
  });

  it("names the Alt key Option on a Mac and Alt elsewhere", () => {
    const prefix: ResolvedPrefix = {
      stroke: "M-a",
      origin: { kind: "tmux-config", path: "~/.tmux.conf" },
    };

    expect(describePrefix(prefix, true)).toBe(
      "Prefix: Option-a, from ~/.tmux.conf",
    );
    expect(describePrefix(prefix, false)).toBe(
      "Prefix: Alt-a, from ~/.tmux.conf",
    );
  });
});
