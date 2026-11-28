// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingActions,
  cancelPendingActionsOnPointerPress,
  runAction,
} from "./actions";
import { runCoreCommand } from "./bb-commands";
import { getUiState, resetStore, setBridge } from "./bridge";
import { BB_COMMANDS } from "./constants";
import {
  beginCopySelection,
  clearCopySelection,
  enterCopyMode,
  exitCopyMode,
  isCopyModeActive,
  moveCopyCursor,
  scrollCopyView,
  yankCopySelection,
} from "./copy-mode";
import {
  cancelPendingSidebarFocus,
  clickClosePane,
  clickMaximizePane,
  focusPaneElement,
  focusSidebarEdge,
  focusSidebarRowForThread,
  getFocusedPaneElement,
  getFocusedSidebarRow,
  getThreadPaneElements,
  hasOpenModal,
  isPaneZoomed,
  isSidebarOpen,
  moveSidebarFocus,
  pageSidebarFocus,
  sidebarRowThreadId,
  toggleSidebar,
} from "./dom-actions";
import {
  findDirectionalPane,
  findNextPane,
  findPaneAcrossWindow,
  findPaneFromZoomedPane,
} from "./geometry";
import {
  cancelPendingNewThread,
  hasNewThreadScreenInAnotherPane,
  interruptPendingNewThread,
} from "./new-thread";
import { openThread } from "./open-thread";
import {
  cancelPendingFocus,
  focusPane,
  getFocusedPane,
  getFocusedThreadId,
  settleDomFocus,
  settleDomFocusWhen,
  settleIdleDomFocus,
} from "./pane-focus";
import { cancelPendingResizeCheck, resizeFocusedPane } from "./pane-resize";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import {
  cycleThread,
  lastThread,
  nthThread,
  readSidebarThreadOrder,
  resolveThreadOrder,
} from "./thread-order";
import { stockTmuxConfig } from "./tmux-keymap";
import type {
  Action,
  Bridge,
  ConfigReload,
  CopyMotion,
  SplitPane,
} from "./types";

vi.mock("./bb-commands", () => ({ runCoreCommand: vi.fn() }));
vi.mock("./copy-mode", () => ({
  beginCopySelection: vi.fn(),
  clearCopySelection: vi.fn(),
  enterCopyMode: vi.fn(),
  exitCopyMode: vi.fn(),
  isCopyModeActive: vi.fn(),
  moveCopyCursor: vi.fn(),
  scrollCopyView: vi.fn(),
  yankCopySelection: vi.fn(),
}));
vi.mock("./dom-actions", () => ({
  cancelPendingSidebarFocus: vi.fn(),
  clickClosePane: vi.fn(),
  clickMaximizePane: vi.fn(),
  focusPaneElement: vi.fn(),
  focusSidebarEdge: vi.fn(),
  focusSidebarRowForThread: vi.fn(),
  getFocusedPaneElement: vi.fn(),
  getFocusedSidebarRow: vi.fn(),
  getThreadPaneElements: vi.fn(),
  hasOpenModal: vi.fn(),
  isPaneZoomed: vi.fn(),
  isSidebarOpen: vi.fn(),
  moveSidebarFocus: vi.fn(),
  pageSidebarFocus: vi.fn(),
  sidebarRowThreadId: vi.fn(),
  toggleSidebar: vi.fn(),
}));
vi.mock("./geometry", () => ({
  findDirectionalPane: vi.fn(),
  findNextPane: vi.fn(),
  findPaneAcrossWindow: vi.fn(),
  findPaneFromZoomedPane: vi.fn(),
}));
vi.mock("./new-thread", () => ({
  ONE_NEW_THREAD_SCREEN_NOTICE:
    "bb shows the New thread screen in one pane only, so you were moved to it.",
  cancelPendingNewThread: vi.fn(),
  hasNewThreadScreenInAnotherPane: vi.fn(),
  interruptPendingNewThread: vi.fn(),
}));
vi.mock("./open-thread", () => ({
  BRIDGE_MISSING_NOTICE: "bb is still loading. Try again in a moment.",
  openThread: vi.fn(),
}));
vi.mock("./pane-resize", () => ({
  cancelPendingResizeCheck: vi.fn(),
  resizeFocusedPane: vi.fn(),
}));
vi.mock("./pane-focus", () => ({
  cancelPendingFocus: vi.fn(),
  focusPane: vi.fn(),
  getFocusedPane: vi.fn(),
  getFocusedThreadId: vi.fn(),
  settleDomFocus: vi.fn(),
  settleDomFocusWhen: vi.fn(),
  settleIdleDomFocus: vi.fn(),
}));
vi.mock("./thread-order", () => ({
  cycleThread: vi.fn(),
  lastThread: vi.fn(),
  nthThread: vi.fn(),
  readSidebarThreadOrder: vi.fn(),
  resolveThreadOrder: vi.fn(),
}));

const LOADING_NOTICE = "bb is still loading. Try again in a moment.";

const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

function runFrame(): void {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}

function pane(paneId: string, threadId: string | null, isFocused = false): SplitPane {
  return { paneId, threadId, isFocused, rect: { x: 0, y: 0, width: 1, height: 1 } };
}

interface BridgeOptions {
  panes?: SplitPane[] | null;
  contextThreadId?: string | null;
  settings?: Partial<Settings>;
  threads?: { id: string; isArchived?: boolean }[];
  reloadTmuxConfig?: () => Promise<ConfigReload>;
}

// The threads that bb lists unless a test names its own: every thread that a
// pane of these tests shows, none of them archived.
const LISTED_THREADS = ["thr_a", "thr_b", "thr_c", "thr_d", "thr_x"].map((id) => ({
  id,
  isArchived: false,
}));

function publishBridge(options: BridgeOptions = {}) {
  const navigate = { toThread: vi.fn(), toCompose: vi.fn() };
  const threads = { paneAction: vi.fn(() => Promise.resolve({ delivered: 1 })) };
  const panes = options.panes === undefined ? twoPanes() : options.panes;
  const reloadTmuxConfig = vi.fn(
    options.reloadTmuxConfig ?? (() => Promise.resolve("read")),
  );
  const bridge = {
    navigate,
    sdk: { threads },
    layout: panes === null ? null : { panes },
    context: { projectId: null, threadId: options.contextThreadId ?? null },
    threads: options.threads ?? LISTED_THREADS,
    threadsReady: true,
    projects: [],
    composers: [],
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
    tmux: stockTmuxConfig(),
    reloadTmuxConfig,
  } as unknown as Bridge;
  setBridge(bridge);
  return { navigate, threads, bridge, reloadTmuxConfig };
}

function twoPanes(): SplitPane[] {
  return [pane("p1", "thr_a", true), pane("p2", "thr_b")];
}

function noticeText(): string | null {
  return getUiState().notice?.text ?? null;
}

function callOrder(mock: unknown): number {
  return vi.mocked(mock as () => void).mock.invocationCallOrder[0];
}

function sidebarRow(): HTMLAnchorElement {
  return document.createElement("a");
}

function paneElement(): HTMLElement {
  return document.createElement("div");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  frames.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.mocked(runCoreCommand).mockReturnValue("ran");
  vi.mocked(enterCopyMode).mockReturnValue(true);
  vi.mocked(isCopyModeActive).mockReturnValue(false);
  vi.mocked(yankCopySelection).mockResolvedValue("copied");
  vi.mocked(clickClosePane).mockReturnValue(true);
  vi.mocked(clickMaximizePane).mockReturnValue(true);
  vi.mocked(hasOpenModal).mockReturnValue(false);
  vi.mocked(focusSidebarEdge).mockReturnValue(true);
  vi.mocked(focusSidebarRowForThread).mockReturnValue(true);
  vi.mocked(getFocusedPaneElement).mockReturnValue(paneElement());
  vi.mocked(getFocusedSidebarRow).mockReturnValue(null);
  vi.mocked(getThreadPaneElements).mockReturnValue([paneElement(), paneElement()]);
  vi.mocked(isPaneZoomed).mockReturnValue(false);
  vi.mocked(isSidebarOpen).mockReturnValue(true);
  vi.mocked(moveSidebarFocus).mockReturnValue(true);
  vi.mocked(sidebarRowThreadId).mockReturnValue(null);
  vi.mocked(toggleSidebar).mockReturnValue(true);
  vi.mocked(findDirectionalPane).mockReturnValue(null);
  vi.mocked(findNextPane).mockReturnValue(null);
  vi.mocked(findPaneAcrossWindow).mockReturnValue(null);
  vi.mocked(findPaneFromZoomedPane).mockReturnValue(null);
  vi.mocked(openThread).mockReturnValue("opened");
  vi.mocked(getFocusedPane).mockReturnValue(pane("p1", "thr_a", true));
  vi.mocked(getFocusedThreadId).mockReturnValue("thr_a");
  vi.mocked(cycleThread).mockReturnValue(null);
  vi.mocked(nthThread).mockReturnValue(null);
  vi.mocked(lastThread).mockReturnValue(null);
  vi.mocked(readSidebarThreadOrder).mockReturnValue(null);
  vi.mocked(resolveThreadOrder).mockReturnValue({ order: [], source: "recent" });
});

