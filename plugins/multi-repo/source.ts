/**
 * The canonical `.bb` checkout — the project's own repo.
 *
 * A project's source here is not code: it is the workspace definition. It
 * holds `repos.json` (the repo set), `AGENTS.md` (cross-repo guidance, read
 * natively by bb) and `skills/` (project skills, also read natively). Core
 * keeps one such checkout per `(project, machine)` and hands this plugin its
 * path as `context.projectCheckout.path`.
 *
 * Two ways a project gets one, converging immediately: clone a `.bb` repo that
 * already has a remote, or point the project at an empty directory and let
 * {@link bootstrapProjectSource} initialize it. The second upgrades to the
 * first with `git remote add` and a push, with no migration.
 *
 * Everything in this module runs host-side, outside the agent's sandbox. That
 * is what makes the write-back in {@link pushGuidance} possible at all.
 */
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { projectFilePathProblem, slugify } from "./names.js";
import { GitError, git, gitIn, gitInOrThrow, gitLine, firstProblemLine, run, splitNul, type RunOptions } from "./git.js";
import { REPOS_FILE, parseReposFile, resolvePublishMode, serializeReposFile, type PublishMode, type PublishPolicy, type ReposFile, type WriteMode } from "./repos.js";
import { parseCreatedUrl } from "./gh-parse.js";
import { cacheDefaultBranch, ensureCache } from "./cache.js";
import { CACHE_FRESH_MS } from "./shared.js";
import type { ProbeRemoteResult, UnpushedSummary } from "./contract.js";
import {
  DEFINITION_PREFIX,
  PROJECT_SOURCE_DIR,
  type ProjectLayout,
} from "./paths.js";

const FETCH_MARKER = ".git/bb-multi-repo-fetched-at";
const GIT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 120_000;
const PUBLISH_TIMEOUT_MS = 120_000;
/** How long a `merge` publish waits for required checks before trying to merge. */
const MERGE_WAIT_MS = 90_000;
/** How often the merge wait re-reads the pull request's checks. */
const MERGE_POLL_MS = 3_000;

