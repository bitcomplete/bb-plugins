# Self improve

**Your agents get better at the things that keep going wrong.**

Self improve reads your recent BB threads, finds failures that keep happening, tests fixes for them, and applies the ones that work to your agents' future turns. You can see every fix, what it adds, what it cost to find, and switch any of it off.

![Problems are found in your threads, fixes are proposed and tested, and the ones that pass are applied.](docs/images/learning-loop.svg)

## How it works

1. **Find problems.** A search agent reads your recent threads (it can open the full conversation and anything it refers to) and records failures worth learning from: corrections you had to make, tool errors, retries. It runs when you press **Find problems now**, or every 15 minutes if you turn scheduling on.
2. **Propose fixes.** For each problem, Self improve proposes a fix: a short instruction for your agents. Ideas come from research (DAIR, then arXiv) and from an agent that sees only the problem.
3. **Test them.** Each fix is tried on your development test cases in fresh BB threads, once without it and once with it.
4. **Apply what works.** A fix that does better, with no regressions, is applied: its text is added to agent turns in your projects through BB's plugin hook. Nothing is written to disk and no skill or plugin is installed.
5. **Stay in control.** The **Improvements** panel lists every applied fix, how many turns received it and what it adds, with **Disable**. Turn off **Apply tested improvements automatically** to approve each fix yourself.

When a problem's cause is in a plugin, a skill, BB itself or a setting, Self improve can only work around it. The problem view then offers a report to send to whoever maintains it.

## Install

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git --subdirectory plugins/self-improve
```

Then open **Self improve** in the sidebar and follow **Get started**:

1. Under **Execution**, choose the project and environment where agent work runs (a scratch environment is safest), then the provider and model. Self improve uses your existing BB sign-in.
2. Press **Find problems now**.
3. Optional: add development test cases (see [setup](docs/setup.md#test-cases)) so fixes can be tested and applied, and turn on scheduling.

## What it uses

Every agent session Self improve starts is recorded against its stage, run and solution with the tokens and cost BB reports. **Recent agent work** on the dashboard lists each run. Agent work is allowed by default; daily caps and spending limits are optional. See [costs](docs/costs.md).

## Read next

- [Setup](docs/setup.md): first run, test cases and scheduling.
- [How it works](docs/how-it-works.md): searching, testing, applying and reports.
- [Configuration](docs/configuration.md): every setting.
- [Costs](docs/costs.md): what's tracked and optional limits.
- [Privacy](docs/privacy.md): what is read, stored and sent.
- [Troubleshooting](docs/troubleshooting.md): common messages and what to do.