afterEach(() => {
  resetStore();
  document.body.replaceChildren();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pane.focus", () => {
  it("focuses the neighbouring pane", () => {
    const { bridge } = publishBridge();
    const neighbour = pane("p2", "thr_b");
    vi.mocked(findDirectionalPane).mockReturnValue(neighbour);

    runAction({ type: "pane.focus", direction: "right" });

    expect(findDirectionalPane).toHaveBeenCalledWith(
      bridge.layout?.panes,
      "p1",
      "right",
      ["p1"],
    );
    expect(focusPane).toHaveBeenCalledWith(neighbour);
    expect(focusSidebarRowForThread).not.toHaveBeenCalled();
    expect(findPaneAcrossWindow).not.toHaveBeenCalled();
  });

  it("hands over the panes that had the focus, the latest first, so that the pane tmux would pick is found", () => {
    publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)] });
    const { bridge } = publishBridge();

    runAction({ type: "pane.focus", direction: "down" });

    expect(findDirectionalPane).toHaveBeenCalledWith(
      bridge.layout?.panes,
      "p1",
      "down",
      ["p1", "p2"],
    );
    expect(findPaneAcrossWindow).toHaveBeenCalledWith(
      bridge.layout?.panes,
      "p1",
      "down",
      ["p1", "p2"],
    );
  });

  it("drops what the plugin still waits to do with the focus, and leaves the wait for a new thread pane alone", () => {
    publishBridge();
    const neighbour = pane("p2", "thr_b");
    vi.mocked(findDirectionalPane).mockReturnValue(neighbour);

    runAction({ type: "pane.focus", direction: "right" });

    expect(cancelPendingSidebarFocus).toHaveBeenCalledTimes(1);
    expect(cancelPendingFocus).toHaveBeenCalledTimes(1);
    expect(cancelPendingResizeCheck).toHaveBeenCalledTimes(1);
    expect(callOrder(cancelPendingResizeCheck)).toBeLessThan(callOrder(focusPane));
    expect(interruptPendingNewThread).not.toHaveBeenCalled();
    expect(cancelPendingNewThread).not.toHaveBeenCalled();
  });

  it("enters the sidebar when there is no pane to the left", () => {
    publishBridge();

    runAction({ type: "pane.focus", direction: "left" });

    expect(focusPane).not.toHaveBeenCalled();
    expect(cancelPendingFocus).toHaveBeenCalled();
    expect(toggleSidebar).not.toHaveBeenCalled();
    expect(focusSidebarRowForThread).toHaveBeenCalledWith("thr_a");
    expect(noticeText()).toBeNull();
  });

  it.each(["right", "up", "down"] as const)(
    "goes around to the pane at the opposite edge of the window from the %s edge, as tmux does",
    (direction) => {
      publishBridge();
      const across = pane("p2", "thr_b");
      vi.mocked(findPaneAcrossWindow).mockReturnValue(across);

      runAction({ type: "pane.focus", direction });

      expect(focusPane).toHaveBeenCalledExactlyOnceWith(across);
      expect(focusSidebarRowForThread).not.toHaveBeenCalled();
      expect(noticeText()).toBeNull();
    },
  );

  it.each(["right", "up", "down"] as const)(
    "does nothing at the %s edge when no pane lies at the opposite edge either",
    (direction) => {
      publishBridge();

      runAction({ type: "pane.focus", direction });

      expect(focusPane).not.toHaveBeenCalled();
      expect(focusSidebarRowForThread).not.toHaveBeenCalled();
      expect(noticeText()).toBeNull();
    },
  );

  it("does not go around to the left: the sidebar is there", () => {
    publishBridge();
    vi.mocked(findPaneAcrossWindow).mockReturnValue(pane("p2", "thr_b"));

    runAction({ type: "pane.focus", direction: "left" });

    expect(findPaneAcrossWindow).not.toHaveBeenCalled();
    expect(focusPane).not.toHaveBeenCalled();
    expect(focusSidebarRowForThread).toHaveBeenCalledWith("thr_a");
  });

  it("enters the sidebar on left with a single pane and ignores other directions", () => {
    publishBridge({ panes: null });
    vi.mocked(getFocusedPane).mockReturnValue(null);

    runAction({ type: "pane.focus", direction: "down" });
    expect(focusSidebarRowForThread).not.toHaveBeenCalled();

    runAction({ type: "pane.focus", direction: "left" });
    expect(focusSidebarRowForThread).toHaveBeenCalledTimes(1);
    expect(findDirectionalPane).not.toHaveBeenCalled();
    expect(focusPane).not.toHaveBeenCalled();
  });

  it("does not act on a split that bb is not showing, as on the Settings page", () => {
    publishBridge();
    vi.mocked(getThreadPaneElements).mockReturnValue([]);
    vi.mocked(findDirectionalPane).mockReturnValue(pane("p2", "thr_b"));

    runAction({ type: "pane.focus", direction: "right" });
    expect(focusPane).not.toHaveBeenCalled();
    expect(focusSidebarRowForThread).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();

    runAction({ type: "pane.focus", direction: "left" });
    expect(focusPane).not.toHaveBeenCalled();
    expect(focusSidebarRowForThread).toHaveBeenCalledTimes(1);
  });

  it("leaves the sidebar on right while a sidebar row has focus", () => {
    vi.mocked(getFocusedSidebarRow).mockReturnValue(sidebarRow());

    runAction({ type: "pane.focus", direction: "right" });

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
    expect(focusPane).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });

  it("still moves between panes on other directions from a sidebar row", () => {
    publishBridge();
    vi.mocked(getFocusedSidebarRow).mockReturnValue(sidebarRow());
    const neighbour = pane("p2", "thr_b");
    vi.mocked(findDirectionalPane).mockReturnValue(neighbour);

    runAction({ type: "pane.focus", direction: "down" });

    expect(settleDomFocus).not.toHaveBeenCalled();
    expect(focusPane).toHaveBeenCalledWith(neighbour);
  });

  it("tells the user while the bridge is missing", () => {
    runAction({ type: "pane.focus", direction: "left" });

    expect(noticeText()).toBe(LOADING_NOTICE);
    expect(focusSidebarRowForThread).not.toHaveBeenCalled();
  });
});

// tmux's {left-of}, {right-of}, {up-of} and {down-of}: the pane that
// window_pane_find_left and its siblings in window.c find.
describe("pane.neighbour", () => {
  const SIDES = ["left", "right", "up", "down"] as const;

  it.each(SIDES)("focuses the pane on the %s and reports that it found one", (direction) => {
    const { bridge } = publishBridge();
    const neighbour = pane("p2", "thr_b");
    vi.mocked(findDirectionalPane).mockReturnValue(neighbour);

    expect(runAction({ type: "pane.neighbour", direction })).toBe(true);

    expect(findDirectionalPane).toHaveBeenCalledWith(
      bridge.layout?.panes,
      "p1",
      direction,
      ["p1"],
    );
    expect(focusPane).toHaveBeenCalledExactlyOnceWith(neighbour);
    expect(findPaneAcrossWindow).not.toHaveBeenCalled();
  });

  it.each(SIDES)(
    "goes around to the pane at the opposite edge of the window from the %s edge, as tmux does, on the left as well",
    (direction) => {
      const { bridge } = publishBridge();
      const across = pane("p2", "thr_b");
      vi.mocked(findPaneAcrossWindow).mockReturnValue(across);

      expect(runAction({ type: "pane.neighbour", direction })).toBe(true);

      expect(findPaneAcrossWindow).toHaveBeenCalledWith(
        bridge.layout?.panes,
        "p1",
        direction,
        ["p1"],
      );
      expect(focusPane).toHaveBeenCalledExactlyOnceWith(across);
      expect(focusSidebarRowForThread).not.toHaveBeenCalled();
      expect(toggleSidebar).not.toHaveBeenCalled();
    },
  );

  it.each(SIDES)(
    "does nothing, says nothing and reports that it found no pane on the %s, which is an error in tmux",
    (direction) => {
      publishBridge();

      expect(runAction({ type: "pane.neighbour", direction })).toBe(false);

      expect(focusPane).not.toHaveBeenCalled();
      expect(focusSidebarRowForThread).not.toHaveBeenCalled();
      expect(toggleSidebar).not.toHaveBeenCalled();
      expect(settleDomFocus).not.toHaveBeenCalled();
      expect(noticeText()).toBeNull();
    },
  );

  it("finds no pane with a single pane, and does not go to the sidebar as the move to the left does", () => {
    publishBridge({ panes: null });
    vi.mocked(getFocusedPane).mockReturnValue(null);

    expect(runAction({ type: "pane.neighbour", direction: "left" })).toBe(false);

    expect(findDirectionalPane).not.toHaveBeenCalled();
    expect(focusPane).not.toHaveBeenCalled();
    expect(focusSidebarRowForThread).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });

  it("goes from a sidebar row to the pane that it finds, and not back to the pane that has the focus", () => {
    publishBridge();
    vi.mocked(getFocusedSidebarRow).mockReturnValue(sidebarRow());
    const neighbour = pane("p2", "thr_b");
    vi.mocked(findDirectionalPane).mockReturnValue(neighbour);

    expect(runAction({ type: "pane.neighbour", direction: "right" })).toBe(true);

    expect(settleDomFocus).not.toHaveBeenCalled();
    expect(focusPane).toHaveBeenCalledExactlyOnceWith(neighbour);
  });

  it("hands over the panes that had the focus, the latest first, so that the pane tmux would pick is found", () => {
    publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)] });
    const { bridge } = publishBridge();

    runAction({ type: "pane.neighbour", direction: "left" });

    expect(findDirectionalPane).toHaveBeenCalledWith(
      bridge.layout?.panes,
      "p1",
      "left",
      ["p1", "p2"],
    );
    expect(findPaneAcrossWindow).toHaveBeenCalledWith(
      bridge.layout?.panes,
      "p1",
      "left",
      ["p1", "p2"],
    );
  });

  it("drops what the plugin still waits to do with the focus, and leaves the wait for a new thread pane alone", () => {
    publishBridge();
    vi.mocked(findDirectionalPane).mockReturnValue(pane("p2", "thr_b"));

    runAction({ type: "pane.neighbour", direction: "right" });

    expect(cancelPendingSidebarFocus).toHaveBeenCalledTimes(1);
    expect(cancelPendingFocus).toHaveBeenCalledTimes(1);
    expect(cancelPendingResizeCheck).toHaveBeenCalledTimes(1);
    expect(callOrder(cancelPendingResizeCheck)).toBeLessThan(callOrder(focusPane));
    expect(cancelPendingNewThread).not.toHaveBeenCalled();
  });

  it("does not act on a split that bb is not showing, as on the Settings page", () => {
    publishBridge();
    vi.mocked(getThreadPaneElements).mockReturnValue([]);
    vi.mocked(findDirectionalPane).mockReturnValue(pane("p2", "thr_b"));

    expect(runAction({ type: "pane.neighbour", direction: "right" })).toBe(false);

    expect(focusPane).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });

  it("tells the user while the bridge is missing, and reports that it found no pane", () => {
    expect(runAction({ type: "pane.neighbour", direction: "left" })).toBe(false);

    expect(noticeText()).toBe(LOADING_NOTICE);
    expect(focusSidebarRowForThread).not.toHaveBeenCalled();
  });

  // tmux looks for the pane of a target before select-pane removes the zoom:
  // from a pane that fills the window, with the others where they were.
  describe("from a zoomed pane", () => {
    beforeEach(() => {
      vi.mocked(isPaneZoomed).mockReturnValue(true);
    });

    it.each(SIDES)(
      "focuses the pane that tmux finds for the %s side of a pane that fills the window, and not the one that lies there in bb's layout",
      (direction) => {
        const { bridge } = publishBridge();
        const found = pane("p3", "thr_c");
        vi.mocked(findDirectionalPane).mockReturnValue(pane("p2", "thr_b"));
        vi.mocked(findPaneAcrossWindow).mockReturnValue(pane("p2", "thr_b"));
        vi.mocked(findPaneFromZoomedPane).mockReturnValue(found);

        expect(runAction({ type: "pane.neighbour", direction })).toBe(true);

        expect(findPaneFromZoomedPane).toHaveBeenCalledExactlyOnceWith(
          bridge.layout?.panes,
          "p1",
          direction,
          ["p1"],
        );
        expect(focusPane).toHaveBeenCalledExactlyOnceWith(found);
      },
    );

    it.each(SIDES)(
      "does nothing and reports that it found no pane for the %s side where tmux finds none, although one lies there in bb's layout",
      (direction) => {
        publishBridge();
        vi.mocked(findDirectionalPane).mockReturnValue(pane("p2", "thr_b"));
        vi.mocked(findPaneAcrossWindow).mockReturnValue(pane("p2", "thr_b"));

        expect(runAction({ type: "pane.neighbour", direction })).toBe(false);

        expect(focusPane).not.toHaveBeenCalled();
        expect(focusSidebarRowForThread).not.toHaveBeenCalled();
        expect(toggleSidebar).not.toHaveBeenCalled();
        expect(noticeText()).toBeNull();
      },
    );

    it("hands over the panes that had the focus, the latest first", () => {
      publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)] });
      const { bridge } = publishBridge();

      runAction({ type: "pane.neighbour", direction: "up" });

      expect(findPaneFromZoomedPane).toHaveBeenCalledExactlyOnceWith(
        bridge.layout?.panes,
        "p1",
        "up",
        ["p1", "p2"],
      );
    });

    it("finds no pane while bb has no pane with the focus", () => {
      publishBridge();
      vi.mocked(getFocusedPane).mockReturnValue(null);
      vi.mocked(findPaneFromZoomedPane).mockReturnValue(pane("p2", "thr_b"));

      expect(runAction({ type: "pane.neighbour", direction: "left" })).toBe(false);

      expect(findPaneFromZoomedPane).not.toHaveBeenCalled();
      expect(focusPane).not.toHaveBeenCalled();
    });

    it.each(SIDES)(
      "leaves the move %s by direction as it is, for which tmux removes the zoom before it looks",
      (direction) => {
        const { bridge } = publishBridge();
        const neighbour = pane("p2", "thr_b");
        vi.mocked(findDirectionalPane).mockReturnValue(neighbour);

        runAction({ type: "pane.focus", direction });

        expect(findDirectionalPane).toHaveBeenCalledWith(
          bridge.layout?.panes,
          "p1",
          direction,
          ["p1"],
        );
        expect(findPaneFromZoomedPane).not.toHaveBeenCalled();
        expect(focusPane).toHaveBeenCalledExactlyOnceWith(neighbour);
      },
    );
  });
});

