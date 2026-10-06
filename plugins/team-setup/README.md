# Team setup

The first-run checklist for a bb server behind
[bb-gate](https://github.com/bitcomplete/bb-gate). It sits on the home page
until every step is done, and under Settings → Plugins → Team setup always.

| Step | Owned by | Done when | What the button does |
|---|---|---|---|
| Claude or Codex | Account Pool | An enabled account exists and routing for its provider is on | Starts Account Pool's sign-in: claude.ai with a code to paste back, or ChatGPT's device code, polled from here. |
| GitHub | gh on the server host, read by bb core | The built-in GitHub row in Environment variables is "logged in" (or overridden by your own `GH_TOKEN`) | Runs `gh auth login --web` on the server, shows the device code, waits for GitHub to approve it. |
| devbox | devbox-provider | Connected | Starts devbox-provider's connect; its callback finishes it. |
| A machine | bb | Any machine exists | Links to Devbox machines. |

The GitHub step is the point. bb core forwards the server host's gh login to
every machine as `GH_TOKEN`, a git credential helper and a commit identity,
but a bb-gate server has no terminal to run `gh auth login` in. The plugin
spawns it headless, parses the one-time code gh prints, and the login lands
in `GH_CONFIG_DIR` on the data volume where it survives restarts. After
sign-in it checks membership of the `githubOrg` setting (default
`bitcomplete`) and warns about a personal account.

No credential passes through this plugin: Claude and Codex tokens go to
Account Pool through its RPCs, the devbox token to devbox-provider, and the
GitHub token to gh's own file.

The checklist polls only while its page is visible, every ten seconds, or
every three while a GitHub sign-in is waiting for approval.

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
