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
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { git, gitIn, gitLine, gitOrThrow, firstProblemLine, run, type RunOptions } from "./git.js";
import { withLock } from "./lock.js";
import { cacheKeyForUrl, normalizeRemoteUrl } from "./paths.js";

export const CACHE_DIR_NAME = "repos";
const FETCHED_MARKER = "bb-fetched-at";
const CLONE_TIMEOUT_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
const TEMPLATE_TIMEOUT_MS = 30 * 60 * 1000;
const COPY_TIMEOUT_MS = 10 * 60 * 1000;
/** A clone can run for half an hour; the lock must outlive it, not it the lock. */
const LOCK_STALE_MS = 120_000;
/** The suffix of the directory holding this entry's template trees. */
export const TREE_DIR_SUFFIX = ".tree";

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
  return withCache(args, async (cache) => cache);
}

/**
 * Acquire the entry's lock, bring it up to date, and run `body` with it.
 *
 * `body` runs while the lock is held, which is what lets a caller refresh the
 * template and copy from it without another materialize or a sweep resetting
 * the template underneath the copy.
 */
export async function withCache<T>(
  args: EnsureCacheArgs,
  body: (cache: CacheRef) => Promise<T>,
): Promise<T> {
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
    async () => body(await ensureCacheLocked(args, repoPath, key)),
  );
}

