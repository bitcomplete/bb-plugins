import { TERMINAL_KEYS, formatStroke } from "./keys";
import {
  LIST_COMMAND_KEYS,
  LIST_COMMANDS,
  LIST_KEYS,
  type ListCommand,
} from "./list-keys";
import {
  describePrefix,
  resolvePrefix,
  worksWithoutPrefix,
  type TmuxLookup,
} from "./prefix";
import {
  CONFIG_TEXT_LABEL,
  CONFIG_TEXT_NAME,
  type Settings,
} from "./settings";
import {
  wasAllRead,
  type TmuxConfig,
  type TmuxKeyBinding,
} from "./tmux-keymap";
import type {
  Action,
  AfterCopy,
  CopyMotion,
  Direction,
  KeyBinding,
  Keymap,
  ListSplitKeys,
  Placement,
  SplitPlacement,
} from "./types";

export interface HelpRow {
  keys: string;
  description: string;
}

export interface HelpSection {
  title: string;
  rows: HelpRow[];
}

// isFromServer is false for the stock tmux that stands in for an answer of
// the server that did not come.
export interface TmuxSource {
  config: TmuxConfig;
  isFromServer: boolean;
}

interface HelpContext {
  keymap: Keymap;
  settings: Settings;
  isMac: boolean;
}

const MS_PER_SECOND = 1000;
const SHIFTED_SYMBOL_CHORD = /^((?:C-)?(?:M-)?)S-([^\p{L}\p{N}])$/u;
const DIGIT_KEY = /^[0-9]$/;
const REPEAT_MARK = "(repeats)";

const STOCK_KEYS_ONLY = "so these are the keys of stock tmux.";
// The config file is chosen in the settings section of the plugin and is no
// setting, so the key help names it by where it was chosen.
const CHOSEN_IN_SETTINGS = "chosen in the plugin's settings";
const NAMED_FILE_NOT_READ = `The config file ${CHOSEN_IN_SETTINGS} could not be read`;
const PASTED_TEXT_NOT_READ = `The ${CONFIG_TEXT_LABEL} setting is too large to be read`;

// The keys that are this plugin's own and that no tmux config changes: the
// filter of the thread chooser, and the key that puts the cursor in the
// message box.
export const CHOOSER_FILTER_KEY = "/";
const MESSAGE_BOX_KEY = "i";

const PANE_FOCUS_DESCRIPTIONS: Record<Direction, string> = {
  left: "Focus the pane to the left, or the sidebar from the leftmost pane",
  down: "Focus the pane below",
  up: "Focus the pane above",
  right: "Focus the pane to the right",
};

const PANE_NEIGHBOUR_DESCRIPTIONS: Record<Direction, string> = {
  ...PANE_FOCUS_DESCRIPTIONS,
  left: "Focus the pane to the left, or the rightmost pane from the leftmost one",
};

const PANE_RESIZE_DESCRIPTIONS: Record<Direction, string> = {
  left: "Resize this pane by moving its divider to the left",
  down: "Resize this pane by moving its divider down",
  up: "Resize this pane by moving its divider up",
  right: "Resize this pane by moving its divider to the right",
};

const CHOOSER_OPEN_DESCRIPTIONS: Record<Placement, string> = {
  replace: "Choose a thread to open in this pane",
  right: "Choose a thread, or the New thread row, for a new pane to the right",
  down: "Choose a thread, or the New thread row, for a new pane below",
};

const COPY_YANK_DESCRIPTIONS: Record<AfterCopy, string> = {
  exit: "Copy the selection and leave copy mode",
  clear: "Copy the selection and drop it",
  keep: "Copy the selection and keep it",
};

