// @vitest-environment jsdom
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelPendingActions } from "./actions";
import { runCoreCommand } from "./bb-commands";
import { getBridge, getUiState, resetStore, setBridge } from "./bridge";
import { ATTRIBUTES, BB_COMMANDS, MAX_PANES } from "./constants";
import {
  clickMaximizePane,
  focusPaneElement,
  isCompactViewport,
  isPaneZoomed,
} from "./dom-actions";
import { getLastShownThreadId } from "./history";
import {
  cancelPendingNewThread,
  hasNewThreadScreenInAnotherPane,
  interruptPendingNewThread,
  openNewThreadInSplit,
} from "./new-thread";
import { BRIDGE_MISSING_NOTICE, PANE_LIMIT_NOTICE } from "./open-thread";
import { makeThread } from "./overlay/test-support";
import { cancelPendingFocus, settleDomFocusWhen } from "./pane-focus";
import { DEFAULT_SETTINGS } from "./settings";
import type { Bridge, SplitPane } from "./types";

// The chat that a plugin page embeds, as bb marks it.
const PLUGIN_CHAT =
  '<p>plugin page</p><div data-app-composer data-app-composer-role="secondary"><div contenteditable="true" tabindex="0"></div></div>';

vi.mock("./bb-commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bb-commands")>()),
  runCoreCommand: vi.fn(),
}));
vi.mock("./dom-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dom-actions")>()),
  clickMaximizePane: vi.fn(),
  focusPaneElement: vi.fn(),
  isCompactViewport: vi.fn(),
  isPaneZoomed: vi.fn(),
}));

const THREAD_ROUTE = "/projects/proj-1/threads/thr_a";
const NEW_THREAD_ROUTE = "/";
const COMPOSER = '<div data-app-composer><div contenteditable="true" tabindex="0"></div></div>';
const NEW_THREAD_COMPOSER = { scope: { kind: "new-thread", projectId: null } };

const SINGLE_PANE_ID = "p1";

const ONE_SCREEN_NOTICE =
  "bb shows the New thread screen in one pane only, so you were moved to it.";
const NO_PANES_NOTICE = "This page shows no panes, so no new pane was opened.";
const NEW_PANE_FAILED_NOTICE = "Could not open the new pane.";
const NEW_PANE_BELOW_FAILED_NOTICE = "Could not open the new pane below.";
const THREAD_PUT_BACK_NOTICE = "The thread is back in its pane.";
const THREAD_CLOSED_NOTICE =
  "The thread that was in the pane is closed. Open it again from the sidebar.";

const frames = new Map<number, FrameRequestCallback>();
const cancelledFrames = new Set<number>();
let nextFrameId = 1;
let calls: string[];
let navigate: { toThread: ReturnType<typeof vi.fn>; toCompose: ReturnType<typeof vi.fn> };
let threadsOpen: ReturnType<typeof vi.fn>;

// As in a browser, a callback that an earlier callback of the same frame
// cancelled does not run.
function runFrame(): void {
  const due = [...frames];
  frames.clear();
  for (const [id, callback] of due) {
    if (!cancelledFrames.has(id)) callback(0);
  }
  cancelledFrames.clear();
}

function pane(paneId: string, threadId: string | null, isFocused = false): SplitPane {
  return { paneId, threadId, isFocused, rect: { x: 0, y: 0, width: 1, height: 1 } };
}

function threads(...ids: string[]): PluginSidebarThread[] {
  return ids.map((id) => makeThread(id));
}

interface BbState {
  panes?: SplitPane[] | null;
  contextThreadId?: string | null;
  threads?: PluginSidebarThread[];
  composers?: object[];
}

function paneElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${ATTRIBUTES.paneId}]`));
}

function paneIdOf(element: HTMLElement): string {
  return element.getAttribute(ATTRIBUTES.paneId) ?? "";
}

// As in bb, where a single pane carries a pane id too.
function showPaneElementsFor(panes: SplitPane[] | null): void {
  const paneIds = panes?.map(({ paneId }) => paneId) ?? [SINGLE_PANE_ID];
  for (const element of paneElements()) {
    if (!paneIds.includes(paneIdOf(element))) element.remove();
  }
  const shown = paneElements().map(paneIdOf);
  for (const paneId of paneIds) {
    if (!shown.includes(paneId)) mountPane(paneId);
  }
}

// Stands in for the overlay and the page: bb's current layout, threads and
// message boxes, and one pane element for every pane.
function bbShows(state: BbState = {}): void {
  const panes = state.panes ?? null;
  showPaneElementsFor(panes);
  setBridge({
    navigate,
    sdk: { threads: { open: threadsOpen } },
    layout: panes === null ? null : { panes },
    context: { projectId: null, threadId: state.contextThreadId ?? null },
    threads: state.threads ?? [],
    threadsReady: true,
    projects: [],
    composers: state.composers ?? [],
    settings: DEFAULT_SETTINGS,
  } as unknown as Bridge);
}

function twoPanes(): SplitPane[] {
  return [pane("p1", "thr_a", true), pane("p2", "thr_b")];
}

function withNewPane(threadId: string | null, base = twoPanes()): SplitPane[] {
  return [
    ...base.map((layoutPane) => ({ ...layoutPane, isFocused: false })),
    pane("p-new", threadId, true),
  ];
}

function mountPane(paneId: string, innerHtml = ""): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute(ATTRIBUTES.paneId, paneId);
  element.innerHTML = innerHtml;
  document.body.append(element);
  return element;
}

// What bb does for Settings and the Plugins page: the layout stays as it is,
// but no pane is in the page.
function bbShowsAPageWithoutPanes(state: BbState): void {
  bbShows(state);
  for (const element of paneElements()) element.remove();
}

function showNewThreadScreenIn(paneId: string): HTMLElement {
  const element = paneElements().find((pane) => paneIdOf(pane) === paneId);
  if (element === undefined) throw new Error(`pane ${paneId} is not in the page`);
  element.innerHTML = COMPOSER;
  return editorOf(element);
}

function bbRejectsThreadsOpen(): void {
  threadsOpen.mockImplementation((args: { threadId: string; split: string }) => {
    calls.push(`threads.open ${args.threadId} ${args.split}`);
    return Promise.reject(new Error("offline"));
  });
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function editorOf(paneElement: HTMLElement): HTMLElement {
  const editor = paneElement.querySelector<HTMLElement>("[contenteditable]");
  if (editor === null) throw new Error("the fixture has no editor");
  return editor;
}

function noticeText(): string | null {
  return getUiState().notice?.text ?? null;
}

function expectNothingPending(): void {
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  window.history.replaceState(null, "", THREAD_ROUTE);
  frames.clear();
  cancelledFrames.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
    cancelledFrames.add(id);
  });
  calls = [];
  navigate = {
    toThread: vi.fn((threadId: string, options?: { split?: boolean }) => {
      calls.push(`toThread ${threadId}${options?.split ? " split" : ""}`);
    }),
    toCompose: vi.fn((options?: { focusPrompt?: boolean }) => {
      calls.push(options?.focusPrompt ? "toCompose focusPrompt" : "toCompose");
    }),
  };
  threadsOpen = vi.fn((args: { threadId: string; split: string }) => {
    calls.push(`threads.open ${args.threadId} ${args.split}`);
    return Promise.resolve({ delivered: 1 });
  });
  vi.mocked(runCoreCommand).mockImplementation((command) => {
    calls.push(`command ${command}`);
    return "ran";
  });
  vi.mocked(clickMaximizePane).mockImplementation(() => {
    calls.push("click maximize");
    return true;
  });
  vi.mocked(isCompactViewport).mockReturnValue(false);
  vi.mocked(isPaneZoomed).mockReturnValue(false);
});

afterEach(() => {
  cancelPendingNewThread();
  cancelPendingFocus();
  resetStore();
  document.body.replaceChildren();
  window.history.replaceState(null, "", NEW_THREAD_ROUTE);
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("openNewThreadInSplit", () => {
  it("reports unavailable and tells the user while the bridge is missing", () => {
    expect(openNewThreadInSplit("right")).toBe("unavailable");

    expect(noticeText()).toBe(BRIDGE_MISSING_NOTICE);
    expectNothingPending();
  });

  describe("when a pane already shows the New thread screen", () => {
    it.each(["right", "down"] as const)(
      "moves to that pane instead of splitting %s and says why",
      (placement) => {
        mountPane("p1");
        mountPane("p2", COMPOSER);
        bbShows({
          panes: [pane("p1", "thr_a", true), pane("p2", null)],
          threads: threads("thr_a", "thr_c"),
        });
        vi.mocked(isPaneZoomed).mockReturnValue(true);

        expect(openNewThreadInSplit(placement)).toBe("focused-existing");

        expect(navigate.toCompose).toHaveBeenCalledWith({ focusPrompt: true });
        expect(calls).toEqual(["toCompose focusPrompt"]);
        expect(noticeText()).toBe(ONE_SCREEN_NOTICE);
        expectNothingPending();
      },
    );

    it("does the same when the only pane is the New thread screen", () => {
      window.history.replaceState(null, "", NEW_THREAD_ROUTE);
      document.body.innerHTML = `<main><div ${ATTRIBUTES.paneId}="${SINGLE_PANE_ID}">${COMPOSER}</div></main>`;
      bbShows({ threads: threads("thr_a", "thr_c") });

      expect(openNewThreadInSplit("right")).toBe("focused-existing");

      expect(calls).toEqual(["toCompose focusPrompt"]);
      expect(noticeText()).toBe(ONE_SCREEN_NOTICE);
      expectNothingPending();
    });

    it("ends a pending settle, so the cursor can stay in the message box", () => {
      const editor = editorOf(mountPane("p2", COMPOSER));
      bbShows({ panes: [pane("p1", "thr_a"), pane("p2", null, true)] });
      settleDomFocusWhen(() => true);
      runFrame();
      vi.mocked(focusPaneElement).mockClear();

      openNewThreadInSplit("right");
      expectNothingPending();
      editor.focus();

      expect(document.activeElement).toBe(editor);
      expect(focusPaneElement).not.toHaveBeenCalled();
    });

    it("does not take a pane that shows a plugin page for the New thread screen", () => {
      mountPane("p1");
      mountPane("p2", "<p>plugin page</p>");
      bbShows({
        panes: [pane("p1", "thr_a", true), pane("p2", null)],
        threads: threads("thr_a", "thr_c"),
      });

      expect(openNewThreadInSplit("right")).toBe("started");
      expect(calls).toEqual(["toThread thr_c split"]);
    });

    it("does not take a pane whose plugin page embeds a chat for the New thread screen", () => {
      mountPane("p1");
      mountPane("p2", PLUGIN_CHAT);
      bbShows({
        panes: [pane("p1", "thr_a", true), pane("p2", null)],
        threads: threads("thr_a", "thr_c"),
      });

      expect(openNewThreadInSplit("right")).toBe("started");
      expect(calls).toEqual(["toThread thr_c split"]);
      expect(noticeText()).toBeNull();
    });

    it("does not take a single thread pane with a message box for the New thread screen", () => {
      document.body.innerHTML = `<main><div ${ATTRIBUTES.paneId}="${SINGLE_PANE_ID}"><div data-thread-window>${COMPOSER}</div></div></main>`;
      bbShows({ contextThreadId: "thr_a", threads: threads("thr_a", "thr_c") });

      expect(openNewThreadInSplit("right")).toBe("started");
      expect(calls).toEqual(["toThread thr_c split"]);
    });
  });

  describe("on a page that shows no panes, such as Settings", () => {
    it("opens nothing when bb's hidden single pane shows the thread that would be the placeholder", () => {
      bbShowsAPageWithoutPanes({ threads: threads("thr_a", "thr_c") });

      expect(openNewThreadInSplit("right")).toBe("unavailable");

      expect(noticeText()).toBe(NO_PANES_NOTICE);
      expect(calls).toEqual([]);
      expectNothingPending();
    });

    it.each(["right", "down"] as const)(
      "opens nothing %s when bb's hidden panes hold a New thread screen that the page cannot show",
      (placement) => {
        bbShowsAPageWithoutPanes({
          panes: [pane("p1", "thr_a", true), pane("p2", null)],
          threads: threads("thr_a", "thr_c"),
        });

        expect(openNewThreadInSplit(placement)).toBe("unavailable");

        expect(noticeText()).toBe(NO_PANES_NOTICE);
        expect(calls).toEqual([]);
        expectNothingPending();
      },
    );
  });

  it.each(["right", "down"] as const)(
    "refuses a %s split at the pane limit with openThread's notice and changes nothing",
    (placement) => {
      const panes = Array.from({ length: MAX_PANES }, (_, index) =>
        pane(`p${index}`, `thr_${index}`, index === 0),
      );
      bbShows({ panes, threads: threads("thr_0", "thr_x") });
      vi.mocked(isPaneZoomed).mockReturnValue(true);

      expect(openNewThreadInSplit(placement)).toBe("pane-limit");

      expect(noticeText()).toBe(PANE_LIMIT_NOTICE);
      expect(noticeText()).toContain(`at most ${MAX_PANES} panes`);
      expect(calls).toEqual([]);
      expectNothingPending();
    },
  );

  it("opens no pane in a narrow window, where bb would replace the thread on screen", () => {
    bbShows({ contextThreadId: "thr_a", threads: threads("thr_a", "thr_c") });
    vi.mocked(isCompactViewport).mockReturnValue(true);

    expect(openNewThreadInSplit("right")).toBe("unavailable");

    expect(noticeText()).toBe(
      "This window is too narrow for panes, so no new pane was opened.",
    );
    expect(calls).toEqual([]);
    expectNothingPending();
  });

  describe("with a thread that is not in any pane", () => {
    const THREADS = threads("thr_a", "thr_b", "thr_c");

    it("opens it in a new pane to the right, then turns that pane into the New thread screen", () => {
      bbShows({ panes: twoPanes(), threads: THREADS });

      expect(openNewThreadInSplit("right")).toBe("started");

      expect(navigate.toThread).toHaveBeenCalledWith("thr_c", { split: true });
      expect(calls).toEqual(["toThread thr_c split"]);
      expect(noticeText()).toBeNull();

      runFrame();
      runFrame();
      expect(calls).toHaveLength(1);

      bbShows({ panes: withNewPane("thr_c"), threads: THREADS });
      runFrame();

      expect(navigate.toCompose).toHaveBeenCalledWith({ focusPrompt: true });
      expect(calls).toEqual(["toThread thr_c split", "toCompose focusPrompt"]);
      expect(noticeText()).toBeNull();
      expectNothingPending();
    });

    it("does not count the thread that only filled the new pane as a thread that the pane showed", () => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      openNewThreadInSplit("right");
      bbShows({ panes: withNewPane("thr_c"), threads: THREADS });
      expect(getLastShownThreadId("p-new")).toBeNull();
      runFrame();

      bbShows({ panes: withNewPane("thr_c"), threads: THREADS });
      bbShows({ panes: withNewPane(null), threads: THREADS });
      expect(getLastShownThreadId("p-new")).toBeNull();

      bbShows({ panes: withNewPane("thr_new"), threads: THREADS });
      expect(getLastShownThreadId("p-new")).toBeNull();
      expect(getLastShownThreadId("p1")).toBeNull();
    });

    it("opens it in a new pane below through the server, then turns that pane into the New thread screen", () => {
      bbShows({ panes: twoPanes(), threads: THREADS });

      expect(openNewThreadInSplit("down")).toBe("started");

      expect(threadsOpen).toHaveBeenCalledWith({
        threadId: "thr_c",
        split: "down",
        file: null,
      });
      expect(calls).toEqual(["threads.open thr_c down"]);

      runFrame();
      expect(calls).toHaveLength(1);

      bbShows({ panes: withNewPane("thr_c"), threads: THREADS });
      runFrame();

      expect(calls).toEqual(["threads.open thr_c down", "toCompose focusPrompt"]);
      expectNothingPending();
    });

    it("splits a single pane", () => {
      bbShows({ contextThreadId: "thr_a", threads: THREADS });

      openNewThreadInSplit("right");
      expect(calls).toEqual(["toThread thr_b split"]);

      bbShows({
        panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)],
        contextThreadId: "thr_b",
        threads: THREADS,
      });
      runFrame();

      expect(calls).toEqual(["toThread thr_b split", "toCompose focusPrompt"]);
    });

    it("keeps waiting while the new pane is not there or does not have the focus", () => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      openNewThreadInSplit("right");

      bbShows({ panes: [pane("p1", "thr_c", true), pane("p2", "thr_b")], threads: THREADS });
      runFrame();
      bbShows({
        panes: [pane("p1", "thr_a", true), pane("p2", "thr_b"), pane("p3", "thr_c")],
        threads: THREADS,
      });
      runFrame();
      bbShows({ panes: withNewPane(null), threads: THREADS });
      runFrame();

      expect(calls).toEqual(["toThread thr_c split"]);
      expect(frames.size).toBe(1);
    });

    it.each([
      ["right", 1500],
      ["down", 3000],
    ] as const)(
      "gives up on a %s split after %d ms, says so and stops waiting",
      (placement, limitMs) => {
        bbShows({ panes: twoPanes(), threads: THREADS });
        openNewThreadInSplit(placement);

        runFrame();
        vi.advanceTimersByTime(limitMs - 1);
        expect(noticeText()).toBeNull();

        vi.advanceTimersByTime(1);
        expect(noticeText()).toBe(NEW_PANE_FAILED_NOTICE);
        expectNothingPending();

        bbShows({ panes: withNewPane("thr_c"), threads: THREADS });
        runFrame();
        expect(navigate.toCompose).not.toHaveBeenCalled();
      },
    );

    describe("the cursor that the closed chooser left on nothing", () => {
      function showsWithMessageBox(): ReturnType<typeof vi.fn> {
        const focus = vi.fn();
        bbShows({
          panes: twoPanes(),
          threads: THREADS,
          composers: [{ scope: { kind: "thread", threadId: "thr_a" }, focus }],
        });
        return focus;
      }

      it.each([
        ["right", 1500],
        ["down", 3000],
      ] as const)(
        "goes into the message box of the focused pane when the new pane %s does not show in time",
        (placement, limitMs) => {
          const focus = showsWithMessageBox();
          openNewThreadInSplit(placement);
          expect(document.activeElement).toBe(document.body);

          vi.advanceTimersByTime(limitMs - 1);
          expect(focus).not.toHaveBeenCalled();
          vi.advanceTimersByTime(1);

          expect(noticeText()).toBe(NEW_PANE_FAILED_NOTICE);
          expect(focusPaneElement).toHaveBeenCalledTimes(1);
          expect(focus).toHaveBeenCalledTimes(1);
          expectNothingPending();
        },
      );

      it("goes into the message box of the focused pane when sdk.threads.open rejects", async () => {
        const focus = showsWithMessageBox();
        bbRejectsThreadsOpen();
        vi.spyOn(console, "error").mockImplementation(() => {});
        openNewThreadInSplit("down");

        await settlePromises();

        expect(noticeText()).toBe(NEW_PANE_BELOW_FAILED_NOTICE);
        expect(focus).toHaveBeenCalledTimes(1);
        expectNothingPending();
      });

      it("stays in a text field that the user has gone to since", () => {
        const focus = showsWithMessageBox();
        const field = document.createElement("textarea");
        document.body.append(field);
        openNewThreadInSplit("right");
        field.focus();

        vi.advanceTimersByTime(1500);

        expect(noticeText()).toBe(NEW_PANE_FAILED_NOTICE);
        expect(focus).not.toHaveBeenCalled();
        expect(focusPaneElement).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(field);
      });

      it("stays where a mouse press put it when sdk.threads.open rejects after that press", async () => {
        const focus = showsWithMessageBox();
        bbRejectsThreadsOpen();
        vi.spyOn(console, "error").mockImplementation(() => {});
        openNewThreadInSplit("down");

        interruptPendingNewThread();
        await settlePromises();

        expect(noticeText()).toBe(NEW_PANE_BELOW_FAILED_NOTICE);
        expect(focus).not.toHaveBeenCalled();
        expect(focusPaneElement).not.toHaveBeenCalled();
      });
    });

    it("does not throw when the bridge disappears while it waits", () => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      openNewThreadInSplit("right");
      setBridge(null);

      expect(() => runFrame()).not.toThrow();
      expect(calls).toEqual(["toThread thr_c split"]);
    });

    it("shows one notice when sdk.threads.open rejects and stops waiting", async () => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      bbRejectsThreadsOpen();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(openNewThreadInSplit("down")).toBe("started");
      expect(noticeText()).toBeNull();

      await settlePromises();

      expect(noticeText()).toBe(NEW_PANE_BELOW_FAILED_NOTICE);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expectNothingPending();
      const noticeId = getUiState().notice?.id;

      bbShows({ panes: withNewPane("thr_c"), threads: THREADS });
      runFrame();
      vi.advanceTimersByTime(3000);

      expect(getUiState().notice?.id).toBe(noticeId);
      expect(noticeText()).toBe(NEW_PANE_BELOW_FAILED_NOTICE);
      expect(calls).toEqual(["threads.open thr_c down"]);
    });

    it("says nothing more when sdk.threads.open rejects after the wait gave up", async () => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      let rejectOpen: (error: Error) => void = () => {};
      threadsOpen.mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectOpen = reject;
        }),
      );
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      openNewThreadInSplit("down");
      vi.advanceTimersByTime(3000);
      expect(noticeText()).toBe(NEW_PANE_FAILED_NOTICE);
      const noticeId = getUiState().notice?.id;

      rejectOpen(new Error("offline"));
      await settlePromises();

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(getUiState().notice?.id).toBe(noticeId);
    });

    it("still says that the pane below failed when the wait was ended by a pointer press", async () => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      bbRejectsThreadsOpen();
      vi.spyOn(console, "error").mockImplementation(() => {});
      openNewThreadInSplit("down");

      interruptPendingNewThread();
      await settlePromises();

      expect(noticeText()).toBe(NEW_PANE_BELOW_FAILED_NOTICE);
      expectNothingPending();
    });

    it("moves to a New thread screen that showed up in another pane meanwhile and says that the new pane kept its thread", () => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      openNewThreadInSplit("right");

      showNewThreadScreenIn("p1");
      bbShows({
        panes: [pane("p1", null), pane("p2", "thr_b"), pane("p-new", "thr_c", true)],
        threads: THREADS,
      });
      runFrame();

      expect(calls).toEqual(["toThread thr_c split", "toCompose focusPrompt"]);
      expect(noticeText()).toBe(
        `${ONE_SCREEN_NOTICE} The new pane kept the thread it opened with.`,
      );
      expectNothingPending();
    });
  });

  describe("choosing the thread that fills the new pane for a moment", () => {
    function placeholderFor(state: BbState): string {
      bbShows(state);
      openNewThreadInSplit("right");
      return calls[0];
    }

    it("takes the most recent thread that no pane shows", () => {
      const placeholder = placeholderFor({
        panes: twoPanes(),
        threads: [
          makeThread("thr_a", { latestAttentionAt: 900 }),
          makeThread("thr_b", { latestAttentionAt: 800 }),
          makeThread("thr_old", { latestAttentionAt: 100 }),
          makeThread("thr_recent", { latestAttentionAt: 500 }),
        ],
      });

      expect(placeholder).toBe("toThread thr_recent split");
    });

    it("prefers a read thread over a more recent unread one, so nothing is marked as read", () => {
      const placeholder = placeholderFor({
        panes: twoPanes(),
        threads: [
          makeThread("thr_a"),
          makeThread("thr_b"),
          makeThread("thr_unread", { latestAttentionAt: 500, isUnread: true }),
          makeThread("thr_read", { latestAttentionAt: 100 }),
        ],
      });

      expect(placeholder).toBe("toThread thr_read split");
    });

    it("prefers a read thread that is not running over a running one, whose next activity bb would mark as read", () => {
      const placeholder = placeholderFor({
        panes: twoPanes(),
        threads: [
          makeThread("thr_a"),
          makeThread("thr_b"),
          makeThread("thr_running", { latestAttentionAt: 900, status: "active" }),
          makeThread("thr_starting", { latestAttentionAt: 800, status: "starting" }),
          makeThread("thr_idle", { latestAttentionAt: 100 }),
        ],
      });

      expect(placeholder).toBe("toThread thr_idle split");
    });

    it("takes a running read thread before an unread one", () => {
      const placeholder = placeholderFor({
        panes: twoPanes(),
        threads: [
          makeThread("thr_a"),
          makeThread("thr_b"),
          makeThread("thr_unread", { latestAttentionAt: 900, isUnread: true }),
          makeThread("thr_running_unread", {
            latestAttentionAt: 800,
            status: "active",
            isUnread: true,
          }),
          makeThread("thr_running", { latestAttentionAt: 100, status: "active" }),
        ],
      });

      expect(placeholder).toBe("toThread thr_running split");
    });

    it("falls back to the most recent unread thread when every other thread is unread", () => {
      const placeholder = placeholderFor({
        panes: twoPanes(),
        threads: [
          makeThread("thr_a"),
          makeThread("thr_b"),
          makeThread("thr_older", { latestAttentionAt: 100, isUnread: true }),
          makeThread("thr_newer", { latestAttentionAt: 500, isUnread: true }),
        ],
      });

      expect(placeholder).toBe("toThread thr_newer split");
    });

    it("skips archived and hidden threads", () => {
      const placeholder = placeholderFor({
        panes: twoPanes(),
        threads: [
          makeThread("thr_a"),
          makeThread("thr_b"),
          makeThread("thr_archived", { latestAttentionAt: 900, isArchived: true }),
          makeThread("thr_hidden", { latestAttentionAt: 800, isHidden: true }),
          makeThread("thr_plain", { latestAttentionAt: 100 }),
        ],
      });

      expect(placeholder).toBe("toThread thr_plain split");
    });

    it("counts the thread of a single pane as shown", () => {
      const placeholder = placeholderFor({
        contextThreadId: "thr_a",
        threads: [
          makeThread("thr_a", { latestAttentionAt: 900 }),
          makeThread("thr_b", { latestAttentionAt: 100 }),
        ],
      });

      expect(placeholder).toBe("toThread thr_b split");
    });
  });

  describe("when a pane is zoomed", () => {
    it("unzooms with bb's own command before it splits to the right", () => {
      bbShows({ panes: twoPanes(), threads: threads("thr_a", "thr_b", "thr_c") });
      vi.mocked(isPaneZoomed).mockReturnValue(true);

      openNewThreadInSplit("right");

      expect(calls).toEqual([
        `command ${BB_COMMANDS.paneMaximizeToggle}`,
        "toThread thr_c split",
      ]);
    });

    it("unzooms with the maximize button when bb declines the command, before it splits below", () => {
      bbShows({ panes: twoPanes(), threads: threads("thr_a", "thr_b", "thr_c") });
      vi.mocked(isPaneZoomed).mockReturnValue(true);
      vi.mocked(runCoreCommand).mockReturnValue("declined");

      openNewThreadInSplit("down");

      expect(calls).toEqual(["click maximize", "threads.open thr_c down"]);
    });

    it("unzooms before it swaps the focused thread into the new pane", () => {
      bbShows({ panes: twoPanes(), threads: threads("thr_a", "thr_b") });
      vi.mocked(isPaneZoomed).mockReturnValue(true);

      openNewThreadInSplit("right");

      expect(calls).toEqual([`command ${BB_COMMANDS.paneMaximizeToggle}`, "toCompose"]);
    });

    it("leaves the zoom alone when there is no thread to open the new pane with", () => {
      bbShows({ panes: [pane("p1", null, true), pane("p2", "thr_b")], threads: threads("thr_b") });
      vi.mocked(isPaneZoomed).mockReturnValue(true);

      expect(openNewThreadInSplit("right")).toBe("unavailable");
      expect(calls).toEqual([]);
    });
  });

  describe("when every thread is already in a pane", () => {
    const THREADS = threads("thr_a", "thr_b");

    it("turns the focused pane into the New thread screen and moves its thread to a new pane on the right", () => {
      bbShows({ panes: twoPanes(), threads: THREADS });

      expect(openNewThreadInSplit("right")).toBe("started");

      expect(navigate.toCompose).toHaveBeenCalledWith();
      expect(calls).toEqual(["toCompose"]);

      runFrame();
      expect(calls).toHaveLength(1);

      bbShows({ panes: [pane("p1", null, true), pane("p2", "thr_b")], threads: THREADS });
      runFrame();

      expect(navigate.toThread).toHaveBeenCalledWith("thr_a", { split: true });
      expect(calls).toEqual(["toCompose", "toThread thr_a split"]);

      runFrame();
      expect(calls).toHaveLength(2);

      bbShows({
        panes: [pane("p1", null), pane("p2", "thr_b"), pane("p3", "thr_a", true)],
        threads: THREADS,
      });
      runFrame();

      expect(navigate.toCompose).toHaveBeenLastCalledWith({ focusPrompt: true });
      expect(calls).toEqual(["toCompose", "toThread thr_a split", "toCompose focusPrompt"]);
      expect(noticeText()).toBeNull();
      expectNothingPending();
    });

    it("does the same below for a single pane whose thread is the only one", () => {
      bbShows({ contextThreadId: "thr_a", threads: threads("thr_a") });

      expect(openNewThreadInSplit("down")).toBe("started");
      expect(calls).toEqual(["toCompose"]);

      bbShows({ threads: threads("thr_a"), composers: [NEW_THREAD_COMPOSER] });
      runFrame();

      expect(threadsOpen).toHaveBeenCalledWith({
        threadId: "thr_a",
        split: "down",
        file: null,
      });
      expect(navigate.toThread).not.toHaveBeenCalled();

      bbShows({
        panes: [pane("p1", null), pane("p2", "thr_a", true)],
        contextThreadId: "thr_a",
        threads: threads("thr_a"),
        composers: [NEW_THREAD_COMPOSER],
      });
      runFrame();

      expect(calls).toEqual(["toCompose", "threads.open thr_a down", "toCompose focusPrompt"]);
      expectNothingPending();
    });

    it("waits, with a single pane, for bb to list the New thread message box before it opens the thread again", () => {
      bbShows({ contextThreadId: "thr_a", threads: threads("thr_a") });
      openNewThreadInSplit("right");

      bbShows({ threads: threads("thr_a") });
      runFrame();
      bbShows({
        contextThreadId: "thr_a",
        threads: threads("thr_a"),
        composers: [NEW_THREAD_COMPOSER],
      });
      runFrame();

      expect(calls).toEqual(["toCompose"]);
      expect(frames.size).toBe(1);
    });

    it("gives up after 1500 ms when the New thread screen does not show", () => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      openNewThreadInSplit("down");

      runFrame();
      vi.advanceTimersByTime(1499);
      expect(noticeText()).toBeNull();

      vi.advanceTimersByTime(1);

      expect(noticeText()).toBe(NEW_PANE_FAILED_NOTICE);
      expect(calls).toEqual(["toCompose"]);
      expectNothingPending();
    });

    function swapUntilNewPaneIsAskedFor(placement: "right" | "down"): HTMLElement {
      bbShows({ panes: twoPanes(), threads: THREADS });
      openNewThreadInSplit(placement);
      const editor = showNewThreadScreenIn("p1");
      bbShows({ panes: [pane("p1", null, true), pane("p2", "thr_b")], threads: THREADS });
      runFrame();
      return editor;
    }

    it.each([
      ["right", 1500, "toThread thr_a split"],
      ["down", 3000, "threads.open thr_a down"],
    ] as const)(
      "puts the thread back and says so when it does not show in a new pane %s in time",
      (placement, limitMs, secondStep) => {
        swapUntilNewPaneIsAskedFor(placement);

        vi.advanceTimersByTime(limitMs - 1);
        expect(noticeText()).toBeNull();
        expect(calls).toEqual(["toCompose", secondStep]);
        vi.advanceTimersByTime(1);

        expect(navigate.toThread).toHaveBeenLastCalledWith("thr_a");
        expect(calls).toEqual(["toCompose", secondStep, "toThread thr_a"]);
        expect(noticeText()).toBe(`${NEW_PANE_FAILED_NOTICE} ${THREAD_PUT_BACK_NOTICE}`);

        bbShows({
          panes: [pane("p1", null), pane("p2", "thr_b"), pane("p3", "thr_a", true)],
          threads: THREADS,
        });
        runFrame();
        expect(navigate.toCompose).toHaveBeenCalledTimes(1);
      },
    );

    it("puts the thread back and shows one notice when sdk.threads.open rejects", async () => {
      bbRejectsThreadsOpen();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      swapUntilNewPaneIsAskedFor("down");

      await settlePromises();

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(["toCompose", "threads.open thr_a down", "toThread thr_a"]);
      expect(noticeText()).toBe(
        `${NEW_PANE_BELOW_FAILED_NOTICE} ${THREAD_PUT_BACK_NOTICE}`,
      );
      const noticeId = getUiState().notice?.id;

      vi.advanceTimersByTime(5000);

      expect(getUiState().notice?.id).toBe(noticeId);
      expect(calls).toHaveLength(3);
    });

    it("leaves the thread closed and says where to find it when another pane has the focus by then", () => {
      swapUntilNewPaneIsAskedFor("right");
      bbShows({ panes: [pane("p1", null), pane("p2", "thr_b", true)], threads: THREADS });

      vi.advanceTimersByTime(1500);

      expect(calls).toEqual(["toCompose", "toThread thr_a split"]);
      expect(noticeText()).toBe(`${NEW_PANE_FAILED_NOTICE} ${THREAD_CLOSED_NOTICE}`);
      expectNothingPending();
    });

    function bbListsNewThreadDraft(isEmpty: boolean): void {
      bbShows({
        panes: [pane("p1", null, true), pane("p2", "thr_b")],
        threads: THREADS,
        composers: [{ ...NEW_THREAD_COMPOSER, isEmpty }],
      });
    }

    it("puts the thread back although bb itself put the cursor in the New thread message box, while the draft is empty", () => {
      const editor = swapUntilNewPaneIsAskedFor("down");
      editor.focus();
      bbListsNewThreadDraft(true);

      vi.advanceTimersByTime(3000);

      expect(calls).toEqual(["toCompose", "threads.open thr_a down", "toThread thr_a"]);
      expect(noticeText()).toBe(`${NEW_PANE_FAILED_NOTICE} ${THREAD_PUT_BACK_NOTICE}`);
    });

    it("does not put the thread back over a New thread screen that the user has written a draft in", () => {
      const editor = swapUntilNewPaneIsAskedFor("down");
      editor.focus();
      bbListsNewThreadDraft(false);

      vi.advanceTimersByTime(3000);

      expect(calls).toEqual(["toCompose", "threads.open thr_a down"]);
      expect(noticeText()).toBe(`${NEW_PANE_FAILED_NOTICE} ${THREAD_CLOSED_NOTICE}`);
      expect(document.activeElement).toBe(editor);
      expectNothingPending();
    });

    it("does not put the thread back while bb does not list the New thread message box, whose draft is then not known", () => {
      const editor = swapUntilNewPaneIsAskedFor("down");
      editor.focus();

      vi.advanceTimersByTime(3000);

      expect(calls).toEqual(["toCompose", "threads.open thr_a down"]);
      expect(noticeText()).toBe(`${NEW_PANE_FAILED_NOTICE} ${THREAD_CLOSED_NOTICE}`);
      expect(document.activeElement).toBe(editor);
    });

    it.each([
      ["another text field", "<textarea></textarea>", "textarea"],
      ["the terminal", "<div data-app-terminal><textarea></textarea></div>", "textarea"],
    ])("does not put the thread back while the cursor is in %s, whatever the draft holds", (_name, html, selector) => {
      swapUntilNewPaneIsAskedFor("right");
      bbListsNewThreadDraft(true);
      document.body.insertAdjacentHTML("beforeend", html);
      const field = document.body.querySelector<HTMLElement>(`body > ${selector}, body > div > ${selector}`);
      field?.focus();
      expect(document.activeElement).toBe(field);

      vi.advanceTimersByTime(1500);

      expect(calls).toEqual(["toCompose", "toThread thr_a split"]);
      expect(noticeText()).toBe(`${NEW_PANE_FAILED_NOTICE} ${THREAD_CLOSED_NOTICE}`);
      expect(document.activeElement).toBe(field);
    });

    it("gives the cursor to the message box of the pane that has the focus by then when the thread stays closed", () => {
      swapUntilNewPaneIsAskedFor("right");
      const focus = vi.fn();
      bbShows({
        panes: [pane("p1", null), pane("p2", "thr_b", true)],
        threads: THREADS,
        composers: [{ scope: { kind: "thread", threadId: "thr_b" }, focus }],
      });

      vi.advanceTimersByTime(1500);

      expect(noticeText()).toBe(`${NEW_PANE_FAILED_NOTICE} ${THREAD_CLOSED_NOTICE}`);
      expect(focus).toHaveBeenCalledTimes(1);
    });

    it("does not put the thread back when it shows in a pane after all", () => {
      swapUntilNewPaneIsAskedFor("right");
      bbShows({
        panes: [pane("p1", null, true), pane("p2", "thr_b"), pane("p3", "thr_a")],
        threads: THREADS,
      });

      vi.advanceTimersByTime(1500);

      expect(calls).toEqual(["toCompose", "toThread thr_a split"]);
      expect(noticeText()).toBe(NEW_PANE_FAILED_NOTICE);
      expectNothingPending();
    });

    it("does not put the thread back on a rejection that comes after a pointer press ended the wait", async () => {
      bbRejectsThreadsOpen();
      vi.spyOn(console, "error").mockImplementation(() => {});
      swapUntilNewPaneIsAskedFor("down");

      interruptPendingNewThread();
      await settlePromises();

      expect(calls).toEqual(["toCompose", "threads.open thr_a down"]);
      expect(noticeText()).toBe(
        `${NEW_PANE_BELOW_FAILED_NOTICE} ${THREAD_CLOSED_NOTICE}`,
      );
      expectNothingPending();
    });

    describe("when the mouse is pressed before the new pane was asked for", () => {
      it("opens no pane, and says that the thread is closed once bb shows the New thread screen", () => {
        bbShows({ panes: twoPanes(), threads: THREADS });
        openNewThreadInSplit("right");

        interruptPendingNewThread();
        expect(noticeText()).toBeNull();
        bbShows({ panes: [pane("p1", null, true), pane("p2", "thr_b")], threads: THREADS });
        runFrame();

        expect(calls).toEqual(["toCompose"]);
        expect(noticeText()).toBe(`${NEW_PANE_FAILED_NOTICE} ${THREAD_CLOSED_NOTICE}`);
        expectNothingPending();
      });

      it("says nothing when the thread stayed in its pane", () => {
        bbShows({ panes: twoPanes(), threads: THREADS });
        openNewThreadInSplit("down");

        interruptPendingNewThread();
        interruptPendingNewThread();
        runFrame();
        vi.advanceTimersByTime(1500);

        expect(calls).toEqual(["toCompose"]);
        expect(noticeText()).toBeNull();
        expectNothingPending();
      });

      it("says that the thread is closed when it left its pane and the New thread screen never got the focus", () => {
        bbShows({ panes: twoPanes(), threads: THREADS });
        openNewThreadInSplit("right");

        interruptPendingNewThread();
        bbShows({ panes: [pane("p1", null), pane("p2", "thr_b", true)], threads: THREADS });
        runFrame();
        expect(noticeText()).toBeNull();
        vi.advanceTimersByTime(1500);

        expect(calls).toEqual(["toCompose"]);
        expect(noticeText()).toBe(`${NEW_PANE_FAILED_NOTICE} ${THREAD_CLOSED_NOTICE}`);
        expectNothingPending();
      });
    });

    it("stops waiting for the reopened thread when the mouse is pressed, and leaves it in the new pane", () => {
      swapUntilNewPaneIsAskedFor("right");

      interruptPendingNewThread();
      expectNothingPending();
      bbShows({
        panes: [pane("p1", null), pane("p2", "thr_b"), pane("p3", "thr_a", true)],
        threads: THREADS,
      });
      runFrame();
      vi.advanceTimersByTime(5000);

      expect(calls).toEqual(["toCompose", "toThread thr_a split"]);
      expect(noticeText()).toBeNull();
    });

    it("says so when the focused pane has no thread either", () => {
      mountPane("p1", "<p>plugin page</p>");
      bbShows({ panes: [pane("p1", null, true), pane("p2", "thr_b")], threads: threads("thr_b") });

      expect(openNewThreadInSplit("right")).toBe("unavailable");

      expect(noticeText()).toBe("There is no thread to open the new pane with.");
      expect(calls).toEqual([]);
      expectNothingPending();
    });

    it("says so when there is no thread at all", () => {
      bbShows();

      expect(openNewThreadInSplit("down")).toBe("unavailable");

      expect(noticeText()).toBe("There is no thread to open the new pane with.");
      expect(calls).toEqual([]);
    });
  });

  describe("cancelling", () => {
    const THREADS = threads("thr_a", "thr_b", "thr_c");

    it("lets a newer call cancel an older pending one", () => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      openNewThreadInSplit("right");
      openNewThreadInSplit("down");
      expect(frames.size).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(1500);
      expect(noticeText()).toBeNull();

      bbShows({ panes: withNewPane("thr_c"), threads: THREADS });
      runFrame();

      expect(calls).toEqual([
        "toThread thr_c split",
        "threads.open thr_c down",
        "toCompose focusPrompt",
      ]);
      expectNothingPending();
    });

    it("drops the pending call even when the newer one cannot start", () => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      openNewThreadInSplit("right");
      setBridge(null);

      expect(openNewThreadInSplit("right")).toBe("unavailable");
      expectNothingPending();
    });

    it("does not let the rejection of an older call stop the wait of a newer one", async () => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      bbRejectsThreadsOpen();
      vi.spyOn(console, "error").mockImplementation(() => {});
      openNewThreadInSplit("down");
      openNewThreadInSplit("right");

      await settlePromises();

      expect(noticeText()).toBe(NEW_PANE_BELOW_FAILED_NOTICE);
      expect(frames.size).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      bbShows({ panes: withNewPane("thr_c"), threads: THREADS });
      runFrame();

      expect(calls).toEqual([
        "threads.open thr_c down",
        "toThread thr_c split",
        "toCompose focusPrompt",
      ]);
      expectNothingPending();
    });

    it.each([
      ["what cancels the plugin's other pending work", cancelPendingActions],
      ["its own cancel", cancelPendingNewThread],
      ["a pointer press", interruptPendingNewThread],
    ])("stops waiting for the new pane on %s", (_label, cancel) => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      openNewThreadInSplit("right");

      cancel();
      expectNothingPending();

      bbShows({ panes: withNewPane("thr_c"), threads: THREADS });
      runFrame();
      vi.advanceTimersByTime(5000);

      expect(calls).toEqual(["toThread thr_c split"]);
      expect(noticeText()).toBeNull();
    });

    it("stops waiting for the New thread screen when pending work is cancelled", () => {
      bbShows({ panes: twoPanes(), threads: threads("thr_a", "thr_b") });
      openNewThreadInSplit("right");

      cancelPendingActions();
      bbShows({
        panes: [pane("p1", null, true), pane("p2", "thr_b")],
        threads: threads("thr_a", "thr_b"),
      });
      runFrame();
      vi.advanceTimersByTime(5000);

      expect(calls).toEqual(["toCompose"]);
      expect(noticeText()).toBeNull();
      expectNothingPending();
    });
  });

  describe("the plugin's own focus settling", () => {
    const THREADS = threads("thr_a", "thr_b", "thr_c");

    function mountNewPane(): HTMLElement {
      const element = mountPane("p-new", COMPOSER);
      element.setAttribute(ATTRIBUTES.paneFocused, "true");
      return editorOf(element);
    }

    it("is cancelled before the new pane is opened", () => {
      bbShows({ panes: twoPanes(), threads: THREADS });
      settleDomFocusWhen(() => false, 5000);

      openNewThreadInSplit("right");

      expect(frames.size).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      cancelPendingNewThread();
      vi.advanceTimersByTime(5000);
      expect(focusPaneElement).not.toHaveBeenCalled();
    });

    it("leaves no settle behind, so the cursor stays in the New thread message box", () => {
      bbShows({
        panes: twoPanes(),
        threads: THREADS,
        composers: [{ scope: { kind: "thread", threadId: "thr_a" } }],
      });
      settleDomFocusWhen(() => true);
      runFrame();
      expect(focusPaneElement).toHaveBeenCalledTimes(1);

      openNewThreadInSplit("right");
      settleDomFocusWhen(() => false, 5000);
      const editor = mountNewPane();
      bbShows({
        panes: withNewPane("thr_c"),
        threads: THREADS,
        composers: [{ scope: { kind: "thread", threadId: "thr_c" } }],
      });
      runFrame();

      expect(calls).toEqual(["toThread thr_c split", "toCompose focusPrompt"]);
      expectNothingPending();

      bbShows({
        panes: withNewPane(null),
        threads: THREADS,
        composers: [NEW_THREAD_COMPOSER],
      });
      editor.focus();
      vi.advanceTimersByTime(5000);

      expect(document.activeElement).toBe(editor);
      expect(focusPaneElement).toHaveBeenCalledTimes(1);
    });

    it("is cancelled at each step of the swap as well", () => {
      bbShows({ panes: twoPanes(), threads: threads("thr_a", "thr_b") });
      settleDomFocusWhen(() => false, 5000);
      openNewThreadInSplit("right");
      expect(vi.getTimerCount()).toBe(1);

      settleDomFocusWhen(() => false, 5000);
      bbShows({
        panes: [pane("p1", null, true), pane("p2", "thr_b")],
        threads: threads("thr_a", "thr_b"),
      });
      runFrame();
      expect(vi.getTimerCount()).toBe(1);

      settleDomFocusWhen(() => false, 5000);
      bbShows({
        panes: [pane("p1", null), pane("p2", "thr_b"), pane("p3", "thr_a", true)],
        threads: threads("thr_a", "thr_b"),
      });
      runFrame();

      expectNothingPending();
      expect(focusPaneElement).not.toHaveBeenCalled();
    });
  });
});

describe("hasNewThreadScreenInAnotherPane", () => {
  function bridgeNow(): Bridge {
    const bridge = getBridge();
    if (bridge === null) throw new Error("no bridge was published");
    return bridge;
  }

  it("is true while a pane other than the focused one shows the New thread screen", () => {
    mountPane("p1");
    mountPane("p2", COMPOSER);
    bbShows({ panes: [pane("p1", "thr_a", true), pane("p2", null)] });

    expect(hasNewThreadScreenInAnotherPane(bridgeNow())).toBe(true);
  });

  it.each([
    ["the focused pane shows it", [pane("p1", "thr_a"), pane("p2", null, true)], COMPOSER],
    ["the other pane shows a plugin page with a chat", [pane("p1", "thr_a", true), pane("p2", null)], PLUGIN_CHAT],
    ["the other pane shows a thread", [pane("p1", "thr_a", true), pane("p2", "thr_b")], COMPOSER],
  ])("is false when %s", (_name, panes, html) => {
    mountPane("p1");
    mountPane("p2", html);
    bbShows({ panes });

    expect(hasNewThreadScreenInAnotherPane(bridgeNow())).toBe(false);
  });

  it("is false in a window that is not split", () => {
    bbShows({ contextThreadId: null });

    expect(hasNewThreadScreenInAnotherPane(bridgeNow())).toBe(false);
  });
});
