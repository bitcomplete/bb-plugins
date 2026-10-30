// Linear sync against a FAKE fetch and a real in-memory SQLite cache. No test
// here reaches the network.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LINEAR_DETAIL_TTL_MS, LINEAR_SETTLE_MS, LINEAR_TEAMS_TTL_MS } from "./linear.js";
import { LINEAR_DETAIL_MIGRATION, createLinearSync } from "./linearsync.js";

const KEY_A = "lin_api_inkwellfakekeyA";
const KEY_B = "lin_api_inkwellfakekeyB";

type Call = { key: string; query: string };

function setup(options: { teams?: Record<string, string[]>; fail?: boolean; failWorkspaceKey?: string; detailResponse?: (query: string) => unknown } = {}) {
  const db = new Database(":memory:");
  db.exec(LINEAR_DETAIL_MIGRATION);
  let clock = 1_000_000;
  const calls: Call[] = [];
  const logs: string[] = [];
  const teams = options.teams ?? { [KEY_A]: ["ABC", "OPS"] };
  const sync = createLinearSync({
    db,
    now: () => clock,
    log: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
    fetch: async (_url, init) => {
      const key = init.headers.authorization ?? "";
      const query = (JSON.parse(init.body) as { query: string }).query;
      calls.push({ key, query });
      if (options.fail) throw new Error(`connect ECONNREFUSED (auth ${key})`);
      if (query.includes("viewer")) {
        if (options.failWorkspaceKey === key) throw new Error("workspace unavailable");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { viewer: { organization: { name: "Inkwell", urlKey: "inkwell" } }, teams: { nodes: (teams[key] ?? []).map((team) => ({ key: team })) } },
          }),
        };
      }
      const data: Record<string, unknown> = {};
      for (const match of query.matchAll(/(t\d+): issue\(id: "([^"]+)"\)/gu)) {
        data[match[1]!] = { identifier: match[2], title: `Title of ${match[2]}`, project: { id: "p", name: "Print run" } };
      }
      return { ok: true, status: 200, json: async () => options.detailResponse?.(query) ?? { data } };
    },
  });
  return { db, sync, calls, logs, tick: (ms: number) => (clock += ms) };
}

const signal = new AbortController().signal;
const issueCalls = (calls: Call[]) => calls.filter((call) => call.query.includes("issue("));

