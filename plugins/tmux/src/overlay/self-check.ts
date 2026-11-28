import { useEffect, useRef } from "react";
import { useIsCompactViewport } from "../../components/ui/hooks/use-compact-viewport";
import { BB_VERSION_VERIFIED, PLUGIN_ID } from "../constants";
import { runSelfCheck } from "../dom-actions";

// Skipped on a compact viewport, where bb's sidebar is a drawer that is not
// always in the page.
export function useSelfCheck(isAppReady: boolean): void {
  const hasChecked = useRef(false);
  const isCompact = useIsCompactViewport();

  useEffect(() => {
    if (hasChecked.current || !isAppReady || isCompact) return;
    hasChecked.current = true;
    const missing = runSelfCheck();
    if (missing.length === 0) return;
    console.warn(
      `[${PLUGIN_ID}] bb markup this plugin relies on was not found: ${missing.join(", ")}. Some keys may not work. The plugin was verified against bb ${BB_VERSION_VERIFIED}.`,
    );
  }, [isAppReady, isCompact]);
}
