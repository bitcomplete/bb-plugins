## Your pull requests waiting on you

PR Inbox shows the human feedback on your authored PRs that still needs a
response. Every row says why: an approval note, a change request, a comment,
or an open thread where another person spoke last. Bot feedback alone does
not add a PR. Drafts stay visible when a person is waiting.

Dismiss a PR until new commits or human feedback arrive. Restore it from the
dismissed list whenever you want. Refresh manually or let the background poll
keep the page current. Failed reads display an error and retain the previous inbox.

## Address comments

Start a thread for one PR or select up to 20 and address them together. The
thread finds the relevant checkout, fixes code, runs checks, pushes changes,
and replies to comments. It addresses bot comments too. Its instructions forbid
merging. The plugin starts no work automatically and only reads GitHub itself.
Started PRs keep their thread links after the feedback clears.

## Requirements

Use the BB server's authenticated GitHub CLI or configure a secret GitHub token.
Choose a BB project whose default environment has the repository checkouts for
Address threads. Optional provider and model settings override that project's
defaults. Agent work uses the configured provider account.

PR Inbox runs independently of Workstreams. Review Watch is its companion for
PRs where someone else needs your review.
