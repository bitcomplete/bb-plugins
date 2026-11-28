import {
  isSingleCharacter,
  isUpperCaseLetter,
  strokeFromNamedKey,
} from "./keys";

// isExpanded: tmux would put the value of an environment variable or a home
// directory into the word, which cannot be known here. The same goes for a
// word with octal escapes whose bytes are no UTF-8 text.
export interface Word {
  type: "word";
  text: string;
  isExpanded: boolean;
}

// The commands between a pair of braces, which tmux hands to a command as one
// argument.
export interface Block {
  type: "block";
  commands: ParsedCommand[];
}

export type Argument = Word | Block;

export type ParsedCommand = readonly Argument[];

// flags holds the value of a flag that takes one, and null for any other.
export interface Flags {
  flags: ReadonlyMap<string, Argument | null>;
  operands: readonly Argument[];
}

// shortest is the shortest form of the name that no other tmux command starts
// with (worked out from the commands in the manual of tmux 3.5a).
export interface CommandName {
  name: string;
  alias?: string;
  shortest: string;
}

// unreadable: a word with an escape or a ${...} that tmux refuses, and a word
// whose quote has no partner. tmux takes the rest of the text into such a
// word. Here its command is dropped, so that no text of a file ends up in a
// message.
// assignment: a word that tmux's lexer takes for NAME=value.
type Token =
  | Word
  | { type: "assignment"; word: Word }
  | { type: "condition"; name: string }
  | { type: "unreadable" }
  | { type: "open" }
  | { type: "close" }
  | { type: "end" };

interface WordRead {
  word: Word;
  end: number;
  isReadable: boolean;
  isAssignment: boolean;
}

// byte: an octal escape from \200 on, which is one byte of a UTF-8 character.
interface Escape {
  text: string;
  length: number;
  byte?: number;
}

// quote is the quote that the word is inside of, and lastQuote is what quote
// was when the last character was added: undefined before the first one.
// expandedFrom is how much of the text stood when the first thing was read
// that tmux would change in a way that cannot be known here.
interface WordState {
  text: string;
  bytes: number[];
  quote: string | null;
  lastQuote: string | null | undefined;
  openBraces: number;
  expandedFrom: number | null;
  isReadable: boolean;
}

// isPlain: no %if, %elif, %else or %endif, no brace without a partner and no
// word that tmux refuses is part of the command that is being read.
// hasAssignment: a NAME=value stands in front of the command.
interface Frame {
  commands: ParsedCommand[];
  args: Argument[];
  isPlain: boolean;
  hasAssignment: boolean;
}

const FLAGS_END = "--";
const FLAG_LETTER = /^[A-Za-z0-9]$/;
const WHOLE_NUMBER = /^[0-9]+$/;

const CONDITION_OPEN = "%if";
const CONDITION_CLOSE = "%endif";
const CONDITION_WORDS: ReadonlySet<string> = new Set([
  CONDITION_OPEN,
  "%elif",
  "%else",
  CONDITION_CLOSE,
]);

