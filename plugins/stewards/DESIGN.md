# Stewards — design

A BB plugin that gives a Linear ticket or a GitHub pull request **a long-lived
thread that manages it until it is done**. The thread, a **steward**, acts on
the entity as you, according to a playbook the project keeps in `.bb`, and you
steer it only from bb.

Status: design. Nothing here is built yet.

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
| **Project file** | `.bb/stewards/project.json`: Linear teams, adoption label, nightly schedule, the project steward's model. |
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

## 3. Configuration

```
.bb/
  repos.json                   owned by multi-repo; the GitHub repos
  stewards/
    project.json               Linear teams, label, nightly, project steward
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
  "label": "bb-managed",
  "nightly": { "at": "01:00", "timezone": "America/New_York" },
  "projectSteward": { "model": "claude/claude-opus-5-5/high" }
}
```

- **Linear teams are listed here**, by key. `repos.json` cannot hold them: its
  schema is strict, and multi-repo deliberately knows nothing about other
  plugins.
- **GitHub repos are not listed.** They are the project's `repos.json`, read
  through multi-repo, so a repo added to the workspace is stewarded without a
  second edit.
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

Whether multi-repo's host-side read fast-forwards the canonical checkout from
its remote, or only fetches, needs checking before this is built.

## 4. Bindings and adoption

| Kind | Trigger | Default playbook |
|---|---|---|
| `ticket` | `bb-managed` added to an issue in a listed Linear team | `linear-tickets` |
| `pr` | `bb-managed` added to a pull request in a repo from `repos.json` | `github-prs` |
| `review` | a non-draft pull request, authored by someone other than you, opened or marked ready in a repo from `repos.json` | `github-reviews` |

- The plugin hears triggers through bb-gate-hooks `team` and `repo` leases,
  which already exist. The nightly pass re-lists labelled tickets and open
  pull requests as the correctness backstop.
- A new steward is spawned in the **Managed** section with its display parent
  set to its nearest managed ancestor, or the project steward when it has none.
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
| standing guidance | Your instructions, appended through `steward_guidance`. |
| ready gate | Checklist state, substantial or not, approval and the spec hash it was given against. |
| priority, holds | Written by the project steward or a parent steward. |
| model overrides | Steward and worker models, when overridden. |
| status record | The latest one (§6). |
| action log | Actions with idempotency keys (§6). |
| requeue at, last snapshot, last judgment | Timers and the mechanical tier's memory. |
| created, ended, end reason | Lifecycle. |

Storage is SQLite with append-only migrations, as in the linear and github
plugins.

## 5. Lifecycle

- **Terminal.** The entity reaches a state the playbook declares terminal
  (Linear Done or Canceled; GitHub merged or closed). The steward gets one
  wrap-up turn — a final comment, closing workers — and is archived with its
  workers.
- **Reopen.** The entity leaves a terminal state. The same thread is
  unarchived and the binding resumes. No second thread.
- **Detach.** The label is removed. The steward gets one turn to stop: no new
  actions, workers told to wind down. Then it is archived. Re-adding the label
  unarchives it.
- **Review stewards** end when the pull request is merged or closed.
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
   - phase changed, or a terminal state, reopen or detach;
   - a human comment, a review submitted, a review re-requested;
   - checks finished; a pull request merged, closed or pushed by someone else;
   - a worker finished or failed; a child steward's status changed;
   - guidance changed, an escalation resolved, an approval given or voided;
   - the spec changed (description edited, spec comment added);
   - `requeueAfter` came due.
4. Otherwise the snapshot is recorded and the ring ends. Most rings end here:
   the steward's own comments, label churn, pushes by its own workers while
   checks run.

### Judgment tier

The steward is woken with one message in a fixed form:

1. The phase's instructions from the playbook.
2. The ready gate's state.
3. Standing guidance, priority and holds.
4. The snapshot.
5. What changed since its last turn.

