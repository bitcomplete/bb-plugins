import type {
  BbNavigate,
  PluginSidebarSplitLayout,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import { PLUGIN_ID } from "../constants";
import {
  buildSnapshot,
  decideRestore,
  isRouteReconciled,
  readSnapshot,
  removeSnapshot,
  writeSnapshot,
  type LayoutSnapshot,
} from "../restore";
import { activeThreads } from "../thread-order";
import { announceWindow, lockManagerOrNull } from "./window-presence";

export interface ColdStartInput {
  navigate: BbNavigate;
  layout: PluginSidebarSplitLayout | null;
  contextThreadId: string | null;
  threads: readonly PluginSidebarThread[];
  threadsReady: boolean;
}

type RestoreContext = Pick<
  ColdStartInput,
  "layout" | "contextThreadId" | "threads"
>;

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStoredSnapshot(): LayoutSnapshot | null {
  const storage = localStorageOrNull();
  return storage === null ? null : readSnapshot(storage);
}

export function forgetStoredSnapshot(): void {
  const storage = localStorageOrNull();
  if (storage !== null) removeSnapshot(storage);
}

function threadToReopen(
  snapshot: LayoutSnapshot | null,
  { layout, contextThreadId, threads }: RestoreContext,
): string | null {
  try {
    return decideRestore({
      snapshot,
      layout,
      contextThreadId,
      pathname: window.location.pathname,
      activeThreadIds: new Set(
        activeThreads(threads).map((thread) => thread.id),
      ),
    });
  } catch (error) {
    console.error(`[${PLUGIN_ID}] checking the saved layout failed`, error);
    return null;
  }
}

// bb loads this plugin after the New thread screen is on screen, so the user
// can already be typing a message there. The browser remembers whether the
// window has been clicked or typed in since it loaded (sticky user activation,
// https://developer.mozilla.org/en-US/docs/Web/API/UserActivation/hasBeenActive).
// Browsers without that API are treated as untouched.
function hasUserUsedWindow(): boolean {
  const activation: UserActivation | undefined = navigator.userActivation;
  return activation?.hasBeenActive === true;
}

// A new window or tab also starts on the New thread screen and reads the
// snapshot that another window saved, so only the first bb window is repaired.
// null until the browser has answered. Without the Web Locks API there is no
// way to tell, and the window is treated as the only one.
function useIsOnlyWindow(): boolean | null {
  const [locks] = useState(lockManagerOrNull);
  const [isOnlyWindow, setIsOnlyWindow] = useState<boolean | null>(
    locks === null ? true : null,
  );

  useEffect(() => {
    if (locks === null) return;
    let isActive = true;
    const presence = announceWindow(locks);
    void presence.hasOtherWindow.then((hasOtherWindow) => {
      if (isActive) setIsOnlyWindow(!hasOtherWindow);
    });
    return () => {
      isActive = false;
      presence.release();
    };
  }, [locks]);

  return isOnlyWindow;
}

export function useColdStartRepair({
  navigate,
  layout,
  contextThreadId,
  threads,
  threadsReady,
}: ColdStartInput): void {
  const [storedSnapshot] = useState(readStoredSnapshot);
  const [hasDecided, setHasDecided] = useState(false);
  const hasDecidedRef = useRef(false);
  const isOnlyWindow = useIsOnlyWindow();

  useEffect(() => {
    if (hasDecidedRef.current || !threadsReady || isOnlyWindow === null) return;
    if (!isRouteReconciled(layout, window.location.pathname)) return;
    hasDecidedRef.current = true;
    const mayRepair = isOnlyWindow && !hasUserUsedWindow();
    const threadId = mayRepair
      ? threadToReopen(storedSnapshot, { layout, contextThreadId, threads })
      : null;
    if (threadId !== null) navigate.toThread(threadId);
    setHasDecided(true);
  }, [
    threadsReady,
    isOnlyWindow,
    storedSnapshot,
    layout,
    contextThreadId,
    threads,
    navigate,
  ]);

  useEffect(() => {
    if (!hasDecided) return;
    const storage = localStorageOrNull();
    if (storage === null) return;
    writeSnapshot(storage, buildSnapshot(layout, contextThreadId, Date.now()));
  }, [hasDecided, layout, contextThreadId]);
}