const COPY_MOTION_DESCRIPTIONS: Record<CopyMotion, string> = {
  "char-left": "Move left one character",
  "char-right": "Move right one character",
  "line-up": "Move up one line",
  "line-down": "Move down one line",
  "word-forward": "Move to the next word",
  "word-back": "Move to the previous word",
  "word-end": "Move to the end of the word",
  "line-start": "Move to the start of the line",
  "line-indent": "Move to the first character of the line that is not a blank",
  "line-end": "Move to the end of the line",
  "paragraph-back": "Move to the previous paragraph",
  "paragraph-forward": "Move to the next paragraph",
  "document-start": "Move to the start of the conversation",
  "document-end": "Move to the end of the conversation",
  "screen-top": "Move to the top visible line",
  "screen-middle": "Move to the middle visible line",
  "screen-bottom": "Move to the bottom visible line",
  "half-page-up": "Move up half a page",
  "half-page-down": "Move down half a page",
  "page-up": "Move up one page",
  "page-down": "Move down one page",
};

const SIDEBAR_OPEN_DESCRIPTIONS: Record<Placement, string> = {
  replace: "Open the thread in the focused pane",
  right: "Open the thread in a new pane to the right",
  down: "Open the thread in a new pane below",
};

const SIDEBAR_ACTIONS: Record<ListCommand, Action> = {
  previous: { type: "sidebar.move", delta: -1 },
  next: { type: "sidebar.move", delta: 1 },
  "page-up": { type: "sidebar.page", delta: -1 },
  "page-down": { type: "sidebar.page", delta: 1 },
  first: { type: "sidebar.edge", edge: "top" },
  last: { type: "sidebar.edge", edge: "bottom" },
  choose: { type: "sidebar.open", placement: "replace" },
  leave: { type: "sidebar.leave" },
};

const CHOOSER_DESCRIPTIONS: Record<ListCommand, string> = {
  previous: "Move to the previous thread",
  next: "Move to the next thread",
  "page-up": "Move up one page",
  "page-down": "Move down one page",
  first: "Move to the first thread",
  last: "Move to the last thread",
  choose: "Open the thread where the chooser was asked to",
  leave: "Close the chooser",
};

const CHOOSER_SPLIT_DESCRIPTIONS: Record<keyof ListSplitKeys, string> = {
  right: SIDEBAR_OPEN_DESCRIPTIONS.right,
  down: SIDEBAR_OPEN_DESCRIPTIONS.down,
  newThread: "Start a new thread in the new pane that the chooser was opened for",
};

function ownBinding(key: string, action: Action): KeyBinding {
  return { key, actions: [action], repeat: false };
}

const PLAIN_BINDINGS: readonly KeyBinding[] = [
  ownBinding(MESSAGE_BOX_KEY, { type: "composer.focus" }),
];

// The prefix is not known when a file or the pasted text that could not be
// read may be what sets it. The key help then says whether nothing of the
// config was read or a part of it.
function prefixLookup({ config, isFromServer }: TmuxSource): TmuxLookup {
  const { prefix } = config.options;
  if (!isFromServer) return { status: "unavailable" };
  if (prefix !== null || wasAllRead(config)) return { status: "answered", prefix };
  const wasPartRead = appliedSources(config).length > 0;
  return { status: wasPartRead ? "partly-read" : "unavailable" };
}

function prefix2Of(config: TmuxConfig, prefix: string): string | null {
  const { prefix2 } = config.options;
  if (prefix2 === null || !prefix2.usable) return null;
  return prefix2.key === prefix ? null : prefix2.key;
}

// send-prefix is done by letting the key press it is bound to through, so it
// only sends the prefix when that key is the prefix itself.
function sendsPressedKey(
  action: Action,
  key: string,
  prefix: string,
  prefix2: string | null,
): boolean {
  if (action.type !== "prefix.send") return true;
  return key === (action.second ? prefix2 : prefix);
}

function splitCommandOf(binding: KeyBinding): keyof ListSplitKeys | null {
  for (const action of binding.actions) {
    if (action.type === "thread.new") return "newThread";
    if (action.type !== "chooser.open") continue;
    if (action.placement !== "replace") return action.placement;
  }
  return null;
}

