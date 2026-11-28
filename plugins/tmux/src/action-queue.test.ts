// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelQueuedActions, runActionsInOrder } from "./action-queue";
import { resetStore, setBridge } from "./bridge";
import { getFocusedPaneElement, isPaneZoomed } from "./dom-actions";
import { hasFocusWaitGivenUp, isFocusPending } from "./pane-focus";
import type { Action, ActionType, Bridge, SplitPane } from "./types";

vi.mock("./dom-actions", () => ({
  getFocusedPaneElement: vi.fn(),
  isPaneZoomed: vi.fn(),
}));
vi.mock("./pane-focus", () => ({
  hasFocusWaitGivenUp: vi.fn(),
  isFocusPending: vi.fn(),
}));

const FOCUS_RIGHT: Action = { type: "pane.focus", direction: "right" };
const CLOSE: Action = { type: "pane.close" };
const ZOOM: Action = { type: "pane.zoom" };
const NOTICE: Action = { type: "notice.show", text: "done" };
const NEXT_THREAD: Action = { type: "thread.cycle", delta: 1 };
const LAST_PANE: Action = { type: "pane.last" };
const PANE_ON_LEFT: Action = { type: "pane.neighbour", direction: "left" };
const LAST_THREAD: Action = { type: "thread.last" };
const JUMP: Action = { type: "thread.jump", index: 9 };
const END_THREAD: Action = { type: "thread.end" };

// The actions that bb follows a moment later, which README.md promises a
// wait after: a pane move, a pane close and a thread change.
const FOLLOWED_BY_BB: Action[] = [
  FOCUS_RIGHT,
  PANE_ON_LEFT,
  { type: "pane.next" },
  { type: "pane.previous" },
  LAST_PANE,
  CLOSE,
  JUMP,
  END_THREAD,
  NEXT_THREAD,
  LAST_THREAD,
];

const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
let ran: Action[];
let failures: number;
let findingNothing: Set<ActionType>;

function runFrame(): void {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}

function pane(paneId: string, isFocused: boolean): SplitPane {
  return { paneId, threadId: `thr-${paneId}`, isFocused, rect: { x: 0, y: 0, width: 1, height: 1 } };
}

// What bb has told the plugin: the pane that its layout names as focused.
function bbLayoutFocuses(paneId: string | null): void {
  const layout =
    paneId === null
      ? null
      : { panes: [pane("p1", paneId === "p1"), pane("p2", paneId === "p2")] };
  setBridge({ layout, context: { projectId: null, threadId: null } } as unknown as Bridge);
}

// What bb has drawn: the pane that the page marks as focused.
function bbPageFocuses(paneId: string): void {
  const element = document.createElement("div");
  element.setAttribute("data-split-pane-id", paneId);
  vi.mocked(getFocusedPaneElement).mockReturnValue(element);
}

function run(...actions: Action[]): void {
  runActionsInOrder(
    actions,
    (action) => {
      ran.push(action);
      return !findingNothing.has(action.type);
    },
    () => {
      failures += 1;
    },
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  frames.clear();
  ran = [];
  failures = 0;
  findingNothing = new Set(["pane.zoom"]);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.mocked(isFocusPending).mockReturnValue(false);
  vi.mocked(hasFocusWaitGivenUp).mockReturnValue(false);
  vi.mocked(isPaneZoomed).mockReturnValue(false);
  bbLayoutFocuses("p1");
  bbPageFocuses("p1");
});

