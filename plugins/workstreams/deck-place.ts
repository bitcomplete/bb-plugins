// Keeping your place in the effort deck (plan amendment A15 and
// design-directions/inventory-calm/PLACE-LOSS.md). Pure: the deck's nav view
// feeds it the DOM measurements and storage it reads.
//
// - What changed since you looked. Each view keeps a snapshot of its rows as
//   you last marked them seen, against which a read's rows changed, arrived,
//   or left; only Mark seen, for that view alone, settles them. The rows
//   themselves follow the read.
// - The card order is set once per session: new, resumed, and reopened
//   efforts join the end of the efforts, before the service cards, so an
//   effort's number key never shifts.
// - Scroll anchors hold a row at its pixel through reads, resizes, and flips,
//   with a spacer above the view when that would need a negative scroll.
// - Focus falls back through one chain and never lands on the page body.
import { ACTED_MS, cardTier } from "./deck-shared";

/** A row as you last marked it seen, or as it was when it arrived since then (`arrived`). */
export type SettledRow = { prUrl: string; ref: string; title: string; section: string; status: string; arrived?: true };
/** A row as a view draws it: where it settled, what changed since, or that it left. */
export type Shown<T> = {
  prUrl: string;
  /** The section it's drawn in: where you last saw it, or its own when it's new. */
  section: string;
  row: T | null; settled: SettledRow | null;
  /** Its section or status moved since you looked. */
  change: { was: string; now: string } | null;
  /** It left this view since you looked. */
  ghost: boolean;
  /** It joined this view since you looked. */
  arrived: boolean;
};

/**
 * Each current row in the section it settled in, then each row that left as a ghost where it was, then new rows, grouped by `sections`
 * (sections not named there follow, in the order they first appear). Within a section, rows keep the order you last saw them in.
 * Without a snapshot, every row is where it is and nothing is news.
 */
export function settleRows<T extends { prUrl: string; section: string; status: string }>(snapshot: readonly SettledRow[] | undefined, rows: readonly T[],
  sections: readonly string[] = []): Shown<T>[] {
  const live = new Map(rows.map((row) => [row.prUrl, row]));
  const shown: Shown<T>[] = [];
  for (const settled of snapshot ?? []) {
    const row = live.get(settled.prUrl) ?? null;
    live.delete(settled.prUrl);
    const moved = row !== null && (row.section !== settled.section || row.status !== settled.status);
    shown.push({ prUrl: settled.prUrl, section: settled.section, row, settled, ghost: row === null, arrived: settled.arrived === true,
      change: moved ? { was: settled.status, now: row!.status } : null });
  }
  for (const row of live.values()) shown.push({ prUrl: row.prUrl, section: row.section, row, settled: null, change: null, ghost: false, arrived: snapshot !== undefined });
  const order = [...sections, ...new Set(shown.map((item) => item.section).filter((section) => !sections.includes(section)))];
  return shown.map((item, index) => ({ item, index })).sort((a, b) => order.indexOf(a.item.section) - order.indexOf(b.item.section) || a.index - b.index)
    .map(({ item }) => item);
}

/** What Mark seen keeps: every current row as it is now. */
export const snapshotOf = (rows: readonly SettledRow[]): SettledRow[] => rows.map(({ prUrl, ref, title, section, status }) => ({ prUrl, ref, title, section, status }));

/**
 * A view's snapshot with each row that arrived since, as it arrived and marked new, so a read never takes a row out from under you: one
 * you saw arrive keeps its place, and stays as a ghost if it leaves again, until Mark seen. Null when nothing arrived.
 */
export function withArrivals(snapshot: readonly SettledRow[], rows: readonly SettledRow[]): SettledRow[] | null {
  const known = new Set(snapshot.map((row) => row.prUrl));
  const fresh = snapshotOf(rows.filter((row) => !known.has(row.prUrl)));
  return fresh.length ? [...snapshot, ...fresh.map((row) => ({ ...row, arrived: true as const }))] : null;
}

/**
 * The session's card order: the ones still here where they were, then new ones, in the order given, each at the end of its tier: efforts,
 * then service cards, then Loose threads.
 */
export function keepOrder(previous: readonly string[], ids: readonly string[]): string[] {
  const here = new Set(ids);
  const kept = previous.filter((id) => here.has(id));
  return [...kept, ...ids.filter((id) => !kept.includes(id))].sort((a, b) => cardTier(a) - cardTier(b));
}

/**
 * The card to show when the one you were on left the pile, as an emptied service card does once you mark it seen: the next card after it
 * in the order you last saw, else the one before it, else the first. Null with no card at all.
 */
export function landAfter(previous: readonly string[], cur: string | null, ids: readonly string[]): string | null {
  if (cur && ids.includes(cur)) return cur;
  const at = cur ? previous.indexOf(cur) : -1;
  return (at < 0 ? undefined : previous.slice(at + 1).find((id) => ids.includes(id)) ?? previous.slice(0, at).reverse().find((id) => ids.includes(id)))
    ?? ids[0] ?? null;
}

/**
 * Overview joins the flip ring without taking an effort's number key. Before the first read there's no ring (`order` null), so the card
 * the session was on waits for the read rather than landing on Overview.
 */
export const deckRing = (order: readonly string[] | null): string[] => order ? ["overview", ...order] : [];
export const numberedEffort = (order: readonly string[], n: number): string | null => n >= 1 && n <= 9 ? order[n - 1] ?? null : null;

