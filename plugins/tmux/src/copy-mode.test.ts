// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUiState, resetStore, setBridge, subscribeUiState } from "./bridge";
import { copySelection } from "./clipboard";
import {
  beginCopySelection,
  clearCopySelection,
  enterCopyMode,
  exitCopyMode,
  exitCopyModeKeepingSelection,
  hasCopyModeLostConversation,
  isConversationText,
  isCopyModeActive,
  moveCopyCursor,
  refreshCopyCursor,
  scrollCopyView,
  yankCopySelection,
} from "./copy-mode";
import { scrollTimelineBy } from "./dom-actions";
import { DEFAULT_SETTINGS } from "./settings";
import { tmuxConfigOf } from "./tmux-test-support";
import type {
  AfterCopy,
  Bridge,
  CopyModeUi,
  CopyMotion,
  CursorRect,
} from "./types";

vi.mock("./clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clipboard")>()),
  copySelection: vi.fn(),
}));
vi.mock("./dom-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dom-actions")>()),
  scrollTimelineBy: vi.fn(),
}));

interface LineBox {
  top: number;
  left: number;
  columnLeft: number;
  isFixed: boolean;
}

interface ThreadOptions {
  prefix?: string;
  lineCount?: number;
  extraRowsHtml?: string;
}

type ModeKeys = "vi" | "emacs";

// Where the selection of the page starts and ends, what it holds, and the
// line and the place in it that the cursor is drawn at: on a character, or
// as a narrow mark where it stands at the end of a line.
interface ShownSelection {
  anchor: string;
  focus: string;
  text: string;
  cursor: [line: number, offset: number, on: "character" | "line end"];
}

// A selection that is started where the cursor is put and then moved.
interface SelectionCase {
  name: string;
  start: [id: string, offset: number];
  scrolledBy?: number;
  moves: CopyMotion[];
  vi: ShownSelection;
  emacs: ShownSelection;
}

const CHAR_WIDTH = 8;
const LINE_HEIGHT = 20;
const CARET_WIDTH = 2;
const PANE_WIDTH = 800;
const TEXT_INSET = 40;
const VIEWPORT_TOP = 100;
const VIEWPORT_HEIGHT = 400;
const FOOTER_TOP = 420;
const CONTENT_TOP = 120;
const DRAFT_TOP = 440;
const LINE_COUNT = 20;
const LAST_LINE = `line-${LINE_COUNT - 1}`;
const LAST_VISIBLE_LINE = "line-13";

const FIRST_LINES = ["alpha beta gamma", "delta epsilon", "zeta eta theta"];

// One character on screen each, made of several code points.
const CLUSTERS: [name: string, character: string][] = [
  ["a warning sign with a variation selector", "\u26A0\uFE0F"],
  ["a letter with a combining accent", "e\u0301"],
  ["a thumb with a skin tone", "\u{1F44D}\u{1F3FD}"],
  ["a flag", "\u{1F1E8}\u{1F1E6}"],
  ["a family joined by zero-width joiners", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"],
];

const LOST_NOTICE =
  "The selection was lost because bb unloaded that part of the conversation";
const NOTHING_SELECTED_NOTICE =
  "Nothing is selected. Start a selection and move the cursor, then copy";

const BOUNDARY_STEPS: ReadonlySet<string> = new Set(["lineboundary", "paragraphboundary"]);
const STOPPING_STEPS: ReadonlySet<string> = new Set(["word", "paragraph", "line"]);

const SELECTION_MENU_HTML = `
  <div data-radix-popper-content-wrapper="">
    <div role="dialog" data-state="open" data-bb-portaled-overlay="">
      <button type="button" id="add-to-chat">Add to chat</button>
    </div>
  </div>`;

let boxes: Map<Node, LineBox>;
let scrollTop: number;
let maxScrollTop: number;
let modifyCalls: string[];
let doesMarginFindLine: boolean;
let doesWordMoveSkipBlanks: boolean;
// As Chromium does it: from the end of a paragraph the forward word move
// stops at the start of the text that follows, not behind its first word.
let doesWordMoveStopAtTextStart: boolean;
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let caretPositionFromPoint: ReturnType<typeof vi.fn<(x: number, y: number) => unknown>>;
// The lines that a move by a line of the fake browser jumps over, as a real
// one jumps over the lines of a code block that bb draws as boxes.
let jumpedOverLines: Set<string>;
// Where a move of the fake browser ends in the place of the neighbouring
// text, for the empty elements that a real one walks into.
let stepsInto: Map<string, [Node, number]>;
// Names for places in a node that is not the one text of an element with an
// id, such as a line break between two lines of a code block.
let nodeNames: Map<Node, string>;

function lineText(index: number): string {
  return FIRST_LINES[index] ?? `row ${index} text`;
}

// Mirrors bb 0.50.1 markup: ThreadScreen.tsx and bottom-anchored-scroll-body.tsx
// (thread window, scroller, sticky footer, overlay beside the scroller),
// ThreadTimelineRows.tsx and TimelineWindowedItems.tsx (row list, the layer for
// the selection menu) and SelectableMessageProse.tsx (message text).
function threadHtml(options: ThreadOptions = {}): string {
  const { prefix = "", lineCount = LINE_COUNT, extraRowsHtml = "" } = options;
  const rows = Array.from(
    { length: lineCount },
    (_, index) => `
      <div data-timeline-row-id="${prefix}row-${index}">
        <div data-sidebar-swipe-selectable=""><p id="${prefix}line-${index}" data-line="">${lineText(index)}</p></div>
      </div>`,
  ).join("");
  return `
    <header><span id="${prefix}pane-title">Thread title</span></header>
    <div data-thread-window="">
      <div data-page-scroll-viewport="" id="${prefix}viewport">
        <div class="relative">
          <div data-timeline-row-list="top-level">
            <div data-timeline-items="">${extraRowsHtml}${rows}</div>
          </div>
          <div id="${prefix}menu-layer" class="pointer-events-none absolute inset-0"></div>
        </div>
        <div data-scroll-footer="" id="${prefix}footer">
          <span id="${prefix}footer-note">2 queued messages</span>
          <div data-app-composer="" data-app-composer-role="primary">
            <div contenteditable="true" role="textbox"><p id="${prefix}draft">draft words here</p></div>
          </div>
        </div>
      </div>
      <div data-scroll-overlay=""><span id="${prefix}context-card">Context card</span></div>
    </div>`;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`fixture element ${id} is missing`);
  return element as T;
}

function textOf(id: string): Text {
  const node = byId(id).firstChild;
  if (!(node instanceof Text)) throw new Error(`fixture text ${id} is missing`);
  return node;
}

function getSelection(): Selection {
  const selection = document.getSelection();
  if (selection === null) throw new Error("the document has no selection");
  return selection;
}

function screenTop(box: LineBox): number {
  return box.isFixed ? box.top : box.top - scrollTop;
}

function layOutPane(prefix: string, columnLeft: number): void {
  const lines = document.querySelectorAll(`#${prefix}viewport p[data-line]`);
  lines.forEach((line, index) => {
    if (line.firstChild === null) return;
    boxes.set(line.firstChild, {
      top: CONTENT_TOP + index * LINE_HEIGHT,
      left: columnLeft + TEXT_INSET,
      columnLeft,
      isFixed: false,
    });
  });
  boxes.set(textOf(`${prefix}draft`), {
    top: DRAFT_TOP,
    left: columnLeft + TEXT_INSET,
    columnLeft,
    isFixed: true,
  });
  byId(`${prefix}viewport`).getBoundingClientRect = () =>
    rect(columnLeft, VIEWPORT_TOP, PANE_WIDTH, VIEWPORT_HEIGHT);
  byId(`${prefix}footer`).getBoundingClientRect = () =>
    rect(columnLeft, FOOTER_TOP, PANE_WIDTH, VIEWPORT_TOP + VIEWPORT_HEIGHT - FOOTER_TOP);
}

function mountThread(options: ThreadOptions = {}): void {
  document.body.innerHTML = `<main>${threadHtml(options)}</main>`;
  boxes = new Map();
  layOutPane("", 0);
}

function mountSplit(focusedPane: "a" | "b" | null): void {
  const pane = (name: "a" | "b"): string => `
    <div tabindex="-1" data-split-pane-id="pane-${name}" data-focused="${focusedPane === name}">
      ${threadHtml({ prefix: `${name}-` })}
    </div>`;
  document.body.innerHTML = `<main>${pane("a")}${pane("b")}</main>`;
  boxes = new Map();
  layOutPane("a-", 0);
  layOutPane("b-", PANE_WIDTH);
}

function fakeClientRects(this: Range): DOMRect[] {
  const box = boxes.get(this.startContainer);
  if (box === undefined) return [];
  const length =
    this.endContainer === this.startContainer ? this.endOffset - this.startOffset : 0;
  return [
    rect(
      box.left + this.startOffset * CHAR_WIDTH,
      screenTop(box),
      length * CHAR_WIDTH,
      LINE_HEIGHT,
    ),
  ];
}

// The sticky footer covers the conversation lines under it, and a point in the
// page margin only finds the line beside it when doesMarginFindLine is set.
function positionAt(x: number, y: number): { offsetNode: Node; offset: number } | null {
  for (const [node, box] of boxes) {
    const top = screenTop(box);
    if (y < top || y >= top + LINE_HEIGHT) continue;
    if (!box.isFixed && y >= FOOTER_TOP) continue;
    if (x < box.columnLeft || x >= box.columnLeft + PANE_WIDTH) continue;
    if (x < box.left && !doesMarginFindLine) return null;
    const length = (node as Text).length;
    const offset = Math.min(length, Math.max(0, Math.round((x - box.left) / CHAR_WIDTH)));
    return { offsetNode: node, offset };
  }
  return null;
}

function allTexts(): Text[] {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node as Text).data.trim() !== "") texts.push(node as Text);
  }
  return texts;
}

