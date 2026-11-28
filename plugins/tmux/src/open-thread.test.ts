import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCoreCommand } from "./bb-commands";
import { getUiState, resetStore, setBridge } from "./bridge";
import { BB_COMMANDS, MAX_PANES } from "./constants";
import { clickMaximizePane, isPaneZoomed } from "./dom-actions";
import { BRIDGE_MISSING_NOTICE, openThread } from "./open-thread";
import {
  getFocusedThreadId,
  settleDomFocusWhen,
  settleIdleDomFocus,
} from "./pane-focus";
import { DEFAULT_SETTINGS } from "./settings";
import type { Bridge, SplitPane } from "./types";

vi.mock("./bb-commands", () => ({ runCoreCommand: vi.fn(() => "ran") }));
vi.mock("./dom-actions", () => ({
  clickMaximizePane: vi.fn(() => true),
  isPaneZoomed: vi.fn(() => false),
}));
vi.mock("./pane-focus", () => ({
  getFocusedThreadId: vi.fn(() => null),
  settleDomFocusWhen: vi.fn(),
  settleIdleDomFocus: vi.fn(),
}));

let stopSettling: ReturnType<typeof vi.fn<() => boolean>>;

function pane(paneId: string, threadId: string | null, isFocused = false): SplitPane {
  return { paneId, threadId, isFocused, rect: { x: 0, y: 0, width: 1, height: 1 } };
}

function publishBridge(panes: SplitPane[] | null, contextThreadId: string | null = null) {
  const navigate = { toThread: vi.fn(), toCompose: vi.fn() };
  const threads = { open: vi.fn(() => Promise.resolve({ delivered: 1 })) };
  setBridge({
    navigate,
    sdk: { threads },
    layout: panes === null ? null : { panes },
    context: { projectId: null, threadId: contextThreadId },
    threads: [],
    threadsReady: true,
    projects: [],
    composers: [],
    settings: DEFAULT_SETTINGS,
  } as unknown as Bridge);
  return { navigate, threads };
}

function twoPanes(): SplitPane[] {
  return [pane("p1", "thr_a", true), pane("p2", "thr_b")];
}

function firstCallOrder(mock: unknown): number {
  return vi.mocked(mock as () => void).mock.invocationCallOrder[0];
}

beforeEach(() => {
  vi.mocked(runCoreCommand).mockReturnValue("ran");
  vi.mocked(clickMaximizePane).mockReturnValue(true);
  vi.mocked(isPaneZoomed).mockReturnValue(false);
  vi.mocked(getFocusedThreadId).mockReturnValue(null);
  stopSettling = vi.fn<() => boolean>(() => true);
  vi.mocked(settleDomFocusWhen).mockReturnValue(stopSettling);
});

