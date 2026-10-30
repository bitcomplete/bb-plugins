// The thread effort popover's model (plan amendment A17.2): pure functions
// from the context's picker read, what you typed, and where the highlight is
// to the list the popover draws and what each of its keys does. Nothing here
// writes: a pick is one explicit click or ↵, and the control applies it with
// an Undo. It imports types and zero-import modules only, so no server module
// reaches the browser (A12.1).
import type { ThreadEffortPicker } from "./thread-effort";
import type { PickerActionId } from "./deck-keys";

/** How many suggested efforts lead the list. */
export const MAX_SUGGESTED = 3;
/** How many PRs the link list shows; typing narrows it. */
export const MAX_PRS = 50;

type Choice = ThreadEffortPicker["choices"][number];
export type PickerItem =
  | ({ kind: "effort"; suggested: boolean; current: boolean } & Choice)
  /** Create an effort from the typed name; an empty name asks for one. */
  | { kind: "new"; name: string }
  /** Ask Jev for suggestions, only on request. */
  | { kind: "jev"; busy: boolean }
  | { kind: "remove"; name: string }
  | { kind: "pr"; url: string; label: string; current: boolean };
export type PickerMode = "effort" | "link";
/** What Jev said when asked: the efforts it matched, and a new effort's name drawn from the thread. */
export type JevAnswer = { state: "idle" | "asking" | "done"; keys: readonly string[]; name: string | null };

const norm = (text: string) => text.trim().replace(/\s+/gu, " ").toLocaleLowerCase();

/**
 * The list, top to bottom. Efforts: up to three suggested ones (not the thread's own) strongest first with their signal, Jev's matches
 * after them, then every other effort by name, all narrowed by what you typed; then "+ New effort" from the typed name, then Remove.
 * PRs: the tracked PRs to link, narrowed the same way.
 */
export function pickerItems(input: { picker: Pick<ThreadEffortPicker, "choices" | "jev">; currentKey: string | null; query: string; mode: PickerMode;
  linkable: readonly { url: string; label: string }[]; linkedUrl: string | null; jev: JevAnswer }): PickerItem[] {
  const query = norm(input.query);
  const match = (text: string) => !query || norm(text).includes(query);
  if (input.mode === "link") return input.linkable.filter((pr) => match(`${pr.label} ${pr.url}`)).slice(0, MAX_PRS)
    .map((pr) => ({ kind: "pr", url: pr.url, label: pr.label, current: pr.url === input.linkedUrl }));
  const { choices } = input.picker;
  const jev = new Set(input.jev.keys);
  const byName = (a: Choice, b: Choice) => a.name.localeCompare(b.name);
  const suggested = [
    ...choices.filter((choice) => choice.score > 0 && choice.key !== input.currentKey).sort((a, b) => b.score - a.score || byName(a, b)),
    ...choices.filter((choice) => choice.score === 0 && jev.has(choice.key) && choice.key !== input.currentKey).sort(byName)
      .map((choice) => ({ ...choice, signal: "Jev: strong match" })),
  ].slice(0, MAX_SUGGESTED);
  const lead = new Set(suggested.map((choice) => choice.key));
  const item = (choice: Choice, isSuggested: boolean): PickerItem => ({ kind: "effort", ...choice, suggested: isSuggested, current: choice.key === input.currentKey });
  const items: PickerItem[] = [
    ...input.picker.jev && input.jev.state !== "done" && !suggested.length && !query ? [{ kind: "jev" as const, busy: input.jev.state === "asking" }] : [],
    ...suggested.filter((choice) => match(choice.name)).map((choice) => item(choice, true)),
    ...choices.filter((choice) => !lead.has(choice.key) && match(choice.name)).sort(byName).map((choice) => item(choice, false)),
  ];
  const exact = choices.some((choice) => norm(choice.name) === query);
  if (!exact) items.push({ kind: "new", name: query ? input.query.trim().replace(/\s+/gu, " ") : input.jev.name ?? "" });
  const current = choices.find((choice) => choice.key === input.currentKey);
  if (input.currentKey !== null) items.push({ kind: "remove", name: current?.name ?? "this effort" });
  return items;
}

/** Where the highlight starts: nowhere, so ↵ on opening picks nothing, and on the first match once you type. */
export const startHighlight = (query: string) => query.trim() ? 0 : -1;

/**
 * What a popover key does, given the list and the highlight: move it (↑ from the top leaves the list, back to the field), pick the
 * highlighted item, or back out of the PR list, then close.
 */
export function pickerStep(action: PickerActionId, state: { highlight: number; count: number; mode: PickerMode }):
  { highlight: number } | { pick: number } | { mode: "effort" } | { close: true } | null {
  switch (action) {
    case "pick-next": return state.count ? { highlight: Math.min(state.highlight + 1, state.count - 1) } : null;
    case "pick-prev": return { highlight: Math.max(state.highlight - 1, -1) };
    case "pick": return state.highlight >= 0 && state.highlight < state.count ? { pick: state.highlight } : null;
    case "pick-back": return state.mode === "link" ? { mode: "effort" } : { close: true };
  }
}

/** What the Undo toast says a pick did. */
/** The confirm a move that takes more than its PR asks first: everything else it takes, listed. */
export function moveAlsoText(pr: { ref: string; also: readonly string[] }): string {
  const list = pr.also.length < 2 ? pr.also.join("") : `${pr.also.slice(0, -1).join(", ")} and ${pr.also.at(-1)}`;
  return `${pr.ref} also moves ${list}.`;
}

export function pickedText(change: { kind: "set" | "create"; name: string } | { kind: "remove"; name: string } | { kind: "link"; ref: string }
  | { kind: "move"; ref: string; name: string }): string {
  switch (change.kind) {
    case "set": return `In ${change.name}`;
    case "create": return `Created ${change.name}`;
    case "remove": return `Out of ${change.name}`;
    case "link": return `Linked ${change.ref}`;
    case "move": return `Moved ${change.ref} to ${change.name}`;
  }
}