describe("pane.next", () => {
  it("focuses the pane that follows the focused one", () => {
    const { bridge } = publishBridge();
    const next = pane("p2", "thr_b");
    vi.mocked(findNextPane).mockReturnValue(next);

    runAction({ type: "pane.next" });

    expect(findNextPane).toHaveBeenCalledWith(bridge.layout?.panes, "p1", 1);
    expect(focusPane).toHaveBeenCalledTimes(1);
    expect(focusPane).toHaveBeenCalledWith(next);
    expect(settleDomFocus).not.toHaveBeenCalled();
  });

  it("drops what the plugin still waits to do with the focus, and leaves the wait for a new thread pane alone", () => {
    publishBridge();
    vi.mocked(findNextPane).mockReturnValue(pane("p2", "thr_b"));

    runAction({ type: "pane.next" });

    expect(cancelPendingSidebarFocus).toHaveBeenCalledTimes(1);
    expect(cancelPendingFocus).toHaveBeenCalledTimes(1);
    expect(cancelPendingResizeCheck).toHaveBeenCalledTimes(1);
    expect(callOrder(cancelPendingResizeCheck)).toBeLessThan(callOrder(focusPane));
    expect(interruptPendingNewThread).not.toHaveBeenCalled();
    expect(cancelPendingNewThread).not.toHaveBeenCalled();
  });

  it("puts the cursor back in the message box when there is a single pane", () => {
    publishBridge({ panes: null });
    vi.mocked(getFocusedPane).mockReturnValue(null);
    vi.mocked(getThreadPaneElements).mockReturnValue([paneElement()]);

    runAction({ type: "pane.next" });

    expect(findNextPane).not.toHaveBeenCalled();
    expect(focusPane).not.toHaveBeenCalled();
    expect(settleDomFocus).toHaveBeenCalledTimes(1);
  });

  it("does the same when the next pane is the focused one, as in a layout of one pane", () => {
    const only = pane("p1", "thr_a", true);
    publishBridge({ panes: [only] });
    vi.mocked(findNextPane).mockReturnValue(only);

    runAction({ type: "pane.next" });

    expect(focusPane).not.toHaveBeenCalled();
    expect(settleDomFocus).toHaveBeenCalledTimes(1);
  });

  it("goes to the next pane from a sidebar row too", () => {
    publishBridge();
    const next = pane("p2", "thr_b");
    vi.mocked(findNextPane).mockReturnValue(next);
    vi.mocked(getFocusedSidebarRow).mockReturnValue(sidebarRow());

    runAction({ type: "pane.next" });

    expect(focusPane).toHaveBeenCalledWith(next);
  });

  it("does not act on a split that bb is not showing, as on the Settings page", () => {
    publishBridge();
    vi.mocked(findNextPane).mockReturnValue(pane("p2", "thr_b"));
    vi.mocked(getThreadPaneElements).mockReturnValue([]);

    runAction({ type: "pane.next" });

    expect(focusPane).not.toHaveBeenCalled();
    expect(settleDomFocus).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });

  it("tells the user while the bridge is missing", () => {
    runAction({ type: "pane.next" });

    expect(noticeText()).toBe(LOADING_NOTICE);
    expect(focusPane).not.toHaveBeenCalled();
    expect(settleDomFocus).not.toHaveBeenCalled();
  });
});

describe("pane.previous", () => {
  it("focuses the pane that comes before the focused one", () => {
    const { bridge } = publishBridge();
    const previous = pane("p2", "thr_b");
    vi.mocked(findNextPane).mockReturnValue(previous);

    runAction({ type: "pane.previous" });

    expect(findNextPane).toHaveBeenCalledWith(bridge.layout?.panes, "p1", -1);
    expect(focusPane).toHaveBeenCalledExactlyOnceWith(previous);
  });

  it("puts the cursor back in the message box when there is a single pane", () => {
    publishBridge({ panes: null });
    vi.mocked(getFocusedPane).mockReturnValue(null);
    vi.mocked(getThreadPaneElements).mockReturnValue([paneElement()]);

    runAction({ type: "pane.previous" });

    expect(focusPane).not.toHaveBeenCalled();
    expect(settleDomFocus).toHaveBeenCalledTimes(1);
  });
});

describe("pane.last", () => {
  const NO_LAST_PANE_NOTICE = "No other pane has had the focus yet.";

  it("focuses the pane that had the focus before the focused one", () => {
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
    const now = [pane("p1", "thr_a"), pane("p2", "thr_b", true)];
    publishBridge({ panes: now });

    runAction({ type: "pane.last" });

    expect(focusPane).toHaveBeenCalledExactlyOnceWith(now[0]);
    expect(noticeText()).toBeNull();
  });

  it("goes back and forth between the two panes", () => {
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
    publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)] });
    const back = [pane("p1", "thr_a", true), pane("p2", "thr_b")];
    publishBridge({ panes: back });

    runAction({ type: "pane.last" });

    expect(focusPane).toHaveBeenCalledExactlyOnceWith(back[1]);
  });

  it("drops what the plugin still waits to do with the focus", () => {
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
    publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)] });

    runAction({ type: "pane.last" });

    expect(cancelPendingFocus).toHaveBeenCalledTimes(1);
    expect(cancelPendingResizeCheck).toHaveBeenCalledTimes(1);
  });

  it("goes to the other one of two panes when no pane is known to have had the focus before, as right after the first split", () => {
    const afterSplit = [pane("p1", "thr_a"), pane("p2", "thr_b", true)];
    publishBridge({ panes: afterSplit });

    runAction({ type: "pane.last" });

    expect(focusPane).toHaveBeenCalledExactlyOnceWith(afterSplit[0]);
    expect(noticeText()).toBeNull();
  });

  it("goes to the other one of two panes when the only other pane that had the focus is closed", () => {
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
    publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)] });
    const left = [pane("p2", "thr_b", true), pane("p3", "thr_c")];
    publishBridge({ panes: left });

    runAction({ type: "pane.last" });

    expect(focusPane).toHaveBeenCalledExactlyOnceWith(left[1]);
    expect(noticeText()).toBeNull();
  });

  it("says so when no other pane of three has had the focus, and reports that it found no pane, which is an error in tmux", () => {
    publishBridge({
      panes: [pane("p1", "thr_a", true), pane("p2", "thr_b"), pane("p3", "thr_c")],
    });

    expect(runAction({ type: "pane.last" })).toBe(false);

    expect(focusPane).not.toHaveBeenCalled();
    expect(noticeText()).toBe(NO_LAST_PANE_NOTICE);
  });

  it("reports that it found a pane to go to", () => {
    publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)] });

    expect(runAction({ type: "pane.last" })).toBe(true);
  });

  it("says so when two panes have no focused pane among them", () => {
    publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b")] });

    runAction({ type: "pane.last" });

    expect(focusPane).not.toHaveBeenCalled();
    expect(noticeText()).toBe(NO_LAST_PANE_NOTICE);
  });

  it("goes to the pane that had the focus before a pane that was closed since", () => {
    const threePanes = (focused: string): SplitPane[] =>
      ["p1", "p2", "p3"].map((id) => pane(id, `thr_${id}`, id === focused));
    publishBridge({ panes: threePanes("p1") });
    publishBridge({ panes: threePanes("p2") });
    publishBridge({ panes: threePanes("p3") });
    const left = [pane("p1", "thr_p1"), pane("p2", "thr_p2", true)];
    publishBridge({ panes: left });

    runAction({ type: "pane.last" });

    expect(focusPane).toHaveBeenCalledExactlyOnceWith(left[0]);
    expect(noticeText()).toBeNull();
  });

  it("does not act on a split that bb is not showing, as on the Settings page", () => {
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
    publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)] });
    vi.mocked(getThreadPaneElements).mockReturnValue([]);

    runAction({ type: "pane.last" });

    expect(focusPane).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });

  it("tells the user while the bridge is missing", () => {
    runAction({ type: "pane.last" });

    expect(noticeText()).toBe(LOADING_NOTICE);
  });
});

