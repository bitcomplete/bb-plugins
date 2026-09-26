// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { BriefState, RowSignal } from "./contract.js";

const READY: BriefState = {
  state: "ready",
  brief: {
    threadId: "thr_1",
    goal: "Ship the thread-briefs plugin",
    currentState: "Server and app written",
    nextStep: "Push the branch",
    // Empty fields must not render a heading.
    blockedOn: "",
    constraints: "bb has no additive per-row sidebar slot",
    stage: "review",
    status: "waiting-on-me",
    stageOverride: null,
    lastSummarizedAt: 1_000,
  },
};

const sidebarThread = (
  overrides: Partial<PluginSidebarThread>,
): PluginSidebarThread =>
  ({
    id: "thr_1",
    hasPendingInteraction: false,
    ...overrides,
  }) as PluginSidebarThread;

let app: CapturedPluginApp | null = null;
const loadApp = async () => {
  app ??= await loadPluginApp(() => import("./app.js"));
  return app;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registrations", () => {
  it("registers the overlay, header action and content script", async () => {
    const captured = await loadApp();
    expect(captured.appOverlays.map((entry) => entry.id)).toEqual(["brief-sync"]);
    expect(captured.threadHeaderActions.map((entry) => entry.id)).toEqual(["brief"]);
    expect(captured.contentScripts.map((entry) => entry.id)).toEqual(["row-glyphs"]);
    // Nothing may register a thread list: replacing bb's sidebar is out of scope.
    expect(captured.threadLists).toEqual([]);
  });
});

