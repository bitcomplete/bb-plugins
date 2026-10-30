// All PRs routes PRs into efforts: select rows and move them, or take a row's suggestion. Moves go through the deck's own assignment
// path (classify-server.test.ts pins the server side: regrouping, a new effort, and Undo); this pins what the rows offer and what each
// click sends.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inkwellInventory, inkwellInventorySuggestions, INVENTORY_EFFORTS, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import { acceptCalls, inventoryScreen, rowSuggestions } from "./inventory-view-model.js";
import { InventoryPane, splitInventory } from "./inventory-screen.js";
import { moveItems } from "./inventory-routing.js";

const SCREEN = inventoryScreen(inkwellInventory(), { now: NOW, filter: null });
const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const { shelf, pickup } = INVENTORY_EFFORTS;
const SUGGESTIONS = rowSuggestions(inkwellInventorySuggestions(), {});
const noop = () => {};
const pane = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(InventoryPane, { screen: SCREEN, busyKey: null, error: null, onView: noop,
  onPalette: noop, onHelp: noop, onOpenPr: noop, onOpenThread: noop, onOpenEffort: noop, onNudge: noop, selected: new Set<string>(), onSelect: noop, onSelectAll: noop,
  onAddress: noop, onAdvance: noop, onClear: noop, ...extra }));
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&quot;/gu, '"').replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/\s+/gu, " ");
const rowOf = (html: string, ref: string) => { const start = html.indexOf(`data-inventory-row="${ref}"`); return html.slice(start, html.indexOf("data-inventory-row=", start + 20)); };

describe("suggested efforts in All PRs", () => {
  // A suggestion one click accepts has to be one the classifier stands behind: a weak or tied pick, or one that isn't an effort, shows nothing.
  it("shows a suggestion only where the classifier picks an effort at medium or better, and hides one you dismissed for that effort", () => {
    expect([...SUGGESTIONS]).toEqual([
      [url("folio", 325), { effortId: shelf.id, name: shelf.name, reason: "ticket ABC-355 · prefix ABC" }],
      [url("folio", 301), { effortId: shelf.id, name: shelf.name, reason: "board group “Shelves”" }],
      [url("catalog", 96), { effortId: pickup.id, name: pickup.name, reason: "thread “Store pickup”" }]]);
    // folio #318 is a low pick, atlas #410 and catalog #97 a new effort, and folio #305 has no clear signal.
    for (const prUrl of [url("folio", 318), url("atlas", 410), url("catalog", 97), url("folio", 305)]) expect(SUGGESTIONS.has(prUrl)).toBe(false);
    // Dismissed for Shelf order, #325 shows none; a dismissal of another effort doesn't hide this one.
    expect(rowSuggestions(inkwellInventorySuggestions(), { [url("folio", 325)]: shelf.id }).has(url("folio", 325))).toBe(false);
    expect(rowSuggestions(inkwellInventorySuggestions(), { [url("folio", 325)]: pickup.id }).get(url("folio", 325))?.name).toBe(shelf.name);
  });

  it("draws → Effort? with why on hover only on suggested rows, an × to hide it, and Accept all on a No effort group with several", () => {
    const html = pane({ suggestions: SUGGESTIONS, onAccept: noop, onDismissSuggestion: noop });
    const chip = (ref: string) => rowOf(html, ref).match(/<span data-inventory-suggestion="[^"]*".*?<\/span>/su)?.[0] ?? null;
    expect(chip("inkwell/folio#325")).toMatch(/data-inventory-action="accept" title="ticket ABC-355 · prefix ABC" aria-label="Put it in Shelf order: ticket ABC-355 · prefix ABC"[^>]*>→ Shelf order\?<\/button>/u);
    expect(chip("inkwell/folio#325")).toContain('data-inventory-action="dismiss-suggestion" aria-label="Hide the suggestion of Shelf order"');
    expect([chip("inkwell/folio#301"), chip("inkwell/catalog#96")].map((found) => found && text(found).trim())).toEqual(["→ Shelf order? ×", "→ Store pickup? ×"]);
    for (const ref of ["inkwell/folio#318", "inkwell/atlas#410", "inkwell/catalog#97", "inkwell/folio#305", "inkwell/folio#340"]) expect(chip(ref)).toBeNull();
    // Other open PRs' No effort group has two, #96 and #325; Your turn's has only #301.
    expect([...html.matchAll(/data-inventory-action="accept-all"[^>]*>([^<]+)</gu)].map((match) => match[1])).toEqual(["Accept all suggestions (2)"]);
    // Without the handler, no chip and no Accept all: the deck's rows never offer one.
    expect(pane({ suggestions: SUGGESTIONS })).not.toMatch(/data-inventory-suggestion|accept-all/u);
  });

  // Accept all moves exactly what its header counts: each suggested row into its own suggested effort, and no row without one.
  it("accepts exactly the suggested rows, one assignment per effort, in the order the rows show", () => {
    const other = splitInventory(SCREEN).other.find((group) => group.effortId === null)!;
    expect(other.lines.map((line) => line.number)).toEqual([410, 96, 97, 305, 325]);
    expect(acceptCalls(other.lines, SUGGESTIONS)).toEqual([{ effortId: pickup.id, prUrls: [url("catalog", 96)] }, { effortId: shelf.id, prUrls: [url("folio", 325)] }]);
    expect(acceptCalls(other.lines.filter((line) => line.number === 410), SUGGESTIONS)).toEqual([]);
  });
});

