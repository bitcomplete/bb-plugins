import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Target } from "./github.js";
import {
  compare,
  createCheckQueue,
  createWatchStore,
  diffSnapshots,
  expiresAt,
  flagsFor,
  formatWake,
  IDLE_AFTER_MS,
  initialCursors,
  newComments,
  NOISY_WAKES_PER_WINDOW,
  RATE_WINDOW_MS,
  RECENT_WAKES_KEPT,
  signature,
  snapshotOf,
  WAKE_COMMENT_CHARS,
  wakesInWindow,
  WATCH_LIMIT,
  WATCH_MIGRATIONS,
  WATCH_TTL_MS,
  type Usage,
  type WatchRow,
} from "./watch.js";

const pull = (over: Partial<Target> = {}, pullOver: Partial<NonNullable<Target["pull"]>> = {}): Target => ({
  kind: "pull",
  repo: "Acme/Widgets",
  number: 12,
  key: "Acme/Widgets#12",
  title: "Add widgets",
  url: "https://github.com/Acme/Widgets/pull/12",
  state: "open",
  author: "jane",
  assignees: ["jane"],
  labels: ["feature"],
  milestone: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-09T10:00:00Z",
  comments: [],
  pull: { base: "main", head: "feature/widgets", headSha: "0123456789abcdef", reviewDecision: "review required", requestedReviewers: ["carol"], reviews: [], checks: { state: "pending", failing: [] }, ...pullOver },
  ...over,
});

const comment = (body: string, createdAt: string, who = "bob", did = "commented") => ({ author: who, did, body, createdAt, url: `https://github.com/c/${createdAt}` });

const watchOf = (t: Target, threadId = "thr-1"): WatchRow => ({ threadId, projectId: "prj-1", key: t.key, kind: t.kind, snapshot: snapshotOf(t), ...initialCursors(t, "2026-10-09T12:00:00Z"), createdAt: 0, lastActivityAt: 0, checks: 0, wakes: 0, lastCheckedAt: 0, lastWokeAt: 0, recentWakes: [] });

describe("snapshots", () => {
  it("report each changed field with both values, in a fixed order", () => {
    const before = snapshotOf(pull());
    const after = snapshotOf(pull({ state: "merged", labels: ["feature", "shipped"] }, { headSha: "fedcba9876543210", reviewDecision: "approved", requestedReviewers: [], reviews: ["carol: approved"], checks: { state: "failure", failing: ["test (https://ci/test)"] } }));
    expect(diffSnapshots(before, after)).toEqual([
      { field: "state", label: "State", from: "open", to: "merged" },
      { field: "labels", label: "Labels", from: "feature", to: "feature, shipped" },
      { field: "head", label: "Head", from: "feature/widgets @ 0123456", to: "feature/widgets @ fedcba9" },
      { field: "reviewDecision", label: "Review decision", from: "review required", to: "approved" },
      { field: "requestedReviewers", label: "Review requested from", from: "carol", to: "(none)" },
      { field: "reviews", label: "Reviews", from: "(none)", to: "carol: approved" },
      { field: "checks", label: "Checks", from: "pending", to: "failure" },
      { field: "failingChecks", label: "Failing checks", from: "(none)", to: "test (https://ci/test)" },
    ]);
  });

  it("ignore list order, and carry no pull request fields for an issue", () => {
    expect(diffSnapshots(snapshotOf(pull({ labels: ["a", "b"] })), snapshotOf(pull({ labels: ["b", "a"] })))).toEqual([]);
    const issue = snapshotOf(pull({ kind: "issue", pull: null }));
    expect(issue).toMatchObject({ base: null, head: null, reviewDecision: null, requestedReviewers: [], reviews: [], checks: null, failingChecks: [] });
  });
});

