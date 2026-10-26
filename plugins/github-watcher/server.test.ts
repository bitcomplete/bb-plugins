import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotSignedInError } from "./gh.js";
import { createGitHubPlugin, TOKEN_CACHE_MS } from "./server.js";
import { signature, WATCH_LIMIT } from "./watch.js";

const API_URL = "https://api.github.test";
const HOOKS_URL = "http://bb-gate-hooks.test:8081";

// A pull request as GitHub currently has it; tests change it and ring the doorbell.
const pullNode = (over: Record<string, unknown> = {}) => ({
  __typename: "PullRequest",
  number: 12,
  title: "Add widgets",
  url: "https://github.com/Acme/Widgets/pull/12",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-09T10:00:00Z",
  author: { login: "jane" },
  assignees: { nodes: [] },
  labels: { nodes: [] },
  milestone: null,
  comments: { nodes: [{ author: { login: "bob" }, body: "old", createdAt: "2026-10-09T09:00:00Z", url: "https://github.com/c/old" }] },
  state: "OPEN",
  isDraft: false,
  merged: false,
  reviewDecision: "REVIEW_REQUIRED",
  headRefName: "feature",
  headRefOid: "0123456789abcdef",
  baseRefName: "main",
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  reviews: { nodes: [] },
  commits: { nodes: [{ commit: { oid: "0123456789abcdef", statusCheckRollup: { state: "PENDING", contexts: { nodes: [] } } } }] },
  ...over,
});
const comment = (body: string, createdAt: string, who = "bob") => ({ author: { login: who }, body, createdAt, url: `https://github.com/c/${createdAt}` });

// A GitHub whose GraphQL endpoint a test scripts: one repository with one
// pull request, whose bb-managed label validates.
function fakeGitHub() {
  const state = { node: pullNode() as Record<string, unknown> | null, fail: false, valid: (token: string) => token.startsWith("gho_"), openPulls: [] as Array<Record<string, unknown>>, dependabotAlerts: [] as unknown[], dependabotPage2: [] as unknown[], dependabotStatus: 200, dependabotMessage: "Forbidden", deployments: [] as unknown[], deploymentStatuses: {} as Record<number, unknown[]> };
  const calls: Array<{ token: string; variables: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const token = ((init?.headers as Record<string, string>).authorization ?? "").replace(/^Bearer /u, "");
    const u = String(url);
    const deployments = /\/repos\/([^/]+)\/([^/]+)\/deployments(?:\?|$)/u.exec(u);
    if (deployments !== null) {
      if (!state.valid(token)) return Response.json({ message: "Bad credentials" }, { status: 401 });
      if (`${deployments[1]}/${deployments[2]}`.toLowerCase() !== "acme/widgets") return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json(state.deployments);
    }
    const statuses = /\/repos\/([^/]+)\/([^/]+)\/deployments\/(\d+)\/statuses(?:\?|$)/u.exec(u);
    if (statuses !== null) {
      if (!state.valid(token)) return Response.json({ message: "Bad credentials" }, { status: 401 });
      return Response.json(state.deploymentStatuses[Number(statuses[3])] ?? []);
    }
    const dependabot = /\/repos\/([^/]+)\/([^/]+)\/dependabot\/alerts(?:\?|$)/u.exec(u);
    if (dependabot !== null) {
      if (!state.valid(token)) return Response.json({ message: "Bad credentials" }, { status: 401 });
      if (`${dependabot[1]}/${dependabot[2]}`.toLowerCase() !== "acme/widgets") return Response.json({ message: "Not Found" }, { status: 404 });
      if (state.dependabotStatus !== 200) return Response.json({ message: state.dependabotMessage }, { status: state.dependabotStatus });
      const page = new URL(u).searchParams.get("page");
      if (page === "2") return Response.json(state.dependabotPage2);
      const headers = state.dependabotPage2.length > 0 ? { link: `<${API_URL}/repos/acme/widgets/dependabot/alerts?state=open&per_page=100&page=2>; rel="next"` } : undefined;
      return Response.json(state.dependabotAlerts, headers === undefined ? undefined : { headers });
    }
    if (u !== `${API_URL}/graphql`) return new Response("not found", { status: 404 });
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push({ token, variables: body.variables });
    if (!state.valid(token)) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (state.fail) return Response.json({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] });
    const v = body.variables as { owner: string; name: string; number: number; label?: string };
    if (!body.query.includes("repository(")) return Response.json({ data: { viewer: { login: "dev" } } });
    if (`${v.owner}/${v.name}`.toLowerCase() !== "acme/widgets") return Response.json({ data: { viewer: { login: "dev" }, repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] });
    if (body.query.includes("label(name:")) return Response.json({ data: { viewer: { login: "dev" }, repository: { nameWithOwner: "Acme/Widgets", label: v.label === "bb-managed" ? { name: "bb-managed" } : null } } });
    if (body.query.includes("pullRequests(")) return Response.json({ data: { viewer: { login: "dev" }, repository: { nameWithOwner: "Acme/Widgets", pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.openPulls } } } });
    if (`${v.owner}/${v.name}`.toLowerCase() !== "acme/widgets") return Response.json({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] });
    const number = typeof state.node?.number === "number" ? state.node.number : 12;
    if (v.number !== number || state.node === null) return Response.json({ data: { repository: { nameWithOwner: "Acme/Widgets", issueOrPullRequest: null } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] });
    return Response.json({ data: { repository: { nameWithOwner: "Acme/Widgets", issueOrPullRequest: state.node } } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, state };
}

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
    doorbell: (id: string) => `event: doorbell\ndata: ${JSON.stringify({ source: "github", kind: "issue", id, unit: "Acme/Widgets", action: "pull_request_review.submitted", at: "2026-10-10T17:02:11Z" })}\n\n`,
  };
}

