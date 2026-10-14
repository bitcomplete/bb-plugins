# Stewards

Give a Linear ticket or a GitHub pull request **a long-lived thread that
manages it until it is done**. The thread, a **steward**, acts on the entity
as you, by a playbook the project keeps in `.bb`, and you steer it only from
bb. [DESIGN.md](DESIGN.md) is the design; this is how it is built and run.

## What it does

- **Adoption.** A Linear issue in a listed team carrying the project's label
  (`bb-managed` by default) gets a `ticket` steward. A labelled pull request
  in one of the project's repos gets a `pr` steward. Every non-draft pull
  request a teammate opens in those repos gets a `review` steward. Each
  steward is a child thread of its nearest managed ancestor, or of the
  project's **project steward**. Stewards make no sidebar sections and pin
  nothing; the sidebar stays the user's.
- **The reconcile loop.** linear and github hold bb-gate-hooks leases for the
  project's teams and repos and for every bound entity, and ring this plugin
  on a doorbell. A ring is debounced, the entity is snapshotted, compared with
  the last observation, and the steward is woken only for an actionable
  change: a phase change, a human comment, a review, checks finishing,
  someone else's push, a worker finishing, guidance, an approval, a spec
  change, or its requeue time. Everything else is recorded and ends there.
- **Wakes are self-contained**: playbook instructions for the phase, the
  ready gate, guidance and holds, the snapshot, and what changed. Each
  woken turn ends with `steward_report`, the status record.
- **Two tools.** `steward_report` ends a turn with the status record and,
  when needed, an escalation; `steward_update` steers a binding (guidance,
  deciding or forwarding escalations, priority, holds, models, approving a
  spec). Everything else is the tools every thread has: `linear_*`, `gh`,
  and `bb thread spawn` / `tell` for workers, which stewards recognizes as
  children of a steward thread.
- **Lifecycle.** A terminal state gets one wrap-up turn and the binding
  ends; removing the label gets one stop turn. Nothing is archived here:
  thread-briefs archives finished threads (and workers go with their
  lifecycle owner). Reopening, or re-adding the label, wakes the same
  thread, bringing it back from the archive if need be.
- **Workers** are hidden child threads with their own checkout, one per
  bounded task, owned by their steward. A runaway guard stops a steward's
  workers past a per-hour limit.
- **Decisions stay with the agents.** Escalations are conditions on the
  status record, routed to the parent steward, then the project steward,
  which decides from the project's guidance (AGENTS.md, design docs). Only
  what the project file lists under `bigDecisions` is forwarded to you, by
  the project steward asking in its own thread, where thread-briefs shows it
  as waiting on you. Substantial specs are approved by the project steward
  unless a playbook says `approval: me`.
- **The nightly pass** (01:00 in the project's time zone by default, done by
  02:45 so bb-gate's 03:00 restarts do not cut a turn) gives every open
  binding a turn, then wakes the project steward for the morning digest.
  A half-hourly mechanical sweep is the adoption and stuck backstop.

## Configuration

In the project's `.bb` (the multi-repo project repo), read from committed
HEAD through multi-repo's `readProjectFiles` and `repoSet`:

```
stewards/
  project.json          Linear teams, label, nightly, project steward model
  playbooks/
    linear-tickets.md   front matter + one ## section per phase
    github-prs.md
    github-reviews.md
```

`bb stewards init` writes starting points ([templates.ts](templates.ts));
`bb stewards check` validates them against Linear and GitHub. A playbook that
fails to parse is reported and bindings keep running under the last good
version. Project file fields beyond the design: `nightly.until`,
`nightly.max`, `playbooks` (which playbook governs each kind),
`reviews.enabled`, `adoption.perPass`, and `bigDecisions` (what reaches you;
defaults in [config.ts](config.ts)).

Playbook front matter: `name`, `kind` (`ticket`, `pr`, `review`), `source`,
`phases` (state → `{ stage, stuck }`), `terminal`, `ready` (`checklist`,
`substantial`, `approval: project` (default), `me` or `{ linear-state: … }`),
`promote`, `may` (policy stated in every wake), `models` (`steward`, `worker` as
`provider/model/level`; `claude` means `claude-code`), `requeue-default`,
`skip-authors`.

## Enforcement

None beyond the playbook's word. A steward acts with the user's credentials
and a shell; its `may` list and the ready gate are stated in every wake, and
everything it writes is signed with its thread, so what it did is visible
afterwards. The runaway guard is the one hard stop. GitHub writes go through
`gh`; there are no write tools to check.

## The contract with linear and github

[source-contract.ts](source-contract.ts) is copied byte for byte into
`plugins/linear` and `plugins/github`; `contract.test.ts` fails when the
copies drift. Sources serve `sourceSnapshot`, `sourceValidate`,
`sourceAdoptable` and `sourceSetInterest`; stewards serves `stewardsRing`.

## Develop

```sh
npm install --include=dev --legacy-peer-deps
npm run typecheck
npm test
bb plugin build
```

Deployment needs this directory added to bb-gate's
`docker/bb-server/Dockerfile` (the sparse checkout, the `mv`, and
`BB_PLUGIN_DIRS`), and multi-repo, linear and github at versions that serve
the contract.
