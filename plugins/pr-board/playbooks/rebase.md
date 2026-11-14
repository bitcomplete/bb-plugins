# Resolve conflicts on ${repo_name} PR #${number} (${short_title})

PR: ${url} (branch `${branch}`, base `${base}`, head `${head_oid}`). Area: ${area}. Gates: ${gates}

Why: ${conflict}

## The work
1. Bring the branch up to date with `origin/${base}` using a merge commit, not a rebase or force-push, so reviewed commits stay intact. If the base branch is gone, stop and report which branch the PR should target instead of retargeting it yourself.
2. Before resolving, find which commits on `${base}` touched each conflicted file since the merge base (`git log <merge-base>..origin/${base} -- <file>`) and read them, so you understand both sides' intent. Keep both behaviors. Do not drop either side's change to make the conflict go away. If the two sides genuinely contradict each other in behavior, stop and report instead of choosing.
3. Run the affected app's unit tests, typecheck, lint and format check, plus focused tests for the conflicted code.
4. The resolution is new code no human has reviewed: give the Sol reviewer `git diff` of each conflicted file against both parents, plus the PR diff.
