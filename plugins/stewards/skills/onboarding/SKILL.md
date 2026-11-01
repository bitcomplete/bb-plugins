---
name: onboarding
description: Set up stewards for a project that has none yet, or adopt one that has a partial .bb — run this when asked to "set up stewards", "onboard this project", or "adopt this project". Surveys the repos, interviews the owner once, writes a minimal .bb, validates it and lands it as a guidance pull request; stewards stay off until it merges.
---

# Onboarding a project onto stewards

You are an ordinary thread, not the project steward: the project steward is
designed to stay small and is started only once the project is set up. Your
job is to turn a project with no stewards content (or a partial `.bb`) into a
project whose `.bb` says what stewards need: the dependency graph between
repos, what rebuilds or redeploys when, how a merge is known live, the test
commands, the project steward's login, and a decide list whose `paths` make the
lane gate work.

The mechanics already exist; the content does not. Everything project-specific
is yours to survey and ask for, and nothing is live until the pull request
merges.

## 1. Survey first, ask second

Run the survey and read it end to end:

```sh
bb stewards survey --json
```

It emits, per repo (from `repos.json` plus the primary): the default branch,
branch protection, languages and package manifests, the test and typecheck
commands CI runs (from `.github/workflows`), Dockerfiles and deploy manifests
(`kploy`, `bc-prod.yaml`), the repo's labels, and which repos reference which.
It emits the Linear teams and their workflow states, and what `.bb` already
holds (project file, roles, playbooks). A read that failed is marked
`available: false` with the reason: say so, never guess.

Then read each repo's `README.md` (and `AGENTS.md` if it has one) for what the
survey cannot see: what the product is, which repo is deployed where, and how
a change is known to be live. Do not re-derive facts the survey already has.

## 2. One batched interview, under ten questions

Ask everything at once, as one numbered list, and only what only the owner
knows. Under ten questions — if you have more, answer the rest from the survey
and list them as assumptions. Cover:

1. **The project steward login** — the GitHub login whose server runs the
   project steward and forwards the project's big decisions.
2. **The owner's decisions versus the project steward's.** Present the
   defaults, then candidate `project` entries with `paths` from the survey
   (each path prefixed with its repo directory from `repos.json`, e.g.
   `bb-plugins/plugins/…`).
3. **How a merge is known to be deployed** — the repo, environment and rule
   the playbook's `deployment` should use.
4. **The label** tickets carry (default `bb-managed`).
5. **The nightly window and timezone.**
6. **Ops watches** — the namespaces, Sentry projects and Dependabot repos
   each server should watch, and which login runs them.
7. **Repos to exclude** from stewards.
8. Anything the survey marked unavailable, or that contradicts a README.

Everything else gets a default and is listed as an assumption in the pull
request body. The pull request is the second interview: the owner reviews the
assumptions there.

## 3. Write a minimal `.bb`

`bb stewards init` writes the skeleton (`stewards/project.json` and the default
playbooks) and never overwrites an existing file. On a partial `.bb`, it keeps
what is there, and you propose additions only: read the existing files first,
and add what is missing rather than replacing it.

Then fill in, from the survey and the interview:

- **`stewards/project.json`** — `linear.teams`, `label`, `nightly`,
  `github.exclude`, `deps` (the survey's test commands do not go here; they go
  in `AGENTS.md`). Fill `bigDecisions`: keep the defaults and add the project's
  `project` entries with repo-dir-prefixed `paths`, so the lane gate can match
  a pull request's changed files. A `user` entry with `paths` always wins.
- **`stewards/roles.json`** — one entry per GitHub login, with
  `projectSteward: true` on exactly one, and the `ops` watches from the
  interview. This file is what makes the project steward run.
- **`AGENTS.md`** — short on day one. The sections bb-gate's has, with only
  what the survey and interview support: the repos, the dependency graph
  (which repo consumes which), the shipping paths (what rebuilds, republishes
  or redeploys when a repo changes, and where the trigger lives), testing (the
  survey's test and typecheck commands), and reviews (the lane gate and who
  merges). Do not write a bb-gate-sized guide from guesses.
- **Playbooks** — touch them only where the survey found a deviation, for
  example a project whose deployment confirmation differs from the default.
  The templates are starting points; leave the rest alone.

Keep it short on day one: the minimum that lets stewards run without harm. The
lessons mechanism grows `.bb` from real decisions afterwards.

## 4. Validate and land

```sh
bb stewards check
```

Fix every `problem:` line before going on. A problem is a fact about the
project, not a warning to explain away.

Commit inside `.bb`, publish with `workspace_publish_guidance`, and open a
pull request on the primary repo. The body lists **every assumption** you made
— each default you took, each question you did not ask, each fact the survey
could not read — so the owner's review is the second interview. Name the repo
dirs and the decide-list paths so a reader can check them against `repos.json`.

Stewards read committed `origin/main` only, so **nothing is live until the
pull request merges**. Do not run `bb stewards enable` early.

## 5. Enable only after merge

Once the pull request is merged, on the project steward's server (the login
`roles.json` names):

```sh
bb stewards enable --project <id>
```

or the toggle on the project's row of the Stewards settings page. Only then
does the project steward thread start and the project adopt a labelled ticket.
If the pull request was declined, revise `.bb` from the review and repeat from
step 3.

## Adoption is the same flow

A project with a partial `.bb` gets the same treatment: survey, diff what
exists against what the survey says, and propose additions only, matching
`init`'s never-overwrite rule. Never rewrite a file someone wrote by hand; add
to it or leave it. This is also the flow for a native single-repo project,
where stewards reads `.bb` from `origin`'s default branch.
