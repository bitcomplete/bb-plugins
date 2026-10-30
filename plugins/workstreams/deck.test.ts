import { describe, expect, it } from "vitest";
import { counted, needsYou } from "./deck-shared.js";
import { deckRows, deckView, type DeckEffortInput, type DeckInput, type DeckRowInput } from "./deck.js";
import type { SuggestionGroup } from "./effort-classify.js";
import { inkwellDeck, inkwellInventory, inkwellInventoryPrs, inkwellThreads, INVENTORY_EFFORTS, INVENTORY_NOW } from "./inkwell-fixtures.js";
import type { InventoryView } from "./inventory-view.js";
import { inventoryScreen, onYourTurn } from "./inventory-view-model.js";
import { LINEAR_SETTLE_MS, type LinearDetail } from "./linear.js";
import type { AttentionReason } from "./pr-attention.js";

const DAY = 86_400_000;
const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const effort = (key: keyof typeof INVENTORY_EFFORTS, patch: Partial<DeckEffortInput> = {}): DeckEffortInput => ({ ...INVENTORY_EFFORTS[key], key, goal: "",
  oneOff: false, archived: false, pile: { effortId: INVENTORY_EFFORTS[key].id, pile: "active", reason: "", since: 1 }, parentThreadId: null, tickets: [],
  ...patch });
const ONE_OFFS = { id: "effort-one-offs", name: "One-offs" };
/**
 * The inventory case's 17 PRs as the server hands them to the deck: Shelf order holds folio #340-#343 (an approved stack) and #330
 * (approved but conflicting); Store pickup holds quill #210 and #211 and spine #155 (changes requested) and the approved #212 and #156
 * stacked on them; seven PRs have no effort.
 */
function input(patch: Partial<DeckInput> = {}, row: (row: DeckRowInput) => Partial<DeckRowInput> = () => ({})): DeckInput {
  const prs = new Map(inkwellInventoryPrs().map((pr) => [pr.url, pr]));
  const rows = inkwellInventory().groups.flatMap((group) => group.rows.map((entry): DeckRowInput => {
    const base: DeckRowInput = { ...entry, effort: group.effort, pr: prs.get(entry.prUrl) ?? null, tickets: entry.title.match(/ABC-\d+/gu) ?? [],
      acted: null };
    return { ...base, ...row(base) };
  }));
  return { now: INVENTORY_NOW, efforts: [effort("shelf"), effort("pickup")], rows, merges: [], linear: new Map(), linearReadAt: new Map(), threads: new Map(), homes: [],
    classify: { groups: [], oneOffsId: null }, read: { checkedAt: null, refreshing: false, limitedUntil: null }, seen: new Map(), ...patch };
}
const sections = (card: ReturnType<typeof deckView>["active"][number]) =>
  Object.fromEntries(card.sections.map((section) => [section.key, section.rows.map((row) => `${row.repo.split("/")[1]} #${row.number}`)]));
const cardOf = (view: ReturnType<typeof deckView>, id: string) => [...view.active, ...view.held].find((card) => card.id === id)!;
/** Every row on a service card, by where it files. */
const serviceRows = (view: ReturnType<typeof deckView>) => Object.fromEntries(view.active.filter((card) => card.kind === "service")
  .flatMap((card) => card.sections.flatMap((section) => section.rows.map((row) => [`${row.repo.split("/")[1]} #${row.number}`, row.section]))));

