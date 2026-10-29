/**
 * Diff data for a multi-repo workspace: what changed, per repo, against each
 * repo's own merge base.
 *
 * The workspace root is not a git repo, so bb's native diff tab never appears
 * and this plugin owns the surface. It does not own the *viewer*:
 * `experimental_Diff` is bb's own, and it already does patch normalization,
 * highlighting, unified/split presentation, gutters and line selection. What
 * is built here is only the data behind it.
 *
 * Deliberately not built: diff tiering, pagination, list virtualization, byte
 * budgeting, patch-section splitting. bb hardens its own diff that way because
 * it has to work on anything; this caps the file count and the per-file patch
 * size instead and says so in the UI.
 */
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import type { ChangedFile, RepoChanges, RepoLiveStatus, RepoTarget } from "./contract.js";
import { gitIn, gitLine } from "./git.js";
import {
  mergeNumstat,
  parseAheadBehind,
  parseNameStatus,
  parseNumstat,
  parsePorcelainCounts,
  splitNul,
  truncatePatch,
} from "./diff-parse.js";

const GIT_TIMEOUT_MS = 60_000;

/**
 * The ref a repo's changes are measured against.
 *
 * `origin/<base>` first, deliberately. It is what the clone actually has, and
 * unlike a local branch of the same name it does not move while the agent
 * works — so the diff a person reads is "everything this thread did", not
 * "everything since the last time someone advanced local main".
 */
