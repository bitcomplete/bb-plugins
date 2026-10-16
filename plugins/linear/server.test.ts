import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signature, WATCH_LIMIT } from "./watch.js";
import { createLinearPlugin, REFRESH_MARGIN_MS } from "./server.js";
import { parseAccounts, serializeAccounts, type Account } from "./accounts.js";

const APP_URL = "https://bb.example";
const CALLBACK = "https://bb.example/api/v1/plugins/linear/http/connect/callback";
const DAY_MS = 86_400_000;

type Answer = (body: { query: string; variables?: Record<string, unknown> }, token: string) => unknown;

// A Linear whose token endpoint and GraphQL endpoint a test scripts.
function fakeLinear(options: { answer?: Answer; tokens?: () => Record<string, unknown>; valid?: (token: string) => boolean; organization?: (token: string) => { name: string; urlKey: string } } = {}) {
  const calls: Array<{ url: string; form?: URLSearchParams; token?: string; body?: { query: string; variables?: Record<string, unknown> } }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/oauth/token")) {
      const form = init?.body as URLSearchParams;
      calls.push({ url: u, form });
      return Response.json(options.tokens?.() ?? { access_token: `at-${form.get("grant_type")}`, refresh_token: "rt-1", expires_in: DAY_MS / 1000 });
    }
    if (u.endsWith("/oauth/revoke")) {
      calls.push({ url: u, token: (init?.headers as Record<string, string>).authorization });
      return new Response("", { status: 200 });
    }
    if (u.endsWith("/graphql")) {
      const token = ((init?.headers as Record<string, string>).authorization ?? "").replace(/^Bearer /u, "");
      const body = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, unknown> };
      calls.push({ url: u, token, body });
      if (options.valid !== undefined && !options.valid(token)) return Response.json({ errors: [{ message: "unauthorized" }] }, { status: 401 });
      if (body.query.startsWith("query { viewer")) {
        return Response.json({ data: { viewer: { id: "u1", name: "Jane", displayName: "jane", email: "jane@acme.test" }, organization: options.organization?.(token) ?? { name: "Acme", urlKey: "acme" } } });
      }
      return Response.json(options.answer?.(body, token) ?? { data: {} });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const HOOKS_URL = "http://bb-gate-hooks.test:8081";

// A bb-gate-hooks whose event stream a test writes to and whose subscribe answers it scripts.
function fakeHooks() {
  const encoder = new TextEncoder();
  const streams: Array<{ send(text: string): void; closed: boolean }> = [];
  const subscribes: Array<{ connection: string; source: string; token: string; watches: Array<{ kind: string; id: string }> }> = [];
  const state = { answer: (body: (typeof subscribes)[number]): Response => Response.json({ leases: body.watches, rejected: [] }) };
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
    if (u === `${HOOKS_URL}/v1/subscribe`) {
      const body = JSON.parse(String(init?.body)) as (typeof subscribes)[number];
      subscribes.push(body);
      return state.answer(body);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    streams,
    subscribes,
    state,
    last: () => streams.at(-1)!,
    hello: (connection: string) => `event: hello\ndata: ${JSON.stringify({ connection, leaseSeconds: 3600 })}\n\n`,
    doorbell: (id: string, unit = "team-1") => `event: doorbell\ndata: ${JSON.stringify({ source: "linear", kind: "issue", id, unit, action: "update", at: "2026-10-10T17:02:11Z" })}\n\n`,
  };
}

// A stewards plugin that records every call made to it.
function fakeStewards() {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const callRpc = vi.fn(async (args: { pluginId: string; method: string; input?: unknown }) => {
    if (args.pluginId !== "stewards") throw new Error(`unexpected plugin ${args.pluginId}`);
    calls.push({ method: args.method, input: args.input as Record<string, unknown> });
    return { ok: true };
  });
  return { callRpc, calls, to: (method: string) => calls.filter((c) => c.method === method).map((c) => c.input) };
}

const issue = (over: Record<string, unknown> = {}) => ({
  id: "uuid-1",
  identifier: "ENG-123",
  title: "Fix login",
  description: "Users cannot log in.",
  url: "https://linear.app/acme/issue/ENG-123",
  state: { name: "In Progress", type: "started" },
  team: { key: "ENG", name: "Engineering", states: { nodes: [{ id: "s-todo", name: "Todo", type: "unstarted", position: 0 }, { id: "s-done", name: "Done", type: "completed", position: 2 }] } },
  assignee: { displayName: "jane" },
  comments: { nodes: [] },
  ...over,
});

