## Your open pull requests

My PRs lists your open PRs and highlights human feedback that still needs a
response. Rows show review status, conflicts, CI failures, or the reason someone
is waiting: an approval note, a change request, a comment, or an open review
thread. Bot feedback alone does not put a PR in Your turn.

Dismiss a PR until new commits or human feedback arrive. Restore it from the
dismissed list whenever you want. Refresh manually or let the background poll
keep the page current. Failed reads display an error and retain the previous PR snapshot.

## Start a PR thread

Select any listed PR, or use organization, area, and state checkboxes to group
up to 20 into one thread. Selections persist across state filters. Approved,
conflicting, draft, held, dismissed, and previously threaded PRs are selectable.
The thread addresses outstanding comments, resolves conflicts, and fixes CI.
It verifies readiness when no changes are needed. Its instructions forbid
merging. The plugin starts no work automatically and only reads GitHub itself.
Started PRs keep their thread links after the feedback clears.

## Requirements

Use the BB server's authenticated GitHub CLI or configure a secret GitHub token.
Choose a BB project for PR threads. Projects with a repo set provision a
fresh Multi-repo workspace on their default machine; other projects use their
default checkout. Optional provider and model settings override that project's
defaults. Agent work uses the configured provider account.

My PRs runs independently of Workstreams. Review Watch is its companion for
PRs where someone else needs your review.
