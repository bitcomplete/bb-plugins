// @vitest-environment jsdom
// BB-44: the stewards sidebar thread list renders one tab per project, efforts
// grouped by the steward relationship, collapsed Watches and Recently ended
// rows, and bb's thread actions context menu on every row.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

const thread = (over: Partial<PluginSidebarThread> & { id: string }): PluginSidebarThread => ({
  projectId: "p1",
  title: over.id,
  titleFallback: null,
  displayTitle: over.id,
  parentThreadId: null,
  lifecycleOwnerThreadId: null,
  sourceThreadId: null,
  sectionId: null,
  originKind: null,
  originPluginId: null,
  providerId: "pi",
  status: "idle",
  runtimeStatus: "idle",
  queuedWork: "none",
  hasPendingInteraction: false,
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
  indicator: "none",
  indicatorLabel: null,
  isUnread: false,
  isPinned: false,
  pinnedAt: null,
  pinSortKey: null,
  isArchived: false,
  archivedAt: null,
  href: `/projects/p1/threads/${over.id}`,
  isHidden: false,
  environment: null,
  host: null,
  createdAt: 0,
  updatedAt: 0,
  lastReadAt: null,
  latestAttentionAt: 0,
  ...over,
});

const projects = [
  { id: "p1", name: "Acme", isPersonal: false, href: "/projects/p1", settingsHref: "/projects/p1/settings" },
  { id: "personal", name: "Personal", isPersonal: true, href: "/projects/personal", settingsHref: "/projects/personal/settings" },
];

const sidebarData = (over: { bindings?: unknown[]; ended?: unknown[]; projectStewardThreadId?: string | null } = {}) => ({
  projects: [
    {
      projectId: "p1",
      name: "Acme",
      projectStewardThreadId: over.projectStewardThreadId ?? null,
      bindings: over.bindings ?? [],
      ended: over.ended ?? [],
    },
  ],
});

const binding = (over: Record<string, unknown> = {}) => ({
  key: "ENG-1",
  kind: "ticket",
  stage: "build",
  threadId: "thr_steward",
  hold: null,
  blockedOn: null,
  needsUser: false,
  advancedAt: null,
  workers: [],
  reviewers: [],
  ...over,
});

let app: CapturedPluginApp | null = null;
const loadApp = async () => {
  app ??= await loadPluginApp(() => import("./app.js"));
  return app;
};

const renderSidebar = async (options: Parameters<typeof renderSlot>[2] = {}, props: Record<string, unknown> = {}): Promise<RenderedSlot> => {
  const captured = await loadApp();
  const list = captured.threadLists[0]!;
  return renderSlot(list, { activeThreadId: null, activeProjectId: "p1", isCompactViewport: false, onNavigate: () => {}, searchQuery: "", ...props }, options);
};

afterEach(() => {
  app = null;
});