afterEach(() => {
  cancelQueuedActions();
  resetStore();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runActionsInOrder", () => {
  it("runs every action at once while nothing waits for bb", () => {
    run(NOTICE, CLOSE, FOCUS_RIGHT, NOTICE);

    expect(ran).toEqual([NOTICE, CLOSE, FOCUS_RIGHT, NOTICE]);
    expect(frames.size).toBe(0);
  });

  it("says so for each action that found nothing to act on, and goes on", () => {
    run(ZOOM, NOTICE, ZOOM);

    expect(ran).toEqual([ZOOM, NOTICE, ZOOM]);
    expect(failures).toBe(2);
  });

  it("holds the action after a pane move back until bb shows the pane it was asked for", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);

    run(FOCUS_RIGHT, CLOSE, NOTICE);
    expect(ran).toEqual([FOCUS_RIGHT]);

    runFrame();
    runFrame();
    expect(ran).toEqual([FOCUS_RIGHT]);

    vi.mocked(isFocusPending).mockReturnValue(false);
    bbLayoutFocuses("p2");
    bbPageFocuses("p2");
    runFrame();

    expect(ran).toEqual([FOCUS_RIGHT, CLOSE, NOTICE]);
    expect(frames.size).toBe(0);
  });

  it("goes on waiting while the layout that plugins get still names the pane from before", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);
    run(FOCUS_RIGHT, CLOSE);
    vi.mocked(isFocusPending).mockReturnValue(false);
    bbPageFocuses("p2");

    runFrame();
    expect(ran).toEqual([FOCUS_RIGHT]);

    bbLayoutFocuses("p2");
    runFrame();
    expect(ran).toEqual([FOCUS_RIGHT, CLOSE]);
  });

  it.each(FOLLOWED_BY_BB)(
    "holds the action after $type back until bb has followed",
    (first) => {
      vi.mocked(isFocusPending).mockReturnValue(true);

      run(first, NOTICE);
      expect(ran).toEqual([first]);

      vi.mocked(isFocusPending).mockReturnValue(false);
      runFrame();
      expect(ran).toEqual([first, NOTICE]);
    },
  );

  it("goes on at once in a window that is not split any more, where the layout names no pane", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);
    run(CLOSE, NOTICE);
    expect(ran).toEqual([CLOSE]);
    vi.mocked(isFocusPending).mockReturnValue(false);
    bbLayoutFocuses(null);

    runFrame();

    expect(ran).toEqual([CLOSE, NOTICE]);
  });

  it("waits again after the next action that bb has to follow", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);
    run(FOCUS_RIGHT, NEXT_THREAD, CLOSE);
    bbLayoutFocuses("p2");
    bbPageFocuses("p2");
    vi.mocked(isFocusPending).mockReturnValueOnce(false);

    runFrame();
    expect(ran).toEqual([FOCUS_RIGHT, NEXT_THREAD]);

    vi.mocked(isFocusPending).mockReturnValue(false);
    runFrame();
    expect(ran).toEqual([FOCUS_RIGHT, NEXT_THREAD, CLOSE]);
  });

  it("does not wait after the last action, nor after one that changes no pane", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);

    run(NOTICE, ZOOM, FOCUS_RIGHT);

    expect(ran).toEqual([NOTICE, ZOOM, FOCUS_RIGHT]);
    expect(frames.size).toBe(0);
  });

  it("drops the rest when the wait for bb gave up, because the pane it would act on is not known", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);
    run(FOCUS_RIGHT, CLOSE);
    vi.mocked(isFocusPending).mockReturnValue(false);
    vi.mocked(hasFocusWaitGivenUp).mockReturnValue(true);

    runFrame();

    expect(ran).toEqual([FOCUS_RIGHT]);
    expect(frames.size).toBe(0);
  });

  it("drops the rest when bb has not caught up after a second", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);
    run(FOCUS_RIGHT, CLOSE);

    vi.advanceTimersByTime(999);
    runFrame();
    expect(frames.size).toBe(1);

    vi.advanceTimersByTime(1);
    vi.mocked(isFocusPending).mockReturnValue(false);
    runFrame();

    expect(ran).toEqual([FOCUS_RIGHT]);
    expect(frames.size).toBe(0);
  });

  it("drops the rest when it is cancelled", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);
    run(FOCUS_RIGHT, CLOSE);

    cancelQueuedActions();
    vi.mocked(isFocusPending).mockReturnValue(false);
    runFrame();

    expect(ran).toEqual([FOCUS_RIGHT]);
    expect(frames.size).toBe(0);
  });

  it("drops what the key before still waited to do when the next key runs its actions", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);
    run(FOCUS_RIGHT, CLOSE);
    vi.mocked(isFocusPending).mockReturnValue(false);

    run(NOTICE);
    runFrame();

    expect(ran).toEqual([FOCUS_RIGHT, NOTICE]);
  });
});

