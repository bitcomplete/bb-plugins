export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface CompositionEventLike {
  isComposing: boolean;
  keyCode: number;
  key: string;
}

interface Chord {
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  shift: boolean;
  base: string;
}

// A key that is named with the keys held for it, as a tmux config names one.
// base is a character, or the name that a key press has for the key.
type NamedKey = Omit<Chord, "meta">;

// The modifiers and locks, and the keys that only switch how text is entered
// (the "IME and composition keys" of the KeyboardEvent key values). A
// terminal sends none of them, so they are no key press to tmux.
const NON_STROKE_KEYS: ReadonlySet<string> = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "CapsLock",
  "Fn",
  "AltGraph",
  "FnLock",
  "NumLock",
  "ScrollLock",
  "Hyper",
  "Super",
  "Symbol",
  "SymbolLock",
  "OS",
  "Dead",
  "Unidentified",
  "Process",
  "Alphanumeric",
  "CodeInput",
  "Compose",
  "Convert",
  "FinalMode",
  "GroupFirst",
  "GroupLast",
  "GroupNext",
  "GroupPrevious",
  "ModeChange",
  "NonConvert",
  "HangulMode",
  "HanjaMode",
  "JunjaMode",
  "Eisu",
  "Hankaku",
  "Hiragana",
  "HiraganaKatakana",
  "KanaMode",
  "KanjiMode",
  "Katakana",
  "Romaji",
  "Zenkaku",
  "ZenkakuHankaku",
]);

const MODIFIER_LABELS = [
  ["C-", "Ctrl-"],
  ["M-", "Alt-"],
  ["S-", "Shift-"],
] as const;

const MAC_MODIFIER_LABELS = [
  ["C-", "Ctrl-"],
  ["M-", "Option-"],
  ["S-", "Shift-"],
] as const;

// tmux's names for the arrow keys, which the key help and the pill show.
const KEY_LABELS: ReadonlyMap<string, string> = new Map([
  ["ArrowUp", "Up"],
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
]);

// A terminal sends one and the same byte for the two keys of each pair, so
// tmux takes Ctrl-[ for Escape, Ctrl-m for Enter and Ctrl-i for Tab. A
// browser tells them apart.
export const TERMINAL_KEYS: ReadonlyMap<string, string> = new Map([
  ["C-[", "Escape"],
  ["C-m", "Enter"],
  ["C-i", "Tab"],
]);

const IME_KEY_CODE = 229;
const DEAD_KEY = "Dead";
const CHORD_STROKE = /^(C-|M-|D-)/;

// A dead key (it waits for the next letter to put an accent on it) and a key
// that an input method turns into text. The browser reports some of them as
// key 229 and gives the rest away by the key name or the composing flag. The
// key that ends a composition can come without that flag and still as 229.
export function isCompositionKey(event: CompositionEventLike): boolean {
  return (
    event.isComposing ||
    event.keyCode === IME_KEY_CODE ||
    event.key === DEAD_KEY
  );
}

export function isSingleCharacter(value: string): boolean {
  return Array.from(value).length === 1;
}

export function isUpperCaseLetter(key: string): boolean {
  return isSingleCharacter(key) && key !== key.toLowerCase();
}

// A stroke of a key that is pressed with Ctrl, Alt or Cmd.
export function isChord(stroke: string): boolean {
  return CHORD_STROKE.test(stroke);
}

// The key that a terminal sends for the stroke, null for a stroke that a
// terminal sends as itself.
export function terminalKeyOf(stroke: string): string | null {
  return TERMINAL_KEYS.get(stroke) ?? null;
}

function isAsciiAlphanumeric(value: string): boolean {
  return /^[a-z0-9]$/i.test(value);
}

function baseFromCode(code: string | undefined): string | null {
  if (code === undefined) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code === "Space" ? "Space" : null;
}

function baseFromEvent(event: KeyEventLike): string {
  if (event.key === " " || event.key === "Spacebar") return "Space";
  if (!event.altKey || isAsciiAlphanumeric(event.key)) return event.key;
  return baseFromCode(event.code) ?? event.key;
}

function strokeFromChord({ ctrl, alt, meta, shift, base }: Chord): string {
  const isCharacter = isSingleCharacter(base);
  if (isCharacter && !ctrl && !alt && !meta) return base;
  const modifiers = [
    ctrl ? "C-" : "",
    alt ? "M-" : "",
    meta ? "D-" : "",
    shift ? "S-" : "",
  ].join("");
  return modifiers + (isCharacter ? base.toLowerCase() : base);
}

// A keydown that a script dispatches as a plain Event has no key at all.
export function keyStrokeFromEvent(event: KeyEventLike): string | null {
  if (typeof event.key !== "string" || event.key === "") return null;
  if (NON_STROKE_KEYS.has(event.key)) return null;
  return strokeFromChord({
    ctrl: event.ctrlKey,
    alt: event.altKey,
    meta: event.metaKey,
    shift: event.shiftKey,
    base: baseFromEvent(event),
  });
}

// On some keyboard layouts a character is typed with Option (macOS) or AltGr
// (which Windows can report as Ctrl plus Alt): "[" is Option-5 on a German
// Mac keyboard. Such a key press is a chord (M-5) and a typed character at once.
export function typedCharacterFromEvent(
  event: KeyEventLike,
  isMac: boolean,
): string | null {
  const isTypingModifier = isMac ? !event.ctrlKey : event.ctrlKey;
  if (!event.altKey || event.metaKey || !isTypingModifier) return null;
  if (!isSingleCharacter(event.key) || isAsciiAlphanumeric(event.key)) return null;
  return event.key.trim() === "" ? null : event.key;
}

// Shift plus a letter is the capital letter. For any other character the
// result depends on the keyboard layout, so such a key has no stroke.
export function strokeFromNamedKey({
  ctrl,
  alt,
  shift,
  base,
}: NamedKey): string | null {
  const isShiftedCharacter = isSingleCharacter(base) && shift && !ctrl && !alt;
  if (!isShiftedCharacter) {
    return strokeFromChord({ ctrl, alt, meta: false, shift, base });
  }
  const upper = base.toUpperCase();
  return upper === base.toLowerCase() ? null : upper;
}

export function formatStroke(stroke: string, isMac = false): string {
  let rest = stroke;
  let label = "";
  for (const [prefix, text] of isMac ? MAC_MODIFIER_LABELS : MODIFIER_LABELS) {
    if (!rest.startsWith(prefix)) continue;
    label += text;
    rest = rest.slice(prefix.length);
  }
  return label + (KEY_LABELS.get(rest) ?? rest);
}
