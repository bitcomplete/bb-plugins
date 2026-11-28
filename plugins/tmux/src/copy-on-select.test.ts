// @vitest-environment jsdom
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUiState, resetStore, setBridge, updateUiState } from "./bridge";
import { copySelection, type CopyResult } from "./clipboard";
import { isCopyModeActive } from "./copy-mode";
import { mountCopyOnSelect } from "./copy-on-select";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import { tmuxConfigOf } from "./tmux-test-support";
import type { Bridge } from "./types";

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@get-bb/plugin-sdk/app")>()),
  experimental_copyToClipboard: vi.fn(),
}));
vi.mock("./clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clipboard")>()),
  copySelection: vi.fn(),
}));
vi.mock("./copy-mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./copy-mode")>()),
  isCopyModeActive: vi.fn(),
}));

// Mirrors bb 0.50.1 markup: ThreadScreen.tsx and bottom-anchored-scroll-body.tsx
// (thread window, scroller, sticky footer), ThreadTimelineRows.tsx (row list and
// the layer that holds the selection menu), SelectableMessageProse.tsx (message
// text) and TimelineSelectionMenu.tsx (a Radix popover, so role="dialog"). The
// sidebar and the buttons carry bb's select-none class: a press on them leaves
// the selection as it is.
const PAGE_HTML = `
  <div data-sidebar="sidebar" class="select-none">
    <span id="sidebar-text">Sidebar title</span>
    <a id="sidebar-row" href="/t/thr-2">Other thread</a>
  </div>
  <main>
    <div data-thread-window="">
      <div data-page-scroll-viewport="">
        <div class="relative">
          <div data-timeline-row-list="top-level">
            <div data-timeline-row-id="row-1">
              <div data-sidebar-swipe-selectable=""><p id="first">First message text</p></div>
              <button type="button" id="copy-message" class="select-none">Copy message</button>
            </div>
            <div data-timeline-row-id="row-2">
              <div data-sidebar-swipe-selectable=""><p id="second">Second message text</p><p id="blank">   </p></div>
            </div>
            <div data-timeline-row-id="row-3">
              <div data-app-terminal=""><span id="terminal-text">npm test output</span></div>
            </div>
            <div data-timeline-row-id="row-4">
              <div contenteditable="true"><p id="inline-editor">Edited message</p></div>
            </div>
          </div>
          <div class="pointer-events-none absolute inset-0">
            <div data-radix-popper-content-wrapper="">
              <div role="dialog" data-state="open" data-bb-portaled-overlay="">
                <button type="button" id="add-to-chat">Add to chat</button>
              </div>
            </div>
          </div>
        </div>
        <div data-scroll-footer="">
          <div data-app-composer="" data-app-composer-role="primary">
            <div contenteditable="true" role="textbox"><p id="draft">Draft message</p></div>
            <span id="composer-hint">Enter to send</span>
          </div>
        </div>
      </div>
    </div>
    <div data-sidebar-split-container="">
      <div data-thread-window="">
        <div data-page-scroll-viewport=""><p id="side-panel">Side panel thread text</p></div>
      </div>
    </div>
  </main>`;

let controller: AbortController;
let dispose: () => void;

// The plugin and copy on select are switched on in the settings of these
// tests unless a test says otherwise. tmuxText is the made-up tmux config of
// the test.
function setSettings(overrides: Partial<Settings> = {}, tmuxText = ""): void {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    enabled: true,
    copyOnSelect: "on",
    ...overrides,
  };
  setBridge({
    settings,
    tmux: tmuxConfigOf(tmuxText),
    layout: null,
    context: { projectId: null, threadId: null },
  } as unknown as Bridge);
}

function textOf(id: string): Text {
  const node = document.getElementById(id)?.firstChild;
  if (!(node instanceof Text)) throw new Error(`fixture text ${id} is missing`);
  return node;
}

