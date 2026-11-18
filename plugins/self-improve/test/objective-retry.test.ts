import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { Store } from "../src/store.js";
import { setObjectiveFocus, type Objective } from "../src/objectives.js";
import type { ObjectiveInput } from "../src/ui/types.js";

const input: ObjectiveInput = { requestId: "owner-retry-intent", kind: "goal", title: "Faster feedback", description: "Reduce the time to run the targeted tests.", priority: "focus", metric: { name: "Feedback time", unit: "seconds", target: 30, direction: "lower" } };

describe("owner objective request recovery", () => {
  it("recovers a committed request after a lost response and reload without duplicating records or resetting focus", async () => {
    const host = createFakePluginHost({ pluginId: "self-improve" });
    try {
      await plugin(host.bb);
      let savedId: string | undefined;
      await expect((async () => {
        savedId = (await host.harness.behavior.callRpc("createObjective", input) as { id: string }).id;
        throw new Error("response lost after commit");
      })()).rejects.toThrow("response lost after commit");
      const store = new Store(host.bb.storage.database());
      const [objective] = store.list<Objective>("objectives");
      expect(objective.problemId).toBe(savedId);
      expect(savedId).not.toBe(input.requestId);
      expect(store.list("problems")).toHaveLength(1);
      expect(store.list("objective-focus")).toHaveLength(1);
      expect(store.list("objective-requests")).toHaveLength(1);
      expect(store.audit()).toHaveLength(3);
      expect(store.list("votes")).toEqual([]);
      // Another owner action after the lost response must survive its eventual retry.
      setObjectiveFocus(store, objective.id, 2, { kind: "owner", id: "later-owner-action" });
      const namespaces = ["objectives", "problems", "objective-focus", "objective-requests"];
      const before = namespaces.map(namespace => store.entries(namespace));
      const audit = store.audit();
      const replacement = await host.harness.lifecycle.reload(plugin);
      try {
        expect(await replacement.harness.behavior.callRpc("createObjective", input)).toEqual({ id: savedId });
        const reloaded = new Store(replacement.bb.storage.database());
        expect(namespaces.map(namespace => reloaded.entries(namespace))).toEqual(before);
        expect(reloaded.audit()).toEqual(audit);
        expect(JSON.stringify(reloaded.list("objective-requests"))).not.toContain(input.description);
      } finally { await replacement.harness.lifecycle.dispose(); }
    } finally { await host.harness.lifecycle.dispose(); }
  });

  it("binds the whole normalized request and rejects conflicting reuse without changing the original intent", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "self-improve" });
    try {
      await plugin(bb);
      const first = await harness.behavior.callRpc("createObjective", { ...input, title: ` ${input.title} ` });
      const store = new Store(bb.storage.database());
      const before = store.entries("objectives"), audit = store.audit();
      expect(await harness.behavior.callRpc("createObjective", input)).toEqual(first);
      for (const change of [{ title: "A different goal" }, { priority: "normal" }, { metric: { ...input.metric!, target: 15 } }]) {
        await expect(harness.behavior.callRpc("createObjective", { ...input, ...change })).rejects.toThrow("Objective request changed");
      }
      expect(store.entries("objectives")).toEqual(before);
      expect(store.audit()).toEqual(audit);
      expect(store.list("problems")).toHaveLength(1);
      expect(store.list("objective-focus")).toHaveLength(1);
      const next = await harness.behavior.callRpc("createObjective", { ...input, requestId: "new-owner-intent", title: "A different goal" });
      expect(next).not.toEqual(first);
      expect(store.list("objectives")).toHaveLength(2);
      expect(store.list("problems")).toHaveLength(2);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("requires a bounded intent key and keeps entity identity and actor authority server-owned", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "self-improve" });
    try {
      await plugin(bb);
      for (const requestId of [undefined, "", "../outside", "x".repeat(101)]) {
        await expect(harness.behavior.callRpc("createObjective", { ...input, requestId })).rejects.toThrow();
      }
      await expect(harness.behavior.callRpc("createObjective", { ...input, id: "chosen-entity", actor: { kind: "owner", id: "chosen-actor" } })).rejects.toThrow();
      const store = new Store(bb.storage.database());
      expect(store.list("objectives")).toEqual([]);
      expect(store.list("problems")).toEqual([]);
      expect(store.audit()).toEqual([]);
    } finally { await harness.lifecycle.dispose(); }
  });
});
