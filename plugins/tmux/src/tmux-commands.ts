import {
  FORMAT_CHARACTER,
  MAX_INT,
  cutText,
  isCommand,
  parseCommands,
  parseFlags,
  plainText,
  wholeNumber,
  type Argument,
  type CommandName,
  type Flags,
  type ParsedCommand,
} from "./tmux-syntax";
import type { CopyMotion, Direction, TmuxAction } from "./types";

// window.select names a window by its number in tmux. Which thread that is
// depends on base-index, and a later line of the config may still change it.
// repeated is an action that send-keys -N makes count times. It stays one
// entry until the answer for the page is built, so that a key costs the same
// to keep with -N and without.
export type CommandAction =
  | TmuxAction
  | { type: "window.select"; window: number }
  | { type: "repeated"; action: TmuxAction; count: number };

// min and max: how many arguments tmux lets a command take behind its flags.
interface OperandCount {
  min: number;
  max: number;
}

// valueFlags: the flags of the command that take a value, from the manual of
// tmux 3.5a. Three are not in it and are taken by tmux all the same (the
// entry of the command in its cmd-*.c file): the -p of split-window, which
// older configs give a size with, the -P of select-pane and the -F of
// display-message. Every other flag is taken for one without a value.
// operands is from that entry as well.
interface CommandSpec extends CommandName {
  valueFlags: string;
  operands: OperandCount;
  actions: (flags: Flags) => CommandAction[];
}

// isComplete: every command of the sequence has an equivalent. The actions
// of one that has not end in front of its first command without equivalent.
// isRefused: tmux does not take one of the commands as it is written, so it
// refuses the bind-key that holds the sequence and the key stays as it was
// (cmd_bind_key_exec in cmd-bind-key.c).
interface Sequence {
  actions: CommandAction[];
  isComplete: boolean;
  isRefused: boolean;
}

const MAX_UNSIGNED_INT = 4294967295;
const MAX_NOTICE_LENGTH = 200;
// A "%" at the end of a text or in front of a blank is not counted: what
// strftime makes of it differs from system to system.
const TIME_CONVERSION = /%\S/;
// confirm-before holds a command, which may be another confirm-before.
const MAX_NESTING = 4;
// No binding of a real config comes near this. Without a limit, a config of
// send-keys -N lines would make an answer some hundred times its own size.
export const MAX_BINDING_ACTIONS = 500;

// The command-alias option of tmux 3.5a as it starts (options-table.c): each
// name with the words that tmux puts in its place. Its entries for
// show-messages are left out, a command bb has no equivalent for.
const STOCK_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["split-pane", ["split-window"]],
  ["splitp", ["split-window"]],
  ["choose-window", ["choose-tree", "-w"]],
  ["choose-session", ["choose-tree", "-s"]],
]);

// The names that tmux puts a character in the place of, in a target of a
// window and of a pane alike (the tables at the top of cmd-find.c). A name
// only counts when it is the whole window part or the whole pane part of the
// target (cmd_find_map_table compares all of it): tmux finds no pane for
// '{next}1'. Its names for the first and the last window, which only a
// window has, are below.
const TARGET_NAMES: ReadonlyMap<string, string> = new Map([
  ["{next}", "+"],
  ["{previous}", "-"],
  ["{last}", "!"],
]);
const RELATIVE_PANE = /^(?::\.|\.)?([+-])1?$/;
const LAST_PANE = /^(?::\.|\.)?!$/;
const PANE_PREFIX = /^(?::\.|\.)/;
const WINDOW_PREFIX = /^:/;
// The names of tmux for the pane on one side of the active pane
// (cmd_find_get_pane_with_window in cmd-find.c).
const NEIGHBOUR_PANES: readonly (readonly [string, Direction])[] = [
  ["{left-of}", "left"],
  ["{right-of}", "right"],
  ["{up-of}", "up"],
  ["{down-of}", "down"],
];
const RELATIVE_WINDOW = /^:?([+-])1?$/;
const LAST_WINDOW = /^:?!$/;
const START_WINDOW = /^:?(?:\^|\{start\})$/;
// A target that is nothing but "$" names a session to tmux, by an id that no
// session has (cmd_find_target in cmd-find.c).
const END_WINDOW = /^(?::\$|:?\{end\})$/;
const WINDOW_NUMBER = /^:?=?([0-9]+)$/;

