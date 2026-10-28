# Multi-repo workspaces — design

A standalone BB plugin that gives a project **a set of git repos** and every thread **one workspace containing a checkout of each**.

## Scope

**In scope.** Provisioning multi-repo thread workspaces, configuring the repo set, a per-machine object cache, agent-facing tools and instructions, and a plugin-owned diff/PR panel.

**Explicitly out of scope — this plugin is standalone:**

- **No fork of bb.** Nothing here requires a core change. One possible core improvement is noted in [Out of scope](#out-of-scope) purely so the option is recorded; the design does not depend on it and must not be built assuming it.
- **No bb-internal packages.** `bb-environment-provider-host` (which exposes `runGit`, `detectGitRepo`, `readDefaultBranchRefs`, and the git ref mutation lock) is `"private": true` and reachable only from plugins bundled inside the bb repo. This plugin ships its own git argument layer.

  It does **not** need its own process layer. `@get-bb/plugin-sdk/host` publishes `experimental_spawnPortableOutputProcess` — documented as being "for host-local plugin operations such as git" — plus `experimental_sanitizeInheritedChildProcessEnv` (`packages/plugin-sdk/src/host.ts:46-56`). Build argument construction, exit-code handling and output parsing on top of those; do not reimplement spawning.
- **No dependency on other plugins in this repo.** No shared code with `kubernetes-provider`, `thread-briefs`, or `workstreams`. It must work on a stock bb install with only the bundled plugins present.

Core references below were verified against bb at commit `611e34892` (2026-09-24) and re-verified line by line on 2026-09-29. They are the evidence that this design works without core changes; re-check them when upgrading bb.

---

## 1. Concepts

A **project's source is the primary repo** — one real repo whose default
branch carries `.bb/`, a directory holding the workspace definition, not the
code. `.bb/` contains:

```
repos.json      the repo set
AGENTS.md       cross-repo guidance (read natively by bb)
skills/         project skills (read natively by bb)
```

A **thread workspace** is a plain directory holding one clone per repo, plus `.bb` itself. Every repo is equal; there is no privileged primary repo.

```
<plugin host-data>/
  repos/<key>.git            bare, self-contained object cache (per machine)
  workspaces/<pathKey>/      ← environment.path (plain dir, isGitRepo: false)
    bb-dylan/                clone, origin = real remote
    bb-plugins/              clone, origin = real remote
    .bb/                     clone of the project-source checkout
```

`<pathKey>` is the provider's per-thread path key. A repo's directory name is whatever `repos.json` says, defaulting to the repo's own name — so two repos sharing a basename can still be disambiguated explicitly.

## 2. Configuration

### `repos.json`

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

- `dir` — directory name inside the workspace, and a safe single path segment. Optional: the parser infers it from the URL's last component minus `.git`, and fails the entry by name when nothing usable comes out rather than inventing `repo-1`. Resolution happens once, at parse; everything downstream sees a `dir`. An inferred `dir` is flagged as such so serialization omits it again, keeping an unrelated add or remove a one-line diff.
- `url` — anything git can clone, including a local path. A local path makes "base this on my local checkout" a first-class option.
- `branch` — optional base branch. Defaults to that repo's default branch.

**Branches float; never pin SHAs.** This is a dev workspace, not a release manifest. Pinning buys reproducibility nobody asked for and creates staleness someone has to manage.

Keep it strict JSON. Documentation lives in the seeded `AGENTS.md` and the plugin UI, not in comments.

`repos.json` is the single source of truth. The plugin UI *edits and commits* it; it never shadows it with a separate store. Plugin storage holds derived state only: cache freshness, workspace manifests, precomputed layout text.

### Where `.bb` lives

`project_sources.path` is the canonical project-source checkout, per
`(projectId, hostId)` — one per machine (`packages/db/src/schema.ts:496`).
There are two layouts, detected from the default branch's committed tree:

- **primary** — the checkout is a clone of the primary repo and the definition
  sits at `P/.bb/`. `repos.json` lists only the other repos; P is derived from
  the checkout's `origin` and materialised into the workspace in addition to
  them. `.bb/` is copied from the canonical checkout to `<workspace>/.bb`,
  because core reads `<workspacePath>/.bb/AGENTS.md` and `.bb/skills` from the
  workspace root only.
- **standalone** — the checkout is a `.bb` git repo with the definition at its
  root. This is the original layout, still read and written as before so a
  machine that has not adopted keeps working.

Reads (`readProjectFiles`, `repoSet`) resolve the default branch's committed
tip — `origin/<default>`, or the local default branch when the plugin's own
commit is ahead of it — never the working tree or a feature branch.

Ways in:

- **Primary, from an existing repo** — point the project at a clone of P. If it
  does not carry `.bb/`, the plugin seeds it on the default branch and publishes
  a `guidance-<seed>` branch with a pull request.
- **Shared** — the standalone `.bb` repo has a remote. Clone it, create the
  project pointing at it.
- **Local, from scratch** — create the project pointing at a fresh directory;
  the plugin initializes a standalone `.bb` there.

`bb repos adopt <primary>` (and the panel) copies a standalone tree into
`.bb/` on a branch of the primary and opens a pull request; once it merges, a
later run re-points `project_sources.path` in place. That is BB-106 Case A: the
SDK's `bb.sdk.projects.sources.update` re-points the source row for the same
project id, so no store re-key and no steward respawn is needed.

## 3. Why a plain-directory workspace root

The root is not a git repo. Verified consequences:

- **It's a supported shape.** `environment-personal-workspace` already ships a non-git workspace.
- **Nothing errors.** `getAdditionalWorkspaceWriteRoots()` returns `[]` when the root isn't a git worktree (`packages/host-workspace/src/provision.ts:136-139`).
- **Everything is writable.** All repos sit under `cwd`, so they're writable under `accept-edits`/`auto` — no `full` permission mode needed. Permission scopes are only `workspace` and `full` (`packages/domain/src/shared-types.ts:495`), and `workspace` grants `cwd` plus additional roots (`packages/provider-bridge-acp/src/session-params.ts:313`).
- **`.bb` lands exactly where bb looks.** `<workspacePath>/.bb/AGENTS.md` (`apps/server/src/services/threads/workspace-agent-instructions.ts:13`) and `<workspacePath>/.bb/skills` (`apps/server/src/services/skills/workspace-skills.ts:83`) are plain path joins with no git requirement.

**Hazard: never create `<root>/.git`.** `packages/host-watcher/src/workspace-status-watcher.ts:324-332` promotes the environment to git mode the moment it appears, which would switch on a misleading native diff tab mid-session. The check is root-relative (`:157-160`), so nested repo `.git` directories are safe.

## 4. Why clones, not worktrees

`git worktree add` leaves the object store in the source repo, outside `cwd`. The agent could edit files but every `git commit` would fail on a sandboxed write to `objects`/`refs`.

A clone puts `.git` **inside** `cwd`. Use `--shared` (or `--reference`) so objects resolve from the per-machine cache: the alternates pointer is only ever read, and reads are unrestricted.

Two independent confirmations that a `.git` under `cwd` is writable:

1. `environment-project-checkout` ships a plain non-worktree repo as the workspace, receives `[]` additional write roots, and commits fine.
2. `packages/host-workspace/src/workspace-write-roots.ts:57-60` filters out candidate roots *nested under* the workspace — only coherent if nested git dirs are already writable.

Secondary benefit: two threads cannot both check out `main` as worktrees of one repo, but independent clones can. `.bb` tracks its default branch in every workspace, so this matters.

## 5. Pull-through object cache

Per repo, in order:

1. **Cache hit** — the internal bare clone exists. Fetch if stale.
2. **Local mirror** — a checkout on this machine has a matching `origin`: `git clone --bare <that-path>` hardlinks objects (instant, no network), then `git remote set-url origin <real-url>` and fetch the delta.
3. **Network** — `git clone --bare <real-url>`.

Discovery for step 2 uses bb's own registry of local checkouts: `bb.sdk.projects.list()` returns every project with its `sources[]` — `projectResponseSchema` is `projectSchema.extend({ sources })` (`packages/server-contract/src/api/projects.ts:432-435`) and each source is a `local_path` carrying `{ hostId, path }` (`packages/domain/src/project.ts:31-40`). One call enumerates every checkout bb knows about on this machine, and the plugin reads each one's `origin`. Add the project-source directory's siblings and one configurable extra search root.

Two rules:

- **The cache must be self-contained.** Never seed it with `--shared`/`--reference` from a user's checkout — deleting or gc'ing that checkout would corrupt every workspace chained off it. A plain bare clone still hardlinks, so it stays cheap and stands alone. Alternates belong only on the workspace→cache hop, where the plugin owns both ends.
- **Always fetch from the real remote after mirroring.** A local checkout carries stale refs and local-only branches.

Cache repos are alternates targets, so set `gc.auto=0` and `gc.pruneExpire=never` on them; repack with `git gc --no-prune`.

**The lock is the plugin's to build.** Nothing in the published SDK is a mutex: `experimental_retainWorker()` returns an `ExperimentalHostWorkerLease`, which only keeps a host worker alive past the current call (`packages/plugin-sdk/src/host-contract.ts:102-134`), and the ref-mutation lock in `bb-environment-provider-host/locks` is private. Budget a real cross-process file lock — concurrent thread creation against one cache entry is the expected case, not a rare one.

Freshness: fetch-if-stale with a short TTL at `create()`, plus a background refresh on a `bb.background` cron. Never fetch synchronously on every thread start.

## 6. Provider lifecycle

Declares `requires: { projectCheckout: true }`, which guarantees a non-null `context.projectCheckout.path` with **no** git availability gating — that only fires for `requires.gitCheckout` (`apps/server/src/services/threads/thread-environment-placement.ts:320,327`).

### `create()`

1. **Bootstrap `.bb`** if `projectCheckout.path` has no `.git`: `git init`, seed `AGENTS.md` and `repos.json`, commit.
2. **Refresh** the project-source checkout (fetch-if-stale), then parse and validate `repos.json`.
3. **Seed by discovery** if the repo set is empty — propose repos found on this machine rather than producing an empty workspace.
4. **Populate the cache** per repo (§5), under a file lock. Concurrent thread creation against one cache entry is normal, not an edge case.
5. **Materialize the workspace**: claim the root with `context.experimental_claimPath(root)` before writing to it, create it, clone each repo plus `.bb`, rewrite each work repo's `origin` to its real remote, and create the shared thread branch in each work repo. `.bb` stays on its default branch.
6. **Precompute the layout** table and write it to plugin storage keyed by environment (see §8).
7. Return `{ status: "created", path: <root>, ownsPath: true, resource: { workspaces: [...] } }`.

The result type also allows an optional `mergeBaseBranch`. Leave it unset: it is a single value on a flattened environment row and this workspace has one merge base per repo, so §9 computes merge bases itself. Setting it would publish one repo's base branch as if it spoke for all of them.

Report progress with `report.step` / `report.log` throughout. A cold start is a full network clone per repo and will read as hung otherwise.

### `remove()`

Kill first, then delete. `experimental_killProcessesWithCwdUnder` (`@get-bb/plugin-sdk/host`) is published for exactly this — "for a provider tearing down a workspace it made" (`packages/plugin-sdk/src/host.ts:38-44`) — and it SIGTERMs then SIGKILLs anything whose cwd sits under the root. Without it, removal races a language server or watcher still holding a repo.

Then enumerate every directory under the workspace root and remove each. Write a `<dir>.completed` marker per repo during `create()` so a partially provisioned workspace is recoverable per repo rather than all-or-nothing.

### Branching

Take the branch name from `context.suggestedBranchName` (`packages/plugin-sdk/src/environment-provider.ts:61`) rather than generating one — it is already bb's name for this thread, so plugin branches read like native ones. Use that single name in **every** work repo, so PRs across repos correlate by head ref. Fall back per repo on collision; the symmetry is a convenience, not an invariant.

### Policy

Take both defaults, deliberately (`packages/plugin-sdk/src/environment-provider.ts:98-104`):

- `pathKeys: "per-thread"` — a rebuild deliberately uses a fresh key "to avoid dead paths," so a rebuild re-clones every repo. That is the correct trade against serving a half-torn-down workspace, and the object cache keeps the cost local rather than networked.
- `retireGraceMs` — the five-minute default is right. Keeping these workspaces indefinitely would accumulate a full checkout set per thread on the machine's disk.

`ownsPath: true` is what makes both of these bb's problem rather than the plugin's.

### Failure policy

A repo that fails to materialize should not fail the whole environment. Record per-repo status and surface it in the panel; the thread is still useful with three of four repos present.

### One workspace, several threads

**A thread resolves its workspace through a binding, never through its own id.** Threads are many-to-one with environments — a fork reuses its source thread's environment by default, so `create()` never runs for the fork and no second workspace is provisioned. A `workspaces` row per `(hostId, pathKey)` with a single `thread_id` therefore answered nothing for a fork: the Changes panel, the repo list, the layout block and every `workspace_*` tool went blank while the checkout sat on disk, fully populated.

So `workspace_threads (thread_id → hostId, pathKey)` is the mapping, written in three places:

- `create()`, for the thread the workspace was built for.
- `thread.created`, for a fork. This is the only moment early enough to matter: `contributeInstructions` is synchronous and can only read a binding that is already persisted, so a fork's *first* turn carries the layout block only if the event bound it.
- Lazily, in any async path (RPC, tool, CLI) that misses — with a short negative cache and per-thread deduplication, because the file opener asks for a workspace on every file bb opens anywhere.

**Resolution asks core for the environment; it does not walk lineage.** `threads.get({ include: "environment" })` returns `environmentProviderId`, `hostId` and `environmentProviderInstanceKey` — and that instance key is exactly the `pathKey` core hands `create()`, which is half of `workspaces`' primary key. So a fork resolves in one indexed read, and refusing the environment when `environmentProviderId` is not ours is what keeps a child thread's git worktree out of this.

Following `sourceThreadId` back through the fork chain would reach the same row the long way round — `sourceThreadId` is the *immediate* source, so it is a walk, not a lookup — and it would be wrong for a fork that was given its own environment. Lineage is not the fact this plugin needs; the environment is.

**The binding table holds nothing core does not already know.** It exists for the synchronous path only: `contributeInstructions` gets `{ threadId, projectId }` and cannot await, so the answer has to be on hand locally before the first turn. An in-memory cache would do the same job until the next server restart, which is precisely when a session is reconstructed and instructions are resolved. (`bb.agents.configure` *does* receive the environment synchronously and can return instructions — a genuinely mapping-free alternative, at the price of also owning tool and skill selection, where an invalid selection drops this plugin's entire contribution for that resolution.)

The table is also the only way to answer the *inverse* question synchronously — who else is in this checkout. Core has no `environmentId` filter on `threads.list`, so deriving it would mean listing the project's threads and filtering, asynchronously, which the instruction path cannot do.

**Sharing is real and must be visible.** Two threads on one checkout means two agents on one branch in one directory, each seeing the other's uncommitted work as its own. The instruction block gains a shared-checkout warning appended at read time (`withSharedNotice`), the Changes panel names the other threads, and `bb repos status` lists them. Nothing prevents the collision — this is the only warning there is.

## 7. Sandbox boundaries

| Path | Agent can write |
|---|---|
| Anything under the workspace root, including every repo's `.git` | yes |
| `host-data/` cache, canonical `.bb` checkout | no |

Work repos push to their real remotes over the network — unaffected.

**`.bb` write-back inverts direction** and runs host-side in a plugin tool:

```bash
git -C <canonical-.bb> fetch <workspace>/.bb HEAD:refs/heads/guidance-<threadId>
```

Every write happens in the canonical repo, initiated by the plugin's host entry, which runs outside the agent's sandbox. This avoids the sandbox *and* `receive.denyCurrentBranch`, since the target ref isn't the checked-out branch. Merge it in the canonical checkout like any branch.

## 8. Agent-facing surface

### Generated facts

`bb.agents.contributeInstructions` supplies a dynamic instruction block. Two constraints to design around (`packages/plugin-sdk/src/backend-contract.ts:1656-1671`): the provider is **synchronous** and sits on the thread-start path, and output is truncated at 4096 characters. It therefore cannot shell out to git.

Precompute the layout at `create()` — a compact table of `dir → path → branch → remote` — store it, and have the callback read and format it. No git in the callback, and no truncation risk for a repo set of any sane size.

**It is not live, and one path makes that visible.** The contract is explicit: "A live provider session keeps the instructions it was constructed with — a changed contribution takes effect when the provider session is next constructed... never mid-session" (`packages/plugin-sdk/src/backend-contract.ts:1658-1663`). So a repo added by `workspace_add_repo` mid-thread will **not** appear in this block, even though its files are on disk.

The tool result is the only channel that reaches a live session, so `workspace_add_repo` must return the new repo's `dir`, absolute path and branch in its result text rather than telling the agent to consult the layout. The block is authoritative at thread start and stale only with respect to that one tool — which is precisely the tool that can repair it.

### Human intent

The seeded `.bb/AGENTS.md`, read natively by bb. This is where cross-repo reasoning lives: which repo depends on which, what has to be rebuilt or redeployed when a given repo changes, what belongs in which repo.

**Keep the split clean: the plugin generates facts, the file holds intent.** Paths written into `AGENTS.md` drift. Intent written into the generated block can't be edited.

The seed must also explain `.bb/` itself — that it is shared across every thread in the project, versioned, and the right place to record durable cross-repo knowledge. Otherwise agents won't use it.

### Tools

Registered with `bb.agents.registerTool`:

- `workspace_add_repo({ url, dir?, branch? })` — append to `repos.json` in the canonical `.bb` and commit; populate the cache; clone into the **live** workspace so the repo appears without restarting the thread. All three writes run host-side, so this works under `accept-edits`.
- `workspace_list_repos` — the current set with per-repo branch and status.
- `workspace_remove_repo({ dir })` — remove from `repos.json`; leave existing workspaces alone.

Plus a manifest skill (`bb.skills`) documenting when to reach for them, and a `bb repos` CLI command via `bb.cli.register` — worth having because the repo list lives in a plugin destination rather than bb's Project settings page.

## 9. Diff and PR

The workspace root isn't a git repo, so bb's native diff tab and PR state are unavailable (see [Known limits](#known-limits)). The plugin owns both surfaces.

### Reused, not rebuilt

`experimental_Diff` (`packages/plugin-sdk/src/app.ts:144`, props at `packages/plugin-sdk/src/app-contract.ts:561-584`) is a host-owned diff viewer available to plugins. It owns patch normalization, syntax highlighting, unified/split presentation, gutters, line-selection, optional full-file context expansion, and the live bb code theme. Pass `{ patch, path }` — a unified patch for one file.

This is the expensive part of a diff UI and it comes free.

### To build

| Component | Rough size |
|---|---|
| Git argument layer + repo/branch detectors (spawning comes from the SDK) | 100–150 |
| Diff data layer — merge base, name-status/numstat, per-file patch, untracked files | 400–500 |
| PR layer — `gh` field parsing and normalizers, actions, polling and caching | ~400 |
| Panel UI — repo grouping, file list, selection, per-repo header | 500–700 |

Reference material in bb (read, don't import): the `gh --json` field list and the checks/review/mergeability normalizers at `packages/host-workspace/src/git-host.ts:35-38,235-282`; the bundled `github` plugin's batched polling into a plugin SQLite table at `plugins/github/server.ts:670-695`.

### Staying current

Nothing in bb tells a panel that a file on a machine changed: there is no
watcher signal a plugin can subscribe to, so a panel that loads once at mount
shows the thread's opening snapshot forever. The diff half therefore polls
while the tab is visible — three short git commands per repo against a warm
checkout — and a `thread.idle` listener publishes a realtime signal so a
finished turn lands without waiting for the tick.

The `gh` half is explicitly excluded from that loop, and the two halves fail
independently: a machine without `gh` must not be able to hide the diffs.

Defer bb's hardening until it's needed: diff tiering and pagination, list virtualization, byte budgeting, patch-section splitting. Cap file count and per-file bytes instead.

Surfaces: `ui.threadPanelAction` for the panel, `ui.fileOpener` to claim workspace file-open targets so timeline file links route in rather than dead-ending, and `app.composer.customize({ banners })` for a one-row changed-files summary above the composer — bb's own prompt-context git section reads the thread checkout and finds a plain directory, so without it the thread view gives no sign that a diff exists and no reason to open the panel. The banner reuses the panel's `changes` RPC, polls on a slower interval because it is mounted on every thread rather than open on request, and stops polling when the first read reports no repos.

**Estimate: ~1,650–2,150 LOC, for §9 only.** It excludes provisioning, the cache, and the file lock from §5 — milestones 4 and 5 are where an estimate like this usually breaks, so treat it as a floor.

## 10. Packaging

One plugin, one package — `plugins/multi-repo/`:

```json
{
  "name": "bb-plugin-multi-repo",
  "type": "module",
  "engines": { "bb": ">=0.0", "bbPluginSdk": ">=0.5.24" },
  "bb": {
    "name": "Multi-repo workspace",
    "description": "Give a project a set of git repos and every thread a checkout of each.",
    "branding": { "icon": "FolderGit" },
    "server": "./server.ts",
    "host": "./host.ts",
    "app": "./app.tsx",
    "skills": ["skills"]
  },
  "dependencies": { "zod": "^4.3.6" },
  "devDependencies": { "@get-bb/plugin-sdk": "0.5.24" }
}
```

Three entry points in one package, because `bb.storage` and RPC routes are namespaced per plugin and the panel needs the provider's layout records. Splitting provisioning from UI would mean cross-plugin state access.

The `bb` floor is `">=0.0"`, matching every bundled plugin; the only one that declares more is `browser-automation` at `">=0.41"`, and there is no 0.43 in the tree to pin to. The SDK floor is the real constraint — `@get-bb/plugin-sdk` is at `0.5.24` — and it carries everything required: `./environment-provider`, `./host`, `./app`, `./testing`. UI primitives (React, Radix, clsx, and similar) are ordinary dev dependencies bundled at build time.

**Install:** `bb plugin install <path-or-git-source>`. No other plugin needs to be present and no bb fork is involved.

*Environment-specific note, not a dependency:* a deployment that bakes plugins into a server image can add this directory to the image's plugin checkout list and its plugin-dirs environment variable; nothing in the plugin assumes that packaging.

## 11. Build order

1. **Provider cold start** — bootstrap `.bb`, discovery seed, cache population, workspace materialization, progress reporting, layout precompute, `contributeInstructions`. Proves the sandbox and commit story end to end, with no UI.
2. **Tools and skill** — including live `workspace_add_repo`.
3. **Nav panel** — repo list, per-repo and cache status, `repos.json` editing with loud validation. Plus `bb repos`.
4. **Diff panel.**
5. **PR panel.**

Milestone 1 is the load-bearing one. Everything after it is additive and independently shippable.

## Known limits

Accepted consequences, not bugs:

- **No native diff tab, PR badge, sidebar PR attention, or AI commit message.** PR state isn't persisted anywhere — there is no pull-request table in `packages/db/src/schema.ts`; `threadPullRequest` is computed live from `environment.path`. There is no row for a plugin to populate. Diff and PR live in the plugin panel.
- **Not in bb's Project settings page.** No project-settings slot exists among the plugin app slots, so the repo list lives in a plugin nav panel beside bb's project settings. Someone looking in the obvious place won't find it — hence the CLI command.
- **A local-only `.bb` is single-machine**, enforced by core: setting a project up on a new machine requires a git remote (`apps/server/src/services/projects/project-source-setup.ts:188-192`). Give `.bb` a remote when it needs to travel.
- **Cold start is a full network clone per repo**, once per machine. Mitigated by the cache and local mirroring, not eliminated.
- **`bb project show` displays the `.bb` remote** as the project's git remote, since core probes it from the project source. Defensible — the project *is* the workspace definition — but it reads oddly at first.
- **`repos.json` sits on the critical path** for every thread creation in the project. Validate with a schema and fail naming the offending entry.
- **A fork shares its source thread's checkout, branch and all.** Core reuses the environment; a plugin cannot provision a second workspace for an environment core considers provisioned. Both threads are warned, in the layout block and in the panel, and coordinating is left to the user.
- **The repo set is fixed at `create()`.** Existing workspaces don't gain repos added later except via `workspace_add_repo`. Deliberate: a workspace shouldn't mutate under a running thread.

## Out of scope

Recorded for completeness only. **The design does not depend on either and neither should be built as part of it.**

- **True worktrees instead of clones.** Would need core to grant write access to nested repos' git directories — dropping the `isWorktree` guard at `packages/host-workspace/src/provision.ts:137` and having `workspace-write-roots.ts` scan subdirectories for worktrees. Small and a strict generalization, but it is a core change. Clones with a shared object cache are cheap enough that this is a disk optimization, not a capability.
- **Native multi-repo git and PR state in bb.** Would need per-workspace rows on the environment (replacing the flattened `path`/`branchName`/`baseBranch`/`mergeBaseBranch` columns) and `threadPullRequest` becoming a list. This plugin's per-repo model is deliberately shaped so it could migrate onto that if it ever lands.
