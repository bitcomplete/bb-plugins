A plain-language board of your open GitHub pull requests, beside your threads.

## What you get

- A one-line summary, then **Ready to merge**, **Needs you** (fix review
  feedback, fix CI, rebase, ask for a review), **Waiting on a reviewer** (by
  person), **Drafts**, and **Other repositories**.
- One sentence per PR, plus a "Blocked by" line for dependencies GitHub cannot
  see.
- A **PR board** tab in every thread's side panel and a **PR board** sidebar
  page. Clicking a PR number opens it in bb's side panel.
- A `bb pr-board` command that prints the same board.

## How it works

The bb server runs `gh` and `python3` every 5 minutes and keeps the last good
board. The plugin only reads GitHub; it never changes a PR.
