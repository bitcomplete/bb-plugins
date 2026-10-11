import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "./linear.js";
import {
  compare,
  createCheckQueue,
  createWatchStore,
  diffSnapshots,
  formatWake,
  initialCursors,
  newComments,
  signature,
  snapshotOf,
  WAKE_COMMENT_CHARS,
  WATCH_LIMIT,
  WATCH_MIGRATIONS,
  WATCH_TTL_MS,
  type WatchRow,
} from "./watch.js";

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "uuid-1",
  identifier: "ENG-123",
  title: "Fix login",
  description: "Users cannot log in.",
  url: "https://linear.app/acme/issue/ENG-123",
  priority: 3,
  priorityLabel: "Medium",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-09T10:00:00.000Z",
  state: { name: "Todo", type: "unstarted" },
  team: { key: "ENG", name: "Engineering" },
  assignee: null,
  labels: { nodes: [{ name: "Bug" }] },
  comments: { nodes: [] },
  ...over,
});

const comment = (body: string, createdAt: string, who = "bob") => ({ body, createdAt, url: `https://linear.app/c/${createdAt}`, user: { displayName: who } });

const watchOf = (i: Issue, threadId = "thr-1"): WatchRow => ({
  threadId,
  projectId: "prj-1",
  issueId: i.id,
  issueKey: i.identifier,
  snapshot: snapshotOf(i),
  ...initialCursors(i, "2026-10-09T12:00:00.000Z"),
  createdAt: 0,
  lastActivityAt: 0,
});

describe("snapshots", () => {
  it("report each changed field with both values, in a fixed order", () => {
    const before = snapshotOf(issue());
    const after = snapshotOf(issue({ state: { name: "In Progress", type: "started" }, assignee: { displayName: "jane" }, priority: 1, priorityLabel: "Urgent", labels: { nodes: [{ name: "Bug" }, { name: "agent" }] }, title: "Fix login flow" }));
    expect(diffSnapshots(before, after).map((c) => `${c.label}: ${c.from} → ${c.to}`)).toEqual([
      "Title: Fix login → Fix login flow",
      "State: Todo → In Progress",
      "Assignee: (none) → jane",
      "Priority: Medium → Urgent",
      "Labels: Bug → Bug, agent",
    ]);
  });

  it("ignore label order and say only that the description changed", () => {
    const before = snapshotOf(issue({ labels: { nodes: [{ name: "a" }, { name: "b" }] } }));
    const same = snapshotOf(issue({ labels: { nodes: [{ name: "b" }, { name: "a" }] } }));
    expect(diffSnapshots(before, same)).toEqual([]);
    const edited = snapshotOf(issue({ labels: { nodes: [{ name: "a" }, { name: "b" }] }, description: "Users cannot log in on Safari." }));
    expect(diffSnapshots(before, edited)).toEqual([{ field: "descriptionHash", label: "Description", from: "", to: "edited" }]);
    expect(JSON.stringify(edited)).not.toContain("Safari");
  });
});

describe("new comments", () => {
  it("are those after the cursor, oldest first, and the cursor moves to the newest", () => {
    const i = issue({ comments: { nodes: [comment("third", "2026-10-09T13:00:00Z"), comment("first", "2026-10-09T11:00:00Z"), comment("second", "2026-10-09T12:30:00Z")] } });
    const { comments, cursor } = newComments(i, "2026-10-09T12:00:00.000Z", "thr-1");
    expect(comments.map((c) => c.body)).toEqual(["second", "third"]);
    expect(cursor).toBe("2026-10-09T13:00:00Z");
  });

  it("skip the watching thread's own signed comments but count another thread's", () => {
    const i = issue({
      comments: {
        nodes: [
          comment(`PR opened${signature("thr-1")}`, "2026-10-09T12:10:00Z", "jane"),
          comment(`Looking at it${signature("thr-2")}`, "2026-10-09T12:20:00Z", "jane"),
          comment("Thanks!", "2026-10-09T12:30:00Z", "bob"),
        ],
      },
    });
    const { comments, cursor } = newComments(i, "2026-10-09T12:00:00.000Z", "thr-1");
    expect(comments.map((c) => [c.author, c.body])).toEqual([
      ["jane", `Looking at it${signature("thr-2")}`],
      ["bob", "Thanks!"],
    ]);
    // The cursor passes the own comment too, so it is never looked at again.
    expect(cursor).toBe("2026-10-09T12:30:00Z");
    const own = issue({ comments: { nodes: [comment(`Only me${signature("thr-1")}`, "2026-10-09T12:10:00Z")] } });
    expect(newComments(own, "2026-10-09T12:00:00.000Z", "thr-1")).toEqual({ comments: [], cursor: "2026-10-09T12:10:00Z" });
  });

  it("start a new watch at the newest existing comment so nothing old is news", () => {
    const i = issue({ comments: { nodes: [comment("old", "2026-10-02T00:00:00Z"), comment("older", "2026-10-01T00:00:00Z")] } });
    expect(initialCursors(i, "now")).toEqual({ updatedAt: "2026-10-09T10:00:00.000Z", lastCommentAt: "2026-10-02T00:00:00Z" });
    expect(initialCursors(issue({ updatedAt: null, createdAt: null }), "now")).toEqual({ updatedAt: "now", lastCommentAt: "now" });
  });
});

