// @vitest-environment jsdom
import type { PluginSidebarSplitLayout } from "@get-bb/plugin-sdk/app";
// loadPluginApp of the SDK's test helpers hands out no palette commands, so the SDK's own collector reads them.
import { collectPluginAppRegistrations } from "@get-bb/plugin-sdk/internal/plugin-app-collector";
import { experimental_makePanelController } from "@get-bb/plugin-sdk/testing";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
  type MountedPluginContentScripts,
  type PluginSdkTestFakes,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findBinding,
  setKeybindings,
  type AppKeybinding,
} from "./src/bb-commands";
import {
  getBridge,
  getUiState,
  resetStore,
  setBridge,
  updateUiState,
} from "./src/bridge";
import {
  BB_COMMANDS,
  PLUGIN_LOCKS,
  PLUGIN_STORAGE_KEYS,
  SWITCHED_ON_ATTRIBUTE,
} from "./src/constants";
import { rpcContract } from "./src/contract";
import { CONFIG_FILE_CHANGED } from "./src/settings";
import { noteSidebarPointerDown } from "./src/dom-actions";
import { cancelPendingNewThread } from "./src/new-thread";
import {
  installFakeLocks,
  listenToLiveRegion,
  makeProject,
  makeThread,
  removeFakeLocks,
} from "./src/overlay/test-support";
import { cancelPendingFocus } from "./src/pane-focus";
import { resetPaneResize } from "./src/pane-resize";
import { VI_STYLE_CONFIG, tmuxConfigOf } from "./src/tmux-test-support";
import { resetThreadOrderCache } from "./src/thread-order";
import { stockTmuxConfig, type TmuxConfig } from "./src/tmux-keymap";

const app = await loadPluginApp(() => import("./app"));
const { default: definition } = await import("./app");
const commands = collectPluginAppRegistrations(definition).commandPaletteActions;

const IDLE_THREAD = {
  status: "idle",
  createdAt: 1,
  parentThreadId: null,
  isUnread: false,
} as const;

const THREADS = [
  makeThread("thr-1", {
    ...IDLE_THREAD,
    displayTitle: "Alpha",
    latestAttentionAt: 300,
  }),
  makeThread("thr-2", {
    ...IDLE_THREAD,
    displayTitle: "Beta",
    latestAttentionAt: 200,
  }),
  makeThread("thr-3", {
    ...IDLE_THREAD,
    displayTitle: "Gamma",
    latestAttentionAt: 100,
  }),
];

const PROJECTS = [makeProject("proj-1", "Website")];

const TWO_PANES: PluginSidebarSplitLayout = {
  panes: [
    {
      paneId: "pane-1",
      threadId: "thr-1",
      isFocused: true,
      rect: { x: 0, y: 0, width: 0.5, height: 1 },
    },
    {
      paneId: "pane-2",
      threadId: "thr-2",
      isFocused: false,
      rect: { x: 0.5, y: 0, width: 0.5, height: 1 },
    },
  ],
};

const THREAD_ROUTE = "/projects/proj-1/threads/thr-1";
const NEW_THREAD_ROUTE = "/";

// A copy of the bb 0.50.1 markup the plugin reads: the sidebar with its thread
// rows, two thread panes, a message box, a terminal and an unrelated text field.
const BB_PAGE = `
  <div data-variant="sidebar" data-state="expanded">
    <div data-sidebar="sidebar">
      <div data-testid="app-sidebar-body">
        <a href="/t/thr-1" data-sidebar-thread-shortcut-target data-sidebar-thread-id="thr-1">Alpha</a>
        <a href="/t/thr-2" data-sidebar-thread-shortcut-target data-sidebar-thread-id="thr-2">Beta</a>
        <a href="/t/thr-3" data-sidebar-thread-shortcut-target data-sidebar-thread-id="thr-3">Gamma</a>
      </div>
    </div>
  </div>
  <button data-sidebar="trigger" aria-expanded="true"></button>
  <main>
    <div data-split-pane-id="pane-1" data-focused="true" tabindex="-1">
      <button data-testid="close-pane" aria-label="Close pane"></button>
      <div data-thread-window>
        <div data-page-scroll-viewport></div>
        <div data-app-composer>
          <div data-testid="composer" contenteditable="true" role="textbox"></div>
        </div>
      </div>
      <div data-app-terminal>
        <textarea data-testid="terminal-input"></textarea>
      </div>
    </div>
    <div data-split-pane-id="pane-2" data-focused="false" tabindex="-1">
      <div data-thread-window>
        <div data-page-scroll-viewport></div>
      </div>
    </div>
  </main>
  <textarea data-testid="notes"></textarea>
`;

const PLAIN_KEYS = [
  "j",
  "k",
  "g",
  "G",
  "/",
  ":",
  "H",
  "L",
  "i",
  " ",
  ",",
  "f",
  "e",
  "1",
  "?",
  "v",
  "s",
  "x",
  "Enter",
  "Escape",
  "Backspace",
  "Tab",
  "ArrowLeft",
  "o",
  "y",
  "q",
  "[",
  "PageUp",
];

const PLAIN_KEYS_BUT_I = PLAIN_KEYS.filter((key) => key !== "i");

const TYPING_CHORDS: KeyboardEventInit[] = [
  { key: "d", ctrlKey: true },
  { key: "u", ctrlKey: true },
  { key: "c", ctrlKey: true },
  { key: "k", metaKey: true },
  { key: "ArrowLeft", altKey: true },
];

const HJKL = ["h", "j", "k", "l"];

// One message of the agent of one line, as ThreadTimelineRows.tsx lays it out
// inside the conversation scroller: ConversationMessageContent.tsx puts its
// text into the element of SelectableMessageProse.tsx, which is what bb's
// copy handler answers for.
function messageRow(index: number, text: string): string {
  return `<div data-timeline-row-id="row-${index}"><div data-message-column=""><div data-sidebar-swipe-selectable=""><p data-testid="line-${index}">${text}</p></div></div></div>`;
}

// Three messages of one line each.
const CONVERSATION = `
  <div data-timeline-row-list="top-level">
    ${messageRow(1, "alpha beta gamma")}
    ${messageRow(2, "delta epsilon")}
    ${messageRow(3, "zeta eta theta")}
  </div>
`;

// Nine messages of one line each, enough to tell the top, the middle and the
// bottom of the view apart.
const LONG_CONVERSATION = `
  <div data-timeline-row-list="top-level">
    ${["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
      .map((word, index) => messageRow(index + 1, `message ${word}`))
      .join("")}
  </div>
`;

// bb's "Add to chat" menu as TimelineSelectionMenu.tsx renders it: a Radix
// popover shown next to selected text. In a conversation it sits inside the
// scroller. For the terminal, a file preview and the diff view it sits on the
// page body.
const BB_SELECTION_MENU = `
  <div data-radix-popper-content-wrapper="">
    <div role="dialog" data-state="open" data-bb-portaled-overlay="">
      <button type="button" data-testid="add-to-chat">Add to chat</button>
    </div>
  </div>
`;

// Another bb popover, as NotificationCenter.tsx renders it on the page body.
const BB_OTHER_POPOVER = `
  <div data-radix-popper-content-wrapper="">
    <div role="dialog" data-state="open" data-bb-portaled-overlay="" aria-label="Notifications">
      <button type="button">Mark all as read</button>
    </div>
  </div>
`;

const NOTHING_SELECTED_NOTICE =
  "Nothing is selected. Start a selection and move the cursor, then copy";

const CHAR_WIDTH = 8;
const LINE_HEIGHT = 20;
const TEXT_LEFT = 40;
const FIRST_LINE_TOP = 100;
const COPIED_NOTICE = "Selection copied";

// Where the first line of the conversation is on screen. It stays put unless
// a test lays the conversation out as a browser does, see scrollAsInABrowser.
let firstLineTop: () => number = () => FIRST_LINE_TOP;

let page: HTMLElement;
let view: RenderedSlot;
let settingValues: SettingValues | undefined;
let mounted: MountedPluginContentScripts;
let pageListeners: AbortController;
let threadsOpen: ReturnType<typeof vi.fn>;
let threadsPaneAction: ReturnType<typeof vi.fn>;
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;
let execCommand: ReturnType<typeof vi.fn<(command: string) => boolean>>;
let copiedTexts: string[];

function fixture(testId: string): HTMLElement {
  const element = page.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`fixture ${testId} is missing`);
  return element;
}

function sidebarRow(threadId: string): HTMLElement {
  const row = page.querySelector<HTMLElement>(
    `[data-sidebar-thread-id="${threadId}"]`,
  );
  if (row === null) throw new Error(`sidebar row ${threadId} is missing`);
  return row;
}

function pane(paneId: string): HTMLElement {
  const element = page.querySelector<HTMLElement>(
    `[data-split-pane-id="${paneId}"]`,
  );
  if (element === null) throw new Error(`pane ${paneId} is missing`);
  return element;
}

function focusedPaneViewport(): HTMLElement {
  const viewport = pane("pane-1").querySelector<HTMLElement>(
    "[data-page-scroll-viewport]",
  );
  if (viewport === null) throw new Error("the timeline viewport is missing");
  return viewport;
}

function press(
  init: KeyboardEventInit,
  target: EventTarget = document.body,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function pressKey(key: string, target?: EventTarget): KeyboardEvent {
  return press({ key }, target);
}

function pressCtrl(key: string, target?: EventTarget): KeyboardEvent {
  return press({ key, ctrlKey: true }, target);
}

// The prefix of these tests is Ctrl-a unless a test sets another.
function pressAfterPrefix(
  key: string,
  target?: EventTarget,
  prefixLetter = "a",
): KeyboardEvent {
  pressCtrl(prefixLetter, target);
  return pressKey(key, target);
}

function enterCopyMode(target?: EventTarget): void {
  expect(pressAfterPrefix("[", target).defaultPrevented).toBe(true);
}

// The test harness only counts how often the plugin asked bb to put the
// cursor in the message box. bb answers a moment later by putting it there.
function messageBoxRequests(): number {
  return view.inspection.composer.focusCount;
}

// The made-up tmux config that most of these tests run with: the config in
// the vi style of the test support, with a repeat time of one second and
// with resize keys that are bound with Shift held as well.
const TMUX_CONFIG = `${VI_STYLE_CONFIG}
set -g repeat-time 1000
bind -r M-H resize-pane -L 5
bind -r M-J resize-pane -D 5
bind -r M-K resize-pane -U 5
bind -r M-L resize-pane -R 5
`;

type SettingValues = Record<string, string | number | boolean>;

// settings: null stands for a bb that has no values for the plugin, which is
// what it reports while the server part of the plugin is not running. The
// plugin is off until its Enable setting is turned on, so these tests turn
// it on unless the settings of a test turn it off. asInstalled stands for a
// plugin whose settings nobody has changed. The prefix is Ctrl-a, which the
// made-up tmux config sets, unless a test sets another.
// tmuxConfig is the text of the tmux config that the server reads, and null
// stands for a machine that has none. tmuxServer answers in its place.
interface OverlayOptions {
  layout?: PluginSidebarSplitLayout | null;
  contextThreadId?: string | null;
  composerThreadId?: string;
  settings?: SettingValues | null;
  asInstalled?: boolean;
  keybindings?: readonly AppKeybinding[];
  tmuxConfig?: string | null;
  tmuxServer?: () => Promise<TmuxConfig>;
}

function settingValuesFor(options: OverlayOptions): SettingValues | undefined {
  if (options.settings === null) return undefined;
  if (options.asInstalled) return {};
  return { enabled: true, ...options.settings };
}

function answerFor(text: string | null | undefined): TmuxConfig {
  if (text === null) return stockTmuxConfig();
  return tmuxConfigOf(text ?? TMUX_CONFIG);
}

function renderOverlay(options: OverlayOptions = {}): void {
  const layout = options.layout === undefined ? TWO_PANES : options.layout;
  const contextThreadId =
    options.contextThreadId === undefined ? "thr-1" : options.contextThreadId;
  const keybindings = options.keybindings ?? [];
  settingValues = settingValuesFor(options);
  threadsOpen = vi.fn(async () => ({ delivered: 1 }));
  threadsPaneAction = vi.fn(async () => ({ delivered: 1 }));
  const sdk = {
    system: { config: async () => ({ keybindings }) },
    subscribe: () => () => {},
    threads: { open: threadsOpen, paneAction: threadsPaneAction },
  } as unknown as PluginSdkTestFakes;
  view = renderSlot(
    app.appOverlays[0],
    {},
    {
      sidebarThreads: { threads: THREADS, projects: PROJECTS },
      sidebarSplitLayout: layout ?? undefined,
      context: { projectId: "proj-1", threadId: contextThreadId },
      composer: {
        scope: { kind: "thread", threadId: options.composerThreadId ?? "thr-1" },
      },
      settings: settingValues,
      sdk,
      experimental_rpcContract: rpcContract,
      rpc: {
        tmuxConfig:
          options.tmuxServer ?? (async () => answerFor(options.tmuxConfig)),
      },
    },
  );
}

// A server that answers the question about the tmux config when the test
// says so.
function tmuxServer() {
  let answer: (value: TmuxConfig) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const pending = new Promise<TmuxConfig>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  return {
    tmuxConfig: () => pending,
    answer: (value: TmuxConfig) => act(async () => answer(value)),
    fail: (error: Error) => act(async () => fail(error)),
  };
}

function helpPrefixLine(): string | null {
  const help = screen.getByRole("dialog", { name: "Tmux keys" });
  return within(help).getByText(/^Prefix: /).textContent;
}

function storedSnapshot(): { savedAt: number } | null {
  const raw = window.localStorage.getItem(PLUGIN_STORAGE_KEYS.layoutSnapshot);
  return raw === null ? null : JSON.parse(raw);
}

async function mountContentScripts(): Promise<void> {
  mounted = await mountPluginContentScripts(app, { pluginId: "tmux" });
}

// The overlay publishes the keys once the server has answered about the tmux
// config, which is a moment after it is drawn.
async function renderOverlayWithKeys(options: OverlayOptions = {}): Promise<void> {
  renderOverlay(options);
  await act(async () => {});
}

async function mountPlugin(options: OverlayOptions = {}): Promise<void> {
  await renderOverlayWithKeys(options);
  await mountContentScripts();
}

// What bb does when a setting is changed while the window is open: the page
// is handed the new values and draws the overlay again. The test harness
// hands the overlay the values object it was given, so the new values are
// written into that object.
async function changeSettings(values: SettingValues): Promise<void> {
  if (settingValues === undefined) {
    throw new Error("bb has no values for the settings");
  }
  Object.assign(settingValues, values);
  const Overlay = app.appOverlays[0].component;
  view.lifecycle.rerender(<Overlay />);
  await act(async () => {});
}

// The test harness cannot change the layout after a navigation the way bb
// does, so the new layout is published straight into the bridge.
function bbFocusesThread(threadId: string): void {
  const bridge = getBridge();
  if (bridge === null) throw new Error("the bridge was not published");
  const showsThread = bridge.layout?.panes.some(
    (layoutPane) => layoutPane.threadId === threadId,
  );
  const panes = bridge.layout?.panes.map((layoutPane) => {
    if (showsThread) {
      return { ...layoutPane, isFocused: layoutPane.threadId === threadId };
    }
    return layoutPane.isFocused ? { ...layoutPane, threadId } : layoutPane;
  });
  setBridge({
    ...bridge,
    context: { ...bridge.context, threadId },
    layout: panes === undefined ? null : { panes },
  });
  for (const layoutPane of panes ?? []) {
    pane(layoutPane.paneId).setAttribute(
      "data-focused",
      String(layoutPane.isFocused),
    );
  }
}

// As above: the layout bb has once it opened the thread in a new pane and
// focused that pane.
function bbOpensPane(threadId: string): void {
  const bridge = getBridge();
  if (bridge === null) throw new Error("the bridge was not published");
  const panes = (bridge.layout?.panes ?? []).map((layoutPane) => ({
    ...layoutPane,
    isFocused: false,
  }));
  const newPane = {
    paneId: "pane-new",
    threadId,
    isFocused: true,
    rect: { x: 0, y: 0.5, width: 1, height: 0.5 },
  };
  setBridge({
    ...bridge,
    context: { ...bridge.context, threadId },
    layout: { panes: [...panes, newPane] },
  });
}

// As above: the layout bb has once the focused pane shows the New thread
// screen in place of its thread.
function bbShowsNewThreadScreenInFocusedPane(): void {
  const bridge = getBridge();
  if (bridge === null) throw new Error("the bridge was not published");
  const panes = (bridge.layout?.panes ?? []).map((layoutPane) =>
    layoutPane.isFocused ? { ...layoutPane, threadId: null } : layoutPane,
  );
  setBridge({
    ...bridge,
    context: { ...bridge.context, threadId: null },
    layout: { panes },
  });
}

function afterFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = (left: number): void => {
      if (left === 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => tick(left - 1));
    };
    tick(count);
  });
}

function clickWithMouse(element: HTMLElement): void {
  element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  element.focus();
}

function bbShortcut(command: string, key: string): AppKeybinding {
  return {
    command,
    desktopOnly: false,
    shortcut: {
      key,
      mod: false,
      meta: false,
      control: false,
      alt: true,
      shift: false,
    },
    when: { all: [], none: [] },
  };
}

// Stands in for bb's own shortcut handler: it claims the Alt shortcut of each
// binding, as bb does for a command it ran, and records the command id.
function listenForBbShortcuts(bindings: readonly AppKeybinding[]): string[] {
  const ran: string[] = [];
  window.addEventListener(
    "keydown",
    (event) => {
      const binding = bindings.find(
        ({ shortcut }) => event.altKey && event.key === shortcut.key,
      );
      if (binding === undefined) return;
      event.preventDefault();
      ran.push(binding.command);
    },
    { signal: pageListeners.signal },
  );
  return ran;
}

async function mountPluginWithBbShortcuts(
  bindings: readonly AppKeybinding[],
): Promise<string[]> {
  await mountPlugin({ keybindings: bindings });
  await waitFor(() =>
    expect(findBinding(bindings[0].command)).not.toBeNull(),
  );
  return listenForBbShortcuts(bindings);
}

function onEvent(element: HTMLElement, type: string): ReturnType<typeof vi.fn> {
  const listener = vi.fn();
  element.addEventListener(type, listener, { signal: pageListeners.signal });
  return listener;
}

async function runCommand(id: string): Promise<void> {
  const command = commands.find((candidate) => candidate.id === id);
  if (command?.target !== "app") throw new Error(`no app command ${id}`);
  await act(async () => {
    await command.run({
      threadId: "thr-1",
      projectId: "proj-1",
      experimental_panel: experimental_makePanelController(),
    });
  });
}

function chooserList(): HTMLElement {
  return screen.getByRole("listbox", { name: "Threads" });
}

function pageSelection(): Selection {
  const selection = document.getSelection();
  if (selection === null) throw new Error("the document has no selection");
  return selection;
}

function lineText(testId: string): Text {
  const text = fixture(testId).firstChild;
  if (!(text instanceof Text)) throw new Error(`line ${testId} has no text`);
  return text;
}

function conversationLines(): Text[] {
  const lines = focusedPaneViewport().querySelectorAll("[data-timeline-row-id] p");
  return Array.from(lines, (line) => line.firstChild).filter(
    (node): node is Text => node instanceof Text,
  );
}

// jsdom has no layout, so every message is one line of fixed-width characters.
function fakeClientRects(this: Range): DOMRect[] {
  const index = conversationLines().indexOf(this.startContainer as Text);
  if (index === -1) return [];
  const length =
    this.endContainer === this.startContainer
      ? this.endOffset - this.startOffset
      : 0;
  return [
    new DOMRect(
      TEXT_LEFT + this.startOffset * CHAR_WIDTH,
      firstLineTop() + index * LINE_HEIGHT,
      length * CHAR_WIDTH,
      LINE_HEIGHT,
    ),
  ];
}

function fakeCaretPositionFromPoint(
  x: number,
  y: number,
): { offsetNode: Node; offset: number } | null {
  if (y < firstLineTop()) return null;
  const line = conversationLines()[Math.floor((y - firstLineTop()) / LINE_HEIGHT)];
  if (line === undefined) return null;
  const offset = Math.round((x - TEXT_LEFT) / CHAR_WIDTH);
  return { offsetNode: line, offset: Math.min(line.length, Math.max(0, offset)) };
}

function wordSpans(line: Text): { start: number; end: number }[] {
  return Array.from(line.data.matchAll(/\S+/g), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

// As macOS does it: forward to the end of a word, backward to its start.
function wordStep(line: Text, offset: number, step: 1 | -1): number | null {
  const words = wordSpans(line);
  if (step === 1) return words.find((word) => word.end > offset)?.end ?? null;
  return words.filter((word) => word.start < offset).at(-1)?.start ?? null;
}

// Stands in for the browser's Selection.modify. Every message is one line and
// one paragraph. A step that has nowhere to go does nothing, as in a browser.
function fakeModify(
  this: Selection,
  _alter?: string,
  direction?: string,
  granularity?: string,
): void {
  const lines = conversationLines();
  const index = lines.indexOf(this.focusNode as Text);
  if (index === -1) return;
  const line = lines[index];
  const step = direction === "forward" || direction === "right" ? 1 : -1;
  const next = lines[index + step];
  if (granularity === "character") {
    const offset = this.focusOffset + step;
    if (offset >= 0 && offset <= line.length) this.extend(line, offset);
    return;
  }
  if (granularity === "word") {
    const offset = wordStep(line, this.focusOffset, step);
    if (offset !== null) this.extend(line, offset);
    return;
  }
  if (granularity === "lineboundary" || granularity === "paragraphboundary") {
    this.extend(line, step === 1 ? line.length : 0);
    return;
  }
  if (granularity === "paragraph") {
    if (next !== undefined) this.extend(next, 0);
    return;
  }
  if (granularity !== "line") {
    throw new Error(`the fake browser does not move by ${granularity}`);
  }
  if (next !== undefined) this.extend(next, Math.min(this.focusOffset, next.length));
}

function define(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    value,
  });
}

// What jsdom lacks for selecting and copying: Selection.modify, the lookup of
// text at a point, the rectangles of a range and the copy command.
function installBrowserFakes(): void {
  const viewport = focusedPaneViewport();
  viewport.innerHTML = CONVERSATION;
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 400);
  copiedTexts = [];
  execCommand = vi.fn((_command: string) => {
    copiedTexts.push(pageSelection().toString());
    return true;
  });
  define(Selection.prototype, "modify", fakeModify);
  define(Range.prototype, "getClientRects", fakeClientRects);
  define(document, "caretPositionFromPoint", fakeCaretPositionFromPoint);
  define(document, "execCommand", execCommand);
}

// A conversation of one-line messages in a view of the given height, laid out
// as a browser does: the lines move with the scroll position, and the view
// does not scroll past the first or the last line. It starts at the bottom.
function scrollAsInABrowser(lineCount: number, viewHeight: number): HTMLElement {
  const viewport = focusedPaneViewport();
  const rows = Array.from({ length: lineCount }, (_, index) =>
    messageRow(index + 1, `message ${index + 1}`),
  );
  viewport.innerHTML = `<div data-timeline-row-list="top-level">${rows.join("")}</div>`;
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, viewHeight);
  const maxScrollTop = lineCount * LINE_HEIGHT - viewHeight;
  define(viewport, "scrollBy", ({ top = 0 }: ScrollToOptions) => {
    viewport.scrollTop = Math.min(maxScrollTop, Math.max(0, viewport.scrollTop + top));
  });
  firstLineTop = () => -viewport.scrollTop;
  viewport.scrollTop = maxScrollTop;
  return viewport;
}

function removeBrowserFakes(): void {
  firstLineTop = () => FIRST_LINE_TOP;
  pageSelection().removeAllRanges();
  Reflect.deleteProperty(Selection.prototype, "modify");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(document, "caretPositionFromPoint");
  Reflect.deleteProperty(document, "execCommand");
}

function cursorPlace(): string {
  const { focusNode, focusOffset } = pageSelection();
  return `${focusNode?.parentElement?.dataset.testid ?? "nowhere"}:${focusOffset}`;
}

function cursorBlock(): Record<"left" | "top" | "width" | "height", string> {
  const { left, top, width, height } = screen.getByTestId("copy-cursor").style;
  return { left, top, width, height };
}

function modePill(): string | null {
  return screen.queryByRole("status")?.textContent ?? null;
}

function showBbSelectionMenu(): HTMLElement {
  focusedPaneViewport().insertAdjacentHTML("beforeend", BB_SELECTION_MENU);
  return fixture("add-to-chat");
}

// What bb does when its pane shows another thread: PageShell is keyed by the
// thread id in ThreadScreen.tsx, so the scroller is a new element.
function bbShowsAnotherThread(): HTMLElement {
  const fresh = document.createElement("div");
  fresh.setAttribute("data-page-scroll-viewport", "");
  fresh.innerHTML = LONG_CONVERSATION;
  fresh.getBoundingClientRect = () => new DOMRect(0, 0, 800, 400);
  focusedPaneViewport().replaceWith(fresh);
  return fresh;
}

// The browser's record of whether the window was clicked or typed in since it
// loaded (navigator.userActivation), which jsdom does not have.
function setWindowUsed(hasBeenActive: boolean): void {
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { hasBeenActive, isActive: false },
  });
}

function pressPointer(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
}

function nextTask(): Promise<void> {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

function pressMouseOn(element: Element, init: MouseEventInit = {}): void {
  element.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, button: 0, ...init }),
  );
}

// The plugin reads the selection one task after the button is released.
async function releaseMouseOn(
  element: Element,
  init: MouseEventInit = {},
): Promise<void> {
  element.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, button: 0, ...init }),
  );
  await nextTask();
  await nextTask();
}

// A drag over the text: the button goes down on it, the browser selects, and
// the button is released.
async function selectWithMouse(
  text: Text,
  start: number,
  end: number,
): Promise<void> {
  const element = text.parentElement ?? document.body;
  pressMouseOn(element);
  pageSelection().setBaseAndExtent(text, start, text, end);
  await releaseMouseOn(element);
}

async function clickWithButton(element: Element): Promise<void> {
  pressMouseOn(element);
  await releaseMouseOn(element);
}

function chooserTitles(): (string | null)[] {
  return screen
    .getAllByRole("option")
    .map((option) => option.firstElementChild?.textContent ?? null);
}

beforeEach(() => {
  window.history.replaceState(null, "", THREAD_ROUTE);
  consoleError = vi.spyOn(console, "error");
  consoleWarn = vi.spyOn(console, "warn");
  // jsdom reports no window focus while an element is losing the cursor. A
  // browser reports it for as long as the window is the active one.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  pageListeners = new AbortController();
  page = document.createElement("div");
  page.innerHTML = BB_PAGE;
  document.body.append(page);
});

