# Kubernetes machine provider

A bb plugin that gives the server long-lived machines: one pod per project
with its own persistent volume, in the namespace the bb server itself runs
in. Threads run on that machine as git worktrees, using bb's bundled
Worktree provider. The plugin provides only the pod and its volume; core
clones the project onto the machine the first time a checkout is needed
there, exactly as it does for any enrolled host.

## Usage

1. Settings → Machines → New machine → **Kubernetes pod**. Enter the
   project's name (this becomes the pod and volume names), optionally a
   resource class. Or from a shell:
   `bb machine create --provider kubernetes --inputs '{"name":"acme-app"}'`.
2. Wait for the machine to show as connected. Core has installed the daemon
   into the pod and enrolled it.
3. Set the machine's per-host thread limit explicitly in the concurrency
   plugin. Its automatic limit counts the node's CPUs, not the pod's
   resource class, so on a large node it will over-admit.
4. Start threads on the machine with the **Worktree** environment provider
   (`--environment-provider git-worktree`). Each thread gets a worktree
   under the volume; the checkout and worktrees survive suspend and, unless
   you say otherwise, removal.

Credentials the agent uses (GitHub token and so on) come from the project's
machine environment in bb core, delivered into the daemon's session, not from
this plugin.

Cluster access is the exception and does come from here: when the server has
tailnet minter credentials, the plugin mints one ephemeral, single-use auth key
per pod and adds a userspace `tailscale` sidecar that redeems it. The pod's tag
is `tag:<prefix>-<machine>`, and the cluster grants it whatever access has
been bound to that tag. Minting is server-side because the client can apply
any tag the minter owns; a pod only ever receives a key narrowed to itself.
The minter is configured with `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_CLIENT_SECRET`
and `TS_TAG_PREFIX` in the server's environment (an OAuth client that owns
`tag:<prefix>-*`); leave them unset and pods simply do not join the tailnet.
The sidecar image comes from the `tailscaleImage` setting.

## Lifecycle

| Operation | What the plugin does |
|---|---|
| `create` | Ensure the PVC `bb-<name>-data` exists (reuse if present). Ensure the pod `bb-<name>` exists (reuse if live; replace if it exited). Checkpoint `{name, key, namespace, podName, pvcName}` with core. Wait for ready, bootstrap the daemon over `pods/exec`, label the pod `bb/host=<hostId>`. |
| `suspend` | Checkpoint the same resource, delete the pod, wait for it to go. The PVC and the enrolled host identity survive. Core stops the daemon first. |
| `resume` | Require the PVC. Recreate the pod from the remembered resource class and the server's current agent image, checkpoint, wait for ready, bootstrap **with the original creation key**, so core restarts the existing host rather than enrolling a new machine. |
| `remove` | Delete the pod. Delete the PVC only when `deleteVolumeOnRemove` is on. Otherwise the volume stays and a machine created later with the same name reattaches it. |
| `reconcileCleanup` | Delete pods carrying the creation key's `bb/key` label. Never deletes a PVC. |

Idempotency is by machine name for the objects and by creation key for the
enrollment. A live pod whose `bb/key` label belongs to a different creation
is refused with "already in use" rather than reused.

The provider is `ephemeral: false`: machines persist until you remove them.
There is no idle auto-suspend in v1; suspend from the Machines page or
`bb machine suspend`.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `resourceClasses` | small/medium/large | JSON map of class name → `{cpu, memory, limits?}`. |
| `defaultResourceClass` | `medium` | Used when the machine inputs name none. |
| `worktreePath` | `/workspace` | Mount path of the persistent volume. Exposed to the container as `BB_WORKTREE_PATH`. |
| `volumeSize` | `20Gi` | PVC request for new machines. Existing PVCs are never resized. |
| `storageClass` | `local-path` | Storage class for new PVCs. |
| `readyTimeoutSeconds` | `300` | How long to wait for the pod to become ready. |
| `deleteVolumeOnRemove` | `false` | Delete the PVC when the machine is removed. |
| `nodeSelector` | `{}` | JSON object of node label → value the pod must match. |
| `tolerations` | `[]` | JSON array of Kubernetes toleration objects. |

Machine inputs: `name` (required; a DNS-1123 label of at most 55
characters, so that `bb-<name>-data` fits an object name), `resourceClass?`.
The class is remembered per machine name in plugin storage so `resume` can
recreate the pod the same way. No secrets are accepted here.

### Agent image and upgrades

The agent image is not a setting or a machine input: every machine pod runs
`BB_K8S_AGENT_IMAGE` from the server's environment, read when the pod is
created. Roll the server with a new value to upgrade. Running pods are left
alone; suspend and resume a machine to move it onto the new image. The
volume and the enrolled host survive, threads running on the machine do not.

