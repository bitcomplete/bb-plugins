import { describe, expect, it } from "vitest";
import { modelSettingSchema, parseModelSetting } from "./execution.js";

describe("model settings", () => {
  it("accepts only providerId/model/reasoningLevel, so a typo fails on save rather than at the next spawn", () => {
    expect(parseModelSetting("codex/gpt-6-sol/high")).toEqual({ providerId: "codex", model: "gpt-6-sol", reasoningLevel: "high" });
    expect(parseModelSetting("claude-code/claude-opus/max")).toEqual({ providerId: "claude-code", model: "claude-opus", reasoningLevel: "max" });
    for (const value of ["gpt-6-sol/high", "codex/gpt-6-sol/turbo", "codex//high", " codex/gpt-6-sol/high", "codex/gpt 6/high"]) {
      expect(modelSettingSchema.safeParse(value).success).toBe(false);
      expect(() => parseModelSetting(value)).toThrow("providerId/model/reasoningLevel");
    }
  });
});