function getSelection(): Selection {
  const selection = document.getSelection();
  if (selection === null) throw new Error("the document has no selection");
  return selection;
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`fixture element ${id} is missing`);
  return element;
}

function select(id: string, start = 0, end = textOf(id).length): void {
  const text = textOf(id);
  getSelection().setBaseAndExtent(text, start, text, end);
}

function selectAcross(fromId: string, toId: string): void {
  const to = textOf(toId);
  getSelection().setBaseAndExtent(textOf(fromId), 0, to, to.length);
}

function pressMouseDown(id = "first", init: MouseEventInit = {}): void {
  byId(id).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ...init }));
}

function pressMouseUp(init: MouseEventInit = {}, target: EventTarget = document.body): void {
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, ...init }));
}

async function releaseMouse(init: MouseEventInit = {}): Promise<void> {
  pressMouseUp(init);
  await vi.runAllTimersAsync();
}

// A drag: the button goes down on conversation text and the browser selects
// while the pointer moves. The button is still down when this returns.
function dragSelect(id: string, start?: number, end?: number): void {
  pressMouseDown();
  select(id, start, end);
}

function dragSelectAcross(fromId: string, toId: string): void {
  pressMouseDown();
  selectAcross(fromId, toId);
}

// The whole click, from the button going down on the element to the check
// that runs one task after it is released there.
async function click(id: string, init: MouseEventInit = {}): Promise<void> {
  pressMouseDown(id, init);
  pressMouseUp(init, byId(id));
  await vi.runAllTimersAsync();
}

// A selection that no mouse press of this test made: from the keyboard, from
// copy mode or from an earlier right click.
async function selectWithoutMouse(id: string, start?: number, end?: number): Promise<void> {
  select(id, start, end);
  await vi.runAllTimersAsync();
}

function noticeText(): string | null {
  return getUiState().notice?.text ?? null;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  document.body.innerHTML = PAGE_HTML;
  setSettings();
  vi.mocked(copySelection).mockResolvedValue("copied");
  vi.mocked(isCopyModeActive).mockReturnValue(false);
  controller = new AbortController();
  dispose = mountCopyOnSelect(controller.signal);
});

