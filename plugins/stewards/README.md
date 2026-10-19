# Stewards

Give a Linear ticket or a GitHub pull request **a long-lived thread that
manages it until it is done**, and production a thread that watches it and
files what goes wrong. The thread, a **steward**, acts on the entity
as you, by a playbook the project keeps in `.bb`, and you steer it only from
bb. [DESIGN.md](DESIGN.md) is the design; this is how it is built and run.

## What it does

- **Adoption.** A Linear issue in a listed team carrying the project's label
  (`bb-managed` by default) gets a `ticket` steward. A labelled pull request
  in one of the project's repos gets a `pr` steward. Every non-draft pull
  request a teammate opens in those repos gets a `review` steward. Each
  steward reports to its nearest managed ancestor's steward, or to the
  project's **project steward**, through its binding — not as a child
  thread: bb wakes a parent thread every time a child finishes a turn, and
  on bithub that was 88 of the project steward's 96 turns. A project's
  stewards share one sidebar section, named after the project, with each
  steward's workers nested under it; see DESIGN.md §15.
- **Ops stewards.** Each target in the project file's `ops.targets` (a
  Kubernetes namespace) gets an `ops` steward, reporting to the project
  steward, for as long as it is listed. The plugin looks at the target with
  `kubectl` on the project's machine, the developer's own, as them (through
  its host entry, [host.ts](host.ts), and [kubectl.ts](kubectl.ts)): pods,
  Warning events, Deployments, and a failing container's last log lines.
  It names each
  problem by a fingerprint (workload, container, error signature;
  [ops.ts](ops.ts)) and keeps a fingerprint → Linear ticket map. A new
  problem, or one back after its ticket was resolved, wakes the steward at
  once. Every requeue (`requeue-default`, 1h in the template) is a turn
  whatever the look found: a problem still failing under its open ticket is
  a comment there and nothing new filed, and a healthy look is a short
  "all healthy" report. The steward
  files one ticket per problem and escalates a `decision` to the project
  steward ("Filed BB-N (high), recommend adopting"); the project steward
  adopts with the label and Todo, the ordinary path. Every kubectl call the
  plugin makes passes one gate that allows only `get`, `describe`, `logs`
  and `auth can-i`, and the playbook's `may` list holds the steward to the
  same; the developer's own rights are broad, so that is a convention, not a
  wall. Until kubectl can read a target, its binding waits and `bb stewards
  check` says "cannot read the target". DESIGN.md §18.
- **The reconcile loop.** linear and github-watcher hold bb-gate-hooks leases for the
  project's teams and repos and for every bound entity, and ring this plugin
  on a doorbell. A ring is debounced, the entity is snapshotted, compared with
  the last observation, and the steward is woken only for an actionable
  change: a phase change, a human comment, a review, checks finishing,
  someone else's push, a worker finishing, guidance, an approval, a spec
  change, or its requeue time. While one of its workers is running, the
  worker's own work on a pull request — checks finishing, description
  edits, pushes and comments from your account, which every thread posts
  as — is not a reason to wake. Everything not actionable is kept as a
  quiet note and shown in "What changed" at the next turn something else
  makes due.
- **Wakes are self-contained**: playbook instructions for the phase, the
  ready gate, guidance and holds, the snapshot, and what changed. Each
  woken turn ends with `steward_report`, the status record. A wake past
  30,000 characters is cut in its snapshot, never in what changed. Because
  a wake carries what the steward needs, its transcript can go: after a
  steward's or the project steward's turn, the plugin compacts its context
  once it holds more than **Compact a steward above this many context
  tokens** (120,000 by default; 0 leaves it to the provider).
- **Two tools.** `steward_report` ends a turn with the status record and,
  when needed, an escalation; `steward_update` steers a binding (guidance,
  deciding or forwarding escalations, priority, holds, models, approving a
  spec). Everything else is the tools every thread has: `linear_*`, `gh`,
  and `bb thread spawn` / `tell` for workers, which stewards recognizes as
  children of a steward thread.
- **Lifecycle.** A terminal state gets a wrap-up turn with its workers
  still running. The steward either ends the binding there, or keeps it open
  to follow through (`steward_report { followThrough }`) on what the state
  does not cover, such as a deploy to watch or production to verify. It is
  then woken as usual until it reports without `followThrough`, or until the
  playbook's `follow-through` cap (6h by default) runs out and the project
  steward is told. Removing the label stops the workers at once and gets one
  stop turn. When the binding ends, its workers are stopped, the steward's
  thread is archived, and the workers go with their lifecycle owner.
  Reopening, or re-adding the label, wakes the same thread, bringing it back
  from the archive; an entity that leaves its terminal state before the
  binding has ended takes the ending back. A steward whose wake turn reports
  `actor: other` (waiting on a reviewer or the author) is archived too,
  unless a worker runs or an escalation is open; its next wake brings it
  back.
- **thread-briefs.** Every steward, the project steward included, is
  spawned with `threadBriefs: { rename: false, group: false, archive: false }`
  in this plugin's metadata namespace (see thread-briefs' "Threads a plugin
  runs"). thread-briefs then never renames a steward, whose title carries
  its entity key, never moves one into a status section or auto-archives
  it, since between wakes it reads done while its entity is still open.
  A ticket or pull request steward's row draws the stage ring like any
  thread's. The project steward also gets `ring: false`: it has no stage of
  its own, so its row keeps bb's own indicators. The project steward
  is titled "<project name> project steward". The sweep tags threads
  spawned before this, lets go of stewards an earlier version made children
  of another steward, and renames an older project steward once. After
  that, a project steward renamed by hand keeps its name.
- **Workers** are child threads with their own checkout, one per bounded
  task, owned by their steward. They show nested under their steward's
  sidebar row, which collapses them like any parent. A runaway guard stops a steward's
  workers past a per-hour limit.
