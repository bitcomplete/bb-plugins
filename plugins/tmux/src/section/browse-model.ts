import type {
  FolderEntry,
  FolderFailure,
  FolderListing,
} from "../folder-listing";

export type ListedFolder = Extract<FolderListing, { ok: true }>;

type ListMove =
  | "next"
  | "previous"
  | "first"
  | "last"
  | "page-down"
  | "page-up";

// The home folder of the user the bb server runs as, as the server reads it.
export const HOME_PATH = "~";

const POSIX_SEPARATOR = "/";
const WINDOWS_SEPARATOR = "\\";

export const FAILURE_TEXTS: Record<FolderFailure, string> = {
  "not-absolute":
    "Write the full path of a folder, or start it with ~ for your home folder on the machine that runs the bb server.",
  missing: "There is no folder at this path.",
  "is-a-file":
    "The folder of this file could not be listed. The file itself can still be chosen.",
  "not-a-folder":
    "This path leads to no folder, and to no file that can be chosen.",
  unreadable: "The bb server may not read this folder.",
};

export const NO_LISTING_TEXT =
  "The folder could not be listed, because the server part of the plugin did not answer.";
export const LISTING_TEXT = "Listing the folder.";

const NOTHING_LISTED_TEXT = "There are no folders or files in this folder.";
const REACH_BY_PATH_TEXT =
  "To reach an entry that is not listed, type or paste its path into the path box.";
// The server stops looking after a number of entries, and what it leaves
// out counts among them: a cut list can hold nothing.
const NOTHING_FOUND_TEXT = `No folders or files are listed. This folder holds more: the list was cut before a folder or a file was found. ${REACH_BY_PATH_TEXT}`;

// The keys of a list as a browser and a screen reader know them. The keys of
// tmux's lists are left out on purpose: no key of the plugin acts in this
// dialog.
export const LIST_MOVES: ReadonlyMap<string, ListMove> = new Map([
  ["ArrowDown", "next"],
  ["ArrowUp", "previous"],
  ["Home", "first"],
  ["End", "last"],
  ["PageDown", "page-down"],
  ["PageUp", "page-up"],
]);

// The server names a folder by its full path in the notation of its own
// system. A path of Windows starts with a drive letter or with two
// backslashes, and never with a slash.
export function childPath(folder: string, name: string): string {
  const separator = folder.startsWith(POSIX_SEPARATOR)
    ? POSIX_SEPARATOR
    : WINDOWS_SEPARATOR;
  return folder.endsWith(separator) ? folder + name : folder + separator + name;
}

// The name of the entry with this full path, null when the folder lists none.
export function entryNameAt(
  listing: ListedFolder,
  path: string | null,
): string | null {
  if (path === null) return null;
  const entry = listing.entries.find(
    ({ name }) => childPath(listing.path, name) === path,
  );
  return entry?.name ?? null;
}

function counted(count: number, one: string): string {
  if (count === 0) return `no ${one}s`;
  return count === 1 ? `1 ${one}` : `${count} ${one}s`;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function countOf(entries: readonly FolderEntry[], kind: FolderEntry["kind"]): number {
  return entries.filter((entry) => entry.kind === kind).length;
}

// What the list holds, in words, for the line under the path box. A screen
// reader reads it whenever another folder is listed.
export function describeListing({ entries, truncated }: ListedFolder): string {
  if (entries.length === 0) return truncated ? NOTHING_FOUND_TEXT : NOTHING_LISTED_TEXT;
  const held = capitalised(
    `${counted(countOf(entries, "folder"), "folder")} and ${counted(countOf(entries, "file"), "file")}`,
  );
  if (!truncated) return `${held}.`;
  return `${held} are listed. This folder holds more: the list was cut after its first ${entries.length} entries. ${REACH_BY_PATH_TEXT}`;
}

// Where a key takes the highlight. index is null while no row is
// highlighted. A step stops at the first and at the last row.
export function movedIndex(
  move: ListMove,
  index: number | null,
  count: number,
  pageRows: number,
): number | null {
  if (count === 0) return null;
  if (move === "first") return 0;
  if (move === "last") return count - 1;
  const isForward = move === "next" || move === "page-down";
  if (index === null) return isForward ? 0 : count - 1;
  const isPage = move === "page-down" || move === "page-up";
  const rows = isPage ? pageRows : 1;
  const target = isForward ? index + rows : index - rows;
  return Math.min(count - 1, Math.max(0, target));
}