async function setup(
  options: {
    settings?: Record<string, string>;
    env?: Record<string, string>;
    linear?: Parameters<typeof fakeLinear>[0];
    expiresAt?: number;
    hooks?: ReturnType<typeof fakeHooks>;
    sdk?: Parameters<typeof createFakePluginHost>[0] extends { sdk?: infer S } | undefined ? S : never;
    /** kv the plugin finds when it starts, as after a restart. */
    kv?: Record<string, unknown>;
    /** Connected to the acme workspace with this access token. */
    token?: string;
    refreshToken?: string;
    /** More connected workspaces, beside acme's. */
    accounts?: Account[];
  } = {},
) {
  const seeded: Account[] = [
    ...(options.token === undefined ? [] : [account("acme", options.token, { refreshToken: options.refreshToken ?? null, expiresAt: options.expiresAt ?? null })]),
    ...(options.accounts ?? []),
  ];
  const { bb, harness } = createFakePluginHost({
    pluginId: "linear",
    appUrl: APP_URL,
    settings: { clientId: "client-1", ...(seeded.length === 0 ? {} : { accounts: serializeAccounts(seeded) }), ...options.settings },
    ...(options.sdk === undefined ? {} : { sdk: options.sdk }),
  });
  const linear = fakeLinear(options.linear);
  let now = 1_000_000_000_000;
  for (const [key, value] of Object.entries(options.kv ?? {})) await bb.storage.kv.set(key, value);
  // The plugin's own settings handle, so a test can read what it stored (the fake host has no getter).
  let handle!: { get(): Promise<Record<string, unknown>> };
  const define = bb.settings.define.bind(bb.settings);
  bb.settings.define = ((descriptors: Parameters<typeof define>[0]) => (handle = define(descriptors))) as typeof define;
  const fetchImpl = (options.hooks === undefined ? linear.fetchImpl : ((url, init) => (String(url).startsWith(HOOKS_URL) ? options.hooks!.fetchImpl(url, init) : linear.fetchImpl(url, init))) as typeof fetch);
  await createLinearPlugin({ fetch: fetchImpl, now: () => now, env: options.env ?? {} })(bb);
  if (options.expiresAt !== undefined && options.token === undefined) await bb.storage.kv.set("expiresAt", options.expiresAt);
  const route = harness.registrations.httpRoutes.find((r) => r.path === "/connect/callback")!;
  const app = new Hono().get("/cb", route.handler);
  const callback = (query: Record<string, string>) => app.request(`/cb?${new URLSearchParams(query)}`);
  const tool = (name: string, args: Record<string, unknown>, ctx?: { threadId?: string; projectId?: string }) =>
    harness.behavior.callAgentTool(name, args, ctx) as Promise<string | { content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  const text = (result: Awaited<ReturnType<typeof tool>>) => (typeof result === "string" ? result : result.content.map((c) => c.text ?? "").join(""));
  const stored = async () => parseAccounts((await handle.get()).accounts as string | undefined);
  /** Move one workspace's token expiry, as time passing would. */
  const setExpiry = async (key: string, expiresAt: number | null) =>
    void (await harness.setSettings({ accounts: serializeAccounts((await stored()).map((a) => (a.key === key ? { ...a, expiresAt } : a))) }));
  return { bb, harness, linear, callback, route, tool, text, stored, setExpiry, advance: (ms: number) => (now += ms), now: () => now };
}

/** A connected workspace as the accounts setting stores it. */
function account(key: string, accessToken: string, over: Partial<Account> = {}): Account {
  return {
    key,
    accessToken,
    refreshToken: null,
    expiresAt: null,
    user: { id: key === "acme" ? "u1" : `u-${key}`, name: "jane", email: "jane@acme.test" },
    organization: { name: key === "acme" ? "Acme" : key[0]!.toUpperCase() + key.slice(1), urlKey: key },
    connectedAt: key === "acme" ? 1 : 2,
    ...over,
  };
}

/** GraphQL calls other than the viewer query a connect or a pasted token makes. */
const reads = (calls: ReturnType<typeof fakeLinear>["calls"]) => calls.filter((c) => c.body !== undefined && !c.body.query.startsWith("query { viewer"));

describe("connect", () => {
  it("sends the browser to Linear with PKCE and this server's callback", async () => {
    const { harness } = await setup();
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://linear.app/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("client-1");
    expect(u.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe("read,write,issues:create,comments:create");
    expect(u.searchParams.get("actor")).toBe("user");
  });

  it("refuses to start without a client ID", async () => {
    const { harness } = await setup({ settings: { clientId: "" } });
    await expect(harness.callRpc("connect", null)).rejects.toThrow(/client ID/u);
    expect(await harness.callRpc("status", null)).toMatchObject({ connected: false, configured: false });
  });

  it("takes the client ID from the server's environment when no setting is stored", async () => {
    const { harness } = await setup({ settings: { clientId: "" }, env: { LINEAR_CLIENT_ID: " fleet-client " } });
    expect(await harness.callRpc("status", null)).toMatchObject({ configured: true });
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    expect(new URL(url).searchParams.get("client_id")).toBe("fleet-client");
  });

  it("lets a stored client ID win over the environment", async () => {
    const { harness } = await setup({ settings: { clientId: "mine" }, env: { LINEAR_CLIENT_ID: "fleet-client" } });
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    expect(new URL(url).searchParams.get("client_id")).toBe("mine");
  });

  it("exchanges the code with the verifier, stores the tokens, and learns who connected", async () => {
    const { harness, callback, linear, now, stored } = await setup();
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    const sent = new URL(url).searchParams;

    const res = await callback({ code: "the-code", state: sent.get("state")! });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("jane");

    const exchange = linear.calls.find((c) => c.form !== undefined)!.form!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("the-code");
    expect(exchange.get("redirect_uri")).toBe(CALLBACK);
    expect(exchange.get("client_id")).toBe("client-1");
    expect(exchange.has("client_secret")).toBe(false);
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(sent.get("code_challenge"));

    expect(await harness.callRpc("status", null)).toEqual({
      connected: true,
      configured: true,
      user: { id: "u1", name: "jane", email: "jane@acme.test" },
      organization: { name: "Acme", urlKey: "acme" },
      linearUrl: "https://linear.app",
      accounts: [{ key: "acme", user: { id: "u1", name: "jane", email: "jane@acme.test" }, organization: { name: "Acme", urlKey: "acme" }, isDefault: true }],
    });
    expect(await stored()).toEqual([expect.objectContaining({ key: "acme", accessToken: "at-authorization_code", refreshToken: "rt-1", expiresAt: now() + DAY_MS })]);
    expect(harness.realtimeSignals.some((s) => s.channel === "connection-changed")).toBe(true);

    // The state is single-use.
    expect((await callback({ code: "again", state: sent.get("state")! })).status).toBe(400);
  });

  it("refuses a callback whose state it never issued", async () => {
    const { callback } = await setup();
    for (const state of ["", "short", "x".repeat(43)]) {
      expect((await callback({ code: "c", state })).status).toBe(400);
    }
  });

  it("forgets a state the developer left open too long", async () => {
    const { harness, callback, advance } = await setup();
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    advance(16 * 60 * 1000);
    expect((await callback({ code: "c", state: new URL(url).searchParams.get("state")! })).status).toBe(400);
  });

  it("reports a refusal on Linear's side without storing anything", async () => {
    const { harness, callback } = await setup();
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    const res = await callback({ error: "access_denied", state: new URL(url).searchParams.get("state")! });
    expect(res.status).toBe(200);
    expect(await harness.callRpc("status", null)).toMatchObject({ connected: false });
  });

  it("disconnect revokes the token and forgets the connection", async () => {
    const { harness, callback, linear, stored } = await setup();
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    await callback({ code: "c", state: new URL(url).searchParams.get("state")! });
    expect(await harness.callRpc("disconnect", null)).toEqual({ ok: true });
    expect(linear.calls.find((c) => c.url.endsWith("/oauth/revoke"))?.token).toBe("Bearer at-authorization_code");
    expect(await harness.callRpc("status", null)).toMatchObject({ connected: false, user: null, accounts: [] });
    expect(await stored()).toEqual([]);
  });
});

describe("tools", () => {
  it("are registered with the names the skill documents", async () => {
    const { harness } = await setup();
    const names = harness.registrations.agentTools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["linear_comment", "linear_create_issue", "linear_issue", "linear_query", "linear_search", "linear_update_issue", "linear_watch_issue"]);
  });

  it("say how to connect when there is no token", async () => {
    const { tool, text } = await setup();
    const result = await tool("linear_issue", { key: "ENG-123" });
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain("Connect Linear");
  });

  it("linear_issue reads an issue as the connected user", async () => {
    const { tool, text, linear } = await setup({
      token: "at-0",
      linear: { answer: (body) => (body.query.startsWith("query($id: String!) { issue(id: $id) { id identifier title") ? { data: { issue: issue() } } : { data: {} }) },
    });
    const out = text(await tool("linear_issue", { key: "eng-123" }));
    expect(out).toContain("# ENG-123: Fix login");
    expect(out).toContain("State: In Progress");
    const call = linear.calls.find((c) => c.body !== undefined)!;
    expect(call.token).toBe("at-0");
    expect(call.body!.variables).toEqual({ id: "ENG-123" });
  });

  it("linear_issue reports a missing issue as an error", async () => {
    const { tool } = await setup({ token: "at-0", linear: { answer: () => ({ data: { issue: null } }) } });
    expect(await tool("linear_issue", { key: "ENG-999" })).toMatchObject({ isError: true });
  });

  it("linear_search lists issues, filtering open ones by default", async () => {
    const { tool, text, linear } = await setup({
      token: "at-0",
      linear: { answer: (body) => ({ data: body.query.includes("searchIssues") ? { searchIssues: { nodes: [issue()] } } : { issues: { nodes: [issue(), issue({ identifier: "ENG-124", title: "Other" })] } } }) },
    });
    const listed = text(await tool("linear_search", { team: "eng", assignee: "me" }));
    expect(listed).toContain("(2):");
    expect(listed).toContain("- ENG-124 Other");
    expect(linear.calls.at(-1)!.body!.variables).toEqual({
      filter: { and: [{ team: { key: { eq: "ENG" } } }, { state: { type: { nin: ["completed", "canceled"] } } }, { assignee: { isMe: { eq: true } } }] },
      first: 20,
    });

    const searched = text(await tool("linear_search", { query: "login", openOnly: false, limit: 5 }));
    expect(searched).toContain('matching "login" (1)');
    expect(linear.calls.at(-1)!.body!.variables).toEqual({ term: "login", filter: undefined, first: 5 });
  });

  it("linear_comment signs the comment with the thread and reports the URL", async () => {
    const { tool, text, linear } = await setup({
      token: "at-0",
      linear: {
        answer: (body) =>
          body.query.startsWith("mutation($input: CommentCreateInput!)")
            ? { data: { commentCreate: { success: true, comment: { url: "https://linear.app/c/1" } } } }
            : { data: { issue: issue() } },
      },
    });
    expect(text(await tool("linear_comment", { key: "ENG-123", body: "PR opened: https://github.com/x/y/pull/1" }))).toBe("Commented on ENG-123: https://linear.app/c/1");
    const mutation = linear.calls.find((c) => c.body?.query.startsWith("mutation($input"))!;
    const input = mutation.body!.variables!.input as { issueId: string; body: string };
    expect(input.issueId).toBe("uuid-1");
    expect(input.body).toMatch(/^PR opened: https:\/\/github\.com\/x\/y\/pull\/1\n\n_— from bb thread .+_$/u);

    // A signature written by hand, even one naming another thread, gives way to the tool's own: one, and right.
    await tool("linear_comment", { key: "ENG-123", body: "Spec posted.\n\n_— from bb thread thr_wrong_\n\n*— from bb thread thr-1*" }, { threadId: "thr-1" });
    const again = linear.calls.filter((c) => c.body?.query.startsWith("mutation($input")).at(-1)!.body!.variables!.input as { body: string };
    expect(again.body).toBe("Spec posted.\n\n_— from bb thread thr-1_");
  });

  it("linear_update_issue applies state, assignee, labels and priority together", async () => {
    let lastInput: Record<string, unknown> = {};
    const ref = issue({
      labels: { nodes: [{ id: "l-bug", name: "Bug" }, { id: "l-ready", name: "build-ready" }] },
      team: { ...(issue().team as object), labels: { nodes: [{ id: "l-bug", name: "Bug" }, { id: "l-ready", name: "build-ready" }, { id: "l-agent", name: "agent" }] } },
    });
    const { tool, text, linear } = await setup({
      token: "at-0",
      linear: {
        answer: (body) => {
          if (body.query.startsWith("mutation($id: String!, $input: IssueUpdateInput!)")) {
            lastInput = body.variables!.input as Record<string, unknown>;
            const who = lastInput.assigneeId === "u1" ? { displayName: "jane" } : lastInput.assigneeId === "u-bob" ? { name: "Bob" } : null;
            const labels = Array.isArray(lastInput.labelIds) ? (lastInput.labelIds as string[]).map((id) => ({ name: id.replace(/^l-/u, "") })) : [{ name: "Bug" }, { name: "build-ready" }];
            return { data: { issueUpdate: { success: true, issue: { identifier: "ENG-123", state: { name: lastInput.stateId === "s-done" ? "Done" : "Todo" }, assignee: who, labels: { nodes: labels }, priority: lastInput.priority ?? 0 } } } };
          }
          if (body.query.startsWith("query($who: String!) { users")) {
            const who = String(body.variables!.who);
            const all = [{ id: "u-bob", name: "Bob", displayName: "Bob", email: "bob@acme.test", active: true }, { id: "u-bobby", name: "Bobby", displayName: "Bobby", email: "bobby@acme.test", active: true }];
            return { data: { users: { nodes: all.filter((u) => u.email === who || u.name.toLowerCase().includes(who.toLowerCase())) } } };
          }
          return { data: { issue: body.variables!.id === "ENG-999" ? null : ref, issueLabels: { nodes: [{ id: "l-ws", name: "Workspace" }] } } };
        },
      },
    });

    // Claiming a ticket: state and assignee in one mutation.
    expect(text(await tool("linear_update_issue", { key: "eng-123", state: "done", assignee: "me" }))).toBe("ENG-123: now Done; assigned to jane.");
    expect(linear.calls.at(-1)!.body!.variables).toEqual({ id: "uuid-1", input: { stateId: "s-done", assigneeId: "u1" } });

    // Handing it back: unassign, relabel, reprioritize. Labels are the issue's current set, minus removed, plus added.
    expect(text(await tool("linear_update_issue", { key: "ENG-123", assignee: "Nobody", removeLabels: ["BUILD-READY"], addLabels: ["agent", "workspace"], priority: "high" }))).toBe(
      "ENG-123: unassigned; labels bug, agent, ws; priority high.",
    );
    expect(lastInput).toEqual({ assigneeId: null, labelIds: ["l-bug", "l-agent", "l-ws"], priority: 2 });

    // A person by email.
    expect(text(await tool("linear_update_issue", { key: "ENG-123", assignee: "bob@acme.test" }))).toBe("ENG-123: assigned to Bob.");
    expect(lastInput).toEqual({ assigneeId: "u-bob" });

    // Misses list the choices and change nothing.
    const state = await tool("linear_update_issue", { key: "ENG-123", state: "Shipped" });
    expect(state).toMatchObject({ isError: true });
    expect(text(state)).toContain("Todo (unstarted), Done (completed)");
    const label = await tool("linear_update_issue", { key: "ENG-123", addLabels: ["perf"] });
    expect(label).toMatchObject({ isError: true });
    expect(text(label)).toContain("Bug, build-ready, agent, Workspace");
    const ambiguous = await tool("linear_update_issue", { key: "ENG-123", assignee: "bo" });
    expect(ambiguous).toMatchObject({ isError: true });
    expect(text(ambiguous)).toContain("Give an email");
    expect(await tool("linear_update_issue", { key: "ENG-999", state: "Done" })).toMatchObject({ isError: true });
    await expect(tool("linear_update_issue", { key: "ENG-123" })).rejects.toThrow(/at least one of/u);
  });

  it("linear_create_issue resolves the team, state, labels, assignee and parent, and signs the description", async () => {
    const team = {
      id: "t-eng",
      key: "ENG",
      name: "Engineering",
      states: { nodes: [{ id: "s-backlog", name: "Backlog", type: "backlog", position: 0 }, { id: "s-todo", name: "Todo", type: "unstarted", position: 1 }] },
      labels: { nodes: [{ id: "l-bug", name: "Bug" }] },
    };
    const { tool, text, linear } = await setup({
      token: "at-0",
      linear: {
        answer: (body) => {
          if (body.query.startsWith("mutation($input: IssueCreateInput!)")) return { data: { issueCreate: { success: true, issue: { identifier: "ENG-124", url: "https://linear.app/acme/issue/ENG-124" } } } };
          if (body.query.startsWith("query($key: String!) { teams")) return { data: { teams: { nodes: body.variables!.key === "ENG" ? [team] : [] }, issueLabels: { nodes: [{ id: "l-infra", name: "Infra" }] } } };
          if (body.query.startsWith("query($who: String!) { users")) {
            return { data: { users: { nodes: [{ id: "u-bob", name: "Bob", displayName: "bob", email: "bob@acme.test", active: true }, { id: "u-bobby", name: "Bobby", displayName: "bobby", email: "bobby@acme.test", active: true }] } } };
          }
          return { data: { issue: issue() } };
        },
      },
    });

    const out = text(await tool("linear_create_issue", { team: "eng", title: "Add retries", description: "Calls fail once in a while.", state: "todo", labels: ["bug", "infra"], assignee: "me", priority: "high", parent: "ENG-123" }));
    expect(out).toBe("Filed ENG-124: Add retries\nhttps://linear.app/acme/issue/ENG-124");
    const mutation = linear.calls.find((c) => c.body?.query.startsWith("mutation($input: IssueCreateInput!)"))!;
    const input = mutation.body!.variables!.input as Record<string, unknown>;
    expect(input).toMatchObject({ teamId: "t-eng", title: "Add retries", stateId: "s-todo", labelIds: ["l-bug", "l-infra"], assigneeId: "u1", priority: 2, parentId: "uuid-1" });
    expect(input.description).toMatch(/^Calls fail once in a while\.\n\n_— from bb thread .+_$/u);

    // Without a description the signature is the description.
    expect(text(await tool("linear_create_issue", { team: "ENG", title: "Bare" }))).toContain("Filed ENG-124");
    const bare = linear.calls.at(-1)!.body!.variables!.input as Record<string, unknown>;
    expect(bare.description).toMatch(/^_— from bb thread .+_$/u);
    expect(bare).not.toHaveProperty("stateId");

    // A person by email; by an ambiguous name the tool asks for an email.
    await tool("linear_create_issue", { team: "ENG", title: "For Bob", assignee: "bob@acme.test" });
    expect((linear.calls.at(-1)!.body!.variables!.input as Record<string, unknown>).assigneeId).toBe("u-bob");
    const ambiguous = await tool("linear_create_issue", { team: "ENG", title: "For Bob", assignee: "bo" });
    expect(ambiguous).toMatchObject({ isError: true });
    expect(text(ambiguous)).toContain("bob <bob@acme.test>, bobby <bobby@acme.test>");

    const noTeam = await tool("linear_create_issue", { team: "NOPE", title: "x" });
    expect(noTeam).toMatchObject({ isError: true });
    expect(text(noTeam)).toContain("No Linear team NOPE");
    const noState = await tool("linear_create_issue", { team: "ENG", title: "x", state: "Shipped" });
    expect(text(noState)).toContain("Backlog (backlog), Todo (unstarted)");
    const noLabel = await tool("linear_create_issue", { team: "ENG", title: "x", labels: ["urgent"] });
    expect(text(noLabel)).toContain('No label named "urgent" for team ENG. Its labels: Bug, Infra.');
    expect(linear.calls.filter((c) => c.body?.query.startsWith("mutation($input: IssueCreateInput!)"))).toHaveLength(3);
  });

  it("linear_query runs queries and refuses mutations", async () => {
    const { tool, text, linear } = await setup({ token: "at-0", linear: { answer: () => ({ data: { teams: { nodes: [{ key: "ENG" }] } } }) } });
    expect(JSON.parse(text(await tool("linear_query", { query: "{ teams { nodes { key } } }" })))).toEqual({ teams: { nodes: [{ key: "ENG" }] } });
    const refused = await tool("linear_query", { query: "mutation { issueDelete(id: \"x\") { success } }" });
    expect(refused).toMatchObject({ isError: true });
    expect(linear.calls.filter((c) => c.body?.query.includes("issueDelete"))).toHaveLength(0);
  });
});

describe("refresh", () => {
  it("refreshes a token about to expire before using it", async () => {
    const { tool, text, linear, now, stored, setExpiry } = await setup({
      token: "at-old", refreshToken: "rt-old",
      expiresAt: 0,
      linear: { answer: () => ({ data: { issue: issue() } }), tokens: () => ({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }) },
    });
    await setExpiry("acme", now() + REFRESH_MARGIN_MS - 1);
    expect(text(await tool("linear_issue", { key: "ENG-123" }))).toContain("ENG-123");
    const refreshed = linear.calls.find((c) => c.form !== undefined)!.form!;
    expect(refreshed.get("grant_type")).toBe("refresh_token");
    expect(refreshed.get("refresh_token")).toBe("rt-old");
    expect(linear.calls.find((c) => c.body !== undefined)!.token).toBe("at-new");
    expect(await stored()).toEqual([expect.objectContaining({ accessToken: "at-new", refreshToken: "rt-new", expiresAt: now() + 3600 * 1000 })]);
    // Next call uses the new token without refreshing again.
    await tool("linear_issue", { key: "ENG-123" });
    expect(linear.calls.filter((c) => c.form !== undefined)).toHaveLength(1);
    expect(linear.calls.at(-1)!.token).toBe("at-new");
  });

  it("refreshes once when Linear refuses the token, then retries", async () => {
    const { tool, text, linear } = await setup({
      token: "at-dead", refreshToken: "rt-1",
      linear: { answer: () => ({ data: { issue: issue() } }), valid: (t) => t !== "at-dead", tokens: () => ({ access_token: "at-live", expires_in: 3600 }) },
    });
    expect(text(await tool("linear_issue", { key: "ENG-123" }))).toContain("ENG-123");
    const graphqlTokens = linear.calls.filter((c) => c.body !== undefined).map((c) => c.token);
    expect(graphqlTokens).toEqual(["at-dead", "at-live"]);
    expect(linear.calls.filter((c) => c.form !== undefined)).toHaveLength(1);
  });

  it("tells the agent to reconnect when there is no refresh token to try", async () => {
    const { tool, text } = await setup({ token: "at-dead", linear: { valid: () => false } });
    const result = await tool("linear_issue", { key: "ENG-123" });
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain("Connect Linear again");
  });

  it("refreshes once for two concurrent calls", async () => {
    const { tool, linear, now, setExpiry } = await setup({
      token: "at-old", refreshToken: "rt-old",
      linear: { answer: () => ({ data: { issue: issue() } }), tokens: () => ({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }) },
    });
    await setExpiry("acme", now());
    await Promise.all([tool("linear_issue", { key: "ENG-1" }), tool("linear_issue", { key: "ENG-2" })]);
    expect(linear.calls.filter((c) => c.form !== undefined)).toHaveLength(1);
  });
});

describe("bb linear", () => {
  const connected = (answer?: Answer) => setup({ token: "at-0", linear: { answer } });

  it("is registered as `bb linear` and renders help without a connection", async () => {
    const { harness } = await setup();
    expect(harness.registrations.cli?.name).toBe("linear");
    const help = await harness.runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    for (const command of ["status", "issue", "search", "query", "watches"]) expect(help.stdout).toContain(command);
  });

  it("status says who is connected, and that nobody is", async () => {
    const { harness, callback } = await setup();
    expect((await harness.runCli(["status"])).stdout).toContain("not connected");
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    await callback({ code: "c", state: new URL(url).searchParams.get("state")! });
    expect((await harness.runCli(["status"])).stdout).toBe("Connected to Linear as jane in Acme.");
    expect(JSON.parse((await harness.runCli(["status", "--json"])).stdout)).toMatchObject({ connected: true, user: { name: "jane" } });
  });

  it("fails with a connect hint and a JSON envelope when there is no token", async () => {
    const { harness } = await setup();
    const result = await harness.runCli(["search", "--state", "Build Ready", "--json"]);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "not_connected" } });
    expect(result.stderr).toContain("Connect Linear");
  });

  it("search runs the same filter as the tool and prints issues as JSON, without a thread", async () => {
    const { harness, linear } = await connected(() => ({ data: { issues: { nodes: [issue(), issue({ identifier: "ENG-124", title: "Other" })] } } }));
    const result = await harness.runCli(["search", "--state", "Build Ready", "--team", "eng", "--limit", "5", "--json"]);
    expect(result.exitCode).toBe(0);
    const issues = JSON.parse(result.stdout) as Array<{ identifier: string; state: { name: string } }>;
    expect(issues.map((i) => i.identifier)).toEqual(["ENG-123", "ENG-124"]);
    expect(linear.calls.at(-1)!.token).toBe("at-0");
    expect(linear.calls.at(-1)!.body!.variables).toEqual({ filter: { and: [{ team: { key: { eq: "ENG" } } }, { state: { name: { eqIgnoreCase: "Build Ready" } } }] }, first: 5 });
    // No token anywhere in what a script sees.
    expect(result.stdout + result.stderr).not.toContain("at-0");
  });

  it("search leaves out closed issues by default and includes them with --all", async () => {
    const { harness, linear } = await connected(() => ({ data: { issues: { nodes: [] } } }));
    expect((await harness.runCli(["search", "--team", "ENG"])).stdout).toContain("no issues");
    expect(linear.calls.at(-1)!.body!.variables).toMatchObject({ filter: { and: [{ team: { key: { eq: "ENG" } } }, { state: { type: { nin: ["completed", "canceled"] } } }] } });
    await harness.runCli(["search", "--team", "ENG", "--all"]);
    expect(linear.calls.at(-1)!.body!.variables).toEqual({ filter: { team: { key: { eq: "ENG" } } }, first: 20 });
  });

  it("issue reads one issue, as text or JSON, and rejects a bad key", async () => {
    const { harness } = await connected((body) => (body.variables?.id === "ENG-123" ? { data: { issue: issue() } } : { data: { issue: null } }));
    expect((await harness.runCli(["issue", "eng-123"])).stdout).toContain("# ENG-123: Fix login");
    expect(JSON.parse((await harness.runCli(["issue", "ENG-123", "--json"])).stdout)).toMatchObject({ identifier: "ENG-123", state: { name: "In Progress" } });
    const missing = await harness.runCli(["issue", "ENG-999", "--json"]);
    expect(missing.exitCode).not.toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: { code: "issue_not_found" } });
    const bad = await harness.runCli(["issue", "nope", "--json"]);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, error: { code: "invalid_issue_key" } });
  });

  it("query prints the data for a read-only document and refuses mutations", async () => {
    const { harness, linear } = await connected((body) => ({ data: { teams: { nodes: [{ key: "ENG" }] } }, errors: body.variables?.first === 0 ? [{ message: "first must be positive" }] : undefined }));
    const ok = await harness.runCli(["query", "query($first: Int) { teams(first: $first) { nodes { key } } }", "--variables", '{"first": 1}']);
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ teams: { nodes: [{ key: "ENG" }] } });
    expect(linear.calls.at(-1)!.body!.variables).toEqual({ first: 1 });

    const withErrors = await harness.runCli(["query", "{ teams { nodes { key } } }", "--variables", '{"first": 0}']);
    expect(withErrors.exitCode).toBe(0);
    expect(withErrors.stderr).toContain("first must be positive");

    const mutation = await harness.runCli(["query", "mutation { issueDelete(id: \"x\") { success } }", "--json"]);
    expect(mutation.exitCode).not.toBe(0);
    expect(JSON.parse(mutation.stdout).error.message).toContain("Only queries");

    const badVars = await harness.runCli(["query", "{ viewer { id } }", "--variables", "[1]", "--json"]);
    expect(JSON.parse(badVars.stdout)).toMatchObject({ ok: false, error: { code: "invalid_variables" } });
  });
});

