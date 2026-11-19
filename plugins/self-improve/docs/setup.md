# Your first learning loop

Start with a problem you can explain. A useful first result is a clear ledger entry and a traceable attempt, even when the experiment is inconclusive.

## Prepare a scratch preview

Follow the [local build/install recipe](../README.md#try-the-draft-in-scratch-bb) in a disposable BB instance with separate data and worker environment. Use ports such as `48886` and `48887`, not the live server's `38886`. Setting a different plugin source path alone does not isolate BB.

The final preview revision still needs its installation and real-provider checks. Until those are recorded, treat this as a development recipe, not an already-verified onboarding result.

Run `bb self-improve doctor` and `bb self-improve status` in that scratch instance. The plugin starts with scheduling disabled. You can inspect empty ledgers and enter goals before enabling background learning.

## Choose where work runs

In **Settings → Plugins → Self improve**, the `config` JSON names an existing worker `projectId` and `environmentId`. Use a dedicated scratch environment appropriate for the material you are analyzing. `scopeProjectIds` records intended improvement scope; this preview withholds historical artifacts from new native instruction contributions.

Open **Self improve → Execution** above the dashboard. Use BB's provider/model picker and permission picker, then select **Save execution**. Choices are resolved for the configured environment. If configuration changes while you edit, reload before saving.

Sign in through the selected provider's normal BB workflow. Existing BB routing and supported failover belong to BB. There is no Self improve model-account setting or separate model API key. Do not copy another installation's credentials into scratch.

Ordinary provider/workspace instructions and tools may remain. A dedicated environment reduces incidental dependencies; it is not proof that an agent cannot reach held-out tests.

## Set privacy and cost preferences

Add names or identifiers to remove in `redactedNames`. Review the scope of the source material: the worker project chooses where analysis executes; it does not filter all observed source projects.

Agent work is allowed by default and every session is tracked; see [costs](costs.md) for where to see what each action used and for optional limits.

The remaining settings are:

| Setting | Purpose |
| --- | --- |
| `enabled` | Enables scheduled enqueueing and optional detector calls. Defaults to `false`. Explicit manual requests still queue work. |
| `dairToken` | Optional secret DAIR token, separate from BB model authentication. |
| `evaluationSuite` | Secret JSON containing development and held-out cases. Native experiments use development cases only; the held-out gate stays blocked. |

No evaluation suite is needed simply to add a problem or explore the ledgers. An unavailable task-outcome source remains a visible coverage gap; see [task outcome sources](task-outcomes.md).

## Add something worth improving

Choose **Add problem / goal**. For a problem, describe what happened and what you expected. For a goal, add a metric, unit, target and direction. For example: “time to targeted test result,” seconds, `30`, lower. This is an example input, not a measured result.

**Focus on this** directs the next research snapshot without fabricating observed votes. Select a record and use **Explore and edit in chat** to investigate it with BB's own conversation UI. Edits retain versions and audit reasons.

## Run a small pass

```sh
bb self-improve run --stage miner
bb self-improve status
bb self-improve costs
```

Queueing is not completion. Inspect the run for success, deferral or failure; finding no new evidence can be a correct result.

For research, run **problem-ranker**, then **scout** and **inventor**. Both streams must finish against the same snapshot before **solution-ranker**. A builder request needs an eligible candidate and development cases; any result remains exploratory in this preview.

Enable scheduling after you have inspected the manual path. Mining runs every 15 minutes. The daily stages use the BB server's local timezone. Optional Laya provides asynchronous early hints without replacing that schedule.

## Know what to expect next

A fresh install will not produce established improvements through native automatic adoption: verified held-out isolation is still missing. Historical established records keep their evidence and show activation qualifications. Basic re-tests preserve earlier results.

The complete impact-screen **Promote** and claim-driven **Revalidate** workflows are pending. Draft skill/plugin export is not proof of publication, installation or portability. Do not create dummy proof records to make these actions available.
