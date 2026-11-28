import { isSingleCharacter } from "./keys";

export type ListCommand =
  | "previous"
  | "next"
  | "page-up"
  | "page-down"
  | "first"
  | "last"
  | "choose"
  | "leave";

// The keys of tmux's chooser lists (mode-tree.c in tmux 3.5a), which are the
// same whatever mode-keys says and cannot be bound to anything else.
export const LIST_COMMAND_KEYS: Record<ListCommand, readonly string[]> = {
  previous: ["ArrowUp", "k", "C-p"],
  next: ["ArrowDown", "j", "C-n"],
  "page-up": ["PageUp", "C-b"],
  "page-down": ["PageDown", "C-f"],
  first: ["g", "Home"],
  last: ["G", "End"],
  choose: ["Enter"],
  leave: ["q", "Escape", "C-g"],
};

export const LIST_COMMANDS = Object.keys(LIST_COMMAND_KEYS) as ListCommand[];

export const LIST_KEYS: ReadonlyMap<string, ListCommand> = new Map(
  LIST_COMMANDS.flatMap((command) =>
    LIST_COMMAND_KEYS[command].map((key): [string, ListCommand] => [
      key,
      command,
    ]),
  ),
);

// The key of a list command that is the shortest to name in a hint.
export function shortListKey(command: ListCommand): string {
  const keys = LIST_COMMAND_KEYS[command];
  return keys.find(isSingleCharacter) ?? keys[0];
}