// A list key of tmux and the filter key of the thread chooser stay what they
// are, also when the prefix table binds the same key to a split.
function listSplitKeysOf(prefixBindings: readonly KeyBinding[]): ListSplitKeys {
  const keys: Record<keyof ListSplitKeys, string[]> = {
    right: [],
    down: [],
    newThread: [],
  };
  for (const binding of prefixBindings) {
    if (LIST_KEYS.has(binding.key) || binding.key === CHOOSER_FILTER_KEY) continue;
    const command = splitCommandOf(binding);
    if (command !== null) keys[command].push(binding.key);
  }
  return keys;
}

function sidebarOpenBindings(
  keys: readonly string[],
  placement: SplitPlacement,
): KeyBinding[] {
  return keys.map((key) => ownBinding(key, { type: "sidebar.open", placement }));
}

function sidebarBindingsOf(splitKeys: ListSplitKeys): KeyBinding[] {
  return [
    ...LIST_COMMANDS.flatMap((command) =>
      LIST_COMMAND_KEYS[command].map((key) =>
        ownBinding(key, SIDEBAR_ACTIONS[command]),
      ),
    ),
    ...sidebarOpenBindings(splitKeys.right, "right"),
    ...sidebarOpenBindings(splitKeys.down, "down"),
  ];
}

export function sendsPrefix(binding: KeyBinding): boolean {
  return binding.actions.some((action) => action.type === "prefix.send");
}

// The keys of this plugin: stock tmux with the user's tmux config applied to
// it, and the few keys that are the plugin's own. A prefix key always arms
// the prefix, so a binding on it outside the prefix table cannot run from
// that key press and is left out. The copy table is the exception: its
// binding on a key that the prefix table sends on with send-prefix is kept
// apart, for the pane in copy mode that the key is sent to. A key of the root
// table needs Ctrl or Alt, or has to be a function key, and one that bb has
// no equivalent for is not taken at all, so that it still reaches bb and the
// terminal. A key of the root table that is taken comes before the list keys
// of a sidebar row, so the row has no key of that name. -r only means
// something in the prefix table.
export function buildKeymap(config: TmuxConfig): Keymap {
  const { options, tables } = config;
  const { stroke: prefix } = resolvePrefix({
    status: "answered",
    prefix: options.prefix,
  });
  const prefix2 = prefix2Of(config, prefix);
  const isPrefixKey = (key: string) => key === prefix || key === prefix2;
  const fromTmux = (
    table: readonly TmuxKeyBinding[],
    canRepeat = false,
  ): KeyBinding[] =>
    table.map(({ key, repeat, actions }) => ({
      key,
      repeat: canRepeat && repeat,
      actions: actions.filter((action) =>
        sendsPressedKey(action, key, prefix, prefix2),
      ),
    }));
  const reachable = (bindings: readonly KeyBinding[]): KeyBinding[] =>
    bindings.filter((binding) => !isPrefixKey(binding.key));
  const prefixBindings = fromTmux(tables.prefix, true);
  const sentKeys = new Set(
    prefixBindings.filter(sendsPrefix).map((binding) => binding.key),
  );
  const listSplitKeys = listSplitKeysOf(prefixBindings);
  const copyTable = options.modeKeys === "vi" ? tables.copyModeVi : tables.copyMode;
  const copyBindings = fromTmux(copyTable);
  const rootBindings = reachable(fromTmux(tables.root)).filter(
    (binding) => worksWithoutPrefix(binding.key) && binding.actions.length > 0,
  );
  const rootKeys = new Set(rootBindings.map((binding) => binding.key));
  return {
    prefix,
    prefix2,
    repeatTimeMs: options.repeatTimeMs,
    prefixTimeoutMs: options.prefixTimeoutMs,
    modeKeys: options.modeKeys,
    prefixBindings,
    rootBindings,
    plainBindings: PLAIN_BINDINGS,
    sidebarBindings: reachable(sidebarBindingsOf(listSplitKeys)).filter(
      (binding) => !rootKeys.has(binding.key),
    ),
    copyBindings: reachable(copyBindings),
    sentCopyBindings: copyBindings.filter((binding) => sentKeys.has(binding.key)),
    listSplitKeys,
  };
}

