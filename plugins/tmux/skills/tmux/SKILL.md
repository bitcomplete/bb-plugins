---
name: tmux
description: "Explain or configure the Tmux keys plugin: how it applies the user's tmux config on top of the keys of stock tmux, its prefix key, its pane, thread, sidebar and thread chooser keys, its copy mode and copy on select, the i key for the message box, its settings, and its known limits."
---

# Tmux keys

Use this when the user asks what a key of the Tmux keys plugin does, why a key
did nothing, how their tmux config is used, or wants a setting changed. The
plugin id is `tmux`. It has no CLI command or agent tool. Besides its keys it
copies on mouse selection (`copyOnSelect`), draws a thin border on the focused
pane and a ring on a focused sidebar row, shows pills (labels: the prefix key,
`COPY` or `SELECT`; a hidden live region tells screen readers "Prefix armed",
"Copy mode", "Copy mode, selecting", once "Copy mode ended"), and reopens the
focused pane's thread once after bb restarts. All off until `enabled` is set.

## The rule

The plugin behaves like stock tmux, and the user's tmux config is applied on
top. Stock tmux means tmux 3.5a as it starts without a config file. The
plugin holds tmux's stock keyboard bindings as config text, reads that text
first and then the tmux config of the user, and turns every tmux command
into what bb can do. tmux has windows where bb has threads (a thread is one
conversation with an agent), so tmux's window commands act on threads.

- The keys are not fixed. "Stock keys" below holds only for a user without a
  tmux config. Do not present it as the user's keys before you know that. To
  change a key, the prefix included, the user changes their tmux config: a
  file, or the lines in the setting `tmuxConfigText`.
- The key help shows the keys in effect and where they come from. The user
  opens it with the prefix then `?` (stock), or with "Tmux: Show keys" from
  bb's command palette, which needs no prefix. Ask what it says.
- Never start tmux to find something out: that runs the user's config. Say
  only what this file says about tmux, and add no claims from memory.

## How one key press is handled: the first rule that applies decides

1. Paused in the window, `enabled` off, or the settings or the tmux config
   not known yet: the key goes to bb.
2. Cursor in a dialog, menu or popup of bb, in the thread chooser, the key
   help, the Browse dialog or the embedded browser page: the key goes there.
3. The prefix is armed (no time limit, or `prefix-timeout`): the key runs
   from the prefix table, else the root table, or is swallowed without an
   equivalent. The prefix ends, but an unbound prefix key keeps it armed.
4. Within `repeat-time` after a key bound with `-r`: a key bound with `-r` in
   the prefix table runs without the prefix. Another key ends that time.
5. The key is the prefix or the second prefix: it arms the prefix, also in a
   text field, the terminal, copy mode and the sidebar.
6. Copy mode is on and the copy table binds the key: it runs, or is
   swallowed when its command has no equivalent.
7. A key of the root table (bound to work without the prefix): it runs.
8. On a sidebar thread row reached from the keyboard: the list and split keys.
9. Cursor in a text field or the terminal: the key is typed.
10. Copy mode is on: a key without Ctrl, Alt or Cmd is swallowed.
11. `i` without Shift puts the text cursor in the message box of the focused
    pane, the field for a message to the agent. Every other key goes to bb.

As in a terminal, `Ctrl-[`, `Ctrl-m` and `Ctrl-i` count as `Escape`, `Enter`
and `Tab` in rules 6, 8 and 10, the thread chooser and the key help, unless
bound themselves. A key that takes the user to a pane, and a key that leaves
copy mode, ends with the text cursor in that pane's message box.

## What each tmux command does in bb

- `select-pane -L/-D/-U/-R`: the pane on that side, of several the one focused
  last. As in tmux, down, up and right go around at the window edge. Left from
  the leftmost or only pane goes to the sidebar's thread list, and right there
  goes back. `-t '{left-of}'`, `'{right-of}'`, `'{up-of}'`, `'{down-of}'` (also
  after `.`, `:.`): the pane tmux finds, also around the left edge, never the
  sidebar; from a zoomed pane only at the opposite window edge. None: no move.
