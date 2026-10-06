import { describe, expect, it } from "vitest";
import { inkwellDeck, INVENTORY_EFFORTS, INVENTORY_NOW } from "./inkwell-fixtures.js";
import { cardScreen } from "./deck-view-model.js";
import { prStatuses, threadRefs, threadStatus, threadReadSummary } from "./deck-status.js";

const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const screen = () => cardScreen(inkwellDeck().active.find((card) => card.oneOff)!, { rows: {} }, { now: INVENTORY_NOW });

describe("visible PR and thread status", () => {
  it("uses Advance's exact available scope, and shows confirmed queued/sending items instead of implying every available action already runs", () => {
    const card = screen();
    const available = prStatuses(card).filter((pr) => pr.advance === "available");
    expect(available.map((pr) => pr.prUrl)).toEqual(card.chores.prUrls);
    expect(available.map((pr) => pr.action?.text)).toEqual(["Advance: Nudge @mira-l, @theo-k"]);
    const live: Map<string, { kind: "nudge"; state: "pending" | "sending" | "sent" }> = new Map([[url("catalog", 96), { kind: "nudge" as const, state: "pending" as const }]]);
    expect(prStatuses(card, live).find((pr) => pr.number === 96)).toMatchObject({ advance: "queued", action: { text: "Nudge · Queued" } });
    live.set(url("catalog", 96), { kind: "nudge", state: "sending" });
    expect(prStatuses(card, live).find((pr) => pr.number === 96)).toMatchObject({ advance: "sending", action: { text: "Nudge · Sending" } });
    live.set(url("catalog", 96), { kind: "nudge", state: "sent" });
    expect(prStatuses(card, live).find((pr) => pr.number === 96)).toMatchObject({ advance: null, action: { text: "Nudge · Sent" } });
  });

  it("keeps retryable Advance PRs in the available scope while showing the last refusal", () => {
    const card = screen();
    const line = card.lines.find((line) => line.row?.number === 96)!;
    line.row = { ...line.row!, acted: { kind: "nudge", state: "refused", at: INVENTORY_NOW, batchId: "batch-refused" } };
    expect(prStatuses(card).find((pr) => pr.number === 96)).toMatchObject({ advance: "available", action: { text: "Nudge · Not sent" } });
  });

  it("identifies each held PR and reason, keeping it out of Advance; a held effort parks every PR", () => {
    const view = inkwellDeck({}, (row) => row.number === 343 ? { hold: { reason: "Wait for launch", heldAt: INVENTORY_NOW } } : {});
    const card = cardScreen(view.active.find((card) => card.id === INVENTORY_EFFORTS.shelf.id)!, { rows: {} }, { now: INVENTORY_NOW });
    expect(prStatuses(card).filter((pr) => pr.held).map((pr) => [pr.ref, pr.detail, pr.advance])).toEqual([["folio #343", "Wait for launch", null]]);
    const held = { ...card, card: { ...card.card, pile: "held" as const, reason: "Waiting for vendor" } };
    expect(prStatuses(held).every((pr) => pr.held && !pr.advance)).toBe(true);
    expect(prStatuses(held).find((pr) => pr.number === 340)?.detail).toBe("Waiting for vendor");
  });

  it("carries pending interactions from the deck input through the view model into both worker and PR status", () => {
    const view = inkwellDeck({ threads: new Map([["thr_folio_330", { title: "Fix shelf conflicts", status: "active", waiting: true, updatedAt: INVENTORY_NOW }]]) });
    const card = cardScreen(view.active.find((card) => card.id === INVENTORY_EFFORTS.shelf.id)!, { rows: {} }, { now: INVENTORY_NOW });
    const thread = card.threads.find((thread) => thread.id === "thr_folio_330")!;
    expect(threadStatus(thread).text).toBe("Needs you");
    expect(prStatuses(card).find((pr) => pr.number === 330)?.thread?.status.text).toBe("Needs you");
  });

  it("keeps Working, Needs you, Failed, and Idle distinct and names every PR linked to a batch thread", () => {
    expect([threadStatus({ status: "active" }), threadStatus({ status: "active", waiting: true }),
      threadStatus({ status: "error" }), threadStatus({ status: "idle" })].map((state) => state.text)).toEqual(["Working", "Needs you", "Failed", "Idle"]);
    const card = screen();
    const thread = { id: "thr-batch", title: "Address feedback", status: "active", ref: "", age: null, dot: false };
    card.lines.slice(0, 2).forEach((line) => { line.row = { ...line.row!, thread: { id: thread.id, title: thread.title, active: true } }; });
    expect(threadRefs(card, thread)).toBe(card.lines.slice(0, 2).map((line) => line.ref).join(" · "));
  });
});


it("summarizes needs-you and working threads and selects the newest activity even when the parent is listed first", () => {
  const view = inkwellDeck();
  const card = view.active[0]!;
  const HOUR = 3_600_000;
  card.threads = [
    { id: "parent", title: "Effort", role: "parent", prUrl: null, status: "idle", lastActivityAt: INVENTORY_NOW - 48 * HOUR },
    { id: "answer", title: "Question", role: "linked", prUrl: null, status: "idle", waiting: true, lastActivityAt: INVENTORY_NOW - 2 * HOUR },
    { id: "work", title: "Fix", role: "linked", prUrl: null, status: "active", lastActivityAt: null },
  ];
  let s = cardScreen(card, { rows: {} }, { now: INVENTORY_NOW });
  expect(threadReadSummary(s)).toContain("1 needs you");
  expect(threadReadSummary(s)).toContain("1 working");
  expect(threadReadSummary(s)).toContain("Last activity 2h ago");
  card.threads.forEach((t) => { t.lastActivityAt = null; });
  s = cardScreen(card, { rows: {} }, { now: INVENTORY_NOW });
  expect(threadReadSummary(s)).not.toContain("Last activity");
});
