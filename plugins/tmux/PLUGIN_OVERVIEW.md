Move between panes and threads, split, zoom, resize and copy text in bb
without the mouse, with the keys you know from tmux. It is off until you
turn on its "Enable tmux keys" setting.

## What you get

- **Your tmux keys.** The plugin starts from the keyboard bindings of stock
  tmux 3.5a and then reads your tmux config (the text file with your tmux
  settings, such as `~/.tmux.conf`): your prefix, your `bind` and `unbind`
  lines, and the options `prefix2`, `prefix-timeout`, `mode-keys`, `mouse`,
  `repeat-time` and `base-index`.
- A **prefix key** followed by one more key. With the stock keys that is
  `Ctrl-b`, then an arrow key to move between panes, `%` or `"` to open a
  thread in a new pane to the right or below, `z` to zoom, `x` to close,
  `Ctrl` or `Alt` with an arrow key to resize, and `?` for the key help.
- **Threads where tmux has windows.** `c` starts a new thread, `n` and `p`
  go to the next and the previous one, `0` to `9` jump to a thread, and `w`
  opens a thread chooser.
- **Panes you can type in straight away.** When a key takes you to a pane,
  the text cursor is put in its message box (the field where you write to
  the agent).
- A **copy mode** for scrolling through a conversation and selecting and
  copying its text without the mouse, with tmux's emacs or vi keys. Enter it
  with the prefix then `[`.
- A **thread chooser** popup and **sidebar keys** with the keys of tmux's
  lists: `j` `k` or the arrow keys to move, `Enter` to open, `q` to leave.
- **Copy on select**: with `set -g mouse on` in your tmux config,
  conversation text you select with the mouse is copied when you release the
  button.
- **`i`**, the plugin's own key: while the text cursor is not in a text
  field, it puts the cursor in the message box of the focused pane.

## How it works

The server part of the plugin (the piece that bb runs in its server) reads
your tmux config files. In the settings you can browse that server's machine
for another config file, and paste config lines that are applied on top.
It only reads them: it never starts tmux or any other program, never runs a
shell command from the config, and follows no other files or tmux plugins.
Each tmux command of a key binding is turned into what bb can do. Example:
`bind h select-pane -L` in your tmux config makes the prefix then `h` focus
the pane on the left, and `bind -T copy-mode-vi y send-keys -X
copy-selection-and-cancel` makes `y` copy and leave copy mode when its vi
keys are in use. A key bound to a tmux command that bb has no equivalent for
is taken and does nothing.

The key help (the prefix then `?`, or "Tmux: Show keys" in bb's command
palette) lists the keys in effect, names the prefix and says where the keys
come from. A changed config file is picked up when a bb window loads, or
when you press a key that you bound to `source-file`.

The other settings cover what a tmux config cannot say for bb: the thread
order, the scroll step, copy on select and the pixels of a resize cell.

## Good to know

A key without the prefix (bound with `bind -n`) needs Ctrl or Alt, or has to
be a function key. For a prefix that only bb has, paste
`set -g prefix C-Space` into the Config text setting. Pressing the prefix
twice sends it on only with a binding such as `bind C-Space send-prefix`, as
stock tmux has for `Ctrl-b`. Copy mode works in conversations only, with no
searching, rectangle selection or paste key. A copy goes to your system's
clipboard: a selection inside one answer of the agent as Markdown, any other
as plain text.

Several actions rely on bb's page structure, last checked against the source
of bb 0.50.1, and may need an update after a bb upgrade. The plugin's
README lists the stock keys, the tmux config lines that are read, and the
known limits.

## For agents

The bundled `tmux` skill tells an agent how the tmux config is applied and
lists the keys, the settings and the known limits, so that it can answer
your questions or change a setting for you.
