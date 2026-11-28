// @vitest-environment jsdom
import {
  renderSlot,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract } from "../contract";
import { CONFIG_FILE_CHANGED } from "../settings";
import {
  BROWSE_DESCRIPTION,
  BROWSE_TITLE,
  CANCEL_LABEL,
  CONFIRM_LABEL,
  GO_LABEL,
  LIST_LABEL,
  NOT_STORED_TEXT,
  NOT_TAKEN_TEXT,
  NO_FILE_TEXT,
  PARENT_LABEL,
  PATH_BOX_HINT,
  PATH_BOX_LABEL,
} from "./BrowseDialog";
import {
  BROWSE_LABEL,
  ConfigFileSection,
  LOADING_TEXT,
  NOT_CLEARED_TEXT,
  RETRY_LABEL,
  UNKNOWN_TEXT,
  USUAL_FILES_LABEL,
} from "./ConfigFileSection";
import {
  FAKE_HOME,
  FAKE_TREE,
  fakeMachine,
  folderOfFiles,
  pendingAnswer,
  type FakeMachine,
  type FakeNode,
} from "./test-support";
import type { ConfigFileChange, ConfigFileChoice } from "../config-file";
import type { FolderListing } from "../folder-listing";

type SectionContract = Pick<
  typeof rpcContract,
  "listFolder" | "configFile" | "setConfigFile"
>;
type SectionOptions = RenderSlotOptions<SectionContract>;

const DOTFILES = `${FAKE_HOME}/dotfiles`;
const CHOSEN = `${DOTFILES}/tmux.conf`;
const EM_DASH = String.fromCharCode(0x2014);

const HOME_ROWS = [
  ".config, folder",
  "dotfiles, folder",
  "empty, folder",
  "locked, folder",
  ".tmux.conf, file",
  "notes.txt, file",
];

function flushEffects(): Promise<void> {
  return act(async () => {});
}

// The section as bb draws it on the page of the plugin, with the made-up
// machine in the place of the server part.
async function renderSection(
  machine: FakeMachine = fakeMachine(),
  options: SectionOptions = {},
) {
  const view = renderSlot(
    { component: ConfigFileSection },
    {},
    { experimental_rpcContract: rpcContract, rpc: machine.rpc, ...options },
  );
  await flushEffects();
  return view;
}

function browseButton(): HTMLElement {
  return screen.getByRole("button", { name: BROWSE_LABEL });
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: BROWSE_TITLE });
}

function list(): HTMLElement {
  return within(dialog()).getByRole("listbox", { name: LIST_LABEL });
}

function rows(): HTMLElement[] {
  return within(list()).queryAllByRole("option");
}

function rowNames(): (string | null)[] {
  return rows().map((row) => row.textContent);
}

function row(name: string): HTMLElement {
  const found = rows().find((candidate) => candidate.textContent?.startsWith(`${name},`));
  if (found === undefined) throw new Error(`the list has no row ${name}`);
  return found;
}

function highlightedRow(): string | null {
  const id = list().getAttribute("aria-activedescendant");
  const selected = rows().filter((candidate) => candidate.getAttribute("aria-selected") === "true");
  if (selected.length > 1) throw new Error("more than one row is selected");
  if (id === null) {
    if (selected.length > 0) throw new Error("a row is selected that the list does not name");
    return null;
  }
  const active = document.getElementById(id);
  if (active === null || active !== selected[0]) {
    throw new Error("the list names a row that is not the selected one");
  }
  return active.textContent;
}

function pathBox(): HTMLInputElement {
  return within(dialog()).getByRole<HTMLInputElement>("textbox", { name: PATH_BOX_LABEL });
}

function button(name: string): HTMLElement {
  return within(dialog()).getByRole("button", { name });
}

function statusLine(): string | null {
  return within(dialog()).getByRole("status").textContent;
}

function alertLine(): string | null {
  return within(dialog()).getByRole("alert").textContent;
}

// The click and the answer of the first listing stay inside one act, so
// that the list is drawn by the time this returns. A wait outside act would
// leave that render to React's scheduler, which can give up its turn first.
async function openDialog(): Promise<void> {
  await act(async () => {
    fireEvent.click(browseButton());
  });
  dialog();
}

async function click(element: HTMLElement): Promise<void> {
  fireEvent.click(element);
  await flushEffects();
}

async function pressOnFocused(key: string, init: KeyboardEventInit = {}): Promise<boolean> {
  const wasNotPrevented = fireEvent.keyDown(document.activeElement ?? document.body, {
    key,
    ...init,
  });
  await flushEffects();
  return wasNotPrevented;
}

async function typePath(path: string, confirm: "Enter" | "Go" | null = "Enter"): Promise<void> {
  fireEvent.change(pathBox(), { target: { value: path } });
  if (confirm === "Enter") fireEvent.keyDown(pathBox(), { key: "Enter" });
  if (confirm === "Go") fireEvent.click(button(GO_LABEL));
  await flushEffects();
}

function sectionText(view: { container: HTMLElement }): string {
  return view.container.textContent ?? "";
}

// A field of the page that is no part of the section, as the Config text
// field of the built-in form above it.
function fieldOutsideTheSection(): HTMLTextAreaElement {
  const field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
  return field;
}