// Whether the stroke is a key that does something. The plain keys are left
// out on purpose: they only count when they are pressed without Ctrl, Alt or
// Cmd, so a chord must never stand in for one. A key that is bound to a
// command bb has no equivalent for does not count either, or the Option-5 of
// a keyboard that types "[" with it would be taken for tmux's M-5.
function hasStroke(keymap: Keymap, stroke: string): boolean {
  if (stroke === keymap.prefix || stroke === keymap.prefix2) return true;
  const tables = [
    keymap.prefixBindings,
    keymap.rootBindings,
    keymap.sidebarBindings,
    keymap.copyBindings,
  ];
  return tables.some((bindings) =>
    bindings.some(
      (binding) => binding.key === stroke && binding.actions.length > 0,
    ),
  );
}

// A symbol such as ? or ^ needs Shift on one keyboard layout and not on
// another, and the key press names the symbol either way. So a chord on a
// symbol, such as the prefix C-^ or the key M-< from a tmux config, is also
// met with Shift held.
function withoutShiftOnSymbol(chord: string): string | null {
  const match = SHIFTED_SYMBOL_CHORD.exec(chord);
  return match === null ? null : match[1] + match[2];
}

// A key press that is a chord and a typed character at once counts as the
// chord when a key of this plugin uses that chord, and as the character when
// only the character is one of its keys. Otherwise it stays a chord, so that
// it is passed on to bb like every other shortcut.
export function strokeForKeymap(
  keymap: Keymap,
  chord: string,
  typedCharacter: string | null,
): string {
  const unshifted = withoutShiftOnSymbol(chord);
  const isPrefixWithShift =
    unshifted === keymap.prefix || unshifted === keymap.prefix2;
  if (unshifted !== null && isPrefixWithShift) return unshifted;
  if (hasStroke(keymap, chord)) return chord;
  if (unshifted !== null && hasStroke(keymap, unshifted)) return unshifted;
  if (typedCharacter === null) return chord;
  return hasStroke(keymap, typedCharacter) ? typedCharacter : chord;
}

function cellCount(cells: number): string {
  return cells === 1 ? "1 cell" : `${cells} cells`;
}

function jumpOrder(settings: Settings): string {
  return settings.threadOrder === "sidebar"
    ? "in sidebar order"
    : "most recent first";
}

function describeAction(action: Action, context: HelpContext): string {
  const { keymap, settings, isMac } = context;
  switch (action.type) {
    case "pane.focus":
      return PANE_FOCUS_DESCRIPTIONS[action.direction];
    case "pane.neighbour":
      return PANE_NEIGHBOUR_DESCRIPTIONS[action.direction];
    case "pane.next":
      return "Focus the next pane in the order of the splits, and the first one after the last";
    case "pane.previous":
      return "Focus the previous pane in the order of the splits, and the last one before the first";
    case "pane.last":
      return "Focus the pane that had the focus before";
    case "pane.resize":
      return `${PANE_RESIZE_DESCRIPTIONS[action.direction]} by ${cellCount(action.cells)}`;
    case "pane.zoom":
      return "Zoom or unzoom this pane";
    case "pane.close":
      return "Close this pane";
    case "chooser.open":
      return CHOOSER_OPEN_DESCRIPTIONS[action.placement];
    case "thread.new":
      return "Start a new thread in this pane";
    case "thread.jump":
      return `Jump to thread ${action.index}, ${jumpOrder(settings)}`;
    case "thread.end":
      return `Jump to the last thread, ${jumpOrder(settings)}`;
    case "thread.cycle":
      return action.delta === 1
        ? "Go to the next thread"
        : "Go to the previous thread";
    case "thread.last":
      return "Go to the thread that this pane showed before";
    case "help.open":
      return "Show this help";
    case "prefix.send": {
      const sent = action.second ? keymap.prefix2 : keymap.prefix;
      return `Send ${formatStroke(sent ?? keymap.prefix, isMac)} itself to the terminal or text field`;
    }
    case "config.reload":
      return "Read the tmux config again";
    case "notice.show":
      return `Show the notice "${action.text}"`;
    case "copy.enter":
      if (action.motion === null) {
        return "Enter copy mode to scroll, select and copy conversation text";
      }
      return action.motion === "page-down"
        ? "Enter copy mode and scroll one page down"
        : "Enter copy mode and scroll one page up";
    case "copy.move":
      return COPY_MOTION_DESCRIPTIONS[action.motion];
    case "copy.scroll":
      return action.direction === 1
        ? "Scroll the conversation down one step"
        : "Scroll the conversation up one step";
    case "copy.beginSelection":
      return "Start selecting from the cursor";
    case "copy.clearSelection":
      return "Drop the selection";
    case "copy.yank":
      return COPY_YANK_DESCRIPTIONS[action.after];
    case "copy.exit":
      return "Leave copy mode without copying";
    case "sidebar.move":
      return action.delta === 1
        ? "Move to the next thread"
        : "Move to the previous thread";
    case "sidebar.page":
      return action.delta === 1 ? "Move down one page" : "Move up one page";
    case "sidebar.edge":
      return action.edge === "top"
        ? "Move to the first thread"
        : "Move to the last thread";
    case "sidebar.open":
      return SIDEBAR_OPEN_DESCRIPTIONS[action.placement];
    case "sidebar.leave":
      return "Return to the pane";
    case "composer.focus":
      return "Put the text cursor in the message box of the focused pane";
  }
}

