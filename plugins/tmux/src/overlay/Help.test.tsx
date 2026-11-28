// @vitest-environment jsdom
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUiState, resetStore, updateUiState } from "../bridge";
import { buildKeymap, type TmuxSource } from "../keymap";
import { settleDomFocus, settleIdleDomFocus } from "../pane-focus";
import { DEFAULT_SETTINGS, type Settings } from "../settings";
import { stockTmuxConfig, tmuxConfigFrom } from "../tmux-keymap";
import {
  TEST_CONFIG_PATH,
  VI_STYLE_CONFIG,
  fileSources,
  tmuxConfigOf,
} from "../tmux-test-support";
import { Help } from "./Help";
import { keepClosingDialogsMounted } from "./test-support";

vi.mock("../pane-focus", () => ({
  settleDomFocus: vi.fn(),
  settleIdleDomFocus: vi.fn(),
  takeOwedSettle: vi.fn(() => false),
}));

const SETTINGS: Settings = DEFAULT_SETTINGS;
const EM_DASH = String.fromCharCode(0x2014);

// text is the made-up tmux config of the test, and null stands for a machine
// that has none.
function sourceOf(text: string | null, isFromServer = true): TmuxSource {
  const config = text === null ? stockTmuxConfig() : tmuxConfigOf(text);
  return { config, isFromServer };
}

function renderHelp(
  text: string | null = null,
  settings: Settings = SETTINGS,
  source: TmuxSource = sourceOf(text),
) {
  const keymap = buildKeymap(source.config);
  return renderSlot({ component: Help }, { settings, keymap, source });
}

function openHelp(): void {
  act(() => updateUiState({ helpOpen: true }));
}

function helpDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Tmux keys" });
}

function pressOnFocused(key: string): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
}

function headings(): (string | null)[] {
  return screen
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent);
}

function section(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { level: 3, name: title });
  const element = heading.closest("section");
  if (element === null) throw new Error(`no help section "${title}"`);
  return element;
}

function description(keys: string, container?: HTMLElement): string | null {
  const queries = container === undefined ? screen : within(container);
  return queries.getByText(keys, { selector: "dt" }).nextElementSibling
    ?.textContent ?? null;
}

let restoreComputedStyle: (() => void) | null = null;

