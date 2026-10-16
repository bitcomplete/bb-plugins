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

## Several workspaces

A developer in more than one Linear workspace (their own company's and a
client's, say) connects each one: **Connect another workspace** runs the
same approval, and Linear's consent screen picks the workspace. Each becomes
an account named by the workspace's URL key (`acme` in `linear.app/acme`),
and connecting a workspace already connected renews its tokens. Each row in
the settings section has its own Disconnect, and **Make default** chooses
the default account; until one is chosen, the first workspace connected is
the default.

Which workspace a call goes to:

1. The one named by the tool's optional `account` argument (or the CLI's
   `--account`), by URL key or workspace name, ignoring case.
2. Else the workspace that has the team: an issue key's prefix (`OPS` in
   `OPS-7`), or the `team` given to a search or a new issue. Each
   workspace's teams are listed once and remembered, then asked again when a
   key is in none of them, at most once a minute per workspace.
3. Else the default: a search without a team, `linear_query`, or a key no
   workspace claims (a renamed team's old keys still resolve in Linear).

Two workspaces with the same team key are an error that names both and asks
for `account`, not a guess. With one workspace connected none of this
costs anything: every call goes to it and no teams are listed.

Watches remember the workspace the issue was read in, and leases on
bb-gate-hooks are proven per workspace: one stream, one subscribe call per
workspace with that workspace's token. Disconnecting one workspace leaves
its watches in place but unchecked and unleased until it is connected
again. Stewards' teams are leased in the workspace that has them, and a
stewards issue named by UUID is looked for in the workspace it was last
found in, then in the others.

All the tokens live in one secret setting, `accounts`, as JSON, so they
stay in the plugin's 0600 secrets file and never reach the database or a
browser. A token in the old single-token settings (from a build before
several workspaces, or pasted in by hand) is moved into `accounts` the first
time it is needed; the move asks Linear whose it is unless the old build
already knew, and refreshes it first if it has lapsed.

## Tools

| Tool | What it does |
|---|---|
| `linear_issue` | One issue by key: fields, description, latest comments. |
| `linear_search` | Issues by free text, team, state, assignee. |
| `linear_create_issue` | A new issue in a team: title, description, state, assignee, labels, priority, parent. |
| `linear_comment` | A Markdown comment, signed with the thread id. |
| `linear_update_issue` | Change an issue's state, assignee, labels, priority and description together. A new description is signed with the thread id. |
| `linear_query` | Any read-only GraphQL query. Mutations are refused. |
| `linear_watch_issue` | Watch an issue: the thread is messaged when it changes or someone else comments. Needs `BB_HOOKS_URL`. |

Every tool takes an optional `account`; see "Several workspaces".

Writes are deliberately named tools rather than a raw mutation tool, so the
thread's timeline says what changed. Everything runs as the connected user
(`actor=user`), so comments and state changes are attributed to the
developer, like `gh`. Issues, descriptions and comments a thread writes
carry the thread's id so a reader in Linear can find the conversation.

## Stewards

The [stewards](../stewards) plugin gives a labelled ticket a long-lived
thread, and reads Linear through this plugin. The contract is
`source-contract.ts`, copied byte for byte into linear, github and stewards:

- `sourceSnapshot` — one issue, by key or UUID, as stewards' snapshot:
  fields, sub-issues, the newest fifty comments with the thread each is
  signed by, and the GitHub pull requests attached to it.
- `sourceValidate` — whether a project's teams exist, carry its label and
  have the states its playbooks name; and the teams the connected user is
  in, for `bb stewards init`.
- `sourceAdoptable` — open issues carrying the label in those teams, oldest
  first, for the nightly pass.
- `sourceSetInterest` — the teams and issues stewards manages. Only
  stewards may call it. The set is kept in kv, leased on bb-gate-hooks (a
  `team` lease per team, an `issue` lease per issue, beside the watches'),
  and every doorbell for one of those issues, or for any issue in one of
  those teams, is passed on to stewards as a ring, debounced per issue.
  Without stewards installed the ring is dropped quietly.

A steward writes through the same tools as any thread, signed the same way.

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
is dropped. There is no unwatch tool; a watch can be stopped from the
Watches settings section. Disconnecting Linear stops the subscription;
connecting again resumes it.

### Seeing what is watched

Settings → Plugins → Linear → Watches lists every watch on this server, and
`bb linear watches` prints the same view. It is a debugging view, made to
answer "why did my thread never wake" and "what is re-reading Linear every
ten minutes" at a glance:

- A status line for the doorbell stream: connected and leased, reconnecting
  (checks fall back to a sweep every two minutes, so reads go up), or
  stopped, how long it has been so, and how many doorbells and sweeps the
  last hour saw.
- A line for what stewards asked to have leased beside the watches (see
  "Stewards"): its teams by key, and its issues counted, listed by key only
  when opened. Anything it asked for that is not leased is called out under
  it with the reason: a team the connected user cannot see, an issue key not
  resolved yet or not visible, or a lease bb-gate-hooks refused in the last
  hour. The CLI names at most twenty issues; `--json` has them all.
- One row per watch: the issue (linking to Linear, with the state the watch
  last saw), the thread (linking to it), age, how many times it has been
  checked and woken, wakes in the last hour, when it last woke, when it
  expires, and flags. A Stop button forgets the watch without telling the
  thread.
- Flags, which sort to the top: `noisy` (five or more wakes in the last
  hour: the ticket is restarting the thread's turn again and again), `idle`
  (three days old and not woken in three days: a wait somebody forgot, still
  read every ten minutes), `expiring` (forgotten within a day unless it
  wakes). A thread watching eight or more of its ten is called out above
  the table.

Checks and wakes are counted in the watch's row (`checks`, `wakes`,
`last_checked_at`, `last_woke_at`, and the newest fifty wake times for the
rate); doorbell and sweep counts are in memory and start over when the
server does.

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
| `bb linear status [--json]` | Which workspaces Linear is connected to, and as whom. |
| `bb linear issue <key> [--account <key>] [--json]` | One issue, as the tool shows it, or its JSON. |
| `bb linear search [--query <text>] [--team <key>] [--state <name>] [--assignee <who>] [--all] [--limit <n>] [--account <key>] [--json]` | Issues, newest first. Open ones only unless `--state` or `--all`. `--json` prints an array of issue objects. |
| `bb linear query <document> [--variables <json>] [--account <key>]` | A read-only GraphQL query's `data`, as JSON, in the default workspace unless `--account` names another. Mutations are refused. |
| `bb linear watches [--json]` | Every watch on this server with its counters and flags, what stewards has leased, and the doorbell stream's state; see "Seeing what is watched". |

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
| Public | Yes. The plugin uses PKCE and sends no client secret. A developer can connect a workspace other than the one that owns the application only if the application allows installs from other workspaces. |

Then give every server the application's client ID through the
`LINEAR_CLIENT_ID` environment variable, the way thread-briefs takes
`THREAD_BRIEFS_BASE_URL` (in bb-gate, a plain value in the backend template).
The plugin reads it as the `clientId` setting's default, so nobody types it;
a stored setting still wins for a server that connects through a different
application. The ID is not a secret: the application is public and PKCE
protects the exchange. The scopes requested are `read`, `write`,
`issues:create`, `comments:create`.

Linear access tokens last 24 hours. The plugin refreshes one that is within
five minutes of expiry before using it, and once more if Linear answers 401,
each workspace on its own; a refresh that fails is reported to the agent as
"connect again". Disconnect revokes the token at Linear.

A watch on an issue in another workspace is only as prompt as that
workspace's webhooks: bb-gate-hooks hears of it only if the application's
webhook delivers that workspace's events. Without them the watch still
works, through the ten-minute baseline re-check.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `clientId` | `LINEAR_CLIENT_ID` from the server's environment | The Linear OAuth application's client ID. Required before Connect works. |
| `linearUrl` | `https://linear.app` | Where the browser approves. |
| `apiUrl` | `https://api.linear.app` | Token exchange and GraphQL. |
| `accounts` | — | Secret. Every connected workspace's tokens and who they belong to, as JSON. Set by Connect Linear, refreshed by the plugin; do not edit. |
| `accessToken` | — | Secret. Paste a token for one more workspace; the plugin moves it into `accounts` and clears this. Also where builds before several workspaces kept the one token. |
| `refreshToken` | — | Secret. The refresh token for a pasted `accessToken`, if it has one. |

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
