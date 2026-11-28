// @vitest-environment jsdom
import {
  renderSlot,
  type PluginSdkTestFakes,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBridge,
  getUiState,
  resetStore,
  showNotice,
  updateUiState,
} from "../bridge";
import { SWITCHED_ON_ATTRIBUTE } from "../constants";
import { rpcContract } from "../contract";
import {
  CONFIG_FILE_CHANGED,
  DEFAULT_SETTINGS,
  type Settings,
} from "../settings";
import {
  stockTmuxConfig,
  tmuxConfigFrom,
  type TmuxConfig,
} from "../tmux-keymap";
import {
  TEST_CONFIG_PATH,
  VI_STYLE_CONFIG,
  fileSources,
  tmuxConfigOf,
} from "../tmux-test-support";
import type { Bridge, ConfigReload, CursorRect } from "../types";
import { TmuxOverlay } from "./Overlay";
import {
  listenToLiveRegion,
  makeLayout,
  makeProject,
  makeThread,
} from "./test-support";

const mocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return {
    toast,
    setKeybindings: vi.fn(),
    chooserCrash: { current: null as Error | null },
    settingsLoading: { current: false },
    changedSettings: { current: null as Settings | null },
    openThread: vi.fn(),
    readSnapshot: vi.fn(),
    writeSnapshot: vi.fn(),
    removeSnapshot: vi.fn(),
    buildSnapshot: vi.fn(),
    decideRestore: vi.fn(),
  };
});

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("../bb-commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bb-commands")>();
  return {
    isMacPlatform: actual.isMacPlatform,
    setKeybindings: mocks.setKeybindings,
  };
});
vi.mock("../chooser-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chooser-model")>();
  return {
    ...actual,
    buildChooserItems: (input: Parameters<typeof actual.buildChooserItems>[0]) => {
      if (mocks.chooserCrash.current !== null) throw mocks.chooserCrash.current;
      return actual.buildChooserItems(input);
    },
  };
});
vi.mock("./hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks")>();
  return {
    ...actual,
    usePluginSettings: () => {
      const result = actual.usePluginSettings();
      if (mocks.changedSettings.current !== null) {
        return { settings: mocks.changedSettings.current, isLoaded: true };
      }
      return mocks.settingsLoading.current
        ? { ...result, isLoaded: false }
        : result;
    },
  };
});
vi.mock("../open-thread", () => ({ openThread: mocks.openThread }));
vi.mock("../restore", () => ({
  readSnapshot: mocks.readSnapshot,
  writeSnapshot: mocks.writeSnapshot,
  removeSnapshot: mocks.removeSnapshot,
  buildSnapshot: mocks.buildSnapshot,
  decideRestore: mocks.decideRestore,
  isRouteReconciled: () => true,
}));

const THREADS = [
  makeThread("thr-1", { displayTitle: "Alpha" }),
  makeThread("thr-2", { displayTitle: "Beta" }),
  makeThread("thr-archived", { isArchived: true }),
  makeThread("thr-hidden", { isHidden: true }),
];
const PROJECTS = [makeProject("proj-1", "Website")];
const LAYOUT = makeLayout([
  { paneId: "pane-1", threadId: "thr-1", isFocused: true },
  { paneId: "pane-2", threadId: null, isFocused: false },
]);
const KEYBINDINGS = [
  {
    command: "pane.close",
    desktopOnly: false,
    shortcut: {
      key: "w",
      mod: true,
      meta: false,
      control: false,
      alt: false,
      shift: false,
    },
    when: { all: ["splitActive"], none: ["modalOpen"] },
  },
];
const STORED_SNAPSHOT = {
  version: 1,
  savedAt: 1,
  focusedThreadId: "thr-2",
  panes: [],
};
const FRESH_SNAPSHOT = {
  version: 1,
  savedAt: 2,
  focusedThreadId: "thr-1",
  panes: [],
};

const HELP_TITLE = "Tmux keys";

// The overlay asks the server for the tmux config and for nothing else.
type OverlayOptions = RenderSlotOptions<Pick<typeof rpcContract, "tmuxConfig">>;

// The plugin is off until its Enable setting is turned on, so the settings of
// these tests turn it on unless a test is about the plugin being off.
const ON = { enabled: true };
const SETTINGS = { ...DEFAULT_SETTINGS, ...ON };
const STOCK_ANSWER = stockTmuxConfig();
const CONFIG_ANSWER = tmuxConfigOf(VI_STYLE_CONFIG);

// The plugin is switched on and the server answers at once that there is no
// tmux config, so the prefix is tmux's own Ctrl-b, unless a test says
// otherwise.
async function renderOverlay(options: OverlayOptions = {}) {
  const view = renderSlot(
    { component: TmuxOverlay },
    {},
    {
      settings: ON,
      experimental_rpcContract: rpcContract,
      rpc: { tmuxConfig: async () => STOCK_ANSWER },
      ...options,
    },
  );
  await flushEffects();
  return view;
}

// A server that answers the question about the tmux config when the test
// says so.
function tmuxServer() {
  let answer: (value: TmuxConfig) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const pending = new Promise<TmuxConfig>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  return {
    rpc: { tmuxConfig: () => pending },
    answer: (value: TmuxConfig) => act(async () => answer(value)),
    fail: (error: Error) => act(async () => fail(error)),
  };
}

function flushEffects(): Promise<void> {
  return act(async () => {});
}

// What bb does when a setting is changed while the window is open: the
// overlay is drawn again with the new values.
async function changeSettings(
  view: Awaited<ReturnType<typeof renderOverlay>>,
  settings: Partial<Settings>,
): Promise<void> {
  mocks.changedSettings.current = { ...DEFAULT_SETTINGS, ...settings };
  view.lifecycle.rerender(<TmuxOverlay />);
  await flushEffects();
}

function prefixLine(): string | null {
  act(() => updateUiState({ helpOpen: true }));
  return screen.getByText(/^Prefix: /).textContent;
}

function publishedBridge(): Bridge {
  const bridge = getBridge();
  if (bridge === null) throw new Error("the bridge was not published");
  return bridge;
}

interface ConfigSubscription {
  event: string;
  callback: () => void;
}

function configFakes(
  config = vi.fn(async () => ({ keybindings: KEYBINDINGS })),
) {
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_args: ConfigSubscription) => unsubscribe);
  const sdk = {
    system: { config },
    subscribe,
  } as unknown as PluginSdkTestFakes;
  return { sdk, config, subscribe, unsubscribe };
}

function silenceConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.chooserCrash.current = null;
  mocks.settingsLoading.current = false;
  mocks.changedSettings.current = null;
  mocks.readSnapshot.mockReturnValue(null);
  mocks.buildSnapshot.mockReturnValue(FRESH_SNAPSHOT);
  mocks.decideRestore.mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  resetStore();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("bridge publisher", () => {
  it("publishes the hook values", async () => {
    const view = await renderOverlay({
      sidebarThreads: { threads: THREADS, projects: PROJECTS },
      sidebarSplitLayout: LAYOUT,
      context: { projectId: "proj-1", threadId: "thr-1" },
      settings: { ...ON, scrollStepPx: 120 },
    });

    const bridge = publishedBridge();
    expect(bridge.layout).toBe(LAYOUT);
    expect(bridge.context).toEqual({ projectId: "proj-1", threadId: "thr-1" });
    expect(bridge.threads).toBe(THREADS);
    expect(bridge.threadsReady).toBe(true);
    expect(bridge.projects).toBe(PROJECTS);
    expect(bridge.composers).toHaveLength(1);
    expect(bridge.settings).toEqual({
      ...DEFAULT_SETTINGS,
      enabled: true,
      scrollStepPx: 120,
    });

    bridge.navigate.toThread("thr-2", { split: true });
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-2", options: { split: true } },
    ]);
  });

  it("publishes the sdk client", async () => {
    const open = vi.fn(async () => ({ delivered: 1 }));
    const view = await renderOverlay({ sdk: { threads: { open } } });

    await publishedBridge().sdk.threads.open({
      threadId: "thr-1",
      split: "down",
      file: null,
    });

    expect(open).toHaveBeenCalledWith({
      threadId: "thr-1",
      split: "down",
      file: null,
    });
    expect(view.inspection.sdkCalls.map((call) => call.method)).toContain(
      "threads.open",
    );
  });

  it("uses the default settings for values bb does not report, and a null layout when bb reports none", async () => {
    await renderOverlay();

    const bridge = publishedBridge();
    expect(bridge.settings).toEqual(SETTINGS);
    expect(bridge.layout).toBeNull();
    expect(bridge.context).toEqual({ projectId: null, threadId: null });
  });

  it("reports threads as not ready while the list is loading", async () => {
    await renderOverlay({ sidebarThreads: { status: "loading" } });
    expect(publishedBridge().threadsReady).toBe(false);
  });

  it("keeps the settings object identity across re-renders with unchanged values", async () => {
    const view = await renderOverlay({
      settings: { ...ON, scrollStepPx: 120 },
    });
    const settings = publishedBridge().settings;

    view.lifecycle.rerender(<TmuxOverlay />);
    view.lifecycle.rerender(<TmuxOverlay />);

    expect(publishedBridge().settings).toBe(settings);
  });

  it("publishes nothing until bb has returned the plugin's settings", async () => {
    mocks.settingsLoading.current = true;
    const view = await renderOverlay({ sidebarThreads: { threads: THREADS } });

    expect(getBridge()).toBeNull();
    expect(mocks.readSnapshot).not.toHaveBeenCalled();
    expect(view.inspection.rpcCalls).toEqual([]);
    act(() => updateUiState({ prefixArmed: true }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => updateUiState({ helpOpen: true }));
    expect(screen.getByText("The tmux config is still being read.")).toBeTruthy();
    act(() => updateUiState({ helpOpen: false }));

    mocks.settingsLoading.current = false;
    view.lifecycle.rerender(<TmuxOverlay />);
    await flushEffects();

    expect(publishedBridge().settings).toEqual(SETTINGS);
    expect(mocks.readSnapshot).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("Ctrl-b");
  });

  it("publishes nothing while bb has stopped loading but has no values for the settings", async () => {
    await renderOverlay({
      sidebarThreads: { threads: THREADS },
      settings: undefined,
    });

    expect(getBridge()).toBeNull();
    expect(mocks.readSnapshot).not.toHaveBeenCalled();
    expect(mocks.decideRestore).not.toHaveBeenCalled();
  });

  it("clears the bridge on unmount", async () => {
    const view = await renderOverlay();
    expect(getBridge()).not.toBeNull();

    view.lifecycle.unmount();

    expect(getBridge()).toBeNull();
  });
});

