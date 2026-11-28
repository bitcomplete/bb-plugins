// @vitest-environment jsdom
import {
  renderSlot,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUiState, resetStore, updateUiState } from "../bridge";
import { SELECTORS } from "../constants";
import { buildKeymap } from "../keymap";
import { stockTmuxConfig } from "../tmux-keymap";
import { VI_STYLE_CONFIG, tmuxConfigOf } from "../tmux-test-support";
import type { Keymap, Placement } from "../types";
import { Chooser } from "./Chooser";
import {
  keepClosingDialogsMounted,
  makeLayout,
  makeProject,
  makeThread,
} from "./test-support";

const mocks = vi.hoisted(() => ({
  openThread: vi.fn(),
  openNewThreadInSplit: vi.fn(),
  settleDomFocus: vi.fn(),
  settleIdleDomFocus: vi.fn(),
  takeOwedSettle: vi.fn(() => false),
}));

// The test harness hands the chooser one fixed thread list. This store lets a
// test swap the list while the chooser is open, as bb does when a thread
// arrives, is archived or is renamed.
const liveThreads = vi.hoisted(() => {
  let threads: readonly unknown[] | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => threads,
    set(next: readonly unknown[] | null) {
      threads = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const original = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  const { useSyncExternalStore } = await import("react");
  return {
    ...original,
    experimental_useSidebarThreads: () => {
      const fromHarness = original.experimental_useSidebarThreads();
      const threads = useSyncExternalStore(liveThreads.subscribe, liveThreads.get);
      if (threads === null) return fromHarness;
      return { ...fromHarness, threads: threads as PluginSidebarThread[] };
    },
  };
});

vi.mock("../open-thread", () => ({ openThread: mocks.openThread }));
vi.mock("../new-thread", () => ({
  openNewThreadInSplit: mocks.openNewThreadInSplit,
}));
vi.mock("../pane-focus", () => ({
  settleDomFocus: mocks.settleDomFocus,
  settleIdleDomFocus: mocks.settleIdleDomFocus,
  takeOwedSettle: mocks.takeOwedSettle,
}));

const THREADS = [
  makeThread("thr-1", { displayTitle: "Alpha" }),
  makeThread("thr-2", { displayTitle: "Beta" }),
  makeThread("thr-3", { displayTitle: "Gamma" }),
];
const PROJECTS = [makeProject("proj-1", "Website")];

const STOCK = buildKeymap(stockTmuxConfig());
const VI_STYLE = buildKeymap(tmuxConfigOf(VI_STYLE_CONFIG));

function keymapOf(text: string): Keymap {
  return buildKeymap(tmuxConfigOf(text));
}

// The keys of the chooser are those of a made-up tmux config in the vi style,
// which adds v and s to the split keys of stock tmux, unless a test hands
// over another keymap. null stands for keys that are not known yet.
function renderChooser(
  options: RenderSlotOptions = {},
  keymap: Keymap | null = VI_STYLE,
) {
  return renderSlot(
    { component: Chooser },
    { keymap },
    { sidebarThreads: { threads: THREADS, projects: PROJECTS }, ...options },
  );
}

function openChooser(placement: Placement = "replace"): void {
  act(() => updateUiState({ chooser: { open: true, placement } }));
}

function list(): HTMLElement {
  return screen.getByRole("listbox", { name: "Threads" });
}

function filter(): HTMLInputElement {
  return screen.getByRole("combobox", { name: "Filter threads by title or project" });
}

function highlightedTitle(): string | null {
  return screen.getByRole("option", { selected: true }).firstElementChild
    ?.textContent ?? null;
}

function press(
  target: Element,
  key: string,
  init: KeyboardEventInit = {},
): void {
  fireEvent.keyDown(target, { key, ...init });
}

function rowTitles(): (string | null | undefined)[] {
  return screen
    .getAllByRole("option")
    .map((row) => row.firstElementChild?.textContent);
}

function bbChangesThreadsTo(threads: readonly PluginSidebarThread[]): void {
  act(() => liveThreads.set(threads));
}

function addVisibleBrowserTab(left: number): void {
  const browserTab = document.createElement("div");
  browserTab.setAttribute(SELECTORS.browser.slice(1, -1), "");
  const content = document.createElement("div");
  content.getBoundingClientRect = () =>
    ({ left, top: 80, width: 500, height: 700 }) as DOMRect;
  browserTab.append(document.createElement("div"), content);
  document.body.append(browserTab);
}

beforeEach(() => {
  mocks.openThread.mockReturnValue("opened");
  mocks.openNewThreadInSplit.mockReturnValue("started");
});

let restoreComputedStyle: (() => void) | null = null;

afterEach(() => {
  restoreComputedStyle?.();
  restoreComputedStyle = null;
  vi.useRealTimers();
  cleanup();
  liveThreads.set(null);
  resetStore();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("Chooser", () => {
  it("stays closed until the store opens it", () => {
    renderChooser();
    expect(screen.queryByRole("dialog")).toBeNull();

    openChooser();

    expect(screen.getByRole("dialog", { name: "Thread chooser" })).toBeTruthy();
    expect(rowTitles()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(highlightedTitle()).toBe("Alpha");
  });

  it("builds its rows from the threads, projects and split layout", () => {
    renderChooser({
      sidebarSplitLayout: makeLayout([
        { paneId: "pane-1", threadId: "thr-2", isFocused: true },
        { paneId: "pane-2", threadId: "thr-3", isFocused: false },
      ]),
      context: { threadId: "thr-2" },
    });
    openChooser();

    const [alpha, beta, gamma] = screen.getAllByRole("option");
    expect(alpha.textContent).toBe("AlphaWebsite");
    expect(beta.textContent).toBe("BetaWebsitefocused pane");
    expect(gamma.textContent).toBe("GammaWebsitein a pane");
  });

  it("marks the context thread as the focused pane when there is no split", () => {
    renderChooser({ context: { threadId: "thr-3" } });
    openChooser();

    const [alpha, , gamma] = screen.getAllByRole("option");
    expect(alpha.textContent).toBe("AlphaWebsite");
    expect(gamma.textContent).toBe("GammaWebsitefocused pane");
  });

  it.each([
    ["replace", "Enter opens the thread in this pane"],
    ["right", "Enter opens the thread in a new pane to the right"],
    ["down", "Enter opens the thread in a new pane below"],
  ] as const)("says what Enter does for placement %s", (placement, heading) => {
    renderChooser();
    openChooser(placement);
    press(list(), "G", { shiftKey: true });
    expect(screen.getByText(heading)).toBeTruthy();
  });

  it("puts focus on the list when it opens", () => {
    renderChooser();
    openChooser();
    expect(document.activeElement).toBe(list());
  });

  it("moves with j and k", () => {
    renderChooser();
    openChooser();

    press(list(), "j");
    expect(highlightedTitle()).toBe("Beta");
    press(list(), "j");
    expect(highlightedTitle()).toBe("Gamma");
    press(list(), "k");
    expect(highlightedTitle()).toBe("Beta");
    press(list(), "k");
    expect(highlightedTitle()).toBe("Alpha");
  });

  it.each<[string, KeyboardEventInit, KeyboardEventInit]>([
    ["j and k", { key: "j" }, { key: "k" }],
    ["the arrow keys", { key: "ArrowDown" }, { key: "ArrowUp" }],
    ["Ctrl-n and Ctrl-p", { key: "n", ctrlKey: true }, { key: "p", ctrlKey: true }],
  ])(
    "goes around with %s, from the last row to the first and back, as tmux's lists do",
    (_keys, next, previous) => {
      renderChooser();
      openChooser();

      fireEvent.keyDown(list(), previous);
      expect(highlightedTitle()).toBe("Gamma");
      fireEvent.keyDown(list(), next);
      expect(highlightedTitle()).toBe("Alpha");
    },
  );

  it("goes around from the filter field as well", () => {
    renderChooser();
    openChooser();
    press(list(), "/");

    press(filter(), "ArrowUp");
    expect(highlightedTitle()).toBe("Gamma");
    press(filter(), "n", { ctrlKey: true });
    expect(highlightedTitle()).toBe("Alpha");
  });

  it("moves with the arrow keys and Ctrl-n / Ctrl-p", () => {
    renderChooser();
    openChooser();

    press(list(), "ArrowDown");
    expect(highlightedTitle()).toBe("Beta");
    press(list(), "n", { ctrlKey: true });
    expect(highlightedTitle()).toBe("Gamma");
    press(list(), "ArrowUp");
    expect(highlightedTitle()).toBe("Beta");
    press(list(), "p", { ctrlKey: true });
    expect(highlightedTitle()).toBe("Alpha");
  });

  it("jumps to the last row with G and to the first with a single g", () => {
    renderChooser();
    openChooser();

    press(list(), "G", { shiftKey: true });
    expect(highlightedTitle()).toBe("Gamma");
    press(list(), "g");
    expect(highlightedTitle()).toBe("Alpha");
    press(list(), "g");
    expect(highlightedTitle()).toBe("Alpha");
  });

  it("jumps to the last row with End and to the first with Home", () => {
    renderChooser();
    openChooser();

    press(list(), "End");
    expect(highlightedTitle()).toBe("Gamma");
    press(list(), "End");
    expect(highlightedTitle()).toBe("Gamma");
    press(list(), "Home");
    expect(highlightedTitle()).toBe("Alpha");
  });

  it("names g and G for the first and the last row in its hint line", () => {
    renderChooser();
    openChooser();

    const hint = list().nextElementSibling?.textContent ?? "";
    expect(hint).toContain("g/G first/last");
  });

  it("opens the highlighted thread with the chooser's placement on Enter, after closing", () => {
    const stateAtCall: { storeOpen: boolean; modalInPage: boolean }[] = [];
    mocks.openThread.mockImplementation(() => {
      stateAtCall.push({
        storeOpen: getUiState().chooser.open,
        modalInPage: document.querySelector(SELECTORS.openModal) !== null,
      });
      return "opened";
    });
    renderChooser();
    openChooser("right");
    expect(document.querySelector(SELECTORS.openModal)).not.toBeNull();

    press(list(), "j");
    press(list(), "j");
    press(list(), "Enter");

    expect(mocks.openThread).toHaveBeenCalledTimes(1);
    expect(mocks.openThread).toHaveBeenCalledWith("thr-2", "right");
    expect(stateAtCall).toEqual([{ storeOpen: false, modalInPage: false }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is closed in the page before a clicked row opens its thread", () => {
    let modalInPage: boolean | null = null;
    mocks.openThread.mockImplementation(() => {
      modalInPage = document.querySelector(SELECTORS.openModal) !== null;
      return "opened";
    });
    renderChooser();
    openChooser();

    fireEvent.click(screen.getByText("Beta"));

    expect(modalInPage).toBe(false);
  });

  it("opens to the right with v and below with s, whatever the chooser's placement", () => {
    renderChooser();
    openChooser("replace");
    press(list(), "v");
    expect(mocks.openThread).toHaveBeenLastCalledWith("thr-1", "right");
    expect(getUiState().chooser.open).toBe(false);

    openChooser("replace");
    press(list(), "j");
    press(list(), "s");
    expect(mocks.openThread).toHaveBeenLastCalledWith("thr-2", "down");
    expect(getUiState().chooser.open).toBe(false);
  });

  it("takes a split key that the keyboard types with AltGr, which the browser can report as Ctrl plus Alt", () => {
    renderChooser({}, keymapOf("bind | split-window -h"));
    openChooser("replace");

    press(list(), "j");
    press(list(), "|", { code: "IntlBackslash", ctrlKey: true, altKey: true });

    expect(mocks.openThread).toHaveBeenCalledExactlyOnceWith("thr-2", "right");
    expect(getUiState().chooser.open).toBe(false);
  });

  it("takes a split key that a Mac keyboard types with Option, as the keys of the window do", () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    renderChooser({}, keymapOf("bind | split-window -h"));
    openChooser("replace");

    press(list(), "|", { code: "Digit7", altKey: true });
    platform.mockRestore();

    expect(mocks.openThread).toHaveBeenCalledExactlyOnceWith("thr-1", "right");
  });

  it("leaves a chord with Option alone when neither the chord nor the character it types is a key of the list", () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    renderChooser({}, keymapOf("bind | split-window -h"));
    openChooser("replace");

    press(list(), "\u00a7", { code: "Digit6", altKey: true });
    press(list(), "j", { code: "KeyJ", altKey: true });
    platform.mockRestore();

    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(highlightedTitle()).toBe(screen.getAllByRole("option")[0].firstElementChild?.textContent);
    expect(getUiState().chooser.open).toBe(true);
  });

  it("opens a clicked row with the chooser's placement", () => {
    renderChooser();
    openChooser("down");

    fireEvent.click(screen.getByText("Gamma"));

    expect(mocks.openThread).toHaveBeenCalledWith("thr-3", "down");
  });

  it("closes on Escape without opening a thread", () => {
    renderChooser();
    openChooser();

    press(list(), "Escape");

    expect(getUiState().chooser.open).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.openThread).not.toHaveBeenCalled();
  });

  it("closes on q without opening a thread", () => {
    renderChooser();
    openChooser();

    press(list(), "q");

    expect(getUiState().chooser.open).toBe(false);
    expect(mocks.openThread).not.toHaveBeenCalled();
  });

  it("moves to the filter field on / and filters by what is typed", () => {
    renderChooser();
    openChooser();

    press(list(), "/");
    expect(document.activeElement).toBe(filter());
    expect(filter().value).toBe("");

    fireEvent.change(filter(), { target: { value: "ma" } });

    expect(rowTitles()).toEqual(["Gamma"]);
    expect(highlightedTitle()).toBe("Gamma");
  });

  it("says in the filter field that it filters by title or project", () => {
    renderChooser();
    openChooser();

    expect(filter().placeholder).toBe("Press / to filter by title or project");
    expect(filter().getAttribute("aria-label")).toBe(
      "Filter threads by title or project",
    );
  });

  it("filters by project name too, with every word required", () => {
    renderChooser({
      sidebarThreads: {
        threads: [
          ...THREADS,
          makeThread("thr-4", { displayTitle: "Delta", projectId: "proj-2" }),
        ],
        projects: [...PROJECTS, makeProject("proj-2", "Docs")],
      },
    });
    openChooser();
    press(list(), "/");

    fireEvent.change(filter(), { target: { value: "DOCS" } });
    expect(rowTitles()).toEqual(["Delta"]);

    fireEvent.change(filter(), { target: { value: "web  et" } });
    expect(rowTitles()).toEqual(["Beta"]);
  });

  it("keeps list keys as text while filtering and moves with the arrows and Ctrl-n / Ctrl-p", () => {
    renderChooser();
    openChooser();
    press(list(), "/");

    press(filter(), "j");
    press(filter(), "v");
    press(filter(), "q");
    expect(highlightedTitle()).toBe("Alpha");
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(getUiState().chooser.open).toBe(true);

    press(filter(), "ArrowDown");
    expect(highlightedTitle()).toBe("Beta");
    press(filter(), "n", { ctrlKey: true });
    expect(highlightedTitle()).toBe("Gamma");
    press(filter(), "ArrowUp");
    press(filter(), "p", { ctrlKey: true });
    expect(highlightedTitle()).toBe("Alpha");
  });

  it("opens the highlighted thread on Enter while filtering", () => {
    renderChooser();
    openChooser("down");
    press(list(), "/");
    fireEvent.change(filter(), { target: { value: "bet" } });

    press(filter(), "Enter");

    expect(mocks.openThread).toHaveBeenCalledWith("thr-2", "down");
    expect(getUiState().chooser.open).toBe(false);
  });

  it("returns to the list on Escape while filtering and keeps the filter text", () => {
    renderChooser();
    openChooser();
    press(list(), "/");
    fireEvent.change(filter(), { target: { value: "a" } });

    press(filter(), "Escape");

    expect(getUiState().chooser.open).toBe(true);
    expect(document.activeElement).toBe(list());
    expect(filter().value).toBe("a");

    press(list(), "Escape");
    expect(getUiState().chooser.open).toBe(false);
  });

  it("starts with an empty filter every time it opens", () => {
    renderChooser();
    openChooser();
    press(list(), "/");
    fireEvent.change(filter(), { target: { value: "bet" } });
    press(filter(), "Escape");
    press(list(), "Escape");

    openChooser();

    expect(filter().value).toBe("");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("shows an empty state when nothing matches", () => {
    renderChooser();
    openChooser();
    press(list(), "/");
    fireEvent.change(filter(), { target: { value: "zzz" } });

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching threads")).toBeTruthy();

    press(filter(), "Enter");
    expect(mocks.openThread).not.toHaveBeenCalled();
  });

  it("shows an empty state when there are no threads", () => {
    renderChooser({ sidebarThreads: { threads: [], projects: [] } });
    openChooser();
    expect(screen.getByText("No threads to show")).toBeTruthy();
  });

  it.each(["replace", "right"] as const)(
    "keeps the empty state out of the list, which holds nothing but rows (%s)",
    (placement) => {
      renderChooser({ sidebarThreads: { threads: [], projects: [] } });
      openChooser(placement);

      const rows = Array.from(list().children, (child) => child.getAttribute("role"));

      expect(rows).toEqual(placement === "replace" ? [] : ["option"]);
      expect(list().contains(screen.getByText("No threads to show"))).toBe(false);
    },
  );

  it.each([
    ["replace", "Enter opens the thread in this pane"],
    ["right", "Enter starts a new thread in a new pane to the right"],
    ["down", "Enter starts a new thread in a new pane below"],
  ] as const)(
    "describes the dialog by where Enter opens the thread, so that a screen reader says it (%s)",
    (placement, text) => {
      renderChooser();
      openChooser(placement);

      const dialog = screen.getByRole("dialog", { name: "Thread chooser" });
      const describedBy = dialog.getAttribute("aria-describedby") ?? "";

      expect(document.getElementById(describedBy)?.textContent).toBe(text);
    },
  );

  it("follows the highlighted row with that description", () => {
    renderChooser();
    openChooser("right");
    const dialog = screen.getByRole("dialog", { name: "Thread chooser" });

    press(list(), "j");

    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Enter opens the thread in a new pane to the right");
  });

  it("does not open the highlighted thread on the Enter that ends a composition of an input method, which some browsers send without the composing flag", () => {
    renderChooser();
    openChooser();
    press(list(), "/");
    fireEvent.change(filter(), { target: { value: "a" } });

    const confirming = fireEvent.keyDown(filter(), { key: "Enter", keyCode: 229 });

    expect(confirming).toBe(true);
    expect(getUiState().chooser.open).toBe(true);
    expect(mocks.openThread).not.toHaveBeenCalled();

    press(filter(), "Enter");
    expect(mocks.openThread).toHaveBeenCalledTimes(1);
  });

  it("shows the project name and the marks of each row", () => {
    renderChooser({
      sidebarThreads: {
        threads: [
          makeThread("thr-1", { displayTitle: "Alpha", status: "active" }),
          makeThread("thr-2", {
            displayTitle: "Beta",
            projectId: "proj-unknown",
            parentThreadId: "thr-1",
            isUnread: true,
          }),
          makeThread("thr-3", {
            displayTitle: "Gamma",
            projectId: "proj-unknown",
          }),
        ],
        projects: PROJECTS,
      },
      sidebarSplitLayout: makeLayout([
        { paneId: "pane-1", threadId: "thr-1", isFocused: true },
        { paneId: "pane-2", threadId: "thr-2", isFocused: false },
      ]),
    });
    openChooser();

    const [alpha, beta, gamma] = screen.getAllByRole("option");
    expect(alpha.textContent).toContain("Website");
    expect(alpha.textContent).toContain("focused pane");
    expect(alpha.textContent).not.toContain("in a pane");
    expect(alpha.textContent).toContain("running");
    expect(beta.textContent).toContain("in a pane");
    expect(beta.textContent).toContain("unread");
    expect(beta.textContent).toContain("child thread");
    expect(gamma.textContent).toBe("Gamma");
  });

  it("scrolls the highlighted row into view after a keyboard move", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderChooser();
    openChooser();

    press(list(), "j");

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.contexts[0]).toBe(
      screen.getByRole("option", { selected: true }),
    );
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  it("returns focus to where it was when cancelled", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    renderChooser();
    openChooser();
    expect(document.activeElement).toBe(list());

    press(list(), "Escape");

    await waitFor(() => expect(document.activeElement).toBe(outside));
    expect(mocks.settleDomFocus).not.toHaveBeenCalled();
  });

  it.each([
    ["Escape", "a text field", '<textarea data-focus=""></textarea>'],
    ["q", "a text field", '<textarea data-focus=""></textarea>'],
    [
      "q",
      "the message box",
      '<div data-app-composer=""><div contenteditable="true" tabindex="0" data-focus=""></div></div>',
    ],
    [
      "Escape",
      "a sidebar thread row",
      '<a href="/t/a" data-sidebar-thread-shortcut-target="" data-sidebar-thread-id="a" data-focus="">Alpha</a>',
    ],
  ])("gives the cursor back on %s to %s, where it was", async (key, _place, html) => {
    document.body.innerHTML = html;
    const outside = document.querySelector<HTMLElement>("[data-focus]");
    outside?.focus();
    renderChooser();
    openChooser();

    press(list(), key);

    await waitFor(() => expect(document.activeElement).toBe(outside));
    expect(mocks.settleDomFocus).not.toHaveBeenCalled();
  });

  it.each([
    ["Escape", "the pane itself"],
    ["q", "the pane itself"],
    ["Escape", "nothing"],
    ["q", "nothing"],
  ])(
    "puts the cursor into the message box when it is closed with %s and the cursor was on %s",
    async (key, place) => {
      const pane = document.createElement("div");
      pane.tabIndex = -1;
      document.body.append(pane);
      if (place === "the pane itself") pane.focus();
      renderChooser();
      openChooser();

      press(list(), key);

      await waitFor(() => expect(mocks.settleDomFocus).toHaveBeenCalledTimes(1));
      expect(getUiState().chooser.open).toBe(false);
      expect(mocks.openThread).not.toHaveBeenCalled();
    },
  );

  it("puts the cursor into the message box when the element that had it is gone", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    renderChooser();
    openChooser();
    outside.remove();

    press(list(), "Escape");

    await waitFor(() => expect(mocks.settleDomFocus).toHaveBeenCalledTimes(1));
  });

  it("does not touch the cursor before it was ever opened", () => {
    renderChooser();

    expect(mocks.settleDomFocus).not.toHaveBeenCalled();
  });

  it("does not return focus to the old element after a choice", () => {
    vi.useFakeTimers();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    renderChooser();
    openChooser();

    press(list(), "Enter");
    act(() => {
      vi.runAllTimers();
    });

    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.openThread).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(outside);
    expect(mocks.settleDomFocus).not.toHaveBeenCalled();
  });

  it.each(["pane-limit", "unavailable"])(
    "gives focus back to where it was when the choice ends in %s",
    (result) => {
      mocks.openThread.mockReturnValue(result);
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      renderChooser();
      openChooser("right");

      press(list(), "j");
      press(list(), "Enter");

      expect(mocks.openThread).toHaveBeenCalledTimes(1);
      expect(getUiState().chooser.open).toBe(false);
      expect(document.activeElement).toBe(outside);
    },
  );

  it.each(["pane-limit", "unavailable"])(
    "puts the cursor into the message box when the choice ends in %s and the cursor was on the pane",
    (result) => {
      mocks.openThread.mockReturnValue(result);
      renderChooser();
      openChooser("right");

      press(list(), "j");
      press(list(), "Enter");

      expect(mocks.openThread).toHaveBeenCalledTimes(1);
      expect(mocks.settleDomFocus).toHaveBeenCalledTimes(1);
    },
  );

  it("gives focus back to where it was when opening the thread throws", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.openThread.mockImplementation(() => {
      throw new Error("boom");
    });
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    renderChooser();
    openChooser();

    press(list(), "Enter");

    expect(document.activeElement).toBe(outside);
    consoleError.mockRestore();
  });

  it("keeps taking its keys after a click on the heading put focus on the dialog itself", () => {
    renderChooser();
    openChooser();
    const dialog = screen.getByRole("dialog");

    dialog.focus();
    expect(document.activeElement).toBe(dialog);
    press(dialog, "j");
    expect(highlightedTitle()).toBe("Beta");
    press(dialog, "G", { shiftKey: true });
    expect(highlightedTitle()).toBe("Gamma");
    press(dialog, "/");
    expect(document.activeElement).toBe(filter());
    press(filter(), "Escape");
    dialog.focus();
    press(dialog, "Enter");

    expect(mocks.openThread).toHaveBeenCalledWith("thr-3", "replace");
  });

  it("takes focus again when it is reopened while it still fades out", () => {
    restoreComputedStyle = keepClosingDialogsMounted();
    const outside = document.createElement("textarea");
    document.body.append(outside);
    outside.focus();
    renderChooser();
    openChooser();
    press(list(), "Escape");
    expect(getUiState().chooser.open).toBe(false);
    expect(screen.queryByRole("dialog", { hidden: true })).not.toBeNull();
    expect(document.activeElement).toBe(outside);

    openChooser("right");

    expect(document.activeElement).toBe(list());
    press(list(), "Escape");
    expect(document.activeElement).toBe(outside);
  });

  it("forgets the highlighted row when it is reopened while it still fades out", () => {
    restoreComputedStyle = keepClosingDialogsMounted();
    renderChooser();
    openChooser("replace");
    press(list(), "j");
    press(list(), "j");
    expect(highlightedTitle()).toBe("Gamma");
    press(list(), "Escape");
    expect(screen.queryByRole("dialog", { hidden: true })).not.toBeNull();

    openChooser("right");

    expect(rowTitles()).toEqual(["New thread", "Alpha", "Beta", "Gamma"]);
    expect(highlightedTitle()).toBe("New thread");
    press(list(), "Enter");
    expect(mocks.openNewThreadInSplit).toHaveBeenCalledWith("right");
    expect(mocks.openThread).not.toHaveBeenCalled();
  });

  it("forgets the filter text when it is reopened while it still fades out", () => {
    restoreComputedStyle = keepClosingDialogsMounted();
    renderChooser();
    openChooser("right");
    press(list(), "/");
    fireEvent.change(filter(), { target: { value: "bet" } });
    press(filter(), "Escape");
    press(list(), "Escape");
    expect(screen.queryByRole("dialog", { hidden: true })).not.toBeNull();

    openChooser("right");

    expect(filter().value).toBe("");
    expect(rowTitles()).toEqual(["New thread", "Alpha", "Beta", "Gamma"]);
    expect(highlightedTitle()).toBe("New thread");
    expect(document.activeElement).toBe(list());
  });

  it("does not scroll under the mouse after a key that had no row to move to", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderChooser();
    openChooser();

    press(list(), "PageUp");
    press(list(), "b", { ctrlKey: true });
    press(list(), "Home");
    press(list(), "g");
    press(list(), "g");
    fireEvent.pointerMove(screen.getByText("Gamma"));

    expect(highlightedTitle()).toBe("Gamma");
    expect(scrollIntoView).not.toHaveBeenCalled();

    press(list(), "G", { shiftKey: true });
    press(list(), "PageDown");
    press(list(), "f", { ctrlKey: true });
    fireEvent.pointerMove(screen.getByText("Alpha"));

    expect(highlightedTitle()).toBe("Alpha");
    expect(scrollIntoView).not.toHaveBeenCalled();
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  describe("when bb changes the thread list while the chooser is open", () => {
    const DELTA = makeThread("thr-0", { displayTitle: "Delta" });

    it("keeps the highlight on the same thread when another thread arrives above it", () => {
      renderChooser();
      openChooser("right");
      press(list(), "j");
      press(list(), "j");
      expect(highlightedTitle()).toBe("Beta");

      bbChangesThreadsTo([DELTA, ...THREADS]);

      expect(rowTitles()).toEqual(["New thread", "Delta", "Alpha", "Beta", "Gamma"]);
      expect(highlightedTitle()).toBe("Beta");
      press(list(), "Enter");
      expect(mocks.openThread).toHaveBeenCalledWith("thr-2", "right");
    });

    it("keeps the highlight on the New thread row when a thread arrives", () => {
      renderChooser();
      openChooser("down");

      bbChangesThreadsTo([DELTA, ...THREADS]);

      expect(rowTitles()).toEqual(["New thread", "Delta", "Alpha", "Beta", "Gamma"]);
      expect(highlightedTitle()).toBe("New thread");
      press(list(), "Enter");
      expect(mocks.openNewThreadInSplit).toHaveBeenCalledWith("down");
      expect(mocks.openThread).not.toHaveBeenCalled();
    });

    it("keeps the highlight on a thread that is renamed", () => {
      renderChooser();
      openChooser("right");
      press(list(), "G", { shiftKey: true });

      bbChangesThreadsTo([
        THREADS[0],
        THREADS[1],
        makeThread("thr-3", { displayTitle: "Gamma two" }),
      ]);

      expect(highlightedTitle()).toBe("Gamma two");
    });

    it("moves the highlight to the first row when the highlighted thread is archived", () => {
      renderChooser();
      openChooser("right");
      press(list(), "j");
      press(list(), "j");
      expect(highlightedTitle()).toBe("Beta");

      bbChangesThreadsTo([THREADS[0], THREADS[2]]);

      expect(rowTitles()).toEqual(["New thread", "Alpha", "Gamma"]);
      expect(highlightedTitle()).toBe("New thread");
    });

    it("moves the highlight to the first thread in the chooser that has no New thread row", () => {
      renderChooser();
      openChooser("replace");
      press(list(), "G", { shiftKey: true });
      expect(highlightedTitle()).toBe("Gamma");

      bbChangesThreadsTo([THREADS[0], THREADS[1]]);

      expect(rowTitles()).toEqual(["Alpha", "Beta"]);
      expect(highlightedTitle()).toBe("Alpha");
    });
  });

  it("reports a thread that fails to open instead of throwing", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.openThread.mockImplementation(() => {
      throw new Error("boom");
    });
    renderChooser();
    openChooser();

    press(list(), "Enter");

    expect(getUiState().chooser.open).toBe(false);
    expect(getUiState().notice?.text).toBe("Could not open that thread.");
    consoleError.mockRestore();
  });

  it("is centred in the area left of a visible embedded browser view", () => {
    addVisibleBrowserTab(900);
    renderChooser();
    openChooser();

    const dialog = screen.getByRole("dialog");
    expect(dialog.style.left).toBe("450px");
    expect(dialog.style.maxWidth).toBe("640px");
  });

  it("is centred normally when no embedded browser view is visible", () => {
    renderChooser();
    openChooser();

    const dialog = screen.getByRole("dialog");
    expect(dialog.style.left).toBe("");
    expect(dialog.style.maxWidth).toBe("");
  });

  describe("the New thread row", () => {
    const SPLIT_HEADINGS = [
      ["right", "Enter starts a new thread in a new pane to the right"],
      ["down", "Enter starts a new thread in a new pane below"],
    ] as const;

    function newThreadRow(): HTMLElement {
      return screen.getByRole("option", { name: /^New thread/ });
    }

    function hintLine(): string | null {
      return list().nextElementSibling?.textContent ?? null;
    }

    it.each(SPLIT_HEADINGS)(
      "comes first and highlighted when the chooser splits %s, and says that c picks it",
      (placement, heading) => {
        renderChooser();
        openChooser(placement);

        expect(rowTitles()).toEqual(["New thread", "Alpha", "Beta", "Gamma"]);
        expect(highlightedTitle()).toBe("New thread");
        expect(newThreadRow().textContent).toBe("New threadpress c");
        expect(list().getAttribute("aria-activedescendant")).toBe(
          newThreadRow().id,
        );
        expect(screen.getByText(heading)).toBeTruthy();
      },
    );

    it("looks different from a thread row", () => {
      renderChooser();
      openChooser("right");

      const [newThread, alpha] = screen.getAllByRole("option");
      expect(newThread.className).toContain("border-dashed");
      expect(alpha.className).not.toContain("border-dashed");
    });

    it("is not offered when the chooser opens a thread in this pane", () => {
      renderChooser();
      openChooser("replace");

      expect(rowTitles()).toEqual(["Alpha", "Beta", "Gamma"]);
      expect(screen.queryByText("New thread")).toBeNull();
      expect(hintLine()).not.toContain("new thread");
    });

    it("is still offered when there are no threads", () => {
      renderChooser({ sidebarThreads: { threads: [], projects: [] } });
      openChooser("down");

      expect(rowTitles()).toEqual(["New thread"]);
      expect(screen.getByText("No threads to show")).toBeTruthy();
    });

    it.each(["right", "down"] as const)(
      "starts a new thread with the chooser's placement %s on Enter, after closing",
      (placement) => {
        const stateAtCall: { storeOpen: boolean; modalInPage: boolean }[] = [];
        mocks.openNewThreadInSplit.mockImplementation(() => {
          stateAtCall.push({
            storeOpen: getUiState().chooser.open,
            modalInPage: document.querySelector(SELECTORS.openModal) !== null,
          });
          return "started";
        });
        renderChooser();
        openChooser(placement);

        press(list(), "Enter");

        expect(mocks.openNewThreadInSplit).toHaveBeenCalledTimes(1);
        expect(mocks.openNewThreadInSplit).toHaveBeenCalledWith(placement);
        expect(stateAtCall).toEqual([{ storeOpen: false, modalInPage: false }]);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(mocks.openThread).not.toHaveBeenCalled();
      },
    );

    it("starts it to the right on v and below on s, whatever the chooser's placement", () => {
      renderChooser();
      openChooser("down");
      press(list(), "v");
      expect(mocks.openNewThreadInSplit).toHaveBeenLastCalledWith("right");
      expect(getUiState().chooser.open).toBe(false);

      openChooser("right");
      press(list(), "s");
      expect(mocks.openNewThreadInSplit).toHaveBeenLastCalledWith("down");
      expect(getUiState().chooser.open).toBe(false);
      expect(mocks.openNewThreadInSplit).toHaveBeenCalledTimes(2);
      expect(mocks.openThread).not.toHaveBeenCalled();
    });

    it.each(["right", "down"] as const)(
      "starts a new thread with the chooser's placement %s on c from a thread row, after closing",
      (placement) => {
        let modalInPage: boolean | null = null;
        mocks.openNewThreadInSplit.mockImplementation(() => {
          modalInPage = document.querySelector(SELECTORS.openModal) !== null;
          return "started";
        });
        renderChooser();
        openChooser(placement);
        press(list(), "j");
        press(list(), "j");
        expect(highlightedTitle()).toBe("Beta");

        const wasLeftAlone = fireEvent.keyDown(list(), { key: "c" });

        expect(wasLeftAlone).toBe(false);
        expect(mocks.openNewThreadInSplit).toHaveBeenCalledTimes(1);
        expect(mocks.openNewThreadInSplit).toHaveBeenCalledWith(placement);
        expect(modalInPage).toBe(false);
        expect(getUiState().chooser.open).toBe(false);
        expect(mocks.openThread).not.toHaveBeenCalled();
      },
    );

    it("starts a new thread on c while the row itself is highlighted", () => {
      renderChooser();
      openChooser("right");

      press(list(), "c");

      expect(mocks.openNewThreadInSplit).toHaveBeenCalledWith("right");
    });

    it("still opens the highlighted thread on Enter, v and s once a thread row is highlighted", () => {
      renderChooser();
      openChooser("right");
      press(list(), "j");
      press(list(), "s");
      expect(mocks.openThread).toHaveBeenLastCalledWith("thr-1", "down");

      openChooser("down");
      press(list(), "G", { shiftKey: true });
      press(list(), "Enter");
      expect(mocks.openThread).toHaveBeenLastCalledWith("thr-3", "down");
      expect(mocks.openNewThreadInSplit).not.toHaveBeenCalled();
    });

    it.each(["right", "down"] as const)(
      "closes on Escape and on q without doing anything when the chooser splits %s",
      (placement) => {
        renderChooser();
        openChooser(placement);
        press(list(), "Escape");
        expect(getUiState().chooser.open).toBe(false);

        openChooser(placement);
        press(list(), "j");
        press(list(), "q");
        expect(getUiState().chooser.open).toBe(false);

        expect(mocks.openNewThreadInSplit).not.toHaveBeenCalled();
        expect(mocks.openThread).not.toHaveBeenCalled();
      },
    );

    it("opens a highlighted thread to the right on v when the chooser splits below", () => {
      renderChooser();
      openChooser("down");
      press(list(), "j");
      press(list(), "j");

      press(list(), "v");

      expect(mocks.openThread).toHaveBeenCalledWith("thr-2", "right");
      expect(mocks.openNewThreadInSplit).not.toHaveBeenCalled();
      expect(getUiState().chooser.open).toBe(false);
    });

    it("ignores c when the chooser opens a thread in this pane", () => {
      renderChooser();
      openChooser("replace");

      const wasLeftAlone = fireEvent.keyDown(list(), { key: "c" });

      expect(wasLeftAlone).toBe(true);
      expect(mocks.openNewThreadInSplit).not.toHaveBeenCalled();
      expect(mocks.openThread).not.toHaveBeenCalled();
      expect(getUiState().chooser.open).toBe(true);
      expect(highlightedTitle()).toBe("Alpha");
    });

    it("hides while a filter is typed, so Enter opens the first matching thread", () => {
      renderChooser();
      openChooser("right");
      press(list(), "/");

      fireEvent.change(filter(), { target: { value: "a" } });

      expect(rowTitles()).toEqual(["Alpha", "Beta", "Gamma"]);
      expect(highlightedTitle()).toBe("Alpha");
      expect(
        screen.getByText("Enter opens the thread in a new pane to the right"),
      ).toBeTruthy();

      press(filter(), "Enter");

      expect(mocks.openThread).toHaveBeenCalledWith("thr-1", "right");
      expect(mocks.openNewThreadInSplit).not.toHaveBeenCalled();
    });

    it("comes back, highlighted, when the filter is cleared", () => {
      renderChooser();
      openChooser("down");
      press(list(), "/");
      fireEvent.change(filter(), { target: { value: "gam" } });
      expect(rowTitles()).toEqual(["Gamma"]);

      fireEvent.change(filter(), { target: { value: "" } });

      expect(rowTitles()).toEqual(["New thread", "Alpha", "Beta", "Gamma"]);
      expect(highlightedTitle()).toBe("New thread");
    });

    it("starts a new thread on Enter in the empty filter field, where c is text", () => {
      renderChooser();
      openChooser("down");
      press(list(), "/");

      expect(fireEvent.keyDown(filter(), { key: "c" })).toBe(true);
      expect(mocks.openNewThreadInSplit).not.toHaveBeenCalled();
      expect(hintLine()).toContain("Enter new thread");

      press(filter(), "Enter");

      expect(mocks.openNewThreadInSplit).toHaveBeenCalledWith("down");
      expect(mocks.openThread).not.toHaveBeenCalled();
    });

    it("takes c in the list while a filter hides the row", () => {
      renderChooser();
      openChooser("right");
      press(list(), "/");
      fireEvent.change(filter(), { target: { value: "bet" } });
      press(filter(), "Escape");
      expect(rowTitles()).toEqual(["Beta"]);

      press(list(), "c");

      expect(mocks.openNewThreadInSplit).toHaveBeenCalledWith("right");
      expect(mocks.openThread).not.toHaveBeenCalled();
    });

    it("starts a new thread with the chooser's placement when it is clicked, after closing", () => {
      let modalInPage: boolean | null = null;
      mocks.openNewThreadInSplit.mockImplementation(() => {
        modalInPage = document.querySelector(SELECTORS.openModal) !== null;
        return "started";
      });
      renderChooser();
      openChooser("down");
      press(list(), "j");

      fireEvent.click(screen.getByText("New thread"));

      expect(mocks.openNewThreadInSplit).toHaveBeenCalledTimes(1);
      expect(mocks.openNewThreadInSplit).toHaveBeenCalledWith("down");
      expect(modalInPage).toBe(false);
      expect(mocks.openThread).not.toHaveBeenCalled();
    });

    it("is highlighted by the mouse like a thread row", () => {
      renderChooser();
      openChooser("right");
      press(list(), "j");
      expect(highlightedTitle()).toBe("Alpha");

      fireEvent.pointerMove(newThreadRow());
      expect(highlightedTitle()).toBe("New thread");

      fireEvent.pointerMove(screen.getByText("Gamma"));
      expect(highlightedTitle()).toBe("Gamma");
    });

    it("is crossed by j and k, the arrow keys and Ctrl-n / Ctrl-p", () => {
      renderChooser();
      openChooser("right");

      press(list(), "k");
      expect(highlightedTitle()).toBe("Gamma");
      press(list(), "j");
      expect(highlightedTitle()).toBe("New thread");
      press(list(), "j");
      expect(highlightedTitle()).toBe("Alpha");
      press(list(), "k");
      expect(highlightedTitle()).toBe("New thread");
      press(list(), "ArrowDown");
      expect(highlightedTitle()).toBe("Alpha");
      press(list(), "ArrowUp");
      expect(highlightedTitle()).toBe("New thread");
      press(list(), "n", { ctrlKey: true });
      expect(highlightedTitle()).toBe("Alpha");
      press(list(), "p", { ctrlKey: true });
      expect(highlightedTitle()).toBe("New thread");
    });

    it("is the first row for g and Home and is left by G and End", () => {
      renderChooser();
      openChooser("down");

      press(list(), "G", { shiftKey: true });
      expect(highlightedTitle()).toBe("Gamma");
      press(list(), "g");
      expect(highlightedTitle()).toBe("New thread");
      press(list(), "End");
      expect(highlightedTitle()).toBe("Gamma");
      press(list(), "Home");
      expect(highlightedTitle()).toBe("New thread");
    });

    it("moves from the empty filter field with the arrow keys", () => {
      renderChooser();
      openChooser("right");
      press(list(), "/");

      press(filter(), "ArrowDown");
      expect(highlightedTitle()).toBe("Alpha");
      press(filter(), "ArrowUp");
      expect(highlightedTitle()).toBe("New thread");
    });

    it("is scrolled into view when a keyboard move reaches it", () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      renderChooser();
      openChooser("right");

      press(list(), "j");
      press(list(), "k");

      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(scrollIntoView.mock.contexts[1]).toBe(newThreadRow());
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    });

    it.each(SPLIT_HEADINGS)(
      "has a heading and a hint line that say what Enter does when the chooser splits %s",
      (placement, heading) => {
        renderChooser();
        openChooser(placement);
        expect(screen.getByText(heading)).toBeTruthy();
        expect(hintLine()).toContain("Enter or c new thread");

        press(list(), "j");

        expect(screen.queryByText(heading)).toBeNull();
        expect(hintLine()).toContain("Enter open");
        expect(hintLine()).toContain("c new thread");
      },
    );

    it("does not return focus to the old element after a new thread was started", () => {
      vi.useFakeTimers();
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      renderChooser();
      openChooser("right");

      press(list(), "Enter");
      act(() => {
        vi.runAllTimers();
      });

      expect(vi.getTimerCount()).toBe(0);
      expect(mocks.openNewThreadInSplit).toHaveBeenCalledTimes(1);
      expect(document.activeElement).not.toBe(outside);
    });

    it("does not return focus to the old element when bb moved to its one New thread screen", () => {
      mocks.openNewThreadInSplit.mockReturnValue("focused-existing");
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      renderChooser();
      openChooser("down");

      press(list(), "c");

      expect(getUiState().chooser.open).toBe(false);
      expect(document.activeElement).not.toBe(outside);
    });

    it.each(["pane-limit", "unavailable"])(
      "gives focus back to where it was when starting a new thread ends in %s",
      (result) => {
        mocks.openNewThreadInSplit.mockReturnValue(result);
        const outside = document.createElement("button");
        document.body.append(outside);
        outside.focus();
        renderChooser();
        openChooser("right");

        press(list(), "Enter");

        expect(mocks.openNewThreadInSplit).toHaveBeenCalledTimes(1);
        expect(getUiState().chooser.open).toBe(false);
        expect(document.activeElement).toBe(outside);
      },
    );

    it("reports a new thread that fails to start instead of throwing, and gives focus back", () => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mocks.openNewThreadInSplit.mockImplementation(() => {
        throw new Error("boom");
      });
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      renderChooser();
      openChooser("down");

      press(list(), "c");

      expect(getUiState().chooser.open).toBe(false);
      expect(getUiState().notice?.text).toBe("Could not start a new thread.");
      expect(document.activeElement).toBe(outside);
      consoleError.mockRestore();
    });
  });

  describe("with the keys of stock tmux, when there is no tmux config", () => {
    function hintLine(): string | null {
      return list().nextElementSibling?.textContent ?? null;
    }

    it("opens to the right with % and below with the double quote, which tmux splits with", () => {
      renderChooser({}, STOCK);
      openChooser("replace");
      press(list(), "%", { shiftKey: true });
      expect(mocks.openThread).toHaveBeenLastCalledWith("thr-1", "right");

      openChooser("replace");
      press(list(), "j");
      press(list(), '"', { shiftKey: true });
      expect(mocks.openThread).toHaveBeenLastCalledWith("thr-2", "down");
      expect(getUiState().chooser.open).toBe(false);
    });

    it.each(["v", "s", "l", "h", "x"])(
      "does nothing on %s, which stock tmux does not split with",
      (key) => {
        renderChooser({}, STOCK);
        openChooser("replace");

        press(list(), key);

        expect(mocks.openThread).not.toHaveBeenCalled();
        expect(getUiState().chooser.open).toBe(true);
      },
    );

    it("starts a new thread on c, the key tmux opens a window with, in a chooser for a new pane", () => {
      renderChooser({}, STOCK);
      openChooser("down");
      press(list(), "j");

      press(list(), "c");

      expect(mocks.openNewThreadInSplit).toHaveBeenCalledExactlyOnceWith("down");
    });

    it("names the keys of stock tmux in its hint line", () => {
      renderChooser({}, STOCK);
      openChooser("replace");
      expect(hintLine()).toBe(
        'j/k move · g/G first/last · / filter · Enter open · % right · " below · q close',
      );

      act(() => updateUiState({ chooser: { open: false } }));
      openChooser("right");
      expect(hintLine()).toBe(
        'j/k move · g/G first/last · / filter · Enter or c new thread · % right · " below · q close',
      );
      press(list(), "j");
      expect(hintLine()).toBe(
        'j/k move · g/G first/last · / filter · Enter open · % right · " below · c new thread · q close',
      );
    });

    it("says on the New thread row which key picks it", () => {
      renderChooser({}, STOCK);
      openChooser("right");

      expect(screen.getByRole("option", { name: /^New thread/ }).textContent).toBe(
        "New threadpress c",
      );
    });
  });

  describe("with the keys of a tmux config", () => {
    function hintLine(): string | null {
      return list().nextElementSibling?.textContent ?? null;
    }

    it("splits with the keys that the config binds to split-window and starts a thread with its new-window key", () => {
      const keymap = keymapOf(
        "unbind %\nunbind '\"'\nunbind c\nbind | split-window -h\nbind - split-window -v\nbind t new-window",
      );
      renderChooser({}, keymap);
      openChooser("down");
      expect(hintLine()).toBe(
        "j/k move · g/G first/last · / filter · Enter or t new thread · | right · - below · q close",
      );
      press(list(), "j");

      press(list(), "|", { shiftKey: true });
      expect(mocks.openThread).toHaveBeenLastCalledWith("thr-1", "right");

      openChooser("down");
      press(list(), "j");
      press(list(), "-");
      expect(mocks.openThread).toHaveBeenLastCalledWith("thr-1", "down");

      openChooser("down");
      press(list(), "c");
      expect(mocks.openNewThreadInSplit).not.toHaveBeenCalled();
      press(list(), "t");
      expect(mocks.openNewThreadInSplit).toHaveBeenCalledExactlyOnceWith("down");
    });

    it("takes a chord of the config as a split key", () => {
      renderChooser({}, keymapOf("bind C-v split-window -h"));
      openChooser("replace");

      press(list(), "v", { ctrlKey: true });

      expect(mocks.openThread).toHaveBeenCalledExactlyOnceWith("thr-1", "right");
    });

    it("names no split key and no new-thread key that the config has unbound", () => {
      renderChooser({}, keymapOf("unbind %\nunbind '\"'\nunbind c"));
      openChooser("right");

      expect(hintLine()).toBe(
        "j/k move · g/G first/last · / filter · Enter new thread · q close",
      );
      expect(screen.getByRole("option", { name: /^New thread/ }).textContent).toBe(
        "New thread",
      );
      press(list(), "%");
      press(list(), "c");
      expect(mocks.openThread).not.toHaveBeenCalled();
      expect(mocks.openNewThreadInSplit).not.toHaveBeenCalled();
    });

    it("keeps tmux's list keys and its own filter key, whatever the config splits with", () => {
      renderChooser(
        {},
        keymapOf("bind j split-window\nbind q split-window -h\nbind / split-window"),
      );
      openChooser("replace");

      press(list(), "j");
      expect(highlightedTitle()).toBe("Beta");
      press(list(), "/");
      expect(document.activeElement).toBe(filter());
      press(filter(), "Escape");
      press(list(), "q");

      expect(mocks.openThread).not.toHaveBeenCalled();
      expect(getUiState().chooser.open).toBe(false);
    });
  });

  describe("while the keys are not known yet", () => {
    it("still moves, opens and closes with tmux's list keys, and has no split keys", () => {
      renderChooser({}, null);
      openChooser("right");

      press(list(), "j");
      expect(highlightedTitle()).toBe("Alpha");
      press(list(), "%");
      press(list(), "v");
      press(list(), "c");
      expect(mocks.openThread).not.toHaveBeenCalled();
      expect(mocks.openNewThreadInSplit).not.toHaveBeenCalled();
      expect(list().nextElementSibling?.textContent).toBe(
        "j/k move · g/G first/last · / filter · Enter open · q close",
      );

      press(list(), "Enter");

      expect(mocks.openThread).toHaveBeenCalledExactlyOnceWith("thr-1", "right");
    });
  });

  describe("tmux's other list keys", () => {
    const MANY = Array.from({ length: 30 }, (_value, index) =>
      makeThread(`thr-${String(index).padStart(2, "0")}`, {
        displayTitle: `Thread ${index}`,
      }),
    );

    function renderMany(): void {
      renderChooser({ sidebarThreads: { threads: MANY, projects: PROJECTS } });
      openChooser("replace");
    }

    it("closes on Ctrl-g without opening a thread", () => {
      renderChooser();
      openChooser();

      press(list(), "g", { ctrlKey: true });

      expect(getUiState().chooser.open).toBe(false);
      expect(mocks.openThread).not.toHaveBeenCalled();
    });

    it.each<[string, KeyboardEventInit, KeyboardEventInit]>([
      ["PageDown and PageUp", { key: "PageDown" }, { key: "PageUp" }],
      ["Ctrl-f and Ctrl-b", { key: "f", ctrlKey: true }, { key: "b", ctrlKey: true }],
    ])("moves a page of ten rows with %s where the rows cannot be measured", (_keys, down, up) => {
      renderMany();

      fireEvent.keyDown(list(), down);
      expect(highlightedTitle()).toBe("Thread 10");
      fireEvent.keyDown(list(), down);
      fireEvent.keyDown(list(), down);
      expect(highlightedTitle()).toBe("Thread 29");
      fireEvent.keyDown(list(), up);
      expect(highlightedTitle()).toBe("Thread 19");
      fireEvent.keyDown(list(), up);
      fireEvent.keyDown(list(), up);
      expect(highlightedTitle()).toBe("Thread 0");
    });

    it("moves by the rows that the list shows at once, less one", () => {
      renderMany();
      Object.defineProperty(list(), "clientHeight", { value: 200 });
      for (const option of screen.getAllByRole("option")) {
        option.getBoundingClientRect = () => new DOMRect(0, 0, 600, 40);
      }

      press(list(), "PageDown");

      expect(highlightedTitle()).toBe("Thread 4");
    });

    it("pages with PageDown and PageUp from the filter field, and leaves Ctrl-f and Ctrl-b to the text field", () => {
      renderMany();
      press(list(), "/");

      press(filter(), "PageDown");
      expect(highlightedTitle()).toBe("Thread 10");
      press(filter(), "f", { ctrlKey: true });
      press(filter(), "b", { ctrlKey: true });
      expect(highlightedTitle()).toBe("Thread 10");
      press(filter(), "PageUp");
      expect(highlightedTitle()).toBe("Thread 0");
    });
  });

  // A terminal sends Ctrl-[ as Escape, Ctrl-m as Enter and Ctrl-i as Tab.
  describe("the keys that a terminal sends as Escape, Enter and Tab", () => {
    const CTRL: KeyboardEventInit = { ctrlKey: true };

    it("closes on Ctrl-[ in the list without opening a thread, as on Escape", () => {
      renderChooser();
      openChooser();

      press(list(), "[", CTRL);

      expect(getUiState().chooser.open).toBe(false);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(mocks.openThread).not.toHaveBeenCalled();
    });

    it("opens the highlighted thread with the chooser's placement on Ctrl-m in the list, as on Enter", () => {
      renderChooser();
      openChooser("replace");
      press(list(), "j");

      press(list(), "m", CTRL);

      expect(mocks.openThread).toHaveBeenCalledExactlyOnceWith("thr-2", "replace");
      expect(getUiState().chooser.open).toBe(false);
    });

    it("starts a new thread on Ctrl-m on the New thread row", () => {
      renderChooser();
      openChooser("right");

      press(list(), "m", CTRL);

      expect(mocks.openNewThreadInSplit).toHaveBeenCalledExactlyOnceWith("right");
      expect(mocks.openThread).not.toHaveBeenCalled();
    });

    it("goes back to the list on Ctrl-[ in the filter field and keeps the filter text, and closes on the next Ctrl-[", () => {
      renderChooser();
      openChooser();
      press(list(), "/");
      fireEvent.change(filter(), { target: { value: "a" } });

      press(filter(), "[", CTRL);

      expect(getUiState().chooser.open).toBe(true);
      expect(document.activeElement).toBe(list());
      expect(filter().value).toBe("a");

      press(list(), "[", CTRL);
      expect(getUiState().chooser.open).toBe(false);
    });

    it("opens the highlighted thread on Ctrl-m in the filter field", () => {
      renderChooser();
      openChooser("down");
      press(list(), "/");
      fireEvent.change(filter(), { target: { value: "bet" } });

      press(filter(), "m", CTRL);

      expect(mocks.openThread).toHaveBeenCalledExactlyOnceWith("thr-2", "down");
      expect(getUiState().chooser.open).toBe(false);
    });

    it("moves the cursor from the list to the filter field and back on Ctrl-i, as Tab does", () => {
      renderChooser();
      openChooser();
      expect(document.activeElement).toBe(list());

      press(list(), "i", CTRL);
      expect(document.activeElement).toBe(filter());

      press(filter(), "i", CTRL);
      expect(document.activeElement).toBe(list());
      expect(filter().value).toBe("");
      expect(getUiState().chooser.open).toBe(true);
      expect(mocks.openThread).not.toHaveBeenCalled();
    });

    it("takes the three keys for itself, so that they do nothing else", () => {
      renderChooser();
      openChooser();

      expect(fireEvent.keyDown(list(), { key: "i", ctrlKey: true })).toBe(false);
      expect(fireEvent.keyDown(filter(), { key: "[", ctrlKey: true })).toBe(false);
      expect(fireEvent.keyDown(list(), { key: "m", ctrlKey: true })).toBe(false);
    });

    it("takes the chord itself in the list when the tmux config makes it a split key", () => {
      renderChooser({}, keymapOf("bind C-m split-window -h\nbind C-[ split-window"));
      openChooser("replace");

      press(list(), "m", CTRL);
      expect(mocks.openThread).toHaveBeenCalledExactlyOnceWith("thr-1", "right");

      openChooser("replace");
      press(list(), "[", CTRL);
      expect(mocks.openThread).toHaveBeenLastCalledWith("thr-1", "down");
    });

    it("takes that chord for Enter in the filter field, where a split key is no key", () => {
      renderChooser({}, keymapOf("bind C-m split-window -h"));
      openChooser("replace");
      press(list(), "/");

      press(filter(), "m", CTRL);

      expect(mocks.openThread).toHaveBeenCalledExactlyOnceWith("thr-1", "replace");
    });

    it.each<[string, KeyboardEventInit]>([
      ["Ctrl-Alt-m", { key: "m", ctrlKey: true, altKey: true }],
      ["Ctrl-Shift-m", { key: "M", ctrlKey: true, shiftKey: true }],
      ["Cmd-m", { key: "m", metaKey: true }],
      ["Alt-[", { key: "[", altKey: true }],
      ["Ctrl-j", { key: "j", ctrlKey: true }],
    ])("leaves %s alone, which no terminal sends as one of them", (_name, init) => {
      renderChooser();
      openChooser();

      expect(fireEvent.keyDown(list(), init)).toBe(true);

      expect(getUiState().chooser.open).toBe(true);
      expect(document.activeElement).toBe(list());
      expect(mocks.openThread).not.toHaveBeenCalled();
    });

    it("works while the keys are not known yet", () => {
      renderChooser({}, null);
      openChooser();

      press(list(), "[", CTRL);

      expect(getUiState().chooser.open).toBe(false);
    });
  });

  describe("on a compact viewport, where the dialog is a drawer", () => {
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

    it("still takes its keys", async () => {
      addVisibleBrowserTab(900);
      renderChooser();
      openChooser("right");

      await waitFor(() => expect(document.activeElement).toBe(list()));
      expect(screen.getByRole("dialog").style.left).toBe("");

      press(list(), "j");
      expect(highlightedTitle()).toBe("Alpha");
      press(list(), "j");
      expect(highlightedTitle()).toBe("Beta");
      press(list(), "/");
      expect(document.activeElement).toBe(filter());
      press(filter(), "Escape");
      expect(getUiState().chooser.open).toBe(true);
      expect(document.activeElement).toBe(list());

      press(list(), "Enter");
      expect(mocks.openThread).toHaveBeenCalledWith("thr-2", "right");
      expect(getUiState().chooser.open).toBe(false);
    });

    // What a click does: the nearest element above that can hold the cursor
    // takes it.
    function clickFocus(element: Element): HTMLElement {
      const holder = element.closest<HTMLElement>("[tabindex]");
      if (holder === null) throw new Error("nothing above can hold the cursor");
      holder.focus();
      return holder;
    }

    it.each([
      ["its heading", () => screen.getByText("Enter opens the thread in this pane")],
      ["its hint line", () => screen.getByText(/first\/last/)],
    ])("still takes its keys after a click on %s", async (_name, clicked) => {
      renderChooser();
      openChooser();
      await waitFor(() => expect(document.activeElement).toBe(list()));

      const holder = clickFocus(clicked());
      press(holder, "j");
      expect(highlightedTitle()).toBe("Beta");

      press(holder, "q");
      expect(getUiState().chooser.open).toBe(false);
    });

    function drawerHandle(): HTMLElement {
      const handle = document.querySelector<HTMLElement>(
        "[data-persistent-drawer-handle]",
      );
      if (handle === null) throw new Error("the drawer has no handle");
      return handle;
    }

    function pressOnFocused(key: string): void {
      press(document.activeElement ?? document.body, key);
    }

    // The handle is in a strip of the drawer above the dialog, so a click
    // there puts the cursor on the drawer itself, which is outside the dialog.
    it("still takes its keys after a click on the handle of the drawer", async () => {
      renderChooser();
      openChooser();
      await waitFor(() => expect(document.activeElement).toBe(list()));

      const drawer = clickFocus(drawerHandle());

      expect(drawer.getAttribute("role")).toBe("dialog");
      expect(drawer.contains(list())).toBe(true);
      expect(document.activeElement).toBe(list());
      pressOnFocused("j");
      expect(highlightedTitle()).toBe("Beta");
      pressOnFocused("/");
      expect(document.activeElement).toBe(filter());

      clickFocus(drawerHandle());

      expect(document.activeElement).toBe(list());
      pressOnFocused("Enter");
      expect(mocks.openThread).toHaveBeenCalledExactlyOnceWith("thr-2", "replace");
      expect(getUiState().chooser.open).toBe(false);
    });

    it("still takes its keys after such a click in a chooser that was closed and opened again", async () => {
      renderChooser();
      openChooser();
      await waitFor(() => expect(document.activeElement).toBe(list()));
      pressOnFocused("q");
      openChooser("right");
      await waitFor(() => expect(document.activeElement).toBe(list()));

      clickFocus(drawerHandle());

      expect(document.activeElement).toBe(list());
      pressOnFocused("q");
      expect(getUiState().chooser.open).toBe(false);
    });

    it("puts a cursor that the drawer leaves on the pane or on nothing into the message box when it closes", async () => {
      renderChooser();
      openChooser();
      await waitFor(() => expect(document.activeElement).toBe(list()));

      press(list(), "q");

      expect(getUiState().chooser.open).toBe(false);
      expect(mocks.settleIdleDomFocus).toHaveBeenCalledTimes(1);
    });

    it("places no cursor before the drawer was ever opened", () => {
      renderChooser();

      expect(mocks.settleIdleDomFocus).not.toHaveBeenCalled();
      expect(mocks.settleDomFocus).not.toHaveBeenCalled();
    });
  });
});
