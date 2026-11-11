/**
 * The reflink template tree.
 *
 * These tests build real repositories and real cache entries. The copy path
 * needs a filesystem that supports reflinks (ZFS with block cloning, btrfs,
 * XFS) and the fallback path needs one that does not (`/dev/shm` is tmpfs);
 * each test asks the probe and skips when the machine cannot provide the
 * filesystem it is about, so the suite is honest on a laptop that has neither.
 */
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cachePathFor,
  cacheRoot,
  reflinkSupported,
  refreshCaches,
  templatePathFor,
  templateRoot,
} from "./cache.js";
import { git, gitEnv, gitIn, gitLine } from "./git.js";
import { EMPTY_REPOS } from "./repos.js";
import { bootstrapProjectSource } from "./source.js";
import { provisionWorkspace, workspaceRoot } from "./workspace.js";

let scratch: string;
let dataDir: string;

async function makeRemote(name: string, branch = "main"): Promise<string> {
  const dir = path.join(scratch, "remotes", name);
  await mkdir(dir, { recursive: true });
  await git(["init", "--quiet", `--initial-branch=${branch}`, dir]);
  await gitIn(dir, ["config", "user.email", "test@example.invalid"]);
  await gitIn(dir, ["config", "user.name", "Test"]);
  await writeFile(path.join(dir, "README.md"), `# ${name}\n`, "utf8");
  await gitIn(dir, ["add", "-A"]);
  await gitIn(dir, ["commit", "--quiet", "-m", "initial"]);
  return dir;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function projectSource(): Promise<string> {
  const dir = path.join(scratch, "project-source");
  await mkdir(dir, { recursive: true });
  await bootstrapProjectSource(dir, EMPTY_REPOS);
  return dir;
}

async function provision(args: {
  dataDir: string;
  pathKey: string;
  source: string;
  url: string;
  branch?: string | null;
  fetchTtlMs?: number;
}) {
  return provisionWorkspace({
    dataDir: args.dataDir,
    pathKey: args.pathKey,
    projectSourcePath: args.source,
    repos: [{ dir: "alpha", url: args.url, branch: args.branch ?? null }],
    branchName: "dylan/work",
    fetchTtlMs: args.fetchTtlMs ?? 0,
    mirrors: [],
  });
}

async function makeTmpfsDataDir(): Promise<string | null> {
  try {
    const dir = await mkdtemp(path.join("/dev/shm", "multi-repo-e2e-"));
    await mkdir(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "multi-repo-template-"));
  dataDir = path.join(scratch, "host-data");
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("materializing from the template tree", () => {
  it("copies a template instead of cloning, and passes every check the clone path does", async () => {
    const remote = await makeRemote("alpha");
    const source = await projectSource();
    const root = workspaceRoot(dataDir, "thread1");
    const supported = await reflinkSupported(cacheRoot(dataDir), root);
    if (!supported) return;

    const result = await provision({ dataDir, pathKey: "thread1", source, url: remote });
    const repo = result.repos.find((entry) => entry.dir === "alpha")!;
    expect(repo.status).toBe("ready");

    // The template is what proves the copy path ran: the clone fallback never
    // creates one.
    const template = templatePathFor(dataDir, remote, "main");
    expect(await exists(template)).toBe(true);
    // `core.checkStat=minimal` lives in the template's config and is inherited
    // by the copy; the clone fallback never sets it.
    expect(await gitLine(repo.path, ["config", "--local", "--get", "core.checkStat"])).toBe("minimal");

    // The same shape the clone path has always produced.
    expect(await gitLine(repo.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("dylan/work");
    expect(await gitLine(repo.path, ["config", "--get", "bb-multi-repo.baseBranch"])).toBe("main");
    expect(await gitLine(repo.path, ["config", "--get", "remote.origin.url"])).toBe(remote);
    expect((await gitIn(repo.path, ["status", "--porcelain"])).stdout.trim()).toBe("");
    const alternates = await readFile(path.join(repo.path, ".git", "objects", "info", "alternates"), "utf8");
    expect(alternates.trim()).toBe(path.join(cachePathFor(dataDir, remote).path, "objects"));
    // Never a `.git` at the root: it would flip the environment into git mode.
    expect(await exists(path.join(result.root, ".git"))).toBe(false);
  });

  it("does not rehash the tree on the first `git status` in a fresh workspace", async () => {
    const remote = await makeRemote("alpha");
    const source = await projectSource();
    const root = workspaceRoot(dataDir, "thread1");
    if (!(await reflinkSupported(cacheRoot(dataDir), root))) return;

    const result = await provision({ dataDir, pathKey: "thread1", source, url: remote });
    const repo = result.repos.find((entry) => entry.dir === "alpha")!;

    const trace = await gitIn(repo.path, ["status", "--porcelain"], {
      env: { ...gitEnv(), GIT_TRACE_PERFORMANCE: "1" },
    });
    expect(trace.code).toBe(0);
    expect(trace.stdout.trim()).toBe("");
    // `core.checkStat=minimal` makes the copied index trustworthy on size and
    // mtime, so the first status changes no entries (`changed mask = 0`);
    // without it the copied inodes and ctimes mark every entry and force a
    // rehash (`changed mask = 2`). Git may still rewrite the identical index
    // bytes under its optional lock, so the changed mask — not the index
    // mtime — is the invariant.
    const masks = [...trace.stderr.matchAll(/changed mask = (\d+)/gu)].map((match) => match[1]);
    expect(masks.every((mask) => mask === "0")).toBe(true);
  });

  it("resets a dirty template before copying from it", async () => {
    const remote = await makeRemote("alpha");
    const source = await projectSource();
    const root = workspaceRoot(dataDir, "thread1");
    if (!(await reflinkSupported(cacheRoot(dataDir), root))) return;

    await provision({ dataDir, pathKey: "thread1", source, url: remote });
    const template = templatePathFor(dataDir, remote, "main");
    await writeFile(path.join(template, "scratch.txt"), "left over\n", "utf8");
    await writeFile(path.join(template, "README.md"), "tampered\n", "utf8");

    const second = await provision({ dataDir, pathKey: "thread2", source, url: remote });
    const repo = second.repos.find((entry) => entry.dir === "alpha")!;
    // The copy is clean and at the ref, so the template was refreshed first.
    expect((await gitIn(repo.path, ["status", "--porcelain"])).stdout.trim()).toBe("");
    expect(await exists(path.join(repo.path, "scratch.txt"))).toBe(false);
    expect(await readFile(path.join(repo.path, "README.md"), "utf8")).toBe("# alpha\n");
    // And the template itself is left clean for the next thread.
    expect((await gitIn(template, ["status", "--porcelain"])).stdout.trim()).toBe("");
    expect(await exists(path.join(template, "scratch.txt"))).toBe(false);
  });

  it("rebuilds a template that is not a usable worktree", async () => {
    const remote = await makeRemote("alpha");
    const source = await projectSource();
    const root = workspaceRoot(dataDir, "thread1");
    if (!(await reflinkSupported(cacheRoot(dataDir), root))) return;

    // A directory at the template path that git cannot use: the refresh must
    // rebuild it from scratch rather than try to repair it field by field.
    const template = templatePathFor(dataDir, remote, "main");
    await mkdir(template, { recursive: true });
    await writeFile(path.join(template, "junk.txt"), "not a repo\n", "utf8");

    const result = await provision({ dataDir, pathKey: "thread1", source, url: remote });
    const repo = result.repos.find((entry) => entry.dir === "alpha")!;
    expect(repo.status).toBe("ready");
    expect(await gitLine(template, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
    expect(await exists(path.join(template, "junk.txt"))).toBe(false);
    expect(await gitLine(template, ["rev-parse", "HEAD"])).toBe(await gitLine(remote, ["rev-parse", "HEAD"]));
  });

  it("resets a template that is behind the cache ref", async () => {
    const remote = await makeRemote("alpha");
    const source = await projectSource();
    const root = workspaceRoot(dataDir, "thread1");
    if (!(await reflinkSupported(cacheRoot(dataDir), root))) return;

    await provision({ dataDir, pathKey: "thread1", source, url: remote });
    const template = templatePathFor(dataDir, remote, "main");
    const before = await gitLine(template, ["rev-parse", "HEAD"]);

    await writeFile(path.join(remote, "later.txt"), "later\n", "utf8");
    await gitIn(remote, ["add", "-A"]);
    await gitIn(remote, ["commit", "--quiet", "-m", "later"]);
    const remoteHead = await gitLine(remote, ["rev-parse", "HEAD"]);

    const second = await provision({ dataDir, pathKey: "thread2", source, url: remote });
    const repo = second.repos.find((entry) => entry.dir === "alpha")!;
    expect(await gitLine(repo.path, ["rev-parse", "HEAD"])).toBe(remoteHead);
    expect(await gitLine(template, ["rev-parse", "HEAD"])).toBe(remoteHead);
    expect(before).not.toBe(remoteHead);
  });

  it("keeps templates for branches with slashes as siblings, never nested", async () => {
    const remote = await makeRemote("alpha", "trunk");
    const source = await projectSource();
    const root = workspaceRoot(dataDir, "thread1");
    if (!(await reflinkSupported(cacheRoot(dataDir), root))) return;

    await gitIn(remote, ["branch", "release/1.0"]);
    const result = await provision({ dataDir, pathKey: "thread1", source, url: remote, branch: "release/1.0" });
    expect(result.repos.find((entry) => entry.dir === "alpha")?.status).toBe("ready");

    const tree = templateRoot(dataDir, remote);
    const plain = templatePathFor(dataDir, remote, "trunk");
    const nested = templatePathFor(dataDir, remote, "release/1.0");
    expect(path.dirname(plain)).toBe(tree);
    expect(path.dirname(nested)).toBe(tree);
    // `release/1.0` must not be nested inside any other template.
    expect(nested.startsWith(`${plain}${path.sep}`)).toBe(false);
    expect(await exists(plain)).toBe(false);
  });
});

describe("the clone fallback when the probe fails", () => {
  it("runs the current clone path and produces the same shape", async () => {
    const shm = await makeTmpfsDataDir();
    if (shm === null) return;
    try {
      const remote = await makeRemote("alpha");
      const source = await projectSource();
      const root = workspaceRoot(shm, "thread1");
      // tmpfs does not support reflinks, so the probe must fail.
      if (await reflinkSupported(cacheRoot(shm), root)) return;

      const result = await provision({ dataDir: shm, pathKey: "thread1", source, url: remote });
      const repo = result.repos.find((entry) => entry.dir === "alpha")!;
      expect(repo.status).toBe("ready");

      // No template was built: the fallback never touches the tree root.
      expect(await exists(templateRoot(shm, remote))).toBe(false);
      // The clone's config, unlike a copy's, does not carry checkStat.
      expect(await gitLine(repo.path, ["config", "--local", "--get", "core.checkStat"])).toBeNull();

      expect(await gitLine(repo.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("dylan/work");
      expect(await gitLine(repo.path, ["config", "--get", "bb-multi-repo.baseBranch"])).toBe("main");
      expect(await gitLine(repo.path, ["config", "--get", "remote.origin.url"])).toBe(remote);
      expect((await gitIn(repo.path, ["status", "--porcelain"])).stdout.trim()).toBe("");
      const alternates = await readFile(path.join(repo.path, ".git", "objects", "info", "alternates"), "utf8");
      expect(alternates.trim()).toBe(path.join(cachePathFor(shm, remote).path, "objects"));
      expect(await exists(path.join(result.root, ".git"))).toBe(false);
    } finally {
      await rm(shm, { recursive: true, force: true });
    }
  });
});

describe("the background sweep and the templates", () => {
  it("resets existing templates and creates none", async () => {
    const remote = await makeRemote("alpha");
    const source = await projectSource();
    const root = workspaceRoot(dataDir, "thread1");
    if (!(await reflinkSupported(cacheRoot(dataDir), root))) return;

    await provision({ dataDir, pathKey: "thread1", source, url: remote });
    const template = templatePathFor(dataDir, remote, "main");
    await writeFile(path.join(template, "scratch.txt"), "left over\n", "utf8");
    await writeFile(path.join(template, "README.md"), "tampered\n", "utf8");

    // A second repo whose cache exists but which no thread has materialized:
    // the sweep must not build a template for it.
    const untouched = await makeRemote("beta");
    await provision({ dataDir, pathKey: "thread2", source, url: untouched });
    const untouchedTemplate = templatePathFor(dataDir, untouched, "main");
    await rm(untouchedTemplate, { recursive: true, force: true });

    await refreshCaches(dataDir, [remote, untouched], 0, undefined);

    // Existing template: reset, and left clean.
    expect((await gitIn(template, ["status", "--porcelain"])).stdout.trim()).toBe("");
    expect(await exists(path.join(template, "scratch.txt"))).toBe(false);
    expect(await readFile(path.join(template, "README.md"), "utf8")).toBe("# alpha\n");
    // No template: still none.
    expect(await exists(untouchedTemplate)).toBe(false);
  });
});
