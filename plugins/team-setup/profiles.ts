// The server side of data profiles: the filesystem layout the bb-gate
// entrypoint sets up. The volume root is the `default` profile's data dir
// and every other profile lives under profiles/<name>; active-profile at the
// root names the active one. Everything here treats a profile name as a path
// segment only after the DNS-label check, resolves the path inside the
// profiles directory, and never follows a symlink out of the tree.
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DEFAULT_PROFILE, PROFILE_NAME_MAX, type ProfileRow, validProfileName } from "./profiles-name.js";

export interface ProfilesLayout {
  profilesDir: string;
  activeProfileFile: string;
}

// profilesLayout returns the two paths the entrypoint exports, or null on a
// server that does not have the layout (not behind bb-gate, or an older
// image). The RPCs are registered only when it is non-null.
export function profilesLayout(env: Record<string, string | undefined>): ProfilesLayout | null {
  const profilesDir = env.BB_GATE_PROFILES_DIR?.trim();
  const activeProfileFile = env.BB_GATE_ACTIVE_PROFILE_FILE?.trim();
  if (!profilesDir || !activeProfileFile) return null;
  return { profilesDir, activeProfileFile };
}

function assertName(name: string): void {
  if (!validProfileName(name)) {
    throw new Error(`"${name}" is not a lowercase DNS label of 1 to ${PROFILE_NAME_MAX} characters`);
  }
}

// profileDir is the data dir for name: the volume root for `default`, and
// profilesDir/name otherwise. assertName guarantees the name cannot contain a
// slash or `..`, so it stays one segment below profilesDir.
export function profileDir(layout: ProfilesLayout, name: string): string {
  assertName(name);
  if (name === DEFAULT_PROFILE) return resolve(layout.profilesDir, "..");
  return join(resolve(layout.profilesDir), name);
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

// resolvesInside reports whether dir resolves to a path inside profilesDir.
// A symlink pointing elsewhere is not inside.
async function resolvesInside(layout: ProfilesLayout, dir: string): Promise<boolean> {
  const root = await realpath(layout.profilesDir).catch(() => null);
  if (root === null) return false;
  const target = await realpath(dir).catch(() => null);
  if (target === null) return false;
  return inside(root, target);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// readActiveProfile is the active name, falling back to `default` for a
// missing, unreadable or invalid file, or a profile whose directory is gone
// or resolves outside the tree.
export async function readActiveProfile(layout: ProfilesLayout): Promise<string> {
  let raw: string;
  try {
    raw = (await readFile(layout.activeProfileFile, "utf8")).trim();
  } catch {
    return DEFAULT_PROFILE;
  }
  if (!validProfileName(raw) || raw === DEFAULT_PROFILE) return DEFAULT_PROFILE;
  if (!(await resolvesInside(layout, profileDir(layout, raw)))) return DEFAULT_PROFILE;
  return raw;
}

// dirSize sums regular files under dir, skipping symlinks (never following
// them) and any entry named in skip.
async function dirSize(dir: string, skip: ReadonlySet<string> = new Set()): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (skip.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(path);
    } else if (entry.isFile()) {
      try {
        total += (await stat(path)).size;
      } catch {
        // Vanished between readdir and stat.
      }
    }
  }
  return total;
}

// listProfiles reports the active profile and every profile with its booted
// state and size. `default` is the volume root, and its size leaves
// profiles/ out so it does not include the other profiles.
export async function listProfiles(layout: ProfilesLayout): Promise<{ active: string; profiles: ProfileRow[] }> {
  const active = await readActiveProfile(layout);
  const names = new Set<string>([DEFAULT_PROFILE, active]);
  try {
    for (const entry of await readdir(layout.profilesDir, { withFileTypes: true })) {
      if (entry.name === DEFAULT_PROFILE || !validProfileName(entry.name)) continue;
      if (!(await resolvesInside(layout, join(resolve(layout.profilesDir), entry.name)))) continue;
      names.add(entry.name);
    }
  } catch {
    // No profiles directory yet: default alone.
  }
  const profiles = await Promise.all(
    [...names].map(async (name): Promise<ProfileRow> => {
      const dir = profileDir(layout, name);
      return {
        name,
        booted: await exists(join(dir, "bb.db")),
        bytes: name === DEFAULT_PROFILE ? await dirSize(dir, new Set(["profiles"])) : await dirSize(dir),
      };
    }),
  );
  // Active first, then by name, so the list is stable across a switch.
  profiles.sort((a, b) => (a.name === active ? -1 : b.name === active ? 1 : a.name.localeCompare(b.name)));
  return { active, profiles };
}

export async function createProfile(layout: ProfilesLayout, name: string): Promise<ProfileRow> {
  assertName(name);
  if (name === DEFAULT_PROFILE) throw new Error(`the "${DEFAULT_PROFILE}" profile already exists`);
  const dir = profileDir(layout, name);
  if (await exists(dir)) throw new Error(`a profile named "${name}" already exists`);
  await mkdir(resolve(layout.profilesDir), { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`a profile named "${name}" already exists`);
    throw error;
  }
  return { name, booted: false, bytes: 0 };
}

export async function deleteProfile(layout: ProfilesLayout, name: string): Promise<{ ok: true }> {
  assertName(name);
  if (name === DEFAULT_PROFILE) throw new Error(`the "${DEFAULT_PROFILE}" profile cannot be deleted`);
  if (name === (await readActiveProfile(layout))) throw new Error(`"${name}" is the active profile`);
  const dir = profileDir(layout, name);
  let info;
  try {
    info = await lstat(dir);
  } catch {
    throw new Error(`no profile named "${name}"`);
  }
  if (info.isSymbolicLink()) {
    // Remove the link itself, never what it points at.
    await unlink(dir);
  } else if (info.isDirectory()) {
    await rm(dir, { recursive: true, force: true });
  } else {
    await unlink(dir);
  }
  return { ok: true };
}

export async function activateProfile(layout: ProfilesLayout, name: string): Promise<{ booted: boolean }> {
  assertName(name);
  const dir = profileDir(layout, name);
  if (name !== DEFAULT_PROFILE && !(await resolvesInside(layout, dir))) {
    throw new Error(`no profile named "${name}"`);
  }
  const booted = await exists(join(dir, "bb.db"));
  await writeFile(layout.activeProfileFile, `${name}\n`);
  return { booted };
}
