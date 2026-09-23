import type { ResolvedSettings, ResourceClass } from "./configuration.js";

export const PROVIDER_ID = "kubernetes";
export const AGENT_CONTAINER = "agent";
export const TAILSCALE_CONTAINER = "tailscale";
export const MANAGED_BY = "bb-kubernetes-provider";

// Label and annotation keys. `bb/` is a valid label prefix (a DNS label).
export const LABELS = {
  managedBy: "app.kubernetes.io/managed-by",
  machine: "bb/machine",
  key: "bb/key",
  host: "bb/host",
} as const;

export const ANNOTATIONS = {
  createdAt: "bb/created-at",
} as const;

// The kubelet projects the cluster CA into every namespace as this ConfigMap.
// The agent image bakes /etc/bb/kubeconfig pointing at this file so kubectl
// in a machine pod can verify the API server with the token that arrives
// through the project's machine environment.
export const KUBE_ROOT_CA_CONFIGMAP = "kube-root-ca.crt";
export const KUBE_CA_MOUNT_PATH = "/etc/bb/kube-ca.crt";
export const KUBECONFIG_PATH = "/etc/bb/kubeconfig";

// Where the tailscale sidecar listens for outbound HTTP proxy requests. The
// containers share a network namespace, so the agent reaches it on localhost.
//
// Wired into the kubeconfig as the cluster's proxy-url rather than
// into the agent's environment as HTTPS_PROXY: the environment variable would
// push every HTTPS request the agent makes — GitHub, Anthropic, npm — through
// a tailnet whose policy permits port 443 to the operator proxy and nothing
// else. proxy-url scopes the detour to the one cluster that needs it.
export const TAILNET_PROXY_LISTEN = "localhost:1055";

// Userspace networking: no TUN device and no NET_ADMIN, so the sidecar runs
// under the same runAsUser 1001 / drop ALL context as the agent. Both
// directories are emptyDir because the node is ephemeral — its state is worth
// nothing once the pod is gone.
const TAILSCALE_STATE_DIR = "/tmp/tailscale-state";
const TAILSCALE_RUN_DIR = "/tmp/tailscale-run";
const TAILSCALE_STATE_VOLUME = "tailscale-state";
const TAILSCALE_RUN_VOLUME = "tailscale-run";

// HOME lives on the persistent volume, not in the container's own filesystem.
// Core installs the daemon and the host identity under $HOME/.bb-machines,
// and resume restarts that installation rather than enrolling again, so a
// home that went away with the pod makes every resume fail with "Machine
// installation was not found". The agent's own logins and dotfiles survive
// the same way. The install script creates the directory.
const HOME_DIR = ".home";

export function homePathFor(worktreePath: string): string {
  return `${worktreePath.replace(/\/+$/u, "")}/${HOME_DIR}`;
}

const POD_PREFIX = "bb-";
const PVC_SUFFIX = "-data";
const OBJECT_NAME_MAX = 63;
// `bb-<name>-data` must fit in an object name.
export const MACHINE_NAME_MAX = OBJECT_NAME_MAX - POD_PREFIX.length - PVC_SUFFIX.length;
export const MACHINE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u;

export function isValidMachineName(name: string): boolean {
  return name.length > 0 && name.length <= MACHINE_NAME_MAX && MACHINE_NAME_PATTERN.test(name);
}

export function podNameForMachine(name: string): string {
  return `${POD_PREFIX}${name}`;
}

export function pvcNameForMachine(name: string): string {
  return `${POD_PREFIX}${name}${PVC_SUFFIX}`;
}

// Label values must be ≤ 63 chars of [a-z0-9A-Z-_.] starting and ending
// alphanumeric. Keys are opaque strings from core, so normalize them.
export function keyLabelValue(key: string): string {
  const cleaned = key
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "");
  const value = cleaned.slice(0, OBJECT_NAME_MAX).replace(/[^A-Za-z0-9]+$/gu, "");
  return value.length === 0 ? "machine" : value;
}

function commonLabels(name: string, key: string): Record<string, string> {
  return {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.machine]: name,
    [LABELS.key]: keyLabelValue(key),
  };
}

export interface PvcSpecInputs {
  name: string;
  key: string;
  namespace: string;
  settings: Pick<ResolvedSettings, "volumeSize" | "storageClass">;
  now: number;
}

export interface PvcManifest {
  apiVersion: "v1";
  kind: "PersistentVolumeClaim";
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  spec: Record<string, unknown>;
}

export function renderPvcManifest(inputs: PvcSpecInputs): PvcManifest {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: pvcNameForMachine(inputs.name),
      namespace: inputs.namespace,
      labels: commonLabels(inputs.name, inputs.key),
      annotations: { [ANNOTATIONS.createdAt]: new Date(inputs.now).toISOString() },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: inputs.settings.storageClass,
      resources: { requests: { storage: inputs.settings.volumeSize } },
    },
  };
}

// A minted, ephemeral, single-use key plus the image to redeem it with. Null
// when the machine has no tailnet identity — either this install has no
// minter, or nothing in the tailnet policy has admitted this machine yet, so
// its tag does not exist. The pod is otherwise identical; it just has no cluster access.
export interface TailnetAttachment {
  authKey: string;
  image: string;
}

export interface PodSpecInputs {
  name: string;
  key: string;
  namespace: string;
  image: string;
  resourceClass: ResourceClass;
  settings: Pick<ResolvedSettings, "worktreePath" | "nodeSelector" | "tolerations">;
  tailnet: TailnetAttachment | null;
  now: number;
}

