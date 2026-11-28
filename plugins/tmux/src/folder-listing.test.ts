import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FOLDER_LIMITS,
  listFolder,
  type FolderEntry,
  type FolderListing,
} from "./folder-listing";

type Listed = Extract<FolderListing, { ok: true }>;

const IS_WINDOWS = process.platform === "win32";
// Long enough for a slow disk, and far shorter than a call that waits for
// the other end of a FIFO, which never comes.
const NO_WAIT_MS = 5000;

// Every folder of these tests lives in a directory made for the test. home
// stands in for the home directory, so the real one is never listed.
let root: string;
let home: string;

async function file(path: string): Promise<void> {
  await writeFile(path, "never read\n");
}

function makeFifo(path: string): void {
  execFileSync("mkfifo", [path]);
}

async function list(path: string): Promise<Listed> {
  const listing = await listFolder(path, home);
  if (!listing.ok) throw new Error(`${path} was not listed: ${listing.reason}`);
  return listing;
}

function names(listing: Listed): string[] {
  return listing.entries.map((entry) => entry.name);
}

function folder(name: string): FolderEntry {
  return { name, kind: "folder" };
}

function regularFile(name: string): FolderEntry {
  return { name, kind: "file" };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tmux-folder-listing-"));
  home = join(root, "home");
  await mkdir(home);
});

