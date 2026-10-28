// @vitest-environment jsdom
// BB-44/BB-76: the stewards sidebar thread list renders one tab per project,
// two-line effort rows with the four glyphs, inline needs-you actions, and the
// Blocked / In flight / Threads / Monitors / Recently ended sections.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { PROJECT_CHANGED } from "./channels.js";
import { setBoardRoute } from "./board-route.js";
import { rowRenderCounts } from "./app.js";

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

const sidebarData = (over: { bindings?: unknown[]; ended?: unknown[]; needs?: unknown; projectStewardThreadId?: string | null } = {}) => ({
  projects: [
    {
      projectId: "p1",
      name: "Acme",
      projectStewardThreadId: over.projectStewardThreadId ?? null,
      needs: over.needs ?? { count: 0, items: [] },
      bindings: over.bindings ?? [],
      ended: over.ended ?? [],
    },
  ],
});

const binding = (over: Record<string, unknown> = {}) => ({
  key: "ENG-1",
  kind: "ticket",
  stage: "build",
  phase: null,
  threadId: "thr_steward",
  hold: null,
  holdBehind: [],
  blockedOn: null,
  needsUser: false,
  stuck: false,
  status: null,
  deployment: null,
  pending: [],
  requeueAt: null,
  advancedAt: null,
  workers: [],
  reviewers: [],
  ...over,
});

const questionItem = (over: Record<string, unknown> = {}) => ({
  type: "question",
  id: "qst_1",
  question: "Stack or hold?",
  context: null,
  choices: [],
  key: "ENG-1",
  bindingKey: "ENG-1",
  url: null,
  escalationId: null,
  createdAt: 0,
  rationaleWanted: null,
  ...over,
});

const needItem = (over: Record<string, unknown> = {}) => ({
  type: "need",
  id: "need_1",
  bindingId: "b1",
  key: "ENG-1",
  bindingKey: "ENG-1",
  kind: "approve-pr",
  url: "https://github.com/acme/web/pull/1",
  entityUrl: "https://github.com/acme/web/pull/1",
  escalationId: null,
  choices: [],
  lessonId: null,
  what: "Approve the pull request",
  how: null,
  destination: null,
  threadId: null,
  createdAt: 0,
  actionable: true,
  why: null,
  ...over,
});

const withUserItem = (over: Record<string, unknown> = {}) => ({
  type: "withUser",
  id: "esc_1",
  kind: "blocked",
  question: "Need cluster access",
  context: null,
  recommendation: null,
  key: "ENG-1",
  bindingKey: "ENG-1",
  url: null,
  threadId: null,
  createdAt: 0,
  rationaleWanted: null,
  ...over,
});

const lineTwo = (slot: RenderedSlot, title: string): string => slot.getByText(title).closest("li")!.querySelector("[data-sidebar-line-two]")!.textContent ?? "";

const glyphOf = (slot: RenderedSlot, title: string): string | null => slot.getByText(title).closest("li")!.querySelector("[data-steward-glyph]")?.getAttribute("data-steward-glyph") ?? null;

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
  setBoardRoute({ projectId: null, key: null });
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