- `select-pane -t :.+` / `:.-` (also `'{next}'`, `'{previous}'`): next /
  previous pane in the order of the splits, as in tmux's pane list.
- `last-pane`, `select-pane -l` / `-t !` / `-t '{last}'`: the open pane that
  had the focus before, or the other one of two when none is remembered.
- `split-window`, `split-pane`, `splitp`: thread chooser for a new pane below,
  with `-h` to the right. `new-window`: new thread in the focused pane. Other
  flags change nothing: `-b` still splits right or below, and `-d` is ignored.
  Either with a shell command: no equivalent.
- `kill-pane`, also inside `confirm-before`: close the pane, no question. As in
  tmux, the pane that had the focus before gets it.
- `resize-pane -Z`: zoom, or undo it (behind a move to another pane in one
  binding: leave it zoomed). `resize-pane -L/-R/-U/-D [n]`: move a divider by n
  cells, 1 without n, of `resizeCellPx` pixels: the one on the right or bottom
  edge of the focused pane, else on its left or top edge.
- `copy-mode`: enter it, with `-u` / `-d` one page up / down. `-q` leaves it.
- `next-window`, `previous-window`, `select-window -n` / `-p` / `-t +` / `-t
  -`: next / previous thread. `last-window`, `select-window -l` / `-t !`: the
  thread this pane showed before, unless archived or deleted. `'{next}'`,
  `'{previous}'`, `'{last}'` stand for `+`, `-`, `!`. `select-window -t N`
  (also `:N`, `=N`, `:=N`): thread N - `base-index` + 1, in `threadOrder`
  order. `-t ^` / `:^` / `'{start}'` and `-t :$` / `'{end}'`: the first and
  the last thread of that order, whatever `base-index` is. No equivalent: `-t
  $` alone (a session in tmux), these with `=`, a session or a pane.
- In a config a name in braces needs quotes (a bare `{` opens a block). Any
  other name (`'{top}'`, `'{marked}'`) or text around one (`'{next}1'`): no
  equivalent. A flag tmux does not know for a command is one without a value.
- `choose-tree`, `choose-window`, `choose-session`: thread chooser for the
  focused pane. `list-keys`: key help.
- `send-prefix` (`-2`: the second prefix): passes the prefix key on to the
  terminal or text field, by letting the key press through, so it only works
  on that prefix key itself. In copy mode it runs the key's copy binding.
- `source-file PATH`: reads the tmux config again, not PATH, rebuilds the
  keys and says whether all of it was read, or that the keys stay.
- `display-message TEXT`: shows TEXT, unless it holds `#` or `%` + a non-blank.
- `send-keys -X NAME` (also `send`, `-N count` to repeat) in a copy table:
  every command that the stock tables below name. history-top / -bottom go
  to the first / last text of the conversation, scroll-up / -down move it by
  `scrollStepPx` pixels, begin-selection starts a selection at the cursor,
  clear-selection drops it, cancel leaves copy mode. `copy-selection`,
  `copy-pipe`: copy, drop the selection, stay. With `-no-clear`: copy and
  keep it. With `-and-cancel`: copy and leave, also with nothing selected.
- Anything else, such as `swap-pane`, `kill-pane -a` or `next-window -a`: no
  equivalent. The key stays bound, does nothing and is not in the key help.
  Such a root table key is not taken: it reaches bb and the terminal.

## Stock keys

Each key is given with the tmux command it is bound to. `Alt` is the Option
key on a Mac. "(repeats)" marks a key bound with `-r`.

