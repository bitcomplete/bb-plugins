---
name: devbox-machines
description: Create, connect, or troubleshoot devbox machines (Incus containers on bertha) as bb machines through the Devbox machines plugin.
---

# Devbox machines

The `devbox-provider` plugin adds the **Devbox** machine provider. A devbox
is an Incus container in the developer's own project on bertha, signed in to
Tailscale as the developer, with the bb daemon enrolled.

## Connect once

The provider reports `setup-required` until devbox is connected. Connecting
is a browser approval and cannot be done by an agent: tell the user to open
Settings → Plugins → Devbox machines → **Connect devbox** and approve on
devbox. The token lands in the plugin's `token` secret setting. Disconnect
in the same place revokes it; so does Disconnect at
https://devbox.boreray-eel.ts.net/connect.

## Create a machine

```sh
bb machine create --provider devbox --inputs '{"name":"mybox"}'
```

Or, for the user: Settings → Plugins → Devbox machines → Create machine
(bb's Settings → Machines → Add machine only offers manual setup). `name` is optional (default `bb-<6 hex>`); `image` overrides the image
alias. Creation waits for the user to **sign the machine in to Tailscale**:
the link is printed in the creation log (`bb machine show <host-id>`) and
listed under Settings → Plugins → Devbox machines. Relay it to the user; do
not open it yourself. Machines signed in with a tag are refused, because
bb-gate only routes person-owned nodes.

## Lifecycle

- `bb machine suspend|resume <machine>` stops and starts the container.
- `bb machine remove <machine>` logs it out of Tailscale and deletes the
  container, including its disk.

## Troubleshooting

- `setup-required`: not connected. `unavailable` with "refused the
  connection token": the token was revoked; connect again.
- Stuck at "Waiting for the machine to boot": cloud-init in the container;
  `/var/log/cloud-init-output.log` inside it.
- Stuck at "Sign in to Tailscale": nobody has opened the link. It times out
  after the `signInTimeoutMinutes` setting (20).
