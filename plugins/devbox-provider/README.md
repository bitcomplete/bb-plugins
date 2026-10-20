# Devbox machines

Create [devbox](https://github.com/bitcomplete/devbox) machines from bb.
Connect your devbox project once, then create machines from the plugin's
settings section (Settings → Plugins → Devbox machines) or with
`bb machine create --provider devbox`. bb's own Settings → Machines → Add
machine offers only manual setup, so it does not list Devbox; machines
created here appear there like any other once they exist.

## How it works

```
bb (this plugin) ──Bearer──▶ devbox-gate :8081 (in-cluster) ──your restricted cert──▶ Incus on bertha
```

- **Connect.** Settings → Plugins → Devbox machines → *Connect devbox*
  sends your browser to devbox, which asks you to approve bb. devbox
  redirects back to this plugin's callback with a one-time code, and the
  plugin exchanges it (PKCE) for a token, kept in the `token` secret
  setting. devbox only ever redirects to callback URIs registered in its
  client registry, so this server's must be listed there; see devbox's
  `docs/connect.md`. Disconnect revokes the token.
- **Create.** The plugin creates a container from the `devbox` image with
  the `default` and `devbox` profiles in your project, waits for
  cloud-init, enables lingering for `dev` (bb's daemon is a user service),
  and starts `tailscale up --ssh`.
- **Sign in to Tailscale.** A devbox has to join as *your* node: bb-gate
  routes a daemon to its owner's server by tailnet identity and refuses
  tagged nodes, so there is no key to mint. The sign-in link appears in the
  machine's creation log and in this plugin's settings section. Creation
  waits for it (20 minutes by default).
- **Enroll.** Core installs and enrolls the bb daemon as `dev` over Incus
  exec, through devbox-gate.

| Operation | What happens |
|---|---|
| create | Create (or, on retry, reuse) the container tagged `user.bb.key=<creation key>`, checkpoint, prepare, sign in, bootstrap. |
| suspend | Stop the container. |
| resume | Start it, wait for Tailscale to reconnect (asking for sign-in again only if the login expired), bootstrap with the original key. |
| remove | `tailscale logout`, stop, delete. The disk goes with it. |
| reconcileCleanup | Delete containers whose `user.bb.key` is the creation key. |

Machines persist (`ephemeral: false`); nothing suspends them on its own.

## Usage dashboard

**Devbox machines** in the sidebar shows live usage for every instance in
the connected project, including ones created outside bb (CLI-created
instances are marked as such by their absence of a bb badge). Each card has
CPU (with a sparkline), memory, disk, network in/out and uptime, and the
page marks machines bb manages. The page reads Incus through the same
connection token the rest of the plugin uses; it polls about every 5 seconds
while open and stops when you leave it. Project totals are labelled
**Allocated** because Incus reports the sum of the instances' configured
limits there, not live usage. Nothing is stored on the server: the
sparklines are an in-memory ring buffer that starts empty each visit.

CPU percent needs two samples, so the first poll after the server restarts
(or after an instance restarts) shows no percentage until the next one. A
stopped instance reports disk only. The memory total falls back to the
instance's `limits.memory` when Incus reports host memory; an instance with
no `limits.memory` set has nothing to fall back to and reports whatever
Incus returns.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `devboxUrl` | `https://devbox.boreray-eel.ts.net` | Where the browser approves. |
| `apiUrl` | `http://devbox-gate.devbox-production.svc.cluster.local:8081` | devbox-gate's API listener, as the server reaches it. |
| `clientId` | `bb` | This server's ID in devbox's client registry. |
| `token` | — | Secret. Set by Connect devbox. |
| `image` | `devbox` | Image alias for new machines. |
| `profiles` | `default,devbox` | Profiles for new machines. |
| `signInTimeoutMinutes` | `20` | How long creation waits for Tailscale sign-in. |

Machine inputs: `name?` (Incus name; default `bb-<6 hex>` from the
creation key, so a retry finds the same container) and `image?`.

The server must have a public address (`BB_APP_URL`) for the callback, and
its namespace must be admitted to devbox-gate's port 8081 (devbox's
`bc-prod.yaml`).

## Development

```sh
npm install --legacy-peer-deps
npm run typecheck
npm test
bb plugin build
bb plugin install .
```
