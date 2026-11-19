# Getting started with stewards

Stewards give a ticket or a pull request **a long-lived bb thread that manages
it until it is done**: a steward decides and delegates, a worker implements,
an independent reviewer reviews, and the merge gate says when it can land.
The project's rules live in `.bb` in the project's repository, so the plugin
does not need any company-specific setup to run.

This guide is for a **stock bb** you run yourself: one git repository, no
Linear, no hooks service. Each optional section adds one thing — GitHub
issues, Linear, more repositories, deployment targets — without changing the
path below. [README.md](README.md) is the reference for everything the plugin
does; this is the shortest route to a working install.

## Prerequisites

- **bb 0.49 or newer.** The plugin declares `engines.bb >=0.49` in its
  manifest, and `bb plugin install` refuses a server below the floor. Check
  with `bb --version`.
- **A `gh` login on the machine that runs bb.** The GitHub source reads the
  repository through the `gh` CLI, so run `gh auth login` once (or set
  `GH_TOKEN`). Without it, the survey and the GitHub ticket playbook report
  GitHub as unavailable rather than guessing.
- **A model provider.** Stewards spawn worker and reviewer threads, so bb
  needs at least one provider configured (Settings → Providers), the same as
  any other thread. A playbook names the models a project uses; the defaults
  assume a Claude model, and a project can point them elsewhere.

## Install

Install the plugin and its GitHub source:

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin stewards
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin github-watcher
```

`github-watcher` is the GitHub source the survey, the GitHub ticket playbook
and the review watches read through. Install `stewards` alone and the project
still works, but it files local tickets only and the survey reports GitHub as
unavailable. A merge to the plugin repository does not update a server that
installed from a tag or a commit; `bb plugin update stewards` picks up a newer
`@main`.

## Your first project

Open or create a bb project for **a single git repository with a GitHub
remote**, and open a thread in it. Run the onboarding skill — say *"set up
stewards"* or *"onboard this project"* — and it surveys the repository, asks
one short interview, writes a minimal `.bb`, validates it and opens a
guidance pull request. That is the supported path; the commands it runs are:

```sh
bb stewards survey --json
bb stewards init
bb stewards check --create-labels
```

- **`survey`** reads the repository's default branch, languages, manifests,
  the test and typecheck commands its CI runs, its Dockerfile and its labels,
  plus what `.bb` already holds and the Linear teams when Linear is connected.
  A read that fails is reported as unavailable, never fabricated.
- **`init`** writes `stewards/project.json` and the default playbooks into
  `.bb`. It never overwrites a file that exists.
- **`check`** validates the project file and every playbook and creates the
  project's labels. Fix every `problem:` line before going on.

A git project is read at the committed tip of `origin`'s default branch, so
**nothing is live until the guidance pull request merges**. A plain project
directory (no git) is read from `.bb` on disk, so its files are live as soon
as they are written. After the pull request merges, switch the project on:

```sh
bb stewards enable --project <id>
```

## File and manage a local ticket

A project with no Linear team files tickets **locally**, in the stewards
store, under a key prefix (`LOCAL` by default). File one by asking bb to
`ticket_file { unit: "local" }`, or from a thread's shell with
`bb stewards tickets file`. `bb stewards tickets
list|show|comment|update|close` is the by-hand surface.

A local ticket is adopted **by state, not by label**: `Backlog` is parked,
and `Ready` or any later non-terminal state is adopted. Set it `Ready` with
`ticket_update` and a steward adopts it on the next sweep, opens the spec and
delegates; a worker opens a pull request, an independent reviewer reviews it,
and the merge gate merges it. The same flow runs for a GitHub issue once you
add the GitHub source below.

## Polling and latency

Without a hooks service there are no webhooks. The plugin **polls**:
`github-watcher` re-checks every open watch and the stewarded repositories on
its own timer (five minutes by default), and the mechanical sweep runs every
five minutes. So a new labelled ticket, a comment or a review is seen within a
few minutes, not instantly. `bb stewards check` prints this as information:

```
doorbells: polling every 5 minutes (no hooks service configured)
```

Set **Sweep every N minutes** on Settings → Plugins → Stewards, or the
plugin's `sweepMinutes` setting, to change the backstop. Three things have no
polling fallback and stay hooks-only: Linear `@bb` sessions, Slack, and
`workflow_run` failure doorbells. Add the hooks service (below) when you want
webhook latency for them.

## Optional: GitHub issues as tickets

With `github-watcher` installed, a GitHub issue is a ticket too. An issue
carrying the project's label (`bb-managed` by default) is adopted when it is
assigned to this server's login. GitHub has no workflow states, so the
playbook keys its phases on **`status:*` labels** — `status:todo`,
`status:in-progress`, and so on — and `bb stewards check --create-labels`
creates the label and each status label in every stewarded repository. The
survey reads the repository's labels so the interview can confirm them.

## Optional: Linear

1. In Linear, create a **public OAuth application** under Settings → API →
   OAuth applications with the callback URL
   `https://<bb host>/api/v1/plugins/linear/http/connect/callback`. Public
   means PKCE with no client secret.
