# My PRs

My PRs shows human feedback waiting on your authored pull requests. It is a
standalone sibling of Review Watch, whose Reviews page shows requests for your
review of other people's PRs. My PRs does not require Workstreams.

## Install and configure

Install the plugin from the collection:

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@bb/pr-inbox-from-workstreams --plugin pr-inbox --yes
bb plugin config pr-inbox set project <project-id>
bb plugin reload pr-inbox
bb pr-inbox poll --json
```

Open **My PRs** in the sidebar. The first successful refresh shows your open
PRs. By default, the poller uses the BB server's authenticated `gh`. If that
server has no `gh` login, set the secret `githubToken` in the plugin settings.
The token needs read access to the repositories you want to follow.

The page uses the same compact, area-grouped layout as Reviews. Its
branch-and-arrow icon distinguishes My PRs in the sidebar. Groups come from PR title
scopes, falling back to the repository name.

Choose one PR's **Address**, or select several rows and choose **Address N**.
Group checkboxes select an area; Shift-click selects a range. Press **b** to
address the selection or **Esc** to clear it. Address starts one thread in the
configured project's default environment. The thread finds checkouts, fixes code,
runs checks, pushes the changes, and replies to review comments. It includes bot comments
in that work. The prompt forbids merging, approving, closing PRs, and automatic
thread resolution. The plugin itself only reads GitHub.

**Dismiss** hides feedback until a new commit or new human feedback changes
that PR. Open the dismissed list and choose **Restore** to bring it back.
Started PRs keep a link to their thread, including after the feedback clears.
When an attempt finishes, **Clear attempt** lets you start another. If a start
fails without returning a thread, check your threads before clearing it.

## Feedback rules

The policy comes from Workstreams' `your-turn.ts`, `feedback-to-address.ts`,
and `pr-gates.ts`. A PR needs your response when it has any of these:

- A human's approval note that you have not answered.
- A human's change request with no later push, reply, or re-request.
- An unresolved thread where another human spoke last.
- A human's comment with no later reply from you.

Drafts count. Bot feedback alone never puts a PR on Your turn. A push answers
a change request, but comments and approval notes require a reply. A bot's
reply does not answer a human's thread. A later standing approval covers that
reviewer's earlier comments.

My PRs keeps no effort assignments, holds, merge gates, or model
enrichment. Workstreams' existing Your turn view continues to work independently.
Workstreams' local **Confirm handled** records do not transfer to My PRs.

GitHub search, reviews, conversation comments, review requests, review threads,
and comments inside threads all paginate. The search limit is 1,000 open authored
PRs. An incomplete or failed read keeps the last successful inbox and displays
an error. Address refreshes and checks the selected activity before dispatch.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `project` | Unset | Project for Address threads. Required to dispatch. |
| `githubToken` | Unset | Secret GitHub token. Empty uses the server's `gh`. |
| `repoAllowlist` | Empty | Comma-separated `owner/repo` names. Empty includes every repository. |
| `pollMinutes` | 5 | Refresh interval, clamped to 1–60 minutes. |
| `provider` | Unset | Optional provider for Address threads. |
| `model` | Unset | Optional model for Address threads. |

Token and repository changes clear the old snapshot. Changes apply to the next
refresh. Reload after setting the initial project to clear the configuration notice.

## CLI

```sh
bb pr-inbox list --json
bb pr-inbox status --json
bb pr-inbox poll --json
bb pr-inbox dismiss <PR-node-id>
bb pr-inbox restore <PR-node-id>
bb pr-inbox address <PR-node-id> [<PR-node-id>...]
bb pr-inbox clear <PR-node-id>
```

Use the `id` field from `list`. Address accepts up to 20 distinct PRs. Dismiss,
restore, and clear each take one id. Clearing a link retains its thread in BB.

## Develop

```sh
npm ci --legacy-peer-deps
npm run typecheck
npm test
npm run build
```

`--legacy-peer-deps` avoids an npm 10 optional-peer resolver error when installing
the frontend test dependencies. Tests cover the feedback rules, pagination,
persistence, stale dispatch, and the page's manual actions using BB's public SDK.
