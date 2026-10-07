# bb-plugins

Plugins for [bb](https://getbb.app), maintained by Bit Complete.

| Plugin | What it does |
|---|---|
| [workstreams](plugins/workstreams) | Maps every git checkout you have in flight into a zoomable board of cross-repo efforts |
| [kubernetes-provider](plugins/kubernetes-provider) | Machine provider that runs each project on its own long-lived pod plus persistent volume in the bb server's namespace |
| [devbox-provider](plugins/devbox-provider) | Machine provider that creates devboxes in your Incus project on bertha, once you connect devbox |
| [thread-briefs](plugins/thread-briefs) | Gives every thread a durable goal / current state / next step brief, summarized outside the working chat |
| [multi-repo](plugins/multi-repo) | Gives a project a set of git repos and every thread a workspace holding a checkout of each |
| [diff-explorer](plugins/diff-explorer) | Scrollable diff of every changed file, with ⌘-click go to definition and Ctrl+- to go back |
| [team-setup](plugins/team-setup) | First-run checklist for a bb-gate server: sign in to Claude or Codex, GitHub (headless `gh auth login`), devbox and Linear, make a machine |
| [linear](plugins/linear) | Connect Linear once with OAuth; threads then read, search, comment on and move issues through native tools, as you |

Install one:

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin workstreams
```
