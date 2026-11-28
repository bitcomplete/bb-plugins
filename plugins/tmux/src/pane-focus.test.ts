// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUiState, resetStore, setBridge, updateUiState } from "./bridge";
import { ATTRIBUTES } from "./constants";
import {
  activatePaneByPointer,
  focusPaneElement,
  getFocusedPaneElement,
  getPaneElementById,
} from "./dom-actions";
import {
  cancelPendingFocus,
  focusPane,
  getFocusedPane,
  getFocusedThreadId,
  settleDomFocus,
  settleDomFocusWhen,
  settleIdleDomFocus,
  showsNewThreadScreen,
  takeOwedSettle,
} from "./pane-focus";
import { DEFAULT_SETTINGS } from "./settings";
import type { Bridge, SplitPane } from "./types";

vi.mock("./dom-actions", () => ({
  activatePaneByPointer: vi.fn(() => true),
  focusPaneElement: vi.fn(),
  getFocusedPaneElement: vi.fn(() => null),
  getPaneElementById: vi.fn(() => null),
  hasOpenModal: vi.fn(() => false),
}));

const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

function runFrame(): void {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}

function pane(paneId: string, threadId: string | null, isFocused = false): SplitPane {
  return { paneId, threadId, isFocused, rect: { x: 0, y: 0, width: 1, height: 1 } };
}

function composer(scope: object, focus = vi.fn()) {
  return { scope, focus };
}

interface BridgeOptions {
  panes?: SplitPane[] | null;
  contextThreadId?: string | null;
  composers?: ReturnType<typeof composer>[];
}

function publishBridge(options: BridgeOptions = {}) {
  const navigate = { toThread: vi.fn(), toCompose: vi.fn() };
  const panes = options.panes ?? null;
  setBridge({
    navigate,
    sdk: {},
    layout: panes === null ? null : { panes },
    context: { projectId: null, threadId: options.contextThreadId ?? null },
    threads: [],
    threadsReady: true,
    projects: [],
    composers: options.composers ?? [],
    settings: DEFAULT_SETTINGS,
  } as unknown as Bridge);
  return navigate;
}

function paneElement(paneId: string, innerHtml = ""): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute(ATTRIBUTES.paneId, paneId);
  element.innerHTML = innerHtml;
  return element;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  frames.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.mocked(getFocusedPaneElement).mockReturnValue(null);
  vi.mocked(getPaneElementById).mockReturnValue(null);
});

afterEach(() => {
  cancelPendingFocus();
  resetStore();
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getFocusedPane and getFocusedThreadId", () => {
  it("return null while the bridge is missing", () => {
    expect(getFocusedPane()).toBeNull();
    expect(getFocusedThreadId()).toBeNull();
  });

  it("use the context thread when there is a single pane", () => {
    publishBridge({ panes: null, contextThreadId: "thr_only" });
    expect(getFocusedPane()).toBeNull();
    expect(getFocusedThreadId()).toBe("thr_only");
  });

  it("use the pane flagged as focused in a split", () => {
    publishBridge({
      panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)],
      contextThreadId: "thr_stale",
    });
    expect(getFocusedPane()?.paneId).toBe("p2");
    expect(getFocusedThreadId()).toBe("thr_b");
  });

  it("report no thread for a focused pane that shows something else", () => {
    publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", null, true)] });
    expect(getFocusedThreadId()).toBeNull();
  });
});