describe("new comments", () => {
  it("are those after the cursor, oldest first, and the cursor moves to the newest", () => {
    const t = pull({ comments: [comment("old", "2026-10-09T09:00:00Z"), comment("new", "2026-10-09T11:00:00Z"), comment("newer", "2026-10-09T11:30:00Z", "carol", "approved")] });
    const { comments, cursor } = newComments(t, "2026-10-09T10:00:00Z", "thr-1");
    expect(comments.map((c) => [c.author, c.did, c.body])).toEqual([["bob", "commented", "new"], ["carol", "approved", "newer"]]);
    expect(cursor).toBe("2026-10-09T11:30:00Z");
  });

  it("skip the watching thread's own signed comments but count another thread's", () => {
    const t = pull({ comments: [comment(`PR updated\n\n${signature("thr-1")}`, "2026-10-09T11:00:00Z", "jane"), comment(`Done\n\n${signature("thr-2")}`, "2026-10-09T11:10:00Z", "jane"), comment("thanks", "2026-10-09T11:20:00Z")] });
    const { comments, cursor } = newComments(t, "2026-10-09T10:00:00Z", "thr-1");
    expect(comments.map((c) => c.body.split("\n")[0])).toEqual(["Done", "thanks"]);
    expect(cursor).toBe("2026-10-09T11:20:00Z");
    // The own comment moves the cursor even when it is the newest.
    expect(newComments(pull({ comments: [comment(`x${signature("thr-1")}`, "2026-10-09T13:00:00Z")] }), "2026-10-09T10:00:00Z", "thr-1")).toEqual({ comments: [], cursor: "2026-10-09T13:00:00Z" });
  });

  it("start a new watch at the newest existing comment so nothing old is news", () => {
    expect(initialCursors(pull({ comments: [comment("a", "2026-10-09T09:00:00Z"), comment("b", "2026-10-09T08:00:00Z")] }), "now")).toEqual({ updatedAt: "2026-10-09T10:00:00Z", lastCommentAt: "2026-10-09T09:00:00Z" });
    expect(initialCursors(pull({ updatedAt: null, createdAt: null }), "now")).toEqual({ updatedAt: "now", lastCommentAt: "now" });
    expect(initialCursors(pull(), "now").lastCommentAt).toBe("2026-10-01T00:00:00Z");
  });
});

describe("compare", () => {
  it("has nothing to say when nothing changed, and still moves the cursors", () => {
    const w = watchOf(pull());
    const out = compare(w, pull({ updatedAt: "2026-10-09T13:00:00Z", comments: [comment(`mine${signature("thr-1")}`, "2026-10-09T12:30:00Z")] }));
    expect(out.message).toBeNull();
    expect(out.updatedAt).toBe("2026-10-09T13:00:00Z");
    expect(out.lastCommentAt).toBe("2026-10-09T12:30:00Z");
  });

  it("writes one Markdown message with the target, the changes, and each new comment", () => {
    const w = watchOf(pull());
    const long = "x".repeat(WAKE_COMMENT_CHARS + 5);
    const out = compare(w, pull({ state: "merged", comments: [comment("Ship it", "2026-10-09T12:30:00Z", "carol", "approved"), comment(long, "2026-10-09T12:40:00Z"), comment("", "2026-10-09T12:50:00Z", "dan", "requested changes")] }, { checks: { state: "success", failing: [] } }));
    expect(out.message).toBe(
      [
        "GitHub pull request Acme/Widgets#12 changed: Add widgets",
        "https://github.com/Acme/Widgets/pull/12",
        "",
        "- State: open → merged",
        "- Checks: pending → success",
        "",
        "New comments (3):",
        "",
        "**carol** approved — 2026-10-09T12:30:00Z (https://github.com/c/2026-10-09T12:30:00Z)",
        "> Ship it",
        "",
        "**bob** commented — 2026-10-09T12:40:00Z (https://github.com/c/2026-10-09T12:40:00Z)",
        `> ${"x".repeat(WAKE_COMMENT_CHARS)}`,
        "> … (5 more characters)",
        "",
        "**dan** requested changes — 2026-10-09T12:50:00Z (https://github.com/c/2026-10-09T12:50:00Z)",
        "> (no text)",
      ].join("\n"),
    );
  });

  it("formats a change-only wake for an issue without a comments section", () => {
    const issue = pull({ kind: "issue", key: "Acme/Widgets#3", title: "Bug", url: null, pull: null });
    expect(formatWake(issue, [{ field: "state", label: "State", from: "open", to: "closed (completed)" }], [])).toBe("GitHub issue Acme/Widgets#3 changed: Bug\n\n- State: open → closed (completed)");
  });
});

