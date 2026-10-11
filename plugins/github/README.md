# GitHub

Let a thread watch a pull request or issue and be woken when it changes,
as the developer.

There is no connect step of its own. The [Team setup](../team-setup)
checklist signs `gh` in on the server host, bb core forwards that login to
every machine as `GH_TOKEN`, and this plugin reads the same token with
`gh auth token` whenever it needs one. Everything else a thread wants from
GitHub it already does with `gh` on its machine: reading a PR, commenting,
requesting review, merging. What `gh` cannot do is wake a thread later.
That is the whole of this plugin.

## Tool

| Tool | What it does |
|---|---|
| `github_watch` | Watch a pull request or issue by URL, `owner/repo#12` or `owner/repo/pull/12`: the thread is messaged when it changes or someone else comments. Needs `BB_HOOKS_URL`. |

## Watching a pull request or issue

A thread that has nothing to do until a PR moves (a review it asked for,
checks it is waiting on, a question it asked in a comment, an issue it is
blocked on) calls `github_watch` and ends its turn. When the target
changes, the thread is sent a message describing the change and a new
turn starts, or the running turn is steered if one is live.

What "changes" means: a different state (open, draft, closed, merged; a
closed issue carries its reason), review decision, requested reviewers,
each reviewer's latest review, the checks rollup (pending, success,
failure) and which checks are failing (with their links), the head branch
and its tip (a push is one line with the new short sha), the base branch,
title, labels, assignees or milestone, each reported as `old → new`; and
new comments, reviews and inline review comments by anyone, with author,
what they did (commented, approved, requested changes, commented on
`path`) and body (long bodies trimmed). One message carries everything
since the thread last looked, however many webhooks it took.

A thread's own comments: `gh` comments as the developer, so the plugin
cannot tell a thread's comment from the developer's by author. The skill
asks a thread to end any comment it posts with
`_— from bb thread <id>_`; a comment carrying the watching thread's own
line is left out of its wake, and one carrying another thread's line is
a real comment. A comment the thread posts without the line wakes it
once, harmlessly.

How it wakes: the plugin keeps a durable watch per thread and target in
its SQLite (what it last saw, and cursors on `updatedAt` and the newest
comment), and subscribes to
[bb-gate-hooks](../../bb-gate/docs/hooks.md), the one public endpoint
that receives GitHub's webhooks. It proves each watch with the
developer's own token, renews the lease every 30 minutes, and when the
service rings for a target it re-reads it as the developer with one
GraphQL query, compares it with the snapshot, and messages the thread
only if something is new. A doorbell is a latency optimization, not the
source of truth: every watch is also re-checked when the stream connects,
after a renewal that failed or ran late, every ten minutes while leased,
and every two minutes while the service is unreachable. That ten-minute
re-check is also how a watch learns of things GitHub's webhook does not
tie to a pull request: commit statuses (as distinct from check runs) and
checks on a pull request from a fork. If GitHub refuses the token, the
plugin re-reads it from `gh` and retries once. Nothing is ever reported
twice.

Limits and cleanup: ten watches per thread; the eleventh is refused.
Watching the same target twice is a no-op. A watch expires a week after
it last woke the thread (or was created). Archiving or deleting the thread
drops its watches, as does a wake that finds the thread gone. If the
target stops being visible to the signed-in user, the thread is told once
and the watch is dropped. There is no unwatch tool and no UI.

`BB_HOOKS_URL` is the cluster-internal address of bb-gate-hooks
(`http://bb-gate-hooks.bb-gate-production.svc:8081` in bb-gate's backend
template). It is read from the server's environment only; there is no
setting. Without it, `github_watch` returns an error saying watching is
not available on this server, no background service is started, and
nothing else changes. There is deliberately no polling fallback: reading
the PR again later with `gh` is what the agent would do anyway.

The webhook itself is configured once per GitHub organization, by hand,
on bb-gate's side; `bb-gate/README.md` ("The hooks service") has the
steps and the event list.

## Development

```sh
npm install --include=dev --legacy-peer-deps
npm run typecheck
npm test
```

`github.ts` is the GraphQL document and its parsing; `watch.ts` the
snapshot, the diff, the wake message and the SQLite store;
`hooks-client.ts` the subscriber side of bb-gate-hooks, the same as the
linear plugin's with the source changed; `gh.ts` reads the token;
`server.ts` wires them to bb.
