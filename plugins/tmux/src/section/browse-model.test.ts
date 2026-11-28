import { describe, expect, it } from "vitest";
import type { FolderEntry, FolderFailure } from "../folder-listing";
import { LIST_KEYS } from "../list-keys";
import {
  FAILURE_TEXTS,
  HOME_PATH,
  LIST_MOVES,
  childPath,
  describeListing,
  entryNameAt,
  movedIndex,
  type ListedFolder,
} from "./browse-model";

const EM_DASH = String.fromCharCode(0x2014);

function listed(
  entries: FolderEntry[],
  overrides: Partial<ListedFolder> = {},
): ListedFolder {
  return {
    ok: true,
    path: "/home/me",
    parent: "/home",
    entries,
    truncated: false,
    ...overrides,
  };
}

function folders(count: number): FolderEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `folder-${index}`,
    kind: "folder",
  }));
}

function files(count: number): FolderEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `file-${index}`,
    kind: "file",
  }));
}

describe("childPath", () => {
  it.each([
    ["/home/me", "dotfiles", "/home/me/dotfiles"],
    ["/home/me/", "dotfiles", "/home/me/dotfiles"],
    ["/", "home", "/home"],
    ["/opt/my\\vi", "nano", "/opt/my\\vi/nano"],
    ["/home/me", ".tmux.conf", "/home/me/.tmux.conf"],
    ["/home/me", "a b.conf", "/home/me/a b.conf"],
  ])("puts a slash between the folder %s and the name %s", (folder, name, path) => {
    expect(childPath(folder, name)).toBe(path);
  });

  it.each([
    ["C:\\Users\\me", "dotfiles", "C:\\Users\\me\\dotfiles"],
    ["C:\\", "Users", "C:\\Users"],
    ["\\\\server\\share", "tmux.conf", "\\\\server\\share\\tmux.conf"],
  ])("puts a backslash between the Windows folder %s and the name %s", (folder, name, path) => {
    expect(childPath(folder, name)).toBe(path);
  });
});

describe("entryNameAt", () => {
  const listing = listed([
    { name: "dotfiles", kind: "folder" },
    { name: "tmux.conf", kind: "file" },
  ]);

  it("finds the entry with a full path", () => {
    expect(entryNameAt(listing, "/home/me/tmux.conf")).toBe("tmux.conf");
    expect(entryNameAt(listing, "/home/me/dotfiles")).toBe("dotfiles");
  });

  it.each([null, "/home/me/gone.conf", "/home/other/tmux.conf", "tmux.conf", "/home/me"])(
    "finds none for %j",
    (path) => {
      expect(entryNameAt(listing, path)).toBeNull();
    },
  );
});

describe("describeListing", () => {
  it.each([
    [3, 12, "3 folders and 12 files."],
    [1, 1, "1 folder and 1 file."],
    [0, 2, "No folders and 2 files."],
    [0, 1, "No folders and 1 file."],
    [4, 0, "4 folders and no files."],
  ])("counts %d folders and %d files", (folderCount, fileCount, text) => {
    expect(describeListing(listed([...folders(folderCount), ...files(fileCount)]))).toBe(text);
  });

  it.each([
    ["an empty folder", listed([])],
    ["a cut list without an entry", listed([], { truncated: true })],
    ["files only", listed(files(3))],
    ["files only in a cut list", listed(files(3), { truncated: true })],
    ["folders only", listed(folders(3))],
    ["folders and files in a cut list", listed([...folders(1), ...files(1)], { truncated: true })],
  ])("starts the line about %s with a capital or a number", (_what, listing) => {
    expect(describeListing(listing)).toMatch(/^[A-Z\d]/);
  });

  it("says that a folder lists nothing", () => {
    expect(describeListing(listed([]))).toBe(
      "There are no folders or files in this folder.",
    );
  });

  it("says that the list was cut, after how many entries, and how to reach the rest", () => {
    const entries = [...folders(2), ...files(1998)];

    expect(describeListing(listed(entries, { truncated: true }))).toBe(
      "2 folders and 1998 files are listed. This folder holds more: the list was cut after its first 2000 entries. To reach an entry that is not listed, type or paste its path into the path box.",
    );
  });

  it("starts with a capital for a cut list of files only", () => {
    expect(describeListing(listed(files(5), { truncated: true }))).toBe(
      "No folders and 5 files are listed. This folder holds more: the list was cut after its first 5 entries. To reach an entry that is not listed, type or paste its path into the path box.",
    );
  });

  it("does not call a folder empty whose list was cut before a folder or a file was found, and says how to reach what is in it", () => {
    expect(describeListing(listed([], { truncated: true }))).toBe(
      "No folders or files are listed. This folder holds more: the list was cut before a folder or a file was found. To reach an entry that is not listed, type or paste its path into the path box.",
    );
  });
});

describe("movedIndex", () => {
  it.each([
    ["next", 0, 1],
    ["next", 4, 4],
    ["previous", 3, 2],
    ["previous", 0, 0],
    ["first", 3, 0],
    ["last", 1, 4],
    ["page-down", 0, 3],
    ["page-down", 3, 4],
    ["page-up", 4, 1],
    ["page-up", 1, 0],
  ] as const)("takes %s from row %d to row %d of five, a page being three rows", (move, from, to) => {
    expect(movedIndex(move, from, 5, 3)).toBe(to);
  });

  it.each([
    ["next", 0],
    ["page-down", 0],
    ["first", 0],
    ["previous", 4],
    ["page-up", 4],
    ["last", 4],
  ] as const)("takes %s from no row to row %d of five", (move, to) => {
    expect(movedIndex(move, null, 5, 3)).toBe(to);
  });

  it.each(["next", "previous", "first", "last", "page-down", "page-up"] as const)(
    "has no row for %s in an empty list",
    (move) => {
      expect(movedIndex(move, null, 0, 3)).toBeNull();
    },
  );
});

describe("the keys and the texts of the dialog", () => {
  it("moves through the list with the keys of a plain list", () => {
    expect([...LIST_MOVES]).toEqual([
      ["ArrowDown", "next"],
      ["ArrowUp", "previous"],
      ["Home", "first"],
      ["End", "last"],
      ["PageDown", "page-down"],
      ["PageUp", "page-up"],
    ]);
  });

  it("uses none of the letter and Ctrl keys of tmux's lists, which are keys of the plugin", () => {
    const tmuxOnly = [...LIST_KEYS.keys()].filter((key) => !LIST_MOVES.has(key));

    expect(tmuxOnly).toEqual(
      expect.arrayContaining(["j", "k", "g", "G", "q", "C-n", "C-p", "C-b", "C-f", "C-g"]),
    );
    for (const key of LIST_MOVES.keys()) expect(key).not.toMatch(/^(?:[a-zA-Z]|C-.*|M-.*)$/);
  });

  it("stands for the home folder as the server reads it", () => {
    expect(HOME_PATH).toBe("~");
  });

  it("has a text without an em dash for every reason a folder cannot be listed for", () => {
    const reasons: FolderFailure[] = [
      "not-absolute",
      "missing",
      "is-a-file",
      "not-a-folder",
      "unreadable",
    ];

    expect(Object.keys(FAILURE_TEXTS).sort()).toEqual([...reasons].sort());
    for (const reason of reasons) {
      expect(FAILURE_TEXTS[reason]).not.toBe("");
      expect(FAILURE_TEXTS[reason]).not.toContain(EM_DASH);
    }
    expect(FAILURE_TEXTS.missing).toBe("There is no folder at this path.");
    expect(FAILURE_TEXTS.unreadable).toBe("The bb server may not read this folder.");
  });
});
