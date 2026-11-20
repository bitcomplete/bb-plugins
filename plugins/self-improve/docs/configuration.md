# Configuration you can reason about

Use BB's execution pickers for provider/model and permission choices. Keep workflow settings in `config`; optional DAIR credentials and evaluation cases have separate secret settings.

Read public configuration with `bb self-improve config`. The settings editor or `bb self-improve config --value '<complete JSON>'` replaces the JSON; omitted fields take defaults. Invalid JSON/schema values are surfaced in doctor.

## BB execution and scope

| Field | Default | Meaning |
| --- | --- | --- |
| `providerId`, `model` | Empty | Explicit BB provider and model selection. No provider is silently chosen. |
| `reasoningLevel`, `serviceTier` | Unset | Optional BB execution preferences. Host picker changes save one coherent selection. |
| `permissionMode` | `accept-edits` | Requested BB permission mode; BB/provider capabilities still govern execution. |
| `projectId`, `environmentId` | Empty | Existing BB worker project and environment to reuse. Configure these before using the host pickers. |
| `taskTimeoutMs` | `120000` | Autonomous task deadline; range 1,000–900,000 ms. Cancellation is best effort at the provider boundary. |
| `scopeProjectIds` | `[]` | Projects whose turns receive applied improvements. Empty means every project except the worker project. |
| `autoApply` | `true` | Apply fixes that pass their test runs without waiting for you. Each applied improvement can still be disabled. |
| `concurrency` | `3` | Concurrent native task admission/mining limit, range 1–20. Manual conversations are a separate execution path. |
| `maxThreadsPerRun` | `1000` | Discovery page budget, range 1–10,000; not an exact combined active/archived thread cap. |
| `maxEventsPerSession` | `500` | Events per analysis, range 10–500. |
| `redactedNames` | `[]` | Additional identifiers removed by the privacy adapter. |
| `taskOutcomeSource` | Unset | Installed plugin ID and public RPC method for authoritative task history. |

The worker project controls execution location, not all source observation scope. Ledger chat binds to its selected record, execution selection and privacy generation. Changing execution or privacy can revoke a conversation and require reopening it from the ledger; history remains preserved.

## Authentication, tools and failover

Self improve spawns BB threads for every agent stage and ledger conversation. Use the provider's existing BB sign-in. If BB Account Pooler or provider retry/failover is configured, this plugin inherits what that path supports. It does not add a vendor gateway, a bundled API-key pool or independent account rotation.

Self improve scopes its own ledger-tool contributions. Other BB, provider, workspace and plugin context/tools may remain. The inventor gets problem-only input **from this plugin**, not a guarantee of universal isolation. A provider/model identifier accepted by the API is not real-provider conformance evidence.

## Problem ranking

`ranking` contains `version`, `halfLifeDays`, `perSourceDayCap` and weights for `owner_correction`, `failed_task`, `blocked_task`, `failed_job`, `task_looped`, `tool_error` and `tool_retry`. Snapshots retain the policy that produced their scores. Owner focus is separate from evidence-derived votes.

## Research and optional detection

DAIR discovery uses `dair.endpoint` and explicit `searchTool`, `queryArgument` and optional `resultsPath`. Configure the separate `dairToken` secret. `bb self-improve doctor --research-tools` requests the authenticated tool schemas; it is a network operation, not an offline diagnostic.

Weekly discovery uses `weeklyTool`, optional `weeklyArguments` and `weeklyResultsPath`. Missing or incompatible DAIR access falls back directly to **arXiv**. Article text and credibility measures that cannot be obtained stay unknown; the plugin does not fabricate eligibility metrics. Authenticated DAIR validation remains part of delivery work.

`laya` contains `enabled` (default `false`), an optional endpoint and `minConfidence` (default `0.8`, allowed 0.8–1). It requires scheduling enabled and `budgets.allowUnknown` left at `true`. The detector consumes a bounded, redacted recent window asynchronously, excludes this plugin's workers and can queue an earlier mining pass. A failure or uncertain response does not suppress the 15-minute fallback. Enable only an endpoint you intend to receive that context.

## Test cases

The builder tests candidate instructions against your **development cases** in ordinary BB threads. It never changes repositories.

The `evaluationSuite` secret retains the schema `id`, `development` (1–50 cases) and `heldOut` (0–100 cases, kept aside and not sent to test threads). Cases contain `id`, `familyId`, `input` and `expected`, with disjoint task IDs, families and normalized inputs across the two sets. Outputs use exact comparison. Keep private cases out of chats and public reports.

**Test runs use development cases in ordinary BB threads.** A fix is applied when it gets more cases right with no regressions. That is good evidence, not isolated proof. See [setup](setup.md#test-cases) for an example.

## Other controls

`enabled` controls scheduled enqueueing; manual stage requests remain explicit queued work. `budgets` controls shared admission and observation thresholds; see [costs](costs.md).

The exact schema is [config.ts](../src/config.ts). Settings are defined in [server/wiring.ts](../server/wiring.ts) and commands in [server/cli.ts](../server/cli.ts). An invalid value is refused with the field that failed, for example `Invalid configuration at budgets.currency`; keys from earlier versions that no longer configure anything are ignored.
