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

The Map's lens control filters and dims **in place**: switching lenses never
moves a circle or a region. Its three status lenses are exactly the three lifecycle
groups below, and it composes with independent staleness and surface filters —
"Needs you ∩ cold or dead" is simply both selected at once. The selection is
persisted in plugin kv and survives a reload.

## Commands

```
bb workstreams list --compact [--json] [--limit N] [--offset N]  # bounded ticket-cluster page; default 20, maximum 50
bb workstreams list [--json]        # the group tree, its clusters, rollups, and lifecycles
bb workstreams refresh              # rescan every scan root now and print the result
bb workstreams group <TICKET> <effort name>   # name the effort a cluster belongs to
bb workstreams ungroup <TICKET>     # drop that manual name
```

For agent lookups, start with `list --compact`. Within a board snapshot, it
returns ticket clusters in ticket order with each ticket's lifecycle, short
summary, and full group path, plus scan freshness and warning count. Scans can
change the board and its ordering. Use `--limit` and `--offset` to page through
larger boards; the plain output prints the next command when another page exists.
When `warningCount` is greater than zero, read full plain `list` to see the
warning messages.

`list --json` emits the whole board as a FLAT `groups` array with a `parentKey`
on each entry — a flat list describes any collapsed shape without assuming a
depth. It includes per-unit branch, dirty state, ahead/behind counts, pull
request state, stack position, staleness and surfaces. Use it when you
need the details; use the plain form when you need the shape. Full JSON can
exceed BB's 1 MB CLI output limit on larger boards.

## Lifecycles

Each displayed unit gets one lifecycle, and a cluster takes its most urgent
member's. The thirteen displayed states fall into three groups, and **those
groups are the lenses**. Closed pull requests that did not merge are omitted
before grouping, even when their checkouts are dirty or ahead of upstream.

| Group | Lifecycle | Meaning |
| --- | --- | --- |
| Waiting | `blocked` | A check is FAILURE or ERROR |
| Waiting | `awaiting-followup` | CHANGES_REQUESTED — the reviewer acted, the ball is with you |
| Waiting | `awaiting-rereview` | CHANGES_REQUESTED remains in effect, but the author has pushed a newer head, resolved the inline threads, and posted PTAL to the reviewer; wait for another review |
| Waiting | `approved-with-comments` | APPROVED, with unresolved review threads |
| Waiting | `approved-with-note` | APPROVED with feedback in the current review that lacks verified resolution for this head; confirm it handled before merging |
| Waiting | `awaiting-merge` | APPROVED, checks green, nothing outstanding |
| Waiting | `awaiting-review` | Open PR with no review decision yet |
| Waiting | `unverified` | Local or GitHub status could not be checked; rescan to verify it |
| Active | `active` | Working tree is dirty — edits are open right now |
| Active | `in-progress` | Commits ahead of upstream, or a draft PR, tree clean |
| Active | `up-next` | Branch exists, nothing ahead, and no PR was found |
| Done | `shipped` | Shown as **In release tag**: merged, and the merge commit is contained in a local release tag; this does not verify deployment |
| Done | `merged` | Merged, not yet in a release tag |

New unit JSON records whether git status and the GitHub PR lookup completed.
Older persisted units have no observation flags and appear as `unverified`
until the next successful scan. Failed checks remain visible as unavailable;
they do not prove that a tree is clean or a pull request is absent.

Precedence runs top to bottom in that table. Key distinctions:

- `awaiting-followup` is **not** `blocked`. One needs your edit; the other needs
  CI. A red check still outranks it, because fixing review comments would not
  make that PR mergeable.
- `awaiting-rereview` requires a complete review-thread check, a head commit
  newer than the changes-requested review, and a PR-author `PTAL @reviewer`
  comment posted after that commit. GitHub still reports `CHANGES_REQUESTED`.
  Workstreams offers no automatic reviewer nudge or PTAL for this state. A branch
  behind its base remains visible as a separate signal.
- Draft pull requests stay in the **Active** group whatever their check state.
  Red CI on unfinished work is expected and must not compete with a PR that is
  genuinely stuck.
- `approved-with-note` means a reviewer wrote a note with approval. It is
  distinct from `approved-with-comments`, which has unresolved inline comments.
  Your confirmation records that the notes are handled; older records may hold
  a worker's evidence for each review point instead. The record applies only
  to the matching review and head commit. The row reads
  ready when that evidence is verified, GitHub still reports approval, checks
  pass, no review threads remain open, and the merge state permits it. The
  approval gate requires no additional reviewer approval or formulaic PR reply.

