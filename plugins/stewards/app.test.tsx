// @vitest-environment jsdom
// BB-20: the Stewards page renders a decide item or question with fixed
// choices as one button per choice plus Other…, and a text-only one with
// Answer rather than Done.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { PROJECT_CHANGED } from "./channels.js";

type Need = {
  id: string;
  bindingId: string;
  key: string;
  kind: string;
  url: string | null;
  entityUrl: string | null;
  escalationId: string | null;
  choices: string[];
  lessonId: string | null;
  what: string;
  how: string | null;
  destination: string | null;
  threadId: string | null;
  createdAt: number;
  actionable: boolean;
  why: string | null;
};

type Question = {
  id: string;
  question: string;
  context: string | null;
  choices: string[];
  key: string | null;
  url: string | null;
  escalationId: string | null;
  createdAt: number;
  rationaleWanted: string | null;
};

const need = (over: Partial<Need> = {}): Need => ({
  id: "need_1",
  bindingId: "bnd_1",
  key: "ENG-12",
  kind: "decide",
  url: null,
  entityUrl: null,
  escalationId: null,
  choices: [],
  lessonId: null,
  what: "Merge or close?",
  how: null,
  destination: null,
  threadId: null,
  createdAt: 1_000,
  actionable: true,
  why: null,
  ...over,
});

const question = (over: Partial<Question> = {}): Question => ({
  id: "qst_1",
  question: "Merge or close?",
  context: null,
  choices: [],
  key: "ENG-12",
  url: null,
  escalationId: null,
  createdAt: 1_000,
  rationaleWanted: null,
  ...over,
});

let app: CapturedPluginApp | null = null;
const loadApp = async () => {
  app ??= await loadPluginApp(() => import("./app.js"));
  return app;
};

const renderBoard = async (needs: Need[], questions: Question[]): Promise<RenderedSlot> => {
  const captured = await loadApp();
  const panel = captured.navPanels[0]!;
  return renderSlot(panel, { subPath: "" }, {
    rpc: {
      stewardsBoard: () => ({
        projects: [{ projectId: "p1", name: "Acme" }],
        board: {
          projectId: "p1",
          name: "Acme",
          paused: false,
          projectStewardThreadId: "thr_p",
          stages: [],
          digest: null,
          questions,
          withUser: [],
          needs,
          lessons: [],
          lessonCounts: { candidate: 0, trial: 0, promoted: 0, retired: 0 },
          stewards: [],
          stuck: [],
          ended: [],
        },
      }),
      stewardsAnswerQuestion: () => ({ ok: true, message: "closed" }),
      stewardsNeedAction: () => ({ ok: true, message: "done" }),
    } as never,
  });
};

afterEach(() => {
  app = null;
});

describe("the Stewards page's decide items and questions (BB-20)", () => {
  it("shows a button per choice and Other…, not Done, for a decide item with choices", async () => {
    const slot = await renderBoard([need({ choices: ["Merge", "Close", "Verify first"] })], []);
    await waitFor(() => expect(slot.getByRole("button", { name: "Merge" })).toBeTruthy());
    expect(slot.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Verify first" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Other…" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Done" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows Answer, not Done, for a decide item without choices, and Done for configure", async () => {
    const slot = await renderBoard([need({ choices: [] }), need({ id: "need_2", kind: "configure", what: "Enable the event", url: "https://example.test" })], []);
    await waitFor(() => expect(slot.getByRole("button", { name: "Answer" })).toBeTruthy());
    expect(slot.queryByRole("button", { name: "Other…" })).toBeNull();
    expect(slot.getAllByRole("button", { name: "Done" })).toHaveLength(1);
    slot.lifecycle.unmount();
  });

  it("shows the same buttons for a question with choices, and Answer without", async () => {
    const slot = await renderBoard([], [question({ choices: ["Merge", "Close"] }), question({ id: "qst_2", choices: [] })]);
    await waitFor(() => expect(slot.getByRole("button", { name: "Merge" })).toBeTruthy());
    expect(slot.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Other…" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Answer" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("sends the chosen label through the need action", async () => {
    const slot = await renderBoard([need({ choices: ["Merge", "Close"] })], []);
    await waitFor(() => expect(slot.getByRole("button", { name: "Merge" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "stewardsNeedAction", input: { needId: "need_1", action: "choose", note: null, choice: "Merge" } }));
    slot.lifecycle.unmount();
  });

  it("sends the chosen label through the question answer, and Other… reveals Answer", async () => {
    const slot = await renderBoard([], [question({ choices: ["Merge", "Close"] })]);
    await waitFor(() => expect(slot.getByRole("button", { name: "Merge" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "stewardsAnswerQuestion", input: { questionId: "qst_1", answer: null, choice: "Merge" } }));
    slot.lifecycle.unmount();
  });
});

// BB-29: an approve-pr or merge card links the pull request separately, while
// the entity key keeps opening the binding's ticket.
describe("the Stewards page's data commits (BB-91)", () => {
  it("never starts a view transition of its own, since only the sidebar's rows are named", async () => {
    const startViewTransition = vi.fn((update: () => void) => {
      update();
      return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition: () => {} } as unknown as ViewTransition;
    });
    (document as unknown as { startViewTransition: unknown }).startViewTransition = startViewTransition;
    try {
      const slot = await renderBoard([need({ choices: ["Merge"] })], []);
      await waitFor(() => expect(slot.getByText("Merge")).toBeTruthy());
      expect(startViewTransition).not.toHaveBeenCalled();
      slot.lifecycle.unmount();
    } finally {
      delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    }
  });
});

describe("the Stewards page's need links (BB-29)", () => {
  const pr = "https://github.com/bitcomplete/bb-gate/pull/17";
  const ticket = "https://linear.app/bit-complete/issue/BB-28";

  it("links the key to the ticket and offers Open the pull request for approve-pr and merge", async () => {
    const slot = await renderBoard(
      [
        need({ kind: "approve-pr", key: "BB-28", url: pr, entityUrl: ticket, what: "Approve bitcomplete/bb-gate#17 on GitHub" }),
        need({ id: "need_2", kind: "merge", key: "BB-29", url: pr, entityUrl: "https://linear.app/bit-complete/issue/BB-29", what: "Merge bitcomplete/bb-gate#17" }),
      ],
      [],
    );
    await waitFor(() => expect(slot.getAllByRole("button", { name: "Open the pull request" })).toHaveLength(2));
    fireEvent.click(slot.getByRole("button", { name: "BB-28" }));
    fireEvent.click(slot.getAllByRole("button", { name: "Open the pull request" })[0]!);
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: ticket }));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: pr }));
    slot.lifecycle.unmount();
  });

  it("shows no Open the pull request link for other kinds", async () => {
    const slot = await renderBoard([need({ kind: "decide", url: ticket, entityUrl: ticket })], []);
    await waitFor(() => expect(slot.getByRole("button", { name: "Answer" })).toBeTruthy());
    expect(slot.queryByRole("button", { name: "Open the pull request" })).toBeNull();
    slot.lifecycle.unmount();
  });
});