describe("entering the sidebar", () => {
  const enter = () => runAction({ type: "pane.focus", direction: "left" });

  it("shows a notice when the open sidebar has no rows", () => {
    publishBridge();
    vi.mocked(focusSidebarRowForThread).mockReturnValue(false);

    enter();

    expect(noticeText()).toBe("Could not move to a thread in the sidebar.");
  });

  it("opens a closed sidebar, waits for it and then focuses the row", () => {
    publishBridge();
    vi.mocked(isSidebarOpen).mockReturnValue(false);

    enter();
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
    expect(runCoreCommand).not.toHaveBeenCalled();
    expect(focusSidebarRowForThread).not.toHaveBeenCalled();

    runFrame();
    runFrame();
    expect(focusSidebarRowForThread).not.toHaveBeenCalled();

    vi.mocked(isSidebarOpen).mockReturnValue(true);
    runFrame();
    expect(focusSidebarRowForThread).toHaveBeenCalledWith("thr_a");
    expect(frames.size).toBe(0);
    expect(noticeText()).toBeNull();
  });

  it("keeps waiting while the opened sidebar has not mounted its rows", () => {
    publishBridge();
    vi.mocked(isSidebarOpen).mockReturnValueOnce(false).mockReturnValue(true);
    vi.mocked(focusSidebarRowForThread).mockReturnValueOnce(false).mockReturnValue(true);

    enter();
    runFrame();
    expect(frames.size).toBe(1);

    runFrame();
    expect(focusSidebarRowForThread).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
    expect(noticeText()).toBeNull();
  });

  it("falls back to bb's sidebar shortcut when the trigger is missing", () => {
    publishBridge();
    vi.mocked(isSidebarOpen).mockReturnValueOnce(false).mockReturnValue(true);
    vi.mocked(toggleSidebar).mockReturnValue(false);

    enter();

    expect(runCoreCommand).toHaveBeenCalledWith(BB_COMMANDS.sidebarToggle);
    expect(callOrder(toggleSidebar)).toBeLessThan(callOrder(runCoreCommand));
    runFrame();
    expect(focusSidebarRowForThread).toHaveBeenCalledTimes(1);
  });

  it("shows a notice when the sidebar cannot be opened", () => {
    publishBridge();
    vi.mocked(isSidebarOpen).mockReturnValue(false);
    vi.mocked(toggleSidebar).mockReturnValue(false);
    vi.mocked(runCoreCommand).mockReturnValue("unbound");

    enter();

    expect(noticeText()).toBe("Could not open the sidebar.");
    expect(frames.size).toBe(0);
  });

  it("gives up with a notice when no row appears in time", () => {
    publishBridge();
    vi.mocked(isSidebarOpen).mockReturnValue(false);

    enter();
    runFrame();
    expect(noticeText()).toBeNull();

    vi.advanceTimersByTime(999);
    runFrame();
    expect(noticeText()).toBeNull();
    expect(frames.size).toBe(1);

    vi.advanceTimersByTime(1);
    runFrame();
    expect(noticeText()).toBe("Could not move to a thread in the sidebar.");
    expect(frames.size).toBe(0);
  });

  it("stops waiting when another focus action follows", () => {
    publishBridge();
    vi.mocked(isSidebarOpen).mockReturnValue(false);

    enter();
    runAction({ type: "sidebar.leave" });
    vi.mocked(isSidebarOpen).mockReturnValue(true);
    runFrame();

    expect(focusSidebarRowForThread).not.toHaveBeenCalled();
  });

  it.each<Action>([
    { type: "copy.scroll", direction: 1 },
    { type: "copy.move", motion: "line-down" },
    { type: "help.open" },
  ])("stops waiting when any other action follows: $type", (action) => {
    publishBridge();
    vi.mocked(isSidebarOpen).mockReturnValue(false);

    enter();
    runAction(action);
    vi.mocked(isSidebarOpen).mockReturnValue(true);
    runFrame();

    expect(focusSidebarRowForThread).not.toHaveBeenCalled();
  });
});

describe("sidebar actions", () => {
  it("moves between rows", () => {
    runAction({ type: "sidebar.move", delta: 1 });
    runAction({ type: "sidebar.move", delta: -1 });

    expect(vi.mocked(moveSidebarFocus).mock.calls).toEqual([[1], [-1]]);
  });

  it("moves a page of rows at a time", () => {
    runAction({ type: "sidebar.page", delta: 1 });
    runAction({ type: "sidebar.page", delta: -1 });

    expect(vi.mocked(pageSidebarFocus).mock.calls).toEqual([[1], [-1]]);
    expect(moveSidebarFocus).not.toHaveBeenCalled();
  });

  it("jumps to the first and last row", () => {
    runAction({ type: "sidebar.edge", edge: "top" });
    runAction({ type: "sidebar.edge", edge: "bottom" });

    expect(vi.mocked(focusSidebarEdge).mock.calls).toEqual([["top"], ["bottom"]]);
  });

  it.each(["replace", "right", "down"] as const)(
    "opens the focused row's thread with placement %s",
    (placement) => {
      const row = sidebarRow();
      vi.mocked(getFocusedSidebarRow).mockReturnValue(row);
      vi.mocked(sidebarRowThreadId).mockReturnValue("thr_row");

      runAction({ type: "sidebar.open", placement });

      expect(sidebarRowThreadId).toHaveBeenCalledWith(row);
      expect(openThread).toHaveBeenCalledWith("thr_row", placement);
    },
  );

  it("opens nothing when no row has focus", () => {
    runAction({ type: "sidebar.open", placement: "replace" });

    expect(openThread).not.toHaveBeenCalled();
  });

  it("returns to the pane on leave", () => {
    runAction({ type: "sidebar.leave" });

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
  });
});

describe("composer.focus", () => {
  it("places the text cursor by the rule of a pane move, and says nothing", () => {
    expect(runAction({ type: "composer.focus" })).toBe(true);

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
    expect(settleDomFocus).toHaveBeenCalledWith();
    expect(noticeText()).toBeNull();
  });

  it("needs no bridge, as leaving the sidebar does not", () => {
    setBridge(null);

    runAction({ type: "composer.focus" });

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
    expect(noticeText()).toBeNull();
  });

  it("leaves the cursor where it is on a page that shows no pane, such as Settings", () => {
    vi.mocked(getThreadPaneElements).mockReturnValue([]);

    expect(runAction({ type: "composer.focus" })).toBe(true);

    expect(settleDomFocus).not.toHaveBeenCalled();
    expect(focusPaneElement).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });

  it("goes to the message box of a single pane, which bb wraps in a pane element too", () => {
    publishBridge({ panes: null });
    vi.mocked(getThreadPaneElements).mockReturnValue([paneElement()]);

    runAction({ type: "composer.focus" });

    expect(settleDomFocus).toHaveBeenCalledTimes(1);
  });

  it("leaves a pane move that has not settled yet to place the cursor after it", () => {
    runAction({ type: "composer.focus" });

    expect(cancelPendingFocus).not.toHaveBeenCalled();
    expect(focusPane).not.toHaveBeenCalled();
    expect(settleDomFocusWhen).not.toHaveBeenCalled();
  });

  it("stops a wait for the sidebar to open", () => {
    publishBridge();
    vi.mocked(isSidebarOpen).mockReturnValue(false);
    runAction({ type: "pane.focus", direction: "left" });

    runAction({ type: "composer.focus" });
    vi.mocked(isSidebarOpen).mockReturnValue(true);
    runFrame();

    expect(focusSidebarRowForThread).not.toHaveBeenCalled();
    expect(settleDomFocus).toHaveBeenCalledTimes(1);
  });
});

