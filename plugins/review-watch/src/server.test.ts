import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { QueueItem } from "./types.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

function item(number: number, rule: QueueItem["rule"] = "review-requested"): QueueItem {
  return {
    key: `${rule}:node-${number}:sha-${number}`,
    rule,
    state: "queued",
    repo: "owner/repo",
    number,
    title: `Fix review issue number ${number}`,
    author: "author",
    url: `https://github.com/owner/repo/pull/${number}`,
    baseBranch: "main",
    headBranch: `feature-${number}`,
    headSha: `sha-${number}`,
    nodeId: `node-${number}`,
    reason: "review requested",
    noticedAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  };
}

async function setup(items: QueueItem[], githubToken?: string, organizationProjects = "{}") {
  const host = createFakePluginHost({ settings: {
    project: "project-test",
    organizationProjects,
    ...(githubToken === undefined ? {} : { githubToken }),
  } });
  hosts.push(host);
  await host.bb.storage.kv.set("queue", items);
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thread-1" }));
  host.harness.sdk.stub("projects.get", async () => ({
    id: "project-test",
    sources: [
      { hostId: "server-host", path: "/wrong-checkout", isDefault: false },
      { hostId: "devbox-host", path: "/project-checkout", isDefault: true },
    ],
  }));
  host.harness.sdk.stub("projects.list", async () => [
    { id: "project-test", name: "Default", sources: [{ isDefault: true }] },
    { id: "project-parsley", name: "Parsley", sources: [{ isDefault: true }] },
    { id: "project-no-checkout", name: "No checkout", sources: [] },
  ]);
  await plugin(host.bb);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function graphqlResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function retainedNode(id: string, state = "OPEN", review: { state: string; submittedAt: string | null } | null = null) {
  const number = Number(id.replace("node-", ""));
  return {
    id, state, number, title: `Fix review issue number ${number}`,
    url: `https://github.com/owner/repo/pull/${number}`, isDraft: false,
    updatedAt: "2026-01-01T00:00:00.000Z", reviewDecision: "REVIEW_REQUIRED",
    baseRefName: "main", headRefName: `feature-${number}`, headRefOid: `sha-${number}`,
    author: { login: "author" }, repository: { nameWithOwner: "owner/repo" },
    commits: { nodes: [{ commit: { committedDate: "2026-01-01T00:00:00.000Z" } }] },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviews: { nodes: review === null ? [] : [review] },
  };
}

describe("poll with date-limited searches", () => {
  it("archives a retained started thread after GitHub confirms a later submitted review", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      if (query.includes("query Viewer")) return graphqlResponse({ viewer: { login: "reader-ada" } });
      if (query.includes("query WatchedPullRequests")) return graphqlResponse({ search: {
        nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
      } });
      return graphqlResponse({ nodes: [retainedNode("node-10", "OPEN", {
        state: "COMMENTED", submittedAt: "2026-09-30T01:00:00.000Z",
      })] });
    }));
    const started = {
      ...item(10), state: "started" as const, threadId: "old-thread",
      reviewBaselineSubmittedAt: null, updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const host = await setup([started], "test-token");
    expect(await host.harness.behavior.callRpc("poll_now", null)).toMatchObject({ ok: true, changed: true });
    const archived = { ...started, state: "archived" };
    expect(await host.bb.storage.kv.get<QueueItem[]>("queue")).toEqual([archived]);
    expect(await host.harness.behavior.callRpc("queue_list", null)).toMatchObject({ items: [archived] });
    const status = await host.harness.behavior.runCli(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      queued: { "review-requested": 0, "review-followup": 0 },
      pending: { "review-requested": 0, "review-followup": 0 },
      started: 0,
      archived: 1,
    });
  });

  it("keeps old started PRs that remain open and drops closed retained PRs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
    const searches: string[] = [];
    const lookups: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const { query, variables } = JSON.parse(String(init.body)) as {
        query: string;
        variables: Record<string, string>;
      };
      if (query.includes("query Viewer")) return graphqlResponse({ viewer: { login: "reader-ada" } });
      if (query.includes("query WatchedPullRequests")) {
        searches.push(variables.search!);
        return graphqlResponse({ search: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        } });
      }
      lookups.push(query);
      if (query.includes("RetainedPullRequestDetails")) return graphqlResponse({ nodes: [retainedNode("node-10")] });
      return graphqlResponse({ nodes: [{ id: "node-11", state: "CLOSED" }] });
    }));
    const started = { ...item(10), state: "started" as const, threadId: "old-thread", updatedAt: "2026-01-01T00:00:00.000Z" };
    const dismissed = { ...item(11), state: "dismissed" as const, updatedAt: "2026-01-01T00:00:00.000Z" };
    const host = await setup([started, dismissed], "test-token");

    const result = await host.harness.behavior.callRpc("poll_now", null) as { ok: boolean; removed: number };

    expect(result).toMatchObject({ ok: true, removed: 1 });
    expect(searches).toHaveLength(2);
    expect(searches.every((search) => search.includes("updated:>=2026-09-15"))).toBe(true);
    expect(lookups).toHaveLength(2);
    expect(lookups[0]).toContain('nodes(ids: ["node-10"])');
    expect(lookups[1]).toContain('nodes(ids: ["node-11"])');
    expect((await host.bb.storage.kv.get<QueueItem[]>("queue")))
      .toEqual([started]);
  });

  it("preserves the queue when the retained PR state lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      if (query.includes("query Viewer")) return graphqlResponse({ viewer: { login: "reader-ada" } });
      if (query.includes("query WatchedPullRequests")) return graphqlResponse({ search: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      } });
      return new Response("rate limited", { status: 503 });
    }));
    const started = { ...item(12), state: "started" as const, threadId: "old-thread" };
    const host = await setup([started], "test-token");

    const result = await host.harness.behavior.callRpc("poll_now", null) as { ok: boolean; changed: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.error).toContain("503");
    expect(await host.bb.storage.kv.get<QueueItem[]>("queue")).toEqual([started]);
  });
});

