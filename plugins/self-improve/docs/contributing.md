# Contributing

Start from the behavior you want to change and the evidence that would demonstrate it. Preserve old attempts and explain new uncertainty; a prettier success label is not an improvement to the learning loop.

## Local checks

From this plugin's directory, install its locked dependencies in an isolated development environment, then run:

```sh
npm ci
npm test
npm run typecheck
bb plugin build
```

Tests use SQLite, SDK fake hosts, frontend harnesses and deterministic model/network fixtures. Native task, chat and usage tests exercise the public SDK contract through fakes; they do not prove real-provider behavior or independent context isolation. Older direct-model evaluation fixtures describe a retained historical path, not the current server's execution boundary. Adapter tests should never need live credentials. The visual harness under `test/ui/` uses clearly labeled synthetic records; it is not shipped as a navigation surface.

Use a fresh scratch BB data directory for integration work, with separate ports and a dedicated worker environment. Packaging checks can run with scheduling disabled and without a model provider. Real-provider experiments need an explicitly authorized scope and the supported BB sign-in flow; never copy live credentials into scratch. Record the exact installed source revision and teardown result.

Self improve scopes its own ledger-tool contributions. Ordinary BB/provider/workspace instructions and other tools may remain available. Review native dispatch ownership, durable recovery, cancellation, privacy changes and versioned ledger edits at that actual boundary. Do not describe worker prompts, a minimal workspace or the plugin's tool list as global tool suppression. Native development replay remains exploratory; the preview does not dispatch held-out cases or automatically adopt the result.

## Where things are

`server.ts` is the entry point. `server/wiring.ts` builds the services, background work and settings; `server/rpc.ts` holds the dashboard RPCs, `server/agents.ts` the agent tools and `agents.configure` hook, `server/dashboard.ts` the dashboard data and diagnostics, and `server/cli.ts` the CLI. Stages live in `src/runtime.ts` and `src/build.ts`; costs in `src/native-accounting.ts` (BB usage), `src/costs.ts` (recorded charges) and `src/activity-accounting.ts` (the one budget check and combined views).

## Review the boundaries, not just the happy path

Changes to source collection need cursor, selection, deduplication and self-run exclusion coverage. Cost changes need cross-stage admission, cumulative session amounts, shared attribution, missing/late usage and currency coverage. Native session observations must remain separate from historical estimates and invoice attestations. New model or research inputs need schema, privacy and prompt-injection review. Evaluation changes must preserve the blocked adoption gate until an independent validation boundary is established.

Dashboard changes should exercise loading, empty, stale-version, error and asynchronous selection states. Test the SDK component wiring as well as the pure React view. Run browsers headlessly, close them in `finally`, and inspect narrow screens and both color schemes. Preserve native BB chat and permission handling.

When writing documentation, distinguish illustrations, synthetic fixture screenshots, scratch installation, real-provider execution and measured field results. Keep command examples synchronized with `server/cli.ts`. If a capability is only an adapter, a schema or a proposed study, say so. The complete Promote/Revalidate workflows remain delivery work; creating a draft PR is not evidence of publication, listing or activation.

## What a useful review contains

Tie each finding to a concrete trigger and observable consequence. State which revision was tested, what was run, what failed, and what could not be exercised. A clean test run is evidence for those tests; it is not proof that every security or product requirement holds.

After a fix, reproduce the original failure and check the surrounding boundary. Preserve rejected findings with their reasoning, so later reviewers can assess the same evidence rather than restarting the argument.
