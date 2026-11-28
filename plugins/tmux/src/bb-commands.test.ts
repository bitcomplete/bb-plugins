// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKeydownInit,
  findBinding,
  getClientEnv,
  isMacPlatform,
  isPluginSyntheticEvent,
  markPluginSyntheticEvent,
  runCoreCommand,
  setKeybindings,
  type AppKeybinding,
  type AppShortcut,
  type ClientEnv,
} from "./bb-commands";
import { BB_COMMANDS, BB_DESKTOP_GLOBAL } from "./constants";

const MAC_DESKTOP: ClientEnv = { isDesktop: true, platform: "MacIntel" };
const MAC_WEB: ClientEnv = { isDesktop: false, platform: "MacIntel" };
const LINUX_DESKTOP: ClientEnv = { isDesktop: true, platform: "Linux x86_64" };
const WINDOWS_WEB: ClientEnv = { isDesktop: false, platform: "Win32" };

function shortcut(key: string, modifiers: Partial<AppShortcut> = {}): AppShortcut {
  return {
    key,
    mod: false,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...modifiers,
  };
}

function binding(
  command: string,
  keys: AppShortcut,
  options: Partial<Omit<AppKeybinding, "command" | "shortcut">> = {},
): AppKeybinding {
  return {
    command,
    desktopOnly: false,
    shortcut: keys,
    when: { all: ["mainSurface"], none: ["modalOpen"] },
    ...options,
  };
}

// A copy of bb's matcher (packages/domain/src/app-keybindings.ts, 0.50.1) so the
// tests prove that the synthetic keydown is one bb would accept.
const SHIFTED_KEY_BASES: Readonly<Record<string, string>> = {
  "{": "[",
  "}": "]",
  "|": "\\",
  "?": "/",
};

function bbNormalizeKey(input: KeyboardEventInit): string {
  const key = input.key ?? "";
  if (key === " " || key === "Spacebar") return "Space";
  if (input.altKey && !/^[a-z0-9]$/iu.test(key)) {
    const code = input.code ?? "";
    if (/^Key[A-Z]$/u.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/u.test(code)) return code.slice(5);
  }
  return input.shiftKey ? (SHIFTED_KEY_BASES[key] ?? key) : key;
}

function bbMatchesAppShortcut(
  input: KeyboardEventInit,
  keys: AppShortcut,
  useMetaForMod: boolean,
): boolean {
  const expectedMeta = keys.meta || (keys.mod && useMetaForMod);
  const expectedControl = keys.control || (keys.mod && !useMetaForMod);
  return (
    bbNormalizeKey(input).toLowerCase() === keys.key.toLowerCase() &&
    (input.metaKey ?? false) === expectedMeta &&
    (input.ctrlKey ?? false) === expectedControl &&
    (input.altKey ?? false) === keys.alt &&
    (input.shiftKey ?? false) === keys.shift
  );
}

let listeners: AbortController;

beforeEach(() => {
  listeners = new AbortController();
  setKeybindings(null);
});

afterEach(() => {
  listeners.abort();
  setKeybindings(null);
  Reflect.deleteProperty(window, BB_DESKTOP_GLOBAL);
  vi.restoreAllMocks();
});

describe("getClientEnv", () => {
  it("reports the web surface when the desktop bridge is absent", () => {
    expect(getClientEnv()).toEqual({
      isDesktop: false,
      platform: navigator.platform,
    });
  });

  it("reports the desktop app and the browser platform", () => {
    Reflect.set(window, BB_DESKTOP_GLOBAL, {});
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    expect(getClientEnv()).toEqual({ isDesktop: true, platform: "MacIntel" });
  });
});

describe("isMacPlatform", () => {
  it("matches the Apple platform strings bb checks", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("iPhone")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(isMacPlatform("")).toBe(false);
  });
});

