# Fix CI on ${repo_name} PR #${number} (${short_title})

PR: ${url} (branch `${branch}`, base `${base}`, head `${head_oid}`). Area: ${area}. Gates: ${gates}

Failing checks when this thread started:
${checks}

## The work
Read the log of every failing check on the current head (`gh run view --log-failed`, or the check's details URL) before changing anything. Do not call a failure a flake without reading its log; when it really is unrelated to this PR, say so with the evidence and rerun only that job. Reproduce each real failure locally, fix the cause rather than the symptom (never skip, delete or weaken a test to make it pass), and run the same command locally until it passes. If a listed gate explains the failure (for example a schema that staging does not serve yet), report that instead of working around it.
