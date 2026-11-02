/**
 * The per-machine object cache: one bare repo per remote, shared by every
 * workspace on the machine.
 *
 * A cold start is a full network clone per repo, once per machine. Everything
 * here exists to make that the only time it happens — the second thread on the
 * same project resolves its objects from a local bare repo and pays a delta
 * fetch, and a machine that already has a checkout of the repo pays no network
 * at all for the bulk of the objects.
 *
 * Two rules the implementation is built around:
 *
 * **The cache must be self-contained.** It is never seeded with
 * `--shared`/`--reference` from a user's checkout. A plain `git clone --bare`
 * of a local path already hardlinks the object files — the speed was never the
 * reason to use alternates — and hardlinks survive the user deleting or
 * garbage-collecting the checkout they came from. Alternates belong only on
 * the workspace→cache hop, where this plugin owns both ends.
 *
 * **Always fetch from the real remote after mirroring.** A local checkout
 * carries stale refs and branches that exist nowhere else, so the mirror is a
 * head start on the objects, never an answer about the refs.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { git, gitIn, gitLine, gitOrThrow, firstProblemLine } from "./git.js";
import { withLock } from "./lock.js";
import { cacheKeyForUrl, normalizeRemoteUrl } from "./paths.js";

export const CACHE_DIR_NAME = "repos";
const FETCHED_MARKER = "bb-fetched-at";
const CLONE_TIMEOUT_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
/** A clone can run for half an hour; the lock must outlive it, not it the lock. */
const LOCK_STALE_MS = 120_000;

export interface CacheProgress {
  step(text: string): void;
  log(text: string): void;
}

export interface CacheRef {
  key: string;
  path: string;
  /** Epoch ms of the last successful fetch from the real remote. */
  fetchedAt: number | null;
}

export function cacheRoot(dataDir: string): string {
  return path.join(dataDir, CACHE_DIR_NAME);
}

export function cachePathFor(dataDir: string, url: string): { key: string; path: string } {
  const key = cacheKeyForUrl(url);
  return { key, path: path.join(cacheRoot(dataDir), `${key}.git`) };
}

