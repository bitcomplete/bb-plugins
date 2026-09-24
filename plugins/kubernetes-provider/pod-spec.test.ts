import { describe, expect, it } from "vitest";
import {
  MACHINE_NAME_MAX,
  isValidMachineName,
  keyLabelValue,
  labelSelectorForKey,
  podNameForMachine,
  pvcNameForMachine,
  renderPodManifest,
  renderPvcManifest,
} from "./pod-spec.js";

describe("machine names", () => {
  it("derives pod and PVC names that fit in 63 characters", () => {
    const name = "a".repeat(MACHINE_NAME_MAX);
    expect(isValidMachineName(name)).toBe(true);
    expect(podNameForMachine(name).length).toBeLessThanOrEqual(63);
    expect(pvcNameForMachine(name).length).toBeLessThanOrEqual(63);
    expect(podNameForMachine("acme-app")).toBe("bb-acme-app");
    expect(pvcNameForMachine("acme-app")).toBe("bb-acme-app-data");
  });
  it("rejects names that are not DNS-1123 labels", () => {
    expect(isValidMachineName("Acme")).toBe(false);
    expect(isValidMachineName("-acme")).toBe(false);
    expect(isValidMachineName("acme_app")).toBe(false);
    expect(isValidMachineName("")).toBe(false);
    expect(isValidMachineName("a".repeat(MACHINE_NAME_MAX + 1))).toBe(false);
  });
});

describe("keyLabelValue", () => {
  it("keeps label-safe characters and strips the rest", () => {
    expect(keyLabelValue("thr_ABC.1/2")).toBe("thr_ABC.1-2");
  });
  it("is used verbatim in the key selector", () => {
    expect(labelSelectorForKey("k/1")).toBe(
      "app.kubernetes.io/managed-by=bb-kubernetes-provider,bb/key=k-1",
    );
  });
});

describe("renderPvcManifest", () => {
  const pvc = renderPvcManifest({
    name: "acme-app",
    key: "launch_1",
    namespace: "example-production",
    settings: { volumeSize: "20Gi", storageClass: "local-path" },
    now: Date.UTC(2026, 8, 18),
  });
  it("renders a RWO claim on the configured class", () => {
    expect(pvc.metadata.name).toBe("bb-acme-app-data");
    expect(pvc.metadata.labels).toEqual({
      "app.kubernetes.io/managed-by": "bb-kubernetes-provider",
      "bb/machine": "acme-app",
      "bb/key": "launch_1",
    });
    expect(pvc.spec).toEqual({
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: { requests: { storage: "20Gi" } },
    });
  });
});

describe("renderPodManifest", () => {
  const baseSettings = { worktreePath: "/workspace", nodeSelector: {}, tolerations: [] };
  const manifest = renderPodManifest({
    name: "acme-app",
    key: "launch_1",
    namespace: "example-production",
    image: "registry.example/agent:1",
    resourceClass: { cpu: "2", memory: "4Gi", limits: { memory: "8Gi" } },
    settings: baseSettings,
    tailnet: null,
    now: Date.UTC(2026, 8, 18),
  });

  it("names and labels the pod from the machine name and key", () => {
    expect(manifest.metadata.name).toBe("bb-acme-app");
    expect(manifest.metadata.labels).toEqual({
      "app.kubernetes.io/managed-by": "bb-kubernetes-provider",
      "bb/machine": "acme-app",
      "bb/key": "launch_1",
    });
    expect(manifest.metadata.annotations["bb/created-at"]).toBe("2026-09-18T00:00:00.000Z");
  });

  it("locks the pod down and mounts the machine's persistent volume", () => {
    const spec = manifest.spec as Record<string, any>;
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.restartPolicy).toBe("Never");
    expect(spec.securityContext.runAsNonRoot).toBe(true);
    expect(spec.securityContext.runAsUser).toBe(1001);
    expect(spec.volumes[0]).toEqual({
      name: "data",
      persistentVolumeClaim: { claimName: "bb-acme-app-data" },
    });
    const container = spec.containers[0];
    expect(container.name).toBe("agent");
    expect(container.image).toBe("registry.example/agent:1");
    expect(container.command).toBeUndefined();
    expect(container.volumeMounts[0]).toEqual({ name: "data", mountPath: "/workspace" });
    expect(container.env).toEqual([
      { name: "BB_WORKTREE_PATH", value: "/workspace" },
      // On the volume: the daemon installation under $HOME/.bb-machines has
      // to outlive the pod or resume finds nothing to restart.
      { name: "HOME", value: "/workspace/.home" },
      { name: "KUBECONFIG", value: "/etc/bb/kubeconfig" },
    ]);
  });

  it("leaves the pod off the tailnet when the machine has no identity", () => {
    const spec = manifest.spec as Record<string, any>;
    expect(spec.containers).toHaveLength(1);
    expect(spec.volumes.map((v: { name: string }) => v.name)).toEqual(["data", "kube-ca"]);
  });

  it("mounts the namespace's cluster CA at /etc/bb/kube-ca.crt via subPath", () => {
    const spec = manifest.spec as Record<string, any>;
    expect(spec.volumes[1]).toEqual({
      name: "kube-ca",
      configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "kube-ca.crt" }] },
    });
    expect(spec.containers[0].volumeMounts[1]).toEqual({
      name: "kube-ca",
      mountPath: "/etc/bb/kube-ca.crt",
      subPath: "kube-ca.crt",
      readOnly: true,
    });
  });

  it("derives limits from the class, falling back to requests", () => {
    const container = (manifest.spec as Record<string, any>).containers[0];
    expect(container.resources).toEqual({
      requests: { cpu: "2", memory: "4Gi" },
      limits: { cpu: "2", memory: "8Gi" },
    });
  });

  it("omits placement fields when unset", () => {
    const spec = manifest.spec as Record<string, any>;
    expect(spec.nodeSelector).toBeUndefined();
    expect(spec.tolerations).toBeUndefined();
  });

  it("renders nodeSelector and tolerations when configured", () => {
    const placed = renderPodManifest({
      name: "acme-app",
      key: "launch_1",
      namespace: "example-production",
      image: "registry.example/agent:1",
      resourceClass: { cpu: "2", memory: "4Gi" },
      tailnet: null,
      settings: {
        ...baseSettings,
        nodeSelector: { role: "agents" },
        tolerations: [
          { key: "agents", operator: "Equal", value: "true", effect: "NoSchedule" },
        ],
      },
      now: 0,
    });
    const spec = placed.spec as Record<string, any>;
    expect(spec.nodeSelector).toEqual({ role: "agents" });
    expect(spec.tolerations).toEqual([
      { key: "agents", operator: "Equal", value: "true", effect: "NoSchedule" },
    ]);
  });
});

