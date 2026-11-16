# PRs

A bb side panel for your open pull requests and your Review Watch inbox.
The **Mine** and **To review** tabs share a unit bar, effort groups, size dots,
and expandable context.

## Use the panel

Open **PRs** from the sidebar or the thread side panel. Select a segment
under the unit bar to filter the list. Every open PR occupies one cell.
The bar uses proportional group blocks when the cells no longer fit or the
board contains more than 120 items.

Use **Organization** to show one repository owner's PRs across both tabs.
The panel remembers this filter across visits and clears selections when you
change it. The organization stays pinned when no PRs match; choose
**All organizations** to broaden the view. Following an explicit review link
switches organizations when needed. The sidebar attention badge covers all
organizations.

The sidebar uses bb's native dot. It stays hidden when nothing needs you,
uses a neutral tone for 1–4 pending items, amber for 5–14, and red for 15 or
more. An unanswered agent question or a review queued for at least two days
also makes the dot red. Hover over the dot for exact counts and the reason.

**Mine** shows your next actions, running agents, pending reviewers, drafts,
and ready PRs. Your actions appear easiest first:

- **Answer to unblock agents** sends an explicit answer to the linked thread
- **One click** requests review from an eligible person that you choose
- **Small fixes for an agent** starts fixes below 2,000 changed lines and stops at Publish
- **Large fixes** starts fixes at 2,000 changed lines or more and stops at Prepare
- **Blocked upstream** shows configured gates and links to a clearing PR when provided

Large fixes and blocked items start folded under **Later**. The panel
remembers folds per tab. PRs waiting on checks, a stack parent, or answered
open threads remain visible with their actual reason. Other repositories
use the same layout; author-fix agents remain scoped to Parsley repositories.

Click a title to expand its stack, real check results, review state, size,
and links. Only one row expands at a time. Hover or focus a row for its PR
number, action, and selection checkbox. Select mixed fixes to choose a
stopping point in the floating toolbar. Up to 100 selected fixes share one
coordinator thread; the panel reports skipped items and later preparation
refusals. Every start refetches GitHub and checks that each chosen action still
applies. A shared agent question has one answer card with its linked PR count;
the other rows retain their individual context and shared thread link.

Use Left and Right Arrow, Home, and End to switch tabs. Use the arrow keys
to select a status, skipping empty statuses. Press Space to toggle a focused
selection checkbox or disclosure. Dialogs keep keyboard focus inside until
you close them; a pending request blocks dismissal.

**To review** reads the companion Review Watch plugin through its public
RPCs. Quick reads include completed review drafts, follow-up deltas below
150 lines, and first reviews below 300 lines. Unknown deltas stay in Longer
read; the panel never labels the full diff as a delta. Estimates use at
least five minutes and one minute per 30 lines, rounded up. The reviewer
thread drafts findings; it never posts a review, comment, or approval.
Review Watch retains its queue, settings, header counts, and CLI.

## Approval policy

One submitted, non-dismissed human approval on any commit counts. Later
commits and a pending second reviewer do not require another approval.
Unanswered review threads, outstanding changes requests, conflicts, failing
or pending CI, open answered threads, and known gates still block readiness.
Merging stays manual. Feedback in review bodies or PR-level comments is not
detected; the existing board rules inspect inline review threads.

## Review requests and agent answers

Request reviews through the panel's explicit Send action or user-authorized
`prs_act` operations. The picker lists current eligible repository collaborators, suggests individual CODEOWNERS, and shows their
existing board load. Missing ownership keeps the picker available. Before
sending, the server refetches the PR and validates the selected logins.

The header's **Agent** picker selects a provider, model, reasoning level, and
supported service tier for fixes and reviews. The default is Codex Sol 6.1
with xhigh reasoning. The panel loads your saved choice before enabling starts
and remembers changes across panel visits. A failed save keeps the confirmed
choice. Each start captures one choice for the whole request.

Fix threads use the existing Parsley project.
Every playbook forbids merging, releases, and deploys. Prepare commits locally
and reports; Publish can push, reply, and request review. The common playbook
requires a final `pr-board-question` JSON block for a blocking decision.
The panel recognizes only a validated block, never questions inferred from
prose. Answers use the supported thread follow-up API. A failed or interrupted
delivery keeps the question visible and directs you to the thread when its
outcome is uncertain, preventing duplicate sends.

## Requirements

The bb server host needs authenticated `gh` and `python3` on `PATH`.
Install both `pr-board` and `review-watch` for the combined experience.
Mine remains available if Review Watch is missing or fails.

In browsers with WebMCP, each open PRs panel exposes `prs_ui_snapshot`,
`prs_ui_query`, and `prs_ui_act`. These tools read bounded SDK component
state and change that panel's local tabs, filters, selection, and disclosures.
They require an exact live panel ID and component reference. The browser
bridge cannot start agents, send review requests or answers, dismiss reviews,
change the saved agent model, or act on another plugin. Without WebMCP,
the panel remains interactive and the typed BB PR tools remain available.
The bridge requires the current
`document.modelContext.registerTool(tool, { signal })` lifecycle. Legacy APIs
that expose `unregisterTool` are unsupported; the bridge registers no tools
and reports `unsupported-lifecycle`.

```sh
npm ci --include=dev
bb plugin build
bb plugin install .
```

The board refreshes every five minutes. **Refresh** forces a new attempt.
A failure keeps the last successful board and its timestamp. Data older than
15 minutes shows a stale indicator. Existing saved boards upgrade from the
plugin's own snapshot without requiring a successful GitHub fetch.

## CLI

The read-only CLI keeps its existing text sections and JSON fields. JSON
also includes canonical `prs` rows and `reviewer_batches` for the panel.

```sh
bb pr-board
bb pr-board --json
bb pr-board refresh
```

A failed refresh exits with status 1 and preserves the last good board.

## Configure gates

Edit `gates.json` for dependencies GitHub cannot detect. The optional
`clearedBy` field must use `owner/repo#number`; only configured references
link Mine gates to To review items.

```json
{"gates":[{"id":"schema","label":"Deploy the API schema","repo":"acme/app","prs":[17],"clearedBy":"acme/api#23"}]}
```

## Develop

The frontend uses matching, exact versions of `@ui-sdk/react` and
`@ui-sdk/core`. Before changing its controls, read the bundled
`node_modules/@ui-sdk/core/skills/ui-sdk/SKILL.md` and
`node_modules/@ui-sdk/react/docs/llms.txt`, then the relevant component pages.
The SDK owns tabs, status selection, disclosures, checkboxes, and dialog
behavior. `calm.css` supplies their appearance without the SDK's default theme.
BB owns navigation, URL links, RPCs, and the native sidebar badge.

```sh
npm run typecheck
TZ=UTC npm test
npm run build
```

`build.py` fetches and derives GitHub facts. `simple.py` owns the canonical
rows and preserves legacy CLI sections. `server.ts` owns refresh, start,
answer, and cross-plugin operations. SQLite stores the full board, source
snapshot, and agent markers, including large shared questions for selections
of up to 100 PRs. After activation, one initializer imports legacy KV state
before reading or updating the board. `reviewers.ts` owns eligibility and
explicit GitHub review requests. `reviews.ts` validates Review Watch's
published version 1 wire contract without importing its source or storage.