After the prefix, which is `Ctrl-b`: `Up` `Down` `Left` `Right` select-pane -U
/ -D / -L / -R (repeats); `o` select-pane -t :.+; `;` last-pane; `%`
split-window -h; `"` split-window; `x` kill-pane; `z` resize-pane -Z; `Ctrl-Up`
`Ctrl-Down` `Ctrl-Left` `Ctrl-Right` resize-pane by 1 (repeats); `Alt-Up`
`Alt-Down` `Alt-Left` `Alt-Right` resize-pane by 5 (repeats); `c` new-window;
`n` next-window; `p` previous-window; `l` last-window; `0` to `9` select-window
-t :=0 to :=9, which is thread 1 to 10; `s` and `w` choose-tree; `[` copy-mode;
`PageUp` copy-mode -u; `?` list-keys; `Ctrl-b` send-prefix. Every other key
that stock tmux binds, such as `d`, `,`, `&`, `Space`, `{`, `]`, `q`, `i` or
`Alt-1`, is taken and does nothing. There is no paste key: a copy goes to the
clipboard of the system. Stock tmux binds no keyboard key without the prefix.

Copy mode. tmux's option `mode-keys` picks the table. The default is emacs,
unless the environment variable `VISUAL` of the bb server has `vi` in its
program name (after the last slash), or `VISUAL` is unset and `EDITOR` has.

- Both tables: the arrow keys cursor-left, cursor-right, cursor-up and
  cursor-down; `Home` start-of-line; `End` end-of-line; `PageUp` page-up;
  `PageDown` page-down; `Ctrl-Up` scroll-up; `Ctrl-Down` scroll-down; `q`,
  `Ctrl-c` cancel. `Ctrl-b` (emacs: cursor-left, vi: page-up), while it is
  the prefix, is pressed after the prefix: send-prefix sends it to the pane.
- emacs table: `Ctrl-Space` begin-selection; `Ctrl-g` clear-selection;
  `Ctrl-w`, `Alt-w` copy-pipe-and-cancel; `Escape` cancel; `Ctrl-f`
  cursor-right; `Ctrl-p` cursor-up; `Ctrl-n` cursor-down; `Ctrl-a`
  start-of-line; `Ctrl-e` end-of-line; `Alt-m` back-to-indentation; `Alt-b`
  previous-word; `Alt-f` next-word-end; `Alt-{` previous-paragraph; `Alt-}`
  next-paragraph; `Alt-<` history-top; `Alt->` history-bottom; `Alt-Shift-r`
  top-line; `Alt-r` middle-line; `Alt-v` page-up; `Ctrl-v`, `Space`
  page-down; `Alt-Up` halfpage-up; `Alt-Down` halfpage-down.
- vi table: `Space` begin-selection; `Escape` clear-selection; `Enter`,
  `Ctrl-j` copy-pipe-and-cancel; `h`, `Ctrl-h`, `Backspace` cursor-left; `l`
  cursor-right; `k` cursor-up; `j` cursor-down; `w` next-word; `b`
  previous-word; `e` next-word-end; `0` start-of-line; `^`
  back-to-indentation; `$` end-of-line; `{` previous-paragraph; `}`
  next-paragraph; `g` history-top; `G` history-bottom; `H` top-line; `M`
  middle-line; `L` bottom-line; `Ctrl-u` halfpage-up; `Ctrl-d`
  halfpage-down; `Ctrl-f` page-down; `Ctrl-y`, `K` scroll-up; `Ctrl-e`, `J`
  scroll-down. `v` is rectangle-toggle, `y` is not bound: neither acts.
- As in tmux, an emacs selection ends in front of the character under the
  cursor block, and a vi selection takes it in, with the one it started on: it
  starts as one character. vi's next-word-end goes to a word's last one. The
  start and end of a line are those of the wrapped line (a paragraph).
- A code block's header (language name, wrap and copy buttons) never holds the
  cursor and is never copied. Line and page keys keep the column over it.
- Copying, also on mouse selection: a selection whose text, blanks aside, lies
  in one answer of the agent goes to bb's own copy handler, as `Cmd-C` does:
  Markdown, or plain text if the browser refuses. Any other (across messages,
  or with a user message or tool row in it): the highlighted plain text, with
  all between. Blanks alone, also with a code block header, are empty.
- The keys for searching, jumps, rectangle and line selection are taken and
  do nothing. Copy mode works on the conversation of the focused pane only.
  It ends on a mouse press, when the window loses focus, when the text
  cursor goes into a text field, when the pane stops showing the
  conversation, and after the prefix and a key that does something else.

