// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { SELECTORS } from "../constants";
import {
  dialogPosition,
  nativeViewRect,
  visibleNativeViewRects,
} from "./native-views";

const BROWSER_ATTRIBUTE = SELECTORS.browser.slice(1, -1);

interface TabOptions {
  left?: number;
  width?: number;
  height?: number;
  contentChildren?: string[];
}

function addBrowserTab({
  left = 800,
  width = 400,
  height = 600,
  contentChildren = [],
}: TabOptions = {}): HTMLElement {
  const tab = document.createElement("div");
  tab.setAttribute(BROWSER_ATTRIBUTE, "");
  const toolbar = document.createElement("div");
  const content = document.createElement("div");
  content.getBoundingClientRect = () =>
    ({ left, top: 90, width, height, right: left + width }) as DOMRect;
  content.append(...contentChildren.map((tag) => document.createElement(tag)));
  tab.append(toolbar, content);
  document.body.append(tab);
  return tab;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("nativeViewRect", () => {
  it("returns the content rectangle while the native view is showing", () => {
    const tab = addBrowserTab({ left: 700, width: 500 });
    expect(nativeViewRect(tab)).toMatchObject({ left: 700, width: 500 });
  });

  it("still counts the view while bb shows its resize snapshot image", () => {
    const tab = addBrowserTab({ contentChildren: ["img"] });
    expect(nativeViewRect(tab)).not.toBeNull();
  });

  it("is null while bb draws its own page in the content element", () => {
    const tab = addBrowserTab({ contentChildren: ["div"] });
    expect(nativeViewRect(tab)).toBeNull();
  });

  it("is null for an empty rectangle", () => {
    expect(nativeViewRect(addBrowserTab({ width: 0 }))).toBeNull();
    expect(nativeViewRect(addBrowserTab({ height: 0 }))).toBeNull();
  });

  it("is null when the tab has no children", () => {
    expect(nativeViewRect(document.createElement("div"))).toBeNull();
  });
});

describe("visibleNativeViewRects", () => {
  it("is empty when there is no Browser tab", () => {
    expect(visibleNativeViewRects()).toEqual([]);
  });

  it("collects every Browser tab that is showing a native view", () => {
    addBrowserTab({ left: 900 });
    addBrowserTab({ left: 600 });
    addBrowserTab({ left: 300, contentChildren: ["div"] });

    expect(visibleNativeViewRects().map((rect) => rect.left)).toEqual([
      900, 600,
    ]);
  });
});

describe("dialogPosition", () => {
  it("is null when no native view is visible", () => {
    expect(dialogPosition([], 640)).toBeNull();
  });

  it("centres the dialog in the strip left of the view", () => {
    expect(dialogPosition([{ left: 900 }], 640)).toEqual({
      centerX: 450,
      maxWidth: 640,
    });
  });

  it("uses the leftmost view when several are visible", () => {
    expect(dialogPosition([{ left: 900 }, { left: 700 }], 640)).toEqual({
      centerX: 350,
      maxWidth: 640,
    });
  });

  it("narrows the dialog to fit a narrow strip", () => {
    expect(dialogPosition([{ left: 400 }], 640)).toEqual({
      centerX: 200,
      maxWidth: 368,
    });
  });

  it("is null when the strip is too narrow for the dialog", () => {
    expect(dialogPosition([{ left: 300 }], 640)).toBeNull();
    expect(dialogPosition([{ left: 0 }], 640)).toBeNull();
  });
});
