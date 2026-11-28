import { runCoreCommand } from "./bb-commands";
import { getBridge, showNotice } from "./bridge";
import { BB_COMMANDS, MAX_PANES, PLUGIN_ID } from "./constants";
import { clickMaximizePane, isPaneZoomed } from "./dom-actions";
import {
  getFocusedThreadId,
  settleDomFocusWhen,
  settleIdleDomFocus,
} from "./pane-focus";
import type { Bridge, Placement } from "./types";

export type OpenThreadResult =
  | "opened"
  | "focused-existing"
  | "pane-limit"
  | "unavailable";

export const BRIDGE_MISSING_NOTICE = "bb is still loading. Try again in a moment.";
export const PANE_LIMIT_NOTICE = `bb allows at most ${MAX_PANES} panes. Close one before splitting again.`;

const BROADCAST_SETTLE_TIMEOUT_MS = 3000;

export function isThreadVisible(bridge: Bridge, threadId: string): boolean {
  if (bridge.layout === null) return bridge.context.threadId === threadId;
  return bridge.layout.panes.some((pane) => pane.threadId === threadId);
}

// bb's zoom follows focus, so a split made while zoomed would leave the new
// pane zoomed. Only local triggers are used: the SDK's paneAction is broadcast
// and arrives after the split, when it would zoom the old pane instead.
export function unzoomBeforeSplit(): void {
  if (!isPaneZoomed()) return;
  if (runCoreCommand(BB_COMMANDS.paneMaximizeToggle) === "ran") return;
  clickMaximizePane();
}

function settleOnThread(threadId: string, timeoutMs?: number): () => boolean {
  return settleDomFocusWhen(() => getFocusedThreadId() === threadId, timeoutMs);
}

export function openThread(threadId: string, placement: Placement): OpenThreadResult {
  const bridge = getBridge();
  if (bridge === null) {
    showNotice(BRIDGE_MISSING_NOTICE);
    return "unavailable";
  }
  if (isThreadVisible(bridge, threadId)) {
    bridge.navigate.toThread(threadId);
    settleOnThread(threadId);
    return "focused-existing";
  }
  if (placement === "replace") {
    bridge.navigate.toThread(threadId);
    settleOnThread(threadId);
    return "opened";
  }
  const paneCount = bridge.layout?.panes.length ?? 1;
  if (paneCount >= MAX_PANES) {
    showNotice(PANE_LIMIT_NOTICE);
    return "pane-limit";
  }
  unzoomBeforeSplit();
  if (placement === "right") {
    bridge.navigate.toThread(threadId, { split: true });
    settleOnThread(threadId);
    return "opened";
  }
  const stopSettling = settleOnThread(threadId, BROADCAST_SETTLE_TIMEOUT_MS);
  bridge.sdk.threads
    .open({ threadId, split: "down", file: null })
    .catch((error: unknown) => {
      console.error(`[${PLUGIN_ID}] threads.open failed`, error);
      showNotice("Could not open the thread in a pane below.");
      // No pane will come, so the wait for it must not move the cursor later
      // on. A cursor that the closed chooser left on nothing goes into the
      // message box now, and one on a sidebar row or in a text field stays.
      if (stopSettling()) settleIdleDomFocus();
    });
  return "opened";
}