// BB-35 step 4: the rationale box on an escalation, shown only when the plugin
// set `rationaleWanted`, and the collapsed lessons details block at the bottom
// of the project tab.
describe("the rationale box and lessons block (BB-35 step 4)", () => {
  const renderBoardWith = async (over: { questions?: Question[]; lessons?: unknown[]; lessonCounts?: unknown }) => {
    const captured = await loadApp();
    const panel = captured.navPanels[0]!;
    return renderSlot(panel, { subPath: "" }, {
      rpc: {
        stewardsBoard: () => ({
          projects: [{ projectId: "p1", name: "Acme" }],
          board: {
            projectId: "p1",
            name: "Acme",
            paused: false,
            projectStewardThreadId: null,
            stages: [],
            digest: null,
            questions: over.questions ?? [],
            withUser: [],
            needs: [],
            lessons: over.lessons ?? [],
            lessonCounts: over.lessonCounts ?? { candidate: 0, trial: 0, promoted: 0, retired: 0 },
            stewards: [],
            stuck: [],
            ended: [],
          },
        }),
        stewardsAnswerQuestion: () => ({ ok: true, message: "closed" }),
        stewardsNeedAction: () => ({ ok: true, message: "done" }),
      } as never,
    });
  };

  it("shows the box only when rationaleWanted is set, with its one-line why", async () => {
    const none = await renderBoardWith({ questions: [question()] });
    await waitFor(() => expect(none.getByRole("button", { name: "Answer" })).toBeTruthy());
    expect(none.queryByLabelText(/^Why:/u)).toBeNull();
    none.lifecycle.unmount();

    const boxed = await renderBoardWith({ questions: [question({ rationaleWanted: "The guidance did not settle this." })] });
    const box = (await waitFor(() => boxed.getByLabelText(/^Why:/u))) as HTMLTextAreaElement;
    expect(box.placeholder).toBe("The guidance did not settle this.");
    boxed.lifecycle.unmount();
  });

  it("sends the rationale with the answer, and an empty box is accepted", async () => {
    const slot = await renderBoardWith({ questions: [question({ rationaleWanted: "Why?" })] });
    const box = await waitFor(() => slot.getByLabelText(/^Why:/u));
    fireEvent.change(box, { target: { value: "Because the plugin owns auth." } });
    fireEvent.click(slot.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "stewardsAnswerQuestion", input: { questionId: "qst_1", answer: null, rationale: "Because the plugin owns auth." } }));
    slot.lifecycle.unmount();

    const empty = await renderBoardWith({ questions: [question({ rationaleWanted: "Why?" })] });
    fireEvent.click(await waitFor(() => empty.getByRole("button", { name: "Answer" })));
    await waitFor(() => expect(empty.inspection.rpcCalls).toContainEqual({ method: "stewardsAnswerQuestion", input: { questionId: "qst_1", answer: null } }));
    empty.lifecycle.unmount();
  });

  it("is a collapsed details block with the tier counts and no action buttons", async () => {
    const lesson = { id: "lsn_1", bindingId: null, key: null, file: "AGENTS.md", text: "A rule.", scope: "procedure", status: "pending", tier: "trial", hits: 2, corrections: 0, lastCitedAt: null, branch: null, mergeSha: null, note: null, escalationId: null, createdAt: 1_000 };
    const slot = await renderBoardWith({ lessons: [lesson], lessonCounts: { candidate: 0, trial: 1, promoted: 0, retired: 0 } });
    await waitFor(() => expect(slot.getByText(/candidate 0 · trial 1 · promoted 0 · retired 0/u)).toBeTruthy());
    const details = slot.container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(slot.getByText("A rule.")).toBeTruthy();
    expect(slot.queryByRole("button")).toBeNull();
    slot.lifecycle.unmount();
  });
});

