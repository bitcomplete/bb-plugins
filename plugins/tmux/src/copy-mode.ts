import { getBridge, getUiState, showNotice, updateUiState } from "./bridge";
import {
  COPIED_NOTICE,
  COPY_FAILED_NOTICE,
  copySelection,
  type CopyResult,
} from "./clipboard";
import { PLUGIN_ID, SELECTORS } from "./constants";
import { getTimelineViewport, scrollTimelineBy } from "./dom-actions";
import {
  EDITABLE_SELECTOR,
  OVERLAY_SELECTOR,
  TERMINAL_SELECTOR,
} from "./focus-context";
import type { AfterCopy, CopyModeUi, CopyMotion, CursorRect } from "./types";

interface TextPosition {
  node: Node;
  offset: number;
}

interface ModifyStep {
  direction: "forward" | "backward" | "left" | "right";
  granularity:
    | "character"
    | "word"
    | "line"
    | "lineboundary"
    | "paragraph"
    | "paragraphboundary";
}

// The moves by a line that followed each other, and where the cursor stood
// before the first of them, which is where their column comes from.
// isColumnOurs: one of the moves was put on its line by copy mode, where the
// browser had jumped over that line. The browser no longer knows the column
// then, so every later move of the run is put at the column of origin.
interface LineRun {
  origin: TextPosition;
  steps: ModifyStep[];
  isColumnOurs: boolean;
}

// anchor is where the selection was started, in front of the character that
// the cursor block was on, and anchorEnd is the place behind that character.
// lineRun is the run of line moves that led to the cursor, and hasColumn says
// that copy mode has not set the selection since the last move of that run,
// which would make the browser forget its column.
interface CopySession {
  viewport: HTMLElement;
  cursor: TextPosition;
  anchor: TextPosition | null;
  anchorEnd: TextPosition | null;
  lineRun: LineRun | null;
  hasColumn: boolean;
  stopTracking: () => void;
}

// selectsUnderBlock: tmux's vi keys are in use. lineRun is the run of line
// moves that came right before the move, and hasColumn says that the browser
// still knows the column of that run. activeRun is the run that the line
// moves under way belong to.
interface MoveContext {
  doc: Document;
  selection: Selection;
  session: CopySession;
  selectsUnderBlock: boolean;
  lineRun: LineRun | null;
  hasColumn: boolean;
  activeRun: LineRun | null;
}

interface Glyph {
  rect: DOMRect;
  text: string;
  end: TextPosition;
}

interface VisibleBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface CaretLine {
  left: number;
  top: number;
  height: number;
}

// What the cursor is drawn as at a place: a block on the character under it,
// or a narrow mark where there is none, as behind the last one of a line.
interface CursorShape {
  rect: CursorRect;
  isMark: boolean;
}

// The part of an element that shows its content, in window coordinates.
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// An element between a place and the scroller of the conversation that cuts
// off what overflows it. scrollsX and scrollsY say that it can be scrolled
// that way, so that what it cuts off can still be brought into view.
interface ClipBox {
  element: HTMLElement;
  box: Box;
  scrollsX: boolean;
  scrollsY: boolean;
}

// A character of the conversation with the rectangle it is drawn in. A line
// break has a rectangle without a width.
interface CharacterBox {
  node: Text;
  offset: number;
  end: number;
  rect: DOMRect;
}

// A stretch of one piece of text that is a line: start is where the line
// begins and end where the line break that ends it stands, or the end of the
// piece.
interface TextLine {
  node: Text;
  start: number;
  end: number;
}

// A place on a line where the cursor can stand, with the left and the right
// edge of the character that follows it.
interface LineStop {
  position: TextPosition;
  left: number;
  right: number;
}

interface FoundLine {
  line: CaretLine;
  stops: LineStop[];
}

// The lines of a code block that bb draws line by line, each a box of its
// own, and which of them a place is on. block is the element that holds
// them.
interface CodeLines {
  block: Element;
  lines: Element[];
  index: number;
}

interface ParagraphStart {
  reached: TextPosition;
  start: TextPosition;
}

// Where a word ends: end is the place behind its last character, and last is
// the place in front of that character.
interface WordEnd {
  end: TextPosition;
  last: TextPosition;
}

// pages is the share of the visible height that the view scrolls by, and
// direction is 1 for down and -1 for up.
interface PageMove {
  direction: 1 | -1;
  pages: number;
}

type ScreenPlace = "top" | "middle" | "bottom";
type TextEdge = "start" | "end";

type PageMotion = "half-page-up" | "half-page-down" | "page-up" | "page-down";

type PlainMotion = Exclude<
  CopyMotion,
  | "line-up"
  | "line-down"
  | "word-forward"
  | "word-end"
  | "line-indent"
  | "paragraph-back"
  | "paragraph-forward"
  | "document-start"
  | "document-end"
  | "screen-top"
  | "screen-middle"
  | "screen-bottom"
  | PageMotion
>;

const LINE_UP: ModifyStep = { direction: "backward", granularity: "line" };
const LINE_DOWN: ModifyStep = { direction: "forward", granularity: "line" };
const LINE_START: ModifyStep = { direction: "backward", granularity: "lineboundary" };
// tmux's start-of-line and end-of-line take the whole line that the terminal
// wrapped (window_copy_cursor_start_of_line and window_copy_cursor_end_of_line
// in window-copy.c, with grid_reader_cursor_start_of_line in grid-reader.c).
// In a page that is a paragraph, or a line of code.
const WRAPPED_LINE_START: ModifyStep = {
  direction: "backward",
  granularity: "paragraphboundary",
};
const WRAPPED_LINE_END: ModifyStep = {
  direction: "forward",
  granularity: "paragraphboundary",
};
const PARAGRAPH_BACK: ModifyStep = { direction: "backward", granularity: "paragraph" };
const PARAGRAPH_ON: ModifyStep = { direction: "forward", granularity: "paragraph" };
const WORD_BACK: ModifyStep = { direction: "backward", granularity: "word" };
const WORD_END: ModifyStep = { direction: "forward", granularity: "word" };
const CHARACTER_ON: ModifyStep = { direction: "forward", granularity: "character" };
const CHARACTER_BACK: ModifyStep = { direction: "backward", granularity: "character" };
const BOUNDARY_GRANULARITIES: ReadonlySet<ModifyStep["granularity"]> = new Set([
  "lineboundary",
  "paragraphboundary",
]);
// The steps that Chromium on macOS stops where the selection was started,
// when they would take its other end across that place
// (SelectionModifier::Modify in selection_modifier.cc of Chromium).
const STOPPING_GRANULARITIES: ReadonlySet<ModifyStep["granularity"]> = new Set([
  "word",
  "paragraph",
  "line",
]);
const CROSSING_GRANULARITIES: ReadonlySet<ModifyStep["granularity"]> = new Set([
  "character",
  "word",
  "paragraph",
]);

const PLAIN_STEPS: Record<PlainMotion, ModifyStep> = {
  "char-left": { direction: "left", granularity: "character" },
  "char-right": { direction: "right", granularity: "character" },
  "word-back": WORD_BACK,
  "line-start": WRAPPED_LINE_START,
  "line-end": WRAPPED_LINE_END,
};

const NOT_CONVERSATION_SELECTOR = [
  SELECTORS.composer,
  TERMINAL_SELECTOR,
  "input",
  EDITABLE_SELECTOR,
  OVERLAY_SELECTOR,
].join(", ");

// The labels that bb draws between the texts of the conversation: the header
// above a code block, whose text bb leaves out of a copy, and the button
// under a long message that shows or hides the rest of it.
const LABEL_SELECTOR = `${SELECTORS.codeBlockHeader}, ${SELECTORS.messageOverflowToggle}`;

// What the scroller of the conversation holds that the cursor never stands
// in: the message box in its footer, and those labels.
const OUTSIDE_TIMELINE_SELECTOR = `${SELECTORS.scrollFooter}, ${LABEL_SELECTOR}, ${NOT_CONVERSATION_SELECTOR}`;

const SCROLL_LISTENER_OPTIONS = { capture: true, passive: true } as const;
const INACTIVE: CopyModeUi = { active: false };

const NOTHING_SELECTED_NOTICE =
  "Nothing is selected. Start a selection and move the cursor, then copy";
const LOST_NOTICE =
  "The selection was lost because bb unloaded that part of the conversation";

const CARET_WIDTH_PX = 2;
// How far from the edge of a box a place still counts as at that edge: the
// width that a box reports is a whole number of pixels.
const EDGE_ROOM_PX = 1;
const COMFORT_MARGIN_PX = 16;
const PROBE_STEP_PX = 6;
const PROBE_INSET_PX = 1;
const FALLBACK_LINE_HEIGHT_PX = 20;
const MAX_PAGE_LINES = 80;
const MAX_LINE_RUN_STEPS = 4 * MAX_PAGE_LINES;
// The most line moves of a run that are made again for the browser to find
// their column. A longer run keeps its column itself: making its moves
// again would cost more with every line that the cursor goes on.
const MAX_RETAKEN_LINE_MOVES = 16;
const HALF_PAGE = 0.5;
const WHOLE_PAGE = 1;
const LEADING_BLANKS = /^[ \t\u00a0]*/;
const BLANK = /\s/;
const LINE_BREAK = "\n";
const LINE_BREAK_ELEMENT = "br";
// The element that bb draws a code block in (MarkdownCodeBlock in
// markdown-preview.tsx of bb 0.50.1).
const CODE_BLOCK_ELEMENT = "pre";
// The line that bb draws between two parts of an answer. It holds no text
// and is a pixel high.
const RULE_ELEMENT = "hr";
// The longest run of places without a cursor that one step passes over: bb
// keeps up to 4096 characters of a long user message in the page and shows
// the first lines of it.
const MAX_PASSED_PLACES = 4096;
const MAX_SCANNED_CHARACTERS = 2000;
// The most word moves that one move to the end of a word makes, where the
// ones before the last end at the start of a text and not behind a word.
const MAX_WORD_MOVES = 4;
const MAX_CLUSTER_LENGTH = 16;
const ADJACENT_LINE_GAP = 0.5;
const SAME_COLUMN_PX = 1;
const CLIPPING_OVERFLOWS: ReadonlySet<string> = new Set([
  "hidden",
  "clip",
  "auto",
  "scroll",
]);
const SCROLLING_OVERFLOWS: ReadonlySet<string> = new Set(["auto", "scroll"]);
const LINE_BOX_DISPLAY = "inline-block";
// The white-space style of text that keeps its line breaks and is not
// wrapped.
const UNWRAPPED_WHITE_SPACE = "pre";
// A box of a line that is at least this many times as high as a line holds a
// line that is wrapped.
const WRAPPED_BOX_LINES = 1.5;
// How far above its baseline a line of text starts and how high it is, in
// parts of the font size, for a line that holds no character to measure.
const ASCENT_SHARE = 0.9;
const LINE_SHARE = 1.2;

const PAGE_MOVES: Record<PageMotion, PageMove> = {
  "half-page-up": { direction: -1, pages: HALF_PAGE },
  "half-page-down": { direction: 1, pages: HALF_PAGE },
  "page-up": { direction: -1, pages: WHOLE_PAGE },
  "page-down": { direction: 1, pages: WHOLE_PAGE },
};

let session: CopySession | null = null;
let graphemes: Intl.Segmenter | null = null;

function report(label: string, error: unknown): void {
  console.error(`[${PLUGIN_ID}] ${label} failed`, error);
}

function guarded<T>(label: string, fallback: T, run: () => T): T {
  try {
    return run();
  } catch (error) {
    report(label, error);
    return fallback;
  }
}

