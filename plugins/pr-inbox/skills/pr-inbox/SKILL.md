---
name: pr-inbox
description: Read the Your turn list in My PRs, refresh GitHub feedback, dismiss rows, or start a thread to address selected PRs.
---

# My PRs

Use `bb pr-inbox list --json` for the current snapshot and
`bb pr-inbox poll --json` for fresh GitHub state. `status` reports the last
poll and its error. PR ids come from each row's `id` field. `holdUntil` is null for active rows or
the ISO timestamp when a temporary hold ends. Held rows are excluded from
Your turn counts and cannot be dispatched until resumed or expired.

Your turn includes human feedback on the authenticated user's authored PRs.
Bots alone never add a PR. A push answers changes requested, but comments and
approval notes need a reply. Drafts count. Workstreams is not required.

- `dismiss <id>` hides a PR until new commits or human feedback.
- `restore <id>` brings dismissed feedback back.
- `address <id>...` starts one thread for 1–20 distinct PRs. It refreshes and
  checks that each still needs your response. Organization mappings choose the
  project, falling back to the default; mixed destinations require an explicit
  project through the page's picker. Threads use that project's default checkout
  and enrolled machine. Use only when the user asks to
  address that feedback. The thread may edit, push code, and reply on GitHub.
  Its prompt forbids merging, approving, closing PRs, and automatic resolution.
- `clear <id>` permits another attempt after its thread is idle or failed.
  For an interrupted or ambiguous start, check the existing threads first.
  Clearing retains the thread in BB.

Never dispatch automatically, clear a working thread's link, or treat a cached
row as current after a failed poll. The plugin stores GitHub tokens as secrets;
read them only through the plugin's configured transport, never print them.
