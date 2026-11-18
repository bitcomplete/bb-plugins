# hooks-service: webhooks in, doorbells out

`hooks-service` is the one public endpoint in this deployment. Sources such
as Linear deliver webhooks to it; it verifies each delivery and tells the
developer servers that asked about that entity that *something changed*,
nothing more. The server then fetches the entity with the developer's own
credential and decides what to do, typically waking a thread that is waiting
on it.

It is deliberately not a door to the router. It never proxies, it never
holds a tsjwt assertion, and nothing it receives from the internet reaches a
developer's pod, with one exception: an agent-session wake carries the
text of the `@bb` mention, from a verified Linear delivery and marked
untrusted unless the server's owner wrote it (see "Agent sessions"). The
public hostname routes to this Service only.

## Shape

```
Linear, GitHub, Sentry, Alertmanager ──HTTPS──▶ hooks.example.com  (your ingress or tunnel)
                              │  :8080  verify the delivery, normalize to a doorbell
                              ▼
                         hooks-service
                              │  :8081  cluster-only: subscribe, renew, event stream
                              ▼
   linear and github-watcher plugins in every bb-<dev> pod ──▶ fetch with the developer's token
                                                           ──▶ wake the watching thread
```

Two listeners, plus `/healthz` on the ops port:

| Port | Who | What |
|---|---|---|
| 8080 | the internet, via the ingress | one path per source, each verifying that source's credential |
| 8081 | pods in the namespace | the subscriber API below, and the agent-session identity and reply calls |
| 9090 | kubelet | `/healthz` |

## Doorbells

A doorbell names an entity and nothing else, with two exceptions: a GitHub
`deployment` doorbell carries a `deployment` object and a GitHub
`workflow_run` doorbell carries a `workflow_run` object (both below), because
the deployment's ref and state and the run's workflow, conclusion, URL and
head commit are what a subscriber decides on and they are not in the entity
name. One shape for every source:

```json
{"source": "linear", "kind": "issue", "id": "<uuid>", "unit": "<team uuid>", "action": "update", "at": "2026-10-10T17:02:11Z"}
```

- `source`: which adapter produced it: `linear`, `github`, `sentry` or
  `alertmanager`.
- `kind`, `id`: the entity. Kinds are per source; see the adapter. A
  subscriber must ignore a doorbell whose kind it does not know.
- `unit`: the coarse thing permissions hang off: the team for Linear, the
  repository for GitHub, the project for Sentry, the channel for Slack.
  Empty when the event did not say.
- `action`, `at`: for logs. Subscribers must not branch on them; the
  reaction to any doorbell is "check this entity against what I last saw".
- `deployment`: present only on a GitHub `deployment` doorbell (see the
  GitHub adapter), absent on every other doorbell and from every other
  source.
- `workflow_run`: present only on a GitHub `workflow_run` doorbell (see the
  GitHub adapter), absent on every other doorbell and from every other
  source.

Doorbells are a latency optimization, not a delivery guarantee. Nothing is
queued for a pod that is not connected, and nothing is replayed. A
subscriber that cannot prove it was leased the whole time re-checks its
entities by fetching them; see "What the subscriber must do".

## Authorization: prove it with the credential

Plugin code runs on a developer's own server, so nothing it *says* is
trusted. What is trusted is a credential it legitimately holds. To watch an
entity the subscriber sends the developer's access token for that source;
the service fetches the entity with it, read-only, and admits the watch only
if the fetch succeeds. Then it forgets the token. A modified plugin can
present nothing the developer could not already read.

Admission is a **lease**, 60 minutes by default. The subscriber renews at
half-life with whatever token it currently holds, which re-proves access.
A lease the subscriber stops renewing simply expires. Leases live in memory
only, keyed by connection: a restart of either side drops them all and the
subscriber re-sends its watch set. There is no persistence anywhere in this
service, and there must not be: persisting a lease would let it outlive the
token that proved it.

Two sources are not proved by fetching an entity with the subscriber's own
token. Slack session leases are proved by the capability the wake delivered
(see "Slack agent"). Alertmanager has no per-user tokens at all, so a
namespace watch is admitted by the in-namespace subscriber API plus a
reachability read of the Alertmanager API, and no token is sent; see the
Alertmanager adapter for why that is weaker and why it is accepted here.

A per-entity cache (5 minutes, keyed by a hash of the token plus the entity)
makes a renewal of many watches cheap. Entries are never written to disk.

## Subscriber API (port 8081)

When a subscriber bearer token is configured (`-subscribe-token`, or
`BB_HOOKS_SUBSCRIBE_TOKEN`), **every** request on this listener must carry
`Authorization: Bearer <token>`. A missing or wrong token is 401 with no
detail, and the token is compared in constant time. The check covers the
event stream, `/v1/subscribe`, `/v1/identify`, the Linear reply endpoint and
the Slack endpoints alike.

With no token configured the listener is open, and the service allows that
only when it is bound to loopback (for example
`-subscribe-listen=127.0.0.1:8081`) or when the operator passes the explicit
`-subscribe-allow-unauthenticated` opt-out for a namespace-isolated
deployment; otherwise it refuses to start. A namespace-isolated deployment
passes the opt-out, so its subscriber API is unchanged (8081 is reachable
only from its own pods).

### `GET /v1/events` — the stream

Server-sent events. The first event is

```
event: hello
data: {"connection":"c_7f3a...","leaseSeconds":3600}
```

The `connection` id is what `/v1/subscribe` binds leases to. Then, for every
admitted lease that an incoming webhook matches:

```
id: 42
event: doorbell
data: {"source":"linear","kind":"issue","id":"...","unit":"...","action":"update","at":"..."}
```

A comment line (`: keepalive`) every 20 seconds, guaranteed, keeps
intermediaries from closing an idle stream and lets a subscriber treat a
minute of silence as a dead stream and reconnect. When the stream closes, for any reason, every lease
bound to it is gone. The subscriber reconnects, gets a new `hello`, and
subscribes again. `id` is a per-connection sequence; it is reserved for
replay on reconnect, which this version does not do.

The service ends every stream itself when it shuts down, so a rollout moves
subscribers to the new pod within their reconnect backoff rather than at the
old pod's deadline. One address (one pod) may hold at most 8 streams; the
ninth is refused with 429. A subscriber needs one.

### `POST /v1/subscribe` — admit or renew watches

```json
{
  "connection": "c_7f3a...",
  "source": "linear",
  "token": "<the developer's access token for this source>",
  "watches": [{"kind": "issue", "id": "<uuid>"}, {"kind": "team", "id": "<uuid>"}]
}
```

The service verifies every watch concurrently with the token, admits the
ones that verify, binds them to the connection, and answers:

```json
{
  "leases":   [{"kind": "issue", "id": "...", "unit": "...", "expiresAt": "2026-10-10T18:02:11Z"}],
  "rejected": [{"kind": "issue", "id": "...", "reason": "forbidden"}]
}
```

- The call is an upsert. A watch already leased on this connection has its
  expiry moved forward; one not mentioned is left to expire on its own; one
  named twice is one watch. There is no unsubscribe: an entity the
  subscriber no longer cares about stops being renewed and is gone within a
  lease.
- A lease is bound to the entity **as the source names it in doorbells**,
  which is what `leases[].id` reports. Linear accepts an issue key where an
  id is expected, so a watch sent as `ENG-123` verifies and comes back
  leased under the issue's UUID. Subscribers should still send UUIDs; the
  canonical id in the answer is what to match doorbells against.
- `reason` is `forbidden` (the source refused or did not find it; the two are
  not distinguished, on purpose), or `unverifiable` (the source could not be
  reached). An `unverifiable` watch is not admitted; the subscriber retries
  on its next renewal.
- Slack is the one source whose watches are not verified by a fetch at all.
  A watch
  of `kind: "session"` names a Slack conversation and carries the
  `capability` the wake delivered; the connection's bound Slack user is the
  subject, and no token is read. `reason` can then also be `owned`: another
  connection's user already holds the session. See "Slack agent" below.
  Alertmanager watches are not verified by a token either -- its API has no
  per-user tokens -- but a namespace watch is still checked against the
  source by a reachability read, and a rejected one is `forbidden` (not a
  namespace) or `unverifiable` (Alertmanager could not be reached). See
  "Alertmanager" below.
- Status 404 with body `{"error":"unknown-connection"}` means the
  `connection` is unknown: the stream dropped. Reconnect, then subscribe
  again. (A 404 without that body is a wrong URL.) Status 401 means the
  source refused the **token itself**, as distinct from an entity: refresh
  the token and retry, nothing was admitted or dropped. Status 400 is a
  malformed request or an unknown `source`; 413 is more than 100 watches in
  one call; 503 means the source's adapter is not configured. An empty
  `watches` list is valid and answers empty.
- The token is used for the verification fetches in this request and then
  discarded. It is never logged.

### What the subscriber must do

The service promises doorbells only while a lease is current and the stream
is up. The subscriber owns correctness:

1. Keep its own durable watch list and, per watched entity, a cursor: what it
   last saw (for Linear, the issue's `updatedAt` and the newest comment's
   `createdAt`).
2. React to a doorbell by **checking the entity against its cursor**, never by
   trusting the event. The check is idempotent, so duplicates and retries
   are harmless.
3. Run that same check for every watch whenever coverage cannot be proven:
   on every `hello` (which includes the first), after any renewal that failed
   or ran late, and on a slow baseline schedule regardless.
4. Renew at half the lease. With the default lease, every 30 minutes.

## Adapters

An adapter contributes three things: a credential check for its webhooks (a
signature for every source but Alertmanager, which uses a bearer token), a
mapping from a webhook to doorbells, and a "fetch this entity with this
token" used to admit watches. Nothing else differs between sources. Secrets
come from one Kubernetes Secret, `hooks-service`, with one key per source,
mounted as files and re-read on use; an adapter whose key is absent is
disabled and answers 503 until the key appears, so the service can be
deployed before every source is set up and a rotation needs no restart.

### Linear (`POST /linear`)

- **Signature.** `Linear-Signature` is hex HMAC-SHA256 of the raw body with
  the webhook's signing secret (Secret key `linear`). The body's
  `webhookTimestamp` (Unix ms) must be within 60 seconds of now. A failure
  of either is 401 with no detail; a body that verifies but cannot be read
  is 400.
- **Doorbells.** `type: Issue` → `issue` with `data.id`, unit `data.teamId`.
  `type: Comment` → `issue` with `data.issueId`, unit from `data.issue.teamId`
  when present. Every other type, and the `OAuthApp revoked` event, is
  acknowledged and dropped. **Caveat for `team` leases:** a comment
  delivery may not name the issue's team, and then its doorbell has no
  unit and reaches `issue` leases only. A subscriber that watches a team
  should expect to learn of new comments from its baseline re-check, not
  from a doorbell.