**In release tag** (`shipped` internally) is derived from **local git tags
only**: the merge commit is tested for containment in the newest release tag
with `git merge-base --is-ancestor`.
No GitHub deployments API call is made, so this state does not establish a
production deployment. If a repo has no release tags or the check fails, the
unit remains `merged` and the board warns once per repo.

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
- **Writes require an explicit start.** Scans never run a git mutation or touch
  a pull request. `group` / `ungroup` change a local ticket → effort name map;
  Every GitHub write runs from a confirm.
  See [Row actions](#row-actions).
- **A manual name always wins.** `group` beats any model assignment.
- **No single signal groups anything.** Seeding compares four independent
  signals: code areas (where in the repo a branch changes files), branch and PR
  vocabulary, Linear (a shared parent issue or project), and a shared thread.
  Two clusters are seeded together only when at least two of them agree, except
  that a shared Linear parent issue can merge a pair when another signal is
  nonzero. A broad shared project follows the normal evidence threshold. The repo is not a signal: in a monorepo every pair shares it. See
  [Grouping signals](#grouping-signals).
- **Linear decides linked groups, and only those.** On its own Linear merges
  nothing. A shared parent issue has a narrow exception when another signal
  supports the pair; shared project membership follows the normal evidence
  threshold. In naming, the project name
  is one candidate among the members' own phrases, and ticket titles, parents
  and projects are passed as context, never as the name. With no Linear key the
  Linear code path is inert: no request is made and nothing Linear-shaped
  reaches a hash, a Jev question or a naming call.
- **Low confidence goes to Unsorted.** A cluster whose effort fit scores below
  `assignmentConfidenceThreshold` lands in `Unsorted` rather than being
  force-fitted into a confident-looking effort. A checkout with no recognizable
  ticket and no pull request also lands there and is never sent to a model. With
  no ticket but an open pull request it is grouped like any ticket; with a merged
  one it is filed under No ticket, never sent to a model. Closed pull requests
  are omitted from the board.
- **One-offs are filed by team, not grouped.** An effort holding a single
  cluster rolls into a container per ticket prefix, named from the `teamNames`
  setting, else the Linear team name, else the prefix ("ABC · 14 one-offs").
  Containers are built by code alone: no model assigns, names or judges them.
- **Model calls are cached by semantic input.** Each cluster is hashed over its
  ticket, repos, PR titles, and branch slugs, plus its Linear title, project and
  parent when known — not lifecycles, Linear state, counts, or timestamps. A rescan where nothing changed semantically makes zero model
  calls. Effort names are keyed by member set, so an effort that neither gained
  nor lost a cluster is never renamed. Call counts and token usage are logged at
  info level: `bb plugin logs workstreams`.
- **Pull request state needs an authenticated `gh`.** When `gh auth status`
  fails, the board reports one warning and falls back to local git state: observed
  edits remain `active` and ahead commits remain `in-progress`; other units show
  `unverified` until a GitHub check succeeds. No stacks are detected. Fix it with
  `gh auth refresh -h github.com`. Changed paths and therefore surfaces also go
  missing, because the default branch they are diffed against comes from `gh`.
- **Scans are cached.** `list` reads the last scan; run `refresh` first when
  freshness matters. Git ref changes and idle thread transitions trigger
  targeted refreshes; a background service also rescans on the
  `refreshMinutes` interval. Workstreams does not use GitHub webhooks.

## Settings

Configure with `bb plugin config workstreams set <key> <value>`:

| Key | Notes |
| --- | --- |
| `scanRoots` | Newline-separated absolute paths; empty falls back to every BB project's path. |
| `ticketPattern` | Two capture groups (prefix and number); default `([A-Za-z]{2,5})-(\d{1,6})`. Used to find tickets in branches, pull request titles, and checkout directory names. |
| `linearApiKeys` | Secret, optional. One or more Linear personal API keys separated by commas or spaces, one per workspace. Each ticket is routed to the key whose workspace owns its team prefix. |
| `linearApiKey` | Secret, optional, older single-key setting. Still read and merged with `linearApiKeys`. |
| `refreshMinutes` | 1–240, default 10. |
| `inventoryPollSeconds` | 15–3600, default 60. How often one batched GraphQL read refreshes every open PR you author. It only reads, and a GitHub rate limit pauses it until the limit resets. |
| `typesafeApiKey` | Secret, optional. Turns on efforts and selected summaries. |
| `anthropicApiKey` | Secret, optional. With Jev enabled, Claude Sonnet 5 writes group names and cohesion verdicts; it does not assign members. |
| `surfaceRules` | Multiline. `name: glob, glob, …` per line. A table that fails to parse falls back to the default. |
| `assignmentConfidenceThreshold` | 0–1, default 0.6. Applies at every grouping level. |
| `mergeMethod` | `squash` (default), `merge` or `rebase`: how Merge merges. |
| `deleteBranchOnMerge` | Default `true`. Always skipped when another open PR is based on the branch. |

## Row actions

### Direct actions (the host runs `gh`; no agent)

Safeguards common to every direct write:

- Every command is an argv array passed to `execFile`, never a shell string,
  and names the repo with `--repo`, so `gh` never touches the local checkout.
- The client names only the PR. The server resolves the repo, PR number and
  pending reviewers from its own last scan.
- Comment bodies reach `gh` on stdin (`--body-file -`), never as a flag value.
  Reviewer logins are validated before they become `--add-reviewer` values.

**Merge.** Opening the merge preview re-reads the PR live: state, draft, review
decision, `mergeStateStatus`, head commit, any open PR based on its head
branch, and the count of unresolved review threads. The preview refuses, with
the reason, unless the PR is open, not a draft, `APPROVED`, and `CLEAN`,
`HAS_HOOKS` or `UNSTABLE` (`UNSTABLE` shows a warning). Unresolved review
threads refuse the merge. The server re-reads and re-checks all of this again
before it writes, then runs
`gh pr merge <n> --<mergeMethod> --match-head-commit <sha shown>`, so GitHub
refuses if anything was pushed after the preview opened. `--delete-branch` is
added only when `deleteBranchOnMerge` is on and no open PR is stacked on the
branch. A successful merge triggers a rescan.

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
- Older runs that shared a thread close without claiming a `Result:` line from
  an unrelated turn.
- On finish, the outcome is the last `Result:` line of the final assistant
  message (capped at 120 characters), read by code, never a model. With no such
  line, the row says "Done: see thread".
- Direct actions record their outcome once: succeeded with a short reason
  ("Merged", "Branch updated", "Re-requested 2 reviewers and commented"), or
  failed with the refusal.
- A finished agent run, or a direct action that succeeded, rescans only that
  checkout (`inspectPaths` on the host), batched over 3 seconds, so the row
  moves sections on its own.

BB's sidebar shows a count beside Workstreams: needs-you first, else running.

## Views

The **Efforts** administration view lists explicitly saved efforts. Create an
effort without launching an agent, edit its name and goal, archive or restore
it, and preview **Merge into…** before combining membership. The destination
keeps its identity; old effort IDs resolve to it. Thread histories stay
separate. Archived efforts retain linked work. Merge previews identify routing
conflicts and blockers; resolve them before applying the merge. Retry pending
thread updates when an external update fails. A thread renamed after the merge
was planned keeps its new title, and the merge still moves its effort and
parent; the merge notice names it. Keep the thread-briefs plugin's
`renameThreads` setting off beside Workstreams, which titles coordinator and
worker threads itself.

The effort chip above a thread's composer names the thread's effort with its
color and Your turn count, and opens that effort's card on the deck. Without an
effort of its own or one it coordinates, it names the card the deck places the
thread on (see the effort deck's threads): an effort, a `<repo> · service`
card with that card's Your turn count, or No effort for a loose thread. The
popover's linked PRs are the ones the thread records and the PR in its exact
checkout, which assigning the thread takes in; a link only by branch name or
worked path doesn't count.

The chip's popover lists efforts with suggested ones first, each with its
signal: an effort has a PR the thread links, the title names one of its
tickets, the classifier suggests it for a linked PR, or it's the parent thread's
effort. Jev suggests only when the user asks. A pick applies at once and offers
an Undo: `thread_effort_undo` puts the thread's effort and linked PR back, moves
moved work back with the effort each piece came from, lets go work the change
brought in, and removes an effort it created while that effort is still empty.
Undo refuses, changing nothing, once anything it touched changed, and keeps a
forward change's guard: nothing goes back into a done effort.

Assigning a thread lets confirmed, unassigned PR work inherit the effort from
exact checkout links, recorded actions, or explicit PR links. Title and
discussion mentions don't authorize automatic assignment. Existing explicit
ticket and PR ownership stays intact, and removing the thread's effort doesn't
remove inherited membership. **+ New effort** creates a named effort and
assigns the thread without starting a coordinator. **Move here** on a linked
PR chip moves that PR, with its ticket's related PRs and checkouts, into the
thread's effort; each linked PR's `also` names what else that move takes, and
the popover lists it and waits for Move all before moving. **+ Link PR** adds a tracked PR as thread context. A done
effort takes no thread or moved work. Explicit membership survives rescans.
Organizing an effort doesn't launch its coordinator, start an agent, or change
existing thread parents.

The panel opens on the last view you used in this browser, or the effort deck
on your first visit. Each view has a deep link.

To hold one PR, the deck's **Hold PR** in its details calls `pr_hold_set` with
an optional `reason`. A held PR keeps its readiness and thread access; no
batch or Advance touches it. `pr_hold_set` with `held: false`
releases it without changing GitHub.

The Map's **Approved** filter persists across reloads, including approved PRs
that still need fixes, checks, or branch work. The Map dims nonmatches without
repacking and counts checkout-backed PRs.

Workstreams starts planning and context threads with the Planning model setting (`planningModel`, default `codex/gpt-6-sol/medium`) and work, repair, and effort repository controller threads with the Code-work model setting (`codeModel`, default `codex/gpt-6-sol/high`). A thread created with another provider cannot change providers in place, so Workstreams doesn't send it Ask or Fix turns: message it in its own thread, or set the Code-work model to its provider.

A new PR worker goes beneath the effort's repository controller, under its
coordinator. Existing PR workers remain linked as history and repair context.
Repairs keep the PR's real checkout. A coordinator or repository controller
does not satisfy a merge gate or replace a PR's latest result. Unarchive an
archived controller before resuming its repository.

Archive an idle leaf thread from its thread menu on the Map. **Archived
threads** shows archive history and lets you undo it. Threads with children
must be archived through BB.

The header's ⓘ, or `?` on any view, opens **How this works** in BB's right
panel. It explains each view, grouping, keys and the Map's marks,
and it shows health: the last scan, the refresh interval, thread-link coverage
by tier, warnings in full, and the last enrichment's model calls and tokens.

Zoom bands span depth ranges and adapt to the depth the board actually
collapsed to, so every band boundary reveals something. On a two-level board
the thresholds are exactly what they were before the hierarchy existed.

## PR inventory

The inventory lists every open PR you author, and every open PR an unarchived
effort names as a member, grouped by the effort that owns it (as a member or
through its ticket), with "No effort" last. A background read refreshes your
authored PRs every `inventoryPollSeconds`. PRs you don't author show their
checkout's facts until the board's latest read finds them merged or closed.

The Workstreams panel shows this inventory as **All PRs**, one tab from the
effort deck it opens on. Map and Efforts admin sit under
the header's More, and each effort's name opens its card on the deck.

```
bb workstreams inventory [--attention draft|reviewer|nudge] [--json]
```

Each row gives the PR, its requested and past reviewers, its state in the
board's words, the PR of yours it is
stacked on (`stackedOn`, whose row it files under), and each attention
reason with its next step, owner, and age. It also gives when GitHub last
answered for the PR, its last failed read and why, any hold, and the thread the
work started in and the one working on it. On your own PRs, held or not,
`yourTurn.why` says in one line which person's feedback waits on you: an
approval comment with no reply of yours after it, a change request with no
push or reply since, an open thread whose last word is theirs, or their
comment with no reply of yours. Bots never set it; drafts count. A change
request you answered is an attention reason to re-request review instead, and
approval notes you answered one to confirm; neither is `yourTurn`. All PRs
lists it as Your turn, and the badge counts it, unless a thread other than its
own batch thread is working on it, you or its effort hold it, or you dismissed
it on this head (`dismissed`), whatever button its row leads with. `sent`
links the newest batch thread that took it, with BB's status for it (working,
needs you, failed with why, or idle), and keeps it on Your turn while that
thread works. The header counts PRs forgotten in
draft, missing a reviewer, and needing a nudge; `--attention` filters to one
question. The `inventory_get` RPC returns the same view, and the
`inventory-changed` realtime event fires after each read, hold, or inventory
action.

Feedback to address holds a PR from ready and from merge in every view. It is
an approval with a non-empty body (a comment, question, condition, or request),
or another person's comment in a review body, an inline thread, or the PR's
conversation, that nothing after it answers. Bots, such as deploy previews,
trackers, CI, and code-review apps, never count. An answer is a reply from the
PR's author on the PR after it (a conversation comment, a review, or a thread
reply) or, for an approval's notes, your evidence-checked confirmation on the
current head. An issue or a PR that mentions the PR never answers it, even
the author's own follow-up or the rest of its stack: the confirm shows those
links as evidence instead. A push never answers it, and
a worker's evidence doesn't either. It doesn't depend on CI, a draft,
conflicts, or merge state. Its attention reasons, `approval-note` and
`review-comments`, come first, and the row's state names it after whatever
else holds the PR, as in "CI failing · approval comment to address". The merge
preview refuses the PR until the feedback is answered.

Four RPCs act on one of your PRs, one write per click, and each sends back
what its row showed: `inventory_mark_ready` the row's `head`,
`inventory_request_review` the row's `reviewers` and the logins to ask
(suggested per row as `suggestedReviewers`: the PR's past reviewers, then its
repository's most recent ones), `inventory_nudge` the reviewers its attention
reason names, whom it re-requests, and `inventory_confirm_handled` the row's
`head` and `feedbackFingerprint`. The first three each write to GitHub.
`inventory_confirm_handled` writes nothing to GitHub. It answers an
`approval-note` reason (an approval comment to address, whatever else holds the
PR) or an `approval-comments` reason (approved, green, merge-clean, every
review thread resolved, and the approval's comments answered but unverified on
this head) by recording
your verification of those comments on that head, which the merge gate accepts
as it accepts a worker's evidence. It reads the approval's notes from GitHub
first and needs evidence of handling since the newest: a commit, a reply from
the PR's author, or every thread that note opened resolved. Without any, it
refuses unless `anyway` is set, and the record says there was no evidence;
every confirmation writes an audit row. An issue or a PR the author linked the
PR from since the note (`evidence.linked`) is shown, as "Linked: folio #362
mentions this PR", but isn't a reply and never counts as handling.
`inventory_confirm_read` returns what the confirm dialog shows and writes
nothing: each note, the `evidence` since the newest, the `headOid` and
`fingerprint` a confirmation binds to, and `ask`, where Ask would send (the
PR's `thread`, a `new` thread `under` a parent that already exists, or `none`
with `why`). `inventory_confirm_revoke` takes back
your own confirmation, however old and even while the PR or its effort is
held, with an audit row; a worker's evidence is never revoked. The notes then
need you again. Each row's `confirmation` says when you confirmed, whether it
still covers this head and these notes, and whether evidence backed it. Each of the four reads the PR again
first. It refuses under a hold or another writer, and when the
facts the step depends on differ from what the row showed. The row's `lastAction` records
each outcome, refusals included. **Merge** opens `action_merge_preview`, and
nothing merges outside it.

## Effort piles

Every unarchived effort sits on one pile: active, on hold, or done.
`effort_piles_get` lists them. `effort_hold` (with an optional `reason`),
`effort_complete`, `effort_resume`, and `effort_reopen` move one effort, and
only when the user asks. A move never changes members, threads, or the effort
itself. `effort_complete` returns the effort's open PRs and active threads. A
resumed or reopened effort joins the end of the active pile (`since`).
Archiving and merging work as before.

## Classifying PRs

`classify_get` suggests where each open PR of the user's that no effort owns
belongs, and moves nothing. PRs that share a ticket, stack on each other, or
sit in one board group are suggested together. Signals from owned work point
them at an effort: a ticket in the title or branch, in any case (3), the PR it
is stacked on (3), a linked thread (2), a board group (2), a ticket prefix (1),
and a code area (1). A ticket prefix names a team, not a piece of work, so it
counts only beside a signal of 2 or more for the same effort; alone or beside a
code area it counts nothing (a `ticket-prefix` standing rule still places PRs
by prefix). A thread linked only through a shared checkout, or linking more
than four PRs, counts nothing. The winning effort's margin over the next sets
the confidence: high at 3 or more, medium at 2, and low at 1. A tie suggests
nothing. Two or more PRs with no effort signal are proposed as a new effort,
and a lone PR whose ticket nothing else carries as a low one-off, which
includes a lone PR tied to an effort only by its prefix. Done efforts and
One-offs are never suggested. Groups are split by effort and confidence for
accepting together, and each group's `signals` lists the specific signals
behind its target, strongest first. The deck shows high, medium, and low as
strong, moderate, and weak, and a weak group asks again, listing each PR with
its signals, before it moves them.

Only the user classifies PRs. Each action takes open PRs of theirs that no
effort owns (the inventory's "No effort" rows) and refuses the whole action if
any of them has an owner now.

- `classify_assign` puts PRs in an effort that isn't done. Optional `tickets`,
  which must be tickets those PRs carry, join too, so later PRs on them belong
  to the effort without another click. Every open PR of the user's on those
  tickets must be in the selection, and a ticket that a PR in another effort
  carries is refused, since a PR whose tickets two efforts own belongs to
  neither.
- `classify_new_effort` starts an effort from PRs, with a name and goal.
- `classify_one_off` puts PRs in **One-offs**, the one effort for standalone
  PRs, which the first use creates. One-offs stays on the active pile. With
  `from` (an effort id or key), it moves PRs that effort owns now out of it;
  each audit row names the effort, and Undo puts the PR back there.

Each action returns an `actionId` and `added`, the number of PRs it moved, and
the audit records one row per PR or ticket it added. `classify_undo` reverses the action while its effort still
owns everything it added. Undoing a new effort also removes the effort, unless
it has since gained other work or a coordinator.

Standing rules are the only automatic placement, and only the user adds them.
`classify_rule_add` takes a `kind` and `value`: `ticket-prefix` (`OPS` matches
OPS-43 and ops43 in a title or branch), `branch` (part of a branch name, or a
pattern with `*` over the whole name), or `repo` (`inkwell/folio` or `folio`),
each naming an effort; or `stack`, with no value or effort, which files a
stacked PR with its base's effort. After each read, a rule places PRs no effort
owns that were opened after the rule was added, one audited action per rule and
effort. `now` also places every PR the rule matches today, and
`classify_rule_preview` lists those PRs before the rule is added. When matching
rules name different efforts, nothing moves. A PR whose rule placement was
undone stays where the undo left it.
`classify_get` lists the rules with the PRs each placed in the last 7 days, and
`classify_rule_remove` removes one and leaves its PRs in place.

## Effort deck

The Workstreams panel opens on the deck: one effort card at a time, flipped
with `[` and `]` or picked with `1`-`9`, with the service cards after the
efforts and On hold and Done piles beside the strip. Every write there opens a confirm that lists
each PR, then waits 8 seconds with Undo; merges run only from the fresh merge
preview. Press `?` for its keys or `⌘K` for every action.

`deck_get` returns the effort deck from one board read (`ghosts`, the PRs the
view drew, returns `gone`: each of them a read found merged, with when, or
closed), and the `deck-changed`
realtime event fires after each inventory read or action, pile move, effort
edit, thread change, and batch step. Every row is an inventory row, filed in
one section by the move its inventory row leads with: `merge`, `confirm`,
`nudge`, `request`, `ready`, or `work` (fixed in its thread) is the user's;
`flight` needs no one yet (a review not yet due a nudge, running checks,
code work or feedback a thread is doing, or feedback the user dismissed until
someone says more); `blocked` waits on something else,
named in `waitsOn`: the PR it is stacked on; `held` is a PR on
hold, with its `hold` reason and since when, and in no other section. A
stacked PR in an approved stack is a merge, since the preview merges the stack
in order. Each row's `turn` says where All PRs lists it (`list`: `turn`,
`dismissed`, `held`, `in-flight`, or `other`) and whether Address takes it
(`addressable`: true, or why not), by one rule for both views.

**Needs you** counts rows in the user's sections on the active pile, service
cards included. Held and done efforts pause. A row the user acted
on (`acted`) stops counting while its write waits or runs, and once it lands
until the view marks its row seen: `deck_get` takes `seen`, when the view last
marked each PR's row seen. A refusal stays theirs, and a mark older than a day
is history. `deck-shared.ts` holds this one rule for every view. Each card's
`yourTurn` counts its rows All PRs lists on Your turn (`turn.list` `turn`),
where a person's feedback waits on the user; the strip chip shows it.

- `active`: one card per active effort, most Your turn first, One-offs after
  the rest, then one service card per repository with open PRs that no effort
  owns (`kind` `service`, `repo`, id `service:<owner/repo>`, named
  `<repo> · service`), most Your turn first. Nothing stores a service card; the
  read model draws it, so every open PR is on a card and an explicit effort
  always wins. Its `suggestions` are `classify_get`'s groups cut to its PRs.
  `deck_batch_plan` takes its id as the `effortId`, and it is always active.
  Promoting one is `classify_new_effort` with all its PRs.
- Last, **Loose threads** (`kind` `loose`, id `loose`), while any thread has
  nowhere else to go. It has no PRs.
- `oneOffsId`: One-offs, once it exists.

Every visible thread is on exactly one card by its own evidence
(`deck-homes.ts`). An explicit effort wins: the thread's intent, the effort it
coordinates, then the effort most of its own PRs are in (merged ones too). Its
own PRs are recorded or started links, a ticket in its title, actions it ran,
and the PR in a checkout only it runs in, never a link through a checkout
other threads share. Without an effort, it goes to the service card of the
repository most of its own PRs are in; a tie goes to its environment's
repository when that is one of the tied, else it is loose. With no PRs, the
checkout only it runs in names the repository, which can draw a service card
with threads and no PRs. An archived effort places no thread, and a thread in
a done effort stays with it on the Done pile. Each card lists its threads on
open PRs first.
- `held`: held efforts' cards, which ask nothing. `done`: each done effort's
  name, merges, and still-open PRs, and each archived effort (`archived`)
  while it still owns open PRs, which pause as a done effort's do.

Each card gives a one-line `status`; `stats` (open PRs, ready to merge, merged
in the last 7 days, median PR age, and the oldest wait); `progress` (merges a
read saw against open PRs); up to three `next` steps (the oldest moves of the
user's, then the oldest waits, never a held PR); `blocked`, oldest first; a `linear` rollup of the stored Linear details of its
tickets (`known` 0 means no Linear data), with each ticket's state type, priority, and points (`issues`) and where Linear and GitHub
disagree (`reconcile`: tickets Done in Linear with PRs on the card still open, and open tickets whose PRs all merged in the last 14
days, as read 10 minutes or more after the newest merge); `people` (reviewers the user waits
on, and reviewers whose requested changes wait on the user); its parent and PR
`threads`, read-only; the week's merges, reviews, and pushes; its rows by
section; and on an effort's card, its Markdown `notes` (`body`, `revision`),
null on a service card. `effort_notes_save` saves them with the `revision`
being edited; one saved since refuses it. A merge counts once a read sees it: the poll's read of a PR that left
your open PRs, a Refresh, or a checkout scan. A merged PR stays in the effort
whose ticket it carries.

Cards and Overview keep every open PR visible with its current status and next
or queued action. Held, Advance available, and Advance queued scopes name each
PR by repository and number; available means eligible for a plan, not already
running. Hold reasons remain visible, including PRs inside held efforts.
Overview also lists repository work and loose threads. Each PR row offers its
next action directly, plus applicable Hold/Release, Move, Dismiss, and Refresh
controls. An Overview action carries that PR and its owning card, never the
current selection; merges still open a preview and writes retain their existing
confirmations and Undo. Disabled buttons explain stack gates or work already
running, and outcomes stay on the affected row. Linked workers show
Working, Needs you, Failed, or Idle; a pending interaction takes priority over
an active/idle thread state. Each worker names every PR it owns on the card.

### Batch actions and Advance

Every write from the deck is a batch the user confirms, and each step is only
on their click. `deck_batch_plan` takes a `kind` (`nudge`, `request`,
`ready`, `release`, `ask`, `fix`, `address`, or `advance`) and an `effortId`, `prUrls`, or both. It
writes nothing. It returns each PR's write (`items`, with `what` it does and
the facts it binds to) and why any selected PR is left out (`skipped`). A plan
covers the Needs you rows of that kind. The deck's per-row Advance is
`advance` with that one PR in `prUrls`. `advance` covers every safe kind in
the effort, in the order nudge, request, and ready: never a merge, which only
the fresh merge preview does, never a thread's work, and never confirming
review notes, which `inventory_confirm_handled` does one PR at a time. A
batch an older build planned with a confirmation refuses that item when it
comes due and sends the rest. A request
asks the `reviewers` given, else each PR's first suggested reviewer. It takes
`seen` as `deck_get` does, so a row whose write landed isn't planned again
until the view marks it seen. `release` covers the effort's held PRs: it lifts
each hold after the same window and writes nothing to GitHub, so it runs on any
pile, and Advance never includes it. `ask` takes one PR in `prUrls` whose
approval notes wait on the user, and sends its thread (the one working on it,
else the one it started in) a request to address the approval's notes; it confirms nothing.
A PR with no thread gets a new one in its checkout, beneath its effort's
repository controller (or its repository's parent when no effort owns it),
only when that parent already exists: Ask never stores an effort or starts a
coordinator, controller, or parent, so without one the PR is skipped with why.
`what` names where it goes. Advance never includes it. `fix` covers the rows
in Work in threads: each PR gets its own fix (`fixes`: resolve conflicts,
update the branch, fix CI, address changes, or resolve review threads, from
GitHub's facts) in the thread Ask would use, or a new worker on the code-work
model beneath the same parent when it has none, else it is skipped with why.
When it sends, it reads the PR again and asks only for the listed fixes still
needed on the head the row showed, and only where the listing said: a PR whose
thread appeared or went away since is refused. It never merges, and Advance
never includes it. `address` takes the selected Your turn PRs, with `mode`
`batch` (the default) or `each`. Each item names its `feedback` and, for a
batch, `where` it's worked: its checkout, or for a PR with none, a new
worktree from a local checkout of its repository ("No checkout: a new
worktree from folio"); `skipped` names why a PR stays out: no feedback
waiting, a hold, a held or done effort, a Dismiss, an agent or open run on
the PR or its checkout, a write just sent, or, for a batch, no local
checkout of its repository to add a worktree from. A batch plan returns its
`thread`: the project, and the effort parent it starts under when every PR
shares that effort, else none. Project selection uses the PR's checkout or
the repository checkout that supplies its new worktree. When the shared
effort has no parent yet, the plan names a new effort thread and binds its
`effortId`; confirmation creates that parent before starting its worker.
Planning and Undo create no threads. An existing parent is reused; an
archived or missing recorded parent requires restoration or replacement.
When it sends, it reads each PR again, claims
every PR still waiting in the run record (one `address-feedback` run per PR)
with nothing awaited between the last check and the last claim, and starts one
worker titled by its PRs ("Address feedback: quill #210, #211 · folio #301", with
"+N more" past 80 characters) on the code-work model. The worker
addresses each PR's review feedback in turn, in its checkout or in a
worktree it adds with `git worktree add` beside that repository checkout
(reusing one already on the head branch, never a fresh clone), replies to each note,
never merges, and ends with a plain report per PR. Once
the worker starts, each PR is linked to it (`pr_threads`) for as long as the
PR is open, whatever the run log prunes. Agent and thread starts refuse a PR or
checkout a claim holds until the start returns, then while the thread works or
asks you something. A result clears nothing: only a reply on the PR or your
Confirm does. `each` sends Ask or Fix
to each PR's own thread, and skips a PR with none.

`deck_batch_start` confirms a plan within 10 minutes of it, while each of its
PRs is on the active pile (a release needn't be). The batch sends 8 seconds later (`dispatchAt`)
unless `deck_batch_undo` cancels it first. Its rows show `acted` as `queued`,
with its `batchId`, while it waits. Each item then runs the inventory action
for its kind, with the facts the plan bound: the action reads the PR again
first, and refuses under a hold or another writer, or when those
facts changed. A PR whose effort is held, done, or archived by then, or that
left its effort, is refused too, except for a release. A refusal refuses that PR only.
`deck_batch_get` returns each PR's result: `sent`, `refused` with why, or
`unknown` when a restart cut it off mid-send, which is never sent again. A
restart keeps a waiting batch's window and its cancel. A batch more than a
minute past its window when the plugin loads sends nothing more: each PR it
hadn't reached is `refused`.

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
  Path-only links do not seed groups directly, and a thread linking more than eight clusters
  counts nothing.

A bounded Jev review can revisit uncertain singleton and mixed-group
neighborhoods using evidence about a shared outcome. Path-only thread links
participate only when the thread's title also matches the work. The review
reuses cached decisions when the evidence is unchanged and leaves established
effort membership fixed.

## Linear details

Ticket detail (title, state, priority, estimate, dates, project, parent,
labels, url) is fetched with the key whose workspace owns the ticket's prefix,
batched, and cached for 12 hours. The sync covers tickets on checkouts and open
PRs, live efforts' own tickets, and tickets of PRs merged in the last 14 days.
A merged PR's ticket read before the merge, or under 10 minutes after it, is
read again on the next scan, since Linear moves it itself soon after.
Workspaces and their team keys are re-read daily and after a settings change. A
prefix no key owns gets no detail; that is not an error. Failures are logged
once and keep the previous cache. Keys stay on the server and are never logged.

The first scan after Linear detail arrives regroups the clusters it changed,
which costs a one-time burst of model calls, logged as `regrouping with Linear
detail: N clusters`. Later scans return to zero calls.


## Reading efforts and planning advancement

Overview triages efforts; an effort card is a read view with exact PR states, holds, queued actions, and linked worker statuses. Open a PR from the card to focus its row in All PRs, where individual PR controls and batch selection live. Card shortcuts do not dispatch PR writes.

**Plan Advance All**, on All PRs, starts one planning thread for every open PR that is not on hold, regardless of the current selection. It saves a compact cached snapshot to the planning workspace and sends an attention index grouped by Jev (board rules are the explicit fallback when Jev is unavailable). The planner prioritizes actions, groups related work, and asks for missing decisions. It has planning instructions only: it does not merge, release holds, send review messages, or start workers. Held PRs are excluded from planning and only their excluded count is sent. Full review bodies and diffs are not cached in this packet; read specific missing evidence when it is needed, and revalidate action-critical facts after the user approves execution.

Idle PRs offer **Start fresh thread** in All PRs. This starts a new code-work conversation with current PR and checkout facts, reuses a live effort parent or creates a missing one, and leaves previous conversations alone. Other worker threads are context, not a reason to refuse this explicit restart; the user manages multiple workers and checkout conflicts. Holds and stopped efforts still require resuming first.


Both Your turn and Other open PRs support checkbox selection. **Advance selected** previews the exact selected scope and starts one fresh code-work thread across those PRs, including mixed selections. The Other heading checkbox selects that list. Holds, stopped efforts, changed heads, and unavailable checkouts are skipped with reasons; older workers do not block the explicit start. **Address** remains specific to unanswered feedback on Your turn. Advancement does not merge.


Effort cards expose **Threads** with status counts, last activity, exact PR links, and per-thread **Archive**. The reversible action rechecks live idle status and refuses threads with descendants; opening a thread in BB provides family management. **Undo** and **Archived threads…** restore archived conversations without starting an agent. Thread insights read the existing cached snapshot rather than fetching additional event logs.
