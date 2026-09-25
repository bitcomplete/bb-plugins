export type ViewId = "map" | "board" | "board-v2";

export const VIEW_STORAGE_KEY = "bb-workstreams:last-view";

export function viewFromSubPath(subPath: string): ViewId | null {
  const head = subPath.split("/").find(Boolean);
  return head === "map" || head === "board" || head === "board-v2" ? head : null;
}

export function readLastView(): ViewId {
  try {
    const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return saved === "board" || saved === "board-v2" ? saved : "map";
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