const DIRECTION_FLAGS: readonly (readonly [string, Direction])[] = [
  ["L", "left"],
  ["R", "right"],
  ["U", "up"],
  ["D", "down"],
];

const COPY_MOTIONS: readonly (readonly [string, CopyMotion])[] = [
  ["cursor-left", "char-left"],
  ["cursor-right", "char-right"],
  ["cursor-up", "line-up"],
  ["cursor-down", "line-down"],
  ["next-word", "word-forward"],
  ["previous-word", "word-back"],
  ["next-word-end", "word-end"],
  ["start-of-line", "line-start"],
  ["back-to-indentation", "line-indent"],
  ["end-of-line", "line-end"],
  ["previous-paragraph", "paragraph-back"],
  ["next-paragraph", "paragraph-forward"],
  ["history-top", "document-start"],
  ["history-bottom", "document-end"],
  ["top-line", "screen-top"],
  ["middle-line", "screen-middle"],
  ["bottom-line", "screen-bottom"],
  ["halfpage-up", "half-page-up"],
  ["halfpage-down", "half-page-down"],
  ["page-up", "page-up"],
  ["page-down", "page-down"],
];

// The commands of copy mode, which send-keys -X names. The shell command that
// a copy-pipe command is given is not read at all.
const COPY_COMMANDS: ReadonlyMap<string, TmuxAction> = new Map<
  string,
  TmuxAction
>([
  ...COPY_MOTIONS.map(([name, motion]): [string, TmuxAction] => [
    name,
    { type: "copy.move", motion },
  ]),
  ["scroll-up", { type: "copy.scroll", direction: -1 }],
  ["scroll-down", { type: "copy.scroll", direction: 1 }],
  ["begin-selection", { type: "copy.beginSelection" }],
  ["clear-selection", { type: "copy.clearSelection" }],
  ["cancel", { type: "copy.exit" }],
  ["copy-selection", { type: "copy.yank", after: "clear" }],
  ["copy-pipe", { type: "copy.yank", after: "clear" }],
  ["copy-selection-no-clear", { type: "copy.yank", after: "keep" }],
  ["copy-pipe-no-clear", { type: "copy.yank", after: "keep" }],
  ["copy-selection-and-cancel", { type: "copy.yank", after: "exit" }],
  ["copy-pipe-and-cancel", { type: "copy.yank", after: "exit" }],
]);

function hasAny({ flags }: Flags, letters: string): boolean {
  return [...letters].some((letter) => flags.has(letter));
}

function directionOf({ flags }: Flags): Direction | null {
  return DIRECTION_FLAGS.find(([flag]) => flags.has(flag))?.[1] ?? null;
}

// The target with the character of tmux in the place of a name. prefix is
// what may stand in front of the part that names the pane or the window.
function targetOf(
  argument: Argument | null | undefined,
  prefix: RegExp,
): string | null {
  const text = plainText(argument);
  if (text === null) return null;
  const lead = prefix.exec(text)?.[0] ?? "";
  const part = text.slice(lead.length);
  return lead + (TARGET_NAMES.get(part) ?? part);
}

function neighbourOf(pane: string): Direction | null {
  const name = pane.replace(PANE_PREFIX, "");
  return NEIGHBOUR_PANES.find(([target]) => target === name)?.[1] ?? null;
}

// -d and -e only switch the input of the last pane off and on, and the focus
// stays where it is (cmd_select_pane_exec in cmd-select-pane.c).
function lastPane(flags: Flags): CommandAction[] {
  if (flags.operands.length > 0 || hasAny(flags, "de")) return [];
  return [{ type: "pane.last" }];
}

