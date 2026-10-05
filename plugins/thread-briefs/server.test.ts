import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import type { BriefState, StoredBrief } from "./contract.js";

const SUMMARY = {
  goal: "Ship the thread-briefs plugin",
  currentState: "Server, app and tests written",
  nextStep: "Push the branch and install from git",
  blockedOn: "",
  constraints: "bb exposes no additive per-row sidebar slot",
  stage: "review",
  status: "waiting-on-me",
};

function fakeCompletion(body: unknown) {
  // Params are declared so `mock.calls` is a typed tuple, not `[]`.
  return vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(body) } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

const thread = makeThreadResponse({
  id: "thr_1",
  title: "Thread briefs",
  visibility: "visible",
  status: "idle",
});

function host(options: { fetch: ReturnType<typeof fakeCompletion> }) {
  globalThis.fetch = options.fetch as unknown as typeof globalThis.fetch;
  return createFakePluginHost({
    pluginId: "thread-briefs",
    settings: {
      apiKey: "test-key",
      baseUrl: "https://api.test/v1",
      model: "test-model",
      jsonMode: true,
      quietSeconds: 120,
    },
    sdk: {
      threads: {
        get: async () => thread,
        list: async () => [thread],
        output: async () => ({ output: "All set. Want me to push it?" }),
        conversationOutline: async () => ({
          items: [
            { id: "1", role: "user", preview: "Build a briefs plugin", attachmentSummary: null },
            { id: "2", role: "assistant", preview: "Done. Want me to push it?", attachmentSummary: null },
          ],
          maxSeq: 12,
        }),
        interactions: { list: async () => [] },
      },
    },
  });
}

/** A stored brief row, for seeding kv directly. */
function storedBrief(
  threadId: string,
  fields: Partial<StoredBrief["fields"]>,
): StoredBrief {
  return {
    version: 1,
    threadId,
    fields: {
      goal: "Ship sidebar grouping",
      currentState: "Sync written",
      nextStep: "Run the tests",
      blockedOn: "",
      constraints: "",
      ...fields,
    },
    modelStage: "implementation",
    stageOverride: null,
    stageOverrideSeq: null,
    endedWithQuestion: false,
    lastSummarizedAt: 1_000,
    lastActivitySeen: 12,
  };
}

/** The summarizer queue drains off the rpc call, so tests wait on its effect. */
async function waitFor<T>(read: () => Promise<T | null | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the summarizer");
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("registrations", () => {
  it("registers the rpc methods and the backstop sweep", async () => {
    const { bb, harness } = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(bb);

    expect(harness.registrations.rpcMethods).toEqual(
      expect.arrayContaining([
        "getBrief",
        "listRowSignals",
        "listBriefCards",
        "setStageOverride",
        "refresh",
      ]),
    );
    expect(harness.registrations.schedules.map((entry) => entry.name)).toContain(
      "brief-sweep",
    );
    await harness.lifecycle.dispose();
  });

  it("reports needs-configuration without an API key", async () => {
    globalThis.fetch = fakeCompletion(SUMMARY) as unknown as typeof globalThis.fetch;
    const { bb, harness } = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: {},
    });
    await plugin(bb);
    expect(harness.needsConfigurationMessages.join(" ")).toMatch(/apiKey/u);
    await harness.lifecycle.dispose();
  });
});