describe("moving selected PRs to an effort", () => {
  // Like tagging: the efforts you have, One-offs, and a new effort by whatever you typed, so one picker reaches every destination.
  it("lists the active efforts, then One-offs, then a new effort by the typed name, narrowing as you type", () => {
    const efforts = [{ id: shelf.id, name: shelf.name }, { id: pickup.id, name: pickup.name }];
    const names = (query: string) => moveItems(efforts, query).map((item) => item.kind === "effort" ? item.name : item.kind === "new" ? `+ ${item.name}` : item.kind);
    expect(names("")).toEqual(["Shelf order", "Store pickup", "One-offs", "+ "]);
    expect(names("sto")).toEqual(["Store pickup", "+ sto"]);
    expect(names("shelf ORDER")).toEqual(["Shelf order"]);
    expect(names(" Delivery  windows ")).toEqual(["+ Delivery windows"]);
    expect(names("one-offs")).toEqual(["One-offs"]);
  });

  // Mixed selections can advance or move together; Address stays specific to unanswered feedback.
  it("offers Advance and Move for mixed selections, and Address as well for Your turn", () => {
    const move = { open: false, onOpenChange: noop, efforts: [], busy: false, onMove: async () => null };
    const mixed = pane({ selected: new Set([url("quill", 210), url("catalog", 96)]), move });
    expect(mixed).not.toContain('data-inventory-action="address"');
    expect(mixed).not.toContain("data-inventory-refusal");
    expect(text(mixed)).toContain("2 selected Advance selected Move to effort… e Refresh (2) g");
    const turn = pane({ selected: new Set([url("quill", 210), url("folio", 301)]), move });
    expect(turn).toMatch(/data-inventory-action="address" title="Starts one thread for them now, with 8 s to Undo\. Nothing merges\."[^>]*>Address 2<kbd/u);
    expect(turn).not.toContain("data-inventory-refusal");
    expect(text(turn)).toContain("Move to effort… e");
  });

  // Routing changes membership only: no GitHub write, merge, or batch rides it, and each change is one the deck's Undo reverses.
  it("calls only the classifier's read, its assignment path, Undo, and dismissal", () => {
    const source = readFileSync(new URL("inventory-routing.tsx", import.meta.url), "utf8");
    expect([...source.matchAll(/rpc\.call\("(\w+)"/gu)].map((match) => match[1])).toEqual(["classify_get", "classify_undo", "classify_dismiss", "classify_move", "classify_assign"]);
  });
});