describe("the stewards sidebar list (BB-44)", () => {
  it("registers exactly one sidebar thread list under the Stewards title", async () => {
    const captured = await loadApp();
    expect(captured.threadLists).toHaveLength(1);
    expect(captured.threadLists[0]).toMatchObject({ id: "sidebar", title: "Stewards" });
  });

  it("shows a tab per live project and a two-line effort row with key, title, kind, phase and phrase", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => sidebarData({ bindings: [binding({ phase: "In Review", status: { actor: "steward", nextAction: "wait for the review", at: 1 } })] }),
      } as never,
    });
    await waitFor(() => expect(slot.getByRole("option", { name: "Acme" })).toBeTruthy());
    expect(slot.getByRole("option", { name: "Personal" })).toBeTruthy();
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    // Line one: the shortened key and the title, the key stripped from the title.
    expect(slot.getByText("ENG-1")).toBeTruthy();
    expect(slot.container.querySelector('[title="ENG-1"]')).not.toBeNull();
    // Line two: kind, phase, phrase; no stage text anywhere.
    expect(lineTwo(slot, "Fix login")).toBe("ticket · In Review · wait for the review");
    expect(slot.queryByText("build")).toBeNull();
    slot.lifecycle.unmount();
  });

  // BB-84: a truncated title is still readable on hover, through the native
  // `title` tooltip on the row's title anchor.
  it("puts the thread's full display title on the row's title anchor as a tooltip", async () => {
    const plainTitle = "A one-off thread whose long title the sidebar truncates";
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }), thread({ id: "thr_oneoff", displayTitle: plainTitle })],
      },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding()] }) } as never,
    });
    // The effort row's own title anchor carries the full title.
    const effortAnchor = (await waitFor(() => slot.getByText("Fix login"))).closest("a")!;
    expect(effortAnchor.getAttribute("title")).toBe("ENG-1: Fix login");
    // So does a plain thread row's title anchor.
    fireEvent.click(slot.getByRole("button", { name: /Threads/u }));
    const plainAnchor = (await waitFor(() => slot.getByText(plainTitle))).closest("a")!;
    expect(plainAnchor.getAttribute("title")).toBe(plainTitle);
    slot.lifecycle.unmount();
  });

  it("shortens a pull-request key to #N and spells out the kind", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "acme/web#612: Read dashboard metrics" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ key: "acme/web#612", kind: "pr", phase: "open" })] }) } as never,
    });
    await waitFor(() => expect(slot.getByText("#612")).toBeTruthy());
    expect(slot.queryByText("acme/web#612", { exact: true })).toBeNull();
    expect(lineTwo(slot, "Read dashboard metrics")).toBe("pull request · open · no report yet");
    slot.lifecycle.unmount();
  });

  it("shows kind only for an ops binding, with no phase", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_ops", displayTitle: "Ops watch: acme/web" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ key: "acme/web", kind: "ops", stage: null, threadId: "thr_ops", status: { actor: "steward", nextAction: "watching", at: 1 } })] }) } as never,
    });
    const monitors = await waitFor(() => slot.getByRole("button", { name: /Monitors/u }));
    fireEvent.click(monitors);
    await waitFor(() => expect(slot.getByText("Ops watch: acme/web")).toBeTruthy());
    expect(lineTwo(slot, "Ops watch: acme/web")).toBe("ops · watching");
    slot.lifecycle.unmount();
  });

  it("drops the child count beside the chevron but keeps the expand aria-label", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }), thread({ id: "thr_worker", displayTitle: "Implement retry" })],
      },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ workers: [{ threadId: "thr_worker", title: "Implement retry", status: "running" }] })] }) } as never,
    });
    const expand = await waitFor(() => slot.getByRole("button", { name: "Expand ENG-1: Fix login" }));
    expect(expand.textContent).toBe("");
    fireEvent.click(expand);
    await waitFor(() => expect(slot.getByText("Implement retry")).toBeTruthy());
    expect(slot.getByRole("button", { name: "Collapse ENG-1: Fix login" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows workers and reviewers only when the effort is expanded, with no role tag and the one-off glyphs", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }), thread({ id: "thr_worker", displayTitle: "Implement retry", status: "active" }), thread({ id: "thr_reviewer", displayTitle: "Review the PR", parentThreadId: "thr_worker" })],
      },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            bindings: [binding({ workers: [{ threadId: "thr_worker", title: "Implement retry", status: "running" }], reviewers: [{ threadId: "thr_reviewer", workerThreadId: "thr_worker" }] })],
          }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    // BB-91: the worker list stays mounted and clips to `0fr` while collapsed.
    const workers = slot.getByText("Fix login").closest("li")!.querySelector("[data-sidebar-workers]")!;
    expect(workers.className).toContain("grid-rows-[0fr]");
    fireEvent.click(slot.getByRole("button", { name: /Expand ENG-1: Fix login/u }));
    await waitFor(() => expect(slot.getByText("Implement retry")).toBeTruthy());
    expect(workers.className).toContain("grid-rows-[1fr]");
    // No W/R badge: nothing in the row names the role.
    expect(slot.queryByTitle("worker")).toBeNull();
    expect(slot.queryByTitle("reviewer")).toBeNull();
    // The busy worker pulses blue; the quiet reviewer is a grey ring.
    expect(glyphOf(slot, "Implement retry")).toBe("running");
    fireEvent.click(slot.getByRole("button", { name: /Expand Implement retry/u }));
    await waitFor(() => expect(slot.getByText("Review the PR")).toBeTruthy());
    expect(glyphOf(slot, "Review the PR")).toBe("quiet");
    slot.lifecycle.unmount();
  });

  it("gives worker, reviewer and one-off child rows the same one-off glyphs", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [
          thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }),
          thread({ id: "thr_unread_worker", displayTitle: "Unread worker", isUnread: true }),
          thread({ id: "thr_busy_reviewer", displayTitle: "Busy reviewer", parentThreadId: "thr_unread_worker", status: "active" }),
          thread({ id: "thr_parent", displayTitle: "One-off parent" }),
          thread({ id: "thr_idle_child", displayTitle: "Idle child", parentThreadId: "thr_parent" }),
          thread({ id: "thr_draft_child", displayTitle: "Draft child", parentThreadId: "thr_parent", indicator: "draft" }),
        ],
      },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            bindings: [
              binding({
                workers: [{ threadId: "thr_unread_worker", title: "Unread worker", status: "finished" }],
                reviewers: [{ threadId: "thr_busy_reviewer", workerThreadId: "thr_unread_worker" }],
              }),
            ],
          }),
      } as never,
    });
    // An unread worker is the yellow dot even with no running worker; its busy
    // reviewer is the pulsing blue ring. BB-80: the unread worker opens the
    // effort by default, so there is no Expand click here.
    await waitFor(() => expect(slot.getByText("Unread worker")).toBeTruthy());
    expect(slot.getByRole("button", { name: /Collapse ENG-1: Fix login/u })).toBeTruthy();
    expect(glyphOf(slot, "Unread worker")).toBe("you");
    fireEvent.click(slot.getByRole("button", { name: /Expand Unread worker/u }));
    await waitFor(() => expect(slot.getByText("Busy reviewer")).toBeTruthy());
    expect(glyphOf(slot, "Busy reviewer")).toBe("running");
    // A one-off thread's children share the glyphs: idle grey, draft bb's own.
    fireEvent.click(slot.getByRole("button", { name: /Threads/u }));
    fireEvent.click(await waitFor(() => slot.getByRole("button", { name: /Expand One-off parent/u })));
    await waitFor(() => expect(slot.getByText("Idle child")).toBeTruthy());
    expect(glyphOf(slot, "Idle child")).toBe("quiet");
    expect(glyphOf(slot, "Draft child")).toBeNull();
    expect(slot.container.querySelector('[data-thread-status-glyph="draft"]')).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("wraps every row in bb's thread actions context menu", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
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

  it("collapses Monitors and Recently ended until opened", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward" }), thread({ id: "thr_ops" })] },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            bindings: [binding(), binding({ key: "acme/web", kind: "ops", stage: null, threadId: "thr_ops" })],
            ended: [{ key: "ENG-0", kind: "ticket", threadId: null, title: "Old work", phase: "Done", endReason: "terminal", endedAt: 1_000 }],
          }),
      } as never,
    });
    await waitFor(() => expect(slot.getByRole("button", { name: /Monitors/u })).toBeTruthy());
    // BB-91: a collapsed section stays mounted and clips to `0fr`, so the
    // expand/collapse can ease; the rows are present but clipped.
    const monitors = slot.getByRole("button", { name: /Monitors/u }).closest("section")!;
    const ended = slot.getByRole("button", { name: /Recently ended/u }).closest("section")!;
    expect(monitors.querySelector("[data-sidebar-collapsible]")!.className).toContain("grid-rows-[0fr]");
    expect(ended.querySelector("[data-sidebar-collapsible]")!.className).toContain("grid-rows-[0fr]");
    fireEvent.click(slot.getByRole("button", { name: /Monitors/u }));
    await waitFor(() => expect(monitors.querySelector("[data-sidebar-collapsible]")!.className).toContain("grid-rows-[1fr]"));
    fireEvent.click(slot.getByRole("button", { name: /Recently ended/u }));
    await waitFor(() => expect(ended.querySelector("[data-sidebar-collapsible]")!.className).toContain("grid-rows-[1fr]"));
    const old = await waitFor(() => slot.getByText("Old work"));
    // BB-88: the same two-line effort row as a live binding, the end reason in
    // the phrase slot, the grey quiet ring, and the ended stamp on the right.
    expect(lineTwo(slot, "Old work")).toBe("ticket · Done · terminal");
    expect(glyphOf(slot, "Old work")).toBe("quiet");
    expect(old.closest("li")!.textContent).toMatch(/ago/u);
    expect(old.closest("a")!.getAttribute("href")).toContain("/board/p1/ENG-0");
    slot.lifecycle.unmount();
  });

  // BB-88 criterion 1: an ended binding whose steward thread is still in the
  // live view renders through SidebarEffortRow, title stripped of the key.
  it("renders a Recently ended binding with a live thread as the two-line effort row", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_old", displayTitle: "ENG-0: Old work" })] },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({ ended: [{ key: "ENG-0", kind: "ticket", threadId: "thr_old", title: "Old work", phase: "Done", endReason: "terminal", endedAt: Date.now() - 2 * 86_400_000 }] }),
      } as never,
    });
    fireEvent.click(await waitFor(() => slot.getByRole("button", { name: /Recently ended/u })));
    const old = await waitFor(() => slot.getByText("Old work"));
    expect(lineTwo(slot, "Old work")).toBe("ticket · Done · terminal");
    expect(glyphOf(slot, "Old work")).toBe("quiet");
    expect(old.closest("li")!.textContent).toMatch(/2d ago/u);
    expect(old.closest("a")!.getAttribute("href")).toContain("/board/p1/ENG-0");
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

  it("draws a custom chevron on the project picker instead of the native arrow", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [] },
      rpc: { stewardsSidebar: () => sidebarData() } as never,
    });
    const select = await waitFor(() => slot.getByLabelText("Project") as HTMLSelectElement);
    expect(select.className).toContain("appearance-none");
    expect(select.className).toContain("pr-7");
    expect(select.closest(".relative")).not.toBeNull();
    const chevron = slot.container.querySelector('[data-icon="ChevronDown"]');
    expect(chevron).not.toBeNull();
    expect(chevron!.className).toContain("pointer-events-none");
    expect(chevron!.className).toContain("text-muted-foreground");
    expect(chevron!.getAttribute("aria-hidden")).toBe("true");
    slot.lifecycle.unmount();
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

  it("opens a stewarded effort's detail view as a real link and calls onNavigate", async () => {
    const onNavigate = vi.fn();
    const slot = await renderSidebar(
      {
        sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
        rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding()] }) } as never,
      },
      { onNavigate },
    );
    const row = await waitFor(() => slot.getByText("Fix login"));
    expect(row.closest("a")!.getAttribute("href")).toBe("/plugins/test-plugin/board/p1/ENG-1");
    fireEvent.click(row);
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "board", options: { subPath: "p1/ENG-1" } }));
    expect(onNavigate).toHaveBeenCalled();
    slot.lifecycle.unmount();
  });

  it("still opens a worker, a one-off thread and the project steward row's thread", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [
          thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }),
          thread({ id: "thr_worker", displayTitle: "Implement retry", status: "active" }),
          thread({ id: "thr_oneoff", displayTitle: "A one-off thread" }),
          thread({ id: "thr_p", displayTitle: "Acme project steward" }),
        ],
      },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            projectStewardThreadId: "thr_p",
            bindings: [binding({ workers: [{ threadId: "thr_worker", title: "Implement retry", status: "running" }] })],
          }),
      } as never,
    });
    // The worker under the effort.
    fireEvent.click(await waitFor(() => slot.getByRole("button", { name: /Expand ENG-1: Fix login/u })));
    fireEvent.click(await waitFor(() => slot.getByText("Implement retry")));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_worker" }));
    // A one-off thread in the Threads section.
    fireEvent.click(slot.getByRole("button", { name: /Threads/u }));
    fireEvent.click(await waitFor(() => slot.getByText("A one-off thread")));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_oneoff" }));
    // The project steward footer row.
    fireEvent.click(await waitFor(() => slot.getByText("Acme project steward")));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_p" }));
    slot.lifecycle.unmount();
  });
});