afterEach(async () => {
  if (mounted !== undefined && !mounted.inspection.disposed) {
    await mounted.lifecycle.dispose();
  }
  expect(consoleError.mock.calls).toEqual([]);
  expect(consoleWarn.mock.calls).toEqual([]);
  vi.useRealTimers();
  vi.restoreAllMocks();
  pageListeners.abort();
  cancelPendingFocus();
  cancelPendingNewThread();
  resetPaneResize();
  noteSidebarPointerDown(null);
  cleanup();
  resetStore();
  resetThreadOrderCache();
  setKeybindings(null);
  removeFakeLocks();
  Reflect.deleteProperty(navigator, "userActivation");
  window.localStorage.clear();
  document.body.replaceChildren();
});

describe("registration", () => {
  it("registers one content script and one app overlay", () => {
    expect(app.contentScripts.map((script) => script.id)).toEqual(["keys"]);
    expect(app.appOverlays.map((overlay) => overlay.id)).toEqual(["overlay"]);
  });

  it("registers three palette commands without a default shortcut", () => {
    expect(
      commands.map(({ id, title, target, defaultShortcut }) => ({
        id,
        title,
        target,
        defaultShortcut,
      })),
    ).toEqual([
      {
        id: "open-thread-chooser",
        title: "Tmux: Open thread chooser",
        target: "app",
        defaultShortcut: null,
      },
      {
        id: "show-keys",
        title: "Tmux: Show keys",
        target: "app",
        defaultShortcut: null,
      },
      {
        id: "toggle-paused",
        title: "Tmux: Pause or resume keys in this window",
        target: "app",
        defaultShortcut: null,
      },
    ]);
  });
});

describe("prefix keys", () => {
  it("opens the thread chooser on Ctrl-a then w and opens the chosen thread", async () => {
    await mountPlugin();

    const prefix = pressCtrl("a");
    expect(prefix.defaultPrevented).toBe(true);
    expect(getUiState().prefixArmed).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Ctrl-a");

    const key = pressKey("w");
    expect(key.defaultPrevented).toBe(true);
    expect(getUiState().prefixArmed).toBe(false);
    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
    expect(screen.getByRole("dialog", { name: "Thread chooser" })).toBeTruthy();
    expect(chooserTitles()).toEqual(["Alpha", "Beta", "Gamma"]);

    pressKey("G", chooserList());
    pressKey("Enter", chooserList());

    expect(getUiState().chooser).toEqual({ open: false });
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-3" },
    ]);
  });

  it("opens a thread in a pane below on Ctrl-a then s", async () => {
    await mountPlugin();

    pressCtrl("a");
    pressKey("s");
    expect(getUiState().chooser).toEqual({ open: true, placement: "down" });

    pressKey("G", chooserList());
    pressKey("Enter", chooserList());

    expect(threadsOpen).toHaveBeenCalledWith({
      threadId: "thr-3",
      split: "down",
      file: null,
    });
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("starts a new thread on Ctrl-a then c", async () => {
    await mountPlugin();

    pressCtrl("a");
    const key = pressKey("c");

    expect(key.defaultPrevented).toBe(true);
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toCompose", options: { focusPrompt: true } },
    ]);
  });

  it("lets the second Ctrl-a through to the page", async () => {
    await mountPlugin();

    const first = pressCtrl("a");
    const second = pressCtrl("a");

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(false);
    expect(getUiState().prefixArmed).toBe(false);
    expect(pressKey("w").defaultPrevented).toBe(false);
    expect(getUiState().chooser).toEqual({ open: false });
  });

  it("shows the key help on Ctrl-a then ?", async () => {
    await mountPlugin();

    pressCtrl("a");
    pressKey("?");

    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    expect(help.textContent).toContain("After the prefix");
    expect(help.textContent).toContain("Ctrl-a 1-9");
  });
});

describe("typing", () => {
  it.each(["notes", "composer", "terminal-input"])(
    "leaves keys typed in the %s field alone",
    async (testId) => {
      await mountPlugin();
      const field = fixture(testId);

      for (const key of PLAIN_KEYS) {
        expect(pressKey(key, field).defaultPrevented, key).toBe(false);
      }
      for (const chord of TYPING_CHORDS) {
        expect(press(chord, field).defaultPrevented, chord.key).toBe(false);
      }
      expect(view.inspection.navigateCalls).toEqual([]);
      expect(getUiState().chooser).toEqual({ open: false });
    },
  );

  it.each(["notes", "composer", "terminal-input"])(
    "arms the prefix on Ctrl-a in the %s field and passes the second Ctrl-a",
    async (testId) => {
      await mountPlugin();
      const field = fixture(testId);

      expect(pressCtrl("a", field).defaultPrevented).toBe(true);
      expect(getUiState().prefixArmed).toBe(true);
      expect(pressCtrl("a", field).defaultPrevented).toBe(false);
      expect(getUiState().prefixArmed).toBe(false);
    },
  );

  it.each(["notes", "composer", "terminal-input"])(
    "leaves Ctrl+h/j/k/l to the %s field, where they move no pane without the prefix",
    async (testId) => {
      await mountPlugin();
      const field = fixture(testId);
      const pointerDown = onEvent(pane("pane-2"), "pointerdown");
      field.focus();

      for (const key of HJKL) {
        expect(pressCtrl(key, field).defaultPrevented, key).toBe(false);
      }
      await afterFrames(2);

      expect(pointerDown).not.toHaveBeenCalled();
      expect(view.inspection.navigateCalls).toEqual([]);
      expect(document.activeElement).toBe(field);
    },
  );
});

describe("keys without the prefix outside copy mode and the sidebar", () => {
  const PLACES: [string, () => HTMLElement][] = [
    ["the pane", () => pane("pane-1")],
    ["the page body", () => document.body],
    ["a button of the pane", () => fixture("close-pane")],
  ];

  it.each(PLACES)(
    "leaves every key but i to bb while the cursor is on %s",
    async (_name, place) => {
      await mountPlugin();
      const target = place();
      target.focus();
      const viewport = focusedPaneViewport();
      const wheel = onEvent(viewport, "wheel");
      const pointerDown = onEvent(pane("pane-2"), "pointerdown");
      const sidebarClick = onEvent(
        page.querySelector<HTMLElement>('[data-sidebar="trigger"]') ?? page,
        "click",
      );

      for (const key of PLAIN_KEYS_BUT_I) {
        expect(pressKey(key, target).defaultPrevented, key).toBe(false);
      }
      for (const chord of TYPING_CHORDS) {
        expect(press(chord, target).defaultPrevented, chord.key).toBe(false);
      }
      for (const key of HJKL) {
        expect(pressCtrl(key, target).defaultPrevented, key).toBe(false);
      }
      expect(press({ key: "G", shiftKey: true }, target).defaultPrevented).toBe(false);
      await afterFrames(2);

      expect(viewport.scrollTop).toBe(0);
      expect(wheel).not.toHaveBeenCalled();
      expect(pointerDown).not.toHaveBeenCalled();
      expect(sidebarClick).not.toHaveBeenCalled();
      expect(view.inspection.navigateCalls).toEqual([]);
      expect(messageBoxRequests()).toBe(0);
      expect(getUiState()).toMatchObject({
        chooser: { open: false },
        helpOpen: false,
        copyMode: { active: false },
        notice: null,
      });
      expect(document.activeElement).toBe(
        target === document.body ? document.body : target,
      );
    },
  );

  it.each([
    ["g g", ["g", "g"]],
    [", f f", [",", "f", "f"]],
    [", f g", [",", "f", "g"]],
    ["Space e", [" ", "e"]],
  ])("passes the plain keys %s on to bb, which stock tmux does not bind without the prefix", async (_name, keys) => {
    await mountPlugin();

    for (const key of keys) {
      expect(pressKey(key).defaultPrevented, key).toBe(false);
    }

    expect(getUiState().chooser).toEqual({ open: false });
    expect(focusedPaneViewport().scrollTop).toBe(0);
  });
});

