# Learn from a change you already made

Perhaps you fixed a recurring problem before installing Self improve. A retrospective can mine the history around that change without adding old observations to today's problem ranking.

Pick an existing solution and supply the time it went live. The plugin examines **seven days before** and **seven days after** that time. An event at the go-live time belongs to the after window; an event at the end of the after window belongs to neither window.

## Start and inspect a retrospective

Use `bb self-improve solutions` to find the solution ID. Replace the example ID and timestamp below with your actual change; `1793491200000` is November 1, 2026 at midnight UTC.

```sh
bb self-improve retro --solution solution_id --go-live-ms 1793491200000
bb self-improve status
bb self-improve retro --solution solution_id
```

The first command queues a verifier job. It captures the active artifact's immutable project scope, or uses your explicitly configured `scopeProjectIds` when no matching artifact exists. BB provider/model selection, existing sign-in, worker environment and budget prerequisites still apply. Manual jobs can run while scheduling is disabled.

After the run, copy its retrospective `id` and inspect the detailed ledger:

```sh
bb self-improve retro --id retrospective_id
```

Use `bb self-improve retro` to list all retrospective reports. `--id` is a detail lookup and cannot be combined with the other flags. Repeating the same solution, go-live time and project scope resumes the existing retrospective snapshot.

## A separate notebook

Retrospectives use their own problems, votes, session selections and mining cursors in the SDK-owned database. They copy the solution's current definition when the retrospective starts, then keep that snapshot fixed across retries. Live problems, rankings, performance and solution status do not change.

Each finding keeps its original thread, turn and event pointer. Model inputs use the ordinary source minimization and redaction path. Retrospective workers have a separate cache scope, so an earlier live-mining answer cannot silently stand in for historical analysis.

Run IDs connect the retrospective to normal [cost accounting](costs.md). Native analysis uses BB threads and existing authentication, with the same shared admission policy as other agent stages. Observed session amounts are floors, and missing billing remains unknown; native work requires `budgets.allowUnknown:true`. There is no plugin-owned model-account pool or guaranteed monetary ceiling. Historical mining is not free simply because the source events already exist.

## Counts are useful. Missing history still matters.

The report includes its two time windows, selected session-day counts, matching symptom votes, coverage gaps and worker run IDs. The detailed ledger also contains the committed cursors and original evidence pointers.

Only fully mined selected session-days enter the displayed denominator. At most one session per task/day is selected. A session-day that has observations on both sides of the change can appear in both windows; each vote appears only in its own window. Task and scheduled-job observations never borrow the thread-session denominator. A project-scoped retrospective omits scheduled jobs whose public history cannot establish their project scope and reports the gap.

The retrospective stays **PENDING** because a supplied go-live timestamp does not prove that the instruction ran in those historical sessions. It cannot establish a causal improvement or promote a solution to proven. Missing model identity, unavailable history, unfinished mining and an after window that has not elapsed are additional visible gaps. Observed rates remain descriptive; confidence intervals and a relative-effect estimate are withheld.

The supported history limit is 90 days from the current time to the start of the before window. Older requests are recorded as pending without fetching sources or inventing session counts. Source pagination limits can also leave coverage incomplete. Retrying resumes committed mining progress; it does not erase successful findings or charge for a new analysis of an already committed event batch.

Retrospective observations answer “what can we recover from this period?” Use the Improvements panel, recorded instruction exposure and independent validation when deciding whether a change earns adoption or a stronger efficacy claim. The native preview does not establish held-out isolation or automatically adopt a development result. A retrospective cannot fill that gap.
