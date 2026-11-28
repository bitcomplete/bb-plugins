// @vitest-environment jsdom
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { beforeEach, describe, expect, it } from "vitest";
import {
  activeThreads,
  cycleThread,
  isThreadRunning,
  lastThread,
  nthThread,
  readSidebarThreadOrder,
  resetThreadOrderCache,
  resolveThreadOrder,
  sortThreadsByRecency,
} from "./thread-order";

function makeThread(
  overrides: Partial<PluginSidebarThread> & { id: string },
): PluginSidebarThread {
  return {
    projectId: "proj_1",
    title: null,
    titleFallback: null,
    displayTitle: overrides.id,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    parentNotifications: "auto",
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "claude-code",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: `/threads/${overrides.id}`,
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 0,
    updatedAt: 0,
    lastReadAt: null,
    latestAttentionAt: 0,
    ...overrides,
  };
}

function ids(threads: readonly PluginSidebarThread[]): string[] {
  return threads.map((thread) => thread.id);
}

function sidebarBody(innerHtml: string, attributes = ""): void {
  document.body.innerHTML = `
    <div data-sidebar="sidebar">
      <div data-sidebar="content">
        <div data-testid="app-sidebar-body" ${attributes}>${innerHtml}</div>
      </div>
    </div>`;
}

function row(threadId: string): string {
  return `
    <div data-sidebar-rename-row>
      <a href="/threads/${threadId}" data-sidebar-thread-shortcut-target=""
        data-sidebar-thread-id="${threadId}" data-sidebar-rename-anchor=""></a>
      <span class="bb-thread-title">${threadId}</span>
    </div>`;
}

function realized(...threadIds: string[]): string {
  return `<div data-sidebar-windowed-item="">${threadIds.map(row).join("")}</div>`;
}

function placeholder(encoded: string): string {
  return `<div data-sidebar-windowed-item="" data-sidebar-windowed-nav="${encoded}" style="height: 28px"></div>`;
}

beforeEach(() => {
  document.body.innerHTML = "";
  resetThreadOrderCache();
});

describe("activeThreads", () => {
  it("drops archived and hidden threads and keeps the rest in order", () => {
    const threads = [
      makeThread({ id: "a" }),
      makeThread({ id: "archived", isArchived: true, archivedAt: 5 }),
      makeThread({ id: "hidden", isHidden: true }),
      makeThread({ id: "b" }),
    ];
    expect(ids(activeThreads(threads))).toEqual(["a", "b"]);
  });
});

describe("isThreadRunning", () => {
  it("is true for the busy statuses only", () => {
    const running = (status: PluginSidebarThread["status"]) =>
      isThreadRunning(makeThread({ id: "t", status }));
    expect(running("starting")).toBe(true);
    expect(running("active")).toBe(true);
    expect(running("stopping")).toBe(true);
    expect(running("idle")).toBe(false);
    expect(running("pending")).toBe(false);
    expect(running("error")).toBe(false);
  });

  it("treats a status this plugin does not know as not running", () => {
    const thread = makeThread({ id: "t" });
    const future = { ...thread, status: "hibernating" } as unknown as PluginSidebarThread;
    expect(isThreadRunning(future)).toBe(false);
  });
});

describe("sortThreadsByRecency", () => {
  it("puts running threads first, then the latest attention, then the newest", () => {
    const threads = [
      makeThread({ id: "old", latestAttentionAt: 10, createdAt: 1 }),
      makeThread({ id: "recent", latestAttentionAt: 90, createdAt: 2 }),
      makeThread({
        id: "running",
        status: "active",
        latestAttentionAt: 5,
        createdAt: 3,
      }),
      makeThread({ id: "tie-newer", latestAttentionAt: 50, createdAt: 9 }),
      makeThread({ id: "tie-older", latestAttentionAt: 50, createdAt: 4 }),
    ];
    expect(ids(sortThreadsByRecency(threads))).toEqual([
      "running",
      "recent",
      "tie-newer",
      "tie-older",
      "old",
    ]);
  });

  it("orders running threads among themselves by the same rule", () => {
    const threads = [
      makeThread({ id: "starting", status: "starting", latestAttentionAt: 1 }),
      makeThread({ id: "stopping", status: "stopping", latestAttentionAt: 3 }),
      makeThread({ id: "active", status: "active", latestAttentionAt: 2 }),
      makeThread({ id: "idle", latestAttentionAt: 99 }),
    ];
    expect(ids(sortThreadsByRecency(threads))).toEqual([
      "stopping",
      "active",
      "starting",
      "idle",
    ]);
  });

  it("puts the thread that was made later first among threads with the same activity, whatever their ids are", () => {
    const threads = [
      makeThread({ id: "a-older", latestAttentionAt: 50, createdAt: 4 }),
      makeThread({ id: "b-newer", latestAttentionAt: 50, createdAt: 9 }),
    ];
    expect(ids(sortThreadsByRecency(threads))).toEqual(["b-newer", "a-older"]);
  });

  it("falls back to the id so equal threads keep a stable order", () => {
    const threads = [makeThread({ id: "b" }), makeThread({ id: "a" })];
    expect(ids(sortThreadsByRecency(threads))).toEqual(["a", "b"]);
  });

  it("does not change the array it was given", () => {
    const threads = [
      makeThread({ id: "a", latestAttentionAt: 1 }),
      makeThread({ id: "b", latestAttentionAt: 2 }),
    ];
    sortThreadsByRecency(threads);
    expect(ids(threads)).toEqual(["a", "b"]);
  });
});

