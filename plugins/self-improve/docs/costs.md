# What did the improvement cost?

A useful change can still cost too much to discover. Self improve tracks native tasks, editing conversations, detector activity, attempts and owner-recorded expenses. Missing cost remains missing.

## Read the labels

| Label | Meaning |
| --- | --- |
| **Observed session floor** | Maximum observed cumulative amount per provider session. Repeated snapshots are not added together. This is not a final bill or necessarily the cost of one task. |
| **Billing unknown** | BB/provider reports do not establish complete billing, including hidden retries or account changes. |
| **Estimated** | A retained legacy/detector estimate under its recorded price version. Native subscription tokens are not repriced this way. |
| **Pending / reserved** | An admitted operation or a legacy estimated reservation awaiting settlement. |
| **Reported charge** | An owner-entered invoice attestation, net of recorded credits. The plugin has not independently verified the bill. |

The dashboard keeps observed BB session amounts separate from charges and estimates. Currency totals stay separate. Shared provider sessions can make per-solution attribution ambiguous: filtered floors may overlap, so do not add them together. General mining/research work can remain outside a particular solution's attribution.

Native usage records retain task, thread, requested provider/model, public request/root-turn observations and optional session usage. The requested model is not proof of every hidden retry's actual model. Missing reports, later missing amounts and counter resets remain qualified. A subscription is not converted into an invented API invoice.

## Set an admission policy

| Field in `budgets` | Meaning |
| --- | --- |
| `currency` | Currency for thresholds, default `USD`. No invented exchange rates. |
| `dailyMicros`, `monthlyMicros` | Observed spending thresholds in millionths of the currency; `null` means no monetary threshold. |
| `maxDailyCalls` | Shared admissions/observed-request threshold per UTC day, default `100`. It is not a count of every provider-internal retry. |
| `allowUnknown` | Explicitly authorize native work whose final cost cannot be bounded in advance. Defaults to `false`. |
| `scopeLimitsMicros` | Optional daily stage or `solution:<id>` thresholds. |
| `prices` | Versioned price inputs for retained legacy/detector estimates; they do not price native subscription usage. |

One currency unit is 1,000,000 micros. Native agent work requires `allowUnknown:true` even if `prices` names the selected model. That setting is a spending decision, not evidence that the operation is free.

Native task admissions have durable identity, call and concurrency checks. Manual chat uses observed-budget preflight: BB's inline dispatch hook has no stable request ID, so repeated hook checks are not counted as new turns. Initial conversation admission is recorded once; later requests/root turns come from public events. Reporting lag, concurrent turns, Send-now overrides, edits and compaction limit enforcement.

These controls can stop **future admissions** using available reports. They cannot guarantee a dollar ceiling for an opaque native turn already running. Cancellation and elapsed-time limits are best effort. BB owns provider routing, retry and failover; the plugin reports unsupported accounting precision honestly.

## Research and infrastructure

Research access has its own ledger. The dashboard counts uncached access requests without assigning an invented unit price. Optional Laya detector reservations and owner-entered infrastructure amounts stay separate from those request counts.

Derived files include `activity-costs.json` for native/manual activity, `costs.jsonl` for retained cost events and `access-costs.jsonl` for research access. The database is authoritative. These exports may lag during a failed refresh; restarting a turn is not proof that a missing charge is zero.

## Record an invoice, allocation or credit

`bb self-improve costs --record '<JSON>'` records an owner attestation with `idempotencyKey`, `kind` (`charge`/`credit`), `basis` (`reported`/`estimated`/`unknown`), `amountMicros`, `currency`, `source`, `reference`, `scope` and `occurredAtMs`. Unknown amounts must be `null`. Keep credentials and private client details out of these fields.

Optional `runId` and `solutionId` attribute the expense. `attemptId` links a **settled legacy cost attempt**, where a reported invoice replaces its token estimate. It is not an arbitrary native task ID. A standalone native expense attestation does not automatically reconcile a provider-session floor; both remain separately labeled.

Use `replacesId` to correct the latest unreplaced charge, or a positive reported credit with `appliesToId`. Credits cannot exceed the remaining charge. Definitions and history are immutable; duplicate idempotency keys with different content are refused.

Inspect the records with `bb self-improve costs` and policy with `bb self-improve budgets`. Compare observations, missing reports and failed attempts before raising a limit. Fixture tests validate the accounting rules; real-provider and long-running cost coverage still need evidence at the delivered revision.
