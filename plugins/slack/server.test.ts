import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import serverEntry, { ASSISTANT_GREETING, CALLBACK_PATH, createSlackPlugin, legacySettingDescriptors, SET_PROJECT_ACTION, SET_PROJECT_BUTTON_ACTION } from "./server.js";

const APP_URL = "https://bb.example";
const HOOKS_URL = "http://bb-gate-hooks.test:8081";

/** The shape of the searchChannels RPC's answer, for test assertions. */
type ChannelSearchResult = {
  state: "ok" | "signin-required" | "unavailable";
  channels: Array<{ id: string; name: string; private: boolean; extShared: boolean }>;
  botChannels: string[] | null;
  truncated: boolean;
  message?: string;
};

// A bb-gate-hooks whose event stream a test writes to, and whose sign-in and
// session endpoints it scripts. Every Slack call is recorded.
function fakeHooks() {
  const encoder = new TextEncoder();
  const streams: Array<{ send(text: string): void; closed: boolean }> = [];
  const identifies: Array<{ connection: string; source: string; token: string; teams: string[] }> = [];
  const signinStarts: Array<{ connection: string }> = [];
  const exchanges: Array<{ connection: string; state: string; code: string }> = [];
  const messages: Array<{ session: string; body: Record<string, unknown> }> = [];
  const statuses: Array<{ session: string; body: Record<string, unknown> }> = [];
  const titles: Array<{ session: string; body: Record<string, unknown> }> = [];
  const ephemerals: Array<Record<string, unknown>> = [];
  const responses: Array<{ url: string; body: Record<string, unknown> }> = [];
  const joins: Array<{ connection: string; channel: string }> = [];
  const subscribes: Array<{ connection: string; source: string; watches: Array<{ kind: string; id: string; capability?: string }> }> = [];
  let botChannelRequests = 0;
  const state: {
    start: () => Response | Promise<Response>;
    exchange: () => Response | Promise<Response>;
    identify: () => Response | Promise<Response>;
    botChannels: () => Response | Promise<Response>;
    join: () => Response | Promise<Response>;
    message: () => Response | Promise<Response>;
    subscribe: (body: (typeof subscribes)[number]) => Response | Promise<Response>;
  } = {
    start: () => Response.json({ authorizeUrl: "https://slack.com/openid/connect/authorize?client_id=x", state: "st-1" }),
    exchange: () => Response.json({ token: "xoxp-user-token" }),
    identify: () => Response.json({ user: { id: "U0123", name: "Alice" }, teams: [], rejected: [] }),
    botChannels: () => Response.json({ channels: ["C0123", "G0456"] }),
    join: () => Response.json({ ok: true }),
    message: () => Response.json({ ok: true }),
    subscribe: (body) => Response.json({ leases: body.watches, rejected: [] }),
  };
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u === `${HOOKS_URL}/v1/events`) {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const entry = { closed: false, send: (text: string) => controller.enqueue(encoder.encode(text)) };
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c), cancel: () => void (entry.closed = true) });
      const keepalive = setInterval(() => {
        if (!entry.closed) entry.send(": keepalive\n\n");
      }, 20_000);
      init?.signal?.addEventListener("abort", () => {
        entry.closed = true;
        clearInterval(keepalive);
      });
      streams.push(entry);
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (u === `${HOOKS_URL}/v1/identify`) {
      const body = JSON.parse(String(init?.body)) as (typeof identifies)[number];
      identifies.push(body);
      return state.identify();
    }
    if (u === `${HOOKS_URL}/v1/subscribe`) {
      const body = JSON.parse(String(init?.body)) as (typeof subscribes)[number];
      subscribes.push(body);
      return state.subscribe(body);
    }
    if (u === `${HOOKS_URL}/v1/slack/signin/start`) {
      signinStarts.push(JSON.parse(String(init?.body)) as { connection: string });
      return state.start();
    }
    if (u === `${HOOKS_URL}/v1/slack/signin/exchange`) {
      exchanges.push(JSON.parse(String(init?.body)) as (typeof exchanges)[number]);
      return state.exchange();
    }
    if (u === `${HOOKS_URL}/v1/slack/bot/channels`) {
      botChannelRequests += 1;
      return state.botChannels();
    }
    if (u === `${HOOKS_URL}/v1/slack/bot/join`) {
      joins.push(JSON.parse(String(init?.body)) as (typeof joins)[number]);
      return state.join();
    }
    if (u === `${HOOKS_URL}/v1/slack/ephemeral`) {
      ephemerals.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true });
    }
    // Slack's response_url: the plugin posts the replacement here, not through
    // bb-gate-hooks, so it arrives as a plain Slack-host POST.
    if (u.startsWith("https://hooks.slack.com/")) {
      responses.push({ url: u, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ ok: true });
    }
    const route = /^http:\/\/bb-gate-hooks\.test:8081\/v1\/slack\/sessions\/([^/]+)\/(message|status|title)$/u.exec(u);
    if (route !== null) {
      const session = decodeURIComponent(route[1]!);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (route[2] === "message") {
        messages.push({ session, body });
        return state.message();
      } else if (route[2] === "status") statuses.push({ session, body });
      else titles.push({ session, body });
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    streams,
    identifies,
    signinStarts,
    exchanges,
    messages,
    statuses,
    titles,
    ephemerals,
    responses,
    joins,
    subscribes,
    state,
    botChannelRequests: () => botChannelRequests,
    last: () => streams.at(-1)!,
    hello: (connection: string) => `event: hello\ndata: ${JSON.stringify({ connection, leaseSeconds: 3600 })}\n\n`,
    session: (over: Record<string, unknown> = {}) =>
      `event: session\ndata: ${JSON.stringify({
        source: "slack",
        session: "D0123:1712345678.901234",
        action: "message",
        channel: "D0123",
        thread: "1712345678.901234",
        asker: { id: "U0123", name: "Alice" },
        owner: { id: "U0123", name: "Alice" },
        fromOwner: true,
        routedAs: "owner",
        comment: { text: "build this", untrusted: false },
        at: "2026-10-22T12:00:00Z",
        ...over,
      })}\n\n`,
  };
}

// A stand-in for Slack's conversations.list, paging through `pages` and
// recording every request so a test can see the pagination and the cache.
function fakeSlack(options: { pages?: Array<Array<{ id: string; name: string; private?: boolean; extShared?: boolean }>>; tokenError?: string } = {}) {
  const pages = options.pages ?? [[{ id: "C0123", name: "general" }]];
  const requests: Array<{ cursor: string | null; token: string }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    if (u.origin !== "https://slack.com" || u.pathname !== "/api/conversations.list") return new Response("not found", { status: 404 });
    const token = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /u, "");
    const cursor = u.searchParams.get("cursor");
    requests.push({ cursor, token });
    if (options.tokenError !== undefined) return Response.json({ ok: false, error: options.tokenError });
    const index = cursor === null ? 0 : Number(cursor);
    const page = pages[index] ?? [];
    const next = index + 1 < pages.length ? String(index + 1) : "";
    return Response.json({
      ok: true,
      channels: page.map((c) => ({ id: c.id, name: c.name, is_private: c.private ?? false, is_ext_shared: c.extShared ?? false })),
      response_metadata: { next_cursor: next },
    });
  });
  return { fetchImpl, requests };
}

/** One environment fixture, as the status and spawn code reads it. */
type TestEnvironment = {
  environmentProviderId: string | null;
  hostId: string;
  createdAt: number;
  lifecycle: { phase: string };
  environmentProviderSelection: { inputs: unknown } | null;
  projectId: string;
};

const PROJECTS = [
  { id: "prj-1", name: "Project One", kind: "standard" },
  { id: "prj-2", name: "Personal", kind: "personal" },
];
/** A machine that is on, and the project's checkout on it. */
const HOSTS = [
  { id: "host_off", status: "disconnected" },
  { id: "host_on", status: "connected" },
];
const SOURCES = [{ type: "local_path", hostId: "host_on", isDefault: true }];
/** The project's environments, newest last: a workspace on the machine that is on. */
const ENVIRONMENTS: TestEnvironment[] = [
  { environmentProviderId: "project-checkout", hostId: "host_on", createdAt: 1, lifecycle: { phase: "active" }, environmentProviderSelection: null, projectId: "prj-1" },
  { environmentProviderId: "multi-repo-workspace", hostId: "host_on", createdAt: 2, lifecycle: { phase: "active" }, environmentProviderSelection: { inputs: { repos: ["a"] } }, projectId: "prj-1" },
  { environmentProviderId: "git-worktree", hostId: "host_off", createdAt: 3, lifecycle: { phase: "active" }, environmentProviderSelection: null, projectId: "prj-1" },
];

