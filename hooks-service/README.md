# hooks-service

One process that takes webhooks in from the internet and rings *doorbells*
out to bb servers. Linear, GitHub, Sentry and Alertmanager deliver webhooks
to it; it verifies each delivery and tells the bb servers that asked about
that entity that something changed, nothing more. The bb server then fetches
the entity with its own credential and decides what to do. It is the service
side of the `linear`, `github-watcher`, `slack` and `stewards` plugins.

The wire contract — every path, payload, doorbell, lease and stream frame —
is in [`docs/hooks.md`](docs/hooks.md).

It is a single Go binary with no database and no Kubernetes client. The only
thing it writes to disk is the optional per-workspace Linear token store
(`-linear-token-store`); everything else — leases, identities, sessions and
the verification cache — is in memory.

## Run it

Run one process behind any reverse proxy or tunnel:

```sh
hooks-service \
  -listen :8080 \
  -subscribe-listen :8081 \
  -ops-listen :9090 \
  -subscribe-token "$BB_HOOKS_SUBSCRIBE_TOKEN" \
  -public-base-url https://bb.example.com
```

* **8080 is public.** Expose one path per source through the ingress or
  tunnel (`/linear`, `/github`, `/sentry`, `/alertmanager`, `/slack`,
  `/slack/interactivity`). The service must be reachable at the hostname you
  give each provider, over HTTPS.
* **8081 is private.** It carries the subscriber API — `POST /v1/subscribe`,
  `POST /v1/identify`, the `GET /v1/events` stream and the Slack/Linear
  session routes. bb servers reach it directly; nothing else should. Keep it
  off the public listener.
* **9090 is the health endpoint** (`/healthz`), for a kubelet or a load
  balancer.

**Subscriber authentication.** `-subscribe-token` (or
`BB_HOOKS_SUBSCRIBE_TOKEN`) is a bearer token every request to the 8081 API
must present; the bb server sends it as `BB_HOOKS_TOKEN` beside
`BB_HOOKS_URL`. If the token is unset, the service starts only when 8081 is
bound to loopback, and otherwise refuses to start, unless
`-subscribe-allow-unauthenticated` is passed. That opt-out exists for a
deployment whose 8081 is reachable only from its own pods (namespace
isolation); do not use it when the port is exposed.

Adapters turn on as their credentials appear: an adapter with no signing
secret is disabled and logs one line, and the rest of the service keeps
serving. Secrets may be given directly (`LINEAR_WEBHOOK_SECRET`,
`GITHUB_WEBHOOK_SECRET`, `SENTRY_WEBHOOK_SECRET`,
`ALERTMANAGER_WEBHOOK_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`,
`SLACK_CLIENT_SECRET`, `LINEAR_CLIENT_SECRET`) or as a `*-file` flag pointing
at a file that is re-read on every use, so a mounted secret can appear or
rotate without a restart.

