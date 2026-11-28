export const STOCK_TMUX_OPTIONS = {
  prefix: "C-b",
  modeKeys: "emacs",
  mouse: false,
  repeatTimeMs: 500,
  prefixTimeoutMs: 0,
  baseIndex: 0,
} as const;

// The keyboard bindings that tmux 3.5a starts with (key-bindings.c), written
// as config lines for the parser of this plugin. The mouse bindings are left
// out. A key whose command bb has no equivalent for is listed as well, so that
// the key is taken, and a prompt or a menu is cut down to the name of its
// command, because nothing else of it is used.
export const STOCK_TMUX_BINDINGS = String.raw`
bind C-b send-prefix
bind C-o rotate-window
bind C-z suspend-client
bind Space next-layout
bind ! break-pane
bind '"' split-window
bind '#' list-buffers
bind '$' command-prompt
bind % split-window -h
bind & confirm-before -p "kill-window #W? (y/n)" kill-window
bind "'" command-prompt
bind ( switch-client -p
bind ) switch-client -n
bind , command-prompt
bind - delete-buffer
bind . command-prompt
bind / command-prompt
bind 0 select-window -t :=0
bind 1 select-window -t :=1
bind 2 select-window -t :=2
bind 3 select-window -t :=3
bind 4 select-window -t :=4
bind 5 select-window -t :=5
bind 6 select-window -t :=6
bind 7 select-window -t :=7
bind 8 select-window -t :=8
bind 9 select-window -t :=9
bind : command-prompt
bind \; last-pane
bind = choose-buffer -Z
bind ? list-keys -N
bind D choose-client -Z
bind E select-layout -E
bind L switch-client -l
bind M select-pane -M
bind [ copy-mode
bind ] paste-buffer -p
bind c new-window
bind d detach-client
bind f command-prompt
bind i display-message
bind l last-window
bind m select-pane -m
bind n next-window
bind o select-pane -t :.+
bind C customize-mode -Z
bind p previous-window
bind q display-panes
bind r refresh-client
bind s choose-tree -Zs
bind t clock-mode
bind w choose-tree -Zw
bind x confirm-before -p "kill-pane #P? (y/n)" kill-pane
bind z resize-pane -Z
bind '{' swap-pane -U
bind '}' swap-pane -D
bind '~' show-messages
bind PPage copy-mode -u
bind -r Up select-pane -U
bind -r Down select-pane -D
bind -r Left select-pane -L
bind -r Right select-pane -R
bind M-1 select-layout even-horizontal
bind M-2 select-layout even-vertical
bind M-3 select-layout main-horizontal
bind M-4 select-layout main-vertical
bind M-5 select-layout tiled
bind M-6 select-layout main-horizontal-mirrored
bind M-7 select-layout main-vertical-mirrored
bind M-n next-window -a
bind M-o rotate-window -D
bind M-p previous-window -a
bind -r S-Up refresh-client -U 10
bind -r S-Down refresh-client -D 10
bind -r S-Left refresh-client -L 10
bind -r S-Right refresh-client -R 10
bind -r DC refresh-client -c
bind -r M-Up resize-pane -U 5
bind -r M-Down resize-pane -D 5
bind -r M-Left resize-pane -L 5
bind -r M-Right resize-pane -R 5
bind -r C-Up resize-pane -U
bind -r C-Down resize-pane -D
bind -r C-Left resize-pane -L
bind -r C-Right resize-pane -R
bind < display-menu
bind > display-menu

bind -T copy-mode C-Space send-keys -X begin-selection
bind -T copy-mode C-a send-keys -X start-of-line
bind -T copy-mode C-c send-keys -X cancel
bind -T copy-mode C-e send-keys -X end-of-line
bind -T copy-mode C-f send-keys -X cursor-right
bind -T copy-mode C-b send-keys -X cursor-left
bind -T copy-mode C-g send-keys -X clear-selection
bind -T copy-mode C-k send-keys -X copy-pipe-end-of-line-and-cancel
bind -T copy-mode C-n send-keys -X cursor-down
bind -T copy-mode C-p send-keys -X cursor-up
bind -T copy-mode C-r command-prompt
bind -T copy-mode C-s command-prompt
bind -T copy-mode C-v send-keys -X page-down
bind -T copy-mode C-w send-keys -X copy-pipe-and-cancel
bind -T copy-mode Escape send-keys -X cancel
bind -T copy-mode Space send-keys -X page-down
bind -T copy-mode , send-keys -X jump-reverse
bind -T copy-mode \; send-keys -X jump-again
bind -T copy-mode F command-prompt
bind -T copy-mode N send-keys -X search-reverse
bind -T copy-mode P send-keys -X toggle-position
bind -T copy-mode R send-keys -X rectangle-toggle
bind -T copy-mode T command-prompt
bind -T copy-mode X send-keys -X set-mark
bind -T copy-mode f command-prompt
bind -T copy-mode g command-prompt
bind -T copy-mode n send-keys -X search-again
bind -T copy-mode q send-keys -X cancel
bind -T copy-mode r send-keys -X refresh-from-pane
bind -T copy-mode t command-prompt
bind -T copy-mode Home send-keys -X start-of-line
bind -T copy-mode End send-keys -X end-of-line
bind -T copy-mode NPage send-keys -X page-down
bind -T copy-mode PPage send-keys -X page-up
bind -T copy-mode Up send-keys -X cursor-up
bind -T copy-mode Down send-keys -X cursor-down
bind -T copy-mode Left send-keys -X cursor-left
bind -T copy-mode Right send-keys -X cursor-right
bind -T copy-mode M-1 command-prompt
bind -T copy-mode M-2 command-prompt
bind -T copy-mode M-3 command-prompt
bind -T copy-mode M-4 command-prompt
bind -T copy-mode M-5 command-prompt
bind -T copy-mode M-6 command-prompt
bind -T copy-mode M-7 command-prompt
bind -T copy-mode M-8 command-prompt
bind -T copy-mode M-9 command-prompt
bind -T copy-mode M-< send-keys -X history-top
bind -T copy-mode M-> send-keys -X history-bottom
bind -T copy-mode M-R send-keys -X top-line
bind -T copy-mode M-b send-keys -X previous-word
bind -T copy-mode C-M-b send-keys -X previous-matching-bracket
bind -T copy-mode M-f send-keys -X next-word-end
bind -T copy-mode C-M-f send-keys -X next-matching-bracket
bind -T copy-mode M-m send-keys -X back-to-indentation
bind -T copy-mode M-r send-keys -X middle-line
bind -T copy-mode M-v send-keys -X page-up
bind -T copy-mode M-w send-keys -X copy-pipe-and-cancel
bind -T copy-mode M-x send-keys -X jump-to-mark
bind -T copy-mode 'M-{' send-keys -X previous-paragraph
bind -T copy-mode 'M-}' send-keys -X next-paragraph
bind -T copy-mode M-Up send-keys -X halfpage-up
bind -T copy-mode M-Down send-keys -X halfpage-down
bind -T copy-mode C-Up send-keys -X scroll-up
bind -T copy-mode C-Down send-keys -X scroll-down

bind -T copy-mode-vi '#' send-keys -X search-backward
bind -T copy-mode-vi * send-keys -X search-forward
bind -T copy-mode-vi C-c send-keys -X cancel
bind -T copy-mode-vi C-d send-keys -X halfpage-down
bind -T copy-mode-vi C-e send-keys -X scroll-down
bind -T copy-mode-vi C-b send-keys -X page-up
bind -T copy-mode-vi C-f send-keys -X page-down
bind -T copy-mode-vi C-h send-keys -X cursor-left
bind -T copy-mode-vi C-j send-keys -X copy-pipe-and-cancel
bind -T copy-mode-vi Enter send-keys -X copy-pipe-and-cancel
bind -T copy-mode-vi C-u send-keys -X halfpage-up
bind -T copy-mode-vi C-v send-keys -X rectangle-toggle
bind -T copy-mode-vi C-y send-keys -X scroll-up
bind -T copy-mode-vi Escape send-keys -X clear-selection
bind -T copy-mode-vi Space send-keys -X begin-selection
bind -T copy-mode-vi '$' send-keys -X end-of-line
bind -T copy-mode-vi , send-keys -X jump-reverse
bind -T copy-mode-vi / command-prompt
bind -T copy-mode-vi 0 send-keys -X start-of-line
bind -T copy-mode-vi 1 command-prompt
bind -T copy-mode-vi 2 command-prompt
bind -T copy-mode-vi 3 command-prompt
bind -T copy-mode-vi 4 command-prompt
bind -T copy-mode-vi 5 command-prompt
bind -T copy-mode-vi 6 command-prompt
bind -T copy-mode-vi 7 command-prompt
bind -T copy-mode-vi 8 command-prompt
bind -T copy-mode-vi 9 command-prompt
bind -T copy-mode-vi : command-prompt
bind -T copy-mode-vi \; send-keys -X jump-again
bind -T copy-mode-vi ? command-prompt
bind -T copy-mode-vi A send-keys -X append-selection-and-cancel
bind -T copy-mode-vi B send-keys -X previous-space
bind -T copy-mode-vi D send-keys -X copy-pipe-end-of-line-and-cancel
bind -T copy-mode-vi E send-keys -X next-space-end
bind -T copy-mode-vi F command-prompt
bind -T copy-mode-vi G send-keys -X history-bottom
bind -T copy-mode-vi H send-keys -X top-line
bind -T copy-mode-vi J send-keys -X scroll-down
bind -T copy-mode-vi K send-keys -X scroll-up
bind -T copy-mode-vi L send-keys -X bottom-line
bind -T copy-mode-vi M send-keys -X middle-line
bind -T copy-mode-vi N send-keys -X search-reverse
bind -T copy-mode-vi P send-keys -X toggle-position
bind -T copy-mode-vi T command-prompt
bind -T copy-mode-vi V send-keys -X select-line
bind -T copy-mode-vi W send-keys -X next-space
bind -T copy-mode-vi X send-keys -X set-mark
bind -T copy-mode-vi ^ send-keys -X back-to-indentation
bind -T copy-mode-vi b send-keys -X previous-word
bind -T copy-mode-vi e send-keys -X next-word-end
bind -T copy-mode-vi f command-prompt
bind -T copy-mode-vi g send-keys -X history-top
bind -T copy-mode-vi h send-keys -X cursor-left
bind -T copy-mode-vi j send-keys -X cursor-down
bind -T copy-mode-vi k send-keys -X cursor-up
bind -T copy-mode-vi z send-keys -X scroll-middle
bind -T copy-mode-vi l send-keys -X cursor-right
bind -T copy-mode-vi n send-keys -X search-again
bind -T copy-mode-vi o send-keys -X other-end
bind -T copy-mode-vi q send-keys -X cancel
bind -T copy-mode-vi r send-keys -X refresh-from-pane
bind -T copy-mode-vi t command-prompt
bind -T copy-mode-vi v send-keys -X rectangle-toggle
bind -T copy-mode-vi w send-keys -X next-word
bind -T copy-mode-vi '{' send-keys -X previous-paragraph
bind -T copy-mode-vi '}' send-keys -X next-paragraph
bind -T copy-mode-vi % send-keys -X next-matching-bracket
bind -T copy-mode-vi Home send-keys -X start-of-line
bind -T copy-mode-vi End send-keys -X end-of-line
bind -T copy-mode-vi BSpace send-keys -X cursor-left
bind -T copy-mode-vi NPage send-keys -X page-down
bind -T copy-mode-vi PPage send-keys -X page-up
bind -T copy-mode-vi Up send-keys -X cursor-up
bind -T copy-mode-vi Down send-keys -X cursor-down
bind -T copy-mode-vi Left send-keys -X cursor-left
bind -T copy-mode-vi Right send-keys -X cursor-right
bind -T copy-mode-vi M-x send-keys -X jump-to-mark
bind -T copy-mode-vi C-Up send-keys -X scroll-up
bind -T copy-mode-vi C-Down send-keys -X scroll-down
`;
