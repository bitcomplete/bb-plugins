# Multi-repo workspaces

Give a project **a set of git repos** and every thread **one workspace
containing a checkout of each**.

```
<workspace>/            ← the thread's working directory (a plain directory)
  bb-dylan/             a clone, origin = its real remote
  bb-plugins/           a clone, origin = its real remote
  .bb/                  the project definition: repos.json, AGENTS.md, skills/
```

A project's source stops being *code* and becomes the **workspace definition**:
a small `.bb` git repo holding the repo set, cross-repo guidance, and project
skills. Every repo is equal — there is no privileged primary repo.

Standalone: no bb fork, no bb-internal packages, no dependency on any other
plugin.

## Install

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin multi-repo
```

Then pick **Multi-repo workspace** as the environment when creating a thread.

## Getting started

Open the **Repos** panel and press **New project**. One form: a name, the
machine the project's `.bb` checkout lives on, where it goes (suggested as
`~/bb/<name>`, editable), and either the repos to start with or the URL of an
existing `.bb` repo to clone. The plugin initializes or clones the checkout,
commits it, and creates the project pointing at it. Then pick **Multi-repo
workspace** as the environment when you start a thread there.

The same two ways in exist without the panel, and are identical afterwards.

**From scratch.** Create a project pointing at an empty directory. The first
thread initializes `.bb` in it — `git init`, a seeded `AGENTS.md`, an empty
`repos.json`, a commit — and proposes a repo set from the checkouts already on
the machine. Add `git remote add origin …` and push whenever you want it to
travel.

**Shared.** Clone an existing `.bb` repo and create the project pointing at it.
A teammate gets the whole workspace definition from one URL.

Then give it a repo set, in the panel or from the CLI. `--project` targets a
project you are not currently working in, which is the usual case when setting
one up; without it the commands act on the project in context. Either this or
the panel will create `.bb` if it does not exist yet.

```sh
bb repos add git@github.com:you/bb-dylan.git  --project proj_abc123
bb repos add git@github.com:you/bb-plugins.git --project proj_abc123 --branch main
bb repos list --project proj_abc123
```

## `repos.json`

```jsonc
{
  "version": 1,
  "repos": [
    { "url": "git@github.com:you/bb-dylan.git" },
    { "url": "git@github.com:you/bb-plugins.git", "branch": "main" },
    { "dir": "bb-plugins-fork", "url": "git@github.com:me/bb-plugins.git" }
  ]
}
```

- `dir` — the directory name inside the workspace. Optional: it defaults to the
  repo's own name (the URL's last component, minus `.git`). Spell it out when
  two repos would otherwise share a basename, or when the URL's name is not the
  one you want. An entry written without it is also *written back* without it,
  so the plugin's own edits stay one-line diffs.
- `url` — anything git can clone, **including a local path**, which makes
  "base this on my local checkout" a first-class option.
- `branch` — optional base branch; defaults to that repo's default branch.

**Branches float; SHAs are never pinned.** This is a dev workspace, not a
release manifest.

Strict JSON, no comments — documentation lives in the seeded `AGENTS.md` and in
the Repos panel. The file is the single source of truth: the plugin edits and
commits it and never shadows it with a separate store. It also sits on the
critical path for every thread creation in the project, so a file that does not
parse fails the launch with a message naming the offending entry.

## Surfaces

| Where | What |
|---|---|
| **Repos** nav panel | The repo set as a list — add by URL with completions from local checkouts, change a base branch inline, remove — each change one commit in `.bb`. A **New project** form that creates a multi-repo project in one step. `repos.json` as text behind a disclosure, which opens itself when the file does not parse. |
| **Changes** thread panel | Per-repo diff and pull request. Opened from the thread panel's Actions list. |
| Composer banner | One row above the composer naming the repos that changed, their file counts and the `+`/`−` totals. Click it to open the Changes panel. Hidden when nothing has changed. |
| `bb repos` | `list`, `add`, `remove` (each takes `--project`), and `status` for the current thread. |
| Agent tools | `workspace_list_repos`, `workspace_add_repo`, `workspace_remove_repo`, `workspace_publish_guidance`. |
| Agent instructions | A generated table of `repo → branch → path`, plus a `multi-repo` skill. |

## How it works

### A plain-directory root

The workspace root is **not** a git repo. That is a supported shape, and it
buys three things: everything the agent touches sits under `cwd`, so the whole
workspace is writable under `accept-edits`/`auto` with no `full` permission
mode; `<workspace>/.bb/AGENTS.md` and `<workspace>/.bb/skills` land exactly
where bb looks for them; and nothing errors, because
`getAdditionalWorkspaceWriteRoots()` returns `[]` for a non-worktree root.

**The plugin never creates `<root>/.git`.** bb's workspace watcher promotes the
environment to git mode the moment one appears, which would switch on a
misleading native diff tab mid-session. Nested repo `.git` directories are
safe — the check is root-relative.

### Clones, not worktrees

`git worktree add` leaves the object store in the source repo, outside `cwd`,
so every `git commit` would fail on a sandboxed write to `objects`/`refs`. A
clone puts `.git` **inside** `cwd`, where it is writable. `--shared` makes the
objects resolve from a per-machine cache, so the disk cost of a clone is close
to a worktree's.

A second benefit: two threads cannot both check out `main` as worktrees of one
repo, but independent clones can — and `.bb` is on its default branch in every
workspace.

### The object cache

One bare repo per remote, per machine, at `<plugin host-data>/repos/<key>.git`.
Per repo, in order:

1. **Cache hit** — fetch if older than the TTL.
2. **Local mirror** — a checkout on this machine with a matching `origin` is
   `git clone --bare`d (hardlinks, no network), repointed at the real remote,
   and then fetched for the delta. Candidates come from bb's own registry of
   local checkouts, plus the project-source directory's siblings and one
   configurable search root.
3. **Network** — a plain bare clone.

Two rules it is built around. The cache is **self-contained** — never seeded
with `--shared`/`--reference` from a user's checkout, because deleting or
gc'ing that checkout would corrupt every workspace chained off it. And it
**always fetches the real remote after mirroring**, because a local checkout
carries stale refs and local-only branches.

Cache repos are alternates targets, so `gc.auto=0` and `gc.pruneExpire=never`
are set on them and repacking uses `git gc --no-prune`: an automatic prune
could delete an object only a borrowing clone still references.

Concurrent thread creation against one cache entry is the expected case, so
access is serialized by a real cross-process file lock with a heartbeat and a
staleness window. A background sweep keeps existing entries warm hourly so a
cold start stays rare rather than routine.

### The agent's view

A generated block lists each repo's directory, branch and absolute path. It is
precomputed at `create()` and stored, because `contributeInstructions` is
synchronous and sits on the thread-start path — it cannot shell out to git.

**It is not live.** A live provider session keeps the instructions it was
constructed with, so a repo added mid-thread by `workspace_add_repo` will not
appear there even though its files are on disk. That tool therefore returns the
new repo's `dir`, path and branch in its own result text, which is the only
channel that reaches a running session.

The generated block holds **facts**; `.bb/AGENTS.md` holds **intent** — which
repo depends on which, what has to be redeployed when a given repo changes,
what belongs where. Paths written into `AGENTS.md` drift; intent written into
the generated block cannot be edited.

### Writing back to `.bb`

The canonical `.bb` checkout is outside the agent's sandbox, so the write is
inverted: the canonical repo *fetches* from the workspace clone, initiated by
the plugin's host entry.

```
git -C <canonical-.bb> fetch <workspace>/.bb HEAD:refs/heads/guidance-<threadId>
```

That avoids the sandbox and `receive.denyCurrentBranch` at once, and leaves a
named branch to review and merge. `workspace_publish_guidance` is the agent's
entry point; `repos.json` edits from the tools, the CLI and the panel take the
same host-side route, which is why they work under `accept-edits`.

### Diff and pull requests

The root is not a git repo, so bb's native diff tab and PR state are
unavailable and the plugin owns both. It does **not** own the viewer:
`experimental_Diff` is bb's own and brings patch normalization, highlighting,
unified/split presentation, gutters, line selection and the live code theme.

Each repo is diffed against **its own merge base**, so an unrelated commit
landing on `main` mid-thread does not appear as this thread deleting someone
else's work. Working tree, not `HEAD`, because an agent mid-task has
uncommitted edits and those are what you want to see.

Pull requests go through `gh`, per repo, cached for a minute. A workspace can
span two orgs and an Enterprise host, so each repo is asked independently and a
machine without `gh` is reported per repo rather than failing the panel.

**The thread view says a diff exists.** bb's own changed-files summary above
the composer reads the thread's checkout, finds a plain directory rather than a
git repo, and shows nothing — so every fact about the diff used to live behind
the panel launcher, with nothing in the thread view to suggest opening it. A
composer banner fills that gap with one row: which repos moved, how many files
each, and the totals. It carries no pull-request state and no actions, because
the panel is still the surface to act on. It polls more slowly than the panel —
it is a glance mounted on every thread, not a diff someone is reading — and it
stops polling entirely on a thread with no workspace.

**The two halves refresh independently, and the diff half refreshes itself.**
Nothing in bb tells a panel that a file on a machine changed, so the diff half
re-reads itself every few seconds while the tab is visible, and a finished turn
publishes a signal so it lands sooner than the next tick. Pull requests stay
out of that loop — they shell out to `gh` over the network — and a `gh` failure
therefore shows as its own line rather than taking the diffs down with it. The
Refresh button is the force path for both.

## Forks share a checkout

A forked thread keeps the environment it was forked from — core's behaviour,
not this plugin's — so it keeps this plugin's workspace too. The fork gets the
same directory, the same repos and the same branch as its source thread, rather
than an empty panel and a workspace it cannot see.

Both threads are told. The agent's instruction block gains a shared-checkout
warning, the Changes panel names the other threads, and `bb repos status` lists
them. Nothing stops two agents from committing to the same branch in the same
directory, so treat the warning as one: let one thread work at a time, or give
the fork its own environment when you create it.

## Failure policy

A repo that fails to materialize does not fail the environment. It is recorded
per repo, named in the agent's instruction block, and shown in the Changes
panel. A thread with three of four repos is still useful; a failed environment
is not.

## Settings

| Setting | Meaning |
|---|---|
| Extra search root | One additional absolute path whose immediate children are scanned for local mirrors. |

## Known limits

Accepted consequences, not bugs.

- **No native diff tab, PR badge, sidebar PR attention, or AI commit message.**
  There is no pull-request table for a plugin to populate — bb computes
  `threadPullRequest` live from `environment.path`. Diff and PR live in the
  plugin panel.
- **Not in bb's Project settings page.** No project-settings slot exists among
  the plugin app slots, so the repo list is a nav panel beside bb's project
  settings. Hence `bb repos`.
- **A local-only `.bb` is single-machine**, enforced by core: setting the
  project up on a new machine requires a git remote.
- **Cold start is a full network clone per repo**, once per machine. Mitigated
  by the cache and local mirroring, not eliminated.
- **`bb project show` displays the `.bb` remote** as the project's git remote,
  since core probes it from the project source. Defensible — the project *is*
  the workspace definition — but it reads oddly at first.
- **The repo set is fixed at `create()`.** Existing workspaces do not gain
  repos added later except through `workspace_add_repo`. Deliberate: a
  workspace should not mutate under a running thread.
- **A fork cannot get its own checkout of the same environment.** Core reuses
  the environment for a fork, and a plugin cannot provision a second workspace
  for an environment core considers provisioned. Sharing is surfaced rather
  than prevented.
- **A rebuild re-clones.** `pathKeys: "per-thread"` means a rebuild takes a
  fresh key to avoid dead paths. The object cache keeps that cost local rather
  than networked.
- **The file opener claims common source extensions.** It delegates straight to
  bb's own preview for any file outside a multi-repo workspace, and only adds a
  header naming the repo inside one. Pin bb's preview per extension under
  Settings → File openers if you would rather it did not.

## Development

```sh
npm install
npm run typecheck
npm test          # 167 tests, including end-to-end provisioning against real git repos
npm run build
```

The end-to-end tests build actual repositories in a temp directory and assert
the properties the design depends on: that the root has no `.git`, that each
repo's `.git` is inside `cwd` and commits succeed, that alternates point at the
cache, that `origin` is the real remote and never the cache, that provisioning
is idempotent per path key, and that removal spares the shared cache.
