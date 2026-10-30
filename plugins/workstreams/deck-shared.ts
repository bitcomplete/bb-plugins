// The effort deck's shared keys and its one "Needs you" rule (plan amendment
// A15). This module imports nothing, so the browser bundle can use it without
// reaching a server module (A12.1): the deck read model, batch actions, the
// deck, and the All PRs table all count with it.

/** Realtime: the server publishes it after each inventory read or action, pile move, thread change, and batch step. */
export const DECK_CHANGED = "deck-changed";

/**
 * A row's section: the move it needs, in the order a card lists them. Each of the first six is yours; in-flight rows need nothing from
 * anyone yet, blocked rows wait on someone or something else, and held rows wait until you release them (plan amendment A17.3): a hold
 * files a row there and nowhere else.
 */
export const DECK_SECTIONS = ["merge", "confirm", "nudge", "request", "ready", "work", "flight", "blocked", "held"] as const;
export type DeckSection = (typeof DECK_SECTIONS)[number];
const YOURS = new Set<DeckSection>(["merge", "confirm", "nudge", "request", "ready", "work"]);

/** The pile a row's card is on. A PR no effort owns is on its repository's service card, which is always active. */
export type DeckPile = "active" | "held" | "done";

/**
 * The cards no stored effort backs (plan amendment A17.1), so nothing open is outside a card: each repository's service card, where its
 * open PRs and threads that no effort has fall back to, and Loose threads, for threads with no effort, PR, or single repository.
 */
export const SERVICE_PREFIX = "service:";
export const LOOSE_ID = "loose";
export const serviceId = (repo: string) => `${SERVICE_PREFIX}${repo.toLowerCase()}`;
export const serviceName = (repo: string) => `${repo.split("/").at(-1) ?? repo} · service`;
export const serviceGoal = (repo: string) => `Work in ${repo.split("/").at(-1) ?? repo} that no effort has yet.`;
/** Where a card sits in the strip: stored efforts first, then service cards, then Loose threads. */
export const cardTier = (id: string) => id === LOOSE_ID ? 2 : id.startsWith(SERVICE_PREFIX) ? 1 : 0;
/**
 * The batches a section button runs, in the order Advance runs them. Each is one GitHub write per PR: never a merge, and never a
 * confirmation of review notes, which you make one PR at a time after reading them.
 */
export const BATCH_KINDS = ["nudge", "request", "ready"] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];
/**
 * Every write the deck confirms in a listing and sends after its Undo window: Advance's kinds; Release, which lifts your hold on a PR
 * (plan amendment A17.3); Ask, which sends a PR's own thread the approval-feedback recipe from that PR's review notes; Fix, which
 * sends each PR in Work in threads its own fix in its thread, or a new worker's when it has none; and Address, which gives the feedback on
 * the Your turn PRs you selected to one new batch thread, or to each PR's own thread. None is ever part of Advance: only you release a
 * hold, and only you ask a thread for work.
 */
export const DECK_WRITES = [...BATCH_KINDS, "release", "ask", "fix", "address"] as const;
export type DeckWrite = (typeof DECK_WRITES)[number];
/** What a row can say you did: a deck write, or a confirmation of its review notes, which only that PR's own confirm records. */
export const ACTED_KINDS = [...DECK_WRITES, "confirm"] as const;
export type ActedKind = (typeof ACTED_KINDS)[number];
/** How long a confirmed batch waits for Undo before it sends anything. */
export const SEND_DELAY_MS = 8_000;

/**
 * What you last did to a row, from the deck or its inventory row: a write waiting out its Undo window or running, sent, refused, or cut
 * off by a restart mid-send. `batchId` names the deck batch it belongs to, which Undo cancels while it waits.
 */
export type RowActed = { kind: ActedKind; state: "queued" | "sending" | "sent" | "refused" | "unknown"; at: number; batchId: string | null };
/** How long a write you made marks its row. An older one is history, so the row counts again whether or not you marked it seen. */
export const ACTED_MS = 86_400_000;

/**
 * A row you acted on dims and stops counting while its write waits or runs, and after it lands until you mark it seen at or after that
 * time: `seenAt`, which the view keeps. A refusal, or a send a restart cut off, leaves the move yours.
 */
export function counted(row: { acted: RowActed | null }, seenAt = Number.NEGATIVE_INFINITY): boolean {
  const { acted } = row;
  if (!acted || acted.state === "refused" || acted.state === "unknown") return true;
  return acted.state === "sent" && acted.at <= seenAt;
}

/** A section whose move is yours. */
export const yours = (section: DeckSection): boolean => YOURS.has(section);

/** Needs you: an open PR on an active card (an effort, One-offs, or a service card) whose next move is yours. Held and done efforts pause. */
export function needsYou(row: { section: DeckSection; acted: RowActed | null }, pile: DeckPile, seenAt?: number): boolean {
  return pile === "active" && yours(row.section) && counted(row, seenAt);
}
