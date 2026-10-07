// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import { useComposer, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import type { BriefState, RowSignal } from "./contract.js";
import {
  BRIEF_STAGES,
  BRIEFS_CHANGED_CHANNEL,
  PROJECT_RING_HUES,
  projectColorIndex,
} from "./shared.js";
import {
  doneRingIcon,
  staleDoneRingIcon,
  stageRingIcon,
  STALE_DONE_RING_ICON,
} from "./brief.js";


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
    statusOverride: null,
    blockReason: null,
    lastSummarizedAt: 1_000,
  },
};

const sidebarThread = (
  overrides: Partial<PluginSidebarThread>,
): PluginSidebarThread =>
  ({
    id: "thr_1",
    status: "idle",
    hasPendingInteraction: false,
    projectId: "proj_alpha",
    // Freshly active unless a test says otherwise, so every existing
    // expectation is also an assertion that a done row keeps its project
    // colour until it has actually gone cold.
    latestAttentionAt: Date.now(),
    ...overrides,
  }) as PluginSidebarThread;

/** The ring `proj_alpha` hashes to, which every default fixture thread draws. */
const ALPHA = projectColorIndex("proj_alpha");

const DAY = 24 * 60 * 60 * 1000;

let app: CapturedPluginApp | null = null;
const loadApp = async () => {
  app ??= await loadPluginApp(() => import("./app.js"));
  return app;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registrations", () => {
  it("registers the overlay, panel action, header action and content script", async () => {
    const captured = await loadApp();
    expect(captured.appOverlays.map((entry) => entry.id)).toEqual(["brief-sync"]);
    expect(captured.threadPanelActions.map((entry) => entry.id)).toEqual(["brief"]);
    expect(captured.threadHeaderActions.map((entry) => entry.id)).toEqual(["brief"]);
    expect(captured.contentScripts.map((entry) => entry.id)).toEqual(["row-glyphs"]);
    // Nothing may register a thread list: replacing bb's sidebar is out of scope.
    expect(captured.threadLists).toEqual([]);
  });

  it("registers a ring for every stage, plus the closed one for done", async () => {
    // A stage with no artwork would draw bb's Zap fallback on the row, which is
    // why the names are mapped off BRIEF_STAGES rather than listed.
    const captured = await loadApp();
    expect(captured.icons.slice(0, 5).map((entry) => entry.name)).toEqual([
      "thread-briefs/stage-discovery",
      "thread-briefs/stage-planning",
      "thread-briefs/stage-implementation",
      "thread-briefs/stage-review",
      "thread-briefs/done",
    ]);
  });

  it("registers every ring again in each palette colour", async () => {
    // The registry is filled at init, before any project is known, so a colour
    // a project hashes to later has to already be there. Asserted against the
    // same name builders the decoration calls, so the two cannot drift.
    const captured = await loadApp();
    const names = new Set(captured.icons.map((entry) => entry.name));
    for (let colorIndex = 0; colorIndex < PROJECT_RING_HUES.length; colorIndex += 1) {
      for (const stage of BRIEF_STAGES) {
        expect(names).toContain(stageRingIcon(stage, colorIndex));
      }
      expect(names).toContain(doneRingIcon(colorIndex));
    }
    // Every ring in every colour, each with and without the pin dot, plus the
    // grey done ring — two, because grey replaces a project's hue rather than
    // varying with it, and only the pin still varies.
    expect(names).toContain(STALE_DONE_RING_ICON);
    expect(names).toContain(staleDoneRingIcon(true));
    expect(captured.icons).toHaveLength(
      (BRIEF_STAGES.length + 1) * 2 * (PROJECT_RING_HUES.length + 1) + 2,
    );
  });

  it("registers a pinned twin of every ring, dot included", async () => {
    const captured = await loadApp();
    const names = new Set(captured.icons.map((entry) => entry.name));
    for (const stage of BRIEF_STAGES) {
      expect(names).toContain(stageRingIcon(stage, undefined, true));
      expect(names).toContain(stageRingIcon(stage, 3, true));
    }
    expect(names).toContain(doneRingIcon(undefined, true));
    expect(names).toContain(doneRingIcon(3, true));
  });

  /** The artwork one registered icon draws, rendered on its own. */
  const drawIcon = async (name: string) => {
    const captured = await loadApp();
    const entry = captured.icons.find((icon) => icon.name === name)!;
    const Artwork = entry.component;
    const { container } = render(<Artwork />);
    const paths = Array.from(container.querySelectorAll("path"));
    const circles = Array.from(container.querySelectorAll("circle"));
    return {
      quarters: paths.length,
      solid: paths.filter((path) => path.getAttribute("opacity") === "1").length,
      // The dot is filled; the outer ring is stroked. Telling them apart is
      // the point of the test below.
      hasDot: circles.some((circle) => circle.getAttribute("fill") !== null),
      hasOuterRing: circles.some(
        (circle) => circle.getAttribute("stroke") !== null,
      ),
    };
  };

  it("draws each stage ring one quarter fuller than the last", async () => {
    // Reading the ring means reading where the fill stops, so the count is the
    // whole glyph: an off-by-one puts a thread a stage ahead of where it is.
    for (const [name, solid] of [
      ["thread-briefs/stage-discovery", 1],
      ["thread-briefs/stage-planning", 2],
      ["thread-briefs/stage-implementation", 3],
      ["thread-briefs/stage-review", 4],
    ] as const) {
      expect(await drawIcon(name)).toMatchObject({ quarters: 4, solid });
    }
  });

  it("rings the done ring, so it is not just the review ring again", async () => {
    // Both close the ring, because done is not a fifth stage. At 16px the
    // thin outer ring is the only thing telling them apart — and the centre
    // stays free for the pin, so a plain done ring has no dot.
    expect(await drawIcon("thread-briefs/done")).toMatchObject({
      solid: 4,
      hasOuterRing: true,
      hasDot: false,
    });
    expect(await drawIcon("thread-briefs/stage-review")).toMatchObject({
      solid: 4,
      hasOuterRing: false,
      hasDot: false,
    });
  });

  it("dots the centre of a pinned ring and nothing else about it", async () => {
    // The dot is the one mark on the row the model did not decide. It has to
    // be additive: a pinned done thread shows both the outer ring and the dot.
    expect(await drawIcon("thread-briefs/stage-planning-pinned")).toMatchObject({
      solid: 2,
      hasOuterRing: false,
      hasDot: true,
    });
    expect(await drawIcon("thread-briefs/done-pinned")).toMatchObject({
      solid: 4,
      hasOuterRing: true,
      hasDot: true,
    });
    expect(await drawIcon(staleDoneRingIcon(true))).toMatchObject({
      hasOuterRing: true,
      hasDot: true,
    });
  });

  it("labels the tab the same way from the launcher as from the header", async () => {
    const captured = await loadApp();
    const action = captured.threadPanelActions[0]!;
    const opens: Array<string | undefined> = [];
    action.run!({
      threadId: "thr_1",
      openPanel: (options) => {
        opens.push(options?.title);
        return true;
      },
    });
    expect(opens).toEqual(["Brief"]);
  });
});

