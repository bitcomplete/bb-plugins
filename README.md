# bb-plugins

Plugins for [bb](https://getbb.app), maintained by Bit Complete.

| Plugin | What it does |
|---|---|
| [workstreams](plugins/workstreams) | Maps every git checkout you have in flight into a zoomable board of cross-repo efforts |
| [kubernetes-provider](plugins/kubernetes-provider) | Machine provider that runs each project on its own long-lived pod plus persistent volume in the bb server's namespace |
| [thread-briefs](plugins/thread-briefs) | Gives every thread a durable goal / current state / next step brief, summarized outside the working chat |

Install one:

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin workstreams
```
