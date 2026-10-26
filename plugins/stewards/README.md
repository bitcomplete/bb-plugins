# Stewards

Give a Linear ticket or a GitHub pull request **a long-lived thread that
manages it until it is done**, and production a thread that watches it and
files what goes wrong. The thread, a **steward**, acts on the entity
as you, by a playbook the project keeps in `.bb`, and you steer it only from
bb. [DESIGN.md](DESIGN.md) is the design; this is how it is built and run.

## What it does

- **Adoption.** A Linear issue in a listed team carrying the project's label
  (`bb-managed` by default) gets a `ticket` steward. A labelled pull request
  in one of the project's repos gets a `pr` steward. Every non-draft pull
  request a teammate opens in those repos gets a `review` steward. Each
  steward reports to its nearest managed ancestor's steward, or to the
  project's **project steward**, through its binding — not as a child
  thread: bb wakes a parent thread every time a child finishes a turn, and
  on bithub that was 88 of the project steward's 96 turns. A project's
  stewards share one sidebar section, named after the project; see
  DESIGN.md §15.
- **Ops stewards.** Each target in the project file's `ops.targets` (a
  Kubernetes namespace or a Sentry project) gets an `ops` steward, reporting to the project
  steward, for as long as it is listed. The plugin looks at the target with
  `kubectl` on the project's machine, the developer's own, as them (through
  its host entry, [host.ts](host.ts), and [kubectl.ts](kubectl.ts)): pods,
  Warning events, Deployments, and a failing container's last log lines.
  It names each
  problem by a fingerprint (workload, container, error signature;
  [ops.ts](ops.ts)) and keeps a fingerprint → Linear ticket map. A new
  problem, or one back after its ticket was resolved, wakes the steward at
  once. Every requeue (`requeue-default`, 1h in the template) is a turn
  whatever the look found: a problem still failing under its open ticket is
  a comment there and nothing new filed, and a healthy look is a short
  "all healthy" report. The steward
  files one ticket per problem and escalates a `decision` to the project
  steward ("Filed BB-N (high), recommend adopting"); the project steward
  adopts with the label and Todo, the ordinary path. Every kubectl call the
  plugin makes passes one gate that allows only `get`, `describe`, `logs`
  and `auth can-i`, and the playbook's `may` list holds the steward to the
  same; the developer's own rights are broad, so that is a convention, not a
  wall. Until kubectl can read a target, its binding waits and `bb stewards
  check` says "cannot read the target". DESIGN.md §18.
- **Dependency stewards.** GitHub scans; the stewards turn Dependabot alerts
  into tickets. Every repo in `repos.json` not in `github.exclude` (or the
  explicit `{ kind: "dependabot", repo }` targets in `ops.targets`) gets an
  `ops` binding that runs `deps-alerts` and is woken by the
  `dependabot_alert` doorbell; the github plugin reads the alerts with the
  developer's token and leases each repo as a `dependabot_repo` (a `repo`
  lease does not receive alert doorbells). Severity sets the Linear priority
  and a due date from `deps.sla`; critical and high get their own ticket,
  medium and low coalesce into one open ticket per repo per ecosystem, and a
  new alert joins or tightens it. A fixed or dismissed alert trims or closes
  its ticket, and the nightly pass re-lists open alerts as the backstop. A
  `dependabot[bot]` version-update pull request is adopted under `deps-prs`,
  reviewed, and escalated for a human merge; it is never merged. Reading
  alerts needs the token's alert access; a server whose login cannot read
  them skips the targets, and `bb stewards check` says which. DESIGN.md §19.
- **The reconcile loop.** linear and github-watcher hold bb-gate-hooks leases for the
  project's teams and repos and for every bound entity, and ring this plugin
  on a doorbell. A ring is debounced, the entity is snapshotted, compared with
  the last observation, and the steward is woken only for an actionable
  change: a phase change, a human comment, a review, checks finishing,
  someone else's push, a worker finishing, guidance, an approval, a spec
  change, or its requeue time. While any worker of the binding is in flight
  — from its spawn until it is stopped, failed or archived, across the idle
  between its turns — the worker's own work on a pull request (checks
  finishing, description edits, pushes and comments from your account, which
  every thread posts as, and the reviewer's `bb-review` markers) is not a
  reason to wake; a reviewer round that changes the lane is. BB-52 scopes
  that to the worker's own pull request — its head branch is one of the
  binding's worker threads' branches, or a worker named its URL — and quiets
  three more causes: a state move between the build and review stages, a
  worker turn ending to wait (only a question, an error report or a gone
  thread wakes), and a terminal state the steward's own last report already
  named (the binding ends from the mechanical tier). A foreign pull request
  wakes on its link and keeps its activity actionable. Everything not
  actionable is kept as a quiet note and shown in "What changed" at the next
  turn something else makes due, and `bb stewards show` lists it as a pending
  note.
