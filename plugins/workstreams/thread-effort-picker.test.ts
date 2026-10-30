import { describe, expect, it } from "vitest";
import { pickerActionForKey } from "./deck-keys.js";
import type { ThreadEffortPicker } from "./thread-effort.js";
import { MAX_SUGGESTED, pickedText, pickerItems, pickerStep, startHighlight, type JevAnswer, type PickerItem } from "./thread-effort-picker.js";

const choice = (key: string, name: string, patch: Partial<ThreadEffortPicker["choices"][number]> = {}): ThreadEffortPicker["choices"][number] =>
  ({ key: `effort:${key}`, id: key, name, oneOff: false, held: false, yourTurn: 0, signal: null, score: 0, ...patch });
const PICKER: ThreadEffortPicker = {
  chip: { kind: "effort", effortId: "shelf", name: "Shelf order", oneOff: false, yourTurn: 2, card: "shelf" },
  choices: [
    choice("gifts", "Gift cards", { held: true }),
    choice("one-offs", "One-offs", { oneOff: true }),
    choice("pickup", "Store pickup", { signal: "ABC-121 in the title", score: 3 }),
    choice("shelf", "Shelf order", { signal: "has folio #340", score: 6, yourTurn: 2 }),
    choice("hours", "Store hours", { signal: "parent thread's effort", score: 2 }),
    choice("catalog", "Catalog pages", { signal: "ticket ABC-130", score: 1 }),
  ],
  linked: [], jev: false,
};
const NO_JEV: JevAnswer = { state: "idle", keys: [], name: null };
const list = (patch: Partial<Parameters<typeof pickerItems>[0]> = {}) => pickerItems({ picker: PICKER, currentKey: null, query: "", mode: "effort",
  linkable: [], linkedUrl: null, jev: NO_JEV, ...patch });
const names = (items: PickerItem[]) => items.map((item) => item.kind === "effort" ? `${item.suggested ? "* " : ""}${item.name}${item.current ? " ✓" : ""}`
  : item.kind === "new" ? `+ ${item.name}` : item.kind === "pr" ? item.label : item.kind);

describe("the thread effort popover's list", () => {
  it("leads with at most three suggestions, strongest first, then every other effort by name, then + New effort", () => {
    expect(MAX_SUGGESTED).toBe(3);
    expect(names(list())).toEqual(["* Shelf order", "* Store pickup", "* Store hours", "Catalog pages", "Gift cards", "One-offs", "+ "]);
    const first = list()[0]!;
    expect(first).toMatchObject({ kind: "effort", signal: "has folio #340", suggested: true });
  });

  it("never suggests the thread's own effort: it keeps its place by name with a check, and Remove comes last", () => {
    const items = list({ currentKey: "effort:shelf" });
    expect(names(items)).toEqual(["* Store pickup", "* Store hours", "* Catalog pages", "Gift cards", "One-offs", "Shelf order ✓", "+ ", "remove"]);
    expect(items.at(-1)).toEqual({ kind: "remove", name: "Shelf order" });
  });

  it("narrows by what you type, offers the typed name as a new effort, and drops it once the name is taken", () => {
    expect(names(list({ query: "store" }))).toEqual(["* Store pickup", "* Store hours", "+ store"]);
    expect(names(list({ query: "  Shelf   redesign " }))).toEqual(["+ Shelf redesign"]);
    expect(names(list({ query: "gift CARDS" }))).toEqual(["Gift cards"]);
  });

  it("offers Jev only on request, when it can run and nothing else is suggested, and puts its matches after the signals'", () => {
    const quiet: ThreadEffortPicker = { ...PICKER, jev: true, choices: PICKER.choices.map((item) => ({ ...item, signal: null, score: 0 })) };
    expect(names(list({ picker: quiet }))[0]).toBe("jev");
    expect(names(list({ picker: quiet, query: "s" }))).not.toContain("jev");
    expect(names(list({ picker: { ...PICKER, jev: true } }))).not.toContain("jev");
    const answered = list({ picker: quiet, jev: { state: "done", keys: ["effort:gifts"], name: "Shelf gaps" } });
    expect(names(answered)).toEqual(["* Gift cards", "Catalog pages", "One-offs", "Shelf order", "Store hours", "Store pickup", "+ Shelf gaps"]);
    expect(answered[0]).toMatchObject({ signal: "Jev: strong match" });
  });

  it("lists tracked PRs to link, narrowed as you type, with the linked one checked", () => {
    const linkable = [{ url: "https://github.com/inkwell/folio/pull/340", label: "inkwell/folio #340 · ABC-360 Store shelf order" },
      { url: "https://github.com/inkwell/atlas/pull/12", label: "inkwell/atlas #12 · Map the stacks" }];
    expect(names(list({ mode: "link", linkable, linkedUrl: linkable[1]!.url }))).toEqual([linkable[0]!.label, linkable[1]!.label]);
    expect(list({ mode: "link", linkable, linkedUrl: linkable[1]!.url })[1]).toMatchObject({ current: true });
    expect(names(list({ mode: "link", linkable, query: "atlas" }))).toEqual([linkable[1]!.label]);
  });
});

describe("the thread effort popover's keys", () => {
  const step = (key: string, highlight: number, count = 4, mode: "effort" | "link" = "effort") => {
    const action = pickerActionForKey({ key });
    return action && pickerStep(action, { highlight, count, mode });
  };

  it("starts with nothing highlighted, so ↵ on opening picks nothing, and on the first match once you type", () => {
    expect(startHighlight("")).toBe(-1);
    expect(step("Enter", -1)).toBeNull();
    expect(startHighlight("sto")).toBe(0);
  });

  it("moves with ↓ and ↑, stopping at the last row and returning to the field above the first", () => {
    expect([step("ArrowDown", -1), step("ArrowDown", 2), step("ArrowDown", 3)]).toEqual([{ highlight: 0 }, { highlight: 3 }, { highlight: 3 }]);
    expect([step("ArrowUp", 2), step("ArrowUp", 0), step("ArrowUp", -1)]).toEqual([{ highlight: 1 }, { highlight: -1 }, { highlight: -1 }]);
    expect(step("ArrowDown", -1, 0)).toBeNull();
  });

  it("picks the highlighted row with ↵, and esc backs out of the PR list before it closes", () => {
    expect(step("Enter", 2)).toEqual({ pick: 2 });
    expect(step("Escape", 0, 4, "link")).toEqual({ mode: "effort" });
    expect(step("Escape", 0)).toEqual({ close: true });
  });
});

it("says what a pick did in a few words", () => {
  expect([pickedText({ kind: "set", name: "Shelf order" }), pickedText({ kind: "create", name: "Shelf gaps" }), pickedText({ kind: "remove", name: "Shelf order" }),
    pickedText({ kind: "link", ref: "folio #340" }), pickedText({ kind: "move", ref: "folio #340", name: "Store pickup" })])
    .toEqual(["In Shelf order", "Created Shelf gaps", "Out of Shelf order", "Linked folio #340", "Moved folio #340 to Store pickup"]);
});