2. Give the server the application's **client ID** through the
   `LINEAR_CLIENT_ID` environment variable, or set the plugin's `clientId`
   setting. The client ID is not a secret; the application is public and
   PKCE protects the exchange.
3. The server needs a **reachable address** (`BB_APP_URL`) so Linear can
   send the browser back after consent. bb sets it from the server's
   configured address; a server only reachable on localhost cannot complete
   the callback.
4. Install the `linear` plugin, open Settings → Plugins → Linear, and press
   **Connect Linear**. The survey then lists the workspace's teams and their
   workflow states. Add the team keys to `linear.teams` in
   `.bb/stewards/project.json`, land the guidance, and run
   `bb stewards check --create-labels`; `init` already wrote
   `linear-tickets.md`, and it never rewrites an existing `project.json`.

## Optional: multi-repo projects

Install the `multi-repo` plugin to give a project a **set of repositories**
instead of one. The plugin gives every thread a workspace holding a checkout
of each repository, and the project's `.bb` lives on the **primary** repo.
The other repositories are listed in `.bb/repos.json`; the decide list's
`paths` are prefixed with the repo directory (`web/src/…`). Land the guidance
with `workspace_publish_guidance` rather than opening the pull request by
hand. A single-repo project needs none of this and reads `.bb` natively.

## Optional: deployment targets

By default **merged is done**. When a project wants to wait for a **GitHub
Deployment**, a playbook names a `deployment` target: the `github` source, the
repository and environment, and a `carries` rule that says whether a given
deployment actually contains the merge. The generic rule is
**`strategy: { kind: ref-contains-merge }`**: the deployment's ref has the
merge commit as an ancestor. A project whose image tag, not the ref, is the
signal can use `image-tag` instead, which reads the image tag from the
manifest at the deployment's ref. The plugin reports `deployed` or
`not-yet` itself and wakes the steward only when a verdict settles a watch or
a deployment fails. `bb stewards check` reports a deployment target with no
`carries` rule.

## Optional: webhooks, Slack and `@bb` mentions

Polling is the whole story until a **hooks service** is in front of the
server. Set `BB_HOOKS_URL` (and `BB_HOOKS_TOKEN` when the service requires
one) and `linear` and `github-watcher` subscribe to it: reviews, comments,
issues and deployments arrive as doorbells instead of on the poll timer, and
`bb stewards check` prints `doorbells: from the hooks service`. The same
service carries Linear `@bb` mentions and Slack messages to a thread. The
service and its wire contract live in the
[hooks-service](../../hooks-service) directory of the plugin repository; it is
optional, and a project without it runs on polling.

## What is not supported

- **A shared multi-user bb server.** Stewards act as the server's owner and
  adopt what that login is assigned. One owner per server; two people do not
  share one server's stewards.
- **A project with no GitHub at all.** The survey, the GitHub ticket playbook
  and the review watches read GitHub through `gh`. A project with no GitHub
  remote can still file and run **local** tickets, but it cannot adopt GitHub
  issues or pull requests, and the survey reports GitHub as unavailable.
