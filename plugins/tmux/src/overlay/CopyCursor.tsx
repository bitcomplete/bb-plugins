import type { ReactElement } from "react";
import { useUiState } from "./hooks";

export function CopyCursor(): ReactElement | null {
  const copyMode = useUiState((state) => state.copyMode);
  if (!copyMode.active || copyMode.cursor === null) return null;
  const { left, top, width, height } = copyMode.cursor;
  return (
    <div
      aria-hidden="true"
      data-testid="copy-cursor"
      className="pointer-events-none fixed z-40 bg-foreground/40"
      style={{ left, top, width, height }}
    />
  );
}
