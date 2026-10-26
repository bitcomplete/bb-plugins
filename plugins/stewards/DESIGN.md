# Stewards — design

A BB plugin that gives a Linear ticket or a GitHub pull request **a long-lived
thread that manages it until it is done**. The thread, a **steward**, acts on
the entity as you, according to a playbook the project keeps in `.bb`, and you
steer it only from bb.

Status: built (steps 1–6 of the build order, ops stewards included). See
[README.md](README.md) for how it runs and where it goes beyond this design.

## Scope

**In scope.** Ticket stewards for labelled Linear issues and GitHub pull
requests; review stewards for every pull request in the project's repos; one
project steward per bb project that prioritizes across all of them; playbooks
and a project file in `.bb`; a level-triggered reconcile loop fed by the
existing bb-gate-hooks pipeline; workers for bounded tasks.

**Out of scope.**

- **Coordination between developers.** One person runs a project's stewards
  and is the only one managing the project. Two servers stewarding the same
  ticket is not a case this design handles.
- **Workstreams.** Nothing here reuses its code, views, scanner or thread
  hierarchy.
- **Automations.** No cron jobs or scripts. Stewards spawn threads; they do
  not run user code.
- **Hard enforcement.** A steward has your credentials and a shell. What it may
  do is policy, checked where it is cheap to check (see
  [Enforcement](#11-enforcement)).

---

## 1. Concepts

| Term | Meaning |
|---|---|
| **Entity** | A Linear issue or a GitHub pull request; for an `ops` binding, a watch target (§18). |
| **Binding** | The durable record that a steward manages an entity. Kinds: `ticket`, `pr`, `review`, `ops`. No TTL. |
| **Ticket steward** | The long-lived thread bound to a labelled ticket or pull request. Decides and delegates; does not write code. |
| **Review steward** | The long-lived thread bound to a teammate's pull request. Reviews it, as you, for as long as it is open. |
| **Project steward** | One per bb project. Reads every binding's status record, sets priorities and holds, routes escalations, writes the morning digest. |
| **Worker** | A short-lived child thread a steward starts for one bounded task: implement, fix CI, review a round. Archived with its steward. |
| **Playbook** | A file in `.bb/stewards/playbooks/`: adoption, phases keyed by entity state, the ready gate, allowed actions, models, terminal states. |
| **Project file** | `.bb/stewards/project.json`: Linear teams, excluded repos, adoption label, nightly schedule, the project steward's model. |
| **Spec** | What the entity should become: the playbook's terminal state, the ticket's description and acceptance criteria, its spec comments, and standing guidance. |
| **Snapshot** | The observed state, built by plugin code. |
| **Status record** | What a steward writes at the end of every judgment turn. |
| **Standing guidance** | Your instructions for one binding, re-sent on every wake. |
| **Ready gate** | Definition of ready, plus approval for substantial work, recorded against a hash of the spec. |
| **Escalation** | A condition on a status record, raised by a steward, that persists until resolved. |

The model is a Kubernetes controller. The spec is the desired state, the
snapshot is the observed state, and a steward's turn is one reconcile: read
everything, compare, take the next action, write status. Events are hints to
look again, never the input a decision is made from.

## 2. Decisions and why

These were settled while designing; each changes what gets built.

- **Playbooks, not freeform charters.** Behaviour should be predictable and
  reviewable across many tickets. A playbook is versioned in `.bb` and every
  steward picks up an edit on its next wake.
- **Long-lived threads are fine** as long as they cost little while idle and
  are organized out of the way. Idle threads cost nothing; the reconcile loop
  keeps wakes rare, and the sidebar layout keeps quiet stewards quiet.
- **The steward acts as you; you steer it from bb.** It comments, files
  sub-issues, opens pull requests and reviews under your identity. You never
  talk to it through the entity. Its comments keep the `— from bb thread <id>`
  signature: reviewers deserve to know they are answering an agent, the
  signature links back to the thread, and it is how a watch tells the thread's
  own comments from everyone else's.
- **Level-triggered reconcile.** Missed, duplicated or reordered webhook
  deliveries stop mattering, and the transcript stops being the source of
  truth, so compaction loses nothing important.
- **Opt-in by label** for tickets and pull requests: `bb-managed`.
- **Every pull request in the project's repos gets a review steward.** Not
  only the ones your review is requested on.
- **Comments, not description edits.** A steward adds to a ticket with
  comments. It edits the description only when the scope changes.
- **Approval before substantial implementation.** A ticket must be fully
  specified before work starts, and approved first if it is substantial.
- **Sub-issues: handled in place, or promoted.** The parent steward decides,
  guided by the playbook.
- **The budget is advisory.** The project steward steers with priority and
  holds; the plugin does not block a steward from spawning work. One hard
  runaway guard remains.
- **A nightly reconcile pass** gives every open binding one judgment turn,
  overnight, to catch drift the event path misses.
- **Stewards escalate explicitly.** Automatic stuck detection is only a
  backstop.
- **One project steward per bb project**, spanning however many Linear teams
  and repos the project holds.
- **Models are a playbook field per role**, and whichever thread spawned a
  binding may override them.
- **Configuration lives in the project's `.bb`**, read through multi-repo.
- **People make only the big decisions.** Stewards and the project steward
  decide everything the project's own guidance (AGENTS.md, architecture and
  design docs, the playbooks) settles. Only what the project file lists as a
  big decision reaches you, through the project steward.
- **Few tools.** Stewards get two: `steward_report` and `steward_update`.
  Everything else uses what every thread has: the `linear_*` tools, `gh`,
  and `bb thread` for workers. The github-watcher plugin adds no write tools.
- **Stewards end their own threads; the rest of the sidebar is the user's.**
  Stewards pin nothing and create no sidebar sections. A finished steward
  says so in its last turn and the plugin archives it when the binding ends;
  a later wake brings it back. A steward waiting on someone else is
  hidden between wakes too, and its finished workers and their reviewers are
  hidden with it (§5, "Waiting"). thread-briefs is asked,
  through each thread's metadata, not to archive or rename stewards and not
  to group the project steward: between wakes a steward reads done while
  its entity is still open, and its title carries the entity key. (This
  first left archiving to thread-briefs, which archived every steward whose
  brief read done, whoever was next. The plugin now decides from the status
  record instead.)

## 3. Configuration

```
.bb/
  repos.json                   owned by multi-repo; the GitHub repos
  stewards/
    project.json               Linear teams, excluded repos, label, nightly,
                               project steward
    playbooks/
      linear-tickets.md
      github-prs.md
      github-reviews.md
      ops-watch.md             only read when ops.targets lists something (§18)
```

### `project.json`

```jsonc
{
  "version": 1,
  "linear": { "teams": ["ENG", "OPS"] },
  "github": { "exclude": ["acme/docs"] },
  "label": "bb-managed",
  "nightly": { "at": "01:00", "timezone": "America/New_York" },
  "projectSteward": { "model": "claude/claude-opus-5-5/high" },
  "bigDecisions": [
    "A public API, data contract or schema change other teams depend on",
    "New vendors, services or spending"
  ]
}
```

- **Linear teams are listed here**, by key. `repos.json` cannot hold them: its
  schema is strict, and multi-repo deliberately knows nothing about other
  plugins.
- **GitHub repos are not listed.** They are the project's `repos.json`, read
  through multi-repo, so a repo added to the workspace is stewarded without a
  second edit.
- **`github.exclude` takes repos back out**, as `owner/repo`, for repos that
  are in the workspace for reference but should not be stewarded. An excluded
  repo gets no lease, no adoption and no review stewards; its checkout still
  lands in every thread, so a ticket steward can still work in it. Exclusion
  only stops new bindings: one already running ends with
  `bb stewards detach`. An entry not in `repos.json` is a problem in
  `bb stewards check`, since a typo would leave the repo stewarded.
- `bb stewards init` writes the file, offering the Linear teams the connected
  user belongs to.
- `bb stewards check` validates the file and every playbook against Linear and
  GitHub.

### Reading `.bb`

`.bb` here is the multi-repo project's own repo — the one holding `repos.json`,
`AGENTS.md` and `skills/` — not a `.bb` directory inside a code repo. Steward
settings belong to the project, not to any one repo: one project steward, Linear
teams, and every repo in `repos.json`.

The plugin runs on the server, not in a thread workspace, so it needs the
project's canonical `.bb` checkout. multi-repo already locates it (the
project's `local_path` source, preferring the server's own machine) and reads
it on the host. It gains one small cross-plugin RPC contract:

- `readProjectFiles({ projectId, paths })` — file contents from the canonical
  checkout's committed `master`.
- `repoSet({ projectId })` — the parsed repo set.

multi-repo still depends on no other plugin; stewards depends on it. Only
committed `master` is read, so a playbook edit published from a thread lands as
a `guidance-<threadId>` branch and takes effect when it is merged. That is the
review step, and it is deliberate.

multi-repo's host-side read fetches and fast-forwards (`--ff-only`) the
canonical checkout at most once every ten minutes, then reads committed
HEAD; a checkout with local commits is left as it is and read as it is.

## 4. Bindings and adoption

| Kind | Trigger | Default playbook |
|---|---|---|
| `ticket` | `bb-managed` added to an issue in a listed Linear team | `linear-tickets` |
| `pr` | `bb-managed` added to a pull request in a repo from `repos.json` not in `github.exclude` | `github-prs` |
| `review` | a non-draft pull request, authored by someone other than you, opened or marked ready in a repo from `repos.json` not in `github.exclude` | `github-reviews` |
| `ops` | a target listed in the project file's `ops.targets` (§18) | `ops-watch` |

- The plugin hears triggers through bb-gate-hooks `team` and `repo` leases,
  which already exist. The nightly pass re-lists labelled tickets and open
  pull requests as the correctness backstop.
- A new steward reports to its nearest managed ancestor's steward, or to the
  project steward when it has none. That is the binding's parent, not the
  thread's: bb wakes a parent thread every time a child finishes a turn,
  which made the project steward a reader of every steward's every turn
  (on bithub, 88 of its first 96 turns). Stewards are threads of their own.
- `--lifecycle-owner-thread` is used only between a steward and its workers.
  Stewards end on their own entity's terms.
- Your own pull requests get no review steward. They belong to the ticket
  steward that opened them, or to a `pr` binding when labelled.
- Turning stewards on for a project with many open pull requests would adopt
  them all at once. Adoption is capped per pass, oldest first, and the rest
  wait for the next one.