/** The cache work itself; the caller holds the entry lock. */
async function ensureCacheLocked(args: EnsureCacheArgs, repoPath: string, key: string): Promise<CacheRef> {
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

/**
 * `<cacheRoot>/<key>.tree`: one template working tree per base branch.
 *
 * The template is a normal `--shared` clone of the bare cache, checked out at
 * its base branch and never worked in. A workspace repo is a reflink copy of
 * it, so the per-thread cost is metadata rather than a fresh checkout.
 */
export function templateRoot(dataDir: string, url: string): string {
  const { key } = cachePathFor(dataDir, url);
  return path.join(cacheRoot(dataDir), `${key}${TREE_DIR_SUFFIX}`);
}

/**
 * A branch name as one path segment.
 *
 * A branch is a ref name and may contain `/`, but a template must be a direct
 * child of the tree root: with a nested path, the templates for `main` and
 * `main/next` would sit inside one another and a copy of `main` would carry
 * `main/next`'s files. Encoding is reversible, so the sweep can name the
 * branch again; `main` and every other slashless branch are unchanged.
 */
function templateDirName(base: string): string {
  return encodeURIComponent(base);
}

function baseFromTemplateDirName(name: string): string | null {
  try {
    const decoded = decodeURIComponent(name);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** Where the template for `base` lives. Exported for tests and diagnostics. */
export function templatePathFor(dataDir: string, url: string, base: string): string {
  return path.join(templateRoot(dataDir, url), templateDirName(base));
}

const reflinkProbes = new Map<string, Promise<boolean>>();

/**
 * Whether `cp --reflink=always` can copy from the cache root into the
 * workspace root, decided once per process per (cache root, workspace root)
 * pair by actually trying it.
 *
 * Reflinks only work within one filesystem/pool, so a machine that puts
 * workspaces somewhere other than `host-data` falls back to a normal clone.
 * Memoizing the answer keeps the probe off every thread start.
 */
export function reflinkSupported(cacheRootPath: string, workspaceRootPath: string): Promise<boolean> {
  const memoKey = `${cacheRootPath}\0${workspaceRootPath}`;
  const known = reflinkProbes.get(memoKey);
  if (known !== undefined) return known;
  const probe = probeReflink(cacheRootPath, workspaceRootPath);
  reflinkProbes.set(memoKey, probe);
  return probe;
}

async function probeReflink(cacheRootPath: string, workspaceRootPath: string): Promise<boolean> {
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const source = path.join(cacheRootPath, `.reflink-probe-${token}`);
  const target = path.join(workspaceRootPath, `.reflink-probe-${token}`);
  const content = "bb-reflink-probe\n";
  try {
    await mkdir(cacheRootPath, { recursive: true });
    await mkdir(workspaceRootPath, { recursive: true });
    await writeFile(source, content, "utf8");
    const result = await run("cp", ["-a", "--reflink=always", "--", source, target], { timeoutMs: 30_000 });
    if (result.code !== 0) return false;
    return (await readFile(target, "utf8")) === content;
  } catch {
    // No `cp`, no permission, no such filesystem: all mean "fall back".
    return false;
  } finally {
    await rm(source, { force: true }).catch(() => undefined);
    await rm(target, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function isGitWorktree(dir: string, options: RunOptions): Promise<boolean> {
  return (await gitLine(dir, ["rev-parse", "--is-inside-work-tree"], options)) === "true";
}

/** A template is usable only when HEAD is exactly `sha` and the tree is clean. */
async function templateIsAt(template: string, sha: string, options: RunOptions): Promise<boolean> {
  if ((await gitLine(template, ["rev-parse", "HEAD"], options)) !== sha) return false;
  return (await gitLine(template, ["status", "--porcelain"], options)) === "";
}

/**
 * Make the template for `base` a clean checkout of the cache's current
 * `refs/heads/<base>` and return its path, or null when that is not possible.
 *
 * **The caller must hold the entry lock.** A reset here and a copy made from
 * the returned path must not interleave with another materialize or a sweep,
 * or a workspace could observe a half-refreshed template.
 *
 * A template that is missing, dirty or behind the cache is brought back with
 * `reset --hard` + `clean -fdx`; a template that does not verify after that is
 * rebuilt from scratch, never repaired field by field.
 */
export async function ensureTemplate(args: {
  dataDir: string;
  url: string;
  cachePath: string;
  base: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const options: RunOptions = {
    timeoutMs: TEMPLATE_TIMEOUT_MS,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  };
  const template = templatePathFor(args.dataDir, args.url, args.base);
  const sha = await gitLine(args.cachePath, ["rev-parse", "--verify", `refs/heads/${args.base}^{commit}`], {
    timeoutMs: 15_000,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (sha === null) return null;

  // `core.checkStat=minimal` is set before the first `git status`, so even
  // the template's own status trusts size and mtime rather than rehashing the
  // tree. It lives in the template's config and every copy inherits it.
  const minimal = () => gitIn(template, ["config", "core.checkStat", "minimal"], options);

  let usable = false;
  if (await isGitWorktree(template, options)) {
    await minimal();
    usable = await templateIsAt(template, sha, options);
    if (!usable) {
      await gitIn(template, ["reset", "--hard", "--quiet", sha], options);
      await gitIn(template, ["clean", "-fdx", "--quiet"], options);
      usable = await templateIsAt(template, sha, options);
    }
  }
  if (!usable) {
    await rm(template, { recursive: true, force: true });
    await mkdir(path.dirname(template), { recursive: true });
    const cloned = await git(
      ["clone", "--shared", "--quiet", "--branch", args.base, args.cachePath, template],
      options,
    );
    if (cloned.code !== 0) return null;
    await minimal();
    usable = await templateIsAt(template, sha, options);
    if (!usable) return null;
  }
  return template;
}

/**
 * Copy a prepared template to `dest` as a reflink clone.
 *
 * **The caller must hold the entry lock**, so the template cannot be reset
 * while it is being copied. Returns false when `cp` refuses (the probe said
 * reflinks work but the copy hit a file it could not share), with nothing left
 * at `dest` for the caller's clone fallback to trip over.
 */
export async function copyTemplate(template: string, dest: string, signal?: AbortSignal): Promise<boolean> {
  const result = await run("cp", ["-a", "--reflink=always", "--", template, dest], {
    timeoutMs: COPY_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.code === 0) return true;
  await rm(dest, { recursive: true, force: true }).catch(() => undefined);
  return false;
}

/**
 * Reset every template that already exists for this cache entry.
 *
 * Called by the background sweep under the entry lock. It **creates none**: a
 * branch no thread has requested yet is not the sweep's business, and building
 * it would pay a checkout on a machine that may never open a thread on it.
 */
async function resetTemplates(args: {
  dataDir: string;
  url: string;
  cachePath: string;
  signal?: AbortSignal;
}): Promise<void> {
  const root = templateRoot(args.dataDir, args.url);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  const options: RunOptions = {
    timeoutMs: 10 * 60 * 1000,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  };
  for (const entry of entries) {
    const base = baseFromTemplateDirName(entry);
    if (base === null) continue;
    const template = path.join(root, entry);
    if (!(await isGitWorktree(template, options))) continue;
    const sha = await gitLine(args.cachePath, ["rev-parse", "--verify", `refs/heads/${base}^{commit}`], options);
    if (sha === null) continue;
    await gitIn(template, ["reset", "--hard", "--quiet", sha], options);
    await gitIn(template, ["clean", "-fdx", "--quiet"], options);
    await gitIn(template, ["config", "core.checkStat", "minimal"], options);
  }
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
 * The background sweep: fetch every entry older than `maxAgeMs` and reset the
 * templates it finds.
 *
 * Only touches entries that already exist. A repo nobody has cloned yet is not
 * this sweep's business — cloning it here would pay a cold start on a machine
 * that may never open a thread on that project. The same rule applies to
 * templates: the sweep resets the ones a thread has already asked for and
 * creates none.
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
    const fresh = fetchedAt !== null && Date.now() - fetchedAt < maxAgeMs;
    try {
      // The reset of existing templates runs under the same lock as the fetch
      // and as every materialize, so a copy can never observe a half-refreshed
      // template. A fresh entry still gets its templates reset — the sweep is
      // what keeps a cold start down to the delta.
      const entry = await withCache(
        { dataDir, url, mirrors: [], fetchTtlMs: maxAgeMs, ...(signal === undefined ? {} : { signal }) },
        async (cache) => {
          await resetTemplates({ dataDir, url, cachePath: cache.path, ...(signal === undefined ? {} : { signal }) });
          return cache;
        },
      );
      if (!fresh) await repackCache(repoPath, signal);
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
