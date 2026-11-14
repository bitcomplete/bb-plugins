---
name: pr-board
description: Read the plain-language board of the user's open GitHub PRs (ready to merge, needs you, waiting on a reviewer, drafts) or force a refresh.
---

# PR board

- `bb pr-board` prints the stored board as text: a summary line, then each
  section with its PRs, one sentence per PR, and any "Blocked by" line.
- `bb pr-board --json` prints the view model: `fetched_at`, `summary`,
  `suggestions` (`{id, text, action, keys}`), `trains` (stacks of 2+ PRs in
  merge order), `sections` → `groups` → `rows`, and `reviewer_load`. Each row
  has `key`, `number`, `url`, `area`, `tone`, `title`, `sentence`, `blocked`,
  `depth` (stack nesting), `after` (an open parent shown elsewhere),
  `reviewers` (`{name, state}`: requested, approved, approved_old, changes),
  `size` (`{lines, files, bar, label}`), `stack` and `action` (fix-feedback,
  rebase, fix-ci, or null).
- `bb pr-board refresh [--json]` fetches from GitHub now (about 10–60 seconds)
  and exits 1 when that run failed. A failed run keeps the last good board.

The backend refreshes on load and every 5 minutes, using `gh` and `python3`
on the bb server host. The CLI is read-only. Starting agent threads happens
only from the panel's Start buttons, after the user confirms; never start
them on the user's behalf through the plugin's RPC.
Dependencies GitHub cannot see live in `gates.json` in the plugin directory;
edit that file only when the user asks.
