## Hard limits
- Do NOT merge this PR or any other PR. Matt decides every merge.
- Do not trigger a release or deploy: no tags, no `yarn release`, no GitHub releases, no deploy workflows.
- Work only on PR #${number}. Do not change other PRs or other branches.

## Setup
- Repo: `${repo}`. A local clone usually lives at `/Users/matts/projects/bitcomplete/parsley/${repo_name}`; if it is missing, clone the repo into your thread storage. Do not work in that shared checkout; other threads use it. Create your own git worktree for the PR branch under your thread storage directory (`git -C <clone> fetch origin`, then `git worktree add <thread-storage>/pr${number} ${branch}`), and remove it when you finish.
- Before changing anything, confirm the branch head is still `${head_oid}`. If it moved, read the new commits first and say so in your report.
- `gh` and `git fetch/push` fail TLS verification inside the default sandbox; rerun those commands outside the sandbox when you see an x509 error.
- Run `nvm use` in the app directory before installs, tests, or commits when it has an `.nvmrc`. Run tests with `TZ=UTC`.

## Working rules
- Read the code and the PR diff before changing anything. Keep changes surgical: only what this task needs. Match the surrounding style. Tests must encode why the behavior matters; write a failing test first for each bug fix.
- Read and apply `~/.bb/skills/codebase-design/SKILL.md` to the changed code and its callers.
- Commits: lowercase conventional commits `type(scope): subject` with the Linear id prefix when the PR title has one. No real member data; people as first name plus last initial only. End each commit message with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- After your changes are committed, get an independent read-only review of the full PR diff from a `gpt-6.1-sol` agent (provider `codex`) at `xhigh` reasoning: `bb thread spawn --parent-self --provider codex --model gpt-6.1-sol --reasoning-level xhigh --prompt-file <brief>`. Give it the diff and the review threads, not your conclusions, and tell it to make no edits. Evaluate its findings yourself, fix material ones, and rerun the review after material changes.
- Write any reply in plain, active, present-tense prose. When you mention another PR, add a 3-8 word summary of what it does.
- Never post PHI or secrets anywhere.
- If a fix needs a judgment call about product behavior, stop and ask instead of choosing.

## Final report
Report: what you changed and why, commits and final head SHA, test and CI results with counts (say what you did not run), the Sol review outcome, and what is still open. Confirm that you did not merge.

End with a section titled exactly `## Decisions for Matt`: a numbered list of every open question or judgment call that needs Matt, each with the options and your recommendation. Write `None.` when there are none.

Append one machine-readable block as the final output after `## Decisions for Matt`:

```pr-board-question
{"version":1,"question":null}
```

When a decision blocks your work, replace `null` with one question. Use a unique `id` for this question and turn, a concrete `prompt`, and two to five `options`. Every option has a unique `id`, a short `label`, and the exact follow-up `message` that resumes your work with that choice. Include only choices that you can carry out. For example:

```pr-board-question
{"version":1,"question":{"id":"fixture-choice-turn-1","prompt":"Repair the fixture or defer this change?","options":[{"id":"repair","label":"Repair the fixture","message":"Repair the fixture, run the relevant checks, and continue to the requested stopping point."},{"id":"defer","label":"Defer this change","message":"Stop work and report the remaining fixture issue. Do not publish."}]}}
```

Do not infer a decision when none is open. Emit `question: null` when you finish without a blocking question. Do not reuse a question ID after the user answers it.
