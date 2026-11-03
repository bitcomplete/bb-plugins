// The data-profile switch sequence: activate the profile through the
// plugin's own RPC, then ask the router to roll this server onto it, then
// hand over to the update store's restart follow-through so the page reloads
// onto the gate's starting page. Kept out of app.tsx so it can be tested
// without a DOM, alongside server-update.ts.
import { followRestart, gateStatus, RESTART_PATH, type UpdateStoreDeps } from "./server-update.js";

export interface SwitchDeps extends UpdateStoreDeps {
  activate: (name: string) => Promise<{ booted: boolean }>;
}

export async function switchProfile(deps: SwitchDeps, name: string): Promise<void> {
  const { booted } = await deps.activate(name);
  // A never-started profile opens on Team setup once, as a brand-new server
  // does; a profile that has booted keeps its own state and never redirects.
  const url = booted ? RESTART_PATH : `${RESTART_PATH}?first_visit=1`;
  const r = await deps.fetch(url, { method: "POST", headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`bb-gate answered ${r.status}`);
  await followRestart(deps, () => gateStatus(deps.fetch));
}
