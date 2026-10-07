// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginNavPanelRegistration,
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { BriefCard, BriefState } from "./contract.js";

const NOW = Date.now();

const card = (overrides: Partial<BriefCard> = {}): BriefCard => ({
  threadId: "thr_1",
  stage: "implementation",
  modelStage: "implementation",
  status: "waiting-on-me",
  stageOverride: null,
  statusOverride: null,
  blockReason: null,
  nextStep: "Push the branch",
  blockedOn: "",
  lastSummarizedAt: NOW - 1000,
  ...overrides,
});

const thread = (overrides: Partial<PluginSidebarThread>): PluginSidebarThread =>
  ({
    id: "thr_1",
    projectId: "proj_alpha",
    displayTitle: "Board thread",
    href: "/projects/proj_alpha/threads/thr_1",
    status: "idle",
    isPinned: false,
    isHidden: false,
    isArchived: false,
    latestAttentionAt: NOW - 1000,
    ...overrides,
  }) as PluginSidebarThread;

const project = (id: string, name: string): PluginSidebarProject =>
  ({ id, name, isPersonal: false }) as PluginSidebarProject;

const READY: BriefState = {
  state: "ready",
  brief: {
    threadId: "thr_1",
    goal: "Ship the board",
    currentState: "Columns render",
    nextStep: "Push the branch",
    blockedOn: "",
    constraints: "One slot per sidebar row",
    stage: "implementation",
    status: "waiting-on-me",
    stageOverride: null,
    statusOverride: null,
    blockReason: null,
    lastSummarizedAt: NOW - 1000,
  },
};

let app: CapturedPluginApp | null = null;
const loadApp = async () => {
  app ??= await loadPluginApp(() => import("./app.js"));
  return app;
};

const panelOf = async (): Promise<PluginNavPanelRegistration> => {
  const captured = await loadApp();
  const panel = captured.navPanels[0];
  if (panel === undefined) throw new Error("no nav panel registered");
  return panel;
};

type RenderOptions = {
  /** The remembered view this board opens onto. See {@link STORAGE_KEY}. */
  stored?: string;
  cards?: readonly BriefCard[];
  threads?: readonly PluginSidebarThread[];
  projects?: readonly PluginSidebarProject[];
  rpc?: Record<string, (input: never) => unknown>;
};

/** Where the board keeps its view, under the harness's plugin id. */
const STORAGE_KEY = "test-plugin:board-filters";

const storedView = () => window.localStorage.getItem(STORAGE_KEY);

const renderBoard = async (options: RenderOptions = {}): Promise<RenderedSlot> => {
  const panel = await panelOf();
  if (options.stored !== undefined) {
    window.localStorage.setItem(STORAGE_KEY, options.stored);
  }
  return renderSlot(
    panel,
    // The host passes the panel's sub path; the board ignores it and keeps its
    // view in storage instead. See {@link BoardPage}.
    { subPath: "" },
    {
      sidebarThreads: {
        status: "ready",
        threads: options.threads ?? [thread({})],
        projects: options.projects ?? [project("proj_alpha", "Alpha")],
        sections: [],
      },
      rpc: {
        listBriefCards: () => ({
          cards: options.cards ?? [card()],
          staleAfterMs: 24 * 60 * 60 * 1000,
          archiveAfterMs: 48 * 60 * 60 * 1000,
        }),
        getBrief: () => READY,
        setStageOverride: () => READY,
        setStatusOverride: () => READY,
        refresh: () => ({ queued: true }),
        ...options.rpc,
      } as never,
    },
  );
};

/** The column with this heading, so an assertion can be scoped to one bucket. */
const column = (slot: RenderedSlot, name: string) =>
  within(slot.getByRole("region", { name }));

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("registration", () => {
  it("registers one nav panel with a sidebar accessory", async () => {
    const captured = await loadApp();
    expect(captured.navPanels.map((entry) => entry.id)).toEqual(["board"]);
    const panel = captured.navPanels[0]!;
    expect(panel.path).toBe("board");
    expect(panel.title).toBe("Briefs");
    // The badge is the reason to open the board, so it has to be on the row.
    expect(panel.experimental_sidebarAccessory).toBeDefined();
  });
});

