// Linear sync against a FAKE fetch and a real in-memory SQLite cache. No test
// here reaches the network.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LINEAR_DETAIL_TTL_MS, LINEAR_TEAMS_TTL_MS } from "./linear.js";
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
  it("makes no call at all with no key, and reports every ticket as unowned: behaviour with no key is today's", async () => {
    const { sync, calls } = setup();
    expect(await sync.sync([], ["ABC-1", "SHOP-2"], signal)).toEqual({ fetched: 0, unowned: ["ABC-1", "SHOP-2"] });
    expect(calls).toEqual([]);
  });

  it("sends each ticket only with the key whose workspace owns its prefix, and leaves the rest unowned", async () => {
    const { sync, calls } = setup({ teams: { [KEY_A]: ["ABC"], [KEY_B]: ["OPS"] } });
    const result = await sync.sync([KEY_A, KEY_B], ["ABC-1", "OPS-2", "SHOP-3"], signal);
    expect(result.unowned).toEqual(["SHOP-3"]);
    const issues = issueCalls(calls);
    expect(issues).toHaveLength(2);
    expect(issues.find((call) => call.key === KEY_A)?.query).toContain('"ABC-1"');
    expect(issues.find((call) => call.key === KEY_A)?.query).not.toContain('"OPS-2"');
    expect(issues.find((call) => call.key === KEY_B)?.query).toContain('"OPS-2"');
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

  it("lets a key replace an agent-sourced row for a ticket it covers, because the key is authoritative", async () => {
    const { sync, calls } = setup();
    sync.store([{ ticket: "ABC-1", detail: { identifier: "ABC-1", title: "from agent", description: null, state: null, project: null, parent: null, labels: [], url: null, updatedAt: null, source: "agent" } }], "agent");
    await sync.sync([KEY_A], ["ABC-1"], signal);
    expect(issueCalls(calls)).toHaveLength(1);
    expect(sync.read(["ABC-1"]).get("ABC-1")?.title).toBe("Title of ABC-1");
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

  it("does not offer unknown ownership to the agent when a workspace lookup fails", async () => {
    const { sync, calls } = setup({ teams: { [KEY_A]: ["ABC"], [KEY_B]: ["OPS"] }, failWorkspaceKey: KEY_B });
    expect(await sync.sync([KEY_A, KEY_B], ["ABC-1", "OPS-2"], signal)).toEqual({ fetched: 1, unowned: [] });
    expect(await sync.unowned([KEY_A, KEY_B], ["ABC-1", "OPS-2"], signal)).toEqual([]);
    expect(calls.filter((call) => call.key === KEY_B && call.query.includes("viewer")).length).toBeGreaterThan(1);
  });
});