function isText(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

function elementOf(node: Node): Element | null {
  return isElement(node) ? node : node.parentElement;
}

export function isConversationText(node: Node | null): boolean {
  const element = node === null ? null : elementOf(node);
  if (element === null) return false;
  if (element.closest(SELECTORS.threadWindow) === null) return false;
  return element.closest(NOT_CONVERSATION_SELECTOR) === null;
}

function isInsideConversation(
  viewport: HTMLElement,
  node: Node | null,
): node is Node {
  if (node === null || !viewport.contains(node)) return false;
  const element = elementOf(node);
  return element !== null && element.closest(OUTSIDE_TIMELINE_SELECTOR) === null;
}

function isSamePosition(a: TextPosition, b: TextPosition): boolean {
  return a.node === b.node && a.offset === b.offset;
}

function isAfter(
  doc: Document,
  position: TextPosition,
  reference: TextPosition,
): boolean {
  const range = doc.createRange();
  range.setStart(reference.node, reference.offset);
  range.collapse(true);
  return range.comparePoint(position.node, position.offset) > 0;
}

function clampPosition(position: TextPosition): TextPosition {
  const { node } = position;
  const limit = isText(node) ? node.length : node.childNodes.length;
  return position.offset <= limit ? position : { node, offset: limit };
}

function rectsOf(range: Range): DOMRect[] {
  if (typeof range.getClientRects !== "function") return [];
  return Array.from(range.getClientRects());
}

function canMeasure(doc: Document): boolean {
  return typeof doc.createRange().getClientRects === "function";
}

// A character on screen can be several code points, as a sign with a
// variation selector, a letter with a combining accent and an emoji with a
// skin tone are. A browser that cannot tell where such a character ends gets
// its first code point.
function characterLength(text: string): number {
  const codePoint = text.codePointAt(0) ?? 0;
  const codePointLength = codePoint > 0xffff ? 2 : 1;
  if (typeof Intl.Segmenter !== "function") return codePointLength;
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const first = graphemes.segment(text)[Symbol.iterator]().next();
  return first.done === true ? codePointLength : first.value.segment.length;
}

function glyphAt(range: Range, node: Text, offset: number): Glyph | null {
  const length = characterLength(node.data.slice(offset));
  const end = Math.min(node.length, offset + length);
  range.setStart(node, offset);
  range.setEnd(node, end);
  const rect = rectsOf(range).find((box) => box.width > 0 && box.height > 0);
  if (rect === undefined) return null;
  return { rect, text: node.data.slice(offset, end), end: { node, offset: end } };
}

// A line of a code block that bb draws as an element of its own, and that
// holds nothing.
function isEmptyLineElement(node: Node | null): node is Element {
  return node !== null && isElement(node) && node.textContent === "";
}

// A line break element ends the line in front of it, so the text behind it
// starts a line that is not empty: a line break at the start of that text,
// as bb puts one behind each line of a message of the user, is not drawn.
function isAtEmptyLine(node: Text, offset: number): boolean {
  if (node.data[offset] !== LINE_BREAK) return false;
  if (offset > 0) return node.data[offset - 1] === LINE_BREAK;
  const { previousSibling } = node;
  if (!isEmptyLineElement(previousSibling)) return false;
  return previousSibling.localName !== LINE_BREAK_ELEMENT;
}

// The browser has no caret rectangle for the start of an empty line of
// preformatted text. The line break that ends that line has one, without a
// width: at the start of the line, or behind the empty element of the line
// where bb draws each line of a code block as an element.
function emptyLineCaret(range: Range, node: Text, offset: number): CaretLine | null {
  if (!isAtEmptyLine(node, offset)) return null;
  range.setStart(node, offset);
  range.setEnd(node, offset + 1);
  const lineBreak = rectsOf(range).find((rect) => rect.height > 0);
  if (lineBreak === undefined) return null;
  const { previousSibling } = node;
  const left =
    offset === 0 && isEmptyLineElement(previousSibling)
      ? previousSibling.getBoundingClientRect().left
      : lineBreak.left;
  return { left, top: lineBreak.top, height: lineBreak.height };
}

// An element of a line that holds nothing has no height and sits on the
// baseline of its line.
function emptyElementCaret(element: Element, box: DOMRect): CaretLine | null {
  if (element.textContent !== "") return null;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const fontSize = Number.parseFloat(style?.fontSize ?? "");
  if (!(fontSize > 0) || !style?.display.startsWith("inline")) return null;
  return {
    left: box.left,
    top: box.top - fontSize * ASCENT_SHARE,
    height: fontSize * LINE_SHARE,
  };
}

// The place behind the line break in front of an empty line that bb draws as
// an element of its own.
function caretBeforeEmptyLine(node: Text, offset: number): CaretLine | null {
  const { nextSibling } = node;
  if (offset !== node.length || !isEmptyLineElement(nextSibling)) return null;
  return emptyElementCaret(nextSibling, nextSibling.getBoundingClientRect());
}

// The place in front of an element whose first line is such an empty line,
// as in front of a code block that starts with one. The cursor stands on
// that line there, and is not as high as the element.
function emptyFirstLineCaret(element: Element): CaretLine | null {
  let first: Node | null = element.firstChild;
  while (first !== null && isElement(first) && first.textContent !== "") {
    first = first.firstChild;
  }
  if (!isEmptyLineElement(first)) return null;
  const box = first.getBoundingClientRect();
  return box.height > 0 ? null : emptyElementCaret(first, box);
}

function caretLine(range: Range, position: TextPosition): CaretLine | null {
  const { node, offset } = position;
  range.setStart(node, offset);
  range.collapse(true);
  const caret = rectsOf(range).find((rect) => rect.height > 0);
  if (caret !== undefined) {
    return { left: caret.left, top: caret.top, height: caret.height };
  }
  if (isText(node)) {
    const emptyLine =
      emptyLineCaret(range, node, offset) ?? caretBeforeEmptyLine(node, offset);
    if (emptyLine !== null) return emptyLine;
  }
  if (isText(node) && offset > 0) {
    const previous = glyphAt(range, node, offset - 1)?.rect;
    if (previous !== undefined) {
      return { left: previous.right, top: previous.top, height: previous.height };
    }
  }
  const child: Node | undefined = node.childNodes[offset];
  if (child === undefined || !isElement(child)) return null;
  if (child.localName === RULE_ELEMENT) return null;
  const box = child.getBoundingClientRect();
  if (box.height <= 0) return emptyElementCaret(child, box);
  return (
    emptyFirstLineCaret(child) ?? { left: box.left, top: box.top, height: box.height }
  );
}

function characterAfter(
  doc: Document,
  viewport: HTMLElement,
  position: TextPosition,
): { node: Text; offset: number } | null {
  const { node, offset } = position;
  if (isText(node) && offset < node.length) return { node, offset };
  const from: Node | undefined = isText(node) ? node : node.childNodes[offset];
  if (from === undefined || !viewport.contains(from)) return null;
  if (from !== node && isText(from) && from.length > 0) {
    return { node: from, offset: 0 };
  }
  const walker = doc.createTreeWalker(viewport, NodeFilter.SHOW_TEXT);
  walker.currentNode = from;
  let next = walker.nextNode();
  while (next !== null && (next as Text).length === 0) next = walker.nextNode();
  return next === null ? null : { node: next as Text, offset: 0 };
}

// A character in the next text node only counts when it sits right after the
// caret on the same line, as it does across bold, code and link boundaries.
function isBesideCaret(glyph: DOMRect, caret: CaretLine): boolean {
  const overlap =
    Math.min(glyph.bottom, caret.top + caret.height) -
    Math.max(glyph.top, caret.top);
  if (overlap < Math.min(glyph.height, caret.height) / 2) return false;
  const gap = glyph.left - caret.left;
  return gap > -1 && gap <= caret.height;
}

function glyphUnderCursor(
  doc: Document,
  viewport: HTMLElement,
  range: Range,
  position: TextPosition,
  caret: CaretLine | null,
): Glyph | null {
  const next = characterAfter(doc, viewport, position);
  if (next === null || !isInsideConversation(viewport, next.node)) return null;
  const glyph = glyphAt(range, next.node, next.offset);
  if (glyph === null || next.node === position.node || caret === null) return glyph;
  return isBesideCaret(glyph.rect, caret) ? glyph : null;
}

// The character that the cursor block is drawn on. There is none where the
// cursor stands at the end of a line or of the conversation.
function blockGlyph(
  doc: Document,
  viewport: HTMLElement,
  position: TextPosition,
): Glyph | null {
  const range = doc.createRange();
  const caret = caretLine(range, position);
  return glyphUnderCursor(doc, viewport, range, position, caret);
}

function behindBlock(
  doc: Document,
  viewport: HTMLElement,
  position: TextPosition,
): TextPosition {
  return blockGlyph(doc, viewport, position)?.end ?? position;
}

function cursorShape(
  doc: Document,
  viewport: HTMLElement,
  position: TextPosition,
): CursorShape | null {
  const range = doc.createRange();
  const caret = caretLine(range, position);
  const glyph = glyphUnderCursor(doc, viewport, range, position, caret)?.rect;
  if (glyph !== undefined) {
    const { left, top, width, height } = glyph;
    return { rect: { left, top, width, height }, isMark: false };
  }
  if (caret === null) return null;
  const { left, top, height } = caret;
  return { rect: { left, top, width: CARET_WIDTH_PX, height }, isMark: true };
}

function cursorRect(
  doc: Document,
  viewport: HTMLElement,
  position: TextPosition,
): CursorRect | null {
  return cursorShape(doc, viewport, position)?.rect ?? null;
}

function contentBox(element: Element): Box {
  const rect = element.getBoundingClientRect();
  const left = rect.left + element.clientLeft;
  const top = rect.top + element.clientTop;
  return {
    left,
    top,
    right: left + element.clientWidth,
    bottom: top + element.clientHeight,
  };
}

// The elements around a place, up to the scroller of the conversation, that
// cut off what overflows them: the box that shows the first lines of a long
// user message, a code block with a long line, the box of a reasoning text.
function clipBoxesOf(viewport: HTMLElement, node: Node): ClipBox[] {
  const view = viewport.ownerDocument.defaultView;
  const found: ClipBox[] = [];
  if (view === null) return found;
  let element = elementOf(node);
  while (element !== null && element !== viewport) {
    const { overflowX, overflowY } = view.getComputedStyle(element);
    const cuts =
      CLIPPING_OVERFLOWS.has(overflowX) || CLIPPING_OVERFLOWS.has(overflowY);
    if (cuts && element instanceof HTMLElement) {
      found.push({
        element,
        box: contentBox(element),
        scrollsX:
          SCROLLING_OVERFLOWS.has(overflowX) &&
          element.scrollWidth > element.clientWidth,
        scrollsY:
          SCROLLING_OVERFLOWS.has(overflowY) &&
          element.scrollHeight > element.clientHeight,
      });
    }
    element = element.parentElement;
  }
  return found;
}

// A character counts by where it starts. The narrow mark stands behind a
// character, at the right edge of it, and that is the right edge of a box
// that is as wide as its text: bb draws a message of the user in such a box,
// so the end of the widest line of the message is there, and the mark shows
// at that edge.
function isLeftOrRightOf(caret: CaretLine, box: Box, isMark: boolean): boolean {
  const rightEdge = isMark ? box.right + EDGE_ROOM_PX : box.right - EDGE_ROOM_PX;
  return caret.left < box.left - EDGE_ROOM_PX || caret.left > rightEdge;
}

function isAboveOrBelow(caret: CaretLine, box: Box): boolean {
  const middle = caret.top + caret.height / 2;
  return middle <= box.top || middle >= box.bottom;
}

// The place is in text that a box around it cuts off and that no box can be
// scrolled to, so that no cursor can be shown there. The boxes come from the
// innermost outwards. Once one of them scrolls in a direction, the boxes
// around it no longer count in that direction: bb puts a box that cuts off
// around each code block, and the text of a long line is outside that box
// until the code block inside it is scrolled there.
function isCutOff(
  caret: CaretLine,
  clipBoxes: readonly ClipBox[],
  isMark = false,
): boolean {
  let canScrollX = false;
  let canScrollY = false;
  for (const { box, scrollsX, scrollsY } of clipBoxes) {
    if (!canScrollX && !scrollsX && isLeftOrRightOf(caret, box, isMark)) return true;
    if (!canScrollY && !scrollsY && isAboveOrBelow(caret, box)) return true;
    canScrollX ||= scrollsX;
    canScrollY ||= scrollsY;
  }
  return false;
}

// The place does not show now: a box around it cuts it off, or would have to
// be scrolled first.
function isOutOfSight(
  caret: CaretLine,
  clipBoxes: readonly ClipBox[],
  isMark: boolean,
): boolean {
  return clipBoxes.some(
    ({ box }) => isLeftOrRightOf(caret, box, isMark) || isAboveOrBelow(caret, box),
  );
}

// A place where the cursor can be shown: it has a rectangle, which an empty
// element such as bb's layer for its selection menu or the stand-in for rows
// that are not loaded has not, and it is not in text that is cut off.
function canShowCursor(
  doc: Document,
  viewport: HTMLElement,
  position: TextPosition,
): boolean {
  if (!canMeasure(doc)) return true;
  const shape = cursorShape(doc, viewport, position);
  if (shape === null) return false;
  return !isCutOff(shape.rect, clipBoxesOf(viewport, position.node), shape.isMark);
}

// bb's message box is a sticky footer inside the scroller, so the lines under
// it are not visible although they are inside the scroller's rectangle.
function visibleBounds(viewport: HTMLElement): VisibleBounds {
  const rect = viewport.getBoundingClientRect();
  const footer = viewport
    .querySelector(SELECTORS.scrollFooter)
    ?.getBoundingClientRect();
  const hasFooter = footer !== undefined && footer.height > 0;
  const bottom = hasFooter ? Math.min(rect.bottom, footer.top) : rect.bottom;
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: Math.max(rect.top, bottom),
  };
}

