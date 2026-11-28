import { BB_ROUTES, SELECTORS } from "./constants";
import { getFocusedPaneElement, hasOpenModal } from "./dom-actions";
import type { FocusKind, Surface } from "./types";

export const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  SELECTORS.radixPopper,
  SELECTORS.portaledOverlay,
].join(", ");

export const TERMINAL_SELECTOR = `${SELECTORS.terminal}, ${SELECTORS.xterm}`;

const TYPING_AREA_SELECTOR = `${TERMINAL_SELECTOR}, ${SELECTORS.browser}`;

export const EDITABLE_SELECTOR = [
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  SELECTORS.monacoEditor,
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
].join(", ");

const TEXT_FIELD_SELECTOR =
  'textarea, [contenteditable]:not([contenteditable="false"])';

const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  "input",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="treeitem"]',
  '[tabindex]:not([tabindex^="-"])',
].join(", ");

const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

const FRAME_TAGS: ReadonlySet<string> = new Set(["iframe", "webview"]);

function isElement(target: EventTarget | null): target is Element {
  return target !== null && (target as Node).nodeType === 1;
}

function isTextInput(element: Element): boolean {
  if (element.localName !== "input") return false;
  return !NON_TEXT_INPUT_TYPES.has((element as HTMLInputElement).type);
}

// Monaco can take typing through the EditContext API on an element that is
// neither a textarea nor contenteditable.
function hasEditContext(element: Element): boolean {
  return (element as { editContext?: unknown }).editContext != null;
}

function isEditable(element: Element): boolean {
  return (
    isTextInput(element) ||
    hasEditContext(element) ||
    element.closest(EDITABLE_SELECTOR) !== null
  );
}

// The browser names the host of a shadow root as the target of a key press
// and as the active element, and not the element inside it that has the
// cursor. A closed shadow root keeps that element to itself.
function focusedInShadowRoot(host: Element): Element | null {
  const inner = host.shadowRoot?.activeElement ?? null;
  if (inner === null) return null;
  return focusedInShadowRoot(inner) ?? inner;
}

function takesTyping(element: Element): boolean {
  if (isEditable(element)) return true;
  const inner = focusedInShadowRoot(element);
  return inner !== null && isEditable(inner);
}

// A field that holds a text cursor. That is less than what takes typing: a
// select and a combobox take keys as well, and a button of a picker can be
// either.
export function isInTextField(element: Element): boolean {
  return isTextInput(element) || element.closest(TEXT_FIELD_SELECTOR) !== null;
}

// The element itself is part of a dialog, a menu or a list. classifyFocus
// says "overlay" for every element of the page while a dialog is open.
export function isInOverlay(target: EventTarget | null): boolean {
  return isElement(target) && target.closest(OVERLAY_SELECTOR) !== null;
}

export function classifyFocus(
  target: EventTarget | null,
  doc: Document = document,
): FocusKind {
  const element = isElement(target) ? target : (doc.activeElement ?? doc.body);
  if (hasOpenModal(doc)) return "overlay";
  if (element.closest(OVERLAY_SELECTOR) !== null) return "overlay";
  if (element.closest(TYPING_AREA_SELECTOR) !== null) return "typing";
  if (FRAME_TAGS.has(doc.activeElement?.localName ?? "")) return "frame";
  if (takesTyping(element)) return "typing";
  if (element.closest(SELECTORS.sidebarRow) !== null) return "sidebar";
  if (element.closest(CONTROL_SELECTOR) !== null) return "control";
  return "normal";
}

function surfaceRoot(doc: Document): Element {
  return (
    getFocusedPaneElement(doc) ?? doc.querySelector(SELECTORS.appMain) ?? doc.body
  );
}

export function detectSurface(doc: Document = document): Surface {
  const root = surfaceRoot(doc);
  if (root.querySelector(SELECTORS.threadWindow) !== null) return "thread";
  const isNewThreadRoute =
    doc.defaultView?.location.pathname === BB_ROUTES.newThread;
  if (isNewThreadRoute && root.querySelector(SELECTORS.composer) !== null) {
    return "compose";
  }
  return "other";
}