describe("watching an issue", () => {
  const comment = (body: string, createdAt: string, who = "bob") => ({ body, createdAt, url: `https://linear.app/c/${createdAt}`, user: { displayName: who } });

  // The issue as Linear currently has it; tests change it and ring the doorbell.
  function liveLinear() {
    const state = { issue: issue({ updatedAt: "2026-10-09T10:00:00Z", comments: { nodes: [comment("old", "2026-10-09T09:00:00Z")] } }) as Record<string, unknown> | null, fail: false };
    const answer: Answer = (body) => {
      if (state.fail) return { errors: [{ message: "Linear is down" }] };
      return body.query.startsWith("query($id: String!) { issue(id: $id) { id identifier title") ? { data: { issue: state.issue } } : { data: {} };
    };
    return { state, answer };
  }

  async function watching(over: { hooks?: ReturnType<typeof fakeHooks>; send?: (...args: never[]) => unknown } = {}) {
    const live = liveLinear();
    const hooks = over.hooks ?? fakeHooks();
    const send = vi.fn((over.send ?? (async () => ({ kind: "sent" }))) as (args: unknown) => unknown);
    const s = await setup({ token: "at-0", env: { BB_HOOKS_URL: HOOKS_URL }, linear: { answer: live.answer }, hooks, sdk: { threads: { send } } });
    const rows = () => s.bb.storage.database().prepare("SELECT thread_id, issue_id, issue_key, updated_at, last_comment_at FROM watches ORDER BY thread_id").all() as Array<Record<string, unknown>>;
    const sent = () => send.mock.calls.map((c) => c[0] as { threadId: string; mode: string; input: Array<{ type: string; text: string }> });
    return { ...s, live, hooks, send, rows, sent };
  }

  it("is refused, with a reason, on a server without bb-gate-hooks, and starts no service", async () => {
    const { tool, text, harness } = await setup({ token: "at-0", linear: { answer: () => ({ data: { issue: issue() } }) } });
    const result = await tool("linear_watch_issue", { key: "ENG-123" });
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain("BB_HOOKS_URL");
    expect(harness.registrations.services.map((s) => s.name)).toEqual([]);
  });

  it("records a watch for the calling thread, is a no-op the second time, and stops at the limit", async () => {
    const { tool, text, rows, harness, live } = await watching();
    expect(harness.registrations.services.map((s) => s.name)).toEqual(["watches"]);
    expect(text(await tool("linear_watch_issue", { key: "eng-123" }, { threadId: "thr-1", projectId: "prj-1" }))).toBe(
      "Watching ENG-123: Fix login. This thread will be messaged when its fields change or someone else comments; end the turn rather than polling.",
    );
    expect(rows()).toEqual([{ thread_id: "thr-1", issue_id: "uuid-1", issue_key: "ENG-123", updated_at: "2026-10-09T10:00:00Z", last_comment_at: "2026-10-09T09:00:00Z" }]);
    expect(text(await tool("linear_watch_issue", { key: "ENG-123" }, { threadId: "thr-1", projectId: "prj-1" }))).toContain("Already watching ENG-123");
    expect(rows()).toHaveLength(1);

    for (let i = 2; i <= WATCH_LIMIT; i++) {
      live.state.issue = issue({ id: `uuid-${i}`, identifier: `ENG-${i}` });
      expect(await tool("linear_watch_issue", { key: `ENG-${i}` }, { threadId: "thr-1", projectId: "prj-1" })).not.toMatchObject({ isError: true });
    }
    live.state.issue = issue({ id: "uuid-extra", identifier: "ENG-999" });
    const full = await tool("linear_watch_issue", { key: "ENG-999" }, { threadId: "thr-1", projectId: "prj-1" });
    expect(full).toMatchObject({ isError: true });
    expect(text(full)).toContain(`already watches ${WATCH_LIMIT} Linear issues`);
    // Another thread has its own budget.
    expect(await tool("linear_watch_issue", { key: "ENG-999" }, { threadId: "thr-2", projectId: "prj-1" })).not.toMatchObject({ isError: true });
    expect(rows()).toHaveLength(WATCH_LIMIT + 1);

    live.state.issue = null;
    expect(await tool("linear_watch_issue", { key: "ENG-404" }, { threadId: "thr-3", projectId: "prj-1" })).toMatchObject({ isError: true });
  });

  describe("the service", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

    it("leases the watches with the developer's token, checks on hello, and wakes the thread on a doorbell with what changed", async () => {
      const w = await watching();
      await w.tool("linear_watch_issue", { key: "ENG-123" }, { threadId: "thr-1", projectId: "prj-1" });
      await w.tool("linear_watch_issue", { key: "ENG-123" }, { threadId: "thr-2", projectId: "prj-1" });
      const service = w.harness.runService("watches");
      await tick();
      expect(w.hooks.streams).toHaveLength(1);
      w.hooks.last().send(w.hooks.hello("c_1"));
      await tick();
      expect(w.hooks.subscribes).toEqual([{ connection: "c_1", source: "linear", token: "at-0", watches: [{ kind: "issue", id: "uuid-1" }] }]);
      // The hello sweep read the issue (by uuid) and found nothing new.
      expect(w.linear.calls.at(-1)!.body!.variables).toEqual({ id: "uuid-1" });
      expect(w.send).not.toHaveBeenCalled();

      // Linear moves the issue; one thread comments on it; a human answers. Three doorbells, one check.
      w.live.state.issue = issue({
        updatedAt: "2026-10-09T12:00:00Z",
        state: { name: "Done", type: "completed" },
        assignee: { displayName: "jane" },
        comments: { nodes: [comment("old", "2026-10-09T09:00:00Z"), comment(`PR opened${signature("thr-1")}`, "2026-10-09T11:00:00Z", "jane"), comment("Merged, thanks", "2026-10-09T11:30:00Z")] },
      });
      const reads = w.linear.calls.length;
      w.hooks.last().send(w.hooks.doorbell("uuid-1"));
      w.hooks.last().send(w.hooks.doorbell("uuid-1"));
      w.hooks.last().send(w.hooks.doorbell("uuid-other"));
      await tick(2999);
      expect(w.send).not.toHaveBeenCalled();
      await tick(1);
      await tick();
      expect(w.linear.calls.length - reads).toBe(1);
      const sent = w.sent();
      expect(sent.map((m) => [m.threadId, m.mode, m.input[0]!.type])).toEqual([
        ["thr-1", "auto", "text"],
        ["thr-2", "auto", "text"],
      ]);
      const toOwner = sent[0]!.input[0]!.text;
      expect(toOwner).toContain("Linear issue ENG-123 changed: Fix login");
      expect(toOwner).toContain("- State: In Progress → Done");
      expect(toOwner).not.toContain("Assignee");
      expect(toOwner).toContain("**bob** — 2026-10-09T11:30:00Z");
      expect(toOwner).toContain("> Merged, thanks");
      // thr-1 wrote the signed comment, so it is not told about it; thr-2 is.
      expect(toOwner).not.toContain("PR opened");
      expect(sent[1]!.input[0]!.text).toContain("PR opened");
      expect(w.rows().map((r) => [r.updated_at, r.last_comment_at])).toEqual([
        ["2026-10-09T12:00:00Z", "2026-10-09T11:30:00Z"],
        ["2026-10-09T12:00:00Z", "2026-10-09T11:30:00Z"],
      ]);
      // Nothing is reported twice.
      w.hooks.last().send(w.hooks.doorbell("uuid-1"));
      await tick(3000);
      expect(w.send).toHaveBeenCalledTimes(2);
      expect(w.harness.logEntries.map((l) => l.message).join("\n")).not.toContain("at-0");

      service.controller.abort();
      await service.done;
      expect(w.hooks.last().closed).toBe(true);
    });

    it("keeps the cursor when the thread cannot be woken, and drops the watch when the thread is gone", async () => {
      let mode: "fail" | "gone" | "ok" = "fail";
      const w = await watching({
        send: async () => {
          if (mode === "ok") return { kind: "sent" };
          throw Object.assign(new Error(mode === "gone" ? "thread not found" : "busy"), mode === "gone" ? { code: "NOT_FOUND", status: 404 } : { status: 500 });
        },
      });
      await w.tool("linear_watch_issue", { key: "ENG-123" }, { threadId: "thr-1", projectId: "prj-1" });
      const service = w.harness.runService("watches");
      await tick();
      w.hooks.last().send(w.hooks.hello("c_1"));
      await tick();
      w.live.state.issue = issue({ updatedAt: "2026-10-09T12:00:00Z", state: { name: "Done", type: "completed" }, comments: { nodes: [] } });
      w.hooks.last().send(w.hooks.doorbell("uuid-1"));
      await tick(3000);
      expect(w.send).toHaveBeenCalledTimes(1);
      expect(w.rows()[0]!.updated_at).toBe("2026-10-09T10:00:00Z");
      // Still unreported, so the next doorbell says it again.
      mode = "ok";
      w.hooks.last().send(w.hooks.doorbell("uuid-1"));
      await tick(3000);
      expect(w.send).toHaveBeenCalledTimes(2);
      expect(w.rows()[0]!.updated_at).toBe("2026-10-09T12:00:00Z");

      mode = "gone";
      w.live.state.issue = issue({ updatedAt: "2026-10-09T13:00:00Z", title: "Renamed", comments: { nodes: [] } });
      w.hooks.last().send(w.hooks.doorbell("uuid-1"));
      await tick(3000);
      expect(w.rows()).toEqual([]);
      service.controller.abort();
      await service.done;
    });

    it("shows every watch with its counters, flags and thread title, lets one be stopped, and signals the settings section", async () => {
      const get = vi.fn(async ({ threadId }: { threadId: string }) => {
        if (threadId === "thr-1") return { id: threadId, title: "Fix login" };
        throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
      });
      const live = liveLinear();
      const hooks = fakeHooks();
      const send = vi.fn(async () => ({ kind: "sent" }));
      const s = await setup({ token: "at-0", env: { BB_HOOKS_URL: HOOKS_URL }, linear: { answer: live.answer }, hooks, sdk: { threads: { send, get } } });
      const signals = () => s.harness.realtimeSignals.filter((x) => x.channel === "watches-changed").length;

      // Before the service runs: no stream, nothing watched.
      type View = { watches: Array<Record<string, unknown>>; threads: unknown; hooks: Record<string, unknown> };
      let view = (await s.harness.callRpc("watches", null)) as View;
      expect(view).toMatchObject({ now: s.now(), limit: WATCH_LIMIT, hooks: { configured: true, state: "stopped" }, threads: [], watches: [] });
      expect(get).not.toHaveBeenCalled();

      await s.tool("linear_watch_issue", { key: "ENG-123" }, { threadId: "thr-1", projectId: "prj-1" });
      expect(signals()).toBe(1);
      const service = s.harness.runService("watches");
      await tick();
      hooks.last().send(hooks.hello("c_1"));
      await tick();
      // The hello sweep checked once without waking.
      view = (await s.harness.callRpc("watches", null)) as View;
      expect(view).toMatchObject({ hooks: { state: "connected", leased: true, sweeps: 1, lastSweepReason: "connected" } });
      expect(view.watches).toEqual([
        expect.objectContaining({
          threadId: "thr-1",
          threadTitle: "Fix login",
          target: { id: "uuid-1", key: "ENG-123", kind: "issue", title: "Fix login", url: "https://linear.app/acme/issue/ENG-123" },
          state: "In Progress",
          checks: 1,
          wakes: 0,
          lastCheckedAt: s.now(),
          lastWokeAt: 0,
          flags: [],
        }),
      ]);

      live.state.issue = issue({ updatedAt: "2026-10-09T12:00:00Z", state: { name: "Done", type: "completed" }, comments: { nodes: [] } });
      hooks.last().send(hooks.doorbell("uuid-1"));
      await tick(3000);
      expect(send).toHaveBeenCalledTimes(1);
      view = (await s.harness.callRpc("watches", null)) as View;
      expect(view.watches[0]).toMatchObject({ state: "Done", checks: 2, wakes: 1, wakesInWindow: 1, lastWokeAt: s.now() });
      expect(view.hooks).toMatchObject({ doorbells: 1, lastDoorbellAt: s.now() });
      expect(view.threads).toEqual([{ threadId: "thr-1", title: "Fix login", count: 1, wakes: 1, nearLimit: false }]);
      const afterWake = signals();
      expect(afterWake).toBeGreaterThan(1);

      // A thread bb cannot read shows its id. The CLI prints the same view.
      live.state.issue = issue({ id: "uuid-2", identifier: "ENG-2" });
      await s.tool("linear_watch_issue", { key: "ENG-2" }, { threadId: "thr-gone", projectId: "prj-1" });
      const cli = await s.harness.runCli(["watches"]);
      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).toContain("Doorbells: connected and leased");
      expect(cli.stdout).toContain("2 watches across 2 threads");
      expect(cli.stdout).toMatch(/ENG-123 +Fix login +/u);
      expect(cli.stdout).toMatch(/ENG-2 +thr-gone +/u);
      expect(JSON.parse((await s.harness.runCli(["watches", "--json"])).stdout)).toMatchObject({ watches: [{ target: { key: "ENG-123" } }, { target: { key: "ENG-2" }, threadTitle: null }] });

      // Stop one from settings: gone from the store, the thread is not told.
      expect(await s.harness.callRpc("unwatch", { threadId: "thr-1", targetId: "uuid-1" })).toEqual({ removed: true });
      expect(await s.harness.callRpc("unwatch", { threadId: "thr-1", targetId: "uuid-1" })).toEqual({ removed: false });
      expect(s.bb.storage.database().prepare("SELECT issue_key FROM watches").all()).toEqual([{ issue_key: "ENG-2" }]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(signals()).toBe(afterWake + 2);

      service.controller.abort();
      await service.done;
      expect(((await s.harness.callRpc("watches", null)) as { hooks: { state: string } }).hooks.state).toBe("stopped");
    });

    it("forgets a thread's watches when it is archived or deleted", async () => {
      const w = await watching();
      await w.tool("linear_watch_issue", { key: "ENG-123" }, { threadId: "thr-1", projectId: "prj-1" });
      await w.tool("linear_watch_issue", { key: "ENG-123" }, { threadId: "thr-2", projectId: "prj-1" });
      await w.harness.emitThreadEvent("thread.archived", { thread: { id: "thr-1" } as never });
      expect(w.rows().map((r) => r.thread_id)).toEqual(["thr-2"]);
      await w.harness.emitThreadEvent("thread.deleted", { thread: { id: "thr-2" } as never });
      expect(w.rows()).toEqual([]);
    });

    it("drops a refused watch only when the developer cannot read the issue either, and tells the thread", async () => {
      const w = await watching();
      await w.tool("linear_watch_issue", { key: "ENG-123" }, { threadId: "thr-1", projectId: "prj-1" });
      w.hooks.state.answer = (body) => Response.json({ leases: [], rejected: body.watches.map((x) => ({ ...x, reason: "forbidden" })) });
      const service = w.harness.runService("watches");
      await tick();
      w.hooks.last().send(w.hooks.hello("c_1"));
      await tick();
      // Readable here: the service is wrong or stale; the watch stays.
      expect(w.rows()).toHaveLength(1);
      expect(w.send).not.toHaveBeenCalled();
      expect(w.harness.logEntries.some((l) => l.message.includes("keeping the watch"))).toBe(true);

      // Linear unreachable from here: neither an `unverifiable` nor a `forbidden`
      // answer can be confirmed, so the watch stays for the next renewal.
      w.live.state.fail = true;
      w.hooks.state.answer = (body) => Response.json({ leases: [], rejected: body.watches.map((x) => ({ ...x, reason: "unverifiable" })) });
      await tick(30 * 60_000);
      expect(w.hooks.subscribes).toHaveLength(2);
      expect(w.rows()).toHaveLength(1);
      w.hooks.state.answer = (body) => Response.json({ leases: [], rejected: body.watches.map((x) => ({ ...x, reason: "forbidden" })) });
      await tick(30 * 60_000);
      expect(w.hooks.subscribes).toHaveLength(3);
      expect(w.rows()).toHaveLength(1);
      expect(w.harness.logEntries.some((l) => l.message.includes("could not confirm a refused lease"))).toBe(true);
      expect(w.send).not.toHaveBeenCalled();

      // Gone for the developer too: the watch is dropped and the thread told, once.
      w.live.state.fail = false;
      w.live.state.issue = null;
      await tick(30 * 60_000);
      expect(w.rows()).toEqual([]);
      expect(w.sent().map((m) => m.input[0]!.text)).toEqual(["Linear issue ENG-123 is no longer visible to the connected user (deleted, moved, or access removed), so this thread has stopped watching it."]);
      service.controller.abort();
      await service.done;
    });

    it("stops the stream on disconnect and opens it again on connect", async () => {
      const w = await watching();
      const service = w.harness.runService("watches");
      await tick();
      expect(w.hooks.streams).toHaveLength(1);
      await w.harness.callRpc("disconnect", null);
      await tick(5000);
      expect(w.hooks.last().closed).toBe(true);
      expect(w.hooks.streams).toHaveLength(1);
      // A token arriving by any route reconnects: here it is pasted into settings.
      await w.harness.setSettings({ accessToken: "at-1" });
      await tick(1000);
      expect(w.hooks.streams).toHaveLength(2);
      expect(w.hooks.last().closed).toBe(false);
      service.controller.abort();
      await service.done;
    });
  });
});

