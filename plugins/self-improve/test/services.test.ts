import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS, Store } from "../src/store.js";
import { Services, STAGES, type StageHandler } from "../src/services.js";
it("owns seven abortable services and an independent reconciliation schedule", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "self-improve" });
  const db = bb.storage.database(); bb.storage.migrate(db, MIGRATIONS);
  const handlers = Object.fromEntries(STAGES.map(stage => [stage, async () => ({ handled: 1 })])) as unknown as Record<typeof STAGES[number], StageHandler>;
  const services = new Services(bb, new Store(db), handlers, async () => true, () => {});
  services.register();
  for (const stage of STAGES) await harness.behavior.runSchedule(stage);
  expect(new Store(db).pending()).toHaveLength(7);
  const running = harness.behavior.runService("miner");
  await new Promise(resolve => setTimeout(resolve, 20));
  running.controller.abort(); await running.done;
  expect(new Store(db).runs()[0]).toMatchObject({ stage: "miner", status: "succeeded" });
  await harness.lifecycle.dispose();
});
