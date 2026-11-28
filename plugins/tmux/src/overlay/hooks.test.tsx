// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetStore, showNotice, updateUiState } from "../bridge";
import { settleDomFocus, settleIdleDomFocus, takeOwedSettle } from "../pane-focus";
import { DEFAULT_SETTINGS } from "../settings";
import {
  giveFocusBack,
  pressFocusedButton,
  useFocusWhenReopened,
  usePluginSettings,
  useReturnFocus,
  useStableSettings,
  useUiState,
  type ReturnFocus,
} from "./hooks";

type SettingValues = Parameters<typeof useStableSettings>[0];

interface SettingsState {
  values: SettingValues;
  isLoading: boolean;
}

const sdk = vi.hoisted(() => ({
  settingsState: { values: undefined, isLoading: true } as SettingsState,
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useSettings: () => sdk.settingsState,
}));
vi.mock("../pane-focus", () => ({
  settleDomFocus: vi.fn(),
  settleIdleDomFocus: vi.fn(),
  takeOwedSettle: vi.fn(() => false),
}));

const INITIAL_PROPS: { values: SettingValues } = {
  values: { tmuxConfigText: "set -g mouse on" },
};

afterEach(() => {
  cleanup();
  resetStore();
  document.body.replaceChildren();
  sdk.settingsState = { values: undefined, isLoading: true };
  vi.clearAllMocks();
});

describe("useStableSettings", () => {
  it("parses the values, falling back to the defaults", () => {
    const { result } = renderHook(() => useStableSettings(undefined));
    expect(result.current).toEqual(DEFAULT_SETTINGS);
  });

  it("returns the same object for new but equal values", () => {
    const { result, rerender } = renderHook(
      ({ values }: { values: SettingValues }) => useStableSettings(values),
      { initialProps: INITIAL_PROPS },
    );
    const first = result.current;

    rerender({ values: { tmuxConfigText: "set -g mouse on" } });
    rerender({ values: { tmuxConfigText: "set -g mouse on", enabled: false } });

    expect(result.current).toBe(first);
  });

  it("returns a new object when a value changes, then keeps that one", () => {
    const { result, rerender } = renderHook(
      ({ values }: { values: SettingValues }) => useStableSettings(values),
      { initialProps: INITIAL_PROPS },
    );
    const first = result.current;

    rerender({ values: { tmuxConfigText: "set -g mouse off" } });
    const second = result.current;
    expect(second).not.toBe(first);
    expect(second.tmuxConfigText).toBe("set -g mouse off");

    rerender({ values: { tmuxConfigText: "set -g mouse off" } });
    expect(result.current).toBe(second);
  });
});

