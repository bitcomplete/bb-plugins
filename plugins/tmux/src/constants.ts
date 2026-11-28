// Every bb-internal selector, event name and storage key the plugin relies on.
// None of these are public plugin API. They were read from bb desktop 0.49.0,
// compared with the source of bb desktop 0.50.1, and can change in any release,
// so keep them here and nowhere else.
export const BB_VERSION_VERIFIED = "0.50.1";

export const PLUGIN_ID = "tmux";

export const SELECTORS = {
  openModal:
    '[aria-modal="true"]:not([inert]):not([inert] *):not([data-state="closed"]), [role="dialog"][data-state="open"]:not([inert]):not([inert] *)',
  terminal: "[data-app-terminal]",
  // bb's setup guide shows a terminal without the marker above, so the root
  // class of xterm.js, the terminal library bb uses, is matched as well.
  xterm: ".xterm",
  browser: "[data-app-browser]",
  composer: "[data-app-composer]",
  // Every composer that is not the message box of a pane: the editor bb opens
  // in place to change a sent or a queued message, and the chat of a plugin
  // panel or of a plugin page. Read from bb 0.50.1 only.
  secondaryComposer: '[data-app-composer][data-app-composer-role="secondary"]',
  // The message box of a thread pane and of the New thread screen.
  messageBox: '[data-app-composer]:not([data-app-composer-role="secondary"])',
  // The part of the window beside the sidebar. bb 0.50.1 wraps a thread and
  // the New thread screen in a pane element also when there is a single pane,
  // so this only stands in for the pane on a page that has no pane element.
  appMain: "main",
  splitPane: "[data-split-pane-id]",
  sidePanelSplitContainer: "[data-sidebar-split-container]",
  // The pane bb marks as current. The side panel reuses the pane attributes
  // for its tab groups. While a pane is zoomed bb marks that pane and no
  // hidden one, so leaving out a hidden pane is only a safeguard.
  focusedThreadPane:
    '[data-split-pane-id][data-focused="true"]:not([aria-hidden="true"]):not([data-sidebar-split-container] *)',
  // bb's own overlay over a pane's visible area. It sits above the pane's
  // content and stops below the window's title strip, which the pane root
  // itself does not.
  paneFocusScrim: "[data-pane-focus-scrim]",
  // The line between two thread panes, read from bb 0.50.1 only. The side
  // panel's tab groups have dividers with the same attributes, and bb hides
  // every divider with the invisible class while a pane is zoomed.
  splitDivider:
    '[role="separator"][data-split-resize-grid-boundary][data-split-resize-grid-count]:not(.invisible):not([data-sidebar-split-container] *)',
  // The child of a divider that takes the mouse press of a drag.
  splitDividerHitTarget: "[data-split-divider-hit-target]",
  // The row or column that a divider and the panes around it belong to. Like
  // the divider, read from bb 0.50.1 only.
  splitGrid: "[data-split-resize-grid-root]",
  threadWindow: "[data-thread-window]",
  scrollViewport: "[data-page-scroll-viewport]",
  // The sticky block at the bottom of the conversation scroller that holds the
  // message box. It covers the last lines of the conversation.
  scrollFooter: "[data-scroll-footer]",
  // bb's "Add to chat" menu for selected message text. It is the one popover
  // bb renders inside the conversation scroller, it matches openModal, and it
  // never takes focus.
  selectionMenu:
    '[data-thread-window] [data-page-scroll-viewport] [data-radix-popper-content-wrapper] > [role="dialog"]',
  // The header that bb draws above a code block: the name of the language
  // and the buttons for line wrap and for copying the code. bb marks it so
  // that its own copy handler leaves its text out (omittedElements in
  // lib/markdown-clipboard.ts), and nothing else carries the mark. Read from
  // bb 0.50.1 only.
  codeBlockHeader: "[data-clipboard-ignore]",
  // The button under a message that bb shows cut short, labelled "Show more"
  // or "Show less" (ConversationMessageOverflowToggle in
  // conversation-message-overflow.tsx). It carries no mark of its own: it is
  // the button of a message that says whether something is expanded and that
  // opens no menu, as the button for the message actions does. Read from bb
  // 0.50.1 only.
  messageOverflowToggle:
    "[data-message-column] button[aria-expanded]:not([aria-haspopup])",
  // The text of one assistant message. bb's copy handler (handleSharedCopy in
  // SelectableMessageProse.tsx) answers a copy inside one such element with
  // the Markdown of what is selected. bb finds the element in a list of its
  // own, and the attribute, which it sets for the swipe gesture of its
  // sidebar, is the only mark of it in the page. Read from bb 0.50.1 only.
  messageProse: "[data-sidebar-swipe-selectable]",
  popover: '[data-radix-popper-content-wrapper] > [role="dialog"]',
  closePaneButton: 'button[aria-label="Close pane"]',
  // Matched by label because the pane header also holds the "Pin thread context"
  // toggle, which carries aria-pressed too. Desktop and web use different labels.
  maximizePaneButton:
    'button[aria-pressed][aria-label^="Full Screen"], button[aria-pressed][aria-label^="Exit Full Screen"], button[aria-pressed][aria-label^="Maximize pane"], button[aria-pressed][aria-label^="Restore split"]',
  sidebarRoot: '[data-sidebar="sidebar"]',
  sidebarStateHolder: '[data-variant="sidebar"][data-state]',
  sidebarTrigger: '[data-sidebar="trigger"]',
  sidebarBody: '[data-testid="app-sidebar-body"]',
  // The part of the sidebar that scrolls, and the headers that bb pins at its
  // top while the list scrolls under them: the label of a section, a project
  // row and the parents of a nested thread row. They are opaque and cover the
  // rows behind them. Read from bb 0.50.1 only.
  sidebarScroller: '[data-sidebar="content"]',
  sidebarPinnedHeader: "[data-sidebar-sticky-tier]",
  sidebarRow: "a[data-sidebar-thread-shortcut-target][data-sidebar-thread-id]",
  sidebarSelectedRow: "[data-sidebar-thread-selected]",
  sidebarWindowedNav: "[data-sidebar-windowed-nav]",
  sidebarWindowedItem: "[data-sidebar-windowed-item]",
  sidebarOverflow: "[data-sidebar-overflow='true']",
  portaledOverlay: "[data-bb-portaled-overlay]",
  radixPopper: "[data-radix-popper-content-wrapper]",
  monacoEditor: ".monaco-editor",
} as const;

