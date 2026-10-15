/**
 * Materializing and tearing down a thread workspace.
 *
 * The root is a **plain directory**, not a git repo. That is a supported shape
 * (`environment-personal-workspace` already ships one),
 * `getAdditionalWorkspaceWriteRoots()` returns `[]` for it, and everything the
 * agent touches sits under `cwd` — so the whole workspace is writable under
 * `accept-edits`/`auto` without asking for the `full` permission mode. It is
 * also exactly where bb looks for `<workspace>/.bb/AGENTS.md` and
 * `<workspace>/.bb/skills`, which are plain path joins with no git requirement.
 *
 * **Never create `<root>/.git`.** bb's workspace status watcher promotes the
 * environment to git mode the moment one appears, which would switch on a
 * misleading native diff tab mid-session. The check is root-relative, so the
 * nested `.git` inside each repo is safe — and it has to be, because that is
 * the whole reason these are clones rather than worktrees: `git worktree add`
 * leaves the object store in the source repo, outside `cwd`, where every
 * commit would fail on a sandboxed write.
 */
import { mkdir, readdir, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { experimental_killProcessesWithCwdUnder as killProcessesUnder } from "@get-bb/plugin-sdk/host";
import { cacheDefaultBranch, cacheHasBranch, ensureCache, type CacheProgress } from "./cache.js";
import { git, gitIn, gitLine, firstProblemLine } from "./git.js";
import type { RepoRequest } from "./contract.js";
import type { WorkspaceRepo } from "./layout.js";
import { PROJECT_SOURCE_DIR, assertSafeSegment } from "./paths.js";

export const WORKSPACES_DIR_NAME = "workspaces";
export const STATE_DIR_NAME = "workspace-state";
const CLONE_TIMEOUT_MS = 30 * 60 * 1000;
const GIT_TIMEOUT_MS = 60_000;

export function workspaceRoot(dataDir: string, pathKey: string): string {
  return path.join(dataDir, WORKSPACES_DIR_NAME, assertSafeSegment(pathKey, "The workspace path key"));
}

/**
 * Per-repo completion markers, kept *outside* the workspace.
 *
 * `create()` must be idempotent for a path key — core calls it again with the
 * same key after a process restart — so a repo that finished last time is
 * skipped this time. The markers live beside the workspace rather than in it
 * because the workspace root is the agent's working directory, and a handful
 * of `bb-dylan.completed` files in `ls` is a confusing thing to hand someone.
 */
export function stateDir(dataDir: string, pathKey: string): string {
  return path.join(dataDir, STATE_DIR_NAME, assertSafeSegment(pathKey, "The workspace path key"));
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function markCompleted(dataDir: string, pathKey: string, dir: string): Promise<void> {
  const markers = stateDir(dataDir, pathKey);
  await mkdir(markers, { recursive: true });
  await writeFile(path.join(markers, `${dir}.completed`), String(Date.now()), "utf8");
}

async function isCompleted(dataDir: string, pathKey: string, dir: string): Promise<boolean> {
  return exists(path.join(stateDir(dataDir, pathKey), `${dir}.completed`));
}

/**
 * Pick a branch name that does not already exist in the clone.
 *
 * Every work repo takes the same name — `context.suggestedBranchName`, which
 * is bb's own name for this thread — so pull requests across repos correlate
 * by head ref and plugin branches read like native ones. The symmetry is a
 * convenience rather than an invariant, so a collision falls back per repo
 * instead of failing the repo.
 */
async function pickBranchName(repoPath: string, wanted: string, dir: string): Promise<string> {
  const candidates = [wanted, `${wanted}-${dir}`, ...[2, 3, 4, 5].map((n) => `${wanted}-${n}`)];
  for (const candidate of candidates) {
    const taken = await gitIn(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], {
      timeoutMs: 10_000,
    });
    if (taken.code !== 0) return candidate;
  }
  return `${wanted}-${Date.now().toString(36)}`;
}

export interface MaterializeArgs {
  dataDir: string;
  pathKey: string;
  root: string;
  repo: RepoRequest;
  branchName: string;
  fetchTtlMs: number;
  mirrors: readonly { path: string; url: string }[];
  report?: CacheProgress;
  signal?: AbortSignal;
}

/**
 * Clone one repo into the workspace.
 *
 * Never throws: a repo that fails to materialize is recorded as `failed` and
 * the thread carries on with the rest. A workspace with three of four repos is
 * still useful; a failed environment is not.
 */
export async function materializeRepo(args: MaterializeArgs): Promise<WorkspaceRepo> {
  const dest = path.join(args.root, assertSafeSegment(args.repo.dir, "A repo directory name"));
  const failed = (message: string): WorkspaceRepo => ({
    dir: args.repo.dir,
    path: dest,
    branch: args.branchName,
    baseBranch: args.repo.branch ?? "",
    remote: args.repo.url,
    status: "failed",
    message: message.slice(0, 600),
  });

  try {
    if (await isCompleted(args.dataDir, args.pathKey, args.repo.dir)) {
      const branch = (await gitLine(dest, ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 10_000 })) ?? args.branchName;
      const base =
        args.repo.branch ??
        (await gitLine(dest, ["config", "--get", "bb-multi-repo.baseBranch"], { timeoutMs: 10_000 })) ??
        branch;
      return {
        dir: args.repo.dir,
        path: dest,
        branch,
        baseBranch: base,
        remote: args.repo.url,
        status: "ready",
      };
    }

    // Debris from an attempt that died mid-clone. The marker above is the only
    // thing that makes a directory trustworthy.
    await rm(dest, { recursive: true, force: true });

    const cache = await ensureCache({
      dataDir: args.dataDir,
      url: args.repo.url,
      mirrors: args.mirrors,
      fetchTtlMs: args.fetchTtlMs,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
      ...(args.report === undefined ? {} : { report: args.report }),
    });

    const base = args.repo.branch ?? (await cacheDefaultBranch(cache.path, args.signal));
    if (base === null) {
      return failed(`${args.repo.url} has no branches.`);
    }
    if (!(await cacheHasBranch(cache.path, base, args.signal))) {
      return failed(
        args.repo.branch === undefined || args.repo.branch === null
          ? `${args.repo.url} has no branch "${base}".`
          : `${args.repo.url} has no branch "${base}" (set in repos.json).`,
      );
    }

    args.report?.step(`Checking out ${args.repo.dir}`);
    // `--shared` points this clone's `objects/info/alternates` at the cache.
    // The pointer is only ever read, and reads are unrestricted in the
    // sandbox, so the agent gets the full object graph while its own `.git`
    // stays inside `cwd` and writable.
    const cloned = await git(
      ["clone", "--shared", "--quiet", "--branch", base, cache.path, dest],
      {
        timeoutMs: CLONE_TIMEOUT_MS,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      },
    );
    if (cloned.code !== 0) return failed(firstProblemLine(cloned));

    const gitOptions = {
      timeoutMs: GIT_TIMEOUT_MS,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    };
    // The clone's `origin` currently points at the object cache, which the
    // agent must never push to. Repoint it at the real remote before the
    // workspace is ever handed over.
    const repointed = await gitIn(dest, ["remote", "set-url", "origin", args.repo.url], gitOptions);
    if (repointed.code !== 0) return failed(firstProblemLine(repointed));
    // Remembered so a resumed `create()` can report the base branch without
    // re-reading `repos.json`, and so the diff layer has it from the repo.
    await gitIn(dest, ["config", "bb-multi-repo.baseBranch", base], gitOptions);

    const branch = await pickBranchName(dest, args.branchName, args.repo.dir);
    const branched = await gitIn(dest, ["checkout", "--quiet", "-b", branch], gitOptions);
    if (branched.code !== 0) return failed(firstProblemLine(branched));

    await markCompleted(args.dataDir, args.pathKey, args.repo.dir);
    return {
      dir: args.repo.dir,
      path: dest,
      branch,
      baseBranch: base,
      remote: args.repo.url,
      status: "ready",
    };
  } catch (error) {
    if (args.signal?.aborted === true) throw error;
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Clone the project source into the workspace as `.bb`.
 *
 * Cloned from the canonical checkout on this machine rather than from its
 * remote: it is a local path, so the objects hardlink, and a project source
 * with no remote at all still works. `origin` is left pointing at the
 * canonical checkout so the agent can pull guidance updates; the write-back in
 * the other direction is {@link pushGuidance}, which runs host-side.
 *
 * `.bb` stays on its default branch. Two threads could not both check out
 * `main` as worktrees of one repo, but independent clones can — which is the
 * secondary reason this design clones.
 */
export async function materializeProjectSource(args: {
  root: string;
  projectSourcePath: string;
  signal?: AbortSignal;
}): Promise<WorkspaceRepo> {
  const dest = path.join(args.root, PROJECT_SOURCE_DIR);
  const options = {
    timeoutMs: CLONE_TIMEOUT_MS,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  };
  if (await exists(path.join(dest, ".git"))) {
    const branch = (await gitLine(dest, ["rev-parse", "--abbrev-ref", "HEAD"], options)) ?? "main";
    return {
      dir: PROJECT_SOURCE_DIR,
      path: dest,
      branch,
      baseBranch: branch,
      remote: args.projectSourcePath,
      status: "ready",
    };
  }
  await rm(dest, { recursive: true, force: true });
  const cloned = await git(["clone", "--quiet", args.projectSourcePath, dest], options);
  if (cloned.code !== 0) {
    return {
      dir: PROJECT_SOURCE_DIR,
      path: dest,
      branch: "",
      baseBranch: "",
      remote: args.projectSourcePath,
      status: "failed",
      message: firstProblemLine(cloned).slice(0, 600),
    };
  }
  const branch = (await gitLine(dest, ["rev-parse", "--abbrev-ref", "HEAD"], options)) ?? "main";
  return {
    dir: PROJECT_SOURCE_DIR,
    path: dest,
    branch,
    baseBranch: branch,
    remote: args.projectSourcePath,
    status: "ready",
  };
}

export interface ProvisionArgs {
  dataDir: string;
  pathKey: string;
  projectSourcePath: string;
  repos: readonly RepoRequest[];
  branchName: string;
  fetchTtlMs: number;
  mirrors: readonly { path: string; url: string }[];
  report?: CacheProgress;
  signal?: AbortSignal;
}

export async function provisionWorkspace(
  args: ProvisionArgs,
): Promise<{ root: string; repos: WorkspaceRepo[] }> {
  const root = workspaceRoot(args.dataDir, args.pathKey);
  await mkdir(root, { recursive: true });

  const repos: WorkspaceRepo[] = [];
  let index = 0;
  for (const repo of args.repos) {
    index += 1;
    args.report?.step(`Preparing ${repo.dir} (${index}/${args.repos.length})`);
    repos.push(await materializeRepo({ ...args, root, repo }));
  }

  args.report?.step("Preparing the project definition");
  const source = await materializeProjectSource({
    root,
    projectSourcePath: args.projectSourcePath,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  repos.push(source);

  return { root, repos };
}

export async function addWorkspaceRepo(args: {
  dataDir: string;
  pathKey: string;
  root: string;
  repo: RepoRequest;
  branchName: string;
  fetchTtlMs: number;
  mirrors: readonly { path: string; url: string }[];
  report?: CacheProgress;
  signal?: AbortSignal;
}): Promise<WorkspaceRepo> {
  await mkdir(args.root, { recursive: true });
  return materializeRepo(args);
}

/**
 * Tear a workspace down.
 *
 * **Kill first, then delete.** `experimental_killProcessesWithCwdUnder` is
 * published for exactly this case — a provider tearing down a workspace it
 * made — and it SIGTERMs, then SIGKILLs, anything whose working directory sits
 * under the root. Without it, removal races a language server or a file
 * watcher still holding one of the repos, and `rm` either fails or leaves a
 * live process pointing at a directory that no longer exists.
 *
 * Every directory under the root goes, plus the completion markers beside it.
 * Nothing outside these two roots is ever touched — in particular not the
 * object cache, whose entries are shared with every other workspace.
 */
export async function removeWorkspace(args: {
  dataDir: string;
  pathKey: string;
  path: string | null;
  report?: CacheProgress;
  signal?: AbortSignal;
}): Promise<{ removed: boolean }> {
  const root = args.path ?? workspaceRoot(args.dataDir, args.pathKey);
  const owned = workspaceRoot(args.dataDir, args.pathKey);
  if (path.resolve(root) !== path.resolve(owned)) {
    // `remove` is handed whatever path the environment row recorded. Deleting
    // a path this plugin did not create is not a recoverable mistake.
    throw new Error(`Refusing to remove ${root}: it is not this plugin's workspace for ${args.pathKey}.`);
  }

  const present = await exists(root);
  if (present) {
    args.report?.step("Stopping processes in the workspace");
    await killProcessesUnder({ directories: [root] }).catch(() => []);
    args.report?.step("Removing the workspace");
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      entries = [];
    }
    // Per-directory so a single undeletable repo does not abandon the rest.
    for (const entry of entries) {
      await rm(path.join(root, entry), { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
  await rm(stateDir(args.dataDir, args.pathKey), { recursive: true, force: true }).catch(() => undefined);
  return { removed: present };
}
