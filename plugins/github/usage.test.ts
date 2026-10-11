import { describe, expect, it } from "vitest";
import type { HooksStatus } from "./hooks-client.js";
import { buildUsage, describeHooks, formatUsage, orderWatches, type WatchView } from "./usage.js";
import { IDLE_AFTER_MS, NEAR_LIMIT_AT, WATCH_LIMIT, WATCH_TTL_MS, type WatchRow } from "./watch.js";

const DAY = 86_400_000;
const NOW = 100 * DAY;

const hooks = (over: Partial<HooksStatus> = {}): HooksStatus => ({
  state: "connected",
  since: NOW - 3 * 60_000,
  leased: true,
  leasedUntil: NOW + 30 * 60_000,
  windowMs: 60 * 60_000,
  doorbells: 4,
  lastDoorbellAt: NOW - 60_000,
  sweeps: 6,
  lastSweepAt: NOW - 5 * 60_000,
  lastSweepReason: "baseline",
  ...over,
});

const row = (threadId: string, key: string, over: Partial<WatchRow> = {}): WatchRow => ({
  threadId,
  projectId: "prj",
  key,
  kind: "pull",
  // Only title and state are read here; the rest of the snapshot is the diff's business.
  snapshot: { title: `About ${key}`, state: "Todo" } as unknown as WatchRow["snapshot"],
  updatedAt: "u",
  lastCommentAt: "c",
  createdAt: NOW - DAY,
  lastActivityAt: NOW - DAY,
  checks: 10,
  wakes: 1,
  lastCheckedAt: NOW - 60_000,
  lastWokeAt: NOW - DAY,
  recentWakes: [],
  ...over,
});

const target = (r: WatchRow) => ({ id: r.key, key: r.key, kind: r.kind, title: r.snapshot.title, url: `https://github.test/acme/pull/${r.key}` });

describe("buildUsage", () => {
  it("puts flagged watches first, noisy before idle before expiring, then the busiest, and sums per thread", () => {
    const rows = [
      row("thr-1", "ENG-1"),
      row("thr-1", "ENG-2", { wakes: 7, checks: 50 }),
      row("thr-2", "ENG-3", { createdAt: NOW - 5 * DAY, lastWokeAt: 0, lastActivityAt: NOW - 5 * DAY }),
      row("thr-2", "ENG-4", { recentWakes: [NOW - 1000, NOW - 2000, NOW - 3000, NOW - 4000, NOW - 5000], wakes: 5 }),
      row("thr-3", "ENG-5", { createdAt: NOW, lastActivityAt: NOW - WATCH_TTL_MS + 3600_000 }),
    ];
    const view = buildUsage({ rows, hooks: hooks(), configured: true, now: NOW, titles: new Map([["thr-1", "Fix login"], ["thr-2", null]]), target });
    expect(view.watches.map((w) => [w.target.key, w.flags])).toEqual([
      ["ENG-4", ["noisy"]],
      ["ENG-3", ["idle"]],
      ["ENG-5", ["expiring"]],
      ["ENG-2", []],
      ["ENG-1", []],
    ]);
    expect(view.watches[0]!).toMatchObject({ threadId: "thr-2", threadTitle: null, wakesInWindow: 5, state: "Todo", expiresAt: NOW - DAY + WATCH_TTL_MS, target: { key: "ENG-4", url: "https://github.test/acme/pull/ENG-4" } });
    expect(view.watches[3]!.threadTitle).toBe("Fix login");
    expect(view.threads).toEqual([
      { threadId: "thr-1", title: "Fix login", count: 2, wakes: 8, nearLimit: false },
      { threadId: "thr-2", title: null, count: 2, wakes: 6, nearLimit: false },
      { threadId: "thr-3", title: null, count: 1, wakes: 1, nearLimit: false },
    ]);
    expect(view).toMatchObject({ now: NOW, limit: WATCH_LIMIT, ttlMs: WATCH_TTL_MS, hooks: { configured: true, state: "connected", doorbells: 4 } });
  });

  it("marks a thread near its limit", () => {
    const rows = Array.from({ length: NEAR_LIMIT_AT }, (_, i) => row("thr-1", `ENG-${i}`));
    const view = buildUsage({ rows, hooks: hooks(), configured: true, now: NOW, titles: new Map(), target });
    expect(view.threads).toEqual([{ threadId: "thr-1", title: null, count: NEAR_LIMIT_AT, wakes: NEAR_LIMIT_AT, nearLimit: true }]);
  });

  it("orders by wakes in the window, then total wakes, checks and age among the unflagged", () => {
    const base = { threadId: "t", threadTitle: null, projectId: "p", target: { id: "", key: "", kind: "pull", title: null, url: null }, state: null, createdAt: 0, lastActivityAt: NOW, expiresAt: NOW + DAY, lastCheckedAt: 0, lastWokeAt: 0, checks: 0, wakes: 0, wakesInWindow: 0, flags: [] as WatchView["flags"] };
    const views: WatchView[] = [
      { ...base, target: { ...base.target, key: "old" }, createdAt: 1 },
      { ...base, target: { ...base.target, key: "new" }, createdAt: 2 },
      { ...base, target: { ...base.target, key: "checked" }, checks: 3 },
      { ...base, target: { ...base.target, key: "woken" }, wakes: 1 },
      { ...base, target: { ...base.target, key: "recent" }, wakesInWindow: 1 },
    ];
    expect(orderWatches(views).map((v) => v.target.key)).toEqual(["recent", "woken", "checked", "old", "new"]);
  });
});

