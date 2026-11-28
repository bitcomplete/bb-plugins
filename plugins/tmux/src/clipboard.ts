import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import { COPY_COMMAND, SELECTORS } from "./constants";

export type CopyResult = "copied" | "empty" | "failed";

export const COPIED_NOTICE = "Selection copied";
export const COPY_FAILED_NOTICE = "Could not copy the selection";

function readSelection(doc: Document): Selection | null {
  const selection = doc.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  return selection.isCollapsed ? null : selection;
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function messageProseOf(node: Node): Element | null {
  return elementOf(node)?.closest(SELECTORS.messageProse) ?? null;
}

// What the range holds in front of an element and behind it is blank.
function holdsAllText(element: Element, range: Range): boolean {
  if (!element.contains(range.startContainer)) {
    const inFront = range.cloneRange();
    inFront.setEnd(element, 0);
    if (inFront.toString().trim() !== "") return false;
  }
  if (element.contains(range.endContainer)) return true;
  const behind = range.cloneRange();
  behind.setStart(element, element.childNodes.length);
  return behind.toString().trim() === "";
}

// The selected text lies in one message. The selection may reach out of the
// message over blanks, as the one of a triple click does, which ends at the
// start of the block that follows. For such a selection bb's copy handler
// (handleSharedCopy in SelectableMessageProse.tsx of bb 0.50.1) answers
// with the Markdown of what is selected. For one that starts in a message
// and ends in another it joins the Markdown of the messages and leaves out
// everything between them, such as a message of the user.
function isInOneMessage(range: Range): boolean {
  const ends = [range.startContainer, range.endContainer];
  return ends.some((end) => {
    const message = messageProseOf(end);
    return message !== null && holdsAllText(message, range);
  });
}

// The copy command only works during a key press or a click, and it is the
// only way to reach bb's own copy handler, so it is tried before the SDK.
function runCopyCommand(doc: Document): boolean {
  if (typeof doc.execCommand !== "function") return false;
  try {
    return doc.execCommand(COPY_COMMAND);
  } catch {
    return false;
  }
}

function codeBlockHeadersIn(range: Range): Element[] {
  const root = elementOf(range.commonAncestorContainer);
  if (root === null) return [];
  return Array.from(root.querySelectorAll(SELECTORS.codeBlockHeader)).filter(
    (header) => range.intersectsNode(header),
  );
}

function textOfPart(selection: Selection, part: Range): string {
  if (part.collapsed) return "";
  selection.setBaseAndExtent(
    part.startContainer,
    part.startOffset,
    part.endContainer,
    part.endOffset,
  );
  return selection.toString();
}

// The text of the selection as the page shows it, without the headers of
// the code blocks in it, which bb leaves out of a copy as well. The browser
// only gives the text with the line breaks of the page for what is selected,
// so the parts between the headers are selected one after another, and then
// the selection is put back as it was.
function plainTextOf(doc: Document, selection: Selection): string {
  const range = selection.getRangeAt(0);
  const headers = codeBlockHeadersIn(range);
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (headers.length === 0 || anchorNode === null || focusNode === null) {
    return selection.toString();
  }
  const part = doc.createRange();
  part.setStart(range.startContainer, range.startOffset);
  let text = "";
  try {
    for (const header of headers) {
      part.setEndBefore(header);
      text += textOfPart(selection, part);
      part.setStartAfter(header);
    }
    part.setEnd(range.endContainer, range.endOffset);
    return text + textOfPart(selection, part);
  } finally {
    selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  }
}

async function writeThroughSdk(text: string): Promise<boolean> {
  try {
    return await experimental_copyToClipboard({ text });
  } catch {
    return false;
  }
}

// A selection in one message is left to bb's copy handler, for its Markdown.
// Any other is written as the plain text that is selected: bb's handler
// answers a selection over several messages without what is between them.
// Either way, a selection that holds nothing but blanks and the headers of
// code blocks is empty: bb's handler would answer it with an empty code
// block.
export async function copySelection(doc: Document = document): Promise<CopyResult> {
  try {
    const selection = readSelection(doc);
    if (selection === null) return "empty";
    const text = plainTextOf(doc, selection);
    if (text.trim() === "") return "empty";
    const isLeftToBb = isInOneMessage(selection.getRangeAt(0));
    if (isLeftToBb && runCopyCommand(doc)) return "copied";
    return (await writeThroughSdk(text)) ? "copied" : "failed";
  } catch {
    return "failed";
  }
}