describe("the stewards sidebar sections, glyphs and phrases (BB-76)", () => {
  it("puts a needs-you effort at the top of Blocked with a yellow dot and its phrase, not in In flight", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ needsUser: true, phase: "In Review" })] }) } as never,
    });
    await waitFor(() => expect(slot.getByRole("heading", { name: /Blocked/u })).toBeTruthy());
    expect(lineTwo(slot, "Fix login")).toBe("ticket · In Review · needs you");
    expect(glyphOf(slot, "Fix login")).toBe("you");
    // The picker counts the yellow rows.
    expect(slot.getByRole("option", { name: "Acme (1)" })).toBeTruthy();
    // No separate Needs you section remains.
    expect(slot.queryByRole("heading", { name: /Needs you/u })).toBeNull();
    // The In flight section is empty.
    expect(slot.getByRole("heading", { name: /In flight/u }).textContent).toContain("0");
    slot.lifecycle.unmount();
  });

  it("puts a blocked effort in Blocked with a red ring and the rule's phrase", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ blockedOn: "bb-gate#88", phase: "In Progress" })] }) } as never,
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    expect(lineTwo(slot, "Fix login")).toBe("ticket · In Progress · blocked on bb-gate#88");
    expect(glyphOf(slot, "Fix login")).toBe("blocked");
    expect(slot.getByRole("heading", { name: /In flight/u }).textContent).toContain("0");
    slot.lifecycle.unmount();
  });

  it("shows held-behind and stuck as blocked", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_a", displayTitle: "ENG-1: A" }), thread({ id: "thr_b", displayTitle: "ENG-2: B" })] },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            bindings: [binding({ key: "ENG-1", threadId: "thr_a", hold: "a freeze", holdBehind: ["ENG-9"] }), binding({ key: "ENG-2", threadId: "thr_b", stuck: true })],
          }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText("A")).toBeTruthy());
    expect(lineTwo(slot, "A")).toContain("held behind ENG-9");
    expect(lineTwo(slot, "B")).toContain("stuck");
    expect(glyphOf(slot, "A")).toBe("blocked");
    expect(glyphOf(slot, "B")).toBe("blocked");
    slot.lifecycle.unmount();
  });

  // BB-81: an external wait is not a block. One row of each kind lands in the
  // section its kind and state call for.
  it("files one row of each kind into its section: blocked yellow and red, in flight, a monitor and a thread", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [
          thread({ id: "thr_you", displayTitle: "ENG-1: Needs you" }),
          thread({ id: "thr_blocked", displayTitle: "ENG-2: Red row" }),
          thread({ id: "thr_wait_ticket", displayTitle: "ENG-3: Waiting ticket" }),
          thread({ id: "thr_wait_ops", displayTitle: "Ops watch: acme/web" }),
          thread({ id: "thr_oneoff", displayTitle: "One-off" }),
        ],
      },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            bindings: [
              binding({ key: "ENG-1", threadId: "thr_you", needsUser: true }),
              binding({ key: "ENG-2", threadId: "thr_blocked", blockedOn: "a review" }),
              binding({ key: "ENG-3", threadId: "thr_wait_ticket", status: { actor: "other", nextAction: "an author push", at: 1 } }),
              binding({ key: "acme/web", threadId: "thr_wait_ops", kind: "ops", stage: null, status: { actor: "other", nextAction: "Next scheduled look", at: 1 } }),
            ],
          }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText("Needs you")).toBeTruthy());
    // Blocked holds the yellow needs-you and the red blockedOn row, not the wait.
    const blocked = slot.getByRole("heading", { name: /Blocked/u }).closest("section")!;
    expect(blocked.textContent).toContain("Needs you");
    expect(blocked.textContent).toContain("Red row");
    expect(blocked.textContent).not.toContain("Waiting ticket");
    expect(glyphOf(slot, "Needs you")).toBe("you");
    expect(glyphOf(slot, "Red row")).toBe("blocked");
    // In flight holds the waiting ticket, grey, with the wait phrase.
    const inflight = slot.getByRole("heading", { name: /In flight/u }).closest("section")!;
    expect(inflight.textContent).toContain("Waiting ticket");
    expect(inflight.textContent).not.toContain("Needs you");
    expect(glyphOf(slot, "Waiting ticket")).toBe("quiet");
    expect(lineTwo(slot, "Waiting ticket")).toBe("ticket · an author push");
    // Monitors holds the ops wait, grey, once opened.
    fireEvent.click(slot.getByRole("button", { name: /Monitors/u }));
    await waitFor(() => expect(slot.getByText("Ops watch: acme/web")).toBeTruthy());
    // Threads holds the one-off thread.
    fireEvent.click(slot.getByRole("button", { name: /Threads/u }));
    await waitFor(() => expect(slot.getByText("One-off")).toBeTruthy());
    // Both collapsibles now show their rows in their own sections.
    const monitors = slot.getByRole("button", { name: /Monitors/u }).closest("section")!;
    expect(monitors.textContent).toContain("Ops watch: acme/web");
    expect(glyphOf(slot, "Ops watch: acme/web")).toBe("quiet");
    expect(lineTwo(slot, "Ops watch: acme/web")).toBe("ops · Next scheduled look");
    const threads = slot.getByRole("button", { name: /Threads/u }).closest("section")!;
    expect(threads.textContent).toContain("One-off");
    slot.lifecycle.unmount();
  });

  it("shows a running effort in In flight with a blue animated ring and a running-worker count", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            bindings: [
              binding({
                phase: "In Review",
                workers: [
                  { threadId: "thr_w1", title: "w1", status: "running" },
                  { threadId: "thr_w2", title: "w2", status: "running" },
                  { threadId: "thr_w3", title: "w3", status: "finished" },
                ],
              }),
            ],
          }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    expect(lineTwo(slot, "Fix login")).toBe("ticket · In Review · 2 workers running");
    expect(glyphOf(slot, "Fix login")).toBe("running");
    const glyph = slot.container.querySelector('[data-steward-glyph="running"]')!;
    expect(glyph.className).toContain("motion-safe:animate-pulse");
    slot.lifecycle.unmount();
  });

  it("shows a quiet effort in In flight with a grey ring and the next action", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ status: { actor: "steward", nextAction: "wait for CI", at: 1 } })] }) } as never,
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    expect(lineTwo(slot, "Fix login")).toBe("ticket · wait for CI");
    expect(glyphOf(slot, "Fix login")).toBe("quiet");
    slot.lifecycle.unmount();
  });

  it("shows a quiet worker finish and the next look over a stale summary (BB-83)", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            bindings: [
              binding({
                status: { actor: "steward", nextAction: "the worker has started", at: 1 },
                pending: [{ text: 'Worker "ENG-1: Implement" finished its turn.', quiet: true }],
                requeueAt: Date.now() + 12 * 60_000,
              }),
            ],
          }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    expect(lineTwo(slot, "Fix login")).toBe("ticket · worker finished, next look 12m");
    expect(glyphOf(slot, "Fix login")).toBe("quiet");
    slot.lifecycle.unmount();
  });

  it("shows a deployment watch's state as the phrase", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ deployment: "deployed" })] }) } as never,
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    expect(lineTwo(slot, "Fix login")).toBe("ticket · deployed");
    expect(glyphOf(slot, "Fix login")).toBe("quiet");
    slot.lifecycle.unmount();
  });

  it("shows yellow, blue and grey one-off thread glyphs, keeping bb's draft glyph", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [
          thread({ id: "thr_unread", displayTitle: "Unread reply", indicator: "unread-success" }),
          thread({ id: "thr_running", displayTitle: "Running agent", status: "active" }),
          thread({ id: "thr_quiet", displayTitle: "Read and idle" }),
          thread({ id: "thr_draft", displayTitle: "Has a draft", indicator: "draft" }),
        ],
      },
      rpc: { stewardsSidebar: () => sidebarData() } as never,
    });
    // BB-80: the unread one-off opens the Threads section by default.
    await waitFor(() => expect(slot.getByRole("button", { name: /Threads/u }).closest("section")!.querySelector("[data-sidebar-collapsible]")!.className).toContain("grid-rows-[1fr]"));
    await waitFor(() => expect(slot.getByText("Unread reply")).toBeTruthy());
    expect(glyphOf(slot, "Unread reply")).toBe("you");
    expect(glyphOf(slot, "Running agent")).toBe("running");
    expect(glyphOf(slot, "Read and idle")).toBe("quiet");
    // A draft keeps bb's own glyph, not the four-glyph component.
    expect(glyphOf(slot, "Has a draft")).toBeNull();
    expect(slot.container.querySelector('[data-thread-status-glyph="draft"]')).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps an ops binding out of Monitors when it is blocked, and shows it in Blocked", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_ops", displayTitle: "Ops watch: acme/web" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ key: "acme/web", kind: "ops", stage: null, threadId: "thr_ops", blockedOn: "a rotation" })] }) } as never,
    });
    await waitFor(() => expect(slot.getByRole("heading", { name: /Blocked/u })).toBeTruthy());
    expect(slot.getByText("Ops watch: acme/web")).toBeTruthy();
    expect(glyphOf(slot, "Ops watch: acme/web")).toBe("blocked");
    expect(slot.queryByRole("button", { name: /Monitors/u })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("gives the project steward footer row a grey ring", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_p", displayTitle: "Acme project steward" })] },
      rpc: { stewardsSidebar: () => sidebarData({ projectStewardThreadId: "thr_p" }) } as never,
    });
    await waitFor(() => expect(slot.getByText("Acme project steward")).toBeTruthy());
    expect(glyphOf(slot, "Acme project steward")).toBe("quiet");
    slot.lifecycle.unmount();
  });
});