afterEach(() => {
  dispose();
  controller.abort();
  getSelection().removeAllRanges();
  vi.runAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
  resetStore();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("copy on select", () => {
  it("copies a finished mouse selection of conversation text and says so", async () => {
    dragSelect("first", 0, 5);

    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(1);
    expect(noticeText()).toBe("Selection copied");
  });

  it("waits one task after the mouse is released, so a double click is complete", async () => {
    dragSelect("first", 0, 5);

    pressMouseUp();

    expect(copySelection).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(copySelection).toHaveBeenCalledTimes(1);
  });

  it("copies what is selected when the wait is over, not what was selected at mouseup", async () => {
    dragSelect("first", 0, 5);
    pressMouseUp();
    getSelection().removeAllRanges();

    await vi.runAllTimersAsync();

    expect(copySelection).not.toHaveBeenCalled();
  });

  it("copies a selection that runs over several messages", async () => {
    dragSelectAcross("first", "second");

    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(1);
  });

  it("copies in a thread shown in the side panel", async () => {
    pressMouseDown("side-panel");
    select("side-panel");

    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(1);
  });

  it("copies while bb's own selection menu is open in the conversation", async () => {
    expect(document.querySelector('[role="dialog"][data-state="open"]')).not.toBeNull();
    dragSelect("second", 0, 6);

    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(1);
  });

  it("copies when the button is released outside the conversation", async () => {
    dragSelect("first", 0, 5);

    pressMouseUp({}, byId("sidebar-row"));
    await vi.runAllTimersAsync();

    expect(copySelection).toHaveBeenCalledTimes(1);
  });

  it("copies a selection that a Shift click stretched", async () => {
    await selectWithoutMouse("first", 0, 5);

    pressMouseDown("first", { shiftKey: true });
    select("first", 0, 9);
    await releaseMouse({ shiftKey: true });

    expect(copySelection).toHaveBeenCalledTimes(1);
  });

  it("copies the word of a double click, which the browser selects at the second press", async () => {
    pressMouseDown();
    getSelection().collapse(textOf("first"), 2);
    await releaseMouse();
    expect(copySelection).not.toHaveBeenCalled();

    pressMouseDown();
    select("first", 0, 5);
    pressMouseUp();
    await vi.advanceTimersByTimeAsync(0);

    expect(copySelection).toHaveBeenCalledTimes(1);
  });

  it("says when the copy failed", async () => {
    vi.mocked(copySelection).mockResolvedValue("failed");
    dragSelect("first", 0, 5);

    await releaseMouse();

    expect(noticeText()).toBe("Could not copy the selection");
  });

  it("says nothing when there turned out to be nothing to copy", async () => {
    vi.mocked(copySelection).mockResolvedValue("empty");
    dragSelect("first", 0, 5);

    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(1);
    expect(noticeText()).toBeNull();
  });
});

// The copy itself, not a stand-in for it: a selection that lies in one
// message goes to bb's own copy handler through the copy command, and any
// other is written by the plugin as the plain text that is selected.
describe("copy on select and the messages that the selection is in", () => {
  const sdkCopy = vi.mocked(experimental_copyToClipboard);
  let execCommand: ReturnType<typeof vi.fn<(commandId: string) => boolean>>;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("./clipboard")>("./clipboard");
    vi.mocked(copySelection).mockImplementation(actual.copySelection);
    sdkCopy.mockResolvedValue(true);
    execCommand = vi.fn<(commandId: string) => boolean>(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "execCommand");
  });

  it("leaves a mouse selection in one message to bb's copy handler", async () => {
    dragSelect("first", 0, 5);

    await releaseMouse();

    expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(sdkCopy).not.toHaveBeenCalled();
    expect(noticeText()).toBe("Selection copied");
  });

  it("writes a mouse selection that runs from one message into another itself, with all of the text that is selected", async () => {
    dragSelectAcross("first", "second");

    await releaseMouse();

    expect(execCommand).not.toHaveBeenCalled();
    expect(sdkCopy).toHaveBeenCalledTimes(1);
    const [{ text }] = sdkCopy.mock.calls[0];
    expect(text).toBe(getSelection().toString());
    expect(text).toContain("First message text");
    expect(text).toContain("Second message text");
    expect(noticeText()).toBe("Selection copied");
  });

  // As bb 0.50.1 draws a code block (markdown-preview.tsx): a header that
  // bb leaves out of a copy, and under it the code.
  it("copies nothing and says nothing for a drag in one message from the end of a paragraph to the start of the code under it, which selects blanks and the header of the code block", async () => {
    byId("blank").insertAdjacentHTML(
      "afterend",
      `<div><div data-clipboard-ignore=""><span>ts</span></div><pre><code id="code">const one = 1;</code></pre></div>`,
    );
    const second = textOf("second");
    pressMouseDown("second");
    getSelection().setBaseAndExtent(second, second.length, textOf("code"), 0);
    expect(getSelection().toString().trim()).toBe("ts");

    await releaseMouse();

    expect(execCommand).not.toHaveBeenCalled();
    expect(sdkCopy).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });

  it("leaves a paragraph that a triple click selected up to the start of the next row to bb's copy handler", async () => {
    const nextRow = document.querySelector('[data-timeline-row-id="row-3"]');
    if (nextRow === null) throw new Error("the fixture row is missing");
    pressMouseDown();
    getSelection().setBaseAndExtent(textOf("second"), 0, nextRow, 0);

    await releaseMouse();

    expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(sdkCopy).not.toHaveBeenCalled();
  });
});

