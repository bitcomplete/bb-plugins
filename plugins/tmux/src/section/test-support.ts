import { vi } from "vitest";
import type { ConfigFileChange, ConfigFileChoice } from "../config-file";
import type { FolderEntry, FolderListing } from "../folder-listing";

// A made-up machine for the tests of the settings section, in the place of
// the one that the bb server runs on. A folder is an object, "file" is a
// regular file and "locked" a folder that the bb server may not read.
export type FakeNode = "file" | "locked" | { [name: string]: FakeNode };

export const FAKE_HOME = "/home/me";

export const FAKE_TREE: FakeNode = {
  home: {
    me: {
      ".config": { tmux: { "tmux.conf": "file" } },
      ".tmux.conf": "file",
      dotfiles: {
        nested: { "deep.conf": "file" },
        "other.conf": "file",
        "tmux.conf": "file",
      },
      empty: {},
      locked: "locked",
      "notes.txt": "file",
    },
  },
};

interface FakeMachineOptions {
  tree?: FakeNode;
  chosen?: string | null;
  maxEntries?: number;
}

// The path is taken as it is given, as the server part takes it: a name can
// end in a blank.
function fullPath(path: string): string | null {
  const isInHome = path === "~" || path.startsWith("~/");
  const expanded = isInHome ? FAKE_HOME + path.slice(1) : path;
  if (!expanded.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of expanded.split("/")) {
    if (part === "..") parts.pop();
    if (part !== "" && part !== "." && part !== "..") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function parentOf(path: string): string | null {
  if (path === "/") return null;
  const parent = path.slice(0, path.lastIndexOf("/"));
  return parent === "" ? "/" : parent;
}

function nodeAt(tree: FakeNode, path: string): FakeNode | null {
  let node: FakeNode = tree;
  for (const name of path.split("/").filter((part) => part !== "")) {
    if (typeof node === "string") return null;
    const next: FakeNode | undefined = node[name];
    if (next === undefined) return null;
    node = next;
  }
  return node;
}

function compareEntries(a: FolderEntry, b: FolderEntry): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });
}

// The three rpc methods of the server part that the settings section calls,
// with answers of the same shape. chosen is the path that the storage of the
// plugin holds, and unreadable holds the full paths of files that cannot be
// read.
export function fakeMachine(options: FakeMachineOptions = {}) {
  const tree = options.tree ?? FAKE_TREE;
  const maxEntries = options.maxEntries ?? 2000;
  const unreadable = new Set<string>();
  let chosen = options.chosen ?? null;

  const isReadable = (path: string): boolean => {
    const full = fullPath(path);
    if (full === null || unreadable.has(full)) return false;
    return nodeAt(tree, full) === "file";
  };

  const choice = (): ConfigFileChoice["file"] =>
    chosen === null ? null : { path: chosen, readable: isReadable(chosen) };

  const listFolder = vi.fn(
    async ({ path }: { path: string }): Promise<FolderListing> => {
      const full = fullPath(path);
      if (full === null) {
        return { ok: false, reason: "not-absolute", path: null, parent: null };
      }
      const parent = parentOf(full);
      const node = nodeAt(tree, full);
      if (node === null) return { ok: false, reason: "missing", path: full, parent };
      if (node === "file") {
        return { ok: false, reason: "is-a-file", path: full, parent };
      }
      if (node === "locked") {
        return { ok: false, reason: "unreadable", path: full, parent };
      }
      const entries = Object.entries(node)
        .map(([name, child]): FolderEntry => ({
          name,
          kind: child === "file" ? "file" : "folder",
        }))
        .sort(compareEntries);
      return {
        ok: true,
        path: full,
        parent,
        entries: entries.slice(0, maxEntries),
        truncated: entries.length > maxEntries,
      };
    },
  );

  const configFile = vi.fn(
    async (_input: null): Promise<ConfigFileChoice> => ({ file: choice() }),
  );

  const setConfigFile = vi.fn(
    async ({ path }: { path: string | null }): Promise<ConfigFileChange> => {
      if (path !== null && fullPath(path) === null) {
        return { ok: false, reason: "not-absolute" };
      }
      chosen = path;
      return { ok: true, file: choice() };
    },
  );

  return {
    rpc: { listFolder, configFile, setConfigFile },
    chosen: () => chosen,
    choose: (path: string | null): void => {
      chosen = path;
    },
    makeUnreadable: (path: string): void => {
      unreadable.add(path);
    },
  };
}

export type FakeMachine = ReturnType<typeof fakeMachine>;

// A folder with this many files, named so that they sort in their order.
export function folderOfFiles(count: number): FakeNode {
  const files: Record<string, FakeNode> = {};
  for (let index = 0; index < count; index += 1) {
    files[`file-${String(index).padStart(4, "0")}.conf`] = "file";
  }
  return files;
}

// An answer that comes when the test says so.
export function pendingAnswer<Answer>() {
  let answer: (value: Answer) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const promise = new Promise<Answer>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  return { promise, answer, fail };
}
