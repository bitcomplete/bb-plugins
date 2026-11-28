import { afterEach, describe, expect, it } from "vitest";
import { resetStore, setBridge } from "./bridge";
import {
  findLastFocusedPane,
  forgetStandIn,
  getFocusOrder,
  getLastShownThreadId,
  noteLayout,
  passFocusOn,
  resetHistory,
} from "./history";
import type { Bridge, SplitPane } from "./types";

function pane(paneId: string, threadId: string | null, isFocused = false): SplitPane {
  return { paneId, threadId, isFocused, rect: { x: 0, y: 0, width: 1, height: 1 } };
}

function panes(focused: string, ...ids: string[]): SplitPane[] {
  return ids.map((id) => pane(id, `thr_${id}`, id === focused));
}

function showInWindow(...threadIds: (string | null)[]): void {
  for (const threadId of threadIds) noteLayout(null, threadId);
}

function showInPane(paneId: string, ...threadIds: (string | null)[]): void {
  for (const threadId of threadIds) {
    noteLayout({ panes: [pane(paneId, threadId, true), pane("other", "thr_o")] }, null);
  }
}

afterEach(() => {
  resetStore();
});

describe("the thread that a pane showed before", () => {
  it("is none for a pane that has shown one thread, or none at all", () => {
    expect(getLastShownThreadId(null)).toBeNull();
    showInWindow("thr_a", "thr_a");

    expect(getLastShownThreadId(null)).toBeNull();
    expect(getLastShownThreadId("p1")).toBeNull();
  });

  it("is the thread before the one that the pane shows now", () => {
    showInWindow("thr_x", "thr_a");
    expect(getLastShownThreadId(null)).toBe("thr_x");

    showInWindow("thr_x");
    expect(getLastShownThreadId(null)).toBe("thr_a");
  });

  it("is the thread that the pane showed last while it shows the New thread screen", () => {
    showInWindow("thr_x", "thr_a", null);

    expect(getLastShownThreadId(null)).toBe("thr_a");
  });

  it("is the only thread that the pane has shown while it shows the New thread screen", () => {
    showInWindow("thr_a", null);

    expect(getLastShownThreadId(null)).toBe("thr_a");
  });

  it("is that same thread once another thread follows the New thread screen", () => {
    showInWindow("thr_x", "thr_a", null, "thr_b");

    expect(getLastShownThreadId(null)).toBe("thr_a");
  });

  it("is the thread before again once the pane shows its last thread after the New thread screen", () => {
    showInWindow("thr_x", "thr_a", null, "thr_a");

    expect(getLastShownThreadId(null)).toBe("thr_x");
  });

  it("is none for a pane that has only shown the New thread screen", () => {
    showInWindow(null, null);

    expect(getLastShownThreadId(null)).toBeNull();
  });

  it("is kept for each pane of a split apart, and apart from the window without a split", () => {
    showInPane("p1", "thr_x", "thr_a", null);

    expect(getLastShownThreadId("p1")).toBe("thr_a");
    expect(getLastShownThreadId("other")).toBeNull();
    expect(getLastShownThreadId(null)).toBeNull();
  });
});