describe("the tmux config", () => {
  const TMUX_CALL = { method: "tmuxConfig", input: null };

  function sourceLine(): string | null {
    act(() => updateUiState({ helpOpen: true }));
    return screen.getByText(/stock tmux/).textContent;
  }

  it("publishes nothing while the server has not answered, then the keys of the tmux config", async () => {
    const server = tmuxServer();
    const view = await renderOverlay({
      rpc: server.rpc,
      sidebarThreads: { threads: THREADS },
    });

    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
    expect(getBridge()).toBeNull();
    expect(mocks.readSnapshot).not.toHaveBeenCalled();
    expect(mocks.decideRestore).not.toHaveBeenCalled();

    await server.answer(CONFIG_ANSWER);

    expect(publishedBridge().settings).toEqual(SETTINGS);
    expect(publishedBridge().tmux).toEqual(CONFIG_ANSWER);
    expect(mocks.decideRestore).toHaveBeenCalledTimes(1);
    act(() => updateUiState({ prefixArmed: true }));
    expect(screen.getByRole("status").textContent).toBe("Ctrl-a");
    expect(prefixLine()).toBe("Prefix: Ctrl-a, from ~/.tmux.conf");
    expect(sourceLine()).toBe(
      "The keys of stock tmux with ~/.tmux.conf applied to them.",
    );
  });

  it("takes the prefix from the tmux config whatever prefixKey value bb still has stored, which is no setting", async () => {
    const server = tmuxServer();
    const view = await renderOverlay({
      settings: { ...ON, prefixKey: "ctrl+x" },
      rpc: server.rpc,
    });

    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
    expect(getBridge()).toBeNull();

    await server.answer(CONFIG_ANSWER);

    expect(publishedBridge().settings).toEqual(SETTINGS);
    expect(publishedBridge().settings).not.toHaveProperty("prefixKey");
    act(() => updateUiState({ prefixArmed: true }));
    expect(screen.getByRole("status").textContent).toBe("Ctrl-a");
    expect(prefixLine()).toBe("Prefix: Ctrl-a, from ~/.tmux.conf");
  });

  it("asks for a plugin that is switched on and has no other setting changed", async () => {
    const server = tmuxServer();
    const view = await renderOverlay({ settings: ON, rpc: server.rpc });

    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
    expect(getBridge()).toBeNull();

    await server.answer(CONFIG_ANSWER);

    expect(publishedBridge().settings).toEqual(SETTINGS);
    expect(publishedBridge().tmux.options.prefix?.key).toBe("C-a");
  });

  it("asks the server once, however often it renders", async () => {
    const server = tmuxServer();
    const view = await renderOverlay({ rpc: server.rpc });
    view.lifecycle.rerender(<TmuxOverlay />);
    await server.answer(CONFIG_ANSWER);
    const { settings, tmux } = publishedBridge();

    view.lifecycle.rerender(<TmuxOverlay />);
    view.lifecycle.rerender(<TmuxOverlay />);
    await flushEffects();

    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
    expect(publishedBridge().settings).toBe(settings);
    expect(publishedBridge().tmux).toBe(tmux);
  });

  it("uses the keys of stock tmux, and says so, when there is no tmux config", async () => {
    await renderOverlay();

    expect(publishedBridge().tmux).toEqual(STOCK_ANSWER);
    act(() => updateUiState({ prefixArmed: true }));
    expect(screen.getByRole("status").textContent).toBe("Ctrl-b");
    expect(prefixLine()).toBe(
      "Prefix: Ctrl-b, tmux's default (no tmux config sets a prefix)",
    );
    expect(sourceLine()).toBe(
      "No tmux config was found, so these are the keys of stock tmux.",
    );
  });

  it("uses Ctrl-b when the tmux config sets a prefix that bb cannot use, and says which", async () => {
    await renderOverlay({
      rpc: { tmuxConfig: async () => tmuxConfigOf("set -g prefix `") },
    });

    act(() => updateUiState({ prefixArmed: true }));
    expect(screen.getByRole("status").textContent).toBe("Ctrl-b");
    expect(prefixLine()).toBe(
      "Prefix: Ctrl-b, tmux's default (the prefix ` in ~/.tmux.conf cannot be used in bb)",
    );
  });

  it("uses stock tmux as soon as the call fails", async () => {
    const server = tmuxServer();
    await renderOverlay({ rpc: server.rpc });
    expect(getBridge()).toBeNull();

    await server.fail(new Error("the server part is not running"));

    expect(publishedBridge().tmux).toEqual(STOCK_ANSWER);
    expect(console.warn).toHaveBeenCalledWith(
      "[tmux] reading the tmux config failed",
      expect.any(Error),
    );
    expect(prefixLine()).toBe(
      "Prefix: Ctrl-b, tmux's default (the tmux config could not be read)",
    );
    expect(sourceLine()).toBe(
      "The tmux config could not be read, so these are the keys of stock tmux.",
    );
  });

  it("uses stock tmux when the server does not know the method", async () => {
    await renderOverlay({ rpc: undefined });

    await waitFor(() => expect(getBridge()).not.toBeNull());

    expect(publishedBridge().tmux).toEqual(STOCK_ANSWER);
  });

  it("uses stock tmux when the answer does not have the agreed shape", async () => {
    const rpc = {
      tmuxConfig: async () => ({ prefix: "C-a" }) as unknown as TmuxConfig,
    };
    await renderOverlay({ rpc });

    await waitFor(() => expect(getBridge()).not.toBeNull());

    expect(publishedBridge().tmux).toEqual(STOCK_ANSWER);
  });

  it("uses stock tmux after 2000 ms without an answer, and adopts the answer when it still comes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = tmuxServer();
    const view = await renderOverlay({ rpc: server.rpc });

    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(getBridge()).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(publishedBridge().tmux).toEqual(STOCK_ANSWER);
    expect(prefixLine()).toBe(
      "Prefix: Ctrl-b, tmux's default (the tmux config could not be read)",
    );

    await server.answer(CONFIG_ANSWER);

    expect(publishedBridge().tmux).toEqual(CONFIG_ANSWER);
    expect(prefixLine()).toBe("Prefix: Ctrl-a, from ~/.tmux.conf");
    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
  });

  it("reads the tmux config again through the bridge, and publishes the new keys", async () => {
    const tmuxConfig = vi
      .fn<() => Promise<TmuxConfig>>()
      .mockResolvedValueOnce(STOCK_ANSWER)
      .mockResolvedValueOnce(CONFIG_ANSWER);
    const view = await renderOverlay({ rpc: { tmuxConfig } });
    expect(publishedBridge().tmux).toEqual(STOCK_ANSWER);

    let reload: ConfigReload | undefined;
    await act(async () => {
      reload = await publishedBridge().reloadTmuxConfig();
    });

    expect(reload).toBe("read");
    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL, TMUX_CALL]);
    expect(publishedBridge().tmux).toEqual(CONFIG_ANSWER);
    act(() => updateUiState({ prefixArmed: true }));
    expect(screen.getByRole("status").textContent).toBe("Ctrl-a");
  });

  it("keeps the keys it has when the config cannot be read again", async () => {
    const tmuxConfig = vi
      .fn<() => Promise<TmuxConfig>>()
      .mockResolvedValueOnce(CONFIG_ANSWER)
      .mockRejectedValueOnce(new Error("the server part is not running"));
    await renderOverlay({ rpc: { tmuxConfig } });

    let reload: ConfigReload | undefined;
    await act(async () => {
      reload = await publishedBridge().reloadTmuxConfig();
    });

    expect(reload).toBe("failed");
    expect(publishedBridge().tmux).toEqual(CONFIG_ANSWER);
  });

  it("says that the config was not read in full, and takes the keys that are left, when the server could not read the chosen file", async () => {
    const withoutFile: TmuxConfig = {
      ...STOCK_ANSWER,
      unreadable: true,
      namedFile: true,
    };
    const tmuxConfig = vi
      .fn<() => Promise<TmuxConfig>>()
      .mockResolvedValueOnce(CONFIG_ANSWER)
      .mockResolvedValueOnce(withoutFile);
    await renderOverlay({ rpc: { tmuxConfig } });

    let reload: ConfigReload | undefined;
    await act(async () => {
      reload = await publishedBridge().reloadTmuxConfig();
    });

    expect(reload).toBe("incomplete");
    expect(publishedBridge().tmux).toEqual(withoutFile);
  });

  it("does not ask before bb has returned the plugin's settings", async () => {
    const server = tmuxServer();
    const view = await renderOverlay({ settings: undefined, rpc: server.rpc });

    expect(view.inspection.rpcCalls).toEqual([]);
    expect(getBridge()).toBeNull();
  });

  describe("with a chosen config file and the Config text setting", () => {
    const PASTED = "set -g prefix C-s\nbind -r H resize-pane -L 5\n";
    const WITH_PASTED_TEXT = tmuxConfigFrom(
      {
        ...fileSources([{ path: TEST_CONFIG_PATH, text: VI_STYLE_CONFIG }]),
        pastedText: {
          state: "applied",
          lines: { path: "the Config text setting", text: PASTED },
        },
      },
      { visual: undefined, editor: undefined },
    );

    function answers(...configs: TmuxConfig[]) {
      const tmuxConfig = vi.fn<() => Promise<TmuxConfig>>();
      for (const config of configs) tmuxConfig.mockResolvedValueOnce(config);
      return { tmuxConfig };
    }

    it("asks the server again when the Config text setting changes, and publishes the new keys", async () => {
      const view = await renderOverlay({
        rpc: answers(STOCK_ANSWER, CONFIG_ANSWER),
      });
      expect(publishedBridge().tmux).toEqual(STOCK_ANSWER);

      await changeSettings(view, { ...ON, tmuxConfigText: PASTED });

      expect(view.inspection.rpcCalls).toEqual([TMUX_CALL, TMUX_CALL]);
      expect(publishedBridge().tmux).toEqual(CONFIG_ANSWER);
      expect(publishedBridge().settings).toMatchObject({ tmuxConfigText: PASTED });
      act(() => updateUiState({ prefixArmed: true }));
      expect(screen.getByRole("status").textContent).toBe("Ctrl-a");
    });

    it("asks the server again when it says that another config file was chosen, and publishes the new keys without a reload", async () => {
      const view = await renderOverlay({
        rpc: answers(STOCK_ANSWER, CONFIG_ANSWER),
      });
      expect(publishedBridge().tmux).toEqual(STOCK_ANSWER);

      await view.behavior.emitRealtime(CONFIG_FILE_CHANGED, {});

      expect(view.inspection.rpcCalls).toEqual([TMUX_CALL, TMUX_CALL]);
      expect(publishedBridge().tmux).toEqual(CONFIG_ANSWER);
      act(() => updateUiState({ prefixArmed: true }));
      expect(screen.getByRole("status").textContent).toBe("Ctrl-a");
    });

    it("asks nothing for a signal on another channel", async () => {
      const view = await renderOverlay({ rpc: answers(STOCK_ANSWER) });

      await view.behavior.emitRealtime("something-else", {});

      expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
    });

    it("asks the server again when the connection to it comes back", async () => {
      const view = await renderOverlay({
        rpc: answers(STOCK_ANSWER, CONFIG_ANSWER),
      });

      await view.behavior.setRealtimeConnectionState("reconnecting");
      expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
      await view.behavior.setRealtimeConnectionState("connected");

      expect(view.inspection.rpcCalls).toEqual([TMUX_CALL, TMUX_CALL]);
      expect(publishedBridge().tmux).toEqual(CONFIG_ANSWER);
    });

    it("asks once when the window connects for the first time", async () => {
      const view = await renderOverlay({
        realtimeConnectionState: "connecting",
        rpc: answers(STOCK_ANSWER),
      });

      await view.behavior.setRealtimeConnectionState("connected");

      expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
    });

    it("keeps the keys it has until the server has answered the new question", async () => {
      const server = tmuxServer();
      const tmuxConfig = vi
        .fn<() => Promise<TmuxConfig>>()
        .mockResolvedValueOnce(CONFIG_ANSWER)
        .mockImplementationOnce(server.rpc.tmuxConfig);
      const view = await renderOverlay({ rpc: { tmuxConfig } });

      await changeSettings(view, { ...ON, tmuxConfigText: PASTED });

      expect(publishedBridge().tmux).toEqual(CONFIG_ANSWER);

      await server.answer(WITH_PASTED_TEXT);

      expect(publishedBridge().tmux).toEqual(WITH_PASTED_TEXT);
    });

    it("does not ask again when another setting changes", async () => {
      const view = await renderOverlay({
        settings: { ...ON, tmuxConfigText: PASTED },
        rpc: answers(CONFIG_ANSWER),
      });

      await changeSettings(view, {
        ...ON,
        tmuxConfigText: PASTED,
        scrollStepPx: 200,
        threadOrder: "recent",
      });

      expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
      expect(publishedBridge().settings.scrollStepPx).toBe(200);
      expect(publishedBridge().tmux).toEqual(CONFIG_ANSWER);
    });

    it("builds the keys from the answer of the server, and not from the text it holds itself", async () => {
      await renderOverlay({
        settings: { ...ON, tmuxConfigText: PASTED },
        rpc: answers(STOCK_ANSWER),
      });

      expect(publishedBridge().settings.tmuxConfigText).toBe(PASTED);
      expect(publishedBridge().tmux).toEqual(STOCK_ANSWER);
      act(() => updateUiState({ prefixArmed: true }));
      expect(screen.getByRole("status").textContent).toBe("Ctrl-b");
    });

    it("names the Config text setting in the key help, as the source of the prefix and of the keys", async () => {
      await renderOverlay({
        settings: { ...ON, tmuxConfigText: PASTED },
        rpc: answers(WITH_PASTED_TEXT),
      });

      expect(prefixLine()).toBe("Prefix: Ctrl-s, from the Config text setting");
      expect(sourceLine()).toBe(
        "The keys of stock tmux with ~/.tmux.conf and the Config text setting applied to them.",
      );
    });

    it("says in the key help that the config file chosen in the plugin's settings could not be read", async () => {
      await renderOverlay({
        rpc: answers({ ...STOCK_ANSWER, unreadable: true, namedFile: true }),
      });

      expect(prefixLine()).toBe(
        "Prefix: Ctrl-b, tmux's default (the tmux config could not be read)",
      );
      expect(sourceLine()).toBe(
        "The config file chosen in the plugin's settings could not be read, so these are the keys of stock tmux.",
      );
    });
  });
});

