# How it works

![Problems are found in your threads, fixes are proposed and tested, and the ones that pass are applied.](images/learning-loop.svg)

## The stages

| Stage | When it runs with scheduling on | What it does |
| --- | --- | --- |
| Miner (Find problems) | Every 15 minutes, plus a daily catch-up at 01:00 | A search agent reads recent threads and records failures worth learning from. |
| Problem ranker | 02:00 | Orders problems by how often and how recently they happen, plus your focus. |
| Scout | 02:15 | Looks for relevant research (DAIR, then arXiv) and proposes fixes from it. |
| Inventor | 02:15 | Proposes fixes from the problem alone. |
| Solution ranker | 03:00 | Orders candidate fixes by expected benefit, effort and risk. |
| Builder | 03:15 | Tests the top candidate on your development cases and applies it if it passes. |
| Verifier | 04:00 | Has no work of its own; it stays registered so existing schedules and queued jobs settle. |

Times use the BB server's local timezone. Each stage can also be run by hand with `bb self-improve run --stage <stage>`. Self improve's own threads are never treated as problems.

## Finding problems

The search agent gets each recent conversation as an index of its events (your messages, assistant replies, tool calls and their status, errors) and reads whatever it needs with a read-only tool: full text, surrounding turns, earlier history, or other threads the conversation refers to. It records a failure only when it can point to a specific event, such as a correction you made, a tool error or a retry. Long conversations are analysed in parts across searches, so nothing is skipped.

Each problem keeps its symptoms, likely cause, where that cause seems to be, and the events it came from.

## Testing fixes

A fix is a short instruction for your agents. The builder runs each of your development test cases twice in fresh BB threads, once without the fix and once with it, and compares the answers with the expected ones. A fix passes when it gets more cases right and none wrong that were right without it.

Test threads run with your normal BB setup, so they can see ordinary BB and workspace context. Treat results as good evidence, not isolated proof.

## Applying improvements

A fix that passes is applied, unless you turned off **Apply tested improvements automatically**; then it waits under Improvements with an **Apply** button.

Applied fixes reach agents through BB's plugin hook: when a turn starts, BB asks Self improve for anything to add, and Self improve returns the text of its enabled improvements. Nothing is written to disk and no skill or plugin is installed. Turns in every project except the worker project receive them, or only the projects listed in `scopeProjectIds`. At most 10 improvements and about 2,000 characters are added per turn; any beyond that show as waiting.

The **Improvements** panel lists each applied fix, how many turns received it and what it adds, with **Disable** and **Enable**. A change takes effect from the next turn.

## Problems outside the agent

When a problem's cause seems to be in a plugin, a skill, BB itself or a setting, Self improve can work around it with an instruction but not fix it. The problem view offers **Draft a report to send**: what happens, where, the likely cause, the evidence, any workaround in use and suggested fixes, ready to copy. For a plugin installed from GitHub it also links **Open an issue** in that plugin's repository. Self improve never edits code or files it doesn't own.

## Checking a claim again

If you doubt that a fix really helps, a revalidation plan tests it again on cases you choose. The engine runs on the server; there is no screen for it yet, but the editing chat can draft plans. See [revalidation](revalidation.md).

## Where things are stored

Everything lives in the plugin's own database, with an audit history of every change. Reports in the plugin's data directory are read-only exports. Make changes through the dashboard, the editing chat or the CLI.