// -P gives the pane a style, which bb has nothing for.
function selectPane(flags: Flags): CommandAction[] {
  if (flags.operands.length > 0 || hasAny(flags, "deMmPT")) return [];
  const direction = directionOf(flags);
  const isLast = flags.flags.has("l");
  const target = flags.flags.get("t");
  if (target === undefined) {
    if (isLast) return [{ type: "pane.last" }];
    return direction === null ? [] : [{ type: "pane.focus", direction }];
  }
  if (isLast || direction !== null) return [];
  const pane = targetOf(target, PANE_PREFIX) ?? "";
  if (LAST_PANE.test(pane)) return [{ type: "pane.last" }];
  const neighbour = neighbourOf(pane);
  if (neighbour !== null) {
    return [{ type: "pane.neighbour", direction: neighbour }];
  }
  const step = RELATIVE_PANE.exec(pane)?.[1];
  if (step === "+") return [{ type: "pane.next" }];
  return step === "-" ? [{ type: "pane.previous" }] : [];
}

// A shell command asks for a pane that runs that program, which is not what
// the thread chooser offers.
function splitWindow(flags: Flags): CommandAction[] {
  if (flags.operands.length > 0) return [];
  const placement = flags.flags.has("h") ? "right" : "down";
  return [{ type: "chooser.open", placement }];
}

function killPane(flags: Flags): CommandAction[] {
  if (flags.operands.length > 0 || hasAny(flags, "at")) return [];
  return [{ type: "pane.close" }];
}

function resizePane(flags: Flags): CommandAction[] {
  if (hasAny(flags, "MTtxy")) return [];
  if (flags.flags.has("Z")) return [{ type: "pane.zoom" }];
  const direction = directionOf(flags);
  const [adjustment, ...others] = flags.operands;
  if (direction === null || others.length > 0) return [];
  const cells =
    adjustment === undefined ? 1 : wholeNumber(plainText(adjustment), 1, MAX_INT);
  return cells === null ? [] : [{ type: "pane.resize", direction, cells }];
}

// -u and -d together scroll one page up and one page down again.
function copyModeMotion({ flags }: Flags): CopyMotion | null {
  if (flags.has("u") === flags.has("d")) return null;
  return flags.has("u") ? "page-up" : "page-down";
}

// As in tmux, -q comes first: it ends copy mode and nothing else is done.
function copyMode(flags: Flags): CommandAction[] {
  if (flags.operands.length > 0 || flags.flags.has("t")) return [];
  if (flags.flags.has("q")) return [{ type: "copy.exit" }];
  if (hasAny(flags, "Ms")) return [];
  return [{ type: "copy.enter", motion: copyModeMotion(flags) }];
}

function newWindow(flags: Flags): CommandAction[] {
  return flags.operands.length > 0 ? [] : [{ type: "thread.new" }];
}

function cycleWindow(delta: 1 | -1): (flags: Flags) => CommandAction[] {
  return (flags) => {
    if (flags.operands.length > 0 || flags.flags.has("a")) return [];
    return [{ type: "thread.cycle", delta }];
  };
}

function lastWindow(flags: Flags): CommandAction[] {
  return flags.operands.length > 0 ? [] : [{ type: "thread.last" }];
}

function selectWindow(flags: Flags): CommandAction[] {
  if (flags.operands.length > 0) return [];
  if (flags.flags.has("l")) return [{ type: "thread.last" }];
  if (flags.flags.has("n")) return [{ type: "thread.cycle", delta: 1 }];
  if (flags.flags.has("p")) return [{ type: "thread.cycle", delta: -1 }];
  const target = targetOf(flags.flags.get("t"), WINDOW_PREFIX);
  if (target === null) return [];
  if (LAST_WINDOW.test(target)) return [{ type: "thread.last" }];
  if (START_WINDOW.test(target)) return [{ type: "thread.jump", index: 1 }];
  if (END_WINDOW.test(target)) return [{ type: "thread.end" }];
  const step = RELATIVE_WINDOW.exec(target)?.[1];
  if (step !== undefined) {
    return [{ type: "thread.cycle", delta: step === "+" ? 1 : -1 }];
  }
  const number = WINDOW_NUMBER.exec(target)?.[1] ?? null;
  const window = wholeNumber(number, 0, MAX_INT);
  return window === null ? [] : [{ type: "window.select", window }];
}