describe("while the plugin is switched off", () => {
  const TMUX_CALL = { method: "tmuxConfig", input: null };
  const SWITCHED_OFF = { enabled: false, tmuxConfigText: "set -g prefix C-a" };

  it.each([
    ["has none of its settings changed", {}],
    ["is switched off", SWITCHED_OFF],
  ])(
    "asks the server nothing, publishes nothing and waits for nothing when the plugin %s",
    async (_state, settings) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { sdk, config, subscribe } = configFakes();
      const view = await renderOverlay({
        settings,
        sdk,
        sidebarThreads: { threads: THREADS },
        sidebarSplitLayout: LAYOUT,
      });

      expect(vi.getTimerCount()).toBe(0);
      await act(() => vi.advanceTimersByTimeAsync(5000));

      expect(view.inspection.rpcCalls).toEqual([]);
      expect(getBridge()).toBeNull();
      expect(config).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(mocks.readSnapshot).not.toHaveBeenCalled();
      expect(mocks.decideRestore).not.toHaveBeenCalled();
      expect(mocks.writeSnapshot).not.toHaveBeenCalled();
      expect(view.inspection.navigateCalls).toEqual([]);
      expect(view.inspection.sdkCalls).toEqual([]);
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it("asks the server nothing when another config file is chosen or the connection comes back, and asks once it is switched on", async () => {
    const view = await renderOverlay({ settings: SWITCHED_OFF });

    await view.behavior.emitRealtime(CONFIG_FILE_CHANGED, {});
    await view.behavior.setRealtimeConnectionState("reconnecting");
    await view.behavior.setRealtimeConnectionState("connected");

    expect(view.inspection.rpcCalls).toEqual([]);
    expect(getBridge()).toBeNull();

    await changeSettings(view, ON);

    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
    expect(getBridge()).not.toBeNull();
  });

  it("does not mark the page for the rules of app.css, so that bb looks as it does without the plugin", async () => {
    await renderOverlay({ settings: {} });

    expect(document.documentElement.hasAttribute(SWITCHED_ON_ATTRIBUTE)).toBe(false);
  });

  it("does not mark the page while the settings are not known either", async () => {
    await renderOverlay({ settings: undefined });

    expect(document.documentElement.hasAttribute(SWITCHED_ON_ATTRIBUTE)).toBe(false);
  });

  it("marks the page while it is on, also before the keys are known, and takes the mark away when it is unmounted", async () => {
    const server = tmuxServer();
    const view = await renderOverlay({ rpc: server.rpc });
    expect(getBridge()).toBeNull();
    expect(document.documentElement.hasAttribute(SWITCHED_ON_ATTRIBUTE)).toBe(true);

    view.lifecycle.unmount();

    expect(document.documentElement.hasAttribute(SWITCHED_ON_ATTRIBUTE)).toBe(false);
  });

  it("forgets the thread that it would reopen after a restart, which is out of date after a time in which it was off", async () => {
    await renderOverlay({ settings: {} });

    expect(mocks.removeSnapshot).toHaveBeenCalledExactlyOnceWith(window.localStorage);
  });

  it.each([
    ["it is on", ON],
    ["the settings are not known", undefined],
  ])("keeps that thread while %s", async (_state, settings) => {
    await renderOverlay({ settings });

    expect(mocks.removeSnapshot).not.toHaveBeenCalled();
  });

  it("draws nothing, not even the prefix pill for a prefix flag that is set", async () => {
    const view = await renderOverlay({ settings: {} });

    act(() => updateUiState({ prefixArmed: true }));

    expect(view.container.innerHTML).toBe("");
    expect(document.body.children).toHaveLength(1);
  });

  it("tells the palette commands and the key handler that it is off, which it does not while the settings are not known", async () => {
    const view = await renderOverlay({ settings: {} });
    expect(getUiState().switchState).toBe("off");

    view.lifecycle.unmount();
    expect(getUiState().switchState).toBe("unknown");

    await renderOverlay({ settings: undefined });
    expect(getUiState().switchState).toBe("unknown");
  });

  it("does not say that it is off while it is on, with the keys known or not", async () => {
    const server = tmuxServer();
    await renderOverlay({ rpc: server.rpc });
    expect(getUiState().switchState).toBe("on");

    await server.answer(CONFIG_ANSWER);

    expect(getUiState().switchState).toBe("on");
  });

  it("still shows a notice, which is how a palette command says that the plugin is off", async () => {
    await renderOverlay({ settings: {} });

    act(() => showNotice("Tmux keys are off."));

    expect(mocks.toast).toHaveBeenCalledWith("Tmux keys are off.", {
      id: "tmux-notice",
    });
  });

  it("asks the server and publishes the keys as soon as it is switched on", async () => {
    const server = tmuxServer();
    const view = await renderOverlay({
      settings: {},
      rpc: server.rpc,
      sidebarThreads: { threads: THREADS },
    });

    await changeSettings(view, ON);

    expect(getUiState().switchState).toBe("on");
    expect(document.documentElement.hasAttribute(SWITCHED_ON_ATTRIBUTE)).toBe(true);
    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
    expect(getBridge()).toBeNull();

    await server.answer(CONFIG_ANSWER);

    expect(publishedBridge().settings.enabled).toBe(true);
    expect(publishedBridge().tmux).toEqual(CONFIG_ANSWER);
    expect(mocks.readSnapshot).toHaveBeenCalledTimes(1);
    act(() => updateUiState({ prefixArmed: true }));
    expect(screen.getByRole("status").textContent).toBe("Ctrl-a");
  });

  it("takes the bridge away in the step in which it is switched off, and stops watching bb's keybindings", async () => {
    const { sdk, unsubscribe } = configFakes();
    const view = await renderOverlay({
      rpc: { tmuxConfig: async () => CONFIG_ANSWER },
      sdk,
    });
    act(() => updateUiState({ prefixArmed: true }));
    expect(screen.getByRole("status").textContent).toBe("Ctrl-a");

    mocks.changedSettings.current = { ...DEFAULT_SETTINGS, enabled: false };
    view.lifecycle.rerender(<TmuxOverlay />);

    expect(getBridge()).toBeNull();
    expect(getUiState().switchState).toBe("off");
    expect(document.documentElement.hasAttribute(SWITCHED_ON_ATTRIBUTE)).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await flushEffects();

    expect(getBridge()).toBeNull();
    expect(mocks.removeSnapshot).toHaveBeenCalledTimes(1);
    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL]);
  });

  it("drops the answer of the server when it was switched off while the answer was awaited", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = tmuxServer();
    const view = await renderOverlay({ rpc: server.rpc });

    await changeSettings(view, { enabled: false });
    await server.answer(CONFIG_ANSWER);
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(getBridge()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks the server again when it is switched on again, and has no keys until the answer", async () => {
    const server = tmuxServer();
    const tmuxConfig = vi
      .fn<() => Promise<TmuxConfig>>()
      .mockResolvedValueOnce(STOCK_ANSWER)
      .mockImplementationOnce(server.rpc.tmuxConfig);
    const view = await renderOverlay({ rpc: { tmuxConfig } });
    expect(publishedBridge().tmux).toEqual(STOCK_ANSWER);

    await changeSettings(view, { enabled: false });
    await changeSettings(view, ON);

    expect(view.inspection.rpcCalls).toEqual([TMUX_CALL, TMUX_CALL]);
    expect(getBridge()).toBeNull();

    await server.answer(CONFIG_ANSWER);

    expect(publishedBridge().tmux).toEqual(CONFIG_ANSWER);
  });
});

