import type { JsonValue } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeClient, PodSummary, PvcSummary } from "./kube/client.js";
import type { TailnetMinter } from "./tailnet.js";
import { createKubernetesProviderPlugin } from "./server.js";

beforeEach(() => {
  vi.stubEnv("BB_K8S_AGENT_IMAGE", "registry.example/agent:1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const report: PluginMachineProviderProgress = { step() {}, log() {} };
const signal = () => new AbortController().signal;

function fakePod(name: string, overrides: Partial<PodSummary> = {}): PodSummary {
  return {
    name,
    phase: "Running",
    ready: true,
    labels: {},
    annotations: {},
    deletionTimestamp: null,
    containerWaitingReason: null,
    exitedContainer: null,
    ...overrides,
  };
}

function fakeClient() {
  const pods = new Map<string, PodSummary>();
  const pvcs = new Map<string, PvcSummary>();
  const executor = { exec: vi.fn(async () => ({ exitCode: 0 })) };
  const client: KubeClient = {
    namespace: "bb-dylan-production",
    createPod: vi.fn(async (manifest: any) => {
      const pod = fakePod(manifest.metadata.name, { labels: manifest.metadata.labels });
      pods.set(pod.name, pod);
      return pod;
    }),
    getPod: vi.fn(async (name: string) => pods.get(name) ?? null),
    listPods: vi.fn(async (selector: string) => {
      const wanted = Object.fromEntries(selector.split(",").map((p) => p.split("=")));
      return [...pods.values()].filter((pod) =>
        Object.entries(wanted).every(([k, v]) => pod.labels[k] === v),
      );
    }),
    deletePod: vi.fn(async (name: string) => {
      pods.delete(name);
    }),
    createPvc: vi.fn(async (manifest: any) => {
      const pvc: PvcSummary = {
        name: manifest.metadata.name,
        phase: "Bound",
        labels: manifest.metadata.labels,
        deletionTimestamp: null,
      };
      pvcs.set(pvc.name, pvc);
      return pvc;
    }),
    getPvc: vi.fn(async (name: string) => pvcs.get(name) ?? null),
    deletePvc: vi.fn(async (name: string) => {
      pvcs.delete(name);
    }),
    patchPodMetadata: vi.fn(async (name: string, patch: any) => {
      const pod = pods.get(name);
      if (!pod) return;
      pods.set(name, {
        ...pod,
        labels: { ...pod.labels, ...(patch.labels ?? {}) },
        annotations: { ...pod.annotations, ...(patch.annotations ?? {}) },
      });
    }),
    executor: vi.fn(() => executor),
    ping: vi.fn(async () => {}),
  };
  return { client, pods, pvcs, executor };
}

async function loadPlugin(
  options: {
    settings?: Record<string, string | number | boolean>;
    tailnet?: TailnetMinter | null;
  } = {},
) {
  const { client, pods, pvcs, executor } = fakeClient();
  let now = 1_000;
  const { bb, harness } = createFakePluginHost({
    pluginId: "kubernetes-provider",
    settings: { ...options.settings },
  });
  const bootstrap = vi.fn(async () => ({ hostId: "host_k8s" }));
  Object.assign(bb.experimental_machines, { bootstrap });
  const plugin = createKubernetesProviderPlugin({
    clientFactory: () => client,
    tailnetFactory: () => options.tailnet ?? null,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  await plugin(bb);
  const machine = harness.registrations.machineProviders.get("kubernetes");
  if (!machine) throw new Error("machine provider not registered");
  return { bb, harness, client, pods, pvcs, executor, bootstrap, machine };
}

const createArgs = (name: string, key = `launch_${name}`, extra: Record<string, string> = {}) => ({
  key,
  attempt: 1,
  inputs: { name, ...extra },
  report,
  signal: signal(),
  checkpoint: async (_resource: JsonValue) => {},
});

const resourceFor = (name: string, key = `launch_${name}`) => ({
  name,
  key,
  namespace: "bb-dylan-production",
  podName: `bb-${name}`,
  pvcName: `bb-${name}-data`,
});

describe("kubernetes machine provider", () => {
  it("registers a persistent (non-ephemeral) machine provider and no composition", async () => {
    const { harness } = await loadPlugin();
    expect(harness.registrations.machineProviders.get("kubernetes")?.ephemeral).toBe(false);
    expect(harness.registrations.environmentCompositions.size).toBe(0);
  });

  it("creates the PVC and pod, checkpoints before bootstrap, then labels the host", async () => {
    const { machine, client, pods, pvcs, bootstrap, executor } = await loadPlugin();
    const checkpoint = vi.fn(async (_resource: JsonValue) => {});
    const result = await machine.create({
      ...createArgs("acme-app", "launch_1", { resourceClass: "small" }),
      checkpoint,
    });
    expect(result).toEqual({
      status: "created",
      name: "Pod bb-acme-app",
      resource: resourceFor("acme-app", "launch_1"),
    });
    expect(checkpoint).toHaveBeenCalledWith(resourceFor("acme-app", "launch_1"));
    expect(checkpoint.mock.invocationCallOrder[0]).toBeLessThan(
      bootstrap.mock.invocationCallOrder[0]!,
    );
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({ key: "launch_1", executor }));
    expect(client.executor).toHaveBeenCalledWith("bb-acme-app", "agent");
    const pvcManifest = (client.createPvc as any).mock.calls[0][0];
    expect(pvcManifest.metadata.name).toBe("bb-acme-app-data");
    const podManifest = (client.createPod as any).mock.calls[0][0];
    expect(podManifest.spec.volumes[0].persistentVolumeClaim.claimName).toBe("bb-acme-app-data");
    expect(podManifest.spec.containers[0].resources.requests).toEqual({ cpu: "1", memory: "2Gi" });
    expect(pvcs.has("bb-acme-app-data")).toBe(true);
    expect(pods.get("bb-acme-app")?.labels["bb/host"]).toBe("host_k8s");
  });

  it("reuses an existing PVC instead of creating one", async () => {
    const { machine, client, pvcs } = await loadPlugin();
    pvcs.set("bb-acme-app-data", {
      name: "bb-acme-app-data",
      phase: "Bound",
      labels: {},
      deletionTimestamp: null,
    });
    const result = await machine.create(createArgs("acme-app"));
    expect(result).toMatchObject({ status: "created" });
    expect(client.createPvc).not.toHaveBeenCalled();
    expect(client.createPod).toHaveBeenCalledTimes(1);
  });

  it("reuses a ready pod for the same key and replaces an exited one", async () => {
    const { machine, client, pods } = await loadPlugin();
    await machine.create(createArgs("acme-app"));
    await machine.create(createArgs("acme-app"));
    expect(client.createPod).toHaveBeenCalledTimes(1);
    pods.set("bb-acme-app", fakePod("bb-acme-app", { phase: "Failed", ready: false }));
    await machine.create(createArgs("acme-app"));
    expect(client.deletePod).toHaveBeenCalledWith("bb-acme-app", expect.anything());
    expect(client.createPod).toHaveBeenCalledTimes(2);
  });

  // restartPolicy Never: a dead sidecar leaves phase Running on the agent
  // alone, and reusing that pod would wait for a readiness that cannot come.
  it("replaces a pod whose phase is Running but has an exited container", async () => {
    const { machine, client, pods } = await loadPlugin();
    await machine.create(createArgs("acme-app"));
    pods.set(
      "bb-acme-app",
      fakePod("bb-acme-app", { ready: false, exitedContainer: "tailscale" }),
    );
    const result = await machine.create(createArgs("acme-app"));
    expect(result).toMatchObject({ status: "created" });
    expect(client.deletePod).toHaveBeenCalledWith("bb-acme-app", expect.anything());
    expect(client.createPod).toHaveBeenCalledTimes(2);
  });

  it("fails fast when a container exits while waiting for ready", async () => {
    const { machine, client, pods } = await loadPlugin();
    (client.createPod as any).mockImplementationOnce(async (manifest: any) => {
      const pod = fakePod(manifest.metadata.name, {
        ready: false,
        exitedContainer: "tailscale",
        labels: manifest.metadata.labels,
      });
      pods.set(pod.name, pod);
      return pod;
    });
    const result = await machine.create(createArgs("acme-app"));
    expect(result).toMatchObject({ status: "failed" });
    expect((result as any).message).toContain("container tailscale exited");
  });

  it("refuses a name whose pod belongs to a different machine", async () => {
    const { machine } = await loadPlugin();
    await machine.create(createArgs("acme-app", "launch_a"));
    const result = await machine.create(createArgs("acme-app", "launch_b"));
    expect(result).toMatchObject({ status: "failed" });
    expect((result as any).message).toContain("already in use");
  });

  it("validates the machine name and resource class", async () => {
    const { machine } = await loadPlugin();
    await expect(machine.validate?.({ inputs: { name: "Acme" } })).resolves.toMatchObject({
      action: "refuse",
    });
    await expect(
      machine.validate?.({ inputs: { name: "acme", resourceClass: "huge" } }),
    ).resolves.toMatchObject({ action: "refuse" });
    await expect(machine.validate?.({ inputs: { name: "acme" } })).resolves.toEqual({
      action: "accept",
    });
  });

  it("fails when the pod cannot pull its image", async () => {
    const { machine, client, pods } = await loadPlugin();
    (client.createPod as any).mockImplementationOnce(async (manifest: any) => {
      const pod = fakePod(manifest.metadata.name, {
        phase: "Pending",
        ready: false,
        containerWaitingReason: "ImagePullBackOff",
        labels: manifest.metadata.labels,
      });
      pods.set(pod.name, pod);
      return pod;
    });
    const result = await machine.create(createArgs("acme-app"));
    expect(result).toMatchObject({ status: "failed" });
    expect((result as any).message).toContain("ImagePullBackOff");
  });

  it("removes the pod and keeps the PVC by default", async () => {
    const { machine, client, pods, pvcs } = await loadPlugin();
    await machine.create(createArgs("acme-app"));
    const result = await machine.remove({
      hostId: "host_k8s",
      resource: resourceFor("acme-app"),
      report,
      signal: signal(),
    });
    expect(result).toEqual({ status: "removed" });
    expect(pods.has("bb-acme-app")).toBe(false);
    expect(client.deletePvc).not.toHaveBeenCalled();
    expect(pvcs.has("bb-acme-app-data")).toBe(true);
  });

  it("deletes the PVC on remove when the setting is on", async () => {
    const { machine, pvcs } = await loadPlugin({ settings: { deleteVolumeOnRemove: true } });
    await machine.create(createArgs("acme-app"));
    await machine.remove({
      hostId: "host_k8s",
      resource: resourceFor("acme-app"),
      report,
      signal: signal(),
    });
    expect(pvcs.has("bb-acme-app-data")).toBe(false);
  });

  it("suspends by deleting the pod and resumes by recreating it with the same key", async () => {
    const { machine, client, pods, pvcs, bootstrap } = await loadPlugin();
    await machine.create(createArgs("acme-app", "launch_1", { resourceClass: "large" }));
    const suspendCheckpoint = vi.fn(async (_resource: JsonValue) => {});
    const suspended = await machine.suspend!({
      hostId: "host_k8s",
      resource: resourceFor("acme-app", "launch_1"),
      checkpoint: suspendCheckpoint,
      report,
      signal: signal(),
    });
    expect(suspended.resource).toEqual(resourceFor("acme-app", "launch_1"));
    expect(suspendCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(
      (client.deletePod as any).mock.invocationCallOrder[0],
    );
    expect(pods.has("bb-acme-app")).toBe(false);
    expect(pvcs.has("bb-acme-app-data")).toBe(true);

    const resumeCheckpoint = vi.fn(async (_resource: JsonValue) => {});
    const resumed = await machine.resume!({
      hostId: "host_k8s",
      resource: suspended.resource,
      checkpoint: resumeCheckpoint,
      report,
      signal: signal(),
    });
    expect(resumed.resource).toEqual(resourceFor("acme-app", "launch_1"));
    expect(client.createPvc).toHaveBeenCalledTimes(1);
    expect(client.createPod).toHaveBeenCalledTimes(2);
    const recreated = (client.createPod as any).mock.calls[1][0];
    expect(recreated.spec.containers[0].resources.requests).toEqual({ cpu: "4", memory: "8Gi" });
    expect(resumeCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(
      bootstrap.mock.invocationCallOrder[1]!,
    );
    expect(bootstrap).toHaveBeenLastCalledWith(expect.objectContaining({ key: "launch_1" }));
    expect(pods.get("bb-acme-app")?.labels["bb/host"]).toBe("host_k8s");
  });

  // HOME is on the volume and the volume outlives the machine, so a create
  it("resumes on the server's current image, not the one the machine was created with", async () => {
    const { bb, machine, client } = await loadPlugin();
    await machine.create(createArgs("acme-app", "launch_1", { resourceClass: "large" }));
    // What a machine created before the image left the launch record has stored.
    await bb.storage.kv.set("launch/acme-app", {
      image: "registry.example/agent:1",
      resourceClass: "large",
    });
    const lifecycle = () => ({
      hostId: "host_k8s",
      resource: resourceFor("acme-app", "launch_1"),
      checkpoint: async (_resource: JsonValue) => {},
      report,
      signal: signal(),
    });
    await machine.suspend!(lifecycle());
    vi.stubEnv("BB_K8S_AGENT_IMAGE", "registry.example/agent:2");
    await machine.resume!(lifecycle());
    const [created, recreated] = (client.createPod as any).mock.calls.map((call: any) => call[0]);
    expect(created.spec.containers[0].image).toBe("registry.example/agent:1");
    expect(recreated.spec.containers[0].image).toBe("registry.example/agent:2");
    expect(recreated.spec.containers[0].resources.requests).toEqual({ cpu: "4", memory: "8Gi" });
  });

  // A machine names its project image; the reference comes from the server
  // environment each time, so the server's current tag reaches it on resume.
  it("resolves a machine's project image afresh on resume", async () => {
    vi.stubEnv("BB_K8S_AGENT_IMAGE_BITHUB2", "registry.example/agent-bithub2:7");
    const { bb, machine, client } = await loadPlugin();
    await machine.create(createArgs("bithub2", "launch_1", { image: "bithub2" }));
    expect(await bb.storage.kv.get("launch/bithub2")).toEqual({
      resourceClass: "medium",
      projectImage: "bithub2",
    });
    const lifecycle = () => ({
      hostId: "host_k8s",
      resource: resourceFor("bithub2", "launch_1"),
      checkpoint: async (_resource: JsonValue) => {},
      report,
      signal: signal(),
    });
    await machine.suspend!(lifecycle());
    vi.stubEnv("BB_K8S_AGENT_IMAGE", "registry.example/agent:2");
    vi.stubEnv("BB_K8S_AGENT_IMAGE_BITHUB2", "registry.example/agent-bithub2:8");
    await machine.resume!(lifecycle());
    const [created, recreated] = (client.createPod as any).mock.calls.map((call: any) => call[0]);
    expect(created.spec.containers[0].image).toBe("registry.example/agent-bithub2:7");
    expect(recreated.spec.containers[0].image).toBe("registry.example/agent-bithub2:8");
  });

  it("refuses a project image the server does not know, naming the variable to set", async () => {
    vi.stubEnv("BB_K8S_AGENT_IMAGE_BITHUB2", "registry.example/agent-bithub2:7");
    const { machine } = await loadPlugin();
    await expect(machine.validate?.({ inputs: { name: "acme", image: "acme-app" } })).resolves.toEqual({
      action: "refuse",
      message: 'Unknown project image "acme-app". Known: bithub2.',
    });
    await expect(machine.validate?.({ inputs: { name: "acme", image: "bithub2" } })).resolves.toEqual({
      action: "accept",
    });
  });

  it("fails a resume whose project image has been unconfigured", async () => {
    vi.stubEnv("BB_K8S_AGENT_IMAGE_BITHUB2", "registry.example/agent-bithub2:7");
    const { machine } = await loadPlugin();
    await machine.create(createArgs("bithub2", "launch_1", { image: "bithub2" }));
    const lifecycle = () => ({
      hostId: "host_k8s",
      resource: resourceFor("bithub2", "launch_1"),
      checkpoint: async (_resource: JsonValue) => {},
      report,
      signal: signal(),
    });
    await machine.suspend!(lifecycle());
    vi.stubEnv("BB_K8S_AGENT_IMAGE_BITHUB2", "");
    await expect(machine.resume!(lifecycle())).rejects.toThrow(
      /project image "bithub2" is not configured; set BB_K8S_AGENT_IMAGE_BITHUB2/u,
    );
  });

  // must be able to clear a removed machine's installation, and a resume must
  // never do so: core restarts that installation and has to find it.
  it("claims the home directory before bootstrap, as create or as resume", async () => {
    const { machine, executor, bootstrap } = await loadPlugin();
    await machine.create(createArgs("acme-app"));
    const claim = (executor.exec as any).mock.calls[0][0];
    expect(claim.command.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(claim.command.slice(-2)).toEqual(["create", "launch_acme-app"]);
    expect((executor.exec as any).mock.invocationCallOrder[0]).toBeLessThan(
      bootstrap.mock.invocationCallOrder[0],
    );

    await machine.suspend?.({
      hostId: "host_k8s",
      resource: resourceFor("acme-app"),
      checkpoint: async () => {},
      report,
      signal: signal(),
    });
    await machine.resume?.({
      hostId: "host_k8s",
      resource: resourceFor("acme-app"),
      checkpoint: async () => {},
      report,
      signal: signal(),
    });
    const resumed = (executor.exec as any).mock.calls.at(-1)[0];
    expect(resumed.command.slice(-2)).toEqual(["resume", "launch_acme-app"]);
  });

  it("fails the create when the home directory cannot be prepared", async () => {
    const { machine, executor, bootstrap } = await loadPlugin();
    (executor.exec as any).mockResolvedValueOnce({ exitCode: 1 });
    const result = await machine.create(createArgs("acme-app"));
    expect(result).toMatchObject({ status: "failed" });
    expect((result as any).message).toContain("home directory");
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("refuses to resume when the volume is gone", async () => {
    const { machine } = await loadPlugin();
    await expect(
      machine.resume!({
        hostId: "host_k8s",
        resource: resourceFor("acme-app"),
        checkpoint: async () => {},
        report,
        signal: signal(),
      }),
    ).rejects.toThrow("no longer exists");
  });

  it("reconcileCleanup deletes pods by key and never touches PVCs", async () => {
    const { machine, client, pods, pvcs } = await loadPlugin();
    await machine.create(createArgs("acme-app", "launch_1"));
    await expect(
      machine.reconcileCleanup({ key: "launch_1", report, signal: signal() }),
    ).resolves.toEqual({ status: "removed" });
    expect(pods.size).toBe(0);
    expect(client.deletePvc).not.toHaveBeenCalled();
    expect(pvcs.has("bb-acme-app-data")).toBe(true);
  });

  it("reports setup-required until an image is configured", async () => {
    vi.stubEnv("BB_K8S_AGENT_IMAGE", "");
    const { machine } = await loadPlugin();
    await expect(machine.availability?.()).resolves.toMatchObject({ status: "setup-required" });
  });
});

describe("tailnet identity", () => {
  const minter = (mint: () => Promise<string>): TailnetMinter => ({
    tagFor: (name) => `tag:bb-dylan-${name}`,
    mintAuthKey: mint,
  });

  it("mints a key for the machine's own tag and puts the sidecar in the pod", async () => {
    const mint = vi.fn(async () => "tskey-auth-xxx");
    const { machine, client } = await loadPlugin({ tailnet: minter(mint) });
    await machine.create({ ...createArgs("acme-app"), checkpoint: vi.fn(async () => {}) });
    expect(mint).toHaveBeenCalledWith("acme-app", expect.anything());
    const podManifest = (client.createPod as any).mock.calls[0][0];
    const sidecar = podManifest.spec.containers[1];
    expect(sidecar.name).toBe("tailscale");
    expect(sidecar.env).toContainEqual({ name: "TS_AUTHKEY", value: "tskey-auth-xxx" });
  });

  // A machine nobody has admitted yet cannot be tagged, because the tailnet policy owns
  // the tag and it does not exist. That is the normal first state of every
  // machine, so it must not fail the creation.
  it("creates a working machine when the tag does not exist yet", async () => {
    const mint = vi.fn(async () => {
      throw new Error("Tailscale refused an auth key for tag:bb-dylan-acme-app: 403");
    });
    const { machine, client, bootstrap } = await loadPlugin({ tailnet: minter(mint) });
    const result = await machine.create({
      ...createArgs("acme-app"),
      checkpoint: vi.fn(async () => {}),
    });
    expect(result.status).toBe("created");
    expect(bootstrap).toHaveBeenCalled();
    const podManifest = (client.createPod as any).mock.calls[0][0];
    expect(podManifest.spec.containers).toHaveLength(1);
  });

  it("leaves the pod alone when the install has no minter", async () => {
    const { machine, client } = await loadPlugin();
    await machine.create({ ...createArgs("acme-app"), checkpoint: vi.fn(async () => {}) });
    const podManifest = (client.createPod as any).mock.calls[0][0];
    expect(podManifest.spec.containers).toHaveLength(1);
  });
});