describe("renderPodManifest with a tailnet identity", () => {
  const manifest = renderPodManifest({
    name: "acme-app",
    key: "launch_1",
    namespace: "example-production",
    image: "registry.example/agent:1",
    resourceClass: { cpu: "2", memory: "4Gi" },
    settings: { worktreePath: "/workspace", nodeSelector: {}, tolerations: [] },
    tailnet: { authKey: "tskey-auth-xxx", image: "tailscale/tailscale:v1.102.4" },
    now: Date.UTC(2026, 8, 18),
  });
  const spec = manifest.spec as Record<string, any>;
  const sidecar = spec.containers[1];
  const env = Object.fromEntries(
    sidecar.env.map((e: { name: string; value: string }) => [e.name, e.value]),
  );

  it("adds the sidecar beside the agent, not in place of it", () => {
    expect(spec.containers.map((c: { name: string }) => c.name)).toEqual(["agent", "tailscale"]);
    expect(sidecar.image).toBe("tailscale/tailscale:v1.102.4");
    expect(env.TS_AUTHKEY).toBe("tskey-auth-xxx");
  });

  // Userspace networking is what keeps the sidecar inside the pod's existing
  // security context: a TUN device would need NET_ADMIN, which is dropped.
  it("runs in userspace with no added capabilities", () => {
    expect(env.TS_USERSPACE).toBe("true");
    expect(sidecar.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
  });

  it("exposes the outbound proxy the kubeconfig's proxy-url points at", () => {
    expect(env.TS_OUTBOUND_HTTP_PROXY_LISTEN).toBe("localhost:1055");
  });

  // The key is single-use and the node is ephemeral, so there is nothing to
  // keep across a restart and nowhere it needs to survive to.
  it("keeps tailscaled state on emptyDir", () => {
    expect(spec.volumes.map((v: { name: string }) => v.name)).toEqual([
      "data",
      "kube-ca",
      "tailscale-state",
      "tailscale-run",
    ]);
    expect(sidecar.volumeMounts.map((m: { mountPath: string }) => m.mountPath)).toEqual([
      "/tmp/tailscale-state",
      "/tmp/tailscale-run",
    ]);
  });

  // The pod has no ServiceAccount token, so containerboot must not reach for
  // its default state Secret: unset is not enough, it has to be empty.
  it("turns off kube Secret state storage", () => {
    expect(env.TS_KUBE_SECRET).toBe("");
    expect(env.TS_STATE_DIR).toBe("/tmp/tailscale-state");
  });

  // Without in-memory state tailscaled does not log out on shutdown, and the
  // old node lingers long enough for a resume to come back as <name>-1.
  it("keeps node state in memory so suspend frees the hostname", () => {
    expect(env.TS_TAILSCALED_EXTRA_ARGS).toBe("--state=mem:");
  });

  it("names the node after the pod so the device list is legible", () => {
    expect(env.TS_HOSTNAME).toBe("bb-acme-app");
  });
});
