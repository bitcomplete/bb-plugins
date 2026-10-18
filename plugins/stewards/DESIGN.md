# Stewards — design

A BB plugin that gives a Linear ticket or a GitHub pull request **a long-lived
thread that manages it until it is done**. The thread, a **steward**, acts on
the entity as you, according to a playbook the project keeps in `.bb`, and you
steer it only from bb.

Status: built (steps 1–4 of the build order; the board is not, but the settings page lists every steward and its status). See
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
| **Entity** | A Linear issue or a GitHub pull request. |
| **Binding** | The durable record that a steward manages an entity. Kinds: `ticket`, `pr`, `review`. No TTL. |
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
  archived between wakes too (§5, "Waiting"). thread-briefs is asked,
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
  reviewers) archives the steward's thread when the turn ends. The binding
  stays, and the next wake brings the same thread back. It stays in the
  sidebar while a worker runs or an escalation is open, while it follows
  through after a terminal state, when the user is next, and after a turn
  the user started, which is theirs to read.
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
   While one of the steward's workers is running, its own work on a pull
   request is not actionable: checks finishing, description edits, and
   pushes and comments from the developer's account, which the worker and
   the reviewers it starts post as, often unsigned. People, merges and
   closes still are.
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
it holds more than a setting (120,000 tokens by default). Left to the provider,
compaction comes near the window's end, and every turn before then reads the
whole transcript. A wake too long to send is cut in its snapshot, never in
what changed. The steward acts and must end its turn with `steward_report`,
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
- **Questions to you are records.** Whatever the project steward asks you is
  a row in the `questions` table, not just a sentence in its reply, so a
  compaction cannot lose it and an answer given elsewhere cannot leave it
  listed as open. A row is made two ways: when it forwards an escalation to
  you (`steward_update { forward }` with the route reaching `me`), bound to
  that escalation and its binding; and when it asks you something itself
  with `steward_update { ask: { question, context } }`, bound to a binding
  when it names one. It closes when the project steward records your answer
  (`steward_update { resolve: "<question id>", answer }`) or when you close
  it on the stewards page, with or without an answer. A question made by
  forwarding and its escalation close together, in one transaction, from
  either side: resolving the escalation (by decision, by the binding
  ending) closes the question with the same text, and closing the question
  resolves the escalation and tells the binding's steward. Every project
  steward wake lists the open questions from the table, and tells it not
  to ask one again.
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
```

- **Phases are the entity's own states**, so the playbook needs no state
  machine. A ticket moved by hand is followed.
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
  it leaves the project section alone. The project steward is titled
  "<project name> project steward".
- Workers are visible children of their steward, started by the steward
  with `bb thread spawn --project … --parent-self --lifecycle-owner-thread
  …` and recognized by the plugin as children of a steward thread. bb's list
  builds the parent tree before it files trees into sections, so a worker
  shows under its steward's row in the project section whatever section
  thread-briefs gives the worker itself, and collapses with that row
  (`collapsedThreads`). Workers are not tagged for thread-briefs: their
  briefs, renames and auto-archiving are thread-briefs' as for any thread.
- Whether a steward is waiting on you, waiting on someone else, or done is
  thread-briefs' judgment from its transcript. Ended bindings are archived
  by this plugin, not by thread-briefs.

## 16. Architecture

### `plugins/stewards`

- **Configuration:** the project file and playbooks through multi-repo, and
  validation.
- **Store:** bindings, status records, escalations, workers.
- **Reconciler:** mechanical tier, debounce, nightly pass, `requeueAfter`
  timers, escalation routing.
- **Threads:** spawning stewards, recognizing workers, building wake messages,
  the project's sidebar section.
- **Agent tools:** `steward_report` and `steward_update`.
- **CLI:** `bb stewards init | check | list | show | detach | pass | digest`.
- **UI:** the Stewards page, a nav panel with one tab per stewarded project:
  waiting on you (open questions, which you can close there, forwarded
  escalations and approval requests), in flight by stage (summary, next
  action and actor, running workers), stuck or held, ended in the last two
  weeks, and the latest digest with its date. Settings → Plugins →
  Stewards keeps each project's configuration and health.

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

The cross-plugin RPC contract in §3.

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

## Known limits

- **Multi-repo projects only.** A bb project whose source is a single
  ordinary git repo has no `.bb` repo. It could read `.bb/stewards/` inside
  that repo instead, but that needs stewards' own host-side read in place of
  multi-repo's RPC.
- **One developer per project.** Nothing stops a teammate's server from
  stewarding the same ticket.
- **`may` is not a wall.** See §11.
- **Deploys are not observed.** "Merged" is the terminal state for pull
  requests. A deploy event source (GitHub deployment or workflow-run events
  through bb-gate-hooks, and the deploy in the snapshot) would be new work in
  three repos. Until then, a playbook that wants a deploy watched has the
  steward follow through (§5) while a worker watches and verifies it.
- **Comments and the team lease.** bb-gate-hooks does not always know a
  Linear comment's team, so a team lease alone misses some comments. That is
  why every binding also holds an issue lease for its own entity (§16).
  Comments on unbound sub-issues are seen only by the parent's snapshot on its
  next wake.