describe("a move that found nothing to go to, which is an error in tmux", () => {
  it.each([PANE_ON_LEFT, LAST_PANE, LAST_THREAD, JUMP, END_THREAD, NEXT_THREAD])(
    "ends the sequence at $type, as an error does in tmux",
    (move) => {
      findingNothing = new Set([move.type]);

      run(NOTICE, move, CLOSE, NOTICE);

      expect(ran).toEqual([NOTICE, move]);
      expect(failures).toBe(0);
      expect(frames.size).toBe(0);
    },
  );

  it.each([PANE_ON_LEFT, LAST_PANE, LAST_THREAD, JUMP, END_THREAD, NEXT_THREAD])(
    "goes on behind $type when it found where to go",
    (move) => {
      run(move, NOTICE);

      expect(ran).toEqual([move, NOTICE]);
    },
  );

  it("still goes on behind a move by direction that found no pane, which is no error in tmux", () => {
    findingNothing = new Set(["pane.focus"]);

    run(FOCUS_RIGHT, CLOSE);

    expect(ran).toEqual([FOCUS_RIGHT, CLOSE]);
  });

  it("still goes on behind a resize that found no divider, which is no error in tmux", () => {
    const resize: Action = { type: "pane.resize", direction: "left", cells: 5 };
    findingNothing = new Set(["pane.resize"]);

    run(resize, NOTICE);

    expect(ran).toEqual([resize, NOTICE]);
    expect(failures).toBe(1);
  });
});

describe("a zoom behind a pane move, on a page whose zoom follows the focus as bb's does", () => {
  beforeEach(() => {
    findingNothing = new Set();
  });

  // What bb does a moment after the move: it marks the pane, tells plugins,
  // and keeps the zoom on the focused pane when one was zoomed.
  function bbFollowsTo(paneId: string, isZoomed: boolean): void {
    vi.mocked(isFocusPending).mockReturnValue(false);
    bbLayoutFocuses(paneId);
    bbPageFocuses(paneId);
    vi.mocked(isPaneZoomed).mockReturnValue(isZoomed);
    runFrame();
  }

  it("leaves the zoom that followed the focus to the new pane, where a toggle would remove it", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);
    run(FOCUS_RIGHT, ZOOM, NOTICE);

    bbFollowsTo("p2", true);

    expect(ran).toEqual([FOCUS_RIGHT, NOTICE]);
    expect(failures).toBe(0);
  });

  it.each([
    PANE_ON_LEFT,
    { type: "pane.next" },
    { type: "pane.previous" },
    LAST_PANE,
  ] as Action[])(
    "does the same behind $type",
    (move) => {
      vi.mocked(isFocusPending).mockReturnValue(true);
      run(move, ZOOM);

      bbFollowsTo("p2", true);

      expect(ran).toEqual([move]);
    },
  );

  it("zooms the pane that the move went to when no pane was zoomed", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);
    run(FOCUS_RIGHT, ZOOM);

    bbFollowsTo("p2", false);

    expect(ran).toEqual([FOCUS_RIGHT, ZOOM]);
  });

  it("toggles the zoom behind a move that stayed on its pane, as tmux does", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);
    run(FOCUS_RIGHT, ZOOM);

    bbFollowsTo("p1", true);

    expect(ran).toEqual([FOCUS_RIGHT, ZOOM]);
  });

  it("toggles the zoom behind a move that started no wait, such as one into the sidebar", () => {
    vi.mocked(isPaneZoomed).mockReturnValue(true);

    run(FOCUS_RIGHT, ZOOM);

    expect(ran).toEqual([FOCUS_RIGHT, ZOOM]);
  });

  it("toggles a zoom on its own, and one behind a thread change", () => {
    vi.mocked(isPaneZoomed).mockReturnValue(true);
    run(ZOOM);
    expect(ran).toEqual([ZOOM]);

    vi.mocked(isFocusPending).mockReturnValue(true);
    run(NEXT_THREAD, ZOOM);
    bbFollowsTo("p2", true);
    expect(ran).toEqual([ZOOM, NEXT_THREAD, ZOOM]);
  });

  it("keeps in mind that the focus has moved over the actions in between, and forgets it at the zoom", () => {
    vi.mocked(isFocusPending).mockReturnValue(true);
    run(FOCUS_RIGHT, NOTICE, ZOOM, ZOOM);

    bbFollowsTo("p2", true);

    expect(ran).toEqual([FOCUS_RIGHT, NOTICE, ZOOM]);
  });
});