describe("refresh after a review-watch thread becomes idle", () => {
  it("refreshes a started single or batch thread once, and ignores unrelated or repeated idle events", async () => {
    let release!: () => void;
    let entered!: () => void;
    const searchGate = new Promise<void>((resolve) => { release = resolve; });
    const searchStarted = new Promise<void>((resolve) => { entered = resolve; });
    let searches = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      if (query.includes("query Viewer")) return graphqlResponse({ viewer: { login: "reader-ada" } });
      if (query.includes("query WatchedPullRequests")) {
        searches += 1;
        entered();
        await searchGate;
        return graphqlResponse({ search: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        } });
      }
      const ids = JSON.parse(query.match(/nodes\(ids: (\[[^)]*\])\)/)?.[1] ?? "[]") as string[];
      return graphqlResponse({ nodes: ids.map((id) => retainedNode(id)) });
    }));
    const first = item(20);
    const second = item(21);
    const third = item(22);
    const host = await setup([first, second, third], "test-token");
    let spawned = 0;
    host.harness.sdk.stub("threads.spawn", async () => ({ id: `thread-${++spawned}` }));
    await host.harness.behavior.callRpc("item_start", { key: first.key });
    await host.harness.behavior.callRpc("item_batch_start", { keys: [second.key, third.key] });
    const idle = (id: string) => host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id }),
      lastAssistantText: null,
    });

    expect((await idle("unrelated-thread")).errors).toEqual([]);
    expect(searches).toBe(0);
    const singleIdle = idle("thread-1");
    await searchStarted;
    const batchIdle = idle("thread-2");
    release();
    expect((await singleIdle).errors).toEqual([]);
    expect((await batchIdle).errors).toEqual([]);
    expect(searches).toBe(2);
    expect((await host.bb.storage.kv.get<{ ok: boolean }>("last-poll"))?.ok).toBe(true);

    await idle("thread-2");
    expect(searches).toBe(2);
  });

  it("runs one trailing refresh when another watched thread idles during the cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
    let searches = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      if (query.includes("query Viewer")) return graphqlResponse({ viewer: { login: "reader-ada" } });
      if (query.includes("query WatchedPullRequests")) {
        searches += 1;
        return graphqlResponse({ search: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        } });
      }
      const ids = JSON.parse(query.match(/nodes\(ids: (\[[^)]*\])\)/)?.[1] ?? "[]") as string[];
      return graphqlResponse({ nodes: ids.map((id) => retainedNode(id)) });
    }));
    const first = { ...item(30), state: "started" as const, threadId: "thread-1" };
    const second = { ...item(31), state: "started" as const, threadId: "thread-2" };
    const host = await setup([first, second], "test-token");
    const idle = (id: string) => host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id }),
      lastAssistantText: null,
    });

    await idle("thread-1");
    expect(searches).toBe(2);
    await idle("thread-2");
    await idle("thread-2");
    await idle("unrelated-thread");
    expect(searches).toBe(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(searches).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(searches).toBe(4);
  });

  it("waits for an active poll before refreshing for a second thread that idles during it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
    let release!: () => void;
    let entered!: () => void;
    const firstSearchGate = new Promise<void>((resolve) => { release = resolve; });
    const firstSearchStarted = new Promise<void>((resolve) => { entered = resolve; });
    let searches = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      if (query.includes("query Viewer")) return graphqlResponse({ viewer: { login: "reader-ada" } });
      if (query.includes("query WatchedPullRequests")) {
        searches += 1;
        if (searches <= 2) {
          entered();
          await firstSearchGate;
        }
        return graphqlResponse({ search: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        } });
      }
      const ids = JSON.parse(query.match(/nodes\(ids: (\[[^)]*\])\)/)?.[1] ?? "[]") as string[];
      return graphqlResponse({ nodes: ids.map((id) => retainedNode(id)) });
    }));
    const first = { ...item(32), state: "started" as const, threadId: "thread-1" };
    const second = { ...item(33), state: "started" as const, threadId: "thread-2" };
    const host = await setup([first, second], "test-token");
    const idle = (id: string) => host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id }),
      lastAssistantText: null,
    });

    const firstIdle = idle("thread-1");
    await firstSearchStarted;
    await idle("thread-2");
    await idle("thread-2");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(searches).toBe(2);
    release();
    await firstIdle;
    await vi.waitFor(() => expect(searches).toBe(4));
  });
});

