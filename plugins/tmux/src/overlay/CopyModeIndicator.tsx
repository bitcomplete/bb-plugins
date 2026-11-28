import type { ReactElement } from "react";
import type { CopyModeUi } from "../types";
import { useUiState } from "./hooks";

function modeLabel(copyMode: CopyModeUi): string | null {
  if (!copyMode.active) return null;
  return copyMode.selecting ? "SELECT" : "COPY";
}

// Sits one row above the prefix pill, which can show at the same time.
export function CopyModeIndicator(): ReactElement | null {
  const label = useUiState((state) => modeLabel(state.copyMode));
  if (label === null) return null;
  return (
    <div
      role="status"
      className="pointer-events-none fixed bottom-12 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1 text-xs font-medium text-popover-foreground shadow-lg"
    >
      {label}
    </div>
  );
}
