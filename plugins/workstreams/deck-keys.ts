// The one key registry the effort deck and All PRs share (plan amendment
// A15): every action with its key, which the key handler, the hint bar, the
// ? sheet, and the ⌘K palette all read, so a key means the same thing
// everywhere. This module imports nothing, so the browser bundle can use it
// without reaching a server module (A12.1).
//
// Safety lives in each action's effect. Only "confirm" and "preview" actions
// can lead to a GitHub write, and neither writes on its key: a confirm opens
// the listing of every PR it would touch, which then waits out its Undo
// window, and a preview opens the fresh merge preview, where only a click or
// ⌘↵ merges. Enter and Space are never bound to either. Release lifts your
// holds through the same listing and window, though it writes nothing to GitHub.
// c opens one PR's review notes, where confirming them handled is a click, or
// ⌘↵ only when something since the approval shows them handled. f asks each
// PR's thread for its fix through the same listing and window; it never merges.
// b takes the selected Your turn PRs to one batch thread, or each to its own
// thread, through the same listing and window; it never merges either.

export const KEY_GROUPS = ["Deck", "Card", "Act", "Rows", "Sort", "Anywhere"] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number];
/**
 * What pressing the key does: move around, change only what the view shows, open a dialog, open a listing confirm for a batch write,
 * start a batch at once into its Undo window (Address selected's one thread), or open the fresh merge preview.
 */
export type KeyEffect = "nav" | "local" | "dialog" | "confirm" | "start" | "preview";
export type DeckActionId = "next" | "prev" | "jump" | "services" | "view" | "seen" | "hold-pile" | "done-pile" | "advance" | "hold" | "complete"
  | "held" | "progress" | "notes" | "merge" | "confirm" | "nudge" | "request" | "ready" | "release" | "fix" | "address" | "move" | "undo" | "hold-pr" | "revoke" | "refresh" | "row-next" | "row-prev" | "select"
  | "select-section" | "expand" | "clear" | "open-thread" | "open-pr" | "accept" | "one-off" | "new-effort" | "promote" | "rule" | "seed" | "palette" | "help";
/** Keys as they read on a kbd: "]" and "→" are the same key, "1–9" names nine, and "⇧H" is Shift with h. */
export type DeckAction = { id: DeckActionId; group: KeyGroup; title: string; keys: readonly string[]; effect: KeyEffect };

export const DECK_ACTIONS: readonly DeckAction[] = [
  { id: "next", group: "Deck", title: "Next effort", keys: ["]", "→"], effect: "nav" },
  { id: "prev", group: "Deck", title: "Previous effort", keys: ["[", "←"], effect: "nav" },
  { id: "jump", group: "Deck", title: "Go to effort by number", keys: ["1–9"], effect: "nav" },
  { id: "services", group: "Deck", title: "Service cards", keys: ["u"], effect: "nav" },
  { id: "view", group: "Deck", title: "Switch Efforts and All PRs", keys: ["v"], effect: "nav" },
  { id: "seen", group: "Deck", title: "Mark seen here", keys: ["s"], effect: "local" },
  { id: "hold-pile", group: "Deck", title: "Show the On hold pile", keys: [], effect: "dialog" },
  { id: "done-pile", group: "Deck", title: "Show the Done pile", keys: [], effect: "dialog" },
  { id: "advance", group: "Card", title: "Advance the chores…", keys: ["a"], effect: "confirm" },
  { id: "hold", group: "Card", title: "Hold the effort…", keys: ["h"], effect: "dialog" },
  { id: "complete", group: "Card", title: "Complete the effort…", keys: [], effect: "dialog" },
  { id: "held", group: "Card", title: "Show held PRs", keys: ["⇧H"], effect: "local" },
  { id: "progress", group: "Card", title: "Show or hide where the effort stands", keys: ["p"], effect: "local" },
  { id: "notes", group: "Card", title: "Edit the effort's notes", keys: ["⇧N"], effect: "local" },
  { id: "merge", group: "Act", title: "Preview merge…", keys: ["m"], effect: "preview" },
  { id: "confirm", group: "Act", title: "Confirm review notes…", keys: ["c"], effect: "dialog" },
  { id: "nudge", group: "Act", title: "Nudge reviewers…", keys: ["n"], effect: "confirm" },
  { id: "request", group: "Act", title: "Request a reviewer…", keys: ["r"], effect: "confirm" },
  { id: "ready", group: "Act", title: "Mark ready…", keys: ["y"], effect: "confirm" },
  { id: "release", group: "Act", title: "Release the hold…", keys: ["l"], effect: "confirm" },
  { id: "fix", group: "Act", title: "Ask threads to fix…", keys: ["f"], effect: "confirm" },
  { id: "address", group: "Act", title: "Address selected", keys: ["b"], effect: "start" },
  { id: "undo", group: "Act", title: "Undo the last action", keys: ["z"], effect: "local" },
  { id: "hold-pr", group: "Act", title: "Hold or release the PR…", keys: [], effect: "dialog" },
  { id: "revoke", group: "Act", title: "Revoke your notes confirmation", keys: [], effect: "local" },
  { id: "refresh", group: "Act", title: "Refresh from GitHub", keys: ["g"], effect: "local" },
  { id: "row-next", group: "Rows", title: "Next row", keys: ["j", "↓"], effect: "nav" },
  { id: "row-prev", group: "Rows", title: "Previous row", keys: ["k", "↑"], effect: "nav" },
  { id: "select", group: "Rows", title: "Select or unselect the row", keys: ["x"], effect: "local" },
  { id: "select-section", group: "Rows", title: "Select every Your turn row", keys: ["⇧X"], effect: "local" },
  { id: "expand", group: "Rows", title: "Show or hide the move's rows", keys: ["↵"], effect: "local" },
  { id: "clear", group: "Rows", title: "Clear the selection", keys: ["esc"], effect: "local" },
  { id: "open-thread", group: "Rows", title: "Open the row's thread", keys: ["o"], effect: "nav" },
  { id: "open-pr", group: "Rows", title: "Open the PR on GitHub", keys: [], effect: "nav" },
  { id: "accept", group: "Sort", title: "Accept the suggestion", keys: ["⇧A"], effect: "local" },
  { id: "move", group: "Sort", title: "Move to an effort…", keys: ["e"], effect: "dialog" },
  { id: "one-off", group: "Sort", title: "Move to One-offs", keys: [], effect: "local" },
  { id: "new-effort", group: "Sort", title: "New effort from the selection…", keys: [], effect: "dialog" },
  { id: "promote", group: "Sort", title: "Promote to an effort…", keys: [], effect: "dialog" },
  { id: "rule", group: "Sort", title: "Standing rules…", keys: [], effect: "dialog" },
  { id: "seed", group: "Sort", title: "Seed efforts from Linear…", keys: [], effect: "dialog" },
  { id: "palette", group: "Anywhere", title: "All actions", keys: ["⌘K"], effect: "dialog" },
  { id: "help", group: "Anywhere", title: "Keys and colors", keys: ["?"], effect: "dialog" },
];
export const ACTION: Readonly<Record<DeckActionId, DeckAction>> = Object.fromEntries(DECK_ACTIONS.map((action) => [action.id, action])) as never;

