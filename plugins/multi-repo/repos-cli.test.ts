/**
 * `bb repos list`'s unpushed `.bb` line.
 *
 * The line is the CLI half of deliverable 1: the same fact the generated
 * instruction block carries, printed under the `layout` row so a person can
 * see that the project checkout has commits origin does not have. The host is
 * faked at the RPC boundary; the assertion is on the rendered command output.
 */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";

const PROJECT_ID = "proj_1";
const HOST_ID = "host-a";
const SOURCE_PATH = "/checkouts/acme";

const PROJECT = {
  id: PROJECT_ID,
  kind: "standard",
  name: "acme",
  gitRemoteUrl: null,
  createdAt: 1,
  updatedAt: 1,
  sources: [{ id: "src_1", projectId: PROJECT_ID, type: "local_path", hostId: HOST_ID, path: SOURCE_PATH, isDefault: true }],
};

async function setup(unpushed: unknown) {
  const { bb, harness } = createFakePluginHost({
    experimental_callHostRpc: (call: { method: string; input: unknown }) => {
      if (call.method === "prepareProjectSource") {
        return {
          bootstrapped: false,
          reposJson: JSON.stringify({
            version: 1,
            repos: [{ dir: "bb-dylan", url: "git@github.com:you/bb-dylan.git" }],
          }),
          remote: "git@github.com:you/acme.git",
          defaultBranch: "main",
          unpushed,
          layout: "primary",
          warnings: [],
        };
      }
      if (call.method === "cacheStatus") return { entries: [] };
      throw new Error(`unexpected host method ${call.method}`);
    },
  });
  harness.sdk.stub("projects.get", () => PROJECT);
  harness.sdk.stub("system.config", () => ({ primaryHostId: HOST_ID }));
  await plugin(bb);
  return harness;
}

describe("bb repos list", () => {
  it("prints the unpushed line under the layout row when the checkout is ahead", async () => {
    const harness = await setup({ branch: "main", count: 2, subjects: ["Add a repo", "Rewrite guidance"] });
    const result = await harness.runCli(["list", "--project", PROJECT_ID]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    const layoutIndex = lines.findIndex((line) => line.startsWith("layout\t"));
    expect(layoutIndex).toBeGreaterThanOrEqual(0);
    const unpushedLine = lines[layoutIndex + 1] ?? "";
    expect(unpushedLine).toContain("unpushed\t");
    expect(unpushedLine).toContain("2 commits on main are live on this server only");
    expect(unpushedLine).toContain("Add a repo; Rewrite guidance");
    expect(unpushedLine).toContain('git -C "/checkouts/acme" push origin main');
  });

  it("prints no unpushed line for a clean checkout", async () => {
    const harness = await setup(null);
    const result = await harness.runCli(["list", "--project", PROJECT_ID]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("unpushed");
    expect(result.stdout).toContain("layout\tprimary");
  });

  it("includes the same fact in the JSON output", async () => {
    const harness = await setup({ branch: "main", count: 1, subjects: ["Only change"] });
    const result = await harness.runCli(["list", "--project", PROJECT_ID, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { unpushed: { count: number; branch: string } | null };
    expect(parsed.unpushed).toEqual({ branch: "main", count: 1, subjects: ["Only change"] });
  });
});