type RpcCall = { pluginId: string; method: string; input: Record<string, unknown> };

async function setup(
  options: {
    env?: Record<string, string>;
    send?: (...args: never[]) => unknown;
    get?: (args: { threadId: string }) => Promise<unknown>;
    token?: () => Promise<string>;
    /** Stands in for stewards answering cross-plugin calls. */
    callRpc?: (args: RpcCall) => Promise<unknown>;
    /** What kv held before this load: a restart. */
    kv?: Record<string, unknown>;
  } = {},
) {
  const send = vi.fn((options.send ?? (async () => ({ kind: "sent" }))) as (args: unknown) => unknown);
  const callRpc = vi.fn((options.callRpc ?? (async () => ({ ok: true }))) as (args: unknown) => Promise<unknown>);
  const { bb, harness } = createFakePluginHost({ pluginId: "github-watcher", sdk: { threads: { send, ...(options.get === undefined ? {} : { get: options.get }) }, plugins: { callRpc } } });
  for (const [key, value] of Object.entries(options.kv ?? {})) await bb.storage.kv.set(key, value);
  const github = fakeGitHub();
  const hooks = fakeHooks();
  let now = 1_000_000_000_000;
  const token = vi.fn(options.token ?? (async () => "gho_dev"));
  const fetchImpl = ((url, init) => (String(url).startsWith(HOOKS_URL) ? hooks.fetchImpl(url, init) : github.fetchImpl(url, init))) as typeof fetch;
  await createGitHubPlugin({ fetch: fetchImpl, now: () => now, env: options.env ?? {}, token, apiUrl: API_URL })(bb);
  const tool = (args: Record<string, unknown>, ctx: { threadId: string; projectId: string } = { threadId: "thr-1", projectId: "prj-1" }) =>
    harness.behavior.callAgentTool("github_watch", args, ctx) as Promise<string | { content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  const text = (result: Awaited<ReturnType<typeof tool>>) => (typeof result === "string" ? result : result.content.map((c) => c.text ?? "").join(""));
  const rows = () => bb.storage.database().prepare("SELECT thread_id, key, kind, updated_at, last_comment_at FROM watches ORDER BY thread_id").all() as Array<Record<string, unknown>>;
  const sent = () => send.mock.calls.map((c) => c[0] as { threadId: string; mode: string; input: Array<{ type: string; text: string }> });
  const rpcs = () => callRpc.mock.calls.map((c) => c[0] as RpcCall).map(({ pluginId, method, input }) => ({ pluginId, method, input }));
  return { bb, harness, github, hooks, token, send, tool, text, rows, sent, callRpc, rpcs, advance: (ms: number) => (now += ms) };
}

const issueNode = (over: Record<string, unknown> = {}) => ({
  __typename: "Issue",
  number: 7,
  title: "Bug",
  url: "https://github.com/Acme/Widgets/issues/7",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  author: { login: "bob" },
  assignees: { nodes: [] },
  labels: { nodes: [] },
  milestone: null,
  comments: { nodes: [] },
  state: "OPEN",
  stateReason: null,
  ...over,
});

const WITH_HOOKS = { env: { BB_HOOKS_URL: HOOKS_URL } };

describe("the tool", () => {
  it("is the one tool, and is refused with a reason on a server without bb-gate-hooks, starting no service", async () => {
    const { harness, tool, text } = await setup();
    expect(harness.registrations.agentTools.map((t: { name: string }) => t.name)).toEqual(["github_watch"]);
    const result = await tool({ ref: "Acme/Widgets#12" });
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain("BB_HOOKS_URL");
    expect(harness.registrations.services.map((s) => s.name)).toEqual([]);
  });

  it("records a watch under the name GitHub uses, is a no-op the second time, and stops at the limit", async () => {
    const { bb, harness, tool, text, rows, github } = await setup(WITH_HOOKS);
    expect(harness.registrations.services.map((s) => s.name)).toEqual(["watches"]);
    expect(text(await tool({ ref: "https://github.com/acme/widgets/pull/12/files" }))).toBe("Watching pull request Acme/Widgets#12: Add widgets. This thread will be messaged when it changes or someone else comments; end the turn rather than polling.");
    expect(rows()).toEqual([{ thread_id: "thr-1", key: "Acme/Widgets#12", kind: "pull", updated_at: "2026-10-09T10:00:00Z", last_comment_at: "2026-10-09T09:00:00Z" }]);
    expect(github.calls.at(-1)).toEqual({ token: "gho_dev", variables: { owner: "acme", name: "widgets", number: 12 } });
    expect(text(await tool({ ref: "Acme/Widgets#12" }))).toContain("Already watching pull request Acme/Widgets#12");
    expect(rows()).toHaveLength(1);

    expect(text(await tool({ ref: "Acme/Other#12" }))).toContain("No Acme/Other#12 on GitHub, or it is not visible");
    expect(text(await tool({ ref: "Acme/Widgets#13" }))).toContain("No Acme/Widgets#13 on GitHub");
    expect(text(await tool({ ref: "nonsense" }))).toContain("does not name a pull request or issue");

    // The fake has one pull request, so fill the rest of the thread by hand.
    const db = bb.storage.database();
    for (let i = 0; i < WATCH_LIMIT; i++) db.prepare("INSERT INTO watches (thread_id, project_id, key, kind, snapshot, updated_at, last_comment_at, created_at, last_activity_at) VALUES ('thr-1', 'prj-1', ?, 'pull', '{}', 'u', 'c', 0, 0)").run(`Acme/Widgets#${100 + i}`);
    db.prepare("DELETE FROM watches WHERE key = 'Acme/Widgets#12'").run();
    const full = await tool({ ref: "Acme/Widgets#12" });
    expect(full).toMatchObject({ isError: true });
    expect(text(full)).toContain(`already watches ${WATCH_LIMIT} GitHub pull requests or issues`);
    // The limit is per thread.
    expect(await tool({ ref: "Acme/Widgets#12" }, { threadId: "thr-2", projectId: "prj-1" })).not.toMatchObject({ isError: true });
  });

  it("says so when gh is not signed in, and when the target is not there", async () => {
    const { tool, text, rows } = await setup({ ...WITH_HOOKS, token: async () => { throw new NotSignedInError("no oauth token"); } });
    const result = await tool({ ref: "Acme/Widgets#12" });
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain("GitHub is not signed in on this bb server (no oauth token)");
    expect(rows()).toEqual([]);
  });

  it("re-reads the token from gh once when GitHub refuses it, and otherwise reuses it for five minutes", async () => {
    const tokens = ["gho_old", "gho_new"];
    const { tool, token, github, advance } = await setup({ ...WITH_HOOKS, token: async () => tokens.shift() ?? "gho_new" });
    github.state.valid = (t) => t === "gho_new";
    expect(await tool({ ref: "Acme/Widgets#12" })).not.toMatchObject({ isError: true });
    expect(github.calls.map((c) => c.token)).toEqual(["gho_old", "gho_new"]);
    expect(token).toHaveBeenCalledTimes(2);
    await tool({ ref: "Acme/Widgets#12" });
    expect(token).toHaveBeenCalledTimes(2);
    advance(TOKEN_CACHE_MS + 1);
    await tool({ ref: "Acme/Widgets#12" });
    expect(token).toHaveBeenCalledTimes(3);
  });
});

describe("the service", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

  it("leases the watches with the developer's token, checks on hello, and wakes the thread on a doorbell with what changed", async () => {
    const w = await setup(WITH_HOOKS);
    await w.tool({ ref: "Acme/Widgets#12" }, { threadId: "thr-1", projectId: "prj-1" });
    await w.tool({ ref: "Acme/Widgets#12" }, { threadId: "thr-2", projectId: "prj-1" });
    const service = w.harness.runService("watches");
    await tick();
    expect(w.hooks.streams).toHaveLength(1);
    w.hooks.last().send(w.hooks.hello("c_1"));
    await tick();
    expect(w.hooks.subscribes).toEqual([{ connection: "c_1", source: "github", token: "gho_dev", watches: [{ kind: "issue", id: "Acme/Widgets#12" }] }]);
    // The hello sweep read the pull request and found nothing new.
    expect(w.github.calls.at(-1)!.variables).toEqual({ owner: "Acme", name: "Widgets", number: 12 });
    expect(w.send).not.toHaveBeenCalled();

    // A review lands, checks finish, one thread comments through gh with its signature, a human answers.
    w.github.state.node = pullNode({
      updatedAt: "2026-10-09T12:00:00Z",
      reviewDecision: "APPROVED",
      latestReviews: { nodes: [{ author: { login: "carol" }, state: "APPROVED" }] },
      reviews: { nodes: [{ author: { login: "carol" }, state: "APPROVED", body: "LGTM", createdAt: "2026-10-09T11:00:00Z", submittedAt: "2026-10-09T11:00:00Z", url: "https://github.com/r/1", comments: { nodes: [] } }] },
      comments: { nodes: [comment("old", "2026-10-09T09:00:00Z"), comment(`Addressed\n\n${signature("thr-1")}`, "2026-10-09T11:10:00Z", "jane"), comment("Merging", "2026-10-09T11:30:00Z")] },
      commits: { nodes: [{ commit: { oid: "0123456789abcdef", statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/1" }] } } } }] },
    });
    const reads = w.github.calls.length;
    w.hooks.last().send(w.hooks.doorbell("Acme/Widgets#12"));
    w.hooks.last().send(w.hooks.doorbell("Acme/Widgets#12"));
    w.hooks.last().send(w.hooks.doorbell("Acme/Widgets#99"));
    await tick(2999);
    expect(w.send).not.toHaveBeenCalled();
    await tick(1);
    await tick();
    expect(w.github.calls.length - reads).toBe(1);
    const sent = w.sent();
    expect(sent.map((m) => [m.threadId, m.mode, m.input[0]!.type])).toEqual([
      ["thr-1", "auto", "text"],
      ["thr-2", "auto", "text"],
    ]);
    const toOwner = sent[0]!.input[0]!.text;
    expect(toOwner).toContain("GitHub pull request Acme/Widgets#12 changed: Add widgets");
    expect(toOwner).toContain("- Review decision: review required → approved");
    expect(toOwner).toContain("- Reviews: (none) → carol: approved");
    expect(toOwner).toContain("- Checks: pending → success");
    expect(toOwner).not.toContain("Head:");
    expect(toOwner).toContain("**carol** approved — 2026-10-09T11:00:00Z");
    expect(toOwner).toContain("> LGTM");
    expect(toOwner).toContain("**bob** commented — 2026-10-09T11:30:00Z");
    // thr-1 wrote the signed comment, so it is not told about it; thr-2 is.
    expect(toOwner).not.toContain("Addressed");
    expect(sent[1]!.input[0]!.text).toContain("Addressed");
    expect(w.rows().map((r) => [r.updated_at, r.last_comment_at])).toEqual([
      ["2026-10-09T12:00:00Z", "2026-10-09T11:30:00Z"],
      ["2026-10-09T12:00:00Z", "2026-10-09T11:30:00Z"],
    ]);
    // Nothing is reported twice.
    w.hooks.last().send(w.hooks.doorbell("Acme/Widgets#12"));
    await tick(3000);
    expect(w.send).toHaveBeenCalledTimes(2);
    expect(w.harness.logEntries.map((l) => l.message).join("\n")).not.toContain("gho_dev");

    service.controller.abort();
    await service.done;
    expect(w.hooks.last().closed).toBe(true);
  });

  it("keeps the cursor when the thread cannot be woken, and drops the watch when the thread is gone", async () => {
    let mode: "fail" | "gone" | "ok" = "fail";
    const w = await setup({
      ...WITH_HOOKS,
      send: async () => {
        if (mode === "ok") return { kind: "sent" };
        throw Object.assign(new Error(mode === "gone" ? "thread not found" : "busy"), mode === "gone" ? { code: "NOT_FOUND", status: 404 } : { status: 500 });
      },
    });
    await w.tool({ ref: "Acme/Widgets#12" });
    const service = w.harness.runService("watches");
    await tick();
    w.hooks.last().send(w.hooks.hello("c_1"));
    await tick();
    w.github.state.node = pullNode({ updatedAt: "2026-10-09T12:00:00Z", state: "MERGED", merged: true });
    w.hooks.last().send(w.hooks.doorbell("Acme/Widgets#12"));
    await tick(3000);
    expect(w.send).toHaveBeenCalledTimes(1);
    expect(w.rows()[0]!.updated_at).toBe("2026-10-09T10:00:00Z");
    // Still unreported, so the next doorbell says it again.
    mode = "ok";
    w.hooks.last().send(w.hooks.doorbell("Acme/Widgets#12"));
    await tick(3000);
    expect(w.send).toHaveBeenCalledTimes(2);
    expect(w.rows()[0]!.updated_at).toBe("2026-10-09T12:00:00Z");

    mode = "gone";
    w.github.state.node = pullNode({ updatedAt: "2026-10-09T13:00:00Z", title: "Renamed" });
    w.hooks.last().send(w.hooks.doorbell("Acme/Widgets#12"));
    await tick(3000);
    expect(w.rows()).toEqual([]);
    service.controller.abort();
    await service.done;
  });

  it("shows every watch with its counters, flags and thread title, lets one be stopped, and signals the settings section", async () => {
    const get = vi.fn(async ({ threadId }: { threadId: string }) => {
      if (threadId === "thr-1") return { id: threadId, title: "Ship widgets" };
      throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
    });
    const w = await setup({ ...WITH_HOOKS, get });
    const signals = () => w.harness.realtimeSignals.filter((x) => x.channel === "watches-changed").length;
    type View = { watches: Array<Record<string, unknown>>; threads: unknown; hooks: Record<string, unknown> };

    let view = (await w.harness.callRpc("watches", null)) as View;
    expect(view).toMatchObject({ limit: WATCH_LIMIT, hooks: { configured: true, state: "stopped" }, threads: [], watches: [] });

    await w.tool({ ref: "Acme/Widgets#12" }, { threadId: "thr-1", projectId: "prj-1" });
    expect(signals()).toBe(1);
    const service = w.harness.runService("watches");
    await tick();
    w.hooks.last().send(w.hooks.hello("c_1"));
    await tick();
    view = (await w.harness.callRpc("watches", null)) as View;
    expect(view).toMatchObject({ hooks: { state: "connected", leased: true, sweeps: 1, lastSweepReason: "connected" } });
    expect(view.watches).toEqual([
      expect.objectContaining({
        threadId: "thr-1",
        threadTitle: "Ship widgets",
        target: { id: "Acme/Widgets#12", key: "Acme/Widgets#12", kind: "pull", title: "Add widgets", url: "https://github.com/Acme/Widgets/pull/12" },
        checks: 1,
        wakes: 0,
        lastWokeAt: 0,
        flags: [],
      }),
    ]);

    w.github.state.node = pullNode({ updatedAt: "2026-10-09T12:00:00Z", reviewDecision: "APPROVED", comments: { nodes: [] } });
    w.hooks.last().send(w.hooks.doorbell("Acme/Widgets#12"));
    await tick(3000);
    expect(w.send).toHaveBeenCalledTimes(1);
    view = (await w.harness.callRpc("watches", null)) as View;
    expect(view.watches[0]).toMatchObject({ checks: 2, wakes: 1, wakesInWindow: 1 });
    expect(view.hooks).toMatchObject({ doorbells: 1 });
    expect(view.threads).toEqual([{ threadId: "thr-1", title: "Ship widgets", count: 1, wakes: 1, nearLimit: false }]);
    const afterWake = signals();
    expect(afterWake).toBeGreaterThan(1);

    // A thread bb cannot read shows its id; an issue links to /issues. The CLI prints the same view.
    w.github.state.node = issueNode();
    await w.tool({ ref: "Acme/Widgets#7" }, { threadId: "thr-gone", projectId: "prj-1" });
    expect(w.harness.registrations.cli?.name).toBe("github-watcher");
    const cli = await w.harness.runCli(["watches"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("Doorbells: connected and leased");
    expect(cli.stdout).toContain("2 watches across 2 threads");
    expect(cli.stdout).toMatch(/Acme\/Widgets#12 +Ship widgets +/u);
    expect(cli.stdout).toMatch(/Acme\/Widgets#7 +thr-gone +/u);
    const json = JSON.parse((await w.harness.runCli(["watches", "--json"])).stdout) as View;
    expect(json.watches.map((x) => x.target)).toEqual([
      expect.objectContaining({ key: "Acme/Widgets#12" }),
      { id: "Acme/Widgets#7", key: "Acme/Widgets#7", kind: "issue", title: expect.any(String), url: "https://github.com/Acme/Widgets/issues/7" },
    ]);

    expect(await w.harness.callRpc("unwatch", { threadId: "thr-1", targetId: "Acme/Widgets#12" })).toEqual({ removed: true });
    expect(await w.harness.callRpc("unwatch", { threadId: "thr-1", targetId: "Acme/Widgets#12" })).toEqual({ removed: false });
    expect(w.rows().map((r) => r.key)).toEqual(["Acme/Widgets#7"]);
    expect(w.send).toHaveBeenCalledTimes(1);
    expect(signals()).toBe(afterWake + 2);

    service.controller.abort();
    await service.done;
    expect(((await w.harness.callRpc("watches", null)) as View).hooks.state).toBe("stopped");
  });

  it("forgets a thread's watches when it is archived or deleted", async () => {
    const w = await setup(WITH_HOOKS);
    await w.tool({ ref: "Acme/Widgets#12" }, { threadId: "thr-1", projectId: "prj-1" });
    await w.tool({ ref: "Acme/Widgets#12" }, { threadId: "thr-2", projectId: "prj-1" });
    await w.harness.emitThreadEvent("thread.archived", { thread: { id: "thr-1" } as never });
    expect(w.rows().map((r) => r.thread_id)).toEqual(["thr-2"]);
    await w.harness.emitThreadEvent("thread.deleted", { thread: { id: "thr-2" } as never });
    expect(w.rows()).toEqual([]);
  });

  it("drops a refused watch only when the developer cannot read the target either, and tells the thread", async () => {
    const w = await setup(WITH_HOOKS);
    await w.tool({ ref: "Acme/Widgets#12" });
    w.hooks.state.answer = (body) => Response.json({ leases: [], rejected: body.watches.map((x) => ({ ...x, reason: "forbidden" })) });
    const service = w.harness.runService("watches");
    await tick();
    w.hooks.last().send(w.hooks.hello("c_1"));
    await tick();
    // Readable here: the service is wrong or stale; the watch stays.
    expect(w.rows()).toHaveLength(1);
    expect(w.send).not.toHaveBeenCalled();
    expect(w.harness.logEntries.some((l) => l.message.includes("keeping the watch"))).toBe(true);

    // GitHub unreachable from here: neither answer can be confirmed, so the watch stays for the next renewal.
    w.github.state.fail = true;
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
    w.github.state.fail = false;
    w.github.state.node = null;
    await tick(30 * 60_000);
    expect(w.rows()).toEqual([]);
    expect(w.sent().map((m) => m.input[0]!.text)).toEqual(["GitHub pull request Acme/Widgets#12 is no longer visible to the signed-in GitHub user (deleted, transferred, or access removed), so this thread has stopped watching it."]);
    service.controller.abort();
    await service.done;
  });

  it("re-reads the token from gh and retries once when the service says GitHub refused it", async () => {
    const tokens = ["gho_old", "gho_new"];
    const w = await setup({ ...WITH_HOOKS, token: async () => tokens.shift() ?? "gho_new" });
    await w.tool({ ref: "Acme/Widgets#12" });
    w.hooks.state.answer = (body) => (body.token === "gho_new" ? Response.json({ leases: body.watches, rejected: [] }) : new Response("token refused", { status: 401 }));
    const service = w.harness.runService("watches");
    await tick();
    w.hooks.last().send(w.hooks.hello("c_1"));
    await tick();
    expect(w.hooks.subscribes.map((s) => s.token)).toEqual(["gho_old", "gho_new"]);
    expect(w.token).toHaveBeenCalledTimes(2);
    service.controller.abort();
    await service.done;
  });
});

describe("stewards' source contract", () => {
  const STEWARDS = { experimental_caller: { kind: "plugin" as const, pluginId: "stewards" } };

  it("snapshots a pull request as the contract names it, and answers null for one that is not there", async () => {
    const w = await setup();
    w.github.state.node = pullNode({
      body: "Adds widgets.",
      isDraft: true,
      comments: { nodes: [{ id: "IC_1", ...comment(`Done\n\n_— from bb thread thr-9_`, "2026-10-09T09:00:00Z") }] },
      reviews: { nodes: [{ id: "PRR_1", author: { login: "carol" }, state: "CHANGES_REQUESTED", body: "No", createdAt: "2026-10-09T08:00:00Z", submittedAt: "2026-10-09T08:00:01Z", url: "https://github.com/r/1", commit: { oid: "aaaa" }, comments: { nodes: [] } }] },
    });
    const { snapshot } = (await w.harness.callRpc("sourceSnapshot", { id: "https://github.com/acme/widgets/pull/12" }, STEWARDS)) as { snapshot: Record<string, unknown> };
    expect(snapshot).toMatchObject({ source: "github", kind: "pull", id: "Acme/Widgets#12", key: "Acme/Widgets#12", unit: "Acme/Widgets", state: "draft", description: "Adds widgets.", stateType: null });
    expect(snapshot.comments).toEqual([
      { id: "PRR_1", author: "carol", did: "requested changes", body: "No", createdAt: "2026-10-09T08:00:01Z", url: "https://github.com/r/1", signedBy: null },
      { id: "IC_1", author: "bob", did: "commented", body: "Done\n\n_— from bb thread thr-9_", createdAt: "2026-10-09T09:00:00Z", url: "https://github.com/c/2026-10-09T09:00:00Z", signedBy: "thr-9" },
    ]);
    expect(snapshot.pull).toMatchObject({ draft: true, merged: false, headSha: "0123456789abcdef", reviews: [{ author: "carol", state: "changes requested", submittedAt: "2026-10-09T08:00:01Z", commit: "aaaa" }] });
    expect(await w.harness.callRpc("sourceSnapshot", { id: "Acme/Widgets#13" }, STEWARDS)).toEqual({ snapshot: null });
    expect(await w.harness.callRpc("sourceSnapshot", { id: "nonsense" }, STEWARDS)).toEqual({ snapshot: null });
  });

  it("validates repositories and their label, and says so when gh is not signed in rather than failing", async () => {
    const w = await setup();
    expect(await w.harness.callRpc("sourceValidate", { units: ["acme/widgets", "Acme/Nope", "not-a-repo"], label: "bb-managed", states: ["In Review"] }, STEWARDS)).toEqual({
      viewer: "dev",
      units: [
        { unit: "acme/widgets", found: true, labelFound: true, missingStates: [] },
        { unit: "Acme/Nope", found: false, labelFound: false, missingStates: [] },
        { unit: "not-a-repo", found: false, labelFound: false, missingStates: [] },
      ],
      mine: [],
      error: null,
    });
    expect(((await w.harness.callRpc("sourceValidate", { units: ["acme/widgets"], label: "other", states: [] }, STEWARDS)) as { units: unknown[] }).units).toEqual([{ unit: "acme/widgets", found: true, labelFound: false, missingStates: [] }]);

    const out = await setup({ token: async () => { throw new NotSignedInError("no oauth token"); } });
    expect(await out.harness.callRpc("sourceValidate", { units: ["acme/widgets"], label: "bb-managed", states: [] }, STEWARDS)).toEqual({ viewer: null, units: [], mine: [], error: expect.stringContaining("not signed in") });
  });

  it("lists open pull requests oldest first up to the limit, with per-repository errors", async () => {
    const w = await setup();
    w.github.state.openPulls = [
      { number: 3, isDraft: false, createdAt: "2026-10-01T00:00:00Z", author: { login: "jane" }, labels: { nodes: [{ name: "bb-managed" }] } },
      { number: 5, isDraft: true, createdAt: "2026-10-02T00:00:00Z", author: null, labels: { nodes: [] } },
    ];
    const result = (await w.harness.callRpc("sourceAdoptable", { units: ["Acme/Widgets", "acme/gone"], label: "bb-managed", limit: 1 }, STEWARDS)) as { viewer: string; entities: unknown[]; errors: string[] };
    expect(result.viewer).toBe("dev");
    expect(result.entities).toEqual([{ id: "Acme/Widgets#3", key: "Acme/Widgets#3", unit: "Acme/Widgets", kind: "pull", state: "open", labels: ["bb-managed"], author: "jane", draft: false, createdAt: "2026-10-01T00:00:00Z" }]);
    expect(result.errors).toEqual(["acme/gone: no such repository, or it is not visible to the signed-in GitHub user"]);
    expect(w.github.calls.find((c) => c.variables.first !== undefined)!.variables).toMatchObject({ owner: "Acme", name: "Widgets", first: 1, after: null });
  });

  it("reads a repository's Dependabot alerts, naming a repository or a repo the token cannot read rather than failing", async () => {
    const w = await setup();
    w.github.state.dependabotAlerts = [
      {
        number: 4,
        state: "open",
        dependency: { package: { ecosystem: "npm", name: "lodash" }, manifest_path: "package-lock.json" },
        security_advisory: { ghsa_id: "GHSA-x", severity: "high", summary: "Prototype pollution" },
        security_vulnerability: { severity: "high", first_patched_version: { identifier: "4.17.21" } },
        html_url: "https://github.com/Acme/Widgets/security/dependabot/4",
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-02T00:00:00Z",
      },
    ];
    expect(await w.harness.callRpc("sourceDependabotAlerts", { units: ["Acme/Widgets"], state: "open" }, STEWARDS)).toEqual({
      viewer: "dev",
      alerts: [
        {
          id: "Acme/Widgets#4",
          repo: "Acme/Widgets",
          number: 4,
          severity: "high",
          package: "lodash",
          ecosystem: "npm",
          manifestPath: "package-lock.json",
          state: "open",
          ghsaId: "GHSA-x",
          fixedVersion: "4.17.21",
          summary: "Prototype pollution",
          url: "https://github.com/Acme/Widgets/security/dependabot/4",
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-02T00:00:00Z",
        },
      ],
      errors: [],
    });
    expect(await w.harness.callRpc("sourceDependabotAlerts", { units: ["acme/gone", "widgets"], state: "open" }, STEWARDS)).toMatchObject({ alerts: [], errors: ["acme/gone: GitHub answered HTTP 404: Not Found", "widgets: not owner/repo"] });
  });

  it("names a repository whose alerts the token cannot read (403) without failing the whole call", async () => {
    const w = await setup();
    w.github.state.dependabotStatus = 403;
    w.github.state.dependabotMessage = "Resource not accessible by integration";
    expect(await w.harness.callRpc("sourceDependabotAlerts", { units: ["Acme/Widgets"], state: "open" }, STEWARDS)).toMatchObject({ alerts: [], errors: ["Acme/Widgets: GitHub answered HTTP 403: Resource not accessible by integration"] });
  });

  it("follows the Link header so a repository with more than one page of alerts is read whole", async () => {
    const w = await setup();
    w.github.state.dependabotAlerts = [{ number: 1, state: "open", dependency: { package: { ecosystem: "npm", name: "a" } }, security_advisory: { severity: "low" }, security_vulnerability: { first_patched_version: null } }];
    w.github.state.dependabotPage2 = [{ number: 2, state: "open", dependency: { package: { ecosystem: "npm", name: "b" } }, security_advisory: { severity: "high" }, security_vulnerability: { first_patched_version: null } }];
    const out = (await w.harness.callRpc("sourceDependabotAlerts", { units: ["Acme/Widgets"], state: "open" }, STEWARDS)) as { alerts: Array<{ id: string }>; errors: string[] };
    expect(out.alerts.map((a) => a.id)).toEqual(["Acme/Widgets#1", "Acme/Widgets#2"]);
    expect(out.errors).toEqual([]);
  });

  it("reads a repository's deployments for one environment, newest first, each with its latest status (BB-59)", async () => {
    const w = await setup();
    w.github.state.deployments = [
      { id: 6, environment: "production", ref: "main", sha: "aaaaaaa1", url: "https://github.com/Acme/Widgets/actions/runs/8" },
      { id: 7, environment: "production", ref: "main", sha: "bbbbbbb2", url: "https://github.com/Acme/Widgets/actions/runs/9" },
    ];
    w.github.state.deploymentStatuses = { 7: [{ state: "success" }], 6: [{ state: "failure" }] };
    expect(await w.harness.callRpc("sourceDeployments", { repo: "Acme/Widgets", environment: "production", limit: 10 }, STEWARDS)).toEqual({
      deployments: [
        { id: 7, environment: "production", ref: "main", sha: "bbbbbbb2", state: "success", url: "https://github.com/Acme/Widgets/actions/runs/9" },
        { id: 6, environment: "production", ref: "main", sha: "aaaaaaa1", state: "failure", url: "https://github.com/Acme/Widgets/actions/runs/8" },
      ],
      error: null,
    });
    // The list is sorted by id, so a limit keeps the newest, whatever order GitHub returned.
    const limited = (await w.harness.callRpc("sourceDeployments", { repo: "acme/widgets", environment: "production", limit: 1 }, STEWARDS)) as { deployments: Array<{ id: number; state: string }> };
    expect(limited.deployments).toEqual([expect.objectContaining({ id: 7, state: "success" })]);
    expect(await w.harness.callRpc("sourceDeployments", { repo: "acme/gone", environment: "production", limit: 10 }, STEWARDS)).toMatchObject({ deployments: [], error: "acme/gone: GitHub answered HTTP 404: Not Found" });
    expect(await w.harness.callRpc("sourceDeployments", { repo: "widgets", environment: "production", limit: 10 }, STEWARDS)).toMatchObject({ deployments: [], error: "widgets: not owner/repo" });
  });

  describe("interest", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

    it("is only for stewards, is kept in kv, is leased at once, and rings stewards for doorbells in it", async () => {
      const w = await setup(WITH_HOOKS);
      await expect(w.harness.callRpc("sourceSetInterest", { units: ["acme/widgets"], entities: [] })).rejects.toThrow(/stewards plugin only/u);
      await expect(w.harness.callRpc("sourceSetInterest", { units: [], entities: [] }, { experimental_caller: { kind: "plugin", pluginId: "linear" } })).rejects.toThrow(/stewards plugin only/u);
      await expect(w.harness.callRpc("sourceSetInterest", { units: ["widgets"], entities: [] }, STEWARDS)).rejects.toThrow(/want owner\/repo/u);

      const service = w.harness.runService("watches");
      await tick();
      w.hooks.last().send(w.hooks.hello("c_1"));
      await tick();
      expect(w.hooks.subscribes).toEqual([]);

      expect(await w.harness.callRpc("sourceSetInterest", { units: ["acme/gadgets"], entities: ["https://github.com/Acme/Widgets/pull/12"] }, STEWARDS)).toEqual({ ok: true });
      expect(await w.bb.storage.kv.get("stewards/interest")).toEqual({ units: ["acme/gadgets"], entities: ["Acme/Widgets#12"], dependabot: [], deployment: [] });
      type Interest = { units: string[]; entities: Array<{ key: string; url: string | null }>; unleased: Array<{ key: string; reason: string }> };
      const interestOf = async () => ((await w.harness.callRpc("watches", null)) as { interest: Interest }).interest;
      expect(await interestOf()).toMatchObject({ units: ["acme/gadgets"], entities: [{ key: "Acme/Widgets#12", url: "https://github.com/Acme/Widgets/issues/12" }], unleased: [] });
      await tick();
      expect(w.hooks.subscribes.map((s) => s.watches)).toEqual([[{ kind: "repo", id: "acme/gadgets" }], [{ kind: "issue", id: "Acme/Widgets#12" }]]);
      // Setting the same again leases nothing new.
      await w.harness.callRpc("sourceSetInterest", { units: ["Acme/Gadgets"], entities: ["Acme/Widgets#12"] }, STEWARDS);
      await tick();
      expect(w.hooks.subscribes).toHaveLength(2);

      // A doorbell for the entity, and one in the repository (spelled as GitHub does), ring stewards once each after the debounce; others do not.
      w.hooks.last().send(w.hooks.doorbell("Acme/Widgets#12"));
      w.hooks.last().send(w.hooks.doorbell("Acme/Widgets#12"));
      w.hooks.last().send(`event: doorbell\ndata: ${JSON.stringify({ source: "github", kind: "issue", id: "Acme/Gadgets#4", unit: "Acme/Gadgets" })}\n\n`);
      w.hooks.last().send(w.hooks.doorbell("Acme/Widgets#99"));
      await tick(3000);
      expect(w.rpcs()).toEqual([
        { pluginId: "stewards", method: "stewardsRing", input: { source: "github", id: "Acme/Widgets#12" } },
        { pluginId: "stewards", method: "stewardsRing", input: { source: "github", id: "Acme/Gadgets#4" } },
      ]);

      // A refused repository lease is logged and otherwise ignored.
      w.hooks.state.answer = (body) => Response.json({ leases: [], rejected: body.watches.map((x) => ({ ...x, reason: "forbidden" })) });
      await tick(30 * 60_000);
      expect(w.harness.logEntries.some((l) => l.message.includes("refused a lease on repository Acme/Gadgets for stewards (forbidden)"))).toBe(true);
      // The usage view says so too, under the name stewards asked for.
      expect((await interestOf()).unleased).toEqual([
        { key: "Acme/Gadgets", reason: "refused by bb-gate-hooks (forbidden)" },
        { key: "Acme/Widgets#12", reason: "refused by bb-gate-hooks (forbidden)" },
      ]);
      expect(w.send).not.toHaveBeenCalled();
      service.controller.abort();
      await service.done;
    });

    it("leases Dependabot repositories and rings stewards for dependabot_alert doorbells, skipping a refused lease", async () => {
      const w = await setup(WITH_HOOKS);
      const service = w.harness.runService("watches");
      await tick();
      w.hooks.last().send(w.hooks.hello("c_1"));
      await tick();
      expect(await w.harness.callRpc("sourceSetInterest", { units: [], entities: [], dependabot: ["acme/widgets"] }, STEWARDS)).toEqual({ ok: true });
      await tick();
      expect(w.hooks.subscribes.map((s) => s.watches)).toEqual([[{ kind: "dependabot_repo", id: "acme/widgets" }]]);
      // A dependabot_alert doorbell in the leased repository rings stewards; one elsewhere does not.
      w.hooks.last().send(`event: doorbell\ndata: ${JSON.stringify({ source: "github", kind: "dependabot_alert", id: "Acme/Widgets#4", unit: "Acme/Widgets" })}\n\n`);
      w.hooks.last().send(`event: doorbell\ndata: ${JSON.stringify({ source: "github", kind: "dependabot_alert", id: "Acme/Other#4", unit: "Acme/Other" })}\n\n`);
      await tick(3000);
      expect(w.rpcs()).toEqual([{ pluginId: "stewards", method: "stewardsRing", input: { source: "github", id: "Acme/Widgets#4" } }]);
      // A refused dependabot_repo lease is a skip, logged as one.
      w.hooks.state.answer = (body) => Response.json({ leases: [], rejected: body.watches.map((x) => ({ ...x, reason: "forbidden" })) });
      await tick(30 * 60_000);
      expect(w.harness.logEntries.some((l) => l.message.includes("this server skips Dependabot alerts there"))).toBe(true);
      service.controller.abort();
      await service.done;
    });

    it("leases deployment repositories and hands stewards a deployment doorbell's object", async () => {
      const w = await setup(WITH_HOOKS);
      const service = w.harness.runService("watches");
      await tick();
      w.hooks.last().send(w.hooks.hello("c_1"));
      await tick();
      expect(await w.harness.callRpc("sourceSetInterest", { units: [], entities: [], dependabot: [], deployment: ["acme/bb-gate"] }, STEWARDS)).toEqual({ ok: true });
      await tick();
      expect(w.hooks.subscribes.map((s) => s.watches)).toEqual([[{ kind: "deployment_repo", id: "acme/bb-gate" }]]);
      const deployment = { id: 7, environment: "production", ref: "main", sha: "abc123", state: "success", url: "https://github.com/acme/bb-gate/actions/runs/9" };
      w.hooks.last().send(`event: doorbell\ndata: ${JSON.stringify({ source: "github", kind: "deployment", id: "Acme/bb-gate#7", unit: "Acme/bb-gate", deployment })}\n\n`);
      w.hooks.last().send(`event: doorbell\ndata: ${JSON.stringify({ source: "github", kind: "deployment", id: "Acme/Other#7", unit: "Acme/Other", deployment })}\n\n`);
      await tick(3000);
      expect(w.rpcs()).toEqual([{ pluginId: "stewards", method: "stewardsRing", input: { source: "github", id: "Acme/bb-gate#7", deployment } }]);
      // A refused deployment_repo lease is a skip, logged as one.
      w.hooks.state.answer = (body) => Response.json({ leases: [], rejected: body.watches.map((x) => ({ ...x, reason: "forbidden" })) });
      await tick(30 * 60_000);
      expect(w.harness.logEntries.some((l) => l.message.includes("this server skips deployment doorbells there"))).toBe(true);
      const interest = ((await w.harness.callRpc("watches", null)) as { interest: { unleased: Array<{ key: string; reason: string }> } }).interest;
      expect(interest.unleased).toEqual([{ key: "acme/bb-gate", reason: "refused by bb-gate-hooks (forbidden); deployment doorbells are skipped" }]);
      service.controller.abort();
      await service.done;
    });

    it("leases what stewards asked for after a restart, beside the watches", async () => {
      const w = await setup({ ...WITH_HOOKS, kv: { "stewards/interest": { units: ["acme/gadgets"], entities: ["acme/widgets#12"] } } });
      await w.tool({ ref: "Acme/Widgets#12" });
      const service = w.harness.runService("watches");
      await tick();
      w.hooks.last().send(w.hooks.hello("c_1"));
      await tick();
      // The watch and the entity are one lease, whatever the casing.
      expect(w.hooks.subscribes.map((s) => s.watches)).toEqual([[{ kind: "issue", id: "Acme/Widgets#12" }, { kind: "repo", id: "acme/gadgets" }]]);
      service.controller.abort();
      await service.done;
    });
  });
});