// bb's useSettings (apps/app/src/lib/plugin-sdk-hooks.ts in bb 0.50.1) reports
// values: undefined while it loads and also after a failed read, for which it
// has already set isLoading to false. The settings route answers 404 while
// the server part of the plugin is not running.
describe("usePluginSettings", () => {
  function bbReports(values: SettingValues, isLoading = false): void {
    sdk.settingsState = { values, isLoading };
  }

  it("is not loaded while bb is loading the settings", () => {
    const { result } = renderHook(() => usePluginSettings());

    expect(result.current.isLoaded).toBe(false);
  });

  it("is not loaded when bb has stopped loading without any values", () => {
    bbReports(undefined);

    const { result } = renderHook(() => usePluginSettings());

    expect(result.current.isLoaded).toBe(false);
  });

  it("is loaded with the user's values once bb reports them", () => {
    const { result, rerender } = renderHook(() => usePluginSettings());

    bbReports({ copyOnSelect: "off", tmuxConfigText: "set -g mouse on" });
    rerender();

    expect(result.current.isLoaded).toBe(true);
    expect(result.current.settings).toEqual({
      ...DEFAULT_SETTINGS,
      copyOnSelect: "off",
      tmuxConfigText: "set -g mouse on",
    });
  });

  it("is loaded with the defaults for a plugin whose settings were never changed", () => {
    bbReports({});

    const { result } = renderHook(() => usePluginSettings());

    expect(result.current).toEqual({ settings: DEFAULT_SETTINGS, isLoaded: true });
  });

  it("keeps the last values, not the defaults, when bb can no longer read the settings", () => {
    bbReports({ copyOnSelect: "off", enabled: true });
    const { result, rerender } = renderHook(() => usePluginSettings());
    const settings = result.current.settings;

    bbReports(undefined);
    rerender();
    rerender();

    expect(result.current.isLoaded).toBe(true);
    expect(result.current.settings).toBe(settings);
    expect(result.current.settings).toMatchObject({ copyOnSelect: "off", enabled: true });
  });

  it("settles when bb hands out a new but equal values object on every render", () => {
    Object.defineProperty(sdk.settingsState, "values", {
      get: () => ({ tmuxConfigText: "set -g mouse on" }),
    });

    const { result, rerender } = renderHook(() => usePluginSettings());
    const settings = result.current.settings;
    rerender();

    expect(result.current.isLoaded).toBe(true);
    expect(result.current.settings).toBe(settings);
    expect(settings.tmuxConfigText).toBe("set -g mouse on");
  });

  it("follows the values again when bb reports new ones", () => {
    bbReports({ copyOnSelect: "off" });
    const { result, rerender } = renderHook(() => usePluginSettings());
    bbReports(undefined);
    rerender();

    bbReports({ copyOnSelect: "on", scrollStepPx: 120 });
    rerender();

    expect(result.current.isLoaded).toBe(true);
    expect(result.current.settings).toMatchObject({ copyOnSelect: "on", scrollStepPx: 120 });
  });
});

describe("useUiState", () => {
  it("follows the selected part of the store", () => {
    const { result } = renderHook(() =>
      useUiState((state) => state.prefixArmed),
    );
    expect(result.current).toBe(false);

    act(() => updateUiState({ prefixArmed: true }));

    expect(result.current).toBe(true);
  });

  it("does not re-render for changes to other parts of the store", () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useUiState((state) => state.chooser);
    });
    const rendersBefore = renders;

    act(() => showNotice("hello"));
    act(() => updateUiState({ prefixArmed: true }));

    expect(renders).toBe(rendersBefore);
  });
});