describe("the stewards sidebar list (BB-44)", () => {
  it("registers exactly one sidebar thread list under the Stewards title", async () => {
    const captured = await loadApp();
    expect(captured.threadLists).toHaveLength(1);
    expect(captured.threadLists[0]).toMatchObject({ id: "sidebar", title: "Stewards" });
  });

  it("shows a tab per live project and a title-first row with the shortened key and badges", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "Fix login" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ hold: "billing freeze" })] }) } as never,
    });
    await waitFor(() => expect(slot.getByRole("option", { name: "Acme" })).toBeTruthy());
    expect(slot.getByRole("option", { name: "Personal" })).toBeTruthy();
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    // The title does not name the key, so the key shows; the stage does not.
    expect(slot.getByText("ENG-1")).toBeTruthy();
    expect(slot.queryByText("build")).toBeNull();
    expect(slot.getByText("held")).toBeTruthy();
    // The full key stays on the row's title attribute.
    expect(slot.container.querySelector('[title="ENG-1"]')).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("drops the key when the title already names it, and keeps no stage text", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "Review acme/web#612: Read dashboard metrics" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ key: "acme/web#612", stage: "review" })] }) } as never,
    });
    await waitFor(() => expect(slot.getByText("Review acme/web#612: Read dashboard metrics")).toBeTruthy());
    expect(slot.queryByText("#612", { exact: true })).toBeNull();
    expect(slot.queryByText("review", { exact: true })).toBeNull();
    expect(slot.container.querySelector('[title="acme/web#612"]')).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("shortens a pull-request key to #N when the title omits it", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "Fix login" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ key: "acme/web#612" })] }) } as never,
    });
    await waitFor(() => expect(slot.getByText("#612")).toBeTruthy());
    expect(slot.queryByText("acme/web#612", { exact: true })).toBeNull();
    expect(slot.container.querySelector('[title="acme/web#612"]')).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("does not swallow a key into a longer number in the title", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "Fix login #6123" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ key: "acme/web#612" })] }) } as never,
    });
    await waitFor(() => expect(slot.getByText("#612", { exact: true })).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("renders held and blocked badges without a stage", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "Fix login" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ hold: "waiting", blockedOn: "a review" })] }) } as never,
    });
    await waitFor(() => expect(slot.getByText("held")).toBeTruthy());
    expect(slot.getByText("blocked")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("drops the child count beside the chevron but keeps the expand aria-label", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [thread({ id: "thr_steward", displayTitle: "Fix login" }), thread({ id: "thr_worker", displayTitle: "Implement retry" })],
      },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ workers: [{ threadId: "thr_worker", title: "Implement retry" }] })] }) } as never,
    });
    const expand = await waitFor(() => slot.getByRole("button", { name: "Expand Fix login" }));
    expect(expand.textContent).toBe("");
    fireEvent.click(expand);
    await waitFor(() => expect(slot.getByText("Implement retry")).toBeTruthy());
    expect(slot.getByRole("button", { name: "Collapse Fix login" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("keeps one-off threads out of In flight, in a collapsed Threads section", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "Fix login" }), thread({ id: "thr_oneoff", displayTitle: "My notes" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding()] }) } as never,
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    const inFlight = slot.getByRole("heading", { name: /In flight/u });
    expect(inFlight.textContent).toContain("1");
    const threads = slot.getByRole("button", { name: /Threads/u });
    expect(threads.textContent).toContain("1");
    // Collapsed by default: the one-off's title is not rendered until it is opened.
    expect(slot.queryByText("My notes")).toBeNull();
    fireEvent.click(threads);
    await waitFor(() => expect(slot.getByText("My notes")).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("shows workers and reviewers only when the effort is expanded, as muted glyph tags", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [thread({ id: "thr_steward", displayTitle: "Fix login" }), thread({ id: "thr_worker", displayTitle: "Implement retry" }), thread({ id: "thr_reviewer", displayTitle: "Review the PR", parentThreadId: "thr_worker" })],
      },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            bindings: [binding({ workers: [{ threadId: "thr_worker", title: "Implement retry" }], reviewers: [{ threadId: "thr_reviewer", workerThreadId: "thr_worker" }] })],
          }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    expect(slot.queryByText("Implement retry")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /Expand Fix login/u }));
    await waitFor(() => expect(slot.getByText("Implement retry")).toBeTruthy());
    expect(slot.getByTitle("worker").textContent).toBe("W");
    fireEvent.click(slot.getByRole("button", { name: /Expand Implement retry/u }));
    await waitFor(() => expect(slot.getByText("Review the PR")).toBeTruthy());
    expect(slot.getByTitle("reviewer").textContent).toBe("R");
    slot.lifecycle.unmount();
  });

  it("wraps every row in bb's thread actions context menu", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "Fix login" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding()] }) } as never,
      threadActions: () =>
        [{ key: "archive", pluginId: "thread-list", group: "4_lifecycle", action: { label: "Archive", icon: "Archive", run: () => {} } }] as never,
    });
    await waitFor(() => expect(slot.getByText("ENG-1")).toBeTruthy());
    const menu = slot.container.querySelector('[data-testid="bb-thread-actions-context-menu"][data-thread-id="thr_steward"]');
    expect(menu).not.toBeNull();
    fireEvent.contextMenu(menu!);
    await waitFor(() => expect(slot.getByRole("menuitem", { name: "Archive" })).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("collapses Watches and Recently ended until opened", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward" }), thread({ id: "thr_ops" })] },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            bindings: [binding(), binding({ key: "acme/web", kind: "ops", stage: null, threadId: "thr_ops" })],
            ended: [{ key: "ENG-0", kind: "ticket", threadId: null, title: "Old work", endedAt: 1_000 }],
          }),
      } as never,
    });
    await waitFor(() => expect(slot.getByRole("button", { name: /Watches/u })).toBeTruthy());
    expect(slot.queryByText("acme/web")).toBeNull();
    expect(slot.queryByText("Old work")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /Watches/u }));
    await waitFor(() => expect(slot.getByText("acme/web")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: /Recently ended/u }));
    await waitFor(() => expect(slot.getByText("Old work")).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("renders the project picker at every viewport width", async () => {
    for (const isCompactViewport of [false, true]) {
      const slot = await renderSidebar(
        {
          sidebarThreads: { projects, threads: [] },
          rpc: { stewardsSidebar: () => sidebarData() } as never,
        },
        { isCompactViewport },
      );
      await waitFor(() => expect(slot.getByLabelText("Project")).toBeTruthy());
      expect(slot.queryByRole("tab")).toBeNull();
      expect(slot.getByRole("option", { name: "Acme" })).toBeTruthy();
      slot.lifecycle.unmount();
    }
  });

  it("follows activeProjectId in the picker and switches on pick without navigating", async () => {
    const slot = await renderSidebar(
      {
        sidebarThreads: { projects, threads: [thread({ id: "thr_personal", projectId: "personal", displayTitle: "My notes" })] },
        rpc: { stewardsSidebar: () => sidebarData() } as never,
      },
      { activeProjectId: "personal" },
    );
    const select = await waitFor(() => slot.getByLabelText("Project") as HTMLSelectElement);
    expect(select.value).toBe("personal");
    fireEvent.click(slot.getByRole("button", { name: /Threads/u }));
    await waitFor(() => expect(slot.getByText("My notes")).toBeTruthy());
    fireEvent.change(select, { target: { value: "p1" } });
    await waitFor(() => expect(select.value).toBe("p1"));
    expect(slot.inspection.navigateCalls).not.toContainEqual(expect.objectContaining({ method: "toProject" }));
    slot.lifecycle.unmount();
  });

  it("opens the composer on the picked project, then closes the drawer", async () => {
    let slot!: RenderedSlot;
    let composeSeenAtNavigate = false;
    const onNavigate = vi.fn(() => {
      composeSeenAtNavigate = slot.inspection.navigateCalls.some((c) => c.method === "toCompose");
    });
    slot = await renderSidebar(
      {
        sidebarThreads: { projects, threads: [] },
        rpc: { stewardsSidebar: () => sidebarData() } as never,
      },
      { onNavigate },
    );
    const select = await waitFor(() => slot.getByLabelText("Project") as HTMLSelectElement);
    fireEvent.change(select, { target: { value: "personal" } });
    await waitFor(() => expect(select.value).toBe("personal"));
    fireEvent.click(slot.getByRole("button", { name: "New thread" }));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toCompose", options: { projectId: "personal" } }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(composeSeenAtNavigate).toBe(true);
    slot.lifecycle.unmount();
  });

  it("navigates to the row's thread and calls onNavigate", async () => {
    const onNavigate = vi.fn();
    const slot = await renderSidebar(
      {
        sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "Fix login" })] },
        rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding()] }) } as never,
      },
      { onNavigate },
    );
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    fireEvent.click(slot.getByText("Fix login"));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_steward" }));
    expect(onNavigate).toHaveBeenCalled();
    slot.lifecycle.unmount();
  });
});