// Every format of tmux starts with "#", and "#{" opens one that names a value.
export const FORMAT_CHARACTER = "#";
export const FORMAT_OPEN = "#{";
// The largest number that tmux takes where it reads an int.
export const MAX_INT = 2147483647;
const QUOTED_FORMAT_FOLLOWERS = ",#{}:";
const WORD_ENDS: ReadonlySet<string> = new Set([" ", "\t", "\n", ";", "}"]);
const VARIABLE_NAME_START = /^[A-Za-z_]$/;
const VARIABLE_NAME_CHARACTER = /^[A-Za-z0-9_]$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ASSIGNMENT_SIGN = "=";
const WINDOWS_LINE_END = "\r\n";
const OCTAL_DIGIT = /^[0-7]$/;
const OCTAL_ESCAPE = /^[0-3][0-7]{2}/;
const UNICODE_ESCAPE = /^(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/;
const UNICODE_ESCAPE_LETTERS = "uU";
const MAX_CODE_POINT = 0x10ffff;
const FIRST_SURROGATE = 0xd800;
const LAST_SURROGATE = 0xdfff;
const FIRST_UTF8_BYTE = 0x80;
const HIGH_SURROGATE_END = /[\ud800-\udbff]$/;
const FIRST_KEY_CODE = 0x20;
const ESCAPED_CHARACTERS: ReadonlyMap<string, string> = new Map([
  ["a", "\u0007"],
  ["b", "\b"],
  ["e", "\u001b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["s", " "],
  ["t", "\t"],
  ["v", "\v"],
]);

const TMUX_MODIFIERS: ReadonlyMap<string, string> = new Map([
  ["c", "ctrl"],
  ["m", "alt"],
  ["s", "shift"],
]);
// tmux's names for special keys, in lower case, each with the name that a
// stroke of this plugin has for the same key.
const TMUX_KEY_NAMES: ReadonlyMap<string, string> = new Map([
  ["up", "ArrowUp"],
  ["down", "ArrowDown"],
  ["left", "ArrowLeft"],
  ["right", "ArrowRight"],
  ["bspace", "Backspace"],
  ["dc", "Delete"],
  ["delete", "Delete"],
  ["ic", "Insert"],
  ["insert", "Insert"],
  ["home", "Home"],
  ["end", "End"],
  ["npage", "PageDown"],
  ["pagedown", "PageDown"],
  ["pgdn", "PageDown"],
  ["ppage", "PageUp"],
  ["pageup", "PageUp"],
  ["pgup", "PageUp"],
  ["enter", "Enter"],
  ["escape", "Escape"],
  ["space", "Space"],
  ["tab", "Tab"],
]);
const TMUX_BACK_TAB = "btab";
const TMUX_NUL_KEY = "@";
const TMUX_FUNCTION_KEY = /^f([1-9]|1[0-2])$/;
// No key of tmux is written with more characters than this.
export const MAX_KEY_LENGTH = 32;

function backslashesBefore(text: string, end: number): number {
  let count = 0;
  while (end > count && text[end - count - 1] === "\\") count += 1;
  return count;
}

// tmux reads "\r\n" as the end of a line. Behind a backslash that is not
// itself escaped it does not: the backslash then escapes the "\r", and the
// "\n" alone ends the line (yylex_getc and yylex_token in cmd-parse.y).
function withUnixLineEnds(text: string): string {
  let folded = "";
  let from = 0;
  let end = text.indexOf(WINDOWS_LINE_END);
  while (end !== -1) {
    const isEscaped = backslashesBefore(text, end) % 2 === 1;
    folded += text.slice(from, isEscaped ? end + 1 : end);
    from = end + 1;
    end = text.indexOf(WINDOWS_LINE_END, end + WINDOWS_LINE_END.length);
  }
  return folded + text.slice(from);
}

// A backslash at the end of a line joins it with the next one, unless that
// backslash is itself escaped by the one before it. A file is read in one
// pass, however long its runs of backslashes are.
function joinContinuedLines(text: string): string {
  let joined = "";
  let from = 0;
  let end = text.indexOf("\n");
  while (end !== -1) {
    if (backslashesBefore(text, end) % 2 === 1) {
      joined += text.slice(from, end - 1);
      from = end + 1;
    }
    end = text.indexOf("\n", end + 1);
  }
  return withUnixLineEnds(joined + text.slice(from));
}

function lineEnd(source: string, from: number): number {
  const end = source.indexOf("\n", from);
  return end === -1 ? source.length : end;
}

// The format that tmux reads after %if and %elif. It runs to the "}" that
// closes it, or else to the end of its line. Only "#{" opens another level.
function formatEnd(source: string, from: number): number {
  let depth = 0;
  let at = from;
  while (at < source.length && source[at] !== "\n") {
    if (source.startsWith(FORMAT_OPEN, at)) {
      depth += 1;
      at += FORMAT_OPEN.length;
      continue;
    }
    at += 1;
    if (source[at - 1] !== "}") continue;
    depth -= 1;
    if (depth === 0) return at;
  }
  return at;
}

function isCharacterCode(code: number): boolean {
  if (code > MAX_CODE_POINT) return false;
  return code < FIRST_SURROGATE || code > LAST_SURROGATE;
}

// tmux adds an octal escape to the word as one byte, so those from \200 on
// are the bytes of a UTF-8 character.
function octalEscape(digits: string): Escape {
  const code = parseInt(digits, 8);
  if (code >= FIRST_UTF8_BYTE) return { text: "", length: 3, byte: code };
  return { text: String.fromCharCode(code), length: 3 };
}

// What stands for the characters after a backslash, and how many of them it
// takes up. null for an escape that tmux refuses (yylex_token_escape in
// cmd-parse.y): an octal one that is not three digits from \000 to \377, a
// \u or \U without its four or eight hex digits or with a number that is no
// character, and a backslash that the text ends with.
function readEscape(source: string, from: number): Escape | null {
  const next = source[from];
  if (next === undefined) return null;
  const named = ESCAPED_CHARACTERS.get(next);
  if (named !== undefined) return { text: named, length: 1 };
  const octal = OCTAL_ESCAPE.exec(source.slice(from, from + 3));
  if (octal !== null) return octalEscape(octal[0]);
  if (OCTAL_DIGIT.test(next)) return null;
  if (!UNICODE_ESCAPE_LETTERS.includes(next)) return { text: next, length: 1 };
  const unicode = UNICODE_ESCAPE.exec(source.slice(from, from + 9));
  if (unicode === null) return null;
  const code = parseInt(unicode[1] ?? unicode[2], 16);
  if (!isCharacterCode(code)) return null;
  return { text: String.fromCodePoint(code), length: unicode[0].length };
}

// Where a line inside quotes goes on. tmux drops the blanks that such a line
// starts with, and the whole line when it is a comment. A "#" in front of one
// of , # { } : belongs to a format there and starts no comment.
function quotedLineStart(source: string, from: number): number {
  let at = from;
  while (source[at] === " " || source[at] === "\t") at += 1;
  if (source[at] !== "#") return at;
  const next = source[at + 1];
  const isFormat = next !== undefined && QUOTED_FORMAT_FOLLOWERS.includes(next);
  return isFormat ? at : lineEnd(source, at);
}

function markExpanded(state: WordState): void {
  state.expandedFrom ??= state.text.length;
}

// The bytes that octal escapes gave the word, read as the UTF-8 text they
// are. Bytes that are no such text leave a word that cannot be known here.
function flushBytes(state: WordState): void {
  if (state.bytes.length === 0) return;
  const bytes = Uint8Array.from(state.bytes);
  state.bytes = [];
  try {
    state.text += new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    markExpanded(state);
  }
}

function addText(state: WordState, text: string): void {
  flushBytes(state);
  state.text += text;
  state.lastQuote = state.quote;
}

function addEscape(state: WordState, escape: Escape | null): void {
  if (escape === null) {
    state.isReadable = false;
    return;
  }
  if (escape.byte === undefined) {
    addText(state, escape.text);
    return;
  }
  state.bytes.push(escape.byte);
  state.lastQuote = state.quote;
}

// Where the name of a variable in braces ends, from the "{" at start on: at
// its "}", or at the first character that a name cannot hold.
function bracedNameEnd(source: string, start: number): number {
  let at = start + 1;
  while (at < source.length && VARIABLE_NAME_CHARACTER.test(source[at])) at += 1;
  return at;
}

// A "$" outside single quotes: tmux puts the value of the variable that is
// named behind it in its place, with braces around the name or without. It
// refuses a "$" that the text ends with, and braces that hold anything but a
// name or that are not closed (yylex_token_variable in cmd-parse.y). The
// return value is where the word goes on.
function readVariable(state: WordState, source: string, at: number): number {
  const next = source[at + 1] ?? "";
  flushBytes(state);
  if (next === "") state.isReadable = false;
  if (next !== "{") {
    if (VARIABLE_NAME_START.test(next)) markExpanded(state);
    addText(state, "$");
    return at + 1;
  }
  const end = bracedNameEnd(source, at + 1);
  markExpanded(state);
  if (source[end] === "}") {
    addText(state, source.slice(at, end + 1));
    return end + 1;
  }
  state.isReadable = false;
  if (state.quote === null) state.openBraces += 1;
  addText(state, source.slice(at, end));
  return end;
}

// The "}" of braces that tmux refuses after a "$" is taken into the word, so
// that it does not close a block of commands.
function closesRefusedBraces(state: WordState, character: string): boolean {
  return character === "}" && state.quote === null && state.openBraces > 0;
}

// Inside such braces a blank or a semicolon does not end the word either:
// the word goes on to the "}" of the braces, or to the end of the line.
function endsWord(state: WordState, character: string): boolean {
  if (state.quote !== null || !WORD_ENDS.has(character)) return false;
  return state.openBraces === 0 || character === "\n";
}

// tmux takes a word for NAME=value by what stands in front of its first "="
// after it has put in the variables (yylex in cmd-parse.y). So the word is
// one when that part is a name and holds nothing that tmux would change.
function readsAsAssignment(state: WordState): boolean {
  if (!ASSIGNMENT.test(state.text)) return false;
  const nameEnd = state.text.indexOf(ASSIGNMENT_SIGN);
  return state.expandedFrom === null || state.expandedFrom > nameEnd;
}

// tmux puts the home directory in the place of a ~ outside single quotes that
// a word starts with, or that comes right after a quote opens or closes
// (yylex_token in cmd-parse.y).
function readWord(source: string, start: number): WordRead {
  const state: WordState = {
    text: "",
    bytes: [],
    quote: null,
    lastQuote: undefined,
    openBraces: 0,
    expandedFrom: null,
    isReadable: true,
  };
  let at = start;
  while (at < source.length) {
    const character = source[at];
    if (closesRefusedBraces(state, character)) {
      state.openBraces -= 1;
      addText(state, character);
      at += 1;
      continue;
    }
    if (endsWord(state, character)) break;
    if (character === "\n") {
      flushBytes(state);
      state.text += character;
      at = quotedLineStart(source, at + 1);
      continue;
    }
    if (character === "\\" && state.quote !== "'") {
      const escape = readEscape(source, at + 1);
      addEscape(state, escape);
      at += 1 + (escape?.length ?? 1);
      continue;
    }
    const isQuote = character === "'" || character === '"';
    if (isQuote && (state.quote === null || state.quote === character)) {
      state.quote = state.quote === null ? character : null;
      at += 1;
      continue;
    }
    if (character === "$" && state.quote !== "'") {
      at = readVariable(state, source, at);
      continue;
    }
    const startsHomeDirectory =
      character === "~" && state.quote !== "'" && state.lastQuote !== state.quote;
    if (startsHomeDirectory) {
      flushBytes(state);
      markExpanded(state);
    }
    addText(state, character);
    at += 1;
  }
  flushBytes(state);
  const isExpanded = state.expandedFrom !== null;
  return {
    word: { type: "word", text: state.text, isExpanded },
    end: at,
    isReadable: state.quote === null && state.isReadable,
    isAssignment: readsAsAssignment(state),
  };
}

function tokenize(text: string): Token[] {
  const source = joinContinuedLines(text);
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const character = source[at];
    if (character === " " || character === "\t") {
      at += 1;
      continue;
    }
    if (character === "\n" || character === ";") {
      tokens.push({ type: "end" });
      at += 1;
      continue;
    }
    if (character === "{" || character === "}") {
      tokens.push({ type: character === "{" ? "open" : "close" });
      at += 1;
      continue;
    }
    // As in tmux, "#" at the start of a word starts a comment that runs to
    // the end of the line. The one exception is "#{" right after %if or
    // %elif, which is the format that the condition tests.
    if (character === "#") {
      const isFormat =
        tokens.at(-1)?.type === "condition" &&
        source.startsWith(FORMAT_OPEN, at);
      const end = isFormat ? formatEnd(source, at) : lineEnd(source, at);
      if (isFormat) {
        tokens.push({ type: "word", text: source.slice(at, end), isExpanded: false });
      }
      at = end;
      continue;
    }
    const { word, end, isReadable, isAssignment } = readWord(source, at);
    at = end;
    if (!isReadable) {
      tokens.push({ type: "unreadable" });
      continue;
    }
    if (isAssignment) {
      tokens.push({ type: "assignment", word });
      continue;
    }
    const isCondition = character === "%" && CONDITION_WORDS.has(word.text);
    tokens.push(isCondition ? { type: "condition", name: word.text } : word);
  }
  tokens.push({ type: "end" });
  return tokens;
}

function emptyFrame(): Frame {
  return { commands: [], args: [], isPlain: true, hasAssignment: false };
}

// tmux takes one NAME=value in front of a command for a variable to set and
// runs the command behind it. A second one is an error, and one behind the
// name of the command is an argument like any other (the command rule of
// cmd-parse.y).
function takeAssignment(frame: Frame, word: Word): void {
  if (frame.args.length > 0) {
    frame.args.push(word);
    return;
  }
  if (frame.hasAssignment) frame.isPlain = false;
  frame.hasAssignment = true;
}

function endCommand(frame: Frame): void {
  if (frame.isPlain && frame.args.length > 0) frame.commands.push(frame.args);
  frame.args = [];
  frame.isPlain = true;
  frame.hasAssignment = false;
}

// A closing brace without an opening one spoils the command it stands in.
function closeBlock(frames: Frame[]): void {
  const frame = frames[frames.length - 1];
  if (frames.length === 1) {
    frame.isPlain = false;
    return;
  }
  endCommand(frame);
  frames.pop();
  frames[frames.length - 1].args.push({ type: "block", commands: frame.commands });
}

// The commands of a config text in their order, each with the commands of its
// brace blocks as arguments. Everything from %if to its %endif is left out,
// and so is a command that such a condition is part of, one whose braces or
// quotes do not pair up, and one with an escape or a ${...} that tmux refuses.
// Nothing is evaluated.
export function parseCommands(text: string): ParsedCommand[] {
  const frames = [emptyFrame()];
  let conditionDepth = 0;
  for (const token of tokenize(text)) {
    const frame = frames[frames.length - 1];
    if (token.type === "condition") {
      frame.isPlain = false;
      if (token.name === CONDITION_OPEN) conditionDepth += 1;
      if (token.name === CONDITION_CLOSE && conditionDepth > 0) {
        conditionDepth -= 1;
      }
      continue;
    }
    if (conditionDepth > 0) continue;
    if (token.type === "unreadable") {
      frame.isPlain = false;
      continue;
    }
    if (token.type === "open") {
      frames.push(emptyFrame());
      continue;
    }
    if (token.type === "close") {
      closeBlock(frames);
      continue;
    }
    if (token.type === "word") {
      frame.args.push(token);
      continue;
    }
    if (token.type === "assignment") {
      takeAssignment(frame, token.word);
      continue;
    }
    endCommand(frame);
  }
  return frames[0].commands;
}

// The flags in front of the operands of a command, as tmux reads them: a flag
// named in valueFlags takes the rest of its word as its value, or else the
// next argument. null for a flag that is no letter or digit, and for a value
// that is missing, which are errors in tmux.
export function parseFlags(
  args: readonly Argument[],
  valueFlags: string,
): Flags | null {
  const flags = new Map<string, Argument | null>();
  let at = 0;
  while (at < args.length) {
    const argument = args[at];
    if (argument.type !== "word") break;
    const { text } = argument;
    if (!text.startsWith("-") || text === "-") break;
    at += 1;
    if (text === FLAGS_END) break;
    for (let index = 1; index < text.length; index += 1) {
      const flag = text[index];
      if (!FLAG_LETTER.test(flag)) return null;
      if (!valueFlags.includes(flag)) {
        flags.set(flag, null);
        continue;
      }
      const attached = text.slice(index + 1);
      if (attached === "" && at >= args.length) return null;
      flags.set(flag, attached === "" ? args[at] : { ...argument, text: attached });
      if (attached === "") at += 1;
      break;
    }
  }
  return { flags, operands: args.slice(at) };
}

// tmux takes the alias of a command, its name, and every shorter form of the
// name that no other command starts with.
export function isCommand(
  word: string,
  { name, alias, shortest }: CommandName,
): boolean {
  return word === alias || (word.startsWith(shortest) && name.startsWith(word));
}

// The text of an argument that is a word and that tmux would not change.
export function plainText(argument: Argument | null | undefined): string | null {
  if (argument === null || argument === undefined) return null;
  if (argument.type !== "word" || argument.isExpanded) return null;
  return argument.text;
}

// The first characters of a text, without half of a character at the cut: an
// emoji is two units of a string, and a cut between them leaves a broken one.
export function cutText(text: string, length: number): string {
  const cut = text.slice(0, length);
  const isSplit = cut.length < text.length && HIGH_SURROGATE_END.test(cut);
  return isSplit ? cut.slice(0, -1) : cut;
}

export function wholeNumber(
  text: string | null,
  min: number,
  max: number,
): number | null {
  if (text === null || !WHOLE_NUMBER.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

// tmux has no key for a character below a space (key_string_lookup_string in
// key-string.c), and this plugin has no name for a blank other than the
// space.
function baseFromTmuxKey(key: string): string | null {
  if (isSingleCharacter(key)) {
    if (key === " ") return "Space";
    const isKey = key.charCodeAt(0) >= FIRST_KEY_CODE && key.trim() !== "";
    return isKey ? key : null;
  }
  const name = key.toLowerCase();
  if (TMUX_FUNCTION_KEY.test(name)) return name.toUpperCase();
  return TMUX_KEY_NAMES.get(name) ?? null;
}

// A terminal sends the same byte for Ctrl-@ and for Ctrl-Space, so tmux takes
// either key press for C-@. A browser tells the two apart, and Ctrl-Space is
// the one that every keyboard layout has without Shift.
function baseWithHeld(key: string, held: ReadonlySet<string>): string | null {
  if (key.toLowerCase() === TMUX_BACK_TAB) return "Tab";
  if (key === TMUX_NUL_KEY && held.has("ctrl")) return "Space";
  return baseFromTmuxKey(key);
}

// The stroke of this plugin for a key as tmux writes it ("M-Up" is
// "M-ArrowUp"). null for a key that tmux does not accept in this form, or
// that this plugin has no name for.
export function strokeFromTmuxKey(key: string): string | null {
  if (key.length > MAX_KEY_LENGTH) return null;
  const held = new Set<string>();
  let rest = key;
  if (rest.startsWith("^") && rest.length > 1) {
    held.add("ctrl");
    rest = rest.slice(1);
  }
  while (rest.length > 2 && rest[1] === "-") {
    const modifier = TMUX_MODIFIERS.get(rest[0].toLowerCase());
    if (modifier === undefined) return null;
    held.add(modifier);
    rest = rest.slice(2);
  }
  const isBackTab = rest.toLowerCase() === TMUX_BACK_TAB;
  const base = baseWithHeld(rest, held);
  if (base === null) return null;
  // Without Ctrl a capital letter is typed with Shift. With Ctrl a letter is
  // taken for the same key in either case. tmux 3.5a does that for ^A only
  // and keeps C-A apart from C-a (key_string_lookup_string in key-string.c).
  const isShifted = isBackTab || (isUpperCaseLetter(rest) && !held.has("ctrl"));
  return strokeFromNamedKey({
    ctrl: held.has("ctrl"),
    alt: held.has("alt"),
    shift: isShifted || held.has("shift"),
    base,
  });
}
