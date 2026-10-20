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
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { projectFilePathProblem, slugify } from "./names.js";
import { git, gitIn, gitInOrThrow, gitLine, firstProblemLine, splitNul } from "./git.js";
import { REPOS_FILE, serializeReposFile, type ReposFile } from "./repos.js";

const FETCH_MARKER = ".git/bb-multi-repo-fetched-at";
const GIT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 120_000;

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

This file lives in \`.bb/\`, the project's own git repo. It is **shared by every
thread in this project and versioned**, so it is the right place to record
durable cross-repo knowledge — and the wrong place for anything specific to one
thread.

\`.bb/\` holds three things:

- \`repos.json\` — the repo set. Every thread gets a checkout of each entry.
- \`AGENTS.md\` — this file. bb reads it natively into every thread here.
- \`skills/\` — project skills, also read natively.

The plugin generates a separate block listing each repo's directory, branch and
path. Do not duplicate those facts here: paths written into this file go stale
the first time a repo is renamed, and the generated block is always current as
of thread start.

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

  const merged = await gitIn(dir, ["merge", "--ff-only", "--quiet", "@{u}"], options);
  if (merged.code !== 0) {
    warnings.push(
      `The project source has local commits that are not on its remote; leaving it as it is.`,
    );
  }
  return warnings;
}

export async function readReposJson(dir: string): Promise<string | null> {
  try {
    return await readFile(path.join(dir, REPOS_FILE), "utf8");
  } catch {
    return null;
  }
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
): Promise<CommittedFiles> {
  for (const file of paths) {
    const problem = projectFilePathProblem(file);
    if (problem !== null) return { head: null, files: [], error: problem };
  }
  const options = { timeoutMs: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  const head = await gitLine(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], options);
  if (head === null || head.length === 0) {
    return { head: null, files: [], error: `${dir} is not a git repo with a commit to read.` };
  }

  // One `ls-tree` for every path: which of them the commit holds, and as what.
  // Literal pathspecs, so a name with `*` or a leading `:(` is only a name.
  const listed = await gitIn(
    dir,
    ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", head, "--", ...paths],
    options,
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
    const object = blobs.get(file);
    if (object === undefined) {
      files.push({ path: file, content: null });
      continue;
    }
    // Room for the limit in the widest UTF-8, plus one byte to tell "exactly
    // at the limit" from "over it".
    const read = await gitIn(dir, ["cat-file", "blob", object], { ...options, maxBytes: maxChars * 3 + 1 });
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
 * Replace `repos.json` in the canonical checkout and commit it.
 *
 * Runs host-side, so it works while the agent is sandboxed — this is the write
 * behind `workspace_add_repo` and behind the panel's editor.
 */
export async function writeReposJson(
  dir: string,
  text: string,
  message: string,
  signal?: AbortSignal,
): Promise<{ committed: boolean; head: string | null; message: string | null }> {
  await writeFile(path.join(dir, REPOS_FILE), text, "utf8");
  await gitIn(dir, ["add", "--", REPOS_FILE], {
    timeoutMs: GIT_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  return commitAll(dir, message, signal);
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
): Promise<{ ok: boolean; ref: string | null; message: string }> {
  const safeId = threadId.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 60);
  const ref = `refs/heads/guidance-${safeId}`;
  const options = { timeoutMs: FETCH_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };

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

/** The `guidance-<thread>` ref a thread's published commits land on. */
export function guidanceRef(threadId: string): string {
  const safeId = threadId.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 60);
  return `refs/heads/guidance-${safeId}`;
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
 * Fast-forward the canonical checkout to a thread's published guidance branch.
 *
 * {@link pushGuidance} lands a thread's `.bb` commits on `guidance-<threadId>`.
 * This is the other half, and the only way a self-merged lesson reaches the
 * HEAD that `readCommittedFiles` reads: the canonical repo's checked-out
 * branch is fast-forwarded to that ref. It is deliberately narrow. It refuses
 * a detached HEAD, a dirty working tree, a non-fast-forward, a commit range
 * that changes anything but `file`, or a `file` that does not carry `text` —
 * and on any refusal it leaves the branch exactly where it is, for a person to
 * look at. A self-merged lesson may therefore only ever add its own wording to
 * its own file; it cannot smuggle in a second change.
 */
export async function mergeGuidance(
  projectSourcePath: string,
  threadId: string,
  file: string,
  text: string,
  signal?: AbortSignal,
): Promise<MergeGuidanceResult> {
  const branch = guidanceRef(threadId);
  const options = { timeoutMs: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  const refuse = (message: string): MergeGuidanceResult => ({ ok: false, sha: null, branch, message });

  const head = await gitLine(projectSourcePath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], options);
  if (head === null || head.length === 0) return refuse(`${projectSourcePath} is not a git repo with a commit to fast-forward.`);
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

  const merged = await gitIn(projectSourcePath, ["merge", "--ff-only", "--quiet", ref], options);
  if (merged.code !== 0) return refuse(firstProblemLine(merged));
  const newHead = await gitLine(projectSourcePath, ["rev-parse", "HEAD"], options);
  if (newHead === null) return refuse(`Fast-forwarded ${branch}, but the new HEAD could not be read.`);
  return { ok: true, sha: newHead, branch, message: `Fast-forwarded ${current} to ${newHead.slice(0, 8)} from ${branch}.` };
}