describe("the header popover", () => {
  const render = async (options: {
    getBrief?: () => BriefState;
    setStageOverride?: (input: unknown) => BriefState;
    refresh?: () => { queued: boolean };
  }) => {
    const captured = await loadApp();
    return renderSlot(
      captured.threadHeaderActions[0]!,
      { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false },
      {
        rpc: {
          getBrief: options.getBrief ?? (() => READY),
          setStageOverride: options.setStageOverride ?? (() => READY),
          refresh: options.refresh ?? (() => ({ queued: true })),
          listRowSignals: () => ({ signals: [] }),
        },
      },
    );
  };

  it("shows the populated fields and skips the empty ones", async () => {
    const slot = await render({});
    fireEvent.click(await slot.findByRole("button", { name: "Thread brief" }));

    expect(await slot.findByText("Ship the thread-briefs plugin")).toBeTruthy();
    expect(await slot.findByText("Server and app written")).toBeTruthy();
    expect(await slot.findByText("Push the branch")).toBeTruthy();
    expect(slot.queryByText("Blocked on")).toBeNull();
    expect(await slot.findByText("Waiting on you")).toBeTruthy();

    slot.lifecycle.unmount();
  });

  it("does not fetch the brief until the popover is opened", async () => {
    const slot = await render({});
    await waitFor(() => expect(slot.inspection.rpcCalls).toEqual([]));
    slot.lifecycle.unmount();
  });

  it("says so while a brief is still being summarized", async () => {
    const slot = await render({ getBrief: () => ({ state: "summarizing" }) });
    fireEvent.click(await slot.findByRole("button", { name: "Thread brief" }));
    expect(await slot.findByText("Summarizing…")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("offers to summarize a thread that has no brief, rather than spinning", async () => {
    const slot = await render({ getBrief: () => ({ state: "absent" }) });
    fireEvent.click(await slot.findByRole("button", { name: "Thread brief" }));

    expect(await slot.findByText("No brief for this thread yet.")).toBeTruthy();
    // A dormant thread is never backfilled, so "Summarizing…" would never resolve.
    expect(slot.queryByText("Summarizing…")).toBeNull();

    fireEvent.click(await slot.findByRole("button", { name: "Summarize now" }));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some((call) => call.method === "refresh"),
      ).toBe(true),
    );
    slot.lifecycle.unmount();
  });

  it("surfaces the unconfigured message instead of an empty brief", async () => {
    const slot = await render({
      getBrief: () => ({ state: "unconfigured", message: "Add an API key." }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Thread brief" }));
    expect(await slot.findByText("Add an API key.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("reports a thread with no next step as done rather than inventing one", async () => {
    const slot = await render({
      getBrief: () => ({
        state: "ready",
        brief: { ...READY.brief!, nextStep: "", status: "done" },
      }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Thread brief" }));
    expect(await slot.findByText("No next step — this thread reads as done.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("sets a manual stage", async () => {
    const slot = await render({});
    fireEvent.click(await slot.findByRole("button", { name: "Thread brief" }));
    fireEvent.click(await slot.findByRole("button", { name: "Planning" }));

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (call) =>
            call.method === "setStageOverride" &&
            (call.input as { stage: string }).stage === "planning",
        ),
      ).toBe(true),
    );
    slot.lifecycle.unmount();
  });

  it("clears the override when the active manual stage is picked again", async () => {
    const overridden: BriefState = {
      state: "ready",
      brief: { ...READY.brief!, stage: "planning", stageOverride: "planning" },
    };
    const slot = await render({ getBrief: () => overridden });
    fireEvent.click(await slot.findByRole("button", { name: "Thread brief" }));
    fireEvent.click(await slot.findByRole("button", { name: /Planning/u }));

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (call) =>
            call.method === "setStageOverride" &&
            (call.input as { stage: string | null }).stage === null,
        ),
      ).toBe(true),
    );
    slot.lifecycle.unmount();
  });
});

describe("sidebar row glyphs", () => {
  const signal = (overrides: Partial<RowSignal> = {}): RowSignal => ({
    threadId: "thr_1",
    status: "done",
    stage: "review",
    label: "Done — Review",
    ...overrides,
  });

  /**
   * The overlay owns the data and the content script owns the setter, so a
   * realistic test mounts both against one loaded app.
   */
  const mountBoth = async (options: {
    signals: RowSignal[];
    threads?: PluginSidebarThread[];
    omitSetter?: boolean;
  }) => {
    const captured = await loadApp();
    const scripts = await mountPluginContentScripts(captured, {
      pluginId: "thread-briefs",
      ...(options.omitSetter === true
        ? { omitExperimentalThreadRowStatus: true }
        : {}),
    });
    const slot = renderSlot(
      captured.appOverlays[0]!,
      {},
      {
        rpc: { listRowSignals: () => ({ signals: options.signals }) },
        sidebarThreads: {
          threads: options.threads ?? [sidebarThread({ id: "thr_1" })],
        },
      },
    );
    return { scripts, slot };
  };

  it("paints the done glyph on the row", async () => {
    const { scripts, slot } = await mountBoth({ signals: [signal()] });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: "CircleCheck",
        label: "Done — Review",
        tone: "success",
      }),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("leaves a merely working thread to bb's own indicator", async () => {
    const { scripts, slot } = await mountBoth({
      signals: [signal({ status: "working", label: "Working — Review" })],
    });

    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(scripts.inspection.getThreadRowStatus("thr_1")).toBeNull();

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("upgrades a working thread whose row has a pending interaction", async () => {
    const { scripts, slot } = await mountBoth({
      signals: [signal({ status: "working", label: "Working — Review" })],
      threads: [sidebarThread({ id: "thr_1", hasPendingInteraction: true })],
    });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: "MessageQuestion",
        label: "Waiting on you — Review",
        tone: "default",
      }),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("clears its glyphs on dispose", async () => {
    const { scripts, slot } = await mountBoth({ signals: [signal()] });
    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).not.toBeNull(),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();

    // No glyph may survive the generation, whether the host cleared it or the
    // script's own disposer did.
    expect(scripts.inspection.getThreadRowStatus("thr_1")).toBeNull();
  });

  it("does not throw on a host without the row-status setter", async () => {
    const { scripts, slot } = await mountBoth({
      signals: [signal()],
      omitSetter: true,
    });
    expect(scripts.inspection.mountedIds).toEqual(["row-glyphs"]);
    expect(scripts.inspection.threadRowStatusCalls).toEqual([]);

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });
});