describe("i when the cursor is not in a text field", () => {
  const BB_MENU =
    '<div role="menu"><div role="menuitem" tabindex="-1">Rename</div></div>';

  function focusOn(element: HTMLElement): HTMLElement {
    element.focus();
    return element;
  }

  function messageLink(): HTMLElement {
    const link = document.createElement("a");
    link.href = "https://example.com/";
    link.textContent = "a link in a message";
    focusedPaneViewport().append(link);
    return link;
  }

  // Stands in for the listener that runs bb's shortcuts, which comes after
  // the plugin's.
  function listenAsBb(): ReturnType<typeof vi.fn> {
    const listener = vi.fn();
    window.addEventListener("keydown", listener, {
      signal: pageListeners.signal,
    });
    return listener;
  }

  // Each of these puts the cursor in its place and returns the element that
  // the key press then goes to.
  const PLACES: [string, () => HTMLElement][] = [
    ["the pane itself", () => focusOn(pane("pane-1"))],
    ["nothing", () => document.body],
    ["a button", () => focusOn(fixture("close-pane"))],
    ["a link", () => focusOn(messageLink())],
    [
      "a sidebar thread row that was reached from the keyboard",
      () => {
        pressAfterPrefix("h");
        return sidebarRow("thr-1");
      },
    ],
    [
      "a sidebar thread row that was clicked",
      () => {
        clickWithMouse(sidebarRow("thr-2"));
        return sidebarRow("thr-2");
      },
    ],
  ];

  it.each(PLACES)(
    "puts the text cursor in the message box of the focused pane from %s",
    async (_name, goTo) => {
      await mountPlugin();
      const target = goTo();
      expect(document.activeElement).toBe(target);
      const seenByBb = listenAsBb();

      const key = pressKey("i", target);

      expect(key.defaultPrevented).toBe(true);
      expect(seenByBb).not.toHaveBeenCalled();
      expect(messageBoxRequests()).toBe(1);
      expect(document.activeElement).toBe(pane("pane-1"));
      expect(view.inspection.navigateCalls).toEqual([]);
      expect(getUiState()).toMatchObject({
        prefixArmed: false,
        chooser: { open: false },
        helpOpen: false,
        copyMode: { active: false },
        notice: null,
      });
    },
  );

  it.each(["composer", "notes", "terminal-input"])(
    "is typed as an i in the %s field",
    async (testId) => {
      await mountPlugin();
      const field = focusOn(fixture(testId));
      const seenByBb = listenAsBb();

      const key = pressKey("i", field);

      expect(key.defaultPrevented).toBe(false);
      expect(seenByBb).toHaveBeenCalledWith(key);
      expect(document.activeElement).toBe(field);
      expect(messageBoxRequests()).toBe(0);
    },
  );

  // The browser names the host of a shadow root as the target of the key, and
  // not the field inside it.
  it("is typed as an i in a text field inside a shadow root", async () => {
    await mountPlugin();
    const host = document.createElement("div");
    pane("pane-1").append(host);
    const field = document.createElement("input");
    host.attachShadow({ mode: "open" }).append(field);
    field.focus();
    const seenByBb = listenAsBb();

    const key = press({ key: "i", composed: true }, field);

    expect(key.defaultPrevented).toBe(false);
    expect(seenByBb).toHaveBeenCalledWith(key);
    expect(document.activeElement).toBe(host);
    expect(host.shadowRoot?.activeElement).toBe(field);
    expect(messageBoxRequests()).toBe(0);
  });

  // A drop-down list can take letters to pick an entry, so it counts as
  // typing. bb's Branch and Worktree pickers are buttons with that role.
  it.each([
    [
      "a button that opens a list, as bb's Branch picker is",
      '<button data-testid="drop-down" role="combobox" aria-expanded="false">main</button>',
    ],
    [
      "a select",
      '<select data-testid="drop-down"><option>main</option></select>',
    ],
  ])("is left alone on %s", async (_name, html) => {
    await mountPlugin();
    fixture("composer").insertAdjacentHTML("afterend", html);
    const dropDown = focusOn(fixture("drop-down"));
    const seenByBb = listenAsBb();

    const key = pressKey("i", dropDown);

    expect(key.defaultPrevented).toBe(false);
    expect(seenByBb).toHaveBeenCalledWith(key);
    expect(document.activeElement).toBe(dropDown);
    expect(messageBoxRequests()).toBe(0);
  });

  it("is taken on a button of the message box that opens a menu, as bb's model picker is", async () => {
    await mountPlugin();
    fixture("composer").insertAdjacentHTML(
      "afterend",
      '<button data-testid="model-picker" aria-haspopup="menu" aria-expanded="false">Model</button>',
    );
    const picker = focusOn(fixture("model-picker"));

    expect(pressKey("i", picker).defaultPrevented).toBe(true);

    expect(document.activeElement).toBe(pane("pane-1"));
    expect(messageBoxRequests()).toBe(1);
  });

  it("is left to a dialog of bb, on its button and on the page behind it", async () => {
    await mountPlugin();
    document.body.insertAdjacentHTML("beforeend", BB_OTHER_POPOVER);
    const button = focusOn(screen.getByText("Mark all as read"));

    expect(pressKey("i", button).defaultPrevented).toBe(false);
    expect(pressKey("i", pane("pane-1")).defaultPrevented).toBe(false);

    expect(document.activeElement).toBe(button);
    expect(messageBoxRequests()).toBe(0);
  });

  it("is left to a menu of bb", async () => {
    await mountPlugin();
    document.body.insertAdjacentHTML("beforeend", BB_MENU);
    const item = focusOn(screen.getByText("Rename"));

    expect(pressKey("i", item).defaultPrevented).toBe(false);

    expect(document.activeElement).toBe(item);
    expect(messageBoxRequests()).toBe(0);
  });

  it("is left alone on a button of the embedded browser", async () => {
    await mountPlugin();
    pane("pane-1").insertAdjacentHTML(
      "beforeend",
      '<div data-app-browser><button data-testid="reload">Reload</button></div>',
    );
    const reload = focusOn(fixture("reload"));

    expect(pressKey("i", reload).defaultPrevented).toBe(false);

    expect(document.activeElement).toBe(reload);
    expect(messageBoxRequests()).toBe(0);
  });

  it("is left alone on a button of the terminal", async () => {
    await mountPlugin();
    fixture("terminal-input").insertAdjacentHTML(
      "afterend",
      '<button data-testid="clear-terminal">Clear</button>',
    );
    const clear = focusOn(fixture("clear-terminal"));

    expect(pressKey("i", clear).defaultPrevented).toBe(false);

    expect(document.activeElement).toBe(clear);
    expect(messageBoxRequests()).toBe(0);
  });

  it("is left alone while an embedded frame has the cursor", async () => {
    await mountPlugin();
    const frame = document.createElement("iframe");
    pane("pane-1").append(frame);
    vi.spyOn(document, "activeElement", "get").mockReturnValue(frame);

    expect(pressKey("i").defaultPrevented).toBe(false);

    expect(messageBoxRequests()).toBe(0);
  });

  it("is left to the thread chooser, in its list and in its filter field", async () => {
    await mountPlugin();
    pressAfterPrefix("w");

    expect(pressKey("i", chooserList()).defaultPrevented).toBe(false);
    pressKey("/", chooserList());
    const filter = screen.getByRole("combobox", {
      name: "Filter threads by title or project",
    });
    expect(document.activeElement).toBe(filter);
    expect(pressKey("i", filter).defaultPrevented).toBe(false);

    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
    expect(document.activeElement).toBe(filter);
    expect(messageBoxRequests()).toBe(0);
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("is left to the key help, which does nothing with it", async () => {
    await mountPlugin();
    pressAfterPrefix("?");
    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    const keyList = document.activeElement ?? help;
    expect(help.contains(keyList)).toBe(true);

    expect(pressKey("i", keyList).defaultPrevented).toBe(false);

    expect(getUiState().helpOpen).toBe(true);
    expect(document.activeElement).toBe(keyList);
    expect(messageBoxRequests()).toBe(0);
  });

  // Option-i is a dead key on a US Mac keyboard, and Caps Lock makes the key
  // type a capital I. With Caps Lock on, Shift can make it type a lowercase i
  // again.
  it.each<[string, KeyboardEventInit]>([
    ["Shift", { key: "I", code: "KeyI", shiftKey: true }],
    ["Shift while Caps Lock is on", { key: "i", code: "KeyI", shiftKey: true }],
    ["Ctrl", { key: "i", code: "KeyI", ctrlKey: true }],
    ["Alt", { key: "i", code: "KeyI", altKey: true }],
    ["Option on a Mac", { key: "Dead", code: "KeyI", altKey: true }],
    ["Cmd", { key: "i", code: "KeyI", metaKey: true }],
    ["Ctrl and Shift", { key: "I", code: "KeyI", ctrlKey: true, shiftKey: true }],
    ["Caps Lock", { key: "I", code: "KeyI" }],
  ])("is left to bb with %s", async (_name, init) => {
    await mountPlugin();
    const target = focusOn(pane("pane-1"));
    const seenByBb = listenAsBb();

    const key = press(init, target);

    expect(key.defaultPrevented).toBe(false);
    expect(seenByBb).toHaveBeenCalledWith(key);
    expect(messageBoxRequests()).toBe(0);
    expect(document.activeElement).toBe(target);
  });

  it("is left to bb with Shift on a sidebar thread row and on a button too", async () => {
    await mountPlugin();
    pressAfterPrefix("h");
    const row = sidebarRow("thr-1");

    expect(press({ key: "I", shiftKey: true }, row).defaultPrevented).toBe(false);
    expect(press({ key: "i", shiftKey: true }, row).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(row);
    const button = focusOn(fixture("close-pane"));
    expect(press({ key: "I", shiftKey: true }, button).defaultPrevented).toBe(false);
    expect(press({ key: "i", shiftKey: true }, button).defaultPrevented).toBe(false);

    expect(document.activeElement).toBe(button);
    expect(messageBoxRequests()).toBe(0);
  });

  // bb puts the cursor into the message box a moment after it was asked to,
  // so the key can still be down when the cursor arrives there.
  it("asks once however long the key is held, and types no i into the message box", async () => {
    await mountPlugin();
    const target = focusOn(fixture("close-pane"));

    expect(pressKey("i", target).defaultPrevented).toBe(true);
    const onPane = press({ key: "i", repeat: true }, pane("pane-1"));
    const composer = focusOn(fixture("composer"));
    const inMessageBox = press({ key: "i", repeat: true }, composer);

    expect(onPane.defaultPrevented).toBe(true);
    expect(inMessageBox.defaultPrevented).toBe(true);
    expect(messageBoxRequests()).toBe(1);
    expect(pressKey("i", composer).defaultPrevented).toBe(false);
  });

  it("stays an unbound key after the prefix, which takes it and does nothing", async () => {
    await mountPlugin();
    const button = focusOn(fixture("close-pane"));

    expect(pressCtrl("a", button).defaultPrevented).toBe(true);
    expect(getUiState().prefixArmed).toBe(true);
    expect(pressKey("i", button).defaultPrevented).toBe(true);

    expect(getUiState().prefixArmed).toBe(false);
    expect(messageBoxRequests()).toBe(0);
    expect(document.activeElement).toBe(button);

    const composer = focusOn(fixture("composer"));
    pressCtrl("a", composer);
    expect(pressKey("i", composer).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(composer);
    expect(messageBoxRequests()).toBe(0);
    expect(getUiState().notice).toBeNull();
  });

  it("does not arm or cancel the prefix: the prefix works right after it", async () => {
    await mountPlugin();
    focusOn(pane("pane-1"));

    pressKey("i", pane("pane-1"));
    expect(pressCtrl("a", pane("pane-1")).defaultPrevented).toBe(true);
    expect(pressKey("w", pane("pane-1")).defaultPrevented).toBe(true);

    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
    expect(messageBoxRequests()).toBe(1);
  });

  it("is left to bb everywhere while the plugin is switched off", async () => {
    await mountPlugin({ settings: { enabled: false } });

    expect(pressKey("i").defaultPrevented).toBe(false);
    for (const place of [
      pane("pane-1"),
      fixture("close-pane"),
      messageLink(),
      sidebarRow("thr-1"),
    ]) {
      place.focus();
      expect(pressKey("i", place).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(place);
    }
    expect(messageBoxRequests()).toBe(0);
  });

  it("is left to bb while the keys are paused in this window, and taken again once they are resumed", async () => {
    await mountPlugin();
    const button = focusOn(fixture("close-pane"));

    await runCommand("toggle-paused");
    expect(pressKey("i", button).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(messageBoxRequests()).toBe(0);

    await runCommand("toggle-paused");
    expect(pressKey("i", button).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pane("pane-1"));
    expect(messageBoxRequests()).toBe(1);
  });

  it("is left to bb before the overlay has published the user's settings", async () => {
    await mountContentScripts();
    const button = focusOn(fixture("close-pane"));

    expect(pressKey("i", button).defaultPrevented).toBe(false);

    expect(document.activeElement).toBe(button);
  });

  // bb lists no message box for a thread that is still loading, nor while it
  // shows a plugin page in the pane.
  it("rests on a pane that has no message box, and says nothing", async () => {
    await mountPlugin({ composerThreadId: "thr-2" });
    const button = focusOn(fixture("close-pane"));

    expect(pressKey("i", button).defaultPrevented).toBe(true);
    await afterFrames(2);

    expect(messageBoxRequests()).toBe(0);
    expect(document.activeElement).toBe(pane("pane-1"));
    expect(getUiState().notice).toBeNull();
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(pressKey("i", pane("pane-1")).defaultPrevented).toBe(true);
    expect(messageBoxRequests()).toBe(0);
    expect(getUiState().notice).toBeNull();
  });

  it("goes to the message box of the focused pane when that is the second of two panes", async () => {
    await mountPlugin({ composerThreadId: "thr-2" });
    bbFocusesThread("thr-2");
    const pointerDown = onEvent(pane("pane-2"), "pointerdown");

    expect(pressKey("i").defaultPrevented).toBe(true);
    await afterFrames(2);

    expect(messageBoxRequests()).toBe(1);
    expect(document.activeElement).toBe(pane("pane-2"));
    expect(pointerDown).not.toHaveBeenCalled();
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("does not ask for the message box of the other pane when the focused pane has none", async () => {
    await mountPlugin();
    bbFocusesThread("thr-2");

    expect(pressKey("i").defaultPrevented).toBe(true);
    await afterFrames(2);

    expect(messageBoxRequests()).toBe(0);
    expect(document.activeElement).toBe(pane("pane-2"));
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(getUiState().notice).toBeNull();
  });

  it("has its own section in the key help, between the prefix keys and copy mode", async () => {
    await mountPlugin();
    pressAfterPrefix("?");

    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    const titles = within(help)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual([
      "After the prefix",
      "Outside a text field",
      "Copy mode, vi keys",
      "On a thread in the sidebar",
      "In the thread chooser",
    ]);
    const section = within(help)
      .getByRole("heading", { level: 3, name: "Outside a text field" })
      .closest("section");
    expect(
      Array.from(section?.querySelectorAll("dt, dd") ?? [], (cell) => cell.textContent),
    ).toEqual(["i", "Put the text cursor in the message box of the focused pane"]);
  });
});

describe("pane and sidebar moves", () => {
  it("moves to the pane on the right on Ctrl-a then l", async () => {
    await mountPlugin();
    const pointerDowns: EventTarget[] = [];
    pane("pane-2").addEventListener("pointerdown", (event) => {
      if (event.target !== null) pointerDowns.push(event.target);
    });

    expect(pressAfterPrefix("l").defaultPrevented).toBe(true);

    expect(pointerDowns).toEqual([pane("pane-2")]);
    await waitFor(() =>
      expect(view.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr-2" },
      ]),
    );
  });

  it("enters the sidebar on Ctrl-a then h from the leftmost pane and drives it with the list keys", async () => {
    await mountPlugin();

    expect(pressAfterPrefix("h").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-1"));

    expect(pressKey("j", sidebarRow("thr-1")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-2"));

    expect(pressKey("G", sidebarRow("thr-2")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-3"));

    expect(pressKey("Enter", sidebarRow("thr-3")).defaultPrevented).toBe(true);
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-3" },
    ]);

    expect(pressKey("l", sidebarRow("thr-3")).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(sidebarRow("thr-3"));
    expect(pressKey("q", sidebarRow("thr-3")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pane("pane-1"));
    expect(messageBoxRequests()).toBe(1);
  });

  it("jumps to the second thread in sidebar order on Ctrl-a then 2", async () => {
    await mountPlugin();

    pressCtrl("a");
    pressKey("2");

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-2" },
    ]);
  });
});

// Three panes: one on the left over the full height, two stacked on the
// right. bb lists the lower right one before the upper right one.
describe("the next pane on Ctrl-a then o", () => {
  const THREE_PANES: PluginSidebarSplitLayout = {
    panes: [
      {
        paneId: "pane-1",
        threadId: "thr-1",
        isFocused: true,
        rect: { x: 0, y: 0, width: 0.5, height: 1 },
      },
      {
        paneId: "pane-3",
        threadId: "thr-3",
        isFocused: false,
        rect: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
      },
      {
        paneId: "pane-2",
        threadId: "thr-2",
        isFocused: false,
        rect: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      },
    ],
  };

  function addThirdPane(): void {
    pane("pane-2").insertAdjacentHTML(
      "afterend",
      '<div data-split-pane-id="pane-3" data-focused="false" tabindex="-1"><div data-thread-window><div data-page-scroll-viewport></div></div></div>',
    );
  }

  async function goToNextPane(): Promise<void> {
    const target = document.activeElement ?? document.body;
    expect(pressAfterPrefix("o", target).defaultPrevented).toBe(true);
    await afterFrames(1);
  }

  it("goes through the panes in the order bb lists them in, which follows the splits as the pane list of tmux does, and from the last one back to the first", async () => {
    addThirdPane();
    await mountPlugin({ layout: THREE_PANES });

    await goToNextPane();
    bbFocusesThread("thr-3");
    await goToNextPane();
    bbFocusesThread("thr-2");
    await goToNextPane();

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-3" },
      { method: "toThread", threadId: "thr-2" },
      { method: "toThread", threadId: "thr-1" },
    ]);
  });

  it("asks bb for the pane with a press on it, as a pane move does", async () => {
    await mountPlugin();
    const pointerDown = onEvent(pane("pane-2"), "pointerdown");

    pressAfterPrefix("o");

    expect(pointerDown).toHaveBeenCalledTimes(1);
  });

  it("puts the cursor in the message box of the pane it went to", async () => {
    await mountPlugin({ composerThreadId: "thr-2" });
    fixture("composer").focus();

    await goToNextPane();
    bbFocusesThread("thr-2");
    await afterFrames(3);

    expect(messageBoxRequests()).toBe(1);
    expect(document.activeElement).toBe(pane("pane-2"));
  });

  it("goes back to the first of two panes on the second o", async () => {
    await mountPlugin();

    await goToNextPane();
    bbFocusesThread("thr-2");
    await afterFrames(3);
    expect(messageBoxRequests()).toBe(0);
    await goToNextPane();
    bbFocusesThread("thr-1");
    await afterFrames(3);

    expect(messageBoxRequests()).toBe(1);
    expect(document.activeElement).toBe(pane("pane-1"));
  });

  it("leaves the sidebar for the next pane", async () => {
    await mountPlugin({ composerThreadId: "thr-2" });
    pressAfterPrefix("h");
    expect(document.activeElement).toBe(sidebarRow("thr-1"));

    await goToNextPane();
    bbFocusesThread("thr-2");
    await afterFrames(3);

    expect(document.activeElement).toBe(pane("pane-2"));
    expect(messageBoxRequests()).toBe(1);
  });
});

describe("palette commands", () => {
  it("opens the chooser and the key help", async () => {
    await mountPlugin();

    await runCommand("open-thread-chooser");
    expect(screen.getByRole("dialog", { name: "Thread chooser" })).toBeTruthy();
    pressKey("q", chooserList());
    expect(getUiState().chooser).toEqual({ open: false });

    await runCommand("show-keys");
    expect(getUiState().helpOpen).toBe(true);
  });

  it.each(["open-thread-chooser", "show-keys", "toggle-paused"])(
    "only says that bb is still loading for the command %s while bb has no values for the settings, because the plugin may be off",
    async (id) => {
      await mountPlugin({ settings: null });

      await runCommand(id);

      expect(getUiState().notice?.text).toBe(
        "bb is still loading. Try again in a moment.",
      );
      expect(getUiState()).toMatchObject({
        chooser: { open: false },
        helpOpen: false,
        paused: false,
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(view.inspection.rpcCalls).toEqual([]);
    },
  );

  it("pauses and resumes the keys and says which state it is in", async () => {
    await mountPlugin();

    await runCommand("toggle-paused");
    expect(getUiState().paused).toBe(true);
    expect(getUiState().notice?.text).toContain("paused");
    expect(pressCtrl("a").defaultPrevented).toBe(false);
    expect(pressKey("j").defaultPrevented).toBe(false);
    expect(getUiState().prefixArmed).toBe(false);

    await runCommand("toggle-paused");
    expect(getUiState().paused).toBe(false);
    expect(getUiState().notice?.text).toContain("on again");
    expect(pressCtrl("a").defaultPrevented).toBe(true);
  });
});

describe("cold start", () => {
  const SNAPSHOT_AT_QUIT = {
    version: 1,
    savedAt: 1,
    focusedThreadId: "thr-1",
    panes: [
      { paneId: "pane-1", threadId: "thr-1", isFocused: true },
      { paneId: "pane-2", threadId: "thr-2", isFocused: false },
    ],
  };
  const LAYOUT_AFTER_COLD_START: PluginSidebarSplitLayout = {
    panes: TWO_PANES.panes.map((layoutPane) =>
      layoutPane.isFocused ? { ...layoutPane, threadId: null } : layoutPane,
    ),
  };

  it("reopens the thread that the New thread screen replaced", async () => {
    window.history.replaceState(null, "", NEW_THREAD_ROUTE);
    window.localStorage.setItem(
      PLUGIN_STORAGE_KEYS.layoutSnapshot,
      JSON.stringify(SNAPSHOT_AT_QUIT),
    );

    await renderOverlayWithKeys({ layout: LAYOUT_AFTER_COLD_START, contextThreadId: null });

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-1" },
    ]);
  });

  it("reopens it in the only bb window once the browser has said so", async () => {
    installFakeLocks();
    window.history.replaceState(null, "", NEW_THREAD_ROUTE);
    window.localStorage.setItem(
      PLUGIN_STORAGE_KEYS.layoutSnapshot,
      JSON.stringify(SNAPSHOT_AT_QUIT),
    );

    await renderOverlayWithKeys({ layout: LAYOUT_AFTER_COLD_START, contextThreadId: null });

    await waitFor(() =>
      expect(view.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr-1" },
      ]),
    );
  });

  it("leaves a new window on the New thread screen while another bb window is open", async () => {
    installFakeLocks([
      { name: PLUGIN_LOCKS.openWindow, clientId: "first-window" },
    ]);
    window.history.replaceState(null, "", NEW_THREAD_ROUTE);
    window.localStorage.setItem(
      PLUGIN_STORAGE_KEYS.layoutSnapshot,
      JSON.stringify(SNAPSHOT_AT_QUIT),
    );

    await renderOverlayWithKeys({ layout: LAYOUT_AFTER_COLD_START, contextThreadId: null });

    await waitFor(() =>
      expect(storedSnapshot()?.savedAt).not.toBe(SNAPSHOT_AT_QUIT.savedAt),
    );
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("only records the layout when nothing was lost", async () => {
    await renderOverlayWithKeys();

    expect(view.inspection.navigateCalls).toEqual([]);
    expect(storedSnapshot()).toMatchObject({
      focusedThreadId: "thr-1",
      panes: SNAPSHOT_AT_QUIT.panes,
    });
  });

  it("reopens the thread in a window that has not been clicked or typed in yet", async () => {
    setWindowUsed(false);
    window.history.replaceState(null, "", NEW_THREAD_ROUTE);
    window.localStorage.setItem(
      PLUGIN_STORAGE_KEYS.layoutSnapshot,
      JSON.stringify(SNAPSHOT_AT_QUIT),
    );

    await renderOverlayWithKeys({ layout: LAYOUT_AFTER_COLD_START, contextThreadId: null });

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-1" },
    ]);
  });

  it("leaves the New thread screen alone once the user has clicked or typed in the window", async () => {
    setWindowUsed(true);
    window.history.replaceState(null, "", NEW_THREAD_ROUTE);
    window.localStorage.setItem(
      PLUGIN_STORAGE_KEYS.layoutSnapshot,
      JSON.stringify(SNAPSHOT_AT_QUIT),
    );

    await renderOverlayWithKeys({ layout: LAYOUT_AFTER_COLD_START, contextThreadId: null });

    expect(view.inspection.navigateCalls).toEqual([]);
    expect(storedSnapshot()).toMatchObject({
      focusedThreadId: null,
      panes: [
        { paneId: "pane-1", threadId: null, isFocused: true },
        { paneId: "pane-2", threadId: "thr-2", isFocused: false },
      ],
    });
  });
});

describe("more prefix keys", () => {
  it("moves with the arrow keys after the prefix", async () => {
    await mountPlugin();
    const pointerDown = onEvent(pane("pane-2"), "pointerdown");

    pressCtrl("a");
    expect(pressKey("ArrowRight").defaultPrevented).toBe(true);

    expect(pointerDown).toHaveBeenCalledTimes(1);
  });

  it("closes the focused pane on Ctrl-a x with bb's own button", async () => {
    await mountPlugin();
    const click = onEvent(fixture("close-pane"), "click");

    pressCtrl("a");
    pressKey("x");

    expect(click).toHaveBeenCalledTimes(1);
    expect(getUiState().notice).toBeNull();
  });

  it("zooms on Ctrl-a z through bb's own shortcut", async () => {
    const ran = await mountPluginWithBbShortcuts([
      bbShortcut(BB_COMMANDS.paneMaximizeToggle, "e"),
    ]);

    pressCtrl("a");
    pressKey("z");

    expect(ran).toEqual([BB_COMMANDS.paneMaximizeToggle]);
    expect(threadsPaneAction).not.toHaveBeenCalled();
    expect(getUiState().notice).toBeNull();
  });

  it("goes to the next and the previous thread on Ctrl-a n and p, wrapping around", async () => {
    await mountPlugin();

    pressCtrl("a");
    pressKey("n");
    pressCtrl("a");
    pressKey("p");

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-2" },
      { method: "toThread", threadId: "thr-3" },
    ]);
  });

  it("cancels the prefix on Escape", async () => {
    await mountPlugin();

    pressCtrl("a");
    expect(pressKey("Escape").defaultPrevented).toBe(true);

    expect(getUiState().prefixArmed).toBe(false);
    expect(pressKey("w").defaultPrevented).toBe(false);
    expect(getUiState().chooser).toEqual({ open: false });
  });

  it("keeps the prefix until the next key, however long that takes, when the tmux config sets no prefix-timeout", async () => {
    await mountPlugin();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    pressCtrl("a");
    act(() => {
      vi.advanceTimersByTime(3_600_000);
    });

    expect(screen.getByRole("status").textContent).toBe("Ctrl-a");
    expect(pressKey("w").defaultPrevented).toBe(true);
    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
  });

  it("cancels the prefix when the next key does not come within the prefix-timeout of the tmux config", async () => {
    await mountPlugin({ tmuxConfig: `${TMUX_CONFIG}\nset -g prefix-timeout 3000` });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    pressCtrl("a");
    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(getUiState().prefixArmed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2);
    });

    expect(getUiState().prefixArmed).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(pressKey("w").defaultPrevented).toBe(false);
  });
});

describe("resizing panes", () => {
  // The divider bb draws between two panes that are side by side, as
  // SplitDivider in SplitThreadArea.tsx renders it. SplitTree in the same file
  // marks the row that holds the panes and the divider as a grid root.
  const BB_DIVIDER = `
    <div role="separator" data-split-resize-grid-boundary="1" data-split-resize-grid-count="2" aria-orientation="vertical" data-testid="divider">
      <div aria-hidden="true" data-split-divider-hit-target="" data-testid="divider-hit-target"></div>
    </div>
  `;

  // What Option-h, j, k and l type on a US Mac keyboard.
  const OPTION_CHARACTERS: Record<string, string> = {
    h: "\u02d9",
    j: "\u2206",
    k: "\u02da",
    l: "\u00ac",
  };

  let drags: string[];

  function pressOption(
    letter: string,
    target?: EventTarget,
    init: KeyboardEventInit = {},
  ): KeyboardEvent {
    return press(
      {
        key: OPTION_CHARACTERS[letter],
        code: `Key${letter.toUpperCase()}`,
        altKey: true,
        ...init,
      },
      target,
    );
  }

  function dragTo(x: number): string[] {
    return [
      `pointerdown at ${x},300 pointer 1 buttons 1`,
      `pointermove at ${x},300 pointer 1 buttons 1`,
      `pointerup at ${x},300 pointer 1 buttons 0`,
    ];
  }

  // jsdom has no layout, so the boxes are set here: the left pane, the
  // divider of 1 pixel and the right pane, in a row of 1001 pixels.
  function layOutPanes(leftWidth: number, rightWidth = 1000 - leftWidth): void {
    const row = pane("pane-1").parentElement;
    if (row === null) throw new Error("the panes have no row");
    const rowWidth = leftWidth + 1 + rightWidth;
    row.getBoundingClientRect = () => new DOMRect(0, 0, rowWidth, 600);
    pane("pane-1").getBoundingClientRect = () => new DOMRect(0, 0, leftWidth, 600);
    fixture("divider").getBoundingClientRect = () => new DOMRect(leftWidth, 0, 1, 600);
    pane("pane-2").getBoundingClientRect = () =>
      new DOMRect(leftWidth + 1, 0, rightWidth, 600);
  }

  beforeEach(() => {
    pane("pane-1").insertAdjacentHTML("afterend", BB_DIVIDER);
    pane("pane-1").parentElement?.setAttribute("data-split-resize-grid-root", "");
    layOutPanes(500);
    drags = [];
    for (const type of ["pointerdown", "pointermove", "pointerup"]) {
      fixture("divider-hit-target").addEventListener(
        type,
        (event) => {
          const { clientX, clientY, pointerId, buttons } = event as PointerEvent;
          drags.push(
            `${type} at ${clientX},${clientY} pointer ${pointerId} buttons ${buttons}`,
          );
        },
        { signal: pageListeners.signal },
      );
    }
  });

  it("drags the divider on the right of the focused pane on Ctrl-a then Option-l, and again on Option-l alone", async () => {
    await mountPlugin();
    const focusPresses = onEvent(pane("pane-2"), "pointerdown");

    pressCtrl("a");
    expect(pressOption("l").defaultPrevented).toBe(true);
    expect(drags).toEqual(dragTo(550.5));
    expect(getUiState().prefixArmed).toBe(true);
    expect(modePill()).toBe("Ctrl-a");

    expect(pressOption("l").defaultPrevented).toBe(true);
    expect(pressOption("l", undefined, { repeat: true }).defaultPrevented).toBe(
      true,
    );
    expect(pressOption("h", undefined, { shiftKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(drags).toEqual([
      ...dragTo(550.5),
      ...dragTo(550.5),
      ...dragTo(550.5),
      ...dragTo(450.5),
    ]);

    expect(getUiState().prefixArmed).toBe(true);
    expect(getUiState().notice).toBeNull();
    expect(focusPresses).not.toHaveBeenCalled();
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("leaves Option-h/j/k/l to typing without the prefix and once the repeat window is over", async () => {
    await mountPlugin({
      settings: { resizeCellPx: 20 },
      tmuxConfig: `${TMUX_CONFIG}\nset -g repeat-time 400`,
    });
    const notes = fixture("notes");

    for (const letter of HJKL) {
      expect(pressOption(letter, notes).defaultPrevented, letter).toBe(false);
      expect(
        pressOption(letter, notes, { shiftKey: true }).defaultPrevented,
        letter,
      ).toBe(false);
    }
    expect(drags).toEqual([]);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    pressCtrl("a", notes);
    expect(pressOption("l", notes).defaultPrevented).toBe(true);
    expect(drags).toEqual(dragTo(600.5));
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(getUiState().prefixArmed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(getUiState().prefixArmed).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(pressOption("l", notes).defaultPrevented).toBe(false);

    pressCtrl("a", notes);
    pressOption("j", notes);
    expect(pressKey("x", notes).defaultPrevented).toBe(false);
    expect(pressOption("l", notes).defaultPrevented).toBe(false);
    expect(drags).toEqual(dragTo(600.5));
    expect(getUiState().notice).toBeNull();
  });

  it("opens no repeat window when the pane has no divider that can go that way", async () => {
    await mountPlugin();
    const notes = fixture("notes");

    pressCtrl("a", notes);
    expect(modePill()).toBe("Ctrl-a");
    expect(pressOption("j", notes).defaultPrevented).toBe(true);

    expect(getUiState().prefixArmed).toBe(false);
    expect(modePill()).toBeNull();
    expect(pressOption("j", notes, { repeat: true }).defaultPrevented).toBe(true);
    for (const letter of HJKL) {
      expect(pressOption(letter, notes).defaultPrevented, letter).toBe(false);
    }
    expect(drags).toEqual([]);
    expect(getUiState().notice).toBeNull();
  });

  it("says once that there is only one pane, opens no repeat window and types the next Option key", async () => {
    pane("pane-2").remove();
    fixture("divider").remove();
    pane("pane-1").removeAttribute("data-focused");
    await mountPlugin({ layout: null });
    const notes = fixture("notes");

    pressCtrl("a", notes);
    expect(pressOption("l", notes).defaultPrevented).toBe(true);
    const notice = getUiState().notice;
    expect(notice?.text).toBe("There is only one pane, so there is nothing to resize.");
    expect(getUiState().prefixArmed).toBe(false);
    expect(modePill()).toBeNull();

    expect(pressOption("l", notes, { repeat: true }).defaultPrevented).toBe(true);
    expect(pressOption("l", notes).defaultPrevented).toBe(false);
    expect(pressOption("k", notes).defaultPrevented).toBe(false);
    expect(getUiState().notice).toBe(notice);
  });

  it("sends bb nothing at the smallest pane size, and still takes the key that goes the other way", async () => {
    layOutPanes(150);
    await mountPlugin();
    const notes = fixture("notes");

    pressCtrl("a", notes);
    expect(pressOption("h", notes).defaultPrevented).toBe(true);
    expect(pressOption("h", notes, { repeat: true }).defaultPrevented).toBe(true);
    expect(drags).toEqual([]);
    expect(getUiState().prefixArmed).toBe(true);

    expect(pressOption("l", notes).defaultPrevented).toBe(true);
    expect(drags).toEqual(dragTo(200.5));
    expect(getUiState().notice).toBeNull();
  });

  it("stops a long step at the smallest pane size", async () => {
    await mountPlugin({ settings: { resizeCellPx: 80 } });

    pressCtrl("a");
    pressOption("h");
    expect(drags).toEqual(dragTo(150.5));
  });

  it("leaves the panes alone while bb hides the conversation area", async () => {
    layOutPanes(0, 0);
    await mountPlugin();
    const notes = fixture("notes");

    pressCtrl("a", notes);
    expect(pressOption("l", notes).defaultPrevented).toBe(true);

    expect(drags).toEqual([]);
    expect(getUiState().prefixArmed).toBe(false);
    expect(pressOption("l", notes).defaultPrevented).toBe(false);
    expect(getUiState().notice).toBeNull();
  });

  // What Option-u is on a US Mac keyboard: a dead key, which waits for the
  // next letter to put an accent on it.
  it.each<[string, KeyboardEventInit]>([
    ["a dead key", { key: "Dead", code: "KeyU", altKey: true }],
    ["a dead key that the browser reports as key 229", { key: "Dead", code: "KeyU", altKey: true, keyCode: 229 }],
  ])("ends the prefix on %s, so the next key is typed and closes no pane", async (_name, deadKey) => {
    await mountPlugin();
    const notes = fixture("notes");
    const closeClick = onEvent(fixture("close-pane"), "click");

    pressCtrl("a", notes);
    expect(press(deadKey, notes).defaultPrevented).toBe(false);

    expect(getUiState().prefixArmed).toBe(false);
    expect(modePill()).toBeNull();
    expect(pressKey("x", notes).defaultPrevented).toBe(false);
    expect(pressKey("Backspace", notes).defaultPrevented).toBe(false);
    expect(closeClick).not.toHaveBeenCalled();
  });

  it("ends the repeat window on a dead key as well", async () => {
    await mountPlugin();
    const notes = fixture("notes");

    pressCtrl("a", notes);
    pressOption("l", notes);
    expect(getUiState().prefixArmed).toBe(true);
    press({ key: "Dead", code: "KeyU", altKey: true }, notes);

    expect(getUiState().prefixArmed).toBe(false);
    expect(pressOption("l", notes).defaultPrevented).toBe(false);
    expect(drags).toEqual(dragTo(550.5));
  });

  it("names the resize keys Option in the key help on a Mac and says that they repeat", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await mountPlugin();

    pressCtrl("a");
    pressKey("?");

    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    expect(help.textContent).toContain(
      "Ctrl-a Option-Left / Option-h / Option-Shift-h",
    );
    expect(help.textContent).toContain(
      "Resize this pane by moving its divider to the left by 5 cells (repeats)",
    );
    expect(help.textContent).toContain(
      "After such a key, every key with this mark works without the prefix for 1 second",
    );
    expect(help.textContent).not.toContain("Alt-");
  });

  it("runs a key of the prefix table that is the prefix key itself after the prefix and inside its repeat window, as tmux does, and never without them", async () => {
    await mountPlugin({ tmuxConfig: `${TMUX_CONFIG}set -g prefix M-h\n` });
    const notes = fixture("notes");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    expect(pressOption("h", notes).defaultPrevented).toBe(true);
    expect(drags).toEqual([]);
    expect(pressOption("h", notes).defaultPrevented).toBe(true);
    expect(drags).toEqual(dragTo(450.5));

    drags = [];
    expect(pressOption("h", notes).defaultPrevented).toBe(true);
    expect(drags).toEqual(dragTo(450.5));
    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(getUiState().prefixArmed).toBe(false);

    drags = [];
    expect(pressOption("h", notes).defaultPrevented).toBe(true);
    expect(drags).toEqual([]);
    expect(getUiState().prefixArmed).toBe(true);
    expect(pressKey("Escape", notes).defaultPrevented).toBe(true);

    pressOption("h");
    pressKey("?");
    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    expect(help.textContent).toContain("Alt-h Alt-Left / Alt-h / Alt-Shift-h");
  });
});

describe("after a thread is opened", () => {
  const THIRD_THREAD = { method: "toThread", threadId: "thr-3" };
  const THIRD_THREAD_TO_THE_RIGHT = {
    method: "toThread",
    threadId: "thr-3",
    options: { split: true },
  };

  it("puts the cursor in the message box of a thread that Ctrl-a then 3 opened", async () => {
    await mountPlugin({ composerThreadId: "thr-3" });

    pressAfterPrefix("3");
    expect(view.inspection.navigateCalls).toEqual([THIRD_THREAD]);
    expect(messageBoxRequests()).toBe(0);
    bbFocusesThread("thr-3");
    await afterFrames(3);

    expect(messageBoxRequests()).toBe(1);
  });

  it("puts the cursor in the message box of a thread that was chosen in the chooser", async () => {
    await mountPlugin({ composerThreadId: "thr-3" });
    fixture("composer").focus();
    pressAfterPrefix("w", fixture("composer"));

    pressKey("G", chooserList());
    pressKey("Enter", chooserList());
    expect(view.inspection.navigateCalls).toEqual([THIRD_THREAD]);
    bbFocusesThread("thr-3");
    await afterFrames(3);

    expect(messageBoxRequests()).toBe(1);
  });

  it("puts the cursor in the message box of a thread that the chooser opened in a new pane", async () => {
    await mountPlugin({ composerThreadId: "thr-3" });
    pressAfterPrefix("v");

    pressKey("G", chooserList());
    pressKey("Enter", chooserList());
    expect(view.inspection.navigateCalls).toEqual([THIRD_THREAD_TO_THE_RIGHT]);
    bbOpensPane("thr-3");
    await afterFrames(3);

    expect(messageBoxRequests()).toBe(1);
  });

  it("puts the cursor in the message box of a thread that was opened from the sidebar", async () => {
    await mountPlugin({ composerThreadId: "thr-3" });
    pressAfterPrefix("h");
    pressKey("G", sidebarRow("thr-1"));

    pressKey("Enter", sidebarRow("thr-3"));
    expect(view.inspection.navigateCalls).toEqual([THIRD_THREAD]);
    bbFocusesThread("thr-3");
    await afterFrames(3);

    expect(messageBoxRequests()).toBe(1);
    expect(document.activeElement).toBe(pane("pane-1"));
  });

  it.each([
    ["v", "to the right"],
    ["s", "below"],
  ])(
    "puts the cursor in the message box of a thread that %s opened in a new pane %s from the sidebar",
    async (key) => {
      await mountPlugin({ composerThreadId: "thr-3" });
      pressAfterPrefix("h");
      pressKey("G", sidebarRow("thr-1"));

      expect(pressKey(key, sidebarRow("thr-3")).defaultPrevented).toBe(true);
      bbOpensPane("thr-3");
      await afterFrames(3);

      expect(messageBoxRequests()).toBe(1);
      expect(document.activeElement).not.toBe(sidebarRow("thr-3"));
    },
  );

  it.each([
    ["the thread chooser", "w", () => chooserList()],
    ["the key help", "?", () => screen.getByRole("dialog", { name: "Tmux keys" })],
  ] as const)(
    "leaves the keyboard to %s when it was opened while a pane below was still on its way, and puts the cursor in the message box of that pane once it closes",
    async (_name, key, dialog) => {
      await mountPlugin({ composerThreadId: "thr-3" });
      pressAfterPrefix("s");
      pressKey("G", chooserList());
      pressKey("Enter", chooserList());
      expect(threadsOpen).toHaveBeenCalledTimes(1);

      pressAfterPrefix(key);
      const opened = dialog();
      await waitFor(() => expect(opened.contains(document.activeElement)).toBe(true));
      bbOpensPane("thr-3");
      await afterFrames(3);

      expect(opened.contains(document.activeElement)).toBe(true);
      expect(messageBoxRequests()).toBe(0);
      expect(pressKey("j", document.activeElement ?? opened).defaultPrevented).toBe(true);

      pressKey("q", document.activeElement ?? opened);
      await waitFor(() => expect(messageBoxRequests()).toBe(1));
    },
  );

  // bb mounts the message box of a thread a moment after the pane shows it,
  // and puts the cursor in it by itself.
  it("stays on the pane while bb lists no message box for the thread, and leaves the cursor where bb puts it afterwards", async () => {
    await mountPlugin();

    pressAfterPrefix("3");
    bbFocusesThread("thr-3");
    await afterFrames(3);
    expect(document.activeElement).toBe(pane("pane-1"));
    expect(messageBoxRequests()).toBe(0);

    fixture("composer").focus();
    await afterFrames(3);

    expect(document.activeElement).toBe(fixture("composer"));
    expect(pressKey("j", fixture("composer")).defaultPrevented).toBe(false);
  });

  it("leaves the cursor in the message box when bb put it there before the plugin looked", async () => {
    await mountPlugin({ composerThreadId: "thr-3" });

    pressAfterPrefix("3");
    bbFocusesThread("thr-3");
    fixture("composer").focus();
    await afterFrames(3);

    expect(document.activeElement).toBe(fixture("composer"));
    expect(messageBoxRequests()).toBe(0);
  });
});

describe("the text cursor after a pane move", () => {
  // bb takes the cursor out of the message box on Escape with a plain blur().
  function pressEscapeInMessageBox(): void {
    expect(pressKey("Escape", fixture("composer")).defaultPrevented).toBe(false);
    fixture("composer").blur();
  }

  // A click on a conversation: bb focuses that pane, and the browser puts
  // the cursor on the pane element.
  function clickConversationOf(paneId: string, threadId: string): void {
    const conversation = pane(paneId).querySelector<HTMLElement>(
      "[data-page-scroll-viewport]",
    );
    if (conversation === null) throw new Error("the pane has no conversation");
    pressPointer(conversation);
    bbFocusesThread(threadId);
    pane(paneId).focus();
  }

  async function moveToPane(key: string, threadId: string): Promise<void> {
    const target = document.activeElement ?? document.body;
    expect(pressAfterPrefix(key, target).defaultPrevented).toBe(true);
    bbFocusesThread(threadId);
    await afterFrames(3);
  }

  it.each([
    ["l", "h"],
    ["ArrowRight", "ArrowLeft"],
  ])(
    "goes into the message box of the pane that Ctrl-a then %s and Ctrl-a then %s move to",
    async (right, left) => {
      await mountPlugin();
      fixture("composer").focus();

      await moveToPane(right, "thr-2");
      expect(document.activeElement).toBe(pane("pane-2"));
      expect(messageBoxRequests()).toBe(0);

      await moveToPane(left, "thr-1");
      expect(messageBoxRequests()).toBe(1);
      fixture("composer").focus();
      await afterFrames(2);

      expect(document.activeElement).toBe(fixture("composer"));
      expect(pressKey("j", fixture("composer")).defaultPrevented).toBe(false);
    },
  );

  it("takes the cursor out of the message box of the pane that is left", async () => {
    await mountPlugin({ composerThreadId: "thr-2" });
    fixture("composer").focus();

    await moveToPane("l", "thr-2");

    expect(document.activeElement).toBe(pane("pane-2"));
    expect(messageBoxRequests()).toBe(1);
  });

  it("stays on a pane that has no message box", async () => {
    await mountPlugin();
    fixture("composer").focus();

    await moveToPane("l", "thr-2");
    await afterFrames(3);

    expect(document.activeElement).toBe(pane("pane-2"));
    expect(messageBoxRequests()).toBe(0);
  });

  it.each([
    ["with the cursor in its message box", () => fixture("composer").focus()],
    [
      "after Escape took the cursor out of its message box",
      () => {
        fixture("composer").focus();
        pressEscapeInMessageBox();
      },
    ],
    [
      "from a click on its conversation",
      () => {
        fixture("composer").focus();
        clickConversationOf("pane-2", "thr-2");
        clickConversationOf("pane-1", "thr-1");
      },
    ],
    ["from one of its buttons", () => clickWithMouse(fixture("close-pane"))],
    ["from its terminal", () => fixture("terminal-input").focus()],
    ["without the cursor ever having been in it", () => {}],
  ])(
    "goes into the message box on the way back to a pane that was left %s",
    async (_name, leave) => {
      await mountPlugin();
      leave();

      await moveToPane("l", "thr-2");
      await moveToPane("h", "thr-1");

      expect(messageBoxRequests()).toBe(1);
      expect(document.activeElement).toBe(pane("pane-1"));
    },
  );

  // bb shows a question of the agent in place of the message box, which is
  // hidden meanwhile (hidden={hasPendingInteraction} in FollowUpPromptBox.tsx).
  // bb then does nothing when it is asked for the cursor.
  it("rests on the pane while bb hides the message box", async () => {
    await mountPlugin();
    fixture("composer").focus();
    await moveToPane("l", "thr-2");

    await moveToPane("h", "thr-1");
    await afterFrames(3);

    expect(messageBoxRequests()).toBe(1);
    expect(document.activeElement).toBe(pane("pane-1"));
    expect(pressKey("j", pane("pane-1")).defaultPrevented).toBe(false);
  });

  it.each([{ key: "q" }, { key: "Escape" }, { key: "g", ctrlKey: true }])(
    "goes into the message box on the way back from the sidebar with $key",
    async (leave) => {
      await mountPlugin();
      fixture("composer").focus();

      expect(pressAfterPrefix("h", fixture("composer")).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(sidebarRow("thr-1"));
      expect(messageBoxRequests()).toBe(0);

      expect(press(leave, sidebarRow("thr-1")).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(pane("pane-1"));
      expect(messageBoxRequests()).toBe(1);
      fixture("composer").focus();

      expect(document.activeElement).toBe(fixture("composer"));
    },
  );

  it("goes into the message box on the way back from the sidebar with Ctrl-a then l", async () => {
    await mountPlugin();
    pressAfterPrefix("h");
    const pointerDown = onEvent(pane("pane-2"), "pointerdown");

    expect(pressAfterPrefix("l", sidebarRow("thr-1")).defaultPrevented).toBe(true);

    expect(document.activeElement).toBe(pane("pane-1"));
    expect(messageBoxRequests()).toBe(1);
    expect(pointerDown).not.toHaveBeenCalled();
  });

  it("goes into the message box on a jump to the thread from another pane", async () => {
    await mountPlugin();
    await moveToPane("l", "thr-2");

    pressAfterPrefix("1", pane("pane-2"));
    bbFocusesThread("thr-1");
    await afterFrames(3);

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-1" },
    ]);
    expect(messageBoxRequests()).toBe(1);
  });

  // bb's zoom follows the focused pane: the pane that is left gets hidden,
  // and the browser takes the cursor away from a hidden element.
  it("goes into the message box of a zoomed pane that was hidden while the user was in the next pane", async () => {
    await mountPlugin();
    fixture("composer").focus();

    expect(pressAfterPrefix("l", fixture("composer")).defaultPrevented).toBe(true);
    pane("pane-1").setAttribute("aria-hidden", "true");
    fixture("composer").blur();
    bbFocusesThread("thr-2");
    await afterFrames(3);
    expect(document.activeElement).toBe(pane("pane-2"));

    expect(pressAfterPrefix("h", pane("pane-2")).defaultPrevented).toBe(true);
    pane("pane-2").setAttribute("aria-hidden", "true");
    pane("pane-1").removeAttribute("aria-hidden");
    bbFocusesThread("thr-1");
    await afterFrames(3);

    expect(messageBoxRequests()).toBe(1);
    fixture("composer").focus();
    expect(document.activeElement).toBe(fixture("composer"));
  });

  it.each([
    ["the thread chooser", "w", () => pressKey("q", chooserList())],
    ["the thread chooser", "w", () => pressKey("Escape", chooserList())],
    ["the key help", "?", () => pressKey("q", document.activeElement ?? document.body)],
    ["the key help", "?", () => pressKey("Escape", document.activeElement ?? document.body)],
  ])(
    "goes into the message box when %s closes without a choice and the cursor was on the pane",
    async (_name, key, close) => {
      await mountPlugin();
      pane("pane-1").focus();
      pressAfterPrefix(key, pane("pane-1"));
      expect(document.activeElement).not.toBe(pane("pane-1"));

      close();

      await waitFor(() => expect(messageBoxRequests()).toBe(1));
      expect(document.activeElement).toBe(pane("pane-1"));
      expect(view.inspection.navigateCalls).toEqual([]);
    },
  );

  it.each([
    ["the thread chooser", "w", () => pressKey("q", chooserList())],
    ["the key help", "?", () => pressKey("q", document.activeElement ?? document.body)],
  ])(
    "gives the cursor back to the message box it was in when %s closes without a choice",
    async (_name, key, close) => {
      await mountPlugin();
      fixture("composer").focus();
      pressAfterPrefix(key, fixture("composer"));

      close();

      await waitFor(() => expect(document.activeElement).toBe(fixture("composer")));
      expect(messageBoxRequests()).toBe(0);
    },
  );

  it.each([
    ["the terminal", () => fixture("terminal-input")],
    ["a sidebar thread row", () => sidebarRow("thr-2")],
  ])(
    "gives the cursor back to %s when the key help closes there",
    async (_name, place) => {
      await mountPlugin();
      place().focus();
      pressAfterPrefix("?", place());

      pressKey("q", document.activeElement ?? document.body);

      await waitFor(() => expect(document.activeElement).toBe(place()));
      expect(messageBoxRequests()).toBe(0);
    },
  );
});

// bb's closePane (SplitThreadArea.tsx) sets the layout first and navigates
// second, and the navigation is rendered later. So the pane that stays is
// the single pane at once, while the route still names the closed thread.
describe("closing a pane with Ctrl-a x", () => {
  function addMessageBoxToSecondPane(): HTMLElement {
    pane("pane-2")
      .querySelector("[data-thread-window]")
      ?.insertAdjacentHTML(
        "beforeend",
        '<div data-app-composer data-app-composer-role="primary"><div data-testid="composer-2" contenteditable="true" role="textbox"></div></div>',
      );
    return fixture("composer-2");
  }

  function bbClosesFirstPane(): void {
    const bridge = getBridge();
    if (bridge === null) throw new Error("the bridge was not published");
    pane("pane-1").remove();
    pane("pane-2").removeAttribute("tabindex");
    pane("pane-2").removeAttribute("data-focused");
    setBridge({ ...bridge, layout: null });
  }

  function bbRouteFollows(): void {
    const bridge = getBridge();
    if (bridge === null) throw new Error("the bridge was not published");
    setBridge({ ...bridge, context: { ...bridge.context, threadId: "thr-2" } });
  }

  function closeFirstPaneFrom(target: HTMLElement): void {
    fixture("close-pane").addEventListener("click", bbClosesFirstPane, {
      signal: pageListeners.signal,
    });
    pressCtrl("a", target);
    expect(pressKey("x", target).defaultPrevented).toBe(true);
    expect(getBridge()?.layout).toBeNull();
    expect(getBridge()?.context.threadId).toBe("thr-1");
  }

  it("puts the cursor in the message box of the pane that stays, once the route names its thread", async () => {
    await mountPlugin({ composerThreadId: "thr-2" });
    const messageBox = addMessageBoxToSecondPane();
    pane("pane-1").focus();

    closeFirstPaneFrom(pane("pane-1"));
    await afterFrames(3);
    expect(messageBoxRequests()).toBe(0);

    bbRouteFollows();
    await afterFrames(3);
    expect(messageBoxRequests()).toBe(1);
    messageBox.focus();

    expect(document.activeElement).toBe(messageBox);
    expect(pressKey("j", messageBox).defaultPrevented).toBe(false);
  });

  it("puts it there as well when the cursor was in the message box of the closed pane", async () => {
    await mountPlugin({ composerThreadId: "thr-2" });
    addMessageBoxToSecondPane();
    fixture("composer").focus();

    closeFirstPaneFrom(fixture("composer"));
    await afterFrames(3);
    bbRouteFollows();
    await afterFrames(3);

    expect(messageBoxRequests()).toBe(1);
  });

  it("leaves the cursor in that message box when bb put it there while the route was still behind", async () => {
    await mountPlugin({ composerThreadId: "thr-2" });
    const messageBox = addMessageBoxToSecondPane();
    pane("pane-1").focus();

    closeFirstPaneFrom(pane("pane-1"));
    messageBox.focus();
    await afterFrames(3);
    bbRouteFollows();
    await afterFrames(3);

    expect(document.activeElement).toBe(messageBox);
    expect(messageBoxRequests()).toBe(0);
    expect(pressKey("j", messageBox).defaultPrevented).toBe(false);
  });

  it("stays on the pane that is left when it has no message box", async () => {
    await mountPlugin();
    fixture("composer").focus();

    closeFirstPaneFrom(fixture("composer"));
    await afterFrames(3);
    bbRouteFollows();
    await afterFrames(3);

    expect(messageBoxRequests()).toBe(0);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("held keys", () => {
  it("swallows the repeats of the key that followed the prefix, and passes that key once it is pressed again", async () => {
    await mountPlugin();

    pressCtrl("a");
    pressKey("j");
    const repeat = press({ key: "j", repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(pressKey("j").defaultPrevented).toBe(false);
    expect(focusedPaneViewport().scrollTop).toBe(0);
  });

  it("keeps moving through the sidebar while j is held", async () => {
    await mountPlugin();
    pressAfterPrefix("h");

    pressKey("j", sidebarRow("thr-1"));
    const repeat = press({ key: "j", repeat: true }, sidebarRow("thr-2"));

    expect(repeat.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-3"));
  });

  it("does not type the key that closed the key help into the message box", async () => {
    await mountPlugin();
    const composer = fixture("composer");
    composer.focus();
    pressCtrl("a", composer);
    pressKey("?", composer);
    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    expect(help.contains(document.activeElement)).toBe(true);

    pressKey("q", document.activeElement ?? help);
    await waitFor(() => expect(document.activeElement).toBe(composer));
    const repeat = press({ key: "q", repeat: true }, composer);

    expect(repeat.defaultPrevented).toBe(true);
    expect(pressKey("q", composer).defaultPrevented).toBe(false);
  });

  it.each(["composer", "terminal-input"])(
    "lets a key held in the %s go on repeating after a hover card of bb has closed by itself",
    async (field) => {
      await mountPlugin({ tmuxConfig: null });
      const input = fixture(field);
      input.focus();
      document.body.insertAdjacentHTML("beforeend", BB_OTHER_POPOVER);
      const card = screen.getByRole("dialog", { name: "Notifications" });

      const first = press({ key: "Backspace", code: "Backspace" }, input);
      const underCard = press({ key: "Backspace", code: "Backspace", repeat: true }, input);
      card.parentElement?.remove();
      const afterCard = press({ key: "Backspace", code: "Backspace", repeat: true }, input);

      expect(first.defaultPrevented).toBe(false);
      expect(underCard.defaultPrevented).toBe(false);
      expect(afterCard.defaultPrevented).toBe(false);
    },
  );

  it("does not send a draft with the Enter that chose a thread", async () => {
    await mountPlugin();
    const composer = fixture("composer");
    composer.focus();
    pressCtrl("a", composer);
    pressKey("w", composer);

    pressKey("Enter", chooserList());
    const repeat = press({ key: "Enter", repeat: true }, composer);

    expect(getUiState().chooser).toEqual({ open: false });
    expect(repeat.defaultPrevented).toBe(true);
  });

  it.each(["Enter", "c"])(
    "does not type the held %s that started a new thread from the chooser into the message box",
    async (key) => {
      await mountPlugin();
      const composer = fixture("composer");
      composer.focus();
      pressCtrl("a", composer);
      pressKey("v", composer);

      pressKey(key, chooserList());
      const repeat = press({ key, repeat: true }, composer);

      expect(getUiState().chooser).toEqual({ open: false });
      expect(view.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr-3", options: { split: true } },
      ]);
      expect(repeat.defaultPrevented).toBe(true);
    },
  );
});

describe("more sidebar keys", () => {
  it("leaves a thread row that was clicked to bb, with every sidebar key", async () => {
    await mountPlugin();
    const row = sidebarRow("thr-2");
    clickWithMouse(row);

    for (const key of ["j", "k", "g", "q", "l", "v", "s", "Escape", "Enter", "Home", "End"]) {
      expect(pressKey(key, row).defaultPrevented, key).toBe(false);
    }
    expect(document.activeElement).toBe(row);
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(focusedPaneViewport().scrollTop).toBe(0);

    expect(pressAfterPrefix("h", row).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-1"));
    expect(pressKey("j", sidebarRow("thr-1")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(row);
    expect(pressKey("k", row).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-1"));
  });

  it("leaves Escape to bb while thread rows are selected", async () => {
    await mountPlugin();
    pressAfterPrefix("h");
    const row = sidebarRow("thr-1");
    sidebarRow("thr-2").setAttribute("data-sidebar-thread-selected", "");

    expect(pressKey("Escape", row).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(row);

    sidebarRow("thr-2").removeAttribute("data-sidebar-thread-selected");
    expect(pressKey("Escape", row).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pane("pane-1"));
  });

  it("moves with the arrow keys, goes to the ends with g, G, Home and End, and splits with v and s", async () => {
    await mountPlugin();
    pressAfterPrefix("h");

    expect(pressKey("ArrowDown", sidebarRow("thr-1")).defaultPrevented).toBe(true);
    pressKey("ArrowDown", sidebarRow("thr-2"));
    expect(document.activeElement).toBe(sidebarRow("thr-3"));
    expect(pressKey("ArrowUp", sidebarRow("thr-3")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-2"));

    expect(pressKey("g", sidebarRow("thr-2")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-1"));
    expect(pressKey("End", sidebarRow("thr-1")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-3"));
    expect(pressKey("Home", sidebarRow("thr-3")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-1"));
    press({ key: "G", shiftKey: true }, sidebarRow("thr-1"));
    expect(document.activeElement).toBe(sidebarRow("thr-3"));

    expect(pressKey("v", sidebarRow("thr-3")).defaultPrevented).toBe(true);
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-3", options: { split: true } },
    ]);
    expect(pressKey("s", sidebarRow("thr-3")).defaultPrevented).toBe(true);
    expect(threadsOpen).toHaveBeenCalledWith({
      threadId: "thr-3",
      split: "down",
      file: null,
    });
  });

  it("goes to the first thread on a single g, without waiting for a second one", async () => {
    await mountPlugin();
    pressAfterPrefix("h");
    press({ key: "G", shiftKey: true }, sidebarRow("thr-1"));

    pressKey("g", sidebarRow("thr-3"));
    expect(document.activeElement).toBe(sidebarRow("thr-1"));

    expect(pressKey("j", sidebarRow("thr-1")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-2"));
  });

  it.each(["q", "Escape"])("returns to the pane on %s", async (key) => {
    await mountPlugin();
    pressAfterPrefix("h");

    expect(pressKey(key, sidebarRow("thr-1")).defaultPrevented).toBe(true);

    expect(document.activeElement).toBe(pane("pane-1"));
    expect(messageBoxRequests()).toBe(1);
  });

  it("stays on the row on a plain l, and returns to the pane on the key that the tmux config binds to the pane on the right", async () => {
    await mountPlugin();
    pressAfterPrefix("h");
    const row = sidebarRow("thr-1");

    expect(pressKey("l", row).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(row);

    expect(pressAfterPrefix("l", row).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pane("pane-1"));
    expect(messageBoxRequests()).toBe(1);
  });

  it("pages through the rows with PageDown and PageUp, and with Ctrl-f and Ctrl-b", async () => {
    await mountPlugin();
    pressAfterPrefix("h");

    expect(pressKey("PageDown", sidebarRow("thr-1")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-3"));
    expect(pressCtrl("b", sidebarRow("thr-3")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-1"));
    expect(pressCtrl("f", sidebarRow("thr-1")).defaultPrevented).toBe(true);
    expect(pressKey("PageUp", sidebarRow("thr-3")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-1"));
  });

  it("leaves every key that is no list key and no split key to bb on a thread row", async () => {
    await mountPlugin();
    pressAfterPrefix("h");
    const row = sidebarRow("thr-1");
    const trigger = page.querySelector<HTMLElement>('[data-sidebar="trigger"]');
    const sidebarClick = onEvent(trigger ?? page, "click");

    for (const key of ["j", "k", "l", "h"]) {
      expect(pressCtrl(key, row).defaultPrevented, key).toBe(false);
    }
    for (const key of [":", ",", "f", " ", "e", "/"]) {
      expect(pressKey(key, row).defaultPrevented, key).toBe(false);
    }
    expect(press({ key: "H", shiftKey: true }, row).defaultPrevented).toBe(false);
    expect(press({ key: "L", shiftKey: true }, row).defaultPrevented).toBe(false);

    expect(document.activeElement).toBe(row);
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(sidebarClick).not.toHaveBeenCalled();
    expect(getUiState().chooser).toEqual({ open: false });
  });
});

describe("more chooser keys", () => {
  it("filters on /, returns to the list on Escape and opens to the right on v", async () => {
    await mountPlugin();
    pressCtrl("a");
    pressKey("w");

    pressKey("/", chooserList());
    const filter = screen.getByRole("combobox", {
      name: "Filter threads by title or project",
    });
    expect(document.activeElement).toBe(filter);
    fireEvent.change(filter, { target: { value: "gam" } });
    expect(chooserTitles()).toEqual(["Gamma"]);
    pressKey("Escape", filter);
    expect(document.activeElement).toBe(chooserList());

    pressKey("v", chooserList());

    expect(getUiState().chooser).toEqual({ open: false });
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-3", options: { split: true } },
    ]);
  });

  it("moves with j, k and Ctrl-n and jumps to the pane of a thread that is already open", async () => {
    await mountPlugin();
    pressAfterPrefix("w");
    expect(screen.getAllByRole("option")[1].textContent).toContain("in a pane");

    pressKey("j", chooserList());
    pressKey("j", chooserList());
    pressKey("k", chooserList());
    pressCtrl("n", chooserList());
    pressCtrl("p", chooserList());
    pressKey("s", chooserList());

    expect(threadsOpen).not.toHaveBeenCalled();
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-2" },
    ]);
  });

  it("goes to the first row on a single g or Home and to the last on G or End", async () => {
    await mountPlugin();
    pressAfterPrefix("w");
    const selected = (): string | null =>
      screen.getByRole("option", { selected: true }).firstElementChild?.textContent ?? null;

    pressKey("End", chooserList());
    expect(selected()).toBe("Gamma");
    pressKey("g", chooserList());
    expect(selected()).toBe("Alpha");
    press({ key: "G", shiftKey: true }, chooserList());
    expect(selected()).toBe("Gamma");
    pressKey("Home", chooserList());
    expect(selected()).toBe("Alpha");
  });
});

describe("a new thread from the chooser", () => {
  const PLACEHOLDER_TO_THE_RIGHT = {
    method: "toThread",
    threadId: "thr-3",
    options: { split: true },
  };
  const NEW_THREAD_SCREEN = {
    method: "toCompose",
    options: { focusPrompt: true },
  };

  it("opens a pane to the right on Ctrl-a then v then Enter and turns it into the New thread screen", async () => {
    await mountPlugin();
    pressCtrl("a");
    pressKey("v");
    expect(chooserTitles()).toEqual(["New thread", "Alpha", "Beta", "Gamma"]);

    pressKey("Enter", chooserList());

    expect(getUiState().chooser).toEqual({ open: false });
    expect(view.inspection.navigateCalls).toEqual([PLACEHOLDER_TO_THE_RIGHT]);

    await afterFrames(2);
    expect(view.inspection.navigateCalls).toEqual([PLACEHOLDER_TO_THE_RIGHT]);

    bbOpensPane("thr-3");
    await afterFrames(2);

    expect(view.inspection.navigateCalls).toEqual([
      PLACEHOLDER_TO_THE_RIGHT,
      NEW_THREAD_SCREEN,
    ]);
    expect(getUiState().notice).toBeNull();
  });

  it("opens a pane below on Ctrl-a then s then c, from a thread row, and stops waiting when the mouse is pressed", async () => {
    await mountPlugin();
    pressCtrl("a");
    pressKey("s");
    pressKey("j", chooserList());

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const key = pressKey("c", chooserList());

    expect(key.defaultPrevented).toBe(true);
    expect(getUiState().chooser).toEqual({ open: false });
    expect(threadsOpen).toHaveBeenCalledWith({
      threadId: "thr-3",
      split: "down",
      file: null,
    });

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    bbOpensPane("thr-3");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(getUiState().notice).toBeNull();
    vi.useRealTimers();
    await afterFrames(2);

    expect(view.inspection.navigateCalls).toEqual([]);
    expect(getUiState().notice).toBeNull();
  });

  it("says that the new pane was not opened when its 3 seconds pass without a mouse press", async () => {
    await mountPlugin();
    pressCtrl("a");
    pressKey("s");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    pressKey("Enter", chooserList());
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(getUiState().notice?.text).toBe("Could not open the new pane.");
  });

  it("puts the cursor back in the message box when the new pane does not show in time", async () => {
    await mountPlugin();
    const composer = fixture("composer");
    composer.focus();
    pressAfterPrefix("s", composer);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    pressKey("Enter", chooserList());
    expect(document.activeElement).toBe(document.body);
    expect(messageBoxRequests()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(getUiState().notice?.text).toBe("Could not open the new pane.");
    expect(messageBoxRequests()).toBe(1);
  });

  it("does not take the plugin's own press on a pane for a mouse press: after Ctrl-a then l during the wait, the new pane still becomes the New thread screen", async () => {
    await mountPlugin();
    pressCtrl("a");
    pressKey("v");
    pressKey("Enter", chooserList());
    expect(view.inspection.navigateCalls).toEqual([PLACEHOLDER_TO_THE_RIGHT]);

    const pointerDown = onEvent(pane("pane-2"), "pointerdown");
    expect(pressAfterPrefix("l").defaultPrevented).toBe(true);
    expect(pointerDown).toHaveBeenCalledTimes(1);
    bbOpensPane("thr-3");
    await afterFrames(3);

    expect(view.inspection.navigateCalls).toContainEqual(NEW_THREAD_SCREEN);
    expect(getUiState().notice).toBeNull();
  });

  it("moves to the New thread screen that Ctrl-a then c made during the wait and says that the new pane kept its thread", async () => {
    await mountPlugin();
    pressCtrl("a");
    pressKey("s");
    pressKey("Enter", chooserList());
    expect(threadsOpen).toHaveBeenCalledTimes(1);

    pressCtrl("a");
    pressKey("c");
    expect(view.inspection.navigateCalls).toEqual([NEW_THREAD_SCREEN]);
    bbShowsNewThreadScreenInFocusedPane();
    bbOpensPane("thr-3");
    await afterFrames(2);

    expect(view.inspection.navigateCalls).toEqual([
      NEW_THREAD_SCREEN,
      NEW_THREAD_SCREEN,
    ]);
    expect(getUiState().notice?.text).toBe(
      "bb shows the New thread screen in one pane only, so you were moved to it. The new pane kept the thread it opened with.",
    );
  });

  it("lets the New thread row of a chooser that is opened again during the wait replace the first request", async () => {
    await mountPlugin();
    pressCtrl("a");
    pressKey("s");
    pressKey("Enter", chooserList());
    expect(threadsOpen).toHaveBeenCalledTimes(1);

    pressCtrl("a");
    pressKey("v");
    expect(chooserTitles()).toEqual(["New thread", "Alpha", "Beta", "Gamma"]);
    pressKey("Enter", chooserList());
    expect(view.inspection.navigateCalls).toEqual([PLACEHOLDER_TO_THE_RIGHT]);
    bbOpensPane("thr-3");
    await afterFrames(3);

    expect(threadsOpen).toHaveBeenCalledTimes(1);
    expect(view.inspection.navigateCalls).toEqual([
      PLACEHOLDER_TO_THE_RIGHT,
      NEW_THREAD_SCREEN,
    ]);
    expect(getUiState().notice).toBeNull();
  });

  it("says that the thread is closed when the mouse is pressed while every thread is in a pane and the new pane was not asked for yet", async () => {
    await mountPlugin({
      layout: {
        panes: [
          ...TWO_PANES.panes,
          {
            paneId: "pane-3",
            threadId: "thr-3",
            isFocused: false,
            rect: { x: 0, y: 0.5, width: 1, height: 0.5 },
          },
        ],
      },
    });
    pressCtrl("a");
    pressKey("v");

    pressKey("Enter", chooserList());
    expect(view.inspection.navigateCalls).toHaveLength(1);
    expect(view.inspection.navigateCalls[0]).toMatchObject({ method: "toCompose" });

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(getUiState().notice).toBeNull();
    bbShowsNewThreadScreenInFocusedPane();
    await afterFrames(2);

    expect(view.inspection.navigateCalls).toHaveLength(1);
    expect(getUiState().notice?.text).toBe(
      "Could not open the new pane. The thread that was in the pane is closed. Open it again from the sidebar.",
    );
  });

  it("moves to the pane that already shows the New thread screen and says why", async () => {
    pane("pane-2").innerHTML = "<div data-app-composer></div>";
    await mountPlugin({
      layout: {
        panes: [
          TWO_PANES.panes[0],
          { ...TWO_PANES.panes[1], threadId: null },
        ],
      },
    });
    pressCtrl("a");
    pressKey("v");

    pressKey("Enter", chooserList());

    expect(view.inspection.navigateCalls).toEqual([NEW_THREAD_SCREEN]);
    expect(getUiState().notice?.text).toBe(
      "bb shows the New thread screen in one pane only, so you were moved to it.",
    );
  });

  it("offers no new thread on Ctrl-a then w, where c is left alone", async () => {
    await mountPlugin();
    pressCtrl("a");
    pressKey("w");
    expect(chooserTitles()).toEqual(["Alpha", "Beta", "Gamma"]);

    const key = pressKey("c", chooserList());

    expect(key.defaultPrevented).toBe(false);
    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
    expect(view.inspection.navigateCalls).toEqual([]);
  });
});

// What bb 0.50.1 renders for a single pane (SecondaryPanelLayout.tsx): the
// pane element keeps its id, but has neither the focused mark nor a
// tabindex, so it cannot take the cursor.
describe("with a single pane", () => {
  beforeEach(() => {
    pane("pane-2").remove();
    pane("pane-1").removeAttribute("data-focused");
    pane("pane-1").removeAttribute("tabindex");
  });

  it("enters the sidebar on Ctrl-a then h and has no other pane to move to", async () => {
    await mountPlugin({ layout: null });

    expect(pressAfterPrefix("l").defaultPrevented).toBe(true);
    await afterFrames(2);
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(messageBoxRequests()).toBe(0);

    pressAfterPrefix("h");
    expect(document.activeElement).toBe(sidebarRow("thr-1"));
    pressKey("q", sidebarRow("thr-1"));
    expect(document.activeElement).toBe(document.body);
    expect(messageBoxRequests()).toBe(1);
  });

  it("goes back from the sidebar to the message box, wherever the cursor was before", async () => {
    await mountPlugin({ layout: null });
    fixture("composer").focus();

    expect(pressAfterPrefix("h", fixture("composer")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-1"));
    pressKey("Escape", sidebarRow("thr-1"));
    expect(messageBoxRequests()).toBe(1);

    fixture("terminal-input").focus();
    pressAfterPrefix("h", fixture("terminal-input"));
    pressKey("q", sidebarRow("thr-1"));
    expect(messageBoxRequests()).toBe(2);
    expect(document.activeElement).toBe(document.body);
  });

  // bb marks the whole frame of the message box, with its pickers, and a
  // picker that closes leaves the cursor on its button.
  function messageBoxButton(): HTMLElement {
    const existing = page.querySelector<HTMLElement>("[data-testid='model-picker']");
    if (existing !== null) return existing;
    const button = document.createElement("button");
    button.dataset.testid = "model-picker";
    fixture("composer").after(button);
    return button;
  }

  it.each([
    ["the terminal", () => fixture("terminal-input")],
    ["a button", () => fixture("close-pane")],
    ["a button of the message box", messageBoxButton],
    ["a sidebar thread row", () => sidebarRow("thr-2")],
  ])(
    "puts the cursor back in the message box on Ctrl-a then o from %s",
    async (_name, place) => {
      await mountPlugin({ layout: null });
      place().focus();

      expect(pressAfterPrefix("o", place()).defaultPrevented).toBe(true);
      await afterFrames(2);

      expect(messageBoxRequests()).toBe(1);
      expect(document.activeElement).toBe(document.body);
      expect(view.inspection.navigateCalls).toEqual([]);
    },
  );

  it.each([
    ["a button", () => fixture("close-pane")],
    ["a button of the message box", messageBoxButton],
    ["a sidebar thread row", () => sidebarRow("thr-2")],
  ])("puts the cursor in the message box on i from %s", async (_name, place) => {
    await mountPlugin({ layout: null });
    place().focus();

    expect(pressKey("i", place()).defaultPrevented).toBe(true);

    expect(messageBoxRequests()).toBe(1);
    expect(document.activeElement).toBe(document.body);
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("leaves the cursor where it is on Ctrl-a then o when it is in the message box already", async () => {
    await mountPlugin({ layout: null });
    fixture("composer").focus();

    expect(pressAfterPrefix("o", fixture("composer")).defaultPrevented).toBe(true);
    await afterFrames(2);

    expect(document.activeElement).toBe(fixture("composer"));
    expect(messageBoxRequests()).toBe(0);
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("marks the open thread in the chooser and splits to the right from it", async () => {
    await mountPlugin({ layout: null });

    pressCtrl("a");
    pressKey("v");
    expect(screen.getAllByRole("option")[1].textContent).toContain(
      "focused pane",
    );
    pressKey("j", chooserList());
    pressKey("j", chooserList());
    pressKey("Enter", chooserList());

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-2", options: { split: true } },
    ]);
  });

  it("does nothing on the zoom and close keys", async () => {
    await mountPlugin({ layout: null });
    const click = onEvent(fixture("close-pane"), "click");

    pressCtrl("a");
    pressKey("x");
    pressCtrl("a");
    pressKey("z");

    expect(click).not.toHaveBeenCalled();
    expect(threadsPaneAction).not.toHaveBeenCalled();
    expect(getUiState().notice).toBeNull();
  });
});

describe("on a page that shows no panes, such as Settings", () => {
  function showSettingsPage(): HTMLInputElement {
    const field = document.createElement("input");
    page.querySelector("main")?.replaceChildren(field);
    field.focus();
    return field;
  }

  it.each(["l", "o"])(
    "stays on the page when Ctrl-a then %s is pressed in a text field",
    async (key) => {
      await mountPlugin();
      const field = showSettingsPage();

      expect(pressAfterPrefix(key, field).defaultPrevented).toBe(true);
      await afterFrames(2);

      expect(view.inspection.navigateCalls).toEqual([]);
      expect(messageBoxRequests()).toBe(0);
      expect(document.activeElement).toBe(field);
      expect(pressKey("j", field).defaultPrevented).toBe(false);
    },
  );

  // bb lists no message box while such a page fills the window. The button
  // that records a shortcut in bb's keyboard settings stops recording when it
  // loses the cursor.
  it.each([
    ["a button", "<button></button>"],
    ["a switch", '<button role="switch" aria-checked="false"></button>'],
  ])("leaves the cursor on %s on i, and says nothing", async (_name, html) => {
    await mountPlugin({ composerThreadId: "thr-3" });
    const field = showSettingsPage();
    field.insertAdjacentHTML("afterend", html);
    const control = field.nextElementSibling as HTMLElement;
    control.focus();
    const blur = onEvent(control, "blur");

    expect(pressKey("i", control).defaultPrevented).toBe(true);
    await afterFrames(2);

    expect(document.activeElement).toBe(control);
    expect(blur).not.toHaveBeenCalled();
    expect(messageBoxRequests()).toBe(0);
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(getUiState().notice).toBeNull();
    expect(pressKey("i", field).defaultPrevented).toBe(false);
  });

  it("leaves the cursor on a sidebar thread row on i, where q still leaves the row", async () => {
    await mountPlugin({ composerThreadId: "thr-3" });
    showSettingsPage();
    const row = sidebarRow("thr-1");
    pressAfterPrefix("h");
    expect(document.activeElement).toBe(row);

    expect(pressKey("i", row).defaultPrevented).toBe(true);
    await afterFrames(2);

    expect(document.activeElement).toBe(row);
    expect(messageBoxRequests()).toBe(0);
    expect(getUiState().notice).toBeNull();
    expect(pressKey("q", row).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it("does not zoom the panes of other bb windows", async () => {
    await mountPlugin();
    showSettingsPage();

    pressCtrl("a");
    pressKey("z");

    expect(threadsPaneAction).not.toHaveBeenCalled();
    expect(getUiState().notice?.text).toBe("Could not zoom this pane.");
  });

  it.each([
    ["v", "Enter"],
    ["s", "c"],
  ])(
    "opens no pane for a new thread on Ctrl-a then %s then %s, stays on the page and says why",
    async (splitKey, newThreadKey) => {
      await mountPlugin();
      const field = showSettingsPage();
      pressCtrl("a", field);
      pressKey(splitKey, field);
      expect(chooserTitles()).toEqual(["New thread", "Alpha", "Beta", "Gamma"]);

      pressKey(newThreadKey, chooserList());
      await afterFrames(2);

      expect(getUiState().chooser).toEqual({ open: false });
      expect(view.inspection.navigateCalls).toEqual([]);
      expect(threadsOpen).not.toHaveBeenCalled();
      expect(getUiState().notice?.text).toBe(
        "This page shows no panes, so no new pane was opened.",
      );
      expect(document.activeElement).toBe(field);
    },
  );
});

describe("settings", () => {
  it("handles no key while the plugin is switched off", async () => {
    await mountPlugin({ settings: { enabled: false } });
    const row = sidebarRow("thr-1");
    row.focus();

    expect(pressCtrl("a").defaultPrevented).toBe(false);
    expect(pressKey("[").defaultPrevented).toBe(false);
    expect(pressKey("j", row).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(row);
    expect(getUiState().prefixArmed).toBe(false);
    expect(getUiState().copyMode).toEqual({ active: false });
  });

  it.each(["ctrl+x", "f12", "a", "nonsense", "auto"])(
    "takes the prefix from the tmux config whatever prefixKey value bb still has stored, here %j, which is no setting",
    async (prefixKey) => {
      await mountPlugin({ settings: { prefixKey } });

      expect(pressCtrl("x").defaultPrevented).toBe(false);
      expect(pressKey("F12").defaultPrevented).toBe(false);
      expect(getUiState().prefixArmed).toBe(false);
      expect(getBridge()?.settings).not.toHaveProperty("prefixKey");
      expect(pressCtrl("a").defaultPrevented).toBe(true);
      expect(screen.getByRole("status").textContent).toBe("Ctrl-a");
      pressKey("?");
      expect(helpPrefixLine()).toBe("Prefix: Ctrl-a, from ~/.tmux.conf");
      act(() => updateUiState({ helpOpen: false }));

      await changeSettings({ prefixKey: "ctrl+b" });

      expect(pressCtrl("b").defaultPrevented).toBe(false);
      expect(pressCtrl("a").defaultPrevented).toBe(true);
    },
  );

  it("goes by no value of a setting it does not define", async () => {
    await mountPlugin({
      settings: {
        leaderKey: ",",
        ctrlHjkl: "everywhere",
        focusAfterPaneMove: "pane",
        sequenceTimeoutMs: 400,
      },
    });
    const pointerDown = onEvent(pane("pane-2"), "pointerdown");

    expect(pressKey("j").defaultPrevented).toBe(false);
    expect(pressCtrl("l").defaultPrevented).toBe(false);
    expect(pressCtrl("l", fixture("terminal-input")).defaultPrevented).toBe(false);
    for (const key of [",", "f", "f"]) {
      expect(pressKey(key).defaultPrevented, key).toBe(false);
    }
    expect(focusedPaneViewport().scrollTop).toBe(0);
    expect(pointerDown).not.toHaveBeenCalled();
    expect(getUiState().chooser).toEqual({ open: false });

    pressAfterPrefix("h");
    pressKey("q", sidebarRow("thr-1"));
    expect(messageBoxRequests()).toBe(1);
  });

  it.each([
    ["sidebar", "thr-1"],
    ["recent", "thr-2"],
  ])("numbers the threads in %s order", async (threadOrder, secondThread) => {
    const list = sidebarRow("thr-3").parentElement;
    list?.prepend(sidebarRow("thr-3"));
    await mountPlugin({ settings: { threadOrder } });

    pressCtrl("a");
    pressKey("2");

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: secondThread },
    ]);
  });
});

describe("a plugin that is switched off", () => {
  const TMUX_CALL = { method: "tmuxConfig", input: null };
  const OFF_NOTICE =
    'Tmux keys are off. Turn on "Enable tmux keys" in the settings of the plugin, or run: bb plugin config tmux set enabled true';

  beforeEach(installBrowserFakes);
  afterEach(removeBrowserFakes);

  function expectNoKeyHandled(): void {
    const row = sidebarRow("thr-1");
    row.focus();
    for (const event of [
      pressCtrl("a"),
      pressCtrl("b"),
      pressKey("["),
      pressKey("i"),
      pressKey("j", row),
    ]) {
      expect(event.defaultPrevented).toBe(false);
    }
    expect(document.activeElement).toBe(row);
    expect(getUiState().prefixArmed).toBe(false);
    expect(getUiState().copyMode).toEqual({ active: false });
    row.blur();
  }

  it.each<[string, OverlayOptions]>([
    ["nobody has switched on", { asInstalled: true }],
    [
      "was switched off, whatever its other settings say",
      { settings: { enabled: false, copyOnSelect: "on", threadOrder: "recent" } },
    ],
  ])(
    "handles no key, asks the server nothing and copies nothing for a plugin that %s",
    async (_state, options) => {
      await mountPlugin(options);

      expect(view.inspection.rpcCalls).toEqual([]);
      expect(getBridge()).toBeNull();
      expectNoKeyHandled();
      await selectWithMouse(lineText("line-1"), 0, 5);

      expect(pageSelection().toString()).toBe("alpha");
      expect(execCommand).not.toHaveBeenCalled();
      expect(mounted.inspection.experimental_clipboardWrites).toEqual([]);
      expect(getUiState().notice).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(view.inspection.navigateCalls).toEqual([]);
      expect(view.inspection.sdkCalls).toEqual([]);
      expect(messageBoxRequests()).toBe(0);
      expect(storedSnapshot()).toBeNull();
      expect(document.documentElement.hasAttribute(SWITCHED_ON_ATTRIBUTE)).toBe(false);
    },
  );

  it("marks the page for its pane border and its focus ring only while it is on", async () => {
    await mountPlugin({ asInstalled: true });

    await changeSettings({ enabled: true });
    expect(document.documentElement.hasAttribute(SWITCHED_ON_ATTRIBUTE)).toBe(true);

    await changeSettings({ enabled: false });
    expect(document.documentElement.hasAttribute(SWITCHED_ON_ATTRIBUTE)).toBe(false);
  });

  it("forgets the thread that it would reopen after a restart when it is switched off", async () => {
    await mountPlugin();
    expect(storedSnapshot()).not.toBeNull();

    await changeSettings({ enabled: false });

    expect(storedSnapshot()).toBeNull();
  });

  it("does not reopen a thread from before the time it was off when it is switched on in a window that still shows the New thread screen", async () => {
    window.history.replaceState(null, "", NEW_THREAD_ROUTE);
    window.localStorage.setItem(
      PLUGIN_STORAGE_KEYS.layoutSnapshot,
      JSON.stringify({ version: 1, savedAt: 1, focusedThreadId: "thr-1", panes: [] }),
    );
    await mountPlugin({ asInstalled: true, layout: null, contextThreadId: null });

    await changeSettings({ enabled: true });

    expect(view.inspection.navigateCalls).toEqual([]);
    expect(storedSnapshot()).toMatchObject({ focusedThreadId: null });
  });

  it("does not go back to a thread that a pane showed before the time it was off", async () => {
    await mountPlugin({ tmuxConfig: null });
    bbFocusesThread("thr-3");

    await changeSettings({ enabled: false });
    await changeSettings({ enabled: true });
    pressAfterPrefix("l", undefined, "b");

    expect(view.inspection.navigateCalls).toEqual([]);
    expect(getUiState().notice?.text).toBe(
      "This pane has not shown another thread yet.",
    );
  });

  it.each(["open-thread-chooser", "show-keys", "toggle-paused"])(
    "says that the plugin is off and how to turn it on, in the place of what the command %s does",
    async (id) => {
      await mountPlugin({ asInstalled: true });

      await runCommand(id);

      expect(getUiState().notice?.text).toBe(OFF_NOTICE);
      expect(getUiState()).toMatchObject({
        chooser: { open: false },
        helpOpen: false,
        paused: false,
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(view.inspection.rpcCalls).toEqual([]);
    },
  );

  it("says so again for every run of a command", async () => {
    await mountPlugin({ settings: { enabled: false } });

    await runCommand("show-keys");
    const first = getUiState().notice;
    await runCommand("show-keys");

    expect(getUiState().notice?.text).toBe(OFF_NOTICE);
    expect(getUiState().notice?.id).not.toBe(first?.id);
  });

  it("takes effect at once when it is switched on: it asks the server, builds its keys and lets the commands act", async () => {
    await mountPlugin({ asInstalled: true });

    await changeSettings({ enabled: true });

    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
    await selectWithMouse(lineText("line-1"), 0, 5);
    expect(copiedTexts).toEqual(["alpha"]);
    expect(pressCtrl("a").defaultPrevented).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Ctrl-a");
    expect(pressKey("w").defaultPrevented).toBe(true);
    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
    pressKey("q", chooserList());
    await runCommand("show-keys");
    expect(getUiState().helpOpen).toBe(true);
    expect(getUiState().notice?.text).not.toBe(OFF_NOTICE);
  });

  it("handles no key between being switched on and the answer of the server", async () => {
    const server = tmuxServer();
    await mountPlugin({ asInstalled: true, tmuxServer: server.tmuxConfig });

    await changeSettings({ enabled: true });

    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
    expectNoKeyHandled();

    await server.answer(tmuxConfigOf(TMUX_CONFIG));

    expect(pressCtrl("a").defaultPrevented).toBe(true);
  });

  it("ends an armed prefix at once when it is switched off, and takes no key after that", async () => {
    await mountPlugin();
    pressCtrl("a");
    expect(screen.getByRole("status").textContent).toBe("Ctrl-a");

    await changeSettings({ enabled: false });

    expect(getUiState().prefixArmed).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(getBridge()).toBeNull();
    expect(pressKey("w").defaultPrevented).toBe(false);
    expect(getUiState().chooser).toEqual({ open: false });
    expectNoKeyHandled();
  });

  it("does not carry an armed prefix over to the next time it is switched on", async () => {
    await mountPlugin();
    pressCtrl("a");

    await changeSettings({ enabled: false });
    await changeSettings({ enabled: true });

    expect(getUiState().prefixArmed).toBe(false);
    expect(pressKey("w").defaultPrevented).toBe(false);
    expect(getUiState().chooser).toEqual({ open: false });
    expect(pressAfterPrefix("w").defaultPrevented).toBe(true);
    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
  });

  it("leaves copy mode at once when it is switched off", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey("v");
    expect(modePill()).toBe("SELECT");

    await changeSettings({ enabled: false });

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(modePill()).toBeNull();
    expect(screen.queryByTestId("copy-cursor")).toBeNull();
    expect(pressKey("j").defaultPrevented).toBe(false);
    expect(pressKey("q").defaultPrevented).toBe(false);
  });

  it.each([
    ["the thread chooser", "open-thread-chooser", "Thread chooser"],
    ["the key help", "show-keys", "Tmux keys"],
  ])("closes %s at once when it is switched off", async (_what, command, name) => {
    await mountPlugin();
    await runCommand(command);
    expect(screen.getByRole("dialog", { name })).toBeTruthy();

    await changeSettings({ enabled: false });

    expect(getUiState()).toMatchObject({
      chooser: { open: false },
      helpOpen: false,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ends a pause of the keys, so that they work when it is switched on again", async () => {
    await mountPlugin();
    await runCommand("toggle-paused");

    await changeSettings({ enabled: false });
    await changeSettings({ enabled: true });

    expect(getUiState().paused).toBe(false);
    expect(pressCtrl("a").defaultPrevented).toBe(true);
  });

  it("copies nothing on a mouse selection once it is switched off, and asks the server again and copies again once it is switched on again", async () => {
    await mountPlugin();
    await changeSettings({ enabled: false });

    await selectWithMouse(lineText("line-1"), 0, 5);

    expect(execCommand).not.toHaveBeenCalled();
    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);

    await changeSettings({ enabled: true });
    await selectWithMouse(lineText("line-2"), 0, 5);

    expect(copiedTexts).toEqual(["delta"]);
    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL, TMUX_CALL]);
  });
});

describe("the tmux config", () => {
  const TMUX_CALL = { method: "tmuxConfig", input: null };
  const CONFIG_ANSWER = tmuxConfigOf(TMUX_CONFIG);

  function expectNoKeyHandled(): void {
    const row = sidebarRow("thr-1");
    row.focus();
    expect(pressCtrl("a").defaultPrevented).toBe(false);
    expect(pressCtrl("b").defaultPrevented).toBe(false);
    expect(pressKey("j", row).defaultPrevented).toBe(false);
    expect(pressKey("i").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(row);
    expect(getUiState().prefixArmed).toBe(false);
    row.blur();
  }

  function helpSourceLine(): string | null {
    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    return within(help).getByText(/stock tmux/).textContent;
  }

  it("handles no key while the server has not answered, then takes the keys of the tmux config", async () => {
    const server = tmuxServer();
    await mountPlugin({ tmuxServer: server.tmuxConfig });

    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
    expect(getBridge()).toBeNull();
    expectNoKeyHandled();

    await server.answer(CONFIG_ANSWER);

    expect(pressCtrl("b").defaultPrevented).toBe(false);
    expect(pressCtrl("a").defaultPrevented).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Ctrl-a");
    pressKey("?");
    expect(helpPrefixLine()).toBe("Prefix: Ctrl-a, from ~/.tmux.conf");
    expect(helpSourceLine()).toBe(
      "The keys of stock tmux with ~/.tmux.conf applied to them.",
    );
    expect(
      screen.getByRole("dialog", { name: "Tmux keys" }).textContent,
    ).toContain("Ctrl-a 1-9");
  });

  it("takes the tmux prefix C-^ with the Shift that a US keyboard needs for ^", async () => {
    await mountPlugin({ tmuxConfig: "set -g prefix C-^" });

    expect(
      press({ key: "^", code: "Digit6", ctrlKey: true, shiftKey: true }).defaultPrevented,
    ).toBe(true);
    expect(getUiState().prefixArmed).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Ctrl-^");
    pressKey("?");
    expect(helpPrefixLine()).toBe("Prefix: Ctrl-^, from ~/.tmux.conf");
  });

  it("takes the tmux prefix M-X for Alt-Shift-x, and not for Alt-x", async () => {
    await mountPlugin({ tmuxConfig: "set -g prefix M-X" });

    expect(press({ key: "x", code: "KeyX", altKey: true }).defaultPrevented).toBe(false);
    expect(getUiState().prefixArmed).toBe(false);
    expect(
      press({ key: "X", code: "KeyX", altKey: true, shiftKey: true }).defaultPrevented,
    ).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Alt-Shift-x");
    pressKey("?");
    expect(helpPrefixLine()).toBe("Prefix: Alt-Shift-x, from ~/.tmux.conf");
  });

  it("takes the tmux prefix C-Space, and neither tmux's own Ctrl-b nor a plain key", async () => {
    await mountPlugin({ tmuxConfig: "set -g prefix C-Space" });

    expect(pressKey("a").defaultPrevented).toBe(false);
    expect(pressCtrl("b").defaultPrevented).toBe(false);
    expect(pressCtrl(" ").defaultPrevented).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Ctrl-Space");
    pressKey("?");
    expect(helpPrefixLine()).toBe("Prefix: Ctrl-Space, from ~/.tmux.conf");
  });

  it("uses Ctrl-b when the tmux config sets a prefix without Ctrl or Alt, and leaves that key to typing", async () => {
    await mountPlugin({ tmuxConfig: "set -g prefix `" });

    expect(pressKey("`").defaultPrevented).toBe(false);
    expect(getUiState().prefixArmed).toBe(false);
    expect(pressCtrl("b").defaultPrevented).toBe(true);
    pressKey("?");
    expect(helpPrefixLine()).toBe(
      "Prefix: Ctrl-b, tmux's default (the prefix ` in ~/.tmux.conf cannot be used in bb)",
    );
  });

  it("uses the keys of stock tmux as soon as the call fails", async () => {
    consoleWarn.mockImplementation(() => {});
    const server = tmuxServer();
    await mountPlugin({ tmuxServer: server.tmuxConfig });
    expectNoKeyHandled();

    await server.fail(new Error("the server part is not running"));

    expect(consoleWarn).toHaveBeenCalledWith(
      "[tmux] reading the tmux config failed",
      expect.any(Error),
    );
    consoleWarn.mockClear();
    expect(pressCtrl("a").defaultPrevented).toBe(false);
    expect(pressCtrl("b").defaultPrevented).toBe(true);
    pressKey("?");
    expect(helpPrefixLine()).toBe(
      "Prefix: Ctrl-b, tmux's default (the tmux config could not be read)",
    );
    expect(helpSourceLine()).toBe(
      "The tmux config could not be read, so these are the keys of stock tmux.",
    );
  });

  it("uses the keys of stock tmux after 2000 ms without an answer, and those of the tmux config once the answer still arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = tmuxServer();
    await mountPlugin({ tmuxServer: server.tmuxConfig });

    await act(() => vi.advanceTimersByTimeAsync(1999));
    expectNoKeyHandled();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(pressCtrl("a").defaultPrevented).toBe(false);
    expect(pressCtrl("b").defaultPrevented).toBe(true);
    expect(pressKey("v").defaultPrevented).toBe(true);
    expect(getUiState().chooser.open).toBe(false);
    pressAfterPrefix("%", undefined, "b");
    expect(getUiState().chooser).toEqual({ open: true, placement: "right" });
    act(() => updateUiState({ chooser: { open: false } }));

    await server.answer(CONFIG_ANSWER);

    expect(pressCtrl("b").defaultPrevented).toBe(false);
    pressAfterPrefix("v");
    expect(getUiState().chooser).toEqual({ open: true, placement: "right" });
    act(() => updateUiState({ chooser: { open: false } }));
    pressAfterPrefix("?");
    expect(helpPrefixLine()).toBe("Prefix: Ctrl-a, from ~/.tmux.conf");
    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
  });

  it("shows the key help without keys while the tmux config is not known", async () => {
    const server = tmuxServer();
    await mountPlugin({ tmuxServer: server.tmuxConfig });

    await runCommand("show-keys");

    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    expect(within(help).queryByText(/^Prefix: /)).toBeNull();
    expect(within(help).getByText("The tmux config is still being read.")).toBeTruthy();

    await server.answer(CONFIG_ANSWER);

    expect(helpPrefixLine()).toBe("Prefix: Ctrl-a, from ~/.tmux.conf");
    expect(help.textContent).toContain("Ctrl-a 1-9");
  });

  it("reads the tmux config again on the key that the config binds to source-file, takes the new keys and says so", async () => {
    const changed = tmuxConfigOf(`${TMUX_CONFIG}\nbind e new-window\nunbind c`);
    const tmuxConfig = vi
      .fn<() => Promise<TmuxConfig>>()
      .mockResolvedValueOnce(CONFIG_ANSWER)
      .mockResolvedValueOnce(changed);
    await mountPlugin({ tmuxServer: tmuxConfig });
    pressAfterPrefix("e");
    expect(view.inspection.navigateCalls).toEqual([]);

    expect(pressAfterPrefix("r").defaultPrevented).toBe(true);
    expect(getUiState().notice?.text).toBe("Config reloaded");
    await act(async () => {});

    expect(tmuxConfig).toHaveBeenCalledTimes(2);
    expect(getUiState().notice?.text).toBe("The tmux config was read again.");
    pressAfterPrefix("c");
    expect(view.inspection.navigateCalls).toEqual([]);
    pressAfterPrefix("e");
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toCompose", options: { focusPrompt: true } },
    ]);
  });

  it.each<[string, () => Promise<void>]>([
    [
      "the Config text setting changes",
      () => changeSettings({ tmuxConfigText: "set -g prefix C-s\nbind e new-window\n" }),
    ],
    [
      "the server part says that another config file was chosen",
      () => view.behavior.emitRealtime(CONFIG_FILE_CHANGED, {}),
    ],
  ])(
    "asks the server again when %s, and takes the keys of the new answer without a reload",
    async (_what, change) => {
      const changed = tmuxConfigOf(
        `${TMUX_CONFIG}\nset -g prefix C-s\nbind e new-window\n`,
      );
      const tmuxConfig = vi
        .fn<() => Promise<TmuxConfig>>()
        .mockResolvedValueOnce(CONFIG_ANSWER)
        .mockResolvedValueOnce(changed);
      await mountPlugin({ tmuxServer: tmuxConfig });

      await change();

      expect(view.inspection.rpcCalls).toEqual([TMUX_CALL, TMUX_CALL]);
      expect(pressCtrl("a").defaultPrevented).toBe(false);
      expect(pressCtrl("s").defaultPrevented).toBe(true);
      expect(screen.getByRole("status").textContent).toBe("Ctrl-s");
      pressKey("e");
      expect(view.inspection.navigateCalls).toEqual([
        { method: "toCompose", options: { focusPrompt: true } },
      ]);
    },
  );

  it("does not ask the server again when another setting changes", async () => {
    const tmuxConfig = vi.fn(async () => CONFIG_ANSWER);
    await mountPlugin({ tmuxServer: tmuxConfig });

    await changeSettings({ scrollStepPx: 120, threadOrder: "recent" });

    expect(tmuxConfig).toHaveBeenCalledTimes(1);
    expect(getBridge()?.settings).toMatchObject({
      scrollStepPx: 120,
      threadOrder: "recent",
    });
    expect(pressCtrl("a").defaultPrevented).toBe(true);
  });

  it("still reads the tmux config again on the key bound to source-file while the Config text setting is set", async () => {
    const tmuxConfig = vi.fn(async () => CONFIG_ANSWER);
    await mountPlugin({
      tmuxServer: tmuxConfig,
      settings: { tmuxConfigText: "bind -r H resize-pane -L 5" },
    });

    pressAfterPrefix("r");
    await act(async () => {});

    expect(tmuxConfig).toHaveBeenCalledTimes(2);
    expect(getUiState().notice?.text).toBe("The tmux config was read again.");
  });

  it("keeps the keys and says so when the tmux config cannot be read again", async () => {
    consoleWarn.mockImplementation(() => {});
    const tmuxConfig = vi
      .fn<() => Promise<TmuxConfig>>()
      .mockResolvedValueOnce(CONFIG_ANSWER)
      .mockRejectedValueOnce(new Error("the server part is not running"));
    await mountPlugin({ tmuxServer: tmuxConfig });

    pressAfterPrefix("r");
    await act(async () => {});
    consoleWarn.mockClear();

    expect(getUiState().notice?.text).toBe(
      "The tmux config could not be read again. The keys stay as they were.",
    );
    pressAfterPrefix("v");
    expect(getUiState().chooser).toEqual({ open: true, placement: "right" });
  });

  it("says that the tmux config could not be read in full when the server could not read the config file that was chosen", async () => {
    const tmuxConfig = vi
      .fn<() => Promise<TmuxConfig>>()
      .mockResolvedValueOnce(CONFIG_ANSWER)
      .mockResolvedValueOnce({
        ...stockTmuxConfig(),
        unreadable: true,
        namedFile: true,
      });
    await mountPlugin({ tmuxServer: tmuxConfig });

    pressAfterPrefix("r");
    await act(async () => {});

    expect(getUiState().notice?.text).toBe(
      "The tmux config could not be read in full. The key help says what is missing.",
    );
    expect(pressCtrl("a").defaultPrevented).toBe(false);
    expect(pressCtrl("b").defaultPrevented).toBe(true);
  });

  it.each([
    "bind e swap-window -t -1 \\; select-window -t -1",
    "bind e set -g mouse on \\; display 'Mouse: ON'",
    "bind e select-pane -t 2 \\; kill-pane",
  ])(
    "takes the key of %j and does nothing, because bb has no equivalent for its first command",
    async (line) => {
      await mountPlugin({ tmuxConfig: line });
      const closed = onEvent(fixture("close-pane"), "click");

      expect(pressAfterPrefix("e", undefined, "b").defaultPrevented).toBe(true);

      expect(view.inspection.navigateCalls).toEqual([]);
      expect(getUiState().notice).toBeNull();
      expect(closed).not.toHaveBeenCalled();
    },
  );

  it("jumps to the last and to the first thread on keys bound to tmux's names for its highest and its lowest window", async () => {
    await mountPlugin({
      tmuxConfig: "bind e select-window -t '{end}'\nbind E select-window -t ^",
    });

    expect(pressAfterPrefix("e", undefined, "b").defaultPrevented).toBe(true);
    expect(pressAfterPrefix("E", undefined, "b").defaultPrevented).toBe(true);

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-3" },
      { method: "toThread", threadId: "thr-1" },
    ]);
  });

  it("moves to the pane on the right on a key bound to tmux's name for the pane on that side", async () => {
    await mountPlugin({ tmuxConfig: "bind e select-pane -t '{right-of}'" });
    const pressed = onEvent(pane("pane-2"), "pointerdown");

    expect(pressAfterPrefix("e", undefined, "b").defaultPrevented).toBe(true);

    expect(pressed).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(view.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr-2" },
      ]),
    );
  });

  it("goes around to the pane at the right edge of the window on a key bound to tmux's name for the pane on the left, where the key for a move to the left goes to the sidebar", async () => {
    await mountPlugin({
      tmuxConfig: "bind e select-pane -t '{left-of}'\nbind f select-pane -L",
    });
    const pressed = onEvent(pane("pane-2"), "pointerdown");

    expect(pressAfterPrefix("e", undefined, "b").defaultPrevented).toBe(true);

    expect(pressed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(sidebarRow("thr-1"));
    await waitFor(() =>
      expect(view.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr-2" },
      ]),
    );

    pressAfterPrefix("f", undefined, "b");

    expect(pressed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(sidebarRow("thr-1"));
  });

  describe("with two panes one above the other, where tmux finds no pane on the left of the upper one", () => {
    const STACKED: PluginSidebarSplitLayout = {
      panes: [
        {
          paneId: "pane-1",
          threadId: "thr-1",
          isFocused: true,
          rect: { x: 0, y: 0, width: 1, height: 0.5 },
        },
        {
          paneId: "pane-2",
          threadId: "thr-2",
          isFocused: false,
          rect: { x: 0, y: 0.5, width: 1, height: 0.5 },
        },
      ],
    };

    it("does nothing on a key bound to tmux's name for that pane, and closes nothing with the kill-pane behind it", async () => {
      await mountPlugin({
        layout: STACKED,
        tmuxConfig: "bind e select-pane -t '{left-of}' \\; kill-pane",
      });
      const closed = onEvent(fixture("close-pane"), "click");
      const pressed = onEvent(pane("pane-2"), "pointerdown");

      expect(pressAfterPrefix("e", undefined, "b").defaultPrevented).toBe(true);
      await afterFrames(3);

      expect(closed).not.toHaveBeenCalled();
      expect(pressed).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(sidebarRow("thr-1"));
      expect(view.inspection.navigateCalls).toEqual([]);
      expect(getUiState().notice).toBeNull();
    });

    it("still goes to the sidebar on a key bound to the move to the left, and runs the kill-pane behind it", async () => {
      await mountPlugin({
        layout: STACKED,
        tmuxConfig: "bind e select-pane -L \\; kill-pane",
      });
      const closed = onEvent(fixture("close-pane"), "click");

      expect(pressAfterPrefix("e", undefined, "b").defaultPrevented).toBe(true);

      expect(document.activeElement).toBe(sidebarRow("thr-1"));
      expect(closed).toHaveBeenCalledTimes(1);
    });
  });

  // tmux looks for the pane of such a target while the window is still
  // zoomed: the zoomed pane fills it, and the other pane is where it was.
  describe("with the left one of two panes zoomed, which is at the left and at the right edge of the window in tmux", () => {
    function zoomLeftPane(): void {
      pane("pane-1").setAttribute("data-maximized", "true");
      pane("pane-2").setAttribute("aria-hidden", "true");
    }

    it("does nothing on a key bound to tmux's name for the pane on the right, and closes nothing with the kill-pane behind it", async () => {
      await mountPlugin({
        tmuxConfig: "bind e select-pane -t '{right-of}' \\; kill-pane",
      });
      zoomLeftPane();
      const closed = onEvent(fixture("close-pane"), "click");
      const pressed = onEvent(pane("pane-2"), "pointerdown");

      expect(pressAfterPrefix("e", undefined, "b").defaultPrevented).toBe(true);
      await afterFrames(3);

      expect(closed).not.toHaveBeenCalled();
      expect(pressed).not.toHaveBeenCalled();
      expect(view.inspection.navigateCalls).toEqual([]);
      expect(getUiState().notice).toBeNull();
    });

    it.each(["{left-of}", "{up-of}", "{down-of}"])(
      "moves to the other pane on a key bound to %s, around the edge of the window",
      async (target) => {
        await mountPlugin({ tmuxConfig: `bind e select-pane -t '${target}'` });
        zoomLeftPane();
        const pressed = onEvent(pane("pane-2"), "pointerdown");

        expect(pressAfterPrefix("e", undefined, "b").defaultPrevented).toBe(true);

        expect(pressed).toHaveBeenCalledTimes(1);
        await waitFor(() =>
          expect(view.inspection.navigateCalls).toEqual([
            { method: "toThread", threadId: "thr-2" },
          ]),
        );
      },
    );

    it("still moves to the pane on the right on a key bound to the move to the right, for which tmux removes the zoom first", async () => {
      await mountPlugin({ tmuxConfig: "bind e select-pane -R" });
      zoomLeftPane();
      const pressed = onEvent(pane("pane-2"), "pointerdown");

      expect(pressAfterPrefix("e", undefined, "b").defaultPrevented).toBe(true);

      expect(pressed).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(view.inspection.navigateCalls).toEqual([
          { method: "toThread", threadId: "thr-2" },
        ]),
      );
    });
  });

  it("shows the text of a display-message as a notice", async () => {
    await mountPlugin({ tmuxConfig: 'bind e display-message "Hello from tmux"' });

    expect(pressAfterPrefix("e", undefined, "b").defaultPrevented).toBe(true);

    expect(getUiState().notice?.text).toBe("Hello from tmux");
  });

  it("arms the same keys with the second prefix of the tmux config", async () => {
    await mountPlugin({ tmuxConfig: "set -g prefix2 C-s" });

    expect(pressCtrl("s").defaultPrevented).toBe(true);
    expect(getUiState().prefixArmed).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Ctrl-s");
    pressKey("%");
    expect(getUiState().chooser).toEqual({ open: true, placement: "right" });
    act(() => updateUiState({ chooser: { open: false } }));

    pressAfterPrefix('"', undefined, "b");
    expect(getUiState().chooser).toEqual({ open: true, placement: "down" });
  });

  it("runs a key of the root table without the prefix, also in a text field, when the key has Ctrl or Alt or is a function key", async () => {
    await mountPlugin({
      tmuxConfig: "bind -n F5 choose-tree\nbind -n M-w choose-tree\nbind -n h choose-tree",
    });
    const composer = fixture("composer");
    composer.focus();

    expect(pressKey("h", composer).defaultPrevented).toBe(false);
    expect(getUiState().chooser.open).toBe(false);

    expect(pressKey("F5", composer).defaultPrevented).toBe(true);
    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
    act(() => updateUiState({ chooser: { open: false } }));

    expect(
      press({ key: "w", code: "KeyW", altKey: true }, composer).defaultPrevented,
    ).toBe(true);
    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
  });

  it("runs a key of the root table after the prefix as well, when the prefix table does not bind the key", async () => {
    await mountPlugin({ tmuxConfig: "bind -n M-w choose-tree" });

    pressCtrl("b");
    expect(press({ key: "w", code: "KeyW", altKey: true }).defaultPrevented).toBe(true);

    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
    expect(getUiState().prefixArmed).toBe(false);
  });

  it("keeps the prefix armed when it is pressed again and the tmux config binds no key to send-prefix", async () => {
    await mountPlugin({ tmuxConfig: "set -g prefix C-a\nunbind C-b" });

    pressCtrl("a");
    expect(pressCtrl("a").defaultPrevented).toBe(true);

    expect(screen.getByRole("status").textContent).toBe("Ctrl-a");
    expect(pressKey("w").defaultPrevented).toBe(true);
    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
  });

  it("passes a root key on to bb when the tmux config binds it to a command bb has no equivalent for", async () => {
    await mountPlugin({ tmuxConfig: "bind -n C-k clear-history" });

    expect(pressCtrl("k", fixture("terminal-input")).defaultPrevented).toBe(false);
  });
});

describe("stock tmux, on a machine without a tmux config", () => {
  function pressAfterStockPrefix(key: string, target?: EventTarget): KeyboardEvent {
    return pressAfterPrefix(key, target, "b");
  }

  it("arms on Ctrl-b, tmux's own prefix, and says in the key help that no tmux config was found", async () => {
    await mountPlugin({ tmuxConfig: null });

    expect(pressCtrl("a").defaultPrevented).toBe(false);
    expect(pressCtrl("b").defaultPrevented).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Ctrl-b");
    pressKey("?");

    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    expect(helpPrefixLine()).toBe(
      "Prefix: Ctrl-b, tmux's default (no tmux config sets a prefix)",
    );
    expect(
      within(help).getByText(
        "No tmux config was found, so these are the keys of stock tmux.",
      ),
    ).toBeTruthy();
    expect(help.textContent).toContain("Ctrl-b 0-9");
    expect(help.textContent).toContain("Copy mode, emacs keys");
    expect(help.textContent).not.toContain("Ctrl-a 1-9");
    expect(help.textContent).not.toContain("Ctrl-b h");
  });

  it.each([
    ["%", "right"],
    ['"', "down"],
    ["w", "replace"],
    ["s", "replace"],
  ] as const)("opens the thread chooser on Ctrl-b %s", async (key, placement) => {
    await mountPlugin({ tmuxConfig: null });

    expect(pressAfterStockPrefix(key).defaultPrevented).toBe(true);

    expect(getUiState().chooser).toEqual({ open: true, placement });
  });

  it("starts a new thread on Ctrl-b c and jumps to the first thread on Ctrl-b 0, because tmux counts windows from 0", async () => {
    await mountPlugin({ tmuxConfig: null });

    pressAfterStockPrefix("c");
    pressAfterStockPrefix("0");
    pressAfterStockPrefix("2");

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toCompose", options: { focusPrompt: true } },
      { method: "toThread", threadId: "thr-1" },
      { method: "toThread", threadId: "thr-3" },
    ]);
  });

  it("goes to the next and the previous thread on Ctrl-b n and p", async () => {
    await mountPlugin({ tmuxConfig: null });

    pressAfterStockPrefix("n");
    pressAfterStockPrefix("p");

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-2" },
      { method: "toThread", threadId: "thr-3" },
    ]);
  });

  it("moves between the panes with Ctrl-b and an arrow, and goes on without the prefix for half a second", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await mountPlugin({ tmuxConfig: null });
    const pressed = onEvent(pane("pane-2"), "pointerdown");

    expect(pressAfterStockPrefix("ArrowRight").defaultPrevented).toBe(true);
    expect(pressed).toHaveBeenCalledTimes(1);
    expect(getUiState().prefixArmed).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(pressKey("ArrowRight").defaultPrevented).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(501));
    expect(getUiState().prefixArmed).toBe(false);
    expect(pressKey("ArrowRight").defaultPrevented).toBe(false);
  });

  it("enters the sidebar on Ctrl-b and the left arrow from the leftmost pane, moves through it with the arrows at once, and goes back with the right arrow", async () => {
    await mountPlugin({ tmuxConfig: null });

    expect(pressAfterStockPrefix("ArrowLeft").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-1"));

    expect(pressKey("ArrowDown", sidebarRow("thr-1")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sidebarRow("thr-2"));

    pressAfterStockPrefix("ArrowLeft", sidebarRow("thr-2"));
    expect(pressKey("ArrowRight", sidebarRow("thr-2")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pane("pane-1"));
  });

  it("goes to the pane that had the focus before on Ctrl-b ;", async () => {
    await mountPlugin({ tmuxConfig: null });
    bbFocusesThread("thr-2");
    const pressed = onEvent(pane("pane-1"), "pointerdown");

    expect(pressAfterStockPrefix(";").defaultPrevented).toBe(true);

    expect(pressed).toHaveBeenCalledTimes(1);
    expect(getUiState().notice).toBeNull();
  });

  it("goes back to the thread that the pane showed before on Ctrl-b l", async () => {
    await mountPlugin({ tmuxConfig: null });
    bbFocusesThread("thr-3");

    pressAfterStockPrefix("l");

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-1" },
    ]);
  });

  it("goes back from the New thread screen to the thread that the pane showed last on Ctrl-b l", async () => {
    await mountPlugin({ tmuxConfig: null });
    bbFocusesThread("thr-3");
    const bridge = getBridge();
    if (bridge === null || bridge.layout === null) throw new Error("no split layout");
    setBridge({
      ...bridge,
      context: { ...bridge.context, threadId: null },
      layout: {
        panes: bridge.layout.panes.map((layoutPane) =>
          layoutPane.isFocused ? { ...layoutPane, threadId: null } : layoutPane,
        ),
      },
    });

    pressAfterStockPrefix("l");

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-3" },
    ]);
    expect(getUiState().notice).toBeNull();
  });

  it("goes around the thread rows of the sidebar with the arrows, from the first row to the last and back", async () => {
    await mountPlugin({ tmuxConfig: null });
    pressAfterStockPrefix("ArrowLeft");
    const first = sidebarRow("thr-1");
    expect(document.activeElement).toBe(first);

    expect(pressKey("ArrowUp", first).defaultPrevented).toBe(true);
    const last = document.activeElement;
    expect(last).not.toBe(first);
    expect(pressKey("ArrowDown", last ?? first).defaultPrevented).toBe(true);

    expect(document.activeElement).toBe(first);
  });

  it("sends Ctrl-b itself on when it is pressed twice, as tmux binds it to send-prefix", async () => {
    await mountPlugin({ tmuxConfig: null });
    const terminal = fixture("terminal-input");
    terminal.focus();

    expect(pressCtrl("b", terminal).defaultPrevented).toBe(true);
    const second = pressCtrl("b", terminal);

    expect(second.defaultPrevented).toBe(false);
    expect(getUiState().prefixArmed).toBe(false);
  });

  it.each(["h", "j", "k", "v", "y", "Escape", "M"])(
    "does nothing on Ctrl-b %s, which stock tmux does not bind, and does not pass the key on",
    async (key) => {
      await mountPlugin({ tmuxConfig: null });

      expect(pressAfterStockPrefix(key).defaultPrevented).toBe(true);

      expect(getUiState().chooser.open).toBe(false);
      expect(getUiState().notice).toBeNull();
      expect(view.inspection.navigateCalls).toEqual([]);
      expect(getUiState().prefixArmed).toBe(false);
    },
  );

  it.each(["d", ":", ",", "!", " ", "t"])(
    "does nothing on Ctrl-b %j, which tmux binds to a command bb has no equivalent for",
    async (key) => {
      await mountPlugin({ tmuxConfig: null });

      expect(pressAfterStockPrefix(key).defaultPrevented).toBe(true);

      expect(getUiState().chooser.open).toBe(false);
      expect(getUiState().helpOpen).toBe(false);
      expect(getUiState().notice).toBeNull();
      expect(view.inspection.navigateCalls).toEqual([]);
    },
  );

  it("opens the highlighted thread of the chooser in a split with tmux's split keys, and not with v and s, which stock tmux does not bind to a split", async () => {
    await mountPlugin({ tmuxConfig: null });
    pressAfterStockPrefix("w");
    const list = chooserList();

    pressKey("v", list);
    pressKey("s", list);
    expect(getUiState().chooser.open).toBe(true);
    pressKey("j", list);
    pressKey("%", list);

    expect(getUiState().chooser.open).toBe(false);
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-2" },
    ]);
  });

  it("opens the thread of a sidebar row in a split with tmux's split keys, and leaves the row with q", async () => {
    await mountPlugin({ tmuxConfig: null });
    const row = sidebarRow("thr-3");
    row.focus();

    expect(pressKey("v", row).defaultPrevented).toBe(false);
    expect(pressKey("l", row).defaultPrevented).toBe(false);
    expect(pressKey("%", row).defaultPrevented).toBe(true);
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-3", options: { split: true } },
    ]);

    row.focus();
    expect(pressKey("q", row).defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(row);
  });

  it("still puts the cursor in the message box on i", async () => {
    await mountPlugin({ tmuxConfig: null });
    const before = messageBoxRequests();

    expect(pressKey("i").defaultPrevented).toBe(true);

    expect(messageBoxRequests()).toBe(before + 1);
  });

  describe("copy mode with tmux's emacs keys", () => {
    beforeEach(installBrowserFakes);
    afterEach(removeBrowserFakes);

    it("enters on Ctrl-b [, selects from Ctrl-Space, moves with Ctrl-f and copies and leaves on Alt-w", async () => {
      await mountPlugin({ tmuxConfig: null });

      expect(pressAfterStockPrefix("[").defaultPrevented).toBe(true);
      expect(modePill()).toBe("COPY");
      expect(cursorPlace()).toBe("line-3:0");

      expect(pressCtrl(" ").defaultPrevented).toBe(true);
      expect(modePill()).toBe("SELECT");
      expect(pressCtrl("f").defaultPrevented).toBe(true);
      expect(pressKey("ArrowRight").defaultPrevented).toBe(true);
      expect(pageSelection().toString()).toBe("ze");

      expect(press({ key: "w", code: "KeyW", altKey: true }).defaultPrevented).toBe(true);

      await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
      expect(copiedTexts).toEqual(["ze"]);
      expect(modePill()).toBeNull();
    });

    it("moves the cursor left on Ctrl-b Ctrl-b, which sends Ctrl-b to the pane, where the emacs keys bind it to cursor-left", async () => {
      await mountPlugin({ tmuxConfig: null });
      pressAfterStockPrefix("[");
      pressCtrl("f");
      pressCtrl("f");
      expect(cursorPlace()).toBe("line-3:2");

      expect(pressCtrl("b").defaultPrevented).toBe(true);
      expect(pressCtrl("b").defaultPrevented).toBe(true);

      expect(cursorPlace()).toBe("line-3:1");
      expect(modePill()).toBe("COPY");
      expect(getUiState().prefixArmed).toBe(false);
    });

    it("starts a selection on the prefix pressed twice when the prefix is Ctrl-Space, the only key of the emacs keys for it", async () => {
      await mountPlugin({
        tmuxConfig: "set -g prefix C-Space\nbind C-Space send-prefix",
      });
      pressCtrl(" ");
      pressKey("[");
      expect(modePill()).toBe("COPY");

      pressCtrl(" ");
      expect(pressCtrl(" ").defaultPrevented).toBe(true);

      expect(modePill()).toBe("SELECT");
      pressCtrl("f");
      expect(pageSelection().toString()).toBe("z");
    });

    it("drops the selection on Ctrl-g and leaves on q, Escape and Ctrl-c", async () => {
      await mountPlugin({ tmuxConfig: null });
      pressAfterStockPrefix("[");
      pressCtrl(" ");
      pressCtrl("f");

      expect(pressCtrl("g").defaultPrevented).toBe(true);
      expect(modePill()).toBe("COPY");
      expect(pageSelection().isCollapsed).toBe(true);

      expect(pressCtrl("c").defaultPrevented).toBe(true);
      expect(modePill()).toBeNull();
    });

    it.each(["h", "j", "k", "l", "v", "y", "w", "b", "$"])(
      "swallows %s, a vi key that tmux's emacs keys do not have",
      async (key) => {
        await mountPlugin({ tmuxConfig: null });
        pressAfterStockPrefix("[");

        expect(pressKey(key).defaultPrevented).toBe(true);

        expect(modePill()).toBe("COPY");
        expect(cursorPlace()).toBe("line-3:0");
      },
    );

    it("uses tmux's vi keys instead when the tmux config sets mode-keys vi, and they select the character under the cursor block as well", async () => {
      await mountPlugin({ tmuxConfig: "setw -g mode-keys vi" });
      pressAfterStockPrefix("[");

      expect(pressKey("l").defaultPrevented).toBe(true);
      expect(cursorPlace()).toBe("line-3:1");
      expect(pressKey(" ").defaultPrevented).toBe(true);
      expect(pageSelection().toString()).toBe("e");
      pressKey("l");
      expect(pageSelection().toString()).toBe("et");
      pressKey("Enter");

      await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
      expect(copiedTexts).toEqual(["et"]);
    });
  });
});

describe("loading and unloading", () => {
  it("handles no key before the overlay has published the user's settings", async () => {
    await mountContentScripts();
    const row = sidebarRow("thr-1");
    row.focus();

    expect(pressCtrl("a").defaultPrevented).toBe(false);
    expect(pressKey("j", row).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(row);
    expect(getUiState().prefixArmed).toBe(false);
  });

  it("handles no key and copies nothing while bb has no values for the settings", async () => {
    installBrowserFakes();
    await mountPlugin({ settings: null });

    expect(getBridge()).toBeNull();
    expect(pressCtrl("a").defaultPrevented).toBe(false);
    expect(pressKey("[").defaultPrevented).toBe(false);
    expect(pressKey("j", sidebarRow("thr-1")).defaultPrevented).toBe(false);
    expect(getUiState().copyMode).toEqual({ active: false });
    await selectWithMouse(lineText("line-1"), 0, 5);

    expect(execCommand).not.toHaveBeenCalled();
    expect(mounted.inspection.experimental_clipboardWrites).toEqual([]);
    expect(getUiState().notice).toBeNull();
    removeBrowserFakes();
  });

  it("does not carry a pause or an open popup over to the next time the plugin is loaded", async () => {
    await mountPlugin();
    await runCommand("toggle-paused");
    await runCommand("show-keys");
    expect(getUiState()).toMatchObject({ paused: true, helpOpen: true });

    await act(async () => {
      await mounted.lifecycle.dispose();
    });
    expect(getUiState()).toMatchObject({ paused: false, helpOpen: false });
    await mountContentScripts();

    expect(pressCtrl("a").defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("dispose", () => {
  it("prevents no key once the content script is disposed", async () => {
    await mountPlugin();
    expect(mounted.inspection.mountedIds).toEqual(["keys"]);
    pressCtrl("a");
    expect(getUiState().prefixArmed).toBe(true);

    await act(async () => {
      await mounted.lifecycle.dispose();
    });

    expect(getUiState().prefixArmed).toBe(false);
    expect(pressCtrl("a").defaultPrevented).toBe(false);
    expect(pressKey("w").defaultPrevented).toBe(false);
    const row = sidebarRow("thr-1");
    row.focus();
    expect(pressKey("j", row).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(row);
    expect(getUiState().chooser).toEqual({ open: false });
    expect(view.inspection.navigateCalls).toEqual([]);
  });
});

describe("copy mode", () => {
  beforeEach(installBrowserFakes);
  afterEach(removeBrowserFakes);

  it("enters on Ctrl-a then [ and shows the COPY pill and the cursor", async () => {
    await mountPlugin();

    pressCtrl("a");
    expect(pressKey("[").defaultPrevented).toBe(true);

    expect(getUiState().copyMode).toMatchObject({ active: true, selecting: false });
    expect(modePill()).toBe("COPY");
    expect(cursorPlace()).toBe("line-3:0");
    expect(pageSelection().isCollapsed).toBe(true);
    expect(cursorBlock()).toEqual({
      left: "40px",
      top: "140px",
      width: "8px",
      height: "20px",
    });
  });

  it("tells a screen reader of the prefix and of the copy mode states in words, in one element that stays in the page, and says nothing on a key that changes nothing", async () => {
    await mountPlugin();
    const region = screen.getByTestId("pill-announcer");
    const heard = listenToLiveRegion(region);
    expect(region.textContent).toBe("");

    pressCtrl("a");
    expect(heard()).toEqual(["Prefix armed"]);

    pressKey("[");
    expect(heard()).toEqual(["Copy mode"]);
    expect(modePill()).toBe("COPY");

    pressKey("k");
    pressKey("l");
    pressKey("z");
    expect(heard()).toEqual([]);

    pressKey("v");
    expect(heard()).toEqual(["Copy mode, selecting"]);
    expect(modePill()).toBe("SELECT");

    pressKey("l");
    expect(heard()).toEqual([]);

    pressCtrl("a");
    expect(heard()).toEqual(["Copy mode, selecting, Prefix armed"]);

    pressKey("Escape");
    expect(getUiState().prefixArmed).toBe(false);
    expect(heard()).toEqual([]);
    expect(region.textContent).toBe("Copy mode, selecting");

    pressKey("q");
    expect(getUiState().copyMode.active).toBe(false);
    expect(heard()).toEqual(["Copy mode ended"]);

    pressCtrl("a");
    expect(heard()).toEqual(["Prefix armed"]);
    expect(screen.getByTestId("pill-announcer")).toBe(region);
  });

  it("moves the cursor on k, l, j and h", async () => {
    await mountPlugin();
    enterCopyMode();

    expect(pressKey("k").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-2:0");
    expect(cursorBlock()).toMatchObject({ left: "40px", top: "120px" });

    expect(pressKey("l").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-2:1");
    expect(cursorBlock()).toMatchObject({ left: "48px", top: "120px" });

    expect(pressKey("j").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-3:1");

    expect(pressKey("h").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-3:0");
    expect(pageSelection().isCollapsed).toBe(true);
    expect(focusedPaneViewport().scrollTop).toBe(0);
  });

  it("moves with the arrow keys and to the ends of a line on 0 and $", async () => {
    await mountPlugin();
    enterCopyMode();

    pressKey("ArrowUp");
    pressKey("ArrowRight");
    expect(cursorPlace()).toBe("line-2:1");
    press({ key: "$", shiftKey: true });
    expect(cursorPlace()).toBe("line-2:13");
    expect(cursorBlock()).toMatchObject({ left: "144px", width: "2px" });
    pressKey("0");
    expect(cursorPlace()).toBe("line-2:0");
    pressKey("ArrowDown");
    pressKey("ArrowLeft");
    expect(cursorPlace()).toBe("line-3:0");
  });

  it("moves by word on w and b, to the last character of a word on e and to the first character of the line on ^", async () => {
    await mountPlugin();
    enterCopyMode();

    expect(pressKey("w").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-3:5");
    expect(pressKey("e").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-3:7");
    expect(pressKey("w").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-3:9");
    expect(pressKey("b").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-3:5");
    expect(press({ key: "^", shiftKey: true }).defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-3:0");
    expect(pageSelection().isCollapsed).toBe(true);
    expect(focusedPaneViewport().scrollTop).toBe(0);
  });

  it("moves by paragraph on { and }", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey("l");

    expect(press({ key: "{", shiftKey: true }).defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-2:0");
    expect(press({ key: "{", shiftKey: true }).defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-1:0");
    expect(press({ key: "}", shiftKey: true }).defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-2:0");
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("moves to the first text on a single g and to the last on G", async () => {
    await mountPlugin();
    enterCopyMode();

    expect(pressKey("g").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-1:0");
    expect(press({ key: "G", shiftKey: true }).defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-3:14");
    expect(pageSelection().isCollapsed).toBe(true);
    expect(focusedPaneViewport().scrollTop).toBe(0);
  });

  it("moves to the top, middle and bottom line of the view on H, M and L", async () => {
    await mountPlugin();
    focusedPaneViewport().innerHTML = LONG_CONVERSATION;
    enterCopyMode();
    expect(cursorPlace()).toBe("line-9:0");

    expect(press({ key: "H", shiftKey: true }).defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-1:0");
    expect(press({ key: "M", shiftKey: true }).defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-5:0");
    expect(press({ key: "L", shiftKey: true }).defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-9:0");
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("selects with the word, paragraph and screen keys once v started selecting", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey("v");

    pressKey("e");
    expect(pageSelection().toString()).toBe("zeta");
    pressKey("w");
    expect(pageSelection().toString()).toBe("zeta e");
    press({ key: "{", shiftKey: true });
    expect(cursorPlace()).toBe("line-2:0");
    press({ key: "H", shiftKey: true });
    expect(cursorPlace()).toBe("line-1:0");
    expect(modePill()).toBe("SELECT");

    pressKey("y");
    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
    expect(execCommand).not.toHaveBeenCalled();
    const writes = mounted.inspection.experimental_clipboardWrites;
    expect(writes).toHaveLength(1);
    expect(writes[0].text.replace(/\s+/g, " ")).toBe("alpha beta gamma delta epsilon z");
  });

  it("keeps moving while a movement key is held", async () => {
    await mountPlugin();
    enterCopyMode();

    pressKey("l");
    const repeat = press({ key: "l", repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-3:2");
  });

  it.each(["y", "Enter"])(
    "selects from v to the cursor and copies it on %s with the browser's copy command",
    async (copyKey) => {
      await mountPlugin();
      enterCopyMode();
      pressKey("k");

      expect(pressKey("v").defaultPrevented).toBe(true);
      expect(modePill()).toBe("SELECT");
      expect(getUiState().copyMode).toMatchObject({ selecting: true });
      press({ key: "$", shiftKey: true });
      expect(pageSelection().toString()).toBe("delta epsilon");
      expect(cursorPlace()).toBe("line-2:13");

      expect(pressKey(copyKey).defaultPrevented).toBe(true);

      expect(execCommand.mock.calls).toEqual([["copy"]]);
      expect(copiedTexts).toEqual(["delta epsilon"]);
      await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
      expect(getUiState().copyMode).toEqual({ active: false });
      expect(pageSelection().toString()).toBe("");
      expect(modePill()).toBeNull();
      expect(screen.queryByTestId("copy-cursor")).toBeNull();
      expect(mounted.inspection.experimental_clipboardWrites).toEqual([]);
      await waitFor(() => expect(messageBoxRequests()).toBe(1));
      expect(document.activeElement).toBe(pane("pane-1"));
    },
  );

  it("starts selecting on Space with the character under the cursor block, and from the cursor again on a second Space", async () => {
    await mountPlugin();
    enterCopyMode();

    expect(pressKey(" ").defaultPrevented).toBe(true);
    expect(modePill()).toBe("SELECT");
    expect(pageSelection().toString()).toBe("z");
    pressKey("l");
    expect(pageSelection().toString()).toBe("ze");

    expect(pressKey(" ").defaultPrevented).toBe(true);
    expect(modePill()).toBe("SELECT");
    expect(pageSelection().toString()).toBe("e");
    pressKey("l");
    expect(pageSelection().toString()).toBe("et");

    pressKey("Enter");
    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
    expect(copiedTexts).toEqual(["et"]);
  });

  it("starts the selection over on v, which the tmux config binds to begin-selection as Space is", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey(" ");
    pressKey("l");
    expect(pageSelection().toString()).toBe("ze");

    pressKey("v");

    expect(modePill()).toBe("SELECT");
    expect(pageSelection().toString()).toBe("e");
    expect(cursorBlock()).toMatchObject({ left: "48px", top: "140px" });
    pressKey("l");
    expect(pageSelection().toString()).toBe("et");
  });

  it("drops the selection and stays in copy mode on Escape with tmux's own vi keys, which bind it to clear-selection", async () => {
    await mountPlugin({ tmuxConfig: "setw -g mode-keys vi" });
    pressAfterPrefix("[", undefined, "b");
    pressKey(" ");
    pressKey("l");
    expect(pageSelection().toString()).toBe("ze");

    expect(pressKey("Escape").defaultPrevented).toBe(true);

    expect(modePill()).toBe("COPY");
    expect(pageSelection().isCollapsed).toBe(true);
    expect(cursorPlace()).toBe("line-3:1");
    expect(pressKey("q").defaultPrevented).toBe(true);
    expect(modePill()).toBeNull();
  });

  it("just leaves copy mode, as tmux does, when the key that copies and leaves is pressed with nothing selected", async () => {
    await mountPlugin();
    enterCopyMode();

    expect(pressKey("y").defaultPrevented).toBe(true);

    await waitFor(() => expect(modePill()).toBeNull());
    expect(execCommand).not.toHaveBeenCalled();
    expect(getUiState().notice).toBeNull();
    await waitFor(() => expect(messageBoxRequests()).toBe(1));
  });

  it("copies the character under the cursor block, as tmux's vi keys do, when the key that copies and leaves follows v at once", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey("v");
    expect(pageSelection().toString()).toBe("z");

    expect(pressKey("y").defaultPrevented).toBe(true);

    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
    expect(copiedTexts).toEqual(["z"]);
    expect(modePill()).toBeNull();
  });

  it("leaves as well when selecting has started at the end of a line, where the block is on no character, and copies nothing", async () => {
    await mountPlugin();
    enterCopyMode();
    press({ key: "$", shiftKey: true });
    pressKey("v");
    expect(pageSelection().isCollapsed).toBe(true);

    expect(pressKey("y").defaultPrevented).toBe(true);

    await waitFor(() => expect(modePill()).toBeNull());
    expect(copiedTexts).toEqual([]);
    expect(mounted.inspection.experimental_clipboardWrites).toEqual([]);
    expect(getUiState().notice).toBeNull();
  });

  it("copies, drops the selection and stays in copy mode on a key that the tmux config binds to copy-selection", async () => {
    await mountPlugin({
      tmuxConfig: `${TMUX_CONFIG}\nbind -T copy-mode-vi y send-keys -X copy-selection`,
    });
    enterCopyMode();

    pressKey("y");
    await waitFor(() =>
      expect(getUiState().notice?.text).toBe(NOTHING_SELECTED_NOTICE),
    );
    expect(modePill()).toBe("COPY");

    pressKey("v");
    pressKey("l");
    pressKey("y");

    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
    expect(copiedTexts).toEqual(["ze"]);
    expect(modePill()).toBe("COPY");
    expect(pageSelection().isCollapsed).toBe(true);
    expect(cursorPlace()).toBe("line-3:1");
  });

  it("copies and keeps the selection on a key that the tmux config binds to copy-selection-no-clear", async () => {
    await mountPlugin({
      tmuxConfig: `${TMUX_CONFIG}\nbind -T copy-mode-vi y send-keys -X copy-selection-no-clear`,
    });
    enterCopyMode();
    pressKey("v");
    pressKey("l");

    pressKey("y");

    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
    expect(copiedTexts).toEqual(["ze"]);
    expect(modePill()).toBe("SELECT");
    expect(pageSelection().toString()).toBe("ze");
  });

  it("never runs the shell command that the tmux config gives to copy-pipe", async () => {
    await mountPlugin({
      tmuxConfig: `${TMUX_CONFIG}\nbind -T copy-mode-vi y send-keys -X copy-pipe-and-cancel "pbcopy"`,
    });
    enterCopyMode();
    pressKey("v");
    pressKey("l");

    pressKey("y");

    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
    expect(copiedTexts).toEqual(["ze"]);
    expect(JSON.stringify(getBridge()?.tmux)).not.toContain("pbcopy");
    expect(modePill()).toBeNull();
  });

  it("falls back to bb's plain-text copy when the browser refuses its copy command", async () => {
    await mountPlugin();
    execCommand.mockReturnValue(false);
    enterCopyMode();
    pressKey("v");
    press({ key: "$", shiftKey: true });

    pressKey("y");

    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
    expect(mounted.inspection.experimental_clipboardWrites).toEqual([
      { text: "zeta eta theta" },
    ]);
    expect(getUiState().copyMode).toEqual({ active: false });
  });

  it.each(["Escape", "q"])(
    "leaves on %s and clears the selection without copying",
    async (leaveKey) => {
      await mountPlugin();
      enterCopyMode();
      pressKey("v");
      pressKey("l");
      expect(pageSelection().toString()).toBe("ze");

      expect(pressKey(leaveKey).defaultPrevented).toBe(true);

      expect(getUiState().copyMode).toEqual({ active: false });
      expect(pageSelection().toString()).toBe("");
      expect(modePill()).toBeNull();
      expect(execCommand).not.toHaveBeenCalled();
      expect(getUiState().notice).toBeNull();
      expect(pressKey("j").defaultPrevented).toBe(false);
      expect(focusedPaneViewport().scrollTop).toBe(0);
    },
  );

  it.each(["Escape", "q"])(
    "puts the cursor back in the message box when %s leaves copy mode",
    async (leaveKey) => {
      await mountPlugin();
      const composer = fixture("composer");
      composer.focus();
      enterCopyMode(composer);
      expect(document.activeElement).toBe(pane("pane-1"));
      expect(messageBoxRequests()).toBe(0);

      pressKey(leaveKey, pane("pane-1"));

      expect(messageBoxRequests()).toBe(1);
      composer.focus();
      expect(pressKey("j", composer).defaultPrevented).toBe(false);
    },
  );

  it("leaves the cursor on the pane when a copy mode key finds the text under the cursor gone, so that the keys pressed next are not typed", async () => {
    await mountPlugin();
    const composer = fixture("composer");
    composer.focus();
    enterCopyMode(composer);
    lineText("line-3").replaceWith(document.createTextNode("zeta eta theta"));

    expect(pressKey("j", pane("pane-1")).defaultPrevented).toBe(true);

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(getUiState().notice?.text).toBe(
      "The selection was lost because bb unloaded that part of the conversation",
    );
    expect(messageBoxRequests()).toBe(0);
    expect(document.activeElement).toBe(pane("pane-1"));
  });

  it("takes the cursor off a button when copy mode is entered there, so that Space selects and Enter copies", async () => {
    await mountPlugin();
    const toggle = document.createElement("button");
    const click = vi.fn();
    toggle.addEventListener("click", click);
    focusedPaneViewport().append(toggle);
    toggle.focus();

    enterCopyMode(toggle);
    expect(document.activeElement).toBe(pane("pane-1"));

    expect(pressKey(" ", pane("pane-1")).defaultPrevented).toBe(true);
    expect(modePill()).toBe("SELECT");
    pressKey("l", pane("pane-1"));
    expect(pressKey("Enter", pane("pane-1")).defaultPrevented).toBe(true);
    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));

    expect(copiedTexts).toEqual(["ze"]);
    expect(click).not.toHaveBeenCalled();
    await waitFor(() => expect(messageBoxRequests()).toBe(1));
  });

  it("puts the cursor back in the message box when Ctrl-a then z ends copy mode", async () => {
    await mountPlugin();
    const composer = fixture("composer");
    composer.focus();
    enterCopyMode(composer);

    expect(pressAfterPrefix("z", pane("pane-1")).defaultPrevented).toBe(true);

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(threadsPaneAction).toHaveBeenCalledTimes(1);
    expect(messageBoxRequests()).toBe(1);
  });

  it("leaves the cursor to the pane move when Ctrl-a then l ends copy mode", async () => {
    await mountPlugin();
    const composer = fixture("composer");
    composer.focus();
    enterCopyMode(composer);

    expect(pressAfterPrefix("l", pane("pane-1")).defaultPrevented).toBe(true);
    expect(getUiState().copyMode).toEqual({ active: false });
    expect(messageBoxRequests()).toBe(0);
    bbFocusesThread("thr-2");
    await afterFrames(3);

    expect(document.activeElement).toBe(pane("pane-2"));
    expect(messageBoxRequests()).toBe(0);
  });

  it("leaves the cursor to the key help when Ctrl-a then ? ends copy mode, and puts it in the message box once the help closes", async () => {
    await mountPlugin();
    const composer = fixture("composer");
    composer.focus();
    enterCopyMode(composer);

    pressAfterPrefix("?", pane("pane-1"));
    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    expect(getUiState().copyMode).toEqual({ active: false });
    expect(help.contains(document.activeElement)).toBe(true);
    expect(messageBoxRequests()).toBe(0);

    pressKey("q", document.activeElement ?? help);

    await waitFor(() => expect(messageBoxRequests()).toBe(1));
  });

  it("swallows a key that means nothing in copy mode", async () => {
    await mountPlugin();
    enterCopyMode();

    for (const key of ["z", "i", "/", "?", "n", ":", "]", "Tab", "1", "Backspace", "Home"]) {
      expect(pressKey(key).defaultPrevented, key).toBe(true);
    }
    expect(press({ key: "N", shiftKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: "V", shiftKey: true }).defaultPrevented).toBe(true);

    expect(cursorPlace()).toBe("line-3:0");
    expect(getUiState().copyMode).toMatchObject({ active: true, selecting: false });
    expect(view.inspection.composer.focusCount).toBe(0);
    expect(focusedPaneViewport().scrollTop).toBe(0);
    expect(getUiState().notice).toBeNull();
  });

  it("swallows i on the pane and on a button, and stays in copy mode", async () => {
    await mountPlugin();
    enterCopyMode();

    expect(pressKey("i").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-3:0");
    const button = fixture("close-pane");
    button.focus();
    expect(pressKey("i", button).defaultPrevented).toBe(true);

    expect(getUiState().copyMode).toMatchObject({ active: true, selecting: false });
    expect(modePill()).toBe("COPY");
    expect(document.activeElement).toBe(button);
    expect(messageBoxRequests()).toBe(0);
    expect(getUiState().notice).toBeNull();
  });

  it("leaves Cmd+C and other shortcuts with Cmd or Alt to the browser and bb", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey("v");
    pressKey("l");

    expect(press({ key: "c", metaKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: "k", metaKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: "ArrowLeft", altKey: true }).defaultPrevented).toBe(false);

    expect(modePill()).toBe("SELECT");
    expect(pageSelection().toString()).toBe("ze");
  });

  it("moves half a page on Ctrl-d and Ctrl-u", async () => {
    await mountPlugin();
    enterCopyMode();

    expect(pressCtrl("u").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-1:0");
    expect(pressCtrl("d").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-3:0");
    expect(focusedPaneViewport().scrollTop).toBe(0);
  });

  // A view of 280 pixels shows the first eight of the nine lines in full:
  // half a page is seven lines and a whole page fourteen.
  describe("in a view that is lower than the conversation", () => {
    beforeEach(() => {
      const viewport = focusedPaneViewport();
      viewport.innerHTML = LONG_CONVERSATION;
      viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 280);
    });

    it.each([
      ["Ctrl-b and Ctrl-f", { key: "b", ctrlKey: true }, { key: "f", ctrlKey: true }],
      ["PageUp and PageDown", { key: "PageUp" }, { key: "PageDown" }],
    ])("moves a whole page on %s", async (_name, up, down) => {
      await mountPlugin();
      enterCopyMode();
      expect(cursorPlace()).toBe("line-8:0");

      expect(press(up).defaultPrevented).toBe(true);
      expect(cursorPlace()).toBe("line-1:0");
      expect(press(down).defaultPrevented).toBe(true);
      expect(cursorPlace()).toBe("line-9:0");
      expect(getUiState().copyMode).toMatchObject({ active: true });
    });

    it("moves half as far on Ctrl-d as on Ctrl-f", async () => {
      await mountPlugin();
      enterCopyMode();
      pressKey("g");

      pressCtrl("d");
      expect(cursorPlace()).toBe("line-8:0");
      pressKey("g");
      pressCtrl("f");
      expect(cursorPlace()).toBe("line-9:0");
    });

    it("enters copy mode one page up on Ctrl-a then PageUp", async () => {
      await mountPlugin();
      const composer = fixture("composer");
      composer.focus();

      expect(pressAfterPrefix("PageUp", composer).defaultPrevented).toBe(true);

      expect(modePill()).toBe("COPY");
      expect(cursorPlace()).toBe("line-1:0");
      expect(document.activeElement).toBe(pane("pane-1"));
      expect(pressKey("j", pane("pane-1")).defaultPrevented).toBe(true);
      expect(cursorPlace()).toBe("line-2:0");
    });

    it("goes up one more page on Ctrl-a then PageUp in copy mode", async () => {
      await mountPlugin();
      enterCopyMode();
      press({ key: "G", shiftKey: true });
      expect(cursorPlace()).toBe("line-9:12");

      pressAfterPrefix("PageUp");

      expect(getUiState().copyMode).toMatchObject({ active: true });
      expect(cursorPlace()).toBe("line-1:11");
    });
  });

  // Sixty lines of 20 pixels in a view of 280 pixels: a page is fourteen
  // lines, and the view can scroll from 0 to 920 pixels.
  describe("in a conversation that is longer than the view, scrolled to its end", () => {
    let viewport: HTMLElement;

    beforeEach(() => {
      viewport = scrollAsInABrowser(60, 280);
    });

    it("scrolls one page up on Ctrl-a then PageUp, from the message box, and keeps the cursor at its height on screen", async () => {
      await mountPlugin();
      const composer = fixture("composer");
      composer.focus();

      expect(pressAfterPrefix("PageUp", composer).defaultPrevented).toBe(true);

      expect(modePill()).toBe("COPY");
      expect(viewport.scrollTop).toBe(640);
      expect(cursorPlace()).toBe("line-45:0");
      expect(cursorBlock()).toMatchObject({ top: "240px" });
    });

    it("scrolls half a page on the first Ctrl-u, and back on Ctrl-d", async () => {
      await mountPlugin();
      enterCopyMode();
      expect(cursorPlace()).toBe("line-59:0");
      expect(cursorBlock()).toMatchObject({ top: "240px" });

      expect(pressCtrl("u").defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(780);
      expect(cursorPlace()).toBe("line-52:0");
      expect(cursorBlock()).toMatchObject({ top: "240px" });

      expect(pressCtrl("d").defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(920);
      expect(cursorPlace()).toBe("line-59:0");
    });

    it("scrolls a whole page on every PageUp and PageDown", async () => {
      await mountPlugin();
      enterCopyMode();

      pressKey("PageUp");
      expect(viewport.scrollTop).toBe(640);
      pressKey("PageUp");
      expect(viewport.scrollTop).toBe(360);
      expect(cursorPlace()).toBe("line-31:0");

      pressKey("PageDown");
      expect(viewport.scrollTop).toBe(640);
      expect(cursorPlace()).toBe("line-45:0");
      expect(cursorBlock()).toMatchObject({ top: "240px" });
    });

    it("goes on paging while the PageUp that followed the prefix is held", async () => {
      await mountPlugin();
      const composer = fixture("composer");
      composer.focus();
      pressAfterPrefix("PageUp", composer);
      expect(viewport.scrollTop).toBe(640);

      const first = press({ key: "PageUp", repeat: true }, pane("pane-1"));
      const second = press({ key: "PageUp", repeat: true }, pane("pane-1"));

      expect(first.defaultPrevented).toBe(true);
      expect(second.defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(80);
      expect(cursorPlace()).toBe("line-17:0");
      expect(modePill()).toBe("COPY");
    });

    it("moves only the cursor where the conversation cannot scroll any further", async () => {
      await mountPlugin();
      viewport.scrollTop = 100;
      enterCopyMode();
      expect(cursorPlace()).toBe("line-18:0");

      pressKey("PageUp");
      expect(viewport.scrollTop).toBe(0);
      expect(cursorPlace()).toBe("line-4:0");

      pressKey("PageUp");
      expect(viewport.scrollTop).toBe(0);
      expect(cursorPlace()).toBe("line-1:0");
      expect(getUiState().copyMode).toMatchObject({ active: true });
    });

    it("moves the cursor to the last line on PageDown at the end of the conversation", async () => {
      await mountPlugin();
      enterCopyMode();

      pressKey("PageDown");

      expect(viewport.scrollTop).toBe(920);
      expect(cursorPlace()).toBe("line-60:0");
    });
  });

  it.each([
    [undefined, 80],
    [120, 120],
  ])(
    "scrolls the conversation by the scroll step on Ctrl-e and Ctrl-y and stays in copy mode: %s",
    async (scrollStepPx, step) => {
      await mountPlugin(
        scrollStepPx === undefined ? {} : { settings: { scrollStepPx } },
      );
      const viewport = focusedPaneViewport();
      const wheelDeltas: number[] = [];
      viewport.addEventListener("wheel", (event) => {
        wheelDeltas.push((event as WheelEvent).deltaY);
      });
      enterCopyMode();
      pressKey("v");
      pressKey("l");

      expect(pressCtrl("e").defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(step);
      expect(pressCtrl("e").defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(2 * step);
      expect(pressCtrl("y").defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(step);

      expect(wheelDeltas).toEqual([step, step, -step]);
      expect(modePill()).toBe("SELECT");
      expect(pageSelection().toString()).toBe("ze");
      expect(cursorBlock()).toMatchObject({ left: "48px", top: "140px" });
    },
  );

  it("keeps scrolling while Ctrl-e is held", async () => {
    await mountPlugin();
    enterCopyMode();

    pressCtrl("e");
    const repeat = press({ key: "e", ctrlKey: true, repeat: true });

    expect(repeat.defaultPrevented).toBe(true);
    expect(focusedPaneViewport().scrollTop).toBe(160);
  });

  it("scrolls with no key outside copy mode", async () => {
    await mountPlugin();

    expect(pressCtrl("e").defaultPrevented).toBe(false);
    expect(pressCtrl("y").defaultPrevented).toBe(false);
    expect(pressKey("PageUp").defaultPrevented).toBe(false);
    expect(pressKey("PageDown").defaultPrevented).toBe(false);

    expect(focusedPaneViewport().scrollTop).toBe(0);
    expect(getUiState().copyMode).toEqual({ active: false });
  });

  it("leaves copy mode on the prefix then h, which goes to the sidebar as usual", async () => {
    await mountPlugin();
    enterCopyMode();

    expect(pressCtrl("a").defaultPrevented).toBe(true);
    expect(getUiState().copyMode).toMatchObject({ active: true });
    expect(pressKey("h").defaultPrevented).toBe(true);

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(modePill()).toBeNull();
    expect(document.activeElement).toBe(sidebarRow("thr-1"));
  });

  it("leaves copy mode on the prefix then l, which moves to the pane on the right as usual", async () => {
    await mountPlugin();
    const pointerDown = onEvent(pane("pane-2"), "pointerdown");
    enterCopyMode();

    expect(pressAfterPrefix("l").defaultPrevented).toBe(true);

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(pointerDown).toHaveBeenCalledTimes(1);
  });

  it("passes Ctrl-k and Ctrl-l, which tmux does not bind in copy mode, on to bb and stays in copy mode", async () => {
    await mountPlugin();
    const pointerDown = onEvent(pane("pane-2"), "pointerdown");
    enterCopyMode();

    for (const key of ["k", "l"]) {
      expect(pressCtrl(key).defaultPrevented, key).toBe(false);
    }

    expect(getUiState().copyMode).toMatchObject({ active: true });
    expect(cursorPlace()).toBe("line-3:0");
    expect(pointerDown).not.toHaveBeenCalled();
  });

  it("moves the cursor left on Ctrl-h, which tmux's vi keys bind as they bind h", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey("l");
    pressKey("l");

    expect(pressCtrl("h").defaultPrevented).toBe(true);

    expect(cursorPlace()).toBe("line-3:1");
    expect(modePill()).toBe("COPY");
  });

  it.each([
    ["Ctrl-v", { key: "v", ctrlKey: true }],
    ["/", { key: "/" }],
    ["n", { key: "n" }],
    ["V", { key: "V", shiftKey: true }],
  ])("swallows %s, which tmux binds in copy mode to a command bb has no equivalent for", async (_name, init) => {
    await mountPlugin();
    enterCopyMode();

    expect(press(init).defaultPrevented).toBe(true);

    expect(modePill()).toBe("COPY");
    expect(cursorPlace()).toBe("line-3:0");
    expect(getUiState().notice).toBeNull();
  });

  it("leaves copy mode and clears the selection on a pointer press", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey("v");
    pressKey("l");

    pressPointer(fixture("line-1"));

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(pageSelection().rangeCount).toBe(0);
    expect(modePill()).toBeNull();
  });

  it("leaves copy mode when the window loses focus", async () => {
    await mountPlugin();
    enterCopyMode();

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(getUiState().copyMode).toEqual({ active: false });
  });

  it("leaves copy mode when the cursor goes into the message box", async () => {
    await mountPlugin();
    enterCopyMode();
    const composer = fixture("composer");
    composer.focus();

    expect(pressKey("j", composer).defaultPrevented).toBe(false);

    expect(getUiState().copyMode).toEqual({ active: false });
  });

  it("leaves copy mode at once when the keys are paused", async () => {
    await mountPlugin();
    enterCopyMode();

    await runCommand("toggle-paused");

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(modePill()).toBeNull();
  });

  it("leaves copy mode when the plugin is unloaded", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey("v");
    pressKey("l");

    await act(async () => {
      await mounted.lifecycle.dispose();
    });

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(pageSelection().rangeCount).toBe(0);
    expect(pressKey("v").defaultPrevented).toBe(false);
  });

  it("leaves copy mode, without a notice, on the first key after bb showed another thread in the pane", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey("v");
    pressKey("l");
    expect(press({ key: "}", metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    const viewport = bbShowsAnotherThread();

    expect(pressKey("j").defaultPrevented).toBe(false);

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(modePill()).toBeNull();
    expect(getUiState().notice).toBeNull();
    expect(viewport.scrollTop).toBe(0);
  });

  it("leaves copy mode, without a notice, when the new thread scrolls", async () => {
    await mountPlugin();
    enterCopyMode();
    const viewport = bbShowsAnotherThread();

    act(() => {
      viewport.dispatchEvent(new Event("scroll"));
    });
    await act(() => afterFrames(2));

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(modePill()).toBeNull();
    expect(getUiState().notice).toBeNull();
  });

  it.each(["v", "["])(
    "does not enter on %s without the prefix, wherever the cursor is",
    async (key) => {
      await mountPlugin();

      expect(pressKey(key).defaultPrevented).toBe(false);
      expect(pressKey(key, pane("pane-1")).defaultPrevented).toBe(false);
      for (const testId of ["notes", "composer", "terminal-input"]) {
        expect(pressKey(key, fixture(testId)).defaultPrevented, testId).toBe(false);
      }

      expect(getUiState().copyMode).toEqual({ active: false });
    },
  );

  it.each(["terminal-input", "notes"])(
    "enters on the prefix then [ from the %s field and takes the cursor out of it",
    async (testId) => {
      await mountPlugin();
      const field = fixture(testId);
      field.focus();

      enterCopyMode(field);

      expect(modePill()).toBe("COPY");
      expect(document.activeElement).toBe(pane("pane-1"));
    },
  );

  it("enters on the prefix then [ from a sidebar thread row", async () => {
    await mountPlugin();
    pressAfterPrefix("h");

    enterCopyMode(sidebarRow("thr-1"));

    expect(modePill()).toBe("COPY");
    expect(document.activeElement).toBe(pane("pane-1"));
    expect(pressKey("k", pane("pane-1")).defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-2:0");
  });

  it("enters on the prefix then [ from the message box and takes the cursor out of it", async () => {
    await mountPlugin();
    const composer = fixture("composer");
    composer.focus();

    pressCtrl("a", composer);
    expect(pressKey("[", composer).defaultPrevented).toBe(true);

    expect(modePill()).toBe("COPY");
    expect(document.activeElement).toBe(pane("pane-1"));
    expect(pressKey("k", pane("pane-1")).defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-2:0");
  });

  // A German Mac keyboard: Option-5 types "[", Option-8 "{" and Option-9 "}".
  it("takes [, { and } typed with Option on a Mac keyboard layout that needs it", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await mountPlugin();

    pressCtrl("a");
    expect(press({ key: "[", code: "Digit5", altKey: true }).defaultPrevented).toBe(true);
    expect(modePill()).toBe("COPY");
    expect(cursorPlace()).toBe("line-3:0");

    expect(press({ key: "{", code: "Digit8", altKey: true }).defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-2:0");
    expect(press({ key: "}", code: "Digit9", altKey: true }).defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-3:0");
  });

  it("still passes Option shortcuts that type no key of the plugin on to bb in copy mode", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await mountPlugin();
    enterCopyMode();

    expect(press({ key: "@", code: "KeyL", altKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: "\u00e7", code: "KeyC", altKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: "|", code: "Digit7", altKey: true }).defaultPrevented).toBe(false);

    expect(modePill()).toBe("COPY");
    expect(cursorPlace()).toBe("line-3:0");
  });

  it("treats Alt with [ as a shortcut on Windows and Linux, where Alt types nothing", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    await mountPlugin();

    pressCtrl("a");
    expect(press({ key: "[", code: "BracketLeft", altKey: true }).defaultPrevented).toBe(true);

    expect(getUiState().prefixArmed).toBe(false);
    expect(getUiState().copyMode).toEqual({ active: false });
  });

  it("says so when the conversation has no text to select", async () => {
    await mountPlugin();
    focusedPaneViewport().replaceChildren();
    const composer = fixture("composer");
    composer.focus();

    pressCtrl("a", composer);
    expect(pressKey("[", composer).defaultPrevented).toBe(true);

    expect(document.activeElement).toBe(composer);
    expect(getUiState().copyMode).toEqual({ active: false });
    expect(getUiState().notice?.text).toBe(
      "There is no conversation text to select here",
    );
  });

  it("lists the copy mode keys in the key help", async () => {
    await mountPlugin();

    pressCtrl("a");
    pressKey("?");

    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    expect(help.textContent).toContain("Copy mode, vi keys");
    expect(help.textContent).toContain("Space / vStart selecting from the cursor");
    expect(help.textContent).toContain(
      "Ctrl-j / Enter / yCopy the selection and leave copy mode",
    );
    expect(help.textContent).toContain("Ctrl-a [");
    expect(help.textContent).toContain("Ctrl-a PageUp");
    expect(help.textContent).toContain("Ctrl-f / PageDown");
    expect(help.textContent).toContain("Ctrl-e");
    expect(help.textContent).not.toContain("gg");
    expect(help.textContent).not.toContain("Browsing");
    expect(help.textContent).not.toContain("Without the prefix");
  });
});

describe("copy mode next to bb's selection menu", () => {
  beforeEach(installBrowserFakes);
  afterEach(removeBrowserFakes);

  it("goes on selecting and copies while bb shows its menu for the selection", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey("v");
    pressKey("l");
    showBbSelectionMenu();

    expect(pressKey("l").defaultPrevented).toBe(true);
    expect(pageSelection().toString()).toBe("zet");
    expect(modePill()).toBe("SELECT");

    expect(pressKey("y").defaultPrevented).toBe(true);
    expect(copiedTexts).toEqual(["zet"]);
    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
    expect(getUiState().copyMode).toEqual({ active: false });
  });

  it("starts at the end of a mouse selection although bb shows its menu for it", async () => {
    await mountPlugin();
    const line = lineText("line-1");
    pageSelection().setBaseAndExtent(line, 0, line, 5);
    showBbSelectionMenu();

    pressCtrl("a");
    expect(pressKey("[").defaultPrevented).toBe(true);

    expect(modePill()).toBe("COPY");
    expect(cursorPlace()).toBe("line-1:5");
    expect(pageSelection().isCollapsed).toBe(true);
  });

  it("keeps the prefix working while the menu shows", async () => {
    await mountPlugin();
    const line = lineText("line-1");
    pageSelection().setBaseAndExtent(line, 0, line, 5);
    showBbSelectionMenu();

    expect(pressCtrl("a").defaultPrevented).toBe(true);
    expect(pressKey("w").defaultPrevented).toBe(true);
    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
  });

  it("leaves the selection to bb's Add to chat button when that is pressed", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey("v");
    press({ key: "$", shiftKey: true });
    const addToChat = showBbSelectionMenu();

    pressPointer(addToChat);

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(modePill()).toBeNull();
    expect(pageSelection().toString()).toBe("zeta eta theta");
  });

  it("stays out of the way while the cursor is on the menu's own button", async () => {
    await mountPlugin();
    const addToChat = showBbSelectionMenu();
    addToChat.focus();

    expect(pressKey("j", addToChat).defaultPrevented).toBe(false);
    expect(pressCtrl("a", addToChat).defaultPrevented).toBe(false);
  });

  it("keeps the prefix working in the terminal while bb shows its menu for selected terminal output", async () => {
    await mountPlugin();
    const terminal = fixture("terminal-input");
    const pointerDown = onEvent(pane("pane-2"), "pointerdown");
    terminal.focus();
    document.body.insertAdjacentHTML("beforeend", BB_SELECTION_MENU);

    expect(pressCtrl("a", terminal).defaultPrevented).toBe(true);
    expect(getUiState().prefixArmed).toBe(true);
    expect(pressKey("l", terminal).defaultPrevented).toBe(true);

    expect(pointerDown).toHaveBeenCalledTimes(1);
  });

  it("keeps the prefix and copy mode working while the menu shows on the page body, as for a file preview", async () => {
    await mountPlugin();
    document.body.insertAdjacentHTML("beforeend", BB_SELECTION_MENU);

    expect(pressCtrl("a").defaultPrevented).toBe(true);
    expect(pressKey("[").defaultPrevented).toBe(true);
    expect(modePill()).toBe("COPY");
    expect(pressKey("k").defaultPrevented).toBe(true);
    expect(cursorPlace()).toBe("line-2:0");
  });

  it("still handles no key while another popover of bb is open on the page body", async () => {
    await mountPlugin();
    document.body.insertAdjacentHTML("beforeend", BB_OTHER_POPOVER);

    expect(pressCtrl("a").defaultPrevented).toBe(false);
    expect(pressKey("[").defaultPrevented).toBe(false);
    expect(getUiState().prefixArmed).toBe(false);
    expect(getUiState().copyMode).toEqual({ active: false });
  });
});

// A terminal sends Ctrl-[ as Escape, Ctrl-m as Enter and Ctrl-i as Tab, so
// those are the same keys to tmux. bb sees them as keys of their own.
describe("the keys that a terminal sends as Escape, Enter and Tab", () => {
  beforeEach(installBrowserFakes);
  afterEach(removeBrowserFakes);

  it("leaves copy mode on Ctrl-[ where the tmux config binds Escape to cancel, and puts the cursor back in the message box", async () => {
    await mountPlugin();
    const composer = fixture("composer");
    composer.focus();
    enterCopyMode(composer);

    expect(pressCtrl("[", pane("pane-1")).defaultPrevented).toBe(true);

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(modePill()).toBeNull();
    expect(messageBoxRequests()).toBe(1);
  });

  it("drops the selection on Ctrl-[ and copies and leaves on Ctrl-m with tmux's own vi keys", async () => {
    await mountPlugin({ tmuxConfig: "setw -g mode-keys vi" });
    pressAfterPrefix("[", undefined, "b");
    pressKey(" ");
    pressKey("l");
    expect(pageSelection().toString()).toBe("ze");

    expect(pressCtrl("[").defaultPrevented).toBe(true);
    expect(modePill()).toBe("COPY");
    expect(pageSelection().isCollapsed).toBe(true);

    pressKey(" ");
    pressKey("l");
    expect(pressCtrl("m").defaultPrevented).toBe(true);

    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
    expect(copiedTexts).toEqual(["et"]);
    expect(modePill()).toBeNull();
  });

  it("leaves copy mode on Ctrl-[ with tmux's emacs keys, and swallows Ctrl-m and Ctrl-i there as it swallows Enter and Tab", async () => {
    await mountPlugin({ tmuxConfig: null });
    pressAfterPrefix("[", undefined, "b");

    expect(pressCtrl("m").defaultPrevented).toBe(true);
    expect(pressCtrl("i").defaultPrevented).toBe(true);
    expect(modePill()).toBe("COPY");
    expect(cursorPlace()).toBe("line-3:0");

    expect(pressCtrl("[").defaultPrevented).toBe(true);
    expect(modePill()).toBeNull();
  });

  it("runs the binding of the chord itself in copy mode when the tmux config has one", async () => {
    await mountPlugin({
      tmuxConfig: `${TMUX_CONFIG}\nbind -T copy-mode-vi C-m send-keys -X cursor-right`,
    });
    enterCopyMode();

    expect(pressCtrl("m").defaultPrevented).toBe(true);

    expect(modePill()).toBe("COPY");
    expect(cursorPlace()).toBe("line-3:1");
    expect(copiedTexts).toEqual([]);
  });

  it("keeps the three keys as keys of their own after the prefix, where each only ends the prefix", async () => {
    await mountPlugin();
    enterCopyMode();

    for (const key of ["[", "m", "i"]) {
      pressCtrl("a");
      expect(pressCtrl(key).defaultPrevented, key).toBe(true);
      expect(getUiState().prefixArmed, key).toBe(false);
    }

    expect(modePill()).toBe("COPY");
    expect(cursorPlace()).toBe("line-3:0");
    expect(copiedTexts).toEqual([]);
  });

  it("goes back to the pane on Ctrl-[ and opens the thread on Ctrl-m on a thread row of the sidebar, and leaves Ctrl-i to bb there", async () => {
    await mountPlugin();
    pressAfterPrefix("h");
    expect(pressKey("j", sidebarRow("thr-1")).defaultPrevented).toBe(true);
    const row = sidebarRow("thr-2");
    expect(document.activeElement).toBe(row);

    expect(pressCtrl("i", row).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(row);

    expect(pressCtrl("m", row).defaultPrevented).toBe(true);
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-2" },
    ]);

    expect(pressCtrl("[", row).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pane("pane-1"));
    expect(messageBoxRequests()).toBe(1);
  });

  // On Windows and Linux Ctrl-[ is bb's shortcut for going back, so it is not
  // handed to bb with Escape, which bb drops its selection of rows on.
  it("goes back to the pane on Ctrl-[ while thread rows are selected as well, where Escape itself is left to bb", async () => {
    await mountPlugin();
    pressAfterPrefix("h");
    const row = sidebarRow("thr-1");
    const selected = sidebarRow("thr-2");
    selected.setAttribute("data-sidebar-thread-selected", "");

    expect(pressKey("Escape", row).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(row);
    expect(messageBoxRequests()).toBe(0);

    expect(pressCtrl("[", row).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pane("pane-1"));
    expect(messageBoxRequests()).toBe(1);
    expect(selected.hasAttribute("data-sidebar-thread-selected")).toBe(true);
  });

  it("opens the thread on Ctrl-m while thread rows are selected, as Enter does", async () => {
    await mountPlugin();
    pressAfterPrefix("h");
    sidebarRow("thr-3").setAttribute("data-sidebar-thread-selected", "");
    pressKey("j", sidebarRow("thr-1"));

    expect(pressCtrl("m", sidebarRow("thr-2")).defaultPrevented).toBe(true);

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-2" },
    ]);
  });

  it.each([
    ["while no rows are selected", false],
    ["while rows are selected", true],
  ])("leaves the three keys to bb on a thread row that was clicked, %s", async (_when, isSelected) => {
    await mountPlugin();
    const row = sidebarRow("thr-2");
    clickWithMouse(row);
    if (isSelected) sidebarRow("thr-3").setAttribute("data-sidebar-thread-selected", "");

    for (const key of ["[", "m", "i"]) {
      expect(pressCtrl(key, row).defaultPrevented, key).toBe(false);
    }
    expect(document.activeElement).toBe(row);
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(messageBoxRequests()).toBe(0);
  });

  it("goes back from the filter field on Ctrl-[, moves between the field and the list on Ctrl-i, opens on Ctrl-m and closes on Ctrl-[ in the thread chooser", async () => {
    await mountPlugin();
    pressAfterPrefix("w");
    pressKey("/", chooserList());
    const filter = screen.getByRole("combobox", {
      name: "Filter threads by title or project",
    });
    expect(document.activeElement).toBe(filter);

    pressCtrl("[", filter);
    expect(getUiState().chooser).toEqual({ open: true, placement: "replace" });
    expect(document.activeElement).toBe(chooserList());

    pressCtrl("i", chooserList());
    expect(document.activeElement).toBe(filter);
    pressCtrl("i", filter);
    expect(document.activeElement).toBe(chooserList());

    pressCtrl("[", chooserList());
    expect(getUiState().chooser).toEqual({ open: false });
    expect(view.inspection.navigateCalls).toEqual([]);

    pressAfterPrefix("w");
    pressKey("G", chooserList());
    pressCtrl("m", chooserList());
    expect(getUiState().chooser).toEqual({ open: false });
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-3" },
    ]);
  });

  it("closes the key help on Ctrl-[, which says in one sentence where the three keys work", async () => {
    await mountPlugin();
    pressAfterPrefix("?");
    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    expect(
      within(help).getByText(
        "As in a terminal, Ctrl-[, Ctrl-m and Ctrl-i work as Escape, Enter and Tab in copy mode, in the thread chooser and here, and Ctrl-[ and Ctrl-m as Escape and Enter on a thread in the sidebar, unless the key itself is bound there.",
      ),
    ).toBeTruthy();

    pressCtrl("[", document.activeElement ?? help);

    expect(getUiState().helpOpen).toBe(false);
  });

  it("moves the cursor to the close button of the key help on Ctrl-i, and presses it on Ctrl-m", async () => {
    await mountPlugin();
    pressAfterPrefix("?");
    const help = screen.getByRole("dialog", { name: "Tmux keys" });
    const close = within(help).getByRole("button", { name: "Close" });

    pressCtrl("m", document.activeElement ?? help);
    expect(getUiState().helpOpen).toBe(true);

    pressCtrl("i", document.activeElement ?? help);
    expect(document.activeElement).toBe(close);
    expect(pressCtrl("m", close).defaultPrevented).toBe(true);

    expect(getUiState().helpOpen).toBe(false);
  });

  it.each([
    ["on a pane", () => pane("pane-1")],
    ["on a button", () => fixture("close-pane")],
    ["in the message box", () => fixture("composer")],
    ["in the terminal", () => fixture("terminal-input")],
  ])("leaves the three keys alone %s outside copy mode", async (_place, target) => {
    await mountPlugin();
    const element = target();
    element.focus();

    for (const key of ["[", "m", "i"]) {
      expect(pressCtrl(key, element).defaultPrevented, key).toBe(false);
    }

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(getUiState().prefixArmed).toBe(false);
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(messageBoxRequests()).toBe(0);
  });

  it("runs a key that the tmux config binds without the prefix to the chord itself, in the message box as well", async () => {
    await mountPlugin({ tmuxConfig: `${TMUX_CONFIG}\nbind -n C-m new-window` });
    const composer = fixture("composer");
    composer.focus();

    expect(pressCtrl("m", composer).defaultPrevented).toBe(true);
    expect(pressKey("Enter", composer).defaultPrevented).toBe(false);

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toCompose", options: { focusPrompt: true } },
    ]);
  });
});

describe("copying with the mouse", () => {
  beforeEach(installBrowserFakes);
  afterEach(removeBrowserFakes);

  it("copies conversation text as soon as the mouse button is released", async () => {
    await mountPlugin();

    await selectWithMouse(lineText("line-1"), 0, 5);

    expect(execCommand.mock.calls).toEqual([["copy"]]);
    expect(copiedTexts).toEqual(["alpha"]);
    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
    expect(pageSelection().toString()).toBe("alpha");
    expect(getUiState().copyMode).toEqual({ active: false });
  });

  it("writes a selection that runs from one message into another itself, as the plain text that is selected, and not through the browser's copy command", async () => {
    await mountPlugin();
    const from = lineText("line-1");
    const to = lineText("line-3");
    pressMouseOn(from.parentElement ?? document.body);
    pageSelection().setBaseAndExtent(from, 6, to, 4);
    await releaseMouseOn(to.parentElement ?? document.body);

    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
    expect(execCommand).not.toHaveBeenCalled();
    const writes = mounted.inspection.experimental_clipboardWrites;
    expect(writes).toHaveLength(1);
    expect(writes[0].text.replace(/\s+/g, " ")).toBe("beta gamma delta epsilon zeta");
  });

  it("does not copy the same selection again on a click on bb's selection menu", async () => {
    await mountPlugin();
    await selectWithMouse(lineText("line-1"), 0, 5);

    await clickWithButton(showBbSelectionMenu());

    expect(copiedTexts).toEqual(["alpha"]);
  });

  it("copies nothing on a click in the sidebar or on a button while conversation text is selected", async () => {
    await mountPlugin();
    const line = lineText("line-1");
    pageSelection().setBaseAndExtent(line, 0, line, 5);
    await nextTask();

    await clickWithButton(sidebarRow("thr-2"));
    await clickWithButton(fixture("close-pane"));
    await releaseMouseOn(document.body);

    expect(pageSelection().toString()).toBe("alpha");
    expect(execCommand).not.toHaveBeenCalled();
    expect(mounted.inspection.experimental_clipboardWrites).toEqual([]);
    expect(getUiState().notice).toBeNull();
  });

  it("copies nothing for the word a right click selects, nor on the next click in the sidebar", async () => {
    await mountPlugin();
    const line = lineText("line-1");
    const paragraph = fixture("line-1");

    pressMouseOn(paragraph, { button: 2 });
    pageSelection().setBaseAndExtent(line, 0, line, 5);
    paragraph.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
    await releaseMouseOn(paragraph, { button: 2 });
    await clickWithButton(sidebarRow("thr-2"));

    expect(pageSelection().toString()).toBe("alpha");
    expect(execCommand).not.toHaveBeenCalled();
    expect(getUiState().notice).toBeNull();
  });

  it("copies nothing for a copy mode selection when bb's menu is pressed and the button is released beside it", async () => {
    await mountPlugin();
    enterCopyMode();
    pressKey("v");
    press({ key: "$", shiftKey: true });
    const addToChat = showBbSelectionMenu();

    pressPointer(addToChat);
    pressMouseOn(addToChat);
    await releaseMouseOn(fixture("line-3"));

    expect(getUiState().copyMode).toEqual({ active: false });
    expect(pageSelection().toString()).toBe("zeta eta theta");
    expect(execCommand).not.toHaveBeenCalled();
    expect(getUiState().notice).toBeNull();
  });

  it("copies again once the selection has changed", async () => {
    await mountPlugin();
    await selectWithMouse(lineText("line-1"), 0, 5);

    await selectWithMouse(lineText("line-2"), 0, 5);

    expect(copiedTexts).toEqual(["alpha", "delta"]);
  });

  it("does not copy text selected in the message box", async () => {
    await mountPlugin();
    const composer = fixture("composer");
    composer.textContent = "draft words";

    await selectWithMouse(composer.firstChild as Text, 0, 5);

    expect(pageSelection().toString()).toBe("draft");
    expect(execCommand).not.toHaveBeenCalled();
    expect(mounted.inspection.experimental_clipboardWrites).toEqual([]);
    expect(getUiState().notice).toBeNull();
  });

  it("does not copy text selected outside a conversation", async () => {
    await mountPlugin();

    await selectWithMouse(sidebarRow("thr-1").firstChild as Text, 0, 5);

    expect(pageSelection().toString()).toBe("Alpha");
    expect(execCommand).not.toHaveBeenCalled();
    expect(getUiState().notice).toBeNull();
  });

  it("copies nothing when copyOnSelect is off, although the tmux config turns the mouse on", async () => {
    await mountPlugin({ settings: { copyOnSelect: "off" } });

    await selectWithMouse(lineText("line-1"), 0, 5);

    expect(execCommand).not.toHaveBeenCalled();
    expect(mounted.inspection.experimental_clipboardWrites).toEqual([]);
    expect(getUiState().notice).toBeNull();
  });

  it("copies nothing with stock tmux, whose mouse option is off, while copyOnSelect follows tmux", async () => {
    await mountPlugin({ tmuxConfig: null });

    await selectWithMouse(lineText("line-1"), 0, 5);

    expect(execCommand).not.toHaveBeenCalled();
    expect(getUiState().notice).toBeNull();
  });

  it("copies with stock tmux when copyOnSelect is on", async () => {
    await mountPlugin({ tmuxConfig: null, settings: { copyOnSelect: "on" } });

    await selectWithMouse(lineText("line-1"), 0, 5);

    expect(copiedTexts).toEqual(["alpha"]);
  });

  it("copies nothing while the keys are paused, nor on the first click after they are resumed", async () => {
    await mountPlugin();
    await runCommand("toggle-paused");

    await selectWithMouse(lineText("line-1"), 0, 5);

    expect(execCommand).not.toHaveBeenCalled();
    expect(getUiState().notice?.text).toContain("paused");

    await runCommand("toggle-paused");
    await clickWithButton(sidebarRow("thr-2"));

    expect(pageSelection().toString()).toBe("alpha");
    expect(execCommand).not.toHaveBeenCalled();
    expect(getUiState().notice?.text).toContain("on again");
  });

  it("copies nothing while the plugin is switched off", async () => {
    await mountPlugin({ settings: { enabled: false } });

    await selectWithMouse(lineText("line-1"), 0, 5);

    expect(pageSelection().toString()).toBe("alpha");
    expect(execCommand).not.toHaveBeenCalled();
    expect(mounted.inspection.experimental_clipboardWrites).toEqual([]);
    expect(getUiState().notice).toBeNull();
  });

  it("copies nothing on a plain click, which selects nothing", async () => {
    await mountPlugin();
    const paragraph = fixture("line-1");

    pressMouseOn(paragraph);
    pageSelection().collapse(lineText("line-1"), 3);
    await releaseMouseOn(paragraph);

    expect(execCommand).not.toHaveBeenCalled();
    expect(getUiState().notice).toBeNull();
  });

  it("falls back to bb's plain-text copy when the browser refuses its copy command", async () => {
    await mountPlugin();
    execCommand.mockReturnValue(false);

    await selectWithMouse(lineText("line-1"), 0, 5);

    await waitFor(() => expect(getUiState().notice?.text).toBe(COPIED_NOTICE));
    expect(mounted.inspection.experimental_clipboardWrites).toEqual([
      { text: "alpha" },
    ]);
  });

  it("copies nothing once the plugin is unloaded", async () => {
    await mountPlugin();
    await act(async () => {
      await mounted.lifecycle.dispose();
    });

    await selectWithMouse(lineText("line-1"), 0, 5);

    expect(execCommand).not.toHaveBeenCalled();
  });
});
