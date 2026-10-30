import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommitSnapshot } from "./contract";

const LIMIT = 800_000;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function git(root: string, args: string[], index?: string, input = "") {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) delete env[name];
  if (index) env.GIT_INDEX_FILE = index;
  return new Promise<string>((resolve, reject) => {
    const child = execFile("git", ["-C", root, ...args], { env, maxBuffer: args[0] === "diff" ? LIMIT : 16 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error && args[0] === "config" && error.code === 1) resolve("");
      else if (error) reject(new Error(`git ${args[0]} failed: ${stderr.trim().slice(0, 4000) || error.message.slice(0, 1000)}`));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

async function indexState(root: string) {
  return sha((await git(root, ["ls-files", "--stage", "-z"])) + (await git(root, ["ls-files", "-v", "-z"])));
}

async function identity(root: string) {
  const branch = (await git(root, ["symbolic-ref", "--quiet", "HEAD"])).trim();
  // An unborn branch has no ref; command failures still propagate.
  const refs = (await git(root, ["for-each-ref", "--format=%(refname) %(objectname)", branch])).trim().split("\n");
  const head = refs.find((ref) => ref.startsWith(`${branch} `))?.slice(branch.length + 1) ?? null;
  return { head, branch };
}

async function validate(root: string, paths: string[]) {
  root = await realpath(root);
  if ((await realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim())) !== root) {
    throw new Error("Commit jobs require the repository root as their workspace");
  }
  if ((await git(root, ["ls-files", "--unmerged", "-z"])).length) throw new Error("Resolve conflicts before committing");
  const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
  for (const state of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
    if (await lstat(path.join(gitDir, state)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    })) throw new Error("Finish the repository's merge, rebase, or cherry-pick before using a commit job");
  }
  for (const file of paths) {
    if (!file || file.includes("\0") || path.isAbsolute(file) || file.split("/").some((part) => ["", ".", "..", ".git"].includes(part))) {
      throw new Error("Commit paths must be literal files inside the repository");
    }
    // Git stores a leaf symlink itself; a symlink in its parent path must never escape the workspace.
    let parent = path.dirname(path.join(root, file));
    while (parent !== root) {
      try {
        const canonical = await realpath(parent);
        if (!canonical.startsWith(`${root}${path.sep}`)) throw new Error("Commit path escapes the workspace");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        parent = path.dirname(parent);
      }
    }
    const info = await lstat(path.join(root, file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (info && !info.isFile() && !info.isSymbolicLink()) throw new Error("Select individual files; directories and submodules cannot be committed by this helper");
  }
  return root;
}

async function tree(root: string, paths: string[], head: string | null, directory: string) {
  const index = path.join(directory, "capture-index");
  await rm(index, { force: true });
  await git(root, head ? ["read-tree", head] : ["read-tree", "--empty"], index);
  const tracked = new Set((await git(root, ["ls-files", "-z", "--", ...paths], index)).split("\0"));
  const present = await Promise.all(paths.map(async (file) => {
    const exists = await lstat(path.join(root, file)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    });
    return tracked.has(file) || exists ? file : null;
  }));
  const selected = present.filter((file): file is string => file !== null);
  if (selected.length) await git(root, ["add", "-A", "--", ...selected], index);
  return (await git(root, ["write-tree"], index)).trim();
}

export async function reviewCommit(root: string, paths: string[], snapshot?: CommitSnapshot) {
  root = await validate(root, paths);
  const directory = await mkdtemp(path.join(os.tmpdir(), "bb-commit-review-"));
  try {
    if (!snapshot) {
      const before = { ...await identity(root), index: await indexState(root) };
      const reviewedTree = await tree(root, paths, before.head, directory);
      const after = { ...await identity(root), index: await indexState(root) };
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Repository state changed while preparing the review; start a new job");
      snapshot = { ...before, tree: reviewedTree };
    }
    const base = snapshot.head ?? (await git(root, ["hash-object", "-t", "tree", "-w", "--stdin"])).trim();
    const diff = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", base, snapshot.tree, "--"]);
    if (!diff) throw new Error("There are no selected changes to commit");
    if (Buffer.byteLength(diff) > LIMIT - 16_000) throw new Error("Diff is too large for one review; split the changes");
    return { snapshot, diff };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// The wrappers run the repository's actual hooks, then check what those hooks left behind.
// Commit uses an immutable alternate index; hooks must not silently replace the reviewed tree or message.
async function guardedHooks(root: string, directory: string, snapshot: CommitSnapshot, paths: string[], message: string) {
  const original = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])).trim();
  const hooks = path.join(directory, "hooks");
  await mkdir(hooks);
  const config = { root, original, snapshot, paths, message, failureFile: path.join(directory, "hook-failure") };
  await writeFile(path.join(directory, "guard.cjs"), `const config = ${JSON.stringify(config)};\n` + HOOK_GUARD);
  const names = new Set(["pre-commit", "prepare-commit-msg", "commit-msg", ...await readdir(original).catch((error: NodeJS.ErrnoException) => {
    if (!["ENOENT", "ENOTDIR"].includes(error.code ?? "")) throw error;
    return [];
  })]);
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  for (const name of names) {
    if (!/^[a-z-]+$/.test(name)) continue;
    await writeFile(path.join(hooks, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(directory, "guard.cjs"))} ${quote(name)} "$@"\n`, { mode: 0o700 });
  }
  return hooks;
}

const HOOK_GUARD = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const [name, ...args] = process.argv.slice(2);
function git(args, index) {
  const result = spawnSync('git', ['-C', config.root, ...args], {encoding:'utf8', env:{...process.env, ...(index ? {GIT_INDEX_FILE:index} : {}), GIT_LITERAL_PATHSPECS:'1'}, maxBuffer:800000});
  if (result.status !== 0) throw new Error('Cannot verify reviewed state: ' + (result.stderr || result.error || 'git failed'));
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}
function verify() {
  const branch = git(['symbolic-ref','--quiet','HEAD']);
  const refs = git(['for-each-ref','--format=%(refname) %(objectname)',branch]).split('\n');
  const head = refs.find(ref => ref.startsWith(branch + ' '))?.slice(branch.length + 1) ?? null;
  if (head !== config.snapshot.head || branch !== config.snapshot.branch || git(['write-tree']) !== config.snapshot.tree) throw new Error('HEAD, branch, or staged content changed since review');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'bb-commit-hook-'));
  try {
    const index = path.join(dir,'index');
    git(config.snapshot.head ? ['read-tree',config.snapshot.head] : ['read-tree','--empty'],index);
    const tracked = new Set(git(['ls-files','-z','--',...config.paths],index).split('\0'));
    const selected = config.paths.filter(file => tracked.has(file) || fs.lstatSync(path.join(config.root,file),{throwIfNoEntry:false}));
    if (selected.length) git(['add','-A','--',...selected],index);
    if (git(['write-tree'],index) !== config.snapshot.tree) throw new Error('Selected files changed since review');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
try {
  const guarded = ['pre-commit','prepare-commit-msg','commit-msg'].includes(name);
  if (guarded) verify();
  const original = path.join(config.original,name);
  let executable = false;
  try { fs.accessSync(original,fs.constants.X_OK); executable = fs.statSync(original).isFile(); } catch(error) { if (!['ENOENT','ENOTDIR','EACCES'].includes(error.code)) throw error; }
  if (executable) {
    const env = {...process.env};
    delete env.GIT_LITERAL_PATHSPECS;
    const child = spawnSync(original,args,{stdio:'inherit',env});
    if (child.status !== 0) throw new Error(name + ' hook failed: ' + (child.error?.message || child.signal || 'exit ' + child.status));
  }
  if (guarded) {
    verify();
    if (name !== 'pre-commit' && fs.readFileSync(args[0],'utf8').trim() !== config.message.trim()) throw new Error('A hook changed the commit message; review it in a new job');
  }
} catch(error) {
  fs.writeFileSync(config.failureFile,error.message);
  console.error(error.message);
  process.exit(1);
}
`;

export async function finishCommit(root: string, paths: string[], snapshot: CommitSnapshot, messageFile: string, push: boolean) {
  root = await validate(root, paths);
  const canonicalMessage = await realpath(messageFile);
  const temporary = await realpath(os.tmpdir());
  // Claude uses /tmp/claude-<uid> even when macOS gives the host a per-user TMPDIR.
  const systemTemporary = await realpath("/tmp");
  if (![root, temporary, systemTemporary].some((base) => canonicalMessage.startsWith(`${base}${path.sep}`))) throw new Error("Message file must be inside the checkout or a host temporary directory");
  const messageInfo = await stat(canonicalMessage);
  if (!messageInfo.isFile() || messageInfo.size > 16_000) throw new Error("Message file must be a regular file smaller than 16 KB");
  const message = (await readFile(canonicalMessage, "utf8")).trim() + "\n";
  const lines = message.trim().split("\n");
  if (!lines[0] || lines[1] !== "" || ![2, 3].includes(lines.length - 2) || !lines.slice(2).every((line) => /^- \S/.test(line)) || /^(?:-\s*)?co-authored-by:/im.test(message)) {
    throw new Error("Use one subject line, a blank line, and two or three sentence bullets; no Co-Authored-By attribution");
  }
  const indexPath = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
  const directory = await mkdtemp(path.join(os.tmpdir(), "bb-commit-finish-"));
  const lockPath = `${indexPath}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let ownsLock = false;
  let committed: string | null = null;
  let commitAttempted = false;
  let publishedIndex = false;
  try {
    lock = await open(lockPath, "wx", 0o600);
    ownsLock = true;
    const current = { ...await identity(root), index: await indexState(root) };
    if (current.head !== snapshot.head || current.branch !== snapshot.branch || current.index !== snapshot.index || await tree(root, paths, current.head, directory) !== snapshot.tree) {
      throw new Error("HEAD, branch, staging, or selected files changed since review; start a new job");
    }
    const commitIndex = path.join(directory, "commit-index");
    await git(root, ["read-tree", snapshot.tree], commitIndex);
    const nextIndex = path.join(directory, "next-index");
    await copyFile(indexPath, nextIndex).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      await git(root, ["read-tree", "--empty"], nextIndex);
    });
    await git(root, ["update-index", "--force-remove", "--", ...paths], nextIndex);
    const entries = await git(root, ["ls-tree", "-rz", snapshot.tree, "--", ...paths]);
    await git(root, ["update-index", "-z", "--index-info"], nextIndex, entries);
    const hooks = await guardedHooks(root, directory, snapshot, paths, message);
    const msg = path.join(directory, "message");
    await writeFile(msg, message, { mode: 0o600 });
    commitAttempted = true;
    await git(root, ["-c", `core.hooksPath=${hooks}`, "commit", "--cleanup=verbatim", "--file", msg], commitIndex);
    committed = (await git(root, ["rev-parse", "HEAD"])).trim();
    const parents = (await git(root, ["rev-list", "--parents", "-n", "1", committed])).trim().split(" ").slice(1);
    if ((await git(root, ["rev-parse", "HEAD^{tree}"])).trim() !== snapshot.tree || (await identity(root)).branch !== snapshot.branch || JSON.stringify(parents) !== JSON.stringify(snapshot.head ? [snapshot.head] : []) || (await git(root, ["show", "--format=%B", "--no-patch", committed])).trim() !== message.trim()) {
      throw new Error("The committed tree, parent, branch, or message differs from the reviewed job; inspect the local commit before continuing");
    }
    await lock.writeFile(await readFile(nextIndex));
    await lock.close();
    lock = undefined;
    await rename(lockPath, indexPath);
    ownsLock = false;
    publishedIndex = true;
    // Git ignores post-commit exit codes, so the wrapper records failures separately.
    const hookFailure = await readFile(path.join(directory, "hook-failure"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (hookFailure) throw new Error(`${hookFailure}; the commit is local and was not pushed`);
    // Post-commit hooks can edit files, but their edits must never be pushed as reviewed work.
    if (await tree(root, paths, committed, directory) !== snapshot.tree) throw new Error("A post-commit hook changed selected files; the commit is local and was not pushed");
    if (push) {
      const branch = snapshot.branch.slice("refs/heads/".length);
      const configured = await Promise.all([`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`].map(async (key) => (await git(root, ["config", "--get", key])).trim() || undefined));
      const remotes = (await git(root, ["remote"])).trim().split("\n");
      const remote = configured.find((value) => value !== undefined) ?? (remotes.includes("origin") ? "origin" : undefined);
      if (!remote || remote === "." || !remotes.includes(remote)) throw new Error("No push remote could be resolved; the commit remains local");
      if ((await identity(root)).head !== committed || (await identity(root)).branch !== snapshot.branch) throw new Error("HEAD or branch changed before push; the commit remains local");
      await git(root, ["push", "--no-force", "--no-mirror", "--no-follow-tags", "--", remote, `${committed}:refs/heads/${branch}`]);
    }
    return { commit: committed, pushed: push, error: null };
  } catch (error) {
    return { commit: committed, pushed: false, error: `${error instanceof Error ? error.message : String(error)}${committed && !publishedIndex ? "; the real index was not updated: inspect it against the local commit" : commitAttempted && !committed ? "; inspect HEAD and repository status before starting another job" : ""}` };
  } finally {
    if (lock) await lock.close();
    if (ownsLock) await rm(lockPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}
