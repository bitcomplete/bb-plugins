import { isUsablePrefix, type TmuxPrefix } from "./prefix";
import {
  MAX_BINDING_ACTIONS,
  actionCount,
  actionsOfBinding,
  type CommandAction,
} from "./tmux-commands";
import { STOCK_TMUX_BINDINGS, STOCK_TMUX_OPTIONS } from "./tmux-defaults";
import {
  FORMAT_CHARACTER,
  FORMAT_OPEN,
  MAX_INT,
  MAX_KEY_LENGTH,
  cutText,
  isCommand,
  parseCommands,
  parseFlags,
  plainText,
  strokeFromTmuxKey,
  wholeNumber,
  type Argument,
  type CommandName,
  type Flags,
  type ParsedCommand,
  type Word,
} from "./tmux-syntax";
import type { TmuxAction } from "./types";

// path is the name the file is reported under.
export interface TmuxConfigFile {
  path: string;
  text: string;
}

export type TmuxModeKeys = "vi" | "emacs";

// The VISUAL and EDITOR variables of the process, undefined when not set.
export interface TmuxEditorEnvironment {
  visual: string | undefined;
  editor: string | undefined;
}

// prefix: null when no file sets it, which leaves tmux's own default.
// prefix2: null when there is none, which is tmux's default.
// prefixTimeoutMs: how long the prefix waits for the next key. 0, which is
// tmux's default, means that it waits for as long as it takes.
export interface TmuxOptions {
  prefix: TmuxPrefix | null;
  prefix2: TmuxPrefix | null;
  modeKeys: TmuxModeKeys;
  mouse: boolean;
  repeatTimeMs: number;
  prefixTimeoutMs: number;
  baseIndex: number;
}

// key is a stroke of this plugin. repeat: the key was bound with -r.
export interface TmuxKeyBinding {
  key: string;
  repeat: boolean;
  actions: TmuxAction[];
}

export interface TmuxKeyTables {
  prefix: TmuxKeyBinding[];
  root: TmuxKeyBinding[];
  copyMode: TmuxKeyBinding[];
  copyModeVi: TmuxKeyBinding[];
}

export type TmuxTableName = keyof TmuxKeyTables;

// Every key that is bound, also one whose command bb has no equivalent for,
// which has no actions.
export interface ResolvedTmuxConfig {
  options: TmuxOptions;
  tables: TmuxKeyTables;
}

// What became of the lines of the Config text setting. none: the setting
// holds no line. unreadable: the lines are over the size limit of a file.
export type PastedTextState = "none" | "applied" | "unreadable";

// What the page is told: the keys and their actions, and nothing else of the
// files and of the pasted lines. A key without actions is in it so that the
// page can tell a key that tmux has bound from one that it has not.
// files: the config files that were read, as they are shown to the user.
// unreadable: a config file is there, or one was chosen in the plugin's
// settings, but it could not be read.
// namedFile: a config file was chosen in the plugin's settings, so the
// places where tmux looks for its config were not read.
export interface TmuxConfig extends ResolvedTmuxConfig {
  files: string[];
  unreadable: boolean;
  namedFile: boolean;
  pastedText: PastedTextState;
}

// False when a config file or the pasted lines could not be read.
export function wasAllRead({ unreadable, pastedText }: TmuxConfig): boolean {
  return !unreadable && pastedText !== "unreadable";
}

// lines holds the pasted lines under the name they are reported under.
export type PastedText =
  | { state: "none" | "unreadable" }
  | { state: "applied"; lines: TmuxConfigFile };

// What the server part found of the user's tmux config. The files are applied
// in their order, and the pasted lines after them.
export interface TmuxConfigSources {
  files: readonly TmuxConfigFile[];
  unreadable: boolean;
  namedFile: boolean;
  pastedText: PastedText;
}

// isStock: the binding is one of stock tmux, which no config line has
// replaced.
interface Binding {
  key: string;
  repeat: boolean;
  actions: CommandAction[];
  isStock: boolean;
}

// isStock: the text is the bindings of stock tmux, not a file of the user.
interface ConfigText extends TmuxConfigFile {
  isStock: boolean;
}