describe("findBinding", () => {
  it("returns null before the keybindings are loaded", () => {
    expect(findBinding(BB_COMMANDS.paneClose, MAC_DESKTOP)).toBeNull();
  });

  it("returns null when the command has no binding", () => {
    setKeybindings([binding("thread.new", shortcut("n", { mod: true }))]);
    expect(findBinding(BB_COMMANDS.paneClose, MAC_DESKTOP)).toBeNull();
  });

  it("picks the last available binding, as bb walks its list backwards", () => {
    const first = binding("thread.new", shortcut("o", { mod: true, shift: true }));
    const second = binding("thread.new", shortcut("n", { mod: true }));
    setKeybindings([
      first,
      binding("thread.search", shortcut("k", { mod: true })),
      second,
    ]);
    expect(findBinding("thread.new", MAC_DESKTOP)).toBe(second);
  });

  it("skips desktop-only bindings on the web surface", () => {
    const everywhere = binding("thread.new", shortcut("o", { mod: true, shift: true }));
    const desktopOnly = binding("thread.new", shortcut("n", { mod: true }), {
      desktopOnly: true,
    });
    setKeybindings([everywhere, desktopOnly]);
    expect(findBinding("thread.new", MAC_WEB)).toBe(everywhere);
    expect(findBinding("thread.new", MAC_DESKTOP)).toBe(desktopOnly);
  });

  it("returns null for a desktop-only command on the web surface", () => {
    setKeybindings([
      binding(BB_COMMANDS.paneMaximizeToggle, shortcut("f", { mod: true }), {
        desktopOnly: true,
      }),
    ]);
    expect(findBinding(BB_COMMANDS.paneMaximizeToggle, MAC_WEB)).toBeNull();
  });

  it("respects the webSurface context in both lists", () => {
    const webOnly = binding("thread.previous", shortcut("[", { control: true, shift: true }), {
      when: { all: ["mainSurface", "webSurface"], none: ["modalOpen"] },
    });
    const notWeb = binding("thread.previous", shortcut("[", { mod: true, shift: true }), {
      when: { all: ["mainSurface"], none: ["modalOpen", "webSurface"] },
    });
    setKeybindings([notWeb, webOnly]);
    expect(findBinding("thread.previous", MAC_DESKTOP)).toBe(notWeb);
    expect(findBinding("thread.previous", MAC_WEB)).toBe(webOnly);
  });

  it("respects the platform contexts", () => {
    const macOnly = binding("pane.focus.left", shortcut("ArrowLeft", { mod: true, control: true, shift: true }), {
      when: { all: ["mainSurface", "splitActive", "macPlatform"], none: ["modalOpen"] },
    });
    setKeybindings([macOnly]);
    expect(findBinding("pane.focus.left", MAC_DESKTOP)).toBe(macOnly);
    expect(findBinding("pane.focus.left", LINUX_DESKTOP)).toBeNull();
    expect(findBinding("pane.focus.left", WINDOWS_WEB)).toBeNull();
  });

  it("rejects a binding that excludes the current platform", () => {
    const notMac = binding("thread.jump.1", shortcut("1", { mod: true, shift: true }), {
      when: { all: ["mainSurface", "webSurface"], none: ["modalOpen", "macPlatform"] },
    });
    const windowsOnly = binding("thread.jump.1", shortcut("1", { alt: true }), {
      when: { all: ["mainSurface", "windowsPlatform"], none: [] },
    });
    setKeybindings([notMac, windowsOnly]);
    expect(findBinding("thread.jump.1", MAC_WEB)).toBeNull();
    expect(findBinding("thread.jump.1", WINDOWS_WEB)).toBe(windowsOnly);
    expect(findBinding("thread.jump.1", { isDesktop: false, platform: "Linux x86_64" })).toBe(notMac);
  });

  it("uses the current client when no environment is passed", () => {
    const desktopOnly = binding(BB_COMMANDS.paneMaximizeToggle, shortcut("f", { mod: true }), {
      desktopOnly: true,
    });
    setKeybindings([desktopOnly]);
    expect(findBinding(BB_COMMANDS.paneMaximizeToggle)).toBeNull();
    Reflect.set(window, BB_DESKTOP_GLOBAL, {});
    expect(findBinding(BB_COMMANDS.paneMaximizeToggle)).toBe(desktopOnly);
  });
});

describe("buildKeydownInit", () => {
  it("maps mod to Command on macOS", () => {
    const init = buildKeydownInit(shortcut("k", { mod: true }), true);
    expect(init).toMatchObject({
      key: "k",
      code: "KeyK",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      bubbles: true,
      cancelable: true,
    });
  });

  it("maps mod to Control on other platforms", () => {
    const init = buildKeydownInit(shortcut("k", { mod: true }), false);
    expect(init).toMatchObject({ metaKey: false, ctrlKey: true });
  });

  it("keeps explicit meta, control, alt and shift", () => {
    const init = buildKeydownInit(
      shortcut("ArrowLeft", { mod: true, control: true, shift: true }),
      true,
    );
    expect(init).toMatchObject({
      key: "ArrowLeft",
      metaKey: true,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
    });
    expect(init.code).toBeUndefined();
    expect(buildKeydownInit(shortcut("x", { meta: true, alt: true }), false)).toMatchObject({
      metaKey: true,
      ctrlKey: false,
      altKey: true,
    });
  });

  it("adds a code for letters and digits only", () => {
    expect(buildKeydownInit(shortcut("E", { mod: true, shift: true }), true).code).toBe("KeyE");
    expect(buildKeydownInit(shortcut("3", { mod: true }), true).code).toBe("Digit3");
    expect(buildKeydownInit(shortcut("\\", { mod: true }), true).code).toBeUndefined();
    expect(buildKeydownInit(shortcut("Escape"), true).code).toBeUndefined();
  });

  it("produces events that bb's matcher accepts for the commands the plugin runs", () => {
    const defaults: AppShortcut[] = [
      shortcut("p", { mod: true, shift: true }),
      shortcut("k", { mod: true }),
      shortcut("\\", { mod: true }),
      shortcut("e", { mod: true, shift: true }),
      shortcut("x", { mod: true, shift: true }),
      shortcut("f", { mod: true }),
      shortcut("[", { control: true, shift: true }),
      shortcut("3", { alt: true }),
      shortcut("Space", { control: true }),
      shortcut("Escape"),
    ];
    for (const keys of defaults) {
      for (const isMac of [true, false]) {
        const init = buildKeydownInit(keys, isMac);
        expect(bbMatchesAppShortcut(init, keys, isMac)).toBe(true);
        expect(bbMatchesAppShortcut(init, keys, !isMac)).toBe(!keys.mod);
      }
    }
  });
});