describe("summarizing", () => {
  let current: Awaited<ReturnType<typeof host>> | null = null;

  beforeEach(() => {
    current = null;
  });

  afterEach(async () => {
    await current?.harness.lifecycle.dispose();
  });

  it("summarizes on refresh and serves the brief over rpc", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    current = host({ fetch: fetchMock });
    await plugin(current.bb);

    await current.harness.behavior.callRpc("refresh", { threadId: "thr_1" });

    const state = await waitFor(async () => {
      const result = (await current!.harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });

    expect(state.state).toBe("ready");
    if (state.state !== "ready") throw new Error("unreachable");
    expect(state.brief.goal).toBe(SUMMARY.goal);
    expect(state.brief.stage).toBe("review");
    // A next step exists and nothing blocks it, but the agent's last message
    // ended in a question.
    expect(state.brief.status).toBe("waiting-on-me");

    // The request went where the settings pointed it.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.test/v1/chat/completions");
    expect(JSON.parse(String(init.body)).model).toBe("test-model");
  });

  it("does not summarize a thread with a brief the moment it goes idle", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    current = host({ fetch: fetchMock });
    await plugin(current.bb);
    // Behind the thread's cursor, so only the quiet period is holding it back.
    await current.bb.storage.kv.set("brief:thr_1", {
      ...storedBrief("thr_1", {}),
      lastActivitySeen: 5,
    });

    await current.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "done",
    });
    // The quiet period has to elapse first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The first brief skips the quiet period, and arrives before the first turn
   * has even finished. Timers are faked because the delays involved are seconds,
   * and asserted on `fetch` rather than by polling: under fake timers the poll
   * in {@link waitFor} would never tick.
   */
  describe("the first brief", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Let the debounce fire and the queue drain. */
    const settle = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await vi.advanceTimersByTimeAsync(0);
    };

    it("skips the quiet period when the thread has no brief", async () => {
      const fetchMock = fakeCompletion(SUMMARY);
      current = host({ fetch: fetchMock });
      await plugin(current.bb);
      vi.useFakeTimers();

      await current.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "done",
      });
      // Well inside the 120s quiet period this host is configured with.
      await settle(6_000);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const stored = await current.bb.storage.kv.get<StoredBrief>("brief:thr_1");
      expect(stored?.fields.goal).toBe(SUMMARY.goal);
    });

    it("stores a done reading beside the suggestion it still carries", async () => {
      const fetchMock = fakeCompletion({ ...SUMMARY, status: "done" });
      current = host({ fetch: fetchMock });
      await plugin(current.bb);
      vi.useFakeTimers();

      await current.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "done",
      });
      await settle(6_000);

      // Stored as the model answered: neither field is rewritten to agree
      // with the other.
      const stored = await current.bb.storage.kv.get<StoredBrief>("brief:thr_1");
      expect(stored?.modelStatus).toBe("done");
      expect(stored?.fields.nextStep).toBe(SUMMARY.nextStep);
      expect(stored?.refresher?.writtenForStatus ?? "done").toBe("done");
    });

    it("summarizes a briefless thread as soon as it starts running", async () => {
      const fetchMock = fakeCompletion(SUMMARY);
      current = host({ fetch: fetchMock });
      await plugin(current.bb);
      vi.useFakeTimers();

      await current.harness.behavior.emitThreadEvent("thread.active", { thread });
      await settle(6_000);

      // A brief describing a turn still in flight, so the row has a ring and a
      // sidebar section the moment that turn ends.
      const stored = await current.bb.storage.kv.get<StoredBrief>("brief:thr_1");
      expect(stored?.fields.goal).toBe(SUMMARY.goal);
    });

    it("leaves a thread that already has a brief alone while it runs", async () => {
      const fetchMock = fakeCompletion(SUMMARY);
      current = host({ fetch: fetchMock });
      await plugin(current.bb);
      await current.bb.storage.kv.set("brief:thr_1", {
        ...storedBrief("thr_1", {}),
        lastActivitySeen: 5,
      });
      vi.useFakeTimers();

      await current.harness.behavior.emitThreadEvent("thread.active", { thread });
      await settle(10_000);

      // Mid-burst is exactly when a brief is not rewritten.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("cancels a pending first brief when the thread starts running again", async () => {
      const fetchMock = fakeCompletion(SUMMARY);
      current = host({ fetch: fetchMock });
      await plugin(current.bb);
      vi.useFakeTimers();

      await current.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "done",
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await current.harness.behavior.emitThreadEvent("thread.active", { thread });
      // The timer restarts from the new event rather than firing at 5s.
      await settle(3_500);
      expect(fetchMock).not.toHaveBeenCalled();

      await settle(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("skips a second request when the thread has not moved", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    current = host({ fetch: fetchMock });
    await plugin(current.bb);

    await current.harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await waitFor(async () => {
      const result = (await current!.harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The sweep considers the thread but the activity cursor is unchanged.
    await current.harness.behavior.runSchedule("brief-sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports absent, not summarizing, for a thread with no brief and none queued", async () => {
    current = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(current.bb);

    const state = (await current.harness.behavior.callRpc("getBrief", {
      threadId: "thr_1",
    })) as BriefState;
    // Saying "summarizing" here would be a lie the UI could never resolve.
    expect(state.state).toBe("absent");
  });

  it("reports summarizing only while work is actually pending", async () => {
    current = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(current.bb);

    // A queued refresh is genuinely pending.
    await current.harness.behavior.callRpc("refresh", { threadId: "thr_2" });
    const pending = (await current.harness.behavior.callRpc("getBrief", {
      threadId: "thr_2",
    })) as BriefState;
    expect(["summarizing", "ready"]).toContain(pending.state);
  });

  it("never backfills a thread whose last activity predates this load", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    const stale = makeThreadResponse({
      id: "thr_old",
      title: "Ancient",
      visibility: "visible",
      status: "idle",
      // Last touched well before the plugin started: no activity to react to.
      updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    current = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: { apiKey: "test-key", baseUrl: "https://api.test/v1" },
      sdk: {
        threads: {
          get: async () => stale,
          list: async () => [stale],
          output: async () => ({ output: "old" }),
          conversationOutline: async () => ({
            items: [
              { id: "1", role: "user", preview: "old work", attachmentSummary: null },
            ],
            maxSeq: 3,
          }),
          interactions: { list: async () => [] },
        },
      },
    }) as typeof current;
    await plugin(current!.bb);

    await current!.harness.behavior.runSchedule("brief-sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchMock).not.toHaveBeenCalled();
    const state = (await current!.harness.behavior.callRpc("getBrief", {
      threadId: "thr_old",
    })) as BriefState;
    expect(state.state).toBe("absent");
  });

  it("gives a long-dormant thread a brief once it sees activity", async () => {
    // The whole point of not backfilling: dormant costs nothing, and the next
    // turn is what earns a brief.
    const fetchMock = fakeCompletion(SUMMARY);
    const old = makeThreadResponse({
      id: "thr_1",
      title: "Dormant for months",
      visibility: "visible",
      status: "idle",
      updatedAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    current = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: { apiKey: "test-key", baseUrl: "https://api.test/v1", quietSeconds: 1 },
      sdk: {
        threads: {
          get: async () => old,
          list: async () => [old],
          output: async () => ({ output: "Picked this back up." }),
          conversationOutline: async () => ({
            items: [
              { id: "1", role: "user", preview: "resume this", attachmentSummary: null },
            ],
            maxSeq: 9,
          }),
          interactions: { list: async () => [] },
        },
      },
    }) as typeof current;
    await plugin(current!.bb);

    // Nothing from the sweep, because nothing has happened.
    await current!.harness.behavior.runSchedule("brief-sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();

    // Now the thread is worked on again.
    await current!.harness.behavior.emitThreadEvent("thread.idle", {
      thread: old,
      lastAssistantText: "Picked this back up.",
    });
    const state = await waitFor(async () => {
      const result = (await current!.harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });
    if (state.state !== "ready") throw new Error("unreachable");
    expect(state.brief.goal).toBe(SUMMARY.goal);
  });

  it("catches a briefless thread whose activity postdates this load", async () => {
    // The sweep's one job for a briefless thread: activity that happened while
    // we were running, whose `thread.idle` we apparently missed.
    const fetchMock = fakeCompletion(SUMMARY);
    let sweepThread = makeThreadResponse({ id: "thr_live", status: "idle" });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    current = createFakePluginHost({
      pluginId: "thread-briefs",
      // A 1s quiet period keeps the test fast.
      settings: { apiKey: "test-key", baseUrl: "https://api.test/v1", quietSeconds: 1 },
      sdk: {
        threads: {
          get: async () => sweepThread,
          list: async () => [sweepThread],
          output: async () => ({ output: "progress" }),
          conversationOutline: async () => ({
            items: [
              { id: "1", role: "user", preview: "do it", attachmentSummary: null },
            ],
            maxSeq: 4,
          }),
          interactions: { list: async () => [] },
        },
      },
    }) as typeof current;
    await plugin(current!.bb);

    // Activity just after load, then let the quiet period elapse.
    sweepThread = makeThreadResponse({
      id: "thr_live",
      status: "idle",
      updatedAt: Date.now() + 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    await current!.harness.behavior.runSchedule("brief-sweep");
    await waitFor(async () => (fetchMock.mock.calls.length > 0 ? true : null));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a thread still inside its quiet period alone", async () => {
    // `thread` defaults to updatedAt = now, so the sweep must not touch it.
    const fetchMock = fakeCompletion(SUMMARY);
    current = host({ fetch: fetchMock });
    await plugin(current.bb);

    await current.harness.behavior.runSchedule("brief-sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits a row signal per stored brief", async () => {
    current = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(current.bb);

    await current.harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    const signals = await waitFor(async () => {
      const result = (await current!.harness.behavior.callRpc(
        "listRowSignals",
        null,
      )) as { signals: unknown[] };
      return result.signals.length > 0 ? result.signals : null;
    });
    expect(signals).toEqual([
      {
        threadId: "thr_1",
        status: "waiting-on-me",
        stage: "review",
        label: "Review — Waiting on you",
      },
    ]);
  });

  it("emits a board card per stored brief, prose and model stage included", async () => {
    // The board's sibling of the signal above: same scan, more of the brief, and
    // `modelStage` — the one fact resolving throws away, which is what makes a
    // drop onto the summarizer's own choice a *cleared* pin rather than a new one.
    current = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(current.bb);

    await current.harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    const cards = await waitFor(async () => {
      const result = (await current!.harness.behavior.callRpc(
        "listBriefCards",
        null,
      )) as { cards: unknown[] };
      return result.cards.length > 0 ? result.cards : null;
    });
    expect(cards).toEqual([
      expect.objectContaining({
        threadId: "thr_1",
        stage: "review",
        modelStage: "review",
        status: "waiting-on-me",
        stageOverride: null,
        statusOverride: null,
        nextStep: SUMMARY.nextStep,
        blockedOn: "",
      }),
    ]);
    // The four fields the card face never shows stay off the wire: the board
    // asks `getBrief` for the one card you expand.
    expect(cards?.[0]).not.toHaveProperty("goal");
    expect(cards?.[0]).not.toHaveProperty("currentState");
    expect(cards?.[0]).not.toHaveProperty("constraints");
  });

  it("reports the pinned stage on a card and remembers the model's", async () => {
    current = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(current.bb);

    await current.harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await waitFor(async () => {
      const result = (await current!.harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });
    await current.harness.behavior.callRpc("setStageOverride", {
      threadId: "thr_1",
      stage: "planning",
    });

    const result = (await current.harness.behavior.callRpc(
      "listBriefCards",
      null,
    )) as { cards: { stage: string; modelStage: string; stageOverride: string | null }[] };
    expect(result.cards[0]).toMatchObject({
      stage: "planning",
      stageOverride: "planning",
      modelStage: "review",
    });
  });
});

describe("the auto-archive sweep", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** A host whose thread list and archive call the test can inspect. */
  function archiveHost(options: {
    threads: ReturnType<typeof makeThreadResponse>[];
    doneArchiveHours?: number;
  }) {
    globalThis.fetch = fakeCompletion(SUMMARY) as unknown as typeof globalThis.fetch;
    const archived: string[] = [];
    const created = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: {
        apiKey: "test-key",
        baseUrl: "https://api.test/v1",
        model: "test-model",
        quietSeconds: 120,
        doneArchiveHours: options.doneArchiveHours ?? 48,
      },
      sdk: {
        threads: {
          list: async () => options.threads,
          get: async ({ threadId }) =>
            options.threads.find((entry) => entry.id === threadId) ?? thread,
          archive: async ({ threadId }) => {
            archived.push(threadId);
            return { id: threadId, archivedAt: Date.now() };
          },
        },
      },
    });
    return { ...created, archived };
  }

  /** A finished thread, idle for `idleDays`, with a brief to match. */
  const coldThread = (id: string, idleDays: number, overrides = {}) =>
    makeThreadResponse({
      id,
      visibility: "visible",
      status: "idle",
      latestAttentionAt: Date.now() - idleDays * DAY,
      ...overrides,
    });

  const seedDoneBrief = async (
    bb: { storage: { kv: { set: (key: string, value: unknown) => Promise<void> } } },
    id: string,
    overrides: Partial<StoredBrief> = {},
  ) => {
    await bb.storage.kv.set(`brief:${id}`, {
      ...storedBrief(id, { nextStep: "", blockedOn: "" }),
      ...overrides,
    });
  };

  it("registers its own schedule, not folded into the brief sweep", async () => {
    // The brief sweep returns early without an API key; archiving a finished
    // thread has nothing to do with whether a summarizer is configured.
    const { bb, harness } = archiveHost({ threads: [] });
    await plugin(bb);
    expect(harness.registrations.schedules.map((entry) => entry.name)).toContain(
      "archive-done",
    );
    await harness.lifecycle.dispose();
  });

  it("archives a done thread that has gone cold", async () => {
    const { bb, harness, archived } = archiveHost({
      threads: [coldThread("thr_cold", 3)],
    });
    await plugin(bb);
    await seedDoneBrief(bb, "thr_cold");

    await harness.behavior.runSchedule("archive-done");
    expect(archived).toEqual(["thr_cold"]);

    // Stamped, so pulling it back out of the archive is final.
    const stored = (await bb.storage.kv.get("brief:thr_cold")) as StoredBrief;
    expect(typeof stored.autoArchivedAt).toBe("number");

    await harness.lifecycle.dispose();
  });

  it("does not archive one that is only grey, not yet past the threshold", async () => {
    // The grey ring is the warning; a thread showing it has not run out of time.
    const { bb, harness, archived } = archiveHost({
      threads: [coldThread("thr_grey", 1.5)],
    });
    await plugin(bb);
    await seedDoneBrief(bb, "thr_grey");

    await harness.behavior.runSchedule("archive-done");
    expect(archived).toEqual([]);

    await harness.lifecycle.dispose();
  });

  it("leaves a thread it already archived and the user pulled back", async () => {
    const { bb, harness, archived } = archiveHost({
      threads: [coldThread("thr_back", 9)],
    });
    await plugin(bb);
    await seedDoneBrief(bb, "thr_back", { autoArchivedAt: Date.now() - 5 * DAY });

    await harness.behavior.runSchedule("archive-done");
    expect(archived).toEqual([]);

    await harness.lifecycle.dispose();
  });

  it("archives nothing when the setting is off", async () => {
    const { bb, harness, archived } = archiveHost({
      threads: [coldThread("thr_cold", 30)],
      doneArchiveHours: 0,
    });
    await plugin(bb);
    await seedDoneBrief(bb, "thr_cold");

    await harness.behavior.runSchedule("archive-done");
    expect(archived).toEqual([]);

    await harness.lifecycle.dispose();
  });

  it("hands the thresholds to the sidebar with the row signals", async () => {
    // One source for both halves, so the grey ring cannot promise an archiving
    // the sweep is not about to do.
    const { bb, harness } = archiveHost({ threads: [] });
    await plugin(bb);
    for (const method of ["listRowSignals", "listBriefCards"]) {
      const result = (await harness.behavior.callRpc(method, null)) as {
        staleAfterMs: number;
        archiveAfterMs: number;
      };
      expect(result.staleAfterMs).toBe(24 * 60 * 60 * 1000);
      expect(result.archiveAfterMs).toBe(48 * 60 * 60 * 1000);
    }
    await harness.lifecycle.dispose();
  });
});

describe("stage override", () => {
  it("pins the stage and retires it once the thread moves on", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    const { bb, harness } = host({ fetch: fetchMock });
    await plugin(bb);

    await harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await waitFor(async () => {
      const result = (await harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });

    const overridden = (await harness.behavior.callRpc("setStageOverride", {
      threadId: "thr_1",
      stage: "planning",
    })) as BriefState;
    expect(overridden.state).toBe("ready");
    if (overridden.state !== "ready") throw new Error("unreachable");
    expect(overridden.brief.stage).toBe("planning");
    expect(overridden.brief.stageOverride).toBe("planning");

    // Simulate real new activity: the stored cursor falls behind the override's.
    const stored = await bb.storage.kv.get<StoredBrief>("brief:thr_1");
    await bb.storage.kv.set("brief:thr_1", {
      ...stored,
      lastActivitySeen: (stored?.stageOverrideSeq ?? 0) + 1,
    });

    const after = (await harness.behavior.callRpc("getBrief", {
      threadId: "thr_1",
    })) as BriefState;
    if (after.state !== "ready") throw new Error("unreachable");
    expect(after.brief.stage).toBe("review");
    expect(after.brief.stageOverride).toBeNull();

    await harness.lifecycle.dispose();
  });

  it("passes an in-force override to the summarizer as fixed", async () => {
    // The model is told discovery is wrong, but the user pinned it.
    const fetchMock = fakeCompletion({ ...SUMMARY, stage: "discovery" });
    const { bb, harness } = host({ fetch: fetchMock });
    await plugin(bb);

    await harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await waitFor(async () => {
      const result = (await harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });
    await harness.behavior.callRpc("setStageOverride", {
      threadId: "thr_1",
      stage: "planning",
    });

    await harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await waitFor(async () => (fetchMock.mock.calls.length > 1 ? true : null));

    const body = JSON.parse(String(fetchMock.mock.calls[1]![1].body));
    expect(body.messages[1].content).toContain('"stage" is fixed to "planning"');

    const state = (await harness.behavior.callRpc("getBrief", {
      threadId: "thr_1",
    })) as BriefState;
    if (state.state !== "ready") throw new Error("unreachable");
    expect(state.brief.stage).toBe("planning");

    await harness.lifecycle.dispose();
  });
});

describe("status override", () => {
  /**
   * The same host, but with a conversation cursor the test can advance, so a
   * summary can follow *real* activity rather than a hand-edited kv row. That is
   * the path an override has to expire on, and the only one that distinguishes
   * "anchored to where you set it" from "re-anchored on every summary" — the
   * latter never expires at all.
   */
  function movingHost(fetchMock: ReturnType<typeof fakeCompletion>) {
    let maxSeq = 12;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const created = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: {
        apiKey: "test-key",
        baseUrl: "https://api.test/v1",
        model: "test-model",
        jsonMode: true,
        quietSeconds: 120,
      },
      sdk: {
        threads: {
          get: async () => thread,
          list: async () => [thread],
          output: async () => ({ output: "All set." }),
          conversationOutline: async () => ({
            items: [
              { id: "1", role: "user", preview: "Build it", attachmentSummary: null },
            ],
            maxSeq,
          }),
          interactions: { list: async () => [] },
        },
      },
    });
    return {
      ...created,
      advance: () => {
        maxSeq += 1;
      },
    };
  }

  /** Force a summary and wait for the brief it produces. */
  const summarize = async (
    harness: { behavior: { callRpc: (method: string, input: unknown) => Promise<unknown> } },
    after = 0,
  ) => {
    await harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    return waitFor(async () => {
      const result = (await harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      if (result.state !== "ready") return null;
      return result.brief.lastSummarizedAt >= after ? result : null;
    });
  };

  it("pins a status the brief's own prose would never reach", async () => {
    // SUMMARY has a next step, so the derivation says waiting-on-me — and if
    // that step is carried out outside the thread, nothing can ever say so.
    const { bb, harness } = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(bb);

    const before = await summarize(harness);
    expect(before.brief.status).toBe("waiting-on-me");

    const pinned = (await harness.behavior.callRpc("setStatusOverride", {
      threadId: "thr_1",
      status: "done",
    })) as BriefState;
    if (pinned.state !== "ready") throw new Error("unreachable");
    expect(pinned.brief.status).toBe("done");
    expect(pinned.brief.statusOverride).toBe("done");
    // The prose is left alone: the next summary is fed the previous brief, so a
    // blanked nextStep would simply be written back.
    expect(pinned.brief.nextStep).toBe(SUMMARY.nextStep);

    await harness.lifecycle.dispose();
  });

  it("hands the status back to the derivation when the pin is cleared", async () => {
    const { bb, harness } = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(bb);
    await summarize(harness);

    await harness.behavior.callRpc("setStatusOverride", {
      threadId: "thr_1",
      status: "done",
    });
    const cleared = (await harness.behavior.callRpc("setStatusOverride", {
      threadId: "thr_1",
      status: null,
    })) as BriefState;
    if (cleared.state !== "ready") throw new Error("unreachable");
    expect(cleared.brief.status).toBe("waiting-on-me");
    expect(cleared.brief.statusOverride).toBeNull();

    await harness.lifecycle.dispose();
  });

  it("survives a re-summary of a thread that has not moved", async () => {
    // Re-summarize is how a stale brief is fixed, so it must not also throw
    // away a decision made about one.
    const { bb, harness } = movingHost(fakeCompletion(SUMMARY));
    await plugin(bb);
    const first = await summarize(harness);

    await harness.behavior.callRpc("setStatusOverride", {
      threadId: "thr_1",
      status: "done",
    });

    const again = await summarize(harness, first.brief.lastSummarizedAt + 1);
    expect(again.brief.status).toBe("done");
    expect(again.brief.statusOverride).toBe("done");

    await harness.lifecycle.dispose();
  });

  it("retires on the next real turn", async () => {
    const { bb, harness, advance } = movingHost(fakeCompletion(SUMMARY));
    await plugin(bb);
    const first = await summarize(harness);

    await harness.behavior.callRpc("setStatusOverride", {
      threadId: "thr_1",
      status: "done",
    });

    advance();
    const after = await summarize(harness, first.brief.lastSummarizedAt + 1);
    expect(after.brief.status).toBe("waiting-on-me");
    expect(after.brief.statusOverride).toBeNull();

    await harness.lifecycle.dispose();
  });

  it("retires a stage pin on the next real turn too", async () => {
    // The same anchor, exercised through a summary rather than a hand-edited
    // row: a pin re-anchored to each new cursor would advance in step with the
    // activity meant to expire it, and so never expire at all.
    const { bb, harness, advance } = movingHost(fakeCompletion(SUMMARY));
    await plugin(bb);
    const first = await summarize(harness);

    await harness.behavior.callRpc("setStageOverride", {
      threadId: "thr_1",
      stage: "planning",
    });

    advance();
    const after = await summarize(harness, first.brief.lastSummarizedAt + 1);
    expect(after.brief.stage).toBe("review");
    expect(after.brief.stageOverride).toBeNull();

    await harness.lifecycle.dispose();
  });

  it("leaves a thread with no brief alone rather than inventing one", async () => {
    const { bb, harness } = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(bb);

    const state = (await harness.behavior.callRpc("setStatusOverride", {
      threadId: "thr_1",
      status: "done",
    })) as BriefState;
    // Nothing to pin a status onto, and briefs are never backfilled.
    expect(state.state).toBe("absent");

    await harness.lifecycle.dispose();
  });
});

describe("sidebar grouping by status", () => {
  const groupedThread = (overrides: Partial<ReturnType<typeof makeThreadResponse>>) =>
    makeThreadResponse({ visibility: "visible", status: "idle", ...overrides });

  /**
   * A host with the sections surface stubbed, grouping already on, and the
   * `thread-list` preference RPC answered in memory so the test can see exactly
   * which preferences were written and how often.
   */
  function groupingHost(options: {
    threads: ReturnType<typeof makeThreadResponse>[];
    sections?: { id: string; name: string }[];
    grouping?: string;
  }) {
    const sections = options.sections ?? [];
    const prefs: Record<string, unknown> = {
      organizationMode: "project",
      chronologicalSort: "updated",
      manualSectionOrder: ["pinned", "sections", "threads"],
    };
    let nextSectionId = 1;

    globalThis.fetch = fakeCompletion(SUMMARY) as unknown as typeof globalThis.fetch;
    const created = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: {
        apiKey: "test-key",
        baseUrl: "https://api.test/v1",
        model: "test-model",
        jsonMode: true,
        quietSeconds: 120,
        sidebarGrouping: options.grouping ?? "status",
      },
      sdk: {
        threads: {
          get: async ({ threadId }) =>
            options.threads.find((thread) => thread.id === threadId) ??
            options.threads[0]!,
          list: async (args) => ((args?.offset ?? 0) === 0 ? options.threads : []),
          update: async ({ threadId, sectionId }) => {
            const thread = options.threads.find((entry) => entry.id === threadId);
            if (thread !== undefined) {
              Object.assign(thread, { sectionId: sectionId ?? null });
            }
            return thread ?? options.threads[0]!;
          },
          output: async () => ({ output: "All set." }),
          conversationOutline: async () => ({ items: [], maxSeq: 0 }),
          interactions: { list: async () => [] },
        },
        threadSections: {
          list: async () => [...sections],
          create: async ({ name }) => {
            const section = { id: `sec_${nextSectionId++}`, name };
            sections.push(section);
            return { ...section, updatedThreadCount: 0 };
          },
          update: async ({ id, name }) => {
            const section = sections.find((entry) => entry.id === id);
            if (section !== undefined) section.name = name;
            return { id, name, updatedThreadCount: 0 };
          },
          delete: async ({ id }) => {
            const index = sections.findIndex((section) => section.id === id);
            const [removed] = sections.splice(index, 1);
            return { id, name: removed?.name ?? "", updatedThreadCount: 0 };
          },
        },
        plugins: {
          callRpc: async ({ method, input }) => {
            if (method === "listPreferences") return { preferences: { ...prefs } };
            const { key, value } = input as { key: string; value?: unknown };
            if (method === "resetPreference") {
              delete prefs[key];
              return { key, value: null };
            }
            prefs[key] = value;
            return { key, value };
          },
        },
      },
    });
    return { ...created, prefs, sections };
  }

  /** The grouping reconcile is scheduled, so tests wait on its effect. */
  const settle = async (read: () => boolean) => {
    // 5s: long enough for a pass that has to wait out the reconcile debounce.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (read()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out waiting for the section sync");
  };

  it("creates the three sections and orders bb's Threads group last", async () => {
    const { bb, harness, prefs, sections } = groupingHost({ threads: [] });
    await plugin(bb);

    await settle(() => prefs.organizationMode === "chronological");
    expect(sections.map((section) => section.name)).toEqual([
      "🙋 Waiting on you",
      "⏸️ Blocked",
      "✅ Done",
    ]);
    expect(prefs.manualSectionOrder).toEqual([
      "pinned",
      "section:sec_1",
      "section:sec_2",
      "section:sec_3",
      "threads",
    ]);
    expect(prefs.chronologicalSort).toBe("updated");

    await harness.lifecycle.dispose();
  });

  it("leaves a hand-reordered sidebar alone on later passes", async () => {
    const threads = [groupedThread({ id: "thr_1", sectionId: null })];
    const { bb, harness, prefs } = groupingHost({ threads });
    await bb.storage.kv.set("brief:thr_1", storedBrief("thr_1", {}));
    await plugin(bb);

    // Waits for our own first write, so the drag below really is a later pass.
    // Waits for our own first write, so the drag below really is a later pass.
    await settle(() =>
      (prefs.manualSectionOrder as string[]).includes("section:sec_1"),
    );
    // The sidebar as the user has since dragged it: Threads at the top, our
    // three sections in an order of their own.
    const dragged = [
      "threads",
      "pinned",
      "section:sec_3",
      "section:sec_1",
      "section:sec_2",
    ];
    prefs.manualSectionOrder = [...dragged];

    // Pinning a status is the cheapest way to make a later pass actually run,
    // and it files the thread, so the pass is visibly a real one.
    await harness.behavior.callRpc("setStatusOverride", {
      threadId: "thr_1",
      status: "done",
    });
    await settle(() => threads[0]!.sectionId === "sec_3");

    // A reconcile runs on every brief write, so re-asserting our own order here
    // would undo the drag within seconds of it being made.
    expect(prefs.manualSectionOrder).toEqual(dragged);
    expect(
      harness.sdk
        .callsTo("plugins.callRpc")
        .map(([args]) => args as { method: string; input?: { key?: string } })
        .filter(
          (args) =>
            args.method === "setPreference" &&
            args.input?.key === "manualSectionOrder",
        ),
    ).toHaveLength(1);

    await harness.lifecycle.dispose();
    // Two reconciles, each behind the debounce, so this one needs the room.
  }, 15_000);

  it("files each thread by its brief's status and leaves briefless ones alone", async () => {
    const threads = [
      groupedThread({ id: "thr_wait", sectionId: null }),
      groupedThread({ id: "thr_blocked", sectionId: null }),
      groupedThread({ id: "thr_done", sectionId: null }),
      groupedThread({ id: "thr_nobrief", sectionId: null }),
    ];
    const { bb, harness } = groupingHost({ threads });
    await plugin(bb);

    await bb.storage.kv.set("brief:thr_wait", storedBrief("thr_wait", {}));
    await bb.storage.kv.set(
      "brief:thr_blocked",
      storedBrief("thr_blocked", { blockedOn: "Review from Dylan" }),
    );
    await bb.storage.kv.set(
      "brief:thr_done",
      storedBrief("thr_done", { nextStep: "", blockedOn: "" }),
    );

    await harness.behavior.callRpc("refresh", { threadId: "thr_wait" });
    await settle(() => threads[0]!.sectionId !== null);

    const sectionFor = (id: string) =>
      threads.find((thread) => thread.id === id)?.sectionId;
    expect(sectionFor("thr_wait")).toBe("sec_1");
    expect(sectionFor("thr_blocked")).toBe("sec_2");
    expect(sectionFor("thr_done")).toBe("sec_3");
    // No brief, so it stays unassigned and falls into bb's Threads group.
    expect(sectionFor("thr_nobrief")).toBeNull();

    await harness.lifecycle.dispose();
  });

  it("renames sections left under their old names instead of duplicating them", async () => {
    // Sections are keyed on name, so adding the emoji has to be a rename: a
    // fresh set beside the old one would leave every filed thread behind.
    const threads = [groupedThread({ id: "thr_1", sectionId: "sec_old_wait" })];
    const sections = [
      { id: "sec_old_wait", name: "Waiting on you" },
      { id: "sec_old_blocked", name: "Blocked" },
      { id: "sec_old_done", name: "Done" },
    ];
    const { bb, harness, prefs } = groupingHost({ threads, sections });
    await bb.storage.kv.set("brief:thr_1", storedBrief("thr_1", {}));
    await plugin(bb);

    await settle(() => sections[0]!.name.startsWith("🙋"));
    expect(sections.map((section) => section.name)).toEqual([
      "🙋 Waiting on you",
      "⏸️ Blocked",
      "✅ Done",
    ]);
    expect(harness.sdk.callsTo("threadSections.create")).toHaveLength(0);
    expect(harness.sdk.callsTo("threadSections.delete")).toHaveLength(0);
    // The ids are unchanged, so the thread already filed under the old name
    // never had to move.
    expect(threads[0]!.sectionId).toBe("sec_old_wait");
    expect(prefs.manualSectionOrder).toEqual([
      "pinned",
      "section:sec_old_wait",
      "section:sec_old_blocked",
      "section:sec_old_done",
      "threads",
    ]);

    await harness.lifecycle.dispose();
  });

  it("still removes a section left under its old name when turned off", async () => {
    const threads = [groupedThread({ id: "thr_1", sectionId: null })];
    const { bb, harness, sections } = groupingHost({ threads });
    await plugin(bb);

    await bb.storage.kv.set("brief:thr_1", storedBrief("thr_1", {}));
    await harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await settle(() => threads[0]!.sectionId !== null);
    // A section we made under a former name, missed by the rename because the
    // reconcile had already run. Teardown still has to take it with it.
    sections.push({ id: "sec_stray", name: "Done" });

    await harness.behavior.setSettings({ sidebarGrouping: "off" });
    await settle(() => sections.length === 0);

    await harness.lifecycle.dispose();
  });

  it("never files an archived thread, whatever its brief says", async () => {
    const threads = [
      groupedThread({ id: "thr_live", sectionId: null }),
      groupedThread({ id: "thr_old", sectionId: null, archivedAt: 1_000 }),
    ];
    const { bb, harness } = groupingHost({ threads });
    await plugin(bb);

    await bb.storage.kv.set("brief:thr_live", storedBrief("thr_live", {}));
    await bb.storage.kv.set("brief:thr_old", storedBrief("thr_old", {}));

    await harness.behavior.callRpc("refresh", { threadId: "thr_live" });
    await settle(() => threads[0]!.sectionId !== null);

    expect(threads[1]!.sectionId).toBeNull();
    expect(
      harness.sdk
        .callsTo("threads.update")
        .map(([args]) => (args as { threadId: string }).threadId),
    ).not.toContain("thr_old");

    await harness.lifecycle.dispose();
  });

  it("writes the preferences once per batch, not once per thread", async () => {
    const threads = Array.from({ length: 5 }, (_unused, index) =>
      groupedThread({ id: `thr_${index}`, sectionId: null }),
    );
    const { bb, harness } = groupingHost({ threads });
    await plugin(bb);

    for (const thread of threads) {
      await bb.storage.kv.set(`brief:${thread.id}`, storedBrief(thread.id, {}));
    }
    await harness.behavior.callRpc("refresh", { threadId: "thr_0" });
    await settle(() => threads.every((thread) => thread.sectionId !== null));

    // The debounce coalesces the batch: one listPreferences plus the three
    // preference writes that were actually wrong, and no more.
    const methods = harness.sdk
      .callsTo("plugins.callRpc")
      .map(([args]) => (args as { method: string }).method);
    expect(methods.filter((method) => method === "listPreferences")).toHaveLength(1);
    expect(methods.filter((method) => method === "setPreference")).toHaveLength(2);
    expect(threads).toHaveLength(5);

    await harness.lifecycle.dispose();
  });

  it("does nothing at all while grouping is off", async () => {
    const { bb, harness } = groupingHost({
      threads: [groupedThread({ id: "thr_1", sectionId: null })],
      grouping: "off",
    });
    await plugin(bb);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(harness.sdk.callsTo("threadSections.create")).toHaveLength(0);
    expect(harness.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    expect(harness.sdk.callsTo("threads.update")).toHaveLength(0);

    await harness.lifecycle.dispose();
  });

  it("removes the sections and restores the preferences when turned off", async () => {
    const threads = [groupedThread({ id: "thr_1", sectionId: null })];
    const { bb, harness, prefs, sections } = groupingHost({ threads });
    await plugin(bb);

    await bb.storage.kv.set("brief:thr_1", storedBrief("thr_1", {}));
    await harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await settle(() => threads[0]!.sectionId !== null);

    await harness.behavior.setSettings({ sidebarGrouping: "off" });
    await settle(() => sections.length === 0);

    // Back to what the sidebar looked like before, not to a guess.
    expect(prefs.organizationMode).toBe("project");
    expect(prefs.manualSectionOrder).toEqual(["pinned", "sections", "threads"]);

    await harness.lifecycle.dispose();
  });
});

describe("stored rows written before nextStepActor", () => {
  it("keeps reading a row that has no actor, rather than discarding it", async () => {
    // `readBrief` deletes anything that fails the strict parse, and briefs are
    // never backfilled, so a required new field would wipe every existing brief
    // and leave dormant threads with nothing to regenerate from. This is the
    // test that says `nextStepActor` stays optional.
    const { bb, harness } = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(bb);

    await bb.storage.kv.set("brief:thr_1", {
      version: 1,
      threadId: "thr_1",
      fields: {
        goal: "Ship the thread-briefs plugin",
        currentState: "Server, app and tests written",
        nextStep: "Push the branch",
        blockedOn: "",
        constraints: "",
      },
      modelStage: "review",
      stageOverride: null,
      stageOverrideSeq: null,
      endedWithQuestion: false,
      lastSummarizedAt: 1_000,
      lastActivitySeen: 12,
    });

    const state = (await harness.behavior.callRpc("getBrief", {
      threadId: "thr_1",
    })) as BriefState;
    expect(state.state).toBe("ready");
    if (state.state !== "ready") throw new Error("unreachable");
    // No actor, so the derivation falls back to the actor-free behaviour.
    expect(state.brief.nextStepActor).toBeUndefined();
    expect(state.brief.status).toBe("waiting-on-me");
    expect(await bb.storage.kv.get("brief:thr_1")).not.toBeUndefined();

    await harness.lifecycle.dispose();
  });
});

describe("cleanup", () => {
  it("drops the brief when the thread is deleted", async () => {
    const { bb, harness } = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(bb);

    await harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await waitFor(async () => {
      const result = (await harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });

    await harness.behavior.emitThreadEvent("thread.deleted", { thread });
    await waitFor(async () => {
      const keys = await bb.storage.kv.list("brief:");
      return keys.length === 0 ? true : null;
    });

    await harness.lifecycle.dispose();
  });
});

describe("renaming threads", () => {
  /**
   * A host whose thread is mutable, so a test can watch the title change — and
   * can rename it by hand between summaries the way a user would.
   */
  function renameHost(options: {
    title?: string | null;
    renameThreads?: boolean;
    summaryTitle?: string;
    /** Runs when the summarizer is called, to move the world mid-flight. */
    onRequest?: () => void;
    update?: (args: { threadId: string; title?: string | null }) => void;
  }) {
    const live = makeThreadResponse({
      id: "thr_1",
      title: options.title === undefined ? "Build me a thing that does..." : options.title,
      visibility: "visible",
      status: "idle",
    });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      options.onRequest?.();
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...SUMMARY,
                  title: options.summaryTitle ?? "Sidebar grouping by status",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    // Advanced per summary so a test can wait for *that* summary's write,
    // rather than seeing the previous one's brief and racing ahead.
    let seq = 12;
    const created = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: {
        apiKey: "test-key",
        baseUrl: "https://api.test/v1",
        model: "test-model",
        jsonMode: true,
        quietSeconds: 120,
        renameThreads: options.renameThreads ?? true,
      },
      sdk: {
        threads: {
          get: async () => ({ ...live }),
          list: async () => [live],
          update: async (args) => {
            options.update?.(args as { threadId: string; title?: string | null });
            if (typeof args.title === "string") live.title = args.title;
            return live;
          },
          output: async () => ({ output: "All set." }),
          conversationOutline: async () => ({
            items: [
              { id: "1", role: "user", preview: "Build it", attachmentSummary: null },
            ],
            maxSeq: seq,
          }),
          interactions: { list: async () => [] },
        },
      },
    });
    return { ...created, live, fetchMock, nextSeq: () => (seq += 1) };
  }

  /** Summarize once, and wait for that summary's brief to be stored. */
  async function summarize(current: ReturnType<typeof renameHost>) {
    const target = current.nextSeq();
    await current.harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await waitFor(async () => {
      const stored = await current.bb.storage.kv.get<StoredBrief>("brief:thr_1");
      return stored?.lastActivitySeen === target ? stored : null;
    });
  }

  it("replaces bb's opening-prompt title with the brief's name", async () => {
    const current = renameHost({});
    await plugin(current.bb);
    await summarize(current);

    expect(current.live.title).toBe("Sidebar grouping by status");
    await current.harness.lifecycle.dispose();
  });

  it("leaves a name bb chose alone until the first turn has ended", async () => {
    const current = renameHost({});
    await plugin(current.bb);
    vi.useFakeTimers();
    try {
      // A brief from the opening prompt alone: written, but it renames nothing,
      // because bb's own title was guessed from that same prompt and the
      // post-turn summary will choose better.
      await current.harness.behavior.emitThreadEvent("thread.active", {
        thread: current.live,
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await vi.advanceTimersByTimeAsync(0);

      const preTurn = await current.bb.storage.kv.get<StoredBrief>("brief:thr_1");
      expect(preTurn?.fields.goal).toBe(SUMMARY.goal);
      expect(preTurn?.appliedTitle).toBeNull();
      expect(current.live.title).toBe("Build me a thing that does...");
      expect(current.harness.sdk.callsTo("threads.update")).toHaveLength(0);

      // The turn ends, and that summary does name it.
      current.nextSeq();
      await current.harness.behavior.emitThreadEvent("thread.idle", {
        thread: current.live,
        lastAssistantText: "All set.",
      });
      await vi.advanceTimersByTimeAsync(130_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(current.live.title).toBe("Sidebar grouping by status");
    } finally {
      vi.useRealTimers();
      await current.harness.lifecycle.dispose();
    }
  });

  it("names an unnamed thread from its pre-turn brief, without waiting", async () => {
    // Nothing to wait for: with no title of bb's own the row falls back to the
    // opening prompt clamped to 80 characters, and four words off that prompt
    // are better than the prompt. A first turn can run for ten minutes.
    const current = renameHost({ title: null });
    await plugin(current.bb);
    vi.useFakeTimers();
    try {
      await current.harness.behavior.emitThreadEvent("thread.active", {
        thread: current.live,
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(current.live.title).toBe("Sidebar grouping by status");
      const preTurn = await current.bb.storage.kv.get<StoredBrief>("brief:thr_1");
      // Recorded as ours, so the post-turn summary is free to improve on it
      // rather than reading it as a name someone chose by hand.
      expect(preTurn?.appliedTitle).toBe("Sidebar grouping by status");
    } finally {
      vi.useRealTimers();
      await current.harness.lifecycle.dispose();
    }
  });

  it("records the title it wrote, so it can tell its own name from yours", async () => {
    const current = renameHost({});
    await plugin(current.bb);
    await summarize(current);

    const stored = await current.bb.storage.kv.get<StoredBrief>("brief:thr_1");
    expect(stored?.appliedTitle).toBe("Sidebar grouping by status");
    expect(stored?.fields.title).toBe("Sidebar grouping by status");
    await current.harness.lifecycle.dispose();
  });

  it("renames nothing while the setting is off", async () => {
    const current = renameHost({ renameThreads: false });
    await plugin(current.bb);
    await summarize(current);

    expect(current.live.title).toBe("Build me a thing that does...");
    expect(current.harness.sdk.callsTo("threads.update")).toHaveLength(0);
    // The name is still recorded, so turning the setting on later has one.
    const stored = await current.bb.storage.kv.get<StoredBrief>("brief:thr_1");
    expect(stored?.fields.title).toBe("Sidebar grouping by status");
    expect(stored?.appliedTitle).toBeNull();
    await current.harness.lifecycle.dispose();
  });

  it("writes nothing when the thread already shows the name", async () => {
    const current = renameHost({ title: "Sidebar grouping by status" });
    await plugin(current.bb);
    await summarize(current);

    // No PATCH, which also means no rename command dispatched to the
    // environment for a title that did not move.
    expect(current.harness.sdk.callsTo("threads.update")).toHaveLength(0);
    await current.harness.lifecycle.dispose();
  });

  it("stops renaming for good once the thread is renamed by hand", async () => {
    const current = renameHost({});
    await plugin(current.bb);
    await summarize(current);
    expect(current.live.title).toBe("Sidebar grouping by status");

    // The user renames it. The summarizer still proposes its own name.
    current.live.title = "DO NOT TOUCH — release cut";
    await summarize(current);

    expect(current.live.title).toBe("DO NOT TOUCH — release cut");
    // And the record still points at our old name, which is what keeps it off.
    const after = await current.bb.storage.kv.get<StoredBrief>("brief:thr_1");
    expect(after?.appliedTitle).toBe("Sidebar grouping by status");

    await summarize(current);
    expect(current.live.title).toBe("DO NOT TOUCH — release cut");
    await current.harness.lifecycle.dispose();
  });

  it("does not clobber a rename made while the summarizer was thinking", async () => {
    // The thread was read before the request; renaming during it is exactly the
    // race the re-read before writing exists for.
    const current: ReturnType<typeof renameHost> = renameHost({
      onRequest: () => {
        current.live.title = "Renamed mid-flight";
      },
    });
    await plugin(current.bb);
    await summarize(current);

    expect(current.live.title).toBe("Renamed mid-flight");
    expect(current.harness.sdk.callsTo("threads.update")).toHaveLength(0);
    await current.harness.lifecycle.dispose();
  });

  it("keeps the brief when the rename fails, and retries next time", async () => {
    let fail = true;
    const current = renameHost({
      update: () => {
        if (fail) throw new Error("thread is archived");
      },
    });
    await plugin(current.bb);
    await summarize(current);

    const stored = await current.bb.storage.kv.get<StoredBrief>("brief:thr_1");
    expect(stored?.fields.goal).toBe(SUMMARY.goal);
    // Nothing recorded as applied, so the thread is still eligible.
    expect(stored?.appliedTitle).toBeNull();

    fail = false;
    await summarize(current);
    expect(current.live.title).toBe("Sidebar grouping by status");
    await current.harness.lifecycle.dispose();
  });

  it("leaves the title alone when the model proposed no name", async () => {
    const current = renameHost({ summaryTitle: "N/A" });
    await plugin(current.bb);
    await summarize(current);

    expect(current.live.title).toBe("Build me a thing that does...");
    expect(current.harness.sdk.callsTo("threads.update")).toHaveLength(0);
    await current.harness.lifecycle.dispose();
  });

  it("titles a thread bb never managed to title at all", async () => {
    const current = renameHost({ title: null });
    await plugin(current.bb);
    await summarize(current);

    expect(current.live.title).toBe("Sidebar grouping by status");
    await current.harness.lifecycle.dispose();
  });
});

describe("re-entry refresher", () => {
  const HOUR = 3_600_000;
  const PROSE = {
    refresherShort: "You were wiring the sidebar sections. Run the reconcile.",
    refresherFull:
      "You were wiring the sidebar sections to brief status, and the sync lands. The order is still unpinned. Run the reconcile and check manualSectionOrder.",
  };

  /** A thread whose last activity, and the refresher setting, a test controls. */
  function refresherHost(options: {
    idleMs?: number;
    refresherIdleHours?: number;
    summary?: Record<string, unknown>;
  }) {
    const live = makeThreadResponse({
      id: "thr_1",
      title: "Sidebar grouping",
      visibility: "visible",
      status: "idle",
      latestAttentionAt: Date.now() - (options.idleMs ?? 48 * HOUR),
    });
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ...SUMMARY,
                    ...PROSE,
                    ...options.summary,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const created = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: {
        apiKey: "test-key",
        baseUrl: "https://api.test/v1",
        model: "test-model",
        jsonMode: true,
        quietSeconds: 120,
        refresherIdleHours: options.refresherIdleHours ?? 1,
      },
      sdk: {
        threads: {
          get: async () => ({ ...live }),
          list: async () => [live],
          update: async () => live,
          output: async () => ({ output: "All set." }),
          conversationOutline: async () => ({
            items: [
              { id: "1", role: "user", preview: "Build it", attachmentSummary: null },
            ],
            maxSeq: 12,
          }),
          interactions: { list: async () => [] },
        },
      },
    });
    return { ...created, live, fetchMock };
  }

  async function summarized(current: ReturnType<typeof refresherHost>) {
    await current.harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    return waitFor(async () =>
      current.bb.storage.kv.get<StoredBrief>("brief:thr_1"),
    );
  }

  const ask = async (current: ReturnType<typeof refresherHost>) =>
    (await current.harness.behavior.callRpc("getRefresher", {
      threadId: "thr_1",
    })) as { refresher: { text: string; variant: string; attentionAt: number } | null };

  let current: ReturnType<typeof refresherHost> | null = null;
  afterEach(async () => {
    await current?.harness.lifecycle.dispose();
    current = null;
  });

  it("stores both variants and the status reading they were written for", async () => {
    current = refresherHost({});
    await plugin(current.bb);
    const stored = await summarized(current);

    expect(stored.refresher).toEqual({
      short: PROSE.refresherShort,
      full: PROSE.refresherFull,
      // Stamped from the fields this same summary produced, so a status pinned
      // afterwards makes the two disagree — which is what suppresses the card.
      writtenForStatus: "waiting-on-me",
    });
  });

  it("reorients you on a thread you left two days ago", async () => {
    current = refresherHost({ idleMs: 48 * HOUR });
    await plugin(current.bb);
    await summarized(current);

    const { refresher } = await ask(current);
    expect(refresher?.variant).toBe("full");
    expect(refresher?.text).toBe(PROSE.refresherFull);
    expect(refresher?.attentionAt).toBe(current.live.latestAttentionAt);
  });

  it("keeps it to a line on a thread you left this morning", async () => {
    current = refresherHost({ idleMs: 10 * HOUR });
    await plugin(current.bb);
    await summarized(current);

    const { refresher } = await ask(current);
    expect(refresher?.variant).toBe("short");
    expect(refresher?.text).toBe(PROSE.refresherShort);
  });

  it("says nothing on a thread you were in ten minutes ago", async () => {
    current = refresherHost({ idleMs: 10 * 60_000 });
    await plugin(current.bb);
    await summarized(current);

    expect((await ask(current)).refresher).toBeNull();
  });

  it("says nothing on a thread with no brief, without touching the thread", async () => {
    current = refresherHost({});
    await plugin(current.bb);

    expect((await ask(current)).refresher).toBeNull();
    // The cheap checks come first: a thread the refresher can never fire on
    // must not cost a lookup on every open.
    expect(current.harness.sdk.callsTo("threads.get")).toHaveLength(0);
  });

  it("is off at a threshold of zero, and costs nothing when it is", async () => {
    current = refresherHost({ refresherIdleHours: 0 });
    await plugin(current.bb);
    await summarized(current);
    const before = current.harness.sdk.callsTo("threads.get").length;

    expect((await ask(current)).refresher).toBeNull();
    expect(current.harness.sdk.callsTo("threads.get")).toHaveLength(before);
  });

  it("stays dismissed for the activity it was shown for", async () => {
    current = refresherHost({});
    await plugin(current.bb);
    await summarized(current);

    const shown = (await ask(current)).refresher!;
    await current.harness.behavior.callRpc("dismissRefresher", {
      threadId: "thr_1",
      attentionAt: shown.attentionAt,
    });

    expect((await ask(current)).refresher).toBeNull();
  });

  it("comes back when the thread does something you have not seen", async () => {
    current = refresherHost({});
    await plugin(current.bb);
    await summarized(current);

    const shown = (await ask(current)).refresher!;
    await current.harness.behavior.callRpc("dismissRefresher", {
      threadId: "thr_1",
      attentionAt: shown.attentionAt,
    });

    // A turn lands after the dismissal.
    current.live.latestAttentionAt = shown.attentionAt + 1_000;
    expect((await ask(current)).refresher).not.toBeNull();
  });

  it("never moves the dismissal backwards", async () => {
    // Two windows can hold the same thread. A stale dismiss from the one you
    // did not type in must not reopen a question the other one closed.
    current = refresherHost({});
    await plugin(current.bb);
    const stored = await summarized(current);
    const at = current.live.latestAttentionAt;

    await current.harness.behavior.callRpc("dismissRefresher", {
      threadId: "thr_1",
      attentionAt: at,
    });
    await current.harness.behavior.callRpc("dismissRefresher", {
      threadId: "thr_1",
      attentionAt: at - 10_000,
    });

    expect(stored.refresher).not.toBeNull();
    expect((await ask(current)).refresher).toBeNull();
  });

  it("drops the dismissal along with the brief it silenced", async () => {
    current = refresherHost({});
    await plugin(current.bb);
    await summarized(current);
    await current.harness.behavior.callRpc("dismissRefresher", {
      threadId: "thr_1",
      attentionAt: current.live.latestAttentionAt,
    });

    await current.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: current.live,
    });
    await waitFor(async () =>
      (await current!.bb.storage.kv.get("brief:thr_1")) === undefined ? true : null,
    );

    expect(
      await current.bb.storage.kv.get("refresher-seen:thr_1"),
    ).toBeUndefined();
  });

  it("says nothing while the agent is running", async () => {
    current = refresherHost({});
    await plugin(current.bb);
    await summarized(current);

    current.live.status = "active";
    expect((await ask(current)).refresher).toBeNull();
  });

  describe("a status pinned by hand", () => {
    it("re-summarizes, telling the model what the user pinned", async () => {
      current = refresherHost({});
      await plugin(current.bb);
      await summarized(current);
      expect(current.fetchMock).toHaveBeenCalledTimes(1);

      await current.harness.behavior.callRpc("setStatusOverride", {
        threadId: "thr_1",
        status: "waiting-on-other",
      });
      await waitFor(async () =>
        current!.fetchMock.mock.calls.length > 1 ? true : null,
      );

      const body = JSON.parse(String(current.fetchMock.mock.calls[1]![1].body));
      expect(body.messages[1].content).toContain(
        'For "refresherShort" and "refresherFull" only',
      );
      expect(body.messages[1].content).toContain("marked this thread as blocked");
    });

    it("shows nothing until the prose written for the pin lands", async () => {
      current = refresherHost({});
      await plugin(current.bb);
      await summarized(current);

      // Pin the status without letting the re-summary land, by seeding the row
      // directly: the stored prose still says "carry on".
      const stored = await current.bb.storage.kv.get<StoredBrief>("brief:thr_1");
      await current.bb.storage.kv.set("brief:thr_1", {
        ...stored,
        statusOverride: "waiting-on-other",
        statusOverrideSeq: stored!.lastActivitySeen,
      });

      expect((await ask(current)).refresher).toBeNull();
    });

    it("shows prose written for the pin once the re-summary has landed", async () => {
      current = refresherHost({});
      await plugin(current.bb);
      await summarized(current);

      await current.harness.behavior.callRpc("setStatusOverride", {
        threadId: "thr_1",
        status: "waiting-on-other",
      });
      const rewritten = await waitFor(async () => {
        const row = await current!.bb.storage.kv.get<StoredBrief>("brief:thr_1");
        return row?.refresher?.writtenForStatus === "waiting-on-other" ? row : null;
      });

      expect(rewritten.statusOverride).toBe("waiting-on-other");
      expect((await ask(current)).refresher?.text).toBe(PROSE.refresherFull);
    });
  });
});
