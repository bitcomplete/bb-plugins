---
name: build-tickets
description: Work a BB Linear ticket's pull request end to end without a human in the loop - implement it in the repo the ticket names, test it, open the PR, spawn an independent reviewer thread on a different model and address its findings, wait for the approver where the lane needs it, merge, and end there. Use when a thread was spawned by a ticket or PR steward, or asked to take a BB ticket to merged.
---

# Build tickets

A ticket handed to this skill has a settled spec. Usually its **steward**
(the stewards plugin's long-lived thread for a `bb-managed` ticket,
following the project's `linear-tickets` playbook) wrote it, moved the
ticket to **In Progress**, and spawned this thread with the ticket key,
the spec, its acceptance criteria and the slice this PR covers. Nobody is
watching the thread in real time. Questions go to the steward: comment the
question on the ticket, end your turn, and put the question in your final
message; the steward is woken with it and answers with `bb thread tell`.

The project-specific parts are the project's, not this skill's: which
repos depend on which, each repo's test command, the restart note, the
lane triggers and the decide list (`bigDecisions`), and the standing
rules. Read the workspace `.bb/AGENTS.md`, the repo's own `AGENTS.md` and
`README.md`, and `.bb/stewards/project.json` before you act, and read the
`stewards` skill for the approval-durability and human-approval defaults.
`bb stewards brief` prints the steward's invariants — the standing rules,
the ready gate and the exact worker spawn command — when you need them.

The ticket's state is how the team sees progress:

| State | Meaning |
|---|---|
| In Progress | Code is being written. |
| In Review | A PR is open; the reviewer thread and, in the owner lane, a human are reviewing it. |
| Done | Merged and deployed; the steward sets it once the deployment source confirms it. |

A worker never sets **Done**. The steward sets it, which ends the steward's
binding and archives the steward's thread, once every pull request is
merged and the project's deployment source confirms it is live. End at
merge.

`linear_comment` and `linear_update_issue` sign what you write; do not add
a signature line to Linear comments yourself. Everything you post with
`gh` ends with `_— from bb thread <value of $BB_THREAD_ID>_`.

## Build

Work in the repo the task names, on the workspace branch. Read the
workspace `.bb/AGENTS.md` first: which repo depends on which, what each
change triggers, and the "Change classification" lanes. A change that spans
repos is one PR per repo, consumed repo first; the task says which one is
yours.

Keep the change to what the ticket asks. Store migrations are append-only:
add a statement at the end of `MIGRATIONS`, never edit one. A change to a
cross-repo contract changes every side in the same PR or in ordered PRs,
as the project's guidance says.

Review your own diff before committing; there is no user to ask.

## Test

Run what CI runs, and what it does not. The project's `.bb/AGENTS.md` names
each repo's test command and the suites CI skips; the repo's `README.md`
and `AGENTS.md` may add more. Run the changed repo's full suite yourself
whether or not CI does.

A red result is fixed, not explained away. For behaviour a unit test cannot
reach (a page, a CLI command, a webhook path), say in the PR how you
exercised it, or that you could not and why.

## Open the PR

Push and open a pull request against the repo's base branch, titled
`<area>: <what changes> (<KEY>)` like the repo's history. Do not add
closing keywords. The body:

```
Implements [<KEY>](<url>). <Two to five lines: what changed and why.>

> <When the project's guidance says a merge to this repo restarts servers:
> the restart note from `.bb/AGENTS.md`.>

## Classification
<owner-reviewed | no-review>: <the trigger from the project's guidance, or why none applies>

## What changes
...

## Testing
- <the repo's test command>: pass (<n> tests; not in the CI matrix).
- <what else you ran or exercised, one line each>
- Not tested: <what, and why> (omit if nothing).
```

Mark it ready (not draft) once checks pass, move the ticket to **In
Review**, and comment the PR URL on the ticket.

## Get it reviewed

Every PR gets an independent review from a reviewer thread you spawn, on
a different model from yours. The reviewer decides the lane and states it
in its marker; if its lane is stricter than your Classification line, it
wins and you correct the PR body.

### Spawn the reviewer

There is exactly one reviewer per PR. First check that there is none yet:
no "Independent review running" comment on the PR
(`gh pr view <n> --repo <repo> --json comments --jq '.comments[].body' | grep -F 'Independent review running'`)
and no child thread
(`bb thread list --parent-thread "$BB_THREAD_ID" --include-hidden --json`;
children are hidden, so a list without `--include-hidden` is always
empty). If either shows one, use it and skip to The review loop.

Otherwise write the review prompt (below). The reviewer follows the
`pr-reviewer` skill and needs the project's environment so it can run
tests. Do not hand-roll its flags: `bb stewards spawn-flags --role reviewer`
prints the full reviewer spawn command — hidden, full
permissions, the project's reviewer model and environment, started from
this worker thread so `--parent-self` makes it your child. Its output ends
in a heredoc whose body is the placeholder `<the whole task>`; run the
command with your review prompt in place of that line, and the `<task>` in
its title replaced by a short label. Add `--json` and keep the whole
output in a file if you want the thread id; do not pipe it through `tail`
or `head`, which cuts off the `id`.

```
Review pull request #<n> in <owner/repo> by following the pr-reviewer skill.

Ticket <KEY>: <title>
<url>

Acceptance criteria:
<the ticket's criteria, verbatim>

Author thread: @thread:$BB_THREAD_ID. After you post your review comment, end your turn; I will message you with the new head sha when I have pushed fixes.
```

Run the spawn once. If you cannot read an id, look again with the
`--include-hidden` list rather than spawning again: a second spawn is a
second reviewer posting its own rounds. A new child may sit in `pending`
behind the concurrency limit; that is normal. Comment on the PR once,
right away: "Independent review running in bb thread @thread:<id>.",
signed.

### The review loop

Repeat until the merge gate below is met:

1. **Wait for the reviewer:** `bb thread wait <reviewer-id> --status idle --timeout 45m`.
   On timeout, check `bb thread show <reviewer-id>`; if it is in `error`,
   `bb thread retry <reviewer-id>` once, then on a second failure proceed
   with the human review alone and say so on the PR. The wait can return
   at once because the reviewer is still idle from the last round while
   your message is queued; if there is no marker for the current head
   yet, wait again.
2. **Read the gate:** run `bb stewards gate <owner/repo#N>` from this
   worker thread (it resolves the binding). It reads the pull request
   fresh and prints the lane, the latest `bb-review` marker and its sha,
   the matched decide-list entry and who decides, the approval it found
   and its sha, the checks, the binding's open items, and
   `gate met: yes|no`, exiting 0 when met and 1 when not; `--json` emits
   the same fields. The reviewer's verdict is the latest comment whose
   first line matches
   `<!-- bb-review round=N sha=S verdict=V lane=L -->`. An `approved`
   verdict stands after a rebase, a merge of the base branch or a small
   follow-up push even though `S` is no longer the head (the `stewards`
   skill, "An approval is of the pull request, not of a commit"); it goes
   stale only when you change scope or behaviour beyond what the reviewer
   saw, and then you ask for a new round. `lane` is the lane for the merge
   gate.
3. **Act on everything that arrived**, in one pass:
   - Reviewer **Blockers**: fix each one or, if you believe it is wrong,
     do not change the code and write why in your PR reply. A blocker you
     dispute is still open until the reviewer accepts the argument.
   - Reviewer **Suggestions**, on every round including an `approved`
     one: take the ones that improve the change within the ticket's
     scope; decline the rest with a one-line reason. Every suggestion
     gets an answer in your PR reply before the merge gate is checked.
   - **Human** review comments: address them the same way.
   - **Failing checks**: fix them.
   Reply on the PR with one comment listing each point and what you did
   (fixed in <sha>, or declined: <reason>). If you changed code, re-run
   Test, commit and push first. An `approved` round goes to the merge gate
   whether you declined its suggestions or took them: taking a reviewer's
   suggestion, fixing a check or rebasing is a follow-up the approval
   covers. Tell the reviewer the new head so the trail is tidy, but do
   not wait for another round unless you changed scope or behaviour beyond
   what it reviewed.
4. **Ask for the next round:**
   ```sh
   bb thread tell <reviewer-id> --mode auto "Round <N+1>: pushed <new head sha>. Changes: <one line per addressed point, with 'disputed:' prefix for the ones you did not change>."
   ```
   If you changed nothing (everything was disputed), still send it so the
   reviewer can accept or hold the dispute.
5. Go to 1, or to the merge gate after an `approved` round.

Bounds: stop the loop after **six rounds** or **48 hours** without a merge.
Comment on the ticket what is still open and the PR URL, leave the ticket
In Review, and stop. A human can prompt the thread to continue.

On an owner-reviewed PR, once the reviewer verdict is `approved`, end your
turn with the PR waiting on the approver the decide list named: the owner,
or the project steward when the matching entry is `decide: project`. When
it is the owner's, the steward or a human wakes you when they review, and
if 24 hours pass after the reviewer's approval with no human review, post
one reminder mentioning the owner, by the login `gh api user -q .login`
prints (the account this server posts as; the `stewards` skill, "Act as
the user, signed"), with the lane and trigger, then do not mention them
again. When it is the project steward's, the plugin wakes this thread when
the `bb-approval` marker lands; do not mention the owner for it.

### The merge gate

`bb stewards gate <owner/repo#N>` prints the verdict the page and the wake
use, computed by the plugin, so do not re-derive it by hand.
The conditions it checks:

1. The reviewer's latest marker says `verdict=approved`. It may name an
   earlier sha than the head: a rebase, a merge of the base branch or a
   follow-up push does not void it (the `stewards` skill, "An approval is
   of the pull request, not of a commit"). Only a push that changed scope
   or behaviour beyond what the reviewer saw needs a new round first.
2. Every check has passed on the current head.
3. **Owner-reviewed lane only:** the approval the decide list
   (`bigDecisions` in `.bb/stewards/project.json`) named, by the rule in
   the project's guidance and the `stewards` skill ("When a human must
   approve"). `bb stewards gate` prints the matched entry and who decides,
   and the approval it found — the owner's unsigned GitHub approval, or
   the project steward's `bb-approval` marker. You open the PR from the
   owner's account, so GitHub records the owner's approval as a COMMENTED
   review; a signed review or comment never counts, whatever it says. The
   newest project-steward marker decides: a decline is a change request
   for the loop, an approved marker names the approved sha. Whichever it
   is, the head having moved past the approved sha does not matter on its
   own: rebases, merges of the base branch, addressed comments and your
   own small fixes are all covered. The condition is met unless you have
   since added scope or changed behaviour beyond what the approver saw.

With `lane=no-review`, conditions 1 and 2 are the whole gate. Before
merging, re-read the reviewer's "Owner review required" line and your own
Classification line; if either says owner-reviewed, or the diff touches a
trigger the reviewer missed, treat it as owner-reviewed and wait.

With `lane=owner-reviewed`, wait for the three conditions: the reviewer's
verdict, green checks, and the approval the decide list named. If the
approval lands while the reviewer still has blockers open, finish the
reviewer round first. Only if you have changed scope or behaviour beyond
what was approved do you ask on the PR for a fresh look at the final sha,
saying in a line what changed since the approval.

**A conflict with the base branch is yours to clear, not a question for
anyone.** When the merge is refused because the PR is not mergeable, merge
the base branch into the branch (or rebase), resolve the conflicts however
they need resolving, push, wait for the checks, and merge. Neither
approval needs renewing for that, and the reviewer does not need another
round. Do not post asking how to proceed and do not wait for the queue of
other PRs to drain. If the base branch moves again before you merge, do it
again.

## Merge and end

You merge; no person does (the project's guidance, "Who merges", and the
`stewards` skill). An empty or `REVIEW_REQUIRED` `reviewDecision` is
normal on every agent PR and is not part of the gate; the base branch is
not protected and the `gh` login is an admin, so there is no merge
permission to wait for. Run:

```sh
bb stewards merge <owner/repo#N>
```

It re-reads the pull request, re-checks the lane gate, refuses with the
gate's reason when it is unmet or another worker is still running on the
pull request, and otherwise squash-merges, posts the "Merged:" comment
(lane, approved sha, a "since then" line when the head moved past it, the
merge commit, and the restart note when the project's guidance says a merge
there restarts servers), and closes the Merge item. If it refuses, do not
look for another way: fix the gate, or if the thread's permission system
refuses the command, post the gate on the PR, put it in your final message,
and the steward merges with the same command. Carry on here once it is in.

Then stop the reviewer with `bb thread stop <reviewer-id>` and **end your
turn**. You do not watch the release: no `gh run list`, `gh run watch` or
`kubectl rollout status`, and no turn held open for the wait. The project's
playbook names a GitHub Deployments source, and the plugin tells the
ticket steward when a merge is deployed, fails, or times out. The project's
`.bb/AGENTS.md` says what a merge to each repo carries; read it, and when a
merge stages a restart, say so in your final message.

Do not move the ticket to **Done**: the steward closes it once every pull
request is merged and deployed, and it is woken by the deployment source,
not by you. Leave the ticket's state to the steward.

A docs-only or host-side change builds nothing, and host-side material
still has to be applied on the host by hand: say so in your final message.

## Report and end

Your final message is what the steward reads when the turn ends. Put in it
the PR URL and number, the lane, the approved sha, the merge commit,
whether the merge stages a restart, and anything still open — a refused
`bb stewards merge`, a disputed blocker, a change that still needs applying
by hand. If something you already saw while merging (a check, a signed
comment, a failed run on the PR page) shows a build failing or hung, add
one line starting "Build problem:" with the run URL; the steward escalates
it at once. Do not go looking for it: you still do not watch the release.
Do not post a closing comment on the ticket and do not set it to **Done**;
the steward is woken by the merge and the deployment source and closes the
ticket once every pull request is merged and deployed.
