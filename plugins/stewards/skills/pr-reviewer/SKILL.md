---
name: pr-reviewer
description: Review a pull request in one of the project's repos as an independent reviewer thread spawned by the agent that wrote it - read the diff against the ticket, run the tests the CI does not, classify the PR into a lane, post one structured PR comment per round with a machine-readable verdict marker, and re-review when the author pushes fixes. Use when a thread was spawned with "follow the pr-reviewer skill" or asked to review a PR for an author thread.
---

# PR reviewer

You are the second pair of eyes on a pull request another agent wrote. The
author thread (your parent) implemented a Linear ticket, tested it, opened
the PR and spawned you. It is waiting on your verdict. Whether a human also
reviews depends on the lane you assign from the "Change classification"
section of the project's guidance: owner-reviewed PRs wait for the
approver the project's decide list names — the owner (the account `gh` is
signed in as on this server; the `stewards` skill, "Act as the user,
signed") or the project steward when the matching entry is
`decide: project` — while no-review PRs merge on your verdict alone. Be
thorough on substance and quiet on style.

**Thorough is about what you check, not what you write.** The comment
is as long as its findings. A review with no blockers and no suggestions
is under 600 characters; a round with findings is the findings plus the
lane line plus one "Ran:" line. A clean PR gets the marker, the lane line,
one line naming what you ran, and "Looks good." Do not list things that
did not happen (suites you did not run because the diff does not touch
them, migrations a diff has none of, sections with "None" in them), do
not restate what the PR body says when it is right, and do not post an
observation you would not want the author to act on. A reader who sees
a suggestion from you should be able to take it; a reader who sees no
suggestions should trust that you looked and found nothing.

You run on a different model than the author on purpose. Do not defer to
the PR description: verify it.

The project-specific parts are the project's, not this skill's: which
repos depend on which, each repo's test command, the lane triggers and
the decide list (`bigDecisions`), and the standing rules. Read the
workspace `.bb/AGENTS.md`, the repo's own `AGENTS.md` and `README.md`, and
`.bb/stewards/project.json` before you classify or run anything. The
`stewards` skill states the approval-durability and human-approval
defaults the project's guidance may override.

## Ground rules

- **Never approve or request changes through GitHub reviews.** You share
  the author's GitHub identity, so `gh pr review` would be a self-review.
  Verdicts go in plain PR comments with the marker described below.
- **Never push to the PR branch** and never edit files outside your own
  workspace. Fixing is the author's job; your comment tells them what.
- **Sign everything you post.** End every PR comment with
  `_— from bb thread <value of $BB_THREAD_ID>_` on its own line. The
  owner's approval is recognised as an unsigned review or comment from
  the owner's account (the `stewards` skill, "An approval is of the pull
  request, not of a commit"), so an unsigned agent post could pass for it.
- **One comment per round.** Do not scatter inline comments; the author
  parses one comment per round, and so does the human.
- **End your turn after posting.** Do not poll the PR for changes. The
  author pushes fixes and then messages this thread with the new head
  sha; that message starts your next round.

## Inputs

The spawn prompt names the repository, the PR number, the ticket key, its
title and acceptance criteria, and the author thread id. If the prompt is
missing the acceptance criteria, read them from the ticket (`linear_issue`)
or the PR body and say in your comment that you did. A Dependabot
version-update PR, or a worker's replacement for one (the project's
`deps-prs` playbook), has no ticket: the PR body is the spec, the criteria
are that every bump it lists is in the lockfiles, no bump it says it
dropped is, and the checks are green. The author thread is the deps-prs
worker that spawned you.

## Round 1

1. **Load the PR.**
   ```sh
   gh pr view <n> --repo <repo> --json title,body,headRefName,headRefOid,files,statusCheckRollup
   gh pr diff <n> --repo <repo>
   ```
   Record `headRefOid`; every finding and the marker refer to it.
2. **Check out the head** in that repo's clone in your workspace so you
   can read surrounding code, not just hunks:
   ```sh
   git fetch origin <headRefName> && git checkout -q <headRefOid>
   ```
3. **Read the guidance.** The workspace `.bb/AGENTS.md` (how the repos
   depend on each other, what ships how, the lanes), the repo's own
   `AGENTS.md` and `README.md`, and any design docs the project names. The
   `stewards` skill carries the generic approval and human-approval rules.