describe("the board", () => {
  it("draws every column, with the card in its stage", async () => {
    const slot = await renderBoard();
    await waitFor(() =>
      expect(column(slot, "Implementation").getByText("Board thread")).toBeTruthy(),
    );
    for (const name of [
      "No stage",
      "Discovery",
      "Planning",
      "Implementation",
      "Review",
      "Done",
    ]) {
      expect(slot.getByRole("region", { name })).toBeTruthy();
    }
    slot.lifecycle.unmount();
  });

  it("shows the next step on the card face, not the goal", async () => {
    // The board's question is which thread to pick up, not what a thread was
    // for; goal is one chevron away, where it answers the other question.
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Push the branch")).toBeTruthy());
    expect(slot.queryByText("Ship the board")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("links the card at bb's own thread href", async () => {
    const slot = await renderBoard();
    const link = await waitFor(() =>
      slot.getByRole("link", { name: "Board thread" }),
    );
    expect(link.getAttribute("href")).toBe(
      "/projects/proj_alpha/threads/thr_1",
    );
    slot.lifecycle.unmount();
  });

  it("puts a done thread in the terminal column", async () => {
    const slot = await renderBoard({
      stored: "expand:done",
      cards: [card({ status: "done", nextStep: "" })],
    });
    await waitFor(() =>
      expect(column(slot, "Done").getByText("Board thread")).toBeTruthy(),
    );
    expect(column(slot, "Done").getByText("Nothing outstanding.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("collapses Done to a rail by default, and opens it on a click", async () => {
    // Done is the one column whose cards are, by definition, not work, and it
    // used to hold a sixth of the width for them.
    const slot = await renderBoard({
      cards: [card({ status: "done", nextStep: "" })],
    });
    const rail = await waitFor(() =>
      slot.getByRole("button", { name: "Show the Done column" }),
    );
    expect(column(slot, "Done").queryByText("Board thread")).toBeNull();
    // The count is on the rail, so a collapsed column never reads as empty.
    expect(column(slot, "Done").getByText("1")).toBeTruthy();
    fireEvent.click(rail);
    expect(column(slot, "Done").getByText("Board thread")).toBeTruthy();
    // Expansion is remembered beside the filters, so the board reopens as you
    // left it.
    expect(storedView()).toBe("expand:done");
    slot.lifecycle.unmount();
  });

  it("collapses an empty No stage column, with no control to open it", async () => {
    // Almost always empty, and a rail with nothing behind it is not a button.
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    expect(slot.getByRole("region", { name: "No stage" })).toBeTruthy();
    expect(
      slot.queryByRole("button", { name: "Show the No stage column" }),
    ).toBeNull();
    slot.lifecycle.unmount();
  });

  it("opens the No stage column as soon as it holds a thread, and offers to summarize it", async () => {
    // Briefs are never backfilled, so the board has to account for these or it
    // cannot be read as "everything I have open" — and the Summarize button on
    // those cards is the whole point of showing them.
    const slot = await renderBoard({ cards: [] });
    await waitFor(() =>
      expect(column(slot, "No stage").getByText("Board thread")).toBeTruthy(),
    );
    fireEvent.click(column(slot, "No stage").getByRole("button", { name: "Summarize" }));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some((entry) => entry.method === "refresh"),
      ).toBe(true),
    );
    slot.lifecycle.unmount();
  });

  it("says when the agent could carry on by itself", async () => {
    const slot = await renderBoard({ cards: [card({ nextStepActor: "agent" })] });
    await waitFor(() => expect(slot.getByText("agent can continue")).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("marks a card pinned by hand", async () => {
    const slot = await renderBoard({
      cards: [card({ stageOverride: "implementation", modelStage: "planning" })],
    });
    await waitFor(() => expect(slot.getByText("· pinned")).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("warns that a cold done thread is on its way out", async () => {
    const slot = await renderBoard({
      stored: "expand:done",
      cards: [card({ status: "done", nextStep: "" })],
      threads: [thread({ latestAttentionAt: NOW - 30 * 60 * 60 * 1000 })],
    });
    await waitFor(() => expect(slot.getByText("· archiving soon")).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("folds a running thread out of Done into its stage column", async () => {
    const slot = await renderBoard({
      stored: "expand:done",
      cards: [card({ status: "done", nextStep: "" })],
      threads: [thread({ status: "active" })],
    });
    await waitFor(() =>
      expect(column(slot, "Implementation").getByText("Board thread")).toBeTruthy(),
    );
    expect(column(slot, "Done").queryByText("Board thread")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("redraws on a briefs-changed event", async () => {
    let status: BriefCard["status"] = "waiting-on-me";
    const slot = await renderBoard({
      stored: "expand:done",
      rpc: {
        listBriefCards: () => ({
          cards: [card({ status, nextStep: status === "done" ? "" : "Push" })],
          staleAfterMs: 0,
          archiveAfterMs: 0,
        }),
      },
    });
    await waitFor(() =>
      expect(column(slot, "Implementation").getByText("Board thread")).toBeTruthy(),
    );
    status = "done";
    await slot.behavior.emitRealtime("briefs-changed", { at: 1 });
    await waitFor(() =>
      expect(column(slot, "Done").getByText("Board thread")).toBeTruthy(),
    );
    slot.lifecycle.unmount();
  });
});

describe("the filters", () => {
  it("applies a chosen status, and remembers it", async () => {
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    const chip = slot.getByRole("button", { name: /Waiting on you/ });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(
      slot.getByRole("button", { name: /Waiting on you/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(slot.getByRole("button", { name: "Clear" })).toBeTruthy();
    expect(storedView()).toBe("status:waiting-on-me");
    slot.lifecycle.unmount();
  });

  it("reopens on the view it was left on", async () => {
    const slot = await renderBoard({ stored: "status:done" });
    await waitFor(() => expect(slot.getByRole("region", { name: "Done" })).toBeTruthy());
    // Only the columns a done filter can ever fill: an empty column under a
    // filter reads as "nothing here" when the filter is what emptied it.
    expect(slot.queryByRole("region", { name: "Implementation" })).toBeNull();
    expect(slot.queryByRole("region", { name: "No stage" })).toBeNull();
    // The only column on the board is never a rail: there would be nothing left
    // to read of the filter you just asked for.
    expect(
      slot.queryByRole("button", { name: "Show the Done column" }),
    ).toBeNull();
    slot.lifecycle.unmount();
  });

  it("filters by project, and offers projects only when there is a choice", async () => {
    const single = await renderBoard();
    await waitFor(() => expect(single.getByText("Board thread")).toBeTruthy());
    expect(single.queryByRole("button", { name: /Alpha/ })).toBeNull();
    single.lifecycle.unmount();

    const slot = await renderBoard({
      threads: [
        thread({}),
        thread({
          id: "thr_2",
          projectId: "proj_beta",
          displayTitle: "Beta thread",
        }),
      ],
      cards: [card(), card({ threadId: "thr_2" })],
      projects: [project("proj_alpha", "Alpha"), project("proj_beta", "Beta")],
    });
    await waitFor(() => expect(slot.getByText("Beta thread")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: /Beta/ }));
    expect(slot.queryByText("Board thread")).toBeNull();
    expect(slot.getByText("Beta thread")).toBeTruthy();
    expect(storedView()).toBe("project:proj_beta");
    slot.lifecycle.unmount();
  });

  it("leaves the rails alone when a filter changes", async () => {
    // The two are independent readings of the same board: clearing a filter is
    // not a request to close Done again.
    const slot = await renderBoard({ stored: "status:waiting-on-me/expand:done" });
    await waitFor(() => expect(slot.getByRole("button", { name: "Clear" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    expect(
      slot.queryByRole("button", { name: "Show the Done column" }),
    ).toBeNull();
    expect(storedView()).toBe("expand:done");
    slot.lifecycle.unmount();
  });

  it("clears back to the unfiltered board", async () => {
    const slot = await renderBoard({ stored: "status:done" });
    await waitFor(() => expect(slot.getByRole("button", { name: "Clear" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    expect(slot.getByRole("region", { name: "Implementation" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(storedView()).toBe("");
    slot.lifecycle.unmount();
  });
});

describe("dragging a card", () => {
  /** One HTML5 drag, as the browser sequences it. */
  const drag = (slot: RenderedSlot, title: string, columnName: string) => {
    const cardElement = slot.getByText(title).closest("article");
    if (cardElement === null) throw new Error("no card");
    const dataTransfer = {
      setData: () => {},
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(cardElement, { dataTransfer });
    const target = slot.getByRole("region", { name: columnName });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
  };

  it("pins the stage you drop it on", async () => {
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    drag(slot, "Board thread", "Review");
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter(
          (entry) => entry.method === "setStageOverride",
        ),
      ).toEqual([
        {
          method: "setStageOverride",
          input: { threadId: "thr_1", stage: "review" },
        },
      ]),
    );
    slot.lifecycle.unmount();
  });

  // Done is a rail by default, so this is also the test that a collapsed column
  // is still a drop target — dropping a card there is how you finish it by hand.
  it("pins done when you drop it on the terminal column", async () => {
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    drag(slot, "Board thread", "Done");
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter(
          (entry) => entry.method === "setStatusOverride",
        ),
      ).toEqual([
        {
          method: "setStatusOverride",
          input: { threadId: "thr_1", status: "done" },
        },
      ]),
    );
    slot.lifecycle.unmount();
  });

  it("writes nothing when the card is dropped where it already is", async () => {
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    drag(slot, "Board thread", "Implementation");
    expect(
      slot.inspection.rpcCalls.filter((entry) =>
        entry.method.startsWith("set"),
      ),
    ).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("writes nothing when a briefless card is dragged", async () => {
    const slot = await renderBoard({ cards: [] });
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    drag(slot, "Board thread", "Review");
    expect(
      slot.inspection.rpcCalls.filter((entry) =>
        entry.method.startsWith("set"),
      ),
    ).toEqual([]);
    slot.lifecycle.unmount();
  });
});

describe("the expanded card", () => {
  it("shows the rest of the brief and both pin controls", async () => {
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Show the whole brief" }));

    await waitFor(() => expect(slot.getByText("Ship the board")).toBeTruthy());
    expect(slot.getByText("Columns render")).toBeTruthy();
    expect(slot.getByText("One slot per sidebar row")).toBeTruthy();
    // The touch path: drag-and-drop is a pointer affordance, so the same two
    // writes have to be reachable as taps.
    expect(slot.getByRole("button", { name: "Review", pressed: false })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("pins a stage from the control", async () => {
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Show the whole brief" }));
    await waitFor(() => expect(slot.getByText("Ship the board")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Review", pressed: false }));

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter(
          (entry) => entry.method === "setStageOverride",
        ),
      ).toEqual([
        {
          method: "setStageOverride",
          input: { threadId: "thr_1", stage: "review" },
        },
      ]),
    );
    slot.lifecycle.unmount();
  });
});
