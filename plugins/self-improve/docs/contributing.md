# Contributing

## Local checks

From this plugin's directory:

```sh
npm ci
npm run typecheck
npm test -- --configLoader native test/ui test/improvements.test.ts   # or any subset
bb plugin build
```

Tests use SQLite, the SDK's fake host, React Testing Library and deterministic model and network fixtures; none need credentials. `migrations.test.ts` checks the storage migrations against `migrations.snapshot.json`.

For an end-to-end check, install the plugin into a BB instance with its own data directory and a dedicated worker environment, and leave scheduling off until you have run a stage by hand.

## Where things are

`server.ts` is the entry point. `server/wiring.ts` builds the services, background work and settings; `server/rpc.ts` holds the dashboard RPCs, `server/agents.ts` the agent tools and `agents.configure` hook, `server/dashboard.ts` the dashboard data and diagnostics, and `server/cli.ts` the CLI. Stages live in `src/runtime.ts` and `src/build.ts`; applied improvements in `src/improvements.ts`; costs in `src/native-accounting.ts` (BB usage), `src/costs.ts` (recorded charges) and `src/activity-accounting.ts` (the budget check and combined views). The dashboard is in `src/ui/`.

## What to test

- Source collection: cursors, session selection, deduplication and excluding Self improve's own threads.
- Costs: admission across stages, late or missing usage reports, shared sessions and currencies.
- Model and research inputs: schemas, redaction and treating fetched text as data.
- Applying improvements: only passing fixes apply, disabled ones never reach turns, and the worker project is excluded.
- Dashboard: loading, empty, error and stale-version states, keyboard use, narrow screens and both colour schemes. Run browsers headless and close them in `finally`.

Keep CLI examples in the docs in sync with `server/cli.ts`.