describe("settleDomFocus", () => {
  const MESSAGE_BOX =
    '<div data-app-composer data-app-composer-role="primary"><div contenteditable="true" tabindex="0"></div></div>';
  const INLINE_EDITOR =
    '<div data-app-composer data-app-composer-role="secondary"><div contenteditable="true" tabindex="0"></div></div>';
  const SIDE_PANEL_CHAT =
    '<div data-sidebar-split-container><div data-app-composer><div contenteditable="true" tabindex="0"></div></div></div>';

  function editorIn(element: HTMLElement): HTMLElement {
    const editor = element.querySelector<HTMLElement>("[contenteditable]");
    if (editor === null) throw new Error("the fixture has no text field");
    return editor;
  }

  it("puts the cursor on the pane and then asks bb to move it into the message box", () => {
    const element = paneElement("p1");
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const other = composer({ kind: "thread", threadId: "thr_b" });
    const queued = composer({ kind: "queued-message", threadId: "thr_a", queuedMessageId: "q" });
    const match = composer({ kind: "thread", threadId: "thr_a" });
    publishBridge({
      panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")],
      composers: [other, queued, match],
    });

    settleDomFocus();

    expect(focusPaneElement).toHaveBeenCalledTimes(1);
    expect(focusPaneElement).toHaveBeenCalledWith(element);
    expect(match.focus).toHaveBeenCalledTimes(1);
    expect(other.focus).not.toHaveBeenCalled();
    expect(queued.focus).not.toHaveBeenCalled();
    expect(vi.mocked(focusPaneElement).mock.invocationCallOrder[0]).toBeLessThan(
      match.focus.mock.invocationCallOrder[0],
    );
  });

  it("asks for the message box of the only pane, whose thread the route names", () => {
    const element = paneElement("p1");
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const match = composer({ kind: "thread", threadId: "thr_only" });
    publishBridge({ panes: null, contextThreadId: "thr_only", composers: [match] });

    settleDomFocus();

    expect(focusPaneElement).toHaveBeenCalledWith(element);
    expect(match.focus).toHaveBeenCalledTimes(1);
  });

  it("asks for the message box of the New thread screen when the pane shows that", () => {
    const element = paneElement("p2", MESSAGE_BOX);
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const newThread = composer({ kind: "new-thread", projectId: null });
    const thread = composer({ kind: "thread", threadId: "thr_a" });
    publishBridge({
      panes: [pane("p1", "thr_a"), pane("p2", null, true)],
      composers: [thread, newThread],
    });

    settleDomFocus();

    expect(focusPaneElement).toHaveBeenCalledWith(element);
    expect(newThread.focus).toHaveBeenCalledTimes(1);
    expect(thread.focus).not.toHaveBeenCalled();
  });

  it("asks for the message box of the New thread screen in a single pane", () => {
    const newThread = composer({ kind: "new-thread", projectId: "proj" });
    publishBridge({ panes: null, contextThreadId: null, composers: [newThread] });

    settleDomFocus();

    expect(newThread.focus).toHaveBeenCalledTimes(1);
  });

  it("stays on a pane that has no message box, and leaves the New thread screen of another pane alone", () => {
    const newThread = composer({ kind: "new-thread", projectId: null });
    const pluginPane = paneElement("p2", "<p>plugin page</p>");
    vi.mocked(getFocusedPaneElement).mockReturnValue(pluginPane);
    publishBridge({
      panes: [pane("p1", null), pane("p2", null, true)],
      composers: [newThread],
    });

    settleDomFocus();

    expect(newThread.focus).not.toHaveBeenCalled();
    expect(focusPaneElement).toHaveBeenCalledTimes(1);
    expect(focusPaneElement).toHaveBeenCalledWith(pluginPane);
  });

  it("stays on a pane whose plugin page embeds a chat, and leaves the New thread screen of another pane alone", () => {
    const newThread = composer({ kind: "new-thread", projectId: null });
    const pluginPane = paneElement("p2", INLINE_EDITOR);
    vi.mocked(getFocusedPaneElement).mockReturnValue(pluginPane);
    publishBridge({
      panes: [pane("p1", null), pane("p2", null, true)],
      composers: [newThread],
    });

    settleDomFocus();

    expect(newThread.focus).not.toHaveBeenCalled();
    expect(focusPaneElement).toHaveBeenCalledExactlyOnceWith(pluginPane);
  });

  it("stays on the pane when bb lists no message box for the thread, as while it is hidden or still loading", () => {
    const element = paneElement("p1");
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const other = composer({ kind: "thread", threadId: "thr_other" });
    publishBridge({ panes: [pane("p1", "thr_a", true)], composers: [other] });

    settleDomFocus();

    expect(focusPaneElement).toHaveBeenCalledTimes(1);
    expect(focusPaneElement).toHaveBeenCalledWith(element);
    expect(other.focus).not.toHaveBeenCalled();
  });

  it("stays on the pane if a later bb should throw for a stale composer handle, which bb 0.50.1 does not do", () => {
    const element = paneElement("p1");
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const stale = composer(
      { kind: "thread", threadId: "thr_a" },
      vi.fn(() => {
        throw new Error("This composer is no longer available.");
      }),
    );
    publishBridge({ panes: [pane("p1", "thr_a", true)], composers: [stale] });

    expect(() => settleDomFocus()).not.toThrow();
    expect(stale.focus).toHaveBeenCalledTimes(1);
    expect(focusPaneElement).toHaveBeenCalledTimes(1);
    expect(focusPaneElement).toHaveBeenCalledWith(element);
  });

  it("blurs to the body through focusPaneElement when there is neither a pane element nor a bridge", () => {
    settleDomFocus();
    expect(focusPaneElement).toHaveBeenCalledTimes(1);
    expect(focusPaneElement).toHaveBeenCalledWith(null);
  });

  it("leaves a cursor alone that is already in the message box of that pane, so that it keeps its place in the draft", () => {
    const element = paneElement("p1", MESSAGE_BOX);
    document.body.append(element);
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const match = composer({ kind: "thread", threadId: "thr_a" });
    publishBridge({ panes: [pane("p1", "thr_a", true)], composers: [match] });
    const editor = editorIn(element);
    editor.focus();

    settleDomFocus();

    expect(focusPaneElement).not.toHaveBeenCalled();
    expect(match.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
  });

  it("leaves a cursor alone that is in a message box on a page without a pane element", () => {
    document.body.innerHTML = `<main>${MESSAGE_BOX}</main>`;
    const match = composer({ kind: "thread", threadId: "thr_a" });
    publishBridge({ panes: null, contextThreadId: "thr_a", composers: [match] });
    editorIn(document.body).focus();

    settleDomFocus();

    expect(focusPaneElement).not.toHaveBeenCalled();
    expect(match.focus).not.toHaveBeenCalled();
  });

  it.each([
    ["a button", '<button type="button">Model</button>', "button"],
    ["a picker button that is a combobox", '<button type="button" role="combobox">Mode</button>', "button"],
    ["a checkbox", '<input type="checkbox" />', "input"],
  ])("moves a cursor that is on %s of the message box into its text field", (_name, html, selector) => {
    const shell = MESSAGE_BOX.replace("</div></div>", `</div>${html}</div>`);
    const element = paneElement("p1", shell);
    document.body.append(element);
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const match = composer({ kind: "thread", threadId: "thr_a" });
    publishBridge({ panes: [pane("p1", "thr_a", true)], composers: [match] });
    const control = element.querySelector<HTMLElement>(selector);
    control?.focus();
    expect(document.activeElement).toBe(control);

    settleDomFocus();

    expect(focusPaneElement).toHaveBeenCalledWith(element);
    expect(match.focus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a multi-line field", "<textarea></textarea>", "textarea"],
    ["a one-line field", '<input type="text" />', "input"],
  ])("leaves a cursor alone that is in %s of the question form in the message box", (_name, html, selector) => {
    const shell = MESSAGE_BOX.replace("</div></div>", `</div>${html}</div>`);
    const element = paneElement("p1", shell);
    document.body.append(element);
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const match = composer({ kind: "thread", threadId: "thr_a" });
    publishBridge({ panes: [pane("p1", "thr_a", true)], composers: [match] });
    const field = element.querySelector<HTMLElement>(selector);
    field?.focus();

    settleDomFocus();

    expect(focusPaneElement).not.toHaveBeenCalled();
    expect(match.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
  });

  it("moves a cursor that is in the message box of another pane", () => {
    const element = paneElement("p1");
    const elsewhere = paneElement("p2", MESSAGE_BOX);
    document.body.append(element, elsewhere);
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const match = composer({ kind: "thread", threadId: "thr_a" });
    publishBridge({
      panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")],
      composers: [match],
    });
    editorIn(elsewhere).focus();

    settleDomFocus();

    expect(focusPaneElement).toHaveBeenCalledWith(element);
    expect(match.focus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the editor of a sent or queued message", INLINE_EDITOR],
    ["a composer in the side panel", SIDE_PANEL_CHAT],
  ])("moves a cursor that is in %s of the same pane", (_name, html) => {
    const element = paneElement("p1", html);
    document.body.append(element);
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const match = composer({ kind: "thread", threadId: "thr_a" });
    publishBridge({ panes: [pane("p1", "thr_a", true)], composers: [match] });
    editorIn(element).focus();

    settleDomFocus();

    expect(focusPaneElement).toHaveBeenCalledWith(element);
    expect(match.focus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a terminal", '<div data-app-terminal><textarea></textarea></div>', "textarea"],
    ["a button", '<button type="button">Run</button>', "button"],
  ])("moves a cursor that is in %s of the same pane", (_name, html, selector) => {
    const element = paneElement("p1", html);
    document.body.append(element);
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const match = composer({ kind: "thread", threadId: "thr_a" });
    publishBridge({ panes: [pane("p1", "thr_a", true)], composers: [match] });
    element.querySelector<HTMLElement>(selector)?.focus();

    settleDomFocus();

    expect(focusPaneElement).toHaveBeenCalledWith(element);
    expect(match.focus).toHaveBeenCalledTimes(1);
  });
});

describe("settleIdleDomFocus", () => {
  function publishThreadPane() {
    const element = paneElement("p1", '<button type="button">Run</button><textarea></textarea>');
    element.tabIndex = -1;
    document.body.append(element);
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const match = composer({ kind: "thread", threadId: "thr_a" });
    publishBridge({ panes: [pane("p1", "thr_a", true)], composers: [match] });
    return { element, match };
  }

  it("puts a cursor that is on the pane itself into the message box", () => {
    const { element, match } = publishThreadPane();
    element.focus();

    settleIdleDomFocus();

    expect(focusPaneElement).toHaveBeenCalledWith(element);
    expect(match.focus).toHaveBeenCalledTimes(1);
  });

  it("does the same for a cursor that is on nothing", () => {
    const { element, match } = publishThreadPane();
    expect(document.activeElement).toBe(document.body);

    settleIdleDomFocus();

    expect(focusPaneElement).toHaveBeenCalledWith(element);
    expect(match.focus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a button", "button"],
    ["a text field", "textarea"],
  ])("leaves a cursor alone that something else has put on %s", (_name, selector) => {
    const { element, match } = publishThreadPane();
    element.querySelector<HTMLElement>(selector)?.focus();

    settleIdleDomFocus();

    expect(focusPaneElement).not.toHaveBeenCalled();
    expect(match.focus).not.toHaveBeenCalled();
  });

  it("leaves the cursor to a pane move that has not settled yet", () => {
    const { element, match } = publishThreadPane();
    element.focus();
    settleDomFocusWhen(() => false);

    settleIdleDomFocus();

    expect(focusPaneElement).not.toHaveBeenCalled();
    expect(match.focus).not.toHaveBeenCalled();
  });

  it.each([
    ["the thread chooser", { chooser: { open: true, placement: "replace" } } as const],
    ["the key help", { helpOpen: true }],
  ])("leaves the cursor to %s, which is about to take it", (_name, patch) => {
    const { element, match } = publishThreadPane();
    element.focus();
    updateUiState(patch);

    settleIdleDomFocus();

    expect(focusPaneElement).not.toHaveBeenCalled();
    expect(match.focus).not.toHaveBeenCalled();
  });
});

describe("showsNewThreadScreen", () => {
  const SECONDARY = '<div data-app-composer data-app-composer-role="secondary"></div>';

  it.each([
    ["a message box", '<div data-app-composer data-app-composer-role="primary"></div>', true],
    ["a message box without a role", "<div data-app-composer></div>", true],
    ["the chat that a plugin page embeds", SECONDARY, false],
    ["a plugin page without a chat", "<p>plugin page</p>", false],
    ["a message box next to an editor of a sent message", `${SECONDARY}<div data-app-composer></div>`, true],
  ])("is %j for a pane with %s", (_name, html, expected) => {
    vi.mocked(getPaneElementById).mockReturnValue(paneElement("p2", html));

    expect(showsNewThreadScreen(pane("p2", null))).toBe(expected);
  });

  it("is false for a pane that the page does not show", () => {
    expect(showsNewThreadScreen(pane("p2", null))).toBe(false);
  });
});

describe("settleDomFocusWhen", () => {
  it("places the cursor with the function it is given once it is ready, and with the message box at the time limit", () => {
    const place = vi.fn();
    let isReady = false;
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });

    settleDomFocusWhen(() => isReady, undefined, place);
    isReady = true;
    runFrame();
    expect(place).toHaveBeenCalledTimes(1);
    expect(focusPaneElement).not.toHaveBeenCalled();

    settleDomFocusWhen(() => false, 500, place);
    vi.advanceTimersByTime(500);
    expect(place).toHaveBeenCalledTimes(1);
    expect(focusPaneElement).toHaveBeenCalledTimes(1);
  });

  describe("while the thread chooser or the key help is open", () => {
    it.each([
      ["the thread chooser", { chooser: { open: true, placement: "replace" } } as const],
      ["the key help", { helpOpen: true }],
    ])("leaves the cursor in %s and owes it to the pane", (_name, opened) => {
      const after = composer({ kind: "thread", threadId: "thr_b" });
      publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)], composers: [after] });
      settleDomFocusWhen(() => true);
      updateUiState(opened);

      runFrame();

      expect(focusPaneElement).not.toHaveBeenCalled();
      expect(after.focus).not.toHaveBeenCalled();
      expect(takeOwedSettle()).toBe(true);
      expect(takeOwedSettle()).toBe(false);
    });

    it("does the same at the time limit", () => {
      publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
      settleDomFocusWhen(() => false);
      updateUiState({ helpOpen: true });

      vi.advanceTimersByTime(1000);

      expect(focusPaneElement).not.toHaveBeenCalled();
      expect(takeOwedSettle()).toBe(true);
    });

    it("owes nothing after a wait that ended without a dialog", () => {
      publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
      settleDomFocusWhen(() => true);

      runFrame();

      expect(focusPaneElement).toHaveBeenCalledTimes(1);
      expect(takeOwedSettle()).toBe(false);
    });

    it.each([
      ["a newer wait", () => settleDomFocusWhen(() => false)],
      ["a pane move", () => focusPane(pane("p2", "thr_b"))],
    ])("owes nothing any more once %s has started", (_name, start) => {
      publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
      settleDomFocusWhen(() => true);
      updateUiState({ helpOpen: true });
      runFrame();

      start();

      expect(takeOwedSettle()).toBe(false);
    });
  });

  it("puts the cursor into the message box of the pane that is focused once it is ready", () => {
    const element = paneElement("p2");
    const before = composer({ kind: "thread", threadId: "thr_a" });
    const after = composer({ kind: "thread", threadId: "thr_b" });
    publishBridge({
      panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")],
      composers: [before, after],
    });
    settleDomFocusWhen(() => getFocusedThreadId() === "thr_b");

    runFrame();
    expect(before.focus).not.toHaveBeenCalled();
    expect(after.focus).not.toHaveBeenCalled();

    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    publishBridge({
      panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)],
      composers: [before, after],
    });
    runFrame();

    expect(focusPaneElement).toHaveBeenCalledWith(element);
    expect(after.focus).toHaveBeenCalledTimes(1);
    expect(before.focus).not.toHaveBeenCalled();
  });

  it("asks bb once and does not watch the message box afterwards", () => {
    const element = paneElement("p1", '<div data-app-composer><div contenteditable="true" tabindex="0"></div></div>');
    document.body.append(element);
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    const match = composer({ kind: "thread", threadId: "thr_a" });
    publishBridge({ panes: [pane("p1", "thr_a", true)], composers: [match] });
    const listen = vi.spyOn(document, "addEventListener");

    settleDomFocusWhen(() => true);
    runFrame();
    element.querySelector<HTMLElement>("[contenteditable]")?.focus();
    vi.advanceTimersByTime(20000);
    runFrame();

    expect(match.focus).toHaveBeenCalledTimes(1);
    expect(focusPaneElement).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(element.querySelector("[contenteditable]"));
    expect(listen).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls each animation frame and settles once ready", () => {
    const isReady = vi.fn(() => false);
    settleDomFocusWhen(isReady);

    expect(isReady).not.toHaveBeenCalled();
    runFrame();
    runFrame();
    expect(isReady).toHaveBeenCalledTimes(2);
    expect(focusPaneElement).not.toHaveBeenCalled();

    isReady.mockReturnValue(true);
    runFrame();
    expect(focusPaneElement).toHaveBeenCalledTimes(1);

    runFrame();
    vi.advanceTimersByTime(5000);
    expect(isReady).toHaveBeenCalledTimes(3);
    expect(focusPaneElement).toHaveBeenCalledTimes(1);
  });

  it("settles anyway at the timeout and stops polling", () => {
    const isReady = vi.fn(() => false);
    settleDomFocusWhen(isReady, 400);

    runFrame();
    vi.advanceTimersByTime(399);
    expect(focusPaneElement).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(focusPaneElement).toHaveBeenCalledTimes(1);

    const pollsAtTimeout = isReady.mock.calls.length;
    runFrame();
    expect(isReady).toHaveBeenCalledTimes(pollsAtTimeout);
    expect(frames.size).toBe(0);
  });

  it("waits one second by default", () => {
    settleDomFocusWhen(() => false);
    vi.advanceTimersByTime(999);
    expect(focusPaneElement).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(focusPaneElement).toHaveBeenCalledTimes(1);
  });

  it("lets a newer call cancel an older pending one", () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => false);
    settleDomFocusWhen(older, 300);
    settleDomFocusWhen(newer, 600);

    runFrame();
    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300);
    expect(focusPaneElement).not.toHaveBeenCalled();

    newer.mockReturnValue(true);
    runFrame();
    expect(focusPaneElement).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled before it settles", () => {
    settleDomFocusWhen(() => true);
    cancelPendingFocus();

    runFrame();
    vi.advanceTimersByTime(5000);
    expect(focusPaneElement).not.toHaveBeenCalled();
  });

  it("returns a function that drops this wait and says that it was still on", () => {
    const stop = settleDomFocusWhen(() => true, 300);

    expect(stop()).toBe(true);
    expect(stop()).toBe(false);
    runFrame();
    vi.advanceTimersByTime(5000);

    expect(focusPaneElement).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a function that leaves a newer wait alone", () => {
    const stopOlder = settleDomFocusWhen(() => false, 300);
    const newer = vi.fn(() => true);
    settleDomFocusWhen(newer, 600);

    expect(stopOlder()).toBe(false);
    runFrame();

    expect(newer).toHaveBeenCalledTimes(1);
    expect(focusPaneElement).toHaveBeenCalledTimes(1);
  });

  it("returns a function that does nothing once the wait has settled", () => {
    const stop = settleDomFocusWhen(() => true);
    runFrame();
    settleDomFocusWhen(() => false, 600);

    expect(stop()).toBe(false);
    vi.advanceTimersByTime(600);

    expect(focusPaneElement).toHaveBeenCalledTimes(2);
  });
});

