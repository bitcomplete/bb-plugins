# Research informs a hypothesis

Self improve uses research to propose tests. It does not copy a paper's headline result into your solution ledger as if the same benefit had been measured here.

## Discovery

The scout searches DAIR when its authenticated adapter is configured, and falls back directly to arXiv. The [arXiv API manual](https://info.arxiv.org/help/api/user-manual.html) describes queries, dates and versioned identifiers. The adapter serializes requests, persists throttling state and caches responses in accordance with the [legacy API usage terms](https://info.arxiv.org/help/api/tou.html).

Paper provenance retains the work ID and version. Updated versions remain distinguishable. Topic fit, paper age and required credibility evidence affect whether a research-derived candidate can enter the build queue.

arXiv metadata does not supply every requested credibility metric. Missing field-weighted citation impact or author evidence stays unknown. The candidate remains pending when those required fields cannot be verified. An invented candidate has a separate hypothesis path; relabeling a paper-derived candidate would not create missing evidence.

## Read the assessment's scope

For supported arXiv versions, the scout retrieves the public HTML article and extracts bounded text. It does not execute the page's scripts, fetch embedded resources, or interpret figures and images. The extractor rejects incomplete or oversized articles rather than silently treating a partial document as a full-text review.

Impact and Fit are model estimates. Methodological Strength can also be estimated when actual article text is available, with a reason and short quotations grounded in that text. A non-null Strength estimate requires an exact source quotation; retained quotations are limited to three excerpts and 25 words in total. The assessment records the canonical versioned URL and SHA-256 hash of the reviewed text.

If full text is unavailable, Strength stays unknown and the assessment is labeled as metadata-and-abstract review. A persuasive abstract is not a substitute for methods, controls or limitations. Even a grounded full-text estimate is an uncertain reading, not an independent replication or measured improvement in your project.

The research cache holds the extracted public text. Assessment evidence records its hash, URL and short quotes; cached model-assessment results do not duplicate the full article. Read the derived `reports/research.md` digest or `reports/research.json` under the plugin's data directory for paper versions, assessment scope, estimates and reasons for deferral. `access-costs.jsonl` records research access separately from monetary accounting; see [costs](costs.md).

## Research results don't transfer automatically

A paper's benchmark result doesn't carry over to another model, provider, repository or task. Every candidate keeps its provenance, so you can tell a research idea apart from an estimated benefit, a held-out result or a longer-term observation.

## What would count as evidence here?

A solution should have a falsifiable prediction, a test the proposer did not see, an exact artifact revision, recorded wiring, and enough observation after adoption to assess the relevant rate. Cost belongs to the same evaluation: candidate counts alone do not capture model tokens, retries, failures or runtime overhead.

Before/after comparisons remain associations when confounded. Low exposure stays pending. Unknown cost stays unknown. These are useful results because they say what to measure next.