async function readFetchedAt(repoPath: string): Promise<number | null> {
  try {
    const raw = await readFile(path.join(repoPath, FETCHED_MARKER), "utf8");
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeFetchedAt(repoPath: string, at: number): Promise<void> {
  await writeFile(path.join(repoPath, FETCHED_MARKER), String(at), "utf8");
}

async function isBareRepo(repoPath: string): Promise<boolean> {
  const answer = await gitLine(repoPath, ["rev-parse", "--is-bare-repository"], { timeoutMs: 10_000 });
  return answer === "true";
}

/**
 * Settings every cache repo carries, applied on creation and re-applied on
 * every use so a repo made by an older version of this plugin gains them.
 *
 * The gc settings are not a tuning choice. Workspace clones point their
 * `objects/info/alternates` at this repo, and an automatic `gc` here can prune
 * an object that only a borrowing clone still references — the borrower is
 * invisible to gc. Disabling automatic gc and never expiring loose objects
 * makes that impossible; {@link repackCache} is the deliberate, safe
 * alternative.
 */
async function configureCache(repoPath: string, url: string, signal?: AbortSignal): Promise<void> {
  const options = { timeoutMs: 15_000, ...(signal === undefined ? {} : { signal }) };
  await gitIn(repoPath, ["config", "gc.auto", "0"], options);
  await gitIn(repoPath, ["config", "gc.pruneExpire", "never"], options);
  await gitIn(repoPath, ["config", "gc.reflogExpire", "never"], options);
  await gitIn(repoPath, ["config", "remote.origin.url", url], options);
  // `git clone --bare` copies the branch heads but deliberately creates no
  // fetch refspec, so without this an ordinary `git fetch` here would update
  // nothing. Mirroring heads directly (rather than into `refs/remotes/`) is
  // what lets a workspace clone read `refs/heads/main` from the cache.
  await gitIn(repoPath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], options);
  await gitIn(repoPath, ["config", "remote.origin.tagOpt", "--tags"], options);
}

/** Find a checkout on this machine whose `origin` is the same repo. */
export function findMirror(
  url: string,
  mirrors: readonly { path: string; url: string }[],
): string | null {
  const wanted = normalizeRemoteUrl(url);
  return mirrors.find((candidate) => normalizeRemoteUrl(candidate.url) === wanted)?.path ?? null;
}

export interface EnsureCacheArgs {
  dataDir: string;
  url: string;
  mirrors: readonly { path: string; url: string }[];
  /** Skip the fetch when the last one was more recent than this. */
  fetchTtlMs: number;
  signal?: AbortSignal;
  report?: CacheProgress;
}

/**
 * Bring one cache entry up to date and return where it lives.
 *
 * The whole body runs under the entry's lock: concurrent thread creation
 * against one repo is the normal case, and the loser should wait for the
 * winner's clone rather than start a second one into the same directory.
 */
export async function ensureCache(args: EnsureCacheArgs): Promise<CacheRef> {
  const { key, path: repoPath } = cachePathFor(args.dataDir, args.url);
  await mkdir(cacheRoot(args.dataDir), { recursive: true });
  const lockPath = path.join(cacheRoot(args.dataDir), `${key}.lock`);

  return withLock(
    lockPath,
    {
      staleMs: LOCK_STALE_MS,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
      onWait: () => args.report?.log(`Waiting for another thread to finish caching ${args.url}`),
    },
    async () => {
      const present = await isBareRepo(repoPath);
      if (!present) {
        // A directory that exists but is not a bare repo is the debris of an
        // interrupted clone. Nothing in it is worth keeping.
        await rm(repoPath, { recursive: true, force: true });
        await cloneCache({ ...args, repoPath, key });
      }
      await configureCache(repoPath, args.url, args.signal);

      const fetchedAt = await readFetchedAt(repoPath);
      const fresh = fetchedAt !== null && Date.now() - fetchedAt < args.fetchTtlMs;
      if (fresh) return { key, path: repoPath, fetchedAt };

      args.report?.step(`Fetching ${args.url}`);
      const result = await git(["-C", repoPath, "fetch", "--prune", "--quiet", "origin"], {
        timeoutMs: FETCH_TIMEOUT_MS,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      });
      if (result.code !== 0) {
        // A stale cache still clones. Report and carry on rather than failing
        // the whole environment because a remote was briefly unreachable —
        // unless there is nothing cached at all, which `cloneCache` above
        // would already have thrown for.
        args.report?.log(`Could not fetch ${args.url}: ${firstProblemLine(result)}`);
        return { key, path: repoPath, fetchedAt };
      }
      const now = Date.now();
      await writeFetchedAt(repoPath, now);
      return { key, path: repoPath, fetchedAt: now };
    },
  );
}

async function cloneCache(args: EnsureCacheArgs & { repoPath: string; key: string }): Promise<void> {
  const mirror = findMirror(args.url, args.mirrors);
  const signalOption = args.signal === undefined ? {} : { signal: args.signal };
  if (mirror !== null) {
    args.report?.step(`Copying ${args.url} from ${mirror}`);
    const local = await git(["clone", "--bare", "--quiet", "--", mirror, args.repoPath], {
      timeoutMs: CLONE_TIMEOUT_MS,
      ...signalOption,
    });
    if (local.code === 0) {
      // Deliberately no fetched-at marker: the refs came from a checkout, not
      // from the remote, so the caller's fetch below is not optional.
      return;
    }
    args.report?.log(`Local copy failed (${firstProblemLine(local)}); cloning from the remote instead`);
    await rm(args.repoPath, { recursive: true, force: true });
  }

  args.report?.step(`Cloning ${args.url}`);
  await gitOrThrow(["clone", "--bare", "--quiet", "--", args.url, args.repoPath], {
    timeoutMs: CLONE_TIMEOUT_MS,
    ...signalOption,
  });
}

/** The branch a clone of this cache entry should start from. */
export async function cacheDefaultBranch(repoPath: string, signal?: AbortSignal): Promise<string | null> {
  const options = { timeoutMs: 10_000, ...(signal === undefined ? {} : { signal }) };
  const head = await gitLine(repoPath, ["symbolic-ref", "--short", "HEAD"], options);
  if (head !== null && head.length > 0 && (await cacheHasBranch(repoPath, head, signal))) return head;
  // A HEAD pointing at a branch that does not exist happens when the remote
  // renamed its default. Take whatever the mirror actually has.
  const first = await gitLine(repoPath, ["for-each-ref", "--count=1", "--format=%(refname:short)", "refs/heads/"], options);
  return first !== null && first.length > 0 ? first : null;
}

export async function cacheHasBranch(repoPath: string, branch: string, signal?: AbortSignal): Promise<boolean> {
  const result = await gitIn(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    timeoutMs: 10_000,
    ...(signal === undefined ? {} : { signal }),
  });
  return result.code === 0;
}

