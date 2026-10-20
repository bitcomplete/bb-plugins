/**
 * The `mergeGuidance` RPC's caller gate.
 *
 * The merge itself is git work, tested end to end in `provision.test.ts`
 * against real repositories. What is tested here is who may ask for it: only
 * the stewards plugin, because a lesson is the one thing that writes itself
 * into the guidance every steward reads. A thread or another plugin calling
 * the RPC directly is refused before any git runs.
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

async function setup() {
  const hostCalls: Array<{ method: string; input: unknown }> = [];
  const { bb, harness } = createFakePluginHost({
    experimental_callHostRpc: (call: { method: string; input: unknown }) => {
      hostCalls.push({ method: call.method, input: call.input });
      if (call.method === "mergeGuidance") return { ok: true, sha: "a".repeat(40), branch: "refs/heads/guidance-thr_lesson", message: "merged" };
      throw new Error(`unexpected host method ${call.method}`);
    },
  });
  harness.sdk.stub("projects.get", () => PROJECT);
  harness.sdk.stub("system.config", () => ({ primaryHostId: HOST_ID }));
  await plugin(bb);
  return { harness, hostCalls };
}

const input = { projectId: PROJECT_ID, threadId: "thr_lesson", file: "AGENTS.md", text: "A lesson." };

describe("merging a lesson through multi-repo", () => {
  it("is refused for a caller that is not the stewards plugin, before any git runs", async () => {
    const { harness, hostCalls } = await setup();
    const result = (await harness.callRpc("mergeGuidance", input, { experimental_caller: { kind: "plugin", pluginId: "linear" } })) as {
      ok: boolean;
      message: string;
    };
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Only the stewards plugin merges a lesson/u);
    expect(hostCalls).toEqual([]);
  });

  it("runs the host merge when the stewards plugin asks", async () => {
    const { harness, hostCalls } = await setup();
    const result = (await harness.callRpc("mergeGuidance", input, { experimental_caller: { kind: "plugin", pluginId: "stewards" } })) as {
      ok: boolean;
      sha: string | null;
    };
    expect(result).toMatchObject({ ok: true, sha: "a".repeat(40) });
    expect(hostCalls).toEqual([{ method: "mergeGuidance", input: { projectSourcePath: SOURCE_PATH, threadId: "thr_lesson", file: "AGENTS.md", text: "A lesson." } }]);
  });
});
