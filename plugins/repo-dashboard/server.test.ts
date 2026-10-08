import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";

afterEach(() => vi.useRealTimers());

describe("repo dashboard activity cache", () => {
  it("reads cached snapshots before full activity without calling the host", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    let hostCalls = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "repo-dashboard",
      sdk: { system: { config: async () => { hostCalls++; throw new Error("Host unavailable"); } } },
      experimental_callHostRpc: () => { hostCalls++; throw new Error("Host unavailable"); },
    });
    await plugin(bb);
    const db = bb.storage.database();
    const input = { org: "parsleyhealth", week: "2026-09-28" } as const;
    const key = `${input.org}:${input.week}`;
    const inProgress = [{ login: "alice", repo: "parsleyhealth/repo", number: 1, title: "Open PR",
      url: "https://github.com/parsleyhealth/repo/pull/1", createdAt: "2026-09-29T12:00:00Z", isDraft: false }];
    const activity = { ok: true, ...input, fetchedAt: "2026-10-01T12:00:00Z", events: [], inProgress };
    const snapshot = { ok: true, ...input, fetchedAt: "2026-10-02T12:00:00Z", inProgress };
    db.prepare("INSERT INTO activity_cache_v1 (key, expires_at, result) VALUES (?, ?, ?)")
      .run(key, Date.now() + 60_000, JSON.stringify(activity));

    expect(await harness.callRpc("in_progress_cached", input)).toEqual({
      ...snapshot, fetchedAt: activity.fetchedAt,
    });
    db.prepare("INSERT INTO in_progress_cache_v1 (key, expires_at, result) VALUES (?, ?, ?)")
      .run(key, Date.now() + 60_000, JSON.stringify(snapshot));
    expect(await harness.callRpc("in_progress_cached", input)).toEqual(snapshot);
    expect(hostCalls).toBe(0);
    await harness.lifecycle.dispose();
  });

  it("returns null for absent, invalid, expired, or mismatched in-progress cache entries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    let hostCalls = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "repo-dashboard",
      sdk: { system: { config: async () => { hostCalls++; throw new Error("Host unavailable"); } } },
      experimental_callHostRpc: () => { hostCalls++; throw new Error("Host unavailable"); },
    });
    await plugin(bb);
    const db = bb.storage.database();
    const input = { org: "parsleyhealth", week: "2026-09-28" } as const;
    const key = `${input.org}:${input.week}`;
    const snapshot = { ok: true, ...input, fetchedAt: "2026-10-01T12:00:00Z", inProgress: [] };
    const write = (table: string, expiresAt: number, result: string) => db.prepare(
      `INSERT INTO ${table} (key, expires_at, result) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at, result = excluded.result`,
    ).run(key, expiresAt, result);

    expect(await harness.callRpc("in_progress_cached", input)).toBeNull();
    expect(await harness.callRpc("in_progress_cached", { ...input, week: "2026-09-29" })).toBeNull();
    expect(await harness.callRpc("in_progress_cached", { ...input, week: "2026-10-12" })).toBeNull();
    for (const table of ["in_progress_cache_v1", "activity_cache_v1"]) {
      write(table, Date.now() + 60_000, "{");
      expect(await harness.callRpc("in_progress_cached", input)).toBeNull();
      write(table, Date.now() + 60_000, JSON.stringify({ ...snapshot, org: "bitcomplete" }));
      expect(await harness.callRpc("in_progress_cached", input)).toBeNull();
      write(table, Date.now() - 1, JSON.stringify(table === "activity_cache_v1"
        ? { ...snapshot, events: [] } : snapshot));
      expect(await harness.callRpc("in_progress_cached", input)).toBeNull();
    }
    expect(hostCalls).toBe(0);
    await harness.lifecycle.dispose();
  });


  it("reads only matching, unexpired activity cache entries without calling the host", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    let hostCalls = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "repo-dashboard",
      sdk: { system: { config: async () => ({ primaryHostId: "host-github" }) as never } },
      experimental_callHostRpc: ({ input }) => {
        hostCalls++;
        const { org, week } = input as { org: string; week: string };
        return { ok: true, org, week, fetchedAt: new Date().toISOString(), events: [], inProgress: [] };
      },
    });
    await plugin(bb);
    const input = { org: "parsleyhealth", week: "2026-09-28" } as const;
    expect(await harness.callRpc("activity_cached", input)).toBeNull();
    expect(await harness.callRpc("activity_cached", { ...input, week: "2026-09-29" })).toBeNull();
    expect(hostCalls).toBe(0);

    const saved = await harness.callRpc("activity_get", { ...input, refresh: false });
    expect(hostCalls).toBe(1);
    expect(await harness.callRpc("activity_cached", input)).toEqual(saved);
    expect(await harness.callRpc("activity_cached", { ...input, org: "bitcomplete" })).toBeNull();
    expect(hostCalls).toBe(1);

    const db = bb.storage.database();
    const key = `${input.org}:${input.week}`;
    db.prepare("UPDATE activity_cache_v1 SET result = ? WHERE key = ?").run("{", key);
    expect(await harness.callRpc("activity_cached", input)).toBeNull();
    db.prepare("UPDATE activity_cache_v1 SET result = ? WHERE key = ?")
      .run(JSON.stringify({ ok: true, org: "bitcomplete", week: input.week,
        fetchedAt: new Date().toISOString(), events: [], inProgress: [] }), key);
    expect(await harness.callRpc("activity_cached", input)).toBeNull();
    db.prepare("UPDATE activity_cache_v1 SET expires_at = ?, result = ? WHERE key = ?")
      .run(Date.now() - 1, JSON.stringify(saved), key);
    expect(await harness.callRpc("activity_cached", input)).toBeNull();
    expect(hostCalls).toBe(1);
    await harness.lifecycle.dispose();
  });
  it("reuses full activity, then caches and refreshes a prior-week snapshot without rerunning activity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    const calls: string[] = [];
    let fail = false;
    const { bb, harness } = createFakePluginHost({
      pluginId: "repo-dashboard",
      sdk: { system: { config: async () => ({ primaryHostId: "host-github" }) as never } },
      experimental_callHostRpc: ({ method, input }) => {
        calls.push(method);
        if (fail) return { ok: false, error: "GitHub unavailable" };
        const { org, week } = input as { org: string; week: string };
        const base = { ok: true, org, week, fetchedAt: new Date().toISOString(), inProgress: [{
          login: "alice", repo: `${org}/repo`, number: calls.length, title: "Open PR",
          url: `https://github.com/${org}/repo/pull/${calls.length}`, createdAt: "2026-09-29T12:00:00Z", isDraft: false,
        }] };
        return method === "activity" ? { ...base, events: [] } : base;
      },
    });
    await plugin(bb);
    const prior = { org: "parsleyhealth", week: "2026-09-28", refresh: false };
    await harness.callRpc("activity_get", prior);
    expect(await harness.callRpc("in_progress_get", prior)).toMatchObject({ ok: true });
    expect(calls).toEqual(["activity"]);

    const next = { org: "bitcomplete", week: prior.week, refresh: false };
    const firstSnapshot = await harness.callRpc("in_progress_get", next);
    expect(await harness.callRpc("in_progress_get", next)).toEqual(firstSnapshot);
    expect(calls).toEqual(["activity", "in_progress"]);
    const reloaded = await harness.lifecycle.reload(plugin);
    expect(await reloaded.harness.callRpc("in_progress_get", next)).toEqual(firstSnapshot);
    expect(calls).toHaveLength(2);

    fail = true;
    expect(await reloaded.harness.callRpc("in_progress_get", { ...next, refresh: true })).toMatchObject({ ok: false });
    expect(await reloaded.harness.callRpc("in_progress_get", next)).toEqual(firstSnapshot);
    fail = false;
    expect(calls).toHaveLength(3);
    const refreshed = await reloaded.harness.callRpc("in_progress_get", { ...next, refresh: true });
    expect(refreshed).not.toEqual(firstSnapshot);
    expect(await reloaded.harness.callRpc("in_progress_get", next)).toEqual(refreshed);
    expect(calls).toHaveLength(4);
    vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
    await reloaded.harness.callRpc("in_progress_get", next);
    expect(calls).toHaveLength(5);
    await reloaded.harness.lifecycle.dispose();
  });
  it("fetches GitHub when a persisted cache entry contains malformed JSON", async () => {
    let fetchCount = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "repo-dashboard",
      sdk: { system: { config: async () => ({ primaryHostId: "host-github" }) as never } },
      experimental_callHostRpc: ({ input }) => {
        fetchCount++;
        const { org, week } = input as { org: string; week: string };
        return { ok: true, org, week, fetchedAt: new Date().toISOString(), events: [], inProgress: [] };
      },
    });
    await plugin(bb);
    const input = { org: "parsleyhealth", week: "2026-09-28", refresh: false };
    bb.storage.database().prepare("INSERT INTO activity_cache_v1 (key, expires_at, result) VALUES (?, ?, ?)")
      .run(`${input.org}:${input.week}`, Date.now() + 60_000, "{");

    expect(await harness.callRpc("activity_get", input)).toMatchObject({ ok: true });
    expect(await harness.callRpc("activity_get", input)).toMatchObject({ ok: true });
    expect(fetchCount).toBe(1);
    await harness.lifecycle.dispose();
  });

  it("persists completed weeks through reload, expires them, and refreshes only on success", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    let fetchCount = 0;
    let fail = false;
    const { bb, harness } = createFakePluginHost({
      pluginId: "repo-dashboard",
      sdk: { system: { config: async () => ({ primaryHostId: "host-github" }) as never } },
      experimental_callHostRpc: ({ method, input }) => {
        expect(method).toBe("activity");
        fetchCount++;
        if (fail) return { ok: false, error: "GitHub unavailable" };
        const { org, week } = input as { org: string; week: string };
        return { ok: true, org, week, fetchedAt: new Date().toISOString(), events: [], inProgress: [] };
      },
    });
    await plugin(bb);

    const input = { org: "parsleyhealth", week: "2026-09-28", refresh: false };
    const first = await harness.callRpc("activity_get", input);
    expect(await harness.callRpc("activity_get", input)).toEqual(first);
    expect(fetchCount).toBe(1);

    const reloaded = await harness.lifecycle.reload(plugin);
    expect(await reloaded.harness.callRpc("activity_get", input)).toEqual(first);
    expect(fetchCount).toBe(1);

    fail = true;
    expect(await reloaded.harness.callRpc("activity_get", { ...input, refresh: true })).toMatchObject({ ok: false });
    expect(await reloaded.harness.callRpc("activity_get", input)).toEqual(first);
    fail = false;
    expect(fetchCount).toBe(2);

    vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
    await reloaded.harness.callRpc("activity_get", input);
    expect(fetchCount).toBe(3);
    await reloaded.harness.callRpc("activity_get", { org: "bitcomplete", week: input.week, refresh: false });
    expect(fetchCount).toBe(4);
    await reloaded.harness.lifecycle.dispose();
  });

  it("expires a current-week snapshot at the Eastern Time week boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T23:00:00Z"));
    let fetchCount = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "repo-dashboard",
      sdk: { system: { config: async () => ({ primaryHostId: "host-github" }) as never } },
      experimental_callHostRpc: ({ input }) => {
        fetchCount++;
        const { org, week } = input as { org: string; week: string };
        return { ok: true, org, week, fetchedAt: new Date().toISOString(), events: [], inProgress: [] };
      },
    });
    await plugin(bb);
    const input = { org: "parsleyhealth", week: "2026-10-05", refresh: false };
    await harness.callRpc("activity_get", input);
    vi.setSystemTime(new Date("2026-10-12T04:00:00Z"));
    await harness.callRpc("activity_get", input);
    expect(fetchCount).toBe(2);
    await harness.lifecycle.dispose();
  });
});