interface State {
  options: TmuxOptions;
  tables: Record<TmuxTableName, Map<string, Binding>>;
}

// flags are the flags the command has, and a line with any other flag is an
// error in tmux.
interface SetCommand extends CommandName {
  flags: RegExp;
}

// read: what a line that sets the option to this text changes, or null for a
// value that tmux would refuse.
// toggle: what a line that names no value changes. tmux takes such a line for
// an option that is on or off, and for one with two choices.
// isServerOption: tmux keeps one value of the option for the whole server, so
// a line sets it with -g, with -s and without either.
interface OptionSpec {
  field: keyof TmuxOptions;
  read: (text: string, path: string) => Partial<TmuxOptions> | null;
  toggle?: (options: TmuxOptions) => Partial<TmuxOptions>;
  isServerOption?: boolean;
}

const SET_COMMANDS: readonly SetCommand[] = [
  {
    name: "set-option",
    alias: "set",
    shortest: "set-o",
    flags: /^[aFgopqstuUw]*$/,
  },
  {
    name: "set-window-option",
    alias: "setw",
    shortest: "set-w",
    flags: /^[aFgoqtu]*$/,
  },
];
const BIND_COMMAND: CommandName = {
  name: "bind-key",
  alias: "bind",
  shortest: "bi",
};
const UNBIND_COMMAND: CommandName = {
  name: "unbind-key",
  alias: "unbind",
  shortest: "unb",
};

const SET_VALUE_FLAGS = "t";
// What the flags do to an option that tmux keeps for every session or window.
// -g picks the global option, and without it the line is about one session or
// window. -u and -U unset the option. -o only sets an option that is not set
// yet, and a global one always is, so tmux refuses such a line. -F expands
// formats in the value. The others change nothing here: -a appends, which
// anything but a string takes as a plain set, -s, -w and -p only say which
// kind a user option (@name) is, -q hides errors and -t names a target.
const GLOBAL_FLAG = "g";
const UNSET_FLAGS = /[uU]/;
const ONLY_IF_NOT_SET_FLAG = "o";
const FORMAT_FLAG = "F";

const BIND_VALUE_FLAGS = "NT";
const BIND_FLAGS = /^[nrNT]*$/;
const UNBIND_VALUE_FLAGS = "T";
const UNBIND_FLAGS = /^[anqT]*$/;
const TABLE_FLAG = "T";
const ROOT_FLAG = "n";
const REPEAT_FLAG = "r";
const ALL_FLAG = "a";

// The key tables of tmux that count here. A key in any other table can only
// be reached through switch-client, which bb has no equivalent for.
const TABLE_NAMES: ReadonlyMap<string, TmuxTableName> = new Map([
  ["prefix", "prefix"],
  ["root", "root"],
  ["copy-mode", "copyMode"],
  ["copy-mode-vi", "copyModeVi"],
]);

const TABLE_ORDER: readonly TmuxTableName[] = [
  "prefix",
  "root",
  "copyMode",
  "copyModeVi",
];
const NO_KEY = /^none$/i;
// What tmux reads as on and as off (options_from_string_flag in options.c).
const FLAG_ON = /^(?:1|on|yes)$/i;
const FLAG_OFF = /^(?:0|off|no)$/i;
const PATH_SEPARATOR = "/";
const MAX_REPEAT_TIME = 32767;
// Stock tmux has some 250 keyboard bindings with one action each. The limit
// is on the actions of the answer only, and the stock bindings come first in
// it. The number of bound keys has no limit of its own: the size limit of a
// config text is what bounds it.
export const MAX_TOTAL_ACTIONS = 40 * MAX_BINDING_ACTIONS;

const NO_EDITOR: TmuxEditorEnvironment = { visual: undefined, editor: undefined };
const NO_SOURCES: TmuxConfigSources = {
  files: [],
  unreadable: false,
  namedFile: false,
  pastedText: { state: "none" },
};

// A prefix of None, tmux's word for no key at all, is no key either and ends
// up with the keys that cannot be used.
function keyFromValue(text: string, path: string): TmuxPrefix {
  if (text.length > MAX_KEY_LENGTH) {
    return { key: `${cutText(text, MAX_KEY_LENGTH)}...`, path, usable: false };
  }
  const stroke = strokeFromTmuxKey(text);
  if (stroke === null || !isUsablePrefix(stroke)) {
    return { key: text, path, usable: false };
  }
  return { key: stroke, path, usable: true };
}