describe("useReturnFocus", () => {
  function setup() {
    const outside = document.createElement("button");
    const inside = document.createElement("button");
    document.body.append(outside, inside);
    const hook = renderHook(({ isOpen }) => useReturnFocus(isOpen), {
      initialProps: { isOpen: true },
    });
    return { outside, inside, ...hook };
  }

  it("focuses the remembered element again when the dialog closes", () => {
    const { outside, inside, result, rerender } = setup();
    outside.focus();
    result.current.remember();
    inside.focus();

    rerender({ isOpen: false });

    expect(document.activeElement).toBe(outside);
    expect(settleDomFocus).not.toHaveBeenCalled();
  });

  it("puts the cursor into the message box when the dialog closes and the cursor was on the pane itself", () => {
    const { inside, result, rerender } = setup();
    const pane = document.createElement("div");
    pane.tabIndex = -1;
    document.body.append(pane);
    pane.focus();
    result.current.remember();
    inside.focus();

    rerender({ isOpen: false });

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(inside);
  });

  it("does the same when the cursor was on nothing", () => {
    const { inside, result, rerender } = setup();
    expect(document.activeElement).toBe(document.body);
    result.current.remember();
    inside.focus();

    rerender({ isOpen: false });

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
  });

  it("leaves the cursor to the check for one that is left on the pane or on nothing after an opening that remembered nothing, as the drawer of a narrow window is", () => {
    const { rerender } = setup();

    rerender({ isOpen: false });

    expect(settleIdleDomFocus).toHaveBeenCalledTimes(1);
    expect(settleDomFocus).not.toHaveBeenCalled();

    rerender({ isOpen: false });
    expect(settleIdleDomFocus).toHaveBeenCalledTimes(1);
  });

  it("puts the cursor into the message box after such an opening when a pane move ended meanwhile", () => {
    const { rerender } = setup();
    vi.mocked(takeOwedSettle).mockReturnValueOnce(true);

    rerender({ isOpen: false });

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
    expect(settleIdleDomFocus).not.toHaveBeenCalled();
  });

  it("does not use that check after an opening that remembered where the cursor was", () => {
    const { outside, result, rerender } = setup();
    outside.focus();
    result.current.remember();

    rerender({ isOpen: false });
    rerender({ isOpen: true });
    rerender({ isOpen: false });

    expect(settleIdleDomFocus).toHaveBeenCalledTimes(1);
  });

  it("touches nothing when it starts closed and nothing was remembered", () => {
    renderHook(({ isOpen }) => useReturnFocus(isOpen), {
      initialProps: { isOpen: false },
    });

    expect(settleDomFocus).not.toHaveBeenCalled();
  });

  it("keeps the first element when it is asked to remember again while open", () => {
    const { outside, inside, result, rerender } = setup();
    outside.focus();
    result.current.remember();
    inside.focus();
    result.current.remember();

    rerender({ isOpen: false });

    expect(document.activeElement).toBe(outside);
  });

  it("hands the remembered element over with take and then leaves focus alone", () => {
    const { outside, inside, result, rerender } = setup();
    outside.focus();
    result.current.remember();
    inside.focus();

    expect(result.current.take()).toBe(outside);
    expect(result.current.take()).toBeNull();
    rerender({ isOpen: false });

    expect(document.activeElement).toBe(inside);
    expect(settleDomFocus).not.toHaveBeenCalled();
  });

  it("puts the cursor into the message box when the remembered element is gone", () => {
    const { outside, inside, result, rerender } = setup();
    outside.focus();
    result.current.remember();
    inside.focus();
    outside.remove();

    rerender({ isOpen: false });

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(inside);
  });

  it("remembers nothing across a second close", () => {
    const { outside, inside, result, rerender } = setup();
    outside.focus();
    result.current.remember();
    rerender({ isOpen: false });
    rerender({ isOpen: true });
    inside.focus();

    rerender({ isOpen: false });

    expect(document.activeElement).toBe(inside);
    expect(settleDomFocus).not.toHaveBeenCalled();
  });
});