// Chromium selects a paragraph up to the start of the next block on a triple
// click, so the selection ends in an element and not in a text node.
describe("copy on select with a selection that ends in an element", () => {
  it("copies a paragraph selected up to the start of the next message", async () => {
    pressMouseDown();
    getSelection().setBaseAndExtent(textOf("first"), 0, byId("second"), 0);

    await releaseMouse();

    expect(getSelection().focusNode).toBe(byId("second"));
    expect(copySelection).toHaveBeenCalledTimes(1);
  });

  it("copies a selection whose two ends are elements", async () => {
    const paragraph = byId("first");
    pressMouseDown();
    getSelection().setBaseAndExtent(paragraph, 0, paragraph, 1);

    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the selection ends at the start of the message box", async () => {
    const messageBox = byId("draft").closest("[data-app-composer]");
    if (messageBox === null) throw new Error("the message box is missing");
    pressMouseDown("second");
    getSelection().setBaseAndExtent(textOf("second"), 0, messageBox, 0);

    await releaseMouse();

    expect(copySelection).not.toHaveBeenCalled();
  });
});

describe("copy on select stays out of the way", () => {
  async function expectNoCopy(init: MouseEventInit = {}): Promise<void> {
    await releaseMouse(init);
    expect(copySelection).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  }

  it("does nothing until the settings are loaded", async () => {
    setBridge(null);
    dragSelect("first", 0, 5);
    await expectNoCopy();
  });

  it("does nothing while the plugin is switched off", async () => {
    setSettings({ enabled: false });
    dragSelect("first", 0, 5);
    await expectNoCopy();
  });

  it("does nothing while the copyOnSelect setting is off", async () => {
    setSettings({ copyOnSelect: "off" });
    dragSelect("first", 0, 5);
    await expectNoCopy();
  });

  it("follows the mouse option of tmux while the setting is auto: off in stock tmux", async () => {
    setSettings({ copyOnSelect: "auto" });
    dragSelect("first", 0, 5);
    await expectNoCopy();
  });

  it("follows the mouse option of tmux while the setting is auto: on when the tmux config turns it on", async () => {
    setSettings({ copyOnSelect: "auto" }, "set -g mouse on");
    dragSelect("first", 0, 5);
    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(1);
  });

  it("copies with the setting on, and does not with the setting off, whatever the tmux config says", async () => {
    setSettings({ copyOnSelect: "off" }, "set -g mouse on");
    dragSelect("first", 0, 5);
    await expectNoCopy();

    setSettings({ copyOnSelect: "on" }, "set -g mouse off");
    dragSelect("second", 0, 6);
    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(1);
  });

  it("reads the settings when the wait is over", async () => {
    dragSelect("first", 0, 5);
    pressMouseUp();
    setSettings({ copyOnSelect: "off" });

    await vi.runAllTimersAsync();

    expect(copySelection).not.toHaveBeenCalled();
  });

  it("does nothing while the plugin is paused", async () => {
    updateUiState({ paused: true });
    dragSelect("first", 0, 5);
    await expectNoCopy();
  });

  it("does nothing while copy mode is active", async () => {
    vi.mocked(isCopyModeActive).mockReturnValue(true);
    dragSelect("first", 0, 5);
    await expectNoCopy();
  });

  it("ignores the other mouse buttons", async () => {
    pressMouseDown("first", { button: 1 });
    select("first", 0, 5);
    await expectNoCopy({ button: 1 });
    pressMouseDown("first", { button: 2 });
    select("first", 0, 9);
    await expectNoCopy({ button: 2 });
  });

  it("does nothing without a selection", async () => {
    pressMouseDown();
    await expectNoCopy();
  });

  it("does nothing for a collapsed selection", async () => {
    pressMouseDown();
    getSelection().collapse(textOf("first"), 3);
    await expectNoCopy();
  });

  it("does nothing for a selection of nothing but white space", async () => {
    dragSelect("blank");
    await expectNoCopy();
  });

  it("does nothing for a selection with more than one range", async () => {
    dragSelect("first", 0, 5);
    vi.spyOn(getSelection(), "rangeCount", "get").mockReturnValue(2);
    await expectNoCopy();
  });

  it("does nothing for text outside a conversation", async () => {
    dragSelect("sidebar-text");
    await expectNoCopy();
  });

  it("does nothing when the selection starts outside the conversation", async () => {
    dragSelectAcross("sidebar-text", "first");
    await expectNoCopy();
  });

  it("does nothing when the selection ends outside the conversation text", async () => {
    dragSelectAcross("second", "composer-hint");
    await expectNoCopy();
  });

  it("does nothing in the message box", async () => {
    dragSelect("draft");
    await expectNoCopy();
  });

  it("does nothing on a part of the message box that takes no typing", async () => {
    dragSelect("composer-hint");
    await expectNoCopy();
  });

  it("does nothing in an editable element of the conversation", async () => {
    dragSelect("inline-editor");
    await expectNoCopy();
  });

  it("does nothing in a terminal", async () => {
    dragSelect("terminal-text");
    await expectNoCopy();
  });

  it("does nothing in a dialog", async () => {
    dragSelect("add-to-chat");
    await expectNoCopy();
  });
});