afterEach(() => {
  resetStore();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("openThread", () => {
  it("reports unavailable and tells the user while the bridge is missing", () => {
    expect(openThread("thr_x", "right")).toBe("unavailable");
    expect(getUiState().notice?.text).toBe(BRIDGE_MISSING_NOTICE);
    expect(settleDomFocusWhen).not.toHaveBeenCalled();
  });

  it.each(["replace", "right", "down"] as const)(
    "jumps to the pane that already shows the thread for placement %s",
    (placement) => {
      const { navigate, threads } = publishBridge(twoPanes());

      expect(openThread("thr_b", placement)).toBe("focused-existing");

      expect(navigate.toThread).toHaveBeenCalledTimes(1);
      expect(navigate.toThread).toHaveBeenCalledWith("thr_b");
      expect(threads.open).not.toHaveBeenCalled();
      expect(runCoreCommand).not.toHaveBeenCalled();
      expect(settleDomFocusWhen).toHaveBeenCalledTimes(1);
    },
  );

  it("treats the context thread as visible when there is a single pane", () => {
    const { navigate } = publishBridge(null, "thr_only");

    expect(openThread("thr_only", "right")).toBe("focused-existing");
    expect(navigate.toThread).toHaveBeenCalledWith("thr_only");
  });

  it("replaces the focused pane's thread", () => {
    const { navigate, threads } = publishBridge(twoPanes());

    expect(openThread("thr_x", "replace")).toBe("opened");

    expect(navigate.toThread).toHaveBeenCalledWith("thr_x");
    expect(threads.open).not.toHaveBeenCalled();
    expect(settleDomFocusWhen).toHaveBeenCalledTimes(1);
  });

  it("splits to the right with the local navigation call", () => {
    const { navigate, threads } = publishBridge(null, "thr_only");

    expect(openThread("thr_x", "right")).toBe("opened");

    expect(navigate.toThread).toHaveBeenCalledWith("thr_x", { split: true });
    expect(threads.open).not.toHaveBeenCalled();
    expect(settleDomFocusWhen).toHaveBeenCalledTimes(1);
  });

  it("splits below with sdk.threads.open", () => {
    const { navigate, threads } = publishBridge(twoPanes());

    expect(openThread("thr_x", "down")).toBe("opened");

    expect(threads.open).toHaveBeenCalledWith({
      threadId: "thr_x",
      split: "down",
      file: null,
    });
    expect(navigate.toThread).not.toHaveBeenCalled();
    expect(settleDomFocusWhen).toHaveBeenCalledTimes(1);
  });

  it("waits the usual time for the pane that already shows the thread", () => {
    publishBridge(twoPanes());

    openThread("thr_b", "replace");

    expect(settleDomFocusWhen).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
    );
    const isReady = vi.mocked(settleDomFocusWhen).mock.calls[0][0];
    expect(isReady()).toBe(false);
    vi.mocked(getFocusedThreadId).mockReturnValue("thr_b");
    expect(isReady()).toBe(true);
  });

  it.each([
    ["replace", undefined],
    ["right", undefined],
    ["down", 3000],
  ] as const)(
    "settles the cursor in the pane of a thread that it opened with placement %s, in the same way",
    (placement, timeoutMs) => {
      publishBridge(twoPanes());

      expect(openThread("thr_x", placement)).toBe("opened");

      expect(settleDomFocusWhen).toHaveBeenCalledTimes(1);
      expect(settleDomFocusWhen).toHaveBeenCalledWith(
        expect.any(Function),
        timeoutMs,
      );
    },
  );

  it("settles DOM focus once the focused thread is the opened one", () => {
    publishBridge(twoPanes());
    openThread("thr_x", "right");

    const isReady = vi.mocked(settleDomFocusWhen).mock.calls[0][0];
    expect(isReady()).toBe(false);
    vi.mocked(getFocusedThreadId).mockReturnValue("thr_x");
    expect(isReady()).toBe(true);
  });

  it.each(["right", "down"] as const)(
    "refuses a %s split at the pane limit and changes nothing",
    (placement) => {
      const panes = Array.from({ length: MAX_PANES }, (_, index) =>
        pane(`p${index}`, `thr_${index}`, index === 0),
      );
      const { navigate, threads } = publishBridge(panes);
      vi.mocked(isPaneZoomed).mockReturnValue(true);

      expect(openThread("thr_x", placement)).toBe("pane-limit");

      expect(getUiState().notice?.text).toContain(`at most ${MAX_PANES} panes`);
      expect(navigate.toThread).not.toHaveBeenCalled();
      expect(threads.open).not.toHaveBeenCalled();
      expect(runCoreCommand).not.toHaveBeenCalled();
      expect(clickMaximizePane).not.toHaveBeenCalled();
      expect(settleDomFocusWhen).not.toHaveBeenCalled();
    },
  );

  // The number is bb's own limit (MAX_PANES in its lib/split-layout/ops.ts),
  // so it is written out here and not taken from the plugin's constant.
  it("refuses the split that would make a ninth pane, and says that bb allows at most 8 panes", () => {
    const eight = Array.from({ length: 8 }, (_, index) =>
      pane(`p${index}`, `thr_${index}`, index === 0),
    );
    const { navigate } = publishBridge(eight);

    expect(openThread("thr_x", "right")).toBe("pane-limit");
    expect(getUiState().notice?.text).toBe(
      "bb allows at most 8 panes. Close one before splitting again.",
    );
    expect(navigate.toThread).not.toHaveBeenCalled();
  });

  it("still splits with seven panes, one below bb's limit", () => {
    const seven = Array.from({ length: 7 }, (_, index) =>
      pane(`p${index}`, `thr_${index}`, index === 0),
    );
    const { navigate } = publishBridge(seven);

    expect(openThread("thr_x", "right")).toBe("opened");
    expect(navigate.toThread).toHaveBeenCalledWith("thr_x", { split: true });
  });

  it("still replaces the focused pane's thread at the pane limit", () => {
    const panes = Array.from({ length: MAX_PANES }, (_, index) =>
      pane(`p${index}`, `thr_${index}`, index === 0),
    );
    const { navigate } = publishBridge(panes);

    expect(openThread("thr_x", "replace")).toBe("opened");
    expect(navigate.toThread).toHaveBeenCalledWith("thr_x");
  });

  it("unzooms with bb's own command before splitting right", () => {
    const { navigate } = publishBridge(twoPanes());
    vi.mocked(isPaneZoomed).mockReturnValue(true);

    openThread("thr_x", "right");

    expect(runCoreCommand).toHaveBeenCalledWith(BB_COMMANDS.paneMaximizeToggle);
    expect(clickMaximizePane).not.toHaveBeenCalled();
    expect(firstCallOrder(runCoreCommand)).toBeLessThan(firstCallOrder(navigate.toThread));
  });

  it("unzooms with the maximize button when bb declines the command, before splitting below", () => {
    const { threads } = publishBridge(twoPanes());
    vi.mocked(isPaneZoomed).mockReturnValue(true);
    vi.mocked(runCoreCommand).mockReturnValue("declined");

    openThread("thr_x", "down");

    expect(clickMaximizePane).toHaveBeenCalledTimes(1);
    expect(firstCallOrder(runCoreCommand)).toBeLessThan(firstCallOrder(clickMaximizePane));
    expect(firstCallOrder(clickMaximizePane)).toBeLessThan(firstCallOrder(threads.open));
  });

  it("leaves the zoom alone when no split is made", () => {
    publishBridge(twoPanes());
    vi.mocked(isPaneZoomed).mockReturnValue(true);

    openThread("thr_x", "replace");
    openThread("thr_b", "right");

    expect(runCoreCommand).not.toHaveBeenCalled();
    expect(clickMaximizePane).not.toHaveBeenCalled();
  });

  it("does not touch the zoom when no pane is zoomed", () => {
    publishBridge(twoPanes());

    openThread("thr_x", "right");

    expect(runCoreCommand).not.toHaveBeenCalled();
    expect(clickMaximizePane).not.toHaveBeenCalled();
  });

  it("shows a notice when sdk.threads.open rejects", async () => {
    const { threads } = publishBridge(twoPanes());
    threads.open.mockReturnValue(Promise.reject(new Error("offline")));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(openThread("thr_x", "down")).toBe("opened");
    expect(getUiState().notice).toBeNull();

    await Promise.resolve();
    await Promise.resolve();

    expect(getUiState().notice?.text).toBe("Could not open the thread in a pane below.");
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for the pane when sdk.threads.open rejects, so that the cursor is not moved three seconds later", async () => {
    const { threads } = publishBridge(twoPanes());
    threads.open.mockReturnValue(Promise.reject(new Error("offline")));
    vi.spyOn(console, "error").mockImplementation(() => {});

    openThread("thr_x", "down");
    expect(stopSettling).not.toHaveBeenCalled();
    expect(settleIdleDomFocus).not.toHaveBeenCalled();

    await Promise.resolve();
    await Promise.resolve();

    expect(stopSettling).toHaveBeenCalledTimes(1);
    expect(settleIdleDomFocus).toHaveBeenCalledTimes(1);
    expect(vi.mocked(stopSettling).mock.invocationCallOrder[0]).toBeLessThan(
      firstCallOrder(settleIdleDomFocus),
    );
  });

  it("leaves the cursor alone when sdk.threads.open rejects after the wait for the pane was over", async () => {
    const { threads } = publishBridge(twoPanes());
    threads.open.mockReturnValue(Promise.reject(new Error("offline")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    stopSettling.mockReturnValue(false);

    openThread("thr_x", "down");
    await Promise.resolve();
    await Promise.resolve();

    expect(getUiState().notice?.text).toBe("Could not open the thread in a pane below.");
    expect(stopSettling).toHaveBeenCalledTimes(1);
    expect(settleIdleDomFocus).not.toHaveBeenCalled();
  });

  it("goes on waiting for the pane while sdk.threads.open has not failed", async () => {
    publishBridge(twoPanes());

    openThread("thr_x", "down");
    await Promise.resolve();
    await Promise.resolve();

    expect(stopSettling).not.toHaveBeenCalled();
    expect(settleIdleDomFocus).not.toHaveBeenCalled();
  });
});