// BB-45: the sidebar-footer disclosure writes the `sidebar.threadListProvider`
// UI preference, so the stewards list BB-44 registers can be turned on and off
// from the footer instead of Settings → Appearance.
describe("the sidebar-footer toggle (BB-45)", () => {
  type UiPrefEntry = { value: string; revision: number };
  type SetArgs = { key: string; value: string; expectedRevision: number };

  /** A `uiPreferences.list()` answer with just the one preference the toggle reads. */
  const listed = (entry: UiPrefEntry | null) => ({ preferences: entry === null ? {} : { "sidebar.threadListProvider": entry } }) as never;

  const renderToggle = async (options: { entry: UiPrefEntry | null; set: (args: SetArgs) => Promise<unknown> }) => {
    const captured = await loadApp();
    const item = captured.experimentalSidebarFooterItems[0]!;
    if (item.kind !== "disclosure") throw new Error("the sidebar footer item is not a disclosure");
    const list = vi.fn(async () => listed(options.entry));
    const set = vi.fn(options.set);
    const slot = renderSlot({ component: item.component }, { dismiss: () => {} }, { pluginId: "stewards", sdk: { system: { uiPreferences: { list, set } } } as never });
    return { slot, set };
  };

  const echo = async (args: SetArgs) => ({ key: args.key, value: args.value, revision: args.expectedRevision + 1 });

  it("registers one footer disclosure under the Stewards sidebar label", async () => {
    const captured = await loadApp();
    expect(captured.experimentalSidebarFooterItems).toHaveLength(1);
    expect(captured.experimentalSidebarFooterItems[0]).toMatchObject({ kind: "disclosure", id: "sidebar", label: "Stewards sidebar", icon: "ShieldCheck" });
  });

  it("shows the switch off for bb's list and on for the stewards list", async () => {
    const off = await renderToggle({ entry: { value: "thread-list/thread-list", revision: 7 }, set: echo });
    const offSwitch = await waitFor(() => off.slot.getByRole("switch", { name: "Stewards sidebar" }));
    expect(offSwitch.getAttribute("aria-checked")).toBe("false");
    off.slot.lifecycle.unmount();

    const on = await renderToggle({ entry: { value: "stewards/sidebar", revision: 7 }, set: echo });
    const onSwitch = await waitFor(() => on.slot.getByRole("switch", { name: "Stewards sidebar" }));
    expect(onSwitch.getAttribute("aria-checked")).toBe("true");
    on.slot.lifecycle.unmount();
  });

  it("reads an unpinned provider as on, the effective stewards list", async () => {
    for (const entry of [null, { value: "__automatic__", revision: 0 }]) {
      const { slot } = await renderToggle({ entry, set: echo });
      const toggle = await waitFor(() => slot.getByRole("switch", { name: "Stewards sidebar" }));
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      slot.lifecycle.unmount();
    }
  });

  it("turns the stewards list on with the stewards list id and the listed revision", async () => {
    const { slot, set } = await renderToggle({ entry: { value: "thread-list/thread-list", revision: 7 }, set: echo });
    fireEvent.click(await waitFor(() => slot.getByRole("switch", { name: "Stewards sidebar" })));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]![0]).toEqual({ key: "sidebar.threadListProvider", value: "stewards/sidebar", expectedRevision: 7 });
    await waitFor(() => expect(slot.getByRole("switch", { name: "Stewards sidebar" }).getAttribute("aria-checked")).toBe("true"));
    slot.lifecycle.unmount();
  });

  it("turns the stewards list off by setting bb's own list", async () => {
    const { slot, set } = await renderToggle({ entry: { value: "stewards/sidebar", revision: 3 }, set: echo });
    fireEvent.click(await waitFor(() => slot.getByRole("switch", { name: "Stewards sidebar" })));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]![0]).toEqual({ key: "sidebar.threadListProvider", value: "thread-list/thread-list", expectedRevision: 3 });
    await waitFor(() => expect(slot.getByRole("switch", { name: "Stewards sidebar" }).getAttribute("aria-checked")).toBe("false"));
    slot.lifecycle.unmount();
  });

  it("re-lists and retries once when the set hits a revision conflict", async () => {
    let sets = 0;
    let lists = 0;
    const captured = await loadApp();
    const item = captured.experimentalSidebarFooterItems[0]!;
    if (item.kind !== "disclosure") throw new Error("the sidebar footer item is not a disclosure");
    const slot = renderSlot({ component: item.component }, { dismiss: () => {} }, {
      pluginId: "stewards",
      sdk: {
        system: {
          uiPreferences: {
            list: async () => {
              lists += 1;
              return listed({ value: "thread-list/thread-list", revision: lists === 1 ? 7 : 9 });
            },
            set: async (args: SetArgs) => {
              sets += 1;
              if (sets === 1) throw Object.assign(new Error("revision conflict"), { status: 409 });
              return { key: args.key, value: args.value, revision: args.expectedRevision + 1 };
            },
          },
        },
      } as never,
    });
    fireEvent.click(await waitFor(() => slot.getByRole("switch", { name: "Stewards sidebar" })));
    await waitFor(() => expect(sets).toBe(2));
    expect(slot.inspection.sdkCalls.filter((c) => c.method === "system.uiPreferences.set")).toEqual([
      { method: "system.uiPreferences.set", args: [{ key: "sidebar.threadListProvider", value: "stewards/sidebar", expectedRevision: 7 }] },
      { method: "system.uiPreferences.set", args: [{ key: "sidebar.threadListProvider", value: "stewards/sidebar", expectedRevision: 9 }] },
    ]);
    expect(lists).toBe(2);
    slot.lifecycle.unmount();
  });
});

