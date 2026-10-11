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
| `linear_watch_issue` | Watch an issue: the thread is messaged when it changes or someone else comments. Needs `BB_HOOKS_URL`. |

Writes are deliberately named tools rather than a raw mutation tool, so the
thread's timeline says what changed. Everything runs as the connected user
(`actor=user`), so comments and state changes are attributed to the
developer, like `gh`. Issues and comments a thread writes carry the
thread's id so a reader in Linear can find the conversation.

## Watching an issue

A thread that has nothing to do until a ticket moves (a question asked of
the reporter, a PR waiting on review in Linear's terms, a parent waiting on
its sub-issues) calls `linear_watch_issue` with the key and ends its turn.
When the issue changes, the thread is sent a message describing the change
and a new turn starts, or the running turn is steered if one is live.

What "changes" means: a different state, assignee, priority, labels, title,
project, cycle, parent, due date or estimate (each reported as `old → new`),
an edited description (reported as edited, without a diff), and new comments
by anyone other than the watching thread itself, with author and body (long
bodies trimmed). Comments the thread wrote carry its signature, so they are
left out; comments from other threads count. One message carries everything
since the thread last looked, however many webhooks it took.

How it wakes: the plugin keeps a durable watch per thread and issue in its
SQLite (what it last saw, and cursors on `updatedAt` and the newest comment),
and subscribes to [bb-gate-hooks](../../bb-gate/docs/hooks.md), the one
public endpoint that receives Linear's webhooks. It proves each watch with
the developer's own access token, renews the lease every 30 minutes, and
when the service rings for an issue it re-reads it as the developer,
compares it with the snapshot, and messages the thread only if something
is new. A doorbell is a latency optimization, not the source of truth:
every watch is also re-checked when the stream connects, after a renewal
that failed or ran late, every ten minutes while leased, and every two
minutes while the service is unreachable. A stream silent for a minute
(the service sends a keepalive every 20 seconds) is dropped and reopened.
If the service reports that Linear refused the token itself, the plugin
refreshes it and retries once; nothing is dropped for that. Nothing is
ever reported twice.

Limits and cleanup: ten watches per thread; the eleventh is refused.
Watching an issue twice is a no-op. A watch expires a week after it last
woke the thread (or was created). Archiving or deleting the thread drops
its watches, as does a wake that finds the thread gone. If the issue stops
being visible to the connected user, the thread is told once and the watch
is dropped. There is no unwatch tool and no UI. Disconnecting Linear stops
the subscription; connecting again resumes it.

`BB_HOOKS_URL` is the cluster-internal address of bb-gate-hooks
(`http://bb-gate-hooks.bb-gate-production.svc:8081` in bb-gate's backend
template). It is read from the server's environment only; there is no
setting. Without it, `linear_watch_issue` returns an error saying watching
is not available on this server, no background service is started, and
the other tools work as before. There is deliberately no polling fallback:
re-reading the issue later is what the agent would do anyway.

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

| Environment | Meaning |
|---|---|
| `LINEAR_CLIENT_ID` | Default for `clientId`. |
| `BB_HOOKS_URL` | Where bb-gate-hooks listens for subscribers. Enables `linear_watch_issue`. |

## Development

```sh
npm install --legacy-peer-deps
npm run typecheck
npm test
```