/** What a key event's key reads as on a kbd. */
const TOKEN: Record<string, string> = { ArrowRight: "→", ArrowLeft: "←", ArrowDown: "↓", ArrowUp: "↑", Enter: "↵", Escape: "esc" };
/** Only row movement repeats while the key is held; every other key fires once per press. */
const REPEATS = new Set(["row-next", "row-prev"]);

/**
 * The action a plain key press runs, and the effort number for 1–9. A key with ⌘, Ctrl, or Alt is never an action here except ⌘K, and
 * a held key repeats row movement only.
 */
export function actionForKey(event: { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; repeat?: boolean }):
  { id: DeckActionId; n?: number } | null {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") return { id: "palette" };
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (/^[1-9]$/u.test(event.key)) return event.repeat ? null : { id: "jump", n: Number(event.key) };
  const token = event.shiftKey && /^[A-Z]$/u.test(event.key) ? `⇧${event.key}` : TOKEN[event.key] ?? event.key;
  const action = DECK_ACTIONS.find((candidate) => candidate.keys.includes(token));
  return action && (!event.repeat || REPEATS.has(action.id)) ? { id: action.id } : null;
}

/**
 * Typing in a field is never an action, except Escape, which leaves it, and ⌘K. A checkbox or radio takes no text: a click focuses a row's
 * selection box, and b, x, and esc still act from it.
 */
export function typingTarget(target: unknown): boolean {
  const element = target as { isContentEditable?: boolean; closest?: (selector: string) => unknown } | null;
  return !!element && (element.isContentEditable === true
    || !!element.closest?.("input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]"));
}

/**
 * The thread effort popover's keys (plan amendment A17.2), from the same registry: its list moves as rows do, ↵ picks as it opens a row,
 * and esc backs out of the PR list, then closes. You type in its field, so no letter is bound.
 */
export type PickerActionId = "pick-next" | "pick-prev" | "pick" | "pick-back";
export const PICKER_ACTIONS: readonly { id: PickerActionId; title: string; keys: readonly string[] }[] = [
  { id: "pick-next", title: "Next choice", keys: ["↓"] },
  { id: "pick-prev", title: "Previous choice", keys: ["↑"] },
  { id: "pick", title: "Pick it", keys: ["↵"] },
  { id: "pick-back", title: "Back, or close", keys: ["esc"] },
];

/** The popover action a key runs: never with ⌘, Ctrl, or Alt, and only the list's movement repeats while held, so a held ↵ picks once. */
export function pickerActionForKey(event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean }):
  PickerActionId | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  const token = TOKEN[event.key];
  const action = token ? PICKER_ACTIONS.find((candidate) => candidate.keys.includes(token)) : undefined;
  return action && (!event.repeat || action.id === "pick-next" || action.id === "pick-prev") ? action.id : null;
}

/** PR mutations and selection live in All PRs; cards expose states and navigation. */
export const PR_VIEW_ACTIONS = new Set<DeckActionId>(["advance", "merge", "confirm", "nudge", "request", "ready", "release", "fix", "address", "hold-pr", "revoke", "refresh", "select", "select-section", "expand", "accept", "move", "one-off", "new-effort"]);