/**
 * The scroll that puts an element `want` pixels below the viewport's top, now that it sits `at` pixels below it. A negative scroll grows
 * the spacer above the view instead, and a spacer shrinks before the scroll does, so the content never jumps.
 */
export function anchorScroll(input: { scrollTop: number; slack: number; at: number; want: number }): { scrollTop: number; slack: number } {
  let scrollTop = input.scrollTop + input.at - input.want;
  let slack = input.slack;
  if (scrollTop < 0) { slack -= scrollTop; scrollTop = 0; }
  else if (slack > 0) { const cut = Math.min(slack, scrollTop); slack -= cut; scrollTop -= cut; }
  return { scrollTop: Math.round(scrollTop), slack: Math.round(slack) };
}
/** Once you scroll past the spacer, it melts away without moving what you see. */
export function meltSlack(input: { scrollTop: number; slack: number }): { scrollTop: number; slack: number } {
  return input.slack > 0 && input.scrollTop >= input.slack ? { scrollTop: input.scrollTop - input.slack, slack: 0 } : input;
}

/** What held your place: a row, or the card's top, and how far below the viewport's top it sat. */
export type Anchor = { row: string; at: number } | { card: true; at: number };
/** Where focus was: a control by its `data-deck-focus` id, and the row and move it sat in. */
export type FocusKey = { id?: string; row?: string; section?: string };
/** What the view can find, for focusFallback. */
export type FocusDom<E> = { byId(id: string): E | null; row(key: string): E | null; nextLiveRow(section: string): E | null;
  firstLiveRow(): E | null; heading(): E | null; live(element: E): boolean };

/**
 * The one focus rule after an action or a dialog: the same control while it's still live; else its row; else the next live row from its
 * section on; else the first live row in view; else the card's heading. Never the page body.
 */
export function focusFallback<E>(key: FocusKey, dom: FocusDom<E>): E | null {
  const same = key.id ? dom.byId(key.id) : null;
  if (same && dom.live(same)) return same;
  return (key.row ? dom.row(key.row) : null) ?? (key.section ? dom.nextLiveRow(key.section) : null) ?? dom.firstLiveRow() ?? dom.heading();
}

/**
 * Each view's place, which the session keeps: the deck's current card and the view you were in, and per view what you had open. `focus` and
 * an anchor's `row` name a row as All PRs does, "owner/repo#N". `unpicked`: the Address move's rows you unticked. `open`: the moves and
 * chores whose rows you opened or folded, and "progress" while the finish line's answers show. `panel`: the footer toggle that's open.
 */
export type ViewPlace = { anchor: Anchor | null; scrollTop: number; focus: string | null; unpicked: string[]; open: string[]; panel: string | null };
export type Place = { view: "deck" | "prs"; cur: string | null; order: string[]; views: Record<string, ViewPlace> };
export const EMPTY_VIEW: ViewPlace = { anchor: null, scrollTop: 0, focus: null, unpicked: [], open: [], panel: null };
export const PLACE_KEY = "bb-workstreams:deck-place";
/** What each view last marked seen, and when you last marked each PR's row seen, which outlast the session. */
export const SEEN_KEY = "bb-workstreams:deck-seen";
export type Seen = { rows: Record<string, SettledRow[]>; at: Record<string, number> };

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 500) : [];
const anchorOf = (value: unknown): Anchor | null => {
  const item = value as { row?: unknown; card?: unknown; at?: unknown } | null;
  if (!item || typeof item.at !== "number") return null;
  return typeof item.row === "string" ? { row: item.row, at: item.at } : item.card === true ? { card: true, at: item.at } : null;
};

/** A stored place, with anything missing or malformed dropped rather than trusted. */
export function readPlace(raw: string | null): Place {
  let value: Partial<Record<keyof Place, unknown>> = {};
  try { value = raw ? JSON.parse(raw) as typeof value : {}; } catch { /* A broken entry starts fresh. */ }
  const views: Record<string, ViewPlace> = {};
  for (const [key, item] of Object.entries(typeof value.views === "object" && value.views ? value.views as Record<string, Record<string, unknown>> : {})) {
    if (!item || typeof item !== "object") continue;
    views[key] = { anchor: anchorOf(item.anchor), scrollTop: typeof item.scrollTop === "number" ? item.scrollTop : 0, focus: typeof item.focus === "string" ? item.focus : null,
      unpicked: strings(item.unpicked), open: strings(item.open), panel: typeof item.panel === "string" ? item.panel : null };
  }
  return { view: value.view === "prs" ? "prs" : "deck", cur: typeof value.cur === "string" ? value.cur : null, order: strings(value.order), views };
}

/** Stored seen marks: marks older than a write's day are history, so they go (see deck-shared.ts's counted()). */
export function readSeen(raw: string | null, now: number): Seen {
  let value: Partial<Seen> = {};
  try { value = raw ? JSON.parse(raw) as Partial<Seen> : {}; } catch { /* A broken entry starts fresh. */ }
  const rows: Seen["rows"] = {};
  for (const [key, list] of Object.entries(value.rows ?? {})) if (Array.isArray(list)) rows[key] = list.filter((row): row is SettledRow =>
    !!row && typeof row.prUrl === "string" && typeof row.section === "string" && typeof row.status === "string" && typeof row.ref === "string" && typeof row.title === "string");
  const at = Object.fromEntries(Object.entries(value.at ?? {}).filter(([, when]) => typeof when === "number" && now - when < ACTED_MS));
  return { rows, at };
}