describe("pane.zoom", () => {
  it("does nothing with a single pane", () => {
    publishBridge({ panes: null });

    runAction({ type: "pane.zoom" });

    expect(runCoreCommand).not.toHaveBeenCalled();
    expect(clickMaximizePane).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });

  it("uses bb's command first", () => {
    const { threads } = publishBridge();

    runAction({ type: "pane.zoom" });

    expect(runCoreCommand).toHaveBeenCalledWith(BB_COMMANDS.paneMaximizeToggle);
    expect(clickMaximizePane).not.toHaveBeenCalled();
    expect(threads.paneAction).not.toHaveBeenCalled();
  });

  it.each(["declined", "unbound"] as const)(
    "clicks the maximize button when the command is %s",
    (result) => {
      const { threads } = publishBridge();
      vi.mocked(runCoreCommand).mockReturnValue(result);

      runAction({ type: "pane.zoom" });

      expect(clickMaximizePane).toHaveBeenCalledTimes(1);
      expect(callOrder(runCoreCommand)).toBeLessThan(callOrder(clickMaximizePane));
      expect(threads.paneAction).not.toHaveBeenCalled();
      expect(noticeText()).toBeNull();
    },
  );

  it("falls back to the SDK pane action for a thread pane", () => {
    const { threads } = publishBridge();
    vi.mocked(runCoreCommand).mockReturnValue("unbound");
    vi.mocked(clickMaximizePane).mockReturnValue(false);

    runAction({ type: "pane.zoom" });

    expect(threads.paneAction).toHaveBeenCalledWith({ threadId: "thr_a", action: "toggle" });
    expect(callOrder(clickMaximizePane)).toBeLessThan(callOrder(threads.paneAction));
    expect(noticeText()).toBeNull();
  });

  it("does not send the pane action to other windows when this one shows no pane", () => {
    const { threads } = publishBridge();
    vi.mocked(runCoreCommand).mockReturnValue("declined");
    vi.mocked(clickMaximizePane).mockReturnValue(false);
    vi.mocked(getFocusedPaneElement).mockReturnValue(null);

    runAction({ type: "pane.zoom" });

    expect(threads.paneAction).not.toHaveBeenCalled();
    expect(noticeText()).toBe("Could not zoom this pane.");
  });

  it("shows a notice when nothing can zoom a pane without a thread", () => {
    const { threads } = publishBridge();
    vi.mocked(runCoreCommand).mockReturnValue("unbound");
    vi.mocked(clickMaximizePane).mockReturnValue(false);
    vi.mocked(getFocusedThreadId).mockReturnValue(null);

    runAction({ type: "pane.zoom" });

    expect(threads.paneAction).not.toHaveBeenCalled();
    expect(noticeText()).toBe("Could not zoom this pane.");
  });

  it("shows a notice when the SDK pane action rejects", async () => {
    const { threads } = publishBridge();
    vi.mocked(runCoreCommand).mockReturnValue("unbound");
    vi.mocked(clickMaximizePane).mockReturnValue(false);
    threads.paneAction.mockReturnValue(Promise.reject(new Error("offline")));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    runAction({ type: "pane.zoom" });
    await Promise.resolve();
    await Promise.resolve();

    expect(noticeText()).not.toBeNull();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("tells the user while the bridge is missing", () => {
    runAction({ type: "pane.zoom" });

    expect(noticeText()).toBe(LOADING_NOTICE);
    expect(runCoreCommand).not.toHaveBeenCalled();
  });
});

describe("pane.close", () => {
  it("does nothing with a single pane", () => {
    publishBridge({ panes: null });

    runAction({ type: "pane.close" });

    expect(clickClosePane).not.toHaveBeenCalled();
    expect(runCoreCommand).not.toHaveBeenCalled();
    expect(settleDomFocusWhen).not.toHaveBeenCalled();
  });

  it("clicks the close button first and settles focus once the layout changed", () => {
    publishBridge();

    runAction({ type: "pane.close" });

    expect(clickClosePane).toHaveBeenCalledTimes(1);
    expect(runCoreCommand).not.toHaveBeenCalled();
    expect(settleDomFocusWhen).toHaveBeenCalledTimes(1);

    const isReady = vi.mocked(settleDomFocusWhen).mock.calls[0][0];
    expect(isReady()).toBe(false);
    publishBridge({ panes: twoPanes() });
    expect(isReady()).toBe(false);
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p3", "thr_c")] });
    expect(isReady()).toBe(true);
    publishBridge({ panes: null });
    vi.mocked(getFocusedThreadId).mockReturnValue("thr_b");
    expect(isReady()).toBe(true);
  });

  // bb's closePane sets the layout first and navigates second, and the
  // navigation is rendered later. With a single pane the focused thread is
  // the thread of the route.
  it("waits for the route to name the pane that stays when the second of two panes is closed", () => {
    publishBridge();
    runAction({ type: "pane.close" });
    const isReady = vi.mocked(settleDomFocusWhen).mock.calls[0][0];

    publishBridge({ panes: null });
    vi.mocked(getFocusedThreadId).mockReturnValue("thr_a");
    expect(isReady()).toBe(false);

    vi.mocked(getFocusedThreadId).mockReturnValue("thr_b");
    expect(isReady()).toBe(true);
  });

  it("waits for a route without a thread when the pane that stays shows the New thread screen", () => {
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", null)] });
    runAction({ type: "pane.close" });
    const isReady = vi.mocked(settleDomFocusWhen).mock.calls[0][0];

    publishBridge({ panes: null });
    vi.mocked(getFocusedThreadId).mockReturnValue("thr_a");
    expect(isReady()).toBe(false);

    vi.mocked(getFocusedThreadId).mockReturnValue(null);
    expect(isReady()).toBe(true);
  });

  it("goes by the layout alone while more than one pane is left, because the layout names the thread of each", () => {
    publishBridge({
      panes: [pane("p1", "thr_a", true), pane("p2", "thr_b"), pane("p3", "thr_c")],
    });
    runAction({ type: "pane.close" });
    const isReady = vi.mocked(settleDomFocusWhen).mock.calls[0][0];
    vi.mocked(getFocusedThreadId).mockReturnValue("thr_a");
    expect(isReady()).toBe(false);

    publishBridge({ panes: [pane("p2", "thr_b", true), pane("p3", "thr_c")] });
    expect(isReady()).toBe(true);

    publishBridge({ panes: null });
    expect(isReady()).toBe(true);
  });

  it("leaves the wait for the route to the timeout of the settle", () => {
    publishBridge();
    runAction({ type: "pane.close" });

    expect(vi.mocked(settleDomFocusWhen).mock.calls[0][1]).toBeUndefined();
  });

  describe("the pane that gets the focus after the close", () => {
    const threePanes = (focused: string): SplitPane[] =>
      ["p1", "p2", "p3"].map((id) => pane(id, `thr_${id}`, id === focused));

    function closeAndLetBbFocus(left: SplitPane[]): void {
      runAction({ type: "pane.close" });
      const settle = vi.mocked(settleDomFocusWhen).mock.calls[0][2];
      publishBridge({ panes: left });
      settle?.();
    }

    it("is the pane that had the focus before, as in tmux, and not the one that bb gave it to", () => {
      publishBridge({ panes: threePanes("p3") });
      publishBridge({ panes: threePanes("p1") });
      const left = [pane("p2", "thr_p2", true), pane("p3", "thr_p3")];

      closeAndLetBbFocus(left);

      expect(focusPane).toHaveBeenCalledExactlyOnceWith(left[1]);
      expect(settleDomFocus).not.toHaveBeenCalled();
    });

    it("leaves the pane that bb gave the focus to out of the panes that had it, so that last-pane then goes to the pane before, as in tmux", () => {
      const fourPanes = (focused: string): SplitPane[] =>
        ["p1", "p2", "p3", "p4"].map((id) => pane(id, `thr_${id}`, id === focused));
      publishBridge({ panes: fourPanes("p2") });
      publishBridge({ panes: fourPanes("p1") });
      publishBridge({ panes: fourPanes("p4") });

      closeAndLetBbFocus(threePanes("p3"));
      expect(focusPane).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ paneId: "p1" }),
      );
      publishBridge({ panes: threePanes("p3") });
      const moved = threePanes("p1");
      publishBridge({ panes: moved });
      vi.mocked(focusPane).mockClear();

      runAction({ type: "pane.last" });

      expect(focusPane).toHaveBeenCalledExactlyOnceWith(moved[1]);
    });

    it("stays the pane that bb gave the focus to when that is the pane that had it before", () => {
      publishBridge({ panes: threePanes("p2") });
      publishBridge({ panes: threePanes("p1") });

      closeAndLetBbFocus([pane("p2", "thr_p2", true), pane("p3", "thr_p3")]);

      expect(focusPane).not.toHaveBeenCalled();
      expect(settleDomFocus).toHaveBeenCalledTimes(1);
    });

    it("stays the pane that bb gave the focus to when no other pane has had the focus", () => {
      publishBridge({ panes: threePanes("p1") });

      closeAndLetBbFocus([pane("p2", "thr_p2", true), pane("p3", "thr_p3")]);

      expect(focusPane).not.toHaveBeenCalled();
      expect(settleDomFocus).toHaveBeenCalledTimes(1);
    });

    it("stays the only pane that is left of two", () => {
      publishBridge({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)] });
      publishBridge({ panes: twoPanes() });
      runAction({ type: "pane.close" });
      const settle = vi.mocked(settleDomFocusWhen).mock.calls[0][2];
      publishBridge({ panes: null, contextThreadId: "thr_b" });

      settle?.();

      expect(focusPane).not.toHaveBeenCalled();
      expect(settleDomFocus).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to bb's command when the button is missing", () => {
    publishBridge();
    vi.mocked(clickClosePane).mockReturnValue(false);

    runAction({ type: "pane.close" });

    expect(runCoreCommand).toHaveBeenCalledWith(BB_COMMANDS.paneClose);
    expect(callOrder(clickClosePane)).toBeLessThan(callOrder(runCoreCommand));
    expect(settleDomFocusWhen).toHaveBeenCalledTimes(1);
    expect(noticeText()).toBeNull();
  });

  it.each(["declined", "unbound"] as const)(
    "shows a notice when the button is missing and the command is %s",
    (result) => {
      publishBridge();
      vi.mocked(clickClosePane).mockReturnValue(false);
      vi.mocked(runCoreCommand).mockReturnValue(result);

      runAction({ type: "pane.close" });

      expect(noticeText()).toBe("Could not close this pane.");
      expect(settleDomFocusWhen).not.toHaveBeenCalled();
    },
  );

  it("tells the user while the bridge is missing", () => {
    runAction({ type: "pane.close" });

    expect(noticeText()).toBe(LOADING_NOTICE);
    expect(clickClosePane).not.toHaveBeenCalled();
  });
});

