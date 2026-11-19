import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { Store } from "../src/store.js";
import { defaultConfig } from "../src/config.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const event = (seq: number, type: string, data: unknown) => ({ id: `evt-${seq}`, seq, type, data, createdAt: 1000 + seq, scope: { kind: "turn", turnId: "turn-1" }, threadId: "user-thread" });

async function fixture() {
  const list = vi.fn(async (args: { types?: string[] }) => [
    event(1, "client/turn/requested", { initiator: "user", input: [{ type: "text", text: "That's wrong, use the PRIVATE-NAME config" }] }),
    event(2, "item/completed", { item: { type: "commandExecution", status: "failed", exitCode: 1, command: "deploy --token SECRET" } }),
  ].filter(row => !args.types || args.types.includes(row.type)));
  const { bb, harness } = createFakePluginHost({ pluginId: "self-improve", settings: { config: JSON.stringify({ ...defaultConfig(), redactedNames: ["PRIVATE-NAME"] }) }, sdk: { threads: { events: { list } } } as never });
  await plugin(bb); const store = new Store(bb.storage.database());
  const task = (taskId: string, threadId: string, stage: string, active = true) => {
    store.put("native-tasks", taskId, { taskId, nonce: "11111111-1111-4111-8111-111111111111", requestDigest: sha(taskId), promptHash: sha("p"), stage, runId: "run", solutionId: undefined, projectId: "p", providerId: "codex", model: "m",
      privacyGeneration: "g", permissionMode: "accept-edits", reasoningLevel: null, serviceTier: null, expectedEnvironmentId: "e", resolvedEnvironmentId: "e", threadId, state: "running", startedAtMs: 1, deadlineAtMs: 9e15,
      endedAtMs: null, error: null, outputDigest: null, dispatched: true, active, cleanupPending: false });
    store.put("native-task-threads", threadId, { taskId });
  };
  const tool = harness.inspection.registrations.agentTools.find(t => t.name === "self_improve_thread_read")!;
  const call = async (threadId: string, params: unknown) => JSON.parse(String(await tool.execute(params, { threadId } as never)));
  return { harness, store, task, tool, call, list };
}

it("lets an active search read a user thread's events, redacted and without tool arguments", async () => {
  const f = await fixture(); try {
    f.task("search-task", "search-thread", "miner");
    const result = await f.call("search-thread", { threadId: "user-thread" });
    expect(result.events.map((e: { kind: string }) => e.kind)).toEqual(["owner_correction", "tool_error"]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-NAME|SECRET|deploy/);
    expect(f.list.mock.calls[0]![0]).toMatchObject({ threadId: "user-thread", types: expect.arrayContaining(["item/completed"]) });
    expect(f.harness.inspection.registrations.agentConfigurationProvider!({ thread: { id: "search-thread" }, project: { id: "p" }, provider: { id: "codex", model: "m" } } as never)).toMatchObject({ tools: ["self_improve_thread_read"] });
  } finally { await f.harness.lifecycle.dispose(); }
});

it("refuses callers that are not an active search, and Self improve's own threads", async () => {
  const f = await fixture(); try {
    f.task("build-task", "build-thread", "builder"); f.task("old-search", "old-thread", "miner", false); f.task("search-task", "search-thread", "miner");
    await expect(f.call("user-thread", { threadId: "user-thread" })).rejects.toThrow("only to Self improve's search");
    await expect(f.call("build-thread", { threadId: "user-thread" })).rejects.toThrow("only to Self improve's search");
    await expect(f.call("old-thread", { threadId: "user-thread" })).rejects.toThrow("only to Self improve's search");
    await expect(f.call("search-thread", { threadId: "build-thread" })).rejects.toThrow("does not analyze its own threads");
    expect(f.harness.inspection.registrations.agentConfigurationProvider!({ thread: { id: "build-thread" }, project: { id: "p" }, provider: { id: "codex", model: "m" } } as never)).toMatchObject({ tools: [] });
  } finally { await f.harness.lifecycle.dispose(); }
});

it("adds applied improvements to turns outside the worker project, and stops once disabled", async () => {
  const f = await fixture(); try {
    const content = "Keep the original request payload when retrying.";
    f.store.put("native-evaluation-artifacts", "artifact", { solutionId: "s1", revision: "r1", kind: "instruction", content, artifactDigest: sha(content) });
    f.store.put("build-decisions", "job", { solutionId: "s1", attemptId: "a1", status: "passed-awaiting-apply", artifactId: "artifact" });
    const configure = (projectId: string) => f.harness.inspection.registrations.agentConfigurationProvider!({ thread: { id: "user-thread" }, project: { id: projectId }, provider: { id: "codex", model: "m" } } as never) as { instructions?: string };
    expect(configure("p1").instructions).toBeUndefined();
    await f.harness.behavior.callRpc("applyImprovement", { solutionId: "s1" });
    expect(configure("p1").instructions).toContain(content);
    await f.harness.behavior.callRpc("setImprovementEnabled", { solutionId: "s1", enabled: false });
    expect(configure("p1").instructions).toBeUndefined();
    const dashboard = await f.harness.behavior.callRpc("dashboard", {}) as { improvements: { applied: Array<{ enabled: boolean; usage: { turns: number } }> } };
    expect(dashboard.improvements.applied[0]).toMatchObject({ enabled: false, usage: { turns: 1 } });
  } finally { await f.harness.lifecycle.dispose(); }
});
