// The native project source's read half, run on the developer's machine by the
// host entry (host.ts) beside the kubectl handler.
//
// A git repo is a primary: it reads `.bb` from the default branch's tip on
// `origin`, after a fetch: never the working tree, never a feature branch,
// never a local commit. The checkout is a person's directory as well as the
// plugin's, so an edit someone is halfway through there is not the project's.
// `git fetch` is the only command that changes anything, and it changes only
// remote-tracking refs; nothing here checks out, resets, stashes, commits or
// writes the working tree or a local branch, and this handler leaves no state
// of its own in the checkout (the caller throttles the fetch).
//
// A directory that is not a git repo is a plain-directory project: `.bb/` is
// an ordinary subdirectory and there is no commit to read, so the files come
// from disk under `<dir>/.bb`. Nothing is created or written there.
//
// Every path is a fixed argument from the plugin, passed after `--`, so a
// file name can never become an option. Paths are validated again here even
// though the host contract already checks them: this is the boundary.
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { experimental_sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/host";
import type { NativeGitRead, ProjectGitFile } from "./project-source.js";

const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** A playbook or project file past this is not read, rather than truncated into a valid-looking one. */
const MAX_FILE_CHARS = 200_000;
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);
const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

type GitRun = { code: number; stdout: string; stderr: string; truncated: boolean };

function runGit(dir: string, args: string[], opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<GitRun> {
  const maxBytes = opts.maxBytes ?? MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, ...args],
      {
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: maxBytes,
        env: { ...experimental_sanitizeInheritedChildProcessEnv({ env: process.env }), NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const e = error as (Omit<NodeJS.ErrnoException, "code"> & { code?: string | number; killed?: boolean }) | null;
        if (e?.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: "git: not found", truncated: false });
        if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ code: 1, stdout: "", stderr: `git output exceeded ${maxBytes} bytes`, truncated: true });
        const exitCode = e === null ? 0 : typeof e.code === "number" ? e.code : 1;
        resolve({ code: exitCode, stdout: String(stdout), stderr: e !== null && e.killed ? `git did not finish in ${(opts.timeoutMs ?? GIT_TIMEOUT_MS) / 1000}s` : String(stderr), truncated: false });
      },
    );
  });
}

async function gitLine(dir: string, args: string[]): Promise<string | null> {
  const r = await runGit(dir, args);
  const line = r.stdout.split(/\r?\n/u).map((l) => l.trim()).find((l) => l !== "");
  return r.code === 0 && line !== undefined ? line : null;
}

const firstProblemLine = (r: GitRun): string => r.stderr.split(/\r?\n/u).map((l) => l.trim()).find((l) => l !== "") ?? `git exited ${r.code}`;

