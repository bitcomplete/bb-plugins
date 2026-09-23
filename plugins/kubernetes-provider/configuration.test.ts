import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSettings, SETTING_DESCRIPTORS, type RawSettings } from "./configuration.js";

const defaults: RawSettings = {
  resourceClasses: SETTING_DESCRIPTORS.resourceClasses.default,
  defaultResourceClass: SETTING_DESCRIPTORS.defaultResourceClass.default,
  worktreePath: SETTING_DESCRIPTORS.worktreePath.default,
  volumeSize: SETTING_DESCRIPTORS.volumeSize.default,
  storageClass: SETTING_DESCRIPTORS.storageClass.default,
  readyTimeoutSeconds: SETTING_DESCRIPTORS.readyTimeoutSeconds.default,
  deleteVolumeOnRemove: SETTING_DESCRIPTORS.deleteVolumeOnRemove.default,
  nodeSelector: SETTING_DESCRIPTORS.nodeSelector.default,
  tolerations: SETTING_DESCRIPTORS.tolerations.default,
  tailscaleImage: SETTING_DESCRIPTORS.tailscaleImage.default,
};

beforeEach(() => {
  vi.stubEnv("BB_K8S_AGENT_IMAGE", "registry.example/agent:1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveSettings", () => {
  it("accepts the shipped defaults once an image is set", () => {
    const resolved = resolveSettings(defaults);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.settings.resourceClasses.medium).toEqual({ cpu: "2", memory: "4Gi" });
    expect(resolved.settings.readyTimeoutMs).toBe(300_000);
    expect(resolved.settings.deleteVolumeOnRemove).toBe(false);
    expect(resolved.settings.nodeSelector).toEqual({});
    expect(resolved.settings.tolerations).toEqual([]);
  });

  it("takes the image from BB_K8S_AGENT_IMAGE", () => {
    const resolved = resolveSettings(defaults);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.settings.image).toBe("registry.example/agent:1");
  });

  it("requires an image", () => {
    vi.stubEnv("BB_K8S_AGENT_IMAGE", "  ");
    expect(resolveSettings(defaults)).toEqual({
      ok: false,
      message: "Set BB_K8S_AGENT_IMAGE in the server environment.",
    });
  });

  it("rejects a default class that is not defined", () => {
    const resolved = resolveSettings({ ...defaults, defaultResourceClass: "huge" });
    expect(resolved.ok).toBe(false);
  });

  it("rejects malformed resource classes", () => {
    expect(resolveSettings({ ...defaults, resourceClasses: "[]" }).ok).toBe(false);
    expect(resolveSettings({ ...defaults, resourceClasses: '{"x":{"cpu":"1"}}' }).ok).toBe(false);
  });

  it("validates the volume quantity and worktree path", () => {
    expect(resolveSettings({ ...defaults, volumeSize: "twenty" }).ok).toBe(false);
    expect(resolveSettings({ ...defaults, worktreePath: "workspace" }).ok).toBe(false);
  });

  it("parses node placement settings", () => {
    const resolved = resolveSettings({
      ...defaults,
      nodeSelector: '{"role":"github-runner"}',
      tolerations:
        '[{"key":"github-runner","operator":"Equal","value":"true","effect":"NoSchedule"}]',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.settings.nodeSelector).toEqual({ role: "github-runner" });
    expect(resolved.settings.tolerations).toEqual([
      { key: "github-runner", operator: "Equal", value: "true", effect: "NoSchedule" },
    ]);
  });

  it("rejects malformed node placement settings", () => {
    expect(resolveSettings({ ...defaults, nodeSelector: "[]" }).ok).toBe(false);
    expect(resolveSettings({ ...defaults, nodeSelector: '{"role":1}' }).ok).toBe(false);
    expect(resolveSettings({ ...defaults, tolerations: "{}" }).ok).toBe(false);
    expect(resolveSettings({ ...defaults, tolerations: '[{"effect":"Sometimes"}]' }).ok).toBe(false);
    expect(resolveSettings({ ...defaults, tolerations: '[{"bogus":true}]' }).ok).toBe(false);
  });
});

describe("placement env fallbacks", () => {
  const base: RawSettings = {
      resourceClasses: JSON.stringify({ small: { cpu: "1", memory: "1Gi" } }),
    defaultResourceClass: "small",
    worktreePath: "/workspace",
    volumeSize: "1Gi",
    storageClass: "local-path",
    readyTimeoutSeconds: 60,
    deleteVolumeOnRemove: false,
    nodeSelector: "{}",
    tolerations: "[]",
    tailscaleImage: "tailscale/tailscale:v1.102.4",
  };
  const withEnv = (env: Record<string, string | undefined>, run: () => void) => {
    const saved = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      run();
    } finally {
      for (const key of Object.keys(env)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  };

  it("uses the env values while the settings are at their empty defaults", () => {
    withEnv(
      {
        BB_K8S_NODE_SELECTOR: '{"role":"github-runner"}',
        BB_K8S_TOLERATIONS: '[{"key":"github-runner","operator":"Equal","value":"true","effect":"NoSchedule"}]',
      },
      () => {
        const resolved = resolveSettings(base);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(resolved.settings.nodeSelector).toEqual({ role: "github-runner" });
        expect(resolved.settings.tolerations).toHaveLength(1);
      },
    );
  });

  it("lets a configured setting win over the env", () => {
    withEnv({ BB_K8S_NODE_SELECTOR: '{"role":"github-runner"}', BB_K8S_TOLERATIONS: "[]" }, () => {
      const resolved = resolveSettings({ ...base, nodeSelector: '{"zone":"ytz-a"}' });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.settings.nodeSelector).toEqual({ zone: "ytz-a" });
    });
  });

  it("ignores an unset env", () => {
    withEnv({ BB_K8S_NODE_SELECTOR: undefined, BB_K8S_TOLERATIONS: undefined }, () => {
      const resolved = resolveSettings(base);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.settings.nodeSelector).toEqual({});
      expect(resolved.settings.tolerations).toEqual([]);
    });
  });
});
