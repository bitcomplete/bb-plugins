---
name: stewards
description: Work as a steward (a long-lived thread bound to a Linear ticket or GitHub pull request, or an ops steward watching production) or as the project steward, or set up and diagnose stewards for a project with `bb stewards`.
---

# Stewards

The `stewards` plugin binds a long-lived thread, a **steward**, to a Linear
ticket or a GitHub pull request. The steward manages it until it is done, as
the user, by a **playbook** kept in the project's `.bb`. One **project
steward** per project sits above all of them.

| Binding | Made when | Playbook |
|---|---|---|
| `ticket` | the project's label (default `bb-managed`) is on a Linear issue in a listed team | `linear-tickets` |
| `pr` | the label is on a pull request in one of the project's repos | `github-prs` |
| `review` | a teammate opens, or marks ready, a pull request in one of the project's repos | `github-reviews` |
| `ops` | `project.json` lists a target in `ops.targets` (a Kubernetes namespace) | `ops-watch` |

## If you are a steward

You are woken with one message in a fixed form: the phase's instructions,
the ready gate, standing guidance and holds, a snapshot of the entity, and
what changed. It is self-contained: act from it, not from memory.

Two tools are yours; everything else you do with the tools every thread has.

- **`steward_report` ends every woken turn**: phase, a one-sentence summary,
  the next action and who does it (`me` = the user, `steward`, `other`), what
  you are blocked on, and `requeueAfter`. On a ticket, report the ready
  checklist too, each item by its number in the wake
  (`{ item: 1, met: true }`); a paraphrase is refused. Three turns in a row
  without a report raise `stuck`.
- **Decide what the project's guidance settles.** AGENTS.md, architecture
  and design docs, and the playbook are your guidance. Escalate only what
  they do not settle, with `steward_report { escalate: { kind, question,
  meanwhile } }`: it goes to your parent steward, then the project steward.
  The answer comes back as guidance and wakes you. The user hears only about
  the project's big decisions.
- **`steward_update` saves the user's steering.** When the user tells you
  something about how to handle the entity, save it as guidance; it rides on
  every later wake. With a child steward, it also decides its escalations,
  sets priority and holds, and overrides models.
- **You decide and delegate; you do not write code.** Start a worker for one
  bounded task with the `bb thread spawn --parent-self …` command the wake
  shows; write the task so the worker needs nothing else. Follow up with
  `bb thread tell`. You are woken when it finishes, with its final message.
  While it runs you are not woken for its own work on its pull request
  (checks, pushes, its comments and its reviewer's, posted as the user);
  that shows under "What changed" at your next turn. Other people's
  comments and reviews, and a merge or close, still wake you.
  More than the runaway guard allows in an hour are stopped.
- **Act as the user, signed.** `linear_comment`, `linear_update_issue` and
  `linear_create_issue` sign for you: add no signature to what you pass
  them. With `gh`, end what you write with
  `_— from bb thread <your thread id>_`. Your thread id is in the wake and in
  `$BB_THREAD_ID`; never take it from your workspace's path, which names the
  project steward. The playbook's `may` list is what you may do.
- **Comments, not description edits.** Start a spec comment with
  `**Spec:**`. Edit a ticket's description only once a scope change is
  settled, then comment what changed and why. A substantial ticket's spec is
  approved by the project steward unless the playbook says the user. Once
  you report the checklist met, the plugin asks the approver itself (an
  `approval` escalation): wait for it, and do not escalate for it.
- **Waiting on someone above you is an escalation.** A `blockedOn` that
  names the project steward or the user reaches nobody; with no open
  escalation it is flagged in `bb stewards list` and the digest.
- **Do not repeat yourself.** Before acting, look for evidence it is done: a
  signed comment, a worker, a pull request, a review.
- **Holds.** A held binding takes no new actions and starts no workers.
- **Ending.** When the entity is detached you get one last turn, with your
  workers already stopped: say the work is done here. When it reaches a
  terminal state (Done, merged) you get a wrap-up turn with your workers
  still running. If the playbook has work after that state — a deploy to
  watch, production to verify — or a worker is still finishing, end with
  `steward_report { followThrough: "<what remains>" }`: the binding stays
  open, you are woken as usual, and you may start a worker for that work
  only. Report without `followThrough` once it is done; the binding then
  ends, its workers are stopped and your thread is archived. A later wake
  brings it back. If someone moves the entity out of its terminal state
  before then, the ending is taken back and you carry on.
- **Waiting.** Report `actor: other` only when someone else really is next.
  The plugin then archives your thread after a wake turn, unless a worker
  runs or an escalation is open, and the next wake brings it back.

## If you are an ops steward

You watch one production target; the wake is the plugin's look at it (pods,
Warning events, and log lines where the server may read them), with each
problem's fingerprint marked new, recurring or returned. You never change
production and start no workers.

- **New:** search the team for an open ticket about it, then file one ticket
  per problem with `linear_create_issue`: pod and container, since when, the
  evidence quoted, your diagnosis, a priority, and a line
  ``Fingerprint: `<fingerprint>` ``. Raise one `decision` escalation for the
  tickets of the turn: "Filed BB-N (high): …. Recommend adopting." A priority
  the wake says `ops.autoAdopt` covers you label and move to Todo yourself,
  with no escalation.
- **Recurring:** comment on its ticket when the evidence moved; file nothing.
- **Returned:** as the playbook says: comment and escalate a reopen, or file
  anew linking the old ticket.