// BB-46/BB-76: the sidebar's picker counts the yellow effort rows and refreshes
// over the realtime channel; the needs-you items themselves live inline on the
// effort row (covered in sidebar-app.test.tsx).
const sidebarProjects = [
  { id: "p1", name: "Acme", isPersonal: false, href: "/projects/p1", settingsHref: "/projects/p1/settings" },
  { id: "p2", name: "Beta", isPersonal: false, href: "/projects/p2", settingsHref: "/projects/p2/settings" },
];

const sidebarThread = (id: string, projectId = "p1") => ({
  id,
  projectId,
  title: id,
  titleFallback: null,
  displayTitle: id,
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
  href: `/projects/${projectId}/threads/${id}`,
  isHidden: false,
  environment: null,
  host: null,
  createdAt: 0,
  updatedAt: 0,
  lastReadAt: null,
  latestAttentionAt: 0,
});

const sidebarBinding = (over: Record<string, unknown>) => ({
  key: "ENG-1",
  kind: "ticket",
  stage: null,
  phase: null,
  hold: null,
  holdBehind: [],
  waitingOn: null,
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

const sidebarData = (over: { p1?: Record<string, unknown>; p2?: Record<string, unknown>; needsCounts?: Record<string, number> } = {}) => {
  const p1 = over.p1 ?? {};
  return {
    projects: [
      { projectId: "p1", name: "Acme", needsCount: over.needsCounts?.p1 ?? 0 },
      { projectId: "p2", name: "Beta", needsCount: over.needsCounts?.p2 ?? 0 },
    ],
    projectId: "p1",
    projectStewardThreadId: (p1.projectStewardThreadId as string | null) ?? null,
    needs: p1.needs ?? { count: 0, items: [] },
    bindings: p1.bindings ?? [],
    ended: p1.ended ?? [],
  };
};

describe("the stewards sidebar's picker counts and refresh (BB-46)", () => {
  const renderSidebar = async (rpc: Record<string, unknown>, props: Record<string, unknown> = {}, threads: unknown[] = []): Promise<RenderedSlot> => {
    const captured = await loadApp();
    const list = captured.threadLists[0]!;
    return renderSlot(list, { activeThreadId: null, activeProjectId: "p1", isCompactViewport: false, onNavigate: () => {}, searchQuery: "", ...props } as never, {
      sidebarThreads: { projects: sidebarProjects, threads },
      rpc,
    } as never);
  };

  it("counts the yellow effort rows per project, with no summed badge beside the picker", async () => {
    const slot = await renderSidebar(
      {
        stewardsSidebar: () =>
          sidebarData({
            needsCounts: { p1: 2, p2: 1 },
            p1: { bindings: [sidebarBinding({ key: "ENG-1", threadId: "thr_a", needsUser: true }), sidebarBinding({ key: "ENG-2", threadId: "thr_b", needsUser: true })], needs: { count: 9, items: [] } },
          }),
      },
      {},
      [sidebarThread("thr_a"), sidebarThread("thr_b"), sidebarThread("thr_c", "p2")],
    );
    await waitFor(() => expect(slot.getByRole("option", { name: "Acme (2)" })).toBeTruthy());
    expect(slot.getByRole("option", { name: "Beta (1)" })).toBeTruthy();
    expect(slot.queryByLabelText("3 waiting on you")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("sizes the picker and the New thread button as h-8 controls", async () => {
    const slot = await renderSidebar({ stewardsSidebar: () => sidebarData() });
    const select = await waitFor(() => slot.getByLabelText("Project"));
    expect(select.className).toContain("h-8");
    const button = slot.getByRole("button", { name: "New thread" });
    expect(button.className).toContain("size-8");
    expect(button.className).toContain("shrink-0");
    slot.lifecycle.unmount();
  });

  it("refetches on a realtime event for a shown project and ignores an unknown one", async () => {
    let calls = 0;
    const slot = await renderSidebar({
      stewardsSidebar: () => {
        calls += 1;
        return sidebarData();
      },
    });
    await waitFor(() => expect(calls).toBe(1));
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p9" });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBe(2));
    slot.lifecycle.unmount();
  });

  it("refetches the board page when the channel names its project", async () => {
    const captured = await loadApp();
    const panel = captured.navPanels[0]!;
    let calls = 0;
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        stewardsBoard: () => {
          calls += 1;
          return {
            projects: [{ projectId: "p1", name: "Acme" }],
            board: { projectId: "p1", name: "Acme", paused: false, projectStewardThreadId: null, stages: [], digest: null, questions: [], withUser: [], needs: [], lessons: [], lessonCounts: { candidate: 0, trial: 0, promoted: 0, retired: 0 }, stewards: [], stuck: [], ended: [] },
          };
        },
      },
    } as never);
    await waitFor(() => expect(calls).toBe(1));
    // The handler only refetches once the board (and its project id) has rendered.
    await waitFor(() => expect(slot.getByText("Acme")).toBeTruthy());
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBe(2));
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p2" });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(2);
    slot.lifecycle.unmount();
  });
});

// BB-90: the overview (Settings → Plugins → Stewards → Status) polled only, so
// it now subscribes to the widened channel too.
describe("the stewards overview's refresh (BB-90)", () => {
  it("refetches on a realtime event for any project", async () => {
    const captured = await loadApp();
    const section = captured.settingsSections[0]!;
    let calls = 0;
    const slot = renderSlot(section, {}, {
      rpc: {
        stewardsOverview: () => {
          calls += 1;
          return { paused: false, projects: [], lastSweepAt: 0, stats: { rpc: {}, cli: {}, signals: {} } };
        },
      },
    } as never);
    await waitFor(() => expect(calls).toBe(1));
    await slot.emitRealtime(PROJECT_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBe(2));
    slot.lifecycle.unmount();
  });
});

// BB-112: the per-project switch on each settings-page project row.
describe("the stewards overview's per-project switch (BB-112)", () => {
  const project = (enabled: boolean) => ({
    projectId: "p1",
    name: "Acme",
    configured: true,
    enabled,
    source: "multi-repo",
    label: "bb-managed",
    linearTeams: ["ENG"],
    repos: ["acme/web"],
    excludedRepos: [],
    playbooks: [],
    problems: [],
    nightly: null,
    lastNight: null,
    projectStewardThreadId: null,
    digestAt: null,
    endedCount: 0,
    stewards: [],
  });

  it("turns a project's stewards on from its row", async () => {
    const captured = await loadApp();
    const section = captured.settingsSections[0]!;
    const calls: Array<{ projectId: string; enabled: boolean }> = [];
    const slot = renderSlot(section, {}, {
      rpc: {
        stewardsOverview: () => ({ paused: false, lastSweepAt: 0, stats: { rpc: {}, cli: {}, signals: {} }, projects: [project(false)] }),
        stewardsSetProjectEnabled: (args: { projectId: string; enabled: boolean }) => {
          calls.push(args);
          return { ok: true, message: "on", enabled: args.enabled };
        },
        stewardsCheck: () => ({ ok: true, lines: [] }),
      },
    } as never);
    const toggle = await waitFor(() => slot.getByRole("switch", { name: "Stewards for Acme" }));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(slot.getByText(/Stewards are off for this project/u)).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(calls).toEqual([{ projectId: "p1", enabled: true }]));
    slot.lifecycle.unmount();
  });

  it("turns a project's stewards off from its row", async () => {
    const captured = await loadApp();
    const section = captured.settingsSections[0]!;
    const calls: Array<{ projectId: string; enabled: boolean }> = [];
    const slot = renderSlot(section, {}, {
      rpc: {
        stewardsOverview: () => ({ paused: false, lastSweepAt: 0, stats: { rpc: {}, cli: {}, signals: {} }, projects: [project(true)] }),
        stewardsSetProjectEnabled: (args: { projectId: string; enabled: boolean }) => {
          calls.push(args);
          return { ok: true, message: "off", enabled: args.enabled };
        },
        stewardsCheck: () => ({ ok: true, lines: [] }),
      },
    } as never);
    const toggle = await waitFor(() => slot.getByRole("switch", { name: "Stewards for Acme" }));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(calls).toEqual([{ projectId: "p1", enabled: false }]));
    slot.lifecycle.unmount();
  });
});

