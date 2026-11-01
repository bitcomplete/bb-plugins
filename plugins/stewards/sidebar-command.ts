// The stewards sidebar list's imperative surface, published by `ProjectTabs`
// and read by the plugin's commands (BB-188), which run outside React. The
// host mounts the list only while it is the sidebar's active list, so a null
// handle is both "the command cannot do anything" and the mount test
// `isAvailable` reads. The module-level shape follows `board-route.ts`.
//
// BB-189 reuses the same handle for its compose command rather than adding a
// second store.

export interface StewardsSidebarCommand {
  /** The project the list is showing, or null while it is not mounted. */
  projectId: string | null;
  /** Open the project picker popover and focus into it. */
  openPicker: () => void;
  /** Compose a new thread on the project the list is showing (BB-189). */
  compose: () => void;
}

let command: StewardsSidebarCommand | null = null;

/** Publish the mounted list's handle, or null when the list unmounts. */
export function setStewardsSidebarCommand(next: StewardsSidebarCommand | null): void {
  command = next;
}

/** The mounted list's handle, or null while the stewards list is not the sidebar. */
export function getStewardsSidebarCommand(): StewardsSidebarCommand | null {
  return command;
}