describe("the store", () => {
  let db: Database.Database;
  let now = 1_000_000;
  beforeEach(() => {
    db = new Database(":memory:");
    for (const statement of WATCH_MIGRATIONS) db.exec(statement);
    now = 1_000_000;
  });
  afterEach(() => db.close());

  const row = (threadId: string, key: string) => ({ threadId, projectId: "prj", key, kind: "pull" as const, snapshot: snapshotOf(pull()), updatedAt: "u", lastCommentAt: "c" });

  it("caps a thread at the limit, treats a repeat as already watched, and keeps threads apart", () => {
    const store = createWatchStore(db, () => now);
    for (let i = 0; i < WATCH_LIMIT; i++) expect(store.add(row("thr-1", `a/b#${i}`))).toEqual({ outcome: "added" });
    expect(store.add(row("thr-1", "a/b#99"))).toEqual({ outcome: "full", limit: WATCH_LIMIT });
    now += 5;
    expect(store.add(row("thr-1", "a/b#0"))).toEqual({ outcome: "already" });
    expect(store.get("thr-1", "a/b#0")?.lastActivityAt).toBe(now);
    expect(store.add(row("thr-2", "a/b#0"))).toEqual({ outcome: "added" });
    expect(store.forKey("a/b#0").map((w) => w.threadId)).toEqual(["thr-1", "thr-2"]);
    expect(store.keys()).toHaveLength(WATCH_LIMIT);
    expect(store.removeThread("thr-1")).toBe(WATCH_LIMIT);
    expect(store.all().map((w) => [w.threadId, w.key, w.kind])).toEqual([["thr-2", "a/b#0", "pull"]]);
  });

  it("expires watches a week after their last activity, and a wake is activity", () => {
    const store = createWatchStore(db, () => now);
    store.add(row("thr-1", "a/b#1"));
    store.add(row("thr-1", "a/b#2"));
    now += WATCH_TTL_MS - 1000;
    store.advance("thr-1", "a/b#2", compare(store.get("thr-1", "a/b#2")!, pull({ state: "merged" })), true);
    store.advance("thr-1", "a/b#1", compare(store.get("thr-1", "a/b#1")!, pull({ updatedAt: "later" })), false);
    now += 2000;
    expect(store.expire()).toBe(1);
    expect(store.get("thr-1", "a/b#2")!.snapshot.state).toBe("merged");
    expect(store.get("thr-1", "a/b#1")).toBeNull();
  });

  it("treats a snapshot it cannot read as empty", () => {
    const store = createWatchStore(db, () => now);
    store.add(row("thr-1", "a/b#1"));
    db.prepare("UPDATE watches SET snapshot = '{\"old\": true}'").run();
    const w = store.get("thr-1", "a/b#1")!;
    expect(w.snapshot.state).toBeNull();
    expect(compare(w, pull()).message).toContain("- State: (none) → open");
  });
});

