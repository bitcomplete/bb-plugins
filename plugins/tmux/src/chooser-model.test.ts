import type {
  PluginSidebarProject,
  PluginSidebarSplitLayout,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { describe, expect, it } from "vitest";
import { buildChooserItems, type ChooserInput } from "./chooser-model";
import type { ChooserItem } from "./types";

function makeThread(
  overrides: Partial<PluginSidebarThread> & { id: string },
): PluginSidebarThread {
  return {
    projectId: "proj_app",
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

function makeProject(id: string, name: string): PluginSidebarProject {
  return {
    id,
    name,
    isPersonal: false,
    href: `/projects/${id}`,
    settingsHref: `/settings/projects/${id}`,
  };
}

function makeLayout(
  panes: readonly { paneId: string; threadId: string | null; isFocused?: boolean }[],
): PluginSidebarSplitLayout {
  return {
    panes: panes.map((pane, index) => ({
      paneId: pane.paneId,
      rect: { x: index / panes.length, y: 0, width: 1 / panes.length, height: 1 },
      threadId: pane.threadId,
      isFocused: pane.isFocused ?? false,
    })),
  };
}

const PROJECTS = [
  makeProject("proj_app", "Web App"),
  makeProject("proj_docs", "Docs Site"),
];

function build(overrides: Partial<ChooserInput>): ChooserItem[] {
  return buildChooserItems({
    threads: [],
    projects: PROJECTS,
    layout: null,
    contextThreadId: null,
    query: "",
    ...overrides,
  });
}

function threadIds(items: readonly ChooserItem[]): string[] {
  return items.map((item) => item.threadId);
}

function itemFor(items: readonly ChooserItem[], threadId: string): ChooserItem {
  const item = items.find((candidate) => candidate.threadId === threadId);
  if (item === undefined) throw new Error(`no chooser item for ${threadId}`);
  return item;
}

describe("buildChooserItems ordering", () => {
  it("lists active threads with the most recent activity first", () => {
    const items = build({
      threads: [
        makeThread({ id: "old", latestAttentionAt: 10 }),
        makeThread({ id: "newest", latestAttentionAt: 30 }),
        makeThread({ id: "middle", latestAttentionAt: 20 }),
      ],
    });
    expect(threadIds(items)).toEqual(["newest", "middle", "old"]);
  });

  it("puts running threads above more recent idle ones", () => {
    const items = build({
      threads: [
        makeThread({ id: "idle", latestAttentionAt: 99 }),
        makeThread({ id: "running", status: "active", latestAttentionAt: 1 }),
      ],
    });
    expect(threadIds(items)).toEqual(["running", "idle"]);
  });

  it("leaves out archived and hidden threads", () => {
    const items = build({
      threads: [
        makeThread({ id: "kept" }),
        makeThread({ id: "archived", isArchived: true, archivedAt: 1 }),
        makeThread({ id: "hidden", isHidden: true }),
      ],
    });
    expect(threadIds(items)).toEqual(["kept"]);
  });

  it("returns nothing for an empty thread list", () => {
    expect(build({ threads: [] })).toEqual([]);
  });
});

describe("buildChooserItems fields", () => {
  it("maps a thread to a full chooser item", () => {
    const items = build({
      threads: [
        makeThread({
          id: "thr_1",
          displayTitle: "Fix the login bug",
          projectId: "proj_docs",
          parentThreadId: "thr_parent",
          status: "active",
          isUnread: true,
        }),
      ],
      contextThreadId: "thr_1",
    });
    expect(items).toEqual([
      {
        threadId: "thr_1",
        title: "Fix the login bug",
        projectName: "Docs Site",
        isVisibleInPane: true,
        isFocusedPane: true,
        isChild: true,
        isRunning: true,
        isUnread: true,
      },
    ]);
  });

  it("falls back to Untitled for an empty or blank display title", () => {
    const items = build({
      threads: [
        makeThread({ id: "empty", displayTitle: "" }),
        makeThread({ id: "blank", displayTitle: "   " }),
        makeThread({ id: "named", displayTitle: "Named" }),
      ],
    });
    expect(itemFor(items, "empty").title).toBe("Untitled");
    expect(itemFor(items, "blank").title).toBe("Untitled");
    expect(itemFor(items, "named").title).toBe("Named");
  });

  it("uses null when the project is not in the project list", () => {
    const items = build({
      threads: [makeThread({ id: "orphan", projectId: "proj_unknown" })],
    });
    expect(itemFor(items, "orphan").projectName).toBeNull();
  });

  it("marks root threads, idle threads and read threads as such", () => {
    const item = itemFor(build({ threads: [makeThread({ id: "plain" })] }), "plain");
    expect(item.isChild).toBe(false);
    expect(item.isRunning).toBe(false);
    expect(item.isUnread).toBe(false);
  });

  it("marks starting and stopping threads as running", () => {
    const items = build({
      threads: [
        makeThread({ id: "starting", status: "starting" }),
        makeThread({ id: "stopping", status: "stopping" }),
        makeThread({ id: "pending", status: "pending" }),
        makeThread({ id: "error", status: "error" }),
      ],
    });
    expect(itemFor(items, "starting").isRunning).toBe(true);
    expect(itemFor(items, "stopping").isRunning).toBe(true);
    expect(itemFor(items, "pending").isRunning).toBe(false);
    expect(itemFor(items, "error").isRunning).toBe(false);
  });
});

describe("buildChooserItems pane marks", () => {
  const threads = [
    makeThread({ id: "left" }),
    makeThread({ id: "right" }),
    makeThread({ id: "closed" }),
  ];

  it("marks the threads shown in panes and the focused pane's thread", () => {
    const items = build({
      threads,
      layout: makeLayout([
        { paneId: "pane-1", threadId: "left" },
        { paneId: "pane-2", threadId: "right", isFocused: true },
      ]),
      contextThreadId: "right",
    });
    expect(itemFor(items, "left")).toMatchObject({
      isVisibleInPane: true,
      isFocusedPane: false,
    });
    expect(itemFor(items, "right")).toMatchObject({
      isVisibleInPane: true,
      isFocusedPane: true,
    });
    expect(itemFor(items, "closed")).toMatchObject({
      isVisibleInPane: false,
      isFocusedPane: false,
    });
  });

  it("marks no thread as focused when the focused pane shows no thread", () => {
    const items = build({
      threads,
      layout: makeLayout([
        { paneId: "pane-1", threadId: "left" },
        { paneId: "pane-2", threadId: null, isFocused: true },
      ]),
      contextThreadId: null,
    });
    expect(items.filter((item) => item.isFocusedPane)).toEqual([]);
    expect(threadIds(items.filter((item) => item.isVisibleInPane))).toEqual(["left"]);
  });

  it("trusts the layout over the context thread when there is a split", () => {
    const items = build({
      threads,
      layout: makeLayout([
        { paneId: "pane-1", threadId: "left", isFocused: true },
        { paneId: "pane-2", threadId: null },
      ]),
      contextThreadId: "closed",
    });
    expect(itemFor(items, "closed")).toMatchObject({
      isVisibleInPane: false,
      isFocusedPane: false,
    });
    expect(itemFor(items, "left").isFocusedPane).toBe(true);
  });

  it("uses the context thread as the only visible pane without a split", () => {
    const items = build({ threads, layout: null, contextThreadId: "left" });
    expect(itemFor(items, "left")).toMatchObject({
      isVisibleInPane: true,
      isFocusedPane: true,
    });
    expect(itemFor(items, "right")).toMatchObject({
      isVisibleInPane: false,
      isFocusedPane: false,
    });
  });

  it("marks nothing without a split and without a context thread", () => {
    const items = build({ threads, layout: null, contextThreadId: null });
    expect(items.some((item) => item.isVisibleInPane || item.isFocusedPane)).toBe(
      false,
    );
  });
});

describe("buildChooserItems query", () => {
  const threads = [
    makeThread({
      id: "login",
      displayTitle: "Fix Login Redirect",
      projectId: "proj_app",
      latestAttentionAt: 30,
    }),
    makeThread({
      id: "guide",
      displayTitle: "Write the install guide",
      projectId: "proj_docs",
      latestAttentionAt: 20,
    }),
    makeThread({
      id: "untitled",
      displayTitle: "",
      projectId: "proj_unknown",
      latestAttentionAt: 10,
    }),
  ];

  it("keeps everything for an empty or blank query", () => {
    expect(threadIds(build({ threads, query: "" }))).toEqual([
      "login",
      "guide",
      "untitled",
    ]);
    expect(threadIds(build({ threads, query: "   " }))).toHaveLength(3);
  });

  it("matches the title without regard to case", () => {
    expect(threadIds(build({ threads, query: "LOGIN" }))).toEqual(["login"]);
    expect(threadIds(build({ threads, query: "install" }))).toEqual(["guide"]);
  });

  it("matches the project name", () => {
    expect(threadIds(build({ threads, query: "docs" }))).toEqual(["guide"]);
    expect(threadIds(build({ threads, query: "web app" }))).toEqual(["login"]);
  });

  it("needs every term, each in the title or the project name", () => {
    expect(threadIds(build({ threads, query: "guide docs" }))).toEqual(["guide"]);
    expect(threadIds(build({ threads, query: "  redirect   web " }))).toEqual([
      "login",
    ]);
    expect(build({ threads, query: "login docs" })).toEqual([]);
  });

  it("does not match across the gap between the title and the project name", () => {
    expect(build({ threads, query: "redirectweb" })).toEqual([]);
  });

  it("matches the Untitled fallback title", () => {
    expect(threadIds(build({ threads, query: "untitled" }))).toEqual(["untitled"]);
  });

  it("keeps the recency order among matches", () => {
    expect(threadIds(build({ threads, query: "i" }))).toEqual([
      "login",
      "guide",
      "untitled",
    ]);
  });

  it("returns nothing when no thread matches", () => {
    expect(build({ threads, query: "zzz" })).toEqual([]);
  });
});