/** True when the ref resolves to a commit. */
async function refExists(dir: string, ref: string, signal?: AbortSignal): Promise<boolean> {
  const result = await gitIn(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    timeoutMs: GIT_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  return result.code === 0 && result.stdout.trim().length > 0;
}

/**
 * The default branch's committed tip, as a ref usable with `git ls-tree`.
 *
 * `origin/<default>` is the project's shared truth and is preferred. The one
 * case where the local default branch is used instead is when it is strictly
 * ahead of the remote-tracking ref — the plugin's own committed `.bb` edits
 * (a seed, a `repos.json` change) live there, and a read that ignored them
 * would make `bb repos add` appear to have done nothing. A local branch that
 * has diverged from the remote is never used: that is a person's own history,
 * not the project's. Never the working tree, and never whatever feature branch
 * the checkout happens to be on.
 *
 * **The local-ahead preference stays, deliberately (BB-148 deliverable 2).**
 * Now that every write publishes (see {@link publishDefinition}), a local
 * branch ahead of `origin` means a publish failed, and the generated block's
 * unpushed line and `bb repos list` both report it. Keeping the preference
 * means the failed change is still live on this server rather than silently
 * ignored, and it is what lets `preparePrimaryProjectSource` seed a project
 * and provision from it before the seed pull request has merged.
 */
export async function resolveDefaultBranchRef(dir: string, signal?: AbortSignal): Promise<string | null> {
  const options = { timeoutMs: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  const originHead = await gitLine(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], options);
  let branch =
    originHead !== null && originHead.startsWith("origin/") ? originHead.slice("origin/".length) : null;
  // A hand-made checkout may have no `origin/HEAD`. The conventional default
  // names are tried before the checked-out branch, so a feature branch is
  // never mistaken for the default; the refresh also runs
  // `git remote set-head origin --auto` to set it properly.
  if (branch === null || branch.length === 0) {
    for (const candidate of ["main", "master"]) {
      if (await refExists(dir, `refs/remotes/origin/${candidate}`, signal)) {
        branch = candidate;
        break;
      }
    }
  }
  if (branch === null || branch.length === 0) {
    const current = await gitLine(dir, ["rev-parse", "--abbrev-ref", "HEAD"], options);
    if (current !== null && current !== "HEAD") branch = current;
  }
  const originRef = branch === null ? null : `refs/remotes/origin/${branch}`;
  const localRef = branch === null ? null : `refs/heads/${branch}`;
  const hasOrigin = originRef !== null && (await refExists(dir, originRef, signal));
  const hasLocal = localRef !== null && (await refExists(dir, localRef, signal));
  if (hasLocal && hasOrigin) {
    const localSha = await gitLine(dir, ["rev-parse", localRef as string], options);
    const originSha = await gitLine(dir, ["rev-parse", originRef as string], options);
    if (localSha !== null && localSha === originSha) return localRef;
    const ahead = await gitIn(dir, ["merge-base", "--is-ancestor", originRef as string, localRef as string], options);
    return ahead.code === 0 ? localRef : originRef;
  }
  if (hasLocal) return localRef;
  if (hasOrigin) return originRef;
  return (await refExists(dir, "HEAD", signal)) ? "HEAD" : null;
}

/**
 * Which layout a project source has.
 *
 * One question decides it: is the project directory a git repo? A git repo is
 * a primary (`.bb/` on its default branch); anything else is a plain directory
 * whose `.bb/` is an ordinary subdirectory. Never a fallback and never decided
 * from the definition's presence: a git repo with no `.bb/` is an unseeded
 * primary, and the seeding happens on the first explicit write.
 *
 * A git repo that carries `repos.json` at its root and no `.bb/repos.json` is
 * a leftover standalone definition (the layout this replaced). It is refused
 * rather than guessed at, so the owner moves the file to `.bb/repos.json`
 * instead of the plugin committing it somewhere new.
 */
export async function detectProjectLayout(dir: string, signal?: AbortSignal): Promise<ProjectLayout> {
  if (!(await isGitRepo(dir))) return "directory";
  const refusal = await rootDefinitionProblem(dir, signal);
  if (refusal !== null) throw new Error(refusal);
  return "primary";
}

/**
 * The move-it message for a git repo holding a former standalone definition,
 * or null when there is nothing to move.
 *
 * `.bb/repos.json` wins when both exist: a primary that carries a stale root
 * copy is not refused, because the committed definition is unambiguous.
 */
export async function rootDefinitionProblem(dir: string, _signal?: AbortSignal): Promise<string | null> {
  if (!(await isGitRepo(dir))) return null;
  if (await exists(path.join(dir, PROJECT_SOURCE_DIR, REPOS_FILE))) return null;
  if (!(await exists(path.join(dir, REPOS_FILE)))) return null;
  return `${dir} has a ${REPOS_FILE} at its root, which is a leftover standalone definition. This project is a git repo now: move it to ${PROJECT_SOURCE_DIR}/${REPOS_FILE}.`;
}

export interface ProbeRemoteArgs {
  /** The host data directory the per-machine object cache lives under. */
  dataDir: string;
  /** A git URL, or an absolute path to a local checkout. */
  url: string;
  signal?: AbortSignal;
}

/**
 * Which shape the thing at `url` has, without checking it out.
 *
 * This is the New project form's replacement for its old mode radio. The
 * answer is read from the default branch's committed tree — `.bb/repos.json`
 * is a primary repo, neither is a plain (unseeded primary) repo — through the
 * per-machine bare cache, which is the same clone a real checkout borrows
 * from, so the fetch is not wasted. A root `repos.json` is a leftover
 * standalone definition and is refused with the move-it message.
 *
 * A local path that is already a checkout is `checkout`: the caller adopts it
 * as the project source rather than cloning beside it. A remote the machine
 * cannot read (a private https URL with no credential helper is the common
 * one) throws with a message that names the cause, so the form can say so
 * plainly instead of guessing "plain".
 */
export async function probeRemote(args: ProbeRemoteArgs): Promise<ProbeRemoteResult> {
  const { url, dataDir, signal } = args;
  const options = { timeoutMs: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };

  if (url.startsWith("-")) throw new Error(`${JSON.stringify(url)} is not a git URL.`);
  if (!path.isAbsolute(url) && (url.startsWith("~") || url.startsWith("."))) {
    throw new Error(
      `${url} is not an absolute path; a local checkout must be absolute (for example /home/you/code/repo), or use a git URL.`,
    );
  }

  if (path.isAbsolute(url) && (await isGitRepo(url))) {
    const refusal = await rootDefinitionProblem(url, signal);
    if (refusal !== null) throw new Error(refusal);
    const ref = await resolveDefaultBranchRef(url, signal);
    const defaultBranch = ref?.replace(/^refs\/(heads|remotes\/origin)\//u, "") ?? null;
    const primary = await gitIn(url, ["cat-file", "-e", `${ref ?? "HEAD"}:${PROJECT_SOURCE_DIR}/${REPOS_FILE}`], options);
    const what = primary.code === 0 ? "a primary repo carrying .bb/" : "an existing checkout (a primary repo with no .bb/ yet)";
    return { outcome: "checkout", defaultBranch, message: `${url} is ${what}; it is used as the project source.` };
  }

  const entry = await ensureCache({
    dataDir,
    url,
    mirrors: [],
    fetchTtlMs: CACHE_FRESH_MS,
    ...(signal === undefined ? {} : { signal }),
  }).catch((error: unknown) => {
    throw new Error(probeRemoteError(url, error));
  });

  const defaultBranch = await cacheDefaultBranch(entry.path, signal);
  if (defaultBranch === null) {
    return { outcome: "plain", defaultBranch: null, message: `No branch was found on ${url}.` };
  }
  const ref = `refs/heads/${defaultBranch}`;
  const primary = await gitIn(entry.path, ["cat-file", "-e", `${ref}:${PROJECT_SOURCE_DIR}/${REPOS_FILE}`], options);
  if (primary.code === 0) {
    return { outcome: "primary", defaultBranch, message: `Primary repo: .bb/repos.json on ${defaultBranch}.` };
  }
  const root = await gitIn(entry.path, ["cat-file", "-e", `${ref}:${REPOS_FILE}`], options);
  if (root.code === 0) {
    throw new Error(
      `${url} carries a ${REPOS_FILE} at its root, which is a leftover standalone definition. Move it to ${PROJECT_SOURCE_DIR}/${REPOS_FILE} before using this repo.`,
    );
  }
  return { outcome: "plain", defaultBranch, message: `Plain repo: no .bb definition on ${defaultBranch}; it becomes a primary repo with an unseeded .bb/.` };
}

/**
 * A probe failure a person can act on.
 *
 * A private https remote with no credential helper is the common one, and
 * git's own message — "could not read Username" — does not say what to do
 * about it, so the cause is named explicitly.
 */
export function probeRemoteError(url: string, error: unknown): string {
  const detail =
    error instanceof GitError ? firstProblemLine(error.result) : error instanceof Error ? error.message : String(error);
  if (/could not read Username|terminal prompts disabled|authentication failed|permission denied|no such device or address/iu.test(detail)) {
    return `${url} looks private and this machine has no credential helper for it. Add one, or use an SSH URL. (${detail})`.slice(0, 600);
  }
  return `Could not read ${url}: ${detail}`.slice(0, 600);
}

/**
 * The seeded `AGENTS.md`.
 *
 * This is the human half of the agent-facing surface, and it is seeded rather
 * than generated because it is meant to be *edited*. The plugin's generated
 * block says where the repos are; this file says what they mean to each other,
 * and the plugin must never rewrite it.
 *
 * It leads with an explanation of `.bb` itself. Without that, an agent treats
 * the directory as scaffolding and never writes anything durable into it,
 * which is the failure mode that makes cross-repo knowledge evaporate at the
 * end of every thread.
 *
 * The publish half differs by layout and so does the file: a primary project
 * publishes committed `.bb/` writes, while a plain directory edits them in
 * place and never publishes anything. See {@link SEEDED_AGENTS_MD_PRIMARY}.
 */
export const SEEDED_AGENTS_MD = `# Cross-repo guidance

This file lives in \`.bb/\`, an ordinary subdirectory of this project's
directory. It is **shared by every thread in this project**, so it is the
right place to record durable cross-repo knowledge — and the wrong place for
anything specific to one thread.

\`.bb/\` holds three things:

- \`repos.json\` — the repo set. Every thread gets a checkout of each entry.
- \`AGENTS.md\` — this file. bb reads it natively into every thread here.
- \`skills/\` — project skills, also read natively.

The plugin generates a separate block listing each repo's directory, branch and
path. Do not duplicate those facts here: paths written into this file go stale
the first time a repo is renamed, and the generated block is always current as
of thread start.

## How a \`.bb\` change lands

This project directory is not a git repo, so \`.bb/\` is edited in place.
Nothing is committed and nothing is published: a change here reaches other
machines only if the project directory itself is shared or synced some other
way. The Repos panel, \`bb repos add\`/\`remove\` and \`workspace_add_repo\`
all edit \`.bb/repos.json\` in place and say so.

## What belongs here

Write down the things a newcomer to this workspace would get wrong:

- **Which repo depends on which**, and in which direction.
- **What has to be rebuilt, republished, or redeployed** when a given repo
  changes — especially when the trigger lives in a different repo than the
  change.
- **What belongs in which repo**, when that is not obvious from the names.
- **Cross-repo conventions** — shared version numbers, coordinated releases,
  contracts that two repos both implement.

## Repos

_Describe each repo in a line or two: what it is, and what depends on it._

## Working across repos

_How a change that spans repos should be landed here: order, PR conventions,
whether anything must merge first._
`;

/**
 * The seeded `AGENTS.md` for a primary project.
 *
 * Same shape as {@link SEEDED_AGENTS_MD}; the publish half describes the
 * policy a git-backed `.bb/` is published by.
 */
export const SEEDED_AGENTS_MD_PRIMARY = `# Cross-repo guidance

This file lives in \`.bb/\`, a directory on the primary repo's default branch.
It is **shared by every thread in this project and versioned**, so it is the
right place to record durable cross-repo knowledge — and the wrong place for
anything specific to one thread.

\`.bb/\` holds three things:

- \`repos.json\` — the repo set. Every thread gets a checkout of each entry.
- \`AGENTS.md\` — this file. bb reads it natively into every thread here.
- \`skills/\` — project skills, also read natively.

The plugin generates a separate block listing each repo's directory, branch and
path. Do not duplicate those facts here: paths written into this file go stale
the first time a repo is renamed, and the generated block is always current as
of thread start.

## How a \`.bb\` change lands

A committed \`.bb\` write is published to \`origin\` by this project's
**publish policy**, so a change never stays on one server. The Repos panel,
\`bb repos add\`/\`remove\`, \`workspace_add_repo\`, the raw \`repos.json\`
editor and the discovery seed all go through the same step; a failed push,
pull request or merge keeps the local commit and is reported, not silently
swallowed.

\`repos.json\` may carry a \`publish\` key that overrides the defaults, either
as one mode for the project or as an object of path → mode:

- \`"push"\` pushes the default branch to \`origin\` at once. The change is
  live everywhere immediately.
- \`"pull-request"\` pushes a \`guidance-\` branch and opens a pull request;
  the default branch is never moved, so the change lands when the pull request
  is reviewed and merged.
- \`"merge"\` cuts a fresh branch from the default branch, opens a pull request
  and merges it in the same step (plain \`gh pr merge --squash
  --delete-branch\`, waiting briefly for required checks; a skipped required
  check counts as passing). A refused merge leaves the pull request open and
  reports it.

With no key set, \`repos.json\` defaults to \`merge\` — adding a repo is
mechanical, nothing else reads the file, and the person who pressed "Add repo"
has already decided — while \`AGENTS.md\`, \`skills/\` and \`stewards/\` stay
\`pull-request\`, because they are reviewed like code. Set \`publish\` to
\`"push"\` to opt in to direct pushes.

Either way the change reaches other machines only once it is on \`origin\` —
for a \`push\` immediately, for a \`merge\` or \`pull-request\` when it merges.

## What belongs here

Write down the things a newcomer to this workspace would get wrong:

- **Which repo depends on which**, and in which direction.
- **What has to be rebuilt, republished, or redeployed** when a given repo
  changes — especially when the trigger lives in a different repo than the
  change.
- **What belongs in which repo**, when that is not obvious from the names.
- **Cross-repo conventions** — shared version numbers, coordinated releases,
  contracts that two repos both implement.

## Repos

_Describe each repo in a line or two: what it is, and what depends on it._

## Working across repos

_How a change that spans repos should be landed here: order, PR conventions,
whether anything must merge first._
`;

/** Is this directory a git repo (not merely inside one)? */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

export interface BootstrapResult {
  bootstrapped: boolean;
  warnings: string[];
}

/**
 * Create a plain directory's `.bb/` skeleton in place.
 *
 * Runs only when the directory has no `.git`. A git repo is a primary and is
 * never seeded here: this runs on the thread-start read path, and committing
 * `.bb/` onto whatever branch the checkout has is not a read's job. The
 * explicit write paths (the Repos panel's add and the raw editor) seed a
 * primary through {@link preparePrimaryProjectSource} instead.
 *
 * Nothing here overwrites a file that already exists — a directory holding an
 * `AGENTS.md` and no repo keeps its `AGENTS.md` — and there is no `git init`,
 * no commit and no `.git` anywhere: a plain directory is just a directory.
 */
export async function bootstrapProjectSource(
  dir: string,
  seed: ReposFile,
  signal?: AbortSignal,
): Promise<BootstrapResult> {
  const warnings: string[] = [];
  if (await isGitRepo(dir)) return { bootstrapped: false, warnings };
  void signal;

  const definitionDir = path.join(dir, PROJECT_SOURCE_DIR);
  await mkdir(path.join(definitionDir, "skills"), { recursive: true });
  const reposPath = path.join(definitionDir, REPOS_FILE);
  if (!(await exists(reposPath))) await writeFile(reposPath, serializeReposFile(seed), "utf8");
  const agentsPath = path.join(definitionDir, "AGENTS.md");
  if (!(await exists(agentsPath))) await writeFile(agentsPath, SEEDED_AGENTS_MD, "utf8");
  // An empty directory is not a thing git can track, and a project with no
  // skills yet should still show the agent where they go.
  const keepPath = path.join(definitionDir, "skills", ".gitkeep");
  if (!(await exists(keepPath))) await writeFile(keepPath, "", "utf8");

  return { bootstrapped: true, warnings };
}

/**
 * Seed the `.bb/` definition inside a primary repo that does not carry one yet.
 *
 * Unlike {@link bootstrapProjectSource} this never runs `git init`: the primary
 * is a real repo that already exists, and `.bb/` is a directory added to it.
 * Nothing here overwrites a file that already exists, so a repo that carries a
 * partial `.bb/` is completed rather than replaced.
 *
 * The commit lands on the checkout's current branch. The caller (the
 * new-project flow) publishes a branch and opens the pull request; this
 * function is only the tree and the commit.
 */
export async function seedPrimaryDefinition(
  dir: string,
  seed: ReposFile,
  signal?: AbortSignal,
): Promise<BootstrapResult> {
  const warnings: string[] = [];
  if (!(await isGitRepo(dir))) {
    return { bootstrapped: false, warnings: [`${dir} is not a git repo, so it cannot carry .bb/.`] };
  }
  const options = { timeoutMs: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  const definitionDir = path.join(dir, PROJECT_SOURCE_DIR);
  await mkdir(path.join(definitionDir, "skills"), { recursive: true });
  const reposPath = path.join(definitionDir, REPOS_FILE);
  if (!(await exists(reposPath))) await writeFile(reposPath, serializeReposFile(seed), "utf8");
  const agentsPath = path.join(definitionDir, "AGENTS.md");
  if (!(await exists(agentsPath))) await writeFile(agentsPath, SEEDED_AGENTS_MD_PRIMARY, "utf8");
  const keepPath = path.join(definitionDir, "skills", ".gitkeep");
  if (!(await exists(keepPath))) await writeFile(keepPath, "", "utf8");

  await gitIn(dir, ["add", "--", PROJECT_SOURCE_DIR], options);
  const commit = await commitAll(dir, "Initialize .bb in the primary repo", signal);
  if (!commit.committed && commit.message !== null) warnings.push(commit.message);
  return { bootstrapped: true, warnings };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone an existing `.bb` repo into `dir`, making it this machine's canonical
 * checkout.
 *
 * Refuses a destination with contents rather than cloning beside them: a
 * populated directory is either a second project or a mistake, and git's own
 * refusal reads as a stack trace. A directory that exists but is empty is
 * fine — `mkdir -p` by a previous attempt is the common way to get one.
 */
export async function cloneProjectSource(
  url: string,
  dir: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string | null }> {
  if (url.startsWith("-")) return { ok: false, message: `${JSON.stringify(url)} is not a clone URL.` };
  const entries = await readdir(dir).catch(() => null);
  if (entries !== null && entries.length > 0) {
    return { ok: false, message: `${dir} already exists and is not empty.` };
  }
  await mkdir(path.dirname(dir), { recursive: true });
  const result = await git(["clone", "--quiet", "--", url, dir], {
    timeoutMs: FETCH_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.code !== 0) return { ok: false, message: firstProblemLine(result) };
  return { ok: true, message: null };
}

/**
 * The parent a new project's `.bb` checkout should sit under.
 *
 * `~/bb` unless every existing project checkout on the machine lives under one
 * other parent directory, which is then used. Mixed parents, or no projects,
 * mean `~/bb`; a set that is already all under `~/bb` also means `~/bb`.
 */
export function existingProjectSourceParent(existingPaths: readonly string[], fallback: string): string {
  const parents = new Set(
    existingPaths
      .map((target) => target.replace(/[\\/]+$/u, ""))
      .filter((target) => target.length > 0)
      .map((target) => path.dirname(target)),
  );
  if (parents.size !== 1) return fallback;
  return [...parents][0];
}

/**
 * Where a new project's `.bb` checkout goes unless someone says otherwise.
 *
 * Under the home directory because that is the one place on a machine that is
 * reliably writable and survives a plugin uninstall, and under one `bb`
 * folder so several projects' definitions sit together — and beside any
 * checkouts the user keeps there, which the mirror discovery scans as siblings
 * of the project source. When every existing project on the machine lives
 * under one other parent, that parent is used instead, so a machine that keeps
 * its projects elsewhere gets the next one there too.
 */
export async function defaultProjectSourcePath(
  name: string,
  existingPaths: readonly string[] = [],
): Promise<{ path: string; exists: boolean }> {
  const parent = existingProjectSourceParent(existingPaths, path.join(homedir(), "bb"));
  const target = path.join(parent, slugify(name));
  return { path: target, exists: await exists(target) };
}

/**
 * Commit whatever is staged, with an identity if the machine has none.
 *
 * A daemon machine very often has no `user.email`, and a commit that fails for
 * that reason would take the whole environment down. The `-c` identity is
 * per-invocation, so nothing is written into the user's global config.
 */
export async function commitAll(
  dir: string,
  message: string,
  signal?: AbortSignal,
): Promise<{ committed: boolean; head: string | null; message: string | null }> {
  const options = { timeoutMs: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  const staged = await gitIn(dir, ["diff", "--cached", "--quiet"], options);
  // Exit 1 means there is something staged; 0 means there is not.
  if (staged.code === 0) {
    return { committed: false, head: await gitLine(dir, ["rev-parse", "HEAD"], options), message: null };
  }
  const identity = (await gitLine(dir, ["config", "user.email"], options)) ?? "";
  const withIdentity =
    identity.trim().length > 0
      ? []
      : ["-c", "user.name=bb multi-repo", "-c", "user.email=multi-repo@plugins.bb.invalid"];
  const result = await gitIn(dir, [...withIdentity, "commit", "--quiet", "-m", message], options);
  if (result.code !== 0) {
    return { committed: false, head: null, message: firstProblemLine(result) };
  }
  return { committed: true, head: await gitLine(dir, ["rev-parse", "HEAD"], options), message: null };
}

/** The remote `origin` URL, or null for a local-only project source. */
export async function projectSourceRemote(dir: string, signal?: AbortSignal): Promise<string | null> {
  const url = await gitLine(dir, ["config", "--get", "remote.origin.url"], {
    timeoutMs: GIT_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  return url === null || url.length === 0 ? null : url;
}

export async function projectSourceBranch(dir: string, signal?: AbortSignal): Promise<string | null> {
  return gitLine(dir, ["rev-parse", "--abbrev-ref", "HEAD"], {
    timeoutMs: GIT_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** How many commit subjects to carry when the default branch is ahead. */
const UNPUSHED_SUBJECT_LIMIT = 50;

/**
 * Commits on the project checkout's default branch that `origin` does not have.
 *
 * The same ref {@link resolveDefaultBranchRef} picks for a read is compared to
 * `origin/<branch>`, so the count is exactly the local-ahead state the plugin's
 * own committed `.bb` edits create. A level or diverged branch, or a checkout
 * with no such remote ref, is reported as null rather than as zero commits:
 * the instruction block prints nothing for it.
 */
export async function projectSourceUnpushed(
  dir: string,
  signal?: AbortSignal,
): Promise<UnpushedSummary | null> {
  const ref = await resolveDefaultBranchRef(dir, signal);
  if (ref === null) return null;
  const branch = ref.replace(/^refs\/(heads|remotes\/origin)\//u, "");
  const options = { timeoutMs: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  const range = `refs/remotes/origin/${branch}..${ref}`;
  const countText = await gitLine(dir, ["rev-list", "--count", range], options);
  if (countText === null) return null;
  const count = Number.parseInt(countText.trim(), 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  const log = await gitIn(
    dir,
    ["log", `--max-count=${UNPUSHED_SUBJECT_LIMIT}`, "--format=%s", range],
    options,
  );
  const subjects =
    log.code === 0
      ? log.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];
  return { branch, count, subjects };
}

/**
 * Fetch and fast-forward the project source, at most once per TTL.
 *
 * Fast-forward only, and silent about failure. This runs on the thread-start
 * path: a project source with a local commit that has not been pushed is a
 * situation for a person to resolve, not one to resolve by merging under them,
 * and a brief network failure must not cost anyone a thread.
 */
export async function refreshProjectSource(
  dir: string,
  ttlMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const warnings: string[] = [];
  const remote = await projectSourceRemote(dir, signal);
  if (remote === null) return warnings;

  const markerPath = path.join(dir, FETCH_MARKER);
  const last = await readFile(markerPath, "utf8").then(
    (raw) => Number.parseInt(raw.trim(), 10),
    () => Number.NaN,
  );
  if (Number.isFinite(last) && Date.now() - last < ttlMs) return warnings;

  const options = { timeoutMs: FETCH_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  const fetched = await gitIn(dir, ["fetch", "--quiet", "origin"], options);
  if (fetched.code !== 0) {
    warnings.push(`Could not fetch the project source: ${firstProblemLine(fetched)}`);
    return warnings;
  }
  await writeFile(markerPath, String(Date.now()), "utf8").catch(() => undefined);
  // Keep `origin/HEAD` pointing at the remote's default branch, so a read
  // never has to guess it from the checked-out branch. Best-effort: a remote
  // that cannot answer leaves the ref as it was.
  await gitIn(dir, ["remote", "set-head", "origin", "--auto"], options).catch(() => undefined);

  const merged = await gitIn(dir, ["merge", "--ff-only", "--quiet", "@{u}"], options);
  if (merged.code !== 0) {
    warnings.push(
      `The project source has local commits that are not on its remote; leaving it as it is.`,
    );
  }
  return warnings;
}

export async function readReposJson(
  dir: string,
  layout: ProjectLayout = "primary",
  signal?: AbortSignal,
): Promise<string | null> {
  if (layout === "directory") return readDefinitionFileFromDisk(dir, REPOS_FILE);
  const read = await readCommittedFiles(dir, [REPOS_FILE], 200_000, signal, {
    prefix: DEFINITION_PREFIX,
  });
  if (read.error !== null || read.files.length === 0) return null;
  return read.files[0].content;
}

/**
 * Read one `.bb/`-relative file from a plain project directory's disk.
 *
 * A plain directory has no commit to read from, so this is the working tree
 * itself — there is nothing else it could be. The path is validated by the
 * caller (the RPC schema and {@link projectFilePathProblem}), and the read is
 * capped so a runaway file cannot be loaded whole.
 */
async function readDefinitionFileFromDisk(
  dir: string,
  file: string,
  maxChars = 200_000,
): Promise<string | null> {
  const problem = projectFilePathProblem(file);
  if (problem !== null) return null;
  const content = await readFile(path.join(dir, PROJECT_SOURCE_DIR, file), "utf8").catch(() => null);
  if (content === null || content.length > maxChars) return null;
  return content;
}

/**
 * Read `.bb/`-relative files for another plugin: from the committed default
 * branch for a primary, from disk for a plain directory.
 *
 * The primary half is {@link readCommittedFiles} with the `.bb/` prefix; the
 * plain half is the working tree, because there is no commit. Both return the
 * same shape so the caller cannot tell them apart.
 */
export async function readDefinitionFiles(
  dir: string,
  layout: ProjectLayout,
  paths: readonly string[],
  maxChars: number,
  signal?: AbortSignal,
): Promise<CommittedFiles> {
  if (layout === "primary") {
    return readCommittedFiles(dir, paths, maxChars, signal, { prefix: DEFINITION_PREFIX });
  }
  const files: CommittedFiles["files"] = [];
  for (const file of paths) {
    files.push({ path: file, content: await readDefinitionFileFromDisk(dir, file, maxChars) });
  }
  return { head: null, files, error: null };
}

export interface CommittedFiles {
  /** The commit read, or null when there is none to read. */
  head: string | null;
  files: Array<{ path: string; content: string | null }>;
  error: string | null;
}

/** Git modes of a regular file. A symlink (`120000`) or a submodule is not one. */
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/**
 * Read files out of the project source's committed `HEAD`, never its working
 * tree.
 *
 * The canonical checkout is a person's directory as well as the plugin's: an
 * edit someone is halfway through there is not yet the project's, any more
 * than one in a thread's workspace is. So the read is pinned to one commit,
 * resolved once, and every file comes from that commit's tree — a `HEAD` that
 * moves mid-read cannot hand back a mix of two.
 *
 * A path the commit does not hold as a regular file comes back as null, and
 * so does one over `maxChars`, with `error` naming it: a truncated playbook
 * would read as a complete one. A path that fails {@link projectFilePathProblem}
 * is refused outright, whatever the schema in front of this already checked.
 */
export async function readCommittedFiles(
  dir: string,
  paths: readonly string[],
  maxChars: number,
  signal?: AbortSignal,
  options: { ref?: string | null; prefix?: string } = {},
): Promise<CommittedFiles> {
  for (const file of paths) {
    const problem = projectFilePathProblem(file);
    if (problem !== null) return { head: null, files: [], error: problem };
  }
  const prefix = options.prefix ?? "";
  const gitOptions = { timeoutMs: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  const ref =
    options.ref === undefined
      ? await resolveDefaultBranchRef(dir, signal)
      : options.ref;
  const resolved = ref ?? "HEAD";
  const head = await gitLine(dir, ["rev-parse", "--verify", "--quiet", `${resolved}^{commit}`], gitOptions);
  if (head === null || head.length === 0) {
    return { head: null, files: [], error: `${dir} is not a git repo with a commit to read.` };
  }

  // One `ls-tree` for every path: which of them the commit holds, and as what.
  // Literal pathspecs, so a name with `*` or a leading `:(` is only a name.
  const listed = await gitIn(
    dir,
    ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", head, "--", ...paths.map((file) => `${prefix}${file}`)],
    gitOptions,
  );
  if (listed.code !== 0) return { head, files: [], error: firstProblemLine(listed) };
  const blobs = new Map<string, string>();
  for (const entry of splitNul(listed.stdout)) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/su.exec(entry);
    if (match === null || match[2] !== "blob" || !REGULAR_FILE_MODES.has(match[1])) continue;
    blobs.set(match[4], match[3]);
  }

  const files: CommittedFiles["files"] = [];
  const tooLarge: string[] = [];
  for (const file of paths) {
    const object = blobs.get(`${prefix}${file}`);
    if (object === undefined) {
      files.push({ path: file, content: null });
      continue;
    }
    // Room for the limit in the widest UTF-8, plus one byte to tell "exactly
    // at the limit" from "over it".
    const read = await gitIn(dir, ["cat-file", "blob", object], { ...gitOptions, maxBytes: maxChars * 3 + 1 });
    if (read.code !== 0) return { head, files: [], error: firstProblemLine(read) };
    if (read.truncated || read.stdout.length > maxChars) {
      tooLarge.push(file);
      files.push({ path: file, content: null });
      continue;
    }
    files.push({ path: file, content: read.stdout });
  }
  const error =
    tooLarge.length === 0
      ? null
      : `Larger than ${maxChars} characters, so not read: ${tooLarge.join(", ")}`.slice(0, 2000);
  return { head, files, error };
}

/**
 * Replace `repos.json` in the canonical checkout and publish it.
 *
 * Runs host-side, so it works while the agent is sandboxed — this is the write
 * behind `workspace_add_repo`, `bb repos add`/`remove`, the discovery seed and
 * the panel's editor. For a primary the commit and the publish are the shared
 * {@link publishDefinition} step; for a plain directory the file is written in
 * place and nothing is published, and the result says so.
 */
export async function writeReposJson(
  dir: string,
  text: string,
  message: string,
  signal?: AbortSignal,
  layout: ProjectLayout = "primary",
  policy?: PublishPolicy,
): Promise<{
  ok: boolean;
  committed: boolean;
  head: string | null;
  message: string | null;
  mode: WriteMode;
  prUrl: string | null;
}> {
  if (layout === "directory") {
    const target = path.join(dir, PROJECT_SOURCE_DIR, REPOS_FILE);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
    } catch (error) {
      return {
        ok: false,
        committed: false,
        head: null,
        message: error instanceof Error ? error.message : String(error),
        mode: "none",
        prUrl: null,
      };
    }
    return {
      ok: true,
      committed: false,
      head: null,
      message: `Wrote ${PROJECT_SOURCE_DIR}/${REPOS_FILE} in place. This project is a plain directory, so nothing is published.`,
      mode: "none",
      prUrl: null,
    };
  }
  const result = await publishDefinition({
    kind: "content",
    dir,
    layout,
    policy,
    path: REPOS_FILE,
    content: text,
    message,
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    ok: result.ok,
    committed: result.committed,
    head: result.head,
    message: result.message,
    mode: result.mode,
    prUrl: result.prUrl,
  };
}

/* ------------------------------------------------------- the publish step */

export interface PublishContentRequest {
  kind: "content";
  /** The canonical `.bb` checkout. */
  dir: string;
  layout: ProjectLayout;
  /** The project's `publish` policy, or undefined for the layout defaults. */
  policy: PublishPolicy | undefined;
  /** The `.bb`-relative path being written. */
  path: string;
  /** The file's new content. */
  content: string;
  /** The commit message, and the pull request title. */
  message: string;
  signal?: AbortSignal;
}

export interface PublishBranchRequest {
  kind: "branch";
  dir: string;
  layout: ProjectLayout;
  policy: PublishPolicy | undefined;
  /** The `.bb`-relative path the branch changes, for the policy lookup. */
  path: string;
  /** A local branch (short name) that already holds the commit. */
  branch: string;
  message: string;
  signal?: AbortSignal;
}

export type PublishRequest = PublishContentRequest | PublishBranchRequest;

export interface PublishResult {
  ok: boolean;
  mode: PublishMode;
  /** Whether a new commit was created for this write. */
  committed: boolean;
  /** The commit that holds the change. */
  head: string | null;
  /** The branch pushed to `origin`, short name, or null when nothing was pushed. */
  branch: string | null;
  /** The pull request opened or found, for `pull-request`. */
  prUrl: string | null;
  /** Why the publish failed, or a note; null on a clean success. */
  message: string | null;
}

interface GitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

interface CommitOutcome {
  committed: boolean;
  head: string | null;
  message: string | null;
}

/** The `guidance-` branch name for a thread id or a definition path. */
export function guidanceBranchName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60);
  return `guidance-${safe.length > 0 ? safe : "bb"}`;
}

/** The project's `publish` policy as committed in `repos.json`, or undefined. */
export async function projectPublishPolicy(
  dir: string,
  layout: ProjectLayout,
  signal?: AbortSignal,
): Promise<PublishPolicy | undefined> {
  const text = await readReposJson(dir, layout, signal);
  if (text === null) return undefined;
  const parsed = parseReposFile(text);
  return parsed.ok ? parsed.value.publish : undefined;
}

/**
 * Publish one committed `.bb` write to `origin`, by the project's policy.
 *
 * This is the single step every write path goes through — the Repos panel,
 * `bb repos add`/`remove`/base-branch, `workspace_add_repo`/`remove_repo`, the
 * raw `repos.json` editor, the discovery seed and `mergeGuidance`. It resolves
 * the mode for the path from the policy and the layout, commits if it has
 * content to commit, then either pushes the default branch (`push`), pushes a
 * `guidance-` branch and opens a pull request (`pull-request`), or opens the
 * pull request and merges it in the same step (`merge`, the `repos.json`
 * default).
 *
 * Failure is loud and local: a rejected push, a failed `gh pr create` or a
 * refused merge leaves the commit exactly where it was, moves nothing back, and
 * never force-pushes.
 */
export async function publishDefinition(request: PublishRequest): Promise<PublishResult> {
  const mode = resolvePublishMode(request.policy, request.layout, request.path);
  const options: GitOptions = {
    timeoutMs: PUBLISH_TIMEOUT_MS,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
  const hasRemote = (await projectSourceRemote(request.dir, request.signal)) !== null;
  // Refresh origin's refs and prune branches deleted upstream before deciding
  // where a guidance branch starts: a stale remote-tracking ref would make a
  // deleted branch look open and stack already-merged commits (BB-340). A
  // failed fetch is not fatal; the push that follows reports the real problem.
  if (hasRemote) {
    await gitIn(request.dir, ["fetch", "--quiet", "--prune", "origin"], options).catch(() => undefined);
  }
  const base = await resolveDefaultBranchRef(request.dir, request.signal);
  if (base === null) {
    return {
      ok: false,
      mode,
      committed: false,
      head: null,
      branch: null,
      prUrl: null,
      message: `${request.dir} has no default branch to publish against.`,
    };
  }
  const baseName = base.replace(/^refs\/(heads|remotes\/origin)\//u, "");
  if (mode === "push") return publishByPush(request, base, baseName, hasRemote, options);
  if (mode === "merge") return publishByMerge(request, base, baseName, hasRemote, options);
  return publishByPullRequest(request, base, baseName, hasRemote, options);
}

async function publishByPush(
  request: PublishRequest,
  base: string,
  baseName: string,
  hasRemote: boolean,
  options: GitOptions,
): Promise<PublishResult> {
  const mode: PublishMode = "push";
  const failure = (message: string, head: string | null = null, committed = false): PublishResult => ({
    ok: false,
    mode,
    committed,
    head,
    branch: null,
    prUrl: null,
    message,
  });
  let outcome: CommitOutcome;
  let target = baseName;
  if (request.kind === "content") {
    const relative = `${DEFINITION_PREFIX}${request.path}`;
    const current = await gitLine(request.dir, ["rev-parse", "--abbrev-ref", "HEAD"], options);
    outcome =
      current === baseName
        ? await commitContentInPlace(request.dir, relative, request.content, request.message, request.signal, options)
        : await commitContentOnBranch({
            dir: request.dir,
            base,
            branchRef: `refs/heads/${baseName}`,
            relative,
            content: request.content,
            message: request.message,
            signal: request.signal,
            options,
          });
  } else {
    const current = await gitLine(request.dir, ["rev-parse", "--abbrev-ref", "HEAD"], options);
    if (current === null || current === "HEAD") {
      return failure(`${request.dir} has a detached HEAD; check out a branch first.`);
    }
    target = current;
    const merged = await gitIn(request.dir, ["merge", "--ff-only", "--quiet", request.branch], options);
    if (merged.code !== 0) {
      return failure(`Could not fast-forward ${current} to ${request.branch}: ${firstProblemLine(merged)}`);
    }
    outcome = { committed: true, head: await gitLine(request.dir, ["rev-parse", "HEAD"], options), message: null };
  }
  if (outcome.message !== null) return failure(outcome.message, outcome.head, outcome.committed);
  if (!outcome.committed) {
    return {
      ok: true,
      mode,
      committed: false,
      head: outcome.head,
      branch: null,
      prUrl: null,
      message: "Nothing to commit; the change was already in place.",
    };
  }
  if (!hasRemote) {
    return {
      ok: true,
      mode,
      committed: true,
      head: outcome.head,
      branch: null,
      prUrl: null,
      message: "No origin remote; the change is committed locally only.",
    };
  }
  const pushed = await pushRefToOrigin(request.dir, target, options);
  if (pushed !== null) {
    return failure(`The commit is on ${target} locally but pushing it to origin failed: ${pushed}`, outcome.head, true);
  }
  return { ok: true, mode, committed: true, head: outcome.head, branch: target, prUrl: null, message: null };
}

async function publishByPullRequest(
  request: PublishRequest,
  base: string,
  baseName: string,
  hasRemote: boolean,
  options: GitOptions,
): Promise<PublishResult> {
  const mode: PublishMode = "pull-request";
  let note: string | null = null;
  const failure = (message: string, head: string | null = null, branch: string | null = null): PublishResult => ({
    ok: false,
    mode,
    committed: head !== null,
    head,
    branch,
    prUrl: null,
    message: withNote(message, note),
  });
  let head: string | null;
  let branchName: string;
  if (request.kind === "content") {
    branchName = guidanceBranchName(request.path);
    const relative = `${DEFINITION_PREFIX}${request.path}`;
    // Stack on the branch's own tip when it is still open, but rebuild it from
    // the default branch when it is already merged or gone from origin. A
    // stale tip must never be stacked on: the push would carry already-merged
    // commits and the pull request would describe the wrong net change.
    const guidance = await resolveGuidanceBase({ dir: request.dir, branchName, base, baseName, hasRemote, options });
    note = backupNote(branchName, guidance.backupRef);
    const outcome = await commitContentOnBranch({
      dir: request.dir,
      base: guidance.base,
      branchRef: `refs/heads/${branchName}`,
      relative,
      content: request.content,
      message: request.message,
      signal: request.signal,
      options,
    });
    if (outcome.message !== null) return failure(outcome.message, outcome.head, branchName);
    if (!outcome.committed) {
      return {
        ok: true,
        mode,
        committed: false,
        head: outcome.head,
        branch: null,
        prUrl: null,
        message: withNote("Nothing to commit; the change was already in place.", note),
      };
    }
    head = outcome.head;
  } else {
    branchName = request.branch;
    head = await gitLine(request.dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}^{commit}`], options);
    if (head === null) return failure(`No branch ${branchName} has been published; publish it first.`, null, branchName);
  }
  // No remote means no push and no pull request. The branch commit is kept,
  // and the error says what to change; the default branch is never moved.
  if (!hasRemote) {
    return failure(
      `This project has no origin remote to open a pull request against; the commit is on ${branchName} locally. Set \`publish\` to \`push\` or add one.`,
      head,
      branchName,
    );
  }
  const pushed = await pushRefToOrigin(request.dir, branchName, options);
  if (pushed !== null) {
    return failure(`The commit is on ${branchName} locally but pushing it to origin failed: ${pushed}`, head, branchName);
  }
  const pr = await openOrFindPullRequest({
    dir: request.dir,
    branch: branchName,
    base: baseName,
    title: request.message,
    body: await pullRequestBody(request, base, head, options),
    signal: request.signal,
    options,
  });
  if (!pr.ok) {
    return failure(`The branch ${branchName} is pushed but opening the pull request failed: ${pr.message}`, head, branchName);
  }
  return { ok: true, mode, committed: true, head, branch: branchName, prUrl: pr.url, message: note };
}

/**
 * Open a pull request and merge it in the same step, the `repos.json` default.
 *
 * A fresh branch is cut from the default branch, pushed, opened as a pull
 * request, and squash-merged with `gh pr merge --squash --delete-branch` once
 * its required checks have finished (a skipped required check counts as
 * passing). No bypass flag is ever passed, so whatever the ruleset or a
 * required check refuses is the fallback: the pull request is left open and
 * its URL and the refusal are reported. After a successful merge the canonical
 * checkout's default branch is fast-forwarded and the local guidance branch is
 * deleted.
 */
async function publishByMerge(
  request: PublishRequest,
  base: string,
  baseName: string,
  hasRemote: boolean,
  options: GitOptions,
): Promise<PublishResult> {
  const mode: PublishMode = "merge";
  let note: string | null = null;
  const failure = (
    message: string,
    head: string | null = null,
    branch: string | null = null,
    prUrl: string | null = null,
  ): PublishResult => ({
    ok: false,
    mode,
    committed: head !== null,
    head,
    branch,
    prUrl,
    message: withNote(message, note),
  });
  let head: string | null;
  let branchName: string;
  if (request.kind === "content") {
    branchName = guidanceBranchName(request.path);
    const relative = `${DEFINITION_PREFIX}${request.path}`;
    const guidance = await resolveGuidanceBase({ dir: request.dir, branchName, base, baseName, hasRemote, options });
    note = backupNote(branchName, guidance.backupRef);
    const outcome = await commitContentOnBranch({
      dir: request.dir,
      base: guidance.base,
      branchRef: `refs/heads/${branchName}`,
      relative,
      content: request.content,
      message: request.message,
      signal: request.signal,
      options,
    });
    if (outcome.message !== null) return failure(outcome.message, outcome.head, branchName);
    if (!outcome.committed) {
      return {
        ok: true,
        mode,
        committed: false,
        head: outcome.head,
        branch: null,
        prUrl: null,
        message: withNote("Nothing to commit; the change was already in place.", note),
      };
    }
    head = outcome.head;
  } else {
    branchName = request.branch;
    head = await gitLine(request.dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}^{commit}`], options);
    if (head === null) return failure(`No branch ${branchName} has been published; publish it first.`, null, branchName);
  }
  if (!hasRemote) {
    return failure(
      `This project has no origin remote to merge into; the commit is on ${branchName} locally. Set \`publish\` to \`push\` or add one.`,
      head,
      branchName,
    );
  }
  const pushed = await pushRefToOrigin(request.dir, branchName, options);
  if (pushed !== null) {
    return failure(`The commit is on ${branchName} locally but pushing it to origin failed: ${pushed}`, head, branchName);
  }
  const pr = await openOrFindPullRequest({
    dir: request.dir,
    branch: branchName,
    base: baseName,
    title: request.message,
    body: await pullRequestBody(request, base, head, options),
    signal: request.signal,
    options,
  });
  if (!pr.ok) {
    return failure(`The branch ${branchName} is pushed but opening the pull request failed: ${pr.message}`, head, branchName);
  }
  const merged = await mergePullRequest({ dir: request.dir, branch: branchName, signal: request.signal, options });
  if (!merged.ok) {
    return failure(`The pull request was left open: ${merged.message}`, head, branchName, pr.url);
  }
  // The merge landed on origin; the local fast-forward and the branch cleanup
  // are best-effort and never undo it.
  const forward = await fastForwardDefaultBranch(request.dir, baseName, options);
  await deleteLocalBranch(request.dir, branchName, options);
  const mergeNote = withNote(
    forward === null ? null : `The canonical checkout could not be fast-forwarded: ${forward}`,
    note,
  );
  return { ok: true, mode, committed: true, head, branch: branchName, prUrl: pr.url, message: mergeNote };
}

/** Append a note to a message, tolerating either being absent. */
function withNote(message: string | null, note: string | null): string | null {
  if (message === null || message.length === 0) return note;
  if (note === null || note.length === 0) return message;
  return `${message} ${note}`;
}

/** The sentence a result carries when unmerged commits were moved to a backup ref. */
function backupNote(branchName: string, backupRef: string | null): string | null {
  return backupRef === null
    ? null
    : `The unmerged ${branchName} was kept at ${backupRef}; a fresh branch was cut from the default branch.`;
}

interface GuidanceBase {
  /** The commit the new branch is based on. */
  base: string;
  /** A local ref holding commits that would otherwise be dropped, or null. */
  backupRef: string | null;
}

/**
 * Where a `guidance-` branch should be based, given what happened to it before.
 *
 * The rule (BB-340 deliverable 2): a branch whose tip is already an ancestor
 * of `origin/<default>` was merged, and one that is gone from origin without
 * being merged was a closed pull request or a failed push. Neither may be
 * stacked on — the first would carry already-merged commits, the second is not
 * on origin at all. In both cases the branch starts fresh from the default
 * branch. A branch that is gone from origin but still holds unmerged commits
 * is kept under a backup ref first, named in the result, so nothing is
 * discarded. Only a branch that is still open on origin is stacked on.
 */
async function resolveGuidanceBase(args: {
  dir: string;
  branchName: string;
  base: string;
  baseName: string;
  hasRemote: boolean;
  options: GitOptions;
}): Promise<GuidanceBase> {
  const { dir, branchName, base, baseName, hasRemote, options } = args;
  const localRef = `refs/heads/${branchName}`;
  const localTip = await gitLine(dir, ["rev-parse", "--verify", "--quiet", `${localRef}^{commit}`], options);
  if (localTip === null || localTip.length === 0) return { base, backupRef: null };
  if (!hasRemote) return { base: localTip, backupRef: null };
  const originDefault = `refs/remotes/origin/${baseName}`;
  if (await refExists(dir, originDefault, args.options.signal)) {
    const merged = await gitIn(dir, ["merge-base", "--is-ancestor", localTip, originDefault], options);
    if (merged.code === 0) return { base, backupRef: null };
  }
  const originBranch = `refs/remotes/origin/${branchName}`;
  const originTip = await gitLine(dir, ["rev-parse", "--verify", "--quiet", `${originBranch}^{commit}`], options);
  if (originTip === null || originTip.length === 0) {
    const backupRef = `refs/heads/${branchName}-backup-${localTip.slice(0, 8)}`;
    const saved = await gitIn(dir, ["update-ref", backupRef, localTip], options);
    // If the backup itself fails, keep the commits where they are rather than
    // resetting over them.
    return saved.code === 0 ? { base, backupRef } : { base: localTip, backupRef: null };
  }
  if (originTip === localTip) return { base: localTip, backupRef: null };
  // The two tips can differ if the branch was pushed elsewhere; base on the
  // descendant so the push stays a fast-forward either way.
  const localIsAncestor = await gitIn(dir, ["merge-base", "--is-ancestor", localTip, originTip], options);
  return localIsAncestor.code === 0 ? { base: originTip, backupRef: null } : { base: localTip, backupRef: null };
}

/** The pull request body: what the publish is, and the branch's net change. */
async function pullRequestBody(
  request: PublishRequest,
  base: string,
  head: string | null,
  options: GitOptions,
): Promise<string> {
  const lines = [`Publishes \`.bb/${request.path}\` for review, by the project's publish policy (BB-340).`];
  const stat = head === null ? null : await gitLine(request.dir, ["diff", "--stat", base, head], options);
  if (stat !== null && stat.trim().length > 0) {
    lines.push("", "Net change against the default branch:", "", "```", stat.trim(), "```");
  }
  return lines.join("\n");
}

/**
 * Squash-merge an open pull request, once its required checks have finished.
 *
 * Plain `gh pr merge --squash --delete-branch`, never `--admin` or any other
 * bypass: whatever the ruleset or a required check refuses is reported and the
 * pull request is left open. A skipped required check counts as passing.
 */
async function mergePullRequest(args: {
  dir: string;
  branch: string;
  signal?: AbortSignal;
  options: GitOptions;
}): Promise<{ ok: boolean; message: string | null }> {
  const common = {
    cwd: args.dir,
    timeoutMs: args.options.timeoutMs,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  };
  try {
    await waitForRequiredChecks(args.dir, args.branch, args.signal, args.options);
    const merged = await run("gh", ["pr", "merge", args.branch, "--squash", "--delete-branch"], common);
    return merged.code === 0 ? { ok: true, message: null } : { ok: false, message: firstProblemLine(merged) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, message: "The gh CLI is not installed on this machine." };
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Wait briefly for the pull request's checks to finish before merging.
 *
 * A failed `gh pr view` is not an error here: the merge attempt that follows
 * reports the real reason. A check is pending while its `status` is not
 * `COMPLETED` or its legacy `state` is still waiting; a `SKIPPED` conclusion is
 * complete and therefore passes.
 */
async function waitForRequiredChecks(
  dir: string,
  branch: string,
  signal: AbortSignal | undefined,
  options: GitOptions,
): Promise<void> {
  const common = { cwd: dir, timeoutMs: options.timeoutMs, ...(signal === undefined ? {} : { signal }) };
  const deadline = Date.now() + MERGE_WAIT_MS;
  while (Date.now() < deadline) {
    const view = await run("gh", ["pr", "view", branch, "--json", "statusCheckRollup"], common);
    if (view.code !== 0) return;
    let pending = false;
    try {
      const json = JSON.parse(view.stdout) as { statusCheckRollup?: Array<Record<string, unknown>> };
      pending = (json.statusCheckRollup ?? []).some(isCheckPending);
    } catch {
      return;
    }
    if (!pending) return;
    await sleep(MERGE_POLL_MS, signal);
  }
}

/** Whether a `statusCheckRollup` entry is still running. */
function isCheckPending(check: Record<string, unknown>): boolean {
  const status = typeof check.status === "string" ? check.status.toUpperCase() : null;
  if (status !== null && status !== "COMPLETED") return true;
  const state = typeof check.state === "string" ? check.state.toUpperCase() : null;
  return state !== null && ["PENDING", "EXPECTED", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED"].includes(state);
}

/** A cancellable sleep. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Fast-forward the canonical checkout's default branch to `origin/<default>`
 * after a merge. Returns a problem sentence, or null on success. The local
 * branch is only moved when the move is a fast-forward; a diverged branch is
 * left exactly where it is.
 */
async function fastForwardDefaultBranch(dir: string, baseName: string, options: GitOptions): Promise<string | null> {
  const fetched = await gitIn(dir, ["fetch", "--quiet", "origin"], options);
  if (fetched.code !== 0) return firstProblemLine(fetched);
  const originRef = `refs/remotes/origin/${baseName}`;
  const localRef = `refs/heads/${baseName}`;
  const originTip = await gitLine(dir, ["rev-parse", "--verify", "--quiet", `${originRef}^{commit}`], options);
  if (originTip === null) return `${originRef} is not present after the fetch.`;
  const localTip = await gitLine(dir, ["rev-parse", "--verify", "--quiet", `${localRef}^{commit}`], options);
  if (localTip === originTip) return null;
  const current = await gitLine(dir, ["rev-parse", "--abbrev-ref", "HEAD"], options);
  if (current === baseName) {
    const merged = await gitIn(dir, ["merge", "--ff-only", "--quiet", originRef], options);
    return merged.code === 0 ? null : firstProblemLine(merged);
  }
  if (localTip !== null) {
    const ancestor = await gitIn(dir, ["merge-base", "--is-ancestor", localTip, originTip], options);
    if (ancestor.code !== 0) return `${localRef} has diverged from ${originRef}.`;
  }
  const updated = await gitIn(dir, ["update-ref", localRef, originTip], options);
  return updated.code === 0 ? null : firstProblemLine(updated);
}

/** Delete a local guidance branch after a successful merge; best-effort. */
async function deleteLocalBranch(dir: string, branchName: string, options: GitOptions): Promise<void> {
  await gitIn(dir, ["branch", "-D", branchName], options).catch(() => undefined);
}

/** Write, stage and commit `content` at `relative` on the checked-out branch. */
async function commitContentInPlace(
  dir: string,
  relative: string,
  content: string,
  message: string,
  signal: AbortSignal | undefined,
  options: GitOptions,
): Promise<CommitOutcome> {
  const target = path.join(dir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  await gitIn(dir, ["add", "--", relative], options);
  return commitAll(dir, message, signal);
}

/**
 * Commit `content` at `relative` on `branchRef`, based on `base`, without
 * touching the checked-out branch or the working tree.
 *
 * A temporary detached worktree at `base` gets the content, one commit is
 * made, and the branch ref is pointed at it. This is the same pattern
 * `pushGuidancePrimary` uses, and it is what keeps a `pull-request` publish
 * from moving the default branch.
 */
async function commitContentOnBranch(args: {
  dir: string;
  base: string;
  branchRef: string;
  relative: string;
  content: string;
  message: string;
  signal?: AbortSignal;
  options: GitOptions;
}): Promise<CommitOutcome> {
  const worktree = await mkdtemp(path.join(tmpdir(), "bb-publish-"));
  try {
    const added = await gitIn(args.dir, ["worktree", "add", "--detach", "--force", worktree, args.base], args.options);
    if (added.code !== 0) return { committed: false, head: null, message: firstProblemLine(added) };
    const target = path.join(worktree, args.relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, args.content, "utf8");
    await gitIn(worktree, ["add", "--", args.relative], args.options);
    const commit = await commitAll(worktree, args.message, args.signal);
    if (!commit.committed || commit.head === null) {
      return { committed: false, head: null, message: commit.message };
    }
    const updated = await gitIn(args.dir, ["update-ref", args.branchRef, commit.head], args.options);
    if (updated.code !== 0) return { committed: false, head: null, message: firstProblemLine(updated) };
    return { committed: true, head: commit.head, message: null };
  } finally {
    await gitIn(args.dir, ["worktree", "remove", "--force", worktree], args.options).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Push one local branch to `origin` under its own name. Never force.
 *
 * A rejected non-fast-forward push is a person's to resolve, and a failed push
 * must leave the local commit exactly where it is. Returns the error text, or
 * null on success.
 */
async function pushRefToOrigin(dir: string, branch: string, options: GitOptions): Promise<string | null> {
  const pushed = await gitIn(dir, ["push", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`], options);
  return pushed.code === 0 ? null : firstProblemLine(pushed);
}

/**
 * Open a pull request for `branch` against `base`, or return the one already
 * open for that head.
 *
 * A second panel edit pushes onto the same `guidance-` branch, so a PR for it
 * already exists; `gh pr create` would fail on that, and the right answer is
 * the existing URL, not an error. The existing pull request's title and body
 * are rewritten to describe the net change rather than keeping the first
 * commit's title (BB-340 deliverable 3).
 */
async function openOrFindPullRequest(args: {
  dir: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  signal?: AbortSignal;
  options: GitOptions;
}): Promise<{ ok: boolean; url: string | null; message: string | null }> {
  const common = {
    cwd: args.dir,
    timeoutMs: args.options.timeoutMs,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  };
  try {
    const listed = await run(
      "gh",
      ["pr", "list", "--head", args.branch, "--state", "open", "--json", "url", "--limit", "1"],
      common,
    );
    // A failed list is reported as itself. Falling through to `pr create`
    // would replace it with "a pull request already exists" when one does.
    if (listed.code !== 0) {
      return { ok: false, url: null, message: `Could not check for an existing pull request: ${firstProblemLine(listed)}` };
    }
    const existing = firstPullRequestUrl(listed.stdout);
    if (existing !== null) {
      const updated = await editPullRequest({ ...args, common });
      return updated === null
        ? { ok: true, url: existing, message: null }
        : { ok: false, url: existing, message: `Could not update the open pull request: ${updated}` };
    }
    const bodyDir = await mkdtemp(path.join(tmpdir(), "bb-pr-"));
    const bodyPath = path.join(bodyDir, "body.md");
    await writeFile(bodyPath, args.body, "utf8");
    try {
      const created = await run(
        "gh",
        ["pr", "create", "--base", args.base, "--head", args.branch, "--title", args.title, "--body-file", bodyPath],
        common,
      );
      if (created.code !== 0) return { ok: false, url: null, message: firstProblemLine(created) };
      return { ok: true, url: parseCreatedUrl(created.stdout), message: null };
    } finally {
      await rm(bodyDir, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, url: null, message: "The gh CLI is not installed on this machine." };
    return { ok: false, url: null, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Rewrite an open pull request's title and body; returns an error, or null. */
async function editPullRequest(args: {
  dir: string;
  branch: string;
  title: string;
  body: string;
  common: RunOptions;
}): Promise<string | null> {
  const bodyDir = await mkdtemp(path.join(tmpdir(), "bb-pr-"));
  const bodyPath = path.join(bodyDir, "body.md");
  await writeFile(bodyPath, args.body, "utf8");
  try {
    const edited = await run(
      "gh",
      ["pr", "edit", args.branch, "--title", args.title, "--body-file", bodyPath],
      args.common,
    );
    return edited.code === 0 ? null : firstProblemLine(edited);
  } finally {
    await rm(bodyDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The first URL in `gh pr list --json url`'s output, or null. */
function firstPullRequestUrl(stdout: string): string | null {
  try {
    const json: unknown = JSON.parse(stdout);
    if (!Array.isArray(json)) return null;
    for (const entry of json) {
      if (typeof entry === "object" && entry !== null && typeof (entry as { url?: unknown }).url === "string") {
        return (entry as { url: string }).url;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Publish a thread's `.bb` commits back to the canonical checkout.
 *
 * The direction is inverted deliberately. The canonical checkout is outside
 * the agent's sandbox, so the agent cannot push to it; instead the *canonical*
 * repo fetches from the workspace clone, and the call is initiated by this
 * plugin's host entry, which is not sandboxed. Landing the commits on
 * `refs/heads/guidance-<threadId>` rather than the checked-out branch also
 * sidesteps `receive.denyCurrentBranch` — and leaves a named branch a person
 * can review and merge like any other.
 */
export async function pushGuidance(
  projectSourcePath: string,
  workspaceBbPath: string,
  threadId: string,
  signal?: AbortSignal,
  definitionBase?: string | null,
): Promise<{ ok: boolean; ref: string | null; message: string }> {
  const layout = await detectProjectLayout(projectSourcePath, signal);
  if (layout === "directory") {
    return {
      ok: true,
      ref: null,
      // The workspace's `.bb` is a symlink straight to the project directory's
      // `.bb/`, so an edit under it is already the project's file. There is no
      // commit and no branch to publish.
      message: `${workspaceBbPath} is a plain directory's .bb/: the files are already in place in ${projectSourcePath}. Nothing is published.`,
    };
  }
  return pushGuidancePrimary(projectSourcePath, workspaceBbPath, threadId, signal, definitionBase ?? null);
}

/**
 * Publish the workspace's `.bb` edits as a `guidance-<thread>` branch of the
 * primary repo, without touching the default branch.
 *
 * The default branch is reviewed like code, so it is not fast-forwarded here.
 * A throwaway worktree at the default branch gets the workspace's `.bb`
 * content (the primary clone's working tree, through the workspace link) in
 * place of the checkout's, one commit is made on it, and the ref is written
 * into the canonical checkout. The thread's own branch is not touched: its
 * `.bb/` edits may also travel with its code in a pull request, and this is
 * the way to send them on their own. A person (or BB-108) turns that branch
 * into a pull request; the default branch only ever moves by merge.
 */
async function pushGuidancePrimary(
  projectSourcePath: string,
  workspaceBbPath: string,
  threadId: string,
  signal?: AbortSignal,
  definitionBase?: string | null,
): Promise<{ ok: boolean; ref: string | null; message: string }> {
  const ref = guidanceRef(threadId);
  const options = { timeoutMs: FETCH_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  const base = await resolveDefaultBranchRef(projectSourcePath, signal);
  if (base === null) {
    return { ok: false, ref: null, message: `${projectSourcePath} has no default branch to publish against.` };
  }
  const warnings: string[] = [];
  // A `.bb/` change merged on the default branch after this workspace was
  // provisioned would be reverted by replacing `.bb/` wholesale, so say so
  // loudly. The guidance branch is still published; the reviewer sees it.
  if (definitionBase !== undefined && definitionBase !== null) {
    const baseTree = await gitLine(projectSourcePath, ["rev-parse", `${definitionBase}:${PROJECT_SOURCE_DIR}`], options);
    const headTree = await gitLine(projectSourcePath, ["rev-parse", `${base}:${PROJECT_SOURCE_DIR}`], options);
    if (baseTree !== null && headTree !== null && baseTree !== headTree) {
      warnings.push(
        ".bb/ on the default branch has changed since this workspace was provisioned; check the guidance branch does not revert those changes.",
      );
    }
  }
  const worktree = await mkdtemp(path.join(tmpdir(), "bb-guidance-"));
  try {
    const added = await gitIn(projectSourcePath, ["worktree", "add", "--detach", "--force", worktree, base], options);
    if (added.code !== 0) return { ok: false, ref: null, message: firstProblemLine(added) };
    await rm(path.join(worktree, PROJECT_SOURCE_DIR), { recursive: true, force: true });
    // `dereference`: the workspace's `.bb` is a symlink into the primary clone,
    // and it is the content behind it that is published, not the link.
    await cp(workspaceBbPath, path.join(worktree, PROJECT_SOURCE_DIR), { recursive: true, dereference: true });
    await gitIn(worktree, ["add", "-A", "--", PROJECT_SOURCE_DIR], options);
    const staged = await gitIn(worktree, ["diff", "--cached", "--quiet"], options);
    let sha: string | null;
    if (staged.code === 0) {
      // Nothing changed relative to the default branch: publish the base so
      // the ref exists, and say so rather than failing.
      sha = await gitLine(projectSourcePath, ["rev-parse", base], options);
      if (sha === null) return { ok: false, ref: null, message: `Could not resolve ${base}.` };
      await gitIn(projectSourcePath, ["update-ref", ref, sha], options);
      return { ok: true, ref, message: [`No .bb changes to publish; ${ref} points at the default branch.`, ...warnings].join(" ") };
    }
    // BB-340: a merge-mode path must never share the guidance branch's commit.
    // `repos.json` is the primary default for `merge`, so when it changed
    // alongside guidance, it is published on its own branch through
    // `publishDefinition` and everything else stays on `guidance-<thread>`.
    const changed = splitNul((await gitIn(worktree, ["diff", "--cached", "--name-only", "-z"], options)).stdout);
    const reposRel = `${PROJECT_SOURCE_DIR}/${REPOS_FILE}`;
    const policy = await projectPublishPolicy(projectSourcePath, "primary", signal);
    if (resolvePublishMode(policy, "primary", REPOS_FILE) === "merge" && changed.includes(reposRel)) {
      const split = await publishSplitGuidance({
        projectSourcePath,
        workspaceBbPath,
        worktree,
        threadId,
        ref,
        policy,
        guidanceChanged: changed.filter((entry) => entry !== reposRel),
        signal,
        options,
      });
      return {
        ok: split.ok,
        ref: split.ref,
        message: [...split.messages, ...warnings].join(" "),
      };
    }
    const commit = await commitAll(worktree, `Publish guidance from ${threadId}`, signal);
    if (!commit.committed || commit.head === null) {
      return { ok: false, ref: null, message: commit.message ?? "Could not commit the guidance." };
    }
    sha = commit.head;
    const updated = await gitIn(projectSourcePath, ["update-ref", ref, sha], options);
    if (updated.code !== 0) return { ok: false, ref: null, message: firstProblemLine(updated) };
    // Publish the branch to origin so a person (or BB-108) can open the pull
    // request without finding the host-data path. Best-effort: a protected or
    // unreachable remote leaves the branch in the local canonical checkout.
    const pushed = await gitIn(projectSourcePath, ["push", "--quiet", "origin", `${ref}:${ref}`], options);
    const pushedNote = pushed.code === 0 ? " It is pushed to origin." : " Push it to origin to open a pull request.";
    return {
      ok: true,
      ref,
      message: [`Published ${sha.slice(0, 8)} to ${ref} in ${projectSourcePath}.${pushedNote}`, ...warnings].join(" "),
    };
  } finally {
    await gitIn(projectSourcePath, ["worktree", "remove", "--force", worktree], options).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Split a workspace `.bb` publish that carries `repos.json` alongside guidance.
 *
 * The `repos.json` half goes through {@link publishDefinition} on its own
 * branch (its policy default is `merge`), so it never rides in the guidance
 * branch's commit. The remaining paths stay on the thread's `guidance-`
 * branch, pushed as before for a person to review. Each half's outcome is
 * reported, and the whole publish is `ok` only when both are.
 */
async function publishSplitGuidance(args: {
  projectSourcePath: string;
  workspaceBbPath: string;
  worktree: string;
  threadId: string;
  ref: string;
  policy: PublishPolicy | undefined;
  guidanceChanged: string[];
  signal?: AbortSignal;
  options: GitOptions;
}): Promise<{ ok: boolean; ref: string | null; messages: string[] }> {
  const messages: string[] = [];
  const reposRel = `${PROJECT_SOURCE_DIR}/${REPOS_FILE}`;
  const content = await readFile(path.join(args.workspaceBbPath, REPOS_FILE), "utf8").catch(() => null);
  if (content === null) {
    return { ok: false, ref: null, messages: [`Could not read ${reposRel} to publish it.`] };
  }
  const repos = await publishDefinition({
    kind: "content",
    dir: args.projectSourcePath,
    layout: "primary",
    policy: args.policy,
    path: REPOS_FILE,
    content,
    message: `Update the repo set from ${args.threadId}`,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (repos.ok) {
    messages.push(repos.prUrl === null ? `Published ${reposRel}.` : `Merged ${repos.prUrl}.`);
    if (repos.message !== null) messages.push(repos.message);
  } else {
    messages.push(
      repos.prUrl === null
        ? `Publishing ${reposRel} failed: ${repos.message ?? "unknown error"}`
        : `The pull request for ${reposRel} was left open at ${repos.prUrl}: ${repos.message ?? "unknown reason"}`,
    );
  }
  let guidanceRef: string | null = null;
  if (args.guidanceChanged.length > 0) {
    // Stage only the guidance paths, so the repos.json change stays out of
    // this commit even though it is still in the worktree.
    await gitIn(args.worktree, ["reset", "--quiet"], args.options);
    await gitIn(args.worktree, ["add", "-A", "--", ...args.guidanceChanged], args.options);
    const commit = await commitAll(args.worktree, `Publish guidance from ${args.threadId}`, args.signal);
    if (!commit.committed || commit.head === null) {
      return { ok: false, ref: null, messages: [...messages, commit.message ?? "Could not commit the guidance."] };
    }
    const updated = await gitIn(args.projectSourcePath, ["update-ref", args.ref, commit.head], args.options);
    if (updated.code !== 0) {
      return { ok: false, ref: null, messages: [...messages, firstProblemLine(updated)] };
    }
    const pushed = await gitIn(args.projectSourcePath, ["push", "--quiet", "origin", `${args.ref}:${args.ref}`], args.options);
    const pushedNote = pushed.code === 0 ? " It is pushed to origin." : " Push it to origin to open a pull request.";
    guidanceRef = args.ref;
    messages.push(`Published ${commit.head.slice(0, 8)} to ${args.ref} in ${args.projectSourcePath}.${pushedNote}`);
  }
  return { ok: repos.ok, ref: guidanceRef, messages };
}

/** The `guidance-<thread>` ref a thread's published commits land on. */
export function guidanceRef(threadId: string): string {
  return `refs/heads/${guidanceBranchName(threadId)}`;
}

/** Whitespace-normalised text, so a lesson matches however the playbook wraps it. */
const normalized = (text: string) => text.replace(/\s+/gu, " ").trim();

export interface MergeGuidanceResult {
  ok: boolean;
  sha: string | null;
  branch: string | null;
  message: string;
}

/**
 * Publish a thread's published guidance branch to `origin`, by the policy.
 *
 * {@link pushGuidance} lands a thread's `.bb` commits on
 * `guidance-<threadId>`. This is the other half: it checks that the branch is
 * a fast-forward that adds only `file` and carries `text`, then hands it to
 * {@link publishDefinition}. Under `push` the canonical checkout's default
 * branch is fast-forwarded and pushed; under `pull-request` the branch is
 * pushed and a pull request is opened, and the default branch is not moved.
 * It refuses a detached HEAD, a dirty working tree, a non-fast-forward, a
 * commit range that changes anything but `file`, or a `file` that does not
 * carry `text` — and on any refusal it leaves the branch exactly where it is.
 */
export async function mergeGuidance(
  projectSourcePath: string,
  threadId: string,
  file: string,
  text: string,
  signal?: AbortSignal,
): Promise<MergeGuidanceResult> {
  const layout = await detectProjectLayout(projectSourcePath, signal);
  if (layout === "directory") {
    // The workspace's `.bb` symlinks straight to the project directory, so the
    // lesson is already on disk there. Verify it carries the text and stop;
    // there is no branch to fast-forward and nothing to publish.
    const content = await readDefinitionFileFromDisk(projectSourcePath, file, 2_000_000);
    if (content === null) {
      return { ok: false, sha: null, branch: null, message: `${PROJECT_SOURCE_DIR}/${file} is not in ${projectSourcePath}.` };
    }
    if (!normalized(content).includes(normalized(text))) {
      return { ok: false, sha: null, branch: null, message: `${PROJECT_SOURCE_DIR}/${file} does not carry the lesson text; write it, then try again.` };
    }
    return {
      ok: true,
      sha: null,
      branch: null,
      message: `${PROJECT_SOURCE_DIR}/${file} is already in place in ${projectSourcePath}; this is a plain directory, so nothing is published.`,
    };
  }
  const branch = guidanceRef(threadId);
  const options = { timeoutMs: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  const refuse = (message: string): MergeGuidanceResult => ({ ok: false, sha: null, branch, message });

  const head = await gitLine(projectSourcePath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], options);
  if (head === null || head.length === 0) return refuse(`${projectSourcePath} is not a git repo with a commit to publish from.`);
  const current = await gitLine(projectSourcePath, ["rev-parse", "--abbrev-ref", "HEAD"], options);
  if (current === null || current === "HEAD") return refuse(`${projectSourcePath} has a detached HEAD; check out a branch first.`);

  const status = await gitIn(projectSourcePath, ["status", "--porcelain"], options);
  if (status.code !== 0) return refuse(firstProblemLine(status));
  if (status.stdout.trim() !== "") return refuse(`The canonical checkout has uncommitted changes; commit or stash them, then try again.`);

  const ref = await gitLine(projectSourcePath, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], options);
  if (ref === null || ref.length === 0) return refuse(`No guidance branch ${branch} has been published; publish it first.`);

  const ancestor = await gitIn(projectSourcePath, ["merge-base", "--is-ancestor", head, ref], options);
  if (ancestor.code !== 0) return refuse(`${branch} is not a fast-forward of ${current}; merge it by hand.`);

  const changed = await gitIn(projectSourcePath, ["diff", "--name-only", "-z", head, ref], options);
  if (changed.code !== 0) return refuse(firstProblemLine(changed));
  const paths = splitNul(changed.stdout);
  if (paths.length === 0) return refuse(`${branch} has no commits beyond ${current}; there is nothing to merge.`);
  const other = paths.filter((path) => path !== file);
  if (other.length > 0) {
    return refuse(`${branch} changes files other than ${file}: ${other.slice(0, 5).join(", ")}. Merge it by hand.`);
  }

  const content = await gitIn(projectSourcePath, ["show", `${ref}:${file}`], { ...options, maxBytes: 2_000_000 });
  if (content.code !== 0) return refuse(`${file} is not in ${branch}.`);
  if (!normalized(content.stdout).includes(normalized(text))) return refuse(`${file} in ${branch} does not carry the lesson text; commit it, then try again.`);

  const policy = await projectPublishPolicy(projectSourcePath, layout, signal);
  const published = await publishDefinition({
    kind: "branch",
    dir: projectSourcePath,
    layout,
    policy,
    path: file,
    branch: guidanceBranchName(threadId),
    message: `Guidance from ${threadId}`,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!published.ok) return refuse(published.message ?? "The lesson could not be published.");
  const note = published.message === null ? "" : ` ${published.message}`;
  return {
    ok: true,
    sha: published.head,
    branch,
    message:
      published.mode === "push"
        ? `Fast-forwarded ${current} to ${published.head?.slice(0, 8) ?? "the lesson"} from ${branch}.${note}`
        : `Opened ${published.prUrl ?? "a pull request"} for ${branch}; the default branch moves when it merges.`,
  };
}

export interface PreparePrimaryProjectSourceArgs {
  /** URL or local path of the primary repo. */
  url: string;
  /** Where the primary clone lives; cloned when absent, fetched when present. */
  path: string;
  /** The other repos to seed `.bb/repos.json` with when it is absent. */
  seed: ReposFile;
  /** Branch the seed commit is published on. */
  branch: string;
  openPullRequest: boolean;
  signal?: AbortSignal;
}

export interface PreparePrimaryProjectSourceResult {
  ok: boolean;
  layout: ProjectLayout;
  seeded: boolean;
  prUrl: string | null;
  warnings: string[];
  message: string;
}

/**
 * Stand up a project whose source is a primary repo (BB-106, item 3).
 *
 * Clone the repo if it is not on this machine, then:
 *
 * - it already carries `.bb/` — use it as it is;
 * - it does not — seed `.bb/` with `AGENTS.md`, `skills/` and a `repos.json`
 *   listing the other repos, commit it on the checkout's default branch so the
 *   first thread can provision, and publish a `guidance-<seed>` branch with a
 *   pull request so the seed is reviewed like code.
 */
export async function preparePrimaryProjectSource(
  args: PreparePrimaryProjectSourceArgs,
): Promise<PreparePrimaryProjectSourceResult> {
  const warnings: string[] = [];
  const options = { timeoutMs: FETCH_TIMEOUT_MS, ...(args.signal === undefined ? {} : { signal: args.signal }) };
  const fail = (message: string): PreparePrimaryProjectSourceResult => ({
    ok: false,
    layout: "primary",
    seeded: false,
    prUrl: null,
    warnings,
    message,
  });

  if (await isGitRepo(args.path)) {
    const fetched = await gitIn(args.path, ["fetch", "--quiet", "origin"], options);
    if (fetched.code !== 0) warnings.push(`Could not fetch the primary: ${firstProblemLine(fetched)}`);
  } else {
    const cloned = await cloneProjectSource(args.url, args.path, args.signal);
    if (!cloned.ok) return fail(cloned.message ?? `Could not clone ${args.url}.`);
  }

  const base = await resolveDefaultBranchRef(args.path, args.signal);
  if (base === null) return fail(`${args.path} has no default branch.`);
  const defaultBranch = base.replace(/^refs\/(heads|remotes\/origin)\//u, "");

  const rootDefinition = await rootDefinitionProblem(args.path, args.signal);
  if (rootDefinition !== null) return fail(rootDefinition);
  const existing = await gitIn(
    args.path,
    ["cat-file", "-e", `${base}:${PROJECT_SOURCE_DIR}/${REPOS_FILE}`],
    options,
  );
  if (existing.code === 0) {
    return {
      ok: true,
      layout: "primary",
      seeded: false,
      prUrl: null,
      warnings,
      message: `${args.path} already carries .bb/.`,
    };
  }

  // Build the seed commit in a detached worktree at the default-branch base,
  // never on the checkout's current branch: a checkout the user points at may
  // sit on a feature branch, and seeding there would publish their unpushed
  // work on the seed branch.
  const worktree = await mkdtemp(path.join(tmpdir(), "bb-seed-"));
  let seedSha: string | null = null;
  try {
    const added = await gitIn(args.path, ["worktree", "add", "--detach", "--force", worktree, base], options);
    if (added.code !== 0) return fail(firstProblemLine(added));
    const seeded = await seedPrimaryDefinition(worktree, args.seed, args.signal);
    warnings.push(...seeded.warnings);
    if (!seeded.bootstrapped) return fail(warnings.join("; ") || "Could not seed .bb/.");
    seedSha = await gitLine(worktree, ["rev-parse", "HEAD"], options);
  } finally {
    await gitIn(args.path, ["worktree", "remove", "--force", worktree], options).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
  }
  if (seedSha === null) return fail("Could not commit the seed.");

  const branchCreated = await gitIn(args.path, ["update-ref", `refs/heads/${args.branch}`, seedSha], options);
  if (branchCreated.code !== 0) warnings.push(`Could not create ${args.branch}: ${firstProblemLine(branchCreated)}`);
  // The branch exists locally either way — it keeps the seed commit reachable
  // when the default branch has diverged — but it only reaches `origin` when a
  // pull request was asked for. A local-only seed must not leave a stray
  // branch on someone's remote.
  let pushed = false;
  if (args.openPullRequest) {
    const push = await gitIn(
      args.path,
      ["push", "--quiet", "--force-with-lease", "origin", `refs/heads/${args.branch}`],
      options,
    );
    if (push.code === 0) {
      pushed = true;
    } else {
      warnings.push(`The seed branch was committed locally but not pushed: ${firstProblemLine(push)}`);
    }
  }

  // Make the seed visible to provisioning without touching a feature branch:
  // fast-forward the checked-out default branch, or advance the local default
  // branch when it is not checked out and the seed descends from it. A diverged
  // default branch is left alone — the seed waits on its pull request.
  let seedLocation = defaultBranch;
  const checkedOut = await gitLine(args.path, ["rev-parse", "--abbrev-ref", "HEAD"], options);
  if (checkedOut === defaultBranch) {
    const merged = await gitIn(args.path, ["merge", "--ff-only", "--quiet", seedSha], options);
    if (merged.code !== 0) warnings.push(`Could not fast-forward ${defaultBranch} to the seed: ${firstProblemLine(merged)}`);
  } else {
    const localRef = `refs/heads/${defaultBranch}`;
    const present = await refExists(args.path, localRef, args.signal);
    const ancestor =
      present && (await gitIn(args.path, ["merge-base", "--is-ancestor", localRef, seedSha], options)).code === 0;
    if (!present || ancestor) {
      const updated = await gitIn(args.path, ["update-ref", localRef, seedSha], options);
      if (updated.code !== 0) warnings.push(`Could not advance ${defaultBranch} to the seed: ${firstProblemLine(updated)}`);
    } else {
      seedLocation = args.branch;
      warnings.push(
        args.openPullRequest
          ? `${defaultBranch} has diverged from origin; the seed is only on ${args.branch} until it merges.`
          : `${defaultBranch} has diverged from origin; the seed is only on the local branch ${args.branch}.`,
      );
    }
  }

  let prUrl: string | null = null;
  if (args.openPullRequest && pushed) {
    const pr = await run(
      "gh",
      [
        "pr",
        "create",
        "--base",
        defaultBranch,
        "--head",
        args.branch,
        "--title",
        "Add .bb/ to the primary repo",
        "--body",
        "Seeds `.bb/` (the repo set, cross-repo guidance and project skills) on the primary repo's default branch (BB-106).",
      ],
      { cwd: args.path, timeoutMs: FETCH_TIMEOUT_MS, ...(args.signal === undefined ? {} : { signal: args.signal }) },
    );
    if (pr.code === 0) prUrl = pr.stdout.trim().split("\n").pop() ?? null;
    else warnings.push(`Could not open the seed pull request: ${firstProblemLine(pr)}`);
  }

  return {
    ok: true,
    layout: "primary",
    seeded: true,
    prUrl,
    warnings,
    message: !args.openPullRequest
      ? `Seeded .bb/ in ${args.path} on ${seedLocation}; committed locally only, no pull request.`
      : prUrl === null
        ? `Seeded .bb/ in ${args.path} on ${args.branch}; open a pull request to land it.`
        : `Opened ${prUrl}.`,
  };
}