function listingOf(path: string, tree: FakeNode = FAKE_TREE): Promise<FolderListing> {
  return fakeMachine({ tree }).rpc.listFolder({ path });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("the Config file section", () => {
  it("says that it is asking until the server part has answered", async () => {
    const answer = pendingAnswer<ConfigFileChoice>();
    const machine = fakeMachine();
    machine.rpc.configFile.mockReturnValueOnce(answer.promise);
    const view = await renderSection(machine);

    expect(screen.getByRole("status").textContent).toBe(LOADING_TEXT);
    expect(screen.queryByRole("button")).toBeNull();

    await act(async () => answer.answer({ file: null }));

    expect(sectionText(view)).toContain("In use: tmux's usual files");
  });

  it("names tmux's usual files with their three places while no file is chosen", async () => {
    const view = await renderSection();

    expect(screen.getByRole("status").textContent).toBe(
      "In use: tmux's usual files" +
        "~/.tmux.conf$XDG_CONFIG_HOME/tmux/tmux.conf~/.config/tmux/tmux.conf" +
        "Each of the three that exists is read, in this order. The second one only counts while XDG_CONFIG_HOME is set for the bb server.",
    );
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "~/.tmux.conf",
      "$XDG_CONFIG_HOME/tmux/tmux.conf",
      "~/.config/tmux/tmux.conf",
    ]);
    expect(sectionText(view)).toContain(
      "The Config text above is applied on top of these files.",
    );
  });

  it("offers Browse, and no way back to tmux's usual files while they are in use", async () => {
    await renderSection();

    expect(screen.getAllByRole("button").map((each) => each.textContent)).toEqual([
      BROWSE_LABEL,
    ]);
    expect(BROWSE_LABEL).toBe("Browse");
  });

  it("names the chosen file by its path as it was given, and says when a change to it is picked up", async () => {
    const view = await renderSection(fakeMachine({ chosen: "~/dotfiles/tmux.conf" }));

    expect(screen.getByRole("status").textContent).toBe(
      "In use: ~/dotfiles/tmux.conf" +
        "This file is read in the place of tmux's usual files. A change to it is picked up when a bb window loads, and on a key that you bound to source-file.",
    );
    expect(sectionText(view)).toContain(
      "The Config text above is applied on top of this file.",
    );
    expect(sectionText(view)).not.toContain("$XDG_CONFIG_HOME");
  });

  it("offers Browse and the way back to tmux's usual files while a file is chosen", async () => {
    await renderSection(fakeMachine({ chosen: CHOSEN }));

    expect(screen.getAllByRole("button").map((each) => each.textContent)).toEqual([
      BROWSE_LABEL,
      USUAL_FILES_LABEL,
    ]);
    expect(USUAL_FILES_LABEL).toBe("Use tmux's usual files");
  });

  it.each([
    ["is missing", `${FAKE_HOME}/gone.conf`],
    ["is a folder", DOTFILES],
    ["is not absolute", "dotfiles/tmux.conf"],
  ])("says that the chosen file cannot be read when it %s, and what the keys are then", async (_why, chosen) => {
    await renderSection(fakeMachine({ chosen }));

    expect(screen.getByRole("status").textContent).toBe(
      `In use: ${chosen}` +
        "This file cannot be read right now. tmux's usual files are not read in its place: until it can be read, you get the keys of stock tmux with the lines of the Config text setting, and the key help says so. Once it can be read again, reload the bb window or choose the file again.",
    );
  });

  it("says that a file that the bb server may not read cannot be read", async () => {
    const machine = fakeMachine({ chosen: CHOSEN });
    machine.makeUnreadable(CHOSEN);
    await renderSection(machine);

    expect(screen.getByRole("status").textContent).toContain(
      "This file cannot be read right now.",
    );
  });

  it("asks the server part once for the file in use, and for nothing else until Browse is pressed", async () => {
    const view = await renderSection();

    expect(view.inspection.rpcCalls).toEqual([{ method: "configFile", input: null }]);
  });

  it.each<[string, Record<string, boolean> | undefined]>([
    ["switched off", { enabled: false }],
    ["switched on", { enabled: true }],
    ["one whose settings bb does not know", undefined],
  ])("shows the file in use and takes a choice for a plugin that is %s", async (_state, settings) => {
    const machine = fakeMachine();
    const view = await renderSection(machine, { settings });
    expect(sectionText(view)).toContain("In use: tmux's usual files");

    await openDialog();
    await click(row("dotfiles"));
    await click(row("tmux.conf"));
    await click(button(CONFIRM_LABEL));

    expect(machine.chosen()).toBe(CHOSEN);
    expect(sectionText(view)).toContain(`In use: ${CHOSEN}`);
  });

  describe("going back to tmux's usual files", () => {
    it("clears the choice on the server part, shows tmux's usual files and puts the cursor on Browse", async () => {
      const machine = fakeMachine({ chosen: CHOSEN });
      const view = await renderSection(machine);
      const back = screen.getByRole("button", { name: USUAL_FILES_LABEL });
      back.focus();

      await click(back);

      expect(view.inspection.rpcCalls.at(-1)).toEqual({
        method: "setConfigFile",
        input: { path: null },
      });
      expect(machine.chosen()).toBeNull();
      expect(sectionText(view)).toContain("In use: tmux's usual files");
      expect(screen.queryByRole("button", { name: USUAL_FILES_LABEL })).toBeNull();
      expect(document.activeElement).toBe(browseButton());
    });

    it("says so when the server part does not answer, and keeps the choice", async () => {
      const machine = fakeMachine({ chosen: CHOSEN });
      machine.rpc.setConfigFile.mockRejectedValueOnce(new Error("no server"));
      const view = await renderSection(machine);

      await click(screen.getByRole("button", { name: USUAL_FILES_LABEL }));

      expect(screen.getByRole("alert").textContent).toBe(NOT_CLEARED_TEXT);
      expect(sectionText(view)).toContain(`In use: ${CHOSEN}`);
      expect(screen.getByRole("button", { name: USUAL_FILES_LABEL })).toBeTruthy();

      await click(screen.getByRole("button", { name: USUAL_FILES_LABEL }));

      expect(screen.queryByRole("alert")).toBeNull();
      expect(sectionText(view)).toContain("In use: tmux's usual files");
    });

    it("leaves the cursor where it went while the server part was answering", async () => {
      const answer = pendingAnswer<ConfigFileChange>();
      const machine = fakeMachine({ chosen: CHOSEN });
      machine.rpc.setConfigFile.mockReturnValueOnce(answer.promise);
      const view = await renderSection(machine);
      const back = screen.getByRole("button", { name: USUAL_FILES_LABEL });
      back.focus();
      await click(back);
      const field = fieldOutsideTheSection();

      await act(async () => answer.answer({ ok: true, file: null }));

      expect(sectionText(view)).toContain("In use: tmux's usual files");
      expect(document.activeElement).toBe(field);
    });

    it("leaves the cursor alone when the button was pressed without the cursor on it, as with the mouse in a browser that does not move it", async () => {
      const view = await renderSection(fakeMachine({ chosen: CHOSEN }));

      await click(screen.getByRole("button", { name: USUAL_FILES_LABEL }));

      expect(sectionText(view)).toContain("In use: tmux's usual files");
      expect(document.activeElement).toBe(document.body);
    });

    it("clears once for a button that is pressed twice", async () => {
      const answer = pendingAnswer<ConfigFileChange>();
      const machine = fakeMachine({ chosen: CHOSEN });
      machine.rpc.setConfigFile.mockReturnValueOnce(answer.promise);
      await renderSection(machine);
      const back = screen.getByRole("button", { name: USUAL_FILES_LABEL });

      await click(back);
      await click(back);

      expect(machine.rpc.setConfigFile).toHaveBeenCalledTimes(1);
      expect(back.getAttribute("aria-disabled")).toBe("true");
      await act(async () => answer.answer({ ok: true, file: null }));
    });
  });

  describe("when the server part does not answer", () => {
    it("says that the file in use is not known, and asks again on Try again", async () => {
      const machine = fakeMachine({ chosen: CHOSEN });
      machine.rpc.configFile.mockRejectedValueOnce(new Error("no server"));
      const view = await renderSection(machine);

      expect(screen.getByRole("alert").textContent).toBe(UNKNOWN_TEXT);
      expect(screen.getAllByRole("button").map((each) => each.textContent)).toEqual([
        RETRY_LABEL,
      ]);

      screen.getByRole("button", { name: RETRY_LABEL }).focus();
      await click(screen.getByRole("button", { name: RETRY_LABEL }));

      expect(screen.queryByRole("alert")).toBeNull();
      expect(sectionText(view)).toContain(`In use: ${CHOSEN}`);
      expect(document.activeElement).toBe(browseButton());
    });

    it("goes on saying so when the server part does not answer the next question either", async () => {
      const machine = fakeMachine();
      machine.rpc.configFile.mockRejectedValue(new Error("no server"));
      await renderSection(machine);

      await click(screen.getByRole("button", { name: RETRY_LABEL }));

      expect(screen.getByRole("alert").textContent).toBe(UNKNOWN_TEXT);
      expect(machine.rpc.configFile).toHaveBeenCalledTimes(2);
    });

    it("does not pull the cursor out of another field when the file in use becomes known after a Try again that failed", async () => {
      const machine = fakeMachine();
      machine.rpc.configFile
        .mockRejectedValueOnce(new Error("no server"))
        .mockRejectedValueOnce(new Error("no server"));
      const view = await renderSection(machine);
      screen.getByRole("button", { name: RETRY_LABEL }).focus();
      await click(screen.getByRole("button", { name: RETRY_LABEL }));
      expect(screen.getByRole("alert").textContent).toBe(UNKNOWN_TEXT);
      const field = fieldOutsideTheSection();

      await view.behavior.setRealtimeConnectionState("reconnecting");
      await view.behavior.setRealtimeConnectionState("connected");

      expect(browseButton()).toBeTruthy();
      expect(document.activeElement).toBe(field);
    });

    it("does not pull the cursor out of another field when Try again is answered late", async () => {
      const answer = pendingAnswer<ConfigFileChoice>();
      const machine = fakeMachine();
      machine.rpc.configFile
        .mockRejectedValueOnce(new Error("no server"))
        .mockReturnValueOnce(answer.promise);
      await renderSection(machine);
      screen.getByRole("button", { name: RETRY_LABEL }).focus();
      await click(screen.getByRole("button", { name: RETRY_LABEL }));
      const field = fieldOutsideTheSection();

      await act(async () => answer.answer({ file: null }));

      expect(browseButton()).toBeTruthy();
      expect(document.activeElement).toBe(field);
    });

    it("moves the cursor from Try again to Browse when the file in use becomes known in another way while the cursor is on it", async () => {
      const machine = fakeMachine();
      machine.rpc.configFile.mockRejectedValueOnce(new Error("no server"));
      const view = await renderSection(machine);
      screen.getByRole("button", { name: RETRY_LABEL }).focus();

      await view.behavior.emitRealtime(CONFIG_FILE_CHANGED, {});

      expect(document.activeElement).toBe(browseButton());
    });

    it("does not move the cursor when the file in use becomes known without Try again", async () => {
      const machine = fakeMachine();
      machine.rpc.configFile.mockRejectedValueOnce(new Error("no server"));
      const view = await renderSection(machine);

      await view.behavior.emitRealtime(CONFIG_FILE_CHANGED, {});

      expect(sectionText(view)).toContain("In use: tmux's usual files");
      expect(document.activeElement).toBe(document.body);
    });

    it("keeps what it shows when a later question fails", async () => {
      const machine = fakeMachine({ chosen: CHOSEN });
      const view = await renderSection(machine);
      machine.rpc.configFile.mockRejectedValueOnce(new Error("no server"));

      await view.behavior.emitRealtime(CONFIG_FILE_CHANGED, {});

      expect(sectionText(view)).toContain(`In use: ${CHOSEN}`);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  describe("when the file is chosen elsewhere", () => {
    it("asks again when the server part says that another file was chosen, as it does for a choice in another bb window", async () => {
      const machine = fakeMachine();
      const view = await renderSection(machine);
      machine.choose(CHOSEN);

      await view.behavior.emitRealtime(CONFIG_FILE_CHANGED, {});

      expect(sectionText(view)).toContain(`In use: ${CHOSEN}`);
      expect(screen.getByRole("button", { name: USUAL_FILES_LABEL })).toBeTruthy();
    });

    it("asks nothing for a signal on another channel", async () => {
      const machine = fakeMachine();
      const view = await renderSection(machine);

      await view.behavior.emitRealtime("something-else", {});

      expect(machine.rpc.configFile).toHaveBeenCalledTimes(1);
    });

    it("asks again when the connection to the server comes back, because a signal sent meanwhile is lost", async () => {
      const machine = fakeMachine();
      const view = await renderSection(machine);
      await view.behavior.setRealtimeConnectionState("reconnecting");
      machine.choose(CHOSEN);

      await view.behavior.setRealtimeConnectionState("connected");

      expect(machine.rpc.configFile).toHaveBeenCalledTimes(2);
      expect(sectionText(view)).toContain(`In use: ${CHOSEN}`);
    });

    it("asks again when the connection comes back for a section that was opened while bb was reconnecting", async () => {
      const machine = fakeMachine();
      const view = await renderSection(machine, { realtimeConnectionState: "reconnecting" });
      expect(sectionText(view)).toContain("In use: tmux's usual files");
      machine.choose(CHOSEN);

      await view.behavior.setRealtimeConnectionState("connected");

      expect(machine.rpc.configFile).toHaveBeenCalledTimes(2);
      expect(sectionText(view)).toContain(`In use: ${CHOSEN}`);
    });

    it("leaves Try again behind when the connection comes back for a section whose first question failed while bb was reconnecting", async () => {
      const machine = fakeMachine({ chosen: CHOSEN });
      machine.rpc.configFile.mockRejectedValueOnce(new Error("no server"));
      const view = await renderSection(machine, { realtimeConnectionState: "reconnecting" });
      expect(screen.getByRole("alert").textContent).toBe(UNKNOWN_TEXT);

      await view.behavior.setRealtimeConnectionState("connected");

      expect(screen.queryByRole("button", { name: RETRY_LABEL })).toBeNull();
      expect(sectionText(view)).toContain(`In use: ${CHOSEN}`);
    });

    it("asks once for a section that was opened while bb connected for the first time", async () => {
      const machine = fakeMachine();
      const view = await renderSection(machine, { realtimeConnectionState: "connecting" });

      await view.behavior.setRealtimeConnectionState("connected");

      expect(machine.rpc.configFile).toHaveBeenCalledTimes(1);
    });

    it("does not let the late answer to an older question replace a newer one", async () => {
      const first = pendingAnswer<ConfigFileChoice>();
      const machine = fakeMachine({ chosen: CHOSEN });
      machine.rpc.configFile.mockReturnValueOnce(first.promise);
      const view = await renderSection(machine);

      await view.behavior.emitRealtime(CONFIG_FILE_CHANGED, {});
      await act(async () => first.answer({ file: null }));

      expect(sectionText(view)).toContain(`In use: ${CHOSEN}`);
    });

    it("does not let an answer that was asked for before a choice replace that choice", async () => {
      const late = pendingAnswer<ConfigFileChoice>();
      const machine = fakeMachine();
      const view = await renderSection(machine);
      machine.rpc.configFile.mockReturnValueOnce(late.promise);
      await view.behavior.emitRealtime(CONFIG_FILE_CHANGED, {});

      await openDialog();
      await click(row("dotfiles"));
      await click(row("tmux.conf"));
      await click(button(CONFIRM_LABEL));
      await act(async () => late.answer({ file: null }));

      expect(sectionText(view)).toContain(`In use: ${CHOSEN}`);
    });
  });

  it("never uses an em dash", async () => {
    const view = await renderSection(fakeMachine({ chosen: `${FAKE_HOME}/gone.conf` }));
    await openDialog();

    expect(document.body.textContent).not.toContain(EM_DASH);
    expect(sectionText(view)).not.toContain(EM_DASH);
  });
});

describe("the Browse dialog", () => {
  describe("when it opens", () => {
    it("stays closed until Browse is pressed", async () => {
      await renderSection();

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(browseButton().getAttribute("aria-haspopup")).toBe("dialog");
      expect(browseButton().getAttribute("aria-expanded")).toBe("false");
    });

    it("is a dialog with a title and a description that say what it lists and where", async () => {
      await renderSection();

      await openDialog();

      expect(dialog().getAttribute("role")).toBe("dialog");
      expect(BROWSE_TITLE).toBe("Choose a tmux config file");
      const describedBy = dialog().getAttribute("aria-describedby") ?? "";
      expect(document.getElementById(describedBy)?.textContent).toBe(BROWSE_DESCRIPTION);
      expect(BROWSE_DESCRIPTION).toContain("the machine that runs the bb server");
      expect(BROWSE_DESCRIPTION).toContain("hidden ones included");
    });

    it("hides the rest of the page from a screen reader while it is open, and marks Browse as expanded", async () => {
      await renderSection();

      await openDialog();

      expect(screen.queryByRole("button", { name: BROWSE_LABEL })).toBeNull();
      expect(
        screen
          .getByRole("button", { name: BROWSE_LABEL, hidden: true })
          .getAttribute("aria-expanded"),
      ).toBe("true");
    });

    it("starts in the home folder while no file is chosen, and lists its folders and then its files by name, hidden ones too", async () => {
      const machine = fakeMachine();
      await renderSection(machine);

      await openDialog();

      expect(machine.rpc.listFolder.mock.calls).toEqual([[{ path: "~" }]]);
      expect(pathBox().value).toBe(FAKE_HOME);
      expect(rowNames()).toEqual(HOME_ROWS);
      expect(statusLine()).toBe("4 folders and 2 files.");
    });

    it("puts the cursor into the list, with no row highlighted and no file chosen", async () => {
      await renderSection();

      await openDialog();

      await waitFor(() => expect(document.activeElement).toBe(list()));
      expect(highlightedRow()).toBeNull();
      expect(within(dialog()).getByText(NO_FILE_TEXT)).toBeTruthy();
      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", true);
    });

    it.each([CHOSEN, "~/dotfiles/tmux.conf"])(
      "starts in the folder of the file in use %s, with that file highlighted and ready to be confirmed",
      async (chosen) => {
        await renderSection(fakeMachine({ chosen }));

        await openDialog();

        expect(pathBox().value).toBe(DOTFILES);
        expect(rowNames()).toEqual(["nested, folder", "other.conf, file", "tmux.conf, file"]);
        expect(highlightedRow()).toBe("tmux.conf, file");
        expect(within(dialog()).getByText(CHOSEN)).toBeTruthy();
        expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", false);
      },
    );

    it("has the file in use chosen also when the list of its folder was cut before it", async () => {
      const tree: FakeNode = { home: { me: { many: folderOfFiles(8) } } };
      const chosen = `${FAKE_HOME}/many/file-0007.conf`;
      await renderSection(fakeMachine({ tree, maxEntries: 5, chosen }));

      await openDialog();

      expect(pathBox().value).toBe(`${FAKE_HOME}/many`);
      expect(highlightedRow()).toBeNull();
      expect(within(dialog()).getByText(chosen)).toBeTruthy();
      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", false);
    });

    it("starts in the folder that held the file in use when that file is gone", async () => {
      await renderSection(fakeMachine({ chosen: `${DOTFILES}/gone.conf` }));

      await openDialog();

      expect(pathBox().value).toBe(DOTFILES);
      expect(highlightedRow()).toBeNull();
      expect(within(dialog()).queryByRole("alert")).toBeNull();
    });

    it.each([`${FAKE_HOME}/gone/tmux.conf`, "dotfiles/tmux.conf", `${FAKE_HOME}/locked/tmux.conf`])(
      "starts in the home folder when neither the file in use %s nor its folder can be listed",
      async (chosen) => {
        await renderSection(fakeMachine({ chosen }));

        await openDialog();

        expect(pathBox().value).toBe(FAKE_HOME);
        expect(rowNames()).toEqual(HOME_ROWS);
      },
    );

    it("starts in the folder itself when a folder is stored as the file in use", async () => {
      await renderSection(fakeMachine({ chosen: DOTFILES }));

      await openDialog();

      expect(pathBox().value).toBe(DOTFILES);
      expect(highlightedRow()).toBeNull();
    });

    it("names the home folder in the path box when it cannot be listed", async () => {
      const tree: FakeNode = { home: { me: "locked" } };
      await renderSection(fakeMachine({ tree }));

      await openDialog();

      expect(alertLine()).toBe("The bb server may not read this folder.");
      expect(pathBox().value).toBe(FAKE_HOME);
    });

    it("opens on a file in use whose name ends in a blank", async () => {
      const tree: FakeNode = { home: { me: { twins: { "tmux.conf": "file", "tmux.conf ": "file" } } } };
      const chosen = `${FAKE_HOME}/twins/tmux.conf `;
      const machine = fakeMachine({ tree, chosen });
      await renderSection(machine);

      await openDialog();

      expect(machine.rpc.listFolder.mock.calls[0]).toEqual([{ path: chosen }]);
      expect(highlightedRow()).toBe("tmux.conf , file");
    });

    it("keeps what is typed into the path box while the first listing is under way, and leaves the cursor there", async () => {
      const first = pendingAnswer<FolderListing>();
      const machine = fakeMachine();
      machine.rpc.listFolder.mockReturnValueOnce(first.promise);
      await renderSection(machine);
      await openDialog();
      pathBox().focus();
      fireEvent.change(pathBox(), { target: { value: "~/dotf" } });

      await act(async () => first.answer(await listingOf("~")));

      expect(rowNames()).toEqual(HOME_ROWS);
      expect(pathBox().value).toBe("~/dotf");
      expect(document.activeElement).toBe(pathBox());
    });

    it("says that it is listing until the server part has answered, and marks the list as busy", async () => {
      const answer = pendingAnswer<FolderListing>();
      const machine = fakeMachine();
      machine.rpc.listFolder.mockReturnValueOnce(answer.promise);
      await renderSection(machine);

      await openDialog();

      expect(statusLine()).toBe("Listing the folder.");
      expect(list().getAttribute("aria-busy")).toBe("true");
      expect(rows()).toEqual([]);

      await act(async () =>
        answer.answer({ ok: true, path: "/", parent: null, entries: [], truncated: false }),
      );

      expect(list().getAttribute("aria-busy")).toBe("false");
      expect(statusLine()).toBe("There are no folders or files in this folder.");
    });
  });

  describe("moving through folders", () => {
    it("lists a folder that is pressed, and shows its path in the path box", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();

      await click(row("dotfiles"));

      expect(machine.rpc.listFolder.mock.calls.at(-1)).toEqual([{ path: DOTFILES }]);
      expect(pathBox().value).toBe(DOTFILES);
      expect(rowNames()).toEqual(["nested, folder", "other.conf, file", "tmux.conf, file"]);
      expect(statusLine()).toBe("1 folder and 2 files.");
      expect(highlightedRow()).toBeNull();
    });

    it("goes up to the parent folder, and highlights the folder it came from", async () => {
      await renderSection();
      await openDialog();
      await click(row("dotfiles"));
      await click(row("nested"));
      expect(pathBox().value).toBe(`${DOTFILES}/nested`);

      await click(button(PARENT_LABEL));

      expect(pathBox().value).toBe(DOTFILES);
      expect(highlightedRow()).toBe("nested, folder");

      await click(button(PARENT_LABEL));

      expect(pathBox().value).toBe(FAKE_HOME);
      expect(highlightedRow()).toBe("dotfiles, folder");
      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", true);
    });

    it("goes up as far as the top folder, where the way up is marked as unavailable and does nothing", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      expect(button(PARENT_LABEL).getAttribute("aria-disabled")).toBe("false");

      await click(button(PARENT_LABEL));
      await click(button(PARENT_LABEL));

      expect(pathBox().value).toBe("/");
      expect(rowNames()).toEqual(["home, folder"]);
      expect(button(PARENT_LABEL).getAttribute("aria-disabled")).toBe("true");
      expect(button(PARENT_LABEL)).toHaveProperty("disabled", false);
      const calls = machine.rpc.listFolder.mock.calls.length;

      await click(button(PARENT_LABEL));

      expect(machine.rpc.listFolder).toHaveBeenCalledTimes(calls);
      expect(pathBox().value).toBe("/");
    });

    it("opens a folder of the top folder with one slash", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      await typePath("/");

      await click(row("home"));

      expect(machine.rpc.listFolder.mock.calls.at(-1)).toEqual([{ path: "/home" }]);
    });

    it("says that a folder is empty", async () => {
      await renderSection();
      await openDialog();

      await click(row("empty"));

      expect(rows()).toEqual([]);
      expect(statusLine()).toBe("There are no folders or files in this folder.");
    });

    it("opens a folder whose name ends in a blank by its whole name", async () => {
      const tree: FakeNode = { home: { me: { trail: {}, "trail ": { "inside.conf": "file" } } } };
      const machine = fakeMachine({ tree });
      await renderSection(machine);
      await openDialog();
      expect(rowNames()).toEqual(["trail, folder", "trail , folder"]);

      await click(row("trail "));

      expect(machine.rpc.listFolder.mock.calls.at(-1)).toEqual([{ path: `${FAKE_HOME}/trail ` }]);
      expect(pathBox().value).toBe(`${FAKE_HOME}/trail `);
      expect(rowNames()).toEqual(["inside.conf, file"]);
    });

    it("says that it is listing while a folder that was pressed is under way, and what the folder holds after that", async () => {
      const slow = pendingAnswer<FolderListing>();
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      machine.rpc.listFolder.mockReturnValueOnce(slow.promise);

      await click(row("dotfiles"));

      expect(statusLine()).toBe("Listing the folder.");
      expect(list().getAttribute("aria-busy")).toBe("true");

      await act(async () => slow.answer(await listingOf(DOTFILES)));

      expect(statusLine()).toBe("1 folder and 2 files.");
      expect(list().getAttribute("aria-busy")).toBe("false");
    });

    it("says that it is listing, and no longer that a folder could not be read, while the next folder is under way", async () => {
      const slow = pendingAnswer<FolderListing>();
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      await click(row("locked"));
      machine.rpc.listFolder.mockReturnValueOnce(slow.promise);

      await click(button(PARENT_LABEL));

      expect(within(dialog()).queryByRole("alert")).toBeNull();
      expect(statusLine()).toBe("Listing the folder.");

      await act(async () => slow.answer(await listingOf("~")));

      expect(statusLine()).toBe("4 folders and 2 files.");
    });

    it("keeps what is typed into the path box while a folder that was pressed is under way", async () => {
      const slow = pendingAnswer<FolderListing>();
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      machine.rpc.listFolder.mockReturnValueOnce(slow.promise);
      await click(row("dotfiles"));
      pathBox().focus();
      fireEvent.change(pathBox(), { target: { value: "/etc/tm" } });

      await act(async () => slow.answer(await listingOf(DOTFILES)));

      expect(rowNames()).toEqual(["nested, folder", "other.conf, file", "tmux.conf, file"]);
      expect(pathBox().value).toBe("/etc/tm");
      expect(document.activeElement).toBe(pathBox());
    });

    it("says that the bb server may not read a folder, names that folder in the path box, and still knows the way up from it", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();

      await click(row("locked"));

      expect(alertLine()).toBe("The bb server may not read this folder.");
      expect(pathBox().value).toBe(`${FAKE_HOME}/locked`);
      expect(within(dialog()).queryByRole("status")).toBeNull();
      expect(rows()).toEqual([]);
      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", true);

      await click(button(GO_LABEL));

      expect(machine.rpc.listFolder.mock.calls.at(-1)).toEqual([{ path: `${FAKE_HOME}/locked` }]);
      expect(alertLine()).toBe("The bb server may not read this folder.");

      await click(button(PARENT_LABEL));

      expect(within(dialog()).queryByRole("alert")).toBeNull();
      expect(pathBox().value).toBe(FAKE_HOME);
      expect(rowNames()).toEqual(HOME_ROWS);
    });

    it("says that a long list was cut, after how many entries, and how to reach the rest", async () => {
      const tree: FakeNode = { home: { me: { many: folderOfFiles(8), sub: {} } } };
      await renderSection(fakeMachine({ tree, maxEntries: 5 }));
      await openDialog();

      await click(row("many"));

      expect(rows()).toHaveLength(5);
      expect(statusLine()).toBe(
        "No folders and 5 files are listed. This folder holds more: the list was cut after its first 5 entries. To reach an entry that is not listed, type or paste its path into the path box.",
      );
    });

    it("lists 2000 entries, as many as the server part hands out at most", { timeout: 20_000 }, async () => {
      const tree: FakeNode = { home: { me: folderOfFiles(2001) } };
      await renderSection(fakeMachine({ tree }));

      await openDialog();

      expect(rows()).toHaveLength(2000);
      expect(statusLine()).toContain("the list was cut after its first 2000 entries");
    });

    it("does not call a folder empty whose list was cut before a folder or a file was found", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      machine.rpc.listFolder.mockResolvedValueOnce({
        ok: true,
        path: `${FAKE_HOME}/empty`,
        parent: FAKE_HOME,
        entries: [],
        truncated: true,
      });

      await click(row("empty"));

      expect(rows()).toEqual([]);
      expect(statusLine()).toBe(
        "No folders or files are listed. This folder holds more: the list was cut before a folder or a file was found. To reach an entry that is not listed, type or paste its path into the path box.",
      );
    });

    it("says that the folder could not be listed when the server part does not answer, names that folder in the path box and asks for it again on Go", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      machine.rpc.listFolder.mockRejectedValueOnce(new Error("no server"));

      await click(row("dotfiles"));

      expect(alertLine()).toBe(
        "The folder could not be listed, because the server part of the plugin did not answer.",
      );
      expect(pathBox().value).toBe(DOTFILES);
      expect(rows()).toEqual([]);
      expect(console.warn).toHaveBeenCalledTimes(1);

      await click(button(GO_LABEL));

      expect(within(dialog()).queryByRole("alert")).toBeNull();
      expect(pathBox().value).toBe(DOTFILES);
      expect(rowNames()).toEqual(["nested, folder", "other.conf, file", "tmux.conf, file"]);
    });

    it("names the folder above in the path box when the way up leads to a folder that cannot be listed", async () => {
      const tree: FakeNode = { home: { me: { dotfiles: {} } } };
      const machine = fakeMachine({ tree });
      await renderSection(machine);
      await openDialog();
      machine.rpc.listFolder.mockResolvedValueOnce({
        ok: false,
        reason: "unreadable",
        path: "/home",
        parent: "/",
      });

      await click(button(PARENT_LABEL));

      expect(alertLine()).toBe("The bb server may not read this folder.");
      expect(pathBox().value).toBe("/home");
    });

    it("does not let the late listing of one folder replace the listing of a folder that was asked for after it", async () => {
      const slow = pendingAnswer<FolderListing>();
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      machine.rpc.listFolder.mockReturnValueOnce(slow.promise);

      await click(row("dotfiles"));
      await typePath("~/.config/tmux");
      await act(async () =>
        slow.answer({
          ok: true,
          path: DOTFILES,
          parent: FAKE_HOME,
          entries: [{ name: "late.conf", kind: "file" }],
          truncated: false,
        }),
      );

      expect(pathBox().value).toBe(`${FAKE_HOME}/.config/tmux`);
      expect(rowNames()).toEqual(["tmux.conf, file"]);
    });
  });

  describe("the path box", () => {
    it("has a name and a hint for a screen reader", async () => {
      await renderSection();
      await openDialog();

      const hint = pathBox().getAttribute("aria-describedby") ?? "";

      expect(PATH_BOX_LABEL).toBe("Path of the folder to list");
      expect(document.getElementById(hint)?.textContent).toBe(PATH_BOX_HINT);
    });

    it.each<["Enter" | "Go"]>([["Enter"], ["Go"]])(
      "jumps to the folder whose path was typed on %s, and shows its full path",
      async (confirm) => {
        const machine = fakeMachine();
        await renderSection(machine);
        await openDialog();

        await typePath("~/.config/tmux", confirm);

        expect(machine.rpc.listFolder.mock.calls.at(-1)).toEqual([{ path: "~/.config/tmux" }]);
        expect(pathBox().value).toBe(`${FAKE_HOME}/.config/tmux`);
        expect(rowNames()).toEqual(["tmux.conf, file"]);
      },
    );

    it.each(["  ~/.config/tmux ", "~/.config/tmux\t", "\u00a0~/.config/tmux"])(
      "asks for the typed path %j as it is, and then without the blanks around it, because it leads nowhere with them",
      async (typed) => {
        const machine = fakeMachine();
        await renderSection(machine);
        await openDialog();

        await typePath(typed);

        expect(machine.rpc.listFolder.mock.calls.slice(1)).toEqual([
          [{ path: typed }],
          [{ path: "~/.config/tmux" }],
        ]);
        expect(pathBox().value).toBe(`${FAKE_HOME}/.config/tmux`);
        expect(rowNames()).toEqual(["tmux.conf, file"]);
      },
    );

    it("jumps to a typed folder whose name ends in a blank, and not to the folder next to it whose name ends without one", async () => {
      const tree: FakeNode = { home: { me: { trail: {}, "trail ": { "inside.conf": "file" } } } };
      const machine = fakeMachine({ tree });
      await renderSection(machine);
      await openDialog();

      await typePath("~/trail ");

      expect(machine.rpc.listFolder.mock.calls.slice(1)).toEqual([[{ path: "~/trail " }]]);
      expect(pathBox().value).toBe(`${FAKE_HOME}/trail `);
      expect(rowNames()).toEqual(["inside.conf, file"]);
    });

    it("takes a pasted path of a file whose name ends in a blank, and stores that file and not the file next to it", async () => {
      const tree: FakeNode = { home: { me: { "tmux.conf": "file", "tmux.conf ": "file" } } };
      const machine = fakeMachine({ tree });
      await renderSection(machine);
      await openDialog();

      await typePath(`${FAKE_HOME}/tmux.conf `);

      expect(highlightedRow()).toBe("tmux.conf , file");

      await click(button(CONFIRM_LABEL));

      expect(machine.rpc.setConfigFile.mock.calls).toEqual([
        [{ path: `${FAKE_HOME}/tmux.conf ` }],
      ]);
    });

    it.each([
      ["leads nowhere and has no blank around it", `${FAKE_HOME}/gone`],
      ["leads to a folder that may not be read", "~/locked"],
    ])("asks once for a typed path that %s", async (_what, typed) => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();

      await typePath(typed);

      expect(machine.rpc.listFolder.mock.calls.slice(1)).toEqual([[{ path: typed }]]);
    });

    it("says what is at the path without the blanks around it when the path leads nowhere with them, and keeps what was typed", async () => {
      await renderSection();
      await openDialog();

      await typePath(" ~/locked ");

      expect(alertLine()).toBe("The bb server may not read this folder.");
      expect(pathBox().value).toBe(" ~/locked ");

      await click(button(PARENT_LABEL));

      expect(pathBox().value).toBe(FAKE_HOME);
    });

    it("takes a pasted file path with blanks around it, and stores the file without them", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();

      await typePath(" ~/dotfiles/tmux.conf ");
      await click(button(CONFIRM_LABEL));

      expect(machine.rpc.setConfigFile.mock.calls).toEqual([[{ path: CHOSEN }]]);
    });

    it("keeps what is typed after Enter while the jump is under way, and leaves the cursor in the path box", async () => {
      const slow = pendingAnswer<FolderListing>();
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      machine.rpc.listFolder.mockReturnValueOnce(slow.promise);
      pathBox().focus();
      await typePath("~/dotfiles");
      fireEvent.change(pathBox(), { target: { value: "~/dotfiles/nes" } });

      await act(async () => slow.answer(await listingOf(DOTFILES)));

      expect(rowNames()).toEqual(["nested, folder", "other.conf, file", "tmux.conf, file"]);
      expect(pathBox().value).toBe("~/dotfiles/nes");
      expect(document.activeElement).toBe(pathBox());
    });

    it("leaves the cursor where it went while the jump was under way", async () => {
      const slow = pendingAnswer<FolderListing>();
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      machine.rpc.listFolder.mockReturnValueOnce(slow.promise);
      pathBox().focus();
      await typePath("~/dotfiles");
      button(CANCEL_LABEL).focus();

      await act(async () => slow.answer(await listingOf(DOTFILES)));

      expect(pathBox().value).toBe(DOTFILES);
      expect(document.activeElement).toBe(button(CANCEL_LABEL));
    });

    it("does not jump again for an Enter that is held down", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      fireEvent.change(pathBox(), { target: { value: DOTFILES } });

      expect(fireEvent.keyDown(pathBox(), { key: "Enter", repeat: true })).toBe(true);
      await flushEffects();

      expect(machine.rpc.listFolder).toHaveBeenCalledTimes(1);
      expect(rowNames()).toEqual(HOME_ROWS);
    });

    it("puts the cursor into the list after a jump, so that the arrow keys go on from there", async () => {
      await renderSection();
      await openDialog();
      pathBox().focus();

      await typePath(DOTFILES);

      expect(document.activeElement).toBe(list());
    });

    it("takes a pasted file path: it lists the folder of the file, with the file highlighted and ready to be confirmed", async () => {
      const machine = fakeMachine();
      const view = await renderSection(machine);
      await openDialog();

      await typePath("~/.config/tmux/tmux.conf");

      expect(pathBox().value).toBe(`${FAKE_HOME}/.config/tmux`);
      expect(highlightedRow()).toBe("tmux.conf, file");
      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", false);

      await click(button(CONFIRM_LABEL));

      expect(machine.chosen()).toBe(`${FAKE_HOME}/.config/tmux/tmux.conf`);
      expect(sectionText(view)).toContain(`In use: ${FAKE_HOME}/.config/tmux/tmux.conf`);
    });

    it.each([
      ["a path that leads nowhere", `${FAKE_HOME}/gone`, "There is no folder at this path."],
      [
        "a path that is not absolute",
        "dotfiles",
        "Write the full path of a folder, or start it with ~ for your home folder on the machine that runs the bb server.",
      ],
      ["a folder that may not be read", "~/locked", "The bb server may not read this folder."],
    ])("says so for %s, keeps what was typed and lists nothing", async (_what, path, message) => {
      await renderSection();
      await openDialog();
      pathBox().focus();

      await typePath(path);

      expect(alertLine()).toBe(message);
      expect(pathBox().value).toBe(path);
      expect(rows()).toEqual([]);
      expect(document.activeElement).toBe(pathBox());
      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", true);
    });

    it("says that a path leads to no folder and to no file that can be chosen, as for a FIFO or a device", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      machine.rpc.listFolder.mockResolvedValueOnce({
        ok: false,
        reason: "not-a-folder",
        path: `${FAKE_HOME}/pipe`,
        parent: FAKE_HOME,
      });
      const calls = machine.rpc.listFolder.mock.calls.length;

      await typePath("~/pipe");

      expect(alertLine()).toBe(
        "This path leads to no folder, and to no file that can be chosen.",
      );
      expect(pathBox().value).toBe("~/pipe");
      expect(machine.rpc.listFolder).toHaveBeenCalledTimes(calls + 1);
      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", true);
    });

    it("takes a pasted file path also when the folder of the file does not list it, as in a list that was cut", async () => {
      const tree: FakeNode = { home: { me: { many: folderOfFiles(8) } } };
      const machine = fakeMachine({ tree, maxEntries: 5 });
      const view = await renderSection(machine);
      await openDialog();
      const pasted = `${FAKE_HOME}/many/file-0007.conf`;

      await typePath(pasted);

      expect(pathBox().value).toBe(`${FAKE_HOME}/many`);
      expect(rows()).toHaveLength(5);
      expect(highlightedRow()).toBeNull();
      expect(within(dialog()).getByText(pasted)).toBeTruthy();
      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", false);

      await click(button(CONFIRM_LABEL));

      expect(machine.chosen()).toBe(pasted);
      expect(sectionText(view)).toContain(`In use: ${pasted}`);
    });

    it("confirms such a file on Enter in the list as well", async () => {
      const tree: FakeNode = { home: { me: { many: folderOfFiles(8) } } };
      const machine = fakeMachine({ tree, maxEntries: 5 });
      await renderSection(machine);
      await openDialog();
      await typePath(`${FAKE_HOME}/many/file-0007.conf`);
      expect(document.activeElement).toBe(list());

      await pressOnFocused("Enter");

      expect(machine.chosen()).toBe(`${FAKE_HOME}/many/file-0007.conf`);
    });

    it("lets a row that is highlighted afterwards take the place of the pasted file", async () => {
      const tree: FakeNode = { home: { me: { many: folderOfFiles(8), sub: {} } } };
      const machine = fakeMachine({ tree });
      await renderSection(machine);
      await openDialog();
      await typePath(`${FAKE_HOME}/many/file-0007.conf`);
      expect(highlightedRow()).toBe("file-0007.conf, file");

      await pressOnFocused("Home");

      expect(highlightedRow()).toBe("file-0000.conf, file");
      expect(within(dialog()).getByText(`${FAKE_HOME}/many/file-0000.conf`)).toBeTruthy();
      expect(within(dialog()).queryByText(`${FAKE_HOME}/many/file-0007.conf`)).toBeNull();
    });

    it("takes a pasted file path whose folder cannot be listed: it says so, and the file can be chosen all the same", async () => {
      const machine = fakeMachine();
      const view = await renderSection(machine);
      await openDialog();
      machine.rpc.listFolder
        .mockResolvedValueOnce({
          ok: false,
          reason: "is-a-file",
          path: `${FAKE_HOME}/locked/tmux.conf`,
          parent: `${FAKE_HOME}/locked`,
        })
        .mockResolvedValueOnce({
          ok: false,
          reason: "unreadable",
          path: `${FAKE_HOME}/locked`,
          parent: FAKE_HOME,
        });

      await typePath("~/locked/tmux.conf");

      expect(alertLine()).toBe(
        "The folder of this file could not be listed. The file itself can still be chosen.",
      );
      expect(rows()).toEqual([]);
      expect(within(dialog()).getByText(`${FAKE_HOME}/locked/tmux.conf`)).toBeTruthy();

      await click(button(CONFIRM_LABEL));

      expect(machine.rpc.setConfigFile.mock.calls).toEqual([
        [{ path: `${FAKE_HOME}/locked/tmux.conf` }],
      ]);
      expect(sectionText(view)).toContain(`In use: ${FAKE_HOME}/locked/tmux.conf`);
    });

    it("drops a pasted file when another folder is listed", async () => {
      await renderSection();
      await openDialog();
      await typePath("~/dotfiles/tmux.conf");
      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", false);

      await click(button(PARENT_LABEL));

      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", true);
      expect(within(dialog()).getByText(NO_FILE_TEXT)).toBeTruthy();
    });

    it("goes up from a path that leads nowhere to the folder above it", async () => {
      await renderSection();
      await openDialog();
      await typePath(`${DOTFILES}/gone`);

      await click(button(PARENT_LABEL));

      expect(pathBox().value).toBe(DOTFILES);
      expect(within(dialog()).queryByRole("alert")).toBeNull();
    });

    it("has no way up from a path that is not absolute", async () => {
      await renderSection();
      await openDialog();

      await typePath("dotfiles");

      expect(button(PARENT_LABEL).getAttribute("aria-disabled")).toBe("true");
    });

    it("does not jump while the path is only typed", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();

      await typePath(DOTFILES, null);

      expect(machine.rpc.listFolder).toHaveBeenCalledTimes(1);
      expect(rowNames()).toEqual(HOME_ROWS);
    });

    it("does not jump on the Enter that ends a composition of an input method", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      fireEvent.change(pathBox(), { target: { value: DOTFILES } });

      fireEvent.keyDown(pathBox(), { key: "Enter", isComposing: true });
      fireEvent.keyDown(pathBox(), { key: "Enter", keyCode: 229 });
      await flushEffects();

      expect(machine.rpc.listFolder).toHaveBeenCalledTimes(1);
    });

    it("leaves every other key to the text field", async () => {
      await renderSection();
      await openDialog();
      pathBox().focus();

      for (const key of ["j", "k", "q", "i", "/", "ArrowDown", "ArrowUp", "Home", "End", "b"]) {
        expect(await pressOnFocused(key)).toBe(true);
      }
      expect(await pressOnFocused("b", { ctrlKey: true })).toBe(true);
      expect(rowNames()).toEqual(HOME_ROWS);
      expect(highlightedRow()).toBeNull();
    });
  });

  describe("with the keyboard", () => {
    it("moves the highlight with the arrow keys, from no row to the first one, and stops at both ends", async () => {
      await renderSection();
      await openDialog();
      await waitFor(() => expect(document.activeElement).toBe(list()));

      await pressOnFocused("ArrowDown");
      expect(highlightedRow()).toBe(".config, folder");

      await pressOnFocused("ArrowDown");
      expect(highlightedRow()).toBe("dotfiles, folder");

      await pressOnFocused("ArrowUp");
      await pressOnFocused("ArrowUp");
      expect(highlightedRow()).toBe(".config, folder");

      await pressOnFocused("End");
      expect(highlightedRow()).toBe("notes.txt, file");
      await pressOnFocused("ArrowDown");
      expect(highlightedRow()).toBe("notes.txt, file");

      await pressOnFocused("Home");
      expect(highlightedRow()).toBe(".config, folder");
    });

    it("goes to the last row on Up while no row is highlighted", async () => {
      await renderSection();
      await openDialog();
      await waitFor(() => expect(document.activeElement).toBe(list()));

      await pressOnFocused("ArrowUp");

      expect(highlightedRow()).toBe("notes.txt, file");
    });

    it("moves by a page with PageDown and PageUp, and no further than the ends", async () => {
      const tree: FakeNode = { home: { me: folderOfFiles(30) } };
      await renderSection(fakeMachine({ tree }));
      await openDialog();
      await waitFor(() => expect(document.activeElement).toBe(list()));

      await pressOnFocused("PageDown");
      expect(highlightedRow()).toBe("file-0000.conf, file");
      await pressOnFocused("PageDown");
      expect(highlightedRow()).toBe("file-0010.conf, file");
      await pressOnFocused("PageDown");
      await pressOnFocused("PageDown");
      expect(highlightedRow()).toBe("file-0029.conf, file");
      await pressOnFocused("PageUp");
      expect(highlightedRow()).toBe("file-0019.conf, file");
    });

    it("takes the keys it uses away from the page, and leaves every other key alone", async () => {
      await renderSection();
      await openDialog();
      await waitFor(() => expect(document.activeElement).toBe(list()));

      for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]) {
        expect(await pressOnFocused(key)).toBe(false);
      }
      await pressOnFocused("Home");
      for (const key of ["j", "k", "g", "G", "q", "i", "/", " ", "ArrowLeft", "ArrowRight", "Backspace"]) {
        expect(await pressOnFocused(key)).toBe(true);
      }
      for (const key of ["n", "p", "b", "f", "g", "ArrowDown"]) {
        expect(await pressOnFocused(key, { ctrlKey: true })).toBe(true);
      }
      expect(highlightedRow()).toBe(".config, folder");
      expect(screen.queryByRole("dialog")).not.toBeNull();
    });

    it("opens the highlighted folder on Enter, and keeps the cursor in the list", async () => {
      await renderSection();
      await openDialog();
      await waitFor(() => expect(document.activeElement).toBe(list()));
      await pressOnFocused("ArrowDown");
      await pressOnFocused("ArrowDown");

      expect(await pressOnFocused("Enter")).toBe(false);

      expect(pathBox().value).toBe(DOTFILES);
      expect(document.activeElement).toBe(list());
      expect(highlightedRow()).toBeNull();
    });

    it("stores the highlighted file on Enter, closes and puts the cursor back on Browse", async () => {
      const machine = fakeMachine();
      const view = await renderSection(machine);
      await openDialog();
      await waitFor(() => expect(document.activeElement).toBe(list()));
      await pressOnFocused("End");
      expect(within(dialog()).getByText(`${FAKE_HOME}/notes.txt`)).toBeTruthy();

      await pressOnFocused("Enter");

      expect(machine.rpc.setConfigFile.mock.calls).toEqual([
        [{ path: `${FAKE_HOME}/notes.txt` }],
      ]);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(sectionText(view)).toContain(`In use: ${FAKE_HOME}/notes.txt`);
      await waitFor(() => expect(document.activeElement).toBe(browseButton()));
    });

    it("does not store the file in use again for an Enter that is still held down from the press that opened the dialog", async () => {
      const machine = fakeMachine({ chosen: "~/dotfiles/tmux.conf" });
      const view = await renderSection(machine);
      await openDialog();
      await waitFor(() => expect(document.activeElement).toBe(list()));
      expect(highlightedRow()).toBe("tmux.conf, file");

      expect(await pressOnFocused("Enter", { repeat: true })).toBe(true);
      expect(await pressOnFocused("Enter", { repeat: true })).toBe(true);

      expect(machine.rpc.setConfigFile).not.toHaveBeenCalled();
      expect(machine.chosen()).toBe("~/dotfiles/tmux.conf");
      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(sectionText(view)).toContain("In use: ~/dotfiles/tmux.conf");

      expect(await pressOnFocused("Enter")).toBe(false);

      expect(machine.rpc.setConfigFile.mock.calls).toEqual([[{ path: CHOSEN }]]);
    });

    it("does not open the highlighted folder for an Enter that is held down", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      await waitFor(() => expect(document.activeElement).toBe(list()));
      await pressOnFocused("ArrowDown");
      await pressOnFocused("ArrowDown");

      expect(await pressOnFocused("Enter", { repeat: true })).toBe(true);

      expect(machine.rpc.listFolder).toHaveBeenCalledTimes(1);
      expect(pathBox().value).toBe(FAKE_HOME);
    });

    it("goes on moving the highlight for an arrow key that is held down", async () => {
      await renderSection();
      await openDialog();
      await waitFor(() => expect(document.activeElement).toBe(list()));

      await pressOnFocused("ArrowDown");
      await pressOnFocused("ArrowDown", { repeat: true });
      await pressOnFocused("ArrowDown", { repeat: true });

      expect(highlightedRow()).toBe("empty, folder");
    });

    it("does nothing on Enter while no row is highlighted", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      await waitFor(() => expect(document.activeElement).toBe(list()));

      expect(await pressOnFocused("Enter")).toBe(true);

      expect(machine.rpc.setConfigFile).not.toHaveBeenCalled();
      expect(machine.rpc.listFolder).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).not.toBeNull();
    });

    it("closes on Escape without storing, from the list and from the path box, and puts the cursor back on Browse", async () => {
      const machine = fakeMachine();
      const view = await renderSection(machine);

      for (const focus of [() => list(), () => pathBox()]) {
        await openDialog();
        await waitFor(() => expect(document.activeElement).toBe(list()));
        await pressOnFocused("ArrowDown");
        focus().focus();

        await pressOnFocused("Escape");

        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(browseButton()));
      }
      expect(machine.rpc.setConfigFile).not.toHaveBeenCalled();
      expect(sectionText(view)).toContain("In use: tmux's usual files");
    });

    it("lets Tab reach, in this order, the way up, the path box, Go, the list and the buttons", async () => {
      await renderSection(fakeMachine({ chosen: CHOSEN }));
      await openDialog();

      const stops = Array.from(
        dialog().querySelectorAll<HTMLElement>("button, input, [tabindex]"),
      ).filter((element) => element.tabIndex >= 0 && !element.matches(":disabled"));

      expect(
        stops.map(
          (element) => element.getAttribute("aria-label") ?? element.textContent,
        ),
      ).toEqual([
        PARENT_LABEL,
        PATH_BOX_LABEL,
        GO_LABEL,
        LIST_LABEL,
        CANCEL_LABEL,
        CONFIRM_LABEL,
        "Close",
      ]);
    });

    it("names every row with its kind for a screen reader, and hides the pictures from it", async () => {
      await renderSection();
      await openDialog();

      expect(rowNames()).toEqual(HOME_ROWS);
      for (const icon of list().querySelectorAll("[data-icon]")) {
        expect(icon.getAttribute("aria-hidden")).toBe("true");
      }
      expect(
        Array.from(list().querySelectorAll("[data-icon]"), (icon) =>
          icon.getAttribute("data-icon"),
        ).slice(0, 2),
      ).toEqual(["Folder", "ChevronRight"]);
    });
  });

  describe("choosing a file", () => {
    it("chooses a file that is pressed, names it by its full path and waits for the confirmation", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      await click(row("dotfiles"));

      await click(row("other.conf"));

      expect(highlightedRow()).toBe("other.conf, file");
      expect(within(dialog()).getByText(`${DOTFILES}/other.conf`)).toBeTruthy();
      expect(within(dialog()).queryByText(NO_FILE_TEXT)).toBeNull();
      expect(machine.rpc.setConfigFile).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeNull();
    });

    it("stores the chosen file on Use this file, closes, shows it in the section and puts the cursor back on Browse", async () => {
      const machine = fakeMachine();
      const view = await renderSection(machine);
      await openDialog();
      await click(row("dotfiles"));
      await click(row("tmux.conf"));

      await click(button(CONFIRM_LABEL));

      expect(machine.rpc.setConfigFile.mock.calls).toEqual([[{ path: CHOSEN }]]);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(sectionText(view)).toContain(`In use: ${CHOSEN}`);
      expect(screen.getByRole("button", { name: USUAL_FILES_LABEL })).toBeTruthy();
      await waitFor(() => expect(document.activeElement).toBe(browseButton()));
    });

    it("stores a file on a double click", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();
      await click(row("dotfiles"));

      fireEvent.click(row("tmux.conf"), { detail: 1 });
      fireEvent.click(row("tmux.conf"), { detail: 2 });
      fireEvent.doubleClick(row("tmux.conf"), { detail: 2 });
      await flushEffects();

      expect(machine.rpc.setConfigFile.mock.calls).toEqual([[{ path: CHOSEN }]]);
    });

    it("does not choose the file that comes to lie under the pointer when a folder is double clicked", async () => {
      const tree: FakeNode = { home: { me: { only: { "first.conf": "file" } } } };
      const machine = fakeMachine({ tree });
      await renderSection(machine);
      await openDialog();

      fireEvent.click(row("only"), { detail: 1 });
      await flushEffects();
      expect(rowNames()).toEqual(["first.conf, file"]);
      fireEvent.click(row("first.conf"), { detail: 2 });
      fireEvent.doubleClick(row("first.conf"), { detail: 2 });
      await flushEffects();

      expect(machine.rpc.setConfigFile).not.toHaveBeenCalled();
      expect(highlightedRow()).toBeNull();
      expect(screen.queryByRole("dialog")).not.toBeNull();
    });

    it("does not open two folders for one double click on a folder", async () => {
      const machine = fakeMachine();
      await renderSection(machine);
      await openDialog();

      fireEvent.click(row("dotfiles"), { detail: 1 });
      await flushEffects();
      fireEvent.click(row("nested"), { detail: 2 });
      fireEvent.doubleClick(row("nested"), { detail: 2 });
      await flushEffects();

      expect(pathBox().value).toBe(DOTFILES);
    });

    it("closes on Cancel without storing, and puts the cursor back on Browse", async () => {
      const machine = fakeMachine();
      const view = await renderSection(machine);
      await openDialog();
      await click(row("dotfiles"));
      await click(row("tmux.conf"));

      await click(button(CANCEL_LABEL));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(machine.rpc.setConfigFile).not.toHaveBeenCalled();
      expect(sectionText(view)).toContain("In use: tmux's usual files");
      await waitFor(() => expect(document.activeElement).toBe(browseButton()));
    });

    it("says so and stays open when the server part does not answer, and stores on the next try", async () => {
      const machine = fakeMachine();
      machine.rpc.setConfigFile.mockRejectedValueOnce(new Error("no server"));
      await renderSection(machine);
      await openDialog();
      await click(row("dotfiles"));
      await click(row("tmux.conf"));

      await click(button(CONFIRM_LABEL));

      expect(alertLine()).toBe(NOT_STORED_TEXT);
      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(machine.chosen()).toBeNull();

      await click(button(CONFIRM_LABEL));

      expect(machine.chosen()).toBe(CHOSEN);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("says so and stays open when the server part does not take the path", async () => {
      const machine = fakeMachine();
      machine.rpc.setConfigFile.mockResolvedValueOnce({ ok: false, reason: "not-absolute" });
      await renderSection(machine);
      await openDialog();
      await click(row("dotfiles"));
      await click(row("tmux.conf"));

      await click(button(CONFIRM_LABEL));

      expect(alertLine()).toBe(NOT_TAKEN_TEXT);
      expect(screen.queryByRole("dialog")).not.toBeNull();
    });

    it("stores once for a confirmation that is given twice", async () => {
      const answer = pendingAnswer<ConfigFileChange>();
      const machine = fakeMachine();
      machine.rpc.setConfigFile.mockReturnValueOnce(answer.promise);
      await renderSection(machine);
      await openDialog();
      await click(row("dotfiles"));
      await click(row("tmux.conf"));

      await click(button(CONFIRM_LABEL));
      await click(button(CONFIRM_LABEL));
      fireEvent.doubleClick(row("tmux.conf"));
      await flushEffects();

      expect(machine.rpc.setConfigFile).toHaveBeenCalledTimes(1);
      await act(async () =>
        answer.answer({ ok: true, file: { path: CHOSEN, readable: true } }),
      );
    });

    it("marks Use this file as busy while it stores, and leaves it a button that keeps the cursor", async () => {
      const answer = pendingAnswer<ConfigFileChange>();
      const machine = fakeMachine();
      machine.rpc.setConfigFile.mockReturnValueOnce(answer.promise);
      await renderSection(machine);
      await openDialog();
      await click(row("dotfiles"));
      await click(row("tmux.conf"));
      expect(button(CONFIRM_LABEL).getAttribute("aria-disabled")).toBe("false");
      button(CONFIRM_LABEL).focus();

      await click(button(CONFIRM_LABEL));

      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", false);
      expect(button(CONFIRM_LABEL).getAttribute("aria-disabled")).toBe("true");
      expect(document.activeElement).toBe(button(CONFIRM_LABEL));

      await act(async () => answer.fail(new Error("no server")));

      expect(alertLine()).toBe(NOT_STORED_TEXT);
      expect(button(CONFIRM_LABEL).getAttribute("aria-disabled")).toBe("false");
      expect(document.activeElement).toBe(button(CONFIRM_LABEL));
    });

    it("stores a file whose name ends in a blank under its whole name, and not the file next to it whose name ends without one", async () => {
      const tree: FakeNode = { home: { me: { "tmux.conf": "file", "tmux.conf ": "file" } } };
      const machine = fakeMachine({ tree });
      const view = await renderSection(machine);
      await openDialog();

      await click(row("tmux.conf "));
      await click(button(CONFIRM_LABEL));

      expect(machine.rpc.setConfigFile.mock.calls).toEqual([
        [{ path: `${FAKE_HOME}/tmux.conf ` }],
      ]);
      expect(machine.chosen()).toBe(`${FAKE_HOME}/tmux.conf `);
      expect(screen.getByRole("status").textContent).toContain(
        `In use: ${FAKE_HOME}/tmux.conf This file is read`,
      );
      expect(sectionText(view)).not.toContain("cannot be read");
    });

    it("does not let the late answer to Use this file close a dialog that was closed with Escape and opened again, and shows the file that was stored", async () => {
      const answer = pendingAnswer<ConfigFileChange>();
      const machine = fakeMachine();
      machine.rpc.setConfigFile.mockReturnValueOnce(answer.promise);
      const view = await renderSection(machine);
      await openDialog();
      await click(row("notes.txt"));
      await click(button(CONFIRM_LABEL));
      list().focus();
      await pressOnFocused("Escape");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(sectionText(view)).toContain("In use: tmux's usual files");
      await openDialog();
      await click(row("dotfiles"));

      await act(async () =>
        answer.answer({ ok: true, file: { path: `${FAKE_HOME}/notes.txt`, readable: true } }),
      );

      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(pathBox().value).toBe(DOTFILES);
      expect(rowNames()).toEqual(["nested, folder", "other.conf, file", "tmux.conf, file"]);
      expect(sectionText(view)).toContain(`In use: ${FAKE_HOME}/notes.txt`);
    });

    it("shows the file that the server part stored also when the dialog was closed before it answered", async () => {
      const answer = pendingAnswer<ConfigFileChange>();
      const machine = fakeMachine();
      machine.rpc.setConfigFile.mockReturnValueOnce(answer.promise);
      const view = await renderSection(machine);
      await openDialog();
      await click(row("notes.txt"));
      await click(button(CONFIRM_LABEL));
      await click(button(CANCEL_LABEL));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      await act(async () =>
        answer.answer({ ok: true, file: { path: `${FAKE_HOME}/notes.txt`, readable: true } }),
      );

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(sectionText(view)).toContain(`In use: ${FAKE_HOME}/notes.txt`);
    });

    it("drops the choice of a file when another folder is listed", async () => {
      await renderSection();
      await openDialog();
      await click(row("notes.txt"));
      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", false);

      await click(row("dotfiles"));

      expect(button(CONFIRM_LABEL)).toHaveProperty("disabled", true);
      expect(within(dialog()).getByText(NO_FILE_TEXT)).toBeTruthy();
    });
  });

  describe("when it is opened again", () => {
    it("starts anew on the file that is in use now", async () => {
      await renderSection();
      await openDialog();
      await click(row("dotfiles"));
      await click(row("tmux.conf"));
      await click(button(CONFIRM_LABEL));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      await openDialog();

      expect(pathBox().value).toBe(DOTFILES);
      expect(highlightedRow()).toBe("tmux.conf, file");
    });

    it("forgets the folder and the path of the last opening", async () => {
      await renderSection();
      await openDialog();
      await click(row("dotfiles"));
      fireEvent.change(pathBox(), { target: { value: "/made/up" } });
      await click(button(CANCEL_LABEL));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      await openDialog();

      expect(pathBox().value).toBe(FAKE_HOME);
      expect(rowNames()).toEqual(HOME_ROWS);
    });

    it("stays where it is when another file is chosen elsewhere while it is open", async () => {
      const machine = fakeMachine();
      const view = await renderSection(machine);
      await openDialog();
      await click(row("dotfiles"));
      machine.choose(`${FAKE_HOME}/.tmux.conf`);

      await view.behavior.emitRealtime(CONFIG_FILE_CHANGED, {});

      expect(sectionText(view)).toContain(`In use: ${FAKE_HOME}/.tmux.conf`);
      expect(pathBox().value).toBe(DOTFILES);
    });
  });
});

