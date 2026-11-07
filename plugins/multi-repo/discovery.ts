/**
 * Finding the git checkouts this machine already has.
 *
 * Two jobs, one mechanism. A checkout whose `origin` matches a repo in the set
 * is a **local mirror** the object cache can be seeded from, turning a cold
 * network clone into a hardlinking local one. And the same list is what the
 * Repos panel offers as suggestions. It is never written into `repos.json`
 * on its own: a project whose repo set is empty gets a workspace holding only
 * its project source, not whatever else happens to be checked out next to it.
 *
 * The candidate paths come from bb's own registry rather than from a disk
 * walk: `bb.sdk.projects.list()` returns every project with its `sources[]`,
 * each a `local_path` carrying `{ hostId, path }`. One call enumerates every
 * checkout bb knows about on this machine. A configurable search root and the
 * project-source directory's siblings fill in the rest.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { DiscoveredCheckout } from "./contract.js";
import { gitLine } from "./git.js";

/** A search root is scanned one level deep — the `~/src/<repo>` convention. */
const MAX_ROOT_ENTRIES = 200;

async function originOf(dir: string, signal?: AbortSignal): Promise<string | null> {
  const url = await gitLine(dir, ["config", "--get", "remote.origin.url"], {
    timeoutMs: 10_000,
    ...(signal === undefined ? {} : { signal }),
  });
  if (url === null || url.length === 0) return null;
  // `git -C <dir>` answers from an ancestor when `dir` is not itself a repo,
  // so confirm the directory is the repo's own top level before believing it.
  const top = await gitLine(dir, ["rev-parse", "--show-toplevel"], {
    timeoutMs: 10_000,
    ...(signal === undefined ? {} : { signal }),
  });
  if (top === null) return null;
  return path.resolve(top) === path.resolve(dir) ? url : null;
}

export async function discoverCheckouts(args: {
  paths: readonly string[];
  searchRoots: readonly string[];
  signal?: AbortSignal;
}): Promise<DiscoveredCheckout[]> {
  const candidates = new Set(args.paths.map((entry) => path.resolve(entry)));

  for (const root of args.searchRoots) {
    let entries: string[] = [];
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .slice(0, MAX_ROOT_ENTRIES)
        .map((entry) => path.join(root, entry.name));
    } catch {
      continue;
    }
    for (const entry of entries) candidates.add(path.resolve(entry));
  }

  const found: DiscoveredCheckout[] = [];
  for (const candidate of candidates) {
    if (args.signal?.aborted === true) break;
    const url = await originOf(candidate, args.signal);
    if (url !== null) found.push({ path: candidate, url });
  }
  return found;
}
