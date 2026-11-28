// @vitest-environment jsdom
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createFakePluginHost,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
  type MountedPluginContentScripts,
  type PluginRpcTestHandlers,
  type PluginSdkTestFakes,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";
import {
  act,
  cleanup,
  configure,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tmux from "../../server";
import { getBridge, getUiState, resetStore, updateUiState } from "../bridge";
import { rpcContract } from "../contract";
import { noteSidebarPointerDown } from "../dom-actions";
import { classifyFocus, detectSurface, isInTextField } from "../focus-context";
import { cancelPendingFocus } from "../pane-focus";
import {
  BROWSE_TITLE,
  CANCEL_LABEL,
  CONFIRM_LABEL,
  GO_LABEL,
  LIST_LABEL,
  PARENT_LABEL,
  PATH_BOX_LABEL,
} from "./BrowseDialog";
import { BROWSE_LABEL, USUAL_FILES_LABEL } from "./ConfigFileSection";

const app = await loadPluginApp(() => import("../../app"));

// The server part reads real folders and files here, which can take longer
// than the wait of the test library on a machine that is busy.
configure({ asyncUtilTimeout: 5000 });

type SettingValues = Record<string, string | number | boolean>;

// The page of the plugin in bb's Settings, as far as the plugin looks at it:
// the sidebar, and the main part with the built-in settings form. It has no
// pane and no conversation. The section of the plugin is drawn below it.
const BB_SETTINGS_PAGE = `
  <div data-variant="sidebar" data-state="expanded">
    <div data-sidebar="sidebar"><div data-testid="app-sidebar-body"></div></div>
  </div>
  <button data-sidebar="trigger" aria-expanded="true"></button>
  <main>
    <div data-testid="plugin-detail-tmux">
      <button role="switch" aria-checked="true" data-testid="enable-switch"></button>
      <textarea data-testid="config-text" aria-label="Config text"></textarea>
    </div>
  </main>
`;

const SETTINGS_ROUTE = "/settings/plugins/tmux";

const CHOSEN_CONFIG = [
  "set -g prefix C-s",
  "unbind C-b",
  "bind -n M-h select-pane -L",
  "bind -n F5 choose-tree",
  "bind e new-window",
  "",
].join("\n");

// The keys that the plugin takes on a button of the page with the chosen
// config: its prefix, the stock prefix, the keys after a prefix, its own i,
// and the keys that the config binds without the prefix.
const PLUGIN_KEYS: KeyboardEventInit[] = [
  { key: "s", ctrlKey: true },
  { key: "b", ctrlKey: true },
  { key: "%" },
  { key: "c" },
  { key: "?" },
  { key: "[" },
  { key: "i" },
  { key: "h", altKey: true },
  { key: "F5" },
  { key: "j" },
  { key: "q" },
];

let root: string;
let home: string;
let page: HTMLElement;
let server: FakePluginHarness;
let delivered: number;
let overlay: RenderedSlot | null;
let section: RenderedSlot | null;
let mounted: MountedPluginContentScripts | null;
let overlaySettings: SettingValues;
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

// The page calls the server part of the plugin itself, which reads the
// folders and files of the test.
function serverRpc(): PluginRpcTestHandlers<typeof rpcContract> {
  const call = (method: string) => (input: unknown) => server.callRpc(method, input);
  return {
    tmuxConfig: call("tmuxConfig"),
    listFolder: call("listFolder"),
    configFile: call("configFile"),
    setConfigFile: call("setConfigFile"),
  } as unknown as PluginRpcTestHandlers<typeof rpcContract>;
}

function renderOverlay(settings: SettingValues): void {
  overlaySettings = { ...settings };
  const sdk = {
    system: { config: async () => ({ keybindings: [] }) },
    subscribe: () => () => {},
  } as unknown as PluginSdkTestFakes;
  overlay = renderSlot(
    app.appOverlays[0],
    {},
    {
      sidebarThreads: { threads: [], projects: [] },
      context: { projectId: null, threadId: null },
      settings: overlaySettings,
      sdk,
      experimental_rpcContract: rpcContract,
      rpc: serverRpc(),
    },
  );
}

function renderSection(settings: SettingValues): void {
  section = renderSlot(
    app.settingsSections[0],
    {},
    { settings, experimental_rpcContract: rpcContract, rpc: serverRpc() },
  );
}

// One bb window that shows the page of the plugin: the overlay and the key
// handler of the plugin, and its settings section.
async function openSettingsWindow(settings: SettingValues = { enabled: true }): Promise<void> {
  renderOverlay(settings);
  renderSection(settings);
  mounted = await mountPluginContentScripts(app, { pluginId: "tmux" });
  await screen.findByRole("button", { name: BROWSE_LABEL });
  if (settings.enabled === true) await waitFor(() => expect(getBridge()).not.toBeNull());
}

// What bb does with a signal of the server part: every window gets it, a
// moment after the server part sent it.
async function serverSignalsArrive(): Promise<void> {
  const signals = server.realtimeSignals.slice(delivered);
  delivered = server.realtimeSignals.length;
  for (const { channel, payload } of signals) {
    for (const view of [overlay, section]) {
      if (view !== null) await view.behavior.emitRealtime(channel, payload);
    }
  }
}

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function clickWithMouse(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  fireEvent.click(element);
}

function browseButton(): HTMLElement {
  return screen.getByRole("button", { name: BROWSE_LABEL, hidden: true });
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: BROWSE_TITLE });
}