// BB-78: the Stewards page adopts the sidebar's two-line row, glyph and phrase,
// with the Blocked / In flight / Monitors / Recently ended sections.
const boardSteward = (over: Record<string, unknown> = {}) => ({
  key: "ENG-1",
  url: null,
  title: "Fix login",
  kind: "ticket",
  phase: null,
  stage: null,
  threadId: "thr_steward",
  summary: null,
  nextAction: null,
  actor: null,
  waitingOn: null,
  priority: null,
  hold: null,
  holdBehind: [],
  needsUser: false,
  stuck: false,
  deployment: null,
  pending: [],
  requeueAt: null,
  ending: null,
  statusAt: null,
  createdAt: 1_000,
  wokeAt: null,
  advancedAt: null,
  workers: [],
  ...over,
});

const renderBoardWith = async (over: { subPath?: string; stewards?: unknown[]; questions?: unknown[]; withUser?: unknown[]; needs?: unknown[]; lessons?: unknown[]; lessonCounts?: unknown; digest?: unknown; ended?: unknown[]; stuck?: unknown[] } = {}): Promise<RenderedSlot> => {
  const captured = await loadApp();
  const panel = captured.navPanels[0]!;
  return renderSlot(panel, { subPath: over.subPath ?? "" }, {
    rpc: {
      stewardsBoard: () => ({
        projects: [{ projectId: "p1", name: "Acme" }],
        board: {
          projectId: "p1",
          name: "Acme",
          paused: false,
          projectStewardThreadId: "thr_p",
          stages: [],
          digest: over.digest ?? null,
          questions: over.questions ?? [],
          withUser: over.withUser ?? [],
          needs: over.needs ?? [],
          lessons: over.lessons ?? [],
          lessonCounts: over.lessonCounts ?? { candidate: 0, trial: 0, promoted: 0, retired: 0 },
          stewards: over.stewards ?? [],
          stuck: over.stuck ?? [],
          ended: over.ended ?? [],
        },
      }),
      stewardsAnswerQuestion: () => ({ ok: true, message: "closed" }),
      stewardsNeedAction: () => ({ ok: true, message: "done" }),
    } as never,
  });
};