describe("the inline needs-you actions (BB-76)", () => {
  it("renders a fixed-choice question's buttons and answers through stewardsAnswerQuestion", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            bindings: [binding({ needsUser: true })],
            needs: { count: 1, items: [questionItem({ choices: ["Stack", "Hold"], question: "Stacked on BB-57. Merge order?" })] },
          }),
        stewardsAnswerQuestion: () => ({ ok: true, message: "closed" }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText("Stacked on BB-57. Merge order?")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Stack" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "stewardsAnswerQuestion", input: { questionId: "qst_1", answer: null, choice: "Stack" } }));
    slot.lifecycle.unmount();
  });

  it("renders a decide need's choices and sends them through stewardsNeedAction choose", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            bindings: [binding({ needsUser: true })],
            needs: { count: 1, items: [needItem({ kind: "decide", choices: ["Merge", "Close"], what: "Merge or close?" })] },
          }),
        stewardsNeedAction: () => ({ ok: true, message: "done" }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText("Merge or close?")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "stewardsNeedAction", input: { needId: "need_1", action: "choose", note: null, choice: "Merge" } }));
    slot.lifecycle.unmount();
  });

  it("renders an approve-pr need's Open PR / Approve / Details and approves in one click", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => sidebarData({ bindings: [binding({ needsUser: true })], needs: { count: 1, items: [needItem()] } }),
        stewardsNeedAction: () => ({ ok: true, message: "done" }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText("Approve the pull request")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "stewardsNeedAction", input: { needId: "need_1", action: "approve", note: null, choice: null } }));
    fireEvent.click(slot.getByRole("button", { name: "Open PR" }));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: "https://github.com/acme/web/pull/1" }));
    slot.lifecycle.unmount();
  });

  it("renders a with-user escalation's prompt with no one-click buttons", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => sidebarData({ bindings: [binding({ needsUser: true })], needs: { count: 1, items: [withUserItem()] } }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText("Need cluster access")).toBeTruthy());
    // A with-user escalation has no choices and is not an approve-pr or merge,
    // so its prompt is one line (BB-79) and the row itself is the detail (BB-85).
    expect(slot.getByText("Need cluster access").className).toContain("line-clamp-1");
    expect(slot.queryByRole("button", { name: "Details" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Approve" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("clamps a choice question's prompt to three lines with the full text on title", async () => {
    const long = "A long forwarded prompt that would otherwise fill the sidebar. ".repeat(6).trim();
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => sidebarData({ bindings: [binding({ needsUser: true })], needs: { count: 1, items: [questionItem({ choices: ["Stack", "Hold"], question: long })] } }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText(long)).toBeTruthy());
    const prompt = slot.getByText(long);
    expect(prompt.className).toContain("line-clamp-3");
    expect(prompt.getAttribute("title")).toBe(long);
    slot.lifecycle.unmount();
  });

  it("clamps a free-text question's prompt to one line and never shows its context", async () => {
    const long = "A free-text question the sidebar cannot answer, so one line only. ".repeat(6).trim();
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => sidebarData({ bindings: [binding({ needsUser: true })], needs: { count: 1, items: [questionItem({ question: long, context: "The evidence and reasoning the sidebar must never show." })] } }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText(long)).toBeTruthy());
    const prompt = slot.getByText(long);
    expect(prompt.className).toContain("line-clamp-1");
    expect(prompt.getAttribute("title")).toBe(long);
    expect(slot.queryByText(/The evidence and reasoning the sidebar must never show/u)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps an approve-pr need's prompt at three lines", async () => {
    const long = "Approve the pull request, which needs the full three lines. ".repeat(4).trim();
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => sidebarData({ bindings: [binding({ needsUser: true })], needs: { count: 1, items: [needItem({ what: long })] } }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText(long)).toBeTruthy());
    expect(slot.getByText(long).className).toContain("line-clamp-3");
    slot.lifecycle.unmount();
  });

  it("shows the server's refusal in the row and re-enables the buttons", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => sidebarData({ bindings: [binding({ needsUser: true })], needs: { count: 1, items: [needItem()] } }),
        stewardsNeedAction: () => ({ ok: false, message: "the owner must approve first" }),
      } as never,
    });
    fireEvent.click(await waitFor(() => slot.getByRole("button", { name: "Approve" })));
    await waitFor(() => expect(slot.getByText("the owner must approve first")).toBeTruthy());
    expect((slot.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
    slot.lifecycle.unmount();
  });

  it("refetches after an action so the row updates without a reload", async () => {
    let calls = 0;
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => {
          calls += 1;
          return sidebarData({
            bindings: [binding({ needsUser: calls === 1 })],
            needs: calls === 1 ? { count: 1, items: [questionItem({ choices: ["Stack", "Hold"] })] } : { count: 0, items: [] },
          });
        },
        stewardsAnswerQuestion: () => ({ ok: true, message: "closed" }),
      } as never,
    });
    await waitFor(() => expect(slot.getByRole("button", { name: "Stack" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Stack" }));
    await waitFor(() => expect(slot.queryByRole("button", { name: "Stack" })).toBeNull());
    expect(calls).toBeGreaterThan(1);
    slot.lifecycle.unmount();
  });
});