afterEach(() => {
  restoreComputedStyle?.();
  restoreComputedStyle = null;
  cleanup();
  resetStore();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("Help", () => {
  it("stays closed until the store opens it", () => {
    renderHelp();
    expect(screen.queryByRole("dialog")).toBeNull();

    openHelp();

    expect(helpDialog()).toBeTruthy();
  });

  it("lists the keys of stock tmux when there is no tmux config", () => {
    renderHelp();
    openHelp();

    expect(headings()).toEqual([
      "After the prefix",
      "Outside a text field",
      "Copy mode, emacs keys",
      "On a thread in the sidebar",
      "In the thread chooser",
    ]);
    const afterPrefix = section("After the prefix");
    expect(description("Ctrl-b %", afterPrefix)).toBe(
      "Choose a thread, or the New thread row, for a new pane to the right",
    );
    expect(description('Ctrl-b "', afterPrefix)).toBe(
      "Choose a thread, or the New thread row, for a new pane below",
    );
    expect(description("Ctrl-b o", afterPrefix)).toBe(
      "Focus the next pane in the order of the splits, and the first one after the last",
    );
    expect(description("Ctrl-b 0-9", afterPrefix)).toBe(
      "Jump to thread 1-10, in sidebar order",
    );
    expect(description("Ctrl-b Ctrl-b", afterPrefix)).toBe(
      "Send Ctrl-b itself to the terminal or text field",
    );
    expect(description("Ctrl-b Alt-Left", afterPrefix)).toBe(
      "Resize this pane by moving its divider to the left by 5 cells (repeats)",
    );
    expect(description("Ctrl-b Ctrl-Left", afterPrefix)).toBe(
      "Resize this pane by moving its divider to the left by 1 cell (repeats)",
    );
    expect(description("(repeats)", afterPrefix)).toBe(
      "After such a key, every key with this mark works without the prefix for 0.5 seconds",
    );
    expect(description("Ctrl-b any other key", afterPrefix)).toBe("Cancel the prefix");
    const copyMode = section("Copy mode, emacs keys");
    expect(description("Ctrl-Space", copyMode)).toBe("Start selecting from the cursor");
    expect(description("Ctrl-w / Alt-w", copyMode)).toBe(
      "Copy the selection and leave copy mode",
    );
    expect(description("Ctrl-c / Escape / q", copyMode)).toBe(
      "Leave copy mode without copying",
    );
  });

  it("says that no tmux config was found and that the keys are those of stock tmux", () => {
    renderHelp();
    openHelp();

    const dialog = helpDialog();
    expect(within(dialog).getByText(/^Prefix: /).textContent).toBe(
      "Prefix: Ctrl-b, tmux's default (no tmux config sets a prefix)",
    );
    expect(
      within(dialog).getByText(
        "No tmux config was found, so these are the keys of stock tmux.",
      ),
    ).toBeTruthy();
  });

  it("lists the keys of the tmux config on top of stock tmux, and says which file they come from", () => {
    renderHelp(VI_STYLE_CONFIG);
    openHelp();

    const dialog = helpDialog();
    expect(within(dialog).getByText(/^Prefix: /).textContent).toBe(
      "Prefix: Ctrl-a, from ~/.tmux.conf",
    );
    expect(
      within(dialog).getByText(
        "The keys of stock tmux with ~/.tmux.conf applied to them.",
      ),
    ).toBeTruthy();
    expect(headings()).toEqual([
      "After the prefix",
      "Outside a text field",
      "Copy mode, vi keys",
      "On a thread in the sidebar",
      "In the thread chooser",
    ]);
    const afterPrefix = section("After the prefix");
    expect(description("Ctrl-a h", afterPrefix)).toBe(
      "Focus the pane to the left, or the sidebar from the leftmost pane",
    );
    expect(description("Ctrl-a % / v", afterPrefix)).toBe(
      "Choose a thread, or the New thread row, for a new pane to the right",
    );
    expect(description('Ctrl-a " / s', afterPrefix)).toBe(
      "Choose a thread, or the New thread row, for a new pane below",
    );
    expect(description("Ctrl-a 1-9", afterPrefix)).toBe(
      "Jump to thread 1-9, in sidebar order",
    );
    expect(description("Ctrl-a Ctrl-a", afterPrefix)).toBe(
      "Send Ctrl-a itself to the terminal or text field",
    );
    expect(description("Ctrl-a Alt-Left / Alt-h", afterPrefix)).toBe(
      "Resize this pane by moving its divider to the left by 5 cells (repeats)",
    );
    expect(description("Ctrl-a r", afterPrefix)).toBe(
      'Read the tmux config again, then show the notice "Config reloaded"',
    );
    const copyMode = section("Copy mode, vi keys");
    expect(description("Space / v", copyMode)).toBe("Start selecting from the cursor");
    expect(description("Ctrl-j / Enter / y", copyMode)).toBe(
      "Copy the selection and leave copy mode",
    );
    expect(description("Ctrl-c / q / Escape", copyMode)).toBe(
      "Leave copy mode without copying",
    );
    expect(description("Ctrl-d", copyMode)).toBe("Move down half a page");
    expect(within(afterPrefix).queryByText(/^Ctrl-b /, { selector: "dt" })).toBeNull();
  });

  it.each(["Ctrl-b h", "Ctrl-b j", "Ctrl-b v", "Ctrl-b Alt-h", "Ctrl-b d", "Ctrl-b :", "Ctrl-b Escape"])(
    "has no row for %s without a tmux config, where the key does nothing",
    (keys) => {
      renderHelp();
      openHelp();

      expect(screen.queryAllByText(keys, { selector: "dt" })).toEqual([]);
    },
  );

  it("has no row for a key that the tmux config binds to a command bb has no equivalent for", () => {
    renderHelp("bind x kill-server\nbind e new-window");
    openHelp();

    expect(screen.queryAllByText("Ctrl-b x", { selector: "dt" })).toEqual([]);
    expect(description("Ctrl-b c / e")).toBe("Start a new thread in this pane");
  });

  it("lists the keys of the root table in a section of their own", () => {
    renderHelp("bind -n M-Left select-pane -L");
    openHelp();

    expect(headings()[1]).toBe("Without the prefix");
    expect(description("Alt-Left", section("Without the prefix"))).toBe(
      "Focus the pane to the left, or the sidebar from the leftmost pane",
    );
  });

  it("lists i, the one key outside a text field, whatever the tmux config binds", () => {
    renderHelp(VI_STYLE_CONFIG);
    openHelp();

    const outsideTextField = section("Outside a text field");
    expect(description("i", outsideTextField)).toBe(
      "Put the text cursor in the message box of the focused pane",
    );
    expect(within(outsideTextField).getAllByRole("term")).toHaveLength(1);
    expect(screen.queryByText("Ctrl-a i", { selector: "dt" })).toBeNull();
  });

  it("lists tmux's list keys for the sidebar and the chooser, with the split keys of the prefix table", () => {
    renderHelp();
    openHelp();

    const sidebar = section("On a thread in the sidebar");
    expect(description("Down / j / Ctrl-n", sidebar)).toBe("Move to the next thread");
    expect(description("Up / k / Ctrl-p", sidebar)).toBe("Move to the previous thread");
    expect(description("PageUp", sidebar)).toBe("Move up one page");
    expect(description("PageDown / Ctrl-f", sidebar)).toBe("Move down one page");
    expect(description("g / Home", sidebar)).toBe("Move to the first thread");
    expect(description("G / End", sidebar)).toBe("Move to the last thread");
    expect(description("Enter", sidebar)).toBe("Open the thread in the focused pane");
    expect(description("%", sidebar)).toBe("Open the thread in a new pane to the right");
    expect(description('"', sidebar)).toBe("Open the thread in a new pane below");
    expect(description("q / Escape / Ctrl-g", sidebar)).toBe("Return to the pane");
    expect(within(sidebar).getAllByRole("term")).toHaveLength(10);
    const chooser = section("In the thread chooser");
    expect(description("PageUp / Ctrl-b", chooser)).toBe("Move up one page");
    expect(description("c", chooser)).toBe(
      "Start a new thread in the new pane that the chooser was opened for",
    );
    expect(description("/", chooser)).toBe("Filter the threads by title or project");
  });

  it("calls the Alt key Option on a Mac, and Alt on Windows and Linux", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    renderHelp();
    openHelp();

    expect(description("Ctrl-b Option-Left")).toBe(
      "Resize this pane by moving its divider to the left by 5 cells (repeats)",
    );
    expect(within(helpDialog()).queryByText(/Alt-/)).toBeNull();

    cleanup();
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    renderHelp();
    openHelp();

    expect(within(helpDialog()).queryByText(/Option-/)).toBeNull();
    expect(description("Ctrl-b Alt-Left")).not.toBeNull();
  });

  it("describes the keymap of the tmux config with the current settings", () => {
    renderHelp(`${VI_STYLE_CONFIG}\nset -g prefix C-x`, {
      ...SETTINGS,
      threadOrder: "recent",
    });
    openHelp();

    expect(within(helpDialog()).getByText(/^Prefix: /).textContent).toBe(
      "Prefix: Ctrl-x, from ~/.tmux.conf",
    );
    expect(description("Ctrl-x [")).toBe(
      "Enter copy mode to scroll, select and copy conversation text",
    );
    expect(description("Ctrl-x 1-9")).toBe("Jump to thread 1-9, most recent first");
    expect(screen.queryByText(/^Ctrl-a /, { selector: "dt" })).toBeNull();
    expect(screen.queryByText("Ctrl-x Ctrl-x", { selector: "dt" })).toBeNull();
  });

  describe("the lines about where the keys come from", () => {
    function lines(): (string | null)[] {
      const dialog = helpDialog();
      const prefix = within(dialog).getByText(/^Prefix: /);
      return Array.from(prefix.parentElement?.children ?? [], (line) => line.textContent);
    }

    it("names the prefix of the tmux config that bb cannot use", () => {
      renderHelp("set -g prefix `");
      openHelp();

      expect(lines()).toEqual([
        "Prefix: Ctrl-b, tmux's default (the prefix ` in ~/.tmux.conf cannot be used in bb)",
        "The keys of stock tmux with ~/.tmux.conf applied to them.",
      ]);
    });

    it("names the second prefix", () => {
      renderHelp("set -g prefix2 M-s");
      openHelp();

      expect(lines()[0]).toBe(
        "Prefix: Ctrl-b, tmux's default (no tmux config sets a prefix). Second prefix: Alt-s",
      );
    });

    it("names the Config text setting as where the prefix comes from when its lines set it", () => {
      const config = tmuxConfigFrom(
        {
          ...fileSources([{ path: TEST_CONFIG_PATH, text: VI_STYLE_CONFIG }]),
          pastedText: {
            state: "applied",
            lines: {
              path: "the Config text setting",
              text: "set -g prefix C-Space\nbind C-Space send-prefix",
            },
          },
        },
        { visual: undefined, editor: undefined },
      );
      renderHelp(null, SETTINGS, { config, isFromServer: true });
      openHelp();

      expect(lines()).toEqual([
        "Prefix: Ctrl-Space, from the Config text setting",
        "The keys of stock tmux with ~/.tmux.conf and the Config text setting applied to them.",
      ]);
      expect(description("Ctrl-Space Ctrl-Space")).toBe(
        "Send Ctrl-Space itself to the terminal or text field",
      );
    });

    it("says so when the server gave no answer and stock tmux stands in", () => {
      renderHelp(null, SETTINGS, sourceOf(null, false));
      openHelp();

      expect(lines()).toEqual([
        "Prefix: Ctrl-b, tmux's default (the tmux config could not be read)",
        "The tmux config could not be read, so these are the keys of stock tmux.",
      ]);
      expect(description("Ctrl-b %")).toBe(
        "Choose a thread, or the New thread row, for a new pane to the right",
      );
    });

    it("says so when a tmux config is there but could not be read", () => {
      const source = sourceOf(null);
      renderHelp(null, SETTINGS, {
        ...source,
        config: { ...source.config, unreadable: true },
      });
      openHelp();

      expect(lines()).toEqual([
        "Prefix: Ctrl-b, tmux's default (the tmux config could not be read)",
        "A tmux config is there but could not be read, so these are the keys of stock tmux.",
      ]);
    });

    it.each([
      ["MacIntel", "Prefix: Option-a, from ~/.tmux.conf"],
      ["Win32", "Prefix: Alt-a, from ~/.tmux.conf"],
    ])("names the Alt key for the platform %s", (platform, line) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      renderHelp("set -g prefix M-a");
      openHelp();

      expect(lines()[0]).toBe(line);
    });

    it("keeps the lines out of the scrolling key list", () => {
      renderHelp(VI_STYLE_CONFIG);
      openHelp();

      const keyList = within(helpDialog()).getByRole("region", {
        name: "Key list",
      });
      expect(within(keyList).queryByText(/^Prefix: /)).toBeNull();
      expect(within(keyList).queryByText(/stock tmux/)).toBeNull();
    });

    it("shows no key and no line while the keys are not known, and says that the config is being read", () => {
      renderSlot(
        { component: Help },
        { settings: SETTINGS, keymap: null, source: null },
      );
      openHelp();

      const dialog = helpDialog();
      expect(within(dialog).queryByText(/^Prefix: /)).toBeNull();
      expect(within(dialog).queryAllByRole("heading", { level: 3 })).toEqual([]);
      expect(within(dialog).getByText("The tmux config is still being read.")).toBeTruthy();

      pressOnFocused("q");

      expect(getUiState().helpOpen).toBe(false);
    });
  });

  it("says in its first line how it closes and scrolls, in the list keys of tmux", () => {
    renderHelp();
    openHelp();

    expect(
      within(helpDialog()).getByText(
        "q or Escape closes. j and k scroll, as do the other list keys of tmux.",
      ),
    ).toBeTruthy();
  });

  it("never uses an em dash", () => {
    renderHelp(VI_STYLE_CONFIG);
    openHelp();

    expect(helpDialog().textContent).not.toContain(EM_DASH);
  });

  it.each(["q", "Escape"])("closes on %s", (key) => {
    renderHelp();
    openHelp();

    pressOnFocused(key);

    expect(getUiState().helpOpen).toBe(false);
  });

  it("closes on Ctrl-g, as a list of tmux does", () => {
    renderHelp();
    openHelp();

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "g",
      ctrlKey: true,
    });

    expect(getUiState().helpOpen).toBe(false);
  });

  it.each<[string, KeyboardEventInit, KeyboardEventInit]>([
    ["j and k", { key: "j" }, { key: "k" }],
    ["the arrows", { key: "ArrowDown" }, { key: "ArrowUp" }],
    ["Ctrl-n and Ctrl-p", { key: "n", ctrlKey: true }, { key: "p", ctrlKey: true }],
  ])("scrolls with %s by the configured scroll step", (_keys, down, up) => {
    renderHelp(null, { ...SETTINGS, scrollStepPx: 120 });
    openHelp();
    const body = document.activeElement as HTMLElement;
    expect(screen.getByRole("dialog").contains(body)).toBe(true);

    fireEvent.keyDown(body, down);
    expect(body.scrollTop).toBe(120);
    fireEvent.keyDown(body, up);
    expect(body.scrollTop).toBe(0);
  });

  it.each<[string, KeyboardEventInit, KeyboardEventInit]>([
    ["PageDown and PageUp", { key: "PageDown" }, { key: "PageUp" }],
    ["Ctrl-f and Ctrl-b", { key: "f", ctrlKey: true }, { key: "b", ctrlKey: true }],
  ])("scrolls a page of the key list with %s", (_keys, down, up) => {
    renderHelp();
    openHelp();
    const body = document.activeElement as HTMLElement;
    Object.defineProperty(body, "clientHeight", { value: 300 });

    fireEvent.keyDown(body, down);
    fireEvent.keyDown(body, down);
    expect(body.scrollTop).toBe(600);
    fireEvent.keyDown(body, up);
    expect(body.scrollTop).toBe(300);
  });

  it.each<[string, KeyboardEventInit, KeyboardEventInit]>([
    ["G and g", { key: "G", shiftKey: true }, { key: "g" }],
    ["End and Home", { key: "End" }, { key: "Home" }],
  ])("goes to the end and the start of the key list with %s", (_keys, end, start) => {
    renderHelp();
    openHelp();
    const body = document.activeElement as HTMLElement;
    Object.defineProperty(body, "scrollHeight", { value: 2400 });

    fireEvent.keyDown(body, end);
    expect(body.scrollTop).toBe(2400);
    fireEvent.keyDown(body, start);
    expect(body.scrollTop).toBe(0);
  });

  // A terminal sends Ctrl-[ as Escape, Ctrl-m as Enter and Ctrl-i as Tab.
  describe("the keys that a terminal sends as Escape, Enter and Tab", () => {
    it("closes on Ctrl-[, as on Escape", () => {
      renderHelp();
      openHelp();

      const wasLeftAlone = fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "[",
        ctrlKey: true,
      });

      expect(wasLeftAlone).toBe(false);
      expect(getUiState().helpOpen).toBe(false);
    });

    it("leaves Ctrl-m alone, as it leaves Enter, which chooses nothing in a key list", () => {
      renderHelp();
      openHelp();
      const body = document.activeElement as HTMLElement;

      expect(fireEvent.keyDown(body, { key: "m", ctrlKey: true })).toBe(true);

      expect(getUiState().helpOpen).toBe(true);
      expect(body.scrollTop).toBe(0);
      expect(document.activeElement).toBe(body);
    });

    it("moves the cursor from the key list to the close button and back on Ctrl-i, as Tab does", () => {
      renderHelp();
      openHelp();
      const body = document.activeElement as HTMLElement;
      const close = within(helpDialog()).getByRole("button", { name: "Close" });

      expect(fireEvent.keyDown(body, { key: "i", ctrlKey: true })).toBe(false);
      expect(document.activeElement).toBe(close);

      expect(fireEvent.keyDown(close, { key: "i", ctrlKey: true })).toBe(false);
      expect(document.activeElement).toBe(body);
      expect(getUiState().helpOpen).toBe(true);
    });

    it("presses the close button on Ctrl-m while the cursor is on it, where Enter itself is left to the browser", () => {
      renderHelp();
      openHelp();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "i", ctrlKey: true });
      const close = within(helpDialog()).getByRole("button", { name: "Close" });
      expect(document.activeElement).toBe(close);

      expect(fireEvent.keyDown(close, { key: "Enter" })).toBe(true);
      expect(fireEvent.keyDown(close, { key: "m", ctrlKey: true })).toBe(false);

      expect(getUiState().helpOpen).toBe(false);
    });

    it("still scrolls with the list keys while the cursor is on the close button", () => {
      renderHelp(null, { ...SETTINGS, scrollStepPx: 120 });
      openHelp();
      const body = document.activeElement as HTMLElement;
      fireEvent.keyDown(body, { key: "i", ctrlKey: true });
      const close = within(helpDialog()).getByRole("button", { name: "Close" });
      expect(document.activeElement).toBe(close);

      fireEvent.keyDown(close, { key: "j" });

      expect(body.scrollTop).toBe(120);
    });

    it.each<[string, KeyboardEventInit]>([
      ["Ctrl-Alt-[", { key: "[", ctrlKey: true, altKey: true }],
      ["Cmd-[", { key: "[", metaKey: true }],
      ["Ctrl-Shift-i", { key: "I", ctrlKey: true, shiftKey: true }],
      ["Tab itself", { key: "Tab" }],
    ])("leaves %s alone", (_name, init) => {
      renderHelp();
      openHelp();
      const body = document.activeElement as HTMLElement;

      expect(fireEvent.keyDown(body, init)).toBe(true);

      expect(getUiState().helpOpen).toBe(true);
      expect(document.activeElement).toBe(body);
    });

    it("says in one sentence where the three keys work, also while the keys are not known", () => {
      const sentence =
        "As in a terminal, Ctrl-[, Ctrl-m and Ctrl-i work as Escape, Enter and Tab in copy mode, in the thread chooser and here, and Ctrl-[ and Ctrl-m as Escape and Enter on a thread in the sidebar, unless the key itself is bound there.";
      renderHelp();
      openHelp();
      expect(within(helpDialog()).getByText(sentence)).toBeTruthy();
      cleanup();

      renderSlot({ component: Help }, { settings: SETTINGS, keymap: null, source: null });
      openHelp();
      expect(within(helpDialog()).getByText(sentence)).toBeTruthy();
    });

    it("keeps that sentence out of the scrolling key list and out of the lines about the prefix", () => {
      renderHelp();
      openHelp();

      const dialog = helpDialog();
      const keyList = within(dialog).getByRole("region", { name: "Key list" });
      expect(within(keyList).queryByText(/As in a terminal/)).toBeNull();
      const prefix = within(dialog).getByText(/^Prefix: /);
      expect(prefix.parentElement?.textContent).not.toContain("As in a terminal");
    });
  });

  it("leaves Enter and every other key alone, which choose nothing in a key list", () => {
    renderHelp();
    openHelp();
    const body = document.activeElement as HTMLElement;

    for (const key of ["Enter", "v", "s", "l", "%"]) {
      expect(fireEvent.keyDown(body, { key })).toBe(true);
    }
    expect(getUiState().helpOpen).toBe(true);
    expect(body.scrollTop).toBe(0);
  });

  it("returns focus to where it was when it closes", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    renderHelp();
    openHelp();
    expect(document.activeElement).not.toBe(outside);

    pressOnFocused("q");

    await waitFor(() => expect(document.activeElement).toBe(outside));
    expect(settleDomFocus).not.toHaveBeenCalled();
  });

  it.each(["q", "Escape"])(
    "gives the cursor back to the message box it was in when it closes on %s",
    async (key) => {
      document.body.innerHTML =
        '<div data-app-composer=""><div contenteditable="true" tabindex="0"></div></div>';
      const editor = document.querySelector<HTMLElement>("[contenteditable]");
      editor?.focus();
      renderHelp();
      openHelp();

      pressOnFocused(key);

      await waitFor(() => expect(document.activeElement).toBe(editor));
      expect(settleDomFocus).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["q", "the pane itself"],
    ["Escape", "the pane itself"],
    ["q", "nothing"],
    ["Escape", "nothing"],
  ])(
    "puts the cursor into the message box when it closes on %s and the cursor was on %s",
    async (key, place) => {
      const pane = document.createElement("div");
      pane.tabIndex = -1;
      document.body.append(pane);
      if (place === "the pane itself") pane.focus();
      renderHelp();
      openHelp();

      pressOnFocused(key);

      await waitFor(() => expect(settleDomFocus).toHaveBeenCalledTimes(1));
      expect(getUiState().helpOpen).toBe(false);
    },
  );

  it("does not touch the cursor before it was ever opened", () => {
    renderHelp();

    expect(settleDomFocus).not.toHaveBeenCalled();
  });

  it("takes focus again when it is reopened while it still fades out", () => {
    restoreComputedStyle = keepClosingDialogsMounted();
    const outside = document.createElement("textarea");
    document.body.append(outside);
    outside.focus();
    renderHelp();
    openHelp();
    pressOnFocused("q");
    expect(getUiState().helpOpen).toBe(false);
    expect(screen.queryByRole("dialog", { hidden: true })).not.toBeNull();
    expect(document.activeElement).toBe(outside);

    openHelp();

    expect(helpDialog().contains(document.activeElement)).toBe(true);
    pressOnFocused("q");
    expect(getUiState().helpOpen).toBe(false);
    expect(document.activeElement).toBe(outside);
  });
});

