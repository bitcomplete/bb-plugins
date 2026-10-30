import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { effortColor } from "./deck-view-model.js";
import type { ThreadEffortPicker } from "./thread-effort.js";
import { pickerItems, type PickerItem } from "./thread-effort-picker.js";
import { PickerBody, ThreadEffortBar, type PickerBodyProps, type ThreadEffortBarProps } from "./thread-effort-popover.js";

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&quot;/gu, '"').replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/\s+/gu, " ").trim();
const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const choice = (id: string, name: string, patch: Partial<ThreadEffortPicker["choices"][number]> = {}): ThreadEffortPicker["choices"][number] =>
  ({ key: `effort:${id}`, id, name, oneOff: false, held: false, yourTurn: 0, signal: null, score: 0, ...patch });
const PICKER: ThreadEffortPicker = {
  chip: { kind: "effort", effortId: "shelf", name: "Shelf order", oneOff: false, yourTurn: 5, card: "shelf" },
  choices: [choice("shelf", "Shelf order", { yourTurn: 5 }), choice("pickup", "Store pickup", { signal: "ABC-121 in the title", score: 3, yourTurn: 3 }),
    choice("gifts", "Gift cards", { held: true })],
  linked: [{ url: url("folio", 340), ref: "folio #340", title: "ABC-360 Store shelf order", effortId: "shelf", effortName: "Shelf order", sourceIds: ["ticket:ABC-360"], also: [] },
    { url: url("folio", 96), ref: "folio #96", title: "ABC-121 Show series order", effortId: "pickup", effortName: "Store pickup", sourceIds: ["ticket:ABC-121"], also: [] }],
  jev: false,
};

function bar(patch: Partial<ThreadEffortBarProps> = {}) {
  return renderToStaticMarkup(createElement(ThreadEffortBar, { chip: PICKER.chip, readError: null, onRetry: noop, open: false, onOpenChange: noop, onCard: noop,
    onEscape: () => false, flash: null, onUndo: noop, ...patch }));
}
function body(patch: Partial<PickerBodyProps> = {}, items: PickerItem[] = pickerItems({ picker: PICKER, currentKey: "effort:shelf", query: "", mode: "effort",
  linkable: [], linkedUrl: null, jev: { state: "idle", keys: [], name: null } })) {
  return renderToStaticMarkup(createElement(PickerBody, { mode: "effort", query: "", items, highlight: -1, busy: false, linked: PICKER.linked,
    current: { id: "shelf", name: "Shelf order" }, confirm: null, notice: null, error: null, listId: "picker", onQuery: noop, onKeyDown: noop, onPick: noop,
    onHighlight: noop, onLinkMode: noop, onMove: noop, onConfirmMove: noop, onCancelMove: noop, onOpenPr: noop, ...patch }));
}
const options = (html: string) => [...html.matchAll(/role="option"[^>]*data-picker-item="([^"]+)"[^>]*>(.*?)<\/div>(?=<div|<\/div>)/gu)].map((match) => text(match[2]!));

