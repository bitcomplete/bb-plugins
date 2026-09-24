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
