import type {
  BbNavigate,
  PluginBrowserBbSdk,
  PluginComposerApi,
  PluginSidebarProject,
  PluginSidebarSplitLayout,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { Settings } from "./settings";
import type { TmuxConfig, TmuxModeKeys } from "./tmux-keymap";

export type Direction = "left" | "down" | "up" | "right";
export type Placement = "replace" | "right" | "down";
export type SplitPlacement = Exclude<Placement, "replace">;
export type Edge = "top" | "bottom";

// Where keyboard focus is.
// overlay: a bb dialog, menu, popover or this plugin's own chooser is open or focused.
// frame: an iframe has focus, so its keys never reach this document.
// typing: the integrated terminal, the embedded browser's toolbar, a message
// box or any other text field, select or editor. Only the prefix, the keys of
// tmux's root table and, during repeat-time, the keys bound with -r work here.
// sidebar: on a thread row of the sidebar.
// control: a focused button, link or similar widget outside the sidebar.
// normal: nothing that takes typing has focus.
export type FocusKind =
  | "overlay"
  | "frame"
  | "typing"
  | "sidebar"
  | "control"
  | "normal";

// What the focused pane (or the only pane) is showing.
// thread: a conversation. compose: the New thread screen. other: settings or a plugin page.
export type Surface = "thread" | "compose" | "other";

export type CopyMotion =
  | "char-left"
  | "char-right"
  | "line-up"
  | "line-down"
  | "word-forward"
  | "word-back"
  | "word-end"
  | "line-start"
  | "line-indent"
  | "line-end"
  | "paragraph-back"
  | "paragraph-forward"
  | "document-start"
  | "document-end"
  | "screen-top"
  | "screen-middle"
  | "screen-bottom"
  | "half-page-up"
  | "half-page-down"
  | "page-up"
  | "page-down";

// What follows a copy: leave copy mode, drop the selection and stay, or keep
// the selection and stay.
export type AfterCopy = "exit" | "clear" | "keep";

// What a key of the tmux keymap runs.
// pane.neighbour: the pane that tmux finds on that side of the focused one
// for a target such as {left-of}. Unlike pane.focus it goes around at every
// edge of the window, never to the sidebar, and finding no pane is an error.
// pane.resize: cells is tmux's adjustment, in terminal cells.
// thread.jump: index counts from 1, base-index is already taken off.
// thread.end: the last thread of the thread order, tmux's {end}.
// prefix.send: second is true for the key of the prefix2 option.
// copy.enter: motion is a move made right after copy mode is entered.
// copy.beginSelection starts a selection at the cursor, also when one is
// under way.
// copy.yank: with nothing selected, "exit" still leaves copy mode.
export type TmuxAction =
  | { type: "pane.focus"; direction: Direction }
  | { type: "pane.neighbour"; direction: Direction }
  | { type: "pane.next" }
  | { type: "pane.previous" }
  | { type: "pane.last" }
  | { type: "pane.resize"; direction: Direction; cells: number }
  | { type: "pane.zoom" }
  | { type: "pane.close" }
  | { type: "chooser.open"; placement: Placement }
  | { type: "thread.new" }
  | { type: "thread.jump"; index: number }
  | { type: "thread.end" }
  | { type: "thread.cycle"; delta: 1 | -1 }
  | { type: "thread.last" }
  | { type: "help.open" }
  | { type: "prefix.send"; second: boolean }
  | { type: "config.reload" }
  | { type: "notice.show"; text: string }
  | { type: "copy.enter"; motion: CopyMotion | null }
  | { type: "copy.move"; motion: CopyMotion }
  | { type: "copy.scroll"; direction: 1 | -1 }
  | { type: "copy.beginSelection" }
  | { type: "copy.clearSelection" }
  | { type: "copy.yank"; after: AfterCopy }
  | { type: "copy.exit" };

// The actions of the keys that are this plugin's own and not tmux's.
// sidebar.page moves by as many rows as the sidebar shows at once.
type OwnAction =
  | { type: "sidebar.move"; delta: 1 | -1 }
  | { type: "sidebar.page"; delta: 1 | -1 }
  | { type: "sidebar.edge"; edge: Edge }
  | { type: "sidebar.open"; placement: Placement }
  | { type: "sidebar.leave" }
  | { type: "composer.focus" };

export type Action = TmuxAction | OwnAction;

export type ActionType = Action["type"];

// repeat: the key was bound with -r in the prefix table of tmux.
export interface KeyBinding {
  key: string;
  actions: readonly Action[];
  repeat: boolean;
}

// The keys that open the highlighted thread of a list in a new pane, and the
// ones that start a new thread from the thread chooser. They are the keys
// that the prefix table binds to the commands for that.
export interface ListSplitKeys {
  right: readonly string[];
  down: readonly string[];
  newThread: readonly string[];
}

// prefix2 is tmux's second prefix key, null when there is none.
// rootBindings work without the prefix wherever the prefix works.
// plainBindings work without the prefix and without Shift, wherever the cursor
// is not in a text field, the terminal or a dialog, and outside copy mode.
// sidebarBindings are for a thread row of the sidebar that has the focus.
// repeatTimeMs: for how long after a prefix key bound with -r the keys bound
// with -r work without the prefix. 0 switches that off.
// prefixTimeoutMs: for how long the prefix waits for the next key. 0 means
// that it waits until a key comes.
// sentCopyBindings: what the copy table binds the prefix keys to. Such a key
// always arms the prefix, so its copy binding only runs when a send-prefix
// sends the key on to a pane that is in copy mode.
export interface Keymap {
  prefix: string;
  prefix2: string | null;
  repeatTimeMs: number;
  prefixTimeoutMs: number;
  modeKeys: TmuxModeKeys;
  prefixBindings: readonly KeyBinding[];
  rootBindings: readonly KeyBinding[];
  plainBindings: readonly KeyBinding[];
  sidebarBindings: readonly KeyBinding[];
  copyBindings: readonly KeyBinding[];
  sentCopyBindings: readonly KeyBinding[];
  listSplitKeys: ListSplitKeys;
}

// repeat: a prefix key bound with -r has just run, so until the deadline the
// keys bound with -r work without the prefix.
export interface MachineState {
  pending: "none" | "prefix" | "repeat";
  deadline: number | null;
}

export interface StepInput {
  stroke: string;
  shift: boolean;
  focus: FocusKind;
  copyMode: boolean;
  now: number;
}

// actions is empty for a key that is passed on or swallowed without more.
export interface StepResult {
  state: MachineState;
  decision: "consume" | "pass";
  actions: readonly Action[];
}

export type SplitPane = PluginSidebarSplitLayout["panes"][number];

export interface ChooserItem {
  threadId: string;
  title: string;
  projectName: string | null;
  isVisibleInPane: boolean;
  isFocusedPane: boolean;
  isChild: boolean;
  isRunning: boolean;
  isUnread: boolean;
}

// What became of reading the tmux config again. incomplete: the server
// answered, but a config file or the pasted lines could not be read. failed:
// the server did not answer.
export type ConfigReload = "read" | "incomplete" | "failed";

// The latest values of bb's React hooks, published by the overlay component so
// plain functions (the key handler, palette commands) can use them.
// tmux is stock tmux with the user's tmux config applied to it.
// reloadTmuxConfig reads the tmux config again and says what became of that.
export interface Bridge {
  navigate: BbNavigate;
  sdk: PluginBrowserBbSdk;
  layout: PluginSidebarSplitLayout | null;
  context: { projectId: string | null; threadId: string | null };
  threads: readonly PluginSidebarThread[];
  threadsReady: boolean;
  projects: readonly PluginSidebarProject[];
  composers: readonly PluginComposerApi[];
  settings: Settings;
  tmux: TmuxConfig;
  reloadTmuxConfig: () => Promise<ConfigReload>;
}

export type ChooserState =
  | { open: false }
  | { open: true; placement: Placement };

export interface Notice {
  id: number;
  text: string;
}

// Viewport coordinates of the copy-mode cursor, for a position: fixed element.
export interface CursorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type CopyModeUi =
  | { active: false }
  | { active: true; selecting: boolean; cursor: CursorRect | null };

// What the Enable setting says. unknown: bb has not handed over the settings
// yet, so the plugin handles no key, and it is not known to be off either.
export type SwitchState = "unknown" | "off" | "on";

// prefixArmedBy: the prefix key that was pressed for the prefix the pill
// shows, null while prefixArmed is false.
export interface UiState {
  chooser: ChooserState;
  helpOpen: boolean;
  prefixArmed: boolean;
  prefixArmedBy: string | null;
  paused: boolean;
  switchState: SwitchState;
  notice: Notice | null;
  copyMode: CopyModeUi;
}