describe("compare", () => {
  it("has nothing to say when nothing changed, and still moves the cursors", () => {
    const w = watchOf(issue());
    const later = issue({ updatedAt: "2026-10-09T11:00:00.000Z", comments: { nodes: [comment(`mine${signature("thr-1")}`, "2026-10-09T12:05:00Z")] } });
    const out = compare(w, later);
    expect(out.message).toBeNull();
    expect(out.updatedAt).toBe("2026-10-09T11:00:00.000Z");
    expect(out.lastCommentAt).toBe("2026-10-09T12:05:00Z");
  });

  it("writes one Markdown message with the issue, the changes, and each new comment", () => {
    const w = watchOf(issue());
    const long = "x".repeat(WAKE_COMMENT_CHARS + 50);
    const now = issue({ state: { name: "Done", type: "completed" }, comments: { nodes: [comment("Shipped in 1.2\nThanks", "2026-10-09T12:30:00Z", "bob"), comment(long, "2026-10-09T12:40:00Z", "eve")] } });
    const out = compare(w, now);
    expect(out.message).toBe(
      [
        "Linear issue ENG-123 changed: Fix login",
        "https://linear.app/acme/issue/ENG-123",
        "",
        "- State: Todo → Done",
        "",
        "New comments (2):",
        "",
        "**bob** — 2026-10-09T12:30:00Z (https://linear.app/c/2026-10-09T12:30:00Z)",
        "> Shipped in 1.2",
        "> Thanks",
        "",
        "**eve** — 2026-10-09T12:40:00Z (https://linear.app/c/2026-10-09T12:40:00Z)",
        `> ${"x".repeat(WAKE_COMMENT_CHARS)}`,
        "> … (50 more characters)",
      ].join("\n"),
    );
    expect(out.snapshot.state).toBe("Done");
  });

  it("formats a change-only wake without a comments section", () => {
    expect(formatWake({ identifier: "ENG-1", title: null, url: null }, [{ field: "state", label: "State", from: "Todo", to: "Done" }], [])).toBe("Linear issue ENG-1 changed: (untitled)\n\n- State: Todo → Done");
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

  const row = (threadId: string, issueId: string) => ({ threadId, projectId: "prj", issueId, issueKey: issueId.toUpperCase(), snapshot: snapshotOf(issue()), updatedAt: "u", lastCommentAt: "c" });

  it("caps a thread at the limit, treats a repeat as already watched, and keeps threads apart", () => {
    const store = createWatchStore(db, () => now);
    for (let i = 0; i < WATCH_LIMIT; i++) expect(store.add(row("thr-1", `i-${i}`))).toEqual({ outcome: "added" });
    expect(store.add(row("thr-1", "i-extra"))).toEqual({ outcome: "full", limit: WATCH_LIMIT });
    now += 5;
    expect(store.add(row("thr-1", "i-0"))).toEqual({ outcome: "already" });
    expect(store.get("thr-1", "i-0")?.lastActivityAt).toBe(now);
    expect(store.add(row("thr-2", "i-0"))).toEqual({ outcome: "added" });
    expect(store.forIssue("i-0").map((w) => w.threadId)).toEqual(["thr-1", "thr-2"]);
    expect(store.issueIds()).toHaveLength(WATCH_LIMIT);
    expect(store.removeThread("thr-1")).toBe(WATCH_LIMIT);
    expect(store.all().map((w) => [w.threadId, w.issueId])).toEqual([["thr-2", "i-0"]]);
  });

  it("expires watches a week after their last activity, and a wake is activity", () => {
    const store = createWatchStore(db, () => now);
    store.add(row("thr-1", "i-a"));
    store.add(row("thr-1", "i-b"));
    now += WATCH_TTL_MS - 1000;
    const outcome = compare(store.get("thr-1", "i-b")!, issue({ state: { name: "Done", type: "completed" } }));
    store.advance("thr-1", "i-b", outcome, true);
    store.advance("thr-1", "i-a", compare(store.get("thr-1", "i-a")!, issue({ updatedAt: "later" })), false);
    now += 2000;
    expect(store.expire()).toBe(1);
    const kept = store.get("thr-1", "i-b")!;
    expect(kept.snapshot.state).toBe("Done");
    expect(store.get("thr-1", "i-a")).toBeNull();
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

  it("never runs two checks of one issue at once, and reports a failing check instead of dropping the chain", async () => {
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
    expect(peak).toBe(2); // a and bad in parallel; the second a waited
    expect(errors).toEqual(["bad:boom"]);
    queue.stop();
    queue.ring("a");
    await vi.advanceTimersByTimeAsync(500);
    expect(running).toBe(0);
  });
});
