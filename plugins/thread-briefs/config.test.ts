import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_JSON_MODE,
  ENV_MODEL,
  resolveApiKey,
  resolveCompletion,
  settingDefaults,
} from "./config.js";

describe("settingDefaults", () => {
  it("falls back to the plugin's own defaults with nothing in the environment", () => {
    expect(settingDefaults({})).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      jsonMode: true,
    });
  });

  it("takes the deployment's values when set", () => {
    expect(
      settingDefaults({
        [ENV_BASE_URL]: " https://api.fireworks.ai/inference/v1 ",
        [ENV_MODEL]: "accounts/fireworks/models/glm-5p3-flash",
        [ENV_JSON_MODE]: "false",
      }),
    ).toEqual({
      baseUrl: "https://api.fireworks.ai/inference/v1",
      model: "accounts/fireworks/models/glm-5p3-flash",
      jsonMode: false,
    });
  });

  it("treats an empty or unreadable variable as unset", () => {
    expect(settingDefaults({ [ENV_BASE_URL]: "  ", [ENV_JSON_MODE]: "maybe" })).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      jsonMode: true,
    });
  });
});

describe("resolveApiKey", () => {
  it("prefers the stored key", () => {
    expect(resolveApiKey(" mine ", { [ENV_API_KEY]: "shared" })).toBe("mine");
  });

  it("uses the environment's key when nothing is stored", () => {
    expect(resolveApiKey(undefined, { [ENV_API_KEY]: "shared" })).toBe("shared");
    expect(resolveApiKey("   ", { [ENV_API_KEY]: "shared" })).toBe("shared");
  });

  it("is null with no key anywhere", () => {
    expect(resolveApiKey("", {})).toBeNull();
    expect(resolveApiKey(undefined, { [ENV_API_KEY]: " " })).toBeNull();
  });
});

describe("resolveCompletion", () => {
  const values = { baseUrl: "https://api.test/v1", model: "m", jsonMode: false };

  it("is null without a key", () => {
    expect(resolveCompletion(values, {})).toBeNull();
  });

  it("carries the settings through with the resolved key", () => {
    expect(resolveCompletion(values, { [ENV_API_KEY]: "shared" })).toEqual({
      ...values,
      apiKey: "shared",
    });
    expect(resolveCompletion({ ...values, apiKey: "mine" }, { [ENV_API_KEY]: "shared" })).toEqual({
      ...values,
      apiKey: "mine",
    });
  });

  it("treats a blank stored URL or model as unset and falls back to the deployment's", () => {
    const env = {
      [ENV_API_KEY]: "shared",
      [ENV_BASE_URL]: "https://api.fireworks.ai/inference/v1",
      [ENV_MODEL]: "accounts/fireworks/models/glm-5p3-flash",
    };
    expect(resolveCompletion({ baseUrl: "", model: "  ", jsonMode: true }, env)).toEqual({
      baseUrl: "https://api.fireworks.ai/inference/v1",
      apiKey: "shared",
      model: "accounts/fireworks/models/glm-5p3-flash",
      jsonMode: true,
    });
  });

  it("falls back to the plugin's own defaults when a blank setting has no deployment value", () => {
    expect(
      resolveCompletion({ baseUrl: "", model: undefined, jsonMode: true }, { [ENV_API_KEY]: "k" }),
    ).toEqual({ baseUrl: DEFAULT_BASE_URL, apiKey: "k", model: DEFAULT_MODEL, jsonMode: true });
  });
});