function comfortBounds(bounds: VisibleBounds): VisibleBounds {
  const margin = Math.min(COMFORT_MARGIN_PX, (bounds.bottom - bounds.top) / 4);
  return { ...bounds, top: bounds.top + margin, bottom: bounds.bottom - margin };
}

function overlaps(rect: CursorRect, bounds: VisibleBounds): boolean {
  return (
    rect.top < bounds.bottom &&
    rect.top + rect.height > bounds.top &&
    rect.left < bounds.right &&
    rect.left + rect.width > bounds.left
  );
}

function fitsBetween(rect: CursorRect, bounds: VisibleBounds): boolean {
  return rect.top >= bounds.top && rect.top + rect.height <= bounds.bottom;
}

function showsBetween(rect: CursorRect, bounds: VisibleBounds): boolean {
  return rect.top < bounds.bottom && rect.top + rect.height > bounds.top;
}

function visibleCursorRect(doc: Document, current: CopySession): CursorRect | null {
  const { viewport, cursor } = current;
  const shape = cursorShape(doc, viewport, cursor);
  if (shape === null) return null;
  const { rect, isMark } = shape;
  if (!overlaps(rect, visibleBounds(viewport))) return null;
  return isOutOfSight(rect, clipBoxesOf(viewport, cursor.node), isMark) ? null : rect;
}

