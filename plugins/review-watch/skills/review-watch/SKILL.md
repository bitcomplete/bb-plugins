---
name: review-watch
description: Read the GitHub review queue and start work on a queued item. Use when the user asks what needs their review, what pull requests are waiting, which reviews are outstanding, or asks to start or dismiss a queued review.
---

# Review watch

Review Watch owns one durable queue of pull requests that need the user's
attention. A background poller asks GitHub every few minutes. Install PR Board
alongside Review Watch for the unified **PRs → To review** inbox. The
`bb review-watch` command reads the same queue and works without PR Board.
The thread header keeps initial-review and follow-up counts in separate chips,
including zeros, and links to **To review**.

The queue is notify-only. Review Watch never posts to GitHub or starts a
thread on its own. A human chooses **Start**, **Review selected**, or
`bb review-watch start`.

## Commands

| Command | Effect |
| --- | --- |
| `bb review-watch list` | Show the queue, grouped by rule, with each item's key. |
| `bb review-watch list --rule <rule>` | Show one group. |
| `bb review-watch start <key>` | Spawn a thread for one item and print the thread id. |
| `bb review-watch dismiss <key>` | Drop one item from the queue. |
| `bb review-watch poll` | Run one poll now and print what changed. |
| `bb review-watch status` | Show configuration, the last poll, and queue counts. |

Add `--json` to any command when the output drives code.

A key looks like `<rule>:<node-id>:<head-sha>`. Every command that takes a key
accepts any unambiguous prefix, so paste the first few characters rather than
the whole string.

## Rules

Each item carries one rule, which says why a human must act:

- `review-requested` — someone requests the user's review, and the user has not
  submitted a review on the pull request.
- `review-followup` — the user submitted an earlier review, and a newer head or
  explicit re-request needs the user's attention.

The user's own pull requests never enter the queue. For feedback on them, use
Workstreams, which shows it as **Your turn**.

## Authentication

The poller reads GitHub one of two ways, and `bb review-watch status` prints
which one is active:

- `transport: token` — the `githubToken` setting holds a personal access token.
  The token travels with the plugin's configuration, so this route suits a BB
  server on a remote host.
- `transport: gh` — `githubToken` is empty, so the poller shells out to `gh` and
  reuses the login it already holds. This route needs `gh` installed and
  authenticated on the host the BB server runs on, not on the user's laptop.

A thread started from a review item reads the pull request's diff and review
comments through `gh` under either route, so `gh` auth on the BB server host
matters even when the poller uses a token.

## Procedure

1. Run `bb review-watch list` before you act. Use the keys it prints; never
   guess a key.
2. To work an item, run `bb review-watch start <key>`. The repository's GitHub
   organization mapping selects the project, falling back to the default BB
   project. The thread uses that project's default checkout on its registered
   machine. Find the matching repository checkout before inspecting code.
3. Report the thread id the command prints so the user can follow it.
4. Dismiss an item only when the user asks. Dismissing hides it for good; there
   is no undismiss in the CLI.
5. If `list` looks stale, run `bb review-watch poll` instead of waiting for the
   next tick.

In **PRs → To review**, select queued review requests and follow-ups, then choose
**Review selected** to choose a project and open one aggregate review thread.
Organization mappings preselect the project. Mixed-project selections require
an explicit choice. **Start** opens the same picker for an individual review.
Canceling starts nothing. The batch action does not have a CLI command.

Queued items need a review. Started items link to reviewer threads; the unified
inbox uses current BB thread state to distinguish active work from stopped
threads. Only a validated final `review-watch-result` block marks a completed
draft. Do not infer completion from an idle thread or prose.

A submitted review newer than the item's baseline, a new head, or a closed pull
request archives the previous item. **Back with authors** requires current
GitHub review evidence, not an archive state alone. Dismissed items stay hidden.

Follow-up details compare the last submitted review's commit with the current
head. If the baseline or exact comparison is unavailable, report an unknown
delta. Never substitute the full PR diff. Resolution counts include only review
threads in which the user participated.

## Constraints

- Never post to GitHub on the user's behalf. In a thread started from a review
  item, present findings for the user to post: do not submit a review, approve,
  request changes, comment, or resolve a review thread.
- Never push code from a review thread. Present findings and next actions in
  the thread for the user.
- Change the queue only through `bb review-watch`. Do not edit bb.db or the
  plugin's storage directly.
- An empty queue with a failed `last poll` in `bb review-watch status` does not
  prove that no reviews need attention. Read the poll error. For transport
  failures, the error names the fix: set `githubToken` or authenticate `gh` on
  the BB server host. Tell the user what to run; do not set the token or run
  `gh auth` yourself.
- GitHub searches paginate through all matching pull requests. If nested
  review data is truncated, the poll fails and leaves the queue unchanged.
  Surface the poll error instead of treating partial data as a complete queue.

## Settings

Configure with `bb plugin config review-watch`:

| Setting | Meaning |
| --- | --- |
| `githubToken` | A personal access token with `repo` scope. Optional: when it is empty, the poller reads GitHub through the `gh` CLI instead. |
| `project` | Default BB project for organizations without a mapping. Optional when a project is chosen through the picker. |
| `organizationProjects` | JSON object mapping GitHub organization names to BB project IDs. Organization names ignore case. Defaults to `{}`. |
| `pollMinutes` | Poll interval in minutes. Defaults to 5. |
| `repoAllowlist` | Comma-separated `owner/name` entries. Empty watches every repository. |
| `maxAgeDays` | Drop an item this old even if GitHub still lists it. Defaults to 14. |
| `provider`, `model` | Optional. Passed through when a review thread spawns. |