describe("pane.resize", () => {
  it.each(["left", "down", "up", "right"] as const)(
    "resizes the focused pane %s by the cells of the key, each worth the pixels of the setting",
    (direction) => {
      publishBridge({ settings: { resizeCellPx: 12 } });

      runAction({ type: "pane.resize", direction, cells: 5 });

      expect(vi.mocked(resizeFocusedPane).mock.calls).toEqual([[direction, 60]]);
      expect(noticeText()).toBeNull();
    },
  );

  it("resizes by one cell of 10 pixels for tmux's default adjustment and the default setting", () => {
    publishBridge();

    runAction({ type: "pane.resize", direction: "left", cells: 1 });

    expect(resizeFocusedPane).toHaveBeenCalledExactlyOnceWith("left", 10);
  });

  it.each([true, false])(
    "reports %s when the resize says that about a divider to move",
    (hasDivider) => {
      vi.mocked(resizeFocusedPane).mockReturnValue(hasDivider);

      expect(runAction({ type: "pane.resize", direction: "right", cells: 5 })).toBe(hasDivider);
    },
  );

  it("reports that there was nothing to act on when the resize threw", () => {
    vi.mocked(resizeFocusedPane).mockImplementation(() => {
      throw new Error("bb markup changed");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(runAction({ type: "pane.resize", direction: "up", cells: 5 })).toBe(false);
  });

  it("reports true for every other action, whatever the resize would say", () => {
    publishBridge();
    vi.mocked(resizeFocusedPane).mockReturnValue(false);

    expect(runAction({ type: "help.open" })).toBe(true);
    expect(runAction({ type: "pane.focus", direction: "left" })).toBe(true);
    expect(runAction({ type: "copy.scroll", direction: 1 })).toBe(true);
    expect(resizeFocusedPane).not.toHaveBeenCalled();
  });

  it("uses the default size of a cell while the bridge is missing", () => {
    runAction({ type: "pane.resize", direction: "right", cells: 5 });

    expect(resizeFocusedPane).toHaveBeenCalledWith(
      "right",
      5 * DEFAULT_SETTINGS.resizeCellPx,
    );
    expect(noticeText()).toBeNull();
  });

  it("leaves the pane focus, the zoom and the layout alone", () => {
    const { navigate, threads } = publishBridge();

    runAction({ type: "pane.resize", direction: "left", cells: 5 });

    expect(focusPane).not.toHaveBeenCalled();
    expect(settleDomFocus).not.toHaveBeenCalled();
    expect(runCoreCommand).not.toHaveBeenCalled();
    expect(navigate.toThread).not.toHaveBeenCalled();
    expect(threads.paneAction).not.toHaveBeenCalled();
  });

  it("never throws: it logs the error and shows a notice", () => {
    const failure = new Error("bb markup changed");
    vi.mocked(resizeFocusedPane).mockImplementation(() => {
      throw failure;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runAction({ type: "pane.resize", direction: "up", cells: 5 })).not.toThrow();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]).toContain(failure);
    expect(noticeText()).toBe("That key did not work. See the console for details.");
  });
});

describe("chooser.open and help.open", () => {
  it.each(["replace", "right", "down"] as const)(
    "opens the chooser with placement %s",
    (placement) => {
      runAction({ type: "chooser.open", placement });

      expect(getUiState().chooser).toEqual({ open: true, placement });
    },
  );

  it("opens the help", () => {
    runAction({ type: "help.open" });

    expect(getUiState().helpOpen).toBe(true);
    expect(noticeText()).toBeNull();
  });
});

describe("thread actions", () => {
  it("starts a new thread in the focused pane with the prompt focused", () => {
    const { navigate } = publishBridge();

    runAction({ type: "thread.new" });

    expect(navigate.toCompose).toHaveBeenCalledWith({ focusPrompt: true });
    expect(cancelPendingFocus).toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });

  it("says that bb moved to the New thread screen of another pane, where the focused pane keeps its thread", () => {
    const { navigate, bridge } = publishBridge();
    vi.mocked(hasNewThreadScreenInAnotherPane).mockReturnValue(true);

    runAction({ type: "thread.new" });

    expect(hasNewThreadScreenInAnotherPane).toHaveBeenCalledWith(bridge);
    expect(navigate.toCompose).toHaveBeenCalledWith({ focusPrompt: true });
    expect(noticeText()).toBe(
      "bb shows the New thread screen in one pane only, so you were moved to it.",
    );
  });

  it("jumps to thread N of the resolved order", () => {
    const threads = [{ id: "thr_a" }, { id: "thr_b" }];
    publishBridge({ threads, settings: { threadOrder: "sidebar" } });
    vi.mocked(readSidebarThreadOrder).mockReturnValue(["thr_b", "thr_a"]);
    vi.mocked(resolveThreadOrder).mockReturnValue({
      order: ["thr_b", "thr_a"],
      source: "sidebar",
    });
    vi.mocked(nthThread).mockReturnValue("thr_a");

    runAction({ type: "thread.jump", index: 2 });

    expect(resolveThreadOrder).toHaveBeenCalledWith({
      mode: "sidebar",
      domOrder: ["thr_b", "thr_a"],
      threads,
    });
    expect(nthThread).toHaveBeenCalledWith(["thr_b", "thr_a"], 2);
    expect(openThread).toHaveBeenCalledWith("thr_a", "replace");
  });

  it("jumps to the last thread of the resolved order", () => {
    const threads = [{ id: "thr_a" }, { id: "thr_b" }];
    publishBridge({ threads, settings: { threadOrder: "sidebar" } });
    vi.mocked(readSidebarThreadOrder).mockReturnValue(["thr_b", "thr_a"]);
    vi.mocked(resolveThreadOrder).mockReturnValue({
      order: ["thr_b", "thr_a"],
      source: "sidebar",
    });
    vi.mocked(lastThread).mockReturnValue("thr_a");

    expect(runAction({ type: "thread.end" })).toBe(true);

    expect(resolveThreadOrder).toHaveBeenCalledWith({
      mode: "sidebar",
      domOrder: ["thr_b", "thr_a"],
      threads,
    });
    expect(vi.mocked(lastThread).mock.calls[0][0]).toEqual(["thr_b", "thr_a"]);
    expect(openThread).toHaveBeenCalledExactlyOnceWith("thr_a", "replace");
  });

  it("passes the configured order mode", () => {
    publishBridge({ settings: { threadOrder: "recent" } });

    runAction({ type: "thread.jump", index: 1 });

    expect(vi.mocked(resolveThreadOrder).mock.calls[0][0].mode).toBe("recent");
  });

  it.each([1, -1] as const)("cycles threads by %i from the focused thread", (delta) => {
    publishBridge();
    vi.mocked(resolveThreadOrder).mockReturnValue({
      order: ["thr_a", "thr_b"],
      source: "recent",
    });
    vi.mocked(cycleThread).mockReturnValue("thr_b");

    runAction({ type: "thread.cycle", delta });

    expect(cycleThread).toHaveBeenCalledWith(["thr_a", "thr_b"], "thr_a", delta);
    expect(openThread).toHaveBeenCalledWith("thr_b", "replace");
  });

  it("opens nothing when the order has no such thread, and reports that, which is an error in tmux", () => {
    publishBridge();

    expect(runAction({ type: "thread.jump", index: 9 })).toBe(false);
    expect(runAction({ type: "thread.end" })).toBe(false);
    expect(runAction({ type: "thread.cycle", delta: 1 })).toBe(false);

    expect(openThread).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });

  it("reports that it found a thread to go to", () => {
    publishBridge();
    vi.mocked(nthThread).mockReturnValue("thr_b");
    vi.mocked(cycleThread).mockReturnValue("thr_b");

    expect(runAction({ type: "thread.jump", index: 2 })).toBe(true);
    expect(runAction({ type: "thread.cycle", delta: 1 })).toBe(true);
  });

  it("goes back to the thread that the focused pane showed before", () => {
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
    publishBridge({ panes: [pane("p1", "thr_c", true), pane("p2", "thr_b")] });

    expect(runAction({ type: "thread.last" })).toBe(true);

    expect(openThread).toHaveBeenCalledExactlyOnceWith("thr_a", "replace");
    expect(noticeText()).toBeNull();
  });

  it.each([
    ["was archived since", [{ id: "thr_a", isArchived: true }, { id: "thr_c" }]],
    ["was deleted since", [{ id: "thr_c" }]],
  ])("does not go back to a thread that %s, and says that there is none", (_name, threads) => {
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
    publishBridge({ panes: [pane("p1", "thr_c", true), pane("p2", "thr_b")], threads });

    expect(runAction({ type: "thread.last" })).toBe(false);

    expect(openThread).not.toHaveBeenCalled();
    expect(noticeText()).toBe("This pane has not shown another thread yet.");
  });

  it("goes back to a thread that bb does not list while its thread list is still loading", () => {
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
    const { bridge } = publishBridge({
      panes: [pane("p1", "thr_c", true), pane("p2", "thr_b")],
      threads: [],
    });
    setBridge({ ...bridge, threadsReady: false });

    runAction({ type: "thread.last" });

    expect(openThread).toHaveBeenCalledExactlyOnceWith("thr_a", "replace");
  });

  it("keeps the threads of each pane apart", () => {
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_d")] });
    vi.mocked(getFocusedPane).mockReturnValue(pane("p2", "thr_d", true));

    runAction({ type: "thread.last" });

    expect(openThread).toHaveBeenCalledExactlyOnceWith("thr_b", "replace");
  });

  it("goes back to the thread that a window without a split showed before", () => {
    publishBridge({ panes: null, contextThreadId: "thr_a" });
    publishBridge({ panes: null, contextThreadId: null });
    publishBridge({ panes: null, contextThreadId: "thr_b" });

    runAction({ type: "thread.last" });

    expect(openThread).toHaveBeenCalledExactlyOnceWith("thr_a", "replace");
  });

  it("goes back from the New thread screen to the thread that the window showed last", () => {
    publishBridge({ panes: null, contextThreadId: "thr_x" });
    publishBridge({ panes: null, contextThreadId: "thr_a" });
    publishBridge({ panes: null, contextThreadId: null });

    runAction({ type: "thread.last" });

    expect(openThread).toHaveBeenCalledExactlyOnceWith("thr_a", "replace");
    expect(noticeText()).toBeNull();
  });

  it("goes back from the New thread screen of a pane to the only thread that the pane has shown", () => {
    publishBridge({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] });
    publishBridge({ panes: [pane("p1", null, true), pane("p2", "thr_b")] });
    vi.mocked(getFocusedPane).mockReturnValue(pane("p1", null, true));

    runAction({ type: "thread.last" });

    expect(openThread).toHaveBeenCalledExactlyOnceWith("thr_a", "replace");
  });

  it("still knows the thread before, once the pane shows its last thread again after the New thread screen", () => {
    publishBridge({ panes: null, contextThreadId: "thr_x" });
    publishBridge({ panes: null, contextThreadId: "thr_a" });
    publishBridge({ panes: null, contextThreadId: null });
    publishBridge({ panes: null, contextThreadId: "thr_a" });

    runAction({ type: "thread.last" });

    expect(openThread).toHaveBeenCalledExactlyOnceWith("thr_x", "replace");
  });

  it("says so when the pane has shown no other thread", () => {
    publishBridge();

    runAction({ type: "thread.last" });

    expect(openThread).not.toHaveBeenCalled();
    expect(noticeText()).toBe("This pane has not shown another thread yet.");
  });

  it.each<Action>([
    { type: "thread.new" },
    { type: "thread.jump", index: 1 },
    { type: "thread.end" },
    { type: "thread.cycle", delta: 1 },
    { type: "thread.last" },
  ])("tells the user while the bridge is missing: $type", (action) => {
    runAction(action);

    expect(noticeText()).toBe(LOADING_NOTICE);
    expect(openThread).not.toHaveBeenCalled();
  });
});

