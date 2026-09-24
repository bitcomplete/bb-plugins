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

## On the Map, position is theme; status is a lens

The Map's layout comes from the grouping hierarchy and stable weights alone.
**No circle or group is ever positioned by lifecycle**: a picture you navigate
by memory must not reshuffle when a PR turns red. Status drives colour, halos
and dimming there, and nothing else.

The Board is the deliberate opposite: an inbox you work through, so it IS
ordered by status (see Views).

The Map's lens control filters and dims **in place**: switching lenses never
moves a circle or a region. Its three status lenses are exactly the three lifecycle
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
| `jev` | `typesafeApiKey` | Efforts, and the levels above them, with borrowed names. Jev selects each cluster's summary from its own PR titles and assigns each level's members to candidates that code seeded from four signals (see [Grouping signals](#grouping-signals)). |
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
- **Every write asks first.** Scans never run a git mutation or touch a pull
  request. The only writes are `group` / `ungroup` (one key-value map of
  ticket → effort name) and the Board's row actions, each of which runs only
  from the confirm button of its own dialog. See [Row actions](#row-actions).
- **A manual name always wins.** `group` beats any model assignment.
- **No single signal groups anything.** Seeding compares four independent
  signals: code areas (where in the repo a branch changes files), branch and PR
  vocabulary, Linear (a shared parent issue or project), and a shared thread.
  Two clusters are seeded together only when at least two of them agree. The
  repo is not a signal: in a monorepo every pair shares it. See
  [Grouping signals](#grouping-signals).
- **Linear informs a theme; it never decides one.** Linear is one of the four
  signals, so on its own it cannot merge anything. In naming, the project name
  is one candidate among the members' own phrases. With no Linear key the
  Linear code path is inert: no request is made and nothing Linear-shaped
  reaches a hash.
- **Low confidence goes to Unsorted.** A cluster whose effort fit scores below
  `assignmentConfidenceThreshold` lands in `Unsorted` rather than being
  force-fitted into a confident-looking effort. Checkouts with no recognizable
  ticket also land there, one cluster each, and are never sent to a model.
- **Model calls are cached by semantic input.** Each cluster is hashed over its
  ticket, repos, PR titles, and branch slugs, plus its Linear title, project and
  parent when known — not lifecycles, Linear state, counts, or timestamps. A rescan where nothing changed semantically makes zero model
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
| `linearApiKeys` | Secret, optional. One or more Linear personal API keys separated by commas or spaces, one per workspace. Each ticket is routed to the key whose workspace owns its team prefix. |
| `linearApiKey` | Secret, optional, older single-key setting. Still read and merged with `linearApiKeys`. |
| `refreshMinutes` | 1–240, default 10. |
| `typesafeApiKey` | Secret, optional. Turns on efforts and selected summaries. |
| `anthropicApiKey` | Secret, optional. Turns on written group names and cohesion verdicts. |
| `surfaceRules` | Multiline. `name: glob, glob, …` per line. A table that fails to parse falls back to the default. |
| `assignmentConfidenceThreshold` | 0–1, default 0.6. Applies at every grouping level. |
| `mergeMethod` | `squash` (default), `merge` or `rebase`: how the Board's Merge action merges. |
| `deleteBranchOnMerge` | Default `true`. Always skipped when another open PR is based on the branch. |

## Row actions

Each Board row offers the action its verb calls for: the row's verb chip is
its button, and the `a` key runs it. Rows with nothing to do show the verb as
plain text. The `⋯` menu offers **Go to thread** (`t`), **Open checkout** (`o`)
and **Start a new thread** (`n`). Opening a dialog never writes; the write runs
only from the dialog's confirm button.

| Row | Action | Kind |
| --- | --- | --- |
| Fix · CI failing | Investigate CI | Agent |
| Fix · Resolve conflicts | Resolve conflicts | Agent |
| Respond · Changes requested | Address review and reply | Agent |
| Respond · Approved, comments open | Address comments and reply (never merges) | Agent |
| Merge · Ready to merge | Merge | Direct |
| Merge · Update branch | Update branch | Direct |
| Waiting · In review | Nudge reviewers | Direct |
| Waiting · Behind #NN | Jump to the blocking row | Navigation |

### Direct actions (the host runs `gh`; no agent)

Safeguards common to all three:

- Every command is an argv array passed to `execFile`, never a shell string,
  and names the repo with `--repo`, so `gh` never touches the local checkout.
- The client sends only the row's checkout path. The server resolves the
  repo, PR number and pending reviewers from its own last scan.
- Comment bodies reach `gh` on stdin (`--body-file -`), never as a flag value.
  Reviewer logins are validated before they become `--add-reviewer` values.

**Merge.** Opening the dialog re-reads the PR live: state, draft, review
decision, `mergeStateStatus`, head commit, any open PR based on its head
branch, and the count of unresolved review threads. The dialog refuses, with
the reason, unless the PR is open, not a draft, `APPROVED`, and `CLEAN`,
`HAS_HOOKS` or `UNSTABLE` (`UNSTABLE` shows a warning). Unresolved review
threads need an explicit **Merge anyway** tick. The server re-reads and
re-checks all of this again before it writes, then runs
`gh pr merge <n> --<mergeMethod> --match-head-commit <sha shown>`, so GitHub
refuses if anything was pushed after the dialog opened. `--delete-branch` is
added only when `deleteBranchOnMerge` is on and no open PR is stacked on the
branch. A successful merge triggers a rescan.

**Update branch.** `gh pr update-branch <n>` after a confirm; the local
checkout is not touched. A rescan follows.

**Nudge reviewers.** Two independent choices: re-request review from the
reviewers GitHub still lists as pending (`reviewRequests`, read by the scan's
existing `gh pr list` call), and post an editable comment prefilled as
`PTAL - @reviewer: repo #PR (title) has been waiting 3d.` With no pending
reviewers, only the comment is offered, and the dialog says so.

### Agent actions (a BB thread does the work)

The dialog reads the row's linked threads live (status and context-window use)
and preselects where the work runs, with its reason in one line. The user can
pick any mode and thread, and edits the prompt, before anything runs.

- **Investigate CI and Resolve conflicts** are repairs: a **subthread** of the
  most relevant linked thread of any tier (strongest tier, then most recently
  updated, then id), which leaves the parent's context untouched and tells the
  parent when it finishes. A **new** thread only when nothing is linked.
- **Address review and Address comments** want the thread that wrote the PR (a
  `started` or `environment` link). Idle → **continue** in it (the message is
  queued, never steered into a running turn). Running, or more than 70% of its
  context used → a **subthread** of it. Only weak links (`ticket`, `paths`) or
  none → a **new** thread, because weak links often point at large, unrelated
  threads.
- If BB will not add a child to a thread, the recommendation falls back to a
  new thread and says why.
- **Continue** and **Subthread** only accept a thread linked to that row. New
  and sub threads run in the checkout and carry this plugin's thread metadata
  `{ ticket }`, which links them to the cluster as `started`.
- Every agent prompt ends by asking for a final line starting `Result:` in
  under 12 words. That line is how the Board reports the outcome.

### Run tracking

Every agent and direct action is recorded as a run (the `action_runs` table,
the newest 200 and at most 30 days). `list --json` includes `runs`: open runs
and the last day's, newest first. Nothing polls:

- An agent run's status follows its thread's BB events. `thread.active` →
  running, `interaction.pending` → needs you, `thread.idle` → done,
  `thread.failed` → failed, and archive or delete → failed. BB has no
  interaction-answered event, so a waiting run re-reads that thread's pending
  interactions when its event sequence advances. The post-scan thread relist
  catches up any event missed during a reload.
- A **continue** run shares its thread with earlier work. It ignores that
  thread's events until the turn it queued starts.
- On finish, the outcome is the last `Result:` line of the final assistant
  message (capped at 120 characters), read by code, never a model. With no such
  line, the row says "Done: see thread".
- Direct actions record their outcome once: succeeded with a short reason
  ("Merged", "Branch updated", "Re-requested 2 reviewers and commented"), or
  failed with the refusal.
- A finished agent run, or a direct action that succeeded, rescans only that
  checkout (`inspectPaths` on the host), batched over 3 seconds, so the row
  moves sections on its own.

The Board shows the row's latest run in place of its age (running, needs you,
or finished in the last 24 hours), and an **Agents** line at the top while
anything is running, waiting on you, or finished in the last 4 hours. BB's
sidebar shows a count beside Workstreams: needs-you first, else running.

## Views

The plugin panel opens on the **Map** — the semantic-zoom canvas — with the
**Board** as the secondary tab. Both are deep-linkable (`board` is a real
sub-path) and both read the same single fetch, so they can never disagree.

The Board is an inbox with one row per checkout, grouped by the next action:
**Fix** (`blocked`), **Respond** (`awaiting-followup`,
`approved-with-comments`), **Merge** (`awaiting-merge` not blocked by a stack),
**Waiting** (`awaiting-review`, and any live row stacked on an unmerged PR,
shown as "Behind #NN"), then, collapsed, **In flight**, **Recently shipped**
(merged in the last 7 days, from `gh`'s `mergedAt`) and **Parked**. Within a
section the row that has been in its state longest comes first. The age is
measured from the scan that saw the checkout enter its state. Until one has,
the row shows its last-commit age and labels it "last commit". Keys: `j`/`k`,
`Enter` (PR), `a` (the row's action, which asks first), `t` (newest thread),
`m` (Map), `o` (open the checkout), `n` (start a thread), `/` (search).

The header's ⓘ, or `?` in either view, opens **How this works** in BB's right
panel. It explains grouping, the states, both views' keys and the Map's marks,
and it shows health: the last scan, the refresh interval, thread-link coverage
by tier, warnings in full, and the last enrichment's model calls and tokens.

Zoom bands span depth ranges and adapt to the depth the board actually
collapsed to, so every band boundary reveals something. On a two-level board
the thresholds are exactly what they were before the hierarchy existed.

## Grouping signals

- **Code area.** Each changed path maps to an area: container directories
  (`src`, `packages`, `apps`, `services`, …) are stripped and the next two named
  directories kept, so `packages/reader-web/src/shelves/Form.tsx` is
  `reader-web/shelves`. Lockfiles and generated output are ignored. An area
  touched by many clusters counts less, and one touched by more than a quarter
  of them counts nothing.
- **Vocabulary.** Words from branch slugs and PR titles.
- **Linear.** A shared parent issue, or (weaker) a shared project.
- **Threads.** A thread strongly linked (started from the Board, running in the
  checkout, or naming the ticket) to n clusters gives each pair 1/(n−1).
  Path-only links never count, and a thread linking more than eight clusters
  counts nothing.

## Linear details

Ticket detail (title, state, project, parent, labels, url) is fetched with the
key whose workspace owns the ticket's prefix, batched, and cached for 12 hours.
Workspaces and their team keys are re-read daily and after a settings change. A
prefix no key owns gets no detail; that is not an error. Failures are logged
once and keep the previous cache. Keys stay on the server and are never logged.

The first scan after Linear detail arrives regroups the clusters it changed,
which costs a one-time burst of model calls, logged as `regrouping with Linear
detail: N clusters`. Later scans return to zero calls.