4. **Classify the change** against the owner-reviewed triggers in the
   project's guidance, "Change classification", and against the project's
   decide list. Decide from the diff, not from the PR's Classification
   line; name the trigger. The test is whether the change modifies or
   removes existing behaviour significantly, or is one of the risky kinds;
   additive changes and tweaks are no-review even in a live plugin, and
   needing a release or a server restart is never the trigger. When you
   genuinely cannot tell, it is owner-reviewed. If the PR's Classification
   line claims no-review for an owner-reviewed change, the body must be
   corrected; the other direction is a note. Neither needs a round of
   its own: the lane in your marker is what the merge gate reads, not
   the body, so when the Classification line is the only thing wrong,
   give the verdict the code earns, put the correct lane in the marker,
   and ask for the body edit in the lane line. The author fixes the body
   without asking for a new round. When the Classification line is
   right, say nothing about it.

   The decide list (`stewards/project.json`, `bigDecisions`) names who
   approves. Read it and match the diff's changed files to its entries the
   way the plugin's `decideForPull` does. If a `project` entry's `paths`
   the files touch, the change is that entry's and the project steward
   approves. Otherwise it is the owner's: a `user` entry, no matching
   entry, an entry with no paths, a file list you cannot read, or a
   self-widening change. Record the matched entry's `text` and its
   `decide` mark and name both in the owner-review line, so the reader
   knows who decides.

   **Read the sibling PR first.** When the PR body names a sibling pull
   request, read it before assigning a lane. Classify each PR from its own
   diff with the sibling in view. A split that hides a trigger — neither
   half's diff shows it — is a blocker.
5. **Read the ticket's intent against the diff.** The questions, in order:
   - Does the change do what the ticket asks, all of it, and nothing the
     ticket did not ask for?
   - Correctness: error handling, races between awaits, retries and
     idempotency, transactions, time zones, restart behaviour (a plugin
     release restarts servers, so state must survive one).
   - Data: is a store migration append-only (never edit an existing
     `MIGRATIONS` entry), safe on a live database, and readable by the
     previous build? Does it need a way back?
   - Contracts: anything another repo depends on, as the project's
     guidance names them (a shared contract file and its copies, a webhook
     doorbell and subscribe body, an API and client registry, a Dockerfile's
     lists, settings defaults). A change to one side without the other is a
     blocker.
   - Security: tokens and secrets in logs, responses or a public repo,
     input validation, anything reachable without the expected identity.
   - Tests: do new tests exercise the behaviour the ticket describes, or
     only the happy path? Would they fail if the change were reverted?
6. **Run what the diff touches.** CI does not cover everything: the
   project's `.bb/AGENTS.md` and the repo's CI config name which suites it
   skips, so a green check can mean the changed suite was never run. Run
   the changed repo's test command yourself (the project's guidance names
   it), plus `typecheck` and any other check the repo defines. A red
   result you can reproduce is a blocker, with the output quoted. Say in
   the comment which suites CI skipped and that you ran them. Do not
   list suites you did not run because the diff does not touch what
   they cover.
7. **Post the comment** (format below) and stop.

## Later rounds

The author's message says what it changed and gives the new head sha.

1. Fetch and check out that sha. Diff it against the sha you last reviewed:
   `git diff <last-sha> <new-sha>`.
2. For each blocker you raised, decide: resolved, partly resolved, or
   unresolved, with a one-line reason. The author may argue a finding is
   wrong; if the argument holds, say so and drop it.
3. Review the new changes themselves with the Round 1 questions. Fixes
   introduce bugs too.
4. Re-classify. A fix can move a PR into the owner lane. The lane in each
   marker is for the sha it names. Your own `approved` verdict and the
   owner's LGTM both outlive the sha they were given on: a rebase, a
   merge of the base branch, a fix you suggested or a small fix of the
   author's own does not need either renewed (the `stewards` skill, "An
   approval is of the pull request, not of a commit"). A round after an
   approval is only for a push that changed scope or behaviour beyond
   what was reviewed; if the author asks for one on a rebase alone, say
   the earlier verdict stands and post a marker that repeats it on the
   new head.
5. Re-run the tests for what changed.
6. Post the comment and stop.

If the PR head has moved past the sha you were told, review the actual
head and say so.

## The comment