function readRepeatTime(text: string): Partial<TmuxOptions> | null {
  const repeatTimeMs = wholeNumber(text, 0, MAX_REPEAT_TIME);
  return repeatTimeMs === null ? null : { repeatTimeMs };
}

function readPrefixTimeout(text: string): Partial<TmuxOptions> | null {
  const prefixTimeoutMs = wholeNumber(text, 0, MAX_INT);
  return prefixTimeoutMs === null ? null : { prefixTimeoutMs };
}

function readBaseIndex(text: string): Partial<TmuxOptions> | null {
  const baseIndex = wholeNumber(text, 0, MAX_INT);
  return baseIndex === null ? null : { baseIndex };
}

function readMouse(text: string): Partial<TmuxOptions> | null {
  if (FLAG_ON.test(text)) return { mouse: true };
  return FLAG_OFF.test(text) ? { mouse: false } : null;
}

// The options of tmux that count here, each with the field it is kept in.
const OPTIONS: ReadonlyMap<string, OptionSpec> = new Map<string, OptionSpec>([
  [
    "prefix",
    {
      field: "prefix",
      read: (text, path) => ({ prefix: keyFromValue(text, path) }),
    },
  ],
  [
    "prefix2",
    {
      field: "prefix2",
      read: (text, path) => ({
        prefix2: NO_KEY.test(text) ? null : keyFromValue(text, path),
      }),
    },
  ],
  [
    "mode-keys",
    {
      field: "modeKeys",
      read: (text) =>
        text === "vi" || text === "emacs" ? { modeKeys: text } : null,
      toggle: ({ modeKeys }) => ({ modeKeys: modeKeys === "vi" ? "emacs" : "vi" }),
    },
  ],
  [
    "mouse",
    {
      field: "mouse",
      read: readMouse,
      toggle: ({ mouse }) => ({ mouse: !mouse }),
    },
  ],
  ["repeat-time", { field: "repeatTimeMs", read: readRepeatTime }],
  [
    "prefix-timeout",
    {
      field: "prefixTimeoutMs",
      read: readPrefixTimeout,
      isServerOption: true,
    },
  ],
  ["base-index", { field: "baseIndex", read: readBaseIndex }],
]);

// As tmux does at its start (tmux.c): VISUAL decides when it is set, and
// EDITOR only when VISUAL is not. Only what follows the last slash of the
// value is looked at, so a folder named "services" does not count.
function modeKeysFrom({ visual, editor }: TmuxEditorEnvironment): TmuxModeKeys {
  const command = visual ?? editor;
  if (command === undefined) return STOCK_TMUX_OPTIONS.modeKeys;
  const program = command.slice(command.lastIndexOf(PATH_SEPARATOR) + 1);
  return program.includes("vi") ? "vi" : STOCK_TMUX_OPTIONS.modeKeys;
}

function initialOptions(environment: TmuxEditorEnvironment): TmuxOptions {
  return {
    prefix: null,
    prefix2: null,
    modeKeys: modeKeysFrom(environment),
    mouse: STOCK_TMUX_OPTIONS.mouse,
    repeatTimeMs: STOCK_TMUX_OPTIONS.repeatTimeMs,
    prefixTimeoutMs: STOCK_TMUX_OPTIONS.prefixTimeoutMs,
    baseIndex: STOCK_TMUX_OPTIONS.baseIndex,
  };
}

function findSetCommand(word: string): SetCommand | undefined {
  return SET_COMMANDS.find((command) => isCommand(word, command));
}

function flagLetters({ flags }: Flags): string {
  return [...flags.keys()].join("");
}

function setsGlobalOption(
  command: SetCommand,
  flags: string,
  { isServerOption = false }: OptionSpec,
): boolean {
  if (!command.flags.test(flags)) return false;
  if (flags.includes(ONLY_IF_NOT_SET_FLAG)) return false;
  return isServerOption || flags.includes(GLOBAL_FLAG);
}

