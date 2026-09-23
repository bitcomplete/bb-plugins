---
name: workstreams
description: Read the workstream board — git checkouts clustered by Linear ticket across repositories, rolled up into named efforts, programs and domains, with stacked pull requests, staleness and code surfaces surfaced. Use when asked which repos a ticket spans, what is blocked or awaiting merge, which PR is waiting on another, what has gone stale, what touches auth or migrations, or to group a ticket under a named workstream.
---

# Workstreams

The Workstreams plugin scans every git checkout under its configured scan roots
and rolls them up through as many as five levels:

```
Domain → Program → Effort → Ticket cluster (e.g. ABC-101) → Unit (one checkout)
```

The three grouping levels are derived, and three is a **maximum rather than a
target**. A level that does not earn its place is collapsed before the board
renders it: a group holding exactly one child is replaced by that child, and a
single group holding the whole board dissolves. On a board that supports only
efforts, the output is a flat list of efforts — the same shape earlier versions
produced.

A ticket cluster is the useful unit: one Linear ticket often spans several
repositories, and nothing else in the toolchain shows that grouping.

Every level carries words, not just counts:

- **Unit**: the pull request number and its title.
- **Cluster**: a 3–8 word summary, selected from the cluster's own pull request
  titles with the `OPS-1234: ` prefix stripped.
- **Effort**: a 3–8 word name plus a rollup sentence naming the real blocker,
  for example `3 of 7 merged; colophon blocked on CI.`
- **Program**: a 2–6 word name for the domain several efforts share.
- **Domain**: a 1–4 word name for the area of the product several programs sit in.

## Position is theme; status is a lens

Ordering and layout come from the grouping hierarchy and stable weights alone.
**Nothing on the board is ever positioned by lifecycle.** Status drives colour,
badges, dimming, filtering and the attention rail, and nothing else. The one
deliberate exception is the attention rail itself, which is explicitly a status
view and is ordered by urgency.

The lens control filters and dims **in place**: switching lenses never moves a
card or a region. Its three status lenses are exactly the three lifecycle
groups below, and it composes with independent staleness and surface filters —
"Needs you ∩ cold or dead" is simply both selected at once. The selection is
persisted in plugin kv and survives a reload.

## Commands

```
bb workstreams list [--json]        # the group tree, its clusters, rollups, and lifecycles
bb workstreams refresh              # rescan every scan root now and print the result
bb workstreams group <TICKET> <effort name>   # name the effort a cluster belongs to
bb workstreams ungroup <TICKET>     # drop that manual name
```

`list --json` emits the whole board as a FLAT `groups` array with a `parentKey`
on each entry — a flat list describes any collapsed shape without assuming a
depth. It includes per-unit branch, dirty state, ahead/behind counts, pull
request state, stack position, staleness and surfaces. Use it when you
need the details; use the plain form when you need the shape.

## Lifecycles

Each unit gets one lifecycle, and a cluster takes its most urgent member's. The
eleven states fall into three groups, and **those groups are the lenses**.

| Group | Lifecycle | Meaning |
| --- | --- | --- |
| Waiting | `blocked` | A check is FAILURE or ERROR |
| Waiting | `awaiting-followup` | CHANGES_REQUESTED — the reviewer acted, the ball is with you |
| Waiting | `approved-with-comments` | APPROVED, but a reviewer is still sitting at COMMENTED |
| Waiting | `awaiting-merge` | APPROVED, checks green, nothing outstanding |
| Waiting | `awaiting-review` | Open PR with no review decision yet |
| Active | `active` | Working tree is dirty — edits are open right now |
| Active | `in-progress` | Commits ahead of upstream, or a draft PR, tree clean |
| Active | `up-next` | Branch exists, nothing ahead, no PR |
| Done | `shipped` | Merged, and the merge commit is contained in a release tag |
| Done | `merged` | Merged, not yet in a release tag |
| Done | `closed` | Closed without merging |