describe("readSidebarThreadOrder", () => {
  it("returns null when the sidebar body is missing", () => {
    document.body.innerHTML = `<div data-sidebar="sidebar">${row("thr_a")}</div>`;
    expect(readSidebarThreadOrder()).toBeNull();
  });

  it("returns null when the sidebar body has the hidden attribute", () => {
    sidebarBody(realized("thr_a", "thr_b"), "hidden");
    expect(readSidebarThreadOrder()).toBeNull();
  });

  it("reads row anchors in DOM order", () => {
    sidebarBody(realized("thr_a") + realized("thr_b", "thr_c"));
    expect(readSidebarThreadOrder()).toEqual(["thr_a", "thr_b", "thr_c"]);
  });

  it("expands windowed placeholders where they sit between mounted rows", () => {
    sidebarBody(
      realized("thr_a") +
        placeholder("thr_b:proj_1 thr_c:proj_2") +
        realized("thr_d") +
        placeholder("thr_e:proj_1"),
    );
    expect(readSidebarThreadOrder()).toEqual([
      "thr_a",
      "thr_b",
      "thr_c",
      "thr_d",
      "thr_e",
    ]);
  });

  it("skips malformed placeholder pairs the way bb does", () => {
    sidebarBody(placeholder("thr_a:proj_1 :proj_2 thr_b: thr_c  thr_d:proj_3"));
    expect(readSidebarThreadOrder()).toEqual(["thr_a", "thr_d"]);
  });

  it("skips rows and placeholders inside the More overflow menu", () => {
    sidebarBody(
      realized("thr_a") +
        `<div data-sidebar-overflow="true">${row("thr_more")}${placeholder("thr_more_windowed:proj_1")}</div>` +
        realized("thr_b"),
    );
    expect(readSidebarThreadOrder()).toEqual(["thr_a", "thr_b"]);
  });

  it("ignores overflow rows that are portaled outside the sidebar body", () => {
    sidebarBody(realized("thr_a"));
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div data-radix-popper-content-wrapper><div data-sidebar-overflow="true">${row("thr_more")}</div></div>`,
    );
    expect(readSidebarThreadOrder()).toEqual(["thr_a"]);
  });

  it("keeps the first position of a thread that appears twice", () => {
    sidebarBody(
      realized("thr_a", "thr_b") +
        placeholder("thr_a:proj_1 thr_c:proj_1") +
        realized("thr_b"),
    );
    expect(readSidebarThreadOrder()).toEqual(["thr_a", "thr_b", "thr_c"]);
  });

  it("ignores elements that are not thread row anchors", () => {
    sidebarBody(`
      <a href="/settings" data-sidebar-thread-shortcut-target="">no id</a>
      <a href="/threads/empty" data-sidebar-thread-shortcut-target="" data-sidebar-thread-id=""></a>
      <div data-sidebar-thread-shortcut-target="" data-sidebar-thread-id="thr_div"></div>
      <a href="/threads/thr_plain" data-sidebar-thread-id="thr_plain"></a>
      ${row("thr_a")}`);
    expect(readSidebarThreadOrder()).toEqual(["thr_a"]);
  });

  it("does not filter by visibility, so a collapsed sidebar still gives the order", () => {
    sidebarBody(realized("thr_a") + placeholder("thr_b:proj_1"));
    const sidebar = document.querySelector<HTMLElement>('[data-sidebar="sidebar"]');
    if (sidebar === null) throw new Error("fixture is missing the sidebar");
    sidebar.style.visibility = "hidden";
    for (const element of document.querySelectorAll<HTMLElement>("*")) {
      element.checkVisibility = () => false;
    }
    expect(readSidebarThreadOrder()).toEqual(["thr_a", "thr_b"]);
  });

  it("returns an empty list when the body has no rows yet", () => {
    sidebarBody("<p>Loading</p>");
    expect(readSidebarThreadOrder()).toEqual([]);
  });

  it("reads from the document it is given", () => {
    const other = document.implementation.createHTMLDocument("other");
    other.body.innerHTML = `<div data-testid="app-sidebar-body">${row("thr_other")}</div>`;
    expect(readSidebarThreadOrder(other)).toEqual(["thr_other"]);
    expect(readSidebarThreadOrder()).toBeNull();
  });
});

describe("resolveThreadOrder", () => {
  const threads = [
    makeThread({ id: "a", latestAttentionAt: 10 }),
    makeThread({ id: "b", latestAttentionAt: 30 }),
    makeThread({ id: "c", latestAttentionAt: 20 }),
    makeThread({ id: "gone", latestAttentionAt: 99, isArchived: true }),
    makeThread({ id: "helper", latestAttentionAt: 98, isHidden: true }),
  ];

  it("uses recency of active threads in recent mode and ignores the sidebar", () => {
    expect(
      resolveThreadOrder({ mode: "recent", domOrder: ["a", "b", "c"], threads }),
    ).toEqual({ order: ["b", "c", "a"], source: "recent" });
  });

  it("uses the sidebar order filtered to active threads in sidebar mode", () => {
    expect(
      resolveThreadOrder({
        mode: "sidebar",
        domOrder: ["c", "gone", "a", "stale", "helper", "b"],
        threads,
      }),
    ).toEqual({ order: ["c", "a", "b"], source: "sidebar" });
  });

  it("does not filter the sidebar order while the thread list is empty", () => {
    expect(
      resolveThreadOrder({ mode: "sidebar", domOrder: ["x", "y"], threads: [] }),
    ).toEqual({ order: ["x", "y"], source: "sidebar" });
  });

  it("uses the cached sidebar order when the sidebar cannot be read", () => {
    resolveThreadOrder({ mode: "sidebar", domOrder: ["c", "a", "b"], threads });
    expect(resolveThreadOrder({ mode: "sidebar", domOrder: null, threads })).toEqual({
      order: ["c", "a", "b"],
      source: "sidebar-cache",
    });
    expect(resolveThreadOrder({ mode: "sidebar", domOrder: [], threads })).toEqual({
      order: ["c", "a", "b"],
      source: "sidebar-cache",
    });
  });

  it("filters the cached order to threads that are still active", () => {
    resolveThreadOrder({ mode: "sidebar", domOrder: ["c", "a", "b"], threads });
    const later = threads.map((thread) =>
      thread.id === "a" ? { ...thread, isArchived: true } : thread,
    );
    expect(
      resolveThreadOrder({ mode: "sidebar", domOrder: null, threads: later }),
    ).toEqual({ order: ["c", "b"], source: "sidebar-cache" });
  });

  it("filters an order cached before the thread list had loaded", () => {
    resolveThreadOrder({ mode: "sidebar", domOrder: ["stale", "c", "a"], threads: [] });
    expect(resolveThreadOrder({ mode: "sidebar", domOrder: null, threads })).toEqual({
      order: ["c", "a"],
      source: "sidebar-cache",
    });
  });

  it("falls back to recency when there is no sidebar order and no cache", () => {
    expect(resolveThreadOrder({ mode: "sidebar", domOrder: null, threads })).toEqual({
      order: ["b", "c", "a"],
      source: "recent",
    });
    expect(resolveThreadOrder({ mode: "sidebar", domOrder: [], threads })).toEqual({
      order: ["b", "c", "a"],
      source: "recent",
    });
  });

  it("falls back to recency when no cached thread is active any more", () => {
    resolveThreadOrder({ mode: "sidebar", domOrder: ["a"], threads });
    const later = threads.filter((thread) => thread.id !== "a");
    expect(
      resolveThreadOrder({ mode: "sidebar", domOrder: null, threads: later }),
    ).toEqual({ order: ["b", "c"], source: "recent" });
  });

  it("falls back when the sidebar only lists threads that are not active", () => {
    expect(
      resolveThreadOrder({ mode: "sidebar", domOrder: ["gone", "stale"], threads }),
    ).toEqual({ order: ["b", "c", "a"], source: "recent" });
  });

  it("does not let recent mode or a failed read replace the cache", () => {
    resolveThreadOrder({ mode: "sidebar", domOrder: ["c", "a", "b"], threads });
    resolveThreadOrder({ mode: "recent", domOrder: ["a"], threads });
    resolveThreadOrder({ mode: "sidebar", domOrder: [], threads });
    expect(resolveThreadOrder({ mode: "sidebar", domOrder: null, threads })).toEqual({
      order: ["c", "a", "b"],
      source: "sidebar-cache",
    });
  });

  it("replaces the cache with each newer sidebar order", () => {
    resolveThreadOrder({ mode: "sidebar", domOrder: ["c", "a", "b"], threads });
    resolveThreadOrder({ mode: "sidebar", domOrder: ["b", "c"], threads });
    expect(resolveThreadOrder({ mode: "sidebar", domOrder: null, threads })).toEqual({
      order: ["b", "c"],
      source: "sidebar-cache",
    });
  });

  it("keeps the cache safe from callers that change the returned order", () => {
    const first = resolveThreadOrder({ mode: "sidebar", domOrder: ["c", "a"], threads });
    first.order.push("b");
    expect(resolveThreadOrder({ mode: "sidebar", domOrder: null, threads }).order).toEqual([
      "c",
      "a",
    ]);
  });

  it("forgets the cache after resetThreadOrderCache", () => {
    resolveThreadOrder({ mode: "sidebar", domOrder: ["c", "a", "b"], threads });
    resetThreadOrderCache();
    expect(resolveThreadOrder({ mode: "sidebar", domOrder: null, threads }).source).toBe(
      "recent",
    );
  });

  it("returns an empty order when nothing is known", () => {
    expect(resolveThreadOrder({ mode: "sidebar", domOrder: null, threads: [] })).toEqual({
      order: [],
      source: "recent",
    });
  });
});

describe("cycleThread", () => {
  const order = ["a", "b", "c"];

  it("moves to the next and previous entry", () => {
    expect(cycleThread(order, "a", 1)).toBe("b");
    expect(cycleThread(order, "b", 1)).toBe("c");
    expect(cycleThread(order, "c", -1)).toBe("b");
  });

  it("wraps at both ends", () => {
    expect(cycleThread(order, "c", 1)).toBe("a");
    expect(cycleThread(order, "a", -1)).toBe("c");
  });

  it("starts at the first or last entry when the current thread is not in the order", () => {
    expect(cycleThread(order, "elsewhere", 1)).toBe("a");
    expect(cycleThread(order, "elsewhere", -1)).toBe("c");
    expect(cycleThread(order, null, 1)).toBe("a");
    expect(cycleThread(order, null, -1)).toBe("c");
    expect(cycleThread(["only"], null, 1)).toBe("only");
    expect(cycleThread(["only"], "elsewhere", -1)).toBe("only");
  });

  it("returns null when there is nowhere to go", () => {
    expect(cycleThread([], "a", 1)).toBeNull();
    expect(cycleThread([], null, -1)).toBeNull();
    expect(cycleThread(["only"], "only", 1)).toBeNull();
    expect(cycleThread(["only"], "only", -1)).toBeNull();
  });
});

describe("lastThread", () => {
  it("is the thread at the end of the order", () => {
    expect(lastThread(["a", "b", "c"])).toBe("c");
    expect(lastThread(["a"])).toBe("a");
  });

  it("is null for an order without threads", () => {
    expect(lastThread([])).toBeNull();
  });
});

describe("nthThread", () => {
  const order = ["a", "b", "c"];

  it("is 1-based", () => {
    expect(nthThread(order, 1)).toBe("a");
    expect(nthThread(order, 3)).toBe("c");
  });

  it("returns null when the index is out of range", () => {
    expect(nthThread(order, 0)).toBeNull();
    expect(nthThread(order, 4)).toBeNull();
    expect(nthThread(order, -1)).toBeNull();
    expect(nthThread(order, 1.5)).toBeNull();
    expect(nthThread([], 1)).toBeNull();
  });
});