function isSameRect(a: CursorRect | null, b: CursorRect | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

function publish(doc: Document, current: CopySession): void {
  const selecting = current.anchor !== null;
  const cursor = visibleCursorRect(doc, current);
  const shown = getUiState().copyMode;
  if (
    shown.active &&
    shown.selecting === selecting &&
    isSameRect(shown.cursor, cursor)
  ) {
    return;
  }
  updateUiState({ copyMode: { active: true, selecting, cursor } });
}

function scrollDistance(rect: CursorRect, bounds: VisibleBounds): number {
  if (rect.top < bounds.top) return rect.top - bounds.top;
  const below = rect.top + rect.height - bounds.bottom;
  return below > 0 ? below : 0;
}

function scrollNeeded(start: number, end: number, from: number, to: number): number {
  const margin = Math.min(COMFORT_MARGIN_PX, (to - from) / 4);
  if (start < from + margin) return start - (from + margin);
  return end > to - margin ? end - (to - margin) : 0;
}

// A box inside the conversation that scrolls by itself, such as a code block
// with a long line or the box of a reasoning text, is scrolled to the cursor.
// The innermost box comes first, because it moves the cursor in the others.
function revealInScrollBoxes(doc: Document, current: CopySession): void {
  const { viewport, cursor } = current;
  for (const { element, scrollsX, scrollsY } of clipBoxesOf(viewport, cursor.node)) {
    const rect = cursorRect(doc, viewport, cursor);
    if (rect === null) return;
    const box = contentBox(element);
    if (scrollsX) {
      element.scrollLeft += scrollNeeded(
        rect.left,
        rect.left + rect.width,
        box.left,
        box.right,
      );
    }
    if (scrollsY) {
      element.scrollTop += scrollNeeded(
        rect.top,
        rect.top + rect.height,
        box.top,
        box.bottom,
      );
    }
  }
}

// For a cursor that was put on a line and not moved there by a key: a box
// that hides it, as a code block that is scrolled sideways hides the start
// of its lines, is scrolled to it. A cursor that shows stays where it is in
// its box.
function revealHiddenCursor(doc: Document, current: CopySession): void {
  if (visibleCursorRect(doc, current) !== null) return;
  revealInScrollBoxes(doc, current);
}

function revealCursor(doc: Document, current: CopySession): void {
  revealInScrollBoxes(doc, current);
  const rect = cursorRect(doc, current.viewport, current.cursor);
  if (rect === null) return;
  const bounds = visibleBounds(current.viewport);
  if (bounds.bottom <= bounds.top) return;
  const distance = scrollDistance(rect, comfortBounds(bounds));
  if (distance === 0 || getTimelineViewport(doc) !== current.viewport) return;
  scrollTimelineBy(distance, doc);
}

function caretFromPoint(doc: Document, x: number, y: number): TextPosition | null {
  if (typeof doc.caretPositionFromPoint === "function") {
    const caret = doc.caretPositionFromPoint(x, y);
    return caret === null ? null : { node: caret.offsetNode, offset: caret.offset };
  }
  if (typeof doc.caretRangeFromPoint !== "function") return null;
  const range = doc.caretRangeFromPoint(x, y);
  if (range === null) return null;
  return { node: range.startContainer, offset: range.startOffset };
}

function probeHeights(bounds: VisibleBounds, place: ScreenPlace): number[] {
  const heights: number[] = [];
  const last = bounds.bottom - PROBE_INSET_PX;
  for (let y = bounds.top + PROBE_INSET_PX; y <= last; y += PROBE_STEP_PX) {
    heights.push(y);
  }
  if (place === "top") return heights;
  if (place === "bottom") return heights.reverse();
  const middle = (bounds.top + bounds.bottom) / 2;
  return heights.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
}

function isVisibleText(
  doc: Document,
  viewport: HTMLElement,
  bounds: VisibleBounds,
  position: TextPosition,
): boolean {
  if (!isText(position.node)) return false;
  if (!isInsideConversation(viewport, position.node)) return false;
  const rect = cursorRect(doc, viewport, position);
  return rect === null || fitsBetween(rect, bounds);
}

// The lookup returns the text nearest to a point, so a point in the page
// margin finds the line beside it and a point in a picture finds a line that
// may be off screen. Hence the two columns and the check that the line shows.
function findVisibleLine(
  doc: Document,
  viewport: HTMLElement,
  place: ScreenPlace,
): TextPosition | null {
  const bounds = comfortBounds(visibleBounds(viewport));
  const columns = [bounds.left + PROBE_INSET_PX, (bounds.left + bounds.right) / 2];
  let rejected: TextPosition | null = null;
  for (const y of probeHeights(bounds, place)) {
    for (const x of columns) {
      const position = caretFromPoint(doc, x, y);
      if (position === null) continue;
      if (rejected !== null && isSamePosition(position, rejected)) continue;
      if (isVisibleText(doc, viewport, bounds, position)) return position;
      rejected = position;
    }
  }
  return null;
}

function isRendered(element: Element): boolean {
  if (typeof element.checkVisibility !== "function") return true;
  return element.checkVisibility({ visibilityProperty: true });
}

function isReadableText(viewport: HTMLElement, node: Node): node is Text {
  if (!isText(node) || node.data.trim() === "") return false;
  if (!isInsideConversation(viewport, node)) return false;
  return node.parentElement !== null && isRendered(node.parentElement);
}

function findEdgeText(
  doc: Document,
  viewport: HTMLElement,
  edge: TextEdge,
): TextPosition | null {
  const walker = doc.createTreeWalker(viewport, NodeFilter.SHOW_TEXT);
  let node = edge === "start" ? walker.nextNode() : walker.lastChild();
  while (node !== null) {
    if (isReadableText(viewport, node)) {
      return { node, offset: edge === "start" ? 0 : node.length };
    }
    node = edge === "start" ? walker.nextNode() : walker.previousNode();
  }
  return null;
}

function isSelectionAt(
  selection: Selection,
  anchor: TextPosition,
  focus: TextPosition,
): boolean {
  return (
    selection.rangeCount > 0 &&
    selection.anchorNode === anchor.node &&
    selection.anchorOffset === anchor.offset &&
    selection.focusNode === focus.node &&
    selection.focusOffset === focus.offset
  );
}

// Left alone when it already matches: setting a selection again makes the
// browser forget the column that line moves try to keep.
function placeSelection(
  selection: Selection,
  current: CopySession,
  anchor: TextPosition | null,
  focus: TextPosition,
): void {
  if (isSelectionAt(selection, anchor ?? focus, focus)) return;
  current.hasColumn = false;
  if (anchor === null) {
    selection.collapse(focus.node, focus.offset);
    return;
  }
  selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

// The selection as every move needs it: from where it was started to the
// cursor, which is where the browser moves on from.
function selectToCursor(selection: Selection, current: CopySession): void {
  placeSelection(selection, current, current.anchor, current.cursor);
}

function selectsUnderBlock(): boolean {
  return getBridge()?.tmux.options.modeKeys === "vi";
}

// The selection as it is shown and copied. With tmux's emacs keys it ends in
// front of the character under the cursor block. With its vi keys it takes
// that character in, and the one the selection was started on, whichever of
// the two comes first (window_copy_get_selection in window-copy.c of tmux
// 3.5a).
function showSelection(
  doc: Document,
  selection: Selection,
  current: CopySession,
): void {
  const { anchor, anchorEnd, cursor, viewport } = current;
  if (anchor === null || !selectsUnderBlock()) {
    selectToCursor(selection, current);
    return;
  }
  if (!isAfter(doc, anchor, cursor)) {
    placeSelection(selection, current, anchor, behindBlock(doc, viewport, cursor));
    return;
  }
  const isEndLoaded = anchorEnd !== null && anchorEnd.node.isConnected;
  const start = isEndLoaded ? clampPosition(anchorEnd) : anchor;
  placeSelection(selection, current, start, cursor);
}

// Every move starts with the selection between where it was started and the
// cursor. A run of line moves only goes on with another line move, so it is
// taken from the session here, and a line move puts it back. The browser no
// longer knows the column of the run when copy mode has set the selection
// since, or something else has, which shows in where the selection is.
function beginMove(
  doc: Document,
  selection: Selection,
  current: CopySession,
): MoveContext {
  const { anchor, cursor, lineRun } = current;
  const hasColumn =
    current.hasColumn && isSelectionAt(selection, anchor ?? cursor, cursor);
  current.lineRun = null;
  selectToCursor(selection, current);
  return {
    doc,
    selection,
    session: current,
    selectsUnderBlock: selectsUnderBlock(),
    lineRun,
    hasColumn,
    activeRun: null,
  };
}

// A selection that has left the conversation since, such as the caret of the
// message box after bb focused it, is not copy mode's to clear.
function clearOwnSelection(doc: Document, viewport: HTMLElement): void {
  const selection = doc.getSelection();
  if (selection === null) return;
  if (!isInsideConversation(viewport, selection.anchorNode)) return;
  if (!isInsideConversation(viewport, selection.focusNode)) return;
  selection.removeAllRanges();
}

function isSameLine(a: CaretLine, b: CaretLine): boolean {
  const overlap =
    Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return overlap >= Math.min(a.height, b.height) / 2;
}

// Two places that the cursor is drawn at alike: on the same line and at the
// same column. Not so where one of them has no rectangle.
function isSamePlace(a: CaretLine | null, b: CaretLine | null): boolean {
  if (a === null || b === null) return false;
  return isSameLine(a, b) && Math.abs(a.left - b.left) <= SAME_COLUMN_PX;
}

// The line is another one than the reference, further on in the direction of
// the move.
function isPastLine(line: CaretLine, reference: CaretLine, isForward: boolean): boolean {
  if (isSameLine(line, reference)) return false;
  return isForward ? line.top > reference.top : line.top < reference.top;
}

// Two lines with nothing but the usual room between them. A wider gap can
// hold a line that the browser jumped over.
function isAdjacentLine(line: CaretLine, reference: CaretLine): boolean {
  const gap =
    Math.max(line.top, reference.top) -
    Math.min(line.top + line.height, reference.top + reference.height);
  return gap <= ADJACENT_LINE_GAP * Math.min(line.height, reference.height);
}

function isSurrogatePairEnd(text: string, at: number): boolean {
  const unit = text.charCodeAt(at);
  return at > 0 && unit >= 0xdc00 && unit <= 0xdfff;
}

function characterEndAfter(text: string, start: number): number {
  const cluster = text.slice(start, start + MAX_CLUSTER_LENGTH);
  return Math.min(text.length, start + characterLength(cluster));
}

// Where the character starts that a place in a text is in.
function characterStartAt(text: string, at: number): number {
  if (typeof Intl.Segmenter !== "function") {
    return isSurrogatePairEnd(text, at) ? at - 1 : at;
  }
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return graphemes.segment(text).containing(at)?.index ?? at;
}

// Where the character starts that ends at a place in a text. Only the code
// units right in front of the place are looked at, as characterEndAfter
// looks at the ones behind it, so that a long text costs no more than a
// short one.
function characterStartBefore(text: string, end: number): number {
  const from = Math.max(0, end - MAX_CLUSTER_LENGTH);
  return from + characterStartAt(text.slice(from, end), end - from - 1);
}

function stepWalker(walker: TreeWalker, isForward: boolean): Node | null {
  return isForward ? walker.nextNode() : walker.previousNode();
}

// The place in front of an element, or the one behind it.
function placeBeside(element: Element, isBehind: boolean): TextPosition | null {
  const { parentNode } = element;
  if (parentNode === null) return null;
  const index = Array.prototype.indexOf.call(parentNode.childNodes, element);
  return { node: parentNode, offset: isBehind ? index + 1 : index };
}

// The text of the conversation from a place on, piece by piece, forward or
// backward. start is where the first piece is entered.
function* textFrom(
  doc: Document,
  viewport: HTMLElement,
  from: TextPosition,
  isForward: boolean,
): Generator<{ node: Text; start: number }> {
  const walker = doc.createTreeWalker(viewport, NodeFilter.SHOW_TEXT);
  if (isText(from.node)) {
    yield { node: from.node, start: from.offset };
    walker.currentNode = from.node;
  } else {
    const child: Node | undefined = from.node.childNodes[from.offset];
    const marker = doc.createRange();
    marker.setStart(from.node, from.offset);
    marker.collapse(true);
    walker.currentNode = child ?? from.node;
    // The first piece is looked for by its place: the first text behind the
    // place, which can be the node that the walker starts at, or the last
    // one before it.
    const isFirstPiece = isForward && child !== undefined && isText(child);
    let node = isFirstPiece ? child : stepWalker(walker, isForward);
    while (node !== null && isForward !== marker.comparePoint(node, 0) >= 0) {
      node = stepWalker(walker, isForward);
    }
    if (node === null) return;
    yield { node: node as Text, start: isForward ? 0 : (node as Text).length };
  }
  let next = stepWalker(walker, isForward);
  while (next !== null) {
    yield { node: next as Text, start: isForward ? 0 : (next as Text).length };
    next = stepWalker(walker, isForward);
  }
}

// The characters of the conversation that have a rectangle, from a place on.
function* charactersFrom(
  doc: Document,
  viewport: HTMLElement,
  from: TextPosition,
  isForward: boolean,
): Generator<CharacterBox> {
  const range = doc.createRange();
  for (const { node, start } of textFrom(doc, viewport, from, isForward)) {
    if (!isInsideConversation(viewport, node)) continue;
    let at = start;
    while (isForward ? at < node.length : at > 0) {
      const offset = isForward ? at : characterStartBefore(node.data, at);
      const end = isForward ? characterEndAfter(node.data, at) : at;
      at = isForward ? end : offset;
      range.setStart(node, offset);
      range.setEnd(node, end);
      const rect = rectsOf(range).find((box) => box.height > 0);
      if (rect !== undefined) yield { node, offset, end, rect };
    }
  }
}

function lineOfRect(rect: DOMRect): CaretLine {
  return { left: rect.left, top: rect.top, height: rect.height };
}

// The place in front of a character that no box cuts off is one where the
// cursor can stand: the character is drawn, or it is the line break of an
// empty line.
function isStop(character: CharacterBox): boolean {
  if (character.rect.width > 0) return true;
  return isAtEmptyLine(character.node, character.offset);
}

// The box that a place is in when its line is drawn as a box of its own, as
// bb draws each line of a highlighted code block.
function lineBoxOf(viewport: HTMLElement, node: Node): Element | null {
  const view = viewport.ownerDocument.defaultView;
  if (view === null) return null;
  let element = elementOf(node);
  while (element !== null && element !== viewport) {
    if (view.getComputedStyle(element).display === LINE_BOX_DISPLAY) return element;
    element = element.parentElement;
  }
  return null;
}

function isInLineBox(viewport: HTMLElement, node: Node): boolean {
  return lineBoxOf(viewport, node) !== null;
}

// The box of a line that is not wrapped: it is as high as the one line that
// it holds, so all of its text is on that line, however long it is. The
// height of a line is the one that the box is styled with, and that of the
// characters of the line where the style names none.
function unwrappedLineBoxOf(
  viewport: HTMLElement,
  node: Node,
  line: CaretLine,
): Element | null {
  const view = viewport.ownerDocument.defaultView;
  const box = lineBoxOf(viewport, node);
  if (box === null || view === null) return null;
  const styled = Number.parseFloat(view.getComputedStyle(box).lineHeight);
  const lineHeight = styled > 0 ? styled : line.height;
  const { height } = box.getBoundingClientRect();
  return height < WRAPPED_BOX_LINES * lineHeight ? box : null;
}

// The line of a place in preformatted text that is not wrapped, as bb draws
// the code of a block that it does not highlight and the output of a tool:
// all of that text is one piece, and a line of it runs from one line break
// to the next, however long it is. null for other text.
function unwrappedTextLineAt(
  viewport: HTMLElement,
  node: Node,
  offset: number,
): TextLine | null {
  const view = viewport.ownerDocument.defaultView;
  if (view === null || !isText(node) || node.parentElement === null) return null;
  const { whiteSpace } = view.getComputedStyle(node.parentElement);
  if (whiteSpace !== UNWRAPPED_WHITE_SPACE) return null;
  const start = offset === 0 ? 0 : node.data.lastIndexOf(LINE_BREAK, offset - 1) + 1;
  const next = node.data.indexOf(LINE_BREAK, offset);
  return { node, start, end: next === -1 ? node.length : next };
}

// The place beside a line that is not wrapped, in the direction of a move:
// beside the box of the line, or at the line break of its piece of text. All
// of the line lies on the other side of that place. null for another line.
function placeBesideLine(
  viewport: HTMLElement,
  from: TextPosition,
  fromLine: CaretLine,
  isForward: boolean,
): TextPosition | null {
  const box = unwrappedLineBoxOf(viewport, from.node, fromLine);
  if (box !== null) return placeBeside(box, isForward);
  const textLine = unwrappedTextLineAt(viewport, from.node, from.offset);
  if (textLine === null) return null;
  return { node: textLine.node, offset: isForward ? textLine.end : textLine.start };
}

// The characters of one line that the cursor can stand in front of, as they
// are met from a place on. The line is that of the first of them that
// isOnLine accepts, and the scan ends where that line does, or with the
// character that isLast accepts. The characters that a box cuts off are
// passed over and have a bound of their own: the lines that a long user
// message hides lie between the last line that it shows and the text behind
// it, and would use up the bound of the scan.
function scanLine(
  context: MoveContext,
  from: TextPosition,
  isForward: boolean,
  isOnLine: (line: CaretLine) => boolean,
  isLast: (character: CharacterBox) => boolean = () => false,
): CharacterBox[] {
  const { doc } = context;
  const { viewport } = context.session;
  const found: CharacterBox[] = [];
  let line: CaretLine | null = null;
  let clipNode: Text | null = null;
  let clipBoxes: ClipBox[] = [];
  let scanned = 0;
  let passed = 0;
  for (const character of charactersFrom(doc, viewport, from, isForward)) {
    const characterLine = lineOfRect(character.rect);
    if (line !== null && !isSameLine(characterLine, line)) break;
    if (clipNode !== character.node) {
      clipNode = character.node;
      clipBoxes = clipBoxesOf(viewport, character.node);
    }
    if (isCutOff(characterLine, clipBoxes)) {
      passed += 1;
      if (passed > MAX_PASSED_PLACES) break;
      continue;
    }
    scanned += 1;
    if (scanned > MAX_SCANNED_CHARACTERS) break;
    if (line === null && !isOnLine(characterLine)) continue;
    if (!isStop(character)) continue;
    line ??= characterLine;
    found.push(character);
    if (isLast(character)) break;
  }
  return found;
}

function columnOf(context: MoveContext, fallback: CaretLine): number {
  const origin = context.activeRun?.origin;
  if (origin === undefined) return fallback.left;
  return caretLine(context.doc.createRange(), origin)?.left ?? fallback.left;
}

// As the browser does it: the caret goes to the edge of a character that is
// nearest to the column, so the place in front of a character is taken when
// the column is left of the middle of that character.
function isRightOfColumn(
  { left, right }: { left: number; right: number },
  column: number,
): boolean {
  return column < (left + right) / 2;
}

function stopAtColumn(stops: readonly LineStop[], column: number): TextPosition {
  const stop =
    stops.find((candidate) => isRightOfColumn(candidate, column)) ??
    stops[stops.length - 1];
  return stop.position;
}

function stopsOf(characters: readonly CharacterBox[], endsLine: boolean): LineStop[] {
  const stops = characters.map(({ node, offset, rect }) => ({
    position: { node, offset },
    left: rect.left,
    right: rect.right,
  }));
  const last = characters[characters.length - 1];
  if (endsLine && last.rect.width > 0) {
    stops.push({
      position: { node: last.node, offset: last.end },
      left: last.rect.right,
      right: last.rect.right,
    });
  }
  return stops;
}

// Every place on the line of a character, from left to right. The last one
// is the end of the line.
function stopsOnLine(
  context: MoveContext,
  first: CharacterBox,
  isForward: boolean,
): LineStop[] {
  const line = lineOfRect(first.rect);
  const nearSide = { node: first.node, offset: isForward ? first.offset : first.end };
  const found = scanLine(context, nearSide, isForward, (other) =>
    isSameLine(other, line),
  );
  return stopsOf(isForward ? found : found.reverse(), true);
}

function textsIn(doc: Document, element: Element): Text[] {
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node as Text).length > 0) texts.push(node as Text);
  }
  return texts;
}

function drawnRectOf(range: Range): DOMRect | undefined {
  return rectsOf(range).find((rect) => rect.height > 0);
}

// In a line that is not wrapped the characters stand from left to right, so
// the last one of a stretch of text that starts at or left of a column is
// found by halving. null where the text has no rectangle.
function offsetAtColumn(
  range: Range,
  text: Text,
  from: number,
  to: number,
  column: number,
): number | null {
  let start = from;
  let end = to - 1;
  while (start < end) {
    const middle = Math.ceil((start + end) / 2);
    range.setStart(text, from);
    range.setEnd(text, middle);
    const drawn = drawnRectOf(range);
    if (drawn === undefined) return null;
    if (drawn.right <= column) start = middle;
    else end = middle - 1;
  }
  return characterStartAt(text.data, start);
}

// The same for a line that is drawn in a box of its own: first among the
// texts of the box, then in the text that holds the column.
function placeAtColumn(doc: Document, box: Element, column: number): TextPosition | null {
  const range = doc.createRange();
  const texts = textsIn(doc, box);
  if (texts.length === 0) return null;
  let first = 0;
  let last = texts.length - 1;
  while (first < last) {
    const middle = Math.ceil((first + last) / 2);
    range.selectNodeContents(texts[middle]);
    const drawn = drawnRectOf(range);
    if (drawn === undefined) return null;
    if (drawn.left <= column) first = middle;
    else last = middle - 1;
  }
  const text = texts[first];
  const offset = offsetAtColumn(range, text, 0, text.length, column);
  return offset === null ? null : { node: text, offset };
}

// A line starts at a place: no character in front of the place is drawn on
// the line. A box inside a line, as the one of a formula behind the words of
// a paragraph, does not hold its line from the start on: the places left of
// it on the line are not in it.
function startsLine(
  context: MoveContext,
  inFront: TextPosition | null,
  line: CaretLine,
): boolean {
  const { doc } = context;
  if (inFront === null) return true;
  const previous = charactersFrom(doc, context.session.viewport, inFront, false).next();
  return previous.done === true || !isSameLine(lineOfRect(previous.value.rect), line);
}