async function refExists(dir: string, ref: string): Promise<boolean> {
  const r = await runGit(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 && r.stdout.trim() !== "";
}

/** Is this directory itself a git repo? A `.git` file counts (a worktree or submodule). */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The default branch's name, from `origin/HEAD`, then the conventional names.
 * Never the checked-out branch: a feature branch is not the project's.
 */
async function originDefaultBranch(dir: string): Promise<string | null> {
  const head = await gitLine(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head !== null && head.startsWith("origin/")) return head.slice("origin/".length);
  for (const candidate of ["main", "master"]) {
    if (await refExists(dir, `refs/remotes/origin/${candidate}`)) return candidate;
  }
  return null;
}

/**
 * Read `.bb/<file>` from a plain project directory's disk. There is no commit
 * and no origin, so the working tree is the project's `.bb`; nothing is
 * created, written or committed. `projectGitPathProblem` has already checked
 * every path before this runs.
 */
async function readDirectoryFiles(dir: string, files: readonly string[]): Promise<{ files: ProjectGitFile[]; error: string | null }> {
  const out: ProjectGitFile[] = [];
  const tooLarge: string[] = [];
  for (const file of files) {
    const content = await readFile(path.join(dir, ".bb", file), "utf8").catch(() => null);
    if (content === null) {
      out.push({ path: file, content: null });
      continue;
    }
    if (content.length > MAX_FILE_CHARS) {
      tooLarge.push(file);
      out.push({ path: file, content: null });
      continue;
    }
    out.push({ path: file, content });
  }
  const error = tooLarge.length === 0 ? null : `Larger than ${MAX_FILE_CHARS} characters, so not read: ${tooLarge.join(", ")}`;
  return { files: out, error };
}

/** Whether every path is a fixed, relative, traversal-free path the plugin may ask for. */
export function projectGitPathProblem(path: string): string | null {
  if (!SAFE_PATH.test(path) || path.split("/").includes("..")) return `${JSON.stringify(path)} is not a project file path`;
  return null;
}

/**
 * Read the named files out of a project's `.bb`.
 *
 * A git repo is a primary and is read from `origin/<default>` at its committed
 * tip. `fetch` (default true) asks for a `git fetch origin` first; the caller
 * throttles it, so the checkout gets no plugin-owned state of its own. A fetch
 * that fails (no network, no remote) still reads the last fetched commit
 * rather than failing the read. The working tree and every local branch are
 * untouched.
 *
 * A directory that is not a git repo is a plain-directory project with no
 * commit: its files come from `<dir>/.bb` on disk, and nothing there is
 * created, written or committed.
 */
export async function readProjectGit(input: { path: string; files: readonly string[]; fetch?: boolean }): Promise<NativeGitRead> {
  const dir = input.path;
  const git = await isGitRepo(dir);
  for (const file of input.files) {
    const problem = projectGitPathProblem(file);
    if (problem !== null) return { head: null, files: [], remote: null, defaultBranch: null, layout: git ? "primary" : "directory", error: problem };
  }
  if (!git) {
    const { files, error } = await readDirectoryFiles(dir, input.files);
    return { head: null, files, remote: null, defaultBranch: null, layout: "directory", error };
  }
  const remote = await gitLine(dir, ["config", "--get", "remote.origin.url"]);
  const fetched = input.fetch === false ? null : await runGit(dir, ["fetch", "--quiet", "origin"]);
  const branch = await originDefaultBranch(dir);
  if (branch === null) {
    const why = fetched === null || fetched.code === 0 ? `${dir} has no origin default branch to read.` : `Could not fetch the project source: ${firstProblemLine(fetched)}`;
    return { head: null, files: [], remote, defaultBranch: null, layout: "primary", error: why };
  }
  const ref = `refs/remotes/origin/${branch}`;
  const head = await gitLine(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (head === null) {
    return { head: null, files: [], remote, defaultBranch: branch, layout: "primary", error: `Could not fetch the project source: ${fetched === null ? "no commit on origin's default branch" : firstProblemLine(fetched)}` };
  }
  if (input.files.length === 0) return { head, files: [], remote, defaultBranch: branch, layout: "primary", error: null };

  // One `ls-tree` for every path: which the commit holds, and as what.
  // Literal pathspecs and `--`, so a name is only ever a name. `.bb/` is the
  // definition prefix for every primary (BB-106).
  const listed = await runGit(dir, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", head, "--", ...input.files.map((file) => `.bb/${file}`)]);
  if (listed.code !== 0) return { head, files: [], remote, defaultBranch: branch, layout: "primary", error: firstProblemLine(listed) };
  const blobs = new Map<string, string>();
  for (const entry of listed.stdout.split("\0")) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/su.exec(entry);
    if (match === null || match[2] !== "blob" || !REGULAR_FILE_MODES.has(match[1]!)) continue;
    blobs.set(match[4]!, match[3]!);
  }

  const files: ProjectGitFile[] = [];
  const tooLarge: string[] = [];
  for (const file of input.files) {
    const object = blobs.get(`.bb/${file}`);
    if (object === undefined) {
      files.push({ path: file, content: null });
      continue;
    }
    const read = await runGit(dir, ["cat-file", "blob", object], { maxBytes: MAX_FILE_CHARS * 3 + 1 });
    if (read.code !== 0) {
      if (read.truncated) {
        tooLarge.push(file);
        files.push({ path: file, content: null });
        continue;
      }
      return { head, files: [], remote, defaultBranch: branch, layout: "primary", error: firstProblemLine(read) };
    }
    if (read.stdout.length > MAX_FILE_CHARS) {
      tooLarge.push(file);
      files.push({ path: file, content: null });
      continue;
    }
    files.push({ path: file, content: read.stdout });
  }
  const error = tooLarge.length === 0 ? null : `Larger than ${MAX_FILE_CHARS} characters, so not read: ${tooLarge.join(", ")}`;
  return { head, files, remote, defaultBranch: branch, layout: "primary", error };
}
