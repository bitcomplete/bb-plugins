export type ViewId = "deck" | "inventory" | "map" | "efforts";

/**
 * Renamed when the effort deck became the front door (plan amendment A15), as it was when the PR inventory did (A13), so a view
 * remembered before then opens the deck once; after that, the panel reopens the last view you chose.
 */
export const VIEW_STORAGE_KEY = "bb-workstreams:last-view-since-deck";

export function viewFromSubPath(subPath: string): ViewId | null {
  const head = subPath.split("/").find(Boolean);
  return head === "deck" || head === "inventory" || head === "map" || head === "efforts" ? head : null;
}

/**
 * `deck/<card>`: the card to open, such as a thread's effort chip links to (an effort's id, or a service card's `service:<owner/repo>`);
 * null for any other path. BB turns an encoded "/" back into one before the panel sees it, so the card is the rest of the path.
 */
export function deckRoute(subPath: string): string | null {
  const [head, ...rest] = subPath.split("/").filter(Boolean);
  if (head !== "deck" || !rest.length) return null;
  const card = rest.join("/");
  try { return decodeURIComponent(card); } catch { return card; }
}

/**
 * What a `deck/<card>` link does with a deck read: open its card on the active ring, open the On hold pile for a held effort, or, when
 * the deck lacks it, read again if no read has landed since the link (a cached deck can predate a card just made), else let it go.
 */
export function deckLinkStep(card: string, deck: { ring: readonly string[]; held: readonly string[] }, readSinceLink: boolean): "open" | "hold" | "read" | "drop" {
  if (deck.ring.includes(card)) return "open";
  if (deck.held.includes(card)) return "hold";
  return readSinceLink ? "drop" : "read";
}

/** The view the panel root opens: the last one chosen, else the effort deck (also for a removed view's id). */
export function readLastView(): ViewId {
  try {
    const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return saved === "inventory" || saved === "map" || saved === "efforts" ? saved : "deck";
  } catch {
    return "deck";
  }
}

export function storeLastView(view: ViewId): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // The view remains usable when storage is disabled.
  }
}

/** Card PR links target the existing workbench's stable row key, including encoded slashes. */
export function inventoryPrPath(prUrl: string): string {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/u.exec(prUrl);
  return match ? `inventory/${encodeURIComponent(`${match[1]}#${match[2]}`)}` : "inventory";
}
export function inventoryRoute(subPath: string): string | null {
  const [head, ...rest] = subPath.split("/").filter(Boolean);
  if (head !== "inventory" || !rest.length) return null;
  let key: string; try { key = decodeURIComponent(rest.join("/")); } catch { return null; }
  return /^[^/\s#]+\/[^/\s#]+#\d+$/u.test(key) ? key : null;
}