function cannotBeEvaluated(value: Word, flags: string): boolean {
  if (value.isExpanded || value.text === "") return true;
  if (value.text.includes(FORMAT_OPEN)) return true;
  return flags.includes(FORMAT_FLAG) && value.text.includes(FORMAT_CHARACTER);
}

function isWord(argument: Argument): argument is Word {
  return argument.type === "word";
}

function optionChange(
  spec: OptionSpec,
  values: readonly Word[],
  flags: string,
  options: TmuxOptions,
  path: string,
): Partial<TmuxOptions> | null {
  if (values.length === 0) return spec.toggle?.(options) ?? null;
  if (values.length !== 1) return null;
  const [value] = values;
  if (cannotBeEvaluated(value, flags)) return null;
  return spec.read(value.text, path);
}

// A brace block anywhere in the line is an argument that cannot be read as a
// flag, a name or a value. defaults holds what tmux gives an option that is
// unset: its own default, whatever VISUAL and EDITOR say.
function setOption(
  state: State,
  command: SetCommand,
  args: readonly Argument[],
  defaults: TmuxOptions,
  path: string,
): void {
  if (!args.every(isWord)) return;
  const parsed = parseFlags(args, SET_VALUE_FLAGS);
  if (parsed === null) return;
  const flags = flagLetters(parsed);
  const operands = parsed.operands.filter(isWord);
  const [option, ...values] = operands;
  const spec = OPTIONS.get(option?.text ?? "");
  if (spec === undefined || !setsGlobalOption(command, flags, spec)) return;
  if (UNSET_FLAGS.test(flags)) {
    if (values.length > 1) return;
    state.options = { ...state.options, [spec.field]: defaults[spec.field] };
    return;
  }
  const change = optionChange(spec, values, flags, state.options, path);
  if (change !== null) state.options = { ...state.options, ...change };
}

// -T names the table, and without it -n picks the root table.
function tableOf({ flags }: Flags): TmuxTableName | null {
  const named = flags.get(TABLE_FLAG);
  if (named !== undefined) return TABLE_NAMES.get(plainText(named) ?? "") ?? null;
  return flags.has(ROOT_FLAG) ? "root" : "prefix";
}

// A bind-key without a command only changes the note of the key. A key that
// is bound again loses what it was bound to before, and keeps it when tmux
// refuses the command of the line.
function bindKey(state: State, args: readonly Argument[], isStock: boolean): void {
  const parsed = parseFlags(args, BIND_VALUE_FLAGS);
  if (parsed === null || !BIND_FLAGS.test(flagLetters(parsed))) return;
  const table = tableOf(parsed);
  const [key, ...command] = parsed.operands;
  const written = plainText(key);
  if (table === null || written === null || command.length === 0) return;
  const stroke = strokeFromTmuxKey(written);
  if (stroke === null) return;
  const actions = actionsOfBinding(command);
  if (actions === null) return;
  const bindings = state.tables[table];
  bindings.delete(stroke);
  bindings.set(stroke, {
    key: stroke,
    repeat: parsed.flags.has(REPEAT_FLAG),
    actions,
    isStock,
  });
}

function unbindKey(state: State, args: readonly Argument[]): void {
  const parsed = parseFlags(args, UNBIND_VALUE_FLAGS);
  if (parsed === null || !UNBIND_FLAGS.test(flagLetters(parsed))) return;
  const table = tableOf(parsed);
  if (table === null) return;
  const [key, ...others] = parsed.operands;
  if (parsed.flags.has(ALL_FLAG)) {
    if (key === undefined) state.tables[table].clear();
    return;
  }
  const written = plainText(key);
  if (written === null || others.length > 0) return;
  const stroke = strokeFromTmuxKey(written);
  if (stroke !== null) state.tables[table].delete(stroke);
}

function runCommand(
  state: State,
  [name, ...args]: ParsedCommand,
  defaults: TmuxOptions,
  { path, isStock }: ConfigText,
): void {
  if (!isWord(name)) return;
  const setCommand = findSetCommand(name.text);
  if (setCommand !== undefined) {
    setOption(state, setCommand, args, defaults, path);
    return;
  }
  if (isCommand(name.text, BIND_COMMAND)) {
    bindKey(state, args, isStock);
    return;
  }
  if (isCommand(name.text, UNBIND_COMMAND)) unbindKey(state, args);
}

