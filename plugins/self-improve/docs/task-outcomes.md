# Connect a source of terminal task outcomes

A thread can fail while its task remains open. A task can be blocked without any thread crashing. Those are different facts, so Self improve does not translate thread status into a failed or blocked task.

The default BB task listing does not provide the complete structured history this miner needs. Without a configured producer, doctor reports **terminal task history is unavailable**. Thread evidence can still be mined, but the missing task coverage stays visible.

## Configure an installed producer

Add a `taskOutcomeSource` object to your ordinary plugin configuration:

```json
{
  "taskOutcomeSource": {
    "pluginId": "your-task-history-plugin",
    "method": "taskOutcomes"
  }
}
```

This is a configuration fragment; preserve your model, scope and budget settings when updating the complete config. The producer must be an installed, trusted plugin that owns an authoritative history of task runs. Self improve calls its **public SDK RPC**, not BB's private database or a guessed endpoint. It cannot name Self improve itself as the producer.

After configuring the source, run a miner pass and inspect `bb self-improve doctor`. Its `task-outcomes` coverage entry shows whether the producer supplied complete history or which bounded validation check failed.

## Producer request

The RPC receives this object:

```ts
{
  sinceMs: number;       // Inclusive Unix milliseconds.
  untilMs: number;       // Inclusive Unix milliseconds; fixed across all pages.
  limit: number;         // 1–200 records per page.
  cursor?: string;       // Absent on the first page; opaque thereafter.
}
```

Return a stable snapshot for that requested time window. A cursor must advance and must not repeat earlier cursors. Its value must be a non-empty string of at most 2,048 characters. Use `nextCursor: null` only when pagination is finished.

## Producer response

The response and every run are strict objects: additional fields, including transcripts, raw tool output or private payloads, are rejected.

```ts
{
  runs: Array<{
    taskId: string;
    runId: string;
    day: string;          // YYYY-MM-DD, the UTC date of occurredAtMs.
    occurredAtMs: number;// Integer Unix milliseconds inside the requested window.
    outcome: "failed" | "blocked" | "succeeded" | "running";
    originPluginId: string | null;
  }>;
  nextCursor: string | null;
  complete: boolean;
}
```

`taskId` and `runId` must start with a letter or digit and contain only letters, digits, `_`, `.`, `:` or `-`, up to 200 characters. Their pair identifies a run. Repeating an identical run is safe; conflicting versions in the same paginated snapshot make coverage incomplete. Across mining passes, a running run may become terminal. A previously recorded terminal outcome cannot silently change.

The producer is responsible for recording actual outcomes and preserving provenance. Set `originPluginId: "self-improve"` for this plugin's work, including its descendants and retries; the miner excludes those runs. Do not infer a task's terminal outcome from an attached thread's live status. `running` is a legitimate observation and is not a failure vote.

`complete: true` attests that the producer can supply the full authoritative history for this fixed window. Each page must make that attestation; if any page says `false`, a later `true` does not repair the gap. Pagination still must reach `nextCursor: null`. Return partial coverage honestly when retention, permissions or unavailable history prevent a complete answer.

## Bounded, resumable ingestion

The collector enforces the configured page budget, no more than 200 runs per page, and no more than 10,000 unique runs per collection. Invalid times, mismatched UTC days, page-size violations, conflicting facts, cursor cycles and unavailable RPCs all leave coverage incomplete. Validated observations from earlier pages remain useful; failed validation does not turn missing records into successful tasks.

The miner stores deterministic task votes and run-count observations through its transactional checkpoints. No provider response can supply problem scores, trusted evaluation receipts or solution adoption decisions.
