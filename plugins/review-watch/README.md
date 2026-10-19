# bb-plugin-review-watch

A personal GitHub review inbox for BB. A background poller asks GitHub what
needs your attention, stores a deduplicated queue, and surfaces it in the
sidebar, the thread header, and on the command line. **Start** opens one thread;
**Review selected** opens one thread for several review requests. Both actions
let you choose a BB project before starting. Threads use that project's default
checkout on its registered machine, including a remote devbox.

Review Watch reads GitHub and never writes to it, and it never starts a thread
on its own. The queue notifies; you dispatch.

## Layout

- `server.ts` — settings, the queue in `bb.storage.kv`, the poll service, the
  `bb review-watch` CLI, RPC for the page, and the realtime signal that keeps
  every open page current.
- `app.tsx` — the **Reviews** page in the left sidebar
  (`app.slots.navPanel`), two review counts on its sidebar row and
  thread header, and a hover preview of up to five review requests.
- `src/types.ts` — the shared vocabulary: `Rule`, `PullRequest`, `QueueItem`.
- `src/github.ts` — the GitHub client and its two transports, a personal access
  token and the `gh` CLI. The only code that talks to the network.
- `src/rules.ts` — `classify` turns pull requests into queue items;
  `mergeQueue` folds a poll's items into the stored queue without losing
  `dismissed` or `started`.
- `skills/review-watch/SKILL.md` — a skill that tells agents how to read the
  queue and what they must not do to GitHub. BB imports it into agent threads
  automatically.
- `PLUGIN_OVERVIEW.md` — the store listing text: a longer version of
  `bb.description` that the plugin detail page shows under it. See
  [Store listing](#store-listing).

## Rules

An item carries exactly one rule, which decides its heading and the prompt a
started thread receives:

| Rule | Fires when | The thread does |
| --- | --- | --- |
| `review-requested` | Someone requests your review, and you have not submitted a review on the pull request. | Reads the diff and drafts findings for you to post. |
| `review-followup` | You have submitted an earlier review, and a newer head or explicit re-request needs your attention. | Focuses on what changed since your review. |

Your own pull requests never enter the queue. Workstreams shows the feedback on
them as **Your turn**.

A queue key is `<rule>:<node-id>:<head-sha>`, so a new head commit is a new
item. Every command that takes a key accepts an unambiguous prefix.

## Notifications

BB exposes no public SDK route for a plugin to raise a user notification. The
sidebar and thread-header badges show `review-requested` and
`review-followup` items in two colored chips. Each badge shows both counts,
including zero counts. Hover over the header badge to see labeled counts,
preview up to five review requests, and open the full **Reviews** page. The
realtime signal keeps these surfaces current.

On the **Reviews** page, queued and started `review-requested` and
`review-followup` items stay in their action sections and remain counted.
Started rows link to their open threads. They stay pending until a GitHub poll
confirms a submitted review newer than the item's baseline. A new head
supersedes the item; a closed or merged pull request also ends its pending
status. Select queued review items and choose **Review selected** to open one
aggregate review thread, or use **Start** for an individual item. Completed or
superseded reviewer threads move to **Archived threads** at the bottom, where you
can reopen them. Dismissed items do not appear. Workstreams displays feedback
on your own pull requests.

Each thread uses the selected project's default checkout. The agent finds
the matching repository checkout before it inspects code. Review Watch does
not create checkouts or worktrees when it starts a thread.

## Review projects

**Start** and **Review selected** open a project picker. Organization mappings
preselect a project; otherwise the plugin's **Default BB project** does. You
can override either choice for that review. If the selected PRs map to different
projects, choose one project for the batch. Canceling starts nothing.

Set **Organization projects** in the plugin's settings to a JSON object mapping
GitHub organization names to BB project IDs. Organization names ignore case.
Find IDs with `bb project list --json`, then configure the mapping:

```sh
bb plugin config review-watch set organizationProjects '{"parsleyhealth":"proj_parsley","bitcomplete":"proj_bitcomplete"}'
```

Replace the example IDs with your project IDs. The CLI's `start` command also
uses these mappings and the default project; a mixed-project batch requires
an explicit project through the picker.

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in `components.json`):

```
npx shadcn add @bb/select @bb/table
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Every shimmed package is declared in `devDependencies` at the
host's version so those imports typecheck; keep them there (never in
`dependencies`, which would bundle a second copy), and `bb plugin types`
repins them alongside the SDK. Ship `dist/` (npm tarball or committed for
git installs) so people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required).
- `bb.app` — frontend entry. Delete it, `app.tsx`, `components/`,
  `hooks/`, and `lib/` for a headless plugin.
- `bb.skills` — skill roots; omitted here, so BB reads `skills/`. Each
  directory with a `SKILL.md` is one skill, named after the directory.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — the lowest plugin SDK you need (scaffold:
  `>=0.4.104`). BB reads this as a floor, not a ceiling: a later
  SDK in the same major still loads your plugin.
- `dependencies` — every package your source imports that BB does not provide.
  `bb plugin build` inlines them into `dist/`, and git installs resolve this
  list alone, so a build-required package here rather than in
  `devDependencies` is what keeps your plugin installable. `devDependencies`
  is for types and tooling only (BB shims React, the portal primitives, and
  `@get-bb/plugin-sdk` at runtime — never bundle them).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` and `app.js` / `app.css` /