- **Decisions stay with the agents.** Escalations are conditions on the
  status record, routed to the parent steward, then the project steward,
  which decides from the project's guidance (AGENTS.md, design docs). Only
  what the project file lists under `bigDecisions` is forwarded to you, by
  the project steward asking in its own thread, where thread-briefs shows it
  as waiting on you. Substantial specs are approved by the project steward
  unless a playbook says `approval: me`. The plugin asks for that approval
  itself: whenever a ready gate's checklist is met, the ticket is
  substantial and the current spec has no approval, it files an `approval`
  escalation with the approver (the project steward, or the user in the
  steward's thread), whatever the steward's report says, and closes it once
  approved or no longer needed. A request the approver declines is not made
  again until the spec changes. When the entity changes while one of its
  escalations is with you, the project steward is woken with the change too,
  since you may have answered on the ticket rather than in its thread. A
  status blocked on the project steward or the user with no open
  escalation is flagged in `bb stewards list` and the digest.
- **The nightly pass** (01:00 in the project's time zone by default, done by
  02:45 so bb-gate's 03:00 restarts do not cut a turn) gives every open
  binding a turn, then wakes the project steward for the morning digest.
  A half-hourly mechanical sweep is the adoption and stuck backstop.
- **The Stewards page** (a nav panel, [app.tsx](app.tsx)) has a tab per
  stewarded project: what waits on you (questions the project steward put
  to you, which you can answer and close there, forwarded escalations and
  approval requests), what is in flight by stage with each status record
  and running workers, what is stuck or held, what ended in the last two
  weeks, and the latest digest with its date.
- **Questions to you** are kept in the store from the moment the project
  steward asks (`steward_update { ask }`, or forwarding an escalation)
  until it records your answer (`steward_update { resolve: "<question id>",
  answer }`) or you close it on the page. A forwarded escalation and its
  question close together. The nightly wake lists them, with the previous
  digest, what moved, what waits on you and what is stuck, all read from
  the store, so the digest does not depend on the project steward's memory.
- **The settings page** (Settings → Plugins → Stewards, [app.tsx](app.tsx))
  shows each stewarded project's configuration, problems, project steward
  and nightly pass, runs `bb stewards check` on a button, and lists every
  open steward with its latest status record and open escalations. It is
  read-only; steering stays with the project steward and `steward_update`.

## Configuration

In the project's `.bb` (the multi-repo project repo), read from committed
HEAD through multi-repo's `readProjectFiles` and `repoSet`:

```
stewards/
  project.json          Linear teams, excluded repos, label, nightly, project steward model
  playbooks/
    linear-tickets.md   front matter + one ## section per phase
    github-prs.md
    github-reviews.md
    ops-watch.md        no phases; ## New, ## Recurring and ## Returned sections
```

`bb stewards init` writes starting points ([templates.ts](templates.ts));
`bb stewards check` validates them against Linear and GitHub. A playbook that
fails to parse is reported and bindings keep running under the last good
version. Project file fields beyond the design: `nightly.until`,
`nightly.max`, `playbooks` (which playbook governs each kind),
`reviews.enabled`, `adoption.perPass`, `bigDecisions` (what reaches you;
defaults in [config.ts](config.ts)), and `ops`: `targets` (`{ kind:
"k8s-namespace", name }`, at most ten), `team` (where tickets are filed; the
first of `linear.teams` by default, and it must be one of them) and
`context` (the kubeconfig context kubectl uses; the machine's current one
when left out) and `autoAdopt` (Linear priorities, `urgent`, `high`, `medium`, `low`, whose
tickets the ops steward labels for a steward itself when it files them).
`ops-watch.md` is read only when `ops.targets` lists something.

Playbook front matter: `name`, `kind` (`ticket`, `pr`, `review`, `ops`),
`source` (`linear`, `github`, or `k8s` for `ops`), `phases` (state → `{ stage,
stuck }`; none for `ops`), `terminal` (at least one; none for `ops`), `ready` (`checklist`,
`substantial`, `approval: project` (default), `me` or `{ linear-state: … }`),
`promote`, `may` (policy stated in every wake), `models` (`steward`, `worker` as
`provider/model/level`; `claude` means `claude-code`; the model may hold
slashes, as Pi's `pi/fireworks/accounts/fireworks/models/…` do, and the last
part is the level only when it names one), `requeue-default`,
`follow-through` (how long a terminal binding may be kept open, 6h by
default), `skip-authors`.

The wake numbers the ready checklist, and `steward_report` takes each item by
its number (or the playbook's exact words). It stores the playbook's wording,
so the gate matches what the steward meant, and it refuses anything else and
records nothing, listing the numbers. Checklist items can then be as long as
a project needs.

## Enforcement

None beyond the playbook's word. A steward acts with the user's credentials
and a shell; its `may` list and the ready gate are stated in every wake, and
everything it writes is signed with its thread, so what it did is visible
afterwards. The runaway guard is the one hard stop. GitHub writes go through
`gh`; there are no write tools to check. Ops stewards are no exception:
kubectl acts as the developer, and only the plugin's verb gate and the
playbook keep the steward to reading.

## The contract with linear and github-watcher

[source-contract.ts](source-contract.ts) is copied byte for byte into
`plugins/linear` and `plugins/github-watcher`; `contract.test.ts` fails when the
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
`BB_PLUGIN_DIRS`), and multi-repo, linear and github-watcher at versions that serve
the contract. Ops stewards need `kubectl` on the project's machine, with a
kubeconfig that reaches the cluster as the developer (for bc-prod, the
Tailscale API proxy: the machine on the tailnet as its developer, not a
tagged node). The plugin's host entry runs it there.
