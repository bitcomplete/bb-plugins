import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { RawUnit } from "./contract.js";
import plugin from "./server.js";

const checkout: RawUnit = {
  path: "/p/quill-abc-101",
  dirName: "quill-abc-101",
  repo: "quill",
  branch: "abc-101",
  dirty: false,
  ahead: 0,
  behind: 0,
  lastCommitAt: "2026-09-20T10:00:00Z",
  defaultBranch: "main",
  pr: null,
  shipped: null,
  changedPaths: [],
};

async function load(units: RawUnit[] = []) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "workstreams",
    settings: { scanRoots: "/p" },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host-quill" }) as never },
      threads: {
        list: async () => [] as never,
        getPluginMetadata: async () => ({}) as never,
        events: { list: async () => [] },
      },
    },
    experimental_callHostRpc: ({ method }) => {
      if (method === "scan") return { units, warnings: [] };
      throw new Error(`unexpected host call ${method}`);
    },
  });
  await plugin(bb);
  return { bb, harness };
}

describe("plain workstreams CLI scan health", () => {
  it("says it has never scanned before the first refresh", async () => {
    const { harness } = await load();
    const result = await harness.runCli(["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("scan: never scanned");
    expect(result.stdout).toContain("No clusters yet. Run `bb workstreams refresh`.");
    await harness.lifecycle.dispose();
  });

  it("distinguishes a failed first scan from no scan attempt", async () => {
    const { bb, harness } = await load();
    await bb.storage.kv.set("warnings", ["Scan failed: host unavailable"]);
    const result = await harness.runCli(["list"]);
    expect(result.stdout).toContain("scan: no successful scan (latest attempt failed)");
    expect(result.stdout).toContain("warnings: 1");
    await harness.lifecycle.dispose();
  });

  it("reports a successful empty scan without presenting it as unscanned", async () => {
    const { harness } = await load();
    expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
    const result = await harness.runCli(["list"]);
    expect(result.stdout).toMatch(/scan: \d{4}-\d\d-\d\dT.*\(just now\)/u);
    expect(result.stdout).toContain("No checkouts found in the scanned roots.");
    await harness.lifecycle.dispose();
  });

  it("shows a stale last success, later failure, and only three warnings", async () => {
    const { bb, harness } = await load();
    expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
    await bb.storage.kv.set("lastScanAt", new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    await bb.storage.kv.set("warnings", [
      "Scan failed: host unavailable",
      "First warning",
      "Second warning",
      "Third warning",
    ]);
    const result = await harness.runCli(["list"]);
    expect(result.stdout).toContain("; stale; latest attempt failed");
    expect(result.stdout).toContain("warnings: 4 (showing 3)");
    expect(result.stdout).toContain("Second warning");
    expect(result.stdout).not.toContain("Third warning");
    await harness.lifecycle.dispose();
  });

  it("places scan health before the groups on a populated board", async () => {
    const { harness } = await load([checkout]);
    expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
    const result = await harness.runCli(["list"]);
    expect(result.stdout.startsWith("scan: ")).toBe(true);
    expect(result.stdout).toContain("ABC-101");
    expect(result.stdout).not.toContain("No checkouts found");
    await harness.lifecycle.dispose();
  });

  it("loads older unit JSON without observation flags as unverified rather than claiming a clean checkout with no PR", async () => {
    const { harness } = await load([checkout]);
    expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
    const result = await harness.runCli(["list"]);
    expect(result.stdout).toContain("ABC-101  unverified");
    expect(result.stdout).toContain("git status unavailable; GitHub status unavailable");
    await harness.lifecycle.dispose();
  });
});

describe("compact workstreams CLI", () => {
  it("pages stable ticket clusters and reports the next offset", async () => {
    const units = [101, 102, 103].map((number) => ({ ...checkout, path: `/p/quill-abc-${number}`, dirName: `quill-abc-${number}`, branch: `abc-${number}` }));
    const { harness } = await load(units);
    await harness.runCli(["refresh"]);
    const first = await harness.runCli(["list", "--compact", "--limit", "2"]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("clusters: 3; showing 2 at offset 0");
    expect(first.stdout).toContain("Next page: bb workstreams list --compact --limit 2 --offset 2");
    const second = await harness.runCli(["list", "--compact", "--limit", "2", "--offset", "2"]);
    expect(second.stdout).toContain("ABC-103");
    expect(second.stdout).not.toContain("ABC-101");
    await harness.lifecycle.dispose();
  });

  it("emits the compact JSON schema and caps pages at 50", async () => {
    const { harness } = await load([checkout]);
    await harness.runCli(["refresh"]);
    const result = await harness.runCli(["list", "--compact", "--json", "--limit", "50"]);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed).sort()).toEqual(["items", "limit", "nextOffset", "offset", "scan", "total", "warningCount"].sort());
    expect(parsed.items[0]).toMatchObject({ ticket: "ABC-101", lifecycle: expect.any(String), summary: expect.any(String), groupPath: expect.any(Array) });
    expect(parsed.items[0].groupPath[0]).toMatchObject({ name: expect.any(String), key: expect.any(String), level: expect.any(String) });
    expect((await harness.runCli(["list", "--compact", "--limit", "51"])).exitCode).not.toBe(0);
    expect((await harness.runCli(["list", "--limit", "2"])).exitCode).not.toBe(0);
    expect((await harness.runCli(["list", "--compact", "--limit"])).exitCode).not.toBe(0);
    expect((await harness.runCli(["list", "--compact", "--offset"])).exitCode).not.toBe(0);
    await harness.lifecycle.dispose();
  });

  it("keeps legacy plain and full JSON outputs unchanged by default", async () => {
    const { harness } = await load([checkout]);
    await harness.runCli(["refresh"]);
    const plain = await harness.runCli(["list"]);
    const plainAgain = await harness.runCli(["list"]);
    expect(plain.stdout).toBe(plainAgain.stdout);
    expect(plain.stdout).toContain("[effort]");
    expect(plain.stdout).toContain("ABC-101");
    expect(plain.stdout).toContain("unverified");
    const json = await harness.runCli(["list", "--json"]);
    const jsonAgain = await harness.runCli(["list", "--json"]);
    expect(json.stdout).toBe(jsonAgain.stdout);
    expect(Object.keys(JSON.parse(json.stdout))).toEqual(expect.arrayContaining(["groups", "prInventory", "threadCoverage"]));
    await harness.lifecycle.dispose();
  });
});