- **Kinds.** `issue` (id is the issue's UUID, not its `ENG-123` key; the
  subscriber resolves the key first, which it needs to do anyway to read the
  cursor) and `team` (id is the team UUID). `team` is a lease kind only:
  every Linear doorbell is `kind: issue`, and a `team` lease receives the
  ones whose unit is that team. A stream holding only `issue` leases
  receives doorbells only for those exact ids, whatever their unit.
- **Admission.** `issue(id)` or `team(id)` through the GraphQL API with the
  token as a bearer. A GraphQL error or a null result is `forbidden`.
- **Admission, rate limits.** Linear answers a rate-limited token with a
  coded GraphQL error; that is `unverifiable`, not `forbidden`, so a
  subscriber renewing many watches at once does not lose them.
- **Delivery.** Linear wants a 200 within five seconds and retries three
  times over six hours otherwise. The handler verifies, fans out (in
  memory, microseconds), and answers 200. Enable only Issue and Comment on
  the application's webhook, plus Agent session events for agent sessions
  (below).
- **Agent sessions.** `type: AgentSessionEvent` with action `created` or
  `prompted` is not a doorbell: it goes to the session router in
  "Agent sessions" below, after the same signature and timestamp checks,
  and the 200 does not wait for it. Other actions on that type are
  acknowledged and dropped.

### GitHub (`POST /github`)

- **Signature.** `X-Hub-Signature-256` is `sha256=` and the hex HMAC-SHA256
  of the raw body with the webhook's secret (Secret key `github`). GitHub
  deliveries carry no timestamp, so there is no freshness window: a replay
  is a doorbell for an entity the subscriber re-checks anyway. A missing
  or wrong signature is 401 with no detail; a body that verifies but
  cannot be read is 400.
- **Doorbells.** The event is named by `X-GitHub-Event`. `issues` and
  `issue_comment` → `issue` with `issue.number`; `pull_request`,
  `pull_request_review`, `pull_request_review_comment` and
  `pull_request_review_thread` → `issue` with `pull_request.number`;
  `check_run`, `check_suite` and `workflow_run` → one `issue` doorbell per
  entry in their `pull_requests` list, which GitHub fills for pull
  requests from the same repository and leaves empty for forks. A
  `workflow_run` event with action `completed` and conclusion `failure`,
  `cancelled` or `timed_out` additionally → one `workflow_run` doorbell
  (the issue doorbell for any pull requests it names is unchanged); every
  other action and conclusion is dropped for that kind. A `workflow_run`
  doorbell is how a build that failed or hung between merge and deployment
  reaches a watch that named its workflow.
  `dependabot_alert` with action `created`, `fixed`, `dismissed`,
  `reopened`, `reintroduced`, `auto_dismissed`, `auto_reopened` or
  `withdrawn` →
  `dependabot_alert` with `alert.number`; any other action of that event
  is acknowledged and dropped. `deployment` → `deployment` with
  `deployment.id` and no state, and `deployment_status` → `deployment` with
  `deployment.id` and the status's state; both carry the deployment object
  described under "Kinds" below. Their `action` is `deployment.created` for
  a bare `deployment` event and `deployment_status.<state>` for a status
  (GitHub's own `created` action is not used); it is for logs only, like
  every other doorbell's. The unit is always
  `repository.full_name`. `ping`, `push`, `status` and every other event
  are acknowledged and dropped. A subscriber that wants to
  know when commit statuses (as distinct from check runs) or a fork's
  checks finish learns it from its baseline re-check.
- **Kinds.** Four doorbell kinds, each with a unit lease kind of its own:

  | Doorbell and entity lease | Unit lease | Admitted by |
  |---|---|---|
  | `issue`, id `owner/repo#123` | `repo`, id `owner/repo` | `GET /repos/{owner}/{repo}/issues/{n}`, `GET /repos/{owner}/{repo}` |
  | `dependabot_alert`, id `owner/repo#4` | `dependabot_repo`, id `owner/repo` | `GET /repos/{owner}/{repo}/dependabot/alerts/{n}`, `GET /repos/{owner}/{repo}` then `GET /repos/{owner}/{repo}/dependabot/alerts?per_page=1` |
  | `deployment`, id `owner/repo#7` | `deployment_repo`, id `owner/repo` | `GET /repos/{owner}/{repo}/deployments/{id}`, `GET /repos/{owner}/{repo}` then `GET /repos/{owner}/{repo}/deployments?per_page=1` |
  | `workflow_run`, id `owner/repo#42` | `deployment_repo`, id `owner/repo` | `GET /repos/{owner}/{repo}/actions/runs/{id}`, `GET /repos/{owner}/{repo}` then `GET /repos/{owner}/{repo}/deployments?per_page=1` |

  An `issue` id names an issue or a pull request: the two share one number
  space, and this adapter does not distinguish them. A `dependabot_alert`
  id is the alert's number in the repository's own alert numbering, a
  `deployment` id the deployment's number in the repository's own
  deployment numbering and a `workflow_run` id the run's number in the
  repository's own run numbering, all unrelated to the issue numbers:
  `owner/repo#4` the issue, `owner/repo#4` the alert and `owner/repo#4` the
  deployment are different entities, told apart by `kind`. `repo`,
  `dependabot_repo` and `deployment_repo` are lease kinds only. A `repo`
  lease receives every `issue` doorbell in that repository and **no**
  `dependabot_alert`, `deployment` or `workflow_run` doorbells; a
  `dependabot_repo` lease receives every `dependabot_alert` doorbell in that
  repository and no `issue`, `deployment` or `workflow_run` doorbells; a
  `deployment_repo` lease receives every `deployment` and `workflow_run`
  doorbell in that repository and no `issue` or `dependabot_alert`
  doorbells. They are separate because reading a
  repository does not entitle a token to its alerts or to its deployments,
  and a doorbell must not tell a subscriber what its token could not read.
  A subscriber that wants several holds several.

  **The deployment doorbell.** A `deployment` doorbell carries more than
  the entity, because a deployment is short-lived and
  its ref and state are what a subscriber decides on. Its `deployment`
  object is

  ```json
  {"id": 7, "environment": "production", "ref": "main", "sha": "abc123",
   "state": "success", "url": "https://github.com/owner/repo/actions/runs/9"}
  ```

  - `id` is the deployment's number, the same number the entity id carries.
  - `environment`, `ref`, `sha` are the deployment's, as the event named
    them; `sha` is the commit the deployment resolves `ref` to.
  - `state` is GitHub's deployment-status state: `queued`, `in_progress`,
    `success`, `failure`, `error`, `inactive` or `pending`. It is empty on
    a `deployment` event, which is sent before the first status and carries
    no state of its own; a subscriber treats any deployment doorbell as
    "check this deployment", and the `deployment_status` doorbells that
    follow carry the state.
  - `url` is the best link GitHub gave: the status's `log_url` (the run,
    when the creator set one), then `environment_url`, then `target_url`,
    then the status's own API URL, then the deployment's API URL. A
    subscriber should still fetch the deployment itself to decide whether
    it carries a merge; the doorbell's `url` is for showing a person where
    to look.

  **The workflow_run doorbell.** A `workflow_run` doorbell also carries more
  than the entity, because a failing run is short-lived and its workflow,
  conclusion and commit are what a subscriber decides on. Its `workflow_run`
  object is

  ```json
  {"workflow": ".github/workflows/bb-server.yaml", "name": "bb-server",
   "conclusion": "failure", "url": "https://github.com/owner/repo/actions/runs/42",
   "sha": "abc123", "run_attempt": 2}
  ```

  - `workflow` is the workflow's file path and `name` its name, as the event
    named them; a subscriber matches either.
  - `conclusion` is `failure`, `cancelled` or `timed_out` -- the only
    conclusions that ring this doorbell.
  - `url` is the run's `html_url`, the page a person opens.
  - `sha` is the run's `head_sha`, the commit the run was for.
  - `run_attempt` is which attempt this was; a re-run is a new event with a
    higher attempt, so a subscriber that has already handled attempt 1 can
    tell attempt 2 apart. Nothing else from the event travels: no logs, no
    commit message, no actor, no branch. A subscriber should still fetch
    the run if it needs more than this.
- **Admission.** Through the REST API with the token as a bearer, by the
  reads in the table. The lease is bound to the repository name the answer
  reports, which is the casing doorbells carry, so a watch sent as
  `Owner/Repo#1` comes back leased under `owner/repo#1`. A
  `dependabot_repo` watch reads the repository for that spelling, then
  one page of its alerts as the proof; a `deployment_repo` watch reads it
  then one page of its deployments. An empty page proves as much as a
  full one. Reading a repository's deployments needs `deployments:read`
  (fine-grained) or the `repo` scope (classic), which the `gh` login the
  servers share has; a token without it is `forbidden`. A `workflow_run`
  entity watch reads the run itself
  (`GET /repos/{owner}/{repo}/actions/runs/{id}`), which needs
  `actions:read` (fine-grained) or the `repo`
  scope (classic). A watch on the whole repository instead holds the
  `deployment_repo` lease, whose admission is the deployment read above
  and not the run's own.
- **Admission, alerts.** Reading Dependabot alerts needs more than read
  access to the repository: the token's user must be allowed to see the
  repository's alerts, and the token needs the `security_events` scope (a
  classic token or an OAuth token such as `gh`'s) or Dependabot alerts
  read (a fine-grained one). GitHub answers 403 when the token lacks that
  or alerts are disabled on the repository, and both are `forbidden`.
- **Admission, refusals.** 401 is the token itself (`ErrBadToken`, the
  subscribe answers 401). 404 is `forbidden`: GitHub answers 404 for a
  private repository the token may not see, on purpose, and so does this.
  403 with `X-RateLimit-Remaining: 0`, 429 and 5xx are `unverifiable`.
- **Delivery.** GitHub wants a response within ten seconds and does not
  retry. Configure one webhook per organization, content type JSON, with
  the events listed above (Dependabot alerts, Deployments and Workflow
  runs included);
  the signing secret is the same for every organization because the
  Secret has one `github` key. GitHub sends `dependabot_alert` only for
  repositories with Dependabot alerts enabled, and `deployment` and
  `deployment_status` only for repositories where a deployment is
  created, for example when the operator applies a new image.
  `workflow_run` arrives for every repository in an organization
  whose webhook selects Workflow runs; a push-to-main run has no
  `pull_requests`, so the `workflow_run` doorbell is what a deployment
  watch hears.

### Sentry (`POST /sentry`)

- **Signature.** `sentry-hook-signature` is the hex HMAC-SHA256 of the raw
  body with the internal integration's client secret (Secret key `sentry`).
  Sentry deliveries carry a `sentry-hook-timestamp`, but the signature is
  the whole proof: there is no freshness window, so a replay is a doorbell
  for an entity the subscriber re-checks anyway. A missing or wrong
  signature is 401 with no detail; a body that verifies but cannot be read
  is 400.
