---
name: kubernetes-machines
description: Create and use long-lived Kubernetes machines from the kubernetes machine provider; one pod and persistent volume per project, threads as worktrees on it.
---

# Kubernetes machines

A Kubernetes machine is one pod with its own persistent volume in the bb
server's namespace. Threads run on it as git worktrees under the volume's
mount path (default `/workspace`). Core clones the project onto the machine
the first time a checkout is needed there.

- Create: `bb machine create --provider kubernetes --inputs '{"name":"acme-app"}'`.
  Optional inputs: `resourceClass` (a name from the plugin's
  `resourceClasses` setting) and `image` (the name of a project image the
  server is configured with, e.g. `bithub2`; without it the machine runs
  agent-base). The name must be a lowercase DNS label; it becomes the pod
  `bb-<name>` and volume `bb-<name>-data`.
- Image upgrades: the reference is resolved from the server environment
  each time a pod is created, so suspend and resume moves a machine to the
  current build of agent-base or of its project image.
- Threads: start them on the machine with the Worktree environment
  provider (`--environment-provider git-worktree`).
- Limits: set the machine's per-host thread limit explicitly in the
  concurrency plugin; its automatic limit counts node CPUs, not the pod's
  resource class.
- Inspect: `bb machine list --json`; the pod carries `bb/host=<hostId>`,
  so `kubectl get pods -l bb/host=<hostId>` finds it.
- Suspend and resume: suspend deletes the pod and keeps the volume; resume
  recreates the pod and reconnects the same host. Worktrees survive.
- Remove: deletes the pod. The volume is kept unless the plugin's
  `deleteVolumeOnRemove` setting is on; a machine created later with the
  same name reattaches it.
- Credentials the agent uses come from the project's machine environment in
  bb core, not from this plugin.
