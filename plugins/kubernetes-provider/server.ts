import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderProgress,
  PluginMachineProviderResource,
} from "@get-bb/plugin-sdk/machine-provider";
import { z } from "zod";
import {
  PROJECT_IMAGE_NAME_PATTERN,
  projectImageEnvVar,
  resolveSettings,
  SETTING_DESCRIPTORS,
  type ResolvedSettings,
} from "./configuration.js";
import {
  createKubeClient,
  readInClusterCredentials,
  type KubeClient,
  type PodSummary,
} from "./kube/client.js";
import {
  AGENT_CONTAINER,
  LABELS,
  MACHINE_NAME_MAX,
  MACHINE_NAME_PATTERN,
  PROVIDER_ID,
  isValidMachineName,
  keyLabelValue,
  labelSelectorForKey,
  podNameForMachine,
  pvcNameForMachine,
  renderPodManifest,
  renderPvcManifest,
  type TailnetAttachment,
} from "./pod-spec.js";
import {
  createTailnetMinter,
  readTailnetCredentials,
  type TailnetMinter,
} from "./tailnet.js";

export const machineInputsSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MACHINE_NAME_MAX)
      .regex(MACHINE_NAME_PATTERN, "lowercase letters, digits and dashes only"),
    resourceClass: z.string().min(1).optional(),
    // Name of a project image the server knows (BB_K8S_AGENT_IMAGE_<NAME>).
    // Left out, the machine runs the base agent image. Either way the
    // reference is resolved each time a pod is created, so whatever tag the
    // server currently carries is what the machine gets on suspend/resume.
    image: z.string().min(1).regex(PROJECT_IMAGE_NAME_PATTERN, "lowercase letters, digits and dashes only").optional(),
  })
  .strict();

// Persisted with core. `key` is the creation key: bootstrap on resume must
// present the same key so core restarts the already-enrolled host instead
// of enrolling a new one.
export const resourceSchema = z
  .object({
    name: z.string().min(1),
    key: z.string().min(1),
    namespace: z.string().min(1),
    podName: z.string().min(1),
    pvcName: z.string().min(1),
  })
  .strict();

export type MachineInputs = z.infer<typeof machineInputsSchema>;
export type MachineResource = z.infer<typeof resourceSchema>;

export interface KubernetesProviderDeps {
  clientFactory: () => KubeClient;
  // Null when this install has no minter credentials, which is the ordinary
  // state for a server whose machines do not need cluster access.
  tailnetFactory: () => TailnetMinter | null;
  now: () => number;
  sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const POLL_INTERVAL_MS = 2000;
const POD_GONE_TIMEOUT_MS = 120_000;
const TERMINAL_WAITING_REASONS = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CrashLoopBackOff",
]);

// An exited container counts: with restartPolicy Never it stays down, so a pod
// whose sidecar died keeps phase Running on the agent alone and would
// otherwise be reused forever and never become ready.
// Run in the agent container before core's bootstrap. HOME is on the volume,
// and the volume outlives the machine: removing a machine keeps it, and a new
// machine of the same name reattaches it. Core never uninstalls on remove, so
// that new machine would find the old host's installation under
// $HOME/.bb-machines and enrollment would refuse it as "another host".
//
// The marker records which creation the installation belongs to. A create
// under a different key clears it; a retry of the same create, and every
// resume, leaves it alone — core restarts that installation and must find it.
const CLAIM_HOME_SCRIPT = `
set -eu
marker="$HOME/.bb-creation-key"
if [ "$1" = create ] && [ -d "$HOME/.bb-machines" ] && [ "$(cat "$marker" 2>/dev/null || true)" != "$2" ]; then
  rm -rf "$HOME/.bb-machines"
  echo "cleared the installation a removed machine left on this volume"
fi
mkdir -p "$HOME"
printf '%s' "$2" >"$marker"
`;
const CLAIM_HOME_TIMEOUT_MS = 60_000;

function isTerminal(pod: PodSummary): boolean {
  return (
    pod.phase === "Failed" ||
    pod.phase === "Succeeded" ||
    pod.deletionTimestamp !== null ||
    pod.exitedContainer !== null
  );
}

