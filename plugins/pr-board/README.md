# PR board

A bb plugin that shows a plain-language board of your open GitHub pull
requests in bb's side panel.

## What it shows

From top to bottom:

1. A one-line summary.
2. **Suggested next steps**: up to five batched suggestions, most valuable
   first: PRs ready to merge, then fix review feedback, rebase, fix CI,
   re-request a reviewer who asked for changes, and pick reviewers. For
   example "Fix CI on 7 PRs; 3 are blocked by a known gate, so 4 are
   actionable (#562, …)". PRs an agent is already working on are left out.
3. **Stacks**: one line per stack of two or more Parsley PRs, with a lettered
   dot per PR in merge order (F fix feedback, C fix CI, R rebase, A ask for
   review, W waiting, H approved but held, ✓ ready, D draft). Long names wrap
   to two lines and show in full on hover. Hover or focus a dot for the PR's
   title and sentence. Clicking a stack filters the list to it. Collapsed by
   default in panels narrower than 440px.
4. The list:
   - **Ready to merge**: approved, no unanswered or answered-but-open
     threads, no outstanding changes request, no conflict, CI passing, no
     gates.
   - **Approved, not ready yet**: approved, but blocked by a gate, waiting
     for its stack parent, holding open threads you answered, or waiting on
     running checks.
   - **Needs you**, grouped as Fix review feedback, Fix CI, Rebase, and Ask
     for a review (no approval and nobody asked, or the reviewer who asked
     for changes is not asked again).
   - **Waiting on a reviewer**, grouped by person: PRs with no approval yet,
     or with changes requested by a reviewer who is asked again.
   - **Drafts** (collapsed).
   - **Other repositories**: PRs outside `parsleyhealth/`, with the same
     sentences and sub-groups (collapsed).
5. **Reviewer load** (collapsed): a bar per requested reviewer split into
   first reviews and re-reviews (PRs where that reviewer asked for changes),
   with the count and the oldest wait in days since the review request (`~`
   when no request event exists and the wait counts from the last push), plus
   a line for PRs with no reviewer. Approved PRs never count. Clicking a bar
   filters the list to that reviewer's PRs.

### The approval rule

One submitted, non-dismissed human approval is enough to merge. An approval
on an earlier commit still counts; later commits of any size do not need
re-approval, and a pending request to a second reviewer never blocks. What
holds a PR back is unanswered review feedback, an outstanding changes
request, conflicts, failing or pending CI, and known gates. Bot reviews never
count as approvals.

The next move is the first of: draft, fix (unanswered substantive or
unlabeled threads), reply (only minor unanswered threads), rebase or
retarget, CI failing, review (no approval, or changes requested), gated
(approved, but a gate or an open thread you answered), CI pending, ready.

Known limitation: feedback left in a review body or a PR-level comment (for
example "LGTM with nits" with no inline thread) is not detected; only review
threads are.

### Rows

Each row reads `#number  area  Title — one sentence`, then, at the right
(or on a second line in narrow panels), who reviews it (`Marcel` requested,
`Marcel ✓` approved, `Pedro ✗` requested changes; the tooltip says when an
approval was on an earlier commit) and its size (`1.2k lines · 14 files`
with a log-scaled bar). The area is the monorepo service or app from its
`service:` or `app:` labels (`root` when it has none), or the repository's
short name. An optional `Blocked by: …` line shows gates from `gates.json`.
Stacked PRs stay together, children indented under their parent with `└`; a
PR whose parent sits in another group shows `after #N`. Clicking a PR number
opens the PR in bb's side panel; modifier clicks, middle clicks, and copy
link work like any link.

## Start agents

The Fix review feedback, Fix CI and Rebase suggestions have a **Start (N)**
button, and each row in those groups has a small **Start** button. A PR with
a known gate gets no agent and shows "blocked by a gate" instead, because the
gate, not the code, may be what holds it. Start
opens a confirmation that names what happens, lists the PRs (uncheck any to
leave them out), and offers two stopping points:

- **Publish** (the default): push, reply on review threads, re-request
  review.
- **Prepare**: commit locally in a worktree and report; nothing is pushed or
  posted.

There is no merge option, and every playbook forbids merging, releases and
deploys. At most five PRs start per click. Confirming re-fetches every PR
from GitHub first; a PR whose next move changed since the click does not
start, and its row says why.

Each PR gets its own thread in the Parsley project (`proj_9itb3ud9c5`) on
Claude Code with `claude-opus-5-5` at `xhigh` reasoning, titled
`<Move> PR <n> <title>`. The prompt is filled from `playbooks/`: one file per
move (`fix-feedback.md`, `rebase.md`, `fix-ci.md`), one per stopping point
(`stop-prepare.md`, `stop-publish.md`) and the shared rules in `common.md`,
which end with a required `Decisions for Matt` section. A row with a live
thread shows "being worked on · <thread>"; after the thread stops it shows
"worked on <time> · see thread" until the PR's head or next move changes.
Asking for reviews and merging stay text-only suggestions.

Open the board in either of two places:

- In a thread, open the side panel's tab launcher and choose **PR board**.
- From the sidebar, open the **PR board** page.

## Requirements

The bb server host needs:

- `gh`, signed in to GitHub (`gh auth status`).
- `python3` on `PATH`.

When either is missing, the panel shows the error in one line and keeps the
last good board.

## Install and remove

```sh
npm install --include=dev
bb plugin install .
```

To remove it:

```sh
bb plugin remove pr-board
```

## Refresh

The backend refreshes on load and every 5 minutes. Runs never overlap. The
panel's **Refresh** button and `bb pr-board refresh` force a run.

## CLI

```sh
bb pr-board            # the board as text
bb pr-board --json     # the view model the panel draws
bb pr-board refresh    # fetch now, then print; exits 1 if the run failed
```

## Gates

`gates.json`, in this directory, lists dependencies GitHub cannot see. Each
gated PR shows a `Blocked by:` line with the gate's label. Edit the file by
hand; the next refresh picks it up.

```json
{"gates": [
  {"id": "sage-migrations",
   "label": "Sage migration numbering and merge order unsettled",
   "repo": "parsleyhealth/parsley-monorepo",
   "prs": [557, 561],
   "group": "Optional group name for the full board"}
]}
```

## How it works

- `build.py` fetches every open PR you authored with `gh api graphql`, derives
  each PR's facts and next move, and writes `data.json`.
- `simple.py --json` turns `data.json` into the view model. All grouping,
  sentence wording, nesting, stacks, suggestions and reviewer load live here.
  `python3 simple.py` writes the list as `simple.html`.
- `playbook.py` re-checks one PR's next move and fills its playbook.
- `server.ts` runs the scripts, stores the latest view model, the last error,
  the last success time and the in-flight markers in plugin storage, serves
  them over RPC, and starts agent threads with `bb.sdk.threads.spawn`.
- `app.tsx` and `board-ui.tsx` draw the view model and markers.

## Development

```sh
npm run typecheck
npm test               # vitest, then the Python unit tests (TZ=UTC)
npm run build
```
