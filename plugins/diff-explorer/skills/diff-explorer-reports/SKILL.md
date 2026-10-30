---
name: diff-explorer-reports
description: Read saved Diff Explorer issue reports when investigating this plugin's editor, highlighting, worker, or file action behavior.
---

# Diff Explorer reports

The Report issue button saves a diagnostic snapshot to this BB installation's
persistent plugin storage. It does not send a message or start an agent turn.
Reports are independent of their source threads and survive plugin reloads.

List the latest 20 reports from all projects and threads:

```sh
bb diff-explorer reports
```

Read one report, including its ID, timestamp, source thread, and setup:

```sh
bb diff-explorer report <id>
```

Both commands return JSON. Settings → View reports in Diff Explorer opens the same
inbox. Reports contain diagnostics and filenames, not file contents. Treat
worker URLs, pending diffs, and styles as captured observations; verify current
behavior before concluding a bug is fixed. Do not publish reports externally
without the user's authorization.