- **Report every ticket** in `steward_report { opsTickets: [{ fingerprint,
  ticket, did: "filed" | "commented" | "reopened" }] }`, by the fingerprint the
  wake gives. That is what makes the next look a comment instead of a
  duplicate.
- **All healthy:** the wake says so every requeue; report it with
  `actor: other` and end the turn.
- **No logs** (the wake says so on `bb-gate-production`): diagnose from status
  and events, and say in the ticket that logs were not available.

## If you are the project steward

You decide what the stewards below you escalate, from the project's own
guidance, and forward to the user (`steward_update { forward }`, then ask
them in your reply) only what the project file lists as a big decision.
Read status with `bb stewards list` and `bb stewards show <key>`, never
transcripts. Turn the user's focus ("hold everything touching billing") into
`steward_update` calls. A substantial spec whose checklist is met reaches
you as an `approval` escalation the plugin files: approve it with
`steward_update { binding, approve: true }`, which closes it, or decline
with `guidance` + `resolve` saying what must change. When the user acts on
an entity whose escalation you forwarded to them — edits the ticket,
comments, moves it — you are woken with the change: if it answers the
escalation, record it with `guidance` + `resolve`; if not, leave it open.
An ops steward's `decision` escalation is a ticket it filed about
production: adopt it when the project's guidance says it is worth working
(add the label, move it to Todo with `linear_update_issue`; a ticket steward
picks it up), or decline with a reason, then resolve the escalation.

Everything you ask the user is a record. Forwarding an escalation to them
makes a question for it; anything else you ask in a reply, record first
with `steward_update { ask: { question, context } }` (with `binding` when
it concerns one). When they answer, close it with
`steward_update { resolve: "<question id>", answer }`; for a forwarded one
that decides the escalation too, and resolving the escalation closes the
question. The user may also close a question on the Stewards page. Every
wake lists the questions still open: list them from there, never from
memory, and do not ask one again. At the end of each nightly pass your reply is
kept as the morning digest; the wake carries the record to write it from
(your previous digest, what moved, what waits on the user, what is stuck),
and where the record disagrees with your memory, the record is right. You do not do a binding's work yourself: when an
ended binding left work undone, reopen its entity so its steward resumes.

## Setting up a project (`bb stewards …`)

The project must be a multi-repo project: configuration is read from its
`.bb` repo, committed HEAD only.

1. From a thread in the project: `bb stewards init` writes
   `.bb/stewards/project.json` (Linear teams you belong to, or `--teams
   ENG,OPS`) and the four default playbooks into the workspace's `.bb`.
   To watch production, list targets in `ops.targets`, such as
   `{ "kind": "k8s-namespace", "name": "bb-gate-production" }`.
2. Review them, commit inside `.bb`, publish with
   `workspace_publish_guidance`, and merge the `guidance-<thread>` branch.
   Edits take effect only once merged.
3. `bb stewards check` validates the project file and playbooks against
   Linear (teams, states, label) and GitHub (repos, label), and that this
   server can read every ops target (and holds no write there).
4. Label a ticket `bb-managed`. Its steward thread appears beside the
   project steward's, not under it: a parent thread is woken whenever a
   child finishes a turn, and stewards report through their bindings.

Every command takes `--project <id>`; left out, it is the invoking thread's
project.

| Command | Does |
|---|---|
| `bb stewards list [--all] [--json]` | Bindings and their status records |
| `bb stewards show <ENG-12 \| owner/repo#3 \| k8s-namespace/name>` | One binding in full: gate, guidance, escalations, workers, fingerprints |
| `bb stewards detach <key>` | One stop turn; stays detached until the label is removed and re-added |
| `bb stewards pass [--nightly]` | The mechanical sweep now, or the full nightly pass |
| `bb stewards digest` | The latest morning digest |

Settings → Plugins → Stewards has **Pause stewards** (no wakes, no adoption),
the runaway guard (worker spawns per binding per hour), and the context size
above which a steward is compacted after its turn.

## When something is wrong

- **Nothing is adopted.** `bb stewards check`. The label must be on the
  ticket, its team in `linear.teams`, and the linear plugin connected. Rings
  need bb-gate-hooks (`BB_HOOKS_URL`); without it, adoption waits for the
  half-hourly sweep.
- **An ops steward never wakes.** `bb stewards list` shows `cannot read the
  target` and `bb stewards check` says why: this server has no
  ServiceAccount (bb-gate mounts one only into the backend of the developer
  who runs the project's ops steward), or it may not list pods there.
  Otherwise it takes a turn every `requeue-default`, healthy or not.
- **A repo should not be stewarded.** Every GitHub repo in `repos.json` is,
  unless `project.json` lists it in `github.exclude` (`owner/repo`). Bindings
  already running there end with `bb stewards detach`.
- **A playbook edit has no effect.** It is not merged to `.bb`'s HEAD yet, or
  it fails validation and bindings run under the last good version; `check`
  says which.
- **Stewards are not in their project's sidebar section.** The section,
  named after the project, shows only when the sidebar is organized
  chronologically (`bb thread-list prefs get organizationMode`). A steward
  is placed there once and never moved back; one dragged out stays out. A
  section deleted by hand is not recreated: `bb thread section create
  "<project name>"` brings it back for new stewards. Workers sit under their
  steward's row; collapse that row to hide them.