// Parts that each begin with a capital letter, as one sentence.
function inOneSentence(parts: readonly string[], separator: string): string {
  return parts
    .map((text, at) => (at === 0 ? text : text[0].toLowerCase() + text.slice(1)))
    .join(separator);
}

// A key that tmux runs the same command several times for, such as
// send-keys -N 5, says so once.
function describeActions(
  actions: readonly Action[],
  context: HelpContext,
): string {
  const parts: { text: string; count: number }[] = [];
  for (const action of actions) {
    const text = describeAction(action, context);
    const last = parts.at(-1);
    if (last?.text === text) {
      last.count += 1;
      continue;
    }
    parts.push({ text, count: 1 });
  }
  return inOneSentence(
    parts.map(({ text, count }) =>
      count === 1 ? text : `${text}, ${count} times`,
    ),
    ", then ",
  );
}

function describeBinding(binding: KeyBinding, context: HelpContext): string {
  const description = describeActions(binding.actions, context);
  const repeats = binding.repeat && context.keymap.repeatTimeMs > 0;
  return repeats ? `${description} ${REPEAT_MARK}` : description;
}

function jumpIndex(binding: KeyBinding): number | null {
  const [action, ...others] = binding.actions;
  if (action?.type !== "thread.jump" || others.length > 0) return null;
  return DIGIT_KEY.test(binding.key) ? action.index : null;
}

// Bindings that run the same actions share one help row, and the digit keys
// that jump to a thread share a row for as long as they count on.
function helpGroupId(binding: KeyBinding): string {
  const repeat = binding.repeat ? "repeat" : "once";
  if (jumpIndex(binding) !== null) return `thread.jump ${repeat}`;
  return `${JSON.stringify(binding.actions)} ${repeat}`;
}

function countsOn(group: readonly KeyBinding[]): boolean {
  return group.every((binding, at) => {
    if (at === 0) return true;
    const previous = group[at - 1];
    const step = (jumpIndex(binding) ?? 0) - (jumpIndex(previous) ?? 0);
    return step === 1 && Number(binding.key) - Number(previous.key) === 1;
  });
}

