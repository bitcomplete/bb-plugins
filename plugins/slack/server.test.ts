import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import serverEntry, { CALLBACK_PATH, createSlackPlugin, legacySettingDescriptors } from "./server.js";

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
  let botChannelRequests = 0;
  const state: {
    start: () => Response | Promise<Response>;
    exchange: () => Response | Promise<Response>;
    identify: () => Response | Promise<Response>;
    botChannels: () => Response | Promise<Response>;
    join: () => Response | Promise<Response>;
  } = {
    start: () => Response.json({ authorizeUrl: "https://slack.com/openid/connect/authorize?client_id=x", state: "st-1" }),
    exchange: () => Response.json({ token: "xoxp-user-token" }),
    identify: () => Response.json({ user: { id: "U0123", name: "Alice" }, teams: [], rejected: [] }),
    botChannels: () => Response.json({ channels: ["C0123", "G0456"] }),
    join: () => Response.json({ ok: true }),
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
      if (route[2] === "message") messages.push({ session, body });
      else if (route[2] === "status") statuses.push({ session, body });
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
const ENVIRONMENTS = [
  { environmentProviderId: "project-checkout", hostId: "host_on", createdAt: 1, lifecycle: { phase: "active" }, environmentProviderSelection: null },
  { environmentProviderId: "multi-repo-workspace", hostId: "host_on", createdAt: 2, lifecycle: { phase: "active" }, environmentProviderSelection: { inputs: { repos: ["a"] } } },
  { environmentProviderId: "git-worktree", hostId: "host_off", createdAt: 3, lifecycle: { phase: "active" }, environmentProviderSelection: null },
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
    environments?: Array<{ environmentProviderId: string | null; hostId: string; createdAt: number; lifecycle: { phase: string }; environmentProviderSelection: { inputs: unknown } | null }>;
    spawn?: () => unknown;
    send?: () => unknown;
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
  const { bb, harness } = createFakePluginHost({
    pluginId: "slack",
    appUrl: APP_URL,
    settings,
    sdk: {
      projects: {
        list: async () => options.projects ?? PROJECTS,
        get: async ({ projectId }: { projectId: string }) => ({ id: projectId, name: projectId, kind: "standard", sources: options.sources ?? SOURCES }),
      },
      hosts: { list: async () => options.hosts ?? HOSTS },
      environments: { list: async () => options.environments ?? ENVIRONMENTS },
      threads: {
        spawn: async () => options.spawn?.() ?? { id: "thr-1" },
        send: async () => options.send?.() ?? { outcome: "sent" },
        get: async () => options.get?.() ?? { title: "Build BB-38", titleFallback: null },
        events: { list: async () => options.turns ?? [] },
      },
    },
  });
  let now = 1_000_000_000_000;
  const factory = createSlackPlugin({ fetch: fetchImpl, now: () => now, env: { BB_HOOKS_URL: HOOKS_URL } });
  await factory(bb);
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
      projects: PROJECTS,
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
    expect(sends[0]![0]).toMatchObject({ threadId: "thr-1", mode: "auto" });
    expect(JSON.stringify(sends[0]![0])).toContain("also the SSO page");
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
        actionId: "bb_set_project",
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
    // An older bb-gate-hooks without the endpoint answers a bare 404.
    s.hooks.state.join = () => new Response("not found", { status: 404 });
    expect(await s.harness.callRpc("joinChannel", { channel: "C0789" })).toMatchObject({ state: "unavailable", message: fallback });
    // A name is never sent: the map stores ids.
    expect(await s.harness.callRpc("joinChannel", { channel: "general" })).toMatchObject({ state: "not-found", message: fallback });
    expect(s.hooks.joins.map((j) => j.channel)).toEqual(["G0456", "C0000", "C0001", "C0789", "C0789", "C0789"]);
    await s.stop();
  });

  it("says when the service is unreachable rather than joining", async () => {
    const s = await setup({ token: "xoxp-user-1" });
    expect(await s.harness.callRpc("joinChannel", { channel: "C0789" })).toMatchObject({ state: "unavailable", message: expect.stringContaining("/invite @bb") });
    expect(s.hooks.joins).toEqual([]);
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

  it("does not answer a turn that did not handle the wake", async () => {
    const s = await live({ turns: [{ createdAt: 1_000_000_000_000, data: { initiator: "client" } }] });
    s.hooks.last().send(s.hooks.session());
    await tick();
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr-1" } as never, lastAssistantText: null });
    await tick();
    expect(s.hooks.messages).toEqual([]);
    await s.stop();
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

  it("leaves the environment to bb only when the project has no connected machine", async () => {
    const s = await live({ environments: [], hosts: [{ id: "host_off", status: "disconnected" }] });
    s.hooks.last().send(s.hooks.session());
    await tick();
    expect(s.harness.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({ environment: { type: "project-default" } });
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
