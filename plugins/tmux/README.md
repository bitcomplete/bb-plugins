# Tmux keys for bb

A bb plugin (an add-on that bb loads next to its own code) that lets you
drive bb from the keyboard with the keys of tmux. bb is a desktop app for
running coding agents in split panes. tmux is a terminal program that splits
a terminal into panes and is driven from the keyboard.

The plugin follows one rule: **it behaves like stock tmux, and your tmux
config is applied on top.** Stock tmux means tmux 3.5a as it starts without a
config file. When you have a tmux config, the plugin reads it and changes its
keys as tmux would. The only other keys are under "The plugin's own keys".

What you get: a **prefix key** followed by one more key, for moving between
panes, splitting, resizing, zooming, closing and switching threads; a **copy
mode** for scrolling through a conversation and for selecting and copying
its text, with tmux's emacs or vi keys; a **thread chooser** (a popup that
lists your threads) and **sidebar keys**, both with the keys of tmux's
lists; **copy on select** for the mouse, when your tmux config turns the
mouse on; and **`i`**, which puts the text cursor in the message box.

The parts of bb that the plugin relies on were checked against the source
code of bb desktop 0.50.1. The tmux facts are from tmux 3.5a and its manual
(the current version of the manual is at <https://man.openbsd.org/tmux.1>).

## Install, reload and remove

Installing a plugin lets its code run inside bb with full trust, so only
install it from a source you trust. From this repository:

```
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin tmux
```

To work on the plugin, from a checkout of this folder:

```
npm install                  # once, fetches the build and test tools
bb plugin install .          # asks for confirmation, then loads the plugin
bb plugin reload tmux        # after a change: rebuild and reload
bb plugin dev                # or: rebuild and reload on every save
bb plugin disable tmux       # unload it, keep the settings
bb plugin enable tmux        # load it again
bb plugin remove tmux        # remove it and delete its settings
```

**The plugin is off until you switch it on.** Until then it handles no key
and copies nothing. Turn on "Enable tmux keys" under Settings, Installed
plugins, Tmux keys, or run `bb plugin config tmux set enabled true`. It
takes effect at once, without a reload, as does switching it off again.

If the folder is inside a bb-managed workspace, bb will later copy the plugin
into its own data folder and run it from there. `bb plugin install` says so.

## How it works

1. **A pane is like a tmux pane: you can type straight away.** Whenever a
   key of this plugin takes you to a pane, the text cursor is put in the
   message box of that pane (the field where you write to the agent), when
   the pane has one. Closing the thread chooser or the key help without
   choosing gives the cursor back to where it was.
2. **A thread is like a tmux window.** tmux has windows where bb has threads
   (a thread is one conversation with an agent). So tmux's window commands
   (new, next, previous, last, by number, choose) act on threads.
3. **Commands start with the prefix.** You press the prefix key, release it
   and press one more key. Stock tmux has `Ctrl-b` as the prefix. It works in
   the message box, the terminal, every other text field, on a pane and in
   the sidebar. A small pill at the bottom of the window shows the prefix
   key that you pressed until the next key comes.
4. **Scrolling and selecting happen in copy mode.** In copy mode the keys
   move a cursor through the conversation instead of being typed. Leaving it
   with a key puts the text cursor back in the message box.
5. **The keys are a tmux keymap.** The plugin holds the keyboard bindings of
   stock tmux as tmux config text. It reads that text first and then your
   tmux config (files, and lines you pasted into a setting), with the same
   reader, and turns every tmux command into what bb can do. A key bound to
   a command that bb has no equivalent for is still taken, and does nothing.

Example with the stock keys: `Ctrl-b` `%` opens the thread chooser, and `j`
then `Enter` opens the first thread of its list in a new pane to the right.
`Ctrl-b` `Left` moves back to the left pane, and what you type next goes
into its message box. `Ctrl-b` `[` enters copy mode there, and `q` leaves it.

## Words used here

- **Pane**: one of the side-by-side or stacked areas that each show a thread.
  The **focused pane** is the one bb treats as current, of 8 at most. While
  the plugin is on it has a thin border, and a focused sidebar row a ring.
- **Divider**: the line between two panes. **Sidebar**: the thread list on
  the left. **Text cursor**: the mark that shows where typing goes.
- **tmux config**: a text file with your tmux settings, such as
  `~/.tmux.conf`. The `~` stands for your home folder.
- **Key table**: tmux's name for a set of key bindings. The plugin uses four:
  `prefix` (keys after the prefix), `root` (keys without the prefix),
  `copy-mode` (emacs keys of copy mode) and `copy-mode-vi` (vi keys).
- **Key help**: the plugin's list of the keys that are in effect right now.
  **Command palette**: bb's searchable list of commands.
- **Pill**: a small label at the bottom of the window. A hidden live region
  tells a screen reader (it reads a page aloud) the same in words: "Prefix
  armed", "Copy mode", "Copy mode, selecting" and, once, "Copy mode ended".
- **`Alt`**: the Option key on a Mac. Key names follow tmux: `C-a` in a tmux
  config is `Ctrl-a`, `M-a` is `Alt-a`, `S-Up` is `Shift-Up`, and a capital
  has Shift (`M-X` is `Alt-Shift-x`). Unlike in tmux, `C-A` is read as `C-a`.

## Stock keys

These are the keys when you have no tmux config. Your config changes them.
As in a terminal, `Ctrl-[`, `Ctrl-m` and `Ctrl-i` work as `Escape`, `Enter`
and `Tab` in copy mode and in the lists, unless they are bound themselves.

### After the prefix

| Key | tmux command | What happens in bb |
| --- | --- | --- |
| `Up` `Down` `Left` `Right` (repeats) | select-pane -U / -D / -L / -R | Focus the pane in that direction, and of several panes there the one that had the focus last. As in tmux, `Up`, `Down` and `Right` at the edge of the window go around to the pane at the opposite edge. `Left` from the leftmost pane, or with a single pane, goes to the thread list of the sidebar. The prefix then `Right` on a thread row there goes back to the pane. |
| `o` | select-pane -t :.+ | Focus the next pane, and the first pane after the last. The order follows the splits, as in tmux: a new pane comes right after the pane it was split from. |
| `;` | last-pane | Focus the pane that had the focus before, or the one before that when it was closed since. The plugin remembers this in the window only and while it is on. When it remembers none, as right after the first split or a reload, two panes go to the other pane, as in tmux, and three or more show a message. |
| `%` | split-window -h | Open the thread chooser for a new pane to the right. |
| `"` | split-window | Open the thread chooser for a new pane below. |
| `x` | kill-pane | Close the focused pane. No question is asked, because closing a pane in bb does not end its thread. As in tmux, the focus then goes to the pane that had it before, when the plugin remembers one. With a single pane, `x` and `z` do nothing. |
| `z` | resize-pane -Z | Zoom the focused pane, or undo the zoom. |
| `Ctrl-Up` `Ctrl-Down` `Ctrl-Left` `Ctrl-Right` (repeats) | resize-pane, 1 cell | Move a divider by 1 cell in that direction (a cell is 10 pixels, setting `resizeCellPx`). As in tmux, it is the divider on the right or bottom edge of the focused pane, or the one on its left or top edge when the pane has none there. |
| `Alt-Up` `Alt-Down` `Alt-Left` `Alt-Right` (repeats) | resize-pane, 5 cells | The same by 5 cells. |
| `c` | new-window | Start a new thread in the focused pane. bb shows the New thread screen in one pane only: when another pane shows it already, you are moved to that pane and a message says so. |
| `n`, `p` | next-window, previous-window | Go to the next or the previous thread. Wraps around. |
| `l` | last-window | Go to the thread that this pane showed before, which is remembered in the same way and stays with the pane when the window is split or a split ends. From the New thread screen that is the thread the pane showed last. A thread that was archived or deleted since is not gone back to, and neither is the thread that only filled a new pane until the New thread screen took its place. |
| `0` to `9` | select-window -t :=0 to :=9 | Jump to thread 1 to 10. tmux counts windows from 0, so `0` is the first thread (see `base-index` and the setting `threadOrder`). |
| `s`, `w` | choose-tree | Open the thread chooser for the focused pane. |
| `[` | copy-mode | Enter copy mode in the focused pane. It works on the conversation there only, not on the terminal, the message box or Settings: without a conversation the message is "There is no conversation text to select here". |
| `PageUp` | copy-mode -u | Enter copy mode and scroll one page up. |
| `?` | list-keys | Show the key help. |
| `Ctrl-b` | send-prefix | Pass `Ctrl-b` itself on to the terminal or text field. A pane in copy mode gets the key instead, as a key of its copy table. |

- **Every other key ends the prefix and is not passed on**: the keys stock
  tmux binds to commands without equivalent (such as `d`, `,`, `&`, `Space`,
  `{`, `]`, `Alt-1`) and the keys tmux does not bind. With a config, a key
  bound without the prefix runs, and an unbound prefix key keeps it waiting.
  There is no paste key: a copy goes to the clipboard of your system.
- **Repeating.** tmux binds some keys with `-r`. After such a key has run,
  every key bound with `-r` works without the prefix until `repeat-time`
  (500 milliseconds) has passed without one, in a text field too: with
  stock tmux, an arrow key pressed that soon after the prefix then an arrow
  moves to another pane again. Any other key ends this and is handled as
  usual. The prefix pill stays on screen meanwhile.

### Copy mode

Enter with the prefix then `[` or `PageUp`. A pill shows `COPY`, or `SELECT`
while a selection is under way, and a block marks the cursor. tmux has two
key tables for copy mode, and its option `mode-keys` picks one. The default
is emacs, unless the environment variable (a named value that the system
hands to a program) `VISUAL` of the bb server has `vi` in its program name
(what follows the last slash), or `VISUAL` is not set and `EDITOR` has.
Where a row names two things, their keys are separated by a slash.

| What happens | tmux command | emacs keys | vi keys |
| --- | --- | --- | --- |
| Move one character left / right. In a code block, a step left from the start of a line stops at the end of the line before, where a step right stops too | cursor-left / cursor-right | `Left` or `Ctrl-b` / `Right` or `Ctrl-f` | `h`, `Left`, `Ctrl-h` or `Backspace` / `l` or `Right` |
| Move one line up / down. The length of a line of code does not slow this and does not change where it lands | cursor-up / cursor-down | `Up` or `Ctrl-p` / `Down` or `Ctrl-n` | `k` or `Up` / `j` or `Down` |
| Next word / previous word / end of word. From the end of a paragraph, of a line of code or of the lines that bb shows of a long collapsed message, end of word goes on to the first word that follows, in one press. The emacs key also passes over the end of a word where the cursor cannot stand, as where bb cuts a word off in part | next-word / previous-word / next-word-end | no key / `Alt-b` / `Alt-f` | `w` / `b` / `e` |
| Start / first character that is not a blank / end of the line, which as in tmux is the whole wrapped line: a paragraph, or a line of code | start-of-line / back-to-indentation / end-of-line | `Ctrl-a` or `Home` / `Alt-m` / `Ctrl-e` or `End` | `0` or `Home` / `^` / `$` or `End` |
| Start of the previous / next paragraph, as tmux goes to the start of the line. In a code block that bb highlights, a paragraph ends at an empty line, as in tmux: the cursor goes to the previous or next empty line of the code, and where there is none, to the start of the paragraph in front of the block or of the text behind it | previous-paragraph / next-paragraph | `Alt-{` / `Alt-}` | `{` / `}` |
| First / last text of the conversation | history-top / history-bottom | `Alt-<` / `Alt->` | `g` / `G` |
| Top / middle / bottom line you can see | top-line / middle-line / bottom-line | `Alt-Shift-r` / `Alt-r` / no key | `H` / `M` / `L` |
| Half a page up / down | halfpage-up / halfpage-down | `Alt-Up` / `Alt-Down` | `Ctrl-u` / `Ctrl-d` |
| One page up / down | page-up / page-down | `Alt-v` or `PageUp` / `Ctrl-v`, `Space` or `PageDown` | `Ctrl-b` or `PageUp` / `Ctrl-f` or `PageDown` |
| Scroll one step up / down (`scrollStepPx` pixels) | scroll-up / scroll-down | `Ctrl-Up` / `Ctrl-Down` | `Ctrl-y`, `K` or `Ctrl-Up` / `Ctrl-e`, `J` or `Ctrl-Down` |
| Start a selection at the cursor | begin-selection | `Ctrl-Space` | `Space` |
| Drop the selection and stay | clear-selection | `Ctrl-g` | `Escape` |
| Copy the selection and leave | copy-pipe-and-cancel | `Ctrl-w` or `Alt-w` | `Enter` or `Ctrl-j` |
| Leave without copying | cancel | `q`, `Escape` or `Ctrl-c` | `q` or `Ctrl-c` |

- The prefix key comes first. So while `Ctrl-b` is the prefix, the `Ctrl-b`
  of either table is pressed as the prefix then `Ctrl-b` (send-prefix).
- Every other key without Ctrl, Alt or Cmd does nothing. A key with one of
  them goes to bb (`Cmd-C` still copies), unless tmux binds it in the table
  to a command without equivalent, such as searching or rectangle selection.
- A selection runs between where it was started and the cursor block. As in
  tmux, the emacs keys end it in front of the character under the block, and
  the vi keys take that character in, with the one it was started on: from
  the `z` of `zeta`, `l` three times selects `zeta`. With the vi keys it
  starts as one character, and `e` goes to the last character of a word.
- **Code blocks.** bb draws a header above a code block: the name of the
  language and the buttons for line wrap and for copying the code. The
  cursor never stands in it, no selection starts or ends in it, and it is
  never copied. The line and page keys pass over it and keep the column. A
  move forward from the text in front of the block lands on the first
  character of the code, and a move back from there at the end of that text.
- **What is copied.** A selection whose text lies in one answer of the agent
  (blanks outside it do not count) is copied by bb's own copy handler, as
  Markdown, as `Cmd-C` does. Any other, such as one from one message into
  another or one with a message of yours or the row of a tool call in it,
  is copied as the plain text that is highlighted, with everything between.
  Blanks alone, also with the header of a code block among them, count as
  nothing selected: Copy and leave then just leaves, as in tmux.
- The prefix works in copy mode. A key after it that does something else,
  such as a pane move, ends copy mode. Copy mode also ends by itself on a
  mouse press, when the window loses focus, when the text cursor goes into a
  text field, and when the pane stops showing the conversation.

### Lists

tmux's lists have fixed keys, whatever `mode-keys` says. The plugin uses them
on a thread row of the sidebar, in the thread chooser and in the key help.

| Key | Sidebar and thread chooser | Key help |
| --- | --- | --- |
| `Up`, `k`, `Ctrl-p` | Move to the previous row, and from the first row to the last. | Scroll up by `scrollStepPx` pixels. |
| `Down`, `j`, `Ctrl-n` | Move to the next row, and from the last row to the first. | Scroll down by `scrollStepPx` pixels. |
| `PageUp`, `Ctrl-b` | Move one page up, and no further than the first row. | Scroll one page up. |
| `PageDown`, `Ctrl-f` | Move one page down, and no further than the last row. | Scroll one page down. |
| `g` or `Home`, `G` or `End` | Move to the first or the last row. | Go to the top or the bottom. |
| `Enter` | Open the thread: in the focused pane from the sidebar, and where the chooser was opened for (this pane, right or below). A thread that is already shown in a pane is not opened twice: you are moved to that pane. | Nothing. |
| `q`, `Escape`, `Ctrl-g` | Go back to the pane, or close the chooser. | Close the key help. |
| The keys your prefix table binds to split-window -h and split-window (stock: `%` and `"`) | Open the highlighted thread in a new pane to the right or below. | Nothing. |

- **Sidebar.** The list keys work on a thread row that you reached from the
  keyboard (the prefix then `Left` from the leftmost pane, which opens a
  hidden sidebar first). A row you clicked is an ordinary link. The prefix
  key and a key that your config binds without the prefix are no list keys
  here. While rows are selected, `Escape` is bb's, but `Ctrl-[` goes back.
- **Thread chooser.** It lists every thread that is not archived, running
  threads first. Opened for a new pane, it starts with a **New thread** row,
  highlighted at first: `Enter` on it starts a new thread in the new pane,
  as does the key your prefix table binds to new-window (stock: `c`) from
  any row. `/` moves to the filter field, where only `Up`, `Down`, `Ctrl-n`,
  `Ctrl-p`, `PageUp`, `PageDown` and `Enter` act and `Escape` goes back.

### The plugin's own keys

These are not tmux keys, and no tmux config changes them.

| Key | Where | What happens |
| --- | --- | --- |
| `i` | Without the prefix and without Shift, while the text cursor is not in a text field, the terminal or a dialog, and outside copy mode. | Put the text cursor in the message box of the focused pane. Example: bb's `Escape` takes the text cursor out of the message box, and `i` puts it back. bb's own command for this is "Focus composer". The key is taken before bb sees it: to record `i` as a shortcut in bb's keyboard settings, pause the plugin first. |
| `/` | In the thread chooser. | Filter the threads by title or project name. |
| The key bound to select-pane -L (stock: the prefix then `Left`) | In the leftmost pane. | Go to the sidebar, which tmux does not have. |

The thread chooser and the key help are the plugin's own too, and in bb's
command palette as "Tmux: Open thread chooser" and "Tmux: Show keys". "Tmux:
Pause or resume keys in this window" turns the keys and copy on select off
or on again. A pause ends when the window or the plugin is reloaded or the
plugin is switched off. While it is off, the three only say how to turn it on.

## Your tmux config

The server part of the plugin (the piece that bb runs in its server and not in
the window) reads tmux's usual files: `~/.tmux.conf`, then
`$XDG_CONFIG_HOME/tmux/tmux.conf` when that environment variable is set, then
`~/.config/tmux/tmux.conf`. Every file that exists is read. For a bb server on
a machine without your tmux config, or for lines in bb only:

- **Config file.** Under Settings, Installed plugins, Tmux keys, the section
  "Config file" shows what is in use: tmux's usual files, or one file chosen
  in their place with **Browse**. Its dialog lists the folders and files of
  the machine that runs the bb server, hidden ones included, folders first,
  from the file in use or else from the home folder there. Open folders or
  type a path (also of a file, also with `~`) and confirm a file with "Use
  this file". A list is cut after 2000 entries, and the dialog says so. "Use
  tmux's usual files" undoes the choice. The path is stored, not a copy, so
  later changes to the file count. A file that cannot be read is not replaced
  by the usual files: you get the stock keys with the pasted lines, and the
  section and the key help say so. The section works while the plugin is off.
- **`tmuxConfigText`** ("Config text") holds pasted tmux config lines, such as
  `bind -r H resize-pane -L 5`, applied on top of the config file.

No setting names the file: its path is in the plugin's storage in bb, which
`bb plugin remove` leaves in place. From a terminal, `bb plugin rpc call tmux
configFile` shows the choice and this makes it (`null` as the path undoes it):

```
echo '{"path":"~/dotfiles/tmux.conf"}' > choice.json
bb plugin rpc call tmux setConfigFile --input-file choice.json
```

The order is always: the stock bindings, then the usual files or the chosen
file, then the pasted lines, as one sequence, so the last line that sets an
option or binds a key wins. While the plugin is on, a bb window asks for the
result when it loads or reconnects, when the plugin is switched on, when the
Config text or the choice of file changes, and on a key bound to `source-file`.

A made-up example with some common cases:

```
set -g prefix C-a                  # the prefix is Ctrl-a
unbind C-b
bind C-a send-prefix               # Ctrl-a twice passes Ctrl-a on

bind h select-pane -L              # letters for pane moves
bind j select-pane -D
bind k select-pane -U
bind l select-pane -R
bind | split-window -h             # a split key, also in the lists
bind -r H resize-pane -L 5         # a resize key that repeats

setw -g mode-keys vi               # vi keys in copy mode
bind -T copy-mode-vi v send-keys -X begin-selection
bind -T copy-mode-vi y send-keys -X copy-selection-and-cancel
set -g mouse on                    # copy on select
bind r source-file ~/.tmux.conf    # read this file again
```

### Lines that are read

| Line | What it changes |
| --- | --- |
| `set -g prefix KEY` | The prefix. The key needs Ctrl or Alt, or has to be a function key, because a plain key would be taken away from typing. Otherwise `Ctrl-b` stays and the key help names the key that could not be used. The tmux config alone decides the prefix. For a prefix in bb that differs from the one of your tmux, put a line such as `set -g prefix C-Space` into the Config text setting, and `bind C-Space send-prefix` with it if pressing the key twice should pass it on. |
| `set -g prefix2 KEY` | A second key that arms the same keys. `None` means none. The key help names a key that cannot be used. |
| `setw -g mode-keys vi` or `emacs` | Which copy mode table is in use. Without a value the line switches to the other one. |
| `set -g mouse on` or `off` | Copy on select, while the setting `copyOnSelect` is `auto`. Also `yes`, `1`, `no` and `0`, as in tmux, and no value to switch it over. |
| `set -g repeat-time N` | For how many milliseconds the keys bound with `-r` repeat. 0 switches repeating off. |
| `set -g prefix-timeout N` | For how many milliseconds the prefix waits for the next key. 0, which stock tmux has, means until a key comes. Also read with `-s` or without a flag. |
| `set -g base-index N` | The number of the first window. select-window -t :=N goes to the first thread, and a smaller number does nothing. |
| `bind KEY command` | Adds a key after the prefix, or replaces what the key did. `-r` lets it repeat. `-n` or `-T root` makes it work without the prefix. `-T copy-mode` and `-T copy-mode-vi` change a copy mode table. In the command, a flag that tmux does not know for it is accepted as a flag without a value. A line leaves the key as it was when tmux refuses one of its commands for a flag that lacks its value or for the number of its arguments, such as `bind c new-window -c`. That holds for the commands of the table below, its last row aside: another command is not checked, so `bind c swap-pane -t` gives `c` no action. |
| `unbind KEY` | Removes the key (with `-n` or `-T` from that table), so that it is treated like any key that is not bound. `unbind -a` empties a whole table. |

- Options count with `-g`, written with `set`, `set-option`, `setw` or
  `set-window-option`. A command can be written with its full name, its
  alias (also `split-pane`, `splitp`) or a shorter form that tmux accepts.
- A binding can hold several commands, separated by `\;` or in braces. They
  run in order up to the first one without equivalent (also inside
  `confirm-before`) or, as tmux stops at an error, a move that finds no last
  pane, no pane for a target like `'{left-of}'` or no thread. One after a pane
  move, a pane close or a thread change waits until bb shows the result, and
  is dropped by a key, a mouse press or a second without it. A binding of over
  500 actions does nothing, nor those of a config past 20000 in all.
- A key without the prefix needs Ctrl or Alt, or has to be a function key,
  and works wherever the prefix works. One whose command has no equivalent
  is not taken, so it reaches bb and the terminal. A plain one is ignored.

### What each tmux command does in bb

| tmux command | In bb |
| --- | --- |
| `select-pane -L`, `-D`, `-U`, `-R`, and `-t '{left-of}'`, `'{down-of}'`, `'{up-of}'`, `'{right-of}'` (also with `.` or `:.` in front) | Focus the pane in that direction. At the edge of the window down, up and right go around to the opposite edge, and left goes to the sidebar. A move by `-L`, `-D`, `-U` or `-R` never ends the commands of a binding, also when it finds no pane. A `-t` target names the pane that tmux finds on that side: left goes around as well, never to the sidebar, and where tmux finds no pane, as with a single pane, nothing happens and the commands of the binding end there, as at tmux's error. From a zoomed pane tmux looks for the target while that pane still fills the window, so it finds a pane at the opposite edge of the window, and none where the zoomed pane is the only one there: with two panes side by side and the left one zoomed, `'{left-of}'`, `'{up-of}'` and `'{down-of}'` go to the right pane and `'{right-of}'` does nothing. |
| `select-pane -t :.+`, `-t :.-` (also `'{next}'`, `'{previous}'`) | Focus the next or the previous pane in the order of the splits. A name in braces needs its quotes in a config: without them `{` opens a block of commands. |
| `last-pane`, `select-pane -l`, `-t !` (also `'{last}'`) | Focus the pane that had the focus before, passing over panes that were closed since. |
| `split-window`, `split-window -h` | Open the thread chooser for a new pane below, or with `-h` to the right. Other flags change nothing: `-c`, also `-b`, with which tmux puts the pane to the left or above, and `-d`, with which tmux leaves the focus where it is. The pane opens to the right or below and gets the focus. With a shell command: no equivalent. |
| `kill-pane`, also inside `confirm-before` | Close the focused pane, without a question. The focus goes to the pane that had it before. |
| `resize-pane -Z` | Zoom the focused pane, or undo the zoom. Behind a move to another pane in the same binding it leaves that pane zoomed: in tmux such a move removes the zoom, in bb the zoom goes with the focus. |
| `resize-pane -L`, `-R`, `-U`, `-D`, with or without a number | Move a divider by that many cells, or by 1. |
| `copy-mode`, `copy-mode -u`, `-d`, `-q` | Enter copy mode, with `-u` one page up and with `-d` one page down. `-q` leaves copy mode. |
| `new-window` | Start a new thread in the focused pane, or move to the pane that already shows the New thread screen. Flags change nothing, also `-d`, with which tmux stays on the window it is on. With a shell command: no equivalent. |
| `next-window`, `previous-window`, `select-window -n`, `-p`, `-t +`, `-t -` (also `'{next}'`, `'{previous}'`) | Go to the next or the previous thread. |
| `last-window`, `select-window -l`, `-t !` (also `'{last}'`) | Go to the thread that this pane showed before, unless it was archived or deleted since. |
| `select-window -t N` (also `:N`, `=N`, `:=N`) | Jump to thread N - `base-index` + 1. |
| `select-window -t '{start}'` or `-t ^` (also `':{start}'`, `:^`), `-t '{end}'` or `-t :$` (also `':{end}'`) | Jump to the first or the last thread of the order in use (setting `threadOrder`), whatever `base-index` is. The `$` needs its colon: `-t $` alone names a session in tmux, which is an error there, and has no equivalent. As tmux does, the plugin refuses a `$` that ends a file with no line break behind it, or a command in quotes: `bind e 'select-window -t :$'` gives the key no action. The key help says "Jump to thread 1, in sidebar order" and "Jump to the last thread, in sidebar order", or "most recent first" with `threadOrder` on `recent`. |
| `choose-tree`, `choose-window`, `choose-session` | Open the thread chooser for the focused pane. |
| `list-keys` | Show the key help. |
| `send-prefix`, `send-prefix -2` | Pass the prefix key (with `-2` the second prefix) on to the terminal or text field. This works only on the key that is that prefix itself, because the plugin lets that key press through: after `set -g prefix C-a`, `Ctrl-a` twice passes nothing on until you add `bind C-a send-prefix`. While the pane is in copy mode, the key runs what the copy table binds it to. |
| `source-file PATH` | Read your tmux config again (the files and the pasted lines) and rebuild the keys, then say whether all of it could be read. The path itself is not read. |
| `display-message TEXT` | Show TEXT as a short message, unless it contains a `#`, or a `%` with anything but a blank behind it: tmux puts a value, a date or a time there. |
| `send-keys -X NAME` | In copy mode, the commands of the table under "Copy mode", and these: `copy-selection` and `copy-pipe` copy, drop the selection and stay; the `-no-clear` forms copy and keep the selection; the `-and-cancel` forms copy and leave copy mode. `-N count` runs the command that many times. |
| Anything else, such as `swap-pane`, `kill-pane -a` or `next-window -a`, a first or last window with a session name, a pane or `=` (`main:^`, `'{start}.1'`, `:=^`), tmux's other names in braces (`{top}`, `{bottom}`, `{left}`, `{right}`, `{top-left}`, `{top-right}`, `{bottom-left}`, `{bottom-right}`, `{mouse}`, `{marked}`), and a name in braces with more around it (`'{next}1'`), which tmux refuses | No equivalent in bb. The key is taken, does nothing and is not listed in the key help. |

### What is ignored and never run

- **Nothing is ever run.** The plugin only reads the files and the pasted
  lines. It never starts tmux, a shell or any other program. The shell
  command of `copy-pipe`, `run-shell`, `if-shell` and `#(...)` is never run.
- **Other files are not followed**: a file loaded with `source-file`, the
  system-wide tmux config, and tmux plugins (tpm and what it loads).
- **Nothing is evaluated.** Everything between `%if` and `%endif` is skipped.
  A key or value that tmux would have to work out, with a format (`#{...}`),
  a variable (`$NAME`, `${NAME}`) or a `~`, is skipped.
- **Not read**: other options without `-g`, every option that is not in the
  table above or whose name is cut short, key tables other than the four,
  mouse bindings, keys the plugin has no name for, a command with a quote
  that is never closed, a file or pasted text that is larger than 1 MiB, and
  a file that the bb server may not read. The key help says what is missing.
- **One line at a time.** tmux reads nothing of a file with a line that it
  refuses, such as an unknown command. The plugin reads every line by
  itself, so the lines around such a line still count.

### Seeing what was read

Open the key help with the prefix then `?`, or with "Tmux: Show keys" from the
command palette, which works without knowing the prefix. It lists the keys in
effect. Two lines above the key list name the prefix and where it comes from
(a config file, the Config text setting or tmux's default), and every source
that was applied, a chosen file marked as such. They say so when a source
could not be read, and when there is none, so that the keys are those of stock
tmux. Keys that repeat carry the mark "(repeats)".

## Copying with the mouse

In tmux, the `mouse` option is what makes a selection with the mouse copy.
With the setting `copyOnSelect` on `auto`, the plugin follows that option:
when it is on, conversation text you select with the mouse is copied when
you release the button, and a message says "Selection copied". Stock tmux
has it off. Only a selection that this press made or changed is copied, and
"What is copied" under "Copy mode" holds for it as well.

## Settings

Change a setting in bb under Settings, Installed plugins, Tmux keys, or from
a terminal. Changes reach the open windows right away. A number outside its
range counts as the nearest allowed value.

```
bb plugin config tmux                         # show the current values
bb plugin config tmux set threadOrder recent  # change one
bb plugin config tmux unset threadOrder       # back to the default
```

| Key | Default | Allowed values | What it does |
| --- | --- | --- | --- |
| `enabled` | `false` | `true`, `false` | Switches the plugin on. While it is `false`, the plugin handles no key and copies nothing. |
| `tmuxConfigText` | empty | tmux config lines, at most 1 MiB | Lines that are applied on top of whatever is in the config file (tmux's usual files or the chosen one), such as a `set -g prefix` line for a prefix that only bb has. See "Your tmux config". |
| `threadOrder` | `sidebar` | `sidebar`, `recent` | The order of the threads for tmux's window commands. `sidebar` follows the thread list from top to bottom. `recent` has running threads first, then the others, each group with the latest activity first. |
| `scrollStepPx` | `80` | 10 to 2000 | How many pixels one scroll step moves the conversation in copy mode, and the key help. |
| `copyOnSelect` | `auto` | `auto`, `on`, `off` | Copy on select. `auto` follows tmux's `mouse` option. |
| `resizeCellPx` | `10` | 1 to 100 | How many pixels one cell of resize-pane is worth. tmux counts in terminal cells, and bb's panes are measured in pixels. |

## Known limits

- **Where the config is read.** The files, the folders in Browse, `VISUAL`
  and `EDITOR` are those of the bb server, which may differ from your shell.
  Set `mode-keys` in your tmux config to be sure which copy mode keys you get.
- **When it is read.** At the times listed under "Your tmux config", not
  when a file changes. Until the settings have loaded and the server part
  has answered, the plugin handles no key. After 2 seconds without an answer,
  or a failed question, it uses stock tmux, and a late answer replaces that.
- **Dialogs, embedded browser.** No key of the plugin works while a dialog,
  a menu or a popup card of bb is open (also the card that shows while the
  mouse rests on the context ring of the message box), or in the embedded
  browser page. That page is drawn above bb's own: it can cover the pills,
  and with under 312 pixels to its left the thread chooser and the key help.
- **Option on a Mac.** Option with a symbol types another character. So
  `Alt-<`, `Alt->`, `Alt-{` and `Alt-}` of the emacs copy keys cannot be
  pressed there, and neither can a prefix such as `M-;`. Option with a
  letter or a digit goes by the place of the key on a US keyboard, except
  `e`, `i`, `n` and `u`: with Option they are dead keys on the US and ABC
  layouts, so `M-e`, `M-i`, `M-n` and `M-u` cannot be pressed either. The
  Ctrl-arrow keys may be taken by macOS before bb sees them.
- **Dead keys, input methods and other alphabets.** A dead key (it waits
  for the next letter to put an accent on it) and a key that an input method
  turns into text end the prefix and are passed on. With an input method
  for Korean, Japanese or Chinese on, the key after the prefix does not work
  in a text field. With a layout without Latin letters (Russian, Greek,
  Hebrew, Arabic), the prefix and the other letter keys do not work.
- **Windows and Linux.** bb's own shortcuts use Ctrl there. The prefix, and in
  copy mode the Ctrl keys of the copy table, come before a bb shortcut on the
  same key. So do `Ctrl-[` (bb's "Go back") there and on a sidebar row, and
  on that row `Ctrl-n`, `Ctrl-p`, `Ctrl-f` (bb's New thread, Quick open, Find).
  A browser tab keeps `Ctrl-w` and `Ctrl-n`: use `Alt-w`, arrows or vi keys.
- **`Ctrl-[`, `Ctrl-m`, `Ctrl-i`** are keys of their own after the prefix and
  with `bind -n`. On a sidebar row `Ctrl-i` goes to bb, as `Tab` does.
- **Copy mode moves the way the browser does.** [Selection.modify](https://developer.mozilla.org/en-US/docs/Web/API/Selection/modify)
  decides what a word is and, outside highlighted code, a paragraph. A line is
  one that you see, but it starts and ends with its paragraph or line of code.
  Where a line ends, tmux's vi keys copy the line break, the plugin does not.
- **As with a mouse selection in bb**, a selection that ends behind a long
  message of yours holds its "Show more" or "Show less" label and, while it
  is collapsed, its hidden lines. The cursor passes over both. One across a
  code block's header highlights the language name, which is not copied.
- **Long conversations.** bb keeps only the messages near the visible part
  loaded. The first and last text are the ones that are loaded, and copy
  mode ends with a message when the text of the selection is unloaded.
- **Copying an answer** reaches bb's copy handler through [document.execCommand](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand),
  which browsers mark as deprecated. If one refuses it, plain text is copied.
- **Resizing imitates a mouse drag** on the divider, because bb has no
  command for it. bb pulls a divider within 12 pixels of an even split onto
  it, so a shorter step from there goes 13 pixels. A pane stops at 15
  percent of its row or column, and nothing is resized while one is zoomed.
- **A pane below reaches other windows.** Opening a thread in a pane below
  uses a bb call that goes to every open bb window and device, so each of
  them opens the thread too. Opening to the right stays in this window.
- **A new thread in a new pane shows another thread first.** bb gives plugins
  no such call, so the New thread row opens the pane with one of your threads
  and turns it into the New thread screen. bb's Back button shows that
  thread, and for a pane below your other windows and devices keep it open.
- **bb's own rules.** The zoom stays on whichever pane has the focus. A
  window narrower than 768 pixels has a single pane and no sidebar keys. In
  it the thread chooser and the key help are drawers (panels at the bottom
  of the window), whose keys keep working after a click on the strip at
  their top. With `threadOrder` on `sidebar`, threads in a collapsed group
  of the sidebar are skipped by the window commands.
- **Restart.** On a fresh start bb opens the New thread screen in place of
  the focused pane's thread. The plugin reopens that thread once, in the
  first bb window, before you click or type, unless it was off meanwhile.
- **Tied to bb's inner workings.** bb has no public API for closing,
  focusing and resizing a pane, scrolling or reading the sidebar order, so
  the plugin reads bb's page structure and clicks bb's own buttons. After a
  bb upgrade some keys may stop working until `src/constants.ts` is updated.
  Checked against bb's source code and a copy of its page, not in the app.

## For developers

```
npx tsc --noEmit                            # type check
npx vitest run --config vitest.config.ts    # tests
bb plugin build                             # bundle into dist/
bb plugin types --check                     # SDK version matches the running bb
```

- `src/tmux-defaults.ts` holds the stock options of tmux 3.5a, and its key
  bindings as config text, and `src/list-keys.ts` the fixed keys of its lists.
  `src/tmux-syntax.ts` reads config text, `src/tmux-commands.ts` turns a tmux
  command into actions, and `src/tmux-keymap.ts` applies the stock text and
  then the files. None of the five imports anything from Node, so the
  window runs them too when the server part gives no answer.
- `server.ts` declares the settings and answers four RPCs (remote procedure
  calls: the window calls a function of the server part) that
  `src/contract.ts` describes. Calls during the same read share it. For
  `tmuxConfig`, `src/tmux-config.ts` reads the usual files or the chosen file
  and applies the pasted lines. It returns the options, every bound key of the
  four tables with whether it repeats and its actions, the paths of the files
  read, whether one could not be read, whether it was the chosen one, and what
  became of the pasted lines. Of their text it holds key names, an unusable
  prefix or prefix2 as written (32 characters at most), and the text of a
  `display-message` (200 at most): no other text, no shell command.
- `configFile` returns `{ file }`: null for the usual files, else `{ path,
  readable }`. `setConfigFile` takes `{ path }` (full, with `~`, or null),
  keeps it as written in `bb.storage.kv`, signals `config-file-changed` to
  every window, and returns `{ ok: true, file }` or `{ ok: false, reason:
  "not-absolute" }`. `listFolder` (`src/folder-listing.ts`) takes `{ path }` as
  written and returns `{ ok: true, path, parent, entries, truncated }` with
  entries `{ name, kind }` (`folder` or `file`, a link as its target), or `{ ok:
  false, reason, path, parent }` (reason `not-absolute`, `missing`, `is-a-file`,
  `not-a-folder` or `unreadable`). It opens no file and starts no process.
- `src/overlay/tmux-lookup.ts` asks for the tmux config, `src/keymap.ts` builds
  the keymap and words the key help, `src/machine.ts` decides what a key does,
  `src/actions.ts` does it, and `src/section/` draws the settings section.
- `src/constants.ts` holds everything that was read from bb's source and is
  the first file to check after a bb upgrade. The tests use made-up tmux
  configs (`src/tmux-test-support.ts`) and never read a real one.
