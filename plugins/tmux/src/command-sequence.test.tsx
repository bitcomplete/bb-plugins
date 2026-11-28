// @vitest-environment jsdom
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBridge, getUiState, resetStore, setBridge } from "./bridge";
import { mountKeyHandler } from "./content-script";
import { DEFAULT_SETTINGS } from "./settings";
import type { TmuxConfig } from "./tmux-keymap";
import { tmuxConfigOf } from "./tmux-test-support";
import type { Bridge, SplitPane } from "./types";

interface PaneState {
  paneId: string;
  threadId: string;
}

interface PageLog {
  closed: string[];
  zoomed: string[];
}

const TWO_PANES: PaneState[] = [
  { paneId: "pane-1", threadId: "thr-1" },
  { paneId: "pane-2", threadId: "thr-2" },
];

const THREE_PANES: PaneState[] = [
  ...TWO_PANES,
  { paneId: "pane-3", threadId: "thr-3" },
];

const FOUR_PANES: PaneState[] = [
  ...THREE_PANES,
  { paneId: "pane-4", threadId: "thr-4" },
];

function layoutPane(pane: PaneState, at: number, focused: string): SplitPane {
  return {
    paneId: pane.paneId,
    threadId: pane.threadId,
    isFocused: pane.paneId === focused,
    rect: { x: at * 0.25, y: 0, width: 0.25, height: 1 },
  };
}

function bridgeFor(panes: PaneState[], focused: string, tmux: TmuxConfig): Bridge {
  const shown = panes.find((pane) => pane.paneId === focused) ?? panes[0];
  const layout =
    panes.length < 2
      ? null
      : { panes: panes.map((pane, at) => layoutPane(pane, at, focused)) };
  return {
    navigate: { toThread: vi.fn(), toCompose: vi.fn() },
    sdk: { threads: {} },
    layout,
    context: { projectId: null, threadId: shown?.threadId ?? null },
    threads: [],
    threadsReady: true,
    projects: [],
    composers: [],
    settings: { ...DEFAULT_SETTINGS, enabled: true },
    tmux,
    reloadTmuxConfig: () => Promise.resolve("read"),
  } as unknown as Bridge;
}

interface BbPanesProps {
  tmux: TmuxConfig;
  log: PageLog;
  initialPanes: PaneState[];
}

// A stand-in for bb's panes that behaves as bb does: a press on a pane
// changes the state at once, React draws the focus mark in a later task, and
// the plugin gets the new layout in an effect after that. The Close pane
// button closes the pane it sits in, and the pane that takes its place gets
// the focus. The Maximize pane button zooms and unzooms, and the zoom goes
// with the focus to another pane.
function BbPanes({ tmux, log, initialPanes }: BbPanesProps) {
  const [panes, setPanes] = useState(initialPanes);
  const [focused, setFocused] = useState("pane-1");
  const [zoomed, setZoomed] = useState<string | null>(null);
  useEffect(() => {
    setBridge(bridgeFor(panes, focused, tmux));
  }, [panes, focused, tmux]);
  const focus = (paneId: string): void => {
    setFocused(paneId);
    setZoomed((current) => (current === null ? null : paneId));
  };
  const close = (paneId: string): void => {
    const at = panes.findIndex((pane) => pane.paneId === paneId);
    const left = panes.filter((pane) => pane.paneId !== paneId);
    log.closed.push(paneId);
    setPanes(left);
    setFocused(left[Math.min(at, left.length - 1)]?.paneId ?? "");
  };
  const toggleZoom = (paneId: string): void => {
    log.zoomed.push(paneId);
    setZoomed((current) => (current === null ? paneId : null));
  };
  return (
    <main>
      {panes.map((pane) => (
        <div
          key={pane.paneId}
          data-split-pane-id={pane.paneId}
          data-focused={String(pane.paneId === focused)}
          data-maximized={String(pane.paneId === zoomed)}
          tabIndex={-1}
          onPointerDown={() => focus(pane.paneId)}
        >
          <button aria-label="Close pane" onClick={() => close(pane.paneId)} />
          <button
            aria-pressed={pane.paneId === zoomed}
            aria-label="Maximize pane"
            onClick={() => toggleZoom(pane.paneId)}
          />
        </div>
      ))}
    </main>
  );
}

let root: Root;
let container: HTMLElement;
let controller: AbortController;
let log: PageLog;

function press(init: KeyboardEventInit): void {
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  );
}

function pressAfterPrefix(init: KeyboardEventInit): void {
  press({ key: "b", code: "KeyB", ctrlKey: true });
  press(init);
}

function isMarkedFocused(paneId: string): boolean {
  const pane = container.querySelector(`[data-split-pane-id="${paneId}"]`);
  return pane?.getAttribute("data-focused") === "true";
}

function markedPane(attribute: "data-focused" | "data-maximized"): string | null {
  const pane = container.querySelector(`[data-split-pane-id][${attribute}="true"]`);
  return pane?.getAttribute("data-split-pane-id") ?? null;
}

// Where the page is once bb has followed a key and the plugin has let go.
async function pageAfter(key: () => void): Promise<{ focused: string | null; zoomed: string | null }> {
  const before = markedPane("data-focused");
  key();
  await vi.waitFor(() => expect(markedPane("data-focused")).not.toBe(before));
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { focused: markedPane("data-focused"), zoomed: markedPane("data-maximized") };
}

async function mountPage(config: string, panes: PaneState[] = TWO_PANES): Promise<void> {
  root.render(<BbPanes tmux={tmuxConfigOf(config)} log={log} initialPanes={panes} />);
  await vi.waitFor(() => expect(getBridge()).not.toBeNull());
  const context: PluginContentScriptContext = {
    pluginId: "tmux",
    generation: 1,
    signal: controller.signal,
  };
  mountKeyHandler(context);
}