function list(): HTMLElement {
  return within(dialog()).getByRole("listbox", { name: LIST_LABEL });
}

function pathBox(): HTMLInputElement {
  return within(dialog()).getByRole<HTMLInputElement>("textbox", { name: PATH_BOX_LABEL });
}

// The row is looked for by its text: the name that the test library works
// out for a row has no blank at the end of the name of the entry.
async function row(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = within(dialog())
      .queryAllByRole("option")
      .find((option) => option.textContent?.startsWith(`${name},`));
    if (found === undefined) throw new Error(`the list has no row ${name}`);
    return found;
  });
}

async function openDialog(): Promise<void> {
  clickWithMouse(browseButton());
  await screen.findByRole("dialog", { name: BROWSE_TITLE });
  await waitFor(() => expect(list().getAttribute("aria-busy")).toBe("false"));
}

async function chooseInDialog(...names: string[]): Promise<void> {
  await openDialog();
  for (const name of names) clickWithMouse(await row(name));
  clickWithMouse(within(dialog()).getByRole("button", { name: CONFIRM_LABEL }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

function prefixOfKeys(): string | null {
  return getBridge()?.tmux.options.prefix?.key ?? null;
}

// The pill of the overlay that names the prefix key that was pressed.
function prefixPill(): string | null {
  if (overlay === null) return null;
  return within(overlay.container).getByRole("status").textContent;
}

function sectionText(): string {
  return section?.container.textContent ?? "";
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tmux-section-and-keys-"));
  home = join(root, "home");
  await mkdir(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
  vi.stubEnv("VISUAL", undefined);
  vi.stubEnv("EDITOR", undefined);
  expect(homedir()).toBe(home);
  await write(join(home, "dotfiles", "tmux.conf"), CHOSEN_CONFIG);
  await write(join(home, "notes.txt"), "notes\n");

  const host = createFakePluginHost({ pluginId: "tmux", settings: { enabled: true } });
  server = host.harness;
  tmux(host.bb);
  delivered = 0;
  overlay = null;
  section = null;
  mounted = null;

  window.history.replaceState(null, "", SETTINGS_ROUTE);
  consoleError = vi.spyOn(console, "error");
  consoleWarn = vi.spyOn(console, "warn");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  page = document.createElement("div");
  page.innerHTML = BB_SETTINGS_PAGE;
  document.body.append(page);
});

// The folders of the test and of the fake host are removed also when the
// test has written to the console, which fails it.
afterEach(async () => {
  try {
    if (mounted !== null && !mounted.inspection.disposed) await mounted.lifecycle.dispose();
    expect(consoleError.mock.calls).toEqual([]);
    expect(consoleWarn.mock.calls).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cancelPendingFocus();
    noteSidebarPointerDown(null);
    cleanup();
    resetStore();
    window.localStorage.clear();
    document.body.replaceChildren();
    await server.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

describe("registration", () => {
  it("registers the Config file section on the page of the plugin, below the built-in form", () => {
    expect(
      app.settingsSections.map(({ id, title, description }) => ({ id, title, description })),
    ).toEqual([
      {
        id: "config-file",
        title: "Config file",
        description:
          "The tmux config that the keys are read from, on the machine that runs the bb server.",
      },
    ]);
  });
});

describe("a choice in the settings section, with the server part and its real files", () => {
  it("changes the keys of the window without a reload", async () => {
    await openSettingsWindow();
    expect(getBridge()?.tmux).toMatchObject({ files: [], namedFile: false });
    expect(prefixOfKeys()).toBeNull();
    expect(press({ key: "s", ctrlKey: true }).defaultPrevented).toBe(false);

    await chooseInDialog("dotfiles", "tmux.conf");
    await serverSignalsArrive();

    await waitFor(() => expect(prefixOfKeys()).toBe("C-s"));
    expect(getBridge()?.tmux).toMatchObject({
      files: ["~/dotfiles/tmux.conf"],
      unreadable: false,
      namedFile: true,
    });
    expect(sectionText()).toContain(`In use: ${join(home, "dotfiles", "tmux.conf")}`);
    expect(press({ key: "b", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: "s", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(getUiState().prefixArmed).toBe(true);
    expect(prefixPill()).toBe("Ctrl-s");
    expect(mounted?.inspection.disposed).toBe(false);
    expect(mounted?.inspection.mountedIds).toEqual(["keys"]);
  });

  it("stores the file on the server part, which goes on reading it", async () => {
    await openSettingsWindow();

    await chooseInDialog("dotfiles", "tmux.conf");

    expect(await server.callRpc("configFile", null)).toEqual({
      file: { path: join(home, "dotfiles", "tmux.conf"), readable: true },
    });
    expect(server.realtimeSignals).toEqual([
      { channel: "config-file-changed", payload: {} },
    ]);
  });

  it("goes back to the keys of tmux's usual files when the choice is cleared", async () => {
    await write(join(home, ".tmux.conf"), "set -g prefix C-a\n");
    await server.callRpc("setConfigFile", { path: "~/dotfiles/tmux.conf" });
    delivered = server.realtimeSignals.length;
    await openSettingsWindow();
    expect(prefixOfKeys()).toBe("C-s");

    clickWithMouse(screen.getByRole("button", { name: USUAL_FILES_LABEL }));
    await waitFor(() => expect(sectionText()).toContain("In use: tmux's usual files"));
    await serverSignalsArrive();

    await waitFor(() => expect(prefixOfKeys()).toBe("C-a"));
    expect(getBridge()?.tmux).toMatchObject({ files: ["~/.tmux.conf"], namedFile: false });
    expect(press({ key: "s", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: "a", ctrlKey: true }).defaultPrevented).toBe(true);
  });

  it("follows a choice that is made without the settings page, as from the bb command line or in another bb window", async () => {
    await openSettingsWindow();

    await server.callRpc("setConfigFile", { path: "~/dotfiles/tmux.conf" });
    await serverSignalsArrive();

    await waitFor(() => expect(prefixOfKeys()).toBe("C-s"));
    await waitFor(() => expect(sectionText()).toContain("In use: ~/dotfiles/tmux.conf"));
  });

  it("changes the keys of a window that does not show the settings page", async () => {
    renderOverlay({ enabled: true });
    mounted = await mountPluginContentScripts(app, { pluginId: "tmux" });
    await waitFor(() => expect(getBridge()).not.toBeNull());

    await server.callRpc("setConfigFile", { path: "~/dotfiles/tmux.conf" });
    await serverSignalsArrive();

    await waitFor(() => expect(prefixOfKeys()).toBe("C-s"));
  });

  it("picks up a later change to the chosen file when the tmux config is read again", async () => {
    await openSettingsWindow();
    await chooseInDialog("dotfiles", "tmux.conf");
    await serverSignalsArrive();
    await waitFor(() => expect(prefixOfKeys()).toBe("C-s"));

    await write(join(home, "dotfiles", "tmux.conf"), "set -g prefix C-q\n");
    await act(async () => {
      await getBridge()?.reloadTmuxConfig();
    });

    expect(prefixOfKeys()).toBe("C-q");
  });

  it("names the chosen file in the key help as chosen in the plugin's settings", async () => {
    await openSettingsWindow();
    await chooseInDialog("dotfiles", "tmux.conf");
    await serverSignalsArrive();
    await waitFor(() => expect(prefixOfKeys()).toBe("C-s"));

    act(() => updateUiState({ helpOpen: true }));

    const help = await screen.findByRole("dialog", { name: "Tmux keys" });
    expect(within(help).getByText(/^Prefix: /).textContent).toBe(
      "Prefix: Ctrl-s, from ~/dotfiles/tmux.conf",
    );
    expect(within(help).getByText(/^The keys of stock tmux/).textContent).toBe(
      "The keys of stock tmux with ~/dotfiles/tmux.conf (chosen in the plugin's settings) applied to them.",
    );
  });

  it("opens a folder and chooses a file whose names end in a blank, and has the keys of that file and not of the file next to it", async () => {
    await write(join(home, "odd ", "tmux.conf"), "set -g prefix C-a\n");
    await write(join(home, "odd ", "tmux.conf "), CHOSEN_CONFIG);
    await openSettingsWindow();

    await chooseInDialog("odd ", "tmux.conf ");
    await serverSignalsArrive();

    await waitFor(() => expect(prefixOfKeys()).toBe("C-s"));
    expect(await server.callRpc("configFile", null)).toEqual({
      file: { path: join(home, "odd ", "tmux.conf "), readable: true },
    });
    expect(getBridge()?.tmux).toMatchObject({
      files: ["~/odd /tmux.conf "],
      unreadable: false,
      namedFile: true,
    });
  });

  it("does not store the file in use again, and tells no window, for an Enter that is still held down when the dialog opens", async () => {
    await server.callRpc("setConfigFile", { path: "~/dotfiles/tmux.conf" });
    delivered = server.realtimeSignals.length;
    await openSettingsWindow();
    await openDialog();
    await waitFor(() => expect(document.activeElement).toBe(list()));
    await waitFor(() => expect(list().getAttribute("aria-activedescendant")).not.toBeNull());

    press({ key: "Enter", repeat: true }, list());
    press({ key: "Enter", repeat: true }, list());
    await act(async () => {});

    expect(screen.queryByRole("dialog", { name: BROWSE_TITLE })).not.toBeNull();
    expect(server.realtimeSignals).toHaveLength(delivered);
    expect(await server.callRpc("configFile", null)).toEqual({
      file: { path: "~/dotfiles/tmux.conf", readable: true },
    });
  });

  it("takes the choice while the plugin is switched off, asks for no keys then, and has the keys of the chosen file as soon as it is switched on", async () => {
    await openSettingsWindow({ enabled: false });
    expect(getBridge()).toBeNull();

    await chooseInDialog("dotfiles", "tmux.conf");
    await serverSignalsArrive();

    expect(sectionText()).toContain(`In use: ${join(home, "dotfiles", "tmux.conf")}`);
    expect(getBridge()).toBeNull();
    expect(overlay?.inspection.rpcCalls).toEqual([]);

    Object.assign(overlaySettings, { enabled: true });
    const Overlay = app.appOverlays[0].component;
    overlay?.lifecycle.rerender(<Overlay />);

    await waitFor(() => expect(prefixOfKeys()).toBe("C-s"));
    expect(press({ key: "s", ctrlKey: true }).defaultPrevented).toBe(true);
  });
});

describe("the keys of the plugin on the settings page", () => {
  async function openWindowWithChosenConfig(settings: SettingValues = { enabled: true }): Promise<void> {
    await server.callRpc("setConfigFile", { path: "~/dotfiles/tmux.conf" });
    delivered = server.realtimeSignals.length;
    await openSettingsWindow(settings);
  }

  function dialogTargets(): [string, HTMLElement][] {
    return [
      ["the list", list()],
      ["the path box", pathBox()],
      ["the way up", within(dialog()).getByRole("button", { name: PARENT_LABEL })],
      ["Go", within(dialog()).getByRole("button", { name: GO_LABEL })],
      ["Cancel", within(dialog()).getByRole("button", { name: CANCEL_LABEL })],
      ["Use this file", within(dialog()).getByRole("button", { name: CONFIRM_LABEL })],
      ["the dialog itself", dialog()],
      ["the page behind the dialog", document.body],
      ["the Browse button behind the dialog", browseButton()],
    ];
  }

  function expectNothingOfThePluginHappened(): void {
    expect(getUiState()).toMatchObject({
      prefixArmed: false,
      chooser: { open: false },
      helpOpen: false,
      copyMode: { active: false },
      notice: null,
    });
    expect(overlay?.inspection.composer.focusCount).toBe(0);
    expect(overlay?.inspection.navigateCalls).toEqual([]);
  }

  it("counts the page as neither a thread nor the New thread screen", async () => {
    await openWindowWithChosenConfig();

    expect(detectSurface()).toBe("other");
  });

  it("counts the Browse button as a control like any button of bb, so the prefix works on it while the dialog is closed", async () => {
    await openWindowWithChosenConfig();
    browseButton().focus();

    expect(classifyFocus(browseButton())).toBe("control");
    expect(press({ key: "s", ctrlKey: true }, browseButton()).defaultPrevented).toBe(true);
    expect(getUiState().prefixArmed).toBe(true);
  });

  it("counts everything as part of a dialog while the Browse dialog is open: the path box, the list, its buttons and the page behind it", async () => {
    await openWindowWithChosenConfig();

    await openDialog();

    expect(isInTextField(pathBox())).toBe(true);
    for (const [, target] of dialogTargets()) {
      expect(classifyFocus(target)).toBe("overlay");
    }
  });

  it("acts on no key while the Browse dialog is open, wherever the cursor is, with the plugin switched on", async () => {
    await openWindowWithChosenConfig();
    await openDialog();

    for (const [where, target] of dialogTargets()) {
      target.focus();
      for (const key of PLUGIN_KEYS) {
        expect(
          press(key, target).defaultPrevented,
          `${JSON.stringify(key)} on ${where}`,
        ).toBe(false);
      }
    }

    expectNothingOfThePluginHappened();
    expect(screen.queryByRole("dialog", { name: BROWSE_TITLE })).not.toBeNull();
  });

  it("acts on no key while the path box has the cursor, with the plugin switched on", async () => {
    await openWindowWithChosenConfig();
    await openDialog();
    pathBox().focus();

    for (const key of PLUGIN_KEYS) {
      expect(press(key, pathBox()).defaultPrevented, JSON.stringify(key)).toBe(false);
    }

    expect(document.activeElement).toBe(pathBox());
    expectNothingOfThePluginHappened();
  });

  it("leaves the dialog its own keys while the plugin is switched on", async () => {
    await openWindowWithChosenConfig();
    await openDialog();
    list().focus();

    expect(press({ key: "ArrowDown" }, list()).defaultPrevented).toBe(true);
    expect(list().getAttribute("aria-activedescendant")).not.toBeNull();
    press({ key: "Escape" }, list());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expectNothingOfThePluginHappened();
  });

  it.each<[string, SettingValues]>([
    ["switched off", { enabled: false }],
    ["one whose settings were never changed", {}],
  ])("acts on no key in the section and in the dialog with a plugin that is %s", async (_state, settings) => {
    await openWindowWithChosenConfig(settings);
    browseButton().focus();
    for (const key of PLUGIN_KEYS) {
      expect(press(key, browseButton()).defaultPrevented, JSON.stringify(key)).toBe(false);
    }

    await openDialog();
    for (const [where, target] of dialogTargets()) {
      target.focus();
      for (const key of PLUGIN_KEYS) {
        expect(
          press(key, target).defaultPrevented,
          `${JSON.stringify(key)} on ${where}`,
        ).toBe(false);
      }
    }

    expect(getBridge()).toBeNull();
    expectNothingOfThePluginHappened();
  });

  it("takes its keys again once the dialog has closed", async () => {
    await openWindowWithChosenConfig();
    await openDialog();
    expect(press({ key: "s", ctrlKey: true }, list()).defaultPrevented).toBe(false);

    clickWithMouse(within(dialog()).getByRole("button", { name: CANCEL_LABEL }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(press({ key: "s", ctrlKey: true }, browseButton()).defaultPrevented).toBe(true);
  });
});
