import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createEffortPileStore, EFFORT_PILE_MIGRATION, type PileMove } from "./effort-piles.js";
import { createEffortStore, EFFORT_MIGRATIONS } from "./effort-store.js";

function setup() {
  const db = new Database(":memory:");
  for (const statement of [...EFFORT_MIGRATIONS, EFFORT_PILE_MIGRATION]) db.prepare(statement).run();
  let clock = 1_000;
  const efforts = createEffortStore(db, () => clock);
  const piles = createEffortPileStore(db, () => clock);
  const shelf = efforts.establish({ sourceKey: "ticket:ABC-341", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: ["ABC-341"], prUrls: ["https://github.com/inkwell/folio/pull/314"] } });
  return { db, efforts, piles, shelf, tick: (ms: number) => { clock += ms; } };
}

describe("effort piles", () => {
  it("starts every effort on the active pile, joined when it was created", () => {
    const { piles, shelf } = setup();
    expect(piles.get(shelf)).toEqual({ effortId: shelf.id, pile: "active", reason: "", since: shelf.createdAt });
  });

  // The deck offers each move from one pile only; any other start means the deck showed a pile that has since changed.
  it.each<[PileMove[], string]>([
    [["hold", "hold"], "This effort is already on hold."],
    [["resume"], "This effort is already active."],
    [["reopen"], "This effort is already active."],
    [["complete", "hold"], "This effort is done. Refresh the deck."],
    [["complete", "resume"], "This effort is done. Refresh the deck."],
    [["hold", "reopen"], "This effort is on hold. Refresh the deck."],
    [["complete", "complete"], "This effort is already done."],
  ])("refuses %j with %j", (moves, error) => {
    const { piles, shelf } = setup();
    for (const move of moves.slice(0, -1)) piles.move(shelf, move);
    expect(() => piles.move(shelf, moves.at(-1)!)).toThrow(error);
  });

  it("holds with a reason, completes from hold, and sends a resumed or reopened effort to the end of the active pile", () => {
    const { piles, shelf, tick } = setup();
    tick(10);
    expect(piles.move(shelf, "hold", "  Waiting on the store layout review ")).toMatchObject({ pile: "held", reason: "Waiting on the store layout review", since: 1_010 });
    tick(10);
    expect(piles.move(shelf, "resume")).toEqual({ effortId: shelf.id, pile: "active", reason: "", since: 1_020 });
    piles.move(shelf, "hold");
    tick(10);
    // Only a hold keeps a reason: completing a held effort drops it.
    expect(piles.move(shelf, "complete", "ignored")).toMatchObject({ pile: "done", reason: "", since: 1_030 });
    tick(10);
    expect(piles.move(shelf, "reopen")).toMatchObject({ pile: "active", since: 1_040 });
  });

  // effort save() spreads the object a coordinator read earlier; a pile kept in the effort's JSON would be reset by it.
  it("never writes the effort's record, so a stale coordinator save can't undo a move", () => {
    const { efforts, piles, shelf } = setup();
    const stale = efforts.get(shelf.id)!;
    piles.move(shelf, "hold", "Paused by design");
    expect(efforts.get(shelf.id)).toEqual(stale);
    efforts.save({ ...stale, coordinatorState: "unavailable" });
    expect(piles.get(shelf)).toMatchObject({ pile: "held", reason: "Paused by design" });
    expect(efforts.get(shelf.id)!.members).toEqual(stale.members);
  });
});