beforeEach(() => {
  log = { closed: [], zoomed: [] };
  controller = new AbortController();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  controller.abort();
  root.unmount();
  container.remove();
  resetStore();
});

describe("a key bound to a pane move and another command, on a page that follows a pane move a moment later as bb does", () => {
  it("closes the pane that the move went to, as tmux does, and not the pane it came from", async () => {
    await mountPage("bind X select-pane -R \\; kill-pane");

    pressAfterPrefix({ key: "X", code: "KeyX", shiftKey: true });

    expect(isMarkedFocused("pane-2")).toBe(false);
    expect(log.closed).toEqual([]);
    await vi.waitFor(() => expect(log.closed).toEqual(["pane-2"]));
    expect(container.querySelectorAll("[data-split-pane-id]")).toHaveLength(1);
    expect(isMarkedFocused("pane-1")).toBe(true);
  });

  it("zooms the pane that the move went to", async () => {
    await mountPage("bind X select-pane -R \\; resize-pane -Z");

    pressAfterPrefix({ key: "X", code: "KeyX", shiftKey: true });

    expect(log.zoomed).toEqual([]);
    await vi.waitFor(() => expect(log.zoomed).toEqual(["pane-2"]));
  });

  it("still closes the focused pane at once for a key bound to that alone", async () => {
    await mountPage("bind X kill-pane");

    pressAfterPrefix({ key: "X", code: "KeyX", shiftKey: true });

    expect(log.closed).toEqual(["pane-1"]);
  });

  it("drops the command after the move when a mouse press comes before bb has followed", async () => {
    await mountPage("bind X select-pane -R \\; kill-pane");

    pressAfterPrefix({ key: "X", code: "KeyX", shiftKey: true });
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await vi.waitFor(() => expect(isMarkedFocused("pane-2")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(log.closed).toEqual([]);
  });
});

describe("a key bound to a pane move and resize-pane -Z, on a page whose zoom goes with the focus as bb's does", () => {
  it.each(["select-pane -t :.+", "select-pane -R"])(
    "leaves the pane that %s went to zoomed on every press, as tmux does",
    async (move) => {
      await mountPage(`bind a ${move} \\; resize-pane -Z`, THREE_PANES);
      const press = () => pressAfterPrefix({ key: "a", code: "KeyA" });

      expect(await pageAfter(press)).toEqual({ focused: "pane-2", zoomed: "pane-2" });
      expect(await pageAfter(press)).toEqual({ focused: "pane-3", zoomed: "pane-3" });
      expect(await pageAfter(press)).toEqual({ focused: "pane-1", zoomed: "pane-1" });
      expect(log.zoomed).toEqual(["pane-2"]);
    },
  );

  it("still unzooms with a key bound to resize-pane -Z alone", async () => {
    await mountPage("bind a select-pane -R \\; resize-pane -Z\nbind z resize-pane -Z", THREE_PANES);
    await pageAfter(() => pressAfterPrefix({ key: "a", code: "KeyA" }));

    pressAfterPrefix({ key: "z", code: "KeyZ" });

    await vi.waitFor(() => expect(markedPane("data-maximized")).toBeNull());
  });
});

describe("a key bound to a move that finds nothing to go to and another command", () => {
  it("does not close a pane behind a last-pane without a pane to go to, which is an error in tmux", async () => {
    await mountPage("bind a last-pane \\; kill-pane", THREE_PANES);

    pressAfterPrefix({ key: "a", code: "KeyA" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(getUiState().notice?.text).toBe("No other pane has had the focus yet.");
    expect(log.closed).toEqual([]);
    expect(container.querySelectorAll("[data-split-pane-id]")).toHaveLength(3);
  });
});

describe("a key bound to kill-pane, on a page that gives the focus to the pane that takes the closed pane's place as bb does", () => {
  it("moves the focus on to the pane that had it before the closed one, as tmux does", async () => {
    await mountPage("bind o select-pane -t :.+", THREE_PANES);
    await pageAfter(() => pressAfterPrefix({ key: "o", code: "KeyO" }));
    await pageAfter(() => pressAfterPrefix({ key: "o", code: "KeyO" }));
    await pageAfter(() => pressAfterPrefix({ key: "o", code: "KeyO" }));
    expect(markedPane("data-focused")).toBe("pane-1");

    pressAfterPrefix({ key: "x", code: "KeyX" });

    await vi.waitFor(() => expect(log.closed).toEqual(["pane-1"]));
    await vi.waitFor(() => expect(markedPane("data-focused")).toBe("pane-3"));
  });

  it("then goes with last-pane to the pane that had the focus before that one, as tmux does, and not to the pane that the page gave it to on the way", async () => {
    await mountPage("bind o select-pane -t :.+\nbind u select-pane -t :.-", FOUR_PANES);
    await pageAfter(() => pressAfterPrefix({ key: "o", code: "KeyO" }));
    await pageAfter(() => pressAfterPrefix({ key: "u", code: "KeyU" }));
    await pageAfter(() => pressAfterPrefix({ key: "u", code: "KeyU" }));
    expect(markedPane("data-focused")).toBe("pane-4");

    pressAfterPrefix({ key: "x", code: "KeyX" });
    await vi.waitFor(() => expect(log.closed).toEqual(["pane-4"]));
    await vi.waitFor(() => expect(markedPane("data-focused")).toBe("pane-1"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const page = await pageAfter(() => pressAfterPrefix({ key: ";", code: "Semicolon" }));

    expect(page.focused).toBe("pane-2");
  });
});