- **Wakes are self-contained**: playbook instructions for the phase, the
  ready gate, guidance and holds, the snapshot, and what changed. Each
  woken turn ends with `steward_report`, the status record. A wake past
  30,000 characters is cut in its snapshot, never in what changed. Because
  a wake carries what the steward needs, its transcript can go: after a
  steward's or the project steward's turn, the plugin compacts its context
  once it holds more than **Compact a steward above this many context
  tokens** (120,000 by default; 0 leaves it to the provider), and before a
  wake that would push it over.
- **The invariants reach turns that are not wakes too.** A plain message, a
  `bb thread tell`, a child notice and the first turn after compaction are
  not wakes the plugin composed. On every turn the SDK resolves a
  per-thread system context, and the plugin injects the brief there: thread
  id, the playbook's allowed actions, the ready gate, the exact worker
  spawn command, the standing rules and "end with `steward_report`". It is
  system context, not transcript, so compaction cannot lose it. Every wake
  also names the durable commands: `bb stewards brief [<binding>]` prints
  the whole brief, and `bb stewards spawn-flags [<binding>]` prints the
  runnable `bb thread spawn …` command from `models.worker` and the project
  environment. A worker whose provider, model, reasoning level or
  environment provider differs from the playbook's is stopped in the
  `thread.created` handler, and the steward's next wake says why and gives
  the right command. DESIGN.md §6.
- **Two tools.** `steward_report` ends a turn with the status record and,
  when needed, an escalation; `steward_update` steers a binding (guidance,
  deciding or forwarding escalations, priority, holds, models, approving a
  spec).
- **Scheduling.** Two tickets changing the same files at once end in a
  rebase for whichever merges second, so the project steward sequences
  them. Each steward reports the repo-relative paths its work changes
  (`steward_report { touches }`); two bindings overlap when a touch of one
  is, or is inside, a touch of the other. When a ticket's ready gate passes
  while another binding is building or reviewing on the same paths, the
  plugin files a `schedule` escalation with the project steward, like the
  approval request, and the ticket steward is told to start no workers
  until it is decided. The project steward holds the ticket behind that
  work (`steward_update { hold, behind: [keys] }`, which closes the request)
  or lets it start (guidance + resolve, not asked again until a new overlap
  appears). A hold placed `behind` lifts itself once every binding named
  has merged its pull requests or ended: the held steward is woken with a
  note to rebase. The project steward is told only when the work waited on
  is not finished — its ticket not terminal and its steward not reporting
  `steward_report { noMorePulls: true }` after every linked pull request
  merged; a finished-work lift is a note on the held binding and the
  project steward's next digest, and starts no turn. When one lift frees
  two waiters that overlap each other, the first by priority then age is
  released and the rest are held behind it. A binding reaching a terminal
  state, or detached, releases what waits behind it as its ending begins,
  so a steward that follows through for hours holds nobody up. A hold that
  would form a cycle is refused. Work whose pull requests have all merged
  and whose steward reported no more are coming no longer counts as in
  flight; merged with no such report is still at work, because the next
  pull request would conflict. Before filing a request the plugin re-reads
  the conflicting bindings' pull requests from GitHub, and a ticket past
  its ready gate that links a new pull request re-runs the check. A ticket
  whose gate has passed with nothing holding or scheduling it counts as in
  flight already, so two tickets going ready in the same minute schedule
  against each other rather than racing to In Progress. `bb stewards show` prints
  what a binding touches and overlaps; the project steward's wake lists
  both for every binding. Everything else is the tools every thread has: `linear_*`, `gh`,
  and `bb thread spawn` / `tell` for workers, which stewards recognizes as
  workers by their lifecycle owner.