describe("usage", () => {
  let db: Database.Database;
  let now = 1_000_000;
  beforeEach(() => {
    db = new Database(":memory:");
    for (const statement of WATCH_MIGRATIONS) db.exec(statement);
    now = 1_000_000;
  });
  afterEach(() => db.close());

  it("counts checks and wakes, remembers when each last happened, and keeps the newest wake times", () => {
    const store = createWatchStore(db, () => now);
    store.add({ threadId: "thr-1", projectId: "prj", key: "a/b#1", kind: "pull", snapshot: snapshotOf(pull()), updatedAt: "u", lastCommentAt: "c" });
    const fresh = store.get("thr-1", "a/b#1")!;
    expect([fresh.checks, fresh.wakes, fresh.lastCheckedAt, fresh.lastWokeAt, fresh.recentWakes]).toEqual([0, 0, 0, 0, []]);

    now += 1000;
    store.advance("thr-1", "a/b#1", compare(fresh, pull({ updatedAt: "later" })), false);
    let w = store.get("thr-1", "a/b#1")!;
    expect([w.checks, w.wakes, w.lastCheckedAt, w.lastWokeAt, w.recentWakes]).toEqual([1, 0, now, 0, []]);
    expect(w.lastActivityAt).toBe(1_000_000);

    for (let i = 0; i < RECENT_WAKES_KEPT + 3; i++) {
      now += 1000;
      store.advance("thr-1", "a/b#1", compare(w, pull({ title: `T${i}` })), true);
      w = store.get("thr-1", "a/b#1")!;
    }
    expect([w.checks, w.wakes, w.lastCheckedAt, w.lastWokeAt, w.lastActivityAt]).toEqual([RECENT_WAKES_KEPT + 4, RECENT_WAKES_KEPT + 3, now, now, now]);
    expect(w.recentWakes).toHaveLength(RECENT_WAKES_KEPT);
    expect(w.recentWakes.at(-1)).toBe(now);
    expect(w.recentWakes[0]).toBe(now - (RECENT_WAKES_KEPT - 1) * 1000);
    expect(wakesInWindow(w, now, 10_500)).toBe(11);
  });

  const DAY = 86_400_000;
  const usage = (over: Partial<Usage> = {}): Usage => ({ checks: 0, wakes: 0, lastCheckedAt: 0, lastWokeAt: 0, recentWakes: [], createdAt: 0, lastActivityAt: 0, ...over });

  it("calls a watch idle once it is old and has not woken in as long", () => {
    const at = 10 * DAY;
    expect(flagsFor(usage({ createdAt: at - IDLE_AFTER_MS + 1, lastActivityAt: at }), at)).toEqual([]);
    expect(flagsFor(usage({ createdAt: at - IDLE_AFTER_MS, lastActivityAt: at }), at)).toEqual(["idle"]);
    expect(flagsFor(usage({ createdAt: 0, lastWokeAt: at - DAY, lastActivityAt: at - DAY }), at)).toEqual([]);
    expect(flagsFor(usage({ createdAt: 0, lastWokeAt: at - IDLE_AFTER_MS, lastActivityAt: at }), at)).toEqual(["idle"]);
  });

  it("calls a watch noisy at the wake rate, counting only the last hour", () => {
    const at = 10 * DAY;
    const recent = (n: number, spread: number) => Array.from({ length: n }, (_, i) => at - i * spread);
    const woke = (recentWakes: number[]) => usage({ recentWakes, lastWokeAt: at, lastActivityAt: at });
    expect(flagsFor(woke(recent(NOISY_WAKES_PER_WINDOW - 1, 1000)), at)).toEqual([]);
    expect(flagsFor(woke(recent(NOISY_WAKES_PER_WINDOW, 1000)), at)).toEqual(["noisy"]);
    expect(flagsFor(woke(recent(NOISY_WAKES_PER_WINDOW, RATE_WINDOW_MS / 2)), at)).toEqual([]);
  });

  it("says when a watch is about to be forgotten", () => {
    const at = 10 * DAY;
    expect(flagsFor(usage({ createdAt: at, lastActivityAt: at - WATCH_TTL_MS + DAY }), at)).toEqual([]);
    expect(flagsFor(usage({ createdAt: at, lastActivityAt: at - WATCH_TTL_MS + DAY - 1 }), at)).toEqual(["expiring"]);
    expect(expiresAt(usage({ lastActivityAt: 5 }))).toBe(5 + WATCH_TTL_MS);
  });
});

describe("the check queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces doorbells within the debounce into one check", async () => {
    const ran: string[] = [];
    const queue = createCheckQueue(async (id) => {
      ran.push(id);
    }, { debounceMs: 3000 });
    queue.ring("a");
    queue.ring("a");
    await vi.advanceTimersByTimeAsync(2000);
    queue.ring("a");
    queue.ring("b");
    expect(ran).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ran).toEqual(["a", "b"]);
  });

  it("never runs two checks of one key at once, and reports a failing check instead of dropping the chain", async () => {
    let running = 0;
    let peak = 0;
    const errors: string[] = [];
    const queue = createCheckQueue(
      async (id) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 100));
        running--;
        if (id === "bad") throw new Error("boom");
      },
      { debounceMs: 10, onError: (id, e) => errors.push(`${id}:${(e as Error).message}`) },
    );
    const sweep = queue.sweep(["a", "a", "bad"]);
    queue.ring("a");
    await vi.advanceTimersByTimeAsync(500);
    await sweep;
    expect(peak).toBe(2);
    expect(errors).toEqual(["bad:boom"]);
    queue.stop();
    queue.ring("a");
    await vi.advanceTimersByTimeAsync(500);
    expect(running).toBe(0);
  });
});