- **Doorbells.** The resource is named by `sentry-hook-resource`. `issue`
  (actions `created`, `resolved`, `assigned`, `archived`, `unresolved`) →
  `issue` with `data.issue.id`; `event_alert` (an issue alert, action
  `triggered`) → `issue` with `data.event.issue_id`. The unit is the
  project's slug: `data.issue.project.slug` for an issue, and the slug in
  `data.event.url` (`/api/0/projects/{org}/{project}/events/{id}/`) for an
  issue alert, which names the project only by id. Every other resource
  (`installation`, `metric_alert`, `error`, `comment`, ...) is acknowledged
  and dropped.
- **Kinds.** `issue` (id is the issue id, a string of digits) and `project`
  (id is the project's slug). `project` is a lease kind only: every Sentry
  doorbell is `kind: issue`, and a `project` lease receives the ones whose
  unit is that project. A stream holding only `issue` leases receives
  doorbells only for those exact ids, whatever their project.
- **Admission.** `GET /api/0/issues/{id}/` or
  `GET /api/0/projects/{org}/{project}/` through the Sentry REST API with
  the token as a bearer. A project watch is sent as `org/slug`, because
  Sentry needs the organization to fetch it, and is leased under the
  project's slug, which is what doorbells carry. A project slug is unique
  only within an organization, so two organizations' projects with the same
  slug are the same unit here; a subscriber watching a project it cannot
  read is `forbidden`.
- **Admission, refusals.** 401 is the token itself (`ErrBadToken`, the
  subscribe answers 401). 403 and 404 are `forbidden`: Sentry refuses a
  project the token may not read, and does not distinguish it from a missing
  one. 429 and 5xx are `unverifiable`, so a subscriber renewing many watches
  does not lose them to a rate limit.
- **Delivery.** Sentry wants a response within a few seconds and retries on
  a non-2xx. Configure the internal integration's webhook with URL
  `https://hooks.example.com/sentry` and enable **issue** and
  **issue alerts**; the signing secret is the integration's client secret.

### Alertmanager (`POST /alertmanager`)

- **Credential.** Alertmanager signs nothing. The receiver is configured with
  a bearer token (`http_config.authorization` of the `hooks-service` receiver
  in the operator's Alertmanager config), and
  `Authorization: Bearer <token>` is compared in constant time against the
  `alertmanager` key of the Secret. A missing or wrong token is 401 with no
  detail; a body that verifies but cannot be read is 400.
- **Doorbells.** One `alert` doorbell per entry in the payload's `alerts[]`:
  `id` is the alert's `fingerprint` (stable across the firing and the
  resolved delivery), `unit` is its `labels.namespace` (empty when the alert
  has no `namespace` label), and `action` is the alert's `status`,
  `firing` or `resolved`. An alert with no fingerprint or an unknown status
  is a payload that verified but cannot be read (400); an empty `alerts` list
  is acknowledged and dropped. Everything else in the payload (`version`,
  `groupKey`, `status`, `receiver`, `groupLabels`, `commonLabels`,
  `annotations`, `startsAt`, `endsAt`, `generatorURL`) is dropped: a doorbell
  is a pointer, and the subscriber reads the alert from the API.
- **Kinds.** The doorbell kind is `alert` (id is the fingerprint); the only
  leasable kind is `namespace` (id is the namespace). Every Alertmanager
  doorbell is `kind: alert`, and a `namespace` lease receives the ones whose
  unit is that namespace. A watch of `kind: alert` is refused `forbidden`:
  the adapter does not admit per-alert leases, because the subscriber can
  read the alert from the API itself.
- **Admission.** Alertmanager's v2 API has no authentication and no per-user
  tokens, so a watch is not proved by a credential the subscriber presents.
  Admission is the **in-namespace subscriber API** (port 8081 is reachable
  only from pods in the namespace) plus a read of `GET /api/v2/status` on the
  configured API root (`-alertmanager-api`, no built-in default; the
  operator points it at the Alertmanager service): a namespace watch
  that reaches Alertmanager is leased, and an unreachable Alertmanager is
  `unverifiable`. With no API root the adapter is off. **This is weaker
  than Sentry's per-user proof**, and on purpose: the Alertmanager API is
  unauthenticated, so a doorbell only ever
  points at data the subscriber could already read, and the receiver token is
  a shared secret between Alertmanager and this service, not a per-user
  credential. Handing that token to a pod would add no per-user boundary and
  would only let a pod forge webhooks. The token is never given to a
  subscriber; a namespace watch is sent with no token at all.
- **Admission, refusals.** A watch that is not a `namespace`, or whose id is
  not a Kubernetes namespace name, is `forbidden`. A status read that fails
  (a transport error, a 5xx or any non-2xx) is `unverifiable`, so a
  subscriber renewing during an Alertmanager restart does not lose its
  watches.
- **Delivery.** Alertmanager wants a response within a few seconds and
  retries on a non-2xx. Add a receiver to the operator's Alertmanager
  routing tree: one route matching the namespaces that should ring a
  doorbell, after the Watchdog and `severity="info"` routes (so info alerts
  ring no doorbell), with `continue: true` so it does not replace an
  existing receiver, and `send_resolved: true`. Grouping is the root's
  (`alertname`, `cluster`, `namespace`). Its bearer token must match the
  `alertmanager` key of the hooks service's Secret (or
  `ALERTMANAGER_WEBHOOK_SECRET`); a rotation updates both from that one
  value.

### Slack (`POST /slack`, `POST /slack/interactivity`)

Slack is not a lease adapter: it has no entities to fetch and no watches to
admit, and it contributes no doorbells. Its deliveries are *agent sessions*
(see "Slack agent" below), and its public path is registered by the Slack
service rather than by the adapter loop. Everything else in the public
listener is shared: the same `maxBody`, the same 401-with-no-detail rule.

- **Signature.** `X-Slack-Signature` is `v0=` and the hex HMAC-SHA256 of
  `v0:<X-Slack-Request-Timestamp>:<raw body>` with the team app's signing
  secret (Secret key `slack`). The timestamp must be within five minutes of
  now, in either direction. A missing, malformed, stale or wrongly signed
  delivery is 401 with no detail. `X-Slack-Retry-Num` is ignored: retries
  are deduplicated by `event_id` (below).
- **Handshake.** A `url_verification` delivery, after the same signature
  check, answers the raw `challenge` string with 200.
- **Acceptance.** An `event_callback` is accepted only when its `team_id`
  and `api_app_id` match the configured workspace and app. Those are the
  app's own identity: the workspace and app id are read from the bot token
  (`auth.test`, then `bots.info`) and cached, so the operator never pastes
  them; `SLACK_TEAM_ID` and `SLACK_APP_ID` override discovery if set. A
  delivery for another workspace or app is acknowledged and dropped.