- **Lifecycle.** A terminal state gets a wrap-up turn with its workers
  still running. The steward either ends the binding there, or keeps it open
  to follow through (`steward_report { followThrough }`) on what the state
  does not cover, such as a deploy to watch or production to verify. It is
  then woken as usual until it reports without `followThrough`, or until the
  playbook's `follow-through` cap (6h by default) runs out and the project
  steward is told. Removing the label stops the workers at once and gets one
  stop turn. When the binding ends, its workers are stopped, the steward's
  thread is archived, and the workers go with their lifecycle owner.
  Reopening, or re-adding the label, wakes the same thread, bringing it back
  from the archive; an entity that leaves its terminal state before the
  binding has ended takes the ending back. A steward whose wake turn reports
  `actor: other` (waiting on a reviewer or the author) is hidden rather than
  archived: it leaves the sidebar's organisation and unread attention but
  stays addressable, so a later wake can reach it. It is made visible again
  when it needs you (the report puts you next, an escalation is open, or a
  question is unanswered) and stays hidden across "nothing changed" wakes.
  Hiding cascades to its finished workers and their reviewers, so no row is
  left behind without its steward; a running worker is unaffected, and
  showing the steward again shows them. Binding end still archives.
- **Finished workers and reviewers.** A worker whose turn ends is marked
  `finished`; once the reconcile that consumed its report has woken the
  steward, its thread is archived, so the sidebar keeps only work in flight.
  A worker that ended with a question for the steward stays visible until it
  is answered. A reviewer is archived once its round is consumed — the
  worker's next turn ends, or a newer round reviewer is spawned for the same
  worker — and the newest reviewer for a worker is never archived while that
  worker is in flight. A later message to an archived worker unarchives it,
  and it shows under its effort again; the steward's own `bb thread tell`
  refuses an archived thread, so it runs `bb thread unarchive <id>` first, or
  starts a fresh worker.
- **thread-briefs.** Every steward, the project steward included, is
  spawned with `threadBriefs: { rename: false, group: false, archive: false }`
  in this plugin's metadata namespace (see thread-briefs' "Threads a plugin
  runs"). thread-briefs then never renames a steward, whose title carries
  its entity key, never moves one into a status section or auto-archives
  it, since between wakes it reads done while its entity is still open.
  Workers and reviewers a steward spawns are tagged the same way, so
  thread-briefs leaves them in the project's section too.
  A ticket or pull request steward's row draws the stage ring like any
  thread's. The project steward also gets `ring: false`: it has no stage of
  its own, so its row keeps bb's own indicators. The project steward
  is titled "<project name> project steward". The sweep tags threads
  spawned before this, lets go of stewards an earlier version made children
  of another steward, and renames an older project steward once. After
  that, a project steward renamed by hand keeps its name.
- **The sidebar and the unread dot.** A steward is put in its project's
  section when it is spawned, and a worker or reviewer the plugin did not
  place is filed there by the `thread.created` handler. A finished worker
  leaves the sidebar once its report is consumed, and a consumed reviewer
  once its round is; a waiting steward's finished workers and their reviewers
  hide with it and come back when it does. The unread dot
  means "needs you": a report that waits on someone else, with no
  escalation, question or needs item, is marked read. A report that needs
  you is left unread.
- **Workers** are top-level threads with their own checkout, one per bounded
  task, owned by their steward through `--lifecycle-owner-thread`. A reviewer
  is a child of the worker that started it, one per review round. Workers do
  not nest under their steward's sidebar row: bb's list trees by parent
  thread, not by lifecycle owner, so they show loose; whether it should tree
  by lifecycle owner too is a core question. A runaway guard stops a
  steward's workers past a per-hour limit.