`app.meta.json`. Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Store listing

Two texts describe the plugin in the store. `bb.description` in package.json
is the one-sentence hook on every browse card and the lead paragraph on the
detail page; keep it under about 140 characters. `PLUGIN_OVERVIEW.md` is the
same claim at length, shown in an Overview section under that paragraph.
Rewrite the scaffold's copy for your plugin, and update it whenever
`bb.description` changes, so the two never disagree.

The submission to the public BB Community marketplace requires the file. Keep
it under 4000 characters (aim for 700 to 1800) and use headings, paragraphs,
emphasis, code, blockquotes, lists, thematic breaks, and absolute https links
only — raw HTML, images, tables, footnotes, and task lists are rejected. Do
not open with a `#` title or repeat `bb.description` verbatim; the page
shows both directly above.

## Install

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin review-watch
```

To work on the plugin, run from this directory in a clone:

```
npm install
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload review-watch
```

Or let `bb plugin dev` rebuild and reload on every save.

## Configure

`project` is required; the plugin reports `needs-configuration` until it is set.
Authentication has two routes, described under
[Authenticate to GitHub](#authenticate-to-github).

```
bb plugin config review-watch
bb plugin config review-watch set pollMinutes 5
bb plugin config review-watch set repoAllowlist "inkwell/folio,inkwell/quill"
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `githubToken` | — | A personal access token with `repo` scope. Stored as a secret. Leave it empty to poll through `gh`. |
| `project` | — | The BB project whose default environment runs started reviews. |
| `pollMinutes` | `5` | How often to ask GitHub. |
| `repoAllowlist` | `""` | Comma-separated `owner/name` entries. Empty watches every repository. |
| `maxAgeDays` | `14` | Drop an item this old even if GitHub still lists it. |
| `provider`, `model` | — | Optional. Passed through when a review thread spawns. |

Settings take effect on the next poll: the service reads a snapshot refreshed by
`settings.onChange`, so changing the interval or the allowlist needs no reload.

## Authenticate to GitHub

The poller reads GitHub through one of two transports, chosen per poll from the
current settings:

- **Personal access token** — set `githubToken` to a token with `repo` scope.
  The token travels with the plugin's configuration, so it needs nothing
  installed alongside it. Use this route for a BB server on a remote host.
- **`gh` CLI** — leave `githubToken` empty. The poller shells out to `gh api
  graphql` and reuses the login `gh` already holds, so no token lives in the
  plugin's configuration. Use this route for a BB server on your own machine.

The `gh` route needs `gh` installed and authenticated **on the host the BB
server runs on**, not on the laptop you browse BB from. Check it there with `gh
auth status`, and refresh a stale login with `gh auth refresh -h github.com`.

Neither route is validated when the plugin loads, because the `gh` binary is
resolved on first use. The first poll fails instead, and its error names the fix:
a missing `gh` points at the `githubToken` setting, and an unauthenticated `gh`
points at `gh auth refresh`. `bb review-watch status` reports which transport is
active, and the resolved `gh` path once a poll has found it.

Threads that Start spawns read pull request diffs and review comments through
`gh` whatever the poller uses, so `gh` auth on the BB server host still matters
when the poller runs on a token.

## Commands

```
bb review-watch list [--rule <rule>] [--json]
bb review-watch start <key> [--json]
bb review-watch dismiss <key> [--json]
bb review-watch poll [--json]
bb review-watch status [--json]
```

`poll` runs a pass now and prints what changed, which beats waiting a tick when
you are debugging. `status` reports the active transport (`token` or `gh`, with
the resolved `gh` path when it is known), the resolved viewer login, the last
poll and its result, and queue counts by rule.

GitHub searches paginate until all matching pull requests are read. If a pull
request has more nested review data than the query retrieves, the poll fails
with an explicit truncation error instead of updating the queue from partial
data. Check the poll error in **Reviews** or `bb review-watch status`.

## Types & API reference

The plugin API ships as the npm package `@get-bb/plugin-sdk`, pinned to an
exact version in `devDependencies` (`0.5.29` — the SDK of the running BB).
After `npm install`, the full surface is on disk
at:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

Your editor and `tsc` resolve `@get-bb/plugin-sdk` there through ordinary node
resolution — no path mapping. These are readable declarations: open them for an
exact signature.

The SDK surface grows with every BB release, so the pin has to track the BB you
actually run:

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```

Ask BB to write plugins for you: the `bb-plugin-authoring` skill documents
the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.