// Deliberately small and fixed. The sidecar shuffles packets for one kubectl
// at a time, and every machine pod pays for it against the namespace quota.
const TAILSCALE_RESOURCES = {
  requests: { cpu: "25m", memory: "64Mi" },
  limits: { cpu: "500m", memory: "128Mi" },
} as const;

function tailscaleContainer(machineName: string, tailnet: TailnetAttachment) {
  return {
    name: TAILSCALE_CONTAINER,
    image: tailnet.image,
    env: [
      { name: "TS_AUTHKEY", value: tailnet.authKey },
      { name: "TS_USERSPACE", value: "true" },
      // The key is single-use: redeem it once and do not try to re-auth with
      // a spent key if tailscaled restarts.
      { name: "TS_AUTH_ONCE", value: "true" },
      // No MagicDNS in the pod's resolv.conf. The proxy resolves tailnet
      // names itself, so kubectl still reaches the operator by name, and the
      // agent's ordinary DNS is left alone.
      { name: "TS_ACCEPT_DNS", value: "false" },
      { name: "TS_HOSTNAME", value: podNameForMachine(machineName) },
      { name: "TS_STATE_DIR", value: TAILSCALE_STATE_DIR },
      // Inside a cluster containerboot defaults this to "tailscale" and then
      // builds a kube client to keep state in that Secret, which dies at boot
      // because the pod mounts no ServiceAccount token. Explicitly empty turns
      // Secret storage off.
      { name: "TS_KUBE_SECRET", value: "" },
      // An ephemeral key alone only gets the node reaped some time after it
      // goes quiet, so a resume inside that window finds the hostname taken
      // and joins as <name>-1. tailscaled logs out on SIGTERM, freeing the
      // name at once, only when it was started with in-memory state — which
      // containerboot does not pass once TS_STATE_DIR is set.
      { name: "TS_TAILSCALED_EXTRA_ARGS", value: "--state=mem:" },
      { name: "TS_SOCKET", value: `${TAILSCALE_RUN_DIR}/tailscaled.sock` },
      { name: "TS_OUTBOUND_HTTP_PROXY_LISTEN", value: TAILNET_PROXY_LISTEN },
    ],
    volumeMounts: [
      { name: TAILSCALE_STATE_VOLUME, mountPath: TAILSCALE_STATE_DIR },
      { name: TAILSCALE_RUN_VOLUME, mountPath: TAILSCALE_RUN_DIR },
    ],
    resources: TAILSCALE_RESOURCES,
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    },
  };
}

export interface PodManifest {
  apiVersion: "v1";
  kind: "Pod";
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  spec: Record<string, unknown>;
}

export function renderPodManifest(inputs: PodSpecInputs): PodManifest {
  const limits = {
    cpu: inputs.resourceClass.limits?.cpu ?? inputs.resourceClass.cpu,
    memory: inputs.resourceClass.limits?.memory ?? inputs.resourceClass.memory,
  };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podNameForMachine(inputs.name),
      namespace: inputs.namespace,
      labels: commonLabels(inputs.name, inputs.key),
      annotations: { [ANNOTATIONS.createdAt]: new Date(inputs.now).toISOString() },
    },
    spec: {
      automountServiceAccountToken: false,
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 30,
      ...(Object.keys(inputs.settings.nodeSelector).length > 0
        ? { nodeSelector: inputs.settings.nodeSelector }
        : {}),
      ...(inputs.settings.tolerations.length > 0
        ? { tolerations: inputs.settings.tolerations }
        : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1001,
        runAsGroup: 1001,
        fsGroup: 1001,
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes: [
        {
          name: "data",
          persistentVolumeClaim: { claimName: pvcNameForMachine(inputs.name) },
        },
        {
          name: "kube-ca",
          configMap: {
            name: KUBE_ROOT_CA_CONFIGMAP,
            items: [{ key: "ca.crt", path: "kube-ca.crt" }],
          },
        },
        ...(inputs.tailnet !== null
          ? [
              { name: TAILSCALE_STATE_VOLUME, emptyDir: {} },
              { name: TAILSCALE_RUN_VOLUME, emptyDir: {} },
            ]
          : []),
      ],
      containers: [
        {
          name: AGENT_CONTAINER,
          image: inputs.image,
          // No command: the base agent image's entrypoint waits for
          // bootstrap and then runs the daemon in the foreground.
          env: [
            { name: "BB_WORKTREE_PATH", value: inputs.settings.worktreePath },
            { name: "HOME", value: homePathFor(inputs.settings.worktreePath) },
            // kubectl defaults to ~/.kube/config, which is not the one the
            // image ships.
            { name: "KUBECONFIG", value: KUBECONFIG_PATH },
          ],
          volumeMounts: [
            { name: "data", mountPath: inputs.settings.worktreePath },
            // subPath mounts just the file, so the image's own /etc/bb
            // (kubeconfig and friends) stays visible beside it.
            {
              name: "kube-ca",
              mountPath: KUBE_CA_MOUNT_PATH,
              subPath: "kube-ca.crt",
              readOnly: true,
            },
          ],
          resources: {
            requests: { cpu: inputs.resourceClass.cpu, memory: inputs.resourceClass.memory },
            limits,
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
        },
        ...(inputs.tailnet !== null ? [tailscaleContainer(inputs.name, inputs.tailnet)] : []),
      ],
    },
  };
}

export function labelSelectorForKey(key: string): string {
  return `${LABELS.managedBy}=${MANAGED_BY},${LABELS.key}=${keyLabelValue(key)}`;
}
