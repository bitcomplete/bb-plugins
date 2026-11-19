import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { Store } from "../src/store.js";
import { defaultConfig } from "../src/config.js";
import { solution } from "./domain/fixtures.js";
import type { EditRevalidationDraft } from "../src/revalidation-edit-contract.js";
import type { RevalidationOwnerApi } from "../src/revalidation-owner.js";

async function fixture() {
  const selection = { providerId: "codex", model: "owner-selected", projectId: "project", environmentId: "environment", permissionMode: "accept-edits" as const };
  const spawn = vi.fn(async () => { throw new Error("No model dispatch is expected in an owner draft test"); });
  const { bb, harness } = createFakePluginHost({ pluginId: "self-improve", settings: { config: JSON.stringify({ ...defaultConfig(), ...selection }) }, sdk: { threads: { spawn } } });
  await plugin(bb); const store = new Store(bb.storage.database());
  const content = "Preserve each field of the original payload.", artifactDigest = createHash("sha256").update(content).digest("hex");
  store.put("solutions", "solution", solution("solution"));
  store.put("native-evaluation-artifacts", "artifact", { solutionId: "solution", revision: "r1", kind: "instruction", content, artifactDigest });
  const input: EditRevalidationDraft = { action: "create", requestId: "owner-intent", definition: {
    target: { solutionId: "solution", namespace: "native-evaluation-artifacts", artifactId: "artifact", revision: "r1", artifactDigest },
    concern: "Does it preserve whitespace?", claim: { id: "payload-preserved", text: "Keep payload fields" },
    cases: [{ id: "case", input: "Return two leading spaces then field", expected: "  field" }],
    criteria: [{ id: "primary", measure: "pass-rate", statistic: "difference", operator: "at-least", value: 0, required: true }],
    limits: { maxDurationMs: 600_000 } } };
  return { harness, store, input, spawn, selection, call: (method: string, value: unknown, options?: object) => harness.behavior.callRpc(method, value, options) };
}
it("drafts, freezes and queues through the owner RPCs with one durable retry identity", async () => {
  const f = await fixture(); try {
    const overview = await f.call("revalidationOverview", { solutionId: "solution" }) as ReturnType<RevalidationOwnerApi["overview"]>;
    expect(overview.artifacts[0]!.target).toEqual(f.input.definition.target);
    const plan = await f.call("editRevalidationDraft", f.input) as ReturnType<RevalidationOwnerApi["edit"]>;
    const frozen = await f.call("freezeRevalidation", { planId: plan.id, expectedVersion: 1 }) as ReturnType<RevalidationOwnerApi["freeze"]>;
    expect(frozen.testedOn).toMatchObject(f.selection); expect(frozen.definition.cases[0]!.expected).toBe("  field");
    const request = { planId: plan.id, version: 1, requestId: "queue-intent" };
    const queued = await f.call("queueRevalidation", request) as ReturnType<RevalidationOwnerApi["queue"]>;
    expect(await f.call("queueRevalidation", request)).toEqual(queued);
    const jobs = f.store.db.prepare("SELECT input FROM jobs WHERE stage='builder'").all() as { input: string }[];
    expect(jobs.map(row => JSON.parse(row.input))).toEqual([{ kind: "revalidation", revalidationRunId: queued.run.id, solutionId: `revalidation-run:${queued.run.id}` }]);
    const cancelled = await f.call("cancelRevalidation", { runId: queued.run.id, reason: "Revise the cases first" });
    expect(cancelled).toMatchObject({ status: "cancelled", verdict: null });
    expect(f.spawn).not.toHaveBeenCalled();
  } finally { await f.harness.lifecycle.dispose(); }
});
it("refuses every dashboard RPC from another plugin", async () => {
  const f = await fixture(); try {
    const asPlugin = { experimental_caller: { kind: "plugin" as const, pluginId: "other-plugin" } };
    for (const [method, value] of [["editRevalidationDraft", f.input], ["dashboard", {}], ["getExecution", {}], ["revalidationOverview", {}]] as const)
      await expect(f.call(method, value, asPlugin)).rejects.toThrow("available only to the owner");
    expect(f.store.list("revalidation-plans")).toEqual([]);
    await expect(f.call("dashboard", {})).resolves.toBeDefined();
  } finally { await f.harness.lifecycle.dispose(); }
});