// BB-85: navigation highlighting and auto-expand.
describe("the sidebar's highlighting and auto-expand (BB-85)", () => {
  it("expands a collapsed effort and highlights the worker whose thread page is showing", async () => {
    const slot = await renderSidebar(
      {
        sidebarThreads: {
          projects,
          threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }), thread({ id: "thr_worker", displayTitle: "Implement retry", status: "active" })],
        },
        rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ workers: [{ threadId: "thr_worker", title: "Implement retry", status: "running" }] })] }) } as never,
      },
      { activeThreadId: "thr_worker" },
    );
    const worker = await waitFor(() => slot.getByText("Implement retry"));
    expect(worker.closest("a")!.getAttribute("aria-current")).toBe("page");
    expect(worker.closest("a")!.parentElement!.className).toContain("bg-state-active");
    slot.lifecycle.unmount();
  });

  it("expands a collapsed effort and highlights a reviewer nested under its worker", async () => {
    const slot = await renderSidebar(
      {
        sidebarThreads: {
          projects,
          threads: [
            thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }),
            thread({ id: "thr_worker", displayTitle: "Implement retry", status: "active" }),
            thread({ id: "thr_reviewer", displayTitle: "Review the PR", parentThreadId: "thr_worker" }),
          ],
        },
        rpc: {
          stewardsSidebar: () =>
            sidebarData({
              bindings: [
                binding({
                  workers: [{ threadId: "thr_worker", title: "Implement retry", status: "running" }],
                  reviewers: [{ threadId: "thr_reviewer", workerThreadId: "thr_worker" }],
                }),
              ],
            }),
        } as never,
      },
      { activeThreadId: "thr_reviewer" },
    );
    const reviewer = await waitFor(() => slot.getByText("Review the PR"));
    expect(reviewer.closest("a")!.getAttribute("aria-current")).toBe("page");
    slot.lifecycle.unmount();
  });

  it("expands the Threads section for a one-off thread, and highlights it", async () => {
    const slot = await renderSidebar(
      {
        sidebarThreads: { projects, threads: [thread({ id: "thr_oneoff", displayTitle: "A one-off thread" })] },
        rpc: { stewardsSidebar: () => sidebarData() } as never,
      },
      { activeThreadId: "thr_oneoff" },
    );
    const row = await waitFor(() => slot.getByText("A one-off thread"));
    expect(row.closest("a")!.getAttribute("aria-current")).toBe("page");
    slot.lifecycle.unmount();
  });

  it("expands Monitors for a worker under a monitor, and Recently ended for an archived thread", async () => {
    const monitors = await renderSidebar(
      {
        sidebarThreads: {
          projects,
          threads: [thread({ id: "thr_ops", displayTitle: "Ops watch: acme/web" }), thread({ id: "thr_ops_worker", displayTitle: "Check Sentry" })],
        },
        rpc: {
          stewardsSidebar: () =>
            sidebarData({ bindings: [binding({ key: "acme/web", kind: "ops", stage: null, threadId: "thr_ops", workers: [{ threadId: "thr_ops_worker", title: "Check Sentry", status: "running" }] })] }),
        } as never,
      },
      { activeThreadId: "thr_ops_worker" },
    );
    const worker = await waitFor(() => monitors.getByText("Check Sentry"));
    expect(worker.closest("a")!.getAttribute("aria-current")).toBe("page");
    monitors.lifecycle.unmount();

    const ended = await renderSidebar(
      {
        sidebarThreads: { projects, threads: [] },
        rpc: { stewardsSidebar: () => sidebarData({ ended: [{ key: "ENG-0", kind: "ticket", threadId: "thr_old", title: "Old work", phase: "Done", endReason: "terminal", endedAt: 1_000 }] }) } as never,
      },
      { activeThreadId: "thr_old" },
    );
    const old = await waitFor(() => ended.getByText("Old work"));
    expect(old.closest("a")!.getAttribute("href")).toContain("/board/p1/ENG-0");
    ended.lifecycle.unmount();
  });
});