// The place of the last character at or left of a column on the line of a
// character, for a line that is not wrapped: one that is drawn in a box of
// its own, or one of preformatted text. null for another line, and for one
// that does not hold the line from its start on.
function unwrappedPlaceAtColumn(
  context: MoveContext,
  first: CharacterBox,
  line: CaretLine,
  column: number,
): TextPosition | null {
  const { doc } = context;
  const { viewport } = context.session;
  const box = unwrappedLineBoxOf(viewport, first.node, line);
  if (box !== null) {
    if (!startsLine(context, placeBeside(box, false), line)) return null;
    return placeAtColumn(doc, box, column);
  }
  const textLine = unwrappedTextLineAt(viewport, first.node, first.offset);
  if (textLine === null || textLine.start === textLine.end) return null;
  const { node, start, end } = textLine;
  if (!startsLine(context, { node, offset: start }, line)) return null;
  const offset = offsetAtColumn(doc.createRange(), node, start, end, column);
  return offset === null ? null : { node, offset };
}

// The places at a column on the line of a character, for a line that is not
// wrapped. null for another line.
function stopsAtColumn(
  context: MoveContext,
  first: CharacterBox,
  column: number,
): LineStop[] | null {
  const line = lineOfRect(first.rect);
  const start = unwrappedPlaceAtColumn(context, first, line, column);
  if (start === null) return null;
  const found = scanLine(
    context,
    start,
    true,
    (other) => isSameLine(other, line),
    ({ rect }) => isRightOfColumn(rect, column),
  );
  if (found.length === 0) return null;
  const last = found[found.length - 1];
  return stopsOf(found, !isRightOfColumn(last.rect, column));
}

// The nearest line in the direction of the move that the cursor can stand
// on, found by the rectangles of the characters, with places on it from left
// to right. null when the text that was looked through has no such line.
//
// A line of code can be thousands of characters long, and Chromium takes
// milliseconds to measure 1000 characters one by one, and longer the longer
// their line is. A line that is not wrapped, one that is drawn in a box of
// its own or one of preformatted text, is therefore not looked through:
// from such a line the search starts beside it, and on such a line only the
// places at the column of the move are looked up.
function findNextLine(
  context: MoveContext,
  from: TextPosition,
  fromLine: CaretLine,
  isForward: boolean,
): FoundLine | null {
  const beside = placeBesideLine(context.session.viewport, from, fromLine, isForward);
  const [first] = scanLine(
    context,
    beside ?? from,
    isForward,
    (other) => isPastLine(other, fromLine, isForward),
    () => true,
  );
  if (first === undefined) return null;
  const stops =
    stopsAtColumn(context, first, columnOf(context, fromLine)) ??
    stopsOnLine(context, first, isForward);
  return { line: lineOfRect(first.rect), stops };
}

// A move by a line without a selection under way moves the caret itself. The
// selection then already is where the cursor ends up, so that it is not set
// again after the move, which would make the browser forget the column that
// line moves try to keep.
function alterationOf(context: MoveContext, step: ModifyStep): "move" | "extend" {
  const movesCaret =
    context.session.anchor === null && step.granularity === "line";
  return movesCaret ? "move" : "extend";
}

function extendTo(context: MoveContext, target: TextPosition): void {
  context.selection.extend(target.node, target.offset);
}

// Puts the end of the selection that moves at a place, as the step of the
// browser before it did: without a selection under way that is the caret.
function moveFocusTo(context: MoveContext, target: TextPosition): void {
  if (context.session.anchor === null) {
    context.selection.collapse(target.node, target.offset);
    return;
  }
  extendTo(context, target);
}

function focusOf(selection: Selection): TextPosition | null {
  const { focusNode, focusOffset } = selection;
  return focusNode === null ? null : { node: focusNode, offset: focusOffset };
}

function labelOf(node: Node): Element | null {
  return elementOf(node)?.closest(LABEL_SELECTOR) ?? null;
}

// The nearest place beside a label of bb that text is drawn at: in front of
// the first character behind it, as the first one of the code under a header,
// or behind the last character of the text in front of it.
function placePastLabel(
  doc: Document,
  viewport: HTMLElement,
  label: Element,
  isForward: boolean,
): TextPosition | null {
  const from = placeBeside(label, isForward);
  if (from === null) return null;
  const nearest = charactersFrom(doc, viewport, from, isForward).next();
  if (nearest.done === true) return null;
  const { node, offset, end } = nearest.value;
  return { node, offset: isForward ? offset : end };
}

function isLineBreakElement(node: Node | null): boolean {
  return node !== null && isElement(node) && node.localName === LINE_BREAK_ELEMENT;
}