describe("Linear sync", () => {
  it("makes no call at all with no key: behaviour with no key is today's", async () => {
    const { sync, calls } = setup();
    expect(await sync.sync([], ["ABC-1", "SHOP-2"], signal)).toEqual({ fetched: 0 });
    expect(calls).toEqual([]);
  });

  it("sends each ticket only with the key whose workspace owns its prefix, and the rest with no key", async () => {
    const { sync, calls } = setup({ teams: { [KEY_A]: ["ABC"], [KEY_B]: ["OPS"] } });
    await sync.sync([KEY_A, KEY_B], ["ABC-1", "OPS-2", "SHOP-3"], signal);
    const issues = issueCalls(calls);
    expect(issues).toHaveLength(2);
    expect(issues.find((call) => call.key === KEY_A)?.query).toContain('"ABC-1"');
    expect(issues.find((call) => call.key === KEY_A)?.query).not.toContain('"OPS-2"');
    expect(issues.find((call) => call.key === KEY_B)?.query).toContain('"OPS-2"');
    expect(issues.some((call) => call.query.includes('"SHOP-3"'))).toBe(false);
    expect(sync.read(["ABC-1", "OPS-2", "SHOP-3"]).size).toBe(2);
  });

  it("batches a key's tickets into aliased queries of at most 25", async () => {
    const { sync, calls } = setup();
    const tickets = Array.from({ length: 30 }, (_, index) => `ABC-${index + 1}`);
    await sync.sync([KEY_A], tickets, signal);
    const issues = issueCalls(calls);
    expect(issues).toHaveLength(2);
    expect(issues[0]?.query.match(/issue\(/gu)).toHaveLength(25);
    expect(issues[1]?.query.match(/issue\(/gu)).toHaveLength(5);
  });

  it("never refetches a ticket within the TTL, and refetches once it has passed", async () => {
    const { sync, calls, tick } = setup();
    await sync.sync([KEY_A], ["ABC-1"], signal);
    await sync.sync([KEY_A], ["ABC-1"], signal);
    expect(issueCalls(calls)).toHaveLength(1);
    tick(LINEAR_DETAIL_TTL_MS + 1);
    await sync.sync([KEY_A], ["ABC-1"], signal);
    expect(issueCalls(calls)).toHaveLength(2);
  });

  // A ticket read while its PR was open may have moved when the PR merged: Linear moves a merged PR's tickets itself, soon after. So the
  // next sync reads it again, and each after until a read lands LINEAR_SETTLE_MS past the merge, rather than waiting out the 12-hour cache.
  it("reads a ticket again after a merge that names it, until a read lands once Linear had time to move it", async () => {
    const { sync, calls, tick } = setup();
    const asked = () => issueCalls(calls).map((call) => [...call.query.matchAll(/issue\(id: "([^"]+)"\)/gu)].map((match) => match[1]));
    const read = 1_000_000;
    await sync.sync([KEY_A], ["ABC-1", "ABC-2"], signal);
    const merged = new Map([["ABC-1", read + 60_000]]);
    tick(120_000);
    await sync.sync([KEY_A], ["ABC-1", "ABC-2"], signal, merged);
    tick(LINEAR_SETTLE_MS);
    await sync.sync([KEY_A], ["ABC-1", "ABC-2"], signal, merged);
    await sync.sync([KEY_A], ["ABC-1", "ABC-2"], signal, merged);
    expect(asked()).toEqual([["ABC-1", "ABC-2"], ["ABC-1"], ["ABC-1"]]);
    expect(sync.readAt(["ABC-1", "ABC-2", "ABC-3"])).toEqual(new Map([["ABC-1", read + 120_000 + LINEAR_SETTLE_MS], ["ABC-2", read]]));
  });

  it("reads each key's workspace once a day, and again after a settings change", async () => {
    const { sync, calls, tick } = setup();
    const workspaceCalls = () => calls.filter((call) => call.query.includes("viewer")).length;
    await sync.sync([KEY_A], [], signal);
    await sync.sync([KEY_A], [], signal);
    expect(workspaceCalls()).toBe(1);
    sync.invalidate();
    await sync.sync([KEY_A], [], signal);
    expect(workspaceCalls()).toBe(2);
    tick(LINEAR_TEAMS_TTL_MS + 1);
    await sync.sync([KEY_A], [], signal);
    expect(workspaceCalls()).toBe(3);
  });

  it("warns once about a team two keys can see, and routes it to the first key", async () => {
    const { sync, calls, logs } = setup({ teams: { [KEY_A]: ["ABC"], [KEY_B]: ["ABC"] } });
    await sync.sync([KEY_A, KEY_B], ["ABC-1"], signal);
    sync.invalidate();
    await sync.sync([KEY_A, KEY_B], ["ABC-2"], signal);
    expect(logs.filter((line) => line.includes("more than one key"))).toHaveLength(1);
    expect(issueCalls(calls).every((call) => call.key === KEY_A)).toBe(true);
  });

  it("survives a network failure: nothing thrown, the prior cache kept, logged once, and no key in any log line", async () => {
    const good = setup();
    await good.sync.sync([KEY_A], ["ABC-1"], signal);
    const failing = setup({ fail: true });
    await failing.sync.sync([KEY_A], ["ABC-1"], signal);
    await failing.sync.sync([KEY_A], ["ABC-1"], signal);
    expect(failing.logs.filter((line) => line.includes("failed"))).toHaveLength(1);
    for (const line of [...failing.logs, ...good.logs]) {
      expect(line).not.toContain(KEY_A);
      expect(line).not.toContain("lin_api_");
    }
    expect(good.sync.read(["ABC-1"]).get("ABC-1")?.title).toBe("Title of ABC-1");
  });

  it("lets a key replace a row the removed agent fetch cached for a ticket it covers, because the key is authoritative", async () => {
    const { sync, calls } = setup();
    sync.store([{ ticket: "ABC-1", detail: { identifier: "ABC-1", title: "from agent", description: null, state: null, project: null, parent: null, labels: [], url: null, updatedAt: null, source: "agent" } }], "agent");
    await sync.sync([KEY_A], ["ABC-1"], signal);
    expect(issueCalls(calls)).toHaveLength(1);
    expect(sync.read(["ABC-1"]).get("ABC-1")?.title).toBe("Title of ABC-1");
  });

  // The live cache held key reads from before the seed's fields; waiting out their 12-hour TTL would leave cards and the seed without them.
  it("refetches a key row cached before assignee, cycle, and dates on the next sync, but not a ticket Linear has no issue for", async () => {
    const { sync, calls } = setup();
    const older = { identifier: "ABC-1", title: "Cached", description: null, state: null, project: null, parent: null, labels: [], url: null, updatedAt: null, source: "key" as const };
    sync.store([{ ticket: "ABC-1", detail: older }, { ticket: "ABC-404", detail: null }], "key");
    await sync.sync([KEY_A], ["ABC-1", "ABC-404"], signal);
    expect(issueCalls(calls)).toHaveLength(1);
    expect(issueCalls(calls)[0]?.query).toContain('"ABC-1"');
    expect(issueCalls(calls)[0]?.query).not.toContain('"ABC-404"');
    expect(sync.read(["ABC-1"]).get("ABC-1")).toMatchObject({ title: "Title of ABC-1", cycle: null });
    await sync.sync([KEY_A], ["ABC-1"], signal);
    expect(issueCalls(calls)).toHaveLength(1);
  });

  // Priority, points, and dates came after the cache filled. Refetching every row that lacks them at once would spend the rate limit on one
  // scan; the 12-hour cache brings them in, and meanwhile the older row still reads, with no priority.
  it("keeps a row cached before priority, points, and dates until its 12-hour cache runs out, and reads it meanwhile", async () => {
    const { sync, calls, tick } = setup();
    const older = { identifier: "ABC-1", title: "Cached", description: null, state: { name: "Done", type: "completed" }, project: null, parent: null, labels: [],
      assignee: null, cycle: null, dueDate: null, url: null, updatedAt: null, source: "key" as const };
    sync.store([{ ticket: "ABC-1", detail: older }], "key");
    await sync.sync([KEY_A], ["ABC-1"], signal);
    expect(issueCalls(calls)).toHaveLength(0);
    expect(sync.read(["ABC-1"]).get("ABC-1")).toMatchObject({ title: "Cached", state: { type: "completed" } });
    expect(sync.read(["ABC-1"]).get("ABC-1")?.priority).toBeUndefined();
    tick(LINEAR_DETAIL_TTL_MS + 1);
    await sync.sync([KEY_A], ["ABC-1"], signal);
    expect(issueCalls(calls)).toHaveLength(1);
  });

  it("retries a missing alias after a partial GraphQL response instead of caching it as no issue", async () => {
    let attempt = 0;
    const { sync, calls, db, logs } = setup({ detailResponse: () => {
      attempt += 1;
      return attempt === 1
        ? { data: { t0: { identifier: "ABC-1", title: "Available" }, t1: null }, errors: [{ message: "Resolver failed", path: ["t1"] }] }
        : { data: { t0: { identifier: "ABC-2", title: "Recovered" } } };
    } });
    expect(await sync.sync([KEY_A], ["ABC-1", "ABC-2"], signal)).toMatchObject({ fetched: 1 });
    expect(db.prepare("SELECT ticket FROM linear_detail ORDER BY ticket").all()).toEqual([{ ticket: "ABC-1" }]);
    expect(await sync.sync([KEY_A], ["ABC-1", "ABC-2"], signal)).toMatchObject({ fetched: 1 });
    expect(sync.read(["ABC-2"]).get("ABC-2")?.title).toBe("Recovered");
    expect(issueCalls(calls)).toHaveLength(2);
    expect(logs.some((line) => line.includes("partial data"))).toBe(true);
  });

  it("fetches what the answering key owns when another key's workspace lookup fails, and retries that lookup on the next sync", async () => {
    const { sync, calls } = setup({ teams: { [KEY_A]: ["ABC"], [KEY_B]: ["OPS"] }, failWorkspaceKey: KEY_B });
    expect(await sync.sync([KEY_A, KEY_B], ["ABC-1", "OPS-2"], signal)).toEqual({ fetched: 1 });
    await sync.sync([KEY_A, KEY_B], ["ABC-1", "OPS-2"], signal);
    expect(calls.filter((call) => call.key === KEY_B && call.query.includes("viewer")).length).toBeGreaterThan(1);
  });
});
