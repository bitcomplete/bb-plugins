# What revalidation guarantees

Revalidation tests a claim you doubt. You write test cases (an input and the exact expected answer) and pass criteria, freeze the plan, and queue a run. Each case runs twice in fresh BB threads: once without the solution's instruction and once with it. The server scores the answers and records a verdict.

## Guarantees

1. **You decide.** Only you can freeze, queue or cancel a plan. The editing chat can create and revise drafts only for the solution it is attached to, and cannot revise a version you have queued or are running. Other plugins cannot call any dashboard action. Only the server's runner records results.
2. **The test is what you froze.** Expected answers never appear in a model request. A frozen plan's cases, criteria and instruction text cannot change, and a run uses exactly what was frozen. Model answers are not stored; each keeps a SHA-256 fingerprint, whether it was readable, and whether it matched.
3. **Verdicts only from complete runs.** A verdict (supported or contradicted) is recorded only after every planned call finished and was scored. If you cancel, the plugin is turned off, the worker settings change, the time limit passes, a call fails or the plugin restarts, the run ends with a reason and no verdict.
4. **Scoring.** Answers must be JSON `{"output": "..."}`, optionally inside one code fence. An unreadable answer counts as a failed case on either side, and the result shows how many answers were unreadable. Pass rates and regressions are computed by the server over every case.
5. **Everything is tracked.** Every model call a run makes is recorded against its run, stage and solution and appears in the cost views. Nothing runs in the background while the plugin is off. A run makes at most two calls per case, and retrying a job never repeats calls.
6. **What was tested is recorded.** A frozen plan records the worker provider, model, project, environment and permission mode. A run stops if your worker settings no longer match.
7. **Standing.** For a claim, the most recently frozen plan across all of that claim's plans decides its standing, through its latest completed run. Until that run completes there is no standing. Earlier results stay in the history.

## Limits

- Test runs share ordinary BB, provider and workspace context, so results are exploratory, not isolated or held-out proof.
- A call already running when a run is cancelled or the plugin is turned off may finish; the run still ends without a verdict.
- Usage comes from BB's reports and can be incomplete. There is no hard spending limit.
- Chats you open yourself still work while the plugin is off.
- BB reports the app, the `bb` CLI and agent threads as the same kind of caller. A thread with shell access (the editing chat or a test run, depending on the worker permission mode) can call owner actions through `bb plugin rpc call` and can read the plugin's data directly, including expected answers. Choose a worker permission mode you trust.
- A short answer can be recovered from its fingerprint by anyone who can read the plugin's database.
