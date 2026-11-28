import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SELECTORS, SWITCHED_ON_ATTRIBUTE } from "../constants";

const css = readFileSync(new URL("../../app.css", import.meta.url), "utf8");
const SWITCHED_ON = `:root[${SWITCHED_ON_ATTRIBUTE}]`;
const SIDEBAR_ROW_RING = `${SWITCHED_ON} ${SELECTORS.sidebarRow}:focus-visible`;
const FOCUSED_PANE_BORDER = `${SWITCHED_ON} ${SELECTORS.focusedThreadPane} > ${SELECTORS.paneFocusScrim}`;
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

function selectors(): string[] {
  return [...rules.matchAll(/([^{}]+)\{[^}]*\}/g)].flatMap((match) =>
    match[1].split(",").map((selector) => selector.trim()),
  );
}

describe("app.css", () => {
  it("rings a focused sidebar thread row with the selector from constants.ts", () => {
    expect(selectors()).toContain(SIDEBAR_ROW_RING);
  });

  it("borders the pane bb marks as focused, on bb's own pane overlay", () => {
    expect(selectors()).toContain(FOCUSED_PANE_BORDER);
  });

  it("does not tie the pane border to keyboard focus, which the message box takes away", () => {
    const paneSelectors = selectors().filter((selector) =>
      selector.includes(SELECTORS.splitPane),
    );
    expect(paneSelectors).toEqual([FOCUSED_PANE_BORDER]);
  });

  it("only reaches into bb's page under the mark of a plugin that is switched on, so that nothing is drawn while it is off", () => {
    const unmarked = selectors().filter(
      (selector) =>
        !selector.startsWith(`${SWITCHED_ON} `) && !selector.startsWith(".tmux-"),
    );
    expect(unmarked).toEqual([]);
  });

  it("only holds prefixed classes or those two bb selectors", () => {
    const allowed = new Set([SIDEBAR_ROW_RING, FOCUSED_PANE_BORDER]);
    const unexpected = selectors().filter(
      (selector) =>
        !allowed.has(selector) && !selector.startsWith(".tmux-"),
    );
    expect(unexpected).toEqual([]);
  });

  it("has no literal colours", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|oklch\(/i);
  });
});