// The copy belongs to the mouse press that made the selection. A selection
// that was already there is not copied by a later click on a part of bb that
// leaves it alone, which is what bb's select-none class does for the sidebar,
// the page headers and the buttons.
describe("copy on select and a selection that the press did not make", () => {
  async function expectNoCopy(): Promise<void> {
    expect(copySelection).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  }

  it("does nothing for a release that no press in the conversation started", async () => {
    await selectWithoutMouse("first", 0, 5);

    await releaseMouse();

    await expectNoCopy();
  });

  it.each(["sidebar-row", "sidebar-text"])(
    "does nothing on a click in the sidebar (%s) while conversation text is selected",
    async (id) => {
      await selectWithoutMouse("first", 0, 5);

      await click(id);

      expect(getSelection().toString()).toBe("First");
      await expectNoCopy();
    },
  );

  it("does nothing on a click on a button of the conversation that keeps the selection", async () => {
    await selectWithoutMouse("first", 0, 5);

    await click("copy-message");

    expect(getSelection().toString()).toBe("First");
    await expectNoCopy();
  });

  it("does nothing for the word a right click selects, nor on the next click in the sidebar", async () => {
    pressMouseDown("first", { button: 2 });
    select("first", 0, 5);
    byId("first").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
    await releaseMouse({ button: 2 });
    await expectNoCopy();

    await click("sidebar-row");

    expect(getSelection().toString()).toBe("First");
    await expectNoCopy();
  });

  it("does nothing for the word a Ctrl click selects on macOS, where it opens the context menu", async () => {
    pressMouseDown("first", { ctrlKey: true });
    select("first", 0, 5);
    byId("first").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, button: 0, ctrlKey: true }),
    );

    await releaseMouse({ ctrlKey: true });

    await expectNoCopy();
  });

  it("does nothing on a later click for a selection made while the keys were paused", async () => {
    updateUiState({ paused: true });
    dragSelect("first", 0, 5);
    await releaseMouse();
    updateUiState({ paused: false });

    await click("copy-message");
    await click("sidebar-row");

    await expectNoCopy();
  });

  it("does nothing on a later click for a selection made while copyOnSelect was off", async () => {
    setSettings({ copyOnSelect: "off" });
    dragSelect("first", 0, 5);
    await releaseMouse();
    setSettings({ copyOnSelect: "on" });

    await click("copy-message");
    await releaseMouse();

    await expectNoCopy();
  });

  it("does nothing on a later click for a selection made before the settings were loaded", async () => {
    setBridge(null);
    dragSelect("first", 0, 5);
    await releaseMouse();
    setSettings();

    await click("copy-message");

    await expectNoCopy();
  });

  it("does nothing for a copy mode selection when the button is pressed on bb's menu and released beside it", async () => {
    await selectWithoutMouse("second", 0, 6);

    pressMouseDown("add-to-chat");
    pressMouseUp({}, byId("second"));
    await vi.runAllTimersAsync();

    expect(getSelection().toString()).toBe("Second");
    await expectNoCopy();
  });

  it("copies the next selection that a press in the conversation makes", async () => {
    setSettings({ copyOnSelect: "off" });
    dragSelect("first", 0, 5);
    await releaseMouse();
    setSettings({ copyOnSelect: "on" });

    dragSelect("second", 0, 6);
    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(1);
  });
});