// The place in front of the first character that is drawn behind a place
// between two nodes, where a text follows that place and starts a line: the
// blanks that such a text starts with are not drawn. null for another place,
// and for a line that holds no character.
function firstCharacterBehind(doc: Document, place: TextPosition): TextPosition | null {
  const { node, offset } = place;
  if (isText(node)) return null;
  const first: Node | undefined = node.childNodes[offset];
  if (first === undefined || !isText(first)) return null;
  const range = doc.createRange();
  const walker = doc.createTreeWalker(
    node,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  walker.currentNode = first;
  for (let next: Node | null = first; next !== null; next = walker.nextNode()) {
    if (isLineBreakElement(next)) return null;
    if (!isText(next)) continue;
    for (let at = 0; at < next.length; at = characterEndAfter(next.data, at)) {
      if (glyphAt(range, next, at) !== null) return { node: next, offset: at };
      if (!BLANK.test(next.data[at])) return null;
    }
  }
  return null;
}

// Chromium gives the start of a line that follows a line break element as
// the place in front of the text behind that element. bb puts a line break
// there that is not drawn, behind each line of a message of the user, so
// the place has no caret and no character under it. The place in front of
// the first character of that line, or null for another place.
function lineStartBehindBreak(doc: Document, place: TextPosition): TextPosition | null {
  const { node, offset } = place;
  if (isText(node) || !isLineBreakElement(node.childNodes[offset - 1] ?? null)) {
    return null;
  }
  return firstCharacterBehind(doc, place);
}

// Where a step of the browser ended, or null where that is outside the
// conversation. A label of bb is no place for the cursor. A step that ends in
// one goes on to the first character behind it when it came from in front of
// the label, as to the first one of the code under a header, and to the end
// of the text in front of it when it came from behind it. A step by a line
// that ends there counts as one that left the conversation, so that the line
// is looked up, which keeps the column. A step that ends at the start of a
// line behind a line break element goes on to the first character of that
// line. A step by a line does not: it is left to the lookup of the line as
// well, because putting the cursor there makes the browser forget its column.
function placeReached(
  context: MoveContext,
  step: ModifyStep,
  from: TextPosition | null,
): TextPosition | null {
  const { doc } = context;
  const { viewport } = context.session;
  const reached = focusOf(context.selection);
  if (reached === null) return null;
  if (isInsideConversation(viewport, reached.node)) {
    if (step.granularity === "line") return reached;
    const lineStart = lineStartBehindBreak(doc, reached);
    if (lineStart === null) return reached;
    moveFocusTo(context, lineStart);
    return lineStart;
  }
  const label = labelOf(reached.node);
  if (label === null || step.granularity === "line") return null;
  const around = doc.createRange();
  around.selectNode(label);
  const isForward = from === null || around.comparePoint(from.node, from.offset) < 0;
  const past = placePastLabel(doc, viewport, label, isForward);
  if (past !== null) moveFocusTo(context, past);
  return past;
}

// In a code block that bb draws line by line, the browser's step back by a
// character from the start of a line stops behind the box of the line
// before, where no cursor can be shown, and the step that is made again from
// there lands on the last character of that line. The place behind that
// character, which is the end of the line and where the step forward stops,
// is passed over. That place, for a step from origin that passed over it.
function lineEndPassed(
  context: MoveContext,
  step: ModifyStep,
  origin: TextPosition | null,
  reached: TextPosition,
): TextPosition | null {
  const { doc } = context;
  const { viewport } = context.session;
  if (origin === null || step.granularity !== "character") return null;
  if (!isAfter(doc, origin, reached)) return null;
  const end = blockGlyph(doc, viewport, reached)?.end;
  if (end === undefined || !isAfter(doc, origin, end)) return null;
  const between = doc.createRange();
  between.setStart(end.node, end.offset);
  between.setEnd(origin.node, origin.offset);
  if (between.toString() !== LINE_BREAK) return null;
  return canShowCursor(doc, viewport, end) ? end : null;
}

function anchorOf(selection: Selection): TextPosition | null {
  const { anchorNode, anchorOffset } = selection;
  return anchorNode === null ? null : { node: anchorNode, offset: anchorOffset };
}

// A step that the caret makes alone, from the end of the selection that
// moves. The selection is then put back from the end that stays.
function modifyByCaret(
  context: MoveContext,
  step: ModifyStep,
  anchor: TextPosition,
  focus: TextPosition,
): void {
  const { selection } = context;
  selection.collapse(focus.node, focus.offset);
  selection.modify("move", step.direction, step.granularity);
  const reached = focusOf(selection) ?? focus;
  selection.setBaseAndExtent(anchor.node, anchor.offset, reached.node, reached.offset);
}

// Moves the end of the selection that moves by one step of the browser.
// Chromium on macOS does not take that end of a selection that is not
// collapsed as far as it takes the caret, in two cases, and the step is then
// made by the caret alone. On a step to the start or the end of a line it
// grows the selection: it moves the end that lies in the direction of the
// step, from where that end is, and that can be the end that the selection
// was started at. On a step by a word, a paragraph or a line that would take
// the end that moves across the end that stays, it stops at that end, which
// leaves the selection collapsed, where tmux goes on. That only matters
// while a selection is under way, and a run of line moves that began at that
// end has come back to it at its own column and has not been stopped. After
// the step by the caret the browser no longer knows the column of the run,
// so the run keeps the column itself from there on.
function modifyFocus(context: MoveContext, step: ModifyStep): void {
  const { selection, activeRun } = context;
  const anchor = anchorOf(selection);
  const focus = focusOf(selection);
  if (selection.isCollapsed || anchor === null || focus === null) {
    selection.modify(alterationOf(context, step), step.direction, step.granularity);
    return;
  }
  if (BOUNDARY_GRANULARITIES.has(step.granularity)) {
    modifyByCaret(context, step, anchor, focus);
    return;
  }
  selection.modify(alterationOf(context, step), step.direction, step.granularity);
  if (!selection.isCollapsed || !STOPPING_GRANULARITIES.has(step.granularity)) return;
  if (context.session.anchor === null) return;
  if (activeRun !== null && isSamePosition(anchor, activeRun.origin)) return;
  modifyByCaret(context, step, anchor, focus);
  if (activeRun !== null) activeRun.isColumnOurs = true;
}

// Chromium does not take a caret that stands in front of a box inside a
// paragraph across that box, as across a picture, which bb draws as a block
// of its own: a step by a character, a word or a paragraph ends where it
// began. The place on the other side of the box, for such a step from a
// place that is in front of an element in the direction of the step.
function placeAcrossBox(from: TextPosition, step: ModifyStep): TextPosition | null {
  if (!CROSSING_GRANULARITIES.has(step.granularity)) return null;
  const { node, offset } = from;
  if (isText(node)) return null;
  const isForward = step.direction === "forward" || step.direction === "right";
  const box: Node | undefined = node.childNodes[isForward ? offset : offset - 1];
  if (box === undefined || !isElement(box)) return null;
  return { node, offset: isForward ? offset + 1 : offset - 1 };
}

// Where one step of the browser from a place ended. A step that ended where
// it began in front of a box is taken across that box, to the first
// character of the text that follows the box on a line of its own.
function stepFrom(
  context: MoveContext,
  step: ModifyStep,
  from: TextPosition | null,
): TextPosition | null {
  modifyFocus(context, step);
  const reached = placeReached(context, step, from);
  if (reached === null || from === null || !isSamePosition(reached, from)) {
    return reached;
  }
  const across = placeAcrossBox(from, step);
  if (across === null) return reached;
  if (!isInsideConversation(context.session.viewport, across.node)) return reached;
  const landed = firstCharacterBehind(context.doc, across) ?? across;
  moveFocusTo(context, landed);
  return landed;
}

// One step of the browser. A place where no cursor can be shown is passed
// over: the step is made again from there, so that the cursor never stands
// in bb's empty layers or in the lines that a long user message hides. null
// for a step that leaves the conversation or that gets nowhere.
function extendBy(context: MoveContext, step: ModifyStep): TextPosition | null {
  const { doc, selection } = context;
  const { viewport } = context.session;
  const origin = focusOf(selection);
  let passed: TextPosition | null = null;
  for (let count = 0; count < MAX_PASSED_PLACES; count += 1) {
    const from = passed ?? origin;
    const reached = stepFrom(context, step, from);
    if (reached === null) return null;
    if (passed !== null && isSamePosition(reached, passed)) return null;
    if (!canShowCursor(doc, viewport, reached)) {
      passed = reached;
      continue;
    }
    const lineEnd = lineEndPassed(context, step, origin, reached);
    if (lineEnd === null) return reached;
    moveFocusTo(context, lineEnd);
    return lineEnd;
  }
  return null;
}

// Puts the cursor on a line that was looked up, at the column of the run.
function takeLine(
  context: MoveContext,
  next: FoundLine,
  fromLine: CaretLine,
): TextPosition {
  const run = context.activeRun;
  if (run !== null) run.isColumnOurs = true;
  const target = stopAtColumn(next.stops, columnOf(context, fromLine));
  moveFocusTo(context, target);
  return target;
}

// The line of a place is one of a code block: one that bb draws as a box of
// its own, or one of preformatted text that is not wrapped.
function isOnCodeLine(viewport: HTMLElement, place: TextPosition): boolean {
  if (isInLineBox(viewport, place.node)) return true;
  return unwrappedTextLineAt(viewport, place.node, place.offset) !== null;
}

// One move by a line. In a code block bb draws every line as a box of its
// own. The browser's move from such a box jumps over the lines that follow,
// and in Chromium it takes longer the longer the block is: over half a
// second in a block of 300 lines. Code that bb does not highlight is
// preformatted text in a box that scrolls sideways to the cursor, and the
// browser keeps the column of its line moves as a place in the window, which
// that scroll takes away from the text. So from a line of either kind the
// next line is looked up from the rectangles of the text, and the browser is
// only asked where that finds none. Elsewhere the browser makes the move,
// and its result is taken when it is on the next line. After a move that got
// further than that, or nowhere, the next line is looked up as well.
function stepLine(
  context: MoveContext,
  step: ModifyStep,
  from: TextPosition,
): TextPosition | null {
  const isForward = step.direction === "forward";
  const range = context.doc.createRange();
  const fromLine = caretLine(range, from);
  if (fromLine === null) return extendBy(context, step);
  if (isOnCodeLine(context.session.viewport, from)) {
    const next = findNextLine(context, from, fromLine, isForward);
    return next === null ? extendBy(context, step) : takeLine(context, next, fromLine);
  }
  const reached = extendBy(context, step);
  const reachedLine = reached === null ? null : caretLine(range, reached);
  const isOnLaterLine =
    reached !== null &&
    reachedLine !== null &&
    isPastLine(reachedLine, fromLine, isForward);
  const run = context.activeRun;
  const keepsColumn = run !== null && run.isColumnOurs;
  if (isOnLaterLine && !keepsColumn && isAdjacentLine(reachedLine, fromLine)) {
    return reached;
  }
  const next = findNextLine(context, from, fromLine, isForward);
  if (next === null) return isOnLaterLine ? reached : null;
  const wasJumpedOver =
    !isOnLaterLine || isPastLine(reachedLine, next.line, isForward);
  if (!wasJumpedOver && !keepsColumn) return reached;
  if (!wasJumpedOver && !isSameLine(reachedLine, next.line)) return reached;
  return takeLine(context, next, fromLine);
}

// The places that the steps reach one after another, up to the first step
// that leaves the conversation or gets nowhere. isEnough ends the steps
// early.
function takeSteps(
  context: MoveContext,
  steps: readonly ModifyStep[],
  from: TextPosition,
  isEnough: (reached: TextPosition) => boolean = () => false,
): TextPosition[] {
  const reached: TextPosition[] = [];
  let last = from;
  for (const step of steps) {
    const next =
      step.granularity === "line"
        ? stepLine(context, step, last)
        : extendBy(context, step);
    if (next === null || isSamePosition(next, last)) break;
    reached.push(next);
    last = next;
    if (isEnough(next)) break;
  }
  return reached;
}

function stepOnce(context: MoveContext, step: ModifyStep): TextPosition {
  const from = context.session.cursor;
  return takeSteps(context, [step], from).at(-1) ?? from;
}

// Makes the line moves of a run again from where the run started, so that
// the browser knows their column again. False when they no longer lead to
// the cursor, as after bb changed the text.
function retakeLineRun(context: MoveContext, run: LineRun): boolean {
  const { selection, session: current } = context;
  if (!isInsideConversation(current.viewport, run.origin.node)) return false;
  const origin = clampPosition(run.origin);
  placeSelection(selection, current, current.anchor, origin);
  context.activeRun = run;
  const reached = takeSteps(context, run.steps, origin);
  context.activeRun = null;
  const last = reached.at(-1);
  if (last === undefined || reached.length < run.steps.length) return false;
  return isSamePosition(last, current.cursor);
}

// The column of the run is kept here and not by the browser, and the place
// that it comes from is still in the conversation.
function ownsColumn(context: MoveContext, run: LineRun): boolean {
  if (!run.isColumnOurs) return false;
  return isInsideConversation(context.session.viewport, run.origin.node);
}

// A run whose moves are too many to make again, and whose first place is
// still in the conversation, keeps its column itself from here on.
function takesColumnOver(context: MoveContext, run: LineRun): boolean {
  if (run.steps.length <= MAX_RETAKEN_LINE_MOVES) return false;
  if (!isInsideConversation(context.session.viewport, run.origin.node)) return false;
  run.origin = clampPosition(run.origin);
  run.isColumnOurs = true;
  return true;
}

// The run that the line moves of this move add to: the one before when its
// column is kept here, or when the browser still has its column or finds it
// again, and else a new one that starts at the cursor.
function resumeLineRun(context: MoveContext): LineRun {
  const { selection, session: current, lineRun } = context;
  const fresh: LineRun = { origin: current.cursor, steps: [], isColumnOurs: false };
  if (lineRun === null) return fresh;
  if (ownsColumn(context, lineRun) || context.hasColumn) return lineRun;
  if (takesColumnOver(context, lineRun)) return lineRun;
  if (retakeLineRun(context, lineRun)) return lineRun;
  selectToCursor(selection, current);
  return fresh;
}

// The browser keeps the column of line moves that follow each other for as
// long as nothing else sets the selection. Copy mode sets it when a selection
// is started or dropped, and with tmux's vi keys after every move while one
// is under way, to take in the character under the cursor block. The line
// moves before are then made again first, as long as they are few: a longer
// run is put on each line at the column that it started from.
function stepLines(
  context: MoveContext,
  step: ModifyStep,
  count: number,
  isEnough?: (reached: TextPosition) => boolean,
): TextPosition {
  const { session: current } = context;
  const wanted = Array.from({ length: count }, () => step);
  const run = resumeLineRun(context);
  context.activeRun = run;
  const reached = takeSteps(context, wanted, current.cursor, isEnough);
  context.activeRun = null;
  current.hasColumn = true;
  const steps = [...run.steps, ...wanted.slice(0, reached.length)];
  const isKept = steps.length > 0 && steps.length <= MAX_LINE_RUN_STEPS;
  current.lineRun = isKept
    ? { origin: run.origin, steps, isColumnOurs: run.isColumnOurs }
    : null;
  return reached.at(-1) ?? current.cursor;
}

// The place is further on than the cursor, and not the place of the cursor
// in other words. Chromium gives the start of the first word of a block as
// the place in front of the block as well, where the cursor is drawn on the
// same character. An empty line of a code block has a place in front of its
// element and one behind it, whose rectangles differ by less than a pixel.
function isPastCursor(context: MoveContext, position: TextPosition): boolean {
  const { doc } = context;
  const { viewport, cursor } = context.session;
  if (!isAfter(doc, position, cursor)) return false;
  const rect = cursorRect(doc, viewport, position);
  return !isSamePlace(rect, cursorRect(doc, viewport, cursor));
}

// The browser's forward word move stops at the end of a word on macOS and
// Linux and at the start of the next word on Windows. Going to a word's end
// and back to its start gives the start of the next word on both.
function nextWordStart(context: MoveContext): TextPosition {
  const { doc } = context;
  const from = context.session.cursor;
  const wordEnd = extendBy(context, WORD_END);
  if (wordEnd === null) return from;
  const wordStart = extendBy(context, WORD_BACK);
  if (wordStart !== null && isPastCursor(context, wordStart)) return wordStart;
  extendTo(context, wordEnd);
  const nextEnd = extendBy(context, WORD_END);
  const nextStart = nextEnd === null ? null : extendBy(context, WORD_BACK);
  if (nextStart !== null && isPastCursor(context, nextStart)) return nextStart;
  return isAfter(doc, wordEnd, from) ? wordEnd : from;
}

// Where the blanks in front of a position begin, as far as they sit in the
// same piece of text.
function beforeBlanks(position: TextPosition): TextPosition {
  const { node } = position;
  if (!isText(node)) return position;
  let offset = position.offset;
  while (offset > 0 && BLANK.test(node.data[offset - 1])) offset -= 1;
  return offset === position.offset ? position : { node, offset };
}

// On Windows the browser's forward word move lands on the start of the next
// word, behind the blanks that follow the word, and the end of the word is in
// front of those blanks. From the end of a word that is where the cursor
// already is, so the move is made once more for the end of the next word.
function nextWordEnd(
  context: MoveContext,
  from: TextPosition = context.session.cursor,
): TextPosition {
  const { doc } = context;
  const landed = extendBy(context, WORD_END);
  if (landed === null) return from;
  const wordEnd = beforeBlanks(landed);
  if (isSamePosition(wordEnd, landed)) return landed;
  if (isAfter(doc, wordEnd, from)) {
    extendTo(context, wordEnd);
    return wordEnd;
  }
  const next = extendBy(context, WORD_END);
  if (next === null) return landed;
  const nextEnd = beforeBlanks(next);
  if (!isAfter(doc, nextEnd, from)) return next;
  extendTo(context, nextEnd);
  return nextEnd;
}

// The place is in front of where a move started, and not that place in other
// words: with a selection under way Chromium gives the start of a line of a
// code block as the place behind the line break in front of that line,
// where the cursor is drawn on the same character.
function isInFrontOfStart(
  context: MoveContext,
  place: TextPosition,
  start: TextPosition,
): boolean {
  const { doc } = context;
  const { viewport } = context.session;
  if (!isAfter(doc, start, place)) return false;
  return !isSamePlace(cursorRect(doc, viewport, place), cursorRect(doc, viewport, start));
}

// One character back from the end of a word is the last character of that
// word. null where that place is in front of where the move started or has
// no character of a word under the cursor block: the word move then ended
// where a text starts, and not at the end of a word.
function lastCharacterBefore(
  context: MoveContext,
  start: TextPosition,
  wordEnd: TextPosition,
): TextPosition | null {
  const { doc, session: current } = context;
  extendTo(context, wordEnd);
  const last = extendBy(context, CHARACTER_BACK);
  if (last === null || isInFrontOfStart(context, last, start)) return null;
  if (!canMeasure(doc)) return last;
  const under = blockGlyph(doc, current.viewport, last)?.text;
  return under === undefined || BLANK.test(under) ? null : last;
}

// The end of the next word behind a place, with the last character of that
// word. From the end of a paragraph, of a line of code or of the lines that
// a long message shows, Chromium's word move stops at the start of the text
// that follows, so the move is made again from there, for the end of the
// first word of that text. tmux goes on to that word in one move as well
// (grid_reader_cursor_next_word_end in grid-reader.c of tmux 3.5a). A word
// that isWanted refuses is passed over in the same way. null where no word
// follows.
function findWordEnd(
  context: MoveContext,
  start: TextPosition,
  isWanted: (last: TextPosition) => boolean = () => true,
): WordEnd | null {
  const { doc } = context;
  let moveFrom = start;
  for (let count = 0; count < MAX_WORD_MOVES; count += 1) {
    const end = nextWordEnd(context, moveFrom);
    if (!isAfter(doc, end, moveFrom)) return null;
    const last = lastCharacterBefore(context, start, end);
    if (last !== null && isWanted(last)) return { end, last };
    extendTo(context, end);
    moveFrom = end;
  }
  return null;
}

// The place behind a character can hold the cursor. The one behind a
// character that a box of bb cuts off in part cannot: it is outside the box.
function canStandBehind(context: MoveContext, character: TextPosition): boolean {
  const { doc } = context;
  const { viewport } = context.session;
  const behind = blockGlyph(doc, viewport, character)?.end;
  return behind === undefined || canShowCursor(doc, viewport, behind);
}

// With tmux's emacs keys the cursor goes behind the last character of a
// word, and from there behind that of the next word. Where the place behind
// a word cannot hold the cursor, the browser's move has gone on to the start
// of the text that follows, which is no end of a word, so the cursor goes on
// to the end of the first word of that text.
function endOfWord(context: MoveContext): TextPosition {
  const from = context.session.cursor;
  const found = findWordEnd(context, from, (last) => canStandBehind(context, last));
  return found?.end ?? from;
}

// With tmux's vi keys the cursor block goes onto the last character of a
// word, and from there onto the last character of the next word. tmux gets
// there by one character on, unless the block is on a blank, then to the end
// of the word and one character back (window_copy_cursor_next_word_end in
// window-copy.c of tmux 3.5a).
function lastCharacterOfWord(context: MoveContext): TextPosition {
  const { doc, session: current } = context;
  const from = current.cursor;
  const under = blockGlyph(doc, current.viewport, from)?.text;
  const isOnBlank = under === undefined || BLANK.test(under);
  const start = isOnBlank ? from : extendBy(context, CHARACTER_ON);
  if (start === null) return from;
  return findWordEnd(context, start)?.last ?? from;
}

function isLineBox(viewport: HTMLElement, element: Element): boolean {
  const view = viewport.ownerDocument.defaultView;
  return view !== null && view.getComputedStyle(element).display === LINE_BOX_DISPLAY;
}

// The box of the line that a place is on, in a code block that bb draws line
// by line. An empty line has no place inside its box: the cursor stands in
// front of the line break behind the box, or behind the one in front of it.
function codeLineBoxAt(viewport: HTMLElement, place: TextPosition): Element | null {
  const { node, offset } = place;
  const box = lineBoxOf(viewport, node);
  if (box !== null || !isText(node) || node.data !== LINE_BREAK) return box;
  const beside = offset === 0 ? node.previousSibling : node.nextSibling;
  if (beside === null || !isElement(beside)) return null;
  return isLineBox(viewport, beside) ? beside : null;
}

// null for a place in other text, as in a box inside a paragraph: the boxes
// of the lines of a code block have nothing but a line break between them,
// and stand in the element of a code block. The boxes that a formula is
// drawn with have nothing between them either.
function codeLinesAt(viewport: HTMLElement, place: TextPosition): CodeLines | null {
  const box = codeLineBoxAt(viewport, place);
  const block = box?.parentElement ?? null;
  if (box === null || block === null) return null;
  if (block.closest(CODE_BLOCK_ELEMENT) === null) return null;
  const children = Array.from(block.childNodes);
  const holdsLinesOnly = children.every(
    (child) => isElement(child) || (isText(child) && child.data === LINE_BREAK),
  );
  if (!holdsLinesOnly) return null;
  const lines = children.filter(isElement);
  return { block, lines, index: lines.indexOf(box) };
}

function isBlankLine(line: Element): boolean {
  return (line.textContent ?? "").trim() === "";
}

// As tmux looks for the line that ends a paragraph, or for the one in front
// of it (window_copy_next_paragraph and window_copy_previous_paragraph in
// window-copy.c): past the empty lines at the cursor, then past the lines
// that are not empty, to the first or the last line at most.
function paragraphEdge(
  lines: readonly Element[],
  from: number,
  isForward: boolean,
): number {
  const last = isForward ? lines.length - 1 : 0;
  const step = isForward ? 1 : -1;
  let index = from;
  while (index !== last && isBlankLine(lines[index])) index += step;
  while (index !== last && !isBlankLine(lines[index])) index += step;
  return index;
}

// The start of a line of such a code block: in front of its first character,
// or where the cursor stands on a line that holds nothing.
function codeLineStart(doc: Document, line: Element): TextPosition | null {
  const [text] = textsIn(doc, line);
  if (text !== undefined) return { node: text, offset: 0 };
  const { nextSibling, previousSibling } = line;
  if (nextSibling !== null && isText(nextSibling) && nextSibling.data === LINE_BREAK) {
    return { node: nextSibling, offset: 0 };
  }
  if (previousSibling === null || !isText(previousSibling)) return null;
  return { node: previousSibling, offset: previousSibling.length };
}

// The nearest place beside a code block where the cursor can stand: in front
// of the first character behind the block, which starts the text that
// follows it, or in front of the last character before the block.
function placeBesideBlock(
  context: MoveContext,
  block: Element,
  isForward: boolean,
): TextPosition | null {
  const beside = placeBeside(block, isForward);
  if (beside === null) return null;
  const [nearest] = scanLine(context, beside, isForward, () => true, () => true);
  return nearest === undefined ? null : { node: nearest.node, offset: nearest.offset };
}

function lineStartFrom(context: MoveContext, place: TextPosition): TextPosition {
  moveFocusTo(context, place);
  return extendBy(context, WRAPPED_LINE_START) ?? place;
}

// Where the paragraph keys end in a code block with nothing beside it, as in
// one that an answer ends with. As tmux does at the first and the last line
// (window_copy_previous_paragraph and window_copy_next_paragraph): the start
// of the first line of the code, or the end of its last one.
function codeEdge(doc: Document, code: CodeLines, isForward: boolean): TextPosition | null {
  if (!isForward) return codeLineStart(doc, code.lines[0]);
  const last = textsIn(doc, code.lines[code.lines.length - 1]).at(-1);
  return last === undefined ? null : { node: last, offset: last.length };
}

// The place that the paragraph keys go to from a line of a code block that
// bb draws line by line. The code has empty lines as a terminal has, so that
// is the next one as in tmux, and where the block has none in that
// direction, the nearest place beside the block. The empty line that the
// cursor is on is none: tmux stays on the last line of its screen, and here
// the conversation goes on beside the block. null where the cursor cannot
// stand there.
function paragraphPlaceInCode(
  context: MoveContext,
  code: CodeLines,
  isForward: boolean,
): TextPosition | null {
  const { doc } = context;
  const { viewport } = context.session;
  const edge = paragraphEdge(code.lines, code.index, isForward);
  const line = code.lines[edge];
  if (edge === code.index || !isBlankLine(line)) {
    return placeBesideBlock(context, code.block, isForward) ?? codeEdge(doc, code, isForward);
  }
  const start = codeLineStart(doc, line);
  return start !== null && canShowCursor(doc, viewport, start) ? start : null;
}

// The paragraph keys in such a code block. From the place in front of the
// block the cursor goes on to the start of that paragraph. Where no place is
// found the cursor stays: the browser's step is not made in its stead.
function reachParagraphInCode(
  context: MoveContext,
  code: CodeLines,
  isForward: boolean,
): TextPosition {
  const place = paragraphPlaceInCode(context, code, isForward);
  if (place === null) return context.session.cursor;
  const isInBlock = code.block.contains(place.node);
  if (!isForward && !isInBlock) return lineStartFrom(context, place);
  moveFocusTo(context, place);
  return place;
}

// The paragraph keys elsewhere: the browser's step to the next or the
// previous paragraph, which keeps the column, and from there to the start
// of that paragraph. A step forward that stays in the paragraph of the
// cursor, as from the last one of the conversation, ends where the browser
// put it, which is the end of that paragraph.
function reachNextParagraph(context: MoveContext): TextPosition {
  const { doc } = context;
  const from = context.session.cursor;
  const reached = extendBy(context, PARAGRAPH_ON);
  if (reached === null) return from;
  const start = extendBy(context, WRAPPED_LINE_START);
  if (start === null) return reached;
  if (isAfter(doc, start, from)) return start;
  moveFocusTo(context, reached);
  return reached;
}

// Where the browser's step back by a paragraph ended, and the start of the
// paragraph there. null for a step that finds no paragraph.
function previousParagraphStart(context: MoveContext): ParagraphStart | null {
  const reached = extendBy(context, PARAGRAPH_BACK);
  if (reached === null) return null;
  return { reached, start: extendBy(context, WRAPPED_LINE_START) ?? reached };
}

// The cursor shows at a place, and not where it shows at another one: the
// place in front of a rule is drawn as the start of the text behind it.
function isDrawnApart(
  context: MoveContext,
  place: TextPosition,
  other: TextPosition,
): boolean {
  const { doc } = context;
  const { viewport } = context.session;
  if (!canShowCursor(doc, viewport, place)) return false;
  return !isSamePlace(cursorRect(doc, viewport, place), cursorRect(doc, viewport, other));
}

// A step back that finds no paragraph, as from the first one, ends at the
// start of that one. Chromium's step from the start of the text behind a
// box that it does not walk across ends behind that box, and the start of
// the paragraph from there is where the cursor stood: behind a picture
// inside a paragraph, which bb draws as a block of its own, and behind a
// rule. The cursor then goes to the start of the paragraph in front of the
// box, which is the place in front of a picture that its paragraph starts
// with. The place in front of a rule is drawn as the text behind the rule,
// so from there the step is made again.
function reachPreviousParagraph(context: MoveContext): TextPosition {
  const from = context.session.cursor;
  const step = previousParagraphStart(context);
  if (step === null) return lineStartFrom(context, from);
  if (isDrawnApart(context, step.start, from)) return step.start;
  const across = placeAcrossBox(step.reached, PARAGRAPH_BACK);
  if (across === null) return step.start;
  const inFront = lineStartFrom(context, across);
  if (isDrawnApart(context, inFront, from)) return inFront;
  return previousParagraphStart(context)?.start ?? inFront;
}

// tmux goes to the empty line behind a paragraph or to the one in front of
// it, and to the start of that line (window_copy_next_paragraph and
// window_copy_previous_paragraph in window-copy.c). A page has no empty line
// between two paragraphs, so the cursor goes to the start of the paragraph
// that the browser's step reaches. From a line of a code block that bb
// draws line by line that step is not made: Chromium takes longer for it
// the longer the block is, over a second in a block of 600 lines, and it
// passes over the empty lines of the code.
function reachParagraph(context: MoveContext, isForward: boolean): TextPosition {
  const { viewport, cursor } = context.session;
  const code = codeLinesAt(viewport, cursor);
  if (code !== null) return reachParagraphInCode(context, code, isForward);
  return isForward ? reachNextParagraph(context) : reachPreviousParagraph(context);
}

// The first or the last text can be one that a box cuts off, as the end of a
// long user message is. The cursor then goes to the nearest place that shows.
function reachText(context: MoveContext, edge: TextEdge): TextPosition {
  const { doc, session: current } = context;
  const target = findEdgeText(doc, current.viewport, edge);
  if (target === null) return current.cursor;
  extendTo(context, target);
  if (canShowCursor(doc, current.viewport, target)) return target;
  const inwards = edge === "start" ? CHARACTER_ON : CHARACTER_BACK;
  return extendBy(context, inwards) ?? current.cursor;
}

function reachLineStart(context: MoveContext, target: TextPosition): TextPosition {
  context.session.lineRun = null;
  extendTo(context, target);
  return extendBy(context, LINE_START) ?? target;
}

function reachScreenLine(
  context: MoveContext,
  place: ScreenPlace,
  fallback: TextPosition = context.session.cursor,
): TextPosition {
  const target = findVisibleLine(context.doc, context.session.viewport, place);
  return target === null ? fallback : reachLineStart(context, target);
}

// A line of a code block can start with blanks. They sit in one text node,
// and a line break in that node ends them.
function reachIndentation(context: MoveContext): TextPosition {
  const { doc, session: current } = context;
  const lineStart = extendBy(context, WRAPPED_LINE_START);
  if (lineStart === null) return current.cursor;
  const first = characterAfter(doc, current.viewport, lineStart);
  if (first === null) return lineStart;
  const blanks = LEADING_BLANKS.exec(first.node.data.slice(first.offset));
  const blankCount = blanks === null ? 0 : blanks[0].length;
  if (blankCount === 0) return lineStart;
  const target = { node: first.node, offset: first.offset + blankCount };
  extendTo(context, target);
  return target;
}

function pageLines(context: MoveContext, pages: number): number {
  const { viewport, cursor } = context.session;
  const bounds = visibleBounds(viewport);
  const lineHeight =
    cursorRect(context.doc, viewport, cursor)?.height ?? FALLBACK_LINE_HEIGHT_PX;
  const lines = Math.floor(((bounds.bottom - bounds.top) * pages) / lineHeight);
  return Math.min(MAX_PAGE_LINES * pages, Math.max(1, lines));
}

function nearestScreenPlace(rect: CursorRect, bounds: VisibleBounds): ScreenPlace {
  return rect.top < bounds.top ? "top" : "bottom";
}

// Says of each place that line moves reach whether the cursor has come as far
// from where it started as the view was scrolled, to the nearest line. Lines
// are further apart than their characters are high, and not all the same.
function hasTravelled(
  context: MoveContext,
  distance: number,
): (reached: TextPosition) => boolean {
  const range = context.doc.createRange();
  const start = caretLine(range, context.session.cursor)?.top;
  let last = start;
  return (reached) => {
    const top = caretLine(range, reached)?.top;
    if (start === undefined || last === undefined || top === undefined) return false;
    const stepHeight = Math.abs(top - last);
    last = top;
    return Math.abs(top - start) + stepHeight / 2 >= distance;
  };
}

// A page key scrolls the conversation by the height of the view, or by half
// of it, as tmux does, and moves the cursor as far, line by line, so that the
// cursor stays at its height on screen. Where the conversation cannot scroll
// any further, at its first and its last text, only the cursor moves. The
// count of lines from the height of the cursor's own line is the most that it
// moves. A cursor that left the view all the same goes to the nearest line
// that shows, and the view is not scrolled a second time.
function reachPage(context: MoveContext, move: PageMove): TextPosition {
  const { doc, session: current } = context;
  const { viewport } = current;
  const step = move.direction === 1 ? LINE_DOWN : LINE_UP;
  const lines = pageLines(context, move.pages);
  const bounds = visibleBounds(viewport);
  const distance = (bounds.bottom - bounds.top) * move.pages;
  if (getTimelineViewport(doc) !== viewport) {
    return stepLines(context, step, lines, hasTravelled(context, distance));
  }
  if (distance !== 0) scrollTimelineBy(distance * move.direction, doc);
  const reached = stepLines(context, step, lines, hasTravelled(context, distance));
  const rect = cursorRect(doc, viewport, reached);
  if (rect === null || showsBetween(rect, bounds)) return reached;
  return reachScreenLine(context, nearestScreenPlace(rect, bounds), reached);
}

function isPageMotion(motion: CopyMotion): motion is PageMotion {
  return motion in PAGE_MOVES;
}

function reach(
  motion: Exclude<CopyMotion, PageMotion>,
  context: MoveContext,
): TextPosition {
  switch (motion) {
    case "line-up":
      return stepLines(context, LINE_UP, 1);
    case "line-down":
      return stepLines(context, LINE_DOWN, 1);
    case "word-forward":
      return nextWordStart(context);
    case "word-end":
      return context.selectsUnderBlock
        ? lastCharacterOfWord(context)
        : endOfWord(context);
    case "line-indent":
      return reachIndentation(context);
    case "paragraph-back":
      return reachParagraph(context, false);
    case "paragraph-forward":
      return reachParagraph(context, true);
    case "document-start":
      return reachText(context, "start");
    case "document-end":
      return reachText(context, "end");
    case "screen-top":
      return reachScreenLine(context, "top");
    case "screen-middle":
      return reachScreenLine(context, "middle");
    case "screen-bottom":
      return reachScreenLine(context, "bottom");
    default:
      return stepOnce(context, PLAIN_STEPS[motion]);
  }
}

// The cursor block is drawn at a place in the window, so it has to follow
// the conversation when that moves. A scroll and a resize of the window say
// so themselves. bb's sidebar, its side panel and a divider move or resize
// the conversation without either, which the size of its scroller shows.
function trackViewport(doc: Document, viewport: HTMLElement): () => void {
  const view = doc.defaultView;
  let frame: number | null = null;
  const refreshOnNextFrame = (): void => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      refreshCopyCursor(doc);
    });
  };
  doc.addEventListener("scroll", refreshOnNextFrame, SCROLL_LISTENER_OPTIONS);
  view?.addEventListener("resize", refreshOnNextFrame);
  const sizeObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(refreshOnNextFrame)
      : null;
  sizeObserver?.observe(viewport);
  return () => {
    doc.removeEventListener("scroll", refreshOnNextFrame, SCROLL_LISTENER_OPTIONS);
    view?.removeEventListener("resize", refreshOnNextFrame);
    sizeObserver?.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
}