async function setup(
  options: {
    hooks?: ReturnType<typeof fakeHooks>;
    slack?: ReturnType<typeof fakeSlack>;
    token?: string;
    settings?: { token?: string; project?: string; channels?: string };
    map?: { fallback: string; channels: Array<{ channel: string; project: string }> };
    projects?: typeof PROJECTS;
    hosts?: Array<{ id: string; status: string }>;
    sources?: Array<{ type: string; hostId: string; isDefault: boolean }>;
    environments?: TestEnvironment[];
    /** What `environments.list()` returns with no project filter; defaults to `environments`. */
    allEnvironments?: TestEnvironment[];
    spawn?: () => unknown;
    send?: (args: { threadId: string; input: Array<{ type: string; text?: string }>; pluginSubmission?: unknown }) => unknown;
    /** What a `threads.queuedMessages.update` returns; a throw simulates a row that moved on. */
    updateQueued?: (args: { threadId: string; queuedMessageId: string; expectedUpdatedAt: number; input: Array<{ type: string; text?: string }> }) => unknown;
    /** What a `threads.queuedMessages.delete` returns; a throw simulates a row that moved on. */
    deleteQueued?: (args: { threadId: string; queuedMessageId: string }) => unknown;
    /** What the dispatch hook reports for a `threads.send`: joined or started. */
    sendAttempt?: "join-turn" | "start-turn";
    get?: () => unknown;
    turns?: Array<{ createdAt: number; data: unknown }>;
  } = {},
) {
  const hooks = options.hooks ?? fakeHooks();
  const slack = options.slack ?? fakeSlack();
  // The plugin's one outbound fetch: Slack's own API goes to the Slack fake,
  // everything else (bb-gate-hooks) to the hooks fake.
  const fetchImpl = vi.fn((url: string | URL, init?: RequestInit): Promise<Response> =>
    String(url).startsWith("https://slack.com/") ? slack.fetchImpl(url, init) : hooks.fetchImpl(url, init),
  ) as unknown as typeof fetch;
  const settings = options.settings ?? { token: options.token ?? "", project: "", channels: "[]" };
  // Assigned once the host is built: the fake `send` runs the registered
  // dispatch hook, the way the server runs it inside `threads.send`.
  let dispatchHook: ((context: ReturnType<typeof makeMessageDispatchHookContext>) => unknown) | null = null;
  const { bb, harness } = createFakePluginHost({
    pluginId: "slack",
    appUrl: APP_URL,
    settings,
    sdk: {
      projects: {
        list: async () => (options.projects ?? PROJECTS).map((p) => ({ ...p, sources: options.sources ?? SOURCES })),
        get: async ({ projectId }: { projectId: string }) => ({ id: projectId, name: projectId, kind: "standard", sources: options.sources ?? SOURCES }),
      },
      hosts: { list: async () => options.hosts ?? HOSTS },
      environments: { list: async (args?: { projectId?: string }) => (args?.projectId === undefined ? (options.allEnvironments ?? options.environments ?? ENVIRONMENTS) : (options.environments ?? ENVIRONMENTS)) },
      threads: {
        spawn: async () => options.spawn?.() ?? { id: "thr-1" },
        send: async (args: { threadId: string; input: Array<{ type: string; text?: string }>; pluginSubmission?: unknown }) => {
          if (dispatchHook !== null) {
            await dispatchHook(
              makeMessageDispatchHookContext({
                thread: { id: args.threadId },
                input: { blocks: args.input as never, text: args.input.map((b) => b.text ?? "").join("\n") },
                attempt: options.sendAttempt ?? "start-turn",
                experimental_submission: (args.pluginSubmission ?? null) as never,
              }),
            );
          }
          return options.send?.(args) ?? { delivery: "sent" };
        },
        queuedMessages: {
          update: async (args: { threadId: string; queuedMessageId: string; expectedUpdatedAt: number; input: Array<{ type: string; text?: string }> }) => options.updateQueued?.(args) ?? { id: args.queuedMessageId, updatedAt: args.expectedUpdatedAt + 1 },
          delete: async (args: { threadId: string; queuedMessageId: string }) => options.deleteQueued?.(args) ?? { ok: true },
        },
        get: async () => options.get?.() ?? { title: "Build BB-38", titleFallback: null },
        events: { list: async () => options.turns ?? [] },
      },
    },
  });
  let now = 1_000_000_000_000;
  const factory = createSlackPlugin({ fetch: fetchImpl, now: () => now, env: { BB_HOOKS_URL: HOOKS_URL } });
  await factory(bb);
  dispatchHook = harness.registrations.hooks["message.dispatch"] as typeof dispatchHook;
  if (options.map !== undefined) await harness.callRpc("setMap", options.map);
  const tool = (name: string, args: Record<string, unknown>, ctx?: { threadId?: string; projectId?: string }) =>
    harness.behavior.callAgentTool(name, args, ctx) as Promise<string | { content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  const text = (result: Awaited<ReturnType<typeof tool>>) => (typeof result === "string" ? result : result.content.map((c) => c.text ?? "").join(""));
  return { bb, harness, hooks, slack, fetchImpl, tool, text, advance: (ms: number) => (now += ms), now: () => now, factory };
}

describe("Slack plugin", () => {
  it("default-exports the factory bb loads as the server entry", () => {
    // bb refuses the plugin ("server entry must default-export a factory (bb) => void, got undefined") without this.
    expect(typeof serverEntry).toBe("function");
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

  async function live(over: Parameters<typeof setup>[0] = {}) {
    const s = await setup(over);
    const service = s.harness.runService("slack");
    await tick();
    s.hooks.last().send(s.hooks.hello("c_1"));
    await tick();
    return { ...s, service, stop: async () => void (service.controller.abort(), await service.done) };
  }

  it("shows the projects and a disconnected hooks service before sign-in", async () => {
    const s = await live();
    expect(await s.harness.callRpc("status")).toEqual({
      signedIn: false,
      user: null,
      fallback: "",
      projects: [
        { id: "prj-1", name: "Project One", kind: "standard", hasMachine: true },
        { id: "prj-2", name: "Personal", kind: "personal", hasMachine: true },
      ],
      channels: [],
      hooks: { configured: true, connected: true, state: "connected" },
    });
    await s.stop();
  });

  it("starts sign-in through the service and stores the state against the connection", async () => {
    const s = await live();
    const { url } = (await s.harness.callRpc("signinStart")) as { url: string };
    expect(url).toContain("slack.com/openid/connect/authorize");
    expect(s.hooks.signinStarts).toEqual([{ connection: "c_1" }]);
    expect(await s.bb.storage.kv.get("signin/pending/st-1")).toMatchObject({ connection: "c_1" });
    await s.stop();
  });

  it("exchanges the callback's code, stores the token and identifies with it, never logging it", async () => {
    const s = await live();
    await s.harness.callRpc("signinStart");
    const page = await s.harness.behavior.fetchHttp("GET", `${CALLBACK_PATH}?code=the-code&state=st-1`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Signed in as Alice");
    expect(s.hooks.exchanges).toEqual([{ connection: "c_1", state: "st-1", code: "the-code" }]);
    expect(s.hooks.identifies.at(-1)).toMatchObject({ connection: "c_1", source: "slack", token: "xoxp-user-token", teams: [] });
    expect(await s.bb.storage.kv.get("signin/pending/st-1")).toBeUndefined();
    const status = (await s.harness.callRpc("status")) as { signedIn: boolean; user: { name: string } | null };
    expect(status).toMatchObject({ signedIn: true, user: { name: "Alice" } });
    expect(s.harness.logEntries.map((l) => l.message).join("\n")).not.toContain("xoxp-user-token");
    // The state is single use: a second callback with the same state is refused.
    const again = await s.harness.behavior.fetchHttp("GET", `${CALLBACK_PATH}?code=the-code&state=st-1`);
    expect(again.status).toBe(400);
    expect(s.hooks.exchanges).toHaveLength(1);
    await s.stop();
  });

  it("tells the developer to start again when the exchange fails, and stores no token", async () => {
    const s = await live();
    s.hooks.state.exchange = () => new Response(JSON.stringify({ error: "already-used" }), { status: 409 });
    await s.harness.callRpc("signinStart");
    const page = await s.harness.behavior.fetchHttp("GET", `${CALLBACK_PATH}?code=the-code&state=st-1`);
    expect(page.status).toBe(502);
    expect(await page.text()).toContain("Start again");
    expect((await s.harness.callRpc("status")) as { signedIn: boolean }).toMatchObject({ signedIn: false });
    await s.stop();
  });

  it("refuses a callback whose state it never started", async () => {
    const s = await live();
    const page = await s.harness.behavior.fetchHttp("GET", `${CALLBACK_PATH}?code=x&state=nope`);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("expired");
    expect(s.hooks.exchanges).toEqual([]);
    await s.stop();
  });

  it("signs out: forgets the token and the identity, and reconnects", async () => {
    const s = await live();
    await s.harness.callRpc("signinStart");
    await s.harness.behavior.fetchHttp("GET", `${CALLBACK_PATH}?code=the-code&state=st-1`);
    expect((await s.harness.callRpc("signout")) as { ok: boolean }).toEqual({ ok: true });
    expect(await s.bb.storage.kv.get("identity")).toBeUndefined();
    expect((await s.harness.callRpc("status")) as { signedIn: boolean; user: unknown }).toMatchObject({ signedIn: false, user: null });
    await s.stop();
  });

  it("spawns one bb thread for the first wake and sends follow-ups to it, with the session named", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session());
    await tick();
    const spawns = s.harness.sdk.callsTo("threads.spawn");
    expect(spawns).toHaveLength(1);
    // The thread runs where the developer's newest environment runs: that
    // provider, with its inputs, on its machine; never the pod's own host.
    expect(spawns[0]![0]).toMatchObject({
      projectId: "prj-2",
      environment: { type: "provider", environmentProviderId: "multi-repo-workspace", inputs: { repos: ["a"] }, machine: { type: "existing", hostId: "host_on" } },
    });
    expect(String((spawns[0]![0] as { prompt: string }).prompt)).toContain("session D0123:1712345678.901234");
    expect(s.hooks.statuses.at(-1)).toMatchObject({ session: "D0123:1712345678.901234", body: { connection: "c_1", status: "is thinking…" } });

    s.hooks.last().send(s.hooks.session({ comment: { text: "also the SSO page", untrusted: false } }));
    await tick();
    const sends = s.harness.sdk.callsTo("threads.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]![0]).toMatchObject({ threadId: "thr-1", mode: "steer" });
    expect(JSON.stringify(sends[0]![0])).toContain("also the SSO page");
    await s.stop();
  });

  it("names a message's files in the spawned prompt and the follow-up, and still wakes a file-only message", async () => {
    const s = await live();
    const files = [
      { id: "F1", name: "shot.png", mimeType: "image/png", size: 1234 },
      { id: "F2", name: "snippet.go", mimeType: "text/plain", size: 99 },
    ];
    // A file-only message (empty text) still wakes the thread.
    s.hooks.last().send(s.hooks.session({ comment: { text: "", untrusted: false }, files }));
    await tick();
    const prompt = String((s.harness.sdk.callsTo("threads.spawn")[0]![0] as { prompt: string }).prompt);
    expect(prompt).toContain("(no text)");
    expect(prompt.endsWith("2 files were attached and not forwarded: shot.png (image/png, 1.2 KB), snippet.go (text/plain, 99 B)")).toBe(true);

    // A follow-up names its own files, and a later message without any carries no line.
    s.hooks.last().send(s.hooks.session({ comment: { text: "and this one", untrusted: false }, files: [{ id: "F3", name: "log.txt", mimeType: "text/plain", size: 2048 }] }));
    await tick();
    const send = s.harness.sdk.callsTo("threads.send").at(-1)![0] as { input: Array<{ text: string }> };
    expect(send.input[0]!.text.endsWith("1 file was attached and not forwarded: log.txt (text/plain, 2 KB)")).toBe(true);
    s.hooks.last().send(s.hooks.session({ comment: { text: "nothing attached", untrusted: false } }));
    await tick();
    const last = s.harness.sdk.callsTo("threads.send").at(-1)![0] as { input: Array<{ text: string }> };
    expect(last.input[0]!.text).not.toContain("not forwarded");
    await s.stop();
  });

  it("leases each live Slack session on the next hello and never logs the capability", async () => {
    const s = await live({ token: "xoxp-test" });
    s.hooks.last().send(s.hooks.session({ capability: "cap-secret" }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    // A fresh hello (a reconnect) re-subscribes every live session.
    s.hooks.last().send(s.hooks.hello("c_2"));
    await tick();
    expect(s.hooks.subscribes).toEqual([
      { connection: "c_2", source: "slack", watches: [{ kind: "session", id: "D0123:1712345678.901234", capability: "cap-secret" }] },
    ]);
    expect(s.harness.logEntries.map((l) => l.message).join("\n")).not.toContain("cap-secret");
    await s.stop();
  });

  it("renews the session lease at half its life", async () => {
    const s = await live({ token: "xoxp-test" });
    s.hooks.last().send(s.hooks.session({ capability: "cap-secret" }));
    await tick();
    expect(s.hooks.subscribes).toEqual([]);
    await tick(30 * 60 * 1000);
    expect(s.hooks.subscribes.at(-1)?.watches).toEqual([{ kind: "session", id: "D0123:1712345678.901234", capability: "cap-secret" }]);
    await s.stop();
  });

  it("keeps a live session past the old 24-hour window and still leases it", async () => {
    const s = await live({ token: "xoxp-test" });
    s.hooks.last().send(s.hooks.session({ capability: "cap-secret" }));
    await tick();
    s.advance(25 * 60 * 60 * 1000);
    await s.tool("slack_reply", { text: "still here" }, { threadId: "thr-1" });
    const stored = (await s.bb.storage.kv.get("sessions")) as Record<string, unknown>;
    expect(Object.keys(stored)).toContain("D0123:1712345678.901234");
    // The old code would have dropped it; a live thread still renews.
    await tick(30 * 60 * 1000);
    expect(s.hooks.subscribes.at(-1)?.watches).toEqual([{ kind: "session", id: "D0123:1712345678.901234", capability: "cap-secret" }]);
    await s.stop();
  });

  it("drops a session from the renewal set when its thread is archived or deleted", async () => {
    let spawned = 0;
    const s = await live({ token: "xoxp-test", spawn: () => ({ id: `thr-${++spawned}` }) });
    s.hooks.last().send(s.hooks.session({ capability: "cap-one" }));
    await tick();
    s.hooks.last().send(s.hooks.session({ session: "D9999:2.3", channel: "D9999", capability: "cap-two", comment: { text: "second", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
    await s.harness.behavior.emitThreadEvent("thread.archived", { thread: { id: "thr-1" } as never });
    await tick(30 * 60 * 1000);
    expect(s.hooks.subscribes.at(-1)?.watches).toEqual([{ kind: "session", id: "D9999:2.3", capability: "cap-two" }]);
    // Deletion drops the other one too: with no live session there is nothing to lease.
    const before = s.hooks.subscribes.length;
    await s.harness.behavior.emitThreadEvent("thread.deleted", { thread: { id: "thr-2" } as never });
    await tick(30 * 60 * 1000);
    expect(s.hooks.subscribes).toHaveLength(before);
    await s.stop();
  });

  it("reports an owned rejection once, degrading when the reply is refused", async () => {
    const s = await live({ token: "xoxp-test" });
    s.hooks.state.subscribe = (body) => Response.json({ leases: [], rejected: body.watches.map((w) => ({ kind: w.kind, id: w.id, reason: "owned" })) });
    // The other server's live lease makes the deployed service refuse this
    // server's reply; the plugin must still record the episode.
    s.hooks.state.message = () => new Response(JSON.stringify({ error: "not-routed" }), { status: 403 });
    s.hooks.last().send(s.hooks.session({ capability: "cap-secret" }));
    await tick();
    s.hooks.last().send(s.hooks.hello("c_2"));
    await tick();
    expect(s.hooks.messages.filter((m) => String(m.body.text).includes("Another bb server holds"))).toHaveLength(1);
    const logs = s.harness.logEntries.map((l) => l.message).join("\n");
    expect(logs).toContain("another bb server holds");
    expect(logs).toContain("could not post the backstop reply");
    expect(logs).not.toContain("cap-secret");
    // The next renewal is rejected too, but the episode is reported once.
    await tick(30 * 60 * 1000);
    expect(s.hooks.messages.filter((m) => String(m.body.text).includes("Another bb server holds"))).toHaveLength(1);
    await s.stop();
  });

  it("reports a new owned episode after the session is routed here again", async () => {
    const s = await live({ token: "xoxp-test" });
    s.hooks.state.subscribe = (body) => Response.json({ leases: [], rejected: body.watches.map((w) => ({ kind: w.kind, id: w.id, reason: "owned" })) });
    s.hooks.last().send(s.hooks.session({ capability: "cap-secret" }));
    await tick();
    s.hooks.last().send(s.hooks.hello("c_2"));
    await tick();
    const notices = () => s.hooks.messages.filter((m) => String(m.body.text).includes("Another bb server holds"));
    expect(notices()).toHaveLength(1);
    // A wake routed here again ends the episode; a later rejection is a new one.
    s.hooks.last().send(s.hooks.session({ capability: "cap-secret", comment: { text: "again", untrusted: false } }));
    await tick();
    s.hooks.last().send(s.hooks.hello("c_3"));
    await tick();
    expect(notices()).toHaveLength(2);
    await s.stop();
  });

  it("does not log an untagged session's channel when its lease is rejected", async () => {
    const s = await live({ token: "xoxp-test" });
    s.hooks.state.subscribe = (body) => Response.json({ leases: [], rejected: body.watches.map((w) => ({ kind: w.kind, id: w.id, reason: "owned" })) });
    s.hooks.last().send(
      s.hooks.session({
        session: "C0123:1712345678.901234",
        channel: "C0123",
        mention: false,
        tagged: false,
        capability: "cap-secret",
        comment: { text: "what about the second one?", untrusted: false },
      }),
    );
    await tick();
    s.hooks.last().send(s.hooks.hello("c_2"));
    await tick();
    const logs = s.harness.logEntries.map((l) => l.message).join("\n");
    expect(logs).toContain("another bb server holds");
    expect(logs).not.toContain("C0123");
    expect(logs).not.toContain("what about the second one?");
    expect(logs).not.toContain("cap-secret");
    await s.stop();
  });

  it("holds a non-owner's channel mention for the owner's confirmation, running no turn", async () => {
    const s = await live();
    s.hooks.last().send(
      s.hooks.session({
        session: "C0123:1712345678.901234",
        channel: "C0123",
        mention: true,
        fromOwner: false,
        asker: { id: "U9999", name: "Carol" },
        comment: { text: "halt work", untrusted: true },
      }),
    );
    await tick();
    // The words never reached a thread, and no turn ran on them.
    expect(s.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(s.harness.sdk.callsTo("threads.send")).toEqual([]);
    // The plugin itself asked the owner to confirm, naming the held request.
    const prompt = String(s.hooks.messages.at(-1)?.body.text ?? "");
    expect(prompt).toContain("Carol asked");
    expect(prompt).toContain("halt work");
    const id = /confirm (r-[a-z0-9]+)/u.exec(prompt)?.[1];
    expect(id).toBeTruthy();

    // The owner confirms by id: only now does the held text reach a thread.
    s.hooks.last().send(
      s.hooks.session({
        session: "C0123:1712345678.901234",
        channel: "C0123",
        mention: true,
        fromOwner: true,
        asker: { id: "U0123", name: "Alice" },
        owner: { id: "U0123", name: "Alice" },
        comment: { text: `<@U-bb> confirm ${id}`, untrusted: false },
      }),
    );
    await tick();
    const spawns = s.harness.sdk.callsTo("threads.spawn");
    expect(spawns).toHaveLength(1);
    const released = String((spawns[0]![0] as { prompt: string }).prompt);
    expect(released).toContain("halt work");
    expect(released).toContain("Alice confirmed request");
    await s.stop();
  });

  it("names a held message's files in the confirm prompt and the released wake", async () => {
    const s = await live();
    const files = [{ id: "F1", name: "shot.png", mimeType: "image/png", size: 1234 }];
    s.hooks.last().send(
      s.hooks.session({
        session: "C0123:1712345678.901234",
        channel: "C0123",
        mention: true,
        fromOwner: false,
        asker: { id: "U9999", name: "Carol" },
        comment: { text: "halt work", untrusted: true },
        files,
      }),
    );
    await tick();
    const prompt = String(s.hooks.messages.at(-1)?.body.text ?? "");
    expect(prompt).toContain("1 file was attached and not forwarded: shot.png (image/png, 1.2 KB)");
    const id = /confirm (r-[a-z0-9]+)/u.exec(prompt)?.[1];
    expect(id).toBeTruthy();

    s.hooks.last().send(
      s.hooks.session({
        session: "C0123:1712345678.901234",
        channel: "C0123",
        mention: true,
        fromOwner: true,
        asker: { id: "U0123", name: "Alice" },
        owner: { id: "U0123", name: "Alice" },
        comment: { text: `<@U-bb> confirm ${id}`, untrusted: false },
        // A file on the confirming message is named too, not just the held one.
        files: [{ id: "F2", name: "confirm.png", mimeType: "image/png", size: 2048 }],
      }),
    );
    await tick();
    const released = String((s.harness.sdk.callsTo("threads.spawn")[0]![0] as { prompt: string }).prompt);
    expect(released).toContain("2 files were attached and not forwarded: shot.png (image/png, 1.2 KB), confirm.png (image/png, 2 KB)");
    await s.stop();
  });

  it("starts a mention in the project its channel is mapped to, and the fallback when it is not", async () => {
    const map = { fallback: "Personal", channels: [{ channel: "C0123", project: "Project One" }] };
    const mapped = await live({ map });
    mapped.hooks.last().send(mapped.hooks.session({ session: "C0123:1.2", channel: "C0123", mention: true, comment: { text: "build this", untrusted: false } }));
    await tick();
    expect((mapped.harness.sdk.callsTo("threads.spawn")[0]![0] as { projectId: string }).projectId).toBe("prj-1");
    await mapped.stop();

    const unmapped = await live({ map });
    unmapped.hooks.last().send(unmapped.hooks.session({ session: "C9999:1.2", channel: "C9999", mention: true, comment: { text: "build this", untrusted: false } }));
    await tick();
    expect((unmapped.harness.sdk.callsTo("threads.spawn")[0]![0] as { projectId: string }).projectId).toBe("prj-2");
    await unmapped.stop();
  });

  it("uses the fallback for a direct message", async () => {
    const s = await live({ map: { fallback: "Project One", channels: [] } });
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect((s.harness.sdk.callsTo("threads.spawn")[0]![0] as { projectId: string }).projectId).toBe("prj-1");
    await s.stop();
  });

  it("ignores the channel map for a DM, even when the DM's own id is mapped", async () => {
    const s = await live({ map: { fallback: "Personal", channels: [{ channel: "D0123", project: "Project One" }] } });
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect((s.harness.sdk.callsTo("threads.spawn")[0]![0] as { projectId: string }).projectId).toBe("prj-2");
    await s.stop();
  });

  it("falls back to the fallback when a map entry names a project this server lacks", async () => {
    const s = await live({ map: { fallback: "Personal", channels: [{ channel: "C0123", project: "Nope" }] } });
    s.hooks.last().send(s.hooks.session({ session: "C0123:1.2", channel: "C0123", mention: true, comment: { text: "build this", untrusted: false } }));
    await tick();
    expect((s.harness.sdk.callsTo("threads.spawn")[0]![0] as { projectId: string }).projectId).toBe("prj-2");
    await s.stop();
  });

  it("saves the routing map through the RPC", async () => {
    const s = await live();
    expect((await s.harness.callRpc("setMap", { fallback: "Project One", channels: [{ channel: "C0123", project: "Project Two" }] })) as { ok: boolean }).toEqual({ ok: true });
    const status = (await s.harness.callRpc("status")) as { fallback: string; channels: unknown };
    expect(status.fallback).toBe("Project One");
    expect(status.channels).toEqual([{ channel: "C0123", project: "Project Two" }]);
    await s.stop();
  });

  it("asks the owner which project an unmapped channel uses when bb joins it", async () => {
    const s = await live();
    s.hooks.last().send(
      s.hooks.session({
        session: "",
        thread: "",
        action: "invited",
        channel: "C0123",
        comment: { text: "", untrusted: false },
      }),
    );
    await tick();
    // No bb thread runs for the prompt.
    expect(s.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(s.hooks.ephemerals).toHaveLength(1);
    const eph = s.hooks.ephemerals[0]!;
    expect(eph).toMatchObject({ connection: "c_1", channel: "C0123", user: "U0123" });
    const blocks = eph.blocks as Array<Record<string, unknown>>;
    expect(JSON.stringify(blocks)).toContain("C0123");
    const actions = blocks.find((b) => b.type === "actions") as { elements: Array<Record<string, unknown>> };
    expect(actions.elements.map((e) => e.type)).toEqual(["static_select", "button"]);
    const select = actions.elements[0] as { action_id: string; options: Array<{ value: string }> };
    expect(select.action_id).toBe("bb_set_project");
    expect(select.options.map((o) => o.value)).toEqual(["prj-1", "prj-2"]);
    const button = actions.elements[1] as { action_id: string };
    expect(button.action_id).toBe(SET_PROJECT_BUTTON_ACTION);
    // Slack rejects a block whose action ids repeat, so every one must differ.
    const actionIds = actions.elements.map((e) => (e as { action_id: string }).action_id);
    expect(new Set(actionIds).size).toBe(actionIds.length);
    expect(SET_PROJECT_ACTION).not.toBe(SET_PROJECT_BUTTON_ACTION);
    expect(JSON.stringify(blocks)).toContain("start a thread in the chosen project");
    await s.stop();
  });

  it("does nothing when bb joins a channel that already has a routing row", async () => {
    const s = await live({ map: { fallback: "Personal", channels: [{ channel: "C0123", project: "Project One" }] } });
    s.hooks.last().send(s.hooks.session({ session: "", thread: "", action: "invited", channel: "C0123", comment: { text: "", untrusted: false } }));
    await tick();
    expect(s.hooks.ephemerals).toEqual([]);
    expect(s.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    await s.stop();
  });

  it("writes the routing row on a block_action and confirms through the response_url", async () => {
    const s = await live();
    const responseUrl = "https://hooks.slack.com/actions/T1/B1/secret-capability";
    s.hooks.last().send(
      s.hooks.session({
        session: "",
        thread: "",
        action: "block_action",
        channel: "C0123",
        actionId: "bb_set_project",
        value: "prj-1",
        responseUrl,
        comment: { text: "", untrusted: false },
      }),
    );
    await tick();
    expect((await s.harness.callRpc("status")) as { channels: unknown }).toMatchObject({ channels: [{ channel: "C0123", project: "Project One" }] });
    expect(s.hooks.responses).toHaveLength(1);
    expect(s.hooks.responses[0]!.url).toBe(responseUrl);
    expect(s.hooks.responses[0]!.body).toMatchObject({ replace_original: true });
    expect(String(s.hooks.responses[0]!.body.text)).toContain("Project One");
    await s.stop();
  });

  it("refuses a block_action whose response_url is not a Slack hooks host", async () => {
    const s = await live();
    const evil = "https://evil.example/actions/T1/B1/steal";
    s.hooks.last().send(
      s.hooks.session({
        session: "",
        thread: "",
        action: "block_action",
        channel: "C0123",
        actionId: "bb_set_project",
        value: "prj-1",
        responseUrl: evil,
        comment: { text: "", untrusted: false },
      }),
    );
    await tick();
    // The row is still written; the prompt is simply not replaced.
    expect((await s.harness.callRpc("status")) as { channels: unknown }).toMatchObject({ channels: [{ channel: "C0123", project: "Project One" }] });
    expect(s.hooks.responses).toEqual([]);
    expect((s.fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls.some(([u]) => String(u) === evil)).toBe(false);
    // The capability never reaches a log line.
    expect(s.harness.logEntries.map((l) => l.message).join("\n")).not.toContain("steal");
    await s.stop();
  });

  it("replies with one line for an unknown project or a stale click", async () => {
    const responseUrl = "https://hooks.slack.com/actions/T1/B1/cap";
    const s = await live();
    s.hooks.last().send(s.hooks.session({ session: "", thread: "", action: "block_action", channel: "C0123", actionId: "bb_set_project", value: "nope", responseUrl, comment: { text: "", untrusted: false } }));
    await tick();
    expect(String(s.hooks.responses.at(-1)?.body.text)).toContain("not on this server");
    expect(((await s.harness.callRpc("status")) as { channels: unknown }).channels).toEqual([]);
    await s.stop();

    const mapped = await live({ map: { fallback: "Personal", channels: [{ channel: "C0123", project: "Project One" }] } });
    mapped.hooks.last().send(mapped.hooks.session({ session: "", thread: "", action: "block_action", channel: "C0123", actionId: "bb_set_project", value: "prj-2", responseUrl, comment: { text: "", untrusted: false } }));
    await tick();
    expect(String(mapped.hooks.responses.at(-1)?.body.text)).toContain("already set to Project One");
    // The existing row is not overwritten.
    expect(((await mapped.harness.callRpc("status")) as { channels: unknown }).channels).toEqual([{ channel: "C0123", project: "Project One" }]);
    await mapped.stop();
  });

  it("never writes the map on a block_action from someone other than the owner", async () => {
    const s = await live();
    s.hooks.last().send(
      s.hooks.session({
        session: "",
        thread: "",
        action: "block_action",
        channel: "C0123",
        actionId: "bb_set_project",
        value: "prj-1",
        responseUrl: "https://hooks.slack.com/actions/T1/B1/cap",
        fromOwner: false,
        asker: { id: "U9999", name: "Carol" },
        comment: { text: "", untrusted: true },
      }),
    );
    await tick();
    expect(((await s.harness.callRpc("status")) as { channels: unknown }).channels).toEqual([]);
    expect(String(s.hooks.responses.at(-1)?.body.text)).toContain("Only the person who invited bb");
    await s.stop();
  });

  it("stays inert when an invited wake has no project to offer", async () => {
    const s = await live({ projects: [] });
    s.hooks.last().send(s.hooks.session({ session: "", thread: "", action: "invited", channel: "C0123", comment: { text: "", untrusted: false } }));
    await tick();
    expect(s.hooks.ephemerals).toEqual([]);
    expect(s.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    await s.stop();
  });

  it("clips a long project name to Slack's plain_text limit in the prompt", async () => {
    const s = await live({ projects: [{ id: "prj-1", name: "p".repeat(120), kind: "standard" }] });
    s.hooks.last().send(s.hooks.session({ session: "", thread: "", action: "invited", channel: "C0123", comment: { text: "", untrusted: false } }));
    await tick();
    const blocks = s.hooks.ephemerals[0]!.blocks as Array<Record<string, unknown>>;
    const actions = blocks.find((b) => b.type === "actions") as { elements: Array<{ options: Array<{ text: { text: string } }> }> };
    expect(actions.elements[0]!.options[0]!.text.text.length).toBeLessThanOrEqual(75);
    await s.stop();
  });

  it("treats the Set button's own value as no choice, even for a project named 'set'", async () => {
    const s = await live({
      projects: [
        { id: "prj-1", name: "set", kind: "standard" },
        { id: "prj-2", name: "Personal", kind: "personal" },
      ],
    });
    s.hooks.last().send(
      s.hooks.session({
        session: "",
        thread: "",
        action: "block_action",
        channel: "C0123",
        actionId: SET_PROJECT_BUTTON_ACTION,
        value: "set",
        responseUrl: "https://hooks.slack.com/actions/T1/B1/cap",
        comment: { text: "", untrusted: false },
      }),
    );
    await tick();
    expect(((await s.harness.callRpc("status")) as { channels: unknown }).channels).toEqual([]);
    expect(String(s.hooks.responses.at(-1)?.body.text)).toContain("Pick a project");
    await s.stop();
  });

  it("keeps the 'pick a project' reply for a bare Set button press", async () => {
    const s = await live();
    s.hooks.last().send(
      s.hooks.session({
        session: "",
        thread: "",
        action: "block_action",
        channel: "C0123",
        actionId: SET_PROJECT_BUTTON_ACTION,
        value: "set",
        responseUrl: "https://hooks.slack.com/actions/T1/B1/cap",
        comment: { text: "", untrusted: false },
      }),
    );
    await tick();
    expect(((await s.harness.callRpc("status")) as { channels: unknown }).channels).toEqual([]);
    expect(String(s.hooks.responses.at(-1)?.body.text)).toContain("Pick a project");
    await s.stop();
  });

  it("refuses a map with no fallback", async () => {
    const s = await live();
    await expect(s.harness.callRpc("setMap", { fallback: "", channels: [] })).rejects.toThrow();
    await s.stop();
  });

  it("searches the developer's channels, paginating and marking private and shared ones", async () => {
    const slack = fakeSlack({
      pages: [
        [
          { id: "C0123", name: "general" },
          { id: "G0456", name: "secret", private: true },
        ],
        [{ id: "C0789", name: "shared", extShared: true }],
      ],
    });
    const s = await live({ slack, token: "xoxp-user-1" });
    const result = (await s.harness.callRpc("searchChannels", { query: "" })) as ChannelSearchResult;
    expect(result.state).toBe("ok");
    expect(result.channels).toEqual([
      { id: "C0123", name: "general", private: false, extShared: false },
      { id: "G0456", name: "secret", private: true, extShared: false },
      { id: "C0789", name: "shared", private: false, extShared: true },
    ]);
    expect(slack.requests.map((r) => r.cursor)).toEqual([null, "1"]);
    expect(slack.requests[0]!.token).toBe("xoxp-user-1");
    expect(result.truncated).toBe(false);
    // The bot's membership list rides along, so the picker can flag an invite.
    expect(result.botChannels).toEqual(["C0123", "G0456"]);
    expect(s.hooks.botChannelRequests()).toBe(1);
    await s.stop();
  });

  it("flags a channel list cut short by the page cap", async () => {
    const pages = Array.from({ length: 21 }, (_, i) => [{ id: `C${String(i).padStart(3, "0")}`, name: `chan-${i}` }]);
    const s = await live({ slack: fakeSlack({ pages }), token: "xoxp-user-1" });
    const result = (await s.harness.callRpc("searchChannels", { query: "" })) as ChannelSearchResult;
    expect(result.state).toBe("ok");
    expect(result.truncated).toBe(true);
    expect(result.channels).toHaveLength(20);
    expect(s.slack.requests).toHaveLength(20);
    await s.stop();
  });

  it("still lists channels when the bot membership list is unavailable", async () => {
    const s = await live({ slack: fakeSlack({ pages: [[{ id: "C0123", name: "general" }]] }), token: "xoxp-user-1" });
    s.hooks.state.botChannels = () => new Response("not configured", { status: 503 });
    const result = (await s.harness.callRpc("searchChannels", { query: "" })) as ChannelSearchResult;
    expect(result).toMatchObject({ state: "ok", channels: [{ id: "C0123", name: "general", private: false, extShared: false }], botChannels: null });
    await s.stop();
  });

  it("caches the channel list per server and refreshes it after a few minutes", async () => {
    const slack = fakeSlack({ pages: [[{ id: "C0123", name: "general" }]] });
    const s = await live({ slack, token: "xoxp-user-1" });
    await s.harness.callRpc("searchChannels", { query: "" });
    expect(slack.requests).toHaveLength(1);
    await s.harness.callRpc("searchChannels", { query: "" });
    expect(slack.requests).toHaveLength(1);
    s.advance(6 * 60 * 1000);
    await s.harness.callRpc("searchChannels", { query: "" });
    expect(slack.requests).toHaveLength(2);
    await s.stop();
  });

  it("filters by name locally, without another Slack call", async () => {
    const slack = fakeSlack({ pages: [[{ id: "C0123", name: "general" }, { id: "C0456", name: "random" }]] });
    const s = await live({ slack, token: "xoxp-user-1" });
    const result = (await s.harness.callRpc("searchChannels", { query: "rand" })) as ChannelSearchResult;
    expect(result.channels.map((c) => c.name)).toEqual(["random"]);
    expect(slack.requests).toHaveLength(1);
    await s.stop();
  });

  it("adds the bot to a channel through the service, with the connection and the channel id only", async () => {
    const s = await live({ token: "xoxp-user-1" });
    expect(await s.harness.callRpc("joinChannel", { channel: " C0789 " })).toEqual({ state: "joined" });
    expect(s.hooks.joins).toEqual([{ connection: "c_1", channel: "C0789" }]);
    expect(JSON.stringify(s.hooks.joins)).not.toContain("xoxp-user-1");
    await s.stop();
  });

  it("explains a private channel, a missing channel and a missing scope instead of failing", async () => {
    const s = await live({ token: "xoxp-user-1" });
    // Every refusal is a message, never a thrown error, and every one points
    // at the /invite @bb fallback.
    const fallback = expect.stringContaining("/invite @bb");
    s.hooks.state.join = () => Response.json({ error: "private-channel" }, { status: 409 });
    expect(await s.harness.callRpc("joinChannel", { channel: "G0456" })).toMatchObject({ state: "private", message: fallback });
    s.hooks.state.join = () => Response.json({ error: "channel-not-found" }, { status: 404 });
    expect(await s.harness.callRpc("joinChannel", { channel: "C0000" })).toMatchObject({ state: "not-found", message: fallback });
    s.hooks.state.join = () => Response.json({ error: "archived" }, { status: 409 });
    expect(await s.harness.callRpc("joinChannel", { channel: "C0001" })).toMatchObject({ state: "not-found", message: fallback });
    s.hooks.state.join = () => Response.json({ error: "missing-scope" }, { status: 503 });
    expect(await s.harness.callRpc("joinChannel", { channel: "C0789" })).toMatchObject({ state: "unavailable", message: fallback });
    s.hooks.state.join = () => Response.json({ error: "not-identified" }, { status: 403 });
    expect(await s.harness.callRpc("joinChannel", { channel: "C0789" })).toMatchObject({ state: "unavailable", message: fallback });
    // The service forgot the connection: its own message, not the generic one.
    s.hooks.state.join = () => Response.json({ error: "unknown-connection" }, { status: 404 });
    expect(await s.harness.callRpc("joinChannel", { channel: "C0789" })).toMatchObject({ state: "unavailable", message: expect.stringContaining("no longer knows this connection") });
    // An older bb-gate-hooks without the endpoint answers a bare 404.
    s.hooks.state.join = () => new Response("not found", { status: 404 });
    expect(await s.harness.callRpc("joinChannel", { channel: "C0789" })).toMatchObject({ state: "unavailable", message: fallback });
    // A name is never sent: the map stores ids.
    expect(await s.harness.callRpc("joinChannel", { channel: "general" })).toMatchObject({ state: "not-found", message: fallback });
    expect(s.hooks.joins.map((j) => j.channel)).toEqual(["G0456", "C0000", "C0001", "C0789", "C0789", "C0789", "C0789"]);
    await s.stop();
  });

  it("says when the service is not connected rather than joining", async () => {
    const s = await setup({ token: "xoxp-user-1" });
    expect(await s.harness.callRpc("joinChannel", { channel: "C0789" })).toMatchObject({ state: "unavailable", message: expect.stringContaining("not connected to bb-gate-hooks") });
    expect(s.hooks.joins).toEqual([]);
  });

  it("says so when the join request itself fails", async () => {
    const s = await live({ token: "xoxp-user-1" });
    s.hooks.state.join = () => {
      throw new Error("network down");
    };
    expect(await s.harness.callRpc("joinChannel", { channel: "C0789" })).toMatchObject({ state: "unavailable", message: expect.stringContaining("/invite @bb") });
    await s.stop();
  });

  it("asks for sign-in when the stored token is an OpenID one, never logging it", async () => {
    const slack = fakeSlack({ tokenError: "not_allowed_token_type" });
    const s = await live({ slack, token: "xoxp-old-openid" });
    const result = (await s.harness.callRpc("searchChannels", { query: "" })) as ChannelSearchResult;
    expect(result).toMatchObject({ state: "signin-required", channels: [], botChannels: null });
    expect(s.harness.logEntries.map((l) => l.message).join("\n")).not.toContain("xoxp-old-openid");
    await s.stop();
  });

  it("asks for sign-in when no token is stored", async () => {
    const s = await live();
    const result = (await s.harness.callRpc("searchChannels", { query: "" })) as ChannelSearchResult;
    expect(result).toMatchObject({ state: "signin-required", channels: [] });
    expect(s.slack.requests).toHaveLength(0);
    await s.stop();
  });

  it("reports Slack as unavailable without failing the settings page", async () => {
    const slack = fakeSlack({ tokenError: "ratelimited" });
    const s = await live({ slack, token: "xoxp-user-1" });
    const result = (await s.harness.callRpc("searchChannels", { query: "" })) as ChannelSearchResult;
    expect(result.state).toBe("unavailable");
    expect(result.message).toBeTruthy();
    expect(s.harness.logEntries.map((l) => l.message).join("\n")).not.toContain("xoxp-user-1");
    await s.stop();
  });

  it("still saves the map when the picker has no channel list", async () => {
    const s = await live({ token: "xoxp-old-openid", slack: fakeSlack({ tokenError: "missing_scope" }) });
    expect((await s.harness.callRpc("setMap", { fallback: "Project One", channels: [{ channel: "G0456", project: "Project One" }] })) as { ok: boolean }).toEqual({ ok: true });
    expect(((await s.harness.callRpc("status")) as { channels: unknown }).channels).toEqual([{ channel: "G0456", project: "Project One" }]);
    await s.stop();
  });

  it("posts a reply through the service with the connection id only, once per message", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session());
    await tick();
    const first = await s.tool("slack_reply", { text: "On it, done by Alice's bb." }, { threadId: "thr-1" });
    expect(s.text(first)).toContain("Replied in Slack");
    expect(s.hooks.messages).toEqual([{ session: "D0123:1712345678.901234", body: { connection: "c_1", text: "On it, done by Alice's bb." } }]);
    const second = await s.tool("slack_reply", { text: "More." }, { threadId: "thr-1" });
    expect(s.text(second)).toContain("already has its reply");
    expect(s.hooks.messages).toHaveLength(1);
    await s.stop();
  });

  it("acknowledges a wake without posting a reply, and refuses a later reply", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session());
    await tick();
    const ack = await s.tool("slack_ack", {}, { threadId: "thr-1" });
    expect(s.text(ack)).toContain("Acknowledged");
    expect(s.hooks.messages).toEqual([]);
    const reply = await s.tool("slack_reply", { text: "On it." }, { threadId: "thr-1" });
    expect(s.text(reply)).toContain("already has its reply");
    expect(s.hooks.messages).toEqual([]);
    await s.stop();
  });

  it("takes an explicit session for an ack, and refuses one with no session", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session());
    await tick();
    const ack = await s.tool("slack_ack", { session: "D0123:1712345678.901234" }, { threadId: "thr-other" });
    expect(s.text(ack)).toContain("Acknowledged");
    expect(s.hooks.messages).toEqual([]);
    const noSession = await s.tool("slack_ack", {}, { threadId: "thr-other" });
    expect(s.text(noSession)).toContain("not answering a Slack conversation");
    await s.stop();
  });

  it("clears the thinking status on an ack", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session());
    await tick();
    await s.tool("slack_ack", {}, { threadId: "thr-1" });
    expect(s.hooks.statuses.at(-1)).toMatchObject({ session: "D0123:1712345678.901234", body: { connection: "c_1", status: "" } });
    await s.stop();
  });

  it("posts no backstop after an ack", async () => {
    const s = await live({ turns: [{ createdAt: 1_000_000_000_001, data: { request: { params: { input: [{ type: "text", text: "session D0123:1712345678.901234" }] } } } }] });
    s.hooks.last().send(s.hooks.session());
    await tick();
    await s.tool("slack_ack", {}, { threadId: "thr-1" });
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages).toEqual([]);
    await s.stop();
  });

  it("refuses an ack after a reply", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session());
    await tick();
    await s.tool("slack_reply", { text: "On it." }, { threadId: "thr-1" });
    const ack = await s.tool("slack_ack", {}, { threadId: "thr-1" });
    expect(s.text(ack)).toContain("already has its reply");
    expect(s.hooks.messages).toHaveLength(1);
    await s.stop();
  });

  it("converts Markdown in a slack_reply to Slack mrkdwn before posting", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session());
    await tick();
    const result = await s.tool("slack_reply", { text: "# Title\n\n**bold** and *italic* and ~~old~~\n\n- [docs](https://x.test)" }, { threadId: "thr-1" });
    expect(s.text(result)).toContain("Replied in Slack");
    expect(s.hooks.messages).toHaveLength(1);
    expect(s.hooks.messages[0]!.body.text).toBe("*Title*\n\n*bold* and _italic_ and ~old~\n\n• <https://x.test|docs>");
    await s.stop();
  });

  it("converts Markdown in a plugin backstop reply too", async () => {
    const s = await live();
    // A non-owner's held message is echoed in the plugin's own prompt, which is
    // posted through the same postReply path as the agent's reply.
    s.hooks.last().send(
      s.hooks.session({
        session: "C0123:1.2",
        channel: "C0123",
        mention: true,
        fromOwner: false,
        asker: { id: "U9999", name: "Carol" },
        comment: { text: "**halt** work", untrusted: true },
      }),
    );
    await tick();
    const posted = String(s.hooks.messages.at(-1)?.body.text ?? "");
    expect(posted).toContain('"*halt* work"');
    expect(posted).not.toContain("**halt**");
    await s.stop();
  });

  it("refuses a reply whose converted text would exceed the 32 KiB cap", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session());
    await tick();
    // 20,000 ampersands are under the character cap, but escaping each to
    // `&amp;` grows the posted text past 32 KiB.
    const result = await s.tool("slack_reply", { text: "&".repeat(20_000) }, { threadId: "thr-1" });
    expect(s.text(result)).toContain("Shorten it");
    expect(s.hooks.messages).toEqual([]);
    await s.stop();
  });

  it("answers for a turn that ended without a reply, and pushes the bb thread's title", async () => {
    const s = await live({ turns: [{ createdAt: 1_000_000_000_001, data: { request: { params: { input: [{ type: "text", text: "session D0123:1712345678.901234" }] } } } }] });
    s.hooks.last().send(s.hooks.session());
    await tick();
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages.map((m) => m.body.text)).toEqual([expect.stringContaining("finished its turn without sending a reply")]);
    expect(s.hooks.titles.at(-1)).toMatchObject({ session: "D0123:1712345678.901234", body: { connection: "c_1", title: "Build BB-38" } });
    await s.stop();
  });

  it("does not post a backstop for an untagged wake whose turn ends without a reply", async () => {
    // A turn that names the session would be caught by the backstop for a
    // tagged wake; an untagged one is not counted, so it must not be.
    const s = await live({ turns: [{ createdAt: 1_000_000_000_001, data: { request: { params: { input: [{ type: "text", text: "session C0123:1712345678.901234" }] } } } }] });
    s.hooks.last().send(
      s.hooks.session({
        session: "C0123:1712345678.901234",
        channel: "C0123",
        thread: "1712345678.901234",
        mention: false,
        tagged: false,
        comment: { text: "what about the second one?", untrusted: false },
      }),
    );
    await tick();
    // The wake is still handed to a bb thread.
    expect(s.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages).toEqual([]);
    // Neither the channel nor the untagged text reaches a log line.
    const logs = s.harness.logEntries.map((l) => l.message).join("\n");
    expect(logs).not.toContain("C0123");
    expect(logs).not.toContain("what about the second one?");
    await s.stop();
  });

  it("lets a turn reply once to an untagged wake even though it does not owe one", async () => {
    const s = await live();
    s.hooks.last().send(
      s.hooks.session({
        session: "C0123:1712345678.901234",
        channel: "C0123",
        thread: "1712345678.901234",
        mention: false,
        tagged: false,
        comment: { text: "what about the second one?", untrusted: false },
      }),
    );
    await tick();
    const first = await s.tool("slack_reply", { text: "Yes, that one." }, { threadId: "thr-1" });
    expect(s.text(first)).toContain("Replied in Slack");
    expect(s.hooks.messages).toHaveLength(1);
    // One reply per message still holds: the untagged wake does not open the
    // door to a second reply.
    const second = await s.tool("slack_reply", { text: "More." }, { threadId: "thr-1" });
    expect(s.text(second)).toContain("already has its reply");
    expect(s.hooks.messages).toHaveLength(1);
    // And a turn that did reply never trips the backstop.
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages).toHaveLength(1);
    await s.stop();
  });

  it("still posts a backstop for a tagged wake, and a missing tagged field counts as tagged", async () => {
    // `session()` sends no `tagged` field at all: the schema defaults it to
    // true, exactly as it does for an older service.
    const s = await live({ turns: [{ createdAt: 1_000_000_000_001, data: { request: { params: { input: [{ type: "text", text: "session D0123:1712345678.901234" }] } } } }] });
    s.hooks.last().send(s.hooks.session());
    await tick();
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages.map((m) => m.body.text)).toEqual([expect.stringContaining("finished its turn without sending a reply")]);
    await s.stop();
  });

  it("steers a follow-up into the running turn and does not backstop when the turn replies once", async () => {
    // The first wake spawns and starts a turn. The second arrives while it
    // runs, so the server joins it: `mode: "steer"` with a `join-turn`
    // dispatch. The turn's one reply covers both Slack messages.
    const s = await live({
      sendAttempt: "join-turn",
      turns: [{ createdAt: 1_000_000_000_001, data: { request: { params: { input: [{ type: "text", text: "session D0123:1712345678.901234" }] } } } }],
    });
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    s.hooks.last().send(s.hooks.session({ comment: { text: "wait, use the other branch", untrusted: false } }));
    await tick();
    const sends = s.harness.sdk.callsTo("threads.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]![0]).toMatchObject({ threadId: "thr-1", mode: "steer" });
    expect(JSON.stringify(sends[0]![0])).toContain("wait, use the other branch");
    // The wake says the words arrived while the previous message was handled.
    expect(JSON.stringify(sends[0]![0])).toContain("while the previous one was being handled");
    expect(JSON.stringify(sends[0]![0])).toContain("correction or addition");
    // One reply covers both wakes, and the backstop stays quiet.
    const reply = await s.tool("slack_reply", { text: "Switched to the other branch." }, { threadId: "thr-1" });
    expect(s.text(reply)).toContain("Replied in Slack");
    expect(s.hooks.messages).toHaveLength(1);
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages).toHaveLength(1);
    await s.stop();
  });

  it("starts a turn for a follow-up on an idle thread and needs its own reply", async () => {
    // The first wake's turn replied and the thread is idle, so the second wake
    // is a `start-turn` dispatch: it owes a reply of its own, as before.
    const s = await live({ sendAttempt: "start-turn" });
    s.hooks.last().send(s.hooks.session());
    await tick();
    await s.tool("slack_reply", { text: "Done." }, { threadId: "thr-1" });
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages).toHaveLength(1);
    s.hooks.last().send(s.hooks.session({ comment: { text: "and the docs", untrusted: false } }));
    await tick();
    const sends = s.harness.sdk.callsTo("threads.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]![0]).toMatchObject({ mode: "steer" });
    // The new turn owes its own reply, so slack_reply is allowed again.
    const reply = await s.tool("slack_reply", { text: "Docs too." }, { threadId: "thr-1" });
    expect(s.text(reply)).toContain("Replied in Slack");
    expect(s.hooks.messages).toHaveLength(2);
    await s.stop();
  });

  it("posts exactly one backstop when a turn ends silent after a steer", async () => {
    const s = await live({
      sendAttempt: "join-turn",
      turns: [{ createdAt: 1_000_000_000_001, data: { request: { params: { input: [{ type: "text", text: "session D0123:1712345678.901234" }] } } } }],
    });
    s.hooks.last().send(s.hooks.session());
    await tick();
    s.hooks.last().send(s.hooks.session({ comment: { text: "wait", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    // The steer adds no obligation: the session still counts one tagged wake.
    const stored = (await s.bb.storage.kv.get("sessions")) as Record<string, { events: number; steeredAt: number | null }>;
    expect(stored["D0123:1712345678.901234"]).toMatchObject({ events: 1 });
    expect(stored["D0123:1712345678.901234"]!.steeredAt).not.toBeNull();
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages.map((m) => m.body.text)).toEqual([expect.stringContaining("finished its turn without sending a reply")]);
    // A second idle posts nothing more.
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages).toHaveLength(1);
    await s.stop();
  });

  it("keeps a tagged steer's own reply when the running turn has already replied", async () => {
    // An untagged first wake starts the thread with no tagged obligation. Its
    // turn replies, then a tagged wake steers in before the turn ends: nothing
    // is outstanding for the steer to share, so it keeps its own reply.
    const s = await live({ sendAttempt: "join-turn" });
    s.hooks.last().send(s.hooks.session({ session: "C0123:1.2", channel: "C0123", mention: false, tagged: false, comment: { text: "what about the second one?", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    await s.tool("slack_reply", { text: "Yes, that one." }, { threadId: "thr-1" });
    expect(s.hooks.messages).toHaveLength(1);
    s.hooks.last().send(s.hooks.session({ session: "C0123:1.2", channel: "C0123", mention: true, tagged: true, comment: { text: "and the docs", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    // The steer owes a reply of its own: slack_reply is allowed again.
    const reply = await s.tool("slack_reply", { text: "Docs too." }, { threadId: "thr-1" });
    expect(s.text(reply)).toContain("Replied in Slack");
    expect(s.hooks.messages).toHaveLength(2);
    await s.stop();
  });

  it("posts one backstop when a queued steer later joins a turn that does not name the session", async () => {
    // `threads.send` can resolve `queued` (a turn was starting, or a plugin
    // held it), so the hook has not run and the plugin reads no attempt. At
    // drain the row joins a turn started by something other than this wake, so
    // that turn's input never names the session; `steeredAt` is what tells the
    // backstop the turn handled the wake.
    const s = await live({ turns: [] });
    s.hooks.last().send(s.hooks.session());
    await tick();
    s.hooks.last().send(s.hooks.session({ comment: { text: "wait", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    const hook = s.harness.registrations.hooks["message.dispatch"]!;
    await hook(
      makeMessageDispatchHookContext({
        thread: { id: "thr-1" },
        input: { blocks: [], text: "session D0123:1712345678.901234" },
        attempt: "join-turn",
        experimental_submission: { pluginId: "slack", data: { session: "D0123:1712345678.901234" } },
      }),
    );
    await tick();
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages.map((m) => m.body.text)).toEqual([expect.stringContaining("finished its turn without sending a reply")]);
    await s.stop();
  });

  it("rewrites a still-queued message in place when it is edited", async () => {
    const s = await live({ send: () => ({ delivery: "queued", queuedMessage: { id: "qm-1", updatedAt: 5 } }) });
    // The first wake spawns the thread; the second becomes a queued row.
    s.hooks.last().send(s.hooks.session({ ts: "1.1" }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    s.hooks.last().send(s.hooks.session({ ts: "1.2", comment: { text: "the first draft", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(1);

    // The edit rewrites the queued row in place, with the wake's own framing.
    s.hooks.last().send(s.hooks.session({ action: "edited", ts: "1.2", comment: { text: "the second draft", untrusted: false } }));
    await tick();
    const updates = s.harness.sdk.callsTo("threads.queuedMessages.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]![0]).toMatchObject({ threadId: "thr-1", queuedMessageId: "qm-1", expectedUpdatedAt: 5 });
    const input = (updates[0]![0] as { input: Array<{ text: string }> }).input;
    expect(input[0]!.text).toContain("the second draft");
    expect(input[0]!.text).toContain("session D0123:1712345678.901234");
    // A second edit uses the row's new version, so it still rewrites in place.
    s.hooks.last().send(s.hooks.session({ action: "edited", ts: "1.2", comment: { text: "the third draft", untrusted: false } }));
    await tick();
    const second = s.harness.sdk.callsTo("threads.queuedMessages.update");
    expect(second).toHaveLength(2);
    expect(second[1]![0]).toMatchObject({ expectedUpdatedAt: 6 });
    expect(JSON.stringify(second[1]![0])).toContain("the third draft");
    // A still-queued correction is not steered and starts no new turn.
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    await s.stop();
  });

  it("steers when the queued row dispatched before the edit", async () => {
    const s = await live({ send: () => ({ delivery: "queued", queuedMessage: { id: "qm-3", updatedAt: 5 } }) });
    s.hooks.last().send(s.hooks.session({ ts: "7.1" }));
    await tick();
    s.hooks.last().send(s.hooks.session({ ts: "7.2", comment: { text: "the first draft", untrusted: false } }));
    await tick();
    // The row drains: its turn has started, so the recorded wake is now started.
    await s.harness.behavior.emitThreadEvent("message.dispatched", { entry: { id: "qm-3" } as never });
    await tick();
    s.hooks.last().send(s.hooks.session({ action: "edited", ts: "7.2", comment: { text: "the second draft", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(0);
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(2);
    expect(JSON.stringify(s.harness.sdk.callsTo("threads.send")[1]![0])).toContain("was edited");
    await s.stop();
  });

  it("steers when a queued row moved on before the edit could rewrite it", async () => {
    const s = await live({
      send: () => ({ delivery: "queued", queuedMessage: { id: "qm-4", updatedAt: 5 } }),
      updateQueued: () => {
        throw Object.assign(new Error("row moved on"), { status: 409 });
      },
    });
    s.hooks.last().send(s.hooks.session({ ts: "8.1" }));
    await tick();
    s.hooks.last().send(s.hooks.session({ ts: "8.2", comment: { text: "the first draft", untrusted: false } }));
    await tick();
    s.hooks.last().send(s.hooks.session({ action: "edited", ts: "8.2", comment: { text: "the second draft", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(1);
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(2);
    expect(JSON.stringify(s.harness.sdk.callsTo("threads.send")[1]![0])).toContain("was edited");
    await s.stop();
  });

  it("steers the thread when a message whose turn started is edited", async () => {
    const s = await live({ sendAttempt: "start-turn" });
    s.hooks.last().send(s.hooks.session({ ts: "2.1" }));
    await tick();
    s.hooks.last().send(s.hooks.session({ ts: "2.2", comment: { text: "the first draft", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(1);

    s.hooks.last().send(s.hooks.session({ action: "edited", ts: "2.2", comment: { text: "the second draft", untrusted: false } }));
    await tick();
    const sends = s.harness.sdk.callsTo("threads.send");
    expect(sends).toHaveLength(2);
    const body = JSON.stringify(sends[1]![0]);
    expect(body).toContain("was edited");
    expect(body).toContain("it now reads");
    expect(body).toContain("the first draft");
    expect(body).toContain("the second draft");
    expect(s.harness.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(0);
    await s.stop();
  });

  it("removes a still-queued message when it is deleted", async () => {
    const s = await live({ send: () => ({ delivery: "queued", queuedMessage: { id: "qm-2", updatedAt: 9 } }) });
    s.hooks.last().send(s.hooks.session({ ts: "3.1" }));
    await tick();
    s.hooks.last().send(s.hooks.session({ ts: "3.2", comment: { text: "please do this", untrusted: false } }));
    await tick();

    s.hooks.last().send(s.hooks.session({ action: "deleted", ts: "3.2", comment: { text: "", untrusted: false } }));
    await tick();
    const deletes = s.harness.sdk.callsTo("threads.queuedMessages.delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]![0]).toMatchObject({ threadId: "thr-1", queuedMessageId: "qm-2" });
    // The removed wake owes no reply, and no steer was sent.
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    const stored = (await s.bb.storage.kv.get("sessions")) as Record<string, { events: number }>;
    expect(stored["D0123:1712345678.901234"]).toMatchObject({ events: 1 });
    await s.stop();
  });

  it("steers the thread when a message whose turn started is deleted", async () => {
    const s = await live({ sendAttempt: "start-turn" });
    s.hooks.last().send(s.hooks.session({ ts: "4.1" }));
    await tick();
    s.hooks.last().send(s.hooks.session({ ts: "4.2", comment: { text: "please do this", untrusted: false } }));
    await tick();

    s.hooks.last().send(s.hooks.session({ action: "deleted", ts: "4.2", comment: { text: "", untrusted: false } }));
    await tick();
    const sends = s.harness.sdk.callsTo("threads.send");
    expect(sends).toHaveLength(2);
    const body = JSON.stringify(sends[1]![0]);
    expect(body).toContain("was deleted");
    expect(body).toContain("disregard it");
    expect(body).toContain("No reply is needed");
    expect(s.harness.sdk.callsTo("threads.queuedMessages.delete")).toHaveLength(0);
    await s.stop();
  });

  it("ignores an edit of a message that produced no wake", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session({ ts: "5.1" }));
    await tick();
    s.hooks.last().send(s.hooks.session({ action: "edited", ts: "9.9", comment: { text: "nope", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(0);
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(0);
    await s.stop();
  });

  it("holds an edit from someone other than the owner like the original message", async () => {
    const s = await live();
    // The owner's first wake spawns the thread; the non-owner's message is held.
    s.hooks.last().send(s.hooks.session({ ts: "6.1" }));
    await tick();
    s.hooks.last().send(s.hooks.session({ ts: "6.2", fromOwner: false, asker: { id: "U9999", name: "Carol" }, comment: { text: "halt work", untrusted: true } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(0);

    s.hooks.last().send(s.hooks.session({ action: "edited", ts: "6.2", fromOwner: false, asker: { id: "U9999", name: "Carol" }, comment: { text: "halt all work", untrusted: true } }));
    await tick();
    // Still no turn runs, and the edited words are what the owner is asked to confirm.
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(s.harness.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(0);
    const prompt = String(s.hooks.messages.at(-1)?.body.text ?? "");
    expect(prompt).toContain("Carol asked");
    expect(prompt).toContain("halt all work");
    await s.stop();
  });

  it("keeps a queued message's files line across a second edit", async () => {
    const s = await live({ send: () => ({ delivery: "queued", queuedMessage: { id: "qm-f", updatedAt: 5 } }) });
    s.hooks.last().send(s.hooks.session({ ts: "10.1" }));
    await tick();
    const files = [{ id: "F1", name: "shot.png", mimeType: "image/png", size: 1234 }];
    s.hooks.last().send(s.hooks.session({ ts: "10.2", comment: { text: "the first draft", untrusted: false }, files }));
    await tick();
    // A correction wake carries no files; the recorded ones must survive it.
    s.hooks.last().send(s.hooks.session({ action: "edited", ts: "10.2", comment: { text: "the second draft", untrusted: false } }));
    await tick();
    s.hooks.last().send(s.hooks.session({ action: "edited", ts: "10.2", comment: { text: "the third draft", untrusted: false } }));
    await tick();
    const updates = s.harness.sdk.callsTo("threads.queuedMessages.update");
    expect(updates).toHaveLength(2);
    expect(JSON.stringify(updates[1]![0])).toContain("shot.png");
    expect(JSON.stringify(updates[1]![0])).toContain("the third draft");
    await s.stop();
  });

  it("leaves a queued message alone on a transient rewrite failure", async () => {
    const s = await live({
      send: () => ({ delivery: "queued", queuedMessage: { id: "qm-t", updatedAt: 5 } }),
      updateQueued: () => {
        throw Object.assign(new Error("try later"), { status: 503 });
      },
    });
    s.hooks.last().send(s.hooks.session({ ts: "11.1" }));
    await tick();
    s.hooks.last().send(s.hooks.session({ ts: "11.2", comment: { text: "the first draft", untrusted: false } }));
    await tick();
    s.hooks.last().send(s.hooks.session({ action: "edited", ts: "11.2", comment: { text: "the second draft", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(1);
    // No steer: the stale row is still queued and would arrive after the correction.
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    await s.stop();
  });

  it("does not set the thinking status for a deletion", async () => {
    const s = await live({ sendAttempt: "start-turn" });
    s.hooks.last().send(s.hooks.session({ ts: "12.1" }));
    await tick();
    s.hooks.last().send(s.hooks.session({ ts: "12.2", comment: { text: "please do this", untrusted: false } }));
    await tick();
    const before = s.hooks.statuses.length;
    s.hooks.last().send(s.hooks.session({ action: "deleted", ts: "12.2", comment: { text: "", untrusted: false } }));
    await tick();
    // The deletion steers without a thinking indicator that nothing would clear.
    expect(s.hooks.statuses.length).toBe(before);
    await s.stop();
  });

  it("withdraws a held request when the non-owner deletes their message", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session({ ts: "13.1" }));
    await tick();
    s.hooks.last().send(s.hooks.session({ ts: "13.2", fromOwner: false, asker: { id: "U9999", name: "Carol" }, comment: { text: "halt work", untrusted: true } }));
    await tick();
    const pendingBefore = (await s.bb.storage.kv.get("sessions/pending")) as Record<string, { requests: unknown[] }>;
    expect(pendingBefore["D0123:1712345678.901234"]?.requests).toHaveLength(1);

    s.hooks.last().send(s.hooks.session({ action: "deleted", ts: "13.2", fromOwner: false, asker: { id: "U9999", name: "Carol" }, comment: { text: "", untrusted: true } }));
    await tick();
    const pendingAfter = (await s.bb.storage.kv.get("sessions/pending")) as Record<string, { requests: unknown[] } | undefined>;
    expect(pendingAfter["D0123:1712345678.901234"]).toBeUndefined();
    await s.stop();
  });

  it("ignores a non-owner's deletion after the owner confirmed their message", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session({ ts: "14.1" }));
    await tick();
    // A non-owner message is held.
    s.hooks.last().send(s.hooks.session({ ts: "14.2", fromOwner: false, asker: { id: "U9999", name: "Carol" }, comment: { text: "halt work", untrusted: true } }));
    await tick();
    const prompt = String(s.hooks.messages.at(-1)?.body.text ?? "");
    const id = /confirm (r-[a-z0-9]+)/u.exec(prompt)?.[1];
    expect(id).toBeTruthy();
    // The owner confirms it: the confirm message is its own outstanding wake.
    s.hooks.last().send(s.hooks.session({ ts: "14.3", comment: { text: `<@U-bb> confirm ${id}`, untrusted: false } }));
    await tick();
    const before = (await s.bb.storage.kv.get("sessions")) as Record<string, { events: number; answered: number }>;
    const sendsBefore = s.harness.sdk.callsTo("threads.send").length;

    // The non-owner deletes their original message: the request was already
    // taken, so nothing is withdrawn and the confirm wake keeps its obligation.
    s.hooks.last().send(s.hooks.session({ action: "deleted", ts: "14.2", fromOwner: false, asker: { id: "U9999", name: "Carol" }, comment: { text: "", untrusted: true } }));
    await tick();
    const after = (await s.bb.storage.kv.get("sessions")) as Record<string, { events: number; answered: number }>;
    expect(after["D0123:1712345678.901234"]).toMatchObject({ events: before["D0123:1712345678.901234"]!.events, answered: before["D0123:1712345678.901234"]!.answered });
    expect(s.harness.sdk.callsTo("threads.send").length).toBe(sendsBefore);
    await s.stop();
  });

  it("does not let an untagged hold prompt consume a tagged wake's reply slot", async () => {
    const s = await live({ turns: [{ createdAt: 1_000_000_000_001, data: { request: { params: { input: [{ type: "text", text: "session C0123:1712345678.901234" }] } } } }] });
    // A tagged owner wake, unanswered.
    s.hooks.last().send(s.hooks.session({ session: "C0123:1712345678.901234", channel: "C0123", mention: true, comment: { text: "build this", untrusted: false } }));
    await tick();
    // A non-owner untagged reply arrives; the confirm prompt answers the
    // untagged message, not the tagged one.
    s.hooks.last().send(
      s.hooks.session({
        session: "C0123:1712345678.901234",
        channel: "C0123",
        mention: false,
        tagged: false,
        fromOwner: false,
        asker: { id: "U9999", name: "Carol" },
        comment: { text: "halt work", untrusted: true },
      }),
    );
    await tick();
    expect(String(s.hooks.messages.at(-1)?.body.text)).toContain("Carol wrote");
    const before = s.hooks.messages.length;
    // The turn that handled the tagged wake ended silently: it still gets its
    // guaranteed backstop.
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages.length).toBe(before + 1);
    expect(String(s.hooks.messages.at(-1)?.body.text)).toContain("finished its turn without sending a reply");
    await s.stop();
  });

  it("holds an untagged reply from someone other than the owner, wording it as written not asked", async () => {
    const s = await live();
    s.hooks.last().send(
      s.hooks.session({
        session: "C0123:1712345678.901234",
        channel: "C0123",
        mention: false,
        tagged: false,
        fromOwner: false,
        asker: { id: "U9999", name: "Carol" },
        comment: { text: "halt work", untrusted: true },
      }),
    );
    await tick();
    // The words never reached a thread, and the owner is asked to confirm.
    expect(s.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    const prompt = String(s.hooks.messages.at(-1)?.body.text ?? "");
    expect(prompt).toContain("Carol wrote");
    expect(prompt).toContain("halt work");
    expect(prompt).not.toContain("Carol asked");
    // The held untagged reply's channel and user are not logged.
    const logs = s.harness.logEntries.map((l) => l.message).join("\n");
    expect(logs).not.toContain("C0123");
    expect(logs).not.toContain("Carol");
    await s.stop();
  });

  it("words a confirmed untagged reply as written even when the owner confirms with a mention", async () => {
    const s = await live();
    s.hooks.last().send(
      s.hooks.session({
        session: "C0123:1.2",
        channel: "C0123",
        mention: false,
        tagged: false,
        fromOwner: false,
        asker: { id: "U9999", name: "Carol" },
        comment: { text: "halt work", untrusted: true },
      }),
    );
    await tick();
    const id = /confirm (r-[a-z0-9]+)/u.exec(String(s.hooks.messages.at(-1)?.body.text ?? ""))?.[1];
    expect(id).toBeTruthy();
    // The owner confirms with a tagged mention; the held message's own tagged
    // flag decides the wording that reaches the thread.
    s.hooks.last().send(
      s.hooks.session({
        session: "C0123:1.2",
        channel: "C0123",
        mention: true,
        tagged: true,
        fromOwner: true,
        comment: { text: `<@U-bb> confirm ${id}`, untrusted: false },
      }),
    );
    await tick();
    const spawns = s.harness.sdk.callsTo("threads.spawn");
    expect(spawns).toHaveLength(1);
    const released = String((spawns[0]![0] as { prompt: string }).prompt);
    expect(released).toContain("Carol wrote");
    expect(released).not.toContain("Carol asked");
    await s.stop();
  });

  it("does not answer a turn that did not handle the wake", async () => {
    const s = await live({ turns: [{ createdAt: 1_000_000_000_000, data: { initiator: "client" } }] });
    s.hooks.last().send(s.hooks.session());
    await tick();
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages).toEqual([]);
    await s.stop();
  });

  it("clears an untagged wake's thinking status only after the turn that handled it has run", async () => {
    // The wake's own turn has not started: an older turn's idle must not clear
    // the indicator just set for the queued wake.
    const queued = await live({ turns: [{ createdAt: 999_999_999_999, data: { request: { params: { input: [{ type: "text", text: "session C0123:1.2" }] } } } }] });
    queued.hooks.last().send(queued.hooks.session({ session: "C0123:1.2", channel: "C0123", mention: false, tagged: false, comment: { text: "what about the second one?", untrusted: false } }));
    await tick();
    await queued.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(queued.hooks.statuses.map((s) => s.body.status)).not.toContain("");
    await queued.stop();

    // The silent untagged turn ran and ended: the indicator is cleared.
    const done = await live({ turns: [{ createdAt: 1_000_000_000_001, data: { request: { params: { input: [{ type: "text", text: "session C0123:1.2" }] } } } }] });
    done.hooks.last().send(done.hooks.session({ session: "C0123:1.2", channel: "C0123", mention: false, tagged: false, comment: { text: "what about the second one?", untrusted: false } }));
    await tick();
    await done.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(done.hooks.statuses.map((s) => s.body.status)).toContain("");
    await done.stop();
  });

  it("runs the thread in the project's checkout on its connected machine when it has no environment there", async () => {
    const s = await live({ map: { fallback: "prj-1", channels: [] }, environments: [] });
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({
      environment: { type: "provider", environmentProviderId: "project-checkout", inputs: null, machine: { type: "existing", hostId: "host_on" } },
    });
    await s.stop();
  });

  it("skips a default source whose machine is off for one that is on", async () => {
    const s = await live({
      environments: [],
      sources: [
        { type: "local_path", hostId: "host_off", isDefault: true },
        { type: "local_path", hostId: "host_on", isDefault: false },
      ],
    });
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({ environment: { machine: { hostId: "host_on" } } });
    await s.stop();
  });

  it("runs the thread in a project-checkout on a connected machine when the project has no environment or checkout there", async () => {
    const s = await live({ map: { fallback: "Project One", channels: [] }, environments: [], sources: [] });
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({
      environment: { type: "provider", environmentProviderId: "project-checkout", inputs: null, machine: { type: "existing", hostId: "host_on" } },
    });
    await s.stop();
  });

  it("uses the personal-workspace provider for a personal project with no environment or checkout on a connected machine", async () => {
    const s = await live({ environments: [], sources: [] });
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({
      environment: { type: "provider", environmentProviderId: "personal-workspace", inputs: null, machine: { type: "existing", hostId: "host_on" } },
    });
    await s.stop();
  });

  it("prefers a connected machine that hosts an active environment over any other connected one", async () => {
    const s = await live({
      map: { fallback: "Project One", channels: [] },
      environments: [],
      sources: [],
      hosts: [
        { id: "host_a", status: "connected" },
        { id: "host_z", status: "connected" },
      ],
      allEnvironments: [{ environmentProviderId: "multi-repo-workspace", hostId: "host_z", createdAt: 1, lifecycle: { phase: "active" }, environmentProviderSelection: null, projectId: "prj-1" }],
    });
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({
      environment: { type: "provider", environmentProviderId: "project-checkout", machine: { type: "existing", hostId: "host_z" } },
    });
    await s.stop();
  });

  it("posts a clear reply naming the project when no connected machine has it", async () => {
    const s = await live({ map: { fallback: "Project One", channels: [] }, environments: [], sources: [], hosts: [{ id: "host_off", status: "disconnected" }] });
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(s.hooks.messages.at(-1)?.body.text).toContain("No connected machine has the Project One project");
    await s.stop();
  });

  it("turns core's local-host-daemon 502 into the clear reply instead of the raw error", async () => {
    const s = await live({
      map: { fallback: "Project One", channels: [] },
      spawn: () => {
        throw new Error("HTTP 502: Local host daemon is not initialized");
      },
    });
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect(s.hooks.messages.at(-1)?.body.text).toContain("No connected machine has the Project One project");
    expect(s.hooks.messages.at(-1)?.body.text).not.toContain("Local host daemon");
    await s.stop();
  });

  it("flags only the projects with no checkout or environment on a connected machine", async () => {
    const s = await live({ sources: [] });
    const status = (await s.harness.callRpc("status")) as { projects: Array<{ id: string; name: string; kind: string; hasMachine: boolean }> };
    expect(status.projects).toEqual([
      { id: "prj-1", name: "Project One", kind: "standard", hasMachine: true },
      { id: "prj-2", name: "Personal", kind: "personal", hasMachine: false },
    ]);
    await s.stop();
  });

  it("flags every project when no machine is connected", async () => {
    const s = await live({ environments: [], sources: [], hosts: [{ id: "host_off", status: "disconnected" }] });
    const status = (await s.harness.callRpc("status")) as { projects: Array<{ hasMachine: boolean }> };
    expect(status.projects.every((project) => !project.hasMachine)).toBe(true);
    await s.stop();
  });

  it("says no project is available when the server has none", async () => {
    const s = await live({ projects: [] });
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(s.hooks.messages.at(-1)?.body.text).toContain("No bb project is available");
    await s.stop();
  });

  it("changes the fallback the next Slack conversation goes to", async () => {
    const s = await live();
    // prj-1 is the standard project; the empty fallback would pick the personal
    // prj-2, so this proves the saved fallback wins over the default.
    expect((await s.harness.callRpc("setMap", { fallback: "Project One", channels: [] })) as { ok: boolean }).toEqual({ ok: true });
    expect(((await s.harness.callRpc("status")) as { fallback: string }).fallback).toBe("Project One");
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect((s.harness.sdk.callsTo("threads.spawn")[0]![0] as { projectId: string }).projectId).toBe("prj-1");
    await s.stop();
  });

  it("starts a conversation in the personal project when the fallback is empty, even when it is not first", async () => {
    const s = await live();
    expect(((await s.harness.callRpc("status")) as { fallback: string }).fallback).toBe("");
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect((s.harness.sdk.callsTo("threads.spawn")[0]![0] as { projectId: string }).projectId).toBe("prj-2");
    await s.stop();
  });

  it("falls back to the personal project when the fallback names no project", async () => {
    const s = await live({ map: { fallback: "not-a-project", channels: [] } });
    expect(((await s.harness.callRpc("status")) as { fallback: string }).fallback).toBe("not-a-project");
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect((s.harness.sdk.callsTo("threads.spawn")[0]![0] as { projectId: string }).projectId).toBe("prj-2");
    await s.stop();
  });

  it("falls back to the first standard project when the server has no personal one", async () => {
    const s = await live({
      projects: [
        { id: "prj-1", name: "Project One", kind: "standard" },
        { id: "prj-3", name: "Project Two", kind: "standard" },
      ],
    });
    expect(((await s.harness.callRpc("status")) as { fallback: string }).fallback).toBe("");
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect((s.harness.sdk.callsTo("threads.spawn")[0]![0] as { projectId: string }).projectId).toBe("prj-1");
    await s.stop();
  });

  it("keeps the conversation's thread on a transient send error, and starts a new one only when it is gone", async () => {
    let sends = 0;
    const transient = await live({
      send: () => {
        sends += 1;
        if (sends === 1) throw new Error("the host is busy");
        return { outcome: "sent" };
      },
    });
    transient.hooks.last().send(transient.hooks.session());
    await tick();
    transient.hooks.last().send(transient.hooks.session({ comment: { text: "again", untrusted: false } }));
    await tick();
    transient.hooks.last().send(transient.hooks.session({ comment: { text: "third", untrusted: false } }));
    await tick();
    expect(transient.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(transient.harness.sdk.callsTo("threads.send")).toHaveLength(2);
    expect(transient.hooks.messages.at(-1)?.body.text).toContain("could not deliver");
    await transient.stop();

    let spawned = 0;
    const gone = await live({
      spawn: () => ({ id: `thr-${++spawned}` }),
      send: () => {
        throw Object.assign(new Error("thread not found"), { status: 404 });
      },
    });
    gone.hooks.last().send(gone.hooks.session());
    await tick();
    gone.hooks.last().send(gone.hooks.session({ comment: { text: "again", untrusted: false } }));
    await tick();
    expect(gone.harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
    await gone.stop();
  });

  it("greets on an assistant pane open without spawning a thread, a status, or a backstop", async () => {
    const s = await live({ turns: [{ createdAt: 1_000_000_000_001, data: { request: { params: { input: [{ type: "text", text: "session D0123:1712345678.901234" }] } } } }] });
    s.hooks.last().send(s.hooks.session({ action: "assistant_thread_started", comment: { text: "", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(s.hooks.messages).toEqual([{ session: "D0123:1712345678.901234", body: { connection: "c_1", text: ASSISTANT_GREETING } }]);
    // No thinking indicator is set for the pane open, and none is cleared.
    expect(s.hooks.statuses).toEqual([]);
    // The greeting already answered the wake; a turn's idle cannot trip the
    // backstop. (The pre-mapped re-open test below pins the answered count,
    // which this unmapped session cannot.)
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages).toHaveLength(1);
    await s.stop();
  });

  it("answers a pane-open wake on a conversation that already has a thread, so a turn's idle cannot trip the backstop", async () => {
    const s = await live({ turns: [{ createdAt: 1_000_000_000_001, data: { request: { params: { input: [{ type: "text", text: "session D0123:1712345678.901234" }] } } } }] });
    // The first message maps the session to thr-1, and its turn replies.
    s.hooks.last().send(s.hooks.session());
    await tick();
    await s.tool("slack_reply", { text: "hi" }, { threadId: "thr-1" });
    const before = s.hooks.messages.length;
    // Reopening the pane greets and starts nothing, but still answers the wake.
    s.hooks.last().send(s.hooks.session({ action: "assistant_thread_started", comment: { text: "", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(s.hooks.messages).toHaveLength(before + 1);
    // The mapped thread's turn idle must not fire the backstop for the pane open.
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages).toHaveLength(before + 1);
    await s.stop();
  });

  it("spawns the thread on the first real message after the pane opened, in the same session", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session({ action: "assistant_thread_started", comment: { text: "", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    s.hooks.last().send(s.hooks.session({ comment: { text: "build this", untrusted: false } }));
    await tick();
    const spawns = s.harness.sdk.callsTo("threads.spawn");
    expect(spawns).toHaveLength(1);
    const prompt = String((spawns[0]![0] as { prompt: string }).prompt);
    expect(prompt).toContain("session D0123:1712345678.901234");
    expect(prompt).toContain("build this");
    // The session record survived the pane open, so a follow-up continues the same bb thread.
    s.hooks.last().send(s.hooks.session({ comment: { text: "also the SSO page", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(s.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    await s.stop();
  });

  it("records a context change without running a turn or expecting a reply", async () => {
    const s = await live();
    s.hooks.last().send(s.hooks.session());
    await tick();
    await s.tool("slack_reply", { text: "hi" }, { threadId: "thr-1" });
    const before = s.hooks.messages.length;
    s.hooks.last().send(s.hooks.session({ action: "assistant_thread_context_changed", comment: { text: "", untrusted: false } }));
    await tick();
    expect(s.harness.sdk.callsTo("threads.send")).toEqual([]);
    expect(s.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages).toHaveLength(before);
    await s.stop();
  });

  it("forgets the token when the service refuses it on identify", async () => {
    const hooks = fakeHooks();
    hooks.state.identify = () => new Response("token refused", { status: 401 });
    const s = await live({ hooks, token: "xoxp-old" });
    expect((await s.harness.callRpc("status")) as { signedIn: boolean }).toMatchObject({ signedIn: false });
    expect(await s.bb.storage.kv.get("identity")).toBeUndefined();
    expect(s.harness.logEntries.map((l) => l.message).join("\n")).not.toContain("xoxp-old");
    await s.stop();
  });

  it("does not clear a newer token when an old one is refused", async () => {
    const hooks = fakeHooks();
    let setToken: (token: string) => Promise<void> = async () => undefined;
    hooks.state.identify = async () => {
      await setToken("xoxp-new");
      return new Response("token refused", { status: 401 });
    };
    const s = await setup({ hooks, token: "xoxp-old" });
    setToken = (token) => s.bb.storage.kv.set("signin/token", token);
    const service = s.harness.runService("slack");
    await tick();
    hooks.last().send(hooks.hello("c_1"));
    await tick();
    expect((await s.harness.callRpc("status")) as { signedIn: boolean }).toMatchObject({ signedIn: true });
    await service.controller.abort();
    await service.done;
  });

  it("moves the old token and map into kv once, clearing only the token setting", async () => {
    const s = await setup({
      settings: {
        token: "xoxp-old",
        project: "Project One",
        channels: JSON.stringify([
          { channel: "C0123", project: "Project Two" },
          { channel: "dm", project: "Personal" },
        ]),
      },
    });
    expect(await s.bb.storage.kv.get("signin/token")).toBe("xoxp-old");
    expect(await s.bb.storage.kv.get("routing/map")).toEqual({ fallback: "Personal", channels: [{ channel: "C0123", project: "Project Two" }] });

    // A second start with the marker set does not touch the map or the token.
    await s.bb.storage.kv.set("routing/map", { fallback: "Project Two", channels: [] });
    const next = await s.harness.lifecycle.reload(s.factory);
    expect(await next.bb.storage.kv.get("routing/map")).toEqual({ fallback: "Project Two", channels: [] });
    expect(await next.bb.storage.kv.get("signin/token")).toBe("xoxp-old");

    // Only the token setting was cleared; the old project and channels settings
    // stay in place for a rollback to the previous build.
    const legacy = next.bb.settings.define(legacySettingDescriptors);
    const old = await legacy.get();
    expect(old.token).toBeUndefined();
    expect(old.project).toBe("Project One");
    expect(old.channels).toBe(JSON.stringify([{ channel: "C0123", project: "Project Two" }, { channel: "dm", project: "Personal" }]));
  });

  it("never puts the token in the status or a settings RPC, and declares no settings after the migration", async () => {
    const s = await live({ token: "xoxp-secret-token" });
    const status = (await s.harness.callRpc("status")) as Record<string, unknown>;
    expect(status).not.toHaveProperty("token");
    expect(status).not.toHaveProperty("project");
    expect(JSON.stringify(status)).not.toContain("xoxp-secret-token");
    expect(JSON.stringify(await s.harness.callRpc("setMap", { fallback: "Project One", channels: [] }))).not.toContain("xoxp-secret-token");
    expect(JSON.stringify(await s.harness.callRpc("searchChannels", { query: "" }))).not.toContain("xoxp-secret-token");
    // The migration declares the old descriptors only on its own load; a later
    // load declares none, so bb core's declarative settings panel is empty.
    const next = await s.harness.lifecycle.reload(s.factory);
    expect(next.harness.registrations.settingsDescriptors).toEqual({});
    await s.stop();
  });
});
