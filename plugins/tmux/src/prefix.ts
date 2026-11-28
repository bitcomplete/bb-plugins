import { formatStroke, isSingleCharacter } from "./keys";
import { STOCK_TMUX_OPTIONS } from "./tmux-defaults";

const CTRL_OR_ALT_STROKE = /^(C-|M-)/;
const FUNCTION_KEY_STROKE = /^(S-)?F\d{1,2}$/;
// The keys that a stroke names as held, in their order, in front of its key.
const HELD_KEYS = /^(?:C-)?(?:M-)?(?:S-)?/;
// How a stroke names a key that is no character: Space, ArrowUp, F5.
const KEY_NAME = /^[A-Z][A-Za-z0-9]+$/;

// What the user's tmux config says about the prefix. key is a stroke of this
// plugin when the prefix is usable, and the text from the config when not.
export interface TmuxPrefix {
  key: string;
  path: string;
  usable: boolean;
}

// answered: the server has read the tmux config, and prefix is null when
// nothing in it sets one. unavailable: the server did not answer in time or
// failed, or nothing of the config could be read. partly-read: a part was
// read and sets no prefix, and a config file or the pasted text that may
// set one could not be read.
export type TmuxLookup =
  | { status: "answered"; prefix: TmuxPrefix | null }
  | { status: "partly-read" }
  | { status: "unavailable" };

export type TmuxDefaultCause =
  | { kind: "not-set" }
  | { kind: "not-usable"; key: string; path: string }
  | { kind: "partly-read" }
  | { kind: "not-read" };

export type PrefixOrigin =
  | { kind: "tmux-config"; path: string }
  | { kind: "tmux-default"; cause: TmuxDefaultCause };

export interface ResolvedPrefix {
  stroke: string;
  origin: PrefixOrigin;
}

// A plain key that works without the prefix would be taken away from typing
// in every text field, so such a key needs Ctrl or Alt, or has to be a
// function key. This holds for the prefix and for a key of tmux's root table.
export function worksWithoutPrefix(stroke: string): boolean {
  return CTRL_OR_ALT_STROKE.test(stroke) || FUNCTION_KEY_STROKE.test(stroke);
}

// The prefix stands in for Ctrl-b, so a text that is no stroke of one key
// must not become the prefix: after the held keys comes one character in
// lower case, or the name of a key. That leaves out the capital dotted I of
// Turkish, whose lower case is two characters.
export function isUsablePrefix(stroke: string): boolean {
  if (!worksWithoutPrefix(stroke)) return false;
  const key = stroke.replace(HELD_KEYS, "");
  if (isSingleCharacter(key)) return key === key.toLowerCase();
  return KEY_NAME.test(key);
}

function tmuxDefault(cause: TmuxDefaultCause): ResolvedPrefix {
  return {
    stroke: STOCK_TMUX_OPTIONS.prefix,
    origin: { kind: "tmux-default", cause },
  };
}

export function resolvePrefix(lookup: TmuxLookup): ResolvedPrefix {
  if (lookup.status === "unavailable") return tmuxDefault({ kind: "not-read" });
  if (lookup.status === "partly-read") return tmuxDefault({ kind: "partly-read" });
  const { prefix } = lookup;
  if (prefix === null) return tmuxDefault({ kind: "not-set" });
  if (!prefix.usable || !isUsablePrefix(prefix.key)) {
    return tmuxDefault({
      kind: "not-usable",
      key: prefix.key,
      path: prefix.path,
    });
  }
  return {
    stroke: prefix.key,
    origin: { kind: "tmux-config", path: prefix.path },
  };
}

function describeCause(cause: TmuxDefaultCause): string {
  if (cause.kind === "not-set") return "no tmux config sets a prefix";
  if (cause.kind === "not-read") return "the tmux config could not be read";
  if (cause.kind === "partly-read") {
    return "part of the tmux config could not be read and may set another one";
  }
  return `the prefix ${cause.key} in ${cause.path} cannot be used in bb`;
}

// isMac only changes how the Alt key is named: Option on a Mac keyboard.
export function describePrefix(
  { stroke, origin }: ResolvedPrefix,
  isMac = false,
): string {
  const prefix = `Prefix: ${formatStroke(stroke, isMac)}`;
  if (origin.kind === "tmux-config") return `${prefix}, from ${origin.path}`;
  return `${prefix}, tmux's default (${describeCause(origin.cause)})`;
}
