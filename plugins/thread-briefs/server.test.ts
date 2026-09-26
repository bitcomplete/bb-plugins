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

  it("does not summarize a thread the moment it goes idle", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    current = host({ fetch: fetchMock });
    await plugin(current.bb);

    await current.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "done",
    });
    // The quiet period has to elapse first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("does not backfill a thread dormant longer than the backfill window", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    const stale = makeThreadResponse({
      id: "thr_old",
      title: "Ancient",
      visibility: "visible",
      status: "idle",
      // Two days idle: past the 24h backfill window.
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

  it("still backfills a thread quiet for a while but inside the window", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    // Ten minutes idle: past the quiet period, inside the 24h backfill window.
    const recent = makeThreadResponse({
      id: "thr_recent",
      title: "Recent",
      visibility: "visible",
      status: "idle",
      updatedAt: Date.now() - 10 * 60 * 1000,
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    current = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: { apiKey: "test-key", baseUrl: "https://api.test/v1" },
      sdk: {
        threads: {
          get: async () => recent,
          list: async () => [recent],
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
        label: "Waiting on you — Review",
      },
    ]);
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