describe("focusPane", () => {
  it("activates the pane with bb's own pointer handler and does not navigate when that worked", () => {
    const target = pane("p2", "thr_b");
    const navigate = publishBridge({ panes: [pane("p1", "thr_a", true), target] });

    focusPane(target);
    expect(activatePaneByPointer).toHaveBeenCalledWith("p2");
    expect(focusPaneElement).not.toHaveBeenCalled();

    const navigateAfter = publishBridge({
      panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)],
    });
    runFrame();
    for (const calls of [navigate, navigateAfter]) {
      expect(calls.toThread).not.toHaveBeenCalled();
      expect(calls.toCompose).not.toHaveBeenCalled();
    }

    runFrame();
    expect(focusPaneElement).not.toHaveBeenCalled();

    const element = paneElement("p2");
    vi.mocked(getFocusedPaneElement).mockReturnValue(element);
    runFrame();
    expect(focusPaneElement).toHaveBeenCalledWith(element);
  });

  it("puts the cursor into the message box of the pane it moved to", () => {
    const target = pane("p2", "thr_b");
    const left = composer({ kind: "thread", threadId: "thr_a" });
    const entered = composer({ kind: "thread", threadId: "thr_b" });
    publishBridge({
      panes: [pane("p1", "thr_a", true), target],
      composers: [left, entered],
    });

    focusPane(target);
    publishBridge({
      panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)],
      composers: [left, entered],
    });
    runFrame();
    expect(entered.focus).not.toHaveBeenCalled();

    vi.mocked(getFocusedPaneElement).mockReturnValue(paneElement("p2"));
    runFrame();

    expect(entered.focus).toHaveBeenCalledTimes(1);
    expect(left.focus).not.toHaveBeenCalled();
  });

  it("stays on the pane it moved to when that pane has no message box", () => {
    const target = pane("p2", null);
    const pluginPane = paneElement("p2", "<p>plugin page</p>");
    vi.mocked(getPaneElementById).mockReturnValue(pluginPane);
    const left = composer({ kind: "thread", threadId: "thr_a" });
    publishBridge({ panes: [pane("p1", "thr_a", true), target], composers: [left] });

    focusPane(target);
    publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", null, true)], composers: [left] });
    vi.mocked(getFocusedPaneElement).mockReturnValue(pluginPane);
    runFrame();
    runFrame();

    expect(focusPaneElement).toHaveBeenCalledWith(pluginPane);
    expect(left.focus).not.toHaveBeenCalled();
  });

  it("falls back to navigate.toThread when the layout does not show the pane focused", () => {
    const target = pane("p2", "thr_b");
    const navigate = publishBridge({ panes: [pane("p1", "thr_a", true), target] });

    focusPane(target);
    expect(navigate.toThread).not.toHaveBeenCalled();
    runFrame();

    expect(navigate.toThread).toHaveBeenCalledWith("thr_b");
    expect(vi.mocked(activatePaneByPointer).mock.invocationCallOrder[0]).toBeLessThan(
      navigate.toThread.mock.invocationCallOrder[0],
    );
  });

  it("falls back to navigate.toCompose for the New thread pane", () => {
    const target = pane("p2", null);
    vi.mocked(getPaneElementById).mockReturnValue(
      paneElement("p2", "<div data-app-composer></div>"),
    );
    const navigate = publishBridge({ panes: [pane("p1", "thr_a", true), target] });

    focusPane(target);
    runFrame();

    expect(getPaneElementById).toHaveBeenCalledWith("p2");
    expect(navigate.toCompose).toHaveBeenCalledWith();
    expect(navigate.toThread).not.toHaveBeenCalled();
  });

  it("does not replace the focused pane with New thread when the target is a plugin pane that embeds a chat", () => {
    const target = pane("p2", null);
    vi.mocked(getPaneElementById).mockReturnValue(
      paneElement("p2", '<div data-app-composer data-app-composer-role="secondary"></div>'),
    );
    const navigate = publishBridge({ panes: [pane("p1", "thr_a", true), target] });

    focusPane(target);
    runFrame();

    expect(navigate.toCompose).not.toHaveBeenCalled();
    expect(getUiState().notice?.text).toBe("Could not move to that pane.");
  });

  it("does not replace the focused pane with New thread when the target is a plugin pane", () => {
    const target = pane("p2", null);
    vi.mocked(getPaneElementById).mockReturnValue(paneElement("p2", "<p>plugin page</p>"));
    const navigate = publishBridge({ panes: [pane("p1", "thr_a", true), target] });

    focusPane(target);
    runFrame();

    expect(navigate.toCompose).not.toHaveBeenCalled();
    expect(getUiState().notice?.text).toBe("Could not move to that pane.");
  });

  it("still settles DOM focus after the timeout when the pane never reports focus", () => {
    const target = pane("p2", "thr_b");
    publishBridge({ panes: [pane("p1", "thr_a", true), target] });

    focusPane(target);
    runFrame();
    vi.advanceTimersByTime(1000);

    expect(focusPaneElement).toHaveBeenCalledTimes(1);
  });

  it("drops the pending fallback of an older call", () => {
    const first = pane("p2", "thr_b");
    const second = pane("p3", "thr_c");
    const navigate = publishBridge({ panes: [pane("p1", "thr_a", true), first, second] });

    focusPane(first);
    focusPane(second);
    runFrame();

    expect(navigate.toThread).toHaveBeenCalledTimes(1);
    expect(navigate.toThread).toHaveBeenCalledWith("thr_c");
  });

  it("does not throw when the bridge disappears before the next frame", () => {
    const target = pane("p2", "thr_b");
    publishBridge({ panes: [pane("p1", "thr_a", true), target] });

    focusPane(target);
    setBridge(null);

    expect(() => runFrame()).not.toThrow();
  });
});
