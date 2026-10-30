// The last project-scoped place the user was in, per project, so the project
// picker can return to it instead of leaving the main pane on another project
// (BB-113). The Stewards page and a thread are the two project-scoped routes;
// settings, the home page and other plugin panels are not, and record nothing.
//
// The map is one `localStorage` entry, keyed by plugin id so a copy of this
// plugin published under another name does not share it. Both the read and the
// write swallow storage errors — a browser with storage disabled loses the
// memory, not the page — and a malformed entry is dropped rather than trusted,
// the same shape `thread-briefs/board-page.tsx` and `multi-repo/repos-panel.tsx`
// use for their own remembered choices.

/** Where a project was last open: a thread, or the Stewards page (with an effort key, or null for the page). */
export type LastPlace = { kind: "thread"; threadId: string } | { kind: "board"; key: string | null };

const STORAGE_SUFFIX = ":last-place";

/** The `localStorage` key holding one plugin's project → place map. */
export function lastPlaceStorageKey(pluginId: string): string {
  return `${pluginId}${STORAGE_SUFFIX}`;
}

/** One entry off disk, or null when it is not a place this version understands. */
function parsePlace(value: unknown): LastPlace | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (entry.kind === "thread") {
    return typeof entry.threadId === "string" && entry.threadId !== "" ? { kind: "thread", threadId: entry.threadId } : null;
  }
  if (entry.kind === "board") {
    if (entry.key === null || entry.key === undefined) return { kind: "board", key: null };
    return typeof entry.key === "string" ? { kind: "board", key: entry.key } : null;
  }
  return null;
}

/** Every remembered place, project id → place. Malformed entries are dropped; a broken store reads as empty. */
export function readLastPlaces(pluginId: string): Record<string, LastPlace> {
  try {
    const raw = window.localStorage.getItem(lastPlaceStorageKey(pluginId));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const places: Record<string, LastPlace> = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (projectId === "") continue;
      const place = parsePlace(value);
      if (place !== null) places[projectId] = place;
    }
    return places;
  } catch {
    // Private browsing, or storage disabled. No memory, not a broken sidebar.
    return {};
  }
}

/** One project's remembered place, or null when there is none. */
export function readLastPlace(pluginId: string, projectId: string): LastPlace | null {
  return readLastPlaces(pluginId)[projectId] ?? null;
}

/** Remember one project's place, keeping every other project's. A failed write is survivable. */
export function writeLastPlace(pluginId: string, projectId: string, place: LastPlace): void {
  try {
    const places = readLastPlaces(pluginId);
    places[projectId] = place;
    window.localStorage.setItem(lastPlaceStorageKey(pluginId), JSON.stringify(places));
  } catch {
    // As above: not remembering the place is fine; failing the navigation is not.
  }
}