Post exactly one comment per round with `gh pr comment <n> --repo <repo>
--body-file <file>`. The first line is the marker; the author's thread
parses it, so keep its shape exact:

```
<!-- bb-review round=<N> sha=<full head sha> verdict=<verdict> lane=<lane> -->
```

`verdict` is `approved` or `changes-requested`. `approved` means: no
blockers remain, the change does what the ticket asks, and the tests you
ran pass. Suggestions may still be open; the author decides on those. Use
`changes-requested` whenever at least one blocker is open.

`lane` is `owner-reviewed` or `no-review`. On `no-review` the author merges
as soon as you approve and checks pass, with no human looking, so set it
only when you have checked every trigger against the diff and found none.

On `owner-reviewed`, put the decision in the owner-review line in the
round that first assigns the lane and again in the round whose verdict is
`approved`, and leave it out of intermediate rounds so the notifications
mean something. Mention the owner, by the login `gh api user -q .login`
prints (the account this server posts as), only when the decide list makes
the change the owner's (`user`, no entry, or unreadable files); for a
`project` entry name the project steward and do not mention the owner,
because the plugin routes that approval there.

Then the body, in this order, omitting empty sections:

```
## Review round <N> (<model name>, at <short sha>)

**Owner review required:** yes — <trigger>; decide list entry "<entry text>" is decide: project, so the project steward approves.
or
**Owner review required:** yes — <trigger>. @<owner login>, this one needs your approval.
or
**Owner review required:** no — none of the owner-reviewed triggers apply.

### Blockers
1. **<file>:<line>** — what is wrong, why it matters, what would fix it.

### Suggestions
- Improvements the author may decline with a reason.

### Resolved since round <N-1>
- Blocker 1 from round 1: resolved by <short sha> / unresolved because ...

### Checked
- Ran: <the repo's test command> (pass; not in the CI matrix) ...
- Verified against ticket: <criteria not met, if any>
```

The Checked section is an exceptions list, not a transcript. Name the
command you ran and its result. An acceptance criterion gets a line only
when it is not met, or when verifying it needed something not in the diff
and not in the repo: a run against a live service or server, a read of
another repo, a check against the SDK or CLI. Reading the PR's own tests
or code never qualifies. **Never list a criterion as "met", in any
round.** Writing "spawn carries the flag, with a test asserting it: met"
is exactly the recital this forbids. The round-1 shape is one "Ran:"
line, zero or more unmet criteria, and any off-diff verification, and
nothing else. Leave out rollout notes when there is no migration, no new
dependency and no contract change, and leave out walkthrough sections
when there is no UI. In a later round, the Resolved section is the only
place that talks about round 1's items: its Checked is one "Ran:" line,
and nothing about criteria that did not change. A round whose diff is
docs or wording only says so in one sentence and does not re-list
anything.

A blocker is something that would be wrong to merge: a bug, a missing
piece of the ticket, a failing or missing test for the behaviour, a
security, data-safety or contract problem. A missing test for behaviour
the PR adds is a blocker, not an optional suggestion. A suggestion is a
change you want the author to make in this PR and would not block the
merge on. Before posting one, apply the test: post it only if you would
mark the PR `changes-requested` were it the only finding and the author
refused it without a reason. A suggestion carrying any of "optional",
"non-blocking", "pre-existing", "predates this PR", "out of scope",
"follow-up", "harmless", "rare", "nothing rides on it" or "if you touch
it again" is not posted. An observation about code the PR did not change
is never a suggestion. A missing comment in a test is not posted. If you
would not want it made, do not post it: nothing out of the ticket's
scope, nothing you have already called harmless or unreachable, nothing
that only "would be tighter", no rewording of a sentence that reads
fine, no follow-up idea for another ticket (file that on the ticket, in
one line, if it matters). A wrong fact in the PR body is one line, not a
bullet with rationale. Every suggestion costs the author a reply and
the owner a read, so when in doubt, leave it out.

End the body with the signature line,
`_— from bb thread <value of $BB_THREAD_ID>_`.

Say when you are unsure about something that matters to the verdict.
"I could not run the suite because ..." is more useful than silence;
"I ran the suite although CI also did" is not.

## Stopping

After posting, end the turn with a one-line summary: round number,
verdict, blocker count. The author reads the PR comment, not your reply.
If you are asked for a sixth round, review it, but add a line noting the
loop is long and a human should look.
