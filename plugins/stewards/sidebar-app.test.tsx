// @vitest-environment jsdom
// BB-44/BB-76: the stewards sidebar thread list renders one tab per project,
// two-line effort rows with the four glyphs, inline needs-you actions, and the
// Blocked / In flight / Threads / Monitors / Recently ended sections.
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
    expect(slot.queryByText("Implement retry")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /Expand ENG-1: Fix login/u }));
    await waitFor(() => expect(slot.getByText("Implement retry")).toBeTruthy());
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
    // reviewer is the pulsing blue ring.
    fireEvent.click(await waitFor(() => slot.getByRole("button", { name: /Expand ENG-1: Fix login/u })));
    await waitFor(() => expect(slot.getByText("Unread worker")).toBeTruthy());
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
            ended: [{ key: "ENG-0", kind: "ticket", threadId: null, title: "Old work", endedAt: 1_000 }],
          }),
      } as never,
    });
    await waitFor(() => expect(slot.getByRole("button", { name: /Monitors/u })).toBeTruthy());
    expect(slot.queryByText("acme/web")).toBeNull();
    expect(slot.queryByText("Old work")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /Monitors/u }));
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

  it("navigates to the row's thread and calls onNavigate", async () => {
    const onNavigate = vi.fn();
    const slot = await renderSidebar(
      {
        sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
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
    fireEvent.click(await waitFor(() => slot.getByRole("button", { name: /Threads/u })));
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
    expect(slot.getByRole("button", { name: "Details" })).toBeTruthy();
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

  it("renders a with-user escalation with Details only", async () => {
    const slot = await renderSidebar({
      sidebarThreads: { projects, threads: [thread({ id: "thr_steward", displayTitle: "ENG-1: Fix login" })] },
      rpc: {
        stewardsSidebar: () => sidebarData({ bindings: [binding({ needsUser: true })], needs: { count: 1, items: [withUserItem()] } }),
      } as never,
    });
    await waitFor(() => expect(slot.getByText("Need cluster access")).toBeTruthy());
    // A with-user escalation has no choices and is not an approve-pr or merge,
    // so its prompt is one line (BB-79).
    expect(slot.getByText("Need cluster access").className).toContain("line-clamp-1");
    expect(slot.getByRole("button", { name: "Details" })).toBeTruthy();
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