### Binding record

| Field | Holds |
|---|---|
| source, entity id, key, url | The entity. |
| kind, playbook, playbook version | What governs it. |
| thread id, parent binding | The steward, and its nearest managed ancestor. |
| phase, stage | From the entity's state, through the playbook. |
| standing guidance | Instructions and decisions, appended through `steward_update`. |
| ready gate | Checklist state, substantial or not, approval and the spec hash it was given against. |
| priority, holds | Written by the project steward or a parent steward. |
| model overrides | Steward and worker models, when overridden. |
| status record | The latest one (§6). |
| requeue at, last snapshot, last judgment | Timers and the mechanical tier's memory. |
| created, ended, end reason | Lifecycle. |

Storage is SQLite with append-only migrations, as in the linear and github
plugins.

## 5. Lifecycle

- **Terminal.** The entity reaches a state the playbook declares terminal
  (Linear Done or Canceled; GitHub merged or closed). The steward gets a
  wrap-up turn — a final comment, saying the work is done — with its
  workers still running, and the binding ends after it. Its workers are
  stopped then, the thread is archived unless it is still running, and
  workers follow their lifecycle owner.
- **Follow-through.** A terminal state is not always the end of the work:
  merged is not deployed, and Done set by an automation is not verified.
  In its wrap-up turn the steward may keep the binding open with
  `steward_report { followThrough }`, saying what remains. Running workers
  keep going, it may start a worker for that work only, and it is woken as
  usual (a worker finishing, a comment, its requeue). Each of those turns
  says `followThrough` again or the binding ends after it; a turn without a
  report ends it too. The playbook's `follow-through` duration (6h by
  default) caps it from when it is first declared: past it, the workers are
  stopped, the binding ends, and the project steward is told what was left.
  The steward decides, not the plugin: a running worker alone does not hold
  a binding open, since a Canceled ticket's workers should stop.
- **Reopen.** The entity leaves a terminal state. The binding resumes and
  the same thread is woken, brought back from the archive. No second
  thread. An entity that leaves its terminal state while the binding is
  still ending — in its wrap-up turn or following through — takes the
  ending back: nothing is stopped or archived, and the steward is woken to
  reopen.
- **Detach.** The label is removed. Workers are stopped at once and the
  steward gets one turn to stop. Re-adding the label resumes it the same way. Deleting
  the steward thread detaches it until the label is removed and re-added.
- **Review stewards** end when the pull request is merged or closed.
- **Waiting.** A wake turn whose report names `other` as the next actor
  (a review posted and the author's move, a ticket in review waiting on
  reviewers) hides the steward's thread when the turn ends
  (`threads.update { visibility: "hidden" }`). The binding stays, the thread
  stays addressable, and the next wake reaches it. It is made visible again
  when it needs the user — the report puts the user next, an escalation is
  open, a question is unanswered, or a needs item is on the Stewards page —
  and stays hidden across "nothing changed" wakes. A steward is shown again
  when a worker of its binding starts or runs, so the sidebar's effort stays
  rooted at it instead of dropping the worker to a bare row under Threads.
  Hiding cascades to the
  steward's finished workers and their reviewers, so a row is not left
  behind without its steward; a running worker is unaffected, and showing the
  steward again shows them. The open-escalation rule stays. A report that
  needs nobody is also marked read (`threads.markRead`), so the unread dot
  means "needs you";
  binding end still archives the thread. Workers stay lifecycle-owned: they
  are the steward's children in bb, and the plugin stops them explicitly only
  when the binding ends (a detach, or a terminal state without
  follow-through). When a worker's final message asks a question, the next
  wake names it (`Worker thr_… asked: …`) ahead of every other change and
  tells the steward to answer it with `bb thread tell` or escalate before
  anything else; a worker archived since it asked is brought back on that
  wake so the tell reaches it, and a worker whose thread is gone is reported
  as gone, needing a fresh one.
- **Finished workers and reviewers.** A worker's turn ending marks it
  `finished`; once the reconcile that consumed its report has woken the
  steward, its thread is archived, so the sidebar keeps only work in flight.
  A worker that ended with a question for the steward stays visible until it
  is answered, and so does a worker whose binding needs the user. A reviewer
  is archived once its round is consumed — the worker's next turn ends, or a
  newer round reviewer is spawned for the same worker — and the newest
  reviewer for a worker is never archived while that worker is in flight.
  Messaging an archived worker from the plugin unarchives it first (`sendTo`),
  and it shows under its effort again; the steward's own `bb thread tell`
  refuses an archived thread, so it brings the worker back with
  `bb thread unarchive` first, or starts a fresh worker.
- **Parent ends first.** Promoted sub-issues still open are re-parented to the
  next managed ancestor, or the project steward.

## 6. The reconcile loop

### Mechanical tier

Plugin code. No model turn.

1. A ring arrives — a hooks doorbell for a watched unit, a worker or child
   steward changing state, guidance or an approval being recorded, a
   `requeueAfter` coming due. Rings are debounced per binding for a few
   seconds, so a push and its three check runs are one ring.
2. The snapshot is built through the source plugin's `snapshot` RPC:
   - entity fields, and the phase and stage they map to;
   - human comments since the last judgment turn, excluding this thread's
     signed ones;
   - linked pull requests with reviews and checks;
   - sub-issues, with the status records of promoted ones;
   - workers and their bb status;
   - open escalations and the ready gate.
