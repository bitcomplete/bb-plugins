import { PR_VIEW_ACTIONS } from "./deck-keys.js";
import { describe, expect, it } from "vitest";
import type { ConfirmRead } from "./approval-evidence.js";
import type { DeckCard, DeckRow, DeckView } from "./deck.js";
import { inkwellDeck, inkwellSuggestions, inkwellThreads, INVENTORY_EFFORTS, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import { availability, cardScreen, notesScreen, cardSnapshot, hintKeys, keptServiceCards, overviewScreen, paletteItems, priorityOf, rankMoves, readText, refreshNote,
  rowFacts, stripChips, targets, type Accepted, type CardScreen, type KeyContext } from "./deck-view-model.js";
import { planBatch, type PlanRow } from "./deck-batch.js";
import { DECK_ACTIONS } from "./deck-keys.js";
import type { LinearDetail } from "./linear.js";
import type { Sent } from "./your-turn.js";

const DAY = 86_400_000;
const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
/** "folio #340" from its URL. */
const ref = (prUrl: string) => prUrl.replace(/^.*\/inkwell\/([^/]+)\/pull\/(\d+)$/u, "$1 #$2");
const SHELF = INVENTORY_EFFORTS.shelf.id, PICKUP = INVENTORY_EFFORTS.pickup.id, ONE_OFFS = "effort-one-offs";
const FOLIO = "service:inkwell/folio", ATLAS = "service:inkwell/atlas", CATALOG = "service:inkwell/catalog";
const none = { rows: {} };
const cardOf = (view: DeckView, id: string) => view.active.find((item) => item.id === id)!;
const card = (view: DeckView, id: string, seen: Parameters<typeof cardScreen>[1] = none, accepted?: Accepted) => cardScreen(cardOf(view, id), seen, { now: NOW, accepted });
const rowsOf = (view: DeckView, id: string) => cardOf(view, id).sections.flatMap((section) => section.rows);
/** A card with some of its rows changed as the deck row the server sends, for a case the fixture's facts don't reach. */
const patched = (view: DeckView, id: string, patch: (row: DeckRow) => Partial<DeckRow> | null): DeckCard => ({ ...cardOf(view, id),
  sections: cardOf(view, id).sections.map((section) => ({ ...section, rows: section.rows.map((row) => ({ ...row, ...patch(row) })) })) });
/** Each move as [kind, title, meta, verb, the rows it touches]. */
const moves = (result: Pick<CardScreen, "moves">) => result.moves.map((move) => [move.kind, move.title, move.meta, move.verb, move.prUrls.map(ref)]);
const context = (screen: CardScreen | "overview", patch: Partial<KeyContext> = {}): KeyContext =>
  ({ view: "deck", cur: screen, service: FOLIO, focused: null, selected: [], seenAvailable: false, undo: false, held: 1, done: 1, ...patch });
const line = (screen: CardScreen, prUrl: string) => screen.lines.find((item) => item.prUrl === prUrl)!;

describe("the effort deck's strip", () => {
  // Amber on a chip means a person waits on you: Your turn, as All PRs counts it. Merges, fixes, nudges, and other chores of yours never
  // count, so an effort full of chores reads as quiet, and a first read puts it after one where people wait.
  it("counts Your turn on each card's chip, and nothing else, most first, with the service cards after the efforts and the first nine numbered", () => {
    const view = inkwellDeck();
    const cards = new Map(view.active.map((item) => [item.id, card(view, item.id)]));
    const chips = stripChips(view.active.map((item) => item.id), cards, SHELF);
    expect(chips.map((chip) => [chip.n, chip.name, chip.count, chip.service])).toEqual([[null, "Overview", 0, false], [1, "Store pickup", 3, false], [2, "Shelf order", 0, false],
      [3, "One-offs", 2, false], [4, "folio · service", 0, true], [5, "atlas · service", 0, true], [6, "catalog · service", 0, true]]);
    // A card keeps its number after you flip away and a read reorders the server's pile: the session order wins.
    expect(stripChips([PICKUP, ONE_OFFS, SHELF, CATALOG], cards, SHELF).map((chip) => chip.name))
      .toEqual(["Overview", "Store pickup", "One-offs", "Shelf order", "catalog · service"]);
  });

  // A hold parks a PR: its feedback waits until you release it, so it doesn't make the chip amber.
  it("leaves a held PR off its card's chip, though its feedback still waits", () => {
    const view = inkwellDeck({}, (row) => row.number === 211 ? { hold: { reason: "Waiting on the slip printer", heldAt: NOW - DAY } } : {});
    const pickup = card(view, PICKUP);
    expect(line(pickup, url("quill", 211)).row?.yourTurn).not.toBeNull();
    expect([pickup.yourTurn, stripChips([PICKUP], new Map([[PICKUP, pickup]]), null)[1]!.count]).toEqual([2, 2]);
  });

  it("ends with a service card for a repository with only threads, and Loose threads, gray, neither counting", () => {
    const view = inkwellDeck(inkwellThreads());
    const cards = new Map(view.active.map((item) => [item.id, card(view, item.id)]));
    expect(stripChips(view.active.map((item) => item.id), cards, SHELF).slice(-2).map((chip) => [chip.n, chip.name, chip.count, chip.service, chip.color]))
      .toEqual([[7, "quill · service", 0, true, "#d3a35a"], [8, "Loose threads", 0, true, "#8f8e8a"]]);
  });
});

describe("Overview", () => {
  it("uses session order and ranks blocked PRs by their recorded wait, including unknown dates last", () => {
    const view = inkwellDeck();
    const cards = new Map(view.active.map((item) => [item.id, card(view, item.id)]));
    const overview = overviewScreen([PICKUP, SHELF, ONE_OFFS], cards);
    expect(overview.cards.map((item) => item.card.id)).toEqual([PICKUP, SHELF, ONE_OFFS]);
    // Service cards and Loose threads stay on the strip: Overview sums up efforts.
    expect(overviewScreen([PICKUP, FOLIO, SHELF, ATLAS, ONE_OFFS], cards).cards.map((item) => item.card.id)).toEqual([PICKUP, SHELF, ONE_OFFS]);
    expect(overview.blockers.map((item) => item.ref)).toEqual(cardOf(view, PICKUP).blocked.map((item) => item.ref));
    const pickup = cards.get(PICKUP)!;
    const [first, second] = pickup.card.blocked;
    const mixed = new Map(cards).set(PICKUP, { ...pickup, card: { ...pickup.card, blocked: [{ ...first!, since: null }, { ...second!, since: NOW - 10 * DAY }] } });
    expect(overviewScreen([PICKUP], mixed).blockers.map((item) => item.ref)).toEqual([second!.ref, first!.ref]);
    expect(overviewScreen([], cards)).toEqual({ cards: [], blockers: [] });
    // Overview draws no rows: nothing to step through, advance, or act on, while ] still flips on.
    const on = availability(context("overview"));
    expect([on.seen.on, on.accept.on, on["row-next"].on, on["row-next"].why, on.advance.on, on.merge.on, on.next.on]).toEqual([false, false, false, "no rows on Overview",
      false, false, true]);
    expect(targets("merge", { cur: "overview", focused: null })).toEqual([]);
  });
});

describe("a card's moves", () => {
  // Store pickup's three PRs wait on @otto-v's and @ines-v's requested changes; the two stacked on them wait on their parents, which is no move.
  it("leads with whoever waits on you: Address, naming them, over every Your turn row", () => {
    expect(moves(card(inkwellDeck(), PICKUP))).toEqual([["address", "@otto-v, @ines-v wait on you", "3 PRs · 1d", "Address", ["quill #210", "quill #211", "spine #155"]]]);
    // A row its Address batch thread is working stays on Your turn with its state, as All PRs keeps it, so the move doesn't jump as it sends.
    const working: Sent = { state: "working", threadId: "thr-batch", title: "Address feedback", detail: null, batchId: null };
    const sent = inkwellDeck({}, (row) => row.number === 211 ? { sent: working, addressing: { threadId: "thr-batch", title: "Address feedback" } } : {});
    expect(moves(card(sent, PICKUP))[0]![4]).toEqual(["quill #210", "spine #155", "quill #211"]);
    // One row names itself.
    const replied = inkwellDeck({}, (row) => row.number === 301 ? { yourTurn: null } : {});
    expect(moves(card(replied, ONE_OFFS))[0]).toEqual(["address", "@theo-k waits on you", "folio #318 · 2d", "Address", ["folio #318"]]);
  });

  it("then what's one step from merged: Merge, its stack in order, then Confirm for notes you answered", () => {
    expect(moves(card(inkwellDeck(), SHELF))[0]).toEqual(["merge", "4 ready to merge", "Ready to merge 1 · stacked 3", "Merge 4…",
      ["folio #340", "folio #341", "folio #342", "folio #343"]]);
    // You replied to folio #301's approval comment, so no person waits on you there; your Confirm still holds its merge.
    const replied = inkwellDeck({}, (row) => row.number === 301 ? { yourTurn: null } : {});
    expect(moves(card(replied, ONE_OFFS))[1]).toEqual(["confirm", "Approved; confirm its notes", "folio #301 · 2d", "Confirm…", ["folio #301"]]);
  });

  it("then your own blockers: Fix, saying which", () => {
    expect(moves(card(inkwellDeck(), SHELF))[1]).toEqual(["fix", "Clear conflicts", "folio #330 · 2d", "Fix 1…", ["folio #330"]]);
    expect(moves(card(inkwellDeck(), CATALOG))).toEqual([["fix", "Clear conflicts", "catalog #97 · 2d", "Fix 1…", ["catalog #97"]]]);
    // Blockers of more than one kind say each.
    const mixed = patched(inkwellDeck(), SHELF, (row) => row.number === 340 ? { section: "work", status: "CI failing" } : null);
    expect(moves(cardScreen(mixed, none, { now: NOW })).find(([kind]) => kind === "fix")).toEqual(["fix", "Unblock 2 of yours", "CI failing 1 · Conflicts 1 · oldest 2d",
      "Fix 2…", ["folio #340", "folio #330"]]);
  });

  // catalog #96 was asked of @mira-l and @theo-k two days ago: a nudge then is a chore. Four days on, a reviewer is holding it.
  it("then a reviewer holding a PR 4 days or more: Nudge, naming who; a shorter wait is a chore for Advance, which never takes a move", () => {
    const fresh = card(inkwellDeck(), ONE_OFFS);
    expect([fresh.moves.map((move) => move.kind), fresh.chores]).toEqual([["address"], { prUrls: [url("catalog", 96)], text: "nudge 1" }]);
    const held = cardScreen(patched(inkwellDeck(), ONE_OFFS, (row) => row.number === 96 ? { step: { ...row.step!, since: NOW - 5 * DAY } } : null), none, { now: NOW });
    expect([moves(held)[1], held.chores.prUrls]).toEqual([["nudge", "@mira-l holds 1", "catalog #96 · 5d · @theo-k 1", "Nudge 1…", ["catalog #96"]], []]);
    expect(card(inkwellDeck(), FOLIO)).toMatchObject({ moves: [], chores: { prUrls: [url("folio", 305), url("folio", 325)], text: "request 2" } });
  });

  // The rule is fixed, so the same card always reads in the same order; the card shows the first three, and keys still reach the rest.
  it("ranks every kind in one fixed order, each row in the first move that takes it", () => {
    const view = inkwellDeck({}, (row) => row.number === 301 ? { yourTurn: null } : {});
    const rows = [...rowsOf(view, PICKUP), ...rowsOf(view, SHELF), ...rowsOf(view, ONE_OFFS).map((row) => row.number === 96 ? { ...row, step: { ...row.step!, since: NOW - 5 * DAY } } : row)];
    const ranked = rankMoves(rows, "active", NOW);
    expect(ranked.moves.map((move) => [move.kind, move.prUrls.length])).toEqual([["address", 4], ["merge", 4], ["confirm", 1], ["fix", 1], ["nudge", 1]]);
    // Store pickup's code work waits on a person's feedback, so Address takes it, and Fix doesn't take it again.
    expect(ranked.moves.find((move) => move.kind === "fix")!.prUrls).toEqual([url("folio", 330)]);
  });

  it("has nothing to move while everything waits on others or on a write of yours, and Release once every open PR is held", () => {
    // Stacked PRs wait on their parents; a conflict whose fix is waiting out its Undo window is the write's until it lands.
    const waiting = rankMoves(rowsOf(inkwellDeck(), PICKUP).filter((row) => row.section === "blocked"), "active", NOW);
    expect(waiting).toEqual({ moves: [], chores: [] });
    const asked = inkwellDeck({}, (row) => row.number === 330 ? { acted: { kind: "fix", state: "queued", at: NOW, batchId: "b1" } } : {});
    expect(card(asked, SHELF).moves.map((move) => move.kind)).toEqual(["merge"]);
    // A held effort moves nothing until you resume it, whoever waits on you.
    expect([rankMoves(rowsOf(inkwellDeck(), SHELF), "held", NOW), rankMoves(rowsOf(inkwellDeck(), PICKUP), "held", NOW)]).toEqual([{ moves: [], chores: [] },
      { moves: [], chores: [] }]);
    const all = inkwellDeck({}, (row) => row.effort?.id === PICKUP ? { hold: { reason: "", heldAt: NOW - 3_600_000 } } : {});
    expect(moves(card(all, PICKUP))).toEqual([["release", "All 5 PRs held", "held 1h", "Release 5…", ["quill #210", "quill #211", "quill #212", "spine #155", "spine #156"]]]);
    // One held PR among moving ones is no move: it waits under Held.
    const one = inkwellDeck({}, (row) => row.number === 156 ? { hold: { reason: "", heldAt: NOW } } : {});
    expect([card(one, PICKUP).moves.map((move) => move.kind), card(one, PICKUP).held]).toEqual([["address"], 1]);
  });

  // The card and deck_batch_plan read one rule (counted): a write you made holds its row from when it's queued until you mark the card seen
  // after it lands. A card that freed the row sooner would read "Advance 1" or "Fix 1…" over a listing that skips it as just ran.
  it("offers a chore or move only on rows the plan takes, so a write that landed holds its row until Mark seen", () => {
    const at = NOW - 3_600_000;
    const chore = url("folio", 325), fix = url("folio", 330);
    const cases = [[null, undefined, true], ["queued", undefined, false], ["sending", undefined, false], ["sent", undefined, false], ["sent", at - 1, false],
      ["sent", at, true], ["refused", undefined, true], ["unknown", undefined, true]] as const;
    for (const [state, seenAt, offered] of cases) {
      const view = inkwellDeck({}, (row) => state && [325, 330].includes(row.number) ? { acted: { kind: row.number === 325 ? "ready" : "fix", state, at, batchId: "b1" } } : {});
      const seen = { rows: {}, at: seenAt === undefined ? {} : { [chore]: seenAt, [fix]: seenAt } };
      const folio = card(view, FOLIO, seen), shelf = card(view, SHELF, seen);
      const plans = (kind: "advance" | "fix", row: DeckRow, extra: Partial<PlanRow> = {}) => planBatch(kind, [{ row, pile: "active", seenAt, head: "a".repeat(40),
        fingerprint: null, shown: { requested: [], reviewed: [] }, ...extra }], { selected: true }).items.length > 0;
      expect([folio.chores.prUrls.includes(chore), plans("advance", line(folio, chore).row!), shelf.moves.some((move) => move.kind === "fix"),
        plans("fix", line(shelf, fix).row!, { fix: { to: "Ask its thread", route: { kind: "thread", id: "thr" }, fixes: ["conflicts"] } })])
        .toEqual([offered, offered, offered, offered]);
      // A write that landed and holds its row is what Mark seen offers to settle; one still waiting isn't done yet.
      expect([folio.settleable, shelf.settleable]).toEqual([state === "sent" && !offered, state === "sent" && !offered]);
    }
  });

  // Reconcile writes nothing to Linear or GitHub: Show unfolds the open PRs of tickets Linear calls done, to merge or close them, and Linear
  // opens a ticket still open after its PRs merged, to move it there.
  it("then Linear and GitHub disagreeing: Reconcile, one line per mismatch with its tickets and one button, after Nudge", () => {
    const reconcile = { done: ["ABC-361", "ABC-364"], prUrls: [url("folio", 341), url("folio", 330)],
      merged: [{ id: "ABC-365", url: "https://linear.app/inkwell/issue/ABC-365" }, { id: "ABC-366", url: null }] };
    const shelf = cardScreen({ ...cardOf(inkwellDeck(), SHELF), linear: { ...cardOf(inkwellDeck(), SHELF).linear, reconcile } }, none, { now: NOW });
    expect(moves(shelf)).toEqual([["merge", "4 ready to merge", "Ready to merge 1 · stacked 3", "Merge 4…", ["folio #340", "folio #341", "folio #342", "folio #343"]],
      ["fix", "Clear conflicts", "folio #330 · 2d", "Fix 1…", ["folio #330"]],
      ["reconcile", "Linear and GitHub disagree", "2 Done in Linear · 2 PRs open · 2 open with every PR merged", "Show 2", ["folio #341", "folio #330"]]]);
    expect(shelf.moves[2]!.lines).toEqual([{ kind: "done", text: "2 Done in Linear · 2 PRs open", tickets: ["ABC-361", "ABC-364"], button: "Show 2", url: null },
      { kind: "merged", text: "2 open with every PR merged", tickets: ["ABC-365", "ABC-366"], button: "Open in Linear ↗", url: "https://linear.app/inkwell/issue/ABC-365" }]);
    // Either mismatch alone is its one line; with none, there's no move, and the hint bar never offers a key it doesn't have.
    const merged = rankMoves([], "active", NOW, { done: [], prUrls: [], merged: [{ id: "ABC-365", url: null }] });
    expect(merged.moves.map((move) => [move.kind, move.meta, move.prUrls])).toEqual([["reconcile", "1 open with every PR merged", []]]);
    expect(rankMoves(rowsOf(inkwellDeck(), SHELF), "active", NOW, { done: [], prUrls: [], merged: [] }).moves.map((move) => move.kind)).toEqual(["merge", "fix"]);
    expect(hintKeys(context(shelf), availability(context(shelf))).map(([, what]) => what)).toEqual(["rows", "All PRs", "progress", "flip"]);
    // A held effort reconciles nothing until you resume it, as it moves nothing else. Every PR held is still a mismatch to see: Release
    // leads only with nothing else to move, and waits under Held.
    expect(rankMoves(rowsOf(inkwellDeck(), SHELF), "held", NOW, reconcile).moves).toEqual([]);
    const held = inkwellDeck({}, (row) => row.effort?.id === SHELF ? { hold: { reason: "", heldAt: NOW } } : {});
    expect(rankMoves(rowsOf(held, SHELF), "active", NOW, reconcile).moves.map((move) => move.kind)).toEqual(["reconcile"]);
  });
});

describe("the finish line", () => {
  const ticket = (n: number, state: string, type: string, project: object = { id: "p1", name: "Shelf redesign", targetDate: "2026-10-14" }): [string, LinearDetail] =>
    [`ABC-${n}`, { identifier: `ABC-${n}`, title: null, description: null, state: { name: state, type }, project: project as LinearDetail["project"], parent: null,
      labels: [], url: null, updatedAt: null, cycle: { number: 41, name: null, endsAt: "2026-10-07T00:00:00.000Z" }, assignee: null, source: "key" }];
  const shelf = (tickets: [string, LinearDetail][], merged: number[]) => card(inkwellDeck({ linear: new Map(tickets),
    merges: merged.map((daysAgo, index) => ({ url: url("folio", 290 + index), at: NOW - daysAgo * DAY, effortId: SHELF })) }), SHELF);
  const five = (project?: object) => [ticket(360, "In Review", "started", project), ticket(361, "Done", "completed", project), ticket(362, "In Review", "started", project),
    ticket(363, "Todo", "unstarted", project), ticket(364, "Done", "completed", project)];

  // Shelf order merged 4 PRs in two weeks, 2 a week, so its 5 open PRs land in about 2.5 weeks: 4 days after the project's target.
  it("says how much is done, the project's target, and when the open PRs land at the last two weeks' pace, amber when that's past the target", () => {
    expect(shelf(five(), [1, 4, 7, 10]).finish).toEqual({ done: "2 of 5 done", date: { text: "Target Oct 14 · 14d left", tone: "gray" },
      eta: { text: "ETA Oct 18 at 2/wk", tone: "amber" },
      answers: [["On track?", "Behind: ETA Oct 18, 4d after the target"], ["What's left", "3 open tickets: 2 In Review · 1 Todo · 5 open PRs"], ["Who holds it", "You 5"],
        ["Moving?", "3 merged in 7d · 4 in 14d"], ["To Done", "5 open PRs · 3 open tickets"]] });
    // At 5 a week, the same PRs land before the target, with days to spare.
    expect(shelf(five(), [1, 1, 2, 3, 4, 5, 6, 8, 9, 13]).finish?.answers[0]).toEqual(["On track?", "On pace: ETA Oct 7, 7d to spare"]);
  });

  // A canceled ticket will never be done, so it counts on neither side: an effort whose tickets are all done or canceled reads all done.
  it("counts done of the tickets Linear didn't cancel, and merged PRs once every ticket is canceled", () => {
    const canceled = (n: number) => ticket(n, "Canceled", "canceled");
    expect([shelf([...five().slice(0, 4), canceled(364)], []), shelf([ticket(360, "Done", "completed"), ticket(361, "Done", "completed"), canceled(362)], []),
      shelf([canceled(360)], [])].map((screen) => screen.finish?.done)).toEqual(["1 of 4 done", "2 of 2 done", "0 of 5 merged"]);
  });

  it("says how late a passed target is, in red, and gives no ETA with nothing merged in 14 days", () => {
    const late = shelf(five({ id: "p1", name: "Shelf redesign", targetDate: "2026-02-27" }), [20]).finish!;
    expect([late.date, late.eta, late.answers[0]]).toEqual([{ text: "Target Feb 27 · 215d late", tone: "red" }, null,
      ["On track?", "Target Feb 27 passed 215d ago · nothing merged in 14d"]]);
  });

  it("falls back to the current cycle's end without a project target, and to no date without either", () => {
    const cycle = shelf(five({ id: "p1", name: "Shelf redesign", targetDate: null }), [3]).finish!;
    expect([cycle.date, cycle.eta?.text]).toEqual([{ text: "Cycle 41 · 7d left", tone: "gray" }, "ETA Dec 9 at 0.5/wk"]);
    // A cycle that ended is no date to answer to.
    const ended = five({ id: "p1", name: "Shelf redesign", targetDate: null }).map(([key, detail]): [string, LinearDetail] =>
      [key, { ...detail, cycle: { number: 40, name: null, endsAt: "2026-09-20T00:00:00.000Z" } }]);
    expect(shelf(ended, [3]).finish?.date).toBeNull();
    // With no Linear data, it counts merged PRs instead, and says what it can't.
    expect(card(inkwellDeck(), PICKUP).finish).toEqual({ done: "0 of 5 merged", date: null, eta: null,
      answers: [["On track?", "No date, and nothing merged in 14d"], ["What's left", "5 open PRs · no Linear data"], ["Who holds it", "You 3"],
        ["Moving?", "0 merged in 7d · 0 in 14d"], ["To Done", "5 open PRs"]] });
  });

  it("names who holds the open PRs: you, then each reviewer a next step waits on, but nobody for a held PR or one a thread is working", () => {
    const shelf = cardScreen(patched(inkwellDeck(), SHELF, (row) => row.number === 330 ? { section: "nudge", nudge: ["mira-l"], step: { text: "Nudge @mira-l", owner: "reviewers", since: NOW - DAY } }
      : row.number === 343 ? { section: "held", hold: { reason: "", since: NOW } } : row.number === 342 ? { section: "flight" } : null), none, { now: NOW });
    expect(shelf.finish?.answers[2]).toEqual(["Who holds it", "You 2 · @mira-l 1"]);
  });

  // One-offs merge on their own, and a service card is no effort yet: neither has an outcome to finish.
  it("draws no finish line on One-offs or a service card", () => {
    expect([card(inkwellDeck(), ONE_OFFS).finish, card(inkwellDeck(), FOLIO).finish, availability(context(card(inkwellDeck(), FOLIO))).progress.on]).toEqual([null, null, false]);
    expect(availability(context(card(inkwellDeck(), SHELF))).progress.on).toBe(true);
  });
});

describe("Linear priority and points", () => {
  // Linear's own priority icon climbs with urgency; Urgent is the one that alarms. No priority draws nothing rather than a dash on every row.
  it("draws each Linear priority as a glyph and Linear's word for it, and no priority as nothing", () => {
    expect([1, 2, 3, 4].map((priority) => priorityOf({ priority, label: null }))).toEqual([{ glyph: "!", label: "Urgent", tone: "red" },
      { glyph: "▂\u200a▄\u200a▆", label: "High", tone: "gray" }, { glyph: "▂\u200a▄", label: "Medium", tone: "gray" }, { glyph: "▂", label: "Low", tone: "gray" }]);
    expect([priorityOf({ priority: 0, label: "No priority" }), priorityOf({ priority: null, label: null }), priorityOf(undefined)]).toEqual([null, null, null]);
    // Linear's word wins, so a workspace that says Normal reads Normal.
    expect(priorityOf({ priority: 3, label: "Normal" })?.label).toBe("Normal");
  });

  const ticket = (n: number, type: string, priority: number | null, estimate: number | null): [string, LinearDetail] => [`ABC-${n}`, { identifier: `ABC-${n}`,
    title: null, description: null, state: { name: type, type }, project: null, parent: null, labels: [], url: null, updatedAt: null, source: "key", priority,
    priorityLabel: null, estimate }];
  const shelf = () => card(inkwellDeck({ linear: new Map([ticket(360, "started", 2, 3), ticket(361, "completed", 2, 2), ticket(362, "started", 1, 1),
    ticket(363, "unstarted", 3, null), ticket(364, "completed", 0, 2)]) }), SHELF);

  it("puts each row's ticket on a chip with its priority's glyph, and a ticket Linear hasn't read on a plain one", () => {
    const chips = shelf().tickets;
    expect([chips.get(url("folio", 340)), chips.get(url("folio", 342)), chips.get(url("folio", 330))]).toEqual([
      { text: "ABC-360", glyph: "▂\u200a▄\u200a▆", title: "ABC-360 · High priority", tone: "gray" }, { text: "ABC-362", glyph: "!", title: "ABC-362 · Urgent priority", tone: "red" },
      { text: "ABC-364", glyph: null, title: "ABC-364", tone: "gray" }]);
    const plain = card(inkwellDeck(), PICKUP).tickets;
    expect(plain.get(url("quill", 210))).toEqual({ text: "ABC-370", glyph: null, title: "ABC-370", tone: "gray" });
    // A row naming two tickets shows the first and how many more.
    const two = cardScreen(patched(inkwellDeck(), SHELF, (row) => row.number === 340 ? { tickets: ["ABC-360", "ABC-361"] } : null), none, { now: NOW });
    expect(two.tickets.get(url("folio", 340))).toEqual({ text: "ABC-360 +1", glyph: null, title: "ABC-360 · ABC-361", tone: "gray" });
  });

  it("says in the p expand what's left by priority, most urgent first, and the points left of all the points estimated", () => {
    expect(shelf().finish?.answers[2]).toEqual(["Left", "1 Urgent · 1 High · 1 Medium · 4 of 8 pts left"]);
    // With no priority or points from Linear, there's no line for them.
    expect(card(inkwellDeck(), SHELF).finish?.answers.map(([label]) => label)).toEqual(["On track?", "What's left", "Who holds it", "Moving?", "To Done"]);
  });
});

describe("an effort card", () => {
  // Moves follow the read, as All PRs does: nothing waits for Mark seen to move. Mark seen only settles what changed since you looked.
  it("follows the read in its moves, and counts what changed since you marked it seen until you do", () => {
    const before = inkwellDeck();
    const seen = { rows: { [SHELF]: cardSnapshot(cardOf(before, SHELF)) } };
    // folio #342 lost its approval on this read, so #343, stacked on it, no longer merges in order either.
    const after = inkwellDeck({}, (row) => row.number === 342 ? { attention: [], status: "Awaiting review", stage: "review" } : {});
    const shelf = card(after, SHELF, seen);
    expect([moves(shelf)[0]![4], shelf.changed]).toEqual([["folio #340", "folio #341"], 2]);
    expect([line(shelf, url("folio", 342)).section, line(shelf, url("folio", 342)).needs]).toEqual(["flight", false]);
    // Mark seen takes the card as it is now.
    expect(card(after, SHELF, { rows: { [SHELF]: cardSnapshot(cardOf(after, SHELF)) } }).changed).toBe(0);
    // A PR that left since you looked counts too, though no key takes it.
    const left = card(inkwellDeck({}, (row) => row.number === 341 ? { effort: null } : {}), SHELF, seen);
    expect([left.changed, line(left, url("folio", 341))]).toMatchObject([1, { ghost: true, needs: false }]);
  });

  it("says what a row's Refresh found, in the hint bar", () => {
    const before = rowFacts(inkwellDeck());
    // folio #330's conflict cleared, so it's in flight, and folio #343 merged.
    const after = rowFacts(inkwellDeck({}, (row) => row.number === 330 ? { attention: [], status: "Ready to merge", stage: "ready", mergeable: true } as never
      : row.number === 343 ? { effort: null, status: "Merged" } as never : {}));
    const pr330 = url("folio", 330);
    expect(refreshNote("folio #330", before.get(pr330)!, after.get(pr330)!, null)).toBe("folio #330: Conflicts → Ready to merge · now in In flight");
    expect(refreshNote("folio #340", before.get(url("folio", 340))!, before.get(url("folio", 340))!, null)).toBe("Read folio #340 just now · no change");
    expect(refreshNote("folio #343", before.get(url("folio", 343))!, null, { how: "merged" })).toBe("folio #343: merged");
    expect(refreshNote("folio #343", before.get(url("folio", 343))!, null, null)).toBe("folio #343: left this card");
    // GitHub's rate limit shows in the top bar while it holds reads, and not after.
    const view = inkwellDeck();
    expect(readText({ ...view, limitedUntil: NOW + 10 * 60_000 }, NOW)).toMatch(/^Rate-limited until .+ · Read 25s ago$/u);
    expect(readText({ ...view, limitedUntil: NOW - 1 }, NOW)).toBe("Read 25s ago");
  });

  it("words its panels and Overview from the card: threads, waits on others, open PRs by move, and stored Linear details", () => {
    const shelf = card(inkwellDeck(), SHELF);
    expect(shelf.stats).toMatchObject({ open: 5, mergedWeek: 1, bar: [{ key: "ready", count: 4 }, { key: "fix", count: 1 }] });
    expect(shelf.linear).toEqual({ summary: "Shelf redesign", chips: [{ kind: "project", text: "Shelf redesign" }, { kind: "label", text: "shelves" }],
      bar: [{ name: "In Review", count: 1, tone: "blue" }], target: null, lines: [["States", "1 in review"], ["Read", "1 of 5 tickets"]] });
    expect(shelf.next).toBe("Merge");
    const pickup = card(inkwellDeck(), PICKUP);
    expect(pickup.threads[0]).toMatchObject({ title: "Store pickup", ref: "parent", age: "2h", dot: false });
    expect(pickup.blocked.map((item) => [item.ref, item.on, item.age])).toEqual([["quill #212", "quill #210", "3d"], ["spine #156", "spine #155", "3d"]]);
    expect(pickup.linear).toEqual({ summary: "no Linear data", chips: [], bar: [], target: null, lines: [] });
  });

  it("words the Linear panel from what Linear gave: project and initiative chips, label tags, states, cycle, assignees, and target date", () => {
    const detail = (identifier: string, patch: object) => ({ identifier, title: null, description: null, state: { name: "In Progress", type: "started" },
      project: { id: "p1", name: "Shelf redesign", targetDate: "2026-10-17", initiatives: [{ id: "i1", name: "Reading rooms" }] }, parent: null, labels: ["shelves"],
      cycle: { number: 42, name: null, endsAt: "2026-10-03T00:00:00.000Z" }, url: null, updatedAt: null, source: "key" as const, ...patch });
    const view = inkwellDeck({ linear: new Map([["ABC-360", detail("ABC-360", { assignee: "dana" })], ["ABC-361", detail("ABC-361", { assignee: "kai",
      state: { name: "Done", type: "completed" } })]]) });
    expect(card(view, SHELF).linear).toEqual({ summary: "Shelf redesign · target Oct 17",
      chips: [{ kind: "project", text: "Shelf redesign" }, { kind: "initiative", text: "Reading rooms" }, { kind: "label", text: "shelves" }],
      bar: [{ name: "Done", count: 1, tone: "green" }, { name: "In Progress", count: 1, tone: "blue" }], target: "target Oct 17",
      lines: [["States", "1 done · 1 in progress"], ["Cycle", "Cycle 42 → Oct 3"], ["Assignees", "dana, kai"], ["Target", "Oct 17 Shelf redesign"], ["Read", "2 of 5 tickets"]] });
    // The target named beside the top project is that project's: a smaller project's date would read as the top one's.
    const two = inkwellDeck({ linear: new Map([["ABC-360", detail("ABC-360", { project: { id: "p1", name: "Shelf redesign", targetDate: null, initiatives: [] } })],
      ["ABC-361", detail("ABC-361", { project: { id: "p1", name: "Shelf redesign", targetDate: null, initiatives: [] } })],
      ["ABC-362", detail("ABC-362", { project: { id: "p2", name: "Store hours", targetDate: "2026-12-01", initiatives: [] } })]]) });
    expect(card(two, SHELF).linear).toMatchObject({ summary: "Shelf redesign", target: null, lines: expect.arrayContaining([["Target", "Dec 1 Store hours"]]) });
  });
});

describe("held PRs on a card", () => {
  const held = () => inkwellDeck({}, (row) => row.number === 211 ? { hold: { reason: "Waiting on the slip printer", heldAt: NOW - 2 * DAY } }
    : row.number === 156 ? { hold: { reason: "", heldAt: NOW - 3_600_000 } } : {});

  it("lists each held PR under its Held toggle, which ⇧H opens, and in no move or wait", () => {
    const pickup = card(held(), PICKUP);
    expect([pickup.held, pickup.lines.filter((item) => item.section === "held").map((item) => item.ref)]).toEqual([2, ["quill #211", "spine #156"]]);
    expect(pickup.moves.flatMap((move) => move.prUrls)).not.toContain(url("quill", 211));
    expect(pickup.blocked.map((item) => item.ref)).toEqual(["quill #212"]);
    expect(availability(context(pickup)).held.on).toBe(true);
    const shelf = card(held(), SHELF);
    expect([shelf.held, availability(context(shelf)).held]).toEqual([0, { on: false, why: "nothing here is on hold" }]);
  });

  it("releases with l, through the listing confirm, the focused held row, else every one still held", () => {
    const pickup = card(held(), PICKUP);
    const [slips, expired] = pickup.lines.filter((item) => item.section === "held");
    expect(targets("release", { cur: pickup, focused: expired! }).map((item) => item.ref)).toEqual(["spine #156"]);
    // A focused row that isn't held doesn't narrow it.
    expect(targets("release", { cur: pickup, focused: line(pickup, url("quill", 210)) }).map((item) => item.ref)).toEqual(["quill #211", "spine #156"]);
    expect(slips!.needs).toBe(false);
    // A release waiting out its window takes its row out of the next one.
    const queued = card(inkwellDeck({}, (row) => row.number === 211 ? { hold: { reason: "Printer", heldAt: NOW }, acted: { kind: "release", state: "queued", at: NOW, batchId: "b9" } }
      : {}), PICKUP);
    expect([line(queued, url("quill", 211)).dim, targets("release", { cur: queued, focused: null })]).toEqual([true, []]);
    // A held effort's card writes nothing to GitHub, and a release writes nothing there either, so it still offers Release, and nothing else.
    const paused = cardScreen({ ...cardOf(held(), PICKUP), pile: "held" }, none, { now: NOW });
    const on = availability(context(paused));
    expect([on.release.on, on.advance.on, on.nudge.on, on.fix.on, paused.moves]).toEqual([false, false, false, false, []]);
  });
});

describe("a service card", () => {
  it("names where each row's suggestion points", () => {
    const folio = card(inkwellDeck(), FOLIO);
    expect(folio.lines.map((item) => [item.ref, item.signals])).toEqual([["folio #305", []], ["folio #325", ["→ Shelf order"]]]);
    expect(card(inkwellDeck(), ATLAS).lines[0]!.signals).toEqual(["→ new Delivery windows"]);
    expect(card(inkwellDeck(), SHELF).suggest).toEqual([]);
  });

  it("shows each suggestion over its rows once, with its strength, signals, and one button, and each PR's own signals", () => {
    const folio = card(inkwellDeck(), FOLIO);
    expect(folio.suggest.map((group) => [group.key, group.title, group.strength, group.signals, group.button.label, group.lines.map((item) => [item.ref, item.signals])]))
      .toEqual([[`${FOLIO} effort:${SHELF}:high`, "Shelf order", "strong", ["ticket ABC-355", "prefix ABC"], "Put 1 in Shelf order", [["folio #325", ["ticket ABC-355", "prefix ABC"]]]],
        [`${FOLIO} none`, "No clear signal", null, [], "Pick per PR", [["folio #305", []]]]]);
    expect(folio.suggest.at(-1)!.reason).toBe("Pick an effort for each PR.");
    // A suggestion that spans two repositories shows on each of their cards, over the PRs on that card.
    expect([ATLAS, CATALOG].map((id) => card(inkwellDeck(), id).suggest.map((group) => [group.key, group.button.label, group.lines.map((item) => item.ref)])))
      .toEqual([[[`${ATLAS} new:ABC-210`, "New effort from 1…", ["atlas #410"]]], [[`${CATALOG} new:ABC-210`, "New effort from 1…", ["catalog #97"]]]]);
  });

  // A weak suggestion rests on one faint signal, so the one button that would move its PRs at once asks first. A new effort's naming dialog
  // already asks, and strong or moderate groups move on one click, with Undo.
  it("asks again before a weak group moves anything", () => {
    const [shelf, delivery, rest] = inkwellSuggestions();
    const view = inkwellDeck({ classify: { oneOffsId: ONE_OFFS, groups: [
      { ...shelf!, key: `effort:${SHELF}:low`, confidence: "low", reason: "Same code area", signals: ["area inkwell/folio:shelves"] },
      { ...delivery!, confidence: "low" },
      { ...rest!, key: "one-off", target: { kind: "one-off" }, confidence: "medium", reason: "Standalone ticket that nothing else carries", signals: ["standalone ticket ABC-305"] }] } });
    expect(card(view, FOLIO).suggest.map((group) => [group.title, group.strength, group.button.label, group.button.confirm])).toEqual([
      ["Shelf order", "weak", "Put 1 in Shelf order…", true], ["One-offs", "moderate", "Mark 1 one-off", false]]);
    expect(card(view, ATLAS).suggest.map((group) => [group.title, group.strength, group.button.label, group.button.confirm]))
      .toEqual([["Delivery windows", "weak", "New effort from 1…", false]]);
    expect(card(inkwellDeck(), FOLIO).suggest.map((group) => group.button.confirm)).toEqual([false, false]);
  });

  it("collapses a group you accepted to one line with Undo where it was, which Mark seen settles", () => {
    const before = inkwellDeck();
    const seen = { rows: { [FOLIO]: cardSnapshot(cardOf(before, FOLIO)) } };
    const [shelf, ...rest] = inkwellSuggestions();
    const after = inkwellDeck({ classify: { oneOffsId: ONE_OFFS, groups: rest } }, (row) => row.number === 325 ? { effort: INVENTORY_EFFORTS.shelf } : {});
    const key = `${FOLIO} ${shelf!.key}`;
    const folio = card(after, FOLIO, seen, new Map([[key, { actionId: "a1", text: "1 PR → Shelf order", prUrls: [url("folio", 325)], index: 0 }]]));
    expect(folio.suggest.map((group) => [group.title, group.accepted?.text ?? null, group.lines.length])).toEqual([["Moved", "1 PR → Shelf order", 0],
      ["No clear signal", null, 1]]);
    expect([folio.settleable, folio.chores.prUrls]).toEqual([true, [url("folio", 305)]]);
  });

  // A17(6) and PLACE-LOSS #2: atlas #410 is the only PR on its service card, so moving it, or its merging on a poll, would take the card
  // and every result on it away under you. The card stays, empty, until you mark it seen.
  it("keeps a service card whose last PR left as a stand-in with its accepted groups until Mark seen", () => {
    const before = inkwellDeck();
    const snapshot = cardSnapshot(cardOf(before, ATLAS));
    expect(snapshot.map((row) => row.ref)).toEqual(["atlas #410"]);
    const after = inkwellDeck({}, (row) => row.repo === "inkwell/atlas" && row.number === 410 ? { effort: INVENTORY_EFFORTS.pickup } : {});
    expect(after.active.map((item) => item.id)).not.toContain(ATLAS);
    const order = before.active.map((item) => item.id);
    const accepted: Accepted = new Map([[`${ATLAS} effort:${PICKUP}:high`, { actionId: "a1", text: "1 PR → Store pickup", prUrls: [url("atlas", 410)], index: 0 }]]);
    const [kept] = keptServiceCards(order, after.active, { [ATLAS]: snapshot }, accepted);
    expect([kept!.id, kept!.kind, kept!.name, kept!.needsYou, kept!.stats.open]).toEqual([ATLAS, "service", "atlas · service", 0, 0]);
    const atlas = cardScreen(kept!, { rows: { [ATLAS]: snapshot } }, { now: NOW, accepted });
    expect([atlas.suggest.map((group) => group.accepted?.text), atlas.settleable, atlas.moves, atlas.lines.map((item) => [item.ref, item.ghost])])
      .toEqual([["1 PR → Store pickup"], true, [], [["atlas #410", true]]]);
    // Mark seen leaves nothing to settle, so it goes; so does a card this session never showed, and one a read still draws.
    expect(keptServiceCards(order, after.active, { [ATLAS]: [] }, new Map())).toEqual([]);
    expect(keptServiceCards(order.filter((id) => id !== ATLAS), after.active, { [ATLAS]: snapshot }, accepted)).toEqual([]);
    expect(keptServiceCards(order, before.active, { [ATLAS]: snapshot }, accepted)).toEqual([]);
  });

  it("keeps a group open while any of it is left here, so accepting part of it hides none of the rest", () => {
    const [shelf, , rest] = inkwellSuggestions();
    const both = { ...shelf!, prs: [...shelf!.prs, rest!.prs[0]!] };
    const view = inkwellDeck({ classify: { oneOffsId: ONE_OFFS, groups: [both] } });
    // You accepted Shelf order for folio #325 alone; folio #305 is still here.
    const folio = card(view, FOLIO, none, new Map([[`${FOLIO} ${shelf!.key}`, { actionId: "a1", text: "1 PR → Shelf order", prUrls: [url("folio", 325)], index: 0 }]]));
    expect(folio.suggest.map((group) => [group.accepted, group.button.label, group.lines.map((item) => item.ref)])).toEqual([[null, "Put 2 in Shelf order",
      ["folio #305", "folio #325"]]]);
  });
});

describe("what the keys act on", () => {
  // A key does what its move's button does: the rows the move lists, so n never sweeps up the chores a reviewer isn't holding yet.
  it("takes the focused row when it has the move, else the card's move of that kind, else every row with it, and one PR's notes at a time", () => {
    // catalog #96 has waited 5 days, a move; folio #318 is a nudge from yesterday, a chore.
    const nudges = cardScreen(patched(inkwellDeck(), ONE_OFFS, (row) => row.number === 96 ? { step: { ...row.step!, since: NOW - 5 * DAY } }
      : row.number === 318 ? { section: "nudge", turn: { list: "other", addressable: "No feedback waits on you." }, yourTurn: null, nudge: ["otto-v"],
        step: { text: "Nudge @otto-v", owner: "reviewers", since: NOW - DAY } } : null), none, { now: NOW });
    expect([nudges.moves.map((move) => move.kind), nudges.chores.prUrls]).toEqual([["address", "nudge"], [url("folio", 318)]]);
    expect(targets("nudge", { cur: nudges, focused: null }).map((item) => item.ref)).toEqual(["catalog #96"]);
    expect(targets("nudge", { cur: nudges, focused: line(nudges, url("folio", 318)) }).map((item) => item.ref)).toEqual(["folio #318"]);
    // A focused row without the move doesn't narrow it; with no Nudge move, n takes every nudge, chores included.
    expect(targets("nudge", { cur: nudges, focused: line(nudges, url("folio", 301)) }).map((item) => item.ref)).toEqual(["catalog #96"]);
    const oneOffs = card(inkwellDeck(), ONE_OFFS);
    expect(targets("nudge", { cur: oneOffs, focused: null }).map((item) => item.ref)).toEqual(["catalog #96"]);
    // Review notes are read one PR at a time: c takes the focused row's notes, else the card's first.
    expect(targets("confirm", { cur: oneOffs, focused: null }).map((item) => item.ref)).toEqual(["folio #301"]);
    expect(targets("confirm", { cur: oneOffs, focused: line(oneOffs, url("folio", 318)) }).map((item) => item.ref)).toEqual(["folio #318"]);
    // spine #155's reviewer has said nothing new, so it's yours to fix, not Address's: f takes it alone, leaving Address's code work to Address.
    const fix = card(inkwellDeck({}, (row) => row.number === 155 ? { yourTurn: null } : {}), PICKUP);
    expect(targets("fix", { cur: fix, focused: null }).map((item) => item.ref)).toEqual(["spine #155"]);
    expect(targets("fix", { cur: card(inkwellDeck(), PICKUP), focused: null }).map((item) => item.ref)).toEqual(["quill #210", "quill #211", "spine #155"]);
  });

  it("keeps PR actions off cards and available only from eligible PR rows", () => {
    for (const id of [SHELF, PICKUP, ONE_OFFS, FOLIO]) {
      const c = card(inkwellDeck(), id); const on = availability(context(c, { focused: c.lines[0]!, selected: c.lines }));
      for (const action of PR_VIEW_ACTIONS) expect(on[action]).toEqual({ on: false, why: "Open the PR in All PRs to act" });
    }
    const prs = availability({ ...context("overview"), view: "prs", cur: null, prs: { row: true, thread: true, moves: new Set(["merge", "ready", "nudge", "refresh"]) } });
    expect([prs.merge.on, prs.ready.on, prs.nudge.on, prs.refresh.on, prs.fix.on, prs.next.on]).toEqual([true, true, true, true, false, false]);
  });

  // Advance clears chores, and only those: a merge, review notes, and a thread's work each keep their own move and key.
  it("retains exact Advance scopes as data while disabling dispatch from the read card", () => {
    const oneOffs = card(inkwellDeck(), ONE_OFFS);
    expect(oneOffs.chores.prUrls).toEqual([url("catalog", 96)]);
    expect(availability(context(oneOffs)).advance.on).toBe(false);
    expect(hintKeys(context(oneOffs), availability(context(oneOffs)))).not.toContainEqual(["a", "advance"]);
    const queued = card(inkwellDeck({}, (r) => r.number === 96 ? { acted: { kind: "nudge", state: "queued", at: NOW, batchId: "b1" } } : {}), ONE_OFFS);
    expect(queued.chores.prUrls).toEqual([]);
  });

  // Address takes the rows ticked under its move and nothing by focus alone: the key, the hint bar, and ⌘K offer it only with Your turn
  // rows ticked, on a live card, or in All PRs' selection.
  it("offers Address, and b, only while Your turn rows are ticked", () => {
    const pickup = card(inkwellDeck(), PICKUP);
    // All PRs: x selects the focused Your turn row, ⇧X all of Your turn, and b addresses the selection.
    const prs = (patch: NonNullable<KeyContext["prs"]>) => ({ ...context(pickup), view: "prs" as const, cur: null, prs: patch });
    const nothing = prs({ row: true, thread: false, moves: new Set(), selectable: true, turn: 5, picked: 0 });
    expect([availability(nothing).select.on, availability(nothing)["select-section"].on, availability(nothing).address]).toEqual([true, true,
      { on: false, why: "select Your turn rows first" }]);
    expect(hintKeys(nothing, availability(nothing))).toContainEqual(["x", "select"]);
    const two = prs({ row: true, thread: false, moves: new Set(), selectable: false, turn: 5, picked: 2 });
    expect([availability(two).select.on, availability(two).address.on, availability(two).clear.on]).toEqual([false, true, true]);
    expect(hintKeys(two, availability(two))).toEqual([["b", "address selected"], ["e", "move"], ["g", "refresh"], ["esc", "clear"]]);
    // Any row selects, to move; with one off Your turn in the selection, b says why it can't take them, and e still moves them.
    const mixed = prs({ row: true, thread: false, moves: new Set(), selectable: true, turn: 5, picked: 3, addressable: false });
    expect([availability(mixed).address, availability(mixed).move.on]).toEqual([{ on: false, why: "Your turn rows only" }, true]);
    expect(hintKeys(mixed, availability(mixed))).toEqual([["x", "toggle"], ["e", "move"], ["g", "refresh"], ["esc", "clear"]]);
    expect(availability(prs({ row: false, thread: false, moves: new Set(), turn: 0, picked: 0 }))["select-section"]).toEqual({ on: false, why: "nothing is on Your turn" });
    // The deck's own e and ⇧A route in All PRs too: e moves the selection, else the focused row, and ⇧A takes the focused row's suggestion.
    const suggested = prs({ row: true, thread: false, moves: new Set(), selectable: true, turn: 5, picked: 0, suggested: true });
    expect([availability(suggested).move.on, availability(suggested).accept.on]).toEqual([true, true]);
    expect(hintKeys(suggested, availability(suggested)).slice(0, 2)).toEqual([["j ↓", "rows"], ["⇧A", "accept"]]);
    expect(paletteItems(availability(suggested), [], { held: [], done: [] }, null, false).filter((item) => item.key === "move" || item.key === "accept")
      .map((item) => [item.title, item.keys, item.on])).toEqual([["Accept the suggestion", ["⇧A"], true], ["Move to an effort…", ["e"], true]]);
    const plain = prs({ row: true, thread: false, moves: new Set(), selectable: false, turn: 5, picked: 0 });
    expect([availability(plain).move, availability(plain).accept]).toEqual([{ on: false, why: "select a row first" }, { on: false, why: "the row has no suggestion" }]);
  });

  it("offers an effort's notes to edit, with ⇧N, and none on a service card", () => {
    const shelf = card(inkwellDeck(), SHELF);
    expect([shelf.notes, availability(context(shelf)).notes.on]).toEqual([{ body: "", first: "", revision: 0 }, true]);
    expect(availability(context(card(inkwellDeck(), FOLIO))).notes).toEqual({ on: false, why: "only an effort keeps notes" });
  });

  // A PR filed in an effort by mistake is a one-off: you move it out from the effort's own card, one focused row at a time.
  it("requires opening All PRs to move a PR out of an effort", () => {
    const shelf = card(inkwellDeck(), SHELF);
    expect(availability(context(shelf, { focused: shelf.lines[0]! }))["one-off"].on).toBe(false);
  });

  // Your confirmation of a PR's notes clears its merge gate on your word; taking it back is ⌘K's, from the focused row, and only where you gave one.
  it("offers Revoke in the PR view when its row supplies that action", () => {
    const c = context(card(inkwellDeck(), SHELF));
    expect(availability(c).revoke.on).toBe(false);
    expect(availability({ ...c, view: "prs", cur: null, prs: { row: true, thread: false, moves: new Set(["revoke"]) } }).revoke.on).toBe(true);
  });

  it("keeps read-card hints to navigation, progress, and worker links", () => {
    const shelf = card(inkwellDeck(), SHELF);
    expect(hintKeys(context(shelf), availability(context(shelf)))).toEqual([["j ↓", "rows"], ["v", "All PRs"], ["p", "progress"], ["] →", "flip"]]);
  });

  it("lists every action in the palette with its key, and each effort to go to, resume, or reopen", () => {
    const view = inkwellDeck();
    const cards = new Map(view.active.map((item) => [item.id, card(view, item.id)]));
    const chips = stripChips(view.active.map((item) => item.id), cards, SHELF);
    const items = paletteItems(availability(context(cards.get(SHELF)!)), chips, { held: [{ id: "effort-gift-cards", name: "Gift cards" }],
      done: [{ id: "effort-store-hours", name: "Store hours", archived: false }, { id: "effort-old", name: "Old", archived: true }] }, SHELF, true);
    expect(items.filter((item) => item.action).map((item) => item.key)).toEqual(DECK_ACTIONS.filter((action) => action.id !== "jump" && !PR_VIEW_ACTIONS.has(action.id)).map((action) => action.id));
    expect(items.filter((item) => item.target).map((item) => [item.title, item.keys.join(""), item.on])).toEqual([["Go to Overview", "", true],
      ["Go to Store pickup", "1", true],
      ["Go to Shelf order", "2", false], ["Go to One-offs", "3", true], ["Go to folio · service", "4", true], ["Go to atlas · service", "5", true],
      ["Go to catalog · service", "6", true], ["Resume Gift cards", "", true], ["Reopen Store hours", "", true], ["Reopen Old", "", false]]);
  });
});

describe("the review notes confirm", () => {
  const read = (evidence: Record<string, unknown> = {}, ask: Extract<ConfirmRead, { ok: true }>["ask"] = { kind: "new", under: "Store pickup" }) => ({ ok: true as const,
    headOid: "a".repeat(40), fingerprint: "f".repeat(64), ask, evidence: { since: new Date(NOW - 86_400_000).toISOString(), commits: 0, replies: 0, threads: { total: 0, resolved: 0 },
      complete: true, ...evidence },
    sources: [{ id: "review-318", kind: "review" as const, author: "theo-k", at: new Date(NOW - 86_400_000).toISOString(), body: "Keep the old label as a fallback.",
      truncated: false, resolved: null }, { id: "thread-318", kind: "thread" as const, author: "theo-k", at: new Date(NOW - 86_400_000).toISOString(),
      body: "Wrap here too.", truncated: true, resolved: true }] });

  it("leads with asking the PR's thread when nothing since the approval shows the notes handled, and with Confirm handled when something does", () => {
    expect(notesScreen(read(), NOW)).toEqual({ primary: "ask", ask: { to: "starts a thread under Store pickup" },
      evidence: { text: "No commits, reply, or resolved threads since this approval", handled: false, linked: null },
      notes: [{ id: "review-318", who: "@theo-k", what: "review", age: "1d", body: "Keep the old label as a fallback.", truncated: false },
        { id: "thread-318", who: "@theo-k", what: "thread, resolved", age: "1d", body: "Wrap here too.", truncated: true }] });
    expect(notesScreen(read({}, { kind: "thread", title: "Spine labels" }), NOW).ask).toEqual({ to: "goes to “Spine labels”" });
    for (const evidence of [{ commits: 1 }, { replies: 2 }, { threads: { total: 1, resolved: 1 } }]) {
      expect(notesScreen(read(evidence), NOW)).toMatchObject({ primary: "confirm", evidence: { handled: true } });
    }
    expect(notesScreen(read({ commits: 1, complete: false }), NOW).primary).toBe("ask");
  });

  // A PR that mentions this one may be the follow-up a conditional approval asked for, so the confirm names it, but it's no reply: with
  // nothing else since the approval, asking still leads and confirming stays Confirm anyway's own click.
  it("names the PRs that mention this one beside the evidence, and never counts them", () => {
    const linked = [{ repo: "inkwell/folio", number: 362 }, { repo: "inkwell/catalog", number: 97 }];
    expect(notesScreen(read({ linked }), NOW)).toMatchObject({ primary: "ask",
      evidence: { text: "No commits, reply, or resolved threads since this approval", handled: false, linked: "Linked: folio #362, catalog #97 mention this PR" } });
    expect(notesScreen(read({ linked: linked.slice(1), replies: 1 }), NOW)).toMatchObject({ primary: "confirm",
      evidence: { text: "1 reply since this approval", handled: true, linked: "Linked: catalog #97 mentions this PR" } });
  });

  // Asking never creates an effort or its threads, so a PR with nowhere to ask says why, and ⌘↵ does nothing: Confirm anyway stays a click.
  it("leads with nothing when there's no evidence and nowhere to ask", () => {
    const none = { kind: "none" as const, why: "This PR has no thread or checkout yet." };
    expect(notesScreen(read({}, none), NOW)).toMatchObject({ primary: null, ask: { why: "This PR has no thread or checkout yet." } });
    expect(notesScreen(read({ commits: 1 }, none), NOW).primary).toBe("confirm");
  });
});