// bb mounts a new scroller when the pane shows another thread.
function isConversationGone(current: CopySession): boolean {
  return !current.viewport.isConnected;
}

function isLost(current: CopySession): boolean {
  if (!current.cursor.node.isConnected) return true;
  return current.anchor !== null && !current.anchor.node.isConnected;
}

function currentSession(doc: Document): CopySession | null {
  const current = session;
  if (current === null) return null;
  if (isConversationGone(current)) {
    exitCopyMode(doc);
    return null;
  }
  if (isLost(current)) {
    exitCopyMode(doc);
    showNotice(LOST_NOTICE);
    return null;
  }
  current.cursor = clampPosition(current.cursor);
  if (current.anchor !== null) current.anchor = clampPosition(current.anchor);
  return current;
}

function selectedFocus(
  doc: Document,
  viewport: HTMLElement,
  selection: Selection,
): TextPosition | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;
  const { focusNode, focusOffset } = selection;
  if (!isInsideConversation(viewport, focusNode)) return null;
  const focus = { node: focusNode, offset: focusOffset };
  const rect = cursorRect(doc, viewport, focus);
  if (rect !== null && !overlaps(rect, visibleBounds(viewport))) return null;
  return focus;
}

export function isCopyModeActive(): boolean {
  return session !== null;
}

