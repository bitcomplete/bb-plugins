// The data-profile switch sequence: activate the profile through the
// plugin's own RPC, then ask the router to roll this server onto it, then
// hand over to the update store's restart follow-through so the page reloads
// onto the gate's starting page. Kept out of app.tsx so it can be tested
// without a DOM, alongside server-update.ts.
import { followRestart, gateStatus, RESTART_PATH, type UpdateStoreDeps } from "./server-update.js";

export interface SwitchDeps extends UpdateStoreDeps {
  activate: (name: string) => Promise<{ booted: boolean }>;
}

// switchProfile activates name, restarts the server onto it and follows the
// restart. previous is the profile the server is running now: if the restart
// is refused or unreachable, the file is put back so a later, unrelated
// restart does not silently land the developer on the new data set.
export async function switchProfile(deps: SwitchDeps, name: string, previous: string): Promise<void> {
  const { booted } = await deps.activate(name);
  // A never-started profile opens on Team setup once, as a brand-new server
  // does; a profile that has booted keeps its own state and never redirects.
  const url = booted ? RESTART_PATH : `${RESTART_PATH}?first_visit=1`;
  let response: Response;
  try {
    response = await deps.fetch(url, { method: "POST", headers: { Accept: "application/json" } });
  } catch (error) {
    await restoreActive(deps, previous);
    throw error;
  }
  if (!response.ok) {
    await restoreActive(deps, previous);
    throw new Error(`bb-gate answered ${response.status}`);
  }
  await followRestart(deps, () => gateStatus(deps.fetch));
}

// restoreActive is best effort: the restart may have failed before the
// activate call was observed, or the RPC may be unreachable; the next boot
// still falls back to default rather than stranding the server.
async function restoreActive(deps: SwitchDeps, previous: string): Promise<void> {
  try {
    await deps.activate(previous);
  } catch {
    // Leave the file as it is; the entrypoint falls back to default if it is
    // unreadable or names a missing profile.
  }
}
