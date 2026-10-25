// @vitest-environment jsdom
// BB-20: the Stewards page renders a decide item or question with fixed
// choices as one button per choice plus Other…, and a text-only one with
// Answer rather than Done.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { NEEDS_YOU_CHANGED } from "./channels.js";

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

// BB-46: the sidebar's "Needs you" block, fed by the
// `stewardsSidebar` call and refreshed over the realtime channel.
const sidebarProjects = [
  { id: "p1", name: "Acme", isPersonal: false, href: "/projects/p1", settingsHref: "/projects/p1/settings" },
  { id: "p2", name: "Beta", isPersonal: false, href: "/projects/p2", settingsHref: "/projects/p2/settings" },
];

const sidebarData = (p1Needs: { count: number; items: unknown[] }, p2Needs: { count: number; items: unknown[] } = { count: 0, items: [] }) => ({
  projects: [
    { projectId: "p1", name: "Acme", projectStewardThreadId: null, needs: p1Needs, bindings: [], ended: [] },
    { projectId: "p2", name: "Beta", projectStewardThreadId: null, needs: p2Needs, bindings: [], ended: [] },
  ],
});

describe("the stewards sidebar's needs you block (BB-46)", () => {
  const questionItem = (over: Record<string, unknown> = {}) => ({
    type: "question",
    id: "qst_1",
    question: "Which approach?",
    context: null,
    choices: [],
    key: "ENG-12",
    url: "https://linear.app/acme/issue/ENG-12",
    escalationId: null,
    createdAt: 1_000,
    ...over,
  });
  const needItem = (over: Record<string, unknown> = {}) => ({
    type: "need",
    id: "need_1",
    bindingId: "bnd_1",
    key: "ENG-12",
    kind: "decide",
    url: null,
    entityUrl: "https://linear.app/acme/issue/ENG-12",
    escalationId: null,
    choices: [],
    lessonId: null,
    what: "Hold or start?",
    how: null,
    destination: null,
    threadId: null,
    createdAt: 1_000,
    actionable: true,
    why: null,
    ...over,
  });

  const renderSidebar = async (rpc: Record<string, unknown>, props: Record<string, unknown> = {}): Promise<RenderedSlot> => {
    const captured = await loadApp();
    const list = captured.threadLists[0]!;
    return renderSlot(list, { activeThreadId: null, activeProjectId: "p1", isCompactViewport: false, onNavigate: () => {}, searchQuery: "", ...props } as never, {
      sidebarThreads: { projects: sidebarProjects, threads: [] },
      rpc,
    } as never);
  };

  it("does not render a summed count badge beside the picker", async () => {
    const slot = await renderSidebar({ stewardsSidebar: () => sidebarData({ count: 2, items: [questionItem()] }) });
    await waitFor(() => expect(slot.getByLabelText("Project")).toBeTruthy());
    await waitFor(() => expect(slot.getByRole("option", { name: "Acme (2)" })).toBeTruthy());
    expect(slot.queryByLabelText("2 waiting on you")).toBeNull();
    expect(slot.getByRole("option", { name: "Beta" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it.each([false, true])("shows per-project counts in its options and no summed badge (compact=%s)", async (isCompactViewport) => {
    const slot = await renderSidebar(
      { stewardsSidebar: () => sidebarData({ count: 2, items: [questionItem(), needItem()] }, { count: 1, items: [needItem({ id: "need_2" })] }) },
      { isCompactViewport },
    );
    await waitFor(() => expect(slot.getByRole("option", { name: "Acme (2)" })).toBeTruthy());
    expect(slot.getByRole("option", { name: "Beta (1)" })).toBeTruthy();
    expect(slot.queryByLabelText("3 waiting on you")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("sizes the picker and the New thread button as h-8 controls", async () => {
    const slot = await renderSidebar({ stewardsSidebar: () => sidebarData({ count: 2, items: [questionItem()] }) });
    const select = await waitFor(() => slot.getByLabelText("Project"));
    expect(select.className).toContain("h-8");
    const button = slot.getByRole("button", { name: "New thread" });
    expect(button.className).toContain("size-8");
    expect(button.className).toContain("shrink-0");
    slot.lifecycle.unmount();
  });

  it("sends a question's choice through stewardsAnswerQuestion with the page's arguments", async () => {
    const slot = await renderSidebar({
      stewardsSidebar: () => sidebarData({ count: 1, items: [questionItem({ choices: ["Merge", "Close"] })] }),
      stewardsAnswerQuestion: () => ({ ok: true, message: "closed" }),
    });
    await waitFor(() => expect(slot.getByRole("button", { name: "Merge" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "stewardsAnswerQuestion", input: { questionId: "qst_1", answer: null, choice: "Merge" } }));
    slot.lifecycle.unmount();
  });

  it("sends a decide need's choice through stewardsNeedAction with the page's arguments", async () => {
    const slot = await renderSidebar({
      stewardsSidebar: () => sidebarData({ count: 1, items: [needItem({ choices: ["Hold", "Start"] })] }),
      stewardsNeedAction: () => ({ ok: true, message: "done" }),
    });
    await waitFor(() => expect(slot.getByRole("button", { name: "Hold" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Hold" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "stewardsNeedAction", input: { needId: "need_1", action: "choose", note: null, choice: "Hold" } }));
    slot.lifecycle.unmount();
  });

  it("opens the board for a row without choices", async () => {
    const slot = await renderSidebar({ stewardsSidebar: () => sidebarData({ count: 1, items: [needItem({ kind: "configure", choices: [] })] }) });
    await waitFor(() => expect(slot.getByRole("button", { name: "Open" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "board", options: { subPath: "p1" } }));
    slot.lifecycle.unmount();
  });

  it("refetches on a realtime event for a shown project and ignores an unknown one", async () => {
    let calls = 0;
    const slot = await renderSidebar({
      stewardsSidebar: () => {
        calls += 1;
        return sidebarData({ count: 0, items: [] });
      },
    });
    await waitFor(() => expect(calls).toBe(1));
    await slot.emitRealtime(NEEDS_YOU_CHANGED, { projectId: "p9" });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    await slot.emitRealtime(NEEDS_YOU_CHANGED, { projectId: "p1" });
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
            board: { projectId: "p1", name: "Acme", paused: false, projectStewardThreadId: null, stages: [], digest: null, questions: [], withUser: [], needs: [], lessons: [], stewards: [], stuck: [], ended: [] },
          };
        },
      },
    } as never);
    await waitFor(() => expect(calls).toBe(1));
    // The handler only refetches once the board (and its project id) has rendered.
    await waitFor(() => expect(slot.getByText("Acme")).toBeTruthy());
    await slot.emitRealtime(NEEDS_YOU_CHANGED, { projectId: "p1" });
    await waitFor(() => expect(calls).toBe(2));
    await slot.emitRealtime(NEEDS_YOU_CHANGED, { projectId: "p2" });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(2);
    slot.lifecycle.unmount();
  });
});
