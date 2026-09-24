See the work you have in flight, grouped by the ticket it belongs to rather
than by the repository it happens to live in.

## What you get

- A **Workstreams** page in the left sidebar: a board of workstreams,
  each holding the ticket clusters under it, each cluster holding one card per
  checkout.
- A colored status chip per cluster — blocked, ready, in review, drafting,
  local, merged, or closed — rolled up from its most urgent checkout.
- A `bb workstreams` command that reads the same board from a terminal and
  names a cluster's workstream.

## How it works

The plugin scans every git checkout under its configured scan roots, reads each
one's branch, upstream position, and pull request state, and clusters them by
the ticket key in the branch name. One ticket often spans several
repositories; that cluster is the thing nothing else in the toolchain shows.

Everything stays on your machine. Pull request state comes from your own
authenticated `gh`; without it the board falls back to local git state. An
optional Linear API key resolves each ticket to its project name so workstreams
name themselves.

## For agents

The bundled skill tells an agent to read the board with
`bb workstreams list [--json]`, rescan with `bb workstreams refresh`, and name a
cluster's workstream with `bb workstreams group <TICKET> <name>`.
