See work across repositories by ticket and by the action it needs next.

## Explore and act

- **Map:** Explore ticket clusters within named efforts, programs, and domains.
  Levels collapse when they add no useful grouping. Switch between theme and
  risk, filter by status or code surface, and open linked agent threads.
- **Board:** Group checkouts by Action or Effort while keeping urgent work first
  within each group. Find CI fixes, review responses, merges, and reviewer
  nudges. Confirm direct GitHub actions, or review a prompt before an agent
  starts work in a dedicated thread.
- **CLI:** Run `bb workstreams list [--json]` to read the board, `bb workstreams
  refresh` to rescan, and `bb workstreams group <TICKET> <name>` to set an effort
  name.

Workstreams scans your configured git checkout directories. It finds ticket
keys in branches, pull requests, Linear linkback comments, and directory names,
then joins checkouts for the same ticket. An authenticated `gh` supplies pull
request state; without it, the board reports a warning, shows observed local
git activity, and marks unverified checkouts. The board uses local release tags
to identify merged commits in a release; that does not prove a production
deployment.

## Optional services

You can use the board without model keys. A Linear key adds ticket details and
team names. A TypeSafe key lets Jev select ticket summaries and assign related
tickets to groups. With Jev enabled, an Anthropic key lets Claude Sonnet 5 name
those groups and flag mixed ones. Anthropic does not change group membership.

Board facts and caches live in BB's local plugin storage. Workstreams uses your
authenticated `gh` for GitHub reads and confirmed actions. When configured, it
sends ticket identifiers to Linear; Jev receives ticket, repository, pull
request title, and available Linear context; Anthropic receives group members,
summaries, repository names, and available Linear or linked-thread context for
naming. Unchanged semantic inputs reuse cached model decisions.
