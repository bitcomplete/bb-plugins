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
import { git, gitIn, gitInOrThrow, gitLine, firstProblemLine, run, splitNul } from "./git.js";
import { REPOS_FILE, parseReposFile, resolvePublishMode, serializeReposFile, type PublishMode, type PublishPolicy, type ReposFile } from "./repos.js";
import { parseCreatedUrl } from "./gh-parse.js";
import type { UnpushedSummary } from "./contract.js";
import {
  PROJECT_SOURCE_DIR,
  projectDefinitionPrefix,
  type ProjectLayout,
} from "./paths.js";

const FETCH_MARKER = ".git/bb-multi-repo-fetched-at";
const GIT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 120_000;
const PUBLISH_TIMEOUT_MS = 120_000;

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
 * Which layout a project source checkout has.
 *
 * Decided from the default branch's committed tree, never the working tree, so
 * an uncommitted `.bb/` someone is halfway through creating does not flip the
 * layout under them. A directory that is not a repo, or has no commit yet, is
 * `standalone` — that is the layout `bootstrapProjectSource` initializes, and
 * the fallback only reaches a directory whose committed tree has neither
 * definition.
 */
export async function detectProjectLayout(dir: string, signal?: AbortSignal): Promise<ProjectLayout> {
  const ref = await resolveDefaultBranchRef(dir, signal);
  if (ref !== null) {
    const primary = await gitIn(dir, ["cat-file", "-e", `${ref}:${PROJECT_SOURCE_DIR}/${REPOS_FILE}`], {
      timeoutMs: GIT_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (primary.code === 0) return "primary";
    const standalone = await gitIn(dir, ["cat-file", "-e", `${ref}:${REPOS_FILE}`], {
      timeoutMs: GIT_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (standalone.code === 0) return "standalone";
  }
  if (await exists(path.join(dir, PROJECT_SOURCE_DIR, REPOS_FILE))) return "primary";
  return "standalone";
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
 */
export const SEEDED_AGENTS_MD = `# Cross-repo guidance

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
editor and the discovery seed all go through the same step; a failed push or
pull request keeps the local commit and is reported, not silently swallowed.

\`repos.json\` may carry a \`publish\` key that overrides the defaults, either
as one mode for the project or as an object of path → mode:

- \`"push"\` pushes the default branch to \`origin\` at once. The change is
  live everywhere immediately.
- \`"pull-request"\` pushes a \`guidance-\` branch and opens a pull request;
  the default branch is never moved, so the change lands when the pull request
  is reviewed and merged.

With no key set, the default follows the layout:

- **In a primary-repo project** (\`.bb/\` on a code repo's default branch, as
  on bb-gate), every path — \`repos.json\` included — defaults to
  \`pull-request\`. Set \`publish\` to \`"push"\` to opt in to direct pushes.
- **In a standalone \`.bb\` repo**, \`repos.json\` defaults to \`push\`, while
  \`AGENTS.md\`, \`skills/\` and \`stewards/\` default to \`pull-request\`.

Either way the change reaches other machines only once it is on \`origin\` —
for a \`push\` immediately, for a \`pull-request\` when it merges.

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
 * Initialize an empty project source in place.
 *
 * Only ever runs when the directory has no `.git`. A project pointed at a
 * cloned `.bb` repo takes none of this path, and nothing here overwrites a
 * file that already exists — a directory holding an `AGENTS.md` and no repo
 * keeps its `AGENTS.md`.
 */
export async function bootstrapProjectSource(
  dir: string,
  seed: ReposFile,
  signal?: AbortSignal,
): Promise<BootstrapResult> {
  const warnings: string[] = [];
  if (await isGitRepo(dir)) return { bootstrapped: false, warnings };

  const options = { timeoutMs: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  await mkdir(dir, { recursive: true });
  await gitInOrThrow(dir, ["init", "--quiet"], options);

  const reposPath = path.join(dir, REPOS_FILE);
  if (!(await exists(reposPath))) await writeFile(reposPath, serializeReposFile(seed), "utf8");
  const agentsPath = path.join(dir, "AGENTS.md");
  if (!(await exists(agentsPath))) await writeFile(agentsPath, SEEDED_AGENTS_MD, "utf8");
  await mkdir(path.join(dir, "skills"), { recursive: true });
  // An empty directory is not a thing git can track, and a project with no
  // skills yet should still show the agent where they go.
  const keepPath = path.join(dir, "skills", ".gitkeep");
  if (!(await exists(keepPath))) await writeFile(keepPath, "", "utf8");

  await gitIn(dir, ["add", "--", REPOS_FILE, "AGENTS.md", "skills"], options);
  const commit = await commitAll(dir, "Initialize the multi-repo workspace definition", signal);
  if (!commit.committed && commit.message !== null) warnings.push(commit.message);
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
  if (!(await exists(agentsPath))) await writeFile(agentsPath, SEEDED_AGENTS_MD, "utf8");
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
 * Where a new project's `.bb` checkout goes unless someone says otherwise:
 * `~/bb/<slug>`. Under the home directory because that is the one place on a
 * machine that is reliably writable and survives a plugin uninstall, and
 * under one `bb` folder so several projects' definitions sit together — and
 * beside any checkouts the user keeps there, which the mirror discovery scans
 * as siblings of the project source.
 */
export async function defaultProjectSourcePath(name: string): Promise<{ path: string; exists: boolean }> {
  const target = path.join(homedir(), "bb", slugify(name));
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
  layout: ProjectLayout = "standalone",
  signal?: AbortSignal,
): Promise<string | null> {
  const read = await readCommittedFiles(dir, [REPOS_FILE], 200_000, signal, {
    prefix: projectDefinitionPrefix(layout),
  });
  if (read.error !== null || read.files.length === 0) return null;
  return read.files[0].content;
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
 * the panel's editor. The commit and the publish are the shared
 * {@link publishDefinition} step, so this function decides nothing about how
 * the change reaches `origin`.
 */
export async function writeReposJson(
  dir: string,
  text: string,
  message: string,
  signal?: AbortSignal,
  layout: ProjectLayout = "standalone",
  policy?: PublishPolicy,
  threadId?: string | null,
): Promise<{
  ok: boolean;
  committed: boolean;
  head: string | null;
  message: string | null;
  mode: PublishMode;
  prUrl: string | null;
}> {
  const result = await publishDefinition({
    kind: "content",
    dir,
    layout,
    policy,
    path: REPOS_FILE,
    content: text,
    message,
    threadId: threadId ?? null,
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
  /** The thread a guidance branch is named after, when there is one. */
  threadId?: string | null;
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
  threadId?: string | null;
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
 * content to commit, then either pushes the default branch (`push`) or pushes
 * a `guidance-` branch and opens a pull request (`pull-request`).
 *
 * Failure is loud and local: a rejected push or a failed `gh pr create` leaves
 * the commit exactly where it was, moves nothing back, and never force-pushes.
 */
export async function publishDefinition(request: PublishRequest): Promise<PublishResult> {
  const mode = resolvePublishMode(request.policy, request.layout, request.path);
  const options: GitOptions = {
    timeoutMs: PUBLISH_TIMEOUT_MS,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
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
  const hasRemote = (await projectSourceRemote(request.dir, request.signal)) !== null;
  return mode === "push"
    ? publishByPush(request, base, baseName, hasRemote, options)
    : publishByPullRequest(request, base, baseName, hasRemote, options);
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
    const relative = `${projectDefinitionPrefix(request.layout)}${request.path}`;
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
    return { ok: true, mode, committed: false, head: outcome.head, branch: null, prUrl: null, message: null };
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
  const failure = (message: string, head: string | null = null, branch: string | null = null): PublishResult => ({
    ok: false,
    mode,
    committed: head !== null,
    head,
    branch,
    prUrl: null,
    message,
  });
  let head: string | null;
  let branchName: string;
  if (request.kind === "content") {
    branchName = guidanceBranchName(request.path);
    const relative = `${projectDefinitionPrefix(request.layout)}${request.path}`;
    const outcome = await commitContentOnBranch({
      dir: request.dir,
      base,
      branchRef: `refs/heads/${branchName}`,
      relative,
      content: request.content,
      message: request.message,
      signal: request.signal,
      options,
    });
    if (outcome.message !== null) return failure(outcome.message, outcome.head, branchName);
    if (!outcome.committed) {
      return { ok: true, mode, committed: false, head: outcome.head, branch: null, prUrl: null, message: null };
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
    body: `Publishes \`.bb/${request.path}\` for review, by the project's publish policy (BB-148).`,
    signal: request.signal,
    options,
  });
  if (!pr.ok) {
    return failure(`The branch ${branchName} is pushed but opening the pull request failed: ${pr.message}`, head, branchName);
  }
  return { ok: true, mode, committed: true, head, branch: branchName, prUrl: pr.url, message: null };
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
 * the existing URL, not an error.
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
    if (listed.code === 0) {
      const url = firstPullRequestUrl(listed.stdout);
      if (url !== null) return { ok: true, url, message: null };
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
  return layout === "primary"
    ? pushGuidancePrimary(projectSourcePath, workspaceBbPath, threadId, signal, definitionBase ?? null)
    : pushGuidanceStandalone(projectSourcePath, workspaceBbPath, threadId, signal);
}

async function pushGuidanceStandalone(
  projectSourcePath: string,
  workspaceBbPath: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; ref: string | null; message: string }> {
  const safeId = threadId.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 60);
  const ref = `refs/heads/guidance-${safeId}`;
  const options = { timeoutMs: FETCH_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };

  // Commit whatever the agent left uncommitted. Publishing must not depend on
  // the agent remembering a `git commit`: in the primary layout `.bb/` has no
  // git repo at all, and the tool has to mean the same thing in both layouts.
  await gitIn(workspaceBbPath, ["add", "-A"], options);
  await commitAll(workspaceBbPath, `Guidance from ${threadId}`, signal);

  const head = await gitLine(workspaceBbPath, ["rev-parse", "HEAD"], options);
  if (head === null) {
    return { ok: false, ref: null, message: `${workspaceBbPath} is not a git repo.` };
  }
  const result = await git(
    ["-C", projectSourcePath, "fetch", "--quiet", "--force", workspaceBbPath, `HEAD:${ref}`],
    options,
  );
  if (result.code !== 0) {
    return { ok: false, ref: null, message: firstProblemLine(result) };
  }
  return {
    ok: true,
    ref,
    message: `Published ${head.slice(0, 8)} to ${ref} in ${projectSourcePath}. Merge it there when you are happy with it.`,
  };
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
    threadId,
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

/**
 * Copy a project-definition tree, skipping any nested `.git`.
 *
 * The standalone checkout is a git repo; the destination is a directory inside
 * the primary repo, which owns the git history. A `.git` copied in would make
 * git treat `.bb/` as a nested repository and the `git add` would produce a
 * gitlink instead of the files.
 */
async function copyDefinitionTree(src: string, dest: string): Promise<void> {
  await cp(src, dest, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".git",
  });
}

export interface AdoptProjectSourceArgs {
  /** The standalone `.bb` checkout whose tree is copied into the primary. */
  standalonePath: string;
  /** URL or local path of the primary repo. */
  primaryUrl: string;
  /** Where the primary clone lives; cloned when absent, fetched when present. */
  primaryPath: string;
  /** Branch the seed commit is pushed on. */
  branch: string;
  /** Attempt `gh pr create` after the push. */
  openPullRequest: boolean;
  signal?: AbortSignal;
}

export interface AdoptProjectSourceResult {
  status: "already" | "pull-request" | "failed";
  message: string;
  prUrl: string | null;
  warnings: string[];
  primaryPath: string;
  defaultBranch: string | null;
}

/**
 * Adopt a standalone `.bb` repo into a primary repo (BB-106, Case A).
 *
 * Idempotent and per-machine, exactly as the ticket requires:
 *
 * - The primary's default branch already carries `.bb/` — a previous run, or a
 *   teammate's merge — so nothing is copied; the caller re-points the project
 *   source at this checkout.
 * - It does not — the standalone tree is copied to `.bb/` on `branch`, pushed,
 *   and a pull request is opened. The project source is re-pointed on a later
 *   run, once the merge has landed `.bb/` on the default branch.
 *
 * The standalone checkout keeps working throughout; this only ever adds a
 * branch to the primary and never touches the default branch.
 */
export async function adoptProjectSource(args: AdoptProjectSourceArgs): Promise<AdoptProjectSourceResult> {
  const warnings: string[] = [];
  const options = { timeoutMs: FETCH_TIMEOUT_MS, ...(args.signal === undefined ? {} : { signal: args.signal }) };
  const fail = (message: string): AdoptProjectSourceResult => ({
    status: "failed",
    message,
    prUrl: null,
    warnings,
    primaryPath: args.primaryPath,
    defaultBranch: null,
  });

  if (await isGitRepo(args.primaryPath)) {
    const fetched = await gitIn(args.primaryPath, ["fetch", "--quiet", "origin"], options);
    if (fetched.code !== 0) warnings.push(`Could not fetch the primary: ${firstProblemLine(fetched)}`);
  } else {
    const cloned = await cloneProjectSource(args.primaryUrl, args.primaryPath, args.signal);
    if (!cloned.ok) return fail(cloned.message ?? `Could not clone ${args.primaryUrl}.`);
  }

  const base = await resolveDefaultBranchRef(args.primaryPath, args.signal);
  if (base === null) return fail(`${args.primaryPath} has no default branch to adopt into.`);
  const defaultBranch = base.replace(/^refs\/(heads|remotes\/origin)\//u, "");
  const existing = await gitIn(
    args.primaryPath,
    ["cat-file", "-e", `${base}:${PROJECT_SOURCE_DIR}/${REPOS_FILE}`],
    options,
  );
  if (existing.code === 0) {
    return {
      status: "already",
      message: `${args.primaryPath} already carries .bb/ on ${defaultBranch}; re-point the project source at this checkout.`,
      prUrl: null,
      warnings,
      primaryPath: args.primaryPath,
      defaultBranch,
    };
  }

  const worktree = await mkdtemp(path.join(tmpdir(), "bb-adopt-"));
  try {
    const added = await gitIn(
      args.primaryPath,
      ["worktree", "add", "--detach", "--force", worktree, base],
      options,
    );
    if (added.code !== 0) return fail(firstProblemLine(added));
    await rm(path.join(worktree, PROJECT_SOURCE_DIR), { recursive: true, force: true });
    await copyDefinitionTree(args.standalonePath, path.join(worktree, PROJECT_SOURCE_DIR));
    await gitIn(worktree, ["add", "-A", "--", PROJECT_SOURCE_DIR], options);
    const commit = await commitAll(worktree, "Move the project definition into .bb/ on the primary repo", args.signal);
    if (!commit.committed || commit.head === null) {
      return fail(commit.message ?? "There was nothing to adopt.");
    }
    const head = commit.head;
    const recorded = await gitIn(args.primaryPath, ["update-ref", `refs/heads/${args.branch}`, head], options);
    if (recorded.code !== 0) return fail(firstProblemLine(recorded));

    const pushed = await gitIn(
      args.primaryPath,
      ["push", "--quiet", "--force-with-lease", "origin", `refs/heads/${args.branch}`],
      options,
    );
    if (pushed.code !== 0) {
      warnings.push(`The adopt branch was created locally but not pushed: ${firstProblemLine(pushed)}`);
    }

    let prUrl: string | null = null;
    if (args.openPullRequest && pushed.code === 0) {
      const title = "Move the project definition into .bb/ on the primary repo";
      const body =
        "Adopts the standalone `.bb` project definition into `.bb/` on this repo's default branch (BB-106). " +
        "`repos.json` lists only the other repos; the primary is derived from this repo's origin. " +
        "Merge this to make the project source this repo.";
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
          title,
          "--body",
          body,
        ],
        { cwd: args.primaryPath, timeoutMs: FETCH_TIMEOUT_MS, ...(args.signal === undefined ? {} : { signal: args.signal }) },
      );
      if (pr.code === 0) prUrl = pr.stdout.trim().split("\n").pop() ?? null;
      else warnings.push(`Could not open the pull request: ${firstProblemLine(pr)}`);
    }

    return {
      status: "pull-request",
      message: prUrl === null
        ? `Copied the standalone .bb tree to ${args.branch} in ${args.primaryPath}. Push it and open a pull request, then run adopt again.`
        : `Opened ${prUrl}. Merge it, then run adopt again to re-point the project source.`,
      prUrl,
      warnings,
      primaryPath: args.primaryPath,
      defaultBranch,
    };
  } finally {
    await gitIn(args.primaryPath, ["worktree", "remove", "--force", worktree], options).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
  }
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
 * - it already carries `.bb/` (or is a standalone `.bb` repo) — use it as it
 *   is;
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
    layout: "standalone",
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

  const rootDefinition = await gitIn(args.path, ["cat-file", "-e", `${base}:${REPOS_FILE}`], options);
  if (rootDefinition.code === 0) {
    return {
      ok: true,
      layout: "standalone",
      seeded: false,
      prUrl: null,
      warnings,
      message: `${args.path} is a standalone .bb repo.`,
    };
  }
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
  // work on the seed branch. `adoptProjectSource` uses the same pattern.
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
  const pushed = await gitIn(
    args.path,
    ["push", "--quiet", "--force-with-lease", "origin", `refs/heads/${args.branch}`],
    options,
  );
  if (pushed.code !== 0) {
    warnings.push(`The seed branch was committed locally but not pushed: ${firstProblemLine(pushed)}`);
  }

  // Make the seed visible to provisioning without touching a feature branch:
  // fast-forward the checked-out default branch, or advance the local default
  // branch when it is not checked out and the seed descends from it. A diverged
  // default branch is left alone — the seed waits on its pull request.
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
      warnings.push(`${defaultBranch} has diverged from origin; the seed is only on ${args.branch} until it merges.`);
    }
  }

  let prUrl: string | null = null;
  if (args.openPullRequest && pushed.code === 0) {
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
    message: prUrl === null
      ? `Seeded .bb/ in ${args.path} on ${args.branch}; open a pull request to land it.`
      : `Opened ${prUrl}.`,
  };
}