export function createKubernetesProviderPlugin(
  deps: KubernetesProviderDeps,
): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const settings = bb.settings.define(SETTING_DESCRIPTORS);
    let client: KubeClient | null = null;
    let minter: TailnetMinter | null | undefined;

    function kube(): KubeClient {
      if (client !== null) return client;
      try {
        client = deps.clientFactory();
        return client;
      } catch (error) {
        throw new Error(
          `Kubernetes credentials are unavailable: ${errorMessage(error)}. The server must run in a pod with a mounted ServiceAccount.`,
        );
      }
    }

    function tailnet(): TailnetMinter | null {
      if (minter === undefined) minter = deps.tailnetFactory();
      return minter;
    }

    // The pod's tailnet identity, or null if it is not getting one. Never
    // fatal: a machine with no cluster access is a working machine, and a
    // machine nobody has admitted yet is the normal first state. The tailnet
    // policy owns the tag, so it does not exist until something there names
    // this machine, and minting a key for an undefined tag is refused.
    async function attachTailnet(
      machineName: string,
      cfg: ResolvedSettings,
      report: PluginMachineProviderProgress,
      signal: AbortSignal,
    ): Promise<TailnetAttachment | null> {
      const api = tailnet();
      if (api === null) return null;
      try {
        const authKey = await api.mintAuthKey(machineName, signal);
        report.log(`tailnet identity ${api.tagFor(machineName)}\n`);
        return { authKey, image: cfg.tailscaleImage };
      } catch (error) {
        signal.throwIfAborted();
        report.log(
          `no cluster access via the tailnet: ${errorMessage(error)}\n` +
            `define ${api.tagFor(machineName)} in the tailnet policy and recreate the pod\n`,
        );
        bb.log.warn(
          `could not mint a tailnet key for machine ${machineName}: ${errorMessage(error)}`,
        );
        return null;
      }
    }

    async function currentSettings() {
      return resolveSettings(await settings.get());
    }

    async function requireSettings(): Promise<ResolvedSettings> {
      const resolved = await currentSettings();
      if (!resolved.ok) throw new Error(resolved.message);
      return resolved.settings;
    }

    function parseResource(value: PluginMachineProviderResource): MachineResource {
      return resourceSchema.parse(value);
    }

    async function waitForReady(
      name: string,
      cfg: ResolvedSettings,
      report: PluginMachineProviderProgress,
      signal: AbortSignal,
    ): Promise<PodSummary> {
      const api = kube();
      const deadline = deps.now() + cfg.readyTimeoutMs;
      let lastReason: string | null = null;
      for (;;) {
        signal.throwIfAborted();
        const pod = await api.getPod(name, signal);
        if (pod === null) throw new Error(`pod ${name} disappeared while waiting for it`);
        if (pod.phase === "Failed" || pod.phase === "Succeeded") {
          throw new Error(`pod ${name} exited (${pod.phase}) before bootstrap`);
        }
        if (pod.exitedContainer !== null) {
          throw new Error(`pod ${name}: container ${pod.exitedContainer} exited before bootstrap`);
        }
        if (pod.containerWaitingReason !== null && pod.containerWaitingReason !== lastReason) {
          lastReason = pod.containerWaitingReason;
          report.log(`pod ${name}: ${lastReason}\n`);
          if (TERMINAL_WAITING_REASONS.has(lastReason)) {
            throw new Error(`pod ${name} cannot start: ${lastReason}`);
          }
        }
        if (pod.phase === "Running" && pod.ready) return pod;
        if (deps.now() >= deadline) {
          throw new Error(
            `pod ${name} was not ready after ${Math.round(cfg.readyTimeoutMs / 1000)} s (phase ${pod.phase})`,
          );
        }
        await deps.sleep(POLL_INTERVAL_MS, signal);
      }
    }

    async function waitForPodGone(name: string, signal: AbortSignal): Promise<void> {
      const api = kube();
      const deadline = deps.now() + POD_GONE_TIMEOUT_MS;
      while ((await api.getPod(name, signal)) !== null) {
        if (deps.now() >= deadline) throw new Error(`pod ${name} did not terminate in time`);
        await deps.sleep(POLL_INTERVAL_MS, signal);
      }
    }

    // Ensure the PVC exists. An existing claim is reused as-is (that is how
    // a removed machine's workspace comes back under the same name).
    async function ensurePvc(
      machine: { name: string; key: string },
      cfg: ResolvedSettings,
      report: PluginMachineProviderProgress,
      signal: AbortSignal,
    ): Promise<{ name: string; created: boolean }> {
      const api = kube();
      const pvcName = pvcNameForMachine(machine.name);
      const existing = await api.getPvc(pvcName, signal);
      if (existing !== null) {
        if (existing.deletionTimestamp !== null) {
          throw new Error(`volume ${pvcName} is being deleted; retry once it is gone`);
        }
        report.log(`reusing volume ${pvcName}\n`);
        return { name: pvcName, created: false };
      }
      report.step("Creating volume");
      await api.createPvc(
        renderPvcManifest({
          name: machine.name,
          key: machine.key,
          namespace: api.namespace,
          settings: cfg,
          now: deps.now(),
        }),
        signal,
      );
      report.log(`created volume ${pvcName} (${cfg.volumeSize}, ${cfg.storageClass})\n`);
      return { name: pvcName, created: true };
    }

    // Ensure a live pod exists for the machine. A pod that already exited or
    // is terminating is replaced; a pod carrying a different creation key
    // belongs to another machine with the same name and is refused.
    async function ensurePod(
      machine: { name: string; key: string; image: string; resourceClass: string },
      cfg: ResolvedSettings,
      report: PluginMachineProviderProgress,
      signal: AbortSignal,
    ): Promise<PodSummary> {
      const api = kube();
      const podName = podNameForMachine(machine.name);
      let existing = await api.getPod(podName, signal);
      if (existing !== null) {
        const owner = existing.labels[LABELS.key];
        if (owner !== undefined && owner !== keyLabelValue(machine.key) && !isTerminal(existing)) {
          throw new Error(
            `machine name "${machine.name}" is already in use by another machine (pod ${podName})`,
          );
        }
        if (isTerminal(existing)) {
          report.log(`replacing exited pod ${podName}\n`);
          await api.deletePod(podName, signal);
          await waitForPodGone(podName, signal);
          existing = null;
        } else {
          report.log(`reusing pod ${podName}\n`);
          return existing;
        }
      }
      const resourceClass = cfg.resourceClasses[machine.resourceClass];
      if (resourceClass === undefined) {
        throw new Error(`Unknown resource class "${machine.resourceClass}".`);
      }
      const tailnetAttachment = await attachTailnet(machine.name, cfg, report, signal);
      report.step("Creating pod");
      const pod = await api.createPod(
        renderPodManifest({
          name: machine.name,
          key: machine.key,
          namespace: api.namespace,
          image: machine.image,
          resourceClass,
          settings: cfg,
          tailnet: tailnetAttachment,
          now: deps.now(),
        }),
        signal,
      );
      report.log(`created pod ${podName} (${machine.image}, class ${machine.resourceClass})\n`);
      return pod;
    }

    async function bootstrapPod(
      resource: MachineResource,
      mode: "create" | "resume",
      cfg: ResolvedSettings,
      report: PluginMachineProviderProgress,
      signal: AbortSignal,
    ): Promise<string> {
      const api = kube();
      report.step("Waiting for pod");
      await waitForReady(resource.podName, cfg, report, signal);
      signal.throwIfAborted();
      const executor: MachineExecutor = api.executor(resource.podName, AGENT_CONTAINER);
      const claimed = await executor.exec({
        command: ["sh", "-c", CLAIM_HOME_SCRIPT, "bb-claim-home", mode, resource.key],
        stdin: "",
        timeoutMs: CLAIM_HOME_TIMEOUT_MS,
        signal,
        onOutput: (chunk) => report.log(chunk),
      });
      if (claimed.exitCode !== 0) {
        throw new Error(`could not prepare the home directory (exit ${claimed.exitCode})`);
      }
      report.step("Installing daemon");
      const startedAt = deps.now();
      const { hostId } = await bb.experimental_machines.bootstrap({
        key: resource.key,
        executor,
        report,
        signal,
      });
      report.log(`daemon connected in ${deps.now() - startedAt} ms\n`);
      try {
        await api.patchPodMetadata(resource.podName, { labels: { [LABELS.host]: hostId } }, signal);
      } catch (error) {
        bb.log.warn(`could not label pod ${resource.podName} with its host id: ${errorMessage(error)}`);
      }
      return hostId;
    }

    // The resource class and the project image name have to survive
    // suspend/resume, so remember them in plugin storage keyed by machine
    // name. Only the name is stored, never a reference: every new pod
    // resolves it against the server's current environment, which is what
    // makes suspend/resume the upgrade path for project images and
    // agent-base alike. Not strict: records written by an earlier version
    // carry an `image` field holding the agent-base reference of the day.
    const launchKey = (name: string) => `launch/${name}`;
    const launchSchema = z.object({
      resourceClass: z.string(),
      projectImage: z.string().optional(),
    });
    type Launch = z.infer<typeof launchSchema>;
    async function rememberLaunch(name: string, launch: Launch) {
      await bb.storage.kv.set(launchKey(name), launch);
    }
    async function recallLaunch(name: string, cfg: ResolvedSettings): Promise<Launch> {
      const stored = await bb.storage.kv.get<unknown>(launchKey(name));
      if (stored === undefined) {
        return { resourceClass: cfg.defaultResourceClass };
      }
      return launchSchema.parse(stored);
    }
    function imageFor(launch: Launch, cfg: ResolvedSettings): string {
      if (launch.projectImage === undefined) return cfg.image;
      const image = cfg.projectImages[launch.projectImage];
      if (image === undefined) {
        throw new Error(
          `project image "${launch.projectImage}" is not configured; set ${projectImageEnvVar(launch.projectImage)} in the server environment`,
        );
      }
      return image;
    }

    bb.experimental_machines.register({
      id: PROVIDER_ID,
      displayName: "Kubernetes pod",
      description:
        "A long-lived pod with its own persistent volume in the bb server's namespace. Start threads on it with the Worktree provider.",
      icon: "Server",
      ephemeral: false,
      inputs: machineInputsSchema,
      async availability() {
        const resolved = await currentSettings();
        if (!resolved.ok) return { status: "setup-required", message: resolved.message };
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error("timed out")), 4000);
          try {
            await kube().ping(controller.signal);
          } finally {
            clearTimeout(timer);
          }
          return { status: "available" };
        } catch (error) {
          return { status: "unavailable", message: errorMessage(error) };
        }
      },
      async validate({ inputs }) {
        const resolved = await currentSettings();
        if (!resolved.ok) return { action: "refuse", message: resolved.message };
        if (!isValidMachineName(inputs.name)) {
          return {
            action: "refuse",
            message: `Machine name "${inputs.name}" must be 1–${MACHINE_NAME_MAX} lowercase letters, digits or dashes, starting and ending alphanumeric.`,
          };
        }
        const cls = inputs.resourceClass ?? resolved.settings.defaultResourceClass;
        if (!(cls in resolved.settings.resourceClasses)) {
          return {
            action: "refuse",
            message: `Unknown resource class "${cls}". Known: ${Object.keys(resolved.settings.resourceClasses).join(", ")}.`,
          };
        }
        if (inputs.image !== undefined && !(inputs.image in resolved.settings.projectImages)) {
          const known = Object.keys(resolved.settings.projectImages);
          return {
            action: "refuse",
            message: `Unknown project image "${inputs.image}". ${known.length > 0 ? `Known: ${known.join(", ")}.` : `None are configured; set ${projectImageEnvVar(inputs.image)} in the server environment.`}`,
          };
        }
        return { action: "accept" };
      },
      async create({ inputs, key, checkpoint, report, signal }) {
        try {
          const cfg = await requireSettings();
          const api = kube();
          const launch: Launch = {
            resourceClass: inputs.resourceClass ?? cfg.defaultResourceClass,
            ...(inputs.image !== undefined ? { projectImage: inputs.image } : {}),
          };
          if (!(launch.resourceClass in cfg.resourceClasses)) {
            return { status: "failed", message: `Unknown resource class "${launch.resourceClass}".` };
          }
          const machine = { name: inputs.name, key };
          const pvc = await ensurePvc(machine, cfg, report, signal);
          const pod = await ensurePod(
            { ...machine, resourceClass: launch.resourceClass, image: imageFor(launch, cfg) },
            cfg,
            report,
            signal,
          );
          const resource: MachineResource = {
            name: inputs.name,
            key,
            namespace: api.namespace,
            podName: pod.name,
            pvcName: pvc.name,
          };
          await checkpoint(resource);
          await rememberLaunch(inputs.name, launch);
          await bootstrapPod(resource, "create", cfg, report, signal);
          return { status: "created", name: `Pod ${pod.name}`, resource };
        } catch (error) {
          signal.throwIfAborted();
          return { status: "failed", message: errorMessage(error) };
        }
      },
      async reconcileCleanup({ key, signal }) {
        // Pods only. A volume is never deleted from a cleanup that has no
        // resource to tell it the user wanted that.
        try {
          const api = kube();
          const pods = await api.listPods(labelSelectorForKey(key), signal);
          for (const pod of pods) await api.deletePod(pod.name, signal);
          return { status: "removed" };
        } catch (error) {
          signal.throwIfAborted();
          return { status: "failed", message: errorMessage(error) };
        }
      },
      // Suspend: persist the recovery record, then delete the pod. The PVC
      // and the enrolled host identity survive; core stops the daemon
      // before calling this.
      async suspend({ resource, checkpoint, report, signal }) {
        const owned = parseResource(resource);
        const api = kube();
        await checkpoint(owned);
        report.step("Stopping pod");
        await api.deletePod(owned.podName, signal);
        await waitForPodGone(owned.podName, signal);
        report.log(`pod ${owned.podName} stopped; volume ${owned.pvcName} kept\n`);
        return { resource: owned };
      },
      // Resume: recreate the pod on the kept volume and bootstrap with the
      // original creation key, which makes core restart the existing host
      // identity rather than enrolling a new machine.
      async resume({ resource, checkpoint, report, signal }) {
        const owned = parseResource(resource);
        const cfg = await requireSettings();
        const api = kube();
        const pvc = await api.getPvc(owned.pvcName, signal);
        if (pvc === null) {
          throw new Error(
            `volume ${owned.pvcName} no longer exists; remove this machine and create it again`,
          );
        }
        const launch = await recallLaunch(owned.name, cfg);
        await ensurePod(
          {
            name: owned.name,
            key: owned.key,
            resourceClass: launch.resourceClass,
            image: imageFor(launch, cfg),
          },
          cfg,
          report,
          signal,
        );
        await checkpoint(owned);
        await bootstrapPod(owned, "resume", cfg, report, signal);
        return { resource: owned };
      },
      async remove({ resource, report, signal }) {
        try {
          const owned = parseResource(resource);
          const resolved = await currentSettings();
          const deleteVolume = resolved.ok && resolved.settings.deleteVolumeOnRemove;
          const api = kube();
          await api.deletePod(owned.podName, signal);
          const strays = await api.listPods(labelSelectorForKey(owned.key), signal);
          for (const pod of strays) await api.deletePod(pod.name, signal);
          if (deleteVolume) {
            await api.deletePvc(owned.pvcName, signal);
            report.log(`deleted pod ${owned.podName} and volume ${owned.pvcName}\n`);
          } else {
            report.log(
              `deleted pod ${owned.podName}; volume ${owned.pvcName} kept and will be reattached by a machine named "${owned.name}"\n`,
            );
          }
          await bb.storage.kv.delete(launchKey(owned.name));
          return { status: "removed" };
        } catch (error) {
          signal.throwIfAborted();
          return { status: "failed", message: errorMessage(error) };
        }
      },
    });

    const loaded = await currentSettings();
    if (!loaded.ok) bb.status.needsConfiguration(loaded.message);
  };
}

export default createKubernetesProviderPlugin({
  clientFactory: () => createKubeClient(readInClusterCredentials()),
  tailnetFactory: () => {
    const credentials = readTailnetCredentials();
    return credentials === null ? null : createTailnetMinter(credentials);
  },
  now: () => Date.now(),
  sleep: defaultSleep,
});