- **Decisions stay with the agents.** Escalations are conditions on the
  status record, routed to the parent steward, then the project steward,
  which decides from the project's guidance (AGENTS.md, design docs). Only
  what the project file lists under `bigDecisions` is forwarded to you, by
  the project steward asking in its own thread, where thread-briefs shows it
  as waiting on you. Substantial specs are approved by the project steward
  unless a playbook says `approval: me`. The plugin asks for that approval
  itself: whenever a ready gate's checklist is met, the ticket is
  substantial and the current spec has no approval, it files an `approval`
  escalation with the project steward, or an `approve-spec` item on the
  Stewards page when the approver is the user (`approval: me`), whatever
  the steward's report says, and closes it once approved or no longer
  needed. When the project steward forwards an `approval` escalation to
  you, the plugin files the same `approve-spec` item and keeps the
  escalation open, linked to it, so a forwarded approval is answered with
  Approve/Decline exactly as `approval: me` is; a forwarded `decision`
  stays a question. An approval is recorded from the approver's
  words wherever they are: the project steward's guidance that resolves the
  request, the user's answer on the Stewards page, their message in the
  steward's thread, or their unsigned approving comment on the entity. A
  page answer that is neither an approval nor a clear refusal goes back to
  the project steward to interpret, rather than being remembered as a
  decline. A spec comment the user writes from their own thread counts
  toward the spec and, with `approval: me`, is its own approval. A request
  the approver declines is not made again until the spec changes, and while
  one is open the steward is told not to ask the user again: the request is
  on the Stewards page, and a report that asks anyway shows as a playbook
  violation in `bb stewards show`. The project file's optional
  `standingRules` list is shown in the approval wake, so the project
  steward adds only the limits a change needs, in at most three points,
  instead of restating rules that already bind every pull request. A
  decline's objections are carried to the ticket steward as a checklist;
  the same objection declined twice is forwarded to the user rather than a
  third round. When the entity changes while one of its
  escalations is with you, the project steward is woken with the change too,
  since you may have answered on the ticket rather than in its thread. A
  status blocked on the project steward or the user with no open
  escalation or needs item is flagged in `bb stewards list` and the digest.
- **"Needs you" items** are the structured things only the user can do. The
  plugin files the gate items (`approve-spec`, `approve-pr`, `merge`) from
  the snapshot; a steward's `decide`, `configure` and `provide-secret` asks
  are the one `escalations` record with `route: me` and a `resolution`
  (`choice`, `text`, `approve-decline`, `secret`, `done`), forwarded by the
  project steward (BB-30). Both are listed under "Waiting on you" on the
  Stewards page with a link and a button each, in the digest, and by
  `bb stewards needs`. The buttons run on the server as the connected user,
  unsigned: Approve posts the "Approved <sha> from the Stewards page"
  comment, Merge re-checks the lane gate and squash-merges through the
  server's `gh` login, and every action wakes the binding's steward with the
  closure under "What changed". A button is shown only while the server can
  verify its preconditions; otherwise the item says why not. `bb stewards
  done <id>` closes one from a thread. A `choice` resolution carries fixed
  labels (two to six): the page shows one button per choice, a note field
  and **Other…** instead of a free-text **Answer**, and a choice is saved as
  guidance. `bb stewards done <id> --choice <label>` records the same from a
  thread. A `blockedOn` naming the user, the owner or a human is refused
  unless an open item says so. The sidebar's **Needs you** block and count
  badge show the same items, so a question reaches you where you already look
  (BB-46).
- **One escalation chain (BB-30).** Every hop is one `escalations` row: a
  worker's `bb stewards escalate` goes to its steward, a steward's
  `steward_report { escalate }` to the project steward, and only the
  project steward reaches the user. Each layer decides from the guidance
  when it can and forwards only what it does not settle. Whoever decides
  answers the originating thread directly: the answer is recorded verbatim
  as guidance on the originating binding with who decided, the bindings in
  between get a quiet note and no turn, and the originating thread is told
  (a `bb thread tell` for a worker, a wake for a steward). The
  owner-reviewed lane is the project file's decide list (`bigDecisions`,
  each entry `decide: project | user`): the project steward approves a
  `project` entry (recorded in the store, bound to the pull request's head
  sha, never a GitHub comment or review) and forwards a `user` one to you.
  A missing or unknown mark, a change to the list, `bigDecisions`, `prGate`
  or the approval code is always yours.
- **Lessons** are a project steward's general judgements, made permanent in
  `.bb` instead of being lost with the ticket that raised them. It records
  one with `steward_update { lesson: { text, file, scope } }`. A lesson
  moves through tiers: `candidate` → `trial` → `promoted` → `retired`. A
  recorded lesson starts `trial`; the nightly pass promotes it when it is
  cited on 3 distinct bindings with no corrections and has been in trial 14
  days, and retires it at 30 days uncited or on any correction (a promoted
  one at 90 days uncited or 2 corrections). The thresholds, caps and decay
  half-life are under `lessons` in `stewards/project.json`; the design's
  defaults apply when the key is absent. Trial lessons are injected into
  wakes under `## Lessons (trial)`; only promoted ones reach `.bb`, with a
  `<!-- lesson:<id> -->` anchor, and only that lesson's own file (multi-repo
  fast-forwards the canonical `.bb`). A `boundary` lesson — credentials and
  reach, who may direct a server, irreversible production steps — is filed on
  the Stewards page with **Merge** and **Drop**, and only you merge it; a
  lesson can never target `stewards/project.json`, so it cannot move a big
  decision to the project, loosen the pull-request gate or relax an approval.
  A user's answer to a forwarded escalation on the Stewards page (or from a
  thread) wakes the project steward with that answer as a lesson candidate: if
  it is a general judgement the playbook should carry, the project steward
  records it as a lesson. A resolve carries `cites: [lesson ids]` — the
  lessons it rested on — and the plugin counts `hits` (once per distinct
  binding), `corrections` and `lastCitedAt`. `bb stewards lessons [--all]`
  lists tiers and counts, `bb stewards drop-lesson <id>` drops one. The
  digest carries nothing about lessons. DESIGN.md §20.
