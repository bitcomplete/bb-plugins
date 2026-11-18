import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { DashboardData } from "../src/ui/types.js";

describe("persisted configuration recovery", () => {
  const cases: Array<Record<string, string>> = [
    { config: "invalid JSON" },
    { config: JSON.stringify({ permissionMode: "unsupported" }) },
  ];
  it.each(cases)("keeps diagnostics and ledger access available after startup with invalid execution settings", async settings => {
    const { bb, harness } = createFakePluginHost({ pluginId: "self-improve", settings });
    try {
      await plugin(bb);
      const dashboard = await harness.behavior.callRpc("dashboard", {}) as DashboardData;
      expect(dashboard.health.issues).toContain("Invalid configuration");
      const doctor = await harness.behavior.runCli(["doctor"]);
      expect(doctor.exitCode).toBe(0); expect(doctor.stdout).toContain("Invalid configuration");
      expect(doctor.stdout).not.toContain("dummy-one"); expect(doctor.stdout).not.toContain("dummy-two");
      const goal = await harness.behavior.callRpc("createObjective", { requestId:"owner-objective", kind: "problem", title: "Keep diagnostics available", description: "Invalid persisted settings must remain repairable", priority: "normal" }) as { id: string };
      expect((await harness.behavior.callRpc("dashboard", {}) as DashboardData).problems.some(p => p.id === goal.id)).toBe(true);
    } finally { await harness.lifecycle.dispose(); }
  });
});