// A template makes the list run that command on the chosen item, which is not
// opening it.
function chooseTree(flags: Flags): CommandAction[] {
  if (flags.operands.length > 0) return [];
  return [{ type: "chooser.open", placement: "replace" }];
}

function sendPrefix(flags: Flags): CommandAction[] {
  return [{ type: "prefix.send", second: flags.flags.has("2") }];
}

// The path is not read: the files that are read again are the ones tmux
// loads at its start. -n only checks the file.
function sourceFile(flags: Flags): CommandAction[] {
  if (flags.operands.length === 0 || flags.flags.has("n")) return [];
  return [{ type: "config.reload" }];
}

// tmux puts values into a message wherever it holds a format, and every
// format starts with "#". It also hands the message to strftime, which puts
// a date or a time in the place of a "%" and the character behind it
// (format_expand_time in cmd_display_message_exec of cmd-display-message.c).
// The message is the argument, or the value of -F where there is none. With
// both, tmux binds the key and shows an error when it is pressed.
function displayMessage(flags: Flags): CommandAction[] {
  const [message, ...others] = flags.operands;
  const format = flags.flags.get("F");
  if (others.length > 0 || hasAny(flags, "aIv")) return [];
  if (message !== undefined && format !== undefined) return [];
  const text = plainText(message ?? format);
  if (text === null || text.trim() === "") return [];
  if (text.includes(FORMAT_CHARACTER) || TIME_CONVERSION.test(text)) return [];
  return [{ type: "notice.show", text: cutText(text, MAX_NOTICE_LENGTH) }];
}

// How many arguments tmux lets the copy command take after its name (the
// maxargs of window_copy_cmd_table in window-copy.c). With more, tmux runs
// nothing.
function maxCopyArguments(name: string): number {
  if (name.startsWith("copy-pipe")) return 2;
  return name.startsWith("copy-selection") ? 1 : 0;
}

// tmux takes any repeat count. One past the limit of a binding is enough to
// say that the binding is over it, and keeps a huge count cheap.
function sendKeys(flags: Flags): CommandAction[] {
  if (!flags.flags.has("X")) return [];
  const [command, ...others] = flags.operands;
  const name = plainText(command) ?? "";
  const action = COPY_COMMANDS.get(name);
  if (action === undefined || others.length > maxCopyArguments(name)) return [];
  const repeat = flags.flags.get("N");
  const count =
    repeat === undefined ? 1 : wholeNumber(plainText(repeat), 1, MAX_UNSIGNED_INT);
  if (count === null) return [];
  if (count === 1) return [action];
  return [
    { type: "repeated", action, count: Math.min(count, MAX_BINDING_ACTIONS + 1) },
  ];
}

// A command that is given as one argument is a brace block, or a string that
// tmux parses once more.
function commandsOfArgument(argument: Argument): ParsedCommand[] {
  return argument.type === "block"
    ? argument.commands
    : parseCommands(argument.text);
}

// No question is asked: the commands that wait behind it run at once, in
// front of what follows the confirm-before in its own sequence, as in tmux
// (cmdq_insert_after in cmd-confirm-before.c). tmux only reads a command
// that is given as a string when the key is pressed, so one that it refuses
// there ends the sequence and leaves the binding in place.
function confirmBefore(args: readonly Argument[], depth: number): Sequence {
  const flags = parseFlags(args, CONFIRM_BEFORE_VALUE_FLAGS);
  if (flags === null || flags.operands.length !== 1) return REFUSED;
  if (depth >= MAX_NESTING) return NO_EQUIVALENT;
  const [command] = flags.operands;
  const sequence = sequenceOfCommands(commandsOfArgument(command), depth + 1);
  return command.type === "block" ? sequence : { ...sequence, isRefused: false };
}