afterEach(async () => {
  await chmod(join(home, "locked"), 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

describe("listFolder", () => {
  it("lists the folders and the files of a folder with its full path and its parent", async () => {
    await mkdir(join(home, "dotfiles"));
    await file(join(home, "notes.txt"));

    expect(await listFolder(home, home)).toEqual({
      ok: true,
      path: home,
      parent: root,
      entries: [folder("dotfiles"), regularFile("notes.txt")],
      truncated: false,
    });
  });

  it("lists an empty folder as one without entries", async () => {
    expect(await list(home)).toMatchObject({ entries: [], truncated: false });
  });

  it("lists hidden folders and files too", async () => {
    await mkdir(join(home, ".config"));
    await file(join(home, ".tmux.conf"));
    await file(join(home, "visible.txt"));

    expect((await list(home)).entries).toEqual([
      folder(".config"),
      regularFile(".tmux.conf"),
      regularFile("visible.txt"),
    ]);
  });

  it("puts the folders first and then the files, each by name, with capitals next to their small letters and digits by their value", async () => {
    for (const name of ["zeta", "Beta", "alpha", ".git", "src10", "src2"]) {
      await mkdir(join(home, name));
    }
    for (const name of ["b.conf", "A.conf", ".zshrc", "c.conf", "file10", "file9"]) {
      await file(join(home, name));
    }

    expect((await list(home)).entries).toEqual([
      folder(".git"),
      folder("alpha"),
      folder("Beta"),
      folder("src2"),
      folder("src10"),
      folder("zeta"),
      regularFile(".zshrc"),
      regularFile("A.conf"),
      regularFile("b.conf"),
      regularFile("c.conf"),
      regularFile("file9"),
      regularFile("file10"),
    ]);
  });

  it.skipIf(IS_WINDOWS)("lists two names that differ in their capitals only in the same order every time", async () => {
    await mkdir(join(root, "case"));
    await file(join(root, "case", "Readme"));
    await file(join(root, "case", "readme"));
    const first = names(await list(join(root, "case")));

    if (first.length === 2) expect(first).toEqual(["Readme", "readme"]);
    expect(names(await list(join(root, "case")))).toEqual(first);
  });

  describe("with symbolic links", () => {
    it("counts a link to a file as a file and a link to a folder as a folder", async () => {
      await mkdir(join(root, "elsewhere"));
      await file(join(root, "elsewhere", "tmux.conf"));
      await symlink(join(root, "elsewhere", "tmux.conf"), join(home, "linked.conf"));
      await symlink(join(root, "elsewhere"), join(home, "linked-folder"));

      expect((await list(home)).entries).toEqual([
        folder("linked-folder"),
        regularFile("linked.conf"),
      ]);
    });

    it("follows a link to a link", async () => {
      await file(join(root, "target.conf"));
      await symlink(join(root, "target.conf"), join(home, "first"));
      await symlink(join(home, "first"), join(home, "second"));

      expect((await list(home)).entries).toEqual([
        regularFile("first"),
        regularFile("second"),
      ]);
    });

    it("lists the folder that a link points to, under the path of the link", async () => {
      await mkdir(join(root, "elsewhere"));
      await file(join(root, "elsewhere", "tmux.conf"));
      await symlink(join(root, "elsewhere"), join(home, "linked-folder"));

      expect(await listFolder("~/linked-folder", home)).toEqual({
        ok: true,
        path: join(home, "linked-folder"),
        parent: home,
        entries: [regularFile("tmux.conf")],
        truncated: false,
      });
    });

    it("leaves out a link that points nowhere", async () => {
      await symlink(join(root, "gone"), join(home, "dangling"));
      await file(join(home, "kept.conf"));

      expect(names(await list(home))).toEqual(["kept.conf"]);
    });

    it("leaves out a link that points to itself and links that point to each other", async () => {
      await symlink(join(home, "self"), join(home, "self"));
      await symlink(join(home, "pong"), join(home, "ping"));
      await symlink(join(home, "ping"), join(home, "pong"));
      await file(join(home, "kept.conf"));

      expect(names(await list(home))).toEqual(["kept.conf"]);
    });

    it("lists a link to the folder above as a folder, and that folder once when it is opened", async () => {
      await mkdir(join(home, "inner"));
      await symlink(home, join(home, "inner", "up"));

      expect((await list(join(home, "inner"))).entries).toEqual([folder("up")]);
      expect(await listFolder(join(home, "inner", "up"), home)).toMatchObject({
        ok: true,
        path: join(home, "inner", "up"),
        parent: join(home, "inner"),
        entries: [folder("inner")],
      });
    });

    it.skipIf(IS_WINDOWS)("leaves out a link to a device", async () => {
      await symlink("/dev/null", join(home, "null"));

      expect(names(await list(home))).toEqual([]);
    });
  });

  describe.skipIf(IS_WINDOWS)("with what is neither a folder nor a regular file", () => {
    let socket: Server | null = null;

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        if (socket === null) return resolve();
        socket.close(() => resolve());
      });
      socket = null;
    });

    it("leaves out a FIFO and a link to one, and does not wait for anyone to write to it", async () => {
      makeFifo(join(home, "pipe"));
      await symlink(join(home, "pipe"), join(home, "linked-pipe"));
      await file(join(home, "kept.conf"));

      expect(names(await list(home))).toEqual(["kept.conf"]);
    }, NO_WAIT_MS);

    it("says at once that a FIFO is no folder", async () => {
      makeFifo(join(home, "pipe"));

      expect(await listFolder(join(home, "pipe"), home)).toEqual({
        ok: false,
        reason: "not-a-folder",
        path: join(home, "pipe"),
        parent: home,
      });
    }, NO_WAIT_MS);

    // A sandbox can forbid the test to make a socket. The test is skipped
    // there, and it says so.
    it("leaves out a socket", async (context) => {
      const path = join(root, "s");
      socket = createServer();
      const isListening = await new Promise<boolean>((resolve) => {
        socket?.once("error", () => resolve(false));
        socket?.listen(path, () => resolve(true));
      });
      if (!isListening) context.skip("this machine does not let the test make a socket");
      await file(join(root, "kept.conf"));

      expect(names(await list(root))).toEqual(["home", "kept.conf"]);
    });
  });

  describe("when the folder cannot be listed", () => {
    it("says that nothing is at a path, and names the folder that would hold it", async () => {
      expect(await listFolder(join(home, "gone", "deeper"), home)).toEqual({
        ok: false,
        reason: "missing",
        path: join(home, "gone", "deeper"),
        parent: join(home, "gone"),
      });
    });

    it("says that a path through a file leads to nothing", async () => {
      await file(join(home, "tmux.conf"));

      expect(await listFolder(join(home, "tmux.conf", "below"), home)).toMatchObject({
        ok: false,
        reason: "missing",
      });
    });

    it("says that a path to a file leads to a file, with the full path of the file and its folder", async () => {
      await mkdir(join(home, "dotfiles"));
      await file(join(home, "dotfiles", "tmux.conf"));

      expect(await listFolder("~/dotfiles/tmux.conf", home)).toEqual({
        ok: false,
        reason: "is-a-file",
        path: join(home, "dotfiles", "tmux.conf"),
        parent: join(home, "dotfiles"),
      });
    });

    it("says the same of a link to a file, and of a file that it may not read", async (context) => {
      if (IS_WINDOWS || process.getuid?.() === 0) context.skip();
      await file(join(home, "locked.conf"));
      await chmod(join(home, "locked.conf"), 0o000);
      await symlink(join(home, "locked.conf"), join(home, "linked.conf"));

      for (const name of ["locked.conf", "linked.conf"]) {
        expect(await listFolder(join(home, name), home)).toMatchObject({
          ok: false,
          reason: "is-a-file",
          path: join(home, name),
        });
      }
    });

    it.skipIf(IS_WINDOWS)("says that a device is no folder, and no file either", async () => {
      expect(await listFolder("/dev/null", home)).toEqual({
        ok: false,
        reason: "not-a-folder",
        path: "/dev/null",
        parent: "/dev",
      });
    });

    it("says that a link that points nowhere leads to nothing", async () => {
      await symlink(join(root, "gone"), join(home, "dangling"));

      expect(await listFolder(join(home, "dangling"), home)).toMatchObject({
        ok: false,
        reason: "missing",
      });
    });

    it("says that a link in a circle leads to nothing", async () => {
      await symlink(join(home, "self"), join(home, "self"));

      expect(await listFolder(join(home, "self"), home)).toMatchObject({
        ok: false,
        reason: "missing",
      });
    });

    it("says that a folder may not be read, and lists it in the folder above all the same", async (context) => {
      if (IS_WINDOWS || process.getuid?.() === 0) context.skip();
      await mkdir(join(home, "locked"));
      await file(join(home, "locked", "secret.conf"));
      await chmod(join(home, "locked"), 0o000);

      expect(await listFolder(join(home, "locked"), home)).toEqual({
        ok: false,
        reason: "unreadable",
        path: join(home, "locked"),
        parent: home,
      });
      expect((await list(home)).entries).toEqual([folder("locked")]);
    });

    it("says that a folder inside one that may not be entered may not be read", async (context) => {
      if (IS_WINDOWS || process.getuid?.() === 0) context.skip();
      await mkdir(join(home, "locked", "inner"), { recursive: true });
      await chmod(join(home, "locked"), 0o000);

      expect(await listFolder(join(home, "locked", "inner"), home)).toMatchObject({
        ok: false,
        reason: "unreadable",
      });
    });

    it.each(["dotfiles", "./dotfiles", "../home", "~other/dotfiles", "~dotfiles", "$HOME", "", "   "])(
      "says that the path %j is not absolute, and looks at nothing",
      async (path) => {
        await mkdir(join(home, "dotfiles"));

        expect(await listFolder(path, home)).toEqual({
          ok: false,
          reason: "not-absolute",
          path: null,
          parent: null,
        });
      },
    );

    it("says that a path with a character that no path can hold leads to nothing", async () => {
      expect(await listFolder(join(home, "a\0b"), home)).toMatchObject({
        ok: false,
        reason: "missing",
      });
    });

    it("never fails the call", async () => {
      await expect(listFolder(join(home, "x".repeat(5000)), home)).resolves.toMatchObject({
        ok: false,
      });
    });
  });

  describe("with ~ for the home directory", () => {
    it.each(["~", "~/"])("lists the home directory for %j", async (path) => {
      await file(join(home, ".tmux.conf"));

      expect(await listFolder(path, home)).toEqual({
        ok: true,
        path: home,
        parent: root,
        entries: [regularFile(".tmux.conf")],
        truncated: false,
      });
    });

    it("lists a folder of the home directory", async () => {
      await mkdir(join(home, ".config", "tmux"), { recursive: true });
      await file(join(home, ".config", "tmux", "tmux.conf"));

      expect(await listFolder("~/.config/tmux", home)).toMatchObject({
        ok: true,
        path: join(home, ".config", "tmux"),
        parent: join(home, ".config"),
        entries: [regularFile("tmux.conf")],
      });
    });

    it.each(["~", "~/dotfiles"])(
      "says that %s is not absolute while the home directory is not known",
      async (path) => {
        expect(await listFolder(path, null)).toEqual({
          ok: false,
          reason: "not-absolute",
          path: null,
          parent: null,
        });
      },
    );

    it("lists a full path while the home directory is not known", async () => {
      await file(join(home, "kept.conf"));

      expect(await listFolder(home, null)).toMatchObject({
        ok: true,
        path: home,
        entries: [regularFile("kept.conf")],
      });
    });
  });

  describe("with a path that is written in another way", () => {
    it.each([
      ["a slash at its end", () => `${home}/`],
      ["a folder and .. behind it", () => join(home, "dotfiles") + "/.."],
    ])("lists the folder for a path with %s, under its plain path", async (_what, path) => {
      await mkdir(join(home, "dotfiles"));

      expect(await listFolder(path(), home)).toMatchObject({
        ok: true,
        path: home,
        parent: root,
        entries: [folder("dotfiles")],
      });
    });
  });

  describe.skipIf(IS_WINDOWS)("with a name that ends in a blank", () => {
    const BLANK_ENDS = [" ", "\t", "\n", "\u00a0"];

    it.each(BLANK_ENDS)("lists a folder whose name ends in %j, and opens it by the path that it listed", async (end) => {
      const name = `trail${end}`;
      await mkdir(join(home, name));
      await file(join(home, name, "inside.conf"));

      expect((await list(home)).entries).toEqual([folder(name)]);
      expect(await listFolder(`${home}/${name}`, home)).toEqual({
        ok: true,
        path: `${home}/${name}`,
        parent: home,
        entries: [regularFile("inside.conf")],
        truncated: false,
      });
      expect(await listFolder(`~/${name}`, home)).toMatchObject({
        ok: true,
        path: `${home}/${name}`,
      });
    });

    it.each(BLANK_ENDS)("says that a file whose name ends in %j is a file, under its whole name", async (end) => {
      const name = `end.conf${end}`;
      await file(join(home, name));

      expect((await list(home)).entries).toEqual([regularFile(name)]);
      expect(await listFolder(`${home}/${name}`, home)).toEqual({
        ok: false,
        reason: "is-a-file",
        path: `${home}/${name}`,
        parent: home,
      });
    });

    it("does not list the folder next to it whose name has no blank at its end", async () => {
      await mkdir(join(home, "twin"));
      await file(join(home, "twin", "plain.conf"));
      await mkdir(join(home, "twin "));
      await file(join(home, "twin ", "blank.conf"));

      expect(names(await list(`${home}/twin `))).toEqual(["blank.conf"]);
      expect(names(await list(`${home}/twin`))).toEqual(["plain.conf"]);
    });

    it("takes a blank behind a path for a part of the last name, so nothing is at that path when no name ends in it", async () => {
      await mkdir(join(home, "dotfiles"));

      expect(await listFolder(`${home}/dotfiles `, home)).toEqual({
        ok: false,
        reason: "missing",
        path: `${home}/dotfiles `,
        parent: home,
      });
    });

    it.each([() => ` ${home}`, () => `\n${home}`, () => " ~", () => " ~/dotfiles"])(
      "says that a path with a blank before it is not absolute",
      async (path) => {
        await mkdir(join(home, "dotfiles"));

        expect(await listFolder(path(), home)).toEqual({
          ok: false,
          reason: "not-absolute",
          path: null,
          parent: null,
        });
      },
    );
  });

  describe("at the top", () => {
    it("lists the top folder, which has no parent", async () => {
      const top = parse(root).root;

      const listing = await listFolder(top, home);

      expect(listing).toMatchObject({ ok: true, path: top, parent: null });
    });

    it("names the top folder as the parent of what is directly in it", async () => {
      const top = parse(root).root;

      const listing = await listFolder(join(top, "made-up-folder-of-a-test"), home);

      expect(listing).toMatchObject({ ok: false, reason: "missing", parent: top });
    });
  });

  describe("with more entries than a listing holds", () => {
    const CAP = FOLDER_LIMITS.entries;

    function fileName(index: number): string {
      return `file-${String(index).padStart(5, "0")}`;
    }

    async function makeFiles(count: number): Promise<void> {
      const made: Promise<void>[] = [];
      for (let index = 0; index < count; index += 1) {
        made.push(writeFile(join(home, fileName(index)), ""));
      }
      await Promise.all(made);
    }

    it("holds 2000 entries at most", () => {
      expect(CAP).toBe(2000);
    });

    it("lists a folder with exactly 2000 entries whole", async () => {
      await makeFiles(CAP);

      const listing = await list(home);

      expect(listing.entries).toHaveLength(CAP);
      expect(listing.truncated).toBe(false);
    });

    it("cuts a longer list at 2000 entries and says so, and keeps the folders and the first files by name", async () => {
      await makeFiles(CAP + 5);
      await mkdir(join(home, "zz-folder"));
      await mkdir(join(home, ".config"));

      const listing = await list(home);

      expect(listing.truncated).toBe(true);
      expect(listing.entries).toHaveLength(CAP);
      expect(listing.entries.slice(0, 3)).toEqual([
        folder(".config"),
        folder("zz-folder"),
        regularFile(fileName(0)),
      ]);
      expect(listing.entries.at(-1)).toEqual(regularFile(fileName(CAP - 3)));
    });

    it("does not count what it leaves out", async () => {
      await mkdir(join(home, "a"));
      await file(join(home, "b"));
      await symlink(join(root, "gone-1"), join(home, "c"));
      await symlink(join(root, "gone-2"), join(home, "d"));

      expect(await listFolder(home, home, { entries: 2, scanned: 100 })).toMatchObject({
        entries: [folder("a"), regularFile("b")],
        truncated: false,
      });
    });

    it("stops looking after a number of entries, so that a huge folder is not read to its end, and says that the list was cut", async () => {
      await makeFiles(30);

      const listing = await listFolder(home, home, { entries: 100, scanned: 10 });

      expect(listing).toMatchObject({ ok: true, truncated: true });
      expect(listing.ok && listing.entries).toHaveLength(10);
    });

    it("says that the list was cut when it stopped looking before it found a folder or a file, and lists nothing", async () => {
      for (let index = 0; index < 6; index += 1) {
        await symlink(join(root, `gone-${index}`), join(home, `dangling-${index}`));
      }

      expect(await listFolder(home, home, { entries: 100, scanned: 5 })).toMatchObject({
        ok: true,
        entries: [],
        truncated: true,
      });
    });

    it("says nothing of a cut for a folder with exactly as many entries as it looks at", async () => {
      await makeFiles(10);

      expect(await listFolder(home, home, { entries: 100, scanned: 10 })).toMatchObject({
        truncated: false,
      });
    });

    it("looks at ten times as many entries as it lists", () => {
      expect(FOLDER_LIMITS.scanned).toBe(10 * CAP);
    });
  });

  describe("what it reads", () => {
    const source = readFileSync(new URL("./folder-listing.ts", import.meta.url), "utf8");

    it("uses the directory read and stat of Node and nothing else of its file system, so no file is ever opened", () => {
      const imports = [...source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"node:fs[^"]*"/g)];

      expect(
        imports.map(([, typeOnly, list]) => ({
          typeOnly: typeOnly !== undefined,
          names: list.split(",").map((name) => name.trim()).filter(Boolean),
        })),
      ).toEqual([
        { typeOnly: true, names: ["Dirent"] },
        { typeOnly: false, names: ["opendir", "stat"] },
      ]);
    });

    it("lists a file that it may not read, because it never reads one", async (context) => {
      if (IS_WINDOWS || process.getuid?.() === 0) context.skip();
      await file(join(home, "locked.conf"));
      await chmod(join(home, "locked.conf"), 0o000);

      expect((await list(home)).entries).toEqual([regularFile("locked.conf")]);
    });

    it("looks again on every call", async () => {
      expect(names(await list(home))).toEqual([]);

      await file(join(home, "new.conf"));

      expect(names(await list(home))).toEqual(["new.conf"]);
    });
  });
});
