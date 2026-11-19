# What did the improvement cost?

Self improve records every agent session it starts: which stage started it (mining, research, invention, ranking, a build or test, a revalidation run), which run and solution it belongs to, and the tokens and cost BB reported for it. Editing conversations, detector activity and expenses you record are tracked too. Nothing is blocked to save money by default; the point is that you can always see what each action used.

## Where to look

- **Recent agent work** on the dashboard lists each run, newest first, with its sessions, tokens and any reported cost.
- **BB usage** under a solution or an impact observation totals the agent work attributed to it.
- A revalidation plan shows each of its runs and what it used.
- `bb self-improve costs` prints the records; `activity-costs.json` in the plugin's data directory has the same activity data.

BB reports usage per session after the fact, so the numbers can lag a few minutes behind the work. A missing report is shown as missing, never as free.

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

## Optional limits

Agent work is allowed by default. If you want limits, set them under `budgets`:

| Field in `budgets` | Meaning |
| --- | --- |
| `maxDailyCalls` | Cap on agent sessions started per UTC day. `null` (the default) means no cap. |
| `dailyMicros`, `monthlyMicros` | Stop starting new work once observed spending reaches this amount, in millionths of `currency`. `null` (the default) means no limit. |
| `scopeLimitsMicros` | Optional daily amounts for one stage or one `solution:<id>`. |
| `allowUnknown` | Agent work whose cost BB reports only afterwards. `true` by default; `false` pauses all agent work. |
| `currency` | Currency for the amounts above, default `USD`. |
| `prices` | Price inputs for older estimate records; they do not price subscription usage. |

Limits stop new work from starting once the reported usage reaches them. A session already running finishes, and reports can lag, so a limit can be passed by the work in flight. Revalidation runs count as `builder` work for the solution being tested.

## Research and infrastructure

Research access has its own ledger. The dashboard counts uncached access requests without assigning an invented unit price. Optional Laya detector reservations and owner-entered infrastructure amounts stay separate from those request counts.

Derived files include `activity-costs.json` for native/manual activity, `costs.jsonl` for retained cost events and `access-costs.jsonl` for research access. The database is authoritative. These exports may lag during a failed refresh; restarting a turn is not proof that a missing charge is zero.

## Record an invoice, allocation or credit

`bb self-improve costs --record '<JSON>'` records an owner attestation with `idempotencyKey`, `kind` (`charge`/`credit`), `basis` (`reported`/`estimated`/`unknown`), `amountMicros`, `currency`, `source`, `reference`, `scope` and `occurredAtMs`. Unknown amounts must be `null`. Keep credentials and private client details out of these fields.

Optional `runId` and `solutionId` attribute the expense. `attemptId` links a **settled legacy cost attempt**, where a reported invoice replaces its token estimate. It is not an arbitrary native task ID. A standalone native expense attestation does not automatically reconcile a provider-session floor; both remain separately labeled.

Use `replacesId` to correct the latest unreplaced charge, or a positive reported credit with `appliesToId`. Credits cannot exceed the remaining charge. Definitions and history are immutable; duplicate idempotency keys with different content are refused.

Inspect the records with `bb self-improve costs` and policy with `bb self-improve budgets`. Compare observations, missing reports and failed attempts before raising a limit. Fixture tests validate the accounting rules; real-provider and long-running cost coverage still need evidence at the delivered revision.

## When solutions are merged

The live solution view includes costs recorded against its retained aliases. It selects the full family once, so a shared cumulative provider session is not added again for each alias. A provider session shared with other solutions remains ambiguous.

Original solution IDs, failed attempts and cost records stay unchanged. Performance history includes observations from those aliases, with each observation’s original identity and cost snapshot. Historical snapshots do not change when a later charge arrives or an alias is added; inspect the current cost view for the latest accounting.
