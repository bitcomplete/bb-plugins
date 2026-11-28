import type { PluginSidebarSplitLayout } from "@get-bb/plugin-sdk/app";
import { BB_ROUTES, PLUGIN_STORAGE_KEYS } from "./constants";

export interface SnapshotPane {
  paneId: string;
  threadId: string | null;
  isFocused: boolean;
}

export interface LayoutSnapshot {
  version: 1;
  savedAt: number;
  focusedThreadId: string | null;
  panes: SnapshotPane[];
}

export interface RestoreInput {
  snapshot: LayoutSnapshot | null;
  layout: PluginSidebarSplitLayout | null;
  contextThreadId: string | null;
  pathname: string;
  activeThreadIds: ReadonlySet<string>;
}

const SNAPSHOT_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThreadIdOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSnapshotPane(value: unknown): value is SnapshotPane {
  return (
    isRecord(value) &&
    typeof value.paneId === "string" &&
    isThreadIdOrNull(value.threadId) &&
    typeof value.isFocused === "boolean"
  );
}

function isLayoutSnapshot(value: unknown): value is LayoutSnapshot {
  return (
    isRecord(value) &&
    value.version === SNAPSHOT_VERSION &&
    typeof value.savedAt === "number" &&
    Number.isFinite(value.savedAt) &&
    isThreadIdOrNull(value.focusedThreadId) &&
    Array.isArray(value.panes) &&
    value.panes.every(isSnapshotPane)
  );
}

export function buildSnapshot(
  layout: PluginSidebarSplitLayout | null,
  contextThreadId: string | null,
  now: number,
): LayoutSnapshot {
  const panes = (layout?.panes ?? []).map(
    (pane): SnapshotPane => ({
      paneId: pane.paneId,
      threadId: pane.threadId,
      isFocused: pane.isFocused,
    }),
  );
  const focusedThreadId =
    layout === null
      ? contextThreadId
      : (panes.find((pane) => pane.isFocused)?.threadId ?? null);
  return { version: SNAPSHOT_VERSION, savedAt: now, focusedThreadId, panes };
}

export function readSnapshot(storage: Pick<Storage, "getItem">): LayoutSnapshot | null {
  try {
    const raw = storage.getItem(PLUGIN_STORAGE_KEYS.layoutSnapshot);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isLayoutSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSnapshot(
  storage: Pick<Storage, "setItem">,
  snapshot: LayoutSnapshot,
): void {
  try {
    storage.setItem(PLUGIN_STORAGE_KEYS.layoutSnapshot, JSON.stringify(snapshot));
  } catch {
    // Storage can be full or disabled; the snapshot is best effort.
  }
}

export function removeSnapshot(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(PLUGIN_STORAGE_KEYS.layoutSnapshot);
  } catch {
    // Storage can be disabled; the snapshot is best effort.
  }
}

// On the New thread route bb makes the focused pane show the New thread
// screen. Until that has happened the layout still holds the pane's old thread,
// and a decision taken then would miss the thread that is about to be dropped.
export function isRouteReconciled(
  layout: PluginSidebarSplitLayout | null,
  pathname: string,
): boolean {
  if (layout === null || pathname !== BB_ROUTES.newThread) return true;
  return layout.panes.every((pane) => !pane.isFocused || pane.threadId === null);
}

export function decideRestore(input: RestoreInput): string | null {
  const { snapshot, layout, contextThreadId, pathname, activeThreadIds } = input;
  if (snapshot === null) return null;
  const threadId = snapshot.focusedThreadId;
  if (threadId === null) return null;
  if (!activeThreadIds.has(threadId)) return null;
  // The desktop app loads the New thread route on every cold start.
  if (pathname !== BB_ROUTES.newThread) return null;
  if (contextThreadId !== null) return null;
  if (layout?.panes.some((pane) => pane.threadId === threadId)) return null;
  if (snapshot.panes.length === 0) return layout === null ? threadId : null;
  if (layout === null) return null;
  const savedFocusedPane = snapshot.panes.find((pane) => pane.isFocused);
  if (savedFocusedPane === undefined) return null;
  const currentPane = layout.panes.find(
    (pane) => pane.paneId === savedFocusedPane.paneId,
  );
  if (currentPane === undefined || currentPane.threadId !== null) return null;
  // navigate.toThread fills the focused pane, so the emptied pane must be it.
  return currentPane.isFocused ? threadId : null;
}