Lists (fixed keys of tmux's lists, the same for emacs and vi):

- `Up` `k` `Ctrl-p` previous and `Down` `j` `Ctrl-n` next, going around at
  the ends; `PageUp` `Ctrl-b` page up; `PageDown` `Ctrl-f` page down; `g`
  `Home` first; `G` `End` last; `Enter` choose; `q` `Escape` `Ctrl-g` leave.
- Sidebar row reached from the keyboard: these keys (`Enter` opens the
  thread in the focused pane), and the keys the prefix table binds to
  split-window -h and split-window (stock: `%` and `"`), which open it in a
  new pane to the right or below. The prefix key and a key that works
  without the prefix are no list keys there. A row that was clicked is an
  ordinary link. While rows are selected, bb gets `Escape`, not `Ctrl-[`.
- Thread chooser: the same keys, and `/` for the filter field. Opened for a
  new pane, it starts with a New thread row, highlighted at first. `Enter`
  on it, or the key the prefix table binds to new-window (stock: `c`) on any
  row, starts a new thread in the new pane. In the filter field only `Up`,
  `Down`, `Ctrl-n`, `Ctrl-p`, `PageUp`, `PageDown`, `Enter`, `Escape` act.
- Key help: the move keys scroll by `scrollStepPx` pixels, the page keys by
  a page, first and last go to the top and bottom, the leave keys close it.

The plugin's own keys, which no tmux config changes: `i` (rule 11), `/` in the
chooser, and the sidebar reached from the leftmost pane. Command palette:
"Tmux: Open thread chooser", "Tmux: Show keys", and "Tmux: Pause or resume
keys in this window". While the plugin is off, each only says so.

## The tmux config

The server part of the plugin (the piece bb runs in its server, not in the
window) reads tmux's usual files: `~/.tmux.conf`, then
`$XDG_CONFIG_HOME/tmux/tmux.conf` when that variable is set, then
`~/.config/tmux/tmux.conf`. Every file that exists is read. One chosen file is
read instead of those three. No setting names it: its path is in the plugin's
storage, and the file is read each time, so later changes count. A chosen file
that is missing, unreadable, no regular file or too large counts as not read,
and the three are not read instead. `tmuxConfigText` ("Config text") holds tmux
config lines, at most 1 MiB, such as `bind -r H resize-pane -L 5`.

- In the app: Settings, Installed plugins, Tmux keys, section "Config file"
  (also while the plugin is off). It names the file in use, and whether it can
  be read. "Browse" lists the folders and files of the machine that runs the bb
  server, hidden ones too, at most 2000 per folder, from the file in use or the
  home folder there. Its path box takes a path of a folder or file, also with
  `~`. "Use this file" stores the choice, "Use tmux's usual files" undoes it.
- From a terminal: `bb plugin rpc call tmux configFile` shows the choice. To
  make one, put `{"path":"~/dotfiles/tmux.conf"}` (a full path or one with `~`,
  kept as written, or `null` to undo it) into a file and run `bb plugin rpc
  call tmux setConfigFile --input-file FILE`. Tell the user before you do.

The order is stock bindings, the usual files or the chosen file, pasted lines,
as one sequence: the last line for an option or a key wins. A window asks for
the keys when it loads or reconnects, when the plugin is switched on, when the
Config text or the choice of file changes, and on a key bound to `source-file`.

- `set -g prefix KEY`: the prefix, when the key has Ctrl or Alt or is a
  function key. Otherwise (a plain key, `None`, an unknown name, a key on the
  Turkish capital dotted I, U+0130) `Ctrl-b` stays and the key help names the
  key. No setting names the prefix: for one in bb that differs from the
  user's tmux, `set -g prefix C-Space` goes into `tmuxConfigText`, with
  `bind C-Space send-prefix` if pressing it twice should send the key on.
- `set -g prefix2 KEY`: a second key that arms the same table. `None`, a
  plain key (named in the key help), or the same key as the prefix: none.
- `setw -g mode-keys vi` or `emacs`: the copy table. `set -g mouse on` or
  `off` (also `yes`, `no`, `1`, `0`): copy on select while `copyOnSelect` is
  `auto`. Either without a value switches over. `set -g repeat-time N`:
  milliseconds, 0 switches repeating off. `set -g prefix-timeout N` (also
  with `-s` or no flag): milliseconds the prefix waits, 0 for no limit.
- `set -g base-index N`: select-window -t :=N goes to the first thread, and
  a smaller number does nothing. With 1, `1` is the first thread.
- The other options need `-g`, with `set`, `set-option`, `setw` or
  `set-window-option`, and their full name. Any other option is ignored.
- `bind KEY command` (or `bind-key`): adds a key to the prefix table or
  replaces what it did. `-r`: it repeats. `-n` or `-T root`: it works without
  the prefix, when the key has Ctrl or Alt or is a function key. `-T
  copy-mode`, `-T copy-mode-vi`: a copy table. Other tables are ignored.
  Commands joined by `\;` or in braces run up to the first without equivalent
  or to a last-pane, `'{left-of}'`-like or thread move that finds none (tmux's
  error). One after a pane move, close or thread change waits for bb up to 1 s.
- `unbind KEY` (`-n`, `-T table`) removes the key, `unbind -a` a whole table.
- Key names are tmux's: `C-a` (or `^a`) is Ctrl-a, `M-a` is Alt-a, `S-Up`,
  `Space`, `Enter`, `Escape`, `Tab`, `BSpace`, `PPage`, `NPage`, `Home`,
  `End`, `F1` to `F12`. A capital letter has Shift, but `C-A` is `C-a`.

Never run, followed or evaluated: the shell command of `copy-pipe`,
`run-shell`, `if-shell` and `#(...)`; a file loaded with `source-file`; the
system-wide tmux config; tmux plugins (tpm and what it loads); everything
between `%if` and `%endif`; a key or value with a format (`#{...}`), a
variable (`$NAME`, `${NAME}`) or a `~`; a file or text larger than 1 MiB.

Above its key list the key help has two lines. The first names the prefix:
"Prefix: Ctrl-a, from ~/.tmux.conf" (or "from the Config text setting"), or
"Prefix: Ctrl-b, tmux's default" with the reason (no tmux config sets a prefix,
the prefix KEY in FILE cannot be used in bb, the tmux config or a part of it
could not be read). The second names every source that was applied, a chosen
file with "(chosen in the plugin's settings)", or says that none was found, and
says when a tmux config, the chosen file or the pasted text could not be read.

## Settings

Show the values with `bb plugin config tmux`, change one with
`bb plugin config tmux set <key> <value>`, reset one with `unset <key>` in
place of `set`. bb shows them under Settings, Installed plugins. Changes
apply without a reload. Tell the user before you change a setting. All six:

- `enabled` (`false`), labelled "Enable tmux keys": `true` switches it on.
- `tmuxConfigText` (empty): see "The tmux config", also for the config file.
- `threadOrder` (`sidebar`): `sidebar` follows the thread list as shown,
  `recent` has running threads first, then the latest activity first.
- `scrollStepPx` (`80`): 10 to 2000. One scroll step: copy mode, the key help.
- `copyOnSelect` (`auto`): `auto`, `on`, `off`. Copies mouse-selected
  conversation text on release. `auto`: tmux's `mouse` option, stock off.
- `resizeCellPx` (`10`): 1 to 100. Pixels for one cell of resize-pane.

## Common questions

- **"No key works"**: first check that the plugin is on. `bb plugin config
  tmux` shows `enabled`, and `bb plugin config tmux set enabled true`
  switches it on. Then: the keys are paused, or a dialog of bb is open.
- **"h, j, k, l do not move between panes", "v and s do not split"**: stock
  tmux has the arrows, `%` and `"` for that. The user adds lines such as
  `bind h select-pane -L` or `bind v split-window -h` to their tmux config.
- **"v and y do nothing in copy mode"**: in the stock vi table `Space`
  starts a selection and `Enter` copies. The user adds `bind -T copy-mode-vi
  v send-keys -X begin-selection`, and `y` for `copy-selection-and-cancel`.
- **"Copy mode has the wrong keys"**: without `mode-keys` in the config,
  `VISUAL` and `EDITOR` of the bb server decide. Add `setw -g mode-keys vi`.
- **"The prefix twice does not send the prefix"**: that needs a binding.
  Stock tmux has it for `Ctrl-b` only. With `set -g prefix C-a` the user adds
  `bind C-a send-prefix`. `bind a send-prefix` does nothing in bb.
- **"The prefix stays armed"**: stock tmux has no time limit for the next
  key. `set -g prefix-timeout 3000` ends it after 3 seconds.
- **"The prefix is not my tmux prefix"**: ask for the prefix line of the key
  help. Causes: the prefix has no Ctrl or Alt; the line has no `-g`, sits
  between `%if` and `%endif` or in a sourced file; `tmuxConfigText` sets
  another one; a file is chosen; the bb server's machine lacks the config.
- **"I want another prefix in bb than in tmux"**: see `set -g prefix KEY`
  under "The tmux config": a line in `tmuxConfigText` sets it for bb only.
- **"I changed my tmux config and nothing happened"**: a file is read when a
  bb window loads. The user reloads the window, or binds a key to
  `source-file`. The Config text and a choice of the config file apply at once.
- **"Right after a pane move the arrow keys move panes again"**: the arrows
  are bound with `-r`, so they work without the prefix for `repeat-time`
  (500 milliseconds), also in a text field. `set -g repeat-time 0` ends it.
- **"A resize does nothing"**: a message says so with a single pane and while
  a pane is zoomed. Otherwise the pane has no divider that way, or the pane
  that would shrink is at bb's smallest size, 15 percent of its row or column.
- **"i did nothing"**: the cursor was in a text field, the terminal or a
  dialog, copy mode was on, Shift was held, or the pane has no message box.

## Limits to mention

- After 2 seconds without an answer of the server part, or a failed
  question, the plugin uses stock tmux, and a late answer replaces that.
- On a Mac, Option with a symbol types another character, so the emacs copy
  keys `Alt-<`, `Alt->`, `Alt-{`, `Alt-}` and a prefix such as `M-;` cannot be
  pressed. Nor can the dead keys `M-e`, `M-i`, `M-n`, `M-u`. Any other letter
  or digit goes by its place on a US keyboard. macOS may take Ctrl-arrow keys.
- With an input method for Korean, Japanese or Chinese on, the key after the
  prefix does not work in a text field. With a layout without Latin letters
  (Russian, Greek...), the prefix and the other letter keys do not work.
- On Windows and Linux the prefix, the Ctrl keys of the copy table in copy
  mode, `Ctrl-[` there and on a sidebar row, and `Ctrl-n`, `Ctrl-p`, `Ctrl-f`
  on that row come before a bb shortcut on the same key. A browser tab keeps
  `Ctrl-w` and `Ctrl-n`: use `Alt-w`, arrows or vi keys.
- A popup card of bb counts as a dialog, also the one under the mouse on the
  message box's context ring: no key works then. The embedded browser page can
  cover the pills, and with little room beside it the chooser and key help.
- At a line end tmux's vi keys also copy the line break, the plugin does not.
  Copy mode skips the cut-off rest of a long user message and its "Show more" /
  "Show less" button, but a selection past them holds both, as with the mouse.
- bb unloads far-away parts of a long conversation, which can end copy mode.
  The last pane and thread are remembered per window, while the plugin is on.
- A pane below also opens in the user's other bb windows and devices. A new
  thread from the chooser first shows another thread, which for a pane below
  stays open in those windows. bb allows 8 panes.
- The plugin relies on bb's page structure, read from the source of bb 0.50.1.
  A bb upgrade may break keys, with `[tmux]` warnings in the developer console.
