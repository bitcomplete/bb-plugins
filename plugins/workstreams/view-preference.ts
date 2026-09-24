export type ViewId = "map" | "board";

export const VIEW_STORAGE_KEY = "bb-workstreams:last-view";

export function viewFromSubPath(subPath: string): ViewId | null {
  const head = subPath.split("/").find(Boolean);
  return head === "map" || head === "board" ? head : null;
}

export function readLastView(): ViewId {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "board" ? "board" : "map";
  } catch {
    return "map";
  }
}

export function storeLastView(view: ViewId): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // The view remains usable when storage is disabled.
  }
}