const NO_OPERAND: OperandCount = { min: 0, max: 0 };
const ONE_OPERAND_AT_MOST: OperandCount = { min: 0, max: 1 };
const ANY_OPERANDS: OperandCount = { min: 0, max: Infinity };
const ONE_OPERAND_AT_LEAST: OperandCount = { min: 1, max: Infinity };

const COMMANDS: readonly CommandSpec[] = [
  {
    name: "select-pane",
    alias: "selectp",
    shortest: "select-p",
    valueFlags: "PTt",
    operands: NO_OPERAND,
    actions: selectPane,
  },
  {
    name: "last-pane",
    alias: "lastp",
    shortest: "last-p",
    valueFlags: "t",
    operands: NO_OPERAND,
    actions: lastPane,
  },
  {
    name: "split-window",
    alias: "splitw",
    shortest: "sp",
    valueFlags: "ceFlpt",
    operands: ANY_OPERANDS,
    actions: splitWindow,
  },
  {
    name: "kill-pane",
    alias: "killp",
    shortest: "kill-p",
    valueFlags: "t",
    operands: NO_OPERAND,
    actions: killPane,
  },
  {
    name: "resize-pane",
    alias: "resizep",
    shortest: "resize-p",
    valueFlags: "txy",
    operands: ONE_OPERAND_AT_MOST,
    actions: resizePane,
  },
  {
    name: "copy-mode",
    shortest: "cop",
    valueFlags: "st",
    operands: NO_OPERAND,
    actions: copyMode,
  },
  {
    name: "new-window",
    alias: "neww",
    shortest: "new-w",
    valueFlags: "ceFnt",
    operands: ANY_OPERANDS,
    actions: newWindow,
  },
  {
    name: "next-window",
    alias: "next",
    shortest: "next-w",
    valueFlags: "t",
    operands: NO_OPERAND,
    actions: cycleWindow(1),
  },
  {
    name: "previous-window",
    alias: "prev",
    shortest: "previous-w",
    valueFlags: "t",
    operands: NO_OPERAND,
    actions: cycleWindow(-1),
  },
  {
    name: "last-window",
    alias: "last",
    shortest: "last-w",
    valueFlags: "t",
    operands: NO_OPERAND,
    actions: lastWindow,
  },
  {
    name: "select-window",
    alias: "selectw",
    shortest: "select-w",
    valueFlags: "t",
    operands: NO_OPERAND,
    actions: selectWindow,
  },
  {
    name: "choose-tree",
    shortest: "choose-t",
    valueFlags: "FfKOt",
    operands: ONE_OPERAND_AT_MOST,
    actions: chooseTree,
  },
  {
    name: "list-keys",
    alias: "lsk",
    shortest: "list-k",
    valueFlags: "PT",
    operands: ONE_OPERAND_AT_MOST,
    actions: () => [{ type: "help.open" }],
  },
  {
    name: "send-prefix",
    shortest: "send-p",
    valueFlags: "t",
    operands: NO_OPERAND,
    actions: sendPrefix,
  },
  {
    name: "source-file",
    alias: "source",
    shortest: "so",
    valueFlags: "t",
    operands: ONE_OPERAND_AT_LEAST,
    actions: sourceFile,
  },
  {
    name: "display-message",
    alias: "display",
    shortest: "display-mes",
    valueFlags: "cdFt",
    operands: ONE_OPERAND_AT_MOST,
    actions: displayMessage,
  },
  {
    name: "send-keys",
    alias: "send",
    shortest: "send-k",
    valueFlags: "cNt",
    operands: ANY_OPERANDS,
    actions: sendKeys,
  },
];

const CONFIRM_BEFORE: CommandName = {
  name: "confirm-before",
  alias: "confirm",
  shortest: "con",
};
const CONFIRM_BEFORE_VALUE_FLAGS = "cpt";
const NO_EQUIVALENT: Sequence = { actions: [], isComplete: false, isRefused: false };
const REFUSED: Sequence = { actions: [], isComplete: false, isRefused: true };

function plainWord(text: string): Argument {
  return { type: "word", text, isExpanded: false };
}