describe("giveFocusBack", () => {
  function place(html: string): HTMLElement {
    document.body.innerHTML = html;
    const element = document.querySelector<HTMLElement>("[data-place]");
    if (element === null) throw new Error("the fixture has no place");
    return element;
  }

  it.each([
    ["a button", '<button type="button" data-place=""></button>'],
    ["a text field", '<textarea data-place=""></textarea>'],
    [
      "the message box",
      '<div data-app-composer=""><div contenteditable="true" tabindex="0" data-place=""></div></div>',
    ],
    [
      "the terminal",
      '<div data-app-terminal=""><textarea data-place=""></textarea></div>',
    ],
    [
      "a sidebar thread row",
      '<a href="/t/a" data-sidebar-thread-shortcut-target="" data-sidebar-thread-id="a" data-place="">Alpha</a>',
    ],
    [
      "a menu item",
      '<div role="menu"><div role="menuitem" tabindex="-1" data-place=""></div></div>',
    ],
  ])("puts the cursor back on %s", (_name, html) => {
    const element = place(html);

    giveFocusBack(element);

    expect(document.activeElement).toBe(element);
    expect(settleDomFocus).not.toHaveBeenCalled();
  });

  it.each([
    ["the pane itself", '<div data-split-pane-id="p1" tabindex="-1" data-place=""></div>'],
    ["a message of the conversation", '<main><p tabindex="-1" data-place="">Hello</p></main>'],
  ])("puts the cursor into the message box when it was on %s", (_name, html) => {
    const element = place(html);

    giveFocusBack(element);

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
  });

  it("puts the cursor into the message box when it was on nothing", () => {
    giveFocusBack(document.body);

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
  });

  it("puts the cursor into the message box when the element has left the page", () => {
    const detached = document.createElement("button");

    giveFocusBack(detached);

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
  });

  it.each([
    ["a text field", '<textarea data-place=""></textarea>'],
    ["a sidebar thread row", '<a href="/t/a" data-sidebar-thread-shortcut-target="" data-sidebar-thread-id="a" data-place="">Alpha</a>'],
  ])(
    "puts the cursor into the message box, and not back on %s, after a pane move that bb finished while the dialog was open",
    (_name, html) => {
      const element = place(html);
      vi.mocked(takeOwedSettle).mockReturnValueOnce(true);

      giveFocusBack(element);

      expect(settleDomFocus).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(document.body);
    },
  );

  it("puts the cursor into the message box after such a pane move also when no element was remembered", () => {
    vi.mocked(takeOwedSettle).mockReturnValueOnce(true);

    giveFocusBack(null);

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no element was remembered, as before the first opening", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();

    giveFocusBack(null);

    expect(settleDomFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });

  it("puts the cursor back on the pane while another dialog is open, which keeps the keys", () => {
    const element = place(
      '<div data-split-pane-id="p1" tabindex="-1" data-place=""></div><div role="dialog" data-state="open"></div>',
    );

    giveFocusBack(element);

    expect(settleDomFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(element);
  });
});

describe("pressFocusedButton", () => {
  function setup() {
    document.body.innerHTML =
      '<main id="page"><button type="button" id="outside"></button><div id="dialog"><div id="list" tabindex="0"></div><button type="button" id="close"></button></div></main>';
    const element = (id: string): HTMLElement => {
      const found = document.getElementById(id);
      if (found === null) throw new Error(`the fixture has no ${id}`);
      return found;
    };
    const clicked: string[] = [];
    element("page").addEventListener("click", (event) => {
      clicked.push((event.target as HTMLElement).id);
    });
    return { dialog: element("dialog"), element, clicked };
  }

  it("presses the button of the dialog that has the cursor", () => {
    const { dialog, element, clicked } = setup();
    element("close").focus();

    expect(pressFocusedButton(dialog)).toBe(true);

    expect(clicked).toEqual(["close"]);
  });

  it("presses nothing while the cursor is on something else in the dialog", () => {
    const { dialog, element, clicked } = setup();
    element("list").focus();

    expect(pressFocusedButton(dialog)).toBe(false);

    expect(clicked).toEqual([]);
  });

  it("presses no button outside the dialog", () => {
    const { dialog, element, clicked } = setup();
    element("outside").focus();

    expect(pressFocusedButton(dialog)).toBe(false);

    expect(clicked).toEqual([]);
  });
});

describe("useFocusWhenReopened", () => {
  function setup() {
    const outside = document.createElement("button");
    const content = document.createElement("div");
    const target = document.createElement("button");
    content.append(target);
    document.body.append(outside, content);
    const contentRef = createRef<HTMLElement>();
    const targetRef = createRef<HTMLElement>();
    targetRef.current = target;
    const remembered: (Element | null)[] = [];
    const returnFocus: ReturnFocus = {
      remember: () => remembered.push(document.activeElement),
      take: () => null,
    };
    const hook = renderHook(
      ({ isOpen }) =>
        useFocusWhenReopened(isOpen, contentRef, targetRef, returnFocus),
      { initialProps: { isOpen: false } },
    );
    return { outside, content, target, contentRef, remembered, ...hook };
  }

  it("moves focus into a dialog that opens again while its content is still mounted", () => {
    const { outside, content, target, contentRef, remembered, rerender } = setup();
    contentRef.current = content;
    outside.focus();

    rerender({ isOpen: true });

    expect(document.activeElement).toBe(target);
    expect(remembered).toEqual([outside]);
  });

  it("leaves a first open to the dialog, whose content is not mounted yet", () => {
    const { outside, remembered, rerender } = setup();
    outside.focus();

    rerender({ isOpen: true });

    expect(document.activeElement).toBe(outside);
    expect(remembered).toEqual([]);
  });

  it("leaves focus that is already inside the dialog alone", () => {
    const { content, contentRef, remembered, rerender } = setup();
    const other = document.createElement("input");
    content.append(other);
    contentRef.current = content;
    other.focus();

    rerender({ isOpen: true });

    expect(document.activeElement).toBe(other);
    expect(remembered).toEqual([]);
  });
});
