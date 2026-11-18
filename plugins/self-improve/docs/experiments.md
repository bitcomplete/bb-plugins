# Does the wording change what you discover?

Self improve supports a paired comparison of **abstract** and **concrete** problem descriptions. Both descriptions come from the same mined evidence. The scout researches each wording, while the study keeps its candidates separate from normal ranking.

This is a workflow for collecting evidence. Installing the plugin does not mean an experiment has run or that one wording is better.

**Native preview limit:** discovery and development replay can collect exploratory observations. The native builder does not dispatch held-out cases or automatically adopt results, so a new native development run cannot satisfy the study's trusted-build or measured-reduction outcome by itself. Missing qualifying outcomes remain missing.

## Decide before collecting

Use `bb self-improve experiments --register '<JSON>'` with these fields:

| Field | Meaning |
| --- | --- |
| `id` | Your stable study identifier. |
| `startsAtMs` | A future start time in Unix milliseconds. Registration must happen first. |
| `endsAtMs` | A later end time. Allow enough time for discovery, review, building and measured follow-up. |
| `sampleSize` | Number of paired evidence samples to collect, from 1 to 10,000. |
| `seed` | Optional private assignment seed. Omit it to let the server generate one. |

The study fixes its metric: paper exposures that lead to a trusted build and then a measured reduction, alongside blinded owner relevance ratings. You cannot quietly rewrite its definition after seeing results. Seeds, generated wordings and arm mappings are excluded from the CLI views.

## Collect a pair from actual evidence

During the registered window, run `bb self-improve experiments --run '<JSON>'` with `experimentId`, `problemId` and `voteIds`. The IDs must refer to the actual mined evidence you want compared. The command queues work in the scout service; BB execution selection, existing sign-in, worker environment and budget prerequisites still apply. Manual jobs can run while scheduling is disabled.

For example, after replacing the IDs with your own:

```sh
bb self-improve experiments --run '{"experimentId":"wording-study","problemId":"problem_id","voteIds":["vote_id"]}'
bb self-improve status
bb self-improve experiments --id wording-study --cards
```

Paper cards have stable identifiers and no arm labels. Rate relevance from 1 to 5 with `bb self-improve experiments --rate '<JSON>'`, supplying `experimentId`, `cardId` and `value`. Ratings are immutable and must be recorded while the window is open. If both wordings find the same paper for a problem, it receives one shared blind rating.

## Review candidates before they join normal work

Inspect isolated proposals with:

```sh
bb self-improve experiments --id wording-study --candidates
```

`bb self-improve experiments --promote CANDIDATE_ID` explicitly moves a reviewed candidate into normal solution ranking. Promotion does not adopt it or supply missing evidence: scores start unknown, the usual eligibility gates apply, and trusted validation is still required. Keep the preregistered end time in mind; a result completed afterward does not count as an in-window outcome.

## Read the outcome honestly

`bb self-improve experiments --id wording-study --report` shows progress throughout the study. Before its end, arm results stay blinded. Afterward, the report shows discovered papers, trusted builds, measured reductions and relevance ratings for each wording. A missing denominator stays unknown. Missing samples or ratings leave the study incomplete.

The report uses the latest qualifying in-window performance result for the built revision, rather than choosing its best historical result. It describes paired outcomes without declaring a causal winner. Differences in exposure, incomplete adoption and low sample counts still matter.

Use `bb self-improve experiments` to list study reports. Supply one action per command. Model work participates in the ordinary [cost and budget policy](costs.md); a preregistration does not reserve permission to exceed that policy.