describe("copy mode actions", () => {
  const MOTIONS: CopyMotion[] = [
    "char-left",
    "char-right",
    "line-up",
    "line-down",
    "word-forward",
    "word-back",
    "word-end",
    "line-start",
    "line-indent",
    "line-end",
    "paragraph-back",
    "paragraph-forward",
    "document-start",
    "document-end",
    "screen-top",
    "screen-middle",
    "screen-bottom",
    "half-page-up",
    "half-page-down",
    "page-up",
    "page-down",
  ];

  const TEXT_FIELD_HTML = '<textarea data-focus=""></textarea>';
  const MESSAGE_BOX_HTML = `
    <div data-app-composer="">
      <div contenteditable="true" role="textbox" tabindex="0" data-focus=""></div>
    </div>`;
  const SIDEBAR_ROW_HTML = `
    <a href="/t/thr_a" data-sidebar-thread-shortcut-target=""
      data-sidebar-thread-id="thr_a" data-focus="">Alpha</a>`;

  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function focusFixture(html: string): void {
    document.body.innerHTML = html;
    document.querySelector<HTMLElement>("[data-focus]")?.focus();
  }

  it("enters copy mode", () => {
    runAction({ type: "copy.enter", motion: null });

    expect(enterCopyMode).toHaveBeenCalledTimes(1);
    expect(enterCopyMode).toHaveBeenCalledWith();
    expect(moveCopyCursor).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });

  it("enters copy mode and then scrolls one page up", () => {
    focusFixture(MESSAGE_BOX_HTML);

    runAction({ type: "copy.enter", motion: "page-up" });

    expect(enterCopyMode).toHaveBeenCalledTimes(1);
    expect(moveCopyCursor).toHaveBeenCalledTimes(1);
    expect(moveCopyCursor).toHaveBeenCalledWith("page-up");
    expect(callOrder(enterCopyMode)).toBeLessThan(callOrder(focusPaneElement));
    expect(callOrder(focusPaneElement)).toBeLessThan(callOrder(moveCopyCursor));
  });

  it("does not move when copy mode could not start for the page up", () => {
    vi.mocked(enterCopyMode).mockReturnValue(false);

    runAction({ type: "copy.enter", motion: "page-up" });

    expect(moveCopyCursor).not.toHaveBeenCalled();
    expect(noticeText()).toBe("There is no conversation text to select here");
  });

  it("says so when there is no conversation text to enter copy mode on", () => {
    vi.mocked(enterCopyMode).mockReturnValue(false);

    runAction({ type: "copy.enter", motion: null });

    expect(noticeText()).toBe("There is no conversation text to select here");
    expect(cancelPendingFocus).not.toHaveBeenCalled();
  });

  it("drops a pane move that has not settled, which would put the cursor in the message box", () => {
    focusFixture(MESSAGE_BOX_HTML);

    runAction({ type: "copy.enter", motion: null });

    expect(cancelPendingFocus).toHaveBeenCalledTimes(1);
    expect(callOrder(enterCopyMode)).toBeLessThan(callOrder(cancelPendingFocus));
    expect(callOrder(cancelPendingFocus)).toBeLessThan(callOrder(focusPaneElement));
  });

  it.each([
    ["the message box", MESSAGE_BOX_HTML],
    ["a text field", TEXT_FIELD_HTML],
    ["the terminal", `<div data-app-terminal="">${TEXT_FIELD_HTML}</div>`],
    ["a sidebar thread row", SIDEBAR_ROW_HTML],
    ["a button, which Space and Enter would press", '<button type="button" data-focus="">Copy</button>'],
    ["a row that opens on Space and Enter", '<div role="button" tabindex="0" data-focus="">Tool call</div>'],
    ["a link", '<a href="https://example.com" data-focus="">Docs</a>'],
  ])("moves the cursor from %s to the pane once copy mode is on", (_place, html) => {
    const focusedPane = paneElement();
    vi.mocked(getFocusedPaneElement).mockReturnValue(focusedPane);
    focusFixture(html);
    expect(document.activeElement).not.toBe(document.body);

    runAction({ type: "copy.enter", motion: null });

    expect(focusPaneElement).toHaveBeenCalledTimes(1);
    expect(focusPaneElement).toHaveBeenCalledWith(focusedPane);
    expect(callOrder(enterCopyMode)).toBeLessThan(callOrder(focusPaneElement));
  });

  it("blurs the text field when there is a single pane without a pane element", () => {
    vi.mocked(getFocusedPaneElement).mockReturnValue(null);
    focusFixture(TEXT_FIELD_HTML);

    runAction({ type: "copy.enter", motion: null });

    expect(focusPaneElement).toHaveBeenCalledWith(null);
  });

  it.each([
    ["nothing", ""],
    ["the pane", '<div tabindex="-1" data-focus=""></div>'],
  ])("leaves the cursor alone when %s has focus", (_place, html) => {
    focusFixture(html);

    runAction({ type: "copy.enter", motion: null });

    expect(enterCopyMode).toHaveBeenCalledTimes(1);
    expect(focusPaneElement).not.toHaveBeenCalled();
  });

  it("leaves the cursor in the text field when copy mode could not start", () => {
    vi.mocked(enterCopyMode).mockReturnValue(false);
    focusFixture(TEXT_FIELD_HTML);

    runAction({ type: "copy.enter", motion: null });

    expect(focusPaneElement).not.toHaveBeenCalled();
  });

  it.each(MOTIONS)("moves the copy cursor: %s", (motion) => {
    runAction({ type: "copy.move", motion });

    expect(moveCopyCursor).toHaveBeenCalledTimes(1);
    expect(moveCopyCursor).toHaveBeenCalledWith(motion);
    expect(noticeText()).toBeNull();
  });

  it.each([
    [1, 120, 120],
    [-1, 120, -120],
    [1, 40, 40],
  ] as const)(
    "scrolls the conversation by the configured step: direction %i, step %i",
    (direction, scrollStepPx, deltaPx) => {
      publishBridge({ settings: { scrollStepPx } });

      runAction({ type: "copy.scroll", direction });

      expect(scrollCopyView).toHaveBeenCalledTimes(1);
      expect(scrollCopyView).toHaveBeenCalledWith(deltaPx);
      expect(exitCopyMode).not.toHaveBeenCalled();
    },
  );

  it("scrolls by the default step while the bridge is missing", () => {
    runAction({ type: "copy.scroll", direction: -1 });

    expect(scrollCopyView).toHaveBeenCalledWith(-DEFAULT_SETTINGS.scrollStepPx);
  });

  it("starts a selection", () => {
    runAction({ type: "copy.beginSelection" });

    expect(beginCopySelection).toHaveBeenCalledTimes(1);
    expect(beginCopySelection).toHaveBeenCalledWith();
    expect(clearCopySelection).not.toHaveBeenCalled();
  });

  it("drops the selection", () => {
    runAction({ type: "copy.clearSelection" });

    expect(clearCopySelection).toHaveBeenCalledTimes(1);
    expect(clearCopySelection).toHaveBeenCalledWith();
    expect(beginCopySelection).not.toHaveBeenCalled();
    expect(exitCopyMode).not.toHaveBeenCalled();
  });

  it("leaves copy mode, and leaves the cursor to the key handler", () => {
    runAction({ type: "copy.exit" });

    expect(exitCopyMode).toHaveBeenCalledTimes(1);
    expect(exitCopyMode).toHaveBeenCalledWith();
    expect(settleIdleDomFocus).not.toHaveBeenCalled();
    expect(noticeText()).toBeNull();
  });

  it.each(["copied", "empty", "failed"] as const)(
    "copies the selection and leaves the %s outcome to the copy engine",
    async (outcome) => {
      vi.mocked(isCopyModeActive).mockReturnValue(true);
      vi.mocked(yankCopySelection).mockResolvedValue(outcome);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      runAction({ type: "copy.yank", after: "exit" });
      await settle();

      expect(yankCopySelection).toHaveBeenCalledTimes(1);
      expect(yankCopySelection).toHaveBeenCalledWith("exit");
      expect(exitCopyMode).not.toHaveBeenCalled();
      expect(noticeText()).toBeNull();
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it.each(["exit", "clear", "keep"] as const)(
    "tells the copy engine what follows the copy: %s",
    (after) => {
      vi.mocked(isCopyModeActive).mockReturnValue(true);

      runAction({ type: "copy.yank", after });

      expect(yankCopySelection).toHaveBeenCalledExactlyOnceWith(after);
    },
  );

  it("copies nothing outside copy mode, where a key of the tmux config can ask for it too", async () => {
    runAction({ type: "copy.yank", after: "exit" });
    await settle();

    expect(yankCopySelection).not.toHaveBeenCalled();
    expect(settleIdleDomFocus).not.toHaveBeenCalled();
  });

  it.each(["copied", "empty"] as const)(
    "puts the cursor back in the message box once a copy that was %s has ended copy mode",
    async (outcome) => {
      vi.mocked(isCopyModeActive).mockReturnValueOnce(true);
      vi.mocked(yankCopySelection).mockResolvedValue(outcome);

      runAction({ type: "copy.yank", after: "exit" });
      expect(settleIdleDomFocus).not.toHaveBeenCalled();
      await settle();

      expect(settleIdleDomFocus).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["clear", "keep"] as const)(
    "leaves the cursor on the pane when a copy that stays in copy mode (%s) finds the selection lost, so that the keys after it are not typed",
    async (after) => {
      vi.mocked(isCopyModeActive).mockReturnValueOnce(true);
      vi.mocked(yankCopySelection).mockResolvedValue("empty");

      runAction({ type: "copy.yank", after });
      await settle();

      expect(isCopyModeActive()).toBe(false);
      expect(settleIdleDomFocus).not.toHaveBeenCalled();
    },
  );

  it.each(["copied", "empty", "failed"] as const)(
    "leaves the cursor on the pane after a copy that was %s and stays in copy mode",
    async (outcome) => {
      vi.mocked(yankCopySelection).mockResolvedValue(outcome);
      vi.mocked(isCopyModeActive).mockReturnValue(true);
      vi.spyOn(console, "error").mockImplementation(() => {});

      runAction({ type: "copy.yank", after: "clear" });
      await settle();

      expect(settleIdleDomFocus).not.toHaveBeenCalled();
    },
  );

  it("catches a rejected copy: it logs the error and shows a notice", async () => {
    const failure = new Error("clipboard is blocked");
    vi.mocked(isCopyModeActive).mockReturnValue(true);
    vi.mocked(yankCopySelection).mockRejectedValue(failure);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    runAction({ type: "copy.yank", after: "exit" });
    await settle();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]).toContain(failure);
    expect(noticeText()).toBe("That key did not work. See the console for details.");
  });

  it("survives a copy engine that throws at once", () => {
    const failure = new Error("no selection api");
    vi.mocked(isCopyModeActive).mockReturnValue(true);
    vi.mocked(yankCopySelection).mockImplementation(() => {
      throw failure;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runAction({ type: "copy.yank", after: "exit" })).not.toThrow();

    expect(consoleError.mock.calls[0]).toContain(failure);
    expect(noticeText()).toBe("That key did not work. See the console for details.");
  });

  it.each<Action>([
    { type: "copy.enter", motion: null },
    { type: "copy.move", motion: "line-down" },
    { type: "copy.scroll", direction: 1 },
    { type: "copy.beginSelection" },
    { type: "copy.clearSelection" },
    { type: "copy.exit" },
  ])("never throws when the copy engine does: $type", (action) => {
    const failure = new Error("bb markup changed");
    for (const engine of [
      enterCopyMode,
      moveCopyCursor,
      scrollCopyView,
      beginCopySelection,
      clearCopySelection,
      exitCopyMode,
    ]) {
      vi.mocked(engine).mockImplementation(() => {
        throw failure;
      });
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runAction(action)).not.toThrow();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(noticeText()).toBe("That key did not work. See the console for details.");
  });

  it("stops waiting for the sidebar, like every other action", () => {
    publishBridge();
    vi.mocked(isSidebarOpen).mockReturnValue(false);
    runAction({ type: "pane.focus", direction: "left" });

    runAction({ type: "copy.enter", motion: null });
    vi.mocked(isSidebarOpen).mockReturnValue(true);
    runFrame();

    expect(focusSidebarRowForThread).not.toHaveBeenCalled();
  });
});

describe("cancelPendingActions", () => {
  it("stops the wait for the sidebar and every pending focus move", () => {
    publishBridge();
    vi.mocked(isSidebarOpen).mockReturnValue(false);
    runAction({ type: "pane.focus", direction: "left" });
    vi.mocked(cancelPendingFocus).mockClear();

    cancelPendingActions();
    vi.mocked(isSidebarOpen).mockReturnValue(true);
    runFrame();

    expect(frames.size).toBe(0);
    expect(focusSidebarRowForThread).not.toHaveBeenCalled();
    expect(cancelPendingSidebarFocus).toHaveBeenCalledTimes(1);
    expect(cancelPendingFocus).toHaveBeenCalledTimes(1);
  });

  it("stops the wait for a new pane that a New thread screen is meant for", () => {
    cancelPendingActions();

    expect(cancelPendingNewThread).toHaveBeenCalledTimes(1);
    expect(interruptPendingNewThread).not.toHaveBeenCalled();
  });

  it("drops the check that follows a resize bb did not take", () => {
    cancelPendingActions();

    expect(cancelPendingResizeCheck).toHaveBeenCalledTimes(1);
  });
});

describe("cancelPendingActionsOnPointerPress", () => {
  it("stops the wait for the sidebar and every pending focus move", () => {
    publishBridge();
    vi.mocked(isSidebarOpen).mockReturnValue(false);
    runAction({ type: "pane.focus", direction: "left" });
    vi.mocked(cancelPendingFocus).mockClear();

    cancelPendingActionsOnPointerPress();
    vi.mocked(isSidebarOpen).mockReturnValue(true);
    runFrame();

    expect(frames.size).toBe(0);
    expect(focusSidebarRowForThread).not.toHaveBeenCalled();
    expect(cancelPendingSidebarFocus).toHaveBeenCalledTimes(1);
    expect(cancelPendingFocus).toHaveBeenCalledTimes(1);
  });

  it("leaves it to the new thread code what a pointer press does to its wait", () => {
    cancelPendingActionsOnPointerPress();

    expect(interruptPendingNewThread).toHaveBeenCalledTimes(1);
    expect(cancelPendingNewThread).not.toHaveBeenCalled();
  });

  it("drops the check that follows a resize bb did not take", () => {
    cancelPendingActionsOnPointerPress();

    expect(cancelPendingResizeCheck).toHaveBeenCalledTimes(1);
  });
});

describe("config.reload", () => {
  it("reads the tmux config again and says so once that is done", async () => {
    const { reloadTmuxConfig } = publishBridge();

    runAction({ type: "config.reload" });

    expect(reloadTmuxConfig).toHaveBeenCalledTimes(1);
    expect(noticeText()).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(noticeText()).toBe("The tmux config was read again.");
  });

  it("says that the key help names what is missing when a config file or the pasted lines could not be read", async () => {
    publishBridge({ reloadTmuxConfig: () => Promise.resolve("incomplete") });

    runAction({ type: "config.reload" });
    await Promise.resolve();
    await Promise.resolve();

    expect(noticeText()).toBe(
      "The tmux config could not be read in full. The key help says what is missing.",
    );
  });

  it("says that the keys stay as they were when the server did not answer", async () => {
    publishBridge({ reloadTmuxConfig: () => Promise.resolve("failed") });

    runAction({ type: "config.reload" });
    await Promise.resolve();
    await Promise.resolve();

    expect(noticeText()).toBe(
      "The tmux config could not be read again. The keys stay as they were.",
    );
  });

  it("catches a reload that fails: it logs the error and shows a notice", async () => {
    const failure = new Error("no server");
    publishBridge({ reloadTmuxConfig: () => Promise.reject(failure) });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    runAction({ type: "config.reload" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleError.mock.calls[0]).toContain(failure);
    expect(noticeText()).toBe("That key did not work. See the console for details.");
  });

  it("tells the user while the bridge is missing", () => {
    runAction({ type: "config.reload" });

    expect(noticeText()).toBe(LOADING_NOTICE);
  });
});

describe("notice.show", () => {
  it("shows the text of tmux's display-message as a notice", () => {
    expect(runAction({ type: "notice.show", text: "Config reloaded" })).toBe(true);

    expect(noticeText()).toBe("Config reloaded");
  });

  it("shows the same text again as a new notice", () => {
    runAction({ type: "notice.show", text: "hello" });
    const first = getUiState().notice;
    runAction({ type: "notice.show", text: "hello" });

    expect(getUiState().notice).not.toBe(first);
    expect(noticeText()).toBe("hello");
  });
});

describe("prefix.send", () => {
  it("does nothing itself, because the key handler lets the key press through", () => {
    publishBridge();

    expect(runAction({ type: "prefix.send", second: false })).toBe(true);
    expect(runAction({ type: "prefix.send", second: true })).toBe(true);

    expect(noticeText()).toBeNull();
    expect(focusPane).not.toHaveBeenCalled();
    expect(settleDomFocus).not.toHaveBeenCalled();
  });
});

describe("runAction", () => {
  it("never throws: it logs the error and shows a notice", () => {
    const failure = new Error("bb markup changed");
    vi.mocked(focusSidebarEdge).mockImplementation(() => {
      throw failure;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runAction({ type: "sidebar.edge", edge: "top" })).not.toThrow();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]).toContain(failure);
    expect(noticeText()).toBe("That key did not work. See the console for details.");
  });
});
