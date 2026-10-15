---
name: diff-explorer-commits
description: Review and finish a commit job started by Diff Explorer's check mark toolbar buttons. Use when a commit agent prompt supplies a Diff Explorer job ID.
---

# Diff Explorer commit jobs

The toolbar creates the job, fixes its selected paths and push permission, and starts a Claude Haiku agent in the same environment. **✓** authorizes a local commit. **✓✓** also authorizes pushing the current branch to the same branch name on its configured push remote, falling back to `origin` when none is configured. Neither command accepts a push override.

Read the snapshot before reviewing:

```sh
bb diff-explorer commit-review <job-id>
```

The JSON response contains `paths`, `branch`, `push`, and the complete `diff`. Review the entire diff, relevant code, and repository instructions. Run applicable repository checks. Stop if there is a blocker. Re-reading a successful review returns the same snapshot; it does not approve newer edits. Large diffs are rejected rather than truncated.

Write a UTF-8 commit message to an absolute file path in the checkout or, preferably, the checkout host's temporary directory. Both the host's per-user temporary directory and `/tmp` (including Claude's `/tmp/claude-<uid>`) are accepted. Use one concise subject sentence, a blank line, then two or three sentence bullets explaining why the changes were made. Never include `Co-Authored-By` or AI attribution. Use a quoted heredoc or a file-writing tool.

Finish once:

```sh
bb diff-explorer commit-finish <job-id> --message-file /absolute/path/to/message.txt
```

The file is read on the checkout's host, including for remote environments. The helper verifies HEAD, branch, logical index state, and selected content against the reviewed snapshot. It uses temporary indexes and an exclusive real-index lock, preserves unrelated staging, and runs existing repository hooks through guards that reject changes to the selected content, commit tree, or message. It does not reset or discard working files, including edits left by a failed hook.

The result contains `commit`, `pushed`, and `error`. Failure has a nonzero exit code. A push failure or a post-commit hook failure may leave a local commit; report its hash and the error. Finishing is consumed before host dispatch, so retrying cannot silently create another commit after a lost connection. Failed jobs require a new toolbar click and review. Inspect an interrupted Git operation before starting again; never delete an index lock automatically.

Do not run staging, commit, reset, stash, checkout, branch switching, pull, rebase, or push commands yourself. Do not invent snapshot checks, rollback scripts, or retries. Only the helper performs Git mutations. Read-only Git commands and repository checks remain available.

The helper requires a repository-root workspace and individual file paths. It refuses detached HEAD, conflicts, and an in-progress merge, rebase, or cherry-pick. Initial commits and linked worktrees are supported. This is a content consistency check, not proof that the changes are correct; report only the review and checks actually performed.
