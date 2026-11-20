# Where did the package go?

Submitting a draft PR starts a review. It does not publish a release or install anything.

In **Performance**, choose a solution to see its recorded submissions, including submissions under retained aliases. Leave **All solutions** selected to see the full ledger. Loading this view reads local records; it does not contact GitHub.

Choose **Check publication** to make a fresh read from GitHub using the server’s existing `gh` login. Only configured `publicationRepositories` are allowed. You can also supply an exact release tag. This action reads status and package contents; it does not merge, create a release, list a package or install it.

## Four separate facts

| Fact | What the check establishes |
| --- | --- |
| Submission | A package was prepared or submitted for review. A legacy internal `published` label is treated as a submission. |
| Review | The PR is open, closed without merging, merged, or currently unconfirmed. A changed PR head is shown separately. |
| Package at merge commit | Every expected file, its content and mode match the reviewed package, with no extra files in its directory. This describes the immutable merge commit, not the repository’s current branch. |
| Release tag | The named release is published and its exact tag resolves to a commit containing the reviewed package. Draft releases and prereleases remain labeled. |

A merged PR can contain changed package files. A release can exist without containing the reviewed package. Each outcome stays separate rather than being collapsed into a single “published” badge.

## Keep the history

Each check appends an observation with its time and exact commit when available. **Show recorded history** reads those saved observations. An unavailable response remains unconfirmed; it does not erase an earlier successful check. Earlier evidence describes what was observed then, not a guarantee that the current remote state is unchanged.

If a repository is removed from the allowlist, saved history stays readable, but new remote checks are refused. Restore access deliberately before checking again.

These checks report what happened to a submission. They do not install anything or confirm that a fix works elsewhere.
