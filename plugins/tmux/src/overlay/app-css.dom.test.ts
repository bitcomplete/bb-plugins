// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { SELECTORS, SWITCHED_ON_ATTRIBUTE } from "../constants";

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute(SWITCHED_ON_ATTRIBUTE);
});

const SWITCHED_ON = `:root[${SWITCHED_ON_ATTRIBUTE}]`;
const FOCUSED_PANE_BORDER = `${SWITCHED_ON} ${SELECTORS.focusedThreadPane} > ${SELECTORS.paneFocusScrim}`;
const SIDEBAR_ROW = `${SWITCHED_ON} ${SELECTORS.sidebarRow}`;

const PAGE = `
  <a id="row" data-sidebar-thread-shortcut-target="" data-sidebar-thread-id="thr_a"></a>
  <div data-split-pane-id="a" data-focused="true">
    <div data-pane-focus-scrim="" id="scrim"></div>
  </div>
`;

function matchedIds(selector: string): string[] {
  return [...document.querySelectorAll(selector)].map((element) => element.id);
}

// app-css.test.ts holds app.css to these two selectors. The row is matched
// here without :focus-visible, which jsdom does not know.
describe("the mark of a plugin that is switched on", () => {
  it("lets the selectors of app.css match nothing of bb's page while the page does not carry it", () => {
    document.body.innerHTML = PAGE;

    expect(matchedIds(SIDEBAR_ROW)).toEqual([]);
    expect(matchedIds(FOCUSED_PANE_BORDER)).toEqual([]);
  });

  it("lets them match the sidebar row and the overlay of the focused pane while the page carries it", () => {
    document.body.innerHTML = PAGE;
    document.documentElement.toggleAttribute(SWITCHED_ON_ATTRIBUTE, true);

    expect(matchedIds(SIDEBAR_ROW)).toEqual(["row"]);
    expect(matchedIds(FOCUSED_PANE_BORDER)).toEqual(["scrim"]);
  });
});

describe("the focused pane selector used by app.css", () => {
  it("borders the overlay of the focused thread pane only", () => {
    document.documentElement.toggleAttribute(SWITCHED_ON_ATTRIBUTE, true);
    document.body.innerHTML = `
      <div data-split-pane-id="a" data-focused="true">
        <div><div data-pane-focus-scrim="" id="nested"></div></div>
        <div data-pane-focus-scrim="" id="focused-overlay"></div>
      </div>
      <div data-split-pane-id="b" data-focused="false">
        <div data-pane-focus-scrim=""></div>
      </div>
      <div data-split-pane-id="c" data-focused="true" aria-hidden="true">
        <div data-pane-focus-scrim=""></div>
      </div>
      <div data-sidebar-split-container="">
        <div data-split-pane-id="tabs" data-focused="true">
          <div data-pane-focus-scrim=""></div>
        </div>
      </div>
    `;
    const matched = [...document.querySelectorAll(FOCUSED_PANE_BORDER)];
    expect(matched.map((element) => element.id)).toEqual(["focused-overlay"]);
  });

  it("picks the focused thread pane and nothing else", () => {
    document.body.innerHTML = `
      <div data-split-pane-id="a" data-focused="true" id="focused"></div>
      <div data-split-pane-id="b" data-focused="false"></div>
      <div data-split-pane-id="c" data-focused="true" aria-hidden="true"></div>
      <div data-split-pane-id="single"></div>
      <div data-sidebar-split-container="">
        <div data-split-pane-id="tabs" data-focused="true"></div>
      </div>
    `;
    const matched = [...document.querySelectorAll(SELECTORS.focusedThreadPane)];
    expect(matched.map((element) => element.id)).toEqual(["focused"]);
  });

  it("still matches while the cursor is in a text field inside the pane", () => {
    document.body.innerHTML = `
      <div data-split-pane-id="a" data-focused="true" id="focused" tabindex="-1">
        <textarea id="box"></textarea>
      </div>
    `;
    document.getElementById("box")?.focus();
    expect(document.activeElement?.id).toBe("box");
    expect(document.querySelector(SELECTORS.focusedThreadPane)?.id).toBe("focused");
  });
});