function groupRows(group: readonly KeyBinding[], context: HelpContext): HelpRow[] {
  const first = group[0];
  const last = group[group.length - 1];
  const from = jumpIndex(first);
  const to = jumpIndex(last);
  if (from === null || to === null || group.length === 1) {
    const labels = group.map((binding) =>
      formatStroke(binding.key, context.isMac),
    );
    return [
      { keys: labels.join(" / "), description: describeBinding(first, context) },
    ];
  }
  if (!countsOn(group)) {
    return group.flatMap((binding) => groupRows([binding], context));
  }
  return [
    {
      keys: `${first.key}-${last.key}`,
      description: `Jump to thread ${from}-${to}, ${jumpOrder(context.settings)}`,
    },
  ];
}

function helpRows(
  bindings: readonly KeyBinding[],
  context: HelpContext,
): HelpRow[] {
  const groups = new Map<string, KeyBinding[]>();
  for (const binding of bindings) {
    if (binding.actions.length === 0) continue;
    const id = helpGroupId(binding);
    groups.set(id, [...(groups.get(id) ?? []), binding]);
  }
  return [...groups.values()].flatMap((group) => groupRows(group, context));
}

function afterPrefix(rows: readonly HelpRow[], context: HelpContext): HelpRow[] {
  const prefix = formatStroke(context.keymap.prefix, context.isMac);
  return rows.map((row) => ({
    keys: `${prefix} ${row.keys}`,
    description: row.description,
  }));
}

function prefixRows(context: HelpContext): HelpRow[] {
  const { keymap, isMac } = context;
  const prefix = formatStroke(keymap.prefix, isMac);
  const rows = afterPrefix(helpRows(keymap.prefixBindings, context), context);
  const repeats =
    keymap.repeatTimeMs > 0 &&
    keymap.prefixBindings.some(
      (binding) => binding.repeat && binding.actions.length > 0,
    );
  const seconds = keymap.repeatTimeMs / MS_PER_SECOND;
  const unit = seconds === 1 ? "second" : "seconds";
  return [
    ...rows,
    ...(repeats
      ? [
          {
            keys: REPEAT_MARK,
            description: `After such a key, every key with this mark works without the prefix for ${seconds} ${unit}`,
          },
        ]
      : []),
    {
      keys: `${prefix} any other key`,
      description:
        keymap.rootBindings.length > 0
          ? "Cancel the prefix, or do what the key does without the prefix"
          : "Cancel the prefix",
    },
  ];
}

// The copy binding of a prefix key runs when the key is sent on to the pane:
// after the prefix, on the key that the prefix table binds to send-prefix.
function copyRows(context: HelpContext): HelpRow[] {
  const { keymap } = context;
  return [
    ...helpRows(keymap.copyBindings, context),
    ...afterPrefix(helpRows(keymap.sentCopyBindings, context), context),
  ];
}

function chooserRows({ keymap, isMac }: HelpContext): HelpRow[] {
  const labels = (keys: readonly string[]) =>
    keys.map((key) => formatStroke(key, isMac)).join(" / ");
  const splitCommands = Object.keys(
    CHOOSER_SPLIT_DESCRIPTIONS,
  ) as (keyof ListSplitKeys)[];
  return [
    ...LIST_COMMANDS.map((command) => ({
      keys: labels(LIST_COMMAND_KEYS[command]),
      description: CHOOSER_DESCRIPTIONS[command],
    })),
    ...splitCommands.map((command) => ({
      keys: labels(keymap.listSplitKeys[command]),
      description: CHOOSER_SPLIT_DESCRIPTIONS[command],
    })),
    {
      keys: CHOOSER_FILTER_KEY,
      description: "Filter the threads by title or project",
    },
  ].filter((row) => row.keys !== "");
}

