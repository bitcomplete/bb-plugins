import type { Dirent } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { absolutePathOf } from "./home-path";

type FolderEntryKind = "folder" | "file";

export interface FolderEntry {
  name: string;
  kind: FolderEntryKind;
}

// not-absolute: the path is no full path, or it starts with ~ and the home
// directory is not known. missing: nothing is at the path. is-a-file: a
// regular file is, which the page can offer as the config file.
// not-a-folder: something else is, such as a FIFO or a device. unreadable:
// the bb server may not read the folder.
export type FolderFailure =
  | "not-absolute"
  | "missing"
  | "is-a-file"
  | "not-a-folder"
  | "unreadable";

// path is the full path that was looked at, also when it could not be
// listed, and parent the folder that holds it, null at the top. Both are
// null for a path that is not absolute.
export type FolderListing =
  | {
      ok: true;
      path: string;
      parent: string | null;
      entries: FolderEntry[];
      truncated: boolean;
    }
  | {
      ok: false;
      reason: FolderFailure;
      path: string | null;
      parent: string | null;
    };

// entries: how many entries a listing holds at most. scanned: how many
// entries of a folder are looked at, so that a folder with millions of them
// is not read to its end.
interface FolderLimits {
  entries: number;
  scanned: number;
}

export const FOLDER_LIMITS: FolderLimits = { entries: 2000, scanned: 20000 };

interface ScannedFolder {
  entries: FolderEntry[];
  hasMore: boolean;
}

const MISSING_ERRORS: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "ERR_INVALID_ARG_VALUE",
]);

// The same order on every server, whatever its locale: digits by their
// value, and capitals next to their small letters.
const BY_NAME = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function failureOf(error: unknown): FolderFailure {
  const code = (error as { code?: unknown } | null)?.code;
  const isMissing = typeof code === "string" && MISSING_ERRORS.has(code);
  return isMissing ? "missing" : "unreadable";
}

function parentOf(path: string): string | null {
  const parent = dirname(path);
  return parent === path ? null : parent;
}

// A symbolic link counts as what it points to. stat follows the link and
// opens nothing, so a link to a FIFO or a device cannot make the call wait.
// null for what is neither a folder nor a regular file, and for a link that
// points nowhere or in a circle.
async function kindOf(
  folder: string,
  entry: Dirent,
): Promise<FolderEntryKind | null> {
  if (entry.isDirectory()) return "folder";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return null;
  try {
    const target = await stat(join(folder, entry.name));
    if (target.isDirectory()) return "folder";
    return target.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

async function scanFolder(
  folder: string,
  maxScanned: number,
): Promise<ScannedFolder> {
  const entries: FolderEntry[] = [];
  let scanned = 0;
  for await (const entry of await opendir(folder)) {
    if (scanned === maxScanned) return { entries, hasMore: true };
    scanned += 1;
    const kind = await kindOf(folder, entry);
    if (kind !== null) entries.push({ name: entry.name, kind });
  }
  return { entries, hasMore: false };
}

function compareNames(a: string, b: string): number {
  const order = BY_NAME.compare(a, b);
  if (order !== 0) return order;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareEntries(a: FolderEntry, b: FolderEntry): number {
  if (a.kind === b.kind) return compareNames(a.name, b.name);
  return a.kind === "folder" ? -1 : 1;
}

// The folders and the regular files of one folder of the machine that the bb
// server runs on, hidden ones included: folders first, each group by name.
// It reads the names and the kinds only, never what a file holds, and it
// starts no process. A folder that cannot be listed is an answer and not an
// error. The path is taken as it is given: a name can end in a blank.
export async function listFolder(
  path: string,
  homeDir: string | null,
  limits: FolderLimits = FOLDER_LIMITS,
): Promise<FolderListing> {
  const absolute = absolutePathOf(path, homeDir);
  if (absolute === null) {
    return { ok: false, reason: "not-absolute", path: null, parent: null };
  }
  const folder = resolve(absolute);
  const parent = parentOf(folder);
  try {
    const info = await stat(folder);
    if (!info.isDirectory()) {
      const reason = info.isFile() ? "is-a-file" : "not-a-folder";
      return { ok: false, reason, path: folder, parent };
    }
    const { entries, hasMore } = await scanFolder(folder, limits.scanned);
    return {
      ok: true,
      path: folder,
      parent,
      entries: entries.sort(compareEntries).slice(0, limits.entries),
      truncated: hasMore || entries.length > limits.entries,
    };
  } catch (error) {
    return { ok: false, reason: failureOf(error), path: folder, parent };
  }
}