describe("editing a description", () => {
  it("replaces the description, signed with the thread, alongside other changes", async () => {
    const { tool, text, linear } = await setup({
      token: "at-0",
      linear: {
        answer: (body) =>
          body.query.startsWith("mutation($id: String!, $input: IssueUpdateInput!)")
            ? { data: { issueUpdate: { success: true, issue: { identifier: "ENG-123", state: { name: "Done" }, assignee: null, labels: { nodes: [] }, priority: 2 } } } }
            : { data: { issue: issue(), issueLabels: { nodes: [] } } },
      },
    });
    expect(text(await tool("linear_update_issue", { key: "ENG-123", state: "done", priority: "high", description: "Scope: login only." }, { threadId: "thr-1" }))).toBe(
      "ENG-123: now Done; priority high; description replaced.",
    );
    const input = linear.calls.find((c) => c.body?.query.startsWith("mutation"))!.body!.variables!.input as Record<string, unknown>;
    expect(input).toMatchObject({ stateId: "s-done", priority: 2 });
    expect(input.description).toMatch(/^Scope: login only\.\n\n_— from bb thread thr-1_$/u);
    expect(text(await tool("linear_update_issue", { key: "ENG-123", description: "Only this." }, { threadId: "thr-1" }))).toBe("ENG-123: description replaced.");
    // A description read back and rewritten keeps one signature, not one per edit.
    await tool("linear_update_issue", { key: "ENG-123", description: "Only this.\n\n_— from bb thread thr-0_" }, { threadId: "thr-1" });
    expect((linear.calls.filter((c) => c.body?.query.startsWith("mutation")).at(-1)!.body!.variables!.input as Record<string, unknown>).description).toBe("Only this.\n\n_— from bb thread thr-1_");
  });
});

