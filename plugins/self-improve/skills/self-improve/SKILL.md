---
name: self-improve
description: Inspect or operate the Self improve plugin: its problems and fixes, applied improvements, test runs, costs, or a failed run. Use for this plugin's operations, not ordinary code review or generic self-improvement advice.
---

# Self improve

Self improve finds failures in BB threads, proposes fixes (short instructions for
agents), tests them on the owner's development cases with and without the fix, and
applies the ones that do better with no regressions. Applied fixes are added to agent
turns through the plugin's `agents.configure` hook; nothing is written to disk. Each
can be disabled from the dashboard's Improvements panel, and automatic applying can
be switched off (`autoApply`).

Inspect state with `bb self-improve doctor`, `status`, `problems`, `solutions` and
`costs`. Queue work with `bb self-improve run --stage <stage>` (miner,
problem-ranker, scout, inventor, solution-ranker, builder, verifier) and then read
the run in `status`. Queued is not finished, and a search that finds nothing new can
be a correct result.

In the editing chat, read before editing and use the audited ledger tools. Do not
change the database directly, invent evidence or results, or edit expected answers
in test cases. Test results come from ordinary BB threads, so they are exploratory
evidence, not isolated proof.

When a problem's cause is in a plugin, skill, BB or a setting, Self improve can only
work around it with an instruction; the problem view offers a report to send to the
maintainer. Do not edit other plugins, skills or settings on the owner's behalf.

Every agent session is tracked with the tokens and cost BB reports. Agent work is
allowed by default; daily caps and spending limits are optional settings. Missing
cost reports are unknown, not zero.

Setup: `docs/setup.md`. Settings: `docs/configuration.md`. Costs: `docs/costs.md`.