3. The snapshot is compared with the last one. A judgment turn is due only
   when something actionable changed:
   - phase changed, or a terminal state, reopen or detach (while a binding
     follows through, the rest of this list still wakes it);
   - a human comment, a review submitted, a review re-requested;
   - checks finished; a pull request merged, closed or pushed by someone else;
   - a worker finished or failed; a child steward's status changed;
   - guidance changed, an escalation resolved, an approval given or voided;
   - the spec changed (description edited, spec comment added);
   - `requeueAfter` came due.
   While any worker of the binding is in flight — from its spawn until it is
   stopped, failed or archived, across the idle between its turns — its own
   work on a pull request is not actionable: checks finishing, description
   edits, and pushes and comments from the developer's account, which the
   worker and the reviewers it starts post as, often unsigned, and the
   reviewer's `bb-review` markers, whichever account posts them. A round
   that changes the lane does wake it. A first marker, with no earlier round
   to change from, does not: the worker's own turn ending carries it, and
   waking on every first review would put back the wake the ticket removes.
   People, merges and closes still do.

   BB-52 narrows that to the worker's own pull request, and quiets three more
   causes. A pull request is the worker's own when its head branch is one of
   the binding's worker threads' branches, or a worker named its URL in its
   final message; anything else — a teammate's pull request, a link the
   plugin cannot tie to a worker — wakes the steward on the link ("Pull
   request linked (not this ticket's worker)") and keeps its checks, pushes
   and comments actionable. A state move between the playbook's `build` and
   `review` stages (In Progress ↔ In Review) is the worker's own loop, a
   quiet note; a move to any other stage, or a terminal state, still wakes. A
   worker's turn ending is a quiet note unless its final message asks a
   question, reports an error, or its thread is gone (a binding following
   through still hears the worker, since it waits on that result). And a
   terminal state the steward's own last report already named ends the
   binding from the mechanical tier, with the wrap-up written from that
   report and no wrap-up wake; a terminal state someone else set still wakes.
4. Otherwise the snapshot is recorded and the ring ends. Most rings end here:
   the steward's own comments, label churn, its workers at work. What
   changed is kept as a quiet note and shown with the next turn something
   else makes due.

### Judgment tier

The steward is woken with one message in a fixed form:

1. The phase's instructions from the playbook.
2. The ready gate's state.
3. Standing guidance, priority and holds.
4. The snapshot.
5. What changed since its last turn.

Each wake is self-contained, so compaction can be aggressive, and it is: after
a steward's or the project steward's turn the plugin compacts its context once
it holds more than a setting (120,000 tokens by default), and before a wake
that would push it over. Left to the provider, compaction comes near the
window's end, and every turn before then reads the whole transcript. A wake
too long to send is cut in its snapshot, never in what changed. The steward acts and must end its turn with `steward_report`,
which writes the status record:

| Field | Holds |
|---|---|
| phase, summary | Where the entity is, in a sentence. |
| next action, actor | What happens next, and who does it: `me`, `steward`, `other`. |
| blocked on | Who or what outside the thread it waits for. |
| requeue after | When to wake it if nothing else does. Defaults to the playbook's `requeue-default`. |
| conditions | Open escalations, `stuck`. |
| resources | Active workers, open pull requests, child stewards. |

A turn that ends without a report is noted; repeated misses raise `stuck`.

#### Turns that are not wakes

Not every turn a steward acts on is one the plugin composed. The turns it
does not compose are:

- a plain message the user types in the steward's thread, and a trusted
  `@bb` mention (the plugin builds a session wake for a mention, but the
  turn itself is the provider's; a mention from anyone other than the
  server's owner is answered by the plugin and starts no turn);
- a `bb thread tell` from another thread, including the answer to a worker's
  question;
- bb core's child-completed notice, and any other core notice a turn starts
  from;
- the first turn after the provider session was reconstructed following
  compaction.

On those turns the plugin has not just handed the steward a wake, so the
invariants reach it from two durable places, not from the transcript:

- **Per-turn system context.** The SDK exposes a per-thread system-context
  hook (`bb.agents.contributeInstructions`, resolved at `thread.start` and
  `turn.submit`, capped at 4096 characters), and the plugin injects the
  brief there on every turn. It carries the thread id, the playbook's allowed
  actions, the ready gate's "start no implementation workers" line, the
  exact `bb thread spawn` command built from `models.worker` and the project
  environment, the standing rules, and "end with `steward_report`". It is
  built from the live binding, and because it is system context and not the
  transcript, compaction cannot lose it. **This is the path taken**; the
  design's fallback (a wake rule plus a preamble on every plugin-composed
  message) is not needed.
- **The durable commands.** `bb stewards brief [<binding>]` prints the whole
  brief — thread id, allowed actions, phase instructions, ready gate,
  standing guidance and holds, standing rules, the spawn command and "end
  with `steward_report`" — and defaults to the binding of `$BB_THREAD_ID`.
  `bb stewards spawn-flags [<binding>]` prints just the runnable spawn
  command. Every wake names both, so a steward whose injected context was
  somehow lost still has a fixed line to follow.

**Compaction hygiene.** The injected brief begins with a fixed prefix
pointing at `bb stewards brief` ("Your context may have been compacted … run
`bb stewards brief` before acting"). The SDK's `threads.compact` takes no
body and bb's compaction summary is provider-generated, so there is no
summary-prefix hook to write into; the fixed prefix lives in the per-turn
system context, which the provider keeps across compaction. Compaction
frequency is unchanged (the `compactAboveTokens` setting, 120k by default);
tuning it against the BB and bithub stewards is a follow-up, not this design.

#### Post-spawn validation

A worker is recognized by the `thread.created` handler by its lifecycle
owner first, then by its parent (for stewards spawned before BB-23). Before
the runaway guard, the handler compares the worker's provider, model,
reasoning level and environment provider with the playbook's `models.worker`
(or the binding's override) and the project's environment. On a mismatch it
stops the worker, notes the reason and the correct spawn command on the
binding, and wakes the steward. A fact the plugin cannot read (the model
before the thread has one, the environment before it is attached) is not a
mismatch: validation only acts on what it observed. This is the safety net
for every path that could spawn a worker wrong, including a compacted
steward that reconstructed the flags from memory.

### Not repeating itself

Comments and spawns are not idempotent. Before acting, a steward looks for
evidence in the world that it already did it — a signed comment, a linked
worker, an open pull request, a submitted review. Everything a steward writes
is signed with its thread, which is what makes that evidence findable.

### The nightly pass

At the project file's time, 01:00 US Eastern by default:

1. Every open binding gets one judgment turn whether or not anything changed,
   staggered and capped per night.
2. The project steward's pass follows, over the fresh status records; its
   reply is kept as the morning digest.

All of it must finish before 03:00, when bb-gate's quiet window restarts
servers to apply staged updates and would kill a running turn.

## 7. The ready gate

No ticket reaches implementation until it is fully specified, and no
substantial ticket until it is approved.

```yaml
ready:
  checklist:
    - Problem and desired outcome are stated
    - Acceptance criteria are testable
    - Affected repos are named
    - Out of scope is stated
  substantial:            # any one makes approval required
    - more than one repo
    - schema or data migration
    - public API or contract change
    - estimate >= 3
  approval: project       # or me, or { linear-state: Approved }
```

- **Specifying is done in comments.** In a `spec` stage the steward checks the
  ticket against the checklist. What it can work out — acceptance criteria,
  affected repos, a plan — it posts as signed **spec comments**. What it
  cannot, it asks through a `decision` escalation. It does not rewrite the
  description.
- **Approval.** A substantial ticket waits. By default the project steward
  approves it, judging the spec against the project's guidance, through
  `steward_update`. With `approval: me` you approve in the steward's thread,
  and the steward records it quoting your words. With a Linear signal, the
  steward waits for it.
- **The plugin asks for it.** Whenever the checklist is met, the ticket is
  substantial (or not yet judged) and the current spec has no approval, the
  plugin files an `approval` escalation with the approver — the project
  steward, or you with `approval: me` — after the steward's report or on
  the next look, and closes it when the gate passes or stops needing it.
  The gate does not depend on the steward remembering to escalate: on
  HUB-196 a steward posted a new spec and said only in its status that it
  waited on the project steward, which nothing delivers. Approving
  resolves the request; declining it (guidance + resolve) is remembered
  against the spec, which is not asked about again until it changes.
- **The approval is pinned to the spec.** It is stored with a hash of the
  description and the spec comments it was given against. The mechanical tier
  flags any change after approval; the steward judges whether it is material,
  and if so voids the approval and asks again.
- **Scope changes edit the description.** When the scope changes, the steward
  raises a `scope` escalation. Once it is decided, the steward updates the
  description to the new scope, signed, and posts a comment saying what changed
  and why. A description edit always voids the approval.
- **Out-of-order moves.** If someone moves the ticket into a `build` stage
  before the gate passes, the steward starts no workers and escalates.
- **Breaking down.** While specifying, the steward may file sub-issues with a
  parent and decide which to promote (§8).

## 8. Sub-issues

- **Handled in place (default).** Sub-issues are part of the parent's snapshot.
  The parent's workers do the work and the parent moves their states. Suits
  sub-issues that are slices of one plan.
- **Promoted.** A sub-issue labelled `bb-managed` — by the parent steward or by
  you — gets its own ticket steward, attached under its nearest managed
  ancestor, with its own ready gate. Suits sub-issues that need their own spec,
  approval or several pull requests.
- The playbook's `promote` field says when to promote.
- A child steward's escalations go to its parent steward first. Its status
  changes are actionable for the parent, and its resources count toward the
  parent's.

## 9. Reviews

Every non-draft pull request a teammate opens in one of the project's repos
gets a review steward.

- **Rounds.** For each round the review steward starts a review worker on the
  pull request head with fresh context and the playbook's review instructions.
  The worker returns findings; the steward posts them as your review, signed.
  A reviewer thread is archived once its round is consumed — the worker's
  next turn ends, or a newer round reviewer is spawned for the same worker —
  so six rounds do not leave six rows in the sidebar (§5).
- **Later rounds** — new pushes after your review, or a re-request — cover only
  what changed since your last review.
- **Reviews post without asking, approvals included.** The review steward
  requests changes for blocking findings, comments otherwise, and approves
  when nothing blocking is left — unless the change is one of the project's
  big decisions, which it escalates. It posts with `gh pr review`, signed.
  This makes an approval as you an agent's call; a project that wants branch
  protection to mean a person looked removes `approve` from the review
  playbook's `may` list and has the steward escalate instead.
- **Authors to skip**, such as dependency bots, are a playbook field.
- **Cost.** Review stewards default to a small model. The work is in the
  workers, one per round.

## 10. Steering and escalation

### Steering

- **One binding:** say it in its steward's thread. The steward saves it with
  `steward_update`, and every later wake carries it.
- **The project:** say it to the project steward — "focus on auth this week",
  "hold everything touching billing", "use a stronger model on ENG-57". It
  turns that into priority, holds and model overrides on bindings.
- **All work of a kind:** edit the playbook.

### Escalation

An escalation is raised with the turn's `steward_report` and takes:

- a **kind** — `blocked`, `decision`, `scope`, `conflict`, `stuck`;
- **what it needs** — one answerable question;
- **what it will do meanwhile** — wait, continue the unblocked part, or proceed
  with a stated default.

An escalation is a condition on the status record, not a message, and stays
until it is resolved.

**One chain, one record (BB-30).** Every hop is one `escalations` row with
one shape: a machine-read envelope (id, origin thread and binding, the
chain of hops each with its rewording, the route the plugin assigned, the
status, and `meanwhile`), a free-text payload the model reads, and the
human-boundary fields (`resolution`, `choices`, `url`, and a secret's
variable, purpose and destination) the project steward supplies when the
route becomes `me`. `route` is assigned, never chosen: a worker's
`bb stewards escalate` goes to its steward, `steward_report { escalate }`
from a steward goes to the project steward, and only the project steward
reaches the user. Each layer decides from the guidance if it can; it
forwards only what the guidance does not settle, and forwarding to the user
is for the project file's decide list alone. Whoever decides answers the
originating thread directly: the answer is recorded verbatim as guidance on
the originating binding with who decided, the bindings in between get a
quiet note and no turn, and the originating thread is told (a `bb thread
tell` for a worker, a wake for a steward). A hop that names the origin
binding is not noted again: the origin binding's own steward reads the
answer as guidance, and its closure wake already tells it. The `questions`
table is gone,
and the steward-filed `decide`, `configure` and `provide-secret` needs are
escalations; the plugin-filed gate items (`approve-spec`, `approve-pr`,
`merge`) stay as they are.

- **Routing:** nearest managed ancestor, then the project steward. Each level
  decides it from the project's guidance by writing guidance onto the binding
  (`steward_update` with `resolve`) — which clears the condition and wakes the
  steward — or forwards it up with a recommendation.
- **To you only for big decisions.** The project file's `bigDecisions` list
  says what they are: by default scope changes beyond clarification, shared
  API and schema changes, irreversible production changes, new spending, and
  conflicts between people. The project steward forwards such an escalation
  and asks you in its own thread, which thread-briefs then shows as waiting
  on you. Nothing else reaches you.
- **Your answer**, in any of the threads involved, becomes standing guidance.
- **An answer on the entity.** You may answer by editing the ticket,
  commenting, or moving it, rather than in a thread. Then only the steward
  would hear, and the escalation would stay with you. So when the entity
  changes while one of its escalations is with you, the project steward is
  woken with the change, and resolves the escalation or leaves it open.
  The steward's own signed description edit does not count.
- **Waits nobody hears.** A status whose `blockedOn` names the project
  steward or you, with no open escalation, is flagged in `bb stewards list`
  and the project steward's wakes, so the nightly digest shows the drift.
- **Backstop:** a status record that has not advanced within the playbook's
  `stuck` limit gets a `stuck` escalation raised for it.

## 11. Enforcement

`may` lists what a playbook allows a steward to do, and every wake states it.
It is policy, not a wall: nothing checks it. A steward acts with your
credentials and a shell, GitHub writes go through `gh`, and adding checking
write tools would duplicate `gh` for little gain. Irreversible actions rely
on the platforms, such as branch protection. Everything a steward writes is
signed with its thread, so what it did is always visible afterwards. The one
hard stop is the runaway guard (§12).

## 12. The project steward

- **Reads** status records (`bb stewards list`, `bb stewards show`) and your
  focus guidance. Never transcripts; that is what keeps it small however many
  bindings are open.
- **Decides** what stewards escalate, from the project's guidance, and
  approves substantial specs. Writes priority, holds, model overrides and
  decisions onto bindings with `steward_update`, forwards big decisions to
  you, and writes the morning digest as its reply to the nightly wake.
- **Woken** at the end of the nightly pass, by escalations that reach it, and
  by your messages.
- **It decides the owner-reviewed lane (BB-30).** The owner-reviewed
triggers are one list in `stewards/project.json` (`bigDecisions`), each
entry marked `decide: project | user`. The plugin raises an
`approve-decline` escalation to the project steward when the reviewer's
marker puts a pull request in the owner-reviewed lane. The project
steward classifies it into an entry and either records a project-steward
approval for a `project` entry (`steward_update { binding, approve,
entry }`, bound to the pull request's head sha so a new push voids it and
kept only in the store, never as a GitHub comment or review) or forwards
it to you for a `user` one. A missing entry, an unknown mark, a `user`
entry, or a change to the decide list, `bigDecisions`, `prGate` or the
approval code is always yours, whatever the list says; a signed comment
never satisfies either. `prGate` accepts the project-steward approval for
a `project` entry, and the user's unsigned GitHub approval is unchanged.
- **Questions and asks are escalations.** Whatever the project steward
asks you is an `escalations` row with `route: me` and a `resolution`
(`choice`, `text`, `approve-decline`, `secret`, `done`), not a sentence in
its reply and not a separate table. A row is made when the project
steward asks you itself with `steward_update { ask: { question,
resolution, … } }`, or when it forwards an escalation to you. The page
picks its buttons from `resolution` alone; a `secret` carries the
variable, purpose and destination the requester thread uses. Resolving it
at any layer delivers the answer to the originating thread, records it as
guidance there, and notes the bindings between.
- **The digest is written from the record.** The nightly wake carries a
  section the plugin assembles from its tables: the previous digest with
  its date; what moved since then (open bindings whose status record
  advanced, bindings that ended, questions answered); what waits on you
  (open questions, then open escalations with you that no question covers,
  such as approval requests); and what is stuck or held (open `stuck`
  escalations, bindings on hold). The project steward writes prose and
  priorities on top, and is told the record wins where it disagrees with
  its earlier digest. Only the latest digest is kept.
- **Budget is advisory.** Status records report what each binding uses; the
  project steward keeps the total sensible through priority and holds.
- **Runaway guard.** A hard cap on worker spawns per binding per hour: a
  worker past it is stopped and the steward told. Not a budget.

## 13. Models

```yaml
models:
  steward: claude/claude-sonnet-5-5/medium
  worker: claude/claude-opus-5-5/high
```

- A playbook names the models for its stewards and their workers. The project
  file names the project steward's.
- The project steward (any binding) and a parent steward (its children) can
  override a binding's models with `steward_update`; a steward can override
  its own workers' model. The override is applied with the thread's
  sticky model (`bb thread update --model`), takes effect from the next turn,
  and is stored on the binding so it survives restarts.

## 14. Playbooks

YAML front matter, then one Markdown section per phase holding that phase's
instructions.

```yaml
name: linear-tickets
kind: ticket
source: linear
phases:
  Backlog:     { stage: spec }
  Todo:        { stage: spec }
  In Progress: { stage: build }
  In Review:   { stage: review, stuck: { days: 3 } }
terminal: [Done, Canceled]
ready: { ... }                    # §7
promote: "A sub-issue that needs more than one pull request or its own approval."
may: [comment, edit-description, set-state, set-labels, create-sub-issue, open-pr, request-review, spawn-worker]
models: { ... }                   # §13
requeue-default: 2d
follow-through: 6h                # how long a terminal binding may be kept open (§5)
deployment:                       # where a merge is confirmed live (BB-53); omit and nothing changes
  source: github
  repo: bitcomplete/bb-gate
  environment: production
  carries: "The pinned BB_PLUGINS_REF contains the merge commit."   # the steward's rule
  timeout: 6h
  workflows: [bb-server.yaml, image.yaml]   # a failed run of one wakes the steward (BB-61)
```

- **Phases are the entity's own states**, so the playbook needs no state
  machine. A ticket moved by hand is followed.
- **`deployment` is where a merge is confirmed live (BB-53).** It names the
  source (`github`), the target repo and environment, the rule the steward
  applies to decide whether a deployment carries a merge, and the timeout. A
  merged pull request is recorded as awaiting deployment, the github plugin
  leases the repo as a `deployment_repo`, and a `deployment` doorbell wakes
  the binding with the deployment and the rule. The plugin never evaluates the
  rule: the steward reports the verdict, and the ticket closes with one
  comment once every pull request is merged and deployed. A failure/error
  deployment or a timeout wakes the steward with the run URL. No `deployment`
  is exactly today's behaviour.
- **`deployment.workflows` names the builds that must not fail while a merge
  waits (BB-61).** Each entry is matched, ignoring case, against a
  `workflow_run` doorbell's file path, basename or name. A run of a named
  workflow that ends in failure, cancellation or timeout wakes every binding
  on that repo still awaiting a deployment, once per run id and attempt, with
  the run's URL, conclusion and head sha and the open watches; the watch's
  state is not moved, and the steward applies its playbook as for a timeout.
  The plugin assumes nothing about images, tags or pins and never matches the
  run's `sha`, which is usually the deploying repository's commit. Empty, or
  absent, wakes nobody: no `workflows` is exactly today's behaviour.
- **A deployment that predates its watch is read, not waited for (BB-59).**
  A doorbell can be missed, most obviously across the server restart every
  `bb-plugins` merge causes, and a deployment that landed before the watch was
  recorded never rings. So when a `merged` watch is first recorded, and on
  every sweep for a watch still in `merged` or `deploying`, the plugin reads
  the target repo's recent deployments for the playbook's environment through
  the github plugin's source contract (`sourceDeployments`, never `gh` in the
  server). The newest one is applied exactly as a doorbell would be: a success
  moves the watch to `deploying` with its id, ref, sha and URL and wakes the
  steward with the playbook's rule; a failure or error gives the failure wake.
  A read that repeats what a watch already recorded is not news, so the sweep
  does not re-wake for the same deployment. No deployments leaves the deadline
  and the timeout path untouched. The plugin still never evaluates `carries`.
- **Stages** — `spec`, `build`, `review` — are what the plugin acts on (the
  ready gate blocks `build`). State names are what a person sees.
- **Validation.** Phases must be workflow states of every listed team, labels
  must exist. A playbook that fails is reported by `bb stewards check` and in
  the project steward's digest, and bindings keep running under the last good
  version.

## 15. Organization

- Stewards are no thread's children (§4): who reports to whom is in the
  bindings. They are grouped in the sidebar instead: each stewarded project
  gets one sidebar section, named after the project, holding its project
  steward and every ticket and pull request steward. Sections are flat in bb,
  and only shown when the sidebar is organized chronologically; in the
  project organization the project's own group does the same job.
- **Placed once, then the user's.** A steward is put in its project's
  section when it is spawned, and one that predates the section is put there
  by the sweep, but only when it is in no section. Either way the thread is
  then recorded as placed (`placed_threads`) and never moved again, so a
  steward dragged elsewhere stays where it was put. The plugin pins
  nothing.
- **The section is remembered by id** (`project_stewards.section_id`), so a
  rename by hand sticks. One deleted by hand stays deleted: the id is kept
  as a tombstone and new stewards land loose. Creating a section with the
  project's exact name brings placement back; an existing section with that
  name is adopted rather than duplicated. When a project stops being
  stewarded, the sweep deletes its section once nothing unarchived is left
  in it, since its stewards are archived as their bindings end; a thread
  filed there by hand keeps it.
- Stewards, the project steward included, are kept out of thread-briefs'
  status sections (`group: false`), where one idle between wakes would read
  done. thread-briefs only moves threads in and out of its own sections, so
  it leaves the project section alone. Workers and reviewers are tagged the
  same way when the `thread.created` handler files them, so thread-briefs
  never moves one out of the section or auto-archives it. The project
  steward is titled "<project name> project steward".
- Workers are top-level threads, owned by their steward through
  `--lifecycle-owner-thread` and started with `bb thread spawn --project …
  --lifecycle-owner-thread "$BB_THREAD_ID" --section <section id> …`; the
  plugin recognizes them by that owner, and still recognizes a worker an
  older steward made a child by its parent. A worker is no thread's child,
  so finishing a turn does not wake the steward: its final message arrives
  in the next wake, which lists finished workers. The sidebar loss is
  accepted: a worker no longer nests under its steward's row in the project
  section, because bb's list trees by parent thread and not by lifecycle
  owner. Whether it should tree by lifecycle owner too is a core question,
  not worked around here. The `thread.created` handler files any unsectioned
  worker or reviewer into the owner's project section, so a skill that
  builds its own spawn command lands there too. A finished worker's thread is
  archived once the reconcile that consumed its report has woken the steward,
  and a reviewer once its round is consumed, so a long-running binding does
  not leave its finished rows loose (§5).
- Whether a steward is waiting on you, waiting on someone else, or done is
  thread-briefs' judgment from its transcript. A steward waiting on someone
  else is hidden (`threads.update { visibility: "hidden" }`), not archived,
  so it leaves the sidebar but stays addressable; its finished workers and
  their reviewers are hidden with it, and a wake that needs you makes them
  visible again. A running worker is not hidden. The unread dot is cleared
  after a report that needs nobody. Ended bindings are archived by this
  plugin, not by thread-briefs.

## 16. Architecture

### `plugins/stewards`

- **Configuration:** the project file and playbooks through multi-repo, and
  validation.
- **Store:** bindings, status records, escalations, workers.
- **Reconciler:** mechanical tier, debounce, nightly pass, `requeueAfter`
  timers, escalation routing.
- **Threads:** spawning stewards, recognizing workers, building wake messages,
  the project's sidebar section.
- **Agent tools:** `steward_report` and `steward_update` (which also
  records and completes lessons, §20).
- **CLI:** `bb stewards init | check | list | show | needs | done | detach | pass | digest | lessons | drop-lesson`.
- **UI:** the Stewards page, a nav panel with one tab per stewarded project:
  waiting on you (needs items with links and buttons, open questions, which you
  can close there, forwarded escalations and approval requests), in flight by
  stage (summary, next action and actor, running workers), stuck or held, ended
  in the last two weeks, and the latest digest with its date. Settings →
  Plugins → Stewards keeps each project's configuration and health.

### Changes to linear and github

- **A source contract**, in a contract file the three plugins share:
  `snapshot`, `validate`, `adoptable` (labelled tickets and open pull requests,
  for the nightly backstop), `setInterest`, and stewards' `ring`.
- **Leases and rings.** The hooks clients hold `team` and `repo` leases for
  the units stewards asks for, plus an issue lease for every bound entity, and
  forward rings to stewards over cross-plugin RPC. Existing `linear_watch_issue` and
  `github_watch` are unchanged.
- **linear:** description editing on `linear_update_issue`, which today changes
  state, assignee, labels and priority only.
- **github:** no new tools. Every GitHub write goes through `gh`, signed by
  the steward.

### Change to multi-repo

The cross-plugin RPC contract in §3, plus `mergeGuidance`: the narrow
fast-forward of the canonical `.bb` to a thread's published guidance branch
that a self-merged lesson uses (§20). Only the stewards plugin may call it.

### bb-gate

The three edits to `docker/bb-server/Dockerfile` for a new plugin directory —
the sparse checkout line, the `mv` line, `BB_PLUGIN_DIRS` — before the first
image that should carry it. No hooks change: `team` and `repo` leases exist.

### .bb

A `stewards/` directory with the project file and the default playbooks, and a
note in `AGENTS.md`.

## 17. Build order

Whichever repo is consumed lands first: multi-repo's RPC and the source
plugins' contract before stewards uses them, bb-plugins before bb-gate.

1. **Linear ticket stewards.** Project file and playbooks through multi-repo,
   label adoption, bindings, mechanical tier, snapshot, status records,
   standing guidance, the ready gate, terminal, reopen and detach.
2. **Pull requests, workers, sub-issues.** Linked pull requests in snapshots,
   workers, model overrides, the runaway guard, promotion and
   parent routing, labelled pull requests.
3. **Project steward.** Escalation routing and decisions, big decisions to
   you, priority and holds, the nightly pass, the morning digest.
4. **Reviews.** Review bindings, review workers.
5. **Board.** Built: the Stewards page, the question record (§12), and the
   digest assembled from records.
6. **Ops.** Built in this plugin (§18), with kubectl on the developer's
   machine; nothing changes in bb-gate or devbox.

## 18. Ops stewards

Every other kind manages work that already exists as a ticket or a pull
request. Nothing watched production, so operational problems were noticed by
a person or not at all. An `ops` binding watches a **target** and turns what
goes wrong there into Linear tickets for the project steward to adopt.

```jsonc
"ops": {
  "targets": [
    { "kind": "k8s-namespace", "name": "bb-gate-production" },
    { "kind": "sentry-project", "org": "acme", "project": "web" }
  ],
  "team": "BB",                 // where tickets are filed; the first linear.teams entry when left out
  "autoAdopt": ["urgent"]       // priorities labelled when filed, without asking; empty by default
}
```

- **The entity is the target.** One binding per target, keyed
  `k8s-namespace/<name>` or `sentry-project/<org>/<project>`, with the
  source `ops`: there is no source plugin behind it, and
  `source-contract.ts` does not change. It has no phases
  keyed on entity state and no terminal state. It lives while the project
  file lists its target: taken out, the binding ends (`unconfigured`) and
  its thread is archived; put back, the same binding and thread resume.
  `bb stewards detach` ends it until the target is taken out and put back,
  as a ticket stays detached until its label is. It reports to the project
  steward and has no workers. On the Stewards page it is grouped as
  `watch`; in `bb stewards list` it shows when it last looked and how many
  problems are failing.
- **The plugin looks with kubectl, as the developer; the steward judges.**
  There is no cluster identity of the plugin's own. The project's machine
  — the developer's, a tailnet node, where the steward's turns run too —
  has `kubectl`, which reaches the cluster through the developer's
  kubeconfig (for bc-prod, the Tailscale API proxy) as them. The plugin's
  server is elsewhere, so it asks the machine to run kubectl through its
  host entry (`host.ts`, one method, `opsKubectl`), and reads with it
  (`kubectl.ts`): pods, Warning events, Deployments, and the last log lines
  of a failing container, with obvious credentials redacted. `ops.context`
  names the kubeconfig context; the machine's current one otherwise. A look
  happens at every sweep and requeue. It is the ops binding's snapshot
  (`bindings.ops_look`), and the wake carries it.
- **Fingerprints.** A problem is named by its target, its workload (a
  Deployment's pods share it whatever their generated names, so a rollout
  or a second replica is the same problem), its container, and an error
  signature from the container's status: `CrashLoopBackOff:<last reason>:<exit
  code>`, `ImagePullBackOff`, `Restarted:OOMKilled:137`, `Failed:Evicted`,
  `Unschedulable`, `NotReady` (a running pod unready for ten minutes). Log
  text is evidence, never part of the name: it changes on every line.
- **The fingerprint map** (`ops_fingerprints`) holds, per project, each
  fingerprint ever seen and the Linear ticket it is tracked under. The
  steward reports what it did in `steward_report { opsTickets: [{
  fingerprint, ticket, did: filed | commented | reopened }] }`, and the
  plugin records it. Each look classifies its findings against the map, and
  reads each ticket's state through linear's `sourceSnapshot`:
  - **new** — no ticket. Worth a turn at once.
  - **recurring** — its ticket is open, or cannot be read (a comment on a
    closed ticket does less harm than a duplicate). Worth a turn at the
    requeue, so a crash loop is one comment per `requeue-default`, and
    never a second ticket.
  - **returned** — its ticket was Done or Canceled and the problem is back.
    Worth a turn at once. The playbook's `## Returned` section decides
    between reopening and filing anew; the default comments on a ticket
    closed within two weeks and escalates a reopen, and otherwise files a new
    ticket linking the old one.
  Every `requeue-default` the steward takes a turn whatever the look
  found; a healthy one is cheap, a wake that says "all healthy" and a
  report with actor `other`, which hides the thread until the next
  look. A sweep's look between requeues wakes it only for a new or
  returned problem.
- **Triage is the project steward's.** The steward files one ticket per new
  problem — pod, since when, the evidence, a diagnosis, a priority, and the
  fingerprint on a line of its own — and raises one `decision` escalation
  for the tickets of the turn ("Filed BB-N (high): …. Recommend adopting.").
  The project steward adopts by adding the label and moving the ticket to
  Todo, the ordinary path, and the team lease brings a ticket steward; or
  declines with a reason. `ops.autoAdopt` names priorities the ops steward
  labels itself when filing, without escalating.
- **Read-only is a convention, not a wall.** There is no separate
  identity: the plugin assumes kubectl read access is available on the
  machine, and uses whatever credential is there. **That ambient
  credential may be broader than read** — a developer's usually can
  delete, exec and patch — **and the verb allowlist is the plugin's only
  guard.** Every kubectl call the plugin makes passes one function,
  `kubectlRefusal`, checked by the server before it asks and by the host
  entry before it runs: only `get`, `describe`, `logs` and `auth can-i`,
  and no flag that swaps the kubeconfig, credentials or identity. The playbook's `may` list says the same for the
  steward's own kubectl (`kubectl get`, `describe`, `logs`, `auth can-i`,
  then filing, commenting and escalating), and like every `may` list it is
  advisory (§11): nothing stops the steward's shell. A real wall, such as a
  read-only identity for kubectl, would slot in behind that one function.
- **`bb stewards check`** validates `ops` (namespace names, Sentry slugs,
  duplicates, that the team is one of `linear.teams`), then runs kubectl
  on the project's machine for each namespace: `get` its pods, events and
  deployments, and `auth can-i` for its logs. A target kubectl cannot
  reach — no kubectl, the machine not on the tailnet as the developer, no
  kubeconfig or context for the cluster, pods forbidden — is a problem,
  "cannot read the target". Writes the identity holds there are said, not
  counted as a problem: they are expected of a developer. For each Sentry
  project it reads the project with the plugin's token (no token, or a
  refusal, is a problem) and says how doorbells arrive: the bb-gate-hooks
  stream's state, or that there is no service here.
- **When kubectl cannot read the target**, the binding is made but its
  steward is not spawned or woken; `bb stewards list` shows `cannot read
  the target`, and the first look that succeeds wakes it.

### Sentry projects

A `sentry-project` target is the push source the k8s look lacks: an error
that does not crash a pod is still an issue in Sentry, and Sentry knows of
it the moment it happens. The target runs the same `ops-watch` playbook
and the same fingerprint map; what differs is how the plugin looks and
what a wake carries.

- **The credential is the plugin's, a secret setting.** `sentryToken` on
  the stewards plugin holds a Sentry *user auth token* with `project:read`,
  `event:read` and `event:write`, entered by the user in the plugin's
  settings and never pasted into a thread; `sentryApiUrl` points at a
  self-hosted Sentry. The
  ticket's decision: no `sentry` plugin, because the source contract has no
  use for one and a new plugin would mean the three plugin lists in the
  `bb-server` Dockerfile. The steward's thread holds no token: it diagnoses
  from the wake's evidence and the code in its workspace. **Until a token
  is set, the look fails with "no Sentry token is configured"; that one
  failure wakes the steward**, which files the `provide-secret` need naming
  the setting (variable `SENTRY_TOKEN`, setting `sentryToken`, the Sentry
  auth-tokens page, the scopes) and does nothing else; later looks are quiet
  until the token appears. Any other read failure (403, a wrong URL) is logged and shown by
  `bb stewards check`, and wakes nobody, as a namespace kubectl cannot read
  does not.
- **Doorbells come from bb-gate-hooks directly** (`hooks-client.ts`, a copy
  of github-watcher's without the GitHub parts), since there is no source
  plugin to lease through. The plugin holds one stream for the `sentry`
  source, opened once a project lists a Sentry target, and leases a
  `project` per target, sent as `org/slug` and leased under the slug that
  doorbells carry as their unit, plus an `issue` per issue in the
  fingerprint map that has a ticket and was seen within thirty days, so a
  resolved ticket's issue still rings when it regresses. Every lease is
  proven with the token; without one nothing is leased, and bb-gate-hooks
  refusing the token is said once per token. A doorbell names an issue id
  and, usually, the project slug: every open Sentry binding whose target is
  that slug, or whose fingerprint map holds that id, notes the id as *rung*
  and looks (bb-gate/docs/hooks.md, "Sentry"). The loop's sweeps (on
  connect, after a failed or late renewal, every ten minutes, and every two
  minutes while the stream is down) have every Sentry binding look for
  itself, and the plugin's own sweep and requeue do the same, so **the
  periodic look is the backstop**: with bb-gate-hooks down, a new issue is
  seen at the next look.
- **The look** reads the project's unresolved issues, newest activity
  first (fifty), and each rung id the list does not carry. The sightings
  are the issues *first seen* since the last look, *regressed* or
  escalating in Sentry and active since, *rung* by a doorbell, and *known*
  (in the fingerprint map) and still firing since; an issue Sentry has
  resolved is never one, even when rung. Twenty at most, regressions
  first. For the first five the latest event is read for its stack trace.
  The rest of the unresolved list is shown for context, ten lines.
- **The fingerprint is the Sentry issue id**: it is what the doorbell
  carries, what the API is keyed on, and stable across events, so one
  issue is one ticket however often it fires. The map's summary is
  `WEB-12: <title> (<culprit>)`.
- **The wake** (`formatSentryWake`) carries, per finding, the short id,
  title, level, culprit, permalink, event and user counts, first and last
  seen, Sentry's substatus, why it is in the look, and the latest event's
  stack trace — each exception as a header, frames innermost last, in-app
  frames marked `*` with their source line — all redacted by the same rule
  as the kubectl look's log lines (`redactLine`): a bearer token or an
  `api_key=` in an error message does not reach a ticket.
- **What wakes the steward** (`sentryChanges`): a new issue, one back after
  its ticket was resolved, and one Sentry marks regressed under an open
  ticket, at once; a doorbell for an issue under an open ticket only when
  the steward has not filed or commented within a `requeue-default`, so a
  noisy issue is one comment per interval, not one per event (the
  playbook's "a second event on the same Sentry issue is a comment, never a
  second ticket"); and the requeue, as for every ops binding. A known issue
  seen again, and one no longer seen, are noted quietly.
- **The plugin writes exactly one thing in Sentry.** With
  `ops.sentry.resolveOnDone` on (it defaults off, so a project opts in),
  the look resolves a mapped issue whose ticket is in a completed state
  (Done) while Sentry still shows the issue unresolved, with one
  `PUT /api/0/issues/<id>/` carrying `{ "status": "resolved" }` and one
  quiet note in the look ("Resolved WEB-12 in Sentry: BB-N is Done").
  Canceled tickets (won't fix), open tickets and issues Sentry has already
  resolved are left alone; no last-seen or deploy-timing guard is added,
  since Sentry's own regression detection reopens the issue if it fires
  again, and the existing Returned path handles that. The write needs the
  token's `event:write` scope: a 403 is one note per look naming the
  missing scope, and the look skips the rest of its resolves and otherwise
  completes. Assigning or commenting on a Sentry issue is not in the `may`
  list, and the token's scopes are the wall.

## 18. Needs you items and one-click actions

Everything a person had to do on a ticket used to exist only as prose,
repeated across Linear comments, the project steward's digest and the stewards'
replies. A **needs** record makes it structured: one row per thing the user
must do, with a link, one line of what, steps, and a close rule. Under
BB-30 the steward-filed asks (`decide`, `configure`, `provide-secret`) are
the one `escalations` record with `route: me` and a `resolution`; the
plugin-filed gate items (`approve-spec`, `approve-pr`, `merge`) stay as
needs. Both are listed under "Waiting on you" on the Stewards page, in the
digest, and by `bb stewards needs` and `bb stewards show`. A `route: me`
escalation is rendered from its `resolution` alone: `choice` (one button
per label), `text` (the answer box), `approve-decline`, `secret` (the
requester thread and bb's secure form) or `done`.

| kind | filed by | link | done when | one-click action |
| -- | -- | -- | -- | -- |
| `approve-spec` | plugin, when the ready gate waits and the playbook's approver is `me`, or when the project steward forwards an `approval` escalation to the user | the ticket | gate approval recorded | **Approve** / **Decline** (with an optional note); Approve records the approval on the gate, as BB-13 does from any surface |
| `approve-pr` | plugin, when a `user`-marked owner-reviewed pull request is forwarded to the user, or the project steward's approval is not the gate's | the pull request | owner approval seen in the snapshot | **Approve**: posts the unsigned comment "Approved <sha> from the Stewards page" as the connected user |
| `merge` | plugin, when the lane gate is met and no worker is running, or by a steward whose worker reported a refused merge | the pull request | the pull request merged | **Merge**: the server re-checks the gate itself, squash-merges through the server's `gh` login, posts the "Merged: …" comment, and wakes the steward |
| `decide` | project steward (today's forwarded question) | the entity | answered | **Answer** (the text box), or one button per `choices` label and **Other…** |
| `provide-secret` | steward, with the variable name and purpose, and either the `writeEnv` dotenv path (or `worker`) or the `setting` of one of the plugin's secret settings | the dotenv, or the stewards secret setting | the requester's `bb secret request` (and `bb stewards secret import` for a setting) completes | **Provide**: the server spawns a fixed-prompt requester thread, opens bb's secure form in its first turn, and navigates to it; **Done** is the manual escape hatch |
| `configure` | steward, for a step outside the repos (install an app, grant a permission, enable an event, set a setting) | the external page where it happens | the user presses Done, or the steward observes it done | **Done** (with an optional note, saved as guidance) |

The rules that hold:

- **One gate function.** `prGate` in `reconcile.ts` is the build-tickets lane
  gate: the reviewer's latest marker has verdict `approved`,
  every check has passed, and, in the owner-reviewed lane, the owner has
  approved — an unsigned approving comment or an APPROVED review by the
  connected user, or, for an entry the decide list marks `project`, a
  project-steward approval recorded in the store and bound to the head sha
  (BB-30); a signed comment is a thread's, never the owner's. An unknown
  lane is owner-reviewed, not no-review. Any comment whose first line opens
  a `bb-review` marker is a round, however it is spelled: a marker missing
  `verdict=` reads its verdict from a bare word (`changes-requested`) or as
  `unreadable`, and one missing `lane=` is the owner's, so a malformed later
  round closes the gate rather than leaving an earlier `approved` as the
  latest word (bb-plugins#88 asked the owner to approve a head the reviewer
  had just rejected that way). The merge
  button, the item the plugin files and the wake's "Lane gate" line all read
  it, so a steward is told whether a pull request's gate is met in the same
  words the button acts on.
- **The buttons run on the server as the connected user, unsigned**, so they
  count as human actions. Approve-PR is a comment, not a review, so GitHub is
  the only thing that can refuse it (approving your own pull request); Merge
  uses the server's `gh` token through the GitHub API. The server never signs
  one with a thread id.
- **A button is offered only while the server can verify its preconditions.**
  `syncNeeds` recomputes the plugin's items on every look and closes the ones
  whose condition no longer holds; the page marks one whose condition has moved
  since as not actionable and says why ("reviewer round 3 pending", "a worker
  is still running"). The merge action re-checks `prGate` against a fresh
  snapshot before it merges.
- **A `provide-secret` item's import is bound to its requester.** Provide
  spawns a fixed-prompt requester thread on the binding's machine with its
  worker model and records the thread id against the need; the need stays open
  until the requester finishes. `bb stewards secret import` accepts only that
  thread, only while the need is open, and only for the need's own `setting`; a
  non-secret setting, another thread, another setting, a file on another host,
  and any import after the need closes are refused. The limit rests on
  `ctx.threadId`, the thread id the CLI client posts (the same assumption
  `bb stewards init` makes about "the thread's" machine): a shell could spoof
  it, so the import is also confined to a setting the plugin itself declared
  `secret: true`, and the value is never readable back through the plugin. The
  value never appears in argv, logs, messages or output.
- **Every action wakes the steward with the item's closure** under "What
  changed", and the wake lists the binding's open items and says not to ask the
  user about them in prose. Closing an item from the page or with
  `bb stewards done <id>` does the same.
- **Fixed choices.** A `decide` item filed with `steward_report { needs }`
  may carry `choices`, two to six short labels kept in the item's `data`; a
  `steward_report { escalate }` may carry the same, kept on the escalation
  and copied onto the question when the project steward forwards it. The page
  shows one button per choice, a note field and **Other…** (which reveals the
  text box with **Answer**); a `decide` item or question without choices
  shows the text box and **Answer**, never **Done** (`configure` keeps
  **Done**, since its "what" names the step being confirmed). Pressing a
  choice closes with `Chose: <label>` plus the note, saves the choice (and
  note) as guidance on the binding, and wakes the steward with "The user
  chose <label> for <what>" under What changed. A forwarded escalation
  answered by a choice resolves with the choice as its guidance, exactly as
  `steward_update { guidance, resolve }` records it. `bb stewards done <id>
  --choice <label> [--note …]` does the same from a thread and refuses a
  label not among the item's choices. The CLI, the digest and every wake list
  the choices after the item.
- **A forwarded approval is a need.** When the project steward forwards an
  `approval` escalation to the user, the plugin files an `approve-spec` need
  on the binding and keeps the escalation open, linked to it
  (`data.escalationId`), instead of a free-text question: the binding is
  waiting on the user's approval exactly as `approval: me` would be. The
  page's Approve and Decline, and `bb stewards done` for Approve, record the
  gate verdict and resolve the open `approval` escalations in the same step,
  so the project steward is not left holding the request. A forwarded
  `decision` escalation stays a question; with `choices`, it is answered by a
  button per label, and a choice is recorded as guidance.
- **Dedupe.** A need is keyed by (binding, kind, url) while open: a steward
  that re-reports updates the wording rather than adding a row. The store
  enforces it with a partial unique index.
- **`blockedOn` stays for third parties.** A `steward_report` whose `blockedOn`
  names the user, the owner or a human with no open needs item is refused and
  told to file one, so the ask reaches the page instead of only the prose.

## 19. Dependency stewards

Nothing kept dependencies current: a vulnerable or stale package was
noticed by a person reading a build log, or not at all. GitHub does the
scanning, and the stewards turn its findings into tickets. Two kinds of
binding do it.

```jsonc
"deps": {
  "sla":       { "critical": "asap", "high": "1d", "medium": "7d", "low": "30d" },
  "autoAdopt": ["critical", "high"],
  "batch":     { "medium": "7d", "low": "30d" }
}
```

- **Dependabot alerts are an `ops` target kind**, `{ "kind": "dependabot",
  "repo": "owner/repo" }`. The default is every repo in `repos.json` not in
  `github.exclude`; the project file may list explicit targets instead. The
  binding's key is `dependabot/owner/repo`, it runs the `deps-alerts`
  playbook, and it is woken by the `dependabot_alert` doorbell rather than a
  look interval.
- **The github plugin reads the alerts** with the developer's token from
  `GET /repos/{owner}/{repo}/dependabot/alerts`, through the shared
  `sourceDependabotAlerts` RPC. It leases each watched repo as a
  `dependabot_repo` (a plain `repo` lease does not receive alert doorbells)
  and rings stewards for each `dependabot_alert` doorbell. Reading alerts
  needs the token's alert access; a `rejected: forbidden` lease is a skip,
  not an error, and `bb stewards check` says which repos are skipped.
- **Severity maps onto priority and the deadline.** critical → urgent and
  due now, high → high and due in a day, and so on. `asap` escalates at
  once rather than waiting for the adopt pass. The alert's fingerprint is
  `owner/repo#<alert number>` (the alert's own numbering), recorded in the
  ops fingerprint map so a recurrence is a comment, never a second ticket.
- **critical and high get their own ticket; medium and low coalesce** into
  one open ticket per repo per ecosystem. A new alert joins that ticket
  when its due date is inside the new alert's deadline, and otherwise
  tightens the ticket's due date to the new deadline. The plugin computes
  the plan (`new`, `join` or `tighten`) from the fingerprint map and gives
  it to the steward in the wake; the steward files or comments.
- **A fixed or dismissed alert leaves the open list**, the look says so,
  and the steward trims it from its ticket or moves the ticket to Done when
  nothing is left.
- **The nightly pass re-lists every watched repo's open alerts**, so a
  missed doorbell costs a night, not a deadline.
- **`deps-prs` adopts the bot's version-update pull requests.** A
  `dependabot[bot]` pull request in a watched repo gets a `pr` binding under
  the `deps-prs` playbook whether or not it is labelled. It gets the same
  independent reviewer round a ticket worker's pull request gets, and the
  ordinary pull-request gate then files the `merge` need for a person to
  press; the steward never merges. A major bump or anything touching an
  owner-reviewed path is escalated with the reason.
- **A replacement pull request moves the binding.** A bump that cannot
  merge as is (the build breaks, the reviewer blocks on part of it) is
  redone by a worker as a new pull request on its own branch, and the bot's
  is closed. The steward reports `steward_report { replacedBy: "owner/repo#N" }`
  and the plugin moves the binding to the replacement: same id, thread,
  playbook, guidance, escalations and workers; the entity, snapshot and
  phase become the replacement's, items filed for the old pull request are
  withdrawn, an ending begun by the old one's close is undone, the thread is
  retitled and the leases refreshed. The replacement must be an open pull
  request in the same repository with no steward of its own. Without this
  the binding stays on a closed pull request, the gate never looks at the
  replacement, and nothing files its Merge item, because the plugin never
  adopts a pull request the signed-in login wrote.

`bb stewards init` writes `deps-alerts.md` and `deps-prs.md`; a project
that has not written them runs no dependency watch, which is how the feature
is off until it is wanted. The dependency watch's targets are derived from
the repo set, so a repo added to `repos.json` is watched without a second
edit.

## 20. Lessons

A project steward's decision that corrects a design is a general rule, but
it reached the playbook only when a person rewrote it: the same answer was
costing a build and a review round on one ticket, then again on the next.
A **lesson** makes the answer a record and, for most of them, lands it.

- **Recording.** The project steward calls
  `steward_update { lesson: { text, file, scope } }`, usually with the
  `binding` and `resolve` it is deciding. `text` is the wording as it should
  read in `.bb`, `file` is the file it belongs in (`AGENTS.md`,
  `stewards/linear-tickets.md`, …), and `scope` is `procedure` or
  `boundary`. Only the project steward may record one — a binding steward
  still escalates — and it is kept with the binding and escalation it came
  from in the `lessons` table. A lesson is `pending` until its text is found
  in its file at `.bb` HEAD, or it is dropped. When the user answers a
  forwarded escalation on the Stewards page or from a thread, the project
  steward is woken with the answer and asked whether it is a general
  judgement: the answer is a lesson candidate for its next turn. A plain
  question with no escalation behind it wakes nobody.
- **Counts (BB-35 step 2).** A `steward_update { resolve }` carries
  `cites: [lesson ids]` — the lessons the decision rested on — and the wake
  says a decision must cite what it was decided from. The plugin records
  `hits` (one per distinct binding), `corrections` (the owner's answer or
  unsigned comment on the entity differing from the steward's recommendation
  on a decision that cited the lesson), and `lastCitedAt`, keeping the cited
  bindings and the escalation's cited lessons. This step only records:
  nothing is promoted, retired or written to `.bb` from these counts yet.
  Only the owner's own words, or this project's steward or worker threads,
  may create, cite or correct a lesson; a signed or non-owner comment never
  does.
- **Tiers and transitions (BB-35 step 3).** Every lesson carries a `tier`:
  `candidate` (store only, never in a wake) → `trial` (in the store, injected
  into steward and project steward wakes under `## Lessons (trial)` with its
  id) → `promoted` (committed to `.bb` with a `<!-- lesson:<id> -->` anchor) →
  `retired` (removed from the file; the row kept). The old `status` column is
  kept and still tracks the file state (`pending`, `merged`, `dropped`); the
  migration maps `pending` → `trial`, `merged` → `promoted`, `dropped` →
  `retired`, once and idempotently. The nightly pass (and every sweep) applies
  the thresholds under `lessons` in `project.json`, with the design's defaults
  when the key is absent: trial → promoted at 3 distinct-binding hits, 0
  corrections and ≥ 14 days in trial; trial → retired at 30 days uncited or
  any correction; promoted → retired at 90 days uncited or 2 corrections; any
  lesson → retired when a newer one in the same file supersedes it. A
  citation's weight halves every `decayHalfLifeDays`, so the lowest-scoring
  promoted lesson is the one displaced when a file is at `promoted.maxPerFile`.
  A lesson is `trial` from the moment the project steward records it; the
  nightly pass is what moves it. A `boundary` lesson is the exception: the
  pass never promotes it, because it changes the escalation boundary, so it
  waits for the user's Merge through the validation escalation below. The
  thresholds and caps are the whole mechanism — no model judges a tier. The
  project steward may still `complete` a trial by hand, which promotes a
  procedure lesson at once and bypasses `promoted.maxPerFile`; that is an
  explicit override, and the nightly pass is the mechanical path, not the only
  one.
- **The rationale box (BB-35 step 4).** The plugin sets `rationaleWanted` on
  an escalation only when the page should ask the user why, and the page shows
  the box only then, with a one-line placeholder naming the reason. It asks
  when the project steward forwards a routine decision the guidance did not
  settle — a forward with no `entry` naming a decide-list entry — and when the
  nightly pass clusters a question with an earlier one under the same playbook
  (`clusterKey` normalises the wording; the playbook keeps kinds apart). It
  never asks on a `bigDecisions` kind the project could never decide, on a
  credential or a plain step, or on a gate item (`approve-pr`, `merge`,
  `approve-spec`); and one cluster is never asked twice — a supplied rationale
  (`rationale_given`) settles it for good, while an empty box leaves it open
  for a later repeat. An empty box is always accepted, and the answer rides
  with the lesson candidate the project steward is woken for. When the user's answer
  contradicts the recommendation, the plugin sets the after-the-fact ask and
  the project steward is woken once, in its thread, to ask why — one follow-up,
  never repeated. Only the owner's words (the page answer or an unsigned
  comment) or this project's own steward or worker threads reach it.
- **Validation escalations (BB-35 step 5).** Only two rare conditions ask the
  user to confirm a lesson, and `lessons.validations.perWeek` (default 1) caps
  how many of one project's validation items may be filed in a rolling week,
  ordered by score, so the rest wait. The budget covers every user-facing
  lesson question, including the boundary Merge/Drop the project steward files
  by hand when it `complete`s a lesson: that filing is the project steward's
  explicit override, and it still spends a slot so the user is not asked twice
  in one week. A **boundary** trial lesson that meets the promotion threshold
  is not promoted mechanically: the plugin files the existing Merge/Drop item
  on the Stewards page, and the lesson stays `trial` until the user Merges —
  silence leaves it in trial, which is safe because a trial lesson widens
  nothing. A **promoted** lesson with mixed evidence — citations and a
  correction short of the count that retires it, read from the lifetime
  counters step 2 keeps — gets one Keep/Retire question; the decayed score only
  orders the queue, it does not gate the condition. Keep is remembered
  (`validated_at`) so it is never asked again, and silence retires it on the
  next nightly pass. Procedure lessons never produce one. The two conditions
  are pure (`planValidations` in `lessons.ts`); the nightly pass enforces the
  cap and the silence default. A validation escalation is a `needs` item of
  kind `decide` whose `data.validation` names the condition, so it renders with
  the page's existing choices and writes only the lesson's own anchored text.
- **The promotion and retirement write only the lesson's own anchored text.**
  A promotion the nightly pass queues is listed under `## Lessons to land`;
  the project steward adds the block (`<!-- lesson:<id> -->` and the wording)
  to the named file, commits, publishes with `workspace_publish_guidance`, and
  completes it. A retirement is listed under `## Lessons to retire`; the
  project steward replaces the block with `<!-- lesson:<id> retired -->` and
  publishes, then `steward_update { lessonAction: { action: "retire" } }`
  fast-forwards the canonical checkout. The same multi-repo guard applies both
  ways: only the lesson's own file may change, and it must carry the anchor the
  call names. A lesson's `file` may never be `stewards/project.json`, so a
  lesson can never move a big decision to the project, loosen the
  pull-request gate or relax an approval; the decide list, `bigDecisions` and
  `prGate` are outside a lesson's reach by construction. A boundary-scope
  lesson still becomes a Merge/Drop item for the user. `retireLessonAnchor`
  in `lessons.ts` is the normative definition of the retirement edit; the
  project steward makes it by hand and the helper is what the tests pin.
- **Procedure lessons self-merge.** Playbook procedure, sequencing and
  conventions are what the project steward may already decide. It applies
  the text to the file in its `.bb` checkout, commits, and publishes with
  `workspace_publish_guidance`; then
  `steward_update { lessonAction: { id, action: "complete" } }` asks
  multi-repo to fast-forward the canonical checkout to that branch. The
  fast-forward is deliberately narrow: the canonical checkout must be clean
  and not detached, the branch must be a fast-forward whose commits change
  only the lesson's own file, and that file must carry the lesson's text
  (whitespace-normalised). Anything else is refused and the
  `guidance-<thread>` branch is left where it is. The merge commit's sha is
  recorded on the lesson. This is the only way a self-merged lesson reaches
  the HEAD that `readProjectFiles` — and so every steward — reads.
- **Boundary lessons go to the user.** Anything that would change the
  steward's own escalation boundary — credentials and reach, who may direct
  a server, irreversible production steps — is never self-merged. The
  project steward applies, commits and publishes it, then `complete` files a
  BB-15 `decide` item on the binding with the fixed choices **Merge** and
  **Drop**. Merge runs the same multi-repo fast-forward from the page, as
  the connected user and unsigned; Drop marks the lesson dropped. Both close
  the item and wake the steward.
- **The guard.** multi-repo exposes the merge as an RPC that refuses any
  caller but the stewards plugin, and stewards only calls it for a pending
  lesson the project steward recorded. The fast-forward can therefore only
  change the lesson's own file, and only to a version carrying the lesson
  text; other edits already in that file ride along, which the recorded sha
  and the revert below cover.
- **Status is observed, not assumed.** Every sweep and nightly pass reads
  each pending lesson's file at `.bb` HEAD and marks it `merged` when the
  anchored text is there, however it got there; a retired lesson is skipped so
  an observation never resurrects it. `dropped` is set by the user's Drop
  button, the project steward's `drop` action, a retirement, or
  `bb stewards drop-lesson <id>`.
- **The nightly prompt and the digest.** The project steward's nightly wake
  lists the trial lessons to decide from, the promoted ones queued to land and
  the retired ones to remove, with the last refusal reason where one was
  refused. The digest carries nothing about lessons: the merged-lessons
  section is gone, and `bb stewards lessons --all` is where their state is
  read.
- **Surfaces.** Every lesson is in one collapsed details block at the bottom
  of the Stewards page's project tab, with counts by tier and the rows behind
  the disclosure (no buttons of its own; the boundary Merge / Drop stays the
  need in "Waiting on you"); `bb stewards list` names the pending ones and
  `bb stewards lessons [--all]` lists them all, `bb stewards drop-lesson <id>`
  drops one.
- **Undo.** A merged procedure lesson is an ordinary commit on `.bb` HEAD;
  `bb stewards lessons --all` names its `mergeSha` and branch. To undo it,
  revert that commit in the canonical checkout (`git revert <sha>` in the
  project's `.bb`, then push), or let the nightly pass retire it once it is
  uncited for `promoted.retireDays` and remove the anchored block through
  `## Lessons to retire`. The row is kept with `tier: retired` either way. A
  boundary lesson is undone the same way once the user has merged it. A
  lesson recorded by an image before this step gets the column default
  `candidate`, and the remap has already run at its own index, so after a
  roll-forward it is invisible to wakes; `bb stewards lessons --all` still
  shows it, and re-recording it as a fresh trial is the way back.

## 21. The sidebar thread list

An opt-in replacement for bb's own sidebar list, registered through the
exclusive `experimental_threadList` slot (`plugins/stewards/app.tsx`). One
project dropdown in the live view; in-flight efforts grouped by the steward
relationship; a collapsed Watches row for `ops`, Dependabot and Sentry
bindings; a collapsed Recently ended row; and the project steward demoted to
one small row at the bottom. Every row carries bb's own thread actions
context menu, so archive, pin, rename, split and delete still work.

**Title-first rows (BB-48).** A row is the status glyph, the title, and — for
a stewarded effort — the binding key only when the title does not already name
it, plus the held and blocked badges. The title wins: it takes the available
width and truncates last, while the meta shrinks and truncates first. A key
shown is shortened (a pull request `acme/web#612` as `#612`, a ticket as its
own key) and the full key stays on the row's `title` attribute. The stage
leaves the row — the board still groups by stage, but a row no longer repeats
it — and the chevron no longer carries a child count, so only the chevron
signals children. A child row's worker/reviewer label is a small muted `W`/`R`
tag. One-off threads no longer share In flight: they sit in a collapsed
**Threads** row below it, so In flight counts stewarded efforts only.
`buildSidebar` returns `efforts`, `threads` and `watches` separately, and the
split is unit tested in `sidebar.test.ts`.

**Grouping is the steward relationship, not the thread tree.** A worker
belongs to its binding through the plugin's `workers` table and a reviewer
through the worker the RPC names, so BB-23's removal of the parent link cannot
break it. The thread tree is used only for one-off threads, which have nothing
else, and as a fallback for a pre-BB-23 worker whose parent is its steward.
The pure grouping and ordering live in `sidebar.ts` and are unit tested; the
component joins them to `experimental_useSidebarThreads` and polls
`stewardsSidebar` on the board's half-minute visibility-aware cadence.

**The Needs you block and the count badge (BB-46).** The sidebar is where the
user already looks, so what waits on them is shown there, not only on the
Stewards page. The project dropdown carries each project's count in its option
label and the summed count in a pill beside it. Above In flight, a **Needs you**
block lists one row per item
with the entity key (opening the entity), one line of text, and **Details**,
which opens the board at that project. A question's or `decide` item's fixed
`choices` are not rendered here: the board carries the full question, its
context and the choices, so a truncated one-line row never asks the user to
pick blind. An `approve-pr` row carries the page's actions — **Open the pull
request** (`navigate.openUrl` on the item's `url`), **Approve**
(`stewardsNeedAction { action: "approve" }`, no confirmation, the server's
refusal shown in the row) and **Details** (the board at that project) — and
its text wraps instead of truncating, so the repository, number and title are
readable before the click. A `merge` row adds **Merge**
(`stewardsNeedAction { action: "merge" }`, the lane gate re-checked
server-side) beside **Open the pull request** and **Details**. Every other
row's page button is **Details** too: a row without choices, or a
`provide-secret` item, opens the Stewards page at that project, where the
free-text answer and the secret form live. The block adds no write path the
page does not already make.

**One source of truth.** `server.ts`'s `needsYou(projectId, { actionableOnly
})` builds the board's `questions`, `withUser` and `needs` lists in one place;
the board calls it unfiltered, the sidebar calls it with `actionableOnly`, and
`bb stewards needs` prints it, so the surfaces cannot drift and a non-actionable
need is on the page but not in the sidebar's count or items. `stewardsSidebar`
carries, per project,
`needs: { count, items }` with the same row shapes, each tagged
`question`/`withUser`/`need` so the app knows how to render the row and which
one-click action it carries.

**Realtime, not the poll.** The store takes an optional
`onNeedsYouChange(projectId)` callback, wired in `server.ts` to
`bb.realtime.publish("needs-you-changed", { projectId })`; the store stays
free of bb. The callback fires from the store's mutation points — a question
filed (`ask`) or answered (`answer`, `answerQuestionOnly`, `answerEscalation`),
an escalation filed route-`me` (`escalate`) or forwarded to the user or
resolved (`reroute`, `resolve`, `approve`, `decline`), a need filed, updated or
closed (`fileNeed`, `closeNeed`, `closeNeeds`, `closeNeedByKey`), and a binding
ended or reopened (`patch`) — so a steward's own tools publish as well as the
page's buttons. A synchronous coalescing guard makes one question filed or
answered publish exactly one event even when the operation nests (`answer`
resolves its escalation). Every open sidebar refetches when the event names a
project it shows, and the board page refetches when it names its project; the
half-minute poll remains the fallback.

**The default provider, checked (BB-44 criterion 1).** With
`sidebar.threadListProvider` unset it is `__automatic__`, which bb resolves to
"the first installed thread list plugin other than the bundled
`thread-list/thread-list`". Registering the slot therefore makes the stewards
list active on every client that has not pinned a provider, and
`bb settings ui get sidebar.threadListProvider` on the dev server reads
`__automatic__`. **The guard was needed:** without it the list would win by
default. On load the plugin (`server.ts`, `pinSidebarThreadListProvider`)
reads the preference and, when it is unset or `__automatic__`, sets it to
`thread-list/thread-list`; an explicit value is left alone, and a failure is
logged, never thrown. `bb.onInstall` is not usable here — it does not run for
plugins baked into the `bb-server` image — so the pin is on load. BB-44 and
BB-45 are one landing; BB-44 must not land alone.

**The footer toggle (BB-45).** `app.tsx` registers a
`experimental_sidebarFooter` disclosure (`id: "sidebar"`, `icon:
"ShieldCheck"`): a switch that writes the same preference. On sets
`<pluginId>/sidebar`, the id BB-44 registers; off sets
`thread-list/thread-list`. It lists the preference when the disclosure opens
and, on an HTTP 409 revision conflict, re-lists and retries once with the
fresh revision. `__automatic__` (or a missing entry) reads as on, because it
means the stewards list is the effective provider until the pin makes the
choice explicit. The preference is server-synced, so a flip is per server:
every window of one bb server shows the same list. Each developer has their
own server behind bb-gate, so it is per developer in practice.



## Known limits

- **Multi-repo projects only.** A bb project whose source is a single
  ordinary git repo has no `.bb` repo. It could read `.bb/stewards/` inside
  that repo instead, but that needs stewards' own host-side read in place of
  multi-repo's RPC.
- **One developer per project.** Nothing stops a teammate's server from
  stewarding the same ticket.
- **`may` is not a wall.** See §11.
- **Deploys are observed through the playbook's `deployment` target (BB-53).**
  A merged pull request whose playbook names one is recorded as awaiting
  deployment; a GitHub Deployment doorbell wakes the binding, and the steward
  decides from the playbook's rule whether it carries the merge. A project
  that names no target keeps "merged" as the terminal state and follows
  through as before. A deployment that already exists is read through the
  github plugin's source contract on the first watch and on the sweep
  (BB-59), so a missed doorbell costs a sweep, not the timeout; the read
  never evaluates `carries`. A build that fails, is cancelled or times out
  between merge and deployment is forwarded from a `workflow_run` doorbell
  when the playbook names it in `deployment.workflows` (BB-61); the plugin
  only forwards the fact, and a `bb-gate` without the doorbell kind falls
  back to the timeout as before.
- **One developer's server and machine watch production.** An ops binding
  runs on the server of the developer who runs the project's stewards, and
  looks with kubectl on their machine, as them, like everything else here
  (one developer per project). Nothing looks while either is down: in
  particular during bb-gate's 03:00–05:00 US Eastern quiet window, when
  staged updates restart servers, and while the machine is off or off the
  tailnet. A crash then is seen at the first look after. Nothing pages
  anyone either: this is periodic looks, not alerting.
- **Read-only rests on the gate and the playbook.** kubectl runs with the
  developer's own rights (§18); a steward that ignored its `may` list could
  use them.
- **Healthy pods' logs are never scanned**, so an error that does not
  crash, restart or unready a pod goes unseen. A `sentry-project` target
  covers the errors Sentry sees (§18); Alertmanager or Prometheus alerts
  through bb-gate-hooks remain separate work.
- **Comments and the team lease.** bb-gate-hooks does not always know a
  Linear comment's team, so a team lease alone misses some comments. That is
  why every binding also holds an issue lease for its own entity (§16).
  Comments on unbound sub-issues are seen only by the parent's snapshot on its
  next wake.
