import { useState, type ReactElement } from "react";
import type { CopyModeUi, Keymap } from "../types";
import { useUiState } from "./hooks";
import { usePrefixPillText } from "./PrefixIndicator";

const COPY_MODE_WORDS = "Copy mode";
const SELECTING_WORDS = "Copy mode, selecting";
const COPY_MODE_ENDED_WORDS = "Copy mode ended";
const PREFIX_WORDS = "Prefix armed";
const SEPARATOR = ", ";

// What the region holds: the words for copy mode, null for none, and whether
// it names the prefix.
interface Spoken {
  mode: string | null;
  isArmed: boolean;
}

function modeWords(copyMode: CopyModeUi): string | null {
  if (!copyMode.active) return null;
  return copyMode.selecting ? SELECTING_WORDS : COPY_MODE_WORDS;
}

// The end of copy mode is said once: its words stay until the prefix is
// armed anew, which is the next thing to say, and are not said with it.
function nextSpoken(spoken: Spoken, mode: string | null, isArmed: boolean): Spoken {
  if (mode !== null) return { mode, isArmed };
  if (spoken.mode === null) return { mode: null, isArmed };
  const isArmedAnew = isArmed && !spoken.isArmed;
  const isEndSaid = spoken.mode === COPY_MODE_ENDED_WORDS;
  return { mode: isEndSaid && isArmedAnew ? null : COPY_MODE_ENDED_WORDS, isArmed };
}

// A screen reader says a polite live region when an element or text is
// added to it, all of it as the region is atomic, and says nothing when
// something is taken out of it. The pills enter the page with their text, so
// this element is there before them and tells in words what they show: the
// words for copy mode first, as on the screen. They sit in an element that is
// put in anew whenever they change, and the words for the prefix in one that
// is taken out when the prefix goes away, which is therefore not said. It
// has no role of a status, so that the pills stay the only elements with
// that role.
export function PillAnnouncer({
  keymap,
}: {
  keymap: Keymap | null;
}): ReactElement {
  const mode = useUiState((state) => modeWords(state.copyMode));
  const isArmed = usePrefixPillText(keymap) !== null;
  const [spoken, setSpoken] = useState<Spoken>({ mode, isArmed });
  const next = nextSpoken(spoken, mode, isArmed);
  if (next.mode !== spoken.mode || next.isArmed !== spoken.isArmed) setSpoken(next);
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      data-testid="pill-announcer"
      className="sr-only"
    >
      {next.mode === null ? null : <span key={next.mode}>{next.mode}</span>}
      {next.isArmed ? (
        <span>{next.mode === null ? PREFIX_WORDS : SEPARATOR + PREFIX_WORDS}</span>
      ) : null}
    </div>
  );
}
