import { describe, expect, it } from "vitest";
import {
  EVENT_READ,
  startedForOf,
  linkThread,
  pathsFromEvents,
  refreshWorkedPaths,
  threadCoverage,
  ticketsIn,
  withinPath,
  type LinkTarget,
  type ThreadFacts,
  type ThreadTier,
} from "./threads.js";

const PATTERN = /([A-Za-z]{2,5})-(\d{1,6})/;

const TARGETS: LinkTarget[] = [
  { cluster: "ABC-101", path: "/p/folio-abc-101", branch: "dev/abc-101-gift-cards", defaultBranch: "main" },
  { cluster: "ABC-101", path: "/p/margin-abc-101", branch: "dev/abc-101-ui", defaultBranch: "main" },
  { cluster: "OPS-2222", path: "/p/wt/spine-ops-2222", branch: "ops-2222", defaultBranch: "main" },
  { cluster: "folio", path: "/p/folio", branch: "main", defaultBranch: "main" },
];

function thread(overrides: Partial<ThreadFacts> = {}): ThreadFacts {
  return {
    id: "thr_1",
    title: null,
    titleFallback: null,
    status: "idle",
    environmentBranchName: null,
    environmentPath: "/p",
    updatedAt: 1,
    workedPaths: [],
    startedFor: null,
    ...overrides,
  };
}

const links = (facts: ThreadFacts) => Object.fromEntries(linkThread(facts, TARGETS, PATTERN));

describe("linkThread tiers", () => {
  it("tier 1: links a thread whose environment IS a checkout, by path", () => {
    expect(links(thread({ environmentPath: "/p/wt/spine-ops-2222/" }))).toEqual({ "OPS-2222": "environment" });
  });

  it("tier 1: links a thread whose environment branch IS a checkout's branch", () => {
    expect(links(thread({ environmentBranchName: "dev/abc-101-ui" }))).toEqual({ "ABC-101": "environment" });
  });

  it("does not link on a shared branch like main, because every checkout of a repo has one and it says nothing about the ticket", () => {
    expect(links(thread({ environmentBranchName: "main" }))).toEqual({});
  });

  it("does not link a branch reused by different clusters, because the thread's repository is unknown", () => {
    const targets: LinkTarget[] = [
      { cluster: "ABC-101", path: "/p/service-a", branch: "feature/auth", defaultBranch: "main" },
      { cluster: "OPS-2222", path: "/p/service-b", branch: "feature/auth", defaultBranch: "main" },
    ];
    expect(Object.fromEntries(linkThread(thread({ environmentBranchName: "feature/auth" }), targets, PATTERN))).toEqual({});
    expect(Object.fromEntries(linkThread(thread({ environmentPath: "/p/service-a", environmentBranchName: "feature/auth" }), targets, PATTERN)))
      .toEqual({ "ABC-101": "environment" });
  });

  it("uses a known checkout path to constrain branch matching to that checkout", () => {
    const targets: LinkTarget[] = [
      { cluster: "ABC-101", path: "/p/service-a", branch: "feature/a", defaultBranch: "main" },
      { cluster: "OPS-2222", path: "/p/service-b", branch: "feature/b", defaultBranch: "main" },
    ];
    expect(Object.fromEntries(linkThread(thread({ environmentPath: "/p/service-a", environmentBranchName: "feature/b" }), targets, PATTERN)))
      .toEqual({ "ABC-101": "environment" });
  });

  it("tier 2: links a ticket named in the title or the first-prompt fallback, uppercased", () => {
    expect(links(thread({ title: "Tidy abc-101 author bios" }))).toEqual({ "ABC-101": "ticket" });
    expect(links(thread({ titleFallback: "look at OPS-2222 please" }))).toEqual({ "OPS-2222": "ticket" });
  });

  it("tier 2 ignores a ticket that is not a cluster on this board, rather than linking it to nothing", () => {
    expect(links(thread({ title: "OPS-12 rotate keys" }))).toEqual({});
  });

  it("tier 3: links a checkout the thread worked inside, from its recent paths", () => {
    expect(links(thread({ workedPaths: ["/p/folio-abc-101/internal/giftcard.go"] }))).toEqual({ "ABC-101": "paths" });
  });

  it("tier 3 respects path boundaries: /p/folio is not inside /p/folio-abc-101, nor the other way round", () => {
    expect(links(thread({ workedPaths: ["/p/folio/README.md"] }))).toEqual({ "folio": "paths" });
    expect(withinPath("/p/folio-abc-101/x", "/p/folio")).toBe(false);
  });

  it("links a thread matching no tier to nothing at all — no fuzzy fallback", () => {
    expect(links(thread({ title: "Brainstorm onboarding copy", workedPaths: ["/Users/me/notes"] }))).toEqual({});
  });

  it("records the STRONGEST tier when several rules reach the same cluster", () => {
    const facts = thread({
      environmentBranchName: "dev/abc-101-gift-cards",
      title: "ABC-101",
      workedPaths: ["/p/folio-abc-101"],
    });
    expect(links(facts)).toEqual({ "ABC-101": "environment" });
  });

  it("lets one thread link to several clusters, each through its own tier", () => {
    const facts = thread({ title: "OPS-2222 follow-up", workedPaths: ["/p/folio-abc-101/go.mod"] });
    expect(links(facts)).toEqual({ "OPS-2222": "ticket", "ABC-101": "paths" });
  });

  it("finds every ticket in a title once, in order", () => {
    expect(ticketsIn("abc-101 and OPS-2222, then ABC-101 again", PATTERN)).toEqual(["ABC-101", "OPS-2222"]);
  });
});