// As tmux does when it parses a command: a first word that is the name of an
// alias gives way to the words of that alias.
function withoutAlias(command: ParsedCommand): ParsedCommand {
  const [name, ...args] = command;
  const words = STOCK_ALIASES.get(plainText(name) ?? "");
  return words === undefined ? command : [...words.map(plainWord), ...args];
}

function takesOperands({ operands }: CommandSpec, flags: Flags): boolean {
  const count = flags.operands.length;
  return count >= operands.min && count <= operands.max;
}

// What bb can do for one tmux command: nothing for a command that is not in
// the list above. A command of the list is refused, as tmux refuses it
// (args_parse in arguments.c), with a flag that is no letter or digit or
// that lacks its value, and with more or fewer arguments than it takes. A
// flag that the command does not have in tmux is taken for one without a
// value.
function sequenceOfCommand(command: ParsedCommand, depth: number): Sequence {
  const [name, ...args] = withoutAlias(command);
  const word = plainText(name);
  if (word === null) return NO_EQUIVALENT;
  if (isCommand(word, CONFIRM_BEFORE)) return confirmBefore(args, depth);
  const spec = COMMANDS.find((candidate) => isCommand(word, candidate));
  if (spec === undefined) return NO_EQUIVALENT;
  const flags = parseFlags(args, spec.valueFlags);
  if (flags === null || !takesOperands(spec, flags)) return REFUSED;
  const actions = spec.actions(flags);
  return { actions, isComplete: actions.length > 0, isRefused: false };
}

// How many actions the page gets for the action.
export function actionCount(action: CommandAction): number {
  return action.type === "repeated" ? action.count : 1;
}

// The actions of a command sequence, in its order. It ends in front of the
// first command that bb has no equivalent for: what tmux does with that
// command is not known here, and the commands after it may count on it, as
// the kill-pane does in "select-pane -t 2 ; kill-pane". A sequence with more
// actions than MAX_BINDING_ACTIONS has none. tmux reads every command of a
// sequence before it binds the key, so one that it refuses anywhere in the
// sequence, also behind that end, refuses the whole of it.
function sequenceOfCommands(
  commands: readonly ParsedCommand[],
  depth: number,
): Sequence {
  const sequences = commands.map((command) => sequenceOfCommand(command, depth));
  if (sequences.some(({ isRefused }) => isRefused)) return REFUSED;
  const actions: CommandAction[] = [];
  let count = 0;
  for (const added of sequences) {
    actions.push(...added.actions);
    count += added.actions.reduce((sum, action) => sum + actionCount(action), 0);
    if (count > MAX_BINDING_ACTIONS) return NO_EQUIVALENT;
    if (!added.isComplete) return { actions, isComplete: false, isRefused: false };
  }
  return { actions, isComplete: true, isRefused: false };
}

// The commands in the arguments of a bind-key. A word that ends in a
// semicolon ends a command, unless a backslash stands in front of the
// semicolon, which then is part of the word.
function commandsAtSemicolons(args: readonly Argument[]): ParsedCommand[] {
  const commands: Argument[][] = [[]];
  for (const argument of args) {
    const command = commands[commands.length - 1];
    if (argument.type !== "word" || !argument.text.endsWith(";")) {
      command.push(argument);
      continue;
    }
    const text = argument.text.slice(0, -1);
    if (text.endsWith("\\")) {
      command.push({ ...argument, text: `${text.slice(0, -1)};` });
      continue;
    }
    if (text !== "") command.push({ ...argument, text });
    commands.push([]);
  }
  return commands.filter((command) => command.length > 0);
}

// The actions of the commands that a key is bound to, in their order, up to
// the first command that bb has no equivalent for. null for commands that
// tmux refuses to bind a key to.
export function actionsOfBinding(
  args: readonly Argument[],
): CommandAction[] | null {
  const commands =
    args.length === 1 ? commandsOfArgument(args[0]) : commandsAtSemicolons(args);
  const sequence = sequenceOfCommands(commands, 0);
  return sequence.isRefused ? null : [...sequence.actions];
}