describe("the effort deck", () => {
  it("files each row under the move its inventory row leads with, so the deck and the inventory never disagree about what you do next", () => {
    const view = deckView(input());
    // An approved stack merges in order, so every PR in it is a merge; a stacked PR whose parent needs work waits on that parent.
    expect(sections(cardOf(view, INVENTORY_EFFORTS.shelf.id))).toEqual({ merge: ["folio #340", "folio #341", "folio #342", "folio #343"], work: ["folio #330"] });
    expect(sections(cardOf(view, INVENTORY_EFFORTS.pickup.id))).toEqual({ work: ["quill #210", "quill #211", "spine #155"], blocked: ["quill #212", "spine #156"] });
    expect(cardOf(view, INVENTORY_EFFORTS.pickup.id).blocked.map(({ ref, kind, on }) => [ref, kind, on]))
      .toEqual([["quill #212", "parent", "quill #210"], ["spine #156", "parent", "spine #155"]]);
    // A PR missing a reviewer asks for one first, as its inventory row does, even while it conflicts; one asked 2 hours ago is no nudge yet.
    expect(serviceRows(view)).toEqual({
      "atlas #410": "request", "catalog #96": "nudge", "catalog #97": "work", "folio #301": "confirm", "folio #305": "request", "folio #318": "confirm",
      "folio #325": "request" });
  });

  // The pile leads with where a person waits on you, Your turn, as the strip chips count: Shelf order's five moves of yours are chores and
  // merges, so Store pickup's three PRs with feedback come first.
  it("orders the active pile by Your turn with One-offs after every effort, and the service cards after them, whose moves count as Needs you too", () => {
    const loose = [url("folio", 301), url("folio", 318), url("catalog", 96), url("catalog", 97), url("atlas", 410), url("folio", 305)];
    const view = deckView(input({ efforts: [effort("shelf"), effort("pickup"), { ...effort("shelf"), ...ONE_OFFS, key: "one-offs", oneOff: true,
      pile: { effortId: ONE_OFFS.id, pile: "active", reason: "", since: 0 } }] }, (row) => loose.includes(row.prUrl) ? { effort: ONE_OFFS } : {}));
    expect(view.active.map((card) => [card.name, card.yourTurn, card.needsYou])).toEqual([["Store pickup", 3, 3], ["Shelf order", 0, 5], ["One-offs", 2, 6],
      ["folio · service", 0, 1]]);
    // folio #325 has no effort, and its move is yours all the same: nothing open is outside a card, or outside the count.
    expect(view.counts).toEqual({ needsYou: 15, held: 0, done: 0 });
  });

  it("puts each open PR no effort owns on its repository's service card, most Your turn first, with the classifier's suggestions cut to its PRs", () => {
    const signal = (effortId: string | null) => [{ kind: "ticket" as const, effortId, text: "ticket ABC-210" }];
    const pr = (repo: string, number: number) => ({ prUrl: url(repo, number), repo: `inkwell/${repo}`, number, title: `Change ${number}`, signals: signal(null) });
    // One suggestion spans two repositories: each card shows the part of it that is on that card.
    const groups: SuggestionGroup[] = [{ key: "new:ABC-210", target: { kind: "new", name: "Delivery windows" }, confidence: "medium", reason: "Shared ticket ABC-210",
      signals: ["ticket ABC-210"], tickets: ["ABC-210"], prs: [pr("atlas", 410), pr("catalog", 97)] }];
    const view = deckView(input({ classify: { groups, oneOffsId: null } }));
    expect(view.active.map((card) => [card.name, card.kind, card.repo, card.needsYou, card.stats.open])).toEqual([
      ["Store pickup", "effort", null, 3, 5], ["Shelf order", "effort", null, 5, 5],
      ["folio · service", "service", "inkwell/folio", 4, 4], ["catalog · service", "service", "inkwell/catalog", 2, 2], ["atlas · service", "service", "inkwell/atlas", 1, 1]]);
    const service = (repo: string) => view.active.find((card) => card.repo === `inkwell/${repo}`)!;
    expect(service("folio")).toMatchObject({ id: "service:inkwell/folio", key: "service:inkwell/folio", pile: "active", oneOff: false, suggestions: [] });
    expect(service("atlas").suggestions.map((group) => [group.key, group.prs.map((item) => item.number)])).toEqual([["new:ABC-210", [410]]]);
    expect(service("catalog").suggestions.map((group) => [group.key, group.prs.map((item) => item.number)])).toEqual([["new:ABC-210", [97]]]);
    // An effort's card never carries suggestions: its PRs are already where they belong.
    expect(cardOf(view, INVENTORY_EFFORTS.shelf.id).suggestions).toEqual([]);
    expect(view.counts.needsYou).toBe(5 + 3 + 4 + 2 + 1);
    // A batch reads the same rows: each PR no effort owns is on its service card, which is always active.
    expect(deckRows(input()).filter((item) => item.input.effort === null).map((item) => `${item.row.number} ${item.cardId} ${item.pile}`).sort()).toEqual([
      "301 service:inkwell/folio active", "305 service:inkwell/folio active", "318 service:inkwell/folio active", "325 service:inkwell/folio active",
      "410 service:inkwell/atlas active", "96 service:inkwell/catalog active", "97 service:inkwell/catalog active"]);
  });

  it("lets an explicit effort win over the service card, even for a PR in the same repository, and draws no service card a repository doesn't need", () => {
    // folio #325 joins Shelf order; the other folio PRs no effort owns stay on folio's service card. Every catalog PR joins One-offs.
    const view = deckView(input({ efforts: [effort("shelf"), effort("pickup"), { ...effort("shelf"), ...ONE_OFFS, key: "one-offs", oneOff: true }] },
      (row) => row.number === 325 ? { effort: INVENTORY_EFFORTS.shelf } : row.repo === "inkwell/catalog" ? { effort: ONE_OFFS } : {}));
    expect(sections(cardOf(view, INVENTORY_EFFORTS.shelf.id)).request).toEqual(["folio #325"]);
    expect(Object.keys(serviceRows(view)).sort()).toEqual(["atlas #410", "folio #301", "folio #305", "folio #318"]);
    expect(view.active.map((card) => card.name)).not.toContain("catalog · service");
    // A held effort's PR pauses with it rather than falling back to a service card.
    const held = deckView(input({ efforts: [effort("shelf", { pile: { effortId: INVENTORY_EFFORTS.shelf.id, pile: "held", reason: "", since: 1 } }), effort("pickup")] }));
    expect(Object.keys(serviceRows(held))).not.toContain("folio #340");
  });

  it("stops counting a row you acted on while its write waits, and once it lands until you mark the view seen; a refusal stays yours", () => {
    const row = { section: "nudge" as const };
    expect(needsYou({ ...row, acted: null }, "active")).toBe(true);
    expect(needsYou({ ...row, acted: { kind: "nudge", state: "queued", at: 5, batchId: null } }, "active")).toBe(false);
    expect(needsYou({ ...row, acted: { kind: "nudge", state: "sending", at: 5, batchId: null } }, "active")).toBe(false);
    expect([4, 5].map((seenAt) => counted({ acted: { kind: "nudge", state: "sent", at: 5, batchId: null } }, seenAt))).toEqual([false, true]);
    expect(needsYou({ ...row, acted: { kind: "nudge", state: "refused", at: 5, batchId: null } }, "active", 0)).toBe(true);
    expect((["held", "done"] as const).map((pile) => needsYou({ ...row, acted: null }, pile))).toEqual([false, false]);
    expect(needsYou({ section: "blocked", acted: null }, "active")).toBe(false);
    const view = deckView(input({}, (entry) => entry.number === 340 ? { acted: { kind: "ready", state: "queued", at: INVENTORY_NOW, batchId: null } } : {}));
    expect(cardOf(view, INVENTORY_EFFORTS.shelf.id)).toMatchObject({ needsYou: 4, sections: [{ key: "merge", needsYou: 3 }, { key: "work", needsYou: 1 }] });
    // A write that landed stays out of the count until the view says it marked the row seen after it, so a caller that says nothing never
    // counts, or plans, the same move twice.
    expect(needsYou({ ...row, acted: { kind: "nudge", state: "sent", at: 5, batchId: null } }, "active")).toBe(false);
    const landed = (entry: DeckRowInput) => entry.number === 340 ? { acted: { kind: "ready" as const, state: "sent" as const, at: INVENTORY_NOW - 60_000, batchId: null } } : {};
    expect(cardOf(deckView(input({}, landed)), INVENTORY_EFFORTS.shelf.id).needsYou).toBe(4);
    expect(cardOf(deckView(input({ seen: new Map([[url("folio", 340), INVENTORY_NOW]]) }, landed)), INVENTORY_EFFORTS.shelf.id).needsYou).toBe(5);
    // A day on, the write is history: the row counts again, seen or not.
    const old = (entry: DeckRowInput) => entry.number === 340 ? { acted: { kind: "ready" as const, state: "sent" as const, at: INVENTORY_NOW - DAY, batchId: null } } : {};
    expect(cardOf(deckView(input({}, old)), INVENTORY_EFFORTS.shelf.id).needsYou).toBe(5);
  });

  it("pauses a held effort, files a stacked PR under what it waits on, and a PR you hold under Held alone", () => {
    const view = deckView(input({ efforts: [effort("shelf", { pile: { effortId: INVENTORY_EFFORTS.shelf.id, pile: "held", reason: "Design review", since: 9 } }),
      effort("pickup")] }, (row) => row.number === 210 ? { hold: { reason: "Waiting on the counter redesign", heldAt: INVENTORY_NOW - DAY } } : {}));
    expect(view.active.filter((card) => card.kind === "effort").map((card) => card.name)).toEqual(["Store pickup"]);
    expect(view.held).toMatchObject([{ name: "Shelf order", needsYou: 0, status: { tone: "held", text: "On hold: Design review" } }]);
    // Store pickup's two moves of yours, and the seven on service cards.
    expect(view.counts).toMatchObject({ needsYou: 2 + 7, held: 1 });
    const pickup = cardOf(view, INVENTORY_EFFORTS.pickup.id);
    // Oldest wait first: the stacked PRs since their push 3 days ago.
    expect(pickup.blocked.map(({ ref, kind, on, what, since }) => [ref, kind, on, what, since])).toEqual([
      ["quill #212", "parent", "quill #210", "Merges after quill #210", INVENTORY_NOW - 3 * DAY],
      ["spine #156", "parent", "spine #155", "Merges after spine #155", INVENTORY_NOW - 3 * DAY]]);
    // The hold is in no other section, no next step, and not the oldest wait: it's parked until you release it, and Held says since when.
    expect(pickup.sections.filter((section) => section.rows.some((row) => row.number === 210)).map((section) => section.key)).toEqual(["held"]);
    expect(pickup.sections.find((section) => section.key === "held")!.rows.map((row) => [row.number, row.hold, row.waitsOn?.since]))
      .toEqual([[210, { reason: "Waiting on the counter redesign", since: INVENTORY_NOW - DAY }, INVENTORY_NOW - DAY]]);
    expect(pickup.next.some((item) => item.prUrl === url("quill", 210))).toBe(false);
    expect(pickup.stats.oldestWait?.ref).not.toBe("quill #210");
    expect(pickup.status.text).toBe("2 need you · 2 blocked · 1 held");
  });

  it("keeps a PR you hold out of the next steps and the oldest wait, even as its card's oldest or only row", () => {
    const view = deckView(input({}, (row) => row.number === 210 || row.number === 410 ? { hold: { reason: "Parked", heldAt: INVENTORY_NOW - 10 * DAY } } : {}));
    // Held ten days, quill #210 is older than any wait on Store pickup, and the oldest wait is still one that waits on someone else.
    expect(cardOf(view, INVENTORY_EFFORTS.pickup.id).stats.oldestWait?.ref).toBe("quill #212");
    // atlas #410 is its service card's only PR: held, it leaves the card no next step and nothing waiting, and the status still counts it.
    const atlas = view.active.find((card) => card.repo === "inkwell/atlas")!;
    expect([atlas.next, atlas.stats.oldestWait, atlas.sections.map((section) => section.key), atlas.status])
      .toEqual([[], null, ["held"], { tone: "waiting", text: "1 held" }]);
  });

  // The badge and All PRs' Your turn say a reviewer's feedback waits on your move; its card must say so too, and the deck's Address must
  // take the same PRs. A card that offered Merge, or led with a nudge that waits on other reviewers, while the feedback waits, or called a
  // PR nothing works on In flight, or paused one with its effort, or addressed or counted one you dismissed, would send you two ways at once.
  // A PR a thread is at work on is In flight in both, whatever its row leads with, and so is one you dismissed, until a person says more.
  it("files every PR Your turn lists under a move of yours, never Merge, on an active card, and addresses only those; one you dismissed, under none", () => {
    const comments = { why: "Comment from @ines-v", since: INVENTORY_NOW - 3_600_000, latest: INVENTORY_NOW - 3_600_000 };
    const merge: AttentionReason = { question: "needs-nudge", kind: "merge-waiting", action: "merge", nextStep: "Merge", owner: "you", reviewers: [],
      since: INVENTORY_NOW - 2 * DAY, ageMs: 2 * DAY, basis: "github" };
    const held = [effort("shelf"), effort("pickup", { pile: { effortId: INVENTORY_EFFORTS.pickup.id, pile: "held", reason: "", since: 1 } })];
    const cases: [DeckInput, number[]][] = [
      [input(), [210, 211, 155, 301, 318]],
      [input({}, (row) => row.number === 340 ? { attention: [merge], yourTurn: comments } : {}), [340, 210, 211, 155, 301, 318]],
      [input({}, (row) => row.number === 96 ? { yourTurn: comments } : {}), [210, 211, 155, 96, 301, 318]],
      [input({}, (row) => row.number === 211 ? { threads: { ...row.threads, executor: { ...row.threads.executor!, active: true } } } : {}), [210, 155, 301, 318]],
      [input({ efforts: held }), [301, 318]],
      // An approval's note leads with Confirm, not its thread; a thread at work on it still has it.
      [input({}, (row) => row.number === 301 ? { threads: { origin: null, executor: { id: "thr_folio_301", title: "Answer mira", active: true } } } : {}), [210, 211, 155, 318]],
      // An older batch thread is done with it, and the PR's own thread took it since.
      [input({}, (row) => row.number === 211 ? { sent: { state: "idle", threadId: "thr-batch", title: "Address feedback on 2 PRs", detail: null, batchId: null },
        threads: { ...row.threads, executor: { ...row.threads.executor!, active: true } } } : {}), [210, 155, 301, 318]],
      [input({}, (row) => row.number === 155 ? { dismissed: true } : {}), [210, 211, 301, 318]],
    ];
    for (const [deck, listed] of cases) {
      // All PRs reads the same rows, each group with its effort's pile.
      const piles = new Map(deck.efforts.map((item) => [item.id, item.pile.pile]));
      const rows = new Map(deck.rows.map((row) => [row.prUrl, row]));
      const base = inkwellInventory();
      const view: InventoryView = { ...base, groups: base.groups.map((group) => ({ effort: group.effort && { ...group.effort, pile: piles.get(group.effort.id) },
        rows: group.rows.map((row) => rows.get(row.prUrl)!) })) };
      const turn = new Set(inventoryScreen(view, { now: deck.now, filter: null }).groups.flatMap((group) => group.lines).filter(onYourTurn).map((line) => line.prUrl));
      expect([...turn].map((prUrl) => rows.get(prUrl)!.number)).toEqual(listed);
      expect(deckRows(deck).filter(({ row, pile }) => turn.has(row.prUrl) && !(needsYou(row, pile) && row.section !== "merge" && row.step?.owner === "you"))
        .map(({ row, pile }) => [row.number, pile, row.section, row.step?.owner])).toEqual([]);
      const rowsOf = (list: string) => deckRows(deck).filter(({ row }) => row.turn.list === list).map(({ row }) => row.number);
      expect(rowsOf("turn").sort()).toEqual([...listed].sort());
      expect(deckRows(deck).filter(({ row }) => ["in-flight", "dismissed"].includes(row.turn.list) && row.section !== "flight")
        .map(({ row }) => [row.number, row.section])).toEqual([]);
    }
  });

  it("keeps a review not yet due a nudge, running checks, and code work a thread is doing in flight: nothing is yours yet, and nothing is blocked", () => {
    const view = deckView(input({}, (row) => row.number === 96 ? { reviewers: { ...row.reviewers, requested: ["mira-l"] }, attention: [],
      pr: { ...row.pr!, reviewRequestedAt: [{ reviewer: "mira-l", at: new Date(INVENTORY_NOW - 5 * 3_600_000).toISOString() }] } }
      // Checks running hold its approval's notes too, so the server marks it neither needing a confirm nor your turn.
      : row.number === 318 ? { attention: [], yourTurn: null, status: "Checks pending" }
      : row.number === 330 ? { threads: { ...row.threads, executor: { id: "thr_folio_330", title: "Fix the shelf conflict", active: true } } } : {}));
    expect(Object.fromEntries(view.active.flatMap((card) => card.sections.flatMap((section) => section.rows)).filter((row) => [96, 318].includes(row.number))
      .map((row) => [row.number, [row.section, row.waitsOn]]))).toEqual({ 96: ["flight", null], 318: ["flight", null] });
    // Its thread is working the conflict now; with that thread idle, the conflict is yours to hand it.
    expect(cardOf(view, INVENTORY_EFFORTS.shelf.id)).toMatchObject({ needsYou: 4, status: { text: "4 need you · 1 in flight" } });
    expect(sections(cardOf(view, INVENTORY_EFFORTS.shelf.id))).toMatchObject({ flight: ["folio #330"] });
  });

  it("sums a card from its rows: stats, merges against open PRs, next steps, who waits on whom, threads, and the week's activity", () => {
    const pickup = INVENTORY_EFFORTS.pickup.id;
    const view = deckView(input({
      efforts: [effort("shelf"), effort("pickup", { parentThreadId: "thr_pickup" })],
      merges: [{ url: url("quill", 200), at: INVENTORY_NOW - DAY, effortId: pickup }, { url: url("quill", 190), at: INVENTORY_NOW - 20 * DAY, effortId: pickup },
        { url: url("quill", 195), at: INVENTORY_NOW - 10 * DAY, effortId: pickup },
        { url: url("folio", 290), at: INVENTORY_NOW - DAY, effortId: INVENTORY_EFFORTS.shelf.id }],
      threads: new Map([["thr_pickup", { title: "Store pickup", status: "idle", updatedAt: INVENTORY_NOW - 9 * DAY }],
        ["thr_quill_211", { title: "Work on quill #211", status: "active", updatedAt: INVENTORY_NOW - 60_000 }]]),
    }));
    const card = cardOf(view, pickup);
    expect(card.status).toEqual({ tone: "you", text: "3 need you · 2 blocked" });
    // Every PR here opened 6 days ago; the stacked PRs have waited since their push 3 days ago, longer than any of your moves is dated. The
    // merge 10 days ago paces the finish line's ETA over two weeks, though it isn't this week's.
    expect(card.stats).toEqual({ open: 5, ready: 0, mergedWeek: 1, mergedFortnight: 2, medianAgeMs: 6 * DAY,
      oldestWait: { prUrl: url("quill", 212), ref: "quill #212", text: "Merges after quill #210", since: INVENTORY_NOW - 3 * DAY } });
    expect(card.progress).toEqual({ merged: 3, open: 5 });
    // Your moves first, oldest first, then what waits on others.
    expect(card.next).toEqual([{ text: "Resolve the conflicts", owner: "you", prUrl: url("quill", 210) },
      { text: "Address the requested changes", owner: "you", prUrl: url("quill", 211) }, { text: "Address the requested changes", owner: "you", prUrl: url("spine", 155) }]);
    expect(card.people).toEqual({ youWaitOn: [], waitOnYou: [
      { login: "otto-v", prs: [{ prUrl: url("quill", 210), ref: "quill #210", since: INVENTORY_NOW - DAY }, { prUrl: url("quill", 211), ref: "quill #211", since: INVENTORY_NOW - DAY }] },
      { login: "ines-v", prs: [{ prUrl: url("spine", 155), ref: "spine #155", since: INVENTORY_NOW - DAY }] }] });
    expect(card.threads.map(({ id, role, status }) => [id, role, status])).toEqual([["thr_pickup", "parent", "idle"], ["thr_quill_211", "pr", "active"],
      ["thr_quill_210", "pr", "idle"], ["thr_quill_210_plan", "pr", "idle"], ["thr_spine_155", "pr", "idle"]]);
    // The merges 10 and 20 days ago count toward progress but not this week.
    expect(card.activity.filter((item) => item.kind === "merged")).toEqual([{ kind: "merged", prUrl: url("quill", 200), ref: "quill #200", who: null, at: INVENTORY_NOW - DAY }]);
    expect(card.activity.map((item) => item.kind)).toEqual(["merged", "changes", "changes", "changes", "approved", "approved", "pushed", "pushed", "pushed",
      "pushed", "pushed"]);
  });

  it("rolls up only the Linear details the board stores, and says so when it stores none", () => {
    const detail = (identifier: string, state: string, patch: Partial<LinearDetail> = {}): LinearDetail => ({ identifier, title: null, description: null,
      state: { name: state, type: state === "Done" ? "completed" : "started" }, project: null, parent: null, labels: [], url: null, updatedAt: null, source: "agent", ...patch });
    // A key read carries the project's target date and initiatives on each ticket; an agent answer or an older cached row has none of them.
    const project = { id: "p1", name: "Shelf order", targetDate: "2026-10-17", initiatives: [{ id: "i1", name: "Reading rooms" }] };
    const cycle = { number: 42, name: null, endsAt: "2026-10-03T00:00:00.000Z" };
    const view = deckView(input({ efforts: [effort("shelf", { tickets: ["ABC-300"] }), effort("pickup")], linear: new Map([
      ["ABC-300", detail("ABC-300", "Done", { project, assignee: "dana", cycle })],
      ["ABC-360", detail("ABC-360", "In Review", { project, labels: ["shelves"], assignee: "kai", cycle })],
      ["ABC-361", detail("ABC-361", "In Review", { parent: { identifier: "ABC-300", title: "Shelf order" }, labels: ["shelves"], assignee: "dana" })]]) }));
    // The effort's own ticket counts beside its PRs' tickets.
    // Each ticket read keeps its own state type, priority, and points, for the rows' ticket chips and the p expand; an older row has none.
    expect(cardOf(view, INVENTORY_EFFORTS.shelf.id).linear).toEqual({ tickets: 6, known: 3, projects: [{ name: "Shelf order", count: 2, targetDate: "2026-10-17" }],
      initiatives: [{ name: "Reading rooms", count: 2 }], parents: [{ name: "ABC-300 Shelf order", count: 1 }],
      states: [{ name: "In Review", type: "started", count: 2 }, { name: "Done", type: "completed", count: 1 }], labels: [{ name: "shelves", count: 2 }],
      cycles: [{ number: 42, name: null, endsAt: "2026-10-03T00:00:00.000Z", count: 2 }], assignees: [{ name: "dana", count: 2 }, { name: "kai", count: 1 }],
      issues: [{ id: "ABC-300", type: "completed", priority: null, label: null, estimate: null }, { id: "ABC-360", type: "started", priority: null, label: null, estimate: null },
        { id: "ABC-361", type: "started", priority: null, label: null, estimate: null }],
      reconcile: { done: [], prUrls: [], merged: [] } });
    expect(cardOf(view, INVENTORY_EFFORTS.pickup.id).linear).toEqual({ tickets: 5, known: 0, projects: [], initiatives: [], parents: [], states: [], labels: [],
      cycles: [], assignees: [], issues: [], reconcile: { done: [], prUrls: [], merged: [] } });
  });

  // Linear and GitHub disagreeing is a move of its own (Reconcile): a ticket done in Linear while its PR stays open wants a merge or a close,
  // and an open ticket whose every PR merged wants Linear moved. Only a state Linear gave counts, and only merges the sync keeps fresh.
  it("finds where Linear and GitHub disagree: done tickets with PRs open here, and open tickets every recent PR of which merged", () => {
    const detail = (identifier: string, type: string, url: string | null = null): LinearDetail => ({ identifier, title: null, description: null,
      state: { name: type, type }, project: null, parent: null, labels: [], url, updatedAt: null, source: "key" });
    const shelf = INVENTORY_EFFORTS.shelf.id;
    const merge = (number: number, daysAgo: number, tickets: string[]) => ({ url: url("folio", number), at: INVENTORY_NOW - daysAgo * DAY, effortId: shelf, tickets });
    const linear = new Map([
      // Done in Linear with folio #341 open; folio #342 open on a started ticket; the effort's own done ticket has no open PR.
      ["ABC-361", detail("ABC-361", "completed")], ["ABC-362", detail("ABC-362", "started")], ["ABC-300", detail("ABC-300", "completed")],
      // Open after their only PRs merged in the last 14 days, with Linear links; one canceled, one done, one merged 20 days ago.
      ["ABC-390", detail("ABC-390", "started", "https://linear.app/inkwell/issue/ABC-390")], ["ABC-391", detail("ABC-391", "unstarted")],
      ["ABC-392", detail("ABC-392", "canceled")], ["ABC-395", detail("ABC-395", "completed")], ["ABC-393", detail("ABC-393", "started")],
      // Still open on Store pickup's quill #210, so not every PR of it merged.
      ["ABC-370", detail("ABC-370", "started")]]);
    const view = deckView(input({ efforts: [effort("shelf", { tickets: ["ABC-300"] }), effort("pickup")],
      merges: [merge(290, 2, ["ABC-390"]), merge(291, 3, ["ABC-391"]), merge(292, 5, ["ABC-392"]), merge(293, 20, ["ABC-393"]), merge(294, 1, ["ABC-370"]),
        merge(295, 1, ["ABC-394"]), merge(296, 4, ["ABC-395"])], linear, linearReadAt: new Map([...linear.keys()].map((ticket) => [ticket, INVENTORY_NOW])) }));
    expect(cardOf(view, shelf).linear.reconcile).toEqual({ done: ["ABC-361"], prUrls: [url("folio", 341)],
      merged: [{ id: "ABC-390", url: "https://linear.app/inkwell/issue/ABC-390" }, { id: "ABC-391", url: null }] });
  });

  // Linear moves a merged PR's tickets itself, soon after the merge, so a ticket last read while its PR was open says nothing yet: that read
  // would call nearly every merge a mismatch until its cache ran out. Only a read LINEAR_SETTLE_MS past the newest merge naming the ticket,
  // in any effort, counts; the sync makes one on its next scan.
  it("calls a ticket open after its PRs merged only from a read made once Linear had time to move it", () => {
    const detail: LinearDetail = { identifier: "ABC-399", title: null, description: null, state: { name: "In Review", type: "started" }, project: null, parent: null,
      labels: [], url: null, updatedAt: null, source: "key" };
    const at = INVENTORY_NOW - 2 * 3_600_000;
    const merge = (number: number, ago: number, effortId: string) => ({ url: url("folio", number), at: at - ago, effortId, tickets: ["ABC-399"] });
    const merged = (readAt: number, merges = [merge(280, 0, INVENTORY_EFFORTS.shelf.id)]) => cardOf(deckView(input({ merges,
      linear: new Map([["ABC-399", detail]]), linearReadAt: new Map([["ABC-399", readAt]]) })), INVENTORY_EFFORTS.shelf.id).linear.reconcile.merged.map((ticket) => ticket.id);
    expect([at - 1, at + LINEAR_SETTLE_MS - 1, at + LINEAR_SETTLE_MS].map((readAt) => merged(readAt))).toEqual([[], [], ["ABC-399"]]);
    // A read past Shelf order's own merge still predates a later merge naming the ticket on Store pickup.
    const own = [merge(281, DAY, INVENTORY_EFFORTS.shelf.id)];
    expect([merged(at - DAY + LINEAR_SETTLE_MS, own), merged(at - DAY + LINEAR_SETTLE_MS, [...own, merge(282, 0, INVENTORY_EFFORTS.pickup.id)])])
      .toEqual([["ABC-399"], []]);
  });

  it("lists a done effort by name with what it merged and what is still open, without drawing its card", () => {
    const view = deckView(input({ efforts: [effort("shelf", { pile: { effortId: INVENTORY_EFFORTS.shelf.id, pile: "done", reason: "", since: 7 } }), effort("pickup")],
      merges: [{ url: url("folio", 290), at: INVENTORY_NOW - 30 * DAY, effortId: INVENTORY_EFFORTS.shelf.id }] }));
    expect(view.done).toEqual([{ id: INVENTORY_EFFORTS.shelf.id, key: "shelf", name: "Shelf order", archived: false, since: 7, merged: 1, open: 5 }]);
    expect(view.active.filter((card) => card.kind === "effort").map((card) => card.name)).toEqual(["Store pickup"]);
  });

  it("lists an archived effort with the done ones while it still owns open PRs, so none of yours drops off the deck", () => {
    const archived = effort("pickup", { archived: true, pile: { effortId: INVENTORY_EFFORTS.pickup.id, pile: "done", reason: "", since: 9 } });
    const view = deckView(input({ efforts: [effort("shelf"), archived] }));
    expect(view.done).toEqual([{ id: INVENTORY_EFFORTS.pickup.id, key: "pickup", name: "Store pickup", archived: true, since: 9, merged: 0, open: 5 }]);
    // Its PRs pause as a done effort's do: they don't count, and don't fall back to a service card. The seven no effort owns count there.
    expect(view.counts).toEqual({ needsYou: 5 + 7, held: 0, done: 1 });
    expect(Object.keys(serviceRows(view))).toHaveLength(7);
    // Once they close, it leaves the deck.
    expect(deckView(input({ efforts: [archived], rows: [] })).done).toEqual([]);
  });
});

