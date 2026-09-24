// The thread menu's open/close rules and keyboard movement. The bug these
// guard against: a hover-only list that vanished the moment the pointer moved
// toward it, so its threads could be seen but never opened.
import { describe, expect, it } from "vitest";
import { CLOSED, menuEntries, menuReducer, nextIndex, threadDotLabel, type MenuEvent } from "./menustate.js";

const run = (...events: MenuEvent[]) => events.reduce(menuReducer, CLOSED);

describe("menuReducer", () => {
  it("opens on hover and stays open while the pointer crosses into the menu (hover again before the timeout)", () => {
    expect(run("hover")).toEqual({ open: true, pinned: false });
    expect(run("hover", "hover")).toEqual({ open: true, pinned: false });
  });

  it("closes after the hover delay when not pinned", () => {
    expect(run("hover", "hover-timeout")).toEqual(CLOSED);
  });

  it("pins on click, so it works without hover and survives the pointer leaving", () => {
    expect(run("click")).toEqual({ open: true, pinned: true });
    expect(run("hover", "click", "hover-timeout")).toEqual({ open: true, pinned: true });
  });

  it("closes on a second click of the dot, on Escape or outside click, and after an entry is chosen", () => {
    expect(run("click", "click")).toEqual(CLOSED);
    expect(run("click", "dismiss")).toEqual(CLOSED);
    expect(run("hover", "dismiss")).toEqual(CLOSED);
  });
});

describe("nextIndex", () => {
  it("walks entries with the arrows, wrapping, and jumps with Home and End", () => {
    expect(nextIndex(-1, "ArrowDown", 3)).toBe(0);
    expect(nextIndex(2, "ArrowDown", 3)).toBe(0);
    expect(nextIndex(0, "ArrowUp", 3)).toBe(2);
    expect(nextIndex(-1, "ArrowUp", 3)).toBe(2);
    expect(nextIndex(1, "Home", 3)).toBe(0);
    expect(nextIndex(1, "End", 3)).toBe(2);
  });

  it("ignores other keys and empty menus", () => {
    expect(nextIndex(0, "a", 3)).toBeNull();
    expect(nextIndex(0, "ArrowDown", 0)).toBeNull();
  });
});

describe("menuEntries", () => {
  it("lists at most five and counts the rest as more", () => {
    expect(menuEntries([1, 2, 3, 4, 5, 6, 7])).toEqual({ shown: [1, 2, 3, 4, 5], more: 2 });
    expect(menuEntries([1, 2])).toEqual({ shown: [1, 2], more: 0 });
  });
});

describe("threadDotLabel", () => {
  it("names the count and the click", () => {
    expect(threadDotLabel(1)).toBe("1 thread · click to open");
    expect(threadDotLabel(2)).toBe("2 threads · click to open");
  });
});
