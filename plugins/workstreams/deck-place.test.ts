import { describe, expect, it } from "vitest";
import { anchorScroll, deckRing, focusFallback, keepOrder, landAfter, meltSlack, numberedEffort, readPlace, readSeen, settleRows, snapshotOf, withArrivals, type FocusDom,
  type SettledRow } from "./deck-place.js";

const DAY = 86_400_000;
const settled = (prUrl: string, section: string, status = "Awaiting review"): SettledRow => ({ prUrl, ref: prUrl, title: `Title ${prUrl}`, section, status });
const row = (prUrl: string, section: string, status = "Awaiting review") => ({ prUrl, section, status });
const shape = (items: ReturnType<typeof settleRows>) => items.map((item) =>
  `${item.section}:${item.prUrl}${item.ghost ? " ghost" : ""}${item.arrived ? " new" : ""}${item.change ? ` ${item.change.was}→${item.change.now}` : ""}`);

describe("settling deck rows in place", () => {
  it("keeps a row a read changed in the section you last saw it in, marked, so nothing moves under you until Mark seen", () => {
    const snapshot = [settled("a", "nudge"), settled("b", "nudge"), settled("c", "work", "CI failing")];
    const next = [row("a", "flight", "In review"), row("b", "nudge"), row("c", "work", "CI running")];
    expect(shape(settleRows(snapshot, next, ["merge", "nudge", "work", "flight"]))).toEqual([
      "nudge:a Awaiting review→In review", "nudge:b", "work:c CI failing→CI running"]);
  });

  it("keeps a row that left as a ghost where it was, and puts a new row at the end of its own section", () => {
    const snapshot = [settled("a", "merge"), settled("b", "merge"), settled("c", "work")];
    const next = [row("c", "work"), row("d", "merge"), row("a", "merge")];
    // b merged elsewhere: its ghost holds its line, so a stays on the same row, and d joins merge after the rows you already saw.
    expect(shape(settleRows(snapshot, next, ["merge", "work"]))).toEqual(["merge:a", "merge:b ghost", "merge:d new", "work:c"]);
  });

  it("marks nothing as news on a view's first read, and settles everything on Mark seen", () => {
    const next = [row("a", "merge"), row("b", "work")];
    expect(shape(settleRows(undefined, next, ["merge", "work"]))).toEqual(["merge:a", "work:b"]);
    const changed = [row("a", "flight", "In review"), row("b", "work")];
    const snapshot = snapshotOf(next.map((item) => ({ ...item, ref: item.prUrl, title: item.prUrl })));
    expect(shape(settleRows(snapshot, changed, ["merge", "work", "flight"]))).toEqual(["merge:a Awaiting review→In review", "work:b"]);
    const marked = snapshotOf(changed.map((item) => ({ ...item, ref: item.prUrl, title: item.prUrl })));
    expect(shape(settleRows(marked, changed, ["merge", "work", "flight"]))).toEqual(["work:b", "flight:a"]);
  });

  it("keeps a row that arrived since you looked where it joined, new, and as a ghost if it leaves again, until Mark seen", () => {
    const snapshot = [settled("a", "merge"), settled("c", "work")];
    const arrived = withArrivals(snapshot, [settled("a", "merge"), settled("d", "merge", "Ready to merge"), settled("c", "work")])!;
    expect(arrived.map((item) => [item.prUrl, item.arrived ?? false])).toEqual([["a", false], ["c", false], ["d", true]]);
    expect(withArrivals(arrived, [settled("a", "merge"), settled("d", "merge")])).toBeNull();
    // A refresh finds d merged and a moved on: both stay put, d as a ghost, and nothing shifts.
    expect(shape(settleRows(arrived, [row("a", "flight", "In review"), row("c", "work")], ["merge", "work", "flight"])))
      .toEqual(["merge:a Awaiting review→In review", "merge:d ghost new", "work:c"]);
    // It stays in the stored place too, and Mark seen, which snapshots rows as they are, lets it go.
    expect(readSeen(JSON.stringify({ rows: { shelf: arrived }, at: {} }), 0).rows.shelf).toEqual(arrived);
    expect(snapshotOf(arrived).some((item) => "arrived" in item)).toBe(false);
  });

  it("orders sections it doesn't know by first appearance, so a suggestion group keeps its place", () => {
    const snapshot = [settled("a", "effort:shelf"), settled("b", "new:ABC-1"), settled("c", "effort:shelf")];
    expect(shape(settleRows(snapshot, [row("c", "effort:shelf"), row("b", "new:ABC-1"), row("d", "one-off")])))
      .toEqual(["effort:shelf:a ghost", "effort:shelf:c", "new:ABC-1:b", "one-off:d new"]);
  });
});