describe("batch review start", () => {
  it("previews an organization mapping without starting a thread", async () => {
    const first = { ...item(1), repo: "ParsleyHealth/sage" };
    const host = await setup([first], undefined, '{"parsleyhealth":"project-parsley"}');
    expect(await host.harness.behavior.callRpc("review_targets", { keys: [first.key] })).toEqual({
      projects: [{ id: "project-test", name: "Default" }, { id: "project-parsley", name: "Parsley" }],
      projectId: "project-parsley", reason: "organization",
    });
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
    await host.harness.behavior.callRpc("item_start", { key: first.key });
    expect(host.harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ projectId: "project-parsley" });
  });

  it("requires a choice for mixed projects, then honors an override and its machine", async () => {
    const first = { ...item(1), repo: "parsleyhealth/sage" }, second = item(2);
    const host = await setup([first, second], undefined, '{"parsleyhealth":"project-parsley"}');
    const keys = [first.key, second.key];
    expect(await host.harness.behavior.callRpc("review_targets", { keys })).toMatchObject({ projectId: null, reason: "mixed" });
    await expect(host.harness.behavior.callRpc("item_batch_start", { keys })).rejects.toThrow("Choose one project");
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(await host.bb.storage.kv.get("queue")).toEqual([first, second]);
    host.harness.sdk.stub("projects.get", async ({ projectId }) => ({
      id: projectId, sources: [{ isDefault: true, hostId: "parsley-host", path: "/home/dev/parsley" }],
    }));
    await host.harness.behavior.callRpc("item_batch_start", { keys, projectId: "project-parsley" });
    expect(host.harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: "project-parsley",
      environment: { type: "host", hostId: "parsley-host", workspace: { type: "unmanaged", path: "/home/dev/parsley" } },
    });
  });

  it("lets a single review override an organization mapping", async () => {
    const first = item(1);
    const host = await setup([first], undefined, '{"owner":"project-parsley"}');
    await host.harness.behavior.callRpc("item_start", { key: first.key, projectId: "project-test" });
    expect(host.harness.sdk.callsTo("projects.get")[0]?.[0]).toEqual({ projectId: "project-test" });
    expect(host.harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ projectId: "project-test" });
  });

  it("asks for a choice when a mapped project is unavailable", async () => {
    const first = item(1);
    const host = await setup([first], undefined, '{"owner":"project-deleted"}');
    expect(await host.harness.behavior.callRpc("review_targets", { keys: [first.key] })).toMatchObject({ projectId: null, reason: "choose" });
  });

  it("starts selected reviews on the default checkout's remote machine", async () => {
    const first = item(1);
    const second = item(2, "review-followup");
    const host = await setup([first, second]);

    const result = await host.harness.behavior.callRpc("item_batch_start", {
      keys: [first.key, second.key],
    }) as { threadId: string; items: QueueItem[] };

    expect(result.threadId).toBe("thread-1");
    expect(result.items.map((row) => row.state)).toEqual(["started", "started"]);
    const status = await host.harness.behavior.runCli(["status", "--json"]);
    expect(JSON.parse(status.stdout)).toMatchObject({
      queued: { "review-requested": 0, "review-followup": 0 },
      pending: { "review-requested": 1, "review-followup": 1 }, started: 2,
    });
    const calls = host.harness.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      projectId: "project-test",
      environment: {
        type: "host", hostId: "devbox-host",
        workspace: { type: "unmanaged", path: "/project-checkout" },
      },
    });
    const prompt = (calls[0]?.[0] as { prompt: string }).prompt;
    expect(prompt).toContain("owner/repo#1 (Fix review issue number 1)");
    expect(prompt).toContain("Full title: Fix review issue number 1");
    expect(prompt).toContain("Approval does not enforce the required changes");
    expect(prompt).toContain("dependencies between pull requests");
    expect(prompt).toContain("no local checkout");
    expect(prompt).toContain("`gh pr diff`");
    expect((await host.bb.storage.kv.get<QueueItem[]>("queue"))?.map((row) => row.threadId))
      .toEqual(["thread-1", "thread-1"]);
  });

  it("rejects duplicate, partial, dismissed, and started keys without spawning", async () => {
    const first = item(1);
    const dismissed = { ...item(2), state: "dismissed" as const };
    const started = { ...item(4), state: "started" as const, threadId: "prior-thread" };
    const host = await setup([first, dismissed, started]);
    for (const keys of [
      [first.key, first.key],
      [first.key.slice(0, 10)],
      [dismissed.key],
      [started.key],
    ]) {
      await expect(host.harness.behavior.callRpc("item_batch_start", { keys })).rejects.toThrow();
    }
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("serializes overlapping starts so one item spawns once", async () => {
    const first = item(1);
    const host = await setup([first]);
    let release!: () => void;
    let entered!: () => void;
    const spawned = new Promise<void>((resolve) => { entered = resolve; });
    host.harness.sdk.stub("threads.spawn", () => new Promise((resolve) => {
      release = () => resolve({ id: "thread-1" });
      entered();
    }));

    const firstStart = host.harness.behavior.callRpc("item_batch_start", { keys: [first.key] });
    const secondStart = host.harness.behavior.callRpc("item_batch_start", { keys: [first.key] });
    await spawned;
    release();

    await expect(firstStart).resolves.toMatchObject({ threadId: "thread-1" });
    await expect(secondStart).rejects.toThrow("already started");
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("adds a short PR summary and reviews through gh without a checkout", async () => {
    const followup = { ...item(4, "review-followup"), title: "Fix a long review issue in the payment workflow today" };
    const host = await setup([followup]);

    await host.harness.behavior.callRpc("item_start", { key: followup.key });

    const spawn = host.harness.sdk.callsTo("threads.spawn")[0]?.[0] as {
      title: string;
      prompt: string;
      environment: unknown;
    };
    expect(spawn.title).toBe("Review owner/repo#4 (Fix a long review issue in the payment)");
    expect(spawn.prompt).toContain(`Full title: ${followup.title}`);
    expect(spawn.prompt).toContain("`gh pr diff 4 -R owner/repo`");
    expect(spawn.prompt).toContain("If a matching local checkout exists");
    expect(spawn.environment).toEqual({
      type: "host", hostId: "devbox-host",
      workspace: { type: "unmanaged", path: "/project-checkout" },
    });
  });

  it("leaves reviews queued when the project has no default checkout", async () => {
    const first = item(3);
    const host = await setup([first]);
    host.harness.sdk.stub("projects.get", async () => ({ id: "project-test", sources: [] }));
    await expect(host.harness.behavior.callRpc("item_batch_start", { keys: [first.key] }))
      .rejects.toThrow("Choose a default project checkout");
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(await host.bb.storage.kv.get<QueueItem[]>("queue")).toEqual([first]);
  });

  it("uses gh as the source for an initial review", async () => {
    const first = item(5);
    const host = await setup([first]);

    await host.harness.behavior.callRpc("item_start", { key: first.key });

    const spawn = host.harness.sdk.callsTo("threads.spawn")[0]?.[0] as { prompt: string };
    expect(spawn.prompt).toContain("`gh pr diff 5 -R owner/repo`");
    expect(spawn.prompt).toContain("If a matching local checkout exists");
  });
});

describe("stored rows from the retired feedback-to-address rule", () => {
  // Earlier versions queued feedback on the viewer's own pull requests. That
  // now lives in Workstreams, so leftover rows must neither break the page nor
  // start a thread.
  function legacy(number: number, state: QueueItem["state"]): QueueItem {
    const row = { ...item(number), key: `feedback-to-address:node-${number}:sha-${number}`, state };
    return { ...row, rule: "feedback-to-address" } as unknown as QueueItem;
  }

  it("leaves them out of the queue and drops them at the next write", async () => {
    const review = item(40);
    const host = await setup([review, legacy(41, "queued"), { ...legacy(42, "started"), threadId: "old-thread" }]);

    const listed = await host.harness.behavior.callRpc("queue_list", null) as { items: QueueItem[] };
    expect(listed.items.map((row) => row.key)).toEqual([review.key]);
    await expect(host.harness.behavior.callRpc("item_start", { key: "feedback-to-address" }))
      .rejects.toThrow(/No queue item matches/);
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);

    await host.harness.behavior.callRpc("item_dismiss", { key: review.key });
    expect((await host.bb.storage.kv.get<QueueItem[]>("queue"))?.map((row) => row.key))
      .toEqual([review.key]);
  });
});