/**
 * The button holds no brief state: its whole job is to open the panel tab. That
 * is what keeps the brief one click from the same place on every thread, since
 * panel tabs are per-thread and per-device.
 */
describe("the header button", () => {
  const render = async (options: { isCompactViewport?: boolean } = {}) => {
    const captured = await loadApp();
    return renderSlot(
      captured.threadHeaderActions[0]!,
      {
        threadId: "thr_1",
        projectId: "proj_1",
        isCompactViewport: options.isCompactViewport ?? false,
      },
      { openThreadPanel: () => true },
    );
  };

  it("opens the brief panel tab", async () => {
    const slot = await render();
    fireEvent.click(await slot.findByRole("button", { name: "Thread brief" }));

    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "openThreadPanel",
        options: { actionId: "brief", title: "Brief" },
      },
    ]);
    slot.lifecycle.unmount();
  });

  it("never fetches a brief of its own", async () => {
    // The header mounts for every visible thread, including both panes of a
    // split; the panel mounts only while its tab is on screen.
    const slot = await render();
    fireEvent.click(await slot.findByRole("button", { name: "Thread brief" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toEqual([]));
    slot.lifecycle.unmount();
  });

  it("drops the label on a compact viewport but keeps the control", async () => {
    const slot = await render({ isCompactViewport: true });
    expect(await slot.findByRole("button", { name: "Thread brief" })).toBeTruthy();
    expect(slot.queryByText("Brief")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("the brief panel", () => {
  const render = async (options: {
    getBrief?: () => BriefState;
    setStageOverride?: (input: unknown) => BriefState;
    setStatusOverride?: (input: unknown) => BriefState;
    refresh?: () => { queued: boolean };
  }) => {
    const captured = await loadApp();
    return renderSlot(
      captured.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getBrief: options.getBrief ?? (() => READY),
          setStageOverride: options.setStageOverride ?? (() => READY),
          setStatusOverride: options.setStatusOverride ?? (() => READY),
          refresh: options.refresh ?? (() => ({ queued: true })),
          listRowSignals: () => ({
            signals: [],
            staleAfterMs: 0,
            archiveAfterMs: 0,
          }),
        },
      },
    );
  };

  it("shows the populated fields and skips the empty ones", async () => {
    const slot = await render({});

    // No click anywhere: the tab being on screen is the request.
    expect(await slot.findByText("Ship the thread-briefs plugin")).toBeTruthy();
    expect(await slot.findByText("Server and app written")).toBeTruthy();
    expect(await slot.findByText("Push the branch")).toBeTruthy();
    expect(slot.queryByText("Blocked on")).toBeNull();
    // Twice over: the status line at the top, and the control that changes it.
    expect(await slot.findAllByText("Waiting on you")).toHaveLength(2);

    slot.lifecycle.unmount();
  });

  it("says how old the brief is, which a panel left open cannot assume", async () => {
    const slot = await render({
      getBrief: () => ({
        state: "ready",
        brief: { ...READY.brief!, lastSummarizedAt: Date.now() },
      }),
    });
    expect(await slot.findByText("Summarized just now")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("says so while a brief is still being summarized", async () => {
    const slot = await render({ getBrief: () => ({ state: "summarizing" }) });
    expect(await slot.findByText("Summarizing…")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("offers to summarize a thread that has no brief, rather than spinning", async () => {
    const slot = await render({ getBrief: () => ({ state: "absent" }) });

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
    expect(await slot.findByText("No next step — this thread reads as done.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("reloads when the server announces a new brief", async () => {
    let goal = "Ship the thread-briefs plugin";
    const slot = await render({
      getBrief: () => ({ state: "ready", brief: { ...READY.brief!, goal } }),
    });
    expect(await slot.findByText(goal)).toBeTruthy();

    goal = "Move the brief into the side panel";
    await slot.behavior.emitRealtime(BRIEFS_CHANGED_CHANNEL, {});
    expect(await slot.findByText(goal)).toBeTruthy();

    slot.lifecycle.unmount();
  });

  it("sets a manual stage", async () => {
    const slot = await render({});
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

  it("pins a status by hand, which is the only way to close this thread", async () => {
    // "Push the branch" is a next step nobody can record as taken from inside
    // the thread, so the derivation says waiting-on-me until somebody says
    // otherwise.
    const slot = await render({});
    fireEvent.click(await slot.findByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (call) =>
            call.method === "setStatusOverride" &&
            (call.input as { status: string }).status === "done",
        ),
      ).toBe(true),
    );
    slot.lifecycle.unmount();
  });

  it("clears the pin when the active manual status is picked again", async () => {
    const pinned: BriefState = {
      state: "ready",
      brief: { ...READY.brief!, status: "done", statusOverride: "done" },
    };
    const slot = await render({ getBrief: () => pinned });
    fireEvent.click(await slot.findByRole("button", { name: /Done/u }));

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (call) =>
            call.method === "setStatusOverride" &&
            (call.input as { status: string | null }).status === null,
        ),
      ).toBe(true),
    );
    slot.lifecycle.unmount();
  });

  it("asks why when Blocked is pinned, and writes the reason on its own", async () => {
    // Pick Blocked, say why: the park gesture. The pin is written on the click
    // and the editor opens for the reason, which is written separately so the
    // pin does not wait on typing.
    const pinned: BriefState = {
      state: "ready",
      brief: {
        ...READY.brief!,
        status: "waiting-on-other",
        statusOverride: "waiting-on-other",
      },
    };
    const slot = await render({ getBrief: () => pinned });
    const input = await slot.findByPlaceholderText(/waiting on the design review/u);
    fireEvent.change(input, { target: { value: "not before the release" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (call) =>
            call.method === "setBlockReason" &&
            (call.input as { text: string }).text === "not before the release",
        ),
      ).toBe(true),
    );
    slot.lifecycle.unmount();
  });

  it("shows the reason as your note, and clears it", async () => {
    const noted: BriefState = {
      state: "ready",
      brief: {
        ...READY.brief!,
        status: "waiting-on-other",
        blockedOn: "the release",
        blockReason: { text: "not before the release", recordedAt: 1_000 },
      },
    };
    const slot = await render({ getBrief: () => noted });
    expect(await slot.findByText("not before the release")).toBeTruthy();
    expect(slot.getByText(/Your note/u)).toBeTruthy();
    // The model's own reading still has its slot, labelled as the brief's.
    expect(slot.getByText("Blocked on")).toBeTruthy();
    expect(slot.getByText("the release")).toBeTruthy();

    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (call) =>
            call.method === "setBlockReason" &&
            (call.input as { text: string | null }).text === null,
        ),
      ).toBe(true),
    );
    slot.lifecycle.unmount();
  });

  it("offers no reason editor on a thread the model read as blocked, only a way in", async () => {
    const modelBlocked: BriefState = {
      state: "ready",
      brief: { ...READY.brief!, status: "waiting-on-other", blockedOn: "CI" },
    };
    const slot = await render({ getBrief: () => modelBlocked });
    expect(await slot.findByText("Add a reason…")).toBeTruthy();
    expect(slot.queryByPlaceholderText(/design review/u)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("says when the status came from you rather than from the brief", async () => {
    // A "Done" heading over a live next step otherwise reads as a bug.
    const slot = await render({
      getBrief: () => ({
        state: "ready",
        brief: { ...READY.brief!, status: "done", statusOverride: "done" },
      }),
    });
    expect(
      await slot.findByText(/Status set by hand to Done/u),
    ).toBeTruthy();
    expect(slot.queryByText("No next step — this thread reads as done.")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("sidebar row glyphs", () => {
  const signal = (overrides: Partial<RowSignal> = {}): RowSignal => ({
    threadId: "thr_1",
    status: "done",
    stage: "review",
    label: "Review — Done",
    pinned: false,
    ...overrides,
  });

  /**
   * The overlay owns the data and the content script owns the setter, so a
   * realistic test mounts both against one loaded app.
   */
  const mountBoth = async (options: {
    signals: RowSignal[];
    threads?: PluginSidebarThread[];
    projects?: { id: string; name: string }[];
    omitSetter?: boolean;
    staleAfterMs?: number;
    archiveAfterMs?: number;
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
        rpc: {
          listRowSignals: () => ({
            signals: options.signals,
            staleAfterMs: options.staleAfterMs ?? DAY,
            archiveAfterMs: options.archiveAfterMs ?? 2 * DAY,
          }),
        },
        sidebarThreads: {
          threads: options.threads ?? [sidebarThread({ id: "thr_1" })],
          projects: (options.projects ?? [
            { id: "proj_alpha", name: "Alpha" },
          ]) as never,
        },
      },
    );
    return { scripts, slot };
  };

  it("paints the closed ring on a finished row", async () => {
    const { scripts, slot } = await mountBoth({ signals: [signal()] });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: doneRingIcon(ALPHA),
        label: "Review — Done (Alpha)",
        tone: "default",
      }),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("greys a done row that has gone cold, taking its project colour away", async () => {
    // The warning light for the auto-archive that follows. Grey replaces the
    // hue rather than joining it: the row has one channel, and a thread about
    // to leave the sidebar has no use for the colour that says whose it is.
    const { scripts, slot } = await mountBoth({
      signals: [signal()],
      threads: [
        sidebarThread({ id: "thr_1", latestAttentionAt: Date.now() - 2 * DAY }),
      ],
    });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: STALE_DONE_RING_ICON,
        // The grey says nothing on its own, so the label is where "why has this
        // one gone flat, and what happens next" gets answered.
        label: "Review — Done · idle 2 days, archiving soon (Alpha)",
        tone: "default",
      }),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("does not promise an archiving that is switched off", async () => {
    const { scripts, slot } = await mountBoth({
      signals: [signal()],
      threads: [
        sidebarThread({ id: "thr_1", latestAttentionAt: Date.now() - 2 * DAY }),
      ],
      archiveAfterMs: 0,
    });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: STALE_DONE_RING_ICON,
        label: "Review — Done · idle 2 days (Alpha)",
        tone: "default",
      }),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("leaves an unfinished row its colour however long it has sat", async () => {
    // Staleness is a fact about a finished thread. An old thread still waiting
    // on you is the opposite of something to fade out.
    const { scripts, slot } = await mountBoth({
      signals: [
        signal({ status: "waiting-on-me", label: "Review — Waiting on you" }),
      ],
      threads: [
        sidebarThread({ id: "thr_1", latestAttentionAt: Date.now() - 30 * DAY }),
      ],
    });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: stageRingIcon("review", ALPHA),
        label: "Review — Waiting on you (Alpha)",
        tone: "default",
      }),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("keeps every done ring coloured when greying is switched off", async () => {
    const { scripts, slot } = await mountBoth({
      signals: [signal()],
      threads: [
        sidebarThread({ id: "thr_1", latestAttentionAt: Date.now() - 90 * DAY }),
      ],
      staleAfterMs: 0,
    });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: doneRingIcon(ALPHA),
        label: "Review — Done (Alpha)",
        tone: "default",
      }),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("paints the stage ring on an unfinished row", async () => {
    const { scripts, slot } = await mountBoth({
      signals: [
        signal({
          status: "waiting-on-me",
          stage: "planning",
          label: "Planning — Waiting on you",
        }),
      ],
    });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: stageRingIcon("planning", ALPHA),
        label: "Planning — Waiting on you (Alpha)",
        tone: "default",
      }),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("leaves a running thread to bb's own indicator", async () => {
    // Live working outranks the brief, and working draws no glyph.
    const { scripts, slot } = await mountBoth({
      signals: [signal({ status: "waiting-on-other", label: "Review — Blocked" })],
      threads: [sidebarThread({ id: "thr_1", status: "active" })],
    });

    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(scripts.inspection.getThreadRowStatus("thr_1")).toBeNull();

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("draws the brief's glyph once the thread is no longer running", async () => {
    const { scripts, slot } = await mountBoth({
      signals: [signal({ status: "waiting-on-me", label: "Review — Waiting on you" })],
      threads: [sidebarThread({ id: "thr_1", status: "idle" })],
    });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: stageRingIcon("review", ALPHA),
        label: "Review — Waiting on you (Alpha)",
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

  it("colours each row by project once the sidebar holds more than one", async () => {
    // The whole point of the setting that brings us here: status grouping
    // takes the sidebar's project grouping away, so the ring gives it back.
    const { scripts, slot } = await mountBoth({
      signals: [
        signal({ threadId: "thr_1", status: "waiting-on-me", stage: "review" }),
        signal({ threadId: "thr_2", status: "waiting-on-me", stage: "review" }),
      ],
      threads: [
        sidebarThread({ id: "thr_1", projectId: "proj_alpha" } as never),
        sidebarThread({ id: "thr_2", projectId: "proj_beta" } as never),
      ],
      projects: [
        { id: "proj_alpha", name: "Alpha" },
        { id: "proj_beta", name: "Beta" },
      ],
    });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: stageRingIcon("review", projectColorIndex("proj_alpha")),
        label: "Review — Waiting on you (Alpha)",
        tone: "default",
      }),
    );
    // Same stage, same status, same artwork — told apart by hue alone.
    expect(scripts.inspection.getThreadRowStatus("thr_2")).toEqual({
      icon: stageRingIcon("review", projectColorIndex("proj_beta")),
      label: "Review — Waiting on you (Beta)",
      tone: "default",
    });

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("colours a lone project's rows too, rather than waiting for a second", async () => {
    // Unconditional: a colour that only appeared once a second project showed
    // up would change every ring on the list without any thread having changed.
    const { scripts, slot } = await mountBoth({
      signals: [signal({ threadId: "thr_1" })],
      threads: [sidebarThread({ id: "thr_1", projectId: "proj_alpha" } as never)],
      projects: [{ id: "proj_alpha", name: "Alpha" }],
    });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: doneRingIcon(ALPHA),
        label: "Review — Done (Alpha)",
        tone: "default",
      }),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("leaves a projectless thread its neutral ring instead of dropping the pass", async () => {
    // Every row is painted in one pass, so a thread the host handed us with no
    // project must not cost the rows around it their glyphs.
    const { scripts, slot } = await mountBoth({
      signals: [signal({ threadId: "thr_1" }), signal({ threadId: "thr_2" })],
      threads: [
        sidebarThread({ id: "thr_1", projectId: undefined } as never),
        sidebarThread({ id: "thr_2", projectId: "proj_alpha" } as never),
      ],
    });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_2")?.icon).toBe(
        doneRingIcon(ALPHA),
      ),
    );
    expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
      icon: "thread-briefs/done",
      label: "Review — Done",
      tone: "default",
    });

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
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

/**
 * The count on the board's own sidebar row. It is the reason to open the board,
 * and it costs no request: the overlay has already folded the briefs against the
 * live thread list to draw the row glyphs, so the badge reads the same store the
 * content script does.
 */
describe("the board's sidebar badge", () => {
  const mountBoth = async (options: {
    signals: RowSignal[];
    threads?: PluginSidebarThread[];
  }) => {
    const captured = await loadApp();
    const overlay = renderSlot(
      captured.appOverlays[0]!,
      {},
      {
        rpc: {
          listRowSignals: () => ({
            signals: options.signals,
            staleAfterMs: 0,
            archiveAfterMs: 0,
          }),
        },
        sidebarThreads: {
          threads: options.threads ?? [sidebarThread({ id: "thr_1" })],
          projects: [{ id: "proj_alpha", name: "Alpha" }] as never,
        },
      },
    );
    const Accessory = captured.navPanels[0]!.experimental_sidebarAccessory!;
    const badge = renderSlot({ component: Accessory }, {});
    return { overlay, badge };
  };

  const waiting = (threadId: string): RowSignal => ({
    threadId,
    status: "waiting-on-me",
    stage: "planning",
    label: "Planning — Waiting on you",
    pinned: false,
  });

  it("counts the threads waiting on you", async () => {
    const { overlay, badge } = await mountBoth({
      signals: [waiting("thr_1"), waiting("thr_2")],
      threads: [
        sidebarThread({ id: "thr_1" }),
        sidebarThread({ id: "thr_2" }),
      ],
    });
    await waitFor(() =>
      expect(
        badge.getByRole("status", { name: "2 threads waiting on you" }),
      ).toBeTruthy(),
    );
    badge.lifecycle.unmount();
    overlay.lifecycle.unmount();
  });

  it("does not count a thread the sidebar is not showing", async () => {
    // Archiving a thread keeps its brief, so the kv scan still returns the
    // signal. The board draws only the sidebar's threads, and the badge on the
    // way to it must agree with what it opens onto.
    const { overlay, badge } = await mountBoth({
      signals: [waiting("thr_1"), waiting("thr_archived")],
      threads: [sidebarThread({ id: "thr_1" })],
    });
    await waitFor(() =>
      expect(
        badge.getByRole("status", { name: "1 thread waiting on you" }),
      ).toBeTruthy(),
    );
    badge.lifecycle.unmount();
    overlay.lifecycle.unmount();
  });

  it("does not count a thread whose agent is running", async () => {
    // The same live fold the row glyph makes: the agent has it, so it is not
    // waiting on you.
    const { overlay, badge } = await mountBoth({
      signals: [waiting("thr_1")],
      threads: [sidebarThread({ id: "thr_1", status: "active" })],
    });
    await waitFor(() => expect(badge.queryByRole("status")).toBeNull());
    badge.lifecycle.unmount();
    overlay.lifecycle.unmount();
  });

  it("draws nothing when nothing is waiting", async () => {
    // An accessory shares the row's trailing column with the host's own options
    // button, so the only badge worth the space is one that means "look here".
    const { overlay, badge } = await mountBoth({
      signals: [{ ...waiting("thr_1"), status: "done" }],
    });
    await waitFor(() => expect(badge.queryByRole("status")).toBeNull());
    badge.lifecycle.unmount();
    overlay.lifecycle.unmount();
  });
});

describe("the re-entry refresher", () => {
  const STATE = {
    threadId: "thr_1",
    text: "You were wiring the sidebar sections. Run the reconcile.",
    variant: "full" as const,
    attentionAt: 1_700_000_000_000,
  };

  const banner = async () => {
    const captured = await loadApp();
    const customization = captured.composerCustomizations.find(
      (entry) => entry.id === "refresher",
    );
    return customization!.banners![0]!;
  };

  /** The banner alone, in a thread composer. */
  const mount = async (
    options: {
      refresher?: typeof STATE | null;
      isRunning?: boolean;
      probe?: boolean;
    } = {},
  ) => {
    const registration = await banner();
    const Banner = registration.component;
    const component = options.probe === true ? withProbe(Banner) : Banner;
    return renderSlot(
      { component },
      {},
      {
        rpc: {
          getRefresher: () => ({
            refresher:
              options.refresher === undefined ? STATE : options.refresher,
          }),
          dismissRefresher: () => ({ dismissed: true }),
        },
        composer: {
          text: "a draft",
          scope: { kind: "thread", threadId: "thr_1" },
        },
      },
    );
  };

  /**
   * The banner beside a button that submits through the same composer.
   *
   * The harness has no "press Enter" driver, so a send is staged the only way
   * a plugin can stage one: through `submit`, which fires the same
   * submission listeners bb's own send does.
   */
  const withProbe = (Banner: ComponentType) =>
    function BannerWithProbe() {
      const composer = useComposer();
      return (
        <>
          <Banner />
          <button
            type="button"
            onClick={() => void composer.submit({ experimental_data: null })}
          >
            send
          </button>
        </>
      );
    };

  it("registers one thread-scoped banner, and no other composer surface", async () => {
    const captured = await loadApp();
    const customization = captured.composerCustomizations.find(
      (entry) => entry.id === "refresher",
    )!;
    expect(customization.scopes).toEqual(["thread"]);
    expect(customization.banners!.map((entry) => entry.id)).toEqual(["re-entry"]);
    // Bare, never "card". bb wraps every plugin surface in a
    // `data-bb-plugin-root` element, so the host card is never `:empty` and its
    // `empty:hidden` cannot fire — taking it would put an empty bordered box
    // above the composer of every thread in bb, since this banner renders
    // nothing on nearly all of them.
    expect(customization.banners![0]!.chrome).toBe("bare");
    // Nothing else: the refresher must not touch the draft, the + menu or the
    // composer's rich text.
    expect(customization.plusMenu).toBeUndefined();
    expect(customization.richText).toBeUndefined();
    expect(customization.actions).toBeUndefined();
  });

  it("shows the sentence the server chose", async () => {
    const slot = await mount();
    expect(await slot.findByText(STATE.text)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("renders nothing at all when there is nothing to say", async () => {
    // The overwhelmingly common case, and the reason the banner is `bare`: an
    // empty render has to leave no element at all above the composer.
    const slot = await mount({ refresher: null });
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some((call) => call.method === "getRefresher"),
      ).toBe(true),
    );
    expect(slot.container.textContent).toBe("");
    slot.lifecycle.unmount();
  });

  it("asks once and does not keep asking", async () => {
    const slot = await mount();
    await slot.findByText(STATE.text);
    // Deliberately not subscribed to `briefs-changed`: a refresher that faded
    // in while you were already reading would be an interruption.
    await slot.behavior.emitRealtime(BRIEFS_CHANGED_CHANNEL, { at: 1 });
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "getRefresher"),
    ).toHaveLength(1);
    slot.lifecycle.unmount();
  });

  it("goes away when dismissed, and records the cursor it was shown for", async () => {
    const slot = await mount();
    await slot.findByText(STATE.text);

    fireEvent.click(slot.getByLabelText("Dismiss the thread refresher"));

    await waitFor(() => expect(slot.queryByText(STATE.text)).toBeNull());
    expect(
      slot.inspection.rpcCalls.find(
        (call) => call.method === "dismissRefresher",
      )?.input,
      // The cursor the card was shown for, not whatever the thread reads by
      // now: a turn that landed while it was up is activity still unseen.
    ).toEqual({ threadId: "thr_1", attentionAt: STATE.attentionAt });
    slot.lifecycle.unmount();
  });

  it("goes away the moment you send a message", async () => {
    const slot = await mount({ probe: true });
    await slot.findByText(STATE.text);

    fireEvent.click(slot.getByText("send"));

    await waitFor(() => expect(slot.queryByText(STATE.text)).toBeNull());
    expect(
      slot.inspection.rpcCalls.some(
        (call) => call.method === "dismissRefresher",
      ),
    ).toBe(true);
    slot.lifecycle.unmount();
  });

  it("says nothing outside a thread composer", async () => {
    const registration = await banner();
    const slot = renderSlot(
      registration,
      {},
      {
        rpc: {
          getRefresher: () => ({ refresher: STATE }),
          dismissRefresher: () => ({ dismissed: true }),
        },
        composer: { scope: { kind: "new-thread", projectId: "proj_alpha" } },
      },
    );
    await waitFor(() => expect(slot.container.textContent).toBe(""));
    expect(slot.inspection.rpcCalls).toEqual([]);
    slot.lifecycle.unmount();
  });
});