Precedence runs top to bottom in that table. Two distinctions matter most:

- `awaiting-followup` is **not** `blocked`. One needs your edit; the other needs
  CI. A red check still outranks it, because fixing review comments would not
  make that PR mergeable.
- Draft pull requests stay in the **Active** group whatever their check state.
  Red CI on unfinished work is expected and must not compete with a PR that is
  genuinely stuck.

`shipped` is derived from **local git tags only**: the merge commit is tested
for containment in the newest release tag with `git merge-base --is-ancestor`.
No GitHub deployments API call is made. If a repo has no release tags or the
check fails, the unit degrades to `merged` and the board warns once per repo —
an unknown never invents a production deploy.

## Staleness

A dimension, never a lifecycle state: a pull request can be `awaiting-review`
**and** `dead` at once, and that pair is the most useful signal on the board.
Derived from the last commit date, with inclusive upper bounds:

| Bucket | Last commit |
| --- | --- |
| `fresh` | ≤ 7 days |
| `recent` | 8–30 days |
| `cold` | 31–90 days |
| `dead` | > 90 days |

A group is as fresh as its freshest member. On the map, staleness is drawn as
opacity above a legibility floor, with a text label at the deepest zoom so the
fact never depends on opacity alone.

## Surfaces and risk

Each unit is classified by the repo-relative paths its branch changes against
its merge base with the default branch — computed with local `git diff`, never
an extra `gh` call. A cluster's surfaces are the union of its units'.

The default table covers `auth`, `payments`, `migrations`, `schema`, `infra`,
`api`, `ui`, `tests` and `docs`, with hints for common frameworks: GraphQL schema
files and generated GraphQL types are `schema`, anything under a
migrations directory is `migrations`, and CI, Docker and terraform paths are
`infra`.

Risk is a coarse ordinal derived from the surfaces present — `high` for `auth`,
`payments` or `migrations`, `low` for only `docs` and `tests`, `medium`
otherwise, `none` for an unclassified change. There is deliberately no numeric
score: a rule table has no precision a decimal would be honest about.

Tune the table with the `surfaceRules` setting. A table that cannot be parsed
is ignored **whole** in favour of the default, with a warning on the board.

## Cohesion flags

In `jev+claude` mode, the same call that names an effort or a program also
returns a coarse `cohesive` / `mixed` verdict and, when mixed, one line naming
which members look unrelated. It costs no extra call and no extra round trip,
and it is cached with the name on the same member hash, so it goes stale at
exactly the moment the name does.

Claude may **not** change membership — Jev keeps deciding. The whole value of
the flag is that it disagrees with the grouping out loud rather than silently
repairing it: a fluent name over a bad grouping is harder to catch than an
awkward one. It renders as a quiet `~` marker with the reason on hover, not a
warning.

In `basic` and `jev` modes there is no verdict and nothing is rendered. Jev's
fit score is not substituted: it measures fit to a candidate, which is a
different thing from internal coherence.

## Stacked pull requests

A unit is stacked when its pull request's base is another open PR's head branch
rather than the repo's default branch. Stacks are a **repository** structure, so
a stack can span two ticket clusters. Each stacked unit carries `stack.position`
(1-based, from the bottom), `stack.size`, and `stack.blockedBelow` — the nearest
PR underneath that has not merged.

A unit's own lifecycle stays honest about the pull request itself: an approved,
green PR on top of an unmerged one is still `awaiting-merge`. The dependency is expressed
separately, and the rollup sentence reflects it
(`approved, blocked by #46 below it`), because merge order is the real
constraint in a stack.

## Grouping modes

The board reports which mode it is in. All three are usable; none is a failure
state.

| Mode | Keys set | What you get |
| --- | --- | --- |
| `basic` | neither | Clusters grouped by ticket (manual name, then Linear project, then the key). Summaries are the most recent PR title. |
| `jev` | `typesafeApiKey` | Efforts, and the levels above them, with borrowed names. Jev selects each cluster's summary from its own PR titles and assigns each level's members to candidates that code seeded from shared repos, branch vocabulary and Linear projects. |
| `jev+claude` | both | As `jev`, and Claude rewrites each group's name as a written category name and returns its cohesion verdict. That is Claude's only job here. |