describe("copy on select and an unchanged selection", () => {
  it("does not copy again on a later click that leaves the selection as it was", async () => {
    dragSelect("first", 0, 5);
    await releaseMouse();
    updateUiState({ notice: null });

    await click("add-to-chat");
    await click("copy-message");

    expect(copySelection).toHaveBeenCalledTimes(1);
    expect(noticeText()).toBeNull();
  });

  it("copies again once the selection has changed", async () => {
    dragSelect("first", 0, 5);
    await releaseMouse();

    dragSelect("first", 0, 9);
    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(2);
  });

  it("copies again when the same text is selected anew", async () => {
    dragSelect("first", 0, 5);
    await releaseMouse();

    pressMouseDown("second");
    getSelection().collapse(textOf("second"), 0);
    await releaseMouse();
    dragSelect("first", 0, 5);
    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(2);
  });

  it("copies again when a drag ends on the very selection it started from", async () => {
    dragSelect("first", 0, 5);
    await releaseMouse();

    pressMouseDown();
    getSelection().collapse(textOf("first"), 0);
    await vi.advanceTimersByTimeAsync(0);
    select("first", 0, 5);
    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(2);
  });

  it("does not try again after a failed copy until the selection changes", async () => {
    vi.mocked(copySelection).mockResolvedValue("failed");
    dragSelect("first", 0, 5);
    await releaseMouse();

    await click("copy-message");
    await releaseMouse();

    expect(copySelection).toHaveBeenCalledTimes(1);
  });
});

describe("copy on select disposal", () => {
  it("stops listening when disposed, and can be disposed twice", async () => {
    dispose();
    dispose();
    dragSelect("first", 0, 5);

    await releaseMouse();

    expect(copySelection).not.toHaveBeenCalled();
  });

  it("drops a copy that was still waiting when it was disposed", async () => {
    dragSelect("first", 0, 5);
    pressMouseUp();
    dispose();

    await vi.runAllTimersAsync();

    expect(copySelection).not.toHaveBeenCalled();
  });

  it("stops listening when the signal aborts", async () => {
    dragSelect("first", 0, 5);
    pressMouseUp();
    controller.abort();
    await vi.runAllTimersAsync();

    dragSelect("first", 0, 9);
    await releaseMouse();

    expect(copySelection).not.toHaveBeenCalled();
  });

  it("removes its listeners from the document", () => {
    const removed = vi.spyOn(document, "removeEventListener");

    dispose();

    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual([
      "contextmenu",
      "mousedown",
      "mouseup",
      "selectionchange",
    ]);
  });

  it("does not listen at all for a signal that has already aborted", async () => {
    dispose();
    const aborted = new AbortController();
    aborted.abort();
    const added = vi.spyOn(document, "addEventListener");

    const disposeAborted = mountCopyOnSelect(aborted.signal);
    disposeAborted();

    expect(added).not.toHaveBeenCalled();
  });

  it("shows no notice for a copy that finishes after it was disposed", async () => {
    let finish: (result: CopyResult) => void = () => {};
    vi.mocked(copySelection).mockReturnValue(
      new Promise<CopyResult>((resolve) => {
        finish = resolve;
      }),
    );
    dragSelect("first", 0, 5);
    await releaseMouse();

    dispose();
    finish("copied");
    await vi.runAllTimersAsync();

    expect(copySelection).toHaveBeenCalledTimes(1);
    expect(noticeText()).toBeNull();
  });
});
