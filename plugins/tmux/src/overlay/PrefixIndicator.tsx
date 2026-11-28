import type { ReactElement } from "react";
import { isMacPlatform } from "../bb-commands";
import { formatStroke } from "../keys";
import type { Keymap } from "../types";
import { useUiState } from "./hooks";

// What the prefix pill shows: the prefix key that was pressed. null while no
// prefix is armed, and while the keys are not known.
export function usePrefixPillText(keymap: Keymap | null): string | null {
  const isArmed = useUiState((state) => state.prefixArmed);
  const armedBy = useUiState((state) => state.prefixArmedBy);
  if (!isArmed || keymap === null) return null;
  return formatStroke(armedBy ?? keymap.prefix, isMacPlatform(navigator.platform));
}

export function PrefixIndicator({
  keymap,
}: {
  keymap: Keymap | null;
}): ReactElement | null {
  const text = usePrefixPillText(keymap);
  if (text === null) return null;
  return (
    <div
      role="status"
      className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1 text-xs font-medium text-popover-foreground shadow-lg"
    >
      {text}
    </div>
  );
}