## Flags and environment

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `-listen` | | `:8080` | public listener: one path per source |
| `-subscribe-listen` | | `:8081` | subscriber API listener; keep private |
| `-ops-listen` | | `:9090` | health listener (`/healthz`) |
| `-subscribe-token` | `BB_HOOKS_SUBSCRIBE_TOKEN` | | bearer token required on the subscriber API; unset requires loopback or the opt-out below |
| `-subscribe-allow-unauthenticated` | | `false` | allow the subscriber API on a non-loopback address with no token (namespace-isolated deployments only) |
| `-lease` | | `60m` | how long an admitted watch lasts without renewal |
| `-verify-cache` | | `5m` | how long a successful verification is remembered; `0` disables |
| `-sentry-verify-cache` | | `6h` | how long a successful Sentry verification is remembered; `0` uses `-verify-cache` |
| `-sentry-verify-stale` | | `24h` | how long past `-sentry-verify-cache` an expired Sentry verification may be served while rate limited; `0` disables |
| `-linear-api` | | `https://api.linear.app/graphql` | Linear GraphQL endpoint for verification fetches |
| `-linear-secret-file` | `LINEAR_WEBHOOK_SECRET` | | Linear webhook signing secret; the flag names a file that is re-read on use |
| `-linear-client-id` | `LINEAR_CLIENT_ID` | | the Linear application's OAuth client id, for minting the app token |
| `-linear-client-secret-file` | `LINEAR_CLIENT_SECRET` | | the application's client secret; the flag names a file that is re-read on use |
| `-linear-token-url` | | `https://api.linear.app/oauth/token` | Linear OAuth token endpoint |
| `-linear-app-scope` | | `read write app:mentionable` | scope set for the app token; changing it revokes existing app tokens |
| `-linear-token-store` | `LINEAR_TOKEN_STORE` | | file for per-workspace Linear app token pairs (0600); empty keeps them in memory |
| `-linear-allowed-workspaces` | `LINEAR_ALLOWED_WORKSPACES` | | comma-separated Linear organization ids an admin may install bb into |
| `-linear-install-redirect-url` | `LINEAR_INSTALL_REDIRECT_URL` | | registered OAuth redirect URI for the per-workspace install callback; no default |
| `-session-ack-budget` | | `8s` | how long routing and acknowledging a Linear agent session may take (Linear's limit is 10s) |
| `-github-api` | | `https://api.github.com` | GitHub REST root for verification fetches |
| `-github-secret-file` | `GITHUB_WEBHOOK_SECRET` | | GitHub webhook signing secret; the flag names a file that is re-read on use |
| `-sentry-api` | | `https://sentry.io/api/0` | Sentry REST root for verification fetches |
| `-sentry-secret-file` | `SENTRY_WEBHOOK_SECRET` | | Sentry webhook signing secret; the flag names a file that is re-read on use |
| `-alertmanager-api` | `ALERTMANAGER_API` | | Alertmanager v2 API root; empty turns the adapter off |
| `-alertmanager-secret-file` | `ALERTMANAGER_WEBHOOK_SECRET` | | Alertmanager webhook bearer token; the flag names a file that is re-read on use |
| `-slack-secret-file` | `SLACK_SIGNING_SECRET` | | Slack signing secret; the flag names a file that is re-read on use |
| `-slack-bot-token-file` | `SLACK_BOT_TOKEN` | | Slack bot token; the flag names a file that is re-read on use |
| `-slack-client-id` | `SLACK_CLIENT_ID` | | the Slack app's OAuth client id, for Sign in with Slack |
| `-slack-client-secret-file` | `SLACK_CLIENT_SECRET` | | the Slack app's OAuth client secret; the flag names a file that is re-read on use |
| `-slack-redirect-url` | `SLACK_REDIRECT_URL` | | registered Slack OAuth redirect URI: the plugin's callback on each developer's own server; no default |
| `-public-base-url` | `PUBLIC_BASE_URL` | | public base URL of a developer's bb server, used in the Slack set-up replies; no default |
| `-slack-team-id` | `SLACK_TEAM_ID` | | the Slack app's workspace id; discovered from the bot token when empty |
| `-slack-app-id` | `SLACK_APP_ID` | | the Slack app's id; discovered from the bot token when empty |
| `-slack-api` | | `https://slack.com/api` | Slack Web API root |
| `-v` | | `false` | debug logging |
| | `SENTRY_DSN` | | report the service's own errors to Sentry; unset disables reporting |

## Operator credentials

Everything below is created once by the operator, by hand. Each provider's
callback (payload) URL is on the public listener; each signing secret is an
environment variable or a `*-file` the service re-reads.

### Linear

1. Create a **public** OAuth application (no client secret needed for
   developer connect; a secret is needed only for `@bb` agent sessions).
2. On the application's **Webhooks**, enable the webhook with URL
   `https://<your-hooks-host>/linear` and resource types **Issue** and
   **Comment** (plus **Agent session events** once the app is used as an
   agent). Copy the signing secret into `LINEAR_WEBHOOK_SECRET`.
3. For per-workspace installs, add
   `https://<your-hooks-host>/linear/install/callback` to the application's
   **Redirect URIs** and set `LINEAR_INSTALL_REDIRECT_URL` to it.
4. For `@bb` mentions, add a client secret to the application, set
   `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` (or
   `-linear-client-secret-file`), and let the service mint the home
   workspace's app token with the default scope set. Do not add
   `app:assignable`.

### GitHub

Create one webhook per organization whose repositories threads will watch
(Organization settings → Webhooks → Add webhook):

* **Payload URL** `https://<your-hooks-host>/github`
* **Content type** `application/json`
* **Secret** a value you generate (`openssl rand -hex 32`), into
  `GITHUB_WEBHOOK_SECRET`. One secret serves every organization.
* **Let me select individual events**: **Issues**, **Issue comments**,
  **Pull requests**, **Pull request reviews**, **Pull request review
  comments**, **Pull request review threads**, **Check runs**, **Check
  suites**, **Workflow runs**, **Dependabot alerts**, **Deployments** and
  **Deployment statuses**.

The Dependabot events ring only for repositories with Dependabot alerts
enabled; the deployment events only for repositories where a deployment is
created.

### Sentry

Create an internal integration for the organization (Settings → Custom
Integrations → Internal Integration, or Settings → Developer Settings on a
self-hosted install) with webhook URL
`https://<your-hooks-host>/sentry`, and under **Webhooks** enable **issue**
and **issue alerts**. The integration's client secret goes into
`SENTRY_WEBHOOK_SECRET`.

### Slack

Create one app for the whole team (the agent is one bot named `bb`):

1. **Basic Information → App Credentials**: copy the **Signing Secret**
   (`SLACK_SIGNING_SECRET`), the **Client ID** (`SLACK_CLIENT_ID`) and the
   **Client Secret** (`SLACK_CLIENT_SECRET`).
2. **OAuth & Permissions → Bot Token Scopes**: `app_mentions:read`,
   `im:history`, `im:write`, `mpim:history`, `mpim:write`, `chat:write`,
   `chat:write.customize`, `users:read`, `users:read.email`, `channels:read`,
   `groups:read`, `channels:history`, `groups:history`, `channels:join`,
   `files:read` and `assistant:write`. Under **User Token Scopes**:
   `channels:read` and `groups:read`.
3. **OAuth & Permissions → Redirect URLs**: add the callback on each
   developer's own bb server, e.g.
   `https://<developer-host>/api/v1/plugins/slack/http/signin/callback`,
   and set `SLACK_REDIRECT_URL` to it. Set `PUBLIC_BASE_URL` to that
   server's public base URL for the set-up replies.
4. **Agents & AI Apps**: turn the toggle on and enable the Messages tab.
   Leave Socket Mode off.
5. **Install App → Install to Workspace** and copy the bot token
   (`xoxb-...`) into `SLACK_BOT_TOKEN`.
6. **Event Subscriptions**: **Enable Events**, request URL
   `https://<your-hooks-host>/slack`, and subscribe to bot events
   `message.im`, `message.mpim`, `app_mention`, `message.channels` and
   `message.groups`.
7. **Interactivity & Shortcuts**: enable Interactivity with request URL
   `https://<your-hooks-host>/slack/interactivity`.

### Alertmanager (optional)

Point an Alertmanager receiver at `https://<your-hooks-host>/alertmanager`
with `Authorization: Bearer <token>` matching
`ALERTMANAGER_WEBHOOK_SECRET`, set `-alertmanager-api` to the Alertmanager
v2 API root, and add a route for the namespaces that should ring a
doorbell. With no API root the adapter is off.

## Slack is one server per user

Slack is the one source whose identity is not a per-entity credential: a
Slack user's DM pane reaches *their* bb server. The service therefore binds
one Slack user to one bb server. A second server that tries to sign in as
the same Slack user is refused with `409 {"error":"already-bound"}`, and the
operator must unbind the first before the second can connect. Run the
service per team, with one bot app, and expect this 409 when a user
re-installs.

## Build and release

The `Dockerfile` builds a static binary and ships it on a distroless base:

```sh
docker build -t hooks-service ./hooks-service
docker run --rm -p 8080:8080 -p 8081:8081 \
  -e BB_HOOKS_SUBSCRIBE_TOKEN=... hooks-service
```

The `.github/workflows/hooks-service.yaml` workflow runs `gofmt`, `go vet`
and `go test ./...` for this directory on every push and pull request that
touches it. On a push it builds and pushes
`ghcr.io/<owner>/hooks-service` to GHCR (a `sha-<short>` tag, and `latest`
from the default branch); on a `hooks-service-v*` tag it also attaches the
`linux/amd64` binary to a GitHub Release.

The first publish creates the GHCR package as **private**. Making it public
is a one-time owner step in the package settings, and consumers should pull
it without an image-pull secret only after that.

## License

MIT, as the repository.