// BB-94: the board panel publishes its route to the sidebar thread list, which
// the host mounts outside the panel, so the list highlights and reveals the
// effort the Stewards page shows even with no active thread.
describe("the board route store (BB-94)", () => {
  const boardData = () => ({
    projects: [{ projectId: "p1", name: "Acme" }],
    board: {
      projectId: "p1",
      name: "Acme",
      paused: false,
      projectStewardThreadId: null,
      stages: [],
      digest: null,
      questions: [],
      withUser: [],
      needs: [],
      lessons: [],
      lessonCounts: { candidate: 0, trial: 0, promoted: 0, retired: 0 },
      stewards: [],
      stuck: [],
      ended: [],
    },
  });

  it("highlights and reveals the effort the panel's path names, and clears when the panel unmounts", async () => {
    const captured = await loadApp();
    const list = captured.threadLists[0]!;
    const panel = captured.navPanels[0]!;
    const options = {
      sidebarThreads: { projects, threads: [thread({ id: "thr_ops", displayTitle: "Ops watch: acme/web" })] },
      rpc: {
        stewardsSidebar: () => sidebarData({ bindings: [binding({ key: "acme/web", kind: "ops", stage: null, threadId: "thr_ops" })] }),
        stewardsBoard: () => boardData(),
      } as never,
    };
    // The list is mounted with no active thread, so only the store can name
    // the page's project and effort.
    const listSlot = renderSlot(list, { activeThreadId: null, activeProjectId: "p1", isCompactViewport: false, onNavigate: () => {}, searchQuery: "" }, options);
    const monitors = (await waitFor(() => listSlot.getByRole("button", { name: /Monitors/u }))).closest("section")!;
    expect(monitors.querySelector("[data-sidebar-collapsible]")!.className).toContain("grid-rows-[0fr]");
    // Mounting the page publishes its route.
    const panelSlot = renderSlot(panel, { subPath: "p1/acme/web" }, options);
    const row = await waitFor(() => listSlot.getByText("acme/web"));
    expect(row.closest("a")!.getAttribute("aria-current")).toBe("page");
    // Monitors is revealed for the row inside it.
    await waitFor(() => expect(monitors.querySelector("[data-sidebar-collapsible]")!.className).toContain("grid-rows-[1fr]"));
    // Unmounting the page clears the store: the highlight goes.
    panelSlot.lifecycle.unmount();
    await waitFor(() => expect(row.closest("a")!.getAttribute("aria-current")).toBeNull());
    listSlot.lifecycle.unmount();
  });

  it("follows the panel's project in the picker and returns to the thread route's on unmount", async () => {
    const captured = await loadApp();
    const list = captured.threadLists[0]!;
    const panel = captured.navPanels[0]!;
    const options = {
      sidebarThreads: { projects, threads: [] },
      rpc: {
        stewardsSidebar: () => sidebarData(),
        stewardsBoard: () => boardData(),
      } as never,
    };
    const listSlot = renderSlot(list, { activeThreadId: null, activeProjectId: "personal", isCompactViewport: false, onNavigate: () => {}, searchQuery: "" }, options);
    const select = await waitFor(() => listSlot.getByLabelText("Project") as HTMLSelectElement);
    expect(select.value).toBe("personal");
    const panelSlot = renderSlot(panel, { subPath: "p1" }, options);
    await waitFor(() => expect(select.value).toBe("p1"));
    panelSlot.lifecycle.unmount();
    await waitFor(() => expect(select.value).toBe("personal"));
    listSlot.lifecycle.unmount();
  });

  it("reveals a Recently ended row the panel's path names, with no active thread", async () => {
    const captured = await loadApp();
    const list = captured.threadLists[0]!;
    const panel = captured.navPanels[0]!;
    const options = {
      sidebarThreads: { projects, threads: [] },
      rpc: {
        stewardsSidebar: () => sidebarData({ ended: [{ key: "ENG-0", kind: "ticket", threadId: "thr_old", title: "Old work", phase: "Done", endReason: "terminal", endedAt: 1_000 }] }),
        stewardsBoard: () => boardData(),
      } as never,
    };
    const listSlot = renderSlot(list, { activeThreadId: null, activeProjectId: "p1", isCompactViewport: false, onNavigate: () => {}, searchQuery: "" }, options);
    const ended = await waitFor(() => listSlot.getByRole("button", { name: /Recently ended/u }).closest("section")!);
    expect(ended.querySelector("[data-sidebar-collapsible]")!.className).toContain("grid-rows-[0fr]");
    const panelSlot = renderSlot(panel, { subPath: "p1/ENG-0" }, options);
    const row = await waitFor(() => listSlot.getByText("Old work"));
    expect(row.closest("a")!.getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(ended.querySelector("[data-sidebar-collapsible]")!.className).toContain("grid-rows-[1fr]"));
    panelSlot.lifecycle.unmount();
    listSlot.lifecycle.unmount();
  });

  it("moves the page when a project is picked while the panel is mounted", async () => {
    const captured = await loadApp();
    const list = captured.threadLists[0]!;
    const panel = captured.navPanels[0]!;
    const options = {
      sidebarThreads: { projects, threads: [] },
      rpc: {
        stewardsSidebar: () => sidebarData(),
        stewardsBoard: () => boardData(),
      } as never,
    };
    const listSlot = renderSlot(list, { activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: () => {}, searchQuery: "" }, options);
    const panelSlot = renderSlot(panel, { subPath: "p1" }, options);
    const select = await waitFor(() => listSlot.getByLabelText("Project") as HTMLSelectElement);
    await waitFor(() => expect(select.value).toBe("p1"));
    fireEvent.change(select, { target: { value: "personal" } });
    await waitFor(() => expect(listSlot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "board", options: { subPath: "personal" } }));
    panelSlot.lifecycle.unmount();
    listSlot.lifecycle.unmount();
  });
});

// BB-91: the sidebar's CSS-only row transitions.
describe("the sidebar's row transitions (BB-91)", () => {
  // BB-95: the root view transition is gone, so no row carries a name for it.
  it("leaves no view-transition-name on any row", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }), thread({ id: "thr_oneoff", displayTitle: "A one-off thread" })],
      },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({
            bindings: [binding()],
            ended: [{ key: "ENG-0", kind: "ticket", threadId: null, title: "Old work", phase: "Done", endReason: "terminal", endedAt: 1_000 }],
          }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    const names = Array.from(slot.container.querySelectorAll<HTMLElement>("[style]"))
      .map((el) => el.style.viewTransitionName)
      .filter((name) => name !== "");
    expect(names).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("eases glyph and phrase colours and rotates both chevrons", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [
          thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }),
          thread({ id: "thr_worker", displayTitle: "Implement retry" }),
          thread({ id: "thr_oneoff", displayTitle: "A one-off thread" }),
        ],
      },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ workers: [{ threadId: "thr_worker", title: "Implement retry", status: "running" }] })] }) } as never,
    });
    const row = await waitFor(() => slot.getByText("Fix login"));
    const effort = row.closest("li")!;
    // Criterion 4: the glyph's border/background and the phrase text ease colour.
    const glyph = effort.querySelector('[data-steward-glyph="running"]')!;
    expect(glyph.className).toContain("motion-safe:transition-colors");
    expect(glyph.className).toContain("duration-300");
    const phrase = effort.querySelector("[data-sidebar-line-two] span")!;
    expect(phrase.className).toContain("motion-safe:transition-colors");
    expect(phrase.className).toContain("duration-300");
    // Criterion 5: the effort chevron eases its rotation and turns when open.
    const expand = slot.getByRole("button", { name: /Expand ENG-1: Fix login/u });
    const effortChevron = expand.querySelector('[data-icon="ChevronRight"]')!;
    expect(effortChevron.className).toContain("motion-safe:transition-transform");
    expect(effortChevron.className).not.toContain("rotate-90");
    fireEvent.click(expand);
    await waitFor(() => expect(expand.querySelector('[data-icon="ChevronRight"]')!.className).toContain("rotate-90"));
    // The collapsible chevron uses the github-watcher `group-open` rotation pattern.
    const collapsible = slot.getByRole("button", { name: /Threads/u });
    const collapsibleChevron = collapsible.querySelector('[data-icon="ChevronRight"]')!;
    expect(collapsibleChevron.className).toContain("motion-safe:transition-transform");
    expect(collapsibleChevron.className).toContain("group-open:rotate-90");
    slot.lifecycle.unmount();
  });

  it("adds the enter classes only once the first load has painted", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding()] }) } as never,
    });
    // The initial render has no rows, so nothing animates.
    expect(slot.container.querySelector("li.motion-safe\\:animate-in")).toBeNull();
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    await waitFor(() => expect(slot.getByText("Fix login").closest("li")!.className).toContain("motion-safe:animate-in"));
    expect(slot.getByText("Fix login").closest("li")!.className).toContain("slide-in-from-top-1");
    expect(slot.getByText("Fix login").closest("li")!.className).toContain("duration-200");
    slot.lifecycle.unmount();
  });

  it("never starts a document view transition, even when the API exists (BB-95)", async () => {
    const startViewTransition = vi.fn((update: () => void) => {
      update();
      return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition: () => {} } as unknown as ViewTransition;
    });
    (document as unknown as { startViewTransition: unknown }).startViewTransition = startViewTransition;
    let calls = 0;
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => {
          calls += 1;
          return sidebarData({ bindings: [binding({ phase: calls === 1 ? "In Progress" : "In Review" })] });
        },
      } as never,
    });
    await waitFor(() => expect(calls).toBe(1));
    startViewTransition.mockClear();
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(lineTwo(slot, "Fix login")).toContain("In Review"));
    expect(startViewTransition).not.toHaveBeenCalled();
    slot.lifecycle.unmount();
  });

  it("still commits a data update when the document has no view transition API", async () => {
    expect((document as unknown as { startViewTransition?: unknown }).startViewTransition).toBeUndefined();
    let calls = 0;
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => {
          calls += 1;
          return sidebarData({ bindings: [binding({ phase: calls === 1 ? "In Progress" : "In Review" })] });
        },
      } as never,
    });
    await waitFor(() => expect(calls).toBe(1));
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(lineTwo(slot, "Fix login")).toContain("In Review"));
    slot.lifecycle.unmount();
  });
});

