import { describe, expect, it } from "vitest";
import { ACTION, actionForKey, DECK_ACTIONS, KEY_GROUPS, PICKER_ACTIONS, pickerActionForKey, typingTarget } from "./deck-keys.js";

describe("the deck's key registry", () => {
  it("gives each key one meaning, so the same letter does the same thing in the deck and All PRs", () => {
    const keys = DECK_ACTIONS.flatMap((action) => action.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(DECK_ACTIONS.every((action) => KEY_GROUPS.includes(action.group))).toBe(true);
    expect(new Set(DECK_ACTIONS.map((action) => action.id)).size).toBe(DECK_ACTIONS.length);
  });

  // r already asks for a reviewer, so Refresh takes g.
  it("binds g to Refresh, leaving r to Request a reviewer", () => {
    expect([actionForKey({ key: "g" }), actionForKey({ key: "r" })]).toEqual([{ id: "refresh" }, { id: "request" }]);
  });

  it("never binds Enter or Space to a merge or a write: Enter only opens a row's details", () => {
    expect(actionForKey({ key: "Enter" })).toEqual({ id: "expand" });
    expect(actionForKey({ key: " " })).toBeNull();
    for (const action of DECK_ACTIONS.filter((item) => item.effect === "confirm" || item.effect === "start" || item.effect === "preview")) {
      expect(action.keys).not.toContain("↵");
      expect(action.keys).not.toContain(" ");
    }
    // ⌘↵ merges only inside the fresh merge preview, which owns that key; the deck never reads it as an action.
    expect(actionForKey({ key: "Enter", metaKey: true })).toBeNull();
    expect(actionForKey({ key: "Enter", ctrlKey: true })).toBeNull();
  });

  it("opens a listing confirm, or the fresh merge preview, for every key that can lead to a GitHub write", () => {
    const writes = ["advance", "merge", "nudge", "request", "ready"] as const;
    expect(writes.map((id) => [id, ACTION[id].effect])).toEqual([["advance", "confirm"], ["merge", "preview"], ["nudge", "confirm"],
      ["request", "confirm"], ["ready", "confirm"]]);
    expect(["a", "m", "n", "r", "y"].map((key) => actionForKey({ key })?.id)).toEqual([...writes]);
    // c opens one PR's review notes: a dialog that reads them first, where a confirmation is a click, never a batch.
    expect([ACTION.confirm.effect, actionForKey({ key: "c" })?.id]).toEqual(["dialog", "confirm"]);
    // Release lifts your hold through the same listing and Undo window, though it writes nothing to GitHub.
    expect([ACTION.release.effect, actionForKey({ key: "l" })?.id]).toEqual(["confirm", "release"]);
    // f asks each PR's thread for its fix, which pushes code, so it lists every PR first and waits out the same window.
    expect([ACTION.fix.effect, actionForKey({ key: "f" })?.id]).toEqual(["confirm", "fix"]);
    // b starts one thread for the selected Your turn PRs at once, as Reviews does: the thread, not the key, pushes and replies, and the
    // same Undo window holds it first. A held b starts one.
    expect([ACTION.address.effect, actionForKey({ key: "b" })?.id, actionForKey({ key: "b", repeat: true }), actionForKey({ key: "b", metaKey: true })])
      .toEqual(["start", "address", null, null]);
    expect(DECK_ACTIONS.filter((action) => action.effect === "start").map((action) => action.id)).toEqual(["address"]);
    // Nothing else reaches a write: every other action moves, changes the view, or opens a dialog.
    expect(DECK_ACTIONS.filter((action) => action.effect === "confirm" || action.effect === "start" || action.effect === "preview").map((action) => action.id).sort())
      .toEqual([...writes, "release", "fix", "address"].sort());
  });

  it("repeats only row movement while a key is held, so a held a or n can't open two confirms", () => {
    expect(actionForKey({ key: "j", repeat: true })).toEqual({ id: "row-next" });
    expect(actionForKey({ key: "ArrowUp", repeat: true })).toEqual({ id: "row-prev" });
    expect(actionForKey({ key: "a", repeat: true })).toBeNull();
    expect(actionForKey({ key: "3", repeat: true })).toBeNull();
  });

  it("reads arrows, brackets, numbers, Shift letters, and ⌘K, and ignores other modified keys", () => {
    expect(["]", "ArrowRight", "[", "ArrowLeft"].map((key) => actionForKey({ key })?.id)).toEqual(["next", "next", "prev", "prev"]);
    expect(actionForKey({ key: "4" })).toEqual({ id: "jump", n: 4 });
    expect(actionForKey({ key: "0" })).toBeNull();
    expect(actionForKey({ key: "X", shiftKey: true })).toEqual({ id: "select-section" });
    expect(actionForKey({ key: "H", shiftKey: true })).toEqual({ id: "held" });
    expect([actionForKey({ key: "N", shiftKey: true }), actionForKey({ key: "n" })]).toEqual([{ id: "notes" }, { id: "nudge" }]);
    // Caps Lock types H without Shift: that's no key here, and neither is a Shift letter the registry doesn't name.
    expect(actionForKey({ key: "H" })).toBeNull();
    expect(actionForKey({ key: "Q", shiftKey: true })).toBeNull();
    expect(actionForKey({ key: "k", metaKey: true })).toEqual({ id: "palette" });
    expect(actionForKey({ key: "a", altKey: true })).toBeNull();
    expect(actionForKey({ key: "c", ctrlKey: true })).toBeNull();
  });

  it("leaves typing alone", () => {
    expect(typingTarget({ closest: (selector: string) => selector.includes("textarea") ? {} : null })).toBe(true);
    expect(typingTarget({ closest: () => null })).toBe(false);
    expect(typingTarget(null)).toBe(false);
  });

  // A click on a row's selection box focuses it in Chromium, so b after picking rows used to do nothing at all: the box read as typing.
  it("acts from a focused checkbox or radio, which take no text, and still leaves a text field alone", () => {
    // closest() as the DOM answers it for one element: a part of the selector list naming its tag matches, unless the part excludes its type.
    const field = (tag: string, type = "") => ({ closest: (selector: string) => selector.split(",").map((part) => part.trim())
      .some((part) => part.startsWith(tag) && !part.includes(`:not([type=${type}])`)) ? {} : null });
    expect([field("input", "checkbox"), field("input", "radio")].map(typingTarget)).toEqual([false, false]);
    expect([field("input", "text"), field("textarea"), field("select")].map(typingTarget)).toEqual([true, true, true]);
  });
});

describe("the thread effort popover's keys", () => {
  it("moves, picks, and backs out with the keys that move, open, and leave rows in the deck", () => {
    const deckMeaning = (token: string) => DECK_ACTIONS.find((action) => action.keys.includes(token))?.id;
    expect(PICKER_ACTIONS.map((action) => [action.id, action.keys.map(deckMeaning)])).toEqual([
      ["pick-next", ["row-next"]], ["pick-prev", ["row-prev"]], ["pick", ["expand"]], ["pick-back", ["clear"]]]);
    expect(["ArrowDown", "ArrowUp", "Enter", "Escape"].map((key) => pickerActionForKey({ key }))).toEqual(["pick-next", "pick-prev", "pick", "pick-back"]);
  });

  it("binds no letter or number, since you type in its field, and no modified key", () => {
    for (const key of ["j", "k", "a", "x", "1", " ", "Tab"]) expect(pickerActionForKey({ key })).toBeNull();
    expect(pickerActionForKey({ key: "Enter", metaKey: true })).toBeNull();
    expect(pickerActionForKey({ key: "Enter", shiftKey: true })).toBeNull();
  });

  it("repeats only movement while a key is held, so a held ↵ picks once", () => {
    expect(pickerActionForKey({ key: "ArrowDown", repeat: true })).toBe("pick-next");
    expect(pickerActionForKey({ key: "Enter", repeat: true })).toBeNull();
  });
});