const snapshotIssue = (over: Record<string, unknown> = {}) => ({
  ...issue(),
  priority: 2,
  priorityLabel: "High",
  estimate: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  team: { id: "t-eng", key: "ENG" },
  creator: { name: "Bob" },
  labels: { nodes: [{ name: "bb-managed" }] },
  parent: null,
  children: { nodes: [] },
  comments: { nodes: [{ id: "c-1", body: `On it${signature("thr-9")}`, createdAt: "2026-10-01T01:00:00Z", url: null, user: { displayName: "jane" } }] },
  attachments: { nodes: [{ url: "https://github.com/acme/web/pull/7", sourceType: "github" }] },
  ...over,
});

describe("the source contract", () => {
  const STEWARDS = { kind: "plugin", pluginId: "stewards" } as const;

  it("sourceSnapshot reads an issue by key or id as the connected user, and is null for one that is not there", async () => {
    const { harness, linear } = await setup({
      token: "at-0",
      linear: {
        answer: (body) =>
          body.variables?.id === "ENG-404" ? { data: null, errors: [{ message: "Entity not found: Issue" }] } : body.query.includes("attachments") ? { data: { issue: snapshotIssue() } } : { data: {} },
      },
    });
    const { snapshot } = (await harness.callRpc("sourceSnapshot", { id: "ENG-123" })) as { snapshot: Record<string, unknown> };
    expect(snapshot).toMatchObject({
      source: "linear",
      id: "uuid-1",
      key: "ENG-123",
      state: "In Progress",
      stateType: "started",
      unit: "ENG",
      author: "Bob",
      assignees: ["jane"],
      priority: "High",
      linkedPulls: [{ url: "https://github.com/acme/web/pull/7", key: "acme/web#7" }],
      viewer: "jane",
    });
    expect(snapshot.comments).toEqual([{ id: "c-1", author: "jane", did: "commented", body: `On it${signature("thr-9")}`, createdAt: "2026-10-01T01:00:00Z", url: null, signedBy: "thr-9" }]);
    expect(linear.calls.find((c) => c.body?.query.includes("attachments"))!.token).toBe("at-0");
    expect(await harness.callRpc("sourceSnapshot", { id: "ENG-404" })).toEqual({ snapshot: null });
  });

  it("sourceValidate checks each team's label and states, lists the viewer's teams, and answers when not connected", async () => {
    const disconnected = await setup();
    expect(await disconnected.harness.callRpc("sourceValidate", { units: ["ENG"], label: "bb-managed", states: [] })).toEqual({
      viewer: null,
      units: [],
      mine: [],
      error: expect.stringContaining("Linear is not connected"),
    });

    const team = {
      id: "t-eng",
      key: "ENG",
      name: "Engineering",
      states: { nodes: [{ id: "s-todo", name: "Todo", type: "unstarted", position: 0 }, { id: "s-review", name: "In Review", type: "started", position: 1 }] },
      labels: { nodes: [{ id: "l-bug", name: "Bug" }] },
    };
    const { harness } = await setup({
      token: "at-0",
      linear: {
        answer: (body) => {
          if (body.query.startsWith("query MyTeams")) return { data: { viewer: { teams: { nodes: [{ id: "t-eng", key: "ENG", name: "Engineering" }] } } } };
          if (body.query.startsWith("query($key: String!) { teams")) {
            return { data: { teams: { nodes: body.variables!.key === "ENG" ? [team] : [] }, issueLabels: { nodes: [{ id: "l-bb", name: "BB-Managed" }] } } };
          }
          return { data: {} };
        },
      },
    });
    expect(await harness.callRpc("sourceValidate", { units: ["eng", "NOPE"], label: "bb-managed", states: ["todo", "In Review", "Approved"] })).toEqual({
      viewer: "jane",
      units: [
        { unit: "eng", found: true, labelFound: true, missingStates: ["Approved"] },
        { unit: "NOPE", found: false, labelFound: false, missingStates: [] },
      ],
      mine: [{ unit: "ENG", name: "Engineering" }],
      error: null,
    });
  });

  it("sourceAdoptable lists labelled open issues per team, oldest first, with each team's failure on its own", async () => {
    const node = (id: string, team: string, createdAt: string) => ({ id, identifier: `${team}-${id}`, createdAt, state: { name: "Todo" }, team: { key: team }, creator: { name: "Bob" }, labels: { nodes: [{ name: "bb-managed" }] } });
    const { harness, linear } = await setup({
      token: "at-0",
      linear: {
        answer: (body) => {
          if (body.query.startsWith("query { teams")) return { data: { teams: { nodes: [{ id: "t-eng", key: "ENG", name: "Engineering" }, { id: "t-ops", key: "OPS", name: "Ops" }] } } };
          const filter = body.variables!.filter as { team: { key: { eq: string } } };
          if (filter.team.key.eq === "OPS") return { errors: [{ message: "rate limited" }] };
          return body.variables!.after === null
            ? { data: { issues: { nodes: [node("3", "ENG", "2026-10-03T00:00:00Z")], pageInfo: { hasNextPage: true, endCursor: "p2" } } } }
            : { data: { issues: { nodes: [node("1", "ENG", "2026-10-01T00:00:00Z"), node("2", "ENG", "2026-10-02T00:00:00Z")], pageInfo: { hasNextPage: false, endCursor: null } } } };
        },
      },
    });
    const result = (await harness.callRpc("sourceAdoptable", { units: ["eng", "OPS", "GONE"], label: "bb-managed", limit: 2 })) as { viewer: string; entities: Array<{ key: string }>; errors: string[] };
    expect(result.viewer).toBe("jane");
    expect(result.entities.map((e) => e.key)).toEqual(["ENG-1", "ENG-2"]);
    expect(result.errors).toEqual(["OPS: Linear: rate limited", "GONE: no such Linear team, or it is not visible to the connected user"]);
    expect(linear.calls.find((c) => c.body?.query.startsWith("query($filter: IssueFilter"))!.body!.variables).toEqual({
      filter: { team: { key: { eq: "ENG" } }, labels: { some: { name: { eqIgnoreCase: "bb-managed" } } }, state: { type: { nin: ["completed", "canceled"] } } },
      first: 250,
      after: null,
    });
  });

  it("sourceSetInterest is for stewards only", async () => {
    const { harness, bb } = await setup({ token: "at-0" });
    await expect(harness.callRpc("sourceSetInterest", { units: [], entities: [] })).rejects.toThrow(/stewards plugin only/u);
    await expect(harness.callRpc("sourceSetInterest", { units: [], entities: [] }, { experimental_caller: { kind: "plugin", pluginId: "workstreams" } })).rejects.toThrow(/stewards plugin only/u);
    expect(await bb.storage.kv.get("stewards/interest")).toBeUndefined();
  });

  describe("leases and rings", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
    const UUID_1 = "11111111-1111-4111-8111-111111111111";
    const UUID_2 = "22222222-2222-4222-8222-222222222222";
    const UUID_3 = "33333333-3333-4333-8333-333333333333";
    const answer: Answer = (body) => {
      if (body.query.startsWith("query { teams")) return { data: { teams: { nodes: [{ id: "t-eng", key: "ENG", name: "Engineering" }, { id: "t-ops", key: "OPS", name: "Ops" }] } } };
      if (body.query.startsWith("query($id: String!) { issue(id: $id) { id identifier }")) {
        return body.variables!.id === "ENG-5" ? { data: { issue: { id: UUID_2, identifier: "ENG-5" } } } : { data: null, errors: [{ message: "Entity not found: Issue" }] };
      }
      if (body.query.startsWith("query($ids: [ID!]!) { issues(")) {
        const known: Record<string, string> = { [UUID_1]: "ENG-1", [UUID_3]: "ENG-3" };
        return { data: { issues: { nodes: (body.variables!.ids as string[]).filter((id) => known[id] !== undefined).map((id) => ({ id, identifier: known[id] })) } } };
      }
      return { data: { issue: null } };
    };
    type InterestView = { units: string[]; entities: Array<{ key: string }>; unleased: Array<{ key: string; reason: string }> };
    const interestOf = async (s: { harness: { callRpc(method: string, input: unknown): Promise<unknown> } }) => ((await s.harness.callRpc("watches", null)) as { interest: InterestView }).interest;

    it("stores the interest, leases its issues and teams, and rings stewards for their doorbells", async () => {
      const hooks = fakeHooks();
      const stewards = fakeStewards();
      const s = await setup({ token: "at-0", env: { BB_HOOKS_URL: HOOKS_URL }, linear: { answer }, hooks, sdk: { plugins: { callRpc: stewards.callRpc } } });
      expect(await s.harness.callRpc("sourceSetInterest", { units: ["eng", "nope"], entities: [UUID_1, "eng-5", "ENG-404"] }, { experimental_caller: STEWARDS })).toEqual({ ok: true });
      // Keys resolved; one the user cannot see is left out.
      expect(await s.bb.storage.kv.get("stewards/interest")).toEqual({ units: ["ENG", "NOPE"], entities: [UUID_1, UUID_2] });
      expect(s.harness.logEntries.some((l) => l.message.includes("ENG-404, which the connected user cannot see"))).toBe(true);
      // The usage view names them by key, and says what is not leased and why.
      expect(await interestOf(s)).toMatchObject({
        units: ["ENG", "NOPE"],
        entities: [{ key: "ENG-1" }, { key: "ENG-5" }],
        unleased: [
          { key: "NOPE", reason: "no such team, or not visible to the connected Linear user" },
          { key: "ENG-404", reason: "not visible to the connected Linear user" },
        ],
      });

      const service = s.harness.runService("watches");
      await tick();
      hooks.last().send(hooks.hello("c_1"));
      await tick();
      expect(hooks.subscribes.at(-1)!.watches).toEqual([
        { kind: "issue", id: UUID_1 },
        { kind: "issue", id: UUID_2 },
        { kind: "team", id: "t-eng" },
      ]);

      // Its own issue, twice: one ring after the debounce. Another issue in its team: a ring. Elsewhere: none.
      hooks.last().send(hooks.doorbell(UUID_1, "t-other"));
      hooks.last().send(hooks.doorbell(UUID_1, "t-other"));
      hooks.last().send(hooks.doorbell("uuid-in-eng", "t-eng"));
      hooks.last().send(hooks.doorbell("uuid-elsewhere", "t-ops"));
      hooks.last().send(hooks.doorbell("uuid-no-unit", ""));
      await tick(2999);
      expect(stewards.to("stewardsRing")).toEqual([]);
      await tick(1);
      expect(stewards.to("stewardsRing")).toEqual([
        { source: "linear", id: UUID_1 },
        { source: "linear", id: "uuid-in-eng" },
      ]);

      // A change while connected is leased right away, only what is new.
      await s.harness.callRpc("sourceSetInterest", { units: ["ENG", "OPS"], entities: [UUID_1, UUID_3] }, { experimental_caller: STEWARDS });
      expect(hooks.subscribes.at(-1)!.watches).toEqual([
        { kind: "issue", id: UUID_3 },
        { kind: "team", id: "t-ops" },
      ]);
      hooks.last().send(hooks.doorbell("uuid-elsewhere", "t-ops"));
      await tick(3000);
      expect(stewards.to("stewardsRing").at(-1)).toEqual({ source: "linear", id: "uuid-elsewhere" });

      service.controller.abort();
      await service.done;
    });

    it("leases a stored interest after a restart, and logs a refused team lease", async () => {
      const hooks = fakeHooks();
      hooks.state.answer = (body) => Response.json({ leases: body.watches.filter((w) => w.kind === "issue"), rejected: body.watches.filter((w) => w.kind === "team").map((w) => ({ ...w, reason: "forbidden" })) });
      const s = await setup({
        token: "at-0",
        env: { BB_HOOKS_URL: HOOKS_URL },
        linear: { answer },
        hooks,
        sdk: { plugins: { callRpc: fakeStewards().callRpc } },
        kv: { "stewards/interest": { units: ["ENG"], entities: [UUID_1, "ENG-5"] }, "stewards/teamIds": { ENG: "t-eng" } },
      });
      const service = s.harness.runService("watches");
      await tick();
      hooks.last().send(hooks.hello("c_1"));
      await tick();
      // The stored key is resolved once the stream is up; whichever lands first, everything ends up leased.
      const leased = hooks.subscribes.flatMap((b) => b.watches);
      expect(leased).toEqual(expect.arrayContaining([{ kind: "issue", id: UUID_1 }, { kind: "issue", id: UUID_2 }, { kind: "team", id: "t-eng" }]));
      expect(await s.bb.storage.kv.get("stewards/interest")).toEqual({ units: ["ENG"], entities: [UUID_1, UUID_2] });
      expect(s.harness.logEntries.some((l) => l.level === "warn" && l.message.includes("refused a lease on Linear team ENG (forbidden)"))).toBe(true);
      expect((await interestOf(s)).unleased).toEqual([{ key: "ENG", reason: "refused by bb-gate-hooks (forbidden)" }]);
      service.controller.abort();
      await service.done;
    });
  });
});