export const ATTRIBUTES = {
  paneId: "data-split-pane-id",
  paneFocused: "data-focused",
  paneMaximized: "data-maximized",
  paneHiddenByZoom: "aria-hidden",
  dividerOrientation: "aria-orientation",
  // A divider's place in its row or column, counted from 1, and the number of
  // panes in that row or column. Both read from bb 0.50.1 only.
  dividerBoundaryIndex: "data-split-resize-grid-boundary",
  dividerPaneCount: "data-split-resize-grid-count",
  sidebarThreadId: "data-sidebar-thread-id",
  sidebarWindowedNav: "data-sidebar-windowed-nav",
  sidebarState: "data-state",
  sidebarTriggerExpanded: "aria-expanded",
} as const;

// bb shows the same "Add to chat" menu for text selected in the terminal, in a
// file preview and in the diff view. There it sits on the page body like every
// other popover, and its button is the only thing that tells it apart.
export const SELECTION_MENU_BUTTON_LABEL = "Add to chat";

// A divider is named after the line it draws: a vertical one sits between
// panes that are side by side, a horizontal one between stacked panes.
export const DIVIDER_ORIENTATIONS = {
  sideBySide: "vertical",
  stacked: "horizontal",
} as const;

// bb's rules for the size of panes, read from bb 0.50.1 only. minPaneShare is
// MIN_SIZE in lib/split-layout/ops.ts: while a divider is dragged, bb keeps
// each of the two panes beside it at that share of the room the two have
// together. When it stores the result it wants every pane at that share of
// the whole row or column, and takes what is missing from the other panes.
// snapCapturePx is SPLIT_RESIZE_SNAP_CAPTURE_PX in lib/split-resize-snap.ts:
// a divider dropped that close to the line of an even split lands on it.
export const SPLIT_LIMITS = {
  minPaneShare: 0.15,
  snapCapturePx: 12,
} as const;

// "expanded" on wide windows, "open" on the narrow-window drawer.
export const SIDEBAR_OPEN_STATES: readonly string[] = ["expanded", "open"];

export const EVENTS = {
  paneFocusPointer: "pointerdown",
  paneFocusPointerEnd: "pointerup",
  userScrollInput: "wheel",
  dividerDragStart: "pointerdown",
  dividerDragMove: "pointermove",
  dividerDragEnd: "pointerup",
  dividerDragCancel: "pointercancel",
} as const;

// The browser editing command whose "copy" event bb's message text answers
// with its own text/plain and text/html.
export const COPY_COMMAND = "copy";

// Public SDK event names, listed here so every event name lives in one file.
export const SDK_EVENTS = {
  configChanged: "system:config-changed",
} as const;

export const BB_ROUTES = {
  newThread: "/",
} as const;

export const BB_COMMANDS = {
  paneClose: "pane.close",
  paneMaximizeToggle: "pane.maximize.toggle",
  sidebarToggle: "sidebar.toggle",
} as const;

export const BB_CONTEXT_KEYS = {
  webSurface: "webSurface",
} as const;

export const BB_PLATFORM_CONTEXT_KEYS = {
  mac: "macPlatform",
  windows: "windowsPlatform",
  linux: "linuxPlatform",
} as const;

export const BB_DESKTOP_GLOBAL = "bbDesktop";

// Set on the root element of the page while the plugin is switched on. The
// rules of app.css reach into bb's own elements and only apply under it.
export const SWITCHED_ON_ATTRIBUTE = "data-tmux-keys";

export const PLUGIN_STORAGE_KEYS = {
  layoutSnapshot: `${PLUGIN_ID}:layout-snapshot:v1`,
} as const;

// Names for the browser's Web Locks API, shared by every window of one origin.
export const PLUGIN_LOCKS = {
  openWindow: `${PLUGIN_ID}:open-window`,
} as const;

export const MAX_PANES = 8;