describe("the thread that a pane showed before, over the start and the end of a split", () => {
  const T0 = 10_000;

  it("goes with the pane into the split, so that the pane still knows what it showed as the only pane", () => {
    showInWindow("thr_a", "thr_b");

    noteLayout({ panes: [pane("p1", "thr_b"), pane("p2", "thr_c", true)] }, "thr_c");

    expect(getLastShownThreadId("p1")).toBe("thr_a");
    expect(getLastShownThreadId("p2")).toBeNull();
  });

  it("does not go to a pane of the split that shows another thread", () => {
    showInWindow("thr_a", "thr_b");

    noteLayout({ panes: [pane("p1", "thr_x"), pane("p2", "thr_c", true)] }, "thr_c");

    expect(getLastShownThreadId("p1")).toBeNull();
    expect(getLastShownThreadId("p2")).toBeNull();
  });

  it("stays with the pane that is left when the split ends", () => {
    showInWindow("thr_a", "thr_b");
    noteLayout({ panes: [pane("p1", "thr_b", true), pane("p2", "thr_c")] }, "thr_b", T0);
    noteLayout({ panes: [pane("p1", "thr_d", true), pane("p2", "thr_c")] }, "thr_d", T0);
    noteLayout({ panes: [pane("p1", "thr_e", true), pane("p2", "thr_c")] }, "thr_e", T0);

    noteLayout(null, "thr_e", T0);

    expect(getLastShownThreadId(null)).toBe("thr_d");
  });

  it("follows the context when it names the thread of the closed pane for a moment after the split has ended", () => {
    noteLayout({ panes: [pane("p1", "thr_d"), pane("p2", "thr_c", true)] }, "thr_c", T0);
    noteLayout({ panes: [pane("p1", "thr_e"), pane("p2", "thr_c", true)] }, "thr_c", T0);

    noteLayout(null, "thr_c", T0);
    noteLayout(null, "thr_e", T0 + 50);

    expect(getLastShownThreadId(null)).toBe("thr_d");
  });

  it("takes a thread that is opened later for a new one, also when a pane of the split showed it", () => {
    noteLayout({ panes: [pane("p1", "thr_d", true), pane("p2", "thr_c")] }, "thr_d", T0);
    noteLayout({ panes: [pane("p1", "thr_e", true), pane("p2", "thr_x")] }, "thr_e", T0);
    noteLayout({ panes: [pane("p1", "thr_e", true), pane("p2", "thr_c")] }, "thr_e", T0);
    noteLayout(null, "thr_e", T0);

    noteLayout(null, "thr_c", T0 + 1001);
    expect(getLastShownThreadId(null)).toBe("thr_e");

    resetHistory();
    noteLayout({ panes: [pane("p1", "thr_e", true), pane("p2", "thr_x")] }, "thr_e", T0);
    noteLayout({ panes: [pane("p1", "thr_e", true), pane("p2", "thr_c")] }, "thr_e", T0);
    noteLayout(null, "thr_e", T0);
    noteLayout(null, "thr_w", T0 + 10);
    noteLayout(null, "thr_c", T0 + 20);
    expect(getLastShownThreadId(null)).toBe("thr_w");
  });

  it.each([
    ["p2", "p1"],
    ["p1", "p2"],
  ])(
    "does not hand what the closed pane %s showed to a pane that gets its id in a later split",
    (closed, staying) => {
      const stayingThread = `thr_${staying}`;
      noteLayout({ panes: [pane("p1", "thr_x"), pane("p2", "thr_y", true)] }, "thr_y", T0);
      noteLayout({ panes: [pane("p1", "thr_p1"), pane("p2", "thr_p2", true)] }, "thr_p2", T0);
      noteLayout(null, stayingThread, T0);

      noteLayout(
        { panes: [pane(staying, stayingThread), pane(closed, "thr_e", true)] },
        "thr_e",
        T0 + 5000,
      );

      expect(getLastShownThreadId(closed)).toBeNull();
      expect(getLastShownThreadId(staying)).toBe(staying === "p1" ? "thr_x" : "thr_y");
    },
  );

  it.each([
    ["names the thread of the closed pane for a moment", ["thr_a", null]],
    ["names no thread at once", [null]],
  ] as const)(
    "stays with a pane that shows the New thread screen when the split ends and the context %s",
    (_name, contexts) => {
      showInWindow("thr_w", "thr_v");
      noteLayout({ panes: [pane("p1", "thr_q", true), pane("p2", "thr_a")] }, "thr_q", T0);
      noteLayout({ panes: [pane("p1", null), pane("p2", "thr_a", true)] }, "thr_a", T0);
      expect(getLastShownThreadId("p1")).toBe("thr_q");

      contexts.forEach((context, at) => noteLayout(null, context, T0 + at * 50));
      expect(getLastShownThreadId(null)).toBe("thr_q");

      noteLayout(null, null, T0 + 5000);
      expect(getLastShownThreadId(null)).toBe("thr_q");
    },
  );

  it.each([
    ["names the thread of the closed pane for a moment", ["thr_a", null]],
    ["names no thread at once", [null]],
  ] as const)(
    "is none for a pane that has only ever shown the New thread screen when the split ends and the context %s",
    (_name, contexts) => {
      showInWindow("thr_a");
      noteLayout({ panes: [pane("p1", "thr_a"), pane("p2", "thr_p", true)] }, "thr_p", T0);
      forgetStandIn("p2", "thr_p");
      noteLayout({ panes: [pane("p1", "thr_a"), pane("p2", null, true)] }, null, T0);
      noteLayout({ panes: [pane("p1", "thr_a", true), pane("p2", null)] }, "thr_a", T0);

      contexts.forEach((context, at) => noteLayout(null, context, T0 + at * 50));
      expect(getLastShownThreadId(null)).toBeNull();

      noteLayout(null, null, T0 + 5000);
      expect(getLastShownThreadId(null)).toBeNull();
    },
  );

  it("is none for such a pane that still holds the thread it was opened with when the split ends", () => {
    showInWindow("thr_a");
    noteLayout({ panes: [pane("p1", "thr_a"), pane("p2", "thr_p", true)] }, "thr_p", T0);
    forgetStandIn("p2", "thr_p");
    noteLayout({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_p")] }, "thr_a", T0);

    noteLayout(null, "thr_a", T0);
    noteLayout(null, null, T0 + 50);

    expect(getLastShownThreadId(null)).toBeNull();
  });

  it("keeps what the pane with a thread showed before when the pane that only ever showed the New thread screen is the one that was closed", () => {
    showInWindow("thr_x", "thr_a");
    noteLayout({ panes: [pane("p1", "thr_a"), pane("p2", "thr_p", true)] }, "thr_p", T0);
    forgetStandIn("p2", "thr_p");
    noteLayout({ panes: [pane("p1", "thr_a"), pane("p2", null, true)] }, null, T0);

    noteLayout(null, "thr_a", T0);

    expect(getLastShownThreadId(null)).toBe("thr_x");
  });

  // bb closes the pane that has the focus, so the context names the thread
  // of the pane that stays, and no thread once the user starts a new one.
  it.each([
    ["shows the New thread screen", null],
    ["still holds the thread it was opened with", "thr_p"],
  ])(
    "is the thread of the pane that stays, when the focused pane that only ever showed the New thread screen and %s is closed and the user goes to the New thread screen within a second",
    (_name, held) => {
      showInWindow("thr_x", "thr_a");
      noteLayout({ panes: [pane("p1", "thr_a"), pane("p2", "thr_p", true)] }, "thr_p", T0);
      forgetStandIn("p2", "thr_p");
      noteLayout({ panes: [pane("p1", "thr_a"), pane("p2", held, true)] }, held, T0);

      noteLayout(null, "thr_a", T0);
      expect(getLastShownThreadId(null)).toBe("thr_x");

      noteLayout(null, null, T0 + 700);
      expect(getLastShownThreadId(null)).toBe("thr_a");
    },
  );

  it("is that thread as well when the context names no thread for a moment after that pane was closed", () => {
    showInWindow("thr_x", "thr_a");
    noteLayout({ panes: [pane("p1", "thr_a"), pane("p2", null, true)] }, null, T0);

    noteLayout(null, null, T0);
    noteLayout(null, "thr_a", T0 + 50);
    noteLayout(null, null, T0 + 700);

    expect(getLastShownThreadId(null)).toBe("thr_a");
  });

  it("starts anew for a thread that is opened in the pane that only ever showed the New thread screen", () => {
    showInWindow("thr_a");
    noteLayout({ panes: [pane("p1", "thr_a", true), pane("p2", null)] }, "thr_a", T0);
    noteLayout(null, "thr_a", T0);
    noteLayout(null, null, T0 + 50);

    noteLayout(null, "thr_b", T0 + 100);
    expect(getLastShownThreadId(null)).toBeNull();

    noteLayout(null, "thr_c", T0 + 150);
    expect(getLastShownThreadId(null)).toBe("thr_b");
  });

  it("drops what the window showed before the split when the pane that stays has shown nothing else", () => {
    showInWindow("thr_x", "thr_y");
    noteLayout({ panes: [pane("p1", "thr_y"), pane("p2", "thr_a", true)] }, "thr_a", T0);

    noteLayout(null, "thr_a", T0);

    expect(getLastShownThreadId(null)).toBeNull();
  });

  it("goes with a pane that shows the New thread screen into the split", () => {
    showInWindow("thr_q", null);
    expect(getLastShownThreadId(null)).toBe("thr_q");

    noteLayout({ panes: [pane("p1", null), pane("p2", "thr_c", true)] }, "thr_c");

    expect(getLastShownThreadId("p1")).toBe("thr_q");
    expect(getLastShownThreadId("p2")).toBeNull();
  });

  it("does not guess which pane of a split the window was when two of them show no thread", () => {
    showInWindow("thr_q", null);

    noteLayout({ panes: [pane("p1", null), pane("p2", null, true)] }, null);

    expect(getLastShownThreadId("p1")).toBeNull();
    expect(getLastShownThreadId("p2")).toBeNull();
  });

  it("forgets a pane that was closed, so that a later pane with its id starts anew", () => {
    noteLayout({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_x")] }, null);
    noteLayout({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_b")] }, null);
    noteLayout({ panes: [pane("p1", "thr_a", true), pane("p3", "thr_c")] }, null);

    noteLayout({ panes: [pane("p1", "thr_a", true), pane("p2", "thr_d")] }, null);

    expect(getLastShownThreadId("p2")).toBeNull();
  });
});

describe("the thread that only filled a new pane until the New thread screen took its place", () => {
  const SPLIT = [pane("p1", "thr_a"), pane("p2", "thr_p", true)];
  const NEW_THREAD_SCREEN = [pane("p1", "thr_a"), pane("p2", null, true)];
  const NEW_THREAD = [pane("p1", "thr_a"), pane("p2", "thr_t", true)];

  it("is not what the new pane showed before, on the New thread screen and in the thread that is started there", () => {
    showInWindow("thr_a");
    noteLayout({ panes: SPLIT }, "thr_p");
    forgetStandIn("p2", "thr_p");

    noteLayout({ panes: SPLIT }, "thr_p");
    noteLayout({ panes: NEW_THREAD_SCREEN }, null);
    expect(getLastShownThreadId("p2")).toBeNull();

    noteLayout({ panes: NEW_THREAD }, "thr_t");
    expect(getLastShownThreadId("p2")).toBeNull();
    expect(getLastShownThreadId("p1")).toBeNull();
  });

  it("counts again once the pane is asked to show that thread later", () => {
    noteLayout({ panes: SPLIT }, "thr_p");
    forgetStandIn("p2", "thr_p");
    noteLayout({ panes: NEW_THREAD_SCREEN }, null);
    noteLayout({ panes: NEW_THREAD }, "thr_t");

    noteLayout({ panes: SPLIT }, "thr_p");
    expect(getLastShownThreadId("p2")).toBe("thr_t");

    noteLayout({ panes: NEW_THREAD }, "thr_t");
    expect(getLastShownThreadId("p2")).toBe("thr_p");
  });

  it("counts when the user opens that thread in the pane from the New thread screen", () => {
    showInWindow("thr_a");
    noteLayout({ panes: SPLIT }, "thr_p");
    forgetStandIn("p2", "thr_p");
    noteLayout({ panes: SPLIT }, "thr_p");
    noteLayout({ panes: NEW_THREAD_SCREEN }, null);
    expect(getLastShownThreadId("p2")).toBeNull();

    noteLayout({ panes: SPLIT }, "thr_p");
    noteLayout({ panes: NEW_THREAD }, "thr_t");

    expect(getLastShownThreadId("p2")).toBe("thr_p");
  });

  it("is forgotten with its pane", () => {
    noteLayout({ panes: SPLIT }, "thr_p");
    forgetStandIn("p2", "thr_p");
    noteLayout({ panes: [pane("p1", "thr_a", true), pane("p3", "thr_c")] }, "thr_a");

    noteLayout({ panes: [pane("p1", "thr_a"), pane("p2", "thr_p", true)] }, "thr_p");
    noteLayout({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)] }, "thr_b");

    expect(getLastShownThreadId("p2")).toBe("thr_p");
  });
});

describe("the pane that had the focus before", () => {
  it("is none while one pane only has had the focus", () => {
    const layout = panes("p1", "p1", "p2");
    noteLayout({ panes: layout }, null);

    expect(findLastFocusedPane(layout)).toBeNull();
    expect(findLastFocusedPane([])).toBeNull();
  });

  it("is the pane that had the focus right before", () => {
    noteLayout({ panes: panes("p1", "p1", "p2", "p3") }, null);
    noteLayout({ panes: panes("p2", "p1", "p2", "p3") }, null);
    const layout = panes("p3", "p1", "p2", "p3");
    noteLayout({ panes: layout }, null);

    expect(findLastFocusedPane(layout)).toBe(layout[1]);
  });

  it("is the one before that when the pane that had the focus was closed", () => {
    noteLayout({ panes: panes("p1", "p1", "p2", "p3") }, null);
    noteLayout({ panes: panes("p2", "p1", "p2", "p3") }, null);
    noteLayout({ panes: panes("p3", "p1", "p2", "p3") }, null);
    const layout = panes("p2", "p1", "p2");
    noteLayout({ panes: layout }, null);

    expect(findLastFocusedPane(layout)).toBe(layout[0]);
  });

  it("is never the pane that has the focus now, also when the layout was not noted", () => {
    noteLayout({ panes: panes("p1", "p1", "p2") }, null);
    noteLayout({ panes: panes("p2", "p1", "p2") }, null);

    expect(findLastFocusedPane(panes("p1", "p1", "p2"))?.paneId).toBe("p2");
    expect(findLastFocusedPane(panes("p1", "p1"))).toBeNull();
  });

  it("goes back and forth between two panes", () => {
    for (const focused of ["p1", "p2", "p1", "p2"]) {
      noteLayout({ panes: panes(focused, "p1", "p2") }, null);
    }

    expect(findLastFocusedPane(panes("p2", "p1", "p2"))?.paneId).toBe("p1");
  });

  it("lists the panes that had the focus, the latest first", () => {
    expect(getFocusOrder()).toEqual([]);
    for (const focused of ["p1", "p2", "p3", "p2"]) {
      noteLayout({ panes: panes(focused, "p1", "p2", "p3") }, null);
    }

    expect(getFocusOrder()).toEqual(["p2", "p3", "p1"]);
  });

  it("is not changed by a layout without a focused pane, or by a window without a split", () => {
    noteLayout({ panes: panes("p1", "p1", "p2") }, null);
    noteLayout({ panes: panes("p2", "p1", "p2") }, null);
    noteLayout({ panes: panes("none", "p1", "p2") }, null);
    noteLayout(null, "thr_a");

    expect(findLastFocusedPane(panes("p2", "p1", "p2"))?.paneId).toBe("p1");
  });
});

describe("the pane that bb gives the focus to when a pane is closed, while the plugin moves the focus on", () => {
  const T0 = 10_000;
  const four = (focused: string): SplitPane[] => panes(focused, "p1", "p2", "p3", "p4");
  const three = (focused: string): SplitPane[] => panes(focused, "p1", "p2", "p3");

  // The panes get the focus in the order given, then p4 is closed and bb
  // gives the focus to p3. The return value is the order before the close.
  function closeFourthPaneAfter(...focused: string[]): readonly string[] {
    for (const paneId of focused) noteLayout({ panes: four(paneId) }, null, T0);
    const orderBefore = getFocusOrder();
    noteLayout({ panes: three("p3") }, null, T0);
    return orderBefore;
  }

  it("does not count as a pane that had the focus, as in tmux", () => {
    const orderBefore = closeFourthPaneAfter("p2", "p1", "p4");
    expect(getFocusOrder()).toEqual(["p3", "p4", "p1", "p2"]);

    passFocusOn("p3", orderBefore, T0);
    noteLayout({ panes: three("p3") }, null, T0 + 20);
    const layout = three("p1");
    noteLayout({ panes: layout }, null, T0 + 40);

    expect(getFocusOrder()).toEqual(["p1", "p4", "p2"]);
    expect(findLastFocusedPane(layout)?.paneId).toBe("p2");
  });

  it("keeps its place among the panes that had the focus before", () => {
    const orderBefore = closeFourthPaneAfter("p3", "p2", "p1", "p4");

    passFocusOn("p3", orderBefore, T0);
    noteLayout({ panes: three("p1") }, null, T0 + 40);

    expect(getFocusOrder()).toEqual(["p1", "p4", "p2", "p3"]);
  });

  it("counts again once another pane has had the focus", () => {
    const orderBefore = closeFourthPaneAfter("p2", "p1", "p4");
    passFocusOn("p3", orderBefore, T0);
    noteLayout({ panes: three("p1") }, null, T0 + 40);

    const layout = three("p3");
    noteLayout({ panes: layout }, null, T0 + 60);

    expect(findLastFocusedPane(layout)?.paneId).toBe("p1");
  });

  it("counts when the pane still has the focus after the time that a pane move takes", () => {
    const orderBefore = closeFourthPaneAfter("p2", "p1", "p4");
    passFocusOn("p3", orderBefore, T0);
    noteLayout({ panes: three("p3") }, null, T0 + 1500);
    expect(getFocusOrder()).toEqual(orderBefore);

    noteLayout({ panes: three("p3") }, null, T0 + 1501);

    expect(getFocusOrder()).toEqual(["p3", "p4", "p1", "p2"]);
  });

  it("is dropped by resetHistory", () => {
    passFocusOn("p3", [], T0);

    resetHistory();
    noteLayout({ panes: three("p3") }, null, T0);

    expect(getFocusOrder()).toEqual(["p3"]);
  });
});

describe("what is remembered", () => {
  function remember(): void {
    noteLayout({ panes: [pane("p1", "thr_x", true), pane("p2", "thr_b")] }, null);
    noteLayout({ panes: [pane("p1", "thr_a"), pane("p2", "thr_b", true)] }, null);
  }

  it("is dropped by resetHistory", () => {
    remember();

    resetHistory();

    expect(getLastShownThreadId("p1")).toBeNull();
    expect(findLastFocusedPane(panes("p2", "p1", "p2"))).toBeNull();
  });

  it("is dropped when the bridge is taken away, as it is while the plugin is switched off, so that nothing from before the off time counts after it", () => {
    const layout = { panes: [pane("p1", "thr_x", true), pane("p2", "thr_b")] };
    const bridge = { layout, context: { projectId: null, threadId: null } };
    setBridge(bridge as unknown as Bridge);
    remember();
    expect(getLastShownThreadId("p1")).toBe("thr_x");

    setBridge(null);
    const after = { panes: [pane("p1", "thr_e", true), pane("p2", "thr_b")] };
    setBridge({ ...bridge, layout: after } as unknown as Bridge);

    expect(getLastShownThreadId("p1")).toBeNull();
    expect(findLastFocusedPane(after.panes)).toBeNull();
  });
});
