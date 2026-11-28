import {
  tmuxConfigFrom,
  type TmuxConfig,
  type TmuxConfigFile,
  type TmuxConfigSources,
} from "./tmux-keymap";

export const TEST_CONFIG_PATH = "~/.tmux.conf";

// A made-up tmux config for the tests, in the style that many vi users write:
// another prefix that is sent on by pressing it twice, letters for the panes,
// other split keys, vi keys in copy mode with their own selection and copy
// keys, windows counted from 1, the mouse on, and a key that reads the config
// again. It is nobody's real file, and neither the page nor the server loads
// this module.
export const VI_STYLE_CONFIG = String.raw`
set -g prefix C-a
unbind C-b
bind C-a send-prefix
set -g base-index 1
set -g mouse on
setw -g mode-keys vi
bind h select-pane -L
bind j select-pane -D
bind k select-pane -U
bind l select-pane -R
bind v split-window -h
bind s split-window -v
bind -r M-h resize-pane -L 5
bind -r M-j resize-pane -D 5
bind -r M-k resize-pane -U 5
bind -r M-l resize-pane -R 5
bind -T copy-mode-vi v send-keys -X begin-selection
bind -T copy-mode-vi y send-keys -X copy-selection-and-cancel
bind -T copy-mode-vi Escape send-keys -X cancel
bind r source-file ~/.tmux.conf \; display-message "Config reloaded"
`;

// What the server found when it read tmux's own config files, with no
// config file chosen and the Config text setting left empty.
export function fileSources(
  files: readonly TmuxConfigFile[],
  unreadable = false,
): TmuxConfigSources {
  return { files, unreadable, namedFile: false, pastedText: { state: "none" } };
}

// What the server answers for a tmux config with this text, worked out by the
// same code as on the server.
export function tmuxConfigOf(text: string): TmuxConfig {
  return tmuxConfigFrom(fileSources([{ path: TEST_CONFIG_PATH, text }]), {
    visual: undefined,
    editor: undefined,
  });
}
