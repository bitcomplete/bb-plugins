# Team setup

The first-run checklist for a bb server behind
[bb-gate](https://github.com/bitcomplete/bb-gate). It lives under Settings →
Plugins → Team setup. The home page carries a one-line summary of it: while
steps remain, a warning icon, what is left and a link to the checklist; once
none do, what is set up. The full checklist never renders on the home page.

| Step | Owned by | Done when | What the button does |
|---|---|---|---|
| Claude or Codex | Account Pool | An enabled account exists and routing for its provider is on | Starts Account Pool's sign-in: claude.ai with a code to paste back, or ChatGPT's device code, polled from here. |
| GitHub | gh on the server host, read by bb core | The built-in GitHub row in Environment variables is "logged in" (or overridden by your own `GH_TOKEN`) | Runs `gh auth login --web` on the server, shows the device code, waits for GitHub to approve it. |
| devbox | devbox-provider | Connected | Starts devbox-provider's connect; its callback finishes it. |
| Linear | linear | Connected. Optional: a server without it is still complete (unavailable until the server has an OAuth client ID) | Starts the linear plugin's connect; its callback finishes it. |
| Figma | Claude Code on the developer's machine | `figma` is configured at user scope and signed in. Optional: a server that never configures it is still complete (unavailable with no machine, or no `claude` on it) | Runs `claude mcp add --scope user` and `claude mcp login` on the machine, shows the authorization URL, and replays the pasted `http://localhost:<port>/callback` URL against Claude Code's listener. |
| A machine | bb | Any machine exists | Links to Devbox machines. |

The GitHub step is the point. bb core forwards the server host's gh login to
every machine as `GH_TOKEN`, a git credential helper and a commit identity,
but a bb-gate server has no terminal to run `gh auth login` in. The plugin
spawns it headless, parses the one-time code gh prints, and the login lands
in `GH_CONFIG_DIR` on the data volume where it survives restarts. After
sign-in it checks membership of the `githubOrg` setting (default
`bitcomplete`) and warns about a personal account.

No credential passes through this plugin: Claude and Codex tokens go to
Account Pool through its RPCs, the devbox token to devbox-provider, the
Linear tokens to the linear plugin, and the GitHub token to gh's own file.

## Figma

Figma hosts a remote MCP server at `https://mcp.figma.com/mcp` that gives
Claude Code design context from a pasted Figma link. It signs in with browser
OAuth, and Claude Code's OAuth callback is a loopback listener on the machine
that runs `claude` — behind bb-gate, the developer's devbox, which has no
browser. The Figma step closes that gap the way the GitHub step closes the
terminal gap for `gh auth login`.

The step acts on the primary connected machine through this plugin's host
entry (`host.ts`), which runs where Claude Code does. It pins
`oauth.callbackPort` with `claude mcp add --transport http --scope user`, then
starts `claude mcp login` and shows the authorization URL. The developer opens
that URL on their laptop and approves it; the browser lands on a dead
`http://localhost:<port>/callback?code=…` page, and they paste that address
back into the step. The plugin replays it against Claude Code's own loopback
listener. Only the one-time code passes through the plugin, and it is useless
without the PKCE verifier held by Claude Code; the OAuth token lands in Claude
Code's own store on the machine and is never read by bb.

`claude mcp login` refuses to run without a terminal (it offers the
paste-the-redirect-URL prompt), so the host entry starts it under `script`,
which provides a pseudo-terminal. The step is `optional` until Figma is
configured, `todo` once it is configured or a sign-in is waiting, `done` once
Claude Code is signed in, and `unavailable` when no machine is connected or
`claude` is not on it. A server that never configures it is still complete.

No credential passes through this plugin for Figma either: only the one-time
authorization code, which the browser puts in the callback URL.

The checklist polls only while its page is visible, every ten seconds, or
every three while a GitHub or Figma sign-in is waiting for approval.

## Deployment-wide machine variables

A key an agent CLI needs is only useful on the machine where that CLI runs,
and behind bb-gate no thread runs on the server. So on every start the
plugin copies `FIREWORKS_API_KEY` from the server's own environment (a
Kubernetes Secret in bb-gate's backend template) into Settings →
Environment variables, the encrypted store bb syncs into every connected
machine's daemon. Pi has Fireworks built in and turns it on when that
variable is set, so a developer picks Pi and a Fireworks model and it works,
with nothing to configure and no secret in the devbox image.

The server's value is the source of truth: the row is rewritten on every
start, so a hand edit or deletion lasts until the next restart. A server
without the variable writes nothing. The list of seeded names is
`SEEDED_VARIABLES` in `server.ts`.

## Server update

bb-gate does not restart a developer's server when a new `bb-server` image
lands; its router stages the update and leaves the restart to the
developer, or to its overnight quiet window. This plugin is how the
developer finds out: a "Server update" section on its settings page
(Settings → Plugins → Team setup) that says whether the server is on the
latest build or a new one is staged, with a Restart now button, and one
line at the top of the home page section pointing there while a build is
staged. Nothing is shown inside a thread; a running conversation is the
wrong place to be asked to restart.

The section reads the router's own `GET /_bb-gate/update` (`{pending,
ready}` for the caller's server) from the page, once a minute while visible,
and the button `POST`s there. Then it follows the restart through the same
endpoint, which the router answers while the server is down, and reloads
the page when the server is back. A bb that is not behind bb-gate gets a
404 there and the section says so. No RPC is involved: the endpoint is
on bb's own host, so the request carries the tailnet assertion the gateway
adds, and the plugin's server side knows nothing about it.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `githubOrg` | `bitcomplete` | Organization membership checked after GitHub sign-in. Empty skips it. |

## Development

```sh
npm install --legacy-peer-deps
npm run typecheck
npm test
```