describe("keybindings sync", () => {
  it("fetches bb's keybindings once and stores them", async () => {
    const { sdk, config } = configFakes();
    const view = await renderOverlay({ sdk });

    await waitFor(() =>
      expect(mocks.setKeybindings).toHaveBeenCalledWith(KEYBINDINGS),
    );
    view.lifecycle.rerender(<TmuxOverlay />);

    expect(config).toHaveBeenCalledTimes(1);
    expect(mocks.setKeybindings).toHaveBeenCalledTimes(1);
  });

  it("fetches again when bb reports a config change", async () => {
    const rebound = [{ ...KEYBINDINGS[0], command: "sidebar.toggle" }];
    const config = vi
      .fn()
      .mockResolvedValueOnce({ keybindings: KEYBINDINGS })
      .mockResolvedValueOnce({ keybindings: rebound });
    const { sdk, subscribe } = configFakes(config);
    await renderOverlay({ sdk });
    await waitFor(() => expect(mocks.setKeybindings).toHaveBeenCalledTimes(1));

    expect(subscribe).toHaveBeenCalledTimes(1);
    const [subscription] = subscribe.mock.calls[0];
    expect(subscription.event).toBe("system:config-changed");
    subscription.callback();

    await waitFor(() =>
      expect(mocks.setKeybindings).toHaveBeenLastCalledWith(rebound),
    );
    expect(config).toHaveBeenCalledTimes(2);
  });

  it("does not let an older answer replace a newer one", async () => {
    type Config = { keybindings: typeof KEYBINDINGS };
    const rebound = [{ ...KEYBINDINGS[0], command: "sidebar.toggle" }];
    const answers: ((value: Config) => void)[] = [];
    const config = vi.fn(
      () =>
        new Promise<Config>((resolve) => {
          answers.push(resolve);
        }),
    );
    const { sdk, subscribe } = configFakes(config);
    await renderOverlay({ sdk });
    subscribe.mock.calls[0][0].callback();
    expect(answers).toHaveLength(2);

    answers[1]({ keybindings: rebound });
    await waitFor(() => expect(mocks.setKeybindings).toHaveBeenCalledWith(rebound));
    answers[0]({ keybindings: KEYBINDINGS });
    await flushEffects();

    expect(mocks.setKeybindings).toHaveBeenCalledTimes(1);
  });

  it("stops listening on unmount and ignores a late response", async () => {
    type Config = { keybindings: typeof KEYBINDINGS };
    let resolveConfig: (value: Config) => void = () => {};
    const config = vi.fn(
      () =>
        new Promise<Config>((resolve) => {
          resolveConfig = resolve;
        }),
    );
    const { sdk, unsubscribe } = configFakes(config);
    const view = await renderOverlay({ sdk });

    view.lifecycle.unmount();
    resolveConfig({ keybindings: KEYBINDINGS });
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.setKeybindings).not.toHaveBeenCalled();
  });

  it("keeps the bridge alive when the keybindings cannot be read", async () => {
    await renderOverlay();

    await waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("reading bb's keybindings failed"),
        expect.anything(),
      ),
    );

    expect(mocks.setKeybindings).not.toHaveBeenCalled();
    expect(getBridge()).not.toBeNull();
  });
});

