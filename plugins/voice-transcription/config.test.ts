import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_MODEL,
  resolveApiKey,
  settingDefaults,
} from "./config.js";

describe("settingDefaults", () => {
  it("falls back to the plugin's own defaults with nothing in the environment", () => {
    expect(settingDefaults({})).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
    });
  });

  it("takes the deployment's values when set", () => {
    expect(
      settingDefaults({
        [ENV_BASE_URL]: " https://shared.test/v1 ",
        [ENV_MODEL]: "shared-model",
      }),
    ).toEqual({
      baseUrl: "https://shared.test/v1",
      model: "shared-model",
    });
  });

  it("treats an empty or whitespace variable as unset", () => {
    expect(
      settingDefaults({ [ENV_BASE_URL]: "  ", [ENV_MODEL]: "" }),
    ).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
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