describe("threads on the effort deck", () => {
  const threadsOf = (view: ReturnType<typeof deckView>, id: string) => view.active.find((card) => card.id === id)?.threads.map((thread) =>
    `${thread.id} ${thread.role}${thread.prUrl ? ` ${thread.prUrl.split("/").at(-3)} #${thread.prUrl.split("/").at(-1)}` : ""}`);
  const everyThread = (view: ReturnType<typeof deckView>) => view.active.flatMap((card) => card.threads.map((thread) => thread.id));

  it("puts every thread on a card: its effort's, its repository's service card, or Loose threads last", () => {
    const view = inkwellDeck(inkwellThreads());
    expect(view.active.map((card) => [card.name, card.kind])).toEqual([["Store pickup", "effort"], ["Shelf order", "effort"], ["One-offs", "effort"],
      ["folio · service", "service"], ["atlas · service", "service"], ["catalog · service", "service"], ["quill · service", "service"], ["Loose threads", "loose"]]);
    // Nothing is outside a card: every thread the deck was handed is on one, and on only one of the cards it places by evidence.
    const placed = everyThread(view);
    for (const id of inkwellThreads().homes.map((thread) => thread.id)) expect(placed.filter((item) => item === id)).toHaveLength(1);
    expect(view.counts.needsYou).toBe(inkwellDeck().counts.needsYou);
  });

  it("lets an explicit effort win: the thread's own effort, then the effort of the PRs it links, merged ones too", () => {
    const view = inkwellDeck(inkwellThreads());
    expect(threadsOf(view, INVENTORY_EFFORTS.shelf.id)).toEqual(["thr_folio_330 pr folio #330", "thr_shelf_notes linked", "thr_shelf_ship linked"]);
  });

  // The review's real case: threads that ran in a clone many threads share link to whatever branch it has checked out, which says nothing.
  it("never places a thread by a checkout it shares, so the folio clone's threads don't crowd folio's service card", () => {
    const view = inkwellDeck(inkwellThreads());
    expect(threadsOf(view, "service:inkwell/folio")).toEqual(["thr_folio_recall linked folio #325", "thr_folio_305 pr folio #305", "thr_folio_325 pr folio #325"]);
    expect(threadsOf(view, "loose")).toEqual(["thr_clone_flaky linked", "thr_audit_logs linked", "thr_clone_footer linked", "thr_clone_question linked"]);
  });

  it("puts a thread spanning repositories on the one most of its PRs are in, its environment's on a tie, else Loose threads", () => {
    const view = inkwellDeck(inkwellThreads());
    expect(threadsOf(view, "service:inkwell/catalog")).toEqual(["thr_author_rename linked catalog #97"]);
    expect(threadsOf(view, "service:inkwell/atlas")).toEqual(["thr_atlas_410 pr atlas #410"]);
    expect(threadsOf(view, "loose")).toContain("thr_audit_logs linked");
  });

  it("draws a service card for a repository whose only open work is a thread in a checkout of its own, after the ones with PRs", () => {
    const quill = inkwellDeck(inkwellThreads()).active.find((card) => card.id === "service:inkwell/quill")!;
    expect(quill).toMatchObject({ name: "quill · service", kind: "service", repo: "inkwell/quill", needsYou: 0, stats: { open: 0 }, sections: [], suggestions: [],
      status: { text: "No open PRs" }, threads: [{ id: "thr_quill_try", role: "linked", prUrl: null }] });
  });

  it("draws Loose threads only while a thread has nowhere else to go, and never counts it in Needs you", () => {
    const { threads, homes } = inkwellThreads();
    expect(inkwellDeck({ threads, homes: homes.filter((thread) => !["thr_clone_footer", "thr_clone_flaky", "thr_clone_question", "thr_audit_logs"].includes(thread.id)) })
      .active.map((card) => card.id)).not.toContain("loose");
    const loose = inkwellDeck({ threads, homes }).active.at(-1)!;
    expect(loose).toMatchObject({ id: "loose", name: "Loose threads", kind: "loose", repo: null, needsYou: 0, pile: "active", sections: [] });
    // A thread the deck has no facts for, such as one archived since, lands nowhere.
    expect(inkwellDeck({ threads: new Map(), homes }).active.map((card) => card.id)).not.toContain("loose");
  });
});
