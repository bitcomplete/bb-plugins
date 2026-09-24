// The thread menu's behaviour, kept pure so it is tested without a browser.
// Hover opens it and a short delay closes it, so the pointer can travel from
// the dot into the menu; a click pins it open; Escape or an outside click
// closes it whether pinned or not.

export type MenuState = { open: boolean; pinned: boolean };

export type MenuEvent =
  /** Pointer entered the dot or the menu. */
  | "hover"
  /** The close delay after the pointer left both ran out. */
  | "hover-timeout"
  /** The dot was clicked (or Enter / Space on it). */
  | "click"
  /** Escape, an outside click, or an entry was chosen. */
  | "dismiss";

export const CLOSED: MenuState = { open: false, pinned: false };

/** How long the menu survives the pointer leaving, in ms: enough to cross the gap. */
export const HOVER_CLOSE_MS = 180;

export function menuReducer(state: MenuState, event: MenuEvent): MenuState {
  switch (event) {
    case "hover":
      return state.open ? state : { open: true, pinned: false };
    case "hover-timeout":
      return state.pinned ? state : CLOSED;
    case "click":
      // A click on an open, pinned menu is the way to close it from the dot.
      return state.open && state.pinned ? CLOSED : { open: true, pinned: true };
    case "dismiss":
      return CLOSED;
  }
}

/** Arrow and Home/End movement over `count` entries; null for any other key. */
export function nextIndex(current: number, key: string, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** The most the menu lists; the rest are "+N more", which flies to the full list on the Map. */
export const THREAD_MENU_MAX = 5;

export function menuEntries<T>(threads: readonly T[], max = THREAD_MENU_MAX): { shown: T[]; more: number } {
  return { shown: threads.slice(0, max), more: Math.max(0, threads.length - max) };
}

/** The dot's label, closed: how many threads, and what a click does. */
export function threadDotLabel(count: number): string {
  return `${count} ${count === 1 ? "thread" : "threads"} · click to open`;
}
