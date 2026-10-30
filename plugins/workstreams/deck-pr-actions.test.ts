import { describe, expect, it } from "vitest";
import { inkwellDeck, inkwellInventory, INVENTORY_EFFORTS, INVENTORY_NOW as now } from "./inkwell-fixtures.js";
import { cardScreen } from "./deck-view-model.js";
import { inventoryScreen } from "./inventory-view-model.js";
import { cardPrActions, cardPrIntent } from "./deck-pr-actions.js";

const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const rows = new Map(inventoryScreen(inkwellInventory(), { now, filter: null }).groups.flatMap((group) => group.lines.map((line) => [line.prUrl, line] as const)));
const view = inkwellDeck();
const screen = (id: string) => cardScreen(view.active.find((card) => card.id === id)!, { rows: {} }, { now });

describe("acting directly on a card's PR", () => {
  it("previews exactly one merge and preserves the PR view's disabled stack gate", () => {
    const shelf = screen(INVENTORY_EFFORTS.shelf.id);
    expect(cardPrIntent(shelf, url("folio", 340), "merge", rows.get(url("folio", 340)))).toEqual({ kind: "merge", prUrl: url("folio", 340) });
    const child = cardPrActions(shelf, url("folio", 341), rows.get(url("folio", 341))).find((action) => action.id === "merge");
    expect(child).toMatchObject({ enabled: false, why: "Merge #340 first; this one follows it" });
    expect(cardPrIntent(shelf, url("folio", 341), "merge", rows.get(url("folio", 341)))).toBeNull();
  });

  it("uses the clicked PR's owning card on Overview, with no sibling PRs or unrelated selection in the plan", () => {
    const oneOffs = screen("effort-one-offs"), prUrl = url("catalog", 96);
    expect(cardPrIntent(oneOffs, prUrl, "nudge", rows.get(prUrl))).toEqual({ kind: "batch", action: "nudge", effortId: oneOffs.card.id, prUrls: [prUrl] });
    expect(cardPrIntent(screen(INVENTORY_EFFORTS.shelf.id), prUrl, "nudge", rows.get(prUrl))).toBeNull();
    expect(cardPrIntent(oneOffs, prUrl, "move", rows.get(prUrl))).toEqual({ kind: "move", prUrls: [prUrl], refs: ["catalog #96"] });
  });

  it("starts Address for just the clicked feedback PR and offers the same dismissal workflow", () => {
    const pickup = screen(INVENTORY_EFFORTS.pickup.id), prUrl = url("quill", 210);
    expect(cardPrIntent(pickup, prUrl, "address", rows.get(prUrl))).toEqual({ kind: "address", effortId: pickup.card.id, prUrls: [prUrl] });
    expect(cardPrIntent(pickup, prUrl, "dismiss", rows.get(prUrl))).toEqual({ kind: "dismiss", prUrl, dismiss: true });
  });

  it("releases just the held PR; a paused effort offers reads but cannot release or act on its PRs", () => {
    const heldView = inkwellDeck({}, (row) => row.number === 343 ? { hold: { reason: "Wait for launch", heldAt: now } } : {});
    const shelf = cardScreen(heldView.active.find((card) => card.id === INVENTORY_EFFORTS.shelf.id)!, { rows: {} }, { now });
    const prUrl = url("folio", 343);
    expect(cardPrIntent(shelf, prUrl, "release", rows.get(prUrl))).toEqual({ kind: "batch", action: "release", effortId: shelf.card.id, prUrls: [prUrl] });
    expect(cardPrIntent(shelf, prUrl, "merge", rows.get(prUrl))).toBeNull();
    const paused = { ...shelf, card: { ...shelf.card, pile: "held" as const } };
    expect(cardPrIntent(paused, prUrl, "release", rows.get(prUrl))).toBeNull();
    expect(cardPrIntent(paused, prUrl, "refresh", rows.get(prUrl))).toEqual({ kind: "refresh", prUrls: [prUrl] });
  });

  it("keeps queued PRs from starting a duplicate write and carries disabled reasons from the PR view", () => {
    const oneOffs = screen("effort-one-offs"), prUrl = url("catalog", 96), inventory = rows.get(prUrl)!;
    const live = new Map([[prUrl, { kind: "nudge" as const, state: "pending" as const }]]);
    expect(cardPrIntent(oneOffs, prUrl, "nudge", inventory, { live })).toBeNull();
    expect(cardPrIntent(oneOffs, prUrl, "hold", inventory, { live })).toBeNull();
    const limited = { ...inventory, actions: inventory.actions.map((action) => action.id === "nudge" ? { ...action, enabled: false, why: "GitHub rate limit; try later" } : action) };
    expect(cardPrActions(oneOffs, prUrl, limited).find((action) => action.id === "nudge")).toMatchObject({ enabled: false, why: "GitHub rate limit; try later" });
    expect(cardPrIntent(oneOffs, prUrl, "nudge", limited)).toBeNull();
  });
  it("offers a fresh conversation for idle PRs even when the previous thread is archived", () => {
    const pickup = screen(INVENTORY_EFFORTS.pickup.id), prUrl = url("quill", 210), original = rows.get(prUrl)!;
    const idle = { ...original, sent: { state: "idle" as const, threadId: "archived-worker", title: null, detail: null, batchId: null }, threads: [] };
    expect(cardPrActions(pickup, prUrl, idle).find((a) => a.id === "restart")).toMatchObject({ label: "Start fresh thread", enabled: true });
    expect(cardPrIntent(pickup, prUrl, "restart", idle)).toEqual({ kind: "restart", prUrl });
  });

  it("can advance Other open PRs without an unanswered-feedback gate or an old thread", () => {
    const oneOffs = screen("effort-one-offs"), prUrl = url("catalog", 96), other = rows.get(prUrl)!;
    expect(other.turn.list).toBe("other");
    expect(cardPrIntent(oneOffs, prUrl, "restart", { ...other, threads: [], sent: null })).toEqual({ kind: "restart", prUrl });
    const paused = { ...oneOffs, card: { ...oneOffs.card, pile: "held" as const } };
    expect(cardPrIntent(paused, prUrl, "restart", other)).toBeNull();
  });

});