describe("Help on a compact viewport, where the dialog is a drawer", () => {
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("closes on q while the keys are not known, when it has no key list to hold the cursor", async () => {
    renderSlot(
      { component: Help },
      { settings: SETTINGS, keymap: null, source: null },
    );
    openHelp();
    const pending = await screen.findByText("The tmux config is still being read.");
    await waitFor(() => expect(document.activeElement).toBe(pending.parentElement));

    pressOnFocused("q");

    expect(getUiState().helpOpen).toBe(false);
  });

  it("still takes its keys after a click on its title", async () => {
    renderHelp();
    openHelp();
    const keyList = await screen.findByRole("region", { name: "Key list" });
    await waitFor(() => expect(document.activeElement).toBe(keyList));

    screen.getByText("Tmux keys").closest<HTMLElement>("[tabindex]")?.focus();
    expect(document.activeElement).not.toBe(keyList);
    pressOnFocused("q");

    expect(getUiState().helpOpen).toBe(false);
  });

  // What a click on the strip that holds the handle of the drawer does: the
  // drawer itself, which is outside the dialog, takes the cursor.
  function clickDrawerHandle(): HTMLElement {
    const drawer = document
      .querySelector("[data-persistent-drawer-handle]")
      ?.closest<HTMLElement>("[tabindex]");
    if (drawer === null || drawer === undefined) {
      throw new Error("the drawer has no handle");
    }
    drawer.focus();
    return drawer;
  }

  it("still takes its keys after a click on the handle of the drawer", async () => {
    renderHelp();
    openHelp();
    const keyList = await screen.findByRole("region", { name: "Key list" });
    await waitFor(() => expect(document.activeElement).toBe(keyList));
    Object.defineProperty(keyList, "scrollHeight", { value: 900 });

    const drawer = clickDrawerHandle();

    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.contains(keyList)).toBe(true);
    expect(document.activeElement).toBe(keyList);
    pressOnFocused("G");
    expect(keyList.scrollTop).toBe(900);
    pressOnFocused("q");
    expect(getUiState().helpOpen).toBe(false);
  });

  it("still closes on q after such a click while the keys are not known", async () => {
    renderSlot(
      { component: Help },
      { settings: SETTINGS, keymap: null, source: null },
    );
    openHelp();
    const pending = await screen.findByText("The tmux config is still being read.");
    await waitFor(() => expect(document.activeElement).toBe(pending.parentElement));

    clickDrawerHandle();

    expect(document.activeElement).toBe(pending.parentElement);
    pressOnFocused("q");
    expect(getUiState().helpOpen).toBe(false);
  });

  it("puts a cursor that the drawer leaves on the pane or on nothing into the message box when it closes", async () => {
    renderHelp();
    openHelp();
    const keyList = await screen.findByRole("region", { name: "Key list" });
    await waitFor(() => expect(document.activeElement).toBe(keyList));

    pressOnFocused("q");

    expect(getUiState().helpOpen).toBe(false);
    expect(settleIdleDomFocus).toHaveBeenCalledTimes(1);
  });
});