// BB-80: a group with an unread descendant starts expanded; a manual toggle
// always wins, and an untouched group follows unread state as it changes.
describe("the sidebar's unread auto-expand (BB-80)", () => {
  const workersBody = (slot: RenderedSlot, title: string): HTMLElement => slot.getByText(title).closest("li")!.querySelector("[data-sidebar-workers]")!;
  const sectionBody = (slot: RenderedSlot, name: RegExp): HTMLElement => slot.getByRole("button", { name }).closest("section")!.querySelector("[data-sidebar-collapsible]")!;

  it("expands a one-off thread row and the Threads section when a descendant is unread on first render", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [thread({ id: "thr_parent", displayTitle: "One-off parent" }), thread({ id: "thr_child", displayTitle: "Unread child", parentThreadId: "thr_parent", isUnread: true })],
      },
      rpc: { stewardsSidebar: () => sidebarData() } as never,
    });
    await waitFor(() => expect(sectionBody(slot, /Threads/u).className).toContain("grid-rows-[1fr]"));
    // The parent row is open, so its child row is mounted.
    await waitFor(() => expect(slot.getByText("Unread child")).toBeTruthy());
    expect(slot.getByRole("button", { name: "Collapse One-off parent" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("expands an effort row and the Monitors section when a descendant is unread on first render", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [thread({ id: "thr_ops", displayTitle: "Ops watch: acme/web" }), thread({ id: "thr_ops_worker", displayTitle: "Check Sentry", isUnread: true })],
      },
      rpc: {
        stewardsSidebar: () =>
          sidebarData({ bindings: [binding({ key: "acme/web", kind: "ops", stage: null, threadId: "thr_ops", workers: [{ threadId: "thr_ops_worker", title: "Check Sentry", status: "finished" }] })] }),
      } as never,
    });
    await waitFor(() => expect(sectionBody(slot, /Monitors/u).className).toContain("grid-rows-[1fr]"));
    await waitFor(() => expect(slot.getByRole("button", { name: "Collapse Ops watch: acme/web" })).toBeTruthy());
    expect(workersBody(slot, "Ops watch: acme/web").className).toContain("grid-rows-[1fr]");
    slot.lifecycle.unmount();
  });

  it("leaves all-read groups collapsed on first render", async () => {
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }), thread({ id: "thr_worker", displayTitle: "Read worker" }), thread({ id: "thr_parent", displayTitle: "One-off parent" }), thread({ id: "thr_child", displayTitle: "Read child", parentThreadId: "thr_parent" })],
      },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ workers: [{ threadId: "thr_worker", title: "Read worker", status: "finished" }] })] }) } as never,
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    expect(slot.getByRole("button", { name: "Expand ENG-1: Fix login" })).toBeTruthy();
    expect(workersBody(slot, "Fix login").className).toContain("grid-rows-[0fr]");
    expect(sectionBody(slot, /Threads/u).className).toContain("grid-rows-[0fr]");
    expect(slot.queryByText("Read child")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("flips an untouched group with unread state: expands when unread arrives, collapses when it clears", async () => {
    const worker = thread({ id: "thr_worker", displayTitle: "Worker" });
    let calls = 0;
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }), worker] },
      rpc: {
        stewardsSidebar: () => {
          calls += 1;
          // A changed payload each call, so the refetch commits and the row
          // re-renders to read the mutated host thread (BB-95 diff-skips an
          // identical payload).
          return sidebarData({ bindings: [binding({ phase: `p${calls}`, workers: [{ threadId: "thr_worker", title: "Worker", status: "finished" }] })] });
        },
      } as never,
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    expect(slot.getByRole("button", { name: "Expand ENG-1: Fix login" })).toBeTruthy();
    const before = calls;
    worker.isUnread = true;
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBeGreaterThan(before));
    await waitFor(() => expect(slot.getByRole("button", { name: "Collapse ENG-1: Fix login" })).toBeTruthy());
    const afterExpand = calls;
    worker.isUnread = false;
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBeGreaterThan(afterExpand));
    await waitFor(() => expect(slot.getByRole("button", { name: "Expand ENG-1: Fix login" })).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("keeps a manually collapsed group collapsed when new unread arrives", async () => {
    const first = thread({ id: "thr_w1", displayTitle: "Unread worker", isUnread: true });
    const second = thread({ id: "thr_w2", displayTitle: "Second worker" });
    let calls = 0;
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }), first, second] },
      rpc: {
        stewardsSidebar: () => {
          calls += 1;
          return sidebarData({ bindings: [binding({ phase: `p${calls}`, workers: [{ threadId: "thr_w1", title: "Unread worker", status: "finished" }, { threadId: "thr_w2", title: "Second worker", status: "finished" }] })] });
        },
      } as never,
    });
    // Auto-expanded by the first worker's unread, then collapsed by hand.
    fireEvent.click(await waitFor(() => slot.getByRole("button", { name: "Collapse ENG-1: Fix login" })));
    await waitFor(() => expect(slot.getByRole("button", { name: "Expand ENG-1: Fix login" })).toBeTruthy());
    // New unread arrives on the second worker; the manual collapse stands.
    const before = calls;
    second.isUnread = true;
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBeGreaterThan(before));
    await waitFor(() => expect(slot.getByRole("button", { name: "Expand ENG-1: Fix login" })).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("keeps a manually expanded group expanded after everything becomes read", async () => {
    const worker = thread({ id: "thr_worker", displayTitle: "Worker" });
    let calls = 0;
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }), worker] },
      rpc: {
        stewardsSidebar: () => {
          calls += 1;
          return sidebarData({ bindings: [binding({ phase: `p${calls}`, workers: [{ threadId: "thr_worker", title: "Worker", status: "finished" }] })] });
        },
      } as never,
    });
    // All read: collapsed, then expanded by hand.
    fireEvent.click(await waitFor(() => slot.getByRole("button", { name: "Expand ENG-1: Fix login" })));
    await waitFor(() => expect(slot.getByRole("button", { name: "Collapse ENG-1: Fix login" })).toBeTruthy());
    // Unread arrives and clears again; the manual expand stands.
    const beforeUnread = calls;
    worker.isUnread = true;
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBeGreaterThan(beforeUnread));
    await waitFor(() => expect(slot.getByRole("button", { name: "Collapse ENG-1: Fix login" })).toBeTruthy());
    const beforeRead = calls;
    worker.isUnread = false;
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBeGreaterThan(beforeRead));
    await waitFor(() => expect(slot.getByRole("button", { name: "Collapse ENG-1: Fix login" })).toBeTruthy());
    slot.lifecycle.unmount();
  });

  // BB-85 kept: navigation to a thread inside a group re-expands it even after
  // a manual collapse, so the highlighted row is revealed.
  it("re-expands a manually collapsed effort when navigation later targets a worker inside it", async () => {
    const captured = await loadApp();
    const list = captured.threadLists[0]!;
    const props = { activeThreadId: null, activeProjectId: "p1", isCompactViewport: false, onNavigate: () => {}, searchQuery: "" };
    const slot = renderSlot(list, props, {
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }), thread({ id: "thr_worker", displayTitle: "Worker" })] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ workers: [{ threadId: "thr_worker", title: "Worker", status: "finished" }] })] }) } as never,
    });
    // All read: collapsed, expanded and collapsed by hand.
    fireEvent.click(await waitFor(() => slot.getByRole("button", { name: "Expand ENG-1: Fix login" })));
    await waitFor(() => expect(slot.getByRole("button", { name: "Collapse ENG-1: Fix login" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Collapse ENG-1: Fix login" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Expand ENG-1: Fix login" })).toBeTruthy());
    // Navigation now targets the worker inside, so the effort re-expands.
    slot.lifecycle.rerender(<list.component {...props} activeThreadId="thr_worker" />);
    await waitFor(() => expect(slot.getByRole("button", { name: "Collapse ENG-1: Fix login" })).toBeTruthy());
    slot.lifecycle.unmount();
  });
});