describe("the Browse dialog in a narrow window, where it is a drawer", () => {
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  async function openDrawer(): Promise<HTMLElement> {
    fireEvent.click(browseButton());
    const listbox = await screen.findByRole("listbox", { name: LIST_LABEL });
    await flushEffects();
    return listbox;
  }

  it("opens as a modal dialog with its title and description, and puts the cursor into the list", async () => {
    await renderSection();

    const listbox = await openDrawer();

    const drawer = dialog();
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(drawer.hasAttribute("data-persistent-drawer-content")).toBe(true);
    const describedBy = drawer.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe(BROWSE_DESCRIPTION);
    await waitFor(() => expect(document.activeElement).toBe(listbox));
    expect(rowNames()).toEqual(HOME_ROWS);
  });

  it("chooses a file with the keyboard, closes and puts the cursor back on Browse", async () => {
    const machine = fakeMachine();
    const view = await renderSection(machine);
    browseButton().focus();
    const listbox = await openDrawer();
    await waitFor(() => expect(document.activeElement).toBe(listbox));

    await pressOnFocused("End");
    await pressOnFocused("Enter");

    expect(machine.chosen()).toBe(`${FAKE_HOME}/notes.txt`);
    expect(sectionText(view)).toContain(`In use: ${FAKE_HOME}/notes.txt`);
    await waitFor(() => expect(document.activeElement).toBe(browseButton()));
  });

  it("closes on Escape without storing, and puts the cursor back on Browse", async () => {
    const machine = fakeMachine();
    await renderSection(machine);
    const listbox = await openDrawer();
    await waitFor(() => expect(document.activeElement).toBe(listbox));

    await pressOnFocused("Escape");

    await waitFor(() => expect(dialogIsOpen()).toBe(false));
    expect(machine.rpc.setConfigFile).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(browseButton()));
  });

  function dialogIsOpen(): boolean {
    return document.querySelector('[role="dialog"][data-state="open"]') !== null;
  }
});

describe("the made-up machine of these tests", () => {
  it("answers in the shapes of the rpc contract, which the test harness checks on every call", async () => {
    const machine = fakeMachine({ chosen: CHOSEN });
    const view = await renderSection(machine);
    await openDialog();
    await typePath("~/locked");
    await typePath("nowhere");
    await typePath(`${FAKE_HOME}/gone`);

    expect(view.inspection.rpcCalls.map((call) => call.method)).toEqual([
      "configFile",
      "listFolder",
      "listFolder",
      "listFolder",
      "listFolder",
      "listFolder",
    ]);
    expect(FAKE_TREE).toHaveProperty("home");
  });
});
