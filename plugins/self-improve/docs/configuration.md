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
| `scopeProjectIds` | `[]` | Intended instruction scope and retained historical scope. Native activation is currently withheld pending valid proof. |
| `concurrency` | `3` | Concurrent native task admission/mining limit, range 1–20. Manual conversations are a separate execution path. |
| `maxThreadsPerRun` | `1000` | Discovery page budget, range 1–10,000; not an exact combined active/archived thread cap. |
| `maxEventsPerSession` | `500` | Events per analysis, range 10–500. |
| `redactedNames` | `[]` | Additional identifiers removed by the privacy adapter. |
| `taskOutcomeSource` | Unset | Installed plugin ID and public RPC method for authoritative task history. |
| `publicationRepositories` | `[]` | Allowed GitHub destinations for the existing explicit draft-PR export action. |

The worker project controls execution location, not all source observation scope. Ledger chat binds to its selected record, execution selection and privacy generation. Changing execution or privacy can revoke a conversation and require reopening it from the ledger; history remains preserved.

## Authentication, tools and failover

Self improve spawns BB threads for every agent stage and ledger conversation. Use the provider's existing BB sign-in. If BB Account Pooler or provider retry/failover is configured, this plugin inherits what that path supports. It does not add a vendor gateway, a bundled API-key pool or independent account rotation.

Self improve scopes its own ledger-tool contributions. Other BB, provider, workspace and plugin context/tools may remain. The inventor gets problem-only input **from this plugin**, not a guarantee of universal isolation. A provider/model identifier accepted by the API is not real-provider conformance evidence.

## Problem ranking

`ranking` contains `version`, `halfLifeDays`, `perSourceDayCap` and weights for `owner_correction`, `failed_task`, `blocked_task`, `failed_job`, `task_looped`, `tool_error` and `tool_retry`. Snapshots retain the policy that produced their scores. Owner focus is separate from evidence-derived votes.

## Research and optional detection

DAIR discovery uses `dair.endpoint` and explicit `searchTool`, `queryArgument` and optional `resultsPath`. Configure the separate `dairToken` secret. `bb self-improve doctor --research-tools` requests the authenticated tool schemas; it is a network operation, not an offline diagnostic.

Weekly discovery uses `weeklyTool`, optional `weeklyArguments` and `weeklyResultsPath`. Missing or incompatible DAIR access falls back directly to **arXiv**. There is no OpenAlex path. Article text and credibility measures that cannot be obtained stay unknown; the plugin does not fabricate eligibility metrics. Authenticated DAIR validation remains part of delivery work.

`laya` contains `enabled` (default `false`), an optional endpoint and `minConfidence` (default `0.8`, allowed 0.8–1). It requires scheduling enabled and `budgets.allowUnknown:true` because infrastructure cost is not automatically invoiced. The detector consumes a bounded, redacted recent window asynchronously, excludes this plugin's workers and can queue an earlier mining pass. A failure or uncertain response does not suppress the 15-minute fallback. Enable only an endpoint you intend to receive that context.

## Held-out evaluation

The current native builder tests reusable instruction candidates against **development cases**. It uses BB threads with ordinary native context limits, not a private stateless model endpoint. It does not automatically patch arbitrary repositories.

The `evaluationSuite` secret retains the schema `id`, `development` (1–50 cases) and `heldOut` (3–100 cases). Cases contain `id`, `familyId`, `input` and `expected`, with disjoint task IDs, families and normalized inputs across the two sets. Outputs use exact comparison. Keep private cases out of chats and public reports.

**The native path does not dispatch held-out cases or satisfy the isolation gate.** Development replay can record baseline/treatment observations, but automatic adoption stays blocked. Passing a toy fixture demonstrates plumbing, not independent proof or longitudinal efficacy. Historical direct-model receipts remain historical; they do not validate the new execution environment.

## Publish a reviewed export

The existing export path prepares reviewable skill/plugin files and can submit a draft PR to an allowed `owner/repo`, using the BB server's existing `gh` authentication. Inspect the exact files, evidence, destination and bundle fingerprint before authorizing that external write. New directories are required; the action does not merge or install the result.

This basic path is **not the completed Promote workflow**. Actual repository availability, release/listing reconciliation, later versions, claim eligibility and packaged portability validation are still being developed. Treat any legacy internal `published` label for draft-PR creation as a submission record, not a release.

## Other controls

`enabled` controls scheduled enqueueing; manual stage requests remain explicit queued work. `budgets` controls shared admission and observation thresholds; see [costs](costs.md).

`experimentalParentLinks` and `experimentalMatchAudit` default to `false` and remain unimplemented flags. Paired wording experiments have a separate CLI workflow; they are exploratory studies, not a claim that BB enforces context isolation.

The exact schema is [config.ts](../src/config.ts), and registered commands/settings are in [server.ts](../server.ts).
