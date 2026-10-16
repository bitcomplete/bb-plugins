---
name: stewards
description: Work as a steward (a long-lived thread bound to a Linear ticket or GitHub pull request) or as the project steward, or set up and diagnose stewards for a project with `bb stewards`.
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

## If you are a steward

You are woken with one message in a fixed form: the phase's instructions,
the ready gate, standing guidance and holds, a snapshot of the entity, and
what changed. It is self-contained: act from it, not from memory.

Two tools are yours; everything else you do with the tools every thread has.

- **`steward_report` ends every woken turn**: phase, a one-sentence summary,
  the next action and who does it (`me` = the user, `steward`, `other`), what
  you are blocked on, and `requeueAfter`. On a ticket, report the ready
  checklist too. Three turns in a row without a report raise `stuck`.
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
  More than the runaway guard allows in an hour are stopped.
- **Act as the user, signed.** `linear_comment`, `linear_update_issue` and
  `linear_create_issue` sign for you. With `gh`, end what you write with
  `_— from bb thread <your thread id>_`. The playbook's `may` list is what
  you may do.
- **Comments, not description edits.** Start a spec comment with
  `**Spec:**`. Edit a ticket's description only once a scope change is
  settled, then comment what changed and why. A substantial ticket's spec is
  approved by the project steward unless the playbook says the user.
- **Do not repeat yourself.** Before acting, look for evidence it is done: a
  signed comment, a worker, a pull request, a review.
- **Holds.** A held binding takes no new actions and starts no workers.
- **Ending.** When the entity is done or detached you get one last turn: say
  the work is done. The plugin archives your thread when the binding ends;
  a later wake brings it back.

## If you are the project steward

You decide what the stewards below you escalate, from the project's own
guidance, and forward to the user (`steward_update { forward }`, then ask
them in your reply) only what the project file lists as a big decision.
Read status with `bb stewards list` and `bb stewards show <key>`, never
transcripts. Turn the user's focus ("hold everything touching billing") into
`steward_update` calls. Approve substantial specs with
`steward_update { approve }`. At the end of each nightly pass your reply is
kept as the morning digest.

## Setting up a project (`bb stewards …`)

The project must be a multi-repo project: configuration is read from its
`.bb` repo, committed HEAD only.

1. From a thread in the project: `bb stewards init` writes
   `.bb/stewards/project.json` (Linear teams you belong to, or `--teams
   ENG,OPS`) and the three default playbooks into the workspace's `.bb`.
2. Review them, commit inside `.bb`, publish with
   `workspace_publish_guidance`, and merge the `guidance-<thread>` branch.
   Edits take effect only once merged.
3. `bb stewards check` validates the project file and playbooks against
   Linear (teams, states, label) and GitHub (repos, label).
4. Label a ticket `bb-managed`. Its steward appears as a child of the
   project steward thread.

| Command | Does |
|---|---|
| `bb stewards list [--all] [--json]` | Bindings and their status records |
| `bb stewards show <ENG-12 \| owner/repo#3>` | One binding in full: gate, guidance, escalations, workers |
| `bb stewards detach <key>` | One stop turn; stays detached until the label is removed and re-added |
| `bb stewards pass [--nightly]` | The mechanical sweep now, or the full nightly pass |
| `bb stewards digest` | The latest morning digest |

Settings → Plugins → Stewards has **Pause stewards** (no wakes, no adoption)
and the runaway guard (worker spawns per binding per hour).

## When something is wrong

- **Nothing is adopted.** `bb stewards check`. The label must be on the
  ticket, its team in `linear.teams`, and the linear plugin connected. Rings
  need bb-gate-hooks (`BB_HOOKS_URL`); without it, adoption waits for the
  half-hourly sweep.
- **A repo should not be stewarded.** Every GitHub repo in `repos.json` is,
  unless `project.json` lists it in `github.exclude` (`owner/repo`). Bindings
  already running there end with `bb stewards detach`.
- **A playbook edit has no effect.** It is not merged to `.bb`'s HEAD yet, or
  it fails validation and bindings run under the last good version; `check`
  says which.