describe("text", () => {
  it("describes the stream in each state", () => {
    expect(describeHooks({ configured: false, ...hooks() }, NOW)).toContain("BB_HOOKS_URL");
    expect(describeHooks({ configured: true, ...hooks() }, NOW)).toBe("Doorbells: connected and leased for 3m; 4 doorbells and 6 sweeps in the last 60 min; last sweep 5m (baseline).");
    expect(describeHooks({ configured: true, ...hooks({ leased: false }) }, NOW)).toContain("leases pending");
    expect(describeHooks({ configured: true, ...hooks({ state: "connecting", sweeps: 1, lastSweepAt: 0, lastSweepReason: null }) }, NOW)).toBe("Doorbells: reconnecting (checks fall back to a slow sweep) for 3m; 4 doorbells and 1 sweep in the last 60 min; last sweep never.");
    expect(describeHooks({ configured: true, ...hooks({ state: "stopped" }) }, NOW)).toContain("stopped");
  });

  it("formats the view as a table with the stream line first, and says when there is nothing", () => {
    const empty = buildUsage({ rows: [], hooks: hooks(), configured: true, now: NOW, titles: new Map(), target });
    expect(formatUsage(empty).split("\n")).toEqual([describeHooks(empty.hooks, NOW), "No watches."]);

    const rows = [row("thr-1", "ENG-1", { recentWakes: [NOW - 1000] }), row("thr-2", "ENG-22", { createdAt: NOW - IDLE_AFTER_MS, lastWokeAt: 0, lastActivityAt: NOW - IDLE_AFTER_MS })];
    const text = formatUsage(buildUsage({ rows, hooks: hooks(), configured: true, now: NOW, titles: new Map([["thr-1", "Fix login"]]), target }));
    const lines = text.split("\n");
    expect(lines[1]).toBe("2 watches across 2 threads (limit 10 per thread; a watch idle for 7 days is forgotten).");
    expect(lines.slice(3)).toEqual([
      "TARGET  THREAD     AGE  CHECKS  WAKES    LAST WOKE  EXPIRES  FLAGS",
      "ENG-22  thr-2      3d   10      1        never      in 4d    idle",
      "ENG-1   Fix login  24h  10      1 (1/h)  24h        in 6d",
    ]);
  });

  it("names threads near the limit", () => {
    const rows = Array.from({ length: NEAR_LIMIT_AT }, (_, i) => row("thr-1", `ENG-${i}`));
    expect(formatUsage(buildUsage({ rows, hooks: hooks(), configured: true, now: NOW, titles: new Map([["thr-1", "Epic"]]), target }))).toContain(`Near limit: thread Epic watches ${NEAR_LIMIT_AT} of ${WATCH_LIMIT}.`);
  });
});