export function hasCopyModeLostConversation(): boolean {
  return session !== null && isConversationGone(session);
}

export function enterCopyMode(doc: Document = document): boolean {
  return guarded("copy.enter", false, () => {
    const isUsable =
      session !== null && !isConversationGone(session) && !isLost(session);
    if (isUsable) return true;
    exitCopyMode(doc);
    const viewport = getTimelineViewport(doc);
    const selection = doc.getSelection();
    if (viewport === null || selection === null) return false;
    if (typeof selection.modify !== "function") return false;
    const selected = selectedFocus(doc, viewport, selection);
    const start = selected ?? findVisibleLine(doc, viewport, "bottom");
    if (start === null) return false;
    selection.collapse(start.node, start.offset);
    const entered: CopySession = {
      viewport,
      cursor: start,
      anchor: null,
      anchorEnd: null,
      lineRun: null,
      hasColumn: false,
      stopTracking: () => {},
    };
    if (selected === null) {
      const context = beginMove(doc, selection, entered);
      entered.cursor = extendBy(context, LINE_START) ?? start;
      showSelection(doc, selection, entered);
    }
    revealHiddenCursor(doc, entered);
    entered.stopTracking = trackViewport(doc, viewport);
    session = entered;
    publish(doc, entered);
    return true;
  });
}

function endSession(doc: Document, keepsSelection: boolean): void {
  const current = session;
  if (current === null) return;
  session = null;
  guarded("copy.exit", undefined, () => {
    current.stopTracking();
    if (!keepsSelection) clearOwnSelection(doc, current.viewport);
  });
  updateUiState({ copyMode: INACTIVE });
}

export function exitCopyMode(doc: Document = document): void {
  endSession(doc, false);
}

// For a press on bb's selection menu, whose buttons act on the selected text.
export function exitCopyModeKeepingSelection(doc: Document = document): void {
  endSession(doc, true);
}

export function moveCopyCursor(motion: CopyMotion, doc: Document = document): void {
  guarded("copy.move", undefined, () => {
    const current = currentSession(doc);
    const selection = doc.getSelection();
    if (current === null || selection === null) return;
    const context = beginMove(doc, selection, current);
    try {
      current.cursor = isPageMotion(motion)
        ? reachPage(context, PAGE_MOVES[motion])
        : reach(motion, context);
    } finally {
      showSelection(doc, selection, current);
    }
    revealCursor(doc, current);
    publish(doc, current);
  });
}

// A cursor that the scroll took out of view moves to the nearest line that
// still shows: the top one after a scroll down, the bottom one after a scroll
// up. The next move then starts from what the user is looking at. Where no
// line shows, the cursor stays, and so does the run of line moves before. A
// code block that is scrolled sideways is scrolled to the cursor, which
// stands at the start of its line.
function keepCursorInView(
  doc: Document,
  selection: Selection,
  current: CopySession,
  deltaPx: number,
): void {
  const { viewport } = current;
  const rect = cursorRect(doc, viewport, current.cursor);
  const bounds = comfortBounds(visibleBounds(viewport));
  if (rect === null || fitsBetween(rect, bounds)) return;
  const context = beginMove(doc, selection, current);
  try {
    const target = findVisibleLine(doc, viewport, deltaPx > 0 ? "top" : "bottom");
    if (target === null) {
      current.lineRun = context.lineRun;
      return;
    }
    current.cursor = reachLineStart(context, target);
  } finally {
    showSelection(doc, selection, current);
  }
  revealHiddenCursor(doc, current);
}

export function scrollCopyView(deltaPx: number, doc: Document = document): void {
  guarded("copy.scroll", undefined, () => {
    const current = currentSession(doc);
    const selection = doc.getSelection();
    if (current === null || selection === null) return;
    if (getTimelineViewport(doc) !== current.viewport) return;
    scrollTimelineBy(deltaPx, doc);
    keepCursorInView(doc, selection, current, deltaPx);
    publish(doc, current);
  });
}

function setSelecting(label: string, doc: Document, isSelecting: boolean): void {
  guarded(label, undefined, () => {
    const current = currentSession(doc);
    const selection = doc.getSelection();
    if (current === null || selection === null) return;
    const { cursor, viewport } = current;
    current.anchor = isSelecting ? cursor : null;
    current.anchorEnd = isSelecting ? behindBlock(doc, viewport, cursor) : null;
    showSelection(doc, selection, current);
    publish(doc, current);
  });
}

export function beginCopySelection(doc: Document = document): void {
  setSelecting("copy.beginSelection", doc, true);
}

export function clearCopySelection(doc: Document = document): void {
  setSelecting("copy.clearSelection", doc, false);
}

// With nothing to copy, the commands of tmux that copy and leave still leave
// copy mode, and the others do nothing.
function finishEmptyCopy(after: AfterCopy, doc: Document): CopyResult {
  if (after === "exit") {
    exitCopyMode(doc);
    return "empty";
  }
  showNotice(NOTHING_SELECTED_NOTICE);
  return "empty";
}

function finishCopy(current: CopySession, after: AfterCopy, doc: Document): void {
  if (session !== current || after === "keep") return;
  if (after === "exit") {
    exitCopyMode(doc);
    return;
  }
  clearCopySelection(doc);
}

export async function yankCopySelection(
  after: AfterCopy,
  doc: Document = document,
): Promise<CopyResult> {
  try {
    const current = currentSession(doc);
    const selection = doc.getSelection();
    if (current === null || selection === null) return "empty";
    if (current.anchor === null) return finishEmptyCopy(after, doc);
    showSelection(doc, selection, current);
    const result = await copySelection(doc);
    // The copy can select the text part by part to read it, and the browser
    // forgets the column of the line moves then.
    current.hasColumn = false;
    if (result === "failed") showNotice(COPY_FAILED_NOTICE);
    if (result === "empty" && session === current) finishEmptyCopy(after, doc);
    if (result !== "copied") return result;
    showNotice(COPIED_NOTICE);
    finishCopy(current, after, doc);
    return result;
  } catch (error) {
    report("copy.yank", error);
    return "failed";
  }
}

export function refreshCopyCursor(doc: Document = document): void {
  guarded("copy.refresh", undefined, () => {
    const current = currentSession(doc);
    if (current !== null) publish(doc, current);
  });
}