describe("the thread's effort chip", () => {
  // Its count is the deck's strip chip's: Your turn, so amber means a person waits on you.
  it("shows the effort's color dot, name, and Your turn, opens its card, and splits off the ⌄ that opens the popover", () => {
    const html = bar();
    expect(html).toContain(`background:${effortColor("shelf")}`);
    expect(html).toMatch(/data-effort-chip="effort"[^>]*title="Shelf order, 5 your turn. Open its card"/u);
    expect(text(html)).toBe("Shelf order 5 ⌄");
    expect(html).toMatch(/data-effort-open[^>]*aria-label="Change the thread&#x27;s effort"/u);
  });

  it("names a service fallback with a hollow dot and its Your turn, which opens its card, and a thread with no effort without a count", () => {
    const service = bar({ chip: { kind: "service", effortId: null, name: "folio · service", oneOff: false, yourTurn: 2, card: "service:inkwell/folio" } });
    // The same hollow amber dot the deck gives a service card.
    expect(service).toMatch(/border-dashed[^"]*" style="border-color:#d3a35a"/u);
    expect(text(service)).toBe("folio · service 2 ⌄");
    expect(service).toContain("folio · service, 2 your turn. Open its card");
    expect(text(bar({ chip: { kind: "none", effortId: null, name: "No effort", oneOff: false, yourTurn: 0, card: null } }))).toBe("No effort ⌄");
  });

  it("offers Undo beside the chip after a pick, and never a Save", () => {
    const html = bar({ flash: { text: "In Store pickup", undo: true } });
    expect(text(html)).toBe("Shelf order 5 ⌄ In Store pickup Undo");
    expect(html).toContain("data-effort-undo");
    expect(text(bar({ flash: { text: "Undone.", undo: false } }))).not.toContain("Undo ");
    for (const html of [bar(), body()]) expect(text(html)).not.toMatch(/\bSave\b|\bCancel\b/u);
  });
});

describe("the thread effort popover", () => {
  it("lists suggested efforts first with their signal, then the rest, + New effort, and Remove at the very bottom below the PRs", () => {
    const html = body();
    expect(options(html)).toEqual(["Store pickup ABC-121 in the title", "Gift cards on hold", "Shelf order 5 ✓", "+ New effort… type its name", "Remove from effort"]);
    expect(text(html).indexOf("Suggested")).toBeLessThan(text(html).indexOf("Store pickup"));
    expect(html.lastIndexOf("data-picker-item=\"remove\"")).toBeGreaterThan(html.indexOf("data-link-pr"));
  });

  it("marks the highlighted row for the keys: selected, the field's active option, and ↵", () => {
    const html = body({ highlight: 0 });
    expect(html).toMatch(/aria-activedescendant="picker-0"/u);
    expect(html).toMatch(/id="picker-0" role="option" aria-selected="true"/u);
    expect(options(html)[0]).toBe("Store pickup ABC-121 in the title ↵");
    expect(html).toMatch(/aria-activedescendant/u);
    expect(body()).not.toMatch(/aria-activedescendant/u);
  });

  it("shows linked PRs as chips, offers to move one from another effort here, and links another inline", () => {
    const html = body();
    const group = html.slice(html.indexOf('aria-label="Linked PRs"'), html.indexOf("data-link-pr"));
    const chips = group.split('data-linked-pr="').slice(1).map((part) => text(`${part.slice(part.indexOf(">") + 1)}>`));
    expect(chips).toEqual(["folio #340", "folio #96 · Store pickup Move here"]);
    expect(html).toMatch(/data-linked-move[^>]*title="Move folio #96 with its ticket to Shelf order"/u);
    expect(text(html)).toContain("+ Link PR");
    // With no effort of its own, the thread has nowhere to move work to.
    expect(body({ current: null })).not.toContain("data-linked-move");
  });

  it("lists what else a Move here takes and waits for Move all, when it takes more than its PR and tickets", () => {
    const wide = { ...PICKER.linked[1]!, also: ["folio #97", "ABC-122", "1 checkout"] };
    const html = body({ linked: [PICKER.linked[0]!, wide] });
    expect(html).toMatch(/data-linked-move[^>]*>Move here…<\/button>/u);
    expect(html).not.toContain("data-move-confirm");
    const asking = body({ linked: [PICKER.linked[0]!, wide], confirm: wide });
    const line = asking.slice(asking.indexOf("data-move-confirm"));
    expect(text(`<${line}`)).toMatch(/^folio #96 also moves folio #97, ABC-122 and 1 checkout\. Cancel Move all/u);
    expect(asking).toContain("data-move-all");
  });

  it("switches its field and list to the PRs to link, and says when none matches", () => {
    const items = pickerItems({ picker: PICKER, currentKey: null, query: "", mode: "link", jev: { state: "idle", keys: [], name: null },
      linkable: [{ url: url("folio", 330), label: "inkwell/folio #330 · ABC-364 Keep shelf filters in the link" }], linkedUrl: null });
    const html = body({ mode: "link" }, items);
    expect(html).toMatch(/placeholder="Find a PR to link"/u);
    expect(options(html)).toEqual(["inkwell/folio #330 · ABC-364 Keep shelf filters in the link"]);
    expect(html).not.toContain("data-link-pr");
    expect(text(body({ mode: "link" }, []))).toContain("No tracked PR matches.");
  });

  it("says why a pick was refused, or what the thread's effort notes", () => {
    expect(body({ error: "Reopen this effort first." })).toMatch(/role="alert"[^>]*>Reopen this effort first\./u);
    expect(body({ notice: "1 linked PR group has work assigned to another effort." })).toMatch(/role="status"/u);
  });
});


it("shows saving feedback beside the chip and prevents starting another pick", () => {
  const html = bar({ busy: true, flash: { text: "In Shelf order", undo: true } });
  expect(text(html)).toContain("Saving effort…");
  expect(html).toMatch(/data-effort-open[^>]*disabled/u);
  expect(html).not.toContain("data-effort-undo");
});
