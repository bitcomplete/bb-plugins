import { describe, expect, it } from "vitest";
import { defaultConfig, parseConfig } from "../src/config.js";
import { nativeExecution } from "../src/native-execution.js";

describe("BB-native execution selection", () => {
  it("does not infer a provider when migrating an old model-only configuration", () => {
    const config = parseConfig(JSON.stringify({ model: "a-model", projectId: "project", environmentId: "env" }));
    expect(config.providerId).toBe("");
    expect(() => nativeExecution({ providerId: config.providerId, model: config.model, projectId: config.projectId, environmentId: config.environmentId, permissionMode: config.permissionMode })).toThrow();
    expect(defaultConfig().providerId).toBe("");
  });

  it.each(["claude-code", "codex", "another-provider"])("forwards %s through the same BB contract", providerId => {
    const selection = { providerId, model: "selected-model", projectId: "project", environmentId: "env", reasoningLevel: "high" as const, permissionMode: "accept-edits" as const, serviceTier: "selected-tier" };
    expect(nativeExecution(selection)).toEqual({ providerId, model: selection.model, projectId: "project", environment: { type: "reuse", environmentId: "env" }, reasoningLevel: "high", permissionMode: "accept-edits", serviceTier: "selected-tier" });
  });

  it("rejects incomplete and extra provider-specific configuration at the boundary", () => {
    const selection = { providerId: "codex", model: "model", projectId: "project", environmentId: "", permissionMode: "accept-edits" as const };
    expect(() => nativeExecution(selection)).toThrow();
    expect(() => nativeExecution({ ...selection, environmentId: "env", apiKey: "dummy" } as typeof selection)).toThrow();
    expect(() => parseConfig(JSON.stringify({ permissionMode: "invented-mode" }))).toThrow();
  });
});