function wordSpans(text: Text): { start: number; end: number }[] {
  return Array.from(text.data.matchAll(/\S+/g), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function wordEndAfter(texts: Text[], index: number, offset: number): [Text, number] | null {
  const here = wordSpans(texts[index]).find((word) => word.end > offset);
  if (here !== undefined) return [texts[index], here.end];
  const next = texts[index + 1];
  if (next === undefined) return null;
  if (doesWordMoveStopAtTextStart) return [next, 0];
  const first = wordSpans(next)[0];
  return first === undefined ? null : [next, first.end];
}

// As Windows does it: forward to the start of the next word, behind the
// blanks, and to the end of the line from its last word.
function wordStartAfter(texts: Text[], index: number, offset: number): [Text, number] | null {
  const text = texts[index];
  const here = wordSpans(text).find((word) => word.start > offset);
  if (here !== undefined) return [text, here.start];
  if (offset < text.length) return [text, text.length];
  const next = texts[index + 1];
  if (next === undefined) return null;
  const first = wordSpans(next)[0];
  return first === undefined ? null : [next, first.start];
}

function wordStartBefore(texts: Text[], index: number, offset: number): [Text, number] | null {
  const here = wordSpans(texts[index])
    .filter((word) => word.start < offset)
    .at(-1);
  if (here !== undefined) return [texts[index], here.start];
  const previous = texts[index - 1];
  if (previous === undefined) return null;
  const last = wordSpans(previous).at(-1);
  return last === undefined ? null : [previous, last.start];
}

// Every text node is one line. A step that has nowhere to go does nothing, as
// in a browser, and a step may walk out of the conversation.
function stepTarget(
  texts: Text[],
  index: number,
  offset: number,
  direction: string | undefined,
  granularity: string | undefined,
): [Text, number] | null {
  const text = texts[index];
  const isForward = direction === "forward" || direction === "right";
  const neighbour: Text | undefined = texts[index + (isForward ? 1 : -1)];
  if (granularity === "character") {
    if (isForward && offset < text.length) return [text, offset + 1];
    if (!isForward && offset > 0) return [text, offset - 1];
    if (neighbour === undefined) return null;
    return [neighbour, isForward ? 0 : neighbour.length];
  }
  if (granularity === "word") {
    if (!isForward) return wordStartBefore(texts, index, offset);
    return doesWordMoveSkipBlanks
      ? wordStartAfter(texts, index, offset)
      : wordEndAfter(texts, index, offset);
  }
  if (granularity === "line") {
    let next = index + (isForward ? 1 : -1);
    while (jumpedOverLines.has(texts[next]?.parentElement?.id ?? "")) {
      next += isForward ? 1 : -1;
    }
    const line: Text | undefined = texts[next];
    return line === undefined ? null : [line, Math.min(offset, line.length)];
  }
  if (granularity === "lineboundary" || granularity === "paragraphboundary") {
    return [text, isForward ? text.length : 0];
  }
  if (granularity === "paragraph") return neighbour === undefined ? null : [neighbour, 0];
  throw new Error(`the fake browser does not move by ${granularity}`);
}

// A browser moves from a place between two elements as it does from the
// start of the text that follows that place.
function textPlaceOf(texts: Text[], node: Node | null, offset: number): [number, number] {
  if (node === null) return [-1, 0];
  if (node instanceof Text) return [texts.indexOf(node), offset];
  const place = document.createRange();
  place.setStart(node, offset);
  place.collapse(true);
  return [texts.findIndex((text) => place.comparePoint(text, 0) >= 0), 0];
}

// As Chromium does it on macOS: a step to the start or the end of a line
// grows a selection that is not collapsed. It moves the end that lies in the
// direction of the step, from where that end is, and leaves the other end
// alone, so the end that the selection was started at moves when it is the
// one on that side.
function growToBoundary(
  selection: Selection,
  texts: Text[],
  direction: string | undefined,
  granularity: string | undefined,
): void {
  const range = selection.getRangeAt(0);
  const isForward = direction === "forward";
  const isAnchorFirst =
    selection.anchorNode === range.startContainer &&
    selection.anchorOffset === range.startOffset;
  const [index, offset] = isForward
    ? textPlaceOf(texts, range.endContainer, range.endOffset)
    : textPlaceOf(texts, range.startContainer, range.startOffset);
  if (index === -1) return;
  const target = stepTarget(texts, index, offset, direction, granularity);
  if (target === null) return;
  if (isForward === isAnchorFirst) {
    selection.extend(target[0], target[1]);
    return;
  }
  const { focusNode, focusOffset } = selection;
  if (focusNode === null) return;
  selection.setBaseAndExtent(target[0], target[1], focusNode, focusOffset);
}

function isInFrontOf(node: Node, offset: number, reference: Node, referenceOffset: number): boolean {
  const place = document.createRange();
  place.setStart(reference, referenceOffset);
  place.collapse(true);
  return place.comparePoint(node, offset) < 0;
}

// As Chromium does it on macOS: a step by a word, a paragraph or a line does
// not take the end of a selection that moves across the end that it was
// started at. It stops at that end, which leaves the selection collapsed.
function stopsWhereSelectionStarted(
  selection: Selection,
  target: [Node, number],
  granularity: string | undefined,
): boolean {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (!STOPPING_STEPS.has(granularity ?? "") || selection.isCollapsed) return false;
  if (anchorNode === null || focusNode === null) return false;
  const wasInFront = isInFrontOf(focusNode, focusOffset, anchorNode, anchorOffset);
  const isBehind = isInFrontOf(anchorNode, anchorOffset, target[0], target[1]);
  const isInFront = isInFrontOf(target[0], target[1], anchorNode, anchorOffset);
  return wasInFront ? isBehind : isInFront;
}

function fakeModify(
  this: Selection,
  alter?: string,
  direction?: string,
  granularity?: string,
): void {
  modifyCalls.push(`${alter} ${direction} ${granularity}`);
  const texts = allTexts();
  const isBoundaryStep = BOUNDARY_STEPS.has(granularity ?? "");
  if (alter === "extend" && isBoundaryStep && !this.isCollapsed) {
    growToBoundary(this, texts, direction, granularity);
    return;
  }
  const [index, offset] = textPlaceOf(texts, this.focusNode, this.focusOffset);
  const into = stepsInto.get(`${where(this.focusNode, this.focusOffset)} ${direction} ${granularity}`);
  if (index === -1 && into === undefined) return;
  const target = into ?? stepTarget(texts, index, offset, direction, granularity);
  if (target === null) return;
  if (alter === "move") {
    this.collapse(target[0], target[1]);
    return;
  }
  if (stopsWhereSelectionStarted(this, target, granularity) && this.anchorNode !== null) {
    this.extend(this.anchorNode, this.anchorOffset);
    return;
  }
  this.extend(target[0], target[1]);
}

function define(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
}

function runFrame(): void {
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(0);
}

function where(node: Node | null, offset: number): string {
  const name = node === null ? undefined : nodeNames.get(node);
  return `${name ?? node?.parentElement?.id ?? "?"}:${offset}`;
}

function anchorAt(): string {
  const selection = getSelection();
  return where(selection.anchorNode, selection.anchorOffset);
}

function focusAt(): string {
  const selection = getSelection();
  return where(selection.focusNode, selection.focusOffset);
}

// The fixture has line breaks between its paragraphs, which a selection over
// several lines picks up.
function selectedText(): string {
  return getSelection().toString().replace(/\s+/g, " ");
}

function copyModeUi(): Extract<CopyModeUi, { active: true }> {
  const ui = getUiState().copyMode;
  if (!ui.active) throw new Error("copy mode is not active");
  return ui;
}

function noticeText(): string | null {
  return getUiState().notice?.text ?? null;
}

function blockAt(lineIndex: number, offset: number): CursorRect {
  return {
    left: TEXT_INSET + offset * CHAR_WIDTH,
    top: CONTENT_TOP + lineIndex * LINE_HEIGHT - scrollTop,
    width: CHAR_WIDTH,
    height: LINE_HEIGHT,
  };
}

function caretAt(lineIndex: number, offset: number): CursorRect {
  return { ...blockAt(lineIndex, offset), width: CARET_WIDTH };
}

// tmux's option mode-keys picks the copy table, and the plugin reads it from
// the tmux config, which is a made-up one here.
function useModeKeys(modeKeys: ModeKeys): void {
  setBridge({
    settings: DEFAULT_SETTINGS,
    tmux: tmuxConfigOf(`setw -g mode-keys ${modeKeys}`),
    layout: null,
    context: { projectId: null, threadId: null },
  } as unknown as Bridge);
}

function expectShown(shown: ShownSelection): void {
  const [line, offset, on] = shown.cursor;
  expect({
    anchor: anchorAt(),
    focus: focusAt(),
    text: selectedText(),
    cursor: copyModeUi().cursor,
  }).toEqual({
    anchor: shown.anchor,
    focus: shown.focus,
    text: shown.text,
    cursor: on === "character" ? blockAt(line, offset) : caretAt(line, offset),
  });
}

// What the selection of the page holds at the moment the copy is made, which
// is what the browser's copy command takes. As that command does, the copy
// counts as empty when nothing is selected.
async function copyAndReadSelection(after: AfterCopy): Promise<string> {
  let selected = "";
  vi.mocked(copySelection).mockImplementation(async () => {
    selected = getSelection().toString();
    return selected === "" ? "empty" : "copied";
  });
  await yankCopySelection(after);
  return selected;
}

// Copy mode starts at the focus end of an existing selection, so selecting up
// to a position and entering puts the cursor there.
function enterAt(id: string, offset: number): void {
  const text = textOf(id);
  getSelection().setBaseAndExtent(text, offset === 0 ? 1 : 0, text, offset);
  expect(enterCopyMode()).toBe(true);
  modifyCalls = [];
}

function removeRow(lineId: string): void {
  byId(lineId).closest("[data-timeline-row-id]")?.remove();
}

// As bb 0.50.1 draws a highlighted code block (MarkdownCodeBlock in
// markdown-preview.tsx): the code in a pre element, every line an inline
// block (.bb-code-highlight .sh__line in markdown-code-highlight.css), with
// a line break between two of them.
function codeBlock(first: number, last: number): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "bb-code-highlight";
  const code = document.createElement("code");
  pre.append(code);
  byId(`line-${first}`).closest("[data-timeline-row-id]")?.before(pre);
  for (let index = first; index <= last; index += 1) {
    const line = byId(`line-${index}`);
    line.style.display = "inline-block";
    code.append(line, "\n");
  }
  return code;
}

// As bb 0.50.1 draws a code block (MarkdownCodeBlock in markdown-preview.tsx):
// a frame that holds a header and under it the code. The header shows the
// name of the language and two buttons, and bb marks it so that its own copy
// leaves it out. The line of the fixture becomes that name, and the lines
// after it, up to the last one, the lines of the code.
function codeBlockUnderHeader(headerLine: number, last: number): HTMLElement {
  const label = byId(`line-${headerLine}`);
  textOf(`line-${headerLine}`).data = "ts";
  const frame = document.createElement("div");
  frame.innerHTML = `<div data-clipboard-ignore=""><div><button type="button" aria-label="Wrap lines"></button><button type="button" aria-label="Copy code"></button></div></div>`;
  label.closest("[data-timeline-row-id]")?.before(frame);
  const header = frame.querySelector<HTMLElement>("[data-clipboard-ignore]");
  const pre = codeBlock(headerLine + 1, last).parentElement;
  if (header === null || pre === null) throw new Error("the fixture header is missing");
  header.prepend(label);
  frame.append(pre);
  return header;
}

// As bb 0.50.1 draws a long message of the user (CollapsibleMessageText in
// ConversationMessageContent.tsx): a box with the text, under it the button
// that shows or hides the rest of it (ConversationMessageOverflowToggle in
// conversation-message-overflow.tsx), and beside them the button for the
// message actions, which opens a menu. body becomes that box, and the text of
// the fixture line becomes the label of the button.
function messageWithToggle(
  body: HTMLElement,
  labelLine: number,
  label: "Show more" | "Show less",
): HTMLButtonElement {
  const text = textOf(`line-${labelLine}`);
  text.data = label;
  const message = document.createElement("div");
  message.innerHTML = `<div data-message-column=""><div><div><div id="message-text"></div><div><button type="button" id="toggle" aria-expanded="${label === "Show less"}"></button></div></div><div><button type="button" aria-label="Message actions" aria-haspopup="menu" aria-expanded="false"></button></div></div></div>`;
  const row = body.closest("[data-timeline-row-id]") ?? body;
  row.before(message);
  byId("message-text").append(body);
  const toggle = byId<HTMLButtonElement>("toggle");
  toggle.append(text);
  removeRow(`line-${labelLine}`);
  if (row !== body) row.remove();
  return toggle;
}

beforeEach(() => {
  boxes = new Map();
  scrollTop = 0;
  maxScrollTop = Number.POSITIVE_INFINITY;
  modifyCalls = [];
  doesMarginFindLine = false;
  doesWordMoveSkipBlanks = false;
  doesWordMoveStopAtTextStart = false;
  jumpedOverLines = new Set();
  stepsInto = new Map();
  nodeNames = new Map();
  frames = new Map();
  nextFrameId = 0;
  caretPositionFromPoint = vi.fn(positionAt);
  define(Selection.prototype, "modify", fakeModify);
  define(Range.prototype, "getClientRects", fakeClientRects);
  define(document, "caretPositionFromPoint", caretPositionFromPoint);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  // As in a browser, the view does not scroll past the ends of its content.
  vi.mocked(scrollTimelineBy).mockImplementation((delta: number) => {
    scrollTop = Math.min(maxScrollTop, Math.max(0, scrollTop + delta));
    return true;
  });
  vi.mocked(copySelection).mockResolvedValue("copied");
  mountThread();
});

afterEach(() => {
  exitCopyMode();
  getSelection().removeAllRanges();
  document.body.innerHTML = "";
  Reflect.deleteProperty(Selection.prototype, "modify");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(document, "caretPositionFromPoint");
  Reflect.deleteProperty(document, "caretRangeFromPoint");
  resetStore();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("isConversationText", () => {
  it("is true for message text, whether given the text or its element", () => {
    expect(isConversationText(textOf("line-0"))).toBe(true);
    expect(isConversationText(byId("line-0"))).toBe(true);
  });

  it("is true for other text of the thread window", () => {
    expect(isConversationText(textOf("context-card"))).toBe(true);
  });

  it("is false outside a thread window and for no node", () => {
    expect(isConversationText(textOf("pane-title"))).toBe(false);
    expect(isConversationText(document.body)).toBe(false);
    expect(isConversationText(null)).toBe(false);
  });

  it("is false in the message box", () => {
    expect(isConversationText(textOf("draft"))).toBe(false);
  });

  it("is true for text beside the message box in the scroller's footer", () => {
    expect(isConversationText(textOf("footer-note"))).toBe(true);
  });

  it("is false in editable elements, terminals and dialogs inside a conversation", () => {
    byId("menu-layer").innerHTML = `
      ${SELECTION_MENU_HTML}
      <div contenteditable="true"><p id="inline-editor">Edited message</p></div>
      <div contenteditable="false"><p id="read-only">Read only</p></div>
      <textarea id="plain-field">Field</textarea>
      <div data-app-terminal=""><span id="terminal-text">npm test</span></div>
      <div class="xterm"><span id="bare-terminal-text">npm test</span></div>
      <div role="menu"><span id="menu-item">Rename</span></div>`;

    expect(isConversationText(textOf("add-to-chat"))).toBe(false);
    expect(isConversationText(textOf("inline-editor"))).toBe(false);
    expect(isConversationText(textOf("plain-field"))).toBe(false);
    expect(isConversationText(textOf("terminal-text"))).toBe(false);
    expect(isConversationText(textOf("bare-terminal-text"))).toBe(false);
    expect(isConversationText(textOf("menu-item"))).toBe(false);
    expect(isConversationText(textOf("read-only"))).toBe(true);
  });
});

describe("enterCopyMode", () => {
  it("starts at the start of the last line that shows above the message box", () => {
    expect(enterCopyMode()).toBe(true);

    expect(isCopyModeActive()).toBe(true);
    expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
    expect(getSelection().isCollapsed).toBe(true);
    expect(getUiState().copyMode).toEqual({
      active: true,
      selecting: false,
      cursor: blockAt(13, 0),
    });
  });

  it("brings a position found in the middle of a line to the line's start", () => {
    enterCopyMode();

    expect(modifyCalls).toEqual(["extend backward lineboundary"]);
  });

  it("finds the line from the page margin where the browser reports the nearest text", () => {
    doesMarginFindLine = true;

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
    expect(caretPositionFromPoint).toHaveBeenCalledTimes(1);
  });

  it("uses caretRangeFromPoint where caretPositionFromPoint is missing", () => {
    Reflect.deleteProperty(document, "caretPositionFromPoint");
    const caretRangeFromPoint = vi.fn((x: number, y: number) => {
      const position = positionAt(x, y);
      if (position === null) return null;
      const range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      return range;
    });
    define(document, "caretRangeFromPoint", caretRangeFromPoint);

    expect(enterCopyMode()).toBe(true);

    expect(caretRangeFromPoint).toHaveBeenCalled();
    expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
  });

  it("starts at the focus end of a selection in the conversation", () => {
    getSelection().setBaseAndExtent(textOf("line-2"), 5, textOf("line-4"), 3);

    expect(enterCopyMode()).toBe(true);

    expect(anchorAt()).toBe("line-4:3");
    expect(focusAt()).toBe("line-4:3");
    expect(getSelection().isCollapsed).toBe(true);
    expect(copyModeUi()).toEqual({ active: true, selecting: false, cursor: blockAt(4, 3) });
    expect(caretPositionFromPoint).not.toHaveBeenCalled();
    expect(modifyCalls).toEqual([]);
  });

  it("starts at the focus end of a selection that was made backwards", () => {
    getSelection().setBaseAndExtent(textOf("line-4"), 3, textOf("line-2"), 5);

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe("line-2:5");
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("ignores a selection whose focus is in the message box", () => {
    getSelection().setBaseAndExtent(textOf("line-2"), 0, textOf("draft"), 4);

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
  });

  it("ignores a selection outside the conversation", () => {
    getSelection().setBaseAndExtent(textOf("pane-title"), 0, textOf("pane-title"), 6);

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
  });

  it("ignores a selection whose focus is off screen", () => {
    getSelection().setBaseAndExtent(textOf("line-2"), 0, textOf("line-18"), 4);

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
  });

  it("ignores a collapsed selection", () => {
    getSelection().collapse(textOf("line-2"), 4);

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
  });

  it("is false and changes nothing where no conversation is shown", () => {
    document.body.innerHTML = '<main><p id="settings">Settings page</p></main>';
    const text = textOf("settings");
    getSelection().setBaseAndExtent(text, 0, text, 8);
    const listener = vi.fn();
    subscribeUiState(listener);

    expect(enterCopyMode()).toBe(false);

    expect(isCopyModeActive()).toBe(false);
    expect(getSelection().toString()).toBe("Settings");
    expect(listener).not.toHaveBeenCalled();
  });

  it("is false where the browser cannot move a selection", () => {
    Reflect.deleteProperty(Selection.prototype, "modify");

    expect(enterCopyMode()).toBe(false);

    expect(isCopyModeActive()).toBe(false);
    expect(getUiState().copyMode).toEqual({ active: false });
  });

  it("is false and changes nothing when no text is found", () => {
    caretPositionFromPoint.mockReturnValue(null);
    const title = textOf("pane-title");
    getSelection().setBaseAndExtent(title, 0, title, 6);
    const added = vi.spyOn(document, "addEventListener");

    expect(enterCopyMode()).toBe(false);

    expect(isCopyModeActive()).toBe(false);
    expect(getSelection().toString()).toBe("Thread");
    expect(getUiState().copyMode).toEqual({ active: false });
    expect(added).not.toHaveBeenCalled();
  });

  it("is false where the browser has no way to find text at a point", () => {
    Reflect.deleteProperty(document, "caretPositionFromPoint");

    expect(enterCopyMode()).toBe(false);
  });

  it("skips text of the footer that the browser reports for a point above it", () => {
    caretPositionFromPoint.mockImplementation((x: number, y: number) => {
      if (y < 390) return positionAt(x, y);
      return { offsetNode: textOf(x < 400 ? "footer-note" : "draft"), offset: 2 };
    });

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
  });

  it("does not start in text that only shows under the message box", () => {
    scrollTop = 400;

    expect(enterCopyMode()).toBe(false);
    expect(getSelection().rangeCount).toBe(0);
  });

  it("stays as it is when entered again", () => {
    enterAt("line-2", 6);

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe("line-2:6");
    expect(caretPositionFromPoint).not.toHaveBeenCalled();
  });

  it("uses the conversation of the focused pane", () => {
    mountSplit("b");

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe(`b-${LAST_VISIBLE_LINE}:0`);
  });

  it("ignores a selection in a pane that is not focused", () => {
    mountSplit("b");
    getSelection().setBaseAndExtent(textOf("a-line-2"), 0, textOf("a-line-2"), 4);

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe(`b-${LAST_VISIBLE_LINE}:0`);
  });

  it("is false while several panes are shown and none is focused", () => {
    mountSplit(null);

    expect(enterCopyMode()).toBe(false);
  });
});

describe("moveCopyCursor without a selection", () => {
  const moves: [CopyMotion, string, string][] = [
    ["char-left", "extend left character", "line-2:5"],
    ["char-right", "extend right character", "line-2:7"],
    ["line-up", "move backward line", "line-1:6"],
    ["line-down", "move forward line", "line-3:6"],
    ["word-back", "extend backward word", "line-2:5"],
    ["line-start", "extend backward paragraphboundary", "line-2:0"],
    ["line-end", "extend forward paragraphboundary", "line-2:14"],
  ];

  it.each(moves)("%s makes one move and leaves a caret at the new place", (motion, call, place) => {
    enterAt("line-2", 6);

    moveCopyCursor(motion);

    expect(modifyCalls).toEqual([call]);
    expect(anchorAt()).toBe(place);
    expect(focusAt()).toBe(place);
    expect(getSelection().isCollapsed).toBe(true);
    expect(copyModeUi().selecting).toBe(false);
  });

  // The browser's move by a paragraph keeps the column. tmux goes to the
  // start of the line (window_copy_next_paragraph and
  // window_copy_previous_paragraph in window-copy.c).
  it.each<[CopyMotion, string, string, string]>([
    ["paragraph-back", "backward", "line-1", "line-1:0"],
    ["paragraph-forward", "forward", "line-3", "line-3:0"],
  ])(
    "%s makes the browser's move to the paragraph, which keeps the column, and goes to the start of that paragraph",
    (motion, direction, reached, place) => {
      enterAt("line-2", 6);
      stepsInto.set(`line-2:6 ${direction} paragraph`, [textOf(reached), 6]);

      moveCopyCursor(motion);

      expect(modifyCalls).toEqual([
        `extend ${direction} paragraph`,
        "move backward paragraphboundary",
      ]);
      expect(anchorAt()).toBe(place);
      expect(focusAt()).toBe(place);
      expect(getSelection().isCollapsed).toBe(true);
      expect(copyModeUi().cursor).toEqual(blockAt(Number(reached.slice(5)), 0));
    },
  );

  it("paragraph-forward stays where it is in the last paragraph when the browser's move finds no paragraph", () => {
    scrollTop = 200;
    enterAt(LAST_LINE, 3);

    moveCopyCursor("paragraph-forward");

    expect(focusAt()).toBe(`${LAST_LINE}:3`);
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("paragraph-forward stays where the browser's move ends when that is in the paragraph of the cursor, as in the last one of the conversation", () => {
    scrollTop = 200;
    enterAt(LAST_LINE, 3);
    stepsInto.set(`${LAST_LINE}:3 forward paragraph`, [textOf(LAST_LINE), 11]);

    moveCopyCursor("paragraph-forward");

    expect(focusAt()).toBe(`${LAST_LINE}:11`);
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("paragraph-back goes to the start of the first paragraph from inside it", () => {
    enterAt("line-0", 6);

    moveCopyCursor("paragraph-back");

    expect(focusAt()).toBe("line-0:0");
  });

  it("word-end makes one word move, looks at the character in front of where that ended, and leaves a caret at the end of the word", () => {
    enterAt("line-2", 6);

    moveCopyCursor("word-end");

    expect(modifyCalls).toEqual(["extend forward word", "extend backward character"]);
    expect(anchorAt()).toBe("line-2:8");
    expect(focusAt()).toBe("line-2:8");
    expect(getSelection().isCollapsed).toBe(true);
    expect(copyModeUi().selecting).toBe(false);
  });

  it("publishes the rectangle of the character after the cursor", () => {
    enterAt("line-2", 6);

    moveCopyCursor("char-right");

    expect(copyModeUi().cursor).toEqual(blockAt(2, 7));
  });

  it("publishes a narrow rectangle at the end of a line", () => {
    enterAt("line-2", 6);

    moveCopyCursor("line-end");

    expect(copyModeUi().cursor).toEqual(caretAt(2, 14));
  });

  it("goes on from the new place on the next move", () => {
    enterAt("line-2", 6);

    moveCopyCursor("line-down");
    moveCopyCursor("char-right");

    expect(focusAt()).toBe("line-3:7");
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("goes back to its own cursor when something else changed the selection", () => {
    enterAt("line-2", 6);
    getSelection().setBaseAndExtent(textOf("line-0"), 0, textOf("line-0"), 5);

    moveCopyCursor("char-right");

    expect(anchorAt()).toBe("line-2:7");
    expect(focusAt()).toBe("line-2:7");
  });

  it("goes on after something else cleared the selection", () => {
    enterAt("line-2", 6);
    getSelection().removeAllRanges();

    moveCopyCursor("char-right");

    expect(focusAt()).toBe("line-2:7");
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("does nothing while copy mode is not active", () => {
    const text = textOf("line-2");
    getSelection().setBaseAndExtent(text, 0, text, 4);

    moveCopyCursor("char-right");

    expect(modifyCalls).toEqual([]);
    expect(getSelection().toString()).toBe("zeta");
  });
});

describe("moveCopyCursor while selecting", () => {
  const moves: [CopyMotion, string, string][] = [
    ["char-left", "extend left character", "line-2:5"],
    ["char-right", "extend right character", "line-2:7"],
    ["line-up", "extend backward line", "line-1:6"],
    ["line-down", "extend forward line", "line-3:6"],
    ["word-back", "extend backward word", "line-2:5"],
    ["line-start", "extend backward paragraphboundary", "line-2:0"],
    ["line-end", "extend forward paragraphboundary", "line-2:14"],
  ];

  it.each(moves)("%s extends from the anchor to the new place", (motion, call, place) => {
    enterAt("line-2", 6);
    beginCopySelection();

    moveCopyCursor(motion);

    expect(modifyCalls).toEqual([call]);
    expect(anchorAt()).toBe("line-2:6");
    expect(focusAt()).toBe(place);
    expect(getSelection().isCollapsed).toBe(false);
    expect(copyModeUi().selecting).toBe(true);
  });

  it.each<[CopyMotion, string, string, string]>([
    ["paragraph-back", "backward", "line-1", "line-1:0"],
    ["paragraph-forward", "forward", "line-3", "line-3:0"],
  ])(
    "%s extends from the anchor to the start of the paragraph that the browser's move reaches",
    (motion, direction, reached, place) => {
      enterAt("line-2", 6);
      beginCopySelection();
      stepsInto.set(`line-2:6 ${direction} paragraph`, [textOf(reached), 6]);

      moveCopyCursor(motion);

      expect(modifyCalls).toEqual([
        `extend ${direction} paragraph`,
        "move backward paragraphboundary",
      ]);
      expect(anchorAt()).toBe("line-2:6");
      expect(focusAt()).toBe(place);
      expect(copyModeUi().selecting).toBe(true);
    },
  );

  // Chromium on macOS grows a selection on a step to the start or the end
  // of a line: it moves the end that lies on that side, which is the end the
  // selection was started at when the cursor is on the other side of it.
  describe.each<ModeKeys>(["vi", "emacs"])("to the ends of a line with tmux's %s keys, after the cursor moved away from where the selection was started", (modeKeys) => {
    beforeEach(() => {
      useModeKeys(modeKeys);
    });

    it.each<[CopyMotion, string]>([
      ["line-start", "line-2:0"],
      ["line-indent", "line-2:0"],
    ])("%s goes back over where the selection was started, to the start of the line", (motion, place) => {
      enterAt("line-2", 6);
      beginCopySelection();
      moveCopyCursor("char-right");
      moveCopyCursor("char-right");

      moveCopyCursor(motion);

      expect(focusAt()).toBe(place);
      expect(copyModeUi().cursor).toEqual(blockAt(2, 0));
      expect(selectedText()).toBe(modeKeys === "vi" ? "zeta et" : "zeta e");
    });

    it("line-end goes on to the end of the line from a cursor in front of where the selection was started", () => {
      enterAt("line-2", 6);
      beginCopySelection();
      moveCopyCursor("char-left");
      moveCopyCursor("char-left");

      moveCopyCursor("line-end");

      expect(focusAt()).toBe("line-2:14");
      expect(copyModeUi().cursor).toEqual(caretAt(2, 14));
      expect(selectedText()).toBe("ta theta");
    });

    it("line-end goes on from a cursor behind where the selection was started", () => {
      enterAt("line-2", 6);
      beginCopySelection();
      moveCopyCursor("char-right");

      moveCopyCursor("line-end");

      expect(anchorAt()).toBe("line-2:6");
      expect(focusAt()).toBe("line-2:14");
    });

    it("line-start goes on from a cursor in front of where the selection was started", () => {
      enterAt("line-2", 6);
      beginCopySelection();
      moveCopyCursor("char-left");

      moveCopyCursor("line-start");

      expect(focusAt()).toBe("line-2:0");
      expect(selectedText()).toBe(modeKeys === "vi" ? "zeta et" : "zeta e");
    });
  });

  it("word-end extends from the anchor to the end of the word", () => {
    enterAt("line-2", 6);
    beginCopySelection();

    moveCopyCursor("word-end");

    expect(modifyCalls).toEqual(["extend forward word", "extend backward character"]);
    expect(anchorAt()).toBe("line-2:6");
    expect(focusAt()).toBe("line-2:8");
    expect(getSelection().toString()).toBe("ta");
    expect(copyModeUi().selecting).toBe(true);
  });

  it("keeps the anchor over several moves, also back past it", () => {
    enterAt("line-2", 6);
    beginCopySelection();

    moveCopyCursor("line-down");
    moveCopyCursor("word-end");
    expect(anchorAt()).toBe("line-2:6");
    expect(focusAt()).toBe("line-3:10");
    expect(selectedText()).toBe("ta theta row 3 text");

    moveCopyCursor("line-up");
    moveCopyCursor("line-up");
    expect(anchorAt()).toBe("line-2:6");
    expect(focusAt()).toBe("line-1:10");
    expect(selectedText()).toBe("lon zeta e");
  });

  it("leaves a selection that already matches alone, so the browser keeps its column", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    const setBaseAndExtent = vi.spyOn(getSelection(), "setBaseAndExtent");
    const collapse = vi.spyOn(getSelection(), "collapse");

    moveCopyCursor("line-down");
    moveCopyCursor("line-down");

    expect(setBaseAndExtent).not.toHaveBeenCalled();
    expect(collapse).not.toHaveBeenCalled();
  });

  it("draws the cursor at the moving end of the selection", () => {
    enterAt("line-2", 6);
    beginCopySelection();

    moveCopyCursor("line-down");

    expect(copyModeUi()).toEqual({ active: true, selecting: true, cursor: blockAt(3, 6) });
  });
});

describe("moveCopyCursor word-forward", () => {
  it("goes to the start of the next word from inside a word", () => {
    enterAt("line-2", 6);

    moveCopyCursor("word-forward");

    expect(focusAt()).toBe("line-2:9");
    expect(getSelection().isCollapsed).toBe(true);
    expect(modifyCalls).toEqual([
      "extend forward word",
      "extend backward word",
      "extend forward word",
      "extend backward word",
    ]);
  });

  it("goes to the start of the next word from the start of a word", () => {
    enterAt("line-2", 5);

    moveCopyCursor("word-forward");

    expect(focusAt()).toBe("line-2:9");
  });

  it("goes to the word that follows from the end of a word", () => {
    enterAt("line-2", 4);

    moveCopyCursor("word-forward");

    expect(focusAt()).toBe("line-2:5");
    expect(modifyCalls).toEqual(["extend forward word", "extend backward word"]);
  });

  it("goes to the first word of the next line from the last word of a line", () => {
    enterAt("line-2", 10);

    moveCopyCursor("word-forward");

    expect(focusAt()).toBe("line-3:0");
  });

  it("stops at the end of the last word of the conversation", () => {
    scrollTop = 200;
    enterAt(LAST_LINE, 8);

    moveCopyCursor("word-forward");

    expect(focusAt()).toBe(`${LAST_LINE}:11`);
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("stays where it is at the very end of the conversation", () => {
    scrollTop = 200;
    enterAt(LAST_LINE, 11);

    moveCopyCursor("word-forward");

    expect(focusAt()).toBe(`${LAST_LINE}:11`);
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("goes to the start of the next word where the browser reports no rectangles", () => {
    enterAt("line-2", 6);
    Reflect.deleteProperty(Range.prototype, "getClientRects");

    moveCopyCursor("word-forward");

    expect(focusAt()).toBe("line-2:9");
  });

  it("goes on to the first word of the next line from a cursor in a text that is not drawn any more", () => {
    enterAt("line-2", 10);
    boxes.delete(textOf("line-2"));

    moveCopyCursor("word-forward");

    expect(focusAt()).toBe("line-3:0");
  });

  it("extends the selection to the start of the next word while selecting", () => {
    enterAt("line-2", 6);
    beginCopySelection();

    moveCopyCursor("word-forward");

    expect(anchorAt()).toBe("line-2:6");
    expect(focusAt()).toBe("line-2:9");
    expect(getSelection().toString()).toBe("ta ");
  });
});

describe("moveCopyCursor word-end", () => {
  it("goes to the end of the word from inside it, with one word move of the browser", () => {
    enterAt("line-2", 6);

    moveCopyCursor("word-end");

    expect(focusAt()).toBe("line-2:8");
    expect(modifyCalls).toEqual(["extend forward word", "extend backward character"]);
  });

  it("goes to the end of the next word from the end of a word", () => {
    enterAt("line-2", 4);

    moveCopyCursor("word-end");

    expect(focusAt()).toBe("line-2:8");
    expect(modifyCalls).toEqual(["extend forward word", "extend backward character"]);
  });

  it("goes to the end of the word from in front of its last character", () => {
    enterAt("line-2", 7);

    moveCopyCursor("word-end");

    expect(focusAt()).toBe("line-2:8");
  });

  it("goes to the end of the word where the browser reports no rectangles", () => {
    enterAt("line-2", 6);
    Reflect.deleteProperty(Range.prototype, "getClientRects");

    moveCopyCursor("word-end");

    expect(focusAt()).toBe("line-2:8");
  });

  it("goes to the end of the first word of the next line from the end of a line", () => {
    enterAt("line-2", 14);

    moveCopyCursor("word-end");

    expect(focusAt()).toBe("line-3:3");
    expect(getSelection().isCollapsed).toBe(true);
  });

  describe("in Chromium, whose word move from the end of a paragraph stops at the start of the text that follows", () => {
    beforeEach(() => {
      doesWordMoveStopAtTextStart = true;
    });

    it("goes on to the end of the first word of the next paragraph in one press, as tmux does", () => {
      enterAt("line-2", 14);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe("line-3:3");
      expect(copyModeUi().cursor).toEqual(blockAt(3, 3));
      expect(modifyCalls).toEqual([
        "extend forward word",
        "extend backward character",
        "extend forward word",
        "extend backward character",
      ]);
    });

    it("goes on from word to word and from paragraph to paragraph on every press", () => {
      enterAt("line-2", 8);
      const visited: string[] = [];

      for (let press = 0; press < 5; press += 1) {
        moveCopyCursor("word-end");
        visited.push(focusAt());
      }

      expect(visited).toEqual(["line-2:14", "line-3:3", "line-3:5", "line-3:10", "line-4:3"]);
    });

    it("extends a selection from the end of a paragraph over the first word of the next one", () => {
      enterAt("line-2", 14);
      beginCopySelection();

      moveCopyCursor("word-end");

      expect(anchorAt()).toBe("line-2:14");
      expect(focusAt()).toBe("line-3:3");
      expect(selectedText()).toBe(" row");
    });

    it("stays at the very end of the conversation", () => {
      scrollTop = 200;
      enterAt(LAST_LINE, 11);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe(`${LAST_LINE}:11`);
      expect(getSelection().isCollapsed).toBe(true);
    });

    it("goes on from the end of a line of code that bb draws as a box of its own", () => {
      codeBlock(4, 5);
      enterAt("line-4", 10);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe("line-5:3");
    });
  });

  describe("on Windows, where the browser's word move lands on the start of the next word", () => {
    beforeEach(() => {
      doesWordMoveSkipBlanks = true;
    });

    it.each([
      ["from inside a word", 6, "line-2:8"],
      ["from the start of a word", 5, "line-2:8"],
      ["from the end of a word, where it goes to the end of the next word", 4, "line-2:8"],
      ["from the end of the word before the last one", 8, "line-2:14"],
      ["from the start of the last word of a line", 9, "line-2:14"],
      ["from inside the last word of a line", 10, "line-2:14"],
    ])("goes to the end of the word %s", (_name, offset, place) => {
      enterAt("line-2", offset);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe(place);
      expect(getSelection().isCollapsed).toBe(true);
    });

    it("differs from word-forward, which goes to the start of the next word", () => {
      enterAt("line-2", 0);
      moveCopyCursor("word-end");
      expect(focusAt()).toBe("line-2:4");

      enterAt("line-2", 0);
      moveCopyCursor("word-forward");
      expect(focusAt()).toBe("line-2:5");
    });

    it("selects the word without the blank that follows it", () => {
      enterAt("line-2", 0);
      beginCopySelection();

      moveCopyCursor("word-end");

      expect(anchorAt()).toBe("line-2:0");
      expect(getSelection().toString()).toBe("zeta");
    });

    it("stays where it is at the very end of the conversation", () => {
      scrollTop = 200;
      enterAt(LAST_LINE, 11);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe(`${LAST_LINE}:11`);
      expect(getSelection().isCollapsed).toBe(true);
    });
  });
});

describe("moveCopyCursor to the ends of the conversation", () => {
  beforeEach(() => {
    mountThread({
      extraRowsHtml: `
        <div data-timeline-row-id="row-hidden"><span id="hidden-label">Hidden label</span></div>`,
    });
    define(byId("hidden-label"), "checkVisibility", () => false);
    byId("menu-layer").innerHTML = SELECTION_MENU_HTML;
  });

  it("document-start goes to the first text that shows in the conversation", () => {
    enterAt("line-2", 6);

    moveCopyCursor("document-start");

    expect(focusAt()).toBe("line-0:0");
    expect(getSelection().isCollapsed).toBe(true);
    expect(modifyCalls).toEqual([]);
  });

  it("document-end goes to the last text of the conversation, not past it", () => {
    enterAt("line-2", 6);

    moveCopyCursor("document-end");

    expect(focusAt()).toBe(`${LAST_LINE}:11`);
    expect(getSelection().isCollapsed).toBe(true);
    expect(modifyCalls).toEqual([]);
  });

  it("document-start extends the selection from the anchor", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    const extend = vi.spyOn(getSelection(), "extend");

    moveCopyCursor("document-start");

    expect(extend).toHaveBeenCalledExactlyOnceWith(textOf("line-0"), 0);
    expect(anchorAt()).toBe("line-2:6");
    expect(focusAt()).toBe("line-0:0");
    expect(selectedText()).toBe("alpha beta gamma delta epsilon zeta e");
  });

  it("document-end extends the selection from the anchor", () => {
    scrollTop = 200;
    enterAt("line-18", 0);
    beginCopySelection();

    moveCopyCursor("document-end");

    expect(anchorAt()).toBe("line-18:0");
    expect(focusAt()).toBe(`${LAST_LINE}:11`);
    expect(selectedText()).toBe("row 18 text row 19 text");
  });

  it("scrolls the conversation to the place it went to", () => {
    enterAt("line-2", 6);

    moveCopyCursor("document-end");

    expect(scrollTimelineBy).toHaveBeenCalledExactlyOnceWith(116, document);
    expect(copyModeUi().cursor).toEqual(caretAt(19, 11));
  });

  it("stays put in a conversation that has no text that shows", () => {
    enterAt("line-2", 6);
    for (const line of document.querySelectorAll("p[data-line]")) {
      if (line.id !== "line-2") line.closest("[data-timeline-row-id]")?.remove();
    }
    define(byId("line-2"), "checkVisibility", () => false);

    moveCopyCursor("document-end");

    expect(focusAt()).toBe("line-2:6");
  });
});

describe("moveCopyCursor to a line on screen", () => {
  beforeEach(() => {
    scrollTop = 50;
  });

  it("screen-top goes to the start of the first line that shows in full", () => {
    enterAt("line-8", 4);

    moveCopyCursor("screen-top");

    expect(focusAt()).toBe("line-3:0");
    expect(getSelection().isCollapsed).toBe(true);
    expect(scrollTimelineBy).not.toHaveBeenCalled();
  });

  it("screen-middle goes to the start of the line in the middle", () => {
    enterAt("line-3", 4);

    moveCopyCursor("screen-middle");

    expect(focusAt()).toBe("line-9:0");
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("screen-bottom goes to the start of the last line above the message box", () => {
    enterAt("line-3", 4);

    moveCopyCursor("screen-bottom");

    expect(focusAt()).toBe("line-15:0");
    expect(getSelection().isCollapsed).toBe(true);
    expect(scrollTimelineBy).not.toHaveBeenCalled();
  });

  it("extends the selection to the line with Selection.extend while selecting, and goes to the start of the line with the caret alone", () => {
    enterAt("line-8", 4);
    beginCopySelection();
    const extend = vi.spyOn(getSelection(), "extend");

    moveCopyCursor("screen-top");

    expect(extend.mock.calls[0]).toEqual([textOf("line-3"), 10]);
    expect(modifyCalls).toEqual(["move backward lineboundary"]);
    expect(anchorAt()).toBe("line-8:4");
    expect(focusAt()).toBe("line-3:0");
    expect(getSelection().isCollapsed).toBe(false);
  });

  // Chromium on macOS grows a selection on a step to the start of a line: it
  // moves the upper end of the selection, which is where the cursor was when
  // the line that is picked is below it.
  it.each<[CopyMotion, string]>([
    ["screen-middle", "line-9:0"],
    ["screen-bottom", "line-15:0"],
  ])("%s goes to the start of a line below the cursor while selecting, and keeps where the selection was started", (motion, place) => {
    enterAt("line-3", 4);
    beginCopySelection();

    moveCopyCursor(motion);

    expect(anchorAt()).toBe("line-3:4");
    expect(focusAt()).toBe(place);
  });

  it("goes to the start of a short line below the cursor, which the middle of the view finds at its end", () => {
    textOf("line-9").data = "short";
    enterAt("line-3", 4);

    moveCopyCursor("screen-middle");

    expect(focusAt()).toBe("line-9:0");
    expect(copyModeUi().cursor).toEqual(blockAt(9, 0));
  });

  it("stays put when no text shows", () => {
    enterAt("line-8", 4);
    caretPositionFromPoint.mockReturnValue(null);

    moveCopyCursor("screen-bottom");

    expect(focusAt()).toBe("line-8:4");
    expect(getSelection().isCollapsed).toBe(true);
  });
});

describe("the column that line moves keep", () => {
  // As a browser does: a move by a line goes for the column that the moves
  // by a line started from, and setting the selection in any other way makes
  // it forget that column.
  let keptColumn: number | null;

  function forgetColumnOn(method: "collapse" | "setBaseAndExtent" | "extend"): void {
    const original = Selection.prototype[method] as (...args: unknown[]) => void;
    vi.spyOn(Selection.prototype, method).mockImplementation(function forget(
      this: Selection,
      ...args: unknown[]
    ) {
      keptColumn = null;
      original.apply(this, args);
    });
  }

  function modifyKeepingColumn(
    this: Selection,
    alter?: string,
    direction?: string,
    granularity?: string,
  ): void {
    if (granularity !== "line") {
      fakeModify.call(this, alter, direction, granularity);
      return;
    }
    modifyCalls.push(`${alter} ${direction} ${granularity}`);
    const texts = allTexts();
    const at = texts.indexOf(this.focusNode as Text);
    const next = texts[at + (direction === "forward" ? 1 : -1)];
    if (next === undefined) return;
    const column = keptColumn ?? this.focusOffset;
    const offset = Math.min(column, next.length);
    const { anchorNode, anchorOffset } = this;
    if (alter === "move" || anchorNode === null) {
      this.collapse(next, offset);
    } else {
      this.setBaseAndExtent(anchorNode, anchorOffset, next, offset);
    }
    keptColumn = column;
  }

  beforeEach(() => {
    keptColumn = null;
    for (const method of ["collapse", "setBaseAndExtent", "extend"] as const) {
      forgetColumnOn(method);
    }
    define(Selection.prototype, "modify", modifyKeepingColumn);
  });

  it("is kept over a short line while nothing is selected", () => {
    enterAt("line-0", 15);

    moveCopyCursor("line-down");
    expect(focusAt()).toBe("line-1:13");

    moveCopyCursor("line-down");
    expect(focusAt()).toBe("line-2:14");

    moveCopyCursor("line-up");
    moveCopyCursor("line-up");
    expect(focusAt()).toBe("line-0:15");
    expect(modifyCalls).toEqual([
      "move forward line",
      "move forward line",
      "move backward line",
      "move backward line",
    ]);
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("is kept over a short line while a selection is under way", () => {
    enterAt("line-0", 15);
    beginCopySelection();

    moveCopyCursor("line-down");
    moveCopyCursor("line-down");

    expect(anchorAt()).toBe("line-0:15");
    expect(focusAt()).toBe("line-2:14");
    expect(modifyCalls).toEqual(["extend forward line", "extend forward line"]);
  });

  it("starts anew after a move that is not by a line", () => {
    enterAt("line-0", 15);
    moveCopyCursor("line-down");

    moveCopyCursor("char-left");
    moveCopyCursor("line-down");

    expect(focusAt()).toBe("line-2:12");
  });

  it("is kept after a copy that left the selection in place but set it again, as the copy does to read the text around the header of a code block", async () => {
    enterAt("line-0", 15);
    beginCopySelection();
    moveCopyCursor("line-down");
    expect(focusAt()).toBe("line-1:13");
    vi.mocked(copySelection).mockImplementation(async () => {
      const { anchorNode, anchorOffset, focusNode, focusOffset } = getSelection();
      if (anchorNode === null || focusNode === null) return "empty";
      getSelection().setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
      return "copied";
    });

    await yankCopySelection("keep");
    moveCopyCursor("line-down");

    expect(anchorAt()).toBe("line-0:15");
    expect(focusAt()).toBe("line-2:14");
  });

  // The selection is set again after a move, to take in the character under
  // the cursor block, and that makes the browser forget the column.
  describe("with tmux's vi keys", () => {
    beforeEach(() => {
      useModeKeys("vi");
      textOf("line-1").data = "short";
    });

    it("is kept over a short line while nothing is selected, by the browser itself", () => {
      enterAt("line-0", 12);

      moveCopyCursor("line-down");
      expect(focusAt()).toBe("line-1:5");
      moveCopyCursor("line-down");
      expect(focusAt()).toBe("line-2:12");
      moveCopyCursor("line-up");
      moveCopyCursor("line-up");

      expect(focusAt()).toBe("line-0:12");
      expect(getSelection().isCollapsed).toBe(true);
      expect(modifyCalls).toEqual([
        "move forward line",
        "move forward line",
        "move backward line",
        "move backward line",
      ]);
    });

    it("is kept on the way down over a short line while a selection is under way", () => {
      enterAt("line-0", 12);
      beginCopySelection();

      moveCopyCursor("line-down");
      expectShown({
        anchor: "line-0:12",
        focus: "line-1:5",
        text: "amma short",
        cursor: [1, 5, "line end"],
      });

      moveCopyCursor("line-down");
      expectShown({
        anchor: "line-0:12",
        focus: "line-2:13",
        text: "amma short zeta eta thet",
        cursor: [2, 12, "character"],
      });
    });

    it("is kept on the way up over a short line, where the selection ends behind the character it was started on", () => {
      enterAt("line-2", 12);
      beginCopySelection();

      moveCopyCursor("line-up");
      expectShown({
        anchor: "line-2:13",
        focus: "line-1:5",
        text: " zeta eta thet",
        cursor: [1, 5, "line end"],
      });

      moveCopyCursor("line-up");
      expectShown({
        anchor: "line-2:13",
        focus: "line-0:12",
        text: "amma short zeta eta thet",
        cursor: [0, 12, "character"],
      });
    });

    it("makes the line moves before again when the selection was set since, which is how the browser finds the column", () => {
      enterAt("line-2", 12);
      beginCopySelection();

      moveCopyCursor("line-up");
      expect(modifyCalls).toEqual(["extend backward line"]);

      moveCopyCursor("line-up");
      expect(modifyCalls).toEqual([
        "extend backward line",
        "extend backward line",
        "extend backward line",
      ]);
    });

    it("is kept back down past where the selection was started and on to a shorter line", () => {
      enterAt("line-2", 12);
      beginCopySelection();
      moveCopyCursor("line-up");
      moveCopyCursor("line-up");

      moveCopyCursor("line-down");
      moveCopyCursor("line-down");
      expectShown({
        anchor: "line-2:12",
        focus: "line-2:13",
        text: "t",
        cursor: [2, 12, "character"],
      });

      moveCopyCursor("line-down");
      expectShown({
        anchor: "line-2:12",
        focus: "line-3:10",
        text: "ta row 3 text",
        cursor: [3, 10, "line end"],
      });
    });

    it("is kept when the selection is started on the short line", () => {
      enterAt("line-0", 12);
      moveCopyCursor("line-down");
      beginCopySelection();

      moveCopyCursor("line-down");

      expectShown({
        anchor: "line-1:5",
        focus: "line-2:13",
        text: " zeta eta thet",
        cursor: [2, 12, "character"],
      });
    });

    it("is kept over a scroll that leaves the cursor in view", () => {
      enterAt("line-2", 12);
      beginCopySelection();
      moveCopyCursor("line-up");

      scrollCopyView(20);
      expect(focusAt()).toBe("line-1:5");
      expect(copyModeUi().cursor).toEqual(caretAt(1, 5));
      moveCopyCursor("line-up");

      expectShown({
        anchor: "line-2:13",
        focus: "line-0:12",
        text: "amma short zeta eta thet",
        cursor: [0, 12, "character"],
      });
    });

    it("is kept when a scroll takes the cursor out of view and finds no line to put it on", () => {
      enterAt("line-2", 12);
      beginCopySelection();
      moveCopyCursor("line-up");
      caretPositionFromPoint.mockReturnValue(null);

      scrollCopyView(80);
      expect(focusAt()).toBe("line-1:5");
      expect(copyModeUi().cursor).toBeNull();
      moveCopyCursor("line-down");

      expectShown({
        anchor: "line-2:12",
        focus: "line-2:13",
        text: "t",
        cursor: [2, 12, "character"],
      });
    });

    it("starts anew after a scroll that took the cursor to another line", () => {
      enterAt("line-2", 12);
      beginCopySelection();
      moveCopyCursor("line-up");

      scrollCopyView(80);
      expect(copyModeUi().cursor).toEqual(blockAt(4, 0));
      moveCopyCursor("line-down");

      expect(copyModeUi().cursor).toEqual(blockAt(5, 0));
    });

    it("starts anew after a move that is not by a line", () => {
      enterAt("line-2", 12);
      beginCopySelection();
      moveCopyCursor("line-up");

      moveCopyCursor("char-left");
      moveCopyCursor("line-up");

      expectShown({
        anchor: "line-2:13",
        focus: "line-0:4",
        text: "a beta gamma short zeta eta thet",
        cursor: [0, 4, "character"],
      });
    });

    it("starts anew when the line moves before no longer lead to the cursor", () => {
      enterAt("line-2", 12);
      beginCopySelection();
      moveCopyCursor("line-up");
      textOf("line-1").data = "now a much longer line";

      moveCopyCursor("line-up");

      expect(focusAt()).toBe("line-0:5");
      expect(anchorAt()).toBe("line-2:13");
    });

    it("makes no more than 16 line moves again, and puts a longer run on each line at the column that it started from", () => {
      mountThread({ lineCount: 40 });
      byId("viewport").getBoundingClientRect = () => rect(0, VIEWPORT_TOP, PANE_WIDTH, 4000);
      byId("footer").remove();
      textOf("line-22").data = "abc";
      enterAt("line-3", 8);
      beginCopySelection();

      const movesMade = Array.from({ length: 20 }, () => {
        modifyCalls = [];
        moveCopyCursor("line-down");
        return modifyCalls.length;
      });

      expect(movesMade).toEqual([
        ...Array.from({ length: 17 }, (_, made) => made + 1),
        1,
        1,
        1,
      ]);
      expect(anchorAt()).toBe("line-3:8");
      expect(copyModeUi().cursor).toEqual(blockAt(23, 8));
      moveCopyCursor("line-up");
      expect(copyModeUi().cursor).toEqual(caretAt(22, 3));
      moveCopyCursor("line-up");
      expect(copyModeUi().cursor).toEqual(blockAt(21, 8));
    });

    it("makes no line move of a long run again on a page key, and starts a run anew after 320 moves", { timeout: 20_000 }, () => {
      mountThread({ lineCount: 100 });
      byId("viewport").getBoundingClientRect = () => rect(0, VIEWPORT_TOP, PANE_WIDTH, 4000);
      byId("footer").remove();
      enterAt("line-3", 4);
      caretPositionFromPoint.mockReturnValue(null);
      beginCopySelection();
      const pages: CopyMotion[] = ["page-down", "page-up", "page-down", "page-up", "page-down"];

      for (const motion of pages) {
        modifyCalls = [];
        moveCopyCursor(motion);
        expect(modifyCalls).toHaveLength(80);
      }
      expect(focusAt()).toBe("line-83:5");
      modifyCalls = [];
      moveCopyCursor("page-up");

      // The run that started anew began elsewhere than the selection, and its
      // last move ends where the selection was started. The browser stops a
      // move there that would go on, so that one is made by the caret as well.
      expect(modifyCalls).toEqual([
        ...Array.from({ length: 80 }, () => "extend backward line"),
        "move backward line",
      ]);
      expect(anchorAt()).toBe("line-3:4");
      expect(focusAt()).toBe("line-3:5");
    });
  });

  // tmux only notes the column where the cursor is not at the end of its
  // line, and neither clear-selection nor begin-selection touches it
  // (window_copy_cursor_down, window_copy_clear_selection and
  // window_copy_start_selection in window-copy.c of tmux 3.5a). Copy mode
  // sets the selection for both, which makes the browser forget the column.
  describe.each<ModeKeys>(["vi", "emacs"])(
    "when the selection is set on a short line between two line moves, with tmux's %s keys",
    (modeKeys) => {
      beforeEach(() => {
        useModeKeys(modeKeys);
        textOf("line-1").data = "short";
      });

      it("is kept after clear-selection", () => {
        enterAt("line-0", 12);
        beginCopySelection();
        moveCopyCursor("line-down");
        expect(focusAt()).toBe("line-1:5");

        clearCopySelection();
        moveCopyCursor("line-down");

        expect(focusAt()).toBe("line-2:12");
        expect(getSelection().isCollapsed).toBe(true);
      });

      it("is kept after a copy that drops the selection", async () => {
        enterAt("line-0", 12);
        beginCopySelection();
        moveCopyCursor("line-down");

        await yankCopySelection("clear");
        moveCopyCursor("line-down");

        expect(focusAt()).toBe("line-2:12");
        expect(getSelection().isCollapsed).toBe(true);
      });

      it("is kept when a selection is started a second time", () => {
        enterAt("line-0", 12);
        beginCopySelection();
        moveCopyCursor("line-down");

        beginCopySelection();
        moveCopyCursor("line-down");

        expect(anchorAt()).toBe("line-1:5");
        expect(copyModeUi().cursor).toEqual(blockAt(2, 12));
        expect(selectedText()).toBe(modeKeys === "vi" ? " zeta eta thet" : " zeta eta the");
      });

      it("is kept on the way back up after clear-selection", () => {
        enterAt("line-2", 12);
        beginCopySelection();
        moveCopyCursor("line-up");

        clearCopySelection();
        moveCopyCursor("line-up");

        expect(focusAt()).toBe("line-0:12");
        expect(getSelection().isCollapsed).toBe(true);
      });

      it("is kept when something else changed the selection between two line moves", () => {
        enterAt("line-0", 12);
        moveCopyCursor("line-down");
        getSelection().setBaseAndExtent(textOf("line-3"), 0, textOf("line-3"), 3);

        moveCopyCursor("line-down");

        expect(focusAt()).toBe("line-2:12");
        expect(getSelection().isCollapsed).toBe(true);
      });
    },
  );
});

describe("moveCopyCursor by half a page", () => {
  it("half-page-down repeats the line move for the lines that fit in half the view", () => {
    enterAt("line-2", 6);

    moveCopyCursor("half-page-down");

    expect(modifyCalls).toEqual(Array(8).fill("move forward line"));
    expect(focusAt()).toBe("line-10:6");
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("half-page-up repeats the line move upwards", () => {
    enterAt("line-12", 3);

    moveCopyCursor("half-page-up");

    expect(modifyCalls).toEqual(Array(8).fill("move backward line"));
    expect(focusAt()).toBe("line-4:3");
  });

  it("half-page-down scrolls the conversation by half the height of the view, so that the cursor stays at its height on screen", () => {
    enterAt("line-2", 6);
    const before = copyModeUi().cursor;

    moveCopyCursor("half-page-down");

    expect(scrollTimelineBy).toHaveBeenCalledExactlyOnceWith(160, document);
    expect(scrollTop).toBe(160);
    expect(copyModeUi().cursor).toEqual(blockAt(10, 6));
    expect(copyModeUi().cursor).toEqual(before);
  });

  it("half-page-up scrolls it up by as much", () => {
    scrollTop = 200;
    enterAt("line-12", 3);
    const before = copyModeUi().cursor;

    moveCopyCursor("half-page-up");

    expect(scrollTimelineBy).toHaveBeenCalledExactlyOnceWith(-160, document);
    expect(scrollTop).toBe(40);
    expect(copyModeUi().cursor).toEqual(before);
  });

  it("extends the selection over the lines while selecting", () => {
    enterAt("line-2", 6);
    beginCopySelection();

    moveCopyCursor("half-page-down");

    expect(anchorAt()).toBe("line-2:6");
    expect(focusAt()).toBe("line-10:6");
  });

  it("stops at the last line of the conversation instead of going back", () => {
    scrollTop = 200;
    enterAt("line-16", 2);

    moveCopyCursor("half-page-down");

    expect(focusAt()).toBe(`${LAST_LINE}:2`);
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("stops at the first line of the conversation", () => {
    enterAt("line-2", 6);

    moveCopyCursor("half-page-up");

    expect(focusAt()).toBe("line-0:6");
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("moves at least one line in a very low view", () => {
    byId("viewport").getBoundingClientRect = () => rect(0, VIEWPORT_TOP, PANE_WIDTH, 30);
    byId("footer").remove();
    enterAt("line-0", 3);

    moveCopyCursor("half-page-down");

    expect(modifyCalls).toEqual(["move forward line"]);
  });

  it("moves at most 40 lines in a very high view", () => {
    mountThread({ lineCount: 60 });
    byId("viewport").getBoundingClientRect = () => rect(0, VIEWPORT_TOP, PANE_WIDTH, 4000);
    byId("footer").remove();
    enterAt("line-0", 3);

    moveCopyCursor("half-page-down");

    expect(modifyCalls).toHaveLength(40);
    expect(focusAt()).toBe("line-40:3");
  });

  it("uses a usual line height where the browser reports no rectangles", () => {
    enterAt("line-2", 6);
    Reflect.deleteProperty(Range.prototype, "getClientRects");

    moveCopyCursor("half-page-down");

    expect(modifyCalls).toHaveLength(8);
  });
});

describe("moveCopyCursor by a whole page", () => {
  it("page-down repeats the line move for the lines that fit in the view", () => {
    enterAt("line-2", 6);

    moveCopyCursor("page-down");

    expect(modifyCalls).toEqual(Array(16).fill("move forward line"));
    expect(focusAt()).toBe("line-18:6");
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("page-up repeats the line move upwards", () => {
    scrollTop = 200;
    enterAt("line-18", 3);

    moveCopyCursor("page-up");

    expect(modifyCalls).toEqual(Array(16).fill("move backward line"));
    expect(focusAt()).toBe("line-2:3");
  });

  it("moves twice as far as half a page", () => {
    mountThread({ lineCount: 60 });
    enterAt("line-0", 3);
    moveCopyCursor("half-page-down");
    const halfPage = modifyCalls.length;
    modifyCalls = [];

    moveCopyCursor("page-down");

    expect(halfPage).toBe(8);
    expect(modifyCalls).toHaveLength(2 * halfPage);
  });

  it("scrolls the conversation by the height of the view, so that the cursor stays at its height on screen", () => {
    mountThread({ lineCount: 60 });
    scrollTop = 400;
    enterAt("line-26", 3);
    const before = copyModeUi().cursor;

    moveCopyCursor("page-up");

    expect(scrollTimelineBy).toHaveBeenCalledExactlyOnceWith(-320, document);
    expect(scrollTop).toBe(80);
    expect(focusAt()).toBe("line-10:3");
    expect(copyModeUi().cursor).toEqual(blockAt(10, 3));
    expect(copyModeUi().cursor).toEqual(before);
    expect(copyModeUi().cursor?.top).toBe(240);
  });

  it("scrolls one page up from the last line that shows, as the prefix and PageUp do", () => {
    mountThread({ lineCount: 60 });
    scrollTop = 800;
    expect(enterCopyMode()).toBe(true);
    expect(focusAt()).toBe("line-53:0");

    moveCopyCursor("page-up");

    expect(scrollTimelineBy).toHaveBeenCalledExactlyOnceWith(-320, document);
    expect(scrollTop).toBe(480);
    expect(focusAt()).toBe("line-37:0");
    expect(copyModeUi().cursor?.top).toBe(380);
    expect(isCopyModeActive()).toBe(true);
  });

  it("scrolls on every press, also on the first one", () => {
    mountThread({ lineCount: 60 });
    scrollTop = 800;
    expect(enterCopyMode()).toBe(true);

    moveCopyCursor("page-up");
    moveCopyCursor("page-up");

    expect(scrollTop).toBe(160);
    expect(focusAt()).toBe("line-21:0");
    expect(vi.mocked(scrollTimelineBy).mock.calls.map(([delta]) => delta)).toEqual([
      -320, -320,
    ]);
  });

  it("moves only the cursor where the conversation cannot scroll any further up", () => {
    scrollTop = 50;
    enterAt("line-10", 2);

    moveCopyCursor("page-up");

    expect(scrollTop).toBe(0);
    expect(focusAt()).toBe("line-0:2");
    expect(copyModeUi().cursor).toEqual(blockAt(0, 2));
    expect(scrollTimelineBy).toHaveBeenCalledTimes(1);
  });

  it("moves only the cursor where the conversation cannot scroll any further down", () => {
    maxScrollTop = 100;
    scrollTop = 100;
    enterAt("line-10", 2);

    moveCopyCursor("page-down");

    expect(scrollTop).toBe(100);
    expect(focusAt()).toBe(`${LAST_LINE}:2`);
    expect(copyModeUi().cursor).toEqual(blockAt(19, 2));
  });

  // The cursor's own line is 20 pixels high and the lines are 30 pixels apart,
  // as the lines of a conversation are further apart than a character is
  // high. Sixteen lines would be more than the view was scrolled by.
  it("moves the cursor as far as the view was scrolled where the lines are further apart than its own height, so that it stays at its height on screen", () => {
    mountThread({ lineCount: 60 });
    Array.from(boxes.values())
      .filter((box) => !box.isFixed)
      .forEach((box, index) => {
        box.top = CONTENT_TOP + index * 30;
      });
    scrollTop = 900;
    enterAt("line-31", 4);
    expect(copyModeUi().cursor?.top).toBe(150);

    moveCopyCursor("page-up");

    expect(scrollTimelineBy).toHaveBeenCalledExactlyOnceWith(-320, document);
    expect(scrollTop).toBe(580);
    expect(modifyCalls).toHaveLength(11);
    expect(focusAt()).toBe("line-20:4");
    expect(copyModeUi().cursor?.top).toBe(140);
  });

  // The cursor's own line is a heading of 60 pixels, so the cursor moves five
  // lines at most. The lines below are 20 pixels apart, which takes it 140
  // pixels down while the view scrolls by 320.
  it("takes the cursor to the nearest line that shows when the lines it moves over are lower than its own, and does not scroll a second time", () => {
    mountThread({ lineCount: 60 });
    const heading = textOf("line-2");
    Array.from(boxes.values())
      .filter((box) => !box.isFixed)
      .slice(3)
      .forEach((box) => {
        box.top += 2 * LINE_HEIGHT;
      });
    define(Range.prototype, "getClientRects", function headingRects(this: Range): DOMRect[] {
      const rects = fakeClientRects.call(this);
      if (this.startContainer !== heading) return rects;
      return rects.map(({ left, top, width }) => rect(left, top, width, 3 * LINE_HEIGHT));
    });
    enterAt("line-2", 4);
    expect(copyModeUi().cursor).toMatchObject({ top: 160, height: 60 });

    moveCopyCursor("page-down");

    expect(modifyCalls.filter((call) => call === "move forward line")).toHaveLength(5);
    expect(scrollTimelineBy).toHaveBeenCalledExactlyOnceWith(320, document);
    expect(scrollTop).toBe(320);
    expect(focusAt()).toBe("line-14:0");
    expect(copyModeUi().cursor?.top).toBe(120);
  });

  it("does not scroll another pane's conversation, and still moves the cursor", () => {
    mountSplit("a");
    expect(enterCopyMode()).toBe(true);
    byId("a-viewport").closest("[data-split-pane-id]")?.setAttribute("data-focused", "false");
    byId("b-viewport").closest("[data-split-pane-id]")?.setAttribute("data-focused", "true");

    moveCopyCursor("page-up");

    expect(focusAt()).toBe("a-line-0:0");
    expect(scrollTimelineBy).not.toHaveBeenCalled();
  });

  it("extends the selection over the lines while selecting", () => {
    enterAt("line-2", 6);
    beginCopySelection();

    moveCopyCursor("page-down");

    expect(anchorAt()).toBe("line-2:6");
    expect(focusAt()).toBe("line-18:6");
  });

  it("stops at the last line of the conversation instead of going back", () => {
    enterAt("line-10", 2);

    moveCopyCursor("page-down");

    expect(focusAt()).toBe(`${LAST_LINE}:2`);
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("stops at the first line of the conversation", () => {
    enterAt("line-5", 6);

    moveCopyCursor("page-up");

    expect(focusAt()).toBe("line-0:6");
  });

  it("moves at least one line in a very low view", () => {
    byId("viewport").getBoundingClientRect = () => rect(0, VIEWPORT_TOP, PANE_WIDTH, 30);
    byId("footer").remove();
    enterAt("line-0", 3);

    moveCopyCursor("page-down");

    expect(modifyCalls).toEqual(["move forward line"]);
  });

  it("moves at most 80 lines in a very high view", () => {
    mountThread({ lineCount: 100 });
    byId("viewport").getBoundingClientRect = () => rect(0, VIEWPORT_TOP, PANE_WIDTH, 4000);
    byId("footer").remove();
    enterAt("line-0", 3);

    moveCopyCursor("page-down");

    expect(modifyCalls).toHaveLength(80);
    expect(focusAt()).toBe("line-80:3");
  });
});

describe("moveCopyCursor to the first character of a line that is not a blank", () => {
  function indentLine(text: string): void {
    textOf("line-2").data = text;
  }

  it("goes to the start of a line that starts with a character", () => {
    enterAt("line-2", 6);

    moveCopyCursor("line-indent");

    expect(modifyCalls).toEqual(["extend backward paragraphboundary"]);
    expect(focusAt()).toBe("line-2:0");
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("goes past the spaces that a line of a code block starts with", () => {
    indentLine("    return zeta;");
    enterAt("line-2", 9);

    moveCopyCursor("line-indent");

    expect(focusAt()).toBe("line-2:4");
    expect(getSelection().isCollapsed).toBe(true);
    expect(copyModeUi().cursor).toEqual(blockAt(2, 4));
  });

  it("goes there from inside the blanks as well", () => {
    indentLine("    return zeta;");
    enterAt("line-2", 2);

    moveCopyCursor("line-indent");

    expect(focusAt()).toBe("line-2:4");
  });

  it("counts tabs and no-break spaces as blanks", () => {
    indentLine(`\t${String.fromCharCode(0xa0)} zeta`);
    enterAt("line-2", 5);

    moveCopyCursor("line-indent");

    expect(focusAt()).toBe("line-2:3");
  });

  it("stops at the line break that ends a line of blanks", () => {
    indentLine("  \n  zeta");
    enterAt("line-2", 1);

    moveCopyCursor("line-indent");

    expect(focusAt()).toBe("line-2:2");
  });

  it("goes to the end of a line that has nothing but blanks", () => {
    indentLine("   ");
    enterAt("line-2", 1);

    moveCopyCursor("line-indent");

    expect(focusAt()).toBe("line-2:3");
  });

  it("differs from line-start, which goes to the very start", () => {
    indentLine("    return zeta;");
    enterAt("line-2", 9);

    moveCopyCursor("line-start");

    expect(focusAt()).toBe("line-2:0");
  });

  it("extends the selection to that character while selecting", () => {
    indentLine("    return zeta;");
    enterAt("line-2", 9);
    beginCopySelection();

    moveCopyCursor("line-indent");

    expect(anchorAt()).toBe("line-2:9");
    expect(focusAt()).toBe("line-2:4");
    expect(getSelection().toString()).toBe("retur");
  });
});

describe("moveCopyCursor at the edges of the conversation", () => {
  it("puts the cursor back when a move would enter the footer under the conversation", () => {
    scrollTop = 200;
    enterAt(LAST_LINE, 4);

    moveCopyCursor("line-down");

    expect(modifyCalls).toEqual(["move forward line"]);
    expect(anchorAt()).toBe(`${LAST_LINE}:4`);
    expect(focusAt()).toBe(`${LAST_LINE}:4`);
    expect(getSelection().isCollapsed).toBe(true);
    expect(copyModeUi().cursor).toEqual(blockAt(19, 4));
  });

  it("puts the cursor back when a move would enter the message box", () => {
    scrollTop = 200;
    byId("footer-note").remove();
    enterAt(LAST_LINE, 4);

    moveCopyCursor("line-down");

    expect(focusAt()).toBe(`${LAST_LINE}:4`);
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("puts the cursor back when a move would leave the conversation at the top", () => {
    enterAt("line-0", 4);

    moveCopyCursor("line-up");

    expect(focusAt()).toBe("line-0:4");
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("puts the cursor back when a character move would leave the conversation", () => {
    scrollTop = 200;
    enterAt(LAST_LINE, 11);

    moveCopyCursor("char-right");

    expect(focusAt()).toBe(`${LAST_LINE}:11`);
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("restores the selection when a move would take its end out of the conversation", () => {
    scrollTop = 200;
    enterAt("line-17", 2);
    beginCopySelection();
    moveCopyCursor("line-down");
    moveCopyCursor("line-down");
    expect(focusAt()).toBe(`${LAST_LINE}:2`);

    moveCopyCursor("line-down");

    expect(anchorAt()).toBe("line-17:2");
    expect(focusAt()).toBe(`${LAST_LINE}:2`);
    expect(selectedText()).toBe("w 17 text row 18 text ro");
    expect(copyModeUi().selecting).toBe(true);
  });

  it("does not enter bb's selection menu", () => {
    scrollTop = 200;
    byId("menu-layer").innerHTML = SELECTION_MENU_HTML;
    enterAt(LAST_LINE, 4);

    moveCopyCursor("line-down");

    expect(focusAt()).toBe(`${LAST_LINE}:4`);
  });

  it("does not throw and keeps its place when the browser fails to move", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    enterAt("line-2", 6);
    define(Selection.prototype, "modify", function failAfterMoving(this: Selection) {
      this.extend(textOf("line-5"), 2);
      throw new Error("modify failed");
    });

    expect(() => moveCopyCursor("char-right")).not.toThrow();

    expect(logged).toHaveBeenCalled();
    expect(isCopyModeActive()).toBe(true);
    expect(focusAt()).toBe("line-2:6");
    expect(getSelection().isCollapsed).toBe(true);
    define(Selection.prototype, "modify", fakeModify);
    moveCopyCursor("char-right");
    expect(focusAt()).toBe("line-2:7");
  });
});

describe("moveCopyCursor scrolling", () => {
  it("scrolls down by the part of the cursor that is below the view", () => {
    enterCopyMode();

    moveCopyCursor("line-down");

    expect(focusAt()).toBe("line-14:0");
    expect(scrollTimelineBy).toHaveBeenCalledExactlyOnceWith(16, document);
    expect(copyModeUi().cursor).toEqual({ left: 40, top: 384, width: 8, height: 20 });
  });

  it("scrolls up by the part of the cursor that is above the view", () => {
    scrollTop = 50;
    enterAt("line-3", 0);

    moveCopyCursor("line-up");

    expect(scrollTimelineBy).toHaveBeenCalledExactlyOnceWith(-6, document);
    expect(copyModeUi().cursor).toEqual({ left: 40, top: 116, width: 8, height: 20 });
  });

  it("does not scroll while the cursor stays in view", () => {
    enterAt("line-5", 0);

    moveCopyCursor("line-down");
    moveCopyCursor("line-up");

    expect(scrollTimelineBy).not.toHaveBeenCalled();
  });

  it("does not scroll another pane's conversation", () => {
    mountSplit("a");
    expect(enterCopyMode()).toBe(true);
    byId("a-viewport").closest("[data-split-pane-id]")?.setAttribute("data-focused", "false");
    byId("b-viewport").closest("[data-split-pane-id]")?.setAttribute("data-focused", "true");

    moveCopyCursor("line-down");

    expect(focusAt()).toBe("a-line-14:0");
    expect(scrollTimelineBy).not.toHaveBeenCalled();
  });
});

describe("scrollCopyView", () => {
  it("scrolls the conversation by the distance it is given and stays in copy mode", () => {
    enterAt("line-5", 2);

    scrollCopyView(40);

    expect(scrollTimelineBy).toHaveBeenCalledExactlyOnceWith(40, document);
    expect(scrollTop).toBe(40);
    expect(isCopyModeActive()).toBe(true);
  });

  it("scrolls up for a negative distance", () => {
    scrollTop = 100;
    enterAt("line-8", 2);

    scrollCopyView(-40);

    expect(scrollTimelineBy).toHaveBeenCalledExactlyOnceWith(-40, document);
    expect(scrollTop).toBe(60);
  });

  it("leaves a cursor that still shows where it is, and draws it at its new height", () => {
    enterAt("line-5", 2);

    scrollCopyView(40);

    expect(modifyCalls).toEqual([]);
    expect(focusAt()).toBe("line-5:2");
    expect(copyModeUi().cursor).toEqual(blockAt(5, 2));
    expect(copyModeUi().cursor?.top).toBe(180);
  });

  it("moves a cursor that left the view at the top to the first line that shows in full", () => {
    enterAt("line-0", 3);

    scrollCopyView(80);

    expect(focusAt()).toBe("line-4:0");
    expect(getSelection().isCollapsed).toBe(true);
    expect(copyModeUi().cursor).toEqual(blockAt(4, 0));
  });

  it("moves a cursor that left the view at the bottom to the last line above the message box", () => {
    scrollTop = 100;
    enterAt("line-18", 0);

    scrollCopyView(-60);

    expect(focusAt()).toBe("line-15:0");
    expect(copyModeUi().cursor).toEqual(blockAt(15, 0));
  });

  it("goes on from the line the cursor was moved to, without scrolling back", () => {
    enterAt("line-0", 3);
    scrollCopyView(80);
    vi.mocked(scrollTimelineBy).mockClear();

    moveCopyCursor("line-down");

    expect(focusAt()).toBe("line-5:0");
    expect(scrollTimelineBy).not.toHaveBeenCalled();
    expect(scrollTop).toBe(80);
  });

  it("keeps the anchor and takes the moving end of the selection along while selecting", () => {
    enterAt("line-0", 3);
    beginCopySelection();

    scrollCopyView(80);

    expect(copyModeUi().selecting).toBe(true);
    expect(anchorAt()).toBe("line-0:3");
    expect(focusAt()).toBe("line-4:0");
  });

  it("leaves the cursor where it is when no line shows after the scroll", () => {
    enterAt("line-0", 3);
    caretPositionFromPoint.mockReturnValue(null);

    scrollCopyView(80);

    expect(isCopyModeActive()).toBe(true);
    expect(copyModeUi().cursor).toBeNull();
    caretPositionFromPoint.mockImplementation(positionAt);
    moveCopyCursor("char-right");
    expect(focusAt()).toBe("line-0:4");
  });

  it("does nothing while copy mode is not active", () => {
    scrollCopyView(40);

    expect(scrollTimelineBy).not.toHaveBeenCalled();
    expect(getUiState().copyMode).toEqual({ active: false });
  });

  it("does not scroll another pane's conversation", () => {
    mountSplit("a");
    expect(enterCopyMode()).toBe(true);
    byId("a-viewport").closest("[data-split-pane-id]")?.setAttribute("data-focused", "false");
    byId("b-viewport").closest("[data-split-pane-id]")?.setAttribute("data-focused", "true");

    scrollCopyView(40);

    expect(scrollTimelineBy).not.toHaveBeenCalled();
    expect(focusAt()).toBe(`a-${LAST_VISIBLE_LINE}:0`);
  });

  it("leaves copy mode, without scrolling, when bb shows another thread in the pane", () => {
    enterAt("line-5", 2);
    const viewport = byId("viewport");
    const replacement = viewport.cloneNode(true);
    viewport.replaceWith(replacement);

    scrollCopyView(40);

    expect(isCopyModeActive()).toBe(false);
    expect(scrollTimelineBy).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });
});

describe("the copy cursor rectangle", () => {
  it("covers the first character of the next piece of text on the same line", () => {
    mountThread({
      extraRowsHtml: `
        <div data-timeline-row-id="row-rich"><p id="rich">plain <b id="bold">bold</b></p></div>`,
    });
    const top = CONTENT_TOP + 2 * LINE_HEIGHT;
    boxes.set(textOf("rich"), { top, left: 300, columnLeft: 0, isFixed: false });
    boxes.set(textOf("bold"), { top, left: 300 + 6 * CHAR_WIDTH, columnLeft: 0, isFixed: false });

    enterAt("rich", 6);

    expect(copyModeUi().cursor).toEqual({
      left: 300 + 6 * CHAR_WIDTH,
      top,
      width: CHAR_WIDTH,
      height: LINE_HEIGHT,
    });
  });

  it("is narrow at the end of a line when the next piece of text is on the next line", () => {
    mountThread({
      extraRowsHtml: `
        <div data-timeline-row-id="row-stacked"><p id="stacked">first<br><b id="stacked-next">second</b></p></div>`,
    });
    const top = CONTENT_TOP + 2 * LINE_HEIGHT;
    boxes.set(textOf("stacked"), { top, left: 300, columnLeft: 0, isFixed: false });
    boxes.set(textOf("stacked-next"), {
      top: top + LINE_HEIGHT,
      left: 300,
      columnLeft: 0,
      isFixed: false,
    });

    enterAt("stacked", 5);

    expect(copyModeUi().cursor).toEqual({
      left: 300 + 5 * CHAR_WIDTH,
      top,
      width: CARET_WIDTH,
      height: LINE_HEIGHT,
    });
  });

  it("is narrow at the end of the last text of the conversation", () => {
    scrollTop = 200;
    enterAt(LAST_LINE, 11);

    expect(copyModeUi().cursor).toEqual(caretAt(19, 11));
  });

  it("covers both halves of a character that takes two code units", () => {
    textOf("line-2").data = "ab\u{1F600}cd";
    enterAt("line-2", 2);

    expect(copyModeUi().cursor).toEqual({ ...blockAt(2, 2), width: 2 * CHAR_WIDTH });
  });

  it.each(CLUSTERS)("covers the whole of %s, which is several code points", (_name, character) => {
    textOf("line-2").data = `ab${character}cd`;
    enterAt("line-2", 2);

    expect(copyModeUi().cursor).toEqual({
      ...blockAt(2, 2),
      width: character.length * CHAR_WIDTH,
    });
  });

  it("is null where the browser reports no rectangles", () => {
    Reflect.deleteProperty(Range.prototype, "getClientRects");

    enterAt("line-2", 6);

    expect(copyModeUi()).toEqual({ active: true, selecting: false, cursor: null });
  });

  it("is null while the cursor is scrolled out of view", () => {
    enterAt("line-2", 6);

    scrollTop = 300;
    refreshCopyCursor();

    expect(copyModeUi().cursor).toBeNull();
  });

  it("is not hidden by a footer that takes no room", () => {
    byId("footer").getBoundingClientRect = () => rect(0, 0, 0, 0);

    enterAt("line-2", 6);

    expect(copyModeUi().cursor).toEqual(blockAt(2, 6));
  });

  it("is null while the cursor is under the message box", () => {
    enterAt("line-12", 6);

    scrollTop = -80;
    refreshCopyCursor();

    expect(copyModeUi().cursor).toBeNull();
  });
});

describe("clearCopySelection", () => {
  it("drops the selection, keeps the cursor and stays in copy mode", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("line-down");

    clearCopySelection();

    expect(isCopyModeActive()).toBe(true);
    expect(copyModeUi()).toEqual({ active: true, selecting: false, cursor: blockAt(3, 6) });
    expect(getSelection().isCollapsed).toBe(true);
    expect(focusAt()).toBe("line-3:6");
  });

  it("forgets the old anchor", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("line-down");
    clearCopySelection();

    moveCopyCursor("char-right");
    expect(getSelection().isCollapsed).toBe(true);

    beginCopySelection();
    moveCopyCursor("char-right");
    expect(anchorAt()).toBe("line-3:7");
    expect(focusAt()).toBe("line-3:8");
  });

  it("changes nothing while nothing is being selected", () => {
    enterAt("line-2", 6);

    clearCopySelection();

    expect(copyModeUi()).toEqual({ active: true, selecting: false, cursor: blockAt(2, 6) });
  });

  it("does nothing while copy mode is not active", () => {
    const listener = vi.fn();
    subscribeUiState(listener);

    clearCopySelection();

    expect(listener).not.toHaveBeenCalled();
    expect(getUiState().copyMode).toEqual({ active: false });
  });
});

describe("beginCopySelection", () => {
  it("starts selecting at the cursor without selecting anything yet", () => {
    enterAt("line-2", 6);

    beginCopySelection();

    expect(copyModeUi()).toEqual({ active: true, selecting: true, cursor: blockAt(2, 6) });
    expect(getSelection().isCollapsed).toBe(true);
    expect(focusAt()).toBe("line-2:6");
  });

  it("selects from there as the cursor moves", () => {
    enterAt("line-2", 5);
    beginCopySelection();

    moveCopyCursor("word-end");

    expect(anchorAt()).toBe("line-2:5");
    expect(focusAt()).toBe("line-2:8");
    expect(getSelection().toString()).toBe("eta");
  });

  it("starts a new selection where the cursor is now when pressed again, and keeps selecting", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("line-down");

    beginCopySelection();

    expect(isCopyModeActive()).toBe(true);
    expect(copyModeUi()).toEqual({ active: true, selecting: true, cursor: blockAt(3, 6) });
    expect(getSelection().isCollapsed).toBe(true);
    moveCopyCursor("char-right");
    expect(anchorAt()).toBe("line-3:6");
    expect(focusAt()).toBe("line-3:7");
  });

  it("does nothing while copy mode is not active", () => {
    const listener = vi.fn();
    subscribeUiState(listener);

    beginCopySelection();

    expect(listener).not.toHaveBeenCalled();
    expect(getUiState().copyMode).toEqual({ active: false });
  });
});

describe("yankCopySelection", () => {
  it("just leaves copy mode, as tmux does, when it is to copy and leave and nothing is being selected", async () => {
    enterAt("line-2", 6);

    await expect(yankCopySelection("exit")).resolves.toBe("empty");

    expect(copySelection).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
    expect(isCopyModeActive()).toBe(false);
  });

  it.each(["clear", "keep"] as const)(
    "says that nothing is selected and stays when it is to copy and %s the selection, and nothing is being selected",
    async (after) => {
      enterAt("line-2", 6);

      await expect(yankCopySelection(after)).resolves.toBe("empty");

      expect(copySelection).not.toHaveBeenCalled();
      expect(noticeText()).toBe(NOTHING_SELECTED_NOTICE);
      expect(isCopyModeActive()).toBe(true);
    },
  );

  it("just leaves copy mode when selecting has started but nothing is selected", async () => {
    vi.mocked(copySelection).mockResolvedValue("empty");
    enterAt("line-2", 6);
    beginCopySelection();

    await expect(yankCopySelection("exit")).resolves.toBe("empty");

    expect(copySelection).toHaveBeenCalledTimes(1);
    expect(noticeText()).toBeNull();
    expect(isCopyModeActive()).toBe(false);
  });

  it("says that nothing is selected, and goes on selecting, when it is to stay and nothing is selected", async () => {
    vi.mocked(copySelection).mockResolvedValue("empty");
    enterAt("line-2", 6);
    beginCopySelection();

    await expect(yankCopySelection("clear")).resolves.toBe("empty");

    expect(noticeText()).toBe(NOTHING_SELECTED_NOTICE);
    expect(isCopyModeActive()).toBe(true);
    expect(copyModeUi().selecting).toBe(true);
  });

  it("names no key in what it says, because the keys are those of the tmux config", () => {
    expect(NOTHING_SELECTED_NOTICE).not.toMatch(/\b(v|y|Space|Enter)\b/);
  });

  it("copies the selection, drops it and stays in copy mode for tmux's copy-selection", async () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("word-end");

    await expect(yankCopySelection("clear")).resolves.toBe("copied");

    expect(noticeText()).toBe("Selection copied");
    expect(isCopyModeActive()).toBe(true);
    expect(copyModeUi()).toEqual({ active: true, selecting: false, cursor: blockAt(2, 8) });
    expect(getSelection().isCollapsed).toBe(true);
    expect(focusAt()).toBe("line-2:8");
  });

  it("copies the selection and keeps it for tmux's copy-selection-no-clear", async () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("word-end");

    await expect(yankCopySelection("keep")).resolves.toBe("copied");

    expect(noticeText()).toBe("Selection copied");
    expect(isCopyModeActive()).toBe(true);
    expect(copyModeUi().selecting).toBe(true);
    expect(getSelection().toString()).toBe("ta");
  });

  it("copies the selection, says so and leaves copy mode", async () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("word-end");
    let selectedWhenCopied = "";
    vi.mocked(copySelection).mockImplementation(async () => {
      selectedWhenCopied = getSelection().toString();
      return "copied";
    });

    await expect(yankCopySelection("exit")).resolves.toBe("copied");

    expect(selectedWhenCopied).toBe("ta");
    expect(copySelection).toHaveBeenCalledExactlyOnceWith(document);
    expect(noticeText()).toBe("Selection copied");
    expect(isCopyModeActive()).toBe(false);
    expect(getUiState().copyMode).toEqual({ active: false });
    expect(getSelection().rangeCount).toBe(0);
  });

  it("starts the copy before it returns, while the key press still counts", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("word-end");

    void yankCopySelection("exit");

    expect(copySelection).toHaveBeenCalledTimes(1);
  });

  it("copies its own selection when something else changed the selection", async () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("word-end");
    getSelection().removeAllRanges();
    let selectedWhenCopied = "";
    vi.mocked(copySelection).mockImplementation(async () => {
      selectedWhenCopied = getSelection().toString();
      return "copied";
    });

    await yankCopySelection("exit");

    expect(selectedWhenCopied).toBe("ta");
  });

  it("says when the copy failed and stays in copy mode with the selection", async () => {
    vi.mocked(copySelection).mockResolvedValue("failed");
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("word-end");

    await expect(yankCopySelection("exit")).resolves.toBe("failed");

    expect(noticeText()).toBe("Could not copy the selection");
    expect(isCopyModeActive()).toBe(true);
    expect(getSelection().toString()).toBe("ta");
  });

  it("is failed, not rejected, when copying throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(copySelection).mockRejectedValue(new Error("copy broke"));
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("word-end");

    await expect(yankCopySelection("exit")).resolves.toBe("failed");

    expect(logged).toHaveBeenCalled();
  });

  it("is empty and silent while copy mode is not active", async () => {
    await expect(yankCopySelection("exit")).resolves.toBe("empty");

    expect(copySelection).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });
});

describe("exitCopyMode", () => {
  it("clears the selection and publishes that copy mode is over", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("line-down");

    exitCopyMode();

    expect(isCopyModeActive()).toBe(false);
    expect(getSelection().rangeCount).toBe(0);
    expect(getUiState().copyMode).toEqual({ active: false });
  });

  it("clears what is left of the selection after bb unloaded one end of it", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("line-down");
    removeRow("line-3");
    expect(getSelection().isCollapsed).toBe(false);

    exitCopyMode();

    expect(getSelection().rangeCount).toBe(0);
  });

  it("leaves a selection alone that has moved out of the conversation since", () => {
    enterAt("line-2", 6);
    const draft = textOf("draft");
    getSelection().collapse(draft, 5);

    exitCopyMode();

    expect(isCopyModeActive()).toBe(false);
    expect(getSelection().rangeCount).toBe(1);
    expect(focusAt()).toBe("draft:5");
  });

  it("leaves the user's selection alone while copy mode is not active", () => {
    const text = textOf("line-2");
    getSelection().setBaseAndExtent(text, 0, text, 4);
    const listener = vi.fn();
    subscribeUiState(listener);

    exitCopyMode();
    exitCopyMode();

    expect(getSelection().toString()).toBe("zeta");
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops following scrolling and resizing", () => {
    enterAt("line-2", 6);
    exitCopyMode();

    byId("viewport").dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));

    expect(frames.size).toBe(0);
  });

  it("cancels an update that was waiting for the next frame", () => {
    enterAt("line-2", 6);
    byId("viewport").dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);

    exitCopyMode();

    expect(frames.size).toBe(0);
  });

  it("can be entered again afterwards", () => {
    enterAt("line-2", 6);
    exitCopyMode();

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
    expect(copyModeUi().selecting).toBe(false);
  });
});

describe("exitCopyModeKeepingSelection", () => {
  it("leaves copy mode and keeps what was selected, for bb's selection menu to use", () => {
    enterAt("line-2", 5);
    beginCopySelection();
    moveCopyCursor("line-end");

    exitCopyModeKeepingSelection();

    expect(isCopyModeActive()).toBe(false);
    expect(getUiState().copyMode).toEqual({ active: false });
    expect(getSelection().toString()).toBe("eta theta");
  });

  it("stops following scrolling and resizing", () => {
    enterAt("line-2", 6);
    byId("viewport").dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);

    exitCopyModeKeepingSelection();
    byId("viewport").dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));

    expect(frames.size).toBe(0);
  });

  it("changes and publishes nothing while copy mode is not active", () => {
    const text = textOf("line-2");
    getSelection().setBaseAndExtent(text, 0, text, 4);
    const listener = vi.fn();
    subscribeUiState(listener);

    exitCopyModeKeepingSelection();

    expect(getSelection().toString()).toBe("zeta");
    expect(listener).not.toHaveBeenCalled();
  });

  it("can be entered again afterwards, starting from the kept selection", () => {
    enterAt("line-2", 5);
    beginCopySelection();
    moveCopyCursor("line-end");
    exitCopyModeKeepingSelection();

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe("line-2:14");
    expect(copyModeUi().selecting).toBe(false);
  });
});

describe("refreshCopyCursor", () => {
  it("publishes the rectangle again after the text has moved", () => {
    enterAt("line-2", 6);
    expect(copyModeUi().cursor).toEqual(blockAt(2, 6));

    scrollTop = 30;
    refreshCopyCursor();

    expect(copyModeUi().cursor).toEqual({ left: 88, top: 130, width: 8, height: 20 });
  });

  it("publishes nothing when the rectangle is unchanged", () => {
    enterAt("line-2", 6);
    const listener = vi.fn();
    subscribeUiState(listener);

    refreshCopyCursor();

    expect(listener).not.toHaveBeenCalled();
  });

  it("does nothing while copy mode is not active", () => {
    const listener = vi.fn();
    subscribeUiState(listener);

    refreshCopyCursor();

    expect(listener).not.toHaveBeenCalled();
  });

  it("follows scrolling anywhere in the document, once per frame", () => {
    enterAt("line-2", 6);
    const listener = vi.fn();
    subscribeUiState(listener);

    scrollTop = 30;
    byId("viewport").dispatchEvent(new Event("scroll"));
    byId("viewport").dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("scroll"));

    expect(frames.size).toBe(1);
    expect(listener).not.toHaveBeenCalled();
    runFrame();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(copyModeUi().cursor).toEqual({ left: 88, top: 130, width: 8, height: 20 });
  });

  it("follows the window being resized", () => {
    enterAt("line-2", 6);

    scrollTop = 30;
    window.dispatchEvent(new Event("resize"));
    runFrame();

    expect(copyModeUi().cursor).toEqual({ left: 88, top: 130, width: 8, height: 20 });
  });

  it("waits for a new frame after each update", () => {
    enterAt("line-2", 6);

    byId("viewport").dispatchEvent(new Event("scroll"));
    runFrame();
    byId("viewport").dispatchEvent(new Event("scroll"));

    expect(frames.size).toBe(1);
  });
});

describe("the cursor block when the conversation moves without a scroll, as when bb's sidebar opens", () => {
  let observed: Element[];
  let disconnects: number;
  let conversationResized: () => void;

  beforeEach(() => {
    observed = [];
    disconnects = 0;
    conversationResized = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          conversationResized = callback;
        }
        observe(element: Element): void {
          observed.push(element);
        }
        disconnect(): void {
          disconnects += 1;
        }
      },
    );
  });

  it("follows the conversation when its scroller changes size, once per frame", () => {
    enterAt("line-2", 6);
    expect(observed).toEqual([byId("viewport")]);

    scrollTop = 30;
    conversationResized();
    conversationResized();

    expect(frames.size).toBe(1);
    runFrame();
    expect(copyModeUi().cursor).toEqual({ left: 88, top: 130, width: 8, height: 20 });
  });

  it("stops watching the scroller when copy mode ends", () => {
    enterAt("line-2", 6);

    exitCopyMode();

    expect(disconnects).toBe(1);
  });

  it("does without it in a browser that has no ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);

    enterAt("line-2", 6);

    expect(isCopyModeActive()).toBe(true);
    expect(observed).toEqual([]);
  });
});

describe("copy mode when bb unloads part of the conversation", () => {
  it("leaves copy mode and says so when the cursor's text is gone on a move", () => {
    enterAt("line-2", 6);
    removeRow("line-2");

    moveCopyCursor("char-right");

    expect(isCopyModeActive()).toBe(false);
    expect(getUiState().copyMode).toEqual({ active: false });
    expect(noticeText()).toBe(LOST_NOTICE);
    expect(modifyCalls).toEqual([]);
  });

  it("leaves copy mode when the anchor's text is gone while selecting", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("half-page-down");
    removeRow("line-2");

    moveCopyCursor("line-down");

    expect(isCopyModeActive()).toBe(false);
    expect(noticeText()).toBe(LOST_NOTICE);
    expect(getSelection().rangeCount).toBe(0);
  });

  it("ignores the text where selecting once started after the selection was dropped", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("half-page-down");
    clearCopySelection();
    removeRow("line-2");

    moveCopyCursor("line-down");

    expect(isCopyModeActive()).toBe(true);
    expect(focusAt()).toBe("line-11:6");
  });

  it("notices the loss when the cursor rectangle is refreshed", () => {
    enterAt("line-2", 6);
    removeRow("line-2");

    byId("viewport").dispatchEvent(new Event("scroll"));
    runFrame();

    expect(isCopyModeActive()).toBe(false);
    expect(noticeText()).toBe(LOST_NOTICE);
  });

  it("notices the loss when selecting is started", () => {
    enterAt("line-2", 6);
    removeRow("line-2");

    beginCopySelection();

    expect(isCopyModeActive()).toBe(false);
    expect(noticeText()).toBe(LOST_NOTICE);
  });

  it("copies nothing when the selection is lost", async () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("line-down");
    removeRow("line-3");

    await expect(yankCopySelection("exit")).resolves.toBe("empty");

    expect(copySelection).not.toHaveBeenCalled();
    expect(noticeText()).toBe(LOST_NOTICE);
    expect(isCopyModeActive()).toBe(false);
  });

  it("starts afresh, without a notice, when entered after a loss", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    removeRow("line-2");

    expect(enterCopyMode()).toBe(true);

    expect(noticeText()).toBeNull();
    expect(copyModeUi().selecting).toBe(false);
    expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
  });

  it("keeps the cursor inside text that bb made shorter", () => {
    enterAt("line-2", 12);
    textOf("line-2").data = "zeta";

    moveCopyCursor("char-left");

    expect(isCopyModeActive()).toBe(true);
    expect(focusAt()).toBe("line-2:3");
  });
});

// bb mounts a new scroller when the pane shows another thread (PageShell is
// keyed by the thread id in ThreadScreen.tsx), for example on bb's own
// shortcut for the next thread, which copy mode passes on.
describe("copy mode when bb shows another thread in the pane", () => {
  it("knows that its conversation is gone", () => {
    expect(hasCopyModeLostConversation()).toBe(false);
    enterAt("line-2", 6);
    expect(hasCopyModeLostConversation()).toBe(false);

    mountThread();

    expect(hasCopyModeLostConversation()).toBe(true);
    exitCopyMode();
    expect(hasCopyModeLostConversation()).toBe(false);
  });

  it("does not take the loss of one message for the loss of the conversation", () => {
    enterAt("line-2", 6);
    removeRow("line-2");

    expect(hasCopyModeLostConversation()).toBe(false);
  });

  it("leaves copy mode on a move, without a notice about a lost selection", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("line-down");
    mountThread();
    modifyCalls = [];

    moveCopyCursor("char-right");

    expect(isCopyModeActive()).toBe(false);
    expect(getUiState().copyMode).toEqual({ active: false });
    expect(noticeText()).toBeNull();
    expect(modifyCalls).toEqual([]);
  });

  it("leaves copy mode when the new thread scrolls, without a notice", () => {
    enterAt("line-2", 6);
    mountThread();

    byId("viewport").dispatchEvent(new Event("scroll"));
    runFrame();

    expect(isCopyModeActive()).toBe(false);
    expect(noticeText()).toBeNull();
  });

  it("leaves copy mode when selecting is started, without a notice", () => {
    enterAt("line-2", 6);
    mountThread();

    beginCopySelection();

    expect(isCopyModeActive()).toBe(false);
    expect(noticeText()).toBeNull();
  });

  it("copies nothing and says nothing", async () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("line-down");
    mountThread();

    await expect(yankCopySelection("exit")).resolves.toBe("empty");

    expect(copySelection).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
    expect(isCopyModeActive()).toBe(false);
  });

  it("leaves a selection in the new thread alone", () => {
    enterAt("line-2", 6);
    mountThread();
    const text = textOf("line-4");
    getSelection().setBaseAndExtent(text, 0, text, 4);

    refreshCopyCursor();

    expect(isCopyModeActive()).toBe(false);
    expect(getSelection().toString()).toBe("row ");
  });

  it("starts afresh in the new thread when entered again", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    mountThread();

    expect(enterCopyMode()).toBe(true);

    expect(noticeText()).toBeNull();
    expect(hasCopyModeLostConversation()).toBe(false);
    expect(copyModeUi().selecting).toBe(false);
    expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
  });
});

// A browser also reports places between elements, not only inside text: a
// triple click ends its selection at the start of the next block, and the
// place in front of a picture has no text of its own.
describe("copy mode at a place between elements", () => {
  const PICTURE_TOP = CONTENT_TOP + 2 * LINE_HEIGHT;
  const PICTURE_ROW_HTML = `
    <div data-timeline-row-id="row-picture"><div id="media"><img id="picture" alt=""></div></div>`;

  function mountThreadWithPicture(): void {
    mountThread({ extraRowsHtml: PICTURE_ROW_HTML });
    byId("picture").getBoundingClientRect = () => rect(300, PICTURE_TOP, 120, 60);
  }

  function enterAtElement(id: string, offset: number): void {
    getSelection().setBaseAndExtent(textOf("line-2"), 0, byId(id), offset);
    expect(enterCopyMode()).toBe(true);
    modifyCalls = [];
  }

  function focusElementAt(): string {
    const { focusNode, focusOffset } = getSelection();
    return `${(focusNode as Element).id}:${focusOffset}`;
  }

  it("starts at the end of a triple click, in front of the next paragraph", () => {
    enterAtElement("line-3", 0);

    expect(getSelection().focusNode).toBe(byId("line-3"));
    expect(focusElementAt()).toBe("line-3:0");
    expect(getSelection().isCollapsed).toBe(true);
    expect(copyModeUi()).toEqual({ active: true, selecting: false, cursor: blockAt(3, 0) });
  });

  it("moves on from there as from the start of that paragraph", () => {
    enterAtElement("line-3", 0);

    moveCopyCursor("char-right");
    expect(focusAt()).toBe("line-3:1");
    expect(copyModeUi().cursor).toEqual(blockAt(3, 1));

    moveCopyCursor("line-down");
    expect(focusAt()).toBe("line-4:1");
  });

  it("selects from there, so that the selection starts with the paragraph", () => {
    enterAtElement("line-3", 0);
    beginCopySelection();

    moveCopyCursor("word-end");

    expect(getSelection().anchorNode).toBe(byId("line-3"));
    expect(focusAt()).toBe("line-3:3");
    expect(selectedText()).toBe("row");
  });

  it("draws a narrow cursor as high as the picture it stands in front of", () => {
    mountThreadWithPicture();

    enterAtElement("media", 0);

    expect(focusElementAt()).toBe("media:0");
    expect(copyModeUi().cursor).toEqual({
      left: 300,
      top: PICTURE_TOP,
      width: CARET_WIDTH,
      height: 60,
    });
  });

  it("draws nothing in front of an element that takes no room", () => {
    mountThreadWithPicture();
    byId("picture").getBoundingClientRect = () => rect(0, 0, 0, 0);

    enterAtElement("media", 0);

    expect(copyModeUi()).toEqual({ active: true, selecting: false, cursor: null });
  });

  it("draws nothing at the end of an element, where no text follows inside it", () => {
    mountThreadWithPicture();

    enterAtElement("media", 1);

    expect(focusElementAt()).toBe("media:1");
    expect(copyModeUi().cursor).toBeNull();
  });

  it("keeps the cursor inside an element that bb emptied", () => {
    mountThreadWithPicture();
    enterAtElement("media", 1);
    byId("picture").remove();

    refreshCopyCursor();
    moveCopyCursor("char-right");

    expect(isCopyModeActive()).toBe(true);
    expect(noticeText()).toBeNull();
    expect(focusAt()).toBe("line-0:1");
  });

  it("leaves copy mode and says so when the element under the cursor is gone", () => {
    mountThreadWithPicture();
    enterAtElement("media", 0);
    byId("media").remove();

    moveCopyCursor("char-right");

    expect(isCopyModeActive()).toBe(false);
    expect(noticeText()).toBe(LOST_NOTICE);
  });
});

// tmux's emacs keys end a selection in front of the character under the
// cursor block. Its vi keys take that character in, and the one the selection
// was started on, whichever of the two comes first (window_copy_get_selection
// in window-copy.c of tmux 3.5a: "lastex = ex + 1").
const SELECTION_CASES: SelectionCase[] = [
  {
    name: "three characters to the right, from the z of zeta to its a",
    start: ["line-2", 0],
    moves: ["char-right", "char-right", "char-right"],
    vi: { anchor: "line-2:0", focus: "line-2:4", text: "zeta", cursor: [2, 3, "character"] },
    emacs: { anchor: "line-2:0", focus: "line-2:3", text: "zet", cursor: [2, 3, "character"] },
  },
  {
    name: "three characters to the left, from the a of zeta to its z",
    start: ["line-2", 3],
    moves: ["char-left", "char-left", "char-left"],
    vi: { anchor: "line-2:4", focus: "line-2:0", text: "zeta", cursor: [2, 0, "character"] },
    emacs: { anchor: "line-2:3", focus: "line-2:0", text: "zet", cursor: [2, 0, "character"] },
  },
  {
    name: "one character to the left of where it was started",
    start: ["line-2", 5],
    moves: ["char-left"],
    vi: { anchor: "line-2:6", focus: "line-2:4", text: " e", cursor: [2, 4, "character"] },
    emacs: { anchor: "line-2:5", focus: "line-2:4", text: " ", cursor: [2, 4, "character"] },
  },
  {
    name: "to the left of where it was started and back to the right of it",
    start: ["line-2", 5],
    moves: ["char-left", "char-right", "char-right"],
    vi: { anchor: "line-2:5", focus: "line-2:7", text: "et", cursor: [2, 6, "character"] },
    emacs: { anchor: "line-2:5", focus: "line-2:6", text: "e", cursor: [2, 6, "character"] },
  },
  {
    name: "to the next word (w)",
    start: ["line-2", 0],
    moves: ["word-forward"],
    vi: { anchor: "line-2:0", focus: "line-2:6", text: "zeta e", cursor: [2, 5, "character"] },
    emacs: { anchor: "line-2:0", focus: "line-2:5", text: "zeta ", cursor: [2, 5, "character"] },
  },
  {
    name: "to the previous word (b)",
    start: ["line-2", 9],
    moves: ["word-back"],
    vi: { anchor: "line-2:10", focus: "line-2:5", text: "eta t", cursor: [2, 5, "character"] },
    emacs: { anchor: "line-2:9", focus: "line-2:5", text: "eta ", cursor: [2, 5, "character"] },
  },
  {
    name: "to the end of the word (e)",
    start: ["line-2", 0],
    moves: ["word-end"],
    vi: { anchor: "line-2:0", focus: "line-2:4", text: "zeta", cursor: [2, 3, "character"] },
    emacs: { anchor: "line-2:0", focus: "line-2:4", text: "zeta", cursor: [2, 4, "character"] },
  },
  {
    name: "to the end of the word after that (e twice)",
    start: ["line-2", 0],
    moves: ["word-end", "word-end"],
    vi: { anchor: "line-2:0", focus: "line-2:8", text: "zeta eta", cursor: [2, 7, "character"] },
    emacs: { anchor: "line-2:0", focus: "line-2:8", text: "zeta eta", cursor: [2, 8, "character"] },
  },
  {
    name: "to the end of the line",
    start: ["line-2", 6],
    moves: ["line-end"],
    vi: { anchor: "line-2:6", focus: "line-2:14", text: "ta theta", cursor: [2, 14, "line end"] },
    emacs: { anchor: "line-2:6", focus: "line-2:14", text: "ta theta", cursor: [2, 14, "line end"] },
  },
  {
    name: "to the start of the line",
    start: ["line-2", 6],
    moves: ["line-start"],
    vi: { anchor: "line-2:7", focus: "line-2:0", text: "zeta et", cursor: [2, 0, "character"] },
    emacs: { anchor: "line-2:6", focus: "line-2:0", text: "zeta e", cursor: [2, 0, "character"] },
  },
  {
    name: "one line down, over the end of a line",
    start: ["line-2", 6],
    moves: ["line-down"],
    vi: { anchor: "line-2:6", focus: "line-3:7", text: "ta theta row 3 t", cursor: [3, 6, "character"] },
    emacs: { anchor: "line-2:6", focus: "line-3:6", text: "ta theta row 3 ", cursor: [3, 6, "character"] },
  },
  {
    name: "one line up",
    start: ["line-2", 6],
    moves: ["line-up"],
    vi: { anchor: "line-2:7", focus: "line-1:6", text: "epsilon zeta et", cursor: [1, 6, "character"] },
    emacs: { anchor: "line-2:6", focus: "line-1:6", text: "epsilon zeta e", cursor: [1, 6, "character"] },
  },
  {
    name: "two lines down and then to the end of a word",
    start: ["line-2", 6],
    moves: ["line-down", "line-down", "word-end"],
    vi: { anchor: "line-2:6", focus: "line-4:10", text: "ta theta row 3 text row 4 text", cursor: [4, 9, "character"] },
    emacs: { anchor: "line-2:6", focus: "line-4:10", text: "ta theta row 3 text row 4 text", cursor: [4, 10, "line end"] },
  },
  {
    name: "to the next paragraph",
    start: ["line-2", 6],
    moves: ["paragraph-forward"],
    vi: { anchor: "line-2:6", focus: "line-3:1", text: "ta theta r", cursor: [3, 0, "character"] },
    emacs: { anchor: "line-2:6", focus: "line-3:0", text: "ta theta ", cursor: [3, 0, "character"] },
  },
  {
    name: "to the previous paragraph",
    start: ["line-2", 6],
    moves: ["paragraph-back"],
    vi: { anchor: "line-2:7", focus: "line-1:0", text: "delta epsilon zeta et", cursor: [1, 0, "character"] },
    emacs: { anchor: "line-2:6", focus: "line-1:0", text: "delta epsilon zeta e", cursor: [1, 0, "character"] },
  },
  {
    name: "to the first text of the conversation",
    start: ["line-2", 6],
    moves: ["document-start"],
    vi: {
      anchor: "line-2:7",
      focus: "line-0:0",
      text: "alpha beta gamma delta epsilon zeta et",
      cursor: [0, 0, "character"],
    },
    emacs: {
      anchor: "line-2:6",
      focus: "line-0:0",
      text: "alpha beta gamma delta epsilon zeta e",
      cursor: [0, 0, "character"],
    },
  },
  {
    name: "to the last text of the conversation",
    start: ["line-18", 0],
    scrolledBy: 200,
    moves: ["document-end"],
    vi: { anchor: "line-18:0", focus: "line-19:11", text: "row 18 text row 19 text", cursor: [19, 11, "line end"] },
    emacs: { anchor: "line-18:0", focus: "line-19:11", text: "row 18 text row 19 text", cursor: [19, 11, "line end"] },
  },
  {
    name: "to the top line that shows",
    start: ["line-5", 4],
    scrolledBy: 50,
    moves: ["screen-top"],
    vi: { anchor: "line-5:5", focus: "line-3:0", text: "row 3 text row 4 text row 5", cursor: [3, 0, "character"] },
    emacs: { anchor: "line-5:4", focus: "line-3:0", text: "row 3 text row 4 text row ", cursor: [3, 0, "character"] },
  },
  {
    name: "to the bottom line that shows",
    start: ["line-13", 4],
    scrolledBy: 50,
    moves: ["screen-bottom"],
    vi: { anchor: "line-13:4", focus: "line-15:1", text: "13 text row 14 text r", cursor: [15, 0, "character"] },
    emacs: { anchor: "line-13:4", focus: "line-15:0", text: "13 text row 14 text ", cursor: [15, 0, "character"] },
  },
  {
    name: "half a page down",
    start: ["line-2", 7],
    moves: ["half-page-down"],
    vi: {
      anchor: "line-2:7",
      focus: "line-10:8",
      text: "a theta row 3 text row 4 text row 5 text row 6 text row 7 text row 8 text row 9 text row 10 t",
      cursor: [10, 7, "character"],
    },
    emacs: {
      anchor: "line-2:7",
      focus: "line-10:7",
      text: "a theta row 3 text row 4 text row 5 text row 6 text row 7 text row 8 text row 9 text row 10 ",
      cursor: [10, 7, "character"],
    },
  },
  {
    name: "a page up, as far as the first line",
    start: ["line-12", 4],
    scrolledBy: 200,
    moves: ["page-up"],
    vi: {
      anchor: "line-12:5",
      focus: "line-0:4",
      text: "a beta gamma delta epsilon zeta eta theta row 3 text row 4 text row 5 text row 6 text row 7 text row 8 text row 9 text row 10 text row 11 text row 1",
      cursor: [0, 4, "character"],
    },
    emacs: {
      anchor: "line-12:4",
      focus: "line-0:4",
      text: "a beta gamma delta epsilon zeta eta theta row 3 text row 4 text row 5 text row 6 text row 7 text row 8 text row 9 text row 10 text row 11 text row ",
      cursor: [0, 4, "character"],
    },
  },
];

describe.each<ModeKeys>(["vi", "emacs"])("a selection with tmux's %s keys", (modeKeys) => {
  beforeEach(() => {
    useModeKeys(modeKeys);
  });

  it.each(SELECTION_CASES)("runs $name", (selectionCase) => {
    scrollTop = selectionCase.scrolledBy ?? 0;
    enterAt(...selectionCase.start);
    beginCopySelection();

    for (const motion of selectionCase.moves) moveCopyCursor(motion);

    expectShown(selectionCase[modeKeys]);
    expect(copyModeUi().selecting).toBe(true);
  });

  it.each(SELECTION_CASES)("copies exactly what is selected after $name", async (selectionCase) => {
    scrollTop = selectionCase.scrolledBy ?? 0;
    enterAt(...selectionCase.start);
    beginCopySelection();
    for (const motion of selectionCase.moves) moveCopyCursor(motion);
    const shown = getSelection().toString();

    const copied = await copyAndReadSelection("keep");

    expect(copied).toBe(shown);
    expect(copied.replace(/\s+/g, " ")).toBe(selectionCase[modeKeys].text);
  });
});

// Chromium on macOS stops a step by a word, a paragraph or a line at the
// place where the selection was started when the step would take the cursor
// across it, which the fake browser does as well. tmux goes on in one press.
const FIVE_LEFT: CopyMotion[] = ["char-left", "char-left", "char-left", "char-left", "char-left"];
const FIVE_RIGHT: CopyMotion[] = ["char-right", "char-right", "char-right", "char-right", "char-right"];

const CROSSING_CASES: SelectionCase[] = [
  {
    name: "a word back, from behind where it was started to the start of the word in front of it",
    start: ["line-2", 6],
    moves: ["char-right", "char-right", "char-right", "word-back"],
    vi: { anchor: "line-2:7", focus: "line-2:5", text: "et", cursor: [2, 5, "character"] },
    emacs: { anchor: "line-2:6", focus: "line-2:5", text: "e", cursor: [2, 5, "character"] },
  },
  {
    name: "to the next word, from in front of where it was started",
    start: ["line-2", 6],
    moves: ["word-back", "word-forward"],
    vi: { anchor: "line-2:6", focus: "line-2:10", text: "ta t", cursor: [2, 9, "character"] },
    emacs: { anchor: "line-2:6", focus: "line-2:9", text: "ta ", cursor: [2, 9, "character"] },
  },
  {
    name: "to the end of the word, from in front of where it was started",
    start: ["line-2", 11],
    moves: ["word-back", "word-end"],
    vi: { anchor: "line-2:11", focus: "line-2:14", text: "eta", cursor: [2, 13, "character"] },
    emacs: { anchor: "line-2:11", focus: "line-2:14", text: "eta", cursor: [2, 14, "line end"] },
  },
  {
    name: "a word back to where it was started, and then to the word in front of it",
    start: ["line-2", 5],
    moves: ["word-forward", "word-back", "word-back"],
    vi: { anchor: "line-2:6", focus: "line-2:0", text: "zeta e", cursor: [2, 0, "character"] },
    emacs: { anchor: "line-2:5", focus: "line-2:0", text: "zeta ", cursor: [2, 0, "character"] },
  },
  {
    name: "to the previous paragraph, from the line below where it was started",
    start: ["line-3", 4],
    moves: ["line-down", "paragraph-back"],
    vi: { anchor: "line-3:5", focus: "line-3:0", text: "row 3", cursor: [3, 0, "character"] },
    emacs: { anchor: "line-3:4", focus: "line-3:0", text: "row ", cursor: [3, 0, "character"] },
  },
  {
    name: "to the next paragraph twice, from the line above where it was started",
    start: ["line-2", 10],
    moves: ["line-up", "paragraph-forward", "paragraph-forward"],
    vi: { anchor: "line-2:10", focus: "line-3:1", text: "heta r", cursor: [3, 0, "character"] },
    emacs: { anchor: "line-2:10", focus: "line-3:0", text: "heta ", cursor: [3, 0, "character"] },
  },
  {
    name: "one line up, onto the line where it was started and to the left of that place",
    start: ["line-3", 8],
    moves: ["line-down", ...FIVE_LEFT, "line-up"],
    vi: { anchor: "line-3:9", focus: "line-3:3", text: " 3 tex", cursor: [3, 3, "character"] },
    emacs: { anchor: "line-3:8", focus: "line-3:3", text: " 3 te", cursor: [3, 3, "character"] },
  },
  {
    name: "one line down, onto the line where it was started and to the right of that place",
    start: ["line-3", 2],
    moves: ["line-up", ...FIVE_RIGHT, "line-down"],
    vi: { anchor: "line-3:2", focus: "line-3:8", text: "w 3 te", cursor: [3, 7, "character"] },
    emacs: { anchor: "line-3:2", focus: "line-3:7", text: "w 3 t", cursor: [3, 7, "character"] },
  },
  {
    name: "one line up from the line where it was started, from the right of that place",
    start: ["line-3", 2],
    moves: [...FIVE_RIGHT, "line-up"],
    vi: { anchor: "line-3:3", focus: "line-2:7", text: "a theta row", cursor: [2, 7, "character"] },
    emacs: { anchor: "line-3:2", focus: "line-2:7", text: "a theta ro", cursor: [2, 7, "character"] },
  },
  {
    name: "one line down, back up to where it was started and one more line up",
    start: ["line-3", 4],
    moves: ["line-down", "line-up", "line-up"],
    vi: { anchor: "line-3:5", focus: "line-2:4", text: " eta theta row 3", cursor: [2, 4, "character"] },
    emacs: { anchor: "line-3:4", focus: "line-2:4", text: " eta theta row ", cursor: [2, 4, "character"] },
  },
];

describe.each<ModeKeys>(["vi", "emacs"])(
  "a move that would take the cursor across the place where the selection was started, with tmux's %s keys",
  (modeKeys) => {
    beforeEach(() => {
      useModeKeys(modeKeys);
    });

    it.each(CROSSING_CASES)("goes $name, in one press", (selectionCase) => {
      enterAt(...selectionCase.start);
      beginCopySelection();

      for (const motion of selectionCase.moves) moveCopyCursor(motion);

      expectShown(selectionCase[modeKeys]);
      expect(copyModeUi().selecting).toBe(true);
    });

    it("asks the browser once for a step that does not come to that place, and once more by the caret alone for one that the browser stopped there", () => {
      enterAt("line-2", 6);
      beginCopySelection();
      moveCopyCursor("word-forward");
      moveCopyCursor("word-forward");
      modifyCalls = [];

      moveCopyCursor("word-back");
      expect(modifyCalls).toEqual(["extend backward word"]);
      modifyCalls = [];

      moveCopyCursor("word-back");
      expect(modifyCalls).toEqual(["extend backward word", "move backward word"]);
      expect(copyModeUi().cursor).toEqual(blockAt(2, 5));
    });
  },
);

describe("a run of line moves that goes across the place where the selection was started", () => {
  // The cursor is taken below a short line and four characters to the right,
  // which is where the run begins: three characters to the left of the place
  // where the selection was started. The short line takes the cursor to its
  // end on the way up, and the line above it is the one of that place.
  const TO_BELOW_SHORT_LINE: CopyMotion[] = [
    "line-down",
    "line-down",
    "char-right",
    "char-right",
    "char-right",
    "char-right",
  ];

  function startBelowShortLine(): void {
    textOf("line-4").data = "ab";
    enterAt("line-3", 9);
    beginCopySelection();
    for (const motion of TO_BELOW_SHORT_LINE) moveCopyCursor(motion);
  }

  function visit(motions: readonly CopyMotion[]): string[] {
    return motions.map((motion) => {
      moveCopyCursor(motion);
      return focusAt();
    });
  }

  it("keeps its column with tmux's emacs keys: it lands left of that place, not at it and not at the column of the short line, and goes on at the column", () => {
    startBelowShortLine();
    expect(focusAt()).toBe("line-5:6");

    expect(visit(["line-up", "line-up", "line-up"])).toEqual([
      "line-4:2",
      "line-3:6",
      "line-2:6",
    ]);
    expect(anchorAt()).toBe("line-3:9");
  });

  it("keeps its column with tmux's vi keys, whose selection then takes in the character that it was started on", () => {
    useModeKeys("vi");
    startBelowShortLine();

    visit(["line-up", "line-up"]);
    expectShown({
      anchor: "line-3:10",
      focus: "line-3:6",
      text: "text",
      cursor: [3, 6, "character"],
    });

    visit(["line-up"]);
    expectShown({
      anchor: "line-3:10",
      focus: "line-2:6",
      text: "ta theta row 3 text",
      cursor: [2, 6, "character"],
    });
  });
});

describe("begin-selection with nothing moved", () => {
  it("selects the character under the cursor block at once with tmux's vi keys, and copies it", async () => {
    useModeKeys("vi");
    enterAt("line-2", 0);

    beginCopySelection();

    expectShown({ anchor: "line-2:0", focus: "line-2:1", text: "z", cursor: [2, 0, "character"] });
    expect(copyModeUi().selecting).toBe(true);
    await expect(copyAndReadSelection("exit")).resolves.toBe("z");
    expect(noticeText()).toBe("Selection copied");
    expect(isCopyModeActive()).toBe(false);
  });

  it("selects nothing yet with tmux's emacs keys, and the copy that leaves just leaves", async () => {
    useModeKeys("emacs");
    enterAt("line-2", 0);

    beginCopySelection();

    expectShown({ anchor: "line-2:0", focus: "line-2:0", text: "", cursor: [2, 0, "character"] });
    expect(copyModeUi().selecting).toBe(true);
    await expect(copyAndReadSelection("exit")).resolves.toBe("");
    expect(noticeText()).toBeNull();
    expect(isCopyModeActive()).toBe(false);
  });

  it.each<ModeKeys>(["vi", "emacs"])(
    "selects nothing at the end of a line, where the block is on no character, with tmux's %s keys",
    async (modeKeys) => {
      useModeKeys(modeKeys);
      enterAt("line-2", 14);

      beginCopySelection();

      expectShown({ anchor: "line-2:14", focus: "line-2:14", text: "", cursor: [2, 14, "line end"] });
      await expect(copyAndReadSelection("clear")).resolves.toBe("");
      expect(noticeText()).toBe(NOTHING_SELECTED_NOTICE);
      expect(copyModeUi().selecting).toBe(true);
    },
  );

  it("takes both halves of a character of two code units with tmux's vi keys", () => {
    useModeKeys("vi");
    textOf("line-2").data = "ab\u{1F600}cd";
    enterAt("line-2", 2);

    beginCopySelection();

    expect(anchorAt()).toBe("line-2:2");
    expect(focusAt()).toBe("line-2:4");
    expect(getSelection().toString()).toBe("\u{1F600}");
  });
});

// tmux copies a line cell by cell, each cell with all of its bytes
// (window_copy_copy_line in window-copy.c of tmux 3.5a), so never a part of
// a character.
describe.each(CLUSTERS)("%s under the cursor block with tmux's vi keys", (_name, character) => {
  beforeEach(() => {
    useModeKeys("vi");
    textOf("line-2").data = `ab${character}cd`;
  });

  it("is selected whole by begin-selection, and copied whole", async () => {
    enterAt("line-2", 2);

    beginCopySelection();

    expect(anchorAt()).toBe("line-2:2");
    expect(focusAt()).toBe(`line-2:${2 + character.length}`);
    await expect(copyAndReadSelection("keep")).resolves.toBe(character);
  });

  it("is whole in a selection that ends on it", () => {
    enterAt("line-2", 0);
    beginCopySelection();

    moveCopyCursor("char-right");
    moveCopyCursor("char-right");

    expect(anchorAt()).toBe("line-2:0");
    expect(getSelection().toString()).toBe(`ab${character}`);
  });

  it("is whole in a selection that was started on it and goes back", () => {
    enterAt("line-2", 2);
    beginCopySelection();

    moveCopyCursor("char-left");

    expect(anchorAt()).toBe(`line-2:${2 + character.length}`);
    expect(focusAt()).toBe("line-2:1");
    expect(getSelection().toString()).toBe(`b${character}`);
  });
});

describe("a character of several code points where the browser cannot tell characters apart", () => {
  const segmenter = Intl.Segmenter;

  beforeEach(() => {
    define(Intl, "Segmenter", undefined);
    useModeKeys("vi");
  });

  afterEach(() => {
    define(Intl, "Segmenter", segmenter);
  });

  it("is selected up to its first code point, both halves of it", () => {
    textOf("line-2").data = "ab\u{1F44D}\u{1F3FD}cd";
    enterAt("line-2", 2);

    beginCopySelection();

    expect(focusAt()).toBe("line-2:4");
    expect(getSelection().toString()).toBe("\u{1F44D}");
    expect(copyModeUi().cursor).toEqual({ ...blockAt(2, 2), width: 2 * CHAR_WIDTH });
  });

  it("is selected up to its first code point of one code unit", () => {
    textOf("line-2").data = "abe\u0301cd";
    enterAt("line-2", 2);

    beginCopySelection();

    expect(focusAt()).toBe("line-2:3");
    expect(getSelection().toString()).toBe("e");
  });
});

// A line of a paragraph is looked through from its end on a move up, where
// the line below is one that bb draws as a box of its own.
describe("a move up onto a line of a paragraph that is looked up, with a character of several code points on it", () => {
  function landingsAt(character: string, columns: readonly number[]): number[] {
    codeBlock(6, 9);
    textOf("line-5").data = `ab${character}cd`;
    textOf("line-6").data = "x".repeat(20);
    return columns.map((column) => {
      exitCopyMode();
      enterAt("line-6", column);
      moveCopyCursor("line-up");
      expect(getSelection().focusNode).toBe(textOf("line-5"));
      return getSelection().focusOffset;
    });
  }

  it.each(CLUSTERS)("never puts the cursor inside %s, at whatever column", (_name, character) => {
    const end = 2 + character.length;
    const columns = Array.from({ length: character.length + 5 }, (_, column) => column);

    const landings = landingsAt(character, columns);

    expect(landings.filter((offset) => offset > 2 && offset < end)).toEqual([]);
    expect(new Set(landings)).toEqual(new Set([0, 1, 2, end, end + 1, end + 2]));
    expect(modifyCalls).toEqual([]);
  });

  it.each([
    ["a thumb with a skin tone, in front of it from its left half", "\u{1F44D}\u{1F3FD}", 3, 2],
    ["a thumb with a skin tone, behind it from its right half", "\u{1F44D}\u{1F3FD}", 4, 6],
    ["a letter with a combining accent, behind it from its right half", "e\u0301", 3, 4],
    ["a letter with a combining accent, in front of it from its left edge", "e\u0301", 2, 2],
  ])("puts the cursor beside %s", (_name, character, column, offset) => {
    expect(landingsAt(character, [column])).toEqual([offset]);
  });

  it("puts the cursor as the move down onto the same line does, which looks through the line from its start", () => {
    const character = "\u{1F44D}\u{1F3FD}";
    const columns = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const up = landingsAt(character, columns);
    mountThread();
    codeBlock(1, 4);
    textOf("line-5").data = `ab${character}cd`;
    textOf("line-4").data = "x".repeat(20);

    const down = columns.map((column) => {
      exitCopyMode();
      enterAt("line-4", column);
      moveCopyCursor("line-down");
      return getSelection().focusOffset;
    });

    expect(up).toEqual(down);
  });

  it("goes by the surrogate pairs where the browser cannot tell characters apart", () => {
    const segmenter = Intl.Segmenter;
    define(Intl, "Segmenter", undefined);
    try {
      expect(landingsAt("\u{1F44D}\u{1F3FD}", [2, 3, 4, 5, 6])).toEqual([2, 4, 4, 6, 6]);
    } finally {
      define(Intl, "Segmenter", segmenter);
    }
  });
});

describe("begin-selection pressed a second time", () => {
  it("starts over on the character under the cursor block with tmux's vi keys", () => {
    useModeKeys("vi");
    enterAt("line-2", 0);
    beginCopySelection();
    moveCopyCursor("char-right");
    moveCopyCursor("char-right");
    expect(selectedText()).toBe("zet");

    beginCopySelection();

    expectShown({ anchor: "line-2:2", focus: "line-2:3", text: "t", cursor: [2, 2, "character"] });
    moveCopyCursor("char-right");
    expectShown({ anchor: "line-2:2", focus: "line-2:4", text: "ta", cursor: [2, 3, "character"] });
  });

  it("starts over with nothing selected with tmux's emacs keys", () => {
    useModeKeys("emacs");
    enterAt("line-2", 0);
    beginCopySelection();
    moveCopyCursor("char-right");
    moveCopyCursor("char-right");
    expect(selectedText()).toBe("ze");

    beginCopySelection();

    expectShown({ anchor: "line-2:2", focus: "line-2:2", text: "", cursor: [2, 2, "character"] });
    moveCopyCursor("char-right");
    expectShown({ anchor: "line-2:2", focus: "line-2:3", text: "t", cursor: [2, 3, "character"] });
  });
});

describe.each<ModeKeys>(["vi", "emacs"])("clear-selection with tmux's %s keys", (modeKeys) => {
  beforeEach(() => {
    useModeKeys(modeKeys);
  });

  it("drops the selection and leaves the cursor on the character it was on", () => {
    enterAt("line-2", 0);
    beginCopySelection();
    moveCopyCursor("char-right");
    moveCopyCursor("char-right");
    moveCopyCursor("char-right");

    clearCopySelection();

    expectShown({ anchor: "line-2:3", focus: "line-2:3", text: "", cursor: [2, 3, "character"] });
    expect(copyModeUi().selecting).toBe(false);
    expect(isCopyModeActive()).toBe(true);
  });

  it("goes on from that character, and selects from there when a selection is started again", () => {
    enterAt("line-2", 0);
    beginCopySelection();
    moveCopyCursor("char-right");
    moveCopyCursor("char-right");
    moveCopyCursor("char-right");
    clearCopySelection();

    moveCopyCursor("char-right");
    expect(focusAt()).toBe("line-2:4");
    expect(getSelection().isCollapsed).toBe(true);

    beginCopySelection();
    moveCopyCursor("char-right");
    expect(anchorAt()).toBe("line-2:4");
    expect(selectedText()).toBe(modeKeys === "vi" ? " e" : " ");
  });
});

describe.each<[ModeKeys, string]>([
  ["vi", "zeta"],
  ["emacs", "zet"],
])("copying from the z of zeta to its a with tmux's %s keys", (modeKeys, text) => {
  beforeEach(() => {
    useModeKeys(modeKeys);
    enterAt("line-2", 0);
    beginCopySelection();
    moveCopyCursor("char-right");
    moveCopyCursor("char-right");
    moveCopyCursor("char-right");
  });

  it(`copies "${text}" and leaves copy mode for copy-selection-and-cancel`, async () => {
    await expect(copyAndReadSelection("exit")).resolves.toBe(text);

    expect(noticeText()).toBe("Selection copied");
    expect(isCopyModeActive()).toBe(false);
    expect(getSelection().rangeCount).toBe(0);
  });

  it(`copies "${text}", drops the selection and stays for copy-selection`, async () => {
    await expect(copyAndReadSelection("clear")).resolves.toBe(text);

    expect(noticeText()).toBe("Selection copied");
    expect(isCopyModeActive()).toBe(true);
    expectShown({ anchor: "line-2:3", focus: "line-2:3", text: "", cursor: [2, 3, "character"] });
    expect(copyModeUi().selecting).toBe(false);
  });

  it(`copies "${text}" and keeps the selection for copy-selection-no-clear`, async () => {
    await expect(copyAndReadSelection("keep")).resolves.toBe(text);

    expect(noticeText()).toBe("Selection copied");
    expect(isCopyModeActive()).toBe(true);
    expect(copyModeUi().selecting).toBe(true);
    expect(selectedText()).toBe(text);
    moveCopyCursor("char-right");
    expect(selectedText()).toBe(modeKeys === "vi" ? "zeta " : "zeta");
  });

  it("copies its own selection when something else changed the selection", async () => {
    getSelection().removeAllRanges();

    await expect(copyAndReadSelection("exit")).resolves.toBe(text);
  });

  it("keeps what is selected for bb's selection menu", () => {
    exitCopyModeKeepingSelection();

    expect(isCopyModeActive()).toBe(false);
    expect(getSelection().toString()).toBe(text);
  });
});

describe("the end of a word with tmux's vi keys, which is its last character", () => {
  beforeEach(() => {
    useModeKeys("vi");
  });

  it.each([
    ["the first character of a word", 0, "line-2:3"],
    ["inside a word", 1, "line-2:3"],
    ["the character before the last one", 2, "line-2:3"],
    ["the last character of a word, where it goes to that of the next word", 3, "line-2:7"],
    ["a blank between two words", 4, "line-2:7"],
    ["the last character of the word before the last one of a line", 7, "line-2:13"],
    ["the last character of a line, where it goes to the first word of the next line", 13, "line-3:2"],
    ["the end of a line, behind its last character", 14, "line-3:2"],
  ])("goes there from %s", (_name, offset, place) => {
    enterAt("line-2", offset);

    moveCopyCursor("word-end");

    expect(focusAt()).toBe(place);
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("draws the cursor block on that character", () => {
    enterAt("line-2", 0);

    moveCopyCursor("word-end");

    expect(copyModeUi().cursor).toEqual(blockAt(2, 3));
  });

  it("stays on the last character of the conversation", () => {
    scrollTop = 200;
    enterAt(LAST_LINE, 10);

    moveCopyCursor("word-end");

    expect(focusAt()).toBe(`${LAST_LINE}:10`);
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("stays at the very end of the conversation", () => {
    scrollTop = 200;
    enterAt(LAST_LINE, 11);

    moveCopyCursor("word-end");

    expect(focusAt()).toBe(`${LAST_LINE}:11`);
    expect(getSelection().isCollapsed).toBe(true);
  });

  it("goes to the last character of a word of one character", () => {
    textOf("line-2").data = "a bc d";
    enterAt("line-2", 0);

    moveCopyCursor("word-end");
    expect(focusAt()).toBe("line-2:3");
    moveCopyCursor("word-end");
    expect(focusAt()).toBe("line-2:5");
  });

  describe("on Windows, where the browser's word move lands on the start of the next word", () => {
    beforeEach(() => {
      doesWordMoveSkipBlanks = true;
    });

    it.each([
      ["the first character of a word", 0, "line-2:3"],
      ["the last character of a word", 3, "line-2:7"],
      ["a blank between two words", 4, "line-2:7"],
      ["the last character of the word before the last one of a line", 7, "line-2:13"],
      ["inside the last word of a line", 10, "line-2:13"],
    ])("goes there from %s", (_name, offset, place) => {
      enterAt("line-2", offset);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe(place);
      expect(getSelection().isCollapsed).toBe(true);
    });

    it("selects the word and nothing behind it", () => {
      enterAt("line-2", 0);
      beginCopySelection();

      moveCopyCursor("word-end");

      expect(getSelection().toString()).toBe("zeta");
    });
  });

  describe("in Chromium, whose word move from the end of a paragraph stops at the start of the text that follows", () => {
    beforeEach(() => {
      doesWordMoveStopAtTextStart = true;
    });

    it.each([
      ["the last character of a paragraph", 13],
      ["the end of a paragraph, behind its last character", 14],
    ])("goes to the last character of the first word of the next paragraph from %s", (_name, offset) => {
      enterAt("line-2", offset);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe("line-3:2");
      expect(copyModeUi().cursor).toEqual(blockAt(3, 2));
    });

    it("goes on from word to word and from paragraph to paragraph on every press", () => {
      enterAt("line-2", 7);
      const visited: string[] = [];

      for (let press = 0; press < 5; press += 1) {
        moveCopyCursor("word-end");
        visited.push(focusAt());
      }

      expect(visited).toEqual(["line-2:13", "line-3:2", "line-3:4", "line-3:9", "line-4:2"]);
    });

    it("still stays on the last character of the conversation", () => {
      scrollTop = 200;
      enterAt(LAST_LINE, 10);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe(`${LAST_LINE}:10`);
    });
  });
});

describe("the character under the cursor block with tmux's vi keys", () => {
  beforeEach(() => {
    useModeKeys("vi");
  });

  it("is taken from the next piece of text when that follows on the same line", () => {
    mountThread({
      extraRowsHtml: `
        <div data-timeline-row-id="row-rich"><p id="rich">plain <b id="bold">bold</b></p></div>`,
    });
    const top = CONTENT_TOP + 2 * LINE_HEIGHT;
    boxes.set(textOf("rich"), { top, left: 300, columnLeft: 0, isFixed: false });
    boxes.set(textOf("bold"), { top, left: 300 + 6 * CHAR_WIDTH, columnLeft: 0, isFixed: false });
    enterAt("rich", 6);

    beginCopySelection();

    expect(anchorAt()).toBe("rich:6");
    expect(focusAt()).toBe("bold:1");
    expect(getSelection().toString()).toBe("b");
  });

  it("is none at the end of a line when the next piece of text is on the next line", () => {
    mountThread({
      extraRowsHtml: `
        <div data-timeline-row-id="row-stacked"><p id="stacked">first<br><b id="stacked-next">second</b></p></div>`,
    });
    const top = CONTENT_TOP + 2 * LINE_HEIGHT;
    boxes.set(textOf("stacked"), { top, left: 300, columnLeft: 0, isFixed: false });
    boxes.set(textOf("stacked-next"), {
      top: top + LINE_HEIGHT,
      left: 300,
      columnLeft: 0,
      isFixed: false,
    });
    enterAt("stacked", 2);
    beginCopySelection();

    moveCopyCursor("line-end");

    expect(anchorAt()).toBe("stacked:2");
    expect(focusAt()).toBe("stacked:5");
    expect(getSelection().toString()).toBe("rst");
  });

  it("is none where the browser reports no rectangles, so that the selection ends at the cursor", () => {
    enterAt("line-2", 0);
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    beginCopySelection();

    moveCopyCursor("char-right");

    expect(anchorAt()).toBe("line-2:0");
    expect(focusAt()).toBe("line-2:1");
  });

  it("stays in the selection when its text is cut off behind where the selection was started", () => {
    enterAt("line-2", 13);
    beginCopySelection();
    moveCopyCursor("char-left");
    expect(anchorAt()).toBe("line-2:14");
    textOf("line-2").data = "zeta eta thet";

    moveCopyCursor("char-left");

    expect(isCopyModeActive()).toBe(true);
    expect(anchorAt()).toBe("line-2:13");
    expect(focusAt()).toBe("line-2:11");
  });

  it("goes back into the selection on the next move after something else changed the selection", () => {
    enterAt("line-2", 0);
    beginCopySelection();
    moveCopyCursor("char-right");
    getSelection().setBaseAndExtent(textOf("line-0"), 0, textOf("line-0"), 5);

    moveCopyCursor("char-right");

    expectShown({ anchor: "line-2:0", focus: "line-2:3", text: "zet", cursor: [2, 2, "character"] });
  });

  it("is in the selection after a scroll took the cursor to another line", () => {
    enterAt("line-0", 3);
    beginCopySelection();

    scrollCopyView(80);

    expectShown({
      anchor: "line-0:3",
      focus: "line-4:1",
      text: "ha beta gamma delta epsilon zeta eta theta row 3 text r",
      cursor: [4, 0, "character"],
    });
  });

  it("leaves copy mode and says so when the text that the selection was started in is gone", () => {
    enterAt("line-2", 6);
    beginCopySelection();
    moveCopyCursor("line-up");
    removeRow("line-2");

    moveCopyCursor("line-up");

    expect(isCopyModeActive()).toBe(false);
    expect(noticeText()).toBe(LOST_NOTICE);
    expect(getSelection().rangeCount).toBe(0);
  });

  it("follows the tmux config when that changes the copy table while copy mode is on", () => {
    enterAt("line-2", 0);
    beginCopySelection();
    moveCopyCursor("char-right");
    expect(selectedText()).toBe("ze");

    useModeKeys("emacs");
    moveCopyCursor("char-right");
    expect(selectedText()).toBe("ze");

    useModeKeys("vi");
    moveCopyCursor("char-right");
    expect(selectedText()).toBe("zeta");
  });
});

// bb draws every line of a highlighted code block as a box of its own, and
// the browser's move by a line from such a box does not go to the next box:
// it lands behind the block, or in an empty layer of bb.
describe("a move by a line where the browser jumps over lines, as in a code block of bb", () => {
  it("goes to the next line and not to where the browser went", () => {
    enterAt("line-4", 5);
    jumpedOverLines = new Set(["line-5", "line-6"]);

    moveCopyCursor("line-down");

    expect(focusAt()).toBe("line-5:5");
    expect(getSelection().isCollapsed).toBe(true);
    expect(copyModeUi().cursor).toEqual(blockAt(5, 5));
  });

  it("visits every line of the block on the way down and on the way up, and keeps the column", () => {
    textOf("line-5").data = "ab";
    enterAt("line-3", 6);
    jumpedOverLines = new Set(["line-5", "line-6"]);
    const visited: string[] = [];

    for (const motion of ["line-down", "line-down", "line-down", "line-down"] as const) {
      moveCopyCursor(motion);
      visited.push(focusAt());
    }
    jumpedOverLines = new Set(["line-4", "line-5"]);
    for (const motion of ["line-up", "line-up", "line-up", "line-up"] as const) {
      moveCopyCursor(motion);
      visited.push(focusAt());
    }

    expect(visited).toEqual([
      "line-4:6",
      "line-5:2",
      "line-6:6",
      "line-7:6",
      "line-6:6",
      "line-5:2",
      "line-4:6",
      "line-3:6",
    ]);
  });

  it("goes to the next line when the browser left the conversation from inside the block", () => {
    enterAt("line-4", 5);
    stepsInto.set("line-4:5 forward line", [byId("menu-layer"), 0]);

    moveCopyCursor("line-down");

    expect(focusAt()).toBe("line-5:5");
  });

  it("extends a selection to the next line with tmux's vi keys, up to the character under the cursor", () => {
    useModeKeys("vi");
    enterAt("line-4", 2);
    beginCopySelection();
    jumpedOverLines = new Set(["line-5", "line-6"]);

    moveCopyCursor("line-down");

    expect(anchorAt()).toBe("line-4:2");
    expect(focusAt()).toBe("line-5:3");
    expect(selectedText()).toBe("w 4 text row");
  });

  it("puts the cursor at the end of a line that is shorter than the column", () => {
    textOf("line-5").data = "ab";
    enterAt("line-4", 7);
    jumpedOverLines = new Set(["line-5", "line-6"]);

    moveCopyCursor("line-down");

    expect(focusAt()).toBe("line-5:2");
    expect(copyModeUi().cursor).toEqual(caretAt(5, 2));
  });

  it("takes a page key through such a block line by line", () => {
    enterAt("line-0", 3);
    jumpedOverLines = new Set(["line-2", "line-3", "line-4"]);

    moveCopyCursor("half-page-down");

    expect(focusAt()).toBe("line-8:3");
  });

  it("leaves a move alone that the browser made to the next line, and does not look through the text for it", () => {
    const walkers = vi.spyOn(document, "createTreeWalker");
    enterAt("line-4", 5);

    moveCopyCursor("line-down");

    expect(focusAt()).toBe("line-5:5");
    expect(walkers.mock.calls.filter(([root]) => root === byId("viewport"))).toEqual([]);
  });
});

// In Chromium a move by a line from inside such a box takes longer the longer
// the code block is: over half a second in a block of 300 lines.
describe("a move by a line from a line that bb draws as a box of its own", () => {
  it("looks the next line up and does not ask the browser, down and up, and keeps the column", () => {
    codeBlock(4, 9);
    textOf("line-7").data = "ab";
    enterAt("line-5", 6);
    const visited: string[] = [];

    for (const motion of ["line-down", "line-down", "line-down", "line-up", "line-up"] as const) {
      moveCopyCursor(motion);
      visited.push(focusAt());
    }

    expect(visited).toEqual(["line-6:6", "line-7:2", "line-8:6", "line-7:2", "line-6:6"]);
    expect(modifyCalls).toEqual([]);
  });

  it("leaves the block for the line behind it without asking the browser, which makes the moves from there", () => {
    codeBlock(4, 9);
    enterAt("line-9", 3);

    moveCopyCursor("line-down");
    expect(focusAt()).toBe("line-10:3");
    expect(modifyCalls).toEqual([]);

    moveCopyCursor("line-down");
    expect(focusAt()).toBe("line-11:3");
    expect(modifyCalls).toEqual(["move forward line"]);
  });

  it("takes a page key through the block without asking the browser", () => {
    mountThread({ lineCount: 40 });
    codeBlock(2, 30);
    enterAt("line-4", 3);

    moveCopyCursor("half-page-down");

    expect(focusAt()).toBe("line-12:3");
    expect(modifyCalls).toEqual([]);
  });

  it("extends a selection with tmux's vi keys line by line without asking the browser", () => {
    useModeKeys("vi");
    codeBlock(4, 9);
    enterAt("line-5", 2);
    beginCopySelection();

    moveCopyCursor("line-down");
    moveCopyCursor("line-down");

    expect(anchorAt()).toBe("line-5:2");
    expect(focusAt()).toBe("line-7:3");
    expect(modifyCalls).toEqual([]);
  });

  it("asks the browser where no line is found, as at the end of the conversation", () => {
    codeBlock(17, 19);
    scrollTop = 200;
    enterAt(LAST_LINE, 3);

    moveCopyCursor("line-down");

    expect(focusAt()).toBe(`${LAST_LINE}:3`);
    expect(modifyCalls).toEqual(["move forward line"]);
  });
});

describe("the empty elements of bb that the browser walks into", () => {
  // bb's layer for its selection menu lies behind the last row, and its
  // stand-in for rows that are not loaded lies in front of the first one.
  function addSpacer(): HTMLElement {
    const spacer = document.createElement("div");
    spacer.setAttribute("data-timeline-window-spacer", "");
    spacer.setAttribute("aria-hidden", "true");
    document.querySelector("[data-timeline-items]")?.prepend(spacer);
    return spacer;
  }

  it.each([
    ["line-down", "forward line"],
    ["char-right", "right character"],
    ["paragraph-forward", "forward paragraph"],
  ] as const)(
    "keeps the cursor on the last line, and shows it, when %s walks into the layer for the selection menu",
    (motion, step) => {
      scrollTop = 200;
      enterAt(LAST_LINE, 4);
      stepsInto.set(`${LAST_LINE}:4 ${step}`, [byId("menu-layer"), 0]);

      moveCopyCursor(motion);

      expect(focusAt()).toBe(`${LAST_LINE}:4`);
      expect(copyModeUi().cursor).toEqual(blockAt(19, 4));
      moveCopyCursor("char-left");
      expect(focusAt()).toBe(`${LAST_LINE}:3`);
    },
  );

  it("keeps the cursor on the first line when a move up walks into the stand-in for rows that are not loaded", () => {
    const spacer = addSpacer();
    enterAt("line-0", 4);
    stepsInto.set("line-0:4 backward line", [spacer, 0]);

    moveCopyCursor("line-up");

    expect(focusAt()).toBe("line-0:4");
    expect(copyModeUi().cursor).toEqual(blockAt(0, 4));
  });

  it("keeps a selection as it is, with tmux's vi keys as well", () => {
    useModeKeys("vi");
    scrollTop = 200;
    enterAt(LAST_LINE, 4);
    beginCopySelection();
    stepsInto.set(`${LAST_LINE}:4 forward line`, [byId("menu-layer"), 0]);

    moveCopyCursor("line-down");

    expect(copyModeUi()).toMatchObject({ selecting: true, cursor: blockAt(19, 4) });
    expect(selectedText()).toBe("1");
  });

  it("passes over a place without a cursor that has text behind it", () => {
    enterAt("line-3", 4);
    stepsInto.set("line-3:4 right character", [byId("menu-layer"), 0]);
    stepsInto.set(":0 right character", [textOf("line-4"), 0]);

    moveCopyCursor("char-right");

    expect(focusAt()).toBe("line-4:0");
  });
});

describe("text that a box of bb cuts off", () => {
  interface BoxLayout {
    lines: [first: number, last: number];
    shown: [first: number, last: number];
    overflow: "hidden" | "auto";
  }

  // Puts the lines into one box, as the lines of a long user message are in
  // one, which shows some of them: with "hidden" bb cuts the others off, and
  // with "auto" the box scrolls to them.
  function boxAround({ lines, shown, overflow }: BoxLayout): HTMLElement {
    const box = document.createElement("div");
    box.id = "clip-box";
    box.style.overflowY = overflow;
    const first = byId(`line-${lines[0]}`).closest("[data-timeline-row-id]");
    first?.before(box);
    for (let index = lines[0]; index <= lines[1]; index += 1) {
      box.append(byId(`line-${index}`));
    }
    const shownHeight = (shown[1] - shown[0] + 1) * LINE_HEIGHT;
    box.getBoundingClientRect = () =>
      rect(0, CONTENT_TOP + shown[0] * LINE_HEIGHT - scrollTop, PANE_WIDTH, shownHeight);
    define(box, "clientWidth", PANE_WIDTH);
    define(box, "clientHeight", shownHeight);
    define(box, "scrollHeight", (lines[1] - lines[0] + 1) * LINE_HEIGHT);
    define(box, "scrollWidth", PANE_WIDTH);
    return box;
  }

  const COLLAPSED: BoxLayout = { lines: [5, 9], shown: [5, 6], overflow: "hidden" };

  it("goes from the last line that shows to the first text behind the box on a move down", () => {
    boxAround(COLLAPSED);
    enterAt("line-5", 3);

    moveCopyCursor("line-down");
    expect(focusAt()).toBe("line-6:3");
    moveCopyCursor("line-down");

    expect(focusAt()).toBe("line-10:3");
    expect(copyModeUi().cursor).toEqual(blockAt(10, 3));
  });

  it("goes from the text behind the box to the last line that shows on a move up", () => {
    boxAround(COLLAPSED);
    enterAt("line-10", 3);

    moveCopyCursor("line-up");

    expect(focusAt()).toBe("line-6:3");
  });

  it.each([
    ["char-right", "line-6", 10, "line-10:0"],
    ["word-forward", "line-6", 8, "line-10:0"],
    ["paragraph-forward", "line-6", 4, "line-10:0"],
    ["char-left", "line-10", 0, "line-6:10"],
  ] as const)("passes over the hidden text on %s", (motion, line, offset, reached) => {
    boxAround(COLLAPSED);
    enterAt(line, offset);

    moveCopyCursor(motion);

    expect(focusAt()).toBe(reached);
  });

  it("goes on with tmux's vi keys from the end of the last line that shows to the end of the first word behind the box, as Chromium's word move stops where that text starts", () => {
    useModeKeys("vi");
    doesWordMoveStopAtTextStart = true;
    boxAround(COLLAPSED);
    enterAt("line-6", 10);

    moveCopyCursor("word-end");

    expect(focusAt()).toBe("line-10:2");
  });

  it("goes on with tmux's emacs keys as well, to the end of the first word behind the box", () => {
    doesWordMoveStopAtTextStart = true;
    boxAround(COLLAPSED);
    enterAt("line-6", 10);

    moveCopyCursor("word-end");

    expect(focusAt()).toBe("line-10:3");
  });

  // The line in a box of its own that cuts off what is outside it and does
  // not scroll. The right edge that the box reports is this far left of the
  // end of the line.
  function boxAroundLine(lineId: string, narrowerBy: number): void {
    const text = textOf(lineId);
    const lineBox = boxes.get(text);
    if (lineBox === undefined) throw new Error("the fixture line has no box");
    const width = TEXT_INSET + text.length * CHAR_WIDTH - narrowerBy;
    const box = document.createElement("div");
    box.style.overflowX = "auto";
    byId(lineId).before(box);
    box.append(byId(lineId));
    box.getBoundingClientRect = () => rect(0, screenTop(lineBox), width, LINE_HEIGHT);
    define(box, "clientWidth", width);
    define(box, "scrollWidth", width);
    define(box, "clientHeight", LINE_HEIGHT);
    define(box, "scrollHeight", LINE_HEIGHT);
  }

  // As bb 0.50.1 draws a message of the user (CollapsibleMessageText in
  // ConversationMessageContent.tsx): its text is in a box that is as wide as
  // its widest line and cuts off what is outside it. The place behind the
  // last character of that line is at the right edge of the box, and in
  // Chromium up to half a pixel to either side of it, as the width that the
  // box reports is a whole number of pixels.
  describe.each([
    ["at the edge of the box of that message", 0],
    ["a part of a pixel right of the edge that the box reports", 0.4],
    ["a part of a pixel left of the edge that the box reports", -0.4],
  ])("the end of the widest line of a message of the user, which is %s", (_name, narrowerBy) => {
    beforeEach(() => {
      boxAroundLine("line-6", narrowerBy);
    });

    describe.each<ModeKeys>(["vi", "emacs"])("with tmux's %s keys", (modeKeys) => {
      beforeEach(() => {
        useModeKeys(modeKeys);
      });

      it("holds the cursor on the move to the end of the line, and shows it as a narrow mark", () => {
        enterAt("line-6", 3);

        moveCopyCursor("line-end");

        expect(focusAt()).toBe("line-6:10");
        expect(copyModeUi().cursor).toEqual(caretAt(6, 10));
      });

      it("holds the cursor on a step to the right from the last character, and the next step goes on to the next line", () => {
        enterAt("line-6", 9);

        moveCopyCursor("char-right");
        expect(focusAt()).toBe("line-6:10");
        expect(copyModeUi().cursor).toEqual(caretAt(6, 10));

        moveCopyCursor("char-right");
        expect(focusAt()).toBe("line-7:0");
      });

      it("holds the cursor on a step to the left from the start of the next line", () => {
        enterAt("line-7", 0);

        moveCopyCursor("char-left");

        expect(focusAt()).toBe("line-6:10");
        expect(copyModeUi().cursor).toEqual(caretAt(6, 10));
      });

      it("shows the cursor there after a move by a line that is looked up, from a column right of that line", () => {
        textOf("line-7").data = "a line that is longer";
        jumpedOverLines = new Set(["line-6"]);
        enterAt("line-7", 15);

        moveCopyCursor("line-up");

        expect(focusAt()).toBe("line-6:10");
        expect(copyModeUi().cursor).toEqual(caretAt(6, 10));
      });

      it("selects up to the end of the line, with its last character", () => {
        enterAt("line-6", 6);
        beginCopySelection();

        moveCopyCursor("line-end");

        expect(getSelection().toString()).toBe("text");
      });
    });

    it("stops there with tmux's emacs keys on the move to the end of the last word of the line, and goes on to the next word from there", () => {
      doesWordMoveStopAtTextStart = true;
      enterAt("line-6", 5);

      moveCopyCursor("word-end");
      expect(focusAt()).toBe("line-6:10");
      expect(copyModeUi().cursor).toEqual(caretAt(6, 10));

      moveCopyCursor("word-end");
      expect(focusAt()).toBe("line-7:3");
    });

    it("goes onto the last character of the line with tmux's vi keys, where the cursor block shows", () => {
      useModeKeys("vi");
      doesWordMoveStopAtTextStart = true;
      enterAt("line-6", 5);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe("line-6:9");
      expect(copyModeUi().cursor).toEqual(blockAt(6, 9));
    });
  });

  // The box ends in the middle of the last character of the line, so that
  // character shows in part and the place behind it is outside the box.
  describe("the end of a word that a box cuts off in part", () => {
    const HALF_A_CHARACTER = CHAR_WIDTH / 2;

    it.each([
      ["as Chromium's word move stops where the next text starts", true],
      ["where the word move stops behind the first word of the next text", false],
    ])(
      "is passed over with tmux's emacs keys, which go on to the end of the first word of the next text, %s",
      (_name, stopsAtTextStart) => {
        doesWordMoveStopAtTextStart = stopsAtTextStart;
        boxAroundLine("line-6", HALF_A_CHARACTER);
        enterAt("line-6", 5);

        moveCopyCursor("word-end");

        expect(focusAt()).toBe("line-7:3");
        expect(copyModeUi().cursor).toEqual(blockAt(7, 3));
      },
    );

    it("is passed over on the way to the end of the next word as well", () => {
      doesWordMoveStopAtTextStart = true;
      boxAroundLine("line-6", HALF_A_CHARACTER);
      enterAt("line-6", 5);

      moveCopyCursor("word-end");
      moveCopyCursor("word-end");

      expect(focusAt()).toBe("line-7:5");
    });

    it("leaves the end of a word of that line alone that can hold the cursor", () => {
      doesWordMoveStopAtTextStart = true;
      boxAroundLine("line-6", HALF_A_CHARACTER);
      enterAt("line-6", 0);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe("line-6:3");
    });

    it("leaves the cursor block on the last character with tmux's vi keys, which shows in part", () => {
      useModeKeys("vi");
      doesWordMoveStopAtTextStart = true;
      boxAroundLine("line-6", HALF_A_CHARACTER);
      enterAt("line-6", 5);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe("line-6:9");
      expect(copyModeUi().cursor).toEqual(blockAt(6, 9));
    });

    it.each<ModeKeys>(["vi", "emacs"])(
      "is no place for the cursor on the move to the end of the line with tmux's %s keys",
      (modeKeys) => {
        useModeKeys(modeKeys);
        boxAroundLine("line-6", HALF_A_CHARACTER);
        enterAt("line-6", 3);

        moveCopyCursor("line-end");

        expect(focusAt()).toBe("line-6:3");
      },
    );
  });

  it("goes to the last text that shows on the move to the end of the conversation, when the hidden text is the last", () => {
    boxAround({ lines: [16, 19], shown: [16, 17], overflow: "hidden" });
    scrollTop = 200;
    enterAt("line-12", 3);

    moveCopyCursor("document-end");

    expect(focusAt()).toBe("line-17:11");
  });

  it("moves into the lines of a box that scrolls by itself, and scrolls that box to the cursor", () => {
    const box = boxAround({ lines: [5, 9], shown: [5, 6], overflow: "auto" });
    let boxScrollTop = 0;
    Object.defineProperty(box, "scrollTop", {
      configurable: true,
      get: () => boxScrollTop,
      set: (value: number) => {
        boxScrollTop = value;
      },
    });
    enterAt("line-6", 3);

    moveCopyCursor("line-down");

    expect(focusAt()).toBe("line-7:3");
    expect(boxScrollTop).toBe(LINE_HEIGHT + 10);
  });

  it("draws no cursor on a line that such a box does not show", () => {
    boxAround({ lines: [5, 9], shown: [5, 6], overflow: "auto" });
    enterAt("line-6", 3);

    moveCopyCursor("line-down");

    expect(focusAt()).toBe("line-7:3");
    expect(copyModeUi().cursor).toBeNull();
  });

  describe("a line of a code block of bb that is wider than the block", () => {
    const BLOCK_WIDTH = 400;
    const LONG_LINE = "word ".repeat(30);
    const LINE_WIDTH = TEXT_INSET + LONG_LINE.length * CHAR_WIDTH;
    const FIRST_HIDDEN_WORD = 45;

    // As bb 0.50.1 draws it (markdown-preview.tsx): a frame that cuts off
    // what overflows it, and inside it the box of the code, which scrolls
    // sideways. Scrolling that box moves the text of the line.
    function codeBlockAround(lineId: string): HTMLElement {
      const text = textOf(lineId);
      text.data = LONG_LINE;
      const lineBox = boxes.get(text);
      if (lineBox === undefined) throw new Error("the fixture line has no box");
      const frame = document.createElement("div");
      frame.style.overflowX = "hidden";
      frame.style.overflowY = "hidden";
      const code = document.createElement("pre");
      code.style.overflowX = "auto";
      byId(lineId).before(frame);
      frame.append(code);
      code.append(byId(lineId));
      for (const element of [frame, code]) {
        element.getBoundingClientRect = () =>
          rect(0, screenTop(lineBox), BLOCK_WIDTH, LINE_HEIGHT);
        define(element, "clientWidth", BLOCK_WIDTH);
        define(element, "clientHeight", LINE_HEIGHT);
        define(element, "scrollHeight", LINE_HEIGHT);
      }
      define(frame, "scrollWidth", BLOCK_WIDTH);
      define(code, "scrollWidth", LINE_WIDTH);
      Object.defineProperty(code, "scrollLeft", {
        configurable: true,
        get: () => TEXT_INSET - lineBox.left,
        set: (value: number) => {
          lineBox.left = TEXT_INSET - value;
        },
      });
      return code;
    }

    it("goes to the end of the line, scrolls the code sideways to the cursor and draws it there", () => {
      const code = codeBlockAround("line-2");
      enterAt("line-2", 2);

      moveCopyCursor("line-end");

      expect(focusAt()).toBe(`line-2:${LONG_LINE.length}`);
      expect(code.scrollLeft).toBe(LINE_WIDTH + CARET_WIDTH - (BLOCK_WIDTH - 16));
      expect(copyModeUi().cursor).toEqual({
        left: BLOCK_WIDTH - 16 - CARET_WIDTH,
        top: CONTENT_TOP + 2 * LINE_HEIGHT,
        width: CARET_WIDTH,
        height: LINE_HEIGHT,
      });
    });

    it.each(["line-start", "line-indent"] as const)(
      "goes back to the start of the line with %s after the code was scrolled",
      (motion) => {
        const code = codeBlockAround("line-2");
        enterAt("line-2", 2);
        moveCopyCursor("line-end");

        moveCopyCursor(motion);

        expect(focusAt()).toBe("line-2:0");
        expect(code.scrollLeft).toBe(TEXT_INSET - 16);
      },
    );

    it("goes on by words through the part of the line that does not show", () => {
      codeBlockAround("line-2");
      enterAt("line-2", FIRST_HIDDEN_WORD - 5);

      moveCopyCursor("word-forward");
      expect(focusAt()).toBe(`line-2:${FIRST_HIDDEN_WORD}`);
      moveCopyCursor("word-forward");

      expect(focusAt()).toBe(`line-2:${FIRST_HIDDEN_WORD + 5}`);
    });

    it("comes to the end of the line from the start of the line below", () => {
      codeBlockAround("line-2");
      enterAt("line-3", 0);

      moveCopyCursor("char-left");

      expect(focusAt()).toBe(`line-2:${LONG_LINE.length}`);
    });

    it("selects up to the end of the line with tmux's vi keys", () => {
      useModeKeys("vi");
      codeBlockAround("line-2");
      enterAt("line-2", 2);
      beginCopySelection();

      moveCopyCursor("line-end");

      expect(getSelection().toString()).toBe(LONG_LINE.slice(2));
    });

    it("scrolls the code back to the start of the line when copy mode is entered on a line whose start the scrolled code hides, and draws the cursor", () => {
      const code = codeBlockAround(LAST_VISIBLE_LINE);
      code.scrollLeft = 300;

      expect(enterCopyMode()).toBe(true);

      expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
      expect(code.scrollLeft).toBe(TEXT_INSET - 16);
      expect(copyModeUi().cursor).toEqual({
        left: 16,
        top: CONTENT_TOP + 13 * LINE_HEIGHT,
        width: CHAR_WIDTH,
        height: LINE_HEIGHT,
      });
    });

    it("does the same when a scroll key puts the cursor on such a line", () => {
      const code = codeBlockAround("line-4");
      enterAt("line-0", 3);
      code.scrollLeft = 300;

      scrollCopyView(80);

      expect(focusAt()).toBe("line-4:0");
      expect(code.scrollLeft).toBe(TEXT_INSET - 16);
      expect(copyModeUi().cursor).not.toBeNull();
    });

    it("leaves the code as it is scrolled when the cursor shows where copy mode is entered", () => {
      const code = codeBlockAround(LAST_VISIBLE_LINE);
      code.scrollLeft = 30;
      const text = textOf(LAST_VISIBLE_LINE);
      getSelection().setBaseAndExtent(text, 0, text, 20);

      expect(enterCopyMode()).toBe(true);

      expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:20`);
      expect(code.scrollLeft).toBe(30);
    });
  });
});

describe("the cursor on an empty line of preformatted text", () => {
  // As Chromium reports it: no rectangle for a place at the start of an
  // empty line, and one without a width for the line break of that line.
  function preformatted(text: string): Text {
    const node = textOf("line-2");
    node.data = text;
    const box = boxes.get(node);
    if (box === undefined) throw new Error("the fixture line has no box");
    const lineOf = (offset: number): number => text.slice(0, offset).split("\n").length - 1;
    const columnOf = (offset: number): number => offset - (text.lastIndexOf("\n", offset - 1) + 1);
    const isEmptyLineStart = (offset: number): boolean =>
      text[offset] === "\n" && (offset === 0 || text[offset - 1] === "\n");
    define(Range.prototype, "getClientRects", function preRects(this: Range): DOMRect[] {
      if (this.startContainer !== node) return fakeClientRects.call(this);
      if (this.collapsed && isEmptyLineStart(this.startOffset)) return [];
      const isLineBreak = text[this.startOffset] === "\n";
      const length = this.collapsed || isLineBreak ? 0 : this.endOffset - this.startOffset;
      return [
        rect(
          box.left + columnOf(this.startOffset) * CHAR_WIDTH,
          screenTop(box) + lineOf(this.startOffset) * LINE_HEIGHT,
          length * CHAR_WIDTH,
          LINE_HEIGHT,
        ),
      ];
    });
    return node;
  }

  it("is a narrow mark at the start of that line", () => {
    preformatted("ab\n\ncd");

    enterAt("line-2", 3);

    expect(focusAt()).toBe("line-2:3");
    expect(copyModeUi().cursor).toEqual({
      left: TEXT_INSET,
      top: CONTENT_TOP + 3 * LINE_HEIGHT,
      width: CARET_WIDTH,
      height: LINE_HEIGHT,
    });
  });

  it("is on the second of two empty lines as well", () => {
    preformatted("ab\n\n\ncd");

    enterAt("line-2", 4);

    expect(copyModeUi().cursor?.top).toBe(CONTENT_TOP + 4 * LINE_HEIGHT);
  });

  it("is the block on a character as before on a line with text", () => {
    preformatted("ab\n\ncd");

    enterAt("line-2", 4);

    expect(copyModeUi().cursor).toEqual({
      left: TEXT_INSET,
      top: CONTENT_TOP + 4 * LINE_HEIGHT,
      width: CHAR_WIDTH,
      height: LINE_HEIGHT,
    });
  });
});

// As Chromium reports such a line: its element holds nothing and has no
// height, the place behind the line break in front of it has no rectangle,
// and the line break behind it has one without a width. Both places are on
// the empty line, and what is worked out for them differs by less than a
// pixel.
describe("an empty line of a code block that bb draws line by line", () => {
  const FONT_SIZE = 16;
  const LINE_TOP_OFFSET = 0.2;

  function lineTop(index: number): number {
    return CONTENT_TOP + index * LINE_HEIGHT - scrollTop;
  }

  // Empties the line and gives back the line break behind it.
  function emptyCodeLine(index: number): Text {
    const line = byId(`line-${index}`);
    const behind = line.nextSibling;
    if (!(behind instanceof Text)) throw new Error("the fixture line break is missing");
    line.textContent = "";
    line.style.fontSize = `${FONT_SIZE}px`;
    line.getBoundingClientRect = () =>
      rect(TEXT_INSET, lineTop(index) + LINE_TOP_OFFSET + FONT_SIZE * 0.9, PANE_WIDTH, 0);
    define(Range.prototype, "getClientRects", function emptyLineRects(this: Range): DOMRect[] {
      if (this.startContainer !== behind) return fakeClientRects.call(this);
      return this.collapsed ? [] : [rect(PANE_WIDTH, lineTop(index), 0, LINE_HEIGHT)];
    });
    nodeNames.set(behind, "break-behind");
    return behind;
  }

  // Chromium's word moves from a place on the empty line: forward to the
  // place behind the line break of that line, where the next line starts,
  // and back from there to the place in front of that line break.
  function wordStepsAsChromium(from: string, behind: Text, nextLine: string): void {
    stepsInto.set(`${from} forward word`, [behind, 1]);
    stepsInto.set("break-behind:1 backward word", [behind, 0]);
    stepsInto.set("break-behind:1 forward word", [textOf(nextLine), 3]);
  }

  function enterAtPlace(node: Node, offset: number): void {
    getSelection().setBaseAndExtent(textOf("line-3"), 0, node, offset);
    expect(enterCopyMode()).toBe(true);
  }

  function codeUnderHeaderWithEmptyFirstLine(): { pre: Element; behind: Text } {
    const pre = codeBlockUnderHeader(5, 9).nextElementSibling;
    const code = pre?.firstElementChild;
    if (pre === null || code === null || code === undefined) throw new Error("the fixture code is missing");
    const behind = emptyCodeLine(6);
    code.getBoundingClientRect = () =>
      rect(TEXT_INSET, lineTop(6), PANE_WIDTH, 4 * LINE_HEIGHT);
    nodeNames.set(pre, "code-box");
    return { pre, behind };
  }

  it.each<ModeKeys>(["vi", "emacs"])(
    "goes from the empty line on to the first word of the next line on a next word move with tmux's %s keys, and does not stay on the line for a press",
    (modeKeys) => {
      useModeKeys(modeKeys);
      codeBlock(4, 9);
      const behind = emptyCodeLine(5);
      const inFront = byId("line-5").previousSibling;
      if (!(inFront instanceof Text)) throw new Error("the fixture line break is missing");
      nodeNames.set(inFront, "break-in-front");
      enterAtPlace(inFront, 1);
      expect(copyModeUi().cursor?.top).toBeCloseTo(lineTop(5) + LINE_TOP_OFFSET);
      wordStepsAsChromium("break-in-front:1", behind, "line-6");

      moveCopyCursor("word-forward");

      expect(focusAt()).toBe("line-6:0");
      expect(copyModeUi().cursor).toEqual(blockAt(6, 0));
    },
  );

  it.each([
    ["the code", 0],
    ["the box that holds the code", 1],
  ])("draws the cursor on the empty first line of a code block, as high as that line, at the place in front of %s", (_name, depth) => {
    const { pre } = codeUnderHeaderWithEmptyFirstLine();
    const frame = pre.parentElement;
    if (frame === null) throw new Error("the fixture frame is missing");
    pre.getBoundingClientRect = () =>
      rect(TEXT_INSET, lineTop(6), PANE_WIDTH, 4 * LINE_HEIGHT);

    enterAtPlace(depth === 0 ? pre : frame, depth);

    const cursor = copyModeUi().cursor;
    expect(cursor).toMatchObject({ left: TEXT_INSET, width: CARET_WIDTH });
    expect(cursor?.top).toBeCloseTo(lineTop(6) + LINE_TOP_OFFSET);
    expect(cursor?.height).toBeCloseTo(FONT_SIZE * 1.2);
  });

  it("draws the cursor as high as the element in front of one that starts with an empty element that has a height, as a picture has", () => {
    mountThread({
      extraRowsHtml: `
        <div data-timeline-row-id="row-figure"><div id="figure"><span id="picture" style="display: inline-block; font-size: ${FONT_SIZE}px"></span><span>caption</span></div></div>`,
    });
    const figure = byId("figure");
    const top = CONTENT_TOP - 3 * LINE_HEIGHT;
    figure.getBoundingClientRect = () => rect(TEXT_INSET, top, PANE_WIDTH, 3 * LINE_HEIGHT);
    byId("picture").getBoundingClientRect = () => rect(TEXT_INSET, top, 60, 2 * LINE_HEIGHT);
    const row = figure.parentElement;
    if (row === null) throw new Error("the fixture row is missing");

    enterAtPlace(row, 0);

    expect(copyModeUi().cursor).toEqual({
      left: TEXT_INSET,
      top,
      width: CARET_WIDTH,
      height: 3 * LINE_HEIGHT,
    });
  });

  it("goes from the place in front of such a code block on to the first word of its second line on a next word move", () => {
    const { pre, behind } = codeUnderHeaderWithEmptyFirstLine();
    enterAtPlace(pre, 0);
    wordStepsAsChromium("code-box:0", behind, "line-7");

    moveCopyCursor("word-forward");

    expect(focusAt()).toBe("line-7:0");
    expect(copyModeUi().cursor).toEqual(blockAt(7, 0));
  });

  // Chromium takes longer for its step by a paragraph the longer such a
  // block is, and tmux goes to the next empty line of the code.
  describe("the paragraph keys in such a code block, which make no move of the browser", () => {
    let behind: Text;

    beforeEach(() => {
      codeBlock(3, 9);
      behind = emptyCodeLine(6);
    });

    function onEmptyLine(): CursorRect {
      return { left: TEXT_INSET, top: lineTop(6), width: CARET_WIDTH, height: LINE_HEIGHT };
    }

    it.each<ModeKeys>(["vi", "emacs"])(
      "go forward to the empty line behind the lines of the cursor with tmux's %s keys",
      (modeKeys) => {
        useModeKeys(modeKeys);
        enterAt("line-4", 5);

        moveCopyCursor("paragraph-forward");

        expect(getSelection().focusNode).toBe(behind);
        expect(focusAt()).toBe("break-behind:0");
        expect(copyModeUi().cursor).toEqual(onEmptyLine());
        expect(modifyCalls).toEqual([]);
      },
    );

    it("go back to the empty line in front of the lines of the cursor", () => {
      enterAt("line-8", 4);

      moveCopyCursor("paragraph-back");

      expect(focusAt()).toBe("break-behind:0");
      expect(copyModeUi().cursor).toEqual(onEmptyLine());
      expect(modifyCalls).toEqual([]);
    });

    it("go on from the empty line to the start of the text behind the block, where no empty line follows", () => {
      enterAt("line-4", 5);
      moveCopyCursor("paragraph-forward");

      moveCopyCursor("paragraph-forward");

      expect(focusAt()).toBe("line-10:0");
      expect(copyModeUi().cursor).toEqual(blockAt(10, 0));
      expect(modifyCalls).toEqual([]);
    });

    it("go back from the empty line to the start of the paragraph in front of the block, where no empty line comes before", () => {
      enterAt("line-8", 4);
      moveCopyCursor("paragraph-back");

      moveCopyCursor("paragraph-back");

      expect(focusAt()).toBe("line-2:0");
      expect(modifyCalls).toEqual(["extend backward paragraphboundary"]);
    });

    it("pass over a line that holds blanks only as over an empty one", () => {
      textOf("line-4").data = "   ";
      enterAt("line-3", 2);

      moveCopyCursor("paragraph-forward");
      expect(focusAt()).toBe("line-4:0");

      moveCopyCursor("paragraph-forward");
      expect(focusAt()).toBe("break-behind:0");
    });

    it("extend a selection to the empty line", () => {
      enterAt("line-4", 5);
      beginCopySelection();

      moveCopyCursor("paragraph-forward");

      expect(anchorAt()).toBe("line-4:5");
      expect(focusAt()).toBe("break-behind:0");
      expect(getSelection().toString()).toBe(" text\nrow 5 text\n");
      expect(modifyCalls).toEqual([]);
    });

    it("leave a block without an empty line in one press, to the start of the text behind it", () => {
      byId("line-6").textContent = "now with text";
      enterAt("line-4", 5);

      moveCopyCursor("paragraph-forward");

      expect(focusAt()).toBe("line-10:0");
      expect(modifyCalls).toEqual([]);
    });

    it("go on from a last line of blanks to the text behind the block, and do not stay on that line", () => {
      textOf("line-9").data = "   ";
      enterAt("line-8", 2);

      moveCopyCursor("paragraph-forward");
      expect(focusAt()).toBe("line-9:0");

      moveCopyCursor("paragraph-forward");
      expect(focusAt()).toBe("line-10:0");
      expect(modifyCalls).toEqual([]);

      moveCopyCursor("paragraph-forward");
      expect(focusAt()).toBe("line-11:0");
    });

    it("go on from a first line of blanks to the paragraph in front of the block, and do not stay on that line", () => {
      textOf("line-3").data = "   ";
      enterAt("line-4", 2);

      moveCopyCursor("paragraph-back");
      expect(focusAt()).toBe("line-3:0");

      moveCopyCursor("paragraph-back");
      expect(focusAt()).toBe("line-2:0");

      moveCopyCursor("paragraph-back");
      expect(focusAt()).toBe("line-1:0");
    });
  });

  it("goes to the end of the last line of a code block that the conversation ends with on a next paragraph move, without a move of the browser", () => {
    mountThread({ lineCount: 8 });
    codeBlock(4, 7);
    enterAt("line-5", 2);

    moveCopyCursor("paragraph-forward");

    expect(focusAt()).toBe("line-7:10");
    expect(copyModeUi().cursor).toEqual(caretAt(7, 10));
    expect(modifyCalls).toEqual([]);
  });

  it("goes to the start of the first line of a code block that the conversation starts with on a previous paragraph move, without a move of the browser", () => {
    mountThread({ lineCount: 8 });
    codeBlock(0, 3);
    enterAt("line-2", 4);

    moveCopyCursor("paragraph-back");

    expect(focusAt()).toBe("line-0:0");
    expect(modifyCalls).toEqual([]);
  });

  it("makes the browser's step by a paragraph from a box inside a paragraph, which is no line of a code block", () => {
    const line = byId("line-4");
    const formula = document.createElement("span");
    formula.id = "formula";
    formula.style.display = "inline-block";
    formula.textContent = "x squared";
    line.append(formula, " and more");
    const lineBox = boxes.get(textOf("line-4"));
    if (lineBox === undefined) throw new Error("the fixture line has no box");
    boxes.set(textOf("formula"), { ...lineBox, left: lineBox.left + 12 * CHAR_WIDTH });
    enterAt("formula", 2);

    moveCopyCursor("paragraph-forward");

    expect(modifyCalls[0]).toBe("extend forward paragraph");
  });

  it("makes the browser's step by a paragraph from the boxes of a formula, which have nothing between them and are not in a code block", () => {
    const line = byId("line-4");
    const formula = document.createElement("span");
    formula.innerHTML = `<span id="base-1" style="display: inline-block">x squared</span><span id="base-2" style="display: inline-block">plus y</span>`;
    line.append(formula, " and more");
    const lineBox = boxes.get(textOf("line-4"));
    if (lineBox === undefined) throw new Error("the fixture line has no box");
    boxes.set(textOf("base-1"), { ...lineBox, left: lineBox.left + 12 * CHAR_WIDTH });
    boxes.set(textOf("base-2"), { ...lineBox, left: lineBox.left + 22 * CHAR_WIDTH });
    enterAt("base-1", 2);

    moveCopyCursor("paragraph-forward");

    expect(modifyCalls[0]).toBe("extend forward paragraph");
  });
});

// The header holds the name of the language and two buttons. A browser walks
// into it like into any other text, and bb leaves it out of a copy.
describe("the header that bb draws above a code block", () => {
  function visit(motions: readonly CopyMotion[]): string[] {
    return motions.map((motion) => {
      moveCopyCursor(motion);
      return focusAt();
    });
  }

  describe.each<ModeKeys>(["vi", "emacs"])("with tmux's %s keys", (modeKeys) => {
    beforeEach(() => {
      useModeKeys(modeKeys);
      codeBlockUnderHeader(5, 9);
    });

    it("goes from the end of the text in front of the block to the first character of the code", () => {
      enterAt("line-4", 10);

      moveCopyCursor("char-right");

      expect(focusAt()).toBe("line-6:0");
      expect(copyModeUi().cursor).toEqual(blockAt(6, 0));
    });

    it("goes from the first character of the code back to the end of the text in front of the block", () => {
      enterAt("line-6", 0);

      moveCopyCursor("char-left");

      expect(focusAt()).toBe("line-4:10");
      expect(copyModeUi().cursor).toEqual(caretAt(4, 10));
    });

    it("walks into the block and out of it again by characters without a stop in the header", () => {
      enterAt("line-4", 8);

      expect(visit(["char-right", "char-right", "char-right", "char-right"])).toEqual([
        "line-4:9",
        "line-4:10",
        "line-6:0",
        "line-6:1",
      ]);
      expect(visit(["char-left", "char-left", "char-left"])).toEqual([
        "line-6:0",
        "line-4:10",
        "line-4:9",
      ]);
    });

    it("passes over the header on a move down and on a move up, and keeps the column", () => {
      enterAt("line-4", 7);

      expect(visit(["line-down", "line-down", "line-up", "line-up"])).toEqual([
        "line-6:7",
        "line-7:7",
        "line-6:7",
        "line-4:7",
      ]);
    });

    it("takes a page key over the header, as far down as the view scrolls", () => {
      enterAt("line-2", 3);

      moveCopyCursor("half-page-down");

      expect(focusAt()).toBe("line-10:3");
    });

    it("goes by words into the block and out of it without a stop in the header", () => {
      enterAt("line-4", 6);

      expect(visit(["word-forward", "word-forward", "word-forward"])).toEqual([
        "line-4:10",
        "line-6:0",
        "line-6:4",
      ]);
      expect(visit(["word-back", "word-back", "word-back"])).toEqual([
        "line-6:0",
        "line-4:10",
        "line-4:6",
      ]);
    });

    it("goes by paragraphs to the first character of the code, and back to the start of the text in front of the block", () => {
      enterAt("line-4", 3);

      moveCopyCursor("paragraph-forward");
      expect(focusAt()).toBe("line-6:0");

      moveCopyCursor("paragraph-back");
      expect(focusAt()).toBe("line-4:0");
    });

    it("never ends a selection in the header", () => {
      enterAt("line-4", 8);
      beginCopySelection();

      const ends = visit(["char-right", "char-right", "char-right"]);

      expect(anchorAt()).toBe("line-4:8");
      expect(ends).toEqual(
        modeKeys === "vi"
          ? ["line-4:10", "line-4:10", "line-6:1"]
          : ["line-4:9", "line-4:10", "line-6:0"],
      );
    });

    it("extends a selection by lines over the header and back", () => {
      enterAt("line-4", 2);
      beginCopySelection();

      const ends = visit(["line-down", "line-down", "line-up", "line-up"]);

      expect(anchorAt()).toBe("line-4:2");
      expect(ends).toEqual(
        modeKeys === "vi"
          ? ["line-6:3", "line-7:3", "line-6:3", "line-4:3"]
          : ["line-6:2", "line-7:2", "line-6:2", "line-4:2"],
      );
    });

    it("goes on to the code from a step that ends on a button of the header", () => {
      const button = byId("line-5").nextElementSibling?.firstElementChild;
      if (!(button instanceof HTMLButtonElement)) throw new Error("the fixture button is missing");
      enterAt("line-4", 10);
      stepsInto.set("line-4:10 right character", [button, 0]);

      moveCopyCursor("char-right");

      expect(focusAt()).toBe("line-6:0");
    });
  });

  it("goes on to the second word of the code on the next word move, where Chromium gives the start of the first word as the place in front of the code as well", () => {
    const header = codeBlockUnderHeader(5, 9);
    const code = header.nextElementSibling;
    if (code === null) throw new Error("the fixture code is missing");
    enterAt("line-4", 10);
    stepsInto.set("line-6:3 backward word", [code, 0]);

    moveCopyCursor("word-forward");
    expect(getSelection().focusNode).toBe(code);
    expect(copyModeUi().cursor).toEqual(blockAt(6, 0));
    stepsInto.clear();

    moveCopyCursor("word-forward");
    expect(focusAt()).toBe("line-6:4");
  });

  it("goes with tmux's vi keys from the last character in front of the block onto the last character of the first word of the code", () => {
    useModeKeys("vi");
    doesWordMoveStopAtTextStart = true;
    codeBlockUnderHeader(5, 9);
    enterAt("line-4", 9);

    moveCopyCursor("word-end");

    expect(focusAt()).toBe("line-6:2");
  });

  it("goes with tmux's emacs keys from the end of the text in front of the block to the end of the first word of the code", () => {
    doesWordMoveStopAtTextStart = true;
    codeBlockUnderHeader(5, 9);
    enterAt("line-4", 10);

    moveCopyCursor("word-end");

    expect(focusAt()).toBe("line-6:3");
  });

  it("goes to the first character of the code on the move to the start of a conversation that starts with a code block", () => {
    codeBlockUnderHeader(0, 3);
    enterAt("line-8", 2);

    moveCopyCursor("document-start");

    expect(focusAt()).toBe("line-1:0");
  });

  it("stays on the first line of the code on a move up when nothing is in front of the block", () => {
    codeBlockUnderHeader(0, 3);
    enterAt("line-1", 2);

    moveCopyCursor("line-up");

    expect(focusAt()).toBe("line-1:2");
    expect(copyModeUi().cursor).toEqual(blockAt(1, 2));
  });

  it.each<CopyMotion>(["char-left", "word-back", "paragraph-back"])(
    "stays on the first character of the code on %s when nothing is in front of the block",
    (motion) => {
      codeBlockUnderHeader(0, 3);
      enterAt("line-1", 0);

      moveCopyCursor(motion);

      expect(focusAt()).toBe("line-1:0");
      expect(copyModeUi().cursor).toEqual(blockAt(1, 0));
    },
  );

  it("starts copy mode on the line above when the header is the last line that shows", () => {
    codeBlockUnderHeader(13, 16);

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe("line-12:0");
  });

  it("goes to the line above the header on the move to the last line on screen", () => {
    codeBlockUnderHeader(13, 16);
    enterAt("line-3", 2);

    moveCopyCursor("screen-bottom");

    expect(focusAt()).toBe("line-12:0");
  });

  it("does not start copy mode at a selection that ends in the header", () => {
    codeBlockUnderHeader(5, 9);
    getSelection().setBaseAndExtent(textOf("line-4"), 2, textOf("line-5"), 1);

    expect(enterCopyMode()).toBe(true);

    expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
  });

  it("draws no cursor block on the name of the language from the end of the text in front of the block", () => {
    useModeKeys("vi");
    const header = codeBlockUnderHeader(5, 9);
    const text = textOf("line-4");
    const top = CONTENT_TOP + 4 * LINE_HEIGHT;
    boxes.set(textOf("line-5"), {
      top,
      left: TEXT_INSET + text.length * CHAR_WIDTH,
      columnLeft: 0,
      isFixed: false,
    });
    expect(header.contains(textOf("line-5"))).toBe(true);

    enterAt("line-4", 10);

    expect(copyModeUi().cursor).toEqual(caretAt(4, 10));
  });
});

// The label is no text of the conversation, and the cursor is kept out of it
// as it is kept out of the header of a code block.
describe.each(["Show more", "Show less"] as const)(
  "the button under a long message of the user, with the label %s",
  (label) => {
    function visit(motions: readonly CopyMotion[]): string[] {
      return motions.map((motion) => {
        moveCopyCursor(motion);
        return focusAt();
      });
    }

    describe.each<ModeKeys>(["vi", "emacs"])("with tmux's %s keys", (modeKeys) => {
      beforeEach(() => {
        useModeKeys(modeKeys);
        messageWithToggle(byId("line-4"), 5, label);
      });

      it("goes from the end of the message to the first character of the text behind the button", () => {
        enterAt("line-4", 10);

        moveCopyCursor("char-right");

        expect(focusAt()).toBe("line-6:0");
        expect(copyModeUi().cursor).toEqual(blockAt(6, 0));
      });

      it("goes from the first character behind the button back to the end of the message", () => {
        enterAt("line-6", 0);

        moveCopyCursor("char-left");

        expect(focusAt()).toBe("line-4:10");
        expect(copyModeUi().cursor).toEqual(caretAt(4, 10));
      });

      it("walks past the button by characters, forward and back, without a stop in its label", () => {
        enterAt("line-4", 8);

        expect(visit(["char-right", "char-right", "char-right", "char-right"])).toEqual([
          "line-4:9",
          "line-4:10",
          "line-6:0",
          "line-6:1",
        ]);
        expect(visit(["char-left", "char-left", "char-left"])).toEqual([
          "line-6:0",
          "line-4:10",
          "line-4:9",
        ]);
      });

      it("passes over the button on a move down and on a move up, and keeps the column", () => {
        enterAt("line-4", 7);

        expect(visit(["line-down", "line-down", "line-up", "line-up"])).toEqual([
          "line-6:7",
          "line-7:7",
          "line-6:7",
          "line-4:7",
        ]);
      });

      it("goes by words past the button without a stop in its label", () => {
        enterAt("line-4", 6);

        expect(visit(["word-forward", "word-forward", "word-forward"])).toEqual([
          "line-4:10",
          "line-6:0",
          "line-6:4",
        ]);
        expect(visit(["word-back", "word-back", "word-back"])).toEqual([
          "line-6:0",
          "line-4:10",
          "line-4:6",
        ]);
      });

      it("goes by paragraphs to the first character behind the button, and back to the start of the message", () => {
        enterAt("line-4", 3);

        moveCopyCursor("paragraph-forward");
        expect(focusAt()).toBe("line-6:0");

        moveCopyCursor("paragraph-back");
        expect(focusAt()).toBe("line-4:0");
      });

      it("never ends a selection in the label", () => {
        enterAt("line-4", 8);
        beginCopySelection();

        const ends = visit(["char-right", "char-right", "char-right"]);

        expect(anchorAt()).toBe("line-4:8");
        expect(ends).toEqual(
          modeKeys === "vi"
            ? ["line-4:10", "line-4:10", "line-6:1"]
            : ["line-4:9", "line-4:10", "line-6:0"],
        );
      });

      it("extends a selection by lines over the button and back", () => {
        enterAt("line-4", 2);
        beginCopySelection();

        const ends = visit(["line-down", "line-down", "line-up", "line-up"]);

        expect(anchorAt()).toBe("line-4:2");
        expect(ends).toEqual(
          modeKeys === "vi"
            ? ["line-6:3", "line-7:3", "line-6:3", "line-4:3"]
            : ["line-6:2", "line-7:2", "line-6:2", "line-4:2"],
        );
      });

      it("goes on to the text behind the button from a step that ends on the button itself, as Chromium's does", () => {
        enterAt("line-4", 10);
        stepsInto.set("line-4:10 right character", [byId("toggle"), 0]);

        moveCopyCursor("char-right");

        expect(focusAt()).toBe("line-6:0");
      });
    });

    it("goes with tmux's vi keys from the last character of the message onto the last character of the first word behind the button", () => {
      useModeKeys("vi");
      doesWordMoveStopAtTextStart = true;
      messageWithToggle(byId("line-4"), 5, label);
      enterAt("line-4", 9);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe("line-6:2");
    });

    it("goes with tmux's emacs keys from the end of the message to the end of the first word behind the button", () => {
      doesWordMoveStopAtTextStart = true;
      messageWithToggle(byId("line-4"), 5, label);
      enterAt("line-4", 10);

      moveCopyCursor("word-end");

      expect(focusAt()).toBe("line-6:3");
    });

    it("goes to the end of the message on the move to the end of a conversation that ends with the button", () => {
      messageWithToggle(byId("line-18"), 19, label);
      scrollTop = 200;
      enterAt("line-12", 3);

      moveCopyCursor("document-end");

      expect(focusAt()).toBe("line-18:11");
    });

    it("stays on the last line of the message on a move down when nothing is behind the button", () => {
      messageWithToggle(byId("line-18"), 19, label);
      scrollTop = 200;
      enterAt("line-18", 2);

      moveCopyCursor("line-down");

      expect(focusAt()).toBe("line-18:2");
      expect(copyModeUi().cursor).toEqual(blockAt(18, 2));
    });

    it("starts copy mode on the line above when the button is the last line that shows", () => {
      messageWithToggle(byId("line-12"), 13, label);

      expect(enterCopyMode()).toBe(true);

      expect(focusAt()).toBe("line-12:0");
    });

    it("goes to the line above the button on the move to the last line on screen", () => {
      messageWithToggle(byId("line-12"), 13, label);
      enterAt("line-3", 2);

      moveCopyCursor("screen-bottom");

      expect(focusAt()).toBe("line-12:0");
    });

    it("does not start copy mode at a selection that ends in the label", () => {
      const toggle = messageWithToggle(byId("line-4"), 5, label);
      getSelection().setBaseAndExtent(textOf("line-4"), 2, toggle.firstChild as Text, 1);

      expect(enterCopyMode()).toBe(true);

      expect(focusAt()).toBe(`${LAST_VISIBLE_LINE}:0`);
    });
  },
);

describe("the button under a long message of the user that bb shows cut short", () => {
  // The lines that bb cuts off are in the page, between the lines that show
  // and the button.
  function collapsedMessage(): void {
    const box = document.createElement("div");
    box.style.overflowY = "hidden";
    byId("line-5").closest("[data-timeline-row-id]")?.before(box);
    for (let index = 5; index <= 9; index += 1) box.append(byId(`line-${index}`));
    box.getBoundingClientRect = () =>
      rect(0, CONTENT_TOP + 5 * LINE_HEIGHT - scrollTop, PANE_WIDTH, 2 * LINE_HEIGHT);
    define(box, "clientWidth", PANE_WIDTH);
    define(box, "clientHeight", 2 * LINE_HEIGHT);
    define(box, "scrollHeight", 5 * LINE_HEIGHT);
    define(box, "scrollWidth", PANE_WIDTH);
    messageWithToggle(box, 10, "Show more");
  }

  it.each([
    ["line-down", "line-6", 3, "line-11:3"],
    ["char-right", "line-6", 10, "line-11:0"],
    ["word-forward", "line-6", 10, "line-11:0"],
    ["paragraph-forward", "line-6", 4, "line-11:0"],
    ["line-up", "line-11", 3, "line-6:3"],
    ["char-left", "line-11", 0, "line-6:10"],
  ] as const)(
    "passes over the hidden lines and the button on %s",
    (motion, line, offset, reached) => {
      collapsedMessage();
      enterAt(line, offset);

      moveCopyCursor(motion);

      expect(focusAt()).toBe(reached);
    },
  );

  // bb keeps up to 4096 characters of such a message in the page
  // (USER_MESSAGE_CHAR_CAP in conversation-message-limits.ts), so the lines
  // that it cuts off can hold thousands of them.
  describe.each([
    ["2700 characters", 900],
    ["4074 characters, with the lines that show nearly all that bb keeps", 1358],
  ])("with %s in the hidden lines", (_name, hiddenLineLength) => {
    describe.each<ModeKeys>(["vi", "emacs"])("with tmux's %s keys", (modeKeys) => {
      beforeEach(() => {
        useModeKeys(modeKeys);
        collapsedMessage();
        for (const index of [7, 8, 9]) {
          textOf(`line-${index}`).data = "x".repeat(hiddenLineLength);
        }
      });

      it.each([
        ["line-down", "line-6", 3, "line-11:3"],
        ["line-up", "line-11", 3, "line-6:3"],
        ["half-page-down", "line-5", 3, "line-11:3"],
        ["half-page-up", "line-11", 3, "line-3:3"],
      ] as const)(
        "passes over the hidden lines and the button on %s, and keeps the column",
        (motion, line, offset, reached) => {
          enterAt(line, offset);

          moveCopyCursor(motion);

          expect(focusAt()).toBe(reached);
        },
      );

      it("goes down and up again over the hidden lines with a selection under way", () => {
        enterAt("line-6", 3);
        beginCopySelection();

        moveCopyCursor("line-down");
        const below = focusAt();
        moveCopyCursor("line-up");

        expect(anchorAt()).toBe("line-6:3");
        expect([below, focusAt()]).toEqual(
          modeKeys === "vi" ? ["line-11:4", "line-6:4"] : ["line-11:3", "line-6:3"],
        );
      });
    });
  });

  // The look through hidden text has an end, so that a text that a box of bb
  // hides and that is far longer than a message does not cost more than one.
  it.each([
    ["line-down", "line-6"],
    ["line-up", "line-11"],
  ] as const)(
    "gives up on %s after a look with an end when the hidden lines hold far more characters than bb keeps of a message",
    (motion, line) => {
      collapsedMessage();
      for (const index of [7, 8, 9]) textOf(`line-${index}`).data = "x".repeat(10000);
      enterAt(line, 3);
      const measured = vi.spyOn(Range.prototype, "getClientRects");

      moveCopyCursor(motion);

      expect(focusAt()).toBe(`${line}:3`);
      expect(measured.mock.calls.length).toBeLessThan(10000);
    },
  );
});

// As bb 0.50.1 draws a message of the user with several lines: one
// paragraph, with a line break element and a line break behind each line. As
// Chromium reports it, that line break has a rectangle without a width at
// the start of the line that follows, and is not drawn.
describe("a move up from the text behind the button onto a line of the message that follows a line break", () => {
  const MESSAGE_LEFT = 400;
  // The first line that the fixture shows. The label is drawn to the right
  // of it here, which no lookup of a line minds.
  const LAST_LINE_TOP = CONTENT_TOP - LINE_HEIGHT;

  function messageOfTwoLines(): Text {
    mountThread({
      extraRowsHtml: `
        <div data-timeline-row-id="row-said"><div data-message-column=""><div><div><div><p id="said">one two<br>
three four</p></div><div><button type="button" id="said-toggle" aria-expanded="false">Show more</button></div></div></div></div></div>`,
    });
    const lastLine = byId("said").lastChild;
    if (!(lastLine instanceof Text)) throw new Error("the fixture line is missing");
    nodeNames.set(lastLine, "said-last");
    boxes.set(textOf("said"), {
      top: LAST_LINE_TOP - LINE_HEIGHT,
      left: MESSAGE_LEFT,
      columnLeft: 0,
      isFixed: false,
    });
    boxes.set(textOf("said-toggle"), {
      top: LAST_LINE_TOP,
      left: 600,
      columnLeft: 0,
      isFixed: false,
    });
    const drawnFrom = (offset: number): number =>
      MESSAGE_LEFT + Math.max(0, offset - 1) * CHAR_WIDTH;
    define(Range.prototype, "getClientRects", function messageRects(this: Range): DOMRect[] {
      if (this.startContainer !== lastLine) return fakeClientRects.call(this);
      const left = drawnFrom(this.startOffset);
      const right = this.collapsed ? left : drawnFrom(this.endOffset);
      return [rect(left, LAST_LINE_TOP - scrollTop, right - left, LINE_HEIGHT)];
    });
    return lastLine;
  }

  it.each<ModeKeys>(["vi", "emacs"])(
    "lands on the first character of that line with tmux's %s keys when the column is left of the message, and not in front of the line break",
    (modeKeys) => {
      useModeKeys(modeKeys);
      messageOfTwoLines();
      enterAt("line-0", 3);

      moveCopyCursor("line-up");

      expect(focusAt()).toBe("said-last:1");
      expect(copyModeUi().cursor).toEqual({
        left: MESSAGE_LEFT,
        top: LAST_LINE_TOP - scrollTop,
        width: CHAR_WIDTH,
        height: LINE_HEIGHT,
      });
    },
  );

  it("still lands at the column of the move when that is inside the line", () => {
    messageOfTwoLines();
    textOf("line-0").data = "x".repeat(70);
    enterAt("line-0", 48);

    moveCopyCursor("line-up");

    expect(focusAt()).toBe("said-last:4");
  });
});

describe("a button of bb that is not the one under a long message", () => {
  it("holds the cursor on its text, as the header of the row of a tool call, which says whether the row is expanded", () => {
    const header = document.createElement("button");
    header.type = "button";
    header.setAttribute("aria-expanded", "false");
    byId("line-5").before(header);
    header.append(byId("line-5"));
    enterAt("line-4", 10);

    moveCopyCursor("char-right");

    expect(focusAt()).toBe("line-5:0");
    expect(copyModeUi().cursor).toEqual(blockAt(5, 0));
  });

  it("holds the cursor on its text inside a message when it opens a menu", () => {
    const column = document.createElement("div");
    column.setAttribute("data-message-column", "");
    const menu = document.createElement("button");
    menu.type = "button";
    menu.setAttribute("aria-expanded", "false");
    menu.setAttribute("aria-haspopup", "menu");
    byId("line-5").before(column);
    column.append(menu);
    menu.append(byId("line-5"));
    enterAt("line-4", 10);

    moveCopyCursor("char-right");

    expect(focusAt()).toBe("line-5:0");
  });
});

// In Chromium the step back from the start of such a line stops behind the
// box of the line before, at the line break between the two boxes, where no
// cursor can be shown. The step that is made again from there lands on the
// last character of that line.
describe("a step back by a character in a code block that bb draws line by line", () => {
  function stepBackAsChromium(): void {
    const lineBreak = byId("line-5").nextSibling;
    if (!(lineBreak instanceof Text)) throw new Error("the fixture line break is missing");
    stepsInto.set("line-6:0 left character", [lineBreak, 0]);
    stepsInto.set(":0 left character", [textOf("line-5"), 9]);
  }

  it.each<ModeKeys>(["vi", "emacs"])(
    "stops at the end of the line before with tmux's %s keys, where the step forward stops as well",
    (modeKeys) => {
      useModeKeys(modeKeys);
      codeBlock(4, 9);
      stepBackAsChromium();
      enterAt("line-6", 0);

      moveCopyCursor("char-left");
      expect(focusAt()).toBe("line-5:10");
      expect(copyModeUi().cursor).toEqual(caretAt(5, 10));

      moveCopyCursor("char-left");
      expect(focusAt()).toBe("line-5:9");
      expect(copyModeUi().cursor).toEqual(blockAt(5, 9));
    },
  );

  it("visits the same places on the way back as on the way forward", () => {
    codeBlock(4, 9);
    stepBackAsChromium();
    enterAt("line-5", 8);
    const forward = [focusAt()];
    for (let press = 0; press < 3; press += 1) {
      moveCopyCursor("char-right");
      forward.push(focusAt());
    }
    const back = [focusAt()];
    for (let press = 0; press < 3; press += 1) {
      moveCopyCursor("char-left");
      back.push(focusAt());
    }

    expect(forward).toEqual(["line-5:8", "line-5:9", "line-5:10", "line-6:0"]);
    expect(back).toEqual(forward.slice().reverse());
  });

  it("extends a selection back to the end of the line before, without its last character", () => {
    codeBlock(4, 9);
    stepBackAsChromium();
    enterAt("line-6", 3);
    beginCopySelection();
    for (let press = 0; press < 4; press += 1) moveCopyCursor("char-left");

    expect(focusAt()).toBe("line-5:10");
    expect(getSelection().toString()).toBe("\nrow");
  });

  it("stays on the last character of the line before where the place behind it cannot hold the cursor, as where a box cuts that character off in part", () => {
    codeBlock(4, 9);
    stepBackAsChromium();
    const line = byId("line-5");
    const width = TEXT_INSET + textOf("line-5").length * CHAR_WIDTH - CHAR_WIDTH / 2;
    line.style.overflowX = "hidden";
    line.getBoundingClientRect = () =>
      rect(0, CONTENT_TOP + 5 * LINE_HEIGHT, width, LINE_HEIGHT);
    define(line, "clientWidth", width);
    define(line, "clientHeight", LINE_HEIGHT);
    enterAt("line-6", 0);

    moveCopyCursor("char-left");

    expect(focusAt()).toBe("line-5:9");
    expect(copyModeUi().cursor).toEqual(blockAt(5, 9));
  });

  it("leaves a step alone that lands on a character with no line break behind it, as at the place where a long line is wrapped", () => {
    mountThread({
      extraRowsHtml: `
        <div data-timeline-row-id="row-wrapped"><p id="wrapped" style="display: inline-block">one<b id="wrapped-on">two</b></p></div>`,
    });
    const top = CONTENT_TOP + 2 * LINE_HEIGHT;
    boxes.set(textOf("wrapped"), { top, left: 300, columnLeft: 0, isFixed: false });
    boxes.set(textOf("wrapped-on"), { top: top + LINE_HEIGHT, left: 300, columnLeft: 0, isFixed: false });
    stepsInto.set("wrapped-on:0 left character", [textOf("wrapped"), 2]);
    enterAt("wrapped-on", 0);

    moveCopyCursor("char-left");

    expect(focusAt()).toBe("wrapped:2");
  });
});

// Measuring the characters of a line one by one takes Chromium milliseconds
// for every 1000 of them.
describe("a line of code that is thousands of characters long, in a box of its own", () => {
  const LONG = 5000;

  function measurements(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(Range.prototype, "getClientRects");
  }

  // The scroller as wide as the longest line, so that a place far to the
  // right in a line counts as on screen.
  function widenViewport(): void {
    byId("viewport").getBoundingClientRect = () =>
      rect(0, VIEWPORT_TOP, TEXT_INSET + (LONG + 1) * CHAR_WIDTH, VIEWPORT_HEIGHT);
  }

  it("goes down from such a line without measuring its characters and without asking the browser", () => {
    codeBlock(4, 9);
    textOf("line-5").data = "x".repeat(LONG);
    enterAt("line-5", 3);
    const measured = measurements();

    moveCopyCursor("line-down");

    expect(focusAt()).toBe("line-6:3");
    expect(modifyCalls).toEqual([]);
    expect(measured.mock.calls.length).toBeLessThan(100);
  });

  it("goes up onto such a line at the column of the move, without measuring its characters", () => {
    codeBlock(4, 9);
    textOf("line-5").data = "x".repeat(LONG);
    enterAt("line-6", 3);
    const measured = measurements();

    moveCopyCursor("line-up");

    expect(focusAt()).toBe("line-5:3");
    expect(modifyCalls).toEqual([]);
    expect(measured.mock.calls.length).toBeLessThan(100);
  });

  it("goes up onto such a line that is the first text of the conversation, without measuring its characters", () => {
    mountThread({
      extraRowsHtml: `
        <code><p id="first-line" style="display: inline-block">${"x".repeat(LONG)}</p>
</code>`,
    });
    boxes.set(textOf("first-line"), {
      top: CONTENT_TOP - LINE_HEIGHT,
      left: TEXT_INSET,
      columnLeft: 0,
      isFixed: false,
    });
    byId("line-0").style.display = "inline-block";
    enterAt("line-0", 3);
    const measured = measurements();

    moveCopyCursor("line-up");

    expect(focusAt()).toBe("first-line:3");
    expect(measured.mock.calls.length).toBeLessThan(100);
  });

  it("goes up from such a line, from far to the right in it", () => {
    codeBlock(4, 9);
    textOf("line-5").data = "x".repeat(LONG);
    widenViewport();
    enterAt("line-5", 3000);
    const measured = measurements();

    moveCopyCursor("line-up");

    expect(focusAt()).toBe("line-4:10");
    expect(modifyCalls).toEqual([]);
    expect(measured.mock.calls.length).toBeLessThan(100);
  });

  it("keeps a column that is far to the right between two such lines, down and up", () => {
    codeBlock(4, 9);
    textOf("line-5").data = "x".repeat(LONG);
    textOf("line-6").data = "y".repeat(LONG);
    widenViewport();
    enterAt("line-5", 3000);
    const measured = measurements();

    moveCopyCursor("line-down");
    expect(focusAt()).toBe("line-6:3000");

    moveCopyCursor("line-up");
    expect(focusAt()).toBe("line-5:3000");
    expect(modifyCalls).toEqual([]);
    expect(measured.mock.calls.length).toBeLessThan(200);
  });

  it("comes back to the end of such a line after a shorter line", () => {
    codeBlock(4, 9);
    textOf("line-5").data = "x".repeat(LONG);
    enterAt("line-5", 3);
    moveCopyCursor("line-end");
    expect(focusAt()).toBe(`line-5:${LONG}`);

    moveCopyCursor("line-down");
    expect(focusAt()).toBe("line-6:10");

    moveCopyCursor("line-up");
    expect(focusAt()).toBe(`line-5:${LONG}`);
    expect(modifyCalls).toEqual(["extend forward paragraphboundary"]);
  });

  it("takes a page key through such lines without asking the browser", () => {
    mountThread({ lineCount: 40 });
    codeBlock(2, 30);
    for (const index of [6, 7, 8]) textOf(`line-${index}`).data = "x".repeat(LONG);
    enterAt("line-4", 3);

    moveCopyCursor("half-page-down");

    expect(focusAt()).toBe("line-12:3");
    expect(modifyCalls).toEqual([]);
  });

  it("finds the column in a line of several pieces of text, as bb draws the words of a line of code", () => {
    mountThread({
      extraRowsHtml: `
        <code><p id="words" style="display: inline-block"><span id="word-1">const</span><span id="word-2"> </span><span id="word-3">answer</span></p>
</code>`,
    });
    const top = CONTENT_TOP - LINE_HEIGHT;
    for (const [id, column] of [["word-1", 0], ["word-2", 5], ["word-3", 6]] as const) {
      boxes.set(textOf(id), {
        top,
        left: TEXT_INSET + column * CHAR_WIDTH,
        columnLeft: 0,
        isFixed: false,
      });
    }
    byId("line-0").style.display = "inline-block";
    enterAt("line-0", 8);

    moveCopyCursor("line-up");
    expect(focusAt()).toBe("word-3:2");
    expect(modifyCalls).toEqual([]);

    moveCopyCursor("line-down");
    moveCopyCursor("char-left");
    moveCopyCursor("char-left");
    moveCopyCursor("char-left");
    moveCopyCursor("line-up");
    expect(focusAt()).toBe("word-2:0");

    moveCopyCursor("line-down");
    moveCopyCursor("line-end");
    moveCopyCursor("line-up");
    expect(focusAt()).toBe("word-3:6");
  });

  it("takes a line for not wrapped by the line height that its box is styled with, where that is more than the height of its characters", () => {
    codeBlock(4, 9);
    const line = byId("line-5");
    textOf("line-5").data = "x".repeat(LONG);
    line.style.lineHeight = `${2 * LINE_HEIGHT}px`;
    line.getBoundingClientRect = () =>
      rect(TEXT_INSET, CONTENT_TOP + 5 * LINE_HEIGHT, PANE_WIDTH, 2 * LINE_HEIGHT);
    enterAt("line-6", 3);
    const measured = measurements();

    moveCopyCursor("line-up");

    expect(focusAt()).toBe("line-5:3");
    expect(measured.mock.calls.length).toBeLessThan(100);
  });

  // The column cannot be looked up by halving then, so the line is looked
  // through from the end that the move comes from.
  describe("a line with a piece of text that has no rectangle", () => {
    // The pieces of the line, each with the column that it is drawn at, or
    // null for one that is not drawn.
    function lineOfPieces(pieces: readonly [text: string, column: number | null][]): void {
      const spans = pieces
        .map(([text], index) => `<span id="word-${index + 1}">${text}</span>`)
        .join("");
      mountThread({
        extraRowsHtml: `
          <code><p id="words" style="display: inline-block">${spans}</p>
</code>`,
      });
      pieces.forEach(([, column], index) => {
        if (column === null) return;
        boxes.set(textOf(`word-${index + 1}`), {
          top: CONTENT_TOP - LINE_HEIGHT,
          left: TEXT_INSET + column * CHAR_WIDTH,
          columnLeft: 0,
          isFixed: false,
        });
      });
      byId("line-0").style.display = "inline-block";
    }

    it.each([
      ["left of that piece", 2, "word-1:2"],
      ["right of that piece", 8, "word-3:2"],
    ])("finds the place at a column %s", (_name, column, place) => {
      lineOfPieces([["const", 0], ["?", null], ["answer", 6]]);
      enterAt("line-0", column);

      moveCopyCursor("line-up");

      expect(focusAt()).toBe(place);
      expect(modifyCalls).toEqual([]);
    });

    it("finds a column near the end of such a line that is thousands of characters long", () => {
      lineOfPieces([["const", 0], ["?", null], ["y".repeat(3000), 6]]);
      textOf("line-0").data = "x".repeat(LONG);
      widenViewport();
      enterAt("line-0", 2506);

      moveCopyCursor("line-up");

      expect(focusAt()).toBe("word-3:2500");
    });

    it("goes to the first character that is drawn where the line starts with such a piece", () => {
      lineOfPieces([["??", null], ["const", 2], ["answer", 8]]);
      enterAt("line-0", 0);

      moveCopyCursor("line-up");

      expect(focusAt()).toBe("word-2:0");
      expect(modifyCalls).toEqual([]);
    });
  });

  it.each([
    ["in front of a character of several code points when the column is in its left half", 3, "line-5:2"],
    ["behind it when the column is in its right half", 5, "line-5:6"],
  ])("puts the cursor %s", (_name, column, place) => {
    codeBlock(4, 9);
    textOf("line-5").data = "ab\u{1F44D}\u{1F3FD}cd";
    enterAt("line-6", column);

    moveCopyCursor("line-up");

    expect(focusAt()).toBe(place);
  });

  it("goes on with the text that follows a box in the same paragraph, as behind a formula that is drawn as a box", () => {
    mountThread({
      extraRowsHtml: `
        <div data-timeline-row-id="row-boxed"><p id="boxed">text <span id="formula" style="display: inline-block">x + y</span>wrapped on</p></div>`,
    });
    const top = CONTENT_TOP + 2 * LINE_HEIGHT;
    const left = 300;
    const behind = byId("boxed").lastChild;
    if (!(behind instanceof Text)) throw new Error("the fixture text is missing");
    boxes.set(textOf("boxed"), { top, left, columnLeft: 0, isFixed: false });
    boxes.set(textOf("formula"), {
      top,
      left: left + 5 * CHAR_WIDTH,
      columnLeft: 0,
      isFixed: false,
    });
    boxes.set(behind, { top: top + LINE_HEIGHT, left, columnLeft: 0, isFixed: false });
    enterAt("formula", 2);

    moveCopyCursor("line-down");

    expect(getSelection().focusNode).toBe(behind);
    expect(getSelection().focusOffset).toBe(7);
    expect(modifyCalls).toEqual([]);
  });

  // The last character of such a line is in the box, and the box is as high
  // as one line, but the words in front of it are on that line as well.
  describe("a move up onto a line that ends with a box, as with a formula behind the words of a paragraph", () => {
    function lineThatEndsWithBox(): void {
      mountThread({
        extraRowsHtml: `
          <div data-timeline-row-id="row-boxed"><p id="boxed">some text <span id="formula" style="display: inline-block">x + y</span></p></div>`,
      });
      const top = CONTENT_TOP - LINE_HEIGHT;
      boxes.set(textOf("boxed"), { top, left: TEXT_INSET, columnLeft: 0, isFixed: false });
      boxes.set(textOf("formula"), {
        top,
        left: TEXT_INSET + 10 * CHAR_WIDTH,
        columnLeft: 0,
        isFixed: false,
      });
      byId("line-0").style.display = "inline-block";
    }

    it.each([
      ["left of the box, among the words in front of it", 3, "boxed:3"],
      ["in the box", 12, "formula:2"],
      ["right of the box, at the end of the line", 15, "formula:5"],
    ])("keeps a column that is %s", (_name, column, place) => {
      lineThatEndsWithBox();
      textOf("line-0").data = "a line of code that is long enough";
      enterAt("line-0", column);

      moveCopyCursor("line-up");

      expect(focusAt()).toBe(place);
      expect(modifyCalls).toEqual([]);
    });

    it("keeps the column on the way back up after the moves went down over that line", () => {
      lineThatEndsWithBox();
      enterAt("boxed", 3);

      moveCopyCursor("line-down");
      moveCopyCursor("line-down");
      expect(focusAt()).toBe("line-1:3");
      moveCopyCursor("line-up");
      moveCopyCursor("line-up");

      expect(focusAt()).toBe("boxed:3");
    });
  });

  it("still looks through a line that is wrapped inside its box, line by line", () => {
    mountThread({
      extraRowsHtml: `
        <code><p id="first-part" style="display: inline-block">row one of it <b id="second-part">row two of it</b></p>
</code>`,
    });
    const top = CONTENT_TOP - 2 * LINE_HEIGHT;
    boxes.set(textOf("first-part"), { top, left: TEXT_INSET, columnLeft: 0, isFixed: false });
    boxes.set(textOf("second-part"), {
      top: top + LINE_HEIGHT,
      left: TEXT_INSET,
      columnLeft: 0,
      isFixed: false,
    });
    byId("first-part").getBoundingClientRect = () =>
      rect(TEXT_INSET, top, PANE_WIDTH, 2 * LINE_HEIGHT);
    enterAt("line-0", 4);

    expect(
      ["line-up", "line-up", "line-down", "line-down"].map((motion) => {
        moveCopyCursor(motion as CopyMotion);
        return focusAt();
      }),
    ).toEqual(["second-part:4", "first-part:4", "second-part:4", "line-0:4"]);
    expect(modifyCalls).toEqual(["move backward line"]);
  });
});

// As bb 0.50.1 draws code that it does not highlight (MarkdownCodeBlock in
// markdown-preview.tsx) and the output of a tool (ToolCallDetailBlock.tsx):
// one piece of text with a line break between two lines, in an element whose
// style keeps the line breaks and does not wrap. Measuring the characters of
// a line one by one takes Chromium the longer the longer the line is.
describe("a line of preformatted text that is thousands of characters long, which bb does not draw in a box of its own", () => {
  const LONG = 5000;
  let lines: readonly string[];

  function offsetOf(line: number, column: number): number {
    const before = lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0);
    return before + column;
  }

  function place(line: number, column: number): string {
    return `line-2:${offsetOf(line, column)}`;
  }

  // The line of the fixture becomes the element, and the lines after it
  // make room for the lines of the text. As Chromium reports it: no
  // rectangle for a place at the start of an empty line, and one without a
  // width for a line break, at the end of the line that it ends.
  function preformattedLines(texts: readonly string[], whiteSpace = "pre"): Text {
    lines = texts;
    for (let index = 3; index <= texts.length + 1; index += 1) removeRow(`line-${index}`);
    const node = textOf("line-2");
    const text = texts.join("\n");
    node.data = text;
    byId("line-2").style.whiteSpace = whiteSpace;
    const box = boxes.get(node);
    if (box === undefined) throw new Error("the fixture line has no box");
    const lineOf = (offset: number): number => text.slice(0, offset).split("\n").length - 1;
    const columnOf = (offset: number): number => offset - (text.lastIndexOf("\n", offset - 1) + 1);
    const isEmptyLineStart = (offset: number): boolean =>
      text[offset] === "\n" && (offset === 0 || text[offset - 1] === "\n");
    define(Range.prototype, "getClientRects", function lineRects(this: Range): DOMRect[] {
      if (this.startContainer !== node) return fakeClientRects.call(this);
      if (this.collapsed && isEmptyLineStart(this.startOffset)) return [];
      const isLineBreak = text[this.startOffset] === "\n";
      const length = this.collapsed || isLineBreak ? 0 : this.endOffset - this.startOffset;
      return [
        rect(
          box.left + columnOf(this.startOffset) * CHAR_WIDTH,
          screenTop(box) + lineOf(this.startOffset) * LINE_HEIGHT,
          length * CHAR_WIDTH,
          LINE_HEIGHT,
        ),
      ];
    });
    return node;
  }

  function enterAtPlace(line: number, column: number): void {
    enterAt("line-2", offsetOf(line, column));
  }

  function measurements(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(Range.prototype, "getClientRects");
  }

  // The scroller as wide as the longest line, so that a place far to the
  // right in a line counts as on screen.
  function widenViewport(): void {
    byId("viewport").getBoundingClientRect = () =>
      rect(0, VIEWPORT_TOP, TEXT_INSET + (LONG + 1) * CHAR_WIDTH, VIEWPORT_HEIGHT);
  }

  it("goes down from such a line without measuring its characters and without asking the browser", () => {
    preformattedLines(["one", "x".repeat(LONG), "two", "three"]);
    enterAtPlace(1, 3);
    const measured = measurements();

    moveCopyCursor("line-down");

    expect(focusAt()).toBe(place(2, 3));
    expect(modifyCalls).toEqual([]);
    expect(measured.mock.calls.length).toBeLessThan(100);
  });

  it("goes up onto such a line at the column of the move, without measuring its characters", () => {
    preformattedLines(["one", "x".repeat(LONG), "two", "three"]);
    enterAtPlace(2, 3);
    const measured = measurements();

    moveCopyCursor("line-up");

    expect(focusAt()).toBe(place(1, 3));
    expect(modifyCalls).toEqual([]);
    expect(measured.mock.calls.length).toBeLessThan(100);
  });

  it("goes down onto such a line at the column of the move, without measuring its characters", () => {
    preformattedLines(["one", "x".repeat(LONG), "two", "three"]);
    enterAtPlace(0, 2);
    const measured = measurements();

    moveCopyCursor("line-down");

    expect(focusAt()).toBe(place(1, 2));
    expect(modifyCalls).toEqual([]);
    expect(measured.mock.calls.length).toBeLessThan(100);
  });

  it("comes onto such a line from the line behind the text, which the browser's move jumps over", () => {
    preformattedLines(["one", "x".repeat(LONG)]);
    enterAt("line-4", 3);
    const measured = measurements();

    moveCopyCursor("line-up");

    expect(focusAt()).toBe(place(1, 3));
    expect(measured.mock.calls.length).toBeLessThan(100);
  });

  it("goes up from such a line, from far to the right in it, to the end of a shorter line", () => {
    preformattedLines(["one", "x".repeat(LONG), "two"]);
    widenViewport();
    enterAtPlace(1, 3000);
    const measured = measurements();

    moveCopyCursor("line-up");

    expect(focusAt()).toBe(place(0, 3));
    expect(modifyCalls).toEqual([]);
    expect(measured.mock.calls.length).toBeLessThan(100);
  });

  it("keeps a column that is far to the right between two such lines, down and up", () => {
    preformattedLines(["one", "x".repeat(LONG), "y".repeat(LONG), "two"]);
    widenViewport();
    enterAtPlace(1, 3000);
    const measured = measurements();

    moveCopyCursor("line-down");
    expect(focusAt()).toBe(place(2, 3000));

    moveCopyCursor("line-up");
    expect(focusAt()).toBe(place(1, 3000));
    expect(modifyCalls).toEqual([]);
    expect(measured.mock.calls.length).toBeLessThan(200);
  });

  it("comes back to a column far to the right in such a line after a shorter line", () => {
    preformattedLines(["one", "x".repeat(LONG), "two", "y".repeat(LONG)]);
    widenViewport();
    enterAtPlace(1, 3000);

    moveCopyCursor("line-down");
    expect(focusAt()).toBe(place(2, 3));

    moveCopyCursor("line-down");
    expect(focusAt()).toBe(place(3, 3000));

    moveCopyCursor("line-up");
    moveCopyCursor("line-up");
    expect(focusAt()).toBe(place(1, 3000));
    expect(modifyCalls).toEqual([]);
  });

  it("extends a selection with tmux's vi keys along such lines without asking the browser", () => {
    useModeKeys("vi");
    preformattedLines(["one", "x".repeat(LONG), "y".repeat(LONG), "two"]);
    enterAtPlace(0, 1);
    beginCopySelection();
    const measured = measurements();

    moveCopyCursor("line-down");
    moveCopyCursor("line-down");

    expect(anchorAt()).toBe(place(0, 1));
    expect(focusAt()).toBe(place(2, 2));
    expect(modifyCalls).toEqual([]);
    expect(measured.mock.calls.length).toBeLessThan(300);
  });

  it("leaves the text for the line behind it without asking the browser, which makes the moves from there", () => {
    preformattedLines(["one", "two"]);
    enterAtPlace(1, 1);

    moveCopyCursor("line-down");
    expect(focusAt()).toBe("line-4:1");
    expect(modifyCalls).toEqual([]);

    moveCopyCursor("line-down");
    expect(focusAt()).toBe("line-5:1");
    expect(modifyCalls).toEqual(["move forward line"]);
  });

  it("stops on an empty line of such text on the way down and on the way up, and keeps the column", () => {
    preformattedLines(["one", "", "three"]);
    enterAtPlace(0, 2);

    const visited = (["line-down", "line-down", "line-up", "line-up"] as const).map((motion) => {
      moveCopyCursor(motion);
      return focusAt();
    });

    expect(visited).toEqual([place(1, 0), place(2, 2), place(1, 0), place(0, 2)]);
    expect(modifyCalls).toEqual([]);
  });

  it.each([
    ["in front of a character of several code points when the column is in its left half", 3, 2],
    ["behind it when the column is in its right half", 5, 6],
  ])("puts the cursor %s", (_name, column, landing) => {
    preformattedLines(["ab\u{1F44D}\u{1F3FD}cd", "x".repeat(20)]);
    enterAtPlace(1, column);

    moveCopyCursor("line-up");

    expect(focusAt()).toBe(place(0, landing));
  });

  it("finds a place left of such text on its line, where other text stands in front of it on that line", () => {
    const node = preformattedLines(["cdefgh", "second line"]);
    const lead = document.createElement("b");
    lead.id = "lead";
    lead.textContent = "ab";
    node.before(lead);
    const box = boxes.get(node);
    if (box === undefined) throw new Error("the fixture line has no box");
    boxes.set(textOf("lead"), { ...box });
    box.left += 2 * CHAR_WIDTH;
    enterAt("line-4", 0);

    moveCopyCursor("line-up");
    expect(getSelection().focusNode).toBe(node);
    expect(getSelection().focusOffset).toBe(offsetOf(1, 0));

    moveCopyCursor("line-up");
    expect(focusAt()).toBe("lead:0");
  });

  it("asks the browser on such text that is wrapped, whose lines are not those of its line breaks", () => {
    preformattedLines(["one", "two"], "pre-wrap");
    enterAtPlace(0, 1);

    moveCopyCursor("line-down");

    expect(focusAt()).toBe(place(1, 1));
    expect(modifyCalls).toEqual(["move forward line"]);
  });
});


// As bb 0.50.1 draws a message of the user with two lines (remark-breaks):
// one paragraph that holds the first line, a line break element, a line
// break that is not drawn, and the second line. Chromium gives the start of
// the second line as the place in front of that line break, where it draws
// no caret, and moves on from it as from the first character of the line.
describe("the start of a line of a message of the user, which follows a line break element", () => {
  let message: HTMLElement;
  let second: Text;

  beforeEach(() => {
    message = byId("line-0");
    second = textOf("line-1");
    message.append(document.createElement("br"), "\n", second);
    removeRow("line-1");
    nodeNames.set(message, "message");
    nodeNames.set(second, "second");
  });

  describe.each<ModeKeys>(["vi", "emacs"])("with tmux's %s keys", (modeKeys) => {
    beforeEach(() => {
      useModeKeys(modeKeys);
    });

    it("is where a next word move from the end of the line before lands, and not on the second word of the line", () => {
      enterAt("line-0", 16);
      stepsInto.set("line-0:16 forward word", [message, 2]);
      stepsInto.set("message:2 forward word", [second, 5]);
      stepsInto.set("second:5 backward word", [message, 2]);
      stepsInto.set("message:2 backward word", [textOf("line-0"), 16]);

      moveCopyCursor("word-forward");

      expect(focusAt()).toBe("second:0");
      expect(copyModeUi().cursor).toEqual(blockAt(1, 0));

      moveCopyCursor("word-forward");

      expect(focusAt()).toBe("second:6");
    });

    it("is where a move by a character from the end of the line before lands, and not behind the first character of the line", () => {
      enterAt("line-0", 16);
      stepsInto.set("line-0:16 right character", [message, 2]);
      stepsInto.set("message:2 right character", [second, 1]);

      moveCopyCursor("char-right");

      expect(focusAt()).toBe("second:0");
      expect(copyModeUi().cursor).toEqual(blockAt(1, 0));
    });
  });

  it("is where a previous word move from the second word of the line lands with a selection that was started above", () => {
    enterAt("line-0", 0);
    beginCopySelection();
    moveCopyCursor("line-down");
    moveCopyCursor("word-forward");
    expect(focusAt()).toBe("second:6");
    stepsInto.set("second:6 backward word", [message, 2]);
    stepsInto.set("message:2 backward word", [textOf("line-0"), 16]);

    moveCopyCursor("word-back");

    expect(anchorAt()).toBe("line-0:0");
    expect(focusAt()).toBe("second:0");
  });

  it("is where a previous paragraph move from the line below lands with a selection that was started above, and not where the selection was started", () => {
    enterAt("line-0", 0);
    beginCopySelection();
    moveCopyCursor("line-down");
    moveCopyCursor("line-down");
    expect(focusAt()).toBe("line-2:0");
    stepsInto.set("line-2:0 backward paragraph", [message, 2]);
    stepsInto.set("message:2 backward paragraph", [textOf("line-0"), 0]);

    moveCopyCursor("paragraph-back");

    expect(anchorAt()).toBe("line-0:0");
    expect(focusAt()).toBe("second:0");
  });

  it("is not looked for on a move by a line, which keeps its column by the lookup of the line", () => {
    enterAt("line-0", 0);
    stepsInto.set("line-0:0 forward line", [message, 2]);

    moveCopyCursor("line-down");

    expect(focusAt()).toBe("second:0");
    expect(modifyCalls).toContain("move forward line");
    expect(getSelection().isCollapsed).toBe(true);
  });
});

// As bb 0.50.1 draws a rule between two parts of an answer: an element
// without text that is a pixel high. Chromium stops a step in front of it.
describe("a rule between two paragraphs", () => {
  let items: HTMLElement;
  let place: number;

  beforeEach(() => {
    const rule = document.createElement("hr");
    byId("line-2").closest("[data-timeline-row-id]")?.after(rule);
    rule.getBoundingClientRect = () =>
      rect(TEXT_INSET, CONTENT_TOP + 3 * LINE_HEIGHT - scrollTop, 700, 1);
    const holder = rule.parentElement;
    if (holder === null) throw new Error("the fixture rule has no parent");
    items = holder;
    place = Array.from(items.childNodes).indexOf(rule);
    nodeNames.set(items, "items");
  });

  it("is passed over by a move by a character, which goes on to the text behind it", () => {
    enterAt("line-2", 14);
    stepsInto.set("line-2:14 right character", [items, place]);
    stepsInto.set(`items:${place} right character`, [textOf("line-3"), 0]);

    moveCopyCursor("char-right");

    expect(focusAt()).toBe("line-3:0");
    expect(copyModeUi().cursor).toEqual(blockAt(3, 0));
  });

  it("is passed over by a move back by a character", () => {
    enterAt("line-3", 0);
    stepsInto.set("line-3:0 left character", [items, place]);
    stepsInto.set(`items:${place} left character`, [textOf("line-2"), 14]);

    moveCopyCursor("char-left");

    expect(focusAt()).toBe("line-2:14");
  });

  it("is passed over by a move down by a line, which keeps its column", () => {
    enterAt("line-2", 3);
    stepsInto.set("line-2:3 forward line", [items, place]);
    stepsInto.set(`items:${place} forward line`, [textOf("line-3"), 3]);

    moveCopyCursor("line-down");

    expect(focusAt()).toBe("line-3:3");
    expect(copyModeUi().cursor).toEqual(blockAt(3, 3));
  });

  it("is passed over by a move to the next paragraph", () => {
    enterAt("line-2", 3);
    stepsInto.set("line-2:3 forward paragraph", [items, place]);
    stepsInto.set(`items:${place} forward paragraph`, [textOf("line-3"), 3]);

    moveCopyCursor("paragraph-forward");

    expect(focusAt()).toBe("line-3:0");
  });

  // As Chromium does it: the step back by a paragraph from the start of the
  // text behind the rule ends behind the rule, and the start of the
  // paragraph from there is the start of that text again. The places behind
  // and in front of the rule are both drawn as the start of that text.
  it("is passed over by a move to the previous paragraph from the start of the text behind it", () => {
    define(Range.prototype, "getClientRects", function besideRuleRects(this: Range): DOMRect[] {
      const isBesideRule =
        this.startContainer === items &&
        (this.startOffset === place || this.startOffset === place + 1);
      if (!isBesideRule) return fakeClientRects.call(this);
      const start = document.createRange();
      start.setStart(textOf("line-3"), 0);
      start.collapse(true);
      return fakeClientRects.call(start);
    });
    stepsInto.set("line-3:0 backward paragraph", [items, place + 1]);
    stepsInto.set(`items:${place} backward paragraphboundary`, [items, place]);
    stepsInto.set(`items:${place} backward paragraph`, [textOf("line-2"), 0]);
    enterAt("line-3", 0);

    moveCopyCursor("paragraph-back");

    expect(focusAt()).toBe("line-2:0");
    expect(copyModeUi().cursor).toEqual(blockAt(2, 0));
  });
});

// As bb 0.50.1 draws a picture inside a paragraph: a block of its own, with
// the text behind it on a line below. Chromium does not take a caret that
// stands in front of the picture across it: the step ends where it began.
describe("a picture that follows text in its paragraph", () => {
  // The picture stands right of the first line here, so that no text of
  // the fixture is drawn where it is.
  const PICTURE_LEFT = 400;
  let paragraph: HTMLElement;

  beforeEach(() => {
    paragraph = byId("line-2");
    const picture = document.createElement("img");
    const tail = textOf("line-3");
    paragraph.append(picture, tail);
    removeRow("line-3");
    picture.getBoundingClientRect = () =>
      rect(PICTURE_LEFT, CONTENT_TOP + 2 * LINE_HEIGHT, 120, LINE_HEIGHT);
    nodeNames.set(paragraph, "paragraph");
    nodeNames.set(tail, "tail");
    stepsInto.set("line-2:14 right character", [paragraph, 1]);
    for (const step of ["right character", "forward word", "forward paragraph"]) {
      stepsInto.set(`paragraph:1 ${step}`, [paragraph, 1]);
    }
    enterAt("line-2", 14);
    moveCopyCursor("char-right");
  });

  it("holds the cursor in front of it, as high as the picture", () => {
    expect(focusAt()).toBe("paragraph:1");
    expect(copyModeUi().cursor).toEqual({
      left: PICTURE_LEFT,
      top: CONTENT_TOP + 2 * LINE_HEIGHT,
      width: CARET_WIDTH,
      height: LINE_HEIGHT,
    });
  });

  it.each<CopyMotion>(["char-right", "paragraph-forward"])(
    "is crossed by %s from the place in front of it, to the first character of the text behind it",
    (motion) => {
      moveCopyCursor(motion);

      expect(focusAt()).toBe("tail:0");
      expect(copyModeUi().cursor).toEqual(blockAt(3, 0));
    },
  );

  it("is crossed by a next word move, which goes on to a word of the text behind it", () => {
    moveCopyCursor("word-forward");

    expect(getSelection().focusNode).toBe(textOf("line-2").parentElement?.lastChild);
  });

  it("is not crossed by a move by a line or to the start of a line that ends where it began", () => {
    stepsInto.set("paragraph:1 forward line", [paragraph, 1]);
    stepsInto.set("paragraph:1 backward paragraphboundary", [paragraph, 1]);

    moveCopyCursor("line-start");

    expect(focusAt()).toBe("paragraph:1");
  });

  // As Chromium does it: the step back by a paragraph from the text behind
  // the picture ends behind the picture, at the place numbered behind, which
  // is drawn as the start of that text, and the start of the paragraph from
  // there is the start of that text again.
  function enterBehindPicture(behind: number): void {
    const tail = paragraph.lastChild;
    if (!(tail instanceof Text)) throw new Error("the fixture text is missing");
    define(Range.prototype, "getClientRects", function behindPictureRects(this: Range): DOMRect[] {
      const isBehind = this.startContainer === paragraph && this.startOffset === behind;
      if (!isBehind) return fakeClientRects.call(this);
      const start = document.createRange();
      start.setStart(tail, 0);
      start.collapse(true);
      return fakeClientRects.call(start);
    });
    stepsInto.set("tail:0 backward paragraph", [paragraph, behind]);
    exitCopyMode();
    getSelection().setBaseAndExtent(textOf("line-4"), 0, tail, 0);
    expect(enterCopyMode()).toBe(true);
  }

  it("is crossed by a previous paragraph move from the text behind it, to the start of the text in front of it", () => {
    stepsInto.set("paragraph:1 backward paragraphboundary", [textOf("line-2"), 0]);
    enterBehindPicture(2);

    moveCopyCursor("paragraph-back");

    expect(focusAt()).toBe("line-2:0");
    expect(copyModeUi().cursor).toEqual(blockAt(2, 0));
  });

  it("holds the cursor in front of it on a previous paragraph move from the text behind it, where the paragraph starts with the picture", () => {
    textOf("line-2").remove();
    stepsInto.set("paragraph:0 backward paragraphboundary", [paragraph, 0]);
    enterBehindPicture(1);

    moveCopyCursor("paragraph-back");

    expect(focusAt()).toBe("paragraph:0");
    expect(copyModeUi().cursor).toEqual({
      left: PICTURE_LEFT,
      top: CONTENT_TOP + 2 * LINE_HEIGHT,
      width: CARET_WIDTH,
      height: LINE_HEIGHT,
    });
  });
});

// With a selection under way Chromium gives the place one character back
// from the end of a word that starts a line of a code block as the place
// behind the line break in front of that line, which is in front of where
// the move started and is drawn on the same character.
describe("the end of a word of one character that starts a line of a code block", () => {
  it("is where a next word end move from the start of that line lands with tmux's emacs keys, and not at the end of the next word", () => {
    codeBlock(2, 5);
    textOf("line-3").data = "}";
    const inFront = byId("line-3").previousSibling;
    if (!(inFront instanceof Text)) throw new Error("the fixture line break is missing");
    enterAt("line-3", 0);
    stepsInto.set("line-3:1 backward character", [inFront, 1]);

    moveCopyCursor("word-end");

    expect(focusAt()).toBe("line-3:1");
  });
});