// BB-95: the client coalesces a burst of signals into one RPC, drops a
// byte-identical answer, and re-renders only the row whose data changed.
describe("the sidebar's refetch coalescing and row memoisation (BB-95)", () => {
  it("makes one RPC for two signals inside the debounce window", async () => {
    let calls = 0;
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => {
          calls += 1;
          return sidebarData({ bindings: [binding()] });
        },
      } as never,
    });
    await waitFor(() => expect(calls).toBe(1));
    // Two signals from one turn: the second lands while the first is still
    // inside the debounce window, so the two make one call.
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBe(2));
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(2);
    slot.lifecycle.unmount();
  });

  it("does not re-render rows when the refetched payload is identical", async () => {
    let calls = 0;
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => {
          calls += 1;
          return sidebarData({ bindings: [binding()] });
        },
      } as never,
    });
    await waitFor(() => expect(calls).toBe(1));
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    // Let the first-load renders settle, then take a baseline.
    await new Promise((r) => setTimeout(r, 50));
    const before = rowRenderCounts.get("effort:ENG-1") ?? 0;
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(rowRenderCounts.get("effort:ENG-1") ?? 0).toBe(before);
    slot.lifecycle.unmount();
  });

  it("re-renders only the row whose data changed", async () => {
    let calls = 0;
    const slot = await renderSidebar({
      sidebarThreads: {
        projects,
        threads: [thread({ id: "thr_a", displayTitle: "ENG-1: A" }), thread({ id: "thr_b", displayTitle: "ENG-2: B" })],
      },
      rpc: {
        stewardsSidebar: () => {
          calls += 1;
          return sidebarData({
            bindings: [binding({ key: "ENG-1", threadId: "thr_a", phase: calls === 1 ? "In Progress" : "In Review" }), binding({ key: "ENG-2", threadId: "thr_b" })],
          });
        },
      } as never,
    });
    await waitFor(() => expect(slot.getByText("A")).toBeTruthy());
    await waitFor(() => expect(calls).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    const beforeA = rowRenderCounts.get("effort:ENG-1") ?? 0;
    const beforeB = rowRenderCounts.get("effort:ENG-2") ?? 0;
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(lineTwo(slot, "A")).toContain("In Review"));
    await new Promise((r) => setTimeout(r, 50));
    expect(rowRenderCounts.get("effort:ENG-1") ?? 0).toBeGreaterThan(beforeA);
    expect(rowRenderCounts.get("effort:ENG-2") ?? 0).toBe(beforeB);
    slot.lifecycle.unmount();
  });

  // BB-80 regression: a host tick that only clears a thread's read state, with
  // no RPC payload change, must still update the group it auto-expanded.
  it("collapses an untouched group when a host thread read clears with no payload change", async () => {
    const captured = await loadApp();
    const list = captured.threadLists[0]!;
    const props = { activeThreadId: null, activeProjectId: "p1", isCompactViewport: false, onNavigate: () => {}, searchQuery: "" };
    const worker = thread({ id: "thr_worker", displayTitle: "Worker", isUnread: true });
    const slot = renderSlot(list, props, {
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }), worker] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ workers: [{ threadId: "thr_worker", title: "Worker", status: "finished" }] })] }) } as never,
    });
    await waitFor(() => expect(slot.getByRole("button", { name: "Collapse ENG-1: Fix login" })).toBeTruthy());
    // The user reads it; the host mutates the thread and re-renders, no RPC.
    worker.isUnread = false;
    slot.lifecycle.rerender(<list.component {...props} />);
    await waitFor(() => expect(slot.getByRole("button", { name: "Expand ENG-1: Fix login" })).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("updates a child row's unread glyph when the host clears it with no payload change", async () => {
    const captured = await loadApp();
    const list = captured.threadLists[0]!;
    const props = { activeThreadId: null, activeProjectId: "p1", isCompactViewport: false, onNavigate: () => {}, searchQuery: "" };
    const worker = thread({ id: "thr_worker", displayTitle: "Worker", isUnread: true });
    const slot = renderSlot(list, props, {
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" }), worker] },
      rpc: { stewardsSidebar: () => sidebarData({ bindings: [binding({ workers: [{ threadId: "thr_worker", title: "Worker", status: "finished" }] })] }) } as never,
    });
    await waitFor(() => expect(glyphOf(slot, "Worker")).toBe("you"));
    worker.isUnread = false;
    slot.lifecycle.rerender(<list.component {...props} />);
    await waitFor(() => expect(glyphOf(slot, "Worker")).toBe("quiet"));
    slot.lifecycle.unmount();
  });
});