const glyphIn = (slot: RenderedSlot, title: string): string | null => slot.getByText(title).closest("li")!.querySelector("[data-steward-glyph]")?.getAttribute("data-steward-glyph") ?? null;
const lineTwoIn = (slot: RenderedSlot, title: string): string => {
  const li = slot.getByText(title).closest("li")!;
  return (li.querySelector("[data-steward-line-two]") ?? li.querySelector("[data-sidebar-line-two]"))?.textContent ?? "";
};
const headingGlyph = (slot: RenderedSlot): string | null => slot.container.querySelector("[data-steward-glyph]")?.getAttribute("data-steward-glyph") ?? null;
const headingLineTwo = (slot: RenderedSlot): string => slot.container.querySelector("[data-steward-line-two]")?.textContent ?? "";

const aLesson = (over: Record<string, unknown> = {}) => ({ id: "lsn_1", bindingId: null, key: null, file: "AGENTS.md", text: "A rule.", scope: "procedure", status: "pending", tier: "trial", hits: 2, corrections: 0, lastCitedAt: null, branch: null, mergeSha: null, note: null, escalationId: null, createdAt: 1_000, ...over });

// BB-85: the page is no longer the list. `board/<project>` is the project
// view and `board/<project>/<key>` is one effort's detail, opened from the
// sidebar; the card columns are gone.
describe("the Stewards page's project view and detail views (BB-85)", () => {
  it("shows the project view: name, steward link, waiting on you, the count line, digest and collapsed lessons, with no card columns", async () => {
    const slot = await renderBoardWith({
      stewards: [
        boardSteward({ key: "ENG-1", title: "Fix login", needsUser: true }),
        boardSteward({ key: "ENG-2", title: "Held up", hold: "a freeze" }),
        boardSteward({ key: "acme/web", title: "Ops watch", kind: "ops" }),
      ],
      questions: [question({ id: "qst_project", key: null, question: "Which release?" })],
      digest: { text: "All quiet.", at: 1_000 },
      lessons: [aLesson()],
      lessonCounts: { candidate: 0, trial: 1, promoted: 0, retired: 0 },
      ended: [{ key: "ENG-0", url: null, title: "Old work", kind: "ticket", endReason: "done", endedAt: 1_000, threadId: "thr_old" }],
    });
    await waitFor(() => expect(slot.getByText("Which release?")).toBeTruthy());
    // The name and the project-steward link.
    expect(slot.getByText("Acme")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Open the project steward" })).toBeTruthy();
    // Waiting on you holds only the item with no open binding.
    expect(slot.queryByText("Stack or hold?")).toBeNull();
    // The count line.
    const count = slot.container.querySelector("[data-board-count-line]")!;
    expect(count.textContent).toContain("3 open");
    expect(count.textContent).toContain("2 blocked");
    expect(count.textContent).toContain("1 monitors");
    expect(count.textContent).toContain("1 recently ended");
    // The latest digest and the collapsed lessons block.
    expect(slot.getByText("All quiet.")).toBeTruthy();
    expect(slot.getByText("A rule.")).toBeTruthy();
    expect(slot.container.querySelector("details")!.open).toBe(false);
    // No card columns any more.
    for (const name of [/^Blocked/u, /^In flight/u, /^Monitors/u, /^Recently ended/u]) {
      expect(slot.queryByRole("heading", { name })).toBeNull();
    }
    slot.lifecycle.unmount();
  });

  it("replaces the path with the server's project when the path names none", async () => {
    const slot = await renderBoardWith({ stewards: [] });
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "board", options: { subPath: "p1", replace: true } }));
    slot.lifecycle.unmount();
  });

  it("shows one effort's detail: the two-line heading, needs you with the page's controls, status, threads and lessons", async () => {
    const slot = await renderBoardWith({
      subPath: "p1/ENG-1",
      stewards: [
        boardSteward({ key: "ENG-1", title: "Fix login", needsUser: true, phase: "In Review", summary: "In review", nextAction: "wait for CI", actor: "steward", statusAt: 1_000, createdAt: 2_000, stage: "build", deployment: "deployed", workers: [{ threadId: "thr_w", title: "Implement retry" }] }),
      ],
      questions: [question({ id: "qst_eng1", key: "ENG-1", question: "Stack or hold?", choices: ["Stack", "Hold"] })],
      needs: [need({ id: "need_spec", kind: "approve-spec", key: "ENG-1", what: "Approve the spec", how: "Read the spec" })],
      lessons: [aLesson({ key: "ENG-1" })],
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    // The heading is the sidebar's two-line row one size up, with a crumb back.
    expect(headingGlyph(slot)).toBe("you");
    expect(headingLineTwo(slot)).toBe("ticket · In Review · needs you");
    expect(slot.getByRole("button", { name: /Acme/u })).toBeTruthy();
    // Needs you carries the page's full controls.
    expect(slot.getByText("Stack or hold?")).toBeTruthy();
    expect(slot.getByText("Approve the spec")).toBeTruthy();
    expect(slot.getByLabelText("Note for: Approve the spec")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Stack" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "stewardsAnswerQuestion", input: { questionId: "qst_eng1", answer: null, choice: "Stack" } }));
    // Status: summary, Next, stage and deployment.
    expect(slot.getByText("In review")).toBeTruthy();
    expect(slot.getByText(/Next: wait for CI \(the steward\)/u)).toBeTruthy();
    expect(slot.getByText(/stage build/u)).toBeTruthy();
    expect(slot.getByText(/deployed/u)).toBeTruthy();
    // Threads: the steward, the worker and the pull request.
    expect(slot.getByRole("button", { name: "Open the steward" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Implement retry" })).toBeTruthy();
    // Lessons the effort wrote.
    expect(slot.getByText("A rule.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("labels the `user` actor as you in an effort's status (BB-97)", async () => {
    const slot = await renderBoardWith({
      subPath: "p1/ENG-1",
      stewards: [boardSteward({ key: "ENG-1", title: "Fix login", needsUser: true, phase: "In Review", summary: "In review", nextAction: "On the next deployment wake, re-run the carries check", actor: "user", statusAt: 1_000, createdAt: 2_000, stage: "build" })],
    });
    await waitFor(() => expect(slot.getByText("Fix login")).toBeTruthy());
    expect(slot.getByText(/Next: On the next deployment wake, re-run the carries check \(you\)/u)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("keeps the page-only controls on the detail's needs-you items: the secret form and the approve-spec note", async () => {
    const slot = await renderBoardWith({
      subPath: "p1/ENG-1",
      stewards: [boardSteward({ key: "ENG-1", title: "Fix login", needsUser: true, summary: "Waiting on you" })],
      needs: [
        need({ id: "need_secret", key: "ENG-1", kind: "provide-secret", what: "Add the token", destination: "the dotenv" }),
        need({ id: "need_spec", key: "ENG-1", kind: "approve-spec", what: "Approve the spec", how: "Read the spec first" }),
      ],
    });
    await waitFor(() => expect(slot.getByText("Add the token")).toBeTruthy());
    expect(slot.getByText(/The form opens in a thread/u)).toBeTruthy();
    expect(slot.getByRole("button", { name: "Provide" })).toBeTruthy();
    const note = slot.getByLabelText("Note for: Approve the spec") as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "LGTM" } });
    fireEvent.click(slot.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "stewardsNeedAction", input: { needId: "need_spec", action: "approve", note: "LGTM" } }));
    slot.lifecycle.unmount();
  });

  it("shows the waiting, hold and stuck lines in the status", async () => {
    const slot = await renderBoardWith({
      subPath: "p1/ENG-1",
      stewards: [boardSteward({ key: "ENG-1", title: "Fix login", waitingOn: "bb-gate#88", hold: "a freeze", holdBehind: ["ENG-9"], stuck: true, summary: "x", nextAction: "y" })],
      stuck: [{ key: "ENG-1", url: null, threadId: "thr_s", why: "waiting on a decision", since: 1 }],
    });
    // The wait is a plain muted line, not a destructive one (BB-109).
    const waiting = await waitFor(() => slot.getByText("Waiting on bb-gate#88"));
    expect(waiting.className).toContain("text-muted-foreground");
    expect(waiting.className).not.toContain("text-destructive");
    expect(slot.getByText(/On hold: a freeze \(behind ENG-9\)/u)).toBeTruthy();
    expect(slot.getByText(/Stuck: waiting on a decision/u)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows what the board knows about an ended effort, and an unknown key says so", async () => {
    const ended = await renderBoardWith({
      subPath: "p1/ENG-0",
      ended: [{ key: "ENG-0", url: "https://linear.app/x", title: "Old work", kind: "ticket", endReason: "done", endedAt: 1_000, threadId: "thr_old" }],
    });
    await waitFor(() => expect(ended.getByText("Old work")).toBeTruthy());
    expect(ended.getByText("done")).toBeTruthy();
    expect(ended.getByRole("button", { name: "Open the archived thread" })).toBeTruthy();
    fireEvent.click(ended.getByRole("button", { name: "Open the archived thread" }));
    await waitFor(() => expect(ended.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_old" }));
    ended.lifecycle.unmount();

    const unknown = await renderBoardWith({ subPath: "p1/ENG-404" });
    await waitFor(() => expect(unknown.getByText(/No effort/u)).toBeTruthy());
    expect(unknown.getByText("ENG-404")).toBeTruthy();
    unknown.lifecycle.unmount();
  });

  it("resolves a pull-request key that keeps its own slash", async () => {
    const slot = await renderBoardWith({
      subPath: "p1/acme/web#612",
      stewards: [boardSteward({ key: "acme/web#612", title: "Read dashboard metrics", kind: "pr", url: "https://github.com/acme/web/pull/612" })],
    });
    await waitFor(() => expect(slot.getByText("Read dashboard metrics")).toBeTruthy());
    expect(slot.getByText("#612")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("derives the same state and phrase on the detail heading and the sidebar for the same binding", async () => {
    const bindings = [
      sidebarBinding({ key: "ENG-1", threadId: "thr_1", needsUser: true, phase: "In Review" }),
      sidebarBinding({ key: "ENG-2", threadId: "thr_2", workers: [{ threadId: "thr_w", title: "w", status: "running" }] }),
      sidebarBinding({ key: "ENG-3", threadId: "thr_3", waitingOn: "bb-gate#88" }),
      sidebarBinding({ key: "ENG-4", threadId: "thr_4", deployment: "deployed" }),
    ];
    const captured = await loadApp();
    const list = captured.threadLists[0]!;
    const sidebar = renderSlot(
      list,
      { activeThreadId: null, activeProjectId: "p1", isCompactViewport: false, onNavigate: () => {}, searchQuery: "" },
      {
        sidebarThreads: {
          projects: sidebarProjects,
          threads: [
            { ...sidebarThread("thr_1"), displayTitle: "ENG-1: Needs you" },
            { ...sidebarThread("thr_2"), displayTitle: "ENG-2: Working" },
            { ...sidebarThread("thr_3"), displayTitle: "ENG-3: Held up" },
            { ...sidebarThread("thr_4"), displayTitle: "ENG-4: Waiting" },
          ],
        },
        rpc: { stewardsSidebar: () => sidebarData({ p1: { bindings } }) },
      } as never,
    );
    await waitFor(() => expect(sidebar.getByText("Needs you")).toBeTruthy());
    const fromSidebar = new Map(["Needs you", "Working", "Held up", "Waiting"].map((title) => [title, { glyph: glyphIn(sidebar, title), lineTwo: lineTwoIn(sidebar, title) }]));
    sidebar.lifecycle.unmount();

    const board = await renderBoardWith({
      subPath: "p1/ENG-2",
      stewards: [boardSteward({ key: "ENG-2", title: "Working", workers: [{ threadId: "thr_w", title: "w" }] })],
    });
    await waitFor(() => expect(board.getByText("Working")).toBeTruthy());
    expect(headingGlyph(board)).toBe(fromSidebar.get("Working")!.glyph);
    expect(headingLineTwo(board)).toBe(fromSidebar.get("Working")!.lineTwo);
    board.lifecycle.unmount();
  });

  it("shows a with-user escalation's context under its question (BB-79)", async () => {
    const slot = await renderBoardWith({
      withUser: [{ id: "esc_1", kind: "blocked", question: "Need cluster access", context: "The staging cluster is not on the tailnet.", recommendation: null, key: "ENG-1", url: null, threadId: null, createdAt: 1_000, rationaleWanted: null }],
    });
    await waitFor(() => expect(slot.getByText("Need cluster access")).toBeTruthy());
    expect(slot.getByText("The staging cluster is not on the tailnet.")).toBeTruthy();
    slot.lifecycle.unmount();
  });
});