- **Dedupe.** `event_id` is remembered in memory for ten minutes; a repeat
  (Slack's retry, or a duplicate) is acknowledged and dropped. A channel
  reply that tags bb is delivered twice, once as `app_mention` and once as
  `message.channels`/`message.groups`, with different event ids but the
  same channel and message `ts`. Both halves are routed as a tagged
  mention and carry the same `channel:ts` key, so whichever arrives first
  routes at once and the second is dropped by `channel:ts`. An untagged
  message half with a key is held for a short grace so a same-key mention
  can still supersede it (the message half arrived before the bot user id
  was resolved, or tagged the bot in a form the parser does not
  recognize); a held message with no mention routes as an untagged
  follow-up. The state is in memory only, so a restart forgets it, which
  is safe: a wake is idempotent at the plugin and no text is stored here.
- **The ack.** Every accepted `event_callback` is answered 200 before
  anything else happens. Routing, the asker's classification, the no-server
  reply and the wake all run after the response, so the 200 never waits for
  a pod or a Slack API call.
- **Routed events.** A DM (`message` with `channel_type: im`), a channel
  `app_mention`, a channel or private-channel message whose text contains
  `<@botUser>` (`message` with `channel_type: channel` or `group`; it
  routes as a mention even when its thread has no live lease or route), an
  untagged reply in a channel thread bb already follows
  (`message` with `channel_type: channel` or `group`, a `thread_ts`, and a
  live session lease or route for `channel:thread_ts`), and the
  assistant-thread events (`assistant_thread_started`,
  `assistant_thread_context_changed`). A
  message or mention is threaded on `thread_ts` when present, else on its
  own `ts`; an untagged reply is always on its thread's root. A message
  whose subtype is `file_share` — a pasted screenshot or an upload, with or
  without text — is kept, because it is the one that carries the `files`
  below. A DM message's own `message_changed` (an edit) and
  `message_deleted` subtypes are routed too, as `action: "edited"` and
  `action: "deleted"` (below); an edit by a bot or this app is dropped.
  Bots, the app's own messages, every other subtype, an untagged top-level
  channel message, an untagged channel message in a thread with no live
  lease or route, and every other event type are acknowledged and dropped.
  Guests and external (Slack Connect) users are refused at identity
  (below), so they are never bound and never routed. The **first** routed
  wake of a session whose message is a reply in an existing thread also
  carries the thread's earlier messages in `history` (below); a follow-up
  in a live session and a thread bb started carry none.
- **Logs.** A delivery's log line carries the event id and the text's
  length, never the text; the message text is not persisted anywhere. A
  dropped `message.channels`/`message.groups` delivery keeps only an
  aggregate count: its text, user and channel are never logged or stored.

## Agent sessions

Mentioning the bb app user (`@bb`) in a Linear comment opens an *agent
session* on the issue. Linear sends an `AgentSessionEvent` for it
(`created`), and another for every follow-up message in it (`prompted`).
The service routes each event to one developer's server, acknowledges it
on Linear itself, and lets that server reply. Every Linear call for a
session is made **as the app**, with that workspace's app token
(`actor=app`), which only this service holds: the home workspace's token is
minted from the application's client credentials and kept in memory, and
every other workspace's comes from a one-time admin install and is
persisted (see "The app token"). No token is ever sent to a pod; a pod asks
the service to post. The event's `organizationId` picks the workspace; an
event from a workspace with no app token is acknowledged and dropped, with
one log line naming the organization.

### Routing

Each event is routed fresh, by rule, with nothing kept from earlier
events on the same session:

1. The **assignee's** server, if the issue is assigned and the assignee
   has a server identified (below). If none of that server's projects
   lists the issue's team, the session gets an `error` activity saying
   so, and routing **stops**: it does not fall through to the asker.
2. Else the **asker's** server: on `created` the mention's author, on
   `prompted` the follow-up's author. Its teams are not checked here; a
   server with no project for the team says so itself.
3. Else an `error` activity: nobody's bb covers this issue.

"Has a server" means **connected right now**: holding an event stream with
a current identity. There is no mapping file and no record of anyone who
is not connected, so an assignee whose server is restarting or not yet
created is passed over for the asker, or the session gets the error. The
error says "connected right now", and mentioning again once the server is
back routes normally.

The issue's assignee, team and key, and the asker's name, are read with
the event workspace's app token for every event: the webhook does not
reliably carry them.

### The acknowledgement

Linear marks a session unresponsive when nothing is posted within ten
seconds of `created`. The service answers every routed event, `created`
and `prompted`, with a `thought` activity naming whose bb is taking it
("Alice's bb is taking this (the issue's assignee)."), or with the `error`
activity from the rule. It does this itself, within 8 seconds of the
delivery (`-session-ack-budget`), and before the pod is woken, so a slow,
restarting or absent server never leaves the session unanswered. The pod
does not post an acknowledgement.

### Identity: `POST /v1/identify`

A server proves which Linear user it acts for the way a lease is proven:
with that user's own token. The service reads `viewer` with it, and checks
each team the server's projects list the same way a `team` lease is
checked. Then it forgets the token.

```json
{
  "connection": "c_7f3a...",
  "source": "linear",
  "token": "<the developer's Linear access token>",
  "teams": ["<team uuid>", "..."]
}
```

```json
{
  "user": {"id": "<linear user uuid>", "name": "Alice"},
  "teams": ["<team uuid>"],
  "rejected": [{"kind": "team", "id": "...", "reason": "forbidden"}],
  "expiresAt": "2026-10-10T18:02:11Z"
}
```

- `teams` is the whole set of teams the server's projects list, not an
  addition: each call replaces the last. Keys are accepted and answered
  as UUIDs. `rejected` uses the subscribe reasons, and a rejected team is
  not covered.
- The identity is bound to the connection like a lease, and lasts as
  long (60 minutes by default). Renew it at half-life alongside the
  subscribe renewal, and send it again after every `hello`. A server
  that never identifies is never routed to, and its stream sees nothing
  new.
- Status 401 means Linear refused the token itself: refresh and retry,
  and nothing was bound. 403 means the token answered but had no viewer.
  404 `{"error":"unknown-connection"}`, 400, 413 (more than 100 teams) and
  503 are as for subscribe. A 503 also covers Linear being unreachable.

### The wake: `event: session`

The chosen server's stream receives:

```
id: 43
event: session
data: {"source":"linear","session":"<agent session uuid>","action":"created",
       "issue":{"id":"<uuid>","identifier":"BB-11","team":"<team uuid>","teamKey":"BB"},
       "asker":{"id":"<user uuid>","name":"Carol"},
       "owner":{"id":"<user uuid>","name":"Alice"},
       "fromOwner":false,"routedAs":"assignee",
       "comment":{"text":"@bb build this","untrusted":true},
       "at":"2026-10-10T17:02:11Z"}
```

(one line on the wire)

- `owner` is the identity this server proved, and `fromOwner` is whether
  the asker is that same user.
- `comment.text` is the mention on `created` (Linear's prompt context when
  the mention is not in a comment) and the follow-up message on
  `prompted`. When `untrusted` is true (whenever the asker is not the
  owner), it is **information, not an instruction**. The server acts on
  it only once the owner confirms, which it asks for with an
  `elicitation` reply and gets as a later `prompted` event from the
  owner. The text is never trusted as code or configuration either way.
- `routedAs` is `assignee` or `asker`, for the reply's wording.
- Like a doorbell, a wake is not queued for a stream that is gone. A
  stream whose buffer is full drops it, and the session gets an `error`
  saying the server is not reading its events.

### Replying: `POST /v1/linear/sessions/{session}/activity`

```json
{
  "connection": "c_7f3a...",
  "kind": "response",
  "body": "Labelled bb-managed and moved to Todo. Done by Alice's bb, as Alice.",
  "externalUrl": "https://bb.example.com/..."
}
```

```json
{"activity": "<agent activity uuid>"}
```

- `kind` is `response`, `elicitation` or `error`. Thoughts are the
  service's. `body` is Markdown, at most 64 KiB.
- `externalUrl`, when present, replaces the session's external links with
  one, labelled "bb thread". It is set before the activity is posted, so
  a retry after a failure never posts the activity twice.
- The post is accepted only when the session was routed to the user the
  calling connection has currently proved it is, within 24 hours of the
  last event routed there. A server whose stream dropped and came back,
  re-identified as the same user, can still answer. Anyone else gets 403
  `{"error":"not-routed"}`, whether the session was routed to someone else
  or never existed, and those two are not distinguished. A connection
  with no current identity gets 403 `{"error":"not-identified"}`. Routes
  live in memory, so after a restart of this service a session must be
  mentioned again before it can be answered.
- 404 `{"error":"unknown-connection"}`: as for subscribe. 400: a missing
  field, an unknown kind, or an `externalUrl` that is not http(s). 503
  `{"error":"linear-unavailable"}` (Linear could not be reached, or the
  workspace's app token could not be minted or refreshed) or a plain 503
  (client credentials not configured): try later. 502
  `{"error":"linear-refused"}`: Linear refused the post, and nothing
  Linear said is passed back.

  The workspace the reply is posted in is the one stored when the session
  was routed (`remember`); the body carries no workspace and one sent by a
  pod is ignored.

### The app token

A Linear app token (`actor=app`) belongs to exactly one workspace, and the
client-credentials grant carries no way to name one, so the application's
home workspace's token is minted with **client credentials** and every
other workspace needs its own one-time admin install. Both kinds request
the same scope set, `read write app:mentionable`, and neither includes
`app:assignable`.

**The home workspace** is resolved once, on first use: the service mints
the client-credentials token and asks Linear `organization { id }`. That
token is held in memory only, lasts 30 days, and is replaced an hour before
it lapses or at once when Linear refuses it.

**Every other workspace** is installed by one of its admins through
`GET /linear/install` (see "Setting it up in Linear"). The callback
exchanges the authorization code for an `actor=app` access token and a
refresh token, reads the workspace the token belongs to, and stores the
pair **only if the workspace is on the allow-list**:

- **The allow-list** is `LINEAR_ALLOWED_WORKSPACES` on the hooks container
  (`-linear-allowed-workspaces`): a comma-separated list of non-home
  organization ids, empty by default. The home workspace needs no entry.
  An install for an unlisted workspace is refused and stores nothing, and
  an event from one is dropped like an event from a workspace with no
  token. **Adding a workspace is the owner's decision.**
- **The store** is one JSON file, `-linear-token-store`
  (`/var/lib/hooks-service/tokens.json`), on a small ReadWriteOnce PVC
  mounted into the pod. It is written atomically and 0600 and read at
  startup, so an install survives a restart. The Deployment is `Recreate`,
  because a ReadWriteOnce volume cannot be shared by two pods at once.
- **Refreshing** happens an hour before the access token lapses and once
  when Linear answers 401 to it. Linear may rotate the refresh token; the
  answer's pair is stored. A refused refresh is `linear-unavailable`: the
  event is dropped, a reply answers 503 `{"error":"linear-unavailable"}`,
  and the log names the workspace and Linear's error code, never a token.
- **Revoking an install** is removing the workspace from the allow-list:
  the next start deletes its token pair and logs the workspace id. Do it
  together with revoking the app in that Linear workspace, so the refresh
  token cannot be used again.

- **The client id** is public config, the same value `backend.json`
  gives every developer's server: `LINEAR_CLIENT_ID` on the hooks
  container (`-linear-client-id`).
- **The client secret** is the `linear-client-secret` key of the same
  `hooks-service` Secret, mounted at `/etc/hooks-service/linear-client-secret`
  and read at each exchange, so a rotation is picked up with no restart.
  Seal it with `LINEAR_CLIENT_SECRET=<secret> scripts/seal-hooks`, which
  merges it into the existing sealed file.
- **No token, refresh token or code reaches a pod or a log.** The secret
  goes to the token endpoint and nowhere else, a token goes to Linear's
  API in a header and nowhere else, and the log records that a token was
  minted or refreshed, its workspace, scope and lifetime, never its value
  or the secret's.

While the client id and secret are absent, session events are answered 200
and dropped, and replies answer a plain 503; doorbells are unaffected. When
Linear refuses the credentials (a wrong or revoked secret), the log says
`Linear refused the client credentials`, events are dropped the same
way, and replies answer 503 `{"error":"linear-unavailable"}` until the
secret is resealed. A token refused by Linear is replaced once and the
call retried.

**The scope set is settled once.** Linear revokes every app token of the
application when client credentials are requested with a different scope
set than before, so `-linear-app-scope` is left at its default, the install
requests the same set, and there is no `app:assignable`, so bb is
mentionable and never offered as an assignee or delegate.

**On the first rollout, confirm that the home mint does not replace the
other workspaces' installs.** Linear documents the client-credentials
replacement rule as scoped to its own workspace, so the home mint should
leave them alone; the log line at each mint (`app token minted`) and each
refresh (`workspace token refreshed`) is what to watch.

### Setting it up in Linear (by hand, a Linear admin)

1. On the team's existing OAuth application (Settings → API → OAuth
   applications), add a **client secret**. Developer connect is
   unaffected: it is a public PKCE exchange, and the secret is optional
   there.
2. Enable **client credentials** on the application if Linear asks for
   it, and let the first token be minted by this service with its default
   scopes (`read`, `write`, `app:mentionable`). Do not add
   `app:assignable`: it revokes or blocks the token this service holds,
   and bb must not be offered as a delegate.
3. On the same application's **Redirect URIs**, add the value of
   `-linear-install-redirect-url`
   (`https://hooks.example.com/linear/install/callback` on this
   deployment). That flag has no built-in default, so it must be set on
   every deployment. It is the callback the per-workspace install returns
   to.
4. On the same application's webhook, enable the **Agent session events**
   category beside Issue and Comment. It signs with the same secret, so
   the `linear` key needs no change.
5. Seal the client secret (above), commit, and push. Within a minute of
   the key appearing the hooks log shows `app token minted`. Mention
   `@bb` on an issue assigned to someone with a connected server: the
   session shows the acknowledgement, and the log shows `session routed`.
6. **To install bb in another workspace**, the owner first adds that
   workspace's organization id to `LINEAR_ALLOWED_WORKSPACES` in
   the deployment's config (or the flag) and rolls the pod, then an admin
   of that workspace opens
   `https://hooks.example.com/linear/install` and approves the
   application. The callback stores the token pair; the log shows
   `linear workspace installed` with the organization id. **Adding a
   workspace is the owner's decision.** To revoke it, remove the id from
   the list (the next start deletes the token pair and logs
   `removed Linear workspace token`) and revoke the application in that
   Linear workspace.

## Slack agent

One team Slack app named `bb`, installed once by hand, gives every
developer a DM pane with their own bb. It is the same shape as the Linear
agent sessions above: the service holds the app's credentials, routes each
event to one developer's server, and posts replies for it, so no Slack
credential ever reaches a pod. DMs and channel mentions both route; a
conversation's owner is set by the first routed wake and kept, so a later
mention by someone else goes to that owner's server as untrusted (see
"Channel mentions"). Per-message "Alice's bb" naming is a later step.

