// The board panel's route, published by `BoardPage` and read by the sidebar
// thread list (BB-94). The list is mounted by the host, not by the panel, so it
// has no `subPath`: `activeThreadId` and `activeProjectId` are null (or stale)
// while the Stewards page is the route, and this store is how the list learns
// which project and effort that page shows. `{ projectId: null, key: null }`
// whenever the panel is not mounted, which is also the "is the panel active"
// test the project picker uses.
import { useSyncExternalStore } from "react";

export interface BoardRoute {
  projectId: string | null;
  key: string | null;
}

const EMPTY: BoardRoute = { projectId: null, key: null };

let route: BoardRoute = EMPTY;
const listeners = new Set<() => void>();

/** Publish the panel's route. A no-op when nothing changed, so `getSnapshot` stays referentially stable. */
export function setBoardRoute(next: BoardRoute): void {
  if (route.projectId === next.projectId && route.key === next.key) return;
  route = { projectId: next.projectId, key: next.key };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): BoardRoute {
  return route;
}

/** The board panel's route, or `{ null, null }` while the panel is not mounted. */
export function useBoardRoute(): BoardRoute {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