An Anthropic key on its own changes nothing: efforts only exist once Jev has
grouped clusters.

Every level is derived with the same machinery one rung up — deterministic
seeding, a Jev choice scored against `assignmentConfidenceThreshold`, and
Claude naming only the groups whose member set changed — and each level caches
on **its own** member hash. Per-level call counts and token usage are logged
separately: `bb plugin logs workstreams`.

## Constraints

- **Code owns every number.** Counts, sorting, rollup sentences, lifecycle
  derivation, stack order, and the confidence cut are all deterministic. Models
  only select, assign, and name. The board and `list` can never disagree.
- **Read-only, except for grouping.** The plugin never runs a git mutation,
  never touches a pull request, and never opens a thread. `group` and `ungroup`
  write one key-value map of ticket → effort name; that is the only write
  surface.
- **A manual name always wins.** `group` beats any model assignment.
- **Linear informs a theme; it never decides one.** A shared Linear project is
  a weighted similarity term alongside shared repos and shared vocabulary, and
  its contribution is capped at the agreement those two already found — it can
  at most double a real signal, and doubling nothing is nothing. In naming, the
  project name is one candidate among the members' own phrases. With no Linear
  key configured, behaviour is exactly as it was before the term existed.
- **Low confidence goes to Unsorted.** A cluster whose effort fit scores below
  `assignmentConfidenceThreshold` lands in `Unsorted` rather than being
  force-fitted into a confident-looking effort. Checkouts with no recognizable
  ticket also land there, one cluster each, and are never sent to a model.
- **Model calls are cached by semantic input.** Each cluster is hashed over its
  ticket, repos, PR titles, and branch slugs — not lifecycles, counts, or
  timestamps. A rescan where nothing changed semantically makes zero model
  calls. Effort names are keyed by member set, so an effort that neither gained
  nor lost a cluster is never renamed. Call counts and token usage are logged at
  info level: `bb plugin logs workstreams`.
- **Pull request state needs an authenticated `gh`.** When `gh auth status`
  fails, the board reports one warning and falls back to local git state: every
  unit reads as `drafting` or `local`, and no stacks are detected. Fix it with
  `gh auth refresh -h github.com`. Changed paths and therefore surfaces also go
  missing, because the default branch they are diffed against comes from `gh`.
- **Scans are cached.** `list` reads the last scan; run `refresh` first when
  freshness matters. A background service rescans on the `refreshMinutes`
  interval.

## Settings

Configure with `bb plugin config workstreams set <key> <value>`:

| Key | Notes |
| --- | --- |
| `scanRoots` | Newline-separated absolute paths; empty falls back to every BB project's path. |
| `ticketPattern` | Two capture groups; default `([A-Za-z]{2,5})-(\d{1,6})`. |
| `linearApiKey` | Secret, optional. Seeds the `basic` mode grouping name. |
| `refreshMinutes` | 1–240, default 10. |
| `typesafeApiKey` | Secret, optional. Turns on efforts and selected summaries. |
| `anthropicApiKey` | Secret, optional. Turns on written group names and cohesion verdicts. |
| `surfaceRules` | Multiline. `name: glob, glob, …` per line. A table that fails to parse falls back to the default. |
| `assignmentConfidenceThreshold` | 0–1, default 0.6. Applies at every grouping level. |

## Views

The plugin panel opens on the **Map** — the semantic-zoom canvas — with the
dense **Board** as the secondary tab. Both are deep-linkable (`board` is a real
sub-path) and both read the same single fetch, so they can never disagree.

Zoom bands span depth ranges and adapt to the depth the board actually
collapsed to, so every band boundary reveals something. On a two-level board
the thresholds are exactly what they were before the hierarchy existed.
