# Linear

Connect a developer's Linear account to their bb server once, with OAuth,
and give every thread native tools that read and update issues as them.

The shape is the same as [devbox-provider](../devbox-provider)'s connect:
Settings → Plugins → Linear → **Connect Linear** sends the browser to
Linear, Linear sends it back to this plugin's callback with a code, and the
plugin exchanges the code for tokens that land in secret settings. Every
Linear call is made on the server with that token. A thread sees results,
never the token, so no Linear credential reaches a machine.

The [Team setup](../team-setup) checklist has a Linear row that starts the
same connect.

## Tools

| Tool | What it does |
|---|---|
| `linear_issue` | One issue by key: fields, description, latest comments. |
| `linear_search` | Issues by free text, team, state, assignee. |
| `linear_create_issue` | A new issue in a team: title, description, state, assignee, labels, priority, parent. |
| `linear_comment` | A Markdown comment, signed with the thread id. |
| `linear_update_issue` | Change an issue's state, assignee, labels and priority together. |
| `linear_query` | Any read-only GraphQL query. Mutations are refused. |

Writes are deliberately named tools rather than a raw mutation tool, so the
thread's timeline says what changed. Everything runs as the connected user
(`actor=user`), so comments and state changes are attributed to the
developer, like `gh`. Issues and comments a thread writes carry the
thread's id so a reader in Linear can find the conversation.

## The `bb linear` command

The reads are also a CLI, for code that runs on the server without a thread:
script automations in particular. A cron script has `bb` on its PATH but no
tools, and this is how it polls Linear without a token of its own. The
command runs inside the plugin on the server, so the token never leaves it.

| Command | What it does |
|---|---|
| `bb linear status [--json]` | Who Linear is connected as. |
| `bb linear issue <key> [--json]` | One issue, as the tool shows it, or its JSON. |
| `bb linear search [--query <text>] [--team <key>] [--state <name>] [--assignee <who>] [--all] [--limit <n>] [--json]` | Issues, newest first. Open ones only unless `--state` or `--all`. `--json` prints an array of issue objects. |
| `bb linear query <document> [--variables <json>]` | A read-only GraphQL query's `data`, as JSON. Mutations are refused. |

A dispatcher that spawns a thread per issue in a state, as a script
automation:

```sh
bb linear search --team ENG --state "Build Ready" --json \
  | jq -r '.[] | "\(.identifier)\t\(.title)"' \
  | while IFS=$'\t' read -r key title; do
      grep -qx "$key" dispatched 2>/dev/null && continue
      bb thread spawn --project "$BB_PROJECT_ID" --prompt "Build $key: $title" --json >/dev/null && echo "$key" >> dispatched && echo "dispatched $key"
    done
```

Create it with `--working-directory automation-storage` so the `dispatched`
file lives beside the script rather than in a project checkout. A quiet
tick prints nothing, which the automations plugin records as a silent
skipped run. There are no write commands: a change to an issue
should be made by the thread that did the work, through the tools, so it
is signed and visible in that thread's timeline.

## The OAuth application

One Linear OAuth application serves every developer, because bb-gate puts
every server behind one hostname. Create it once in Linear under Settings →
API → OAuth applications:

| Field | Value |
|---|---|
| Callback URL | `https://<bb host>/api/v1/plugins/linear/http/connect/callback` — for the team, `https://bb.boreray-eel.ts.net/api/v1/plugins/linear/http/connect/callback` |
| Public | Yes. The plugin uses PKCE and sends no client secret. |

Then give every server the application's client ID through the
`LINEAR_CLIENT_ID` environment variable, the way thread-briefs takes
`THREAD_BRIEFS_BASE_URL` (in bb-gate, a plain value in the backend template).
The plugin reads it as the `clientId` setting's default, so nobody types it;
a stored setting still wins for a server that connects through a different
application. The ID is not a secret: the application is public and PKCE
protects the exchange. The scopes requested are `read`, `write`,
`issues:create`, `comments:create`.

Linear access tokens last 24 hours. The plugin refreshes one that is within
five minutes of expiry before using it, and once more if Linear answers 401;
a refresh that fails is reported to the agent as "connect again".
Disconnect revokes the token at Linear.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `clientId` | `LINEAR_CLIENT_ID` from the server's environment | The Linear OAuth application's client ID. Required before Connect works. |
| `linearUrl` | `https://linear.app` | Where the browser approves. |
| `apiUrl` | `https://api.linear.app` | Token exchange and GraphQL. |
| `accessToken` | — | Secret. Set by Connect Linear, refreshed by the plugin. |
| `refreshToken` | — | Secret. Set by Connect Linear. |

## Development

```sh
npm install --legacy-peer-deps
npm run typecheck
npm test
```