describe("several workspaces", () => {
  const teamsOf: Record<string, Array<{ id: string; key: string; name: string }>> = {
    "at-acme": [{ id: "t-eng", key: "ENG", name: "Engineering" }, { id: "t-web-a", key: "WEB", name: "Web" }],
    "at-globex": [{ id: "t-ops", key: "OPS", name: "Ops" }, { id: "t-web-g", key: "WEB", name: "Web" }],
  };
  // Each token sees its own workspace's teams, and an issue in it named by the key asked for.
  const answer: Answer = (body, token) => {
    if (body.query.startsWith("query { teams")) return { data: { teams: { nodes: teamsOf[token] ?? [] } } };
    if (body.query.startsWith("query($id: String!) { issue(id: $id) { id identifier title")) {
      const id = String(body.variables!.id);
      return { data: { issue: issue({ id: token === "at-globex" ? "uuid-g" : "uuid-1", identifier: id.startsWith("uuid") ? (token === "at-globex" ? "OPS-7" : "ENG-123") : id }) } };
    }
    if (body.query.includes("issues(") || body.query.includes("searchIssues(")) return { data: { issues: { nodes: [] }, searchIssues: { nodes: [] } } };
    return { data: { ok: token } };
  };
  const two = (over: Parameters<typeof setup>[0] = {}) =>
    setup({ accounts: [account("acme", "at-acme"), account("globex", "at-globex")], linear: { answer }, ...over });
  const lastRead = (calls: ReturnType<typeof fakeLinear>["calls"]) => reads(calls).filter((c) => !c.body!.query.startsWith("query { teams")).at(-1)!;

  it("moves a token from the single-workspace build into the workspaces without asking Linear again", async () => {
    const { harness, linear, stored, bb, now } = await setup({
      settings: { accessToken: "at-legacy", refreshToken: "rt-legacy" },
      kv: {
        connection: { tokenFingerprint: createHash("sha256").update("at-legacy").digest("hex"), user: { id: "u1", name: "jane", email: null }, organization: { name: "Acme", urlKey: "acme" } },
        expiresAt: 1_000_000_000_000 + DAY_MS,
      },
    });
    expect(await harness.callRpc("status", null)).toMatchObject({ connected: true, accounts: [{ key: "acme", isDefault: true }] });
    expect(linear.calls).toEqual([]);
    expect(await stored()).toEqual([expect.objectContaining({ key: "acme", accessToken: "at-legacy", refreshToken: "rt-legacy", expiresAt: now() + DAY_MS })]);
    expect(await bb.storage.kv.get("connection")).toBeUndefined();
    expect(await bb.storage.kv.get("expiresAt")).toBeUndefined();
  });

  it("asks whose a pasted token is, refreshing it first when Linear refuses it", async () => {
    const { tool, text, linear, stored } = await setup({
      settings: { accessToken: "at-dead", refreshToken: "rt-1" },
      linear: { answer: () => ({ data: { issue: issue() } }), valid: (t) => t !== "at-dead", tokens: () => ({ access_token: "at-live", expires_in: 3600 }) },
    });
    expect(text(await tool("linear_issue", { key: "ENG-123" }))).toContain("# ENG-123");
    expect(linear.calls.filter((c) => c.form !== undefined)).toHaveLength(1);
    expect(await stored()).toEqual([expect.objectContaining({ key: "acme", accessToken: "at-live", refreshToken: "rt-1" })]);
  });

  it("connects a second workspace beside the first, picks a default, and disconnects one", async () => {
    let n = 0;
    const tokens = ["at-acme", "at-globex"];
    const { harness, callback, linear, stored } = await setup({
      linear: {
        tokens: () => ({ access_token: tokens[n++], refresh_token: "rt", expires_in: 3600 }),
        organization: (token) => (token === "at-globex" ? { name: "Globex", urlKey: "globex" } : { name: "Acme", urlKey: "acme" }),
      },
    });
    for (let i = 0; i < 2; i++) {
      const { url } = (await harness.callRpc("connect", null)) as { url: string };
      const res = await callback({ code: `c${i}`, state: new URL(url).searchParams.get("state")! });
      expect(res.status).toBe(200);
      if (i === 1) expect(await res.text()).toContain("Also connected: Acme");
    }
    type Status = { organization: { urlKey: string }; accounts: Array<{ key: string; isDefault: boolean }> };
    let status = (await harness.callRpc("status", null)) as Status;
    expect(status.accounts.map((a) => [a.key, a.isDefault])).toEqual([["acme", true], ["globex", false]]);

    await harness.callRpc("setDefault", { account: "Globex" });
    status = (await harness.callRpc("status", null)) as Status;
    expect(status.organization.urlKey).toBe("globex");
    expect(status.accounts.map((a) => [a.key, a.isDefault])).toEqual([["acme", false], ["globex", true]]);
    await expect(harness.callRpc("setDefault", { account: "initech" })).rejects.toThrow(/No Linear workspace "initech"/u);

    await harness.callRpc("disconnect", { account: "globex" });
    expect(linear.calls.filter((c) => c.url.endsWith("/oauth/revoke")).map((c) => c.token)).toEqual(["Bearer at-globex"]);
    expect((await stored()).map((a) => a.key)).toEqual(["acme"]);
    status = (await harness.callRpc("status", null)) as Status;
    expect(status.accounts).toEqual([expect.objectContaining({ key: "acme", isDefault: true })]);
  });

  it("routes each call to the workspace that has the issue's team, and asks for the account when that is not enough", async () => {
    const { tool, text, linear } = await two();
    expect(text(await tool("linear_issue", { key: "ENG-1" }))).toContain("# ENG-1");
    expect(lastRead(linear.calls).token).toBe("at-acme");
    expect(text(await tool("linear_issue", { key: "ops-7" }))).toContain("# OPS-7");
    expect(lastRead(linear.calls).token).toBe("at-globex");
    // Each workspace's teams were asked once, and are remembered.
    await tool("linear_issue", { key: "OPS-8" });
    expect(linear.calls.filter((c) => c.body?.query.startsWith("query { teams")).map((c) => c.token).sort()).toEqual(["at-acme", "at-globex"]);

    // Search: by team, by account, else the default; and the heading says where.
    expect(text(await tool("linear_search", { team: "OPS" }))).toContain("in globex");
    expect(lastRead(linear.calls).token).toBe("at-globex");
    await tool("linear_search", { query: "login" });
    expect(lastRead(linear.calls).token).toBe("at-acme");
    await tool("linear_search", { query: "login", account: "GLOBEX" });
    expect(lastRead(linear.calls).token).toBe("at-globex");
    expect(text(await tool("linear_query", { query: "query { organization { name } }", account: "Globex" }))).toContain("at-globex");

    // Two workspaces with a WEB team: say which rather than guess.
    const ambiguous = await tool("linear_issue", { key: "WEB-1" });
    expect(ambiguous).toMatchObject({ isError: true });
    expect(text(ambiguous)).toContain("Team WEB exists in more than one connected Linear workspace: acme, globex. Pass account");
    await tool("linear_issue", { key: "WEB-1", account: "globex" });
    expect(lastRead(linear.calls).token).toBe("at-globex");
    const unknown = await tool("linear_issue", { key: "ENG-1", account: "initech" });
    expect(text(unknown)).toBe('No Linear workspace "initech" is connected. Connected: acme, globex.');
  });

  it("watches issues in two workspaces on one stream, each lease proven with its own workspace's token", async () => {
    vi.useFakeTimers();
    try {
      const hooks = fakeHooks();
      const send = vi.fn(async () => ({ kind: "sent" }));
      const s = await two({ env: { BB_HOOKS_URL: HOOKS_URL }, hooks, sdk: { threads: { send } } });
      await s.tool("linear_watch_issue", { key: "ENG-123" }, { threadId: "thr-1", projectId: "prj-1" });
      await s.tool("linear_watch_issue", { key: "OPS-7" }, { threadId: "thr-1", projectId: "prj-1" });
      const service = s.harness.runService("watches");
      await vi.advanceTimersByTimeAsync(0);
      hooks.last().send(hooks.hello("c_1"));
      await vi.advanceTimersByTimeAsync(0);
      expect(hooks.subscribes.map((b) => [b.token, b.watches]).sort()).toEqual([
        ["at-acme", [{ kind: "issue", id: "uuid-1" }]],
        ["at-globex", [{ kind: "issue", id: "uuid-g" }]],
      ]);
      // A doorbell for the second workspace's issue is read with its token.
      hooks.last().send(hooks.doorbell("uuid-g", "t-ops"));
      await vi.advanceTimersByTimeAsync(3000);
      expect(lastRead(s.linear.calls)).toMatchObject({ token: "at-globex", body: { variables: { id: "uuid-g" } } });
      // The usage view links each issue into its own workspace.
      const view = (await s.harness.callRpc("watches", null)) as { watches: Array<{ target: { key: string; url: string } }> };
      expect(view.watches.map((w) => w.target.url).sort()).toEqual(["https://linear.app/acme/issue/ENG-123", "https://linear.app/globex/issue/OPS-7"]);
      service.controller.abort();
      await service.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("finds a stewards issue by UUID in whichever workspace has it, and goes there first next time", async () => {
    const UUID = "44444444-4444-4444-8444-444444444444";
    const { harness, linear } = await two({
      linear: {
        answer: (body, token) =>
          body.query.includes("attachments") ? (token === "at-globex" ? { data: { issue: snapshotIssue({ id: UUID }) } } : { data: null, errors: [{ message: "Entity not found: Issue" }] }) : answer(body, token),
      },
    });
    const snapshots = () => linear.calls.filter((c) => c.body?.query.includes("attachments")).map((c) => c.token);
    expect(((await harness.callRpc("sourceSnapshot", { id: UUID })) as { snapshot: { id: string } }).snapshot.id).toBe(UUID);
    expect(snapshots()).toEqual(["at-acme", "at-globex"]);
    await harness.callRpc("sourceSnapshot", { id: UUID });
    expect(snapshots()).toEqual(["at-acme", "at-globex", "at-globex"]);
  });

  it("bb linear status lists the workspaces, and --account picks one", async () => {
    const { harness, linear } = await two();
    const status = await harness.runCli(["status"]);
    expect(status.stdout).toBe("Connected to 2 Linear workspaces:\n  acme (default): jane in Acme\n  globex: jane in Globex");
    const out = await harness.runCli(["issue", "WEB-2", "--account", "globex", "--json"]);
    expect(out.exitCode).toBe(0);
    expect(lastRead(linear.calls).token).toBe("at-globex");
    const ambiguous = await harness.runCli(["issue", "WEB-2"]);
    expect(ambiguous.exitCode).not.toBe(0);
  });
});