describe("runCoreCommand", () => {
  it('returns "unbound" and dispatches nothing when the command has no binding', () => {
    const seen = vi.fn();
    window.addEventListener("keydown", seen, { signal: listeners.signal });
    setKeybindings([binding("thread.new", shortcut("n", { mod: true }))]);
    expect(runCoreCommand(BB_COMMANDS.paneClose)).toBe("unbound");
    setKeybindings(null);
    expect(runCoreCommand("thread.new")).toBe("unbound");
    expect(seen).not.toHaveBeenCalled();
  });

  it('returns "ran" when a window listener prevents the default, as bb does after a command ran', () => {
    const seen: KeyboardEvent[] = [];
    window.addEventListener(
      "keydown",
      (event) => {
        seen.push(event);
        event.preventDefault();
        event.stopPropagation();
      },
      { signal: listeners.signal },
    );
    setKeybindings([binding(BB_COMMANDS.sidebarToggle, shortcut("k", { mod: true }))]);

    expect(runCoreCommand(BB_COMMANDS.sidebarToggle)).toBe("ran");
    expect(seen).toHaveLength(1);
    const [event] = seen;
    expect(event.target).toBe(document.body);
    expect(event.key).toBe("k");
    expect(event.code).toBe("KeyK");
    expect(event.ctrlKey).toBe(true);
    expect(event.metaKey).toBe(false);
    expect(event.repeat).toBe(false);
    expect(event.isComposing).toBe(false);
    expect(event.cancelable).toBe(true);
  });

  it("uses Command for mod when the browser platform is a Mac", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const seen: KeyboardEvent[] = [];
    window.addEventListener("keydown", (event) => seen.push(event), {
      signal: listeners.signal,
    });
    setKeybindings([
      binding(BB_COMMANDS.paneClose, shortcut("x", { mod: true, shift: true })),
    ]);
    runCoreCommand(BB_COMMANDS.paneClose);
    expect(seen[0]).toMatchObject({
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      key: "x",
    });
  });

  it('returns "declined" when nobody prevents the default', () => {
    const seen = vi.fn();
    window.addEventListener("keydown", seen, { signal: listeners.signal });
    setKeybindings([
      binding(BB_COMMANDS.paneMaximizeToggle, shortcut("e", { mod: true, shift: true })),
    ]);
    expect(runCoreCommand(BB_COMMANDS.paneMaximizeToggle)).toBe("declined");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("dispatches on the page body, whatever has the cursor", () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    const targets: (EventTarget | null)[] = [];
    window.addEventListener("keydown", (event) => targets.push(event.target), {
      signal: listeners.signal,
    });
    setKeybindings([binding(BB_COMMANDS.sidebarToggle, shortcut("\\", { mod: true }))]);
    runCoreCommand(BB_COMMANDS.sidebarToggle);
    expect(targets).toEqual([document.body]);
    field.remove();
  });

  it("marks its own events so the plugin's key handler can ignore them", () => {
    const flags: boolean[] = [];
    window.addEventListener(
      "keydown",
      (event) => flags.push(isPluginSyntheticEvent(event)),
      { capture: true, signal: listeners.signal },
    );
    setKeybindings([binding(BB_COMMANDS.paneClose, shortcut("p", { mod: true, shift: true }))]);
    runCoreCommand(BB_COMMANDS.paneClose);
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: true }),
    );
    expect(flags).toEqual([true, false]);
  });
});

describe("markPluginSyntheticEvent", () => {
  it("returns the event it was given and makes it one of the plugin's own", () => {
    const own = new Event("pointerdown", { bubbles: true });
    const users = new Event("pointerdown", { bubbles: true });

    expect(markPluginSyntheticEvent(own)).toBe(own);

    expect(isPluginSyntheticEvent(own)).toBe(true);
    expect(isPluginSyntheticEvent(users)).toBe(false);
  });

  it("leaves the event itself untouched, so bb cannot tell it apart", () => {
    const event = markPluginSyntheticEvent(
      new KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: true }),
    );

    expect(Object.keys(event)).toEqual(
      Object.keys(new KeyboardEvent("keydown", { key: "p" })),
    );
    expect(event.defaultPrevented).toBe(false);
  });
});