describe("the session's card order", () => {
  it("starts the flip ring on Overview while number keys still select active efforts", () => {
    expect(deckRing(["shelf", "pickup", "service:inkwell/folio"])).toEqual(["overview", "shelf", "pickup", "service:inkwell/folio"]);
    expect(deckRing([])).toEqual(["overview"]);
    expect(numberedEffort(["shelf", "pickup"], 1)).toBe("shelf");
    expect(numberedEffort(["shelf", "pickup"], 2)).toBe("pickup");
    expect(numberedEffort(["shelf", "pickup"], 3)).toBeNull();
    // The deck opens on Overview, and lands there when its last card leaves.
    expect(landAfter([], null, deckRing(["shelf", "pickup"]))).toBe("overview");
    expect(landAfter(["shelf"], "shelf", deckRing([]))).toBe("overview");
    // Before the first read, the card you were on keeps its place: nothing lands, so a reload returns to it rather than to Overview.
    expect(deckRing(null)).toEqual([]);
    expect(landAfter(["shelf", "pickup"], "pickup", deckRing(null))).toBeNull();
    expect(landAfter(["shelf", "pickup"], "pickup", deckRing(["shelf", "pickup"]))).toBe("pickup");
  });
  it("keeps number keys pointing at the same efforts: new, resumed, and reopened cards join the end", () => {
    expect(keepOrder(["shelf", "pickup", "one-offs"], ["pickup", "shelf", "one-offs", "gifts"])).toEqual(["shelf", "pickup", "one-offs", "gifts"]);
    // Holding pickup drops it; resuming it later puts it back at the end, not in its old slot.
    expect(keepOrder(["shelf", "pickup", "one-offs"], ["shelf", "one-offs"])).toEqual(["shelf", "one-offs"]);
    expect(keepOrder(["shelf", "one-offs"], ["pickup", "shelf", "one-offs"])).toEqual(["shelf", "one-offs", "pickup"]);
    expect(keepOrder([], ["b", "a"])).toEqual(["b", "a"]);
  });

  // Mark seen on an emptied service card lets it go; the deck lands where the strip closed up, never back at the start.
  it("lands on the next card when the one shown leaves, else the one before it", () => {
    const seen = ["shelf", "service:inkwell/folio", "service:inkwell/atlas"];
    expect(landAfter(seen, "service:inkwell/folio", ["shelf", "service:inkwell/atlas"])).toBe("service:inkwell/atlas");
    expect(landAfter(seen, "service:inkwell/atlas", ["shelf", "service:inkwell/folio"])).toBe("service:inkwell/folio");
    expect(landAfter(seen, "shelf", ["shelf", "service:inkwell/atlas"])).toBe("shelf");
    // A card the session never saw, or none yet, starts at the first; an empty deck shows none.
    expect(landAfter(seen, "gone", ["shelf"])).toBe("shelf");
    expect(landAfter([], null, ["pickup", "shelf"])).toBe("pickup");
    expect(landAfter(seen, "shelf", [])).toBeNull();
  });

  // A17.1: service cards stand in for efforts no one made yet, so they follow every real one in the strip, whatever the session saw first.
  it("keeps the service cards after every effort: a new or promoted effort joins the end of the efforts, before them", () => {
    expect(keepOrder(["shelf", "service:inkwell/folio", "service:inkwell/atlas"], ["shelf", "service:inkwell/atlas", "folio", "service:inkwell/folio"]))
      .toEqual(["shelf", "folio", "service:inkwell/folio", "service:inkwell/atlas"]);
    expect(keepOrder([], ["service:inkwell/atlas", "shelf"])).toEqual(["shelf", "service:inkwell/atlas"]);
  });
});