### Identity: `POST /v1/identify` (`source: "slack"`)

Each developer signs in once from their bb's Slack settings with "Sign in
with Slack". The sign-in now grants the developer's own user token
(`xoxp-`) with the user scopes `channels:read` and `groups:read`, so it can
read the channel lists that developer can see and nothing else. That is what
lets the settings page offer a search-by-name channel picker showing only
what the signed-in developer can see; the app's bot token is never given
channel access on the developer's behalf. The plugin keeps that user token
and presents it, as the Linear plugin does, at every renewal and after every
`hello`:

```json
{
  "connection": "c_7f3a...",
  "source": "slack",
  "token": "<the developer's Sign in with Slack user token>",
  "teams": []
}
```

The service reads the token's own user and workspace with `auth.test`,
checks the workspace against the app's own `team_id`, and forgets the
token. A still-valid OpenID Connect token from a sign-in before this change
is read with `openid.connect.userInfo` instead, so identify accepts both
kinds and nobody is forced to sign out. Either way the user's name is read
with the bot token's `users:read`, and the token itself is never logged,
never put on the event stream and never put in a doorbell. It answers the
same shape as the Linear identify:

```json
{"user": {"id": "U0123", "name": "Alice"}, "teams": [], "rejected": [], "expiresAt": "2026-10-10T18:02:11Z"}
```

- The identity is bound to the connection, so closing the stream drops it
  and the user can then bind a new connection. It also expires with the
  lease interval as a backstop. The plugin re-identifies after every
  `hello` from the token it stored at sign-in, and after every reconnect.
  Only a bound user's DMs are routed. Identify is separate from a session
  lease (see "Leasing a session"): identify proves who a connection is,
  and a session lease is the owner of record for one conversation.
