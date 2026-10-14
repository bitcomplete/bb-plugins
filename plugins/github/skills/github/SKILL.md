---
name: github
description: Wait for a GitHub pull request or issue to change (a review, checks, a merge, a comment) from a bb thread with github_watch instead of polling with gh, and sign comments so the watch can tell your own apart.
---

# GitHub

This bb server is signed in to GitHub as the user, and `gh` on the
machine carries the same login. Read, comment, review, request review,
open and merge with `gh` as usual. The `github` plugin adds one thing
`gh` cannot do: wake this thread when a pull request or issue changes.

## Waiting on a pull request or issue

When there is nothing to do until a PR or issue moves, do not poll it
with `gh pr view` or sleep in a loop. Call `github_watch` with its URL
(`https://github.com/owner/repo/pull/12`), `owner/repo#12` or
`owner/repo/pull/12`, say in your reply what you are waiting for, and
end the turn. The plugin wakes this thread with one message naming the
target, each changed field as `old → new` (state, review decision,
reviews, requested reviewers, checks and which are failing, head commit,
labels, assignees, title), and any new comment, review or inline review
comment with its author, what they did, and body. Typical moments: you
opened a PR and the next step is a reviewer's; checks are running and
you will act on the result; you asked a question in a comment; your work
is blocked on an issue someone else owns.

The tool does not read the PR for you; use `gh` for that before and after.
Watching the same target again is harmless. A thread can watch ten; a
watch that has not fired in a week is forgotten, so watch again if you
are still waiting. If the tool answers that watching is not available on
this server (no `BB_HOOKS_URL`), tell the user you cannot be woken and
will check when they next send a message; do not poll.

## Sign your comments

`gh` comments as the user, so the plugin cannot tell your comment from
theirs by author. End every comment or review you post with a line
naming this thread, on its own line after a blank line:

```
_— from bb thread <this thread's id>_
```

A comment carrying this thread's line is left out of its wakes; one
carrying another thread's line is a real comment. The thread id is the
one in `BB_THREAD_ID` on the machine, or `bb status`.

## Not signed in

If the tool says GitHub is not signed in on this bb server, the user has
to sign in from the GitHub row of the Team setup checklist on the home
page (a device-code `gh auth login` on the server). An agent cannot do
that. `gh` on the machine is signed in the same way, so if `gh` works
here, the server is signed in too.