Each wake is self-contained, so compaction can be aggressive. The steward acts
and must end its turn with `steward_report`, which writes the status record:

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
worker, an open pull request, a submitted review. Actions that leave no
visible trace go in the binding's action log with an idempotency key, and the
log is part of the snapshot.

### The nightly pass

At the project file's time, 01:00 US Eastern by default:

1. Every open binding gets one judgment turn whether or not anything changed,
   staggered and capped per night.
2. The project steward's pass follows, over the fresh status records, and
   writes the morning digest.

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
  approval: me            # or { linear-state: Approved }
```

- **Specifying is done in comments.** In a `spec` stage the steward checks the
  ticket against the checklist. What it can work out — acceptance criteria,
  affected repos, a plan — it posts as signed **spec comments**. What it
  cannot, it asks through a `decision` escalation. It does not rewrite the
  description.
- **Approval.** A substantial ticket waits. With `approval: me` you approve in
  bb, recorded by `steward_approve`. With a Linear signal, the steward waits
  for it.
- **The approval is pinned to the spec.** It is stored with a hash of the
  description and the spec comments it was given against. The mechanical tier
  flags any change after approval; the steward judges whether it is material,
  and if so voids the approval and asks again.
- **Scope changes edit the description.** When the scope changes, the steward
  raises a `scope` escalation. Once it is resolved, the steward updates the
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
- **Comments and change requests post without asking. Approvals go to you**
  (`gate: me` on approve). An approval is the branch-protection safeguard
  against unreviewed merges; if an agent can give it as you, the safeguard is
  an agent too.
- **Authors to skip**, such as dependency bots, are a playbook field.
- **Cost.** Review stewards default to a small model. The work is in the
  workers, one per round.
- The morning digest lists reviews waiting on your approval.

## 10. Steering and escalation

### Steering

- **One binding:** say it in its steward's thread. The steward saves it with
  `steward_guidance`, and every later wake carries it.
- **The project:** say it to the project steward — "focus on auth this week",
  "hold everything touching billing", "use a stronger model on ENG-57". It
  turns that into priority, holds and model overrides on bindings.
- **All work of a kind:** edit the playbook.

### Escalation

`steward_escalate` takes:

- a **kind** — `blocked`, `decision`, `scope`, `conflict`, `stuck`;
- **what it needs** — one answerable question;
- **what it will do meanwhile** — wait, continue the unblocked part, or proceed
  with a stated default.

An escalation is a condition on the status record, not a message, and stays
until it is resolved.

- **Routing:** nearest managed ancestor, then the project steward, then you.
  Each level resolves it by writing guidance onto the binding — which clears
  the condition and wakes the steward — or forwards it with a recommendation.
- **Straight to you:** kinds listed in the playbook's `escalate-to-me`, and
  every gate — `gate: me`, ready-gate approval, review approval. The steward
  then shows as waiting-on-me.
- **Your answer**, in any of the threads involved, becomes standing guidance.
- **Backstop:** a status record that has not advanced within the playbook's
  `stuck` limit gets a `stuck` escalation raised for it.

## 11. Enforcement

`may` lists what a playbook allows a steward to do. It is checked by the
source plugins' write tools: a tool called from a bound thread refuses an
action its playbook does not allow, and a description edit is refused unless
the binding has a resolved `scope` escalation newer than the last edit.

That check sits on the normal path only. A steward with a shell can run `gh`
or call an API directly. Irreversible actions rely on the platforms: branch
protection that requires someone else's approval, and review approvals that go
through you. Every action is signed and recorded against its binding, so what
a steward did is always visible afterwards.

## 12. The project steward

- **Reads** status records and your focus guidance. Never transcripts; that is
  what keeps it small however many bindings are open.
- **Writes** priority, holds and model overrides onto bindings
  (`steward_prioritize`, `steward_set_model`), resolutions to escalations,
  forwarded escalations with its recommendation, and the morning digest.
- **Woken** at the end of the nightly pass, by escalations that reach it, and
  by your messages.
- **Budget is advisory.** Status records report what each binding uses; the
  project steward keeps the total sensible through priority and holds.
- **Runaway guard.** A hard cap on worker spawns per binding per hour, to stop
  a looping thread. Not a budget.

## 13. Models

```yaml
models:
  steward: claude/claude-sonnet-5-5/medium
  worker: claude/claude-opus-5-5/high
