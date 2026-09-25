# Workstreams

Workstreams connects git checkouts that belong to the same ticket, even across
repositories. Its Map groups tickets into efforts, programs, and domains when
the evidence supports those levels. Its Board groups checkouts by next action
or effort.

## Get started

From this directory:

```sh
npm install
bb plugin install .
bb plugin config workstreams
```

Set `scanRoots` to the directories that hold your checkouts. If you leave it
empty, Workstreams scans the paths of your BB projects. Open **Workstreams** in
the sidebar, or run `bb workstreams refresh` followed by `bb workstreams list`.

An authenticated `gh` supplies pull request state and enables Board actions.
Without it, the board shows observed local git activity, marks other checkouts
as unverified, and shows a warning. Workstreams looks
for ticket keys in branch names, Linear linkback comments, pull request titles
and descriptions, and checkout directory names, in that order. A ticket's
checkouts form one cluster. Related clusters can form an effort; levels that do
not add information collapse.

## Choose enrichment

The board works without model keys. Optional keys add detail:

| Setting | What it adds |
| --- | --- |
| `linearApiKeys` | Ticket titles, state, project, parent, and team names from each matching Linear workspace. The older `linearApiKey` setting still works. |
| `typesafeApiKey` | Jev selects ticket summaries and assigns related tickets to efforts and higher groups. |
| `anthropicApiKey` | With Jev enabled, Claude Sonnet 5 names groups and flags groups whose members look unrelated. It does not change membership. |

Set these under **Plugins → Workstreams** or with `bb plugin config workstreams
set <key> <value>`. Keys are optional. An Anthropic key alone does not enable
grouping.

The scanner stores board facts and caches in BB's local plugin storage. It uses
`git` locally and your authenticated `gh` to read GitHub pull requests and
perform Board actions that you confirm. A Linear key sends ticket identifiers
to Linear and retrieves issue details. With model keys, Jev receives ticket
keys, repository names, pull request titles, and available Linear context to
select summaries and groups. Anthropic receives the member keys, summaries,
repository names, candidate phrases, and available Linear or thread-title
context needed to name a group. Model calls happen when semantic inputs change;
an unchanged rescan reuses cached decisions. The optional **Fetch Linear details
via agent** action starts a BB thread only when you confirm it.

## Use the board

- **Map:** Explore the grouping hierarchy. Switch between theme and risk faces,
  filter by status and code surface, and open a linked agent thread.
- **Board:** Group rows by Action (the default) or Effort. Both views keep
  urgent work first within each group and offer the same row actions. Direct
  merge, branch update, and reviewer nudge actions ask for confirmation. CI,
  conflict, and review work starts a dedicated agent thread after you review
  its prompt.
- **Board v2:** Start with rows grouped by Effort. Choose one effort, use
  **Shadow preview** to see
  the next eligible PR repair, then explicitly enable **Auto**. Auto starts one
  agent at a time for failing CI, merge conflicts, or review feedback. The
  agent works locally and is instructed to ask before pushing or replying on
  GitHub. Workstreams checks the PR again before it calls a transition
  verified. An unresolved gate pauses further dispatch until a fresh scan
  confirms it cleared. **Off** stops new dispatches; it does not cancel an
  agent already running. Auto never merges or deploys. The original Board
  remains available beside Board v2.
- **How this works:** Open the ⓘ panel for state definitions, shortcuts, scan
  health, and warnings.

`bb workstreams list [--json]` reads the last scan. Run `bb workstreams refresh`
when freshness matters. `bb workstreams group <TICKET> <effort name>` sets a
manual effort name; `bb workstreams ungroup <TICKET>` removes it.

The internal `shipped` state means a merged commit appears in a local release
tag. It does not establish that the change reached production. When a repository
has no usable release tags, merged work remains `merged` and the board warns.
Dispatch currently starts from existing PRs with a scanned checkout. It does
not create PRs from issues or checkouts, request review, or merge; those steps
remain Board actions. Its workflow ends when GitHub reports the PR merged.

## Develop

The scanner and Anthropic naming call live in `host.ts`. `server.ts` handles
settings, local storage, refresh, enrichment, actions, and the CLI. The grouping
and lifecycle rules live in `workstreams.ts`; `app.tsx` mounts the Map and both
Board tabs.
`contract.ts` defines the host RPC schema, and `skills/workstreams/SKILL.md`
documents the CLI for agents.

```sh
npm test
npm run typecheck
npm run build
```

After editing the plugin, run `bb plugin reload workstreams`. The build creates
the distributable files in `dist/` for git or npm installs.