Project-specific images are `BB_K8S_AGENT_IMAGE_<NAME>` (name upper-cased,
dashes as underscores); a machine created with the `image` input set to
`<name>` runs that image instead.

### Placing machine pods on a node class

Suppose the nodes reserved for agents carry the label `role=agents` and
the taint `agents=true:NoSchedule`. To steer machine pods there, set
both placement settings:

```json
{"role":"agents"}
```

```json
[{"key":"agents","operator":"Equal","value":"true","effect":"NoSchedule"}]
```

Both are validated as JSON on save and again when the plugin resolves its
settings; the pod spec omits `nodeSelector`/`tolerations` entirely while
they are empty. With `local-path` storage the PVC is pinned to the node it
was first bound on, so a machine whose pod is placed on a different node on
resume will fail to schedule; keep placement stable for the life of the
volume.

## What the pod looks like

- `automountServiceAccountToken: false`, `restartPolicy: Never`.
- Pod and container security contexts satisfy the `restricted` Pod Security
  profile: `runAsNonRoot`, uid/gid 1001, `RuntimeDefault` seccomp, no
  privilege escalation, all capabilities dropped. The image must therefore
  have a user with uid 1001.
- One container, `agent`, running the image's own entrypoint. The base agent
  image's entrypoint is expected to idle until bootstrap installs the daemon,
  then run the daemon in the foreground.
- Volume `data`: the machine's PVC, mounted at the worktree path.
- `HOME` is `<worktree path>/.home`, on that volume. Core installs the daemon
  and the host identity under `$HOME/.bb-machines`, and `resume` restarts that
  installation instead of enrolling again, so a home in the container's own
  filesystem would fail every resume with "Machine installation was not
  found". The agent's logins and dotfiles persist for the same reason.
- The namespace's `kube-root-ca.crt` ConfigMap (key `ca.crt`) is mounted
  read-only at `/etc/bb/kube-ca.crt` with `subPath`, so the image's own
  `/etc/bb/kubeconfig`, which names that file as its
  `certificate-authority`, stays visible. With a `KUBE_TOKEN` from the
  project's machine environment and `KUBECONFIG=/etc/bb/kubeconfig`,
  `kubectl` in the pod can verify the API server. The kubelet mounts the
  ConfigMap; no RBAC is involved.
- `nodeSelector` and `tolerations` from settings, when non-empty.
- Labels: `app.kubernetes.io/managed-by=bb-kubernetes-provider`,
  `bb/machine=<name>`, `bb/key=<creation key>`, and after bootstrap
  `bb/host=<hostId>`. The PVC carries the first three. Annotation
  `bb/created-at` on both.

## How it talks to Kubernetes

The plugin reads the server pod's mounted ServiceAccount
(`/var/run/secrets/kubernetes.io/serviceaccount/{token,namespace,ca.crt}`)
and calls `https://kubernetes.default.svc` with Node's `https` module using
that CA. `pods/exec` is a WebSocket; the plugin uses the `ws` package for it
(the only runtime dependency besides `zod`) because it needs a custom CA and
an `Authorization` header, which Node's built-in WebSocket does not expose.

Exec negotiates `v5.channel.k8s.io` first so it can half-close stdin after
sending the bootstrap bundle. That protocol needs Kubernetes 1.30 or newer;
on older clusters it falls back to v4, where stdin cannot be closed and the
bootstrap will hang until its timeout.

Credentials are read lazily. A server started outside a cluster loads the
plugin and reports the provider as unavailable rather than failing.

## RBAC the server's ServiceAccount needs

Namespace-scoped Role, bound to the bb server's ServiceAccount:

| API group | Resource | Verbs |
|---|---|---|
| `""` | `pods` | `create`, `get`, `list`, `delete`, `patch` |
| `""` | `pods/exec` | `get`, `create` (WebSocket exec is a GET; SPDY exec is a create) |
| `""` | `persistentvolumeclaims` | `create`, `get`, `list`, `delete` |

Nothing cluster-scoped and no `secrets`.

## Later

- **Per-thread dev-server pods** on the same node, mounting the machine's
  PVC by `subPath` at the thread's worktree, so a backend or frontend dev
  server runs beside the agent without sharing its container.
- **Treat the volume as a cache.** Branches are pushed; nothing on the
  volume is the only copy. Losing or deleting it costs a re-clone, so
  replication is not worth building.

## Development

```sh
npm install --legacy-peer-deps   # the published SDK's testing entry has unlisted peers
npm run typecheck
npm test
```

Install into a running server with `bb plugin install .` from this
directory, or from the published repo:

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin kubernetes-provider
```
