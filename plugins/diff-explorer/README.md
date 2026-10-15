# Diff Explorer

A [BB](https://getbb.app) plugin. Review a thread's changes, and jump into the code behind them.

![Diff view](screenshots/diff.png)

## What it does

- Shows every changed file in one scrolling view.
- Switches between **Uncommitted** and **All changes** since the base branch.
- ⌘-click a symbol (or press F12) to open its definition.
- Jump again to go deeper. Press **Ctrl+-** to go back one level.
- Opens from the thread header button, or with **⌘⇧D**.
- If autosave detects a disk conflict, the file's **Discard edit and reload** action replaces only that editor's unsaved text with the current disk version. Ordinary refreshes preserve unsaved edits.

![Go to definition](screenshots/go-to-definition.png)

## Install

```sh
bb plugin install git:https://github.com/arashout/bb-plugin-diff-explorer.git
```

## Go to definition needs a language server

| Language | Server (on your PATH) |
|---|---|
| TypeScript, JavaScript | Node.js 20+ with `npx` (downloads pinned TypeScript 5.9.3 and language server 5.1.3 on first use) |
| Go | `gopls` |
| Rust | `rust-analyzer` |
| Python | `pyright-langserver` |
| C, C++ | `clangd` |
| Swift | `sourcekit-lsp` |

Other languages still show the diff.

## Issue reports

**Report issue** saves diagnostics to the plugin's inbox without sending a
thread message or starting an agent. **Settings → View reports** opens the latest 20 snapshots
from all threads. Each snapshot has an ID, timestamp, source thread ID, and
setup details; it excludes file contents.

Reports use BB's plugin key-value storage in `bb.db`. They survive plugin
reloads, BB restarts, and source-thread deletion. Older reports remain stored
and can be retrieved by ID. This is local BB storage, so its durability depends
on keeping or backing up the BB data directory.

```sh
bb diff-explorer reports
bb diff-explorer report <id>
```

## Develop

Use pnpm 10.34.6 and Node 22.23.3 from this directory:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build:monaco   # after changing scripts/multi-diff.js, scripts/diff-search.js, or Monaco
bb plugin install .
```

Dependencies use exact versions and a committed pnpm lock. Install scripts are
blocked unless their package and version are approved in `pnpm-workspace.yaml`;
newly published versions must be at least one day old. CI rejects high or
critical dependency advisories, and its GitHub Actions use pinned commit hashes.

BB's Git plugin installer currently uses npm, so `package-lock.json` remains
as its compatibility lock. After a dependency update, regenerate that lock with
`npm install --package-lock-only --ignore-scripts --legacy-peer-deps`, then run
`node scripts/check-dependencies.mjs` and `pnpm install --frozen-lockfile`.

## License

MIT. Bundles Monaco and code adapted from VS Code (both MIT, © Microsoft).