describe("cold-start repair", () => {
  it("reads the stored snapshot before it writes a fresh one", async () => {
    mocks.readSnapshot.mockReturnValue(STORED_SNAPSHOT);
    await renderOverlay({
      sidebarThreads: { threads: THREADS },
      sidebarSplitLayout: LAYOUT,
      context: { threadId: "thr-1" },
    });

    expect(mocks.readSnapshot).toHaveBeenCalledWith(window.localStorage);
    expect(mocks.buildSnapshot).toHaveBeenCalledWith(
      LAYOUT,
      "thr-1",
      expect.any(Number),
    );
    expect(mocks.writeSnapshot).toHaveBeenCalledWith(
      window.localStorage,
      FRESH_SNAPSHOT,
    );
    const [firstRead] = mocks.readSnapshot.mock.invocationCallOrder;
    const [decision] = mocks.decideRestore.mock.invocationCallOrder;
    const [firstWrite] = mocks.writeSnapshot.mock.invocationCallOrder;
    expect(firstRead).toBeLessThan(decision);
    expect(decision).toBeLessThan(firstWrite);
  });

  it("decides once with the stored snapshot and the current state", async () => {
    mocks.readSnapshot.mockReturnValue(STORED_SNAPSHOT);
    const view = await renderOverlay({
      sidebarThreads: { threads: THREADS },
      sidebarSplitLayout: LAYOUT,
    });
    view.lifecycle.rerender(<TmuxOverlay />);

    expect(mocks.decideRestore).toHaveBeenCalledTimes(1);
    expect(mocks.decideRestore).toHaveBeenCalledWith({
      snapshot: STORED_SNAPSHOT,
      layout: LAYOUT,
      contextThreadId: null,
      pathname: window.location.pathname,
      activeThreadIds: new Set(["thr-1", "thr-2"]),
    });
  });

  it("reopens the thread once when the decision names one", async () => {
    mocks.decideRestore.mockReturnValue("thr-2");
    const view = await renderOverlay({ sidebarThreads: { threads: THREADS } });
    view.lifecycle.rerender(<TmuxOverlay />);

    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr-2" },
    ]);
  });

  it("does not navigate when the decision is null", async () => {
    const view = await renderOverlay({ sidebarThreads: { threads: THREADS } });

    expect(mocks.decideRestore).toHaveBeenCalledTimes(1);
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("neither decides nor writes while the thread list is loading", async () => {
    mocks.readSnapshot.mockReturnValue(STORED_SNAPSHOT);
    mocks.decideRestore.mockReturnValue("thr-2");
    const view = await renderOverlay({ sidebarThreads: { status: "loading" } });

    expect(mocks.readSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.decideRestore).not.toHaveBeenCalled();
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("still starts writing snapshots when the decision throws", async () => {
    const consoleError = silenceConsoleError();
    mocks.decideRestore.mockImplementation(() => {
      throw new Error("boom");
    });
    const view = await renderOverlay({ sidebarThreads: { threads: THREADS } });

    expect(consoleError).toHaveBeenCalled();
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    expect(getBridge()).not.toBeNull();
  });
});

describe("prefix indicator", () => {
  it("shows the formatted prefix only while the prefix is armed", async () => {
    await renderOverlay();
    expect(screen.queryByRole("status")).toBeNull();

    act(() => updateUiState({ prefixArmed: true }));
    const pill = screen.getByRole("status");
    expect(pill.textContent).toBe("Ctrl-b");
    expect(pill.className).toContain("pointer-events-none");

    act(() => updateUiState({ prefixArmed: false }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the prefix of the tmux config", async () => {
    await renderOverlay({ rpc: { tmuxConfig: async () => CONFIG_ANSWER } });

    act(() => updateUiState({ prefixArmed: true }));

    expect(screen.getByRole("status").textContent).toBe("Ctrl-a");
  });

  it("shows the second prefix when that is the key that was pressed", async () => {
    await renderOverlay({
      rpc: { tmuxConfig: async () => tmuxConfigOf("set -g prefix2 M-s") },
    });

    act(() => updateUiState({ prefixArmed: true, prefixArmedBy: "M-s" }));
    expect(screen.getByRole("status").textContent).toBe("Alt-s");

    act(() => updateUiState({ prefixArmed: true, prefixArmedBy: "C-b" }));
    expect(screen.getByRole("status").textContent).toBe("Ctrl-b");
  });

  it.each([
    ["MacIntel", "Option-x"],
    ["Win32", "Alt-x"],
    ["Linux x86_64", "Alt-x"],
  ])("names the Alt key of a prefix for the platform %s: %s", async (platform, label) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    await renderOverlay({
      rpc: { tmuxConfig: async () => tmuxConfigOf("set -g prefix M-x") },
    });

    act(() => updateUiState({ prefixArmed: true }));

    expect(screen.getByRole("status").textContent).toBe(label);
  });
});

describe("copy mode", () => {
  const CURSOR: CursorRect = { left: 120, top: 48, width: 8, height: 18 };
  const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|rgb\(|hsl\(|oklch\(/i;

  function cursorBlock(): HTMLElement | null {
    return screen.queryByTestId("copy-cursor");
  }

  function enterCopyMode(cursor: CursorRect | null, selecting = false): void {
    act(() => updateUiState({ copyMode: { active: true, selecting, cursor } }));
  }

  it("shows neither the cursor block nor the pill while copy mode is off", async () => {
    await renderOverlay();

    expect(cursorBlock()).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("draws the cursor block at the rectangle from the store and follows it", async () => {
    await renderOverlay();

    enterCopyMode(CURSOR);
    const block = cursorBlock();
    expect(block?.style).toMatchObject({
      left: "120px",
      top: "48px",
      width: "8px",
      height: "18px",
    });

    enterCopyMode({ left: 16, top: 300, width: 2, height: 20 }, true);
    expect(cursorBlock()?.style).toMatchObject({
      left: "16px",
      top: "300px",
      width: "2px",
      height: "20px",
    });
  });

  it("keeps the block out of the way of the pointer and of screen readers", async () => {
    await renderOverlay();

    enterCopyMode(CURSOR);
    const block = cursorBlock();

    expect(block?.className).toContain("pointer-events-none");
    expect(block?.className).toContain("fixed");
    expect(block?.getAttribute("aria-hidden")).toBe("true");
    expect(block?.textContent).toBe("");
  });

  it("colours the block with a see-through theme token only", async () => {
    await renderOverlay();

    enterCopyMode(CURSOR);
    const block = cursorBlock();

    expect(block?.className).toMatch(/\bbg-[a-z-]+\/\d+\b/);
    expect(block?.className).not.toContain("dark:");
    expect(block?.className).not.toMatch(LITERAL_COLOUR);
    expect(block?.style.backgroundColor).toBe("");
  });

  it("draws no block while the cursor rectangle is unknown, and keeps the pill", async () => {
    await renderOverlay();

    enterCopyMode(null);

    expect(cursorBlock()).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("COPY");
  });

  it("shows COPY in the pill, and SELECT while selecting", async () => {
    await renderOverlay();

    enterCopyMode(CURSOR);
    const pill = screen.getByRole("status");
    expect(pill.textContent).toBe("COPY");
    expect(pill.className).toContain("pointer-events-none");

    enterCopyMode(CURSOR, true);
    expect(screen.getByRole("status").textContent).toBe("SELECT");

    enterCopyMode(CURSOR, false);
    expect(screen.getByRole("status").textContent).toBe("COPY");
  });

  it("removes the block and the pill when copy mode ends", async () => {
    await renderOverlay();
    enterCopyMode(CURSOR, true);

    act(() => updateUiState({ copyMode: { active: false } }));

    expect(cursorBlock()).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the mode pill above the prefix pill when both are up", async () => {
    await renderOverlay();
    enterCopyMode(CURSOR);

    act(() => updateUiState({ prefixArmed: true }));
    const [modePill, prefixPill] = screen.getAllByRole("status");

    expect(modePill.textContent).toBe("COPY");
    expect(prefixPill.textContent).toBe("Ctrl-b");
    expect(modePill.className).toContain("bottom-12");
    expect(prefixPill.className).toContain("bottom-4");
  });
});

describe("what a screen reader is told of the pills", () => {
  const CURSOR: CursorRect = { left: 120, top: 48, width: 8, height: 18 };

  function announcer(): HTMLElement {
    const region = screen.queryByTestId("pill-announcer");
    if (region === null) throw new Error("the live region is not in the page");
    return region;
  }

  function setCopyMode(selecting: boolean, cursor: CursorRect = CURSOR): void {
    act(() => updateUiState({ copyMode: { active: true, selecting, cursor } }));
  }

  function endCopyMode(): void {
    act(() => updateUiState({ copyMode: { active: false } }));
  }

  function setPrefix(isArmed: boolean, armedBy: string | null = null): void {
    act(() => updateUiState({ prefixArmed: isArmed, prefixArmedBy: armedBy }));
  }

  function pillTexts(): (string | null)[] {
    return screen.getAllByRole("status").map((pill) => pill.textContent);
  }

  it("has one polite live region in the page before any pill shows, with no text, hidden from the eye and no status of its own", async () => {
    await renderOverlay();

    const region = announcer();
    expect(region.textContent).toBe("");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.hasAttribute("aria-relevant")).toBe(false);
    expect(region.className).toBe("sr-only");
    expect(region.hasAttribute("aria-hidden")).toBe(false);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says \"Prefix armed\" when the prefix is armed, and nothing when it goes away", async () => {
    await renderOverlay();
    const region = announcer();
    const heard = listenToLiveRegion(region);

    setPrefix(true);
    expect(heard()).toEqual(["Prefix armed"]);
    expect(pillTexts()).toEqual(["Ctrl-b"]);

    setPrefix(false);
    expect(heard()).toEqual([]);
    expect(region.textContent).toBe("");

    setPrefix(true);
    expect(heard()).toEqual(["Prefix armed"]);
    expect(announcer()).toBe(region);
  });

  it("says nothing more while the prefix stays armed, also when another prefix key takes over, which only the pill names", async () => {
    await renderOverlay();
    const region = announcer();
    setPrefix(true);
    const heard = listenToLiveRegion(region);

    setPrefix(true, "M-s");

    expect(pillTexts()).toEqual(["Alt-s"]);
    expect(region.textContent).toBe("Prefix armed");
    expect(heard()).toEqual([]);
  });

  it("says \"Copy mode\" on entering copy mode, \"Copy mode, selecting\" when a selection starts, \"Copy mode\" when it is dropped, and \"Copy mode ended\" at the end", async () => {
    await renderOverlay();
    const region = announcer();
    const heard = listenToLiveRegion(region);

    setCopyMode(false);
    expect(heard()).toEqual(["Copy mode"]);
    expect(pillTexts()).toEqual(["COPY"]);

    setCopyMode(true);
    expect(heard()).toEqual(["Copy mode, selecting"]);
    expect(pillTexts()).toEqual(["SELECT"]);

    setCopyMode(false);
    expect(heard()).toEqual(["Copy mode"]);

    endCopyMode();
    expect(heard()).toEqual(["Copy mode ended"]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(announcer()).toBe(region);
  });

  it("says that copy mode ended when it ends with a selection under way as well", async () => {
    await renderOverlay();
    setCopyMode(true);
    const heard = listenToLiveRegion(announcer());

    endCopyMode();

    expect(heard()).toEqual(["Copy mode ended"]);
  });

  it("says the words for copy mode first and \"Prefix armed\" after them when both apply, and nothing when the prefix then goes away", async () => {
    await renderOverlay();
    const region = announcer();
    setCopyMode(true);
    const heard = listenToLiveRegion(region);

    setPrefix(true);
    expect(heard()).toEqual(["Copy mode, selecting, Prefix armed"]);
    expect(pillTexts()).toEqual(["SELECT", "Ctrl-b"]);

    setPrefix(false);
    expect(heard()).toEqual([]);
    expect(region.textContent).toBe("Copy mode, selecting");

    setCopyMode(false);
    expect(heard()).toEqual(["Copy mode"]);
  });

  it("says both when copy mode is entered while the prefix pill still shows, as within repeat-time", async () => {
    await renderOverlay();
    setPrefix(true);
    const heard = listenToLiveRegion(announcer());

    setCopyMode(false);

    expect(heard()).toEqual(["Copy mode, Prefix armed"]);
  });

  it("says that copy mode ended once: not again with the prefix that is armed after it", async () => {
    await renderOverlay();
    const region = announcer();
    setCopyMode(false);
    endCopyMode();
    const heard = listenToLiveRegion(region);

    setPrefix(true);
    expect(heard()).toEqual(["Prefix armed"]);

    setPrefix(false);
    expect(heard()).toEqual([]);
    expect(region.textContent).toBe("");

    setPrefix(true);
    expect(heard()).toEqual(["Prefix armed"]);
  });

  it("says that copy mode ended once when the prefix was armed at the time and goes away after it", async () => {
    await renderOverlay();
    const region = announcer();
    setCopyMode(false);
    setPrefix(true);
    const heard = listenToLiveRegion(region);

    endCopyMode();
    expect(heard()).toEqual(["Copy mode ended, Prefix armed"]);

    setPrefix(false);
    expect(heard()).toEqual([]);

    setPrefix(true);
    expect(heard()).toEqual(["Prefix armed"]);
    expect(region.textContent).toBe("Prefix armed");
  });

  it("says nothing of an end of copy mode that never began", async () => {
    await renderOverlay();
    const region = announcer();
    const heard = listenToLiveRegion(region);

    endCopyMode();
    setPrefix(false);

    expect(heard()).toEqual([]);
    expect(region.textContent).toBe("");
  });

  it("says nothing again on what changes nothing: a move of the cursor, the same state once more, the popup interface drawn anew", async () => {
    const view = await renderOverlay();
    const region = announcer();
    setCopyMode(true);
    setPrefix(true);
    const nodes = Array.from(region.childNodes);
    const heard = listenToLiveRegion(region);

    setCopyMode(true, { left: 16, top: 300, width: 2, height: 20 });
    setCopyMode(true, { left: 24, top: 300, width: 8, height: 20 });
    setPrefix(true);
    act(() => showNotice("Selection copied"));
    view.lifecycle.rerender(<TmuxOverlay />);

    expect(heard()).toEqual([]);
    expect(Array.from(region.childNodes)).toEqual(nodes);
    expect(region.textContent).toBe("Copy mode, selecting, Prefix armed");
  });

  it("does not name the prefix key, which the pill shows with the name of the Alt key", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await renderOverlay({
      rpc: { tmuxConfig: async () => tmuxConfigOf("set -g prefix M-x") },
    });

    setPrefix(true);

    expect(pillTexts()).toEqual(["Option-x"]);
    expect(announcer().textContent).toBe("Prefix armed");
  });

  it("is in the page while the plugin is on and the keys are not known yet, and says no prefix that the pill does not show", async () => {
    const server = tmuxServer();
    await renderOverlay({ rpc: server.rpc });
    const region = announcer();
    const heard = listenToLiveRegion(region);

    setPrefix(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(heard()).toEqual([]);
    expect(region.textContent).toBe("");

    await server.answer(STOCK_ANSWER);

    expect(announcer()).toBe(region);
    expect(heard()).toEqual(["Prefix armed"]);
  });

  it.each([
    ["is switched off", { enabled: false }],
    ["has none of its settings changed", {}],
    ["has no settings from bb yet", undefined],
  ])("is not in the page while the plugin %s", async (_state, settings) => {
    await renderOverlay({ settings });

    expect(screen.queryByTestId("pill-announcer")).toBeNull();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(0);
  });

  it("leaves the page when the plugin is switched off, and comes back empty when it is switched on again, with no end of copy mode left to say", async () => {
    const view = await renderOverlay();
    setCopyMode(false);
    endCopyMode();
    expect(announcer().textContent).toBe("Copy mode ended");

    await changeSettings(view, { enabled: false });
    expect(screen.queryByTestId("pill-announcer")).toBeNull();

    await changeSettings(view, ON);
    expect(announcer().textContent).toBe("");
  });
});

describe("notices", () => {
  it("shows each notice once as a bb toast", async () => {
    const view = await renderOverlay();
    expect(mocks.toast).not.toHaveBeenCalled();

    act(() => showNotice("bb allows at most 8 panes."));
    view.lifecycle.rerender(<TmuxOverlay />);

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith("bb allows at most 8 panes.", {
      id: "tmux-notice",
    });

    act(() => showNotice("bb allows at most 8 panes."));
    expect(mocks.toast).toHaveBeenCalledTimes(2);
  });
});

describe("a notice that is still the latest one when the popup interface is drawn anew", () => {
  it("is not shown a second time", async () => {
    const view = await renderOverlay();
    act(() => showNotice("The tmux config was read again."));
    expect(mocks.toast).toHaveBeenCalledTimes(1);

    view.lifecycle.unmount();
    await renderOverlay();

    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });
});

describe("popups", () => {
  it("opens the chooser and the help from the store", async () => {
    await renderOverlay({ sidebarThreads: { threads: THREADS } });
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => updateUiState({ chooser: { open: true, placement: "right" } }));
    expect(screen.getByRole("dialog", { name: "Thread chooser" })).toBeTruthy();
    act(() => updateUiState({ chooser: { open: false } }));

    act(() => updateUiState({ helpOpen: true }));
    expect(screen.getByRole("dialog", { name: HELP_TITLE })).toBeTruthy();
  });
});

describe("crash isolation", () => {
  it("keeps the bridge published when the visible UI crashes, and recovers", async () => {
    const consoleError = silenceConsoleError();
    mocks.chooserCrash.current = new Error("chooser crashed");
    await renderOverlay({ sidebarThreads: { threads: THREADS } });
    const bridge = publishedBridge();

    act(() => updateUiState({ chooser: { open: true, placement: "replace" } }));

    expect(getBridge()).toBe(bridge);
    expect(getUiState().chooser.open).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);

    act(() => updateUiState({ prefixArmed: true }));
    expect(screen.getByRole("status").textContent).toBe("Ctrl-b");
    expect(getBridge()).toBe(bridge);

    mocks.chooserCrash.current = null;
    act(() => updateUiState({ chooser: { open: true, placement: "replace" } }));
    expect(screen.getByRole("dialog", { name: "Thread chooser" })).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("gives the cursor to the focused pane when a popup crashes while it is open, which takes the element with the cursor with it", async () => {
    const consoleError = silenceConsoleError();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<main><div data-split-pane-id="pane-1" data-focused="true" tabindex="-1"></div><div data-split-pane-id="pane-2" data-focused="false" tabindex="-1"></div></main>',
    );
    const focusedPane = document.querySelector<HTMLElement>('[data-split-pane-id="pane-1"]');
    await renderOverlay({
      sidebarThreads: { threads: THREADS },
      sidebarSplitLayout: LAYOUT,
    });
    act(() => updateUiState({ chooser: { open: true, placement: "replace" } }));
    const list = screen.getByRole("listbox", { name: "Threads" });
    await waitFor(() => expect(document.activeElement).toBe(list));

    mocks.chooserCrash.current = new Error("chooser crashed");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });

    expect(consoleError).toHaveBeenCalled();
    expect(getUiState().chooser.open).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(focusedPane);
  });

  it("leaves a cursor in a text field where it is when a popup crashes before it has opened", async () => {
    silenceConsoleError();
    document.body.insertAdjacentHTML("beforeend", '<textarea id="notes"></textarea>');
    const notes = document.getElementById("notes");
    notes?.focus();
    mocks.chooserCrash.current = new Error("chooser crashed");
    await renderOverlay({ sidebarThreads: { threads: THREADS } });

    act(() => updateUiState({ chooser: { open: true, placement: "replace" } }));

    expect(getUiState().chooser.open).toBe(false);
    expect(document.activeElement).toBe(notes);
  });
});
