See what needs your review on GitHub, and open a thread to work it when you
choose to.

## What you get

- A **Reviews** page in the left sidebar, grouped into pull requests that need
  your first review or a follow-up after a new commit or re-request. Feedback
  on your own pull requests appears in Workstreams as **Your turn**.
- A **Start** button on each row that opens an individual BB thread with a
  prompt written for that kind of work.
- Queued and started review items stay in their action sections and remain
  counted. Started rows link to their open threads and stay pending until a
  GitHub poll confirms a submitted review newer than the item's baseline. A new
  head supersedes an item; a closed or merged pull request ends its pending
  status.
- Completed or superseded reviewer threads move to **Archived threads** at the
  bottom, where they remain available. Dismissed items do not appear.
- Checkboxes for queued review requests. **Review selected** opens one aggregate
  review thread.
- A `bb review-watch` command that reads the same queue from a terminal.
- The **Reviews** navigation badge shows the total number of pending initial
  reviews and follow-ups. It uses a warning tone when follow-ups are waiting
  and clears when the queue is empty. The thread-header badge shows
  `review-requested` and `review-followup` counts in two colored chips,
  including zeros. Hover over the header badge to see labeled counts, preview
  up to five review requests, or open the full **Reviews** page. Live updates
  keep the list current without a reload.

## How it works

A background poller asks GitHub every few minutes what needs your attention and
stores a deduplicated queue in this plugin's own storage on the BB server.
Dismissing an item survives later polls. Starting a review keeps it pending
until GitHub confirms a submitted review newer than the item's baseline. A new
head supersedes the item, and a closed or merged pull request ends its pending
status. The queue moves completed or superseded items to **Archived threads**.

GitHub searches paginate through all matching pull requests. If nested review
data is truncated, the poll reports an error and does not update the queue from
partial data.

Started review threads use the configured project's default environment. The
agent finds the matching repository checkout before inspecting code.

Review Watch reads GitHub and never writes to it. It also never starts a thread
on its own: the queue notifies, and you decide what to work. A thread started
from a review item presents its findings to you for posting rather than
submitting a review itself.

## What you need

A BB project to run reviews in, and one of two ways to read GitHub:

- A personal access token with `repo` scope, set as `githubToken`. The token
  travels with the plugin's configuration, which suits a BB server on a remote
  host.
- The `gh` CLI, used when `githubToken` is empty. It reuses the login `gh`
  already holds, and needs `gh` installed and authenticated on the host the BB
  server runs on.

Set the project and the token with `bb plugin config review-watch`.

Either way, a thread started from a review item reads the pull request through
`gh`, so keep `gh` authenticated on the BB server host even when the poller uses
a token.

## For agents

The bundled skill tells an agent to read the queue with `bb review-watch list`,
start one item with `bb review-watch start <key>`, and never post to GitHub or
push code on your behalf.
