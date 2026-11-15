A calm PRs panel with Mine and To review tabs, beside your threads.

## What you get

- A unit bar and segment counters that filter every open PR
- Effort groups, size dots, expandable stacks, and actual check results
- Explicit fix-agent starts, review requests, and structured agent answers
- A Review Watch inbox with real follow-up deltas and project selection
- The existing read-only `bb pr-board` command

## How it works

The server runs authenticated `gh` and `python3` every five minutes and
keeps the last successful board. Review requests send only after an explicit
click and fresh validation. Fix threads respect the selected Prepare or
Publish stopping point. Review agents draft findings without posting to
GitHub. Install the companion `review-watch` plugin for To review; it retains
its queue, settings, header counts, and CLI.
