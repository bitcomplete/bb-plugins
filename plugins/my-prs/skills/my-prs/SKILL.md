---
name: my-prs
description: Read open PRs and the Your turn list in My PRs, refresh GitHub feedback, dismiss rows, or start a thread to address selected PRs.
---

# My PRs

Use `bb my-prs list --json` for the current snapshot and
`bb my-prs poll --json` for fresh GitHub state. `status` reports the last
poll and its error. PR ids come from each row's `id` field. `holdUntil` is null for active rows or
the ISO timestamp when a temporary hold ends. Held rows are excluded from
Your turn counts but can be explicitly selected for a thread.

Your turn includes human feedback on the authenticated user's authored PRs.
Bot feedback alone never puts a PR in Your turn. A push answers changes requested, but comments and
approval notes need a reply. Drafts count. Workstreams is not required.

- `dismiss <id>` hides a PR until new commits or human feedback.
- `restore <id>` brings dismissed feedback back.
- `address <id>...` starts one thread for 1–20 distinct PRs. It refreshes and
  checks that each remains open and its observed head and activity are current.
  Any listed PR can be selected, including approved, conflicting, waiting, draft,
  held, dismissed, and previously threaded PRs. Organization mappings choose the
  project, falling back to the default; mixed destinations require an explicit
  project through the page's picker. Threads use that project's default machine.
  A configured repo set selects a fresh Multi-repo workspace; other projects use
  their default checkout. A repo-set read failure stops dispatch. Use only when the user asks to
  start work on those PRs. The thread may edit, push code, and reply on GitHub.
  It addresses outstanding feedback, merge conflicts, and CI failures, or reports
  readiness when no changes are needed. Selecting a previously threaded PR
  starts a new thread and updates its link. An in-progress or ambiguous start
  must finish or be cleared before retrying.
  Its prompt forbids merging, approving, closing PRs, and automatic resolution.
- `clear <id>` permits another attempt after its thread is idle or failed.
  For an interrupted or ambiguous start, check the existing threads first.
  Clearing retains the thread in BB.

Never dispatch automatically or use `clear` while its linked thread is working.
Never treat a cached row as current after a failed poll. The plugin stores GitHub tokens as secrets;
read them only through the plugin's configured transport, never print them.
