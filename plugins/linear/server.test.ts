import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createLinearPlugin, REFRESH_MARGIN_MS } from "./server.js";

const APP_URL = "https://bb.example";
const CALLBACK = "https://bb.example/api/v1/plugins/linear/http/connect/callback";
const DAY_MS = 86_400_000;

type Answer = (body: { query: string; variables?: Record<string, unknown> }, token: string) => unknown;

// A Linear whose token endpoint and GraphQL endpoint a test scripts.
function fakeLinear(options: { answer?: Answer; tokens?: () => Record<string, unknown>; valid?: (token: string) => boolean } = {}) {
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
        return Response.json({ data: { viewer: { id: "u1", name: "Jane", displayName: "jane", email: "jane@acme.test" }, organization: { name: "Acme", urlKey: "acme" } } });
      }
      return Response.json(options.answer?.(body, token) ?? { data: {} });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
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

async function setup(options: { settings?: Record<string, string>; env?: Record<string, string>; linear?: Parameters<typeof fakeLinear>[0]; expiresAt?: number } = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "linear",
    appUrl: APP_URL,
    settings: { clientId: "client-1", ...options.settings },
  });
  const linear = fakeLinear(options.linear);
  let now = 1_000_000_000_000;
  await createLinearPlugin({ fetch: linear.fetchImpl, now: () => now, env: options.env ?? {} })(bb);
  if (options.expiresAt !== undefined) await bb.storage.kv.set("expiresAt", options.expiresAt);
  const route = harness.registrations.httpRoutes.find((r) => r.path === "/connect/callback")!;
  const app = new Hono().get("/cb", route.handler);
  const callback = (query: Record<string, string>) => app.request(`/cb?${new URLSearchParams(query)}`);
  const tool = (name: string, args: Record<string, unknown>) => harness.behavior.callAgentTool(name, args) as Promise<string | { content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  const text = (result: Awaited<ReturnType<typeof tool>>) => (typeof result === "string" ? result : result.content.map((c) => c.text ?? "").join(""));
  return { bb, harness, linear, callback, route, tool, text, advance: (ms: number) => (now += ms), now: () => now };
}

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
    const { bb, harness, callback, linear, now } = await setup();
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
    });
    expect(await bb.storage.kv.get("expiresAt")).toBe(now() + DAY_MS);
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
    const { bb, harness, callback, linear } = await setup();
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    await callback({ code: "c", state: new URL(url).searchParams.get("state")! });
    expect(await harness.callRpc("disconnect", null)).toEqual({ ok: true });
    expect(linear.calls.find((c) => c.url.endsWith("/oauth/revoke"))?.token).toBe("Bearer at-authorization_code");
    expect(await harness.callRpc("status", null)).toMatchObject({ connected: false, user: null });
    expect(await bb.storage.kv.get("expiresAt")).toBeUndefined();
  });
});