/** Pack size in bytes from `git count-objects`, which is cheap; null if unknown. */
async function cacheSizeBytes(repoPath: string): Promise<number | null> {
  const raw = await gitLine(repoPath, ["count-objects", "-v"], { timeoutMs: 15_000 });
  if (raw === null) return null;
  let total = 0;
  let seen = false;
  for (const line of raw.split("\n")) {
    const match = /^(size|size-pack):\s+(\d+)$/u.exec(line.trim());
    if (match !== null) {
      total += Number.parseInt(match[2], 10) * 1024;
      seen = true;
    }
  }
  return seen ? total : null;
}

export interface CacheStatusEntry {
  key: string;
  url: string;
  present: boolean;
  fetchedAt: number | null;
  sizeBytes: number | null;
  error: string | null;
}

export async function cacheStatus(dataDir: string, urls: readonly string[]): Promise<CacheStatusEntry[]> {
  const entries: CacheStatusEntry[] = [];
  for (const url of urls) {
    const { key, path: repoPath } = cachePathFor(dataDir, url);
    try {
      await stat(repoPath);
    } catch {
      entries.push({ key, url, present: false, fetchedAt: null, sizeBytes: null, error: null });
      continue;
    }
    entries.push({
      key,
      url,
      present: true,
      fetchedAt: await readFetchedAt(repoPath),
      sizeBytes: await cacheSizeBytes(repoPath),
      error: null,
    });
  }
  return entries;
}

/**
 * The background sweep: fetch every entry older than `maxAgeMs`.
 *
 * Only touches entries that already exist. A repo nobody has cloned yet is not
 * this sweep's business — cloning it here would pay a cold start on a machine
 * that may never open a thread on that project.
 */
export async function refreshCaches(
  dataDir: string,
  urls: readonly string[],
  maxAgeMs: number,
  signal?: AbortSignal,
): Promise<CacheStatusEntry[]> {
  const results: CacheStatusEntry[] = [];
  for (const url of urls) {
    if (signal?.aborted === true) break;
    const { key, path: repoPath } = cachePathFor(dataDir, url);
    if (!(await isBareRepo(repoPath))) {
      results.push({ key, url, present: false, fetchedAt: null, sizeBytes: null, error: null });
      continue;
    }
    const fetchedAt = await readFetchedAt(repoPath);
    if (fetchedAt !== null && Date.now() - fetchedAt < maxAgeMs) {
      results.push({ key, url, present: true, fetchedAt, sizeBytes: null, error: null });
      continue;
    }
    try {
      const entry = await ensureCache({ dataDir, url, mirrors: [], fetchTtlMs: maxAgeMs, ...(signal === undefined ? {} : { signal }) });
      await repackCache(repoPath, signal);
      results.push({ key, url, present: true, fetchedAt: entry.fetchedAt, sizeBytes: null, error: null });
    } catch (error) {
      results.push({
        key,
        url,
        present: true,
        fetchedAt,
        sizeBytes: null,
        error: error instanceof Error ? error.message.slice(0, 600) : String(error),
      });
    }
  }
  return results;
}

/**
 * Repack a cache entry without pruning.
 *
 * `--no-prune` is the whole point: loose objects here may be the only copy a
 * borrowing workspace clone has, and this repo cannot see those borrowers.
 * Packing them is safe; deleting them is not.
 */
export async function repackCache(repoPath: string, signal?: AbortSignal): Promise<void> {
  await gitIn(repoPath, ["gc", "--no-prune", "--quiet"], {
    timeoutMs: 10 * 60 * 1000,
    ...(signal === undefined ? {} : { signal }),
  });
}
