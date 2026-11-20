# Setup

## First run

Open **Self improve** in the sidebar. **Get started** lists what's needed and ticks each step off.

1. **Choose where agent work runs.** Under **Execution**, pick a project and environment. Agent sessions run there with that environment's ordinary tools, and in accept-edits mode they can change its files, so a scratch environment is safest.
2. **Choose a provider and model**, and a permission mode, then **Save execution**. Self improve uses your existing BB sign-in; there is no separate API key.
3. **Find problems now.** The search reads the last two days of your threads. The line next to the button says when it is running and what the last search found.

After setup, Execution moves behind the **Settings** button at the top of the dashboard.

You can also add a problem or goal yourself with **Add problem / goal**, for example "time to a targeted test result, seconds, lower than 30". **Focus on this** makes research look at it first.

## Test cases

Fixes are only tested, and so only applied, when you give Self improve some development test cases: inputs with the exact answer you expect. Put them in the `evaluationSuite` secret setting (**Settings → Plugins → Self improve**):

```json
{
  "id": "my-cases",
  "development": [
    { "id": "retry-payload", "familyId": "retries", "input": "A request failed with a timeout. Retry it.", "expected": "Retried with the original payload" },
    { "id": "test-scope", "familyId": "tests", "input": "Run only the tests for src/store.ts.", "expected": "npx vitest run test/store.test.ts" }
  ],
  "heldOut": []
}
```

Each case runs once without the fix and once with it; the server compares answers exactly. Up to 50 development cases. Choose cases that reflect the problems you care about.

## Scheduling

Turn on **Run scheduled improvements** to search every 15 minutes and run research, ranking and testing daily (in the BB server's local timezone). Without it, nothing runs in the background; **Find problems now** and `bb self-improve run --stage <stage>` still work.

Optional Laya detection can trigger an earlier search from recent activity; see [configuration](configuration.md).

## Privacy

Add names to hide in `redactedNames`. Text is redacted before it reaches the search agent or is stored. See [privacy](privacy.md).

## From the command line

```sh
bb self-improve doctor     # what's set up and what's missing
bb self-improve run --stage miner
bb self-improve status     # runs and their results
bb self-improve costs
```