- **The nightly pass** (01:00 in the project's time zone by default, done by
  02:45 so bb-gate's 03:00 restarts do not cut a turn) gives every open
  binding a turn, then wakes the project steward for the morning digest.
  A half-hourly mechanical sweep is the adoption and stuck backstop.
- **The Stewards page** (a nav panel, [app.tsx](app.tsx)) has a tab per
  stewarded project: what waits on you (needs items with their links and
  buttons, questions the project steward put to you, which you can answer
  and close there, forwarded escalations and approval requests), what is in
  flight by stage with each status record and running workers, what is stuck
  or held, what ended in the last two weeks, and the latest digest with its
  date.
- **Questions and asks to you** are escalations with `route: me`, kept in
  the store from the moment the project steward asks
  (`steward_update { ask }`, or forwarding an escalation) until it records
  your answer (`steward_update { resolve: "<id>", answer }`) or you close it
  on the page. A forwarded escalation and its ask close together. The
  nightly wake lists them, with the previous digest, what moved, what waits
  on you and what is stuck, all read from the store, so the digest does not
  depend on the project steward's memory.
- **The settings page** (Settings → Plugins → Stewards, [app.tsx](app.tsx))
  shows each stewarded project's configuration, problems, project steward
  and nightly pass, runs `bb stewards check` on a button, and lists every
  open steward with its latest status record and open escalations. It is
  read-only; steering stays with the project steward and `steward_update`.

- **@bb mentions.** A Linear comment that mentions `@bb` reaches this
  server through linear (`stewardsSession`, see linear's README, "@bb
  mentions"). A mention from the server's owner goes to the issue's ticket
  steward when the issue has an open binding, else to the project steward
  of the project whose file lists the issue's team; with neither, linear
  answers that stewards is not set up for that team. The wake
  ([wake.ts](wake.ts), `formatSessionWake`) carries the words, the session
  id and who asked, and the turn ends with exactly one
  `linear_session_reply`, plus a `steward_report` from a ticket steward.
  **A mention from anyone else runs no model turn at all.** bb core cannot
  withhold a turn's tools, so the words are parked under a short id
  (`r-xxxx`); the plugin answers the session itself, asking the owner to
  `confirm <id>`. Only that deterministic reply releases the one request,
  and the steward is then woken with it framed as the owner's confirmation.
  A vague "sure" releases nothing and is re-asked once. The three intents
  in BB-11 use tools stewards already have: "build this" is
  `linear_update_issue` (label and Todo), "halt work" is a hold plus a move
  to Backlog, and a redirect is `steward_update { guidance }`. A steward may
  put its own binding on hold for this, but only its parent or the project
  steward lifts a hold.

## The sidebar thread list and its toggle

BB-44 registers a replacement for bb's own sidebar thread list through the
exclusive `experimental_threadList` slot: one project dropdown,
in-flight efforts grouped by the steward relationship, and collapsed Watches
and Recently ended rows. BB-45 makes it switchable from where you are.

**The footer toggle.** A `ShieldCheck` icon in the sidebar footer (next to
Settings) opens a small panel above the footer row with a **Stewards
sidebar** switch and one line of help. On writes `sidebar.threadListProvider`
= `stewards/sidebar` (the list BB-44 registers); off writes it back to bb's
own `thread-list/thread-list`. The sidebar's list swaps without a reload. The
footer is host-rendered and stays in place under either list, so the icon is
reachable in both states. Hide it like any footer item through bb's footer
preferences (Settings → Appearance → Sidebar → footer items, or
`sidebar.hiddenFooterItems`).

**The Appearance page alternative.** The same choice is Settings → Appearance
→ Sidebar → the thread-list provider; the toggle is a shortcut to it, not a
second setting. Both write the one UI preference.

**The default-provider pin.** bb resolves an unset (`__automatic__`)
provider to the first installed thread list other than the bundled
`thread-list/thread-list` — the stewards list — so without a guard BB-44
would change everyone's sidebar the moment it landed. On load the plugin
reads the preference and, when it is unset or `__automatic__`, sets it to
`thread-list/thread-list`. An explicit value, including `stewards/sidebar`,
is left alone. The write is best-effort: a failure is logged and the sidebar
keeps working. (`bb.onInstall` is not usable here; it does not run for
plugins baked into the `bb-server` image.)

**The Needs you block and the picker badge (BB-46).** The project dropdown
shows each project's count in its option label and the summed count in a small
pill beside it. Above **In flight**, a **Needs you** block lists one row per
item: the entity key opens the entity, one line of what, and a question's or
`decide` item's fixed `choices` as small buttons. A choice makes the same
write the page does (`stewardsAnswerQuestion` for a question,
`stewardsNeedAction { action: "choose" }` for a `decide` item) and refetches.
An `approve-pr` row carries the page's three actions: **Open the pull
request** opens the item's `url`, **Approve** makes the page's one-click
approval (`stewardsNeedAction { action: "approve" }`, no confirmation, the
server's refusal shown in the row), and **Details** opens the Stewards page at
that project; its text wraps so the repository, number and title are readable.
Every other row's page button is **Details** too: a row without choices, or a
`provide-secret` item, opens the Stewards page at that project. The block and
the board page read one server function
(`needsYou`), so the sidebar and the page can never disagree; a
non-actionable need is on the page but not in the sidebar. The count and the
items come from `stewardsSidebar`; the plugin publishes
`needs-you-changed { projectId }` on its realtime channel whenever a question
is opened or answered, an escalation is filed with or forwarded to the user
or resolved, a need is filed, updated or closed, or a binding ends or reopens
— including from a steward's own tools — so every open sidebar and the board
page refresh within seconds. The half-minute poll stays as the fallback.

**Per client or per server?** Checked on a dev server: the preference is
**server-synced**, so a flip is per server, not per browser. Every open
window of that bb server shows the same list, and the choice survives a
reload. `bb settings ui get sidebar.threadListProvider` — a different client —
sees the value the toggle wrote, and bb tells the other clients the preference
changed. Each developer has their own server behind bb-gate, so in practice
the choice is per developer.

## Configuration

In the project's `.bb` (the multi-repo project repo), read from committed
HEAD through multi-repo's `readProjectFiles` and `repoSet`:

```
stewards/
  project.json          Linear teams, excluded repos, label, nightly, project steward model
  playbooks/
    linear-tickets.md   front matter + one ## section per phase
    github-prs.md
    github-reviews.md
    ops-watch.md        no phases; ## New, ## Recurring and ## Returned sections
    deps-alerts.md      the Dependabot alert side: file, batch, tighten, close
    deps-prs.md         adopts dependabot[bot] pull requests; escalates, never merges
```

`bb stewards init` writes starting points ([templates.ts](templates.ts));
`bb stewards check` validates them against Linear and GitHub. A playbook that
fails to parse is reported and bindings keep running under the last good
version. Project file fields beyond the design: `nightly.until`,
`nightly.max`, `playbooks` (which playbook governs each kind),
`reviews.enabled`, `adoption.perPass`, `bigDecisions` (what reaches you;
defaults in [config.ts](config.ts)), and `ops`: `targets` (`{ kind:
"k8s-namespace", name }`, at most ten), `team` (where tickets are filed; the
first of `linear.teams` by default, and it must be one of them) and
`context` (the kubeconfig context kubectl uses; the machine's current one
when left out) and `autoAdopt` (Linear priorities, `urgent`, `high`, `medium`, `low`, whose
tickets the ops steward labels for a steward itself when it files them).
A `{ kind: "sentry-project", org, project }` target watches a Sentry
project with the plugin's **Sentry token** setting (a user auth token with
`project:read`, `event:read` and `event:write`; `Sentry API` for a
self-hosted server), rung by bb-gate-hooks the moment an issue is created
or regresses and backed by the same periodic look; the Sentry issue id is
the fingerprint, and the wake carries the issue's title, culprit,
permalink, counts and latest stack trace ([sentry.ts](sentry.ts), DESIGN.md
§18). With `ops.sentry.resolveOnDone` on (it defaults off), the look
resolves a mapped issue whose ticket is Done while Sentry still shows it
unresolved — the plugin's only Sentry write — and notes it in the look;
`event:write` is the scope that write needs.
`ops-watch.md` is read only when `ops.targets` lists a k8s namespace or a
Sentry project.

The `deps` object is the dependency watch: `sla` (a duration or `asap` per
severity; critical→urgent, high→high, medium→medium, low→low), `batch` (the
window a medium or low alert may wait for company), and `autoAdopt` (the
severities whose tickets are labelled and moved to Todo when filed).
`deps-alerts.md` and `deps-prs.md` are optional: a project that has not
written them runs no dependency watch. `bb stewards init` writes them, and
`bb stewards check` validates `deps.sla`, `deps.batch` and `deps.autoAdopt`
and reports each repo whose alerts the `gh` login cannot read.

Playbook front matter: `name`, `kind` (`ticket`, `pr`, `review`, `ops`),
`source` (`linear`, `github`, or `k8s` or `sentry` for `ops`), `phases` (state → `{ stage,
stuck }`; none for `ops`), `terminal` (at least one; none for `ops`), `ready` (`checklist`,
`substantial`, `approval: project` (default), `me` or `{ linear-state: … }`),
`promote`, `may` (policy stated in every wake), `models` (`steward`, `worker` as
`provider/model/level`; `claude` means `claude-code`; the model may hold
slashes, as Pi's `pi/fireworks/accounts/fireworks/models/…` do, and the last
part is the level only when it names one), `requeue-default`,
`follow-through` (how long a terminal binding may be kept open, 6h by
default), `skip-authors`, `deployment`.

`deployment` names where a merge is confirmed live (BB-53): `source`
(`github`), `repo` (the repo the deployment is created on, e.g.
`bitcomplete/bb-gate`), `environment`, `carries` (the rule the steward applies
to decide whether a deployment carries a merge; free text, shown in the wake
alongside the deployment) and `timeout` (how long to wait for one, 6h by
default). With it, a merged pull request is recorded as awaiting deployment,
the github plugin leases the repo as a `deployment_repo` and a `deployment`
doorbell for the repo and environment wakes the binding, and the steward
reports the verdict with `steward_report { deployment: { state } }`; a
failure/error deployment or a timeout wakes it with the run URL. The wake's
`merge <sha>` is the pull request's head, and a squash or rebase merge
rewrites it, so decide ancestry from the deployment's own `ref`/`sha` and the
repository rather than the head sha alone. With no
`deployment`, the playbook behaves exactly as before.

The wake numbers the ready checklist, and `steward_report` takes each item by
its number (or the playbook's exact words). It stores the playbook's wording,
so the gate matches what the steward meant, and it refuses anything else and
records nothing, listing the numbers. Checklist items can then be as long as
a project needs.

## Enforcement

None beyond the playbook's word. A steward acts with the user's credentials
and a shell; its `may` list and the ready gate are stated in every wake, and
everything it writes is signed with its thread, so what it did is visible
afterwards. The runaway guard is the one hard stop. GitHub writes go through
`gh`; there are no write tools to check. Ops stewards are no exception:
kubectl acts as the developer, and only the plugin's verb gate and the
playbook keep the steward to reading.

## The contract with linear and github-watcher

[source-contract.ts](source-contract.ts) is copied byte for byte into
`plugins/linear` and `plugins/github-watcher`; `contract.test.ts` fails when the
copies drift. Sources serve `sourceSnapshot`, `sourceValidate`,
`sourceAdoptable` and `sourceSetInterest`; stewards serves `stewardsRing`,
and `stewardsSession` for linear's `@bb` mentions.

## Develop

```sh
npm install --include=dev --legacy-peer-deps
npm run typecheck
npm test
bb plugin build
```

Deployment needs this directory added to bb-gate's
`docker/bb-server/Dockerfile` (the sparse checkout, the `mv`, and
`BB_PLUGIN_DIRS`), and multi-repo, linear and github-watcher at versions that serve
the contract. Ops stewards need `kubectl` on the project's machine, with a
kubeconfig that reaches the cluster as the developer (for bc-prod, the
Tailscale API proxy: the machine on the tailnet as its developer, not a
tagged node). The plugin's host entry runs it there.