describe("scroll anchors", () => {
  it("holds a row at its pixel when content above it grows or shrinks", () => {
    // The row sat 120px down; a read added 60px above it, so it now sits at 180px.
    expect(anchorScroll({ scrollTop: 400, slack: 0, at: 180, want: 120 })).toEqual({ scrollTop: 460, slack: 0 });
    expect(anchorScroll({ scrollTop: 400, slack: 0, at: 90, want: 120 })).toEqual({ scrollTop: 370, slack: 0 });
  });

  it("grows a spacer above the view when holding the row would need a negative scroll, even at the top of the list", () => {
    // Mark seen removed 50px of ghosts above a row 40px down at the very top: it would jump up without the spacer.
    const held = anchorScroll({ scrollTop: 0, slack: 0, at: -10, want: 40 });
    expect(held).toEqual({ scrollTop: 0, slack: 50 });
    // The spacer shrinks before the scroll does, and melts once you scroll past it, without moving what you see.
    expect(anchorScroll({ scrollTop: 0, slack: 50, at: 70, want: 40 })).toEqual({ scrollTop: 0, slack: 20 });
    expect(meltSlack({ scrollTop: 80, slack: 50 })).toEqual({ scrollTop: 30, slack: 0 });
    expect(meltSlack({ scrollTop: 20, slack: 50 })).toEqual({ scrollTop: 20, slack: 50 });
  });
});

describe("focus after an action or a dialog", () => {
  type El = { name: string; live: boolean };
  const dom = (found: Partial<Record<"byId" | "row" | "next" | "first" | "heading", El>>): FocusDom<El> => ({
    byId: () => found.byId ?? null, row: () => found.row ?? null, nextLiveRow: () => found.next ?? null, firstLiveRow: () => found.first ?? null,
    heading: () => found.heading ?? null, live: (element) => element.live });
  const el = (name: string, live = true): El => ({ name, live });

  it("returns to the same control, else its row, else the next live row, else the first in view, else the card heading, never the page", () => {
    expect(focusFallback({ id: "b-nudge", row: "a" }, dom({ byId: el("button"), row: el("row a") }))?.name).toBe("button");
    // The button went disabled when its section emptied: its row takes focus.
    expect(focusFallback({ id: "b-nudge", row: "a" }, dom({ byId: el("button", false), row: el("row a") }))?.name).toBe("row a");
    // The row left too: the next live row from its section on.
    expect(focusFallback({ id: "b-nudge", row: "a", section: "nudge" }, dom({ next: el("row b"), first: el("row z") }))?.name).toBe("row b");
    expect(focusFallback({ row: "a" }, dom({ first: el("row z"), heading: el("heading") }))?.name).toBe("row z");
    expect(focusFallback({}, dom({ heading: el("heading") }))?.name).toBe("heading");
  });
});

describe("stored place", () => {
  it("reads back what the session kept, and drops what it can't trust instead of failing", () => {
    const place = { view: "prs", cur: "effort-shelf", order: ["effort-shelf", 3], views: { "effort-shelf": { anchor: { row: "inkwell/folio#340", at: 12 },
      scrollTop: 300, focus: "inkwell/folio#340", unpicked: ["u", 4], open: ["progress"], panel: "held" },
      // An earlier build's selection, details, tiles, and filter: this one keeps none of them, so they drop rather than mean something else.
      "effort-pickup": { selected: ["u"], expanded: ["u"], tiles: ["next"], filter: { kind: "needs", prUrls: ["u"] }, panel: 7 }, broken: 7 } };
    expect(readPlace(JSON.stringify(place))).toEqual({ view: "prs", cur: "effort-shelf", order: ["effort-shelf"], views: { "effort-shelf": {
      anchor: { row: "inkwell/folio#340", at: 12 }, scrollTop: 300, focus: "inkwell/folio#340", unpicked: ["u"], open: ["progress"], panel: "held" },
      "effort-pickup": { anchor: null, scrollTop: 0, focus: null, unpicked: [], open: [], panel: null } } });
    expect(readPlace("{not json")).toEqual({ view: "deck", cur: null, order: [], views: {} });
    expect(readPlace(null).view).toBe("deck");
  });

  it("forgets seen marks older than a write's day, which no longer change what counts", () => {
    const now = 10 * DAY;
    const seen = readSeen(JSON.stringify({ rows: { shelf: [settled("a", "merge"), { prUrl: 3 }] }, at: { a: now - DAY + 1, b: now - DAY, c: "x" } }), now);
    expect(seen).toEqual({ rows: { shelf: [settled("a", "merge")] }, at: { a: now - DAY + 1 } });
  });
});