// The first thread stands for the window that has the number base-index. A
// window below that number does not exist, which is an error in tmux, and an
// error ends the command sequence.
function actionsInReach(
  actions: readonly CommandAction[],
  baseIndex: number,
): readonly CommandAction[] {
  const end = actions.findIndex(
    (action) => action.type === "window.select" && action.window < baseIndex,
  );
  return end === -1 ? actions : actions.slice(0, end);
}

function countActions(actions: readonly CommandAction[]): number {
  return actions.reduce((count, action) => count + actionCount(action), 0);
}

function threadActions(action: CommandAction, baseIndex: number): TmuxAction[] {
  if (action.type === "window.select") {
    return [{ type: "thread.jump", index: action.window - baseIndex + 1 }];
  }
  if (action.type !== "repeated") return [action];
  return Array.from({ length: action.count }, () => action.action);
}

// The stock bindings get their room in the answer first, so that no config
// can take the action of a stock key away by its size. A binding of a config
// with more actions than the answer has room left for keeps its key and
// loses its actions. The actions are only counted until then, and written
// out one by one for a binding that fits.
function resolvedTables(
  tables: State["tables"],
  baseIndex: number,
): TmuxKeyTables {
  const all = TABLE_ORDER.flatMap((table) => [...tables[table].values()]);
  const stock = all.filter((binding) => binding.isStock);
  let room =
    MAX_TOTAL_ACTIONS -
    countActions(stock.flatMap(({ actions }) => actionsInReach(actions, baseIndex)));
  const bindingsOf = (table: TmuxTableName): TmuxKeyBinding[] =>
    [...tables[table].values()].map(({ key, repeat, actions, isStock }) => {
      const inReach = actionsInReach(actions, baseIndex);
      const count = countActions(inReach);
      if (!isStock && count > room) return { key, repeat, actions: [] };
      if (!isStock) room -= count;
      return {
        key,
        repeat,
        actions: inReach.flatMap((action) => threadActions(action, baseIndex)),
      };
    });
  return {
    prefix: bindingsOf("prefix"),
    root: bindingsOf("root"),
    copyMode: bindingsOf("copyMode"),
    copyModeVi: bindingsOf("copyModeVi"),
  };
}

// The keymap of stock tmux with the config files applied to it. tmux runs its
// own bindings and then the files one after another as one sequence, so the
// last command that sets an option or binds a key decides. Nothing is run and
// no other file is read.
export function resolveTmuxConfig(
  files: readonly TmuxConfigFile[],
  environment: TmuxEditorEnvironment = NO_EDITOR,
): ResolvedTmuxConfig {
  const defaults = initialOptions(NO_EDITOR);
  const state: State = {
    options: initialOptions(environment),
    tables: {
      prefix: new Map(),
      root: new Map(),
      copyMode: new Map(),
      copyModeVi: new Map(),
    },
  };
  const texts: ConfigText[] = [
    { path: "", text: STOCK_TMUX_BINDINGS, isStock: true },
    ...files.map((file) => ({ ...file, isStock: false })),
  ];
  for (const text of texts) {
    for (const command of parseCommands(text.text)) {
      runCommand(state, command, defaults, text);
    }
  }
  return {
    options: state.options,
    tables: resolvedTables(state.tables, state.options.baseIndex),
  };
}

export function tmuxConfigFrom(
  { files, unreadable, namedFile, pastedText }: TmuxConfigSources,
  environment: TmuxEditorEnvironment,
): TmuxConfig {
  const applied =
    pastedText.state === "applied" ? [...files, pastedText.lines] : files;
  return {
    ...resolveTmuxConfig(applied, environment),
    files: files.map((file) => file.path),
    unreadable,
    namedFile,
    pastedText: pastedText.state,
  };
}

// What stock tmux does when no config is known, for a page that got no answer
// from the server.
export function stockTmuxConfig(): TmuxConfig {
  return tmuxConfigFrom(NO_SOURCES, NO_EDITOR);
}