export async function resolveBaseRef(
  repoPath: string,
  baseBranch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const options = { timeoutMs: 15_000, ...(signal === undefined ? {} : { signal }) };
  for (const candidate of [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`, baseBranch]) {
    const result = await gitIn(repoPath, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], options);
    if (result.code === 0 && result.stdout.trim().length > 0) return candidate;
  }
  return null;
}

export async function resolveMergeBase(
  repoPath: string,
  baseBranch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const ref = await resolveBaseRef(repoPath, baseBranch, signal);
  if (ref === null) return null;
  return gitLine(repoPath, ["merge-base", "HEAD", ref], {
    timeoutMs: 15_000,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * Everything that changed in one repo since it diverged from its base.
 *
 * Diffing against the merge base rather than the base branch tip is what makes
 * the answer stable: an unrelated commit landing on `main` while the thread
 * runs would otherwise appear as this thread deleting someone else's work.
 *
 * Working tree, not HEAD — an agent mid-task has uncommitted edits, and those
 * are exactly what a person opening the panel wants to see.
 */
export async function repoChanges(
  target: RepoTarget,
  maxFiles: number,
  signal?: AbortSignal,
): Promise<RepoChanges> {
  const options = { timeoutMs: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  const empty = (error: string | null, mergeBase: string | null = null): RepoChanges => ({
    dir: target.dir,
    baseBranch: target.baseBranch,
    mergeBase,
    files: [],
    truncated: false,
    error,
  });

  const mergeBase = await resolveMergeBase(target.path, target.baseBranch, signal);
  if (mergeBase === null) {
    return empty(`No base branch "${target.baseBranch}" in this clone.`);
  }

  const [nameStatus, numstat, untracked] = await Promise.all([
    gitIn(target.path, ["diff", "--name-status", "--find-renames", "-z", mergeBase], options),
    gitIn(target.path, ["diff", "--numstat", "--find-renames", "-z", mergeBase], options),
    gitIn(target.path, ["ls-files", "--others", "--exclude-standard", "-z"], options),
  ]);
  if (nameStatus.code !== 0) {
    return empty(nameStatus.stderr.trim().slice(0, 600) || "git diff failed", mergeBase);
  }

  const tracked = mergeNumstat(
    parseNameStatus(nameStatus.stdout),
    numstat.code === 0 ? parseNumstat(numstat.stdout) : [],
  );
  const untrackedFiles: ChangedFile[] =
    untracked.code === 0
      ? splitNul(untracked.stdout).map((filePath) => ({
          path: filePath,
          status: "untracked" as const,
          oldPath: null,
          additions: null,
          deletions: null,
        }))
      : [];

  const all = [...tracked, ...untrackedFiles];
  return {
    dir: target.dir,
    baseBranch: target.baseBranch,
    mergeBase,
    files: all.slice(0, maxFiles),
    truncated: all.length > maxFiles,
    error: null,
  };
}

/**
 * One file's unified patch.
 *
 * An untracked file has no `HEAD` side, so it takes the `--no-index` path
 * against the null device — `git diff` alone would not mention it at all. That
 * form exits 1 when there *is* a difference, which is the normal case here, so
 * the exit code is not an error signal.
 */
export async function filePatch(args: {
  repoPath: string;
  baseBranch: string;
  file: string;
  untracked: boolean;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<{ patch: string; truncated: boolean; error: string | null }> {
  const options = {
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: args.maxBytes * 2,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  };

  if (args.untracked) {
    const result = await gitIn(
      args.repoPath,
      ["diff", "--no-index", "--no-color", "--", nullDevice(), args.file],
      options,
    );
    // 0 = identical (an empty new file), 1 = differs. Anything else is a real
    // failure, most often a file that vanished between listing and reading.
    if (result.code !== 0 && result.code !== 1) {
      return { patch: "", truncated: false, error: result.stderr.trim().slice(0, 600) || "git diff failed" };
    }
    const cut = truncatePatch(result.stdout, args.maxBytes);
    return { ...cut, error: null };
  }

  const mergeBase = await resolveMergeBase(args.repoPath, args.baseBranch, args.signal);
  if (mergeBase === null) {
    return { patch: "", truncated: false, error: `No base branch "${args.baseBranch}" in this clone.` };
  }
  const result = await gitIn(
    args.repoPath,
    ["diff", "--no-color", "--find-renames", mergeBase, "--", args.file],
    options,
  );
  if (result.code !== 0) {
    return { patch: "", truncated: false, error: result.stderr.trim().slice(0, 600) || "git diff failed" };
  }
  const cut = truncatePatch(result.stdout, args.maxBytes);
  return { ...cut, error: null };
}

/**
 * The null device, for `git diff --no-index`.
 *
 * Git accepts the POSIX spelling on Windows too — it is special-cased inside
 * git rather than resolved by the OS — but `nul` is what a Windows git
 * actually documents, so this picks by platform rather than assuming.
 */
function nullDevice(): string {
  return process.platform === "win32" ? "nul" : path.posix.join("/dev", "null");
}

/** The link target of a symlinked path, as written, or null for anything else. */
async function linkTarget(target: string): Promise<string | null> {
  try {
    if (!(await lstat(target)).isSymbolicLink()) return null;
    return await readlink(target);
  } catch {
    return null;
  }
}

/** Branch, divergence and working-tree counts, for the panel's repo headers. */
export async function repoLiveStatus(target: RepoTarget, signal?: AbortSignal): Promise<RepoLiveStatus> {
  const options = { timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) };
  // A linked `.bb` (the primary layout) sits inside the primary clone, so git
  // run in it would report that whole clone again under this row. Say where
  // it points instead; the primary's own row carries the counts.
  const link = await linkTarget(target.path);
  if (link !== null) {
    return { dir: target.dir, branch: null, ahead: 0, behind: 0, dirty: 0, untracked: 0, error: `Linked to ${link}.` };
  }
  const branch = await gitLine(target.path, ["rev-parse", "--abbrev-ref", "HEAD"], options);
  if (branch === null) {
    return {
      dir: target.dir,
      branch: null,
      ahead: 0,
      behind: 0,
      dirty: 0,
      untracked: 0,
      error: "Not a git repo on disk.",
    };
  }
  const baseRef = await resolveBaseRef(target.path, target.baseBranch, signal);
  const [counts, divergence] = await Promise.all([
    gitIn(target.path, ["status", "--porcelain=v1", "-z"], options),
    baseRef === null
      ? Promise.resolve(null)
      : gitIn(target.path, ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`], options),
  ]);
  const { dirty, untracked } = counts.code === 0 ? parsePorcelainCounts(counts.stdout) : { dirty: 0, untracked: 0 };
  const { ahead, behind } =
    divergence !== null && divergence.code === 0
      ? parseAheadBehind(divergence.stdout)
      : { ahead: 0, behind: 0 };
  return {
    dir: target.dir,
    branch,
    ahead,
    behind,
    dirty,
    untracked,
    error: baseRef === null ? `No base branch "${target.baseBranch}" in this clone.` : null,
  };
}