- 401 means the token itself was refused (bad, expired or revoked): sign in
  again. 403 means the token answered but is not acceptable: another
  workspace, a bot or app user, a guest (`is_restricted`,
  `is_ultra_restricted`), or a Slack Connect external user
  (`is_stranger`, or a `team_id` that is not the app's). The user is read
  with the bot token's `users:read`; no email is read and no
  `users:read.email` scope is used. 409 `{"error":"already-bound"}` means
  the user is already bound to a *different* live connection: **Slack is one
  server per user**, and a user may hold one server at a time. 503 is Slack
  unreachable; nothing was bound.
- `teams` is accepted and ignored (it is part of the shared identify body);
  Slack has no unit leases.

### Sign-in: the callback lives on the developer's own server

The token exchange needs the app's **client secret**, which a pod must not
hold, so the exchange happens in hooks-service. The browser redirect,
however, goes to the plugin's callback on the developer's own server:
the value of `-slack-redirect-url`
(`https://bb.example.com/api/v1/plugins/slack/http/signin/callback`
on this deployment; no built-in default).
That host is the router, behind tsjwt, so the request reaches the server of
whoever completed sign-in and no one else's, and the callback runs in the
plugin on that server. This is the browser-bound proof: a different person
opening the authorize link is routed to *their* server, whose connection
does not match the flow's, and the exchange is refused.

1. The plugin calls `POST /v1/slack/signin/start` with its `connection`.
   The service mints a single-use `state` and a PKCE `code_verifier`, binds
   them to that connection for ten minutes, and answers
   `{"authorizeUrl": "https://slack.com/oauth/v2/authorize?...", "state": "..."}`.
   The URL carries `client_id`, `user_scope=channels:read,groups:read`, the
   registered `redirect_uri`, the `state` and the S256 `code_challenge`. It
   asks for no bot `scope`: the bot scopes come from the app's installation,
   not from a developer's sign-in.
2. The developer's browser opens `authorizeUrl` and signs in. Slack
   redirects to the plugin's callback with `code` and `state`. Because the
   redirect is to `bb.example.com`, tsjwt sends it to the browser
   owner's own server.
3. The plugin calls `POST /v1/slack/signin/exchange` (cluster-only, 8081)
   with its `connection`, the `state` and the `code`. The service consumes
   the state only when the state's connection is the caller's connection; a
   different connection is refused `403 {"error":"not-yours"}` **without**
   consuming it, so the server that started the flow can still complete it.
   The service then exchanges the code at `oauth.v2.access` with the client
   secret and the held `code_verifier`, and returns the developer's own
   `authed_user.access_token` (`xoxp-`) as `{"token": "..."}` in that
   response only. The response's `authed_user.id` and `team.id` are the
   identity the token proves. It deletes the flow and keeps nothing after.
4. The plugin keeps the token and presents it to `POST /v1/identify`, and
   again after every `hello`.

The code never leaves the plugin's own server and the hooks service;
the verifier never leaves hooks-service; neither the code, the verifier, the
secret nor the token is logged. A replay after a successful exchange is
refused (the flow is gone), and an expired state is refused. The state is
consumed even when the exchange itself fails on a transient Slack error,
because the code is single-use either way: the plugin should tell the user
to start the sign-in again, not to retry.

`start` and `exchange` are on the cluster-only listener (8081), beside the
other subscriber calls. `start` requires a live connection; `exchange`
requires that same connection, so another pod cannot complete a flow even
if it learns the state. Neither the token nor any Slack credential is ever
put on the event stream or in a doorbell.

**What a pod holds after this change.** Each developer's pod keeps the
user token the exchange returned. It is the developer's own token with the
`channels:read` and `groups:read` user scopes: the pod can read the channel
lists that developer can see, as that developer, and nothing else. Before
this change the pod held an OpenID Connect identity token that reads
nothing. The bot token, the client secret and the signing secret still
never leave hooks-service.

### Bot channel membership: `GET /v1/slack/bot/channels`

`GET /v1/slack/bot/channels` is on the cluster-only listener (8081), beside
the sign-in calls, and reachable only from inside the cluster. It answers
the ids of the channels the app's bot user is a member of, and nothing
else:

```json
{"channels": ["C0123", "G0456"]}
```

The service reads them with the bot token's `users.conversations`
(`types=public_channel,private_channel`, `exclude_archived=true`), following
the `cursor` to the end, and caches the list for a few minutes. It needs the
bot scopes `channels:read` and `groups:read`, which the app's installation
grants. The picker uses the ids only to flag a channel bb still needs an
invite to; the channel *names* the picker shows come from the developer's
own user token calling Slack directly, not from this endpoint. A bot that is
in no channel answers `{"channels": []}`.

### Adding the bot to a channel: `POST /v1/slack/bot/join`

`POST /v1/slack/bot/join` is on the cluster-only listener (8081), beside
the membership read. When a developer maps a channel the bot is not in, the
settings page offers to add bb to it, and the plugin asks this service
rather than the developer typing `/invite @bb` in Slack:

```json
{"connection": "c_7f3a...", "channel": "C0123"}
```

The service requires a live connection that has identified (403
`{"error":"not-identified"}` otherwise, 404 `{"error":"unknown-connection"}`
for a connection it does not know), and `channel` must be a channel id
(`C…` or `G…`), never a name. It then calls `conversations.join` with the
bot token, which needs the bot scope `channels:join` from the app's
installation, and answers `{"ok":true}`; a channel the bot is already in is
a success. The bot token never leaves the service, and no developer token
is involved: joining a public channel is something any workspace member can
make the bot do with `/invite`, so a bound connection is authorization
enough.

- 409 `{"error":"private-channel"}`: a private channel the bot can see.
  Slack lets a bot join only public channels by itself; a member has to
  invite it into a private one, so the plugin tells the developer to
  `/invite @bb` from Slack. A private channel the bot cannot see at all is
  refused by Slack as `channel_not_found` and answers 404
  `channel-not-found` instead.
- 404 `{"error":"channel-not-found"}`, 409 `{"error":"archived"}`: the id
  names no channel the bot can join.
- 409 `{"error":"channel-restricted"}`: the channel does not let the app
  post (`restricted_action_read_only_channel`, `restricted_action` or
  `not_in_channel`), so a mention there could never be answered. The plugin
  warns instead of mapping the channel. A channel Slack lets the bot join but
  not post in is caught on the first post, which falls back to an ephemeral
  reply (see "Replying").
- 503 `{"error":"missing-scope"}`: the app was installed without
  `channels:join`; the README's by-hand setup names the scope and a
  reinstall grants it.
- 502 `{"error":"slack-refused"}` and 503 `{"error":"slack-unavailable"}`
  as for the other Slack calls.

A successful join is added to the cached membership list at once, so the
next `GET /v1/slack/bot/channels` no longer flags the channel. The bot's
own join raises `member_joined_channel`, which the webhook drops, so no pod
hears about a channel the settings page is already mapping.

Every attempt is logged with the connection, the owner it proved (the
Slack user id and display name), the channel id and the outcome (`joined`,
`already-in`, or the refusal above). The line goes through the same
redaction the Sentry path uses, and the bot token is never part of it.

While the OAuth client id or secret is unset, `start` and `exchange`
answer 503 and nothing else is affected.

### Opening a conversation: `POST /v1/slack/conversations`

A thread that needs input from someone in Slack can start the conversation
itself, rather than only reply where a conversation already woke it.
`POST /v1/slack/conversations` is on the cluster-only listener (8081),
beside the other subscriber calls:

```json
{"connection": "c_7f3a...", "text": "Dylan's bb here, on Dylan's behalf: quick question", "users": ["corey", "U0123"]}
{"connection": "c_7f3a...", "text": "Starting a thread", "channel": "C0123"}
```

The connection must have a current Slack identity (403
`{"error":"not-identified"}`, 404 `{"error":"unknown-connection"}`); that
identity is the session's owner. Exactly one of `users` or `channel` is
required, `text` is required and posted verbatim, and a body over 32 KiB is
413.

- **`users`**: each entry is a Slack user id, a name matched
  case-insensitively against the workspace user list read with the bot
  token's `users:read` (`users.list`, cached a few minutes) on the real
  name, the display name and the handle, or an email address (an entry
  containing an `@` and a dot). An email is resolved with
  `users.lookupByEmail` (bot scope `users:read.email`, added by hand — see
  the README) instead of the member list; the address is used for that one
  call and then forgotten, never cached or logged, and a lookup without the
  scope answers 503 `{"error":"missing-scope"}` like `users.list` does. An
  entry that matches nothing is refused 400 `unknown-user` with up to five
  near matches as `candidates` — a case-insensitive prefix or substring on
  the handle, real name or display name — and one that matches more than
  one user is refused 400 `ambiguous-user` with every match. A candidate
  carries `id`, `name` and `handle` and never an email, and nothing is
  opened or posted:
  ```json
  {"error": "ambiguous-user", "name": "alex", "candidates": [{"id": "U0123", "name": "Alex Smith", "handle": "alex"}, {"id": "U0456", "name": "Alex Jones", "handle": "ajones"}]}
  {"error": "unknown-user", "name": "alxe", "candidates": [{"id": "U0123", "name": "Alex Smith", "handle": "alex"}]}
  ```
  An `unknown-user` with an empty `candidates` means nothing was near. An
  email entry that is refused (`unknown-user` or `forbidden`) carries
  `"name": ""` and empty `candidates`: the address is never echoed back. A
  guest, a Slack Connect stranger or a bot is refused 403
  `{"error":"forbidden"}`, exactly as identify refuses one. One user opens
  a 1:1 DM with `conversations.open` (bot scope `im:write`, already held);
  several open a group DM (bot scope `mpim:write`, added by hand — see the
  README). A token without the scope answers 503
  `{"error":"missing-scope"}`.
- **`channel`**: the app posts a new top-level message in that channel with
  `chat.postMessage`; the bot must be a member, and `not_in_channel` answers
  409 `{"error":"not-in-channel"}` (the plugin's join flow is the fix). A
  private channel works when the bot has been invited.
- The answer is the session the plugin leases, the capability minted for the
  connection's owner, the opener's permalink and the resolved participants:
  ```json
  {"session": "C0123:1712345678.901234", "capability": "<opaque>", "permalink": "https://….slack.com/archives/C0123/p1712345678901234", "channel": "C0123", "participants": [{"id": "U0123", "name": "Corey Hart"}]}
  ```
  `session` is `channel + ":" + ts`, where `ts` is the opener's own message
  ts, and `capability` verifies for the owner exactly as a wake's does, so
  `POST /v1/subscribe` accepts the lease the same way (see "Leasing a
  session"). A lease on a conversation bb opened is accepted only from the
  connection that opened it.
- 502 `{"error":"slack-refused"}` and 503 `{"error":"slack-unavailable"}` are
  as for the reply endpoints. A permalink lookup that fails leaves
  `permalink` empty rather than failing an opener that was already posted.

The group-DM half needs the bot scopes `mpim:write` and `mpim:history` and
the `message.mpim` bot event, all added by hand (the README's Slack admin
steps). Until then a multi-user DM answers 503 `missing-scope` and nothing
in a group DM routes; single-user DMs and channel threads work with the
scopes already held.

### The wake: `event: session` (`source: "slack"`)

A DM from Slack user U is routed to the one connection currently bound to
U. If none is, the service classifies the asker with the same `users.info`
check identify applies, then replies itself. A member gets the **not set
up yet** reply (below): a Block Kit message with a button to the bb site
and a plain-text fallback. A member whose connection was bound within the
last 14 days, or any member in the two minutes after this service starts
while pods reconnect, gets the **not connected** reply instead: the server
is restarting or the plugin is not signed in to hooks-service, and the
message says to open bb and check *Settings → Plugins → Slack*. A
workspace guest (`is_restricted` or `is_ultra_restricted`) gets one line
saying bb is for members of this workspace, with no button, because a
guest can never bind a server. A Slack Connect stranger (`is_stranger`, or
a `team_id` that is not the app's), a bot or an app user is dropped with a
log line naming the user and channel and no reply. A failed `users.info`
read is treated as a member, so a transient Slack error never silences a
teammate; the classification is cached per user for a few minutes, and a
failure is not cached. The not-connected reply is sent at most once per
session within five minutes; the set-up and guest replies are not deduped.
The chosen server's stream receives, on the same `event: session` stream
as Linear:

```
id: 44
event: session
data: {"source":"slack","session":"D0123:1712345678.901234","action":"message",
       "mention":false,"tagged":true,
       "channel":"D0123","thread":"1712345678.901234",
       "asker":{"id":"U0123","name":"Alice"},"owner":{"id":"U0123","name":"Alice"},
       "fromOwner":true,"routedAs":"owner","capability":"<opaque>",
       "comment":{"text":"build this","untrusted":false},
       "ts":"1712345678.901234","at":"2026-10-22T12:00:00Z"}
```

(one line on the wire)

- `session` is `channel + ":" + thread`, where `thread` is the message's
  `thread_ts` when it has one, else its own `ts`. It is the key the plugin
  maps to a bb thread and the `{session}` in the reply paths.
- `capability` is the opaque proof that the session belongs to `owner`: an
  HMAC over the session and the owner's Slack user, keyed by a value derived
  from the signing secret, so it verifies after a restart. The plugin stores
  it with the session and echoes it to `POST /v1/subscribe` (see "Leasing a
  session"); it is never logged. It is empty (and omitted) when `session` is
  empty, as on `block_action` wakes.
- `mention` is `false` for a DM or assistant-thread wake and `true` for a
  channel `app_mention` or a channel message that tags the bot (below). It
  is how the plugin tells the two apart.
- `tagged` is `true` when the message addressed bb directly — a DM, a
  channel `app_mention` or a channel message that tags the bot — and
  `false` for an untagged reply in a channel thread bb is already part of
  (below). The plugin uses it to tell a message that must be answered from
  one that only continues a conversation: an untagged follow-up does not
  oblige a reply. An `edited` or `deleted` wake carries `tagged: true`, as
  the message it corrects did; the plugin keys on `action` first, so a
  `deleted` wake is not owed a reply. A message in a conversation bb opened
  with `POST /v1/slack/conversations` is always `tagged:false` (below).
- `opened` is `true` on a wake in a conversation bb opened with
  `POST /v1/slack/conversations`, and omitted otherwise, so an ordinary
  wake is byte-identical. The plugin frames these as the next message in a
  conversation it started; they owe no reply. A participant's message still
  carries `fromOwner:false` and `comment.untrusted:true` — the service makes
  no trust decision here.
- `action` is `message`, `edited`, `deleted`,
  `assistant_thread_started` or `assistant_thread_context_changed`. An
  `edited` or `deleted` wake is a correction to an earlier message, below;
  the assistant-thread events carry no text.
- `ts` is the message's own Slack timestamp (`1712345678.901234`), the key
  the plugin matches an edit or deletion to the wake it delivered. It is set
  on every `message` wake (a DM, a channel `app_mention`, a tagged channel
  message and an untagged thread reply alike) and on the `edited` and
  `deleted` wakes, and omitted on every other wake, so a wake that is not a
  message is byte-identical to before the field existed.
- An edit arrives as a `message` event with subtype `message_changed`, and a
  deletion as `message_deleted`. Both are routed only in a DM, and only to
  the same session as the original message (`channel:thread_ts`, else
  `channel:ts`): `action` is `edited` or `deleted`, `ts` is the original
  message's ts, and `comment.text` is the new text on an edit and empty on a
  deletion. Slack puts the edited message under the event's inner `message`
  object and the prior one under `previous_message`; the original ts is the
  inner `message.ts`, or `deleted_ts` (falling back to
  `previous_message.ts`) on a deletion. An edit by a bot or this app, a
  deletion of a bot message, a non-DM channel, and every other subtype are
  acknowledged and dropped. The plugin matches `ts` to the wake it delivered
  to decide whether the message is still queued (rewrite or remove it) or the
  turn has started (steer the thread).
- `contextChannel` is the channel the user was viewing when an
  `assistant_thread_context_changed` fired, read from
  `assistant_thread.context.channel_id`; it is empty (and omitted) on every
  other wake. The assistant thread itself lives in the DM named by
  `channel`, so this is the only place the viewed channel appears. A plugin
  that maps channels to projects remembers it per DM session and consults
  it before its direct-message entry.
- `comment.text` is the message text with Slack's control sequences resolved
  in memory before the wake is built, so the agent reads names rather than
  ids. `<@U…>` becomes `@Name` (the profile display name, else the real
  name) and the app's own mention becomes `@bb`; a user's name is cached per
  user for five minutes. `<#C…|name>` becomes `#name`, while a bare `<#C…>`
  is read with `conversations.info` and falls back to `#C…` when the app has
  no `channels:read`/`groups:read`. `<url|label>` becomes `label (url)`,
  `<url>` stays the url, and `mailto:` is treated the same. `<!here>`,
  `<!channel>` and `<!everyone>` become `@here`, `@channel` and `@everyone`,
  `<!subteam^S…|@team>` becomes `@team`, and `<!date…|fallback>` becomes
  `fallback`. A lookup that fails or times out leaves the id in place; each
  lookup is bounded at two seconds and the whole resolution at three, so the
  message is never dropped or held past that. The transform is in memory
  only: nothing new is persisted or logged.
- `mentions` is the user mentions the text resolved, in order of appearance
  and deduplicated, each `{"id":"U…","name":"Alice"}`, and it includes
  the app's own mention as `{"id":"<bot user id>","name":"bb"}`. It is
  omitted when the text had no user mention, so a wake without one is
  unchanged. A mention whose name lookup failed is still listed, with the id
  as its name. The plugin uses an id to write a real `<@U…>` in a reply; the
  service does not rewrite mentions on the way out.
- `files` is the message's attachments, metadata only: `[{"id":"F…",
  "name":"shot.png","mimeType":"image/png","size":12345,"filetype":"png"}, …]`.
  `name` is the file's name, falling back to its title (a snippet has a title
  where a plain upload has a name); `size` is bytes; `filetype` is Slack's
  short type label, and `preview` is a snippet's short text (bounded, with an
  ellipsis past the cap), so the plugin can decide what to forward without a
  fetch. `filetype` and `preview` are additive and omitted when Slack sent
  none. The whole field is omitted when the message carried no files, so a
  wake without them is byte-identical to before it existed. It applies to
  DMs, channel `app_mention`s and untagged thread replies alike, and a
  file-only message with empty `comment.text` still routes. The bytes are not
  on the wake; the endpoint below serves them for the ids it names.
- `history` is the thread's earlier messages on the **first** wake of a
  session (BB-162), oldest first, every message in the thread before the one
  that woke, the root included: `[{"ts":"1712345678.900000",
  "user":{"id":"U0456","name":"Bob"},"text":"Hello. What is this?",
  "files":[…]}…]`. It is how a mention partway through an existing thread
  carries its context. The text goes through the same control-sequence
  resolution as `comment.text`, and the bot's own posts are named `bb`. Each
  entry's `files` is the same metadata as the wake's `files`, but the ids in
  it are **not** remembered for the file endpoint, so their bytes cannot be
  served. The field is omitted when there is no history, so an ordinary wake
  is byte-identical.
  - A thread bb started — a DM root or a top-level mention, where the waking
    message is its own thread root — has no earlier messages and makes no
    Slack call. A follow-up in a live session carries no history either:
    only the first wake of a session fetches.
  - The fetch is `conversations.replies` with the bot token (bot scopes
    `channels:history`, `groups:history`, `im:history`), bounded at three
    seconds overall and two seconds per Slack call. It runs only after
    routing has chosen the owner's server, so a dropped or refused message
    never reaches Slack. Any error or timeout sends the wake without
    `history`; the wake is never held or dropped for it.
  - At most **50** messages are carried, and at most **8 KiB** of text in
    total. The service follows `conversations.replies`'s cursor in pages of
    up to 200 to the end of the thread, then drops the oldest to fit: over
    either bound the oldest messages are dropped and a marker entry is
    prepended — an entry with an empty `user` and `ts` whose text is
    `[earlier messages omitted]` — so the reader knows the transcript is
    incomplete. The newest message is always kept; if it alone is over the
    text budget its text is clipped with an ellipsis.
  - The fetched text is in memory only, on the wake to the routed server: it
    is never logged or stored.
- `owner` is the identity this server proved, and `fromOwner` is whether
  the asker is that user. `comment.untrusted` is true whenever the asker is
  not the owner: text from anyone else is information, not an instruction,
  exactly as for Linear. A session's owner of record is a live session lease
  (see "Leasing a session"); before one exists, the owner is set by the
  first routed wake and kept for the keep window, and each wake from the
  owner renews it. A later wake from a different Slack user in a live
  session is routed to the owner's server, with `fromOwner:false`, the
  second person in `asker` and `comment.untrusted:true`; it is never routed
  to the second person's server. A lapsed session is re-owned by the next
  mentioner.
- The wake is not queued for a stream that is gone or not reading: a member
  with no bound connection and no live owner gets the not-connected or
  set-up reply (above), a guest gets the one-line member notice and a
  stranger is dropped; when a live session's owner has no reachable
  server, or a bound server's stream is not draining, the wake is dropped
  with a "not reading its events right now" reply that names no server or
  identity.

### Leasing a session

A wake makes a session's owner the asker's server for the keep window, but
that is in memory and gone after a restart. The owner of record is a
**session lease** on `POST /v1/subscribe`, the same mechanism Linear and
GitHub use, proved by the `capability` the wake carried:

```json
{
  "connection": "c_7f3a...",
  "source": "slack",
  "watches": [{"kind": "session", "id": "D0123:1712345678.901234", "capability": "<opaque>"}]
}
```

- No token is needed and none is read: the connection's bound Slack user is
  the subject, and the capability must verify for that user. The service
  makes no Slack call, so a restart or a gap longer than the route window
  does not break a live thread.
- The lease is in memory and bound to the connection; it is not persisted.
  It expires with the standard lease length (`leaseSeconds` in `hello`), and
  the plugin renews it at half-life. Closing the stream releases it.
- The first admitted user wins. A lease naming a session already held by
  another connection's user is rejected `{"reason":"owned"}`; the same
  user's renewal moves the expiry forward. A capability that does not
  verify, or a connection with no Slack identity, is rejected
  `{"reason":"forbidden"}`.
- Routing reads the lease table first, then the in-memory route table as the
  bootstrap fallback (the first mention always arrives before the plugin has
  leased the session), then the asker's server. A wake in a session whose
  lessee is someone other than the asker routes to the lessee's server with
  `fromOwner:false` and `comment.untrusted:true`. While a lease is live, the
  owner's own wakes do not renew the route entry (the lease is the owner of
  record); if the lease lapses, the next owner wake re-establishes the route
  entry through the bootstrap path.
- Reply, status and title accept a live lease as well as a route entry, so
  the owner's server may post to a session it leased even after a restart or
  a gap longer than the route window.

**A Slack lease grants routing and reply authority only.** The wake carries
the payload with no re-check and no replay, unlike a doorbell: a doorbell
names an entity the subscriber fetches with its own credential, while a
Slack lease authorizes the service to deliver the next message in that
session to the lessee and to post the lessee's replies. The `capability` is
an opaque string to echo back, not a credential to present anywhere else; it
is never logged and never put in the wake's text.

### Channel mentions

A mention of the app in a channel (`app_mention`) routes to the server that
owns the session: the first mention in a conversation goes to the
**asker's** server, exactly as a DM routes to its sender's server, and a
later mention by a different Slack user goes to that owner's server, never
the asker's. A channel or private-channel `message` whose text contains
`<@botUser>` routes the same way, with the same `mention:true`/
`tagged:true` wake, even when its thread has no live lease or route; the
two deliveries of one tagged reply share a `channel:ts` key, so they wake
once (see "Dedupe"). The asker is the event's `user`; an asker with no live session
and no bound connection gets the same reply as a DM: a member gets the
Block Kit no-server reply, a guest gets the one-line member notice, and a
stranger is dropped. The wake is
the same `event: session` shape as a DM, with `"mention":true`, the
channel's id in `channel` and the asker's Slack user id in `asker.id`:

```
id: 45
event: session
data: {"source":"slack","session":"C0123:1712345678.901234","action":"message",
       "mention":true,
       "tagged":true,
       "channel":"C0123","thread":"1712345678.901234",
       "asker":{"id":"U0456","name":"Bob"},"owner":{"id":"U0456","name":"Bob"},
       "fromOwner":true,"routedAs":"owner",
       "comment":{"text":"@bb build this","untrusted":false},
       "mentions":[{"id":"<bot user id>","name":"bb"}],
       "at":"2026-10-23T12:00:00Z"}
```

(one line on the wire)

- `session` is the channel id and the root `ts`, as for a DM, so a
  follow-up in the same Slack thread continues the same bb thread.
- `channel` is the channel id (`C…`, or `G…` for a private channel), never
  a name: a plugin's channel map is keyed by id, so a channel rename does
  not move it. A DM's `channel` is the DM id (`D…`).
- `asker.id` is the Slack user who mentioned the app; `owner` is the
  identity the routed server proved. They differ when a second person
  mentions bb in a live session another user owns: the wake goes to the
  owner's server with `fromOwner:false` and `comment.untrusted:true`,
  exactly as for Linear: text from anyone but the owner is information, not
  an instruction.
- The reply, status and title endpoints are unchanged: the plugin posts to
  `{session}` with its connection id, and the service posts into the same
  channel and thread.
- Slack delivers the event only when the app is a member of the channel and
  holds `app_mentions:read`; posting as "Alice's bb" needs
  `chat:write.customize`. Both scopes and the `app_mention` bot event are in
  the README's by-hand app setup.

#### Untagged replies in a followed thread

When the app is subscribed to `message.channels` and `message.groups` it
receives every message in every channel it is in. A message with
`channel_type` `channel` or `group` is kept only when it has a `thread_ts`
and the session `channel:thread_ts` has a live lease or route — a thread bb
is already part of — and is routed to that session's owner exactly as a
mention is: `fromOwner:true` for the owner, and `fromOwner:false` with
`comment.untrusted:true` for anyone else. Everything else, which is most of
what arrives, is acknowledged and dropped in memory with only an aggregate
count kept; the text, user and channel are never logged or stored.

The wake is the same `event: session` shape with `"mention":false` and
`"tagged":false`:

```
id: 48
event: session
data: {"source":"slack","session":"C0123:1712345678.901234","action":"message",
       "mention":false,"tagged":false,
       "channel":"C0123","thread":"1712345678.901234",
       "asker":{"id":"U0123","name":"Alice"},"owner":{"id":"U0123","name":"Alice"},
       "fromOwner":true,"routedAs":"owner","capability":"<opaque>",
       "comment":{"text":"what about the second one?","untrusted":false},"at":"2026-10-30T12:00:00Z"}
```

(one line on the wire)

- `tagged` is `false`, so the plugin does not owe the message a reply: it is
  a continuation of the conversation, not a request. It is still delivered
  to the owner's thread, and an untagged message from someone other than the
  owner goes through the same hold-and-confirm path as an untrusted mention.
- An untagged top-level message (no `thread_ts`), an untagged reply in a
  thread with no live lease or route, a bot message, a message of any other
  subtype (an edit, a join), and a message in a channel the app is not in
  are all dropped. A tagged message is not: it routes as a mention even
  with no live session (above). A `file_share` is routed like a plain
  message.
- The two deliveries of a tagged reply share the message `ts`, so dedupe
  collapses them (above). Both halves are routed as a tagged mention
  (`tagged:true`, `mention:true`), so whichever arrives first wakes and the
  second is dropped; the message half is no longer held for the
  `app_mention` half.
- The bot scopes that deliver these events are `channels:history` and
  `groups:history`, and the bot events are `message.channels` and
  `message.groups`; the README's by-hand app setup names them.

#### Replies in a conversation bb opened

A conversation opened with `POST /v1/slack/conversations` is remembered in
memory, keyed by its session and indexed by its channel. A reply in the
opener's thread routes to that session as usual; a threaded message in any
other thread in that channel is a thread of its own and follows today's
routing. For a 1:1 DM (`im`) or a
group DM (`mpim`), where people reply at the top level rather than in a
thread, a top-level message continues the opened conversation when the
channel has **exactly one live opened lease**; for `im` only when the sender
has no bb connection of their own, because a person's own DM with the app
must reach their own server. A channel with two live opened leases, or a
connected person's own DM, falls back to today's routing, so a second open
cannot hijack a top-level message. A message in an opened session is
`tagged:false` and carries `"opened":true`.

Group-DM (`mpim`) events are routed like `im` throughout: `message`,
`message_changed`/`message_deleted`, `file_share`, and the `history` field
on the first wake of an existing thread. The by-hand `mpim:history` scope is
what delivers them (see the README).

### Interactivity: `block_actions`

`POST /slack/interactivity` is a second public path on this service for a
Block Kit action click. Nothing posts a block with an action today — the
invite prompt that did is gone, and the mention-time prompt that will is
not written yet — but the path is the hooks contract the plugin's
`block_action` handling is built on. It is not an Events API delivery:
Slack POSTs it form-encoded with a `payload` field holding the JSON.

- **Signature.** The same check as `/slack`: `X-Slack-Signature` is `v0=`
  and the hex HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<raw body>`
  with the same signing secret, and the timestamp must be within five
  minutes of now in either direction. A missing, malformed, stale or wrongly
  signed delivery is 401 with no detail, so a replayed `block_action` is
  refused.
- **What is read.** Only a `block_actions` payload with a `user.id`, a
  channel (the payload's `channel.id`, else `container.channel_id`) and at
  least one action. The clicker's `user.id` is the **only** identity the
  path routes on. The 200 is sent before the membership check, so the click
  never waits on a Slack API call; guests and external (Slack Connect)
  users are then dropped with the same `users.info` check identify applies,
  and nothing is routed.
- **The wake.** A valid click routes to the clicking user's server as a
  `session` event with action `block_action`:

```
id: 47
event: session
data: {"source":"slack","session":"","action":"block_action",
       "channel":"C0123","thread":"",
       "asker":{"id":"U0456","name":"Bob"},"owner":{"id":"U0456","name":"Bob"},
       "fromOwner":true,"routedAs":"owner",
       "actionId":"bb_set_project","value":"<project uuid>",
       "responseUrl":"https://hooks.slack.com/actions/...",
       "comment":{"text":"","untrusted":false},"at":"2026-10-26T12:00:00Z"}
```

(one line on the wire)

- `actionId` and `value` are the clicked action's id and value. For a
  `button` that is its `value`; for a `static_select` (the dropdown) it is
  the selected choice's `selected_option.value`, since a select has no
  top-level `value`.
- `responseUrl` is Slack's capability to replace the ephemeral message the
  click came from (ephemeral messages cannot be updated with `chat.update`).
  It is a capability: it reaches the routed pod, and this service never logs
  it. Slack's `response_url` lives for **30 minutes** and accepts at most
  **5 uses**; the plugin replaces the prompt once and treats a later failure
  as a stale click.
- A clicker with no bound server, and a bound server that is not reading its
  stream, are dropped silently.

### The ephemeral endpoint

```
POST /v1/slack/ephemeral
{"connection": "c_7f3a...", "channel": "C0123", "user": "U0456",
 "text": "Which project should this channel use?",
 "blocks": [ ... ]}
```

- It posts as the app with `chat.postEphemeral`, visible only to `user`.
  `text` and `blocks` are optional together, but at least one is required;
  `blocks` is the Block Kit array and `text` is the fallback text.
- It is **not** a general post-as-the-app endpoint. The connection must have
  a current Slack identity, and it may post only to **its own bound user**
  (a `user` naming anyone else is 403 `{"error":"not-yours"}`) and only in a
  channel the service recorded for that connection (anything else is 403
  `{"error":"not-routed"}`). No wake records a channel today: the invite
  prompt that did is gone, and the mention-time prompt that will is not
  written yet, so the endpoint refuses every channel until one does. The
  service tracks those channels per connection, in memory, for the same
  24-hour window as a routed session.
- 404 `{"error":"unknown-connection"}`, 403
  `{"error":"not-identified"}`, 400, 413 when `text` or `blocks` alone is
  over 32 KiB, 503 `{"error":"slack-unavailable"}` and 502
  `{"error":"slack-refused"}` are as for the reply endpoints below.

### Replying

```
POST /v1/slack/sessions/{session}/message
{"connection": "c_7f3a...", "text": "On it. Done by Alice's bb, as Alice."}

POST /v1/slack/sessions/{session}/status
{"connection": "c_7f3a...", "status": "is thinking\u2026"}

POST /v1/slack/sessions/{session}/title
{"connection": "c_7f3a...", "title": "Build BB-38"}
```

- The service posts as the app with the bot token it holds, via
  `chat.postMessage`, `assistant.threads.setStatus` and
  `assistant.threads.setTitle`. The bot token is never sent to a pod, and
  the request carries only the connection id and the content.
- A call is accepted only when the connection has a current Slack identity
  and the session is held by that user: a live session lease (see "Leasing a
  session"), or a route entry from within the last 24 hours. Another server
  gets 403 `{"error":"not-routed"}`, an unidentified connection 403
  `{"error":"not-identified"}`, and an unknown connection 404
  `{"error":"unknown-connection"}`; the first two are not distinguished
  from a session that never existed.
- 400 is a missing field or an unknown session shape; 413 is a reply over
  32 KiB (status and title are capped at 256 bytes). 503
  `{"error":"slack-unavailable"}` (Slack could not be reached) and 502
  `{"error":"slack-refused"}` (Slack refused the post) mean try later;
  nothing Slack said is passed back.
- When the channel does not let the app post
  (`restricted_action_read_only_channel`, `restricted_action` or
  `not_in_channel`), the reply falls back to an ephemeral message to the
  connection's own bound user, in the same channel, carrying the text plus a
  line saying the channel does not let bb post. A successful fallback answers
  200 `{"ok":true,"ephemeral":true,"reason":"channel-restricted"}`, and the
  message is visible only to that user. If the fallback fails too, the answer
  is 502 `{"error":"channel-restricted"}`. A missing `ephemeral` field means
  an older service that posted normally.
- The no-server reply is the service's own: a user with no bound connection
  gets one `chat.postMessage` in the same thread, with Block Kit `blocks` —
  a section saying the server is not set up yet and what to do next, and one
  `url` button **Set up your bb** to `-public-base-url`
  (`https://bb.example.com/` on this deployment; no built-in default)
  — and a non-empty plain `text` fallback for notifications and clients that
  do not render blocks. The button never posts back to Slack, so Interactivity
  stays off. The not-reading reply is text only. When the channel does not
  let the app post, the notice falls back to an ephemeral message to the
  asker (text only, with the same line saying why); a failed fallback is a
  warning in the log, not a reply.

### Fetching a file's bytes: `GET /v1/slack/sessions/{session}/files/{id}`

```
GET /v1/slack/sessions/D0123:1712345678.901234/files/F0123?connection=c_7f3a...
```

The wake names a message's files; this serves one file's bytes, so the
plugin can forward an image or a small text file into the thread. It is on
the cluster-only listener (8081), beside the reply endpoints, and is gated
exactly like a reply: the `connection` must have a current Slack identity
and the session must be held by that user (a live session lease or a route
entry). An unidentified connection is 403 `{"error":"not-identified"}`, a
session it does not hold is 403 `{"error":"not-routed"}`, and a connection
the service does not know is 404 `{"error":"unknown-connection"}`.

The `{id}` must be a file id the service saw on a wake routed to that
session. The ids are remembered per session, in memory, for the same
24-hour window as a routed session; any other id is 404
`{"error":"not-found"}`, so the endpoint cannot be used to read an
arbitrary Slack file. A file id named only in a wake's `history` is not
remembered, so its bytes cannot be served. Nothing but metadata and the
fetch URL is kept, and neither is logged.

The bytes are streamed from Slack's `url_private` with the bot token, which
never leaves the service. Nothing is written to disk, and neither the URL
nor the bytes are logged. The fetch needs the bot scope `files:read`; a
token without it answers 503 `{"error":"missing-scope"}`, and the plugin
keeps the "not forwarded" line. The size limits are enforced server-side,
from the metadata on the wake and again on the body:

- an image (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) up to
  10 MiB;
- a text-like file (`text/*`, json, csv, xml, yaml or code — matched by mime
  type, or by a code `filetype` when Slack gives no image or text-like mime
  type) up to 1 MiB;
- anything else is 415 `{"error":"unsupported-type"}`, and a file over its
  cap is 413 `{"error":"too-large"}` before Slack is called.

The response is the file's bytes with its `Content-Type` and no caching.
502 `{"error":"slack-refused"}` and 503 `{"error":"slack-unavailable"}`
are as for the other Slack calls.

### Credentials and setup

The service reads three keys from the one `hooks-service` Secret, mounted
and re-read on use like the webhook secrets:

| Key | What it is |
|---|---|
| `slack` | the app's signing secret, for deliveries in |
| `slack-bot-token` | the `xoxb-...` bot token, for posting as the app |
| `slack-client-secret` | the OAuth client secret, for the token exchange |

The OAuth **client id** is public config (`SLACK_CLIENT_ID`); the workspace
and app id are read from the bot token. Seal the three with
`SLACK_SIGNING_SECRET=<secret> SLACK_BOT_TOKEN=<xoxb-...> SLACK_CLIENT_SECRET=<secret> scripts/seal-hooks`;
the step-by-step app setup is in the README. A missing key disables the
adapter (503) until it appears, and a rotation is a reseal, with no
restart.

## Reporting: errors to Sentry

hooks-service reports its own failures to Sentry. This is an **outbound**
channel from the service to the internet, the counterpart of the inbound
webhooks; it changes nothing about what reaches a developer's pod. The
promise above is unchanged: nothing a source sends is forwarded to a pod,
except the text of a verified Linear `@bb` mention on an agent-session
wake.

The DSN is plain config, not a secret: an ingest endpoint that grants no
read access to the project. It is injected as `SENTRY_DSN` (for example
from a ConfigMap set to the team's project). It is read into the
environment at container start, so a
rotated DSN takes effect on the next pod restart (the webhook secrets are
mounted as files and re-read on use, which is why they rotate without one).
With it unset the service reports nothing and starts exactly as before,
logging `sentry disabled: SENTRY_DSN is not set` once.

**What is reported**, each tagged `service=hooks-service`, `release` (the
image tag) and `environment=production`:

- a signature-verified delivery the adapter could not normalize (a parse
  or shape failure, `ErrBadRequest`);
- a verification fetch that failed for a reason other than 401, 403 or 404
  while admitting a lease (the source was unreachable, rate-limited or
  unreadable, not "you may not see this");
- a subscriber event-stream failure (a write that failed while the request
  was still live, not a client that simply disconnected);
- an agent-session mint or reply failure (a refused client credential or
  app token, or Linear unreachable);
- a panic in a handler, which is still answered with a 500.

**What is not reported:**

- an unsigned or badly signed delivery. That is internet noise and stays a
  log line (`webhook refused ... status 401`), never an issue;
- the Sentry adapter's own signature failures, in particular. A bad Sentry
  delivery is not allowed to become an issue, whose doorbell would come
  back and loop;
- a missing assertion, an ordinary "not signed in".

Identical failures are deduplicated by fingerprint for a minute, so a
repeated bad shape is one issue and a failure cannot loop through Sentry's
own webhook doorbell. Before an event leaves, `BeforeSend` drops the
request body, query string, cookies and every header, and redacts
credential-shaped text with the same rules the stewards plugin applies to
log lines (tokens, secrets, passwords, API keys, cookies, and the
`sentry-hook-signature`, `linear-signature` and `x-hub-signature-256`
headers). No access token, webhook signing secret, Linear client secret or
minted app token reaches Sentry. Events are errors only: no transactions,
no profiling, no PII, no breadcrumbs. The SDK's transport queue is in
memory and nothing is written to disk, so the "no persistence anywhere in
this service" rule still holds.

## Finding the service

Every developer's server gets one variable from the backend template:

```
BB_HOOKS_URL=http://hooks-service.<namespace>.svc:8081
```

A plugin that wants doorbells reads it and treats its absence as "watching is
not available here". There is no polling fallback; the baseline re-check is
part of a leased watch, not a substitute for one.