describe("tools", () => {
  it("are registered with the names the skill documents", async () => {
    const { harness } = await setup();
    const names = harness.registrations.agentTools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["linear_comment", "linear_create_issue", "linear_issue", "linear_query", "linear_search", "linear_update_issue"]);
  });

  it("say how to connect when there is no token", async () => {
    const { tool, text } = await setup();
    const result = await tool("linear_issue", { key: "ENG-123" });
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain("Connect Linear");
  });

  it("linear_issue reads an issue as the connected user", async () => {
    const { tool, text, linear } = await setup({
      settings: { accessToken: "at-0" },
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
    const { tool } = await setup({ settings: { accessToken: "at-0" }, linear: { answer: () => ({ data: { issue: null } }) } });
    expect(await tool("linear_issue", { key: "ENG-999" })).toMatchObject({ isError: true });
  });

  it("linear_search lists issues, filtering open ones by default", async () => {
    const { tool, text, linear } = await setup({
      settings: { accessToken: "at-0" },
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
      settings: { accessToken: "at-0" },
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
  });

  it("linear_update_issue applies state, assignee, labels and priority together", async () => {
    let lastInput: Record<string, unknown> = {};
    const ref = issue({
      labels: { nodes: [{ id: "l-bug", name: "Bug" }, { id: "l-ready", name: "build-ready" }] },
      team: { ...(issue().team as object), labels: { nodes: [{ id: "l-bug", name: "Bug" }, { id: "l-ready", name: "build-ready" }, { id: "l-agent", name: "agent" }] } },
    });
    const { tool, text, linear } = await setup({
      settings: { accessToken: "at-0" },
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
      settings: { accessToken: "at-0" },
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
    const { tool, text, linear } = await setup({ settings: { accessToken: "at-0" }, linear: { answer: () => ({ data: { teams: { nodes: [{ key: "ENG" }] } } }) } });
    expect(JSON.parse(text(await tool("linear_query", { query: "{ teams { nodes { key } } }" })))).toEqual({ teams: { nodes: [{ key: "ENG" }] } });
    const refused = await tool("linear_query", { query: "mutation { issueDelete(id: \"x\") { success } }" });
    expect(refused).toMatchObject({ isError: true });
    expect(linear.calls.filter((c) => c.body?.query.includes("issueDelete"))).toHaveLength(0);
  });
});

describe("refresh", () => {
  it("refreshes a token about to expire before using it", async () => {
    const { bb, tool, text, linear, now } = await setup({
      settings: { accessToken: "at-old", refreshToken: "rt-old" },
      expiresAt: 0,
      linear: { answer: () => ({ data: { issue: issue() } }), tokens: () => ({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }) },
    });
    await bb.storage.kv.set("expiresAt", now() + REFRESH_MARGIN_MS - 1);
    expect(text(await tool("linear_issue", { key: "ENG-123" }))).toContain("ENG-123");
    const refreshed = linear.calls.find((c) => c.form !== undefined)!.form!;
    expect(refreshed.get("grant_type")).toBe("refresh_token");
    expect(refreshed.get("refresh_token")).toBe("rt-old");
    expect(linear.calls.find((c) => c.body !== undefined)!.token).toBe("at-new");
    expect(await bb.storage.kv.get("expiresAt")).toBe(now() + 3600 * 1000);
    // Next call uses the new token without refreshing again.
    await tool("linear_issue", { key: "ENG-123" });
    expect(linear.calls.filter((c) => c.form !== undefined)).toHaveLength(1);
    expect(linear.calls.at(-1)!.token).toBe("at-new");
  });

  it("refreshes once when Linear refuses the token, then retries", async () => {
    const { tool, text, linear } = await setup({
      settings: { accessToken: "at-dead", refreshToken: "rt-1" },
      linear: { answer: () => ({ data: { issue: issue() } }), valid: (t) => t !== "at-dead", tokens: () => ({ access_token: "at-live", expires_in: 3600 }) },
    });
    expect(text(await tool("linear_issue", { key: "ENG-123" }))).toContain("ENG-123");
    const graphqlTokens = linear.calls.filter((c) => c.body !== undefined).map((c) => c.token);
    expect(graphqlTokens).toEqual(["at-dead", "at-live"]);
    expect(linear.calls.filter((c) => c.form !== undefined)).toHaveLength(1);
  });

  it("tells the agent to reconnect when there is no refresh token to try", async () => {
    const { tool, text } = await setup({ settings: { accessToken: "at-dead" }, linear: { valid: () => false } });
    const result = await tool("linear_issue", { key: "ENG-123" });
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain("Connect Linear again");
  });

  it("refreshes once for two concurrent calls", async () => {
    const { bb, tool, linear, now } = await setup({
      settings: { accessToken: "at-old", refreshToken: "rt-old" },
      linear: { answer: () => ({ data: { issue: issue() } }), tokens: () => ({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }) },
    });
    await bb.storage.kv.set("expiresAt", now());
    await Promise.all([tool("linear_issue", { key: "ENG-1" }), tool("linear_issue", { key: "ENG-2" })]);
    expect(linear.calls.filter((c) => c.form !== undefined)).toHaveLength(1);
  });
});