```

- A playbook names the models for its stewards and their workers. The project
  file names the project steward's.
- Whichever thread spawned a binding can override its models with
  `steward_set_model`: the project steward for any binding, a parent steward
  for its children and workers. The override is applied with the thread's
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
  Triage:      { stage: spec }
  Todo:        { stage: spec }
  In Progress: { stage: build }
  In Review:   { stage: review, stuck: { days: 3 } }
terminal: [Done, Canceled]
ready: { ... }                    # §7
promote: "A sub-issue that needs more than one pull request or its own approval."
escalate-to-me: [scope]
may: [comment, edit-description, set-state, set-labels, create-sub-issue, open-pr, request-review, spawn-worker]
models: { ... }                   # §13
requeue-default: 2d
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

- A **Managed** section holds the pinned project steward and every ticket and
  review steward, nested under their display parents.
- Workers are hidden children of their steward.
- A steward waiting on someone else stays quiet. Only gates and escalations
  that reach you make it waiting-on-me.
- Terminal bindings are archived.

## 16. Architecture

### `plugins/stewards`

- **Configuration:** the project file and playbooks through multi-repo, and
  validation.
- **Store:** bindings, action log, status records.
- **Reconciler:** mechanical tier, debounce, nightly pass, `requeueAfter`
  timers, escalation routing.
- **Threads:** spawning stewards and workers, building wake messages.
- **Agent tools:** `steward_report`, `steward_guidance`, `steward_escalate`,
  `steward_spawn_worker`, `steward_set_model`, `steward_approve`, and for the
  project steward `steward_prioritize`.
- **CLI:** `bb stewards init | check | list | show | detach | pass`.
- **UI:** a board of status records, later.

### Changes to linear and github

- **A source contract**, in a contract file the three plugins share:
  `snapshot`, `validate`, `adoptable` (labelled tickets and open pull requests,
  for the nightly backstop).
- **Leases and rings.** The hooks clients hold `team` and `repo` leases for
  the units stewards asks for, plus an issue lease for every bound entity, and
  forward rings to stewards over cross-plugin RPC. Existing `linear_watch_issue` and
  `github_watch` are unchanged.
- **linear:** description editing on `linear_update_issue`, which today changes
  state, assignee, labels and priority only. The `may` check on write tools.
- **github:** write tools it does not have yet — comment, and submit a review
  (comment, request changes, approve) — signed like linear's, with the `may`
  check. Without them every GitHub write goes through `gh` and nothing is
  checked.

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
   standing guidance, the ready gate, terminal, reopen and detach, escalation
   straight to you.
2. **Pull requests, workers, sub-issues.** Linked pull requests in snapshots,
   workers, model overrides, the `may` check, the runaway guard, promotion and
   parent routing, labelled pull requests.
3. **Project steward.** Escalation routing, priority and holds, the nightly
   pass, the morning digest.
4. **Reviews.** Review bindings, review workers, the approval gate, github's
   review tool.
5. **Board.**

## Known limits

- **Multi-repo projects only.** A bb project whose source is a single
  ordinary git repo has no `.bb` repo. It could read `.bb/stewards/` inside
  that repo instead, but that needs stewards' own host-side read in place of
  multi-repo's RPC.
- **One developer per project.** Nothing stops a teammate's server from
  stewarding the same ticket.
- **`may` is not a wall.** See §11.
- **Deploys are not observed.** "Merged" is the terminal state for pull
  requests. A deploy event source would be new work.
- **Comments and the team lease.** bb-gate-hooks does not always know a
  Linear comment's team, so a team lease alone misses some comments. That is
  why every binding also holds an issue lease for its own entity (§16).
  Comments on unbound sub-issues are seen only by the parent's snapshot on its
  next wake.