describe("the started-here tier", () => {
  it("links a thread started from the Board for a cluster as `started`, beating the environment, ticket and path tiers that also reach it", () => {
    const facts = thread({
      startedFor: "ABC-101",
      environmentPath: "/p/folio-abc-101",
      environmentBranchName: "dev/abc-101-gift-cards",
      title: "ABC-101 follow-up",
      workedPaths: ["/p/margin-abc-101/src/app.tsx"],
    });
    expect(links(facts)).toEqual({ "ABC-101": "started" });
  });

  it("links on the metadata alone, so a new thread shows on the board before it has run anything", () => {
    expect(links(thread({ startedFor: "OPS-2222" }))).toEqual({ "OPS-2222": "started" });
  });

  it("ignores metadata naming a cluster that is not on the board, rather than linking it to nothing", () => {
    expect(links(thread({ startedFor: "WEB-77" }))).toEqual({});
  });

  it("keeps the inferred tiers for OTHER clusters the same thread reaches", () => {
    expect(links(thread({ startedFor: "ABC-101", title: "OPS-2222 too" }))).toEqual({ "ABC-101": "started", "OPS-2222": "ticket" });
  });

  it("reads only a well-formed ticket out of the metadata, because any client can write that namespace", () => {
    expect(startedForOf({ ticket: "ABC-101" })).toBe("ABC-101");
    for (const bad of [null, "ABC-101", [], {}, { ticket: 7 }, { ticket: "  " }, { ticket: "x".repeat(301) }]) {
      expect(startedForOf(bad)).toBeNull();
    }
  });
});

describe("pathsFromEvents", () => {
  const started = (item: Record<string, unknown>) => ({ type: "item/started", seq: 1, data: { item } });

  it("reads a command's cwd and the absolute paths its command line names", () => {
    const rows = [started({ type: "commandExecution", cwd: "/p", command: "cd /p/folio-abc-101 && git -C '/p/margin-abc-101' status" })];
    expect(pathsFromEvents(rows)).toEqual(["/p", "/p/folio-abc-101", "/p/margin-abc-101"]);
  });

  it("reads file changes, file reads and string tool arguments", () => {
    const rows = [
      started({ type: "fileChange", changes: [{ path: "/p/folio/a.go", kind: "update" }, { path: "relative.go", kind: "add" }] }),
      started({ type: "fileRead", path: "/p/folio/b.go" }),
      started({ type: "toolCall", tool: "Read", arguments: { file_path: "/p/folio/c.go", limit: 20 } }),
    ];
    expect(pathsFromEvents(rows)).toEqual(["/p/folio/a.go", "/p/folio/b.go", "/p/folio/c.go"]);
  });

  it("skips malformed rows and item kinds that carry no working location, instead of failing the read", () => {
    const rows = [null, 7, { data: null }, started({ type: "agentMessage", text: "see /p/folio" }), started({ type: "reasoning" })];
    expect(pathsFromEvents(rows)).toEqual([]);
  });
});

describe("refreshWorkedPaths", () => {
  it("never re-reads a thread whose updatedAt is the one its cached paths were read at", async () => {
    const reads: string[] = [];
    const result = await refreshWorkedPaths({
      threads: [
        { id: "a", updatedAt: 5 },
        { id: "b", updatedAt: 9 },
      ],
      cached: (id) => (id === "a" ? { updatedAt: 5, paths: ["/p/folio"] } : { updatedAt: 3, paths: [] }),
      read: async (id) => {
        reads.push(id);
        return ["/p/x"];
      },
    });
    expect(reads).toEqual(["b"]);
    expect(result.reused).toBe(1);
    expect(result.updates.get("b")).toEqual({ updatedAt: 9, paths: ["/p/x"] });
    expect(result.updates.has("a")).toBe(false);
  });

  it("skips a thread whose read fails or times out, and still finishes the others", async () => {
    const result = await refreshWorkedPaths({
      threads: [
        { id: "slow", updatedAt: 1 },
        { id: "bad", updatedAt: 1 },
        { id: "ok", updatedAt: 1 },
      ],
      cached: () => undefined,
      read: (id) =>
        id === "slow"
          ? new Promise<string[]>(() => {})
          : id === "bad"
            ? Promise.reject(new Error("boom"))
            : Promise.resolve(["/p/ok"]),
      timeoutMs: 20,
    });
    expect(result.failed).toBe(2);
    expect([...result.updates.keys()]).toEqual(["ok"]);
  });

  it("keeps at most `concurrency` reads in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await refreshWorkedPaths({
      threads: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, updatedAt: 1 })),
      cached: () => undefined,
      concurrency: 3,
      read: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return [];
      },
    });
    expect(peak).toBe(3);
  });

  it("bounds what it keeps per thread", async () => {
    const many = Array.from({ length: EVENT_READ.paths + 50 }, (_, i) => `/p/f${i}`);
    const result = await refreshWorkedPaths({
      threads: [{ id: "a", updatedAt: 1 }],
      cached: () => undefined,
      read: async () => many,
    });
    expect(result.updates.get("a")?.paths).toHaveLength(EVENT_READ.paths);
  });
});

describe("threadCoverage", () => {
  it("counts each linked thread once under its strongest tier, and the clusters any thread reached", () => {
    const map = (entries: [string, ThreadTier][]) => new Map(entries);
    const coverage = threadCoverage(
      4,
      new Map([
        ["a", map([["ABC-101", "paths"], ["OPS-2222", "environment"]])],
        ["b", map([["ABC-101", "ticket"]])],
        ["c", map([])],
      ]),
    );
    expect(coverage).toEqual({
      threads: 4,
      linked: 2,
      byTier: { started: 0, environment: 1, ticket: 1, paths: 0 },
      clustersWithThread: 2,
    });
  });
});