// isMac only changes how the Alt key is named: Option on a Mac keyboard. A
// key that is bound to a command bb has no equivalent for is not listed.
export function describeKeymap(
  keymap: Keymap,
  settings: Settings,
  isMac = false,
): HelpSection[] {
  const context: HelpContext = { keymap, settings, isMac };
  const sections: HelpSection[] = [
    { title: "After the prefix", rows: prefixRows(context) },
    {
      title: "Without the prefix",
      rows: helpRows(keymap.rootBindings, context),
    },
    {
      title: "Outside a text field",
      rows: helpRows(keymap.plainBindings, context),
    },
    { title: `Copy mode, ${keymap.modeKeys} keys`, rows: copyRows(context) },
    {
      title: "On a thread in the sidebar",
      rows: helpRows(keymap.sidebarBindings, context),
    },
    { title: "In the thread chooser", rows: chooserRows(context) },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

// null for a config without a second prefix, and for one that names the
// prefix itself.
function describeSecondPrefix(
  keymap: Keymap,
  { options }: TmuxConfig,
  isMac: boolean,
): string | null {
  if (keymap.prefix2 !== null) {
    return `Second prefix: ${formatStroke(keymap.prefix2, isMac)}`;
  }
  const { prefix2 } = options;
  if (prefix2 === null || prefix2.usable) return null;
  return `The second prefix ${prefix2.key} in ${prefix2.path} cannot be used in bb`;
}

// The prefix and where it comes from, then the second prefix.
export function describeKeymapPrefix(
  keymap: Keymap,
  source: TmuxSource,
  isMac = false,
): string {
  const prefix = describePrefix(resolvePrefix(prefixLookup(source)), isMac);
  const second = describeSecondPrefix(keymap, source.config, isMac);
  return second === null ? prefix : `${prefix}. ${second}`;
}

type TerminalKeyPair = readonly [stroke: string, key: string];

function chordsOf(pairs: readonly TerminalKeyPair[]): string {
  return listOf(pairs.map(([stroke]) => formatStroke(stroke)));
}

function keysOf(pairs: readonly TerminalKeyPair[]): string {
  return listOf(pairs.map(([, key]) => key));
}

// One sentence for the key help about the keys that a terminal sends as
// Escape, Enter and Tab. A thread row of the sidebar only takes the keys of
// tmux's lists, and Tab is none of them.
export function describeTerminalKeys(): string {
  const all = [...TERMINAL_KEYS];
  const onRow = all.filter(([, key]) => LIST_KEYS.has(key));
  return `As in a terminal, ${chordsOf(all)} work as ${keysOf(all)} in copy mode, in the thread chooser and here, and ${chordsOf(onRow)} as ${keysOf(onRow)} on a thread in the sidebar, unless the key itself is bound there.`;
}

// The files that were read and the pasted text, in the order they were
// applied in. A file that was chosen is marked as such, because it stands in
// the place of tmux's usual files.
function appliedSources({ files, namedFile, pastedText }: TmuxConfig): string[] {
  const read = namedFile
    ? files.map((file) => `${file} (${CHOSEN_IN_SETTINGS})`)
    : files;
  return pastedText === "applied" ? [...read, CONFIG_TEXT_NAME] : read;
}

// What could not be read, each as words that begin a sentence.
function unreadSources(config: TmuxConfig): string[] {
  const unread: string[] = [];
  if (config.unreadable && config.namedFile) unread.push(NAMED_FILE_NOT_READ);
  if (config.unreadable && !config.namedFile) {
    const which = config.files.length > 0 ? "Another" : "A";
    unread.push(`${which} tmux config is there but could not be read`);
  }
  if (config.pastedText === "unreadable") unread.push(PASTED_TEXT_NOT_READ);
  return unread;
}

function listOf(names: readonly string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Where the keys come from: every source that was applied to stock tmux, and
// every one that could not be read.
export function describeSource({ config, isFromServer }: TmuxSource): string {
  if (!isFromServer) {
    return `The tmux config could not be read, ${STOCK_KEYS_ONLY}`;
  }
  const applied = appliedSources(config);
  const unread = unreadSources(config);
  if (applied.length > 0) {
    const read = `The keys of stock tmux with ${listOf(applied)} applied to them.`;
    return [read, ...unread.map((words) => `${words}.`)].join(" ");
  }
  if (unread.length > 0) {
    return `${inOneSentence(unread, ", and ")}, ${STOCK_KEYS_ONLY}`;
  }
  return `No tmux config was found, ${STOCK_KEYS_ONLY}`;
}
